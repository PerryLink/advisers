/**
 * KB compiled pages (0.4.0, schema v22): deterministic, rebuildable projections
 * of the local ledger and KB. A page is derived data, never a fourth ledger:
 * every byte comes from rows in the same database, and `kb page rebuild` is the
 * only writer (the CLI wires the command; this module owns the derivation).
 *
 * Four page kinds (45 section 3.6):
 * - client: identity, projects, counts, open commitments, recent timeline, facts;
 * - project: project fields, its matters, deliveries and open commitments;
 * - timeline: the derived client timeline (deliveries + commitments only, never
 *   note bodies), reuseing lib/customer-read.js;
 * - facts: one fact chain per (subject, matter) with validFrom/validTo and
 *   evidence quotes.
 *
 * Determinism contract:
 * - data contains no wall clock; generated_at lives only on the row;
 * - inputsSha256 = sha256(canonical JSON of the page data), so identical
 *   database rows produce byte-identical markdown/json/hash across processes;
 * - json column is canonical JSON (sorted keys), markdown is a pure function of
 *   the same data; rebuild writes only rows whose hash changed;
 * - page ids are stable: page_client_<id>, page_project_<id>,
 *   page_timeline_<id>, page_facts_<sha256(subject|matter)[0:12]>.
 *
 * Privacy: notes are counted, never rendered; a page whose owner is above the
 * caller's clearance is filtered BEFORE counting/paging and only counted in
 * protectedExcluded; unresolvable owners fail closed. No model, no network.
 */
import { createHash } from 'node:crypto'
import { entityError } from './sqlite.js'
import { readClientStatus } from './customer-read.js'
import { stripBidiControls, stripControlChars, stripTerminalSequences } from './text-safe.js'

export const KB_PAGE_KINDS = Object.freeze(['client', 'project', 'timeline', 'facts'])
export const KB_PAGE_GENERATOR = 'deterministic@1'
export const KB_PAGE_LIST_LIMIT = 50
export const KB_PAGE_LIST_LIMIT_MAX = 500
export const KB_PAGE_FACTS_MAX = 500
export const KB_PAGE_FACTS_PER_GROUP_MAX = 200
export const KB_PAGE_FACT_EVIDENCE_MAX = 200

const KIND_RANK = Object.freeze({ client: 0, project: 1, timeline: 2, facts: 3 })
const FACT_QUOTE_MAX = 200
const DELIVERY_PREVIEW_MAX = 20

/* -------------------------------------------------------------------------- */
/* deterministic helpers                                                      */
/* -------------------------------------------------------------------------- */

function normalizeJson(value) {
  if (value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item))
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue
      out[key] = normalizeJson(value[key])
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}

/** Canonical JSON (sorted keys at every depth) used for the page hash + json column. */
export function canonicalJson(value) {
  return JSON.stringify(normalizeJson(value))
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function sanitizeInline(value, max = 200) {
  const text = stripControlChars(stripBidiControls(stripTerminalSequences(String(value ?? ''))), { keepNewlines: false, keepTabs: false, replacement: ' ' })
    .replace(/\s+/gu, ' ').trim()
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

function sanitizeBlock(value) {
  return stripControlChars(stripBidiControls(stripTerminalSequences(String(value ?? ''))), { keepNewlines: true, keepTabs: true, replacement: ' ' })
    .replace(/\n{3,}/g, '\n\n').trim()
}

function cell(value) {
  return sanitizeInline(value, 160).replace(/\|/g, '\\|')
}

function numberOrNull(value) {
  if (value === undefined || value === null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function stringOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  return String(value)
}

function assertStore(store) {
  if (!store || !store.db || typeof store.db.prepare !== 'function' || typeof store.read !== 'function' || typeof store.mutate !== 'function') {
    throw new TypeError('kb-pages requires an opened SqliteStore')
  }
}

function hasSqliteObject(store, name, types = ['table']) {
  const placeholders = types.map(() => '?').join(',')
  return Boolean(store.db.prepare('SELECT name FROM sqlite_master WHERE name = ? AND type IN (' + placeholders + ')').get(name, ...types))
}

export function assertKbPagesSchema(store) {
  assertStore(store)
  if (!hasSqliteObject(store, 'kb_pages')) {
    throw entityError('E_SCHEMA_STALE', 'kb_pages is missing; open an upgraded database (schema v22)', 'advisers doctor')
  }
}

/* -------------------------------------------------------------------------- */
/* page ids                                                                   */
/* -------------------------------------------------------------------------- */

export function clientPageId(clientId) {
  return 'page_client_' + String(clientId)
}

export function projectPageId(projectId) {
  return 'page_project_' + String(projectId)
}

export function timelinePageId(clientId) {
  return 'page_timeline_' + String(clientId)
}

/** Stable facts-page key for one (subject, matter) pair. */
export function factsPageKey(subject, matterId) {
  return sha256Hex(String(subject) + '|' + String(matterId ?? '')).slice(0, 12)
}

export function factsPageId(subject, matterId) {
  return 'page_facts_' + factsPageKey(subject, matterId)
}

/** Parse a stable page id back into an identity ({kind, clientId|projectId|hash}). */
export function parseKbPageId(id) {
  const text = String(id ?? '')
  let match = /^page_client_(.+)$/.exec(text)
  if (match) return { kind: 'client', clientId: match[1] }
  match = /^page_timeline_(.+)$/.exec(text)
  if (match) return { kind: 'timeline', clientId: match[1] }
  match = /^page_project_(.+)$/.exec(text)
  if (match) return { kind: 'project', projectId: match[1] }
  match = /^page_facts_([0-9a-f]{12})$/.exec(text)
  if (match) return { kind: 'facts', key: match[1] }
  return null
}

/* -------------------------------------------------------------------------- */
/* owner / clearance helpers                                                  */
/* -------------------------------------------------------------------------- */

function loadOwnerMaps(store) {
  const clients = new Map(store.db.prepare('SELECT id, secrecy_default FROM clients').all().map((row) => [String(row.id), Number(row.secrecy_default ?? 0)]))
  const matters = new Map(store.db.prepare('SELECT id, secrecy, client_id FROM matters').all().map((row) => [String(row.id), { secrecy: Number(row.secrecy ?? 0), clientId: stringOrNull(row.client_id) }]))
  const projects = new Map(store.db.prepare('SELECT id, client_id FROM projects').all().map((row) => [String(row.id), stringOrNull(row.client_id)]))
  return { clients, matters, projects }
}

function ownerSecrecy(maps, owner) {
  if (!owner) return Number.POSITIVE_INFINITY
  let level = 0
  if (owner.clientId) {
    const value = maps.clients.get(String(owner.clientId))
    if (value === undefined) return Number.POSITIVE_INFINITY
    level = Math.max(level, value)
  }
  if (owner.matterId) {
    const matter = maps.matters.get(String(owner.matterId))
    if (!matter) return Number.POSITIVE_INFINITY
    level = Math.max(level, matter.secrecy)
    if (matter.clientId) {
      const value = maps.clients.get(matter.clientId)
      if (value === undefined) return Number.POSITIVE_INFINITY
      level = Math.max(level, value)
    }
  }
  return level
}

function pageOwnerFromRow(row, maps) {
  let data = null
  try { data = JSON.parse(String(row.json ?? '')) } catch { data = null }
  if (data && data.owner && typeof data.owner === 'object') {
    return { clientId: stringOrNull(data.owner.clientId), matterId: stringOrNull(data.owner.matterId) }
  }
  const kind = String(row.kind)
  if (kind === 'client' || kind === 'timeline') return { clientId: String(row.subject_id), matterId: null }
  if (kind === 'project') {
    const clientId = maps.projects.get(String(row.subject_id))
    return clientId === undefined ? null : { clientId, matterId: null }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* source refs                                                                */
/* -------------------------------------------------------------------------- */

function collectSourceRefs(data) {
  const refs = []
  const seen = new Set()
  const push = (kind, id) => {
    if (id === undefined || id === null || id === '') return
    const key = kind + ':' + String(id)
    if (seen.has(key)) return
    seen.add(key)
    refs.push({ kind, id: String(id) })
  }
  const pushOpen = (open) => {
    for (const item of [...(open?.mine ?? []), ...(open?.waiting ?? [])]) push('commitment', item.id)
  }
  if (data.kind === 'client' || data.kind === 'timeline') {
    push('client', data.client.id)
    for (const project of data.projects ?? []) push('project', project.id)
    for (const item of data.timeline ?? []) push(item.ref.kind, item.ref.id)
    pushOpen(data.open)
    for (const fact of data.facts ?? []) push('fact', fact.id)
  } else if (data.kind === 'project') {
    push('client', data.client.id)
    push('project', data.project.id)
    for (const matter of data.matters ?? []) push('matter', matter.id)
    for (const delivery of data.deliveries ?? []) push('delivery', delivery.id)
    pushOpen(data.open)
  } else if (data.kind === 'facts') {
    if (data.matterId) push('matter', data.matterId)
    if (data.owner && data.owner.clientId) push('client', data.owner.clientId)
    for (const fact of data.facts ?? []) push('fact', fact.id)
  }
  refs.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return refs
}

/* -------------------------------------------------------------------------- */
/* fact views                                                                 */
/* -------------------------------------------------------------------------- */

function parseJsonArray(value) {
  if (value === undefined || value === null) return []
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function factEvidence(evidence) {
  const out = []
  for (const item of parseJsonArray(evidence)) {
    if (!item || typeof item !== 'object') continue
    const quote = stringOrNull(item.quote) ?? stringOrNull(item.source && item.source.quote)
    const ref = stringOrNull(item.ref) ?? (item.sessionId ? String(item.sessionId) + '#' + String(item.turnId ?? '') : null)
    if (!quote && !ref) continue
    out.push({
      ...(quote ? { quote: sanitizeInline(quote, FACT_QUOTE_MAX) } : {}),
      ...(ref ? { ref } : {}),
    })
    if (out.length >= 3) break
  }
  return out
}

function factView(row) {
  return {
    id: String(row.id),
    subject: String(row.subject ?? ''),
    predicate: String(row.predicate ?? ''),
    object: sanitizeInline(row.object, 500),
    ...(row.matter_id === null || row.matter_id === undefined ? {} : { matterId: String(row.matter_id) }),
    authority: String(row.authority ?? ''),
    confidence: Number(row.confidence ?? 0),
    status: String(row.status ?? ''),
    recordedAt: String(row.recorded_at ?? ''),
    ...(row.valid_from === null || row.valid_from === undefined ? {} : { validFrom: String(row.valid_from) }),
    ...(row.valid_to === null || row.valid_to === undefined ? {} : { validTo: String(row.valid_to) }),
    ...(row.supersedes === null || row.supersedes === undefined ? {} : { supersedes: String(row.supersedes) }),
    ...(row.superseded_by === null || row.superseded_by === undefined ? {} : { supersededBy: String(row.superseded_by) }),
    evidence: factEvidence(row.evidence),
  }
}

function currentFactsForClient(store, clientId, clearance, clientSecrecyDefault) {
  const matters = store.listMattersByClient(clientId).filter((matter) => Math.max(Number(clientSecrecyDefault ?? 0), Number(matter.secrecy ?? 0)) <= clearance)
  if (!matters.length) return []
  const placeholders = matters.map(() => '?').join(',')
  const rows = store.db.prepare("SELECT id, matter_id, subject, predicate, object, authority, confidence, valid_from, valid_to, supersedes, superseded_by, evidence, recorded_at, status FROM facts WHERE deleted_at IS NULL AND status = 'confirmed' AND matter_id IN (" + placeholders + ') ORDER BY subject ASC, predicate ASC, matter_id ASC, recorded_at ASC, id ASC LIMIT 50')
    .all(...matters.map((matter) => String(matter.id)))
  return rows.map(factView)
}

/* -------------------------------------------------------------------------- */
/* page data builders (pure projections; no wall clock)                       */
/* -------------------------------------------------------------------------- */

function pickCounts(counts) {
  const source = counts ?? {}
  return {
    matters: Number(source.matters ?? 0),
    mattersArchived: Number(source.mattersArchived ?? 0),
    deliveries: Number(source.deliveries ?? 0),
    notes: Number(source.notes ?? 0),
    commitments: Number(source.commitments ?? 0),
    openMine: Number(source.openMine ?? 0),
    openWaiting: Number(source.openWaiting ?? 0),
  }
}

function pickOpenItem(item) {
  return {
    id: String(item.id),
    action: sanitizeInline(item.action, 200),
    debtor: String(item.debtor ?? ''),
    creditor: String(item.creditor ?? ''),
    ...(item.matterId === undefined ? {} : { matterId: String(item.matterId) }),
    ...(item.dueAt === undefined ? {} : { dueAt: String(item.dueAt) }),
    ...(item.projectId === undefined ? {} : { projectId: String(item.projectId) }),
  }
}

function pickTimelineItem(item) {
  return {
    at: String(item.at),
    kind: String(item.kind),
    title: sanitizeInline(item.title, 200),
    ref: { kind: String(item.ref.kind), id: String(item.ref.id) },
    ...(item.matterId === undefined ? {} : { matterId: String(item.matterId) }),
  }
}

function clientPageData(status, facts, timelineLimit = 20) {
  const client = status.client
  const timeline = (status.timeline ?? []).slice(0, timelineLimit).map(pickTimelineItem)
  const timelineTotal = Number(status.timelineTotal ?? (status.timeline ?? []).length)
  return {
    version: 1,
    kind: 'client',
    generator: KB_PAGE_GENERATOR,
    owner: { clientId: String(client.id), matterId: null },
    client: {
      id: String(client.id),
      name: sanitizeInline(client.name, 200),
      status: String(client.status ?? ''),
      aliases: (client.aliases ?? []).map((alias) => sanitizeInline(alias, 80)),
      tags: (client.tags ?? []).map((tag) => sanitizeInline(tag, 80)),
      secrecyDefault: Number(client.secrecyDefault ?? 0),
    },
    counts: pickCounts(status.counts),
    nextDueAt: status.nextDueAt ?? null,
    projects: (status.projects ?? []).map((project) => ({
      id: String(project.id),
      name: sanitizeInline(project.name, 200),
      status: String(project.status ?? ''),
      counts: pickCounts(project.counts),
      nextDueAt: project.nextDueAt ?? null,
    })),
    open: {
      mine: (status.open?.mine ?? []).map(pickOpenItem),
      waiting: (status.open?.waiting ?? []).map(pickOpenItem),
      mineTotal: Number(status.open?.mineTotal ?? 0),
      waitingTotal: Number(status.open?.waitingTotal ?? 0),
    },
    timeline,
    timelineTotal,
    timelineTruncated: timelineTotal > timeline.length,
    facts,
    protectedExcluded: Number(status.protectedExcluded ?? 0),
  }
}

function timelinePageData(status, timelineLimit = 100) {
  const client = status.client
  const timeline = (status.timeline ?? []).slice(0, timelineLimit).map(pickTimelineItem)
  const timelineTotal = Number(status.timelineTotal ?? (status.timeline ?? []).length)
  return {
    version: 1,
    kind: 'timeline',
    generator: KB_PAGE_GENERATOR,
    owner: { clientId: String(client.id), matterId: null },
    client: { id: String(client.id), name: sanitizeInline(client.name, 200), status: String(client.status ?? '') },
    timeline,
    timelineTotal,
    timelineTruncated: timelineTotal > timeline.length,
    protectedExcluded: Number(status.protectedExcluded ?? 0),
  }
}

function projectPageData(store, client, projectRow, projectStatus, status, clearance) {
  const clientLevel = Number(client.secrecyDefault ?? 0)
  if (clientLevel > clearance) return null
  const matterRows = store.listMattersByProject(projectRow.id)
  const visibleMatters = []
  let protectedMatters = 0
  for (const matter of matterRows) {
    if (Math.max(clientLevel, Number(matter.secrecy ?? 0)) <= clearance) visibleMatters.push(matter)
    else protectedMatters += 1
  }
  const matterIds = visibleMatters.map((matter) => String(matter.id))
  const allowed = new Set(matterIds)
  let deliveries = []
  if (matterIds.length) {
    const placeholders = matterIds.map(() => '?').join(',')
    deliveries = store.db.prepare('SELECT id, matter_id, title, tool, created_at FROM deliveries WHERE matter_id IN (' + placeholders + ') ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(...matterIds, DELIVERY_PREVIEW_MAX)
  }
  const pickProjectOpen = (items) => (items ?? [])
    .filter((item) => item.matterId !== undefined && allowed.has(String(item.matterId)))
    .map(pickOpenItem)
  return {
    version: 1,
    kind: 'project',
    generator: KB_PAGE_GENERATOR,
    owner: { clientId: String(client.id), matterId: null },
    project: {
      id: String(projectRow.id),
      name: sanitizeInline(projectRow.name, 200),
      status: String(projectRow.status ?? ''),
      startedAt: projectRow.startedAt ?? null,
      dueAt: projectRow.dueAt ?? null,
      defaultMatterId: projectRow.defaultMatterId ?? null,
      createdAt: projectRow.createdAt ?? null,
      updatedAt: projectRow.updatedAt ?? null,
    },
    client: { id: String(client.id), name: sanitizeInline(client.name, 200), status: String(client.status ?? ''), secrecyDefault: clientLevel },
    counts: pickCounts(projectStatus?.counts),
    nextDueAt: projectStatus?.nextDueAt ?? null,
    matters: visibleMatters.map((matter) => ({ id: String(matter.id), title: sanitizeInline(matter.title, 200), status: String(matter.status ?? '') })),
    deliveries: deliveries.map((delivery) => ({
      id: String(delivery.id),
      matterId: String(delivery.matter_id),
      title: sanitizeInline(delivery.title ?? delivery.tool ?? delivery.id, 200),
      tool: delivery.tool === null || delivery.tool === undefined ? null : sanitizeInline(delivery.tool, 80),
      createdAt: String(delivery.created_at ?? ''),
    })),
    open: {
      mine: pickProjectOpen(status.open?.mine),
      waiting: pickProjectOpen(status.open?.waiting),
      mineTotal: Number(projectStatus?.counts?.openMine ?? 0),
      waitingTotal: Number(projectStatus?.counts?.openWaiting ?? 0),
    },
    protectedExcluded: protectedMatters + Number(status.protectedExcluded ?? 0),
  }
}

function factsPageData(store, subject, matterId, clearance) {
  const matter = matterId === null || matterId === undefined ? undefined : store.getMatter(String(matterId))
  if (matterId !== null && matterId !== undefined && !matter) return null
  const client = matter && matter.clientId ? store.getClient(String(matter.clientId)) : undefined
  if (matter && matter.clientId && !client) return null
  const level = Math.max(Number(client?.secrecyDefault ?? 0), Number(matter?.secrecy ?? 0))
  if (level > clearance) return null
  const rows = store.db.prepare("SELECT id, matter_id, subject, predicate, object, authority, confidence, status, recorded_at, valid_from, valid_to, supersedes, superseded_by, evidence FROM facts WHERE subject = ? AND (matter_id IS ?) AND deleted_at IS NULL ORDER BY recorded_at ASC, id ASC LIMIT ?")
    .all(String(subject), matterId === null || matterId === undefined ? null : String(matterId), KB_PAGE_FACTS_PER_GROUP_MAX)
  if (!rows.length) return null
  return {
    version: 1,
    kind: 'facts',
    generator: KB_PAGE_GENERATOR,
    owner: { clientId: client ? String(client.id) : null, matterId: matter ? String(matter.id) : null },
    subject: sanitizeInline(subject, 200),
    matterId: matter ? String(matter.id) : null,
    facts: rows.map(factView),
  }
}

/* -------------------------------------------------------------------------- */
/* markdown renderers (pure functions of the data)                            */
/* -------------------------------------------------------------------------- */

function table(header, rows) {
  const lines = ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |']
  for (const row of rows) lines.push('| ' + row.join(' | ') + ' |')
  return lines
}

function countsLine(counts) {
  return 'matters ' + counts.matters + ' (archived ' + counts.mattersArchived + '), deliveries ' + counts.deliveries
    + ', notes ' + counts.notes + ', commitments ' + counts.commitments
    + ', open mine ' + counts.openMine + ', open waiting ' + counts.openWaiting
}

function openLines(items) {
  return items.map((item) => '- [ ] ' + cell(item.action) + ' (' + cell(item.matterId ?? '-') + ')' + (item.dueAt ? ' due ' + cell(item.dueAt) : ''))
}

function timelineLines(items) {
  return items.map((item) => '- ' + cell(item.at) + ' ' + cell(item.kind) + ': ' + cell(item.title) + ' (' + cell(item.ref.kind) + ':' + cell(item.ref.id) + ')')
}

function factLines(items) {
  return items.map((fact) => '- ' + cell(fact.predicate) + ' = ' + cell(fact.object)
    + (fact.validFrom ? ' (from ' + cell(fact.validFrom) + ')' : '')
    + (fact.validTo ? ' (until ' + cell(fact.validTo) + ')' : '')
    + ' [' + cell(fact.status) + ']')
}

function renderClientMarkdown(data) {
  const lines = []
  lines.push('# Client: ' + sanitizeInline(data.client.name))
  lines.push('')
  lines.push('- id: ' + data.client.id)
  lines.push('- status: ' + data.client.status)
  lines.push('- aliases: ' + (data.client.aliases.length ? data.client.aliases.join(', ') : '(none)'))
  lines.push('- tags: ' + (data.client.tags.length ? data.client.tags.join(', ') : '(none)'))
  lines.push('- secrecy default: ' + data.client.secrecyDefault)
  lines.push('- next due: ' + (data.nextDueAt ?? '(none)'))
  lines.push('- counts: ' + countsLine(data.counts))
  if (data.protectedExcluded > 0) lines.push('- protected excluded: ' + data.protectedExcluded)
  lines.push('')
  lines.push('## Projects')
  if (!data.projects.length) lines.push('(none)')
  else lines.push(...table(['Project', 'Status', 'Matters', 'Deliveries', 'Commitments', 'Next due'], data.projects.map((project) => [
    cell(project.name),
    cell(project.status),
    String(project.counts.matters),
    String(project.counts.deliveries),
    String(project.counts.commitments),
    cell(project.nextDueAt ?? '(none)'),
  ])))
  lines.push('')
  lines.push('## Open commitments (mine)')
  lines.push(...(data.open.mine.length ? openLines(data.open.mine) : ['(none)']))
  lines.push('')
  lines.push('## Open commitments (waiting on client)')
  lines.push(...(data.open.waiting.length ? openLines(data.open.waiting) : ['(none)']))
  lines.push('')
  lines.push('## Timeline (' + data.timeline.length + ' of ' + data.timelineTotal + ')')
  lines.push(...(data.timeline.length ? timelineLines(data.timeline) : ['(none)']))
  lines.push('')
  lines.push('## Facts')
  lines.push(...(data.facts.length ? factLines(data.facts) : ['(none)']))
  lines.push('')
  lines.push('_generator: ' + data.generator + '_')
  return lines.join('\n')
}

function renderProjectMarkdown(data) {
  const lines = []
  lines.push('# Project: ' + sanitizeInline(data.project.name))
  lines.push('')
  lines.push('- id: ' + data.project.id)
  lines.push('- client: ' + data.client.id + ' (' + data.client.name + ')')
  lines.push('- status: ' + data.project.status)
  lines.push('- started at: ' + (data.project.startedAt ?? '(none)'))
  lines.push('- due at: ' + (data.project.dueAt ?? '(none)'))
  lines.push('- default matter: ' + (data.project.defaultMatterId ?? '(none)'))
  lines.push('- next due: ' + (data.nextDueAt ?? '(none)'))
  lines.push('- counts: ' + countsLine(data.counts))
  if (data.protectedExcluded > 0) lines.push('- protected excluded: ' + data.protectedExcluded)
  lines.push('')
  lines.push('## Matters')
  if (!data.matters.length) lines.push('(none)')
  else lines.push(...table(['Matter', 'Status', 'Title'], data.matters.map((matter) => [cell(matter.id), cell(matter.status), cell(matter.title)])))
  lines.push('')
  lines.push('## Deliveries (' + data.deliveries.length + ' shown)')
  if (!data.deliveries.length) lines.push('(none)')
  else for (const delivery of data.deliveries) lines.push('- ' + cell(delivery.createdAt) + ' ' + cell(delivery.title) + ' (' + cell(delivery.id) + ')')
  lines.push('')
  lines.push('## Open commitments (mine)')
  lines.push(...(data.open.mine.length ? openLines(data.open.mine) : ['(none)']))
  lines.push('')
  lines.push('## Open commitments (waiting on client)')
  lines.push(...(data.open.waiting.length ? openLines(data.open.waiting) : ['(none)']))
  lines.push('')
  lines.push('_generator: ' + data.generator + '_')
  return lines.join('\n')
}

function renderTimelineMarkdown(data) {
  const lines = []
  lines.push('# Timeline: ' + sanitizeInline(data.client.name))
  lines.push('')
  lines.push('- client: ' + data.client.id)
  lines.push('- events: ' + data.timeline.length + ' of ' + data.timelineTotal)
  if (data.protectedExcluded > 0) lines.push('- protected excluded: ' + data.protectedExcluded)
  lines.push('')
  lines.push('## Events')
  lines.push(...(data.timeline.length ? timelineLines(data.timeline) : ['(none)']))
  lines.push('')
  lines.push('_generator: ' + data.generator + '_')
  return lines.join('\n')
}

function renderFactsMarkdown(data) {
  const lines = []
  lines.push('# Facts: ' + sanitizeInline(data.subject))
  lines.push('')
  if (data.matterId) lines.push('- matter: ' + data.matterId)
  if (data.owner.clientId) lines.push('- client: ' + data.owner.clientId)
  lines.push('')
  lines.push('## Facts')
  if (!data.facts.length) lines.push('(none)')
  for (const fact of data.facts) {
    lines.push('### ' + cell(fact.predicate) + ' = ' + cell(fact.object))
    lines.push('')
    lines.push('- status: ' + fact.status)
    lines.push('- authority: ' + fact.authority + ', confidence: ' + fact.confidence)
    lines.push('- recorded at: ' + fact.recordedAt)
    lines.push('- valid from: ' + (fact.validFrom ?? '(none)'))
    lines.push('- valid to: ' + (fact.validTo ?? '(none)'))
    if (fact.supersedes) lines.push('- supersedes: ' + fact.supersedes)
    if (fact.supersededBy) lines.push('- superseded by: ' + fact.supersededBy)
    for (const evidence of fact.evidence) {
      lines.push('- evidence: ' + (evidence.quote ?? '') + (evidence.ref ? ' [' + evidence.ref + ']' : ''))
    }
    lines.push('')
  }
  lines.push('_generator: ' + data.generator + '_')
  return lines.join('\n')
}

function pageTitle(data) {
  if (data.kind === 'client') return 'Client: ' + data.client.name
  if (data.kind === 'project') return 'Project: ' + data.project.name
  if (data.kind === 'timeline') return 'Timeline: ' + data.client.name
  return 'Facts: ' + data.subject
}

function renderMarkdown(data) {
  if (data.kind === 'client') return renderClientMarkdown(data)
  if (data.kind === 'project') return renderProjectMarkdown(data)
  if (data.kind === 'timeline') return renderTimelineMarkdown(data)
  return renderFactsMarkdown(data)
}

/* -------------------------------------------------------------------------- */
/* page assembly + builders                                                   */
/* -------------------------------------------------------------------------- */

function makePage(pageId, subjectId, data) {
  const json = canonicalJson(data)
  return {
    id: String(pageId),
    kind: String(data.kind),
    subjectId: String(subjectId),
    title: sanitizeInline(pageTitle(data), 200),
    markdown: renderMarkdown(data),
    json,
    sourceRefs: collectSourceRefs(data),
    inputsSha256: sha256Hex(json),
    data,
  }
}

function buildClientPage(status, facts) {
  return makePage(clientPageId(status.client.id), status.client.id, clientPageData(status, facts))
}

function buildTimelinePage(status) {
  return makePage(timelinePageId(status.client.id), status.client.id, timelinePageData(status))
}

function buildProjectPage(store, client, projectRow, projectStatus, status, clearance) {
  const data = projectPageData(store, client, projectRow, projectStatus, status, clearance)
  if (!data) return null
  return makePage(projectPageId(projectRow.id), projectRow.id, data)
}

function buildFactsPage(store, subject, matterId, clearance) {
  const data = factsPageData(store, subject, matterId, clearance)
  if (!data) return null
  const key = matterId === null || matterId === undefined ? null : String(matterId)
  return makePage(factsPageId(subject, key), factsPageKey(subject, key), data)
}

function buildAllPages(store, { clearance, kind = null }) {
  const pages = []
  const degraded = []
  let skipped = 0
  const want = (value) => kind === null || kind === value
  const clients = store.listClients({ status: 'all', includeDeleted: false, limit: 1000 })
  for (const client of clients) {
    const clientLevel = Number(client.secrecyDefault ?? 0)
    if (clientLevel > clearance) { skipped += 1; continue }
    let status = null
    try {
      status = readClientStatus(store, client.id, { clearance, timelineLimit: 100, openLimit: 20 })
    } catch (error) {
      degraded.push('client_read_failed')
      skipped += 1
      continue
    }
    if (!status) { skipped += 1; continue }
    if (want('client')) pages.push(buildClientPage(status, currentFactsForClient(store, client.id, clearance, clientLevel)))
    if (want('timeline')) pages.push(buildTimelinePage(status))
    if (want('project')) {
      for (const projectStatus of status.projects ?? []) {
        const projectRow = typeof store.getProject === 'function' ? store.getProject(projectStatus.id) : undefined
        if (!projectRow) { skipped += 1; continue }
        const page = buildProjectPage(store, client, projectRow, projectStatus, status, clearance)
        if (page) pages.push(page)
        else skipped += 1
      }
    }
  }
  if (want('facts')) {
    const groups = store.db.prepare('SELECT subject, matter_id FROM facts WHERE deleted_at IS NULL GROUP BY subject, matter_id ORDER BY subject ASC, matter_id ASC LIMIT ?').all(KB_PAGE_FACTS_MAX + 1)
    if (groups.length > KB_PAGE_FACTS_MAX) {
      degraded.push('facts_pages_capped')
      groups.length = KB_PAGE_FACTS_MAX
    }
    for (const group of groups) {
      if (group.subject === null || group.subject === undefined) { skipped += 1; continue }
      const matterId = group.matter_id === null || group.matter_id === undefined ? null : String(group.matter_id)
      const page = buildFactsPage(store, group.subject, matterId, clearance)
      if (page) pages.push(page)
      else skipped += 1
    }
  }
  return { pages, degraded: [...new Set(degraded)].sort(), skipped }
}

function buildPageByIdentity(store, identity, { clearance, storedRow = null } = {}) {
  if (!identity) return null
  if (identity.kind === 'client' || identity.kind === 'timeline') {
    const client = typeof store.getClient === 'function' ? store.getClient(identity.clientId) : undefined
    if (!client || client.deletedAt) return null
    const clientLevel = Number(client.secrecyDefault ?? 0)
    if (clientLevel > clearance) return null
    const status = readClientStatus(store, client.id, { clearance, timelineLimit: 100, openLimit: 20 })
    if (!status) return null
    if (identity.kind === 'client') return buildClientPage(status, currentFactsForClient(store, client.id, clearance, clientLevel))
    return buildTimelinePage(status)
  }
  if (identity.kind === 'project') {
    const project = typeof store.getProject === 'function' ? store.getProject(identity.projectId) : undefined
    if (!project || project.deletedAt) return null
    const client = typeof store.getClient === 'function' ? store.getClient(project.clientId) : undefined
    if (!client || client.deletedAt) return null
    const clientLevel = Number(client.secrecyDefault ?? 0)
    if (clientLevel > clearance) return null
    const status = readClientStatus(store, client.id, { clearance, timelineLimit: 100, openLimit: 20 })
    if (!status) return null
    const projectStatus = (status.projects ?? []).find((projectRow) => projectRow.id === project.id)
    return buildProjectPage(store, client, project, projectStatus, status, clearance)
  }
  if (identity.kind === 'facts') {
    let subject = null
    let matterId = null
    if (storedRow) {
      try {
        const data = JSON.parse(String(storedRow.json ?? ''))
        subject = stringOrNull(data.subject)
        matterId = stringOrNull(data.matterId)
      } catch { subject = null }
    }
    if (subject === null) return null
    return buildFactsPage(store, subject, matterId, clearance)
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* stored views + public API                                                  */
/* -------------------------------------------------------------------------- */

function normalizeClearance(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.floor(number)
}

function clampLimit(value, fallback, max) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) return fallback
  return Math.min(number, max)
}

function storedPageView(row) {
  let data = null
  try { data = JSON.parse(String(row.json ?? '')) } catch { data = null }
  let sourceRefs = []
  try {
    const parsed = JSON.parse(String(row.source_refs ?? '[]'))
    if (Array.isArray(parsed)) sourceRefs = parsed
  } catch { sourceRefs = [] }
  return {
    id: String(row.id),
    kind: String(row.kind),
    subjectId: String(row.subject_id),
    title: sanitizeInline(row.title, 200),
    markdown: String(row.markdown ?? ''),
    data,
    sourceRefs,
    inputsSha256: String(row.inputs_sha256),
    generatedAt: String(row.generated_at),
    status: String(row.status),
  }
}

function livePageView(page) {
  return {
    id: page.id,
    kind: page.kind,
    subjectId: page.subjectId,
    title: page.title,
    markdown: page.markdown,
    data: page.data,
    sourceRefs: page.sourceRefs,
    inputsSha256: page.inputsSha256,
    generatedAt: null,
    status: 'live',
  }
}

/**
 * List stored pages. check:true recomputes every page against the live ledger
 * and reports stale/staleReason (pure read; nothing is written).
 */
export function kbPageList(store, options = {}) {
  assertKbPagesSchema(store)
  const kind = options.kind === undefined || options.kind === null ? null : String(options.kind)
  if (kind !== null && !KB_PAGE_KINDS.includes(kind)) throw entityError('E_KB_INVALID', 'unknown page kind: ' + kind, 'use one of ' + KB_PAGE_KINDS.join(', '))
  const check = options.check === true
  const clearance = normalizeClearance(options.clearance === undefined ? 3 : options.clearance)
  const limit = clampLimit(options.limit, KB_PAGE_LIST_LIMIT, KB_PAGE_LIST_LIMIT_MAX)
  const filterId = options.id === undefined || options.id === null ? null : String(options.id)
  return store.read(() => {
    const maps = loadOwnerMaps(store)
    const rows = store.db.prepare('SELECT * FROM kb_pages WHERE deleted_at IS NULL ORDER BY kind ASC, id ASC').all()
    const summaries = []
    let protectedExcluded = 0
    let staleCount = 0
    for (const row of rows) {
      if (kind !== null && String(row.kind) !== kind) continue
      if (filterId !== null && String(row.id) !== filterId) continue
      const owner = pageOwnerFromRow(row, maps)
      const level = ownerSecrecy(maps, owner)
      if (!Number.isFinite(level) || level > clearance) { protectedExcluded += 1; continue }
      const summary = {
        id: String(row.id),
        kind: String(row.kind),
        subjectId: String(row.subject_id),
        title: sanitizeInline(row.title, 200),
        generatedAt: String(row.generated_at),
        status: String(row.status),
        inputsSha256: String(row.inputs_sha256),
        stale: null,
      }
      if (check) {
        const identity = parseKbPageId(row.id)
        let live = null
        try { live = identity ? buildPageByIdentity(store, identity, { clearance, storedRow: row }) : null } catch { live = null }
        if (!live) {
          summary.stale = true
          summary.staleReason = 'source_missing'
        } else {
          summary.stale = live.inputsSha256 !== String(row.inputs_sha256)
          if (summary.stale) summary.staleReason = 'inputs_changed'
        }
        if (summary.stale) staleCount += 1
      }
      summaries.push(summary)
    }
    summaries.sort((a, b) => ((KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const total = summaries.length
    const pages = summaries.slice(0, limit)
    return {
      ok: true,
      command: 'kb page ls',
      pages,
      total,
      truncated: total > pages.length,
      limit,
      clearance,
      protectedExcluded,
      ...(check ? { staleCount } : {}),
    }
  })
}

/**
 * Show one page. Default recomputes it live from the ledger (pure read) and
 * reports stale vs the stored row; stored:true returns the stored content.
 */
export function kbPageShow(store, id, options = {}) {
  assertKbPagesSchema(store)
  const key = typeof id === 'string' ? id.trim() : ''
  if (!key) throw entityError('E_KB_INVALID', 'page id is required')
  const stored = options.stored === true
  const wantDiff = options.diff === true
  const clearance = normalizeClearance(options.clearance === undefined ? 3 : options.clearance)
  return store.read(() => {
    const row = store.db.prepare('SELECT * FROM kb_pages WHERE id = ? AND deleted_at IS NULL').get(key) ?? null
    const maps = loadOwnerMaps(store)
    if (row) {
      const owner = pageOwnerFromRow(row, maps)
      const level = ownerSecrecy(maps, owner)
      if (!Number.isFinite(level) || level > clearance) throw entityError('E_KB_PAGE_NOT_FOUND', 'unknown page: ' + key)
    }
    const identity = parseKbPageId(key)
    if (!identity) throw entityError('E_KB_PAGE_NOT_FOUND', 'unknown page: ' + key)
    if (stored && !row) throw entityError('E_KB_PAGE_NOT_FOUND', 'unknown page: ' + key)
    const live = buildPageByIdentity(store, identity, { clearance, storedRow: row })
    if (!live) {
      if (!row) throw entityError('E_KB_PAGE_NOT_FOUND', 'unknown page: ' + key)
      return {
        ok: true,
        command: 'kb page show',
        page: storedPageView(row),
        live: null,
        stale: true,
        staleReason: 'source_missing',
        stored: { exists: true, inputsSha256: String(row.inputs_sha256), generatedAt: String(row.generated_at), status: String(row.status) },
        clearance,
      }
    }
    const stale = !row || String(row.inputs_sha256) !== live.inputsSha256
    const page = stored && row ? storedPageView(row) : livePageView(live)
    const result = {
      ok: true,
      command: 'kb page show',
      page,
      live: { inputsSha256: live.inputsSha256, markdown: live.markdown, data: live.data, sourceRefs: live.sourceRefs },
      stale,
      stored: {
        exists: Boolean(row),
        inputsSha256: row ? String(row.inputs_sha256) : null,
        generatedAt: row ? String(row.generated_at) : null,
        status: row ? String(row.status) : null,
      },
      clearance,
    }
    if (wantDiff && row && stale) result.diff = unifiedDiff(String(row.markdown ?? ''), live.markdown)
    return result
  })
}

/** Line-based unified diff (bounded LCS); no dependency and no DOM/HTML. */
export function unifiedDiff(before, after) {
  const a = String(before ?? '').replace(/\r\n/g, '\n').split('\n')
  const b = String(after ?? '').replace(/\r\n/g, '\n').split('\n')
  if (a.length > 400 || b.length > 400) {
    return '@@ page too large for an inline line diff @@' + '\n' + '- before: ' + a.length + ' lines' + '\n' + '+ after: ' + b.length + ' lines'
  }
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lines = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push('  ' + a[i])
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push('- ' + a[i])
      i += 1
    } else {
      lines.push('+ ' + b[j])
      j += 1
    }
  }
  while (i < n) { lines.push('- ' + a[i]); i += 1 }
  while (j < m) { lines.push('+ ' + b[j]); j += 1 }
  return lines.join('\n')
}

function existingPageHashes(store) {
  const map = new Map()
  for (const row of store.db.prepare('SELECT id, inputs_sha256 FROM kb_pages').all()) map.set(String(row.id), String(row.inputs_sha256))
  return map
}

function rebuildBuild(store, { clearance, kind, id }) {
  if (id === null) return buildAllPages(store, { clearance, kind })
  const stored = store.db.prepare('SELECT * FROM kb_pages WHERE id = ?').get(id) ?? null
  const identity = parseKbPageId(id)
  const page = buildPageByIdentity(store, identity, { clearance, storedRow: stored })
  if (!page) throw entityError('E_KB_PAGE_NOT_FOUND', 'page cannot be derived: ' + id)
  return { pages: [page], degraded: [], skipped: 0 }
}

/**
 * Rebuild computed pages. This is the only write path: one transaction, one
 * audit row, and only rows whose inputsSha256 changed are rewritten (so a
 * no-op rebuild is byte-identical). dryRun computes the same plan without
 * writing. onlyStale is accepted for CLI symmetry; the incremental rule above
 * already writes only stale rows.
 */
export function kbPageRebuild(store, options = {}) {
  assertKbPagesSchema(store)
  const kind = options.kind === undefined || options.kind === null ? null : String(options.kind)
  if (kind !== null && !KB_PAGE_KINDS.includes(kind)) throw entityError('E_KB_INVALID', 'unknown page kind: ' + kind, 'use one of ' + KB_PAGE_KINDS.join(', '))
  const id = options.id === undefined || options.id === null ? null : String(options.id)
  const clearance = normalizeClearance(options.clearance === undefined ? 3 : options.clearance)
  const dryRun = options.dryRun === true
  if (id !== null) {
    const identity = parseKbPageId(id)
    if (!identity) throw entityError('E_KB_PAGE_NOT_FOUND', 'unknown page id: ' + id)
    if (kind !== null && identity.kind !== kind) throw entityError('E_KB_INVALID', 'page id does not match kind ' + kind)
  }
  const plan = (built, existing) => {
    const written = []
    let unchanged = 0
    for (const page of built.pages) {
      if (existing.get(page.id) === page.inputsSha256) { unchanged += 1; continue }
      written.push(page)
    }
    return { written, unchanged }
  }
  if (dryRun) {
    return store.read(() => {
      const built = rebuildBuild(store, { clearance, kind, id })
      const planned = plan(built, existingPageHashes(store))
      return {
        ok: true,
        command: 'kb page rebuild',
        dryRun: true,
        counts: { built: built.pages.length, written: planned.written.length, unchanged: planned.unchanged, skipped: built.skipped },
        pages: planned.written.map((page) => ({ id: page.id, kind: page.kind })),
        degraded: built.degraded,
        clearance,
      }
    })
  }
  const audit = { actor: 'local', action: 'kb.page.rebuild', allowed: true, reason: '' }
  const outcome = store.mutate(() => {
    const built = rebuildBuild(store, { clearance, kind, id })
    const planned = plan(built, existingPageHashes(store))
    const generatedAt = new Date().toISOString()
    const insert = store.db.prepare('INSERT OR REPLACE INTO kb_pages(id,kind,subject_id,title,markdown,json,source_refs,inputs_sha256,generated_at,status,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    for (const page of planned.written) {
      insert.run(page.id, page.kind, page.subjectId, page.title, page.markdown, page.json, JSON.stringify(page.sourceRefs), page.inputsSha256, generatedAt, 'generated', null)
    }
    audit.reason = 'built ' + built.pages.length + ', written ' + planned.written.length + ', unchanged ' + planned.unchanged
    return { built: built.pages.length, written: planned.written, unchanged: planned.unchanged, skipped: built.skipped, degraded: built.degraded }
  }, audit)
  return {
    ok: true,
    command: 'kb page rebuild',
    dryRun: false,
    counts: { built: outcome.result.built, written: outcome.result.written.length, unchanged: outcome.result.unchanged, skipped: outcome.result.skipped },
    pages: outcome.result.written.map((page) => ({ id: page.id, kind: page.kind })),
    degraded: outcome.result.degraded,
    clearance,
  }
}

/** Convenience wrapper for `kb page diff`: stale flag plus a bounded line diff. */
export function kbPageDiff(store, id, options = {}) {
  const shown = kbPageShow(store, id, { ...options, diff: true })
  return { ok: true, command: 'kb page diff', pageId: shown.page.id, stale: shown.stale, diff: shown.diff ?? '' }
}

export default Object.freeze({
  KB_PAGE_KINDS,
  KB_PAGE_GENERATOR,
  KB_PAGE_LIST_LIMIT,
  KB_PAGE_LIST_LIMIT_MAX,
  KB_PAGE_FACTS_MAX,
  KB_PAGE_FACTS_PER_GROUP_MAX,
  KB_PAGE_FACT_EVIDENCE_MAX,
  clientPageId,
  projectPageId,
  timelinePageId,
  factsPageKey,
  factsPageId,
  parseKbPageId,
  canonicalJson,
  sha256Hex,
  unifiedDiff,
  kbPageList,
  kbPageShow,
  kbPageRebuild,
  kbPageDiff,
  assertKbPagesSchema,
})


