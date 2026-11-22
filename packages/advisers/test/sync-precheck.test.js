import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { SqliteStore } from '../lib/sqlite.js'
import {
  SYNC_CONFLICT_CODE,
  SNAPSHOT_PAYLOAD_VERSION,
  computeSyncConflict,
  inspectSnapshots,
  planPushSnapshot,
  precheckSync,
  pullSnapshot,
  pushSnapshot,
  readLocalDbFingerprint,
  refreshSyncStateLocalSha,
} from '../lib/sync.js'
import { readSyncState, writeSyncState } from '../lib/sync-state.js'
import { encryptJson } from '../lib/vault.js'

// 0.5.0 050-S2 (plan 121 §3 S2.1/S2.4): snapshot payload v2 metadata, a real
// zero-write `sync push --dry-run`, the sync.state.json baseline, and the
// stale push/pull refusal with `--force` keeping a `.before-sync-*` copy.
// v1 snapshots stay readable and callers that do not pass a HOME keep the exact
// 0.4.3 semantics (no precheck, no state file).

const PASSPHRASE = 'correct horse battery'
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'advisers-sync-precheck-'))
}

function makeHome(root, name) {
  const home = join(root, name)
  mkdirSync(home, { recursive: true })
  return home
}

function seedDatabase(dbPath, contents = []) {
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const store = new SqliteStore(dbPath)
  try {
    for (const content of contents) store.addTurn({ conversationId: 'c1', role: 'user', content })
  } finally {
    store.close()
  }
}

function addTurn(dbPath, content) {
  const store = new SqliteStore(dbPath)
  try { store.addTurn({ conversationId: 'c1', role: 'user', content }) } finally { store.close() }
}

function turnContents(dbPath) {
  const store = new SqliteStore(dbPath)
  try { return store.db.prepare('SELECT content FROM turns ORDER BY seq').all().map((row) => row.content) } finally { store.close() }
}

function dbHash(dbPath) {
  return sha256(readFileSync(dbPath))
}

function fileHashes(dir) {
  const hashes = {}
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name)
    let info
    try { info = statSync(file) } catch { continue }
    if (!info.isFile()) continue
    hashes[name] = sha256(readFileSync(file))
  }
  return hashes
}

function backupFiles(home) {
  return readdirSync(home).filter((name) => name.startsWith('state.db.before-sync-'))
}

function syncFiles(dir) {
  return readdirSync(dir).filter((name) => name.endsWith('.enc.json')).sort()
}

test('created snapshots are payload v2 with dbMtimeMs/dbSha256/sourceSchemaVersion, and v1 payloads stay readable', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root, 'home-a')
    const dbPath = join(home, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbPath, ['快照内容'])
    const pushed = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a' })
    const inspected = inspectSnapshots(dir, { passphrase: PASSPHRASE })
    assert.equal(inspected.snapshots.length, 1)
    const entry = inspected.snapshots[0]
    assert.equal(entry.readable, true)
    assert.equal(entry.error, null)
    assert.equal(entry.payloadVersion, SNAPSHOT_PAYLOAD_VERSION)
    assert.equal(entry.dbSha256, sha256(readFileSync(dbPath)))
    assert.equal(entry.dbSha256, pushed.sha256)
    assert.equal(entry.dbSha256Recorded, entry.dbSha256)
    assert.ok(Number.isFinite(entry.dbMtimeMs), 'dbMtimeMs was statted before the bytes were read')
    assert.ok(Number.isInteger(entry.sourceSchemaVersion) && entry.sourceSchemaVersion > 0)
    // A 0.4.3 writer (payload v1, no v2 fields) is still fully readable/pullable.
    const v1Home = makeHome(root, 'home-v1')
    const v1Db = join(v1Home, 'state.db')
    seedDatabase(v1Db, ['旧版快照内容'])
    const v1Bytes = readFileSync(v1Db)
    const v1Payload = {
      kind: 'advisers-sync-db',
      version: 1,
      device: 'old-cli',
      createdAt: '2026-11-01T00:00:00.000Z',
      sha256: sha256(v1Bytes),
      db: v1Bytes.toString('base64'),
    }
    const v1Envelope = encryptJson(v1Payload, PASSPHRASE)
    v1Envelope.sync = { v: 1, createdAt: v1Payload.createdAt, device: 'old-cli' }
    const v1Dir = join(root, 'sync-v1')
    mkdirSync(v1Dir)
    writeFileSync(join(v1Dir, 'advisers-old-cli-20261101T000000Z.enc.json'), JSON.stringify(v1Envelope) + '\n')
    const v1Inspect = inspectSnapshots(v1Dir, { passphrase: PASSPHRASE })
    assert.equal(v1Inspect.snapshots[0].payloadVersion, 1)
    assert.equal(v1Inspect.snapshots[0].dbSha256, v1Payload.sha256)
    assert.equal(v1Inspect.snapshots[0].dbMtimeMs, null)
    assert.equal(v1Inspect.snapshots[0].sourceSchemaVersion, null)
    const targetHome = makeHome(root, 'home-v1-target')
    const pulled = pullSnapshot({ dir: v1Dir, dbPath: join(targetHome, 'state.db'), passphrase: PASSPHRASE })
    assert.equal(pulled.changed, true)
    assert.equal(pulled.status, 'bootstrapped')
    assert.equal(pulled.payloadVersion, 1)
    assert.deepEqual(turnContents(join(targetHome, 'state.db')), ['旧版快照内容'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('planPushSnapshot and pushSnapshot(dryRun) write nothing (no dir, no state, no snapshot)', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root, 'home-a')
    const dbPath = join(home, 'state.db')
    seedDatabase(dbPath, ['dry-run 内容'])
    const dir = join(root, 'sync')
    const before = fileHashes(home)
    const plan = planPushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-01T00:00:00.000Z') })
    assert.equal(plan.ok, true, JSON.stringify(plan.errors))
    assert.equal(plan.dryRun, true)
    assert.equal(plan.wouldPush, true)
    assert.equal(plan.sha256, dbHash(dbPath))
    assert.equal(plan.dbSha256, plan.sha256)
    assert.ok(plan.bytes > 0)
    assert.equal(plan.walBytes, 0)
    assert.equal(plan.name, 'advisers-device-a-20261101T000000Z.enc.json')
    assert.equal(plan.file, join(dir, plan.name))
    assert.equal(existsSync(dir), false, 'planning a push does not create the sync directory')
    const dry = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', home, dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.wouldPush, true)
    assert.equal(dry.wouldRefuse, false)
    assert.equal(dry.sha256, dbHash(dbPath))
    assert.equal(existsSync(dir), false)
    assert.equal(existsSync(join(home, 'sync.state.json')), false, 'a dry run does not write the sync baseline')
    assert.deepEqual(fileHashes(home), before, 'a push dry run leaves the HOME byte-identical')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a push plan with a non-empty WAL reports the sha256 as unknown instead of guessing', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root, 'home-a')
    const dbPath = join(home, 'state.db')
    seedDatabase(dbPath)
    const dir = join(root, 'sync')
    const store = new SqliteStore(dbPath)
    try {
      store.db.exec('PRAGMA wal_autocheckpoint = 0')
      store.appendAudit({ actor: 'local', action: 'sync.wal-test', allowed: true, reason: null })
      const walBytes = statSync(dbPath + '-wal').size
      assert.ok(walBytes > 0, 'precondition: the WAL holds uncheckpointed frames')
      const plan = planPushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a' })
      assert.equal(plan.walBytes, walBytes)
      assert.equal(plan.sha256, null, 'the complete database hash cannot be predicted from a non-empty WAL')
      assert.ok(plan.warnings.some((warning) => /WAL still holds/.test(warning)), JSON.stringify(plan.warnings))
      const dry = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', dryRun: true })
      assert.equal(dry.sha256, null)
      assert.equal(existsSync(dir), false)
      const fingerprint = readLocalDbFingerprint(dbPath)
      assert.equal(fingerprint.walBytes, walBytes)
      assert.equal(fingerprint.sha256, null)
    } finally {
      store.close()
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('push/pull record the sync baseline; refreshSyncStateLocalSha fixes it after a pull audit row', () => {
  const root = makeRoot()
  try {
    const homeA = makeHome(root, 'home-a')
    const dbA = join(homeA, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbA, ['A 的数据'])
    const pushed = pushSnapshot({ dir, dbPath: dbA, passphrase: PASSPHRASE, device: 'device-a', home: homeA })
    assert.equal(pushed.state.ok, true, JSON.stringify(pushed.state))
    const stateA = readSyncState({ home: homeA })
    assert.equal(stateA.state.device, 'device-a')
    assert.equal(stateA.state.lastPush.sha256, pushed.sha256)
    assert.equal(stateA.state.lastPush.dbSha256, pushed.sha256)
    assert.ok(Number.isInteger(stateA.state.localSchemaVersion))
    // A second device boots from the snapshot and records lastPull.
    const homeB = makeHome(root, 'home-b')
    const dbB = join(homeB, 'state.db')
    const pulled = pullSnapshot({ dir, dbPath: dbB, passphrase: PASSPHRASE, localDevice: 'device-b', home: homeB })
    assert.equal(pulled.changed, true)
    assert.equal(pulled.state.ok, true, JSON.stringify(pulled.state))
    const stateB = readSyncState({ home: homeB })
    assert.equal(stateB.state.device, 'device-b')
    assert.equal(stateB.state.lastPull.sha256, pushed.sha256)
    assert.equal(stateB.state.lastPull.localDbSha256, pushed.sha256)
    assert.equal(stateB.state.lastPull.sourceDevice, 'device-a')
    assert.equal(stateB.state.lastPush, null)
    // The bin/ caller appends its sync.pull audit row after the pull; refresh the
    // baseline so the next precheck does not see a false local change.
    const store = new SqliteStore(dbB)
    try { store.appendAudit({ actor: 'local', action: 'sync.pull', allowed: true, reason: 'advisers-device-a.enc.json' }) } finally { store.close() }
    const refreshed = refreshSyncStateLocalSha({ home: homeB, dbPath: dbB })
    assert.equal(refreshed.ok, true, JSON.stringify(refreshed.errors))
    assert.equal(refreshed.updated, 'lastPull.localDbSha256')
    assert.equal(refreshed.sha256, dbHash(dbB))
    const stateAfter = readSyncState({ home: homeB }).state
    assert.equal(stateAfter.lastPull.localDbSha256, dbHash(dbB))
    const pre = precheckSync({ direction: 'push', dir, dbPath: dbB, passphrase: PASSPHRASE, device: 'device-b', home: homeB })
    assert.equal(pre.localChanged, false, 'the refreshed baseline sees no local change')
    assert.equal(pre.remoteAdvanced, false)
    assert.equal(pre.status, 'clear')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a stale push is refused (E_SYNC_CONFLICT) with the sync dir and database unchanged; --force keeps a .before-sync copy', () => {
  const root = makeRoot()
  try {
    const homeA = makeHome(root, 'home-a')
    const homeB = makeHome(root, 'home-b')
    const dbA = join(homeA, 'state.db')
    const dbB = join(homeB, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbA, ['base'])
    pushSnapshot({ dir, dbPath: dbA, passphrase: PASSPHRASE, device: 'device-a', home: homeA })
    pullSnapshot({ dir, dbPath: dbB, passphrase: PASSPHRASE, localDevice: 'device-b', home: homeB })
    // Both devices write; A pushes first, B's push is now stale.
    addTurn(dbA, 'a2')
    pushSnapshot({ dir, dbPath: dbA, passphrase: PASSPHRASE, device: 'device-a', home: homeA })
    addTurn(dbB, 'b2')
    const pre = precheckSync({ direction: 'push', dir, dbPath: dbB, passphrase: PASSPHRASE, device: 'device-b', home: homeB })
    assert.equal(pre.status, 'conflict')
    assert.equal(pre.conflict, true)
    assert.equal(pre.localChanged, true)
    assert.equal(pre.remoteAdvanced, true)
    assert.equal(pre.sameDevice, false)
    assert.equal(pre.wouldRefuse, true)
    const filesBefore = syncFiles(dir)
    const dbBefore = dbHash(dbB)
    const homeBefore = fileHashes(homeB)
    assert.throws(
      () => pushSnapshot({ dir, dbPath: dbB, passphrase: PASSPHRASE, device: 'device-b', home: homeB }),
      (error) => {
        assert.equal(error.code, SYNC_CONFLICT_CODE)
        assert.match(error.message, /E_SYNC_CONFLICT/)
        assert.equal(error.conflict, true)
        return true
      },
    )
    assert.deepEqual(syncFiles(dir), filesBefore, 'a refused push writes no snapshot')
    assert.equal(dbHash(dbB), dbBefore, 'a refused push leaves the database byte-identical')
    assert.deepEqual(fileHashes(homeB), homeBefore, 'a refused push writes nothing else in HOME')
    const forced = pushSnapshot({ dir, dbPath: dbB, passphrase: PASSPHRASE, device: 'device-b', home: homeB, force: true })
    assert.equal(forced.conflict, true)
    assert.ok(forced.backup, '--force keeps a .before-sync copy')
    assert.ok(existsSync(forced.backup))
    assert.equal(sha256(readFileSync(forced.backup)), dbBefore)
    assert.equal(syncFiles(dir).length, filesBefore.length + 1)
    assert.equal(backupFiles(homeB).length, 1)
    // bin/ runs the precheck itself (before its sync.push audit row) and calls
    // pushSnapshot with precheck:false; --force must still keep a copy then.
    const forcedNoPrecheck = pushSnapshot({ dir, dbPath: dbB, passphrase: PASSPHRASE, device: 'device-b', home: homeB, force: true, precheck: false })
    assert.ok(forcedNoPrecheck.backup, '--force keeps a .before-sync copy even when bin already prechecked')
    assert.ok(existsSync(forcedNoPrecheck.backup))
    assert.equal(backupFiles(homeB).length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a pull that would discard newer local writes is refused, then installed by --force with a backup', () => {
  const root = makeRoot()
  try {
    const homeA = makeHome(root, 'home-a')
    const homeB = makeHome(root, 'home-b')
    const dbA = join(homeA, 'state.db')
    const dbB = join(homeB, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbA, ['base'])
    pushSnapshot({ dir, dbPath: dbA, passphrase: PASSPHRASE, device: 'device-a', home: homeA })
    pullSnapshot({ dir, dbPath: dbB, passphrase: PASSPHRASE, localDevice: 'device-b', home: homeB })
    addTurn(dbA, 'a2')
    pushSnapshot({ dir, dbPath: dbA, passphrase: PASSPHRASE, device: 'device-a', home: homeA })
    addTurn(dbB, 'only-on-b')
    const pre = precheckSync({ direction: 'pull', dir, dbPath: dbB, passphrase: PASSPHRASE, localDevice: 'device-b', home: homeB })
    assert.equal(pre.status, 'conflict')
    assert.equal(pre.wouldRefuse, true)
    const dbBefore = dbHash(dbB)
    const homeBefore = fileHashes(homeB)
    assert.throws(
      () => pullSnapshot({ dir, dbPath: dbB, passphrase: PASSPHRASE, localDevice: 'device-b', home: homeB }),
      (error) => {
        assert.equal(error.code, SYNC_CONFLICT_CODE)
        return true
      },
    )
    assert.equal(dbHash(dbB), dbBefore, 'the refused pull leaves the database byte-identical')
    assert.deepEqual(fileHashes(homeB), homeBefore, 'the refused pull writes nothing')
    const forced = pullSnapshot({ dir, dbPath: dbB, passphrase: PASSPHRASE, localDevice: 'device-b', home: homeB, force: true })
    assert.equal(forced.changed, true)
    assert.equal(forced.status, 'forced')
    assert.ok(forced.conflict, 'the conflict is still reported on a forced pull')
    assert.ok(forced.backup, 'a forced pull keeps the pre-pull database')
    assert.equal(sha256(readFileSync(forced.backup)), dbBefore)
    assert.deepEqual(turnContents(dbB), ['base', 'a2'], 'the newer remote snapshot is installed')
    assert.equal(readSyncState({ home: homeB }).state.lastPull.sha256, sha256(readFileSync(dbB)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('precheckSync(status) is read-only and reports the local/remote comparison', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root, 'home-a')
    const dbPath = join(home, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbPath, ['status'])
    const pushed = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', home })
    const before = fileHashes(home)
    const status = precheckSync({ direction: 'status', dir, dbPath, passphrase: PASSPHRASE, localDevice: 'device-a', home })
    assert.equal(status.ok, true, JSON.stringify(status.errors))
    assert.equal(status.direction, 'status')
    assert.equal(status.status, 'clear')
    assert.equal(status.newest.file, basename(pushed.file))
    assert.equal(status.newest.sha256, pushed.sha256)
    assert.equal(status.local.sha256, dbHash(dbPath))
    assert.ok(Number.isInteger(status.local.sourceSchemaVersion))
    assert.equal(status.baseline.kind, 'push')
    assert.deepEqual(fileHashes(home), before, 'status --check data is collected without writing')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a state write failure after a successful push is a warning, not a data-operation failure', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root, 'home-a')
    const dbPath = join(home, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbPath, ['state failure'])
    // A directory at the state path makes every read/write fail structurally.
    mkdirSync(join(home, 'sync.state.json'))
    const pushed = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', home })
    assert.ok(existsSync(pushed.file), 'the snapshot itself is written')
    assert.equal(sha256(readFileSync(pushed.file)), sha256(readFileSync(pushed.file)))
    assert.equal(pushed.state.ok, false)
    assert.ok(pushed.state.warnings.length >= 1 || pushed.state.errors.length >= 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('without a HOME the 0.4.3 semantics are unchanged (no precheck, no state file)', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root, 'home-a')
    const dbPath = join(home, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbPath, ['legacy'])
    const pushed = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a' })
    assert.equal(existsSync(join(home, 'sync.state.json')), false)
    assert.equal(pushed.state, null)
    assert.equal(pushed.conflict, null)
    const localHome = makeHome(root, 'home-b')
    const pulled = pullSnapshot({ dir, dbPath: join(localHome, 'state.db'), passphrase: PASSPHRASE })
    assert.equal(pulled.changed, true)
    assert.equal(pulled.state, null)
    assert.equal(existsSync(join(localHome, 'sync.state.json')), false)
    // computeSyncConflict remains importable and pure for callers that pass a state.
    assert.equal(typeof computeSyncConflict, 'function')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('writeSyncState accepts a baseline produced by push and precheck reads it back', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root, 'home-a')
    const dbPath = join(home, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(dbPath)
    const pushed = pushSnapshot({ dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', home })
    const read = readSyncState({ home })
    assert.equal(read.ok, true)
    assert.equal(writeSyncState({ home, state: read.state }).ok, true)
    const pre = precheckSync({ direction: 'push', dir, dbPath, passphrase: PASSPHRASE, device: 'device-a', home })
    assert.equal(pre.status, 'clear')
    assert.equal(pre.localChanged, false)
    assert.equal(pre.remoteAdvanced, false)
    assert.equal(pre.newest.sha256, pushed.sha256)
  } finally { rmSync(root, { recursive: true, force: true }) }
})