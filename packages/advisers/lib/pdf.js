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

/**
 * P1-5: per-font/per-size width cache.
 *
 * The old wrap() measured every candidate prefix with
 * font.widthOfTextAtSize(current + ch) — that re-shapes the whole line for
 * every character, so one paragraph cost O(chars²) shaping work (1000 lines
 * took ~900ms end to end). The CJK fonts Advisers supports have additive
 * advance widths (no pair kerning), so measuring each character once and
 * summing the advances yields the identical line breaks in O(chars).
 */
const WIDTH_CACHES = new WeakMap()

function widthOfChar(font, size, ch) {
  let cache = WIDTH_CACHES.get(font)
  if (!cache) { cache = new Map(); WIDTH_CACHES.set(font, cache) }
  const key = size + '\u0000' + ch
  let width = cache.get(key)
  if (width === undefined) {
    width = font.widthOfTextAtSize(ch, size)
    cache.set(key, width)
  }
  return width
}

/**
 * Break one paragraph into lines at maxWidth.
 *
 * Exported so test/perf-regression.test.js can compare it against the original
 * prefix-measuring algorithm (equivalence is asserted on an additive reference
 * font, which is the class of fonts this builder supports).
 */
export function wrapToWidth(text, font, size, maxWidth) {
  const lines = []
  let current = ''
  let currentWidth = 0
  for (const ch of String(text)) {
    if (ch === '\n') { lines.push(current); current = ''; currentWidth = 0; continue }
    const charWidth = widthOfChar(font, size, ch)
    if (current && currentWidth + charWidth > maxWidth) {
      lines.push(current)
      current = ch
      currentWidth = charWidth
    } else {
      current += ch
      currentWidth += charWidth
    }
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
    for (const line of wrapToWidth(text, font, fontSize, width - margin * 2)) {
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
