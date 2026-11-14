import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { extractAttachment } from '../lib/attachments.js'
import { buildDocx, buildPptx, buildXlsx } from '../../office/dist/index.js'

test('extracts text from docx, xlsx, pptx and text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-attach-'))
  try {
    writeFileSync(join(dir, 'notes.md'), '# 标题\n\n正文')
    const docx = await buildDocx({ title: 'Q4 周报', sections: [{ heading: '结论', paragraphs: ['增长 12%'] }] })
    writeFileSync(join(dir, 'weekly.docx'), docx)
    const xlsx = await buildXlsx({ sheet: '预算', columns: [{ header: '项目', key: 'item' }, { header: '金额', key: 'amount' }], rows: [{ item: '市场', amount: 120 }] })
    writeFileSync(join(dir, 'budget.xlsx'), xlsx)
    const pptx = await buildPptx({ title: '复盘', slides: [{ title: '结论', bullets: ['增长 12%'] }] })
    writeFileSync(join(dir, 'review.pptx'), pptx)

    assert.match((await extractAttachment('notes.md', { cwd: dir })).text, /正文/)
    assert.match((await extractAttachment('weekly.docx', { cwd: dir })).text, /增长 12%/)
    assert.match((await extractAttachment('budget.xlsx', { cwd: dir })).text, /市场/)
    assert.match((await extractAttachment('review.pptx', { cwd: dir })).text, /增长 12%/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makePdf(text) {
  const body = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objs.forEach((obj, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objs.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

test('extracts text from PDF and rejects path escape/unsupported types', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-attach-'))
  try {
    writeFileSync(join(dir, 'x.pdf'), makePdf('Hello PDF'))
    assert.match((await extractAttachment('x.pdf', { cwd: dir })).text, /Hello PDF/)
    await assert.rejects(() => extractAttachment('../outside', { cwd: dir }), /escapes workspace/)
    writeFileSync(join(dir, 'x.png'), 'x')
    await assert.rejects(() => extractAttachment('x.png', { cwd: dir }), /unsupported attachment|OCR is not configured/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
