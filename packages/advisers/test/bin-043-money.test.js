/**
 * 0.4.3 (043-5, plan 93 §3/§5): quote/proposal schema v2 payment.channels and
 * `receivable export --csv`.
 *
 * v2 is explicit opt-in: v1 data keeps templateVersion "1", rejects `channels`
 * as an unknown field, and gets no new verify checks. v2 channels are validated
 * (masked accounts only, https + stripe.com/wise.com links), rendered into the
 * document, and re-checked by `verify --content`. The CSV export never writes a
 * default HOME path, is RFC4180/CRLF with deterministic rows, and the --json
 * metadata carries no client names and no amounts.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_ACCEPT_TOS: '1', ADVISERS_NO_MODEL: '1', ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1' }

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'advisers-043-money-'))
}

function run(home, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home },
    encoding: 'utf8', input: '', timeout: 180000,
  })
}

function json(result) {
  return JSON.parse(result.stdout)
}

function baseQuote(extra = {}) {
  return {
    issuedAt: '2026-11-18',
    validUntil: '2026-12-02',
    currency: 'CNY',
    issuer: { name: 'PerryLink 顾问工作室', contact: 'Perry' },
    client: { name: '王工', company: '王工科技' },
    project: { name: '官网改版', deliverables: ['信息架构', '视觉稿'] },
    items: [{ desc: '需求调研', qty: '1', unit: '项', unitPrice: '8000.00' }],
    ...extra,
  }
}

const V2_QUOTE = baseQuote({
  schemaVersion: 2,
  payment: {
    terms: '验收后 15 日内付清',
    channels: [
      { kind: 'bank', label: '对公账户', bankName: '招商银行', accountName: 'PerryLink', accountMasked: '尾号1234' },
      { kind: 'stripe_link', label: '在线支付', url: 'https://buy.stripe.com/test_abc' },
    ],
  },
})

test('quote schema v2 builds with templateVersion 2 and verifies its payment channels', () => {
  const home = makeHome()
  try {
    const dataFile = join(home, 'v2.json')
    writeFileSync(dataFile, JSON.stringify(V2_QUOTE, null, 2))
    const out = join(home, 'v2.docx')
    const built = run(home, ['template', 'quote', dataFile, out, '--json'])
    assert.equal(built.status, 0, built.stderr)
    const payload = json(built)
    assert.equal(payload.templateVersion, '2')
    assert.match(payload.dataSha256, /^[0-9a-f]{64}$/)
    const verified = run(home, ['verify', out, '--content', '--template', 'quote', '--data', dataFile])
    assert.equal(verified.status, 0, verified.stderr)
    const document = json(verified).content
    assert.equal(document.ok, true)
    assert.equal(document.template.version, '2')
    const byId = new Map(document.checks.map((check) => [check.id, check]))
    for (const id of ['quote.payment_channels', 'quote.payment_url', 'quote.no_full_account', 'quote.data_hash']) {
      assert.ok(byId.has(id), 'v2 verify emits ' + id)
      assert.equal(byId.get(id).ok, true, id + ' passes for a valid v2 quote')
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('v1 data rejects the v2 channels field (no silent v1 behaviour change)', () => {
  const home = makeHome()
  try {
    const dataFile = join(home, 'v1-with-channels.json')
    writeFileSync(dataFile, JSON.stringify(baseQuote({ payment: { channels: [{ kind: 'bank', accountMasked: '尾号1234' }] } }), null, 2))
    const result = run(home, ['template', 'quote', dataFile, join(home, 'x.docx')])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /E_TEMPLATE_INVALID/)
    assert.match(result.stderr, /unknown field: payment\.channels/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('v2 channel validation rejects full accounts and unsafe links before writing', () => {
  const home = makeHome()
  try {
    const cases = [
      [{ kind: 'bank', accountMasked: '6222021234567890123' }, 'accountMasked'],
      [{ kind: 'bank', accountMasked: '尾号1234', url: 'https://x.stripe.com/a' }, 'url'],
      [{ kind: 'stripe_link', url: 'http://buy.stripe.com/a' }, 'url'],
      [{ kind: 'stripe_link', url: 'https://buy.wise.com/a' }, 'url'],
      [{ kind: 'wechat', accountName: '微信', accountMasked: '13800138000' }, 'accountMasked'],
    ]
    for (const [channel, field] of cases) {
      const dataFile = join(home, 'bad.json')
      writeFileSync(dataFile, JSON.stringify(baseQuote({ schemaVersion: 2, payment: { channels: [channel] } }), null, 2))
      const result = run(home, ['template', 'quote', dataFile, join(home, 'bad.docx')])
      assert.equal(result.status, 1, 'invalid channel must fail: ' + JSON.stringify(channel))
      assert.match(result.stderr, /E_TEMPLATE_INVALID/)
      assert.match(result.stderr, new RegExp(field), 'error names ' + field)
    }
    const tooMany = baseQuote({ schemaVersion: 2, payment: { channels: Array.from({ length: 9 }, () => ({ kind: 'bank', accountMasked: '尾号1234' })) } })
    writeFileSync(join(home, 'many.json'), JSON.stringify(tooMany, null, 2))
    const many = run(home, ['template', 'quote', join(home, 'many.json'), join(home, 'many.docx')])
    assert.equal(many.status, 1)
    assert.match(many.stderr, /E_TEMPLATE_INVALID/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

function addClient(home, name, extra = []) {
  const result = run(home, ['client', 'add', name, '--json', ...extra])
  assert.equal(result.status, 0, result.stderr)
  return json(result).client.id
}

function seedReceivables(home) {
  const visible = addClient(home, '王工')
  const secret = addClient(home, '机密客户', ['--secrecy', '3'])
  assert.equal(run(home, ['receivable', 'add', visible, '=SUM(A1)', '--amount', '1000.50', '--due', '2026-12-01']).status, 0)
  assert.equal(run(home, ['receivable', 'add', visible, '过期尾款', '--amount', '200', '--due', '2020-01-01']).status, 0)
  assert.equal(run(home, ['receivable', 'add', secret, '机密项目尾款', '--amount', '5000', '--due', '2026-12-02']).status, 0)
  const list = json(run(home, ['receivable', 'ls', '--json']))
  const partial = list.receivables.find((row) => row.label === '=SUM(A1)')
  assert.equal(run(home, ['payment', 'add', visible, '--amount', '400', '--receivable', partial.id]).status, 0)
}

const CSV_HEADER = 'receivable_id,client_name,date,label,currency,amount,paid,outstanding,due_at,state,overdue_days,kind,quote_no,delivery_id,commitment_id,memo'

test('receivable export writes an explicit 0600 RFC4180 CSV with deterministic rows', () => {
  const home = makeHome()
  try {
    seedReceivables(home)
    const out = join(home, 'receivables.csv')
    const first = run(home, ['receivable', 'export', '--out', out])
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /csv written: .*3 rows/)
    assert.equal(statSync(out).mode & 0o777, 0o600)
    const csv = readFileSync(out, 'utf8')
    assert.ok(csv.startsWith(CSV_HEADER + '\r\n'), 'header is the documented 16 columns')
    assert.ok(csv.endsWith('\r\n'))
    const rows = csv.trimEnd().split('\r\n').slice(1)
    assert.equal(rows.length, 3)
    assert.match(rows[0], /过期尾款/, 'overdue rows sort first')
    assert.match(rows.join('\n'), /'=SUM\(A1\)/, 'formula-looking labels get a leading apostrophe')
    assert.doesNotMatch(csv, /\n[^\r]*total/i, 'no totals line')
    const second = run(home, ['receivable', 'export', '--out', join(home, 'again.csv')])
    assert.equal(second.status, 0, second.stderr)
    assert.equal(readFileSync(join(home, 'again.csv'), 'utf8'), csv, 'the same rows export byte-identically')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('receivable export --json hides names/amounts and reports protectedExcluded', () => {
  const home = makeHome()
  try {
    seedReceivables(home)
    const out = join(home, 'clearance.csv')
    const result = run(home, ['receivable', 'export', '--out', out, '--clearance', '0', '--json'])
    assert.equal(result.status, 0, result.stderr)
    const meta = json(result)
    assert.equal(meta.ok, true)
    assert.equal(meta.command, 'receivable export')
    assert.equal(meta.csvVersion, 1)
    assert.equal(meta.profile, 'generic')
    assert.equal(meta.rowCount, 2)
    assert.equal(meta.total, 2)
    assert.equal(meta.clearance, 0)
    assert.equal(meta.protectedExcluded, 1)
    assert.doesNotMatch(result.stdout, /王工|机密客户|1000\.50|5000/, 'metadata carries no client names or amounts')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('receivable export --out - streams CSV to stdout and never defaults a path', () => {
  const home = makeHome()
  try {
    seedReceivables(home)
    const streamed = run(home, ['receivable', 'export', '--out', '-'])
    assert.equal(streamed.status, 0, streamed.stderr)
    assert.ok(streamed.stdout.startsWith(CSV_HEADER + '\r\n'))
    assert.equal(streamed.stdout.trimEnd().split('\r\n').length, 4)
    const missing = run(home, ['receivable', 'export'])
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /requires --out/)
    const conflict = run(home, ['receivable', 'export', '--out', '-', '--json'])
    assert.equal(conflict.status, 1)
    assert.match(conflict.stderr, /mutually exclusive/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('receivable export --bom writes the UTF-8 BOM only when asked', () => {
  const home = makeHome()
  try {
    const client = addClient(home, '王工')
    assert.equal(run(home, ['receivable', 'add', client, '尾款', '--amount', '10', '--due', '2026-12-01']).status, 0)
    const plain = join(home, 'plain.csv')
    const bom = join(home, 'bom.csv')
    assert.equal(run(home, ['receivable', 'export', '--out', plain]).status, 0)
    assert.equal(run(home, ['receivable', 'export', '--out', bom, '--bom']).status, 0)
    assert.notEqual(readFileSync(plain, 'utf8').charCodeAt(0), 0xfeff)
    assert.equal(readFileSync(bom, 'utf8').charCodeAt(0), 0xfeff)
  } finally { rmSync(home, { recursive: true, force: true }) }
})