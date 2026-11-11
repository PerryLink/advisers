import * as PptxModule from 'pptxgenjs'

// pptxgenjs 4 ships a default class but its ESM type shape is a namespace.
const PptxGenJS: any = (PptxModule as any).default ?? PptxModule

export interface PptxSlideSpec {
  title: string
  bullets?: string[]
  notes?: string
  table?: { headers: string[]; rows: string[][] }
}

export interface PptxSpec {
  title: string
  subtitle?: string
  slides: PptxSlideSpec[]
}

const FONT = 'Microsoft YaHei'

export async function buildPptx(spec: PptxSpec): Promise<Buffer> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Advisers'
  pptx.subject = spec.title
  pptx.title = spec.title
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT, lang: 'zh-CN' }

  const cover = pptx.addSlide()
  cover.background = { color: 'F5F7FB' }
  cover.addText(spec.title, { x: 0.6, y: 1.4, w: 12, h: 1.2, fontSize: 30, bold: true, color: '1F2937', fontFace: FONT })
  if (spec.subtitle) {
    cover.addText(spec.subtitle, { x: 0.6, y: 2.6, w: 12, h: 0.6, fontSize: 16, color: '6B7280', fontFace: FONT })
  }

  for (const item of spec.slides) {
    const slide = pptx.addSlide()
    slide.addText(item.title, { x: 0.6, y: 0.4, w: 12, h: 0.7, fontSize: 24, bold: true, color: '1F2937', fontFace: FONT })
    let y = 1.3
    for (const bullet of item.bullets ?? []) {
      slide.addText(bullet, {
        x: 0.8,
        y,
        w: 11.8,
        h: 0.5,
        fontSize: 15,
        color: '374151',
        fontFace: FONT,
        bullet: { type: 'bullet' },
      })
      y += 0.55
    }
    if (item.table) {
      const rows = [item.table.headers, ...item.table.rows].map((row) =>
        row.map((cell) => ({ text: cell, options: { fontFace: FONT, fontSize: 11 } })),
      )
      slide.addTable(rows, { x: 0.6, y, w: 12, border: { pt: 1, color: 'D1D5DB' }, fill: 'FFFFFF' })
    }
    if (item.notes) slide.addNotes(item.notes)
  }

  const data = await pptx.write({ outputType: 'nodebuffer' })
  return Buffer.from(data as Uint8Array)
}
