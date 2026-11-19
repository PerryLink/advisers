/**
 * JSON purity helpers for --json / --out consumers (0.3.0 output kernel).
 *
 * The CLI JSON contract says: stdout is exactly one JSON document, no human prose, no
 * ANSI, diagnostics on stderr. These helpers make that checkable in unit tests and in
 * CI without parsing human text:
 *
 *   stringifyJson(value)  deterministic serialisation; optional display sanitisation
 *   isJsonPure(text)      parseable JSON + no raw C0/C1/DEL bytes
 *   assertJsonPure(text)  throws JsonPurityError with the offending offset
 *
 * Purity is about the emitted byte stream, not about rewriting data. Data fidelity is
 * the JSON contract's default (see docs/CLI-JSON.md); jsonSafe() from sanitize.js is
 * opt-in for human-facing fields (message/hint/subject).
 */
import { jsonSafe } from './sanitize.js'

/** Error code reported by assertJsonPure(). */
export const JSON_PURITY_CODE = 'E_JSON_IMPURE'

/**
 * Error thrown when a --json stream is not pure JSON.
 */
export class JsonPurityError extends Error {
  /**
   * @param {string} message
   * @param {{ offset?: number, reason?: string }} [details]
   */
  constructor(message, { offset = -1, reason = 'unknown' } = {}) {
    super(message)
    this.name = 'JsonPurityError'
    this.code = JSON_PURITY_CODE
    this.offset = offset
    this.reason = reason
  }
}

/**
 * Serialise a value as JSON.
 *
 * @param {unknown} value
 * @param {{ sanitize?: boolean, space?: number }} [options] `sanitize: true` runs
 *   jsonSafe() on strings/keys first (display fields only; not the data default).
 * @returns {string}
 */
export function stringifyJson(value, { sanitize = false, space = 0 } = {}) {
  const prepared = sanitize ? jsonSafe(value) : value
  const text = JSON.stringify(prepared, null, space)
  if (typeof text !== 'string') throw new TypeError('stringifyJson: value is not JSON-serialisable')
  return text
}

/**
 * Locate the first reason a text is not a pure JSON stream.
 *
 * @param {unknown} text
 * @returns {{ reason: 'not-json' | 'empty' | 'control-char' | 'c1-control', offset: number } | null}
 */
export function findJsonImpurity(text) {
  if (typeof text !== 'string') return { reason: 'not-json', offset: -1 }
  const trimmed = text.trim()
  if (trimmed === '') return { reason: 'empty', offset: -1 }
  try {
    JSON.parse(trimmed)
  } catch {
    return { reason: 'not-json', offset: -1 }
  }
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index)
    const isForbidden = code <= 0x08 || (code >= 0x0b && code <= 0x0c) || (code >= 0x0e && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)
    if (!isForbidden) continue
    return { reason: code >= 0x7f ? 'c1-control' : 'control-char', offset: index }
  }
  return null
}

/**
 * True when text is exactly one JSON document with no raw control bytes that could
 * forge terminal state (ANSI/C1). Human prose mixed into the stream fails this check.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isJsonPure(text) {
  return findJsonImpurity(text) === null
}

/**
 * Assert a --json stream is pure; throws JsonPurityError otherwise.
 *
 * @param {unknown} text
 * @param {{ label?: string }} [options] label names the stream in the error message
 * @returns {string} the input text (for fluent use)
 */
export function assertJsonPure(text, { label = 'stdout' } = {}) {
  if (typeof text !== 'string') throw new JsonPurityError(`${label}: expected a JSON string, got ${typeof text}`, { reason: 'not-json' })
  const impurity = findJsonImpurity(text)
  if (impurity === null) return text
  if (impurity.reason === 'empty') throw new JsonPurityError(`${label}: expected one JSON document, got an empty stream`, { reason: 'empty' })
  if (impurity.reason === 'not-json') {
    const preview = text.trim().slice(0, 80).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
    throw new JsonPurityError(`${label}: stream is not one JSON document (human text or a second document leaked in): ${preview}`, { reason: 'not-json' })
  }
  const codePoint = text.trim().charCodeAt(impurity.offset)
  const hex = codePoint.toString(16).toUpperCase().padStart(2, '0')
  throw new JsonPurityError(`${label}: raw control character U+${hex} at offset ${impurity.offset} would corrupt a terminal; JSON output must not contain ANSI/C0/C1 bytes`, { offset: impurity.offset, reason: impurity.reason })
}

/**
 * Build a stderr error envelope object for a failed --json command.
 *
 * Rendering is the caller's job (stdout stays empty); this helper keeps the envelope
 * shape consistent without owning the error-code registry.
 *
 * @param {{ code: string, message: string, hint?: string, details?: unknown }} error
 * @returns {{ error: { code: string, message: string, hint?: string, details?: unknown } }}
 */
export function errorEnvelope({ code, message, hint, details } = {}) {
  const envelope = { error: { code: String(code ?? 'E_UNKNOWN'), message: String(message ?? '') } }
  if (hint !== undefined) envelope.error.hint = String(hint)
  if (details !== undefined) envelope.error.details = jsonSafe(details)
  return envelope
}

