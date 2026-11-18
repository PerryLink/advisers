import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { SqliteStore } from '../lib/sqlite.js'
import {
  cleanupStalePullTemps,
  inspectLocalLedger,
  listSnapshots,
  PULL_TMP_PREFIX,
  pullSnapshot,
  pushSnapshot,
  selectSnapshot,
} from '../lib/sync.js'
import { tosEnv } from './tos-fixture.js'

// 0.2.3 robustness Phase 0 (robustness audit 2026-11-17 P1-1):
// - a brand-new device must be able to bootstrap (init-created empty DB) without
//   --force;
// - snapshot selection must use the snapshot createdAt, not file mtimes, so a
//   mtime-skewed sync directory cannot make `pull --force` silently install an
//   older snapshot;
// - the library API reports localEmpty / snapshotOlder / status so bin/ can
//   explain the decision.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const PASSPHRASE = 'correct horse battery'

function envFor(home, env = {}) {
  return tosEnv(home, {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_SYNC_PASSPHRASE: PASSPHRASE,
    ...env,
  })
}

function cli(home, args, env = {}) {
  return execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: envFor(home, env) })
}

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'advisers-sync-bootstrap-'))
}

function seedDatabase(dbPath, contents = []) {
  const store = new SqliteStore(dbPath)
  try {
    for (const content of contents) store.addTurn({ conversationId: 'c1', role: 'user', content })
  } finally { store.close() }
}

function rowCount(dbPath, table = 'turns') {
  const store = new SqliteStore(dbPath)
  try { return Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) } finally { store.close() }
}

function backupFiles(home) {
  return readdirSync(home).filter((name) => name.startsWith('state.db.before-sync-'))
}

test('inspectLocalLedger: a fresh empty database is bootstrap-able, user rows are not', () => {
  const root = makeRoot()
  try {
    const emptyDb = join(root, 'empty', 'state.db')
    mkdirSync(join(root, 'empty'), { recursive: true })
    seedDatabase(emptyDb)
    const empty = inspectLocalLedger(emptyDb)
    assert.equal(empty.exists, true)
    assert.equal(empty.empty, true)
    assert.equal(empty.userRows, 0)
    const missing = inspectLocalLedger(join(root, 'missing', 'state.db'))
    assert.equal(missing.exists, false)
    assert.equal(missing.empty, true)
    seedDatabase(emptyDb, ['一条真实承诺'])
    const filled = inspectLocalLedger(emptyDb)
    assert.equal(filled.empty, false)
    assert.equal(filled.userRows, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('selectSnapshot uses createdAt, not mtime, and warns when the sync tool rewrote timestamps', () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const dbPath = join(home, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbPath, ['第一条'])
    const older = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-01T00:00:00.000Z') })
    seedDatabase(dbPath, ['第一条', '第二条'])
    const newer = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-02T00:00:00.000Z') })
    assert.notEqual(older.file, newer.file)
    const listed = listSnapshots(dir)
    assert.equal(listed.length, 2)
    assert.equal(listed.find((entry) => entry.name.endsWith('.enc.json') && entry.createdAt === '2026-11-02T00:00:00.000Z')?.createdAtSource, 'envelope')
    // Simulate a sync tool that gave the older snapshot the newest file mtime.
    const future = new Date(Date.now() + 3_600_000)
    const past = new Date(Date.now() - 3_600_000)
    utimesSync(older.file, future, future)
    utimesSync(newer.file, past, past)
    const selected = selectSnapshot({ dir, passphrase: PASSPHRASE })
    assert.equal(selected.chosen.name, newer.file.split('/').pop(), 'content-newest snapshot must win over mtime')
    assert.ok(selected.warnings.some((warning) => /mtimes disagree/.test(warning)), 'the mtime/createdAt disagreement is not silent')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pullSnapshot bootstraps a new device (no local DB) and reports localEmpty/status', () => {
  const root = makeRoot()
  try {
    const homeA = join(root, 'home-a')
    mkdirSync(homeA, { recursive: true })
    const dbPath = join(homeA, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbPath, ['快照里的承诺'])
    pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a' })
    const homeB = join(root, 'home-b')
    mkdirSync(homeB, { recursive: true })
    const emptyDb = join(homeB, 'state.db')
    seedDatabase(emptyDb)
    const result = pullSnapshot({ dir, dbPath: emptyDb, passphrase: PASSPHRASE })
    assert.equal(result.changed, true)
    assert.equal(result.localEmpty, true)
    assert.equal(result.status, 'bootstrapped', 'an init-created empty ledger bootstraps without --force')
    assert.equal(result.snapshotOlder, false)
    assert.ok(result.backup, 'the empty file is still backed up')
    assert.equal(rowCount(emptyDb), 1)
    assert.equal(backupFiles(homeB).length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pullSnapshot refuses to overwrite a newer non-empty ledger without force and exposes snapshotOlder', () => {
  const root = makeRoot()
  try {
    const homeA = join(root, 'home-a')
    mkdirSync(homeA, { recursive: true })
    const dbPath = join(homeA, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbPath, ['旧快照'])
    pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-01T00:00:00.000Z') })
    const homeB = join(root, 'home-b')
    mkdirSync(homeB, { recursive: true })
    const localDb = join(homeB, 'state.db')
    seedDatabase(localDb, ['本机更新的数据'])
    assert.throws(
      () => pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE }),
      /refusing to overwrite/,
    )
    assert.equal(rowCount(localDb), 1, 'the local ledger is untouched')
    // With force the library still reports the situation (snapshotOlder + warning)
    // instead of silently claiming a clean pull.
    const forced = pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE, force: true })
    assert.equal(forced.status, 'forced')
    assert.equal(forced.localEmpty, false)
    assert.equal(forced.snapshotOlder, true)
    assert.ok(forced.warnings.some((warning) => /newer local database/.test(warning)), 'replacing newer local data is warned about')
    assert.equal(rowCount(localDb), 1)
    const installed = new SqliteStore(localDb)
    try { assert.equal(installed.db.prepare('SELECT content FROM turns').get().content, '旧快照') } finally { installed.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('force still selects the content-newest snapshot when a stale mtime points at an older one', () => {
  const root = makeRoot()
  try {
    const homeA = join(root, 'home-a')
    mkdirSync(homeA, { recursive: true })
    const dbPath = join(homeA, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbPath, ['旧内容'])
    const older = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-01T00:00:00.000Z') })
    seedDatabase(dbPath, ['新内容'])
    const newer = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-02T00:00:00.000Z') })
    const future = new Date(Date.now() + 3_600_000)
    utimesSync(older.file, future, future)
    const homeB = join(root, 'home-b')
    mkdirSync(homeB, { recursive: true })
    const localDb = join(homeB, 'state.db')
    seedDatabase(localDb, ['本机数据'])
    const result = pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE, force: true })
    assert.equal(result.file, newer.file.split('/').pop())
    assert.equal(result.status, 'forced')
    assert.equal(rowCount(localDb), 2, 'the content-newest snapshot (2 rows) was installed, not the mtime-newest (1 row)')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a non-newest --file selection is warned about instead of pretending it is the latest', () => {
  const root = makeRoot()
  try {
    const homeA = join(root, 'home-a')
    mkdirSync(homeA, { recursive: true })
    const dbPath = join(homeA, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbPath, ['第一版'])
    const older = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-01T00:00:00.000Z') })
    seedDatabase(dbPath, ['第一版', '第二版'])
    pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-02T00:00:00.000Z') })
    const homeB = join(root, 'home-b')
    mkdirSync(homeB, { recursive: true })
    const localDb = join(homeB, 'state.db')
    seedDatabase(localDb, ['本机'])
    const result = pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE, file: older.file.split('/').pop(), force: true })
    assert.equal(result.explicit, true)
    assert.ok(result.warnings.some((warning) => /--file selected .*newer createdAt/.test(warning)), '--force must not make an older --file selection look newest')
    assert.equal(rowCount(localDb), 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('same content: a pull without force reports unchanged and does not touch the database', () => {
  const root = makeRoot()
  try {
    const homeA = join(root, 'home-a')
    mkdirSync(homeA, { recursive: true })
    const dbPath = join(homeA, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbPath, ['同样内容'])
    pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE })
    const homeB = join(root, 'home-b')
    mkdirSync(homeB, { recursive: true })
    const localDb = join(homeB, 'state.db')
    seedDatabase(localDb)
    const first = pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE })
    assert.equal(first.changed, true)
    const backupsAfterFirst = backupFiles(homeB).length
    const second = pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE })
    assert.equal(second.changed, false)
    assert.equal(second.status, 'unchanged')
    assert.equal(second.backup, null)
    assert.equal(backupFiles(homeB).length, backupsAfterFirst, 'an unchanged pull creates no extra backup')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an unreadable snapshot makes the newest undecidable: pull requires --file, it never guesses', () => {
  const root = makeRoot()
  try {
    const homeA = join(root, 'home-a')
    mkdirSync(homeA, { recursive: true })
    const dbPath = join(homeA, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbPath, ['好快照'])
    const good = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a' })
    const garbage = join(dir, 'advisers-dead-device-20260101T000000Z.enc.json')
    writeFileSync(garbage, 'this is not a snapshot\n')
    const homeB = join(root, 'home-b')
    mkdirSync(homeB, { recursive: true })
    const localDb = join(homeB, 'state.db')
    assert.throws(
      () => pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE }),
      (error) => /cannot determine the newest snapshot/.test(error.message) && /--file/.test(error.message),
    )
    assert.throws(
      () => pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE, file: 'advisers-dead-device-20260101T000000Z.enc.json', force: true }),
      /cannot be used/,
    )
    const explicit = pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE, file: good.file.split('/').pop() })
    assert.equal(explicit.changed, true)
    assert.equal(rowCount(localDb), 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('tampered envelope metadata is detected against the authenticated payload', () => {
  const root = makeRoot()
  try {
    const homeA = join(root, 'home-a')
    mkdirSync(homeA, { recursive: true })
    const dbPath = join(homeA, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbPath, ['原快照'])
    const pushed = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-01T00:00:00.000Z') })
    const envelope = JSON.parse(readFileSync(pushed.file, 'utf8'))
    envelope.sync = { v: 1, createdAt: '2099-01-01T00:00:00.000Z', device: 'device-a' }
    writeFileSync(pushed.file, JSON.stringify(envelope) + '\n')
    const homeB = join(root, 'home-b')
    mkdirSync(homeB, { recursive: true })
    const localDb = join(homeB, 'state.db')
    assert.throws(
      () => pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE }),
      (error) => /tampered/.test(error.message) && /--file/.test(error.message),
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cleanupStalePullTemps removes dead-pid stale staging files and their sidecars, keeps live/fresh ones', () => {
  const root = makeRoot()
  try {
    const deadPid = 999_999
    const stale = join(root, `${PULL_TMP_PREFIX}${deadPid}-stale`)
    const staleWal = `${stale}-wal`
    const staleShm = `${stale}-shm`
    for (const file of [stale, staleWal, staleShm]) {
      writeFileSync(file, 'plaintext staging bytes')
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
      utimesSync(file, old, old)
    }
    const fresh = join(root, `${PULL_TMP_PREFIX}${deadPid}-fresh`)
    writeFileSync(fresh, 'in progress')
    const live = join(root, `${PULL_TMP_PREFIX}${process.pid}-live`)
    writeFileSync(live, 'this process is alive')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(live, old, old)
    const result = cleanupStalePullTemps(root)
    assert.deepEqual(result.removed.sort(), [stale, staleShm, staleWal].sort())
    assert.equal(existsSync(stale), false)
    assert.equal(existsSync(staleWal), false)
    assert.equal(existsSync(staleShm), false)
    assert.equal(existsSync(fresh), true, 'a fresh staging file may belong to a running pull')
    assert.equal(existsSync(live), true, 'a live pid is never swept')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('CLI: a new device bootstraps with init + sync pull (no --force) and keeps a backup', () => {
  const root = makeRoot()
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  const dir = join(root, 'sync')
  try {
    mkdirSync(homeA, { recursive: true })
    cli(homeA, ['commit', 'add', '跨设备承诺', '--quote', '跨设备承诺'])
    assert.match(cli(homeA, ['sync', 'push', '--dir', dir, '--device', 'device-a']), /pushed/)
    assert.match(cli(homeB, ['init']), /home/)
    // A truly fresh machine gets an empty state.db from the TOS gate/init; the
    // seeded tosEnv fixture skips the gate, so create it with a first read command.
    cli(homeB, ['commit', 'ls'])
    assert.ok(existsSync(join(homeB, 'state.db')), 'the first command created the empty local database')
    const out = cli(homeB, ['sync', 'pull', '--dir', dir])
    assert.match(out, /pulled/, 'the documented bootstrap flow must work without --force')
    assert.match(cli(homeB, ['commit', 'ls']), /跨设备承诺/)
    assert.equal(backupFiles(homeB).length, 1, 'the empty init DB is backed up before replacement')
    // The pull appended a sync.pull audit row, so the local DB is now newer than
    // the snapshot: a repeated pull without --force must refuse (same as 0.2.2)
    // and an explicit --force instead reinstalls the snapshot.
    const repeat = spawnSync(process.execPath, [bin, 'sync', 'pull', '--dir', dir], { encoding: 'utf8', env: envFor(homeB) })
    assert.equal(repeat.status, 1)
    assert.match(repeat.stderr + repeat.stdout, /refusing to overwrite/)
    assert.match(cli(homeB, ['sync', 'pull', '--dir', dir, '--force']), /pulled/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('CLI: --force pull with skewed mtimes installs the content-newest snapshot', () => {
  const root = makeRoot()
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  const dir = join(root, 'sync')
  try {
    mkdirSync(homeA, { recursive: true })
    cli(homeA, ['commit', 'add', '第一份', '--quote', '第一份'])
    const dbPath = join(homeA, 'state.db')
    const older = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-01T00:00:00.000Z') })
    cli(homeA, ['commit', 'add', '第二份', '--quote', '第二份'])
    pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-02T00:00:00.000Z') })
    // The OLD snapshot gets the newest mtime: mtime ordering must not decide.
    const future = new Date(Date.now() + 3_600_000)
    utimesSync(older.file, future, future)
    cli(homeB, ['init'])
    assert.match(cli(homeB, ['sync', 'pull', '--dir', dir, '--force']), /pulled/)
    const listed = cli(homeB, ['commit', 'ls'])
    assert.match(listed, /第一份/)
    assert.match(listed, /第二份/, 'the newest snapshot contains both commitments')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
