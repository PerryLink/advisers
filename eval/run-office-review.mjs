#!/usr/bin/env node
/** Real-model Office review smoke. Usage: DEEPSEEK_API_KEY=... node eval/run-office-review.mjs */
import { buildDocx } from '../packages/office/dist/index.js'
import { readOffice, officeToText } from '../packages/office/dist/index.js'
import { reviewDocument } from '../packages/advisers/lib/doc-review.js'

const key = process.env.DEEPSEEK_API_KEY || process.env.ADVISERS_API_KEY
if (!key) { console.error('set DEEPSEEK_API_KEY'); process.exit(1) }
const cases = [
  { id: 'sum', request: '预算合计应为 120，检查合计是否正确', spec: { title: 'Q4 预算', sections: [{ heading: '合计', paragraphs: ['差旅 80，外包 40，合计 100。'] }] } },
  { id: 'placeholder', request: '交付前检查是否还有占位符', spec: { title: '方案', sections: [{ heading: '内容', paragraphs: ['TODO 待补充客户案例。'] }] } },
  { id: 'client', request: '客户名应为“华星”，检查是否有误', spec: { title: '报价', sections: [{ heading: '客户', paragraphs: ['客户：华兴公司'] }] } },
  { id: 'date', request: '交付日期应为 2026-11-20', spec: { title: '交付', sections: [{ heading: '日期', paragraphs: ['交付日期：2026-11-18'] }] } },
  { id: 'clean', request: '检查有无明显问题', spec: { title: '周报', sections: [{ heading: '进展', paragraphs: ['本周完成 A 客户报价，风险已同步。'] }] } },
]
let caught = 0
for (const item of cases) {
  const buffer = await buildDocx(item.spec)
  const doc = await readOffice(buffer)
  const result = await reviewDocument({ text: officeToText(doc, 10_000), request: item.request, apiKey: key })
  const blocker = result.findings.some((f) => f.severity === 'blocker')
  if (item.id !== 'clean' && blocker) caught++
  console.log(`${item.id}: ${blocker ? 'blocker' : result.findings.length ? 'warn' : 'clear'} ${result.findings.map((f) => f.message).join(' | ')}`)
}
console.log(JSON.stringify({ cases: cases.length, caught, expected: cases.length - 1 }, null, 2))
