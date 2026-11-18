import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function env(home, extra = {}) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra })
}
function cli(home, args, extra = {}) {
  return execFileSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8' })
}
function cliFail(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8' })
}
function setup(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-quote-' + prefix + '-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  return { root, home, work }
}
function writeData(work, name, data) {
  const file = join(work, name)
  writeFileSync(file, JSON.stringify(data, null, 2))
  return file
}
function baseQuote(overrides = {}) {
  return {
    issuedAt: '2026-11-18',
    validUntil: '2026-12-02',
    currency: 'CNY',
    issuer: { name: 'PerryLink 顾问工作室', contact: 'Perry' },
    client: { name: '王工', company: '王工科技' },
    project: { name: '官网改版', summary: '官网信息架构与视觉改版', deliverables: ['信息架构', '视觉稿'] },
    items: [{ desc: '需求调研', qty: '1', unit: '项', unitPrice: '8000.00' }],
    ...overrides,
  }
}

test('quote DOCX/XLSX generate, structurally verify and format money as integer cents', () => {
  const s = setup('totals')
  try {
    const cases = [
      {
        name: 'plain',
        data: baseQuote({ items: [{ desc: '需求调研', qty: '2', unit: '项', unitPrice: '1234.56' }] }),
        totals: { subtotal: '2,469.12', discount: '0.00', tax: '0.00', total: '2,469.12' },
      },
      {
        name: 'discount-tax',
        data: baseQuote({
          items: [
            { desc: '需求调研', qty: '1', unit: '项', unitPrice: '8000.00' },
            { desc: '视觉设计', qty: '2', unit: '版', unitPrice: '12000.50' },
          ],
          discount: { kind: 'percent', value: '10' },
          tax: { mode: 'exclusive', ratePct: '6' },
        }),
        totals: { subtotal: '32,001.00', discount: '3,200.10', tax: '1,728.05', total: '30,528.95' },
      },
      {
        name: 'inclusive',
        data: baseQuote({
          items: [{ desc: '设计', qty: '1', unit: '项', unitPrice: '1060.00' }],
          discount: { kind: 'amount', value: '60.00' },
          tax: { mode: 'inclusive', ratePct: '6' },
        }),
        totals: { subtotal: '1,060.00', discount: '60.00', tax: '56.60', total: '1,000.00' },
      },
    ]
    for (const entry of cases) {
      const dataFile = writeData(s.work, entry.name + '.json', entry.data)
      const out = join(s.work, entry.name + '.docx')
      const result = JSON.parse(cli(s.home, ['template', 'quote', dataFile, out, '--json']))
      assert.equal(result.ok, true)
      assert.equal(result.template, 'quote')
      assert.equal(result.format, 'docx')
      assert.equal(result.templateVersion, '1')
      assert.match(result.dataSha256, /^[0-9a-f]{64}$/)
      assert.equal(result.quoteNo, 'Q-20261118-001')
      assert.deepEqual({
        subtotal: result.totals.subtotal,
        discount: result.totals.discount,
        tax: result.totals.tax,
        total: result.totals.total,
      }, entry.totals)
      assert.equal(result.verify.structure.ok, true)
      assert.equal(result.verify.content.ok, true)
      assert.ok(existsSync(out))
    }
    const xlsx = join(s.work, 'plain.xlsx')
    const xlsxResult = JSON.parse(cli(s.home, ['template', 'quote', join(s.work, 'plain.json'), xlsx, '--json']))
    assert.equal(xlsxResult.format, 'xlsx')
    assert.equal(xlsxResult.verify.structure.ok, true)
    assert.deepEqual(xlsxResult.totals, JSON.parse(cli(s.home, ['template', 'quote', join(s.work, 'plain.json'), join(s.work, 'plain-again.docx'), '--json'])).totals)
    const xlsxVerified = JSON.parse(cli(s.home, ['verify', xlsx, '--content', '--template', 'quote', '--data', join(s.work, 'plain.json')]))
    assert.equal(xlsxVerified.content.ok, true, 'XLSX totals are re-checkable too')
    const delivered = JSON.parse(cli(s.home, ['template', 'quote', join(s.work, 'plain.json'), join(s.work, 'plain-delivered.docx'), '--record-delivery', '--json']))
    assert.match(delivered.deliveryId, /^del_/)
    const rows = JSON.parse(cli(s.home, ['deliveries', '--json']))
    assert.ok(rows.some((row) => row.tool === 'template:quote' && row.title === '报价单'))
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('verify --content --template re-checks totals/data hash and detects a tampered -data', () => {
  const s = setup('verify')
  try {
    const data = baseQuote()
    const dataFile = writeData(s.work, 'quote.json', data)
    const docx = join(s.work, 'quote.docx')
    cli(s.home, ['template', 'quote', dataFile, docx])
    const verified = JSON.parse(cli(s.home, ['verify', docx, '--content', '--template', 'quote', '--data', dataFile]))
    assert.equal(verified.content.ok, true)
    const checks = verified.content.checks.filter((check) => String(check.id).startsWith('quote.'))
    assert.deepEqual(checks.map((check) => check.id), ['quote.required', 'quote.totals', 'quote.data_hash', 'quote.no_placeholders'])
    for (const check of checks) assert.equal(check.ok, true, check.id + ': ' + (check.detail ?? ''))
    assert.equal(verified.content.template.totals.total, '8,000.00')
    const tampered = { ...data, items: [{ desc: '需求调研', qty: '1', unit: '项', unitPrice: '8000.01' }] }
    const tamperedFile = writeData(s.work, 'tampered.json', tampered)
    const mismatch = cliFail(s.home, ['verify', docx, '--content', '--template', 'quote', '--data', tamperedFile])
    assert.equal(mismatch.status, 1)
    const parsed = JSON.parse(mismatch.stdout)
    assert.equal(parsed.content.checks.find((check) => check.id === 'quote.totals').ok, false)
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('proposal DOCX renders required SOW sections and verifies --content', () => {
  const s = setup('proposal')
  try {
    const data = {
      issuedAt: '2026-11-18',
      validUntil: '2026-12-02',
      currency: 'CNY',
      issuer: { name: 'PerryLink 顾问工作室' },
      client: { name: '王工' },
      project: { name: '官网改版', summary: '官网信息架构与视觉改版', deliverables: ['信息架构', '视觉稿'] },
      scope: { included: ['需求调研'], excluded: ['后端开发'], assumptions: ['客户提供素材'] },
      timeline: [{ name: '阶段一', start: '2026-11-20', end: '2026-11-27' }],
    }
    const dataFile = writeData(s.work, 'proposal.json', data)
    const docx = join(s.work, 'proposal.docx')
    const generated = JSON.parse(cli(s.home, ['template', 'proposal', dataFile, docx, '--json']))
    assert.equal(generated.ok, true)
    assert.equal(generated.verify.content.ok, true)
    assert.equal(generated.verify.content.findings.length, 0)
    const verified = JSON.parse(cli(s.home, ['verify', docx, '--content', '--template', 'proposal', '--data', dataFile]))
    assert.equal(verified.content.ok, true)
    for (const check of verified.content.checks.filter((row) => String(row.id).startsWith('proposal.'))) assert.equal(check.ok, true, check.id)
    const wrongExt = cliFail(s.home, ['template', 'proposal', dataFile, join(s.work, 'proposal.xlsx')])
    assert.equal(wrongExt.status, 1)
    assert.match(wrongExt.stderr, /E_TEMPLATE_OUTPUT/)
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('invalid template data fails before writing any output file', () => {
  const s = setup('invalid')
  try {
    const cases = [
      { name: 'bad-date', data: baseQuote({ validUntil: '2026-11-01' }), code: /E_TEMPLATE_INVALID/ },
      { name: 'bad-amount', data: baseQuote({ items: [{ desc: 'x', qty: '1', unit: '项', unitPrice: '8000.000' }] }), code: /E_AMOUNT|E_TEMPLATE_INVALID/ },
      { name: 'unknown-field', data: { ...baseQuote(), surprise: true }, code: /E_TEMPLATE_INVALID/ },
      { name: 'missing-client', data: { ...baseQuote(), client: { company: '无名字' } }, code: /E_TEMPLATE_INVALID/ },
    ]
    for (const entry of cases) {
      const dataFile = writeData(s.work, entry.name + '.json', entry.data)
      const out = join(s.work, entry.name + '.docx')
      const failed = cliFail(s.home, ['template', 'quote', dataFile, out])
      assert.equal(failed.status, 1, entry.name + ' must fail')
      assert.match(failed.stderr, entry.code)
      assert.equal(existsSync(out), false, entry.name + ' must not leave an output file')
    }
    // Decimal strings are mandatory: a JSON number is rejected, never coerced.
    const numericAmount = baseQuote({ items: [{ desc: 'x', qty: '1', unit: '项', unitPrice: 8000 }] })
    const numericFile = writeData(s.work, 'numeric.json', numericAmount)
    const numericFail = cliFail(s.home, ['template', 'quote', numericFile, join(s.work, 'numeric.docx')])
    assert.equal(numericFail.status, 1)
    assert.match(numericFail.stderr, /E_AMOUNT|E_TEMPLATE_INVALID/)
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})
