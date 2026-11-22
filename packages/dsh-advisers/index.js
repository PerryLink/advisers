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
import { ERROR_CODES as READ_ERROR_CODES, ReadToolError, createLedgerReader } from './lib/read.js'

export const name = 'advisers'
export const inject = ['tools']
export const version = '0.4.3'

// ---------------------------------------------------------------------------
// Read-only ledger views: advisers_today / advisers_who / advisers_evidence.
//
// 0.3.0: the three read tools read the REAL local ledger through the narrow
// `advisers/lib/ledger-read.js` facade (read-only, TOS-gated, no HOME lock, no
// migration, no writes, clearance 0). The import is dynamic and defensive: an
// older `advisers` package without the subpath, or a host without node:sqlite,
// falls back to the 0.2.x marked preview instead of failing plugin load.
//
// Failure envelope: { ok:false, error:{ code, message, hint? } } with a stable
// code, so the model can react to a gate failure without a failed tool call.
// A MISSING ledger is not an error (first-run preview is kept and marked
// preview:true / source:"preview-no-ledger"); TOS/vault/schema/corruption/
// unavailability failures are structured errors and never return empty data.
// If the runtime exposes an audit sink (runtime.audit), every read call is
// reported there; a missing or failing sink is a no-op and never turns a read
// into a failure.
// ---------------------------------------------------------------------------

const ERROR_CODES = Object.freeze({
  ...READ_ERROR_CODES,
  CONTENT_BLOCKED: 'CONTENT_BLOCKED',
})

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
      description: 'Stable error code: INVALID_ARGUMENT | UNKNOWN_ID_PREFIX | EVIDENCE_NOT_FOUND | EVIDENCE_PROTECTED | CLIENT_NOT_FOUND | LEDGER_TOS_REQUIRED | LEDGER_VAULT_SEALED | LEDGER_SCHEMA_STALE | LEDGER_SCHEMA_NEWER | LEDGER_CORRUPT | LEDGER_UNAVAILABLE | LEDGER_BUSY | INTERNAL_ERROR.',
    },
    message: { type: 'string', required: true, description: 'One-line human-readable detail (never contains an absolute filesystem path).' },
    hint: { type: 'string', description: 'Optional actionable next step (usually a CLI command); never contains an absolute filesystem path.' },
  },
}

// Source marker shared by the three read-tool payloads (additive to the 0.2.x
// fields; names stay stable, 0.3.0 makes `preview` a boolean and `source` a
// two-value enum).
const sourceDataSchema = {
  preview: {
    type: 'boolean',
    required: true,
    description: 'False when the payload comes from the real read-only ledger; true for the marked in-memory preview fallback.',
  },
  source: {
    type: 'string',
    enum: ['preview-no-ledger', 'ledger-readonly'],
    required: true,
    description: 'Where the payload came from: the real read-only ledger, or the marked preview fallback.',
  },
  note: {
    type: 'string',
    required: true,
    description: 'One-line disclosure of the payload source.',
  },
  warnings: {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional non-fatal ledger warnings (for example a WAL warning); paths are relative.',
  },
  backend: {
    type: 'string',
    enum: ['sqlite', 'json'],
    description: 'Ledger backend actually read (sqlite = state.db, json = legacy state.json).',
  },
  clearance: {
    type: 'number',
    description: 'Per-item secrecy clearance applied to this read. DSH 0.3.0 always reads at clearance 0 (fail closed).',
  },
  protectedExcluded: {
    type: 'number',
    description: 'Count of records withheld because their matter secrecy is above the clearance (content never returned).',
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
    ...sourceDataSchema,
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
    ...sourceDataSchema,
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
    ...sourceDataSchema,
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

/* -------------------------------------------------------------------------- */
/* customer projection (0.3.2 M3)                                             */
/* -------------------------------------------------------------------------- */

const clientCountsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    matters: { type: 'number', required: true },
    mattersArchived: { type: 'number', required: true },
    deliveries: { type: 'number', required: true },
    notes: { type: 'number', required: true },
    commitments: { type: 'number', required: true },
    openMine: { type: 'number', required: true },
    openWaiting: { type: 'number', required: true },
    overdue: { type: 'number', required: true },
  },
}

const nullableClientDateSchema = {
  oneOf: [
    { type: 'string' },
    { type: 'null' },
  ],
}

const clientListRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    status: { type: 'string', required: true },
    aliases: { type: 'array', items: { type: 'string' }, required: true },
    secrecyDefault: { type: 'number', required: true },
    tags: { type: 'array', items: { type: 'string' }, required: true },
    counts: { ...clientCountsSchema, required: true },
    nextDueAt: nullableClientDateSchema,
    clearance: { type: 'number', required: true },
    protectedExcluded: { type: 'number', required: true },
  },
}

const clientIdentitySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    status: { type: 'string', required: true },
    aliases: { type: 'array', items: { type: 'string' }, required: true },
    tags: { type: 'array', items: { type: 'string' }, required: true },
    secrecyDefault: { type: 'number', required: true },
  },
}

const clientProjectSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    status: { type: 'string', required: true },
    counts: { ...clientCountsSchema, required: true },
    nextDueAt: nullableClientDateSchema,
  },
}

const clientTimelineItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    at: { type: 'string', required: true },
    kind: { type: 'string', enum: ['delivery', 'commitment'], required: true },
    title: { type: 'string', required: true },
    ref: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['delivery', 'commitment'], required: true },
        id: { type: 'string', required: true },
      },
      required: true,
    },
    matterId: { type: 'string' },
    secrecy: { type: 'number', required: true },
  },
}

const clientOpenRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    action: { type: 'string', required: true },
    debtor: { type: 'string', required: true },
    creditor: { type: 'string', required: true },
    status: { type: 'string', required: true },
    dueAt: { type: 'string' },
    matterId: { type: 'string' },
    projectId: { type: 'string' },
    secrecy: { type: 'number', required: true },
  },
}

const clientsListDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...sourceDataSchema,
    clearance: { type: 'number', required: true },
    protectedExcluded: { type: 'number', required: true },
    customerEntities: { type: 'boolean', required: true },
    action: { type: 'string', enum: ['list'], required: true },
    clients: { type: 'array', items: clientListRowSchema, required: true },
    total: { type: 'number', required: true },
    truncated: { type: 'boolean', required: true },
    limit: { type: 'number', required: true },
  },
}

const clientsStatusDataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...sourceDataSchema,
    clearance: { type: 'number', required: true },
    protectedExcluded: { type: 'number', required: true },
    customerEntities: { type: 'boolean', required: true },
    action: { type: 'string', enum: ['show'], required: true },
    client: { ...clientIdentitySchema, required: true },
    projects: { type: 'array', items: clientProjectSchema, required: true },
    counts: { ...clientCountsSchema, required: true },
    open: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mine: { type: 'array', items: clientOpenRowSchema, required: true },
        waiting: { type: 'array', items: clientOpenRowSchema, required: true },
        mineTotal: { type: 'number', required: true },
        waitingTotal: { type: 'number', required: true },
      },
      required: true,
    },
    nextDueAt: nullableClientDateSchema,
    timeline: { type: 'array', items: clientTimelineItemSchema, required: true },
    timelineTotal: { type: 'number', required: true },
    timelineTruncated: { type: 'boolean', required: true },
  },
}

const clientsOutputSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', const: true, required: true },
        data: { ...clientsListDataSchema, required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', const: true, required: true },
        data: { ...clientsStatusDataSchema, required: true },
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

/** '[preview: no ledger] ' prefix for rendered text of a preview payload. */
function previewTag(value) {
  const data = value && value.ok === true ? value.data : undefined
  return data && data.preview === true ? '[preview: no ledger] ' : ''
}

function protectedTag(value) {
  const data = value && value.ok === true ? value.data : undefined
  const count = data && Number(data.protectedExcluded)
  return count > 0 ? `; ${count} protected item(s) withheld (clearance 0)` : ''
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
    const payload = { code, message: message.slice(0, 300) }
    if (known && error.hint) payload.hint = String(error.hint).slice(0, 300)
    return { ok: false, error: payload }
  }
}

function renderError(value) {
  const error = value && typeof value === 'object' && value.error ? value.error : {}
  const hint = asString(error.hint) ? ` (${asString(error.hint)})` : ''
  return `${asString(error.code) || 'ERROR'}: ${asString(error.message)}${hint}`
}

function renderToday(value) {
  if (!value || value.ok !== true) return renderError(value)
  const data = value.data ?? {}
  const counts = data.counts ?? {}
  const next = data.next
    ? `; next: ${asString(data.next.action)}${typeof data.next.dueAt === 'string' ? ` (${data.next.dueAt.slice(0, 10)})` : ''}`
    : ''
  return `${previewTag(value)}today ${asString(data.localDay)}: ${counts.today ?? 0} due today, ${counts.overdue ?? 0} overdue, ${counts.week ?? 0} in 7 days, ${counts.waiting ?? 0} waiting, ${counts.noDue ?? 0} without due date${next}${protectedTag(value)}`
}

function renderWho(value) {
  if (!value || value.ok !== true) return renderError(value)
  const counts = (value.data ?? {}).counts ?? {}
  return `${previewTag(value)}who: ${counts.mine ?? 0} owed by me, ${counts.waiting ?? 0} waiting on others (${counts.open ?? 0} open)${protectedTag(value)}`
}

function renderEvidence(value) {
  if (!value || value.ok !== true) return renderError(value)
  const data = value.data ?? {}
  const counts = data.counts ?? {}
  return `${previewTag(value)}${asString(data.kind)} ${asString(data.id)}: ${counts.sources ?? 0} source(s), ${counts.missing ?? 0} missing (ledger refs only; turns not verified)`
}

function renderClients(value) {
  if (!value || value.ok !== true) return renderError(value)
  const data = value.data ?? {}
  if (data.action === 'show') {
    const client = data.client ?? {}
    const counts = data.counts ?? {}
    const open = data.open ?? {}
    const projects = Array.isArray(data.projects) ? data.projects.length : 0
    const timeline = Array.isArray(data.timeline) ? data.timeline.length : 0
    const next = asString(data.nextDueAt) || 'none'
    return `${previewTag(value)}client ${asString(client.name)} (${asString(client.id)}): ${counts.matters ?? 0} matter(s), ${open.mineTotal ?? 0} mine / ${open.waitingTotal ?? 0} waiting, ${counts.deliveries ?? 0} delivery(s), ${counts.notes ?? 0} note(s), next due ${next}; ${projects} project(s); timeline ${timeline}/${data.timelineTotal ?? 0}${data.timelineTruncated ? ' (truncated)' : ''}${protectedTag(value)}`
  }
  const clients = Array.isArray(data.clients) ? data.clients.length : 0
  const noTables = data.customerEntities === false && data.preview !== true ? ' (no customer tables in this ledger)' : ''
  return `${previewTag(value)}clients: ${clients}/${data.total ?? 0} shown${data.truncated ? ' (truncated)' : ''}${noTables}${protectedTag(value)}`
}

const asString = (value) => (typeof value === 'string' ? value : '')

const TODAY_DESCRIPTION = 'Read-only view of the real local Advisers ledger: today/overdue/next-7-days/waiting counts, capped lists and the earliest due item. Opens ~/.advisers/state.db read-only (no HOME write lock, no migration, no writes) and requires an existing accepted TOS record. Falls back to a marked preview ([preview: no ledger]) only when no ledger exists or the read-only facade is unavailable; TOS/schema/vault/corruption/busy failures are structured errors, not empty data. Reads at clearance 0: records of protected matters are excluded and only counted. Never writes the ledger and never sends a message.'
const WHO_DESCRIPTION = 'Read-only view of who owes whom in the real local Advisers ledger: open commitments I owe (user/agent debtor) and ones I am waiting on (third-party debtor), with counts and capped lists. Opens ~/.advisers/state.db read-only (no HOME write lock, no migration, no writes) and requires an existing accepted TOS record. Falls back to a marked preview ([preview: no ledger]) only when no ledger exists or the read-only facade is unavailable; TOS/schema/vault/corruption/busy failures are structured errors, not empty data. Reads at clearance 0: records of protected matters are excluded and only counted. Never writes the ledger and never sends a message.'
const EVIDENCE_DESCRIPTION = 'Read-only evidence lookup in the real local Advisers ledger for a commitment (cm_…), fact (fact_…), or preference (pref_…) id: the stored quotes/refs/sources. It does not resolve turn bodies (verified:false), write the ledger, or send a message; use `advisers evidence show <id> --json` in the CLI or MCP for turn-resolved evidence. Opens ~/.advisers/state.db read-only with the same TOS/schema/vault gates as advisers_today; a missing ledger or an unavailable facade falls back to a marked preview. Records of protected matters are withheld with EVIDENCE_PROTECTED (clearance 0).'
const CLIENTS_DESCRIPTION = 'Read-only customer projection from the real local Advisers ledger: list active clients (or one client by id) with exact counts, next due date, open mine/waiting items, project summaries and a derived delivery/commitment timeline. It never returns note bodies or conversation text. Opens ~/.advisers/state.db read-only (no HOME write lock, no migration, no writes) and requires an existing accepted TOS record; a missing ledger or an unavailable facade falls back to a marked preview ([preview: no ledger]), and a JSON ledger store (no customer tables) returns an empty list marked customerEntities:false. Reads at clearance 0: protected matters and client-level notes are excluded and only counted. Never writes the ledger and never sends a message.'

/**
 * DSH bundle entry point. It registers the service plus the read-only brief /
 * today / who / evidence tools and the workspace-confined office builder. The
 * three ledger readers read the real ledger read-only in 0.3.0 (see the read
 * facade import above) and fall back to the marked 0.2.x preview.
 */
export function apply(ctx, config = {}) {
  const runtime = new AdvisersRuntime({
    stage: config.stage === 'trusted' ? 'trusted' : 'probation',
  })
  const reader = createLedgerReader(config, { runtime })

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
    description: TODAY_DESCRIPTION,
    parameters: {},
    output: {
      schema: readOnlyResultSchema(todayDataSchema),
      render: (_args, value) => [{ type: 'text', text: renderToday(value) }],
    },
    async execute() {
      return executeRead(runtime, 'advisers_today', () => reader.todayView())
    },
  }))

  ctx.tools.register(defineTool({
    name: 'advisers_who',
    description: WHO_DESCRIPTION,
    parameters: {},
    output: {
      schema: readOnlyResultSchema(whoDataSchema),
      render: (_args, value) => [{ type: 'text', text: renderWho(value) }],
    },
    async execute() {
      return executeRead(runtime, 'advisers_who', () => reader.whoView())
    },
  }))

  ctx.tools.register(defineTool({
    name: 'advisers_evidence',
    description: EVIDENCE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Evidence id: cm_… for a commitment, fact_… for a fact, pref_… for a preference.' },
    },
    output: {
      schema: readOnlyResultSchema(evidenceDataSchema),
      render: (_args, value) => [{ type: 'text', text: renderEvidence(value) }],
    },
    async execute(args) {
      return executeRead(runtime, 'advisers_evidence', () => reader.evidenceView(args))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'advisers_clients',
    description: CLIENTS_DESCRIPTION,
    parameters: {
      action: { type: 'string', enum: ['list', 'show'], required: true, description: 'list: client rows; show: one client view.' },
      id: { type: 'string', description: 'Client id (cl_…) required when action is "show".' },
      limit: { type: 'number', description: 'Max rows (client rows for list, timeline rows for show): integer 1..50, default 20.' },
    },
    output: {
      schema: clientsOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderClients(value) }],
    },
    async execute(args) {
      return executeRead(runtime, 'advisers_clients', () => reader.clientsView(args))
    },
  }))
}
