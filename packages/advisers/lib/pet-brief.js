/**
 * Pet Brief producer — read-only, redacted, expiring projection from the
 * Advisers ledger to desktop-pet consumers (contract v0.2, docs/PET-BRIEF-PRODUCER.md).
 *
 * Pure functions: no network, no model call, no ledger writes. The caller
 * supplies the ledger (loaded read-only by the CLI) and an injectable `now`.
 *
 * Privacy rules implemented here (see docs/PET-BRIEF-PRODUCER.md):
 * - matters with secrecy >= 2 are excluded entirely (not even counted in arrays);
 * - facts below 0.7 confidence are dropped before output;
 * - person/client names are masked to `某客户` by default and never echoed back;
 * - no reasoning, prompts, secrets, document bodies, or emotional fields;
 * - every suggested line is built from a field that is present in the brief;
 * - `displayPolicy` states who may see the brief (public/private/none); it
 *   defaults to `private` and is never `public` unless explicitly requested.
 */
import { localDay } from './remind.js'
import { atomicWriteFileSync } from './fs-safe.js'
import { classify } from './safety/index.js'

export const PET_BRIEF_SCHEMA_VERSION = 2
/** v0.1 briefs (contract before `displayPolicy`) are still accepted with warnings. */
export const PET_BRIEF_LEGACY_SCHEMA_VERSION = 1
/** Schema versions `validatePetBrief` can read (v0.1 = legacy, warnings only). */
export const PET_BRIEF_SCHEMA_VERSIONS = [PET_BRIEF_LEGACY_SCHEMA_VERSION, PET_BRIEF_SCHEMA_VERSION]
/** Contract v0.2 display policy: who may see brief-derived content. */
export const PET_BRIEF_DISPLAY_POLICIES = ['public', 'private', 'none']
/** Safe default: never `public` unless the user explicitly opts in. */
export const PET_BRIEF_DEFAULT_DISPLAY_POLICY = 'private'
export const PET_BRIEF_SOURCE = 'advisers'
export const PET_BRIEF_TTL_MS = 5 * 60_000
export const PET_BRIEF_MAX_ITEMS = 10
export const PET_BRIEF_MIN_CONFIDENCE = 0.7
export const PET_BRIEF_MAX_SUGGESTED_LINES = 3
export const PET_BRIEF_MAX_LINE_LENGTH = 40
export const PET_BRIEF_MOODS = ['calm', 'focused', 'concerned', 'pleased']

// Content-safety wiring (docs/CONTENT-SAFETY.md section 8): suggested lines and
// risk summaries are classified with the pet-brief surface. A block-level line
// is dropped entirely (fail-closed, no schema change: counts are derived from
// the arrays) and only a generic note is added to redactions - never the text.
const PET_BRIEF_SURFACE = 'pet-brief'

function isBlockedLine(text, hmacKey) {
  return classify(text, { surface: PET_BRIEF_SURFACE, hmacKey }).action === 'block'
}

/** Contract §2.2. Matched case-insensitively with `_`/`-`/spaces removed. */
export const PET_BRIEF_FORBIDDEN_KEYS = [
  'reasoning', 'cot', 'chainofthought', 'rawprompt', 'systemprompt',
  'clientsecret', 'apikey', 'token', 'password',
  'affection', 'love', 'missedyou', 'streak', 'guilt',
]

const ROOT_KEYS = [
  'schemaVersion', 'generatedAt', 'expiresAt', 'source', 'displayPolicy', 'counts',
  'today', 'commitments', 'risks', 'facts', 'mood', 'suggestedLines', 'redactions',
]
const ITEM_KEYS = {
  today: ['id', 'title', 'status'],
  commitments: ['id', 'matter', 'who', 'what', 'due', 'risk', 'confidence'],
  risks: ['id', 'level', 'summary', 'evidence', 'confidence'],
  facts: ['id', 'subject', 'predicate', 'value', 'confidence'],
}
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const RISK_LEVEL = ['low', 'medium', 'high']
const TODAY_STATUS = ['open', 'doing', 'done']

/** Creditors/subjects that are roles or groups, not personal names. */
const GENERIC_WHO = new Set([
  '团队', '客户', '某客户', '客户方', '公司', '部门', '领导', '同事', '同学', '老师',
  '家人', '朋友', '对方', '某人', '自己', '用户', '老板', '甲方', '乙方', '供应商',
  '伙伴', '项目组', '全员', '大家', 'hr', '财务', '法务', '行政', '运营', '销售',
])
const NAME_SUFFIX = '(?:工|总|老师|经理|总监|主任|医生|律师|先生|女士|姐|哥|叔|阿姨|经理)'
const VERB_NAME = new RegExp(`(给|向|找|和|与|跟|回复|联系|问|让|等|约|催)([\\u4e00-\\u9fa5]{1,2}${NAME_SUFFIX})`, 'g')

function toMillis(value) {
  if (value === undefined || value === null) return Date.now()
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Clip by Unicode code points so a sentence never exceeds the contract limit. */
function clip(value, max) {
  const points = Array.from(String(value ?? ''))
  return points.length <= max ? points.join('') : points.slice(0, max).join('')
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function looksLikePersonName(value) {
  const text = oneLine(value)
  if (!text || GENERIC_WHO.has(text.toLowerCase())) return false
  if (new RegExp(`^[\\u4e00-\\u9fa5]{1,4}${NAME_SUFFIX}$`, 'u').test(text)) return true
  if (/^[\u4e00-\u9fa5]{2,3}$/u.test(text)) return true
  if (/^[A-Z][a-z]{1,10}\s+[A-Z][a-z]{1,10}$/.test(text)) return true
  return false
}

/**
 * Deterministic name redactor. Collects likely person names from the ledger
 * first, then masks exact matches plus common "<verb><surname><role>" forms in
 * titles/actions. `masked` is a count of replacements (for `redactions`).
 */
function createRedactor(rawNames) {
  const names = [...new Set((rawNames ?? []).map(oneLine).filter((name) => looksLikePersonName(name)))]
    .sort((a, b) => b.length - a.length || cmp(a, b))
  let masked = 0
  const redact = (value) => {
    let text = oneLine(value)
    if (!text) return text
    for (const name of names) {
      if (!text.includes(name)) continue
      masked += text.split(name).length - 1
      text = text.split(name).join('某客户')
    }
    text = text.replace(VERB_NAME, (_match, verb) => {
      masked += 1
      return `${verb}某客户`
    })
    return text
  }
  return { redact, masked: () => masked }
}

function matterSecrecy(matter) {
  if (!matter) return Number.POSITIVE_INFINITY
  const level = Number(matter.secrecy ?? 0)
  return Number.isFinite(level) ? level : Number.POSITIVE_INFINITY
}

function isPublicMatter(matter) {
  return Boolean(matter) && matter.status === 'active' && matterSecrecy(matter) < 2
}

function confidenceOfCommitment(commitment) {
  return Array.isArray(commitment.evidence) && commitment.evidence.length > 0 ? 0.95 : 0.75
}

function riskOfDue(dueMs, nowMs, today) {
  if (dueMs < nowMs) return 'high'
  const day = localDay(new Date(dueMs).toISOString())
  if (day === today) return 'high'
  if (dueMs <= nowMs + 3 * 86_400_000) return 'medium'
  return 'low'
}

const RISK_RANK = { low: 1, medium: 2, high: 3 }

/**
 * Build the brief document. Deterministic for the same ledger + now.
 *
 * @param {object} ledger Advisers core `Ledger` (listMatters/listCommitments/listFacts).
 * @param {object} [options]
 * @param {number|string|Date} [options.now]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxItems]
 * @param {number} [options.minConfidence]
 * @param {'public'|'private'|'none'} [options.displayPolicy='private'] who may see the brief
 * @returns {object} contract v0.2 brief (no writes, no network).
 */
export function buildPetBrief(ledger, options = {}) {
  if (!ledger || typeof ledger.listCommitments !== 'function') throw new TypeError('buildPetBrief requires a ledger')
  const nowMs = toMillis(options.now)
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : PET_BRIEF_TTL_MS
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : PET_BRIEF_MAX_ITEMS
  const minConfidence = Number.isFinite(options.minConfidence) ? options.minConfidence : PET_BRIEF_MIN_CONFIDENCE
  const displayPolicy = options.displayPolicy ?? PET_BRIEF_DEFAULT_DISPLAY_POLICY
  const hmacKey = options.hmacKey
  const dropped = { risks: 0, lines: 0 }
  if (!PET_BRIEF_DISPLAY_POLICIES.includes(displayPolicy)) {
    throw new TypeError(`displayPolicy must be one of ${PET_BRIEF_DISPLAY_POLICIES.join('|')}`)
  }
  const limit = Math.max(1, Math.min(PET_BRIEF_MAX_ITEMS, Math.trunc(maxItems)))
  const today = localDay(new Date(nowMs).toISOString())

  const allMatters = [
    ...(ledger.listMatters('active') ?? []),
    ...(ledger.listMatters('paused') ?? []),
    ...(ledger.listMatters('archived') ?? []),
  ]
  const matterById = new Map(allMatters.map((matter) => [matter.id, matter]))
  const activeMatters = allMatters.filter((matter) => isPublicMatter(matter))
  const publicMatterIds = new Set(activeMatters.map((matter) => matter.id))

  const allCommitments = ledger.listCommitments() ?? []
  const openCommitments = allCommitments.filter((commitment) => commitment.status === 'open')
  const rawNames = [
    ...allCommitments.map((commitment) => commitment.creditor),
    ...(ledger.listFacts() ?? []).map((fact) => fact.subject),
    ...allMatters.flatMap((matter) => matter.participants ?? []),
  ]
  const redactor = createRedactor(rawNames)
  const redacted = (value) => redactor.redact(value)

  // Public open commitments: matter must be active with secrecy < 2.
  const publicOpen = openCommitments.filter((commitment) => publicMatterIds.has(commitment.matterId))
  const dueMsOf = (commitment) => {
    if (!commitment.dueAt) return null
    const ms = Date.parse(commitment.dueAt)
    return Number.isFinite(ms) ? ms : null
  }

  // --- today: active public matters, urgency first, deterministic tie-break.
  const urgency = new Map()
  for (const commitment of publicOpen) {
    const ms = dueMsOf(commitment)
    if (ms === null) continue
    const day = localDay(new Date(ms).toISOString())
    if (day !== today && ms >= nowMs) continue
    urgency.set(commitment.matterId, (urgency.get(commitment.matterId) ?? 0) + 1)
  }
  const todayItems = [...activeMatters]
    .sort((a, b) => (urgency.get(b.id) ?? 0) - (urgency.get(a.id) ?? 0) || cmp(String(b.updatedAt ?? ''), String(a.updatedAt ?? '')) || cmp(a.id, b.id))
    .slice(0, limit)
    .map((matter) => ({
      id: clip(matter.id, 64),
      title: clip(redacted(matter.title), 80),
      status: urgency.has(matter.id) ? 'doing' : 'open',
    }))

  // --- commitments: open, due-dated, public; risk ordered then due date.
  const dueCommitments = publicOpen
    .map((commitment) => ({ commitment, dueMs: dueMsOf(commitment) }))
    .filter((row) => row.dueMs !== null)
    .map((row) => ({ ...row, risk: riskOfDue(row.dueMs, nowMs, today), confidence: confidenceOfCommitment(row.commitment) }))
    .sort((a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk] || a.dueMs - b.dueMs || cmp(a.commitment.id, b.commitment.id))
    .slice(0, limit)
  const commitmentItems = dueCommitments.map(({ commitment, dueMs, risk, confidence }) => ({
    id: clip(commitment.id, 64),
    matter: clip(commitment.matterId, 64),
    who: clip(redacted(commitment.creditor), 40),
    what: clip(redacted(commitment.action), 80),
    due: clip(localDay(new Date(dueMs).toISOString()) ?? clip(commitment.dueAt, 32), 32),
    risk,
    confidence,
  }))

  // --- risks: deterministic derivation from the same public commitments.
  const risks = []
  for (const { commitment, dueMs, risk } of dueCommitments) {
    const who = clip(redacted(commitment.creditor), 12)
    const what = clip(redacted(commitment.action), 24)
    if (risk === 'high') {
      const summary = dueMs < nowMs ? `${who}的${what}已逾期` : `${who}的${what}今天到期`
      risks.push({
        id: clip(`risk_${commitment.id}`, 64),
        level: 'high',
        summary: clip(summary, 80),
        evidence: clip(commitment.id, 64),
        confidence: dueMs < nowMs ? 0.95 : 0.9,
      })
    } else if (risk === 'medium') {
      risks.push({
        id: clip(`risk_${commitment.id}`, 64),
        level: 'medium',
        summary: clip(`${who}的${what}即将到期`, 80),
        evidence: clip(commitment.id, 64),
        confidence: 0.72,
      })
    }
  }
  for (const commitment of publicOpen.filter((row) => !row.dueAt && isPublicMatter(matterById.get(row.matterId)))) {
    const who = clip(redacted(commitment.creditor), 12)
    const what = clip(redacted(commitment.action), 24)
    risks.push({
      id: clip(`risk_${commitment.id}`, 64),
      level: 'medium',
      summary: clip(`${who}的${what}还没有截止时间`, 80),
      evidence: clip(commitment.id, 64),
      confidence: 0.75,
    })
  }
  const byDay = new Map()
  for (const { commitment, dueMs } of dueCommitments) {
    const day = localDay(new Date(dueMs).toISOString())
    if (!day || day < today) continue
    byDay.set(day, [...(byDay.get(day) ?? []), commitment])
  }
  for (const [day, list] of [...byDay.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    if (list.length < 2) continue
    risks.push({
      id: clip(`risk_cluster_${day.replaceAll('-', '')}`, 64),
      level: 'medium',
      summary: clip(`${day} 有 ${list.length} 个截止`, 80),
      evidence: clip(list[0].id, 64),
      confidence: 0.72,
    })
  }
  const riskItems = risks
    .filter((risk) => risk.confidence >= minConfidence)
    .filter((risk) => {
      if (!isBlockedLine(risk.summary, hmacKey)) return true
      dropped.risks += 1
      return false
    })
    .sort((a, b) => RISK_RANK[b.level] - RISK_RANK[a.level] || b.confidence - a.confidence || cmp(a.id, b.id))
    .slice(0, limit)

  // --- facts: confirmed ledger facts, confidence >= 0.7, public matters only.
  const factItems = (ledger.listFacts() ?? [])
    .filter((fact) => Number(fact.confidence) >= minConfidence)
    .filter((fact) => {
      if (!fact.matterId) return true
      return publicMatterIds.has(fact.matterId)
    })
    .sort((a, b) => Number(b.confidence) - Number(a.confidence) || cmp(a.id, b.id))
    .slice(0, limit)
    .map((fact) => ({
      id: clip(fact.id, 64),
      subject: clip(redacted(fact.subject), 40),
      predicate: clip(oneLine(fact.predicate), 40),
      value: clip(redacted(fact.object), 80),
      confidence: Number(fact.confidence),
    }))

  // --- mood: workload only, never affection.
  let mood = 'calm'
  if (riskItems.some((risk) => risk.level === 'high')) mood = 'concerned'
  else if (commitmentItems.length > 0 || riskItems.length > 0 || todayItems.some((item) => item.status === 'doing')) mood = 'focused'

  // --- suggested lines: <=3, <=40 chars, every line reuses a brief field.
  const lines = []
  const pushLine = (line) => {
    const text = clip(oneLine(line), PET_BRIEF_MAX_LINE_LENGTH)
    if (!text || lines.includes(text) || lines.length >= PET_BRIEF_MAX_SUGGESTED_LINES) return
    if (isBlockedLine(text, hmacKey)) {
      dropped.lines += 1
      return
    }
    lines.push(text)
  }
  const topRisk = riskItems[0]
  if (topRisk) pushLine(`${topRisk.summary}。`)
  const topCommitment = commitmentItems.find((item) => item.id !== topRisk?.evidence) ?? commitmentItems[0]
  if (topCommitment) {
    if (topCommitment.due < today) pushLine(`${topCommitment.who}的${topCommitment.what}已经逾期。`)
    else pushLine(`${topCommitment.who}的${topCommitment.what}，${topCommitment.due === today ? '今天' : topCommitment.due}到期。`)
  }
  const topFact = factItems[0]
  if (topFact) pushLine(`${topFact.subject}：${topFact.value}`)

  // --- redactions: human-readable log, never a secret.
  const redactions = []
  if (redactor.masked() > 0) redactions.push(clip(`联系人/客户名已脱敏为“某客户”（${redactor.masked()} 处）`, 80))
  redactions.push('不含文档正文、邮件正文、聊天记录')
  redactions.push('不含模型推理、系统提示或原始提示词')
  const excludedSecrecy = allMatters.filter((matter) => matterSecrecy(matter) >= 2).length
  if (excludedSecrecy > 0) redactions.push(clip(`已排除保密等级≥2 的事项（${excludedSecrecy} 个）`, 80))
  const droppedTotal = dropped.risks + dropped.lines
  if (droppedTotal > 0) redactions.push(clip(`已丢弃 ${droppedTotal} 条不安全内容（不展示原文）`, 80))
  if (!redactions.some((note) => note.startsWith('联系人')) && !redactions.some((note) => note.includes('客户名'))) {
    redactions.push('联系人/客户名默认不进入 brief')
  }

  const generatedAt = new Date(nowMs).toISOString()
  const expiresAt = new Date(nowMs + ttlMs).toISOString()
  return {
    schemaVersion: PET_BRIEF_SCHEMA_VERSION,
    generatedAt,
    expiresAt,
    source: PET_BRIEF_SOURCE,
    displayPolicy,
    counts: {
      today: todayItems.length,
      commitments: commitmentItems.length,
      risks: riskItems.length,
      facts: factItems.length,
    },
    today: todayItems,
    commitments: commitmentItems,
    risks: riskItems,
    facts: factItems,
    mood,
    suggestedLines: lines.slice(0, PET_BRIEF_MAX_SUGGESTED_LINES),
    redactions: redactions.slice(0, 10),
  }
}

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[_\-\s]/g, '')
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function issue(code, path, message) {
  return { code, path, message }
}

function checkForbiddenKeys(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => checkForbiddenKeys(entry, `${path}[${index}]`, errors))
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizedKey(key)
    if (PET_BRIEF_FORBIDDEN_KEYS.includes(normalized) || PET_BRIEF_FORBIDDEN_KEYS.some((forbidden) => normalized.endsWith(forbidden))) {
      errors.push(issue('E_FORBIDDEN_FIELD', `${path}.${key}`, `forbidden contract field: ${key}`))
    }
    checkForbiddenKeys(entry, `${path}.${key}`, errors)
  }
}

function checkUnknownKeys(value, allowed, path, errors) {
  if (!isPlainObject(value)) return
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(issue('E_UNKNOWN_FIELD', `${path}.${key}`, `field is not in contract v0.2: ${key}`))
  }
}

function checkString(value, { path, errors, min = 1, max = 80, field }) {
  if (typeof value !== 'string') {
    errors.push(issue('E_TYPE', path, `${field ?? 'value'} must be a string`))
    return false
  }
  const length = Array.from(value).length
  if (length < min || length > max) {
    errors.push(issue('E_LENGTH', path, `${field ?? 'value'} length ${length} outside ${min}..${max}`))
    return false
  }
  return true
}

function checkConfidence(value, path, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(issue('E_CONFIDENCE', path, 'confidence must be a number in 0..1'))
    return false
  }
  return true
}

/**
 * Validate a brief against contract v0.2 (schema + freshness + forbidden data).
 * Used by `advisers pet-brief --check` and by tests; the consumer re-validates.
 *
 * Backward compatibility: contract v0.1 briefs (`schemaVersion: 1`, no
 * `displayPolicy`) are accepted by default with a `W_LEGACY_SCHEMA_VERSION`
 * warning and a `W_MISSING_DISPLAY_POLICY` warning; missing `displayPolicy`
 * always means the safe default `private` and never fails the check unless the
 * caller opts into `requireDisplayPolicy`. Unknown versions still fail closed.
 *
 * @param {unknown|string} value parsed brief, or raw JSON text
 * @param {object} [options]
 * @param {number|string|Date} [options.now]
 * @param {boolean} [options.allowExpired] skip the freshness gate (schema check only)
 * @param {boolean} [options.acceptLegacy=true] accept v0.1 briefs with warnings; false fails closed
 * @param {boolean} [options.requireDisplayPolicy=false] make a missing displayPolicy an error
 * @returns {{ok: boolean, errors: Array<{code: string, path: string, message: string}>, warnings: Array<{code: string, path: string, message: string}>, brief?: object}}
 */
export function validatePetBrief(value, options = {}) {
  const errors = []
  const warnings = []
  let brief = value
  if (typeof value === 'string') {
    try {
      brief = JSON.parse(value)
    } catch (error) {
      return { ok: false, errors: [issue('E_MALFORMED_JSON', '$', `invalid JSON: ${error.message}`)], warnings: [], brief: undefined }
    }
  }
  if (!isPlainObject(brief)) {
    return { ok: false, errors: [issue('E_TYPE', '$', 'brief must be a JSON object')], warnings: [], brief: undefined }
  }

  checkForbiddenKeys(brief, '$', errors)
  checkUnknownKeys(brief, ROOT_KEYS, '$', errors)

  if (brief.schemaVersion === PET_BRIEF_LEGACY_SCHEMA_VERSION) {
    if (options.acceptLegacy === false) {
      errors.push(issue('E_SCHEMA_VERSION', '$.schemaVersion', 'schemaVersion 1 is legacy (contract v0.1) and acceptance is disabled'))
    } else {
      warnings.push(issue('W_LEGACY_SCHEMA_VERSION', '$.schemaVersion', 'brief uses legacy schemaVersion 1 (contract v0.1); accepted, missing displayPolicy means "private"'))
    }
  } else if (brief.schemaVersion !== PET_BRIEF_SCHEMA_VERSION) {
    errors.push(issue('E_SCHEMA_VERSION', '$.schemaVersion', `unsupported schemaVersion (expected 2, legacy 1 allowed with warnings)`))
  }
  if (brief.displayPolicy === undefined) {
    const message = 'displayPolicy is missing; consumers must treat it as "private" (legacy v0.1 brief)'
    if (options.requireDisplayPolicy === true) errors.push(issue('E_DISPLAY_POLICY', '$.displayPolicy', message))
    else warnings.push(issue('W_MISSING_DISPLAY_POLICY', '$.displayPolicy', message))
  } else if (!PET_BRIEF_DISPLAY_POLICIES.includes(brief.displayPolicy)) {
    errors.push(issue('E_ENUM', '$.displayPolicy', 'displayPolicy must be public|private|none'))
  }
  if (brief.source !== PET_BRIEF_SOURCE) errors.push(issue('E_SOURCE', '$.source', 'source must be "advisers"'))

  const generatedMs = parseIsoWithZone(brief.generatedAt, '$.generatedAt', errors)
  const expiresMs = parseIsoWithZone(brief.expiresAt, '$.expiresAt', errors)
  if (generatedMs !== null && expiresMs !== null) {
    if (expiresMs <= generatedMs) errors.push(issue('E_TIME_ORDER', '$.expiresAt', 'expiresAt must be after generatedAt'))
    else if (!options.allowExpired && toMillis(options.now) >= expiresMs) errors.push(issue('E_EXPIRED', '$.expiresAt', 'brief is expired'))
  }

  const arrays = ['today', 'commitments', 'risks', 'facts']
  for (const name of arrays) {
    if (!Array.isArray(brief[name])) continue
    if (brief[name].length > PET_BRIEF_MAX_ITEMS) errors.push(issue('E_MAX_ITEMS', `$.${name}`, `${name} exceeds ${PET_BRIEF_MAX_ITEMS} items`))
    const seen = new Set()
    brief[name].forEach((item, index) => {
      const path = `$.${name}[${index}]`
      if (!isPlainObject(item)) {
        errors.push(issue('E_TYPE', path, 'item must be an object'))
        return
      }
      checkUnknownKeys(item, ITEM_KEYS[name], path, errors)
      if (typeof item.id !== 'string' || !item.id) errors.push(issue('E_ID', `${path}.id`, 'id is required'))
      else {
        checkString(item.id, { path: `${path}.id`, errors, max: 64, field: 'id' })
        if (seen.has(item.id)) errors.push(issue('E_DUP_ID', `${path}.id`, `duplicate id within ${name}: ${item.id}`))
        seen.add(item.id)
      }
    })
  }

  if (!Array.isArray(brief.today)) errors.push(issue('E_TYPE', '$.today', 'today must be an array'))
  else brief.today.forEach((item, index) => {
    if (!isPlainObject(item)) return
    checkString(item.title, { path: `$.today[${index}].title`, errors, max: 80, field: 'title' })
    if (!TODAY_STATUS.includes(item.status)) errors.push(issue('E_ENUM', `$.today[${index}].status`, 'status must be open|doing|done'))
  })

  if (!Array.isArray(brief.commitments)) errors.push(issue('E_TYPE', '$.commitments', 'commitments must be an array'))
  else brief.commitments.forEach((item, index) => {
    if (!isPlainObject(item)) return
    const path = `$.commitments[${index}]`
    checkString(item.matter, { path: `${path}.matter`, errors, max: 64, field: 'matter' })
    checkString(item.who, { path: `${path}.who`, errors, max: 40, field: 'who' })
    checkString(item.what, { path: `${path}.what`, errors, max: 80, field: 'what' })
    checkString(item.due, { path: `${path}.due`, errors, max: 32, field: 'due' })
    if (!RISK_LEVEL.includes(item.risk)) errors.push(issue('E_ENUM', `${path}.risk`, 'risk must be low|medium|high'))
    checkConfidence(item.confidence, `${path}.confidence`, errors)
  })

  if (!Array.isArray(brief.risks)) errors.push(issue('E_TYPE', '$.risks', 'risks must be an array'))
  else brief.risks.forEach((item, index) => {
    if (!isPlainObject(item)) return
    const path = `$.risks[${index}]`
    if (!RISK_LEVEL.includes(item.level)) errors.push(issue('E_ENUM', `${path}.level`, 'level must be low|medium|high'))
    checkString(item.summary, { path: `${path}.summary`, errors, max: 80, field: 'summary' })
    checkString(item.evidence, { path: `${path}.evidence`, errors, max: 64, field: 'evidence' })
    checkConfidence(item.confidence, `${path}.confidence`, errors)
  })

  if (!Array.isArray(brief.facts)) errors.push(issue('E_TYPE', '$.facts', 'facts must be an array'))
  else brief.facts.forEach((item, index) => {
    if (!isPlainObject(item)) return
    const path = `$.facts[${index}]`
    checkString(item.subject, { path: `${path}.subject`, errors, max: 40, field: 'subject' })
    checkString(item.predicate, { path: `${path}.predicate`, errors, max: 40, field: 'predicate' })
    checkString(item.value, { path: `${path}.value`, errors, max: 80, field: 'value' })
    checkConfidence(item.confidence, `${path}.confidence`, errors)
  })

  if (!isPlainObject(brief.counts)) {
    errors.push(issue('E_TYPE', '$.counts', 'counts must be an object'))
  } else {
    checkUnknownKeys(brief.counts, arrays, '$.counts', errors)
    for (const name of arrays) {
      if (!Number.isInteger(brief.counts[name]) || brief.counts[name] < 0 || brief.counts[name] > PET_BRIEF_MAX_ITEMS) {
        errors.push(issue('E_COUNTS', `$.counts.${name}`, `${name} count must be an integer in 0..${PET_BRIEF_MAX_ITEMS}`))
      } else if (Array.isArray(brief[name]) && brief.counts[name] !== brief[name].length) {
        errors.push(issue('E_COUNTS', `$.counts.${name}`, `${name} count does not match array length`))
      }
    }
  }

  if (!PET_BRIEF_MOODS.includes(brief.mood)) errors.push(issue('E_ENUM', '$.mood', 'mood must be calm|focused|concerned|pleased'))

  if (!Array.isArray(brief.suggestedLines)) errors.push(issue('E_TYPE', '$.suggestedLines', 'suggestedLines must be an array'))
  else {
    if (brief.suggestedLines.length > PET_BRIEF_MAX_SUGGESTED_LINES) errors.push(issue('E_MAX_LINES', '$.suggestedLines', `suggestedLines exceeds ${PET_BRIEF_MAX_SUGGESTED_LINES}`))
    brief.suggestedLines.forEach((line, index) => {
      checkString(line, { path: `$.suggestedLines[${index}]`, errors, max: PET_BRIEF_MAX_LINE_LENGTH, field: 'suggested line' })
    })
  }

  if (!Array.isArray(brief.redactions)) errors.push(issue('E_TYPE', '$.redactions', 'redactions must be an array'))
  else {
    if (brief.redactions.length > 10) errors.push(issue('E_MAX_ITEMS', '$.redactions', 'redactions exceeds 10'))
    brief.redactions.forEach((note, index) => {
      checkString(note, { path: `$.redactions[${index}]`, errors, max: 80, field: 'redaction note' })
    })
  }

  return { ok: errors.length === 0, errors, warnings, brief }
}

function parseIsoWithZone(value, path, errors) {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) {
    errors.push(issue('E_TIME_FORMAT', path, 'timestamp must be ISO 8601 with a timezone'))
    return null
  }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    errors.push(issue('E_TIME_FORMAT', path, 'timestamp is not a valid instant'))
    return null
  }
  return ms
}

/**
 * Atomically write a brief.
 *
 * 0.2.3 Wave 1: delegates to lib/fs-safe.js so the write uses the short-write
 * loop, fsync, size verification and an atomic same-directory rename. A short
 * write/ENOSPC can no longer install a truncated brief (robustness audit P1-2),
 * and a failed write removes its temp file instead of leaving it behind.
 *
 * @param {string} filePath destination path
 * @param {object} brief brief object
 * @returns {string} the written path
 */
export function writePetBriefAtomic(filePath, brief) {
  const target = String(filePath)
  atomicWriteFileSync(target, `${JSON.stringify(brief, null, 2)}\n`, { mode: 0o600 })
  return target
}
