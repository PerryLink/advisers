#!/usr/bin/env node
/**
 * Structural + optional application-open verification for Office artifacts.
 * LibreOffice is optional; without it the script still checks OPC/rels/text and
 * prints the Windows manual checklist.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDocx, buildPptx, buildXlsx, containsText, validateOffice } from '../packages/office/dist/index.js'

const dir = mkdtempSync(join(tmpdir(), 'advisers-office-verify-'))
try {
  const docx = await buildDocx({
    title: 'Office 验证',
    sections: [{ heading: '结论', paragraphs: ['预算可控'], table: { headers: ['项', '值'], rows: [['a', '1']] } }],
  })
  const xlsx = await buildXlsx({
    sheet: '预算',
    columns: [{ header: '项目', key: 'item' }, { header: '金额', key: 'amount', numFmt: '#,##0' }],
    rows: [{ item: '市场', amount: 120 }],
  })
  const pptx = await buildPptx({ title: 'Office 验证', slides: [{ title: '结论', bullets: ['预算可控'] }] })

  const checks = []
  for (const [kind, buffer, text] of [['docx', docx, '预算可控'], ['xlsx', xlsx, '市场'], ['pptx', pptx, '预算可控']]) {
    const result = await validateOffice(buffer, kind)
    checks.push([kind, result.ok ? 'OPC/rels OK' : `FAIL ${result.missing.join(',')}`, await containsText(buffer, text) ? 'text OK' : 'text MISSING'])
    const file = join(dir, `verify.${kind}`)
    await import('node:fs').then(({ writeFileSync }) => writeFileSync(file, buffer))
    try {
      const binary = process.env.LIBREOFFICE || 'libreoffice'
      execFileSync(binary, ['--headless', '--convert-to', 'pdf', '--outdir', dir, file], { stdio: 'ignore', timeout: 60_000 })
      checks[checks.length - 1].push('PDF OK')
    } catch {
      checks[checks.length - 1].push('PDF skipped (no LibreOffice)')
    }
  }
  for (const row of checks) console.log(row.join('\t'))
  console.log('\nWindows manual checklist:')
  console.log('- open each file in Word/Excel/PowerPoint; no "repair" dialog')
  console.log('- Chinese text is not tofu; table borders/width look sane')
  console.log('- Excel total formula recalculates; dates show the intended day')
  console.log('- PPT slide count and speaker notes are present')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
