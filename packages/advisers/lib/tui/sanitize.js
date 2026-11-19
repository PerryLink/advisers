/**
 * Display sanitisation policy for terminal output (0.3.0 output kernel).
 *
 * Two distinct jobs, deliberately kept apart:
 *
 *   sanitizeDisplay()  terminal rendering policy: keep line structure and tabs (so
 *                      result blocks can be laid out), strip everything that can
 *                      forge terminal state. Used by every render* function.
 *   jsonSafe()         display safety for JSON string fields (message/hint/subject
 *                      and other strings that a human or terminal may echo). It keeps
 *                      newlines (JSON.stringify escapes them) but strips ESC/C1 and
 *                      bidi/zero-width marks.
 *
 * Data contract: sanitisation happens at the rendering/emission boundary; it never
 * rewrites database rows or the semantics of a --json field. docs/TUI.md records the
 * boundary, and tests assert both the sanitised view and the untouched data.
 */
import { stripBom, stripTerminalSequences } from '../text-safe.js'
import { expandTabs, truncateToWidth } from './width.js'

const C0_NO_LINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const C1_ALL = /[\u0080-\u009F]/g
// Bidi overrides/isolates plus U+FEFF can reorder or hide rendered text. Unlike the
// console/log layer, display sanitisation keeps ZWJ/ZWNJ/ZWSP: they are part of
// legitimate text (emoji ZWJ families, Indic/emoji clusters) and have zero width.
const BIDI_DISPLAY = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g
const UNSAFE_DISPLAY = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/

/**
 * Sanitise text for terminal display.
 *
 * Pipeline: CRLF/CR -> LF; strip escape sequences (CSI/OSC/DCS/SOS/PM/APC); strip
 * bidi/zero-width marks; drop remaining C0 (except \n and \t) and all C1. Normal
 * Chinese punctuation, emoji and combining sequences are preserved.
 *
 * @param {unknown} value
 * @param {{
 *   singleLine?: boolean,      // fold newlines/tabs to spaces (one-line fields)
 *   maxWidth?: number,         // truncate each line to N display columns
 *   maxChars?: number,         // compatibility alias for maxWidth
 *   expandTabs?: boolean,      // replace tabs with spaces (use before rendering)
 *   tabSize?: number,
 *   ellipsis?: string
 * }} [options]
 * @returns {string}
 */
export function sanitizeDisplay(value, { singleLine = false, maxWidth, maxChars, expandTabs: shouldExpandTabs = false, tabSize = 4, ellipsis = '\u2026' } = {}) {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'string' ? value : String(value)
  text = stripBom(text)
  text = text.replace(/\r\n?/g, '\n')
  text = stripTerminalSequences(text)
  text = text.replace(BIDI_DISPLAY, '')
  text = text.replace(C0_NO_LINE, '')
  text = text.replace(C1_ALL, '')
  if (shouldExpandTabs) text = expandTabs(text, tabSize)
  const limit = maxWidth === undefined ? maxChars : maxWidth
  const hasLimit = typeof limit === 'number' && Number.isFinite(limit)
  const widthLimit = hasLimit ? Math.max(0, Math.floor(limit)) : 0
  if (singleLine) {
    text = text.replace(/\t/g, ' ').replace(/\n+/g, ' ').replace(/ {2,}/g, ' ').trim()
    return hasLimit ? truncateToWidth(text, widthLimit, { ellipsis }) : text
  }
  if (!hasLimit) return text
  return text
    .split('\n')
    .map((line) => truncateToWidth(line, widthLimit, { ellipsis }))
    .join('\n')
}

/**
 * True when the string still contains characters that can forge terminal state
 * (ESC/C0/C1/bidi/zero-width). Used by tests and the --plain output gate.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasUnsafeDisplayChars(value) {
  if (typeof value !== 'string') return false
  return UNSAFE_DISPLAY.test(value)
}

/**
 * Inverse of hasUnsafeDisplayChars().
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDisplaySafe(value) {
  return !hasUnsafeDisplayChars(value)
}

/**
 * Deep-copy a JSON value with display-unsafe characters removed from strings and keys.
 *
 * Use it for human-facing JSON fields (error message/hint, remote subject lines). It is
 * intentionally not the default for data fields: --json data keeps its value, and
 * assertJsonPure() is the gate that catches control bytes in the emitted stream.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function jsonSafe(value) {
  return sanitizeJsonValue(value, new WeakSet())
}

function sanitizeJsonValue(value, seen) {
  if (typeof value === 'string') return sanitizeJsonString(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) throw new TypeError('jsonSafe: cyclic structure')
  seen.add(value)
  let out
  if (Array.isArray(value)) {
    out = value.map((item) => sanitizeJsonValue(item, seen))
  } else {
    out = {}
    for (const [key, item] of Object.entries(value)) out[sanitizeJsonString(key)] = sanitizeJsonValue(item, seen)
  }
  seen.delete(value)
  return out
}

/**
 * Sanitise one JSON string field: strip escape sequences, bidi/zero-width marks and
 * C0/C1 controls, normalise CRLF to LF. Newlines and tabs are kept as data (JSON
 * serialisers escape them); normal CJK punctuation and emoji are preserved.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeJsonString(value) {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'string' ? value : String(value)
  text = stripBom(text)
  text = stripTerminalSequences(text)
  text = text.replace(BIDI_DISPLAY, '')
  text = text.replace(/\r\n?/g, '\n')
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
  return text
}

