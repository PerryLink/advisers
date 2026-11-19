/**
 * Text safety primitives for terminal, console and log output (0.3.0 output kernel).
 *
 * This module is the single low-level chokepoint for text that originated outside the
 * program: model output, tool results, IMAP greetings/status lines, webhook response
 * bodies, parsed documents and any other remote or user-editable content. It removes
 * the characters that can forge terminal state or log lines, without interpreting the
 * payload:
 *
 *   - escape sequences: CSI, OSC, DCS, SOS, PM, APC and the 8-bit C1 introducers;
 *   - remaining C0 controls (NUL/BEL/CR/...) and C1 controls (0x80-0x9F);
 *   - bidi overrides/isolates and zero-width/bidi marks that can reorder a rendered
 *     path or hide text (U+061C, U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF);
 *   - line breaks: a console/log line must stay exactly one line.
 *
 * Invariants:
 * - sanitizeConsoleText() always returns a single-line string with no ESC, CR, LF, NUL,
 *   BEL or C1 bytes; the returned string's length (in code points) is <= max.
 * - Normal text - Chinese punctuation, emoji, combining sequences - is preserved;
 *   the module strips control characters, it does not transliterate or escape data.
 * - No I/O, no dependencies beyond node:util.
 *
 * Callers: lib/tui/sanitize.js builds the display policy on top of these primitives.
 * lib/notify.js (webhook response body) and lib/imap.js (server greeting/status) are
 * expected to call sanitizeConsoleText() before writing remote text to stderr or
 * reminders.log; that wiring lands with the Wave-2 CLI integration.
 */
/** Default cap (in code points) for a console/log line. */
export const DEFAULT_CONSOLE_TEXT_MAX = 2000

/** Marker appended when sanitizeConsoleText() truncates a value. */
export const TRUNCATION_MARK = '…'

const ESC = 0x1b
const BEL = 0x07
const ST_8BIT = 0x9c
const CSI_8BIT = 0x9b
const OSC_8BIT = 0x9d
const DCS_8BIT = 0x90
const PM_8BIT = 0x9e
const APC_8BIT = 0x9f

const BIDI_CONTROL_PATTERN = /[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g
// Each pattern keeps the character(s) named in the constant and removes the rest.
const C0_EXCEPT_LINE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g // keeps \t and \n
const C0_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F]/g // keeps \n only
const C0_EXCEPT_TAB = /[\u0000-\u0008\u000A-\u001F\u007F]/g // keeps \t only
const C0_ALL = /[\u0000-\u001F\u007F]/g
const C1_CONTROLS = /[\u0080-\u009F]/g

/**
 * Remove the UTF-8 BOM (U+FEFF) if it is the first character.
 *
 * Only the leading BOM is removed: a U+FEFF inside the payload is data (and is
 * stripped by stripBidiControls() for display, but not here).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stripBom(value) {
  if (typeof value !== 'string' || value.length === 0) return typeof value === 'string' ? value : ''
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

/**
 * Remove terminal escape sequences (ESC/CSI/OSC/DCS/SOS/PM/APC) and the 8-bit C1
 * introducers with their payloads. Other characters, including plain C0/C1 controls,
 * are left untouched for the caller to decide about.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stripTerminalSequences(value) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : String(value)
  if (text.length === 0) return ''
  let out = ''
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code === ESC) {
      index = skipEscapeSequence(text, index)
      continue
    }
    if (code === CSI_8BIT || code === OSC_8BIT || code === DCS_8BIT || code === PM_8BIT || code === APC_8BIT || (code >= 0x91 && code <= 0x97)) {
      index = skipC1Sequence(text, index)
      continue
    }
    out += text[index]
    index += 1
  }
  return out
}

/**
 * Remove bidi controls and zero-width bidi marks that can visually reorder or hide
 * text (Trojan-Source class). Normal CJK punctuation and emoji are preserved.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stripBidiControls(value) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : String(value)
  return text.replace(BIDI_CONTROL_PATTERN, '')
}

/**
 * Remove remaining C0/C1 controls, optionally keeping line structure.
 *
 * @param {unknown} value
 * @param {{ keepNewlines?: boolean, keepTabs?: boolean, replacement?: string }} [options]
 * @returns {string}
 */
export function stripControlChars(value, { keepNewlines = true, keepTabs = true, replacement = ' ' } = {}) {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'string' ? value : String(value)
  if (keepNewlines && keepTabs) text = text.replace(C0_EXCEPT_LINE_CHARS, replacement)
  else if (keepNewlines) text = text.replace(C0_EXCEPT_NEWLINE, replacement)
  else if (keepTabs) text = text.replace(C0_EXCEPT_TAB, replacement)
  else text = text.replace(C0_ALL, replacement)
  return text.replace(C1_CONTROLS, replacement)
}

/**
 * Render an arbitrary value as one safe console/log line.
 *
 * Pipeline: strip escape sequences -> fold CR/LF to spaces -> remove bidi/zero-width
 * marks -> replace remaining C0/C1 controls with spaces -> collapse spaces -> trim ->
 * truncate to max code points (with a truncation marker inside the budget).
 *
 * The result never contains ESC, BEL, CR, LF or C1 controls; it is always one line.
 *
 * @param {unknown} value any value; null/undefined become ''
 * @param {{ max?: number, keepTabs?: boolean, ellipsis?: string }} [options]
 * @returns {string}
 */
export function sanitizeConsoleText(value, { max = DEFAULT_CONSOLE_TEXT_MAX, keepTabs = true, ellipsis = TRUNCATION_MARK } = {}) {
  if (value === null || value === undefined) return ''
  const raw = typeof value === 'string' ? value : String(value)
  let text = stripTerminalSequences(raw)
  text = text.replace(/\r\n?/g, ' ').replace(/\n+/g, ' ')
  if (!keepTabs) text = text.replace(/\t+/g, ' ')
  text = stripBidiControls(text)
  text = text.replace(C0_EXCEPT_LINE_CHARS, ' ')
  text = text.replace(C1_CONTROLS, ' ')
  text = text.replace(/ {2,}/g, ' ').trim()
  return truncateCodePoints(text, normalizeMax(max), String(ellipsis))
}

function normalizeMax(max) {
  if (!Number.isSafeInteger(max) || max < 0) return DEFAULT_CONSOLE_TEXT_MAX
  return max
}

function truncateCodePoints(text, max, ellipsis) {
  if (max <= 0) return ''
  const codePoints = Array.from(text)
  if (codePoints.length <= max) return text
  const mark = Array.from(ellipsis)
  if (mark.length >= max) return codePoints.slice(0, max).join('')
  return codePoints.slice(0, max - mark.length).join('') + ellipsis
}

function skipEscapeSequence(text, start) {
  const length = text.length
  if (start + 1 >= length) return length
  const next = text.charCodeAt(start + 1)
  if (next === 0x5b) return skipCsiPayload(text, start + 2)
  if (next === 0x5d) return skipOscPayload(text, start + 2)
  if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) return skipStringPayload(text, start + 2)
  if (next >= 0x20 && next <= 0x2f) {
    let index = start + 1
    while (index < length) {
      const code = text.charCodeAt(index)
      if (code < 0x20 || code > 0x2f) break
      index += 1
    }
    if (index < length && text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x7e) return index + 1
    return index
  }
  if (next >= 0x30 && next <= 0x7e) return start + 2
  return start + 1
}

function skipCsiPayload(text, start) {
  const length = text.length
  let index = start
  while (index < length) {
    const code = text.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index + 1
    index += 1
  }
  return length
}

function skipOscPayload(text, start) {
  const length = text.length
  let index = start
  while (index < length) {
    const code = text.charCodeAt(index)
    if (code === BEL || code === ST_8BIT) return index + 1
    if (code === ESC && index + 1 < length && text.charCodeAt(index + 1) === 0x5c) return index + 2
    index += 1
  }
  return length
}

function skipStringPayload(text, start) {
  const length = text.length
  let index = start
  while (index < length) {
    const code = text.charCodeAt(index)
    if (code === ST_8BIT) return index + 1
    if (code === ESC && index + 1 < length && text.charCodeAt(index + 1) === 0x5c) return index + 2
    index += 1
  }
  return length
}

function skipC1Sequence(text, start) {
  const length = text.length
  const introducer = text.charCodeAt(start)
  if (introducer === CSI_8BIT) return skipCsiPayload(text, start + 1)
  if (introducer === OSC_8BIT) return skipOscPayload(text, start + 1)
  return skipStringPayload(text, start + 1)
}


