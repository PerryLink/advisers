import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'
import { downgradeToV19, downgradeToV20 } from './schema-fixtures.js'

// 0.3.0 schema v21 (customer entities) migration contract.
//
// The v20 step (persistence v2) is pinned here together with the new v21 step
// so the whole chain is covered by one fixture set:
//  - a genuine v20 database upgrades to v21: customer tables, ownership columns
//    and delivery-lineage columns appear, every pre-existing row is untouched,
//    and the pre-migration backup is taken at v20 and verified;
//  - v19 -> v21 records BOTH steps (20 and 21) and one backup taken at v19;
//  - v18 -> v21 runs the legacy base block and the two steps in one transaction;
//  - a failing v21 step rolls back atomically and leaves the v20 database
//    retryable (no half-migrated customer table, no v21 ledger row);
//  - a backup verification failure refuses the migration (fail closed);
//  - a committed WAL-only row is folded into the backup before the upgrade;
//  - a future schema (v22) is refused and the file is never modified.

const NOW = '2026-11-01T00:00:00.000Z'
const SAMPLE_TABLES = ['matters', 'facts', 'commitments', 'preferences', 'audit']
const V20_INDEX_NAMES = ['idx_turns_seq', 'idx_facts_identity', 'idx_memory_candidates_status']
const V21_INDEX_NAMES = [
  'idx_clients_name_norm_active', 'idx_clients_status', 'idx_projects_client_status',
  'idx_projects_client_name_active', 'idx_client_notes_client_at', 'idx_matters_client',
  'idx_matters_project', 'idx_commitments_matter', 'idx_deliveries_matter',
]
const CUSTOMER_TABLES = ['clients', 'projects', 'client_notes']
const STEP20 = 'incremental-writes-readonly-reads'
const STEP21 = 'client-project-entities-delivery-lineage'
const V20_META_KEYS = ['schema_migrated_from', 'schema_migrated_at', 'schema_migrated_app', 'schema_migration_backup']

function setup(prefix = 'advisers-migration-v21-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, db: join(root, 'state.db') }
}

function readRaw(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true })
}

function tableNames(dbPath) {
  const raw = readRaw(dbPath)
  try {
    return new Set(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
  } finally { raw.close() }
}

function columnsOf(dbPath, table) {
  const raw = readRaw(dbPath)
  try { return raw.prepare('PRAGMA table_info(' + table + ')').all().map((row) => row.name) } finally { raw.close() }
}

function countsOf(dbPath) {
  const raw = readRaw(dbPath)
  try {
    const counts = {}
    for (const table of SAMPLE_TABLES) {
      const present = raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).n
      if (present) counts[table] = Number(raw.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n)
    }
    return counts
  } finally { raw.close() }
}

/** Seed a complete, current (v21) database with data in every sampled table. */
function createSeed(dbPath) {
  const store = new SqliteStore(dbPath)
  try {
    const ledger = {
      version: 1,
      matters: [{ id: 'm1', title: '客户A', status: 'active', domain: 'consulting', secrecy: 0, participants: ['a'], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW }],
      facts: [{ id: 'f1', matterId: 'm1', subject: 'client', predicate: 'budget', object: '300万', recordedAt: NOW, authority: 'user', confidence: 0.9, status: 'confirmed', validFrom: NOW }],
      commitments: [{ id: 'cm1', matterId: 'm1', debtor: 'agent', creditor: 'user', action: '发报价', timezone: 'Asia/Shanghai', status: 'open', evidence: [{ sessionId: 'c1', turnId: 't1', quote: 'q' }], capability: 'none' }],
      preferences: [{ id: 'p1', kind: 'preference', statement: '邮件先结论', scope: { level: 'global' }, source: { type: 'user_explicit' }, evidence: [], confidence: 0.9, status: 'confirmed', validFrom: NOW, priority: 'soft' }],
      links: [], updates: [], routines: [], routinePatches: [], routes: {},
    }
    store.save(ledger)
    store.addTurn({ conversationId: 'c1', role: 'user', content: '先给结论，预算总额是420万，报价单周五前发。' })
    store.addDelivery({ matterId: 'm1', conversationId: 'c1', files: ['out/legacy.docx'], tool: 'office_build', title: '旧交付' })
    store.appendAudit({ actor: 'local', action: 'commit.add', allowed: true, reason: 'cm1' })
  } finally { store.close() }
  return countsOf(dbPath)
}

/** A hand-built v18 database (base tables + the v19-era unicode61 FTS). */
function createV18Database(dbPath) {
  const raw = new DatabaseSync(dbPath)
  try {
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    raw.prepare("INSERT INTO meta(key,value) VALUES('schema_version','18')").run()
    raw.exec('CREATE TABLE turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(conversation_id, seq))')
    raw.exec('CREATE TABLE session_summaries (conversation_id TEXT PRIMARY KEY, summary TEXT NOT NULL, through_seq INTEGER NOT NULL, updated_at TEXT NOT NULL)')
    raw.exec("CREATE VIRTUAL TABLE turns_fts USING fts5(content, content='turns', content_rowid='rowid')")
    raw.prepare('INSERT INTO turns(id,conversation_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)').run('t1', 'c1', 1, 'user', '先给结论，预算总额是420万', NOW)
    raw.prepare('INSERT INTO turns(id,conversation_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)').run('t2', 'c2', 1, 'user', '里程碑：蓝鲸计划正式启动', NOW)
    raw.prepare('INSERT INTO session_summaries(conversation_id,summary,through_seq,updated_at) VALUES(?,?,?,?)').run('c1', '讨论了预算总额', 1, NOW)
  } finally { raw.close() }
}

function backupsIn(root) {
  return readdirSync(root).filter((name) => /^state\.db\.before-migrate-v\d+-\d+$/.test(name))
}

function migrationRows(store) {
  return store.db.prepare('SELECT version, name, applied_at, duration_ms, backup_path FROM schema_migrations ORDER BY version').all()
}

function indexNames(store, names) {
  return store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()
    .map((row) => row.name).filter((name) => names.includes(name)).sort()
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('v20 -> v21: version, both migration rows, customer layout, data and verified backup', () => {
  const { root, db } = setup()
  try {
    const beforeCounts = createSeed(db)
    downgradeToV20(db)
    assert.equal(tableNames(db).has('clients'), false, 'fixture: a genuine v20 database has no customer tables')
    assert.equal(columnsOf(db, 'matters').includes('client_id'), false, 'fixture: v20 matters have no ownership columns')
    const raw = readRaw(db)
    try { assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '20') } finally { raw.close() }

    const store = new SqliteStore(db)
    try {
      assert.equal(SCHEMA_VERSION, 21)
      assert.equal(store.getMeta('schema_version'), '21')
      assert.equal(store.schemaVersion(), 21)
      const rows = migrationRows(store)
      assert.equal(rows.length, 2, 'the v20 row survives and exactly the v21 step is appended')
      assert.deepEqual(rows.map((row) => row.version), [20, 21])
      assert.equal(rows[0].name, STEP20)
      assert.equal(rows[0].backup_path, null, 'the v20 step was applied to a fresh database: no backup')
      assert.equal(rows[1].name, STEP21)
      assert.match(rows[1].backup_path, /state\.db\.before-migrate-v20-\d+$/)
      assert.match(rows[1].applied_at, /^\d{4}-\d{2}-\d{2}T/)
      assert.ok(Number.isInteger(rows[1].duration_ms) && rows[1].duration_ms >= 0)
      assert.equal(store.getMeta('schema_migrated_from'), '20')
      assert.equal(store.getMeta('schema_migration_backup'), rows[1].backup_path)

      const tables = tableNames(db)
      for (const table of CUSTOMER_TABLES) assert.ok(tables.has(table), 'missing table ' + table)
      for (const column of ['client_id', 'project_id']) assert.ok(columnsOf(db, 'matters').includes(column), 'missing matters.' + column)
      assert.ok(columnsOf(db, 'commitments').includes('created_at'), 'missing commitments.created_at')
      for (const column of ['client_id', 'project_id', 'template_name', 'template_version', 'quote_no', 'data_sha256']) {
        assert.ok(columnsOf(db, 'deliveries').includes(column), 'missing deliveries.' + column)
      }
      assert.deepEqual(indexNames(store, V21_INDEX_NAMES), V21_INDEX_NAMES.slice().sort())
      assert.deepEqual(indexNames(store, V20_INDEX_NAMES), V20_INDEX_NAMES.slice().sort(), 'the v20 indexes stay')
      assert.deepEqual([...tables].filter((name) => CUSTOMER_TABLES.includes(name)).length, CUSTOMER_TABLES.length)

      assert.deepEqual(countsOf(db), beforeCounts, 'migrating must not change any ledger row count')
      assert.equal(store.searchTurns('预算总额').length, 1, 'the v19 FTS index is not rebuilt by v21')

      // Pre-v21 rows keep their exact old JSON shape (no invented lineage).
      const deliveries = store.listDeliveries(10)
      assert.equal(deliveries.length, 1)
      assert.equal(deliveries[0].title, '旧交付')
      assert.equal('clientId' in deliveries[0], false)
      assert.equal('templateName' in deliveries[0], false)
      const commitment = store.getCommitment('cm1')
      assert.equal(commitment.action, '发报价')
      assert.equal('createdAt' in commitment, false, 'an old commitment has no creation instant to invent')
      const matter = store.getMatter('m1')
      assert.equal('clientId' in matter, false)
      assert.equal('projectId' in matter, false)
    } finally { store.close() }

    const backups = backupsIn(root)
    assert.equal(backups.length, 1, 'exactly one pre-migration backup')
    const backupPath = join(root, backups[0])
    assert.match(backups[0], /before-migrate-v20-/)
    assert.ok(statSync(backupPath).size > 0)
    if (process.platform !== 'win32') assert.equal(statSync(backupPath).mode & 0o777, 0o600, 'the backup must be 0600')
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(backups[0]) && name !== backups[0]), [], 'no verification -wal/-shm sidecars are left behind')
    const backup = readRaw(backupPath)
    try {
      assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok')
      assert.equal(backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '20')
      assert.equal(Number(backup.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'clients'").get().n), 0)
      assert.equal(backup.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'schema_migrations'").get().n, 1)
      assert.equal(Number(backup.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n), 1)
      for (const table of SAMPLE_TABLES) {
        assert.equal(Number(backup.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n), beforeCounts[table], 'backup ' + table + ' count')
      }
    } finally { backup.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('v19 -> v21: the chain records both steps and keeps one v19 backup', () => {
  const { root, db } = setup('advisers-migration-v19-')
  try {
    const beforeCounts = createSeed(db)
    downgradeToV19(db)
    assert.equal(tableNames(db).has('schema_migrations'), false, 'fixture: a genuine v19 database has no migration ledger')
    const raw = readRaw(db)
    try { assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '19') } finally { raw.close() }
    const store = new SqliteStore(db)
    try {
      assert.equal(store.getMeta('schema_version'), '21')
      assert.equal(store.getMeta('schema_migrated_from'), '19')
      const rows = migrationRows(store)
      assert.deepEqual(rows.map((row) => row.version), [20, 21])
      assert.deepEqual(rows.map((row) => row.name), [STEP20, STEP21])
      assert.match(rows[0].backup_path, /before-migrate-v19-\d+$/)
      assert.equal(rows[0].backup_path, rows[1].backup_path, 'one verified backup covers both steps of the run')
      assert.equal(store.searchTurns('预算总额').length, 1)
      assert.deepEqual(countsOf(db), beforeCounts)
      for (const table of CUSTOMER_TABLES) assert.ok(tableNames(db).has(table), 'missing table ' + table)
    } finally { store.close() }
    assert.equal(backupsIn(root).length, 1)
    assert.match(backupsIn(root)[0], /before-migrate-v19-/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('v18 -> v21: legacy base tables + both steps migrate and record from=18', () => {
  const { root, db } = setup('advisers-migration-v18-')
  try {
    createV18Database(db)
    const store = new SqliteStore(db)
    try {
      assert.equal(store.getMeta('schema_version'), '21')
      assert.equal(store.getMeta('schema_migrated_from'), '18')
      assert.equal(store.ftsTokenizer, 'trigram')
      assert.equal(store.searchTurns('预算总额').length, 1)
      assert.equal(store.searchSummaries('预算总额').length, 1)
      const rows = migrationRows(store)
      assert.deepEqual(rows.map((row) => row.version), [20, 21], 'the legacy block has no ledger row; both version steps do')
      assert.match(rows[0].backup_path, /before-migrate-v18-\d+$/)
      for (const table of CUSTOMER_TABLES) assert.ok(tableNames(db).has(table), 'missing table ' + table)
    } finally { store.close() }
    assert.equal(backupsIn(root).length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a failed v21 step rolls back atomically and leaves the v20 database retryable', () => {
  const { root, db } = setup('advisers-migration-fail-')
  try {
    const beforeCounts = createSeed(db)
    downgradeToV20(db)
    const original = SqliteStore.prototype._runMigrationStep
    SqliteStore.prototype._runMigrationStep = function (step) {
      if (step.version === 21) throw new Error('injected v21 step failure')
      return original.call(this, step)
    }
    try {
      assert.throws(() => new SqliteStore(db), /injected v21 step failure/)
    } finally {
      SqliteStore.prototype._runMigrationStep = original
    }
    const raw = readRaw(db)
    try {
      assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '20', 'DDL and the version stamp roll back together')
      assert.equal(Number(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('clients','projects','client_notes')").get().n), 0, 'no half-created customer table may survive')
      assert.equal(Number(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'schema_migrations'").get().n), 1, 'only the v20 row remains')
      const matterColumns = raw.prepare('PRAGMA table_info(matters)').all().map((row) => row.name)
      assert.equal(matterColumns.includes('client_id'), false)
      const deliveryColumns = raw.prepare('PRAGMA table_info(deliveries)').all().map((row) => row.name)
      assert.equal(deliveryColumns.includes('data_sha256'), false)
    } finally { raw.close() }
    assert.deepEqual(countsOf(db), beforeCounts)
    assert.equal(backupsIn(root).length, 1, 'the verified backup is kept after a failed step')

    const retry = new SqliteStore(db)
    try {
      assert.equal(retry.getMeta('schema_version'), '21')
      assert.deepEqual(migrationRows(retry).map((row) => row.version), [20, 21])
      for (const table of CUSTOMER_TABLES) assert.ok(tableNames(db).has(table), 'missing table ' + table)
      assert.deepEqual(indexNames(retry, V21_INDEX_NAMES), V21_INDEX_NAMES.slice().sort())
    } finally { retry.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('backup verification compares row counts and refuses to migrate on mismatch', () => {
  const { root, db } = setup('advisers-migration-counts-')
  try {
    const store = new SqliteStore(db)
    try {
      const counts = store._sampleTableCounts(store.db)
      assert.deepEqual(store._sampleTableCounts(store.db), counts)
      store._verifyBackupCounts(store.db, counts)
      const wrong = { ...counts, commitments: counts.commitments + 1 }
      assert.throws(() => store._verifyBackupCounts(store.db, wrong), /backup row count mismatch for commitments/)
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a verification failure during the migration refuses it and deletes the partial backup', () => {
  const { root, db } = setup('advisers-migration-verifyfail-')
  try {
    const beforeCounts = createSeed(db)
    downgradeToV20(db)
    const original = SqliteStore.prototype._verifyBackupCounts
    SqliteStore.prototype._verifyBackupCounts = () => { throw new Error('injected count mismatch') }
    try {
      assert.throws(
        () => new SqliteStore(db),
        (error) => error.code === 'E_MIGRATION_BACKUP' && /refusing to migrate without a verified backup/.test(error.message),
      )
    } finally {
      SqliteStore.prototype._verifyBackupCounts = original
    }
    assert.deepEqual(readdirSync(root).filter((name) => name.includes('before-migrate')), [], 'no unverified backup may be left behind')
    const raw = readRaw(db)
    try { assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '20') } finally { raw.close() }
    assert.deepEqual(countsOf(db), beforeCounts)
    const retry = new SqliteStore(db)
    try { assert.equal(retry.getMeta('schema_version'), '21') } finally { retry.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the v21 migration backup folds a committed WAL-only row into the copy', () => {
  const source = setup('advisers-migration-wal-src-')
  const target = setup('advisers-migration-wal-')
  try {
    createSeed(source.db)
    downgradeToV20(source.db)
    const raw = new DatabaseSync(source.db)
    let mainBytes
    let walBytes
    try {
      raw.exec('PRAGMA wal_autocheckpoint = 0')
      raw.prepare('INSERT INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('cm_wal_only', 'm1', 'user', 'u', 'wal-only committed row', null, 'Asia/Shanghai', 'open', '[]', 'none', null, null)
      mainBytes = readFileSync(source.db)
      walBytes = readFileSync(source.db + '-wal')
    } finally { raw.close() }
    assert.equal(walBytes.includes(Buffer.from('cm_wal_only')), true, 'fixture: the row bytes are in the WAL')
    assert.equal(mainBytes.includes(Buffer.from('cm_wal_only')), false, 'fixture: the row bytes are not in the main file')
    writeFileSync(target.db, mainBytes)
    writeFileSync(target.db + '-wal', walBytes)
    const store = new SqliteStore(target.db)
    try {
      assert.equal(store.getMeta('schema_version'), '21')
      assert.equal(store.countCommitments(), 2, 'the WAL-only row survived the migration')
    } finally { store.close() }
    const backups = backupsIn(target.root)
    assert.equal(backups.length, 1)
    const backup = readRaw(join(target.root, backups[0]))
    try {
      assert.equal(backup.prepare("SELECT action FROM commitments WHERE id = 'cm_wal_only'").get()?.action, 'wal-only committed row', 'checkpoint-before-copy must include the WAL row')
      assert.equal(Number(backup.prepare('SELECT COUNT(*) AS n FROM commitments').get().n), 2)
      assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok')
      assert.equal(backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '20', 'the backup is the pre-migration v20 database')
    } finally { backup.close() }
  } finally {
    rmSync(source.root, { recursive: true, force: true })
    rmSync(target.root, { recursive: true, force: true })
  }
})

test('a future schema (v22) is refused with E_SCHEMA_NEWER and the file is not modified', () => {
  const { root, db } = setup('advisers-migration-future-')
  try {
    const store = new SqliteStore(db)
    store.close()
    const raw = new DatabaseSync(db)
    raw.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version','22')").run()
    raw.close()
    const before = fileHash(db)
    assert.throws(() => new SqliteStore(db), (error) => {
      assert.equal(error.code, 'E_SCHEMA_NEWER')
      assert.match(error.message, /database schema v22 is newer than this CLI \(v21\)/)
      return true
    })
    assert.equal(fileHash(db), before, 'a refused future schema must not change any byte')
    assert.deepEqual(readdirSync(root).filter((name) => name.includes('before-migrate')), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
