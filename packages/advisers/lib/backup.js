/**
 * Backup rotation + verified restore (Advisers 0.3.0 operations library).
 *
 * This module is the recovery half of 0.3.0 "Trustworthy Delivery": the CLI
 * used to have a one-shot `backup <path>` copy with no restore, no rotation and
 * no sidecars (04-0.3-research §2.2/§4.3, 05-0.3.0-planning P0-D2). What it adds:
 *
 *   - createBackup(): checkpoint WAL -> copy to a same-directory temp file ->
 *     fsync -> verify the COPY itself (quick_check, schema, audit head, sampled
 *     row counts vs the live DB) -> atomic rename. A backup that cannot be
 *     verified is removed and the command fails closed; an existing target is
 *     never clobbered unless explicit overwrite:true.
 *   - inspectBackup(): read-only verification of a .db file (quick_check,
 *     schema compatibility, audit chain/head, sampled row counts, adjacent WAL).
 *   - GFS / keep-N rotation with dry-run by default. Rotation only ever
 *     touches `<home>/backups/state-*.db` + their sidecars, always keeps the
 *     newest backup and the newest readable backup, and refuses paths that
 *     resolve outside the managed directory (never deletes a bad backup).
 *   - restore: planRestore() validates a backup + anchor first; restoreBackup()
 *     checkpoints/closes the live store, writes a pre-restore backup, installs
 *     the verified backup via atomic rename, re-verifies, and rolls back to the
 *     pre-restore copy if the installed file does not verify. The original
 *     database is untouched on every failure before the rename.
 *   - sidecars: `<backup>.sha256` (coreutils format) and
 *     `<backup>.anchor.json` (the audit tail anchor, §4.7).
 *   - audit anchor interop: a backup older than the audit anchor requires an
 *     explicit allowAnchorBehind (`restore --allow-anchor-behind`), while a
 *     live database whose count is below the anchor is a tail truncation.
 *
 * Failure matrix covered by test/backup.test.js + test/restore-drill.test.js:
 * missing/empty/corrupt/WAL-carrying/newer-schema backup, busy checkpoint,
 * pre-restore copy failure, copy verification failure, rename failure (original
 * intact), post-install verification failure (rollback), anchor-behind gate,
 * rotation dry-run/containment/unreadable protection.
 *
 * Library-only: no bin/ wiring (Wave 2), no network, no new dependency. Uses
 * only node:fs/node:crypto/node:sqlite (through lib/sqlite.js) and lib/fs-safe.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  atomicWriteFileSync,
  copyFileWithRetrySync,
  fsyncDirSync,
  fsyncFileSync,
  mkdirWithRetrySync,
  renameWithRetrySync,
  rmWithRetrySync,
  tempPathForSync,
} from './fs-safe.js'
import { SCHEMA_VERSION, SqliteStore } from './sqlite.js'
import {
  readAuditAnchor,
  readAuditHead,
  resolveAuditAnchorKey,
  verifyAuditAnchor,
  verifyRestoreAnchor,
  writeAuditAnchor,
} from './audit-anchor.js'

export const BACKUP_DIR_NAME = 'backups'
export const BACKUP_SHA256_SUFFIX = '.sha256'
export const BACKUP_ANCHOR_SUFFIX = '.anchor.json'
/** Managed backup file names: state-<UTC YYYYMMDDTHHMMSS[mmm]Z>[-tag].db. */
export const BACKUP_FILE_RE = /^state-(\d{8}T\d{6}(?:\d{3})?Z)(?:-([a-z0-9][a-z0-9-]{0,31}))?\.db$/
/** GFS retention defaults from 04-0.3-research §4.3 (daily=7 weekly=4 monthly=3). */
export const DEFAULT_KEEP_POLICY = Object.freeze({ daily: 7, weekly: 4, monthly: 3 })
/** Always protect at least this many newest backups from rotation. */
const PROTECT_NEWEST = 1
const MAX_TAG_CHARS = 32
const HASH_CHUNK_BYTES = 1024 * 1024
/** Tables whose row counts are compared after a backup copy (same set as sqlite.js). */
const BACKUP_SAMPLE_TABLES = ['matters', 'facts', 'commitments', 'preferences', 'audit']

function failure(code, message, extra = {}) {
  return { ok: false, code, errors: message ? [message] : [], warnings: [], ...extra }
}

function isMissingError(error) {
  return error?.code === 'ENOENT'
}

function fsExists(fs, file) {
  const exists = typeof fs?.existsSync === 'function' ? fs.existsSync : existsSync
  try { return Boolean(exists(file)) } catch { return false }
}

function fsStat(fs, file) {
  const stat = typeof fs?.statSync === 'function' ? fs.statSync : statSync
  return stat(file)
}

function fsReadDir(fs, dir) {
  const readdir = typeof fs?.readdirSync === 'function' ? fs.readdirSync : readdirSync
  return readdir(dir, { withFileTypes: true })
}

function fsRm(fs, file) {
  try { rmWithRetrySync(file, { fs: fs ?? nodeFs }) } catch {}
}

/** UTC compact stamp used in backup file names: 20261119T154512345Z. */
export function backupTimestamp(at = new Date(), { ms = true } = {}) {
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) throw new TypeError('backupTimestamp requires a valid Date')
  const iso = date.toISOString()
  if (ms) return iso.replace(/[-:]/g, '').replace('.', '')
  return iso.slice(0, 19).replace(/[-:]/g, '') + 'Z'
}

/** Parse the UTC compact stamp back to a Date (invalid input -> null). */
export function parseBackupTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{8}T\d{6}(?:\d{3})?Z$/.test(value)) return null
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  const hour = Number(value.slice(9, 11))
  const minute = Number(value.slice(11, 13))
  const second = Number(value.slice(13, 15))
  const millis = value.length === 18 ? Number(value.slice(15, 18)) : 0
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  if (date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null
  if (date.getUTCMilliseconds() !== millis) return null
  return date
}

/** Validate + normalize a backup tag; returns {ok, tag}. */
export function normalizeBackupTag(tag) {
  if (tag === undefined || tag === null || tag === '') return { ok: true, tag: null }
  const normalized = String(tag).trim().toLowerCase()
  if (normalized.length === 0) return { ok: true, tag: null }
  if (normalized.length > MAX_TAG_CHARS || !/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    return { ok: false, tag: normalized, error: 'backup tag must be 1-' + MAX_TAG_CHARS + ' lowercase letters/digits/hyphens and start with a letter/digit' }
  }
  return { ok: true, tag: normalized }
}

/** Managed backup file name for a timestamp + optional tag. */
export function backupFileName({ at = new Date(), tag = null, ms = true } = {}) {
  const checked = normalizeBackupTag(tag)
  if (!checked.ok) throw new TypeError(checked.error)
  const stamp = backupTimestamp(at, { ms })
  return 'state-' + stamp + (checked.tag ? '-' + checked.tag : '') + '.db'
}

/** <home>/backups (the only directory rotation is allowed to delete from). */
export function backupDir({ home } = {}) {
  if (!home) throw new TypeError('backupDir requires {home}')
  return join(home, BACKUP_DIR_NAME)
}

export function backupPathFor({ home, at = new Date(), tag = null, ms = true } = {}) {
  return join(backupDir({ home }), backupFileName({ at, tag, ms }))
}

export function backupSha256Path(backupPath) {
  return String(backupPath) + BACKUP_SHA256_SUFFIX
}

export function backupAnchorPath(backupPath) {
  return String(backupPath) + BACKUP_ANCHOR_SUFFIX
}

/** Parse a managed backup name into {name, atIso, atMs, tag} or null. */
export function parseBackupFileName(name) {
  if (typeof name !== 'string') return null
  const match = BACKUP_FILE_RE.exec(name)
  if (!match) return null
  const at = parseBackupTimestamp(match[1])
  if (!at) return null
  return { name, timestamp: match[1], atIso: at.toISOString(), atMs: at.getTime(), tag: match[2] ?? null }
}

/** Streaming synchronous sha256 of a file (1 MiB chunks; bounded memory). */
export function sha256FileSync(file, { fs = nodeFs, chunkSize = HASH_CHUNK_BYTES } = {}) {
  const open = fs.openSync
  const read = fs.readSync
  const close = fs.closeSync
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.max(4096, Math.min(chunkSize, HASH_CHUNK_BYTES)))
  let bytes = 0
  const fd = open(file, 'r')
  try {
    for (;;) {
      const count = read(fd, buffer, 0, buffer.length, null)
      if (!count) break
      hash.update(buffer.subarray(0, count))
      bytes += count
    }
  } finally {
    try { close(fd) } catch {}
  }
  return { sha256: hash.digest('hex'), bytes }
}

// ---------------------------------------------------------------------------
// Listing + GFS / keep-N rotation
// ---------------------------------------------------------------------------

/**
 * List managed backups in <home>/backups (or an explicit dir), newest first.
 * Symlinks and non-matching names are ignored; a missing directory is an empty
 * list, not an error. `sidecars` says which optional files exist.
 */
export function listBackups({ home, dir, fs = nodeFs } = {}) {
  const directory = resolve(String(dir ?? backupDir({ home })))
  const result = { ok: true, dir: directory, entries: [], errors: [], warnings: [] }
  let dirents
  try {
    dirents = fsReadDir(fs, directory)
  } catch (error) {
    if (isMissingError(error)) return result
    result.ok = false
    result.errors.push('cannot list backup directory ' + directory + ': ' + String(error?.code ?? error?.message ?? error))
    return result
  }
  for (const dirent of dirents) {
    if (!dirent.isFile() || dirent.isSymbolicLink()) continue
    const parsed = parseBackupFileName(dirent.name)
    if (!parsed) continue
    const path = join(directory, dirent.name)
    let info
    try { info = fsStat(fs, path) } catch { continue }
    if (!info.isFile()) continue
    result.entries.push({
      path,
      name: dirent.name,
      tag: parsed.tag,
      createdAt: parsed.atIso,
      atMs: parsed.atMs,
      size: info.size,
      mtimeMs: info.mtimeMs,
      sidecars: {
        sha256: fsExists(fs, backupSha256Path(path)),
        anchor: fsExists(fs, backupAnchorPath(path)),
      },
    })
  }
  result.entries.sort((left, right) => (right.atMs - left.atMs) || (left.name < right.name ? 1 : -1))
  return result
}

/** Merge a keep policy with defaults. Number N => keep the newest N; object => GFS. */
export function normalizeKeepPolicy(keep) {
  if (keep === undefined || keep === null) {
    return { ok: true, policy: { mode: 'gfs', ...DEFAULT_KEEP_POLICY } }
  }
  if (typeof keep === 'number') {
    if (!Number.isFinite(keep) || keep < 1) return { ok: false, error: 'keep must be a positive number of backups' }
    return { ok: true, policy: { mode: 'count', count: Math.floor(keep) } }
  }
  if (typeof keep === 'string') {
    const parsed = {}
    for (const part of keep.split(',')) {
      const [rawKey, rawValue] = part.split('=')
      const key = String(rawKey ?? '').trim().toLowerCase()
      const value = Number(String(rawValue ?? '').trim())
      if (!['daily', 'weekly', 'monthly'].includes(key) || !Number.isInteger(value) || value < 0) {
        return { ok: false, error: 'invalid keep policy "' + keep + '": expected "daily=7,weekly=4,monthly=3" or a number' }
      }
      parsed[key] = value
    }
    if (Object.keys(parsed).length === 0) return { ok: false, error: 'invalid empty keep policy' }
    return { ok: true, policy: { mode: 'gfs', ...DEFAULT_KEEP_POLICY, ...parsed } }
  }
  if (typeof keep === 'object') {
    if ('count' in keep) {
      const count = Number(keep.count)
      if (!Number.isInteger(count) || count < 1) return { ok: false, error: 'keep.count must be a positive integer' }
      return { ok: true, policy: { mode: 'count', count } }
    }
    const policy = { mode: 'gfs', ...DEFAULT_KEEP_POLICY }
    for (const key of ['daily', 'weekly', 'monthly']) {
      if (!(key in keep)) continue
      const value = Number(keep[key])
      if (!Number.isInteger(value) || value < 0) return { ok: false, error: 'keep.' + key + ' must be a non-negative integer' }
      policy[key] = value
    }
    return { ok: true, policy }
  }
  return { ok: false, error: 'keep must be a number, an object or a "daily=..,weekly=.." string' }
}

/** ISO-8601 week key (UTC) used by the GFS weekly bucket. */
export function isoWeekKey(ms) {
  const date = new Date(ms)
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNumber = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNumber + 3)
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3)
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000))
  return target.getUTCFullYear() + '-W' + String(week).padStart(2, '0')
}

/**
 * Pure rotation planner. Never deletes anything; returns the keep/victim split.
 *
 * Invariants (04-0.3-research §4.3): the newest backup is ALWAYS kept, the
 * newest entry explicitly marked `readable:true` (last quick_check that passed)
 * is ALWAYS kept, and a count policy always keeps `count` entries. Deletion
 * safety (path containment, sidecars) lives in applyBackupRotation.
 */
export function planBackupRotation({ entries, keep, now = Date.now() } = {}) {
  const normalized = normalizeKeepPolicy(keep)
  if (!normalized.ok) return failure('E_BACKUP_KEEP_INVALID', normalized.error)
  const policy = normalized.policy
  const sorted = [...(Array.isArray(entries) ? entries : [])]
    .filter((entry) => entry && typeof entry.path === 'string')
    .sort((left, right) => (Number(right.atMs ?? right.mtimeMs ?? 0) - Number(left.atMs ?? left.mtimeMs ?? 0)))
  const result = { ok: true, policy, kept: [], protected: [], victims: [], wouldDelete: [], warnings: [] }
  if (sorted.length === 0) return result
  const kept = new Set()
  const protect = (entry) => {
    if (!entry || kept.has(entry)) return
    kept.add(entry)
    result.protected.push(entry.path)
  }
  if (policy.mode === 'count') {
    for (const entry of sorted.slice(0, policy.count)) protect(entry)
  } else {
    const seenDays = new Set()
    const seenWeeks = new Set()
    const seenMonths = new Set()
    let daily = 0
    let weekly = 0
    let monthly = 0
    for (const entry of sorted) {
      if (kept.has(entry)) continue
      const atMs = Number(entry.atMs ?? entry.mtimeMs ?? now)
      const dayKey = new Date(atMs).toISOString().slice(0, 10)
      if (daily < policy.daily && !seenDays.has(dayKey)) {
        seenDays.add(dayKey)
        daily++
        protect(entry)
        continue
      }
      const weekKey = isoWeekKey(atMs)
      if (weekly < policy.weekly && !seenWeeks.has(weekKey)) {
        seenWeeks.add(weekKey)
        weekly++
        protect(entry)
        continue
      }
      const monthKey = new Date(atMs).toISOString().slice(0, 7)
      if (monthly < policy.monthly && !seenMonths.has(monthKey)) {
        seenMonths.add(monthKey)
        monthly++
        protect(entry)
      }
    }
  }
  // Safety net on top of the policy: the newest backup and the newest backup
  // whose quick_check passed are always kept, even if the policy buckets would
  // have dropped them (a readable backup is the actual rollback path).
  for (let index = 0; index < Math.min(PROTECT_NEWEST, sorted.length); index++) protect(sorted[index])
  protect(sorted.find((entry) => entry.readable === true))
  result.kept = sorted.filter((entry) => kept.has(entry))
  result.victims = sorted.filter((entry) => !kept.has(entry))
  result.wouldDelete = result.victims.map((entry) => entry.path)
  return result
}

function assertManagedPath(directory, file) {
  const resolvedDir = resolve(directory)
  const resolved = resolve(String(file))
  if (dirname(resolved) !== resolvedDir) {
    return { ok: false, code: 'E_BACKUP_PATH_UNSAFE', error: 'refusing to delete ' + resolved + ': it is not directly inside the managed backup directory ' + resolvedDir }
  }
  if (!BACKUP_FILE_RE.test(basename(resolved))) {
    return { ok: false, code: 'E_BACKUP_PATH_UNSAFE', error: 'refusing to delete ' + resolved + ': not a managed backup file name' }
  }
  return { ok: true, path: resolved }
}

/** Cheap read-only readability probe: open + PRAGMA quick_check, no chain pass. */
export function probeBackupReadable(backupPath, { fs = nodeFs } = {}) {
  let store = null
  const before = {
    wal: fsExists(fs, String(backupPath) + '-wal'),
    shm: fsExists(fs, String(backupPath) + '-shm'),
  }
  try {
    store = new SqliteStore(String(backupPath), { readOnly: true })
    const verdict = String(store.db.prepare('PRAGMA quick_check').get()?.quick_check ?? 'unknown')
    return { ok: verdict === 'ok', quickCheck: verdict }
  } catch (error) {
    return { ok: false, quickCheck: null, code: error?.code === 'E_DB_CORRUPT' ? 'E_BACKUP_CORRUPT' : 'E_BACKUP_OPEN_FAILED', error: String(error?.message ?? error).slice(0, 200) }
  } finally {
    try { store?.close() } catch {}
    cleanupVerificationArtifacts(String(backupPath), before, fs)
  }
}

function cleanupVerificationArtifacts(path, before, fs) {
  for (const suffix of ['-wal', '-shm']) {
    if (before?.[suffix.slice(1)]) continue
    const file = path + suffix
    try { if (fsExists(fs, file)) { const raw = typeof fs?.rmSync === 'function' ? fs.rmSync : nodeFs.rmSync; raw(file, { force: true }) } } catch {}
  }
}

/**
 * Apply a rotation plan. Dry-run by default (pass dryRun:false to delete).
 * Every victim is re-resolved and checked to be a direct child of `dir` with a
 * managed name; symlinks are refused. Backup + sidecars are removed together.
 */
export function applyBackupRotation({ home, dir, entries, keep, now = Date.now(), dryRun = true, fs = nodeFs, probeReadable = true, maxProbe = 3 } = {}) {
  const directory = resolve(String(dir ?? (home ? backupDir({ home }) : '')))
  if (!directory) return failure('E_BACKUP_DIR_REQUIRED', 'applyBackupRotation requires {dir} or {home}')
  let candidates = entries
  if (!Array.isArray(candidates)) {
    const listed = listBackups({ dir: directory, fs })
    if (!listed.ok) return failure('E_BACKUP_LIST_FAILED', listed.errors.join('; '))
    candidates = listed.entries
  }
  if (probeReadable) {
    candidates = candidates.map((entry) => ({ ...entry }))
    for (let index = 0; index < Math.min(maxProbe, candidates.length); index++) {
      if (typeof candidates[index].readable === 'boolean') continue
      candidates[index].readable = probeBackupReadable(candidates[index].path, { fs }).ok
    }
  }
  const plan = planBackupRotation({ entries: candidates, keep, now })
  if (!plan.ok) return plan
  const result = {
    ok: true,
    dryRun: Boolean(dryRun),
    dir: directory,
    kept: plan.kept.map((entry) => entry.path),
    protected: plan.protected,
    deleted: [],
    wouldDelete: [],
    failed: [],
    errors: [],
    warnings: [],
    plan,
  }
  const victims = plan.victims.map((entry) => entry.path)
  if (dryRun) { result.wouldDelete = victims; return result }
  for (const victim of victims) {
    const checked = assertManagedPath(directory, victim)
    if (!checked.ok) { result.errors.push(checked.error); result.failed.push({ path: victim, error: checked.error }); continue }
    try {
      const info = (typeof fs.lstatSync === 'function' ? fs.lstatSync : nodeFs.lstatSync)(checked.path)
      if (info.isSymbolicLink()) {
        const error = 'refusing to delete symlink ' + checked.path
        result.errors.push(error)
        result.failed.push({ path: checked.path, error })
        continue
      }
    } catch (error) {
      if (!isMissingError(error)) result.warnings.push('cannot stat ' + checked.path + ': ' + String(error?.code ?? error?.message ?? error))
    }
    for (const file of [checked.path, backupSha256Path(checked.path), backupAnchorPath(checked.path)]) {
      if (!fsExists(fs, file)) continue
      try {
        rmWithRetrySync(file, { fs })
        if (file === checked.path) result.deleted.push(file)
      } catch (error) {
        const message = 'cannot remove ' + file + ': ' + String(error?.code ?? error?.message ?? error)
        result.errors.push(message)
        result.failed.push({ path: file, error: message })
      }
    }
  }
  result.ok = result.errors.length === 0
  return result
}

/**
 * One-call managed rotation: list <home>/backups, plan, apply.
 * Defaults to a dry run: the CLI decides when `--yes` turns it into deletion.
 */
export function rotateManagedBackups({ home, keep, now = Date.now(), dryRun = true, fs = nodeFs } = {}) {
  if (!home) return failure('E_BACKUP_DIR_REQUIRED', 'rotateManagedBackups requires {home}')
  return applyBackupRotation({ home, dir: backupDir({ home }), keep, now, dryRun, fs })
}

// ---------------------------------------------------------------------------
// sha256 sidecar
// ---------------------------------------------------------------------------

/** Write `<backup>.sha256` in coreutils format ("<hex>  <basename>\n"), 0600. */
export function writeBackupSha256(backupPath, { fs = nodeFs, mode = 0o600 } = {}) {
  const file = String(backupPath)
  if (!fsExists(fs, file)) return failure('E_BACKUP_MISSING', 'backup file not found: ' + file)
  const hashed = sha256FileSync(file, { fs })
  const target = backupSha256Path(file)
  const content = hashed.sha256 + '  ' + basename(file) + '\n'
  try {
    atomicWriteFileSync(target, content, { fs, mode })
  } catch (error) {
    return failure(error?.code ?? 'E_BACKUP_SIDECAR_FAILED', 'cannot write ' + target + ': ' + String(error?.message ?? error).slice(0, 200))
  }
  return { ok: true, path: target, sha256: hashed.sha256, bytes: hashed.bytes }
}

/** Read `<backup>.sha256`; {found:false} when absent. */
export function readBackupSha256(backupPath, { fs = nodeFs } = {}) {
  const target = backupSha256Path(String(backupPath))
  const result = { ok: false, found: false, path: target, sha256: null, recordedName: null, errors: [] }
  let text
  try { text = (typeof fs.readFileSync === 'function' ? fs.readFileSync : readFileSync)(target, 'utf8') } catch (error) {
    if (isMissingError(error)) { result.ok = true; return result }
    result.errors.push('cannot read ' + target + ': ' + String(error?.code ?? error?.message ?? error))
    return result
  }
  result.found = true
  const match = /^([0-9a-f]{64})  (.+)\n?$/.exec(text)
  if (!match) { result.errors.push('malformed sha256 sidecar: ' + target); return result }
  result.sha256 = match[1]
  result.recordedName = match[2]
  result.ok = true
  return result
}

/** Verify a backup file against its .sha256 sidecar (and its name). */
export function verifyBackupSha256(backupPath, { fs = nodeFs, hash = null } = {}) {
  const file = String(backupPath)
  const sidecar = readBackupSha256(file, { fs })
  const result = { ok: false, found: sidecar.found, path: backupSha256Path(file), expected: sidecar.sha256, actual: null, errors: [...sidecar.errors], warnings: [] }
  if (!sidecar.found) { result.ok = true; return result }
  if (!sidecar.ok) return result
  if (sidecar.recordedName !== basename(file)) {
    result.errors.push('sha256 sidecar names ' + sidecar.recordedName + ' but the backup is ' + basename(file))
    return result
  }
  try {
    result.actual = hash?.sha256 ?? sha256FileSync(file, { fs }).sha256
  } catch (error) {
    result.errors.push('cannot hash ' + file + ': ' + String(error?.code ?? error?.message ?? error))
    return result
  }
  if (result.actual !== sidecar.sha256) {
    result.errors.push('sha256 mismatch for ' + basename(file) + ': sidecar ' + sidecar.sha256 + ', actual ' + result.actual)
    return result
  }
  result.ok = true
  return result
}

// ---------------------------------------------------------------------------
// Backup inspection
// ---------------------------------------------------------------------------

function hasTable(store, name) {
  try {
    return Boolean(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
  } catch { return false }
}

function sampleTableCounts(store) {
  const counts = {}
  for (const table of BACKUP_SAMPLE_TABLES) {
    if (!hasTable(store, table)) continue
    try { counts[table] = Number(store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()?.n ?? 0) } catch { counts[table] = null }
  }
  return counts
}

function compareCounts(expected, actual) {
  const mismatched = []
  for (const [table, count] of Object.entries(expected ?? {})) {
    if (count === null || count === undefined) continue
    if ((actual ?? {})[table] !== count) mismatched.push(table + ': source ' + count + ', backup ' + ((actual ?? {})[table] ?? 'missing'))
  }
  return mismatched
}

/**
 * Verify a .db backup read-only, without touching the file (except deleting the
 * -wal/-shm sidecars SQLite creates for a read-only open of a WAL database).
 *
 * Checks: exists/size, no adjacent -wal, opens as SQLite, PRAGMA quick_check,
 * meta.schema_version vs currentSchemaVersion (a newer backup is refused), the
 * audit table/chain/head (when verifyChain) and sampled row counts.
 * `audit` is always the cheap head (count/lastSeq/headHash/dbId) so restore can
 * compare it with an anchor even when chain verification is waived.
 */
export function inspectBackup(backupPath, { currentSchemaVersion = null, verifyChain = true, fs = nodeFs } = {}) {
  const path = resolve(String(backupPath))
  const result = {
    ok: false,
    codes: [],
    path,
    size: 0,
    sha256: null,
    quickCheck: null,
    schemaVersion: null,
    schemaStatus: 'unknown',
    audit: null,
    chain: null,
    chainVerified: false,
    counts: null,
    code: null,
    errors: [],
    warnings: [],
  }
  const addError = (code, message) => {
    if (!result.codes.includes(code)) result.codes.push(code)
    if (result.code === null) result.code = code
    result.errors.push(message)
  }
  let info
  try { info = fsStat(fs, path) } catch (error) {
    if (isMissingError(error)) addError('E_BACKUP_MISSING', 'backup file not found: ' + path)
    else addError('E_BACKUP_UNREADABLE', 'cannot stat backup ' + path + ': ' + String(error?.code ?? error?.message ?? error))
    return result
  }
  if (!info.isFile()) { addError('E_BACKUP_INVALID', 'backup path is not a regular file: ' + path); return result }
  result.size = info.size
  if (info.size === 0) { addError('E_BACKUP_EMPTY', 'backup file is empty: ' + path); return result }
  const adjacentWal = path + '-wal'
  if (fsExists(fs, adjacentWal)) {
    let walSize = 0
    try { walSize = fsStat(fs, adjacentWal).size } catch {}
    if (walSize > 0) {
      addError('E_BACKUP_HAS_WAL', 'backup has a non-empty ' + basename(adjacentWal) + ' (' + walSize + ' bytes): it was copied without a WAL checkpoint, so committed rows may be missing from the main file')
      return result
    }
  }
  const before = { wal: fsExists(fs, path + '-wal'), shm: fsExists(fs, path + '-shm') }
  let store = null
  try {
    try {
      store = new SqliteStore(path, { readOnly: true })
    } catch (error) {
      addError(error?.code === 'E_DB_CORRUPT' ? 'E_BACKUP_CORRUPT' : 'E_BACKUP_OPEN_FAILED', 'cannot open backup ' + path + ': ' + String(error?.message ?? error).slice(0, 200))
      return result
    }
    try {
      const verdict = String(store.db.prepare('PRAGMA quick_check').get()?.quick_check ?? 'unknown')
      result.quickCheck = verdict
      if (verdict !== 'ok') addError('E_BACKUP_CORRUPT', 'PRAGMA quick_check on the backup reported "' + verdict + '"')
    } catch (error) {
      result.quickCheck = 'error'
      addError('E_BACKUP_CORRUPT', 'PRAGMA quick_check failed on the backup: ' + String(error?.message ?? error).slice(0, 200))
    }
    const isLedger = ['meta', 'matters', 'facts', 'commitments', 'audit'].some((table) => hasTable(store, table))
    if (!isLedger) {
      addError('E_BACKUP_NOT_ADVISERS_DB', 'backup has no Advisers tables (meta/matters/facts/commitments/audit); refusing to treat it as a ledger backup')
      return result
    }
    try { result.schemaVersion = store.schemaVersion() } catch (error) { result.warnings.push('cannot read schema_version: ' + String(error?.message ?? error).slice(0, 160)) }
    if (currentSchemaVersion !== null && currentSchemaVersion !== undefined && result.schemaVersion !== null) {
      if (result.schemaVersion > Number(currentSchemaVersion)) {
        result.schemaStatus = 'newer'
        addError('E_BACKUP_SCHEMA_NEWER', 'backup schema v' + result.schemaVersion + ' is newer than this CLI (v' + currentSchemaVersion + '); upgrade advisers instead of restoring')
      } else if (result.schemaVersion < Number(currentSchemaVersion)) {
        result.schemaStatus = 'older'
        result.warnings.push('backup schema v' + result.schemaVersion + ' is older than the current v' + currentSchemaVersion + '; it will be migrated on the next writable open')
      } else {
        result.schemaStatus = 'current'
      }
    }
    if (!hasTable(store, 'audit')) {
      result.warnings.push('backup has no audit table (pre-audit schema); audit anchor checks are skipped')
    } else {
      const cheap = readAuditHead(store, { verifyChain: false })
      if (cheap.ok) result.audit = cheap
      else addError(cheap.code ?? 'E_BACKUP_AUDIT_UNREADABLE', 'cannot read the backup audit head: ' + (cheap.errors[0] ?? 'unknown error'))
      if (verifyChain) {
        const chain = readAuditHead(store, { verifyChain: true })
        result.chain = { ok: chain.ok, count: chain.count, brokenAt: chain.brokenAt }
        if (!chain.ok) {
          addError('E_BACKUP_AUDIT_CHAIN_BROKEN', 'backup audit chain is broken' + (chain.brokenAt === null || chain.brokenAt === undefined ? '' : ' at seq ' + chain.brokenAt) + '; restoring it would keep the broken chain')
        } else if (result.audit && (chain.count !== result.audit.count || chain.headHash !== result.audit.headHash)) {
          addError('E_BACKUP_AUDIT_CHAIN_BROKEN', 'backup audit head disagrees with the verified chain')
        } else {
          result.chainVerified = true
        }
      }
    }
    result.counts = sampleTableCounts(store)
  } finally {
    try { store?.close() } catch {}
    cleanupVerificationArtifacts(path, before, fs)
  }
  result.ok = result.errors.length === 0
  return result
}

/** Write `<backup>.anchor.json` from a cheap audit head (04 §4.7 sidecar). */
export function writeBackupAnchorSidecar({ backupPath, head, key, home, env, generator = 'advisers', createdAt = new Date().toISOString() } = {}) {
  if (!head || head.ok !== true) {
    return failure('E_BACKUP_ANCHOR_HEAD_MISSING', 'cannot write a backup audit anchor without a verified audit head')
  }
  const anchorPath = backupAnchorPath(backupPath)
  const keyInfo = resolveAuditAnchorKey({ home, key, env })
  const written = writeAuditAnchor({ file: anchorPath, head, key: keyInfo.key, generator, createdAt })
  return { ...written, anchorPath }
}

/** Verify the optional backup sidecars (.sha256 and .anchor.json). */
export function verifyBackupSidecars({ backupPath, head = null, key, home, env, fs = nodeFs } = {}) {
  const file = String(backupPath)
  const result = {
    ok: true,
    path: file,
    sha256: { found: false, ok: null, path: backupSha256Path(file), expected: null, actual: null },
    anchor: { found: false, ok: null, path: backupAnchorPath(file), code: null, errors: [], warnings: [] },
    errors: [],
    warnings: [],
  }
  const sha = verifyBackupSha256(file, { fs })
  result.sha256 = { found: sha.found, ok: sha.found ? sha.ok : null, path: sha.path, expected: sha.expected, actual: sha.actual }
  if (sha.found && !sha.ok) { result.errors.push(...sha.errors) }
  const read = readAuditAnchor({ file: backupAnchorPath(file) })
  if (read.errors.length && read.code !== 'E_AUDIT_ANCHOR_INVALID') result.errors.push(...read.errors)
  if (read.found && !read.ok) {
    result.anchor.found = true
    result.anchor.ok = false
    result.anchor.code = read.code
    result.anchor.errors = read.errors
    result.errors.push(...read.errors)
  } else if (read.found && read.ok) {
    result.anchor.found = true
    const keyInfo = resolveAuditAnchorKey({ home, key, env })
    const compareHead = head ?? { count: read.anchor.count, lastSeq: read.anchor.lastSeq, headHash: read.anchor.headHash, dbId: read.anchor.dbId }
    const verified = verifyAuditAnchor({ anchor: read.anchor, head: compareHead, key: keyInfo.key })
    result.anchor.ok = verified.ok
    result.anchor.code = verified.code
    result.anchor.hmacVerified = verified.hmacVerified
    result.anchor.errors = verified.errors
    result.anchor.warnings = [...read.warnings, ...verified.warnings]
    if (!verified.ok) result.errors.push(...verified.errors)
    result.warnings.push(...result.anchor.warnings)
  }
  result.ok = result.errors.length === 0
  return result
}

/**
 * `backups verify` convenience: inspect every managed backup (default: all,
 * capped by `limit`) and check its optional .sha256/.anchor.json sidecars.
 * Read-only; an unreadable/corrupt backup is reported, never deleted.
 */
export function verifyBackups({ home, dir, verifyChain = true, currentSchemaVersion = SCHEMA_VERSION, fs = nodeFs, key, env = process.env, limit = 100 } = {}) {
  const listed = listBackups({ home, dir, fs })
  if (!listed.ok) return { ok: false, dir: listed.dir, count: 0, results: [], errors: [...listed.errors], warnings: [] }
  const selected = listed.entries.slice(0, Math.max(1, Math.floor(limit)))
  const warnings = []
  const errors = []
  const results = selected.map((entry) => {
    const inspection = inspectBackup(entry.path, { currentSchemaVersion, verifyChain, fs })
    const sidecars = verifyBackupSidecars({ backupPath: entry.path, head: inspection.audit, key, home, env, fs })
    const ok = inspection.ok && sidecars.ok
    if (!ok) errors.push(...inspection.errors, ...sidecars.errors)
    if (inspection.warnings.length || sidecars.warnings.length) warnings.push(...inspection.warnings, ...sidecars.warnings)
    return { path: entry.path, name: entry.name, ok, inspection, sidecars }
  })
  return { ok: errors.length === 0, dir: listed.dir, count: results.length, results, errors, warnings }
}

/** One-line actionable hint per stable backup/restore code (bin/ messages). */
export const BACKUP_ERROR_HINTS = Object.freeze({
  E_BACKUP_MISSING: 'the backup file does not exist; check the path or list <home>/backups',
  E_BACKUP_EMPTY: 'the backup file is empty; it cannot be restored — take a fresh backup after recovering the ledger',
  E_BACKUP_CORRUPT: 'the backup fails SQLite quick_check; do not restore it — try an older backup and keep this file for forensics',
  E_BACKUP_HAS_WAL: 'the backup was copied without a WAL checkpoint; take a fresh backup with `advisers backup` (it checkpoints first)',
  E_BACKUP_SCHEMA_NEWER: 'the backup is from a newer Advisers; upgrade the CLI instead of restoring it',
  E_BACKUP_NOT_ADVISERS_DB: 'the file is not an Advisers ledger database; check the path',
  E_BACKUP_BUSY: 'another connection blocked the WAL checkpoint; close other advisers processes (ui/mcp/bridge) and retry',
  E_BACKUP_EXISTS: 'the target backup file already exists; choose another name or pass overwrite explicitly',
  E_BACKUP_VERIFY_FAILED: 'the copied backup did not verify, so it was removed and no backup was installed; the live database is unchanged',
  E_RESTORE_BUSY: 'another connection blocked the pre-restore checkpoint; close other advisers processes and retry',
  E_RESTORE_WAL_OPEN: 'the database still has a non-empty WAL; checkpoint and close every connection before restoring',
  E_RESTORE_PRERESTORE_FAILED: 'the pre-restore safety backup failed, so nothing was replaced; free disk space/permissions and retry',
  E_RESTORE_INSTALL_FAILED: 'the atomic install failed, so the live database is unchanged; retry after closing programs that hold the file (antivirus/OneDrive)',
  E_RESTORE_VERIFY_FAILED: 'the installed database did not verify; the pre-restore backup was used to roll back',
  E_RESTORE_ROLLBACK_FAILED: 'the installed database did not verify AND rollback failed: stop, keep the pre-restore backup, and recover manually',
  E_BACKUP_AUDIT_CHAIN_BROKEN: 'the backup audit chain is broken; restore only with explicit allowBrokenAuditChain after exporting evidence',
  E_BACKUP_AUDIT_UNREADABLE: 'the backup audit head cannot be read; the file may be corrupt',
  E_AUDIT_ANCHOR_ABSENT: 'no audit anchor was found, so the backup could not be anchor-checked; restore is allowed but not anchored',
  E_AUDIT_ANCHOR_BEHIND: 'the backup is older than the audit anchor; pass --allow-anchor-behind only if this time-travel is intended',
  E_BACKUP_ANCHOR_MISMATCH: 'the backup\'s own .anchor.json sidecar does not match the backup audit head; the backup or its sidecar was modified',
  E_BACKUP_PATH_UNSAFE: 'refusing to delete a path outside the managed backup directory',
  E_BACKUP_KEEP_INVALID: 'invalid keep policy; use a count or daily=7,weekly=4,monthly=3',
  E_BACKUP_SIDECAR_FAILED: 'the .sha256 sidecar could not be written; the backup exists but its checksum file is missing',
  E_RESTORE_TARGET_UNSAFE: 'the restore target path is not a regular .db path; refusing to replace it',
})

export function describeBackupCode(code) {
  return BACKUP_ERROR_HINTS[code] ?? ('backup/restore failed: ' + String(code ?? 'unknown error'))
}

/**
 * Create a verified backup of dbPath at targetPath.
 *
 * Steps: optional checkpoint(TRUNCATE) on the live store -> copy to a
 * same-directory temp -> fsync -> read-only verification of the copy -> compare
 * sampled row counts with the live DB -> sha256 -> atomic rename into place.
 * The live database is only read. A failed verification removes the temp file
 * and leaves an existing target untouched (E_BACKUP_VERIFY_FAILED).
 */
export function createBackup({
  dbPath,
  targetPath,
  store = null,
  checkpoint = true,
  verify = true,
  verifyChain = false,
  currentSchemaVersion = SCHEMA_VERSION,
  expectedCounts = null,
  overwrite = false,
  writeSha256 = false,
  tag = null,
  at = new Date(),
  fs = nodeFs,
  mode = 0o600,
} = {}) {
  if (!dbPath) return failure('E_BACKUP_SOURCE_MISSING', 'createBackup requires {dbPath}')
  if (!targetPath) return failure('E_BACKUP_TARGET_MISSING', 'createBackup requires {targetPath}')
  const source = resolve(String(dbPath))
  const target = resolve(String(targetPath))
  const warnings = []
  const steps = []
  let sourceInfo
  try { sourceInfo = fsStat(fs, source) } catch (error) { return failure('E_BACKUP_SOURCE_MISSING', 'cannot stat the live database ' + source + ': ' + String(error?.code ?? error?.message ?? error)) }
  if (!sourceInfo.isFile()) return failure('E_BACKUP_SOURCE_MISSING', 'live database path is not a regular file: ' + source)
  const tagCheck = normalizeBackupTag(tag)
  if (!tagCheck.ok) return failure('E_BACKUP_TAG_INVALID', tagCheck.error)
  let checkpointInfo = null
  if (checkpoint && store) {
    if (typeof store.checkpoint !== 'function') return failure('E_BACKUP_STORE_INVALID', 'store does not implement checkpoint(); pass {checkpoint:false} if the WAL is already flushed')
    try { checkpointInfo = store.checkpoint({ mode: 'TRUNCATE' }) } catch (error) {
      return failure(error?.code ?? 'E_BACKUP_CHECKPOINT_FAILED', 'cannot checkpoint the WAL before backing up: ' + String(error?.message ?? error).slice(0, 200))
    }
    if (checkpointInfo?.busy) {
      return failure('E_BACKUP_BUSY', 'another connection blocked the WAL checkpoint; the backup was not taken. Close other advisers processes and retry')
    }
    steps.push('checkpoint: TRUNCATE (busy=false)')
  }
  const liveCounts = expectedCounts ?? (store && store.db ? sampleTableCounts(store) : null)
  const existedBefore = fsExists(fs, target)
  if (existedBefore && !overwrite) {
    return failure('E_BACKUP_EXISTS', 'refusing to overwrite the existing file ' + target + '; choose another name or pass overwrite:true', { path: target })
  }
  try { mkdirWithRetrySync(dirname(target), { fs }) } catch (error) {
    return failure('E_BACKUP_DIR_FAILED', 'cannot create the backup directory ' + dirname(target) + ': ' + String(error?.message ?? error).slice(0, 200))
  }
  const temp = tempPathForSync(target)
  try {
    copyFileWithRetrySync(source, temp, { fs, mode })
    steps.push('copy -> temp')
    fsyncFileSync(temp, { fs })
    try { fs.chmodSync?.(temp, mode) } catch {}
    steps.push('fsync temp')
    let inspection = null
    if (verify) {
      inspection = inspectBackup(temp, { currentSchemaVersion, verifyChain, fs })
      if (!inspection.ok) {
        const detail = inspection.errors.join('; ').slice(0, 400)
        fsRm(fs, temp)
        return failure('E_BACKUP_VERIFY_FAILED', 'the copied backup did not verify, so it was removed and the existing target (if any) is untouched: ' + detail, { codes: inspection.codes })
      }
      if (liveCounts) {
        const mismatched = compareCounts(liveCounts, inspection.counts)
        if (mismatched.length) {
          fsRm(fs, temp)
          return failure('E_BACKUP_VERIFY_FAILED', 'the backup row counts do not match the live database (' + mismatched.join(', ') + '); the backup was removed')
        }
        steps.push('row counts match the live database')
      }
      steps.push('verify: quick_check ok, schema v' + (inspection.schemaVersion ?? 'unknown'))
    }
    const hashed = sha256FileSync(temp, { fs })
    try { fs.chmodSync?.(temp, mode) } catch {}
    try {
      renameWithRetrySync(temp, target, { fs })
    } catch (error) {
      fsRm(fs, temp)
      return failure('E_BACKUP_INSTALL_FAILED', 'cannot install the verified backup at ' + target + ': ' + String(error?.message ?? error).slice(0, 200))
    }
    try { fs.chmodSync?.(target, mode) } catch {}
    try { fsyncDirSync(dirname(target), { fs }) } catch {}
    steps.push('atomic rename into place')
    const result = {
      ok: true,
      code: null,
      path: target,
      bytes: hashed.bytes,
      sha256: hashed.sha256,
      schemaVersion: inspection?.schemaVersion ?? null,
      audit: inspection?.audit ?? null,
      chainVerified: inspection?.chainVerified ?? false,
      counts: inspection?.counts ?? null,
      checkpoint: checkpointInfo,
      sidecars: { sha256: null, anchor: null },
      steps,
      warnings,
      errors: [],
    }
    if (writeSha256) {
      const written = writeBackupSha256(target, { fs })
      if (written.ok) result.sidecars.sha256 = written.path
      else warnings.push(written.errors[0] ?? 'could not write the sha256 sidecar')
    }
    if (!result.audit) warnings.push('backup audit head unavailable; no audit anchor sidecar can certify this backup')
    return result
  } catch (error) {
    fsRm(fs, temp)
    return failure(error?.code ?? 'E_BACKUP_FAILED', 'backup failed: ' + String(error?.message ?? error).slice(0, 300))
  }
}

/**
 * Create a backup in <home>/backups with the managed name, .sha256 and
 * .anchor.json sidecars, then optionally rotate. Wave 2 bin/ glue: choose
 * `rotate:true` only on the explicit `backup` command (not on `--out` paths,
 * which never participate in rotation).
 */
export function createManagedBackup({
  home,
  dbPath,
  store = null,
  tag = null,
  at = new Date(),
  keep = null,
  rotate = false,
  rotateDryRun = false,
  anchorKey,
  env = process.env,
  generator = 'advisers',
  writeSha256 = true,
  writeAnchor = true,
  verifyChain = false,
  fs = nodeFs,
} = {}) {
  if (!home) return failure('E_BACKUP_DIR_REQUIRED', 'createManagedBackup requires {home}')
  const tagCheck = normalizeBackupTag(tag)
  if (!tagCheck.ok) return failure('E_BACKUP_TAG_INVALID', tagCheck.error)
  const finalTarget = backupPathFor({ home, at, tag: tagCheck.tag })
  const created = createBackup({
    dbPath,
    targetPath: finalTarget,
    store,
    verify: true,
    verifyChain,
    writeSha256,
    fs,
  })
  if (!created.ok) return created
  if (writeAnchor && created.audit) {
    const anchor = writeBackupAnchorSidecar({ backupPath: finalTarget, head: created.audit, key: anchorKey, home, env, generator })
    if (anchor.ok) created.sidecars.anchor = anchor.anchorPath
    else created.warnings.push(anchor.errors?.[0] ?? 'could not write the audit anchor sidecar')
  }
  created.managedDir = backupDir({ home })
  if (rotate) {
    const rotation = rotateManagedBackups({ home, keep, dryRun: rotateDryRun, fs })
    created.rotation = rotation
    if (!rotation.ok) created.warnings.push(...(rotation.errors ?? ['rotation failed']))
    else if (rotation.dryRun) created.warnings.push('rotation dry-run: would delete ' + rotation.wouldDelete.length + ' backup(s)')
  }
  return created
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

function defaultPreRestorePath({ dbPath, home, at }) {
  if (home) return backupPathFor({ home, at, tag: 'pre-restore' })
  return String(dbPath) + '.before-restore-' + backupTimestamp(at)
}

function uniquePath(path, fs) {
  if (!fsExists(fs, path)) return path
  const stem = path.endsWith('.db') ? path.slice(0, -3) : path
  const suffix = path.endsWith('.db') ? '.db' : ''
  for (let index = 2; index < 1000; index++) {
    const candidate = stem + '-' + index + suffix
    if (!fsExists(fs, candidate)) return candidate
  }
  return path
}

/**
 * Validate a backup + audit anchor BEFORE touching the live database.
 * This is the `restore --dry-run` path: no file is modified.
 */
export function planRestore({
  backupPath,
  dbPath,
  currentSchemaVersion = SCHEMA_VERSION,
  anchor = null,
  anchorPath = null,
  allowAnchorBehind = false,
  allowBrokenAuditChain = false,
  requireAnchor = false,
  key,
  home,
  env = process.env,
  fs = nodeFs,
} = {}) {
  if (!backupPath) return failure('E_BACKUP_MISSING', 'planRestore requires {backupPath}')
  const inspection = inspectBackup(backupPath, { currentSchemaVersion, verifyChain: true, fs })
  const warnings = [...inspection.warnings]
  if (!inspection.ok) {
    const blocking = inspection.codes.filter((code) => !(allowBrokenAuditChain && code === 'E_BACKUP_AUDIT_CHAIN_BROKEN'))
    if (blocking.length) {
      return {
        ok: false,
        code: blocking[0],
        codes: blocking,
        path: inspection.path,
        inspection,
        errors: [...inspection.errors],
        warnings,
      }
    }
    warnings.push('restoring a backup whose audit chain is broken was explicitly allowed; the restored ledger will keep the broken chain')
  }
  let anchorRead = null
  let resolvedAnchor = anchor
  if (!resolvedAnchor) {
    const target = anchorPath ?? (home ? resolve(join(home, 'audit-anchor.json')) : null)
    if (target) {
      anchorRead = readAuditAnchor({ file: target })
      if (anchorRead.found && !anchorRead.ok) {
        if (allowBrokenAuditChain && !requireAnchor) {
          warnings.push('the audit anchor is unreadable (' + anchorRead.code + ') but rescue mode (allowBrokenAuditChain) proceeds without it; the restore will not be anchor-checked')
        } else {
          return { ok: false, code: anchorRead.code, path: inspection.path, inspection, errors: [...anchorRead.errors], warnings }
        }
      }
      if (anchorRead.found && anchorRead.ok) resolvedAnchor = anchorRead.anchor
    }
  }
  let anchorVerification = null
  if (resolvedAnchor) {
    if (!inspection.audit) {
      if (requireAnchor) return { ok: false, code: 'E_BACKUP_AUDIT_UNREADABLE', path: inspection.path, inspection, errors: ['the backup has no readable audit head, so the audit anchor cannot be checked'], warnings }
      warnings.push('the backup has no readable audit head; audit anchor comparison skipped')
    } else {
      const keyInfo = resolveAuditAnchorKey({ home, key, env })
      anchorVerification = verifyRestoreAnchor({ anchor: resolvedAnchor, head: inspection.audit, key: keyInfo.key, allowAnchorBehind })
      warnings.push(...anchorVerification.warnings)
      if (!anchorVerification.ok) {
        if (allowBrokenAuditChain && !requireAnchor) {
          warnings.push('the audit anchor check failed (' + anchorVerification.code + ') but rescue mode (allowBrokenAuditChain) proceeds: ' + (anchorVerification.errors[0] ?? 'anchor mismatch'))
        } else {
          return {
            ok: false,
            code: anchorVerification.code,
            path: inspection.path,
            inspection,
            anchor: resolvedAnchor,
            anchorVerification,
            errors: [...anchorVerification.errors],
            warnings,
          }
        }
      }
    }
  } else if (requireAnchor) {
    return { ok: false, code: 'E_AUDIT_ANCHOR_ABSENT', path: inspection.path, inspection, errors: ['no audit anchor found and requireAnchor is set'], warnings }
  } else {
    warnings.push('no audit anchor found: the restore cannot be checked against an audit baseline (yellow, not a failure)')
  }
  // A managed backup also carries its own <backup>.anchor.json. It cannot prove
  // the backup is recent (both files travel together), but it does detect a
  // backup or sidecar edited after the fact, so check it too when present.
  let sidecarAnchor = null
  if (inspection.audit) {
    const sidecarRead = readAuditAnchor({ file: backupAnchorPath(inspection.path) })
    if (sidecarRead.found && sidecarRead.ok) {
      const sidecarKey = resolveAuditAnchorKey({ home, key, env })
      const sidecarVerification = verifyAuditAnchor({ anchor: sidecarRead.anchor, head: inspection.audit, key: sidecarKey.key })
      if (!sidecarVerification.ok) {
        if (allowBrokenAuditChain && !requireAnchor) {
          warnings.push('the backup sidecar anchor check failed (' + sidecarVerification.code + ') but rescue mode (allowBrokenAuditChain) proceeds: ' + (sidecarVerification.errors[0] ?? 'anchor mismatch'))
        } else {
          return {
            ok: false,
            code: 'E_BACKUP_ANCHOR_MISMATCH',
            path: inspection.path,
            inspection,
            anchor: resolvedAnchor ?? null,
            anchorVerification,
            errors: [...sidecarVerification.errors],
            warnings,
          }
        }
      }
      sidecarAnchor = { anchor: sidecarRead.anchor, verification: sidecarVerification }
      warnings.push(...sidecarVerification.warnings)
    } else if (sidecarRead.found && !sidecarRead.ok) {
      if (allowBrokenAuditChain && !requireAnchor) {
        warnings.push('the backup sidecar anchor is unreadable (' + sidecarRead.code + ') but rescue mode (allowBrokenAuditChain) proceeds without it')
      } else {
        return { ok: false, code: sidecarRead.code, path: inspection.path, inspection, errors: [...sidecarRead.errors], warnings }
      }
    }
  }
  const resolvedDbPath = dbPath ? resolve(String(dbPath)) : null
  const steps = [
    'verify backup: quick_check/schema/audit' + (inspection.chainVerified ? ' chain verified' : ''),
    'check audit anchor' + (resolvedAnchor ? (allowAnchorBehind ? ' (anchor-behind allowed)' : '') : ' (none found)') + (sidecarAnchor ? ' + backup sidecar anchor' : ''),
    'checkpoint + close the live store',
    'write pre-restore backup',
    'remove stale -wal/-shm, install backup via atomic rename',
    'verify restored database and roll back on failure',
  ]
  return {
    ok: true,
    path: inspection.path,
    dbPath: resolvedDbPath,
    inspection,
    anchor: resolvedAnchor ?? null,
    anchorVerification,
    sidecarAnchor,
    warnings,
    errors: [],
    steps,
  }
}

function verifyDatabaseFile(path, { expectedSchemaVersion = null, expectedHead = null, fs = nodeFs } = {}) {
  const before = { wal: fsExists(fs, path + '-wal'), shm: fsExists(fs, path + '-shm') }
  let store = null
  const result = { ok: false, code: null, quickCheck: null, schemaVersion: null, audit: null, errors: [] }
  try {
    store = new SqliteStore(path, { readOnly: true })
    try {
      const verdict = String(store.db.prepare('PRAGMA quick_check').get()?.quick_check ?? 'unknown')
      result.quickCheck = verdict
      if (verdict !== 'ok') { result.code = 'E_RESTORE_VERIFY_FAILED'; result.errors.push('quick_check reported "' + verdict + '"') }
    } catch (error) {
      result.code = 'E_RESTORE_VERIFY_FAILED'
      result.errors.push('quick_check failed: ' + String(error?.message ?? error).slice(0, 200))
    }
    try { result.schemaVersion = store.schemaVersion() } catch {}
    if (expectedSchemaVersion !== null && expectedSchemaVersion !== undefined && result.schemaVersion !== null && result.schemaVersion !== expectedSchemaVersion) {
      result.code = 'E_RESTORE_VERIFY_FAILED'
      result.errors.push('restored schema v' + result.schemaVersion + ' does not match the backup schema v' + expectedSchemaVersion)
    }
    if (expectedHead) {
      const head = readAuditHead(store, { verifyChain: false })
      if (!head.ok) {
        result.code = 'E_RESTORE_VERIFY_FAILED'
        result.errors.push('cannot read the restored audit head: ' + (head.errors[0] ?? 'unknown error'))
      } else {
        result.audit = head
        if (head.count !== expectedHead.count || head.lastSeq !== expectedHead.lastSeq || head.headHash !== expectedHead.headHash) {
          result.code = 'E_RESTORE_VERIFY_FAILED'
          result.errors.push('restored audit head does not match the backup (count ' + head.count + ' vs ' + expectedHead.count + ')')
        }
      }
    }
  } catch (error) {
    result.code = error?.code === 'E_DB_CORRUPT' ? 'E_RESTORE_VERIFY_FAILED' : (error?.code ?? 'E_RESTORE_VERIFY_FAILED')
    result.errors.push('cannot open the installed database: ' + String(error?.message ?? error).slice(0, 200))
  } finally {
    try { store?.close() } catch {}
    cleanupVerificationArtifacts(path, before, fs)
  }
  result.ok = result.code === null && result.errors.length === 0
  return result
}

/**
 * Restore a verified backup over dbPath (fail-safe, rollback capable).
 *
 * Preconditions: the caller has validated the backup (or passes options so
 * planRestore runs first) and holds the HOME instance lock. Passing `store`
 * lets the library checkpoint(TRUNCATE) and close it before the copy; without a
 * store the caller must have checkpointed and closed every connection, and a
 * non-empty -wal file is refused with E_RESTORE_WAL_OPEN.
 *
 * Returns {ok:true, restoredFrom, preRestoreBackup, audit, ...} or a failure with
 * `originalIntact` / `rolledBack` flags. The caller writes the `db.restore` audit
 * row and a fresh anchor after reopening the restored store.
 */
export function restoreBackup({
  plan = null,
  backupPath = null,
  dbPath,
  store = null,
  closeStore = null,
  home = null,
  anchor = null,
  anchorPath = null,
  key,
  env = process.env,
  allowAnchorBehind = false,
  allowBrokenAuditChain = false,
  requireAnchor = false,
  currentSchemaVersion = SCHEMA_VERSION,
  preRestorePath = null,
  expectSameBytes = true,
  verifyAfter = true,
  fs = nodeFs,
  now = Date.now(),
} = {}) {
  let restorePlan = plan
  if (!restorePlan) {
    restorePlan = planRestore({ backupPath, dbPath, currentSchemaVersion, anchor, anchorPath, allowAnchorBehind, allowBrokenAuditChain, requireAnchor, key, home, env, fs })
  }
  if (!restorePlan.ok) return { ...restorePlan, originalIntact: true, storeClosed: false }
  const targetDb = restorePlan.dbPath ?? (dbPath ? resolve(String(dbPath)) : null)
  if (!targetDb) return failure('E_RESTORE_TARGET_MISSING', 'restoreBackup requires {dbPath}')
  if (!/\.db$/i.test(basename(targetDb))) return failure('E_RESTORE_TARGET_UNSAFE', 'restore target must be a .db file: ' + targetDb)
  const backup = restorePlan.path
  const backupInfo = restorePlan.inspection
  const steps = [...(restorePlan.steps ?? [])]
  const warnings = [...(restorePlan.warnings ?? [])]
  const ts = new Date(now)
  let storeClosed = false
  // 1. Quiesce the live store.
  if (store) {
    try {
      const checkpoint = typeof store.checkpoint === 'function' ? store.checkpoint({ mode: 'TRUNCATE' }) : null
      if (checkpoint?.busy) return failure('E_RESTORE_BUSY', 'another connection blocked the pre-restore WAL checkpoint; close other advisers processes and retry', { storeClosed: false, originalIntact: true })
    } catch (error) {
      return failure(error?.code ?? 'E_RESTORE_CHECKPOINT_FAILED', 'cannot checkpoint the live database before restore: ' + String(error?.message ?? error).slice(0, 200), { storeClosed: false, originalIntact: true })
    }
  }
  try {
    if (typeof closeStore === 'function') closeStore()
    else if (store && typeof store.close === 'function') store.close()
    storeClosed = Boolean(store || closeStore)
  } catch (error) {
    return failure('E_RESTORE_CLOSE_FAILED', 'cannot close the live database before restore: ' + String(error?.message ?? error).slice(0, 200), { storeClosed: false, originalIntact: true })
  }
  steps.push('live store checkpointed and closed')
  const walFile = targetDb + '-wal'
  if (fsExists(fs, walFile)) {
    let walSize = 0
    try { walSize = fsStat(fs, walFile).size } catch {}
    if (walSize > 0) {
      return failure('E_RESTORE_WAL_OPEN', 'the live database still has a non-empty -wal file (' + walSize + ' bytes): checkpoint and close every connection before restoring', { storeClosed, originalIntact: true })
    }
  }
  // 2. Pre-restore safety backup of the current database (rollback source).
  const liveExists = fsExists(fs, targetDb)
  let preRestore = null
  if (liveExists) {
    const candidate = preRestorePath ?? defaultPreRestorePath({ dbPath: targetDb, home, at: ts })
    preRestore = uniquePath(candidate, fs)
    try {
      try { mkdirWithRetrySync(dirname(preRestore), { fs }) } catch {}
      copyFileWithRetrySync(targetDb, preRestore, { fs, mode: 0o600 })
      fsyncFileSync(preRestore, { fs })
      try { fs.chmodSync?.(preRestore, 0o600) } catch {}
      try { fsyncDirSync(dirname(preRestore), { fs }) } catch {}
    } catch (error) {
      fsRm(fs, preRestore)
      preRestore = null
      return failure('E_RESTORE_PRERESTORE_FAILED', 'cannot write the pre-restore safety backup ' + candidate + ': ' + String(error?.message ?? error).slice(0, 200), { storeClosed, originalIntact: true })
    }
    steps.push('pre-restore backup -> ' + preRestore)
    const verifiedPre = probeBackupReadable(preRestore, { fs })
    if (!verifiedPre.ok) warnings.push('the current database does not pass quick_check either, so the pre-restore backup is kept for forensics but may not open (' + (verifiedPre.error ?? verifiedPre.quickCheck ?? 'unknown') + ')')
  } else {
    steps.push('no live database: fresh install')
  }
  // 3. Remove stale WAL/SHM of the old database (they must not be applied to the new file).
  for (const suffix of ['-wal', '-shm']) {
    const stale = targetDb + suffix
    if (fsExists(fs, stale)) {
      try { rmWithRetrySync(stale, { fs }) } catch (error) {
        return failure('E_RESTORE_WAL_OPEN', 'cannot remove stale ' + basename(stale) + ': ' + String(error?.message ?? error).slice(0, 200), { storeClosed, originalIntact: true, preRestoreBackup: preRestore })
      }
    }
  }
  // 4. Copy the backup to a same-directory temp file and verify the copy.
  const temp = tempPathForSync(targetDb)
  let tempBytes = 0
  try {
    copyFileWithRetrySync(backup, temp, { fs, mode: 0o600 })
    fsyncFileSync(temp, { fs })
    try { fs.chmodSync?.(temp, 0o600) } catch {}
    tempBytes = fsStat(fs, temp).size
    if (expectSameBytes && tempBytes !== backupInfo.size) {
      fsRm(fs, temp)
      return failure('E_RESTORE_VERIFY_FAILED', 'the copied backup is ' + tempBytes + ' bytes but the source is ' + backupInfo.size + '; the copy was removed and the live database is unchanged', { storeClosed, originalIntact: true, preRestoreBackup: preRestore })
    }
    const tempVerification = verifyDatabaseFile(temp, { expectedSchemaVersion: backupInfo.schemaVersion, expectedHead: backupInfo.audit, fs })
    if (!tempVerification.ok) {
      fsRm(fs, temp)
      return failure('E_RESTORE_VERIFY_FAILED', 'the copied backup did not verify (' + tempVerification.errors.join('; ').slice(0, 300) + '); the copy was removed and the live database is unchanged', { storeClosed, originalIntact: true, preRestoreBackup: preRestore })
    }
    steps.push('copy verified before install')
  } catch (error) {
    fsRm(fs, temp)
    return failure(error?.code ?? 'E_RESTORE_COPY_FAILED', 'cannot copy the backup into place: ' + String(error?.message ?? error).slice(0, 200), { storeClosed, originalIntact: true, preRestoreBackup: preRestore })
  }
  // 5. Atomic install.
  try {
    renameWithRetrySync(temp, targetDb, { fs })
    try { fs.chmodSync?.(targetDb, 0o600) } catch {}
    try { fsyncDirSync(dirname(targetDb), { fs }) } catch {}
    steps.push('backup installed via atomic rename')
  } catch (error) {
    fsRm(fs, temp)
    return failure('E_RESTORE_INSTALL_FAILED', 'cannot install the restore at ' + targetDb + ': ' + String(error?.message ?? error).slice(0, 200) + '; the live database is unchanged', { storeClosed, originalIntact: true, preRestoreBackup: preRestore })
  }
  // 6. Post-install verification with rollback to the pre-restore copy.
  const installed = verifyAfter
    ? verifyDatabaseFile(targetDb, { expectedSchemaVersion: backupInfo.schemaVersion, expectedHead: backupInfo.audit, fs })
    : { ok: true, errors: [], audit: backupInfo.audit }
  if (!installed.ok) {
    for (const suffix of ['-wal', '-shm']) fsRm(fs, targetDb + suffix)
    let rolledBack = false
    let rollbackError = null
    try {
      if (preRestore) {
        renameWithRetrySync(preRestore, targetDb, { fs })
        try { fsyncDirSync(dirname(targetDb), { fs }) } catch {}
        rolledBack = true
      } else {
        rmWithRetrySync(targetDb, { fs })
        rolledBack = true
      }
    } catch (error) {
      rollbackError = String(error?.message ?? error).slice(0, 300)
    }
    if (rollbackError) {
      return failure('E_RESTORE_ROLLBACK_FAILED', 'the restored database did not verify AND rollback failed: ' + rollbackError + '. The pre-restore backup is at ' + (preRestore ?? '(none)') + '; recover manually and keep evidence', { storeClosed, originalIntact: false, preRestoreBackup: preRestore })
    }
    return failure('E_RESTORE_VERIFY_FAILED', 'the restored database did not verify (' + installed.errors.join('; ').slice(0, 300) + '); ' + (rolledBack ? 'the pre-restore backup was rolled back' : 'the partial file was removed'), { storeClosed, originalIntact: true, rolledBack, preRestoreBackup: preRestore })
  }
  steps.push('restored database verified')
  return {
    ok: true,
    code: null,
    dbPath: targetDb,
    restoredFrom: backup,
    preRestoreBackup: preRestore,
    schemaVersion: installed.schemaVersion ?? backupInfo.schemaVersion,
    audit: installed.audit ?? backupInfo.audit,
    storeClosed,
    allowAnchorBehind: Boolean(allowAnchorBehind),
    steps,
    warnings,
    errors: [],
  }
}
