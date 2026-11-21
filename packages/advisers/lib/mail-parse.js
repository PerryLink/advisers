/**
 * Local email parsing for the 0.4.0 mail entry.
 *
 * parseMailMessage(raw) is the one function mail sync and the .eml/.mbox
 * fallback share. It reuses lib/importers.js parseEml() for the readable text
 * body (MIME text/plain first, tag-stripped HTML fallback, transfer decoding)
 * and adds ATTACHMENT METADATA ONLY: name / size / mime. Attachment bytes are
 * never written anywhere, never decoded into the ledger and never returned.
 *
 * Pure and offline: no fs, no network, no console. Malformed MIME never
 * throws; the affected metadata is dropped and explained in `warnings`.
 */
import { parseEml } from './importers.js'

export const MAX_ATTACHMENTS = 50
export const MAX_ATTACHMENT_NAME_CHARS = 120
const MAX_MIME_DEPTH = 10

function normalizeNewlines(value) {
  return String(value == null ? '' : value).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function splitHeadBody(text) {
  const index = text.indexOf('\n\n')
  if (index === -1) return { head: text, body: '' }
  return { head: text.slice(0, index), body: text.slice(index + 2) }
}

function splitQuoted(value, separator) {
  const out = []
  let current = ''
  let quoted = false
  for (const char of String(value)) {
    if (char === '"') { quoted = !quoted; current += char; continue }
    if (char === separator && !quoted) { out.push(current); current = ''; continue }
    current += char
  }
  out.push(current)
  return out
}

function unquote(value) {
  const text = String(value == null ? '' : value).trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\(.)/g, '$1')
  return text
}

function parseHeaders(head) {
  const map = Object.create(null)
  const lines = []
  for (const line of normalizeNewlines(head).split('\n')) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += ' ' + line.trim()
    else lines.push(line)
  }
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    if (!name || map[name] !== undefined) continue
    map[name] = line.slice(colon + 1).trim()
  }
  return map
}

function paramsOf(segments) {
  const params = {}
  for (const segment of segments.slice(1)) {
    const equals = segment.indexOf('=')
    if (equals <= 0) continue
    const key = segment.slice(0, equals).trim().toLowerCase()
    if (!key || params[key] !== undefined) continue
    params[key] = unquote(segment.slice(equals + 1))
  }
  return params
}

/** Parse a Content-Type header into { mime, params }. Pure. */
export function parseContentType(raw) {
  const segments = splitQuoted(String(raw == null ? '' : raw), ';')
  const mime = (segments[0] || 'text/plain').trim().toLowerCase() || 'text/plain'
  return { mime, params: paramsOf(segments) }
}

/** Parse a Content-Disposition header into { type, params }. Pure. */
export function parseContentDisposition(raw) {
  const segments = splitQuoted(String(raw == null ? '' : raw), ';')
  const type = (segments[0] || '').trim().toLowerCase()
  return { type, params: paramsOf(segments) }
}

function decodeHeaderWords(value) {
  return String(value == null ? '' : value).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, data) => {
    try {
      const buffer = encoding.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1')
      const label = String(charset).toLowerCase().replace(/^utf8$/, 'utf-8')
      if (label === 'utf-8' || label === 'utf8') return buffer.toString('utf8')
      if (label === 'gbk' || label === 'gb2312' || label === 'gb18030') return buffer.toString('utf8')
      if (label === 'iso-8859-1' || label === 'latin1') return buffer.toString('latin1')
      return buffer.toString('utf8')
    } catch { return match }
  })
}

function sanitizeAttachmentName(value, index) {
  let name = decodeHeaderWords(value)
  name = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name || name === '.' || name === '..') name = 'attachment-' + (index + 1)
  return name.slice(0, MAX_ATTACHMENT_NAME_CHARS)
}

function splitMultipart(body, boundary) {
  const marker = '--' + boundary
  const parts = []
  let current = null
  for (const line of body.split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    if (trimmed === marker || trimmed === marker + '--') {
      if (current) parts.push(current.join('\n'))
      current = trimmed === marker + '--' ? null : []
      if (trimmed === marker + '--') break
      continue
    }
    if (current) current.push(line)
  }
  if (current) parts.push(current.join('\n'))
  return parts
}

function decodedByteLength(body, transferEncoding) {
  const encoding = String(transferEncoding == null ? '' : transferEncoding).trim().toLowerCase()
  if (encoding === 'base64') {
    const compact = body.replace(/[^A-Za-z0-9+/=]/g, '')
    const padding = (compact.match(/=+$/) || [''])[0].length
    return Math.max(0, Math.floor((compact.length * 3) / 4) - padding)
  }
  if (encoding === 'quoted-printable') {
    const text = body.replace(/=\r?\n/g, '')
    let size = 0
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]
      if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 1, index + 3))) { size += 1; index += 2; continue }
      if (char === '\n' || char === '\r') continue
      size += 1
    }
    return size
  }
  return Buffer.byteLength(body)
}

function walkEntity(entity, depth, out, warnings) {
  if (depth > MAX_MIME_DEPTH) { warnings.push('MIME nesting is too deep; deeper parts were ignored'); return }
  const { head, body } = splitHeadBody(normalizeNewlines(entity))
  const headers = parseHeaders(head)
  const contentType = parseContentType(headers['content-type'])
  if (contentType.mime.startsWith('multipart/')) {
    const boundary = contentType.params.boundary
    if (!boundary) { warnings.push('a multipart part has no boundary'); return }
    for (const part of splitMultipart(body, boundary)) walkEntity(part, depth + 1, out, warnings)
    return
  }
  const disposition = parseContentDisposition(headers['content-disposition'])
  const rawName = disposition.params.filename ?? contentType.params.name
  const isAttachment = disposition.type === 'attachment' || Boolean(rawName)
  if (!isAttachment) return
  out.push({
    name: sanitizeAttachmentName(rawName, out.length),
    size: decodedByteLength(body, headers['content-transfer-encoding']),
    mime: contentType.mime.slice(0, 120),
  })
}

/**
 * Attachment metadata only: [{ name, size, mime }]. Never throws.
 * @param {string} raw RFC 822 / MIME message source
 * @returns {Array<{ name: string, size: number, mime: string }>}
 */
export function scanAttachments(raw) {
  const source = normalizeNewlines(raw)
  const out = []
  const warnings = []
  try {
    walkEntity(source, 0, out, warnings)
  } catch { return out }
  return out.slice(0, MAX_ATTACHMENTS)
}

function cleanHeader(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Parse one RFC 822 message into the row fields the mail store needs.
 * @returns {{ from: string, to: string, subject: string, date: string,
 *   messageId: string, text: string, attachments: Array<{name,size,mime}>,
 *   warnings: string[], sizeBytes: number }}
 */
export function parseMailMessage(raw) {
  const source = normalizeNewlines(raw)
  let parsed
  const warnings = []
  try {
    parsed = parseEml(source)
  } catch {
    parsed = { from: '', to: '', subject: '', date: '', messageId: '', text: '', warnings: [] }
    warnings.push('message could not be parsed')
  }
  for (const warning of Array.isArray(parsed.warnings) ? parsed.warnings : []) {
    if (!warnings.includes(warning)) warnings.push(warning)
  }
  return {
    from: cleanHeader(parsed.from),
    to: cleanHeader(parsed.to),
    subject: cleanHeader(parsed.subject),
    date: cleanHeader(parsed.date),
    messageId: cleanHeader(parsed.messageId),
    text: typeof parsed.text === 'string' ? parsed.text : '',
    attachments: scanAttachments(source),
    warnings,
    sizeBytes: Buffer.byteLength(source),
  }
}
