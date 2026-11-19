import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

import {
  LedgerReadError,
  readEntityById,
  readLedgerSnapshot,
  readLedgerStatus,
  readOpenCommitmentIndex,
  resolveAdvisersHome,
} from '../lib/ledger-read.js'
import { SCHEMA_VERSION, SqliteStore, acquireInstanceLock } from '../lib/sqlite.js'
import { seedAcceptedTos } from './tos-fixture.js'

// 0.3.0 read-only ledger facade (research reports 10 section 3.2 / 24 section 4).
//
// Contract pinned here: stable error codes, TOS/vault/schema gates, no HOME
// write lock, no HOME creation, no migration, no DB writes, targeted reads,
// clearance 0, and concurrency with a writer (WAL snapshot reads).

const sqliteLib = fileURLToPath(new URL('../lib/sqlite.js', import.meta.url))
const tempRoots = []
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

after(() => {
  for (const root of tempRoots) {
    try { chmodSync(root, 0o755) } catch {}
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  }
})

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function makeHome(prefix) {
  const home = join(makeRoot(prefix), 'home')
  mkdirSync(home, { recursive: true })
  return home
}

const NOW = '2026-01-01T00:00:00.000Z'

function seed(home, { tos = true } = {}) {
  if (tos) seedAcceptedTos(home)
  const db = join(home, 'state.db')
  const store = new SqliteStore(db)
  try {
    store.mutate(() => {
      store.insertMatter({ id: 'm_public', title: 'public', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW })
      store.insertMatter({ id: 'm_secret', title: 'secret', status: 'active', domain: 'general', secrecy: 2, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW })
      store.insertCommitment({ id: 'cm_public', matterId: 'm_public', debtor: 'user', creditor: 'boss', action: 'send deck', timezone: 'Asia/Shanghai', status: 'open', evidence: [{ sessionId: 's1', turnId: 't1', quote: 'q' }], capability: 'none' })
      store.insertCommitment({ id: 'cm_secret', matterId: 'm_secret', debtor: 'user', creditor: 'boss', action: 'secret thing', timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none' })
      store.insertCommitment({ id: 'cm_done', matterId: 'm_public', debtor: 'user', creditor: 'boss', action: 'done thing', timezone: 'Asia/Shanghai', status: 'done', evidence: [], capability: 'none' })
      store.insertFact({ id: 'fact_public', matterId: 'm_public', subject: 'client', predicate: 'prefers', object: 'tea', recordedAt: NOW, authority: 'user', confidence: 0.9, evidence: [], status: 'confirmed' })
      store.insertPreference({ id: 'pref_global', kind: 'preference', statement: 'short replies', scope: { level: 'global' }, source: {}, evidence: [], confidence: 0.8, status: 'confirmed', validFrom: NOW, priority: 'normal' })
      store.insertPreference({ id: 'pref_secret', kind: 'preference', statement: 'secret preference', scope: { level: 'matter', value: 'm_secret' }, source: {}, evidence: [], confidence: 0.8, status: 'confirmed', validFrom: NOW, priority: 'normal' })
    }, { actor: 'test', action: 'seed', allowed: true, reason: 'fixture' })
  } finally { store.close() }
  return { home, db }
}

function assertStableError(error, code) {
  assert.ok(error instanceof LedgerReadError, 'expected a LedgerReadError, got ' + (error?.name ?? typeof error))
  assert.equal(error.code, code)
  return error
}

function assertNoAbsolutePath(error, home) {
  for (const field of ['message', 'hint']) {
    const text = String(error?.[field] ?? '')
    assert.ok(!text.includes(home), field + ' leaked the configured home path: ' + text)
    assert.doesNotMatch(text, /\/tmp\//, field + ' leaked a /tmp path: ' + text)
    assert.doesNotMatch(text, /[A-Za-z]:\\/, field + ' leaked a Windows path: ' + text)
  }
}

/* -------------------------------------------------------------------------- */
/* home resolution + absence                                                  */
/* -------------------------------------------------------------------------- */

test('resolveAdvisersHome validates an explicit home and mirrors the CLI default', () => {
  assert.throws(() => resolveAdvisersHome({ home: 'relative/path' }), (error) => assertStableError(error, 'E_USAGE').hint.includes('absolute'))
  assert.throws(() => resolveAdvisersHome({ home: '' }), (error) => error.code === 'E_USAGE')
  assert.throws(() => resolveAdvisersHome({ home: 42 }), (error) => error.code === 'E_USAGE')
  assert.equal(resolveAdvisersHome({ home: '/tmp/some-home' }), '/tmp/some-home')
  const saved = process.env.ADVISERS_HOME
  try {
    process.env.ADVISERS_HOME = '/tmp/env-home'
    assert.equal(resolveAdvisersHome(), '/tmp/env-home')
    assert.equal(resolveAdvisersHome({ home: '/tmp/option-home' }), '/tmp/option-home', 'options.home wins over ADVISERS_HOME')
  } finally {
    if (saved === undefined) delete process.env.ADVISERS_HOME
    else process.env.ADVISERS_HOME = saved
  }
})

test('absent ledger: E_LEDGER_ABSENT, no HOME/DB/lock created', async () => {
  const root = makeRoot('adv-facade-absent-')
  const home = join(root, 'home')
  assert.equal(existsSync(home), false)
  const error = await readOpenCommitmentIndex({ home }).then(() => null, (reason) => reason)
  assertStableError(error, 'E_LEDGER_ABSENT')
  assert.match(error.hint, /advisers init/)
  assertNoAbsolutePath(error, home)
  assert.equal(existsSync(home), false, 'the facade must not create the home directory')
  const status = await readLedgerStatus({ home })
  assert.equal(status.dbPresent, false)
  assert.equal(status.sealed, false)
  assert.equal(status.readable, false)
  assert.equal(status.reason, 'absent')
  assert.equal(status.schemaVersion, null)
  assert.equal(existsSync(home), false, 'readLedgerStatus must not create the home directory')
})

test('sealed vault: E_VAULT_SEALED and no empty database is created', async () => {
  const home = makeHome('adv-facade-sealed-')
  seedAcceptedTos(home)
  writeFileSync(join(home, 'state.db.vault'), 'sealed-bytes')
  const error = await readOpenCommitmentIndex({ home }).then(() => null, (reason) => reason)
  assertStableError(error, 'E_VAULT_SEALED')
  assert.match(error.hint, /vault unseal/)
  assert.equal(existsSync(join(home, 'state.db')), false)
  assertNoAbsolutePath(error, home)
  const status = await readLedgerStatus({ home })
  assert.equal(status.sealed, true)
  assert.equal(status.dbPresent, false)
  assert.equal(status.reason, 'sealed')
})

test('corrupt ledger: E_LEDGER_CORRUPT for 0-byte and non-SQLite files', async () => {
  const zeroHome = makeHome('adv-facade-zero-')
  seedAcceptedTos(zeroHome)
  writeFileSync(join(zeroHome, 'state.db'), '')
  const zero = await readOpenCommitmentIndex({ home: zeroHome }).then(() => null, (reason) => reason)
  assertStableError(zero, 'E_LEDGER_CORRUPT')
  assert.match(zero.hint, /advisers doctor/)
  assertNoAbsolutePath(zero, zeroHome)

  const junkHome = makeHome('adv-facade-junk-')
  seedAcceptedTos(junkHome)
  writeFileSync(join(junkHome, 'state.db'), 'this is not a sqlite database')
  const junk = await readOpenCommitmentIndex({ home: junkHome }).then(() => null, (reason) => reason)
  assertStableError(junk, 'E_LEDGER_CORRUPT')
  assert.equal(readFileSync(join(junkHome, 'state.db'), 'utf8'), 'this is not a sqlite database', 'the facade must not touch a corrupt file')
})

/* -------------------------------------------------------------------------- */
/* TOS gate                                                                   */
/* -------------------------------------------------------------------------- */

test('TOS gate: missing/revoked/version-changed/text-changed are refused with a reason', async () => {
  const home = makeHome('adv-facade-tos-')
  seed(home, { tos: false })
  const missing = await readOpenCommitmentIndex({ home }).then(() => null, (reason) => reason)
  assertStableError(missing, 'E_TOS_REQUIRED')
  assert.equal(missing.reason, 'missing')
  assert.match(missing.hint, /advisers tos show/)
  assertNoAbsolutePath(missing, home)

  const tosPath = seedAcceptedTos(home)
  const first = JSON.parse(readFileSync(tosPath, 'utf8'))

  writeFileSync(tosPath, JSON.stringify({ ...first, revokedAt: '2026-01-02T00:00:00.000Z' }) + '\n')
  const revoked = await readOpenCommitmentIndex({ home }).then(() => null, (reason) => reason)
  assertStableError(revoked, 'E_TOS_REQUIRED')
  assert.equal(revoked.reason, 'revoked')

  writeFileSync(tosPath, JSON.stringify({ ...first, version: 'v0.0.0-old' }) + '\n')
  const versionChanged = await readOpenCommitmentIndex({ home }).then(() => null, (reason) => reason)
  assert.equal(versionChanged.code, 'E_TOS_REQUIRED')
  assert.equal(versionChanged.reason, 'version-changed')

  writeFileSync(tosPath, JSON.stringify({ ...first, sha256: '0'.repeat(64) }) + '\n')
  const textChanged = await readOpenCommitmentIndex({ home }).then(() => null, (reason) => reason)
  assert.equal(textChanged.code, 'E_TOS_REQUIRED')
  assert.equal(textChanged.reason, 'text-changed')

  // The facade never writes an acceptance record.
  assert.equal(JSON.parse(readFileSync(tosPath, 'utf8')).sha256, '0'.repeat(64))
})

test('the ADVISERS_TOS_VERSION env override cannot fake consent', async () => {
  const home = makeHome('adv-facade-tos-env-')
  seed(home, { tos: false })
  const saved = process.env.ADVISERS_TOS_VERSION
  try {
    process.env.ADVISERS_TOS_VERSION = 'v-fake-accepted'
    const error = await readOpenCommitmentIndex({ home }).then(() => null, (reason) => reason)
    assertStableError(error, 'E_TOS_REQUIRED')
    assert.equal(error.reason, 'missing')
  } finally {
    if (saved === undefined) delete process.env.ADVISERS_TOS_VERSION
    else process.env.ADVISERS_TOS_VERSION = saved
  }
})

/* -------------------------------------------------------------------------- */
/* schema gates                                                               */
/* -------------------------------------------------------------------------- */

test('stale schema: E_SCHEMA_STALE, no migration, no backup, no lock', async () => {
  const { home, db } = seed(makeHome('adv-facade-stale-'))
  const raw = new DatabaseSync(db)
  raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION - 1))
  raw.close()
  const before = hashFile(db)
  const beforeEntries = readdirSync(home).sort()
  const error = await readOpenCommitmentIndex({ home }).then(() => null, (reason) => reason)
  assertStableError(error, 'E_SCHEMA_STALE')
  assert.match(error.hint, /advisers doctor/)
  assertNoAbsolutePath(error, home)
  assert.equal(hashFile(db), before, 'a read-only open must not migrate the database')
  assert.equal(existsSync(join(home, 'instance.lock')), false)
  const created = readdirSync(home).filter((name) => !beforeEntries.includes(name) && !name.endsWith('-wal') && !name.endsWith('-shm'))
  assert.deepEqual(created, [], 'no migration/backup artifact may be created')
  const status = await readLedgerStatus({ home })
  assert.equal(status.readable, false)
  assert.equal(status.error.code, 'E_SCHEMA_STALE')
  assert.equal(status.schemaVersion, SCHEMA_VERSION - 1)
})

test('newer schema: E_SCHEMA_NEWER (fail closed, no data)', async () => {
  const { home, db } = seed(makeHome('adv-facade-newer-'))
  const raw = new DatabaseSync(db)
  raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1))
  raw.close()
  const error = await readOpenCommitmentIndex({ home }).then(() => null, (reason) => reason)
  assertStableError(error, 'E_SCHEMA_NEWER')
  assert.match(error.hint, /Upgrade/)
  assert.equal(error.schemaVersion, SCHEMA_VERSION + 1)
})

/* -------------------------------------------------------------------------- */
/* targeted reads + clearance                                                 */
/* -------------------------------------------------------------------------- */

test('readOpenCommitmentIndex: targeted open rows, clearance 0, all/limit', async () => {
  const { home, db } = seed(makeHome('adv-facade-index-'))
  const before = hashFile(db)
  const open = await readOpenCommitmentIndex({ home })
  assert.equal(open.backend, 'sqlite')
  assert.equal(open.schemaVersion, SCHEMA_VERSION)
  assert.equal(open.clearance, 0)
  assert.equal(open.protectedExcluded, 1)
  assert.equal(open.total, 1)
  assert.deepEqual(open.rows.map((row) => row.id), ['cm_public'])
  for (const row of open.rows) {
    assert.deepEqual(Object.keys(row).sort(), ['action', 'creditor', 'debtor', 'id', 'matterId', 'status'].sort())
  }
  assert.ok(!JSON.stringify(open).includes('secret thing'), 'protected content must not be returned')

  const all = await readOpenCommitmentIndex({ home, all: true })
  assert.equal(all.total, 2)
  assert.ok(all.rows.some((row) => row.id === 'cm_done' && row.status === 'done'))

  const limited = await readOpenCommitmentIndex({ home, limit: 1 })
  assert.equal(limited.rows.length, 1)
  assert.equal(limited.total, 1)
  await assert.rejects(readOpenCommitmentIndex({ home, limit: 0 }), (error) => error.code === 'E_USAGE')
  assert.equal(hashFile(db), before, 'reads must not modify the SQLite database')
})

test('readEntityById: point reads, hidden protected records, missing rows', async () => {
  const { home } = seed(makeHome('adv-facade-entity-'))
  const commitment = await readEntityById({ home, kind: 'commitments', id: 'cm_public' })
  assert.equal(commitment.record.id, 'cm_public')
  assert.equal(commitment.hidden, false)
  assert.equal(commitment.protectedExcluded, 0)
  assert.equal(commitment.clearance, 0)

  const fact = await readEntityById({ home, kind: 'facts', id: 'fact_public' })
  assert.equal(fact.record.subject, 'client')
  const preference = await readEntityById({ home, kind: 'preferences', id: 'pref_global' })
  assert.equal(preference.record.statement, 'short replies')
  const matter = await readEntityById({ home, kind: 'matters', id: 'm_public' })
  assert.equal(matter.record.id, 'm_public')

  const hidden = await readEntityById({ home, kind: 'commitments', id: 'cm_secret' })
  assert.equal(hidden.record, null)
  assert.equal(hidden.hidden, true)
  assert.equal(hidden.protectedExcluded, 1)
  assert.ok(!JSON.stringify(hidden).includes('secret thing'))
  const hiddenPreference = await readEntityById({ home, kind: 'preferences', id: 'pref_secret' })
  assert.equal(hiddenPreference.hidden, true, 'a matter-scoped preference is hidden through its scope')
  const hiddenMatter = await readEntityById({ home, kind: 'matters', id: 'm_secret' })
  assert.equal(hiddenMatter.hidden, true)

  const missing = await readEntityById({ home, kind: 'commitments', id: 'cm_missing' })
  assert.equal(missing.record, null)
  assert.equal(missing.hidden, false)
  await assert.rejects(readEntityById({ home, kind: 'unknown', id: 'x' }), (error) => error.code === 'E_USAGE')
  await assert.rejects(readEntityById({ home, kind: 'commitments', id: '  ' }), (error) => error.code === 'E_USAGE')
})

test('readLedgerSnapshot: wire subset, part allowlist, no clearance projection', async () => {
  const { home } = seed(makeHome('adv-facade-snapshot-'))
  const partial = await readLedgerSnapshot({ home, parts: ['commitments'] })
  assert.deepEqual(Object.keys(partial.snapshot).sort(), ['commitments', 'version'])
  assert.equal(partial.snapshot.version, 1)
  assert.equal(partial.snapshot.commitments.length, 3)
  const full = await readLedgerSnapshot({ home })
  assert.ok(full.snapshot.matters.length >= 2)
  assert.equal(full.backend, 'sqlite')
  await assert.rejects(readLedgerSnapshot({ home, parts: ['not_a_table'] }), (error) => error.code === 'E_USAGE')
})

/* -------------------------------------------------------------------------- */
/* read-only side effects + concurrency                                       */
/* -------------------------------------------------------------------------- */

test('reads leave the DB byte-identical and create no HOME lock', async () => {
  const { home, db } = seed(makeHome('adv-facade-sideeffects-'))
  const before = hashFile(db)
  const beforeEntries = readdirSync(home).sort()
  await readOpenCommitmentIndex({ home })
  await readEntityById({ home, kind: 'commitments', id: 'cm_public' })
  await readLedgerSnapshot({ home, parts: ['matters'] })
  await readLedgerStatus({ home })
  assert.equal(hashFile(db), before)
  assert.equal(existsSync(join(home, 'instance.lock')), false)
  const allowedNew = new Set(['state.db-wal', 'state.db-shm'])
  const created = readdirSync(home).filter((name) => !beforeEntries.includes(name) && !allowedNew.has(name))
  assert.deepEqual(created, [], 'only SQLite sidecars may appear (documented read-only side effect)')
})

test('a writer holding the HOME lock does not block a facade read and is not disturbed', async () => {
  const { home, db } = seed(makeHome('adv-facade-lock-'))
  const script = join(home, 'lock-holder.mjs')
  writeFileSync(script, [
    `import { acquireInstanceLock } from ${JSON.stringify(pathToFileURL(sqliteLib).href)}`,
    "const lock = acquireInstanceLock({ home: process.env.ADVISERS_TEST_HOME, command: 'test-holder', timeoutMs: 5000 })",
    "process.stdout.write('held\\n')",
    'setTimeout(() => { lock.release(); process.exit(0) }, 2000)',
  ].join('\n'))
  const child = spawn(process.execPath, [script], { env: { ...process.env, ADVISERS_TEST_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  try {
    for (let i = 0; i < 200 && !stdout.includes('held'); i++) await sleep(25)
    assert.ok(stdout.includes('held'), `lock holder did not start: ${stderr}`)
    assert.ok(existsSync(join(home, 'instance.lock')))
    const started = Date.now()
    const index = await readOpenCommitmentIndex({ home })
    const elapsed = Date.now() - started
    assert.equal(index.total, 1)
    assert.ok(elapsed < 1000, `read waited for the writer lock (${elapsed}ms)`)
    assert.ok(existsSync(join(home, 'instance.lock')), 'the facade must not remove the writer lock')
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolvePromise) => child.once('exit', resolvePromise))
  }
})

test('uncommitted writer rows are invisible; committed rows are visible on the next call', async () => {
  const { home, db } = seed(makeHome('adv-facade-tx-'))
  const writer = new SqliteStore(db)
  try {
    writer.db.exec('BEGIN IMMEDIATE')
    writer.db.prepare('INSERT INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('cm_uncommitted', 'm_public', 'user', 'boss', 'uncommitted', null, 'Asia/Shanghai', 'open', '[]', 'none', null, null)
    const during = await readOpenCommitmentIndex({ home, all: true })
    assert.ok(!during.rows.some((row) => row.id === 'cm_uncommitted'), 'a read-only connection must not see uncommitted rows')
    writer.db.exec('COMMIT')
    const after = await readOpenCommitmentIndex({ home, all: true })
    assert.ok(after.rows.some((row) => row.id === 'cm_uncommitted'), 'a committed row is visible')
  } finally { writer.close() }
})

test('WAL reads: committed sidecar data is read and the WAL bytes are untouched', async () => {
  const { home, db } = seed(makeHome('adv-facade-wal-'))
  // Keep the writer connection open: the last connection close checkpoints and
  // removes the WAL, so the sidecar only exists while a writer is attached.
  const writer = new SqliteStore(db)
  try {
    writer.addTurn({ conversationId: 'c_wal', role: 'user', content: 'wal row' })
    const walPath = db + '-wal'
    assert.ok(existsSync(walPath), 'fixture: the committed row lives in the WAL')
    const dbHash = hashFile(db)
    const walHash = hashFile(walPath)
    const index = await readOpenCommitmentIndex({ home })
    assert.equal(index.backend, 'sqlite')
    assert.equal(hashFile(db), dbHash, 'a read must not checkpoint state.db')
    assert.equal(hashFile(walPath), walHash, 'a read-only connection must not rewrite the WAL')
  } finally { writer.close() }
})

test('an invalid WAL is reported in warnings and never quarantined', async () => {
  const { home, db } = seed(makeHome('adv-facade-badwal-'))
  const walPath = db + '-wal'
  writeFileSync(walPath, Buffer.alloc(64, 0x41))
  const walHash = hashFile(walPath)
  const index = await readOpenCommitmentIndex({ home })
  assert.equal(index.rows.length >= 1, true)
  assert.ok(index.warnings.length > 0, 'an unusable WAL must be reported as a warning')
  assert.match(index.warnings[0], /E_WAL_/)
  assert.ok(!index.warnings[0].includes(home), 'warnings must not contain an absolute path')
  assert.equal(hashFile(walPath), walHash, 'a read-only open must leave an invalid WAL untouched')
  const quarantined = readdirSync(home).filter((name) => name.includes('wal.corrupt'))
  assert.deepEqual(quarantined, [], 'a read-only open must not quarantine the WAL')
})

/* -------------------------------------------------------------------------- */
/* environment / backend variants                                             */
/* -------------------------------------------------------------------------- */

test('a read-only directory maps to E_LEDGER_UNAVAILABLE (POSIX; root/Windows skips)', async () => {
  if (process.platform === 'win32') return
  if (typeof process.getuid === 'function' && process.getuid() === 0) return
  const { home } = seed(makeHome('adv-facade-ro-'))
  chmodSync(home, 0o555)
  try {
    const error = await readOpenCommitmentIndex({ home }).then(() => null, (reason) => reason)
    assertStableError(error, 'E_LEDGER_UNAVAILABLE')
    assert.match(error.hint, /local|read/i)
    assertNoAbsolutePath(error, home)
  } finally {
    chmodSync(home, 0o755)
  }
})

test('home paths with spaces, CJK and emoji are readable', async () => {
  const home = join(makeRoot('adv-facade-path-'), 'home with 空格 🚀')
  mkdirSync(home, { recursive: true })
  seed(home)
  const index = await readOpenCommitmentIndex({ home })
  assert.equal(index.total, 1)
})

test('legacy JSON store: read-only backend, corrupt JSON is E_LEDGER_CORRUPT', async () => {
  const home = makeHome('adv-facade-json-')
  seedAcceptedTos(home)
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    matters: [{ id: 'm1', title: 't', status: 'active', domain: 'g', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW }],
    commitments: [{ id: 'cm1', matterId: 'm1', debtor: 'user', creditor: 'u', action: 'a', dueAt: NOW, timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none' }],
    facts: [], preferences: [], links: [], updates: [], routines: [], routinePatches: [], routes: {},
  }))
  const saved = process.env.ADVISERS_STORE
  try {
    process.env.ADVISERS_STORE = 'json'
    const index = await readOpenCommitmentIndex({ home })
    assert.equal(index.backend, 'json')
    assert.equal(index.schemaVersion, null)
    assert.deepEqual(index.rows.map((row) => row.id), ['cm1'])
    const entity = await readEntityById({ home, kind: 'commitments', id: 'cm1' })
    assert.equal(entity.record.action, 'a')
    const snapshot = await readLedgerSnapshot({ home, parts: ['commitments'] })
    assert.equal(snapshot.snapshot.commitments.length, 1)
    const status = await readLedgerStatus({ home })
    assert.equal(status.backend, 'json')
    assert.equal(status.readable, true)
    assert.equal(status.schemaVersion, null)
  } finally {
    if (saved === undefined) delete process.env.ADVISERS_STORE
    else process.env.ADVISERS_STORE = saved
  }
  writeFileSync(join(home, 'state.json'), '{not json')
  const savedAgain = process.env.ADVISERS_STORE
  try {
    process.env.ADVISERS_STORE = 'json'
    const error = await readOpenCommitmentIndex({ home }).then(() => null, (reason) => reason)
    assertStableError(error, 'E_LEDGER_CORRUPT')
    assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), '{not json', 'a corrupt JSON store must not be rewritten')
  } finally {
    if (savedAgain === undefined) delete process.env.ADVISERS_STORE
    else process.env.ADVISERS_STORE = savedAgain
  }
})
