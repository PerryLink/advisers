import { buildIntentBrief } from './intent.ts'
import type { IntentAction } from './intent.ts'

export interface IntentProbe {
  id: string
  input: string
  stage?: 'probation' | 'trusted'
  expect: {
    deliverable?: string
    action?: IntentAction[]
    risk?: 'low' | 'medium' | 'high'
  }
}

export interface ProbeResult {
  id: string
  ok: boolean
  actual: { deliverable: string; action: IntentAction; risk: string }
  expect: IntentProbe['expect']
}

const probes: IntentProbe[] = [
  { id: 'p01', input: '做一份 Q4 预算 Excel，周五前给老板，包含三张表', expect: { deliverable: 'xlsx', action: ['confirm', 'execute'], risk: 'high' } },
  { id: 'p02', input: '下周一给客户做一版汇报 PPT，先结论', expect: { deliverable: 'pptx', action: ['confirm', 'execute'], risk: 'high' } },
  { id: 'p03', input: '写一封回复王工的邮件，说明周五交付', expect: { deliverable: 'email', action: ['execute', 'confirm'] } },
  { id: 'p04', input: '整理本周项目进展，做成周报 Word', expect: { deliverable: 'docx', action: ['execute', 'confirm'] } },
  { id: 'p05', input: '画一个采购审批流程图，节点：申请、审批、付款', expect: { deliverable: 'diagram', action: ['execute', 'confirm'] } },
  { id: 'p06', input: '把这份数据做成 Excel，列：项目/金额/负责人', expect: { deliverable: 'xlsx', action: ['execute', 'confirm'] } },
  { id: 'p07', input: '做一份 10 页的 Q4 复盘 PPT，给管理层', expect: { deliverable: 'pptx', action: ['execute', 'confirm'] } },
  { id: 'p08', input: '写一个下周的工作计划，按优先级排', expect: { deliverable: 'plan', action: ['execute', 'confirm'] } },
  { id: 'p09', input: '整理客户反馈，输出一份带表格的 Word', expect: { deliverable: 'docx', action: ['confirm', 'execute'], risk: 'high' } },
  { id: 'p10', input: '把会议纪要整理成 Word，包含决议和待办', expect: { deliverable: 'docx', action: ['execute', 'confirm'] } },
  { id: 'p11', input: '那个搞一下', expect: { action: ['ask', 'confirm'] } },
  { id: 'p12', input: '帮我看看', expect: { action: ['confirm', 'ask'] } },
  { id: 'p13', input: '处理一下', expect: { action: ['ask', 'confirm'] } },
  { id: 'p14', input: '老样子', expect: { action: ['ask', 'confirm'] } },
  { id: 'p15', input: '弄一下那个表', expect: { action: ['ask', 'confirm'] } },
  { id: 'p16', input: '你懂的，按上次那个来', expect: { action: ['ask', 'confirm'] } },
  { id: 'p17', input: '把那个东西发给他', expect: { action: ['ask', 'confirm'] } },
  { id: 'p18', input: '随便弄个方案', expect: { action: ['ask', 'confirm'] } },
  { id: 'p19', input: '看一下这个数据', expect: { action: ['confirm', 'ask', 'execute'] } },
  { id: 'p20', input: '尽快处理', expect: { action: ['confirm', 'ask'] } },
  { id: 'p21', input: '把这封邮件发给客户，合同附件也带上', expect: { risk: 'high', action: ['confirm', 'ask'] } },
  { id: 'p22', input: '把钱转到这个账户', expect: { risk: 'high', action: ['ask', 'confirm'] } },
  { id: 'p23', input: '把旧数据删掉', expect: { risk: 'high', action: ['ask', 'confirm'] } },
  { id: 'p24', input: '发一封邮件给老板说项目延期', expect: { risk: 'high', action: ['confirm', 'ask'] } },
  { id: 'p25', input: '签这份合同', expect: { risk: 'high', action: ['confirm', 'ask'] } },
  { id: 'p26', input: '总结一下这份文档的三点结论', expect: { action: ['execute', 'confirm'] } },
  { id: 'p27', input: '把 120 和 300 加起来', expect: { action: ['execute', 'confirm'] } },
  { id: 'p28', input: '列出本周的三个风险', expect: { action: ['execute', 'confirm'] } },
  { id: 'p29', input: '解释一下这个函数做什么', expect: { action: ['execute', 'confirm'] } },
  { id: 'p30', input: '把这段中文翻译成英文', expect: { action: ['execute', 'confirm'] } },
]

export const INTENT_PROBES = probes

export function runIntentProbes(input: IntentProbe[] = probes): ProbeResult[] {
  return input.map((probe) => {
    const brief = buildIntentBrief(probe.input, { stage: probe.stage ?? 'trusted' })
    const okDeliverable = !probe.expect.deliverable || brief.deliverable === probe.expect.deliverable
    const okAction = !probe.expect.action || probe.expect.action.includes(brief.action)
    const okRisk = !probe.expect.risk || brief.risk === probe.expect.risk
    return {
      id: probe.id,
      ok: okDeliverable && okAction && okRisk,
      actual: { deliverable: brief.deliverable, action: brief.action, risk: brief.risk },
      expect: probe.expect,
    }
  })
}
