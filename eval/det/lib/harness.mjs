/**
 * Shared harness for the deterministic eval suite (0.3.0, `pnpm eval:det`).
 *
 * Design rules (04-0.3-research/15-eval-contracts.md §3.4):
 * - temp ADVISERS_HOME under the OS temp dir; never the real ~/.advisers;
 * - fixed TZ (Asia/Shanghai) and no model key (ADVISERS_NO_MODEL=1);
 * - every child process runs with a network-block preload and a per-run log,
 *   so "0 network attempts" is asserted, not assumed;
 * - output is normalized before it enters a result file: no absolute paths,
 *   no temp dirs, no key material.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { collectCliInfo } from '../../lib/quality-report.mjs'

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
export const BIN = join(REPO_ROOT, 'packages/advisers/bin/advisers.js')
export const NETWORK_BLOCK_URL = pathToFileURL(join(REPO_ROOT, 'eval/det/lib/network-block.mjs')).href
export const CORE_DIST = join(REPO_ROOT, 'packages/core/dist/index.js')
export const BASELINE_PATH = join(REPO_ROOT, 'eval/det/baseline.json')
// 0.5.0 WF4 Q1: every quality report lives under the shared eval/results/<suite>/
// tree (gitignored); historical eval/det/results/ files are not migrated.
export const RESULTS_DIR = join(REPO_ROOT, 'eval/results/det')
export const TIMEZONE = 'Asia/Shanghai'
export const CLI_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/advisers/package.json'), 'utf8')).version
export const NODE_VERSION = process.version
export const OS_NAME = process.platform

/** Environment variables that could let a command reach a real provider. */
const STRIPPED_ENV = [
  'ADVISERS_API_KEY',
  'ADVISERS_BASE_URL',
  'ADVISERS_MODEL',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ADVISERS_SYNC_PASSPHRASE',
  'FORCE_COLOR',
  'NO_COLOR',
]

/** Every temp root ever handed out; used to scrub result files. */
const KNOWN_ROOTS = []
/** All blocked network attempts observed in this process (children log to us). */
const NETWORK_ATTEMPTS = []

export function knownRoots() {
  return [...KNOWN_ROOTS]
}

export function networkSummary() {
  const kinds = {}
  for (const attempt of NETWORK_ATTEMPTS) kinds[attempt.kind] = (kinds[attempt.kind] ?? 0) + 1
  return { attempts: NETWORK_ATTEMPTS.length, kinds }
}

/** Create an isolated temp root with `home/` and `work/` directories. */
export function createWorkdir(label = 'case') {
  const safe = String(label).replace(/[^a-z0-9-]+/gi, '-').slice(0, 40)
  const root = mkdtempSync(join(tmpdir(), 'advisers-eval-det-' + safe + '-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  const net = join(root, 'net')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  mkdirSync(net, { recursive: true })
  const workdir = { root, home, work, net }
  KNOWN_ROOTS.push(root)
  return workdir
}

/** Remove a workdir; callers must always do this in a finally block. */
export function cleanupWorkdir(workdir) {
  if (!workdir?.root) return
  rmSync(workdir.root, { recursive: true, force: true })
}

/**
 * Build a child environment.
 *
 * `acceptTos` defaults to true because the consent gate is covered separately
 * (exit-code suite); every other case wants the gate inert and reproducible.
 */
export function buildEnv(workdir, { acceptTos = true, extra = {}, networkLog = null, blockNetwork = true } = {}) {
  const env = { ...process.env }
  for (const key of STRIPPED_ENV) delete env[key]
  env.TZ = TIMEZONE
  env.LANG = 'C.UTF-8'
  env.LC_ALL = 'C.UTF-8'
  env.TERM = 'xterm-256color'
  env.ADVISERS_HOME = workdir.home
  env.ADVISERS_CORE_LOCAL = '1'
  env.ADVISERS_OFFICE_LOCAL = '1'
  env.ADVISERS_STORE = 'sqlite'
  env.ADVISERS_NO_MODEL = '1'
  // node:sqlite is still marked experimental on Node 22; its one-time warning is
  // not part of the CLI contract and must not make the JSON-purity gates flaky.
  env.NODE_NO_WARNINGS = '1'
  if (acceptTos) env.ADVISERS_ACCEPT_TOS = '1'
  if (blockNetwork) {
    const existing = env.NODE_OPTIONS ? env.NODE_OPTIONS.trim() : ''
    env.NODE_OPTIONS = (existing ? existing + ' ' : '') + '--import=' + NETWORK_BLOCK_URL
  }
  if (networkLog) env.ADVISERS_EVAL_NET_LOG = networkLog
  return { ...env, ...extra }
}

function networkLogPath(workdir, index) {
  return join(workdir.net, 'attempt-' + index + '.log')
}

/** Run the CLI in a temp HOME; never spawns a shell. */
export function runCli(workdir, args, { acceptTos = true, extra = {}, timeoutMs = 30000, input = '', index } = {}) {
  const logPath = networkLogPath(workdir, index ?? Date.now())
  const env = buildEnv(workdir, { acceptTos, extra, networkLog: logPath })
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: workdir.work,
    env,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.error?.code === 'ETIMEDOUT',
    durationMs: Date.now() - startedAt,
    network: networkAttempts(logPath),
  }
}

/** Read and parse the per-invocation network-block log (missing file = no attempts). */
export function networkAttempts(logPath) {
  if (!logPath || !existsSync(logPath)) return []
  const attempts = []
  for (const line of readFileSync(logPath, 'utf8').split(String.fromCharCode(10))) {
    if (!line.trim()) continue
    try { attempts.push(JSON.parse(line)) } catch { attempts.push({ kind: 'unknown' }) }
  }
  const normalized = attempts.map((entry) => ({ kind: String(entry.kind ?? 'unknown'), pid: entry.pid }))
  for (const attempt of normalized) NETWORK_ATTEMPTS.push({ kind: attempt.kind })
  return normalized
}

/**
 * One stdio MCP session: newline-delimited JSON-RPC in, parsed responses out.
 * Invalid lines are included so the parse-error path can be asserted.
 */
export function runMcp(workdir, messages, { acceptTos = true, extra = {}, timeoutMs = 30000, rawLines = [] } = {}) {
  const lines = [
    ...messages.map((message) => (typeof message === 'string' ? message : JSON.stringify(message))),
    ...rawLines,
  ]
  const logPath = networkLogPath(workdir, 'mcp')
  const env = buildEnv(workdir, { acceptTos, extra, networkLog: logPath })
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [BIN, 'mcp', '--stdio'], {
    cwd: workdir.work,
    env,
    input: lines.join('\n') + '\n',
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  })
  const raw = (result.stdout ?? '').trim()
  const responses = []
  const unparsable = []
  for (const line of raw ? raw.split('\n') : []) {
    try { responses.push(JSON.parse(line)) } catch { unparsable.push(line) }
  }
  const byId = new Map()
  for (const response of responses) if (response.id !== undefined && response.id !== null) byId.set(response.id, response)
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.error?.code === 'ETIMEDOUT',
    durationMs: Date.now() - startedAt,
    responses,
    unparsable,
    response: (id) => byId.get(id),
    network: networkAttempts(logPath),
  }
}

/** Parse a JSON document, returning `{ ok, value, error }` instead of throwing. */
export function parseJson(text) {
  try { return { ok: true, value: JSON.parse(text) } } catch (error) { return { ok: false, error: String(error.message) } }
}

export const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/
export const ANSI_ESCAPE = /[\u001B\u009B]/
export const CARRIAGE_RETURN = /\r/

/** True when the text contains an ANSI escape or a disallowed C0 control byte. */
export function hasAnsi(text) {
  return ANSI_ESCAPE.test(text)
}

/** List the control-byte classes found in the text (\n and \t are allowed). */
export function controlViolations(text) {
  const found = []
  if (ANSI_ESCAPE.test(text)) found.push('esc')
  if (CONTROL_CHARS.test(text)) found.push('c0')
  if (CARRIAGE_RETURN.test(text)) found.push('cr')
  return found
}

/**
 * Normalize output for result files: no absolute paths, no temp dirs.
 * The same replacement map is used for details, failures and metrics.
 */
export function normalizeText(text, workdir) {
  let out = String(text ?? '')
  // Children first: <HOME>/<WORK> sit under <TMP>, so the precise rewrite
  // must happen before the parent path is collapsed.
  const replacements = []
  if (workdir?.home) replacements.push([workdir.home, '<HOME>'])
  if (workdir?.work) replacements.push([workdir.work, '<WORK>'])
  if (workdir?.net) replacements.push([workdir.net, '<NET>'])
  if (workdir?.root) replacements.push([workdir.root, '<TMP>'])
  replacements.push([REPO_ROOT, '<REPO>'])
  for (const [from, to] of replacements) {
    if (!from) continue
    out = out.split(from).join(to)
    out = out.split(from.replaceAll('\\', '/')).join(to)
  }
  return out
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** Stable stringify with sorted keys (same shape as lib/evidence stableStringify). */
export function stableStringify(value, space = 0) {
  const seen = new Set()
  const normalize = (input) => {
    if (input === null || typeof input !== 'object') return input
    if (seen.has(input)) throw new TypeError('stableStringify: circular structure')
    seen.add(input)
    const out = Array.isArray(input) ? input.map(normalize) : Object.fromEntries(Object.keys(input).sort().map((key) => [key, normalize(input[key])]))
    seen.delete(input)
    return out
  }
  return JSON.stringify(normalize(value), null, space)
}

/** CLI metadata recorded in every result file (v2 adds the dirty flag). */
export function cliInfo() {
  return collectCliInfo()
}

/** Fail early with an actionable message when the workspace is not built. */
export function preflight() {
  const problems = []
  if (!existsSync(BIN)) problems.push('missing ' + BIN + ' (run pnpm -r build)')
  if (!existsSync(CORE_DIST)) problems.push('missing packages/core/dist (run pnpm -r build)')
  if (!existsSync(BASELINE_PATH)) problems.push('missing eval/det/baseline.json')
  return problems
}

/**
 * Check helper. A check is the smallest unit reported in the result:
 * `{ id, pass, detail? }`. Throwing from `fn` becomes a failed check.
 */
export function check(checks, id, fn) {
  try {
    const value = fn()
    if (value && typeof value.then === 'function') throw new Error('check helper is synchronous; await before calling it')
    checks.push({ id, pass: true })
    return true
  } catch (error) {
    const raw = String(error?.message ?? error)
    checks.push({ id, pass: false, detail: raw.slice(0, 500) })
    return false
  }
}
