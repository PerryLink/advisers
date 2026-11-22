import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CSV_PROFILE,
  CSV_VERSION,
  GENERIC_COLUMNS,
  buildReceivableCsv,
  exportReceivablesCsv,
} from '../lib/receivable-csv.js'
import { receivableAdd } from '../lib/receivables.js'
import { SqliteStore } from '../lib/sqlite.js'

// Receivable CSV export (0.4.3 spec 93 section 5): RFC 4180, generic columns,
// deterministic order, optional BOM, formula-injection guarding, clearance
// before counting. The store tests use a mktemp SQLite home; the real
// ~/.advisers is never opened.

const NOW = '2026-11-21T00:00:00.000Z'
const LATER = '2026-12-01T00:00:00.000Z'
const HEADER = 'receivable_id,client_name,date,label,currency,amount,paid,outstanding,due_at,state,overdue_days,kind,quote_no,delivery_id,commitment_id,memo'

function row(overrides = {}) {
  return {
    id: 'rcv_0000000000000001',
    clientName: '王工',
    label: '尾款',
    currency: 'CNY',
    amount: '8000.00',
    paid: '0.00',
    outstanding: '8000.00',
    state: 'open',
    dueAt: '2026-12-15',
    overdueDays: null,
    kind: 'milestone',
    createdAt: '2026-11-21T00:00:00.000Z',
    commitmentId: 'cm_1',
    ...overrides,
  }
}

/** Minimal RFC 4180 reader used to prove the emitted quoting round-trips. */
function parseCsv(text) {
  let source = text
  if (source.charCodeAt(0) === 0xFEFF) source = source.slice(1)
  const records = []
  let record = []
  let field = ''
  let quoted = false
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"') {
      quoted = true
      index += 1
      continue
    }
    if (char === ',') {
      record.push(field)
      field = ''
      index += 1
      continue
    }
    if (char === '\r' && source[index + 1] === '\n') {
      record.push(field)
      records.push(record)
      record = []
      field = ''
      index += 2
      continue
    }
    field += char
    index += 1
  }
  if (field !== '' || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records
}

function errorOf(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  assert.fail('expected the call to throw')
}

function toObjects(csv) {
  const records = parseCsv(csv)
  const header = records[0]
  return records.slice(1).map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index]])))
}

/* ------------------------------------------------------------------ *
 * Format, header and determinism.
 * ------------------------------------------------------------------ */

test('buildReceivableCsv: generic v1 header with CRLF records and no totals', () => {
  assert.equal(CSV_VERSION, 1)
  assert.equal(CSV_PROFILE, 'generic')
  assert.equal(GENERIC_COLUMNS.length, 16)
  assert.deepEqual(GENERIC_COLUMNS, HEADER.split(','))
  const built = buildReceivableCsv([row(), row({ id: 'rcv_0000000000000002', label: '首款' })])
  assert.equal(built.csvVersion, 1)
  assert.equal(built.profile, 'generic')
  assert.equal(built.rowCount, 2)
  assert.equal(built.bom, false)
  assert.ok(built.csv.startsWith(HEADER + '\r\n'))
  assert.ok(built.csv.endsWith('\r\n'))
  assert.equal(built.bytes, Buffer.byteLength(built.csv, 'utf8'))
  assert.ok(!built.csv.includes('合计'), 'no totals row')
  assert.equal(parseCsv(built.csv).length, 3)
})

test('buildReceivableCsv: empty rows render the header only', () => {
  const built = buildReceivableCsv([])
  assert.equal(built.rowCount, 0)
  assert.equal(built.csv, HEADER + '\r\n')
})

test('buildReceivableCsv: deterministic order (overdue, due asc, createdAt desc, id)', () => {
  const rows = [
    row({ id: 'rcv_e', label: '无到期' }),
    row({ id: 'rcv_b', label: '12-01 旧', dueAt: '2026-12-01', createdAt: '2026-11-01T00:00:00.000Z' }),
    row({ id: 'rcv_a', label: '逾期', state: 'overdue', dueAt: '2026-11-20', overdueDays: 11 }),
    row({ id: 'rcv_c', label: '11-25', dueAt: '2026-11-25' }),
    row({ id: 'rcv_d', label: '12-01 新', dueAt: '2026-12-01', createdAt: '2026-11-05T00:00:00.000Z' }),
    row({ id: 'rcv_f', label: '12-01 同刻 B', dueAt: '2026-12-01', createdAt: '2026-11-05T00:00:00.000Z' }),
  ]
  // Drop the no-due row's dueAt to null so it sorts last.
  rows[0].dueAt = null
  const built = buildReceivableCsv(rows)
  assert.deepEqual(toObjects(built.csv).map((entry) => entry.receivable_id), ['rcv_a', 'rcv_c', 'rcv_d', 'rcv_f', 'rcv_b', 'rcv_e'])
  // The input order is untouched.
  assert.deepEqual(rows.map((entry) => entry.id), ['rcv_e', 'rcv_b', 'rcv_a', 'rcv_c', 'rcv_d', 'rcv_f'])
  // Two runs are byte-identical.
  assert.equal(buildReceivableCsv(rows).csv, built.csv)
})

test('buildReceivableCsv: optional UTF-8 BOM for spreadsheet apps', () => {
  const plain = buildReceivableCsv([row()])
  const withBom = buildReceivableCsv([row()], { bom: true })
  assert.notEqual(plain.csv.charCodeAt(0), 0xFEFF)
  assert.equal(withBom.csv.charCodeAt(0), 0xFEFF)
  assert.equal(withBom.bom, true)
  assert.equal(withBom.csv.slice(1), plain.csv)
  assert.equal(withBom.bytes, Buffer.byteLength(withBom.csv, 'utf8'))
})

/* ------------------------------------------------------------------ *
 * RFC 4180 quoting and formula-injection defence.
 * ------------------------------------------------------------------ */

test('buildReceivableCsv: escapes comma, quote, CR/LF and keeps Chinese text', () => {
  const built = buildReceivableCsv([
    row({
      label: '付款 "首期", 含逗号',
      memo: 'line1\r\nline2',
      clientName: '王工（上海）',
    }),
    row({ id: 'rcv_0000000000000009', label: '纯文本', memo: 'say "hi"' }),
    row({ id: 'rcv_0000000000000010', label: '普通', memo: 'bare\nnewline' }),
  ])
  const records = toObjects(built.csv)
  assert.equal(records[0].label, '付款 "首期", 含逗号')
  assert.equal(records[0].memo, 'line1\r\nline2')
  assert.equal(records[0].client_name, '王工（上海）')
  assert.equal(records[1].memo, 'say "hi"')
  assert.equal(records[2].memo, 'bare\nnewline')
  assert.ok(built.csv.includes('"付款 ""首期"", 含逗号"'))
  assert.ok(built.csv.includes('"say ""hi"""'))
})

test('buildReceivableCsv: neutralises spreadsheet formulas with a leading apostrophe', () => {
  const built = buildReceivableCsv([
    row({ label: '=1+1', memo: '+cmd', clientName: '@SUM(A1)' }),
    row({ id: 'rcv_0000000000000011', label: '-2-3', memo: 'ok' }),
  ])
  const records = toObjects(built.csv)
  assert.equal(records[0].label, "'=1+1")
  assert.equal(records[0].memo, "'+cmd")
  assert.equal(records[0].client_name, "'@SUM(A1)")
  assert.equal(records[1].label, "'-2-3")
  assert.equal(records[1].memo, 'ok')
  // The header row is never rewritten.
  assert.equal(parseCsv(built.csv)[0][0], 'receivable_id')
})

/* ------------------------------------------------------------------ *
 * Dates, money, quote numbers.
 * ------------------------------------------------------------------ */

test('buildReceivableCsv: dates render as Asia/Shanghai YYYY-MM-DD', () => {
  const built = buildReceivableCsv([
    row({ createdAt: '2026-11-21T18:30:00.000Z', dueAt: '2026-12-15' }),
    row({ id: 'rcv_0000000000000012', createdAt: '2026-11-20T00:00:00.000Z', dueAt: '2026-12-15T00:00:00.000Z' }),
    row({ id: 'rcv_0000000000000013', createdAt: '2026-11-20T00:00:00.000Z', dueAt: '2026-12-15T09:00:00' }),
    row({ id: 'rcv_0000000000000014', createdAt: '2026-11-20T00:00:00.000Z', dueAt: null }),
  ])
  const records = toObjects(built.csv)
  assert.equal(records.find((entry) => entry.receivable_id === 'rcv_0000000000000001').date, '2026-11-22')
  assert.equal(records.find((entry) => entry.receivable_id === 'rcv_0000000000000001').due_at, '2026-12-15')
  assert.equal(records.find((entry) => entry.receivable_id === 'rcv_0000000000000012').due_at, '2026-12-15')
  assert.equal(records.find((entry) => entry.receivable_id === 'rcv_0000000000000013').due_at, '2026-12-15')
  assert.equal(records.find((entry) => entry.receivable_id === 'rcv_0000000000000014').due_at, '')
})

test('buildReceivableCsv: money strings, minor-unit fallback and empty cells', () => {
  const built = buildReceivableCsv([
    row(),
    row({ id: 'rcv_0000000000000015', amount: undefined, amountMinor: 123456, paid: undefined, paidMinor: 3456, outstanding: undefined, outstandingMinor: 120000, overdueDays: 7 }),
    row({ id: 'rcv_0000000000000016', memo: undefined, kind: undefined, commitmentId: undefined, clientName: undefined }),
  ])
  const records = toObjects(built.csv)
  assert.equal(records[0].amount, '8000.00')
  assert.equal(records[0].paid, '0.00')
  assert.equal(records[0].outstanding, '8000.00')
  assert.equal(records[1].amount, '1234.56')
  assert.equal(records[1].paid, '34.56')
  assert.equal(records[1].outstanding, '1200.00')
  assert.equal(records[1].overdue_days, '7')
  assert.equal(records[2].memo, '')
  assert.equal(records[2].client_name, '')
})

test('buildReceivableCsv: quote_no only through the delivery link, never guessed', () => {
  const map = new Map([['dlv_1', 'Q-20261121-001']])
  const built = buildReceivableCsv([
    row({ id: 'rcv_0000000000000017', deliveryId: 'dlv_1', quoteNo: 'Q-DIRECT' }),
    row({ id: 'rcv_0000000000000018', deliveryId: 'dlv_1' }),
    row({ id: 'rcv_0000000000000019', deliveryId: 'dlv_missing' }),
    row({ id: 'rcv_0000000000000020' }),
  ], { quoteNoByDeliveryId: map })
  const records = toObjects(built.csv)
  assert.equal(records[0].quote_no, 'Q-DIRECT')
  assert.equal(records[1].quote_no, 'Q-20261121-001')
  assert.equal(records[2].quote_no, '')
  assert.equal(records[3].quote_no, '')
})

test('buildReceivableCsv: unsupported profile and bad shapes are rejected', () => {
  const error = errorOf(() => buildReceivableCsv([row()], { profile: 'xero' }))
  assert.equal(error.code, 'E_RECEIVABLE_INVALID')
  assert.throws(() => buildReceivableCsv(null), TypeError)
  assert.throws(() => buildReceivableCsv([null]), TypeError)
})

/* ------------------------------------------------------------------ *
 * Store-aware export: filters, clearance, quote link, truncation.
 * ------------------------------------------------------------------ */

function setupStore() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-receivable-csv-'))
  const store = new SqliteStore(join(root, 'state.db'))
  return { root, store }
}

function seedDelivery(store, client, matter, id, quoteNo) {
  store.mutate(() => {
    store.db.prepare('INSERT INTO deliveries(id,matter_id,conversation_id,files,tool,title,validation,created_at,client_id,project_id,template_name,template_version,quote_no,data_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, matter.id, 'conv_1', '[]', 'template quote', '报价单', 'ok', NOW, client.id, null, 'quote', '2', quoteNo, null)
  })
}

test('exportReceivablesCsv: reads the store, links quote_no and orders rows', () => {
  const { root, store } = setupStore()
  try {
    const client = store.addClient({ name: '王工', secrecyDefault: 0 })
    let matter = null
    store.mutate(() => {
      matter = store.insertMatter({
        id: 'mat_1',
        title: '项目',
        status: 'active',
        domain: 'customer',
        secrecy: 0,
        clientId: client.id,
        participants: [],
        deadlines: [],
        openQuestions: [],
        createdAt: NOW,
        updatedAt: NOW,
      })
    })
    seedDelivery(store, client, matter, 'dlv_1', 'Q-20261121-001')
    const older = receivableAdd(store, {
      clientId: client.id,
      matterId: matter.id,
      deliveryId: 'dlv_1',
      label: '尾款',
      amount: '8000.00',
      dueAt: '2026-11-20',
      now: NOW,
    })
    const newer = receivableAdd(store, {
      clientId: client.id,
      label: '预付款',
      amount: '1000.00',
      dueAt: '2026-12-15',
      now: NOW,
    })
    assert.equal(older.receivable.state, 'overdue')
    assert.equal(newer.receivable.state, 'open')

    const payload = exportReceivablesCsv(store, { clientId: client.id, now: LATER })
    assert.equal(payload.ok, true)
    assert.equal(payload.command, 'receivable export')
    assert.equal(payload.csvVersion, 1)
    assert.equal(payload.profile, 'generic')
    assert.equal(payload.bom, false)
    assert.equal(payload.rowCount, 2)
    assert.equal(payload.total, 2)
    assert.equal(payload.clearance, 3)
    assert.equal(payload.protectedExcluded, 0)
    assert.equal(payload.bytes, Buffer.byteLength(payload.csv, 'utf8'))
    const records = toObjects(payload.csv)
    assert.deepEqual(records.map((entry) => entry.label), ['尾款', '预付款'])
    assert.equal(records[0].state, 'overdue')
    assert.equal(records[0].quote_no, 'Q-20261121-001')
    assert.equal(records[0].delivery_id, 'dlv_1')
    assert.equal(records[1].quote_no, '')
    assert.equal(records[0].amount, '8000.00')
    // Two runs are byte-identical.
    assert.equal(exportReceivablesCsv(store, { clientId: client.id, now: LATER }).csv, payload.csv)
    // Filters compose: status/currency/dueWithin.
    assert.equal(exportReceivablesCsv(store, { clientId: client.id, status: 'settled', now: LATER }).rowCount, 0)
    assert.equal(exportReceivablesCsv(store, { clientId: client.id, currency: 'USD', now: LATER }).rowCount, 0)
    assert.equal(exportReceivablesCsv(store, { clientId: client.id, dueWithin: '7d', now: LATER }).rowCount, 1)
    // --bom is an explicit opt-in and the flag is reported in the payload.
    const bomPayload = exportReceivablesCsv(store, { clientId: client.id, now: LATER, bom: true })
    assert.equal(bomPayload.bom, true)
    assert.equal(bomPayload.csv.charCodeAt(0), 0xFEFF)
    assert.equal(bomPayload.bytes, Buffer.byteLength(bomPayload.csv, 'utf8'))
  } finally {
    try { store.db.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportReceivablesCsv: clearance filters first and only counts hidden rows', () => {
  const { root, store } = setupStore()
  try {
    const client = store.addClient({ name: '机密客户', secrecyDefault: 2 })
    receivableAdd(store, { clientId: client.id, label: '尾款', amount: '10.00', now: NOW })
    receivableAdd(store, { clientId: client.id, label: '首款', amount: '20.00', now: NOW })
    const hidden = exportReceivablesCsv(store, { clientId: client.id, clearance: 1, now: LATER })
    assert.equal(hidden.rowCount, 0)
    assert.equal(hidden.total, 0)
    assert.equal(hidden.protectedExcluded, 2)
    assert.equal(hidden.csv, HEADER + '\r\n')
    const visible = exportReceivablesCsv(store, { clientId: client.id, clearance: 2, now: LATER })
    assert.equal(visible.rowCount, 2)
    assert.equal(visible.clearance, 2)
    // No client name leaks through the protected path.
    assert.ok(!hidden.csv.includes('机密客户'))
  } finally {
    try { store.db.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportReceivablesCsv: more matching rows than the cap fails closed', () => {
  const { root, store } = setupStore()
  try {
    const client = store.addClient({ name: '王工', secrecyDefault: 0 })
    receivableAdd(store, { clientId: client.id, label: '一', amount: '1.00', now: NOW })
    receivableAdd(store, { clientId: client.id, label: '二', amount: '2.00', now: NOW })
    const error = errorOf(() => exportReceivablesCsv(store, { clientId: client.id, now: LATER, limit: 1 }))
    assert.equal(error.code, 'E_RECEIVABLE_INVALID')
    assert.match(error.message, /narrow the filter/)
    // The default cap covers both rows.
    assert.equal(exportReceivablesCsv(store, { clientId: client.id, now: LATER }).rowCount, 2)
  } finally {
    try { store.db.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})
