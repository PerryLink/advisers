import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SqliteStore } from '../lib/sqlite.js'
import {
  paymentAdd,
  paymentList,
  paymentVoid,
  receivableAdd,
  receivableList,
  receivableShow,
  receivableVoid,
} from '../lib/receivables.js'

// Payments (0.4.0, schema v22): partial / multiple / over-payment, unmatched
// prepayments, automatic follow-up completion, exact reopening on void and the
// evidence-history rule. Temporary HOME only.

const NOW = '2026-11-21T00:00:00.000Z'
const LATER = '2026-11-25T00:00:00.000Z'
const DDL = [
  'CREATE TABLE IF NOT EXISTS receivables (id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, project_id TEXT, matter_id TEXT, delivery_id TEXT, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL, kind TEXT NOT NULL DEFAULT "other", memo TEXT, closed_by_payment_id TEXT, written_off_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)',
  'CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, commitment_id TEXT, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL, paid_at TEXT NOT NULL, method TEXT NOT NULL, memo TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)',
]

function setup(prefix = 'advisers-receivables-payments-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const store = new SqliteStore(join(root, 'state.db'))
  const tableCount = Number(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('receivables','payments')").get()?.n ?? 0)
  if (tableCount !== 2) for (const statement of DDL) store.db.exec(statement)
  return { root, store }
}

function withClient(store, name = '王工') {
  return store.addClient({ name })
}

test('partial and multiple payments: state follows the money, not the stored status', () => {
  const { root, store } = setup()
  try {
    const client = withClient(store)
    const made = receivableAdd(store, { clientId: client.id, label: '尾款', amount: '8000.00', dueAt: '2026-12-15', now: NOW })
    const first = paymentAdd(store, { clientId: client.id, amount: '3000', receivableId: made.receivable.id, method: 'bank', paidAt: '2026-11-20', now: NOW })
    assert.equal(first.completedCommitment, false)
    assert.equal(first.receivable.state, 'partial')
    assert.equal(first.receivable.paid, '3000.00')
    assert.equal(first.receivable.outstanding, '5000.00')
    assert.equal(first.receivable.payments.count, 1)
    assert.equal(first.receivable.payments.lastPaidAt, '2026-11-20T00:00:00.000+08:00')
    assert.equal(store.getCommitment(made.receivable.commitmentId).status, 'open')

    const second = paymentAdd(store, { clientId: client.id, amount: '5000.00', receivableId: made.receivable.id, method: 'wechat', paidAt: '2026-11-21', now: LATER })
    assert.equal(second.completedCommitment, true)
    assert.equal(second.receivable.state, 'settled')
    assert.equal(second.receivable.paid, '8000.00')
    assert.equal(second.receivable.outstanding, '0.00')
    assert.equal(second.receivable.closedByPaymentId, second.payment.id)
    assert.equal(second.receivable.payments.count, 2)
    const commitment = store.getCommitment(made.receivable.commitmentId)
    assert.equal(commitment.status, 'done')
    assert.equal(commitment.evidence.length, 2, 'completion appends one manual evidence item')
    assert.equal(commitment.evidence[1].quote, 'payment ' + second.payment.id)
    assert.ok(!JSON.stringify(commitment).includes('5000.00'), 'payment evidence never carries the amount')
    // audit: ids + method, never the amount.
    const audit = store.listAudit(5)[0]
    assert.equal(audit.action, 'payment.add')
    assert.match(audit.reason, /^pay_[0-9a-f]{16} rcv_[0-9a-f]{16} client cl_.* method=wechat$/)
    assert.ok(!audit.reason.includes('5000'))
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('over-payment beyond the amount is recorded, not rejected, and keeps the closer', () => {
  const { root, store } = setup()
  try {
    const client = withClient(store)
    const made = receivableAdd(store, { clientId: client.id, label: '尾款', amount: '100', now: NOW })
    const first = paymentAdd(store, { clientId: client.id, amount: '100', receivableId: made.receivable.id, now: NOW })
    assert.equal(first.completedCommitment, true)
    const over = paymentAdd(store, { clientId: client.id, amount: '20', receivableId: made.receivable.id, now: NOW })
    assert.equal(over.completedCommitment, false)
    assert.equal(over.receivable.state, 'settled')
    assert.equal(over.receivable.paid, '120.00')
    assert.equal(over.receivable.overpaid, '20.00')
    assert.equal(over.receivable.overpaidMinor, 2000)
    assert.equal(over.receivable.closedByPaymentId, first.payment.id)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('noComplete: money state settles but the follow-up commitment stays open', () => {
  const { root, store } = setup()
  try {
    const client = withClient(store)
    const made = receivableAdd(store, { clientId: client.id, label: '尾款', amount: '100', now: NOW })
    const paid = paymentAdd(store, { clientId: client.id, amount: '100', receivableId: made.receivable.id, noComplete: true, now: NOW })
    assert.equal(paid.completedCommitment, false)
    assert.equal(paid.receivable.state, 'settled')
    assert.equal(paid.receivable.closedByPaymentId, undefined)
    assert.equal(store.getCommitment(made.receivable.commitmentId).status, 'open')
    assert.throws(() => paymentAdd(store, { clientId: client.id, amount: '1', receivableId: made.receivable.id, noComplete: 'yes' }), /noComplete/)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('payment void reopens exactly: only when the balance is positive again, evidence history is kept', () => {
  const { root, store } = setup()
  try {
    const client = withClient(store)
    const made = receivableAdd(store, { clientId: client.id, label: '尾款', amount: '100', now: NOW })
    const p1 = paymentAdd(store, { clientId: client.id, amount: '60', receivableId: made.receivable.id, now: NOW })
    const p2 = paymentAdd(store, { clientId: client.id, amount: '40', receivableId: made.receivable.id, now: NOW })
    assert.equal(p2.completedCommitment, true)
    const before = store.getCommitment(made.receivable.commitmentId)
    assert.equal(before.status, 'done')
    assert.equal(before.evidence.length, 2)

    const voided = paymentVoid(store, p2.payment.id, { now: LATER })
    assert.equal(voided.reopenedCommitment, true)
    assert.equal(voided.receivable.state, 'partial')
    assert.equal(voided.receivable.paid, '60.00')
    assert.equal(voided.receivable.closedByPaymentId, undefined)
    const reopened = store.getCommitment(made.receivable.commitmentId)
    assert.equal(reopened.status, 'open')
    assert.equal(reopened.doneAt, undefined)
    assert.equal(reopened.evidence.length, 2, 'evidence history is never rewritten')
    assert.equal(store.listAudit(5)[0].action, 'payment.void')
    assert.match(store.listAudit(5)[0].reason, /^pay_[0-9a-f]{16} reopen=1 rcv_/)

    // Voiding a partial payment never reopens a commitment it did not close.
    const voidPartial = paymentVoid(store, p1.payment.id, { now: LATER })
    assert.equal(voidPartial.reopenedCommitment, false)
    assert.equal(voidPartial.receivable.state, 'open')
    assert.equal(store.getCommitment(made.receivable.commitmentId).status, 'open')

    // Idempotent: a second void does not write again.
    const again = paymentVoid(store, p2.payment.id, { now: LATER })
    assert.equal(again.alreadyVoid, true)
    assert.equal(again.payment.deletedAt, LATER)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('voiding an over-payment on a settled receivable keeps it settled and re-points the closer', () => {
  const { root, store } = setup()
  try {
    const client = withClient(store)
    const made = receivableAdd(store, { clientId: client.id, label: '尾款', amount: '100', now: NOW })
    const p1 = paymentAdd(store, { clientId: client.id, amount: '100', receivableId: made.receivable.id, now: NOW })
    assert.equal(p1.completedCommitment, true)
    const over = paymentAdd(store, { clientId: client.id, amount: '30', receivableId: made.receivable.id, now: NOW })
    const voided = paymentVoid(store, over.payment.id, { now: LATER })
    assert.equal(voided.reopenedCommitment, false)
    assert.equal(voided.receivable.state, 'settled')
    assert.equal(voided.receivable.paid, '100.00')
    assert.equal(voided.receivable.closedByPaymentId, p1.payment.id)
    assert.equal(store.getCommitment(made.receivable.commitmentId).status, 'done')
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('prepayments are unmatched by design and never reduce an outstanding balance', () => {
  const { root, store } = setup()
  try {
    const client = withClient(store)
    const made = receivableAdd(store, { clientId: client.id, label: '尾款', amount: '500', now: NOW })
    const prepay = paymentAdd(store, { clientId: client.id, amount: '200', method: 'cash', memo: '预收', now: NOW })
    assert.equal(prepay.payment.commitmentId, undefined)
    assert.equal(prepay.receivable, null)
    assert.equal(prepay.completedCommitment, false)
    const row = receivableShow(store, made.receivable.id, { now: NOW }).receivable
    assert.equal(row.paid, '0.00')
    assert.equal(row.outstanding, '500.00')
    assert.equal(row.payments.count, 0)
    const listed = paymentList(store, { clientId: client.id, now: NOW })
    assert.equal(listed.total, 1)
    assert.equal(listed.payments[0].receivableId, undefined)
    // Payment list filter: a 1-day window excludes a payment made a week ago.
    paymentAdd(store, { clientId: client.id, amount: '50', paidAt: '2026-11-14', now: NOW })
    const since = paymentList(store, { clientId: client.id, since: '2d', now: NOW })
    assert.equal(since.total, 1)
    assert.equal(since.payments[0].amount, '200.00')
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('currency, client, future date, amount and method validation fail closed', () => {
  const { root, store } = setup()
  try {
    const client = withClient(store)
    const other = store.addClient({ name: '别人' })
    const made = receivableAdd(store, { clientId: client.id, label: 'USD 尾款', amount: '100', currency: 'USD', now: NOW })
    // A linked payment infers the receivable currency when --currency is omitted.
    const inferred = paymentAdd(store, { clientId: client.id, amount: '10', receivableId: made.receivable.id, now: NOW })
    assert.equal(inferred.payment.currency, 'USD')
    assert.throws(() => paymentAdd(store, { clientId: client.id, amount: '1', currency: 'CNY', receivableId: made.receivable.id, now: NOW }), /does not match receivable currency/)
    assert.throws(() => paymentAdd(store, { clientId: other.id, amount: '1', currency: 'USD', receivableId: made.receivable.id, now: NOW }), /belongs to client/)
    assert.throws(() => paymentAdd(store, { clientId: client.id, amount: '0', now: NOW }), /E_PAYMENT_INVALID/)
    assert.throws(() => paymentAdd(store, { clientId: client.id, amount: '1', paidAt: '2026-11-25', now: NOW }), /future/)
    assert.throws(() => paymentAdd(store, { clientId: client.id, amount: '1', method: 'bitcoin', now: NOW }), /method/)
    assert.throws(() => paymentAdd(store, { clientId: 'cl_missing', amount: '1', now: NOW }), /E_CLIENT_NOT_FOUND/)
    assert.throws(() => paymentAdd(store, { clientId: client.id, amount: '1', receivableId: 'rcv_missing', now: NOW }), /E_RECEIVABLE_NOT_FOUND/)
    assert.throws(() => paymentList(store, { receivableId: 'rcv_missing' }), /E_RECEIVABLE_NOT_FOUND/)
    assert.throws(() => paymentVoid(store, 'pay_missing'), /E_PAYMENT_NOT_FOUND/)
    // Voided receivables reject new payments.
    const voidTarget = receivableAdd(store, { clientId: client.id, label: '要作废', amount: '5', currency: 'USD', now: NOW })
    receivableVoid(store, voidTarget.receivable.id, { now: NOW })
    assert.throws(() => paymentAdd(store, { clientId: client.id, amount: '1', currency: 'USD', receivableId: voidTarget.receivable.id, now: NOW }), /void/)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('receivable void is blocked by active payments; voiding them first allows the tombstone', () => {
  const { root, store } = setup()
  try {
    const client = withClient(store)
    const made = receivableAdd(store, { clientId: client.id, label: '尾款', amount: '100', now: NOW })
    const paid = paymentAdd(store, { clientId: client.id, amount: '100', receivableId: made.receivable.id, now: NOW })
    assert.equal(paid.completedCommitment, true)
    assert.throws(() => receivableVoid(store, made.receivable.id), /still has 1 active payment/)
    paymentVoid(store, paid.payment.id, { now: LATER })
    assert.equal(store.getCommitment(made.receivable.commitmentId).status, 'open')
    const voided = receivableVoid(store, made.receivable.id, { reason: '取消' })
    assert.equal(voided.receivable.state, 'void')
    assert.equal(voided.droppedCommitment, true)
    assert.equal(store.getCommitment(made.receivable.commitmentId).status, 'dropped')
    assert.equal(receivableList(store, { now: LATER }).total, 0)
    assert.equal(receivableList(store, { now: LATER, status: 'all' }).total, 1)
    assert.equal(receivableList(store, { now: LATER, status: 'void' }).total, 1)
    // Idempotent second void.
    assert.equal(receivableVoid(store, made.receivable.id).alreadyVoid, true)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
