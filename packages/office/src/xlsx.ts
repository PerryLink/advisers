import ExcelJS from 'exceljs'

export function excelDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day))
}

export interface XlsxColumnSpec {
  header: string
  key: string
  width?: number
  numFmt?: string
}

export interface XlsxSpec {
  sheet?: string
  columns: XlsxColumnSpec[]
  rows: Array<Record<string, string | number | null>>
  freezeHeader?: boolean
  formulas?: Array<{ cell: string; formula: string }>
}

export async function buildXlsx(spec: XlsxSpec): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Advisers'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet(spec.sheet ?? 'Sheet1')
  sheet.columns = spec.columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width ?? 18,
    style: { font: { name: 'Microsoft YaHei', size: 11 }, ...(c.numFmt ? { numFmt: c.numFmt } : {}) },
  }))
  sheet.addRows(spec.rows)
  sheet.getRow(1).font = { bold: true, name: 'Microsoft YaHei', size: 11 }
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE8EEF7' },
  }
  if (spec.freezeHeader !== false) sheet.views = [{ state: 'frozen', ySplit: 1 }]
  for (const formula of spec.formulas ?? []) sheet.getCell(formula.cell).value = { formula: formula.formula }

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
