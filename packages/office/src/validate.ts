import JSZip from 'jszip'
import path from 'node:path'

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

async function brokenRelationships(zip: JSZip): Promise<string[]> {
  const broken: string[] = []
  const rels = Object.keys(zip.files).filter((name) => name.endsWith('.rels'))
  for (const name of rels) {
    const content = await zip.file(name)?.async('string')
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

export async function validateOffice(buffer: Buffer, kind: OfficeKind): Promise<ValidationResult> {
  const zip = await JSZip.loadAsync(buffer)
  const missing = REQUIRED[kind].filter((name) => !zip.file(name))
  const contentTypes = await zip.file('[Content_Types].xml')?.async('string')
  if (!contentTypes?.includes(CONTENT_TYPE[kind])) missing.push(`content-type: ${CONTENT_TYPE[kind]}`)
  const broken = await brokenRelationships(zip)
  for (const item of broken) missing.push(`rel: ${item}`)
  return { ok: missing.length === 0, missing }
}

export async function containsText(buffer: Buffer, text: string): Promise<boolean> {
  const zip = await JSZip.loadAsync(buffer)
  const files = Object.keys(zip.files).filter((name) => /\.(xml|rels|json)$/.test(name))
  for (const name of files) {
    const content = await zip.file(name)?.async('string')
    if (content?.includes(text)) return true
  }
  return false
}
