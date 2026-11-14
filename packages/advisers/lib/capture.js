import { chatCompletion } from './model.js'
import { describeMessageTime, normalizeDue } from './relative-date.js'

const MAX_CANDIDATES = 5
const MAX_CHARS = 20_000

function normalize(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
}

export function buildCapturePrompt(text, { date = new Date(), source = 'wechat' } = {}) {
  const clock = describeMessageTime(date)
  return [
    '从下面这段中文工作内容里抽取“承诺/义务”候选。只做候选，不写账本。',
    `来源：${source}；消息时间：${clock.label}；今天是 ${clock.date}（${clock.weekday}）。`,
    '规则：',
    '1. 只抽明确义务：我答应别人、别人答应我、双方待定；不要把请求、客套、计划、愿望当承诺。',
    '2. quote 必须逐字来自原文，不改标点/不补字；找不到原句就不要输出。',
    '2b. action 必须是 12 字以内的动词短语，去掉“把/给+人名”，例如“发报价”而不是“把报价发给王工”。',
    '3. modal: firm（我会/一定/周五前）、tentative（尽量/争取/应该/回头）、conditional（如果/前提）。',
    '4. dueAt 用 ISO 8601（带 +08:00）；相对日期一律以“消息时间”的 Asia/Shanghai 本地日期为基准换算，禁止按 UTC 日期；无法确定就 null，并在 uncertainty 写明。',
    '4b. 参考：今天=消息当天；明天=+1；后天=+2；周X=本周或下一个周X；下周X=下一周；月底=当月最后一天；季度末=当季最后一天。',
    '5. debtor: user（我）/ third（对方）/ unknown；creditor 是对方名字，未知写 null。',
    '6. 最多 5 条；宁少勿多；每条的 uncertainty 写一个短原因。',
    '输出严格 JSON：{"candidates":[{"action":"","debtor":"user|third|unknown","creditor":null,"dueAt":null,"quote":"","modal":"firm|tentative|conditional","confidence":0.0,"uncertainty":""}]}',
    '',
    '原文：',
    text,
  ].join('\n')
}

export function parseCaptureResponse(content) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed?.candidates)) return []
  return parsed.candidates
}

export function validateCaptureCandidates(candidates, text, { now = new Date(), messageDate, max = MAX_CANDIDATES } = {}) {
  const original = normalize(text)
  const compact = original.replace(/\s+/g, '')
  const anchor = messageDate ?? now
  const out = []
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || typeof c !== 'object') continue
    const quote = String(c.quote || '')
    if (!quote || !compact.includes(quote.replace(/\s+/g, ''))) continue
    const action = String(c.action || '').trim()
    if (!action || action.length > 200) continue
    const debtor = ['user', 'third', 'unknown'].includes(c.debtor) ? c.debtor : 'unknown'
    // Deterministic date pass: the model is good at spotting commitments but
    // unreliable at calendar arithmetic (and used to receive a UTC clock).
    const due = normalizeDue({ dueAt: c.dueAt, quote, text: original, messageDate: anchor })
    const ambiguityNote = due.ambiguous ? '相对日期有歧义，已按消息时间规则解析' : ''
    out.push({
      action,
      debtor,
      creditor: c.creditor == null ? undefined : String(c.creditor).slice(0, 60),
      dueAt: due.dueAt,
      dueBasis: due.basis,
      dueAmbiguous: due.ambiguous || undefined,
      quote,
      modal: ['firm', 'tentative', 'conditional'].includes(c.modal) ? c.modal : 'tentative',
      confidence: Math.max(0, Math.min(1, Number(c.confidence) || 0.5)),
      uncertainty: String(c.uncertainty || ambiguityNote || '').slice(0, 160),
    })
    if (out.length >= max) break
  }
  return out
}

export async function captureCandidates({ text, apiKey, baseUrl, model, fetchImpl = fetch, date, source, now = new Date() }) {
  const input = normalize(text)
  if (!input) return { candidates: [], usage: undefined }
  if (input.length > MAX_CHARS) throw new Error(`capture input is too long (max ${MAX_CHARS} chars)`)
  const messageDate = date ? new Date(date) : now
  if (!Number.isFinite(messageDate.getTime())) throw new Error('capture message date is invalid')
  const result = await chatCompletion({
    messages: [
      { role: 'system', content: '你是严谨的中文工作秘书。只输出 JSON，不输出解释。' },
      { role: 'user', content: buildCapturePrompt(input, { date: messageDate, source }) },
    ],
    apiKey, baseUrl, model, fetchImpl,
    task: 'capture', thinking: true, effort: 'high', maxTokens: 4096,
  })
  return { candidates: validateCaptureCandidates(parseCaptureResponse(result.content), input, { now, messageDate }), usage: result.usage, raw: result }
}
