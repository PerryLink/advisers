/**
 * Human-readable safety explanations (the copy behind `advisers safety explain`).
 *
 * Contract: the public explanation may reveal the CATEGORY, action, ruleset
 * version and evidence-hash prefix, but never the matched text or the rule
 * keywords. Full rule tables stay private to reduce evasion.
 */

import { CATEGORY_BY_ID, RULESET_VERSION } from './rules.js'

export const EXPLAIN_FORMAT = 'advisers-safety-explain'
export const NOTICE_VERSION = 1

/** Crisis resources; self-harm is never blocked, only escalated. */
export const CRISIS_RESOURCES = Object.freeze({
  mainlandHotline: '12356',
  emergency: '120',
  police: '110',
  international: Object.freeze(['US 988', 'UK 116 123']),
})

const CODE_HINTS = Object.freeze({
  CSAM: '检测到涉及未成年人的性剥削内容，已阻止处理。',
  TERRORISM_OPERATIONS: '检测到恐怖主义操作指引，已阻止处理。',
  ILLEGAL_INSTRUCTION: '检测到直接违法教唆（制毒、制爆、武器改装等），已阻止处理。',
  MALWARE_WEAPONIZED: '检测到恶意代码或网络攻击武器化内容，已阻止处理。',
  PII_BULK_EXFIL: '检测到批量个人信息外泄内容，已阻止处理。',
  SELFHARM_CRISIS: '检测到自伤风险，已触发危机提示（内容未被阻断）。',
  PII: '检测到个人信息或密钥，已按脱敏处理（原文不落盘）。',
  PROMPT_INJECTION: '检测到提示注入或越权指令，已提示风险并加固系统边界。',
  SAFETY_INTERNAL_ERROR: '本地审核出现异常，已按保守策略处理。',
})

const ACTION_LABELS = Object.freeze({
  allow: '允许',
  warn: '提醒',
  confirm: '需确认',
  redact: '脱敏',
  block: '已拦截',
})

/** Public category label; no rule keywords are exposed. */
export function categoryLabel(categoryId) {
  const category = CATEGORY_BY_ID[categoryId]
  return category ? category.labelZh : '未分类风险'
}

/** Evidence hashes are keyed one-way digests; show only a short prefix. */
export function formatEvidenceHash(hash) {
  if (!hash) return '不可用（未配置审计密钥）'
  return String(hash).slice(0, 8) + '…'
}

function categoriesText(result) {
  const list = (result && result.categories) || []
  if (!list.length) return '未分类风险'
  return list.map(categoryLabel).join('、')
}

function seqText(seq) {
  return seq == null ? '当前事件' : '事件 #' + String(seq)
}

function reportHint(seq) {
  return seq == null ? 'advisers safety report' : 'advisers safety report ' + String(seq)
}

function explainHint(seq) {
  return seq == null ? 'advisers safety explain' : 'advisers safety explain ' + String(seq)
}

/**
 * Why did this happen? Used by `advisers safety explain <seq>`.
 * Accepts the audit-row shape; never includes the original text.
 */
export function explainAudit(event = {}) {
  const seq = event.seq
  const surface = event.surface || 'unknown'
  const action = event.action || 'warn'
  const code = event.code || 'NONE'
  const categories = event.categories && event.categories.length
    ? event.categories
    : (event.category ? [event.category] : [])
  const ruleIds = event.ruleIds || []
  const evidenceHash = event.evidenceHash || null
  const rulesetVersion = event.rulesetVersion || RULESET_VERSION
  const at = event.at || ''
  const hint = CODE_HINTS[code]
  const lines = []
  lines.push(seqText(seq) + (at ? ' · ' + at : ''))
  lines.push('surface=' + surface + ' · 动作=' + (ACTION_LABELS[action] || action) + ' · 类别=' + categories.map(categoryLabel).join('、'))
  lines.push('规则版本=' + rulesetVersion + ' · 规则=' + (ruleIds.length ? ruleIds.join(',') : '—'))
  lines.push('证据哈希=' + formatEvidenceHash(evidenceHash) + '（不可逆）')
  if (hint) lines.push('说明：' + hint)
  lines.push('误判？' + reportHint(seq) + '。' + explainHint(seq) + '。完整规则表不公开，以避免被规避。')
  return lines.join('\n')
}

/** Copy shown when a block decision stops a request. */
export function blockNotice(result = {}, options = {}) {
  const seq = options.seq
  const lines = []
  lines.push('已拦截：这段内容可能涉及' + categoriesText(result) + '，Advisers 不能生成或代为处理。')
  lines.push('你可以：改写需求（' + explainHint(seq) + ' 查看原因）；如果是误判，' + reportHint(seq) + ' 反馈。')
  if (result.crisis) lines.push(crisisNotice())
  else lines.push('涉及未成年人或即时危险，请拨 110；紧急医疗请拨 120。')
  return lines.join('\n')
}

/** Copy shown when a warn decision lets the request continue with a notice. */
export function warnNotice(result = {}, options = {}) {
  const seq = options.seq
  const lines = []
  lines.push('提醒：检测到可能的风险（' + categoriesText(result) + '）。内容已保留，请自行判断是否继续。')
  lines.push('继续使用可能违反法律或平台规则；误判可执行 ' + reportHint(seq) + ' 反馈。')
  return lines.join('\n')
}

/** Copy shown when the user must explicitly confirm a risk (confirm action). */
export function confirmNotice(result = {}, options = {}) {
  const seq = options.seq
  const lines = []
  lines.push('需要确认：检测到可能的风险（' + categoriesText(result) + '）。')
  lines.push('继续意味着你自行承担相应责任；输入 y 继续，输入 n 取消。')
  lines.push('如需了解原因：' + explainHint(seq) + '；误判反馈：' + reportHint(seq) + '。')
  return lines.join('\n')
}

/** Self-harm: never blocked, always escalate to crisis resources. */
export function crisisNotice() {
  return [
    '我很在意你现在的安全。先不要一个人扛着：请联系身边可信任的人，或拨打当地急救/心理援助热线。',
    '中国大陆可拨 ' + CRISIS_RESOURCES.mainlandHotline + '；紧急医疗 ' + CRISIS_RESOURCES.emergency + '；报警 ' + CRISIS_RESOURCES.police + '。',
    '如果你现在有立即伤害自己的打算，请直接拨打 ' + CRISIS_RESOURCES.emergency + '/' + CRISIS_RESOURCES.police + '。',
    '（国际：' + CRISIS_RESOURCES.international.join(' / ') + '。）',
  ].join('\n')
}

/** Pick the notice matching a classify() result. */
export function explainResult(result = {}, options = {}) {
  switch (result.action) {
    case 'block':
      return blockNotice(result, options)
    case 'confirm':
      return confirmNotice(result, options)
    case 'warn':
      return result.crisis ? crisisNotice() : warnNotice(result, options)
    case 'redact': {
      const labels = (result.categories || []).map(categoryLabel).filter(Boolean)
      return labels.length
        ? '已按个人信息保护要求脱敏（' + labels.join('、') + '）。'
        : '已按个人信息保护要求脱敏。'
    }
    default:
      return ''
  }
}
