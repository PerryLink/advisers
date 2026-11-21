/**
 * Fact time travel (0.4.0, read-only; no migration).
 *
 * The facts table already stores valid_from / valid_to / supersedes /
 * superseded_by / deleted_at; this module is the read side that 0.3.2 only had
 * partially. Three time concepts are kept distinct:
 * - validFrom/validTo: when the fact was true in the world (the as-of axis);
 * - recordedAt: when the ledger learned it;
 * - expiredAt: when the system noticed it stopped being current (never used for
 *   as-of selection, only displayed).
 *
 * as-of semantics (45 section 3.7): at instant t a fact applies when
 *   effectiveFrom = validFrom ?? recordedAt  <=  t
 *   and (validTo is null or t < validTo)
 * status is deliberately NOT filtered: a superseded fact was true in the past.
 * Deleted facts are excluded unless includeDeleted, and then only facts whose
 * deletedAt is after t are kept. For one (subject, predicate, matter) group the
 * row with the largest effectiveFrom wins; ties fall back to recordedAt and id.
 * A date-only --at is the start of that Asia/Shanghai calendar day converted to
 * a UTC instant (never a UTC day slice).
 *
 * Pure read module: no writes, no model, no network, no console output.
 */
import { entityError } from './sqlite.js'
import { stripBidiControls, stripControlChars, stripTerminalSequences } from './text-safe.js'

export const FACT_AS_OF_LIMIT = 200
export const FACT_AS_OF_LIMIT_MAX = 500
export const FACT_EVIDENCE_QUOTE_MAX = 200
export const FACT_HISTORY_MAX = 500

const SHANGHAI_OFFSET_MS = 8 * 3600_000
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const LOCAL_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function assertStore(store) {
  if (!store || !store.db || typeof store.db.prepare !== 'function' || typeof store.read !== 'function') {
    throw new TypeError('kb-facts requires an opened SqliteStore')
  }
}

function sanitizeQuote(value) {
  const text = stripControlChars(stripBidiControls(stripTerminalSequences(String(value ?? ''))), { keepNewlines: false, keepTabs: false, replacement: ' ' })
    .replace(/\s+/gu, ' ').trim()
  const chars = Array.from(text)
  return chars.length <= FACT_EVIDENCE_QUOTE_MAX ? text : chars.slice(0, FACT_EVIDENCE_QUOTE_MAX).join('')
}

function parseJson(value) {
  if (value === undefined || value === null) return undefined
  try { return typeof value === 'string' ? JSON.parse(value) : value } catch { return undefined }
}

function parseEvidence(value) {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed)) return []
  const out = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const quote = item.quote === undefined || item.quote === null ? null : sanitizeQuote(item.quote)
    const ref = item.ref === undefined || item.ref === null
      ? (item.sessionId ? String(item.sessionId) + '#' + String(item.turnId ?? '') : null)
      : String(item.ref)
    const source = item.source && typeof item.source === 'object' ? item.source : null
    if (!quote && !ref) continue
    out.push({
      ...(quote ? { quote } : {}),
      ...(ref ? { ref } : {}),
      ...(source ? { source } : {}),
    })
    if (out.length >= 10) break
  }
  return out
}

function mapFact(row) {
  if (!row) return null
  return {
    id: String(row.id),
    ...(row.matter_id === null || row.matter_id === undefined ? {} : { matterId: String(row.matter_id) }),
    subject: String(row.subject ?? ''),
    predicate: String(row.predicate ?? ''),
    object: String(row.object ?? ''),
    recordedAt: String(row.recorded_at ?? ''),
    ...(row.expired_at === null || row.expired_at === undefined ? {} : { expiredAt: String(row.expired_at) }),
    authority: String(row.authority ?? ''),
    confidence: Number(row.confidence ?? 0),
    ...(row.source === null || row.source === undefined ? {} : { source: parseJson(row.source) }),
    evidence: parseEvidence(row.evidence),
    status: String(row.status ?? ''),
    ...(row.valid_from === null || row.valid_from === undefined ? {} : { validFrom: String(row.valid_from) }),
    ...(row.valid_to === null || row.valid_to === undefined ? {} : { validTo: String(row.valid_to) }),
    ...(row.supersedes === null || row.supersedes === undefined ? {} : { supersedes: String(row.supersedes) }),
    ...(row.superseded_by === null || row.superseded_by === undefined ? {} : { supersededBy: String(row.superseded_by) }),
    ...(row.shadowed_by === null || row.shadowed_by === undefined ? {} : { shadowedBy: String(row.shadowed_by) }),
    ...(row.last_seen_at === null || row.last_seen_at === undefined ? {} : { lastSeenAt: String(row.last_seen_at) }),
    ...(row.deleted_at === null || row.deleted_at === undefined ? {} : { deletedAt: String(row.deleted_at) }),
    ...(row.deleted_reason === null || row.deleted_reason === undefined ? {} : { deletedReason: String(row.deleted_reason) }),
  }
}

function loadFact(store, id) {
  return mapFact(store.db.prepare('SELECT * FROM facts WHERE id = ?').get(String(id)))
}

/** Parse a stored timestamp to a UTC instant; date-only means the Shanghai day start. */
export function instantOfFactTime(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (DATE_ONLY_RE.test(text)) {
    const parts = text.split('-').map(Number)
    return Date.UTC(parts[0], parts[1] - 1, parts[2]) - SHANGHAI_OFFSET_MS
  }
  if (LOCAL_TIME_RE.test(text)) {
    const ms = Date.parse(text.replace(' ', 'T') + '+08:00')
    return Number.isFinite(ms) ? ms : null
  }
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/** UTC instant -> Asia/Shanghai calendar day (YYYY-MM-DD). */
export function shanghaiDayOf(ms) {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

/** Normalize an --at selector to {ms, iso, asOfLocalDay}. */
export function normalizeAsOf(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw entityError('E_USAGE', 'an as-of instant is required', 'use --at YYYY-MM-DD or an ISO 8601 datetime')
  }
  const text = value.trim()
  const ms = instantOfFactTime(text)
  if (ms === null || !Number.isFinite(ms)) {
    throw entityError('E_USAGE', 'invalid as-of instant: ' + text, 'use --at YYYY-MM-DD or an ISO 8601 datetime')
  }
  if (DATE_ONLY_RE.test(text) && shanghaiDayOf(ms) !== text) {
    throw entityError('E_USAGE', 'invalid calendar date: ' + text)
  }
  return { ms, iso: new Date(ms).toISOString(), asOfLocalDay: shanghaiDayOf(ms) }
}

function clientIdForMatter(store, matterId, cache) {
  if (matterId === undefined || matterId === null) return null
  if (cache.has(matterId)) return cache.get(matterId)
  const matter = store.getMatter(String(matterId))
  const clientId = matter && matter.clientId !== undefined && matter.clientId !== null ? String(matter.clientId) : null
  cache.set(matterId, clientId)
  return clientId
}

function kbSourcesForFact(store, factId) {
  const hasLinks = Boolean(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'kb_fact_links' AND type = 'table'").get())
  if (!hasLinks) return []
  const hasDocuments = Boolean(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'kb_documents' AND type = 'table'").get())
  if (!hasDocuments) return []
  const rows = store.db.prepare("SELECT l.doc_id, l.chunk_id, l.relation, d.title FROM kb_fact_links l JOIN kb_documents d ON d.id = l.doc_id WHERE l.fact_id = ? AND d.status = 'active' AND d.deleted_at IS NULL ORDER BY l.doc_id ASC, l.relation ASC").all(String(factId))
  return rows.map((row) => ({
    docId: String(row.doc_id),
    title: String(row.title),
    ...(row.chunk_id === null || row.chunk_id === undefined ? {} : { chunkId: String(row.chunk_id) }),
    relation: String(row.relation),
  }))
}

function factView(fact, { clientId = null, includeDeleted = true } = {}) {
  const fallback = { validFromFromRecordedAt: fact.validFrom === undefined }
  const view = {
    id: fact.id,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    ...(fact.matterId === undefined ? {} : { matterId: fact.matterId }),
    ...(clientId === null ? {} : { clientId }),
    authority: fact.authority,
    confidence: fact.confidence,
    status: fact.status,
    recordedAt: fact.recordedAt,
    ...(fact.validFrom === undefined ? {} : { validFrom: fact.validFrom }),
    ...(fact.validTo === undefined ? {} : { validTo: fact.validTo }),
    ...(fact.expiredAt === undefined ? {} : { expiredAt: fact.expiredAt }),
    ...(fact.supersedes === undefined ? {} : { supersedes: fact.supersedes }),
    ...(fact.supersededBy === undefined ? {} : { supersededBy: fact.supersededBy }),
    ...(fact.shadowedBy === undefined ? {} : { shadowedBy: fact.shadowedBy }),
    ...(fact.lastSeenAt === undefined ? {} : { lastSeenAt: fact.lastSeenAt }),
    ...(includeDeleted && fact.deletedAt !== undefined ? { deletedAt: fact.deletedAt } : {}),
    ...(includeDeleted && fact.deletedReason !== undefined ? { deletedReason: fact.deletedReason } : {}),
    evidence: fact.evidence,
    fallback,
  }
  return view
}

/* -------------------------------------------------------------------------- */
/* fact show                                                                  */
/* -------------------------------------------------------------------------- */

/** One fact with its supersede pointers, evidence and explicit KB sources. */
export function factShow(store, id, options = {}) {
  assertStore(store)
  const key = typeof id === 'string' ? id.trim() : ''
  if (!key) throw entityError('E_KB_INVALID', 'fact id is required')
  const includeDeleted = options.includeDeleted === true
  return store.read(() => {
    const fact = loadFact(store, key)
    if (!fact) throw entityError('E_FACT_NOT_FOUND', 'unknown fact: ' + key, 'advisers fact ls')
    if (fact.deletedAt !== undefined && !includeDeleted) throw entityError('E_FACT_NOT_FOUND', 'unknown fact: ' + key + ' (deleted)', 'pass --include-deleted to inspect a tombstone')
    const cache = new Map()
    const clientId = clientIdForMatter(store, fact.matterId, cache)
    const warnings = []
    if (fact.deletedAt !== undefined) warnings.push('fact is a tombstone')
    if (fact.validFrom === undefined) warnings.push('validFrom is missing; recordedAt is the effective start')
    return {
      ok: true,
      command: 'fact show',
      fact: factView(fact, { clientId, includeDeleted: true }),
      kbSources: kbSourcesForFact(store, fact.id),
      warnings,
      includeDeleted,
    }
  })
}

/* -------------------------------------------------------------------------- */
/* fact history                                                               */
/* -------------------------------------------------------------------------- */

/** Walk the supersede chain (oldest -> newest), tolerating broken links/cycles. */
export function factHistory(store, id, options = {}) {
  assertStore(store)
  const key = typeof id === 'string' ? id.trim() : ''
  if (!key) throw entityError('E_KB_INVALID', 'fact id is required')
  const includeDeleted = options.includeDeleted !== false
  return store.read(() => {
    const root = loadFact(store, key)
    if (!root) throw entityError('E_FACT_NOT_FOUND', 'unknown fact: ' + key, 'advisers fact ls')
    const warnings = []
    const byId = new Map([[root.id, root]])
    const load = (factId) => {
      if (byId.has(factId)) return byId.get(factId)
      const fact = loadFact(store, factId)
      if (fact) byId.set(fact.id, fact)
      return fact ?? null
    }
    // 1) walk supersedes back to the oldest row
    const backward = []
    const seenBack = new Set()
    let cursor = root
    while (cursor) {
      if (seenBack.has(cursor.id)) { warnings.push('cycle in supersedes chain at ' + cursor.id); break }
      seenBack.add(cursor.id)
      backward.push(cursor)
      if (cursor.supersedes === undefined) break
      const previous = load(cursor.supersedes)
      if (!previous) { warnings.push('broken supersedes link: ' + cursor.supersedes + ' is missing'); break }
      cursor = previous
    }
    const earliest = backward[backward.length - 1]
    // 2) walk supersededBy forward from the oldest row to the newest
    const ordered = []
    const seen = new Set()
    cursor = earliest
    while (cursor) {
      if (seen.has(cursor.id)) { warnings.push('cycle in supersededBy chain at ' + cursor.id); break }
      seen.add(cursor.id)
      ordered.push(cursor)
      if (ordered.length >= FACT_HISTORY_MAX) { warnings.push('history truncated at ' + FACT_HISTORY_MAX + ' rows'); break }
      if (cursor.supersededBy === undefined) break
      const next = load(cursor.supersededBy)
      if (!next) { warnings.push('broken supersededBy link: ' + cursor.supersededBy + ' is missing'); break }
      cursor = next
    }
    for (const fact of backward) {
      if (!seen.has(fact.id)) warnings.push('fact ' + fact.id + ' is only reachable through supersedes')
    }
    const cache = new Map()
    const items = ordered
      .filter((fact) => includeDeleted || fact.deletedAt === undefined)
      .map((fact) => factView(fact, { clientId: clientIdForMatter(store, fact.matterId, cache), includeDeleted: true }))
    return {
      ok: true,
      command: 'fact history',
      rootId: root.id,
      items,
      warnings,
      counts: { items: items.length },
      includeDeleted,
    }
  })
}

/* -------------------------------------------------------------------------- */
/* fact as-of                                                                 */
/* -------------------------------------------------------------------------- */

function clampLimit(value, fallback, max) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) return fallback
  return Math.min(number, max)
}

function compareCandidates(a, b) {
  if (a.effectiveMs !== b.effectiveMs) return a.effectiveMs - b.effectiveMs
  const aRecorded = a.recordedMs === null ? Number.NEGATIVE_INFINITY : a.recordedMs
  const bRecorded = b.recordedMs === null ? Number.NEGATIVE_INFINITY : b.recordedMs
  if (aRecorded !== bRecorded) return aRecorded - bRecorded
  return a.fact.id < b.fact.id ? -1 : a.fact.id > b.fact.id ? 1 : 0
}

function pushWarning(warnings, message) {
  if (!warnings.includes(message)) warnings.push(message)
}

/**
 * The facts that were true at one instant, one row per (subject, predicate,
 * matter) group. Read-only; deterministic for the same rows and --at.
 */
export function factAsOf(store, options = {}) {
  assertStore(store)
  const at = normalizeAsOf(options.at)
  const includeDeleted = options.includeDeleted === true
  const limit = clampLimit(options.limit, FACT_AS_OF_LIMIT, FACT_AS_OF_LIMIT_MAX)
  const matterId = options.matterId === undefined || options.matterId === null ? null : String(options.matterId)
  const clientId = options.clientId === undefined || options.clientId === null ? null : String(options.clientId)
  const subject = options.subject === undefined || options.subject === null ? null : String(options.subject)
  const predicate = options.predicate === undefined || options.predicate === null ? null : String(options.predicate)
  return store.read(() => {
    const warnings = []
    if (matterId !== null && !store.getMatter(matterId)) throw entityError('E_MATTER_NOT_FOUND', 'unknown matter: ' + matterId, 'advisers matter ls')
    let clientMatterIds = null
    if (clientId !== null) {
      if (!store.getClient(clientId)) throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + clientId, 'advisers client ls')
      clientMatterIds = store.listMattersByClient(clientId).map((matter) => String(matter.id))
      if (!clientMatterIds.length) return { ok: true, command: 'fact as-of', at: at.iso, asOfLocalDay: at.asOfLocalDay, items: [], counts: { groups: 0, candidates: 0, overlappingGroups: 0 }, warnings, degraded: [], includeDeleted, truncated: false }
    }
    const where = []
    const params = []
    if (!includeDeleted) where.push('deleted_at IS NULL')
    if (matterId !== null) { where.push('matter_id = ?'); params.push(matterId) }
    if (clientMatterIds !== null) { where.push('matter_id IN (' + clientMatterIds.map(() => '?').join(',') + ')'); params.push(...clientMatterIds) }
    if (subject !== null) { where.push('subject = ?'); params.push(subject) }
    if (predicate !== null) { where.push('predicate = ?'); params.push(predicate) }
    const rows = store.db.prepare('SELECT * FROM facts' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY subject ASC, predicate ASC, matter_id ASC, recorded_at ASC, id ASC').all(...params)
    let invalidTimestamps = 0
    let deletedFiltered = 0
    const groups = new Map()
    let candidates = 0
    for (const row of rows) {
      const fact = mapFact(row)
      if (fact.deletedAt !== undefined) {
        const deletedMs = instantOfFactTime(fact.deletedAt)
        if (!includeDeleted || deletedMs === null || deletedMs <= at.ms) { deletedFiltered += 1; continue }
      }
      const effectiveFrom = fact.validFrom === undefined ? fact.recordedAt : fact.validFrom
      const effectiveMs = instantOfFactTime(effectiveFrom)
      if (effectiveMs === null) { invalidTimestamps += 1; continue }
      if (effectiveMs > at.ms) continue
      if (fact.validTo !== undefined) {
        const validToMs = instantOfFactTime(fact.validTo)
        if (validToMs === null) { invalidTimestamps += 1; continue }
        if (at.ms >= validToMs) continue
      }
      candidates += 1
      const groupKey = fact.subject + '\u0000' + fact.predicate + '\u0000' + (fact.matterId ?? '')
      const recordedMs = instantOfFactTime(fact.recordedAt)
      const entry = { fact, effectiveMs, recordedMs }
      const group = groups.get(groupKey)
      if (!group) groups.set(groupKey, { candidates: [entry], selected: entry })
      else {
        group.candidates.push(entry)
        if (compareCandidates(entry, group.selected) > 0) group.selected = entry
      }
    }
    if (invalidTimestamps > 0) pushWarning(warnings, invalidTimestamps + ' fact(s) skipped because a timestamp could not be parsed')
    if (deletedFiltered > 0) pushWarning(warnings, deletedFiltered + ' deleted fact(s) excluded')
    let overlappingGroups = 0
    for (const group of groups.values()) if (group.candidates.length > 1) overlappingGroups += 1
    if (overlappingGroups > 0) pushWarning(warnings, overlappingGroups + ' group(s) have overlapping valid intervals; the latest effective start was selected')
    const cache = new Map()
    const items = []
    let fallbackCount = 0
    for (const group of groups.values()) {
      const entry = group.selected
      const view = factView(entry.fact, { clientId: clientIdForMatter(store, entry.fact.matterId, cache), includeDeleted: true })
      if (view.fallback.validFromFromRecordedAt) fallbackCount += 1
      items.push({ ...view, effectiveFrom: entry.fact.validFrom === undefined ? entry.fact.recordedAt : entry.fact.validFrom })
    }
    items.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1
      : a.predicate < b.predicate ? -1 : a.predicate > b.predicate ? 1
      : (a.matterId ?? '') < (b.matterId ?? '') ? -1 : (a.matterId ?? '') > (b.matterId ?? '') ? 1
      : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const total = items.length
    const page = items.slice(0, limit)
    const degraded = fallbackCount > 0 ? ['valid_from_fallback_recorded_at'] : []
    return {
      ok: true,
      command: 'fact as-of',
      at: at.iso,
      asOfLocalDay: at.asOfLocalDay,
      items: page,
      counts: { groups: total, candidates, overlappingGroups },
      warnings,
      degraded,
      includeDeleted,
      truncated: total > page.length,
    }
  })
}

export default Object.freeze({
  FACT_AS_OF_LIMIT,
  FACT_AS_OF_LIMIT_MAX,
  FACT_EVIDENCE_QUOTE_MAX,
  FACT_HISTORY_MAX,
  factShow,
  factHistory,
  factAsOf,
  instantOfFactTime,
  shanghaiDayOf,
  normalizeAsOf,
})
