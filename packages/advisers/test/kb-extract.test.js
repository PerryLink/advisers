import assert from 'node:assert/strict'
import test from 'node:test'

import {
  KB_MAX_TEXT_BYTES,
  chunkText,
  codePointSlice,
  decodeTextBuffer,
  extractForIndex,
  htmlToIndexText,
  isIndexableFile,
  truncateUtf8,
} from '../lib/kb-extract.js'
import { buildDocx, buildEml, buildPdf, buildPdfPages, createKbStore } from './kb-fixture.js'

test('kb extract: BOM / UTF-8 / GB18030 text decoding', () => {
  assert.deepEqual(decodeTextBuffer(Buffer.from('报价单', 'utf8')), { text: '报价单', encoding: 'utf-8' })
  assert.deepEqual(decodeTextBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), { text: '中文', encoding: 'gb18030' })
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('摘要', 'utf8')])
  assert.deepEqual(decodeTextBuffer(bom), { text: '摘要', encoding: 'utf-8' })
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('报告', 'utf16le')])
  assert.deepEqual(decodeTextBuffer(utf16), { text: '报告', encoding: 'utf-16le' })
  assert.throws(() => decodeTextBuffer(Buffer.from([0xff, 0xff, 0xff, 0xff])), (error) => error.code === 'E_KB_ENCODING')
})

test('kb extract: chunking is deterministic, bounded and lossless', () => {
  const paragraph = '报价单正文。'.repeat(300) // 1800 chars, over the hard max
  const result = chunkText(paragraph)
  assert.ok(result.chunks.length >= 1)
  for (const chunk of result.chunks) {
    assert.ok([...chunk.text].length <= 1500, 'chunk exceeds the hard max')
    assert.equal(chunk.charCount, [...chunk.text].length)
  }
  const rejoined = result.chunks.map((chunk) => chunk.text).join('')
  assert.equal(rejoined.replace(/\s/gu, ''), paragraph.replace(/\s/gu, ''))
  assert.equal(chunkText(paragraph).chunks.length, result.chunks.length)
  const capped = chunkText('段'.repeat(5000) + '\n\n' + '段'.repeat(5000), { maxChunks: 2 })
  assert.equal(capped.chunks.length, 2)
  assert.equal(capped.truncated, true)
  assert.deepEqual(chunkText(''), { chunks: [], truncated: false, charCount: 0 })
  assert.equal(codePointSlice('😀ab', 0, 1), '😀')
})

test('kb extract: UTF-8 byte truncation never splits a code point', () => {
  const limited = truncateUtf8('报价单报价单', 4)
  assert.equal(limited.truncated, true)
  assert.equal(limited.text, '报')
  const exact = truncateUtf8('abc', 3)
  assert.deepEqual(exact, { text: 'abc', truncated: false })
})

test('kb extract: md/txt/docx/pdf/eml extraction without copying files', async () => {
  const fixture = createKbStore('advisers-kb-extract-')
  try {
    fixture.writeFile('报价单.md', '# 报价单\n\n客户 ACME 需要网站改版报价。')
    fixture.writeFile('gbk.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xa3, 0xba, 0x31, 0x32]))
    fixture.writeFile('weekly.docx', await buildDocx(['季度周报', '增长 12%']))
    fixture.writeFile('quote.pdf', buildPdf('Hello KB PDF'))
    fixture.writeFile('mail.eml', buildEml({ subject: 'Quote follow-up', body: 'Please send the revised quote by Friday.' }))
    fixture.writeFile('scan.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const markdown = await extractForIndex(fixture.root + '/报价单.md')
    assert.equal(markdown.extractor, 'plain')
    assert.equal(markdown.encoding, 'utf-8')
    assert.match(markdown.text, /网站改版报价/)
    assert.equal(markdown.sourceName, '报价单.md')
    const legacy = await extractForIndex(fixture.root + '/gbk.txt')
    assert.equal(legacy.encoding, 'gb18030')
    assert.match(legacy.text, /中文：12/)
    const docx = await extractForIndex(fixture.root + '/weekly.docx')
    assert.equal(docx.extractor, 'docx')
    assert.match(docx.text, /季度周报/)
    const pdf = await extractForIndex(fixture.root + '/quote.pdf')
    assert.equal(pdf.extractor, 'pdf')
    assert.match(pdf.text, /Hello KB PDF/)
    const eml = await extractForIndex(fixture.root + '/mail.eml')
    assert.equal(eml.extractor, 'eml')
    assert.match(eml.text, /Subject: Quote follow-up/)
    assert.match(eml.text, /revised quote/)
    const image = await extractForIndex(fixture.root + '/scan.png')
    assert.equal(image.needsOcr, true)
    assert.equal(image.text, '')
    // The result carries the basename only, never the temporary absolute path.
    for (const result of [markdown, docx, pdf, eml]) {
      assert.equal(JSON.stringify(result).includes(fixture.root), false, 'extraction leaked an absolute path')
    }
    assert.equal(isIndexableFile('x.docx'), true)
    assert.equal(isIndexableFile('x.exe'), false)
    await assert.rejects(() => extractForIndex(fixture.root + '/x.exe'), (error) => error.code === 'E_KB_UNSUPPORTED')
  } finally { fixture.cleanup() }
})

test('kb extract: explicit limits (file bytes, text bytes, PDF pages)', async () => {
  const fixture = createKbStore('advisers-kb-limits-')
  try {
    fixture.writeFile('big.txt', 'a'.repeat(500))
    await assert.rejects(() => extractForIndex(fixture.root + '/big.txt', { maxFileBytes: 10 }), (error) => error.code === 'E_KB_TOO_LARGE')
    const limited = await extractForIndex(fixture.root + '/big.txt', { maxTextBytes: 100 })
    assert.equal(limited.truncated, true)
    assert.ok(limited.truncatedBy.includes('text_bytes'))
    assert.ok(limited.textBytes <= 100)
    assert.ok(limited.warnings.some((warning) => /only the prefix/i.test(warning)))
    fixture.writeFile('multi.pdf', buildPdfPages(['page number 1', 'page number 2', 'page number 3']))
    const pages = await extractForIndex(fixture.root + '/multi.pdf', { maxPdfPages: 1 })
    assert.equal(pages.totalPages, 3)
    assert.equal(pages.pages, 1)
    assert.equal(pages.truncated, true)
    assert.ok(pages.truncatedBy.includes('pdf_pages'))
    assert.equal(KB_MAX_TEXT_BYTES, 2 * 1024 * 1024)
  } finally { fixture.cleanup() }
})

test('kb extract: html is reduced to searchable text', () => {
  const text = htmlToIndexText('<html><head><style>.x{}</style></head><body><h1>报价</h1><script>evil()</script><p>总价 &amp; 折扣</p></body></html>')
  assert.match(text, /报价/)
  assert.match(text, /总价 & 折扣/)
  assert.equal(text.includes('script'), false)
})
