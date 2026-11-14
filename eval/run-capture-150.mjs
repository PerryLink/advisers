#!/usr/bin/env node
/** Synthetic 150-case capture stress. Usage: DEEPSEEK_API_KEY=... node eval/run-capture-150.mjs */
import { captureCandidates } from '../packages/advisers/lib/capture.js'

const key = process.env.DEEPSEEK_API_KEY || process.env.ADVISERS_API_KEY
if (!key) { console.error('set DEEPSEEK_API_KEY'); process.exit(1) }
const names = ['王工', '李总', '张经理', '陈老师', '赵总', '周工', '吴总', '郑经理', '孙工', '钱总']
const things = ['报价', '预算表', '合同', '会议纪要', '方案', '周报', '验收材料', '数据', '发票', '排期']
const iso = (d) => d.toISOString().slice(0, 10)
const nextWeekday = (from, weekday) => {
  const d = new Date(from)
  const delta = (weekday - d.getDay() + 7) % 7 || 7
  d.setDate(d.getDate() + delta)
  return d
}
const base = new Date('2026-11-12T10:00:00+08:00')
const cases = []
for (let i = 0; i < 30; i++) {
  const name = names[i % names.length]; const thing = things[i % things.length]
  const date = new Date(base); date.setDate(date.getDate() + (i % 7))
  const friday = nextWeekday(date, 5)
  cases.push({ id: `u-${i}`, text: `${name}：周五前把${thing}发我。我：好的，我周五前发。`, date: date.toISOString(), expect: { action: `发${thing}`, due: iso(friday), modal: 'firm' } })
  cases.push({ id: `t-${i}`, text: `${name}说下周一给${thing}。`, date: date.toISOString(), expect: { action: `给${thing}`, due: iso(nextWeekday(date, 1)), modal: 'firm' } })
  cases.push({ id: `c-${i}`, text: `如果客户确认，我周三前把${thing}发给他。`, date: date.toISOString(), expect: { action: `发${thing}`, due: iso(nextWeekday(date, 3)), modal: 'conditional' } })
  cases.push({ id: `k-${i}`, text: `乙方应于 2027 年 1 月 10 日前交付${thing}。`, date: date.toISOString(), expect: { action: `交付${thing}`, due: '2027-01-10', modal: 'firm' } })
  cases.push({ id: `v-${i}`, text: `我回头把${thing}发你。`, date: date.toISOString(), expect: { action: `发${thing}`, due: null, modal: 'tentative' } })
}
let expected = 0; let found = 0; let dueOk = 0; let auto = 0
const failures = []
const chunks = Array.from({ length: 5 }, (_, n) => cases.filter((_, i) => i % 5 === n))
await Promise.all(chunks.map(async (chunk) => {
  for (const item of chunk) {
    const { candidates } = await captureCandidates({ text: item.text, apiKey: key, date: item.date, source: 'synthetic' })
    expected++
    const match = candidates.find((c) => c.action === item.expect.action || c.action.includes(item.expect.action.replace(/^(发|给|交付)/, '')))
    if (!match) { failures.push({ id: item.id, text: item.text, expect: item.expect, got: candidates.map((c) => c.action) }); continue }
    found++
    const localDue = match.dueAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(match.dueAt)) : null
    if (localDue === item.expect.due) dueOk++
    if (candidates.some((c) => c.confirmed)) auto++
  }
}))
console.log(JSON.stringify({ cases: cases.length, found, recall: found / expected, dueOk, autoConfirmed: auto, failures: failures.slice(0, 10) }, null, 2))
if (found / expected < 0.9) process.exitCode = 1
