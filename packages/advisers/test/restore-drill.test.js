import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'
import { writeAuditAnchor } from '../lib/audit-anchor.js'
import {
  backupAnchorPath,
  createManagedBackup,
  planRestore,
  restoreBackup,
} from '../lib/backup.js'

// 0.3.0 restore drill + failure matrix (04-0.3-research §4.3):
// temporary DSH_HOME -> seed -> backup -> mutate -> restore -> the ledger and
// audit come back to the backup moment, a pre-restore backup exists, and the
// caller can append the `db.restore` audit row afterwards. Failure injection
// covers: corrupt/newer-schema backup (live DB untouched), install rename EPERM
// (original intact), post-install verification failure (rollback), non-empty
// WAL (refuse), missing live DB (fresh install), anchor-behind gate.

const KEY = 'test-restore-anchor-key-0123456789'

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-restore-drill-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home, dbPath: join(home, 'state.db'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function appendAudit(store, count, prefix = 'drill.audit.') {
  for (let index = 1; index <= count; index++) {
    store.appendAudit({ actor: 'local', action: prefix + index, allowed: true, reason: null })
  }
}

function insertCommitment(store, id, action = 'seeded commitment') {
  store.db.prepare('INSERT INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'm1', 'user', 'someone', action, null, 'Asia/Shanghai', 'open', '[]', 'todo', null, null)
}

function countCommitments(store, id) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM commitments WHERE id = ?').get(id).n
}

function makeBackup(home, store, dbPath, options = {}) {
  return createManagedBackup({ home, dbPath, store, writeSha256: true, writeAnchor: true, anchorKey: KEY, ...options })
}

function listTemps(dir) {
  try { return readdirSync(dir).filter((name) => name.includes('.tmp-')) } catch { return [] }
}

test('restore drill: ledger + audit return to the backup moment and a pre-restore backup exists', () => {
  const { root, home, dbPath, cleanup } = makeHome()
  let store = new SqliteStore(dbPath)
  try {
    appendAudit(store, 3)
    insertCommitment(store, 'cm_seed_1')
    insertCommitment(store, 'cm_seed_2')
    const created = makeBackup(home, store, dbPath)
    assert.equal(created.ok, true, JSON.stringify(created.errors))
    assert.equal(created.audit.count, 3)

    // Mutate after the backup: both the ledger and the audit change.
    appendAudit(store, 2, 'drill.after.')
    insertCommitment(store, 'cm_after_backup', 'row written after the backup')
    assert.equal(countCommitments(store, 'cm_after_backup'), 1)

    const plan = planRestore({ backupPath: created.path, dbPath, home, key: KEY })
    assert.equal(plan.ok, true, JSON.stringify(plan.errors))
    assert.ok(plan.sidecarAnchor, 'the backup\'s own anchor sidecar was verified')
    assert.equal(plan.sidecarAnchor.verification.status, 'match')

    const restored = restoreBackup({ plan, store, home })
    assert.equal(restored.ok, true, JSON.stringify(restored.errors))
    assert.equal(restored.storeClosed, true)
    assert.equal(restored.audit.count, 3)
    assert.equal(restored.schemaVersion, SCHEMA_VERSION)
    assert.ok(restored.preRestoreBackup, 'a pre-restore safety backup was written')
    assert.match(restored.preRestoreBackup, /pre-restore/)
    assert.equal(existsSync(restored.preRestoreBackup), true)
    assert.deepEqual(listTemps(home), [], 'no temp file is left behind')
    store = null

    const check = new SqliteStore(dbPath, { readOnly: true })
    try {
      assert.equal(check.db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
      assert.equal(check.db.prepare('SELECT COUNT(*) AS n FROM commitments').get().n, 2)
      assert.equal(countCommitments(check, 'cm_after_backup'), 0, 'post-backup rows are gone')
      assert.equal(check.verifyAudit().ok, true)
      assert.equal(check.verifyAudit().count, 3, 'audit is back to the backup count')
    } finally { check.close() }

    // bin/ writes the db.restore audit row after reopening the restored store.
    const reopened = new SqliteStore(dbPath)
    try {
      reopened.appendAudit({ actor: 'local', action: 'db.restore', allowed: true, reason: null })
      assert.equal(reopened.verifyAudit().ok, true)
      assert.equal(reopened.verifyAudit().count, 4, 'the restore audit row is chained on top')
    } finally { reopened.close() }
  } finally {
    try { store?.close() } catch {}
    cleanup()
  }
})

test('restore works with the caller-closed store (no store option) and enforces the anchor gate', () => {
  const { root, home, dbPath, cleanup } = makeHome()
  let store = new SqliteStore(dbPath)
  try {
    appendAudit(store, 2)
    const created = makeBackup(home, store, dbPath)
    assert.equal(created.ok, true)
    appendAudit(store, 2, 'drill.later.')
    // Live audit anchor at count 4: the backup (count 2) is older than it.
    const anchored = writeAuditAnchor({ home, store, key: KEY })
    assert.equal(anchored.ok, true)
    store.close()
    store = null

    const behind = planRestore({ backupPath: created.path, dbPath, home, key: KEY })
    assert.equal(behind.ok, false)
    assert.equal(behind.code, 'E_AUDIT_ANCHOR_BEHIND')
    assert.match(behind.errors.join(' '), /allow-anchor-behind/)

    const allowed = planRestore({ backupPath: created.path, dbPath, home, key: KEY, allowAnchorBehind: true })
    assert.equal(allowed.ok, true, JSON.stringify(allowed.errors))
    const restored = restoreBackup({ plan: allowed })
    assert.equal(restored.ok, true, JSON.stringify(restored.errors))
    assert.equal(restored.storeClosed, false, 'no store was passed in')
    assert.equal(restored.audit.count, 2)
    assert.ok(restored.warnings.some((warning) => /older than the audit anchor/.test(warning)))
  } finally {
    try { store?.close() } catch {}
    cleanup()
  }
})

test('a corrupt backup is refused before anything is touched', () => {
  const { root, home, dbPath, cleanup } = makeHome()
  let store = new SqliteStore(dbPath)
  try {
    appendAudit(store, 2)
    const created = makeBackup(home, store, dbPath)
    assert.equal(created.ok, true)
    store.close()
    store = null
    const before = readFileSync(dbPath)
    writeFileSync(created.path, 'garbage that is not sqlite')
    const plan = planRestore({ backupPath: created.path, dbPath, home, key: KEY })
    assert.equal(plan.ok, false)
    assert.ok(['E_BACKUP_CORRUPT', 'E_BACKUP_OPEN_FAILED'].includes(plan.code), plan.code)
    const attempted = restoreBackup({ plan })
    assert.equal(attempted.ok, false)
    assert.equal(attempted.originalIntact, true)
    assert.deepEqual(readFileSync(dbPath), before, 'the live database is byte-identical')
  } finally {
    try { store?.close() } catch {}
    cleanup()
  }
})

test('a newer-schema backup is refused with an actionable code', () => {
  const { root, home, dbPath, cleanup } = makeHome()
  const store = new SqliteStore(dbPath)
  try {
    appendAudit(store, 1)
    const created = makeBackup(home, store, dbPath)
    assert.equal(created.ok, true)
    const newer = join(root, 'newer.db')
    writeFileSync(newer, readFileSync(created.path))
    const db = new DatabaseSync(newer)
    try { db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run() } finally { db.close() }
    const plan = planRestore({ backupPath: newer, dbPath, home, key: KEY })
    assert.equal(plan.ok, false)
    assert.equal(plan.code, 'E_BACKUP_SCHEMA_NEWER')
  } finally { store.close(); cleanup() }
})

test('install rename failure (EPERM) leaves the live database untouched', () => {
  const { root, home, dbPath, cleanup } = makeHome()
  let store = new SqliteStore(dbPath)
  try {
    appendAudit(store, 2)
    const created = makeBackup(home, store, dbPath)
    store.close()
    store = null
    const before = readFileSync(dbPath)
    const failingFs = {
      ...nodeFs,
      renameSync() {
        const error = new Error('EPERM: operation not permitted, rename')
        error.code = 'EPERM'
        throw error
      },
    }
    const result = restoreBackup({ backupPath: created.path, dbPath, home, key: KEY, fs: failingFs })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'E_RESTORE_INSTALL_FAILED')
    assert.equal(result.originalIntact, true)
    assert.deepEqual(readFileSync(dbPath), before, 'the live database is byte-identical')
    assert.deepEqual(listTemps(home), [], 'the temp copy was removed')
  } finally {
    try { store?.close() } catch {}
    cleanup()
  }
})

test('post-install verification failure rolls back to the pre-restore backup', () => {
  const { root, home, dbPath, cleanup } = makeHome()
  let store = new SqliteStore(dbPath)
  try {
    appendAudit(store, 2)
    insertCommitment(store, 'cm_before_restore')
    const created = makeBackup(home, store, dbPath)
    store.close()
    store = null
    // The rename succeeds but the installed bytes are corrupted afterwards, so
    // the post-install verification fails and the rollback path must run.
    let renameCalls = 0
    const corruptingFs = {
      ...nodeFs,
      renameSync(from, to) {
        renameCalls += 1
        nodeFs.renameSync(from, to)
        if (renameCalls === 1) nodeFs.writeFileSync(to, 'corrupted after install')
      },
    }
    const result = restoreBackup({ backupPath: created.path, dbPath, home, key: KEY, fs: corruptingFs })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'E_RESTORE_VERIFY_FAILED')
    assert.equal(result.rolledBack, true)
    assert.equal(result.originalIntact, true)
    assert.ok(renameCalls >= 2, 'install + rollback renames happened')
    assert.equal(existsSync(result.preRestoreBackup), false, 'the pre-restore copy was consumed by the rollback')
    const check = new SqliteStore(dbPath, { readOnly: true })
    try {
      assert.equal(check.db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
      assert.equal(countCommitments(check, 'cm_before_restore'), 1, 'the pre-restore state is back')
      assert.equal(check.verifyAudit().ok, true)
    } finally { check.close() }
  } finally {
    try { store?.close() } catch {}
    cleanup()
  }
})

test('restore refuses a non-empty live WAL instead of snapshotting an incomplete rollback', () => {
  const { root, home, dbPath, cleanup } = makeHome()
  let store = new SqliteStore(dbPath)
  try {
    appendAudit(store, 1)
    const created = makeBackup(home, store, dbPath)
    store.close()
    store = null
    const before = readFileSync(dbPath)
    writeFileSync(dbPath + '-wal', 'junk-but-non-empty-wal')
    const result = restoreBackup({ backupPath: created.path, dbPath, home, key: KEY })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'E_RESTORE_WAL_OPEN')
    assert.equal(result.originalIntact, true)
    assert.deepEqual(readFileSync(dbPath), before)
  } finally {
    try { store?.close() } catch {}
    cleanup()
  }
})

test('restore installs a fresh database when the live one is missing', () => {
  const { root, home, dbPath, cleanup } = makeHome()
  let store = new SqliteStore(dbPath)
  try {
    appendAudit(store, 2)
    insertCommitment(store, 'cm_fresh_install')
    const created = makeBackup(home, store, dbPath)
    store.close()
    store = null
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) nodeFs.rmSync(dbPath + suffix, { force: true })
    }
    const result = restoreBackup({ backupPath: created.path, dbPath, home, key: KEY })
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.equal(result.preRestoreBackup, null)
    const check = new SqliteStore(dbPath, { readOnly: true })
    try {
      assert.equal(countCommitments(check, 'cm_fresh_install'), 1)
      assert.equal(check.verifyAudit().count, 2)
    } finally { check.close() }
  } finally {
    try { store?.close() } catch {}
    cleanup()
  }
})

test('a backup without any anchor is allowed but reported as yellow', () => {
  const { root, home, dbPath, cleanup } = makeHome()
  const store = new SqliteStore(dbPath)
  try {
    appendAudit(store, 1)
    const created = makeBackup(home, store, dbPath, { writeAnchor: false })
    const plan = planRestore({ backupPath: created.path, dbPath, home, key: KEY })
    assert.equal(plan.ok, true)
    assert.ok(plan.warnings.some((warning) => /no audit anchor found/.test(warning)), plan.warnings.join(' | '))
    const strict = planRestore({ backupPath: created.path, dbPath, home, key: KEY, requireAnchor: true })
    assert.equal(strict.ok, false)
    assert.equal(strict.code, 'E_AUDIT_ANCHOR_ABSENT')
  } finally { store.close(); cleanup() }
})
test('rescue mode (allowBrokenAuditChain) proceeds when the audit key is unavailable', () => {
  const { root, home, dbPath, cleanup } = makeHome()
  const savedKey = process.env.ADVISERS_AUDIT_KEY
  process.env.ADVISERS_AUDIT_KEY = KEY
  let store = null
  try {
    store = new SqliteStore(dbPath)
    appendAudit(store, 2)
    const created = makeBackup(home, store, dbPath)
    assert.equal(created.ok, true)
    store.close()
    store = null
    // Audit key lost: the keyed chain no longer verifies and the keyed sidecar
    // anchor cannot be checked. Plain restore refuses; rescue mode reports both.
    delete process.env.ADVISERS_AUDIT_KEY
    const blocked = planRestore({ backupPath: created.path, dbPath, home })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'E_BACKUP_AUDIT_CHAIN_BROKEN')
    const rescue = planRestore({ backupPath: created.path, dbPath, home, allowBrokenAuditChain: true })
    assert.equal(rescue.ok, true, JSON.stringify(rescue.errors))
    assert.ok(rescue.warnings.some((warning) => /rescue mode/.test(warning)), rescue.warnings.join(' | '))
    const restored = restoreBackup({ plan: rescue })
    assert.equal(restored.ok, true, JSON.stringify(restored.errors))
    assert.equal(restored.audit.count, 2)
  } finally {
    if (savedKey === undefined) delete process.env.ADVISERS_AUDIT_KEY
    else process.env.ADVISERS_AUDIT_KEY = savedKey
    try { store?.close() } catch {}
    cleanup()
  }
})
