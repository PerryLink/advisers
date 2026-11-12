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


export interface MeetingMinutesInput {
  title?: string
  date: string
  place?: string
  chair?: string
  attendees?: string[]
  agenda: string[]
  decisions?: string[]
  actions?: Array<{ what: string; owner?: string; due?: string }>
}

export function meetingMinutes(input: MeetingMinutesInput): DocxSpec {
  const actions = input.actions ?? []
  return {
    title: input.title ?? `${input.date} 会议纪要`,
    subtitle: input.place ? `地点：${input.place}` : undefined,
    sections: [
      { heading: '基本信息', table: { headers: ['项', '内容'], rows: [['日期', input.date], ['地点', input.place ?? ''], ['主持', input.chair ?? ''], ['参会', (input.attendees ?? []).join('、')]] } },
      { heading: '议题', bullets: input.agenda },
      { heading: '决议', bullets: input.decisions?.length ? input.decisions : ['无'] },
      { heading: '行动项', table: { headers: ['事项', '负责人', '截止'], rows: actions.length ? actions.map((a) => [a.what, a.owner ?? '', a.due ?? '']) : [['无', '', '']] } },
    ],
  }
}

export interface NoticeInput {
  title: string
  issuer: string
  recipients: string[]
  body: string[]
  signer: string
  date: string
}

export function notice(input: NoticeInput): DocxSpec {
  return {
    title: input.title,
    subtitle: `主送：${input.recipients.join('、')}`,
    sections: [
      { heading: '正文', paragraphs: input.body },
      { heading: '落款', paragraphs: [`${input.issuer}　${input.signer}`, input.date] },
    ],
  }
}
