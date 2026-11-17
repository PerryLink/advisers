import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import {
  ZipBudgetError,
  buildDocx,
  buildPptx,
  buildXlsx,
  containsText,
  editOffice,
  readOffice,
  validateOffice,
} from '../src/index.ts'

const MIB = 1024 * 1024

function repeatXml(unit: string, targetBytes: number, head = '', tail = ''): string {
  const count = Math.max(1, Math.ceil((targetBytes - head.length - tail.length) / unit.length))
  return head + unit.repeat(count) + tail
}

function hugeDocumentXml(targetBytes: number): string {
  return repeatXml('<w:p><w:r><w:t>zip-bomb</w:t></w:r></w:p>', targetBytes, '<w:document><w:body>', '</w:body></w:document>')
}

function hugeSlideXml(targetBytes: number): string {
  return repeatXml('<a:p><a:r><a:t>zip-bomb</a:t></a:r></a:p>', targetBytes, '<p:sld><p:cSld><p:spTree>', '</p:spTree></p:cSld></p:sld>')
}

function hugeSharedStringsXml(targetBytes: number): string {
  return repeatXml('<si><t>zip-bomb</t></si>', targetBytes, '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">', '</sst>')
}

function hugeContentTypesXml(targetBytes: number): string {
  return repeatXml('<Default Extension="xml" ContentType="application/xml"/>', targetBytes, '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">', '</Types>')
}

async function replaceZipEntry(buffer: Buffer, name: string, content: string, level = 9): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer)
  zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level } })
}

async function addZipEntries(buffer: Buffer, entries: Array<[string, string]>, level = 1): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer)
  for (const [name, content] of entries) zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level } })
}

function assertFast(started: number, label: string): void {
  const elapsed = Date.now() - started
  assert.ok(elapsed < 30_000, label + ' should be rejected quickly, no OOM (took ' + elapsed + 'ms)')
}

/** Rewrite the declared uncompressed size in both ZIP headers (a lying central directory). */
function patchDeclaredSizes(buffer: Buffer, targetName: string, declared: number): Buffer {
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

function assertBudgetError(message: unknown, pattern: RegExp): void {
  assert.equal(typeof message, 'string')
  assert.match(String(message), pattern)
}

test('editOffice rejects a high-compression DOCX zip bomb instead of decompressing it', async () => {
  const base = await buildDocx({ title: 'bomb', sections: [{ heading: 'h', paragraphs: ['ok'] }] })
  const bomb = await replaceZipEntry(base, 'word/document.xml', hugeDocumentXml(17 * MIB))
  assert.ok(bomb.length < 256 * 1024, 'compressed bomb should stay tiny, got ' + bomb.length + ' bytes')
  const started = Date.now()
  const result = await editOffice(bomb, 'docx', [{ op: 'docx.setText', block: 0, text: 'changed' }])
  assert.equal(result.ok, false)
  assertBudgetError(result.error, /ZIP entry too large|single-entry budget|exceeds/)
  assertFast(started, 'DOCX bomb')
})

test('editOffice rejects a high-compression XLSX zip bomb before ExcelJS expands entries', async () => {
  const base = await buildXlsx({ sheet: '预算', columns: [{ header: '项目', key: 'item' }], rows: [{ item: '差旅' }] })
  const bomb = await replaceZipEntry(base, 'xl/sharedStrings.xml', hugeSharedStringsXml(17 * MIB))
  assert.ok(bomb.length < 256 * 1024, 'compressed bomb should stay tiny, got ' + bomb.length + ' bytes')
  const started = Date.now()
  const result = await editOffice(bomb, 'xlsx', [{ op: 'xlsx.setCell', sheet: '预算', ref: 'B2', value: 200 }])
  assert.equal(result.ok, false)
  assertBudgetError(result.error, /ZIP entry too large|single-entry budget|exceeds/)
  assertFast(started, 'XLSX bomb')
})

test('editOffice rejects a high-compression PPTX zip bomb instead of decompressing it', async () => {
  const base = await buildPptx({ title: 'bomb', slides: [{ title: 's', bullets: ['ok'] }] })
  const bomb = await replaceZipEntry(base, 'ppt/slides/slide1.xml', hugeSlideXml(17 * MIB))
  assert.ok(bomb.length < 256 * 1024, 'compressed bomb should stay tiny, got ' + bomb.length + ' bytes')
  const started = Date.now()
  const result = await editOffice(bomb, 'pptx', [{ op: 'pptx.setText', slide: 1, text: 'changed' }])
  assert.equal(result.ok, false)
  assertBudgetError(result.error, /ZIP entry too large|single-entry budget|exceeds/)
  assertFast(started, 'PPTX bomb')
})

test('editOffice rejects an archive that exceeds the total uncompressed budget', async () => {
  const base = await buildDocx({ title: 'total', sections: [{ paragraphs: ['ok'] }] })
  const entries: Array<[string, string]> = []
  for (let i = 0; i < 5; i++) entries.push(['word/media/blob' + i + '.xml', hugeDocumentXml(14 * MIB)])
  const bomb = await addZipEntries(base, entries, 1)
  const result = await editOffice(bomb, 'docx', [{ op: 'docx.setText', block: 0, text: 'x' }])
  assert.equal(result.ok, false)
  assertBudgetError(result.error, /expands to|total budget|limit/)
})

test('editOffice rejects an archive with too many entries', async () => {
  const base = await buildDocx({ title: 'many', sections: [{ paragraphs: ['ok'] }] })
  const entries: Array<[string, string]> = []
  for (let i = 0; i < 2000; i++) entries.push(['word/media/e' + i + '.bin', 'x'])
  const bomb = await addZipEntries(base, entries)
  const result = await editOffice(bomb, 'docx', [{ op: 'docx.setText', block: 0, text: 'x' }])
  assert.equal(result.ok, false)
  assertBudgetError(result.error, /too many ZIP entries/)
})

test('editOffice enforces the text character budget while reading document entries', async () => {
  const base = await buildDocx({ title: 'text', sections: [{ paragraphs: ['ok'] }] })
  const inflated = await replaceZipEntry(base, 'word/document.xml', hugeDocumentXml(9 * MIB))
  const result = await editOffice(inflated, 'docx', [{ op: 'docx.setText', block: 0, text: 'x' }])
  assert.equal(result.ok, false)
  assertBudgetError(result.error, /decodes to|characters|text entry/)
})

test('editOffice rejects a DOCX whose central directory lies about entry sizes', async () => {
  const base = await buildDocx({ title: 'lying', sections: [{ paragraphs: ['ok'] }] })
  const zip = await JSZip.loadAsync(base)
  zip.file('word/document.xml', hugeDocumentXml(17 * MIB))
  const honest = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
  const bomb = patchDeclaredSizes(honest, 'word/document.xml', 1024)
  assert.ok(bomb.length < 256 * 1024, 'compressed bomb should stay tiny, got ' + bomb.length + ' bytes')
  const started = Date.now()
  const result = await editOffice(bomb, 'docx', [{ op: 'docx.setText', block: 0, text: 'changed' }])
  assert.equal(result.ok, false)
  assertBudgetError(result.error, /single-entry budget|expands beyond/)
  assertFast(started, 'lying DOCX bomb')
})

test('editOffice rejects an XLSX whose central directory lies about entry sizes', async () => {
  const base = await buildXlsx({ sheet: '预算', columns: [{ header: '项目', key: 'item' }], rows: [{ item: '差旅' }] })
  const zip = await JSZip.loadAsync(base)
  zip.file('xl/sharedStrings.xml', hugeSharedStringsXml(17 * MIB))
  const honest = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
  const bomb = patchDeclaredSizes(honest, 'xl/sharedStrings.xml', 1024)
  assert.ok(bomb.length < 256 * 1024, 'compressed bomb should stay tiny, got ' + bomb.length + ' bytes')
  const started = Date.now()
  const result = await editOffice(bomb, 'xlsx', [{ op: 'xlsx.setCell', sheet: '预算', ref: 'B2', value: 200 }])
  assert.equal(result.ok, false)
  assertBudgetError(result.error, /single-entry budget|expands beyond/)
  assertFast(started, 'lying XLSX bomb')
})

test('editOffice accepts a budget override and still edits normal files', async () => {
  const docx = await buildDocx({ title: '正常', sections: [{ heading: '结论', paragraphs: ['旧内容'] }] })
  const read = await readOffice(docx)
  const block = (read as any).blocks.findIndex((b: any) => b.paragraph?.text === '旧内容')
  const edited = await editOffice(docx, 'docx', [{ op: 'docx.setText', block, text: '新内容' }])
  assert.equal(edited.ok, true)
  assert.match(((await readOffice(edited.buffer)) as any).text, /新内容/)
  const limited = await editOffice(docx, 'docx', [{ op: 'docx.setText', block: 0, text: 'x' }], { budget: { maxEntries: 3 } })
  assert.equal(limited.ok, false)
  assertBudgetError(limited.error, /too many ZIP entries/)
})

test('validateOffice rejects zip bombs with a not-ok result instead of decompressing them', async () => {
  const base = await buildDocx({ title: 'bomb', sections: [{ paragraphs: ['ok'] }] })
  const bomb = await replaceZipEntry(base, 'word/document.xml', hugeDocumentXml(17 * MIB))
  const started = Date.now()
  const result = await validateOffice(bomb, 'docx')
  assert.equal(result.ok, false)
  assert.ok(result.missing.length >= 1)
  assertBudgetError(result.missing[0], /ZIP entry too large|single-entry budget|exceeds/)
  assertFast(started, 'validateOffice DOCX bomb')

  const textBomb = await replaceZipEntry(base, '[Content_Types].xml', hugeContentTypesXml(9 * MIB))
  const textResult = await validateOffice(textBomb, 'docx')
  assert.equal(textResult.ok, false)
  assertBudgetError(textResult.missing[0], /decodes to|characters|text entry/)
})

test('containsText rejects a zip bomb with ZipBudgetError', async () => {
  const base = await buildDocx({ title: 'bomb', sections: [{ paragraphs: ['ok'] }] })
  const bomb = await replaceZipEntry(base, 'word/document.xml', hugeDocumentXml(17 * MIB))
  await assert.rejects(containsText(bomb, 'anything'), (error: unknown) => {
    assert.ok(error instanceof ZipBudgetError)
    assert.match(error.message, /ZIP entry too large|single-entry budget|exceeds/)
    return true
  })
})

test('validateOffice and containsText still accept normal builder output', async () => {
  const docx = await buildDocx({ title: '报告', sections: [{ heading: '结论', paragraphs: ['预算可控'] }] })
  const xlsx = await buildXlsx({ sheet: '预算', columns: [{ header: '项目', key: 'item' }], rows: [{ item: '差旅' }] })
  const pptx = await buildPptx({ title: '汇报', slides: [{ title: '进展', bullets: ['完成'] }] })
  for (const [kind, buffer, needle] of [
    ['docx', docx, '预算可控'],
    ['xlsx', xlsx, '差旅'],
    ['pptx', pptx, '进展'],
  ] as const) {
    assert.equal((await validateOffice(buffer, kind)).ok, true, kind + ' should validate')
    assert.equal(await containsText(buffer, needle), true, kind + ' text should be found')
  }
})
