/**
 * P2: file-based end-to-end encrypted snapshot sync (0.2.2), hardened in 0.2.3
 * (robustness audit 2026-11-17 P1-1/P1-2/P1-3).
 *
 * The user chooses a directory that their existing sync tool (OneDrive, Dropbox,
 * Syncthing, rsync, a NAS) already replicates. Advisers only writes encrypted
 * snapshots there and never talks to a sync server itself.
 *
 * Scope: whole-database snapshots, manual push/pull, last-snapshot-wins.
 * Not provided: continuous merge, multi-writer conflict resolution, cloud accounts.
 * Pull always keeps a verified backup before replacing the local database.
 *
 * 0.2.3 changes (all additive to the public exports):
 * - Snapshot selection uses the snapshot's created time, not the file mtime,
 *   so a sync tool/clock that rewrites timestamps cannot make `pull --force`
 *   silently install an older snapshot. New snapshots carry an envelope-level
 *   `sync.createdAt` copy for cheap ordering; it is checked against the
 *   authenticated payload of the chosen snapshot. Legacy snapshots (no
 *   envelope metadata) are ranked by their authenticated payload createdAt.
 *   When the mtime order and createdAt order disagree by more than 5 minutes
 *   the chosen snapshot is still the content-newest one, with a warning; an
 *   unreadable/undecidable snapshot set requires an explicit `--file`.
 * - `pullSnapshot` reports `localEmpty` / `snapshotOlder` / `status`, lets a
 *   brand-new device bootstrap (empty ledger) without `--force`, and warns
 *   (never silently) when `--force` replaces a local ledger with an older
 *   snapshot or when `--file` selects a non-newest snapshot.
 * - Pull staging files are written durably through lib/fs-safe.js (short-write
 *   loop, fsync, rename retry) and the staging file plus its -wal/-shm siblings
 *   are always removed; `cleanupStalePullTemps()` (bin/doctor hook) sweeps
 *   leftovers from a crashed pull.
 * - `pullSnapshot({ dryRun: true })` makes the same decision — snapshot
 *   selection, decryption + SHA-256, the local-empty/older/same-device checks —
 *   and predicts whether a real pull would replace the database, but writes
 *   nothing: no database replace, no backup, no staging temp, no stale-temp
 *   sweep and no audit row. It returns `status: 'dry-run'` (or `'unchanged'`
 *   when the local bytes already match and `force` is not set) plus
 *   `wouldChange` / `wouldStatus` / `wouldBackup`; warnings are returned for
 *   the caller to print, because a dry run never prints or writes.
 *
 * 0.5.0 changes (050-S2, plan 121 §3; all additive to the public exports):
 * - Snapshot payload v2 adds `dbMtimeMs` (stat before the bytes are read),
 *   `dbSha256` and `sourceSchemaVersion`; v1 payloads stay readable and are
 *   still written only when read (new snapshots use v2).
 * - `$HOME/sync.state.json` (new lib/sync-state.js) records the last successful
 *   push/pull (device, schema, snapshot sha256, local database sha256, time).
 *   Writes happen only after a real push/pull; a broken state file degrades to
 *   0.4.3 behaviour with a warning.
 * - `computeSyncConflict()` is a pure decision function; `precheckSync()` reads
 *   the state + sync directory without writing anything and `pushSnapshot()` /
 *   `pullSnapshot()` refuse a stale overwrite with E_SYNC_CONFLICT unless
 *   force:true (a `.before-sync-*` copy is kept on force). Unknown inputs are
 *   reported as `null`/degraded, never as "checked and safe".
 * - `pushSnapshot({ dryRun: true })` is a real dry run: it plans the snapshot
 *   (name/sha256/size) and writes neither a snapshot file, nor an audit row, nor
 *   the state file. `refreshSyncStateLocalSha()` updates the baseline after a
 *   caller appends its own sync.pull audit row.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decryptJson, encryptJson, isVaultEnvelope } from './vault.js'
import { atomicWriteFileSync, copyFileWithRetrySync, fsyncDirSync, renameWithRetrySync, rmWithRetrySync, writeAllToTempSync } from './fs-safe.js'
import { createSyncState, readSyncState, writeSyncState } from './sync-state.js'

/** Prefix of the staged (plaintext) database copy used while a pull verifies. */
export const PULL_TMP_PREFIX = '.advisers-pull-verify-'
/** Staged pull files older than this (and from a dead pid) are safe to remove. */
export const STALE_PULL_TMP_MS = 60 * 60 * 1000
/** mtime-vs-createdAt disagreement above this is reported/blocked as skew. */
export const SNAPSHOT_CLOCK_SKEW_MS = 5 * 60 * 1000
/** Snapshot payload version written by this CLI (v1 remains readable). */
export const SNAPSHOT_PAYLOAD_VERSION = 2
/** Error code raised when a stale push/pull would overwrite newer remote state. */
export const SYNC_CONFLICT_CODE = 'E_SYNC_CONFLICT'
/** Envelope-level (unencrypted) copy of the snapshot metadata for cheap ordering. */
const ENVELOPE_META_VERSION = 1
const SYNC_ENVELOPE_META_KEY = 'sync'

function randomSuffix() {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Verify that a database file is a structurally valid SQLite database before it
 * is allowed to replace the main database (robustness audit P1-4, 2026-11-17).
 *
 * The snapshot SHA-256 only proves the envelope payload is self-consistent; a
 * byte-corrupted payload is still "consistent" after re-encryption and used to
 * be installed as the live library. PRAGMA quick_check is O(file) and catches
 * corrupt b-trees/pages. The original file is only opened read-only.
 */
function assertDatabaseIntegrity(file) {
  let db
  try {
    // A 0-byte file is a valid "empty database" to SQLite (quick_check says ok),
    // so a truncated snapshot used to replace the live library silently. Treat it
    // as corrupt (robustness audit P2-2 / P1-4) and keep the local database.
    if (statSync(file).size === 0) throw new Error('E_DB_CORRUPT: the snapshot database is 0 bytes (truncated)')
    db = new DatabaseSync(file, { readOnly: true })
    const row = db.prepare('PRAGMA quick_check').get()
    const verdict = String(row?.quick_check ?? 'unknown').slice(0, 120)
    if (verdict !== 'ok') throw new Error(`quick_check reported ${verdict}`)
  } catch (error) {
    throw new Error(`snapshot database failed the integrity check: ${String(error?.message ?? error).slice(0, 200)}`)
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * Open a database read-only without leaving SQLite sidecars behind.
 * A read-only open of a WAL-mode database may still make SQLite create an empty
 * <db>-wal and a <db>-shm in a writable directory; those are inspection
 * artifacts (not part of the ledger) and would otherwise be copied into pull
 * backups or counted as plaintext copies. Only files that did not exist before
 * the open are removed; a pre-existing pending WAL is never touched.
 */
function withReadOnlyDatabase(file, fn) {
  const preexisting = new Set(['-wal', '-shm'].filter((suffix) => existsSync(file + suffix)))
  let db = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    return fn(db)
  } finally {
    try { db?.close() } catch {}
    for (const suffix of ['-wal', '-shm']) {
      if (preexisting.has(suffix)) continue
      const artifact = file + suffix
      try {
        if (!existsSync(artifact)) continue
        // A read-only connection cannot append committed frames; only remove an
        // empty WAL (and the rebuildable shared-memory index).
        if (suffix === '-wal' && statSync(artifact).size > 0) continue
        rmWithRetrySync(artifact)
      } catch {}
    }
  }
}

/** Put the pre-pull database (and its WAL/SHM siblings) back after a failed replace. */
function restoreBackup(backup, dbPath) {
  copyFileWithRetrySync(backup, dbPath)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(backup + suffix)) copyFileWithRetrySync(backup + suffix, dbPath + suffix)
    else { try { rmWithRetrySync(dbPath + suffix) } catch {} }
  }
  try { chmodSync(dbPath, 0o600) } catch {}
}

export const SYNC_PREFIX = 'advisers-'
export const SYNC_SUFFIX = '.enc.json'

export function sanitizeDevice(value) {
  return String(value || 'device').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'device'
}

export function snapshotName(device, date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `${SYNC_PREFIX}${sanitizeDevice(device)}-${stamp}${SYNC_SUFFIX}`
}

/**
 * A snapshot must carry every committed row. bin/ checkpoints the WAL before
 * calling this, but the library API is also used directly: refuse a push while
 * a non-empty -wal still holds possibly-committed data (it would silently
 * produce a snapshot missing the newest writes).
 */
function assertSnapshotSourceComplete(dbPath) {
  const walPath = `${dbPath}-wal`
  try {
    const st = statSync(walPath)
    if (st.size > 0) throw new Error(`refusing to push a snapshot of ${dbPath}: the WAL sidecar still holds ${st.size} bytes of possibly-committed data; close other advisers processes and retry (a checkpoint is required first)`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/** meta.schema_version of a database file, or null (missing/corrupt/empty). */
function readSchemaVersionFromDb(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return null
  try {
    return withReadOnlyDatabase(String(dbPath), (db) => {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
      const version = Number(row?.value)
      return Number.isInteger(version) && version > 0 ? version : null
    })
  } catch {
    return null
  }
}

function sha256OrNull(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null
}

function syncNowMs(now) {
  if (now instanceof Date) {
    const value = now.getTime()
    return Number.isFinite(value) ? value : Date.now()
  }
  if (Number.isFinite(now)) return Number(now)
  return Date.now()
}

function syncEventAt(entry) {
  const ms = Date.parse(entry?.at ?? '')
  return Number.isFinite(ms) ? ms : null
}

/**
 * Read-only fingerprint of the local ledger for conflict detection (S2.1/S2.4):
 * stat BEFORE the bytes are read, hash only when the WAL is empty (otherwise a
 * committed transaction could be missing from the hash), and report the schema
 * version. Never writes, never throws for a missing/unreadable database.
 */
export function readLocalDbFingerprint(dbPath) {
  const result = { ok: false, exists: false, sha256: null, dbMtimeMs: null, walBytes: 0, sourceSchemaVersion: null, size: null, warnings: [], errors: [] }
  if (!dbPath) { result.errors.push('readLocalDbFingerprint requires {dbPath}'); return result }
  let info
  try { info = statSync(String(dbPath)) } catch (error) {
    if (error?.code === 'ENOENT') {
      result.ok = true
      result.warnings.push('there is no local database at ' + dbPath)
      return result
    }
    result.errors.push('cannot stat the local database ' + dbPath + ': ' + String(error?.code ?? error?.message ?? error))
    return result
  }
  if (!info.isFile() || info.size === 0) {
    result.ok = true
    result.warnings.push('the local database is not a regular non-empty file')
    return result
  }
  result.exists = true
  result.size = info.size
  // S2.1: the mtime is captured before the bytes are read.
  result.dbMtimeMs = info.mtimeMs
  try { result.walBytes = Number(statSync(String(dbPath) + '-wal').size) || 0 } catch {}
  result.sourceSchemaVersion = readSchemaVersionFromDb(String(dbPath))
  if (result.walBytes > 0) {
    result.ok = true
    result.warnings.push('the WAL still holds ' + result.walBytes + ' bytes; the local database sha256 is unknown until it is checkpointed')
    return result
  }
  try {
    const bytes = readFileSync(String(dbPath))
    result.sha256 = createHash('sha256').update(bytes).digest('hex')
  } catch (error) {
    result.errors.push('cannot hash the local database ' + dbPath + ': ' + String(error?.message ?? error).slice(0, 200))
    return result
  }
  result.ok = true
  return result
}

export function createSnapshot({ dbPath, passphrase, device = 'device', createdAt = new Date() }) {
  if (!existsSync(dbPath)) throw new Error('no database at ' + dbPath)
  assertSnapshotSourceComplete(dbPath)
  // S2.1: stat BEFORE reading the bytes so the snapshot records the state it
  // was taken from, not the time the read finished.
  let dbMtimeMs = null
  try { dbMtimeMs = statSync(dbPath).mtimeMs } catch {}
  const bytes = readFileSync(dbPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const payload = {
    kind: 'advisers-sync-db',
    version: SNAPSHOT_PAYLOAD_VERSION,
    device: sanitizeDevice(device),
    createdAt: createdAt.toISOString(),
    sha256,
    dbMtimeMs: Number.isFinite(dbMtimeMs) ? dbMtimeMs : null,
    dbSha256: sha256,
    sourceSchemaVersion: readSchemaVersionFromDb(dbPath),
    db: bytes.toString('base64'),
  }
  const envelope = encryptJson(payload, passphrase)
  // 0.2.3 P1-1: an envelope-level copy of createdAt so `sync status` and the
  // default snapshot choice do not depend on file mtimes. It is NOT trusted on
  // its own: pullSnapshot re-decrypts the payload and refuses a mismatch.
  envelope[SYNC_ENVELOPE_META_KEY] = { v: ENVELOPE_META_VERSION, createdAt: payload.createdAt, device: payload.device }
  return { name: snapshotName(device, createdAt), payload, envelope }
}

function keepBeforeSyncCopy(dbPath, now = Date.now()) {
  const target = String(dbPath) + '.before-sync-' + now
  try {
    copyFileWithRetrySync(dbPath, target)
    for (const suffix of ['-wal', '-shm']) {
      try { if (existsSync(dbPath + suffix)) copyFileWithRetrySync(dbPath + suffix, target + suffix) } catch {}
    }
    return { ok: true, path: target, error: null }
  } catch (error) {
    return { ok: false, path: null, error: String(error?.code ?? error?.message ?? error).slice(0, 200) }
  }
}

/**
 * Pick the baseline event that describes the newest known sync state: the
 * latest lastPush/lastPull entry by `at` (push wins an exact tie). Returns null
 * when the baseline has no usable event. Pure (no filesystem access).
 */
export function summarizeSyncBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return null
  const events = []
  if (baseline.lastPush && typeof baseline.lastPush === 'object') {
    events.push({
      kind: 'push',
      at: syncEventAt(baseline.lastPush),
      localDbSha256: sha256OrNull(baseline.lastPush.dbSha256),
      remoteSha256: sha256OrNull(baseline.lastPush.sha256),
    })
  }
  if (baseline.lastPull && typeof baseline.lastPull === 'object') {
    events.push({
      kind: 'pull',
      at: syncEventAt(baseline.lastPull),
      localDbSha256: sha256OrNull(baseline.lastPull.localDbSha256),
      remoteSha256: sha256OrNull(baseline.lastPull.sha256),
    })
  }
  if (!events.length) return null
  events.sort((left, right) => {
    const leftAt = left.at === null ? -Infinity : left.at
    const rightAt = right.at === null ? -Infinity : right.at
    if (leftAt !== rightAt) return rightAt - leftAt
    return left.kind === right.kind ? 0 : left.kind === 'push' ? -1 : 1
  })
  const latest = events[0]
  const pullEvent = events.find((event) => event.kind === 'pull') ?? null
  const pushEvent = events.find((event) => event.kind === 'push') ?? null
  return {
    kind: latest.kind,
    at: latest.at === null ? null : new Date(latest.at).toISOString(),
    localDbSha256: latest.localDbSha256,
    remoteSha256: latest.remoteSha256,
    lastPullAt: pullEvent?.at === null || pullEvent === null ? null : new Date(pullEvent.at).toISOString(),
    lastPushAt: pushEvent?.at === null || pushEvent === null ? null : new Date(pushEvent.at).toISOString(),
  }
}

/**
 * Pure conflict decision (050-S2, plan 121 §3 S2.3).
 *
 * `localChanged` compares the current local database sha256 with the local sha
 * recorded by the newest baseline event; `remoteAdvanced` compares the newest
 * readable remote snapshot sha256 with the remote sha of that event. Both are
 * `null` when the input cannot prove them (no baseline, WAL not checkpointed,
 * unreadable snapshot, no device name) -- unknown is never reported as clear.
 *
 * A conflict only exists when BOTH changed AND the newest snapshot came from a
 * different device. The same snapshot on the same device is an intentional
 * restore and stays allowed (0.4.3 semantics).
 */
export function computeSyncConflict({ localDbSha256 = null, localWalBytes = 0, baseline = null, newest = null, sameDevice = null } = {}) {
  const result = { ok: true, status: 'clear', conflict: false, localChanged: null, remoteAdvanced: null, sameDevice: null, reason: null, baseline: null, warnings: [] }
  const summary = summarizeSyncBaseline(baseline)
  result.baseline = summary
  const walBytes = Number.isFinite(localWalBytes) ? Number(localWalBytes) : 0
  const localSha = sha256OrNull(localDbSha256)
  const newestSha = sha256OrNull(newest?.sha256)
  const hasNewest = Boolean(newest && (newest.sha256 !== undefined || newest.file))
  const same = hasNewest && (sameDevice === true || sameDevice === false) ? sameDevice : null
  result.sameDevice = same
  if (!summary) result.warnings.push('no sync baseline exists yet (first sync on this HOME); conflict detection is degraded')
  else if (summary.localDbSha256 === null) result.warnings.push('the sync baseline has no local database sha256; conflict detection is degraded')
  if (walBytes > 0) result.warnings.push('the WAL still holds ' + walBytes + ' bytes; the local database sha256 is unknown until it is checkpointed')
  if (summary && summary.localDbSha256 !== null && walBytes === 0 && localSha !== null) result.localChanged = localSha !== summary.localDbSha256
  if (!hasNewest) result.warnings.push('no readable snapshot exists in the sync directory, so the remote state is unknown')
  else if (!summary || summary.remoteSha256 === null) result.warnings.push('the sync baseline has no remote snapshot sha256; conflict detection is degraded')
  else if (newestSha === null) result.warnings.push('the newest snapshot has no authenticated sha256; the remote state is unknown')
  else result.remoteAdvanced = newestSha !== summary.remoteSha256
  if (hasNewest && same === null) result.warnings.push('the local device name is unknown, so it cannot be proven that the newest snapshot came from another device')
  if (result.localChanged === true && result.remoteAdvanced === true) {
    if (same === true) {
      result.conflict = false
      result.warnings.push('the newest snapshot was pushed by this device; treating it as our own state')
    } else if (same === false) {
      result.conflict = true
    } else {
      result.conflict = null
    }
  } else if (result.localChanged === null || result.remoteAdvanced === null) {
    result.conflict = null
  } else {
    result.conflict = false
  }
  if (result.conflict === true) {
    result.status = 'conflict'
    result.reason = 'the local database changed since the last sync AND the sync directory has a newer snapshot from another device; continuing would silently discard one side'
  } else if (result.conflict === null) {
    result.status = 'degraded'
    result.reason = 'conflict detection is degraded: ' + (result.warnings[0] ?? 'the local and remote state cannot be compared')
  }
  return result
}

function syncConflictError(precheck) {
  const error = new Error(SYNC_CONFLICT_CODE + ': ' + (precheck?.reason ?? 'a stale sync baseline would overwrite another device\'s changes') + '; re-run with --force to proceed (a .before-sync copy is kept)')
  error.code = SYNC_CONFLICT_CODE
  error.status = precheck?.status ?? 'conflict'
  error.conflict = precheck?.conflict ?? null
  error.localChanged = precheck?.localChanged ?? null
  error.remoteAdvanced = precheck?.remoteAdvanced ?? null
  error.sameDevice = precheck?.sameDevice ?? null
  error.baseline = precheck?.baseline ?? null
  error.newest = precheck?.newest ?? null
  error.warnings = precheck?.warnings ?? []
  return error
}

/**
 * Read-only push/pull/status precheck (050-S2). Never writes and never throws
 * for a degraded baseline: `wouldRefuse` is true only when a stale overwrite is
 * proven (`conflict === true`) and `force` is not set. bin/ decides the exit
 * code; `sync push --dry-run` / `sync status --check --json` reuse this result.
 */
export function precheckSync({ direction = 'push', dir, dbPath = null, passphrase = null, device = null, localDevice = null, home = null, file = null, force = false, now = Date.now(), state = undefined } = {}) {
  const result = { ok: false, direction, status: 'degraded', conflict: null, localChanged: null, remoteAdvanced: null, sameDevice: null, wouldRefuse: false, reason: null, baseline: null, newest: null, local: null, force: Boolean(force), warnings: [], errors: [] }
  if (!['push', 'pull', 'status'].includes(direction)) { result.errors.push('precheckSync direction must be push, pull or status'); return result }
  if (!dir) { result.errors.push('precheckSync requires {dir}'); return result }
  let baseline = state
  if (baseline === undefined) {
    if (home) {
      const read = readSyncState({ home })
      baseline = read.state
      result.warnings.push(...(read.warnings ?? []))
    } else {
      baseline = null
    }
  }
  result.baseline = summarizeSyncBaseline(baseline)
  let fingerprint = { ok: true, exists: false, sha256: null, dbMtimeMs: null, walBytes: 0, sourceSchemaVersion: null, warnings: [], errors: [] }
  if (dbPath) {
    fingerprint = readLocalDbFingerprint(dbPath)
    result.warnings.push(...(fingerprint.warnings ?? []))
    if ((fingerprint.errors ?? []).length) result.errors.push(...fingerprint.errors)
  }
  result.local = {
    exists: Boolean(fingerprint.exists),
    sha256: fingerprint.sha256 ?? null,
    dbMtimeMs: fingerprint.dbMtimeMs ?? null,
    walBytes: Number(fingerprint.walBytes ?? 0),
    sourceSchemaVersion: fingerprint.sourceSchemaVersion ?? null,
  }
  let inspected = { snapshots: [], warnings: [] }
  try { inspected = inspectSnapshots(String(dir), passphrase ? { passphrase } : {}) } catch (error) {
    result.warnings.push('cannot inspect the sync directory ' + dir + ': ' + String(error?.message ?? error).slice(0, 200))
  }
  result.warnings.push(...(inspected.warnings ?? []))
  const candidates = (inspected.snapshots ?? []).filter((entry) => !entry.error)
  let chosen = null
  if (file) {
    chosen = candidates.find((entry) => entry.name === basename(String(file))) ?? null
    if (!chosen) result.warnings.push('the requested snapshot ' + file + ' was not found or cannot be read')
  } else {
    const authenticated = passphrase ? candidates.filter((entry) => entry.readable) : []
    const pool = authenticated.length ? authenticated : candidates.filter((entry) => Number.isFinite(entryTimeMs(entry)))
    chosen = pool.length ? [...pool].sort((left, right) => entryTimeMs(right) - entryTimeMs(left) || right.mtimeMs - left.mtimeMs)[0] : null
    if (!chosen) result.warnings.push('no readable snapshot exists in ' + dir + '; the remote state is unknown')
  }
  if (chosen) {
    result.newest = {
      file: chosen.name,
      sha256: chosen.dbSha256 ?? null,
      device: chosen.device ?? null,
      createdAt: chosen.authenticatedCreatedAt ?? chosen.createdAt ?? null,
      payloadVersion: chosen.payloadVersion ?? null,
      readable: Boolean(chosen.readable),
    }
  }
  const ourDevice = direction === 'push' ? device : (localDevice ?? baseline?.device ?? null)
  const sameDevice = result.newest?.device && ourDevice ? sanitizeDevice(result.newest.device) === sanitizeDevice(ourDevice) : null
  const verdict = computeSyncConflict({ localDbSha256: fingerprint.sha256, localWalBytes: fingerprint.walBytes, baseline, newest: result.newest, sameDevice })
  result.status = verdict.status
  result.conflict = verdict.conflict
  result.localChanged = verdict.localChanged
  result.remoteAdvanced = verdict.remoteAdvanced
  result.sameDevice = verdict.sameDevice
  result.reason = verdict.reason
  result.baseline = verdict.baseline
  result.warnings.push(...verdict.warnings)
  result.wouldRefuse = verdict.conflict === true && force !== true
  result.warnings = [...new Set(result.warnings)]
  result.ok = result.errors.length === 0
  return result
}

/**
 * Plan a push without writing anything (050-S2 real `sync push --dry-run`):
 * no snapshot file, no directory creation, no audit row, no state file. With a
 * non-empty WAL the real push checkpoints first, so the sha256/size cannot be
 * predicted; the plan reports that instead of guessing.
 */
export function planPushSnapshot({ dir, dbPath, passphrase, device = 'device', createdAt = new Date() } = {}) {
  const result = { ok: false, dryRun: true, wouldPush: false, dir: dir ?? null, name: null, file: null, sha256: null, dbSha256: null, dbMtimeMs: null, sourceSchemaVersion: null, bytes: null, walBytes: 0, warnings: [], errors: [] }
  if (!dir) { result.errors.push('planPushSnapshot requires {dir}'); return result }
  if (!dbPath) { result.errors.push('planPushSnapshot requires {dbPath}'); return result }
  const fingerprint = readLocalDbFingerprint(dbPath)
  result.walBytes = Number(fingerprint.walBytes ?? 0)
  result.dbMtimeMs = fingerprint.dbMtimeMs ?? null
  result.sourceSchemaVersion = fingerprint.sourceSchemaVersion ?? null
  result.warnings.push(...(fingerprint.warnings ?? []))
  if (!fingerprint.exists) {
    result.errors.push('no database at ' + dbPath)
    return result
  }
  const name = snapshotName(device, createdAt)
  result.name = name
  result.file = join(String(dir), name)
  result.wouldPush = true
  if (result.walBytes > 0) {
    result.ok = true
    result.warnings.push('the WAL still holds ' + result.walBytes + ' bytes; a real push checkpoints it first, so the snapshot sha256/size cannot be predicted without writing')
    return result
  }
  if (!fingerprint.sha256) {
    result.ok = true
    result.warnings.push('the local database sha256 is unavailable; the snapshot sha256 cannot be predicted')
    return result
  }
  try {
    const snap = createSnapshot({ dbPath, passphrase, device, createdAt })
    result.sha256 = snap.payload.sha256
    result.dbSha256 = snap.payload.dbSha256 ?? snap.payload.sha256
    result.dbMtimeMs = snap.payload.dbMtimeMs ?? result.dbMtimeMs
    result.sourceSchemaVersion = snap.payload.sourceSchemaVersion ?? result.sourceSchemaVersion
    result.bytes = Buffer.byteLength(JSON.stringify(snap.envelope) + '\n')
    result.ok = true
  } catch (error) {
    result.errors.push(String(error?.message ?? error).slice(0, 300))
  }
  return result
}

export function pushSnapshot({ dir, dbPath, passphrase, device = 'device', createdAt = new Date(), dryRun = false, home = null, force = false, precheck = true, now = Date.now() } = {}) {
  const isDryRun = Boolean(dryRun)
  if (isDryRun) {
    const plan = planPushSnapshot({ dir, dbPath, passphrase, device, createdAt })
    let check = null
    if (precheck && home) check = precheckSync({ direction: 'push', dir, dbPath, passphrase, device, home, force, now })
    const result = {
      ...plan,
      dryRun: true,
      localDirty: check?.localChanged ?? null,
      localChanged: check?.localChanged ?? null,
      remoteAdvanced: check?.remoteAdvanced ?? null,
      conflict: check?.conflict ?? null,
      baseline: check?.baseline ?? null,
      syncCheck: check?.status ?? null,
      wouldRefuse: Boolean(check?.wouldRefuse),
      backup: null,
      state: null,
    }
    if ((check?.warnings ?? []).length) result.warnings = [...(plan.warnings ?? []), ...check.warnings]
    return result
  }
  let check = null
  if (precheck && home) {
    check = precheckSync({ direction: 'push', dir, dbPath, passphrase, device, home, force, now })
    if ((check.errors ?? []).length) throw new Error('sync precheck failed: ' + check.errors.join('; '))
    if (check.wouldRefuse) throw syncConflictError(check)
  }
  // --force always keeps a local pre-sync copy: bin/ runs its own precheck
  // (before its sync.push audit row) and passes precheck:false here, so the
  // conflict decision is not available to this call and must not be guessed.
  const backup = force === true ? keepBeforeSyncCopy(dbPath, syncNowMs(now)) : null
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const snap = createSnapshot({ dbPath, passphrase, device, createdAt })
  const out = join(dir, snap.name)
  const body = JSON.stringify(snap.envelope) + '\n'
  atomicWriteFileSync(out, body, { mode: 0o600 })
  const result = {
    file: out,
    sha256: snap.payload.sha256,
    bytes: Buffer.byteLength(body),
    name: snap.name,
    payloadVersion: snap.payload.version,
    dbSha256: snap.payload.dbSha256 ?? snap.payload.sha256,
    dbMtimeMs: snap.payload.dbMtimeMs ?? null,
    sourceSchemaVersion: snap.payload.sourceSchemaVersion ?? null,
    localDirty: check?.localChanged ?? null,
    localChanged: check?.localChanged ?? null,
    remoteAdvanced: check?.remoteAdvanced ?? null,
    conflict: check?.conflict ?? null,
    baseline: check?.baseline ?? null,
    syncCheck: check?.status ?? null,
    backup: null,
    state: null,
  }
  if ((check?.warnings ?? []).length) result.warnings = [...check.warnings]
  if (backup) {
    if (backup.ok) result.backup = backup.path
    else result.warnings = [...(result.warnings ?? []), '--force could not keep a .before-sync copy: ' + backup.error]
  }
  if (home) result.state = recordPushState({ home, name: snap.name, payload: snap.payload, device, now })
  return result
}

function recordPushState({ home, name, payload, device, now } = {}) {
  try {
    const read = readSyncState({ home })
    const state = read.state ?? createSyncState({ device: sanitizeDevice(device) })
    state.device = sanitizeDevice(device)
    if (Number.isInteger(payload?.sourceSchemaVersion)) state.localSchemaVersion = payload.sourceSchemaVersion
    state.lastPush = { file: name, sha256: payload.sha256, dbSha256: payload.dbSha256 ?? payload.sha256, at: new Date(syncNowMs(now)).toISOString() }
    const written = writeSyncState({ home, state })
    return { ok: Boolean(written.ok), path: written.path ?? null, warnings: [...(read.warnings ?? []), ...(written.warnings ?? [])], errors: written.errors ?? [] }
  } catch (error) {
    return { ok: false, path: null, warnings: ['the sync baseline could not be updated: ' + String(error?.message ?? error).slice(0, 160)], errors: [] }
  }
}

function recordPullState({ home, name, payload, sha256, localDevice, now } = {}) {
  try {
    const read = readSyncState({ home })
    const device = localDevice ? sanitizeDevice(localDevice) : null
    const state = read.state ?? createSyncState({ device })
    if (device) state.device = device
    if (Number.isInteger(payload?.sourceSchemaVersion)) state.localSchemaVersion = payload.sourceSchemaVersion
    state.lastPull = {
      file: name,
      sha256: payload.sha256,
      createdAt: payload.createdAt ?? null,
      sourceDevice: payload?.device ? sanitizeDevice(payload.device) : null,
      localDbSha256: sha256,
      at: new Date(syncNowMs(now)).toISOString(),
    }
    const written = writeSyncState({ home, state })
    return { ok: Boolean(written.ok), path: written.path ?? null, warnings: [...(read.warnings ?? []), ...(written.warnings ?? [])], errors: written.errors ?? [] }
  } catch (error) {
    return { ok: false, path: null, warnings: ['the sync baseline could not be updated: ' + String(error?.message ?? error).slice(0, 160)], errors: [] }
  }
}

/**
 * Refresh the baseline's local sha256 after the caller appended its own
 * `sync.pull` audit row (that row changes the database bytes after a successful
 * pull). Without this the next precheck would see a false local change. A no-op
 * when the newest baseline event is not a pull (a push already records the
 * post-audit bytes).
 */
export function refreshSyncStateLocalSha({ home, dbPath } = {}) {
  const result = { ok: false, skipped: false, path: null, sha256: null, updated: null, warnings: [], errors: [] }
  if (!home) { result.errors.push('refreshSyncStateLocalSha requires {home}'); return result }
  const read = readSyncState({ home })
  result.path = read.path ?? null
  result.warnings.push(...(read.warnings ?? []))
  const state = read.state
  if (!state) { result.ok = true; result.skipped = true; return result }
  const fingerprint = readLocalDbFingerprint(dbPath)
  result.warnings.push(...(fingerprint.warnings ?? []))
  if (!fingerprint.sha256) { result.errors.push('the local database sha256 is unknown; the sync baseline was not refreshed'); return result }
  const baseline = summarizeSyncBaseline(state)
  if (baseline?.kind !== 'pull' || !state.lastPull) {
    result.ok = true
    result.skipped = true
    result.updated = baseline?.kind ?? null
    result.warnings.push('the newest baseline event is not a pull; no post-audit refresh is needed')
    return result
  }
  state.lastPull.localDbSha256 = fingerprint.sha256
  if (Number.isInteger(fingerprint.sourceSchemaVersion)) state.localSchemaVersion = fingerprint.sourceSchemaVersion
  const written = writeSyncState({ home, state })
  result.ok = Boolean(written.ok)
  result.sha256 = fingerprint.sha256
  result.updated = 'lastPull.localDbSha256'
  result.path = written.path ?? result.path
  result.warnings.push(...(written.warnings ?? []))
  result.errors.push(...(written.errors ?? []))
  return result
}

/** Cheap listing for `sync status`: file metadata plus the envelope createdAt (if any). */
export function listSnapshots(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.startsWith(SYNC_PREFIX) && n.endsWith(SYNC_SUFFIX))
    .map((name) => {
      const file = join(dir, name)
      const st = statSync(file)
      const entry = { name, mtimeMs: st.mtimeMs, bytes: st.size }
      try {
        const envelope = JSON.parse(readFileSync(file, 'utf8'))
        const meta = envelope?.[SYNC_ENVELOPE_META_KEY]
        if (meta && typeof meta.createdAt === 'string' && Number.isFinite(Date.parse(meta.createdAt))) {
          entry.createdAt = meta.createdAt
          entry.createdAtSource = 'envelope'
        }
      } catch {}
      return entry
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function entryTimeMs(entry) {
  if (Number.isFinite(entry.authenticatedCreatedAtMs)) return entry.authenticatedCreatedAtMs
  if (Number.isFinite(entry.createdAtMs)) return entry.createdAtMs
  return NaN
}

/**
 * Inspect every snapshot file: file metadata, envelope-level createdAt, and
 * (with a passphrase) the authenticated payload createdAt/device. Options are
 * extracted and the decrypted payload is dropped, so memory stays bounded.
 */
export function inspectSnapshots(dir, { passphrase } = {}) {
  const result = { snapshots: [], warnings: [] }
  if (!existsSync(dir)) return result
  for (const name of readdirSync(dir).filter((n) => n.startsWith(SYNC_PREFIX) && n.endsWith(SYNC_SUFFIX)).sort()) {
    const file = join(dir, name)
    let st
    try { st = statSync(file) } catch (error) { result.warnings.push(`cannot stat snapshot ${name}: ${String(error?.message ?? error).slice(0, 120)}`); continue }
    const entry = {
      name,
      file,
      mtimeMs: st.mtimeMs,
      bytes: st.size,
      createdAt: null,
      createdAtMs: null,
      createdAtSource: null,
      authenticatedCreatedAt: null,
      authenticatedCreatedAtMs: null,
      payloadVersion: null,
      dbSha256: null,
      dbMtimeMs: null,
      sourceSchemaVersion: null,
      device: null,
      readable: false,
      error: null,
    }
    let envelope = null
    try { envelope = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { entry.error = `not valid JSON (${String(error?.message ?? error).slice(0, 120)})` }
    if (envelope) {
      if (!isVaultEnvelope(envelope)) {
        entry.error = 'not an Advisers encrypted envelope'
      } else {
        const meta = envelope?.[SYNC_ENVELOPE_META_KEY]
        if (meta && typeof meta.createdAt === 'string' && Number.isFinite(Date.parse(meta.createdAt))) {
          entry.createdAt = meta.createdAt
          entry.createdAtMs = Date.parse(meta.createdAt)
          entry.createdAtSource = 'envelope'
        }
        if (meta?.device) entry.device = sanitizeDevice(meta.device)
        if (passphrase) {
          try {
            const payload = decryptJson(envelope, passphrase)
            if (payload?.kind !== 'advisers-sync-db' || typeof payload.db !== 'string') throw new Error('not an Advisers database snapshot')
            const payloadVersion = Number.isInteger(payload.version) ? payload.version : 1
            if (payloadVersion > SNAPSHOT_PAYLOAD_VERSION) throw new Error('snapshot payload version ' + payloadVersion + ' is newer than this CLI supports (v' + SNAPSHOT_PAYLOAD_VERSION + '); upgrade advisers')
            const payloadSha256 = sha256OrNull(payload.sha256)
            if (!payloadSha256) throw new Error('snapshot payload has no valid sha256')
            // The decrypted bytes are authenticated by `sha256` (the field
            // pullSnapshot re-computes). v2 repeats the database hash as
            // `dbSha256`; a disagreement is reported but does not make the
            // snapshot unusable, because sha256 remains the checked value (a
            // hand-built/tampered payload must not bypass the staging quick_check).
            const recordedDbSha256 = payloadVersion >= 2 ? sha256OrNull(payload.dbSha256) : payloadSha256
            if (payloadVersion >= 2 && recordedDbSha256 !== payloadSha256) {
              result.warnings.push('snapshot ' + name + ' payload dbSha256 disagrees with its sha256; using the sha256-verified database hash')
            }
            const payloadAt = Date.parse(payload.createdAt ?? '')
            entry.readable = true
            entry.payloadVersion = payloadVersion
            entry.dbSha256 = payloadSha256
            entry.dbSha256Recorded = recordedDbSha256
            entry.dbMtimeMs = Number.isFinite(payload.dbMtimeMs) ? payload.dbMtimeMs : null
            entry.sourceSchemaVersion = Number.isInteger(payload.sourceSchemaVersion) ? payload.sourceSchemaVersion : null
            if (Number.isFinite(payloadAt)) {
              entry.authenticatedCreatedAt = payload.createdAt
              entry.authenticatedCreatedAtMs = payloadAt
            }
            entry.device = sanitizeDevice(payload.device ?? entry.device)
            if (entry.createdAtMs != null && Number.isFinite(payloadAt) && Math.abs(entry.createdAtMs - payloadAt) > 1000) {
              entry.error = `envelope metadata createdAt ${entry.createdAt} does not match the authenticated payload ${payload.createdAt} (the sync directory may have been tampered with)`
            }
          } catch (error) {
            entry.readable = false
            entry.error = String(error?.message ?? error).slice(0, 200)
          }
        }
      }
    }
    result.snapshots.push(entry)
  }
  return result
}

/**
 * Choose which snapshot a pull should install.
 *
 * Rules (P1-1):
 * - `file` is an explicit user choice; it must be readable.
 * - Otherwise the snapshot with the newest authenticated createdAt wins. Ties
 *   fall back to file mtime.
 * - If any candidate is unreadable, the newest cannot be proven: require
 *   `--file` instead of guessing.
 * - If the newest file mtime belongs to a different snapshot than the newest
 *   createdAt and their times disagree by more than SNAPSHOT_CLOCK_SKEW_MS, the
 *   timestamps are not trustworthy: require `--file` (an ordinary skew with an
 *   agreed order only warns).
 */
export function selectSnapshot({ dir, passphrase, file, now = Date.now() } = {}) {
  const { snapshots, warnings } = inspectSnapshots(dir, { passphrase })
  if (!snapshots.length) throw new Error(`no Advisers snapshots in ${dir}`)
  const explicit = Boolean(file)
  let chosen
  if (explicit) {
    chosen = snapshots.find((entry) => entry.name === basename(file))
    if (!chosen) throw new Error(`snapshot not found: ${file}`)
    if (chosen.error) throw new Error(`snapshot ${chosen.name} cannot be used: ${chosen.error}`)
  } else {
    const unreadable = snapshots.filter((entry) => entry.error)
    if (unreadable.length) {
      const detail = unreadable.map((entry) => `${entry.name} (${entry.error})`).join('; ')
      throw new Error(`cannot determine the newest snapshot: ${detail}; re-run with --file <snapshot> to choose one explicitly`)
    }
    const undetermined = snapshots.filter((entry) => !Number.isFinite(entryTimeMs(entry)))
    if (undetermined.length) {
      const names = undetermined.map((entry) => entry.name).join(', ')
      throw new Error(`cannot determine the newest snapshot: ${names} has no readable createdAt; re-run with --file <snapshot>`)
    }
    const ordered = [...snapshots].sort((a, b) => entryTimeMs(b) - entryTimeMs(a) || b.mtimeMs - a.mtimeMs)
    chosen = ordered[0]
    const mtimeTop = [...snapshots].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (mtimeTop && mtimeTop.name !== chosen.name) {
      const mtimeTopTime = entryTimeMs(mtimeTop)
      if (mtimeTopTime > entryTimeMs(chosen) + SNAPSHOT_CLOCK_SKEW_MS) {
        const minutes = SNAPSHOT_CLOCK_SKEW_MS / 60000
        throw new Error(`cannot determine the newest snapshot: ${mtimeTop.name} has the newest file mtime but ${chosen.name} has the newest embedded createdAt (disagreement > ${minutes} min); file timestamps may be skewed by a sync tool or a clock change — re-run with --file <snapshot>`)
      }
      warnings.push(`snapshot file mtimes disagree with their embedded createdAt (${mtimeTop.name} is newest by mtime, ${chosen.name} by createdAt); using ${chosen.name} (a sync tool may have rewritten timestamps)`)
    }
  }
  if (explicit && !chosen.error) {
    const newest = [...snapshots].filter((entry) => !entry.error && Number.isFinite(entryTimeMs(entry))).sort((a, b) => entryTimeMs(b) - entryTimeMs(a))[0]
    if (newest && newest.name !== chosen.name) {
      warnings.push(`--file selected ${chosen.name}, but ${newest.name} has a newer createdAt (${newest.authenticatedCreatedAt ?? newest.createdAt}); --force does not change snapshot selection`)
    }
  }
  return { chosen, snapshots, warnings, explicit }
}

/** Tables that mean "this local ledger has user data" (used for bootstrap). */
const LOCAL_CONTENT_TABLES = [
  'matters', 'facts', 'commitments', 'preferences', 'links', 'updates', 'routines', 'routine_patches',
  'turns', 'session_summaries', 'sessions', 'deliveries', 'task_runs', 'nudges', 'calendar_events',
  'memory_candidates', 'research_runs', 'model_calls',
]

/**
 * Is the local database empty (a brand-new device) or does it hold user data?
 * A TOS-gate/init-created database has schema tables but no rows; the gate's
 * audit rows (tos.*) and sync.* audit rows do not count as user data. Empty
 * local ledgers are allowed to be replaced by a pull WITHOUT --force (P1-1):
 * on a new device, the empty DB created by `init`/TOS is always newer by mtime
 * than a snapshot taken elsewhere, which used to make documented bootstrap
 * impossible. Errors (locked/corrupt DB) are treated as NOT empty (fail-safe).
 */
export function inspectLocalLedger(dbPath) {
  const result = { exists: false, empty: true, counts: {}, userRows: 0, auditRows: 0, meaningfulAuditRows: 0, error: null }
  if (!dbPath) { result.empty = false; result.error = 'no database path'; return result }
  let st
  try { st = statSync(dbPath) } catch (error) {
    if (error?.code === 'ENOENT') return result
    result.empty = false
    result.error = String(error?.message ?? error).slice(0, 200)
    return result
  }
  result.exists = true
  if (!st.isFile() || st.size === 0) {
    result.empty = false
    result.error = 'the local database is not a regular non-empty file'
    return result
  }
  try {
    return withReadOnlyDatabase(dbPath, (db) => {
      const tableNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
      let userRows = 0
      for (const table of LOCAL_CONTENT_TABLES) {
        if (!tableNames.has(table)) continue
        const n = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0)
        result.counts[table] = n
        userRows += n
      }
      result.userRows = userRows
      if (tableNames.has('audit')) {
        result.auditRows = Number(db.prepare('SELECT COUNT(*) AS n FROM audit').get()?.n ?? 0)
        result.meaningfulAuditRows = Number(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action NOT LIKE 'tos.%' AND action NOT LIKE 'sync.%'").get()?.n ?? 0)
        result.counts.audit = result.auditRows
      }
      result.empty = userRows === 0 && result.meaningfulAuditRows === 0
      return result
    })
  } catch (error) {
    // Fail safe: a locked/corrupt database is never treated as disposable.
    result.empty = false
    result.error = String(error?.message ?? error).slice(0, 200)
    return result
  }
}

/**
 * Remove staged pull files left behind by a crashed/killed pull (P1-3). Only
 * files with the pull staging prefix are touched, and only when they are older
 * than maxAgeMs AND their pid is not alive, so a concurrent pull is never
 * disturbed. bin/doctor should call this on the HOME directory.
 */
export function cleanupStalePullTemps(dir, { maxAgeMs = STALE_PULL_TMP_MS, now = Date.now() } = {}) {
  const result = { removed: [], kept: [], errors: [] }
  let names
  try { names = readdirSync(dir) } catch (error) { result.errors.push(String(error?.message ?? error).slice(0, 160)); return result }
  for (const name of names) {
    if (!name.startsWith(PULL_TMP_PREFIX)) continue
    const file = join(dir, name)
    const pid = Number.parseInt(name.slice(PULL_TMP_PREFIX.length).split('-')[0], 10)
    let st
    try { st = statSync(file) } catch (error) { if (error?.code !== 'ENOENT') result.errors.push(`${file}: ${String(error?.message ?? error).slice(0, 120)}`); continue }
    if (now - st.mtimeMs < maxAgeMs) { result.kept.push(file); continue }
    if (Number.isFinite(pid) && pid > 0) {
      if (pid === process.pid) { result.kept.push(file); continue }
      try { process.kill(pid, 0); result.kept.push(file); continue } catch (error) { if (error?.code !== 'ESRCH') { result.kept.push(file); continue } }
    }
    try { rmWithRetrySync(file); result.removed.push(file) } catch (error) { result.errors.push(`${file}: ${String(error?.message ?? error).slice(0, 120)}`) }
  }
  return result
}

function latestDbMtime(dbPath) {
  let latest = 0
  for (const suffix of ['', '-wal']) {
    try { latest = Math.max(latest, statSync(dbPath + suffix).mtimeMs) } catch {}
  }
  return latest
}

function emitWarnings(warnings) {
  for (const warning of warnings ?? []) {
    try { console.warn(`advisers: warning: ${warning}`) } catch {}
  }
}

/**
 * Replace the local database with the selected snapshot.
 *
 * Safety rules:
 * - a local ledger with user data is only replaced when (a) the snapshot was
 *   pushed from this same HOME (intentional restore), (b) it is not older than
 *   the local write, or (c) the caller passed force:true (a verified backup is
 *   kept on every path);
 * - a new device (no local DB, or an empty ledger) bootstraps without --force,
 *   still keeping a backup when a local file existed;
 * - the snapshot is staged next to the database and passes quick_check before
 *   anything replaces the live library;
 * - the result reports { changed, status, localEmpty, snapshotOlder, sameDevice,
 *   backup, warnings } so bin/ can explain what happened. `status` is one of
 *   unchanged | pulled | bootstrapped | forced.
 * - --force never changes WHICH snapshot is selected (selection is always the
 *   newest readable one unless --file names one), and replacing the local
 *   ledger with an older snapshot is warned about loudly.
 * - dryRun:true stops after the read-only decision phase. It reports the same
 *   file/sha256/device/createdAt/localEmpty/snapshotOlder/sameDevice/warnings a
 *   real pull would report, plus `wouldChange`, `wouldStatus` (the status a
 *   real pull would return: pulled | bootstrapped | forced | unchanged) and
 *   `wouldBackup`, while `changed` stays false and `backup` stays null. A
 *   caller can therefore explain what WOULD happen, and bin/ keeps its
 *   sync.pull audit off because it only audits `changed` pulls. The snapshot's
 *   PRAGMA quick_check is intentionally NOT run: it needs the decrypted bytes
 *   staged next to the database, which a dry run must not do, so a snapshot
 *   whose SHA-256 is self-consistent but whose bytes are not a SQLite database
 *   is predicted as a change and then refused by the real pull (the live
 *   database stays intact; see test/sync-pull-integrity.test.js).
 *
 * 0.5.0 (050-S2): when `home` is supplied the call reads `sync.state.json` first
 * and refuses a stale overwrite with E_SYNC_CONFLICT before staging anything
 * (force:true proceeds and keeps the usual `.before-sync-*` copy). The result
 * reports additive localDirty/remoteAdvanced/conflict/baseline/payloadVersion/
 * dbSha256/dbMtimeMs/sourceSchemaVersion keys, and a successful replacement
 * records lastPull in the baseline (a failed state write only warns).
 * precheck:false lets bin/ run the precheck itself (before its audit row).
 */
export function pullSnapshot({ dir, dbPath, passphrase, file, force = false, dryRun = false, localMtimeMs, localDevice, home = null, precheck = true, state = undefined, now = Date.now() }) {
  const isDryRun = Boolean(dryRun)
  const { chosen, warnings: selectionWarnings } = selectSnapshot({ dir, passphrase, file, now })
  const envelope = JSON.parse(readFileSync(chosen.file, 'utf8'))
  if (!isVaultEnvelope(envelope)) throw new Error('snapshot is not an Advisers encrypted envelope')
  const payload = decryptJson(envelope, passphrase)
  if (payload.kind !== 'advisers-sync-db' || typeof payload.db !== 'string') throw new Error('snapshot is not an Advisers database snapshot')
  const payloadVersion = Number.isInteger(payload.version) ? payload.version : 1
  if (payloadVersion > SNAPSHOT_PAYLOAD_VERSION) throw new Error('snapshot payload version ' + payloadVersion + ' is newer than this CLI supports (v' + SNAPSHOT_PAYLOAD_VERSION + '); upgrade advisers')
  const bytes = Buffer.from(payload.db, 'base64')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== payload.sha256) throw new Error('snapshot checksum mismatch')
  // The decrypted bytes are authenticated by `sha256` above. v2 repeats the
  // database hash as `dbSha256`; a disagreement is reported as a warning but
  // sha256 stays authoritative (see inspectSnapshots).
  const payloadDbSha256 = payloadVersion >= 2 ? sha256OrNull(payload.dbSha256) : payload.sha256
  const payloadWarnings = []
  if (payloadVersion >= 2 && payloadDbSha256 !== null && payloadDbSha256 !== sha256) {
    payloadWarnings.push('the snapshot payload dbSha256 disagrees with its sha256; using the sha256-verified database hash')
  }
  // 0.5.0 S2.4: refuse a stale overwrite before any write. The precheck only
  // runs when a HOME is supplied; library callers without a state baseline keep
  // the 0.4.3 semantics.
  const precheckInfo = precheck && home ? precheckSync({ direction: 'pull', dir, dbPath, passphrase, file, localDevice, home, force, now, state }) : null
  if (precheckInfo?.wouldRefuse) throw syncConflictError(precheckInfo)
  const snapshotAt = Date.parse(payload.createdAt ?? '')
  const sameDevice = Boolean(localDevice) && Boolean(payload.device) && sanitizeDevice(payload.device) === sanitizeDevice(localDevice)
  const local = inspectLocalLedger(dbPath)
  const localEmpty = local.empty
  const localAt = Number.isFinite(localMtimeMs) && localMtimeMs > 0 ? localMtimeMs : latestDbMtime(dbPath)
  // Only meaningful for a non-empty local ledger: a new device's empty DB is
  // always 'newer' by mtime but has no writes worth protecting.
  const snapshotOlder = !localEmpty && Number.isFinite(snapshotAt) && localAt > 0 && localAt > snapshotAt
  const warnings = [...selectionWarnings, ...payloadWarnings, ...(precheckInfo?.warnings ?? [])]
  const base = {
    file: chosen.name,
    sha256,
    device: payload.device,
    createdAt: payload.createdAt,
    payloadVersion,
    dbSha256: sha256,
    dbMtimeMs: Number.isFinite(payload.dbMtimeMs) ? payload.dbMtimeMs : null,
    sourceSchemaVersion: Number.isInteger(payload.sourceSchemaVersion) ? payload.sourceSchemaVersion : null,
    localEmpty,
    snapshotOlder,
    sameDevice,
    explicit: Boolean(file),
    localDirty: precheckInfo?.localChanged ?? null,
    localChanged: precheckInfo?.localChanged ?? null,
    remoteAdvanced: precheckInfo?.remoteAdvanced ?? null,
    conflict: precheckInfo?.conflict ?? null,
    baseline: precheckInfo?.baseline ?? null,
    syncCheck: precheckInfo?.status ?? null,
    warnings,
    backup: null,
    state: null,
  }

  // Same bytes: no work to do. Kept force-sensitive for CLI compatibility
  // (`sync pull --force` has always replaced the file even when identical).
  if (local.exists && !force) {
    let localBytes = null
    try { localBytes = readFileSync(dbPath) } catch {}
    if (localBytes && localBytes.equals(bytes)) {
      const unchanged = { ...base, changed: false, status: 'unchanged' }
      // A dry run reports the same no-op verdict without touching anything.
      if (!isDryRun) return unchanged
      return { ...unchanged, dryRun: true, wouldChange: false, wouldStatus: 'unchanged', wouldBackup: false }
    }
  }

  if (local.exists && !localEmpty && !sameDevice && !force) {
    if (!Number.isFinite(snapshotAt)) throw new Error(`cannot tell whether the local database is newer than ${chosen.name} (snapshot has no valid createdAt); re-run with --force to overwrite and keep a backup`)
    if (snapshotOlder) throw new Error(`refusing to overwrite: the local database was written after snapshot ${chosen.name} (local ${new Date(localAt).toISOString()} > snapshot ${new Date(snapshotAt).toISOString()}). If those local writes matter, back them up/export them first; re-run with --force to overwrite anyway (a backup is kept).`)
  }

  let status = 'pulled'
  if (localEmpty) status = 'bootstrapped'
  else if (force) status = 'forced'
  if (local.exists && !localEmpty && snapshotOlder) {
    const reason = force ? '--force was given' : 'the snapshot was pushed from this device'
    warnings.push(`replacing a newer local database (${new Date(localAt).toISOString()}) with older snapshot ${chosen.name} (${new Date(snapshotAt).toISOString()}) because ${reason}; a backup is kept`)
  }

  // Dry run: everything above (selection, decryption, SHA-256, refusal rules,
  // local state) is the same decision a real pull makes; everything below
  // (temp staging, backup, rename, stale-temp sweep) is a write. Stop here and
  // predict instead. `changed` stays false so a caller cannot mistake this for
  // an applied pull (bin/ only audits changed pulls and keeps its backup note
  // from `backup`, which stays null). Warnings are returned, not printed.
  if (isDryRun) {
    return { ...base, changed: false, status: 'dry-run', dryRun: true, wouldChange: true, wouldStatus: status, wouldBackup: local.exists }
  }

  emitWarnings(warnings)

  const parent = dirname(dbPath)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  // Sweep leftovers from crashed pulls before staging a fresh one (only stale
  // files whose pid is gone are removed; a concurrent pull is never disturbed).
  try { cleanupStalePullTemps(parent, { now }) } catch {}
  const tmp = join(parent, `${PULL_TMP_PREFIX}${process.pid}-${randomSuffix()}`)
  let backup = null
  try {
    // Durable staging write (fs-safe short-write loop + fsync + size check).
    writeAllToTempSync(dbPath, bytes, { mode: 0o600, tempPath: tmp })
    const hadLocal = existsSync(dbPath)
    if (hadLocal) {
      backup = `${dbPath}.before-sync-${Date.now()}`
      copyFileWithRetrySync(dbPath, backup)
      for (const suffix of ['-wal', '-shm']) {
        try { if (existsSync(dbPath + suffix)) copyFileWithRetrySync(dbPath + suffix, backup + suffix) } catch {}
      }
    }
    try {
      assertDatabaseIntegrity(tmp)
    } catch (error) {
      throw new Error(`refusing to replace the local database: ${error.message}`)
    }
    for (const suffix of ['-wal', '-shm']) { try { rmWithRetrySync(dbPath + suffix) } catch {} }
    try {
      // Rename the verified bytes into place (same directory: atomic).
      renameWithRetrySync(tmp, dbPath)
      try { chmodSync(dbPath, 0o600) } catch {}
      fsyncDirSync(parent)
    } catch (error) {
      // A failure after the rename must never leave a half-installed library:
      // restore the pre-pull database and keep the backup for inspection.
      let restored = false
      try {
        if (hadLocal && backup) {
          restoreBackup(backup, dbPath)
          restored = true
        } else {
          rmWithRetrySync(dbPath)
          restored = true
        }
      } catch {}
      const hint = restored ? 'the previous local database was restored' : 'restore the backup manually from ' + String(backup)
      throw new Error(`failed to install the verified snapshot; ${hint}: ${error.message}`)
    }
    const result = { ...base, changed: true, backup, status, replacedLocalEmpty: local.exists && localEmpty }
    // 0.5.0 S2.2: record the baseline AFTER the database (and its backup) are in
    // place. A state write failure is a warning: the pull already succeeded.
    if (home) result.state = recordPullState({ home, name: chosen.name, payload, sha256, localDevice, now })
    return result
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try { if (existsSync(tmp + suffix)) rmWithRetrySync(tmp + suffix) } catch {}
    }
  }
}

// 0.5.0 S2.2: the baseline helpers live in lib/sync-state.js; re-exported here
// so bin/ keeps a single `loadSync()` import surface.
export { clearSyncState, createSyncState, readSyncState, syncStatePath, SYNC_STATE_FILE, SYNC_STATE_VERSION, writeSyncState } from './sync-state.js'
