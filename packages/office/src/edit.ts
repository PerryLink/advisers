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
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function paragraphBlocks(xml: string): Array<{ start: number; end: number; inner: string }> {
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, inner: m[0] }))
}

function replaceDocxParagraph(xml: string, block: number, text: string): { xml: string; before: string } {
  const paragraphs = paragraphBlocks(xml)
  const target = paragraphs[block]
  if (!target) throw new Error(`paragraph not found: ${block}`)
  const pPr = target.inner.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? ''
  const before = target.inner.replace(/<[^>]+>/g, '').slice(0, 120)
  const paragraph = `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
  return { xml: xml.slice(0, target.start) + paragraph + xml.slice(target.end), before }
}

function replaceTable(xml: string, block: number, rows: string[][]): { xml: string; before: string } {
  const tables = [...xml.matchAll(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g)]
  const target = tables[block]
  if (!target) throw new Error(`table not found: ${block}`)
  const firstRow = target[0].match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/)?.[0] ?? ''
  const firstCell = firstRow.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/)?.[0] ?? '<w:tc><w:p></w:p></w:tc>'
  const tcPr = firstCell.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/)?.[0] ?? ''
  const body = rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${tcPr}<w:p><w:r><w:t xml:space="preserve">${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')
  const table = `<w:tbl>${target[0].match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/)?.[0] ?? ''}${body}</w:tbl>`
  return { xml: xml.slice(0, target.index!) + table + xml.slice(target.index! + target[0].length), before: 'table' }
}

export async function editOffice(input: Buffer, kind: OfficeEditKind, ops: EditOp[]): Promise<EditResult> {
  const original = Buffer.from(input)
  try {
    if (!Array.isArray(ops) || ops.length === 0) throw new Error('ops must not be empty')
    if (kind === 'xlsx') {
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(original as never)
      for (const op of ops) {
        if (op.op !== 'xlsx.setCell') throw new Error(`unsupported xlsx op: ${op.op}`)
        const sheet = workbook.getWorksheet(op.sheet)
        if (!sheet) throw new Error(`sheet not found: ${op.sheet}`)
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
        let replaced = false
        xml = xml.replace(/<a:t(?:\s[^>]*)?>[\s\S]*?<\/a:t>/, () => { replaced = true; return `<a:t xml:space="preserve">${escapeXml(op.text)}</a:t>` })
        if (!replaced) throw new Error(`no text on slide ${op.slide}`)
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
