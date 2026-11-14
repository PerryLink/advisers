#!/usr/bin/env node
/** 40-defect Office review set. Usage: DEEPSEEK_API_KEY=... node eval/run-office-40.mjs */
import { buildDocx, readOffice, officeToText } from '../packages/office/dist/index.js'
import { reviewDocument } from '../packages/advisers/lib/doc-review.js'

const key = process.env.DEEPSEEK_API_KEY || process.env.ADVISERS_API_KEY
if (!key) { console.error('set DEEPSEEK_API_KEY'); process.exit(1) }
const types = [
  ['sum', (i) => ({ text: `差旅 ${80 + i}，外包 40，合计 100。`, request: `合计应为 ${120 + i}，检查合计。` })],
  ['placeholder', (i) => ({ text: `TODO 待补充案例 ${i}。`, request: '交付前检查是否还有占位符。' })],
  ['client', (i) => ({ text: `客户：华兴公司${i}。`, request: '客户名应为“华星”。' })],
  ['date', (i) => ({ text: `交付日期：2026-11-${[18, 19, 21, 22][i % 4]}。`, request: '交付日期应为 2026-11-20。' })],
  ['owner', (i) => ({ text: `负责人：张三${i}。`, request: '负责人应为李四。' })],
  ['unit', (i) => ({ text: `合同金额：100 元${i}。`, request: '金额单位应为万元。' })],
  ['contradiction', (i) => ({ text: `项目开始 2026-12-01，结束 2026-11-0${1 + (i % 5)}。`, request: '检查起止日期是否矛盾。' })],
  ['missing_total', (i) => ({ text: `差旅 ${80 + i}，外包 40。`, request: '预算表必须包含合计。' })],
  ['percent', (i) => ({ text: `本季度增长 30%${i}。`, request: '增长率应为 20%。' })],
  ['duplicate', (i) => ({ text: `客户 A：100 万；客户 A：120 万${i}。`, request: '同一客户不应重复且金额应一致。' })],
]
const cases = []
for (const [type, make] of types) for (let i = 0; i < 4; i++) cases.push({ id: `${type}-${i + 1}`, type, ...make(i) })
let caught = 0
const failures = []
const chunks = Array.from({ length: 4 }, (_, n) => cases.filter((_, i) => i % 4 === n))
await Promise.all(chunks.map(async (chunk) => {
  for (const item of chunk) {
    const buffer = await buildDocx({ title: '审阅样本', sections: [{ heading: '正文', paragraphs: [item.text] }] })
    const doc = await readOffice(buffer)
    const result = await reviewDocument({ text: officeToText(doc, 10_000), request: item.request, apiKey: key })
    const blocker = result.findings.some((f) => f.severity === 'blocker')
    if (blocker) caught++
    else failures.push({ id: item.id, text: item.text, findings: result.findings })
    console.log(`${blocker ? 'CAUGHT' : 'MISS'} ${item.id}`)
  }
}))
console.log(JSON.stringify({ cases: cases.length, caught, miss: failures.length, failures }, null, 2))
if (caught < 32) process.exitCode = 1
