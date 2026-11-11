import type { DocxSpec } from './docx.ts'
import type { DiagramSpec } from './diagram.ts'
import type { PptxSpec } from './pptx.ts'
import type { XlsxSpec } from './xlsx.ts'

export interface WeeklyReportInput {
  title?: string
  period: string
  done: string[]
  risks?: string[]
  next?: string[]
}

export function weeklyReport(input: WeeklyReportInput): DocxSpec {
  const title = input.title ?? `${input.period} 周报`
  return {
    title,
    subtitle: 'BLUF：先说结论，再列事实',
    sections: [
      { heading: '本周完成', bullets: input.done },
      { heading: '风险与阻塞', bullets: input.risks ?? ['无'] },
      { heading: '下周计划', bullets: input.next ?? ['待定'] },
      {
        heading: '一页摘要',
        table: {
          headers: ['项', '内容'],
          rows: [
            ['周期', input.period],
            ['完成', `${input.done.length} 项`],
            ['风险', `${input.risks?.length ?? 0} 项`],
          ],
        },
      },
    ],
  }
}

export interface BudgetRow {
  item: string
  amount: number
  owner?: string
}

export interface BudgetInput {
  sheet?: string
  rows: BudgetRow[]
}

export function budget(input: BudgetInput): XlsxSpec {
  const rows = input.rows.map((r) => ({ item: r.item, amount: r.amount, owner: r.owner ?? '' }))
  const last = rows.length + 1
  return {
    sheet: input.sheet ?? '预算',
    columns: [
      { header: '项目', key: 'item', width: 24 },
      { header: '金额', key: 'amount', width: 16, numFmt: '#,##0' },
      { header: '负责人', key: 'owner', width: 14 },
    ],
    rows,
    formulas: last >= 2 ? [{ cell: `B${last + 1}`, formula: `SUM(B2:B${last})` }] : [],
  }
}

export interface PresentationInput {
  title: string
  conclusion: string
  bullets: string[]
  risks?: string[]
}

export function presentation(input: PresentationInput): PptxSpec {
  return {
    title: input.title,
    subtitle: 'BLUF：结论先行',
    slides: [
      { title: '结论', bullets: [input.conclusion] },
      { title: '要点', bullets: input.bullets },
      { title: '风险与下一步', bullets: input.risks?.length ? input.risks : ['暂无重大风险'] },
    ],
  }
}

export interface FlowInput {
  title: string
  steps: string[]
}

export function flow(input: FlowInput): DiagramSpec {
  const nodes = input.steps.map((label, index) => ({ id: `S${index + 1}`, label }))
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id }))
  return { kind: 'flowchart', title: input.title, direction: 'TD', nodes, edges }
}

export interface MindmapInput {
  title: string
  branches: Array<{ label: string; children?: string[] }>
}

export function mindmap(input: MindmapInput): DiagramSpec {
  return { kind: 'mindmap', title: input.title, branches: input.branches }
}
