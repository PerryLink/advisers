import { DatabaseSync } from 'node:sqlite'
import { chmodSync, copyFileSync } from 'node:fs'
import { createHash, createHmac, randomUUID } from 'node:crypto'

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
export const SCHEMA_VERSION = 18
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
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(content, content='turns', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
END;
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

export class SqliteStore {
  constructor(path, { readOnly = false, checkIntegrity = false, busyTimeoutMs = Number(process.env.ADVISERS_SQLITE_BUSY_TIMEOUT_MS) || DEFAULT_BUSY_TIMEOUT_MS } = {}) {
    this.path = path
    this.busyTimeoutMs = busyTimeoutMs
    this._transactionDepth = 0
    this._baselineIds = null
    this.db = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path)
    // P0-1: sqlite only applies busy_timeout to statements that run after the
    // pragma is set; concurrent first-opens used to fail on journal_mode=WAL
    // because busy_timeout was set afterwards.
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(Number(busyTimeoutMs) || 0))}`)
    if (readOnly) {
      if (checkIntegrity) this.assertIntegrity()
      return
    }
    this.enableWal()
    this.db.exec('PRAGMA secure_delete = ON')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.initializeSchema()
  }

  /** Full-database integrity check; explicit because it is O(database size). */
  assertIntegrity() {
    const row = this.db.prepare('PRAGMA quick_check').get()
    const verdict = row?.quick_check ?? 'unknown'
    if (verdict !== 'ok') throw new Error(`database integrity check failed: ${verdict}`)
    return verdict
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
    this._transaction('IMMEDIATE', () => {
      this.db.exec(SCHEMA)
      this.migrate()
      // Indexes come after migrate(): some index the columns migrate() adds
      // (e.g. facts.deleted_at), so an old database must be upgraded first.
      this.db.exec(INDEXES)
    })
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

  backupBeforeMigrate(current) {
    if (!this.path || this.path === ':memory:') return
    const target = `${this.path}.before-migrate-v${current}-${Date.now()}`
    try {
      copyFileSync(this.path, target)
      try { chmodSync(target, 0o600) } catch {}
    } catch (error) {
      throw new Error(`refusing to migrate without a backup of ${this.path}: ${error.message}`)
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
    if (current > 0) this.backupBeforeMigrate(current)
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
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(content, content='turns', content_rowid='rowid')`)
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
      END`)
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END`)
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
      END`)
      try { this.db.exec("INSERT INTO turns_fts(turns_fts) VALUES('rebuild')") } catch {}
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
   * P0-2 (tick N+1 removal): the newest `limit` outcomes per commitment in one
   * query (window function over idx_nudges_commitment_at). Replaces one
   * listCommitmentNudges() round-trip per commitment.
   */
  recentNudgeOutcomes(limit = 3) {
    const rows = this.db.prepare(`SELECT commitment_id, outcome, at FROM (
        SELECT commitment_id, outcome, at, ROW_NUMBER() OVER (PARTITION BY commitment_id ORDER BY at DESC) AS rn
        FROM nudges
      ) WHERE rn <= ?`).all(limit)
    const byCommitment = new Map()
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

  sumModelUsage({ since } = {}) {
    const rows = since
      ? this.db.prepare('SELECT * FROM model_calls WHERE created_at >= ?').all(since)
      : this.db.prepare('SELECT * FROM model_calls').all()
    return rows.reduce((acc, r) => {
      acc.calls += 1
      for (const key of ['prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'cached_tokens', 'total_tokens']) acc[key] += Number(r[key] || 0)
      return acc
    }, { calls: 0, prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, total_tokens: 0 })
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

  searchTurns(query, { limit = 8 } = {}) {
    const terms = String(query || '').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2).slice(0, 8)
    if (!terms.length) return []
    const rows = this.db.prepare('SELECT * FROM turns ORDER BY created_at DESC LIMIT 2000').all()
    const score = (text) => terms.filter((t) => String(text).includes(t)).length
    return rows.map((r) => ({ id: r.id, conversationId: r.conversation_id, seq: r.seq, role: r.role, text: r.content, createdAt: r.created_at, score: score(r.content) }))
      .filter((r) => r.score > 0).sort((a, b) => b.score - a.score || Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit)
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

  searchTurns(query, { conversationId, matterId, limit = 8 } = {}) {
    const q = String(query ?? '').trim()
    if (!q) return []
    const clauses = []
    const filterArgs = []
    if (conversationId) { clauses.push('t.conversation_id = ?'); filterArgs.push(conversationId) }
    if (matterId) { clauses.push('s.matter_id = ?'); filterArgs.push(matterId) }
    const join = matterId ? ' JOIN sessions s ON s.conversation_id = t.conversation_id' : ''
    const where = clauses.length ? ` AND ${clauses.join(' AND ')}` : ''
    try {
      if (q.length >= 3) {
        const rows = this.db.prepare(`SELECT t.* FROM turns_fts f JOIN turns t ON t.rowid = f.rowid${join} WHERE turns_fts MATCH ?${where} ORDER BY rank LIMIT ?`).all(q, ...filterArgs, limit)
        if (rows.length) return rows.map((r) => ({ id: r.id, conversationId: r.conversation_id, seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at }))
      }
    } catch {}
    const rows = this.db.prepare(`SELECT t.* FROM turns t${join} WHERE t.content LIKE ?${where} ORDER BY t.seq DESC LIMIT ?`).all(`%${q}%`, ...filterArgs, limit)
    return rows.reverse().map((r) => ({ id: r.id, conversationId: r.conversation_id, seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at }))
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

  load() {
    const all = (sql) => this.db.prepare(sql).all()
    const snapshot = {
      version: 1,
      matters: all('SELECT * FROM matters').map((r) => ({
        id: r.id, title: r.title, status: r.status, domain: r.domain, secrecy: r.secrecy,
        summary: r.summary ?? undefined, participants: parse(r.participants), deadlines: parse(r.deadlines),
        openQuestions: parse(r.open_questions), createdAt: r.created_at, updatedAt: r.updated_at,
      })),
      facts: all('SELECT * FROM facts').map((r) => ({
        id: r.id, matterId: r.matter_id ?? undefined, subject: r.subject, predicate: r.predicate,
        object: r.object, recordedAt: r.recorded_at, expiredAt: r.expired_at ?? undefined,
        authority: r.authority, confidence: r.confidence,
        source: r.source ? parse(r.source, undefined) : undefined,
        evidence: r.evidence ? parse(r.evidence, undefined) : undefined,
        status: r.status, validFrom: r.valid_from ?? undefined, validTo: r.valid_to ?? undefined,
        supersedes: r.supersedes ?? undefined, supersededBy: r.superseded_by ?? undefined,
        shadowedBy: r.shadowed_by ?? undefined, lastSeenAt: r.last_seen_at ?? undefined,
        deletedAt: r.deleted_at ?? undefined, deletedReason: r.deleted_reason ?? undefined,
      })),
      commitments: all('SELECT * FROM commitments').map((r) => {
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
      }),
      preferences: all('SELECT * FROM preferences').map((r) => ({
        id: r.id, kind: r.kind, statement: r.statement, scope: parse(r.scope, {}),
        source: parse(r.source, {}), evidence: parse(r.evidence), confidence: r.confidence,
        status: r.status, validFrom: r.valid_from, lastConfirmed: r.last_confirmed ?? undefined,
        expiresAt: r.expires_at ?? undefined, priority: r.priority,
      })),
      links: all('SELECT * FROM links').map((r) => ({
        id: r.id, fromMatter: r.from_matter, toMatter: r.to_matter, type: r.type,
        confidence: r.confidence, evidence: parse(r.evidence), status: r.status,
        createdBy: r.created_by, createdAt: r.created_at,
      })),
      updates: all('SELECT * FROM updates').map((r) => ({
        id: r.id, sourceMatter: r.source_matter, targetMatter: r.target_matter, change: r.change,
        status: r.status, createdAt: r.created_at, rollback: r.rollback ?? undefined,
      })),
      routines: all('SELECT * FROM routines').map((r) => ({
        id: r.id, name: r.name, description: r.description, trigger: parse(r.trigger),
        steps: parse(r.steps), preferences: parse(r.preferences), pitfalls: parse(r.pitfalls),
        verification: parse(r.verification), scope: r.scope ?? undefined, version: r.version,
        status: r.status, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
      })),
      routinePatches: all('SELECT * FROM routine_patches').map((r) => ({
        id: r.id, routineId: r.routine_id, baseVersion: r.base_version,
        changes: parse(r.changes, {}), before: parse(r.before, {}), diff: r.diff, status: r.status, createdAt: r.created_at,
      })),
      routes: Object.fromEntries(all('SELECT * FROM routes').map((r) => [r.key, r.matter_id])),
    }
    // Remember which rows this connection has seen (P1-1): save() only deletes
    // rows this loader owned, so another process's concurrent additions are
    // merged instead of being silently overwritten by a stale snapshot.
    this._baselineIds = idsFor(snapshot)
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
