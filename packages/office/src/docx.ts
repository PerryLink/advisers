import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'

export interface DocxTableSpec {
  headers: string[]
  rows: string[][]
}

export interface DocxSectionSpec {
  heading?: string
  paragraphs?: string[]
  bullets?: string[]
  table?: DocxTableSpec
}

export interface DocxSpec {
  title: string
  subtitle?: string
  sections: DocxSectionSpec[]
}

const FONT = 'Microsoft YaHei'

function textParagraph(text: string, options: { bold?: boolean; italics?: boolean } = {}): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, font: FONT, size: 22, bold: options.bold, italics: options.italics })],
    spacing: { after: 120 },
  })
}

function table(spec: DocxTableSpec): Table {
  const header = new TableRow({
    tableHeader: true,
    children: spec.headers.map(
      (h) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, font: FONT, size: 20 })] })],
          shading: { fill: 'E8EEF7' },
        }),
    ),
  })
  const rows = spec.rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: cell, font: FONT, size: 20 })] })],
            }),
        ),
      }),
  )
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [header, ...rows],
  })
}

export async function buildDocx(spec: DocxSpec): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({
      text: spec.title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.LEFT,
    }),
  ]
  if (spec.subtitle) children.push(textParagraph(spec.subtitle, { italics: true }))

  for (const section of spec.sections) {
    if (section.heading) {
      children.push(
        new Paragraph({
          text: section.heading,
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 },
        }),
      )
    }
    for (const p of section.paragraphs ?? []) children.push(textParagraph(p))
    for (const b of section.bullets ?? []) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun({ text: b, font: FONT, size: 22 })],
        }),
      )
    }
    if (section.table) children.push(table(section.table))
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ properties: {}, children }],
  })
  return Buffer.from(await Packer.toBuffer(doc))
}
