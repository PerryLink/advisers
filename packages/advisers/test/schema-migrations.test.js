import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'
import { downgradeToV19 } from './schema-fixtures.js'

// Schema v23: the schema_migrations ledger contents for a fresh database, an
// upgraded database and an idempotent reopen. The v20/v21/v22 steps remain
// pinned so the chain keeps exactly one row per version (R1); v22 is the 0.4.0
// KB/mail/money step and v23 is the 0.5.1 memory-trust + mail-threading single
// hop (facts claim fields, mail threading headers, handoff/followup sidecars).

const STEP20 = 'incremental-writes-readonly-reads'
const STEP21 = 'client-project-entities-delivery-lineage'
const STEP22 = 'kb-mail-payment-entities'
const STEP23 = 'fact-claim-fields-and-handoffs'

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

test('a fresh database records exactly the v20, v21, v22 and v23 steps and the diagnostics meta keys', () => {
  const { root, db } = setup('advisers-fresh-migrations-')
  try {
    const store = new SqliteStore(db)
    try {
      assert.equal(SCHEMA_VERSION, 23)
      const rows = migrations(store)
      assert.equal(rows.length, 4, 'fresh databases run every version step; no separate baseline row')
      assert.deepEqual(rows.map((row) => row.version), [20, 21, 22, 23])
      assert.deepEqual(rows.map((row) => row.name), [STEP20, STEP21, STEP22, STEP23])
      for (const row of rows) {
        assert.match(row.applied_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        assert.ok(Number.isInteger(row.duration_ms) && row.duration_ms >= 0)
        assert.equal(row.backup_path, null, 'a fresh database needs no backup')
      }
      assert.equal(store.getMeta('schema_version'), '23')
      assert.equal(store.getMeta('schema_migrated_from'), '0')
      assert.equal(store.getMeta('schema_migrated_app'), pkgVersion())
      assert.match(store.getMeta('schema_migrated_at'), /^\d{4}-\d{2}-\d{2}T/)
      assert.equal(store.getMeta('schema_migration_backup'), undefined, 'no backup path for a fresh database')
      assert.deepEqual(backupFiles(root), [])
      const v20Indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_turns_seq','idx_facts_identity','idx_memory_candidates_status')").all()
      assert.equal(v20Indexes.length, 3)
      const v21Indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_clients_name_norm_active','idx_matters_client','idx_deliveries_matter')").all()
      assert.equal(v21Indexes.length, 3)
      const v22Indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_kb_source_unique','idx_mail_dedupe','idx_receivables_client')").all()
      assert.equal(v22Indexes.length, 3)
      const v23Indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_mail_thread','idx_handoffs_status_expires','idx_waiting_replies_state')").all()
      assert.equal(v23Indexes.length, 3)
      assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('kb_fts','kb_pages_fts')").get().n), 2, 'the v22 step creates both KB FTS indexes')
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
      assert.equal(migrationCount(second), 4)
      assert.equal(second.getMeta('schema_version'), '23')
      assert.equal(second.getMeta('schema_migrated_from'), '0')
      assert.equal(second.getMeta('marker'), 'one')
      // Dropping a v21 index is repaired by the INDEXES pass without a schema
      // bump or a new migration row (layout-only indexes, R3).
      second.db.exec('DROP INDEX idx_matters_client')
      second.db.exec('DROP INDEX idx_kb_source_unique')
      second.db.exec('DROP INDEX idx_mail_thread')
      second.close()
      const third = new SqliteStore(db)
      try {
        assert.equal(third.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_matters_client'").get().n, 1, 'the index is recreated on open')
        assert.equal(third.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_kb_source_unique'").get().n, 1, 'the v22 index is recreated on open too')
        assert.equal(third.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_mail_thread'").get().n, 1, 'the v23 index is recreated on open too')
        assert.equal(migrationCount(third), 4, 'but the migration ledger is unchanged')
        assert.equal(third.getMeta('schema_version'), '23')
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

test('an upgraded database records every step with the same real v19 backup path', () => {
  const { root, db } = setup('advisers-upgrade-migrations-')
  try {
    const seed = new SqliteStore(db)
    seed.save({ version: 1, matters: [], facts: [], commitments: [], preferences: [], links: [], updates: [], routines: [], routinePatches: [], routes: {} })
    seed.close()
    downgradeToV19(db)
    const store = new SqliteStore(db)
    try {
      const rows = migrations(store)
      assert.deepEqual(rows.map((row) => row.version), [20, 21, 22, 23])
      const backupPath = store.getMeta('schema_migration_backup')
      assert.equal(rows[0].backup_path, backupPath, 'the v20 step and the meta key agree')
      assert.equal(rows[1].backup_path, backupPath, 'one verified backup covers the whole run')
      assert.equal(rows[2].backup_path, backupPath, 'the v22 step reuses the same backup')
      assert.equal(rows[3].backup_path, backupPath, 'the v23 step reuses the same backup')
      const match = /state\.db\.before-migrate-v19-(\d+)$/.exec(backupPath)
      assert.ok(match, 'unexpected backup path ' + backupPath)
      assert.ok(statSync(backupPath).size > 0)
      assert.equal(store.getMeta('schema_migrated_from'), '19')
      assert.equal(store.getMeta('schema_version'), '23')
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
      for (const table of ['kb_documents', 'kb_chunks', 'kb_pages', 'mail_messages', 'receivables', 'payments', 'handoffs', 'handoff_claims', 'waiting_replies']) {
        assert.equal(table in snapshot, false, table + ' is SQLite-only, not a wire table')
      }
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
