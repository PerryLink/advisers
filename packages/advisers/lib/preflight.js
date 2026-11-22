/**
 * Read-only environment preflight for `advisers setup` (0.5.0 U2a).
 *
 * Why not reuse `advisers doctor`? doctor's implementation calls `ensureHome()`
 * (it needs a real HOME to report store/backup state), so using it for
 * `setup --dry-run` would create the very files the dry-run promises not to
 * write. This module is the pure-read subset:
 *
 *  - Node version >= 22.16 (node:sqlite floor);
 *  - HOME is creatable/writable (an existing directory is probed read-only,
 *    a missing one is judged by its nearest existing writable ancestor);
 *  - node:sqlite opens and FTS5 compiles — using an IN-MEMORY database only,
 *    so the probe never creates state.db/WAL files or takes the writer lock;
 *  - the Office builder resolves (`advisers-office`, or the repo build when
 *    ADVISERS_OFFICE_LOCAL=1) without loading the barrel module.
 *
 * No function here creates a directory, writes a file, reads user data, opens
 * a network socket or mutates process.env. The setup command may continue with
 * warnings when a check fails; the checks are informational and every failure
 * carries a copy-pasteable hint.
 *
 * @module preflight
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable check ids (setup payload + tests iterate them). */
export const PREFLIGHT_CHECK_IDS = Object.freeze(['node', 'home', 'sqlite', 'office'])

/** Minimum Node version (node:sqlite + FTS5 support used by the ledger). */
export const MINIMUM_NODE = Object.freeze({ major: 22, minor: 16 })

/** Same HOME rule as bin/advisers.js: ADVISERS_HOME, else ~/.advisers. */
export function defaultHomePath(env = process.env) {
  return env.ADVISERS_HOME || join(homedir(), '.advisers')
}

function fail(id, detail, hint) {
  return hint ? { id, ok: false, detail, hint } : { id, ok: false, detail }
}

function pass(id, detail) {
  return { id, ok: true, detail }
}

/** Numeric [major, minor] from a Node version string, or null. */
function parseNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)/.exec(String(value ?? '').trim())
  return match ? [Number(match[1]), Number(match[2])] : null
}

function checkNode(nodeVersion = process.version) {
  const parsed = parseNodeVersion(nodeVersion)
  if (!parsed) return fail('node', String(nodeVersion ?? '(unknown)'), '无法识别 Node 版本；需要 Node >= 22.16（或 24 LTS）')
  const [major, minor] = parsed
  const ok = major > MINIMUM_NODE.major || (major === MINIMUM_NODE.major && minor >= MINIMUM_NODE.minor)
  if (!ok) return fail('node', 'v' + major + '.' + minor, '需要 Node >= 22.16（或 24 LTS）：' + (nodeVersion ?? ''))
  return pass('node', String(nodeVersion ?? ('v' + major + '.' + minor)).trim())
}

/** Nearest existing ancestor directory (read-only walk upward; no creation). */
function nearestExistingDirectory(target) {
  let current = target
  for (;;) {
    if (existsSync(current)) {
      try { return statSync(current).isDirectory() ? current : null } catch { return null }
    }
    const parent = dirname(current)
    if (!parent || parent === current) return null
    current = parent
  }
}

function checkHome(home) {
  let target
  try { target = resolve(String(home ?? '')) } catch { return fail('home', String(home ?? ''), 'ADVISERS_HOME 不是有效路径') }
  if (!target) return fail('home', '(empty)', 'ADVISERS_HOME 不能为空；默认是 ~/.advisers')
  const existing = existsSync(target)
  if (existing) {
    let stats
    try { stats = statSync(target) } catch (error) { return fail('home', target, '无法读取 HOME：' + (error?.message ?? error)) }
    if (!stats.isDirectory()) return fail('home', target, 'ADVISERS_HOME 是一个文件，不是目录')
    try {
      accessSync(target, constants.W_OK)
      return pass('home', target)
    } catch {
      return fail('home', target, 'HOME 目录不可写；检查权限或设置 ADVISERS_HOME 到可写目录')
    }
  }
  const ancestor = nearestExistingDirectory(dirname(target))
  if (!ancestor) return fail('home', target, 'HOME 的上级目录不存在；设置 ADVISERS_HOME 到已有路径下')
  try {
    accessSync(ancestor, constants.W_OK)
    return pass('home', target + '（尚不存在，将新建）')
  } catch {
    return fail('home', target, 'HOME 的上级目录不可写：' + ancestor)
  }
}

function checkSqlite() {
  let DatabaseSync
  try {
    DatabaseSync = process.getBuiltinModule?.('node:sqlite')?.DatabaseSync
  } catch {}
  if (typeof DatabaseSync !== 'function') return fail('sqlite', 'node:sqlite 不可用', '需要 Node >= 22.16（或 24 LTS）；当前 Node 没有 node:sqlite')
  let db
  try {
    db = new DatabaseSync(':memory:')
    db.exec('CREATE VIRTUAL TABLE fts_preflight_probe USING fts5(value)')
    db.exec("INSERT INTO fts_preflight_probe(value) VALUES ('preflight')")
    const row = db.prepare('SELECT count(*) AS n FROM fts_preflight_probe').get()
    if (Number(row?.n) !== 1) return fail('sqlite', 'FTS5 写入/读取不一致', '运行 advisers doctor --check-db；若持续失败请重装 Node')
    return pass('sqlite', 'node:sqlite + FTS5 OK（内存探针，未创建任何文件）')
  } catch (error) {
    return fail('sqlite', 'node:sqlite/FTS5 探测失败', 'FTS5 不可用：' + String(error?.message ?? error) + '；若使用发行版 Node 请换官方 Node 24')
  } finally {
    try { db?.close() } catch {}
  }
}

/** Resolve the Office builder without importing it (import would load pdf-lib etc). */
function checkOffice(env = process.env) {
  if (env.ADVISERS_OFFICE_LOCAL === '1') {
    const local = fileURLToPath(new URL('../../office/dist/index.js', import.meta.url))
    if (existsSync(local)) return pass('office', '仓库构建 ' + local)
    return fail('office', 'ADVISERS_OFFICE_LOCAL=1 但缺少 packages/office/dist/index.js', '先在仓库运行 pnpm -r build，或安装 advisers-office')
  }
  try {
    const resolved = fileURLToPath(import.meta.resolve('advisers-office'))
    if (existsSync(resolved)) return pass('office', resolved)
    return fail('office', resolved, 'advisers-office 已解析但文件缺失；重新安装 advisers-office')
  } catch {
    // Installed users get the external package; source checkouts may have the
    // workspace build without the env flag. Probe it read-only as a fallback.
    const local = fileURLToPath(new URL('../../office/dist/index.js', import.meta.url))
    if (existsSync(local)) return pass('office', '仓库构建 ' + local)
    return fail('office', 'advisers-office 未安装', 'npm i -g advisers-office@next（或设置 ADVISERS_OFFICE_LOCAL=1 使用仓库构建）')
  }
}

/**
 * Run the read-only checks.
 * @param {{home?: string, env?: Record<string, string|undefined>, nodeVersion?: string}} [options]
 * @returns {{ok: boolean, home: string, checks: Array<{id: string, ok: boolean, detail: string, hint?: string}>}}
 */
export function runPreflight(options = {}) {
  const env = options.env ?? process.env
  const home = resolve(String(options.home ?? defaultHomePath(env)))
  const checks = [
    checkNode(options.nodeVersion),
    checkHome(home),
    checkSqlite(),
    checkOffice(env),
  ]
  return { ok: checks.every((check) => check.ok), home, checks }
}

/** Compact human lines for the setup wizard (<= 6 lines, plain text). */
export function preflightLines(result) {
  const checks = Array.isArray(result?.checks) ? result.checks : []
  const lines = ['环境检查：']
  for (const check of checks) {
    const label = String(check.id).padEnd(7)
    lines.push('  ' + label + (check.ok ? 'OK  ' : 'FAIL ') + String(check.detail ?? ''))
    if (!check.ok && check.hint) lines.push('        hint: ' + check.hint)
  }
  return lines
}
