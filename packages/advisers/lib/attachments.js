import { readFile, stat } from 'node:fs/promises'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import JSZip from 'jszip'
import { runLocalOcr, ocrConfigured } from './ocr.js'

const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_CHARS = 20_000
// ZIP extraction budget: keep the same limits as advisers-office read.ts
// (DEFAULT_ZIP_BUDGET) so an attachment is rejected, not decompressed, when a
// malicious docx/xlsx/pptx/ofd would expand past them.
const MAX_ZIP_ENTRIES = 2000
const MAX_TOTAL_UNCOMPRESSED = 64 * 1024 * 1024
const MAX_ENTRY_UNCOMPRESSED = 16 * 1024 * 1024
const MAX_TEXT_CHARS = 8 * 1024 * 1024
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yaml', '.yml', '.xml', '.html'])
const OFFICE_EXT = new Set(['.docx', '.xlsx', '.pptx'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'])

function safePath(cwd, input) {
  const root = realpathSync(cwd)
  const abs = resolve(root, input)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`attachment escapes workspace: ${input}`)
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = resolve(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`attachment symlink is not allowed: ${part}`)
  }
  return abs
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function truncate(text) {
  if (text.length <= MAX_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_CHARS), truncated: true }
}

/** Declared uncompressed size from the ZIP central directory (never byte 0). */
function declaredUncompressedSize(entry) {
  const size = entry?._data?.uncompressedSize
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : undefined
}

/**
 * Bounded reader over one ZIP archive. Every entry is decompressed as a capped
 * stream, so a lying central directory cannot inflate past the budget, and the
 * cumulative decompressed bytes stay inside the total budget.
 */
class ZipBudgetReader {
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
    if (text.length > MAX_TEXT_CHARS) {
      throw new Error(`attachment text entry too large: ${name} decodes to ${text.length} characters (limit ${MAX_TEXT_CHARS})`)
    }
    return text
  }

  async readBuffer(name) {
    const entry = this.zip.files[name]
    if (!entry || entry.dir) throw new Error(`attachment ZIP entry is missing: ${name}`)
    const declared = declaredUncompressedSize(entry)
    if (declared !== undefined && declared > MAX_ENTRY_UNCOMPRESSED) {
      throw new Error(`attachment entry too large: ${name} declares ${declared} uncompressed bytes (limit ${MAX_ENTRY_UNCOMPRESSED})`)
    }
    const stream = entry.nodeStream('nodebuffer')
    const chunks = []
    const self = this
    let entryBytes = 0
    await new Promise((resolve, reject) => {
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      const stop = () => {
        if (typeof stream.destroy === 'function') stream.destroy()
      }
      stream.on('data', (chunk) => {
        if (settled) return
        entryBytes += chunk.length
        self.decompressedBytes += chunk.length
        if (entryBytes > MAX_ENTRY_UNCOMPRESSED) {
          fail(new Error(`attachment entry expands beyond the single-entry budget: ${name} exceeds ${MAX_ENTRY_UNCOMPRESSED} uncompressed bytes`))
          stop()
          return
        }
        if (self.decompressedBytes > MAX_TOTAL_UNCOMPRESSED) {
          fail(new Error(`attachment archive expands beyond the unzip budget: more than ${MAX_TOTAL_UNCOMPRESSED} uncompressed bytes`))
          stop()
          return
        }
        chunks.push(chunk)
      })
      stream.on('end', () => {
        if (settled) return
        settled = true
        resolve()
      })
      stream.on('error', (error) => fail(error))
    })
    return Buffer.concat(chunks, entryBytes)
  }
}

/** Reject an archive before any entry is decompressed. */
async function loadZip(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const names = Object.keys(zip.files)
  if (names.length > MAX_ZIP_ENTRIES) {
    throw new Error(`attachment archive has too many ZIP entries: ${names.length} (limit ${MAX_ZIP_ENTRIES})`)
  }
  let declaredTotal = 0
  for (const name of names) {
    const entry = zip.files[name]
    if (!entry || entry.dir) continue
    const declared = declaredUncompressedSize(entry) ?? 0
    if (declared > MAX_ENTRY_UNCOMPRESSED) {
      throw new Error(`attachment entry too large: ${name} declares ${declared} uncompressed bytes (limit ${MAX_ENTRY_UNCOMPRESSED})`)
    }
    declaredTotal += declared
    if (declaredTotal > MAX_TOTAL_UNCOMPRESSED) {
      throw new Error(`attachment archive expands beyond the unzip budget: declares ${declaredTotal} uncompressed bytes (limit ${MAX_TOTAL_UNCOMPRESSED})`)
    }
  }
  return new ZipBudgetReader(zip)
}

function docxText(xml) {
  return decodeXml(xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n').trim()
}

async function pptxText(reader) {
  const slides = reader.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const out = []
  for (const name of slides) {
    const xml = await reader.readText(name)
    if (!xml) continue
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]))
    if (texts.length) out.push(`# ${name.split('/').pop()}\n${texts.join('\n')}`)
  }
  return out.join('\n\n').trim()
}

export async function ofdText(buffer) {
  const reader = await loadZip(buffer)
  const names = reader.names().filter((n) => /(?:^|\/)Content\.xml$/i.test(n) || /(?:^|\/)Pages\/[^/]+\.xml$/i.test(n)).sort()
  const out = []
  for (const name of names) {
    const xml = await reader.readText(name)
    if (!xml) continue
    const texts = [...xml.matchAll(/<(?:ofd:)?TextCode[^>]*>([\s\S]*?)<\/(?:ofd:)?TextCode>/gi)].map((m) => decodeXml(m[1]))
    if (texts.length) out.push(texts.join('\n'))
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

async function pdfText(path) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(path))
  const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 })
  const doc = await task.promise
  try {
    const pages = []
    const count = Math.min(doc.numPages, 50)
    for (let pageNo = 1; pageNo <= count; pageNo++) {
      const page = await doc.getPage(pageNo)
      const content = await page.getTextContent()
      pages.push(content.items.map((item) => item.str ?? '').join(' '))
    }
    return pages.join('\n').trim()
  } finally {
    await task.destroy()
  }
}

async function xlsxText(reader) {
  const out = []
  const shared = await reader.readText('xl/sharedStrings.xml')
  if (shared) out.push(...[...shared.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])))
  if (!out.length) {
    for (const name of reader.names().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
      const xml = await reader.readText(name)
      if (xml) out.push(...[...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])))
    }
  }
  return out.filter(Boolean).join('\n').trim()
}

export async function extractAttachment(input, { cwd = process.cwd() } = {}) {
  const path = safePath(cwd, input)
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`not a file: ${input}`)
  if (info.size > MAX_FILE_BYTES) throw new Error(`attachment is larger than 10 MB: ${input}`)
  const ext = extname(path).toLowerCase()
  const name = path.split('/').pop()
  if (TEXT_EXT.has(ext)) {
    const raw = await readFile(path, 'utf8')
    const { text, truncated } = truncate(raw)
    return { name, path, kind: ext.slice(1), text, truncated, bytes: info.size }
  }
  if (OFFICE_EXT.has(ext)) {
    const reader = await loadZip(await readFile(path))
    const raw = ext === '.docx'
      ? docxText(await reader.readText('word/document.xml') ?? '')
      : ext === '.pptx'
        ? await pptxText(reader)
        : await xlsxText(reader)
    const { text, truncated } = truncate(raw)
    if (!text) throw new Error(`no extractable text in ${name}`)
    return { name, path, kind: ext.slice(1), text, truncated, bytes: info.size }
  }
  if (ext === '.ofd') {
    const raw = await ofdText(await readFile(path))
    const { text, truncated } = truncate(raw)
    if (!text) throw new Error(`no extractable text in ${name} (OFD image-only?)`)
    return { name, path, kind: 'ofd', text, truncated, bytes: info.size }
  }
  if (IMAGE_EXT.has(ext)) {
    if (!ocrConfigured()) throw new Error(`image OCR is not configured; set ADVISERS_OCR_CMD to a local OCR executable (${name})`)
    const raw = await runLocalOcr(path, { cwd })
    const { text, truncated } = truncate(raw)
    return { name, path, kind: 'ocr', text, truncated, bytes: info.size }
  }
  if (ext === '.pdf') {
    const raw = await pdfText(path)
    const { text, truncated } = truncate(raw)
    if (!text) throw new Error(`no extractable text in ${name} (scanned PDF?)`)
    return { name, path, kind: 'pdf', text, truncated, bytes: info.size }
  }
  throw new Error(`unsupported attachment type: ${ext || '(none)'}`)
}
