import JSZip from 'jszip'
import path from 'node:path'
import { validateOffice, type OfficeKind, type ValidationResult } from './validate.ts'

export interface VerifyResult extends ValidationResult {
  entries: number
  bytes: number
  layers: string[]
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

/** Structural verification: ZIP safety, XML well-formedness, content types, rels. */
export async function verifyOffice(buffer: Buffer, kind: OfficeKind): Promise<VerifyResult> {
  let base: ValidationResult
  try {
    base = await validateOffice(buffer, kind)
  } catch (error) {
    return { ok: false, missing: [error instanceof Error ? error.message : String(error)], entries: 0, bytes: buffer.length, layers: ['opc'] }
  }
  const zip = await JSZip.loadAsync(buffer)
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  const layers: string[] = ['opc', 'xml', 'content-types', 'rels']
  const errors: string[] = []
  let bytes = 0
  if (names.length > 2000) errors.push(`too many entries: ${names.length}`)
  for (const name of names) {
    if (name.includes('..') || path.posix.isAbsolute(name)) errors.push(`unsafe entry: ${name}`)
    const data = await zip.files[name].async('nodebuffer')
    bytes += data.length
    if (bytes > 50 * 1024 * 1024) { errors.push('uncompressed size exceeds 50MB'); break }
    if (/\.(xml|rels)$/i.test(name) && !xmlWellFormed(data.toString('utf8'))) errors.push(`malformed xml: ${name}`)
  }
  const ct = names.includes('[Content_Types].xml') ? await zip.files['[Content_Types].xml'].async('string') : ''
  const defaults = new Set([...ct.matchAll(/<Default[^>]*Extension="([^"]+)"/g)].map((m) => m[1].toLowerCase()))
  const overrides = new Set([...ct.matchAll(/<Override[^>]*PartName="([^"]+)"/g)].map((m) => m[1].replace(/^\//, '')))
  for (const name of names) {
    if (name === '[Content_Types].xml') continue
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    if (!defaults.has(ext) && !overrides.has(name)) errors.push(`missing content type: ${name}`)
  }
  for (const name of names.filter((n) => n.endsWith('.rels'))) {
    const xml = await zip.files[name].async('string')
    for (const m of xml.matchAll(/<Relationship[^>]*Target="([^"]+)"[^>]*>/g)) {
      if (/TargetMode="External"/.test(m[0])) continue
      const baseDir = path.posix.dirname(name).replace(/(^|\/)_rels$/, '$1')
      const target = path.posix.normalize(path.posix.join(baseDir, m[1].replace(/^\//, '')))
      if (!names.includes(target)) errors.push(`missing rel target: ${name} -> ${m[1]}`)
    }
  }
  return { ...base, ok: base.ok && errors.length === 0, missing: [...base.missing, ...errors], entries: names.length, bytes, layers }
}
