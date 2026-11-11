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

test('rejects path escape, PDF and unsupported types', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-attach-'))
  try {
    writeFileSync(join(dir, 'x.pdf'), '%PDF')
    await assert.rejects(() => extractAttachment('../outside', { cwd: dir }), /escapes workspace/)
    await assert.rejects(() => extractAttachment('x.pdf', { cwd: dir }), /PDF text extraction/)
    writeFileSync(join(dir, 'x.png'), 'x')
    await assert.rejects(() => extractAttachment('x.png', { cwd: dir }), /unsupported attachment/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
