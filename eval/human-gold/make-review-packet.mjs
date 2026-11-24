#!/usr/bin/env node
/**
 * Build a blind, independently-reviewable packet for the Chinese commitment
 * corpus. Reviewers label from the case text only; the existing reference labels
 * live in `adjudicator-only/reference-labels.jsonl` so they cannot be copied.
 *
 * Usage:
 *   node eval/human-gold/make-review-packet.mjs \
 *     [--corpus eval/corpus/gold/commitments.zh.gold.reviewed.jsonl] \
 *     [--out <dir outside the repo>] [--limit 60] [--reviewers reviewer-a,reviewer-b]
 *
 * The packet is written outside the repository by default (OS temp dir): real
 * anonymized cases and reviewer labels must not be committed. A packet inside
 * the repo is refused so synthetic-only data cannot slip in by habit either.
 *
 * Output: cases.tsv, labels-<reviewer>.tsv (blank), adjudication.tsv (blank),
 * adjudicator-only/reference-labels.jsonl, annotation-guide.zh.md, README.md,
 * manifest.json (packet format v2: corpus sha256, row count, reviewers).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative as relativePath, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ADJUDICATION_HEADER, LABEL_HEADER, sha256File } from './agreement-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '../..')
const DEFAULT_CORPUS = join(here, '../corpus/gold/commitments.zh.gold.reviewed.jsonl')

const args = process.argv.slice(2)
function flag(name, fallback) {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const corpusPath = resolve(flag('corpus', DEFAULT_CORPUS))
const out = resolve(flag('out', join(tmpdir(), 'advisers-human-gold-packet-' + stamp)))
const reviewers = String(flag('reviewers', 'reviewer-a,reviewer-b')).split(',').map((id) => id.trim()).filter(Boolean)
const limit = flag('limit', null) === null ? null : Number(flag('limit', null))

function fail(message) { console.error('advisers human-gold packet: ' + message); process.exit(1) }

if (!existsSync(corpusPath)) fail('corpus not found: ' + corpusPath)
if (!reviewers.length) fail('--reviewers needs at least one reviewer id')
if (limit !== null && (!Number.isInteger(limit) || limit < 1)) fail('--limit must be a positive integer')
const outRelative = relativePath(REPO_ROOT, out).replaceAll('\\', '/')
if (outRelative !== '..' && !outRelative.startsWith('../') && !isAbsolute(outRelative)) fail('--out must be outside the repository (' + REPO_ROOT + '); packets/reviewer labels are not committed')

const corpusBytes = readFileSync(corpusPath)
const corpusSha256 = createHash('sha256').update(corpusBytes).digest('hex')
const allRows = corpusBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
  let row
  try { row = JSON.parse(line) } catch (error) { throw new Error('invalid JSONL at line ' + (index + 1) + ': ' + error.message) }
  if (!row || typeof row.id !== 'string' || !row.id) throw new Error('invalid JSONL at line ' + (index + 1) + ': missing id')
  if (typeof row.text !== 'string' || !row.text) throw new Error('invalid JSONL at line ' + (index + 1) + ': missing text')
  return row
})
if (!allRows.length) fail('corpus has no rows')
let rows = allRows
let selection = { mode: 'all', limit: null }
if (limit !== null) {
  if (limit > allRows.length) fail('--limit ' + limit + ' exceeds corpus rows ' + allRows.length)
  // Deterministic pilot subset: lowest sha256(id) order, then restored to corpus order.
  const ranked = [...allRows].sort((left, right) => {
    const leftHash = createHash('sha256').update(left.id).digest('hex')
    const rightHash = createHash('sha256').update(right.id).digest('hex')
    return leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : 0
  })
  const chosen = new Set(ranked.slice(0, limit).map((row) => row.id))
  rows = allRows.filter((row) => chosen.has(row.id))
  selection = { mode: 'sha256-lowest-id', limit }
}

mkdirSync(out, { recursive: true })
mkdirSync(join(out, 'adjudicator-only'), { recursive: true })

const esc = (value) => String(value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
const tsv = ['id\tsource\tdate\ttext']
for (const row of rows) tsv.push([row.id, row.source, row.date, esc(row.text)].join('\t'))
writeFileSync(join(out, 'cases.tsv'), tsv.join('\n') + '\n')

for (const reviewer of reviewers) writeFileSync(join(out, 'labels-' + reviewer + '.tsv'), LABEL_HEADER.join('\t') + '\n')
writeFileSync(join(out, 'adjudication.tsv'), ADJUDICATION_HEADER.join('\t') + '\n')
writeFileSync(join(out, 'adjudicator-only/reference-labels.jsonl'), rows.map((row) => JSON.stringify({ id: row.id, expect: row.expect ?? [] })).join('\n') + '\n')

const caseIdsSha256 = createHash('sha256').update(rows.map((row) => row.id).join('\n') + '\n').digest('hex')
const manifest = {
  format: 'advisers-human-gold-packet',
  version: 2,
  corpus: relativePath(REPO_ROOT, corpusPath).startsWith('..') ? corpusPath : relativePath(REPO_ROOT, corpusPath),
  corpusSha256,
  rows: rows.length,
  selection,
  caseIdsSha256,
  reviewers,
  generatedAt: new Date().toISOString(),
  annotationGuide: 'annotation-guide.zh.md',
  referenceLabels: 'adjudicator-only/reference-labels.jsonl',
  note: 'Reviewers must label from cases.tsv only. reference-labels.jsonl is for the adjudicator after both reviews; do not open adjudicator-only/ before that. Label one row per commitment, in case-text order; a case with no commitment gets no row.',
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
writeFileSync(join(out, 'annotation-guide.zh.md'), readFileSync(join(here, 'annotation-guide.zh.md'), 'utf8'))
writeFileSync(join(out, 'README.md'), readFileSync(join(here, 'README.md'), 'utf8')
  .replaceAll('{{OUT}}', out).replaceAll('{{CORPUS_SHA256}}', corpusSha256).replaceAll('{{ROWS}}', String(rows.length)))
console.log(JSON.stringify({ out, rows: rows.length, corpusSha256, reviewers, selection }, null, 2))
