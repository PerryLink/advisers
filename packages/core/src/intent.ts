import type { IsoDate } from './types.ts'

export type IntentAction = 'execute' | 'confirm' | 'ask'
export type IntentRisk = 'low' | 'medium' | 'high'
export type ReportLength = 'one_line' | 'five_lines' | 'screen'

export interface IntentContext {
  /** Probation asks more; trusted asks less. */
  stage?: 'probation' | 'trusted'
}

export interface IntentBrief {
  /** The user's words, never normalized. */
  verbatim: string
  request: string
  goal: string
  deliverable: string
  audience?: string
  due?: string
  constraints: string[]
  assumptions: string[]
  unknowns: string[]
  risk: IntentRisk
  confidence: number
  action: IntentAction
  /** At most one; a second question is usually a tax, not information. */
  questions: string[]
  /** Two-line "did I understand you" readback. */
  readback: string
  reportFormat: ReportLength
}

const DELIVERABLES: Array<[string, RegExp]> = [
  ['pptx', /(ppt|幻灯片|演示文稿|汇报材料)/i],
  ['docx', /(word|文档|周报|报告|纪要|方案书|合同)/i],
  ['xlsx', /(excel|表格|预算表|数据表|台账)/i],
  ['diagram', /(流程图|思维导图|架构图|mermaid|draw\.io|xmind|visio)/i],
  ['email', /(邮件|回复|发给|草稿)/i],
  ['plan', /(计划|排期|方案|步骤)/i],
]

const HIGH_RISK = /(发送|发给|发布|付款|转账|汇款|打款|转(到|账)|删除|删掉|清空|销毁|签字|签约|对外|客户|老板|投资|合同)/
const VAGUE = /(那个|这个|搞一下|弄一下|看一下|看看|处理一下|尽快|看着办|随便|你懂的|老样子)/
const CONSTRAINT = /(不要|别|必须|只能|不能|务必|一定要|截止|之前|以后)/

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))]
}

export function detectDeliverable(request: string): string {
  for (const [name, re] of DELIVERABLES) if (re.test(request)) return name
  return 'answer'
}

export function detectRisk(request: string): IntentRisk {
  if (HIGH_RISK.test(request)) return 'high'
  if (DELIVERABLES.some(([, re]) => re.test(request))) return 'medium'
  return 'low'
}

export function ambiguityScore(request: string): number {
  const text = request.trim()
  if (!text) return 1
  let score = 0
  if (text.length < 8) score += 0.35
  else if (text.length < 16) score += 0.2
  if (VAGUE.test(text)) score += 0.3
  if (!/[。！？.!?]/.test(text) && text.length > 30) score += 0.05
  if (/(它|他们|她们|那边|上面|前面)/.test(text)) score += 0.1
  return clamp(score, 0, 1)
}

function isRecallQuestion(text: string): boolean {
  if (!/[？?]\s*$/.test(text)) return false
  if (/(做|写|生成|整理|发给|发我|交付|安排|准备|改|优化|检查|帮我)/.test(text)) return false
  return /(什么|多少|谁|哪|吗|是否|多久|什么时候|叫什么|是什么|怎么样)/.test(text)
}

export function buildIntentBrief(request: string, context: IntentContext = {}): IntentBrief {
  const text = request.trim()
  const recall = isRecallQuestion(text)
  const deliverable = recall ? 'answer' : detectDeliverable(text)
  const risk = recall ? 'low' : detectRisk(text)
  const ambiguity = recall ? 0 : ambiguityScore(text)
  const hasDeadline = /(今天|明天|后天|本周|下周|周[一二三四五六日天]|\d{1,2}[-/月]\d{1,2}|月底|季度末)/.test(text)
  const constraints = unique(
    text
      .split(/[。；;\n]/)
      .filter((s) => CONSTRAINT.test(s))
      .map((s) => s.trim())
      .slice(0, 3),
  )

  const unknowns: string[] = []
  if (!recall && !hasDeadline) unknowns.push('截止时间')
  if (!recall && deliverable === 'answer') unknowns.push('交付形式')
  if (ambiguity > 0.45) unknowns.push('具体对象/范围')
  if (/(给|发|汇报)/.test(text) && !/(给谁|对谁|王工|老板|客户|团队)/.test(text)) {
    unknowns.push('受众')
  }

  const confidence = clamp(
    0.82 - ambiguity * 0.45 + (deliverable === 'answer' ? 0 : 0.08) + (constraints.length ? 0.03 : 0),
    0.2,
    0.95,
  )

  let action: IntentAction = 'execute'
  if (recall) action = 'execute'
  else if (risk === 'high') action = confidence < 0.8 ? 'ask' : 'confirm'
  else if (ambiguity >= 0.5 && confidence < 0.62) action = 'ask'
  else if ((context.stage ?? 'probation') === 'probation' && confidence < 0.72) action = 'confirm'
  else if (confidence < 0.55) action = 'confirm'

  const questions: string[] = []
  if (action !== 'execute') {
    if (unknowns.includes('截止时间')) questions.push('这件事的截止时间是什么时候？')
    if (unknowns.includes('交付形式')) questions.push('交付形式是 Word / Excel / PPT / 流程图，还是先给结论？')
    if (unknowns.includes('受众')) questions.push('这份东西是给谁看的？')
    if (unknowns.includes('具体对象/范围') && questions.length < 2) questions.push('能给我一个具体对象或范围吗？')
  }

  const goal = inferGoal(text, deliverable)
  const audience = text.match(/(?:给|发给|汇报给|抄送)([\u4e00-\u9fa5A-Za-z0-9]{1,8})/)?.[1]
  const due = text.match(/(今天|明天|后天|本周[一二三四五六日天]?|下周[一二三四五六日天]?|周[一二三四五六日天]|\d{1,2}[-/月]\d{1,2})/)?.[1]
  const readback =
    `我理解：${goal}；交付 ${deliverable}` +
    (audience ? `，给 ${audience}` : '') +
    (due ? `，${due}前` : '') +
    '。如果我理解错了，请直接说。'

  return {
    verbatim: text,
    request: text,
    goal,
    deliverable,
    audience,
    due,
    constraints,
    assumptions: buildAssumptions(deliverable, hasDeadline),
    unknowns,
    risk,
    confidence: Number(confidence.toFixed(2)),
    action,
    questions: questions.slice(0, 1),
    readback,
    reportFormat: risk === 'high' ? 'screen' : deliverable === 'answer' ? 'one_line' : 'five_lines',
  }
}

function inferGoal(text: string, deliverable: string): string {
  if (deliverable === 'pptx') return '做一份可汇报的演示材料，先结论后论据'
  if (deliverable === 'xlsx') return '把数据整理成可计算、可筛选的表格'
  if (deliverable === 'docx') return '产出一份可直接编辑/发送的文档'
  if (deliverable === 'diagram') return '把流程/结构画成可编辑、可分享的图'
  if (deliverable === 'email') return '起草一封可直接发送的邮件'
  if (deliverable === 'plan') return '给出可执行的步骤与排期'
  return text.length > 80 ? text.slice(0, 80) + '…' : text
}

function buildAssumptions(deliverable: string, hasDeadline: boolean): string[] {
  const out = ['默认使用简体中文']
  if (deliverable !== 'answer') out.push(`默认交付格式：${deliverable}`)
  if (!hasDeadline) out.push('未给截止时间，按“尽快”处理')
  out.push('未明确受众时，按“内部同事”措辞')
  return out
}

export function renderReadback(brief: IntentBrief): string {
  return brief.readback
}

export function renderIntentBrief(brief: IntentBrief): string {
  const lines = [
    '<intent>',
    `goal: ${brief.goal}`,
    `deliverable: ${brief.deliverable}`,
    `risk: ${brief.risk}; confidence: ${brief.confidence}; action: ${brief.action}`,
    `constraints: ${brief.constraints.length ? brief.constraints.join(' | ') : '(none)'}`,
    `assumptions: ${brief.assumptions.length ? brief.assumptions.join(' | ') : '(none)'}`,
    `unknowns: ${brief.unknowns.length ? brief.unknowns.join(' | ') : '(none)'}`,
  ]
  if (brief.questions.length) lines.push(`questions: ${brief.questions.join(' | ')}`)
  lines.push('</intent>')
  return lines.join('\n')
}

export interface TaskReport {
  bluf: string
  done: string[]
  evidence: string[]
  open: string[]
  next: string[]
  decisions: string[]
  at?: IsoDate
}

export function renderReport(report: TaskReport, length: ReportLength = 'five_lines'): string {
  if (length === 'one_line') return report.bluf
  if (length === 'five_lines') {
    return [
      report.bluf,
      `完成：${report.done.length ? report.done.join('；') : '无'}`,
      `未决：${report.open.length ? report.open.join('；') : '无'}`,
      `下一步：${report.next.length ? report.next.join('；') : '无'}`,
    ].join('\n')
  }
  return [
    `BLUF: ${report.bluf}`,
    '',
    '完成:',
    ...(report.done.length ? report.done.map((x) => `- ${x}`) : ['- 无']),
    '',
    '证据:',
    ...(report.evidence.length ? report.evidence.map((x) => `- ${x}`) : ['- 无']),
    '',
    '未决/风险:',
    ...(report.open.length ? report.open.map((x) => `- ${x}`) : ['- 无']),
    '',
    '需要你决策:',
    ...(report.decisions.length ? report.decisions.map((x) => `- ${x}`) : ['- 无']),
    '',
    '下一步:',
    ...(report.next.length ? report.next.map((x) => `- ${x}`) : ['- 无']),
  ].join('\n')
}
