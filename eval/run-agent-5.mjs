#!/usr/bin/env node
/** Five real agent tasks. Usage: DEEPSEEK_API_KEY=... node eval/run-agent-5.mjs */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readOffice } from '../packages/office/dist/index.js'

const key = process.env.DEEPSEEK_API_KEY || process.env.ADVISERS_API_KEY
if (!key) { console.error('set DEEPSEEK_API_KEY'); process.exit(1) }
const root = mkdtempSync(join(tmpdir(), 'advisers-agent5-'))
const home = join(root, 'home'); const work = join(root, 'work')
mkdirSync(work, { recursive: true })
const cli = join(dirname(fileURLToPath(import.meta.url)), '../packages/advisers/bin/advisers.js')
const env = { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_API_KEY: key, ADVISERS_MODEL: 'deepseek-flash', ADVISERS_FORCE: '1' }
const tasks = [
  { id: 'docx', prompt: '做一份周报 Word，放到 out/week.docx，标题写“周报”，内容写“本周完成 A 客户报价”。', file: 'out/week.docx' },
  { id: 'xlsx', prompt: '做一个 Q4 预算 Excel，放到 out/budget.xlsx，列：项目、金额；行：差旅 80、外包 40。', file: 'out/budget.xlsx' },
  { id: 'pptx', prompt: '做一个 3 页 PPT，放到 out/deck.pptx，主题“Q4 复盘”；第 1 页标题，第 2 页进展，第 3 页下一步。', file: 'out/deck.pptx' },
]
const results = []
try {
  for (const task of tasks) {
    let output = ''
    let ok = true
    try { output = execFileSync(process.execPath, [cli, 'chat', task.prompt], { cwd: work, env, encoding: 'utf8', timeout: 300_000 }) } catch (error) { ok = false; output = String(error.stdout || error.message).slice(0, 500) }
    const path = join(work, task.file)
    const exists = existsSync(path)
    let valid = false
    if (exists) {
      try { const doc = await readOffice(await (await import('node:fs/promises')).readFile(path)); valid = Boolean(doc) } catch {}
    }
    results.push({ id: task.id, ok, exists, valid, bytes: exists ? statSync(path).size : 0, output: output.replace(/\s+/g, ' ').slice(-200) })
    console.log(`${valid ? 'PASS' : 'FAIL'} ${task.id} exists=${exists} bytes=${exists ? statSync(path).size : 0}`)
  }
} finally { console.log(JSON.stringify({ results }, null, 2)); rmSync(root, { recursive: true, force: true }) }
if (results.some((r) => !r.valid)) process.exitCode = 1
