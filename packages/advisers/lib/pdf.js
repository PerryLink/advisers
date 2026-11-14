/**
 * E7 minimal PDF: a local commitment/evidence report.
 *
 * pdf-lib has no built-in CJK font, so we load a system CJK font. The caller
 * supplies an explicit font path via `ADVISERS_PDF_FONT` or we try common
 * Windows/Linux/macOS locations. If no font is found we fail with a clear
 * message instead of emitting tofu.
 */
import { readFileSync, existsSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

const FONT_CANDIDATES = [
  process.env.ADVISERS_PDF_FONT,
  '/mnt/c/Windows/Fonts/simhei.ttf',
  'C:\\Windows\\Fonts\\simhei.ttf',
  '/mnt/c/Windows/Fonts/msyh.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/System/Library/Fonts/PingFang.ttc',
].filter(Boolean)

export function findCjkFont() {
  for (const path of FONT_CANDIDATES) {
    try { if (existsSync(path)) return path } catch {}
  }
  return null
}

function wrap(text, font, size, maxWidth) {
  const lines = []
  let current = ''
  for (const ch of String(text)) {
    if (ch === '\n') { lines.push(current); current = ''; continue }
    const next = current + ch
    if (font.widthOfTextAtSize(next, size) > maxWidth && current) { lines.push(current); current = ch }
    else current = next
  }
  if (current) lines.push(current)
  return lines
}

export async function buildSimplePdf({ title = 'Advisers', paragraphs = [], fontPath = findCjkFont(), createdAt = new Date() } = {}) {
  if (!fontPath) throw new Error('no CJK font found; set ADVISERS_PDF_FONT to a .ttf/.otf font (e.g. simhei.ttf)')
  const bytes = readFileSync(fontPath)
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(bytes, { subset: true })
  const size = 10.5
  const margin = 48
  let page = doc.addPage([595, 842])
  const { width, height } = page.getSize()
  let y = height - margin
  const add = (text, fontSize = size) => {
    for (const line of wrap(text, font, fontSize, width - margin * 2)) {
      if (y < margin + fontSize * 2) { page = doc.addPage([595, 842]); y = height - margin }
      page.drawText(line, { x: margin, y, size: fontSize, font })
      y -= fontSize * 1.55
    }
  }
  add(title, 16)
  y -= 6
  add(`生成时间：${createdAt.toISOString()}`, 8.5)
  y -= 6
  for (const p of paragraphs) add(p)
  const out = await doc.save()
  return Buffer.from(out)
}
