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
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decryptJson, encryptJson, isVaultEnvelope } from './vault.js'
import { atomicWriteFileSync, copyFileWithRetrySync, fsyncDirSync, renameWithRetrySync, rmWithRetrySync, writeAllToTempSync } from './fs-safe.js'

/** Prefix of the staged (plaintext) database copy used while a pull verifies. */
export const PULL_TMP_PREFIX = '.advisers-pull-verify-'
/** Staged pull files older than this (and from a dead pid) are safe to remove. */
export const STALE_PULL_TMP_MS = 60 * 60 * 1000
/** mtime-vs-createdAt disagreement above this is reported/blocked as skew. */
export const SNAPSHOT_CLOCK_SKEW_MS = 5 * 60 * 1000
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

export function createSnapshot({ dbPath, passphrase, device = 'device', createdAt = new Date() }) {
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`)
  assertSnapshotSourceComplete(dbPath)
  const bytes = readFileSync(dbPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const payload = { kind: 'advisers-sync-db', version: 1, device: sanitizeDevice(device), createdAt: createdAt.toISOString(), sha256, db: bytes.toString('base64') }
  const envelope = encryptJson(payload, passphrase)
  // 0.2.3 P1-1: an envelope-level copy of createdAt so `sync status` and the
  // default snapshot choice do not depend on file mtimes. It is NOT trusted on
  // its own: pullSnapshot re-decrypts the payload and refuses a mismatch.
  envelope[SYNC_ENVELOPE_META_KEY] = { v: ENVELOPE_META_VERSION, createdAt: payload.createdAt, device: payload.device }
  return { name: snapshotName(device, createdAt), payload, envelope }
}

export function pushSnapshot({ dir, dbPath, passphrase, device = 'device', createdAt = new Date() }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const snap = createSnapshot({ dbPath, passphrase, device, createdAt })
  const out = join(dir, snap.name)
  const body = JSON.stringify(snap.envelope) + '\n'
  atomicWriteFileSync(out, body, { mode: 0o600 })
  return { file: out, sha256: snap.payload.sha256, bytes: Buffer.byteLength(body) }
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
            const payloadAt = Date.parse(payload.createdAt ?? '')
            entry.readable = true
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
 */
export function pullSnapshot({ dir, dbPath, passphrase, file, force = false, dryRun = false, localMtimeMs, localDevice, now = Date.now() }) {
  const isDryRun = Boolean(dryRun)
  const { chosen, warnings: selectionWarnings } = selectSnapshot({ dir, passphrase, file, now })
  const envelope = JSON.parse(readFileSync(chosen.file, 'utf8'))
  if (!isVaultEnvelope(envelope)) throw new Error('snapshot is not an Advisers encrypted envelope')
  const payload = decryptJson(envelope, passphrase)
  if (payload.kind !== 'advisers-sync-db' || typeof payload.db !== 'string') throw new Error('snapshot is not an Advisers database snapshot')
  const bytes = Buffer.from(payload.db, 'base64')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== payload.sha256) throw new Error('snapshot checksum mismatch')
  const snapshotAt = Date.parse(payload.createdAt ?? '')
  const sameDevice = Boolean(localDevice) && Boolean(payload.device) && sanitizeDevice(payload.device) === sanitizeDevice(localDevice)
  const local = inspectLocalLedger(dbPath)
  const localEmpty = local.empty
  const localAt = Number.isFinite(localMtimeMs) && localMtimeMs > 0 ? localMtimeMs : latestDbMtime(dbPath)
  // Only meaningful for a non-empty local ledger: a new device's empty DB is
  // always 'newer' by mtime but has no writes worth protecting.
  const snapshotOlder = !localEmpty && Number.isFinite(snapshotAt) && localAt > 0 && localAt > snapshotAt
  const warnings = selectionWarnings.slice()
  const base = { file: chosen.name, sha256, device: payload.device, createdAt: payload.createdAt, localEmpty, snapshotOlder, sameDevice, explicit: Boolean(file), warnings, backup: null }

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
    return { ...base, changed: true, backup, status, replacedLocalEmpty: local.exists && localEmpty }
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try { if (existsSync(tmp + suffix)) rmWithRetrySync(tmp + suffix) } catch {}
    }
  }
}
