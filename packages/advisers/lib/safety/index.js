/**
 * Content-safety module entry point.
 *
 * Pure ESM, offline, zero third-party dependencies:
 *   rules.js     14-category matrix + narrow block allowlist + JSON overrides
 *   classifier.js  normalize -> match -> surface/context policy -> decision
 *   redact.js     PII / secret detection + one-way redaction
 *   explain.js    user-facing "advisers safety explain" copy
 *
 * Honest scope: this is an ASSISTIVE local rule layer. It reduces risk but is
 * not a compliance certification, not an official review, and does not perform
 * algorithm filing / model registration. See docs/CONTENT-SAFETY.md.
 *
 * Auditing: the caller passes the HMAC key and writes the returned structured
 * fields to its own appendAudit(); this module never stores text and never
 * writes audit rows itself.
 */

export * from './rules.js'
export * from './classifier.js'
export * from './redact.js'
export * from './explain.js'

import { RULESET_VERSION, actionRank } from './rules.js'
import { classify } from './classifier.js'

export const SAFETY_API_VERSION = 'advisers-safety-api-1'

// ---------------------------------------------------------------------------
// audit reason helpers (hash-chain compatible: one string field, no schema change)
// ---------------------------------------------------------------------------

export const AUDIT_REASON_MAX = 300

function reasonPart(value, fallback) {
  if (value == null) return fallback || '-'
  const text = String(value).replace(/[|\r\n\t\u0000-\u001f]/g, ' ').trim()
  return text ? text.slice(0, 40) : (fallback || '-')
}

function normalizeRuleIds(ruleIds) {
  if (!Array.isArray(ruleIds)) return []
  const out = []
  for (const raw of ruleIds) {
    if (raw == null) continue
    const id = reasonPart(raw).replace(/[^A-Za-z0-9-]/g, '').slice(0, 24)
    if (id && !out.includes(id)) out.push(id)
    if (out.length >= 8) break
  }
  return out
}

function normalizeEvidenceHash(hash) {
  if (hash == null) return '-'
  const text = String(hash)
  return /^[0-9a-f]{8,64}$/i.test(text) ? text.slice(0, 16) : '-'
}

/**
 * Build the audit `reason` string. Format (single line, <=300 chars):
 *   rulesetVersion|surface|action|code|ruleIds|evidenceHash
 * Example: advisers-content-1|chat.output|block|CSAM|R-SEX-CSAM-01|9f2c1ab7e3d4c5b6
 */
export function buildAuditReason(fields = {}) {
  const version = reasonPart(fields.rulesetVersion == null ? RULESET_VERSION : fields.rulesetVersion, 'unknown')
  const surface = reasonPart(fields.surface, 'unknown')
  const action = reasonPart(fields.action, 'allow')
  const code = reasonPart(fields.code, 'NONE')
  const ids = normalizeRuleIds(fields.ruleIds)
  const evidenceHash = normalizeEvidenceHash(fields.evidenceHash)
  const reason = [version, surface, action, code, ids.length ? ids.join(',') : '-', evidenceHash].join('|')
  return reason.slice(0, AUDIT_REASON_MAX)
}

/** Parse an audit reason back into structured fields (for explain/report). */
export function parseAuditReason(reason) {
  if (typeof reason !== 'string') return null
  const parts = reason.slice(0, AUDIT_REASON_MAX).split('|')
  if (parts.length < 6) return null
  const ruleIds = parts[4] === '-' ? [] : parts[4].split(',').filter(Boolean)
  return {
    rulesetVersion: parts[0],
    surface: parts[1],
    action: parts[2],
    code: parts[3],
    ruleIds,
    evidenceHash: parts[5] === '-' ? null : parts[5],
  }
}

/** Build the audit reason for a classify() result. */
export function auditReasonForResult(result = {}, options = {}) {
  return buildAuditReason({
    rulesetVersion: result.rulesetVersion,
    surface: result.surface || options.surface,
    action: result.action,
    code: result.code,
    ruleIds: result.ruleIds,
    evidenceHash: result.evidenceHash,
  })
}

// ---------------------------------------------------------------------------
// typed error (no original text, no upstream text)
// ---------------------------------------------------------------------------

export class ContentSafetyError extends Error {
  constructor(result = {}, options = {}) {
    super('内容安全审核未通过（CONTENT_SAFETY_BLOCKED）')
    this.name = 'ContentSafetyError'
    this.code = result.code || options.code || 'CONTENT_SAFETY_BLOCKED'
    this.action = result.action || 'block'
    this.provider = options.provider || 'local'
    this.surface = result.surface || options.surface || 'unknown'
    this.categories = Array.isArray(result.categories) ? result.categories : []
    this.ruleIds = Array.isArray(result.ruleIds) ? result.ruleIds : []
    this.crisis = Boolean(result.crisis)
    this.evidenceHash = result.evidenceHash || null
    this.rulesetVersion = result.rulesetVersion || options.rulesetVersion || RULESET_VERSION
    this.auditReason = options.auditReason || auditReasonForResult(result, options)
    this.retryable = false
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      action: this.action,
      provider: this.provider,
      surface: this.surface,
      categories: this.categories,
      ruleIds: this.ruleIds,
      crisis: this.crisis,
      evidenceHash: this.evidenceHash,
      rulesetVersion: this.rulesetVersion,
      auditReason: this.auditReason,
      retryable: this.retryable,
    }
  }
}

/** Convenience constructor; only block/confirm results should be thrown. */
export function safetyErrorFrom(result = {}, options = {}) {
  return new ContentSafetyError(result, options)
}

// ---------------------------------------------------------------------------
// provider refusal shapes (DeepSeek docs: Messages / Responses / Chat + 400)
// ---------------------------------------------------------------------------

const PROVIDER_MESSAGES = Object.freeze({
  CONTENT_RISK_400: '模型服务商以内容风险为由拒绝了本次请求。',
  PROVIDER_REFUSAL: '模型服务商以拒答结束了本次请求。',
  CONTENT_FILTER: '模型服务商的内容过滤拦截了本次请求。',
  IMAGE_BLOCKED: '模型服务商拦截了请求中的图片。',
  NONE: null,
})

function jsonOf(payload) {
  try {
    return JSON.stringify(payload == null ? {} : payload)
  } catch {
    return ''
  }
}

function pickSafetyTokens(payload) {
  const candidates = [
    payload && payload.usage && payload.usage.output_tokens_details && payload.usage.output_tokens_details.safety_tokens,
    payload && payload.usage && payload.usage.completion_tokens_details && payload.usage.completion_tokens_details.safety_tokens,
    payload && payload.usage && payload.usage.input_tokens_details && payload.usage.input_tokens_details.safety_tokens,
    payload && payload.usage && payload.usage.safety_tokens,
    payload && payload.safety_tokens,
    payload && payload.safetyTokens,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate
  }
  return 0
}

function detectProtocol(payload, status) {
  if (status >= 400 || (payload && payload.error)) return 'http'
  if (payload && (payload.stop_reason != null || payload.stop_details != null)) return 'messages'
  if (payload && (payload.status != null || payload.incomplete_details != null)) return 'responses'
  if (payload && Array.isArray(payload.choices)) return 'chat'
  return 'unknown'
}

function imagePaths(json) {
  const out = []
  const matches = json.match(/messages\.\d+\.content\.\d+/g) || []
  for (const match of matches) if (!out.includes(match)) out.push(match)
  return out
}

/**
 * Map a provider response/payload to a unified refusal shape WITHOUT copying
 * upstream text. Returns:
 *   { blocked, provider, protocol, code, message, retryable, safetyTokens, imagesBlocked }
 * Never includes the upstream explanation/refusal text (only stable codes).
 */
export function normalizeProviderRefusal(payload, options = {}) {
  const status = Number.isInteger(options.status) ? options.status : 0
  const json = jsonOf(payload)
  const lower = json.toLowerCase()
  const safetyTokens = pickSafetyTokens(payload)
  const protocol = detectProtocol(payload, status)
  const images = imagePaths(json)

  let code = 'NONE'
  if (images.length || lower.includes('blocked by content moderation')) {
    code = 'IMAGE_BLOCKED'
  } else if (payload && (payload.stop_reason === 'refusal' || (payload.stop_details && payload.stop_details.type === 'refusal'))) {
    code = 'PROVIDER_REFUSAL'
  } else if (payload && payload.status === 'incomplete' && payload.incomplete_details && payload.incomplete_details.reason === 'content_filter') {
    code = 'CONTENT_FILTER'
  } else if (payload && Array.isArray(payload.choices) && payload.choices.some((choice) => (
    (choice && choice.finish_reason === 'content_filter')
    || (choice && choice.message && typeof choice.message.refusal === 'string' && choice.message.refusal.length > 0)
  ))) {
    code = 'CONTENT_FILTER'
  } else if (status >= 400 || lower.includes('content exists risk') || lower.includes('content_exists_risk')) {
    if (lower.includes('content exists risk') || lower.includes('content_exists_risk') || lower.includes('content risk')) {
      code = 'CONTENT_RISK_400'
    }
  }

  const blocked = code !== 'NONE'
  return {
    blocked,
    provider: 'deepseek',
    protocol,
    code,
    message: PROVIDER_MESSAGES[code],
    retryable: false,
    safetyTokens,
    imagesBlocked: images,
  }
}

// ---------------------------------------------------------------------------
// message-level convenience
// ---------------------------------------------------------------------------

function textPartsOf(message) {
  const texts = []
  if (!message || typeof message !== 'object') {
    if (typeof message === 'string') texts.push(message)
    return texts
  }
  const content = message.content
  if (typeof content === 'string') texts.push(content)
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && typeof part.text === 'string' && (part.type == null || part.type === 'text' || part.type === 'input_text' || part.type === 'output_text')) {
        texts.push(part.text)
      }
    }
  }
  if (typeof message.refusal === 'string') texts.push(message.refusal)
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const args = call && call.function && call.function.arguments
      if (typeof args === 'string') texts.push(args)
    }
  }
  return texts
}

/**
 * Classify every user/assistant text in an OpenAI-style messages array and
 * aggregate the worst action. Output messages use chat.output policy.
 */
export function inspectMessages(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : []
  const results = []
  let worst = null
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index]
    const role = message && typeof message === 'object' && message.role ? message.role : 'unknown'
    const surface = options.surface || (role === 'assistant' ? 'chat.output' : 'chat.input')
    for (const text of textPartsOf(message)) {
      const result = classify(text, { ...options, surface })
      results.push({
        index,
        role,
        surface,
        action: result.action,
        code: result.code,
        categories: result.categories,
        ruleIds: result.ruleIds,
        crisis: result.crisis,
        evidenceHash: result.evidenceHash,
      })
      if (!worst || actionRank(result.action) > actionRank(worst.action)) worst = result
    }
  }
  if (!worst) {
    const result = classify('', { ...options, surface: options.surface || 'chat.input' })
    return {
      action: 'allow',
      code: 'NONE',
      categories: [],
      ruleIds: [],
      crisis: false,
      confidence: 0,
      evidenceHash: null,
      surface: result.surface,
      rulesetVersion: result.rulesetVersion,
      rulesetDigest: result.rulesetDigest,
      results: [],
    }
  }
  return {
    action: worst.action,
    code: worst.code,
    categories: worst.categories,
    ruleIds: worst.ruleIds,
    crisis: results.some((item) => item.crisis),
    confidence: worst.confidence,
    evidenceHash: worst.evidenceHash,
    surface: worst.surface,
    rulesetVersion: worst.rulesetVersion,
    rulesetDigest: worst.rulesetDigest,
    results,
  }
}

/** Alias kept for callers that read the design doc naming. */
export function inspectText(text, options = {}) {
  return classify(text, options)
}
