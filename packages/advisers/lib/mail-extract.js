/**
 * Local-first commitment extraction for the 0.4.0 mail entry.
 *
 * DEFAULT PATH (`extractLocalCandidates`) is fully offline/deterministic:
 *   sentence split -> commitment trigger patterns (zh/en) -> verbatim quote
 *   -> due date via lib/relative-date.js (Asia/Shanghai) -> amount/currency
 *   -> client/project HINTS (never automatic binding) -> memory_candidates
 *   compatible payload (kind 'commitment').
 *
 * The model path (`extractCandidatesWithModel`) is OPT-IN and never called by
 * mailSync or by the default `mailExtract` flow. It requires an explicit
 * ADVISERS_API_KEY, wraps the body with lib/untrusted.js, clips it to 8 KiB,
 * sends no attachment/header bytes and reuses the audited capture pipeline
 * (safety classify + verbatim quote validation). Candidates stay pending;
 * nothing is auto-accepted.
 *
 * Known limits (documented, not bugs): request/polite sentences are not
 * promises; meeting reschedules are a known false-positive class; the rules
 * are calibrated for typical Chinese/English business mail and every
 * candidate is reviewed by a human before it reaches the ledger.
 */
import { normalizeDue } from './relative-date.js'
import { mailError, MAIL_ERROR_CODES } from './mail-errors.js'

export const LOCAL_MAX_CANDIDATES = 5
export const MODEL_MAX_INPUT_CHARS = 8000
export const MAX_QUOTE_CHARS = 500
export const MAX_ACTION_CHARS = 40

const ACTION_VERBS = [
  '发送', '发', '提交', '交付', '回复', '确认', '提供', '安排', '完成', '给出',
  '上线', '付款', '打款', '支付', '签署', '签', '寄', '送', '对接', '处理',
  '反馈', '准备', '整理', '跟进', '汇报', '报价', '回访', '续约',
]
const EN_ACTION_VERBS = ['send', 'submit', 'deliver', 'reply', 'confirm', 'provide', 'finish', 'complete', 'pay', 'share', 'prepare', 'upload', 'review', 'fix', 'quote']
// A request is only a request when the sentence STARTS with one: a promise
// sentence may legitimately mention "please" later ("I will send it, please review").
const REQUEST_RE = /^(?:请|麻烦|烦请|劳驾|能否|可否|能不能|可以(?:帮我|帮忙)?|帮忙|劳烦)|^\s*(?:could|can|would|please)\b/i
const RESCHEDULE_RE = /(?:改期|改到|改在|推迟|延后|另行通知|时间改|推到|挪到|顺延)/
const TENTATIVE_RE = /(?:尽量|争取|应该|大概|可能|回头|到时候|看看|有空)/
const STRONG_RE = /(?:一定|保证|承诺|答应|务必|准时|肯定)/
const FIRST_PERSON_RE = /(?:我|我们|本人|咱们)/
const THIRD_PERSON_RE = /(?:他|她|他们|她们|对方|客户|乙方|供应商|厂家|甲方)/

function splitSentences(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    // Chinese/ASCII sentence punctuation plus an ASCII full stop followed by
    // a capitalised new sentence (keeps 3.5 / U.S. intact).
    .split(/[\n。！？!?；;]+|\.\s+(?=[A-Z])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function compact(text) {
  return String(text == null ? '' : text).replace(/\s+/g, '')
}

function capAction(value) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, MAX_ACTION_CHARS) : undefined
}

function actionOf(sentence) {
  const carry = /(?:把|将)([^。！？!?\n，,：:]{1,16}?)(发送|发|提交|交付|回复|确认|提供|安排|完成|给出|上线|付款|打款|支付|签署|寄|送|对接|处理|反馈|报价)/.exec(sentence)
  if (carry) return capAction(carry[2] + carry[1])
  let first = null
  for (const verb of ACTION_VERBS) {
    const index = sentence.indexOf(verb)
    if (index === -1) continue
    if (!first || index < first.index) first = { index, verb }
  }
  if (first) {
    const after = sentence.slice(first.index + first.verb.length).replace(/^[\s，,：:]*(?:给|到|至|你|您|他|她|他们|客户|对方)?/, '').slice(0, 12)
    return capAction(first.verb + after)
  }
  const english = /\b(?:will|'ll|promise to|going to|shall)\s+([a-z]+(?:\s+[a-z]+){0,4})/i.exec(sentence)
  if (english) {
    const words = english[1].split(/\s+/).slice(0, 5).join(' ')
    return capAction(words.replace(/\b(the|a|an)\b\s*/gi, ''))
  }
  for (const verb of EN_ACTION_VERBS) {
    const match = new RegExp('\\b' + verb + '\\b([^.!?\\n]{0,30})', 'i').exec(sentence)
    if (match) return capAction((verb + match[1]).replace(/\s+/g, ' ').trim().slice(0, MAX_ACTION_CHARS))
  }
  return undefined
}

function toMinor(numberText, unit) {
  const clean = String(numberText).replace(/,/g, '')
  const [integerPart, fractionRaw = ''] = clean.split('.')
  if (!/^\d+$/.test(integerPart)) return null
  const fraction = (fractionRaw + '00').slice(0, 2)
  let minor = BigInt(integerPart) * 100n + BigInt(fraction)
  if (unit === '万') minor *= 10000n
  else if (unit === '千') minor *= 1000n
  if (minor <= 0n || minor > 100_000_000_000_000n) return null
  return Number(minor)
}

/** Extract one explicit money amount from text: { amountMinor, currency } or null. */
export function extractMailAmount(text) {
  const source = String(text == null ? '' : text)
  let match = /(?:¥|￥|RMB|CNY|人民币)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(万|千)?/i.exec(source)
  if (match) {
    const minor = toMinor(match[1], match[2] === '万' ? '万' : match[2] === '千' ? '千' : null)
    if (minor) return { amountMinor: minor, currency: 'CNY' }
  }
  match = /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(万元|万|千元|元|块(?:钱)?)/.exec(source)
  if (match) {
    const unit = match[2].startsWith('万') ? '万' : match[2].startsWith('千') ? '千' : null
    const minor = toMinor(match[1], unit)
    if (minor) return { amountMinor: minor, currency: 'CNY' }
  }
  match = /(?:USD|US\$|\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(source)
  if (match) {
    const minor = toMinor(match[1], null)
    if (minor) return { amountMinor: minor, currency: 'USD' }
  }
  match = /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:美元|美金)/.exec(source)
  if (match) {
    const minor = toMinor(match[1], null)
    if (minor) return { amountMinor: minor, currency: 'USD' }
  }
  return null
}

function normalizeKey(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse a From header into display name / address / domain. */
export function parseFromAddress(from) {
  const text = String(from == null ? '' : from).trim()
  const bracketed = /<([^<>\s]+@[^<>\s]+)>/.exec(text)
  const emailMatch = bracketed || /([^\s<>]+@[^\s<>]+)/.exec(text)
  const email = emailMatch ? emailMatch[1].trim() : ''
  let display = ''
  if (bracketed) display = text.slice(0, bracketed.index).replace(/["']/g, '').trim()
  else if (!email) display = text
  const domain = email.includes('@') ? email.split('@').pop().toLowerCase().replace(/[>),;]+$/, '') : ''
  const local = email.includes('@') ? email.split('@')[0].toLowerCase() : ''
  return { display, email, domain, local }
}

/**
 * Client/project HINTS from the From header, subject and body.
 * NEVER writes a binding: docs/CLIENTS.md forbids automatic customer
 * identification, so the candidate only carries a suggestion.
 */
export function matchMailHints({ from = '', subject = '', text = '' } = {}, { clients = [], projects = [] } = {}) {
  const parsed = parseFromAddress(from)
  const haystack = compact(normalizeKey([parsed.display, subject, text].filter(Boolean).join(' ')))
  const domain = parsed.domain.replace(/\s+/g, '')
  let clientHint
  // Pass 1: address domain / exact From display name (stronger than a substring
  // in the body). Pass 2: name or alias mentioned in From/subject/body.
  for (const client of Array.isArray(clients) ? clients : []) {
    if (!client || typeof client !== 'object' || !client.id) continue
    const names = [client.name, ...(Array.isArray(client.aliases) ? client.aliases : [])].filter(Boolean)
    for (const name of names) {
      const key = normalizeKey(name)
      const keyCompact = key.replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
      if (keyCompact.length >= 3 && domain.includes(keyCompact)) {
        clientHint = { id: client.id, name: client.name, basis: 'address-domain', confidence: 0.75 }
        break
      }
      if (parsed.display && compact(normalizeKey(parsed.display)) === compact(normalizeKey(client.name))) {
        clientHint = { id: client.id, name: client.name, basis: 'from-name', confidence: 0.8 }
        break
      }
    }
    if (clientHint) break
  }
  if (!clientHint) {
    for (const client of Array.isArray(clients) ? clients : []) {
      if (!client || typeof client !== 'object' || !client.id) continue
      const names = [client.name, ...(Array.isArray(client.aliases) ? client.aliases : [])].filter(Boolean)
      for (const name of names) {
        const keyCompact = normalizeKey(name).replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
        if (!keyCompact) continue
        const latin = /^[a-z0-9]+$/.test(keyCompact)
        if (haystack.includes(keyCompact) && (!latin || keyCompact.length >= 3)) {
          clientHint = { id: client.id, name: client.name, basis: 'message', confidence: 0.6 }
          break
        }
      }
      if (clientHint) break
    }
  }
  let projectHint
  const projectHaystack = compact(normalizeKey([subject, text].filter(Boolean).join(' ')))
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project || typeof project !== 'object' || !project.id) continue
    const key = normalizeKey(project.name).replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
    if (key.length < 2 || !projectHaystack.includes(key)) continue
    projectHint = { id: project.id, name: project.name, ...(project.clientId ? { clientId: project.clientId } : {}), basis: 'message', confidence: 0.6 }
    break
  }
  return { clientHint, projectHint }
}

function exceedsQuote(quote) {
  return String(quote).length > MAX_QUOTE_CHARS
}

function analyzeSentence(sentence, { messageDate, hints, parsedFrom, receivedAt }) {
  const source = String(sentence)
  if (REQUEST_RE.test(source) && !FIRST_PERSON_RE.test(source)) return null
  const strong = STRONG_RE.test(source)
  if (RESCHEDULE_RE.test(source) && !strong) return null
  let debtor = null
  if (/(?:我|我们|本人)(?:会|将|一定|保证|承诺|答应|争取|尽量)/.test(source)) debtor = 'user'
  if (debtor == null && /(?:我|我们|本人)[^。！？!?\n]{0,60}(?:前|之前|以前|内|截止)/.test(source) && ACTION_VERBS.some((verb) => source.includes(verb))) debtor = 'user'
  if (debtor == null && /(?:我|我们|本人)(?:明天|后天|今天|本周|这周|下周|下个月|月底|下周一|周[一二三四五六日天]|[0-9]{1,2}月[0-9]{1,2}[日号]|[0-9]{1,2}号)/.test(source) && ACTION_VERBS.some((verb) => source.includes(verb))) debtor = 'user'
  if (debtor == null && /\b(?:i|we)\b[^.!?\n]{0,40}\b(?:will|'ll|shall|promise to|am going to|are going to)\b/i.test(source)) debtor = 'user'
  if (debtor == null && /\b(?:i|we)\b[^.!?\n]{0,60}\b(?:by|before|no later than)\b/i.test(source) && /\b(?:send|submit|deliver|reply|confirm|provide|finish|complete|pay|share|prepare|upload|review|fix)\b/i.test(source)) debtor = 'user'
  if (debtor == null && THIRD_PERSON_RE.test(source) && /(?:会|将|答应|承诺|同意|保证)/.test(source)) debtor = 'third'
  if (debtor == null && /\b(?:he|she|they|the client|the vendor|the supplier)\b[^.!?\n]{0,30}\b(?:will|promised to|agreed to)\b/i.test(source)) debtor = 'third'
  if (debtor == null) return null
  const quote = source.trim()
  if (!quote || exceedsQuote(quote)) return null
  const action = actionOf(source)
  if (!action) return null
  const due = normalizeDue({ quote, text: source, messageDate })
  const money = extractMailAmount(source)
  const uncertain = TENTATIVE_RE.test(source)
  const confidence = strong ? 0.85 : uncertain ? 0.55 : 0.7
  const uncertaintyParts = []
  if (due.ambiguous) uncertaintyParts.push('相对日期有歧义，已按消息时间解析')
  if (uncertain) uncertaintyParts.push('语气为“尽量/争取”，不保证完成')
  if (!due.dueAt) uncertaintyParts.push('未识别到明确日期')
  return {
    action,
    debtor,
    creditor: debtor === 'third' ? (hints.thirdPartyName ?? parsedFrom.display ?? undefined) : (parsedFrom.display || undefined),
    ...(due.dueAt ? { dueAt: due.dueAt, dueBasis: due.basis } : {}),
    ...(due.ambiguous ? { dueAmbiguous: true } : {}),
    ...(money ? { amountMinor: money.amountMinor, currency: money.currency } : {}),
    quote,
    modal: strong ? 'firm' : uncertain ? 'tentative' : 'firm',
    confidence,
    uncertainty: uncertaintyParts.join('；').slice(0, 160),
    extractor: 'local',
    receivedAt: receivedAt ?? undefined,
  }
}

/**
 * Deterministic offline extraction for one message.
 * @returns {{ candidates: object[], hints: {clientHint?, projectHint?} }}
 */
export function extractLocalCandidates({
  text = '', subject = '', from = '', receivedAt, clients = [], projects = [], now,
} = {}) {
  const parsedFrom = parseFromAddress(from)
  const hints = matchMailHints({ from, subject, text }, { clients, projects })
  const messageDate = receivedAt ? new Date(receivedAt) : now instanceof Date ? now : new Date(now ?? Date.now())
  const anchor = Number.isFinite(messageDate.getTime()) ? messageDate : new Date()
  const normalizedQuote = compact(text)
  const candidates = []
  for (const sentence of splitSentences(text)) {
    if (candidates.length >= LOCAL_MAX_CANDIDATES) break
    const candidate = analyzeSentence(sentence, { messageDate: anchor, hints, parsedFrom, receivedAt: anchor.toISOString() })
    if (!candidate) continue
    if (!normalizedQuote.includes(compact(candidate.quote))) continue
    const duplicate = candidates.some((row) => row.quote === candidate.quote)
    if (duplicate) continue
    candidates.push({ ...candidate, ...(hints.clientHint ? { clientHint: hints.clientHint } : {}), ...(hints.projectHint ? { projectHint: hints.projectHint } : {}) })
  }
  return { candidates, hints }
}

/**
 * Build the source-ref object stored on a mail candidate's evidence.
 * IMAP rows use `imap:<account>:<uidvalidity>:<uid>`; .eml rows use
 * `eml:<account>:<messageRowId>`. Quote-only evidence; never the body.
 */
export function mailEvidenceSource(message, { now } = {}) {
  const accountId = message?.accountId ?? 'unknown'
  const localRow = message?.uidvalidity === 'local' || message?.mailbox === 'local'
  const ref = message?.uid != null && !localRow
    ? 'imap:' + accountId + ':' + (message.uidvalidity ?? 'unknown') + ':' + message.uid
    : 'eml:' + accountId + ':' + (message.id ?? 'unknown')
  const capturedAt = message?.receivedAt ?? (now instanceof Date ? now.toISOString() : new Date().toISOString())
  return {
    type: 'mail',
    ref,
    ...(message?.messageId ? { messageId: message.messageId } : {}),
    ...(message?.subject ? { subject: String(message.subject).slice(0, 200) } : {}),
    capturedAt,
  }
}

/**
 * Map one extractor candidate to the memory_candidates shape reused by
 * `advisers memory accept` (kind 'commitment', payload + evidence).
 */
export function toMemoryCandidate(candidate, { message, matterId, now } = {}) {
  const payload = {
    ...(matterId ? { matterId } : {}),
    debtor: candidate.debtor === 'third' ? 'third' : 'user',
    creditor: candidate.creditor || 'someone',
    action: candidate.action,
    ...(candidate.dueAt ? { dueAt: candidate.dueAt } : {}),
    capability: 'none',
    extractor: candidate.extractor ?? 'local',
    ...(candidate.amountMinor ? { amountMinor: candidate.amountMinor, currency: candidate.currency ?? 'CNY' } : {}),
    ...(candidate.clientHint ? { clientHint: candidate.clientHint } : {}),
    ...(candidate.projectHint ? { projectHint: candidate.projectHint } : {}),
  }
  return { kind: 'commitment', payload, evidence: [{ quote: candidate.quote, source: mailEvidenceSource(message, { now }) }] }
}

/**
 * OPT-IN model extraction. Never called by mailSync or by the local default.
 * Requires an API key and reuses lib/capture.js (safety classify + verbatim
 * quote validation) with the body inside the untrusted-data boundary.
 */
export async function extractCandidatesWithModel({
  text = '', subject = '', from = '', receivedAt, apiKey, baseUrl, model, fetchImpl, safetyKey,
  maxChars = MODEL_MAX_INPUT_CHARS, now,
} = {}) {
  if (!apiKey) {
    throw mailError(MAIL_ERROR_CODES.MODEL_DISABLED, 'mail extract --model requires ADVISERS_API_KEY', 'model extraction is opt-in; the default --local path never calls a model')
  }
  const body = String(text == null ? '' : text).slice(0, Math.max(1, Number(maxChars) || MODEL_MAX_INPUT_CHARS))
  if (!body.trim()) return { candidates: [], safetyWarnings: [] }
  const [{ wrapUntrusted }, { captureCandidates }] = await Promise.all([import('./untrusted.js'), import('./capture.js')])
  const wrapped = wrapUntrusted('mail:message', body)
  let messageDate = receivedAt ? new Date(receivedAt) : now ? new Date(now) : new Date()
  if (!Number.isFinite(messageDate.getTime())) messageDate = new Date()
  const result = await captureCandidates({
    text: wrapped, apiKey, baseUrl, model, fetchImpl,
    date: messageDate, source: 'email', now: messageDate, safetyKey,
  })
  const candidates = (Array.isArray(result.candidates) ? result.candidates : []).map((candidate) => ({
    ...candidate,
    extractor: 'model',
    receivedAt: messageDate.toISOString(),
  }))
  return {
    candidates,
    ...(Array.isArray(result.safetyWarnings) && result.safetyWarnings.length ? { safetyWarnings: result.safetyWarnings } : {}),
  }
}
