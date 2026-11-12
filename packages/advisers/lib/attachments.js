import { readFile, stat } from 'node:fs/promises'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import JSZip from 'jszip'

const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_UNZIP_BYTES = 20 * 1024 * 1024
const MAX_CHARS = 20_000
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yaml', '.yml', '.xml', '.html'])
const OFFICE_EXT = new Set(['.docx', '.xlsx', '.pptx'])

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

async function loadZip(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  let total = 0
  for (const file of Object.values(zip.files)) {
    const size = file?._data?.uncompressedSize ?? 0
    total += size
    if (total > MAX_UNZIP_BYTES) throw new Error('attachment expands beyond 20 MB')
  }
  return zip
}

function docxText(xml) {
  return decodeXml(xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n').trim()
}

async function pptxText(zip) {
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const out = []
  for (const name of slides) {
    const xml = await zip.file(name)?.async('string')
    if (!xml) continue
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]))
    if (texts.length) out.push(`# ${name.split('/').pop()}\n${texts.join('\n')}`)
  }
  return out.join('\n\n').trim()
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

async function xlsxText(zip) {
  const shared = await zip.file('xl/sharedStrings.xml')?.async('string')
  const out = []
  if (shared) out.push(...[...shared.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])))
  if (!out.length) {
    for (const name of Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
      const xml = await zip.file(name)?.async('string')
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
    const zip = await loadZip(await readFile(path))
    const raw = ext === '.docx'
      ? docxText(await zip.file('word/document.xml')?.async('string') ?? '')
      : ext === '.pptx'
        ? await pptxText(zip)
        : await xlsxText(zip)
    const { text, truncated } = truncate(raw)
    if (!text) throw new Error(`no extractable text in ${name}`)
    return { name, path, kind: ext.slice(1), text, truncated, bytes: info.size }
  }
  if (ext === '.pdf') {
    const raw = await pdfText(path)
    const { text, truncated } = truncate(raw)
    if (!text) throw new Error(`no extractable text in ${name} (scanned PDF?)`)
    return { name, path, kind: 'pdf', text, truncated, bytes: info.size }
  }
  throw new Error(`unsupported attachment type: ${ext || '(none)'}`)
}
