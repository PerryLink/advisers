import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { inspectWalStatus, SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'

// 0.2.3 robustness Phase 0 (robustness audit 2026-11-17 P2-9): the pre-migration
// backup used to copy only the main database file. Committed rows that still
// lived in the WAL were missing from the backup, so rolling back to it silently
// dropped data. backupBeforeMigrate now checkpoints first, verifies the copy
// with a read-only quick_check and refuses to migrate without it.

function createV18WithWalOnlyRow() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-migration-backup-'))
  const source = join(root, 'source.db')
  const store = new SqliteStore(source)
  let mainBytes
  let walBytes
  try {
    store.db.exec('PRAGMA wal_autocheckpoint = 0')
    store.db.prepare(
      'INSERT INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run('cm_wal_only', 'm1', 'user', 'someone', 'wal-only committed row', null, 'Asia/Shanghai', 'open', '[]', 'todo', null, null)
    // Pretend the database is still v18 so opening it runs a real migration.
    store.db.prepare("UPDATE meta SET value = '18' WHERE key = 'schema_version'").run()
    mainBytes = readFileSync(source)
    walBytes = readFileSync(`${source}-wal`)
  } finally { store.close() }
  const dbPath = join(root, 'state.db')
  writeFileSync(dbPath, mainBytes)
  writeFileSync(`${dbPath}-wal`, walBytes)
  return { root, dbPath, mainBytes, walBytes }
}

function migrationBackupsIn(root) {
  return readdirSync(root).filter((name) => /^state\.db\.before-migrate-v18-\d+$/.test(name))
}

test('backupBeforeMigrate checkpoints the WAL first, so the backup contains rows that only lived in the WAL', () => {
  const { root, dbPath, mainBytes, walBytes } = createV18WithWalOnlyRow()
  try {
    // Fixture precondition: the committed row exists ONLY in the WAL bytes.
    assert.equal(walBytes.includes(Buffer.from('cm_wal_only')), true, 'fixture: row bytes are in the WAL')
    assert.equal(mainBytes.includes(Buffer.from('cm_wal_only')), false, 'fixture: row bytes are not in the main DB file')
    assert.equal(inspectWalStatus(dbPath).status, 'ok')

    const store = new SqliteStore(dbPath)
    try {
      assert.equal(store.getMeta('schema_version'), String(SCHEMA_VERSION))
      const count = store.db.prepare('SELECT COUNT(*) AS n FROM commitments').get().n
      assert.equal(count, 1)
    } finally { store.close() }

    const backups = migrationBackupsIn(root)
    assert.equal(backups.length, 1, 'exactly one pre-migration backup is written')
    assert.equal(readdirSync(root).filter((name) => name.startsWith(backups[0]) && name !== backups[0]).length, 0, 'no verification -wal/-shm left behind for the backup')
    const backupPath = join(root, backups[0])
    assert.ok(statSync(backupPath).size > 0)
    const backup = new DatabaseSync(backupPath, { readOnly: true })
    try {
      assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok', 'the backup passes quick_check')
      assert.equal(backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '18')
      const row = backup.prepare("SELECT action FROM commitments WHERE id = 'cm_wal_only'").get()
      assert.equal(row?.action, 'wal-only committed row', 'the WAL-only row is in the backup')
    } finally { backup.close() }
    // The raw copy without the checkpoint would have been byte-identical to the
    // main file, so prove the checkpoint is what put the row into the backup.
    assert.ok(readFileSync(backupPath).includes(Buffer.from('cm_wal_only')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('backupBeforeMigrate refuses to migrate when another connection blocks the checkpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-migration-busy-'))
  const dbPath = join(root, 'state.db')
  // Keep the bounded checkpoint retries cheap: the point is the refusal, not the wait.
  const store = new SqliteStore(dbPath, { busyTimeoutMs: 100 })
  const blocker = new DatabaseSync(dbPath)
  try {
    store.addTurn({ conversationId: 'c1', role: 'user', content: 'existing data' })
    blocker.exec('PRAGMA busy_timeout = 100')
    blocker.exec('BEGIN IMMEDIATE')
    blocker.prepare("INSERT INTO meta(key,value) VALUES('blocker','1') ON CONFLICT(key) DO UPDATE SET value='1'").run()
    assert.throws(
      () => store.backupBeforeMigrate(18),
      (error) => error.code === 'E_MIGRATE_BUSY' && /refusing to migrate without a consistent backup.*checkpoint/i.test(error.message),
    )
    assert.deepEqual(readdirSync(root).filter((name) => name.includes('before-migrate')), [], 'no half-verified backup may be left behind')
  } finally {
    try { blocker.exec('ROLLBACK') } catch {}
    blocker.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
