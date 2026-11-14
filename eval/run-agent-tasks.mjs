#!/usr/bin/env node
/**
 * Eight real-model agent tasks (docx / xlsx / pptx / cross-file summary /
 * contract edit / path-escape recovery / scanned PDF / weekly email).
 *
 * Usage: ADVISERS_API_KEY=... [TASKS=docx,xlsx,...] node eval/run-agent-tasks.mjs
 *
 * Each task = setup (temp files) + prompt(s) sent through `advisers chat` +
 * assertions. Every CLI call runs in a throw-away ADVISERS_HOME/work tree with
 * ADVISERS_FORCE=1 and a 300 s timeout. This eval needs a real model key and is
 * NOT run in CI: without a key it exits 1 immediately.
 *
 * stdout carries one JSON document (per-task PASS/FAIL details + failure
 * summary); progress goes to stderr. The temp tree is removed in a finally
 * block. Key material is redacted from captured output.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLI_TIMEOUT_MS = 300_000
const evalDir = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = join(evalDir, '../packages/advisers/bin/advisers.js')

// The office dist imports ~10 s worth of dependencies, so load it lazily: the
// no-key path must fail fast instead of paying that startup cost.
let officeModule
async function loadOffice() {
  if (!officeModule) officeModule = await import('../packages/office/dist/index.js')
  return officeModule
}

function check(name, ok, detail = '') {
  return { name, ok: Boolean(ok), detail: String(detail ?? '') }
}

function redact(text) {
  const key = process.env.ADVISERS_API_KEY || process.env.DEEPSEEK_API_KEY
  const value = String(text ?? '')
  return key ? value.split(key).join('[redacted]') : value
}

function writeWorkFile(ctx, rel, content) {
  const abs = join(ctx.work, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

async function checkOfficeFile(ctx, rel) {
  const abs = join(ctx.work, rel)
  if (!existsSync(abs)) return { checks: [check(`${rel} 存在`, false, 'missing')], text: null }
  const checks = [check(`${rel} 存在`, true, `${statSync(abs).size} bytes`)]
  try {
    const { officeToText, readOffice } = await loadOffice()
    const doc = await readOffice(readFileSync(abs))
    const text = officeToText(doc, 20_000)
    checks.push(check(`${rel} 可解析`, true, `${doc.kind || '?'} / ${text.length} chars`))
    return { checks, text }
  } catch (error) {
    checks.push(check(`${rel} 可解析`, false, String(error?.message || error).slice(0, 240)))
    return { checks, text: null }
  }
}

function addContains(checks, label, text, tokens) {
  for (const token of tokens) {
    const ok = text.includes(token)
    checks.push(check(`${label} 含「${token}」`, ok, ok ? 'ok' : `实际文本：${text.replace(/\s+/g, ' ').slice(0, 220)}`))
  }
}

function checkTextFile(ctx, rel, tokens) {
  const abs = join(ctx.work, rel)
  if (!existsSync(abs)) return [check(`${rel} 存在`, false, 'missing')]
  const text = readFileSync(abs, 'utf8')
  const checks = [
    check(`${rel} 存在`, true, `${Buffer.byteLength(text)} bytes`),
    check(`${rel} 非空`, text.trim().length > 0, `${text.trim().length} chars`),
  ]
  addContains(checks, rel, text, tokens)
  return checks
}

function checkNoFile(ctx, rel, label) {
  const abs = join(ctx.work, rel)
  const leaked = existsSync(abs)
  return check(label, !leaked, leaked ? `LEAKED: ${abs}` : `未创建（${rel}）`)
}

function runCheck(run, name) {
  if (!run) return check(name, false, '未执行')
  if (run.timedOut) return check(name, false, `timeout after ${CLI_TIMEOUT_MS}ms`)
  if (!run.ok) return check(name, false, `exit ${run.exitCode ?? 'null'}${run.error ? ` / ${run.error}` : ''}`)
  return check(name, true, `exit 0 / ${run.durationMs}ms`)
}

function runCli(ctx, text, files = []) {
  const args = [ctx.cli, 'chat']
  for (const file of files) args.push('--file', file)
  args.push(text)
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, args, {
    cwd: ctx.work,
    env: ctx.env,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
  })
  const timedOut = result.error?.code === 'ETIMEDOUT' || Boolean(result.error && /timed?\s*out/i.test(String(result.error.message || '')))
  return {
    prompt: text,
    files,
    ok: !timedOut && !result.error && result.status === 0,
    exitCode: result.status,
    timedOut,
    error: result.error ? String(result.error.message || result.error) : '',
    durationMs: Date.now() - startedAt,
    output: `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim(),
  }
}

/**
 * Minimal valid PDF with an empty content stream (no embedded fonts, no text).
 * pdfjs parses it fine and attachments.js turns the empty extraction into the
 * "no extractable text ... (scanned PDF?)" graceful-failure path.
 */
export function minimalPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

export const TASKS = [
  {
    id: 'docx',
    title: 'docx 周报',
    prompt: '做一份周报 Word，放到 out/week.docx，标题写“周报”，内容写“本周完成 A 客户报价”。',
    async assert(ctx) {
      const { checks, text } = await checkOfficeFile(ctx, 'out/week.docx')
      if (text) addContains(checks, 'out/week.docx', text, ['周报', '报价'])
      return checks
    },
  },
  {
    id: 'xlsx',
    title: 'xlsx 预算表',
    prompt: '做一个 Q4 预算 Excel，放到 out/budget.xlsx，列：项目、金额；行：差旅 80、外包 40。',
    async assert(ctx) {
      const { checks, text } = await checkOfficeFile(ctx, 'out/budget.xlsx')
      if (text) addContains(checks, 'out/budget.xlsx', text, ['差旅', '80', '外包', '40'])
      return checks
    },
  },
  {
    id: 'pptx',
    title: 'pptx 3 页复盘',
    prompt: '做一个 3 页 PPT，放到 out/deck.pptx，主题“Q4 复盘”；第 1 页标题，第 2 页进展，第 3 页下一步。',
    async assert(ctx) {
      const { checks, text } = await checkOfficeFile(ctx, 'out/deck.pptx')
      if (text) {
        addContains(checks, 'out/deck.pptx', text, ['Q4'])
        const slides = (text.match(/\[\[slide\d+\]\]/g) || []).length
        checks.push(check('out/deck.pptx 至少 3 页', slides >= 3, `${slides} slides`))
      }
      return checks
    },
  },
  {
    id: 'summary',
    title: '跨文件汇总 docx',
    async setup(ctx) {
      writeWorkFile(ctx, 'notes/a.txt', 'A 项目周报素材（客户 alpha）\n本周完成：报价 3 份；已签合同金额 137 万元；客户满意度 92 分。\n风险：无。\n')
      writeWorkFile(ctx, 'notes/b.txt', 'B 项目周报素材（客户 beta）\n本周完成：差旅支出 8 万元；外包支出 26 万元，合计 34 万元。\n风险：外包交付延期 2 天。\n')
    },
    prompt: '读取 notes/a.txt 和 notes/b.txt，把两份周报素材汇总成一份 Word 文档放到 out/summary.docx；文档中必须同时包含 A 项目的合同金额 137 万元和 B 项目的支出合计 34 万元。',
    async assert(ctx) {
      const { checks, text } = await checkOfficeFile(ctx, 'out/summary.docx')
      if (text) addContains(checks, 'out/summary.docx', text, ['137', '34'])
      return checks
    },
  },
  {
    id: 'contract',
    title: '读合同改金额',
    async setup(ctx) {
      const { buildDocx } = await loadOffice()
      const buffer = await buildDocx({
        title: '采购合同',
        sections: [{
          heading: '合同条款',
          paragraphs: [
            '甲方：华兴科技；乙方：本方公司。',
            '合同金额：120 万元。',
            '付款节点：签约后 30 日内支付。',
          ],
        }],
      })
      writeWorkFile(ctx, 'in/contract.docx', buffer)
    },
    prompt: '读取 in/contract.docx，把合同金额从 120 万元改为 150 万元，另存为 out/contract-v2.docx。',
    async assert(ctx) {
      const { checks, text } = await checkOfficeFile(ctx, 'out/contract-v2.docx')
      if (text) addContains(checks, 'out/contract-v2.docx', text, ['150'])
      return checks
    },
  },
  {
    id: 'escape',
    title: '越界写保护 + 失败恢复',
    prompt: '用 file_write 工具把“越界测试”写到 ../escape.docx，不要改用其他路径。',
    followUp: '刚才那个路径越界了；请改成写到 out/safe.docx，做成一份 Word 文档，内容写“越界测试”。',
    async assert(ctx, runs) {
      const checks = [
        checkNoFile(ctx, '../escape.docx', '父目录没有逃逸文件 escape.docx'),
        runCheck(runs[0], '越界尝试的 CLI 调用未崩溃'),
        runCheck(runs[1], '恢复写 safe.docx 的 CLI 调用未崩溃'),
      ]
      checks.push(...(await checkOfficeFile(ctx, 'out/safe.docx')).checks)
      return checks
    },
  },
  {
    id: 'pdf',
    title: '扫描版 PDF 优雅失败',
    async setup(ctx) {
      writeWorkFile(ctx, 'in/scan.pdf', minimalPdf())
    },
    files: ['in/scan.pdf'],
    prompt: '请读取 in/scan.pdf，并总结其中的关键内容。',
    async assert(ctx, runs) {
      const run = runs[0]
      const output = run?.output || ''
      const lower = output.toLowerCase()
      const keywords = ['no extractable text', 'scanned', '无法读取', '无法提取', '无文本', '扫描', '不支持', 'not supported', 'encrypted', 'password']
      const hit = keywords.find((word) => lower.includes(word.toLowerCase()))
      const stack = /(^|\n)\s+at\s+[^\n]+:\d+:\d+/.test(output)
      return [
        runCheck(run, 'PDF 任务的 CLI 调用未崩溃'),
        check('输出说明了 PDF 无法提取文本', Boolean(hit), hit ? `匹配「${hit}」` : output.replace(/\s+/g, ' ').slice(0, 240)),
        check('输出没有 Node 堆栈', !stack, stack ? output.replace(/\s+/g, ' ').slice(0, 240) : 'ok'),
        check('没有超时', !run?.timedOut, run?.timedOut ? `timeout after ${CLI_TIMEOUT_MS}ms` : 'ok'),
      ]
    },
  },
  {
    id: 'email',
    title: '周报 + 邮件',
    async setup(ctx) {
      writeWorkFile(ctx, 'notes/week-a.txt', '本周完成：客户 alpha 的报价 3 份，合同金额 137 万元。\n下周计划：拜访客户 beta，确认交付排期。\n')
      writeWorkFile(ctx, 'notes/week-b.txt', '本周风险：外包交付延期 2 天；预算剩余 34 万元。\n需要决策：是否追加 5 万元外包预算。\n')
    },
    prompt: '读取 notes/week-a.txt 和 notes/week-b.txt，写一封周报邮件到 out/weekly-email.md，邮件正文要包含两个文件的关键信息（金额数字）。',
    async assert(ctx) {
      return checkTextFile(ctx, 'out/weekly-email.md', ['137', '34'])
    },
  },
]

export function selectTasks(raw = process.env.TASKS) {
  const wanted = String(raw || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
  if (!wanted.length) return TASKS
  const ids = TASKS.map((task) => task.id)
  const unknown = wanted.filter((id) => !ids.includes(id))
  if (unknown.length) throw new Error(`unknown TASKS: ${unknown.join(',')} (valid: ${ids.join(',')})`)
  return TASKS.filter((task) => wanted.includes(task.id))
}

function serializeRun(run) {
  return {
    prompt: redact(run.prompt),
    ok: run.ok,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    outputTail: redact(run.output).replace(/\s+/g, ' ').slice(-400),
  }
}

async function runTask(task, ctx) {
  const startedAt = Date.now()
  const runs = []
  const checks = []
  try {
    if (task.setup) await task.setup(ctx)
    const steps = [{ prompt: task.prompt, files: task.files || [] }]
    if (task.followUp) steps.push({ prompt: task.followUp, files: [] })
    for (const [index, step] of steps.entries()) {
      const run = runCli(ctx, step.prompt, step.files)
      runs.push(run)
      checks.push(runCheck(run, `CLI 调用 ${index + 1}`))
    }
    checks.push(...(await task.assert(ctx, runs)))
  } catch (error) {
    checks.push(check('任务执行未抛异常', false, String(error?.message || error).slice(0, 300)))
  }
  return {
    id: task.id,
    title: task.title,
    ok: checks.length > 0 && checks.every((item) => item.ok),
    durationMs: Date.now() - startedAt,
    runs: runs.map(serializeRun),
    checks,
  }
}

export async function main() {
  const key = process.env.ADVISERS_API_KEY || process.env.DEEPSEEK_API_KEY
  if (!key) {
    console.error('ADVISERS_API_KEY (or DEEPSEEK_API_KEY) is required: this eval calls a real model and is not run in CI')
    process.exit(1)
    return
  }
  const selected = selectTasks()
  const startedAt = Date.now()
  const root = mkdtempSync(join(tmpdir(), 'advisers-agent-tasks-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  const childEnv = {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_API_KEY: key,
    ADVISERS_MODEL: process.env.ADVISERS_MODEL || 'deepseek-flash',
    ADVISERS_FORCE: '1',
  }
  delete childEnv.ADVISERS_NO_MODEL
  const ctx = { root, home, work, cli: CLI_PATH, env: childEnv }

  const results = []
  try {
    for (const [index, task] of selected.entries()) {
      console.error(`[${index + 1}/${selected.length}] ${task.id}: ${task.title}`)
      const result = await runTask(task, ctx)
      results.push(result)
      console.error(`${result.ok ? 'PASS' : 'FAIL'} ${task.id} (${result.durationMs}ms)`)
      if (!result.ok) for (const item of result.checks.filter((entry) => !entry.ok)) console.error(`  - ${item.name}: ${item.detail}`)
    }
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {}
  }

  const passed = results.filter((result) => result.ok).length
  const summary = {
    model: process.env.ADVISERS_MODEL || 'deepseek-flash',
    cliTimeoutMs: CLI_TIMEOUT_MS,
    elapsedMs: Date.now() - startedAt,
    tasks: results.length,
    passed,
    failed: results.length - passed,
    results,
    failures: results.filter((result) => !result.ok).map((result) => ({
      id: result.id,
      failedChecks: result.checks.filter((item) => !item.ok),
      outputTail: result.runs.map((run) => run.outputTail).join(' | ').slice(0, 800),
    })),
  }
  console.log(JSON.stringify(summary, null, 2))
  if (summary.failed > 0) process.exitCode = 1
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error(`[fatal] ${error?.message || error}`)
    process.exitCode = 1
  }
}
