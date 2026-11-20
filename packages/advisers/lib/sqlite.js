import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { copyFileWithRetrySync, fsyncDirSync, fsyncFileSync, rmWithRetrySync } from './fs-safe.js'

/**
 * Open + write hardening (2026-11-17 robustness audit P0-1/P0-3/P1-2):
 * - busy_timeout is set before any lock-taking pragma; journal_mode=WAL is
 *   idempotent and retried with bounded backoff while another process holds
 *   the database lock.
 * - Opening no longer runs a full 'PRAGMA quick_check' (that is O(db) and made
 *   every command slow). Integrity checks live in assertIntegrity() and are
 *   run by 'advisers doctor' / 'advisers audit --check-db'.
 * - appendAudit() and saveWithAudit() run in BEGIN IMMEDIATE transactions that
 *   re-read the previous hash before inserting, so the audit chain cannot fork
 *   under concurrent writers and a ledger write and its audit row commit
 *   together or not at all.
 * - Migrations are refused for a schema newer than this CLI and are preceded
 *   by a same-directory backup of the old database.
 */
/**
 * Physical database schema version (meta.schema_version).
 *
 * v20 (0.2.3 persistence v2): adds the schema_migrations ledger, the
 * idx_turns_seq / idx_facts_identity / idx_memory_candidates_status indexes,
 * and turns migrate() into a per-version step table.
 *
 * v21 (0.3.0 customer entities): adds clients / projects / client_notes,
 * matters.client_id/project_id (nullable ownership; the single source of
 * truth for who a matter belongs to), commitments.created_at (the derived
 * customer timeline needs the moment a commitment was recorded, not its due
 * date), and the deliveries lineage columns (client_id/project_id snapshot +
 * template_name/template_version/quote_no/data_sha256). There is no event
 * table and no stored counter: the timeline and the client views are derived
 * from these rows by packages/core/src/customer.ts. This is NOT the wire
 * format: LedgerSnapshot.version stays 1 (see core/src/ledger.ts).
 */
export const SCHEMA_VERSION = 21
/** The last schema built by the single-block legacy migration (0.2.2). */
const LEGACY_SCHEMA_VERSION = 19
const DEFAULT_BUSY_TIMEOUT_MS = 5000
const OPEN_RETRIES = 6
const BUSY_ERRCODES = new Set([5, 6]) // SQLITE_BUSY, SQLITE_LOCKED

function isBusyError(error) {
  if (!error) return false
  if (typeof error.errcode === 'number' && BUSY_ERRCODES.has(error.errcode)) return true
  return /SQLITE_BUSY|SQLITE_LOCKED|database (?:table )?is locked/i.test(String(error.message ?? error))
}

function sleepSync(ms) {
  if (!ms || ms <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {}
  }
}

function backoffMs(attempt) {
  return Math.min(2000, 50 * 2 ** attempt)
}

// ---------------------------------------------------------------------------
// Cross-process single-writer instance lock (0.2.1 robustness audit P0-1).
//
// The ledger snapshot save() path (see _saveRows below) writes whole rows, so
// two ordinary CLI commands that both load() and then save() can overwrite each
// other's committed updates (and resurrect soft-deleted rows) even while the
// SQLite page-level writer serialization keeps the file structurally intact.
// The audit's recommended first fix is one writer per HOME: every process that
// opens the SQLite store takes ~/.advisers/instance.lock (O_EXCL) first, waits a
// bounded time for a live holder, reclaims a provably stale lock, and releases
// on exit/SIGINT/SIGTERM.
//
// Rules that keep the takeover safe:
// - a lock whose pid is alive is never stolen while its heartbeat is fresh;
//   long-lived holders (ui/mcp/bridge) refresh the lock mtime periodically.
// - a stale lock is removed only under an O_EXCL reclaim guard directory, so
//   two waiters can never both delete and recreate the lock under each other.
// - release() only unlinks the lock when its pid + startedAt still match ours.
// ---------------------------------------------------------------------------
export const INSTANCE_LOCK_FILE = 'instance.lock'
const DEFAULT_LOCK_TIMEOUT_MS = 10_000
const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1000
const MAX_LOCK_TIMEOUT_MS = 24 * 60 * 60 * 1000
const MAX_LOCK_STALE_MS = 30 * 24 * 60 * 60 * 1000
const LOCK_POLL_INTERVAL_MS = 50
const LOCK_RECLAIM_GUARD_MS = 10_000

/** The database exists but cannot be trusted (0 bytes / not a SQLite file). */
export class DatabaseCorruptError extends Error {
  constructor(path, detail) {
    super(
      `E_DB_CORRUPT: ${path}: ${detail}. Refusing to rebuild or overwrite it. ` +
        'Back up the file first (do not delete it), then run `advisers doctor`; ' +
        'restore a known-good copy (state.db.before-*) if you have one.',
    )
    this.name = 'DatabaseCorruptError'
    this.code = 'E_DB_CORRUPT'
    this.path = path
  }
}

/** Another live advisers process holds the HOME's single-writer instance lock. */
export class DatabaseLockedError extends Error {
  constructor({ lockPath, holder, waitedMs, timeoutMs }) {
    const who = holder
      ? ` (pid ${holder.pid}, started ${holder.startedAt || 'unknown'}${holder.command ? `, "${holder.command}"` : ''})`
      : ''
    super(
      `E_DB_LOCKED: another advisers process is using this home via ${lockPath}${who}; ` +
        `waited ${waitedMs}ms (ADVISERS_LOCK_TIMEOUT_MS=${timeoutMs}). No data was written. ` +
        'Stop the other process (ui/mcp/bridge servers hold the lock while running) and retry, ' +
        'or raise ADVISERS_LOCK_TIMEOUT_MS to wait longer. If the holder is gone, remove the stale lock file.',
    )
    this.name = 'DatabaseLockedError'
    this.code = 'E_DB_LOCKED'
    this.lockPath = lockPath
    this.holder = holder
    this.waitedMs = waitedMs
  }
}

/**
 * Version of this CLI, recorded in meta.schema_migrated_app for support. Read
 * from the package manifest so it cannot drift from the released version.
 */
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg?.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** E_SCHEMA_STALE: the on-disk schema is older than this CLI (read path). */
function schemaStaleError(path, version) {
  const found = version === null || version === undefined ? 'unknown' : `v${version}`
  const error = new Error(
    `E_SCHEMA_STALE: database schema at ${path} is ${found} but this CLI expects v${SCHEMA_VERSION}; ` +
      'if another advisers process is upgrading it, retry in a moment; otherwise run a writable ' +
      'command (for example `advisers doctor`) to migrate it first.',
  )
  error.name = 'SchemaStaleError'
  error.code = 'E_SCHEMA_STALE'
  error.schemaVersion = version ?? null
  error.expected = SCHEMA_VERSION
  return error
}

/** E_SCHEMA_NEWER: the on-disk schema is newer than this CLI (fail closed). */
function schemaNewerError(path, version) {
  const error = new Error(`database schema v${version} is newer than this CLI (v${SCHEMA_VERSION}); upgrade advisers before opening ${path}`)
  error.name = 'SchemaNewerError'
  error.code = 'E_SCHEMA_NEWER'
  error.schemaVersion = Number(version)
  error.expected = SCHEMA_VERSION
  return error
}

function readEnvMs(name, fallback, max) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.min(Math.floor(value), max)
}

/** Wait budget for a contended instance lock (`ADVISERS_LOCK_TIMEOUT_MS`, default 10s). */
export function instanceLockTimeoutMs() {
  return readEnvMs('ADVISERS_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS, MAX_LOCK_TIMEOUT_MS)
}

/** Age after which an unrefreshed lock may be reclaimed (`ADVISERS_LOCK_STALE_MS`, default 1h). */
export function instanceLockStaleMs() {
  return readEnvMs('ADVISERS_LOCK_STALE_MS', DEFAULT_LOCK_STALE_MS, MAX_LOCK_STALE_MS)
}

/** Absolute path of the per-HOME instance lock. */
export function instanceLockPath(home) {
  return join(home, INSTANCE_LOCK_FILE)
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the pid exists but belongs to another user; never steal from it.
    return error?.code === 'EPERM'
  }
}

/** Read + stat the instance lock without creating anything; null when absent. */
export function readInstanceLock(home) {
  const file = instanceLockPath(home)
  let stat
  try {
    stat = statSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let record = null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && Number.isFinite(Number(parsed.pid)) && Number(parsed.pid) > 0) {
      record = {
        pid: Math.trunc(Number(parsed.pid)),
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
        command: typeof parsed.command === 'string' ? parsed.command : '',
      }
    }
  } catch {}
  return { file, record, mtimeMs: stat.mtimeMs, size: stat.size }
}

/**
 * A lock is stale when its owner pid is gone, or when it has not been refreshed
 * (heartbeat / normal short command) for longer than `staleMs`. A live pid with
 * a fresh mtime is never stolen — ui/mcp/bridge holders legitimately keep the
 * lock for hours.
 */
export function instanceLockIsStale(info, { now = Date.now(), staleMs = instanceLockStaleMs() } = {}) {
  if (!info) return false
  if (info.record && !isPidAlive(info.record.pid)) return true
  return now - info.mtimeMs > staleMs
}

function heartbeatIntervalMs(staleMs) {
  return Math.max(1000, Math.min(5 * 60_000, Math.floor(staleMs / 4)))
}

/** Remove a stale lock while serialising concurrent reclaimers with a tty-less guard dir. */
function reclaimStaleLock({ path, expected, staleMs, timeoutMs, pollMs }) {
  const guard = path + '.reclaim'
  const guardDeadline = Date.now() + timeoutMs
  for (;;) {
    try {
      mkdirSync(guard, { mode: 0o700 })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let age = 0
      try { age = Date.now() - statSync(guard).mtimeMs } catch {}
      if (age > LOCK_RECLAIM_GUARD_MS) {
        try { rmSync(guard, { recursive: true, force: true }) } catch {}
        continue
      }
      if (Date.now() >= guardDeadline) return false
      sleepSync(pollMs)
    }
  }
  try {
    const current = readInstanceLock(dirname(path))
    if (!current) return true
    if (!instanceLockIsStale(current, { staleMs })) return false
    // Only delete the exact record we inspected; a new holder may have replaced it.
    const same = expected
      ? current.record && expected.record &&
        current.record.pid === expected.record.pid &&
        current.record.startedAt === expected.record.startedAt
      : !current.record
    if (!same) return false
    try { unlinkSync(path) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    return true
  } finally {
    try { rmSync(guard, { recursive: true, force: true }) } catch {}
  }
}

export class InstanceLock {
  constructor({ home, command = '', timeoutMs = instanceLockTimeoutMs(), staleMs = instanceLockStaleMs(), pollMs = LOCK_POLL_INTERVAL_MS } = {}) {
    this.home = home
    this.path = instanceLockPath(home)
    this.timeoutMs = Math.max(0, Math.floor(Number(timeoutMs) || 0))
    this.staleMs = Math.max(1, Math.floor(Number(staleMs) || DEFAULT_LOCK_STALE_MS))
    this.pollMs = Math.max(5, Math.floor(Number(pollMs) || LOCK_POLL_INTERVAL_MS))
    this.record = { pid: process.pid, startedAt: new Date().toISOString(), command: String(command ?? '').slice(0, 160) }
    this._held = false
    this._heartbeat = null
  }

  get held() {
    return this._held
  }

  /** Try once to create the lock file (O_EXCL); returns true on success. */
  _create() {
    mkdirSync(this.home, { recursive: true, mode: 0o700 })
    let fd
    try {
      fd = openSync(this.path, 'wx', 0o600)
    } catch (error) {
      if (error?.code === 'EEXIST') return false
      throw error
    }
    try {
      writeSync(fd, JSON.stringify(this.record) + '\n')
      fsyncSync(fd)
    } catch (error) {
      // Never leave a half-written lock file behind: a reader would see invalid
      // JSON and could only recover by waiting out the (1h) stale threshold.
      try { closeSync(fd) } catch {}
      try { unlinkSync(this.path) } catch {}
      throw error
    }
    closeSync(fd)
    try { chmodSync(this.path, 0o600) } catch {}
    return true
  }

  acquire() {
    const deadline = Date.now() + this.timeoutMs
    const started = Date.now()
    for (;;) {
      if (this._create()) {
        this._held = true
        this._startHeartbeat()
        return this
      }
      const info = readInstanceLock(this.home)
      if (info && instanceLockIsStale(info, { staleMs: this.staleMs })) {
        if (reclaimStaleLock({ path: this.path, expected: info, staleMs: this.staleMs, timeoutMs: this.timeoutMs, pollMs: this.pollMs })) continue
      }
      const now = Date.now()
      if (now >= deadline) {
        throw new DatabaseLockedError({ lockPath: this.path, holder: info?.record ?? null, waitedMs: now - started, timeoutMs: this.timeoutMs })
      }
      sleepSync(Math.max(1, Math.min(this.pollMs, deadline - now)))
    }
  }

  /** Refresh the lock mtime so long-lived holders are not age-reclaimed. */
  refresh() {
    if (!this._held) return false
    const info = readInstanceLock(this.home)
    if (!info?.record || info.record.pid !== this.record.pid || info.record.startedAt !== this.record.startedAt) {
      this._stopHeartbeat()
      this._held = false
      return false
    }
    const now = new Date()
    try { utimesSync(this.path, now, now) } catch { this._stopHeartbeat() }
    return true
  }

  _startHeartbeat() {
    if (this._heartbeat || this.staleMs < 60_000) return
    this._heartbeat = setInterval(() => this.refresh(), heartbeatIntervalMs(this.staleMs))
    if (typeof this._heartbeat.unref === 'function') this._heartbeat.unref()
  }

  _stopHeartbeat() {
    if (!this._heartbeat) return
    clearInterval(this._heartbeat)
    this._heartbeat = null
  }

  /** Release the lock; only the exact record this process wrote is removed. */
  release() {
    this._stopHeartbeat()
    if (!this._held) return false
    this._held = false
    let info
    try { info = readInstanceLock(this.home) } catch { return false }
    if (!info?.record) return false
    if (info.record.pid !== this.record.pid || info.record.startedAt !== this.record.startedAt) return false
    try {
      unlinkSync(this.path)
      return true
    } catch (error) {
      return error?.code === 'ENOENT'
    }
  }
}

/** Take the single-writer lock for a HOME; throws E_DB_LOCKED after the wait budget. */
export function acquireInstanceLock({ home, command = '', timeoutMs, staleMs, pollMs } = {}) {
  if (!home) throw new Error('acquireInstanceLock requires a home directory')
  const lock = new InstanceLock({ home, command, timeoutMs, staleMs, pollMs })
  return lock.acquire()
}

/** Throw E_DB_CORRUPT for an existing 0-byte / non-file database before SQLite touches it. */
export function assertDatabaseFileUsable(path) {
  if (!path || path === ':memory:') return
  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (stat.isDirectory()) throw new DatabaseCorruptError(path, 'the path is a directory, not a SQLite database file')
  if (stat.size === 0) throw new DatabaseCorruptError(path, 'the database file is 0 bytes (truncated, or an interrupted first-time initialisation)')
}

function isCorruptSqliteError(error) {
  return /file is not a database|database disk image is malformed|malformed database|not a database/i.test(String(error?.message ?? error))
}

// Ledger tables are written as a whole snapshot by save(). The id column lets
// save() merge with rows other processes committed after our load().
const LEDGER_TABLES = [
  ['matters', 'id'],
  ['facts', 'id'],
  ['commitments', 'id'],
  ['preferences', 'id'],
  ['links', 'id'],
  ['updates', 'id'],
  ['routines', 'id'],
  ['routine_patches', 'id'],
  ['routes', 'key'],
]

function idsFor(snapshot) {
  const ids = {}
  for (const [table, key] of LEDGER_TABLES) {
    const value = snapshot?.[table]
    const rows = table === 'routes' ? Object.keys(value ?? {}) : (value ?? []).map((row) => row?.id)
    ids[table] = new Set(rows.filter((id) => id != null))
  }
  return ids
}

// ---------------------------------------------------------------------------
// Schema v20 (0.2.3 persistence v2): the migration ledger plus the per-version
// step table. The three indexes are new persisted objects too, but the reason
// this is a schema bump is the new table + the step framework (not the indexes
// alone: secondary indexes are normally layout-only, see INDEXES).
// ---------------------------------------------------------------------------
const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  backup_path TEXT
);
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matters (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, domain TEXT NOT NULL,
  secrecy INTEGER NOT NULL, summary TEXT, participants TEXT NOT NULL, deadlines TEXT NOT NULL,
  open_questions TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  client_id TEXT, project_id TEXT
);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY, matter_id TEXT, subject TEXT NOT NULL, predicate TEXT NOT NULL,
  object TEXT NOT NULL, recorded_at TEXT NOT NULL, authority TEXT NOT NULL, confidence REAL NOT NULL,
  source TEXT, status TEXT NOT NULL,
  valid_from TEXT, valid_to TEXT, expired_at TEXT, evidence TEXT, supersedes TEXT,
  superseded_by TEXT, shadowed_by TEXT, last_seen_at TEXT, deleted_at TEXT, deleted_reason TEXT
);
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, debtor TEXT NOT NULL, creditor TEXT NOT NULL,
  action TEXT NOT NULL, due_at TEXT, timezone TEXT NOT NULL, status TEXT NOT NULL,
  evidence TEXT NOT NULL, capability TEXT NOT NULL, done_at TEXT, reminder_offsets TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS preferences (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, statement TEXT NOT NULL, scope TEXT NOT NULL,
  source TEXT NOT NULL, evidence TEXT NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL,
  valid_from TEXT NOT NULL, last_confirmed TEXT, expires_at TEXT, priority TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY, from_matter TEXT NOT NULL, to_matter TEXT NOT NULL, type TEXT NOT NULL,
  confidence REAL NOT NULL, evidence TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS updates (
  id TEXT PRIMARY KEY, source_matter TEXT NOT NULL, target_matter TEXT NOT NULL, change TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, rollback TEXT
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, trigger TEXT NOT NULL,
  steps TEXT NOT NULL, preferences TEXT NOT NULL, pitfalls TEXT NOT NULL, verification TEXT NOT NULL,
  scope TEXT, version INTEGER NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routine_patches (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, base_version INTEGER NOT NULL,
  changes TEXT NOT NULL, before TEXT, diff TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS permit_consumed (
  permit_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, consumed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY, matter_id TEXT, query TEXT NOT NULL, answer TEXT NOT NULL,
  sources TEXT NOT NULL, usage TEXT, stop_reason TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY, conversation_id TEXT, matter_id TEXT, turn_id TEXT, task TEXT NOT NULL,
  model TEXT NOT NULL, effort TEXT, thinking INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ok',
  code TEXT, attempts INTEGER NOT NULL DEFAULT 1, prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0, finish_reason TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, evidence TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, reviewed_at TEXT, reject_reason TEXT
);
CREATE TABLE IF NOT EXISTS routes (key TEXT PRIMARY KEY, matter_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seen_events (
  link_id TEXT NOT NULL, account_id TEXT NOT NULL, dedupe_key TEXT NOT NULL,
  seen_at TEXT NOT NULL, PRIMARY KEY(link_id, account_id, dedupe_key)
);
CREATE TABLE IF NOT EXISTS sessions (
  conversation_id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, title TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  files TEXT NOT NULL, tool TEXT, title TEXT, validation TEXT, created_at TEXT NOT NULL,
  client_id TEXT, project_id TEXT, template_name TEXT, template_version TEXT,
  quote_no TEXT, data_sha256 TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, allowed INTEGER NOT NULL, reason TEXT, prev_hash TEXT, hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(conversation_id, seq)
);
CREATE TABLE IF NOT EXISTS session_summaries (
  conversation_id TEXT PRIMARY KEY, summary TEXT NOT NULL,
  through_seq INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS summary_versions (
  conversation_id TEXT NOT NULL, version INTEGER NOT NULL, summary TEXT NOT NULL,
  through_seq INTEGER NOT NULL, pins TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, version)
);
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, matter_id TEXT, task TEXT NOT NULL,
  tools TEXT NOT NULL, artifacts TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nudges (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, local_day TEXT NOT NULL, level TEXT NOT NULL,
  commitment_id TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending', outcome_at TEXT
);
CREATE TABLE IF NOT EXISTS calendar_events (
  uid TEXT PRIMARY KEY, summary TEXT NOT NULL, starts_at TEXT, ends_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0, tzid TEXT, location TEXT, rrule TEXT,
  source TEXT, imported_at TEXT NOT NULL
);
-- 0.3.0 (schema v21) customer entities. display name + name_norm (application
-- normalisation: NFKC, zero-width stripped, whitespace folded, lowercase) is
-- what the partial unique index enforces among active rows, so an archived or
-- merged client's name can be reused. notes is short operator prose, never a
-- file path; nothing here is a fourth ledger (see docs/ARCHITECTURE.md).
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
  tags TEXT NOT NULL DEFAULT '[]', secrecy_default INTEGER NOT NULL DEFAULT 0,
  notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, name TEXT NOT NULL, name_norm TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', started_at TEXT, due_at TEXT, default_matter_id TEXT,
  notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS client_notes (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, project_id TEXT, matter_id TEXT,
  kind TEXT NOT NULL, at TEXT NOT NULL, summary TEXT NOT NULL, source TEXT,
  created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
${SCHEMA_MIGRATIONS_DDL}`

// ---------------------------------------------------------------------------
// Full-text search (schema v19; 2026-11-17 performance audit round 2, P2-6).
//
// v18 created turns_fts with the default unicode61 tokenizer, which treats a
// whole run of CJK characters as one token. It indexed the data but could not
// answer a Chinese query: 'MATCH "报价单"' returned 0 rows, so every Chinese
// search fell back to 'content LIKE ?' (a full table scan). v19 rebuilds the
// turn index (and adds an index for session summaries) with the FTS5 trigram
// tokenizer. Trigram indexes every 3-character substring, so it supports CJK
// substring search, phrases, and English substring search with the same query
// path. Queries shorter than 3 characters cannot produce a trigram, so they
// keep the LIKE path; malformed/special FTS syntax is caught and also falls
// back to LIKE.
//
// The FTS5 schema is created by migrate() rather than the static SCHEMA so the
// tokenizer can be probed at runtime. If the SQLite build has no trigram
// tokenizer the store degrades to unicode61 (Chinese keeps working through
// LIKE); if FTS5 itself is missing it degrades to LIKE-only. Opening never
// fails because of a missing tokenizer; ftsWarning explains the degradation.
//
// ADVISERS_FTS_TOKENIZER=auto|trigram|unicode61 is an operator override:
// 'unicode61' forces the legacy tokenizer (and the LIKE path for Chinese),
// which is also how tests exercise the degraded mode deterministically.
// ---------------------------------------------------------------------------
const FTS_TOKENIZER_ENV = 'ADVISERS_FTS_TOKENIZER'
const FTS_TRIGRAM_MIN_QUERY = 3
const FTS_TABLE_NAMES = ['turns_fts', 'summaries_fts']
const FTS_TRIGGER_NAMES = ['turns_ai', 'turns_ad', 'turns_au', 'summaries_ai', 'summaries_ad', 'summaries_au']

function ftsTokenizerPreference() {
  const raw = String(process.env[FTS_TOKENIZER_ENV] ?? '').trim().toLowerCase()
  return raw === 'trigram' || raw === 'unicode61' ? raw : 'auto'
}

/** DDL for both FTS indexes and their sync triggers for one tokenizer. */
function ftsDdl(tokenizer) {
  const trigram = tokenizer === 'trigram' ? ", tokenize='trigram'" : ''
  return {
    tables: [
      `CREATE VIRTUAL TABLE turns_fts USING fts5(content, content='turns', content_rowid='rowid'${trigram})`,
      `CREATE VIRTUAL TABLE summaries_fts USING fts5(summary, content='session_summaries', content_rowid='rowid'${trigram})`,
    ],
    triggers: [
      `CREATE TRIGGER turns_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
      END`,
      `CREATE TRIGGER turns_ad AFTER DELETE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END`,
      `CREATE TRIGGER turns_au AFTER UPDATE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
      END`,
      `CREATE TRIGGER summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO summaries_fts(rowid, summary) VALUES (new.rowid, new.summary);
      END`,
      `CREATE TRIGGER summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO summaries_fts(summaries_fts, rowid, summary) VALUES ('delete', old.rowid, old.summary);
      END`,
      `CREATE TRIGGER summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO summaries_fts(summaries_fts, rowid, summary) VALUES ('delete', old.rowid, old.summary);
        INSERT INTO summaries_fts(rowid, summary) VALUES (new.rowid, new.summary);
      END`,
    ],
  }
}

/**
 * P2-1: secondary indexes for the hot read/write paths (tick, today, history,
 * deliveries). Indexes are layout only, not a schema change, so they are
 * created with IF NOT EXISTS after migrate() on every open: new databases get
 * them at creation time and existing databases get them the first time they
 * are opened by this version. Each one was a full table SCAN + TEMP B-TREE in
 * the 2026-11-17 performance audit (nudges/facts/deliveries/calendar_events/
 * task_runs/sessions/model_calls/preferences/commitments).
 */
/** v20 indexes: FTS seq early-stop, fact identity lookup, candidate status. */
const V20_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_turns_seq ON turns(seq);
CREATE INDEX IF NOT EXISTS idx_facts_identity ON facts(subject, predicate, matter_id);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates(status);
`

/**
 * v21 (customer entities) layout: the partial unique indexes are what makes
 * duplicate active client/project names impossible even under a racing writer,
 * while an archived/merged row may keep its old name so it can be reused. The
 * ownership/lineage indexes serve the derived timeline and the client views;
 * like every secondary index they are layout only (IF NOT EXISTS on open) and
 * do not themselves bump the schema version.
 */
const V21_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_name_norm_active ON clients(name_norm) WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
CREATE INDEX IF NOT EXISTS idx_projects_client_status ON projects(client_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_client_name_active ON projects(client_id, name_norm) WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_client_notes_client_at ON client_notes(client_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_matters_client ON matters(client_id, status);
CREATE INDEX IF NOT EXISTS idx_matters_project ON matters(project_id, status);
CREATE INDEX IF NOT EXISTS idx_commitments_matter ON commitments(matter_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_matter ON deliveries(matter_id, created_at);
`
/**
 * 0.3.0 P0-T2 (2026-11-20): two more layout-only indexes for the pet-brief read
 * projection. Both replace a full facts scan + TEMP B-TREE on every pet-brief:
 *  - (status, confidence) serves the top-N facts by confidence query
 *    (measured 40ms -> 5ms at 200k facts);
 *  - (status, deleted_at, expired_at, subject) is covering for the redactor
 *    name-candidate scan (measured 69ms -> 34ms).
 * Neither changes the schema version: secondary indexes are layout only and
 * are created IF NOT EXISTS on open, like the 0.2.2 P2-1 indexes below.
 */
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_nudges_commitment_at ON nudges(commitment_id, at);
CREATE INDEX IF NOT EXISTS idx_facts_status_confidence ON facts(status, confidence);
CREATE INDEX IF NOT EXISTS idx_facts_valid_subject ON facts(status, deleted_at, expired_at, subject);
CREATE INDEX IF NOT EXISTS idx_nudges_local_day_level ON nudges(local_day, level);
CREATE INDEX IF NOT EXISTS idx_nudges_at ON nudges(at);
CREATE INDEX IF NOT EXISTS idx_commitments_status_due ON commitments(status, due_at);
CREATE INDEX IF NOT EXISTS idx_facts_matter ON facts(matter_id);
CREATE INDEX IF NOT EXISTS idx_facts_status_deleted ON facts(status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_preferences_status_expires ON preferences(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_starts ON calendar_events(starts_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_created ON deliveries(created_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_created ON task_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_model_calls_created ON model_calls(created_at);
${V20_INDEXES}
${V21_INDEXES}`


/**
 * Per-version migration steps (schema v20+). Each step must be idempotent
 * (IF NOT EXISTS / INSERT OR REPLACE) because it can be retried after a crash
 * that rolled the transaction back. migrate() runs every step with
 * version > current inside one BEGIN IMMEDIATE, records name/duration/backup
 * in schema_migrations, and only then bumps meta.schema_version.
 */
/**
 * Idempotent ALTER TABLE ... ADD COLUMN guard shared by the version steps.
 * SQLite has no ADD COLUMN IF NOT EXISTS, and a step must be retryable after a
 * crash rolled its transaction back (the column is then absent again).
 */
function addColumnIfMissing(db, table, column, type) {
  const columns = db.prepare('PRAGMA table_info(' + table + ')').all().map((row) => row.name)
  if (!columns.includes(column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type)
}

/**
 * Per-version migration steps (schema v20+). Each step must be idempotent
 * (IF NOT EXISTS / INSERT OR REPLACE) because it can be retried after a crash
 * that rolled the transaction back. migrate() runs every step with
 * version > current inside one BEGIN IMMEDIATE, records name/duration/backup
 * in schema_migrations, and only then bumps meta.schema_version.
 */
const MIGRATIONS = [
  {
    version: 20,
    name: 'incremental-writes-readonly-reads',
    up(store) {
      store.db.exec(SCHEMA_MIGRATIONS_DDL)
      store.db.exec(V20_INDEXES)
    },
  },
  {
    version: 21,
    name: 'client-project-entities-delivery-lineage',
    up(store) {
      // The three new tables are part of SCHEMA and created with IF NOT EXISTS
      // before this step runs (in initializeSchema's transaction), so a fresh
      // database and an upgraded one converge on one layout; CREATE TABLE IF
      // NOT EXISTS cannot add columns to an existing table, so the ownership /
      // lineage columns are added here. All checks are idempotent.
      addColumnIfMissing(store.db, 'matters', 'client_id', 'TEXT')
      addColumnIfMissing(store.db, 'matters', 'project_id', 'TEXT')
      // The derived timeline places a commitment at its creation instant; old
      // rows keep NULL and the derivation reports them as degraded instead of
      // pretending a due date is a historical event.
      addColumnIfMissing(store.db, 'commitments', 'created_at', 'TEXT')
      for (const [column, type] of [
        ['client_id', 'TEXT'], ['project_id', 'TEXT'],
        ['template_name', 'TEXT'], ['template_version', 'TEXT'],
        ['quote_no', 'TEXT'], ['data_sha256', 'TEXT'],
      ]) addColumnIfMissing(store.db, 'deliveries', column, type)
    },
  },
]
const json = (v) => JSON.stringify(v ?? [])
const parse = (v, fallback = []) => {
  if (v == null) return fallback
  try { return JSON.parse(v) } catch { return fallback }
}

// ---------------------------------------------------------------------------
// Customer entity helpers (schema v21, 0.3.0).
//
// clients/projects/client_notes are SQLite-only rows: they never enter the wire
// LedgerSnapshot, so the store is the single gate that validates them (bin and
// every future caller share this path):
// - a name is stored twice: name (display, verbatim) and name_norm (the
//   duplicate key produced by normalizeClientName());
// - nothing is hard-deleted: deleted_at is the tombstone and the partial unique
//   indexes only cover active, non-deleted rows, so a name can be reused after
//   an archive/merge;
// - notes/summaries are short operator prose; a note source id that looks like
//   an absolute path is refused so an exported customer view cannot carry the
//   home directory with it.
// ---------------------------------------------------------------------------

/** Allowed client/project statuses (archived rows are tombstones). */
export const CLIENT_STATUSES = ['active', 'archived']
export const PROJECT_STATUSES = ['active', 'archived']
/** Allowed client_notes kinds. */
export const CLIENT_NOTE_KINDS = ['note', 'call', 'meeting', 'decision', 'email-summary']
/** Allowed client note source kinds (lineage only, never a file copy). */
export const CLIENT_NOTE_SOURCE_KINDS = ['delivery', 'matter', 'manual']

/**
 * Tables that a full export --all carries next to the nine-table ledger
 * snapshot. The three v21 customer tables are appended so an export/import
 * round-trip cannot silently drop them; this constant is the single list the
 * CLI should read instead of hard-coding its own (bin wiring is a separate
 * 0.3.0 task).
 */
export const DATA_TABLES = Object.freeze([
  'sessions', 'turns', 'session_summaries', 'summary_versions', 'deliveries', 'nudges',
  'task_runs', 'audit', 'memory_candidates', 'permit_consumed',
  'clients', 'projects', 'client_notes',
])

/** A business error with a stable code (message keeps the code for stderr). */
export function entityError(code, message, hint) {
  const error = new Error(code + ': ' + message + (hint ? ' (hint: ' + hint + ')' : ''))
  error.code = code
  if (hint) error.hint = hint
  return error
}

/**
 * Duplicate-detection key for a client/project display name.
 *
 * NFKC folds compatibility forms (full-width A -> A), zero-width characters are
 * removed, whitespace is folded/trimmed and lowercasing makes Latin matching
 * case-insensitive (CJK is unchanged). Pure and deterministic so the unique
 * index and the CLI agree byte for byte. Deliberately no fuzzy matching: two
 * different spellings are never guessed to be one customer.
 */
export function normalizeClientName(value) {
  if (typeof value !== 'string') throw new TypeError('name must be a string')
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase()
}

const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/

function invalidKind(kind) {
  return kind === 'client' ? 'E_CLIENT_INVALID' : kind === 'project' ? 'E_PROJECT_INVALID' : 'E_CLIENT_NOTE_INVALID'
}

function validateDisplayName(kind, value, { max = 200 } = {}) {
  if (typeof value !== 'string') throw entityError(invalidKind(kind), kind + ' name is required')
  const name = value.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim()
  if (!name) throw entityError(invalidKind(kind), kind + ' name is required')
  if (name.length > max) throw entityError(invalidKind(kind), kind + ' name is longer than ' + max + ' characters')
  return name
}

function validateEntityStatus(kind, value) {
  const allowed = kind === 'client' ? CLIENT_STATUSES : PROJECT_STATUSES
  if (value === undefined || value === null) return 'active'
  if (!allowed.includes(value)) {
    throw entityError(invalidKind(kind), 'unknown ' + kind + ' status: ' + String(value), 'use one of ' + allowed.join(', '))
  }
  return value
}

function validateStringList(kind, field, value, { max = 100, itemMax = 200 } = {}) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw entityError(invalidKind(kind), field + ' must be an array of strings')
  if (value.length > max) throw entityError(invalidKind(kind), field + ' has more than ' + max + ' entries')
  const seen = new Set()
  const list = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw entityError(invalidKind(kind), field + ' must be an array of strings')
    const text = entry.trim()
    if (!text) throw entityError(invalidKind(kind), field + ' entries must not be empty')
    if (text.length > itemMax) throw entityError(invalidKind(kind), field + ' entries must be at most ' + itemMax + ' characters')
    if (seen.has(text)) continue
    seen.add(text)
    list.push(text)
  }
  return list
}

function validateSecrecy(value) {
  if (value === undefined || value === null) return 0
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > 3) {
    throw entityError('E_CLIENT_INVALID', 'secrecyDefault must be an integer 0..3')
  }
  return number
}

/** Validate an optional date/date-time field and keep the caller text. */
function normalizeOptionalDate(kind, field, value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw entityError(invalidKind(kind), field + ' must be a YYYY-MM-DD date or an ISO timestamp')
  const text = value.trim()
  if (!text) return null
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw entityError(invalidKind(kind), field + ' must be a YYYY-MM-DD date or an ISO timestamp')
  }
  return text
}

/** Validate an optional free-text field (notes) and keep the caller text. */
function normalizeOptionalText(kind, field, value, max) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw entityError(invalidKind(kind), field + ' must be a string')
  const text = value.trim()
  if (!text) return null
  if (text.length > max) throw entityError(invalidKind(kind), field + ' must be at most ' + max + ' characters')
  return text
}

/** Clamp a requested row limit into [1, max]. */
function normalizeRowLimit(value, { def = 100, max = 1000 } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return def
  return Math.min(Math.floor(number), max)
}

/** Client-note event time: normalized to ISO UTC so ordering is unambiguous. */
function normalizeNoteInstant(value) {
  if (value === undefined || value === null) return new Date().toISOString()
  const text = String(value).trim()
  const ms = text ? Date.parse(text) : Number.NaN
  if (!Number.isFinite(ms)) throw entityError('E_CLIENT_NOTE_INVALID', 'at must be an ISO timestamp')
  return new Date(ms).toISOString()
}

/** Validate the optional lineage JSON of a client note. */
function validateNoteSource(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw entityError('E_CLIENT_NOTE_INVALID', 'source must be an object')
  const source = {}
  if (value.kind !== undefined) {
    if (!CLIENT_NOTE_SOURCE_KINDS.includes(value.kind)) {
      throw entityError('E_CLIENT_NOTE_INVALID', 'unknown note source kind: ' + String(value.kind), 'use one of ' + CLIENT_NOTE_SOURCE_KINDS.join(', '))
    }
    source.kind = value.kind
  }
  if (value.id !== undefined) {
    if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200) {
      throw entityError('E_CLIENT_NOTE_INVALID', 'source.id must be a short id string')
    }
    if (ABSOLUTE_PATH_RE.test(value.id.trim())) throw entityError('E_CLIENT_NOTE_INVALID', 'source.id must be an id, not a file path')
    source.id = value.id.trim()
  }
  if (value.quote !== undefined) {
    if (typeof value.quote !== 'string' || value.quote.length > 500) throw entityError('E_CLIENT_NOTE_INVALID', 'source.quote must be a string of at most 500 characters')
    source.quote = value.quote
  }
  if (source.kind !== undefined && source.kind !== 'manual' && !source.id) {
    throw entityError('E_CLIENT_NOTE_INVALID', 'source.id is required for a ' + source.kind + ' source')
  }
  return JSON.stringify(source)
}

/** Validate the optional delivery template lineage columns (v21). */
function normalizeDeliveryLineage({ clientId, projectId, templateName, templateVersion, quoteNo, dataSha256 } = {}) {
  const shortText = (field, value, max) => {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string') throw entityError('E_DELIVERY_INVALID', field + ' must be a string')
    const text = value.trim()
    if (!text) return null
    if (text.length > max) throw entityError('E_DELIVERY_INVALID', field + ' must be at most ' + max + ' characters')
    if (ABSOLUTE_PATH_RE.test(text)) throw entityError('E_DELIVERY_INVALID', field + ' must not be a file path')
    return text
  }
  const idOf = (field, value) => {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw entityError('E_DELIVERY_INVALID', field + ' must be an id string')
    return value.trim()
  }
  const sha = dataSha256 === undefined || dataSha256 === null ? null : String(dataSha256).trim().toLowerCase()
  if (sha !== null && !/^[0-9a-f]{64}$/.test(sha)) {
    throw entityError('E_DELIVERY_INVALID', 'dataSha256 must be 64 lowercase hex characters', 'pass the SHA-256 of the canonical template data')
  }
  return {
    clientId: idOf('clientId', clientId),
    projectId: idOf('projectId', projectId),
    templateName: shortText('templateName', templateName, 40),
    templateVersion: shortText('templateVersion', templateVersion, 40),
    quoteNo: shortText('quoteNo', quoteNo, 40),
    dataSha256: sha,
  }
}

const mapClientRow = (row) => ({
  id: row.id,
  name: row.name,
  nameNorm: row.name_norm,
  aliases: parse(row.aliases),
  status: row.status,
  tags: parse(row.tags),
  secrecyDefault: Number(row.secrecy_default),
  notes: row.notes ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.deleted_at == null ? {} : { deletedAt: row.deleted_at }),
})

const mapProjectRow = (row) => ({
  id: row.id,
  clientId: row.client_id,
  name: row.name,
  nameNorm: row.name_norm,
  status: row.status,
  startedAt: row.started_at ?? undefined,
  dueAt: row.due_at ?? undefined,
  defaultMatterId: row.default_matter_id ?? undefined,
  notes: row.notes ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.deleted_at == null ? {} : { deletedAt: row.deleted_at }),
})

const mapClientNoteRow = (row) => ({
  id: row.id,
  clientId: row.client_id,
  projectId: row.project_id ?? undefined,
  matterId: row.matter_id ?? undefined,
  kind: row.kind,
  at: row.at,
  summary: row.summary,
  source: row.source ? parse(row.source, undefined) : undefined,
  createdAt: row.created_at,
  ...(row.deleted_at == null ? {} : { deletedAt: row.deleted_at }),
})

/**
 * Delivery row + template lineage. Rows written before v21 have no lineage
 * columns, so the new keys are omitted entirely (the pre-v21 JSON shape is
 * byte-identical for old rows).
 */
const mapDeliveryRow = (row) => ({
  id: row.id,
  matterId: row.matter_id,
  conversationId: row.conversation_id,
  files: parse(row.files),
  tool: row.tool ?? undefined,
  title: row.title ?? undefined,
  validation: row.validation ?? undefined,
  createdAt: row.created_at,
  ...(row.client_id == null ? {} : { clientId: row.client_id }),
  ...(row.project_id == null ? {} : { projectId: row.project_id }),
  ...(row.template_name == null ? {} : { templateName: row.template_name }),
  ...(row.template_version == null ? {} : { templateVersion: row.template_version }),
  ...(row.quote_no == null ? {} : { quoteNo: row.quote_no }),
  ...(row.data_sha256 == null ? {} : { dataSha256: row.data_sha256 }),
})

// ---------------------------------------------------------------------------
// Ledger row mappers + table registry (P1-2, 0.2.2).
//
// Before this, every ledger command paid for store.load() -- the whole 9-table
// snapshot -- even when it needed one table or a count: 488ms at a 50k-row
// ledger (1.2s at 100k) in the 2026-11-17 performance audit round 2. The
// mappers are shared by load() and the per-table load*/count* helpers so a
// partial snapshot returns byte-identical row objects to a full snapshot; a
// partial snapshot is safe to hand to Ledger.fromJSON/fromParts because the
// core Ledger treats missing tables as empty.
// ---------------------------------------------------------------------------
const mapMatterRow = (r) => ({
  id: r.id, title: r.title, status: r.status, domain: r.domain, secrecy: r.secrecy,
  summary: r.summary ?? undefined, participants: parse(r.participants), deadlines: parse(r.deadlines),
  openQuestions: parse(r.open_questions), createdAt: r.created_at, updatedAt: r.updated_at,
  // v21 ownership is additive: pre-v21 rows (NULL) keep their exact old shape.
  ...(r.client_id == null ? {} : { clientId: r.client_id }),
  ...(r.project_id == null ? {} : { projectId: r.project_id }),
})

const mapFactRow = (r) => ({
  id: r.id, matterId: r.matter_id ?? undefined, subject: r.subject, predicate: r.predicate,
  object: r.object, recordedAt: r.recorded_at, expiredAt: r.expired_at ?? undefined,
  authority: r.authority, confidence: r.confidence,
  source: r.source ? parse(r.source, undefined) : undefined,
  evidence: r.evidence ? parse(r.evidence, undefined) : undefined,
  status: r.status, validFrom: r.valid_from ?? undefined, validTo: r.valid_to ?? undefined,
  supersedes: r.supersedes ?? undefined, supersededBy: r.superseded_by ?? undefined,
  shadowedBy: r.shadowed_by ?? undefined, lastSeenAt: r.last_seen_at ?? undefined,
  deletedAt: r.deleted_at ?? undefined, deletedReason: r.deleted_reason ?? undefined,
})

const mapCommitmentRow = (r) => {
  // NULL means "never customised": keep the field absent so old snapshots
  // and the pre-0.2.0 commitment shape stay identical. Corrupt or
  // non-array JSON degrades to absent rather than breaking the ledger.
  const parsedOffsets = r.reminder_offsets == null ? null : parse(r.reminder_offsets, null)
  const reminderOffsets = Array.isArray(parsedOffsets) ? parsedOffsets : undefined
  return {
    id: r.id, matterId: r.matter_id, debtor: r.debtor, creditor: r.creditor, action: r.action,
    dueAt: r.due_at ?? undefined, timezone: r.timezone, status: r.status,
    evidence: parse(r.evidence), capability: r.capability, doneAt: r.done_at ?? undefined,
    // v21: additive (rows written before v21 have NULL here).
    ...(r.created_at == null ? {} : { createdAt: r.created_at }),
    ...(reminderOffsets === undefined ? {} : { reminderOffsets }),
  }
}

const mapPreferenceRow = (r) => ({
  id: r.id, kind: r.kind, statement: r.statement, scope: parse(r.scope, {}),
  source: parse(r.source, {}), evidence: parse(r.evidence), confidence: r.confidence,
  status: r.status, validFrom: r.valid_from, lastConfirmed: r.last_confirmed ?? undefined,
  expiresAt: r.expires_at ?? undefined, priority: r.priority,
})

const mapLinkRow = (r) => ({
  id: r.id, fromMatter: r.from_matter, toMatter: r.to_matter, type: r.type,
  confidence: r.confidence, evidence: parse(r.evidence), status: r.status,
  createdBy: r.created_by, createdAt: r.created_at,
})

const mapUpdateRow = (r) => ({
  id: r.id, sourceMatter: r.source_matter, targetMatter: r.target_matter, change: r.change,
  status: r.status, createdAt: r.created_at, rollback: r.rollback ?? undefined,
})

const mapRoutineRow = (r) => ({
  id: r.id, name: r.name, description: r.description, trigger: parse(r.trigger),
  steps: parse(r.steps), preferences: parse(r.preferences), pitfalls: parse(r.pitfalls),
  verification: parse(r.verification), scope: r.scope ?? undefined, version: r.version,
  status: r.status, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
})

const mapRoutinePatchRow = (r) => ({
  id: r.id, routineId: r.routine_id, baseVersion: r.base_version,
  changes: parse(r.changes, {}), before: parse(r.before, {}), diff: r.diff, status: r.status, createdAt: r.created_at,
})

const mapTurnRow = (r) => ({
  id: r.id, conversationId: r.conversation_id, seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at,
})

/** Every table Ledger.fromJSON understands: raw SQL table + row mapper. */
const LEDGER_TABLE_LOADERS = {
  matters: { table: 'matters', map: mapMatterRow },
  facts: { table: 'facts', map: mapFactRow },
  commitments: { table: 'commitments', map: mapCommitmentRow },
  preferences: { table: 'preferences', map: mapPreferenceRow },
  links: { table: 'links', map: mapLinkRow },
  updates: { table: 'updates', map: mapUpdateRow },
  routines: { table: 'routines', map: mapRoutineRow },
  routinePatches: { table: 'routine_patches', map: mapRoutinePatchRow },
  routes: { table: 'routes', routes: true },
}


// ---------------------------------------------------------------------------
// Incremental-write row codecs (0.2.3 persistence v2 phase 2).
//
// _saveRows() below is the historical full-snapshot writer and stays the
// import/seed path. The targeted insert*/update* methods must produce exactly
// the same column bytes as _saveRows(), so one ENTITY_SPECS table per entity
// lists the column + codec of every persisted field. Both paths therefore
// cannot drift silently: test/incremental-write.test.js compares the old
// load+save result with the targeted-write result row by row.
//
// Only the four ledger entities touched by the 0.2.3 write commands are
// covered; 0.3 replaces this with core's ENTITY_SPECS single source of truth.
// ---------------------------------------------------------------------------
const encodeText = (v) => (v === undefined || v === null ? null : String(v))
const encodeInt = (v) => Math.trunc(Number(v))
const encodeReal = (v) => Number(v)
const encodeJson = (v) => json(v)
const encodeJsonNullable = (v) => (v === undefined || v === null ? null : json(v))
const encodeReminderOffsets = (v) => (v === undefined || v === null ? null : JSON.stringify(v))
const CODECS = {
  text: encodeText,
  int: encodeInt,
  real: encodeReal,
  json: encodeJson,
  'json-nullable': encodeJsonNullable,
  reminder: encodeReminderOffsets,
}

const ENTITY_SPECS = {
  matters: {
    table: 'matters',
    key: 'id',
    map: mapMatterRow,
    columns: {
      id: ['id', 'text'], title: ['title', 'text'], status: ['status', 'text'], domain: ['domain', 'text'],
      secrecy: ['secrecy', 'int'], summary: ['summary', 'text'], participants: ['participants', 'json'],
      deadlines: ['deadlines', 'json'], openQuestions: ['open_questions', 'json'],
      createdAt: ['created_at', 'text'], updatedAt: ['updated_at', 'text'],
      clientId: ['client_id', 'text'], projectId: ['project_id', 'text'],
    },
  },
  facts: {
    table: 'facts',
    key: 'id',
    map: mapFactRow,
    columns: {
      id: ['id', 'text'], matterId: ['matter_id', 'text'], subject: ['subject', 'text'],
      predicate: ['predicate', 'text'], object: ['object', 'text'], recordedAt: ['recorded_at', 'text'],
      expiredAt: ['expired_at', 'text'], authority: ['authority', 'text'], confidence: ['confidence', 'real'],
      source: ['source', 'json-nullable'], evidence: ['evidence', 'json-nullable'], status: ['status', 'text'],
      validFrom: ['valid_from', 'text'], validTo: ['valid_to', 'text'], supersedes: ['supersedes', 'text'],
      supersededBy: ['superseded_by', 'text'], shadowedBy: ['shadowed_by', 'text'],
      lastSeenAt: ['last_seen_at', 'text'], deletedAt: ['deleted_at', 'text'], deletedReason: ['deleted_reason', 'text'],
    },
  },
  commitments: {
    table: 'commitments',
    key: 'id',
    map: mapCommitmentRow,
    columns: {
      id: ['id', 'text'], matterId: ['matter_id', 'text'], debtor: ['debtor', 'text'], creditor: ['creditor', 'text'],
      action: ['action', 'text'], dueAt: ['due_at', 'text'], timezone: ['timezone', 'text'], status: ['status', 'text'],
      evidence: ['evidence', 'json'], capability: ['capability', 'text'], doneAt: ['done_at', 'text'],
      reminderOffsets: ['reminder_offsets', 'reminder'], createdAt: ['created_at', 'text'],
    },
  },
  preferences: {
    table: 'preferences',
    key: 'id',
    map: mapPreferenceRow,
    columns: {
      id: ['id', 'text'], kind: ['kind', 'text'], statement: ['statement', 'text'], scope: ['scope', 'json'],
      source: ['source', 'json'], evidence: ['evidence', 'json'], confidence: ['confidence', 'real'],
      status: ['status', 'text'], validFrom: ['valid_from', 'text'], lastConfirmed: ['last_confirmed', 'text'],
      expiresAt: ['expires_at', 'text'], priority: ['priority', 'text'],
    },
  },
}

function encodeEntityValue(codec, value) {
  const encode = CODECS[codec]
  if (!encode) throw new Error(`unknown entity column codec: ${codec}`)
  return encode(value)
}

/**
 * Tables whose row counts are sampled to verify a pre-migration backup. The
 * v21 customer tables are included so a future migration's backup verification
 * also proves the customer entities were copied (they are absent in older
 * databases and are then skipped by _sampleTableCounts).
 */
const BACKUP_SAMPLE_TABLES = ['matters', 'facts', 'commitments', 'preferences', 'audit', 'clients', 'projects', 'client_notes']
// ---------------------------------------------------------------------------
// WAL status / recovery (robustness audit 2026-11-17 P1-6).
//
// SQLite's documented recovery semantics: a WAL whose header is invalid, whose
// last frame is torn, or whose checksums do not verify is treated as if it
// contained no transactions. The database still opens (that is safe for the
// main file) but every transaction committed since the last checkpoint that
// only lived in the WAL is silently lost, and `quick_check` still says ok.
//
// This pre-open check classifies the sidecar BEFORE SQLite can ignore it:
//   - invalid (bad magic/version/page-size/header checksum, or a stale first
//     frame): preserve the bytes as state.db-wal.corrupt-<ts>, move the unusable
//     WAL aside (and the rebuildable -shm cache), then warn loudly and record a
//     quick_check of the surviving database;
//   - truncated (valid header, size not a whole number of frames): keep the WAL
//     so SQLite recovers its valid prefix, copy it aside as evidence, and warn
//     that frames after the tear may be lost;
//   - ok / absent / empty: no warning (the common case has no extra I/O cost).
// No database bytes are ever deleted: the preserved copy is the recovery path.
// `inspectWalStatus()` is also exported so bin/doctor can report the sidecar
// without opening the store (Wave 1 `doctor --check-db` / `audit --check-db`).
// ---------------------------------------------------------------------------
const WAL_HEADER_SIZE = 32
const WAL_FRAME_HEADER_SIZE = 24
const WAL_VERSION = 3007000
const WAL_MAGIC_LE = 0x377f0682
const WAL_MAGIC_BE = 0x377f0683
/** Suffix of a preserved copy of a WAL file SQLite cannot use (0600). */
export const WAL_CORRUPT_SUFFIX = '-wal.corrupt-'

/** SQLite WAL checksum: cumulative s1/s2 over 32-bit words (big- or little-endian). */
function walChecksum(bytes, bigEndian, start1 = 0, start2 = 0) {
  let s1 = start1 >>> 0
  let s2 = start2 >>> 0
  for (let offset = 0; offset + 8 <= bytes.length; offset += 8) {
    const first = bigEndian ? bytes.readUInt32BE(offset) : bytes.readUInt32LE(offset)
    const second = bigEndian ? bytes.readUInt32BE(offset + 4) : bytes.readUInt32LE(offset + 4)
    s1 = (s1 + first + s2) >>> 0
    s2 = (s2 + second + s1) >>> 0
  }
  return [s1 >>> 0, s2 >>> 0]
}

function readAtSync(file, position, length) {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const bytesRead = readSync(fd, buffer, 0, length, position)
    return buffer.subarray(0, bytesRead)
  } finally {
    try { closeSync(fd) } catch {}
  }
}

function corruptStamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** Report the state of <db>-wal without opening SQLite or modifying anything. */
export function inspectWalStatus(dbPath) {
  const path = `${dbPath}-wal`
  const report = { path, present: false, bytes: 0, status: 'absent', frames: 0, pageSize: null, header: null, reason: null, warning: null }
  if (!dbPath || dbPath === ':memory:') { report.status = 'memory'; return report }
  let stat
  try { stat = statSync(path) } catch (error) {
    if (error?.code !== 'ENOENT') { report.status = 'unreadable'; report.reason = String(error?.message ?? error); report.warning = `E_WAL_UNREADABLE: cannot inspect ${path} (${report.reason}); if the database is open elsewhere, close it and retry` }
    return report
  }
  report.present = true
  report.bytes = stat.size
  if (!stat.isFile()) { report.status = 'invalid'; report.reason = 'not-a-regular-file'; return report }
  if (stat.size === 0) { report.status = 'empty'; return report }
  if (stat.size < WAL_HEADER_SIZE) { report.status = 'invalid'; report.reason = `truncated header (${stat.size} of ${WAL_HEADER_SIZE} bytes)`; return report }
  let header
  try { header = readAtSync(path, 0, WAL_HEADER_SIZE) } catch (error) { report.status = 'unreadable'; report.reason = String(error?.message ?? error); return report }
  if (header.length < WAL_HEADER_SIZE) { report.status = 'invalid'; report.reason = 'truncated header'; return report }
  const magic = header.readUInt32BE(0)
  const version = header.readUInt32BE(4)
  const pageSize = header.readUInt32BE(8)
  if (magic !== WAL_MAGIC_LE && magic !== WAL_MAGIC_BE) { report.status = 'invalid'; report.reason = `bad WAL magic 0x${magic.toString(16)} (header was overwritten or truncated)`; return report }
  if (version !== WAL_VERSION) { report.status = 'invalid'; report.reason = `unsupported WAL format version ${version}`; return report }
  if (!Number.isInteger(pageSize) || pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) { report.status = 'invalid'; report.reason = `invalid WAL page size ${pageSize}`; return report }
  const bigEndian = magic === WAL_MAGIC_BE
  const [checksum1, checksum2] = walChecksum(header.subarray(0, 24), bigEndian)
  if (checksum1 !== header.readUInt32BE(24) || checksum2 !== header.readUInt32BE(28)) { report.status = 'invalid'; report.reason = 'WAL header checksum mismatch'; return report }
  report.pageSize = pageSize
  report.header = { magic: bigEndian ? 'be' : 'le', version, pageSize }
  // A writer may be appending right now (direct library use has no instance
  // lock). Only classify a size-based tear when the size is stable; otherwise
  // report 'changing' and stay quiet instead of warning about a false tear.
  let stable
  try { stable = statSync(path) } catch (error) { report.status = 'unreadable'; report.reason = String(error?.message ?? error); return report }
  if (stable.size !== stat.size) { report.status = 'changing'; return report }
  const frameSize = WAL_FRAME_HEADER_SIZE + pageSize
  const payloadBytes = stat.size - WAL_HEADER_SIZE
  report.frames = Math.floor(payloadBytes / frameSize)
  if (payloadBytes % frameSize !== 0) {
    report.status = 'truncated'
    report.reason = 'torn-frame'
    report.warning = `E_WAL_TRUNCATED: ${path} ends with a torn/partial frame (${payloadBytes % frameSize} of ${frameSize} bytes); SQLite recovers only the complete frames before the tear, so the most recently committed transactions may be lost`
    return report
  }
  if (report.frames > 0) {
    try {
      const firstFrame = readAtSync(path, WAL_HEADER_SIZE, WAL_FRAME_HEADER_SIZE)
      if (firstFrame.length === WAL_FRAME_HEADER_SIZE) {
        const salt1 = firstFrame.readUInt32BE(8)
        const salt2 = firstFrame.readUInt32BE(12)
        if (salt1 !== header.readUInt32BE(16) || salt2 !== header.readUInt32BE(20)) {
          report.status = 'invalid'
          report.reason = 'stale first frame (WAL salt mismatch)'
          return report
        }
      }
    } catch {}
  }
  report.status = 'ok'
  return report
}

/** Copy a WAL sidecar next to the database as evidence (0600, fsynced). */
function preserveWalCopy(dbPath, report, { now = Date.now() } = {}) {
  const backup = `${dbPath}${WAL_CORRUPT_SUFFIX}${corruptStamp(now)}`
  try {
    copyFileWithRetrySync(report.path, backup, { mode: 0o600 })
    fsyncFileSync(backup)
    return { backup, error: null }
  } catch (error) {
    return { backup: null, error }
  }
}

/**
 * Inspect (and, for a writable open, quarantine) a WAL before SQLite sees it.
 * Returns the inspection report plus `backup` / `quarantined` / `warning`.
 * For readOnly opens nothing is written: the DB is only reported on.
 */
export function prepareWalForOpen(dbPath, { readOnly = false, now = Date.now() } = {}) {
  const report = inspectWalStatus(dbPath)
  if (report.status !== 'invalid' && report.status !== 'truncated') return report
  if (readOnly) {
    report.note = 'read-only open: the WAL was inspected but not modified; run a writable maintenance command (for example `advisers doctor --check-db`) to preserve and quarantine it'
    if (report.status === 'invalid') {
      report.warning = `E_WAL_CORRUPT: the WAL file ${report.path} cannot be used by SQLite (${report.reason}); read-only open left it untouched. Run 'advisers doctor --check-db' to preserve and quarantine it; transactions committed after the last checkpoint may be lost.`
    } else {
      report.warning = `${report.warning}. Read-only open left it untouched; run 'advisers doctor --check-db' to preserve it.`
    }
    return report
  }
  const preserved = preserveWalCopy(dbPath, report, { now })
  report.backup = preserved.backup
  report.preserveError = preserved.error ? String(preserved.error?.message ?? preserved.error) : null
  if (report.status === 'invalid' && preserved.backup) {
    try {
      rmWithRetrySync(report.path)
      try { if (existsSync(`${dbPath}-shm`)) rmWithRetrySync(`${dbPath}-shm`) } catch {}
      report.quarantined = true
    } catch (error) {
      report.quarantined = false
      report.preserveError = String(error?.message ?? error)
    }
  }
  const preservedText = report.backup
    ? ` the file was preserved as ${report.backup}.`
    : ` the file could not be preserved (${report.preserveError ?? 'unknown error'}).`
  if (report.status === 'invalid') {
    report.warning = `E_WAL_CORRUPT: the WAL file ${report.path} cannot be used by SQLite (${report.reason}); SQLite ignores an invalid WAL, so transactions committed after the last checkpoint may be lost.${preservedText} Run 'advisers doctor' and take a fresh 'advisers backup'; for forensic recovery open the preserved copy with the sqlite3 CLI.`
  } else {
    report.warning = `${report.warning}.${preservedText} Run 'advisers doctor' before relying on the most recent writes.`
  }
  return report
}

export class SqliteStore {
  constructor(path, { readOnly = false, checkIntegrity = false, busyTimeoutMs = Number(process.env.ADVISERS_SQLITE_BUSY_TIMEOUT_MS) || DEFAULT_BUSY_TIMEOUT_MS } = {}) {
    this.path = path
    this.busyTimeoutMs = busyTimeoutMs
    // 0.2.3 read path: a read-only store never runs DDL/migrate/journal-mode
    // pragmas and refuses every write method with E_READ_ONLY (see read()).
    this.readOnly = Boolean(readOnly)
    this._transactionDepth = 0
    this._readDepth = 0
    this._baselineIds = null
    this._fullLoad = false
    // FTS5 state (schema v19): which indexes exist and which tokenizer built
    // them. Fillable stores discover it after migrate(); read-only stores detect
    // it from sqlite_master without running DDL (see _initFtsState).
    this.ftsTokenizer = null
    this.ftsWarning = null
    this._ftsTables = new Set()
    // P1-5: searchTurns()/searchSummaries() set these when FTS and LIKE
    // disagree; verifyFtsIntegrity() fills ftsIntegrityReport for doctor.
    this._ftsBroken = false
    this._ftsWarned = false
    this.ftsIntegrityWarning = null
    this.ftsIntegrityReport = null
    // P2-2 (0.2.1): an existing 0-byte file is treated as corrupt instead of a
    // brand-new database. Before this, SQLite turned it into an empty schema and
    // every command reported "no data" while silently rebuilding the ledger.
    assertDatabaseFileUsable(path)
    // P1-6: classify (and, for writable opens, quarantine) an unusable WAL
    // before SQLite opens the file and treats it as empty. `walStatus` is kept
    // on the store so doctor/audit can report it (see walReport()).
    this.walStatus = null
    try {
      this.walStatus = prepareWalForOpen(path, { readOnly })
      if (this.walStatus.warning) {
        try { console.warn(`advisers: warning: ${this.walStatus.warning}`) } catch {}
      }
      this.db = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path)
      // P0-1: sqlite only applies busy_timeout to statements that run after the
      // pragma is set; concurrent first-opens used to fail on journal_mode=WAL
      // because busy_timeout was set afterwards.
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(Number(busyTimeoutMs) || 0))}`)
      if (this.walStatus.quarantined) {
        // The pre-check moved an unusable WAL aside; verify that the surviving
        // main database is structurally sound (this is the one open where the
        // O(db) quick_check cost is justified).
        try {
          const recovered = this.db.prepare('PRAGMA quick_check').get()
          this.walStatus.recovery = { quickCheck: String(recovered?.quick_check ?? 'unknown') }
          if (this.walStatus.recovery.quickCheck !== 'ok') {
            try { console.warn(`advisers: warning: quick_check after WAL recovery reported '${this.walStatus.recovery.quickCheck}'`) } catch {}
          }
        } catch (error) {
          this.walStatus.recovery = { error: String(error?.message ?? error) }
        }
      }
      if (readOnly) {
        this._initFtsState()
        if (checkIntegrity) this.assertIntegrity()
        return
      }
      this.enableWal()
      // A torn WAL was preserved by the pre-open check. Fold its valid prefix
      // into the main database and truncate the sidecar so subsequent opens are
      // clean; the preserved copy remains available for forensics.
      if (this.walStatus?.status === 'truncated' && this.walStatus.backup) {
        try {
          this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
          this.walStatus.recovered = true
          this.walStatus.current = inspectWalStatus(path)
        } catch (error) {
          this.walStatus.recovered = false
          this.walStatus.recoveryError = String(error?.message ?? error)
        }
      }
      this.db.exec('PRAGMA secure_delete = ON')
      this.db.exec('PRAGMA synchronous = NORMAL')
      this.initializeSchema()
    } catch (error) {
      try { this.db?.close() } catch {}
      if (error?.code === 'E_DB_CORRUPT') throw error
      if (isCorruptSqliteError(error)) {
        throw new DatabaseCorruptError(path, `SQLite reports that the file is not a valid database (${String(error?.message ?? error).slice(0, 200)})`)
      }
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // Read-only access (0.2.3 read path; 03-design-persistence-v2.md §4).
  //
  // A read-only store never enables WAL, never runs DDL/migrate and never
  // takes the HOME instance lock (that lock lives in bin/ and only protects
  // writers), so pure-read commands work while another process holds the write
  // lock. The connection reads a committed WAL snapshot: an uncommitted writer
  // transaction is invisible and does not block the reader.
  // -------------------------------------------------------------------------

  /** meta.schema_version, or null when the meta table/row does not exist. */
  schemaVersion() {
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
      return row ? Number(row.value) : null
    } catch {
      return null
    }
  }

  /** Throw E_SCHEMA_STALE / E_SCHEMA_NEWER unless this database is current. */
  assertSchemaCurrent() {
    const version = this.schemaVersion()
    if (version === SCHEMA_VERSION) return version
    if (version !== null && version > SCHEMA_VERSION) throw schemaNewerError(this.path, version)
    throw schemaStaleError(this.path, version)
  }

  /** Throw E_READ_ONLY for any write attempted on a read-only store. */
  _assertWritable(operation = 'write') {
    if (!this.readOnly) return
    const error = new Error(`E_READ_ONLY: ${operation} is not available on a read-only SqliteStore (${this.path}); open a writable store to change the ledger`)
    error.name = 'ReadOnlyStoreError'
    error.code = 'E_READ_ONLY'
    error.operation = operation
    throw error
  }

  /** Directed row writes are only valid inside mutate()/transaction(). */
  _assertInWriteTransaction(operation) {
    this._assertWritable(operation)
    if (this._transactionDepth > 0) return
    const error = new Error(`E_TX_REQUIRED: ${operation} must run inside SqliteStore.mutate() or transaction() (${this.path})`)
    error.name = 'TransactionRequiredError'
    error.code = 'E_TX_REQUIRED'
    throw error
  }

  /**
   * Run fn inside one read transaction so several SELECTs see the same WAL
   * snapshot (multi-query commands: status/receipt/deliveries/doctor/export).
   * A read() nested inside a write transaction joins that transaction.
   */
  read(fn) {
    if (typeof fn !== 'function') throw new TypeError('read requires a function')
    if (this._transactionDepth > 0 || this._readDepth > 0) return fn(this)
    this.db.exec('BEGIN DEFERRED')
    this._readDepth++
    try {
      const result = fn(this)
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    } finally {
      this._readDepth--
    }
  }
  /** Full-database integrity check; explicit because it is O(database size). */
  assertIntegrity() {
    const row = this.db.prepare('PRAGMA quick_check').get()
    const verdict = row?.quick_check ?? 'unknown'
    if (verdict !== 'ok') throw new Error(`database integrity check failed: ${verdict}`)
    return verdict
  }

  /**
   * Aggregate integrity report for `doctor --check-db` / `audit --check-db`
   * (Wave 1 contract). quick_check is O(db) and the FTS check is O(index), so
   * both are opt-in; the WAL report is cheap and always included.
   */
  integrityReport({ quickCheck = true, fts = false } = {}) {
    const report = { ok: true, path: this.path, schemaVersion: null, quickCheck: null, wal: null, fts: null, errors: [] }
    try { report.schemaVersion = this.getMeta('schema_version') } catch (error) { report.errors.push(`cannot read schema_version: ${String(error?.message ?? error).slice(0, 160)}`) }
    if (quickCheck) {
      try {
        const verdict = String(this.db.prepare('PRAGMA quick_check').get()?.quick_check ?? 'unknown')
        report.quickCheck = { ok: verdict === 'ok', verdict }
        if (verdict !== 'ok') { report.ok = false; report.errors.push(`PRAGMA quick_check: ${verdict}`) }
      } catch (error) {
        report.quickCheck = { ok: false, error: String(error?.message ?? error).slice(0, 200) }
        report.ok = false
        report.errors.push(`PRAGMA quick_check failed: ${report.quickCheck.error}`)
      }
    }
    report.wal = this.walReport()
    if (!report.wal.ok) { report.ok = false; if (report.wal.initial?.warning) report.errors.push(report.wal.initial.warning) }
    if (fts) {
      report.fts = this.verifyFtsIntegrity()
      if (!report.fts.ok) { report.ok = false; if (report.fts.warning) report.errors.push(report.fts.warning) }
    }
    return report
  }

  /** WAL is persistent; skip the switch when already enabled and retry on busy. */
  enableWal() {
    this._assertWritable('enableWal')
    if (!this.path || this.path === ':memory:') return 'memory'
    const current = String(this.db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '').toLowerCase()
    if (current === 'wal' || current === 'memory') return current
    let lastError
    for (let attempt = 0; attempt <= OPEN_RETRIES; attempt++) {
      try {
        const result = this.db.prepare('PRAGMA journal_mode = WAL').get()
        const mode = String(result?.journal_mode ?? '').toLowerCase()
        if (mode === 'wal' || mode === 'memory') return mode
        lastError = new Error(`could not enable WAL journal mode (got '${mode || 'unknown'}')`)
      } catch (error) {
        lastError = error
        if (!isBusyError(error)) throw error
      }
      sleepSync(backoffMs(attempt))
    }
    throw lastError
  }

  initializeSchema() {
    this._assertWritable('initializeSchema')
    // P2-9: migration backups must be taken OUTSIDE the write transaction --
    // a 'wal_checkpoint(TRUNCATE)' inside BEGIN IMMEDIATE fails with 'database
    // table is locked', and copying the main file without folding the WAL can
    // silently omit committed rows. Read the old version and back up first.
    this._migrationBackup = this._prepareMigrationBackup()
    this._transaction('IMMEDIATE', () => {
      this.db.exec(SCHEMA)
      this.migrate()
      // migrate() installs the FTS indexes during an upgrade; a database that
      // was already at SCHEMA_VERSION only needs their tokenizer read back.
      this._initFtsState()
      // Indexes come after migrate(): some index the columns migrate() adds
      // (e.g. facts.deleted_at), so an old database must be upgraded first.
      this.db.exec(INDEXES)
    })
  }

  /** Look up which FTS indexes/tokenizer this database actually has on disk. */
  _initFtsState() {
    const rows = this.db.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('turns_fts', 'summaries_fts')").all()
    this._ftsTables = new Set(rows.map((row) => row.name))
    const turns = rows.find((row) => row.name === 'turns_fts')
    // v19 records the tokenizer in the virtual-table DDL. An older or
    // hand-modified database may have no index at all: search then uses the
    // LIKE path only, which stays correct.
    this.ftsTokenizer = turns ? (/tokenize\s*=\s*'?trigram/i.test(String(turns.sql ?? '')) ? 'trigram' : 'unicode61') : null
    return this.ftsTokenizer
  }

  _createFts(tokenizer) {
    const ddl = ftsDdl(tokenizer)
    for (const sql of ddl.tables) this.db.exec(sql)
    for (const sql of ddl.triggers) this.db.exec(sql)
  }

  _dropFts() {
    // Triggers first: they reference the virtual tables and a leftover trigger
    // on the source table would break the next write.
    for (const trigger of FTS_TRIGGER_NAMES) this.db.exec(`DROP TRIGGER IF EXISTS ${trigger}`)
    for (const table of FTS_TABLE_NAMES) this.db.exec(`DROP TABLE IF EXISTS ${table}`)
  }

  /**
   * Install (or rebuild) the v19 FTS5 indexes with the trigram tokenizer.
   *
   * Runs inside migrate()'s write transaction, so dropping/creating both
   * virtual tables, replacing the triggers, and the 'rebuild' backfill are
   * atomic with the schema_version bump: a failure rolls the migration back
   * and the old v18 index survives. Rows are re-indexed from the source
   * tables, so a database upgraded from v18 keeps all searchable data.
   *
   * Degrades instead of crashing: trigram (SQLite >= 3.34) -> unicode61 ->
   * LIKE-only, recording ftsWarning and printing one warning line.
   */
  _setupFts() {
    this._dropFts()
    const preference = ftsTokenizerPreference()
    let tokenizer = preference === 'unicode61' ? null : 'trigram'
    if (tokenizer) {
      try {
        this._createFts(tokenizer)
      } catch (error) {
        // This build has no trigram tokenizer (or rejected the DDL): drop any
        // partial index and fall through to the legacy tokenizer.
        this._dropFts()
        this.ftsWarning = `FTS5 trigram tokenizer unavailable (${error.message}); Chinese substring search falls back to LIKE`
        try { console.warn(`advisers: warning: ${this.ftsWarning}`) } catch {}
        tokenizer = null
      }
    } else if (preference === 'unicode61') {
      this.ftsWarning = 'ADVISERS_FTS_TOKENIZER=unicode61 forces the legacy FTS5 tokenizer; Chinese substring search falls back to LIKE'
      try { console.warn(`advisers: warning: ${this.ftsWarning}`) } catch {}
    }
    if (!tokenizer) {
      try {
        this._createFts('unicode61')
        tokenizer = 'unicode61'
      } catch (error) {
        // FTS5 itself is absent: keep the database usable with LIKE-only
        // search (no index, no triggers). SCHEMA_VERSION still advances so the
        // migration is not retried on every open.
        this._dropFts()
        tokenizer = null
        this.ftsWarning = `FTS5 is unavailable in this SQLite build (${error.message}); search uses LIKE only`
        try { console.warn(`advisers: warning: ${this.ftsWarning}`) } catch {}
      }
    }
    this.ftsTokenizer = tokenizer
    this._ftsTables = new Set(tokenizer ? FTS_TABLE_NAMES : [])
    if (tokenizer) {
      this.db.exec("INSERT INTO turns_fts(turns_fts) VALUES('rebuild')")
      this.db.exec("INSERT INTO summaries_fts(summaries_fts) VALUES('rebuild')")
    }
    return tokenizer
  }

  /**
   * Report the WAL/shm state and whether this connection can checkpoint.
   * `initial` is the pre-open inspection (see inspectWalStatus above); a fresh
   * `current` read lets a long-lived store (mcp/ui) be diagnosed too.
   */
  walReport() {
    const report = {
      path: this.path,
      initial: this.walStatus ?? { status: 'absent', present: false },
      current: inspectWalStatus(this.path),
    }
    try { report.journalMode = String(this.db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '') } catch (error) { report.journalModeError = String(error?.message ?? error) }
    try {
      const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
      report.checkpoint = { busy: Number(checkpoint?.busy ?? 0) !== 0, log: Number(checkpoint?.log ?? 0), checkpointed: Number(checkpoint?.checkpointed ?? 0) }
    } catch (error) { report.checkpoint = { error: String(error?.message ?? error) } }
    const bad = (status) => ['invalid', 'truncated', 'unreadable'].includes(String(status))
    // A WAL that was preserved and then quarantined/checkpointed is reported as
    // recovered, but the maintenance check still fails once: data committed
    // after the last checkpoint may have been lost. The next open is clean.
    report.recovered = Boolean(
      report.initial.preserveError == null &&
      (report.initial.quarantined === true ||
        (report.initial.backup && (report.initial.recovered === true || !bad(report.current.status)))),
    )
    report.ok = !bad(report.current.status) && !bad(report.initial.status) && report.initial.preserveError == null
    return report
  }

  /**
   * Verify the two FTS5 indexes against their source tables (robustness audit
   * 2026-11-17 P1-5). A desynchronised index makes search silently return
   * fewer rows than a LIKE scan; this is the explicit check that doctor and
   * audit --check-db should surface (O(index), so never run on every open).
   *
   * Checks per index: table present, the three sync triggers present, FTS5
   * 'integrity-check' (catches malformed/desynced segments), source vs index
   * (shadow docsize) row counts, and a deterministic rowid sample in both
   * directions. On a non-ok result the store also marks its FTS path unusable
   * (`searchTurns`/`searchSummaries` then use LIKE until a rebuild).
   */
  verifyFtsIntegrity({ sampleSize = 100 } = {}) {
    this._initFtsState()
    const report = {
      ok: true,
      state: 'ok',
      tokenizer: this.ftsTokenizer,
      tables: {},
      triggers: { expected: FTS_TRIGGER_NAMES.slice(), missing: [] },
      checkedAt: new Date().toISOString(),
      errors: [],
      warning: null,
      repair: 'advisers audit --rebuild-fts',
    }
    let existingTriggers = new Set()
    try {
      existingTriggers = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((row) => row.name))
    } catch (error) {
      report.errors.push(`cannot list triggers: ${String(error?.message ?? error).slice(0, 200)}`)
    }
    const triggerMap = {
      turns_fts: ['turns_ai', 'turns_ad', 'turns_au'],
      summaries_fts: ['summaries_ai', 'summaries_ad', 'summaries_au'],
    }
    const sourceMap = {
      turns_fts: { table: 'turns' },
      summaries_fts: { table: 'session_summaries' },
    }
    let anyTable = false
    let inconsistent = false
    let missingTable = false
    for (const table of FTS_TABLE_NAMES) {
      const source = sourceMap[table]
      const info = {
        table,
        sourceTable: source.table,
        exists: false,
        triggers: { expected: triggerMap[table].slice(), missing: [] },
        integrityCheck: 'skipped',
        sourceCount: null,
        indexCount: null,
        countMismatch: false,
        sample: { checked: 0, missingFromIndex: [], extraInIndex: [] },
      }
      try { info.exists = Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) } catch (error) { report.errors.push(`${table}: cannot inspect sqlite_master: ${String(error?.message ?? error).slice(0, 200)}`) }
      report.tables[table] = info
      if (!info.exists) {
        missingTable = true
        info.triggers.missing = triggerMap[table].slice()
        report.errors.push(`${table}: the FTS index table is missing although schema v19 expects it`)
        continue
      }
      anyTable = true
      info.triggers.missing = triggerMap[table].filter((name) => !existingTriggers.has(name))
      if (info.triggers.missing.length) {
        inconsistent = true
        report.errors.push(`${table}: missing FTS sync trigger(s) ${info.triggers.missing.join(', ')}; rows written without them are not indexed`)
      }
      try {
        this.db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('integrity-check', 1)`).run()
        info.integrityCheck = 'ok'
      } catch (error) {
        info.integrityCheck = 'malformed'
        inconsistent = true
        report.errors.push(`${table}: FTS5 integrity-check failed: ${String(error?.message ?? error).slice(0, 200)}`)
      }
      try { info.sourceCount = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${source.table}`).get()?.n ?? 0) } catch (error) { report.errors.push(`${table}: cannot count ${source.table}: ${String(error?.message ?? error).slice(0, 120)}`) }
      try { info.indexCount = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}_docsize`).get()?.n ?? 0) } catch (error) { info.indexCount = null }
      if (info.sourceCount != null && info.indexCount != null && info.sourceCount !== info.indexCount) {
        info.countMismatch = true
        inconsistent = true
        report.errors.push(`${table}: index has ${info.indexCount} row(s) for ${info.sourceCount} source row(s)`)
      }
      if (info.sourceCount && info.sourceCount > 0) {
        try {
          const limitN = Math.max(1, Math.min(Number(sampleSize) || 0, 1000))
          const sampleIds = this.db.prepare(`SELECT rowid AS id FROM ${source.table} ORDER BY rowid LIMIT ?`).all(limitN).map((row) => row.id)
          if (sampleIds.length) {
            const indexed = new Set(this.db.prepare(`SELECT id FROM ${table}_docsize WHERE id IN (${sampleIds.map(() => '?').join(',')})`).all(...sampleIds).map((row) => row.id))
            info.sample.checked = sampleIds.length
            info.sample.missingFromIndex = sampleIds.filter((id) => !indexed.has(id))
            if (info.sample.missingFromIndex.length) {
              inconsistent = true
              report.errors.push(`${table}: sample rowid(s) ${info.sample.missingFromIndex.slice(0, 10).join(', ')} are in the source table but not in the index`)
            }
            const indexIds = this.db.prepare(`SELECT id FROM ${table}_docsize ORDER BY id LIMIT ?`).all(limitN).map((row) => row.id)
            if (indexIds.length) {
              const sourceIds = new Set(this.db.prepare(`SELECT rowid AS id FROM ${source.table} WHERE rowid IN (${indexIds.map(() => '?').join(',')})`).all(...indexIds).map((row) => row.id))
              info.sample.extraInIndex = indexIds.filter((id) => !sourceIds.has(id))
              if (info.sample.extraInIndex.length) {
                inconsistent = true
                report.errors.push(`${table}: sample rowid(s) ${info.sample.extraInIndex.slice(0, 10).join(', ')} are in the index but not in the source table`)
              }
            }
          }
        } catch (error) {
          report.errors.push(`${table}: sample comparison failed: ${String(error?.message ?? error).slice(0, 160)}`)
        }
      }
    }
    report.triggers.missing = FTS_TRIGGER_NAMES.filter((name) => !existingTriggers.has(name))
    if (!anyTable) {
      if (this.ftsWarning) {
        report.state = 'degraded'
        report.warning = `FTS5 is unavailable/degraded (${this.ftsWarning}); search uses LIKE only`
      } else {
        report.state = 'missing'
        report.ok = false
        report.errors.push('no FTS index tables exist although schema v19 expects them')
      }
    } else if (inconsistent || missingTable) {
      report.state = 'inconsistent'
      report.ok = false
    }
    if (!report.ok) {
      if (!report.warning) report.warning = `FTS index is inconsistent (${report.errors[0] ?? 'unknown reason'}); search falls back to LIKE so results stay complete; run '${report.repair}' to rebuild the index`
      this._ftsBroken = true
      this.ftsIntegrityWarning = report.warning
    }
    this.ftsIntegrityReport = report
    return report
  }

  /** Record a detected FTS/LIKE result mismatch and warn once per store. */
  _markFtsInconsistent(table, ftsCount, likeCount) {
    this._ftsBroken = true
    const message = `FTS index ${table} is inconsistent (MATCH returned ${ftsCount} row(s) but LIKE returned ${likeCount}); search fell back to LIKE so results stay complete. Run 'advisers doctor --check-db' and 'advisers audit --rebuild-fts' to rebuild the index`
    this.ftsIntegrityWarning = message
    if (this._ftsWarned) return
    this._ftsWarned = true
    try { console.warn(`advisers: warning: ${message}`) } catch {}
  }

  /**
   * Run fn() in a write transaction with bounded SQLITE_BUSY retries.
   * Nested calls join the outer transaction (no nested BEGIN).
   */
  _transaction(mode, fn, { retries = OPEN_RETRIES } = {}) {
    if (String(mode).toUpperCase() === 'IMMEDIATE') this._assertWritable('transaction')
    if (this._transactionDepth > 0) return fn()
    let lastError
    for (let attempt = 0; attempt <= retries; attempt++) {
      let began = false
      try {
        this.db.exec(`BEGIN ${mode}`)
        began = true
        this._transactionDepth++
        let result
        try {
          result = fn()
        } finally {
          this._transactionDepth--
        }
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        if (began) { try { this.db.exec('ROLLBACK') } catch {} }
        lastError = error
        if (!isBusyError(error) || attempt === retries) throw error
      }
      sleepSync(backoffMs(attempt))
    }
    throw lastError
  }

  /** Public transaction helper for multi-statement invariants (returns fn result). */
  transaction(fn, { mode = 'IMMEDIATE' } = {}) {
    return this._transaction(mode, fn)
  }

  /**
   * One BEGIN IMMEDIATE for a directed write: fn() runs inside, then (when
   * provided) the audit row is appended to the same transaction. Any throw —
   * business error or audit failure — rolls every row back, so a ledger write
   * never commits without its audit row and an audit row never claims a write
   * that rolled back (invariant I1). Returns { result, audit }.
   */
  mutate(fn, audit) {
    this._assertWritable('mutate')
    if (typeof fn !== 'function') throw new TypeError('mutate requires a function')
    return this._transaction('IMMEDIATE', () => {
      const result = fn(this)
      const auditRow = audit === undefined || audit === null ? null : this._appendAuditRow(audit)
      return { result, audit: auditRow }
    })
  }

  /**
   * Checkpoint the WAL so a copied/sealed database file is self-contained.
   * Returns busy=true when another connection prevented a full checkpoint.
   */
  checkpoint({ mode = 'TRUNCATE', retries = OPEN_RETRIES } = {}) {
    this._assertWritable('checkpoint')
    let last = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      last = this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get()
      if (!last || Number(last.busy) === 0) {
        return { busy: false, log: Number(last?.log ?? 0), checkpointed: Number(last?.checkpointed ?? 0) }
      }
      sleepSync(backoffMs(attempt))
    }
    return { busy: Number(last?.busy ?? 1) !== 0, log: Number(last?.log ?? 0), checkpointed: Number(last?.checkpointed ?? 0) }
  }

  /** Read the on-disk schema version before SCHEMA/migrate run (0 = new/empty). */
  _readSchemaVersionForBackup() {
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
      return row ? Number(row.value) : 0
    } catch (error) {
      if (/no such table/i.test(String(error?.message ?? error))) return 0
      throw error
    }
  }

  /** Take the pre-migration backup while no write transaction is open. */
  _prepareMigrationBackup() {
    if (!this.path || this.path === ':memory:') return null
    const current = this._readSchemaVersionForBackup()
    if (!Number.isFinite(current) || current <= 0 || current >= SCHEMA_VERSION) return null
    return this.backupBeforeMigrate(current)
  }

  /**
   * Same-directory backup of the database before a schema migration.
   *
   * P2-9 (2026-11-17 robustness audit): the old implementation copied only the
   * main database file. Committed transactions that still lived in the WAL
   * were missing from the backup (measured: backup 300 rows vs main DB 301),
   * so rolling back to it silently dropped data. Now the WAL is folded into
   * the main file with 'PRAGMA wal_checkpoint(TRUNCATE)' before the copy; if
   * another connection prevents the checkpoint the migration is refused
   * rather than proceeding with an incomplete backup.
   *
   * The copy is verified with a read-only DatabaseSync quick_check, the
   * schema_version it was taken at, and a row-count sample of the five tables
   * whose loss matters most (matters/facts/commitments/preferences/audit). A
   * failed verification removes the partial backup and throws (fail-closed).
   * The directory entry is fsynced after the copy so a crash cannot leave a
   * visible-but-empty backup. Returns the backup path.
   */
  backupBeforeMigrate(current) {
    this._assertWritable('backupBeforeMigrate')
    if (!this.path || this.path === ':memory:') return null
    const checkpoint = this.checkpoint({ mode: 'TRUNCATE' })
    if (checkpoint.busy) {
      const error = new Error(`refusing to migrate without a consistent backup of ${this.path}: could not checkpoint the WAL (another connection is busy); close other advisers processes and retry`)
      // Wave-2 Persistence v2 contract (03-design-persistence-v2.md §5.4): stable
      // code so bin/ can map it to an actionable message.
      error.code = 'E_MIGRATE_BUSY'
      throw error
    }
    // Sample the main database AFTER the checkpoint (so WAL-only commits are
    // included) and compare it with the copy: a backup that silently dropped
    // committed rows must never be used as the rollback path.
    const expectedCounts = this._sampleTableCounts(this.db)
    const target = `${this.path}.before-migrate-v${current}-${Date.now()}`
    let backupDb = null
    try {
      copyFileWithRetrySync(this.path, target, { mode: 0o600 })
      fsyncFileSync(target)
      // Make the directory entry durable too: without this a crash can leave a
      // correctly-sized backup that is not recoverable after reboot.
      try { fsyncDirSync(dirname(this.path)) } catch {}
      backupDb = new DatabaseSync(target, { readOnly: true })
      const verdict = String(backupDb.prepare('PRAGMA quick_check').get()?.quick_check ?? 'unknown')
      if (verdict !== 'ok') throw new Error(`quick_check on the backup reported '${verdict}'`)
      const meta = backupDb.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
      if (meta && Number(meta.value) !== Number(current)) {
        throw new Error(`backup contains schema_version ${meta.value}, expected ${current}`)
      }
      this._verifyBackupCounts(backupDb, expectedCounts)
      try { chmodSync(target, 0o600) } catch {}
      return target
    } catch (error) {
      try { backupDb?.close() } catch {}
      backupDb = null
      try { rmWithRetrySync(target) } catch {}
      const wrapped = new Error(`refusing to migrate without a verified backup of ${this.path}: ${String(error?.message ?? error).slice(0, 300)}`)
      wrapped.code = 'E_MIGRATION_BACKUP'
      throw wrapped
    } finally {
      try { backupDb?.close() } catch {}
      // Opening a WAL-mode backup read-only makes SQLite create <backup>-wal/-shm;
      // they are verification artifacts, not part of the backup, so remove them.
      for (const suffix of ['-wal', '-shm']) {
        try { if (existsSync(target + suffix)) rmSync(target + suffix, { force: true }) } catch {}
      }
    }
  }

  /**
   * Pre-v20 single-block idempotent migration (0.2.2 and earlier).
   *
   * Kept apart from the version-step table below: it builds every base table,
   * adds the columns older releases lacked, installs the v19 trigram FTS and
   * stamps meta.schema_version=19. The v20 step then adds the migration ledger
   * and the new indexes in the same outer transaction.
   */
  _legacyMigrateThrough19() {
    {
      this.db.exec(`CREATE TABLE IF NOT EXISTS seen_events (
        link_id TEXT NOT NULL, account_id TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        seen_at TEXT NOT NULL, PRIMARY KEY(link_id, account_id, dedupe_key)
      )`)
      this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
        conversation_id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, title TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`)
      this.db.exec(`CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        files TEXT NOT NULL, tool TEXT, title TEXT, validation TEXT, created_at TEXT NOT NULL
      )`)
      const cols = this.db.prepare('PRAGMA table_info(deliveries)').all().map((c) => c.name)
      if (!cols.includes('title')) this.db.exec('ALTER TABLE deliveries ADD COLUMN title TEXT')
      if (!cols.includes('validation')) this.db.exec('ALTER TABLE deliveries ADD COLUMN validation TEXT')
      this.db.exec(`CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, allowed INTEGER NOT NULL, reason TEXT, prev_hash TEXT, hash TEXT NOT NULL
      )`)
      const patchCols = this.db.prepare('PRAGMA table_info(routine_patches)').all().map((c) => c.name)
      if (!patchCols.includes('before')) this.db.exec('ALTER TABLE routine_patches ADD COLUMN before TEXT')
      this.db.exec(`CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(conversation_id, seq)
      )`)
      this.db.exec(`CREATE TABLE IF NOT EXISTS session_summaries (
        conversation_id TEXT PRIMARY KEY, summary TEXT NOT NULL,
        through_seq INTEGER NOT NULL, updated_at TEXT NOT NULL
      )`)
      const commitmentCols = this.db.prepare('PRAGMA table_info(commitments)').all().map((c) => c.name)
      if (!commitmentCols.includes('done_at')) this.db.exec('ALTER TABLE commitments ADD COLUMN done_at TEXT')
      // 0.2.0: per-commitment custom reminder offsets (JSON array of strings).
      if (!commitmentCols.includes('reminder_offsets')) this.db.exec('ALTER TABLE commitments ADD COLUMN reminder_offsets TEXT')
      const factCols = this.db.prepare('PRAGMA table_info(facts)').all().map((c) => c.name)
      for (const [name, type] of [['valid_from','TEXT'],['valid_to','TEXT'],['expired_at','TEXT'],['evidence','TEXT'],['supersedes','TEXT'],['superseded_by','TEXT'],['shadowed_by','TEXT'],['last_seen_at','TEXT'],['deleted_at','TEXT'],['deleted_reason','TEXT']]) {
        if (!factCols.includes(name)) this.db.exec(`ALTER TABLE facts ADD COLUMN ${name} ${type}`)
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS summary_versions (
  conversation_id TEXT NOT NULL, version INTEGER NOT NULL, summary TEXT NOT NULL,
  through_seq INTEGER NOT NULL, pins TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, version)
);
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, matter_id TEXT, task TEXT NOT NULL,
  tools TEXT NOT NULL, artifacts TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nudges (
        id TEXT PRIMARY KEY, at TEXT NOT NULL, local_day TEXT NOT NULL, level TEXT NOT NULL,
        commitment_id TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, body TEXT NOT NULL
      )`)
      const nudgeCols = this.db.prepare('PRAGMA table_info(nudges)').all().map((c) => c.name)
      if (!nudgeCols.includes('outcome')) this.db.exec("ALTER TABLE nudges ADD COLUMN outcome TEXT NOT NULL DEFAULT 'pending'")
      if (!nudgeCols.includes('outcome_at')) this.db.exec('ALTER TABLE nudges ADD COLUMN outcome_at TEXT')
      this.db.exec(`CREATE TABLE IF NOT EXISTS summary_versions (
  conversation_id TEXT NOT NULL, version INTEGER NOT NULL, summary TEXT NOT NULL,
  through_seq INTEGER NOT NULL, pins TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, version)
);
CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, task TEXT NOT NULL,
        tools TEXT NOT NULL, artifacts TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL
      )`)
      this.db.exec(`CREATE TABLE IF NOT EXISTS summary_versions (
        conversation_id TEXT NOT NULL, version INTEGER NOT NULL, summary TEXT NOT NULL,
        through_seq INTEGER NOT NULL, pins TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, version)
      )`)
      const runCols = this.db.prepare('PRAGMA table_info(task_runs)').all().map((c) => c.name)
      if (!runCols.includes('matter_id')) this.db.exec('ALTER TABLE task_runs ADD COLUMN matter_id TEXT')
      this.db.exec(`CREATE TABLE IF NOT EXISTS calendar_events (
        uid TEXT PRIMARY KEY, summary TEXT NOT NULL, starts_at TEXT, ends_at TEXT,
        all_day INTEGER NOT NULL DEFAULT 0, tzid TEXT, location TEXT, rrule TEXT,
        source TEXT, imported_at TEXT NOT NULL
      )`)
      // Schema v19 (perf audit round 2, P2-6): rebuild full-text search with the
      // trigram tokenizer so 3+ character Chinese/substring queries hit FTS5
      // instead of falling back to a LIKE table scan. Runs last so the source
      // tables (turns, session_summaries) exist for the 'rebuild' backfill.
      this._setupFts()
      this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('schema_version', String(LEGACY_SCHEMA_VERSION))
    }
  }

  /**
   * Bring an older database up to SCHEMA_VERSION.
   *
   * Runs inside the caller's write transaction (initializeSchema). Order:
   *   1. read the on-disk version (0 = fresh database whose meta table was just
   *      created by SCHEMA);
   *   2. refuse a future schema (E_SCHEMA_NEWER, fail closed);
   *   3. legacy block for < v19 (idempotent base tables + FTS);
   *   4. every MIGRATIONS step with version > current, recording
   *      schema_migrations(version, name, applied_at, duration_ms, backup_path);
   *   5. stamp meta.schema_version = SCHEMA_VERSION and the diagnostics keys.
   *
   * A failure anywhere rolls back every DDL write and the version stamp, so a
   * failed migration leaves the old database intact and retryable.
   */
  migrate() {
    this._assertWritable('migrate')
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    const current = row ? Number(row.value) : 0
    if (!Number.isFinite(current) || current < 0) throw new Error(`invalid schema_version in ${this.path}: ${row?.value}`)
    if (current > SCHEMA_VERSION) throw schemaNewerError(this.path, current)
    if (current >= SCHEMA_VERSION) return
    // initializeSchema() already took the verified backup before opening its
    // write transaction (a WAL checkpoint cannot run inside one); only direct
    // callers of migrate() fall back to taking it here.
    if (current > 0 && !this._migrationBackup) this._migrationBackup = this.backupBeforeMigrate(current)
    if (current < LEGACY_SCHEMA_VERSION) this._legacyMigrateThrough19()
    // A direct migrate() caller may not have run SCHEMA first; the steps assume
    // the migration ledger exists.
    this.db.exec(SCHEMA_MIGRATIONS_DDL)
    const from = current
    for (const step of MIGRATIONS) {
      if (step.version <= current) continue
      const startedAt = Date.now()
      this._runMigrationStep(step)
      this.db.prepare('INSERT OR REPLACE INTO schema_migrations(version,name,applied_at,duration_ms,backup_path) VALUES(?,?,?,?,?)')
        .run(step.version, step.name, new Date().toISOString(), Date.now() - startedAt, this._migrationBackup ?? null)
    }
    const migratedAt = new Date().toISOString()
    const setMeta = this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)')
    setMeta.run('schema_version', String(SCHEMA_VERSION))
    setMeta.run('schema_migrated_from', String(from))
    setMeta.run('schema_migrated_at', migratedAt)
    setMeta.run('schema_migrated_app', APP_VERSION)
    if (this._migrationBackup) setMeta.run('schema_migration_backup', this._migrationBackup)
  }

  /** Run one migration step (separate method so tests can inject a failure). */
  _runMigrationStep(step) {
    step.up(this)
  }

  /** Row counts for the verify-after-copy step of the migration backup. */
  _sampleTableCounts(db) {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
    const counts = {}
    for (const table of BACKUP_SAMPLE_TABLES) {
      if (!tables.has(table)) continue
      counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0)
    }
    return counts
  }

  /** Fail-closed comparison of the backup row counts with the main database. */
  _verifyBackupCounts(backupDb, expected) {
    const actual = this._sampleTableCounts(backupDb)
    for (const [table, expectedCount] of Object.entries(expected)) {
      const actualCount = actual[table]
      if (actualCount !== expectedCount) {
        throw new Error(`backup row count mismatch for ${table}: backup has ${actualCount ?? 'no table'}, main database has ${expectedCount}`)
      }
    }
  }

  upsertSession({ conversationId, matterId, title }) {
    this._assertWritable('upsertSession')
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO sessions(conversation_id,matter_id,title,created_at,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET matter_id=excluded.matter_id, title=excluded.title, updated_at=excluded.updated_at`)
      .run(conversationId, matterId, title.slice(0, 120), now, now)
  }

  listSessions(limit = 20) {
    return this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?').all(limit)
      .map((r) => ({ conversationId: r.conversation_id, matterId: r.matter_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }))
  }

  getSession(conversationId) {
    const r = this.db.prepare('SELECT * FROM sessions WHERE conversation_id = ?').get(conversationId)
    return r ? { conversationId: r.conversation_id, matterId: r.matter_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at } : undefined
  }

  /**
   * Record one delivery row.
   *
   * v21 lineage (0.3.0): the optional client/project/template fields snapshot
   * WHO and WHICH template a delivery belonged to at generation time, so a
   * later matter re-link does not rewrite an already-generated receipt. When
   * the caller omits clientId/projectId they are filled from the matter the
   * delivery is filed under (the historical CLI path), and explicitly passed
   * ids are validated against the client/project rows. Every new argument is
   * optional: the pre-v21 call shape keeps working and old rows stay NULL.
   */
  addDelivery({ matterId, conversationId, files, tool, title, validation, clientId, projectId, templateName, templateVersion, quoteNo, dataSha256 } = {}) {
    this._assertWritable('addDelivery')
    const lineage = normalizeDeliveryLineage({ clientId, projectId, templateName, templateVersion, quoteNo, dataSha256 })
    let resolvedClientId = lineage.clientId
    let resolvedProjectId = lineage.projectId
    if (resolvedProjectId !== null) {
      const project = this.getProject(resolvedProjectId)
      if (!project) throw entityError('E_PROJECT_NOT_FOUND', 'unknown project: ' + resolvedProjectId)
      if (resolvedClientId === null) resolvedClientId = project.clientId
      else if (project.clientId !== resolvedClientId) throw entityError('E_PROJECT_CLIENT_MISMATCH', 'project ' + resolvedProjectId + ' belongs to client ' + project.clientId)
    }
    if (resolvedClientId !== null && !this.getClient(resolvedClientId)) {
      throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + resolvedClientId)
    }
    if ((resolvedClientId === null || resolvedProjectId === null) && matterId) {
      const matter = this.getMatter(String(matterId))
      if (matter) {
        if (resolvedClientId === null) resolvedClientId = matter.clientId ?? null
        if (resolvedProjectId === null && (matter.clientId ?? null) === resolvedClientId) resolvedProjectId = matter.projectId ?? null
      }
    }
    const id = 'del_' + randomUUID().replace(/-/g, '').slice(0, 16)
    this.db.prepare('INSERT INTO deliveries(id,matter_id,conversation_id,files,tool,title,validation,created_at,client_id,project_id,template_name,template_version,quote_no,data_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, matterId, conversationId, JSON.stringify(files ?? []), tool ?? null, title ?? null, validation ?? null, new Date().toISOString(),
        resolvedClientId, resolvedProjectId, lineage.templateName, lineage.templateVersion, lineage.quoteNo, lineage.dataSha256)
    return id
  }

  /**
   * Newest delivery rows, optionally scoped.
   *
   * The second argument is additive: listDeliveries(limit) keeps its historical
   * result. clientId/projectId filter the generation-time snapshot columns
   * (receipt scope); matterId filters row ownership. The rowid tie-break keeps
   * same-millisecond rows in insertion order, as before.
   */
  listDeliveries(limit = 20, { clientId, projectId, matterId } = {}) {
    const where = []
    const params = []
    if (clientId !== undefined && clientId !== null) { where.push('client_id = ?'); params.push(clientId) }
    if (projectId !== undefined && projectId !== null) { where.push('project_id = ?'); params.push(projectId) }
    if (matterId !== undefined && matterId !== null) { where.push('matter_id = ?'); params.push(matterId) }
    const sql = 'SELECT * FROM deliveries' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC, rowid DESC LIMIT ?'
    return this.db.prepare(sql).all(...params, limit).map(mapDeliveryRow)
  }

  /**
   * Delivery rows for one receipt subject (0.3.2): row ownership by the
   * subject's current matter ids OR the generation-time client/project
   * snapshot columns. The union is deliberate — a delivery recorded for the
   * client stays scoped to it even after the matter is re-linked, and a row
   * whose lineage is missing is found through its matter.
   *
   * @param {{clientId?: string|null, projectId?: string|null, matterIds?: string[], limit?: number}} [scope]
   */
  listDeliveriesForScope({ clientId = null, projectId = null, matterIds = [], limit = 100 } = {}) {
    const clauses = []
    const params = []
    const ids = Array.isArray(matterIds) ? matterIds.filter((id) => typeof id === 'string' && id) : []
    if (ids.length) {
      clauses.push('matter_id IN (' + ids.map(() => '?').join(',') + ')')
      params.push(...ids)
    }
    if (clientId !== null && clientId !== undefined && clientId !== '') {
      clauses.push('client_id = ?')
      params.push(clientId)
    }
    if (projectId !== null && projectId !== undefined && projectId !== '') {
      clauses.push('project_id = ?')
      params.push(projectId)
    }
    if (!clauses.length) return []
    const sql = 'SELECT * FROM deliveries WHERE (' + clauses.join(' OR ') + ') ORDER BY created_at DESC, rowid DESC LIMIT ?'
    return this.db.prepare(sql).all(...params, limit).map(mapDeliveryRow)
  }

  /**
   * Count delivery rows for one receipt subject without loading files.
   * Mirrors listDeliveriesForScope's scope predicate; receipt packs themselves
   * are excluded so a new receipt cannot count older receipt packs.
   */
  countDeliveriesForScope({ clientId = null, projectId = null, matterIds = [], excludeReceiptPacks = true } = {}) {
    const scopeClauses = []
    const params = []
    const ids = Array.isArray(matterIds) ? matterIds.filter((id) => typeof id === 'string' && id) : []
    if (ids.length) {
      scopeClauses.push('matter_id IN (' + ids.map(() => '?').join(',') + ')')
      params.push(...ids)
    }
    if (clientId !== null && clientId !== undefined && clientId !== '') {
      scopeClauses.push('client_id = ?')
      params.push(clientId)
    }
    if (projectId !== null && projectId !== undefined && projectId !== '') {
      scopeClauses.push('project_id = ?')
      params.push(projectId)
    }
    if (!scopeClauses.length) return 0
    const clauses = ['(' + scopeClauses.join(' OR ') + ')']
    if (excludeReceiptPacks) clauses.push("COALESCE(tool, '') != 'receipt-pack'")
    return this.db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE ' + clauses.join(' AND ')).get(...params).n
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value
  }

  setMeta(key, value) {
    this._assertWritable('setMeta')
    this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(key, String(value))
  }

  deleteMeta(key) {
    this._assertWritable('deleteMeta')
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key)
  }

  addTaskRun({ conversationId, matterId, task, tools, artifacts, outcome }) {
    this._assertWritable('addTaskRun')
    const id = `run_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    this.db.prepare('INSERT INTO task_runs(id,conversation_id,matter_id,task,tools,artifacts,outcome,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, conversationId, matterId ?? null, task, json(tools), json(artifacts), outcome, new Date().toISOString())
    return id
  }

  listTaskRuns(limit = 20) {
    return this.db.prepare('SELECT * FROM task_runs ORDER BY created_at DESC LIMIT ?').all(limit)
      .map((r) => ({ id: r.id, conversationId: r.conversation_id, matterId: r.matter_id ?? undefined, task: r.task, tools: parse(r.tools), artifacts: parse(r.artifacts), outcome: r.outcome, createdAt: r.created_at }))
  }

  addNudge({ localDay, level, commitmentId, body }) {
    this._assertWritable('addNudge')
    const key = `${localDay}:${level}:${commitmentId}`
    const id = `nudge_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    try {
      this.db.prepare('INSERT INTO nudges(id,at,local_day,level,commitment_id,dedupe_key,body) VALUES(?,?,?,?,?,?,?)')
        .run(id, new Date().toISOString(), localDay, level, commitmentId, key, body)
      return { id, dedupeKey: key }
    } catch {
      return null
    }
  }

  setNudgeOutcome(id, outcome) {
    this._assertWritable('setNudgeOutcome')
    return Number(this.db.prepare('UPDATE nudges SET outcome = ?, outcome_at = ? WHERE id = ?').run(outcome, new Date().toISOString(), id).changes) > 0
  }

  listCommitmentNudges(commitmentId, limit = 3) {
    return this.db.prepare('SELECT * FROM nudges WHERE commitment_id = ? ORDER BY at DESC LIMIT ?').all(commitmentId, limit)
  }

  countNudges(localDay, level) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM nudges WHERE local_day = ? AND level = ?').get(localDay, level).n
  }

  /**
   * P0-2 (tick N+1 removal): insert every nudge for one tick in a single
   * transaction with one prepared statement. INSERT OR IGNORE keeps the
   * per-(local_day, level, commitment_id) dedupe key semantics of addNudge()
   * without aborting the batch on an expected duplicate. Returns the number of
   * rows actually inserted (existing rows are left untouched).
   */
  addNudges(rows) {
    this._assertWritable('addNudges')
    if (!rows?.length) return 0
    return this._transaction('IMMEDIATE', () => {
      const statement = this.db.prepare('INSERT OR IGNORE INTO nudges(id,at,local_day,level,commitment_id,dedupe_key,body) VALUES(?,?,?,?,?,?,?)')
      const now = new Date().toISOString()
      let inserted = 0
      for (const row of rows) {
        const key = `${row.localDay}:${row.level}:${row.commitmentId}`
        const id = `nudge_${randomUUID().replace(/-/g, '').slice(0, 16)}`
        inserted += Number(statement.run(id, row.at ?? now, row.localDay, row.level, row.commitmentId, key, row.body).changes)
      }
      return inserted
    })
  }

  /**
   * P0-2 (tick N+1 removal): the newest `limit` outcomes per commitment.
   *
   * P2-2 (0.2.1): the original form windowed over the WHOLE nudges table
   * (scan + temp b-tree sort), so every tick paid for the entire nudge history:
   * 271ms at 200k rows and growing linearly. Tick only needs outcomes for the
   * commitments it is about to nudge, so callers that know that set pass
   * `commitmentIds`; the read then becomes `limit` index seeks per commitment on
   * idx_nudges_commitment_at, bounded by the candidate set instead of the
   * history size. Passing no ids keeps the historical whole-table map for
   * callers/tests that need it.
   */
  recentNudgeOutcomes(limit = 3, commitmentIds = null) {
    const newest = Math.max(1, Math.floor(Number(limit) || 3))
    const byCommitment = new Map()
    if (commitmentIds) {
      const ids = [...new Set(commitmentIds)]
      if (!ids.length) return byCommitment
      const statement = this.db.prepare('SELECT outcome FROM nudges WHERE commitment_id = ? ORDER BY at DESC LIMIT ?')
      for (const id of ids) {
        const rows = statement.all(id, newest)
        if (rows.length) byCommitment.set(id, rows.map((row) => row.outcome))
      }
      return byCommitment
    }
    const rows = this.db.prepare(`SELECT commitment_id, outcome, at FROM (
        SELECT commitment_id, outcome, at, ROW_NUMBER() OVER (PARTITION BY commitment_id ORDER BY at DESC) AS rn
        FROM nudges
      ) WHERE rn <= ?`).all(newest)
    for (const row of rows) {
      const list = byCommitment.get(row.commitment_id)
      if (list) list.push(row.outcome)
      else byCommitment.set(row.commitment_id, [row.outcome])
    }
    return byCommitment
  }

  /** P0-2 (tick N+1 removal): today's nudge count per level in one query. */
  countNudgesByDay(localDay) {
    const rows = this.db.prepare('SELECT level, COUNT(*) AS n FROM nudges WHERE local_day = ? GROUP BY level').all(localDay)
    return new Map(rows.map((row) => [row.level, Number(row.n)]))
  }

  /** P0-2 (tick N+1 removal): existing (commitment, level) nudge keys for a day. */
  listNudgeLevelKeysByDay(localDay) {
    const rows = this.db.prepare('SELECT commitment_id, level FROM nudges WHERE local_day = ?').all(localDay)
    return new Set(rows.map((row) => `${row.commitment_id}\u0000${row.level}`))
  }

  /** P0-2 (tick N+1 removal): all meta rows with a prefix in one query (snooze:*). */
  listMetaByPrefix(prefix) {
    const rows = this.db.prepare('SELECT key, value FROM meta WHERE key LIKE ?').all(`${prefix}%`)
    return new Map(rows.map((row) => [row.key, row.value]))
  }

  /** P0-2: delete a batch of meta keys in one transaction. */
  deleteMetaKeys(keys) {
    this._assertWritable('deleteMetaKeys')
    if (!keys?.length) return 0
    return this._transaction('IMMEDIATE', () => {
      const statement = this.db.prepare('DELETE FROM meta WHERE key = ?')
      let deleted = 0
      for (const key of keys) deleted += Number(statement.run(key).changes)
      return deleted
    })
  }

  listNudges(limit = 20) {
    return this.db.prepare('SELECT * FROM nudges ORDER BY at DESC LIMIT ?').all(limit)
  }

  /**
   * Delete the non-ledger rows of one matter (sessions/turns/summaries/runs/
   * nudges/candidates/deliveries). The VACUUM is a maintenance operation: it
   * cannot run inside a transaction, so when this is called from inside
   * mutate()/transaction() it is skipped and the caller runs it after COMMIT
   * (pass { vacuum: false } explicitly to force that). Standalone calls keep
   * the historical checkpoint+VACUUM behaviour.
   */
  purgeMatterData(matterId, { vacuum = true } = {}) {
    this._assertWritable('purgeMatterData')
    const conversations = this.db.prepare('SELECT conversation_id FROM sessions WHERE matter_id = ?').all(matterId).map((r) => r.conversation_id)
    let turns = 0
    let summaries = 0
    let runs = 0
    let nudges = 0
    for (const conversationId of conversations) {
      turns += Number(this.db.prepare('DELETE FROM turns WHERE conversation_id = ?').run(conversationId).changes)
      summaries += Number(this.db.prepare('DELETE FROM summary_versions WHERE conversation_id = ?').run(conversationId).changes)
      runs += Number(this.db.prepare('DELETE FROM task_runs WHERE conversation_id = ?').run(conversationId).changes)
      this.db.prepare('DELETE FROM session_summaries WHERE conversation_id = ?').run(conversationId)
    }
    const candidates = Number(this.db.prepare("DELETE FROM memory_candidates WHERE payload LIKE ? OR evidence LIKE ?").run(`%${matterId}%`, `%${matterId}%`).changes)
    const commitmentIds = this.db.prepare('SELECT id FROM commitments WHERE matter_id = ?').all(matterId).map((r) => r.id)
    for (const id of commitmentIds) nudges += Number(this.db.prepare('DELETE FROM nudges WHERE commitment_id = ?').run(id).changes)
    runs += Number(this.db.prepare('DELETE FROM task_runs WHERE matter_id = ?').run(matterId).changes)
    this.db.prepare('DELETE FROM model_calls WHERE matter_id = ?').run(matterId)
    this.db.prepare('DELETE FROM research_runs WHERE matter_id = ?').run(matterId)
    const sessions = this.db.prepare('DELETE FROM sessions WHERE matter_id = ?').run(matterId).changes
    const deliveries = this.db.prepare('DELETE FROM deliveries WHERE matter_id = ?').run(matterId).changes
    if (vacuum && this._transactionDepth === 0) {
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.exec('VACUUM') } catch {}
    }
    return { sessions: Number(sessions), deliveries: Number(deliveries), turns, summaries, runs, nudges, candidates }
  }

  addTurn({ conversationId, role, content }) {
    this._assertWritable('addTurn')
    const seq = (this.db.prepare('SELECT MAX(seq) AS n FROM turns WHERE conversation_id = ?').get(conversationId)?.n ?? 0) + 1
    const id = `turn_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    this.db.prepare('INSERT INTO turns(id,conversation_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, conversationId, seq, role, content, new Date().toISOString())
    return { id, conversationId, seq, role, content, createdAt: new Date().toISOString() }
  }

  getTurn(id) {
    const r = this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id)
    return r ? { id: r.id, conversationId: r.conversation_id, seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at } : undefined
  }

  upsertCalendarEvent({ uid, summary, startsAt, endsAt, allDay = false, tzid, location, rrule, source }) {
    this._assertWritable('upsertCalendarEvent')
    this.db.prepare(`INSERT INTO calendar_events(uid,summary,starts_at,ends_at,all_day,tzid,location,rrule,source,imported_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(uid) DO UPDATE SET summary=excluded.summary, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
        all_day=excluded.all_day, tzid=excluded.tzid, location=excluded.location, rrule=excluded.rrule,
        source=excluded.source, imported_at=excluded.imported_at`)
      .run(uid, summary ?? '', startsAt ?? null, endsAt ?? null, allDay ? 1 : 0, tzid ?? null, location ?? null, rrule ?? null, source ?? null, new Date().toISOString())
    return { uid, summary, startsAt, endsAt, allDay, tzid, location, rrule, source }
  }

  listCalendarEvents(limit = 500) {
    return this.db.prepare('SELECT * FROM calendar_events ORDER BY starts_at ASC LIMIT ?').all(limit)
      .map((r) => ({ uid: r.uid, summary: r.summary, startsAt: r.starts_at ?? undefined, endsAt: r.ends_at ?? undefined, allDay: Boolean(r.all_day), tzid: r.tzid ?? undefined, location: r.location ?? undefined, rrule: r.rrule ?? undefined, source: r.source ?? undefined, importedAt: r.imported_at }))
  }

  listTurns(conversationId, limit = 50) {
    return this.db.prepare('SELECT * FROM turns WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?').all(conversationId, limit)
      .map((r) => ({ id: r.id, conversationId: r.conversation_id, seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at }))
      .reverse()
  }

  permitReplayStore() {
    this._assertWritable('permitReplayStore')
    return {
      has: (permitId) => Boolean(this.db.prepare('SELECT 1 FROM permit_consumed WHERE permit_id = ?').get(permitId)),
      claim: (permitId, expiresAt) => Number(this.db.prepare('INSERT OR IGNORE INTO permit_consumed(permit_id,expires_at,consumed_at) VALUES(?,?,?)').run(permitId, expiresAt, new Date().toISOString()).changes) === 1,
      prune: (now) => Number(this.db.prepare('DELETE FROM permit_consumed WHERE expires_at <= ?').run(now).changes),
    }
  }

  addResearchRun({ matterId, query, answer, sources, usage, stopReason }) {
    this._assertWritable('addResearchRun')
    const id = `rr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.db.prepare('INSERT INTO research_runs(id,matter_id,query,answer,sources,usage,stop_reason,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, matterId ?? null, query, answer, JSON.stringify(sources ?? []), usage ? JSON.stringify(usage) : null, stopReason ?? null, new Date().toISOString())
    return id
  }

  listResearch(limit = 10) {
    return this.db.prepare('SELECT * FROM research_runs ORDER BY created_at DESC LIMIT ?').all(limit).map((r) => ({ id: r.id, matterId: r.matter_id ?? undefined, query: r.query, answer: r.answer, sources: JSON.parse(r.sources), usage: r.usage ? JSON.parse(r.usage) : undefined, stopReason: r.stop_reason ?? undefined, createdAt: r.created_at }))
  }

  addModelCall({ conversationId, matterId, turnId, task, model, effort, thinking, usage, durationMs, finishReason, status = 'ok', code, attempts = 1 }) {
    this._assertWritable('addModelCall')
    const id = `mc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.db.prepare(`INSERT INTO model_calls(id,conversation_id,matter_id,turn_id,task,model,effort,thinking,status,code,attempts,prompt_tokens,completion_tokens,reasoning_tokens,cached_tokens,total_tokens,duration_ms,finish_reason,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, conversationId ?? null, matterId ?? null, turnId ?? null, task, model, effort ?? null, thinking ? 1 : 0,
      status, code ?? null, attempts, usage?.promptTokens ?? 0, usage?.completionTokens ?? 0, usage?.reasoningTokens ?? 0,
      usage?.cachedTokens ?? 0, usage?.totalTokens ?? 0, durationMs ?? 0, finishReason ?? null, new Date().toISOString(),
    )
    return id
  }

  /**
   * Token totals for 'advisers status' / 'advisers receipt'.
   * P1-2: aggregate in SQLite instead of materialising every model_calls row
   * (the old reduce loaded the whole table just to sum five columns).
   */
  sumModelUsage({ since } = {}) {
    const row = since
      ? this.db.prepare(`SELECT COUNT(*) AS calls,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM model_calls WHERE created_at >= ?`).get(since)
      : this.db.prepare(`SELECT COUNT(*) AS calls,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM model_calls`).get()
    return {
      calls: Number(row?.calls ?? 0),
      prompt_tokens: Number(row?.prompt_tokens ?? 0),
      completion_tokens: Number(row?.completion_tokens ?? 0),
      reasoning_tokens: Number(row?.reasoning_tokens ?? 0),
      cached_tokens: Number(row?.cached_tokens ?? 0),
      total_tokens: Number(row?.total_tokens ?? 0),
    }
  }

  proposeCandidate({ kind, payload, evidence }) {
    this._assertWritable('proposeCandidate')
    const id = `cand_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    this.db.prepare('INSERT INTO memory_candidates(id,kind,payload,evidence,status,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, kind, JSON.stringify(payload), JSON.stringify(evidence), 'pending', now)
    return this.getCandidate(id)
  }

  getCandidate(id) {
    const r = this.db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id)
    return r ? { id: r.id, kind: r.kind, payload: JSON.parse(r.payload), evidence: JSON.parse(r.evidence), status: r.status, createdAt: r.created_at, reviewedAt: r.reviewed_at, rejectReason: r.reject_reason } : undefined
  }

  listCandidates(status = 'pending') {
    const rows = status === 'all' ? this.db.prepare('SELECT * FROM memory_candidates ORDER BY created_at DESC').all() : this.db.prepare('SELECT * FROM memory_candidates WHERE status = ? ORDER BY created_at DESC').all(status)
    return rows.map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload), evidence: JSON.parse(r.evidence), status: r.status, createdAt: r.created_at, reviewedAt: r.reviewed_at, rejectReason: r.reject_reason }))
  }

  reviewCandidate(id, status, reason) {
    this._assertWritable('reviewCandidate')
    this.db.prepare('UPDATE memory_candidates SET status = ?, reviewed_at = ?, reject_reason = ? WHERE id = ?')
      .run(status, new Date().toISOString(), reason ?? null, id)
    return this.getCandidate(id)
  }

  searchMemory(query, { limit = 6, matterId } = {}) {
    const terms = String(query || '').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2).slice(0, 8)
    if (!terms.length) return []
    const scope = matterId ? 'AND (matter_id IS NULL OR matter_id = ?)' : ''
    const factRows = this.db.prepare(
      `SELECT id, matter_id, subject, predicate, object, authority, evidence FROM facts
       WHERE status = 'confirmed' AND deleted_at IS NULL
         ${scope}
         AND (${terms.map(() => '(subject LIKE ? OR predicate LIKE ? OR object LIKE ?)').join(' OR ')})
       LIMIT 50`
    ).all(...(matterId ? [matterId] : []), ...terms.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]))
    const prefRows = this.db.prepare(
      `SELECT id, statement, kind, evidence, priority FROM preferences
       WHERE status IN ('confirmed','candidate') AND (expires_at IS NULL OR expires_at > ?)
         AND (${terms.map(() => 'statement LIKE ?').join(' OR ')})
       LIMIT 50`
    ).all(new Date().toISOString(), ...terms.map((t) => `%${t}%`))
    const score = (text) => terms.filter((t) => text.includes(t)).length
    return [
      ...factRows.map((r) => ({ kind: 'fact', id: r.id, text: r.object, detail: `${r.subject} ${r.predicate}`, matterId: r.matter_id ?? undefined, evidence: r.evidence ? JSON.parse(r.evidence)[0]?.quote : undefined, score: score(`${r.subject} ${r.predicate} ${r.object}`) })),
      ...prefRows.map((r) => ({ kind: 'preference', id: r.id, text: r.statement, detail: r.kind, evidence: r.evidence ? JSON.parse(r.evidence)[0]?.quote : undefined, score: score(r.statement) })),
    ].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit)
  }

  /**
   * Full-text turn search (schema v19; perf audit round 2, P2-6).
   *
   * 3+ characters go through FTS5 MATCH. With the trigram tokenizer that is
   * CJK substring/phrase search and English substring search; with the
   * unicode61 fallback it is word search (Chinese misses then fall through to
   * LIKE). Shorter queries and malformed/special FTS syntax keep the previous
   * LIKE path as the correctness backstop. Public shape and limit are unchanged
   * from v18: { id, conversationId, seq, role, content, createdAt }. Ordering
   * keeps the v18 conventions: FTS hits are ranked, LIKE hits are in seq order
   * (so Chinese results move from the old LIKE order to relevance order once
   * they hit the trigram index).
   */
  searchTurns(query, { conversationId, matterId, limit = 8 } = {}) {
    const q = String(query ?? '').trim()
    if (!q) return []
    const clauses = []
    const filterArgs = []
    if (conversationId) { clauses.push('t.conversation_id = ?'); filterArgs.push(conversationId) }
    if (matterId) { clauses.push('s.matter_id = ?'); filterArgs.push(matterId) }
    const join = matterId ? ' JOIN sessions s ON s.conversation_id = t.conversation_id' : ''
    const where = clauses.length ? ` AND ${clauses.join(' AND ')}` : ''
    const map = (r) => ({ id: r.id, conversationId: r.conversation_id, seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at })
    const likeRows = () => {
      const rows = this.db.prepare(`SELECT t.* FROM turns t${join} WHERE t.content LIKE ?${where} ORDER BY t.seq DESC LIMIT ?`).all(`%${q}%`, ...filterArgs, limit)
      return rows.reverse().map(map)
    }
    let ftsRows = null
    if (this.ftsTokenizer && this._ftsTables.has('turns_fts') && !this._ftsBroken && q.length >= FTS_TRIGRAM_MIN_QUERY) {
      try {
        ftsRows = this.db.prepare(`SELECT t.* FROM turns_fts f JOIN turns t ON t.rowid = f.rowid${join} WHERE turns_fts MATCH ?${where} ORDER BY rank LIMIT ?`).all(q, ...filterArgs, limit)
      } catch {
        // Malformed or special FTS query: use the LIKE scan below.
        ftsRows = null
      }
    }
    // P1-5: a full FTS page is returned ranked, as before. A short page is
    // cross-checked with a LIKE scan; if LIKE finds more rows the index is
    // incomplete (or the MATCH query was narrower) and the complete, seq-ordered
    // LIKE rows are returned with one warning instead of silently losing hits.
    if (ftsRows && ftsRows.length >= limit) return ftsRows.map(map)
    const rows = likeRows()
    if (ftsRows && ftsRows.length) {
      if (rows.length > ftsRows.length) {
        this._markFtsInconsistent('turns_fts', ftsRows.length, rows.length)
        return rows
      }
      return ftsRows.map(map)
    }
    if (ftsRows && ftsRows.length === 0 && rows.length > 0 && this.ftsTokenizer === 'trigram') {
      // Trigram indexes every 3+ character substring, so a 0-hit MATCH that a
      // LIKE scan contradicts means the index is missing rows (not a tokenizer
      // limitation); warn instead of quietly returning the LIKE rows.
      this._markFtsInconsistent('turns_fts', 0, rows.length)
    }
    return rows
  }

  /**
   * Full-text session-summary search (schema v19). Same trigram/FTS-then-LIKE
   * strategy as searchTurns; returns the public summary shape used by
   * getSessionSummary().
   */
  searchSummaries(query, { conversationId, limit = 8 } = {}) {
    const q = String(query ?? '').trim()
    if (!q) return []
    const where = conversationId ? ' AND s.conversation_id = ?' : ''
    const filterArgs = conversationId ? [conversationId] : []
    const map = (r) => ({ conversationId: r.conversation_id, summary: r.summary, throughSeq: r.through_seq, updatedAt: r.updated_at })
    const likeRows = () => this.db.prepare(`SELECT s.* FROM session_summaries s WHERE s.summary LIKE ?${where} ORDER BY s.updated_at DESC LIMIT ?`).all(`%${q}%`, ...filterArgs, limit).map(map)
    let ftsRows = null
    if (this.ftsTokenizer && this._ftsTables.has('summaries_fts') && !this._ftsBroken && q.length >= FTS_TRIGRAM_MIN_QUERY) {
      try {
        ftsRows = this.db.prepare(`SELECT s.* FROM summaries_fts f JOIN session_summaries s ON s.rowid = f.rowid WHERE summaries_fts MATCH ?${where} ORDER BY rank LIMIT ?`).all(q, ...filterArgs, limit)
      } catch {
        // Malformed or special FTS query: use the LIKE scan below.
        ftsRows = null
      }
    }
    if (ftsRows && ftsRows.length >= limit) return ftsRows.map(map)
    const rows = likeRows()
    if (ftsRows && ftsRows.length) {
      if (rows.length > ftsRows.length) {
        this._markFtsInconsistent('summaries_fts', ftsRows.length, rows.length)
        return rows
      }
      return ftsRows.map(map)
    }
    if (ftsRows && ftsRows.length === 0 && rows.length > 0 && this.ftsTokenizer === 'trigram') {
      this._markFtsInconsistent('summaries_fts', 0, rows.length)
    }
    return rows
  }

  getSessionSummary(conversationId) {
    const r = this.db.prepare('SELECT * FROM session_summaries WHERE conversation_id = ?').get(conversationId)
    return r ? { conversationId: r.conversation_id, summary: r.summary, throughSeq: r.through_seq, updatedAt: r.updated_at } : undefined
  }

  upsertSessionSummary({ conversationId, summary, throughSeq, pins }) {
    this._assertWritable('upsertSessionSummary')
    const max = this.db.prepare('SELECT MAX(version) AS v FROM summary_versions WHERE conversation_id = ?').get(conversationId)?.v ?? 0
    const version = max + 1
    const at = new Date().toISOString()
    this.db.prepare('INSERT INTO summary_versions(conversation_id,version,summary,through_seq,pins,created_at) VALUES(?,?,?,?,?,?)')
      .run(conversationId, version, summary, throughSeq, pins ?? null, at)
    this.db.prepare(`INSERT INTO session_summaries(conversation_id,summary,through_seq,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET summary=excluded.summary, through_seq=excluded.through_seq, updated_at=excluded.updated_at`)
      .run(conversationId, summary, throughSeq, at)
    return { version, summary, throughSeq, createdAt: at }
  }

  listSummaryVersions(conversationId) {
    return this.db.prepare('SELECT * FROM summary_versions WHERE conversation_id = ? ORDER BY version DESC').all(conversationId)
      .map((r) => ({ conversationId: r.conversation_id, version: r.version, summary: r.summary, throughSeq: r.through_seq, pins: r.pins ?? undefined, createdAt: r.created_at }))
  }

  countDeliveries() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n
  }

  /**
   * Append an audit row atomically. BEGIN IMMEDIATE serializes writers and the
   * previous hash is re-read inside the transaction, so two concurrent writers
   * can never both chain onto the same predecessor (audit fork, P0-3).
   */
  appendAudit({ actor, action, allowed, reason }) {
    this._assertWritable('appendAudit')
    return this._transaction('IMMEDIATE', () => this._appendAuditRow({ actor, action, allowed, reason }))
  }

  _appendAuditRow({ actor, action, allowed, reason }) {
    this._assertWritable('appendAudit')
    const last = this.db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get()
    const prev = last?.hash ?? ''
    const at = new Date().toISOString()
    const material = `${prev}\n${at}\n${actor}\n${action}\n${allowed ? 1 : 0}\n${reason ?? ''}`
    const key = process.env.ADVISERS_AUDIT_KEY
    const hash = key ? createHmac('sha256', key).update(material).digest('hex') : createHash('sha256').update(material).digest('hex')
    const info = this.db.prepare('INSERT INTO audit(at,actor,action,allowed,reason,prev_hash,hash) VALUES(?,?,?,?,?,?,?)')
      .run(at, actor, action, allowed ? 1 : 0, reason ?? null, prev, hash)
    return { seq: Number(info.lastInsertRowid), at, actor, action, allowed: Boolean(allowed), reason, prevHash: prev, hash }
  }

  listAudit(limit = 50) {
    return this.db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit)
      .map((r) => ({ seq: r.seq, at: r.at, actor: r.actor, action: r.action, allowed: Boolean(r.allowed), reason: r.reason ?? undefined, prevHash: r.prev_hash ?? undefined, hash: r.hash }))
  }

  verifyAudit() {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY seq ASC').all()
    let prev = ''
    for (const row of rows) {
      const material = `${prev}\n${row.at}\n${row.actor}\n${row.action}\n${row.allowed}\n${row.reason ?? ''}`
      const key = process.env.ADVISERS_AUDIT_KEY
      const expected = key ? createHmac('sha256', key).update(material).digest('hex') : createHash('sha256').update(material).digest('hex')
      if (row.prev_hash !== prev || row.hash !== expected) return { ok: false, seq: row.seq }
      prev = row.hash
    }
    return { ok: true, count: rows.length }
  }

  hasSeen(linkId, accountId, dedupeKey, ttlDays = 7) {
    const cutoff = new Date(Date.now() - ttlDays * 86_400_000).toISOString()
    const row = this.db.prepare(
      'SELECT 1 AS hit FROM seen_events WHERE link_id = ? AND account_id = ? AND dedupe_key = ? AND seen_at >= ?',
    ).get(linkId, accountId, dedupeKey, cutoff)
    return Boolean(row)
  }

  markSeen(linkId, accountId, dedupeKey) {
    this._assertWritable('markSeen')
    this.db.prepare('INSERT OR REPLACE INTO seen_events VALUES(?,?,?,?)')
      .run(linkId, accountId, dedupeKey, new Date().toISOString())
  }

  pruneSeen(ttlDays = 7) {
    this._assertWritable('pruneSeen')
    const cutoff = new Date(Date.now() - ttlDays * 86_400_000).toISOString()
    this.db.prepare('DELETE FROM seen_events WHERE seen_at < ?').run(cutoff)
  }

  seenStore() {
    return {
      has: (key) => {
        const [linkId, accountId, ...rest] = key.split(':')
        return this.hasSeen(linkId, accountId, rest.join(':'))
      },
      add: (key) => {
        const [linkId, accountId, ...rest] = key.split(':')
        this.markSeen(linkId, accountId, rest.join(':'))
      },
    }
  }

  // -------------------------------------------------------------------------
  // Directed entity reads/writes (0.2.3 incremental write path).
  //
  // Every insert*/update* must run inside mutate()/transaction() (otherwise
  // E_TX_REQUIRED: a ledger row must never commit outside the transaction that
  // carries its audit row), and produces exactly the bytes _saveRows() would
  // (shared ENTITY_SPECS codecs). update* writes only the columns a patch
  // explicitly names; an unknown field is an error so a typo cannot silently
  // write nothing. get*/find* are read methods usable on read-only stores.
  // -------------------------------------------------------------------------

  _getEntity(kind, id) {
    const spec = ENTITY_SPECS[kind]
    if (!spec) throw new Error(`unknown entity: ${kind}`)
    const row = this.db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.key} = ?`).get(id)
    return row ? spec.map(row) : undefined
  }

  getMatter(id) { return this._getEntity('matters', id) }
  getFact(id) { return this._getEntity('facts', id) }
  getCommitment(id) { return this._getEntity('commitments', id) }
  getPreference(id) { return this._getEntity('preferences', id) }

  _insertEntity(operation, kind, entity) {
    this._assertInWriteTransaction(operation)
    const spec = ENTITY_SPECS[kind]
    if (!spec) throw new Error(`unknown entity: ${kind}`)
    const fields = Object.keys(spec.columns)
    const columns = fields.map((field) => spec.columns[field][0])
    const values = fields.map((field) => encodeEntityValue(spec.columns[field][1], entity?.[field]))
    this.db.prepare(`INSERT INTO ${spec.table}(${columns.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).run(...values)
    return entity
  }

  insertMatter(row) { return this._insertEntity('insertMatter', 'matters', row) }
  insertFact(row) { return this._insertEntity('insertFact', 'facts', row) }
  insertCommitment(row) { return this._insertEntity('insertCommitment', 'commitments', row) }
  insertPreference(row) { return this._insertEntity('insertPreference', 'preferences', row) }

  _updateEntity(operation, kind, id, patch) {
    this._assertInWriteTransaction(operation)
    const spec = ENTITY_SPECS[kind]
    if (!spec) throw new Error(`unknown entity: ${kind}`)
    const assignments = []
    const values = []
    for (const field of Object.keys(patch ?? {})) {
      const column = spec.columns[field]
      if (!column) throw new Error(`unknown ${kind} field: ${field}`)
      const value = patch[field]
      if (value === undefined) continue
      assignments.push(`${column[0]} = ?`)
      values.push(encodeEntityValue(column[1], value))
    }
    if (assignments.length) {
      this.db.prepare(`UPDATE ${spec.table} SET ${assignments.join(', ')} WHERE ${spec.key} = ?`).run(...values, id)
    }
    return this._getEntity(kind, id)
  }

  updateMatter(id, patch) { return this._updateEntity('updateMatter', 'matters', id, patch) }
  updateFact(id, patch) { return this._updateEntity('updateFact', 'facts', id, patch) }
  updateCommitment(id, patch) { return this._updateEntity('updateCommitment', 'commitments', id, patch) }
  updatePreference(id, patch) { return this._updateEntity('updatePreference', 'preferences', id, patch) }

  /**
   * The confirmed, unexpired fact for one identity (remember/supersede path).
   * predicate 'said' never matches: conversation echoes do not supersede each
   * other (same rule as core Ledger.remember). Uses idx_facts_identity. The
   * `IS ?` comparison treats a missing matterId like SQLite's IS NULL.
   */
  findFactCurrent({ subject, predicate, matterId } = {}) {
    if (predicate === 'said') return undefined
    const row = this.db.prepare(`
      SELECT * FROM facts
      WHERE status = 'confirmed' AND expired_at IS NULL AND subject = ? AND predicate = ? AND (matter_id IS ?)
      ORDER BY rowid LIMIT 1
    `).get(subject, predicate, matterId ?? null)
    return row ? mapFactRow(row) : undefined
  }

  /** First non-deprecated preference with this exact statement (correct/learn). */
  findPreferenceByStatement(statement) {
    const row = this.db.prepare("SELECT * FROM preferences WHERE statement = ? AND status <> 'deprecated' ORDER BY rowid LIMIT 1").get(statement)
    return row ? mapPreferenceRow(row) : undefined
  }

  /** First active matter by insertion order (commit add / memory accept default). */
  firstActiveMatter() {
    const row = this.db.prepare("SELECT * FROM matters WHERE status = 'active' ORDER BY rowid LIMIT 1").get()
    return row ? mapMatterRow(row) : undefined
  }

  /**
   * Persist one tick() batch atomically (no audit row, matching the historical
   * tick behaviour): nudge inserts, snooze wake-ups and the snooze meta
   * cleanup either all commit or all roll back, so a nudge can never be
   * recorded while its wake-up is lost. The conditional UPDATE keeps a
   * concurrent state change (e.g. the commitment was completed meanwhile)
   * authoritative. Returns { nudges, woke, metaDeleted }.
   */
  applyTick({ nudgeRows = [], wakeIds = [], snoozeKeys = [] } = {}) {
    this._assertWritable('applyTick')
    return this._transaction('IMMEDIATE', () => {
      const now = new Date().toISOString()
      let nudges = 0
      if (nudgeRows.length) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO nudges(id,at,local_day,level,commitment_id,dedupe_key,body) VALUES(?,?,?,?,?,?,?)')
        for (const row of nudgeRows) {
          const dedupeKey = `${row.localDay}:${row.level}:${row.commitmentId}`
          const id = `nudge_${randomUUID().replace(/-/g, '').slice(0, 16)}`
          nudges += Number(insert.run(id, row.at ?? now, row.localDay, row.level, row.commitmentId, dedupeKey, row.body).changes)
        }
      }
      let woke = 0
      if (wakeIds.length) {
        const wake = this.db.prepare("UPDATE commitments SET status = 'open' WHERE id = ? AND status = 'snoozed'")
        for (const id of wakeIds) woke += Number(wake.run(id).changes)
      }
      let metaDeleted = 0
      if (snoozeKeys.length) {
        const del = this.db.prepare('DELETE FROM meta WHERE key = ?')
        for (const key of snoozeKeys) metaDeleted += Number(del.run(key).changes)
      }
      return { nudges, woke, metaDeleted }
    })
  }
  // -------------------------------------------------------------------------
  // Customer / project entities (schema v21, 0.3.0).
  //
  // clients/projects/client_notes are SQLite-only rows: they never enter the
  // wire LedgerSnapshot, so they are written with directed INSERT/UPDATE
  // statements (a caller that needs an audit row wraps them in mutate(fn,
  // audit), exactly like the other directed writes) and read back through the
  // CRUD methods below. A matter keeps the ownership (client_id/project_id) as
  // the single source of truth; the client timeline is derived from the rows
  // clientTimelineSources() returns, and there is no event table and no stored
  // counter that could disagree with them. Nothing is hard-deleted: archiving
  // sets status='archived' + deleted_at, so past work stays answerable.
  // -------------------------------------------------------------------------

  /** A live (active, non-deleted) client row for a write, or a stable E_*. */
  _clientForWrite(clientId, operation = 'client') {
    const id = typeof clientId === 'string' ? clientId.trim() : ''
    const row = id ? this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id) : undefined
    if (!row) throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + String(clientId), 'advisers client add "<name>"')
    if (row.deleted_at != null || row.status !== 'active') {
      throw entityError('E_CLIENT_ARCHIVED', 'client is archived: ' + row.id + ' (' + operation + ')', 'advisers client ls')
    }
    return row
  }

  /** Active client identity keys (name + aliases) other than exceptId. */
  _activeClientIdentities(exceptId = null) {
    const rows = this.db.prepare("SELECT id, name, aliases FROM clients WHERE status = 'active' AND deleted_at IS NULL").all()
    const result = []
    for (const row of rows) {
      if (exceptId != null && row.id === exceptId) continue
      const norms = new Map()
      norms.set(normalizeClientName(row.name), 'name')
      for (const alias of parse(row.aliases)) {
        if (typeof alias !== 'string') continue
        const norm = normalizeClientName(alias)
        if (norm && !norms.has(norm)) norms.set(norm, 'alias')
      }
      result.push({ id: row.id, name: row.name, norms: norms })
    }
    return result
  }

  /**
   * Refuse a client name/alias that another live client already owns. The
   * partial unique index enforces the name half even under a racing writer;
   * aliases are checked here because they live inside a JSON column.
   */
  _assertClientIdentityFree({ nameNorm, aliases = [] }, exceptId = null) {
    const identities = this._activeClientIdentities(exceptId)
    for (const identity of identities) {
      if (identity.norms.has(nameNorm)) {
        throw entityError('E_CLIENT_DUPLICATE', 'an active client named ' + identity.name + ' already exists (' + identity.id + ')', 'advisers client alias add ' + identity.id + ' <alias>')
      }
    }
    for (const alias of aliases) {
      const norm = normalizeClientName(alias)
      for (const identity of identities) {
        if (identity.norms.has(norm)) {
          throw entityError('E_CLIENT_ALIAS_CONFLICT', 'alias ' + alias + ' is already used by ' + identity.name + ' (' + identity.id + ')', 'advisers client alias add ' + identity.id + ' <alias>')
        }
      }
    }
  }

  /** Create a client. Same-name active client -> E_CLIENT_DUPLICATE. */
  addClient({ name, aliases, tags, secrecyDefault, notes, status, id } = {}) {
    this._assertWritable('addClient')
    const displayName = validateDisplayName('client', name)
    const nameNorm = normalizeClientName(displayName)
    const aliasList = validateStringList('client', 'aliases', aliases)
    const tagList = validateStringList('client', 'tags', tags, { max: 20, itemMax: 40 })
    const secrecy = validateSecrecy(secrecyDefault)
    const clientStatus = validateEntityStatus('client', status)
    const clientId = id === undefined || id === null ? 'cl_' + randomUUID().replace(/-/g, '').slice(0, 16) : String(id).trim()
    if (!clientId) throw entityError('E_CLIENT_INVALID', 'client id must not be empty')
    if (this.getClient(clientId)) throw entityError('E_CLIENT_DUPLICATE', 'client id already exists: ' + clientId)
    if (clientStatus === 'active') this._assertClientIdentityFree({ nameNorm, aliases: aliasList })
    const now = new Date().toISOString()
    try {
      this.db.prepare('INSERT INTO clients(id,name,name_norm,aliases,status,tags,secrecy_default,notes,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(clientId, displayName, nameNorm, json(aliasList), clientStatus, json(tagList), secrecy, normalizeOptionalText('client', 'notes', notes, 4000), now, now, clientStatus === 'archived' ? now : null)
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error?.message ?? error))) {
        throw entityError('E_CLIENT_DUPLICATE', 'an active client with this name already exists', 'advisers client ls')
      }
      throw error
    }
    return this.getClient(clientId)
  }

  /** One client by id (archived included; undefined when absent). */
  getClient(id) {
    const row = this.db.prepare('SELECT * FROM clients WHERE id = ?').get(String(id))
    return row ? mapClientRow(row) : undefined
  }

  /** First live client whose name or alias normalises to the given name. */
  findClientByName(name) {
    const nameNorm = normalizeClientName(validateDisplayName('client', name))
    const rows = this.db.prepare("SELECT * FROM clients WHERE status = 'active' AND deleted_at IS NULL ORDER BY created_at, id").all()
    for (const row of rows) {
      if (row.name_norm === nameNorm) return mapClientRow(row)
      for (const alias of parse(row.aliases)) {
        if (typeof alias === 'string' && normalizeClientName(alias) === nameNorm) return mapClientRow(row)
      }
    }
    return undefined
  }

  /**
   * List clients. Default is the live (active, non-deleted) list; pass
   * status:'archived' with includeDeleted:true for tombstones, status:'all'
   * for every status. Ordered by name_norm then id (deterministic).
   */
  listClients({ status = 'active', includeDeleted = false, limit = 100 } = {}) {
    const where = []
    const params = []
    if (includeDeleted !== true) where.push('deleted_at IS NULL')
    if (status !== 'all') {
      const wanted = validateEntityStatus('client', status)
      where.push('status = ?')
      params.push(wanted)
    }
    const sql = 'SELECT * FROM clients' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY name_norm ASC, id ASC LIMIT ?'
    return this.db.prepare(sql).all(...params, normalizeRowLimit(limit, { def: 100, max: 1000 })).map(mapClientRow)
  }

  /**
   * Update the mutable client fields. Renames re-check the active identity
   * uniqueness; status:'archived' stamps deleted_at, status:'active' restores
   * (and fails closed if the name was reused meanwhile).
   */
  updateClient(id, patch = {}) {
    this._assertWritable('updateClient')
    const current = this.getClient(id)
    if (!current) throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + String(id))
    const allowed = ['name', 'aliases', 'tags', 'secrecyDefault', 'notes', 'status']
    for (const field of Object.keys(patch)) {
      if (!allowed.includes(field)) throw new Error('unknown client field: ' + field)
    }
    const name = patch.name === undefined ? current.name : validateDisplayName('client', patch.name)
    const nameNorm = normalizeClientName(name)
    const aliases = patch.aliases === undefined ? current.aliases : validateStringList('client', 'aliases', patch.aliases)
    const tags = patch.tags === undefined ? current.tags : validateStringList('client', 'tags', patch.tags, { max: 20, itemMax: 40 })
    const secrecy = patch.secrecyDefault === undefined ? current.secrecyDefault : validateSecrecy(patch.secrecyDefault)
    const notes = patch.notes === undefined ? (current.notes ?? null) : normalizeOptionalText('client', 'notes', patch.notes, 4000)
    const status = patch.status === undefined ? current.status : validateEntityStatus('client', patch.status)
    const now = new Date().toISOString()
    let deletedAt = current.deletedAt ?? null
    if (status === 'archived' && deletedAt === null) deletedAt = now
    if (status === 'active' && deletedAt !== null) deletedAt = null
    if (status === 'active') this._assertClientIdentityFree({ nameNorm, aliases }, current.id)
    try {
      this.db.prepare('UPDATE clients SET name = ?, name_norm = ?, aliases = ?, status = ?, tags = ?, secrecy_default = ?, notes = ?, updated_at = ?, deleted_at = ? WHERE id = ?')
        .run(name, nameNorm, json(aliases), status, json(tags), secrecy, notes, now, deletedAt, current.id)
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error?.message ?? error))) {
        throw entityError('E_CLIENT_DUPLICATE', 'an active client with this name already exists', 'advisers client ls')
      }
      throw error
    }
    return this.getClient(current.id)
  }

  /** Soft-delete one client (status archived + tombstone); idempotent. */
  archiveClient(id, { now } = {}) {
    this._assertWritable('archiveClient')
    const current = this.getClient(id)
    if (!current) throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + String(id))
    const at = now === undefined || now === null ? new Date().toISOString() : String(now)
    this.db.prepare("UPDATE clients SET status = 'archived', deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?").run(at, at, current.id)
    return this.getClient(current.id)
  }

  /** Restore an archived client; fails closed when its name was reused. */
  restoreClient(id) {
    this._assertWritable('restoreClient')
    const current = this.getClient(id)
    if (!current) throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + String(id))
    this._assertClientIdentityFree({ nameNorm: current.nameNorm, aliases: current.aliases }, current.id)
    const now = new Date().toISOString()
    this.db.prepare("UPDATE clients SET status = 'active', deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, current.id)
    return this.getClient(current.id)
  }

  /** Append one alias; alias conflicts with another live client are refused. */
  addClientAlias(id, alias) {
    this._assertWritable('addClientAlias')
    const current = this.getClient(id)
    if (!current) throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + String(id))
    const text = validateDisplayName('client', alias)
    const norm = normalizeClientName(text)
    if (norm === current.nameNorm || current.aliases.some((entry) => typeof entry === 'string' && normalizeClientName(entry) === norm)) return current
    this._assertClientIdentityFree({ nameNorm: current.nameNorm, aliases: [text] }, current.id)
    const aliases = [...current.aliases, text]
    this.db.prepare('UPDATE clients SET aliases = ?, updated_at = ? WHERE id = ?').run(json(aliases), new Date().toISOString(), current.id)
    return this.getClient(current.id)
  }

  /** Remove one alias (normalised match); unknown alias -> E_CLIENT_ALIAS_NOT_FOUND. */
  removeClientAlias(id, alias) {
    this._assertWritable('removeClientAlias')
    const current = this.getClient(id)
    if (!current) throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + String(id))
    const norm = normalizeClientName(validateDisplayName('client', alias))
    const aliases = current.aliases.filter((entry) => !(typeof entry === 'string' && normalizeClientName(entry) === norm))
    if (aliases.length === current.aliases.length) throw entityError('E_CLIENT_ALIAS_NOT_FOUND', 'unknown alias: ' + String(alias))
    this.db.prepare('UPDATE clients SET aliases = ?, updated_at = ? WHERE id = ?').run(json(aliases), new Date().toISOString(), current.id)
    return this.getClient(current.id)
  }

  /**
   * Merge one client into another (explicit user intent; no fuzzy matching).
   *
   * Everything source-owned moves to the target: projects with a name clash are
   * merged onto the target project, the remaining projects/matters/notes and
   * delivery snapshots are re-pointed, the source is archived (never deleted),
   * and its name/aliases become target aliases when no third live client owns
   * them. One transaction: a merge can never half-happen.
   */
  mergeClients(fromId, intoId, { now } = {}) {
    this._assertWritable('mergeClients')
    if (String(fromId) === String(intoId)) throw entityError('E_CLIENT_MERGE_SELF', 'cannot merge a client into itself')
    const source = this.getClient(fromId)
    if (!source) throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + String(fromId))
    const target = this._clientForWrite(intoId, 'mergeClients')
    const targetRow = this.getClient(target.id)
    const at = now === undefined || now === null ? new Date().toISOString() : String(now)
    return this._transaction('IMMEDIATE', () => {
      const sourceProjects = this.db.prepare('SELECT * FROM projects WHERE client_id = ? ORDER BY name_norm, id').all(source.id).map(mapProjectRow)
      const targetProjects = this.db.prepare("SELECT * FROM projects WHERE client_id = ? AND status = 'active' AND deleted_at IS NULL").all(target.id).map(mapProjectRow)
      const byName = new Map(targetProjects.map((project) => [project.nameNorm, project]))
      let movedProjects = 0
      let mergedProjects = 0
      for (const project of sourceProjects) {
        const existing = byName.get(project.nameNorm)
        if (!existing) {
          this.db.prepare('UPDATE projects SET client_id = ?, updated_at = ? WHERE id = ?').run(target.id, at, project.id)
          movedProjects++
        } else {
          this.db.prepare('UPDATE matters SET project_id = ? WHERE project_id = ?').run(existing.id, project.id)
          this.db.prepare('UPDATE client_notes SET project_id = ? WHERE project_id = ?').run(existing.id, project.id)
          this.db.prepare("UPDATE projects SET status = 'archived', deleted_at = ?, updated_at = ? WHERE id = ?").run(at, at, project.id)
          mergedProjects++
        }
      }
      const movedMatters = Number(this.db.prepare('UPDATE matters SET client_id = ?, updated_at = ? WHERE client_id = ?').run(target.id, at, source.id).changes)
      const movedNotes = Number(this.db.prepare('UPDATE client_notes SET client_id = ? WHERE client_id = ?').run(target.id, source.id).changes)
      const movedDeliveries = Number(this.db.prepare('UPDATE deliveries SET client_id = ? WHERE client_id = ?').run(target.id, source.id).changes)
      this.db.prepare("UPDATE clients SET status = 'archived', deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?").run(at, at, source.id)
      const taken = new Set()
      for (const identity of this._activeClientIdentities(target.id)) for (const norm of identity.norms.keys()) taken.add(norm)
      const aliases = targetRow.aliases.slice()
      const seen = new Set(aliases.map((entry) => normalizeClientName(String(entry))))
      let carriedAliases = 0
      for (const name of [source.name, ...source.aliases]) {
        if (typeof name !== 'string') continue
        const norm = normalizeClientName(name)
        if (!norm || norm === targetRow.nameNorm || seen.has(norm) || taken.has(norm)) continue
        aliases.push(name)
        seen.add(norm)
        carriedAliases++
      }
      if (carriedAliases) this.db.prepare('UPDATE clients SET aliases = ?, updated_at = ? WHERE id = ?').run(json(aliases), at, target.id)
      return {
        client: this.getClient(target.id),
        mergedFrom: source.id,
        movedMatters,
        movedProjects,
        mergedProjects,
        movedNotes,
        movedDeliveries,
        carriedAliases,
      }
    })
  }

  // -------------------------------------------------------------------------
  // Projects (one client per project; a cross-client job is two projects).
  // -------------------------------------------------------------------------

  /** Create a project under one live client. */
  addProject({ clientId, name, startedAt, dueAt, defaultMatterId, notes, status, id } = {}) {
    this._assertWritable('addProject')
    const client = this._clientForWrite(clientId, 'addProject')
    const displayName = validateDisplayName('project', name)
    const nameNorm = normalizeClientName(displayName)
    const projectStatus = validateEntityStatus('project', status)
    const projectId = id === undefined || id === null ? 'prj_' + randomUUID().replace(/-/g, '').slice(0, 16) : String(id).trim()
    if (!projectId) throw entityError('E_PROJECT_INVALID', 'project id must not be empty')
    if (this.getProject(projectId)) throw entityError('E_PROJECT_DUPLICATE', 'project id already exists: ' + projectId)
    let matterId = null
    if (defaultMatterId !== undefined && defaultMatterId !== null) {
      const matter = this.getMatter(String(defaultMatterId))
      if (!matter) throw entityError('E_MATTER_NOT_FOUND', 'unknown matter: ' + String(defaultMatterId), 'advisers matter ls')
      matterId = matter.id
    }
    const starts = normalizeOptionalDate('project', 'startedAt', startedAt)
    const ends = normalizeOptionalDate('project', 'dueAt', dueAt)
    const now = new Date().toISOString()
    try {
      this.db.prepare('INSERT INTO projects(id,client_id,name,name_norm,status,started_at,due_at,default_matter_id,notes,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(projectId, client.id, displayName, nameNorm, projectStatus, starts, ends, matterId, normalizeOptionalText('project', 'notes', notes, 4000), now, now, projectStatus === 'archived' ? now : null)
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error?.message ?? error))) {
        throw entityError('E_PROJECT_DUPLICATE', 'this client already has an active project with this name', 'advisers project ls --client ' + client.id)
      }
      throw error
    }
    return this.getProject(projectId)
  }

  /** One project by id (archived included; undefined when absent). */
  getProject(id) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(String(id))
    return row ? mapProjectRow(row) : undefined
  }

  /** Deterministic name lookup inside one client (active projects only). */
  findProjectByName(clientId, name) {
    const nameNorm = normalizeClientName(validateDisplayName('project', name))
    const row = this.db.prepare("SELECT * FROM projects WHERE client_id = ? AND name_norm = ? AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1").get(String(clientId), nameNorm)
    return row ? mapProjectRow(row) : undefined
  }

  /** List projects, optionally scoped to one client. */
  listProjects({ clientId, status = 'active', includeDeleted = false, limit = 100 } = {}) {
    const where = []
    const params = []
    if (includeDeleted !== true) where.push('deleted_at IS NULL')
    if (clientId !== undefined && clientId !== null) { where.push('client_id = ?'); params.push(String(clientId)) }
    if (status !== 'all') {
      const wanted = validateEntityStatus('project', status)
      where.push('status = ?')
      params.push(wanted)
    }
    const sql = 'SELECT * FROM projects' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY client_id ASC, name_norm ASC, id ASC LIMIT ?'
    return this.db.prepare(sql).all(...params, normalizeRowLimit(limit, { def: 100, max: 1000 })).map(mapProjectRow)
  }

  /** Update mutable project fields (rename re-checks the per-client uniqueness). */
  updateProject(id, patch = {}) {
    this._assertWritable('updateProject')
    const current = this.getProject(id)
    if (!current) throw entityError('E_PROJECT_NOT_FOUND', 'unknown project: ' + String(id))
    const allowed = ['name', 'status', 'startedAt', 'dueAt', 'defaultMatterId', 'notes']
    for (const field of Object.keys(patch)) {
      if (!allowed.includes(field)) throw new Error('unknown project field: ' + field)
    }
    const name = patch.name === undefined ? current.name : validateDisplayName('project', patch.name)
    const nameNorm = normalizeClientName(name)
    const status = patch.status === undefined ? current.status : validateEntityStatus('project', patch.status)
    const starts = patch.startedAt === undefined ? (current.startedAt ?? null) : normalizeOptionalDate('project', 'startedAt', patch.startedAt)
    const ends = patch.dueAt === undefined ? (current.dueAt ?? null) : normalizeOptionalDate('project', 'dueAt', patch.dueAt)
    const notes = patch.notes === undefined ? (current.notes ?? null) : normalizeOptionalText('project', 'notes', patch.notes, 4000)
    let matterId = current.defaultMatterId ?? null
    if (patch.defaultMatterId !== undefined) {
      matterId = patch.defaultMatterId === null ? null : String(patch.defaultMatterId)
      if (matterId !== null && !this.getMatter(matterId)) throw entityError('E_MATTER_NOT_FOUND', 'unknown matter: ' + matterId, 'advisers matter ls')
    }
    const now = new Date().toISOString()
    let deletedAt = current.deletedAt ?? null
    if (status === 'archived' && deletedAt === null) deletedAt = now
    if (status === 'active' && deletedAt !== null) deletedAt = null
    try {
      this.db.prepare('UPDATE projects SET name = ?, name_norm = ?, status = ?, started_at = ?, due_at = ?, default_matter_id = ?, notes = ?, updated_at = ?, deleted_at = ? WHERE id = ?')
        .run(name, nameNorm, status, starts, ends, matterId, notes, now, deletedAt, current.id)
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error?.message ?? error))) {
        throw entityError('E_PROJECT_DUPLICATE', 'this client already has an active project with this name', 'advisers project ls --client ' + current.clientId)
      }
      throw error
    }
    return this.getProject(current.id)
  }

  /** Soft-delete one project (idempotent). */
  archiveProject(id, { now } = {}) {
    this._assertWritable('archiveProject')
    const current = this.getProject(id)
    if (!current) throw entityError('E_PROJECT_NOT_FOUND', 'unknown project: ' + String(id))
    const at = now === undefined || now === null ? new Date().toISOString() : String(now)
    this.db.prepare("UPDATE projects SET status = 'archived', deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?").run(at, at, current.id)
    return this.getProject(current.id)
  }

  // -------------------------------------------------------------------------
  // Client notes (the manual source of the derived timeline).
  // -------------------------------------------------------------------------

  /** Resolve a project that must belong to the given client. */
  _projectForClient(projectId, clientId) {
    const project = this.getProject(String(projectId))
    if (!project) throw entityError('E_PROJECT_NOT_FOUND', 'unknown project: ' + String(projectId), 'advisers project ls')
    if (project.clientId !== clientId) throw entityError('E_PROJECT_CLIENT_MISMATCH', 'project ' + project.id + ' belongs to client ' + project.clientId)
    return project
  }

  /**
   * Record one client note (phone call, meeting, decision, ...). The summary is
   * operator prose (<= 2000 chars); source is lineage only (kind/id/quote), so a
   * note can point at a delivery or matter without copying a file or a path.
   */
  addClientNote({ clientId, projectId, matterId, kind, at, summary, source, id } = {}) {
    this._assertWritable('addClientNote')
    const client = this._clientForWrite(clientId, 'addClientNote')
    const noteKind = kind === undefined || kind === null ? 'note' : String(kind)
    if (!CLIENT_NOTE_KINDS.includes(noteKind)) {
      throw entityError('E_CLIENT_NOTE_INVALID', 'unknown note kind: ' + noteKind, 'use one of ' + CLIENT_NOTE_KINDS.join(', '))
    }
    let resolvedProjectId = null
    if (projectId !== undefined && projectId !== null) resolvedProjectId = this._projectForClient(projectId, client.id).id
    let resolvedMatterId = null
    if (matterId !== undefined && matterId !== null) {
      const matter = this.getMatter(String(matterId))
      if (!matter) throw entityError('E_MATTER_NOT_FOUND', 'unknown matter: ' + String(matterId), 'advisers matter ls')
      if (matter.clientId != null && matter.clientId !== client.id) {
        throw entityError('E_MATTER_CLIENT_MISMATCH', 'matter ' + matter.id + ' belongs to client ' + matter.clientId)
      }
      resolvedMatterId = matter.id
      if (resolvedProjectId === null && matter.projectId != null) resolvedProjectId = matter.projectId
    }
    if (typeof summary !== 'string' || !summary.trim()) throw entityError('E_CLIENT_NOTE_INVALID', 'summary is required')
    const text = summary.trim()
    if (text.length > 2000) throw entityError('E_CLIENT_NOTE_INVALID', 'summary must be at most 2000 characters')
    const noteAt = normalizeNoteInstant(at)
    const noteSource = validateNoteSource(source)
    const noteId = id === undefined || id === null ? 'note_' + randomUUID().replace(/-/g, '').slice(0, 16) : String(id).trim()
    if (!noteId) throw entityError('E_CLIENT_NOTE_INVALID', 'note id must not be empty')
    if (this.getClientNote(noteId)) throw entityError('E_CLIENT_NOTE_INVALID', 'note id already exists: ' + noteId)
    this.db.prepare('INSERT INTO client_notes(id,client_id,project_id,matter_id,kind,at,summary,source,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(noteId, client.id, resolvedProjectId, resolvedMatterId, noteKind, noteAt, text, noteSource, new Date().toISOString(), null)
    return this.getClientNote(noteId)
  }

  /** One note by id (deleted notes included; undefined when absent). */
  getClientNote(id) {
    const row = this.db.prepare('SELECT * FROM client_notes WHERE id = ?').get(String(id))
    return row ? mapClientNoteRow(row) : undefined
  }

  /**
   * Notes of one client, newest event first (at DESC, then rowid DESC so notes
   * written in one batch keep their order). Soft-deleted notes are hidden by
   * default.
   */
  listClientNotes({ clientId, projectId, matterId, includeDeleted = false, limit = 50 } = {}) {
    const where = []
    const params = []
    if (clientId !== undefined && clientId !== null) { where.push('client_id = ?'); params.push(String(clientId)) }
    if (projectId !== undefined && projectId !== null) { where.push('project_id = ?'); params.push(String(projectId)) }
    if (matterId !== undefined && matterId !== null) { where.push('matter_id = ?'); params.push(String(matterId)) }
    if (includeDeleted !== true) where.push('deleted_at IS NULL')
    const sql = 'SELECT * FROM client_notes' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY at DESC, rowid DESC LIMIT ?'
    return this.db.prepare(sql).all(...params, normalizeRowLimit(limit, { def: 50, max: 500 })).map(mapClientNoteRow)
  }

  /** Update one note; the client ownership cannot be changed, the project can. */
  updateClientNote(id, patch = {}) {
    this._assertWritable('updateClientNote')
    const current = this.getClientNote(id)
    if (!current) throw entityError('E_CLIENT_NOTE_NOT_FOUND', 'unknown note: ' + String(id))
    const allowed = ['kind', 'at', 'summary', 'projectId', 'matterId']
    for (const field of Object.keys(patch)) {
      if (!allowed.includes(field)) throw new Error('unknown client note field: ' + field)
    }
    const kind = patch.kind === undefined ? current.kind : String(patch.kind)
    if (!CLIENT_NOTE_KINDS.includes(kind)) throw entityError('E_CLIENT_NOTE_INVALID', 'unknown note kind: ' + kind, 'use one of ' + CLIENT_NOTE_KINDS.join(', '))
    const at = patch.at === undefined ? current.at : normalizeNoteInstant(patch.at)
    let summary = current.summary
    if (patch.summary !== undefined) {
      if (typeof patch.summary !== 'string' || !patch.summary.trim()) throw entityError('E_CLIENT_NOTE_INVALID', 'summary is required')
      summary = patch.summary.trim()
      if (summary.length > 2000) throw entityError('E_CLIENT_NOTE_INVALID', 'summary must be at most 2000 characters')
    }
    let projectId = current.projectId ?? null
    if (patch.projectId !== undefined) projectId = patch.projectId === null ? null : this._projectForClient(patch.projectId, current.clientId).id
    let matterId = current.matterId ?? null
    if (patch.matterId !== undefined) {
      if (patch.matterId === null) matterId = null
      else {
        const matter = this.getMatter(String(patch.matterId))
        if (!matter) throw entityError('E_MATTER_NOT_FOUND', 'unknown matter: ' + String(patch.matterId), 'advisers matter ls')
        if (matter.clientId != null && matter.clientId !== current.clientId) throw entityError('E_MATTER_CLIENT_MISMATCH', 'matter ' + matter.id + ' belongs to client ' + matter.clientId)
        matterId = matter.id
      }
    }
    this.db.prepare('UPDATE client_notes SET kind = ?, at = ?, summary = ?, project_id = ?, matter_id = ? WHERE id = ?').run(kind, at, summary, projectId, matterId, current.id)
    return this.getClientNote(current.id)
  }

  /** Soft-delete one note (idempotent; never a hard delete of user data). */
  deleteClientNote(id, { now } = {}) {
    this._assertWritable('deleteClientNote')
    const current = this.getClientNote(id)
    if (!current) throw entityError('E_CLIENT_NOTE_NOT_FOUND', 'unknown note: ' + String(id))
    if (current.deletedAt) return current
    const at = now === undefined || now === null ? new Date().toISOString() : String(now)
    this.db.prepare('UPDATE client_notes SET deleted_at = ? WHERE id = ?').run(at, current.id)
    return this.getClientNote(current.id)
  }

  // -------------------------------------------------------------------------
  // Matter ownership (client/project) + the derived timeline sources.
  // -------------------------------------------------------------------------

  /**
   * Point one matter at a client (and optionally one of that client's
   * projects), or unlink it with both null. Only this column pair is written:
   * commitments/facts stay matter-scoped, so re-linking can never leave two
   * copies of the truth behind.
   */
  setMatterClient(matterId, { clientId, projectId } = {}) {
    this._assertWritable('setMatterClient')
    const matter = this.getMatter(String(matterId))
    if (!matter) throw entityError('E_MATTER_NOT_FOUND', 'unknown matter: ' + String(matterId), 'advisers matter ls')
    let resolvedClientId = clientId === undefined || clientId === null ? null : clientId
    let resolvedProjectId = projectId === undefined || projectId === null ? null : projectId
    if (resolvedClientId === null && resolvedProjectId !== null) {
      throw entityError('E_PROJECT_CLIENT_MISMATCH', 'projectId requires clientId; a project belongs to exactly one client')
    }
    if (resolvedClientId !== null) {
      const client = this._clientForWrite(resolvedClientId, 'setMatterClient')
      resolvedClientId = client.id
      if (resolvedProjectId !== null) {
        const project = this._projectForClient(resolvedProjectId, resolvedClientId)
        if (project.status !== 'active' || project.deletedAt) throw entityError('E_PROJECT_ARCHIVED', 'project is archived: ' + project.id, 'advisers project ls')
        resolvedProjectId = project.id
      }
    }
    this.db.prepare('UPDATE matters SET client_id = ?, project_id = ?, updated_at = ? WHERE id = ?')
      .run(resolvedClientId, resolvedProjectId, new Date().toISOString(), matter.id)
    return this.getMatter(matter.id)
  }

  /** Every matter owned by one client, in insertion order (archived included). */
  listMattersByClient(clientId, { status } = {}) {
    const where = ['client_id = ?']
    const params = [String(clientId)]
    if (status !== undefined && status !== null) { where.push('status = ?'); params.push(String(status)) }
    return this.db.prepare('SELECT * FROM matters WHERE ' + where.join(' AND ') + ' ORDER BY rowid').all(...params).map(mapMatterRow)
  }

  /** Every matter owned by one project, in insertion order. */
  listMattersByProject(projectId, { status } = {}) {
    const where = ['project_id = ?']
    const params = [String(projectId)]
    if (status !== undefined && status !== null) { where.push('status = ?'); params.push(String(status)) }
    return this.db.prepare('SELECT * FROM matters WHERE ' + where.join(' AND ') + ' ORDER BY rowid').all(...params).map(mapMatterRow)
  }

  /** Matters that are not linked to any client (the honest "unclassified" view). */
  listUnclassifiedMatters({ limit = 100 } = {}) {
    return this.db.prepare('SELECT * FROM matters WHERE client_id IS NULL ORDER BY rowid LIMIT ?').all(normalizeRowLimit(limit, { def: 100, max: 1000 })).map(mapMatterRow)
  }

  /**
   * One read snapshot of everything a customer timeline is derived from.
   *
   * The caller merges these rows with packages/core/src/customer.ts
   * (deriveClientTimeline). Every query is scoped by the client's own matters,
   * so two clients can never see each other's rows: no full-table read followed
   * by an in-memory filter happens in this path. Limits bound each source (the
   * derivation applies the display limit afterwards).
   */
  clientTimelineSources(clientId, { limit = 200 } = {}) {
    const client = this.getClient(String(clientId))
    if (!client) throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + String(clientId), 'advisers client ls')
    const rowLimit = normalizeRowLimit(limit, { def: 200, max: 500 })
    const matters = this.db.prepare('SELECT * FROM matters WHERE client_id = ? ORDER BY rowid').all(client.id).map(mapMatterRow)
    const projects = this.db.prepare('SELECT * FROM projects WHERE client_id = ? ORDER BY name_norm ASC, id ASC').all(client.id).map(mapProjectRow)
    const matterIds = matters.map((matter) => matter.id)
    let commitments = []
    let deliveries = []
    if (matterIds.length) {
      const placeholders = matterIds.map(() => '?').join(',')
      commitments = this.db.prepare('SELECT * FROM commitments WHERE matter_id IN (' + placeholders + ') ORDER BY rowid DESC LIMIT ?')
        .all(...matterIds, rowLimit).map(mapCommitmentRow)
      deliveries = this.db.prepare('SELECT * FROM deliveries WHERE matter_id IN (' + placeholders + ') ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(...matterIds, rowLimit).map(mapDeliveryRow)
    }
    const notes = this.db.prepare('SELECT * FROM client_notes WHERE client_id = ? AND deleted_at IS NULL ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(client.id, rowLimit).map(mapClientNoteRow)
    return { client: client, projects: projects, matters: matters, commitments: commitments, deliveries: deliveries, notes: notes, limit: rowLimit }
  }

  /**
   * Raw rows of the SQLite-only tables carried next to a ledger export.
   *
   * The snake_case raw row shape matches what export --all has always written,
   * and DATA_TABLES is the single list of tables so an export/import helper
   * cannot silently drop the v21 customer entities.
   */
  exportDataTables(tables = DATA_TABLES) {
    const data = {}
    for (const table of tables) {
      if (!DATA_TABLES.includes(table)) throw new Error('unknown export table: ' + table)
      data[table] = this.db.prepare('SELECT * FROM ' + table).all()
    }
    return data
  }

  // -------------------------------------------------------------------------
  // Partial loading (P1-2, 0.2.2)
  //
  // Read commands no longer pay for the whole 9-table snapshot: they call the
  // per-table loaders below for the tables they actually use (today/who -> open
  // commitments, week/tick -> commitments, status -> count* only) and build a
  // partial snapshot for Ledger.fromParts. Every loader also records the row
  // ids it saw on this connection, so a later save() keeps the P1-1 merge
  // semantics: rows a loader never read are never deleted, and a partially
  // loaded ledger can be saved without truncating the tables it did not touch
  // (this is what lets 'tick' persist a snooze wake-up without touching facts).
  // -------------------------------------------------------------------------

  _selectRows(table, where = [], params = [], suffix = '') {
    const sql = 'SELECT * FROM ' + table + (where.length ? ' WHERE ' + where.join(' AND ') : '') + suffix
    return this.db.prepare(sql).all(...params)
  }

  _countRows(table, where = [], params = []) {
    const sql = 'SELECT COUNT(*) AS n FROM ' + table + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    return Number(this.db.prepare(sql).get(...params)?.n ?? 0)
  }

  /** Record the row ids this connection loaded so save() only deletes those. */
  _markLoadedRows(table, rows) {
    // A partial load after a full load() starts a fresh partial baseline: a
    // snapshot built from the partial ledger does not contain the tables the
    // full load read, and keeping the full baseline would let save() delete
    // rows that the partial snapshot simply never had. Conservative rule: a
    // save may only delete rows a loader on this connection actually read.
    if (this._fullLoad) {
      this._baselineIds = idsFor({})
      this._fullLoad = false
    }
    if (!this._baselineIds) this._baselineIds = idsFor({})
    this._baselineIds[table] = table === 'routes'
      ? new Set(Object.keys(rows ?? {}))
      : new Set((rows ?? []).map((row) => row?.id).filter((id) => id != null))
  }

  /** Load one whole ledger table by its Ledger.fromJSON table name. */
  _loadTable(table) {
    const definition = LEDGER_TABLE_LOADERS[table]
    if (!definition) throw new Error('unknown ledger table: ' + table)
    if (definition.routes) return this.loadRoutes()
    const rows = this._selectRows(definition.table).map(definition.map)
    this._markLoadedRows(table, rows)
    return rows
  }

  /** Snapshot of a subset of ledger tables (default: all of them). */
  loadSnapshot(tables = null) {
    const snapshot = { version: 1 }
    for (const table of tables ?? Object.keys(LEDGER_TABLE_LOADERS)) snapshot[table] = this._loadTable(table)
    return snapshot
  }

  loadMatters({ status } = {}) {
    const rows = status === undefined
      ? this._selectRows('matters', [], [], ' ORDER BY rowid')
      : this._selectRows('matters', ['status = ?'], [status], ' ORDER BY rowid')
    const matters = rows.map(mapMatterRow)
    this._markLoadedRows('matters', matters)
    return matters
  }

  /**
   * Load one ledger table's rows.
   *
   * 0.3.0 P0-T1: two optional knobs keep the hot read paths off the TEMP
   * B-TREE. The v20 status-leading indexes (`idx_facts_status_deleted`,
   * `idx_commitments_status_due`) cannot satisfy `ORDER BY rowid` for a
   * status predicate, so SQLite sorted every matching row into a TEMP B-TREE
   * and spilled it to disk (pet-brief wrote 29 MB per run, today 5.6 MB).
   *
   * @param {object} [options]
   * @param {boolean} [options.validOnly] facts only: `expired_at IS NULL AND
   *   deleted_at IS NULL`. With `status` also set this is an index key prefix,
   *   so rowid order comes from the index and no sort/spill happens.
   * @param {'rowid'|'natural'|'table'} [options.order='rowid'] commitments only:
   *   'rowid' keeps the historical ORDER BY rowid (may sort); 'natural' leaves
   *   the order to the plan (index order, no sort); 'table' reads the table
   *   without an index (rowid order, no sort) -- the cheapest way to keep
   *   insertion order when a predicate matches a large fraction of the table.
   */
  loadFacts({ status, matterId, includeDeleted, validOnly } = {}) {
    const where = []
    const params = []
    if (status !== undefined) { where.push('status = ?'); params.push(status) }
    if (matterId !== undefined) { where.push('matter_id = ?'); params.push(matterId) }
    if (includeDeleted === false) where.push('deleted_at IS NULL')
    if (validOnly === true) {
      where.push('expired_at IS NULL')
      if (includeDeleted !== true) where.push('deleted_at IS NULL')
    }
    const facts = this._selectRows('facts', where, params, ' ORDER BY rowid').map(mapFactRow)
    this._markLoadedRows('facts', facts)
    return facts
  }

  loadCommitments({ status, matterId, order = 'rowid' } = {}) {
    const where = []
    const params = []
    if (status !== undefined) { where.push('status = ?'); params.push(status) }
    if (matterId !== undefined) { where.push('matter_id = ?'); params.push(matterId) }
    const table = order === 'table' ? 'commitments NOT INDEXED' : 'commitments'
    const suffix = order === 'natural' || order === 'table' ? '' : ' ORDER BY rowid'
    const commitments = this._selectRows(table, where, params, suffix).map(mapCommitmentRow)
    this._markLoadedRows('commitments', commitments)
    return commitments
  }

  // -------------------------------------------------------------------------
  // 0.3.0 P0-T2: narrow read projections (2026-11-20).
  //
  // The 0.2.x views paid two costs these projections remove: mapping whole
  // entities (JSON.parse of evidence / reminder_offsets) for rows a view only
  // counts, and ORDER BY rowid after a status predicate (TEMP B-TREE spill,
  // see P0-T1 above). Each projection returns exactly the columns its view
  // reads, in table-scan order (= rowid order): a NOT INDEXED scan is
  // sequential, so it keeps the historical array order without a sort and is
  // faster than 66k index -> table lookups at 200k rows (40 ms vs 100-120 ms).
  //
  // Only status predicates are pushed to SQL. Every due-date comparison stays
  // in JS: due_at is TEXT with mixed formats (date-only / no zone / Z /
  // offsets) and JS Date.parse semantics differ from SQLite julianday() for
  // the no-zone forms, so SQL-side date filtering would change behaviour.
  // These helpers are read-only and never feed save().
  // -------------------------------------------------------------------------

  /**
   * Run a read-only projection and map rows positionally.
   * setReturnArrays skips building one object per row inside node:sqlite
   * (~25% faster at 66k rows) and the view maps only the columns it needs.
   */
  _project(sql, params, map) {
    const statement = this.db.prepare(sql)
    if (typeof statement.setReturnArrays === 'function') statement.setReturnArrays(true)
    return statement.all(...params).map(map)
  }

  /** today (human view): same minimal open-commitment rows as before. */
  projectOpenCommitmentsForToday() {
    return this._project(
      "SELECT id, debtor, creditor, action, due_at FROM commitments NOT INDEXED WHERE status = 'open'",
      [],
      (row) => ({ id: row[0], debtor: row[1], creditor: row[2], action: row[3], dueAt: row[4] ?? undefined }),
    )
  }

  /**
   * remind / tui: every row buildReminders can turn into a reminder (not
   * done/dropped, has a due_at). The due-date test itself stays in JS.
   */
  projectCommitmentsForReminders({ includeUndated = false } = {}) {
    return this._project(
      includeUndated
        ? "SELECT id, status, creditor, action, due_at, reminder_offsets FROM commitments NOT INDEXED WHERE status NOT IN ('done','dropped')"
        : "SELECT id, status, creditor, action, due_at, reminder_offsets FROM commitments NOT INDEXED WHERE status NOT IN ('done','dropped') AND due_at IS NOT NULL",
      [],
      (row) => {
        const offsets = row[5] == null ? null : parse(row[5], null)
        return {
          id: row[0], status: row[1], creditor: row[2], action: row[3], dueAt: row[4],
          ...(Array.isArray(offsets) ? { reminderOffsets: offsets } : {}),
        }
      },
    )
  }

  /** digest: the two statuses buildDigest reads, in rowid order. */
  projectCommitmentsForDigest() {
    return this._project(
      "SELECT status, action, due_at, done_at FROM commitments NOT INDEXED WHERE status IN ('open','done')",
      [],
      (row) => ({ status: row[0], action: row[1], dueAt: row[2] ?? undefined, doneAt: row[3] ?? undefined }),
    )
  }

  /**
   * pet-brief: open commitments, with hasEvidence computed in SQL.
   *
   * confidenceOfCommitment() only asks whether the parsed evidence array is
   * non-empty, so the projection answers it without shipping 66k evidence
   * JSON strings to JS. The CASE mirrors mapCommitmentRow's JSON.parse +
   * Array.isArray semantics exactly, including corrupt JSON (json_valid=0 ->
   * parse falls back to [] -> no evidence).
   */
  projectCommitmentsForPetBrief() {
    return this._project(
      "SELECT id, matter_id, creditor, action, due_at, CASE WHEN json_valid(evidence) THEN (CASE WHEN json_type(evidence) = 'array' AND json_array_length(evidence) > 0 THEN 1 ELSE 0 END) ELSE 0 END FROM commitments NOT INDEXED WHERE status = 'open'",
      [],
      (row) => ({
        id: row[0], matterId: row[1], creditor: row[2], action: row[3],
        dueAt: row[4] ?? undefined, status: 'open', hasEvidence: row[5] === 1,
      }),
    )
  }

  /**
   * pet-brief facts: the top-N confirmed facts by confidence that buildPetBrief
   * would sort and slice to. matterIds restricts to the public matters (a
   * matter-less fact is always public, matching buildPetBrief).
   */
  projectFactsForPetBrief({ limit = 10, minConfidence = 0.7, matterIds = null } = {}) {
    // listFacts() semantics: confirmed + not expired + not deleted. buildPetBrief
    // only ever sees those rows, so the projection must filter them in SQL or an
    // expired fact could displace a live one in the top-N.
    const where = ["status = 'confirmed'", 'expired_at IS NULL', 'deleted_at IS NULL', 'confidence >= ?']
    const params = [minConfidence]
    if (Array.isArray(matterIds)) {
      if (matterIds.length) {
        where.push('(matter_id IS NULL OR matter_id IN (' + matterIds.map(() => '?').join(',') + '))')
        params.push(...matterIds)
      } else {
        where.push('matter_id IS NULL')
      }
    }
    params.push(Math.max(1, Math.trunc(limit)))
    return this._project(
      'SELECT id, matter_id, subject, predicate, object, confidence FROM facts WHERE ' + where.join(' AND ') + ' ORDER BY confidence DESC, id LIMIT ?',
      params,
      (row) => ({ id: row[0], matterId: row[1] ?? undefined, subject: row[2], predicate: row[3], object: row[4], confidence: row[5] }),
    )
  }

  /** pet-brief redactor candidates: subjects of every fact listFacts() returns. */
  projectFactSubjectCandidates() {
    return this._project(
      "SELECT subject FROM facts NOT INDEXED WHERE status = 'confirmed' AND expired_at IS NULL AND deleted_at IS NULL",
      [],
      (row) => row[0],
    )
  }

  /** pet-brief redactor candidates: every commitment's creditor, all statuses. */
  projectCommitmentCreditorCandidates() {
    return this._project('SELECT DISTINCT creditor FROM commitments', [], (row) => row[0])
  }

  /**
   * MCP narrow commitment read model (0.3.2 P2-1).
   *
   * The four MCP list tools (today / commit_ls / who / remind) previously mapped
   * every commitment entity (`SELECT *` + JSON.parse per row + a Ledger Map) just
   * to drop almost all rows before serialization. This projection selects only
   * the eight columns those read models need and applies the per-item clearance
   * gate here, in rowid (insertion) order:
   *
   * - `WHERE status = 'open'` when `all` is false; every status otherwise;
   * - `NOT INDEXED` keeps the natural table/rowid order, which is exactly the
   *   order `loadCommitments()` (+ its `ORDER BY rowid`) used to produce, so the
   *   MCP output stays byte-identical;
   * - `hidden = secrecy > clearance`. The secrecy rule mirrors
   *   `lib/evidence.js` `evidenceRecordSecrecy()` exactly: no matter id -> 0, a
   *   matter id missing from the matters table -> Infinity, a null/non-finite
   *   matter secrecy -> 0/Infinity (fail closed);
   * - `reminder_offsets` is parsed only when it is a JSON array, matching
   *   `mapCommitmentRow` (remind needs the custom offsets).
   *
   * `total` is the number of scanned rows (visible + hidden); subtract
   * `protectedExcluded` for the visible count. No write, no schema/index change.
   *
   * @param {{ all?: boolean, clearance?: number }} [options]
   * @returns {{rows: Array<object>, total: number, protectedExcluded: number}}
   */
  projectCommitmentReadModel({ all = false, clearance = 0 } = {}) {
    const sql = all
      ? 'SELECT id, debtor, creditor, action, due_at, status, matter_id, reminder_offsets FROM commitments NOT INDEXED'
      : "SELECT id, debtor, creditor, action, due_at, status, matter_id, reminder_offsets FROM commitments NOT INDEXED WHERE status = 'open'"
    const statement = this.db.prepare(sql)
    if (typeof statement.setReturnArrays === 'function') statement.setReturnArrays(true)
    const raw = statement.all()
    const matterRows = this.db.prepare('SELECT id, secrecy FROM matters').all()
    const secrecyById = new Map()
    for (const matter of matterRows) secrecyById.set(matter.id, matter.secrecy)
    const numericClearance = Number(clearance)
    const level = Number.isFinite(numericClearance) && numericClearance >= 0 ? numericClearance : 0
    const rows = []
    let protectedExcluded = 0
    for (const row of raw) {
      const matterId = row[6]
      let secrecy = 0
      if (typeof matterId === 'string' && matterId) {
        if (!secrecyById.has(matterId)) {
          secrecy = Number.POSITIVE_INFINITY
        } else {
          const matterLevel = Number(secrecyById.get(matterId))
          secrecy = Number.isFinite(matterLevel) ? matterLevel : Number.POSITIVE_INFINITY
        }
      }
      const hidden = secrecy > level
      if (hidden) protectedExcluded += 1
      let offsets
      if (row[7] != null) {
        try {
          const parsed = JSON.parse(row[7])
          if (Array.isArray(parsed)) offsets = parsed
        } catch {
          // Corrupt JSON degrades to "no custom offsets", exactly like mapCommitmentRow.
        }
      }
      rows.push({
        id: row[0],
        debtor: row[1],
        creditor: row[2],
        action: row[3],
        dueAt: row[4] ?? undefined,
        status: row[5],
        matterId: row[6] ?? undefined,
        ...(offsets === undefined ? {} : { reminderOffsets: offsets }),
        hidden,
      })
    }
    return { rows, total: rows.length, protectedExcluded }
  }


  loadPreferences({ status, kind } = {}) {
    const where = []
    const params = []
    if (status !== undefined) { where.push('status = ?'); params.push(status) }
    if (kind !== undefined) { where.push('kind = ?'); params.push(kind) }
    const preferences = this._selectRows('preferences', where, params, ' ORDER BY rowid').map(mapPreferenceRow)
    this._markLoadedRows('preferences', preferences)
    return preferences
  }

  loadLinks({ status, excludeRejected } = {}) {
    const where = []
    const params = []
    if (status !== undefined) { where.push('status = ?'); params.push(status) }
    if (excludeRejected === true) where.push("status != 'rejected'")
    const links = this._selectRows('links', where, params, ' ORDER BY rowid').map(mapLinkRow)
    this._markLoadedRows('links', links)
    return links
  }

  loadUpdates({ status } = {}) {
    const rows = status === undefined
      ? this._selectRows('updates', [], [], ' ORDER BY rowid')
      : this._selectRows('updates', ['status = ?'], [status], ' ORDER BY rowid')
    const updates = rows.map(mapUpdateRow)
    this._markLoadedRows('updates', updates)
    return updates
  }

  loadRoutines({ status } = {}) {
    const rows = status === undefined
      ? this._selectRows('routines', [], [], ' ORDER BY rowid')
      : this._selectRows('routines', ['status = ?'], [status], ' ORDER BY rowid')
    const routines = rows.map(mapRoutineRow)
    this._markLoadedRows('routines', routines)
    return routines
  }

  loadRoutinePatches({ status } = {}) {
    const rows = status === undefined
      ? this._selectRows('routine_patches', [], [], ' ORDER BY rowid')
      : this._selectRows('routine_patches', ['status = ?'], [status], ' ORDER BY rowid')
    const routinePatches = rows.map(mapRoutinePatchRow)
    this._markLoadedRows('routinePatches', routinePatches)
    return routinePatches
  }

  loadRoutes() {
    const routes = Object.fromEntries(this._selectRows('routes', [], [], ' ORDER BY rowid').map((r) => [r.key, r.matter_id]))
    this._markLoadedRows('routes', routes)
    return routes
  }

  /**
   * Latest turns for one conversation (same window and order as listTurns),
   * or every turn in seq order when no conversation/limit is given.
   */
  loadTurns({ conversationId, limit } = {}) {
    const where = []
    const params = []
    if (conversationId !== undefined) { where.push('conversation_id = ?'); params.push(conversationId) }
    if (limit === undefined) return this._selectRows('turns', where, params, ' ORDER BY seq ASC').map(mapTurnRow)
    const rows = this._selectRows('turns', where, params.concat([limit]), ' ORDER BY seq DESC LIMIT ?')
    return rows.reverse().map(mapTurnRow)
  }

  /** Row counts for 'advisers status' and friends (no row mapping, no snapshot). */
  countMatters({ status } = {}) {
    return status === undefined ? this._countRows('matters') : this._countRows('matters', ['status = ?'], [status])
  }

  countFacts({ status, matterId, includeDeleted } = {}) {
    const where = []
    const params = []
    if (status !== undefined) { where.push('status = ?'); params.push(status) }
    if (matterId !== undefined) { where.push('matter_id = ?'); params.push(matterId) }
    if (includeDeleted === false) where.push('deleted_at IS NULL')
    return this._countRows('facts', where, params)
  }

  countCommitments({ status, matterId } = {}) {
    const where = []
    const params = []
    if (status !== undefined) { where.push('status = ?'); params.push(status) }
    if (matterId !== undefined) { where.push('matter_id = ?'); params.push(matterId) }
    return this._countRows('commitments', where, params)
  }

  countPreferences({ status, kind } = {}) {
    const where = []
    const params = []
    if (status !== undefined) { where.push('status = ?'); params.push(status) }
    if (kind !== undefined) { where.push('kind = ?'); params.push(kind) }
    return this._countRows('preferences', where, params)
  }

  countRoutines({ status } = {}) {
    return status === undefined ? this._countRows('routines') : this._countRows('routines', ['status = ?'], [status])
  }

  countLinks({ status, excludeRejected } = {}) {
    const where = []
    const params = []
    if (status !== undefined) { where.push('status = ?'); params.push(status) }
    if (excludeRejected === true) where.push("status != 'rejected'")
    return this._countRows('links', where, params)
  }

  countSessions() {
    return this._countRows('sessions')
  }

  countTurns({ conversationId } = {}) {
    return conversationId === undefined
      ? this._countRows('turns')
      : this._countRows('turns', ['conversation_id = ?'], [conversationId])
  }

  load() {
    const snapshot = this.loadSnapshot()
    // Remember which rows this connection has seen (P1-1): save() only deletes
    // rows this loader owned, so another process's concurrent additions are
    // merged instead of being silently overwritten by a stale snapshot. The
    // partial loaders above record the same baseline for their own tables.
    this._baselineIds = idsFor(snapshot)
    this._fullLoad = true
    return snapshot
  }

  save(snapshot) {
    this._assertWritable('save')
    return this._transaction('IMMEDIATE', () => this._saveRows(snapshot))
  }

  /**
   * Write the ledger snapshot and its audit row in one transaction, so the
   * audit trail can never claim a write that rolled back (or miss one that
   * committed). `inside` runs inside the same transaction before the audit row.
   */
  saveWithAudit(snapshot, audit, inside) {
    this._assertWritable('saveWithAudit')
    return this._transaction('IMMEDIATE', () => {
      this._saveRows(snapshot)
      if (typeof inside === 'function') inside(this)
      return this._appendAuditRow(audit)
    })
  }

  _saveRows(snapshot) {
    this._assertWritable('save')
    const db = this.db
    const newIds = idsFor(snapshot)
    const baseline = this._baselineIds
    try {
      if (baseline) {
        // P1-1: delete only rows this connection loaded that the new snapshot
        // dropped; rows another process added after our load() are kept.
        for (const [table, key] of LEDGER_TABLES) {
          const removed = [...(baseline[table] ?? [])].filter((id) => !newIds[table].has(id))
          if (!removed.length) continue
          const statement = db.prepare(`DELETE FROM ${table} WHERE ${key} = ?`)
          for (const id of removed) statement.run(id)
        }
      } else {
        // No prior load(): keep the historical full-replace semantics for
        // direct library use (e.g. importing or seeding a ledger).
        for (const [table] of LEDGER_TABLES) db.exec(`DELETE FROM ${table}`)
      }
      const m = db.prepare('INSERT OR REPLACE INTO matters(id,title,status,domain,secrecy,summary,participants,deadlines,open_questions,created_at,updated_at,client_id,project_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      for (const x of snapshot.matters ?? []) {
        m.run(x.id, x.title, x.status, x.domain, x.secrecy, x.summary ?? null, json(x.participants), json(x.deadlines), json(x.openQuestions), x.createdAt, x.updatedAt, x.clientId ?? null, x.projectId ?? null)
      }
      const f = db.prepare(`INSERT OR REPLACE INTO facts(id,matter_id,subject,predicate,object,recorded_at,expired_at,authority,confidence,source,evidence,status,valid_from,valid_to,supersedes,superseded_by,shadowed_by,last_seen_at,deleted_at,deleted_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const x of snapshot.facts ?? []) {
        f.run(x.id, x.matterId ?? null, x.subject, x.predicate, x.object, x.recordedAt, x.expiredAt ?? null, x.authority, x.confidence, x.source ? json(x.source) : null, x.evidence ? json(x.evidence) : null, x.status, x.validFrom ?? null, x.validTo ?? null, x.supersedes ?? null, x.supersededBy ?? null, x.shadowedBy ?? null, x.lastSeenAt ?? null, x.deletedAt ?? null, x.deletedReason ?? null)
      }
      const c = db.prepare(`INSERT OR REPLACE INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const x of snapshot.commitments ?? []) {
        // A missing/undefined list stays NULL so a round-trip keeps the pre-0.2.0
        // "no field" shape; an explicit [] is preserved as its own value.
        const reminderOffsets = Array.isArray(x.reminderOffsets) ? JSON.stringify(x.reminderOffsets) : null
        c.run(x.id, x.matterId, x.debtor, x.creditor, x.action, x.dueAt ?? null, x.timezone, x.status, json(x.evidence), x.capability, x.doneAt ?? null, reminderOffsets, x.createdAt ?? null)
      }
      const p = db.prepare('INSERT OR REPLACE INTO preferences VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      for (const x of snapshot.preferences ?? []) {
        p.run(x.id, x.kind, x.statement, json(x.scope), json(x.source), json(x.evidence), x.confidence, x.status, x.validFrom, x.lastConfirmed ?? null, x.expiresAt ?? null, x.priority)
      }
      const l = db.prepare('INSERT OR REPLACE INTO links VALUES (?,?,?,?,?,?,?,?,?)')
      for (const x of snapshot.links ?? []) {
        l.run(x.id, x.fromMatter, x.toMatter, x.type, x.confidence, json(x.evidence), x.status, x.createdBy, x.createdAt)
      }
      const u = db.prepare('INSERT OR REPLACE INTO updates VALUES (?,?,?,?,?,?,?)')
      for (const x of snapshot.updates ?? []) {
        u.run(x.id, x.sourceMatter, x.targetMatter, x.change, x.status, x.createdAt, x.rollback ?? null)
      }
      const r = db.prepare('INSERT OR REPLACE INTO routines VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      for (const x of snapshot.routines ?? []) {
        r.run(x.id, x.name, x.description, json(x.trigger), json(x.steps), json(x.preferences), json(x.pitfalls), json(x.verification), x.scope ?? null, x.version, x.status, x.createdBy, x.createdAt, x.updatedAt)
      }
      const rp = db.prepare('INSERT OR REPLACE INTO routine_patches VALUES (?,?,?,?,?,?,?,?)')
      for (const x of snapshot.routinePatches ?? []) {
        rp.run(x.id, x.routineId, x.baseVersion, json(x.changes), json(x.before), x.diff, x.status, x.createdAt)
      }
      const rt = db.prepare('INSERT OR REPLACE INTO routes VALUES (?,?)')
      for (const [key, matterId] of Object.entries(snapshot.routes ?? {})) rt.run(key, matterId)
      this._baselineIds = newIds
    } catch (error) {
      throw error
    }
  }

  close() {
    this.db.close()
  }
}

/**
 * Open an existing database for lock-free reads (0.2.3 read path).
 *
 * The store is read-only (DatabaseSync readOnly): no DDL, no migration, no
 * journal-mode pragmas, no HOME instance lock — so it works while a long-lived
 * writer holds the lock, reading the last committed WAL snapshot. The schema is
 * asserted up front: a stale database throws E_SCHEMA_STALE (a writable command
 * has to migrate it first) and a future one throws E_SCHEMA_NEWER. The caller
 * decides whether to fall back to the writable path (bin's openReadStore).
 *
 * @param {string} path database file
 * @param {{ checkIntegrity?: boolean, busyTimeoutMs?: number }} [options]
 * @returns {SqliteStore}
 */
export function openReadStore(path, { checkIntegrity = false, busyTimeoutMs } = {}) {
  const store = new SqliteStore(path, { readOnly: true, checkIntegrity, busyTimeoutMs })
  try {
    store.assertSchemaCurrent()
    return store
  } catch (error) {
    try { store.close() } catch {}
    throw error
  }
}
