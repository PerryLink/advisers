// ---------------------------------------------------------------------------
// Read-tool payload assembly for the DSH adapter (0.3.0).
//
// The adapter is a thin channel: it owns the tool protocol/schemas/rendering
// and the payload shape, never SQL/schema/TOS/vault policy. All ledger policy
// lives in the `advisers/lib/ledger-read.js` facade, which is imported LAZILY
// and defensively: an older `advisers` package without the subpath, or a host
// without `node:sqlite`, must fall back to the marked preview instead of
// failing plugin load.
//
// Three data origins are possible:
//   - real ledger : facade read at clearance 0 -> preview:false /
//                   source:"ledger-readonly" (+ backend/clearance/protected
//                   Excluded/warnings); read-only, no HOME lock, no migration.
//   - preview     : no ledger found, facade unavailable, or config.mode
//                   "preview" (the kill switch) -> the 0.2.x in-memory view
//                   with preview:true / source:"preview-no-ledger"/note.
//   - error       : TOS missing/revoked/changed, vault sealed, stale/newer
//                   schema, corrupt/busy/unavailable ledger -> a structured
//                   { ok:false, error:{ code, message, hint? } } envelope.
// A missing ledger is NOT an error (first-run preview is kept); every other
// gate failure is, so 'no data' can never masquerade as 'not allowed'.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

/** Error codes visible to the DSH host (additive; 0.x only grows this set). */
export const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  UNKNOWN_ID_PREFIX: 'UNKNOWN_ID_PREFIX',
  EVIDENCE_NOT_FOUND: 'EVIDENCE_NOT_FOUND',
  EVIDENCE_PROTECTED: 'EVIDENCE_PROTECTED',
  CLIENT_NOT_FOUND: 'CLIENT_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  LEDGER_TOS_REQUIRED: 'LEDGER_TOS_REQUIRED',
  LEDGER_VAULT_SEALED: 'LEDGER_VAULT_SEALED',
  LEDGER_SCHEMA_STALE: 'LEDGER_SCHEMA_STALE',
  LEDGER_SCHEMA_NEWER: 'LEDGER_SCHEMA_NEWER',
  LEDGER_CORRUPT: 'LEDGER_CORRUPT',
  LEDGER_UNAVAILABLE: 'LEDGER_UNAVAILABLE',
  LEDGER_BUSY: 'LEDGER_BUSY',
})

/** Stable structured error for a read tool; executeRead renders it, never throws. */
export class ReadToolError extends Error {
  constructor(code, message, hint) {
    super(String(message))
    this.name = 'ReadToolError'
    this.code = String(code)
    if (hint) this.hint = String(hint)
  }
}

const TIME_ZONE = 'Asia/Shanghai'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const QUOTE_CAP = 500
const TODAY_LIST_CAP = 10
const WHO_LIST_CAP = 50
const EVIDENCE_LIST_CAP = 20
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE })

/** Preview disclosure (kept from 0.2.x, reworded for the 0.3.0 read wiring). */
export const PREVIEW_NOTE = 'Preview only: the DSH adapter did not read ~/.advisers/state.db (no ledger was found, or preview mode is configured), so this comes from an empty in-memory ledger, not your real books. Run `advisers init` to create the ledger, or use the advisers CLI/MCP for real data.'
/** Real-ledger disclosure. */
export const LEDGER_NOTE = 'Read-only snapshot of the local ledger; call again to refresh.'
/** Customer disclosure for the legacy JSON store (it has no customer tables). */
export const JSON_CUSTOMER_NOTE = 'Read-only snapshot of the JSON ledger; it has no customer tables (clients/projects require the SQLite store), so no client rows are available.'
/** Client-list page default/cap of the DSH adapter. */
const CLIENT_LIST_DEFAULT = 20
const CLIENT_LIST_MAX = 50

/* -------------------------------------------------------------------------- */
/* read disclosure (0.5.0 M1)                                                 */
/* -------------------------------------------------------------------------- */
// The DSH adapter is a read-only projection and never writes the advisers
// tamper-evident audit chain, so every disclosure is audited:false. Row views
// are derived from the local read model only: the adapter has no turn store and
// therefore never claims `verified` (that word would mean a local evidence
// pointer resolved, which only the CLI/MCP ledgers can check).
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
}

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function disclosureFieldsOf(rows) {
  const fields = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    for (const key of Object.keys(row)) if (key !== 'view') fields.add(key)
  }
  return [...fields].sort()
}

function disclosureViewCounts(views) {
  const counts = { verified: 0, pending: 0, historical: 0, derived: 0 }
  for (const view of Array.isArray(views) ? views : []) if (Object.prototype.hasOwnProperty.call(counts, view)) counts[view] += 1
  return counts
}

/** preview and the legacy JSON store never resolve evidence: basis=preview. */
function dshBasis(marker) {
  return marker && (marker.preview === true || marker.backend === 'json') ? 'preview' : 'local-resolution'
}

function dshCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
}

/**
 * Row view from the local read model only. `preview` never claims more than
 * pending; a real ledger read can report historical for closed rows, but the
 * adapter has no turn store, so it never reports verified.
 */
function dshStatusView(kind, row, basis) {
  if (kind === 'client') return basis === 'preview' ? 'pending' : 'derived'
  if (basis === 'preview') return 'pending'
  const status = typeof row?.status === 'string' ? row.status : ''
  if (kind === 'commitment') return status === 'done' || status === 'dropped' ? 'historical' : 'pending'
  if (kind === 'fact') return status === 'superseded' || status === 'deleted' || row?.expiredAt ? 'historical' : 'pending'
  if (kind === 'preference') return status === 'deprecated' ? 'historical' : 'pending'
  return 'pending'
}

function buildDshDisclosure({ tool, basis, fields, views, clearance, protectedExcluded, truncated }) {
  const disclosure = {
    surface: 'dsh',
    tool,
    basis: basis === 'preview' ? 'preview' : 'local-resolution',
    callId: '',
    fields: (() => { const set = new Set(); for (const field of Array.isArray(fields) ? fields : []) if (typeof field === 'string' && field && field !== 'view') set.add(field); return [...set].sort() })(),
    view: disclosureViewCounts(views),
    clearance: dshCount(clearance),
    protectedExcluded: dshCount(protectedExcluded),
    truncated: truncated === true,
    audited: false,
    digest: '',
  }
  const digest = 'sha256:' + sha256Hex(canonicalJson({
    surface: disclosure.surface,
    tool: disclosure.tool,
    basis: disclosure.basis,
    fields: disclosure.fields,
    view: disclosure.view,
    clearance: disclosure.clearance,
    protectedExcluded: disclosure.protectedExcluded,
    truncated: disclosure.truncated,
  }))
  disclosure.callId = 'dc_' + digest.slice('sha256:'.length, 'sha256:'.length + 16)
  disclosure.digest = digest
  return disclosure
}

function annotateCommitmentLists(data, tool, lists) {
  const basis = dshBasis(data)
  const views = []
  const payload = { ...data }
  for (const key of lists) {
    if (!Array.isArray(data[key])) continue
    payload[key] = data[key].map((row) => {
      const view = dshStatusView('commitment', row, basis)
      views.push(view)
      return row && typeof row === 'object' ? { ...row, view } : row
    })
  }
  if (payload.next && typeof payload.next === 'object') payload.next = { ...payload.next, view: dshStatusView('commitment', payload.next, basis) }
  return {
    ...payload,
    disclosure: buildDshDisclosure({
      tool,
      basis,
      fields: disclosureFieldsOf(lists.flatMap((key) => (Array.isArray(data[key]) ? data[key] : []))),
      views,
      clearance: data.clearance,
      protectedExcluded: data.protectedExcluded,
      truncated: data.truncated === true,
    }),
  }
}

function annotateWhoPayload(data, tool) {
  const basis = dshBasis(data)
  const views = []
  const payload = { ...data }
  for (const key of ['mine', 'waiting']) {
    if (!Array.isArray(data[key])) continue
    payload[key] = data[key].map((row) => {
      const view = dshStatusView('commitment', row, basis)
      views.push(view)
      return row && typeof row === 'object' ? { ...row, view } : row
    })
  }
  return {
    ...payload,
    disclosure: buildDshDisclosure({
      tool,
      basis,
      fields: disclosureFieldsOf([...(Array.isArray(data.mine) ? data.mine : []), ...(Array.isArray(data.waiting) ? data.waiting : [])]),
      views,
      clearance: data.clearance,
      protectedExcluded: data.protectedExcluded,
      truncated: data.truncated === true,
    }),
  }
}

function annotateEvidencePayload(data, tool) {
  const basis = dshBasis(data)
  const record = data.record
  const view = dshStatusView(data.kind, record, basis)
  return {
    ...data,
    record: record && typeof record === 'object' ? { ...record, view } : record,
    disclosure: buildDshDisclosure({
      tool,
      basis,
      fields: disclosureFieldsOf([record]),
      views: [view],
      clearance: data.clearance,
      protectedExcluded: data.protectedExcluded,
      truncated: data.truncated === true,
    }),
  }
}

function annotateClientsPayload(data, tool) {
  const basis = dshBasis(data)
  if (data.action === 'list') {
    const rows = Array.isArray(data.clients) ? data.clients : []
    const views = rows.map(() => dshStatusView('client', null, basis))
    return {
      ...data,
      clients: rows.map((row, index) => (row && typeof row === 'object' ? { ...row, view: views[index] } : row)),
      disclosure: buildDshDisclosure({
        tool,
        basis,
        fields: disclosureFieldsOf(rows),
        views,
        clearance: data.clearance,
        protectedExcluded: data.protectedExcluded,
        truncated: data.truncated === true,
      }),
    }
  }
  const client = data.client
  const hasClient = Boolean(client && typeof client === 'object' && !Array.isArray(client))
  const view = dshStatusView('client', client, basis)
  return {
    ...data,
    ...(hasClient ? { client: { ...client, view } } : {}),
    disclosure: buildDshDisclosure({
      tool,
      basis,
      fields: hasClient ? disclosureFieldsOf([client]) : [],
      views: hasClient ? [view] : [],
      clearance: data.clearance,
      protectedExcluded: data.protectedExcluded,
      truncated: data.timelineTruncated === true,
    }),
  }
}

/** The 0.2.x preview marker; exactly the fields the 0.2.3 contract required. */
export function previewMarker() {
  return { preview: true, source: 'preview-no-ledger', note: PREVIEW_NOTE }
}

function withLedgerMarker(data, index) {
  const payload = {
    ...data,
    preview: false,
    source: 'ledger-readonly',
    note: LEDGER_NOTE,
    backend: index.backend,
    clearance: index.clearance,
    protectedExcluded: index.protectedExcluded,
  }
  if (Array.isArray(index.warnings) && index.warnings.length > 0) payload.warnings = index.warnings.slice()
  return payload
}

const asString = (value) => (typeof value === 'string' ? value : '')
const asQuote = (value) => (typeof value === 'string' ? value.slice(0, QUOTE_CAP) : '')

function commitmentView(commitment) {
  const view = {
    id: asString(commitment?.id),
    debtor: asString(commitment?.debtor),
    creditor: asString(commitment?.creditor),
    action: asString(commitment?.action),
    status: asString(commitment?.status),
  }
  if (typeof commitment?.dueAt === 'string' && commitment.dueAt) view.dueAt = commitment.dueAt
  if (typeof commitment?.matterId === 'string' && commitment.matterId) view.matterId = commitment.matterId
  return view
}

function dueAtMs(commitment) {
  if (!commitment || typeof commitment.dueAt !== 'string' || !commitment.dueAt) return Number.NaN
  return Date.parse(commitment.dueAt)
}

function localDayOfMs(ms) {
  return DAY_FORMAT.format(new Date(ms))
}

function isWaitingOnThirdParty(commitment) {
  const debtor = commitment?.debtor
  return debtor === 'third' || (typeof debtor === 'string' && debtor.startsWith('third:'))
}

/* -------------------------------------------------------------------------- */
/* shared today/who classification (real rows and the in-memory preview)       */
/* -------------------------------------------------------------------------- */

function buildToday(open) {
  const nowMs = Date.now()
  const localDay = localDayOfMs(nowMs)
  const weekAhead = nowMs + WEEK_MS
  const overdue = []
  const dueToday = []
  const week = []
  const waiting = []
  const noDue = []
  let next = null
  let nextMs = Number.POSITIVE_INFINITY
  // Cache parse+format per distinct dueAt string: a 200k ledger has ~66k open
  // commitments but only a few hundred distinct due dates (same trick as the
  // CLI today hot path).
  const dueCache = new Map()
  const dueInfo = (dueAt) => {
    let info = dueCache.get(dueAt)
    if (info === undefined) {
      const ms = Date.parse(dueAt)
      info = { ms, day: Number.isNaN(ms) ? null : localDayOfMs(ms) }
      dueCache.set(dueAt, info)
    }
    return info
  }
  for (const commitment of open) {
    if (isWaitingOnThirdParty(commitment)) waiting.push(commitment)
    if (!commitment?.dueAt) { noDue.push(commitment); continue }
    const info = dueInfo(commitment.dueAt)
    if (info.day === null) { noDue.push(commitment); continue }
    if (info.ms < nowMs) {
      if (info.day !== localDay) overdue.push(commitment)
      else dueToday.push(commitment)
    } else if (info.day === localDay) {
      dueToday.push(commitment)
    } else if (info.ms <= weekAhead) {
      week.push(commitment)
    }
    if (info.ms <= weekAhead && info.ms < nextMs) { nextMs = info.ms; next = commitment }
  }
  const counts = {
    open: open.length,
    overdue: overdue.length,
    today: dueToday.length,
    week: week.length,
    waiting: waiting.length,
    noDue: noDue.length,
  }
  const lists = [overdue, dueToday, week, waiting, noDue]
  const data = {
    now: new Date(nowMs).toISOString(),
    timezone: TIME_ZONE,
    localDay,
    counts,
    overdue: overdue.slice(0, TODAY_LIST_CAP).map(commitmentView),
    today: dueToday.slice(0, TODAY_LIST_CAP).map(commitmentView),
    week: week.slice(0, TODAY_LIST_CAP).map(commitmentView),
    waiting: waiting.slice(0, TODAY_LIST_CAP).map(commitmentView),
    noDue: noDue.slice(0, TODAY_LIST_CAP).map(commitmentView),
    truncated: lists.some((list) => list.length > TODAY_LIST_CAP),
  }
  if (next) data.next = commitmentView(next)
  return {
    data,
    audit: `open=${counts.open} overdue=${counts.overdue} today=${counts.today} week=${counts.week} waiting=${counts.waiting}`,
  }
}

function buildWho(open) {
  const mine = []
  const waiting = []
  for (const commitment of open) {
    if (isWaitingOnThirdParty(commitment)) waiting.push(commitment)
    else if (commitment?.debtor === 'user' || commitment?.debtor === 'agent') mine.push(commitment)
  }
  return {
    data: {
      counts: { mine: mine.length, waiting: waiting.length, open: open.length },
      mine: mine.slice(0, WHO_LIST_CAP).map(commitmentView),
      waiting: waiting.slice(0, WHO_LIST_CAP).map(commitmentView),
      truncated: mine.length > WHO_LIST_CAP || waiting.length > WHO_LIST_CAP,
    },
    audit: `mine=${mine.length} waiting=${waiting.length}`,
  }
}

function previewToday(runtime) {
  const { data, audit } = buildToday(runtime.ledger.openCommitments())
  return { data: { ...data, ...previewMarker() }, audit }
}

function previewWho(runtime) {
  const { data, audit } = buildWho(runtime.ledger.openCommitments())
  return { data: { ...data, ...previewMarker() }, audit }
}

/* -------------------------------------------------------------------------- */
/* evidence tracing (ledger refs only; the adapter never resolves turn bodies) */
/* -------------------------------------------------------------------------- */

function normalizeSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined
  const view = {}
  for (const key of ['type', 'subject', 'messageId', 'file']) {
    if (typeof source[key] === 'string' && source[key]) view[key] = source[key]
  }
  return Object.keys(view).length > 0 ? view : undefined
}

function parseEvidenceRef(ref) {
  if (typeof ref !== 'string') return null
  const text = ref.trim()
  const split = text.indexOf('#')
  if (split <= 0) return null
  const sessionId = text.slice(0, split)
  const turnId = text.slice(split + 1)
  if (!sessionId || !turnId || turnId.includes('#')) return null
  return { sessionId, turnId }
}

function traceCommitmentEvidence(commitment) {
  const sources = []
  const missing = []
  const evidence = Array.isArray(commitment?.evidence) ? commitment.evidence : []
  for (const item of evidence) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { missing.push({ reason: 'invalid_source' }); continue }
    const sessionId = asString(item.sessionId)
    const turnId = asString(item.turnId)
    const quote = asQuote(item.quote)
    const source = normalizeSource(item.source)
    if (!sessionId || !turnId) {
      const entry = { reason: 'invalid_evidence' }
      if (sessionId) entry.sessionId = sessionId
      if (turnId) entry.turnId = turnId
      if (quote) entry.quote = quote
      missing.push(entry)
      continue
    }
    const entry = { ref: `${sessionId}#${turnId}`, sessionId, turnId }
    if (quote) entry.quote = quote
    if (source) entry.source = source
    sources.push(entry)
  }
  return { sources, missing }
}

function traceSourceRefs(record) {
  const items = []
  const seen = new Set()
  const add = (item) => {
    if (!item || typeof item !== 'object') { items.push(item); return }
    const key = `${asString(item.ref)}\u0000${asString(item.quote)}`
    if (seen.has(key)) return
    seen.add(key)
    items.push(item)
  }
  if (Array.isArray(record?.evidence)) for (const item of record.evidence) add(item)
  const primary = record?.source
  if (primary && typeof primary === 'object' && !Array.isArray(primary) && (asString(primary.ref) || asQuote(primary.quote))) add(primary)
  const sources = []
  const missing = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { missing.push({ reason: 'invalid_source' }); continue }
    const quote = asQuote(item.quote)
    const ref = asString(item.ref)
    if (!ref) {
      const entry = { reason: 'no_ref' }
      if (quote) entry.quote = quote
      missing.push(entry)
      continue
    }
    const parsed = parseEvidenceRef(ref)
    if (!parsed) {
      const entry = { reason: 'unparseable_ref', ref }
      if (quote) entry.quote = quote
      missing.push(entry)
      continue
    }
    const entry = { ref, sessionId: parsed.sessionId, turnId: parsed.turnId }
    if (quote) entry.quote = quote
    sources.push(entry)
  }
  return { sources, missing }
}

function commitmentRecord(commitment) {
  const record = {
    type: 'commitment',
    id: asString(commitment?.id),
    action: asString(commitment?.action),
    debtor: asString(commitment?.debtor),
    creditor: asString(commitment?.creditor),
    status: asString(commitment?.status),
  }
  if (typeof commitment?.dueAt === 'string' && commitment.dueAt) record.dueAt = commitment.dueAt
  if (typeof commitment?.matterId === 'string' && commitment.matterId) record.matterId = commitment.matterId
  return record
}

function factRecord(fact) {
  const record = {
    type: 'fact',
    id: asString(fact?.id),
    subject: asString(fact?.subject),
    predicate: asString(fact?.predicate),
    object: asString(fact?.object),
    status: asString(fact?.status),
  }
  if (typeof fact?.confidence === 'number' && Number.isFinite(fact.confidence)) record.confidence = fact.confidence
  if (typeof fact?.matterId === 'string' && fact.matterId) record.matterId = fact.matterId
  return record
}

function preferenceRecord(preference) {
  const record = {
    type: 'preference',
    id: asString(preference?.id),
    statement: asString(preference?.statement),
    status: asString(preference?.status),
  }
  if (typeof preference?.kind === 'string' && preference.kind) record.preferenceKind = preference.kind
  if (typeof preference?.priority === 'string' && preference.priority) record.priority = preference.priority
  return record
}

function findCommitment(ledger, id) {
  return ledger.listCommitments().find((commitment) => commitment?.id === id)
}

function findFact(ledger, id) {
  const rows = ledger.listFacts(undefined, true)
  const found = rows.find((fact) => fact?.id === id)
  if (found) return found
  const snapshot = typeof ledger.toJSON === 'function' ? ledger.toJSON() : undefined
  return (Array.isArray(snapshot?.facts) ? snapshot.facts : []).find((fact) => fact?.id === id)
}

function findPreference(ledger, id) {
  if (typeof ledger.findPreference === 'function') {
    const found = ledger.findPreference(id)
    if (found) return found
  }
  return ledger.listPreferences({ includeCandidates: true }).find((preference) => preference?.id === id)
}

/** Evidence refs stored on one in-memory preview ledger row; ledger-only. */
function previewEvidence(runtime, args) {
  const id = typeof args?.id === 'string' ? args.id.trim() : ''
  if (!id) throw new ReadToolError(ERROR_CODES.INVALID_ARGUMENT, 'id is required and must be a non-empty string')
  const ledger = runtime.ledger
  let kind
  let record
  let traced
  if (id.startsWith('cm_')) {
    kind = 'commitment'
    const commitment = findCommitment(ledger, id)
    if (!commitment) throw new ReadToolError(ERROR_CODES.EVIDENCE_NOT_FOUND, `no commitment with id ${id} (preview ledger: the DSH adapter did not find a real ledger to read)`)
    record = commitmentRecord(commitment)
    traced = traceCommitmentEvidence(commitment)
  } else if (id.startsWith('fact_')) {
    kind = 'fact'
    const fact = findFact(ledger, id)
    if (!fact) throw new ReadToolError(ERROR_CODES.EVIDENCE_NOT_FOUND, `no fact with id ${id} (preview ledger: the DSH adapter did not find a real ledger to read)`)
    record = factRecord(fact)
    traced = traceSourceRefs(fact)
  } else if (id.startsWith('pref_')) {
    kind = 'preference'
    const preference = findPreference(ledger, id)
    if (!preference) throw new ReadToolError(ERROR_CODES.EVIDENCE_NOT_FOUND, `no preference with id ${id} (preview ledger: the DSH adapter did not find a real ledger to read)`)
    record = preferenceRecord(preference)
    traced = traceSourceRefs(preference)
  } else {
    throw new ReadToolError(ERROR_CODES.UNKNOWN_ID_PREFIX, 'id must start with cm_ (commitment), fact_ (fact), or pref_ (preference)')
  }
  return evidencePayload(id, kind, record, traced, previewMarker(), { auditExtra: '' })
}

/* -------------------------------------------------------------------------- */
/* customer projection (0.3.2 M3; list/show through the read-only facade)      */
/* -------------------------------------------------------------------------- */

const CLIENT_ID_MAX = 120

function normalizeClientLimit(value) {
  if (value === undefined || value === null) return CLIENT_LIST_DEFAULT
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > CLIENT_LIST_MAX) {
    throw new ReadToolError(ERROR_CODES.INVALID_ARGUMENT, 'limit must be an integer between 1 and ' + CLIENT_LIST_MAX)
  }
  return limit
}

/** The no-ledger customer preview: an empty, marked list — never fake data. */
function previewClientsList(limit) {
  const data = annotateClientsPayload({
    action: 'list',
    clients: [],
    total: 0,
    truncated: false,
    limit,
    customerEntities: false,
    clearance: 0,
    protectedExcluded: 0,
    ...previewMarker(),
  }, 'advisers_clients')
  return { data, audit: 'preview clients=0' }
}

/** A preview ledger cannot contain a real client: not-found, never an empty fake. */
function previewClientMissing(id) {
  const safeId = String(id).slice(0, CLIENT_ID_MAX)
  throw new ReadToolError(
    ERROR_CODES.CLIENT_NOT_FOUND,
    'no client with id ' + safeId + ' (preview ledger: the DSH adapter did not read a real ledger)',
    'Run `advisers init` and `advisers client add "<name>"` on the local machine, then retry.',
  )
}

function evidencePayload(id, kind, record, traced, marker, { auditExtra }) {
  const counts = { sources: traced.sources.length, missing: traced.missing.length }
  const data = annotateEvidencePayload({
    id,
    kind,
    record,
    sources: traced.sources.slice(0, EVIDENCE_LIST_CAP),
    missing: traced.missing.slice(0, EVIDENCE_LIST_CAP),
    counts,
    verified: false,
    truncated: counts.sources > EVIDENCE_LIST_CAP || counts.missing > EVIDENCE_LIST_CAP,
    ...marker,
  }, 'advisers_evidence')
  return {
    data,
    audit: `${kind} ${id} sources=${counts.sources} missing=${counts.missing}${auditExtra}`,
  }
}

/* -------------------------------------------------------------------------- */
/* error mapping (facade -> DSH bare codes; never absolute paths)             */
/* -------------------------------------------------------------------------- */

const FACADE_CODE_MAP = Object.freeze({
  E_TOS_REQUIRED: ERROR_CODES.LEDGER_TOS_REQUIRED,
  E_VAULT_SEALED: ERROR_CODES.LEDGER_VAULT_SEALED,
  E_SCHEMA_STALE: ERROR_CODES.LEDGER_SCHEMA_STALE,
  E_SCHEMA_NEWER: ERROR_CODES.LEDGER_SCHEMA_NEWER,
  E_LEDGER_CORRUPT: ERROR_CODES.LEDGER_CORRUPT,
  E_LEDGER_UNAVAILABLE: ERROR_CODES.LEDGER_UNAVAILABLE,
  E_LEDGER_BUSY: ERROR_CODES.LEDGER_BUSY,
  E_USAGE: ERROR_CODES.INVALID_ARGUMENT,
})

/** Codes that mean 'no real ledger available': the adapter falls back to preview. */
const PREVIEW_FALLBACK_CODES = new Set(['E_LEDGER_ABSENT', 'E_LEDGER_UNAVAILABLE'])

/** Strip a configured home path from any message before it reaches the model. */
function sanitizeReadText(value, home) {
  let text = String(value ?? '')
  if (home) text = text.split(home).join('~/.advisers')
  return text.replace(/\s+/g, ' ').trim().slice(0, 400)
}

/**
 * Create the ledger reader used by the three read tools.
 *
 * @param {{ mode?: 'auto'|'preview', home?: string }} [config]
 * @param {{ runtime: object, importFacade?: Function }} options runtime is the
 *        in-memory service (preview fallback / service provide only). The
 *        optional importFacade seam lets tests simulate an older advisers
 *        package without touching the module graph.
 */
export function createLedgerReader(config = {}, options = {}) {
  const runtime = options.runtime
  const importFacade = typeof options.importFacade === 'function'
    ? options.importFacade
    : () => import('advisers/lib/ledger-read.js')
  const mode = config.mode === undefined || config.mode === null ? 'auto' : String(config.mode)
  if (mode !== 'auto' && mode !== 'preview') throw new TypeError('config.mode must be "auto" or "preview"')
  let home = config.home
  if (home !== undefined && home !== null) {
    if (typeof home !== 'string' || home.trim() === '' || !isAbsolute(home)) {
      throw new TypeError('config.home must be an absolute path when set')
    }
    home = home.trim()
  } else {
    home = undefined
  }
  // 0.3.0 DSH reads at clearance 0 (fail closed). Raising it is a host decision
  // that is deliberately not exposed by this bundle yet.
  const clearance = 0
  let facadePromise
  function loadFacade() {
    if (!facadePromise) {
      facadePromise = (async () => {
        try {
          const api = await importFacade()
          if (!api || typeof api.readOpenCommitmentIndex !== 'function' || typeof api.readEntityById !== 'function') {
            return { api: null }
          }
          return { api }
        } catch {
          // Old `advisers` package (no subpath), missing optional module, or a
          // host without node:sqlite: preview, never a plugin-load failure.
          return { api: null }
        }
      })()
    }
    return facadePromise
  }
  function mapError(error) {
    const code = String(error?.code ?? '')
    const mapped = FACADE_CODE_MAP[code]
    const message = sanitizeReadText(error?.message, home) || 'read-only ledger read failed'
    const hint = error?.hint ? sanitizeReadText(error.hint, home) : undefined
    if (mapped) return new ReadToolError(mapped, message, hint)
    return new ReadToolError(ERROR_CODES.INTERNAL_ERROR, message || 'read-only ledger read failed', hint)
  }
  function fallback(error) {
    return PREVIEW_FALLBACK_CODES.has(String(error?.code ?? ''))
  }
  async function realIndex() {
    const { api } = await loadFacade()
    if (!api) return null
    try {
      return await api.readOpenCommitmentIndex({ home, clearance })
    } catch (error) {
      if (fallback(error)) return null
      throw mapError(error)
    }
  }
  return {
    mode,
    home,
    clearance,
    loadFacade,
    async todayView() {
      let result
      if (mode === 'preview') {
        result = previewToday(runtime)
      } else {
        const index = await realIndex()
        if (!index) {
          result = previewToday(runtime)
        } else {
          const { data, audit } = buildToday(index.rows)
          result = { data: withLedgerMarker(data, index), audit }
        }
      }
      return { ...result, data: annotateCommitmentLists(result.data, 'advisers_today', ['overdue', 'today', 'week', 'waiting', 'noDue']) }
    },
    async whoView() {
      let result
      if (mode === 'preview') {
        result = previewWho(runtime)
      } else {
        const index = await realIndex()
        if (!index) {
          result = previewWho(runtime)
        } else {
          const { data, audit } = buildWho(index.rows)
          result = { data: withLedgerMarker(data, index), audit }
        }
      }
      return { ...result, data: annotateWhoPayload(result.data, 'advisers_who') }
    },
    async evidenceView(args) {
      if (mode === 'preview') return previewEvidence(runtime, args)
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (!id) throw new ReadToolError(ERROR_CODES.INVALID_ARGUMENT, 'id is required and must be a non-empty string')
      let kind
      let entity
      if (id.startsWith('cm_')) { kind = 'commitment'; entity = 'commitments' }
      else if (id.startsWith('fact_')) { kind = 'fact'; entity = 'facts' }
      else if (id.startsWith('pref_')) { kind = 'preference'; entity = 'preferences' }
      else throw new ReadToolError(ERROR_CODES.UNKNOWN_ID_PREFIX, 'id must start with cm_ (commitment), fact_ (fact), or pref_ (preference)')
      const { api } = await loadFacade()
      if (!api) return previewEvidence(runtime, args)
      let info
      try {
        info = await api.readEntityById({ home, kind: entity, id, clearance })
      } catch (error) {
        if (fallback(error)) return previewEvidence(runtime, args)
        throw mapError(error)
      }
      if (info.hidden) {
        throw new ReadToolError(ERROR_CODES.EVIDENCE_PROTECTED, `record ${id} belongs to a protected matter (secrecy above the read clearance)`, 'DSH reads at clearance 0 and never raises it; open the record in the advisers CLI on the local machine.')
      }
      if (!info.record) {
        throw new ReadToolError(ERROR_CODES.EVIDENCE_NOT_FOUND, `no ${kind} with id ${id}`, 'Ids are case-sensitive; use `advisers evidence show <id> --json` to confirm the id.')
      }
      let record
      let traced
      if (kind === 'commitment') { record = commitmentRecord(info.record); traced = traceCommitmentEvidence(info.record) }
      else if (kind === 'fact') { record = factRecord(info.record); traced = traceSourceRefs(info.record) }
      else { record = preferenceRecord(info.record); traced = traceSourceRefs(info.record) }
      const marker = withLedgerMarker({}, { backend: info.backend, clearance: info.clearance, protectedExcluded: 0, warnings: info.warnings })
      return evidencePayload(id, kind, record, traced, marker, { auditExtra: ` backend=${info.backend}` })
    },
    /**
     * Customer projection (0.3.2 M3): action 'list' | 'show'. Real ledger reads
     * go through the read-only facade (clearance 0, TOS-gated, no HOME lock, no
     * migration); a missing ledger / unavailable facade falls back to the marked
     * preview. Note bodies and conversation text are never part of the payload.
     */
    async clientsView(args = {}) {
      const action = args?.action
      if (action !== 'list' && action !== 'show') {
        throw new ReadToolError(ERROR_CODES.INVALID_ARGUMENT, 'action must be "list" or "show"')
      }
      const limit = normalizeClientLimit(args?.limit)
      const id = typeof args?.id === 'string' ? args.id.trim().slice(0, CLIENT_ID_MAX) : ''
      if (action === 'show') {
        if (!id) throw new ReadToolError(ERROR_CODES.INVALID_ARGUMENT, 'id is required for action "show"')
        if (mode === 'preview') return previewClientMissing(id)
        const { api } = await loadFacade()
        if (!api || typeof api.readClientById !== 'function') return previewClientMissing(id)
        let info
        try {
          info = await api.readClientById({ home, id, clearance, timelineLimit: limit })
        } catch (error) {
          if (fallback(error)) return previewClientMissing(id)
          throw mapError(error)
        }
        if (!info.found || !info.view) {
          throw new ReadToolError(
            ERROR_CODES.CLIENT_NOT_FOUND,
            `no client with id ${id}`,
            info.customerEntities === false
              ? 'The JSON ledger store has no customer tables; use ADVISERS_STORE=sqlite.'
              : 'Ids are case-sensitive; use `advisers client list --json` to confirm the id.',
          )
        }
        const view = info.view
        const marker = withLedgerMarker({}, {
          backend: info.backend,
          clearance: info.clearance,
          protectedExcluded: view.protectedExcluded,
          warnings: info.warnings,
        })
        const showData = { action: 'show', ...view, customerEntities: info.customerEntities === true, ...marker }
        return {
          data: annotateClientsPayload(showData, 'advisers_clients'),
          audit: `client ${view.client.id} matters=${view.counts.matters} open=${view.counts.openMine}/${view.counts.openWaiting} timeline=${view.timelineTotal}`,
        }
      }
      if (mode === 'preview') return previewClientsList(limit)
      const { api } = await loadFacade()
      if (!api || typeof api.readClientList !== 'function') return previewClientsList(limit)
      let info
      try {
        info = await api.readClientList({ home, clearance, limit })
      } catch (error) {
        if (fallback(error)) return previewClientsList(limit)
        throw mapError(error)
      }
      const marker = withLedgerMarker({}, {
        backend: info.backend,
        clearance: info.clearance,
        protectedExcluded: info.protectedExcluded,
        warnings: info.warnings,
      })
      const data = {
        action: 'list',
        clients: info.clients,
        total: info.total,
        truncated: info.truncated,
        limit: info.limit,
        customerEntities: info.customerEntities === true,
        ...marker,
      }
      if (info.customerEntities !== true) data.note = JSON_CUSTOMER_NOTE
      return {
        data: annotateClientsPayload(data, 'advisers_clients'),
        audit: `clients=${info.clients.length}/${info.total} customerEntities=${info.customerEntities === true}`,
      }
    },
  }
}
