/**
 * KB text extraction (0.4.0, schema v22).
 *
 * One bounded, local-only entry point for turning a user file into the text the
 * KB indexes. This is deliberately NOT extractAttachment(): attachments are a
 * model-context budget (10 MB file, 20k chars, 50 PDF pages, silent PDF page
 * cap) while the KB is a durable local index (50 MB file, 2 MB text, 500 PDF
 * pages, explicit truncation). The two callers keep their own limits and the KB
 * module must never silently drop half a document.
 *
 * Guarantees:
 * - read-only: the source file is opened for reading only and is never copied;
 *   the returned object never contains an absolute path, only the basename;
 * - no network, no OCR fallback, no model: a scanned/image file is reported as
 *   needsOcr=true with empty text (the caller records a warning), it is not
 *   silently treated as empty content;
 * - deterministic: the same bytes + options produce the same extraction result;
 * - all limits are explicit: file bytes, extracted text bytes, PDF pages, ZIP
 *   expansion budget and per-entry XML size. A limit hit sets truncated=true and
 *   names the reason instead of silently discarding data;
 * - text encoding: BOM (UTF-8/UTF-16LE/UTF-16BE) -> strict UTF-8 -> GB18030
 *   fallback (the common Chinese-Windows legacy encoding). Undecodable bytes
 *   throw E_KB_ENCODING rather than storing mojibake.
 *
 * Pure module boundaries: no store, no HOME handling, no console output. The
 * only environment interaction is the imported read-only EML parser.
 */
import { lstatSync, readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import JSZip from 'jszip'
import { parseEml } from './importers.js'

/** Hard per-file cap for KB ingestion (larger than the 10 MB attachment cap). */
export const KB_MAX_FILE_BYTES = 50 * 1024 * 1024
/** Hard cap for the extracted text stored in kb_chunks (UTF-8 bytes). */
export const KB_MAX_TEXT_BYTES = 2 * 1024 * 1024
/** Hard cap for indexed PDF pages (the attachment path only reads 50). */
export const KB_MAX_PDF_PAGES = 500
/** Extraction pipeline version recorded next to a document. */
export const KB_EXTRACTOR_VERSION = 1

const MAX_ZIP_ENTRIES = 4000
const MAX_ZIP_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024
const MAX_ZIP_ENTRY_UNCOMPRESSED = 64 * 1024 * 1024
const MAX_XML_CHARS = 16 * 1024 * 1024

const TEXT_EXTENSIONS = Object.freeze([
  '.txt', '.md', '.markdown', '.csv', '.json', '.jsonl', '.log', '.yaml', '.yml', '.xml', '.html', '.htm',
])
const OFFICE_EXTENSIONS = Object.freeze(['.docx', '.xlsx', '.pptx'])
const IMAGE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'])
const MIME_BY_EXT = Object.freeze({
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.csv': 'text/csv', '.json': 'application/json', '.jsonl': 'application/jsonl',
  '.log': 'text/plain', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.xml': 'application/xml', '.html': 'text/html', '.htm': 'text/html',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf', '.ofd': 'application/ofd', '.eml': 'message/rfc822',
})

// KB errors carry stable codes; the message keeps only the basename so a log or
// an audit reason can never leak the operator's directory layout.
function kbError(code, message, hint) {
  const error = new Error(code + ': ' + message + (hint ? ' (hint: ' + hint + ')' : ''))
  error.code = code
  if (hint) error.hint = hint
  return error
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** Truncate a JS string to at most maxBytes UTF-8 bytes without splitting a code point. */
export function truncateUtf8(text, maxBytes) {
  const raw = String(text ?? '')
  if (byteLength(raw) <= maxBytes) return { text: raw, truncated: false }
  const buffer = Buffer.from(raw, 'utf8').subarray(0, maxBytes)
  let truncated = buffer.toString('utf8')
  // Buffer.subarray can cut a multi-byte sequence; drop the replacement char(s).
  while (truncated.endsWith('\uFFFD')) truncated = truncated.slice(0, -1)
  return { text: truncated, truncated: true }
}

export function extensionOf(file) {
  return extname(String(file ?? '')).toLowerCase()
}

function kindOfExtension(ext) {
  if (TEXT_EXTENSIONS.includes(ext)) return 'text'
  if (OFFICE_EXTENSIONS.includes(ext)) return 'office'
  if (ext === '.pdf') return 'pdf'
  if (ext === '.ofd') return 'ofd'
  if (ext === '.eml') return 'eml'
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image'
  return null
}

/** True when the file type can be indexed (used by callers before hashing). */
export function isIndexableFile(file) {
  return kindOfExtension(extensionOf(file)) !== null
}

export function mimeForFile(file) {
  return MIME_BY_EXT[extensionOf(file)] ?? 'application/octet-stream'
}

/* -------------------------------------------------------------------------- */
/* text decoding (BOM -> strict UTF-8 -> GB18030)                              */
/* -------------------------------------------------------------------------- */

function decodeWith(label, buffer) {
  return new TextDecoder(label, { fatal: true }).decode(buffer)
}

/**
 * Decode a plain-text file buffer.
 *
 * Order: a BOM (UTF-8/UTF-16LE/UTF-16BE) wins; otherwise strict UTF-8; then
 * GB18030 (the Windows Chinese legacy encoding, a superset of GBK/GB2312).
 * Throws E_KB_ENCODING when even GB18030 yields U+FFFD (never store mojibake).
 *
 * @param {Buffer} buffer
 * @returns {{text: string, encoding: string}}
 */
export function decodeTextBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  let text
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = decodeWith('utf-8', bytes.subarray(3))
    return { text, encoding: 'utf-8' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = decodeWith('utf-16le', bytes.subarray(2))
    return { text, encoding: 'utf-16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = decodeWith('utf-16be', bytes.subarray(2))
    return { text, encoding: 'utf-16be' }
  }
  try {
    return { text: decodeWith('utf-8', bytes), encoding: 'utf-8' }
  } catch {
    // Not UTF-8: fall through to the legacy Chinese encoding.
  }
  let legacy
  try {
    legacy = new TextDecoder('gb18030', { fatal: false }).decode(bytes)
  } catch (error) {
    throw kbError('E_KB_ENCODING', 'file bytes are neither valid UTF-8 nor decodable as GB18030 (' + String(error?.message ?? error).slice(0, 120) + ')')
  }
  if (legacy.includes('\uFFFD')) {
    throw kbError('E_KB_ENCODING', 'file bytes are neither valid UTF-8 nor GB18030; convert the file to UTF-8 first')
  }
  return { text: legacy, encoding: 'gb18030' }
}

/* -------------------------------------------------------------------------- */
/* HTML to text (minimal, tag-stripping only; never executes anything)        */
/* -------------------------------------------------------------------------- */

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function htmlToIndexText(html) {
  const source = String(html ?? '')
  const withoutHidden = source
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const blocked = withoutHidden.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)\s*>/gi, '\n').replace(/<[^>]+>/g, ' ')
  return blocked.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (entity, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return entity
      try { return String.fromCodePoint(code) } catch { return entity }
    }
    return HTML_ENTITIES[body.toLowerCase()] ?? entity
  })
}

export function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/* -------------------------------------------------------------------------- */
/* bounded ZIP reading (docx/xlsx/pptx/ofd)                                   */
/* -------------------------------------------------------------------------- */

function declaredUncompressedSize(entry) {
  const size = entry?._data?.uncompressedSize
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : undefined
}

class KbZipReader {
  constructor(zip) {
    this.zip = zip
    this.decompressedBytes = 0
  }

  names() {
    return Object.keys(this.zip.files)
  }

  async readText(name) {
    const entry = this.zip.files[name]
    if (!entry || entry.dir) return undefined
    const buffer = await this.readBuffer(name)
    const text = buffer.toString('utf8')
    if (text.length > MAX_XML_CHARS) {
      throw kbError('E_KB_TOO_LARGE', 'archive text entry decodes to more than ' + MAX_XML_CHARS + ' characters')
    }
    return text
  }

  async readBuffer(name) {
    const entry = this.zip.files[name]
    if (!entry || entry.dir) throw kbError('E_KB_INVALID', 'archive entry is missing: ' + name)
    const declared = declaredUncompressedSize(entry)
    if (declared !== undefined && declared > MAX_ZIP_ENTRY_UNCOMPRESSED) {
      throw kbError('E_KB_TOO_LARGE', 'archive entry declares more than ' + MAX_ZIP_ENTRY_UNCOMPRESSED + ' uncompressed bytes')
    }
    const stream = entry.nodeStream('nodebuffer')
    const chunks = []
    const self = this
    let entryBytes = 0
    await new Promise((resolvePromise, reject) => {
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      const stop = () => { if (typeof stream.destroy === 'function') stream.destroy() }
      stream.on('data', (chunk) => {
        if (settled) return
        entryBytes += chunk.length
        self.decompressedBytes += chunk.length
        if (entryBytes > MAX_ZIP_ENTRY_UNCOMPRESSED) {
          fail(kbError('E_KB_TOO_LARGE', 'archive entry expands beyond the single-entry budget'))
          stop()
          return
        }
        if (self.decompressedBytes > MAX_ZIP_TOTAL_UNCOMPRESSED) {
          fail(kbError('E_KB_TOO_LARGE', 'archive expands beyond the unzip budget'))
          stop()
          return
        }
        chunks.push(chunk)
      })
      stream.on('end', () => {
        if (settled) return
        settled = true
        resolvePromise()
      })
      stream.on('error', (error) => fail(error))
    })
    return Buffer.concat(chunks, entryBytes)
  }
}

async function loadZip(buffer) {
  let zip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch (error) {
    throw kbError('E_KB_INVALID', 'file is not a readable ZIP/OOXML archive (' + String(error?.message ?? error).slice(0, 120) + ')')
  }
  const names = Object.keys(zip.files)
  if (names.length > MAX_ZIP_ENTRIES) {
    throw kbError('E_KB_TOO_LARGE', 'archive has ' + names.length + ' entries (limit ' + MAX_ZIP_ENTRIES + ')')
  }
  let declaredTotal = 0
  for (const name of names) {
    const entry = zip.files[name]
    if (!entry || entry.dir) continue
    const declared = declaredUncompressedSize(entry) ?? 0
    if (declared > MAX_ZIP_ENTRY_UNCOMPRESSED) throw kbError('E_KB_TOO_LARGE', 'archive entry declares more than the single-entry budget')
    declaredTotal += declared
    if (declaredTotal > MAX_ZIP_TOTAL_UNCOMPRESSED) throw kbError('E_KB_TOO_LARGE', 'archive declares more than the unzip budget')
  }
  return new KbZipReader(zip)
}

function decodeXml(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function docxText(xml) {
  return decodeXml(String(xml ?? '')
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n').trim()
}

async function pptxText(reader) {
  const slides = reader.names().filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const out = []
  let index = 0
  for (const name of slides) {
    index += 1
    const xml = await reader.readText(name)
    if (!xml) continue
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]))
    if (texts.length) out.push('# slide ' + index + '\n' + texts.join('\n'))
  }
  return out.join('\n\n').trim()
}

async function xlsxText(reader) {
  const out = []
  const shared = await reader.readText('xl/sharedStrings.xml')
  if (shared) out.push(...[...shared.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1])))
  if (!out.length) {
    const sheets = reader.names().filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()
    for (const name of sheets) {
      const xml = await reader.readText(name)
      if (xml) out.push(...[...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1])))
    }
  }
  return out.filter(Boolean).join('\n').trim()
}

async function ofdText(reader) {
  const names = reader.names()
    .filter((name) => /(?:^|\/)Content\.xml$/i.test(name) || /(?:^|\/)Pages\/[^/]+\.xml$/i.test(name))
    .sort()
  const out = []
  for (const name of names) {
    const xml = await reader.readText(name)
    if (!xml) continue
    const texts = [...xml.matchAll(/<(?:ofd:)?TextCode[^>]*>([\s\S]*?)<\/(?:ofd:)?TextCode>/gi)].map((match) => decodeXml(match[1]))
    if (texts.length) out.push(texts.join('\n'))
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

/* -------------------------------------------------------------------------- */
/* PDF extraction (local pdfjs; explicit page cap)                            */
/* -------------------------------------------------------------------------- */

async function pdfText(file, { maxPdfPages = KB_MAX_PDF_PAGES } = {}) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(readFileSync(file))
  const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 })
  const doc = await task.promise
  try {
    const totalPages = doc.numPages
    const count = Math.min(totalPages, maxPdfPages)
    const pages = []
    for (let pageNo = 1; pageNo <= count; pageNo += 1) {
      const page = await doc.getPage(pageNo)
      const pageContent = await page.getTextContent()
      pages.push(pageContent.items.map((item) => item.str ?? '').join(' '))
    }
    return { text: pages.join('\n').trim(), totalPages, pages: count, truncated: totalPages > count }
  } finally {
    await task.destroy()
  }
}

/* -------------------------------------------------------------------------- */
/* EML extraction (reuses the read-only importers parser)                     */
/* -------------------------------------------------------------------------- */

function emlText(raw) {
  const parsed = parseEml(raw)
  const header = [
    parsed.subject ? 'Subject: ' + parsed.subject : '',
    parsed.from ? 'From: ' + parsed.from : '',
    parsed.date ? 'Date: ' + parsed.date : '',
  ].filter(Boolean).join('\n')
  const body = parsed.text ?? ''
  return { text: [header, body].filter(Boolean).join('\n\n').trim(), parsed }
}

/* -------------------------------------------------------------------------- */
/* chunking                                                                   */
/* -------------------------------------------------------------------------- */

/** Slice by code points: codePointSlice('abc', 0, 2) === 'ab'. */
export function codePointSlice(text, startCp, endCp) {
  const chars = Array.from(String(text ?? ''))
  return chars.slice(startCp, endCp).join('')
}

/**
 * Split extracted text into deterministic chunks.
 *
 * Rule (45 section 3.3): normalize CRLF, split on blank lines into paragraphs,
 * pack paragraphs up to targetChars, hard-split a paragraph above maxChars at
 * sentence boundaries (or a code-point boundary as the last resort), no
 * overlap. maxChunks caps one document; the caller records truncated=true.
 *
 * @param {string} text
 * @param {{targetChars?: number, maxChars?: number, maxChunks?: number}} [options]
 * @returns {{chunks: Array<{seq: number, text: string, charCount: number}>, truncated: boolean, charCount: number}}
 */
export function chunkText(text, { targetChars = 800, maxChars = 1500, maxChunks = 2000 } = {}) {
  const normalized = normalizeNewlines(text).trim()
  if (!normalized) return { chunks: [], truncated: false, charCount: 0 }
  const target = Math.max(1, Math.floor(Number(targetChars) || 800))
  const hardMax = Math.max(target, Math.floor(Number(maxChars) || 1500))
  const cap = Math.max(1, Math.floor(Number(maxChunks) || 2000))

  const pieces = []
  const paragraphs = normalized.split(/\n{2,}/)
  for (const rawParagraph of paragraphs) {
    const paragraph = rawParagraph.trim()
    if (!paragraph) continue
    if (paragraph.length <= hardMax) {
      pieces.push(paragraph)
      continue
    }
    // Long paragraph: prefer sentence boundaries, then a hard code-point cut.
    const sentences = paragraph.match(/[^\n。！？!?；;\.]+[\n。！？!?；;\.]*/gu) ?? [paragraph]
    let current = ''
    const flush = () => {
      if (current.trim()) pieces.push(current.trim())
      current = ''
    }
    for (const sentence of sentences) {
      let rest = sentence
      while (rest.length) {
        const room = hardMax - current.length
        if (rest.length <= room) {
          current += rest
          rest = ''
        } else if (room > 0) {
          const cut = codePointSlice(rest, 0, room)
          current += cut
          rest = rest.slice(cut.length)
          flush()
        } else {
          flush()
        }
      }
    }
    flush()
  }

  const chunks = []
  let current = ''
  const flushChunk = () => {
    const value = current.trim()
    if (value) chunks.push(value)
    current = ''
  }
  for (const piece of pieces) {
    if (!current) {
      current = piece
    } else if (current.length + 2 + piece.length <= target) {
      current += '\n\n' + piece
    } else {
      flushChunk()
      current = piece
    }
  }
  flushChunk()

  const kept = []
  let charCount = 0
  for (const value of chunks) {
    if (kept.length >= cap) break
    const clean = value.trim()
    if (!clean) continue
    const codePoints = [...clean].length
    kept.push({ seq: kept.length, text: clean, charCount: codePoints })
    charCount += codePoints
  }
  return { chunks: kept, truncated: chunks.length > kept.length, charCount }
}

/* -------------------------------------------------------------------------- */
/* public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Extract indexable text from one local file.
 *
 * @param {string} file caller-resolved path (never stored)
 * @param {{maxFileBytes?: number, maxTextBytes?: number, maxPdfPages?: number}} [options]
 * @returns {Promise<object>} JSON-ready extraction result (never contains the path)
 */
export async function extractForIndex(file, options = {}) {
  if (typeof file !== 'string' || !file.trim()) throw kbError('E_KB_INVALID', 'file path is required')
  const maxFileBytes = Number(options.maxFileBytes) > 0 ? Number(options.maxFileBytes) : KB_MAX_FILE_BYTES
  const maxTextBytes = Number(options.maxTextBytes) > 0 ? Number(options.maxTextBytes) : KB_MAX_TEXT_BYTES
  const maxPdfPages = Number(options.maxPdfPages) > 0 ? Number(options.maxPdfPages) : KB_MAX_PDF_PAGES
  const name = basename(file)
  const ext = extensionOf(file)
  const type = kindOfExtension(ext)
  if (!type) throw kbError('E_KB_UNSUPPORTED', 'unsupported file type: ' + (ext || '(none)'), 'index md/txt/docx/xlsx/pptx/ofd/pdf/eml files')

  let info
  try {
    info = lstatSync(file)
  } catch (error) {
    throw kbError('E_KB_READ', 'cannot read file ' + name + ' (' + String(error?.code ?? 'ENOENT') + ')', 'check that the path exists and is readable')
  }
  if (info.isSymbolicLink()) throw kbError('E_KB_INVALID', 'symbolic links are not indexed: ' + name)
  if (!info.isFile()) throw kbError('E_KB_INVALID', 'not a regular file: ' + name)
  if (info.size > maxFileBytes) {
    throw kbError('E_KB_TOO_LARGE', 'file is ' + info.size + ' bytes, above the ' + maxFileBytes + '-byte limit: ' + name)
  }

  const warnings = []
  const truncatedBy = []
  let text = ''
  let extractor = (ext || 'text').replace(/^\./, '')
  let encoding = null
  let pages
  let totalPages
  let needsOcr = false
  let truncated = false

  if (type === 'image') {
    // KB never spends CPU on OCR automatically: the user explicitly sets
    // ADVISERS_OCR_CMD for the attachment path. A scanned KB file is recorded
    // with needsOcr=1 and no chunks so the CLI can warn honestly.
    needsOcr = true
    extractor = 'image'
    warnings.push('image files are not OCR-indexed by KB; set ADVISERS_OCR_CMD and index a text/PDF source instead')
  } else if (type === 'text') {
    const buffer = readFileSync(file)
    const decoded = decodeTextBuffer(buffer)
    encoding = decoded.encoding
    extractor = 'plain'
    text = ext === '.html' || ext === '.htm' ? htmlToIndexText(decoded.text) : decoded.text
  } else if (type === 'office') {
    const reader = await loadZip(readFileSync(file))
    if (ext === '.docx') {
      extractor = 'docx'
      text = docxText(await reader.readText('word/document.xml') ?? '')
    } else if (ext === '.pptx') {
      extractor = 'pptx'
      text = await pptxText(reader)
    } else {
      extractor = 'xlsx'
      text = await xlsxText(reader)
    }
    if (!text) throw kbError('E_KB_EMPTY', 'no extractable text in ' + name)
  } else if (type === 'ofd') {
    extractor = 'ofd'
    const reader = await loadZip(readFileSync(file))
    text = await ofdText(reader)
    if (!text) {
      needsOcr = true
      warnings.push('OFD has no text layer (image-only); not indexed')
    }
  } else if (type === 'pdf') {
    extractor = 'pdf'
    const result = await pdfText(file, { maxPdfPages })
    text = result.text
    pages = result.pages
    totalPages = result.totalPages
    if (result.truncated) {
      truncated = true
      truncatedBy.push('pdf_pages')
      warnings.push('PDF has ' + result.totalPages + ' pages; only the first ' + result.pages + ' were indexed')
    }
    if (!text) {
      needsOcr = true
      warnings.push('PDF has no extractable text layer (scanned?); not indexed')
    }
  } else if (type === 'eml') {
    extractor = 'eml'
    const raw = readFileSync(file).toString('utf8')
    const result = emlText(raw)
    text = result.text
    encoding = 'utf-8'
    for (const warning of result.parsed?.warnings ?? []) warnings.push(String(warning).slice(0, 200))
    if (!text) throw kbError('E_KB_EMPTY', 'no readable text in ' + name)
  }

  text = normalizeNewlines(text).trim()
  if (!needsOcr && !text && type !== 'image') throw kbError('E_KB_EMPTY', 'no extractable text in ' + name)

  const limited = truncateUtf8(text, maxTextBytes)
  text = limited.text
  if (limited.truncated) {
    truncated = true
    truncatedBy.push('text_bytes')
    warnings.push('extracted text exceeded ' + maxTextBytes + ' bytes; only the prefix was indexed')
  }

  return {
    text,
    extractor,
    encoding,
    mime: mimeForFile(file),
    sizeBytes: info.size,
    sourceName: name,
    ...(pages === undefined ? {} : { pages }),
    ...(totalPages === undefined ? {} : { totalPages }),
    truncated,
    truncatedBy,
    needsOcr,
    warnings,
    charCount: [...text].length,
    textBytes: byteLength(text),
  }
}

export default Object.freeze({
  KB_MAX_FILE_BYTES,
  KB_MAX_TEXT_BYTES,
  KB_MAX_PDF_PAGES,
  KB_EXTRACTOR_VERSION,
  isIndexableFile,
  mimeForFile,
  extensionOf,
  decodeTextBuffer,
  truncateUtf8,
  normalizeNewlines,
  htmlToIndexText,
  chunkText,
  codePointSlice,
  extractForIndex,
})
