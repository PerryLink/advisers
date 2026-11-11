import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'

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
  evidence TEXT NOT NULL, capability TEXT NOT NULL, done_at TEXT
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
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, task TEXT NOT NULL,
  tools TEXT NOT NULL, artifacts TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nudges (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, local_day TEXT NOT NULL, level TEXT NOT NULL,
  commitment_id TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending', outcome_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

const json = (v) => JSON.stringify(v ?? [])
const parse = (v, fallback = []) => {
  if (v == null) return fallback
  try { return JSON.parse(v) } catch { return fallback }
}

export class SqliteStore {
  constructor(path) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.migrate()
  }

  migrate() {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    const current = row ? Number(row.value) : 0
    if (current >= 14) return
    this.db.exec('BEGIN')
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
      const factCols = this.db.prepare('PRAGMA table_info(facts)').all().map((c) => c.name)
      for (const [name, type] of [['valid_from','TEXT'],['valid_to','TEXT'],['expired_at','TEXT'],['evidence','TEXT'],['supersedes','TEXT'],['superseded_by','TEXT'],['shadowed_by','TEXT'],['last_seen_at','TEXT'],['deleted_at','TEXT'],['deleted_reason','TEXT']]) {
        if (!factCols.includes(name)) this.db.exec(`ALTER TABLE facts ADD COLUMN ${name} ${type}`)
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, task TEXT NOT NULL,
  tools TEXT NOT NULL, artifacts TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nudges (
        id TEXT PRIMARY KEY, at TEXT NOT NULL, local_day TEXT NOT NULL, level TEXT NOT NULL,
        commitment_id TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, body TEXT NOT NULL
      )`)
      const nudgeCols = this.db.prepare('PRAGMA table_info(nudges)').all().map((c) => c.name)
      if (!nudgeCols.includes('outcome')) this.db.exec("ALTER TABLE nudges ADD COLUMN outcome TEXT NOT NULL DEFAULT 'pending'")
      if (!nudgeCols.includes('outcome_at')) this.db.exec('ALTER TABLE nudges ADD COLUMN outcome_at TEXT')
      this.db.exec(`CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, task TEXT NOT NULL,
        tools TEXT NOT NULL, artifacts TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL
      )`)
      this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('schema_version', '14')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
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

  addTaskRun({ conversationId, task, tools, artifacts, outcome }) {
    const id = `run_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    this.db.prepare('INSERT INTO task_runs(id,conversation_id,task,tools,artifacts,outcome,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, conversationId, task, json(tools), json(artifacts), outcome, new Date().toISOString())
    return id
  }

  listTaskRuns(limit = 20) {
    return this.db.prepare('SELECT * FROM task_runs ORDER BY created_at DESC LIMIT ?').all(limit)
      .map((r) => ({ id: r.id, conversationId: r.conversation_id, task: r.task, tools: parse(r.tools), artifacts: parse(r.artifacts), outcome: r.outcome, createdAt: r.created_at }))
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

  listNudges(limit = 20) {
    return this.db.prepare('SELECT * FROM nudges ORDER BY at DESC LIMIT ?').all(limit)
  }

  purgeMatterData(matterId) {
    const conversations = this.db.prepare('SELECT conversation_id FROM sessions WHERE matter_id = ?').all(matterId).map((r) => r.conversation_id)
    let turns = 0
    for (const conversationId of conversations) {
      turns += Number(this.db.prepare('DELETE FROM turns WHERE conversation_id = ?').run(conversationId).changes)
      this.db.prepare('DELETE FROM session_summaries WHERE conversation_id = ?').run(conversationId)
    }
    const sessions = this.db.prepare('DELETE FROM sessions WHERE matter_id = ?').run(matterId).changes
    const deliveries = this.db.prepare('DELETE FROM deliveries WHERE matter_id = ?').run(matterId).changes
    return { sessions: Number(sessions), deliveries: Number(deliveries), turns }
  }

  addTurn({ conversationId, role, content }) {
    const seq = (this.db.prepare('SELECT MAX(seq) AS n FROM turns WHERE conversation_id = ?').get(conversationId)?.n ?? 0) + 1
    const id = `turn_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    this.db.prepare('INSERT INTO turns(id,conversation_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, conversationId, seq, role, content, new Date().toISOString())
    return { id, conversationId, seq, role, content, createdAt: new Date().toISOString() }
  }

  listTurns(conversationId, limit = 50) {
    return this.db.prepare('SELECT * FROM turns WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?').all(conversationId, limit)
      .map((r) => ({ id: r.id, conversationId: r.conversation_id, seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at }))
      .reverse()
  }

  searchTurns(query, { conversationId, limit = 8 } = {}) {
    const q = String(query ?? '').trim()
    if (!q) return []
    const where = conversationId ? ' AND t.conversation_id = ?' : ''
    const args = conversationId ? [q, conversationId, limit] : [q, limit]
    try {
      if (q.length >= 3) {
        const rows = this.db.prepare(`SELECT t.* FROM turns_fts f JOIN turns t ON t.rowid = f.rowid WHERE turns_fts MATCH ?${where} ORDER BY rank LIMIT ?`).all(...args)
        if (rows.length) return rows.map((r) => ({ id: r.id, conversationId: r.conversation_id, seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at }))
      }
    } catch {}
    const likeArgs = conversationId ? [`%${q}%`, conversationId, limit] : [`%${q}%`, limit]
    const rows = this.db.prepare(`SELECT t.* FROM turns t WHERE t.content LIKE ?${where.replace('t.', 't.')} ORDER BY t.seq DESC LIMIT ?`).all(...likeArgs)
    return rows.reverse().map((r) => ({ id: r.id, conversationId: r.conversation_id, seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at }))
  }

  getSessionSummary(conversationId) {
    const r = this.db.prepare('SELECT * FROM session_summaries WHERE conversation_id = ?').get(conversationId)
    return r ? { conversationId: r.conversation_id, summary: r.summary, throughSeq: r.through_seq, updatedAt: r.updated_at } : undefined
  }

  upsertSessionSummary({ conversationId, summary, throughSeq }) {
    this.db.prepare(`INSERT INTO session_summaries(conversation_id,summary,through_seq,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET summary=excluded.summary, through_seq=excluded.through_seq, updated_at=excluded.updated_at`)
      .run(conversationId, summary, throughSeq, new Date().toISOString())
  }

  countDeliveries() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n
  }

  appendAudit({ actor, action, allowed, reason }) {
    const last = this.db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get()
    const prev = last?.hash ?? ''
    const at = new Date().toISOString()
    const material = `${prev}\n${at}\n${actor}\n${action}\n${allowed ? 1 : 0}\n${reason ?? ''}`
    const hash = createHash('sha256').update(material).digest('hex')
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
      const expected = createHash('sha256').update(material).digest('hex')
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
    return {
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
      commitments: all('SELECT * FROM commitments').map((r) => ({
        id: r.id, matterId: r.matter_id, debtor: r.debtor, creditor: r.creditor, action: r.action,
        dueAt: r.due_at ?? undefined, timezone: r.timezone, status: r.status,
        evidence: parse(r.evidence), capability: r.capability, doneAt: r.done_at ?? undefined,
      })),
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
  }

  save(snapshot) {
    const db = this.db
    db.exec('BEGIN')
    try {
      for (const table of ['matters', 'facts', 'commitments', 'preferences', 'links', 'updates', 'routines', 'routine_patches', 'routes']) {
        db.exec(`DELETE FROM ${table}`)
      }
      const m = db.prepare('INSERT INTO matters VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      for (const x of snapshot.matters ?? []) {
        m.run(x.id, x.title, x.status, x.domain, x.secrecy, x.summary ?? null, json(x.participants), json(x.deadlines), json(x.openQuestions), x.createdAt, x.updatedAt)
      }
      const f = db.prepare(`INSERT INTO facts(id,matter_id,subject,predicate,object,recorded_at,expired_at,authority,confidence,source,evidence,status,valid_from,valid_to,supersedes,superseded_by,shadowed_by,last_seen_at,deleted_at,deleted_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const x of snapshot.facts ?? []) {
        f.run(x.id, x.matterId ?? null, x.subject, x.predicate, x.object, x.recordedAt, x.expiredAt ?? null, x.authority, x.confidence, x.source ? json(x.source) : null, x.evidence ? json(x.evidence) : null, x.status, x.validFrom ?? null, x.validTo ?? null, x.supersedes ?? null, x.supersededBy ?? null, x.shadowedBy ?? null, x.lastSeenAt ?? null, x.deletedAt ?? null, x.deletedReason ?? null)
      }
      const c = db.prepare('INSERT INTO commitments VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      for (const x of snapshot.commitments ?? []) {
        c.run(x.id, x.matterId, x.debtor, x.creditor, x.action, x.dueAt ?? null, x.timezone, x.status, json(x.evidence), x.capability, x.doneAt ?? null)
      }
      const p = db.prepare('INSERT INTO preferences VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      for (const x of snapshot.preferences ?? []) {
        p.run(x.id, x.kind, x.statement, json(x.scope), json(x.source), json(x.evidence), x.confidence, x.status, x.validFrom, x.lastConfirmed ?? null, x.expiresAt ?? null, x.priority)
      }
      const l = db.prepare('INSERT INTO links VALUES (?,?,?,?,?,?,?,?,?)')
      for (const x of snapshot.links ?? []) {
        l.run(x.id, x.fromMatter, x.toMatter, x.type, x.confidence, json(x.evidence), x.status, x.createdBy, x.createdAt)
      }
      const u = db.prepare('INSERT INTO updates VALUES (?,?,?,?,?,?,?)')
      for (const x of snapshot.updates ?? []) {
        u.run(x.id, x.sourceMatter, x.targetMatter, x.change, x.status, x.createdAt, x.rollback ?? null)
      }
      const r = db.prepare('INSERT INTO routines VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      for (const x of snapshot.routines ?? []) {
        r.run(x.id, x.name, x.description, json(x.trigger), json(x.steps), json(x.preferences), json(x.pitfalls), json(x.verification), x.scope ?? null, x.version, x.status, x.createdBy, x.createdAt, x.updatedAt)
      }
      const rp = db.prepare('INSERT INTO routine_patches VALUES (?,?,?,?,?,?,?,?)')
      for (const x of snapshot.routinePatches ?? []) {
        rp.run(x.id, x.routineId, x.baseVersion, json(x.changes), json(x.before), x.diff, x.status, x.createdAt)
      }
      const rt = db.prepare('INSERT INTO routes VALUES (?,?)')
      for (const [key, matterId] of Object.entries(snapshot.routes ?? {})) rt.run(key, matterId)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  close() {
    this.db.close()
  }
}
