import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { SqliteStore } from '../lib/sqlite.js'
import {
  SAFETY_BACKUP_REUSE_MS,
  backupDir,
  backupSha256Path,
  ensureSafetyBackup,
  findReusableManagedBackup,
  inspectBackupFreshness,
  listBackups,
  parseBackupFileName,
  sha256FileSync,
} from '../lib/backup.js'

// 0.5.0 050-S1 (plan 121 §3): every destructive command that purges or merges
// local data must write (or reuse) a managed, verified `pre-*` backup first and
// abort when it cannot. `inspectBackupFreshness()` is the read-only doctor block:
// it reports the newest managed/plaintext copy and warns without changing any
// exit code. These tests pin the fail-closed, dedupe, age and report semantics.

const DAY = 86400000
const T0 = Date.parse('2026-11-01T00:00:00.000Z')

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'advisers-backup-preflight-'))
}

function makeHome(root, name = 'home') {
  const home = join(root, name)
  mkdirSync(home, { recursive: true })
  return home
}

function seedDatabase(dbPath, { turns = 0, audit = 1 } = {}) {
  const store = new SqliteStore(dbPath)
  try {
    for (let index = 0; index < turns; index++) store.addTurn({ conversationId: 'c1', role: 'user', content: 'turn ' + index })
    for (let index = 0; index < audit; index++) store.appendAudit({ actor: 'local', action: 'backup-preflight.test.' + index, allowed: true, reason: null })
  } finally {
    store.close()
  }
}

function appendAudit(dbPath) {
  const store = new SqliteStore(dbPath)
  try { store.appendAudit({ actor: 'local', action: 'backup-preflight.more', allowed: true, reason: null }) } finally { store.close() }
}

/** Byte hash of every regular file under a directory (a no-change assertion). */
function fileHashes(dir) {
  const hashes = {}
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name)
    let info
    try { info = statSync(file) } catch { continue }
    if (!info.isFile()) continue
    hashes[name] = createHash('sha256').update(readFileSync(file)).digest('hex')
  }
  return hashes
}

test('ensureSafetyBackup writes a verified managed pre-purge backup and does not modify the database', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root)
    const dbPath = join(home, 'state.db')
    seedDatabase(dbPath, { turns: 2 })
    const before = sha256FileSync(dbPath).sha256
    const created = ensureSafetyBackup({ home, dbPath, tag: 'pre-purge', now: T0 })
    assert.equal(created.ok, true, JSON.stringify(created.errors))
    assert.equal(created.reused, false)
    assert.equal(created.tag, 'pre-purge')
    assert.equal(created.reason, null)
    assert.ok(created.path, 'a backup path is returned')
    assert.equal(parseBackupFileName(basename(created.path))?.tag, 'pre-purge')
    assert.ok(existsSync(created.path), 'the backup file exists')
    assert.ok(existsSync(backupSha256Path(created.path)), 'the sha256 sidecar exists')
    assert.equal(created.sha256, before, 'the returned sha256 is the checkpointed database hash')
    assert.equal(parseBackupFileName(basename(created.path))?.atIso, created.createdAt)
    assert.equal(created.checkpoint?.busy, false)
    const listed = listBackups({ home })
    assert.equal(listed.entries.length, 1)
    assert.equal(listed.entries[0].path, created.path)
    assert.equal(sha256FileSync(dbPath).sha256, before, 'the live database bytes did not change')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('ensureSafetyBackup reuses the same tag+database hash inside the window and writes a new backup after a change', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root)
    const dbPath = join(home, 'state.db')
    seedDatabase(dbPath)
    const first = ensureSafetyBackup({ home, dbPath, tag: 'pre-purge', now: T0 })
    assert.equal(first.ok, true, JSON.stringify(first.errors))
    const reused = ensureSafetyBackup({ home, dbPath, tag: 'pre-purge', now: T0 + 60000 })
    assert.equal(reused.ok, true)
    assert.equal(reused.reused, true, 'an identical database within 10 minutes is not backed up twice')
    assert.equal(reused.path, first.path)
    assert.ok(reused.ageMs <= 60000)
    appendAudit(dbPath)
    const changed = ensureSafetyBackup({ home, dbPath, tag: 'pre-purge', now: T0 + 120000 })
    assert.equal(changed.ok, true)
    assert.equal(changed.reused, false, 'a changed database gets a fresh safety backup')
    assert.notEqual(changed.path, first.path)
    assert.notEqual(changed.sha256, first.sha256)
    assert.equal(listBackups({ home }).entries.length, 2)
    // The reusable lookup is read-only and hash-exact.
    const oldLookup = findReusableManagedBackup({ home, tag: 'pre-purge', sha256: first.sha256, now: T0 + 120000 })
    assert.equal(oldLookup.found, false)
    const newLookup = findReusableManagedBackup({ home, tag: 'pre-purge', sha256: changed.sha256, now: T0 + 120000 })
    assert.equal(newLookup.found, true)
    assert.equal(newLookup.path, changed.path)
    assert.equal(newLookup.reason, 'reused')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('ensureSafetyBackup does not reuse a backup older than the reuse window or without its sha256 sidecar', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root)
    const dbPath = join(home, 'state.db')
    seedDatabase(dbPath)
    const first = ensureSafetyBackup({ home, dbPath, tag: 'pre-purge', now: T0 })
    const tooOld = ensureSafetyBackup({ home, dbPath, tag: 'pre-purge', now: T0 + SAFETY_BACKUP_REUSE_MS + 1000 })
    assert.equal(tooOld.ok, true)
    assert.equal(tooOld.reused, false, 'a backup older than the reuse window is not reused even with the same hash')
    assert.notEqual(tooOld.path, first.path)
    rmSync(backupSha256Path(tooOld.path))
    const noSidecar = ensureSafetyBackup({ home, dbPath, tag: 'pre-purge', now: T0 + SAFETY_BACKUP_REUSE_MS + 2000 })
    assert.equal(noSidecar.ok, true)
    assert.equal(noSidecar.reused, false, 'a backup without its .sha256 sidecar is not trusted for reuse')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('ensureSafetyBackup fails closed (structured code, database untouched) when the backup directory cannot be written', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root)
    writeFileSync(join(home, 'backups'), 'this is a file, not a backup directory')
    const dbPath = join(home, 'state.db')
    seedDatabase(dbPath)
    const before = fileHashes(home)
    const failed = ensureSafetyBackup({ home, dbPath, tag: 'pre-purge', now: T0 })
    assert.equal(failed.ok, false, 'a safety backup that cannot be written must fail closed')
    assert.match(String(failed.code), /^E_BACKUP_/, 'the failure carries a registered backup code')
    assert.ok(failed.errors.length >= 1)
    assert.equal(failed.path, null)
    assert.equal(failed.reused, false)
    assert.deepEqual(fileHashes(home), before, 'the ledger/home is unchanged when the backup fails')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('ensureSafetyBackup skips (with a warning) for a JSON store / missing database and rejects invalid arguments', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root)
    const missing = ensureSafetyBackup({ home, dbPath: join(home, 'missing.db'), tag: 'pre-purge', now: T0 })
    assert.equal(missing.ok, true, 'a JSON store has no SQLite backup to write')
    assert.equal(missing.skipped, true)
    assert.equal(missing.reason, 'no-database')
    assert.ok(missing.warnings.length >= 1)
    const noPath = ensureSafetyBackup({ home, tag: 'pre-purge', now: T0 })
    assert.equal(noPath.ok, true)
    assert.equal(noPath.skipped, true)
    assert.equal(noPath.reason, 'no-database')
    const noHome = ensureSafetyBackup({ dbPath: join(home, 'state.db'), tag: 'pre-purge', now: T0 })
    assert.equal(noHome.ok, false)
    assert.equal(noHome.code, 'E_BACKUP_DIR_REQUIRED')
    const badTag = ensureSafetyBackup({ home, dbPath: join(home, 'state.db'), tag: 'Not A Tag', now: T0 })
    assert.equal(badTag.ok, false)
    assert.equal(badTag.code, 'E_BACKUP_TAG_INVALID')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('inspectBackupFreshness reports none while the ledger has user rows and no managed backup', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root)
    const dbPath = join(home, 'state.db')
    seedDatabase(dbPath, { audit: 2 })
    const freshness = inspectBackupFreshness({ home, dbPath, now: T0 })
    assert.equal(freshness.ok, true)
    assert.equal(freshness.status, 'none')
    assert.equal(freshness.managedCount, 0)
    assert.equal(freshness.newestManaged, null)
    assert.equal(freshness.keepPolicy.mode, 'gfs')
    assert.equal(freshness.keepPolicy.gfsTarget, 14)
    assert.equal(freshness.checkedAt, new Date(T0).toISOString())
    assert.ok(freshness.warnings.some((warning) => /no managed backup/.test(warning)), JSON.stringify(freshness.warnings))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('inspectBackupFreshness reports the newest managed/plaintext copy, readability and sidecars', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root)
    const dbPath = join(home, 'state.db')
    seedDatabase(dbPath)
    const created = ensureSafetyBackup({ home, dbPath, tag: 'pre-purge', now: T0 })
    assert.equal(created.ok, true, JSON.stringify(created.errors))
    const plaintext = join(home, 'import-backup-20261101T000000Z.db')
    writeFileSync(plaintext, 'plaintext copy')
    utimesSync(plaintext, new Date(T0 - 2 * DAY), new Date(T0 - 2 * DAY))
    const freshness = inspectBackupFreshness({ home, dbPath, now: T0 })
    assert.equal(freshness.ok, true)
    assert.equal(freshness.status, 'ok')
    assert.equal(freshness.managedCount, 1)
    assert.equal(freshness.dir, backupDir({ home }))
    assert.equal(freshness.newestManaged.path, created.path)
    assert.equal(freshness.newestManaged.readable, true)
    assert.equal(freshness.newestManaged.sidecars.sha256, true)
    assert.ok(freshness.newestManaged.ageDays < 0.01)
    assert.equal(freshness.newestPlaintext.name, 'import-backup-20261101T000000Z.db')
    assert.ok(Math.abs(freshness.newestPlaintext.ageDays - 2) < 0.01)
    assert.equal(freshness.keepPolicy.gfsTarget, 14)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('inspectBackupFreshness warns after 7 days and reports stale after 30 days', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root)
    const dbPath = join(home, 'state.db')
    seedDatabase(dbPath)
    const created = ensureSafetyBackup({ home, dbPath, tag: 'pre-purge', now: T0 })
    assert.equal(created.ok, true, JSON.stringify(created.errors))
    const week = inspectBackupFreshness({ home, dbPath, now: T0 + 8 * DAY })
    assert.equal(week.status, 'ok')
    assert.ok(week.warnings.some((warning) => /days old/.test(warning)), JSON.stringify(week.warnings))
    const stale = inspectBackupFreshness({ home, dbPath, now: T0 + 31 * DAY })
    assert.equal(stale.status, 'stale')
    assert.ok(stale.warnings.some((warning) => /> 30/.test(warning)), JSON.stringify(stale.warnings))
    // A non-GFS keep policy still reports a usable target.
    const counted = inspectBackupFreshness({ home, dbPath, now: T0, keep: 5 })
    assert.equal(counted.keepPolicy.mode, 'count')
    assert.equal(counted.keepPolicy.gfsTarget, 5)
  } finally { rmSync(root, { recursive: true, force: true }) }
})