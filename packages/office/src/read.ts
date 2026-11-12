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

async function readDocxZip(zip: JSZip): Promise<ReadDocx> {
  const document = await zip.files['word/document.xml']?.async('string')
  if (!document) throw new Error('docx is missing word/document.xml')
  const blocks: ReadDocx['blocks'] = []
  const body = document.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? document
  const parts = [...body.matchAll(/<w:(p|tbl)(?:\s[^>]*)?>[\s\S]*?<\/w:\1>/g)]
  for (const part of parts) {
    if (part[1] === 'tbl') { blocks.push({ type: 'table', table: { rows: tableRows(part[0]) } }); continue }
    const style = part[0].match(/<w:pStyle[^>]*w:val="([^"]+)"/)?.[1]
    blocks.push({ type: 'paragraph', paragraph: { text: xmlText(part[0]), style } })
  }
  const headers = await Promise.all(Object.keys(zip.files).filter((n) => /^word\/header\d+\.xml$/.test(n)).map(async (n) => xmlText(await zip.files[n].async('string'))))
  const footers = await Promise.all(Object.keys(zip.files).filter((n) => /^word\/footer\d+\.xml$/.test(n)).map(async (n) => xmlText(await zip.files[n].async('string'))))
  const text = [...headers, ...footers, ...blocks.map((b) => b.type === 'paragraph' ? b.paragraph.text : b.table.rows.map((r) => r.join(' | ')).join('\n'))].filter(Boolean).join('\n')
  return { kind: 'docx', blocks, headers, footers, text, warnings: [] }
}

async function readXlsxZip(buffer: Buffer): Promise<ReadXlsx> {
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
  const text = sheets.map((s) => [`[${s.name}]`, ...s.rows.map((r) => r.join('\t'))].join('\n')).join('\n\n')
  return { kind: 'xlsx', sheets, text, warnings: [] }
}

async function readPptxZip(zip: JSZip): Promise<ReadPptx> {
  const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1]) - Number(b.match(/(\d+)\.xml$/)?.[1]))
  const slides: ReadSlide[] = []
  for (const [i, name] of slideNames.entries()) {
    const xml = await zip.files[name].async('string')
    const paragraphs = [...xml.matchAll(/<a:p[\s>][\s\S]*?<\/a:p>/g)].map((p) => xmlText(p[0]).trim()).filter(Boolean)
    const notesName = name.replace('slides/slide', 'notesSlides/notesSlide')
    const notes = zip.files[notesName] ? [...(await zip.files[notesName].async('string')).matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlText(m[1]).trim()).filter(Boolean) : []
    slides.push({ index: i + 1, title: paragraphs[0] ?? '', paragraphs, notes })
  }
  const text = slides.map((s) => [`[[slide${s.index}]] ${s.title}`, ...s.paragraphs.slice(1), ...(s.notes.length ? [`notes: ${s.notes.join(' ')}`] : [])].join('\n')).join('\n\n')
  return { kind: 'pptx', slides, text, warnings: [] }
}

export async function readOffice(input: Buffer | string, kind?: OfficeReadKind): Promise<OfficeRead> {
  const buffer = typeof input === 'string' ? Buffer.from(await import('node:fs/promises').then((fs) => fs.readFile(input))) : input
  if (buffer.length > 20 * 1024 * 1024) throw new Error('Office file exceeds 20MB read limit')
  const zip = await JSZip.loadAsync(buffer)
  const entries = Object.keys(zip.files)
  if (entries.length > 2000) throw new Error('too many ZIP entries')
  if (entries.some((n) => n.includes('..') || n.startsWith('/'))) throw new Error('unsafe ZIP entry')
  const resolved = kind ?? (zip.files['word/document.xml'] ? 'docx' : zip.files['xl/workbook.xml'] ? 'xlsx' : zip.files['ppt/presentation.xml'] ? 'pptx' : undefined)
  if (!resolved) throw new Error('not a supported Office file')
  if (resolved === 'docx') return readDocxZip(zip)
  if (resolved === 'xlsx') return readXlsxZip(buffer)
  return readPptxZip(zip)
}

export function officeToText(doc: OfficeRead, limit = 20_000): string {
  const text = doc.text
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`
}
