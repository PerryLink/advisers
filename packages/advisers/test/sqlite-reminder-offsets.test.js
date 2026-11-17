import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import { SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'

const EVIDENCE = [{ sessionId: 's1', turnId: 't1', quote: '提醒我发报价' }]

function ledgerWith({ offsets, plain } = {}) {
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: 'SQLite 提醒偏移' })
  const commitments = {}
  if (offsets !== undefined) {
    commitments.custom = ledger.addCommitment({
      matterId: matter.id,
      debtor: 'agent',
      creditor: '客户',
      action: '发送报价单',
      dueAt: '2026-11-20T18:00:00+08:00',
      evidence: EVIDENCE,
      reminderOffsets: offsets,
    })
  }
  if (plain) {
    commitments.plain = ledger.addCommitment({
      matterId: matter.id,
      debtor: 'agent',
      creditor: '客户',
      action: '老承诺',
      dueAt: '2026-11-21T09:00:00+08:00',
      evidence: EVIDENCE,
    })
  }
  return { ledger, matter, commitments }
}

function schemaVersionOf(store) {
  return store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value
}

test('sqlite persists per-commitment reminderOffsets across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-sqlite-offsets-'))
  const db = join(dir, 'state.db')
  try {
    const { ledger, commitments } = ledgerWith({ offsets: ['-1d', '-2h', '+0d09:00'], plain: true })
    const store = new SqliteStore(db)
    assert.equal(schemaVersionOf(store), String(SCHEMA_VERSION))
    store.save(ledger.toJSON())
    store.close()

    const reopened = new SqliteStore(db)
    const snapshot = reopened.load()
    const restored = Ledger.fromJSON(snapshot)
    const custom = restored.listCommitments().find((entry) => entry.id === commitments.custom.id)
    assert.ok(custom)
    assert.deepEqual(custom.reminderOffsets, ['-1d', '-2h', '+0d09:00'])
    const plain = restored.listCommitments().find((entry) => entry.id === commitments.plain.id)
    assert.ok(plain)
    assert.equal(plain.reminderOffsets, undefined)
    assert.ok(!('reminderOffsets' in plain), 'a commitment without offsets keeps the pre-0.2.0 shape')
    reopened.close()

    const verify = new SqliteStore(db, { readOnly: true })
    assert.deepEqual(verify.load().commitments.find((entry) => entry.id === commitments.custom.id).reminderOffsets, ['-1d', '-2h', '+0d09:00'])
    verify.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sqlite persists reminderOffsets updates and an explicit empty list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-sqlite-offsets-update-'))
  const db = join(dir, 'state.db')
  try {
    const first = ledgerWith({ offsets: ['-1d'] })
    const store = new SqliteStore(db)
    store.save(first.ledger.toJSON())
    const loaded = Ledger.fromJSON(store.load())
    loaded.updateCommitment(first.commitments.custom.id, { reminderOffsets: ['-30m', '+0d09:00'] })
    store.save(loaded.toJSON())
    store.close()

    const second = new SqliteStore(db)
    const restored = Ledger.fromJSON(second.load())
    assert.deepEqual(restored.listCommitments()[0].reminderOffsets, ['-30m', '+0d09:00'])

    // Bounded edge: an explicit empty array is a value, not "missing".
    restored.updateCommitment(first.commitments.custom.id, { reminderOffsets: [] })
    second.save(restored.toJSON())
    second.close()

    const third = new SqliteStore(db)
    const again = Ledger.fromJSON(third.load())
    assert.deepEqual(again.listCommitments()[0].reminderOffsets, [])
    third.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a v17 database migrates by adding reminder_offsets without losing commitments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-sqlite-migrate-'))
  const db = join(dir, 'state.db')
  try {
    // Build the pre-0.2.0 shape by hand: schema_version 17 and no reminder_offsets column.
    const raw = new DatabaseSync(db)
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    raw.exec("INSERT INTO meta(key,value) VALUES('schema_version','17')")
    raw.exec(`CREATE TABLE commitments (
      id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, debtor TEXT NOT NULL, creditor TEXT NOT NULL,
      action TEXT NOT NULL, due_at TEXT, timezone TEXT NOT NULL, status TEXT NOT NULL,
      evidence TEXT NOT NULL, capability TEXT NOT NULL, done_at TEXT
    )`)
    raw.exec(`INSERT INTO commitments VALUES (
      'cm_legacy','matter_legacy','agent','user','旧承诺','2026-11-20T18:00:00+08:00',
      'Asia/Shanghai','open','[]','calendar',NULL
    )`)
    raw.close()

    const store = new SqliteStore(db)
    assert.equal(schemaVersionOf(store), String(SCHEMA_VERSION))
    const columns = store.db.prepare('PRAGMA table_info(commitments)').all().map((column) => column.name)
    assert.ok(columns.includes('reminder_offsets'), 'migration adds the column')

    const snapshot = store.load()
    assert.equal(snapshot.commitments.length, 1)
    assert.equal(snapshot.commitments[0].id, 'cm_legacy')
    assert.equal(snapshot.commitments[0].reminderOffsets, undefined)

    // The migrated table accepts the new value on the next save/reopen.
    const ledger = Ledger.fromJSON(snapshot)
    ledger.updateCommitment('cm_legacy', { reminderOffsets: ['-1d'] })
    store.save(ledger.toJSON())
    store.close()

    const reopened = new SqliteStore(db)
    assert.deepEqual(reopened.load().commitments[0].reminderOffsets, ['-1d'])
    reopened.close()

    const backups = readdirSync(dir).filter((name) => /^state\.db\.before-migrate-v17-\d+$/.test(name))
    assert.equal(backups.length, 1, 'an existing database is backed up before migrating')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corrupt stored reminder_offsets degrade to undefined instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-sqlite-offsets-bad-'))
  const db = join(dir, 'state.db')
  try {
    const { ledger } = ledgerWith({ offsets: ['-1d'] })
    const store = new SqliteStore(db)
    store.save(ledger.toJSON())
    store.db.prepare("UPDATE commitments SET reminder_offsets = 'not-json'").run()
    const snapshot = store.load()
    assert.equal(snapshot.commitments[0].reminderOffsets, undefined)
    assert.equal(snapshot.commitments[0].action, '发送报价单')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
