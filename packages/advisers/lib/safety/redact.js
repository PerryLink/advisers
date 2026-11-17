/**
 * PII / secret detection and redaction (local, offline, zero-dependency).
 *
 * Single-value personal data is never a block reason: it is REDACTED so logs,
 * audit rows, Pet Brief inputs and model-adjacent copies do not carry it.
 * Only bulk exfiltration rules (in rules.js) may block.
 *
 * Rules are the `detector: 'pii'` entries of the ruleset, so a JSON ruleset
 * override can tune them like any other rule. Redaction is one-way here: the
 * original value is never returned in the result object.
 */

import { DEFAULT_RULESET, PII_KINDS, resolveRuleset } from './rules.js'

/** Full-width ASCII -> half-width, same length (so offsets stay valid). */
function toAsciiView(text) {
  return text.replace(/[\uFF01-\uFF5E\u3000]/g, (char) => (
    char === '\u3000' ? ' ' : String.fromCharCode(char.charCodeAt(0) - 0xFEE0)
  ))
}

function digitsOf(value) {
  return value.replace(/[^0-9Xx]/g, '').toUpperCase()
}

function isLuhn(number) {
  const digits = number.replace(/\D/g, '')
  if (digits.length < 12) return false
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index])
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }
  return sum % 10 === 0
}

function isValidIdCard(value) {
  const id = digitsOf(value)
  if (id.length !== 18) return false
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const checks = '10X98765432'
  let sum = 0
  for (let index = 0; index < 17; index += 1) sum += Number(id[index]) * weights[index]
  return checks[sum % 11] === id[17]
}

function labelNear(prepared, start, labels) {
  const window = prepared.slice(Math.max(0, start - 16), start)
  return labels.test(window)
}

const ID_LABELS = /(身份证|证件号|证件号码|公民身份号码)/
const BANK_LABELS = /(银行卡|卡号|信用卡|储蓄卡|借记卡|账户|账号)/
const BANK_BIN = /^(4|5|62|34|37|6011|65)/

function validatorAccept(validator, prepared, start, end) {
  const raw = prepared.slice(start, end)
  if (validator === 'idcard') {
    return isValidIdCard(raw) || labelNear(prepared, start, ID_LABELS)
  }
  if (validator === 'bankcard') {
    const digits = raw.replace(/\D/g, '')
    if (!isLuhn(digits)) return false
    return labelNear(prepared, start, BANK_LABELS) || BANK_BIN.test(digits)
  }
  return true
}

function addDetectionFlags(pattern) {
  const flags = new Set((pattern.flags || '').split(''))
  flags.add('g')
  flags.add('d')
  return new RegExp(pattern.source, [...flags].join(''))
}

function piiRulesOf(ruleset) {
  return ruleset.rules.filter((rule) => rule.detector === 'pii')
}

/**
 * Internal detector: returns hits WITH the matched raw value so the classifier
 * can key an HMAC evidence hash. Never export this object to users/UI/logs.
 */
export function detectPiiInternal(input, options = {}) {
  const source = String(input == null ? '' : input)
  if (!source) return []
  let ruleset = DEFAULT_RULESET
  if (options.ruleset) {
    try {
      ruleset = options.ruleset.__compiled ? options.ruleset : resolveRuleset(options.ruleset)
    } catch {
      ruleset = DEFAULT_RULESET
    }
  }
  const prepared = toAsciiView(source)
  const hits = []
  for (const rule of piiRulesOf(ruleset)) {
    for (const pattern of rule.patterns) {
      let regex
      try {
        regex = addDetectionFlags(pattern)
      } catch {
        continue
      }
      let match
      while ((match = regex.exec(prepared)) !== null) {
        if (match[0].length === 0) {
          regex.lastIndex += 1
          continue
        }
        let start = match.index
        let end = match.index + match[0].length
        if (rule.group != null && match.indices && match.indices[rule.group]) {
          start = match.indices[rule.group][0]
          end = match.indices[rule.group][1]
        }
        if (start == null || end == null || end <= start) continue
        if (!validatorAccept(rule.validator, prepared, start, end)) continue
        hits.push({
          ruleId: rule.id,
          kind: rule.piiKind || 'PII',
          start,
          end,
          raw: source.slice(start, end),
          confidence: rule.confidence,
          severity: rule.severity,
        })
      }
    }
  }
  return resolveOverlaps(hits)
}

function resolveOverlaps(hits) {
  const sorted = [...hits].sort((a, b) => (a.start - b.start) || (b.end - a.end))
  const kept = []
  let lastEnd = -1
  for (const hit of sorted) {
    if (hit.start < lastEnd) continue
    kept.push(hit)
    lastEnd = hit.end
  }
  return kept
}

/**
 * Public detector: same as detectPiiInternal but strips the raw value. Safe to
 * print or store; only rule ids, kinds and offsets remain.
 */
export function detectPii(input, options = {}) {
  return detectPiiInternal(input, options).map((hit) => ({
    ruleId: hit.ruleId,
    kind: hit.kind,
    start: hit.start,
    end: hit.end,
    confidence: hit.confidence,
    severity: hit.severity,
  }))
}

/**
 * Redact PII / secrets in place. Idempotent: redacting redacted text is a no-op.
 * Returns { text, redacted, count, kinds, categories, hits } and never returns
 * the original values. `kinds` filters by PII kind (e.g. ['PHONE']).
 */
export function redact(input, options = {}) {
  const source = String(input == null ? '' : input)
  let hits = detectPiiInternal(source, options)
  const only = options.kinds == null
    ? null
    : new Set(Array.isArray(options.kinds) ? options.kinds : [options.kinds])
  if (only) hits = hits.filter((hit) => only.has(hit.kind))
  if (!hits.length) {
    return { text: source, redacted: false, count: 0, kinds: [], categories: [], hits: [] }
  }
  const baseToken = options.token || 'REDACTED'
  let out = ''
  let cursor = 0
  const publicHits = []
  for (const hit of hits) {
    const replacement = '[' + baseToken + ':' + hit.kind + ']'
    out += source.slice(cursor, hit.start) + replacement
    cursor = hit.end
    publicHits.push({
      ruleId: hit.ruleId,
      kind: hit.kind,
      start: hit.start,
      end: hit.end,
      replacement,
    })
  }
  out += source.slice(cursor)
  return {
    text: out,
    redacted: true,
    count: publicHits.length,
    kinds: [...new Set(publicHits.map((hit) => hit.kind))],
    categories: ['pii'],
    hits: publicHits,
  }
}

/** Human-readable label for a PII kind (safe to print, no values). */
export function piiKindLabel(kind) {
  return PII_KINDS[kind] || PII_KINDS.SECRET
}
