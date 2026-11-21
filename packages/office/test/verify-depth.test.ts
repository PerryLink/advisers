import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import {
  buildDocx,
  buildPptx,
  buildXlsx,
  checkOffice,
  readOffice,
  readOfdText,
  verifyOffice,
} from '../src/index.ts'

const MIB = 1024 * 1024

function hugeDocumentXml(targetBytes: number): string {
  const head = '<w:document><w:body>'
  const tail = '</w:body></w:document>'
  const unit = '<w:p><w:r><w:t>zip-bomb</w:t></w:r></w:p>'
  const count = Math.ceil((targetBytes - head.length - tail.length) / unit.length)
  return head + unit.repeat(count) + tail
}

function hugeOfdXml(targetBytes: number): string {
  const head = '<?xml version="1.0"?><ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content>'
  const tail = '</ofd:Content></ofd:Page>'
  const unit = '<ofd:TextObject><ofd:TextCode>zip-bomb</ofd:TextCode></ofd:TextObject>'
  const count = Math.ceil((targetBytes - head.length - tail.length) / unit.length)
  return head + unit.repeat(count) + tail
}

async function replaceZipEntry(buffer: Buffer, name: string, content: string, level = 9): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer)
  zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level } })
}

async function patchZipEntry(buffer: Buffer, name: string, transform: (current: string) => string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer)
  const entry = zip.file(name)
  assert.ok(entry, 'missing ZIP entry ' + name)
  zip.file(name, transform(await entry.async('string')))
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function rejectsWithBudget(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, pattern)
    return true
  })
}

const REVISION_XML =
  '<w:p><w:ins w:id="1" w:author="张三" w:date="2026-11-17T00:00:00Z"><w:r><w:t>新增</w:t></w:r></w:ins>' +
  '<w:del w:id="2" w:author="李四" w:date="2026-11-17T00:00:00Z"><w:r><w:delText>删除</w:delText></w:r></w:del></w:p>'

test('readOffice rejects a high-compression DOCX zip bomb above the single-entry budget', async () => {
  const base = await buildDocx({ title: 'bomb', sections: [{ heading: 'h', paragraphs: ['ok'] }] })
  const started = Date.now()
  const bomb = await replaceZipEntry(base, 'word/document.xml', hugeDocumentXml(17 * MIB))
  assert.ok(bomb.length < 256 * 1024, 'compressed bomb should stay tiny, got ' + bomb.length + ' bytes')
  await rejectsWithBudget(readOffice(bomb), /ZIP entry too large|single-entry budget/)
  assert.ok(Date.now() - started < 30_000, 'rejection should be fast, no OOM')
})

test('readOffice rejects a DOCX whose total uncompressed size exceeds the total budget', async () => {
  const base = await buildDocx({ title: 'bomb', sections: [{ paragraphs: ['ok'] }] })
  const zip = await JSZip.loadAsync(base)
  for (let i = 0; i < 5; i++) zip.file('word/media/blob' + i + '.xml', hugeDocumentXml(14 * MIB))
  const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } })
  await rejectsWithBudget(readOffice(bomb), /expands to|total|limit/)
})

test('readOffice rejects too many ZIP entries', async () => {
  const base = await buildDocx({ title: 'many', sections: [{ paragraphs: ['ok'] }] })
  const zip = await JSZip.loadAsync(base)
  for (let i = 0; i < 2000; i++) zip.file('word/media/e' + i + '.bin', 'x')
  const bomb = await zip.generateAsync({ type: 'nodebuffer' })
  await rejectsWithBudget(readOffice(bomb), /too many ZIP entries/)
})

test('readOffice rejects an XML entry above the text character budget even when it fits the byte budget', async () => {
  const base = await buildDocx({ title: 'text', sections: [{ paragraphs: ['ok'] }] })
  const inflated = await replaceZipEntry(base, 'word/document.xml', hugeDocumentXml(9 * MIB))
  await rejectsWithBudget(readOffice(inflated), /decodes to|characters|text entry/)
})

test('default ZIP budgets accept builder output and can be overridden', async () => {
  const docx = await buildDocx({ title: '报告', sections: [{ heading: '结论', paragraphs: ['预算可控'] }] })
  const xlsx = await buildXlsx({ sheet: '预算', columns: [{ header: '项目', key: 'item' }], rows: [{ item: '差旅' }] })
  const pptx = await buildPptx({ title: '汇报', slides: [{ title: '进展', bullets: ['完成'] }] })
  assert.match((await readOffice(docx)).text, /预算可控/)
  assert.match((await readOffice(xlsx)).text, /差旅/)
  assert.match((await readOffice(pptx)).text, /进展/)
  await rejectsWithBudget(readOffice(docx, 'docx', { budget: { maxEntries: 3 } }), /too many ZIP entries/)
})

test('verifyOffice reports a zip bomb through checks instead of throwing', async () => {
  const base = await buildDocx({ title: 'bomb', sections: [{ paragraphs: ['ok'] }] })
  const bomb = await replaceZipEntry(base, 'word/document.xml', hugeDocumentXml(17 * MIB))
  const result = await verifyOffice(bomb, 'docx')
  assert.equal(result.ok, false)
  assert.equal(Array.isArray(result.checks), true)
  const budgetCheck = result.checks.find((item) => item.id === 'zip.uncompressed-budget')
  assert.ok(budgetCheck)
  assert.equal(budgetCheck.ok, false)
  assert.equal(budgetCheck.severity, 'blocker')
  assert.match(budgetCheck.detail, /oversized|exceeds|MiB/i)
  assert.ok(result.missing.length >= 1)
  const checked = await checkOffice(bomb, 'docx')
  assert.equal(checked.ok, false)
  assert.ok(checked.findings.some((finding) => finding.severity === 'blocker'))
})

test('verifyOffice detects DOCX tracked changes and stays green when there are none', async () => {
  const normal = await buildDocx({ title: '报告', sections: [{ heading: '结论', paragraphs: ['正常内容'] }] })
  const clean = await verifyOffice(normal, 'docx')
  const cleanCheck = clean.checks.find((item) => item.id === 'docx.revisions')
  assert.ok(cleanCheck)
  assert.equal(cleanCheck.ok, true)
  assert.equal(cleanCheck.severity, 'warn')
  assert.match(cleanCheck.detail, /no tracked changes/)

  const revised = await patchZipEntry(normal, 'word/document.xml', (xml) => xml.replace('</w:body>', REVISION_XML + '</w:body>'))
  const result = await verifyOffice(revised, 'docx')
  assert.equal(result.ok, true, 'tracked changes are a warning, not a structural failure')
  const revisionCheck = result.checks.find((item) => item.id === 'docx.revisions')
  assert.ok(revisionCheck)
  assert.equal(revisionCheck.ok, false)
  assert.equal(revisionCheck.severity, 'warn')
  assert.match(revisionCheck.detail, /1 w:ins, 1 w:del/)
  assert.match(revisionCheck.detail, /张三/)
  assert.equal(result.checks.find((item) => item.id === 'xml.wellformed')?.ok, true)

  const checked = await checkOffice(revised, 'docx')
  assert.equal(checked.ok, true)
  assert.ok(checked.findings.some((finding) => finding.code === 'DOCX_REVISIONS' && finding.severity === 'warn'))
  assert.match((await readOffice(revised)).text, /正常内容/)
})

test('verifyOffice returns a stable machine-readable checks array with legacy fields', async () => {
  const docx = await buildDocx({ title: '报告', sections: [{ heading: '结论', paragraphs: ['正常内容'] }] })
  const first = await verifyOffice(docx, 'docx')
  const second = await verifyOffice(docx, 'docx')
  assert.equal(typeof first.ok, 'boolean')
  assert.equal(Array.isArray(first.missing), true)
  const ids = first.checks.map((item) => item.id)
  assert.deepEqual(ids, [
    'zip.entries',
    'zip.entry-paths',
    'zip.uncompressed-budget',
    'zip.text-budget',
    'xml.wellformed',
    'opc.required-parts',
    'opc.content-types',
    'opc.relationships',
    'docx.revisions',
  ])
  for (const item of first.checks) {
    assert.equal(typeof item.id, 'string')
    assert.equal(typeof item.ok, 'boolean')
    assert.ok(item.severity === 'blocker' || item.severity === 'warn' || item.severity === 'info')
    assert.equal(typeof item.detail, 'string')
  }
  assert.deepEqual(ids, second.checks.map((item) => item.id))
  assert.deepEqual(first.checks.map((item) => item.ok), second.checks.map((item) => item.ok))

  const checked = await checkOffice(docx, 'docx')
  assert.equal(Array.isArray(checked.checks), true)
  assert.ok(checked.checks.length >= first.checks.length)
  assert.equal(typeof checked.ok, 'boolean')
  assert.equal(Array.isArray(checked.findings), true)
  assert.equal(typeof checked.stats.characters, 'number')
})

test('verifyOffice reports missing XLSX formula caches and cached formula errors', async () => {
  const xlsx = await buildXlsx({
    columns: [{ header: 'A', key: 'a' }, { header: 'B', key: 'b' }],
    rows: [{ a: 1, b: 2 }],
    formulas: [{ cell: 'B3', formula: 'SUM(B2:B2)' }],
  })
  const clean = await verifyOffice(xlsx, 'xlsx')
  assert.equal(clean.ok, true)
  const cacheCheck = clean.checks.find((item) => item.id === 'xlsx.formula-cache')
  assert.ok(cacheCheck)
  assert.equal(cacheCheck.ok, false)
  assert.equal(cacheCheck.severity, 'warn')
  assert.match(cacheCheck.detail, /no cached result/)
  assert.equal(clean.checks.find((item) => item.id === 'xlsx.formula-errors')?.ok, true)

  const broken = await patchZipEntry(xlsx, 'xl/worksheets/sheet1.xml', (xml) => xml.replace('</sheetData>', '<row r="5"><c r="B5" t="e"><v>#REF!</v></c></row></sheetData>'))
  const result = await verifyOffice(broken, 'xlsx')
  assert.equal(result.ok, false)
  const errorCheck = result.checks.find((item) => item.id === 'xlsx.formula-errors')
  assert.ok(errorCheck)
  assert.equal(errorCheck.ok, false)
  assert.equal(errorCheck.severity, 'blocker')
  assert.match(errorCheck.detail, /#REF!/)
  assert.equal((await checkOffice(broken, 'xlsx')).ok, false)
})

test('xlsx recalculation is skipped, never passed, when ADVISERS_VERIFY_RECALC_CMD is unconfigured', async () => {
  const previous = process.env.ADVISERS_VERIFY_RECALC_CMD
  delete process.env.ADVISERS_VERIFY_RECALC_CMD
  try {
    const xlsx = await buildXlsx({ columns: [{ header: 'A', key: 'a' }], rows: [{ a: 1 }] })
    const result = await verifyOffice(xlsx, 'xlsx')
    const recalc = result.checks.find((item) => item.id === 'xlsx.recalc')
    assert.ok(recalc)
    assert.equal(recalc.skipped, true)
    assert.equal(recalc.ok, false)
    assert.equal(recalc.severity, 'info')
    assert.match(recalc.detail, /not configured/)
    assert.equal(result.ok, true, 'a skipped recalc must not fail or pass the overall result')
    assert.equal(result.layers.includes('recalc'), false)
  } finally {
    if (previous === undefined) delete process.env.ADVISERS_VERIFY_RECALC_CMD
    else process.env.ADVISERS_VERIFY_RECALC_CMD = previous
  }
})

test('a configured external recalc hook is executed and its failure is a blocker', {
  // Windows platform gap (same root cause as verify-env.test.ts): the recalc
  // command is split on whitespace, so process.execPath with spaces cannot be
  // configured until the quoted-argv product contract lands (windows triage E).
  skip: process.platform === 'win32'
    ? 'recalc command with an executable path containing spaces is not parseable on Windows; quoted-argv contract tracked (windows triage E)'
    : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-recalc-test-'))
  const okScript = join(dir, 'ok.mjs')
  const failScript = join(dir, 'fail.mjs')
  writeFileSync(okScript, 'process.exit(0)\n')
  writeFileSync(failScript, 'process.exit(3)\n')
  const previous = process.env.ADVISERS_VERIFY_RECALC_CMD
  try {
    const xlsx = await buildXlsx({ columns: [{ header: 'A', key: 'a' }], rows: [{ a: 1 }] })
    process.env.ADVISERS_VERIFY_RECALC_CMD = process.execPath + ' ' + okScript
    const good = await verifyOffice(xlsx, 'xlsx')
    const goodCheck = good.checks.find((item) => item.id === 'xlsx.recalc')
    assert.ok(goodCheck)
    assert.equal(goodCheck.ok, true)
    assert.equal(goodCheck.skipped, undefined)
    assert.equal(good.ok, true)
    assert.ok(good.layers.includes('recalc'))

    process.env.ADVISERS_VERIFY_RECALC_CMD = process.execPath + ' ' + failScript
    const bad = await verifyOffice(xlsx, 'xlsx')
    const badCheck = bad.checks.find((item) => item.id === 'xlsx.recalc')
    assert.ok(badCheck)
    assert.equal(badCheck.ok, false)
    assert.equal(badCheck.skipped, undefined)
    assert.equal(badCheck.severity, 'blocker')
    assert.equal(bad.ok, false)
  } finally {
    if (previous === undefined) delete process.env.ADVISERS_VERIFY_RECALC_CMD
    else process.env.ADVISERS_VERIFY_RECALC_CMD = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readOfdText extracts OFD text under the same budget and rejects an OFD bomb', async () => {
  const ofd = new JSZip()
  ofd.file('OFD.xml', '<?xml version="1.0"?><ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016"><ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>')
  ofd.file('Doc_0/Pages/Page_0/Content.xml', '<?xml version="1.0"?><ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content><ofd:TextObject><ofd:TextCode>周五前给王工发报价</ofd:TextCode></ofd:TextObject></ofd:Content></ofd:Page>')
  const buffer = await ofd.generateAsync({ type: 'nodebuffer' })
  assert.match(await readOfdText(buffer), /周五前给王工发报价/)

  const bombZip = new JSZip()
  bombZip.file('OFD.xml', '<ofd:OFD/>')
  bombZip.file('Doc_0/Pages/Page_0/Content.xml', hugeOfdXml(17 * MIB))
  const bomb = await bombZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
  assert.ok(bomb.length < 256 * 1024)
  await rejectsWithBudget(readOfdText(bomb), /ZIP entry too large|single-entry budget/)
})
