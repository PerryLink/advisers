import JSZip from 'jszip'
import ExcelJS from 'exceljs'

export type OfficeReadKind = 'docx' | 'xlsx' | 'pptx'

export interface ReadParagraph { text: string; style?: string }
export interface ReadTable { rows: string[][] }
export interface ReadDocx {
  kind: 'docx'
  blocks: Array<{ type: 'paragraph'; paragraph: ReadParagraph } | { type: 'table'; table: ReadTable }>
  headers: string[]
  footers: string[]
  text: string
  warnings: string[]
}
export interface ReadSheet {
  name: string
  rows: string[][]
  formulas: Array<{ cell: string; formula: string; result?: string }>
}
export interface ReadXlsx { kind: 'xlsx'; sheets: ReadSheet[]; text: string; warnings: string[] }
export interface ReadSlide { index: number; title: string; paragraphs: string[]; notes: string[] }
export interface ReadPptx { kind: 'pptx'; slides: ReadSlide[]; text: string; warnings: string[] }
export type OfficeRead = ReadDocx | ReadXlsx | ReadPptx

/**
 * Extraction budget for untrusted Office/OFD archives (security audit P1-6).
 * The compressed input size is capped at 20 MB by the readers; these limits
 * bound what the archive may expand to, so a malicious docx/xlsx/pptx is
 * rejected instead of exhausting memory.
 */
export interface ZipBudget {
  /** Maximum number of ZIP entries (files + folders). */
  maxEntries: number
  /** Maximum total uncompressed bytes across all entries. */
  maxTotalUncompressed: number
  /** Maximum uncompressed bytes for a single entry. */
  maxEntryUncompressed: number
  /** Maximum characters decoded from a single XML/text entry. */
  maxTextChars: number
}

export const DEFAULT_ZIP_BUDGET: ZipBudget = {
  maxEntries: 2000,
  maxTotalUncompressed: 64 * 1024 * 1024,
  maxEntryUncompressed: 16 * 1024 * 1024,
  maxTextChars: 8 * 1024 * 1024,
}

export type ZipBudgetLimit = 'entries' | 'entry' | 'total' | 'text' | 'paths'

/** Thrown when an archive would expand beyond the extraction budget. */
export class ZipBudgetError extends Error {
  readonly code = 'ZIP_BUDGET_EXCEEDED'
  readonly limit: ZipBudgetLimit
  readonly entry?: string

  constructor(limit: ZipBudgetLimit, message: string, entry?: string) {
    super(message)
    this.name = 'ZipBudgetError'
    this.limit = limit
    if (entry !== undefined) this.entry = entry
  }
}

export interface ZipBudgetReport {
  budget: ZipBudget
  /** All ZIP entries, including folders. */
  entries: number
  /** Non-folder entries. */
  files: number
  /** Sum of the uncompressed sizes declared in the ZIP central directory. */
  totalUncompressedBytes: number
  oversizedEntries: string[]
  unsafeEntries: string[]
  tooManyEntries: boolean
  overTotalBudget: boolean
}

export function resolveZipBudget(overrides: Partial<ZipBudget> = {}): ZipBudget {
  const budget: ZipBudget = {
    maxEntries: overrides.maxEntries ?? DEFAULT_ZIP_BUDGET.maxEntries,
    maxTotalUncompressed: overrides.maxTotalUncompressed ?? DEFAULT_ZIP_BUDGET.maxTotalUncompressed,
    maxEntryUncompressed: overrides.maxEntryUncompressed ?? DEFAULT_ZIP_BUDGET.maxEntryUncompressed,
    maxTextChars: overrides.maxTextChars ?? DEFAULT_ZIP_BUDGET.maxTextChars,
  }
  const keys = ['maxEntries', 'maxTotalUncompressed', 'maxEntryUncompressed', 'maxTextChars'] as const
  for (const key of keys) {
    const value = budget[key]
    if (!Number.isFinite(value) || value < 0) throw new Error('invalid ZIP budget ' + key + ': ' + String(value))
  }
  return budget
}

function declaredUncompressedSize(entry: unknown): number | undefined {
  // JSZip keeps the central-directory sizes on the private _data object.
  const size = (entry as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : undefined
}

function unsafeZipEntryName(name: string): boolean {
  return name.includes('..') || name.startsWith('/') || name.startsWith('\\')
}

/** Cheap, metadata-only budget inspection. Never decompresses entry contents. */
export function inspectZipBudget(zip: JSZip, overrides: Partial<ZipBudget> = {}): ZipBudgetReport {
  const budget = resolveZipBudget(overrides)
  const names = Object.keys(zip.files)
  const oversizedEntries: string[] = []
  const unsafeEntries: string[] = []
  let files = 0
  let totalUncompressedBytes = 0
  for (const name of names) {
    if (unsafeZipEntryName(name)) unsafeEntries.push(name)
    const entry = zip.files[name]
    if (!entry || entry.dir) continue
    files += 1
    const size = declaredUncompressedSize(entry) ?? 0
    totalUncompressedBytes += size
    if (size > budget.maxEntryUncompressed) oversizedEntries.push(name)
  }
  return {
    budget,
    entries: names.length,
    files,
    totalUncompressedBytes,
    oversizedEntries,
    unsafeEntries,
    tooManyEntries: names.length > budget.maxEntries,
    overTotalBudget: totalUncompressedBytes > budget.maxTotalUncompressed,
  }
}

/** Reject an archive before any of its entries are decompressed. */
export function assertZipBudget(zip: JSZip, overrides: Partial<ZipBudget> = {}): ZipBudgetReport {
  const report = inspectZipBudget(zip, overrides)
  const budget = report.budget
  if (report.tooManyEntries) throw new ZipBudgetError('entries', 'too many ZIP entries: ' + report.entries + ' (limit ' + budget.maxEntries + ')')
  if (report.unsafeEntries.length) throw new ZipBudgetError('paths', 'unsafe ZIP entry: ' + report.unsafeEntries[0], report.unsafeEntries[0])
  if (report.oversizedEntries.length) {
    throw new ZipBudgetError('entry', 'ZIP entry too large: ' + report.oversizedEntries[0] + ' exceeds ' + budget.maxEntryUncompressed + ' uncompressed bytes', report.oversizedEntries[0])
  }
  if (report.overTotalBudget) {
    throw new ZipBudgetError('total', 'ZIP archive expands to ' + report.totalUncompressedBytes + ' bytes (limit ' + budget.maxTotalUncompressed + ')')
  }
  return report
}

async function readZipEntryCapped(zip: JSZip, name: string, budget: ZipBudget): Promise<Buffer> {
  const entry = zip.files[name]
  if (!entry || entry.dir) throw new Error('ZIP entry is missing: ' + name)
  const declared = declaredUncompressedSize(entry)
  if (declared !== undefined && declared > budget.maxEntryUncompressed) {
    throw new ZipBudgetError('entry', 'ZIP entry too large: ' + name + ' declares ' + declared + ' uncompressed bytes (limit ' + budget.maxEntryUncompressed + ')', name)
  }
  const stream = entry.nodeStream('nodebuffer')
  const chunks: Buffer[] = []
  let total = 0
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    stream.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > budget.maxEntryUncompressed) {
        fail(new ZipBudgetError('entry', 'ZIP entry expands beyond the single-entry budget: ' + name + ' exceeds ' + budget.maxEntryUncompressed + ' uncompressed bytes', name))
        const destroy = (stream as unknown as { destroy?: () => void }).destroy
        if (typeof destroy === 'function') destroy.call(stream)
        return
      }
      chunks.push(chunk)
    })
    stream.on('end', () => {
      if (settled) return
      settled = true
      resolve()
    })
    stream.on('error', (error: Error) => fail(error))
  })
  return Buffer.concat(chunks, total)
}

/**
 * Read one ZIP entry as text while enforcing the single-entry byte budget and
 * the decoded-character budget. The entry is decompressed as a capped stream,
 * so a lying central directory cannot inflate past the budget.
 */
export async function readZipEntryText(zip: JSZip, name: string, overrides: Partial<ZipBudget> = {}): Promise<string> {
  const budget = resolveZipBudget(overrides)
  const buffer = await readZipEntryCapped(zip, name, budget)
  const text = buffer.toString('utf8')
  if (text.length > budget.maxTextChars) {
    throw new ZipBudgetError('text', 'ZIP text entry too large: ' + name + ' decodes to ' + text.length + ' characters (limit ' + budget.maxTextChars + ')', name)
  }
  return text
}

const XML_NS = /<\/?[A-Za-z_][\w:.-]*(?:\s[^>]*?)?\/?>/g

export function decodeXmlText(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function stripTags(xml: string): string {
  return decodeXmlText(xml.replace(XML_NS, '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function xmlText(xml: string): string {
  return [...xml.matchAll(/<(?:w|a):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w|a):t>/g)].map((m) => decodeXmlText(m[1])).join('')
}

function tableRows(xml: string): string[][] {
  return [...xml.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)].map((tr) => [...tr[0].matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)].map((tc) => xmlText(tc[0]).trim()))
}

async function readDocxZip(zip: JSZip, budget: ZipBudget): Promise<ReadDocx> {
  const document = zip.files['word/document.xml'] ? await readZipEntryText(zip, 'word/document.xml', budget) : undefined
  if (!document) throw new Error('docx is missing word/document.xml')
  const blocks: ReadDocx['blocks'] = []
  const body = document.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? document
  const parts = [...body.matchAll(/<w:(p|tbl)(?:\s[^>]*)?>[\s\S]*?<\/w:\1>/g)]
  for (const part of parts) {
    if (part[1] === 'tbl') { blocks.push({ type: 'table', table: { rows: tableRows(part[0]) } }); continue }
    const style = part[0].match(/<w:pStyle[^>]*w:val="([^"]+)"/)?.[1]
    blocks.push({ type: 'paragraph', paragraph: { text: xmlText(part[0]), style } })
  }
  const headerNames = Object.keys(zip.files).filter((n) => /^word\/header\d+\.xml$/.test(n))
  const footerNames = Object.keys(zip.files).filter((n) => /^word\/footer\d+\.xml$/.test(n))
  const headers = await Promise.all(headerNames.map(async (n) => xmlText(await readZipEntryText(zip, n, budget))))
  const footers = await Promise.all(footerNames.map(async (n) => xmlText(await readZipEntryText(zip, n, budget))))
  const text = [...headers, ...footers, ...blocks.map((b) => b.type === 'paragraph' ? b.paragraph.text : b.table.rows.map((r) => r.join(' | ')).join('\n'))].filter(Boolean).join('\n')
  return { kind: 'docx', blocks, headers, footers, text, warnings: [] }
}

async function readXlsxZip(buffer: Buffer): Promise<ReadXlsx> {
  // The ZIP budget was asserted in readOffice() before ExcelJS parses the
  // central directory; ExcelJS works from the same buffer afterwards.
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as never)
  const sheets: ReadSheet[] = []
  for (const sheet of workbook.worksheets) {
    const rows: string[][] = []
    const formulas: ReadSheet['formulas'] = []
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values: string[] = []
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        while (values.length < col - 1) values.push('')
        const any = cell as unknown as { formula?: string; result?: unknown }
        if (any.formula) formulas.push({ cell: cell.address, formula: any.formula, result: any.result == null ? undefined : String(any.result) })
        const value = cell.value
        if (value && typeof value === 'object' && 'formula' in (value as object)) values.push(String((value as { result?: unknown }).result ?? ''))
        else values.push(cell.text ?? '')
      })
      rows.push(values)
    })
    sheets.push({ name: sheet.name, rows, formulas })
  }
  const text = sheets.map((s) => ['[' + s.name + ']', ...s.rows.map((r) => r.join('\t'))].join('\n')).join('\n\n')
  return { kind: 'xlsx', sheets, text, warnings: [] }
}

async function readPptxZip(zip: JSZip, budget: ZipBudget): Promise<ReadPptx> {
  const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1]) - Number(b.match(/(\d+)\.xml$/)?.[1]))
  const slides: ReadSlide[] = []
  for (const [i, name] of slideNames.entries()) {
    const xml = await readZipEntryText(zip, name, budget)
    const paragraphs = [...xml.matchAll(/<a:p[\s>][\s\S]*?<\/a:p>/g)].map((p) => xmlText(p[0]).trim()).filter(Boolean)
    const notesName = name.replace('slides/slide', 'notesSlides/notesSlide')
    const notes = zip.files[notesName] ? [...(await readZipEntryText(zip, notesName, budget)).matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlText(m[1]).trim()).filter(Boolean) : []
    slides.push({ index: i + 1, title: paragraphs[0] ?? '', paragraphs, notes })
  }
  const text = slides.map((s) => ['[[slide' + s.index + ']] ' + s.title, ...s.paragraphs.slice(1), ...(s.notes.length ? ['notes: ' + s.notes.join(' ')] : [])].join('\n')).join('\n\n')
  return { kind: 'pptx', slides, text, warnings: [] }
}

export interface ReadOfficeOptions {
  /** Override the default ZIP extraction budgets. */
  budget?: Partial<ZipBudget>
}

export async function readOffice(input: Buffer | string, kind?: OfficeReadKind, options: ReadOfficeOptions = {}): Promise<OfficeRead> {
  const buffer = typeof input === 'string' ? Buffer.from(await import('node:fs/promises').then((fs) => fs.readFile(input))) : input
  if (buffer.length > 20 * 1024 * 1024) throw new Error('Office file exceeds 20MB read limit')
  const zip = await JSZip.loadAsync(buffer)
  const report = assertZipBudget(zip, options.budget)
  const resolved = kind ?? (zip.files['word/document.xml'] ? 'docx' : zip.files['xl/workbook.xml'] ? 'xlsx' : zip.files['ppt/presentation.xml'] ? 'pptx' : undefined)
  if (!resolved) throw new Error('not a supported Office file')
  if (resolved === 'docx') return readDocxZip(zip, report.budget)
  if (resolved === 'xlsx') return readXlsxZip(buffer)
  return readPptxZip(zip, report.budget)
}

export interface ReadOfdOptions {
  /** Override the default ZIP extraction budgets. */
  budget?: Partial<ZipBudget>
}

/**
 * Extract text from an OFD (GB/T 33190-2016) package. OFD is a ZIP of XML
 * parts, so it goes through the same extraction budget as Office files.
 */
export async function readOfdText(input: Buffer | string, options: ReadOfdOptions = {}): Promise<string> {
  const buffer = typeof input === 'string' ? Buffer.from(await import('node:fs/promises').then((fs) => fs.readFile(input))) : input
  if (buffer.length > 20 * 1024 * 1024) throw new Error('OFD file exceeds 20MB read limit')
  const zip = await JSZip.loadAsync(buffer)
  const report = assertZipBudget(zip, options.budget)
  const names = Object.keys(zip.files).filter((n) => /(?:^|\/)Content\.xml$/i.test(n) || /(?:^|\/)Pages\/[^/]+\.xml$/i.test(n)).sort()
  const parts: string[] = []
  for (const name of names) {
    const xml = await readZipEntryText(zip, name, report.budget)
    const texts = [...xml.matchAll(/<(?:ofd:)?TextCode[^>]*>([\s\S]*?)<\/(?:ofd:)?TextCode>/gi)].map((m) => decodeXmlText(m[1]))
    if (texts.length) parts.push(texts.join('\n'))
  }
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function officeToText(doc: OfficeRead, limit = 20_000): string {
  const text = doc.text
  return text.length <= limit ? text : text.slice(0, limit) + '\n[truncated]'
}
