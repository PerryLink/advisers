import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { extractAttachment, ofdText } from '../lib/attachments.js'
import { buildDocx, buildPptx, buildXlsx } from '../../office/dist/index.js'

const MIB = 1024 * 1024

function repeatXml(unit, targetBytes, head = '', tail = '') {
  const count = Math.max(1, Math.ceil((targetBytes - head.length - tail.length) / unit.length))
  return head + unit.repeat(count) + tail
}

function hugeDocumentXml(targetBytes) {
  return repeatXml('<w:p><w:r><w:t>zip-bomb</w:t></w:r></w:p>', targetBytes, '<w:document><w:body>', '</w:body></w:document>')
}

function hugeSharedStringsXml(targetBytes) {
  return repeatXml('<si><t>zip-bomb</t></si>', targetBytes, '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">', '</sst>')
}

function hugeSlideXml(targetBytes) {
  return repeatXml('<a:p><a:r><a:t>zip-bomb</a:t></a:r></a:p>', targetBytes, '<p:sld><p:cSld><p:spTree>', '</p:spTree></p:cSld></p:sld>')
}

function hugeOfdXml(targetBytes) {
  return repeatXml(
    '<ofd:TextObject><ofd:TextCode>zip-bomb</ofd:TextCode></ofd:TextObject>',
    targetBytes,
    '<?xml version="1.0"?><ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content>',
    '</ofd:Content></ofd:Page>',
  )
}

async function replaceZipEntry(buffer, name, content, level = 9) {
  const zip = await JSZip.loadAsync(buffer)
  zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level } })
}

async function addZipEntries(buffer, entries, level = 1) {
  const zip = await JSZip.loadAsync(buffer)
  for (const [name, content] of entries) zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level } })
}

async function ofdFixture() {
  const zip = new JSZip()
  zip.file('OFD.xml', '<?xml version="1.0"?><ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016"><ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>')
  zip.file('Doc_0/Document.xml', '<?xml version="1.0"?><ofd:Document xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Pages><ofd:Page ID="1">Pages/Page_0/Content.xml</ofd:Page></ofd:Pages></ofd:Document>')
  zip.file('Doc_0/Pages/Page_0/Content.xml', '<?xml version="1.0"?><ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content><ofd:TextObject><ofd:TextCode>周五前给王工发报价</ofd:TextCode></ofd:TextObject></ofd:Content></ofd:Page>')
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-attach-budget-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Rewrite the declared uncompressed size in both ZIP headers (a lying central directory). */
function patchDeclaredSizes(buffer, targetName, declared) {
  const buf = Buffer.from(buffer)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 0xffff - 22); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  assert.ok(eocd >= 0, 'EOCD not found')
  let p = buf.readUInt32LE(eocd + 16)
  const count = buf.readUInt16LE(eocd + 10)
  let local = -1
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory header')
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (name === targetName) {
      buf.writeUInt32LE(declared, p + 24)
      local = buf.readUInt32LE(p + 42)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  assert.ok(local >= 0, 'target ZIP entry not found')
  assert.equal(buf.readUInt32LE(local), 0x04034b50, 'local file header')
  buf.writeUInt32LE(declared, local + 22)
  return buf
}

function rejectsBudget(promise, pattern) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, pattern)
    return true
  })
}

test('extractAttachment rejects a high-compression DOCX bomb instead of decompressing it', async () => {
  await withTempDir(async (dir) => {
    const base = await buildDocx({ title: 'bomb', sections: [{ paragraphs: ['ok'] }] })
    const bomb = await replaceZipEntry(base, 'word/document.xml', hugeDocumentXml(17 * MIB))
    assert.ok(bomb.length < 256 * 1024, 'compressed bomb should stay tiny, got ' + bomb.length + ' bytes')
    writeFileSync(join(dir, 'bomb.docx'), bomb)
    const started = Date.now()
    await rejectsBudget(extractAttachment('bomb.docx', { cwd: dir }), /too large|exceeds|single-entry budget|unzip budget/)
    assert.ok(Date.now() - started < 30_000, 'DOCX bomb must be rejected quickly, no OOM')
  })
})

test('extractAttachment rejects a high-compression XLSX bomb instead of decompressing it', async () => {
  await withTempDir(async (dir) => {
    const base = await buildXlsx({ sheet: '预算', columns: [{ header: '项目', key: 'item' }], rows: [{ item: '差旅' }] })
    const bomb = await replaceZipEntry(base, 'xl/sharedStrings.xml', hugeSharedStringsXml(17 * MIB))
    assert.ok(bomb.length < 256 * 1024, 'compressed bomb should stay tiny, got ' + bomb.length + ' bytes')
    writeFileSync(join(dir, 'bomb.xlsx'), bomb)
    const started = Date.now()
    await rejectsBudget(extractAttachment('bomb.xlsx', { cwd: dir }), /too large|exceeds|single-entry budget|unzip budget/)
    assert.ok(Date.now() - started < 30_000, 'XLSX bomb must be rejected quickly, no OOM')
  })
})

test('extractAttachment rejects a high-compression PPTX bomb instead of decompressing it', async () => {
  await withTempDir(async (dir) => {
    const base = await buildPptx({ title: 'bomb', slides: [{ title: 's', bullets: ['ok'] }] })
    const bomb = await replaceZipEntry(base, 'ppt/slides/slide1.xml', hugeSlideXml(17 * MIB))
    assert.ok(bomb.length < 256 * 1024, 'compressed bomb should stay tiny, got ' + bomb.length + ' bytes')
    writeFileSync(join(dir, 'bomb.pptx'), bomb)
    const started = Date.now()
    await rejectsBudget(extractAttachment('bomb.pptx', { cwd: dir }), /too large|exceeds|single-entry budget|unzip budget/)
    assert.ok(Date.now() - started < 30_000, 'PPTX bomb must be rejected quickly, no OOM')
  })
})

test('OFD extraction rejects a high-compression bomb through the same budget', async () => {
  const zip = new JSZip()
  zip.file('OFD.xml', '<ofd:OFD/>')
  zip.file('Doc_0/Pages/Page_0/Content.xml', hugeOfdXml(17 * MIB))
  const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
  assert.ok(bomb.length < 256 * 1024, 'compressed bomb should stay tiny, got ' + bomb.length + ' bytes')
  const started = Date.now()
  await rejectsBudget(ofdText(bomb), /too large|exceeds|single-entry budget|unzip budget/)
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'bomb.ofd'), bomb)
    await rejectsBudget(extractAttachment('bomb.ofd', { cwd: dir }), /too large|exceeds|single-entry budget|unzip budget/)
  })
  assert.ok(Date.now() - started < 30_000, 'OFD bomb must be rejected quickly, no OOM')
})

test('extractAttachment rejects a DOCX whose total uncompressed size exceeds 64 MiB', async () => {
  await withTempDir(async (dir) => {
    const base = await buildDocx({ title: 'total', sections: [{ paragraphs: ['ok'] }] })
    const entries = []
    for (let i = 0; i < 5; i++) entries.push(['word/media/blob' + i + '.xml', hugeDocumentXml(14 * MIB)])
    const bomb = await addZipEntries(base, entries, 1)
    writeFileSync(join(dir, 'total.docx'), bomb)
    await rejectsBudget(extractAttachment('total.docx', { cwd: dir }), /64 MiB|unzip budget|expands/)
  })
})

test('extractAttachment enforces the 8 M character text budget while decompressing', async () => {
  await withTempDir(async (dir) => {
    const base = await buildDocx({ title: 'text', sections: [{ paragraphs: ['ok'] }] })
    const inflated = await replaceZipEntry(base, 'word/document.xml', hugeDocumentXml(9 * MIB))
    writeFileSync(join(dir, 'text.docx'), inflated)
    await rejectsBudget(extractAttachment('text.docx', { cwd: dir }), /decodes to|characters|text entry too large/)
  })
})

test('extractAttachment rejects a DOCX whose central directory lies about entry sizes', async () => {
  await withTempDir(async (dir) => {
    const base = await buildDocx({ title: 'lying', sections: [{ paragraphs: ['ok'] }] })
    const zip = await JSZip.loadAsync(base)
    zip.file('word/document.xml', hugeDocumentXml(17 * MIB))
    const honest = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
    const bomb = patchDeclaredSizes(honest, 'word/document.xml', 1024)
    assert.ok(bomb.length < 256 * 1024, 'compressed bomb should stay tiny, got ' + bomb.length + ' bytes')
    writeFileSync(join(dir, 'lying.docx'), bomb)
    const started = Date.now()
    await rejectsBudget(extractAttachment('lying.docx', { cwd: dir }), /single-entry budget|expands beyond/)
    assert.ok(Date.now() - started < 30_000, 'lying DOCX bomb must be rejected quickly, no OOM')
    // A normal file still extracts after the capped-stream rejection.
    writeFileSync(join(dir, 'ok.docx'), await buildDocx({ title: 'ok', sections: [{ paragraphs: ['正常内容'] }] }))
    assert.match((await extractAttachment('ok.docx', { cwd: dir })).text, /正常内容/)
  })
})

test('extractAttachment rejects an archive with too many ZIP entries', async () => {
  await withTempDir(async (dir) => {
    const base = await buildDocx({ title: 'many', sections: [{ paragraphs: ['ok'] }] })
    const entries = []
    for (let i = 0; i < 2000; i++) entries.push(['word/media/e' + i + '.bin', 'x'])
    const bomb = await addZipEntries(base, entries)
    writeFileSync(join(dir, 'many.docx'), bomb)
    await rejectsBudget(extractAttachment('many.docx', { cwd: dir }), /too many ZIP entries/)
  })
})

test('normal docx/xlsx/pptx/ofd extraction still works under the budget', async () => {
  await withTempDir(async (dir) => {
    const docx = await buildDocx({ title: 'Q4 周报', sections: [{ heading: '结论', paragraphs: ['增长 12%'] }] })
    writeFileSync(join(dir, 'weekly.docx'), docx)
    const xlsx = await buildXlsx({ sheet: '预算', columns: [{ header: '项目', key: 'item' }], rows: [{ item: '市场' }] })
    writeFileSync(join(dir, 'budget.xlsx'), xlsx)
    const pptx = await buildPptx({ title: '复盘', slides: [{ title: '结论', bullets: ['增长 12%'] }] })
    writeFileSync(join(dir, 'review.pptx'), pptx)
    writeFileSync(join(dir, 'doc.ofd'), await ofdFixture())

    assert.match((await extractAttachment('weekly.docx', { cwd: dir })).text, /增长 12%/)
    assert.match((await extractAttachment('budget.xlsx', { cwd: dir })).text, /市场/)
    assert.match((await extractAttachment('review.pptx', { cwd: dir })).text, /增长 12%/)
    const ofd = await extractAttachment('doc.ofd', { cwd: dir })
    assert.equal(ofd.kind, 'ofd')
    assert.match(ofd.text, /周五前给王工发报价/)
  })
})
