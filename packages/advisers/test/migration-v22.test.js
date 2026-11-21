import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { DATA_TABLES, openReadStore, SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'
import { V22_LAYOUT, V22_MIGRATION_NAME, downgradeToV21 } from './schema-fixtures.js'

/**
 * 0.4.0 schema v22 (KB / mail / money entities) migration contract.
 *
 * The v20 and v21 steps stay pinned in migration-v20.test.js; this file pins the
 * v22 step and the new objects it owns:
 *  - a fresh database is v22, records exactly the 20/21/22 steps and installs
 *    the ten plain tables, their indexes and the two KB FTS5 indexes;
 *  - a genuine v21 fixture (current database with every v22 artifact removed)
 *    upgrades to v22, keeps every row, and leaves a verified v21 backup;
 *  - a failing v22 step rolls back atomically (no table, no FTS, no ledger row,
 *    no version bump) and the v21 database stays retryable;
 *  - reopening is idempotent: no new migration row, no second backup and no
 *    duplicated FTS rows;
 *  - verifyFtsIntegrity() covers the two KB indexes and _setupKbFts() is a real
 *    repair path; both tokenizer degradations keep the database openable;
 *  - DATA_TABLES carries the data rows (never the FTS tables or mail_cursors)
 *    and a raw export can be re-inserted into a fresh v22 database.
 *
 * Every database lives in a mkdtemp HOME; the real ~/.advisers is never opened.
 */

const NOW = '2026-11-01T00:00:00.000Z'
const STEP20 = 'incremental-writes-readonly-reads'
const STEP21 = 'client-project-entities-delivery-lineage'
const STEP22 = V22_MIGRATION_NAME

const KB_TABLES = ['kb_documents', 'kb_chunks', 'kb_fact_links', 'kb_pages']
const MAIL_TABLES = ['mail_accounts', 'mail_cursors', 'mail_messages', 'mail_sync_runs']
const MONEY_TABLES = ['receivables', 'payments']
const SAMPLE_TABLES = ['matters', 'facts', 'commitments', 'preferences', 'audit', 'clients', 'projects', 'client_notes']

function setup(prefix = 'advisers-migration-v22-') {
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

function columnNames(dbPath, table) {
  const raw = readRaw(dbPath)
  try { return raw.prepare('PRAGMA table_info(' + table + ')').all().map((row) => row.name) } finally { raw.close() }
}

function indexNames(dbPath) {
  const raw = readRaw(dbPath)
  try {
    return raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name)
  } finally { raw.close() }
}

function triggerNames(dbPath) {
  const raw = readRaw(dbPath)
  try {
    return raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((row) => row.name)
  } finally { raw.close() }
}

function metaValue(dbPath, key) {
  const raw = readRaw(dbPath)
  try { return raw.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value } finally { raw.close() }
}

function countRows(dbPath, table) {
  const raw = readRaw(dbPath)
  try {
    const present = raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).n
    if (!present) return null
    return Number(raw.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n)
  } finally { raw.close() }
}

function migrationRows(store) {
  return store.db.prepare('SELECT version, name, applied_at, duration_ms, backup_path FROM schema_migrations ORDER BY version').all()
}

function backupsIn(root) {
  return readdirSync(root).filter((name) => /^state\.db\.before-migrate-v\d+-\d+$/.test(name)).sort()
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Insert one raw row (used to seed the new tables without the 0.4 modules). */
function insertRow(store, table, row) {
  const columns = Object.keys(row)
  store.db.prepare(
    'INSERT INTO ' + table + ' (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')',
  ).run(...columns.map((column) => row[column]))
}

function seedLedger(store) {
  store.save({
    version: 1,
    matters: [{
      id: 'm1', title: '客户A', status: 'active', domain: 'consulting', secrecy: 0,
      participants: ['a'], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW, clientId: 'cl1',
    }],
    facts: [{
      id: 'f1', matterId: 'm1', subject: 'client', predicate: 'budget', object: '300万',
      recordedAt: NOW, authority: 'user', confidence: 0.9, status: 'confirmed', validFrom: NOW,
    }],
    commitments: [{
      id: 'cm1', matterId: 'm1', debtor: 'agent', creditor: 'user', action: '发报价',
      timezone: 'Asia/Shanghai', status: 'open',
      evidence: [{ sessionId: 'c1', turnId: 't1', quote: 'q' }], capability: 'none',
    }],
    preferences: [], links: [], updates: [], routines: [], routinePatches: [], routes: {},
  })
  store.addTurn({ conversationId: 'c1', role: 'user', content: '先给结论，预算总额是420万，报价单周五前发。' })
  store.appendAudit({ actor: 'local', action: 'commit.add', allowed: true, reason: 'cm1' })
}

/** A v22 seed that also has rows in the v21 and v22 tables. */
function createSeed(dbPath) {
  const store = new SqliteStore(dbPath)
  try {
    store.addClient({ id: 'cl1', name: 'ACME', secrecyDefault: 0 })
    seedLedger(store)
    insertRow(store, 'kb_documents', {
      id: 'kb1', kind: 'quote', title: '报价单', client_id: 'cl1', project_id: null, matter_id: 'm1',
      source_name: 'quote.docx', source_sha256: 'a'.repeat(64), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size_bytes: 1024, encoding: 'utf-8', extractor: 'docx', status: 'active', secrecy: 0,
      needs_ocr: 0, truncated: 0, text_bytes: 12, chunk_count: 1, safety: null, created_at: NOW, captured_at: NOW,
    })
    insertRow(store, 'kb_chunks', { id: 'chk1', doc_id: 'kb1', seq: 1, text: '季度报价单方案', char_count: 7 })
    insertRow(store, 'kb_pages', {
      id: 'page_client_cl1', kind: 'client', subject_id: 'cl1', title: '客户A 档案',
      markdown: '# 客户A', json: '{}', source_refs: '{}', inputs_sha256: 'b'.repeat(64), generated_at: NOW,
    })
    insertRow(store, 'mail_accounts', {
      id: 'acc1', name: 'INBOX', host: 'imap.example.com', port: 993, tls: 'tls',
      username: 'me@example.com', mailbox: 'INBOX', status: 'active', retention_days: 30,
      created_at: NOW, updated_at: NOW,
    })
    insertRow(store, 'mail_messages', {
      id: 'msg1', account_id: 'acc1', mailbox: 'INBOX', uid: 1, uidvalidity: '1',
      dedupe_key: 'k1', received_at: NOW, status: 'new', created_at: NOW, updated_at: NOW,
    })
    insertRow(store, 'receivables', {
      id: 'rcv1', commitment_id: 'cm1', client_id: 'cl1', amount_minor: 800000,
      currency: 'CNY', kind: 'quote', created_at: NOW, updated_at: NOW,
    })
    insertRow(store, 'payments', {
      id: 'pay1', client_id: 'cl1', commitment_id: 'cm1', amount_minor: 400000,
      currency: 'CNY', paid_at: NOW, method: 'bank', created_at: NOW, updated_at: NOW,
    })
  } finally { store.close() }
  const counts = {}
  for (const table of SAMPLE_TABLES) counts[table] = countRows(dbPath, table)
  return counts
}

function assertNoV22Artifacts(dbPath) {
  const tables = tableNames(dbPath)
  for (const table of V22_LAYOUT.tables) assert.equal(tables.has(table), false, 'v21 fixture must not have ' + table)
  for (const table of V22_LAYOUT.ftsTables) assert.equal(tables.has(table), false, 'v21 fixture must not have ' + table)
  const indexes = new Set(indexNames(dbPath))
  for (const index of V22_LAYOUT.indexes) assert.equal(indexes.has(index), false, 'v21 fixture must not have ' + index)
  const triggers = new Set(triggerNames(dbPath))
  for (const trigger of V22_LAYOUT.ftsTriggers) assert.equal(triggers.has(trigger), false, 'v21 fixture must not have ' + trigger)
  assert.equal(metaValue(dbPath, 'schema_version'), '21', 'v21 fixture stamps version 21')
}

test('fresh database: schema 22, ten new tables, their indexes, both KB FTS indexes and the migration ledger', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    try {
      assert.equal(SCHEMA_VERSION, 22)
      assert.equal(store.getMeta('schema_version'), '22')
      assert.equal(store.schemaVersion(), 22)

      const rows = migrationRows(store)
      assert.deepEqual(rows.map((row) => row.version), [20, 21, 22], 'fresh databases record every version step')
      assert.deepEqual(rows.map((row) => row.name), [STEP20, STEP21, STEP22])
      assert.equal(rows[2].backup_path, null, 'a fresh database needs no migration backup')
      assert.equal(store.getMeta('schema_migrated_from'), '0')

      const tables = tableNames(db)
      for (const table of [...KB_TABLES, ...MAIL_TABLES, ...MONEY_TABLES]) {
        assert.ok(tables.has(table), 'missing table ' + table)
      }
      const indexes = new Set(indexNames(db))
      for (const index of V22_LAYOUT.indexes) assert.ok(indexes.has(index), 'missing index ' + index)
      for (const table of V22_LAYOUT.ftsTables) assert.ok(tables.has(table), 'missing FTS table ' + table)
      const triggers = new Set(triggerNames(db))
      for (const trigger of V22_LAYOUT.ftsTriggers) assert.ok(triggers.has(trigger), 'missing FTS trigger ' + trigger)

      assert.equal(store.kbFtsTokenizer, 'trigram', 'the KB indexes default to the trigram tokenizer')
      assert.equal(store.kbFtsWarning, null)
      assert.deepEqual([...store._kbFtsTables].sort(), ['kb_fts', 'kb_pages_fts'])
      const report = store.verifyFtsIntegrity()
      assert.equal(report.ok, true, JSON.stringify(report.errors))
      assert.equal(report.state, 'ok')
      assert.deepEqual(Object.keys(report.tables).sort(), ['kb_fts', 'kb_pages_fts', 'summaries_fts', 'turns_fts'])
      assert.equal(report.kbTokenizer, 'trigram')
      assert.equal(report.tables.kb_fts.triggers.missing.length, 0)
      assert.equal(report.tables.kb_pages_fts.triggers.missing.length, 0)

      // Column shape of the frozen v22 DDL (spot-check the load-bearing ones).
      assert.deepEqual(columnNames(db, 'kb_documents'), [
        'id', 'kind', 'title', 'client_id', 'project_id', 'matter_id',
        'source_name', 'source_sha256', 'mime', 'size_bytes', 'encoding', 'extractor',
        'status', 'secrecy', 'needs_ocr', 'truncated', 'text_bytes', 'chunk_count',
        'safety', 'created_at', 'captured_at', 'deleted_at',
      ])
      for (const column of ['id', 'commitment_id', 'client_id', 'amount_minor', 'currency', 'closed_by_payment_id', 'written_off_at', 'deleted_at']) {
        assert.ok(columnNames(db, 'receivables').includes(column), 'receivables.' + column)
      }
      for (const column of ['account_id', 'mailbox', 'uidvalidity', 'last_uid', 'uidnext', 'status']) {
        assert.ok(columnNames(db, 'mail_cursors').includes(column), 'mail_cursors.' + column)
      }

      // FTS wiring is live: the triggers feed both KB indexes.
      insertRow(store, 'kb_documents', {
        id: 'kbA', kind: 'note', title: '报价说明', source_sha256: 'c'.repeat(64), size_bytes: 10,
        extractor: 'plain', status: 'active', created_at: NOW, captured_at: NOW,
      })
      insertRow(store, 'kb_chunks', { id: 'chkA', doc_id: 'kbA', seq: 1, text: '季度报价单方案', char_count: 7 })
      insertRow(store, 'kb_chunks', { id: 'chkB', doc_id: 'kbA', seq: 2, text: '预算总额四百二十万', char_count: 9 })
      insertRow(store, 'kb_pages', {
        id: 'page_facts_x', kind: 'facts', subject_id: 'client', title: '报价与预算',
        markdown: '客户预算总额四百二十万', json: '{}', source_refs: '[]',
        inputs_sha256: 'd'.repeat(64), generated_at: NOW,
      })
      const matchKb = (query) => Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_fts WHERE kb_fts MATCH ?').get(query).n)
      const matchPages = (query) => Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_pages_fts WHERE kb_pages_fts MATCH ?').get(query).n)
      assert.equal(matchKb('报价单'), 1)
      assert.equal(matchPages('预算总额'), 1)
      store.db.prepare("UPDATE kb_chunks SET text = '验收清单下周确认' WHERE id = 'chkA'").run()
      assert.equal(matchKb('报价单'), 0, 'the UPDATE trigger removes the old tokens')
      assert.equal(matchKb('验收清单'), 1, 'the UPDATE trigger adds the new tokens')
      store.db.prepare("DELETE FROM kb_chunks WHERE id = 'chkB'").run()
      assert.equal(matchKb('预算总额'), 0, 'the deleted chunk is gone from the chunk index')
      assert.equal(matchPages('预算总额'), 1, 'the page index still has its own copy')
      assert.equal(store.verifyFtsIntegrity().ok, true)
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('v22 tables carry the frozen constraints (money CHECK/UNIQUE, mail dedupe/uid uniqueness)', () => {
  const { root, db } = setup('advisers-v22-constraints-')
  try {
    const store = new SqliteStore(db)
    try {
      const insert = (table, row) => insertRow(store, table, row)
      assert.throws(() => insert('receivables', {
        id: 'rcv0', commitment_id: 'cm1', client_id: 'cl1', amount_minor: 0, currency: 'CNY',
        created_at: NOW, updated_at: NOW,
      }), /CHECK constraint failed/i, 'a receivable must be positive')
      assert.throws(() => insert('payments', {
        id: 'pay0', client_id: 'cl1', amount_minor: -1, currency: 'CNY', paid_at: NOW,
        method: 'bank', created_at: NOW, updated_at: NOW,
      }), /CHECK constraint failed/i, 'a payment must be positive')
      insert('receivables', { id: 'rcv1', commitment_id: 'cm1', client_id: 'cl1', amount_minor: 100, currency: 'CNY', created_at: NOW, updated_at: NOW })
      assert.throws(() => insert('receivables', {
        id: 'rcv2', commitment_id: 'cm1', client_id: 'cl1', amount_minor: 200, currency: 'CNY', created_at: NOW, updated_at: NOW,
      }), /UNIQUE constraint failed/i, 'one commitment can only carry one receivable')
      insert('mail_messages', {
        id: 'msg1', account_id: 'acc1', mailbox: 'INBOX', uid: 1, uidvalidity: 'v1', dedupe_key: 'd1',
        received_at: NOW, created_at: NOW, updated_at: NOW,
      })
      assert.throws(() => insert('mail_messages', {
        id: 'msg2', account_id: 'acc1', mailbox: 'INBOX', uid: 2, uidvalidity: 'v1', dedupe_key: 'd1',
        received_at: NOW, created_at: NOW, updated_at: NOW,
      }), /UNIQUE constraint failed/i, '(account_id, dedupe_key) is unique')
      assert.throws(() => insert('mail_messages', {
        id: 'msg3', account_id: 'acc1', mailbox: 'INBOX', uid: 1, uidvalidity: 'v1', dedupe_key: 'd2',
        received_at: NOW, created_at: NOW, updated_at: NOW,
      }), /UNIQUE constraint failed/i, '(account_id, mailbox, uidvalidity, uid) is unique')
      // The partial unique KB source index only covers active, non-deleted rows.
      insert('kb_documents', { id: 'kb1', kind: 'note', title: 'a', source_sha256: 'e'.repeat(64), size_bytes: 1, extractor: 'plain', created_at: NOW, captured_at: NOW })
      assert.throws(() => insert('kb_documents', {
        id: 'kb2', kind: 'note', title: 'b', source_sha256: 'e'.repeat(64), size_bytes: 1, extractor: 'plain', created_at: NOW, captured_at: NOW,
      }), /UNIQUE constraint failed/i, 'two active documents cannot share the source sha256')
      store.db.prepare("UPDATE kb_documents SET status = 'deleted', deleted_at = ? WHERE id = 'kb1'").run(NOW)
      insert('kb_documents', { id: 'kb3', kind: 'note', title: 'c', source_sha256: 'e'.repeat(64), size_bytes: 1, extractor: 'plain', created_at: NOW, captured_at: NOW })
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('v21 fixture -> v22: verified v21 backup, unchanged rows, new layout and working FTS', () => {
  const { root, db } = setup('advisers-migration-v22-upgrade-')
  try {
    const beforeCounts = createSeed(db)
    downgradeToV21(db)
    assertNoV22Artifacts(db)
    assert.equal(countRows(db, 'kb_documents'), null)
    assert.equal(metaValue(db, 'schema_version'), '21')
    const raw = readRaw(db)
    try {
      assert.deepEqual(raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version), [20, 21])
      assert.equal(Number(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'clients'").get().n), 1, 'the v21 customer table survives the fixture')
    } finally { raw.close() }

    const store = new SqliteStore(db)
    try {
      assert.equal(store.getMeta('schema_version'), '22')
      assert.equal(store.getMeta('schema_migrated_from'), '21')
      const rows = migrationRows(store)
      assert.deepEqual(rows.map((row) => row.version), [20, 21, 22], 'exactly the v22 step is appended')
      assert.equal(rows[2].name, STEP22)
      assert.match(rows[2].backup_path, /state\.db\.before-migrate-v21-\d+$/)
      assert.equal(store.getMeta('schema_migration_backup'), rows[2].backup_path)
      assert.ok(Number.isInteger(rows[2].duration_ms) && rows[2].duration_ms >= 0)
      assert.match(rows[2].applied_at, /^\d{4}-\d{2}-\d{2}T/)

      for (const table of V22_LAYOUT.tables) assert.ok(tableNames(db).has(table), 'missing table ' + table)
      const indexes = new Set(indexNames(db))
      for (const index of V22_LAYOUT.indexes) assert.ok(indexes.has(index), 'missing index ' + index)
      assert.equal(store.kbFtsTokenizer, 'trigram')
      const report = store.verifyFtsIntegrity()
      assert.equal(report.ok, true, JSON.stringify(report.errors))
      assert.equal(report.state, 'ok')

      // Migration must not rewrite existing rows.
      assert.equal(store.getCommitment('cm1').action, '发报价')
      assert.equal(store.getClient('cl1').name, 'ACME')
      assert.equal(store.searchTurns('预算总额').length, 1, 'the v19 turn index is untouched by v22')
      for (const table of SAMPLE_TABLES) {
        assert.equal(countRows(db, table), beforeCounts[table], 'row count of ' + table + ' changed during migration')
      }
      // The v22 seed rows are gone with the fixture (the fixture was downgraded
      // before the upgrade), so the new tables start empty apart from what the
      // migration itself creates.
      assert.equal(countRows(db, 'kb_documents'), 0)
      assert.equal(countRows(db, 'receivables'), 0)
    } finally { store.close() }

    const backups = backupsIn(root)
    assert.equal(backups.length, 1, 'exactly one pre-migration backup')
    assert.match(backups[0], /before-migrate-v21-/)
    const backupPath = join(root, backups[0])
    assert.ok(statSync(backupPath).size > 0)
    if (process.platform !== 'win32') assert.equal(statSync(backupPath).mode & 0o777, 0o600, 'the backup must be 0600')
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(backups[0]) && name !== backups[0]), [], 'no verification -wal/-shm sidecars are left behind')
    const backup = readRaw(backupPath)
    try {
      assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok')
      assert.equal(backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '21')
      assert.equal(Number(backup.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'kb_documents'").get().n), 0, 'the backup is the pre-v22 database')
      assert.equal(Number(backup.prepare('SELECT COUNT(*) AS n FROM commitments').get().n), 1)
      for (const table of SAMPLE_TABLES) {
        assert.equal(Number(backup.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n), beforeCounts[table], 'backup ' + table + ' count')
      }
    } finally { backup.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a failed v22 step rolls back atomically and leaves the v21 database retryable', () => {
  const { root, db } = setup('advisers-migration-v22-fail-')
  try {
    const beforeCounts = createSeed(db)
    downgradeToV21(db)
    const original = SqliteStore.prototype._runMigrationStep
    SqliteStore.prototype._runMigrationStep = function (step) {
      if (step.version === 22) throw new Error('injected v22 step failure')
      return original.call(this, step)
    }
    try {
      assert.throws(() => new SqliteStore(db), /injected v22 step failure/)
    } finally {
      SqliteStore.prototype._runMigrationStep = original
    }
    assert.equal(metaValue(db, 'schema_version'), '21', 'DDL, FTS and the version stamp roll back together')
    const tables = tableNames(db)
    for (const table of V22_LAYOUT.tables) assert.equal(tables.has(table), false, 'no half-created table may survive: ' + table)
    for (const table of V22_LAYOUT.ftsTables) assert.equal(tables.has(table), false, 'no half-created FTS table may survive: ' + table)
    assert.equal(Number(readRawCount(db, 'schema_migrations', 'version', 22)), 0, 'the v22 ledger row rolls back')
    assert.equal(backupsIn(root).length, 1, 'the verified backup is kept after a failed step')
    for (const table of SAMPLE_TABLES) assert.equal(countRows(db, table), beforeCounts[table])

    const retry = new SqliteStore(db)
    try {
      assert.equal(retry.getMeta('schema_version'), '22')
      assert.deepEqual(migrationRows(retry).map((row) => row.version), [20, 21, 22])
      for (const table of V22_LAYOUT.tables) assert.ok(tableNames(db).has(table), 'missing table ' + table)
      assert.equal(retry.verifyFtsIntegrity().ok, true)
    } finally { retry.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function readRawCount(dbPath, table, column, value) {
  const raw = readRaw(dbPath)
  try { return Number(raw.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE ' + column + ' = ?').get(value).n) } finally { raw.close() }
}

test('reopening is idempotent: no migration row, no second backup, no duplicated FTS rows', () => {
  const { root, db } = setup('advisers-migration-v22-reopen-')
  try {
    const seed = new SqliteStore(db)
    try {
      insertRow(seed, 'kb_documents', { id: 'kb1', kind: 'note', title: 'a', source_sha256: 'f'.repeat(64), size_bytes: 1, extractor: 'plain', created_at: NOW, captured_at: NOW })
      insertRow(seed, 'kb_chunks', { id: 'chk1', doc_id: 'kb1', seq: 1, text: '季度报价单方案', char_count: 7 })
    } finally { seed.close() }
    downgradeToV21(db)
    const first = new SqliteStore(db)
    const firstRows = migrationRows(first)
    const firstIndexBytes = () => Number(first.db.prepare('SELECT COUNT(*) AS n FROM kb_fts_docsize').get().n)
    assert.equal(firstIndexBytes(), 0, 'the fixture had no KB rows left')
    first.close()
    const backupCount = backupsIn(root).length
    assert.equal(backupCount, 1)

    const second = new SqliteStore(db)
    try {
      assert.deepEqual(migrationRows(second), firstRows, 'a plain reopen must not add a migration row')
      assert.equal(second.getMeta('schema_version'), '22')
      assert.equal(backupsIn(root).length, backupCount, 'a plain reopen must not take another backup')
      insertRow(second, 'kb_chunks', { id: 'chk2', doc_id: 'kb1', seq: 2, text: '预算总额四百二十万', char_count: 9 })
      assert.equal(Number(second.db.prepare('SELECT COUNT(*) AS n FROM kb_fts_docsize').get().n), 1, 'trigger indexing is not duplicated')
    } finally { second.close() }
    const third = new SqliteStore(db)
    try {
      assert.equal(third.verifyFtsIntegrity().ok, true)
      assert.equal(Number(third.db.prepare('SELECT COUNT(*) AS n FROM kb_fts_docsize').get().n), 1, 'no rebuild/duplication on reopen')
      assert.equal(backupsIn(root).length, backupCount)
    } finally { third.close() }

    // A fresh database reopens without a backup as well.
    const fresh = setup('advisers-fresh-v22-reopen-')
    try {
      const created = new SqliteStore(fresh.db)
      const createdRows = migrationRows(created)
      created.close()
      const reopened = new SqliteStore(fresh.db)
      try {
        assert.deepEqual(migrationRows(reopened), createdRows)
        assert.equal(reopened.getMeta('schema_version'), '22')
      } finally { reopened.close() }
      assert.deepEqual(backupsIn(fresh.root), [], 'fresh databases never need a migration backup')
    } finally { rmSync(fresh.root, { recursive: true, force: true }) }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('verifyFtsIntegrity covers both KB indexes and _setupKbFts is a working repair path', () => {
  const { root, db } = setup('advisers-v22-fts-integrity-')
  try {
    const store = new SqliteStore(db)
    try {
      insertRow(store, 'kb_documents', { id: 'kb1', kind: 'note', title: 'a', source_sha256: '1'.repeat(64), size_bytes: 1, extractor: 'plain', created_at: NOW, captured_at: NOW })
      insertRow(store, 'kb_chunks', { id: 'chk1', doc_id: 'kb1', seq: 1, text: '季度报价单方案', char_count: 7 })
      insertRow(store, 'kb_chunks', { id: 'chk2', doc_id: 'kb1', seq: 2, text: '预算总额四百二十万', char_count: 9 })
      insertRow(store, 'kb_pages', {
        id: 'page_client_x', kind: 'client', subject_id: 'cl1', title: '客户档案',
        markdown: '# 客户档案', json: '{}', source_refs: '[]', inputs_sha256: '2'.repeat(64), generated_at: NOW,
      })
      assert.equal(store.verifyFtsIntegrity().ok, true)

      // Desync both KB indexes without touching the turn indexes.
      store.db.exec('DROP TRIGGER kb_chunks_ai')
      insertRow(store, 'kb_chunks', { id: 'chk3', doc_id: 'kb1', seq: 3, text: '验收清单下周确认', char_count: 9 })
      store.db.exec('DROP TRIGGER kb_pages_au')
      store.db.prepare("UPDATE kb_pages SET markdown = '# 客户档案 验收清单' WHERE id = 'page_client_x'").run()

      const report = store.verifyFtsIntegrity()
      assert.equal(report.ok, false)
      assert.equal(report.state, 'inconsistent')
      assert.deepEqual(report.tables.kb_fts.triggers.missing, ['kb_chunks_ai'])
      assert.deepEqual(report.tables.kb_pages_fts.triggers.missing, ['kb_pages_au'])
      assert.equal(report.tables.kb_fts.countMismatch, true)
      assert.deepEqual(report.tables.kb_fts.sample.missingFromIndex, [3], 'the unindexed chunk rowid is reported')
      assert.ok(report.errors.some((line) => /kb_fts: missing FTS sync trigger/.test(line)))
      assert.match(report.repair, /audit --rebuild-fts/)
      assert.equal(store._ftsBroken, true)
      assert.equal(report.tables.turns_fts.integrityCheck, 'ok', 'the turn index itself was never touched')

      // The repair the CLI runs (rebuildAllFtsIndexes is the single entry point
      // proposed for bin's audit --rebuild-fts / doctor --repair): recreate all
      // four indexes and re-index from the source tables (no source files).
      let tokenizers
      store.db.exec('BEGIN IMMEDIATE')
      try {
        tokenizers = store.rebuildAllFtsIndexes()
        store.db.exec('COMMIT')
      } catch (error) {
        try { store.db.exec('ROLLBACK') } catch {}
        throw error
      }
      assert.deepEqual(tokenizers, { turns: 'trigram', kb: 'trigram' })
      const repaired = store.verifyFtsIntegrity()
      assert.equal(repaired.ok, true, JSON.stringify(repaired.errors))
      assert.equal(repaired.state, 'ok')
      assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_fts WHERE kb_fts MATCH ?').get('验收清单').n), 1)
      assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_pages_fts WHERE kb_pages_fts MATCH ?').get('验收清单').n), 1)
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('KB FTS degrades like the v19 indexes: trigram -> unicode61 -> LIKE-only, open never fails', () => {
  const originalKbCreate = SqliteStore.prototype._createKbFts
  const originalTurnCreate = SqliteStore.prototype._createFts
  const originalWarn = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    // 1) This build has no trigram tokenizer for the KB DDL: unicode61 fallback.
    const unicode = setup('advisers-v22-fts-unicode-')
    SqliteStore.prototype._createKbFts = function createKbFts(tokenizer) {
      if (tokenizer === 'trigram') throw new Error('no such tokenizer: trigram')
      return originalKbCreate.call(this, tokenizer)
    }
    let store
    try {
      store = new SqliteStore(unicode.db)
    } finally {
      SqliteStore.prototype._createKbFts = originalKbCreate
    }
    try {
      assert.equal(store.kbFtsTokenizer, 'unicode61', 'degrades to the legacy tokenizer')
      assert.match(store.kbFtsWarning, /trigram tokenizer unavailable/i)
      assert.match(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kb_fts'").get().sql, /content='kb_chunks'/i)
      assert.doesNotMatch(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kb_fts'").get().sql, /trigram/i)
      assert.equal(store.verifyFtsIntegrity().ok, true, 'a degraded but consistent index is ok')
      insertRow(store, 'kb_documents', { id: 'kb1', kind: 'note', title: 'a', source_sha256: '3'.repeat(64), size_bytes: 1, extractor: 'plain', created_at: NOW, captured_at: NOW })
      insertRow(store, 'kb_chunks', { id: 'chk1', doc_id: 'kb1', seq: 1, text: '季度报价单方案', char_count: 7 })
      assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM kb_fts WHERE kb_fts MATCH ?').get('报价单').n), 0, 'unicode61 cannot match the CJK substring')
    } finally {
      store.close()
      rmSync(unicode.root, { recursive: true, force: true })
    }

    // 2) FTS5 itself is absent: the database still opens and the schema still
    // advances to v22 (so the migration is not retried on every open).
    const none = setup('advisers-v22-fts-none-')
    const boom = () => { throw new Error('FTS5 is unavailable in this SQLite build') }
    SqliteStore.prototype._createFts = boom
    SqliteStore.prototype._createKbFts = boom
    try {
      store = new SqliteStore(none.db)
    } finally {
      SqliteStore.prototype._createFts = originalTurnCreate
      SqliteStore.prototype._createKbFts = originalKbCreate
    }
    try {
      assert.equal(store.getMeta('schema_version'), '22', 'the version advances even without FTS5')
      assert.equal(store.ftsTokenizer, null)
      assert.equal(store.kbFtsTokenizer, null)
      assert.match(store.ftsWarning, /FTS5 is unavailable/i)
      assert.match(store.kbFtsWarning, /FTS5 is unavailable/i)
      assert.equal(store.verifyFtsIntegrity().state, 'degraded')
      assert.equal(store.verifyFtsIntegrity().ok, true, 'LIKE-only degradation is reported but not a failure')
      store.addTurn({ conversationId: 'c1', role: 'user', content: '重开前的报价单' })
      assert.equal(store.searchTurns('报价单').length, 1, 'search still answers through the LIKE backstop')
    } finally {
      store.close()
      rmSync(none.root, { recursive: true, force: true })
    }

    // 3) The operator override forces the legacy tokenizer for both index pairs.
    const saved = process.env.ADVISERS_FTS_TOKENIZER
    process.env.ADVISERS_FTS_TOKENIZER = 'unicode61'
    const forced = setup('advisers-v22-fts-forced-')
    try {
      store = new SqliteStore(forced.db)
      assert.equal(store.ftsTokenizer, 'unicode61')
      assert.equal(store.kbFtsTokenizer, 'unicode61')
      assert.match(store.kbFtsWarning, /unicode61/)
      assert.equal(store.verifyFtsIntegrity().ok, true)
    } finally {
      if (store) store.close()
      if (saved === undefined) delete process.env.ADVISERS_FTS_TOKENIZER
      else process.env.ADVISERS_FTS_TOKENIZER = saved
      rmSync(forced.root, { recursive: true, force: true })
    }
    assert.ok(warnings.some((line) => /trigram tokenizer unavailable/i.test(line)), 'the degradation prints a warning line')
  } finally {
    SqliteStore.prototype._createKbFts = originalKbCreate
    SqliteStore.prototype._createFts = originalTurnCreate
    console.warn = originalWarn
  }
})

test('openReadStore: a v21 database is E_SCHEMA_STALE, a migrated v22 database reads lock-free', () => {
  const { root, db } = setup('advisers-v22-read-path-')
  try {
    const seed = new SqliteStore(db)
    seed.addTurn({ conversationId: 'c1', role: 'user', content: '只读路径的报价单' })
    seed.close()
    downgradeToV21(db)
    assert.throws(() => openReadStore(db), (error) => {
      assert.equal(error.code, 'E_SCHEMA_STALE')
      assert.match(error.message, /advisers doctor/)
      return true
    })
    const migrated = new SqliteStore(db)
    try { assert.equal(migrated.getMeta('schema_version'), '22') } finally { migrated.close() }
    const reader = openReadStore(db)
    try {
      assert.equal(reader.schemaVersion(), 22)
      assert.equal(reader.searchTurns('报价单').length, 1, 'the lock-free read path sees the v22 data')
      assert.equal(reader.kbFtsTokenizer, 'trigram', 'the read-only open discovers the KB index shape')
      // FTS 'integrity-check' writes an internal row, so it is a maintenance
      // (writable) connection concern; a read-only open only reports the shape.
      assert.throws(() => reader.addTurn({ conversationId: 'c1', role: 'user', content: 'x' }), (error) => error.code === 'E_READ_ONLY')
    } finally { reader.close() }

    // A future schema is refused and never touched by a read open.
    const raw = new DatabaseSync(db)
    raw.prepare("UPDATE meta SET value = '23' WHERE key = 'schema_version'").run()
    raw.close()
    const before = fileHash(db)
    assert.throws(() => openReadStore(db), (error) => error.code === 'E_SCHEMA_NEWER')
    assert.equal(fileHash(db), before, 'a refused future schema must not change any byte')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('DATA_TABLES export/import parity: the data rows round-trip, FTS and mail_cursors never travel', () => {
  const source = setup('advisers-v22-export-src-')
  const target = setup('advisers-v22-export-dst-')
  try {
    const from = new SqliteStore(source.db)
    let exported
    try {
      insertRow(from, 'kb_documents', { id: 'kb1', kind: 'note', title: 'a', source_sha256: '4'.repeat(64), size_bytes: 1, extractor: 'plain', created_at: NOW, captured_at: NOW })
      insertRow(from, 'kb_chunks', { id: 'chk1', doc_id: 'kb1', seq: 1, text: '季度报价单方案', char_count: 7 })
      insertRow(from, 'kb_fact_links', { fact_id: 'f1', doc_id: 'kb1', chunk_id: 'chk1', relation: 'source', created_at: NOW })
      insertRow(from, 'kb_pages', { id: 'page_client_cl1', kind: 'client', subject_id: 'cl1', title: 'a', markdown: 'm', json: '{}', source_refs: '[]', inputs_sha256: '5'.repeat(64), generated_at: NOW })
      insertRow(from, 'mail_accounts', { id: 'acc1', name: 'INBOX', host: 'h', port: 993, tls: 'tls', username: 'u', created_at: NOW, updated_at: NOW })
      insertRow(from, 'mail_cursors', { account_id: 'acc1', mailbox: 'INBOX', last_uid: 42, updated_at: NOW })
      insertRow(from, 'mail_messages', { id: 'msg1', account_id: 'acc1', mailbox: 'INBOX', uid: 1, dedupe_key: 'k1', received_at: NOW, created_at: NOW, updated_at: NOW })
      insertRow(from, 'mail_sync_runs', { id: 'run1', account_id: 'acc1', mailbox: 'INBOX', started_at: NOW, status: 'ok' })
      insertRow(from, 'receivables', { id: 'rcv1', commitment_id: 'cm1', client_id: 'cl1', amount_minor: 100, currency: 'CNY', created_at: NOW, updated_at: NOW })
      insertRow(from, 'payments', { id: 'pay1', client_id: 'cl1', amount_minor: 100, currency: 'CNY', paid_at: NOW, method: 'bank', created_at: NOW, updated_at: NOW })

      assert.ok(DATA_TABLES.includes('kb_pages'), 'kb_pages is a data table and must be exportable')
      for (const table of ['mail_cursors', 'kb_fts', 'kb_pages_fts']) {
        assert.equal(DATA_TABLES.includes(table), false, table + ' must never be exported')
        assert.throws(() => from.exportDataTables([table]), /unknown export table/, table + ' must not be exportable directly')
      }
      assert.deepEqual(Object.keys(from.exportDataTables()), [...DATA_TABLES])
      exported = from.exportDataTables([
        'kb_documents', 'kb_chunks', 'kb_fact_links', 'kb_pages',
        'mail_accounts', 'mail_messages', 'mail_sync_runs', 'receivables', 'payments',
      ])
      for (const table of Object.keys(exported)) assert.equal(exported[table].length, 1, 'export ' + table)
      assert.equal('mail_cursors' in exported, false)
      assert.equal('kb_fts' in exported, false)
    } finally { from.close() }

    const to = new SqliteStore(target.db)
    try {
      for (const [table, rows] of Object.entries(exported)) for (const row of rows) insertRow(to, table, row)
      for (const [table, rows] of Object.entries(exported)) {
        assert.deepEqual(to.exportDataTables([table])[table], rows, 'round-trip of ' + table)
      }
      assert.equal(countRows(target.db, 'mail_cursors'), 0, 'mail_cursors is local sync state, never imported')
      assert.equal(to.verifyFtsIntegrity().ok, true, 'importing KB rows feeds the FTS triggers')
      assert.equal(Number(to.db.prepare('SELECT COUNT(*) AS n FROM kb_fts WHERE kb_fts MATCH ?').get('报价单').n), 1)
    } finally { to.close() }
  } finally {
    rmSync(source.root, { recursive: true, force: true })
    rmSync(target.root, { recursive: true, force: true })
  }
})

test('load() stays the nine-table wire ledger: no KB/mail/money table leaks into a LedgerSnapshot', () => {
  const { root, db } = setup('advisers-v22-snapshot-')
  try {
    const store = new SqliteStore(db)
    try {
      seedLedger(store)
      const snapshot = store.load()
      assert.deepEqual(Object.keys(snapshot).sort(), ['commitments', 'facts', 'links', 'matters', 'preferences', 'routinePatches', 'routines', 'routes', 'updates', 'version'].sort())
      for (const table of [...KB_TABLES, ...MAIL_TABLES, ...MONEY_TABLES]) {
        assert.equal(table in snapshot, false, table + ' must not be part of the wire snapshot')
      }
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
