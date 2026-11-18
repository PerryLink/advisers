import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { copyFileWithRetrySync, fsyncFileSync, rmWithRetrySync } from './fs-safe.js'

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
export const SCHEMA_VERSION = 19
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matters (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, domain TEXT NOT NULL,
  secrecy INTEGER NOT NULL, summary TEXT, participants TEXT NOT NULL, deadlines TEXT NOT NULL,
  open_questions TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
  evidence TEXT NOT NULL, capability TEXT NOT NULL, done_at TEXT, reminder_offsets TEXT
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
  files TEXT NOT NULL, tool TEXT, title TEXT, validation TEXT, created_at TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

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
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_nudges_commitment_at ON nudges(commitment_id, at);
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
`

const json = (v) => JSON.stringify(v ?? [])
const parse = (v, fallback = []) => {
  if (v == null) return fallback
  try { return JSON.parse(v) } catch { return fallback }
}

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
    report.note = 'read-only open: the WAL was inspected but not preserved; run a writable command to quarantine it'
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
    this._transactionDepth = 0
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
    report.ok = !bad(report.initial.status) && !bad(report.current.status) && report.initial.preserveError == null
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
   * Checkpoint the WAL so a copied/sealed database file is self-contained.
   * Returns busy=true when another connection prevented a full checkpoint.
   */
  checkpoint({ mode = 'TRUNCATE', retries = OPEN_RETRIES } = {}) {
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
   * The copy is verified with a read-only DatabaseSync quick_check and the
   * schema_version it was taken at; a failed verification removes the partial
   * backup and throws (fail-closed). Returns the backup path.
   */
  backupBeforeMigrate(current) {
    if (!this.path || this.path === ':memory:') return null
    const checkpoint = this.checkpoint({ mode: 'TRUNCATE' })
    if (checkpoint.busy) {
      const error = new Error(`refusing to migrate without a consistent backup of ${this.path}: could not checkpoint the WAL (another connection is busy); close other advisers processes and retry`)
      // Wave-2 Persistence v2 contract (03-design-persistence-v2.md §5.4): stable
      // code so bin/ can map it to an actionable message.
      error.code = 'E_MIGRATE_BUSY'
      throw error
    }
    const target = `${this.path}.before-migrate-v${current}-${Date.now()}`
    let backupDb = null
    try {
      copyFileWithRetrySync(this.path, target, { mode: 0o600 })
      fsyncFileSync(target)
      backupDb = new DatabaseSync(target, { readOnly: true })
      const verdict = String(backupDb.prepare('PRAGMA quick_check').get()?.quick_check ?? 'unknown')
      if (verdict !== 'ok') throw new Error(`quick_check on the backup reported '${verdict}'`)
      const meta = backupDb.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
      if (meta && Number(meta.value) !== Number(current)) {
        throw new Error(`backup contains schema_version ${meta.value}, expected ${current}`)
      }
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
   * Bring an older database up to SCHEMA_VERSION. Runs inside the caller's
   * write transaction (initializeSchema). Refuses futures schemas and keeps
   * a same-directory backup before altering an existing database.
   */
  migrate() {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    const current = row ? Number(row.value) : 0
    if (!Number.isFinite(current) || current < 0) throw new Error(`invalid schema_version in ${this.path}: ${row?.value}`)
    if (current > SCHEMA_VERSION) throw new Error(`database schema v${current} is newer than this CLI (v${SCHEMA_VERSION}); upgrade advisers before opening ${this.path}`)
    if (current >= SCHEMA_VERSION) return
    // initializeSchema() already took the verified backup before opening its
    // write transaction (a WAL checkpoint cannot run inside one); only direct
    // callers of migrate() fall back to taking it here.
    if (current > 0 && !this._migrationBackup) this._migrationBackup = this.backupBeforeMigrate(current)
    try {
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
      this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('schema_version', String(SCHEMA_VERSION))
    } catch (error) {
      throw error
    }
  }

  upsertSession({ conversationId, matterId, title }) {
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

  addDelivery({ matterId, conversationId, files, tool, title, validation }) {
    const id = `del_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    this.db.prepare('INSERT INTO deliveries(id,matter_id,conversation_id,files,tool,title,validation,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, matterId, conversationId, JSON.stringify(files ?? []), tool ?? null, title ?? null, validation ?? null, new Date().toISOString())
    return id
  }

  listDeliveries(limit = 20) {
    return this.db.prepare('SELECT * FROM deliveries ORDER BY created_at DESC LIMIT ?').all(limit)
      .map((r) => ({ id: r.id, matterId: r.matter_id, conversationId: r.conversation_id, files: parse(r.files), tool: r.tool ?? undefined, title: r.title ?? undefined, validation: r.validation ?? undefined, createdAt: r.created_at }))
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value
  }

  setMeta(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(key, String(value))
  }

  deleteMeta(key) {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key)
  }

  addTaskRun({ conversationId, matterId, task, tools, artifacts, outcome }) {
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

  purgeMatterData(matterId) {
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
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.exec('VACUUM') } catch {}
    return { sessions: Number(sessions), deliveries: Number(deliveries), turns, summaries, runs, nudges, candidates }
  }

  addTurn({ conversationId, role, content }) {
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
    return {
      has: (permitId) => Boolean(this.db.prepare('SELECT 1 FROM permit_consumed WHERE permit_id = ?').get(permitId)),
      claim: (permitId, expiresAt) => Number(this.db.prepare('INSERT OR IGNORE INTO permit_consumed(permit_id,expires_at,consumed_at) VALUES(?,?,?)').run(permitId, expiresAt, new Date().toISOString()).changes) === 1,
      prune: (now) => Number(this.db.prepare('DELETE FROM permit_consumed WHERE expires_at <= ?').run(now).changes),
    }
  }

  addResearchRun({ matterId, query, answer, sources, usage, stopReason }) {
    const id = `rr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.db.prepare('INSERT INTO research_runs(id,matter_id,query,answer,sources,usage,stop_reason,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, matterId ?? null, query, answer, JSON.stringify(sources ?? []), usage ? JSON.stringify(usage) : null, stopReason ?? null, new Date().toISOString())
    return id
  }

  listResearch(limit = 10) {
    return this.db.prepare('SELECT * FROM research_runs ORDER BY created_at DESC LIMIT ?').all(limit).map((r) => ({ id: r.id, matterId: r.matter_id ?? undefined, query: r.query, answer: r.answer, sources: JSON.parse(r.sources), usage: r.usage ? JSON.parse(r.usage) : undefined, stopReason: r.stop_reason ?? undefined, createdAt: r.created_at }))
  }

  addModelCall({ conversationId, matterId, turnId, task, model, effort, thinking, usage, durationMs, finishReason, status = 'ok', code, attempts = 1 }) {
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
    return this._transaction('IMMEDIATE', () => this._appendAuditRow({ actor, action, allowed, reason }))
  }

  _appendAuditRow({ actor, action, allowed, reason }) {
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
    this.db.prepare('INSERT OR REPLACE INTO seen_events VALUES(?,?,?,?)')
      .run(linkId, accountId, dedupeKey, new Date().toISOString())
  }

  pruneSeen(ttlDays = 7) {
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

  loadFacts({ status, matterId, includeDeleted } = {}) {
    const where = []
    const params = []
    if (status !== undefined) { where.push('status = ?'); params.push(status) }
    if (matterId !== undefined) { where.push('matter_id = ?'); params.push(matterId) }
    if (includeDeleted === false) where.push('deleted_at IS NULL')
    const facts = this._selectRows('facts', where, params, ' ORDER BY rowid').map(mapFactRow)
    this._markLoadedRows('facts', facts)
    return facts
  }

  loadCommitments({ status, matterId } = {}) {
    const where = []
    const params = []
    if (status !== undefined) { where.push('status = ?'); params.push(status) }
    if (matterId !== undefined) { where.push('matter_id = ?'); params.push(matterId) }
    const commitments = this._selectRows('commitments', where, params, ' ORDER BY rowid').map(mapCommitmentRow)
    this._markLoadedRows('commitments', commitments)
    return commitments
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
    return this._transaction('IMMEDIATE', () => this._saveRows(snapshot))
  }

  /**
   * Write the ledger snapshot and its audit row in one transaction, so the
   * audit trail can never claim a write that rolled back (or miss one that
   * committed). `inside` runs inside the same transaction before the audit row.
   */
  saveWithAudit(snapshot, audit, inside) {
    return this._transaction('IMMEDIATE', () => {
      this._saveRows(snapshot)
      if (typeof inside === 'function') inside(this)
      return this._appendAuditRow(audit)
    })
  }

  _saveRows(snapshot) {
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
      const m = db.prepare('INSERT OR REPLACE INTO matters VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      for (const x of snapshot.matters ?? []) {
        m.run(x.id, x.title, x.status, x.domain, x.secrecy, x.summary ?? null, json(x.participants), json(x.deadlines), json(x.openQuestions), x.createdAt, x.updatedAt)
      }
      const f = db.prepare(`INSERT OR REPLACE INTO facts(id,matter_id,subject,predicate,object,recorded_at,expired_at,authority,confidence,source,evidence,status,valid_from,valid_to,supersedes,superseded_by,shadowed_by,last_seen_at,deleted_at,deleted_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const x of snapshot.facts ?? []) {
        f.run(x.id, x.matterId ?? null, x.subject, x.predicate, x.object, x.recordedAt, x.expiredAt ?? null, x.authority, x.confidence, x.source ? json(x.source) : null, x.evidence ? json(x.evidence) : null, x.status, x.validFrom ?? null, x.validTo ?? null, x.supersedes ?? null, x.supersededBy ?? null, x.shadowedBy ?? null, x.lastSeenAt ?? null, x.deletedAt ?? null, x.deletedReason ?? null)
      }
      const c = db.prepare(`INSERT OR REPLACE INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const x of snapshot.commitments ?? []) {
        // A missing/undefined list stays NULL so a round-trip keeps the pre-0.2.0
        // "no field" shape; an explicit [] is preserved as its own value.
        const reminderOffsets = Array.isArray(x.reminderOffsets) ? JSON.stringify(x.reminderOffsets) : null
        c.run(x.id, x.matterId, x.debtor, x.creditor, x.action, x.dueAt ?? null, x.timezone, x.status, json(x.evidence), x.capability, x.doneAt ?? null, reminderOffsets)
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
