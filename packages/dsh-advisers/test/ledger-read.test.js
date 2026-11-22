import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { apply } from '../index.js'
import { createLedgerReader } from '../lib/read.js'
import { SCHEMA_VERSION, SqliteStore } from '../../advisers/lib/sqlite.js'
import { seedAcceptedTos } from '../../advisers/test/tos-fixture.js'

// 0.3.0 DSH read-only real ledger wiring (research reports 10/11/24 section 4).
//
// The three read tools must read the real local ledger through
// `advisers/lib/ledger-read.js` (read-only, TOS-gated, no HOME write lock, no
// migration, no HOME creation, no writes, clearance 0) and must fall back to
// the marked preview when no ledger exists or when the facade is unavailable.
// Gate failures are structured errors, never empty data.

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bin = resolve(pkgDir, '..', 'advisers', 'bin', 'advisers.js')
const exec = { signal: new AbortController().signal, deferContext() {}, concludeTurn() {} }

const tempRoots = []
function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

after(() => {
  for (const root of tempRoots) { try { rmSync(root, { recursive: true, force: true }) } catch {} }
})

// An env that always resolves to a non-existent home, so a test that mounts
// without an explicit config can never read the developer's real ~/.advisers.
const EMPTY_HOME = join(makeRoot('adv-dsh-empty-'), 'home')
const originalHome = process.env.ADVISERS_HOME
const originalStore = process.env.ADVISERS_STORE
process.env.ADVISERS_HOME = EMPTY_HOME
delete process.env.ADVISERS_STORE
after(() => {
  if (originalHome === undefined) delete process.env.ADVISERS_HOME
  else process.env.ADVISERS_HOME = originalHome
  if (originalStore === undefined) delete process.env.ADVISERS_STORE
  else process.env.ADVISERS_STORE = originalStore
})

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function dirSnapshot(home) {
  try { return readdirSync(home).sort() } catch { return [] }
}

const SEED = {
  today: 'send the Q4 deck',
  overdue: 'file the overdue report',
  week: 'book the review meeting',
  third: 'alice sends the signed contract',
  noDue: 'untimed follow-up',
  secret: 'secret acquisition target',
  fact: 'client prefers tea',
  pref: 'short replies',
}

function seedLedger(home, { tos = true, secret = true } = {}) {
  if (tos) seedAcceptedTos(home)
  else mkdirSync(home, { recursive: true })
  const now = Date.now()
  const store = new SqliteStore(join(home, 'state.db'))
  try {
    const createdAt = new Date(now).toISOString()
    const turn = store.addTurn({ conversationId: 'conv_public', role: 'user', content: 'please send it by Tuesday' })
    const publicMatter = { id: 'm_public', title: 'Q4', status: 'active', domain: 'work', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt, updatedAt: createdAt }
    const secretMatter = { id: 'm_secret', title: 'M&A', status: 'active', domain: 'work', secrecy: 2, participants: [], deadlines: [], openQuestions: [], createdAt, updatedAt: createdAt }
    store.mutate(() => {
      store.insertMatter(publicMatter)
      store.insertMatter(secretMatter)
      const commitment = (id, matterId, debtor, creditor, action, dueAt, evidence = []) => store.insertCommitment({ id, matterId, debtor, creditor, action, timezone: 'Asia/Shanghai', status: 'open', evidence, capability: 'none', ...(dueAt ? { dueAt } : {}) })
      commitment('cm_today', 'm_public', 'user', 'boss', SEED.today, new Date(now).toISOString(), [{ sessionId: 'conv_public', turnId: turn.id, quote: 'please send it by Tuesday' }])
      commitment('cm_overdue', 'm_public', 'user', 'boss', SEED.overdue, new Date(now - 2 * 86400000).toISOString())
      commitment('cm_week', 'm_public', 'user', 'boss', SEED.week, new Date(now + 2 * 86400000).toISOString())
      commitment('cm_third', 'm_public', 'third:alice', 'me', SEED.third, new Date(now + 3 * 86400000).toISOString())
      commitment('cm_nodue', 'm_public', 'agent', 'me', SEED.noDue)
      if (secret) commitment('cm_secret', 'm_secret', 'user', 'boss', SEED.secret, new Date(now).toISOString())
      store.insertFact({ id: 'fact_public', matterId: 'm_public', subject: 'client', predicate: 'prefers', object: SEED.fact, recordedAt: createdAt, authority: 'user', confidence: 0.9, evidence: [{ ref: `conv_public#${turn.id}`, quote: 'please send it by Tuesday' }], status: 'confirmed' })
      store.insertPreference({ id: 'pref_global', kind: 'preference', statement: SEED.pref, scope: { level: 'global' }, source: {}, evidence: [], confidence: 0.8, status: 'confirmed', validFrom: createdAt, priority: 'normal' })
    }, { actor: 'test', action: 'seed', allowed: true, reason: 'fixture' })
  } finally { store.close() }
  return { home, db: join(home, 'state.db') }
}

function mount(config = {}) {
  const tools = []
  let runtime
  const ctx = {
    provide(serviceName, value) { if (serviceName === 'advisers') runtime = value },
    tools: { register(tool) { tools.push(tool); return () => {} } },
  }
  apply(ctx, config)
  return { tools, runtime, byName: new Map(tools.map((tool) => [tool.name, tool])) }
}

async function execute(tool, args = {}) {
  const value = await tool.execute(args, exec)
  const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
  assert.deepEqual(violations, [], tool.name + ' returned a value outside its output schema')
  const content = tool.output.render(args, value)
  assert.ok(Array.isArray(content) && content.length === 1, tool.name + ' render must return one block')
  assert.equal(content[0].type, 'text')
  assert.equal(typeof content[0].text, 'string')
  return { value, text: content[0].text }
}

function assertNoAbsolutePath(value, home) {
  const text = JSON.stringify(value)
  assert.ok(!text.includes(home), 'payload leaked the configured home path')
  assert.doesNotMatch(text, /\/tmp\//, 'payload leaked a /tmp path')
  assert.doesNotMatch(text, /[A-Za-z]:\\/, 'payload leaked a Windows absolute path')
}

function cli(home, args) {
  const env = { ...process.env, ADVISERS_HOME: home, ADVISERS_ACCEPT_TOS: '1' }
  delete env.ADVISERS_STORE
  return JSON.parse(execFileSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' }))
}

test('no ledger -> marked preview, no HOME is created, plugin loads', async () => {
  const { byName } = mount()
  assert.equal(existsSync(EMPTY_HOME), false, 'fixture: the env home does not exist')
  const today = await execute(byName.get('advisers_today'))
  const who = await execute(byName.get('advisers_who'))
  assert.equal(today.value.ok, true)
  assert.equal(today.value.data.preview, true)
  assert.equal(today.value.data.source, 'preview-no-ledger')
  assert.match(today.text, /^\[preview: no ledger\] /)
  assert.equal(who.value.data.preview, true)
  assert.equal(existsSync(EMPTY_HOME), false, 'a preview read must not create the home directory')
})

test('real ledger: today/who read the targeted index with clearance 0', async () => {
  const root = makeRoot('adv-dsh-real-')
  const home = join(root, 'home')
  const { db } = seedLedger(home)
  const before = hashFile(db)
  const beforeEntries = dirSnapshot(home)
  const { byName } = mount({ home })

  const today = await execute(byName.get('advisers_today'))
  assert.equal(today.value.ok, true, JSON.stringify(today.value))
  const data = today.value.data
  assert.equal(data.preview, false)
  assert.equal(data.source, 'ledger-readonly')
  assert.equal(data.note.length > 0, true)
  assert.equal(data.backend, 'sqlite')
  assert.equal(data.clearance, 0)
  assert.equal(data.protectedExcluded, 1)
  // cm_third is both 'waiting' and due within 7 days, exactly like the CLI view.
  assert.deepEqual(data.counts, { open: 5, overdue: 1, today: 1, week: 2, waiting: 1, noDue: 1 })
  assert.deepEqual(data.overdue.map((row) => row.id), ['cm_overdue'])
  assert.deepEqual(data.today.map((row) => row.id), ['cm_today'])
  assert.deepEqual(data.week.map((row) => row.id), ['cm_week', 'cm_third'])
  assert.deepEqual(data.waiting.map((row) => row.id), ['cm_third'])
  assert.deepEqual(data.noDue.map((row) => row.id), ['cm_nodue'])
  assert.equal(data.next.id, 'cm_overdue')
  assert.ok(!JSON.stringify(data).includes(SEED.secret), 'secret content must not reach the payload')
  assert.doesNotMatch(today.text, /^\[preview/)
  assert.match(today.text, /1 protected item\(s\) withheld/)

  const who = await execute(byName.get('advisers_who'))
  assert.equal(who.value.ok, true)
  assert.deepEqual(who.value.data.counts, { mine: 4, waiting: 1, open: 5 })
  assert.deepEqual(who.value.data.mine.map((row) => row.id).sort(), ['cm_nodue', 'cm_overdue', 'cm_today', 'cm_week'])
  assert.deepEqual(who.value.data.waiting.map((row) => row.id), ['cm_third'])
  assert.equal(who.value.data.protectedExcluded, 1)

  // Read-only: byte-identical database, no writer lock, no extra ledger files.
  assert.equal(hashFile(db), before, 'a read tool must not modify state.db')
  assert.equal(existsSync(join(home, 'instance.lock')), false, 'a read tool must not take the HOME write lock')
  const allowedNew = new Set(['state.db-wal', 'state.db-shm'])
  for (const entry of dirSnapshot(home)) {
    assert.ok(beforeEntries.includes(entry) || allowedNew.has(entry), 'unexpected file created by a read: ' + entry)
  }
  assertNoAbsolutePath(today.value, home)
  assertNoAbsolutePath(who.value, home)
})

test('real ledger: evidence reads one row; protected rows are withheld', async () => {
  const home = join(makeRoot('adv-dsh-evidence-'), 'home')
  seedLedger(home)
  const { byName } = mount({ home })
  const tool = byName.get('advisers_evidence')

  const found = await execute(tool, { id: 'cm_today' })
  assert.equal(found.value.ok, true, JSON.stringify(found.value))
  assert.equal(found.value.data.preview, false)
  assert.equal(found.value.data.source, 'ledger-readonly')
  assert.equal(found.value.data.kind, 'commitment')
  assert.equal(found.value.data.record.id, 'cm_today')
  assert.equal(found.value.data.verified, false)
  const foundSource = found.value.data.sources[0]
  assert.equal(foundSource.sessionId, 'conv_public')
  assert.equal(foundSource.ref, 'conv_public#' + foundSource.turnId)
  assert.equal(found.value.data.counts.sources, 1)
  assert.equal(found.value.data.protectedExcluded, 0)

  const fact = await execute(tool, { id: 'fact_public' })
  assert.equal(fact.value.ok, true, JSON.stringify(fact.value))
  assert.equal(fact.value.data.kind, 'fact')
  assert.equal(fact.value.data.sources.length, 1)

  const preference = await execute(tool, { id: 'pref_global' })
  assert.equal(preference.value.ok, true)
  assert.equal(preference.value.data.kind, 'preference')

  const protectedRecord = await execute(tool, { id: 'cm_secret' })
  assert.equal(protectedRecord.value.ok, false)
  assert.equal(protectedRecord.value.error.code, 'EVIDENCE_PROTECTED')
  assert.ok(!JSON.stringify(protectedRecord.value).includes(SEED.secret))

  const missing = await execute(tool, { id: 'cm_missing' })
  assert.equal(missing.value.ok, false)
  assert.equal(missing.value.error.code, 'EVIDENCE_NOT_FOUND')

  const unknown = await execute(tool, { id: 'matter_1' })
  assert.equal(unknown.value.error.code, 'UNKNOWN_ID_PREFIX')
  const empty = await execute(tool, { id: '   ' })
  assert.equal(empty.value.error.code, 'INVALID_ARGUMENT')
})

test('TOS missing/revoked/version-changed are structured errors, not preview', async () => {
  const root = makeRoot('adv-dsh-tos-')
  const home = join(root, 'home')
  seedLedger(home, { tos: false })
  const { byName } = mount({ home })
  const tool = byName.get('advisers_today')

  const missing = await execute(tool)
  assert.equal(missing.value.ok, false)
  assert.equal(missing.value.error.code, 'LEDGER_TOS_REQUIRED')
  assert.match(missing.value.error.message, /missing/)
  assert.match(missing.value.error.hint, /advisers tos show/)
  assert.equal(missing.value.data, undefined)
  assertNoAbsolutePath(missing.value, home)

  // revoked acceptance -> still refused; never auto-rewritten
  seedAcceptedTos(home)
  const tosPath = join(home, 'tos.json')
  const record = JSON.parse(readFileSync(tosPath, 'utf8'))
  writeFileSync(tosPath, JSON.stringify({ ...record, revokedAt: new Date().toISOString() }) + '\n')
  const revoked = await execute(tool)
  assert.equal(revoked.value.ok, false)
  assert.equal(revoked.value.error.code, 'LEDGER_TOS_REQUIRED')
  assert.match(revoked.value.error.message, /revoked/)

  // changed version -> refused (stale acceptance is not consent)
  writeFileSync(tosPath, JSON.stringify({ ...record, version: 'v-old' }) + '\n')
  const changed = await execute(tool)
  assert.equal(changed.value.error.code, 'LEDGER_TOS_REQUIRED')
  assert.match(changed.value.error.message, /version-changed/)
})

test('schema stale/newer and vault-sealed ledgers are structured errors', async () => {
  const staleHome = join(makeRoot('adv-dsh-stale-'), 'home')
  const { db } = seedLedger(staleHome)
  const raw = new DatabaseSync(db)
  raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION - 1))
  raw.close()
  const before = hashFile(db)
  const stale = mount({ home: staleHome })
  const staleResult = await execute(stale.byName.get('advisers_today'))
  assert.equal(staleResult.value.ok, false)
  assert.equal(staleResult.value.error.code, 'LEDGER_SCHEMA_STALE')
  assert.match(staleResult.value.error.hint, /advisers doctor/)
  assert.equal(hashFile(db), before, 'the read path must not migrate a stale schema')
  assert.equal(existsSync(join(staleHome, 'instance.lock')), false)

  const newerHome = join(makeRoot('adv-dsh-newer-'), 'home')
  const newer = seedLedger(newerHome)
  const rawNewer = new DatabaseSync(newer.db)
  rawNewer.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1))
  rawNewer.close()
  const newerResult = await execute(mount({ home: newerHome }).byName.get('advisers_today'))
  assert.equal(newerResult.value.error.code, 'LEDGER_SCHEMA_NEWER')

  const sealedHome = join(makeRoot('adv-dsh-sealed-'), 'home')
  mkdirSync(sealedHome, { recursive: true })
  writeFileSync(join(sealedHome, 'state.db.vault'), 'sealed-vault-bytes')
  seedAcceptedTos(sealedHome)
  const sealed = await execute(mount({ home: sealedHome }).byName.get('advisers_today'))
  assert.equal(sealed.value.ok, false)
  assert.equal(sealed.value.error.code, 'LEDGER_VAULT_SEALED')
  assert.equal(existsSync(join(sealedHome, 'state.db')), false, 'a sealed vault must not be replaced by an empty database')
})

test('config.mode preview is the kill switch and keeps the 0.2.x payload', async () => {
  const home = join(makeRoot('adv-dsh-preview-mode-'), 'home')
  seedLedger(home)
  const { byName } = mount({ home, mode: 'preview' })
  const today = await execute(byName.get('advisers_today'))
  assert.equal(today.value.ok, true)
  assert.equal(today.value.data.preview, true)
  assert.equal(today.value.data.source, 'preview-no-ledger')
  assert.deepEqual(today.value.data.counts, { open: 0, overdue: 0, today: 0, week: 0, waiting: 0, noDue: 0 })
  assert.match(today.text, /^\[preview: no ledger\] /)
  assert.deepEqual(Object.keys(today.value.data).sort(), ['counts', 'disclosure', 'localDay', 'noDue', 'note', 'now', 'overdue', 'preview', 'source', 'today', 'truncated', 'timezone', 'waiting', 'week'].sort())
  assert.throws(() => mount({ mode: 'sometimes' }), /config\.mode/)
  assert.throws(() => mount({ home: 'relative/dir' }), /config\.home must be an absolute path/)
})

test('an unavailable facade falls back to preview instead of failing the plugin', async () => {
  const { AdvisersRuntime } = await import('advisers-core')
  const runtime = new AdvisersRuntime({ stage: 'probation' })
  for (const importFacade of [
    () => { const error = new Error('Package subpath is not defined'); error.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED'; throw error },
    async () => { throw new Error('ERR_MODULE_NOT_FOUND') },
    async () => ({}),
  ]) {
    const reader = createLedgerReader({}, { runtime, importFacade })
    const today = await reader.todayView()
    assert.equal(today.data.preview, true)
    assert.equal(today.data.source, 'preview-no-ledger')
    assert.equal(today.data.counts.open, 0)
    const { loadFacade } = reader
    assert.equal((await loadFacade()).api, null)
  }
})

test('reading sees only committed WAL snapshots and never blocks the writer', async () => {
  const home = join(makeRoot('adv-dsh-concurrent-'), 'home')
  const { db } = seedLedger(home)
  const { byName } = mount({ home })
  const tool = byName.get('advisers_today')
  const writer = new SqliteStore(db)
  try {
    writer.db.exec('BEGIN IMMEDIATE')
    writer.db.prepare('INSERT INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('cm_uncommitted', 'm_public', 'user', 'boss', 'uncommitted row', null, 'Asia/Shanghai', 'open', '[]', 'none', null, null)
    const started = Date.now()
    const during = await execute(tool)
    const elapsed = Date.now() - started
    assert.equal(during.value.ok, true, 'a read must not fail while a writer holds a transaction')
    assert.ok(!during.value.data.noDue.some((row) => row.id === 'cm_uncommitted'), 'a read must not see uncommitted rows')
    assert.ok(elapsed < 2000, `read waited for the writer (${elapsed}ms)`)
    writer.db.exec('COMMIT')
    const afterCommit = await execute(tool)
    assert.ok(afterCommit.value.data.noDue.some((row) => row.id === 'cm_uncommitted'), 'a read sees a row after it commits')
  } finally { writer.close() }
  const before = hashFile(db)
  const finalRead = await execute(tool)
  assert.equal(finalRead.value.ok, true)
  assert.equal(hashFile(db), before, 'reads must not modify the database')
})

test('WAL sidecar from a committed writer is read without modification', async () => {
  const home = join(makeRoot('adv-dsh-wal-'), 'home')
  const { db } = seedLedger(home)
  const writer = new SqliteStore(db)
  try {
    writer.addTurn({ conversationId: 'conv_wal', role: 'user', content: 'wal row' })
  } finally { writer.close() }
  const walPath = db + '-wal'
  const walPresent = existsSync(walPath)
  const walHash = walPresent ? hashFile(walPath) : null
  const dbHash = hashFile(db)
  const { byName } = mount({ home })
  const today = await execute(byName.get('advisers_today'))
  assert.equal(today.value.ok, true)
  assert.equal(hashFile(db), dbHash, 'a WAL read must not checkpoint or modify state.db')
  if (walPresent) assert.equal(hashFile(walPath), walHash, 'a read-only connection must not modify the WAL')
})

test('CLI parity: DSH counts/lists and evidence refs match the CLI read views', async () => {
  const home = join(makeRoot('adv-dsh-parity-'), 'home')
  // The CLI view is trusted-local and has no clearance gate; use a ledger without
  // protected rows so the parity comparison is apples-to-apples (the protected
  // path is covered by the clearance test above).
  seedLedger(home, { secret: false })
  const { byName } = mount({ home })
  const today = (await execute(byName.get('advisers_today'))).value.data
  const who = (await execute(byName.get('advisers_who'))).value.data
  const evidence = (await execute(byName.get('advisers_evidence'), { id: 'cm_today' })).value.data

  const cliToday = cli(home, ['today', '--json'])
  for (const key of ['overdue', 'today', 'week', 'waiting', 'noDue']) {
    assert.equal(today.counts[key], cliToday.counts[key], 'today.' + key + ' must match the CLI')
    assert.deepEqual(today[key].map((row) => row.id), cliToday[key].map((row) => row.id), 'today ' + key + ' list must match the CLI')
  }
  assert.equal(today.next?.id, cliToday.next?.id)

  const cliWho = cli(home, ['who', '--json'])
  assert.deepEqual(who.mine.map((row) => row.id).sort(), cliWho.mine.map((row) => row.id).sort())
  assert.deepEqual(who.waiting.map((row) => row.id).sort(), cliWho.waiting.map((row) => row.id).sort())

  const cliEvidence = cli(home, ['evidence', 'show', 'cm_today', '--json'])
  const cliRefs = cliEvidence.sources.map((source) => source.sessionId + '#' + source.turnId).sort()
  assert.deepEqual(evidence.sources.map((source) => source.ref).sort(), cliRefs)
  assert.equal(evidence.counts.sources, cliEvidence.sources.length)
})

test('legacy JSON store (ADVISERS_STORE=json) is read read-only', async () => {
  const home = join(makeRoot('adv-dsh-json-'), 'home')
  mkdirSync(home, { recursive: true })
  seedAcceptedTos(home)
  const state = {
    version: 1,
    matters: [{ id: 'm_json', title: 'json matter', status: 'active', domain: 'work', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    commitments: [{ id: 'cm_json', matterId: 'm_json', debtor: 'user', creditor: 'boss', action: 'json action', dueAt: new Date().toISOString(), timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none' }],
    facts: [], preferences: [], links: [], updates: [], routines: [], routinePatches: [], routes: {},
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const jsonHash = hashFile(join(home, 'state.json'))
  process.env.ADVISERS_STORE = 'json'
  try {
    const { byName } = mount({ home })
    const today = await execute(byName.get('advisers_today'))
    assert.equal(today.value.ok, true, JSON.stringify(today.value))
    assert.equal(today.value.data.backend, 'json')
    assert.equal(today.value.data.preview, false)
    assert.equal(today.value.data.source, 'ledger-readonly')
    assert.equal(today.value.data.counts.open, 1)
    assert.deepEqual(today.value.data.today.map((row) => row.id), ['cm_json'])
    const evidence = await execute(byName.get('advisers_evidence'), { id: 'cm_json' })
    assert.equal(evidence.value.ok, true)
    assert.equal(evidence.value.data.record.action, 'json action')
  } finally {
    delete process.env.ADVISERS_STORE
  }
  assert.equal(hashFile(join(home, 'state.json')), jsonHash, 'a JSON read must not modify state.json')
})

test('read tool descriptions disclose real-ledger reads and the preview fallback', async () => {
  const { byName } = mount({ home: EMPTY_HOME })
  for (const name of ['advisers_today', 'advisers_who', 'advisers_evidence']) {
    const description = byName.get(name).description
    assert.match(description, /read-only/i, name + ' must say read-only')
    assert.match(description, /~\/\.advisers\/state\.db/, name + ' must name the ledger')
    assert.match(description, /preview/i, name + ' must disclose the preview fallback')
    assert.match(description, /clearance 0/i, name + ' must disclose clearance 0')
    assert.match(description, /(Never writes the ledger|write the ledger, or send a message)/, name + ' keeps the no-write promise')
    assert.doesNotMatch(description, /does not open/i, name + ' must not claim the ledger is unwired')
  }
})
