#!/usr/bin/env node
/**
 * Build a blind, independently-reviewable packet for the Chinese commitment
 * corpus. Humans must label from the case text; existing reference labels are
 * kept in a separate adjudicator-only file so reviewers cannot copy them.
 *
 * Usage:
 *   node eval/human-gold/make-review-packet.mjs \
 *     --corpus eval/corpus/gold/commitments.zh.gold.reviewed.jsonl \
 *     --out /tmp/advisers-human-gold-2026-11-14
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const corpusPath = resolve(flag('corpus', join(here, '../corpus/gold/commitments.zh.gold.reviewed.jsonl')))
const out = resolve(flag('out', join(here, 'packet')))
if (!existsSync(corpusPath)) { console.error(`corpus not found: ${corpusPath}`); process.exit(1) }
const rows = readFileSync(corpusPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, i) => {
  try { return JSON.parse(line) } catch { throw new Error(`invalid JSONL at line ${i + 1}`) }
})
mkdirSync(out, { recursive: true })
mkdirSync(join(out, 'adjudicator-only'), { recursive: true })

const esc = (v) => String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
const tsv = ['id\tsource\tdate\ttext']
for (const r of rows) tsv.push([r.id, r.source, r.date, esc(r.text)].join('\t'))
writeFileSync(join(out, 'cases.tsv'), tsv.join('\n') + '\n')

const header = 'id\taction\tdebtor\tcreditor\tdue\tquote\tmodal\tconfidence\tnotes\n'
for (const reviewer of ['reviewer-a', 'reviewer-b']) {
  writeFileSync(join(out, `labels-${reviewer}.tsv`), header)
}
writeFileSync(join(out, 'adjudication.tsv'), 'id\treviewer_a_ok\treviewer_b_ok\tfinal_action\tfinal_due\tnotes\n')
writeFileSync(join(out, 'adjudicator-only/reference-labels.jsonl'), rows.map((r) => JSON.stringify({ id: r.id, expect: r.expect })).join('\n') + '\n')
const sha = createHash('sha256').update(readFileSync(corpusPath)).digest('hex')
writeFileSync(join(out, 'manifest.json'), JSON.stringify({
  format: 'advisers-human-gold-packet', version: 1, corpus: corpusPath, corpusSha256: sha,
  rows: rows.length, reviewers: ['reviewer-a', 'reviewer-b'],
  generatedAt: new Date().toISOString(),
  note: 'Reviewers must label from cases.tsv only. reference-labels.jsonl is for the adjudicator after both reviews.',
}, null, 2) + '\n')
writeFileSync(join(out, 'README.md'), readFileSync(join(here, 'README.md'), 'utf8').replaceAll('{{OUT}}', out).replaceAll('{{CORPUS_SHA256}}', sha).replaceAll('{{ROWS}}', String(rows.length)))
console.log(JSON.stringify({ out, rows: rows.length, corpusSha256: sha }, null, 2))
