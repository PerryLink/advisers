import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDocx,
  buildDrawio,
  buildMermaid,
  buildPptx,
  buildXlsx,
  containsText,
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
