import JSZip from 'jszip'

export type OfficeKind = 'docx' | 'xlsx' | 'pptx'

const REQUIRED: Record<OfficeKind, string[]> = {
  docx: ['[Content_Types].xml', 'word/document.xml'],
  xlsx: ['[Content_Types].xml', 'xl/workbook.xml'],
  pptx: ['[Content_Types].xml', 'ppt/presentation.xml'],
}

export interface ValidationResult {
  ok: boolean
  missing: string[]
}

export async function validateOffice(buffer: Buffer, kind: OfficeKind): Promise<ValidationResult> {
  const zip = await JSZip.loadAsync(buffer)
  const missing = REQUIRED[kind].filter((name) => !zip.file(name))
  return { ok: missing.length === 0, missing }
}

export async function containsText(buffer: Buffer, text: string): Promise<boolean> {
  const zip = await JSZip.loadAsync(buffer)
  const files = Object.keys(zip.files).filter((name) => name.endsWith('.xml'))
  for (const name of files) {
    const content = await zip.file(name)?.async('string')
    if (content?.includes(text)) return true
  }
  return false
}
