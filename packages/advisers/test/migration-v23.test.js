import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { DATA_TABLES, openReadStore, SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'
import {
  downgradeToV22,
  V23_LAYOUT,
  V23_MIGRATION_NAME,
} from './schema-fixtures.js'

/**
 * 0.5.1 schema v23 (memory claim fields + mail threading + handoff/followup
 * sidecars) migration contract. The v20/v21 steps stay pinned in
 * migration-v20.test.js and the v22 step in migration-v22.test.js; this file
 * pins the single v23 hop that merges 91 §4 (facts claim/quote columns +
 * handoffs/handoff_claims) and 92 §4 (mail threading columns + waiting_replies),
 * plus the 207 A10 reserved acceptance/payment-proof columns:
 *  - a fresh database is v23, records exactly the 20/21/22/23 steps, and its
 *    layout is byte-identical to an upgraded v22 database;
 *  - a genuine v22 fixture (current database with every v23 artifact removed)
 *    upgrades to v23, keeps every row, backfills only the declared defaults
 *    (direction='unknown', valid_time_unknown=0) and leaves a verified v22
 *    backup;
 *  - a failing v23 step rolls back atomically (no table, column, index, ledger
 *    row or version bump) and the v22 database stays retryable;
 *  - reopening is idempotent: no new migration row and no second backup;
 *  - a future schema is refused with E_SCHEMA_NEWER and never modified;
 *  - DATA_TABLES carries the v23 sidecars and a raw export round-trips.
 *
 * Every database lives in a mkdtemp HOME; the real ~/.advisers is never opened.
 */

const NOW = '2026-11-01T00:00:00.000Z'
const STEP23 = V23_MIGRATION_NAME
const BIN = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

/** Spawn the real CLI against a throwaway HOME (integration, not unit). */
function runCli(home, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    env: {
      ...process.env,
      ADVISERS_HOME: home,
      ADVISERS_CORE_LOCAL: '1',
      ADVISERS_OFFICE_LOCAL: '1',
      ADVISERS_NO_MODEL: '1',
      ADVISERS_ACCEPT_TOS: '1',
    },
    encoding: 'utf8',
    timeout: 120000,
  })
  assert.equal(result.status, 0, 'advisers ' + args.join(' ') + ' exited ' + result.status + ': ' + (result.stderr || result.stdout).slice(0, 400))
  return result
}

function setup(prefix = 'advisers-migration-v23-') {
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
  try { return new Set(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name)) } finally { raw.close() }
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

/** Insert one raw row; identifiers are quoted (mail_messages."references"). */
function insertRow(store, table, row) {
  const columns = Object.keys(row)
  const names = columns.map((column) => '"' + column + '"')
  store.db.prepare(
    'INSERT INTO ' + table + ' (' + names.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')',
  ).run(...columns.map((column) => row[column]))
}

/** Seed a current (v23) database with v22-era rows in the tables v23 touches. */
function createSeed(dbPath) {
  const store = new SqliteStore(dbPath)
  try {
    store.save({
      version: 1,
      matters: [{
        id: 'm1', title: '客户A', status: 'active', domain: 'consulting', secrecy: 0,
        participants: ['a'], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW,
      }],
      facts: [{
        id: 'f1', matterId: 'm1', subject: 'client', predicate: 'budget', object: '300万',
        recordedAt: NOW, authority: 'user', confidence: 0.9, status: 'confirmed', validFrom: NOW,
      }],
      commitments: [],
      preferences: [], links: [], updates: [], routines: [], routinePatches: [], routes: {},
    })
    insertRow(store, 'mail_messages', {
      id: 'msg1', account_id: 'acc1', mailbox: 'INBOX', uid: 1, uidvalidity: '1',
      message_id: '<m1@example.com>', dedupe_key: 'k1', from_addr: 'client@example.com',
      subject: '报价确认', sent_at: NOW, received_at: NOW, size_bytes: 100,
      body_text: '正文', body_sha256: 'c'.repeat(64), status: 'new', created_at: NOW, updated_at: NOW,
    })
    insertRow(store, 'deliveries', {
      id: 'd1', matter_id: 'm1', conversation_id: 'c1', files: '[]', created_at: NOW,
      client_id: 'cl1', project_id: null, template_name: 'quote', template_version: '1',
      quote_no: 'Q-1', data_sha256: 'd'.repeat(64),
    })
    insertRow(store, 'payments', {
      id: 'pay1', client_id: 'cl1', commitment_id: null, amount_minor: 100, currency: 'CNY',
      paid_at: NOW, method: 'bank', created_at: NOW, updated_at: NOW,
    })
  } finally { store.close() }
  const facts = readRaw(dbPath)
  try {
    assert.equal(Number(facts.prepare('SELECT COUNT(*) AS n FROM facts').get().n), 1)
  } finally { facts.close() }
}

function assertNoV23Artifacts(dbPath) {
  const tables = tableNames(dbPath)
  for (const table of V23_LAYOUT.tables) assert.equal(tables.has(table), false, 'v22 fixture must not have ' + table)
  const indexes = indexNames(dbPath)
  for (const index of V23_LAYOUT.indexes) assert.equal(indexes.has(index), false, 'v22 fixture must not have ' + index)
  for (const column of V23_LAYOUT.factsColumns) assert.equal(columnNames(dbPath, 'facts').includes(column), false, 'v22 fixture must not have facts.' + column)
  for (const column of V23_LAYOUT.mailColumns) assert.equal(columnNames(dbPath, 'mail_messages').includes(column), false, 'v22 fixture must not have mail_messages.' + column)
  for (const column of V23_LAYOUT.deliveriesColumns) assert.equal(columnNames(dbPath, 'deliveries').includes(column), false, 'v22 fixture must not have deliveries.' + column)
  for (const column of V23_LAYOUT.paymentsColumns) assert.equal(columnNames(dbPath, 'payments').includes(column), false, 'v22 fixture must not have payments.' + column)
  assert.equal(metaValue(dbPath, 'schema_version'), '22', 'v22 fixture stamps version 22')
}

/** PRAGMA table_info shape for the tables v23 creates or extends. */
function tableShape(dbPath, table) {
  const raw = readRaw(dbPath)
  try {
    return raw.prepare('PRAGMA table_info(' + table + ')').all().map((row) => ({
      name: row.name, type: row.type, notnull: row.notnull, dflt_value: row.dflt_value, pk: row.pk,
    }))
  } finally { raw.close() }
}

const V23_SHAPE_TABLES = ['facts', 'mail_messages', 'deliveries', 'payments', ...V23_LAYOUT.tables].sort()

test('fresh database: schema 23, the v23 step, its tables/columns/indexes and the declared defaults', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    try {
      assert.equal(SCHEMA_VERSION, 23)
      assert.equal(store.getMeta('schema_version'), '23')
      assert.equal(store.schemaVersion(), 23)
      assert.deepEqual(migrationRows(store).map((row) => row.version), [20, 21, 22, 23])
      assert.deepEqual(migrationRows(store).map((row) => row.name), [
        'incremental-writes-readonly-reads',
        'client-project-entities-delivery-lineage',
        'kb-mail-payment-entities',
        STEP23,
      ])
      assert.equal(store.getMeta('schema_migrated_from'), '0')
      assert.equal(store.getMeta('schema_migration_backup'), undefined, 'a fresh database needs no backup')
    } finally { store.close() }

    const tables = tableNames(db)
    for (const table of V23_LAYOUT.tables) assert.ok(tables.has(table), 'missing table ' + table)
    for (const table of V23_LAYOUT.tables) assert.deepEqual(
      columnNames(db, table),
      table === 'waiting_replies' ? V23_LAYOUT.waitingRepliesColumns
        : table === 'handoffs' ? V23_LAYOUT.handoffsColumns
          : V23_LAYOUT.handoffClaimsColumns,
      'column order of ' + table,
    )
    for (const index of V23_LAYOUT.indexes) assert.ok(indexNames(db).has(index), 'missing index ' + index)
    for (const column of V23_LAYOUT.factsColumns) assert.ok(columnNames(db, 'facts').includes(column), 'missing facts.' + column)
    for (const column of V23_LAYOUT.mailColumns) assert.ok(columnNames(db, 'mail_messages').includes(column), 'missing mail_messages.' + column)
    for (const column of V23_LAYOUT.deliveriesColumns) assert.ok(columnNames(db, 'deliveries').includes(column), 'missing deliveries.' + column)
    for (const column of V23_LAYOUT.paymentsColumns) assert.ok(columnNames(db, 'payments').includes(column), 'missing payments.' + column)

    // Declared defaults are part of the contract: an old mail row is never
    // guessed as inbound/outbound, and unknown valid time is an explicit 0.
    const raw = new DatabaseSync(db)
    try {
      const mail = Object.fromEntries(raw.prepare('PRAGMA table_info(mail_messages)').all().map((row) => [row.name, row]))
      assert.equal(mail.direction.notnull, 1)
      assert.equal(mail.direction.dflt_value, "'unknown'")
      const facts = Object.fromEntries(raw.prepare('PRAGMA table_info(facts)').all().map((row) => [row.name, row]))
      assert.equal(facts.valid_time_unknown.notnull, 1)
      assert.equal(facts.valid_time_unknown.dflt_value, '0')
      for (const column of ['conditions', 'polarity', 'modality', 'revision_intent', 'quote_source_kind', 'quote_source_id', 'quote_char_start', 'quote_char_end']) {
        assert.equal(facts[column].notnull, 0, column + ' must stay nullable')
      }
    } finally { raw.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a fresh v23 layout and an upgraded v22 layout converge on the same shape', () => {
  const fresh = setup('advisers-v23-shape-fresh-')
  const upgraded = setup('advisers-v23-shape-upgraded-')
  try {
    const freshStore = new SqliteStore(fresh.db)
    freshStore.close()

    const seedStore = new SqliteStore(upgraded.db)
    insertRow(seedStore, 'mail_messages', {
      id: 'msg1', account_id: 'acc1', mailbox: 'INBOX', uid: 1, dedupe_key: 'k1', received_at: NOW,
      status: 'new', created_at: NOW, updated_at: NOW,
    })
    seedStore.close()
    downgradeToV22(upgraded.db)
    assertNoV23Artifacts(upgraded.db)
    const migrated = new SqliteStore(upgraded.db)
    migrated.close()

    for (const table of V23_SHAPE_TABLES) {
      assert.deepEqual(tableShape(upgraded.db, table), tableShape(fresh.db, table), 'shape of ' + table + ' must converge')
    }
    assert.deepEqual([...indexNames(upgraded.db)].sort(), [...indexNames(fresh.db)].sort(), 'index set must converge')
  } finally {
    rmSync(fresh.root, { recursive: true, force: true })
    rmSync(upgraded.root, { recursive: true, force: true })
  }
})

test('v22 fixture -> v23: verified v22 backup, unchanged rows, backfilled defaults and new layout', () => {
  const { root, db } = setup('advisers-migration-v23-upgrade-')
  try {
    createSeed(db)
    downgradeToV22(db)
    assertNoV23Artifacts(db)
    assert.equal(countRows(db, 'mail_messages'), 1, 'the v22 fixture keeps its mail row')
    assert.equal(countRows(db, 'facts'), 1)
    const raw = readRaw(db)
    try {
      assert.deepEqual(raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version), [20, 21, 22])
    } finally { raw.close() }

    const store = new SqliteStore(db)
    try {
      assert.equal(store.getMeta('schema_version'), '23')
      assert.equal(store.getMeta('schema_migrated_from'), '22')
      const rows = migrationRows(store)
      assert.deepEqual(rows.map((row) => row.version), [20, 21, 22, 23], 'exactly the v23 step is appended')
      assert.equal(rows[3].name, STEP23)
      assert.match(rows[3].backup_path, /state\.db\.before-migrate-v22-\d+$/)
      assert.equal(store.getMeta('schema_migration_backup'), rows[3].backup_path)
      assert.ok(Number.isInteger(rows[3].duration_ms) && rows[3].duration_ms >= 0)
      assert.match(rows[3].applied_at, /^\d{4}-\d{2}-\d{2}T/)

      for (const table of V23_LAYOUT.tables) assert.ok(tableNames(db).has(table), 'missing table ' + table)
      for (const index of V23_LAYOUT.indexes) assert.ok(indexNames(db).has(index), 'missing index ' + index)

      // No backfill: rows keep their data, only the declared defaults appear.
      const mail = store.db.prepare('SELECT * FROM mail_messages WHERE id = ?').get('msg1')
      assert.equal(mail.from_addr, 'client@example.com')
      assert.equal(mail.thread_root, null, 'the migration must not guess a thread root')
      assert.equal(mail.in_reply_to, null)
      assert.equal(mail.references, null)
      assert.equal(mail.direction, 'unknown')
      assert.equal(mail.auto_submitted, null)
      const fact = store.db.prepare('SELECT * FROM facts WHERE id = ?').get('f1')
      assert.equal(fact.object, '300万')
      assert.equal(fact.valid_time_unknown, 0)
      assert.equal(fact.conditions, null)
      assert.equal(fact.polarity, null)
      const delivery = store.db.prepare('SELECT * FROM deliveries WHERE id = ?').get('d1')
      assert.equal(delivery.title, null)
      assert.equal(delivery.accepted_at, null)
      assert.equal(delivery.accepted_by, null)
      assert.equal(delivery.accept_method, null)
      assert.equal(delivery.accept_evidence_ref, null)
      const payment = store.db.prepare('SELECT * FROM payments WHERE id = ?').get('pay1')
      assert.equal(payment.amount_minor, 100)
      assert.equal(payment.proof_sha256, null)
    } finally { store.close() }

    const backups = backupsIn(root)
    assert.equal(backups.length, 1, 'exactly one pre-migration backup')
    assert.match(backups[0], /before-migrate-v22-/)
    const backupPath = join(root, backups[0])
    assert.ok(statSync(backupPath).size > 0)
    if (process.platform !== 'win32') assert.equal(statSync(backupPath).mode & 0o777, 0o600, 'the backup must be 0600')
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(backups[0]) && name !== backups[0]), [], 'no verification -wal/-shm sidecars are left behind')
    const backup = readRaw(backupPath)
    try {
      assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok')
      assert.equal(backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '22')
      assert.equal(Number(backup.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'handoffs'").get().n), 0, 'the backup is the pre-v23 database')
      assert.equal(Number(backup.prepare('SELECT COUNT(*) AS n FROM mail_messages').get().n), 1)
      assert.equal(Number(backup.prepare('SELECT COUNT(*) AS n FROM facts').get().n), 1)
    } finally { backup.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a failed v23 step rolls back atomically and leaves the v22 database retryable', () => {
  const { root, db } = setup('advisers-migration-v23-fail-')
  try {
    createSeed(db)
    downgradeToV22(db)
    assertNoV23Artifacts(db)
    const beforeHash = fileHash(db)
    const original = SqliteStore.prototype._runMigrationStep
    SqliteStore.prototype._runMigrationStep = function (step) {
      if (step.version === 23) throw new Error('injected v23 step failure')
      return original.call(this, step)
    }
    try {
      assert.throws(() => new SqliteStore(db), /injected v23 step failure/)
    } finally {
      SqliteStore.prototype._runMigrationStep = original
    }
    assert.equal(metaValue(db, 'schema_version'), '22', 'DDL and the version stamp roll back together')
    assertNoV23Artifacts(db)
    assert.equal(fileHash(db), beforeHash, 'a rolled-back migration leaves the old database intact')
    assert.equal(backupsIn(root).length, 1, 'the verified backup is kept after a failed step')
    const raw = readRaw(db)
    try {
      assert.equal(Number(raw.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 23").get().n), 0, 'the v23 ledger row rolls back')
      assert.equal(Number(raw.prepare('SELECT COUNT(*) AS n FROM mail_messages').get().n), 1)
      assert.equal(Number(raw.prepare('SELECT COUNT(*) AS n FROM facts').get().n), 1)
    } finally { raw.close() }

    const retry = new SqliteStore(db)
    try {
      assert.equal(retry.getMeta('schema_version'), '23')
      assert.deepEqual(migrationRows(retry).map((row) => row.version), [20, 21, 22, 23])
      for (const table of V23_LAYOUT.tables) assert.ok(tableNames(db).has(table), 'missing table ' + table)
      assert.equal(retry.db.prepare('SELECT direction FROM mail_messages WHERE id = ?').get('msg1').direction, 'unknown')
    } finally { retry.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reopening is idempotent: no migration row and no second backup', () => {
  const { root, db } = setup('advisers-migration-v23-reopen-')
  try {
    createSeed(db)
    downgradeToV22(db)
    const first = new SqliteStore(db)
    const firstRows = migrationRows(first)
    first.close()
    const backupCount = backupsIn(root).length
    assert.equal(backupCount, 1)

    const second = new SqliteStore(db)
    try {
      assert.deepEqual(migrationRows(second), firstRows, 'a plain reopen must not add a migration row')
      assert.equal(second.getMeta('schema_version'), '23')
      assert.equal(backupsIn(root).length, backupCount, 'a plain reopen must not take another backup')
    } finally { second.close() }
    const third = new SqliteStore(db)
    try {
      assert.equal(third.getMeta('schema_version'), '23')
      assert.equal(backupsIn(root).length, backupCount)
    } finally { third.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a future schema is refused with E_SCHEMA_NEWER and the file is not modified', () => {
  const { root, db } = setup('advisers-migration-v23-future-')
  try {
    const store = new SqliteStore(db)
    store.close()
    // Simulate the 0.5.0 CLI (schema v22) opening this v23 database: its
    // SCHEMA_VERSION is 22, so the on-disk 24 (one newer than v23) must be
    // refused by the same guard. A v22 binary would see 23 > 22 and fail closed
    // with the identical code path.
    const raw = new DatabaseSync(db)
    raw.prepare("UPDATE meta SET value = '24' WHERE key = 'schema_version'").run()
    raw.close()
    const before = fileHash(db)
    assert.throws(() => new SqliteStore(db), (error) => {
      assert.equal(error.code, 'E_SCHEMA_NEWER')
      assert.match(error.message, /database schema v24 is newer than this CLI \(v23\)/)
      return true
    })
    assert.throws(() => openReadStore(db), (error) => error.code === 'E_SCHEMA_NEWER')
    assert.equal(fileHash(db), before, 'a refused future schema must not change any byte')
    assert.deepEqual(readdirSync(root).filter((name) => name.includes('before-migrate')), [], 'refusing a future schema must not take a backup')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('DATA_TABLES carries the v23 sidecars and a raw export round-trips', () => {
  const source = setup('advisers-v23-export-src-')
  const target = setup('advisers-v23-export-dst-')
  try {
    const from = new SqliteStore(source.db)
    let exported
    try {
      insertRow(from, 'waiting_replies', {
        id: 'wr_1', commitment_id: 'cm1', account_id: 'acc1', anchor_row_id: 'msg1',
        anchor_message_id: 'mid1@example.com', thread_root: 'root@example.com',
        counterparty: 'client@example.com', anchor_at: NOW, state: 'waiting',
        basis: JSON.stringify({ method: 'headers', replies: [], ignored: [], warnings: [] }),
        created_at: NOW, updated_at: NOW,
      })
      insertRow(from, 'handoffs', {
        id: 'hd_1', created_at: NOW, expires_at: NOW, status: 'active', summary: '交接摘要',
        completed: JSON.stringify(['a']), open_tasks: '[]', decisions: '[]', failed_attempts: '[]',
        constraints: '[]', next_steps: '[]', matter_id: 'm1', secrecy: 0, payload_sha256: 'a'.repeat(64),
      })
      insertRow(from, 'handoff_claims', {
        handoff_id: 'hd_1', claim_id: 'clm_1', claimed_at: NOW, claimant: 'agent-b',
        request_id: 'req-1', receipt_sha256: 'b'.repeat(64),
      })
      for (const table of V23_LAYOUT.tables) assert.ok(DATA_TABLES.includes(table), table + ' must be a data table')
      exported = from.exportDataTables([...V23_LAYOUT.tables])
      for (const table of V23_LAYOUT.tables) assert.equal(exported[table].length, 1, 'export ' + table)
      assert.equal(exported['handoff_claims'][0].claimant, 'agent-b')
    } finally { from.close() }

    const to = new SqliteStore(target.db)
    try {
      for (const [table, rows] of Object.entries(exported)) for (const row of rows) insertRow(to, table, row)
      for (const [table, rows] of Object.entries(exported)) {
        assert.deepEqual(to.exportDataTables([table])[table], rows, 'round-trip of ' + table)
      }
      // Claim-once rides with the database: a second claim row for the same
      // handoff is refused by handoff_id's primary key.
      assert.throws(() => insertRow(to, 'handoff_claims', {
        handoff_id: 'hd_1', claim_id: 'clm_2', claimed_at: NOW, receipt_sha256: 'c'.repeat(64),
      }), /UNIQUE constraint failed|PRIMARY KEY/i)
      // One commitment can only carry one waiting_replies row.
      assert.throws(() => insertRow(to, 'waiting_replies', {
        id: 'wr_2', commitment_id: 'cm1', anchor_message_id: 'mid2@example.com',
        thread_root: 'root2@example.com', counterparty: 'other@example.com', anchor_at: NOW,
        state: 'waiting', basis: '{}', created_at: NOW, updated_at: NOW,
      }), /UNIQUE constraint failed/i)
    } finally { to.close() }
  } finally {
    rmSync(source.root, { recursive: true, force: true })
    rmSync(target.root, { recursive: true, force: true })
  }
})

test('export --all / import --replace and bundle round-trips survive the reserved-word column', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-v23-import-'))
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  const homeC = join(root, 'home-c')
  mkdirSync(homeA)
  mkdirSync(homeB)
  mkdirSync(homeC)
  try {
    runCli(homeA, ['commit', 'add', '集成测试报价', '--quote', 'q', '--json'])
    // A mail row with the reserved-word column set, plus a claimed handoff (the
    // claim row is inserted before the parent by the bundle's sorted table
    // order; the deferred FK makes that legal inside the import transaction).
    const raw = new DatabaseSync(join(homeA, 'state.db'))
    try {
      raw.exec("INSERT INTO mail_accounts (id,name,host,port,tls,username,mailbox,status,created_at,updated_at) VALUES ('acc1','INBOX','h',993,'tls','me@example.com','INBOX','active','t','t')")
      raw.exec('INSERT INTO mail_messages (id,account_id,mailbox,uid,uidvalidity,message_id,dedupe_key,from_addr,subject,received_at,status,created_at,updated_at,in_reply_to,"references",thread_root,direction,auto_submitted) VALUES (\'msg1\',\'acc1\',\'INBOX\',1,\'1\',\'<m1@x>\',\'k1\',\'client@x\',\'Re: 报价\',\'t\',\'new\',\'t\',\'t\',\'<m0@x>\',\'["<m0@x>"]\',\'<m0@x>\',\'inbound\',NULL)')
      raw.exec("INSERT INTO handoffs (id,created_at,expires_at,status,summary,payload_sha256) VALUES ('hd_1','t','2099-01-01T00:00:00Z','active','s','" + 'a'.repeat(64) + "')")
      raw.exec("INSERT INTO handoff_claims (handoff_id,claim_id,claimed_at,request_id,receipt_sha256) VALUES ('hd_1','clm_1','t','req-1','" + 'b'.repeat(64) + "')")
    } finally { raw.close() }

    const exportFile = join(root, 'export.json')
    runCli(homeA, ['export', '--all', '--out', exportFile])
    runCli(homeB, ['import', exportFile, '--replace'])
    const imported = new DatabaseSync(join(homeB, 'state.db'), { readOnly: true })
    try {
      const mail = imported.prepare('SELECT * FROM mail_messages WHERE id = ?').get('msg1')
      assert.equal(mail.references, '["<m0@x>"]', 'mail_messages.references survives export --all / import --replace')
      assert.equal(mail.in_reply_to, '<m0@x>')
      assert.equal(mail.direction, 'inbound')
      assert.equal(Number(imported.prepare('SELECT COUNT(*) AS n FROM handoffs').get().n), 1)
      assert.equal(Number(imported.prepare('SELECT COUNT(*) AS n FROM handoff_claims').get().n), 1)
    } finally { imported.close() }

    const bundleDir = join(root, 'bundle')
    runCli(homeA, ['export', '--bundle', bundleDir, '--json'])
    runCli(homeC, ['import', '--bundle', bundleDir, '--verify', '--json'])
    const reimported = new DatabaseSync(join(homeC, 'state.db'), { readOnly: true })
    try {
      const mail = reimported.prepare('SELECT * FROM mail_messages WHERE id = ?').get('msg1')
      assert.equal(mail.references, '["<m0@x>"]', 'mail_messages.references survives a bundle round-trip')
      const claim = reimported.prepare('SELECT * FROM handoff_claims').get()
      assert.equal(claim.claim_id, 'clm_1')
      assert.equal(claim.request_id, 'req-1')
    } finally { reimported.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

