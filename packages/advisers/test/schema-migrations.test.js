import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'

// 0.2.3 persistence v2: the schema_migrations ledger contents for a fresh
// database, an upgraded database and an idempotent reopen.

const STEP_NAME = 'incremental-writes-readonly-reads'

function setup(prefix = 'advisers-schema-migrations-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, db: join(root, 'state.db') };
}

function migrations(store) {
  return store.db.prepare('SELECT version, name, applied_at, duration_ms, backup_path FROM schema_migrations ORDER BY version').all();
}

function backupFiles(root) {
  return readdirSync(root).filter((name) => name.includes('before-migrate'));
}

function pkgVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

test('a fresh database records exactly one v20 step and the diagnostics meta keys', () => {
  const { root, db } = setup('advisers-fresh-migrations-');
  try {
    const store = new SqliteStore(db);
    try {
      assert.equal(SCHEMA_VERSION, 20);
      const rows = migrations(store);
      assert.equal(rows.length, 1, 'fresh databases run the v20 step; no separate baseline row');
      assert.equal(rows[0].version, 20);
      assert.equal(rows[0].name, STEP_NAME);
      assert.match(rows[0].applied_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.ok(Number.isInteger(rows[0].duration_ms) && rows[0].duration_ms >= 0);
      assert.equal(rows[0].backup_path, null, 'a fresh database needs no backup');
      assert.equal(store.getMeta('schema_version'), '20');
      assert.equal(store.getMeta('schema_migrated_from'), '0');
      assert.equal(store.getMeta('schema_migrated_app'), pkgVersion());
      assert.match(store.getMeta('schema_migrated_at'), /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(store.getMeta('schema_migration_backup'), undefined, 'no backup path for a fresh database');
      assert.deepEqual(backupFiles(root), []);
      const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' AND name IN ('idx_turns_seq','idx_facts_identity','idx_memory_candidates_status')").all().map((row) => row.name);
      assert.equal(indexes.length, 3);
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('reopening does not add a migration row, a backup or a version bump (idempotent)', () => {
  const { root, db } = setup('advisers-reopen-migrations-');
  try {
    const first = new SqliteStore(db);
    first.setMeta('marker', 'one');
    const firstRows = migrations(first);
    const firstBackups = backupFiles(root);
    first.close();
    const second = new SqliteStore(db);
    try {
      assert.deepEqual(migrations(second), firstRows, 'the ledger row is byte-identical after a plain reopen');
      assert.equal(migrationCount(second), 1);
      assert.equal(second.getMeta('schema_version'), '20');
      assert.equal(second.getMeta('schema_migrated_from'), '0');
      assert.equal(second.getMeta('marker'), 'one');
      // Dropping a v20 index is repaired by the INDEXES pass without a schema
      // bump or a new migration row (perf-regression contract).
      second.db.exec('DROP INDEX idx_turns_seq');
      second.close();
      const third = new SqliteStore(db);
      try {
        assert.equal(third.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_turns_seq'").get().n, 1, 'the index is recreated on open');
        assert.equal(migrationCount(third), 1, 'but the migration ledger is unchanged');
        assert.equal(third.getMeta('schema_version'), '20');
      } finally { third.close() }
    } finally {
      // second was closed above only if the index-drop path ran; guard the
      // close so a failed assertion does not mask the original error.
      try { second.close() } catch {}
    }
    assert.deepEqual(backupFiles(root), firstBackups, 'no migration -> no backup');
  } finally { rmSync(root, { recursive: true, force: true }) }
});

function migrationCount(store) {
  return Number(store.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n);
}

test('an upgraded database records the real backup path and previous version', () => {
  const { root, db } = setup('advisers-upgrade-migrations-');
  try {
    const seed = new SqliteStore(db);
    seed.save({ version: 1, matters: [], facts: [], commitments: [], preferences: [], links: [], updates: [], routines: [], routinePatches: [], routes: {} });
    seed.close();
    downgradeToV19(db);
    const store = new SqliteStore(db);
    try {
      const rows = migrations(store);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].backup_path, store.getMeta('schema_migration_backup'), 'the ledger row and meta agree');
      const match = /state\.db\.before-migrate-v19-(\d+)$/.exec(rows[0].backup_path);
      assert.ok(match, `unexpected backup path ${rows[0].backup_path}`);
      assert.ok(statSync(rows[0].backup_path).size > 0);
      assert.equal(store.getMeta('schema_migrated_from'), '19');
      assert.equal(store.getMeta('schema_version'), '20');
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

function downgradeToV19(dbPath) {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('DROP INDEX IF EXISTS idx_turns_seq');
    raw.exec('DROP INDEX IF EXISTS idx_facts_identity');
    raw.exec('DROP INDEX IF EXISTS idx_memory_candidates_status');
    raw.exec('DROP TABLE IF EXISTS schema_migrations');
    for (const key of ['schema_migrated_from', 'schema_migrated_at', 'schema_migrated_app', 'schema_migration_backup']) {
      raw.prepare('DELETE FROM meta WHERE key = ?').run(key);
    }
    raw.prepare("UPDATE meta SET value = '19' WHERE key = 'schema_version'").run();
  } finally { raw.close() }
}

test('schema_migrations is an internal table: it never appears in a LedgerSnapshot', () => {
  const { root, db } = setup('advisers-internal-migrations-');
  try {
    const store = new SqliteStore(db);
    try {
      const snapshot = store.load();
      assert.equal('schema_migrations' in snapshot, false, 'load() only returns the nine wire-v1 ledger tables');
      assert.deepEqual(Object.keys(snapshot).sort(), ['commitments', 'facts', 'links', 'matters', 'preferences', 'routinePatches', 'routines', 'routes', 'updates', 'version'].sort());
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('schemaVersion()/assertSchemaCurrent() distinguish a fresh empty SQLite file', () => {
  const { root, db } = setup('advisers-empty-schema-');
  try {
    const raw = new DatabaseSync(db);
    raw.exec('CREATE TABLE unrelated (x TEXT)');
    raw.close();
    const store = new SqliteStore(db, { readOnly: true });
    try {
      assert.equal(store.schemaVersion(), null, 'no meta table -> unknown schema');
      assert.throws(() => store.assertSchemaCurrent(), (error) => error.code === 'E_SCHEMA_STALE');
      assert.throws(() => store.getMeta('schema_version'), /no such table: meta/);
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});
