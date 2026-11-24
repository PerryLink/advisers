#!/usr/bin/env node
/**
 * Cohen's kappa for the two independent human-gold label sheets.
 *
 * Usage:
 *   node eval/human-gold/compute-agreement.mjs --a labels-reviewer-a.tsv \
 *     --b labels-reviewer-b.tsv [--out agreement.json] [--threshold 0.70]
 *
 * Both reviewers must label every case in the packet (including cases with no
 * commitment). Commitments are aligned in the order each reviewer wrote them, so
 * reviewers must record multiple commitments in the order they appear in the
 * case text (the annotation guide says so). Fields compared: action, debtor,
 * creditor, due, quote, modal. A missing side counts as its own label, so an
 * extra/missing commitment lowers agreement instead of being silently ignored.
 *
 * The gate is the frozen threshold from plan 123/97: overall (micro) Cohen's
 * kappa >= 0.70 before a human gold set may be frozen. Per-field kappa is
 * reported next to it but does not replace the gate. When kappa is undefined
 * (all labels in one category) the gate is `null`, not a fabricated pass.
 *
 * The output contains counts and kappa only: no case text, no raw label values.
 * Exit codes: 0 computed (gate pass or fail is in the JSON); 1 input error;
 * 2 usage error.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  DEFAULT_KAPPA_THRESHOLD,
  computeAgreement,
  parseLabelSheet,
  sha256File,
} from './agreement-lib.mjs'

const USAGE = [
  'usage: node eval/human-gold/compute-agreement.mjs --a <tsv> --b <tsv> [--out <agreement.json>] [--threshold 0.70]',
  '',
  '  --a/--b        the two independent reviewer label sheets',
  '  --out          write agreement.json (default: print JSON to stdout)',
  '  --threshold    kappa gate (default ' + DEFAULT_KAPPA_THRESHOLD + ')',
].join('\n')

function fail(message) { console.error('advisers human-gold agreement: ' + message); process.exit(1) }
function usageFail(message) { console.error('advisers human-gold agreement: ' + message + '\n\n' + USAGE); process.exit(2) }

function parseArgs(argv) {
  const options = { a: null, b: null, out: null, threshold: DEFAULT_KAPPA_THRESHOLD }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0) }
    else if (arg === '--a') options.a = argv[++index] ?? ''
    else if (arg === '--b') options.b = argv[++index] ?? ''
    else if (arg === '--out') options.out = argv[++index] ?? ''
    else if (arg === '--threshold') options.threshold = Number(argv[++index])
    else usageFail('unknown argument: ' + arg)
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.a || !options.b) usageFail('--a and --b are required')
  if (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1) usageFail('--threshold must be a number in [0, 1]')
  for (const path of [options.a, options.b]) if (!existsSync(resolve(path))) fail('label sheet not found: ' + path)
  const aPath = resolve(options.a)
  const bPath = resolve(options.b)
  const aText = readFileSync(aPath, 'utf8')
  const bText = readFileSync(bPath, 'utf8')
  let a
  let b
  try { a = parseLabelSheet(aText, { file: aPath }) } catch (error) { fail(error.message) }
  try { b = parseLabelSheet(bText, { file: bPath }) } catch (error) { fail(error.message) }
  const aIds = new Set(a.ids)
  const bIds = new Set(b.ids)
  const onlyA = [...aIds].filter((id) => !bIds.has(id))
  const onlyB = [...bIds].filter((id) => !aIds.has(id))
  if (onlyA.length || onlyB.length) {
    fail('reviewer sheets cover different id sets (' + onlyA.length + ' only in --a, ' + onlyB.length + ' only in --b; e.g. ' + [...onlyA, ...onlyB].slice(0, 5).join(', ') + '); both reviewers must label the same packet')
  }
  const ids = [...aIds].sort()
  const agreement = computeAgreement({
    a: { ...a, file: aPath, sha256: sha256File(aPath) },
    b: { ...b, file: bPath, sha256: sha256File(bPath) },
    ids,
    threshold: options.threshold,
  })
  agreement.generatedAt = new Date().toISOString()
  const body = JSON.stringify(agreement, null, 2) + '\n'
  if (options.out) {
    const out = resolve(options.out)
    writeFileSync(out, body)
    console.log('reviewers: a=' + agreement.reviewers.a.rows + ' commitment row(s), b=' + agreement.reviewers.b.rows + ' commitment row(s)')
    console.log('cases: ' + agreement.cases + ', commitment slots: ' + agreement.commitmentSlots + ', exact case agreement: ' + agreement.caseAgreement.exact + '/' + agreement.cases)
    for (const [field, entry] of Object.entries(agreement.perField)) {
      console.log('  ' + field.padEnd(9) + ' n=' + String(entry.n).padEnd(4) + ' observed=' + String(entry.observedAgreement).padEnd(6) + ' kappa=' + String(entry.kappa))
    }
    console.log('overall kappa=' + String(agreement.overall.kappa) + ' (macro mean over ' + agreement.overall.definedFields + ' defined field(s), threshold ' + options.threshold + ')')
    console.log((agreement.gate.passed === true ? 'PASS ' : agreement.gate.passed === false ? 'FAIL ' : 'UNKNOWN ') + 'human-gold kappa gate: ' + agreement.gate.reason)
    console.log('agreement: ' + out)
  } else {
    process.stdout.write(body)
  }
  return 0
}

try { process.exit(main()) } catch (error) { console.error('advisers human-gold agreement: internal error: ' + String(error?.stack ?? error)); process.exit(1) }
