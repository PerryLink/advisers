/**
 * Context pack candidates (0.5.0 / WF3 050-C2, docs 122 section 3.2).
 *
 * Pure read layer: given an ALREADY OPENED SqliteStore and a subject
 * ('client:<id>' or 'matter:<id>') it derives the candidate rows a context
 * pack may disclose. It never writes, never opens a connection and never
 * touches HOME; bin/advisers.js owns flag parsing, TOS and rendering.
 *
 * Frozen rules (0.5.0 context pack manifest v1):
 * - scope is SQL-derived from the subject: a client sees only its own
 *   matters, a matter sees only itself. No full-table read followed by an
 *   in-memory filter of another client's rows.
 * - packable kinds are commitment (status open), fact (confirmed and not
 *   expired/deleted/superseded), preference (confirmed and not expired) and
 *   delivery METADATA (title/tool/template/createdAt; never files, bytes or
 *   paths). notes are counted as unsupportedKind and never returned.
 * - effective secrecy = max(client.secrecyDefault, matter.secrecy). Rows above
 *   the clearance are filtered BEFORE counting/paging; they are only counted
 *   in excluded.byReason.secrecy and no id/title is returned.
 * - excluded byReason precedence is secrecy > stale > unsupportedKind >
 *   notFound, so the counts add up and never double count. Tombsones
 *   (fact.deleted_at) are not candidates at all and are not counted.
 * - ordering reuses the frozen customer timeline order: instant DESC, then
 *   delivery < note < commitment < fact, then id ASC. note is reserved but
 *   never emitted; preference (not on the timeline) sorts after fact using
 *   lastConfirmed ?? validFrom. Two runs over the same rows are byte-identical.
 * - view/verification are computed at read time with the frozen evidence
 *   resolver (lib/evidence.js): verified/pending are LOCAL resolution labels
 *   ('the pointer resolved against this ledger'), never a truth claim.
 *
 * This module must not import lib/context-pack.js: the pack builder imports
 * this module (one direction only) so the format whitelist stays in one file.
 */

import { evidenceDescriptor, evidenceKindOf, resolveEvidenceSource } from './evidence.js'
import { entityError } from './sqlite.js'

/* -------------------------------------------------------------------------- */
/* constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Subject kinds a 0.5.0 context pack can be assembled for. */
export const CONTEXT_PACK_SUBJECT_KINDS = Object.freeze(['client', 'matter'])
/** Candidate kinds emitted by the assembler, in timeline rank order. */
export const CONTEXT_CANDIDATE_KINDS = Object.freeze(['delivery', 'commitment', 'fact', 'preference'])
/** Default --candidate-limit (rows returned; the totals stay exact). */
export const CONTEXT_CANDIDATE_LIMIT_DEFAULT = 50
/** Hard cap for one candidate page. */
export const CONTEXT_CANDIDATE_LIMIT_MAX = 200
/** Stable codes shared with the pack builder and the CLI error surface. */
export const CONTEXT_CANDIDATE_ERRORS = Object.freeze({
  invalid: 'E_CONTEXT_PACK_INVALID',
  notFound: 'E_CONTEXT_PACK_ENTRY_NOT_FOUND',
  stale: 'E_CONTEXT_PACK_ENTRY_STALE',
  secrecy: 'E_CONTEXT_PACK_SECRECY_BLOCKED',
  unsupported: 'E_CONTEXT_PACK_UNSUPPORTED_KIND',
})
/** Reason keys of disclosure.excluded.byReason, in the documented order. */
export const CONTEXT_EXCLUSION_REASONS = Object.freeze(['secrecy', 'stale', 'unsupportedKind', 'notFound'])

const TITLE_MAX = 120
const DAY_MS = 86400_000
/** Frozen customer timeline kind order (packages/core/src/customer.ts). */
const KIND_RANK = Object.freeze({ delivery: 0, note: 1, commitment: 2, fact: 3, preference: 4 })
/** Hard per-source row cap: a candidate page never hydrates an unbounded set. */
const MAX_SOURCE_ROWS = 1000
const PREFERENCE_CURRENT = "status = 'confirmed' AND (expires_at IS NULL OR expires_at = '' OR julianday(expires_at) > julianday(?))"
const FACT_CURRENT = "status = 'confirmed' AND expired_at IS NULL AND deleted_at IS NULL AND superseded_by IS NULL AND shadowed_by IS NULL"

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function fail(code, message, hint) {
  return entityError(code, message, hint)
}

function invalid(message, hint) {
  return fail(CONTEXT_CANDIDATE_ERRORS.invalid, message, hint)
}

function normalizeClearance(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.floor(number)
}

/** Clamp --candidate-limit like the customer read limits (never errors). */
export function normalizeContextCandidateLimit(value) {
  if (value === undefined || value === null) return CONTEXT_CANDIDATE_LIMIT_DEFAULT
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) return CONTEXT_CANDIDATE_LIMIT_DEFAULT
  return Math.min(number, CONTEXT_CANDIDATE_LIMIT_MAX)
}

/** Single-line display title (max 120 chars), never a file path. */
function timelineTitle(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  if (!text) return ''
  const chars = Array.from(text)
  if (chars.length <= TITLE_MAX) return text
  return chars.slice(0, TITLE_MAX - 1).join('') + '\u2026'
}

function instantOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

function isoOrNull(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  return Number.isFinite(Date.parse(value)) ? value.trim() : null
}

/** Accept '180d' / '12h' / '30m' or an ISO instant; null means no cutoff. */
function parseSince(value, nowMs) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim()
  const match = /^(\d+)(d|h|m)$/i.exec(text)
  if (match) {
    const amount = Number(match[1])
    const unit = match[2].toLowerCase()
    const unitMs = unit === 'd' ? DAY_MS : unit === 'h' ? 3600_000 : 60_000
    if (!Number.isFinite(amount) || amount < 1) throw invalid('--since must be a positive duration like 180d', 'pass ISO time or a duration of days/hours/minutes')
    return Math.max(0, nowMs - amount * unitMs)
  }
  const ms = instantOf(text)
  if (ms === null) throw invalid('--since must be an ISO timestamp or a duration like 180d', 'examples: --since 180d, --since 2026-01-01T00:00:00Z')
  return ms
}

function inClause(values) {
  return values.map(() => '?').join(',')
}

function countRows(store, sql, params = []) {
  const row = store.db.prepare(sql).get(...params)
  return Number(row?.n ?? 0)
}

function finiteSecrecy(value) {
  if (value === undefined || value === null) return 0
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : Number.POSITIVE_INFINITY
}

/** max(client.secrecyDefault, matter.secrecy); dirty data fails closed. */
function effectiveMatterSecrecy(client, matter) {
  const clientLevel = client ? finiteSecrecy(client.secrecyDefault) : 0
  const matterLevel = matter ? finiteSecrecy(matter.secrecy) : 0
  if (!Number.isFinite(clientLevel) || !Number.isFinite(matterLevel)) return Number.POSITIVE_INFINITY
  return Math.max(clientLevel, matterLevel)
}

function clientDefaultSecrecy(client) {
  return client ? finiteSecrecy(client.secrecyDefault) : 0
}

/** JSON text helper for rows read with raw SQL. */
function parseJsonField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function stringOf(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/** The customer-read store contract (customer tables are SQLite-only). */
function assertSqliteStore(store) {
  if (!store || typeof store.read !== 'function' || !store.db || typeof store.db.prepare !== 'function'
    || typeof store.getClient !== 'function' || typeof store.getMatter !== 'function'
    || typeof store.listMattersByClient !== 'function' || typeof store.listProjects !== 'function'
    || typeof store.getCommitment !== 'function' || typeof store.getFact !== 'function'
    || typeof store.getPreference !== 'function') {
    throw fail('E_STORE', 'context pack candidates require an opened SQLite store (customer tables are SQLite-only)', 'run advisers init and point ADVISERS_HOME at the SQLite home; JSON ledger mode has no context pack candidates')
  }
}

/* -------------------------------------------------------------------------- */
/* subject                                                                    */
/* -------------------------------------------------------------------------- */

/** Parse 'client:<id>' / 'matter:<id>' / {kind,id} into a frozen subject. */
export function normalizeContextPackSubject(input) {
  let kind = ''
  let id = ''
  if (typeof input === 'string') {
    const text = input.trim()
    const index = text.indexOf(':')
    if (index <= 0) throw invalid('subject must be client:<id> or matter:<id>', 'examples: --subject client:cl_wang, --subject matter:m_website')
    kind = text.slice(0, index).trim().toLowerCase()
    id = text.slice(index + 1).trim()
  } else if (isPlainObject(input)) {
    kind = stringOf(input.kind).trim().toLowerCase()
    id = stringOf(input.id).trim()
  } else {
    throw invalid('subject must be client:<id> or matter:<id>')
  }
  if (!CONTEXT_PACK_SUBJECT_KINDS.includes(kind)) {
    throw invalid('unsupported context pack subject kind: ' + (kind || '(empty)'), '0.5.0 supports client and matter subjects only')
  }
  if (!id) throw invalid('subject id is required', 'examples: --subject client:cl_wang')
  if (Array.from(id).length > 200) throw invalid('subject id is too long')
  if (/[\u0000-\u001f\u007f]/.test(id)) throw invalid('subject id contains control characters')
  return Object.freeze({ kind, id })
}

/* -------------------------------------------------------------------------- */
/* scope (one read snapshot)                                                  */
/* -------------------------------------------------------------------------- */

function resolveScopeInSnapshot(store, subjectInput, options) {
  const subject = normalizeContextPackSubject(subjectInput)
  const clearance = normalizeClearance(options?.clearance)
  const now = options?.now === undefined || options?.now === null ? Date.now() : Number(options.now)
  const nowMs = Number.isFinite(now) ? now : Date.now()
  let client
  let matter
  let mattersAll
  if (subject.kind === 'client') {
    client = store.getClient(subject.id)
    if (!client) throw fail(CONTEXT_CANDIDATE_ERRORS.notFound, 'unknown client subject: ' + subject.id, 'advisers client ls')
    if (client.status !== 'active' || client.deletedAt) throw fail(CONTEXT_CANDIDATE_ERRORS.stale, 'client ' + subject.id + ' is archived; an archived client is not a context pack subject', 'restore the client or pick an active one')
    mattersAll = store.listMattersByClient(client.id)
  } else {
    matter = store.getMatter(subject.id)
    if (!matter) throw fail(CONTEXT_CANDIDATE_ERRORS.notFound, 'unknown matter subject: ' + subject.id, 'advisers matter ls')
    if (matter.status === 'archived') throw fail(CONTEXT_CANDIDATE_ERRORS.stale, 'matter ' + subject.id + ' is archived; an archived matter is not a context pack subject', 'pick an active matter')
    client = matter.clientId ? store.getClient(matter.clientId) : undefined
    mattersAll = [matter]
  }
  const projects = subject.kind === 'client'
    ? store.listProjects({ clientId: client.id, status: 'all', includeDeleted: true, limit: 1000 })
    : []
  const activeProjects = projects.filter((project) => project.status === 'active' && !project.deletedAt)
  const allMatterIds = mattersAll.map((row) => row.id)
  const allMatterById = new Map(mattersAll.map((row) => [row.id, row]))
  const protectedMatterIds = mattersAll.filter((row) => effectiveMatterSecrecy(client, row) > clearance).map((row) => row.id)
  const archivedMatterIds = mattersAll.filter((row) => row.status === 'archived' && effectiveMatterSecrecy(client, row) <= clearance).map((row) => row.id)
  const visibleMatters = mattersAll.filter((row) => row.status !== 'archived' && effectiveMatterSecrecy(client, row) <= clearance)
  const visibleMatterIds = visibleMatters.map((row) => row.id)
  const allProjectIds = subject.kind === 'client' ? activeProjects.map((row) => row.id) : []
  const clientProtected = subject.kind === 'client' && clientDefaultSecrecy(client) > clearance
  // A protected client hides its project-scoped preferences too: they leave the
  // candidate scope and are counted as secrecy (allProjectIds keeps the count).
  const projectIds = clientProtected ? [] : allProjectIds
  return {
    subject: { kind: subject.kind, id: subject.id, name: timelineTitle(subject.kind === 'client' ? client.name : matter.title) },
    kind: subject.kind,
    client: client ?? null,
    matter: matter ?? null,
    mattersAll,
    allMatterIds,
    allMatterById,
    visibleMatters,
    visibleMatterIds,
    protectedMatterIds,
    archivedMatterIds,
    projectIds,
    allProjectIds,
    clientProtected,
    clearance,
    nowMs,
    nowIso: new Date(nowMs).toISOString(),
  }
}

/** Resolve the candidate scope in its own read snapshot (read-only). */
export function resolveContextPackSubjectScope(store, subject, options = {}) {
  assertSqliteStore(store)
  return store.read(() => resolveScopeInSnapshot(store, subject, options))
}

/* -------------------------------------------------------------------------- */
/* current-row filters (shared by listing and exact counting)                 */
/* -------------------------------------------------------------------------- */

function currentSinceClause(column, sinceMs) {
  return sinceMs === null ? { sql: '', params: [] } : { sql: column + ' >= ?', params: [new Date(sinceMs).toISOString()] }
}

function matterIdsWhere(column, ids) {
  if (!ids.length) return null
  return { sql: column + ' IN (' + inClause(ids) + ')', params: [...ids] }
}

/** Preference scope clause for a set of matter ids and project ids. */
function preferenceScopeClause(matterIds, projectIds) {
  const parts = []
  const params = []
  if (matterIds.length) {
    parts.push("(json_extract(scope, '$.level') = 'matter' AND json_extract(scope, '$.value') IN (" + inClause(matterIds) + '))')
    params.push(...matterIds)
  }
  if (projectIds.length) {
    parts.push("(json_extract(scope, '$.level') = 'project' AND json_extract(scope, '$.value') IN (" + inClause(projectIds) + '))')
    params.push(...projectIds)
  }
  if (!parts.length) return null
  return { sql: '(' + parts.join(' OR ') + ')', params }
}

function andWhere(...clauses) {
  const parts = []
  const params = []
  for (const clause of clauses) {
    if (!clause || !clause.sql) continue
    parts.push(clause.sql)
    params.push(...clause.params)
  }
  return parts.length ? { sql: parts.join(' AND '), params } : { sql: '1 = 1', params: [] }
}

function countWhere(store, table, where) {
  return countRows(store, 'SELECT COUNT(*) AS n FROM ' + table + ' WHERE ' + where.sql, where.params)
}

/* -------------------------------------------------------------------------- */
/* exact exclusion counts (disclosure.excluded)                               */
/* -------------------------------------------------------------------------- */

function factsAlive(ids) {
  return matterIdsWhere('matter_id', ids)
}

function factCurrentWhere(ids, sinceMs) {
  const scope = matterIdsWhere('matter_id', ids)
  if (!scope) return null
  return andWhere(scope, { sql: FACT_CURRENT, params: [] }, currentSinceClause('recorded_at', sinceMs))
}

function factStaleWhere(ids) {
  const scope = matterIdsWhere('matter_id', ids)
  if (!scope) return null
  return andWhere(scope, { sql: 'deleted_at IS NULL', params: [] }, { sql: 'NOT (' + FACT_CURRENT + ')', params: [] })
}

function commitmentCurrentWhere(ids, sinceMs) {
  const scope = matterIdsWhere('matter_id', ids)
  if (!scope) return null
  return andWhere(scope, { sql: "status = 'open'", params: [] }, currentSinceClause('created_at', sinceMs))
}

function commitmentStaleWhere(ids) {
  const scope = matterIdsWhere('matter_id', ids)
  if (!scope) return null
  return andWhere(scope, { sql: "status <> 'open'", params: [] })
}

function deliveryCurrentWhere(ids, sinceMs) {
  const scope = matterIdsWhere('matter_id', ids)
  if (!scope) return null
  return andWhere(scope, currentSinceClause('created_at', sinceMs))
}

function preferenceCurrentWhere(scope, sinceMs) {
  const scoped = preferenceScopeClause(scope.visibleMatterIds, scope.projectIds)
  if (!scoped) return null
  return andWhere(scoped, { sql: PREFERENCE_CURRENT, params: [scope.nowIso] }, currentSinceClause("COALESCE(NULLIF(last_confirmed, ''), valid_from)", sinceMs))
}

function preferenceStaleWhere(matterIds, projectIds, nowIso) {
  const scoped = preferenceScopeClause(matterIds, projectIds)
  if (!scoped) return null
  return andWhere(scoped, {
    sql: "(status <> 'confirmed' OR (expires_at IS NOT NULL AND expires_at <> '' AND (julianday(expires_at) IS NULL OR julianday(expires_at) <= julianday(?))))",
    params: [nowIso],
  })
}

function allScopedPreferenceWhere(matterIds, projectIds) {
  return preferenceScopeClause(matterIds, projectIds)
}

function noteAlive(ids, clientId, includeClientLevel) {
  const parts = []
  const params = []
  if (ids.length) {
    parts.push('matter_id IN (' + inClause(ids) + ')')
    params.push(...ids)
  }
  if (includeClientLevel && clientId) {
    parts.push('(matter_id IS NULL AND client_id = ?)')
    params.push(clientId)
  }
  if (!parts.length) return null
  return { sql: 'deleted_at IS NULL AND (' + parts.join(' OR ') + ')', params }
}

/** Exact disclosure counts; nothing here returns ids or content. */
function computeExcludedCounts(store, scope) {
  const { nowIso, visibleMatterIds, archivedMatterIds, protectedMatterIds, projectIds, clientProtected, kind } = scope
  const clientId = scope.client ? scope.client.id : null
  const byReason = { secrecy: 0, stale: 0, unsupportedKind: 0, notFound: 0 }

  // secrecy has priority over every other reason
  if (protectedMatterIds.length) {
    byReason.secrecy += countWhere(store, 'commitments', { sql: 'matter_id IN (' + inClause(protectedMatterIds) + ')', params: protectedMatterIds })
    const aliveFacts = factsAlive(protectedMatterIds)
    byReason.secrecy += countWhere(store, 'facts', andWhere(aliveFacts, { sql: 'deleted_at IS NULL', params: [] }))
    byReason.secrecy += countWhere(store, 'deliveries', { sql: 'matter_id IN (' + inClause(protectedMatterIds) + ')', params: protectedMatterIds })
    const prefScope = allScopedPreferenceWhere(protectedMatterIds, [])
    if (prefScope) byReason.secrecy += countWhere(store, 'preferences', prefScope)
    const notes = noteAlive(protectedMatterIds, null, false)
    if (notes) byReason.secrecy += countWhere(store, 'client_notes', notes)
  }
  if (clientProtected) {
    // Matter-scoped preferences were already counted with the protected
    // matters; a protected client additionally hides its project-scoped
    // preferences, client-level notes and orphan deliveries (no id returned).
    const prefProjects = allScopedPreferenceWhere([], scope.allProjectIds)
    if (prefProjects) byReason.secrecy += countWhere(store, 'preferences', prefProjects)
    if (clientId) {
      byReason.secrecy += countRows(store, 'SELECT COUNT(*) AS n FROM client_notes WHERE deleted_at IS NULL AND matter_id IS NULL AND client_id = ?', [clientId])
      const allIds = scope.allMatterIds
      const orphan = allIds.length
        ? '(matter_id IS NULL OR matter_id NOT IN (' + inClause(allIds) + '))'
        : '(matter_id IS NULL OR 1 = 1)'
      byReason.secrecy += countRows(store, 'SELECT COUNT(*) AS n FROM deliveries WHERE client_id = ? AND ' + orphan, [clientId, ...allIds])
    }
  }

  // stale: archived matters (whole rows) + non-current rows in visible matters
  if (archivedMatterIds.length) {
    const archived = { sql: 'matter_id IN (' + inClause(archivedMatterIds) + ')', params: archivedMatterIds }
    byReason.stale += countWhere(store, 'commitments', archived)
    byReason.stale += countWhere(store, 'facts', andWhere(archived, { sql: 'deleted_at IS NULL', params: [] }))
    byReason.stale += countWhere(store, 'deliveries', archived)
    const prefArchived = allScopedPreferenceWhere(archivedMatterIds, [])
    if (prefArchived) byReason.stale += countWhere(store, 'preferences', prefArchived)
    const notes = noteAlive(archivedMatterIds, null, false)
    if (notes) byReason.stale += countWhere(store, 'client_notes', notes)
  }
  const staleCommitments = commitmentStaleWhere(visibleMatterIds)
  if (staleCommitments) byReason.stale += countWhere(store, 'commitments', staleCommitments)
  const staleFacts = factStaleWhere(visibleMatterIds)
  if (staleFacts) byReason.stale += countWhere(store, 'facts', staleFacts)
  const stalePreferences = preferenceStaleWhere(visibleMatterIds, projectIds, nowIso)
  if (stalePreferences) byReason.stale += countWhere(store, 'preferences', stalePreferences)

  // unsupportedKind: notes (v1 packs ledger rows only; note bodies are never read)
  const unsupportedNotes = noteAlive(visibleMatterIds, clientProtected ? null : clientId, !clientProtected && kind === 'client')
  if (unsupportedNotes) byReason.unsupportedKind += countWhere(store, 'client_notes', unsupportedNotes)

  // notFound: a delivery whose generation-time client snapshot points at this
  // client but whose matter cannot be resolved inside the subject scope.
  if (!clientProtected && kind === 'client' && clientId) {
    const allIds = scope.allMatterIds
    const conditions = allIds.length
      ? '(matter_id IS NULL OR matter_id NOT IN (' + inClause(allIds) + '))'
      : '(matter_id IS NULL OR 1 = 1)'
    byReason.notFound += countRows(store, 'SELECT COUNT(*) AS n FROM deliveries WHERE client_id = ? AND ' + conditions, [clientId, ...allIds])
  }

  const total = byReason.secrecy + byReason.stale + byReason.unsupportedKind + byReason.notFound
  return { total, byReason }
}

/* -------------------------------------------------------------------------- */
/* evidence resolution -> candidate view/verification                         */
/* -------------------------------------------------------------------------- */

function evidenceItemsForEntity(kind, entity) {
  const items = Array.isArray(entity?.evidence) ? entity.evidence : []
  const out = []
  for (const item of items) if (item && typeof item === 'object') out.push(item)
  if (kind === 'fact' || kind === 'preference') {
    const source = entity?.source
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      const hasPointer = typeof source.ref === 'string' && source.ref.length > 0
      const hasQuote = typeof source.quote === 'string' && source.quote.length > 0
      if (hasPointer || hasQuote) out.push(source)
    }
  }
  return out
}

/** First verbatim quote on the row (only fact/preference may disclose it). */
function quoteForEntity(kind, entity) {
  if (kind !== 'fact' && kind !== 'preference') return null
  for (const item of evidenceItemsForEntity(kind, entity)) {
    if (typeof item.quote === 'string' && item.quote.trim()) return item.quote
  }
  return null
}

/** Frozen evidence resolver tally; honest empty buckets for delivery rows. */
function verificationOfEntity(store, kind, entity) {
  const buckets = { resolved: 0, missing: 0, unverifiable: 0, notChecked: 0 }
  if (kind !== 'delivery') {
    for (const item of evidenceItemsForEntity(kind, entity)) {
      const result = resolveEvidenceSource(store, item)
      if (result.resolution === 'verified') buckets.resolved += 1
      else if (result.resolution === 'missing') buckets.missing += 1
      else if (result.resolution === 'unverifiable') buckets.unverifiable += 1
      else buckets.notChecked += 1
    }
  }
  return { basis: 'local-resolution', ...buckets }
}

/** view mapping (frozen 0.5.0 labels; verified = LOCAL resolution only). */
function viewOf(kind, entity, verification) {
  if (kind === 'commitment') {
    if (entity.status !== 'open') return 'historical'
    return verification.resolved > 0 ? 'verified' : 'pending'
  }
  if (kind === 'fact' || kind === 'preference') {
    if (entity.status !== 'confirmed') return 'historical'
    return verification.resolved > 0 ? 'verified' : 'pending'
  }
  // A delivery is a finished event: the row itself is historical metadata.
  return 'historical'
}

/* -------------------------------------------------------------------------- */
/* records (internal: entity + quote are never serialized)                    */
/* -------------------------------------------------------------------------- */

function makeRecord(kind, entity, store) {
  const verification = verificationOfEntity(store, kind, entity)
  let at = null
  let title = ''
  if (kind === 'commitment') {
    at = isoOrNull(entity.createdAt)
    title = timelineTitle(entity.action) || String(entity.id)
  } else if (kind === 'fact') {
    at = isoOrNull(entity.recordedAt)
    title = timelineTitle(stringOf(entity.subject) + ' ' + stringOf(entity.predicate)) || String(entity.id)
  } else if (kind === 'preference') {
    at = isoOrNull(entity.lastConfirmed) ?? isoOrNull(entity.validFrom)
    title = timelineTitle(entity.statement) || String(entity.id)
  } else {
    at = isoOrNull(entity.createdAt)
    title = timelineTitle(entity.title) || timelineTitle(entity.tool) || String(entity.id)
  }
  return {
    ref: String(entity.id),
    kind,
    title,
    at,
    atMs: instantOf(at),
    view: viewOf(kind, entity, verification),
    verification,
    selectable: true,
    quote: quoteForEntity(kind, entity),
    entity,
  }
}

function publicCandidate(record) {
  return {
    ref: record.ref,
    kind: record.kind,
    title: record.title,
    at: record.at,
    view: record.view,
    verification: record.verification,
    selectable: record.selectable,
  }
}

/** Frozen candidate order (also used when an explicit --ids list is sorted). */
export function compareContextCandidateRecords(left, right) {
  const a = left.atMs
  const b = right.atMs
  if (a === null && b === null) return left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0
  if (a === null) return 1
  if (b === null) return -1
  if (a !== b) return b - a
  const rank = KIND_RANK[left.kind] - KIND_RANK[right.kind]
  if (rank !== 0) return rank
  return left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0
}

/* -------------------------------------------------------------------------- */
/* raw row access                                                             */
/* -------------------------------------------------------------------------- */

function rawRow(store, table, id) {
  return store.db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(String(id))
}

/** Delivery mapped field subset (the store has no public delivery getter). */
function deliveryEntity(store, id) {
  const row = rawRow(store, 'deliveries', id)
  if (!row) return undefined
  return {
    id: row.id,
    matterId: row.matter_id,
    title: row.title === null || row.title === undefined ? undefined : row.title,
    tool: row.tool === null || row.tool === undefined ? undefined : row.tool,
    templateName: row.template_name === null || row.template_name === undefined ? undefined : row.template_name,
    createdAt: row.created_at,
  }
}

function preferenceScopeOf(entity) {
  if (!isPlainObject(entity?.scope)) return { level: '', value: '' }
  return { level: stringOf(entity.scope.level), value: stringOf(entity.scope.value) }
}

/** Which pack row a ledger id denotes; notes/mail/KB kinds are unsupported. */
function kindOfId(id) {
  const text = String(id)
  if (text.startsWith('cm_')) return 'commitment'
  if (text.startsWith('fact_')) return 'fact'
  if (text.startsWith('pref_')) return 'preference'
  if (text.startsWith('del_')) return 'delivery'
  if (text.startsWith('note_')) return 'note'
  if (/^(note_|mail_|mail:|imap_|imap:|eml_|eml:|msg_|kb_|kb:|kb_chunk:|kb_page:|page_|doc_|turn_|web:|tool:|calendar:|transcript:|ledger:)/i.test(text)) return 'unsupported'
  return 'unknown'
}

function throwUnsupported(id) {
  throw fail(CONTEXT_CANDIDATE_ERRORS.unsupported, 'kind of ' + String(id) + ' is not packable in context pack v1', 'v1 packs commitments, facts, preferences and delivery metadata; KB/mail/note bodies stay local')
}

/** Owned-matter check for one row; throws the documented selection error. */
function assertMatterInScope(scope, matterId) {
  const matter = matterId === null || matterId === undefined ? undefined : scope.allMatterById.get(String(matterId))
  if (!matter) throw fail(CONTEXT_CANDIDATE_ERRORS.notFound, 'record is outside the subject scope', 'select a candidate returned by --subject, or widen the subject')
  if (effectiveMatterSecrecy(scope.client, matter) > scope.clearance) {
    throw fail(CONTEXT_CANDIDATE_ERRORS.secrecy, 'record belongs to a protected matter (effective secrecy above the clearance)', 'lower the matter/client secrecy locally or pick another record')
  }
  if (matter.status === 'archived') throw fail(CONTEXT_CANDIDATE_ERRORS.stale, 'record belongs to an archived matter', 'archived matters are not context pack candidates')
  return matter
}

function assertPreferenceInScope(scope, entity) {
  const scoped = preferenceScopeOf(entity)
  if (scoped.level === 'matter') {
    const matter = assertMatterInScope(scope, scoped.value)
    return effectiveMatterSecrecy(scope.client, matter) > scope.clearance
  }
  if (scoped.level === 'project' && scope.kind === 'client' && scope.projectIds.includes(scoped.value)) {
    if (scope.clientProtected) {
      throw fail(CONTEXT_CANDIDATE_ERRORS.secrecy, 'record belongs to a protected client (effective secrecy above the clearance)', 'lower the client secrecy locally or pick another record')
    }
    return false
  }
  throw fail(CONTEXT_CANDIDATE_ERRORS.notFound, 'preference scope is outside the subject scope', 'global/audience preferences are not packable in v1; select a matter- or project-scoped preference')
}

/**
 * Load one selected id as a packable record (fail closed, no silent skips).
 * Exported for the pack builder; bin never calls it directly.
 */
export function loadContextCandidateForSelection({ store, subject, id, scope = null, now = Date.now(), clearance = 0 }) {
  assertSqliteStore(store)
  const key = typeof id === 'string' ? id.trim() : ''
  if (!key) throw invalid('an item id is required')
  const kind = kindOfId(key)
  if (kind === 'note' || kind === 'unsupported') throwUnsupported(key)
  if (kind === 'unknown') throw fail(CONTEXT_CANDIDATE_ERRORS.notFound, 'unknown context pack item id: ' + key, 'v1 item ids start with cm_, fact_, pref_ or del_')
  return store.read(() => {
    const resolved = scope ?? resolveScopeInSnapshot(store, subject, { clearance, now })
    if (kind === 'commitment') {
      const entity = store.getCommitment(key)
      if (!entity) throw fail(CONTEXT_CANDIDATE_ERRORS.notFound, 'unknown commitment: ' + key)
      assertMatterInScope(resolved, entity.matterId)
      if (entity.status !== 'open') throw fail(CONTEXT_CANDIDATE_ERRORS.stale, 'commitment ' + key + ' is ' + String(entity.status) + ', not open', 'only open commitments are packable')
      return makeRecord('commitment', entity, store)
    }
    if (kind === 'fact') {
      const entity = store.getFact(key)
      if (!entity) throw fail(CONTEXT_CANDIDATE_ERRORS.notFound, 'unknown fact: ' + key)
      assertMatterInScope(resolved, entity.matterId)
      if (entity.status !== 'confirmed' || entity.expiredAt || entity.deletedAt || entity.supersededBy || entity.shadowedBy) {
        throw fail(CONTEXT_CANDIDATE_ERRORS.stale, 'fact ' + key + ' is not current', 'only confirmed, unexpired and non-superseded facts are packable')
      }
      return makeRecord('fact', entity, store)
    }
    if (kind === 'preference') {
      const entity = store.getPreference(key)
      if (!entity) throw fail(CONTEXT_CANDIDATE_ERRORS.notFound, 'unknown preference: ' + key)
      assertPreferenceInScope(resolved, entity)
      const expiry = instantOf(entity.expiresAt)
      const expired = expiry !== null && expiry <= resolved.nowMs
      const malformedExpiry = entity.expiresAt !== undefined && entity.expiresAt !== null && entity.expiresAt !== '' && expiry === null
      if (entity.status !== 'confirmed' || expired || malformedExpiry) {
        throw fail(CONTEXT_CANDIDATE_ERRORS.stale, 'preference ' + key + ' is not current', 'only confirmed, unexpired preferences are packable')
      }
      return makeRecord('preference', entity, store)
    }
    const entity = deliveryEntity(store, key)
    if (!entity) throw fail(CONTEXT_CANDIDATE_ERRORS.notFound, 'unknown delivery: ' + key)
    assertMatterInScope(resolved, entity.matterId)
    return makeRecord('delivery', entity, store)
  })
}

/* -------------------------------------------------------------------------- */
/* candidate collection                                                       */
/* -------------------------------------------------------------------------- */

function emptyByKind() {
  const byKind = {}
  for (const kind of CONTEXT_CANDIDATE_KINDS) byKind[kind] = 0
  return byKind
}

function collectCurrentEntries(store, scope, sinceMs) {
  const entries = []
  const visibleIds = scope.visibleMatterIds
  const nowIso = scope.nowIso
  if (visibleIds.length) {
    const commitmentWhere = commitmentCurrentWhere(visibleIds, sinceMs)
    const rows = store.db.prepare("SELECT id, action, created_at FROM commitments WHERE " + commitmentWhere.sql + " ORDER BY created_at DESC, rowid DESC LIMIT " + MAX_SOURCE_ROWS).all(...commitmentWhere.params)
    for (const row of rows) entries.push({ kind: 'commitment', id: String(row.id), at: isoOrNull(row.created_at), title: timelineTitle(row.action) })
    const factWhere = factCurrentWhere(visibleIds, sinceMs)
    const factRows = store.db.prepare("SELECT id, subject, predicate, recorded_at FROM facts WHERE " + factWhere.sql + " ORDER BY recorded_at DESC, rowid DESC LIMIT " + MAX_SOURCE_ROWS).all(...factWhere.params)
    for (const row of factRows) entries.push({ kind: 'fact', id: String(row.id), at: isoOrNull(row.recorded_at), title: timelineTitle(stringOf(row.subject) + ' ' + stringOf(row.predicate)) })
    const deliveryWhere = deliveryCurrentWhere(visibleIds, sinceMs)
    const deliveryRows = store.db.prepare("SELECT id, title, tool, created_at FROM deliveries WHERE " + deliveryWhere.sql + " ORDER BY created_at DESC, rowid DESC LIMIT " + MAX_SOURCE_ROWS).all(...deliveryWhere.params)
    for (const row of deliveryRows) entries.push({ kind: 'delivery', id: String(row.id), at: isoOrNull(row.created_at), title: timelineTitle(row.title) || timelineTitle(row.tool) })
  }
  const preferenceWhere = preferenceCurrentWhere(scope, sinceMs)
  if (preferenceWhere) {
    const rows = store.db.prepare("SELECT id, statement, last_confirmed, valid_from FROM preferences WHERE " + preferenceWhere.sql + " ORDER BY rowid DESC LIMIT " + MAX_SOURCE_ROWS).all(...preferenceWhere.params)
    for (const row of rows) entries.push({
      kind: 'preference',
      id: String(row.id),
      at: isoOrNull(row.last_confirmed) ?? isoOrNull(row.valid_from),
      title: timelineTitle(row.statement),
    })
  }
  return entries
}

function hydrateEntry(store, entry) {
  if (entry.kind === 'commitment') {
    const entity = store.getCommitment(entry.id)
    return entity ? makeRecord('commitment', entity, store) : null
  }
  if (entry.kind === 'fact') {
    const entity = store.getFact(entry.id)
    return entity ? makeRecord('fact', entity, store) : null
  }
  if (entry.kind === 'preference') {
    const entity = store.getPreference(entry.id)
    return entity ? makeRecord('preference', entity, store) : null
  }
  const entity = deliveryEntity(store, entry.id)
  return entity ? makeRecord('delivery', entity, store) : null
}

/**
 * Assemble the subject's candidates in one read snapshot.
 *
 * @returns {{subject:{kind,id,name}, generatedAt:string, candidates:object[],
 *            counts:object, excluded:object, records?:object[]}}
 */
export function collectContextCandidates({ store, subject, limit, since, now, clearance, scope = null, withRecords = false } = {}) {
  assertSqliteStore(store)
  const pageLimit = normalizeContextCandidateLimit(limit)
  return store.read(() => {
    const resolved = scope ?? resolveScopeInSnapshot(store, subject, { clearance, now })
    const sinceMs = parseSince(since, resolved.nowMs)
    const excluded = computeExcludedCounts(store, resolved)
    const currentCommitments = resolved.visibleMatterIds.length ? countWhere(store, 'commitments', commitmentCurrentWhere(resolved.visibleMatterIds, sinceMs)) : 0
    const currentFacts = resolved.visibleMatterIds.length ? countWhere(store, 'facts', factCurrentWhere(resolved.visibleMatterIds, sinceMs)) : 0
    const currentDeliveries = resolved.visibleMatterIds.length ? countWhere(store, 'deliveries', deliveryCurrentWhere(resolved.visibleMatterIds, sinceMs)) : 0
    const currentPreferenceWhere = preferenceCurrentWhere(resolved, sinceMs)
    const currentPreferences = currentPreferenceWhere ? countWhere(store, 'preferences', currentPreferenceWhere) : 0
    const entries = collectCurrentEntries(store, resolved, sinceMs)
    entries.sort((left, right) => {
      const a = left.atMs === undefined ? instantOf(left.at) : left.atMs
      const b = right.atMs === undefined ? instantOf(right.at) : right.atMs
      if (a === null && b === null) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      if (a === null) return 1
      if (b === null) return -1
      if (a !== b) return b - a
      const rank = KIND_RANK[left.kind] - KIND_RANK[right.kind]
      if (rank !== 0) return rank
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    })
    const page = entries.slice(0, pageLimit)
    const records = []
    for (const entry of page) {
      const record = hydrateEntry(store, entry)
      if (!record) throw fail('E_STORE', 'a candidate row could not be re-read in the same snapshot: ' + entry.id, 'run advisers doctor --check-db for a corrupt ledger row')
      records.push(record)
    }
    const byKind = emptyByKind()
    byKind.commitment = currentCommitments
    byKind.fact = currentFacts
    byKind.delivery = currentDeliveries
    byKind.preference = currentPreferences
    const candidateTotal = currentCommitments + currentFacts + currentDeliveries + currentPreferences
    const result = {
      subject: resolved.subject,
      generatedAt: resolved.nowIso,
      candidates: records.map(publicCandidate),
      counts: {
        candidates: records.length,
        candidateTotal,
        selectable: records.length,
        truncated: candidateTotal > records.length,
        byKind,
      },
      excluded,
    }
    if (withRecords) result.records = records
    return result
  })
}

export default Object.freeze({
  CONTEXT_PACK_SUBJECT_KINDS,
  CONTEXT_CANDIDATE_KINDS,
  CONTEXT_CANDIDATE_LIMIT_DEFAULT,
  CONTEXT_CANDIDATE_LIMIT_MAX,
  CONTEXT_CANDIDATE_ERRORS,
  CONTEXT_EXCLUSION_REASONS,
  normalizeContextPackSubject,
  normalizeContextCandidateLimit,
  resolveContextPackSubjectScope,
  collectContextCandidates,
  loadContextCandidateForSelection,
})
