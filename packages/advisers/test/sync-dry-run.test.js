import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { SqliteStore } from '../lib/sqlite.js'
import { PULL_TMP_PREFIX, pullSnapshot, pushSnapshot } from '../lib/sync.js'
import { decryptJson, encryptJson } from '../lib/vault.js'

// `sync pull --dry-run`: pullSnapshot({ dryRun: true }) performs the whole
// read-only decision — snapshot selection, decryption + SHA-256, the
// local-empty/older/same-device refusal rules — and predicts whether a real
// pull would replace the database. A dry run must never write the database,
// create a backup or staging temp file, sweep stale temp files or append an
// audit row, and its changed/status prediction must match the immediately
// following real pull. These tests use real encrypted snapshots built with
// pushSnapshot() and inspect the filesystem before and after every dry run.

const PASSPHRASE = 'correct horse battery'
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'advisers-sync-dry-run-'))
}

function seedDatabase(dbPath, contents = []) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const store = new SqliteStore(dbPath)
  try {
    for (const content of contents) store.addTurn({ conversationId: 'c1', role: 'user', content })
  } finally {
    store.close()
  }
}

function rowCount(dbPath, table = 'turns') {
  const store = new SqliteStore(dbPath)
  try { return Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) } finally { store.close() }
}

function turnContents(dbPath) {
  const store = new SqliteStore(dbPath)
  try { return store.db.prepare('SELECT content FROM turns ORDER BY seq').all().map((row) => row.content) } finally { store.close() }
}

/** Byte hash of every regular file in a directory: an exact no-write snapshot. */
function fileHashes(dir) {
  const hashes = {}
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name)
    let entry
    try { entry = statSync(file) } catch { continue }
    if (!entry.isFile()) continue
    hashes[name] = sha256(readFileSync(file))
  }
  return hashes
}

function backupFiles(home) {
  return readdirSync(home).filter((name) => name.startsWith('state.db.before-sync-'))
}

function stagingFiles(home) {
  return readdirSync(home).filter((name) => name.startsWith(PULL_TMP_PREFIX))
}

/** A dry run must leave the HOME directory byte-identical and add no copy. */
function assertNoSideEffects(home, before) {
  assert.deepEqual(fileHashes(home), before, 'a dry run must not create, delete or rewrite any file in the HOME directory')
  assert.deepEqual(backupFiles(home), [], 'a dry run must not create a backup')
  assert.deepEqual(stagingFiles(home), [], 'a dry run must not leave a staging temp file')
}

function pullError(options) {
  try {
    pullSnapshot(options)
  } catch (error) {
    return error
  }
  assert.fail('expected pullSnapshot to throw')
}

test('dry run predicts a bootstrap on a new device without writing, and the real pull matches', () => {
  const root = makeRoot()
  try {
    const sourceHome = join(root, 'source-home')
    const sourceDb = join(sourceHome, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(sourceDb, ['来自另一台设备的承诺'])
    pushSnapshot({ dir, dbPath: sourceDb, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-01T00:00:00.000Z') })

    const targetHome = join(root, 'target-home')
    const localDb = join(targetHome, 'state.db')
    seedDatabase(localDb) // init-created, schema-only local database
    const dbBytes = sha256(readFileSync(localDb))
    const homeBefore = fileHashes(targetHome)
    const syncBefore = fileHashes(dir)

    const dry = pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE, dryRun: true })
    assert.equal(dry.status, 'dry-run')
    assert.equal(dry.dryRun, true)
    assert.equal(dry.changed, false, 'a dry run never reports a change')
    assert.equal(dry.wouldChange, true)
    assert.equal(dry.wouldStatus, 'bootstrapped')
    assert.equal(dry.wouldBackup, true, 'the empty schema-only DB would still be backed up')
    assert.equal(dry.localEmpty, true)
    assert.equal(dry.snapshotOlder, false)
    assert.equal(dry.sameDevice, false)
    assert.equal(dry.backup, null)
    assert.equal(dry.file.endsWith('.enc.json'), true)

    assert.equal(sha256(readFileSync(localDb)), dbBytes, 'the local database bytes are untouched')
    assertNoSideEffects(targetHome, homeBefore)
    assert.deepEqual(fileHashes(dir), syncBefore, 'the snapshot directory is untouched')

    const real = pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE })
    assert.equal(real.changed, true)
    assert.equal(real.status, dry.wouldStatus, 'the dry-run status prediction matches the real pull')
    assert.equal(Boolean(real.backup), dry.wouldBackup, 'the dry-run backup prediction matches the real pull')
    assert.deepEqual(turnContents(localDb), ['来自另一台设备的承诺'])
    assert.equal(backupFiles(targetHome).length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dry run reports unchanged for an up-to-date database, and --force still predicts a replacement', () => {
  const root = makeRoot()
  try {
    const sourceHome = join(root, 'source-home')
    const sourceDb = join(sourceHome, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(sourceDb, ['快照内容'])
    pushSnapshot({ dir, dbPath: sourceDb, passphrase: PASSPHRASE, device: 'device-a' })

    const targetHome = join(root, 'target-home')
    const localDb = join(targetHome, 'state.db')
    seedDatabase(localDb)
    const bootstrapped = pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE })
    assert.equal(bootstrapped.status, 'bootstrapped')
    const backupsAfterBootstrap = backupFiles(targetHome).length
    const dbBytes = sha256(readFileSync(localDb))
    const homeBefore = fileHashes(targetHome)

    const dry = pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE, dryRun: true })
    assert.equal(dry.status, 'unchanged')
    assert.equal(dry.changed, false)
    assert.equal(dry.wouldChange, false)
    assert.equal(dry.wouldStatus, 'unchanged')
    assert.equal(dry.wouldBackup, false)
    assert.equal(dry.backup, null)
    assert.equal(sha256(readFileSync(localDb)), dbBytes)
    assert.deepEqual(fileHashes(targetHome), homeBefore, 'the no-op dry run writes nothing')
    assert.equal(backupFiles(targetHome).length, backupsAfterBootstrap, 'no extra backup for a no-op')
    assert.deepEqual(stagingFiles(targetHome), [])

    const real = pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE })
    assert.equal(real.status, dry.wouldStatus)
    assert.equal(real.changed, dry.wouldChange)
    assert.equal(real.backup, null)

    // `sync pull --force` has always replaced even identical bytes: the dry run
    // must predict that replacement instead of claiming the database is current.
    const forcedDry = pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE, dryRun: true, force: true })
    assert.equal(forcedDry.status, 'dry-run')
    assert.equal(forcedDry.wouldChange, true)
    assert.equal(forcedDry.wouldStatus, 'forced')
    assert.equal(forcedDry.wouldBackup, true)
    assert.deepEqual(fileHashes(targetHome), homeBefore, 'the forced dry run writes nothing either')

    const forcedReal = pullSnapshot({ dir, dbPath: localDb, passphrase: PASSPHRASE, force: true })
    assert.equal(forcedReal.changed, true)
    assert.equal(forcedReal.status, forcedDry.wouldStatus)
    assert.equal(Boolean(forcedReal.backup), forcedDry.wouldBackup)
    assert.equal(backupFiles(targetHome).length, backupsAfterBootstrap + 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dry run predicts a same-device pull and matches the real pull', () => {
  const root = makeRoot()
  try {
    const sourceHome = join(root, 'source-home')
    const sourceDb = join(sourceHome, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(sourceDb, ['快照里的内容'])
    pushSnapshot({ dir, dbPath: sourceDb, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-02T00:00:00.000Z') })

    const targetHome = join(root, 'target-home')
    const localDb = join(targetHome, 'state.db')
    seedDatabase(localDb, ['只在本机的内容'])
    const dbBytes = sha256(readFileSync(localDb))
    const homeBefore = fileHashes(targetHome)
    const options = { dir, dbPath: localDb, passphrase: PASSPHRASE, localDevice: 'device-a', localMtimeMs: Date.parse('2026-11-01T00:00:00.000Z') }

    const dry = pullSnapshot({ ...options, dryRun: true })
    assert.equal(dry.status, 'dry-run')
    assert.equal(dry.wouldChange, true)
    assert.equal(dry.wouldStatus, 'pulled')
    assert.equal(dry.wouldBackup, true)
    assert.equal(dry.localEmpty, false)
    assert.equal(dry.snapshotOlder, false)
    assert.equal(dry.sameDevice, true)
    assert.equal(sha256(readFileSync(localDb)), dbBytes, 'the local database bytes are untouched')
    assertNoSideEffects(targetHome, homeBefore)

    const real = pullSnapshot(options)
    assert.equal(real.changed, true)
    assert.equal(real.status, dry.wouldStatus)
    assert.equal(Boolean(real.backup), dry.wouldBackup)
    assert.deepEqual(turnContents(localDb), ['快照里的内容'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dry run returns the same newer-local warning a same-device pull would report', () => {
  const root = makeRoot()
  try {
    const sourceHome = join(root, 'source-home')
    const sourceDb = join(sourceHome, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(sourceDb, ['旧快照内容'])
    pushSnapshot({ dir, dbPath: sourceDb, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-01T00:00:00.000Z') })

    const targetHome = join(root, 'target-home')
    const localDb = join(targetHome, 'state.db')
    seedDatabase(localDb, ['本机更新的内容'])
    const homeBefore = fileHashes(targetHome)
    const options = { dir, dbPath: localDb, passphrase: PASSPHRASE, localDevice: 'device-a', localMtimeMs: Date.parse('2026-11-02T00:00:00.000Z') }

    const dry = pullSnapshot({ ...options, dryRun: true })
    assert.equal(dry.snapshotOlder, true)
    assert.equal(dry.wouldChange, true)
    assert.equal(dry.wouldStatus, 'pulled')
    assert.ok(
      dry.warnings.some((warning) => /replacing a newer local database .* because the snapshot was pushed from this device/.test(warning)),
      'the dry run returns the same prediction warning instead of printing it',
    )
    assert.deepEqual(fileHashes(targetHome), homeBefore, 'the warned replacement does not happen during the dry run')

    const real = pullSnapshot(options)
    assert.equal(real.status, dry.wouldStatus)
    assert.deepEqual(real.warnings, dry.warnings, 'a dry run warns about exactly what the real pull warns about')
    assert.equal(rowCount(localDb), 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dry run and the real pull refuse a newer non-empty ledger identically, before writing', () => {
  const root = makeRoot()
  try {
    const sourceHome = join(root, 'source-home')
    const sourceDb = join(sourceHome, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(sourceDb, ['旧快照'])
    pushSnapshot({ dir, dbPath: sourceDb, passphrase: PASSPHRASE, device: 'device-a', createdAt: new Date('2026-11-01T00:00:00.000Z') })

    const targetHome = join(root, 'target-home')
    const localDb = join(targetHome, 'state.db')
    seedDatabase(localDb, ['本机更新的数据'])
    const dbBytes = sha256(readFileSync(localDb))
    const homeBefore = fileHashes(targetHome)
    const options = { dir, dbPath: localDb, passphrase: PASSPHRASE, localDevice: 'device-b', localMtimeMs: Date.parse('2026-11-02T00:00:00.000Z') }

    const dryError = pullError({ ...options, dryRun: true })
    assert.match(dryError.message, /refusing to overwrite/)
    assert.equal(sha256(readFileSync(localDb)), dbBytes, 'a refused dry run does not touch the database')
    assertNoSideEffects(targetHome, homeBefore)

    const realError = pullError(options)
    assert.equal(dryError.message, realError.message, 'dry-run and real refusal reasons are identical')
    assert.equal(sha256(readFileSync(localDb)), dbBytes)
    assert.deepEqual(fileHashes(targetHome), homeBefore)
    assert.deepEqual(turnContents(localDb), ['本机更新的数据'])

    // --force turns the same situation into an allowed replacement: the dry run
    // must predict it (with the newer-local warning) and still write nothing.
    const forcedDry = pullSnapshot({ ...options, dryRun: true, force: true })
    assert.equal(forcedDry.status, 'dry-run')
    assert.equal(forcedDry.wouldChange, true)
    assert.equal(forcedDry.wouldStatus, 'forced')
    assert.equal(forcedDry.snapshotOlder, true)
    assert.ok(forcedDry.warnings.some((warning) => /because --force was given/.test(warning)))
    assert.equal(sha256(readFileSync(localDb)), dbBytes, 'the forced dry run does not touch the database')
    assert.deepEqual(fileHashes(targetHome), homeBefore)

    const forcedReal = pullSnapshot({ ...options, force: true })
    assert.equal(forcedReal.changed, true)
    assert.equal(forcedReal.status, forcedDry.wouldStatus)
    assert.equal(Boolean(forcedReal.backup), forcedDry.wouldBackup)
    assert.deepEqual(turnContents(localDb), ['旧快照'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dry run refuses a missing or empty sync directory like the real pull and creates no HOME', () => {
  const root = makeRoot()
  try {
    const targetHome = join(root, 'target-home')
    const localDb = join(targetHome, 'state.db')
    const dir = join(root, 'missing-sync-dir')
    const options = { dir, dbPath: localDb, passphrase: PASSPHRASE }

    const dryError = pullError({ ...options, dryRun: true })
    assert.match(dryError.message, /no Advisers snapshots/)
    assert.equal(existsSync(dir), false, 'a dry run must not create the sync directory')
    assert.equal(existsSync(targetHome), false, 'a dry run must not create the HOME directory')

    const realError = pullError(options)
    assert.equal(dryError.message, realError.message)
    assert.equal(existsSync(targetHome), false, 'the real refusal also happens before mkdir')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dry run refuses an undecidable snapshot set exactly like the real pull', () => {
  const root = makeRoot()
  try {
    const sourceHome = join(root, 'source-home')
    const sourceDb = join(sourceHome, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(sourceDb, ['好快照'])
    pushSnapshot({ dir, dbPath: sourceDb, passphrase: PASSPHRASE, device: 'device-a' })
    writeFileSync(join(dir, 'advisers-dead-device-20260101T000000Z.enc.json'), 'this is not a snapshot\n')

    const targetHome = join(root, 'target-home')
    const localDb = join(targetHome, 'state.db')
    seedDatabase(localDb)
    const homeBefore = fileHashes(targetHome)
    const options = { dir, dbPath: localDb, passphrase: PASSPHRASE }

    const dryError = pullError({ ...options, dryRun: true })
    assert.match(dryError.message, /cannot determine the newest snapshot/)
    assertNoSideEffects(targetHome, homeBefore)

    const realError = pullError(options)
    assert.equal(dryError.message, realError.message)
    assert.deepEqual(fileHashes(targetHome), homeBefore)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dry run refuses a checksum-mismatched snapshot exactly like the real pull', () => {
  const root = makeRoot()
  try {
    const sourceHome = join(root, 'source-home')
    const sourceDb = join(sourceHome, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(sourceDb, ['原快照'])
    const pushed = pushSnapshot({ dir, dbPath: sourceDb, passphrase: PASSPHRASE, device: 'device-a' })
    // Self-consistent encryption whose payload sha256 does not match its bytes.
    const envelope = JSON.parse(readFileSync(pushed.file, 'utf8'))
    const payload = decryptJson(envelope, PASSPHRASE)
    payload.sha256 = sha256(Buffer.from('these bytes are not the snapshot database'))
    writeFileSync(pushed.file, JSON.stringify(encryptJson(payload, PASSPHRASE)) + '\n')

    const targetHome = join(root, 'target-home')
    const localDb = join(targetHome, 'state.db')
    seedDatabase(localDb)
    const homeBefore = fileHashes(targetHome)
    const options = { dir, dbPath: localDb, passphrase: PASSPHRASE }

    const dryError = pullError({ ...options, dryRun: true })
    assert.match(dryError.message, /snapshot checksum mismatch/)
    assertNoSideEffects(targetHome, homeBefore)

    const realError = pullError(options)
    assert.equal(dryError.message, realError.message)
    assert.deepEqual(fileHashes(targetHome), homeBefore)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dry run predicts a backup-less bootstrap when no local database exists and creates no HOME', () => {
  const root = makeRoot()
  try {
    const sourceHome = join(root, 'source-home')
    const sourceDb = join(sourceHome, 'state.db')
    const dir = join(root, 'sync')
    seedDatabase(sourceDb, ['唯一快照内容'])
    pushSnapshot({ dir, dbPath: sourceDb, passphrase: PASSPHRASE, device: 'device-a' })

    const targetHome = join(root, 'fresh-home')
    const localDb = join(targetHome, 'state.db')
    const options = { dir, dbPath: localDb, passphrase: PASSPHRASE }

    const dry = pullSnapshot({ ...options, dryRun: true })
    assert.equal(dry.status, 'dry-run')
    assert.equal(dry.wouldChange, true)
    assert.equal(dry.wouldStatus, 'bootstrapped')
    assert.equal(dry.wouldBackup, false, 'a missing local database has nothing to back up')
    assert.equal(dry.localEmpty, true)
    assert.equal(existsSync(targetHome), false, 'a dry run must not create the HOME directory')

    const real = pullSnapshot(options)
    assert.equal(real.changed, true)
    assert.equal(real.status, dry.wouldStatus)
    assert.equal(Boolean(real.backup), dry.wouldBackup)
    assert.deepEqual(turnContents(localDb), ['唯一快照内容'])
    assert.equal(backupFiles(targetHome).length, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
