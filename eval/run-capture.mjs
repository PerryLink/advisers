#!/usr/bin/env node
/** Real-model capture eval. Usage: DEEPSEEK_API_KEY=... node eval/run-capture.mjs */
import { readFileSync } from 'node:fs'
import { captureCandidates } from '../packages/advisers/lib/capture.js'

if (!process.env.DEEPSEEK_API_KEY && !process.env.ADVISERS_API_KEY) {
  console.error('set DEEPSEEK_API_KEY or ADVISERS_API_KEY')
  process.exit(1)
}
const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ADVISERS_API_KEY
const cases = readFileSync(new URL('./corpus/commitments.zh.jsonl', import.meta.url), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
let expected = 0
let found = 0
let quoteValid = 0
let dueOk = 0
let dueTotal = 0
let autoConfirmed = 0
const failures = []
for (const item of cases) {
  const { candidates } = await captureCandidates({ text: item.text, apiKey, date: item.date, source: item.source })
  for (const want of item.expect || []) {
    expected++
    const match = candidates.find((c) => c.action === want.action || c.action.includes(want.action))
    if (!match) { failures.push(`${item.id}: missing ${want.action}`); continue }
    found++
    if (match.quote.includes(want.quote) || want.quote.includes(match.quote)) quoteValid++
    const localDue = match.dueAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(match.dueAt)) : null
    if (want.due || want.dueAlt) {
      dueTotal++
      if (localDue === want.due || (want.dueAlt && localDue === want.dueAlt)) dueOk++
      else failures.push(`${item.id}: due ${localDue} != ${want.due}${want.dueAlt ? ` (alt ${want.dueAlt})` : ''}`)
    }
    if (match.modal !== want.modal) failures.push(`${item.id}: modal ${match.modal} != ${want.modal}`)
  }
  autoConfirmed += candidates.filter((c) => c.confirmed).length
  console.error(`${item.id}: ${candidates.length} candidates`)
}
const recall = expected ? found / expected : 0
console.log(JSON.stringify({ cases: cases.length, expected, found, recall, quoteValid, dueOk, dueTotal, dueRate: dueTotal ? dueOk / dueTotal : 0, autoConfirmed, failures }, null, 2))
if (autoConfirmed > 0 || (expected && recall < 0.7)) process.exitCode = 1
