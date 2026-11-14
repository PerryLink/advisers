#!/usr/bin/env node
/** Real-model continuity probe. Usage: DEEPSEEK_API_KEY=... node eval/run-continuity.mjs */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const key = process.env.DEEPSEEK_API_KEY || process.env.ADVISERS_API_KEY
if (!key) { console.error('set DEEPSEEK_API_KEY'); process.exit(1) }
const root = mkdtempSync(join(tmpdir(), 'advisers-continuity-'))
const home = join(root, 'home'); const work = join(root, 'work')
mkdirSync(work, { recursive: true })
const cli = join(dirname(fileURLToPath(import.meta.url)), '../packages/advisers/bin/advisers.js')
const env = { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_API_KEY: key, ADVISERS_MODEL: 'deepseek-flash' }
const say = (text) => execFileSync(process.execPath, [cli, 'chat', text], { cwd: work, env, encoding: 'utf8', timeout: 180_000 })
const facts = [
  '我叫阿哲，时区是 Asia/Shanghai。',
  '客户 A 的报价底线是 300 万，绝对不能外发。',
  '客户 B 的预算是 80 万。',
  '我的周报偏好是先给结论。',
  '我答应王工周五前发报价。',
  '客户 C 的负责人是李总。',
  '我的公司叫星河咨询。',
  '写邮件不要用“尊敬的”开头。',
  '客户 D 的项目截止是 12 月 15 日。',
  '我习惯上午处理邮件。',
]
const probes = [
  ['我叫什么？', '阿哲'],
  ['客户 A 的报价底线是多少？', '300'],
  ['客户 B 的预算是多少？', '80'],
  ['我的周报偏好是什么？', '结论'],
  ['我答应了王工什么？', '报价'],
  ['客户 C 的负责人是谁？', '李总'],
  ['我的公司叫什么？', '星河'],
  ['客户 D 的截止日期是什么？', '12'],
]
let passed = 0
try {
  for (const text of facts) { say(text); console.error('stored:', text.slice(0, 20)) }
  for (const [q, expect] of probes) {
    const answer = say(q)
    const ok = answer.includes(expect)
    if (ok) passed++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${q} -> ${answer.replace(/\s+/g, ' ').slice(0, 100)}`)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(JSON.stringify({ probes: probes.length, passed }, null, 2))
if (passed < Math.ceil(probes.length * 0.75)) process.exitCode = 1
