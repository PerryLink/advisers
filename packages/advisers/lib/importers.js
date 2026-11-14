/**
 * E2 read-only import parsers.
 *
 * Pure, offline, dependency-free parsers for the file formats a read-only
 * import entry point is expected to accept:
 *
 *   parseEml(raw)                  -> one RFC 822 message (minimal MIME subset)
 *   parseMbox(raw)                 -> parseEml() for every `From ` separated block
 *   parseIcs(raw)                  -> array of VEVENT records
 *   parseTranscript(raw, opts?)    -> { text, segments } from VTT/SRT/plain text
 *   toCaptureInput(parsed, opts)   -> { text, source, meta } ready for capture
 *   dedupeKey(source, parsed)      -> stable sha256 hex key
 *
 * Design constraints:
 *   - no network, no filesystem, no third-party dependencies (node:crypto only);
 *   - every function is deterministic for the same input;
 *   - malformed email/transcript input never throws: the affected text is
 *     dropped and explained in `warnings` (calendar input is the exception:
 *     structurally invalid iCalendar throws Error, as required by the E2 spec).
 *
 * Deliberate limits (documented, not bugs):
 *   - emails: no address rewriting, no attachment extraction, no MIME
 *     parameter continuation (RFC 2231), no S/MIME, no header charset guessing
 *     for 8bit bodies (the caller already supplied a JS string);
 *   - mbox: no `>From ` unquoting, no Content-Length handling;
 *   - iCalendar: no time zone database (TZID is kept as a literal marker), no
 *     RRULE expansion, no recurrence overrides / EXDATE resolution;
 *   - transcripts: cue timing only (no word-level timestamps), no speaker
 *     diarization beyond `<v Name>` / `Name:` prefixes.
 */

import { createHash } from 'node:crypto'

const HTML_ENTITIES = {
  amp: '&',
  apos: "'",
  bull: '•',
  copy: '©',
  deg: '°',
  divide: '÷',
  emsp: '\u2003',
  ensp: '\u2002',
  euro: '€',
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  middot: '·',
  nbsp: '\u00a0',
  ndash: '–',
  para: '¶',
  pound: '£',
  quot: '"',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  sect: '§',
  thinsp: '\u2009',
  times: '×',
  yen: '¥',
}

const CHARSET_ALIASES = {
  ascii: 'windows-1252',
  'us-ascii': 'windows-1252',
  'iso-8859-1': 'windows-1252',
  'iso8859-1': 'windows-1252',
  'latin1': 'windows-1252',
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  'gb2312': 'gbk',
  'gb-2312': 'gbk',
  'gb_2312': 'gbk',
  'x-gbk': 'gbk',
}

const TRANSFER_IDENTITY = new Set(['', '7bit', '8bit', 'binary'])
const TRANSFER_DECODED = new Set(['base64', 'quoted-printable'])

function asString(value) {
  if (value == null) return ''
  return typeof value === 'string' ? value : String(value)
}

function normalizeNewlines(value) {
  return asString(value).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function pushWarning(warnings, message) {
  if (warnings && !warnings.includes(message)) warnings.push(message)
}

function cleanText(value) {
  return asString(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripTrailing(value) {
  return asString(value).replace(/[ \t]+$/gm, '')
}

/* ------------------------------------------------------------------ *
 * Header helpers
 * ------------------------------------------------------------------ */

function splitHeadersAndBody(text) {
  const separator = text.indexOf('\n\n')
  if (separator === -1) return { head: text, body: '', separated: false }
  return { head: text.slice(0, separator), body: text.slice(separator + 2), separated: true }
}

function unfoldHeaderBlock(block) {
  const lines = []
  for (const line of normalizeNewlines(block).split('\n')) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += ` ${line.trim()}`
    else lines.push(line)
  }
  return lines
}

function parseHeaderBlock(block) {
  const headers = {}
  for (const line of unfoldHeaderBlock(block)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const name = line.slice(0, index).trim().toLowerCase()
    if (!name || name in headers) continue
    headers[name] = line.slice(index + 1).trim()
  }
  return headers
}

function splitQuoted(value, separator) {
  const out = []
  let current = ''
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (quoted) {
      current += char
      if (char === '\\' && i + 1 < value.length) current += value[++i]
      else if (char === '"') quoted = false
    } else if (char === '"') {
      quoted = true
      current += char
    } else if (char === separator) {
      out.push(current)
      current = ''
    } else {
      current += char
    }
  }
  out.push(current)
  return out
}

function unquote(value) {
  const text = asString(value).trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return text
}

function parseParameterList(raw) {
  const params = {}
  for (const segment of splitQuoted(asString(raw), ';').slice(1)) {
    const equals = segment.indexOf('=')
    if (equals <= 0) continue
    const key = segment.slice(0, equals).trim().toLowerCase()
    if (!key) continue
    params[key] = unquote(segment.slice(equals + 1))
  }
  return params
}

function parseContentType(value) {
  const raw = asString(value).trim()
  if (!raw) return { type: '', params: {} }
  const segments = splitQuoted(raw, ';')
  return { type: segments[0].trim().toLowerCase(), params: parseParameterList(raw) }
}

function parseDisposition(value) {
  const raw = asString(value).trim()
  if (!raw) return ''
  return splitQuoted(raw, ';')[0].trim().toLowerCase()
}

function normalizeCharset(value) {
  const label = unquote(value).trim().toLowerCase()
  if (!label) return 'utf-8'
  return CHARSET_ALIASES[label] || label
}

function decodeBytes(bytes, charset, warnings) {
  const label = normalizeCharset(charset)
  if (!bytes || !bytes.length) return ''
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes)
  } catch {
    pushWarning(warnings, `unsupported charset: ${asString(charset).trim() || label}`)
    return null
  }
}

/* ------------------------------------------------------------------ *
 * RFC 2047 encoded words (headers)
 * ------------------------------------------------------------------ */

function decodeQuotedPrintableWord(payload) {
  const bytes = []
  for (let i = 0; i < payload.length; i++) {
    const char = payload[i]
    if (char === '_') {
      bytes.push(0x20)
      continue
    }
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(payload.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(payload.slice(i + 1, i + 3), 16))
      i += 2
      continue
    }
    const code = char.charCodeAt(0)
    bytes.push(code <= 0xff ? code : 0x3f)
  }
  return Buffer.from(bytes)
}

function decodeEncodedWord(charset, encoding, payload, warnings) {
  let bytes
  if (encoding.toUpperCase() === 'B') {
    const compact = payload.replace(/\s+/g, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
      pushWarning(warnings, 'invalid base64 encoded-word')
      return null
    }
    bytes = Buffer.from(compact, 'base64')
  } else {
    bytes = decodeQuotedPrintableWord(payload)
  }
  return decodeBytes(bytes, charset.split('*')[0], warnings)
}

function decodeHeaderValue(value, warnings) {
  const input = asString(value)
  if (!input.includes('=?')) return input
  const pattern = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g
  const tokens = []
  let last = 0
  let match
  while ((match = pattern.exec(input))) {
    if (match.index > last) tokens.push({ encoded: false, raw: input.slice(last, match.index) })
    tokens.push({ encoded: true, raw: match[0], charset: match[1], encoding: match[2], payload: match[3] })
    last = match.index + match[0].length
  }
  if (!tokens.length) return input
  if (last < input.length) tokens.push({ encoded: false, raw: input.slice(last) })
  let out = ''
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.encoded) {
      const decoded = decodeEncodedWord(token.charset, token.encoding, token.payload, warnings)
      out += decoded == null ? token.raw : decoded
    } else if (tokens[i - 1]?.encoded && tokens[i + 1]?.encoded && /^[ \t\r\n]*$/.test(token.raw)) {
      // RFC 2047: whitespace between two adjacent encoded-words is not content.
    } else {
      out += token.raw
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Bodies: transfer encodings, charsets, HTML
 * ------------------------------------------------------------------ */

function decodeQuotedPrintableBody(value) {
  const source = asString(value)
  const bytes = []
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '=') {
      if (source[i + 1] === '\n') {
        i += 1 // soft line break
        continue
      }
      if (/^[0-9A-Fa-f]{2}$/.test(source.slice(i + 1, i + 3))) {
        bytes.push(Number.parseInt(source.slice(i + 1, i + 3), 16))
        i += 2
        continue
      }
      bytes.push(0x3d) // lone '=': keep literal rather than corrupt the body
      continue
    }
    const code = char.charCodeAt(0)
    if (code <= 0x7f) {
      bytes.push(code)
    } else {
      bytes.push(...Buffer.from(char, 'utf8'))
    }
  }
  return Buffer.from(bytes)
}

function decodeTransferBody(body, transferEncoding, warnings) {
  const encoding = asString(transferEncoding).trim().toLowerCase()
  if (TRANSFER_IDENTITY.has(encoding)) return { text: asString(body) }
  if (TRANSFER_DECODED.has(encoding)) {
    if (encoding === 'quoted-printable') return { bytes: decodeQuotedPrintableBody(body) }
    const compact = asString(body).replace(/\s+/g, '')
    if (!compact) return { bytes: Buffer.alloc(0) }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
      pushWarning(warnings, 'invalid base64 body')
      return null
    }
    return { bytes: Buffer.from(compact, 'base64') }
  }
  pushWarning(warnings, `unsupported content-transfer-encoding: ${encoding}`)
  return null
}

function decodeEntityContent(headers, body, warnings) {
  const contentType = parseContentType(headers['content-type'])
  const decoded = decodeTransferBody(body, headers['content-transfer-encoding'], warnings)
  if (!decoded) return { text: null, contentType }
  if (decoded.text !== undefined) return { text: decoded.text, contentType }
  const charset = contentType.params.charset || 'utf-8'
  return { text: decodeBytes(decoded.bytes, charset, warnings), contentType }
}

function decodeNumericEntity(digits, radix) {
  const codePoint = Number.parseInt(digits, radix)
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return null
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null
  try {
    return String.fromCodePoint(codePoint)
  } catch {
    return null
  }
}

function decodeHtmlEntities(value) {
  return asString(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (entity, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const decoded = decodeNumericEntity(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      return decoded == null ? entity : decoded
    }
    const named = HTML_ENTITIES[body.toLowerCase()]
    return named == null ? entity : named
  })
}

function htmlToText(value) {
  const html = asString(value)
  if (!html) return ''
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table|section|article|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  text = decodeHtmlEntities(text)
  return text
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* ------------------------------------------------------------------ *
 * MIME multipart walking
 * ------------------------------------------------------------------ */

function splitMultipart(body, boundary, warnings) {
  const marker = `--${asString(boundary)}`
  if (!asString(boundary)) {
    pushWarning(warnings, 'multipart entity without boundary parameter')
    return []
  }
  const parts = []
  let current = null
  let closed = false
  for (const line of normalizeNewlines(body).split('\n')) {
    const trimmed = line.replace(/[ \t]+$/, '')
    if (trimmed === marker || trimmed === `${marker}--`) {
      if (current) parts.push(current.join('\n'))
      current = null
      if (trimmed === `${marker}--`) {
        closed = true
        break
      }
      current = []
      continue
    }
    if (current) current.push(line)
  }
  if (current) parts.push(current.join('\n'))
  if (!closed) pushWarning(warnings, 'multipart entity is missing its closing boundary')
  return parts.map((part) => part.replace(/^\n+/, '')).filter((part) => part.trim() !== '')
}

function collectMimeContent(entity, warnings, collected) {
  const { head, body } = splitHeadersAndBody(normalizeNewlines(entity))
  const headers = parseHeaderBlock(head)
  const contentType = parseContentType(headers['content-type'])
  if (parseDisposition(headers['content-disposition']) === 'attachment') return

  if (contentType.type.startsWith('multipart/')) {
    const decoded = decodeTransferBody(body, headers['content-transfer-encoding'], warnings)
    if (!decoded) return
    let raw = decoded.text
    if (raw === undefined) raw = decodeBytes(decoded.bytes, 'utf-8', warnings)
    if (raw == null) return
    const parts = splitMultipart(raw, contentType.params.boundary, warnings)
    if (!parts.length) pushWarning(warnings, 'multipart entity has no parts')
    for (const part of parts) collectMimeContent(part, warnings, collected)
    return
  }

  const { text } = decodeEntityContent(headers, body, warnings)
  if (text == null) return
  if (contentType.type === 'text/html') collected.html.push(text)
  else if (contentType.type === 'text/plain' || !contentType.type) collected.plain.push(text)
  // other leaf types (images, application/pdf, message/rfc822, ...) are ignored
}

/* ------------------------------------------------------------------ *
 * parseEml
 * ------------------------------------------------------------------ */

function cleanMessageId(value) {
  const text = asString(value).trim()
  const wrapped = /^<([^>]+)>$/.exec(text)
  return (wrapped ? wrapped[1] : text).trim()
}

/**
 * Parse one RFC 822 message using a minimal MIME subset.
 *
 * `text` is always the readable rendering: the first `text/plain` part, or the
 * tag-stripped / entity-decoded `text/html` part when no plain part exists.
 * `html` (only when a `text/html` part exists) keeps the decoded HTML source so
 * callers can re-render or archive it; it is never returned as capture text.
 * Encoding failures and missing bodies yield `text: ''` plus a non-empty
 * `warnings` array instead of throwing.
 *
 * @param {string} raw
 * @returns {{ from: string, to: string, subject: string, date: string,
 *   messageId: string, text: string, html?: string, warnings: string[] }}
 */
export function parseEml(raw) {
  const warnings = []
  const source = normalizeNewlines(raw)
  if (!source.trim()) {
    return { from: '', to: '', subject: '', date: '', messageId: '', text: '', warnings: ['empty message'] }
  }

  const split = splitHeadersAndBody(source)
  let headers = parseHeaderBlock(split.head)
  let body = split.body
  if (!split.separated && !Object.keys(headers).length) {
    // Tolerate a body-only input instead of silently returning nothing.
    headers = {}
    body = source
    pushWarning(warnings, 'message has no header/body separator')
  }

  const from = cleanText(decodeHeaderValue(headers.from, warnings))
  const to = cleanText(decodeHeaderValue(headers.to, warnings))
  const subject = cleanText(decodeHeaderValue(headers.subject, warnings))
  const date = cleanText(decodeHeaderValue(headers.date, warnings))
  const messageId = cleanMessageId(decodeHeaderValue(headers['message-id'], warnings))

  const collected = { plain: [], html: [] }
  collectMimeContent(source, warnings, collected)

  const plain = collected.plain.map(cleanText).find(Boolean) || ''
  const html = collected.html.map(cleanText).find(Boolean) || ''
  const text = plain || (html ? htmlToText(html) : '')
  if (!text) pushWarning(warnings, 'message has no readable text body')

  const result = { from, to, subject, date, messageId, text, warnings }
  if (html) result.html = html
  return result
}

/* ------------------------------------------------------------------ *
 * parseMbox
 * ------------------------------------------------------------------ */

/**
 * Split an mbox stream on `^From ` separator lines and parse every message.
 *
 * @param {string} raw
 * @returns {Array<ReturnType<typeof parseEml>>}
 */
export function parseMbox(raw) {
  const source = normalizeNewlines(raw)
  if (!source.trim()) return []
  const results = []
  const leading = []
  let current = null
  for (const line of source.split('\n')) {
    if (line.startsWith('From ')) {
      if (current) results.push(parseEml(current.join('\n')))
      current = []
      continue
    }
    if (current) current.push(line)
    else leading.push(line)
  }
  if (current) {
    const chunk = current.join('\n')
    if (chunk.trim()) results.push(parseEml(chunk))
  }
  const preamble = leading.join('\n').trim()
  if (preamble) results.unshift(parseEml(preamble))
  return results
}

/* ------------------------------------------------------------------ *
 * parseIcs
 * ------------------------------------------------------------------ */

function unfoldIcs(raw) {
  const out = []
  for (const line of normalizeNewlines(raw).split('\n')) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1)
    else out.push(line)
  }
  return out
}

function findPropertyColon(line) {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') quoted = !quoted
    else if (char === ':' && !quoted) return i
  }
  return -1
}

function parseIcsProperty(line) {
  const colon = findPropertyColon(line)
  if (colon <= 0) return null
  const left = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const segments = splitQuoted(left, ';')
  const name = segments[0].trim().toUpperCase()
  if (!name) return null
  const params = {}
  for (const segment of segments.slice(1)) {
    const equals = segment.indexOf('=')
    if (equals <= 0) continue
    params[segment.slice(0, equals).trim().toUpperCase()] = unquote(segment.slice(equals + 1))
  }
  return { name, params, value }
}

function unescapeIcsText(value) {
  const source = asString(value)
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '\\' && i + 1 < source.length) {
      const next = source[i + 1]
      if (next === 'n' || next === 'N') {
        out += '\n'
        i += 1
      } else if (next === ',' || next === ';' || next === '\\') {
        out += next
        i += 1
      } else {
        out += char
      }
    } else {
      out += char
    }
  }
  return out
}

function parseIcsDate(property) {
  if (!property) return { value: null, allDay: false, tzid: null }
  const raw = asString(property.value).trim()
  const tzid = property.params.TZID ? property.params.TZID.trim() : null
  let match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw)
  if (match) return { value: `${match[1]}-${match[2]}-${match[3]}`, allDay: true, tzid }
  match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i.exec(raw)
  if (match) {
    const value = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7] ? 'Z' : ''}`
    return { value, allDay: false, tzid: match[7] ? null : tzid }
  }
  // Unknown / extended forms are kept verbatim so no information is lost.
  return { value: raw, allDay: false, tzid }
}

function buildIcsEvent(lines) {
  const properties = new Map()
  let skipDepth = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const upper = trimmed.toUpperCase()
    if (skipDepth > 0) {
      if (upper.startsWith('BEGIN:')) skipDepth += 1
      else if (upper.startsWith('END:')) skipDepth -= 1
      continue
    }
    if (upper.startsWith('BEGIN:')) {
      // Nested components (VALARM) may carry their own DESCRIPTION; skip them.
      skipDepth = 1
      continue
    }
    if (upper.startsWith('END:')) continue
    const property = parseIcsProperty(line)
    if (property && !properties.has(property.name)) properties.set(property.name, property)
  }

  const get = (name) => properties.get(name)
  const textValue = (name) => {
    const property = get(name)
    return property ? unescapeIcsText(property.value).trim() : ''
  }
  const start = parseIcsDate(get('DTSTART'))
  const end = parseIcsDate(get('DTEND'))
  const uidProperty = get('UID')
  const rruleProperty = get('RRULE')

  return {
    uid: uidProperty ? unescapeIcsText(uidProperty.value).trim() : '',
    summary: textValue('SUMMARY'),
    start: start.value,
    end: end ? end.value : null,
    allDay: start.allDay,
    tzid: start.tzid ?? null,
    description: textValue('DESCRIPTION'),
    location: textValue('LOCATION'),
    // Kept as the original rule text: it is evidence, not something to expand.
    rrule: rruleProperty ? asString(rruleProperty.value).trim() : null,
  }
}

/**
 * Parse an iCalendar stream and return its VEVENT records.
 *
 * Dates are normalised to `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM:SS[Z]`. Floating
 * times with `TZID=...` are kept literally and the zone is exposed as `tzid`
 * (there is no time zone database in this module). RRULE is never expanded.
 *
 * @param {string} raw
 * @returns {Array<{ uid: string, summary: string, start: string|null,
 *   end: string|null, allDay: boolean, tzid: string|null,
 *   description: string, location: string, rrule: string|null }>}
 * @throws {Error} on structurally invalid iCalendar input
 */
export function parseIcs(raw) {
  if (typeof raw !== 'string') throw new Error('parseIcs: expected a string')
  const source = normalizeNewlines(raw)
  if (!source.trim()) throw new Error('parseIcs: empty input')
  const lines = unfoldIcs(source)
  const hasCalendar = lines.some((line) => line.trim().toUpperCase() === 'BEGIN:VCALENDAR')
  if (!hasCalendar) throw new Error('parseIcs: missing BEGIN:VCALENDAR')

  const events = []
  let calendarOpen = false
  let calendarClosed = false
  let inEvent = false
  let eventLines = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const upper = trimmed.toUpperCase()
    if (upper === 'BEGIN:VCALENDAR') {
      if (calendarOpen) throw new Error('parseIcs: nested VCALENDAR is not supported')
      calendarOpen = true
      continue
    }
    if (upper === 'END:VCALENDAR') {
      if (!calendarOpen) throw new Error('parseIcs: END:VCALENDAR without BEGIN:VCALENDAR')
      if (inEvent) throw new Error('parseIcs: unterminated VEVENT')
      calendarOpen = false
      calendarClosed = true
      continue
    }
    if (upper === 'BEGIN:VEVENT') {
      if (inEvent) throw new Error('parseIcs: nested VEVENT is not supported')
      inEvent = true
      eventLines = []
      continue
    }
    if (upper === 'END:VEVENT') {
      if (!inEvent) throw new Error('parseIcs: END:VEVENT without BEGIN:VEVENT')
      events.push(buildIcsEvent(eventLines))
      inEvent = false
      eventLines = []
      continue
    }
    if (inEvent) eventLines.push(line)
  }

  if (inEvent) throw new Error('parseIcs: unterminated VEVENT')
  if (!calendarClosed) throw new Error('parseIcs: unterminated VCALENDAR')
  return events
}

/* ------------------------------------------------------------------ *
 * parseTranscript
 * ------------------------------------------------------------------ */

const CUE_TIMING = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?[ \t]*-->[ \t]*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?/

function secondsFromCue(hours, minutes, seconds, fraction) {
  const whole = Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(seconds)
  const millis = fraction ? Number(`${fraction}000`.slice(0, 3)) : 0
  return Math.round((whole + millis / 1000) * 1000) / 1000
}

function parseCueTiming(line) {
  const match = CUE_TIMING.exec(asString(line).trim())
  if (!match) return null
  return {
    start: secondsFromCue(match[1], match[2], match[3], match[4]),
    end: secondsFromCue(match[5], match[6], match[7], match[8]),
  }
}

function detectTranscriptFormat(text) {
  const head = asString(text).replace(/^\uFEFF/, '').trimStart()
  if (/^WEBVTT(?:[ \t]|\n|$)/i.test(head)) return 'vtt'
  if (/^\d{1,2}:\d{2}:\d{2},\d{1,3}[ \t]*-->/m.test(text)) return 'srt'
  if (/-->/.test(text)) return 'vtt'
  return 'text'
}

function speakerFromPrefix(line) {
  const match = /^([^:：\n]{1,24})[：:][ \t]*(.*)$/.exec(asString(line).trim())
  if (!match) return null
  const speaker = match[1]
    .replace(/^[*_`~\[\]()（）【】]+|[*_`~\[\]()（）【】]+$/g, '')
    .trim()
  if (!speaker || /^\d+$/.test(speaker)) return null
  return { speaker, text: match[2].trim() }
}

function normaliseCueText(raw) {
  let speaker
  let text = asString(raw)
  text = text.replace(/<v(?:\.[^ >]+)?[ \t]+([^>]+)>/gi, (_tag, name) => {
    if (!speaker) speaker = asString(name).trim()
    return ''
  })
  text = text.replace(/<\/v>/gi, '')
  text = text.replace(/<[^>]*>/g, '')
  text = decodeHtmlEntities(text)
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  let body = lines.join('\n')
  if (!speaker) {
    const prefixed = speakerFromPrefix(lines[0] || '')
    if (prefixed) {
      speaker = prefixed.speaker
      body = [prefixed.text, ...lines.slice(1)].filter(Boolean).join('\n')
    }
  }
  return { speaker, text: body.trim() }
}

function parseCueTranscript(text) {
  const segments = []
  for (const block of asString(text).split(/\n[ \t]*\n/)) {
    const lines = block.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '')
    if (!lines.length) continue
    const first = lines[0].trim()
    if (/^WEBVTT(?:[ \t]|$)/i.test(first) || /^NOTE(?:[ \t]|$)/i.test(first) || /^STYLE(?:[ \t]|$)/i.test(first) || /^REGION(?:[ \t]|$)/i.test(first)) continue
    let timingIndex = -1
    let timing = null
    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      timing = parseCueTiming(lines[i])
      if (timing) {
        timingIndex = i
        break
      }
    }
    if (!timing) continue
    const cue = normaliseCueText(lines.slice(timingIndex + 1).join('\n'))
    if (!cue.text) continue
    segments.push({
      start: timing.start,
      end: timing.end,
      ...(cue.speaker ? { speaker: cue.speaker } : {}),
      text: cue.text,
    })
  }
  return { text: segments.map((segment) => segment.text).join('\n'), segments }
}

function parsePlainTranscript(text) {
  const source = stripTrailing(asString(text)).trim()
  if (!source) return { text: '', segments: [] }
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean)
  let hasSpeaker = false
  const segments = []
  for (const line of lines) {
    const prefixed = speakerFromPrefix(line)
    if (prefixed) {
      hasSpeaker = true
      segments.push({ speaker: prefixed.speaker, text: prefixed.text })
    } else {
      segments.push({ text: line })
    }
  }
  if (!hasSpeaker) return { text: source, segments: [{ text: source }] }
  return { text: source, segments }
}

/**
 * Parse a transcript in WebVTT, SubRip or plain-text form.
 *
 * Format is auto-detected from the content (VTT header, `-->` timing lines and
 * SRT comma milliseconds); plain `.txt`/`.md` files fall back to text mode.
 * Cue times are returned as seconds (numbers). Plain text without timestamps
 * yields one segment covering the whole text.
 *
 * @param {string} raw
 * @param {{ format?: 'auto'|'vtt'|'srt'|'text' }} [options]
 * @returns {{ text: string, segments: Array<{ start?: number, end?: number,
 *   speaker?: string, text: string }> }}
 */
export function parseTranscript(raw, options = {}) {
  const source = normalizeNewlines(raw)
  if (!source.trim()) return { text: '', segments: [] }
  const requested = asString(options?.format).trim().toLowerCase()
  const format = requested && requested !== 'auto' ? requested : detectTranscriptFormat(source)
  if (format === 'vtt' || format === 'webvtt' || format === 'srt') return parseCueTranscript(source)
  return parsePlainTranscript(source)
}

/* ------------------------------------------------------------------ *
 * toCaptureInput
 * ------------------------------------------------------------------ */

function isTranscriptResult(parsed) {
  return Boolean(parsed && typeof parsed === 'object' && Array.isArray(parsed.segments) && typeof parsed.text === 'string')
}

function isEmailResult(parsed) {
  return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed.segments) &&
    ('messageId' in parsed || 'subject' in parsed || ('from' in parsed && 'to' in parsed)))
}

function isCalendarResult(parsed) {
  return Boolean(parsed && typeof parsed === 'object' && ('uid' in parsed || ('summary' in parsed && 'start' in parsed)))
}

function uniqueSpeakers(segments) {
  const speakers = []
  for (const segment of Array.isArray(segments) ? segments : []) {
    const speaker = asString(segment?.speaker).trim()
    if (speaker && !speakers.includes(speaker)) speakers.push(speaker)
  }
  return speakers
}

function emailCaptureInput(parsed, source) {
  const text = cleanText(parsed.text) || cleanText(parsed.subject)
  const meta = {
    subject: asString(parsed.subject).trim(),
    from: asString(parsed.from).trim(),
    date: asString(parsed.date).trim(),
    messageId: asString(parsed.messageId).trim(),
  }
  if (Array.isArray(parsed.warnings) && parsed.warnings.length) meta.warnings = [...parsed.warnings]
  return { text, source, meta }
}

function calendarCaptureInput(parsed, source) {
  const summary = asString(parsed.summary).trim()
  const start = parsed.start == null ? null : asString(parsed.start)
  const end = parsed.end == null ? null : asString(parsed.end)
  const tzid = parsed.tzid == null ? null : asString(parsed.tzid)
  const location = asString(parsed.location).trim()
  const description = asString(parsed.description).trim()
  const rrule = parsed.rrule == null ? null : asString(parsed.rrule)
  const lines = []
  if (summary) lines.push(`摘要：${summary}`)
  const when = [start, end].filter(Boolean).join(' ~ ')
  if (when) lines.push(`时间：${when}${tzid ? ` (${tzid})` : ''}`)
  if (location) lines.push(`地点：${location}`)
  if (description) lines.push(`详情：${description}`)
  if (rrule) lines.push(`重复：${rrule}`)
  return {
    text: lines.join('\n'),
    source,
    meta: {
      uid: asString(parsed.uid).trim(),
      summary,
      start,
      end,
      allDay: Boolean(parsed.allDay),
      tzid,
      location,
      rrule,
    },
  }
}

function transcriptCaptureInput(parsed, source) {
  const segments = Array.isArray(parsed.segments) ? parsed.segments : []
  return {
    text: cleanText(parsed.text),
    source,
    meta: { speakers: uniqueSpeakers(segments), segments },
  }
}

/**
 * Normalise a parser result into the `{ text, source, meta }` shape that the
 * capture pipeline consumes.
 *
 * Source defaults are inferred from the result shape (`email`, `calendar`,
 * `transcript`) and can be overridden with `{ source }`. Arrays (from
 * parseMbox / parseIcs) are collapsed into one input; their per-record meta is
 * exposed as `meta.items` plus `meta.count`.
 *
 * @param {object|object[]} parsed
 * @param {{ source?: string }} [options]
 * @returns {{ text: string, source: string, meta: object }}
 */
export function toCaptureInput(parsed, { source } = {}) {
  const explicitSource = source == null || source === '' ? undefined : asString(source)
  if (Array.isArray(parsed)) {
    const items = parsed.map((item) => toCaptureInput(item, {}))
    const text = items.map((item) => item.text).filter(Boolean).join('\n\n')
    return {
      text,
      source: explicitSource || items[0]?.source || 'import',
      meta: { count: items.length, items: items.map((item) => item.meta) },
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { text: cleanText(parsed), source: explicitSource || 'import', meta: {} }
  }
  if (isTranscriptResult(parsed)) return transcriptCaptureInput(parsed, explicitSource || 'transcript')
  if (isEmailResult(parsed)) return emailCaptureInput(parsed, explicitSource || 'email')
  if (isCalendarResult(parsed)) return calendarCaptureInput(parsed, explicitSource || 'calendar')
  return { text: cleanText(parsed.text), source: explicitSource || 'import', meta: {} }
}

/* ------------------------------------------------------------------ *
 * dedupeKey
 * ------------------------------------------------------------------ */

function canonicalKeyText(value) {
  return cleanText(asString(value))
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
}

function keyMaterial(parsed) {
  if (Array.isArray(parsed)) return `array:${parsed.map(keyMaterial).join('\u0001')}`
  if (parsed == null) return 'empty:'
  if (typeof parsed === 'string') return `text:${canonicalKeyText(parsed)}`
  if (typeof parsed !== 'object') return `value:${asString(parsed)}`
  const messageId = cleanMessageId(parsed.messageId)
  if (messageId) return `message-id:${messageId}`
  const uid = cleanMessageId(parsed.uid)
  if (uid) return `uid:${uid}`
  let text = typeof parsed.text === 'string' ? parsed.text : ''
  if (!text && typeof parsed.html === 'string') text = htmlToText(parsed.html)
  return `text:${canonicalKeyText(text)}`
}

/**
 * Stable sha256 key for idempotent imports. `messageId` wins, then `uid`,
 * then the normalised text. The source string is part of the hash input so the
 * same body imported from two channels does not collapse into one record.
 *
 * @param {string} source
 * @param {object|object[]|string} parsed
 * @returns {string} 64-character lowercase sha256 hex digest
 */
export function dedupeKey(source, parsed) {
  const hash = createHash('sha256')
  hash.update(asString(source))
  hash.update('\u0000')
  hash.update(keyMaterial(parsed))
  return hash.digest('hex')
}
