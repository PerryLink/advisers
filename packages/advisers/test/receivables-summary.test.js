import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openReadStore, SqliteStore } from '../lib/sqlite.js'
import {
  clientReceivablesBlock,
  moveClientMoneyRows,
  openReceivablesCount,
  paymentAdd,
  paymentList,
  receivableAdd,
  receivableList,
  receivableVoid,
  receivablesSummary,
  paymentVoid,
} from '../lib/receivables.js'

// Reconciliation view (0.4.0): per-currency totals, aging buckets, overdue
// ordering, clearance-before-count, due-within windows, unmatched prepayments
// and the additive client-show block. Temporary HOME only.

const NOW = '2026-11-21T00:00:00.000Z'
const DDL = [
  'CREATE TABLE IF NOT EXISTS receivables (id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, project_id TEXT, matter_id TEXT, delivery_id TEXT, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL, kind TEXT NOT NULL DEFAULT "other", memo TEXT, closed_by_payment_id TEXT, written_off_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)',
  'CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, commitment_id TEXT, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL, paid_at TEXT NOT NULL, method TEXT NOT NULL, memo TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)',
]

function setup(prefix = 'advisers-receivables-summary-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const store = new SqliteStore(join(root, 'state.db'))
  const tableCount = Number(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('receivables','payments')").get()?.n ?? 0)
  if (tableCount !== 2) for (const statement of DDL) store.db.exec(statement)
  return { root, store }
}

function seedAging(store, clientId) {
  const rows = {}
  rows.noDue = receivableAdd(store, { clientId, label: '无期限尾款', amount: '100', now: NOW }).receivable
  rows.notDue = receivableAdd(store, { clientId, label: '未来尾款', amount: '100', dueAt: '2026-12-15', now: NOW }).receivable
  rows.overdue30 = receivableAdd(store, { clientId, label: '逾期 9 天', amount: '100', dueAt: '2026-11-11', now: NOW }).receivable
  rows.overdue60 = receivableAdd(store, { clientId, label: '逾期 44 天', amount: '100', dueAt: '2026-10-07', now: NOW }).receivable
  rows.overdue90 = receivableAdd(store, { clientId, label: '逾期 74 天', amount: '100', dueAt: '2026-09-07', now: NOW }).receivable
  rows.overduePlus = receivableAdd(store, { clientId, label: '逾期 119 天', amount: '100', dueAt: '2026-07-24', now: NOW }).receivable
  return rows
}

test('aging buckets, overdue-first ordering and per-currency totals over the same snapshot', () => {
  const { root, store } = setup()
  try {
    const client = store.addClient({ name: '王工' })
    const rows = seedAging(store, client.id)
    const list = receivableList(store, { clientId: client.id, now: NOW })
    assert.equal(list.total, 6)
    assert.equal(list.truncated, false)
    // overdue rows first, earliest due first; then future due; undated last.
    assert.deepEqual(list.receivables.map((row) => row.label), [
      '逾期 119 天', '逾期 74 天', '逾期 44 天', '逾期 9 天', '未来尾款', '无期限尾款',
    ])
    assert.equal(list.receivables[0].state, 'overdue')
    assert.equal(list.receivables[0].overdueDays, 119)
    assert.equal(list.receivables[4].state, 'open')
    assert.equal(list.receivables[4].overdueDays, null)
    const cny = list.totals.find((totals) => totals.currency === 'CNY')
    assert.equal(cny.count, 6)
    assert.equal(cny.amountMinor, 60000)
    assert.equal(cny.amount, undefined, 'amount strings live on rows, totals carry minor units only')
    assert.equal(cny.unsettledCount, 6)
    assert.equal(cny.settledCount, 0)
    assert.equal(cny.overdueCount, 4)
    assert.equal(cny.overdueMinor, 40000)
    assert.equal(cny.outstandingMinor, 60000)
    assert.deepEqual(cny.aging, { notDue: 1, '0_30': 1, '31_60': 1, '61_90': 1, '90plus': 1, noDue: 1 })
    // Totals only for currencies with data: no phantom USD/EUR/HKD rows.
    assert.deepEqual(list.totals.map((totals) => totals.currency), ['CNY'])
    assert.equal(rows.overduePlus.id.length > 0, true)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('four currencies stay separate; prepayments become unmatched totals, never reduce outstanding', () => {
  const { root, store } = setup()
  try {
    const client = store.addClient({ name: '多币客户' })
    receivableAdd(store, { clientId: client.id, label: 'CNY 尾款', amount: '8000', now: NOW })
    receivableAdd(store, { clientId: client.id, label: 'USD 尾款', amount: '1500.25', currency: 'USD', now: NOW })
    receivableAdd(store, { clientId: client.id, label: 'HKD 尾款', amount: '900', currency: 'HKD', now: NOW })
    paymentAdd(store, { clientId: client.id, amount: '200', currency: 'EUR', method: 'cash', now: NOW })
    const list = receivableList(store, { clientId: client.id, now: NOW })
    assert.deepEqual(list.totals.map((totals) => totals.currency), ['CNY', 'USD', 'EUR', 'HKD'])
    const cny = list.totals.find((totals) => totals.currency === 'CNY')
    const usd = list.totals.find((totals) => totals.currency === 'USD')
    const eur = list.totals.find((totals) => totals.currency === 'EUR')
    assert.equal(cny.amountMinor, 800000)
    assert.equal(usd.amountMinor, 150025)
    assert.equal(cny.unmatchedMinor, 0)
    assert.equal(eur.count, 0)
    assert.equal(eur.unmatchedMinor, 20000)
    assert.equal(eur.amountMinor, 0)
    const summary = receivablesSummary(store, { clientId: client.id, now: NOW })
    assert.equal(summary.total, 3)
    assert.deepEqual(summary.unmatchedPayments, [{ currency: 'EUR', amountMinor: 20000, amount: '200.00', count: 1 }])
    // A mixed-currency payment cannot attach to a CNY receivable.
    const cnyRow = list.receivables.find((row) => row.currency === 'CNY')
    assert.throws(() => paymentAdd(store, { clientId: client.id, amount: '1', currency: 'USD', receivableId: cnyRow.id, now: NOW }), /does not match receivable currency/)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('clearance filters before counting/paging and only reports protectedExcluded', () => {
  const { root, store } = setup()
  try {
    const client = store.addClient({ name: '保密客户', secrecyDefault: 2 })
    const other = store.addClient({ name: '普通客户' })
    receivableAdd(store, { clientId: client.id, label: '私密尾款', amount: '500', dueAt: '2026-12-01', now: NOW })
    receivableAdd(store, { clientId: other.id, label: '普通尾款', amount: '100', now: NOW })
    const hidden = receivableList(store, { clearance: 1, now: NOW })
    assert.equal(hidden.total, 1, 'only the ordinary client row is visible')
    assert.equal(hidden.protectedExcluded, 1)
    assert.equal(hidden.totals[0].amountMinor, 10000, 'totals exclude hidden amounts')
    assert.ok(!JSON.stringify(hidden.receivables).includes('私密'), 'hidden labels never leak')
    assert.ok(!JSON.stringify(hidden.receivables).includes(client.id), 'hidden client ids never leak')
    const visible = receivableList(store, { clearance: 2, now: NOW })
    assert.equal(visible.total, 2)
    assert.equal(visible.protectedExcluded, 0)
    // A matter-level secrecy above the client default also hides the row.
    const otherMatterId = visible.receivables.find((row) => row.clientId === other.id).matterId
    store.mutate(() => store.updateMatter(otherMatterId, { secrecy: 3 }))
    assert.equal(receivableList(store, { clearance: 2, now: NOW }).protectedExcluded, 1)
    assert.equal(receivableList(store, { clearance: 3, now: NOW }).total, 2)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('status, due-within and limit filters; settled and written-off rows leave the unsettled totals', () => {
  const { root, store } = setup()
  try {
    const client = store.addClient({ name: '筛选客户' })
    const rows = seedAging(store, client.id)
    const paid = receivableAdd(store, { clientId: client.id, label: '已结清', amount: '100', dueAt: '2026-11-20', now: NOW })
    paymentAdd(store, { clientId: client.id, amount: '100', receivableId: paid.receivable.id, now: NOW })
    // written_off_at is a 0.4.1 write surface; the stored tombstone is handled now.
    store.db.prepare('UPDATE receivables SET written_off_at = ? WHERE id = ?').run('2026-11-20T00:00:00.000Z', rows.overduePlus.id)

    const overdue = receivableList(store, { clientId: client.id, status: 'overdue', now: NOW })
    assert.equal(overdue.total, 3)
    const settled = receivableList(store, { clientId: client.id, status: 'settled', now: NOW })
    assert.equal(settled.total, 1)
    assert.equal(settled.totals[0].settledCount, 1)
    const written = receivableList(store, { clientId: client.id, status: 'written_off', now: NOW })
    assert.equal(written.total, 1)
    assert.equal(written.receivables[0].outstanding, '0.00')
    assert.equal(written.totals[0].writtenOffCount, 1)
    const unsettled = receivablesSummary(store, { clientId: client.id, status: 'unsettled', now: NOW })
    assert.equal(unsettled.unsettled, 5)
    assert.equal(unsettled.writtenOff, 0, 'written-off rows are not unsettled')
    // due-within includes overdue rows and excludes the far future / undated ones.
    const dueSoon = receivableList(store, { clientId: client.id, dueWithin: '10d', now: NOW })
    assert.deepEqual(dueSoon.receivables.map((row) => row.label).sort(), ['已结清', '逾期 119 天', '逾期 44 天', '逾期 74 天', '逾期 9 天'].sort())
    // limit + total/truncated.
    const limited = receivableList(store, { clientId: client.id, limit: 2, now: NOW })
    assert.equal(limited.receivables.length, 2)
    assert.equal(limited.total, 7)
    assert.equal(limited.truncated, true)
    assert.equal(limited.limit, 2)
    // Currency filter.
    assert.equal(receivableList(store, { clientId: client.id, currency: 'USD', now: NOW }).total, 0)
    assert.throws(() => receivableList(store, { status: 'weird' }), /status must be one of/)
    assert.throws(() => receivableList(store, { limit: 0 }), /limit/)
    assert.throws(() => receivableList(store, { dueWithin: 'soon' }), /due-within/)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('clientReceivablesBlock is the additive client-show aggregation', () => {
  const { root, store } = setup()
  try {
    const client = store.addClient({ name: '聚合客户' })
    receivableAdd(store, { clientId: client.id, label: '逾期尾款', amount: '100', dueAt: '2026-11-01', now: NOW })
    receivableAdd(store, { clientId: client.id, label: '未来尾款', amount: '200', dueAt: '2026-12-20', now: NOW })
    const settled = receivableAdd(store, { clientId: client.id, label: '已结清', amount: '50', now: NOW })
    paymentAdd(store, { clientId: client.id, amount: '50', receivableId: settled.receivable.id, now: NOW })
    const block = clientReceivablesBlock(store, client.id, { now: NOW })
    assert.deepEqual(Object.keys(block).sort(), ['count', 'nextDueAt', 'overdueCount', 'protectedExcluded', 'totals'])
    assert.equal(block.count, 2, 'count = unsettled receivables')
    assert.equal(block.overdueCount, 1)
    assert.equal(block.protectedExcluded, 0)
    assert.equal(block.totals.length, 1)
    assert.equal(block.totals[0].currency, 'CNY')
    assert.equal(block.totals[0].amountMinor, 35000)
    assert.equal(block.totals[0].outstandingMinor, 30000)
    assert.match(block.nextDueAt, /^2026-11-01T23:59:59\.999\+08:00$/)
    // Unknown client is an empty block, not an error (bin resolves the client).
    assert.equal(clientReceivablesBlock(store, 'cl_missing').count, 0)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('integration helpers: archive precondition, merge re-pointing, read-only reads and audited writes', () => {
  const { root, store } = setup()
  try {
    const source = store.addClient({ name: '源客户' })
    const target = store.addClient({ name: '目标客户' })
    const made = receivableAdd(store, { clientId: source.id, label: '尾款', amount: '100', now: NOW })
    paymentAdd(store, { clientId: source.id, amount: '40', receivableId: made.receivable.id, now: NOW })
    assert.equal(openReceivablesCount(store, source.id, { now: NOW }), 1)
    assert.equal(openReceivablesCount(store, target.id, { now: NOW }), 0)

    // Merge order: matters move first, then the money helper re-points rows.
    store.db.prepare('UPDATE matters SET client_id = ? WHERE client_id = ?').run(target.id, source.id)
    store.transaction(() => {
      const moved = moveClientMoneyRows(store, source.id, target.id)
      assert.deepEqual(moved, { movedReceivables: 1, movedPayments: 1 })
    })
    assert.equal(store.db.prepare('SELECT client_id FROM receivables WHERE id = ?').get(made.receivable.id).client_id, target.id)
    assert.equal(store.db.prepare('SELECT client_id FROM payments').get().client_id, target.id)
    assert.throws(() => moveClientMoneyRows(store, source.id, source.id), /E_CLIENT_MERGE_SELF/)

    // Every write command produced exactly one audit row.
    const audit = store.listAudit(50)
    assert.deepEqual(audit.map((row) => row.action).reverse(), ['receivable.add', 'payment.add'])
    const auditText = JSON.stringify(audit)
    assert.ok(!auditText.includes('100.00'))
    assert.ok(!auditText.includes('源客户'))

    // Read-only store: reads work, writes fail closed with E_READ_ONLY.
    store.close()
    const readStore = openReadStore(join(root, 'state.db'))
    try {
      assert.equal(receivableList(readStore, { now: NOW }).total, 1)
      assert.equal(paymentList(readStore, { now: NOW }).total, 1)
      assert.throws(() => receivableAdd(readStore, { clientId: target.id, label: 'x', amount: '1' }), /E_READ_ONLY/)
    } finally {
      readStore.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('settled by money but completed manually: a payment void never reopens someone else close', () => {
  const { root, store } = setup()
  try {
    const client = store.addClient({ name: '手工完成' })
    const made = receivableAdd(store, { clientId: client.id, label: '尾款', amount: '100', now: NOW })
    // The operator completes the commitment manually before the money arrives.
    store.mutate(() => {
      const commitment = store.getCommitment(made.receivable.commitmentId)
      store.updateCommitment(commitment.id, { status: 'done', doneAt: NOW, evidence: [...commitment.evidence, { kind: 'manual', quote: 'done', quoteSha256: 'x' }] })
    })
    const paid = paymentAdd(store, { clientId: client.id, amount: '100', receivableId: made.receivable.id, now: NOW })
    assert.equal(paid.completedCommitment, false)
    assert.equal(paid.receivable.state, 'settled')
    assert.equal(paid.receivable.closedByPaymentId, undefined)
    const voided = paymentVoid(store, paid.payment.id, { now: NOW })
    assert.equal(voided.reopenedCommitment, false)
    assert.equal(store.getCommitment(made.receivable.commitmentId).status, 'done')
    // The receivable can be voided once the payment is gone.
    assert.equal(receivableVoid(store, made.receivable.id, { now: NOW }).receivable.state, 'void')
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
