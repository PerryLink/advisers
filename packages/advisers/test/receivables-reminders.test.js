import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildReminders, toIcs } from '../lib/remind.js'
import { SqliteStore } from '../lib/sqlite.js'
import { paymentAdd, paymentVoid, receivableAdd } from '../lib/receivables.js'

// Reminder linkage (0.4.0): the receivable's follow-up commitment is the only
// due source, so remind/ICS work with zero new tables and no amount ever
// appears in a reminder payload or calendar. Temporary HOME only.

const NOW = new Date('2026-11-21T00:00:00.000Z')
const LATER = '2026-11-22T00:00:00.000Z'
const DDL = [
  'CREATE TABLE IF NOT EXISTS receivables (id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, project_id TEXT, matter_id TEXT, delivery_id TEXT, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL, kind TEXT NOT NULL DEFAULT "other", memo TEXT, closed_by_payment_id TEXT, written_off_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)',
  'CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, commitment_id TEXT, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL, paid_at TEXT NOT NULL, method TEXT NOT NULL, memo TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)',
]

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-receivables-reminders-'))
  const store = new SqliteStore(join(root, 'state.db'))
  const tableCount = Number(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('receivables','payments')").get()?.n ?? 0)
  if (tableCount !== 2) for (const statement of DDL) store.db.exec(statement)
  const ledger = { listCommitments: () => store.loadCommitments({ status: 'open', order: 'rowid' }) }
  return { root, store, ledger }
}

test('the follow-up commitment drives reminders, completion silences them and void reopens them', () => {
  const { root, store, ledger } = setup()
  try {
    const client = store.addClient({ name: '王工' })
    const made = receivableAdd(store, {
      clientId: client.id,
      label: '支付尾款',
      amount: '8000.00',
      dueAt: '2026-11-24',
      reminderOffsets: ['-1d'],
      now: NOW.toISOString(),
    })
    const reminders = buildReminders(ledger, { now: NOW, horizonDays: 7 })
    const own = reminders.filter((reminder) => reminder.commitmentId === made.receivable.commitmentId)
    assert.equal(own.length, 1, 'the follow-up commitment is visible to remind')
    assert.equal(own[0].action, '支付尾款')
    assert.deepEqual(own[0].reminderOffsets, ['-1d'])
    // No amount in the reminder JSON or the ICS calendar.
    assert.ok(!JSON.stringify(reminders).includes('8000'))
    const ics = toIcs(reminders, { now: NOW })
    assert.ok(!ics.includes('8000'))
    assert.ok(!ics.includes('800000'))
    assert.match(ics, /BEGIN:VEVENT/)

    // Full payment completes the commitment: remind no longer lists it.
    const paid = paymentAdd(store, { clientId: client.id, amount: '8000', receivableId: made.receivable.id, now: LATER })
    assert.equal(paid.completedCommitment, true)
    assert.equal(buildReminders(ledger, { now: new Date(LATER), horizonDays: 7 }).length, 0)

    // Voiding that payment reopens the commitment: reminders return.
    paymentVoid(store, paid.payment.id, { now: LATER })
    const reopened = buildReminders(ledger, { now: new Date(LATER), horizonDays: 7 })
    assert.equal(reopened.length, 1)
    assert.equal(reopened[0].commitmentId, made.receivable.commitmentId)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
