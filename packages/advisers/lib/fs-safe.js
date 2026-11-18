/**
 * Crash-safe filesystem helpers (0.2.3 robustness Phase 0, robustness audit
 * P1-2/P1-3/P1-7).
 *
 * Why this module exists: Node's fs.writeSync (and writeFileSync, which also
 * issues a single write(2)) may write fewer bytes than requested. POSIX allows
 * a short write on ENOSPC/EDQUOT, on signal interruption, and on network/quota
 * filesystems; the 2026-11-17 robustness audit reproduced a 1 MB write into a
 * nearly-full tmpfs returning 204800 bytes with no error, which used to install
 * a truncated state.db.vault. A durable write therefore needs:
 *   1. loop until every byte is written (zero/negative progress is EIO);
 *   2. fsync the file before rename, fsync the directory after rename;
 *   3. never leave a truncated target: write a same-directory temp file, verify
 *      its length, then atomically rename it into place; on any failure remove
 *      the temp file and rethrow (no 'best effort' success);
 *   4. retry transient Windows/AV/OneDrive failures (EPERM/EBUSY/EACCES) with
 *      bounded exponential backoff instead of failing a user command once.
 *
 * This is a library-only module: it never imports node:sqlite and never writes
 * to the user's home. Every function takes an optional `fs` implementation
 * (default: node:fs), so tests can inject short writes and EPERM without root
 * or a full disk (see test/fs-safe.test.js).
 *
 * bin/ integration contract (Wave 1):
 *   - vault seal:      const tmp = writeAllToTempSync(out, bytes, { mode: 0o600 })
 *                      ...verify by decrypting tmp...; commitTempFileSync(tmp, out)
 *   - pet-brief --out: atomicWriteFileSync(file, bytes)
 *   - backup/import:   copyFileWithRetrySync(src, dst); fsyncFileSync(dst)
 *   - any rename/rm:   renameWithRetrySync / rmWithRetrySync
 * Also exported: tempPathForSync/tempPrefixForSync (so stale *.tmp-* scans can
 * name the same scheme), describeFsError (ENOSPC/EACCES -> actionable text).
 */
import * as nodeFs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** errno values retried for transient filesystem contention (Windows AV/OneDrive). */
export const DEFAULT_RETRY_ERRNOS = Object.freeze(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EAGAIN'])
/** Marker embedded in every temp file this module creates. */
export const TEMP_MARKER = '.tmp-'
const DEFAULT_TEMP_PREFIX = '.'
const MAX_BACKOFF_MS = 200

/** Synchronous sleep; used only between bounded retries. */
export function sleepSync(ms) {
  if (!ms || ms <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {}
  }
}

/** Bounded exponential backoff: 10, 20, 40, 80, 160, 200, 200... ms. */
export function retryBackoffMs(attempt) {
  return Math.min(MAX_BACKOFF_MS, 10 * 2 ** Math.max(0, attempt))
}

function errnoOf(error) {
  const code = error?.code ?? error?.errno
  return typeof code === 'string' ? code : ''
}

/** True for transient errno values that a retry can legitimately fix. */
export function isRetryableFsError(error, errnos = DEFAULT_RETRY_ERRNOS) {
  const allowed = errnos instanceof Set ? errnos : new Set(errnos)
  const code = errnoOf(error)
  if (code && allowed.has(code)) return true
  const message = String(error?.message ?? error)
  // libuv/windows sometimes surface EPERM/EBUSY in the message without a code
  // (e.g. wrapped 'operation not permitted, rename ...'), so keep a narrow
  // message fallback. ENOSPC must NOT be retried here.
  return /operation not permitted|resource busy|permission denied/i.test(message) && /rename|unlink|rmdir|copyfile|fsync/i.test(message)
}

/**
 * Retry fn() when it throws a retryable fs error. fn receives the 0-based attempt.
 * Non-retryable errors (ENOSPC, ENOENT, EIO, ...) are rethrown immediately.
 */
export function retryFsSync(fn, { retries = 5, errnos = DEFAULT_RETRY_ERRNOS, backoffMs = retryBackoffMs, sleep = sleepSync, onRetry } = {}) {
  const allowed = errnos instanceof Set ? errnos : new Set(errnos)
  let lastError
  for (let attempt = 0; attempt <= Math.max(0, retries); attempt++) {
    try {
      return fn(attempt)
    } catch (error) {
      lastError = error
      if (attempt >= retries || !isRetryableFsError(error, allowed)) throw error
      try { onRetry?.(attempt, error) } catch {}
      sleep(backoffMs(attempt))
    }
  }
  throw lastError
}

/**
 * Write the whole buffer through fd, looping over short writes.
 * Returns the number of bytes written (always buffer.length or throws).
 * A 0/undefined/negative return is treated as EIO: reporting success after a
 * short write is exactly the bug this helper exists to prevent.
 */
export function writeAllSync(fd, data, { fs = nodeFs } = {}) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  let written = 0
  while (written < buffer.length) {
    const chunk = fs.writeSync(fd, buffer, written, buffer.length - written)
    if (!Number.isFinite(chunk) || chunk <= 0) {
      const error = new Error(`E_SHORT_WRITE: writeSync made no progress after ${written} of ${buffer.length} bytes; refusing to report a truncated write as success`)
      error.code = 'E_SHORT_WRITE'
      error.written = written
      error.expected = buffer.length
      throw error
    }
    written += chunk
  }
  return written
}

/** fsync a file descriptor or a path (opened read-only). */
export function fsyncFileSync(fileOrFd, { fs = nodeFs, retries = 5, errnos = DEFAULT_RETRY_ERRNOS, backoffMs = retryBackoffMs, sleep = sleepSync } = {}) {
  if (typeof fileOrFd === 'number') {
    return retryFsSync(() => fs.fsyncSync(fileOrFd), { retries, errnos, backoffMs, sleep })
  }
  return retryFsSync(() => {
    const fd = fs.openSync(fileOrFd, 'r')
    try { fs.fsyncSync(fd) } finally { try { fs.closeSync(fd) } catch {} }
  }, { retries, errnos, backoffMs, sleep })
}

/**
 * fsync a directory entry so a completed rename survives a crash. Windows
 * returns EPERM for directory fsync (and FAT/network shares may not support it),
 * so this is best-effort by contract: it returns a boolean, never throws.
 */
export function fsyncDirSync(dir, { fs = nodeFs } = {}) {
  try {
    const fd = fs.openSync(dir, 'r')
    try { fs.fsyncSync(fd) } finally { try { fs.closeSync(fd) } catch {} }
    return true
  } catch {
    return false
  }
}

/** Same-directory temp path: hidden, pid+timestamp+random (unique per process). */
export function tempPathForSync(file) {
  const unique = `${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  return join(dirname(file), `${DEFAULT_TEMP_PREFIX}${basename(file)}${TEMP_MARKER}${unique}`)
}

/** Prefix shared by tempPathForSync paths (for stale-temp scans/cleanup). */
export function tempPrefixForSync(file) {
  return join(dirname(file), `${DEFAULT_TEMP_PREFIX}${basename(file)}${TEMP_MARKER}`)
}

/** mkdir -p with retry; mode only applies to directories it creates. */
export function mkdirWithRetrySync(dir, { fs = nodeFs, mode = 0o700, recursive = true, retries = 3 } = {}) {
  retryFsSync(() => fs.mkdirSync(dir, { recursive, mode }), { retries })
  return dir
}

/** rename() with retry on transient EPERM/EBUSY/EACCES. */
export function renameWithRetrySync(from, to, { fs = nodeFs, retries = 5, errnos = DEFAULT_RETRY_ERRNOS, backoffMs = retryBackoffMs, sleep = sleepSync } = {}) {
  retryFsSync(() => fs.renameSync(from, to), { retries, errnos, backoffMs, sleep })
  return to
}

/** rm with retry; force:true so a missing target is not an error. */
export function rmWithRetrySync(target, { fs = nodeFs, retries = 3, force = true, errnos = DEFAULT_RETRY_ERRNOS, backoffMs = retryBackoffMs, sleep = sleepSync } = {}) {
  try {
    retryFsSync(() => fs.rmSync(target, { force }), { retries, errnos, backoffMs, sleep })
    return true
  } catch (error) {
    if (force && errnoOf(error) === 'ENOENT') return false
    throw error
  }
}

/** copyFile with retry, then chmod 0600 unless disabled (backups hold plaintext). */
export function copyFileWithRetrySync(from, to, { fs = nodeFs, mode = 0o600, chmod = true, retries = 5, errnos = DEFAULT_RETRY_ERRNOS, backoffMs = retryBackoffMs, sleep = sleepSync } = {}) {
  retryFsSync(() => fs.copyFileSync(from, to), { retries, errnos, backoffMs, sleep })
  if (chmod && typeof fs.chmodSync === 'function') {
    try { fs.chmodSync(to, mode) } catch {}
  }
  return to
}

function cleanupTemp(fs, tmp) {
  try { fs.rmSync(tmp, { force: true }) } catch {}
}

/**
 * Write data to a fresh same-directory temp file, fsync it, verify its length,
 * and return the temp path. The caller commits with commitTempFileSync() (and
 * must call rmWithRetrySync(tmp) if it abandons the file after verification).
 * On any failure the temp file is removed before the error is rethrown.
 */
export function writeAllToTempSync(file, data, { fs = nodeFs, mode = 0o600, fsync = true, retries = 5, tempPath, expectedBytes } = {}) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const expected = Number.isFinite(expectedBytes) ? expectedBytes : buffer.length
  mkdirWithRetrySync(dirname(file), { fs })
  const tmp = tempPath ?? tempPathForSync(file)
  let fd = null
  let created = false
  try {
    fd = fs.openSync(tmp, 'wx', mode)
    created = true
    writeAllSync(fd, buffer, { fs })
    if (fsync) fsyncFileSync(fd, { fs, retries })
    fs.closeSync(fd)
    fd = null
    if (typeof fs.chmodSync === 'function') { try { fs.chmodSync(tmp, mode) } catch {} }
    const size = fs.statSync(tmp).size
    if (size !== expected) {
      const error = new Error(`E_SHORT_WRITE: wrote ${size} of ${expected} bytes to ${tmp}; refusing to commit a truncated file`)
      error.code = 'E_SHORT_WRITE'
      error.written = size
      error.expected = expected
      throw error
    }
    return tmp
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    // Only remove the temp file when this call created it: a pre-existing file
    // at the same path belongs to someone else and is never deleted.
    if (created) cleanupTemp(fs, tmp)
    throw error
  }
}

/**
 * Atomically install a verified temp file at `file` (same directory, atomic
 * rename). On failure the temp file is removed and the previous target is left
 * untouched (rename is all-or-nothing).
 */
export function commitTempFileSync(tmp, file, { fs = nodeFs, mode = 0o600, retries = 5, errnos = DEFAULT_RETRY_ERRNOS, backoffMs = retryBackoffMs, sleep = sleepSync, fsyncDir = true } = {}) {
  try {
    renameWithRetrySync(tmp, file, { fs, retries, errnos, backoffMs, sleep })
    if (typeof fs.chmodSync === 'function') { try { fs.chmodSync(file, mode) } catch {} }
    if (fsyncDir) fsyncDirSync(dirname(file), { fs })
    return file
  } catch (error) {
    cleanupTemp(fs, tmp)
    throw error
  }
}

/**
 * Durable atomic write of a whole file. This is the one-call API for bin/
 * outputs that must never be installed truncated (vault seal, pet-brief --out,
 * exports). Throws on ENOSPC/EIO/permission errors after removing the temp file.
 */
export function atomicWriteFileSync(file, data, { fs = nodeFs, mode = 0o600, fsync = true, retries = 5, verifyBytes = true } = {}) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const tmp = writeAllToTempSync(file, buffer, { fs, mode, fsync, retries, expectedBytes: verifyBytes ? buffer.length : undefined })
  return commitTempFileSync(tmp, file, { fs, mode, retries })
}

/** Human-actionable one-line explanation for a failed durable write. */
export function describeFsError(error, { action = 'writing', path = '', target = '' } = {}) {
  const code = errnoOf(error)
  const message = String(error?.message ?? error)
  const where = target || path
  if (/ENOSPC|EDQUOT/.test(code) || /no space left|disk quota exceeded/i.test(message)) {
    return `E_NO_SPACE: not enough disk space while ${action}${where ? ` ${where}` : ''} (${code || 'ENOSPC'}); the temp file was removed and no truncated file was installed`
  }
  if (/EACCES|EPERM|EROFS/.test(code)) {
    return `E_FS_PERMISSION: ${action}${where ? ` ${where}` : ''} was denied (${code}); check file/directory permissions, or close the program (antivirus/OneDrive/sync client) that may be holding it`
  }
  if (/EIO/.test(code)) return `E_IO: the filesystem reported an I/O error while ${action}${where ? ` ${where}` : ''}; the write was aborted and the temp file removed`
  return `${action}${where ? ` ${where}` : ''} failed: ${message}`
}

/** Wrap an fs error with the actionable message while preserving code/errno. */
export function wrapFsError(error, context = {}) {
  const wrapped = new Error(describeFsError(error, context))
  if (error?.code !== undefined) wrapped.code = error.code
  if (error?.errno !== undefined) wrapped.errno = error.errno
  wrapped.cause = error
  return wrapped
}

export { nodeFs as defaultFs }
