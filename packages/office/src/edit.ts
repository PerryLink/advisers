import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { verifyOffice } from './verify.ts'

export type OfficeEditKind = 'docx' | 'xlsx' | 'pptx'

export type EditOp =
  | { op: 'docx.setText'; block: number; text: string }
  | { op: 'docx.setTable'; block: number; rows: string[][] }
  | { op: 'xlsx.setCell'; sheet: string; ref: string; value: string | number | boolean | null }
  | { op: 'pptx.setText'; slide: number; text: string }

export interface EditResult {
  ok: boolean
  buffer: Buffer
  kind: OfficeEditKind
  changes: string[]
  error?: string
}

function escapeXml(text: string): string {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new Error('control characters are not allowed')
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

interface BodyBlock { type: 'p' | 'tbl'; start: number; end: number; inner: string }

/** Top-level body blocks in the same order as readOffice (paragraphs and tables only). */
function bodyBlocks(xml: string): BodyBlock[] {
  const bodyStart = xml.indexOf('<w:body>')
  if (bodyStart < 0) return []
  const start = bodyStart + '<w:body>'.length
  const end = xml.lastIndexOf('</w:body>')
  if (end < 0) return []
  const body = xml.slice(start, end)
  const blocks: BodyBlock[] = []
  const re = /<(w:p|w:tbl)(?:\s[^>]*)?>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body))) {
    const tag = match[1]
    const openStart = match.index
    const openEnd = openStart + match[0].length
    const selfClosing = match[0].endsWith('/>')
    if (selfClosing) {
      if (tag === 'w:p') blocks.push({ type: 'p', start: start + openStart, end: start + openEnd, inner: match[0] })
      continue
    }
    const reClose = new RegExp(`</${tag}>`, 'g')
    reClose.lastIndex = openEnd
    const close = reClose.exec(body)
    if (!close) break
    const blockEnd = close.index + close[0].length
    blocks.push({ type: tag === 'w:tbl' ? 'tbl' : 'p', start: start + openStart, end: start + blockEnd, inner: body.slice(openStart, blockEnd) })
    re.lastIndex = blockEnd
  }
  return blocks
}

function replaceDocxParagraph(xml: string, block: number, text: string): { xml: string; before: string } {
  const target = bodyBlocks(xml)[block]
  if (!target || target.type !== 'p') throw new Error(`paragraph block not found: ${block}`)
  const pPr = target.inner.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? ''
  const before = target.inner.replace(/<[^>]+>/g, '').slice(0, 120)
  const paragraph = `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
  return { xml: xml.slice(0, target.start) + paragraph + xml.slice(target.end), before }
}

function replaceTable(xml: string, block: number, rows: string[][]): { xml: string; before: string } {
  const target = bodyBlocks(xml)[block]
  if (!target || target.type !== 'tbl') throw new Error(`table block not found: ${block}`)
  const firstRow = target.inner.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/)?.[0] ?? ''
  const firstCell = firstRow.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/)?.[0] ?? '<w:tc><w:p></w:p></w:tc>'
  const tcPr = firstCell.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/)?.[0] ?? ''
  const body = rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${tcPr}<w:p><w:r><w:t xml:space="preserve">${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')
  const table = `<w:tbl>${target.inner.match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/)?.[0] ?? ''}${target.inner.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/)?.[0] ?? ''}${body}</w:tbl>`
  return { xml: xml.slice(0, target.start) + table + xml.slice(target.end), before: 'table' }
}

export async function editOffice(input: Buffer, kind: OfficeEditKind, ops: EditOp[]): Promise<EditResult> {
  const original = Buffer.from(input)
  try {
    if (!Array.isArray(ops) || ops.length === 0) throw new Error('ops must not be empty')
    if (kind === 'xlsx') {
      const pre = await JSZip.loadAsync(original)
      if (Object.keys(pre.files).some((n) => /^xl\/(charts|drawings|media)\//.test(n))) throw new Error('xlsx with charts/drawings/media is read-only (edit would drop parts)')
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(original as never)
      for (const op of ops) {
        if (op.op !== 'xlsx.setCell') throw new Error(`unsupported xlsx op: ${op.op}`)
        const sheet = workbook.getWorksheet(op.sheet)
        if (!sheet) throw new Error(`sheet not found: ${op.sheet}`)
        if (typeof op.value === 'string' && op.value.startsWith('=')) throw new Error('use xlsx.setFormula for formulas')
        sheet.getCell(op.ref).value = op.value
      }
      const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
      const verify = await verifyOffice(buffer, 'xlsx')
      if (!verify.ok) throw new Error(`edited xlsx failed verification: ${verify.missing.join('; ')}`)
      return { ok: true, buffer, kind, changes: ops.map((op) => JSON.stringify(op)) }
    }
    const zip = await JSZip.loadAsync(original)
    const changes: string[] = []
    if (kind === 'docx') {
      const file = zip.files['word/document.xml']
      if (!file) throw new Error('docx is missing word/document.xml')
      let xml = await file.async('string')
      let tableOps = 0
      for (const op of ops) {
        if (op.op === 'docx.setText') {
          const result = replaceDocxParagraph(xml, op.block, op.text)
          xml = result.xml
          changes.push(`p${op.block}: ${result.before} -> ${op.text}`)
        } else if (op.op === 'docx.setTable') {
          const result = replaceTable(xml, op.block, op.rows)
          xml = result.xml
          tableOps++
          changes.push(`tbl${op.block}: ${tableOps} rows`)
        } else throw new Error(`unsupported docx op: ${op.op}`)
      }
      zip.file('word/document.xml', xml)
    } else {
      const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort()
      for (const op of ops) {
        if (op.op !== 'pptx.setText') throw new Error(`unsupported pptx op: ${op.op}`)
        const name = slideNames[op.slide - 1]
        if (!name) throw new Error(`slide not found: ${op.slide}`)
        let xml = await zip.files[name].async('string')
        const runs = [...xml.matchAll(/<a:t(?:\s[^>]*)?>[\s\S]*?<\/a:t>/g)]
        if (!runs.length) throw new Error(`no text on slide ${op.slide}`)
        if (runs.length > 1) throw new Error(`slide ${op.slide} has multiple text runs; refusing to corrupt them`)
        const replaced = true
        xml = xml.replace(/<a:t(?:\s[^>]*)?>[\s\S]*?<\/a:t>/, `<a:t xml:space="preserve">${escapeXml(op.text)}</a:t>`)
        zip.file(name, xml)
        changes.push(`slide${op.slide}: -> ${op.text}`)
      }
    }
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })
    const verify = await verifyOffice(buffer, kind)
    if (!verify.ok) throw new Error(`edited ${kind} failed verification: ${verify.missing.join('; ')}`)
    return { ok: true, buffer, kind, changes }
  } catch (error) {
    return { ok: false, buffer: original, kind, changes: [], error: error instanceof Error ? error.message : String(error) }
  }
}
