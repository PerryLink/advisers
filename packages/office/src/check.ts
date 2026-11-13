import { readOffice } from './read.ts'
import { verifyOffice } from './verify.ts'

export type OfficeCheckKind = 'docx' | 'xlsx' | 'pptx'

export interface Finding {
  severity: 'blocker' | 'warn'
  code: string
  message: string
  anchor?: string
}

export interface OfficeCheckResult {
  ok: boolean
  findings: Finding[]
  stats: Record<string, number>
}

/** Deterministic content checks. It does not judge whether the content is correct. */
export async function checkOffice(buffer: Buffer, kind: OfficeCheckKind): Promise<OfficeCheckResult> {
  const structural = await verifyOffice(buffer, kind)
  const findings: Finding[] = structural.missing.map((m) => ({ severity: 'blocker', code: 'STRUCTURE', message: m }))
  const doc = await readOffice(buffer, kind)
  const text = doc.text
  for (const [code, re, message] of [
    ['PLACEHOLDER', /\b(TODO|TBD|FIXME|XXX)\b|占位|待补|待填写/gi, 'placeholder text'],
    ['FORMULA_ERROR', /#(REF!|VALUE!|DIV\/0!|NAME\?|N\/A)/g, 'formula error'],
    ['NAN', /\bNaN\b/g, 'NaN value'],
  ] as const) {
    for (const match of text.matchAll(re)) findings.push({ severity: 'blocker', code, message, anchor: String(match.index) })
  }
  if (kind === 'docx') {
    const blocks = (doc as any).blocks ?? []
    findings.push(...blocks.filter((b: any) => b.type === 'table' && b.table.rows.length < 2).map((b: any, i: number) => ({ severity: 'warn' as const, code: 'EMPTY_TABLE', message: 'table has no data rows', anchor: `block:${i}` })))
    if (text.trim().length < 5) findings.push({ severity: 'blocker', code: 'EMPTY_DOC', message: 'document has almost no text' })
  }
  if (kind === 'xlsx') {
    const sheets = (doc as any).sheets ?? []
    for (const sheet of sheets) {
      if (!sheet.rows.length) findings.push({ severity: 'warn', code: 'EMPTY_SHEET', message: `sheet ${sheet.name} is empty`, anchor: sheet.name })
      for (const f of sheet.formulas) if (f.result == null) findings.push({ severity: 'warn', code: 'FORMULA_NO_CACHE', message: `formula ${f.cell} has no cached result`, anchor: `${sheet.name}!${f.cell}` })
    }
    if (!sheets.length) findings.push({ severity: 'blocker', code: 'NO_SHEETS', message: 'workbook has no sheets' })
  }
  if (kind === 'pptx') {
    const slides = (doc as any).slides ?? []
    if (!slides.length) findings.push({ severity: 'blocker', code: 'NO_SLIDES', message: 'deck has no slides' })
    for (const slide of slides) if (!slide.paragraphs?.length) findings.push({ severity: 'warn', code: 'EMPTY_SLIDE', message: `slide ${slide.index} is empty`, anchor: `slide:${slide.index}` })
  }
  return {
    ok: !findings.some((f) => f.severity === 'blocker'),
    findings,
    stats: { characters: text.length, findings: findings.length, blockers: findings.filter((f) => f.severity === 'blocker').length },
  }
}
