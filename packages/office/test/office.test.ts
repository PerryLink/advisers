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
