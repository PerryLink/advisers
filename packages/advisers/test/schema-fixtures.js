import { DatabaseSync } from 'node:sqlite'

/**
 * Shared schema fixtures for the v20/v21 migration tests (0.3.0).
 *
 * A genuine v20 database is a v21 one with every v21 artifact removed: the
 * three customer tables, the ownership/lineage columns on matters/commitments/
 * deliveries, the v21 indexes and the v21 migration row. Downgrading through
 * SQLite (not by copying a fixture file) keeps the fixtures honest: the upgrade
 * then really has to add what it claims to add, and the rollback path is
 * exercised against the same bytes a 0.2.x install would have.
 *
 * SQLite has no DROP COLUMN IF EXISTS either, so every helper checks
 * sqlite_master first and is safe on a partially-built database.
 */

const V21_INDEXES = [
  'idx_clients_name_norm_active',
  'idx_clients_status',
  'idx_projects_client_status',
  'idx_projects_client_name_active',
  'idx_client_notes_client_at',
  'idx_matters_client',
  'idx_matters_project',
  'idx_commitments_matter',
  'idx_deliveries_matter',
]

const V20_INDEXES = ['idx_turns_seq', 'idx_facts_identity', 'idx_memory_candidates_status']

const V21_COLUMNS = [
  ['matters', 'client_id'],
  ['matters', 'project_id'],
  ['commitments', 'created_at'],
  ['deliveries', 'client_id'],
  ['deliveries', 'project_id'],
  ['deliveries', 'template_name'],
  ['deliveries', 'template_version'],
  ['deliveries', 'quote_no'],
  ['deliveries', 'data_sha256'],
]

const META_KEYS = ['schema_migrated_from', 'schema_migrated_at', 'schema_migrated_app', 'schema_migration_backup']

function hasTable(raw, name) {
  return Number(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).n) > 0
}

function columnNames(raw, table) {
  try { return raw.prepare('PRAGMA table_info(' + table + ')').all().map((row) => row.name) } catch { return [] }
}

/** Remove every schema-v21 artifact and stamp the database as genuine v20. */
export function dropV21Artifacts(raw) {
  for (const index of V21_INDEXES) raw.exec('DROP INDEX IF EXISTS ' + index)
  for (const table of ['clients', 'projects', 'client_notes']) {
    if (hasTable(raw, table)) raw.exec('DROP TABLE ' + table)
  }
  for (const [table, column] of V21_COLUMNS) {
    if (columnNames(raw, table).includes(column)) raw.exec('ALTER TABLE ' + table + ' DROP COLUMN ' + column)
  }
  if (hasTable(raw, 'schema_migrations')) raw.prepare('DELETE FROM schema_migrations WHERE version = 21').run()
  for (const key of META_KEYS) {
    try { raw.prepare('DELETE FROM meta WHERE key = ?').run(key) } catch {}
  }
  raw.prepare("UPDATE meta SET value = '20' WHERE key = 'schema_version'").run()
}

/** Turn a current (v21) database into a genuine v20 one. */
export function downgradeToV20(dbPath) {
  const raw = new DatabaseSync(dbPath)
  try { dropV21Artifacts(raw) } finally { raw.close() }
}

/** Turn a current (v21) database into a genuine v19 one. */
export function downgradeToV19(dbPath) {
  const raw = new DatabaseSync(dbPath)
  try {
    dropV21Artifacts(raw)
    for (const index of V20_INDEXES) raw.exec('DROP INDEX IF EXISTS ' + index)
    if (hasTable(raw, 'schema_migrations')) raw.exec('DROP TABLE schema_migrations')
    for (const key of META_KEYS) {
      try { raw.prepare('DELETE FROM meta WHERE key = ?').run(key) } catch {}
    }
    raw.prepare("UPDATE meta SET value = '19' WHERE key = 'schema_version'").run()
  } finally { raw.close() }
}
