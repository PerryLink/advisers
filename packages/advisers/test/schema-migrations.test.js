import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'
import { downgradeToV19 } from './schema-fixtures.js'

// 0.3.0 schema v21: the schema_migrations ledger contents for a fresh database,
// an upgraded database and an idempotent reopen. The v20 step remains pinned so
// the chain keeps exactly two rows (one migration step per version, R1).

const STEP20 = 'incremental-writes-readonly-reads'
const STEP21 = 'client-project-entities-delivery-lineage'

function setup(prefix = 'advisers-schema-migrations-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, db: join(root, 'state.db') }
}

function migrations(store) {
  return store.db.prepare('SELECT version, name, applied_at, duration_ms, backup_path FROM schema_migrations ORDER BY version').all()
}

function backupFiles(root) {
  return readdirSync(root).filter((name) => name.includes('before-migrate'))
}

function pkgVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
}

test('a fresh database records exactly the v20 and v21 steps and the diagnostics meta keys', () => {
  const { root, db } = setup('advisers-fresh-migrations-')
  try {
    const store = new SqliteStore(db)
    try {
      assert.equal(SCHEMA_VERSION, 21)
      const rows = migrations(store)
      assert.equal(rows.length, 2, 'fresh databases run both version steps; no separate baseline row')
      assert.deepEqual(rows.map((row) => row.version), [20, 21])
      assert.deepEqual(rows.map((row) => row.name), [STEP20, STEP21])
      for (const row of rows) {
        assert.match(row.applied_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        assert.ok(Number.isInteger(row.duration_ms) && row.duration_ms >= 0)
        assert.equal(row.backup_path, null, 'a fresh database needs no backup')
      }
      assert.equal(store.getMeta('schema_version'), '21')
      assert.equal(store.getMeta('schema_migrated_from'), '0')
      assert.equal(store.getMeta('schema_migrated_app'), pkgVersion())
      assert.match(store.getMeta('schema_migrated_at'), /^\d{4}-\d{2}-\d{2}T/)
      assert.equal(store.getMeta('schema_migration_backup'), undefined, 'no backup path for a fresh database')
      assert.deepEqual(backupFiles(root), [])
      const v20Indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_turns_seq','idx_facts_identity','idx_memory_candidates_status')").all()
      assert.equal(v20Indexes.length, 3)
      const v21Indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_clients_name_norm_active','idx_matters_client','idx_deliveries_matter')").all()
      assert.equal(v21Indexes.length, 3)
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reopening does not add a migration row, a backup or a version bump (idempotent)', () => {
  const { root, db } = setup('advisers-reopen-migrations-')
  try {
    const first = new SqliteStore(db)
    first.setMeta('marker', 'one')
    const firstRows = migrations(first)
    const firstBackups = backupFiles(root)
    first.close()
    const second = new SqliteStore(db)
    try {
      assert.deepEqual(migrations(second), firstRows, 'the ledger rows are byte-identical after a plain reopen')
      assert.equal(migrationCount(second), 2)
      assert.equal(second.getMeta('schema_version'), '21')
      assert.equal(second.getMeta('schema_migrated_from'), '0')
      assert.equal(second.getMeta('marker'), 'one')
      // Dropping a v21 index is repaired by the INDEXES pass without a schema
      // bump or a new migration row (layout-only indexes, R3).
      second.db.exec('DROP INDEX idx_matters_client')
      second.close()
      const third = new SqliteStore(db)
      try {
        assert.equal(third.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_matters_client'").get().n, 1, 'the index is recreated on open')
        assert.equal(migrationCount(third), 2, 'but the migration ledger is unchanged')
        assert.equal(third.getMeta('schema_version'), '21')
      } finally { third.close() }
    } finally {
      // second was closed above only if the index-drop path ran; guard the
      // close so a failed assertion does not mask the original error.
      try { second.close() } catch {}
    }
    assert.deepEqual(backupFiles(root), firstBackups, 'no migration -> no backup')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function migrationCount(store) {
  return Number(store.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n)
}

test('an upgraded database records both steps with the same real v19 backup path', () => {
  const { root, db } = setup('advisers-upgrade-migrations-')
  try {
    const seed = new SqliteStore(db)
    seed.save({ version: 1, matters: [], facts: [], commitments: [], preferences: [], links: [], updates: [], routines: [], routinePatches: [], routes: {} })
    seed.close()
    downgradeToV19(db)
    const store = new SqliteStore(db)
    try {
      const rows = migrations(store)
      assert.deepEqual(rows.map((row) => row.version), [20, 21])
      const backupPath = store.getMeta('schema_migration_backup')
      assert.equal(rows[0].backup_path, backupPath, 'the v20 step and the meta key agree')
      assert.equal(rows[1].backup_path, backupPath, 'one verified backup covers the whole run')
      const match = /state\.db\.before-migrate-v19-(\d+)$/.exec(backupPath)
      assert.ok(match, 'unexpected backup path ' + backupPath)
      assert.ok(statSync(backupPath).size > 0)
      assert.equal(store.getMeta('schema_migrated_from'), '19')
      assert.equal(store.getMeta('schema_version'), '21')
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('schema_migrations is an internal table: it never appears in a LedgerSnapshot', () => {
  const { root, db } = setup('advisers-internal-migrations-')
  try {
    const store = new SqliteStore(db)
    try {
      const snapshot = store.load()
      assert.equal('schema_migrations' in snapshot, false, 'load() only returns the nine wire-v1 ledger tables')
      assert.deepEqual(Object.keys(snapshot).sort(), ['commitments', 'facts', 'links', 'matters', 'preferences', 'routinePatches', 'routines', 'routes', 'updates', 'version'].sort())
      assert.equal('clients' in snapshot, false, 'the v21 customer entities are SQLite-only, not wire tables')
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('schemaVersion()/assertSchemaCurrent() distinguish a fresh empty SQLite file', () => {
  const { root, db } = setup('advisers-empty-schema-')
  try {
    const raw = new DatabaseSync(db)
    raw.exec('CREATE TABLE unrelated (x TEXT)')
    raw.close()
    const store = new SqliteStore(db, { readOnly: true })
    try {
      assert.equal(store.schemaVersion(), null, 'no meta table -> unknown schema')
      assert.throws(() => store.assertSchemaCurrent(), (error) => error.code === 'E_SCHEMA_STALE')
      assert.throws(() => store.getMeta('schema_version'), /no such table: meta/)
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
