import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSimplePdf, findCjkFont } from '../lib/pdf.js'

test('E7: simple Chinese PDF starts with %PDF and has bytes', { skip: !findCjkFont() ? 'no CJK font on this host' : false }, async () => {
  const buf = await buildSimplePdf({ title: '承诺回执', paragraphs: ['发报价 · 截止 2026-11-20', '本 PDF 由本地账本生成。'] })
  assert.ok(buf.length > 1000)
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-')
})
