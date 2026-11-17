import JSZip from 'jszip'
import path from 'node:path'
import {
  ZipBudgetError,
  assertZipBudget,
  readZipEntryText,
  type ZipBudget,
} from './read.ts'

export type OfficeKind = 'docx' | 'xlsx' | 'pptx'

const CONTENT_TYPE: Record<OfficeKind, string> = {
  docx: 'wordprocessingml.document.main+xml',
  xlsx: 'spreadsheetml.sheet.main+xml',
  pptx: 'presentationml.presentation.main+xml',
}

const REQUIRED: Record<OfficeKind, string[]> = {
  docx: ['[Content_Types].xml', 'word/document.xml'],
  xlsx: ['[Content_Types].xml', 'xl/workbook.xml'],
  pptx: ['[Content_Types].xml', 'ppt/presentation.xml'],
}

export interface ValidationResult {
  ok: boolean
  missing: string[]
}

export interface ValidateOptions {
  /** Override the default ZIP extraction budgets. */
  budget?: Partial<ZipBudget>
}

function budgetFailure(error: unknown): ValidationResult | undefined {
  if (!(error instanceof ZipBudgetError)) return undefined
  return { ok: false, missing: [error.message] }
}

/** A regular (non-folder) entry, using metadata only. */
function fileEntry(zip: JSZip, name: string): boolean {
  const entry = zip.files[name]
  return Boolean(entry && !entry.dir)
}

async function brokenRelationships(zip: JSZip, budget: ZipBudget): Promise<string[]> {
  const broken: string[] = []
  const rels = Object.keys(zip.files).filter((name) => name.endsWith('.rels') && !zip.files[name]?.dir)
  for (const name of rels) {
    const content = await readZipEntryText(zip, name, budget)
    if (!content) continue
    const base = name.replace(/_rels\/[^/]+$/, '')
    for (const match of content.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = match[0]
      if (/TargetMode="External"/.test(tag)) continue
      const target = /Target="([^"]+)"/.exec(tag)?.[1]
      if (!target) continue
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : path.posix.normalize(path.posix.join(base, target))
      if (!zip.file(resolved)) broken.push(`${name} -> ${target}`)
    }
  }
  return broken
}

/**
 * Structural validation. A ZIP whose extraction would exceed the shared
 * Office budget (64 MiB total, 16 MiB per entry, 8 M chars per text entry) is
 * reported as not-ok instead of being decompressed; the same gate protects
 * every entry read below.
 */
export async function validateOffice(buffer: Buffer, kind: OfficeKind, options: ValidateOptions = {}): Promise<ValidationResult> {
  const zip = await JSZip.loadAsync(buffer)
  let budget: ZipBudget
  try {
    budget = assertZipBudget(zip, options.budget).budget
  } catch (error) {
    const failure = budgetFailure(error)
    if (failure) return failure
    throw error
  }
  try {
    const missing = REQUIRED[kind].filter((name) => !zip.file(name))
    const contentTypes = fileEntry(zip, '[Content_Types].xml')
      ? await readZipEntryText(zip, '[Content_Types].xml', budget)
      : undefined
    if (!contentTypes?.includes(CONTENT_TYPE[kind])) missing.push(`content-type: ${CONTENT_TYPE[kind]}`)
    const broken = await brokenRelationships(zip, budget)
    for (const item of broken) missing.push(`rel: ${item}`)
    return { ok: missing.length === 0, missing }
  } catch (error) {
    const failure = budgetFailure(error)
    if (failure) return failure
    throw error
  }
}

/**
 * Search decoded text entries. A ZIP over the extraction budget throws
 * ZipBudgetError instead of being decompressed entry by entry.
 */
export async function containsText(buffer: Buffer, text: string, options: ValidateOptions = {}): Promise<boolean> {
  const zip = await JSZip.loadAsync(buffer)
  const budget = assertZipBudget(zip, options.budget).budget
  const files = Object.keys(zip.files).filter((name) => /\.(xml|rels|json)$/.test(name) && !zip.files[name]?.dir)
  for (const name of files) {
    const content = await readZipEntryText(zip, name, budget)
    if (content.includes(text)) return true
  }
  return false
}
