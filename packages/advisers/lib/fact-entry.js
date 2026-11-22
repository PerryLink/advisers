/**
 * Manual fact entry for the SQLite ledger (0.4.x, write side of the facts table).
 *
 * The audit finding this closes: before this module a user could not record a
 * fact directly -- facts only arrived as agent/mail candidates plus `memory
 * accept`. This module is the library layer only: the caller owns HOME handling,
 * migration, CLI output and the model. There is no model call, no console output,
 * no table creation and no network here.
 *
 * Contract:
 * - subject/predicate/object are required, non-empty, single-line and length
 *   capped (FACT_ENTRY_LIMITS); a quote is required evidence for a manual fact
 *   (evidence: [{ quote, source? }] -- the repo SourceRef shape);
 * - the written row is always a user-authority confirmed fact:
 *   authority='user', status='confirmed', confidence=1, recordedAt=now,
 *   validFrom=input.validFrom ?? now, id='fact_'+16 hex chars;
 * - every write goes through store.mutate(): insertFact (plus the optional
 *   supersede update / KB link insert) and exactly one audit row commit or roll
 *   back together. A rejected or deduped call writes no facts row and no audit
 *   row (invariant I1, and `fact add` must not claim a write that did not happen);
 * - duplicate semantics (explicit, idempotent): the same ACTIVE fact -- same
 *   subject/predicate/matter/object with status='confirmed', expired_at IS NULL
 *   and deleted_at IS NULL -- is returned unchanged as
 *   { ok:true, fact, deduped:true }. The check runs inside the same BEGIN
 *   IMMEDIATE as the insert, so two writers can never both insert it. Evidence
 *   is NOT merged and recordedAt is NOT refreshed: a repeat entry is the same
 *   assertion, not a new observation. Different objects/identities are new rows;
 *   pass `supersedes` to replace the current fact for one identity;
 * - optional `supersedes: factId` replaces the current fact for the same
 *   subject/predicate/matter: the new row carries facts.supersedes and the old
 *   row becomes status='superseded', supersededBy=new.id, validTo=new.validFrom,
 *   expiredAt=now (the core applyRemember supersede shape). A fact is not a
 *   "relation" in this repo -- the relation vocabulary below is the KB link
 *   vocabulary -- so the supersede target is a separate input;
 * - optional `relation: 'source'|'mentions'` + `docId` writes one explicit
 *   fact <-> KB document link (kb_fact_links; the same vocabulary as lib/kb.js
 *   KB_RELATIONS and `kb link --relation`). docId without relation defaults to
 *   'source' (the kbLink default); relation without docId is rejected. This is
 *   provenance only: the quote is never copied into the KB;
 * - audit rows carry ids/counts only (never the quote, subject, predicate or
 *   object), matching the other write paths.
 */
import { randomBytes } from 'node:crypto'
import { entityError } from './sqlite.js'
import { stripBidiControls, stripControlChars, stripTerminalSequences } from './text-safe.js'

/** Relations accepted by a fact <-> KB document link (mirrors KB_RELATIONS). */
export const FACT_ENTRY_RELATIONS = Object.freeze(['source', 'mentions'])
/** Audit action of one committed manual fact entry. */
export const FACT_ENTRY_ACTION = 'fact.add'
/** Input caps (code points for text, UTF-8 bytes for the evidence source). */
export const FACT_ENTRY_LIMITS = Object.freeze({
  subject: 200,
  predicate: 200,
  object: 2000,
  quote: 500,
  sourceBytes: 2048,
})

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const FACT_ID_RE = /^fact_[0-9a-f]{16}$/

/**
 * Control-flow signal: the duplicate row is thrown from inside mutate() so the
 * BEGIN IMMEDIATE rolls back before mutate() would append the audit row. It
 * never escapes factAdd(); the caller only ever sees the deduped result.
 */
class DuplicateFactSignal extends Error {
  constructor(fact) {
    super('fact entry duplicate')
    this.name = 'DuplicateFactSignal'
    this.fact = fact
  }
}

function assertStore(store) {
  if (!store || typeof store !== 'object' || typeof store.db?.prepare !== 'function') {
    throw new TypeError('fact entry requires an opened SqliteStore')
  }
  for (const method of ['mutate', 'insertFact', 'updateFact', 'getFact', 'getMatter']) {
    if (typeof store[method] !== 'function') {
      throw new TypeError('fact entry requires a writable SqliteStore (missing ' + method + ')')
    }
  }
}

/** Sanitize one operator-entered identity field / quote into a single safe line. */
function singleLine(value, field, max) {
  if (typeof value !== 'string') throw entityError('E_USAGE', 'fact ' + field + ' must be a string')
  const text = stripControlChars(stripBidiControls(stripTerminalSequences(value)), { keepNewlines: false, keepTabs: false, replacement: ' ' })
    .replace(/\s+/gu, ' ')
    .trim()
  if (!text) throw entityError('E_USAGE', 'fact ' + field + ' is required and must not be empty')
  const chars = Array.from(text)
  if (chars.length > max) {
    throw entityError('E_USAGE', 'fact ' + field + ' is too long (' + chars.length + ' > ' + max + ' characters)')
  }
  return text
}

/** Optional evidence provenance object: stored verbatim as JSON, bounded in size. */
function normalizeSource(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw entityError('E_USAGE', 'evidence source must be a plain object')
  }
  let text
  try { text = JSON.stringify(value) } catch {
    throw entityError('E_USAGE', 'evidence source must be JSON-serializable')
  }
  if (typeof text !== 'string') throw entityError('E_USAGE', 'evidence source must be a plain object')
  if (Buffer.byteLength(text, 'utf8') > FACT_ENTRY_LIMITS.sourceBytes) {
    throw entityError('E_USAGE', 'evidence source is too large (max ' + FACT_ENTRY_LIMITS.sourceBytes + ' bytes)')
  }
  const clone = JSON.parse(text)
  if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) {
    throw entityError('E_USAGE', 'evidence source must be a plain object')
  }
  return clone
}

function normalizeMatterId(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw entityError('E_USAGE', 'matterId must be a string')
  const id = value.trim()
  return id || null
}

function normalizeSupersedes(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw entityError('E_USAGE', 'supersedes must be a fact id string')
  const id = value.trim()
  if (!id) throw entityError('E_USAGE', 'supersedes must be a non-empty fact id')
  return id
}

function normalizeNow(value) {
  if (value === undefined || value === null) return new Date().toISOString()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw entityError('E_USAGE', 'now must be a valid date')
  return date.toISOString()
}

/** validFrom: an ISO instant normalized to UTC, a date-only string kept as-is
 * (the ledger reads YYYY-MM-DD as the Asia/Shanghai day start), or absent. */
function normalizeValidFrom(value) {
  if (value === undefined || value === null) return null
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw entityError('E_USAGE', 'validFrom is not a valid date')
    return value.toISOString()
  }
  if (typeof value !== 'string') {
    throw entityError('E_USAGE', 'validFrom must be an ISO 8601 date/datetime or a Date')
  }
  const text = value.trim()
  if (!text) return null
  if (DATE_ONLY_RE.test(text)) {
    const parsed = Date.parse(text + 'T00:00:00.000Z')
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== text) {
      throw entityError('E_USAGE', 'validFrom is not a valid calendar date: ' + text)
    }
    return text
  }
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) {
    throw entityError('E_USAGE', 'validFrom is not a valid ISO 8601 instant: ' + text)
  }
  return new Date(parsed).toISOString()
}

/**
 * Optional relation link. Returns null (no link), { docId, relation } otherwise.
 * The relation vocabulary is the KB link vocabulary; a supersede is NOT passed
 * here (see the header) because the repo models it as facts.supersedes.
 */
function normalizeLink(input) {
  const relationRaw = input.relation
  const docRaw = input.docId
  const hasRelation = relationRaw !== undefined && relationRaw !== null && String(relationRaw).trim() !== ''
  const docId = docRaw === undefined || docRaw === null ? '' : String(docRaw).trim()
  if (!hasRelation && !docId) return null
  if (!hasRelation) return { docId, relation: 'source' }
  const relation = String(relationRaw).trim()
  if (!FACT_ENTRY_RELATIONS.includes(relation)) {
    throw entityError('E_KB_INVALID', 'unknown relation: ' + relation, 'use one of ' + FACT_ENTRY_RELATIONS.join(', ') + '; to replace an older fact pass supersedes')
  }
  if (!docId) throw entityError('E_USAGE', 'relation requires a docId (a link is stored per KB document)')
  return { docId, relation }
}

/** The ledger's definition of the current row for one identity (same rule as
 * SqliteStore.findFactCurrent; predicate 'said' is only special there for
 * supersede bookkeeping, manual entry dedupes it like any other identity). */
function findActiveFact(store, { subject, predicate, matterId, object }) {
  const row = store.db.prepare(
    "SELECT id FROM facts WHERE status = 'confirmed' AND expired_at IS NULL AND deleted_at IS NULL" +
    ' AND subject = ? AND predicate = ? AND (matter_id IS ?) AND object = ? ORDER BY rowid LIMIT 1',
  ).get(subject, predicate, matterId, object)
  return row ? store.getFact(row.id) : undefined
}

/** Fail closed when the optional KB link target is absent, stale or not active. */
function assertLinkTarget(store, { docId, relation }) {
  const hasTable = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kb_fact_links'").get()
  if (!hasTable) {
    throw entityError('E_SCHEMA_STALE', 'fact <-> document links need the v22 schema (kb_fact_links is missing)', 'upgrade the ledger and run advisers doctor')
  }
  const doc = store.db.prepare('SELECT id, status, deleted_at FROM kb_documents WHERE id = ?').get(docId)
  if (!doc || doc.status !== 'active' || doc.deleted_at !== null) {
    throw entityError('E_KB_NOT_FOUND', 'unknown document: ' + docId, 'advisers kb ls')
  }
  return relation
}

function newFactId() {
  return 'fact_' + randomBytes(8).toString('hex')
}

/**
 * Record one manually entered fact and return the persisted row.
 *
 * @param {object} store an opened writable SqliteStore
 * @param {{subject: string, predicate: string, object: string, quote: string,
 *          source?: object, matterId?: string, validFrom?: string|Date,
 *          relation?: 'source'|'mentions', docId?: string,
 *          supersedes?: string}} input
 * @param {{now?: string|Date}} [options] injectable clock (tests/imports)
 * @returns {{ok: true, fact: object, deduped: boolean, audit: object|null}}
 */
export function factAdd(store, input = {}, options = {}) {
  assertStore(store)
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw entityError('E_USAGE', 'fact input must be an object')
  }
  const opts = options && typeof options === 'object' ? options : {}
  const recordedAt = normalizeNow(opts.now)
  const subject = singleLine(input.subject, 'subject', FACT_ENTRY_LIMITS.subject)
  const predicate = singleLine(input.predicate, 'predicate', FACT_ENTRY_LIMITS.predicate)
  const object = singleLine(input.object, 'object', FACT_ENTRY_LIMITS.object)
  const quote = singleLine(input.quote, 'quote', FACT_ENTRY_LIMITS.quote)
  const source = normalizeSource(input.source)
  const matterId = normalizeMatterId(input.matterId)
  const validFrom = normalizeValidFrom(input.validFrom) ?? recordedAt
  const link = normalizeLink(input)
  const supersedesId = normalizeSupersedes(input.supersedes)
  const id = newFactId()
  if (!FACT_ID_RE.test(id)) throw new Error('generated fact id is malformed: ' + id)
  const audit = { actor: 'local', action: FACT_ENTRY_ACTION, allowed: true, reason: id }
  let outcome
  try {
    outcome = store.mutate((s) => {
      const existing = findActiveFact(s, { subject, predicate, matterId, object })
      if (existing) throw new DuplicateFactSignal(existing)
      if (matterId !== null && !s.getMatter(matterId)) {
        throw entityError('E_MATTER_NOT_FOUND', 'unknown matter: ' + matterId, 'advisers matter ls')
      }
      let previous = null
      if (supersedesId !== null) {
        previous = s.getFact(supersedesId)
        if (!previous || previous.deletedAt !== undefined) {
          throw entityError('E_FACT_NOT_FOUND', 'unknown fact: ' + supersedesId, 'advisers fact ls')
        }
        if (previous.status !== 'confirmed' || previous.expiredAt !== undefined) {
          throw entityError('E_USAGE', 'cannot supersede fact ' + supersedesId + ': it is not an active confirmed fact (status=' + previous.status + ')', 'only the current confirmed fact for the same identity can be superseded')
        }
        const sameMatter = (previous.matterId ?? null) === matterId
        if (previous.subject !== subject || previous.predicate !== predicate || !sameMatter) {
          throw entityError('E_USAGE', 'cannot supersede fact ' + supersedesId + ': subject/predicate/matter differ from this entry', 'a supersede replaces the current fact for the same subject/predicate/matter')
        }
      }
      if (link !== null) assertLinkTarget(s, link)
      const row = {
        id,
        ...(matterId === null ? {} : { matterId }),
        subject,
        predicate,
        object,
        recordedAt,
        authority: 'user',
        confidence: 1,
        evidence: [{ quote, ...(source === null ? {} : { source }) }],
        status: 'confirmed',
        validFrom,
        ...(previous === null ? {} : { supersedes: previous.id }),
      }
      s.insertFact(row)
      if (previous !== null) {
        s.updateFact(previous.id, { status: 'superseded', supersededBy: id, validTo: validFrom, expiredAt: recordedAt })
      }
      if (link !== null) {
        s.db.prepare('INSERT OR REPLACE INTO kb_fact_links(fact_id, doc_id, chunk_id, relation, created_at) VALUES(?,?,?,?,?)')
          .run(id, link.docId, null, link.relation, recordedAt)
      }
      audit.reason = id +
        (matterId === null ? '' : ' matter ' + matterId) +
        (previous === null ? '' : ' supersedes ' + previous.id) +
        (link === null ? '' : ' link ' + link.docId + ' (' + link.relation + ')')
      const stored = s.getFact(id)
      if (!stored) throw new Error('fact ' + id + ' was not persisted')
      return stored
    }, audit)
  } catch (error) {
    if (error instanceof DuplicateFactSignal) {
      return { ok: true, fact: error.fact, deduped: true, audit: null }
    }
    throw error
  }
  return { ok: true, fact: outcome.result, deduped: false, audit: outcome.audit }
}

/** Alias matching the file name; the repo's other write modules use <entity>Add. */
export const factEntry = factAdd

export default Object.freeze({
  FACT_ENTRY_RELATIONS,
  FACT_ENTRY_ACTION,
  FACT_ENTRY_LIMITS,
  factAdd,
  factEntry,
})
