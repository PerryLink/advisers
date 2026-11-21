import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openReadStore, SqliteStore } from '../lib/sqlite.js'
import {
  receivableAdd,
  receivableEdit,
  receivableList,
  receivableShow,
  receivableVoid,
  paymentAdd,
  paymentList,
  paymentVoid,
  openReceivablesCount,
  moveClientMoneyRows,
} from '../lib/receivables.js'

// Receivable commands (0.4.0, schema v22): follow-up commitment sidecar,
// matter resolution, validation, audit rows, edit/void lifecycle. Every store
// lives in a mktemp HOME; the real ~/.advisers is never opened.

const NOW = '2026-11-21T00:00:00.000Z'
const LATER = '2026-12-01T00:00:00.000Z'
const DDL = [
  'CREATE TABLE IF NOT EXISTS receivables (id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, project_id TEXT, matter_id TEXT, delivery_id TEXT, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL, kind TEXT NOT NULL DEFAULT "other", memo TEXT, closed_by_payment_id TEXT, written_off_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)',
  'CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, commitment_id TEXT, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL, paid_at TEXT NOT NULL, method TEXT NOT NULL, memo TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)',
]

function setup(prefix = 'advisers-receivables-commands-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const db = join(root, 'state.db')
  const store = new SqliteStore(db)
  ensureMoneyTables(store)
  return { root, db, store }
}

/** The schema-v22 money tables are owned by lib/sqlite.js; create them here only
 * if a concurrently edited schema has not landed yet (idempotent no-op in CI). */
function ensureMoneyTables(store) {
  const tableCount = Number(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('receivables','payments')").get()?.n ?? 0)
  if (tableCount === 2) return
  for (const statement of DDL) store.db.exec(statement)
}

function seedMatter(store, id, extra = {}) {
  store.mutate(() => store.insertMatter({
    id,
    title: id,
    status: 'active',
    domain: 'general',
    secrecy: 0,
    participants: [],
    deadlines: [],
    openQuestions: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  }))
  return store.getMatter(id)
}

test('receivableAdd creates the follow-up commitment sidecar in the same transaction', () => {
  const { root, store } = setup()
  try {
    const client = store.addClient({ name: '王工', secrecyDefault: 1 })
    const made = receivableAdd(store, {
      clientId: client.id,
      label: '支付尾款',
      amount: '8000.00',
      dueAt: '2026-12-15',
      reminderOffsets: ['-3d', '-1d'],
      now: NOW,
    })
    assert.match(made.receivable.id, /^rcv_[0-9a-f]{16}$/)
    assert.match(made.receivable.commitmentId, /^cm_/)
    assert.equal(made.createdMatter, true, 'no matter existed, so the 回款 matter is created')
    assert.equal(made.receivable.label, '支付尾款')
    assert.equal(made.receivable.amountMinor, 800000)
    assert.equal(made.receivable.amount, '8000.00')
    assert.equal(made.receivable.paid, '0.00')
    assert.equal(made.receivable.outstanding, '8000.00')
    assert.equal(made.receivable.state, 'open')
    assert.equal(made.receivable.currency, 'CNY')
    assert.equal(made.receivable.dueAt, '2026-12-15')
    assert.deepEqual(made.receivable.reminderOffsets, ['-3d', '-1d'])

    const commitment = store.getCommitment(made.receivable.commitmentId)
    assert.equal(commitment.action, '支付尾款')
    assert.equal(commitment.debtor, 'third:王工')
    assert.equal(commitment.creditor, 'me')
    assert.equal(commitment.status, 'open')
    assert.equal(commitment.dueAt, '2026-12-15')
    assert.equal(commitment.timezone, 'Asia/Shanghai')
    assert.equal(commitment.capability, 'todo')
    assert.deepEqual(commitment.reminderOffsets, ['-3d', '-1d'])
    assert.equal(commitment.evidence.length, 1)
    assert.equal(commitment.evidence[0].kind, 'manual')
    assert.equal(commitment.evidence[0].command, 'receivable add')

    // The amount never enters the action or any evidence quote.
    const sidecarText = JSON.stringify(commitment)
    assert.ok(!sidecarText.includes('8000'), 'commitment action/evidence must not contain the amount')
    assert.ok(!sidecarText.includes('800000'), 'commitment action/evidence must not contain minor units')
    // The follow-up matter is real, active and owned by the client.
    const matter = store.getMatter(made.receivable.matterId)
    assert.equal(matter.title, '回款')
    assert.equal(matter.clientId, client.id)
    assert.equal(matter.domain, 'customer')
    assert.equal(matter.secrecy, 1)
    assert.equal(made.receivable.projectId, undefined)

    // One audit row, ids only, no amount.
    const audit = store.listAudit(5)
    assert.equal(audit[0].action, 'receivable.add')
    assert.equal(audit[0].allowed, true)
    assert.match(audit[0].reason, /^rcv_[0-9a-f]{16} cm_[0-9a-z_]+ client cl_/)
    assert.ok(!audit[0].reason.includes('8000'))
    assert.ok(!audit[0].reason.includes('王工'))
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a second receivable reuses the single active matter and does not create another 回款', () => {
  const { root, store } = setup()
  try {
    const client = store.addClient({ name: '李工' })
    const first = receivableAdd(store, { clientId: client.id, label: '首款', amount: '1000', now: NOW })
    const second = receivableAdd(store, { clientId: client.id, label: '尾款', amount: '2000', now: NOW })
    assert.equal(first.createdMatter, true)
    assert.equal(second.createdMatter, false)
    assert.equal(first.receivable.matterId, second.receivable.matterId)
    const matters = store.db.prepare('SELECT COUNT(*) AS n FROM matters WHERE client_id = ?').get(client.id)
    assert.equal(Number(matters.n), 1)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('matter resolution: explicit matter, project default matter and explicit errors', () => {
  const { root, store } = setup()
  try {
    const client = store.addClient({ name: '赵工' })
    const other = store.addClient({ name: '别人' })
    const matter = seedMatter(store, 'matter_quote', { title: '报价确认', clientId: client.id, projectId: 'prj_quote' })
    const foreignMatter = seedMatter(store, 'matter_foreign', { clientId: other.id })
    assert.ok(matter && foreignMatter)
    store.addProject({ id: 'prj_quote', clientId: client.id, name: '官网', defaultMatterId: 'matter_quote' })
    // 1) explicit matter wins and derives the project from the matter.
    const byMatter = receivableAdd(store, { clientId: client.id, label: '首款', amount: '500', matterId: 'matter_quote', now: NOW })
    assert.equal(byMatter.receivable.matterId, 'matter_quote')
    assert.equal(byMatter.receivable.projectId, 'prj_quote')
    assert.equal(byMatter.createdMatter, false)
    // 2) project default matter.
    const byProject = receivableAdd(store, { clientId: client.id, label: '尾款', amount: '500', projectId: 'prj_quote', now: NOW })
    assert.equal(byProject.receivable.matterId, 'matter_quote')
    assert.equal(byProject.receivable.projectId, 'prj_quote')
    // 3) a matter owned by another client fails closed.
    assert.throws(
      () => receivableAdd(store, { clientId: client.id, label: 'x', amount: '1', matterId: 'matter_foreign', now: NOW }),
      /E_MATTER_CLIENT_MISMATCH/,
    )
    assert.throws(
      () => receivableAdd(store, { clientId: client.id, label: 'x', amount: '1', matterId: 'matter_missing', now: NOW }),
      /E_MATTER_NOT_FOUND/,
    )
    assert.throws(
      () => receivableAdd(store, { clientId: client.id, label: 'x', amount: '1', projectId: 'prj_missing', now: NOW }),
      /E_PROJECT_NOT_FOUND/,
    )
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('validation: unknown/archived client, bad label, amount, currency, kind, due date', () => {
  const { root, store } = setup()
  try {
    const client = store.addClient({ name: '钱工' })
    const archived = store.addClient({ name: '旧客户' })
    store.archiveClient(archived.id)
    const base = { clientId: client.id, label: '尾款', amount: '100', now: NOW }
    assert.throws(() => receivableAdd(store, { ...base, clientId: 'cl_missing' }), /E_CLIENT_NOT_FOUND/)
    assert.throws(() => receivableAdd(store, { ...base, clientId: archived.id }), /E_CLIENT_ARCHIVED/)
    assert.throws(() => receivableAdd(store, { ...base, label: 'line' + String.fromCharCode(10) + 'break' }), /single line/)
    assert.throws(() => receivableAdd(store, { ...base, label: '/etc/passwd' }), /absolute file path/)
    assert.throws(() => receivableAdd(store, { ...base, amount: '12.345' }), /E_RECEIVABLE_INVALID/)
    assert.throws(() => receivableAdd(store, { ...base, amount: -1 }), /E_RECEIVABLE_INVALID/)
    assert.throws(() => receivableAdd(store, { ...base, currency: 'JPY' }), /currency/)
    assert.throws(() => receivableAdd(store, { ...base, kind: 'gift' }), /kind/)
    assert.throws(() => receivableAdd(store, { ...base, dueAt: 'tomorrow' }), /not a valid date/)
    assert.throws(() => receivableAdd(store, { ...base, reminderOffsets: ['nonsense'] }), /invalid reminder offsets/)
    assert.throws(() => receivableAdd(store, { ...base, memo: 'C:' + String.fromCharCode(92) + 'secret.txt' }), /absolute file path/)
    assert.equal(receivableList(store).total, 0, 'no invalid write reached the database')
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('receivableShow returns the row plus payments; unknown ids and clearance fail closed', () => {
  const { root, store } = setup()
  try {
    const client = store.addClient({ name: '孙工', secrecyDefault: 2 })
    const made = receivableAdd(store, { clientId: client.id, label: '尾款', amount: '300', now: NOW })
    paymentAdd(store, { clientId: client.id, amount: '100', receivableId: made.receivable.id, method: 'cash', paidAt: '2026-11-20', now: NOW })
    const shown = receivableShow(store, made.receivable.id, { now: NOW })
    assert.equal(shown.receivable.paid, '100.00')
    assert.equal(shown.receivable.state, 'partial')
    assert.equal(shown.payments.length, 1)
    assert.equal(shown.payments[0].method, 'cash')
    assert.equal(shown.clearance, 3)
    assert.throws(() => receivableShow(store, 'rcv_missing'), /E_RECEIVABLE_NOT_FOUND/)
    // effective secrecy 2 > clearance 1: not even the id is echoed.
    assert.throws(() => receivableShow(store, made.receivable.id, { clearance: 1 }), /E_RECEIVABLE_NOT_FOUND/)
    assert.equal(receivableList(store, { clearance: 1 }).total, 0)
    assert.equal(receivableList(store, { clearance: 1 }).protectedExcluded, 1)
    assert.equal(receivableList(store, { clearance: 2 }).total, 1)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('edit updates memo/kind/due/label/reminders, refuses amount changes with payments and void records', () => {
  const { root, store } = setup()
  try {
    const client = store.addClient({ name: '周工' })
    const made = receivableAdd(store, { clientId: client.id, label: '尾款', amount: '800', now: NOW })
    const edited = receivableEdit(store, made.receivable.id, { memo: '分两笔', kind: 'milestone', dueAt: '2026-12-20', label: '尾款（改）' })
    assert.equal(edited.receivable.memo, '分两笔')
    assert.equal(edited.receivable.kind, 'milestone')
    assert.equal(edited.receivable.dueAt, '2026-12-20')
    assert.equal(edited.receivable.label, '尾款（改）')
    const commitment = store.getCommitment(made.receivable.commitmentId)
    assert.equal(commitment.dueAt, '2026-12-20')
    assert.equal(commitment.action, '尾款（改）')
    // reminders can be set and cleared.
    receivableEdit(store, made.receivable.id, { reminderOffsets: ['-1d'] })
    assert.deepEqual(store.getCommitment(made.receivable.commitmentId).reminderOffsets, ['-1d'])
    receivableEdit(store, made.receivable.id, { noRemind: true })
    assert.equal(store.getCommitment(made.receivable.commitmentId).reminderOffsets, undefined)
    assert.throws(() => receivableEdit(store, made.receivable.id, {}), /nothing to edit/)
    assert.throws(() => receivableEdit(store, 'rcv_missing', { memo: 'x' }), /E_RECEIVABLE_NOT_FOUND/)
    // amount can change while no payments exist.
    const reAmounted = receivableEdit(store, made.receivable.id, { amount: '900.50' })
    assert.equal(reAmounted.receivable.amount, '900.50')
    paymentAdd(store, { clientId: client.id, amount: '100', receivableId: made.receivable.id, now: LATER })
    assert.throws(() => receivableEdit(store, made.receivable.id, { amount: '950' }), /cannot change the amount/)
    assert.equal(receivableEdit(store, made.receivable.id, { memo: '还能改备注' }).receivable.memo, '还能改备注')
    // A receivable with active payments cannot be voided: void the payment first.
    assert.throws(() => receivableVoid(store, made.receivable.id, { reason: '客户取消' }), /still has 1 active payment/)
    const payments = paymentList(store, { receivableId: made.receivable.id, now: LATER })
    assert.equal(payments.total, 1)
    paymentVoid(store, payments.payments[0].id)
    const voided = receivableVoid(store, made.receivable.id, { reason: '客户取消' })
    assert.equal(voided.receivable.state, 'void')
    assert.equal(voided.alreadyVoid, false)
    assert.equal(voided.droppedCommitment, true, 'the pending follow-up commitment is dropped')
    assert.equal(store.getCommitment(made.receivable.commitmentId).status, 'dropped')
    // A tombstone is immutable.
    assert.throws(() => receivableEdit(store, made.receivable.id, { memo: 'x' }), /void/)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
