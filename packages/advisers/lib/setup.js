/**
 * `advisers setup` — planned/idempotent first-run wizard (0.5.0 U2a; plan 124 §2).
 *
 * The TOS decision is NOT taken here. bin/advisers.js owns the only TOS gate:
 * `inspectSetupTos()` is a pure read that lets bin decide "accepted / record the
 * --accept-tos flag / prompt on a TTY / exit 3 with a byte-empty HOME". That is
 * what makes `setup` safe to add to TOS_EXEMPT_COMMANDS: a rejected first run
 * must create no home, no state.db and no `tos.block` audit row.
 *
 * What runSetup writes (idempotent; never overwrites existing files):
 *   <home>/           0700
 *   <home>/audit.key  0600, only when missing and no ADVISERS_AUDIT_KEY
 *   <home>/state.db   schema v22 via the shared SqliteStore (created once)
 *   <home>/soul.md + soul.meta.json, only when missing (--name applies here)
 * plus optional child commands: `mail import` (--mail eml:<path>) and the
 * synthetic `demo` (lib/demo.js, independent temp home).
 *
 * It never writes tos.json, never writes a tos.* audit row, never stores an API
 * key, never calls the network and never touches the real HOME when `home` is
 * the isolated ADVISERS_HOME (the caller decides which home is real).
 *
 * Payload shape follows 124 §2.2: {ok, command:'setup', mode, steps, doctor,
 * tos, soul, model, mail, demo, wouldWrite?, next, warnings}. JSON printing and
 * the process exit code belong to bin.
 *
 * @module setup
 */

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPreflight } from './preflight.js'
import { runDemo } from './demo.js'
import { acceptanceStatus, currentTos, readManifest, resolveConsent } from './tos/index.js'

/** Ordered setup step ids (payload + tests iterate them). */
export const SETUP_STEP_IDS = Object.freeze(['env', 'tos', 'init', 'model', 'mail', 'demo', 'next'])

/** Default soul written by `init` (0.4.3 wording, parameterised by --name). */
const DEFAULT_SOUL = '你是我的幕僚：直接、简洁、有用。\n你是我生活里的客人：私事保持私密。\n如果你要改这个文件，先告诉我。\n'

/** Error with a stable code/hint/usage/exitCode for bin to render. */
export class SetupError extends Error {
  /**
   * @param {string} code stable error code (E_USAGE / E_TOS_REQUIRED / E_IO / E_TERM_REQUIRED)
   * @param {string} message human message
   * @param {{hint?: string, usage?: string, exitCode?: number}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'SetupError'
    this.code = code
    if (extra.hint) this.hint = extra.hint
    if (extra.usage) this.usage = extra.usage
    this.exitCode = Number.isInteger(extra.exitCode) ? extra.exitCode : 1
  }
}

function defaultHome(env) {
  return resolve(env?.ADVISERS_HOME || join(homedir(), '.advisers'))
}

/** 3 copy-pasteable "next steps" cards (124 §2.1 step 7; topics are same-source). */
export function setupNextCards() {
  return [
    { label: '做一份报价（确定性模板）', command: 'advisers template quote <data.json> out/quote.docx --json' },
    { label: '设一条承诺提醒', command: 'advisers commit add "周五前发报价" --quote "周五前发报价" --due 2026-12-05' },
    { label: '生成离线可校验的回执包', command: 'advisers deliveries --receipt --client <client-id> --out out/receipt --json' },
  ]
}

/**
 * Pure read of the TOS facts setup needs. Writes nothing (no tos.json, no
 * audit row, no home). bin uses `explicit` to record a --accept-tos/env
 * acceptance itself, and `accepted:false` + non-TTY to exit 3 before any write.
 *
 * @param {{home?: string, acceptTosFlag?: unknown, env?: Record<string,string|undefined>, isTTY?: boolean}} [options]
 * @returns {{accepted: boolean, channel: string|null, version: string, sha256: string,
 *            reason: string, explicit: null|{ok: boolean, channel?: string, error?: string},
 *            error: string|null}}
 */
export function inspectSetupTos(options = {}) {
  const env = options.env ?? process.env
  const isTTY = options.isTTY === true
  const manifest = readManifest()
  const info = currentTos({ version: manifest.version })
  const status = acceptanceStatus({ home: options.home ?? defaultHome(env), version: info.version, sha256: info.sha256 })
  const explicit = status.accepted
    ? null
    : resolveConsent({ flag: options.acceptTosFlag, env: env.ADVISERS_ACCEPT_TOS, version: info.version, isTTY })
  return {
    accepted: status.accepted,
    channel: status.record?.channel ?? (explicit?.ok ? explicit.channel : null),
    version: info.version,
    sha256: info.sha256,
    reason: status.reason,
    explicit,
    error: explicit?.error ?? null,
  }
}

/** Files a setup apply would create in the given home (read-only plan). */
function plannedWrites({ homeDir, env }) {
  const writes = []
  if (!existsSync(homeDir)) writes.push(homeDir)
  const keyFromEnv = typeof env?.ADVISERS_AUDIT_KEY === 'string' && env.ADVISERS_AUDIT_KEY.trim().length >= 16
  if (!keyFromEnv && !existsSync(join(homeDir, 'audit.key'))) writes.push(join(homeDir, 'audit.key'))
  if (!existsSync(join(homeDir, 'state.db'))) writes.push(join(homeDir, 'state.db'))
  if (!existsSync(join(homeDir, 'soul.md'))) writes.push(join(homeDir, 'soul.md'))
  if (!existsSync(join(homeDir, 'soul.meta.json'))) writes.push(join(homeDir, 'soul.meta.json'))
  return writes
}

function soulContent(options) {
  if (typeof options.soulFile === 'string' && options.soulFile) {
    let content
    try { content = readFileSync(resolve(options.soulFile), 'utf8') } catch (error) {
      throw new SetupError('E_IO', '无法读取 --soul-file：' + String(error?.message ?? error), { hint: '检查文件路径与权限' })
    }
    if (!content.trim()) throw new SetupError('E_IO', '--soul-file 内容为空', { hint: 'soul 文件至少要有一行文字' })
    return content
  }
  const name = typeof options.name === 'string' ? options.name.trim() : ''
  if (!name) return DEFAULT_SOUL
  const first = '你是' + name + '的幕僚：直接、简洁、有用。'
  return [first, ...DEFAULT_SOUL.split('\n').slice(1)].join('\n')
}

/** Create the home dir 0700; verify an existing path is a directory. */
function ensureHomeDirectory(homeDir) {
  if (existsSync(homeDir)) {
    let stats
    try { stats = statSync(homeDir) } catch (error) {
      throw new SetupError('E_IO', '无法读取 HOME：' + String(error?.message ?? error), { hint: '检查 ADVISERS_HOME 权限' })
    }
    if (!stats.isDirectory()) throw new SetupError('E_IO', 'ADVISERS_HOME 是一个文件而不是目录', { hint: '设置 ADVISERS_HOME 到一个目录' })
    try { chmodSync(homeDir, 0o700) } catch {}
    return false
  }
  try { mkdirSync(homeDir, { recursive: true, mode: 0o700 }) } catch (error) {
    throw new SetupError('E_IO', '无法创建 HOME：' + String(error?.message ?? error), { hint: '检查上级目录权限或设置 ADVISERS_HOME' })
  }
  try { chmodSync(homeDir, 0o700) } catch {}
  return true
}

/**
 * Ensure <home>/audit.key exists (0600, never overwritten). Mirrors the bin
 * ensureAuditKey contract: a short/unreadable key is a hard error, because
 * regenerating it would make the existing audit chain verify as BROKEN.
 */
function ensureAuditKeyFile(homeDir, env) {
  const fromEnv = typeof env?.ADVISERS_AUDIT_KEY === 'string' ? env.ADVISERS_AUDIT_KEY.trim() : ''
  if (fromEnv.length >= 16) return { created: false, source: 'env' }
  const target = join(homeDir, 'audit.key')
  for (let attempt = 0; attempt < 8; attempt++) {
    if (existsSync(target)) {
      let key = ''
      try { key = readFileSync(target, 'utf8').trim() } catch (error) {
        throw new SetupError('E_IO', '无法读取 audit.key：' + String(error?.message ?? error), { hint: '恢复 ~/.advisers/audit.key 后重试；不要重建，否则旧审计链会验证为 BROKEN' })
      }
      if (key.length < 16) throw new SetupError('E_IO', 'audit.key 太短（' + key.length + ' 字符）', { hint: '恢复原始 audit.key；不要重建，否则旧审计链会验证为 BROKEN' })
      return { created: false, source: 'file' }
    }
    // O_EXCL + fsync: two first runs agree on exactly one key (bin uses the
    // same rule); the loser reads the winner's file instead of overwriting it.
    const temp = join(homeDir, '.audit.key.tmp-' + process.pid + '-' + randomBytes(4).toString('hex'))
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeSync(fd, randomBytes(32).toString('hex'))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      renameSync(temp, target)
      return { created: true, source: 'generated' }
    } catch (error) {
      try { rmSync(temp, { force: true }) } catch {}
      if (error?.code === 'EEXIST' || existsSync(target)) continue
      throw new SetupError('E_IO', '无法写入 audit.key：' + String(error?.message ?? error), { hint: '检查 HOME 权限' })
    }
  }
  throw new SetupError('E_IO', '无法创建 audit.key（并发写入冲突）', { hint: '重试 advisers setup' })
}

/** Create <home>/state.db with the current schema, only when missing. */
async function ensureDatabaseFile(homeDir) {
  const dbPath = join(homeDir, 'state.db')
  if (existsSync(dbPath)) return { created: false }
  const { SqliteStore } = await import('./sqlite.js')
  let store = null
  try { store = new SqliteStore(dbPath) } finally {
    try { store?.close() } catch {}
  }
  return { created: true }
}

/** Create soul.md + soul.meta.json, only when missing (never overwrite). */
function ensureSoulFiles(homeDir, options, nowIso) {
  const soulPath = join(homeDir, 'soul.md')
  const metaPath = join(homeDir, 'soul.meta.json')
  if (existsSync(soulPath)) return { present: true, created: false }
  const content = soulContent(options)
  writeFileSync(soulPath, content, { mode: 0o600 })
  writeFileSync(metaPath, JSON.stringify({ version: 1, updatedAt: nowIso }, null, 2) + '\n', { mode: 0o600 })
  return { present: true, created: true }
}

/** Child environment for setup's own subprocesses (mail import, demo). */
function setupChildEnv({ env, homeDir }) {
  const childEnv = { ...env }
  for (const key of ['ADVISERS_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ADVISERS_AUDIT_KEY']) delete childEnv[key]
  childEnv.ADVISERS_HOME = homeDir
  return childEnv
}

/** Default child runner (array args; no shell). */
function defaultRunCommand() {
  return async (argv, { cwd, env, timeoutMs = 180_000 } = {}) => {
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync(process.execPath, [fileURLForBin(), ...argv], {
      cwd, env, encoding: 'utf8', input: '', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    })
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error ? String(result.error.message ?? result.error) : null,
    }
  }
}

function fileURLForBin() {
  return fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
}

/** Reusable child-step helpers shared by plan (status only) and apply. */
function stepRecord(id, status, detail, extra = {}) {
  return { id, status, ...(detail ? { detail } : {}), ...extra }
}

function envStep(doctor, mode) {
  const failed = doctor.checks.filter((check) => !check.ok)
  if (!failed.length) return stepRecord('env', mode === 'plan' ? 'planned' : 'applied', '环境检查通过')
  const hint = failed.map((check) => check.hint ?? check.detail).filter(Boolean).join('；')
  return stepRecord('env', 'failed', '环境检查有 ' + failed.length + ' 项问题（可继续）', { hint })
}

function tosStep(tos, mode) {
  if (mode === 'plan') {
    return stepRecord('tos', 'planned', tos.accepted ? '已接受（channel=' + tos.channel + '）' : '尚未接受；apply 时由 CLI 的 TOS gate 处理')
  }
  return stepRecord('tos', 'skipped', '已接受（channel=' + (tos.channel ?? 'existing') + '）')
}

function modelStep(env) {
  const configured = typeof env?.ADVISERS_API_KEY === 'string' && env.ADVISERS_API_KEY.trim().length > 0
  return {
    step: stepRecord('model', 'skipped', configured ? '已配置 ADVISERS_API_KEY（仅当前 shell，不落盘）' : '未配置模型 key；本地模式可完成大部分操作（BYOK 只影响模型能力）'),
    model: { configured },
  }
}

function nextStep() {
  return { step: stepRecord('next', 'applied', '3 条下一步命令'), next: setupNextCards() }
}

/**
 * Build the read-only plan payload (`setup --dry-run`); creates nothing.
 * @param {{home?: string, options?: object, env?: object, isTTY?: boolean}} [params]
 * @returns {object} SetupPayload with mode:'plan'
 */
export function buildSetupPlan(params = {}) {
  const env = params.env ?? process.env
  const options = params.options ?? {}
  const homeDir = resolve(params.home ?? defaultHome(env))
  const doctor = runPreflight({ home: homeDir, env })
  const tos = inspectSetupTos({ home: homeDir, acceptTosFlag: options.acceptTos, env, isTTY: params.isTTY })
  const model = modelStep(env)
  const steps = [
    envStep(doctor, 'plan'),
    tosStep(tos, 'plan'),
    stepRecord('init', 'planned', '将创建 HOME/audit.key/state.db/soul（仅缺失项）'),
    model.step,
    stepRecord('mail', 'planned', options.mail && options.mail !== 'none' ? '将导入 .eml：' + String(options.mail) : '跳过（默认不导入邮件）'),
    stepRecord('demo', options.noDemo === true ? 'skipped' : 'planned', options.noDemo === true ? '--no-demo' : '将在独立临时 demo home 跑合成示例'),
    stepRecord('next', 'planned', '3 条下一步命令'),
  ]
  const wouldWrite = plannedWrites({ homeDir, env })
  return {
    ok: true,
    command: 'setup',
    mode: 'plan',
    home: homeDir,
    steps,
    doctor: { ok: doctor.ok, checks: doctor.checks },
    tos: { accepted: tos.accepted, channel: tos.channel },
    soul: { present: existsSync(join(homeDir, 'soul.md')) },
    model: model.model,
    mail: { mode: mailMode(options) },
    demo: null,
    wouldWrite,
    next: setupNextCards(),
    warnings: [],
  }
}

function mailMode(options) {
  return options.mail && options.mail !== 'none' ? 'eml' : 'none'
}

function mailTarget(options) {
  if (!options.mail || options.mail === 'none') return null
  const value = String(options.mail)
  return value.startsWith('eml:') ? value.slice('eml:'.length) : value
}

/**
 * Apply the setup plan (idempotent). bin must have resolved TOS first
 * (`inspectSetupTos`) — this function verifies the acceptance record exists
 * and refuses to write anything when it does not.
 *
 * @param {{home?: string, options?: object, env?: object, isTTY?: boolean,
 *          now?: Date, ports?: {runCommand?: Function}}} [params]
 * @returns {Promise<object>} SetupPayload with mode:'applied'
 */
export async function runSetup(params = {}) {
  const env = params.env ?? process.env
  const options = params.options ?? {}
  const isTTY = params.isTTY === true
  const ports = params.ports ?? {}
  const now = params.now instanceof Date ? params.now : new Date()
  const nowIso = now.toISOString()
  const homeDir = resolve(params.home ?? defaultHome(env))

  if (options.dryRun === true) return buildSetupPlan({ home: homeDir, options, env, isTTY })
  if (options.yes !== true && (options.json === true || !isTTY)) {
    throw new SetupError('E_USAGE', 'setup 写入需要 --yes（非交互环境）', {
      usage: 'usage: advisers setup --json --yes --accept-tos',
      hint: '先运行 advisers setup --dry-run --json 查看计划',
    })
  }

  const tos = inspectSetupTos({ home: homeDir, acceptTosFlag: options.acceptTos, env, isTTY })
  if (tos.error) throw new SetupError('E_USAGE', tos.error, { usage: 'usage: advisers setup --json --yes --accept-tos' })
  if (!tos.accepted) {
    throw new SetupError('E_TOS_REQUIRED', 'setup 需要先接受使用条款（TOS gate 未放行）', {
      exitCode: 3,
      hint: '非交互环境加 --accept-tos 或 ADVISERS_ACCEPT_TOS=1；TTY 环境按提示输入“同意”',
    })
  }

  const doctor = runPreflight({ home: homeDir, env })
  const warnings = []
  const steps = [envStep(doctor, 'apply'), tosStep(tos, 'apply')]

  const homeCreated = ensureHomeDirectory(homeDir)
  const keyState = ensureAuditKeyFile(homeDir, env)
  const dbState = await ensureDatabaseFile(homeDir)
  const soulState = ensureSoulFiles(homeDir, options, nowIso)
  const initDetail = [homeCreated ? '创建 HOME' : 'HOME 已存在', keyState.created ? '生成 audit.key' : null, dbState.created ? '创建 state.db' : 'state.db 已存在', soulState.created ? '写入 soul' : 'soul 已存在'].filter(Boolean).join(' · ')
  steps.push(stepRecord('init', homeCreated || keyState.created || dbState.created || soulState.created ? 'applied' : 'skipped', initDetail))

  const model = modelStep(env)
  steps.push(model.step)

  // Optional mail import through the existing CLI command (zero network).
  const target = mailTarget(options)
  if (!target) {
    steps.push(stepRecord('mail', 'skipped', '未导入邮件（--mail eml:<path> 可导入 .eml）'))
  } else {
    const runCommand = typeof ports.runCommand === 'function' ? ports.runCommand : defaultRunCommand()
    const childEnv = setupChildEnv({ env, homeDir })
    try {
      const result = await runCommand(['mail', 'import', target, '--json'], { cwd: process.cwd(), env: childEnv })
      if (result?.status !== 0) throw new Error(String(result?.stderr ?? '').split('\n').filter(Boolean)[0] ?? ('exit ' + result?.status))
      let inserted = null
      try { inserted = JSON.parse(String(result.stdout ?? '')).inserted ?? null } catch {}
      steps.push(stepRecord('mail', 'applied', '导入 .eml' + (inserted === null ? '' : '：inserted=' + inserted)))
    } catch (error) {
      warnings.push('邮件导入未完成：' + String(error?.message ?? error))
      steps.push(stepRecord('mail', 'failed', '跳过（不影响 setup 成功）', { hint: '稍后运行 advisers mail import <file|dir> --json' }))
    }
  }

  // Optional demo on an independent temp home (never the setup home).
  let demoPayload = null
  if (options.noDemo === true) {
    steps.push(stepRecord('demo', 'skipped', '--no-demo'))
  } else {
    try {
      const payload = await runDemo({ env, isTTY, now, ports: { runCommand: ports.runCommand } })
      if (payload.ok === true) {
        demoPayload = {
          demoHome: payload.demoHome,
          receipt: payload.receipt ? { scope: payload.receipt.scope, subject: payload.receipt.subject, manifestDigest: payload.receipt.manifestDigest } : null,
        }
        steps.push(stepRecord('demo', 'applied', 'demo home：' + payload.demoHome))
      } else {
        warnings.push('demo 未跑通：' + String(payload.error?.message ?? 'unknown error'))
        steps.push(stepRecord('demo', 'failed', '跳过（不影响 setup 成功）', { hint: '运行 advisers demo --json 单独排查' }))
      }
    } catch (error) {
      warnings.push('demo 未跑通：' + String(error?.message ?? error))
      steps.push(stepRecord('demo', 'failed', '跳过（不影响 setup 成功）', { hint: '运行 advisers demo --json 单独排查' }))
    }
  }

  const final = nextStep()
  steps.push(final.step)

  return {
    ok: steps.every((step) => step.status !== 'failed' || ['env', 'mail', 'demo'].includes(step.id)),
    command: 'setup',
    mode: 'applied',
    home: homeDir,
    steps,
    doctor: { ok: doctor.ok, checks: doctor.checks },
    tos: { accepted: tos.accepted, channel: tos.channel },
    soul: { present: existsSync(join(homeDir, 'soul.md')) },
    model: model.model,
    mail: { mode: mailMode(options) },
    demo: demoPayload,
    next: final.next,
    warnings,
  }
}

/** Human lines for bin (plain text, no ANSI). */
export function setupHumanLines(payload) {
  const lines = []
  lines.push(payload?.mode === 'plan' ? 'setup 计划（dry-run）：不会写入任何文件' : 'setup: ' + (payload?.ok ? 'OK' : 'INCOMPLETE'))
  if (payload?.home) lines.push((payload.mode === 'plan' ? '将使用 HOME  ' : 'home          ') + payload.home)
  for (const step of Array.isArray(payload?.steps) ? payload.steps : []) {
    lines.push('  ' + String(step.id).padEnd(8) + String(step.status) + (step.detail ? '  ' + step.detail : ''))
    if (step.hint) lines.push('           hint: ' + step.hint)
  }
  if (Array.isArray(payload?.wouldWrite) && payload.wouldWrite.length) {
    lines.push('将写入：')
    for (const target of payload.wouldWrite) lines.push('  ' + target)
  }
  if (payload?.demo?.demoHome) lines.push('demo home    ' + payload.demo.demoHome + '（独立临时目录，保留）')
  for (const warning of payload?.warnings ?? []) lines.push('warning: ' + warning)
  const next = Array.isArray(payload?.next) ? payload.next : []
  if (next.length) {
    lines.push('下一步：')
    for (const item of next) lines.push('  ' + item.label + '  ' + item.command)
  }
  return lines
}
