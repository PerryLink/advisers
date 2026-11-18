import { defineTool } from '@deepseek-ai/dsh-tools'
import { AdvisersRuntime } from 'advisers-core'
import { buildDocx, buildPptx, buildXlsx, buildXmind, buildMermaid, buildDrawio, validateOffice, validateXmind } from 'advisers-office'
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
// Content safety (docs/CONTENT-SAFETY.md section 8). dsh-advisers consumes the
// same local rule layer as the CLI through the published `advisers` package
// (an explicit dependency plus the "./lib/safety/index.js" export subpath), so a
// clean npm/pnpm install of the tarball can resolve it.
import { classify } from 'advisers/lib/safety/index.js'

export const name = 'advisers'
export const inject = ['tools']
export const version = '0.2.2'

// ---------------------------------------------------------------------------
// Read-only ledger views: advisers_today / advisers_who / advisers_evidence.
//
// These tools only read runtime.ledger. They never add/complete/forget a row and
// never call a link. Failures come back as { ok: false, error: { code, message } }
// with a stable code instead of escaping as a bare exception, so the model can
// react to a domain error without a failed tool call. If the runtime exposes an
// audit sink (runtime.audit), every read call is reported there; a missing or
// failing sink is a no-op and never turns a read into a failure.
//
// 0.2.3 honesty: this bundle still creates an in-memory AdvisersRuntime and does
// not open ~/.advisers/state.db (read-only ledger wiring is planned for 0.3).
// Every read payload therefore carries the preview marker defined below, so an
// empty preview ledger can never be mistaken for a real ledger with no work.
// ---------------------------------------------------------------------------

const TIME_ZONE = 'Asia/Shanghai'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const QUOTE_CAP = 500
const TODAY_LIST_CAP = 10
const WHO_LIST_CAP = 50
const EVIDENCE_LIST_CAP = 20
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE })

const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  UNKNOWN_ID_PREFIX: 'UNKNOWN_ID_PREFIX',
  EVIDENCE_NOT_FOUND: 'EVIDENCE_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  CONTENT_BLOCKED: 'CONTENT_BLOCKED',
})

// ---------------------------------------------------------------------------
// Honest-preview contract (0.2.3 subset, additive to the 0.2.x read payloads).
//
// The bundle creates an in-memory ledger and never opens ~/.advisers/state.db
// (read-only ledger wiring is planned for 0.3). Without a marker an empty
// preview is indistinguishable from a real ledger with no open commitments, so
// the model could answer "nothing is due" about books it has never read. Every
// successful payload from the three read tools therefore carries:
//
//   preview: true                    the data is a preview, not the real books
//   source: 'preview-no-ledger'      stable machine-readable source marker
//   note: '...'                      one-line disclosure for the model and user
//
// The field names are part of the 0.2.3 contract; 0.3 replaces the *value* of
// `source` with the read-only store and keeps the names. Existing 0.2.x fields
// (counts, lists, sources, missing, verified, truncated, ...) are untouched, and
// the { ok: false, error: { code, message } } envelope keeps its stable codes.
// ---------------------------------------------------------------------------
const PREVIEW_NOTE = 'Preview only: the DSH adapter does not open ~/.advisers/state.db, so this comes from an empty in-memory ledger, not your real books. Use the advisers CLI (advisers today --json / who --json / evidence show <id> --json) or "advisers mcp --stdio" for real ledger data.'
const PREVIEW = Object.freeze({ preview: true, source: 'preview-no-ledger', note: PREVIEW_NOTE })
// Appended to EVIDENCE_NOT_FOUND so a real-ledger id does not look deleted/absent.
const PREVIEW_ERROR_HINT = ' (preview ledger: the DSH adapter does not open ~/.advisers/state.db)'

// Stable structured error for a local content-safety block. Shape is deliberately
// additive to the existing { ok, path, bytes } / IntentBrief results; no host
// crash and no original text.
const contentSafetyErrorSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true, description: 'CONTENT_BLOCKED when the local content-safety layer blocked the call.' },
    message: { type: 'string', required: true, description: 'One-line human-readable detail (no original text).' },
    surface: { type: 'string' },
    ruleIds: { type: 'array', items: { type: 'string' } },
    rulesetVersion: { type: 'string' },
  },
}

/** JSON text for classification only; never throws on odd input. */
function safeJson(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return ''
  }
}

/** Classify tool input with the dsh.tool surface; return a structured block. */
function contentSafetyBlock(text, surface = 'dsh.tool') {
  const result = classify(text, { surface })
  if (result.action !== 'block') return null
  return {
    ok: false,
    error: {
      code: ERROR_CODES.CONTENT_BLOCKED,
      message: '内容安全审核未通过，已阻止本次工具调用（CONTENT_BLOCKED）。',
      surface: result.surface,
      ruleIds: result.ruleIds,
      rulesetVersion: result.rulesetVersion,
    },
  }
}

/** Domain error that executeRead renders as a structured { ok: false, error }. */
class ReadToolError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReadToolError'
    this.code = code
  }
}

const asString = (value) => (typeof value === 'string' ? value : '')
const asQuote = (value) => (typeof value === 'string' ? value.slice(0, QUOTE_CAP) : '')

const commitmentViewSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Commitment id (cm_…).' },
    debtor: { type: 'string', required: true },
    creditor: { type: 'string', required: true },
    action: { type: 'string', required: true },
    status: { type: 'string', required: true },
    dueAt: { type: 'string' },
    matterId: { type: 'string' },
  },
}

const errorDetailSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: {
      type: 'string',
      required: true,
      description: 'Stable error code: INVALID_ARGUMENT | UNKNOWN_ID_PREFIX | EVIDENCE_NOT_FOUND | INTERNAL_ERROR.',
    },
    message: { type: 'string', required: true, description: 'One-line human-readable detail.' },
  },
}

// Additive preview marker shared by the three read-tool payload schemas. The
// fields are required so a later edit cannot silently drop the disclosure.
const previewDataSchema = {
  preview: {
    type: 'boolean',
    const: true,
    required: true,
    description: 'True while the DSH adapter reads an in-memory preview ledger instead of ~/.advisers/state.db.',
  },
  source: {
    type: 'string',
    enum: ['preview-no-ledger'],
    required: true,
    description: 'Where the payload came from. Always "preview-no-ledger" in 0.2.3; 0.3 adds the read-only ledger source.',
  },
  note: {
    type: 'string',
    required: true,
    description: 'One-line disclosure that the payload is a preview, not the real ledger.',
  },
}

/** Success = { ok: true, data }; failure = { ok: false, error }. */
function readOnlyResultSchema(dataSchema) {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', const: true, required: true },
          data: { ...dataSchema, required: true, description: 'Read-only payload.' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', const: false, required: true },
          error: { ...errorDetailSchema, required: true },
        },
      },
    ],
  }
}

const todayDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...previewDataSchema,
    now: { type: 'string', required: true, description: 'ISO-8601 timestamp of the read.' },
    timezone: { type: 'string', required: true },
    localDay: { type: 'string', required: true, description: 'Calendar day in Asia/Shanghai (YYYY-MM-DD).' },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: true,
      description: 'Totals; the lists below are capped and may be truncated.',
      properties: {
        open: { type: 'number', required: true },
        overdue: { type: 'number', required: true },
        today: { type: 'number', required: true },
        week: { type: 'number', required: true },
        waiting: { type: 'number', required: true },
        noDue: { type: 'number', required: true },
      },
    },
    overdue: { type: 'array', items: commitmentViewSchema, required: true },
    today: { type: 'array', items: commitmentViewSchema, required: true },
    week: { type: 'array', items: commitmentViewSchema, required: true },
    waiting: { type: 'array', items: commitmentViewSchema, required: true },
    noDue: { type: 'array', items: commitmentViewSchema, required: true },
    next: { ...commitmentViewSchema, description: 'Earliest due open commitment, when one exists.' },
    truncated: { type: 'boolean', required: true, description: 'True when a list was capped.' },
  },
}

const whoDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...previewDataSchema,
    counts: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        mine: { type: 'number', required: true },
        waiting: { type: 'number', required: true },
        open: { type: 'number', required: true },
      },
    },
    mine: {
      type: 'array',
      items: commitmentViewSchema,
      required: true,
      description: 'Open commitments where the user or the agent owes someone.',
    },
    waiting: {
      type: 'array',
      items: commitmentViewSchema,
      required: true,
      description: 'Open commitments where a third party owes the user (debtor third / third:<name>).',
    },
    truncated: { type: 'boolean', required: true },
  },
}

const evidenceSourceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'string', required: true, description: 'Stored reference, normally sessionId#turnId.' },
    sessionId: { type: 'string' },
    turnId: { type: 'string' },
    quote: { type: 'string' },
    source: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string' },
        subject: { type: 'string' },
        messageId: { type: 'string' },
        file: { type: 'string' },
      },
    },
  },
}

const evidenceMissingSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string', required: true, description: 'invalid_source | invalid_evidence | no_ref | unparseable_ref.' },
    id: { type: 'string' },
    ref: { type: 'string' },
    quote: { type: 'string' },
    sessionId: { type: 'string' },
    turnId: { type: 'string' },
  },
}

const evidenceRecordSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['commitment', 'fact', 'preference'], required: true },
    id: { type: 'string', required: true },
    action: { type: 'string' },
    debtor: { type: 'string' },
    creditor: { type: 'string' },
    dueAt: { type: 'string' },
    status: { type: 'string' },
    matterId: { type: 'string' },
    subject: { type: 'string' },
    predicate: { type: 'string' },
    object: { type: 'string' },
    confidence: { type: 'number' },
    statement: { type: 'string' },
    preferenceKind: { type: 'string' },
    priority: { type: 'string' },
  },
}

const evidenceDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...previewDataSchema,
    id: { type: 'string', required: true },
    kind: { type: 'string', enum: ['commitment', 'fact', 'preference'], required: true },
    record: { ...evidenceRecordSchema, required: true },
    sources: { type: 'array', items: evidenceSourceSchema, required: true },
    missing: { type: 'array', items: evidenceMissingSchema, required: true },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        sources: { type: 'number', required: true },
        missing: { type: 'number', required: true },
      },
    },
    verified: {
      type: 'boolean',
      required: true,
      description: 'False here: the DSH adapter has no turn store, so stored refs are reported but not resolved against turns.',
    },
    truncated: { type: 'boolean', required: true },
  },
}

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

/** Additive honest-preview marker for every read payload (0.2.x fields untouched). */
function withPreview(data) {
  return { ...data, ...PREVIEW }
}

// '[preview: no ledger] ' prefix for the rendered text, so the model cannot read
// the counts as if they came from the real books.
function previewTag(value) {
  const data = value && value.ok === true ? value.data : undefined
  return data && data.preview === true ? '[preview: no ledger] ' : ''
}

/** Today/week/waiting buckets, mirroring the CLI today/who read views. */
function buildToday(runtime) {
  const nowMs = Date.now()
  const localDay = localDayOfMs(nowMs)
  const open = runtime.ledger.openCommitments()
  const overdue = []
  const dueToday = []
  const week = []
  const waiting = []
  const noDue = []
  for (const commitment of open) {
    if (isWaitingOnThirdParty(commitment)) waiting.push(commitment)
    const ms = dueAtMs(commitment)
    if (!Number.isFinite(ms)) { noDue.push(commitment); continue }
    if (localDayOfMs(ms) === localDay) dueToday.push(commitment)
    else if (ms < nowMs) overdue.push(commitment)
    else if (ms <= nowMs + WEEK_MS) week.push(commitment)
  }
  const candidates = [...overdue, ...dueToday, ...week].filter((commitment) => Number.isFinite(dueAtMs(commitment)))
  candidates.sort((a, b) => dueAtMs(a) - dueAtMs(b) || asString(a.id).localeCompare(asString(b.id)))
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
  if (candidates.length > 0) data.next = commitmentView(candidates[0])
  return {
    data: withPreview(data),
    audit: `open=${counts.open} overdue=${counts.overdue} today=${counts.today} week=${counts.week} waiting=${counts.waiting}`,
  }
}

/** Who owes whom, mirroring the CLI who/who --json read view. */
function buildWho(runtime) {
  const open = runtime.ledger.openCommitments()
  const mine = []
  const waiting = []
  for (const commitment of open) {
    if (isWaitingOnThirdParty(commitment)) waiting.push(commitment)
    else if (commitment?.debtor === 'user' || commitment?.debtor === 'agent') mine.push(commitment)
  }
  return {
    data: withPreview({
      counts: { mine: mine.length, waiting: waiting.length, open: open.length },
      mine: mine.slice(0, WHO_LIST_CAP).map(commitmentView),
      waiting: waiting.slice(0, WHO_LIST_CAP).map(commitmentView),
      truncated: mine.length > WHO_LIST_CAP || waiting.length > WHO_LIST_CAP,
    }),
    audit: `mine=${mine.length} waiting=${waiting.length}`,
  }
}

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

/** Evidence refs stored on one ledger row; ledger-only (no turn lookup). */
function buildEvidence(runtime, args) {
  const id = typeof args?.id === 'string' ? args.id.trim() : ''
  if (!id) throw new ReadToolError(ERROR_CODES.INVALID_ARGUMENT, 'id is required and must be a non-empty string')
  const ledger = runtime.ledger
  let kind
  let record
  let traced
  if (id.startsWith('cm_')) {
    kind = 'commitment'
    const commitment = findCommitment(ledger, id)
    if (!commitment) throw new ReadToolError(ERROR_CODES.EVIDENCE_NOT_FOUND, `no commitment with id ${id}${PREVIEW_ERROR_HINT}`)
    record = commitmentRecord(commitment)
    traced = traceCommitmentEvidence(commitment)
  } else if (id.startsWith('fact_')) {
    kind = 'fact'
    const fact = findFact(ledger, id)
    if (!fact) throw new ReadToolError(ERROR_CODES.EVIDENCE_NOT_FOUND, `no fact with id ${id}${PREVIEW_ERROR_HINT}`)
    record = factRecord(fact)
    traced = traceSourceRefs(fact)
  } else if (id.startsWith('pref_')) {
    kind = 'preference'
    const preference = findPreference(ledger, id)
    if (!preference) throw new ReadToolError(ERROR_CODES.EVIDENCE_NOT_FOUND, `no preference with id ${id}${PREVIEW_ERROR_HINT}`)
    record = preferenceRecord(preference)
    traced = traceSourceRefs(preference)
  } else {
    throw new ReadToolError(ERROR_CODES.UNKNOWN_ID_PREFIX, 'id must start with cm_ (commitment), fact_ (fact), or pref_ (preference)')
  }
  const counts = { sources: traced.sources.length, missing: traced.missing.length }
  return {
    data: withPreview({
      id,
      kind,
      record,
      sources: traced.sources.slice(0, EVIDENCE_LIST_CAP),
      missing: traced.missing.slice(0, EVIDENCE_LIST_CAP),
      counts,
      verified: false,
      truncated: counts.sources > EVIDENCE_LIST_CAP || counts.missing > EVIDENCE_LIST_CAP,
    }),
    audit: `${kind} ${id} sources=${counts.sources} missing=${counts.missing}`,
  }
}

function auditRead(runtime, toolName, allowed, reason) {
  const sink = runtime && typeof runtime.audit === 'function' ? runtime.audit : undefined
  if (!sink) return
  try {
    const result = sink.call(runtime, {
      actor: 'dsh',
      action: 'tool.read',
      allowed,
      reason: `${toolName}: ${reason}`.slice(0, 300),
    })
    if (result && typeof result.then === 'function') result.then(undefined, () => {})
  } catch {
    // An audit sink must never turn a read-only tool into a failure.
  }
}

async function executeRead(runtime, toolName, build) {
  try {
    const { data, audit } = await build()
    auditRead(runtime, toolName, true, audit)
    return { ok: true, data }
  } catch (error) {
    const known = error instanceof ReadToolError
    const code = known ? error.code : ERROR_CODES.INTERNAL_ERROR
    const message = known ? error.message : `read failed: ${asString(error?.message) || String(error)}`
    auditRead(runtime, toolName, false, code)
    return { ok: false, error: { code, message: message.slice(0, 300) } }
  }
}

function renderError(value) {
  const error = value && typeof value === 'object' && value.error ? value.error : {}
  return `${asString(error.code) || 'ERROR'}: ${asString(error.message)}`
}

function renderToday(value) {
  if (!value || value.ok !== true) return renderError(value)
  const data = value.data ?? {}
  const counts = data.counts ?? {}
  const next = data.next
    ? `; next: ${asString(data.next.action)}${typeof data.next.dueAt === 'string' ? ` (${data.next.dueAt.slice(0, 10)})` : ''}`
    : ''
  return `${previewTag(value)}today ${asString(data.localDay)}: ${counts.today ?? 0} due today, ${counts.overdue ?? 0} overdue, ${counts.week ?? 0} in 7 days, ${counts.waiting ?? 0} waiting, ${counts.noDue ?? 0} without due date${next}`
}

function renderWho(value) {
  if (!value || value.ok !== true) return renderError(value)
  const counts = (value.data ?? {}).counts ?? {}
  return `${previewTag(value)}who: ${counts.mine ?? 0} owed by me, ${counts.waiting ?? 0} waiting on others (${counts.open ?? 0} open)`
}

function renderEvidence(value) {
  if (!value || value.ok !== true) return renderError(value)
  const data = value.data ?? {}
  const counts = data.counts ?? {}
  return `${previewTag(value)}${asString(data.kind)} ${asString(data.id)}: ${counts.sources ?? 0} source(s), ${counts.missing ?? 0} missing (ledger refs only; turns not verified)`
}

/**
 * DSH bundle entry point. It registers the service plus the read-only brief /
 * today / who / evidence tools and the workspace-confined office builder. The
 * three ledger readers are preview-only in 0.2.3 (see PREVIEW above).
 */
export function apply(ctx, config = {}) {
  const runtime = new AdvisersRuntime({
    stage: config.stage === 'trusted' ? 'trusted' : 'probation',
  })

  ctx.provide('advisers', runtime)

  ctx.tools.register(defineTool({
    name: 'advisers_office',
    description: 'Build a real Office/diagram file from a JSON spec inside the configured workspace. Returns the path and validation result.',
    parameters: {
      kind: { type: 'string', required: true, description: 'docx | xlsx | pptx | xmind | mermaid | drawio' },
      out: { type: 'string', required: true, description: 'Relative output path, e.g. out/q4.docx' },
      spec: { type: 'object', additionalProperties: true, required: true, description: 'Builder spec (title/sections/columns/rows/slides/nodes/branches).' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              path: { type: 'string', required: true },
              bytes: { type: 'number', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: false, required: true },
              error: { ...contentSafetyErrorSchema, required: true },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok === false && value.error
          ? `${asString(value.error.code) || ERROR_CODES.CONTENT_BLOCKED}: ${asString(value.error.message)}`
          : `${value.ok ? 'written' : 'failed'}: ${value.path} (${value.bytes} bytes)`,
      }],
    },
    async execute(args) {
      const blocked = contentSafetyBlock(safeJson({ kind: args.kind, out: args.out, spec: args.spec }))
      if (blocked) return blocked
      const root = resolve(config.workspace || process.cwd())
      const target = resolve(root, args.out)
      const rel = relative(root, target)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('output path escapes workspace')
      const denied = new Set(['.git', '.hg', '.svn', '.dsh', '.github', 'node_modules', 'package.json', 'pnpm-lock.yaml', 'soul.md', 'state.db'])
      for (const part of rel.split(/[\\/]+/)) {
        const lower = part.toLowerCase()
        if (denied.has(lower) || lower.startsWith('.env')) throw new Error(`output path is protected: ${part}`)
      }
      let buffer
      let validation
      if (args.kind === 'docx') { buffer = await buildDocx(args.spec); validation = await validateOffice(buffer, 'docx') }
      else if (args.kind === 'xlsx') { buffer = await buildXlsx(args.spec); validation = await validateOffice(buffer, 'xlsx') }
      else if (args.kind === 'pptx') { buffer = await buildPptx(args.spec); validation = await validateOffice(buffer, 'pptx') }
      else if (args.kind === 'xmind') { buffer = await buildXmind(args.spec); validation = await validateXmind(buffer) }
      else if (args.kind === 'drawio') { buffer = Buffer.from(buildDrawio(args.spec)); validation = { ok: true } }
      else if (args.kind === 'mermaid') { buffer = Buffer.from(buildMermaid(args.spec)); validation = { ok: true } }
      else throw new Error(`unsupported kind: ${args.kind}`)
      mkdirSync(dirname(target), { recursive: true })
      const realRoot = realpathSync(root)
      const realParent = realpathSync(dirname(target))
      const parentRel = relative(realRoot, realParent)
      if (parentRel.startsWith('..') || isAbsolute(parentRel)) throw new Error('output path escapes workspace through a symlink')
      try { if (lstatSync(target).isSymbolicLink()) throw new Error('symlink output is not allowed') } catch (error) { if (error.code !== 'ENOENT') throw error }
      writeFileSync(target, buffer)
      return { ok: validation.ok, path: target, bytes: buffer.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'advisers_brief',
    description: 'Turn a work request into a concise IntentBrief: goal, deliverable, risk, assumptions, one question, and a two-line readback. Use before starting an ambiguous task.',
    parameters: {
      text: { type: 'string', required: true, description: 'The user request, verbatim.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              goal: { type: 'string', required: true },
              deliverable: { type: 'string', required: true },
              action: { type: 'string', required: true },
              risk: { type: 'string', required: true },
              questions: { type: 'array', items: { type: 'string' }, required: true },
              readback: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: false, required: true },
              error: { ...contentSafetyErrorSchema, required: true },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok === false && value.error
          ? `${asString(value.error.code) || ERROR_CODES.CONTENT_BLOCKED}: ${asString(value.error.message)}`
          : value.readback,
      }],
    },
    async execute(args) {
      const blocked = contentSafetyBlock(args.text)
      if (blocked) return blocked
      const brief = runtime.brief(args.text)
      return {
        goal: brief.goal,
        deliverable: brief.deliverable,
        action: brief.action,
        risk: brief.risk,
        questions: brief.questions,
        readback: brief.readback,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'advisers_today',
    description: 'Read-only PREVIEW of the commitment ledger (today/week/waiting counts, capped lists, earliest due item). The DSH adapter does not open ~/.advisers/state.db yet: it reads an empty in-memory ledger and marks every payload preview:true / source:"preview-no-ledger", so "0 due today" means "no preview data", not "nothing is due". Use the advisers CLI (advisers today --json) or MCP for the real ledger. Never writes the ledger and never sends a message.',
    parameters: {},
    output: {
      schema: readOnlyResultSchema(todayDataSchema),
      render: (_args, value) => [{ type: 'text', text: renderToday(value) }],
    },
    async execute() {
      return executeRead(runtime, 'advisers_today', () => buildToday(runtime))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'advisers_who',
    description: 'Read-only PREVIEW of who-owes-whom: open commitments I owe (user/agent debtor) and ones I am waiting on (third-party debtor). The DSH adapter does not open ~/.advisers/state.db yet: it reads an empty in-memory ledger and marks every payload preview:true / source:"preview-no-ledger". Use the advisers CLI (advisers who --json) or MCP for the real ledger. Never writes the ledger and never sends a message.',
    parameters: {},
    output: {
      schema: readOnlyResultSchema(whoDataSchema),
      render: (_args, value) => [{ type: 'text', text: renderWho(value) }],
    },
    async execute() {
      return executeRead(runtime, 'advisers_who', () => buildWho(runtime))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'advisers_evidence',
    description: 'Read-only PREVIEW evidence lookup for a commitment (cm_…), fact (fact_…), or preference (pref_…) id. The DSH adapter does not open ~/.advisers/state.db yet, so ids from your real ledger are not found here; payloads are marked preview:true / source:"preview-no-ledger" and EVIDENCE_NOT_FOUND says it only searched the preview ledger. Use advisers evidence show <id> --json or MCP for real evidence. Returns the stored quotes/refs from the preview ledger; it does not resolve turn bodies, write the ledger, or send a message.',
    parameters: {
      id: { type: 'string', required: true, description: 'Evidence id: cm_… for a commitment, fact_… for a fact, pref_… for a preference.' },
    },
    output: {
      schema: readOnlyResultSchema(evidenceDataSchema),
      render: (_args, value) => [{ type: 'text', text: renderEvidence(value) }],
    },
    async execute(args) {
      return executeRead(runtime, 'advisers_evidence', () => buildEvidence(runtime, args))
    },
  }))
}
