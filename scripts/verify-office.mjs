#!/usr/bin/env node
/**
 * Structural + optional application-open verification for Office artifacts.
 *
 * Every artifact is checked through verifyOffice(), whose result carries a
 * machine-readable checks array (id / ok / severity / detail / skipped).
 * LibreOffice is optional: when it is missing the PDF layer is reported as
 * skipped, never as a pass. Formula recalculation uses the optional
 * ADVISERS_VERIFY_RECALC_CMD hook and is likewise skipped when unconfigured.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDocx, buildPptx, buildXlsx, containsText, verifyOffice } from '../packages/office/dist/index.js'

const dir = mkdtempSync(join(tmpdir(), 'advisers-office-verify-'))

function findLibreOffice() {
  const binary = process.env.LIBREOFFICE || 'libreoffice'
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore', timeout: 10_000 })
    return binary
  } catch {
    return null
  }
}

function statusOf(check) {
  return check.skipped ? 'SKIP' : check.ok ? 'ok' : 'FAIL'
}

try {
  const artifacts = [
    {
      kind: 'docx',
      text: '预算可控',
      buffer: await buildDocx({
        title: 'Office 验证',
        sections: [{ heading: '结论', paragraphs: ['预算可控'], table: { headers: ['项', '值'], rows: [['a', '1']] } }],
      }),
    },
    {
      kind: 'xlsx',
      text: '市场',
      buffer: await buildXlsx({
        sheet: '预算',
        columns: [{ header: '项目', key: 'item' }, { header: '金额', key: 'amount', numFmt: '#,##0' }],
        rows: [{ item: '市场', amount: 120 }],
      }),
    },
    {
      kind: 'pptx',
      text: '预算可控',
      buffer: await buildPptx({ title: 'Office 验证', slides: [{ title: '结论', bullets: ['预算可控'] }] }),
    },
  ]

  const libreoffice = findLibreOffice()
  const results = []
  for (const artifact of artifacts) {
    const result = await verifyOffice(artifact.buffer, artifact.kind)
    const textOk = await containsText(artifact.buffer, artifact.text)
    let pdf = 'skipped (LibreOffice not found)'
    if (libreoffice) {
      const file = join(dir, 'verify.' + artifact.kind)
      writeFileSync(file, artifact.buffer)
      try {
        execFileSync(libreoffice, ['--headless', '--convert-to', 'pdf', '--outdir', dir, file], { stdio: 'ignore', timeout: 60_000 })
        pdf = 'ok'
      } catch (error) {
        pdf = 'failed: ' + (error instanceof Error ? error.message : String(error))
      }
    }
    const pdfOk = pdf === 'ok' || pdf.startsWith('skipped')
    results.push({
      kind: artifact.kind,
      ok: result.ok && textOk && pdfOk,
      checks: result.checks,
      entries: result.entries,
      bytes: result.bytes,
      layers: result.layers,
      text: textOk,
      pdf,
    })
  }

  let allOk = true
  for (const result of results) {
    const passed = result.checks.filter((check) => check.ok && !check.skipped).length
    const failed = result.checks.filter((check) => !check.ok && !check.skipped).length
    const skipped = result.checks.filter((check) => check.skipped).length
    console.log(
      result.kind + '\t' + (result.ok ? 'PASS' : 'FAIL') +
      '\tchecks: ' + passed + ' ok / ' + failed + ' failed / ' + skipped + ' skipped' +
      '\tentries=' + result.entries + '\tbytes=' + result.bytes +
      '\ttext=' + (result.text ? 'OK' : 'MISSING') + '\tpdf=' + result.pdf,
    )
    for (const check of result.checks) {
      console.log('  - ' + statusOf(check) + ' ' + check.id + ' [' + check.severity + '] ' + check.detail)
    }
    if (!result.ok) allOk = false
  }

  console.log('')
  console.log('Windows manual checklist:')
  console.log('- open each file in Word/Excel/PowerPoint; no "repair" dialog')
  console.log('- Chinese text is not tofu; table borders/width look sane')
  console.log('- Excel total formula recalculates; dates show the intended day')
  console.log('- PPT slide count and speaker notes are present')
  console.log('')
  console.log(JSON.stringify({ ok: allOk, pdfLayer: libreoffice ? 'ok' : 'skipped (LibreOffice not found)', artifacts: results }, null, 2))
  console.log('')
  console.log(allOk ? 'PASS' : 'FAIL')
  process.exitCode = allOk ? 0 : 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
