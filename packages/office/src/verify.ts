import JSZip from 'jszip'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { validateOffice, type OfficeKind, type ValidationResult } from './validate.ts'
import {
  ZipBudgetError,
  inspectZipBudget,
  readZipEntryText,
  resolveZipBudget,
  type ZipBudget,
  type ZipBudgetReport,
} from './read.ts'

export type VerifyCheckSeverity = 'blocker' | 'warn' | 'info'

/**
 * One machine-readable verification result. The ok field is true only when the
 * check actually passed: a check that could not run carries skipped: true and
 * is never treated as a pass.
 */
export interface VerifyCheck {
  id: string
  ok: boolean
  severity: VerifyCheckSeverity
  detail: string
  skipped?: boolean
}

export const RECALC_ENV = 'ADVISERS_VERIFY_RECALC_CMD'
const DEFAULT_RECALC_TIMEOUT_MS = 60_000
const MAX_DETAIL_ITEMS = 10

export interface VerifyOptions {
  /** Override the default ZIP extraction budgets. */
  budget?: Partial<ZipBudget>
  /** Override RECALC_ENV; false forces the recalc check to be skipped. */
  recalcCommand?: string | false
  /** Timeout for the external recalculation command, in milliseconds. */
  recalcTimeoutMs?: number
}

export interface VerifyResult extends ValidationResult {
  checks: VerifyCheck[]
  entries: number
  bytes: number
  layers: string[]
}

function check(id: string, ok: boolean, severity: VerifyCheckSeverity, detail: string, skipped = false): VerifyCheck {
  const item: VerifyCheck = { id, ok, severity, detail }
  if (skipped) item.skipped = true
  return item
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MiB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KiB'
  return bytes + ' B'
}

function summarize(items: string[]): string {
  if (!items.length) return 'none'
  const head = items.slice(0, MAX_DETAIL_ITEMS).join('; ')
  return items.length > MAX_DETAIL_ITEMS ? head + ' (+' + (items.length - MAX_DETAIL_ITEMS) + ' more)' : head
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function commandFailureDetail(error: unknown): string {
  const record = error as { message?: string; stderr?: Buffer | string }
  const message = record?.message ?? errorMessage(error)
  const stderr = record?.stderr ? String(record.stderr).trim().slice(0, 300) : ''
  return stderr ? message + ' (stderr: ' + stderr + ')' : message
}

function budgetFailureMessage(report: ZipBudgetReport): string {
  const budget = report.budget
  if (report.tooManyEntries) return 'too many ZIP entries: ' + report.entries + ' (limit ' + budget.maxEntries + ')'
  if (report.unsafeEntries.length) return 'unsafe ZIP entry: ' + report.unsafeEntries[0]
  if (report.oversizedEntries.length) {
    return 'ZIP entry too large: ' + report.oversizedEntries[0] + ' exceeds ' + budget.maxEntryUncompressed + ' uncompressed bytes'
  }
  return 'ZIP archive expands to ' + report.totalUncompressedBytes + ' bytes (limit ' + budget.maxTotalUncompressed + ')'
}

function xmlWellFormed(xml: string): boolean {
  const text = xml.replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[\s\S]*?\?>/g, '')
  const stack: string[] = []
  const re = /<\/?([A-Za-z_][\w:.-]*)(?:\s[^>]*?)?(\/?)>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const closing = match[0].startsWith('</')
    const selfClosing = match[2] === '/'
    if (closing) {
      if (stack.pop() !== match[1]) return false
    } else if (!selfClosing) {
      stack.push(match[1])
    }
  }
  return stack.length === 0
}

const FORMULA_ERROR_VALUE = /^#(?:REF!|VALUE!|DIV\/0!|NAME\?|N\/A|NUM!|NULL!)$/

interface FormulaScan {
  formulaCells: number
  missingCache: string[]
  errorCells: string[]
}

function scanSheetFormulas(name: string, xml: string): FormulaScan {
  const scan: FormulaScan = { formulaCells: 0, missingCache: [], errorCells: [] }
  for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const attrs = match[1]
    const inner = match[2]
    const ref = /\br="([^"]+)"/.exec(attrs)?.[1] ?? '?'
    const anchor = name + '!' + ref
    const value = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)
    const cached = value ? value[1].trim() : undefined
    const isFormula = /<f(?:\s[^>]*)?\/?>/.test(inner)
    if (isFormula) {
      scan.formulaCells += 1
      if (value === null) scan.missingCache.push(anchor)
    }
    const declaredError = /\bt="e"/.test(attrs)
    if (declaredError || (cached !== undefined && cached !== '' && FORMULA_ERROR_VALUE.test(cached))) {
      scan.errorCells.push(cached ? anchor + '=' + cached : anchor)
    }
  }
  return scan
}

interface RevisionScan {
  insertions: number
  deletions: number
  authors: string[]
}

function scanRevisions(xml: string, scan: RevisionScan): void {
  scan.insertions += (xml.match(/<w:ins[\s>]/g) ?? []).length
  scan.deletions += (xml.match(/<w:del[\s>]/g) ?? []).length
  for (const match of xml.matchAll(/<w:(?:ins|del)\b[^>]*\bw:author="([^"]*)"/g)) if (match[1]) scan.authors.push(match[1])
}

async function runRecalcCheck(buffer: Buffer, options: VerifyOptions): Promise<VerifyCheck> {
  const configured = options.recalcCommand === false ? '' : options.recalcCommand ?? process.env[RECALC_ENV] ?? ''
  const command = configured.trim()
  if (!command) {
    return check('xlsx.recalc', false, 'info', RECALC_ENV + ' is not configured: external formula recalculation was skipped (not a pass)', true)
  }
  const argv = command.split(/\s+/).filter(Boolean)
  const dir = mkdtempSync(path.join(tmpdir(), 'advisers-verify-recalc-'))
  const file = path.join(dir, 'recalc.xlsx')
  try {
    writeFileSync(file, buffer)
    execFileSync(argv[0], [...argv.slice(1), file], { stdio: 'pipe', timeout: options.recalcTimeoutMs ?? DEFAULT_RECALC_TIMEOUT_MS })
    return check('xlsx.recalc', true, 'info', 'external recalculation command exited 0 (' + argv[0] + ')')
  } catch (error) {
    return check('xlsx.recalc', false, 'blocker', 'external recalculation command failed: ' + commandFailureDetail(error))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Structural + deterministic verification. The result keeps the historical
 * ok/missing fields and adds a machine-readable checks array
 * (id/ok/severity/detail/skipped).
 */
export async function verifyOffice(buffer: Buffer, kind: OfficeKind, options: VerifyOptions = {}): Promise<VerifyResult> {
  const budget = resolveZipBudget(options.budget)
  const layers: string[] = ['opc', 'xml', 'content-types', 'rels']
  const checks: VerifyCheck[] = []
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch (error) {
    const detail = errorMessage(error)
    return { ok: false, missing: [detail], checks: [check('zip.open', false, 'blocker', detail)], entries: 0, bytes: buffer.length, layers }
  }

  // ---- ZIP expansion budget (security audit P1-6) ----
  const report = inspectZipBudget(zip, budget)
  checks.push(check('zip.entries', !report.tooManyEntries, 'blocker', report.entries + ' entries (' + report.files + ' files, limit ' + budget.maxEntries + ')'))
  checks.push(check('zip.entry-paths', report.unsafeEntries.length === 0, 'blocker', report.unsafeEntries.length === 0 ? 'all entry names are relative and safe' : 'unsafe entries: ' + summarize(report.unsafeEntries)))
  checks.push(check(
    'zip.uncompressed-budget',
    !report.overTotalBudget && report.oversizedEntries.length === 0,
    'blocker',
    formatBytes(report.totalUncompressedBytes) + ' uncompressed across ' + report.files + ' files (limits: ' + formatBytes(budget.maxTotalUncompressed) + ' total, ' + formatBytes(budget.maxEntryUncompressed) + ' per entry)' + (report.oversizedEntries.length ? '; oversized: ' + summarize(report.oversizedEntries) : ''),
  ))
  if (report.tooManyEntries || report.unsafeEntries.length > 0 || report.oversizedEntries.length > 0 || report.overTotalBudget) {
    return { ok: false, missing: [budgetFailureMessage(report)], checks, entries: report.entries, bytes: buffer.length, layers: ['zip'] }
  }

  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir)

  // ---- XML well-formedness + per-entry text budget ----
  const xmlTexts = new Map<string, string>()
  const xmlErrors: string[] = []
  let largestText = 0
  let textBudgetError: ZipBudgetError | undefined
  try {
    for (const name of names.filter((n) => /\.(xml|rels)$/i.test(n))) {
      const text = await readZipEntryText(zip, name, budget)
      largestText = Math.max(largestText, text.length)
      xmlTexts.set(name, text)
      if (!xmlWellFormed(text)) xmlErrors.push('malformed xml: ' + name)
    }
  } catch (error) {
    if (!(error instanceof ZipBudgetError)) throw error
    textBudgetError = error
  }
  checks.push(check('zip.text-budget', !textBudgetError, 'blocker', textBudgetError ? textBudgetError.message : 'largest decoded text entry: ' + largestText + ' chars (limit ' + budget.maxTextChars + ' per entry)'))
  if (textBudgetError) {
    return { ok: false, missing: [textBudgetError.message], checks, entries: names.length, bytes: report.totalUncompressedBytes, layers }
  }
  checks.push(check('xml.wellformed', xmlErrors.length === 0, 'blocker', xmlErrors.length === 0 ? 'all XML/rels entries are well-formed' : summarize(xmlErrors)))

  // ---- OPC structure (required parts / content types / relationships) ----
  let base: ValidationResult
  try {
    base = await validateOffice(buffer, kind)
  } catch (error) {
    const detail = errorMessage(error)
    checks.push(check('opc.required-parts', false, 'blocker', detail))
    return { ok: false, missing: [detail], checks, entries: names.length, bytes: report.totalUncompressedBytes, layers }
  }
  const relMissing = base.missing.filter((item) => item.startsWith('rel:'))
  const contentTypesMissing = base.missing.filter((item) => item.startsWith('content-type:'))
  const requiredMissing = base.missing.filter((item) => !item.startsWith('rel:') && !item.startsWith('content-type:'))
  const contentTypesXml = names.includes('[Content_Types].xml') ? xmlTexts.get('[Content_Types].xml') ?? '' : ''
  const defaultTypes = new Set([...contentTypesXml.matchAll(/<Default[^>]*Extension="([^"]+)"/g)].map((match) => match[1].toLowerCase()))
  const overrideTypes = new Set([...contentTypesXml.matchAll(/<Override[^>]*PartName="([^"]+)"/g)].map((match) => match[1].replace(/^\//, '')))
  const partTypeErrors: string[] = []
  for (const name of names) {
    if (name === '[Content_Types].xml') continue
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    if (!defaultTypes.has(ext) && !overrideTypes.has(name)) partTypeErrors.push('missing content type: ' + name)
  }
  checks.push(check('opc.required-parts', requiredMissing.length === 0, 'blocker', requiredMissing.length === 0 ? 'required ' + kind + ' parts are present' : 'missing: ' + summarize(requiredMissing)))
  checks.push(check('opc.content-types', contentTypesMissing.length === 0 && partTypeErrors.length === 0, 'blocker', contentTypesMissing.length === 0 && partTypeErrors.length === 0 ? 'content types are declared for the main part and every part' : 'main part: ' + summarize(contentTypesMissing) + '; other parts: ' + summarize(partTypeErrors)))
  checks.push(check('opc.relationships', relMissing.length === 0, 'blocker', relMissing.length === 0 ? 'all relationship targets resolve' : 'broken: ' + summarize(relMissing)))

  const missing: string[] = [...base.missing, ...partTypeErrors, ...xmlErrors]
  let ok = base.ok && partTypeErrors.length === 0 && xmlErrors.length === 0

  // ---- DOCX tracked changes (w:ins / w:del) ----
  if (kind === 'docx') {
    const revisionFiles = names.filter((name) => /^word\/(?:document|header\d+|footer\d+)\.xml$/.test(name))
    const revisionScan: RevisionScan = { insertions: 0, deletions: 0, authors: [] }
    for (const name of revisionFiles) scanRevisions(xmlTexts.get(name) ?? '', revisionScan)
    const revisionCount = revisionScan.insertions + revisionScan.deletions
    const authors = [...new Set(revisionScan.authors)].filter(Boolean).slice(0, 5)
    checks.push(check('docx.revisions', revisionCount === 0, 'warn', revisionCount === 0 ? 'no tracked changes (w:ins/w:del) found' : revisionCount + ' tracked change marker(s): ' + revisionScan.insertions + ' w:ins, ' + revisionScan.deletions + ' w:del' + (authors.length ? '; authors: ' + authors.join(', ') : '')))
    layers.push('revisions')
  }

  // ---- XLSX formula cache / error values / optional recalc hook ----
  if (kind === 'xlsx') {
    const sheetNames = names.filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name))
    const formulaScan: FormulaScan = { formulaCells: 0, missingCache: [], errorCells: [] }
    for (const name of sheetNames) {
      const part = scanSheetFormulas(name, xmlTexts.get(name) ?? '')
      formulaScan.formulaCells += part.formulaCells
      formulaScan.missingCache.push(...part.missingCache)
      formulaScan.errorCells.push(...part.errorCells)
    }
    const cacheOk = formulaScan.missingCache.length === 0
    checks.push(check('xlsx.formula-cache', cacheOk, 'warn', cacheOk ? formulaScan.formulaCells + ' formula cell(s) have cached results' : formulaScan.missingCache.length + ' of ' + formulaScan.formulaCells + ' formula cell(s) have no cached result: ' + summarize(formulaScan.missingCache)))
    const errorsOk = formulaScan.errorCells.length === 0
    checks.push(check('xlsx.formula-errors', errorsOk, 'blocker', errorsOk ? 'no formula cell caches an error value' : formulaScan.errorCells.length + ' formula cell(s) cache an error value: ' + summarize(formulaScan.errorCells)))
    if (!errorsOk) ok = false
    layers.push('formulas')
    const recalc = ok
      ? await runRecalcCheck(buffer, options)
      : check('xlsx.recalc', false, 'info', 'external formula recalculation skipped because earlier checks failed', true)
    checks.push(recalc)
    if (!recalc.skipped) layers.push('recalc')
  }

  const failedBlocker = checks.some((item) => !item.ok && !item.skipped && item.severity === 'blocker')
  return { ok: ok && !failedBlocker, missing, checks, entries: names.length, bytes: report.totalUncompressedBytes, layers }
}
