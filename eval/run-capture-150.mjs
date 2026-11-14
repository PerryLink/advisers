#!/usr/bin/env node
/**
 * Synthetic 150-case capture stress. Usage: DEEPSEEK_API_KEY=... node eval/run-capture-150.mjs
 *
 * Label convention (v2): a "周X/周三前" said on that same weekday resolves to
 * today (natural reading). The previous generator expected the next week in
 * that case; those 9 ambiguous cases now carry `dueAlt` (legacy strict label)
 * so we can report both readings instead of silently moving the goalposts:
 *   - dueRate        accepts due or dueAlt (ambiguous labels either way)
 *   - dueRateStrict  natural label only
 *   - dueRateLegacy  legacy label only (comparable to the old 84.7%)
 *
 * This set is synthetic, not the human gold set. Never cite it as a benchmark.
 */
import { captureCandidates } from '../packages/advisers/lib/capture.js'

const key = process.env.DEEPSEEK_API_KEY || process.env.ADVISERS_API_KEY
if (!key) { console.error('set DEEPSEEK_API_KEY'); process.exit(1) }
const names = ['王工', '李总', '张经理', '陈老师', '赵总', '周工', '吴总', '郑经理', '孙工', '钱总']
const things = ['报价', '预算表', '合同', '会议纪要', '方案', '周报', '验收材料', '数据', '发票', '排期']
const iso = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d)
const nextWeekday = (from, weekday) => {
  const d = new Date(from)
  const delta = (weekday - d.getDay() + 7) % 7 || 7
  d.setDate(d.getDate() + delta)
  return d
}
// Natural reading: same weekday -> today; otherwise the upcoming weekday.
const naturalWeekday = (from, weekday) => {
  const d = new Date(from)
  if (d.getDay() === weekday) return d
  return nextWeekday(d, weekday)
}
const base = new Date('2026-11-12T10:00:00+08:00')
const cases = []
let ambiguous = 0
for (let i = 0; i < 30; i++) {
  const name = names[i % names.length]
  const thing = things[i % things.length]
  const date = new Date(base)
  date.setDate(date.getDate() + (i % 7))
  const friday = naturalWeekday(date, 5)
  const fridayLegacy = nextWeekday(date, 5)
  const wednesday = naturalWeekday(date, 3)
  const wednesdayLegacy = nextWeekday(date, 3)
  const fridayCase = { due: iso(friday) }
  if (iso(friday) !== iso(fridayLegacy)) { fridayCase.dueAlt = iso(fridayLegacy); ambiguous++ }
  const wednesdayCase = { due: iso(wednesday) }
  if (iso(wednesday) !== iso(wednesdayLegacy)) { wednesdayCase.dueAlt = iso(wednesdayLegacy); ambiguous++ }
  cases.push({ id: `u-${i}`, text: `${name}：周五前把${thing}发我。我：好的，我周五前发。`, date: date.toISOString(), expect: { action: `发${thing}`, ...fridayCase, modal: 'firm' } })
  cases.push({ id: `t-${i}`, text: `${name}说下周一给${thing}。`, date: date.toISOString(), expect: { action: `给${thing}`, due: iso(nextWeekday(date, 1)), modal: 'firm' } })
  cases.push({ id: `c-${i}`, text: `如果客户确认，我周三前把${thing}发给他。`, date: date.toISOString(), expect: { action: `发${thing}`, ...wednesdayCase, modal: 'conditional' } })
  cases.push({ id: `k-${i}`, text: `乙方应于 2027 年 1 月 10 日前交付${thing}。`, date: date.toISOString(), expect: { action: `交付${thing}`, due: '2027-01-10', modal: 'firm' } })
  cases.push({ id: `v-${i}`, text: `我回头把${thing}发你。`, date: date.toISOString(), expect: { action: `发${thing}`, due: null, modal: 'tentative' } })
}

let expected = 0
let found = 0
let dueOk = 0
let dueOkStrict = 0
let dueOkLegacy = 0
let ruleDue = 0
let auto = 0
const failures = []
const chunks = Array.from({ length: 5 }, (_, n) => cases.filter((_, i) => i % 5 === n))
await Promise.all(chunks.map(async (chunk) => {
  for (const item of chunk) {
    const { candidates } = await captureCandidates({ text: item.text, apiKey: key, date: item.date, source: 'synthetic' })
    expected++
    const match = candidates.find((c) => c.action === item.expect.action || c.action.includes(item.expect.action.replace(/^(发|给|交付)/, '')))
    if (!match) {
      failures.push({ id: item.id, kind: 'missing-action', text: item.text, expect: item.expect, got: candidates.map((c) => `${c.action}@${c.dueAt ?? 'null'}`) })
      continue
    }
    found++
    if (match.dueBasis === 'rule') ruleDue++
    const localDue = match.dueAt ? iso(new Date(match.dueAt)) : null
    const strictDue = item.expect.due
    const legacyDue = item.expect.dueAlt ?? item.expect.due
    if (localDue === strictDue) dueOkStrict++
    if (localDue === legacyDue) dueOkLegacy++
    if (localDue === strictDue || (item.expect.dueAlt && localDue === item.expect.dueAlt)) dueOk++
    else failures.push({ id: item.id, kind: 'due', text: item.text, expected: strictDue, expectedAlt: item.expect.dueAlt, got: localDue, basis: match.dueBasis })
    if (candidates.some((c) => c.confirmed)) auto++
  }
}))

const total = expected
const dueRate = total ? dueOk / total : 0
const dueRateStrict = total ? dueOkStrict / total : 0
const dueRateLegacy = total ? dueOkLegacy / total : 0
const result = {
  cases: cases.length,
  expected: total,
  found,
  recall: total ? found / total : 0,
  dueOk,
  dueRate,
  dueOkStrict,
  dueRateStrict,
  dueOkLegacy,
  dueRateLegacy,
  ambiguousCases: ambiguous,
  ruleDue,
  autoConfirmed: auto,
  failures: failures.slice(0, 30),
  failureCount: failures.length,
}
console.log(JSON.stringify(result, null, 2))
if (found / total < 0.9) process.exitCode = 1
if (dueRate < 0.95) process.exitCode = 1
if (auto > 0) process.exitCode = 1
