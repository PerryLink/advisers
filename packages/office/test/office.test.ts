import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDocx,
  buildDrawio,
  buildMermaid,
  buildPptx,
  buildXmind,
  buildXlsx,
  budget,
  flow,
  mindmap,
  presentation,
  weeklyReport,
  containsText,
  excelDate,
  validateXmind,
  validateOffice,
} from '../src/index.ts'

test('docx contains title, paragraph, and table text', async () => {
  const buffer = await buildDocx({
    title: 'Q4 预算说明',
    subtitle: '内部讨论稿',
    sections: [
      { heading: '结论', paragraphs: ['本季度预算整体可控。'] },
      {
        heading: '明细',
        table: { headers: ['项目', '金额'], rows: [['市场', '120'], ['研发', '300']] },
      },
    ],
  })
  assert.ok(buffer.length > 1000)
  assert.equal((await validateOffice(buffer, 'docx')).ok, true)
  assert.equal(await containsText(buffer, 'Q4 预算说明'), true)
  assert.equal(await containsText(buffer, '市场'), true)
})

test('xlsx contains headers and rows', async () => {
  const buffer = await buildXlsx({
    sheet: '预算',
    columns: [
      { header: '项目', key: 'item', width: 20 },
      { header: '金额', key: 'amount', numFmt: '#,##0' },
    ],
    rows: [
      { item: '市场', amount: 120 },
      { item: '研发', amount: 300 },
    ],
  })
  assert.equal((await validateOffice(buffer, 'xlsx')).ok, true)
  assert.equal(await containsText(buffer, '项目'), true)
  assert.equal(await containsText(buffer, '研发'), true)
})

test('pptx contains title and slide text', async () => {
  const buffer = await buildPptx({
    title: 'Q4 复盘',
    slides: [{ title: '结论', bullets: ['收入增长 12%', '成本下降 4%'] }],
  })
  assert.equal((await validateOffice(buffer, 'pptx')).ok, true)
  assert.equal(await containsText(buffer, 'Q4 复盘'), true)
  assert.equal(await containsText(buffer, '收入增长'), true)
})

test('mermaid flowchart and mindmap are valid source text', () => {
  const flow = buildMermaid({
    kind: 'flowchart',
    title: '审批流程',
    nodes: [
      { id: 'A', label: '提交' },
      { id: 'B', label: '审批', shape: 'diamond' },
    ],
    edges: [{ from: 'A', to: 'B', label: '提交后' }],
  })
  assert.match(flow, /^flowchart TD/)
  assert.match(flow, /A\["提交"\]/)
  assert.match(flow, /-->.*B/)

  const mind = buildMermaid({
    kind: 'mindmap',
    title: '项目',
    branches: [{ label: '范围', children: ['需求', '验收'] }],
  })
  assert.match(mind, /^mindmap/)
  assert.match(mind, /需求/)
})

test('drawio XML has vertices and edges', () => {
  const xml = buildDrawio({
    kind: 'flowchart',
    title: '流程',
    nodes: [{ id: 'A', label: '开始' }, { id: 'B', label: '结束' }],
    edges: [{ from: 'A', to: 'B' }],
  })
  assert.match(xml, /<mxGraphModel/)
  assert.match(xml, /value="开始"/)
  assert.match(xml, /edge="1"/)
})

test('excelDate is timezone-safe (UTC, not local midnight)', () => {
  const d = excelDate(2026, 11, 10)
  assert.equal(d.toISOString().slice(0, 10), '2026-11-10')
  assert.equal(d.getUTCHours(), 0)
})

test('xmind zip has content, metadata, manifest, and the title', async () => {
  const buffer = await buildXmind({
    kind: 'mindmap',
    title: 'Q4 规划',
    branches: [{ label: '目标', children: ['增长', '利润'] }],
  })
  assert.equal((await validateXmind(buffer)).ok, true)
  assert.equal(await containsText(buffer, 'Q4 规划'), true)
  assert.equal(await containsText(buffer, '增长'), true)
})

test('validator catches a broken OOXML relationship target', async () => {
  const JSZip = (await import('jszip')).default
  const buffer = await buildDocx({ title: '断链测试', sections: [{ paragraphs: ['hello'] }] })
  const zip = await JSZip.loadAsync(buffer)
  const rels = await zip.file('word/_rels/document.xml.rels')?.async('string')
  assert.ok(rels)
  const match = [...rels.matchAll(/<Relationship\b[^>]*>/g)]
    .map((m) => m[0])
    .find((tag) => !/TargetMode="External"/.test(tag))
  const target = match && /Target="([^"]+)"/.exec(match)?.[1]
  assert.ok(target)
  const resolved = target.startsWith('/') ? target.slice(1) : 'word/' + target
  zip.remove(resolved)
  const broken = await zip.generateAsync({ type: 'nodebuffer' })
  const result = await validateOffice(broken, 'docx')
  assert.equal(result.ok, false)
  assert.ok(result.missing.some((item) => item.startsWith('rel:')))
})

test('templates produce the right shapes', () => {
  const weekly = weeklyReport({ period: '2026-W45', done: ['a', 'b'], risks: ['c'] })
  assert.equal(weekly.sections.length, 4)
  assert.equal(weekly.sections[0]?.bullets?.length, 2)

  const b = budget({ rows: [{ item: '市场', amount: 120 }, { item: '研发', amount: 300 }] })
  assert.equal(b.rows.length, 2)
  assert.equal(b.formulas?.[0]?.cell, 'B4')
  assert.match(b.formulas?.[0]?.formula ?? '', /SUM\(B2:B3\)/)

  const p = presentation({ title: '复盘', conclusion: '增长', bullets: ['a'] })
  assert.equal(p.slides.length, 3)

  const f = flow({ title: '审批', steps: ['提交', '审批', '付款'] })
  assert.equal(f.nodes?.length, 3)
  assert.equal(f.edges?.length, 2)

  const m = mindmap({ title: '规划', branches: [{ label: '目标', children: ['增长'] }] })
  assert.equal(m.kind, 'mindmap')
})

test('validator rejects a missing content-type declaration', async () => {
  const JSZip = (await import('jszip')).default
  const buffer = await buildDocx({ title: 'content-type', sections: [{ paragraphs: ['x'] }] })
  const zip = await JSZip.loadAsync(buffer)
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>')
  const broken = await zip.generateAsync({ type: 'nodebuffer' })
  const result = await validateOffice(broken, 'docx')
  assert.equal(result.ok, false)
  assert.ok(result.missing.some((item) => item.startsWith('content-type:')))
})

test('docx bullet text is not duplicated', async () => {
  const JSZip = (await import('jszip')).default
  const buffer = await buildDocx({ title: 't', sections: [{ bullets: ['alpha'] }] })
  const zip = await JSZip.loadAsync(buffer)
  const xml = await zip.file('word/document.xml')?.async('string')
  assert.equal((xml?.match(/alpha/g) ?? []).length, 1)
})

test('verifyOffice checks XML/content types/rels and rejects corruption', async () => {
  const { buildDocx } = await import('../src/docx.ts')
  const { verifyOffice } = await import('../src/verify.ts')
  const buffer = await buildDocx({ title: '验证', sections: [{ heading: '结论', paragraphs: ['正常'] }] })
  const good = await verifyOffice(buffer, 'docx')
  assert.equal(good.ok, true)
  assert.ok(good.entries > 3)
  const broken = await verifyOffice(Buffer.from('not a zip'), 'docx')
  assert.equal(broken.ok, false)
})

test('readOffice reads docx/xlsx/pptx generated by builders', async () => {
  const { buildDocx, buildXlsx, buildPptx } = await import('../src/index.ts')
  const { readOffice } = await import('../src/index.ts')
  const docx = await buildDocx({ title: '报告', sections: [{ heading: '结论', paragraphs: ['要发报价'] }] })
  const readDoc = await readOffice(docx)
  assert.equal(readDoc.kind, 'docx')
  assert.match(readDoc.text, /要发报价/)
  const xlsx = await buildXlsx({ sheet: '预算', columns: [{ header: '项目', key: 'item' }, { header: '金额', key: 'amount' }], rows: [{ item: '差旅', amount: 100 }], formulas: [{ cell: 'B3', formula: 'SUM(B2:B2)' }] })
  const readSheet = await readOffice(xlsx)
  assert.equal(readSheet.kind, 'xlsx')
  assert.match(readSheet.text, /预算/)
  assert.match(readSheet.text, /差旅/)
  const pptx = await buildPptx({ title: '汇报', slides: [{ title: '进展', bullets: ['完成'], notes: '备注' }] })
  const readPpt = await readOffice(pptx)
  assert.equal(readPpt.kind, 'pptx')
  assert.match(readPpt.text, /进展/)
  assert.match(readPpt.text, /备注/)
})

test('editOffice changes DOCX/XLSX/PPTX and verifies the result', async () => {
  const { buildDocx, buildXlsx, buildPptx, editOffice, readOffice } = await import('../src/index.ts')
  const docx = await buildDocx({ title: '标题', sections: [{ heading: '结论', paragraphs: ['旧内容'] }] })
  const readDoc = await readOffice(docx)
  const index = (readDoc as any).blocks.findIndex((b: any) => b.paragraph?.text === '旧内容')
  const editedDoc = await editOffice(docx, 'docx', [{ op: 'docx.setText', block: index, text: '新内容' }])
  assert.equal(editedDoc.ok, true)
  assert.match(((await readOffice(editedDoc.buffer)) as any).text, /新内容/)
  const xlsx = await buildXlsx({ sheet: '预算', columns: [{ header: '项目', key: 'item' }, { header: '金额', key: 'amount' }], rows: [{ item: '差旅', amount: 100 }] })
  const editedXlsx = await editOffice(xlsx, 'xlsx', [{ op: 'xlsx.setCell', sheet: '预算', ref: 'B2', value: 200 }])
  assert.equal(editedXlsx.ok, true)
  assert.match(((await readOffice(editedXlsx.buffer)) as any).text, /200/)
  const pptx = await buildPptx({ title: '汇报', slides: [{ title: '旧标题', bullets: ['x'] }] })
  const editedPptx = await editOffice(pptx, 'pptx', [{ op: 'pptx.setText', slide: 1, text: '新标题' }])
  assert.equal(editedPptx.ok, true)
  assert.match(((await readOffice(editedPptx.buffer)) as any).text, /新标题/)
})

test('Chinese meeting-minutes and notice templates build valid DOCX', async () => {
  const { meetingMinutes, notice, buildDocx, validateOffice, readOffice } = await import('../src/index.ts')
  const minutes = await buildDocx(meetingMinutes({ date: '2026-11-12', place: '会议室', chair: '王工', attendees: ['张三'], agenda: ['报价'], decisions: ['周五发'], actions: [{ what: '发报价', owner: '张三', due: '周五' }] }))
  assert.equal((await validateOffice(minutes, 'docx')).ok, true)
  assert.match(((await readOffice(minutes)) as any).text, /会议纪要/)
  const n = await buildDocx(notice({ title: '通知', issuer: '某某公司', recipients: ['全体员工'], body: ['本周五放假'], signer: '行政部', date: '2026年11月12日' }))
  assert.equal((await validateOffice(n, 'docx')).ok, true)
  assert.match(((await readOffice(n)) as any).text, /本周五放假/)
})

test('docx edit block index stays aligned when a table precedes a paragraph', async () => {
  const { buildDocx, editOffice, readOffice } = await import('../src/index.ts')
  const buffer = await buildDocx({ title: '标题', sections: [{ heading: '表在前', table: { headers: ['A'], rows: [['1']] } }, { heading: '目标', paragraphs: ['旧段落'] }] })
  const before = await readOffice(buffer)
  const index = (before as any).blocks.findIndex((b: any) => b.paragraph?.text === '旧段落')
  const result = await editOffice(buffer, 'docx', [{ op: 'docx.setText', block: index, text: '新段落' }])
  assert.equal(result.ok, true)
  const after = await readOffice(result.buffer)
  assert.match((after as any).text, /新段落/)
  assert.doesNotMatch((after as any).text, /旧段落/)
})
