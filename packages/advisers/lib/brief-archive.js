/**
 * Proactive 0.4 — morning brief archive.
 *
 * `advisers morning --archive` (CLI wiring is a separate integration task) stores
 * the deterministic markdown under `<ADVISERS_HOME>/briefs/`:
 *
 *   briefs/2026-11-21.md   write-once-per-day file, atomically overwritten on re-run
 *   briefs/latest.md       byte copy of the most recent archive
 *
 * Privacy/retention rules baked into this module:
 * - the directory is 0700 and every file 0600 (owner-only);
 * - only files matching `YYYY-MM-DD.md` are ever deleted, never recursively,
 *   so unrelated files in `briefs/` are preserved;
 * - the default retention is 14 local days (1..365 configurable) and only the
 *   archived day files are pruned;
 * - the audit row suggestion never contains the brief body.
 *
 * Pure-library style: no console output, JSON-ready return values, caller owns
 * the audit write and the writer lock.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { atomicWriteFileSync } from './fs-safe.js'

export const BRIEFS_DIR = 'briefs'
export const BRIEF_LATEST_FILE = 'latest.md'
/** Default number of daily briefs kept by `--archive`. */
export const BRIEF_RETENTION_DAYS = 14
export const BRIEF_MIN_KEEP = 1
export const BRIEF_MAX_KEEP = 365
/** Audit action written by the CLI after a successful archive. */
export const BRIEF_AUDIT_ACTION = 'brief.archive'

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/

/** Local usage error carrying the registered CLI code (never throws an E_* literal). */
function usageError(message) {
  const error = new RangeError(message)
  error.code = 'E_USAGE'
  return error
}

function validCalendarDay(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

/**
 * Validate an archive day. Accepts only real `YYYY-MM-DD` calendar days so the
 * filename, the retention key and the audit reason can never disagree.
 * @param {string} localDay
 * @returns {string} the trimmed canonical day
 */
export function validateBriefDay(localDay) {
  if (typeof localDay !== 'string') throw usageError('brief localDay must be a YYYY-MM-DD string')
  const text = localDay.trim()
  const match = DATE_ONLY_RE.exec(text)
  if (!match) throw usageError('brief localDay must be YYYY-MM-DD')
  if (!validCalendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw usageError('brief localDay is not a real calendar day: ' + text)
  }
  return text
}

/** Resolve the Advisers home without assuming a real HOME when one is passed. */
export function briefHome({ home, env = process.env } = {}) {
  if (home !== undefined && home !== null && String(home).trim() !== '') return resolve(String(home))
  const fromEnv = env?.ADVISERS_HOME
  if (fromEnv !== undefined && fromEnv !== null && String(fromEnv).trim() !== '') return resolve(String(fromEnv))
  return resolve(join(homedir(), '.advisers'))
}

/**
 * Paths of the managed archive directory. `home` wins over `env.ADVISERS_HOME`;
 * tests always pass an explicit `home` (temporary directory).
 * @returns {{home: string, dir: string, latestFile: string}}
 */
export function briefPaths({ home, env } = {}) {
  const root = briefHome({ home, env })
  const dir = join(root, BRIEFS_DIR)
  return { home: root, dir, latestFile: join(dir, BRIEF_LATEST_FILE) }
}

/** Absolute path of one archived day file (validates the day). */
export function briefFilePath({ home, env, localDay } = {}) {
  const day = validateBriefDay(localDay)
  return join(briefPaths({ home, env }).dir, day + '.md')
}

function normalizeKeep(keep) {
  if (keep === undefined || keep === null) return BRIEF_RETENTION_DAYS
  if (!Number.isInteger(keep) || keep < BRIEF_MIN_KEEP || keep > BRIEF_MAX_KEEP) {
    throw usageError('brief keep must be an integer ' + BRIEF_MIN_KEEP + '..' + BRIEF_MAX_KEEP)
  }
  return keep
}

/**
 * List archived day files, newest first. Non-matching entries (including
 * `latest.md`, unrelated files and symlinks) are never considered: retention and
 * deletion only ever touch `YYYY-MM-DD.md` regular files.
 */
function listDayFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = DAY_FILE_RE.exec(entry.name)
    if (!match) continue
    if (!validCalendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) continue
    const path = join(dir, entry.name)
    let info
    try {
      info = statSync(path)
    } catch {
      continue
    }
    files.push({
      localDay: match[1] + '-' + match[2] + '-' + match[3],
      path,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    })
  }
  files.sort((left, right) => (left.localDay < right.localDay ? 1 : left.localDay > right.localDay ? -1 : 0))
  return files
}

/**
 * Audit-row suggestion for a successful archive. Contains the local day only —
 * never the brief body — and is returned rather than written so the CLI keeps
 * ownership of the writer lock (`store.appendAudit`).
 *
 * @param {{localDay: string}} options
 * @returns {{actor: 'local', action: string, allowed: true, reason: string}}
 */
export function briefAuditRow({ localDay } = {}) {
  const day = validateBriefDay(localDay)
  return { actor: 'local', action: BRIEF_AUDIT_ACTION, allowed: true, reason: day }
}

function latestInfo(latestFile) {
  try {
    const info = statSync(latestFile)
    return { exists: true, path: latestFile, bytes: info.size, modifiedAt: info.mtime.toISOString() }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, path: latestFile, bytes: 0, modifiedAt: null }
    throw error
  }
}

/**
 * Atomically write one archived brief (plus `latest.md`) and prune older day
 * files down to `keep`. Returns the plan as data: the caller prints the removed
 * absolute paths, takes the writer lock and writes `audit` (see
 * {@link briefAuditRow}).
 *
 * `dryRun` computes the same result without touching the filesystem.
 *
 * @param {{home?: string, env?: object, localDay: string, markdown: string,
 *   keep?: number, dryRun?: boolean}} options
 * @returns {{ok: true, dryRun: boolean, written: boolean, localDay: string,
 *   path: string, latestPath: string, keep: number, bytes: number,
 *   retained: string[], removed: string[], failed: Array<{path: string, code: string}>,
 *   audit: object}}
 */
export function archiveBrief({ home, env, localDay, markdown, keep, dryRun = false } = {}) {
  const day = validateBriefDay(localDay)
  if (typeof markdown !== 'string') throw new TypeError('brief markdown must be a string')
  const retention = normalizeKeep(keep)
  const paths = briefPaths({ home, env })
  const target = join(paths.dir, day + '.md')
  const existing = listDayFiles(paths.dir).filter((file) => file.localDay !== day)
  const all = [{ localDay: day, path: target }, ...existing]
    .sort((left, right) => (left.localDay < right.localDay ? 1 : left.localDay > right.localDay ? -1 : 0))
  const retained = all.slice(0, retention).map((file) => file.localDay)
  const pruned = all.slice(retention).filter((file) => file.localDay !== day)
  const bytes = Buffer.byteLength(markdown, 'utf8')
  const audit = briefAuditRow({ localDay: day })
  if (dryRun === true) {
    return {
      ok: true, dryRun: true, written: false, localDay: day, path: target,
      latestPath: paths.latestFile, keep: retention, bytes, retained,
      removed: pruned.map((file) => file.path), failed: [], audit,
    }
  }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  try { chmodSync(paths.dir, 0o700) } catch {}
  // Atomic overwrite: re-running the same day replaces the file, and latest.md
  // always ends up byte-identical to the newest archive.
  atomicWriteFileSync(target, markdown, { mode: 0o600 })
  atomicWriteFileSync(paths.latestFile, markdown, { mode: 0o600 })
  const failed = []
  const removed = []
  for (const file of pruned) {
    try {
      unlinkSync(file.path)
      removed.push(file.path)
    } catch (error) {
      failed.push({ path: file.path, code: typeof error?.code === 'string' ? error.code : 'E_UNKNOWN' })
    }
  }
  return {
    ok: true, dryRun: false, written: true, localDay: day, path: target,
    latestPath: paths.latestFile, keep: retention, bytes, retained,
    removed, failed, audit,
  }
}

/**
 * Read one archived brief. A missing day is `{found: false}` rather than an
 * error (an archive is optional); other filesystem errors are rethrown.
 *
 * @param {{home?: string, env?: object, localDay: string}} options
 * @returns {{ok: true, found: boolean, localDay: string, path: string,
 *   markdown: string|null, bytes: number}}
 */
export function readBrief({ home, env, localDay } = {}) {
  const day = validateBriefDay(localDay)
  const path = join(briefPaths({ home, env }).dir, day + '.md')
  try {
    const markdown = readFileSync(path, 'utf8')
    return { ok: true, found: true, localDay: day, path, markdown, bytes: Buffer.byteLength(markdown, 'utf8') }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, found: false, localDay: day, path, markdown: null, bytes: 0 }
    throw error
  }
}

/**
 * List the archive without reading any brief body: day metadata newest first,
 * plus the `latest.md` copy's metadata. `exists: false` means no archive has
 * ever been written.
 *
 * @param {{home?: string, env?: object, limit?: number}} options
 * @returns {{ok: true, dir: string, exists: boolean, count: number,
 *   briefs: Array<{localDay: string, path: string, bytes: number, modifiedAt: string}>,
 *   latest: {exists: boolean, path: string, bytes: number, modifiedAt: string|null}}}
 */
export function listBriefs({ home, env, limit } = {}) {
  const paths = briefPaths({ home, env })
  const exists = existsSync(paths.dir)
  const all = listDayFiles(paths.dir)
  let briefs = all
  if (limit !== undefined && limit !== null) {
    if (!Number.isInteger(limit) || limit < 1) throw usageError('brief limit must be a positive integer')
    briefs = all.slice(0, limit)
  }
  return {
    ok: true,
    dir: paths.dir,
    exists,
    count: all.length,
    briefs: briefs.map((file) => ({ localDay: file.localDay, path: file.path, bytes: file.bytes, modifiedAt: file.modifiedAt })),
    latest: latestInfo(paths.latestFile),
  }
}
