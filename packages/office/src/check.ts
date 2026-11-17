import { readOffice, type OfficeRead } from './read.ts'
import { verifyOffice, type VerifyCheck, type VerifyOptions } from './verify.ts'

export type OfficeCheckKind = 'docx' | 'xlsx' | 'pptx'

export interface Finding {
  severity: 'blocker' | 'warn'
  code: string
  message: string
  anchor?: string
}

export interface OfficeCheckOptions {
  budget?: VerifyOptions['budget']
  recalcCommand?: VerifyOptions['recalcCommand']
  recalcTimeoutMs?: VerifyOptions['recalcTimeoutMs']
}

export interface OfficeCheckResult {
  ok: boolean
  findings: Finding[]
  /**
   * Machine-readable checks in a stable order. Structure and deeper
   * verification checks come first, then deterministic content checks; the
   * legacy ok/findings/stats fields are kept for backward compatibility.
   */
  checks: VerifyCheck[]
  stats: Record<string, number>
}

function failureSummary(findings: Finding[], checks: VerifyCheck[], characters: number): OfficeCheckResult {
  const blockers = findings.filter((finding) => finding.severity === 'blocker').length
  return { ok: blockers === 0, findings, checks, stats: { characters, findings: findings.length, blockers, checks: checks.length } }
}

/** Deterministic content checks. It does not judge whether the content is correct. */
export async function checkOffice(buffer: Buffer, kind: OfficeCheckKind, options: OfficeCheckOptions = {}): Promise<OfficeCheckResult> {
  const structural = await verifyOffice(buffer, kind, { budget: options.budget, recalcCommand: options.recalcCommand, recalcTimeoutMs: options.recalcTimeoutMs })
  const findings: Finding[] = structural.missing.map((message) => ({ severity: 'blocker', code: 'STRUCTURE', message }))
  const checks: VerifyCheck[] = [...structural.checks]
  for (const item of structural.checks) {
    if (!item.ok && !item.skipped && item.id === 'docx.revisions') findings.push({ severity: 'warn', code: 'DOCX_REVISIONS', message: item.detail })
  }

  const read = await readOffice(buffer, kind, { budget: options.budget }).then((value) => ({ ok: true as const, value })).catch((error: unknown) => ({ ok: false as const, error }))
  if (!read.ok) {
    const detail = read.error instanceof Error ? read.error.message : String(read.error)
    findings.push({ severity: 'blocker', code: 'READ', message: detail })
    return failureSummary(findings, checks, 0)
  }
  const doc: OfficeRead = read.value
  const text = doc.text
  const contentChecks: VerifyCheck[] = []

  for (const [code, re, message] of [
    ['PLACEHOLDER', /\b(TODO|TBD|FIXME|XXX)\b|占位|待补|待填写/gi, 'placeholder text'],
    ['FORMULA_ERROR', /#(REF!|VALUE!|DIV\/0!|NAME\?|N\/A)/g, 'formula error'],
    ['NAN', /\bNaN\b/g, 'NaN value'],
  ] as const) {
    for (const match of text.matchAll(re)) {
      findings.push({ severity: 'blocker', code, message, anchor: String(match.index) })
      contentChecks.push({ id: 'content.' + code.toLowerCase().replace(/_/g, '-'), ok: false, severity: 'blocker', detail: message + ' at character ' + String(match.index) })
    }
  }
  if (kind === 'docx') {
    const blocks = (doc as any).blocks ?? []
    for (const [index, block] of blocks.entries()) {
      if (block.type === 'table' && block.table.rows.length < 2) {
        findings.push({ severity: 'warn', code: 'EMPTY_TABLE', message: 'table has no data rows', anchor: 'block:' + index })
        contentChecks.push({ id: 'content.empty-table', ok: false, severity: 'warn', detail: 'table has no data rows (block ' + index + ')' })
      }
    }
    if (text.trim().length < 5) {
      findings.push({ severity: 'blocker', code: 'EMPTY_DOC', message: 'document has almost no text' })
      contentChecks.push({ id: 'content.empty-doc', ok: false, severity: 'blocker', detail: 'document has almost no text' })
    }
  }
  if (kind === 'xlsx') {
    const sheets = (doc as any).sheets ?? []
    for (const sheet of sheets) {
      if (!sheet.rows.length) {
        findings.push({ severity: 'warn', code: 'EMPTY_SHEET', message: 'sheet ' + sheet.name + ' is empty', anchor: sheet.name })
        contentChecks.push({ id: 'content.empty-sheet', ok: false, severity: 'warn', detail: 'sheet ' + sheet.name + ' is empty' })
      }
      for (const formula of sheet.formulas) {
        if (formula.result == null) {
          findings.push({ severity: 'warn', code: 'FORMULA_NO_CACHE', message: 'formula ' + formula.cell + ' has no cached result', anchor: sheet.name + '!' + formula.cell })
          contentChecks.push({ id: 'content.formula-no-cache', ok: false, severity: 'warn', detail: 'formula ' + sheet.name + '!' + formula.cell + ' has no cached result' })
        }
      }
    }
    if (!sheets.length) {
      findings.push({ severity: 'blocker', code: 'NO_SHEETS', message: 'workbook has no sheets' })
      contentChecks.push({ id: 'content.no-sheets', ok: false, severity: 'blocker', detail: 'workbook has no sheets' })
    }
  }
  if (kind === 'pptx') {
    const slides = (doc as any).slides ?? []
    if (!slides.length) {
      findings.push({ severity: 'blocker', code: 'NO_SLIDES', message: 'deck has no slides' })
      contentChecks.push({ id: 'content.no-slides', ok: false, severity: 'blocker', detail: 'deck has no slides' })
    }
    for (const slide of slides) {
      if (!slide.paragraphs?.length) {
        findings.push({ severity: 'warn', code: 'EMPTY_SLIDE', message: 'slide ' + slide.index + ' is empty', anchor: 'slide:' + slide.index })
        contentChecks.push({ id: 'content.empty-slide', ok: false, severity: 'warn', detail: 'slide ' + slide.index + ' is empty' })
      }
    }
  }

  checks.push(...contentChecks)
  const blockers = findings.filter((finding) => finding.severity === 'blocker').length
  const structuralBlocker = structural.checks.some((item) => !item.ok && !item.skipped && item.severity === 'blocker')
  const ok = blockers === 0 && structural.missing.length === 0 && !structuralBlocker
  return { ok, findings, checks, stats: { characters: text.length, findings: findings.length, blockers, checks: checks.length } }
}
