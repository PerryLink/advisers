/**
 * `advisers demo` — one command that demonstrates the "顾问一单" (consultant's
 * first deal) workflow on fully synthetic data (0.5.0 U2b; plan 124 §3).
 *
 * Design constraints (enforced here, not in bin):
 *  - ISOLATED HOME: every child command runs with ADVISERS_HOME pointing at a
 *    fresh OS-temp directory (0700, marker file .advisers-demo.json). The real
 *    home is never read or written; passing --home equal to the real home is
 *    refused. A reused --home must carry the demo marker.
 *  - EMBEDDED DATA: the three JSON inputs live in lib/demo-data.js because the
 *    npm tarball ships only bin/lib/README* (no examples/, no docs/).
 *  - ZERO MODEL / ZERO NETWORK: ADVISERS_NO_MODEL=1, ADVISERS_ACCEPT_TOS=1, and
 *    the API/audit-key variables are removed from the child environment.
 *  - REUSE, DON'T REIMPLEMENT: the steps shell out to the existing commands
 *    (matter/client, template quote/proposal/notice, deliveries --receipt,
 *    receivable add, remind --ics, evidence verify). Nothing here opens SQLite
 *    or writes ledger rows itself.
 *  - NO AUTO-DELETE: the demo home is kept and its absolute path returned.
 *    --clean may remove only a directory THIS RUN created, under the OS temp
 *    root, after printing the path, an interactive confirmation, and a
 *    same-root quarantine rename (AGENTS §2 data-safety rule).
 *
 * Payload shape follows 124 §3: {ok, command:'demo', demoHome, out, steps,
 * artifacts, receipt, next, warnings}. Human rendering and the process exit
 * code belong to bin/advisers.js.
 *
 * @module demo
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEMO_CLIENT_NAME,
  DEMO_MARKER_FILE,
  DEMO_MATTER_TITLE,
  demoDataFiles,
  demoMarker,
  demoReceivable,
} from './demo-data.js'

/** Default binary entry used by the demo child processes. */
const BIN_PATH = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
/** Per-step timeout for a child command (the whole demo is ~10 spawns). */
const STEP_TIMEOUT_MS = 180_000

/** Error with a stable code/hint/exitCode that bin maps to a stderr envelope. */
export class DemoError extends Error {
  /**
   * @param {string} code stable error code (E_USAGE / E_IO / E_DEMO_STEP)
   * @param {string} message human message
   * @param {{hint?: string, usage?: string, exitCode?: number}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'DemoError'
    this.code = code
    if (extra.hint) this.hint = extra.hint
    if (extra.usage) this.usage = extra.usage
    this.exitCode = Number.isInteger(extra.exitCode) ? extra.exitCode : 1
  }
}

function realHomePath(env) {
  return resolve(env?.ADVISERS_HOME || join(homedir(), '.advisers'))
}

function isUnder(parent, child) {
  const root = resolve(parent)
  const target = resolve(child)
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Timestamped temp demo home; unique per process so concurrent demos never merge. */
export function defaultDemoHome(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return join(tmpdir(), 'advisers-demo-' + stamp + '-' + randomBytes(3).toString('hex'))
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function quoteArg(value) {
  const text = String(value)
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : '"' + text.replaceAll('"', '\\"') + '"'
}

function displayCommand(argv) {
  return ['advisers', ...argv].map(quoteArg).join(' ')
}

function firstStderrLine(stderr) {
  return String(stderr ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? ''
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(String(stdout ?? ''))
  } catch {
    throw new DemoError('E_DEMO_STEP', label + ': 子命令输出不是有效 JSON', { hint: '运行 advisers doctor 检查本地环境' })
  }
}

/** Child environment: isolated home, TOS pre-accepted, no model, no keys. */
function demoChildEnv({ env, homeDir }) {
  const childEnv = { ...env }
  for (const key of ['ADVISERS_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ADVISERS_AUDIT_KEY']) delete childEnv[key]
  childEnv.ADVISERS_HOME = homeDir
  childEnv.ADVISERS_ACCEPT_TOS = '1'
  childEnv.ADVISERS_NO_MODEL = '1'
  return childEnv
}

/** Default child runner: this Node binary + the same CLI entry (array args only). */
function defaultRunCommand() {
  return (argv, { cwd, env, timeoutMs = STEP_TIMEOUT_MS } = {}) => {
    const result = spawnSync(process.execPath, [BIN_PATH, ...argv], {
      cwd,
      env,
      encoding: 'utf8',
      input: '',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    })
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error ? String(result.error.message ?? result.error) : null,
    }
  }
}

/** Interactive confirmation for --clean (only reached on a TTY). */
async function ttyConfirm(question) {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(question)
    return /^(y|yes|是|确认|同意)$/i.test(String(answer ?? '').trim())
  } finally {
    rl.close()
  }
}

function listArtifacts(rootDir) {
  const artifacts = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry)
      let stats
      try { stats = statSync(full) } catch { continue }
      if (stats.isDirectory()) { walk(full); continue }
      if (!stats.isFile()) continue
      try {
        artifacts.push({ path: full, bytes: stats.size, sha256: sha256File(full) })
      } catch {}
    }
  }
  walk(rootDir)
  artifacts.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return artifacts
}

/**
 * Create/validate the demo home and write the embedded data files.
 * @returns {{homeDir: string, created: boolean}}
 */
function prepareDemoHome({ home, env, now }) {
  const homeDir = resolve(home ?? defaultDemoHome(now))
  const realHome = realHomePath(env)
  if (homeDir === realHome) {
    throw new DemoError('E_IO', 'demo 拒绝使用真实 ADVISERS_HOME 作为演示目录', {
      hint: '换一个 --home，或省略 --home 让 demo 在系统临时目录创建独立 demo home',
    })
  }
  if (homeDir === resolve(homedir())) {
    throw new DemoError('E_IO', 'demo 拒绝使用用户主目录本身作为演示目录', { hint: '使用 --home <新目录>' })
  }
  let created = false
  if (existsSync(homeDir)) {
    let stats
    try { stats = statSync(homeDir) } catch (error) {
      throw new DemoError('E_IO', '无法读取 demo 目录：' + String(error?.message ?? error), { hint: '换一个 --home' })
    }
    if (!stats.isDirectory()) throw new DemoError('E_IO', '--home 指向一个文件而不是目录', { hint: '换一个 --home' })
    if (!existsSync(join(homeDir, DEMO_MARKER_FILE))) {
      throw new DemoError('E_IO', '目录已存在但不是 demo home（缺少 ' + DEMO_MARKER_FILE + ' 标记）', {
        hint: 'demo 只复用自己创建过的目录；换一个 --home 或手动确认并删除该目录后重试',
      })
    }
    let marker = null
    try { marker = JSON.parse(readFileSync(join(homeDir, DEMO_MARKER_FILE), 'utf8')) } catch {}
    if (marker?.kind !== 'advisers-demo') throw new DemoError('E_IO', '目录标记不是有效的 demo home', { hint: '换一个 --home' })
  } else {
    mkdirSync(homeDir, { recursive: true, mode: 0o700 })
    try { chmodSync(homeDir, 0o700) } catch {}
    created = true
    writeFileSync(join(homeDir, DEMO_MARKER_FILE), JSON.stringify(demoMarker(now.toISOString()), null, 2) + '\n', { mode: 0o600 })
  }
  // Embedded synthetic inputs, rewritten each run (deterministic bytes).
  const dataDir = join(homeDir, 'data')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  for (const file of demoDataFiles()) {
    const target = join(homeDir, file.path)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(target, file.content, { mode: 0o600 })
  }
  return { homeDir, created }
}

/**
 * Run the demo.
 *
 * @param {{home?: string, out?: string, clean?: boolean, isTTY?: boolean,
 *          env?: Record<string, string|undefined>, now?: Date,
 *          ports?: {runCommand?: Function, confirm?: Function}}} [options]
 * @returns {Promise<object>} DemoPayload (124 §3)
 */
export async function runDemo(options = {}) {
  const env = options.env ?? process.env
  const now = options.now instanceof Date ? options.now : new Date()
  const isTTY = options.isTTY === true
  const ports = options.ports ?? {}
  const runCommand = typeof ports.runCommand === 'function' ? ports.runCommand : defaultRunCommand()
  const clean = options.clean === true
  const warnings = []
  const steps = []

  if (clean && !isTTY && typeof ports.confirm !== 'function') {
    throw new DemoError('E_USAGE', 'demo --clean 需要交互确认（当前不是 TTY）', {
      hint: '去掉 --clean（demo home 会保留），或在 TTY 中重跑',
      usage: 'usage: advisers demo [--out <dir>] [--home <dir>] [--json] [--clean]',
    })
  }

  const { homeDir, created } = prepareDemoHome({ home: options.home, env, now })
  if (clean && !created) {
    throw new DemoError('E_USAGE', 'demo --clean 只删除本次运行创建的系统临时目录', {
      hint: '该 --home 不是本次创建的；确认目录内容后手动删除，或换一个新的 --home',
      usage: 'usage: advisers demo [--out <dir>] [--home <dir>] [--json] [--clean]',
    })
  }
  const outDir = resolve(options.out ? resolve(options.out) : join(homeDir, 'out'))
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const childEnv = demoChildEnv({ env, homeDir })

  /** Run one child command; throws DemoError with the child's code/first line. */
  const runCli = async (argv, label) => {
    let result
    try {
      result = await runCommand(argv, { cwd: homeDir, env: childEnv, timeoutMs: STEP_TIMEOUT_MS })
    } catch (error) {
      throw new DemoError('E_DEMO_STEP', label + ' 失败：' + String(error?.message ?? error), { hint: '运行 advisers doctor 检查本地环境' })
    }
    if (result?.error) throw new DemoError('E_DEMO_STEP', label + ' 无法启动子进程：' + String(result.error))
    if (result.status !== 0) {
      throw new DemoError('E_DEMO_STEP', label + ' 失败（exit ' + result.status + '）：' + (firstStderrLine(result.stderr) || 'no stderr'), {
        hint: '运行 advisers doctor --check-db 检查本地环境；demo 只写独立临时 home',
      })
    }
    return result
  }
  const push = (record) => { steps.push(record); return record }

  let receipt = null
  try {
    // 1 客户与事项 -------------------------------------------------------
    const matterRun = await runCli(['matter', 'add', DEMO_MATTER_TITLE, '--json'], 'matter add')
    const matter = parseJson(matterRun.stdout, 'matter add').matter
    if (!matter?.id) throw new DemoError('E_DEMO_STEP', 'matter add 未返回 matter.id')
    const clientRun = await runCli(['client', 'add', DEMO_CLIENT_NAME, '--link-matter', matter.id, '--json'], 'client add')
    const client = parseJson(clientRun.stdout, 'client add').client
    if (!client?.id) throw new DemoError('E_DEMO_STEP', 'client add 未返回 client.id')
    await runCli(['matter', 'use', matter.id, '--json'], 'matter use')
    push({
      id: 'client', status: 'applied',
      command: 'advisers client add "' + DEMO_CLIENT_NAME + '" --link-matter <matter> --json',
      checks: ['matter=' + matter.id, 'client=' + client.id],
    })

    // 2 报价 -------------------------------------------------------------
    const quoteRun = await runCli(['template', 'quote', join(homeDir, 'data/quote.json'), join(outDir, 'quote.docx'), '--record-delivery', '--matter', matter.id, '--json'], 'template quote')
    const quote = parseJson(quoteRun.stdout, 'template quote')
    if (quote?.ok !== true || quote?.verify?.structure?.ok !== true) throw new DemoError('E_DEMO_STEP', '报价 docx 结构校验失败')
    if (quote.templateVersion !== '2' || !/^[a-f0-9]{64}$/.test(String(quote.dataSha256 ?? ''))) throw new DemoError('E_DEMO_STEP', '报价未返回 v2 dataSha256')
    push({
      id: 'quote', status: 'applied',
      command: 'advisers template quote data/quote.json out/quote.docx --record-delivery --matter <matter> --json',
      artifact: join(outDir, 'quote.docx'),
      sha256: sha256File(join(outDir, 'quote.docx')),
      checks: ['templateVersion=' + quote.templateVersion, 'quoteNo=' + quote.quoteNo, 'dataSha256=' + quote.dataSha256, 'total=' + (quote.totals?.total ?? '?'), 'verify.structure.ok=true'],
    })

    // 3 提案 -------------------------------------------------------------
    const proposalRun = await runCli(['template', 'proposal', join(homeDir, 'data/proposal.json'), join(outDir, 'proposal.docx'), '--record-delivery', '--matter', matter.id, '--json'], 'template proposal')
    const proposal = parseJson(proposalRun.stdout, 'template proposal')
    if (proposal?.ok !== true || proposal?.verify?.structure?.ok !== true) throw new DemoError('E_DEMO_STEP', '提案 docx 结构校验失败')
    push({
      id: 'proposal', status: 'applied',
      command: 'advisers template proposal data/proposal.json out/proposal.docx --record-delivery --matter <matter> --json',
      artifact: join(outDir, 'proposal.docx'),
      sha256: sha256File(join(outDir, 'proposal.docx')),
      checks: ['templateVersion=' + proposal.templateVersion, 'dataSha256=' + proposal.dataSha256, 'verify.structure.ok=true'],
    })

    // 4 通知（legacy 模板无 --json，用 verify 校验结构） -----------------
    await runCli(['template', 'notice', join(homeDir, 'data/notice.json'), join(outDir, 'notice.docx')], 'template notice')
    if (!existsSync(join(outDir, 'notice.docx'))) throw new DemoError('E_DEMO_STEP', '通知 docx 未生成')
    const noticeVerifyRun = await runCli(['verify', join(outDir, 'notice.docx'), '--json'], 'verify notice')
    const noticeVerify = parseJson(noticeVerifyRun.stdout, 'verify notice')
    if (noticeVerify?.ok !== true) throw new DemoError('E_DEMO_STEP', '通知 docx 结构校验失败')
    push({
      id: 'notice', status: 'applied',
      command: 'advisers template notice data/notice.json out/notice.docx',
      artifact: join(outDir, 'notice.docx'),
      sha256: sha256File(join(outDir, 'notice.docx')),
      checks: ['verify.ok=true'],
    })

    // 5 回执包 -----------------------------------------------------------
    const receiptRun = await runCli(['deliveries', '--receipt', '--client', client.id, '--out', join(outDir, 'receipt'), '--json'], 'deliveries receipt')
    const receiptJson = parseJson(receiptRun.stdout, 'deliveries receipt')
    if (receiptJson?.scope !== 'subject' || receiptJson?.subject?.kind !== 'client' || !/^[a-f0-9]{64}$/.test(String(receiptJson?.manifestDigest ?? ''))) {
      throw new DemoError('E_DEMO_STEP', '回执包未返回 scope=subject 的 manifestDigest')
    }
    receipt = { scope: receiptJson.scope, subject: receiptJson.subject, manifestDigest: receiptJson.manifestDigest, out: resolve(receiptJson.outDir ?? join(outDir, 'receipt')) }
    const manifestPath = join(receipt.out, 'manifest.json')
    push({
      id: 'receipt', status: 'applied',
      command: 'advisers deliveries --receipt --client <client> --out out/receipt --json',
      artifact: manifestPath,
      sha256: existsSync(manifestPath) ? sha256File(manifestPath) : null,
      checks: ['scope=subject', 'subject=' + receipt.subject.id, 'manifestDigest=' + receipt.manifestDigest],
    })

    // 6 回款 -------------------------------------------------------------
    const receivable = demoReceivable(now)
    const receivableRun = await runCli(['receivable', 'add', client.id, receivable.label, '--amount', receivable.amount, '--due', receivable.due, '--json'], 'receivable add')
    const receivableJson = parseJson(receivableRun.stdout, 'receivable add').receivable
    if (!receivableJson?.id) throw new DemoError('E_DEMO_STEP', 'receivable add 未返回 receivable.id')
    push({
      id: 'receivable', status: 'applied',
      command: 'advisers receivable add <client> "首款 30%" --amount ' + receivable.amount + ' --due ' + receivable.due + ' --json',
      checks: ['receivable=' + receivableJson.id, 'commitment=' + receivableJson.commitmentId, 'amount=' + receivable.amount + ' ' + receivable.currency, 'due=' + receivable.due],
    })

    // 7 提醒 .ics（due 由 demoReceivable 动态落在 7 天提醒窗口内） ---------
    const icsPath = join(outDir, 'demo.ics')
    await runCli(['remind', '--ics', icsPath], 'remind --ics')
    const ics = existsSync(icsPath) ? readFileSync(icsPath, 'utf8') : ''
    for (const expected of ['BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:Asia/Shanghai', 'BEGIN:VALARM']) {
      if (!ics.includes(expected)) throw new DemoError('E_DEMO_STEP', '提醒 .ics 缺少 ' + expected)
    }
    push({
      id: 'remind', status: 'applied',
      command: 'advisers remind --ics out/demo.ics',
      artifact: icsPath,
      sha256: sha256File(icsPath),
      checks: ['events=' + (ics.match(/BEGIN:VEVENT/g) ?? []).length, 'timezone=Asia/Shanghai', 'valarm=true'],
    })

    // 8 离线回执校验 -----------------------------------------------------
    const verifyRun = await runCli(['evidence', 'verify', join(outDir, 'receipt'), '--json'], 'evidence verify')
    const verifyJson = parseJson(verifyRun.stdout, 'evidence verify')
    if (verifyJson?.ok !== true) throw new DemoError('E_DEMO_STEP', '回执包离线校验失败')
    push({ id: 'verify', status: 'applied', command: 'advisers evidence verify out/receipt --json', checks: ['ok=true'] })
  } catch (caught) {
    const failure = caught instanceof DemoError ? caught : new DemoError('E_DEMO_STEP', String(caught?.message ?? caught))
    steps.push({ id: 'failed', status: 'failed', command: null, error: { code: failure.code, message: failure.message, ...(failure.hint ? { hint: failure.hint } : {}) } })
    warnings.push('演示停止；已创建的 demo home 保留在 ' + homeDir + '（不会自动删除）。')
    return {
      ok: false,
      command: 'demo',
      demoHome: homeDir,
      out: outDir,
      steps,
      artifacts: listArtifacts(outDir),
      receipt,
      next: [],
      warnings,
      error: { code: failure.code, message: failure.message, ...(failure.hint ? { hint: failure.hint } : {}) },
    }
  }

  const artifacts = listArtifacts(outDir)
  const next = [
    { label: '重新跑同样的演示（复用 demo home）', command: 'advisers demo --home ' + quoteArg(homeDir) + ' --json' },
    { label: '查询演示账本（bash）', command: 'ADVISERS_HOME=' + quoteArg(homeDir) + ' advisers receivable ls --json' },
    { label: '继续了解主题', command: 'advisers help receipt' },
  ]
  let cleanup = null
  if (clean) {
    try {
      cleanup = await cleanupDemoHome({ homeDir, confirm: ports.confirm, isTTY })
    } catch (error) {
      warnings.push('--clean 未执行：' + String(error?.message ?? error))
    }
  }
  return {
    ok: true,
    command: 'demo',
    demoHome: homeDir,
    out: outDir,
    steps,
    artifacts,
    receipt,
    next,
    warnings,
    ...(cleanup ? { cleanup } : {}),
  }
}

/**
 * Remove a demo home this run created (tmp root + marker required, then
 * quarantine rename, then delete the quarantine only).
 * @returns {Promise<{removed: boolean, path: string, reason?: string}>}
 */
async function cleanupDemoHome({ homeDir, confirm, isTTY }) {
  const target = resolve(homeDir)
  const tempRoot = resolve(tmpdir())
  if (!isUnder(tempRoot, target) || target === tempRoot) throw new DemoError('E_USAGE', '--clean 只允许删除系统临时目录下的 demo home')
  if (!existsSync(join(target, DEMO_MARKER_FILE))) throw new DemoError('E_IO', '目标目录缺少 ' + DEMO_MARKER_FILE + ' 标记，拒绝删除')
  // Stage 1: show the absolute path (the prompt itself carries it).
  const question = '将删除本次演示创建的目录：' + target + '\n确认删除？[y/N] '
  let confirmed = false
  if (typeof confirm === 'function') confirmed = (await confirm({ question, path: target })) === true
  else if (isTTY) confirmed = await ttyConfirm(question)
  if (!confirmed) return { removed: false, path: target, reason: 'declined' }
  // Stage 2: quarantine rename inside the temp root (no cross-device risk).
  const quarantine = target + '.trash-' + Date.now() + '-' + randomBytes(3).toString('hex')
  if (!isUnder(tempRoot, quarantine)) throw new DemoError('E_DEMO_STEP', '隔离路径不在系统临时目录内，拒绝删除')
  renameSync(target, quarantine)
  // Stage 3: delete only the directory we just renamed.
  rmSync(quarantine, { recursive: true, force: true })
  return { removed: true, path: target }
}

/** Human lines for bin (plain text, no ANSI). */
export function demoHumanLines(payload) {
  const lines = []
  lines.push(payload?.ok ? 'demo: OK — 全合成「顾问一单」已在独立 demo home 中跑通（0 模型 / 0 网络）' : 'demo: FAILED — 演示未跑完')
  if (payload?.demoHome) {
    const removed = payload?.cleanup?.removed === true
    lines.push('demo home  ' + payload.demoHome + (removed ? '（本次运行创建的目录已删除）' : '（保留，不自动删除）'))
  }
  if (payload?.out) lines.push('out        ' + payload.out)
  for (const step of Array.isArray(payload?.steps) ? payload.steps : []) {
    lines.push('  ' + String(step.id).padEnd(11) + String(step.status) + (step.sha256 ? '  sha256=' + step.sha256.slice(0, 12) : ''))
  }
  if (payload?.receipt) lines.push('receipt    scope=' + payload.receipt.scope + ' subject=' + (payload.receipt.subject?.id ?? '?') + ' manifestDigest=' + String(payload.receipt.manifestDigest).slice(0, 16))
  const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : []
  if (artifacts.length) {
    lines.push('产物：')
    for (const artifact of artifacts) lines.push('  ' + artifact.path + '  ' + artifact.bytes + ' B  sha256=' + String(artifact.sha256).slice(0, 12))
  }
  for (const warning of payload?.warnings ?? []) lines.push('warning: ' + warning)
  if (payload?.error) lines.push('error: ' + payload.error.code + ': ' + payload.error.message + (payload.error.hint ? '\nhint: ' + payload.error.hint : ''))
  const next = Array.isArray(payload?.next) ? payload.next : []
  if (next.length) {
    lines.push('下一步：')
    for (const item of next) lines.push('  ' + item.label + '  ' + item.command)
  }
  return lines
}
