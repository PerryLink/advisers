import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'
import {
  BACKUP_FILE_RE,
  applyBackupRotation,
  backupAnchorPath,
  backupDir,
  backupFileName,
  backupPathFor,
  backupSha256Path,
  createBackup,
  createManagedBackup,
  inspectBackup,
  listBackups,
  normalizeBackupTag,
  normalizeKeepPolicy,
  parseBackupFileName,
  planBackupRotation,
  rotateManagedBackups,
  sha256FileSync,
  verifyBackupSha256,
  verifyBackups,
  verifyBackupSidecars,
  writeBackupSha256,
} from '../lib/backup.js'

// 0.3.0 P0-D2 (04-0.3-research §4.3 / 25-0.3.0-security-perf-robustness): the old
// `backup <path>` only copied bytes. These tests pin the verified copy (WAL
// checkpoint first, quick_check/schema/audit/count checks on the copy), the
// managed name + .sha256/.anchor.json sidecars, GFS/keep-N rotation safety
// (dry-run by default, newest + newest readable always kept, path containment),
// and the backup failure matrix. Restore paths live in test/restore-drill.test.js.

const KEY = 'test-backup-anchor-key-0123456789'
const DAY = 86400000

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-backup-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function seedStore(home, count = 2) {
  const store = new SqliteStore(join(home, 'state.db'))
  for (let index = 1; index <= count; index++) {
    store.appendAudit({ actor: 'local', action: 'backup.test.' + index, allowed: true, reason: null })
  }
  return store
}

function fixtureBackup(dir, atMs, { tag = null, readable, sidecars = true } = {}) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, backupFileName({ at: new Date(atMs), tag }))
  writeFileSync(path, 'fixture backup bytes')
  if (sidecars) {
    writeFileSync(backupSha256Path(path), '0'.repeat(64) + '  ' + basename(path) + '\n')
    writeFileSync(backupAnchorPath(path), '{}')
  }
  return { path, name: basename(path), atMs, tag, readable }
}

test('createManagedBackup writes a verified managed backup plus sha256/anchor sidecars', () => {
  const { root, home } = makeHome()
  const store = seedStore(home, 3)
  try {
    const created = createManagedBackup({ home, dbPath: join(home, 'state.db'), store, writeSha256: true, writeAnchor: true, anchorKey: KEY })
    assert.equal(created.ok, true, JSON.stringify(created.errors))
    assert.match(basename(created.path), BACKUP_FILE_RE)
    assert.equal(created.audit.count, 3)
    assert.equal(created.sidecars.sha256, backupSha256Path(created.path))
    assert.equal(created.sidecars.anchor, backupAnchorPath(created.path))
    assert.equal(existsSync(created.sidecars.sha256), true)
    assert.equal(existsSync(created.sidecars.anchor), true)

    const inspected = inspectBackup(created.path, { currentSchemaVersion: SCHEMA_VERSION })
    assert.equal(inspected.ok, true, JSON.stringify(inspected.errors))
    assert.equal(inspected.quickCheck, 'ok')
    assert.equal(inspected.schemaStatus, 'current')
    assert.equal(inspected.chainVerified, true)
    assert.equal(inspected.audit.count, 3)
    assert.equal(inspected.counts.audit, 3)

    const sidecars = verifyBackupSidecars({ backupPath: created.path, head: inspected.audit, key: KEY })
    assert.equal(sidecars.ok, true, JSON.stringify(sidecars.errors))
    assert.equal(sidecars.sha256.ok, true)
    assert.equal(sidecars.anchor.ok, true)
    assert.equal(sidecars.anchor.hmacVerified, true)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('createBackup checkpoints the WAL first, so WAL-only commits are in the backup', () => {
  const { root, home } = makeHome()
  const store = seedStore(home, 2)
  const target = join(root, 'out', 'state-copy.db')
  try {
    // Keep recent commits in the WAL only.
    store.db.exec('PRAGMA wal_autocheckpoint = 0')
    store.db.prepare("INSERT INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run('cm_wal_only', 'm1', 'user', 'someone', 'wal-only row', null, 'Asia/Shanghai', 'open', '[]', 'todo', null, null)
    const created = createBackup({ dbPath: join(home, 'state.db'), targetPath: target, store, verifyChain: true })
    assert.equal(created.ok, true, JSON.stringify(created.errors))
    assert.equal(existsSync(target + '-wal'), false, 'the installed backup has no WAL sidecar')
    const backup = new SqliteStore(target, { readOnly: true })
    try {
      assert.equal(backup.db.prepare("SELECT COUNT(*) AS n FROM commitments WHERE id = 'cm_wal_only'").get().n, 1)
      assert.equal(backup.verifyAudit().count, 2)
    } finally { backup.close() }
    assert.equal(created.audit.count, 2)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('createBackup never clobbers an existing target unless overwrite:true', () => {
  const { root, home } = makeHome()
  const store = seedStore(home, 1)
  const target = join(root, 'explicit.db')
  try {
    const first = createBackup({ dbPath: join(home, 'state.db'), targetPath: target, store })
    assert.equal(first.ok, true)
    const originalBytes = readFileSync(target)
    store.appendAudit({ actor: 'local', action: 'more.data', allowed: true, reason: null })
    const refused = createBackup({ dbPath: join(home, 'state.db'), targetPath: target, store })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'E_BACKUP_EXISTS')
    assert.deepEqual(readFileSync(target), originalBytes, 'existing backup bytes are untouched')
    const overwritten = createBackup({ dbPath: join(home, 'state.db'), targetPath: target, store, overwrite: true })
    assert.equal(overwritten.ok, true)
    assert.notDeepEqual(readFileSync(target), originalBytes)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('a backup that fails verification is never installed (fail closed)', () => {
  const { root, home } = makeHome()
  const store = seedStore(home, 1)
  const target = join(root, 'out', 'state-copy.db')
  try {
    // currentSchemaVersion older than the DB makes inspectBackup refuse the copy.
    const created = createBackup({ dbPath: join(home, 'state.db'), targetPath: target, store, currentSchemaVersion: 1 })
    assert.equal(created.ok, false)
    assert.equal(created.code, 'E_BACKUP_VERIFY_FAILED')
    assert.equal(existsSync(target), false, 'no backup file is installed')
    const leftovers = existsSync(join(root, 'out')) ? readdirSync(join(root, 'out')) : []
    assert.deepEqual(leftovers, [], 'the temp copy was removed: ' + leftovers.join(','))
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('inspectBackup detects empty/corrupt/WAL-carrying/newer-schema/non-ledger files', () => {
  const { root, home } = makeHome()
  const store = seedStore(home, 1)
  try {
    const good = createManagedBackup({ home, dbPath: join(home, 'state.db'), store })
    assert.equal(good.ok, true)

    const empty = join(root, 'empty.db')
    writeFileSync(empty, '')
    assert.equal(inspectBackup(empty).code, 'E_BACKUP_EMPTY')

    const corrupt = join(root, 'corrupt.db')
    writeFileSync(corrupt, 'this is definitely not a sqlite database')
    const corruptReport = inspectBackup(corrupt)
    assert.equal(corruptReport.ok, false)
    assert.ok(corruptReport.codes.includes('E_BACKUP_CORRUPT') || corruptReport.codes.includes('E_BACKUP_OPEN_FAILED'), JSON.stringify(corruptReport.codes))

    const walCopy = join(root, 'wal-copy.db')
    writeFileSync(walCopy, readFileSync(good.path))
    writeFileSync(walCopy + '-wal', 'non-empty wal')
    const walReport = inspectBackup(walCopy)
    assert.equal(walReport.ok, false)
    assert.equal(walReport.code, 'E_BACKUP_HAS_WAL')

    const newer = join(root, 'newer.db')
    writeFileSync(newer, readFileSync(good.path))
    const db = new DatabaseSync(newer)
    try { db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run() } finally { db.close() }
    const newerReport = inspectBackup(newer, { currentSchemaVersion: SCHEMA_VERSION })
    assert.equal(newerReport.ok, false)
    assert.ok(newerReport.codes.includes('E_BACKUP_SCHEMA_NEWER'))
    assert.equal(newerReport.schemaStatus, 'newer')

    const plain = join(root, 'plain.db')
    const plainDb = new DatabaseSync(plain)
    try { plainDb.exec('CREATE TABLE t(x)') } finally { plainDb.close() }
    assert.ok(inspectBackup(plain, { currentSchemaVersion: SCHEMA_VERSION }).codes.includes('E_BACKUP_NOT_ADVISERS_DB'))
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('sha256 sidecar: written, verifies, and tampering is detected', () => {
  const { root, home } = makeHome()
  const store = seedStore(home, 1)
  try {
    const created = createManagedBackup({ home, dbPath: join(home, 'state.db'), store, writeSha256: false })
    assert.equal(created.ok, true)
    const written = writeBackupSha256(created.path)
    assert.equal(written.ok, true)
    assert.equal(written.sha256, sha256FileSync(created.path).sha256)
    assert.equal(verifyBackupSha256(created.path).ok, true)
    assert.match(readFileSync(backupSha256Path(created.path), 'utf8'), /^[0-9a-f]{64}  state-.+\.db\n$/)
    writeFileSync(backupSha256Path(created.path), 'f'.repeat(64) + '  ' + basename(created.path) + '\n')
    const tampered = verifyBackupSha256(created.path)
    assert.equal(tampered.ok, false)
    assert.match(tampered.errors.join(' '), /sha256 mismatch/)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('listBackups parses managed names, sorts newest-first and ignores foreign files', () => {
  const { root, home } = makeHome()
  const dir = backupDir({ home })
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const older = fixtureBackup(dir, now - 2 * DAY, { tag: 'pre-upgrade' })
  const newer = fixtureBackup(dir, now - DAY)
  writeFileSync(join(dir, 'state.db.before-migrate-v19-1'), 'legacy')
  writeFileSync(join(dir, 'notes.txt'), 'not a backup')
  try {
    const listed = listBackups({ home })
    assert.equal(listed.ok, true)
    assert.equal(listed.entries.length, 2)
    assert.equal(listed.entries[0].path, newer.path, 'newest first')
    assert.equal(listed.entries[0].sidecars.sha256, true)
    assert.equal(listed.entries[1].tag, 'pre-upgrade')
    assert.equal(parseBackupFileName(newer.name).tag, null)
    assert.equal(parseBackupFileName('nope.db'), null)
    assert.equal(normalizeBackupTag('Pre-Upgrade').tag, 'pre-upgrade')
    assert.equal(normalizeBackupTag('bad tag!').ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('planBackupRotation: keep-N and GFS semantics always keep the newest + newest readable', () => {
  const now = Date.now()
  const entries = []
  for (let index = 0; index < 5; index++) {
    entries.push({ path: '/b/' + index + '.db', atMs: now - index * DAY, readable: index === 1 })
  }
  const count = planBackupRotation({ entries, keep: 2 })
  assert.equal(count.ok, true)
  assert.equal(count.policy.mode, 'count')
  assert.ok(count.kept.some((entry) => entry.atMs === now), 'newest is kept')
  assert.ok(count.kept.some((entry) => entry.readable === true), 'newest readable is kept')
  assert.equal(count.kept.length, 2)
  assert.equal(count.victims.length, 3)

  const gfsEntries = []
  for (let index = 0; index < 400; index++) {
    gfsEntries.push({ path: '/b/' + index + '.db', atMs: now - index * DAY })
  }
  const gfs = planBackupRotation({ entries: gfsEntries, keep: { daily: 7, weekly: 4, monthly: 3 } })
  assert.equal(gfs.ok, true)
  assert.equal(gfs.kept.length, 14, 'daily 7 + weekly 4 + monthly 3 distinct buckets')
  assert.equal(new Set(gfs.kept.map((entry) => entry.path)).size, 14)
  assert.equal(gfs.victims.length, 386)

  const defaults = planBackupRotation({ entries: gfsEntries })
  assert.deepEqual(defaults.policy, { mode: 'gfs', daily: 7, weekly: 4, monthly: 3 })
  assert.equal(normalizeKeepPolicy('daily=2,weekly=1').policy.daily, 2)
  assert.equal(normalizeKeepPolicy('bogus').ok, false)
  assert.equal(normalizeKeepPolicy(0).ok, false)
})


test('applyBackupRotation: dry-run deletes nothing; real rotation only touches managed files', () => {
  const { root, home } = makeHome()
  const dir = backupDir({ home })
  const now = Date.now()
  const fixtures = []
  for (let index = 0; index < 5; index++) {
    fixtures.push(fixtureBackup(dir, now - index * DAY, { readable: index === 1 }))
  }
  const entries = fixtures.map((fixture, index) => ({ path: fixture.path, atMs: fixture.atMs, readable: index === 1 }))
  try {
    const dry = applyBackupRotation({ dir, entries, keep: 1, dryRun: true, probeReadable: false })
    assert.equal(dry.ok, true)
    assert.equal(dry.dryRun, true)
    assert.ok(dry.wouldDelete.length >= 3, 'older backups are planned for deletion')
    assert.equal(readdirSync(dir).filter((name) => name.endsWith('.db')).length, 5, 'dry-run deletes nothing')

    const real = applyBackupRotation({ dir, entries, keep: 1, dryRun: false, probeReadable: false })
    assert.equal(real.ok, true, JSON.stringify(real.errors))
    assert.equal(real.dryRun, false)
    assert.equal(real.deleted.length, 3)
    for (const deleted of real.deleted) {
      assert.equal(existsSync(deleted), false)
      assert.equal(existsSync(backupSha256Path(deleted)), false)
      assert.equal(existsSync(backupAnchorPath(deleted)), false)
    }
    // The newest (even though its fixture is not readable) and the newest readable survive.
    assert.equal(existsSync(fixtures[0].path), true)
    assert.equal(existsSync(fixtures[1].path), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('applyBackupRotation refuses to delete anything outside the managed directory', () => {
  const { root, home } = makeHome()
  const dir = backupDir({ home })
  const outside = join(home, 'state-20200101T000000000Z.db')
  writeFileSync(outside, 'do not delete')
  const inside = fixtureBackup(dir, Date.now())
  const entries = [
    { path: inside.path, atMs: Date.now() },
    { path: outside, atMs: Date.now() - DAY },
  ]
  try {
    const result = applyBackupRotation({ dir, entries, keep: 1, dryRun: false, probeReadable: false })
    assert.equal(result.ok, false)
    assert.equal(result.errors.some((error) => /not directly inside the managed backup directory/.test(error)), true, result.errors.join(' | '))
    assert.equal(existsSync(outside), true, 'an outside path is never deleted')
    assert.equal(existsSync(inside.path), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('createManagedBackup rotation is opt-in and reports the dry-run plan', () => {
  const { root, home } = makeHome()
  const store = seedStore(home, 1)
  const dir = backupDir({ home })
  try {
    for (let index = 1; index <= 3; index++) {
      fixtureBackup(dir, Date.now() - index * DAY)
    }
    const created = createManagedBackup({
      home,
      dbPath: join(home, 'state.db'),
      store,
      writeSha256: false,
      writeAnchor: false,
      rotate: true,
      rotateDryRun: true,
      keep: 1,
    })
    assert.equal(created.ok, true)
    assert.ok(created.rotation, 'rotation plan is returned')
    assert.equal(created.rotation.dryRun, true)
    assert.ok(created.warnings.some((warning) => /rotation dry-run/.test(warning)))
    assert.equal(readdirSync(dir).filter((name) => name.endsWith('.db')).length, 4, 'dry-run keeps every backup')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
test('verifyBackups checks every managed backup and its sidecars without deleting bad ones', () => {
  const { root, home } = makeHome()
  const store = seedStore(home, 2)
  try {
    const first = createManagedBackup({ home, dbPath: join(home, 'state.db'), store, writeSha256: true, writeAnchor: true, anchorKey: KEY })
    assert.equal(first.ok, true)
    const second = createManagedBackup({ home, dbPath: join(home, 'state.db'), store, writeSha256: true, writeAnchor: true, anchorKey: KEY, at: new Date(Date.now() + 1000) })
    assert.equal(second.ok, true)
    const healthy = verifyBackups({ home, key: KEY })
    assert.equal(healthy.ok, true, JSON.stringify(healthy.errors))
    assert.equal(healthy.count, 2)
    assert.equal(healthy.results.every((result) => result.ok), true)
    // Corrupt one backup: verify reports it, and the file is still there.
    writeFileSync(second.path, 'corrupted backup bytes')
    const broken = verifyBackups({ home, key: KEY })
    assert.equal(broken.ok, false)
    assert.equal(broken.results.find((result) => result.path === second.path).ok, false)
    assert.equal(existsSync(second.path), true, 'verify never deletes a bad backup')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
