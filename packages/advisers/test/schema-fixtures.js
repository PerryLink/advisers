import { DatabaseSync } from 'node:sqlite'

/**
 * Shared schema fixtures for the v19/v20/v21 migration tests (0.3.0 and 0.4.0).
 *
 * A genuine v20 database is a v21 one with every v21 artifact removed, and a
 * genuine v21 database is the current one (v22) with every v22 artifact
 * removed. Downgrading through SQLite (not by copying a fixture file) keeps the
 * fixtures honest: the upgrade then really has to add what it claims to add,
 * and the rollback path is exercised against the same bytes an older install
 * would have.
 *
 * SQLite has no DROP COLUMN IF EXISTS either, so every helper checks
 * sqlite_master first and is safe on a partially-built database.
 */

// v22 (0.4.0 KB/mail/money): everything the v22 migration adds on top of v21.
// The two FTS virtual tables, their six triggers and their shadow tables are
// dropped before the plain tables; the KB indexes are plain (non-unique
// autoindexes on kb_chunks/kb_pages live in those tables and go with them).
const V22_TABLES = [
  'kb_documents', 'kb_chunks', 'kb_fact_links', 'kb_pages',
  'mail_accounts', 'mail_cursors', 'mail_messages', 'mail_sync_runs',
  'receivables', 'payments',
]
const V22_FTS_TABLES = ['kb_fts', 'kb_pages_fts']
const V22_FTS_TRIGGERS = [
  'kb_chunks_ai', 'kb_chunks_ad', 'kb_chunks_au',
  'kb_pages_ai', 'kb_pages_ad', 'kb_pages_au',
]
const V22_INDEXES = [
  'idx_kb_source_active',
  'idx_kb_source_unique',
  'idx_kb_client_status',
  'idx_kb_matter_status',
  'idx_kb_chunks_doc',
  'idx_kb_fact_links_fact',
  'idx_kb_pages_kind',
  'idx_mail_dedupe',
  'idx_mail_uid',
  'idx_mail_client',
  'idx_receivables_client',
  'idx_payments_client_day',
  'idx_payments_commitment',
]

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

/** Name of the v22 step, pinned here so the migration expectations agree. */
export const V22_MIGRATION_NAME = 'kb-mail-payment-entities'

/** Tables/indexes asserted by the v21 -> v22 migration test. */
export const V22_LAYOUT = Object.freeze({
  tables: V22_TABLES.slice(),
  ftsTables: V22_FTS_TABLES.slice(),
  ftsTriggers: V22_FTS_TRIGGERS.slice(),
  indexes: V22_INDEXES.slice(),
})

function hasTable(raw, name) {
  return Number(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).n) > 0
}

function columnNames(raw, table) {
  try { return raw.prepare('PRAGMA table_info(' + table + ')').all().map((row) => row.name) } catch { return [] }
}

/** Remove every schema-v22 artifact and stamp the database as genuine v21. */
export function dropV22Artifacts(raw) {
  for (const trigger of V22_FTS_TRIGGERS) raw.exec('DROP TRIGGER IF EXISTS ' + trigger)
  for (const table of V22_FTS_TABLES) raw.exec('DROP TABLE IF EXISTS ' + table)
  for (const index of V22_INDEXES) raw.exec('DROP INDEX IF EXISTS ' + index)
  for (const table of V22_TABLES) {
    if (hasTable(raw, table)) raw.exec('DROP TABLE ' + table)
  }
  if (hasTable(raw, 'schema_migrations')) raw.prepare('DELETE FROM schema_migrations WHERE version = 22').run()
  raw.prepare("UPDATE meta SET value = '21' WHERE key = 'schema_version'").run()
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

/** Turn a current (v22) database into a genuine v21 one. */
export function downgradeToV21(dbPath) {
  const raw = new DatabaseSync(dbPath)
  try { dropV22Artifacts(raw) } finally { raw.close() }
}

/** Turn a current (v22) database into a genuine v20 one. */
export function downgradeToV20(dbPath) {
  const raw = new DatabaseSync(dbPath)
  try {
    dropV22Artifacts(raw)
    dropV21Artifacts(raw)
  } finally { raw.close() }
}

/** Turn a current (v22) database into a genuine v19 one. */
export function downgradeToV19(dbPath) {
  const raw = new DatabaseSync(dbPath)
  try {
    dropV22Artifacts(raw)
    dropV21Artifacts(raw)
    for (const index of V20_INDEXES) raw.exec('DROP INDEX IF EXISTS ' + index)
    if (hasTable(raw, 'schema_migrations')) raw.exec('DROP TABLE schema_migrations')
    for (const key of META_KEYS) {
      try { raw.prepare('DELETE FROM meta WHERE key = ?').run(key) } catch {}
    }
    raw.prepare("UPDATE meta SET value = '19' WHERE key = 'schema_version'").run()
  } finally { raw.close() }
}
