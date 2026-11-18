import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'

// 0.2.3 persistence v2 (03-design-persistence-v2.md §5): schema v20 is the
// migration ledger (schema_migrations) plus the three v20 indexes. These tests
// pin the v19 -> v20 and v18 -> v20 migrations, the checkpoint+row-count
// verified backup, the fail-closed refusal when a backup cannot be verified,
// the atomic rollback of a failed step and the future-schema refusal.

const NOW = '2026-11-01T00:00:00.000Z'
const SAMPLE_TABLES = ['matters', 'facts', 'commitments', 'preferences', 'audit']
const V20_INDEX_NAMES = ['idx_turns_seq', 'idx_facts_identity', 'idx_memory_candidates_status']
const V20_META_KEYS = ['schema_migrated_from', 'schema_migrated_at', 'schema_migrated_app', 'schema_migration_backup']

function setup(prefix = 'advisers-migration-v20-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, db: join(root, 'state.db') };
}

function readRaw(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

function countsOf(dbPath) {
  const raw = readRaw(dbPath);
  try {
    const counts = {};
    for (const table of SAMPLE_TABLES) {
      const present = raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).n;
      if (present) counts[table] = Number(raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    }
    return counts;
  } finally { raw.close() }
}

/** Seed a complete, current (v20) database with data in every sampled table. */
function createV20Seed(dbPath) {
  const store = new SqliteStore(dbPath);
  try {
    const ledger = {
      version: 1,
      matters: [{ id: 'm1', title: '客户A', status: 'active', domain: 'consulting', secrecy: 0, participants: ['a'], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW }],
      facts: [{ id: 'f1', matterId: 'm1', subject: 'client', predicate: 'budget', object: '300万', recordedAt: NOW, authority: 'user', confidence: 0.9, status: 'confirmed', validFrom: NOW }],
      commitments: [{ id: 'cm1', matterId: 'm1', debtor: 'agent', creditor: 'user', action: '发报价', timezone: 'Asia/Shanghai', status: 'open', evidence: [{ sessionId: 'c1', turnId: 't1', quote: 'q' }], capability: 'none' }],
      preferences: [{ id: 'p1', kind: 'preference', statement: '邮件先结论', scope: { level: 'global' }, source: { type: 'user_explicit' }, evidence: [], confidence: 0.9, status: 'confirmed', validFrom: NOW, priority: 'soft' }],
      links: [], updates: [], routines: [], routinePatches: [], routes: {},
    };
    store.save(ledger);
    store.addTurn({ conversationId: 'c1', role: 'user', content: '先给结论，预算总额是420万，报价单周五前发。' });
    store.appendAudit({ actor: 'local', action: 'commit.add', allowed: true, reason: 'cm1' });
  } finally { store.close() }
  return countsOf(dbPath);
}

/** Turn a current database into a genuine v19 one: drop the v20 artifacts only. */
function downgradeToV19(dbPath) {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('DROP INDEX IF EXISTS idx_turns_seq');
    raw.exec('DROP INDEX IF EXISTS idx_facts_identity');
    raw.exec('DROP INDEX IF EXISTS idx_memory_candidates_status');
    raw.exec('DROP TABLE IF EXISTS schema_migrations');
    for (const key of V20_META_KEYS) raw.prepare('DELETE FROM meta WHERE key = ?').run(key);
    raw.prepare("UPDATE meta SET value = '19' WHERE key = 'schema_version'").run();
  } finally { raw.close() }
}

/** A hand-built v18 database (base tables + the v19-era unicode61 FTS). */
function createV18Database(dbPath) {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    raw.prepare("INSERT INTO meta(key,value) VALUES('schema_version','18')").run();
    raw.exec('CREATE TABLE turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(conversation_id, seq))');
    raw.exec('CREATE TABLE session_summaries (conversation_id TEXT PRIMARY KEY, summary TEXT NOT NULL, through_seq INTEGER NOT NULL, updated_at TEXT NOT NULL)');
    raw.exec("CREATE VIRTUAL TABLE turns_fts USING fts5(content, content='turns', content_rowid='rowid')");
    raw.prepare('INSERT INTO turns(id,conversation_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)').run('t1', 'c1', 1, 'user', '先给结论，预算总额是420万', NOW);
    raw.prepare('INSERT INTO turns(id,conversation_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)').run('t2', 'c2', 1, 'user', '里程碑：蓝鲸计划正式启动', NOW);
    raw.prepare('INSERT INTO session_summaries(conversation_id,summary,through_seq,updated_at) VALUES(?,?,?,?)').run('c1', '讨论了预算总额', 1, NOW);
  } finally { raw.close() }
}

function backupsIn(root) {
  return readdirSync(root).filter((name) => /^state\.db\.before-migrate-v\d+-\d+$/.test(name));
}

function migrationRows(store) {
  return store.db.prepare('SELECT version, name, applied_at, duration_ms, backup_path FROM schema_migrations ORDER BY version').all();
}

function indexNames(store) {
  return store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_turns_seq','idx_facts_identity','idx_memory_candidates_status') ORDER BY name").all().map((row) => row.name);
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('v19 -> v20: version, migration ledger, indexes, data, FTS and verified backup', () => {
  const { root, db } = setup();
  try {
    const beforeCounts = createV20Seed(db);
    downgradeToV19(db);
    assert.equal(readRaw(db).prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '19');
    const store = new SqliteStore(db);
    try {
      assert.equal(store.getMeta('schema_version'), String(SCHEMA_VERSION));
      assert.equal(SCHEMA_VERSION, 20);
      assert.ok(store.schemaVersion() === 20);
      const rows = migrationRows(store);
      assert.equal(rows.length, 1, 'a v19 database records exactly the v20 step');
      assert.equal(rows[0].version, 20);
      assert.equal(rows[0].name, 'incremental-writes-readonly-reads');
      assert.match(rows[0].applied_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(Number.isInteger(rows[0].duration_ms) && rows[0].duration_ms >= 0);
      assert.match(rows[0].backup_path, /state\.db\.before-migrate-v19-\d+$/);
      assert.deepEqual(indexNames(store), V20_INDEX_NAMES.slice().sort());
      assert.equal(store.ftsTokenizer, 'trigram', 'v20 does not rebuild the v19 FTS index');
      assert.equal(store.searchTurns('预算总额').length, 1);
      assert.deepEqual(countsOf(db), beforeCounts, 'migrating must not change any sampled row count');
      assert.equal(store.getMeta('schema_migrated_from'), '19');
      assert.equal(store.getMeta('schema_migration_backup'), rows[0].backup_path);
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      assert.equal(store.getMeta('schema_migrated_app'), pkg.version);
      assert.match(store.getMeta('schema_migrated_at'), /^\d{4}-\d{2}-\d{2}T/);
    } finally { store.close() }
    const backups = backupsIn(root);
    assert.equal(backups.length, 1, 'exactly one pre-migration backup');
    const backupPath = join(root, backups[0]);
    assert.ok(statSync(backupPath).size > 0);
    if (process.platform !== 'win32') assert.equal(statSync(backupPath).mode & 0o777, 0o600, 'the backup must be 0600');
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(backups[0]) && name !== backups[0]), [], 'no verification -wal/-shm sidecars are left behind');
    const backup = readRaw(backupPath);
    try {
      assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      assert.equal(backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '19');
      assert.equal(backup.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'schema_migrations'").get().n, 0);
      for (const table of SAMPLE_TABLES) {
        assert.equal(Number(backup.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), beforeCounts[table], `backup ${table} count`);
      }
      assert.equal(backup.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('idx_turns_seq','idx_facts_identity','idx_memory_candidates_status')").get().n, 0);
    } finally { backup.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('v18 -> v20: legacy base tables + FTS migrate in one step and record from=18', () => {
  const { root, db } = setup('advisers-migration-v18-');
  try {
    createV18Database(db);
    const store = new SqliteStore(db);
    try {
      assert.equal(store.getMeta('schema_version'), '20');
      assert.equal(store.getMeta('schema_migrated_from'), '18');
      assert.equal(store.ftsTokenizer, 'trigram');
      assert.equal(store.searchTurns('预算总额').length, 1);
      assert.equal(store.searchSummaries('预算总额').length, 1);
      const rows = migrationRows(store);
      assert.equal(rows.length, 1, 'only the v20 step is recorded; the legacy block has no ledger row');
      assert.match(rows[0].backup_path, /before-migrate-v18-\d+$/);
      assert.deepEqual(indexNames(store), V20_INDEX_NAMES.slice().sort());
    } finally { store.close() }
    assert.equal(backupsIn(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('a failed v20 step rolls back atomically and leaves the v19 database retryable', () => {
  const { root, db } = setup('advisers-migration-fail-');
  try {
    const beforeCounts = createV20Seed(db);
    downgradeToV19(db);
    const original = SqliteStore.prototype._runMigrationStep;
    SqliteStore.prototype._runMigrationStep = () => { throw new Error('injected step failure') };
    try {
      assert.throws(() => new SqliteStore(db), /injected step failure/);
    } finally {
      SqliteStore.prototype._runMigrationStep = original;
    }
    const raw = readRaw(db);
    try {
      assert.equal(raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '19', 'DDL and the version stamp roll back together');
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'schema_migrations'").get().n, 0);
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('idx_turns_seq','idx_facts_identity','idx_memory_candidates_status')").get().n, 0);
    } finally { raw.close() }
    assert.deepEqual(countsOf(db), beforeCounts);
    assert.equal(backupsIn(root).length, 1, 'the verified backup is kept after a failed step');
    const retry = new SqliteStore(db);
    try {
      assert.equal(retry.getMeta('schema_version'), '20');
      assert.equal(migrationRows(retry).length, 1);
      assert.deepEqual(indexNames(retry), V20_INDEX_NAMES.slice().sort());
    } finally { retry.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('backup verification compares row counts and refuses to migrate on mismatch', () => {
  const { root, db } = setup('advisers-migration-counts-');
  try {
    const beforeCounts = createV20Seed(db);
    const store = new SqliteStore(db);
    try {
      assert.deepEqual(store._sampleTableCounts(store.db), beforeCounts);
      store._verifyBackupCounts(store.db, beforeCounts);
      const wrong = { ...beforeCounts, commitments: beforeCounts.commitments + 1 };
      assert.throws(() => store._verifyBackupCounts(store.db, wrong), /backup row count mismatch for commitments/);
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('a verification failure during the migration refuses it, deletes the partial backup and keeps v19', () => {
  const { root, db } = setup('advisers-migration-verifyfail-');
  try {
    const beforeCounts = createV20Seed(db);
    downgradeToV19(db);
    const original = SqliteStore.prototype._verifyBackupCounts;
    SqliteStore.prototype._verifyBackupCounts = () => { throw new Error('injected count mismatch') };
    try {
      assert.throws(
        () => new SqliteStore(db),
        (error) => error.code === 'E_MIGRATION_BACKUP' && /refusing to migrate without a verified backup/.test(error.message),
      );
    } finally {
      SqliteStore.prototype._verifyBackupCounts = original;
    }
    assert.deepEqual(readdirSync(root).filter((name) => name.includes('before-migrate')), [], 'no unverified backup may be left behind');
    const raw = readRaw(db);
    try { assert.equal(raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '19'); } finally { raw.close() }
    assert.deepEqual(countsOf(db), beforeCounts);
    const retry = new SqliteStore(db);
    try { assert.equal(retry.getMeta('schema_version'), '20') } finally { retry.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('the migration backup folds a committed WAL-only row into the copy', () => {
  const source = setup('advisers-migration-wal-src-');
  const target = setup('advisers-migration-wal-');
  try {
    createV20Seed(source.db);
    downgradeToV19(source.db);
    // Commit a row that only lives in the WAL (autocheckpoint disabled), then
    // capture the main file and the WAL exactly as a crashed process would.
    const raw = new DatabaseSync(source.db);
    let mainBytes;
    let walBytes;
    try {
      raw.exec('PRAGMA wal_autocheckpoint = 0');
      raw.prepare('INSERT INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('cm_wal_only', 'm1', 'user', 'u', 'wal-only committed row', null, 'Asia/Shanghai', 'open', '[]', 'none', null, null);
      mainBytes = readFileSync(source.db);
      walBytes = readFileSync(`${source.db}-wal`);
    } finally { raw.close() }
    assert.equal(walBytes.includes(Buffer.from('cm_wal_only')), true, 'fixture: the row bytes are in the WAL');
    assert.equal(mainBytes.includes(Buffer.from('cm_wal_only')), false, 'fixture: the row bytes are not in the main file');
    writeFileSync(target.db, mainBytes);
    writeFileSync(`${target.db}-wal`, walBytes);
    const store = new SqliteStore(target.db);
    try {
      assert.equal(store.getMeta('schema_version'), '20');
      assert.equal(store.countCommitments(), 2, 'the WAL-only row survived the migration');
    } finally { store.close() }
    const backups = backupsIn(target.root);
    assert.equal(backups.length, 1);
    const backup = readRaw(join(target.root, backups[0]));
    try {
      assert.equal(backup.prepare("SELECT action FROM commitments WHERE id = 'cm_wal_only'").get()?.action, 'wal-only committed row', 'checkpoint-before-copy must include the WAL row');
      assert.equal(Number(backup.prepare('SELECT COUNT(*) AS n FROM commitments').get().n), 2);
      assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    } finally { backup.close() }
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('a future schema (v21) is refused with E_SCHEMA_NEWER and the file is not modified', () => {
  const { root, db } = setup('advisers-migration-future-');
  try {
    const store = new SqliteStore(db);
    store.close();
    const raw = new DatabaseSync(db);
    raw.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version','21')").run();
    raw.close();
    const before = fileHash(db);
    assert.throws(() => new SqliteStore(db), (error) => {
      assert.equal(error.code, 'E_SCHEMA_NEWER');
      assert.match(error.message, /database schema v21 is newer than this CLI \(v20\)/);
      return true;
    });
    assert.equal(fileHash(db), before, 'a refused future schema must not change any byte');
    assert.deepEqual(readdirSync(root).filter((name) => name.includes('before-migrate')), []);
  } finally { rmSync(root, { recursive: true, force: true }) }
});
