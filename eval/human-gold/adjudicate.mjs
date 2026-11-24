#!/usr/bin/env node
/**
 * Freeze an independent human-gold set from two reviewer sheets.
 *
 * Usage:
 *   node eval/human-gold/adjudicate.mjs \
 *     --a labels-reviewer-a.tsv --b labels-reviewer-b.tsv \
 *     --adjudication adjudication.tsv --corpus eval/corpus/gold/commitments.zh.gold.reviewed.jsonl \
 *     --reviewer-a-id reviewer-a --reviewer-b-id reviewer-b \
 *     --reviewed-at 2027-01-05T10:00:00+08:00 --out /tmp/advisers-human-gold-frozen \
 *     [--reference adjudicator-only/reference-labels.jsonl] [--threshold 0.70] [--dry-run]
 *
 * The script never invents human labels. It refuses to freeze when:
 *   - either sheet is blank / covers a different id set;
 *   - the two reviewers disagree and adjudication.tsv has no decision;
 *   - overall Cohen's kappa is undefined or below the frozen threshold;
 *   - --reviewed-at or the anonymous reviewer ids are missing.
 *
 * On success it writes `commitments.zh.gold.human.v1.jsonl` (final agreed
 * commitments, review_mode `human_double_review`, pending_human_review false)
 * and `manifest.json` (corpus sha256, subset ids sha256, kappa, reviewers,
 * reviewed_at, output sha256, gate result). The optional reference labels are
 * used for a count-only comparison against the existing agent-reviewed labels;
 * they never fill a final value.
 *
 * This is the only path that may set a human-gold provenance: until real people
 * finish this workflow, quality reports keep `unknowns.humanGold = null`.
 *
 * Exit codes: 0 frozen; 1 gate/input failure (manifest records the failed gate
 * when --out is given); 2 usage error. --dry-run never writes or freezes.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative as relativePath, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_KAPPA_THRESHOLD,
  LABEL_FIELDS,
  computeAgreement,
  normalizeFieldValue,
  parseAdjudicationSheet,
  parseLabelSheet,
  readCorpusJsonl,
  sha256File,
} from './agreement-lib.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const USAGE = [
  'usage: node eval/human-gold/adjudicate.mjs --a <tsv> --b <tsv> --adjudication <tsv> --corpus <jsonl>',
  '       --reviewer-a-id <id> --reviewer-b-id <id> --reviewed-at <ISO> --out <dir>',
  '       [--reference <jsonl>] [--threshold 0.70] [--dry-run]',
].join('\n')

function fail(message) { console.error('advisers human-gold adjudicate: ' + message); process.exit(1) }
function usageFail(message) { console.error('advisers human-gold adjudicate: ' + message + '\n\n' + USAGE); process.exit(2) }

function parseArgs(argv) {
  const options = {
    a: null, b: null, adjudication: null, corpus: null, reference: null, out: null,
    reviewerA: null, reviewerB: null, reviewedAt: null, threshold: DEFAULT_KAPPA_THRESHOLD, dryRun: false,
  }
  const needed = { '--a': 'a', '--b': 'b', '--adjudication': 'adjudication', '--corpus': 'corpus', '--reference': 'reference', '--out': 'out', '--reviewer-a-id': 'reviewerA', '--reviewer-b-id': 'reviewerB', '--reviewed-at': 'reviewedAt' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0) }
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--threshold') options.threshold = Number(argv[++index])
    else if (needed[arg]) options[needed[arg]] = argv[++index] ?? ''
    else usageFail('unknown argument: ' + arg)
  }
  return options
}

function sameCommitments(left, right) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    for (const field of LABEL_FIELDS) {
      if ((left[index].normalized[field] || '') !== (right[index].normalized[field] || '')) return false
    }
  }
  return true
}

function finalRows(rows) {
  return rows.map((row) => ({ fields: { ...row.fields }, normalized: { ...row.normalized } }))
}

function toGoldRow(corpusRow, commitments, { reviewers, reviewedAt, corpusSha256 }) {
  const expect = commitments.map((commitment) => ({
    action: commitment.fields.action,
    debtor: commitment.fields.debtor,
    creditor: commitment.fields.creditor || null,
    due: commitment.fields.due || null,
    quote: commitment.fields.quote,
    modal: commitment.fields.modal,
  }))
  return {
    id: corpusRow.id,
    source: corpusRow.source,
    date: corpusRow.date,
    text: corpusRow.text,
    expect,
    provenance: corpusRow.provenance ?? 'synthetic',
    pending_human_review: false,
    review_mode: 'human_double_review',
    reviewers: [...reviewers],
    reviewed_at: reviewedAt,
    corpus_sha256: corpusSha256,
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const missing = ['a', 'b', 'adjudication', 'corpus', 'reviewerA', 'reviewerB', 'reviewedAt', 'out'].filter((key) => !options[key])
  if (missing.length) usageFail('missing required argument(s): ' + missing.join(', '))
  if (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1) usageFail('--threshold must be a number in [0, 1]')
  const reviewedAt = new Date(options.reviewedAt)
  if (Number.isNaN(reviewedAt.getTime())) usageFail('--reviewed-at must be an ISO-8601 instant')
  const paths = { a: resolve(options.a), b: resolve(options.b), adjudication: resolve(options.adjudication), corpus: resolve(options.corpus) }
  for (const [key, path] of Object.entries(paths)) if (!existsSync(path)) fail(key + ' file not found: ' + path)
  if (options.reference) { options.reference = resolve(options.reference); if (!existsSync(options.reference)) fail('reference file not found: ' + options.reference) }

  const aText = readFileSync(paths.a, 'utf8')
  const bText = readFileSync(paths.b, 'utf8')
  const corpus = readCorpusJsonl(paths.corpus)
  let a
  let b
  let adjudication
  try { a = parseLabelSheet(aText, { file: paths.a }) } catch (error) { fail(error.message) }
  try { b = parseLabelSheet(bText, { file: paths.b }) } catch (error) { fail(error.message) }
  try { adjudication = parseAdjudicationSheet(readFileSync(paths.adjudication, 'utf8'), { file: paths.adjudication }) } catch (error) { fail(error.message) }

  const aIds = new Set(a.ids)
  const bIds = new Set(b.ids)
  const onlyA = [...aIds].filter((id) => !bIds.has(id))
  const onlyB = [...bIds].filter((id) => !aIds.has(id))
  if (onlyA.length || onlyB.length) fail('reviewer sheets cover different id sets (' + onlyA.length + ' only in --a, ' + onlyB.length + ' only in --b)')
  const ids = [...aIds].sort()
  const unknown = ids.filter((id) => !corpus.has(id))
  if (unknown.length) fail(unknown.length + ' labelled id(s) are not in the corpus (e.g. ' + unknown.slice(0, 3).join(', ') + ')')

  const agreement = computeAgreement({
    a: { ...a, file: paths.a, sha256: sha256File(paths.a) },
    b: { ...b, file: paths.b, sha256: sha256File(paths.b) },
    ids,
    threshold: options.threshold,
  })

  const finalById = new Map()
  const unresolved = []
  const adjudicated = []
  const inconsistent = []
  for (const id of ids) {
    const aRows = a.rows.get(id) ?? []
    const bRows = b.rows.get(id) ?? []
    const decision = adjudication.get(id)
    const consensus = sameCommitments(aRows, bRows)
    if (consensus) {
      if (decision && decision.agree === 'no') inconsistent.push(id + ' (adjudication says no, reviewers agree)')
      finalById.set(id, finalRows(aRows))
      continue
    }
    if (!decision) { unresolved.push(id); continue }
    if (decision.agree === 'yes') { inconsistent.push(id + ' (adjudication says yes, reviewers disagree)'); continue }
    if (!decision.final) { unresolved.push(id); continue }
    finalById.set(id, decision.final)
    adjudicated.push(id)
  }
  if (inconsistent.length) fail('adjudication sheet contradicts the label sheets: ' + inconsistent.slice(0, 5).join('; '))
  if (unresolved.length) fail(unresolved.length + ' case(s) disagree between reviewers and have no adjudication (e.g. ' + unresolved.slice(0, 5).join(', ') + '); fill adjudication.tsv')

  const subsetSha256 = createHash('sha256').update(ids.join('\n') + '\n').digest('hex')
  const corpusSha256 = sha256File(paths.corpus)
  const manifestBase = {
    format: 'advisers-human-gold-manifest',
    version: 1,
    reviewMode: 'human_double_review',
    reviewers: [options.reviewerA, options.reviewerB],
    reviewerSheets: {
      a: { file: paths.a, sha256: sha256File(paths.a), rows: a.rowCount },
      b: { file: paths.b, sha256: sha256File(paths.b), rows: b.rowCount },
    },
    adjudicationSheet: { file: paths.adjudication, sha256: sha256File(paths.adjudication) },
    corpusSha256,
    subset: { rows: ids.length, idsSha256: subsetSha256 },
    reviewedAt: reviewedAt.toISOString(),
    kappa: {
      threshold: options.threshold,
      method: agreement.overall.method,
      overall: agreement.overall.kappa,
      definedFields: agreement.overall.definedFields,
      undefinedFields: agreement.overall.undefinedFields,
      micro: agreement.overall.micro,
      perField: Object.fromEntries(Object.entries(agreement.perField).map(([field, entry]) => [field, entry.kappa])),
    },
    agreement: { ...agreement, reviewers: agreement.reviewers },
    adjudicatedCases: adjudicated.length,
    generatedAt: new Date().toISOString(),
  }

  if (options.reference) {
    const reference = readCorpusJsonl(options.reference)
    let compared = 0
    let matched = 0
    for (const id of ids) {
      const expected = reference.get(id)?.expect
      if (!Array.isArray(expected)) continue
      compared += 1
      const final = finalById.get(id) ?? []
      if (expected.length !== final.length) continue
      const clean = final.every((row, index) => {
        const want = expected[index] ?? {}
        return (row.normalized.action || '') === (normalizeFieldValue('action', want.action ?? '') || '') &&
          (row.normalized.due || '') === (normalizeFieldValue('due', want.due ?? '') || '') &&
          (row.normalized.debtor || '') === (normalizeFieldValue('debtor', want.debtor ?? '') || '')
      })
      if (clean) matched += 1
    }
    manifestBase.referenceComparison = { file: options.reference, sha256: sha256File(options.reference), comparedCases: compared, exactMatches: matched, note: 'count-only comparison; reference labels never fill a final value' }
  }

  const gatePassed = agreement.gate.passed === true
  if (!gatePassed) {
    const manifest = { ...manifestBase, frozen: false, gate: agreement.gate, output: null }
    if (!options.dryRun) {
      const outDir = resolve(options.out)
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    }
    console.error('FAIL human-gold kappa gate: ' + agreement.gate.reason + ' (kappa=' + String(agreement.overall.kappa) + ', threshold ' + options.threshold + ')')
    console.error('not frozen: re-label / re-adjudicate; do not publish a human-gold claim. manifest written with frozen:false')
    return 1
  }

  const goldRows = ids.map((id) => toGoldRow(corpus.get(id), finalById.get(id) ?? [], { reviewers: [options.reviewerA, options.reviewerB], reviewedAt: reviewedAt.toISOString(), corpusSha256 }))
  const goldBody = goldRows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  const goldSha256 = createHash('sha256').update(goldBody).digest('hex')
  const manifest = {
    ...manifestBase,
    frozen: true,
    gate: agreement.gate,
    output: { file: 'commitments.zh.gold.human.v1.jsonl', rows: goldRows.length, sha256: goldSha256 },
  }
  if (options.dryRun) {
    console.log('PASS human-gold dry-run: ' + ids.length + ' case(s) resolvable, kappa=' + agreement.overall.kappa + ', would freeze ' + goldRows.length + ' row(s)')
    return 0
  }
  const outDir = resolve(options.out)
  const outRelative = relativePath(REPO_ROOT, outDir)
  if (outRelative !== '..' && !outRelative.startsWith('../')) {
    console.warn('WARNING output directory is inside the repository: commit it only for consented synthetic cases; real anonymized gold files stay outside the tree')
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'commitments.zh.gold.human.v1.jsonl'), goldBody)
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log('PASS human-gold frozen: ' + goldRows.length + ' case(s), kappa=' + agreement.overall.kappa + ', adjudicated=' + adjudicated.length)
  console.log('output: ' + join(outDir, 'commitments.zh.gold.human.v1.jsonl'))
  console.log('manifest: ' + join(outDir, 'manifest.json'))
  return 0
}

try { process.exit(main()) } catch (error) { console.error('advisers human-gold adjudicate: internal error: ' + String(error?.stack ?? error)); process.exit(1) }
