/**
 * Customer read projection (0.3.2 M3): pure, read-only views over an ALREADY
 * OPENED SqliteStore.
 *
 * This module is the single place that derives the customer list/status shapes
 * used by the MCP server (advisers_clients + advisers://clients) and the DSH
 * adapter. It performs no writes, no migrations and no HOME handling; the
 * caller owns the connection (MCP: the long-lived store; DSH: the read-only
 * facade in lib/ledger-read.js).
 *
 * Frozen rules (0.3.0 schema v21 customer entities, docs/CLIENTS.md):
 * - one store.read() snapshot per call: every SELECT below sees the same WAL
 *   snapshot, so a concurrent writer can never make counts disagree with rows;
 * - every query is scoped by the client's own matter ids (or by the delivery
 *   lineage snapshot client_id), never a full-table read followed by an
 *   in-memory filter of another client's rows;
 * - effective secrecy of a matter = max(client.secrecyDefault, matter.secrecy);
 *   rows above the clearance are filtered BEFORE counting, paging and limiting
 *   and are only counted in protectedExcluded (no id/title/name is returned);
 * - notes are counted, never returned (this projection has no note-body field
 *   at all); no conversation/turn text is ever read;
 * - the timeline only contains delivery/commitment rows (never note bodies),
 *   ordered by instant DESC, then delivery > commitment, then id ASC;
 * - a delivery whose matter cannot be resolved inside the visible scope (for
 *   example a generation-time client snapshot whose matter was re-linked, or a
 *   dangling matter id) is treated as protected: it is counted, never returned.
 */

/** Client-row list page default (the MCP resource/tool default is 20). */
export const CUSTOMER_LIST_LIMIT = 50
/** Hard cap for one client-row page. */
export const CUSTOMER_LIST_LIMIT_MAX = 200
/** Timeline page default. */
export const CUSTOMER_TIMELINE_LIMIT = 20
/** Hard cap for one timeline page. */
export const CUSTOMER_TIMELINE_LIMIT_MAX = 200
/** Open mine/waiting list default. */
export const CUSTOMER_OPEN_LIMIT = 20
/** Hard cap for one open list. */
export const CUSTOMER_OPEN_LIMIT_MAX = 200

const TITLE_MAX = 120
const DAY_MS = 86400_000
const SHANGHAI_OFFSET_MS = 8 * 3600_000
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const LOCAL_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/
/** Kind order used by the frozen timeline sort (delivery before commitment). */
const KIND_RANK = Object.freeze({ delivery: 0, commitment: 1 })

/* -------------------------------------------------------------------------- */
/* small pure helpers                                                         */
/* -------------------------------------------------------------------------- */

function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeClearance(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.floor(number)
}

function clampLimit(value, def, max) {
  if (value === undefined || value === null) return def
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) return def
  return Math.min(number, max)
}

/** max(client.secrecyDefault, matter.secrecy); a dirty value fails closed. */
function effectiveMatterSecrecy(client, matter) {
  const clientLevel = client?.secrecyDefault === undefined || client?.secrecyDefault === null
    ? 0
    : finiteNumber(client.secrecyDefault, Number.POSITIVE_INFINITY)
  const matterLevel = matter?.secrecy === undefined || matter?.secrecy === null
    ? 0
    : finiteNumber(matter.secrecy, Number.POSITIVE_INFINITY)
  if (!Number.isFinite(clientLevel) || !Number.isFinite(matterLevel)) return Number.POSITIVE_INFINITY
  return Math.max(clientLevel, matterLevel)
}

function clientDefaultSecrecy(client) {
  return finiteNumber(client?.secrecyDefault, Number.POSITIVE_INFINITY)
}

/** Single-line display title (max 120 chars), never a file path. */
function timelineTitle(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  if (!text) return ''
  const chars = Array.from(text)
  if (chars.length <= TITLE_MAX) return text
  return chars.slice(0, TITLE_MAX - 1).join('') + '\u2026'
}

/** Parse a stored ISO/epoch timestamp; null when it cannot be trusted. */
function instantOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

function agendaDayEndInstant(day) {
  if (!DATE_ONLY_RE.test(day)) return null
  const parts = day.split('-').map(Number)
  return Date.UTC(parts[0], parts[1] - 1, parts[2]) - SHANGHAI_OFFSET_MS + DAY_MS - 1
}

/**
 * Resolve a stored dueAt to an absolute instant (same rule as the CLI):
 * YYYY-MM-DD -> end of that Shanghai day, local ISO without zone -> +08:00,
 * anything with Z/offset -> its absolute instant. Null for dirty data.
 */
function dueInstantOf(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  if (DATE_ONLY_RE.test(text)) return agendaDayEndInstant(text)
  if (LOCAL_TIME_RE.test(text)) {
    const ms = Date.parse(text.replace(' ', 'T') + '+08:00')
    return Number.isFinite(ms) ? ms : null
  }
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/** UTC instant -> Shanghai wall-clock ISO string with an explicit +08:00 offset. */
function toShanghaiIso(ms) {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().replace('Z', '+08:00')
}

function nextDueAt(openRows) {
  let next = null
  for (const row of openRows) {
    const ms = dueInstantOf(row.due_at)
    if (ms !== null && (next === null || ms < next)) next = ms
  }
  return next === null ? null : toShanghaiIso(next)
}

function overdueCount(openRows) {
  const nowMs = Date.now()
  let count = 0
  for (const row of openRows) {
    const ms = dueInstantOf(row.due_at)
    if (ms !== null && ms < nowMs) count += 1
  }
  return count
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
}

function assertStore(store) {
  if (!store || typeof store.read !== 'function' || !store.db || typeof store.db.prepare !== 'function'
    || typeof store.listMattersByClient !== 'function' || typeof store.listClients !== 'function'
    || typeof store.getClient !== 'function') {
    throw new TypeError('customer-read requires an opened SqliteStore (customer tables are SQLite-only)')
  }
}

/* -------------------------------------------------------------------------- */
/* SQL helpers (table names are internal constants, never caller input)       */
/* -------------------------------------------------------------------------- */

const COUNT_TABLES = new Set(['commitments', 'deliveries'])

function matterPlaceholders(ids) {
  return ids.map(() => '?').join(',')
}

/** Exact COUNT(*) on one client-scoped table. */
function countByMatter(store, table, ids) {
  if (!COUNT_TABLES.has(table)) throw new TypeError('unexpected customer count table: ' + String(table))
  if (!ids.length) return 0
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE matter_id IN (' + matterPlaceholders(ids) + ')').get(...ids)
  return Number(row?.n ?? 0)
}

/** Open commitments on the client's visible matters, insertion order. */
function openCommitmentRows(store, ids) {
  if (!ids.length) return []
  return store.db.prepare(
    'SELECT id, matter_id, action, debtor, creditor, due_at FROM commitments WHERE status = ? AND matter_id IN (' + matterPlaceholders(ids) + ') ORDER BY rowid',
  ).all('open', ...ids)
}

/** Note counts grouped by (project, matter) for one client; never the body. */
function noteGroups(store, clientId) {
  const rows = store.db.prepare(
    'SELECT project_id, matter_id, COUNT(*) AS n FROM client_notes WHERE client_id = ? AND deleted_at IS NULL GROUP BY project_id, matter_id',
  ).all(clientId)
  return rows.map((row) => ({
    projectId: row.project_id === null || row.project_id === undefined ? undefined : row.project_id,
    matterId: row.matter_id === null || row.matter_id === undefined ? undefined : row.matter_id,
    n: Number(row.n ?? 0),
  }))
}

/** Client-level visible note count + withheld client-level notes (no bodies). */
function clientNoteStats(client, groups, allowedIds, clearance) {
  const clientLevel = clientDefaultSecrecy(client)
  let count = 0
  let withheld = 0
  for (const group of groups) {
    if (group.matterId === undefined) {
      if (clientLevel <= clearance) count += group.n
      else withheld += group.n
    } else if (allowedIds.has(group.matterId)) {
      count += group.n
    }
  }
  return { count, withheld }
}

/** Project-scoped visible note count (explicit project id OR one of its matters). */
function projectNoteStats(client, groups, projectId, projectAllowedIds, clearance) {
  const clientLevel = clientDefaultSecrecy(client)
  let count = 0
  for (const group of groups) {
    const viaProject = group.projectId === projectId
    const viaMatter = group.matterId !== undefined && projectAllowedIds.has(group.matterId)
    if (!viaProject && !viaMatter) continue
    if (group.matterId === undefined) {
      if (clientLevel <= clearance) count += group.n
    } else if (projectAllowedIds.has(group.matterId)) {
      count += group.n
    }
  }
  return count
}

/* -------------------------------------------------------------------------- */
/* open-commitment split                                                      */
/* -------------------------------------------------------------------------- */

function isWaitingOnClient(row) {
  return typeof row?.debtor === 'string' && row.debtor.startsWith('third:')
}

function openRowView(row, matterById, client) {
  const view = {
    id: String(row.id),
    action: String(row.action ?? ''),
    debtor: String(row.debtor ?? ''),
    creditor: String(row.creditor ?? ''),
    status: 'open',
  }
  if (row.matter_id !== null && row.matter_id !== undefined) view.matterId = String(row.matter_id)
  if (row.due_at !== null && row.due_at !== undefined) view.dueAt = String(row.due_at)
  const matter = view.matterId === undefined ? undefined : matterById.get(view.matterId)
  if (matter?.projectId !== undefined && matter.projectId !== null) view.projectId = String(matter.projectId)
  view.secrecy = matter ? effectiveMatterSecrecy(client, matter) : clientDefaultSecrecy(client)
  return view
}

function byDueThenId(a, b) {
  const aMs = dueInstantOf(a.dueAt)
  const bMs = dueInstantOf(b.dueAt)
  if (aMs === null && bMs === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  if (aMs === null) return 1
  if (bMs === null) return -1
  if (aMs !== bMs) return aMs - bMs
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function splitOpenRows(rows, matterById, client) {
  const mine = []
  const waiting = []
  for (const row of rows) {
    const view = openRowView(row, matterById, client)
    if (isWaitingOnClient(row)) waiting.push(view)
    else mine.push(view)
  }
  mine.sort(byDueThenId)
  waiting.sort(byDueThenId)
  return { mine, waiting }
}

/* -------------------------------------------------------------------------- */
/* shared per-client projection                                               */
/* -------------------------------------------------------------------------- */

/**
 * One client's visible read model, inside the caller's store.read() snapshot.
 * The caller owns the snapshot: this helper performs the SELECTs directly.
 */
function projectClient(store, client, clearance) {
  const matters = store.listMattersByClient(client.id)
  const visibleMatters = []
  let protectedMatters = 0
  for (const matter of matters) {
    if (effectiveMatterSecrecy(client, matter) <= clearance) visibleMatters.push(matter)
    else protectedMatters += 1
  }
  const allowedIds = new Set(visibleMatters.map((matter) => matter.id))
  const matterById = new Map(visibleMatters.map((matter) => [matter.id, matter]))
  const groups = noteGroups(store, client.id)
  const notes = clientNoteStats(client, groups, allowedIds, clearance)
  const ids = [...allowedIds]
  const openRows = openCommitmentRows(store, ids)
  const split = splitOpenRows(openRows, matterById, client)
  const counts = {
    matters: visibleMatters.length,
    mattersArchived: visibleMatters.filter((matter) => matter.status === 'archived').length,
    deliveries: countByMatter(store, 'deliveries', ids),
    notes: notes.count,
    commitments: countByMatter(store, 'commitments', ids),
    openMine: split.mine.length,
    openWaiting: split.waiting.length,
    overdue: overdueCount(openRows),
  }
  return { client, visibleMatters, matterById, allowedIds, ids, groups, notes, openRows, split, counts, protectedMatters }
}

/* -------------------------------------------------------------------------- */
/* timeline (delivery + commitment only; notes are counted, never shown)      */
/* -------------------------------------------------------------------------- */

function buildTimeline(store, client, projection, timelineLimit) {
  const { ids, matterById } = projection
  const fetchLimit = timelineLimit + 20
  const items = []
  let protectedDeliveries = 0
  let deliveryRows = []
  if (ids.length) {
    deliveryRows = store.db.prepare(
      'SELECT id, matter_id, title, tool, created_at FROM deliveries WHERE matter_id IN (' + matterPlaceholders(ids) + ') OR client_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).all(...ids, client.id, fetchLimit)
  } else {
    deliveryRows = store.db.prepare(
      'SELECT id, matter_id, title, tool, created_at FROM deliveries WHERE client_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).all(client.id, fetchLimit)
  }
  for (const row of deliveryRows) {
    const matter = row.matter_id === null || row.matter_id === undefined ? undefined : matterById.get(row.matter_id)
    if (!matter) { protectedDeliveries += 1; continue }
    const at = String(row.created_at ?? '')
    const ms = instantOf(at)
    if (ms === null) continue
    items.push({
      at,
      kind: 'delivery',
      title: timelineTitle(row.title) || timelineTitle(row.tool) || String(row.id),
      ref: { kind: 'delivery', id: String(row.id) },
      matterId: String(matter.id),
      secrecy: effectiveMatterSecrecy(client, matter),
      _ms: ms,
    })
  }
  if (ids.length) {
    const commitmentRows = store.db.prepare(
      "SELECT id, matter_id, action, created_at FROM commitments WHERE matter_id IN (" + matterPlaceholders(ids) + ") AND created_at IS NOT NULL AND created_at != '' ORDER BY created_at DESC, rowid DESC LIMIT ?",
    ).all(...ids, fetchLimit)
    for (const row of commitmentRows) {
      const matter = matterById.get(row.matter_id)
      if (!matter) continue
      const at = String(row.created_at ?? '')
      const ms = instantOf(at)
      if (ms === null) continue
      items.push({
        at,
        kind: 'commitment',
        title: timelineTitle(row.action) || String(row.id),
        ref: { kind: 'commitment', id: String(row.id) },
        matterId: String(matter.id),
        secrecy: effectiveMatterSecrecy(client, matter),
        _ms: ms,
      })
    }
  }
  const deliveryTotal = countByMatter(store, 'deliveries', ids)
  let commitmentTotal = 0
  if (ids.length) {
    commitmentTotal = Number(store.db.prepare(
      "SELECT COUNT(*) AS n FROM commitments WHERE matter_id IN (" + matterPlaceholders(ids) + ") AND created_at IS NOT NULL AND created_at != ''",
    ).get(...ids)?.n ?? 0)
  }
  items.sort((a, b) => (b._ms - a._ms) || (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || (a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0))
  const page = items.slice(0, timelineLimit).map(({ _ms, ...item }) => item)
  const total = deliveryTotal + commitmentTotal
  return { items: page, total, truncated: total > page.length, protectedDeliveries }
}

/* -------------------------------------------------------------------------- */
/* public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * List customer rows (active by default; archived only with includeArchived).
 *
 * Pagination happens AFTER the per-client secrecy filter/count derivation, so
 * a truncated page never changes the meaning of a row's counts. `total` is the
 * post-filter client count; `protectedExcluded` counts the protected matters
 * and client-level notes of the returned rows.
 *
 * @param {object} store opened SqliteStore
 * @param {{clearance?:number, limit?:number, includeArchived?:boolean}} [options]
 * @returns {{rows:Array<object>, total:number, limit:number, clearance:number, protectedExcluded:number}}
 */
export function listClientRows(store, { clearance = 0, limit = CUSTOMER_LIST_LIMIT, includeArchived = false } = {}) {
  assertStore(store)
  const level = normalizeClearance(clearance)
  const pageLimit = clampLimit(limit, CUSTOMER_LIST_LIMIT, CUSTOMER_LIST_LIMIT_MAX)
  const archived = includeArchived === true
  return store.read(() => {
    const where = archived ? '' : " WHERE status = 'active' AND deleted_at IS NULL"
    const total = Number(store.db.prepare('SELECT COUNT(*) AS n FROM clients' + where).get()?.n ?? 0)
    const clients = store.listClients({
      status: archived ? 'all' : 'active',
      includeDeleted: archived,
      limit: pageLimit,
    })
    const rows = []
    let protectedExcluded = 0
    for (const client of clients) {
      const projection = projectClient(store, client, level)
      const withheld = projection.protectedMatters + projection.notes.withheld
      protectedExcluded += withheld
      rows.push({
        id: String(client.id),
        name: String(client.name ?? ''),
        status: String(client.status ?? ''),
        aliases: stringList(client.aliases),
        secrecyDefault: finiteNumber(client.secrecyDefault, 0),
        tags: stringList(client.tags),
        counts: projection.counts,
        nextDueAt: nextDueAt(projection.openRows),
        clearance: level,
        protectedExcluded: withheld,
      })
    }
    return { rows, total, limit: pageLimit, clearance: level, protectedExcluded }
  })
}

/**
 * One client status view: identity (no notes body), project summaries, exact
 * counts, open mine/waiting items and a derived delivery/commitment timeline.
 * Returns null for an unknown client id (the caller decides how to map that;
 * the store itself is not the error source).
 *
 * @param {object} store opened SqliteStore
 * @param {string} id client id
 * @param {{clearance?:number, timelineLimit?:number, openLimit?:number}} [options]
 * @returns {object|null}
 */
export function readClientStatus(store, id, { clearance = 0, timelineLimit = CUSTOMER_TIMELINE_LIMIT, openLimit = CUSTOMER_OPEN_LIMIT } = {}) {
  assertStore(store)
  const key = typeof id === 'string' ? id.trim() : ''
  if (!key) return null
  const level = normalizeClearance(clearance)
  const timelinePage = clampLimit(timelineLimit, CUSTOMER_TIMELINE_LIMIT, CUSTOMER_TIMELINE_LIMIT_MAX)
  const openPage = clampLimit(openLimit, CUSTOMER_OPEN_LIMIT, CUSTOMER_OPEN_LIMIT_MAX)
  return store.read(() => {
    const client = store.getClient(key)
    if (!client) return null
    const projection = projectClient(store, client, level)
    const timeline = buildTimeline(store, client, projection, timelinePage)
    const projects = store.listProjects({ clientId: client.id, status: 'all', includeDeleted: true, limit: 1000 }).map((project) => {
      const projectMatters = projection.visibleMatters.filter((matter) => matter.projectId === project.id)
      const projectIds = projectMatters.map((matter) => matter.id)
      const projectAllowed = new Set(projectIds)
      const projectOpen = projection.openRows.filter((row) => row.matter_id !== null && row.matter_id !== undefined && projectAllowed.has(row.matter_id))
      const projectSplit = splitOpenRows(projectOpen, projection.matterById, client)
      return {
        id: String(project.id),
        name: String(project.name ?? ''),
        status: String(project.status ?? ''),
        counts: {
          matters: projectMatters.length,
          mattersArchived: projectMatters.filter((matter) => matter.status === 'archived').length,
          deliveries: countByMatter(store, 'deliveries', projectIds),
          notes: projectNoteStats(client, projection.groups, project.id, projectAllowed, level),
          commitments: countByMatter(store, 'commitments', projectIds),
          openMine: projectSplit.mine.length,
          openWaiting: projectSplit.waiting.length,
          overdue: overdueCount(projectOpen),
        },
        nextDueAt: nextDueAt(projectOpen),
      }
    })
    return {
      client: {
        id: String(client.id),
        name: String(client.name ?? ''),
        status: String(client.status ?? ''),
        aliases: stringList(client.aliases),
        tags: stringList(client.tags),
        secrecyDefault: finiteNumber(client.secrecyDefault, 0),
      },
      projects,
      counts: projection.counts,
      open: {
        mine: projection.split.mine.slice(0, openPage),
        waiting: projection.split.waiting.slice(0, openPage),
        mineTotal: projection.split.mine.length,
        waitingTotal: projection.split.waiting.length,
      },
      nextDueAt: nextDueAt(projection.openRows),
      timeline: timeline.items,
      timelineTotal: timeline.total,
      timelineTruncated: timeline.truncated,
      clearance: level,
      protectedExcluded: projection.protectedMatters + projection.notes.withheld + timeline.protectedDeliveries,
    }
  })
}

export default Object.freeze({
  CUSTOMER_LIST_LIMIT,
  CUSTOMER_LIST_LIMIT_MAX,
  CUSTOMER_TIMELINE_LIMIT,
  CUSTOMER_TIMELINE_LIMIT_MAX,
  CUSTOMER_OPEN_LIMIT,
  CUSTOMER_OPEN_LIMIT_MAX,
  listClientRows,
  readClientStatus,
})
