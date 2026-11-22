/**
 * Advisers MCP server (JSON-RPC 2.0 over stdio; legacy '2024-11-05' handshake
 * plus the stateless modern '2026-07-28' revision — dual-era since 0.4.0).
 *
 * This module is the testable library extracted from the MCP section of
 * 'bin/advisers.js'. The binary owns process wiring (home, audit key, sqlite);
 * this module owns the protocol surface and never touches the network.
 *
 * Era rules (0.4.0):
 * - A request is served by the modern path only when it carries the per-request
 *   metadata in 'params._meta' (io.modelcontextprotocol/protocolVersion or
 *   .../clientCapabilities) and is not 'initialize'. The modern path is a strict
 *   allowlist (server/discover, tools/list, tools/call, resources/list,
 *   resources/read) that returns the SAME read-model payload wrapped in the
 *   modern result envelope (resultType + optional ttlMs/cacheScope + _meta).
 * - Every other request keeps the legacy dispatcher byte-for-byte, so 0.3.x
 *   clients observe exactly the old responses. ADVISERS_MCP_MODERN=off disables
 *   the era layer entirely.
 *
 * Surface (0.2.0):
 * - 5 read-only tools: today / commit_ls / who / evidence / remind
 * - 2 whitelisted writes:
 *     advisers_capture_candidate  -> creates a PENDING memory candidate only.
 *       It never accepts a candidate and never writes the ledger; a human must
 *       run 'advisers memory accept <id>' afterwards.
 *     advisers_pack_verify        -> read-only verification of an evidence-pack
 *       receipt directory (manifest.json / README.txt / SHA256SUMS [+ receipt.docx]).
 * - 4 read-only resources: today / commitments / who / evidence (JSON).
 *
 * Invariants:
 * - No absolute paths and no raw input (tool arguments, quotes, filesystem
 *   paths) are echoed in error messages.
 * - Every 'tools/call' is audited through the injected 'audit' callback
 *   ({actor, action, allowed, reason}). A write that cannot be audited fails
 *   closed: a created candidate is rejected and the call returns an error.
 * - One JSON-RPC request per line, UTF-8, hard cap 1 MiB per line.
 */

import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  evidenceForCommitment,
  evidenceForFact,
  evidenceForPreference,
  isEvidenceRecordAboveClearance,
  verifyPack,
} from './evidence.js'
import { buildReminders } from './remind.js'
import { inspectCaptureText } from './capture.js'
import { listClientRows, readClientStatus } from './customer-read.js'
import { buildDisclosure, disclosureAuditReason, fieldsOf, verificationOf, viewOf, withAudited } from './disclosure.js'
import { classify, redact, safetyErrorFrom } from './safety/index.js'

/**
 * Default MCP protocol version. Legacy clients that send no version (or an
 * unknown one) keep getting 2024-11-05, i.e. the pre-0.3.0 behaviour.
 */
export const PROTOCOL_VERSION = '2024-11-05'
/**
 * Legacy protocol versions negotiated by `initialize` (0.3.0 P0-T3).
 *
 * The 2025-06-18 / 2025-11-25 revisions keep the same initialize/tools/
 * resources lifecycle this server implements, so echoing the client's
 * supported version is safe; anything else (including a stray 2026-07-28
 * value, which is modern-era and never negotiated through initialize) falls
 * back to PROTOCOL_VERSION. The modern revision is served statelessly through
 * the per-request `_meta` path below; dual-era clients pick it with
 * `server/discover` and legacy clients keep the handshake.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2024-11-05', '2025-06-18', '2025-11-25'])
/**
 * Modern (stateless) MCP revision served by the era layer (0.4.0).
 *
 * Spec: <https://modelcontextprotocol.io/specification/2026-07-28/>. There is
 * no initialize handshake: every request declares its protocol version and
 * client capabilities in `params._meta` and the server answers it statelessly.
 */
export const MODERN_PROTOCOL_VERSION = '2026-07-28'
export const SUPPORTED_MODERN_PROTOCOL_VERSIONS = Object.freeze([MODERN_PROTOCOL_VERSION])
/** Reserved modern `_meta` keys (spec: basic/index#_meta). */
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'
/**
 * Explicit modern method allowlist. The modern era removed initialize/ping/
 * logging/roots and keeps resources/subscribe out; anything not listed here is
 * answered with -32601 instead of falling through to the legacy dispatcher.
 */
export const MODERN_METHODS = Object.freeze(['server/discover', 'tools/list', 'tools/call', 'resources/list', 'resources/read'])
/**
 * Cache hints for cacheable modern results (spec: server/utilities/caching).
 * The tool/resource catalogue is static for the process lifetime, so it is safe
 * to cache publicly; ledger reads are private and stale immediately.
 */
export const MODERN_CACHE_HINTS = Object.freeze({
  discover: Object.freeze({ ttlMs: 300000, cacheScope: 'public' }),
  toolsList: Object.freeze({ ttlMs: 300000, cacheScope: 'public' }),
  resourcesList: Object.freeze({ ttlMs: 300000, cacheScope: 'public' }),
  resourcesRead: Object.freeze({ ttlMs: 0, cacheScope: 'private' }),
})
/** ADVISERS_MCP_MODERN values that disable the modern era (default: enabled). */
const MODERN_OFF_VALUES = Object.freeze(['off', '0', 'false', 'no', 'disabled'])
/** True unless ADVISERS_MCP_MODERN explicitly disables the modern era. */
export function resolveModernEnabled(env = process.env) {
  const raw = env?.ADVISERS_MCP_MODERN
  if (raw === undefined || raw === null) return true
  return !MODERN_OFF_VALUES.includes(String(raw).trim().toLowerCase())
}
/**
 * Modern per-request metadata, or null for a legacy request. `initialize` is
 * never modern (the handshake IS the legacy-era discriminator), and a request
 * with no modern `_meta` key stays on the legacy path even when `_meta` exists
 * for another reason (e.g. `progressToken`) — era is never guessed.
 */
function modernRequestMeta(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  const meta = params._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  if (!Object.prototype.hasOwnProperty.call(meta, META_PROTOCOL_VERSION)
    && !Object.prototype.hasOwnProperty.call(meta, META_CLIENT_CAPABILITIES)) return null
  return meta
}
export const SERVER_NAME = 'advisers'
/** Hard cap for one stdio JSON-RPC line (bytes). */
export const MAX_LINE_BYTES = 1024 * 1024
/**
 * Output caps for every list-shaped tool result (0.3.0 P0-T3 / S2).
 *
 * The content-safety classifier fail-closes any mcp.tool egress surface above
 * 100k characters (lib/safety/classifier.js MAX_SCAN_CHARS), so an unbounded
 * ledger listing used to turn advisers_today/commit_ls/remind into
 * CONTENT_BLOCKED errors on a large ledger. Every read model now truncates
 * AFTER the per-item clearance filter and BEFORE the classifier runs, and
 * reports the true post-filter count in `total`/`mineTotal`/`waitingTotal`
 * with `truncated: true`. Small ledgers are byte-for-byte unchanged.
 */
export const MCP_OUTPUT_LIMITS = Object.freeze({
  todayCommitments: 20,
  commitRows: 50,
  commitRowsMax: 200,
  whoRows: 20,
  reminders: 20,
  evidenceItems: 20,
  clients: 20,
  clientsMax: 50,
  clientTimeline: 20,
  clientTimelineMax: 50,
  clientOpen: 20,
})
/**
 * Last-resort byte budget for one tool/resource payload. The per-tool row caps
 * keep every normal result far below this, but a single commitment with a huge
 * evidence array could still push a list over the classifier's 100k-character
 * fail-closed threshold. When that happens the longest list is halved (and
 * marked truncated) until the serialized payload fits, so the egress
 * classifier never turns a large ledger into CONTENT_BLOCKED.
 */
export const MCP_MAX_RESULT_BYTES = 64 * 1024
const PAYLOAD_LIST_KEYS = Object.freeze(['commitments', 'mine', 'waiting', 'reminders', 'sources', 'missing', 'clients', 'projects', 'timeline'])
/**
 * Read tools whose successful result carries the additive 0.5.0 disclosure
 * block and row-level `view` labels. The two write tools (pending capture and
 * read-only pack verification) and `advisers_remind` keep their exact 0.4.x
 * payload bytes.
 */
const DISCLOSURE_TOOLS = Object.freeze(['advisers_today', 'advisers_commit_ls', 'advisers_who', 'advisers_evidence', 'advisers_clients'])
const DISCLOSURE_TOOL_SET = new Set(DISCLOSURE_TOOLS)
/** Warning on disclosure.audited=false when no audit sink is configured. */
const DISCLOSURE_WARNING = 'audit chain unavailable: this read is not recorded in the local tamper-evident audit log'
/** Receipt directories are small; refuse to slurp anything huge. */
export const MAX_PACK_FILE_BYTES = 512 * 1024
export const MAX_PACK_SUMS_BYTES = 64 * 1024

// Content-safety wiring (docs/CONTENT-SAFETY.md section 8): tools/call argument
// text and returned text are classified with the mcp.tool surface. A block-level
// call returns a structured CONTENT_BLOCKED tool error (isError true) instead of
// crashing the JSON-RPC server; blocked writes never reach the store because the
// capture gate runs inside advisers_capture_candidate before proposeCandidate.
const MCP_SURFACE = 'mcp.tool'

export const TOOL_NAMES = Object.freeze([
  'advisers_today',
  'advisers_commit_ls',
  'advisers_who',
  'advisers_evidence',
  'advisers_remind',
  'advisers_clients',
  'advisers_capture_candidate',
  'advisers_pack_verify',
])

export const RESOURCE_URIS = Object.freeze([
  'advisers://today',
  'advisers://commitments',
  'advisers://who',
  'advisers://evidence',
  'advisers://clients',
])

const RESOURCE_DEFINITIONS = Object.freeze([
  {
    uri: 'advisers://today',
    name: 'today',
    description: 'Open commitments and their count (same shape as advisers_today; protected matters excluded at the server clearance).',
    mimeType: 'application/json',
  },
  {
    uri: 'advisers://commitments',
    name: 'commitments',
    description: 'All commitments (open and closed) as compact rows.',
    mimeType: 'application/json',
  },
  {
    uri: 'advisers://who',
    name: 'who',
    description: 'Who owes whom: mine (user/agent) vs waiting (third parties).',
    mimeType: 'application/json',
  },
  {
    uri: 'advisers://evidence',
    name: 'evidence',
    description: 'Evidence traceback index for commitments, facts and preferences (counts only).',
    mimeType: 'application/json',
  },
  {
    uri: 'advisers://clients',
    name: 'clients',
    description: 'Active client rows as compact read-only projections (exact counts and next due date; no note text or conversation bodies), capped with total/truncated/limit and clearance/protectedExcluded.',
    mimeType: 'application/json',
  },
])

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
})

const WRITE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
})

const CAPTURE_TOOL = Object.freeze({
  name: 'advisers_capture_candidate',
  description:
    'Propose a PENDING commitment candidate captured from a quote. This writes a memory candidate only: it never accepts the candidate and never changes the ledger. A human must review it with "advisers memory candidates" and run "advisers memory accept <id>".',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', minLength: 1, maxLength: 500, description: 'What must be done (verbatim or near-verbatim).' },
      quote: { type: 'string', minLength: 1, maxLength: 2000, description: 'The verbatim source text this candidate was captured from.' },
      debtor: { type: 'string', enum: ['user', 'agent', 'third'], description: 'Who owes the action. Defaults to user.' },
      creditor: { type: 'string', maxLength: 200, description: 'Who is owed the action. Defaults to someone.' },
      dueAt: { type: 'string', maxLength: 64, description: 'ISO 8601 due date-time, e.g. 2026-12-01T10:00:00+08:00.' },
      matterId: { type: 'string', maxLength: 120, description: 'Existing matter id. Defaults to the first active matter.' },
    },
    required: ['action', 'quote'],
    additionalProperties: false,
  },
  annotations: WRITE_ANNOTATIONS,
  write: true,
})

const PACK_VERIFY_TOOL = Object.freeze({
  name: 'advisers_pack_verify',
  description:
    'Read-only verification of an evidence-pack receipt directory: recomputes SHA256SUMS for manifest.json and README.txt, rejects unsafe or unhashed pack files, and reports whether a receipt.docx is present. Never modifies the directory. The directory path is not echoed in errors.',
  inputSchema: {
    type: 'object',
    properties: {
      dir: { type: 'string', minLength: 1, maxLength: 4096, description: 'Directory written by "advisers deliveries --pack" (contains manifest.json, README.txt, SHA256SUMS, optionally receipt.docx).' },
    },
    required: ['dir'],
    additionalProperties: false,
  },
  // Read-only in effect: it never writes to the receipt directory.
  annotations: READ_ONLY_ANNOTATIONS,
  write: false,
})

/* -------------------------------------------------------------------------- */
/* errors                                                                      */
/* -------------------------------------------------------------------------- */

class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RpcError'
    this.code = code
  }
}

/** A controlled execution failure; its message is safe to return verbatim. */
class ToolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ToolError'
  }
}

function invalidParams(message) {
  return new RpcError(-32602, message)
}

/** JSON text for classification only; never echoes raw input in errors. */
function safeJson(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return ''
  }
}

/**
 * Enforce MCP_MAX_RESULT_BYTES on a list-shaped payload, trimming the longest
 * array until it fits and marking the result truncated (the total fields stay
 * the true post-clearance counts). Non-list payloads are returned unchanged.
 */
function boundPayload(data) {
  if (Buffer.byteLength(safeJson(data), 'utf8') <= MCP_MAX_RESULT_BYTES) return data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const trimmed = { ...data }
  for (;;) {
    if (Buffer.byteLength(safeJson(trimmed), 'utf8') <= MCP_MAX_RESULT_BYTES) break
    let target = null
    for (const key of PAYLOAD_LIST_KEYS) {
      const list = trimmed[key]
      if (!Array.isArray(list) || list.length === 0) continue
      if (target === null || list.length > trimmed[target].length) target = key
    }
    if (target === null) break
    trimmed[target] = trimmed[target].slice(0, Math.floor(trimmed[target].length / 2))
    trimmed.truncated = true
  }
  return trimmed
}

/** Structured CONTENT_BLOCKED tool result: isError=true, no original text. */
function toolBlocked(id, error) {
  const payload = {
    ok: false,
    error: {
      code: 'CONTENT_BLOCKED',
      message: error.message,
      action: error.action,
      surface: error.surface,
      ruleIds: Array.isArray(error.ruleIds) ? error.ruleIds : [],
      rulesetVersion: error.rulesetVersion,
      auditReason: error.auditReason,
    },
  }
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true } }
}

/* -------------------------------------------------------------------------- */
/* argument validation (messages are fixed strings; raw values are not echoed) */
/* -------------------------------------------------------------------------- */

const SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,40}$/

function sanitizeToken(value) {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : 'argument'
}

function assertAllowedKeys(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw invalidParams('unexpected argument')
  }
}

function requireString(args, key, { min = 1, max = 500 } = {}) {
  const value = args[key]
  if (typeof value !== 'string') throw invalidParams(key + ' must be a string')
  const text = value.trim()
  if (text.length < min) throw invalidParams(key + ' must not be empty')
  if (text.length > max) throw invalidParams(key + ' is too long')
  return text
}

function optionalString(args, key, { max = 200 } = {}) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalidParams(key + ' must be a string')
  const text = value.trim()
  if (!text) return undefined
  if (text.length > max) throw invalidParams(key + ' is too long')
  return text
}

function optionalEnum(args, key, allowed, fallback) {
  const text = optionalString(args, key, { max: 40 })
  if (text === undefined) return fallback
  if (!allowed.includes(text)) throw invalidParams(key + ' must be one of ' + allowed.join(', '))
  return text
}

function optionalBoolean(args, key) {
  const value = args[key]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw invalidParams(key + ' must be a boolean')
  return value
}

/** Optional 1..max integer row limit (undefined keeps the tool default). */
function optionalLimit(args, key, max) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw invalidParams(key + ' must be an integer between 1 and ' + max)
  }
  return value
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

function optionalIsoDate(args, key) {
  const text = optionalString(args, key, { max: 64 })
  if (text === undefined) return undefined
  if (!ISO_DATE_TIME.test(text) || Number.isNaN(Date.parse(text))) throw invalidParams(key + ' must be an ISO 8601 date-time')
  return text
}

function paramsObject(params) {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) throw invalidParams('params must be an object')
  return params
}

/* -------------------------------------------------------------------------- */
/* receipt-directory reader (read-only, fail-closed, no path leaks)            */
/* -------------------------------------------------------------------------- */

function isSafePackName(name) {
  if (typeof name !== 'string' || !name || name.length > 128) return false
  if (/[\u0000-\u001f\u007f]/.test(name)) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  if (/^[A-Za-z]:/.test(name)) return false
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false
  return true
}

function listedPackNames(sumsText) {
  const names = new Set()
  for (const raw of String(sumsText).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line)
    if (!match) continue
    const name = match[2].trim()
    if (isSafePackName(name) && name !== 'SHA256SUMS') names.add(name)
  }
  return names
}

function readPackFile(dir, name, maxBytes) {
  if (!isSafePackName(name)) return undefined
  const path = join(dir, name)
  // Defense in depth: a safe basename must still resolve inside the directory.
  if (resolve(path) !== resolve(dir, name)) return undefined
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return undefined
  }
  if (stat.isSymbolicLink()) throw new ToolError('pack files must be regular files')
  if (!stat.isFile()) return undefined
  if (stat.size > maxBytes) throw new ToolError('pack file exceeds the size limit')
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Read the pack files of a receipt directory. Only known pack names and names
 * listed inside SHA256SUMS are read; a receipt.docx is reported by presence,
 * never parsed. Errors are generic (no absolute paths).
 *
 * @returns {{files: Record<string,string>, receiptPresent: boolean, extraFileCount: number}}
 */
export function readReceiptDirectory(dir) {
  let stat
  try {
    stat = statSync(dir)
  } catch {
    throw new ToolError('pack directory not found')
  }
  if (!stat.isDirectory()) throw new ToolError('pack directory not found')

  const files = {}
  const sums = readPackFile(dir, 'SHA256SUMS', MAX_PACK_SUMS_BYTES)
  if (sums !== undefined) files.SHA256SUMS = sums

  const wanted = new Set(['manifest.json', 'README.txt'])
  if (sums !== undefined) for (const name of listedPackNames(sums)) wanted.add(name)
  for (const name of wanted) {
    const content = readPackFile(dir, name, MAX_PACK_FILE_BYTES)
    if (content !== undefined) files[name] = content
  }

  let receiptPresent = false
  let extraFileCount = 0
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!isSafePackName(entry.name)) continue
    if (entry.name === 'receipt.docx') {
      receiptPresent = true
      continue
    }
    if (Object.prototype.hasOwnProperty.call(files, entry.name)) continue
    if (entry.isFile()) extraFileCount += 1
  }
  return { files, receiptPresent, extraFileCount }
}

/* -------------------------------------------------------------------------- */
/* factory                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create an MCP server handler.
 *
 * @param {object} options
 * @param {object} [options.store]   SqliteStore-like object (proposeCandidate, reviewCandidate, getTurn, ...).
 * @param {object} [options.ledger]  Core Ledger-like object (openCommitments, listCommitments, ...).
 * @param {string} [options.version] Server version reported by 'initialize'.
 * @param {Function} [options.audit] Audit sink: ({actor, action, allowed, reason}) => unknown.
 * @param {Function} [options.readPack] Injectable receipt-directory reader returns {files, receiptPresent, extraFileCount}; defaults to readReceiptDirectory.
 * @param {Function|Date} [options.now] Clock used by reminders (defaults to new Date()).
 * @param {number} [options.clearance=0] Read clearance of this MCP surface
 *        (0.2.5 A-2). Every read model excludes records whose matter secrecy is
 *        above it and reports `protectedExcluded`; 0 (fail closed) is the
 *        default and a client cannot raise it through a tool argument.
 * @param {Function} [options.loadCommitmentView] 0.3.2 P2-1 narrow read model:
 *        `(options: {all: boolean, clearance: number}) => {rows, total,
 *        protectedExcluded}` where rows are the positional projection from
 *        `SqliteStore.projectCommitmentReadModel()` (id/debtor/creditor/action/
 *        dueAt/status/matterId/reminderOffsets/hidden). When supplied, today /
 *        commit_ls / who / remind read this projection instead of loading the
 *        full ledger. Omitted => the legacy ledger path is used unchanged
 *        (embedders/tests that pass `ledger` never change behaviour).
 * @param {Function} [options.loadCommitmentRecords] 0.3.2 P2-1 hydration for
 *        `advisers_who` (whose payload is full Commitment rows): `(ids: string[])
 *        => Map<string, object> | object[]`. Only the capped <= 20 rows per
 *        bucket are hydrated; omitted => the narrow who path is not used.
 * @param {boolean} [options.modern] Dual-era (0.4.0): serve the stateless
 *        2026-07-28 revision for requests that carry modern per-request
 *        `params._meta`. Defaults to `ADVISERS_MCP_MODERN` (enabled unless the
 *        env value is off/0/false/no/disabled); explicit `false` forces
 *        legacy-only, `true` forces dual-era even when the env disables it.
 * @returns {{protocolVersion: string, handle: Function, handleLine: Function, serve: Function, tools: Function, resources: Function}}
 */
export function createMcpServer({ store, ledger, loadLedger, loadStore, loadCommitmentView, loadCommitmentRecords, version = '0.0.0', audit, readPack, now = () => new Date(), clearance = 0, modern } = {}) {
  const serverVersion = String(version ?? '0.0.0')
  // 0.4.0 MCP modern: dual-era switch. The env var is read per factory call, so
  // `ADVISERS_MCP_MODERN=off advisers mcp --stdio` is a one-restart rollback to
  // the exact 0.3.2 surface without touching the CLI wiring.
  const modernEnabled = modern === undefined ? resolveModernEnabled() : modern === true
  // Protocol version agreed by the last legacy `initialize` (advisory only:
  // the legacy method surface is identical for every supported revision).
  let negotiatedProtocolVersion = PROTOCOL_VERSION
  // 0.2.5 A-2: clearance is process configuration, never a tool argument. An
  // invalid/negative value falls back to the most restrictive level (0).
  const requestedClearance = Number(clearance)
  const clearanceLevel = Number.isFinite(requestedClearance) && requestedClearance >= 0 ? requestedClearance : 0
  // 0.5.0 disclosure: audited is true only when this process actually has an
  // audit sink (the shipped bin wires store.appendAudit; embedders may not).
  const auditConfigured = typeof audit === 'function'
  // 0.2.3 P0-2: the CLI wires lazy loaders instead of a preloaded ledger/store so
  // `initialize` stays protocol-only (200k-row ledgers used to cost ~2s before the
  // first response). Anything that needs data resolves it on first use; an
  // explicit ledger/store object (tests, embedders) still wins, and the resolved
  // value is cached per table subset. kind: 'commitments' | 'matters' | 'full'.
  let resolvedLedger = ledger
  let resolvedStore = store
  const ledgerCache = new Map()
  // 0.3.2 P2-1: process-level cache of the narrow commitment view, keyed like
  // the legacy ledger cache (the snapshot is taken on first use and reused until
  // the process exits; refresh semantics are unchanged).
  const commitmentViewCache = new Map()
  function commitmentView(options = {}) {
    if (typeof loadCommitmentView !== 'function') return null
    const key = String(options.all === true) + ':' + String(options.clearance ?? clearanceLevel)
    if (commitmentViewCache.has(key)) return commitmentViewCache.get(key)
    const view = loadCommitmentView(options)
    commitmentViewCache.set(key, view)
    return view
  }
  /** Normalize loadCommitmentRecords() output to an id -> record Map. */
  function commitmentRecordsById(ids) {
    const loaded = loadCommitmentRecords(ids)
    if (loaded instanceof Map) return loaded
    const byId = new Map()
    if (Array.isArray(loaded)) {
      for (const record of loaded) {
        if (record && typeof record.id === 'string' && record.id) byId.set(record.id, record)
      }
    }
    return byId
  }
  function ledgerFor(kind = 'full') {
    if (resolvedLedger !== undefined) return resolvedLedger
    if (ledgerCache.has(kind)) return ledgerCache.get(kind)
    const loaded = typeof loadLedger === 'function' ? loadLedger(kind) : undefined
    ledgerCache.set(kind, loaded)
    return loaded
  }
  function storeFor() {
    if (resolvedStore === undefined && typeof loadStore === 'function') resolvedStore = loadStore()
    return resolvedStore
  }

  function nowDate() {
    const value = typeof now === 'function' ? now() : now
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? new Date() : date
  }

  function requireLedger(kind = 'full') {
    const ledgerApi = ledgerFor(kind)
    if (!ledgerApi || typeof ledgerApi.openCommitments !== 'function' || typeof ledgerApi.listCommitments !== 'function') {
      throw new ToolError('ledger unavailable')
    }
    return ledgerApi
  }

  function requireStore() {
    const storeApi = storeFor()
    if (!storeApi || typeof storeApi.proposeCandidate !== 'function') throw new ToolError('candidate store unavailable')
    return storeApi
  }

  // 0.2.5 A-2 (MCP clearance): commitments/facts/preferences are judged by the
  // secrecy of their OWN matter. The 'commitments' read path does not need the
  // matters table for anything else, so resolve the small matters table too; with
  // an embedder-provided ledger that has no getMatter we fail closed instead of
  // returning unfiltered data.
  let matterLedger
  function matterSource() {
    if (matterLedger !== undefined) return matterLedger
    const primary = ledgerFor('commitments')
    if (primary && typeof primary.getMatter === 'function') {
      matterLedger = primary
    } else {
      const matters = ledgerFor('matters')
      matterLedger = matters && typeof matters.getMatter === 'function' ? matters : primary ?? matters ?? {}
    }
    return matterLedger
  }

  /** True when the record's matter secrecy is above this server's clearance. */
  function isHidden(kind, record) {
    if (!record || typeof record !== 'object') return false
    return isEvidenceRecordAboveClearance(matterSource(), kind, record, clearanceLevel)
  }

  /** Split a list into visible rows and the withheld count (never a row). */
  function splitByClearance(kind, rows) {
    const visible = []
    let protectedExcluded = 0
    for (const row of rows) {
      if (isHidden(kind, row)) protectedExcluded += 1
      else visible.push(row)
    }
    return { visible, protectedExcluded }
  }

  /* ------------------------- read disclosure (0.5.0) ----------------------- */

  // 0.5.0 M1: the read models above stay value-identical; every successful
  // result of the five read tools and the five resources is augmented with
  // per-row `view` labels and one additive `disclosure` block. The disclosure
  // carries metadata only (fields/counts/clearance/digest), never record
  // values, quotes or paths; callId/digest are content-addressed so legacy and
  // modern era bytes stay identical for the same request.
  function commitmentVerification(id) {
    if (typeof id !== 'string' || !id) return null
    try {
      const ledgerApi = ledgerFor('commitments')
      if (!ledgerApi) return null
      return verificationOf(evidenceForCommitment(storeFor(), ledgerApi, id))
    } catch {
      // A read that already succeeded must not fail because verification of
      // one row hit a missing loader/store: the row stays `pending`.
      return null
    }
  }

  function annotateCommitmentRows(rows) {
    const list = Array.isArray(rows) ? rows : []
    const fields = fieldsOf(list)
    const verificationCache = new Map()
    const views = []
    const annotated = list.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row
      const id = typeof row.id === 'string' ? row.id : ''
      let verification = null
      if (id) {
        verification = verificationCache.get(id)
        if (verification === undefined) {
          verification = commitmentVerification(id)
          verificationCache.set(id, verification)
        }
      }
      const view = viewOf('commitment', row, verification)
      views.push(view)
      return { ...row, view }
    })
    return { rows: annotated, fields, views }
  }

  function annotateCommitmentList(data, tool) {
    const annotated = annotateCommitmentRows(data?.commitments)
    return {
      ...data,
      commitments: annotated.rows,
      disclosure: buildDisclosure({
        tool,
        fields: annotated.fields,
        views: annotated.views,
        clearance: data?.clearance ?? clearanceLevel,
        protectedExcluded: data?.protectedExcluded,
        truncated: data?.truncated === true,
      }),
    }
  }

  function annotateWho(data, tool) {
    const mine = annotateCommitmentRows(data?.mine)
    const waiting = annotateCommitmentRows(data?.waiting)
    return {
      ...data,
      mine: mine.rows,
      waiting: waiting.rows,
      disclosure: buildDisclosure({
        tool,
        fields: [...new Set([...mine.fields, ...waiting.fields])].sort(),
        views: [...mine.views, ...waiting.views],
        clearance: data?.clearance ?? clearanceLevel,
        protectedExcluded: data?.protectedExcluded,
        truncated: data?.truncated === true,
      }),
    }
  }

  function annotateEvidenceTool(data, tool) {
    // The 0.4.x evidence payload keys the record by kind and carries no explicit
    // `kind` field, so detect it from the record key (never from the request id).
    const kind = data?.commitment && typeof data.commitment === 'object'
      ? 'commitment'
      : data?.fact && typeof data.fact === 'object'
        ? 'fact'
        : data?.preference && typeof data.preference === 'object' ? 'preference' : null
    const record = kind ? data[kind] : undefined
    const base = {
      tool,
      clearance: data?.clearance ?? clearanceLevel,
      protectedExcluded: data?.protectedExcluded,
      truncated: data?.truncated === true,
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { ...data, disclosure: buildDisclosure({ ...base, fields: [], views: [] }) }
    }
    const verification = verificationOf(data, {
      resolved: Number.isInteger(data.sourcesTotal) ? data.sourcesTotal : undefined,
      missing: Number.isInteger(data.missingTotal) ? data.missingTotal : undefined,
    })
    const view = viewOf(kind, record, verification)
    return {
      ...data,
      [kind]: { ...record, view },
      disclosure: buildDisclosure({ ...base, fields: fieldsOf([record]), views: [view] }),
    }
  }

  function annotateClientRows(rows) {
    const list = Array.isArray(rows) ? rows : []
    const fields = fieldsOf(list)
    const views = list.map((row) => viewOf('client', row))
    const annotated = list.map((row, index) => (row && typeof row === 'object' && !Array.isArray(row) ? { ...row, view: views[index] } : row))
    return { rows: annotated, fields, views }
  }

  function annotateClients(data, tool) {
    const base = {
      tool,
      clearance: data?.clearance ?? clearanceLevel,
      protectedExcluded: data?.protectedExcluded,
    }
    // The MCP tool/resource list payload has no `action` field (only the DSH
    // payload sets it), so a clients array is the list discriminator here.
    if (data?.action === 'list' || Array.isArray(data?.clients)) {
      const annotated = annotateClientRows(data.clients)
      return {
        ...data,
        clients: annotated.rows,
        disclosure: buildDisclosure({ ...base, fields: annotated.fields, views: annotated.views, truncated: data?.truncated === true }),
      }
    }
    const client = data?.client
    const hasClient = Boolean(client && typeof client === 'object' && !Array.isArray(client))
    const payload = hasClient ? { ...data, client: { ...client, view: 'derived' } } : { ...data }
    return {
      ...payload,
      disclosure: buildDisclosure({ ...base, fields: hasClient ? fieldsOf([client]) : [], views: hasClient ? ['derived'] : [], truncated: data?.timelineTruncated === true }),
    }
  }

  function annotateEvidenceIndexRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row
    const found = row.found === true
    const view = found && Number(row.sources) > 0 ? 'verified' : 'pending'
    return { ...row, view }
  }

  function annotateEvidenceIndex(data, tool) {
    const commitments = Array.isArray(data?.commitments) ? data.commitments : []
    const facts = Array.isArray(data?.facts) ? data.facts : []
    const preferences = Array.isArray(data?.preferences) ? data.preferences : []
    const rows = [...commitments, ...facts, ...preferences]
    const views = rows.map((row) => annotateEvidenceIndexRow(row)?.view ?? 'pending')
    return {
      ...data,
      commitments: commitments.map(annotateEvidenceIndexRow),
      facts: facts.map(annotateEvidenceIndexRow),
      preferences: preferences.map(annotateEvidenceIndexRow),
      disclosure: buildDisclosure({
        tool,
        fields: fieldsOf(rows),
        views,
        clearance: data?.clearance ?? clearanceLevel,
        protectedExcluded: data?.protectedExcluded,
        truncated: data?.truncated === true,
      }),
    }
  }

  /** Add the additive disclosure/view block to one successful read tool result. */
  function addToolDisclosure(toolName, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data
    if (toolName === 'advisers_today' || toolName === 'advisers_commit_ls') return annotateCommitmentList(data, toolName)
    if (toolName === 'advisers_who') return annotateWho(data, toolName)
    if (toolName === 'advisers_evidence') return annotateEvidenceTool(data, toolName)
    if (toolName === 'advisers_clients') return annotateClients(data, toolName)
    return data
  }

  /** Add the additive disclosure/view block to one successful resource read. */
  function addResourceDisclosure(uri, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data
    if (uri === 'advisers://today' || uri === 'advisers://commitments') return annotateCommitmentList(data, uri)
    if (uri === 'advisers://who') return annotateWho(data, uri)
    if (uri === 'advisers://clients') return annotateClients(data, uri)
    if (uri === 'advisers://evidence') return annotateEvidenceIndex(data, uri)
    return data
  }

  /* ------------------------------ read models ------------------------------ */

  function todayData() {
    const narrow = commitmentView({ all: false, clearance: clearanceLevel })
    if (narrow) {
      const visible = narrow.rows.filter((row) => !row.hidden)
      const commitments = visible.slice(0, MCP_OUTPUT_LIMITS.todayCommitments)
      return {
        open: visible.length,
        commitments: commitments.map((c) => ({ id: c.id, debtor: c.debtor, creditor: c.creditor, action: c.action, dueAt: c.dueAt })),
        clearance: clearanceLevel,
        protectedExcluded: narrow.protectedExcluded,
        total: visible.length,
        truncated: visible.length > commitments.length,
      }
    }
    const open = requireLedger('commitments').openCommitments()
    const view = splitByClearance('commitment', open)
    // Cap AFTER clearance and BEFORE the egress classifier: `open` and `total`
    // stay the true post-filter count, `truncated` says rows were withheld.
    const commitments = view.visible.slice(0, MCP_OUTPUT_LIMITS.todayCommitments)
    return {
      open: view.visible.length,
      commitments: commitments.map((c) => ({ id: c.id, debtor: c.debtor, creditor: c.creditor, action: c.action, dueAt: c.dueAt })),
      clearance: clearanceLevel,
      protectedExcluded: view.protectedExcluded,
      total: view.visible.length,
      truncated: view.visible.length > commitments.length,
    }
  }

  function commitListData(all, requestedLimit) {
    const narrow = commitmentView({ all: true, clearance: clearanceLevel })
    if (narrow) {
      const statusFiltered = all ? narrow.rows : narrow.rows.filter((row) => row.status === 'open')
      const visible = statusFiltered.filter((row) => !row.hidden)
      const limit = Number.isInteger(requestedLimit) ? requestedLimit : MCP_OUTPUT_LIMITS.commitRows
      const commitments = visible.slice(0, limit)
      return {
        commitments: commitments.map((c) => ({ id: c.id, status: c.status, action: c.action, dueAt: c.dueAt, creditor: c.creditor })),
        clearance: clearanceLevel,
        protectedExcluded: statusFiltered.length - visible.length,
        total: visible.length,
        truncated: visible.length > commitments.length,
        limit,
      }
    }
    const rows = requireLedger('commitments')
      .listCommitments()
      .filter((c) => all || c.status === 'open')
    const view = splitByClearance('commitment', rows)
    const limit = Number.isInteger(requestedLimit) ? requestedLimit : MCP_OUTPUT_LIMITS.commitRows
    const commitments = view.visible.slice(0, limit)
    return {
      commitments: commitments.map((c) => ({ id: c.id, status: c.status, action: c.action, dueAt: c.dueAt, creditor: c.creditor })),
      clearance: clearanceLevel,
      protectedExcluded: view.protectedExcluded,
      total: view.visible.length,
      truncated: view.visible.length > commitments.length,
      limit,
    }
  }

  function whoData() {
    const narrow = commitmentView({ all: false, clearance: clearanceLevel })
    if (narrow) {
      const visible = narrow.rows.filter((row) => !row.hidden)
      const mine = visible.filter((c) => c.debtor === 'user' || c.debtor === 'agent')
      const waiting = visible.filter((c) => c.debtor === 'third' || String(c.debtor).startsWith('third:'))
      const limit = MCP_OUTPUT_LIMITS.whoRows
      // who returns full Commitment rows (the frozen v1 shape with
      // evidence/matterId/timezone/...), so hydrate only the capped page.
      const hydrate = (list) => {
        const capped = list.slice(0, limit)
        if (typeof loadCommitmentRecords !== 'function' || !capped.length) return capped
        const byId = commitmentRecordsById(capped.map((row) => row.id))
        return capped.map((row) => byId.get(row.id) ?? row)
      }
      return {
        mine: hydrate(mine),
        waiting: hydrate(waiting),
        clearance: clearanceLevel,
        protectedExcluded: narrow.protectedExcluded,
        mineTotal: mine.length,
        waitingTotal: waiting.length,
        truncated: mine.length > limit || waiting.length > limit,
      }
    }
    const open = requireLedger('commitments').openCommitments()
    const view = splitByClearance('commitment', open)
    const mine = view.visible.filter((c) => c.debtor === 'user' || c.debtor === 'agent')
    const waiting = view.visible.filter((c) => c.debtor === 'third' || String(c.debtor).startsWith('third:'))
    const limit = MCP_OUTPUT_LIMITS.whoRows
    return {
      mine: mine.slice(0, limit),
      waiting: waiting.slice(0, limit),
      clearance: clearanceLevel,
      protectedExcluded: view.protectedExcluded,
      mineTotal: mine.length,
      waitingTotal: waiting.length,
      truncated: mine.length > limit || waiting.length > limit,
    }
  }

  function remindData() {
    const narrow = commitmentView({ all: true, clearance: clearanceLevel })
    if (narrow) {
      const hiddenIds = new Set()
      for (const row of narrow.rows) if (row.hidden) hiddenIds.add(row.id)
      let reminders
      try {
        // buildReminders only needs listCommitments(); the narrow rows carry the
        // fields it reads (id/action/dueAt/status/reminderOffsets).
        reminders = buildReminders({ listCommitments: () => narrow.rows }, { now: nowDate() })
      } catch {
        throw new ToolError('reminder planning failed')
      }
      const visible = []
      let protectedExcluded = 0
      for (const reminder of reminders) {
        if (hiddenIds.has(reminder.commitmentId)) protectedExcluded += 1
        else visible.push(reminder)
      }
      const capped = visible.slice(0, MCP_OUTPUT_LIMITS.reminders)
      return {
        reminders: capped,
        clearance: clearanceLevel,
        protectedExcluded,
        total: visible.length,
        truncated: visible.length > capped.length,
      }
    }
    const ledgerApi = requireLedger('commitments')
    let reminders
    try {
      reminders = buildReminders(ledgerApi, { now: nowDate() })
    } catch {
      throw new ToolError('reminder planning failed')
    }
    let rows
    try {
      rows = ledgerApi.listCommitments()
    } catch {
      rows = []
    }
    const hiddenIds = new Set()
    for (const row of rows) if (isHidden('commitment', row)) hiddenIds.add(row.id)
    const visible = []
    let protectedExcluded = 0
    for (const reminder of reminders) {
      if (hiddenIds.has(reminder.commitmentId)) protectedExcluded += 1
      else visible.push(reminder)
    }
    const capped = visible.slice(0, MCP_OUTPUT_LIMITS.reminders)
    return {
      reminders: capped,
      clearance: clearanceLevel,
      protectedExcluded,
      total: visible.length,
      truncated: visible.length > capped.length,
    }
  }

  function evidenceData(id) {
    const ledgerApi = requireLedger('full')
    const storeApi = storeFor()
    const kind = id.startsWith('cm_') ? 'commitment' : id.startsWith('fact_') ? 'fact' : id.startsWith('pref_') ? 'preference' : null
    if (!kind) throw new ToolError('unknown evidence id prefix (want cm_/fact_/pref_)')
    const result =
      kind === 'commitment'
        ? evidenceForCommitment(storeApi, ledgerApi, id)
        : kind === 'fact'
          ? evidenceForFact(storeApi, ledgerApi, id)
          : evidenceForPreference(storeApi, ledgerApi, id)
    if (result?.[kind] && isHidden(kind, result[kind])) {
      // Excluded, never partially returned: no creditor/action/quote/missing
      // rows from a protected record may reach the client.
      return {
        schemaVersion: 2,
        clearance: clearanceLevel,
        protectedExcluded: 1,
        sources: [],
        missing: [],
        note: 'record belongs to a protected matter (secrecy above MCP clearance); content withheld',
      }
    }
    // Same cap contract as the list tools: after clearance, before the
    // classifier; totals describe the untruncated lists.
    const sources = Array.isArray(result.sources) ? result.sources : []
    const missing = Array.isArray(result.missing) ? result.missing : []
    return {
      ...result,
      sources: sources.slice(0, MCP_OUTPUT_LIMITS.evidenceItems),
      missing: missing.slice(0, MCP_OUTPUT_LIMITS.evidenceItems),
      clearance: clearanceLevel,
      protectedExcluded: 0,
      sourcesTotal: sources.length,
      missingTotal: missing.length,
      truncated: sources.length > MCP_OUTPUT_LIMITS.evidenceItems || missing.length > MCP_OUTPUT_LIMITS.evidenceItems,
    }
  }

  function evidenceIndex() {
    const ledgerApi = requireLedger('full')
    const storeApi = storeFor()
    const limit = 50
    const summarize = (kind, id, result) => ({
      kind,
      id,
      found: Boolean(result?.[kind]),
      sources: Array.isArray(result?.sources) ? result.sources.length : 0,
      missing: Array.isArray(result?.missing) ? result.missing.length : 0,
    })
    const commitments = splitByClearance('commitment', ledgerApi.listCommitments())
    const facts = splitByClearance(
      'fact',
      typeof ledgerApi.listFacts === 'function' ? ledgerApi.listFacts() : [],
    )
    const preferences = splitByClearance(
      'preference',
      typeof ledgerApi.listPreferences === 'function' ? ledgerApi.listPreferences({ includeCandidates: false }) : [],
    )
    return {
      limits: { perKind: limit },
      clearance: clearanceLevel,
      protectedExcluded: commitments.protectedExcluded + facts.protectedExcluded + preferences.protectedExcluded,
      commitments: commitments.visible
        .slice(0, limit)
        .map((c) => summarize('commitment', c.id, evidenceForCommitment(storeApi, ledgerApi, c.id))),
      facts: facts.visible
        .slice(0, limit)
        .map((f) => summarize('fact', f.id, evidenceForFact(storeApi, ledgerApi, f.id))),
      preferences: preferences.visible
        .slice(0, limit)
        .map((p) => summarize('preference', p.id, evidenceForPreference(storeApi, ledgerApi, p.id))),
    }
  }

  /* ----------------------------- customer reads ---------------------------- */

  /**
   * Customer entities are SQLite-only (schema v21). A JSON store (storeFor()
   * returns undefined), a legacy embedder store without the customer API or a
   * store opened before the customer tables existed is a structured ToolError,
   * never a crash and never fake empty data.
   */
  function requireCustomerStore() {
    const storeApi = storeFor()
    if (!storeApi || typeof storeApi.read !== 'function' || typeof storeApi.listClients !== 'function'
      || typeof storeApi.getClient !== 'function' || typeof storeApi.listMattersByClient !== 'function') {
      throw new ToolError('customer data requires the SQLite ledger (ADVISERS_STORE=sqlite)')
    }
    return storeApi
  }

  function clientsListData(all, requestedLimit) {
    const storeApi = requireCustomerStore()
    const limit = Number.isInteger(requestedLimit) ? requestedLimit : MCP_OUTPUT_LIMITS.clients
    const result = listClientRows(storeApi, { clearance: clearanceLevel, limit, includeArchived: all === true })
    return {
      clients: result.rows,
      total: result.total,
      truncated: result.total > result.rows.length,
      limit: result.limit,
      clearance: clearanceLevel,
      protectedExcluded: result.protectedExcluded,
    }
  }

  function clientsShowData(args) {
    const id = requireString(args, 'id', { min: 1, max: 120 })
    const timelineLimit = optionalLimit(args, 'timelineLimit', MCP_OUTPUT_LIMITS.clientTimelineMax)
    const view = readClientStatus(requireCustomerStore(), id, {
      clearance: clearanceLevel,
      timelineLimit: timelineLimit === undefined ? MCP_OUTPUT_LIMITS.clientTimeline : timelineLimit,
      openLimit: MCP_OUTPUT_LIMITS.clientOpen,
    })
    if (!view) throw new ToolError('unknown client id')
    return view
  }

  /* ------------------------------ write tools ------------------------------ */

  function captureCandidate(args) {
    assertAllowedKeys(args, ['action', 'quote', 'debtor', 'creditor', 'dueAt', 'matterId'])
    const action = requireString(args, 'action', { min: 1, max: 500 })
    const quote = requireString(args, 'quote', { min: 1, max: 2000 })
    // Reuse the capture gate (same surface/policy as lib/capture.js): a blocked
    // write never creates a candidate; PII is redacted from the payload only.
    // The quote stays verbatim (it is the stored evidence text).
    inspectCaptureText([action, quote].join('\n'), { surface: 'capture.input' })
    const debtor = optionalEnum(args, 'debtor', ['user', 'agent', 'third'], 'user')
    const creditor = optionalString(args, 'creditor', { max: 200 }) ?? 'someone'
    const dueAt = optionalIsoDate(args, 'dueAt')
    const mattersLedger = ledgerFor('matters')
    let matterId = optionalString(args, 'matterId', { max: 120 })
    if (matterId !== undefined) {
      if (typeof mattersLedger?.getMatter !== 'function' || !mattersLedger.getMatter(matterId)) throw invalidParams('unknown matter id')
    } else {
      matterId = typeof mattersLedger?.listMatters === 'function' ? mattersLedger.listMatters()[0]?.id : undefined
    }

    const payload = { debtor, creditor: redact(creditor).text, action: redact(action).text, capability: 'none' }
    if (matterId !== undefined) payload.matterId = matterId
    if (dueAt !== undefined) payload.dueAt = dueAt

    const storeApi = requireStore()
    let candidate
    try {
      candidate = storeApi.proposeCandidate({ kind: 'commitment', payload, evidence: [{ quote }] })
    } catch {
      throw new ToolError('candidate store rejected the write')
    }
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id) throw new ToolError('candidate store returned no record')
    return {
      ok: true,
      candidate: { id: candidate.id, kind: candidate.kind ?? 'commitment', status: candidate.status ?? 'pending' },
      note: 'Pending candidate only; it is not in the ledger. A human must run "advisers memory accept <id>".',
    }
  }

  function rollbackCandidate(id) {
    try {
      const storeApi = storeFor()
      if (storeApi && typeof storeApi.reviewCandidate === 'function') storeApi.reviewCandidate(id, 'rejected', 'audit_failed')
    } catch {
      // best effort compensation only
    }
  }

  async function verifyReceipt(args) {
    assertAllowedKeys(args, ['dir'])
    const dir = requireString(args, 'dir', { min: 1, max: 4096 })
    if (/[\u0000-\u001f\u007f]/.test(dir)) throw invalidParams('dir is invalid')
    const reader = typeof readPack === 'function' ? readPack : readReceiptDirectory
    let pack
    try {
      pack = await reader(dir)
    } catch (error) {
      if (error instanceof ToolError) throw error
      throw new ToolError('pack directory is unreadable')
    }
    if (!pack || typeof pack !== 'object' || Array.isArray(pack) || !pack.files || typeof pack.files !== 'object' || Array.isArray(pack.files)) {
      throw new ToolError('pack directory is unreadable')
    }
    const files = pack.files
    const names = Object.keys(files).filter(isSafePackName)
    const verification = verifyPack(files)
    return {
      ok: verification.ok,
      errors: verification.errors.slice(0, 50),
      files: names.slice(0, 32),
      fileCount: names.length,
      receiptPresent: pack.receiptPresent === true,
      extraFileCount: Number.isInteger(pack.extraFileCount) && pack.extraFileCount >= 0 ? pack.extraFileCount : 0,
      verifiedAt: new Date().toISOString(),
    }
  }

  /* -------------------------------- tools --------------------------------- */

  const CLEARANCE_NOTE =
    'Records belonging to protected matters (matter secrecy above this server clearance, default 0) are excluded and only counted in protectedExcluded.'
  const tools = [
    {
      name: 'advisers_today',
      description: 'Read the open-commitment count and the open commitments (read-only). Returns at most ' + MCP_OUTPUT_LIMITS.todayCommitments + ' commitment rows; `open`/`total` are the true post-clearance count and `truncated` says rows were withheld. ' + CLEARANCE_NOTE,
      inputSchema: { type: 'object', properties: {} },
      annotations: READ_ONLY_ANNOTATIONS,
      run: () => todayData(),
    },
    {
      name: 'advisers_commit_ls',
      description:
        'List commitments (open by default; pass all=true for every status). Returns {commitments, total, truncated, limit, clearance, protectedExcluded}; total is the post-clearance row count, so a truncated result is never mistaken for the whole ledger. Read-only. ' +
        CLEARANCE_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          all: { type: 'boolean', description: 'Include done/snoozed/dropped commitments.' },
          limit: { type: 'integer', minimum: 1, maximum: MCP_OUTPUT_LIMITS.commitRowsMax, description: 'Max rows to return (default ' + MCP_OUTPUT_LIMITS.commitRows + ', max ' + MCP_OUTPUT_LIMITS.commitRowsMax + ').' },
        },
      },
      annotations: READ_ONLY_ANNOTATIONS,
      run: (args) => commitListData(optionalBoolean(args, 'all'), optionalLimit(args, 'limit', MCP_OUTPUT_LIMITS.commitRowsMax)),
    },
    {
      name: 'advisers_who',
      description: 'Who owes whom: mine (user/agent) versus waiting (third parties). Read-only. Each array is capped at ' + MCP_OUTPUT_LIMITS.whoRows + ' rows; mineTotal/waitingTotal/truncated report the full counts. ' + CLEARANCE_NOTE,
      inputSchema: { type: 'object', properties: {} },
      annotations: READ_ONLY_ANNOTATIONS,
      run: () => whoData(),
    },
    {
      name: 'advisers_evidence',
      description:
        'Read the source turns for a commitment/fact/preference id. Read-only. ' +
        'Evidence of a protected record is withheld (no id content) and reported as protectedExcluded.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'cm_* commitment, fact_* fact, or pref_* preference id.' } },
        required: ['id'],
      },
      annotations: READ_ONLY_ANNOTATIONS,
      run: (args) => evidenceData(requireString(args, 'id', { min: 1, max: 128 })),
    },
    {
      name: 'advisers_remind',
      description:
        'Read due reminders (no delivery, no network). Returns {reminders, total, truncated, clearance, protectedExcluded}; total is the post-clearance reminder count. Read-only. ' +
        CLEARANCE_NOTE,
      inputSchema: { type: 'object', properties: {} },
      annotations: READ_ONLY_ANNOTATIONS,
      run: () => remindData(),
    },
    {
      name: 'advisers_clients',
      description:
        'Read-only customer projection: list active clients (all=true includes archived) or show one client by id. Rows carry exact counts, nextDueAt, clearance and protectedExcluded; show adds project summaries, open mine/waiting items and a derived delivery/commitment timeline. Note text and conversation bodies are never returned. At most ' +
        MCP_OUTPUT_LIMITS.clients + ' client rows are returned (limit 1..' + MCP_OUTPUT_LIMITS.clientsMax + '); timelineLimit (1..' + MCP_OUTPUT_LIMITS.clientTimelineMax + ') caps the show timeline. ' +
        CLEARANCE_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'show'], description: 'list: client rows; show: one client view.' },
          id: { type: 'string', description: 'Client id (cl_…). Required when action is show.' },
          all: { type: 'boolean', description: 'Include archived clients (action=list).' },
          limit: { type: 'integer', minimum: 1, maximum: MCP_OUTPUT_LIMITS.clientsMax, description: 'Max client rows for action=list (default ' + MCP_OUTPUT_LIMITS.clients + ', max ' + MCP_OUTPUT_LIMITS.clientsMax + ').' },
          timelineLimit: { type: 'integer', minimum: 1, maximum: MCP_OUTPUT_LIMITS.clientTimelineMax, description: 'Max timeline rows for action=show (default ' + MCP_OUTPUT_LIMITS.clientTimeline + ', max ' + MCP_OUTPUT_LIMITS.clientTimelineMax + ').' },
        },
        required: ['action'],
      },
      annotations: READ_ONLY_ANNOTATIONS,
      run: (args) => {
        const action = optionalEnum(args, 'action', ['list', 'show'], undefined)
        if (action === undefined) throw invalidParams('action must be one of list, show')
        if (action === 'list') {
          return clientsListData(optionalBoolean(args, 'all'), optionalLimit(args, 'limit', MCP_OUTPUT_LIMITS.clientsMax))
        }
        return clientsShowData(args)
      },
    },
    { ...CAPTURE_TOOL, run: (args) => captureCandidate(args) },
    { ...PACK_VERIFY_TOOL, run: (args) => verifyReceipt(args) },
  ].map((tool) => ({ ...tool, write: tool.write === true }))

  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))

  function toolsList() {
    return tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }))
  }

  /* ------------------------------- auditing ------------------------------- */

  function auditEntry(tool, outcome) {
    if (!outcome.ok && outcome.error && outcome.error.name === 'ContentSafetyError') {
      const action = tool.name === 'advisers_capture_candidate'
        ? 'mcp.capture.candidate'
        : tool.name === 'advisers_pack_verify'
          ? 'mcp.pack.verify'
          : 'mcp.call'
      return { actor: 'mcp', action, allowed: false, reason: outcome.error.auditReason || 'CONTENT_BLOCKED' }
    }
    if (tool.name === 'advisers_capture_candidate') {
      return {
        actor: 'mcp',
        action: 'mcp.capture.candidate',
        allowed: outcome.ok,
        reason: outcome.ok ? outcome.data.candidate.id : 'rejected',
      }
    }
    if (tool.name === 'advisers_pack_verify') {
      const data = outcome.ok ? outcome.data : undefined
      return {
        actor: 'mcp',
        action: 'mcp.pack.verify',
        allowed: Boolean(data?.ok),
        reason: data ? data.fileCount + ' files, ' + data.errors.length + ' errors' : 'error',
      }
    }
    const disclosure = outcome.ok ? outcome.data?.disclosure : undefined
    return {
      actor: 'mcp',
      action: 'mcp.call',
      allowed: outcome.ok,
      // 0.5.0: the single mcp.call row carries the disclosure ids/counts/digest
      // (metadata only; no record values). A failed read keeps the old reason.
      reason: disclosure && typeof disclosure === 'object' ? disclosureAuditReason(tool.name, disclosure) : tool.name,
    }
  }

  async function recordAudit(entry) {
    if (typeof audit !== 'function') return true
    try {
      await audit(entry)
      return true
    } catch {
      return false
    }
  }

  /* -------------------------- modern (2026-07-28) -------------------------- */

  /** Modern result envelope: resultType is mandatory; the payload is untouched. */
  function modernResult(result, cache) {
    const envelope = {
      resultType: 'complete',
      ...result,
      _meta: { [META_SERVER_INFO]: { name: SERVER_NAME, version: serverVersion } },
    }
    if (cache) {
      envelope.ttlMs = cache.ttlMs
      envelope.cacheScope = cache.cacheScope
    }
    return envelope
  }

  /** Modern JSON-RPC error response (errors never carry resultType). */
  function modernError(id, error) {
    const payload = { code: error.code, message: error.message }
    if (error.data !== undefined) payload.data = error.data
    return { jsonrpc: '2.0', id, error: payload }
  }

  /**
   * Wrap a legacy result response in the modern envelope. The payload object
   * itself is spread unchanged, so tools/call content[0].text and resources/read
   * contents[0].text stay byte-identical to the legacy response.
   */
  function modernWrappedResult(legacyResponse, cache) {
    const result = legacyResponse?.result
    if (!result || typeof result !== 'object' || Array.isArray(result)) return legacyResponse
    return { jsonrpc: '2.0', id: legacyResponse.id, result: modernResult(result, cache) }
  }

  /**
   * Validate the required per-request modern `_meta` fields. Missing or
   * ill-typed metadata is a malformed request (-32602); a well-formed but
   * unsupported version is -32022 with the supported list (client retries).
   */
  function modernMetaError(meta) {
    const requested = meta[META_PROTOCOL_VERSION]
    if (typeof requested !== 'string' || !requested.trim()) {
      return { code: -32602, message: 'invalid params: _meta field ' + META_PROTOCOL_VERSION + ' must be a string' }
    }
    const version = requested.trim()
    if (!SUPPORTED_MODERN_PROTOCOL_VERSIONS.includes(version)) {
      return { code: -32022, message: 'Unsupported protocol version', data: { supported: [...SUPPORTED_MODERN_PROTOCOL_VERSIONS], requested: version } }
    }
    const capabilities = meta[META_CLIENT_CAPABILITIES]
    if (capabilities === undefined || capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
      return { code: -32602, message: 'invalid params: _meta field ' + META_CLIENT_CAPABILITIES + ' must be an object' }
    }
    return null
  }

  /** This server returns a single static page; any client cursor is invalid. */
  function assertNoModernCursor(params) {
    if (Object.prototype.hasOwnProperty.call(params, 'cursor')) throw invalidParams('invalid cursor')
  }

  /**
   * Stateless modern dispatcher (strict allowlist). Methods that only exist in
   * the legacy lifecycle (initialize/ping/...) answer -32601 here instead of
   * leaking into the legacy dispatcher; notifications are never answered.
   */
  async function handleModernRequest(hasId, id, method, params, meta) {
    if (!hasId) return null
    const metaError = modernMetaError(meta)
    if (metaError) return modernError(id, metaError)
    if (method.startsWith('notifications/')) return null
    if (!MODERN_METHODS.includes(method)) return rpcError(id, -32601, 'unknown method')
    try {
      if (method === 'server/discover') {
        return reply(id, modernResult({
          supportedVersions: [...SUPPORTED_MODERN_PROTOCOL_VERSIONS],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        }, MODERN_CACHE_HINTS.discover))
      }
      if (method === 'tools/list') {
        assertNoModernCursor(params)
        return reply(id, modernResult({ tools: toolsList() }, MODERN_CACHE_HINTS.toolsList))
      }
      if (method === 'resources/list') {
        assertNoModernCursor(params)
        return reply(id, modernResult({ resources: RESOURCE_DEFINITIONS.map((entry) => ({ ...entry })) }, MODERN_CACHE_HINTS.resourcesList))
      }
      if (method === 'tools/call') {
        return modernWrappedResult(await handleToolsCall(id, params))
      }
      // resources/read: modern uses -32602 for an unknown resource (legacy keeps
      // -32002 for pre-0.4 clients); ledger reads are private and immediately stale.
      const legacyResponse = await handleResourcesRead(id, params)
      if (legacyResponse?.error) {
        return legacyResponse.error.code === -32002 ? rpcError(id, -32602, 'resource not found') : legacyResponse
      }
      return modernWrappedResult(legacyResponse, MODERN_CACHE_HINTS.resourcesRead)
    } catch (error) {
      if (error instanceof RpcError) return rpcError(id, error.code, error.message)
      return rpcError(id, -32603, 'internal error')
    }
  }

  /* ------------------------------ dispatcher ------------------------------ */

  function reply(id, result) {
    return { jsonrpc: '2.0', id, result }
  }

  function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } }
  }

  function toolResult(id, data) {
    return reply(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false })
  }

  function toolFailure(id, message) {
    return reply(id, { content: [{ type: 'text', text: message }], isError: true })
  }

  /**
   * Legacy `initialize` result. 0.3.0 P0-T3: echo the client's version when
   * this server implements that legacy revision (2024-11-05 / 2025-06-18 /
   * 2025-11-25); a missing or unknown version keeps the 2024-11-05 default so
   * pre-0.3 clients observe exactly the old behaviour. 2026-07-28 is never
   * negotiated here: the modern revision is stateless and advertises itself
   * through `server/discover`, so a modern client probes that method instead of
   * calling initialize (dual-era; see docs/MCP.md).
   */
  function initializeResult(requestedVersion) {
    const requested = typeof requestedVersion === 'string' ? requestedVersion.trim() : ''
    const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION
    negotiatedProtocolVersion = negotiated
    return {
      protocolVersion: negotiated,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: { name: SERVER_NAME, version: serverVersion },
    }
  }

  async function handleToolsCall(id, params) {
    const p = paramsObject(params)
    const name = p.name
    if (typeof name !== 'string' || !name.trim()) throw invalidParams('name must be a non-empty string')
    const args = p.arguments === undefined || p.arguments === null ? {} : p.arguments
    if (typeof args !== 'object' || Array.isArray(args)) throw invalidParams('arguments must be an object')
    const tool = toolsByName.get(name)
    if (!tool) throw invalidParams('unknown tool ' + sanitizeToken(name))

    // Gate 1: classify argument text before any tool logic runs.
    const argumentSafety = classify(safeJson(args), { surface: MCP_SURFACE })
    if (argumentSafety.action === 'block') {
      const error = safetyErrorFrom(argumentSafety, { surface: MCP_SURFACE })
      await recordAudit(auditEntry(tool, { ok: false, error }))
      return toolBlocked(id, error)
    }

    let outcome
    try {
      outcome = { ok: true, data: await tool.run(args) }
    } catch (error) {
      outcome = { ok: false, error }
    }
    // 0.3.0 P0-T3: cap the payload BEFORE the egress classifier scans it.
    if (outcome.ok) outcome.data = boundPayload(outcome.data)
    // 0.5.0 disclosure: additive view labels + disclosure block on the five
    // read tools only (after the cap, so the labels describe the returned rows).
    if (outcome.ok && DISCLOSURE_TOOL_SET.has(tool.name)) outcome.data = addToolDisclosure(tool.name, outcome.data)

    // Gate 2: a tool must not relay block-level text (ledger data, receipt
    // metadata, ...). The returned payload is classified before it is sent.
    let blockedData
    if (outcome.ok) {
      const outputSafety = classify(safeJson(outcome.data), { surface: MCP_SURFACE })
      if (outputSafety.action === 'block') {
        blockedData = outcome.data
        outcome = { ok: false, error: safetyErrorFrom(outputSafety, { surface: MCP_SURFACE }) }
      }
    }
    const audited = await recordAudit(auditEntry(tool, outcome))
    // Reads never fail on an audit-chain problem (0.4.x behaviour); the
    // disclosure says so honestly instead: audited=false + a fixed warning.
    if (outcome.ok && outcome.data?.disclosure) withAudited(outcome.data.disclosure, auditConfigured && audited, DISCLOSURE_WARNING)

    if (!outcome.ok) {
      if (outcome.error instanceof RpcError) {
        throw outcome.error
      }
      if (outcome.error?.name === 'ContentSafetyError') {
        // A write whose returned text was blocked is compensated (no orphan).
        if (tool.name === 'advisers_capture_candidate' && blockedData?.candidate?.id) rollbackCandidate(blockedData.candidate.id)
        return toolBlocked(id, outcome.error)
      }
      if (tool.write && !audited) return toolFailure(id, 'audit chain unavailable; call rejected')
      return toolFailure(id, outcome.error instanceof ToolError ? outcome.error.message : 'tool execution failed')
    }
    if (tool.write && !audited) {
      if (tool.name === 'advisers_capture_candidate' && outcome.data?.candidate?.id) rollbackCandidate(outcome.data.candidate.id)
      return toolFailure(id, 'audit chain unavailable; write rolled back')
    }
    return toolResult(id, outcome.data)
  }

  async function handleResourcesRead(id, params) {
    const p = paramsObject(params)
    const uri = p.uri
    if (typeof uri !== 'string' || !uri.trim()) throw invalidParams('uri must be a non-empty string')
    if (!RESOURCE_URIS.includes(uri)) return rpcError(id, -32002, 'resource not found')
    let data
    // 0.2.5 A-2: resources read the same clearance-filtered models as the tools.
    if (uri === 'advisers://today') data = todayData()
    else if (uri === 'advisers://commitments') data = commitListData(true)
    else if (uri === 'advisers://who') data = whoData()
    else if (uri === 'advisers://clients') data = clientsListData(false)
    else data = evidenceIndex()
    const bounded = boundPayload(data)
    // 0.5.0 disclosure: same additive view/disclosure block as the tools.
    const payload = addResourceDisclosure(uri, bounded)
    const disclosure = payload && typeof payload === 'object' ? payload.disclosure : undefined
    const audited = await recordAudit({
      actor: 'mcp',
      action: 'mcp.call',
      allowed: true,
      reason: disclosure ? disclosureAuditReason('resource:' + uri, disclosure) : 'resource:' + uri,
    })
    if (disclosure) withAudited(disclosure, auditConfigured && audited, DISCLOSURE_WARNING)
    return reply(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }] })
  }

  /**
   * Handle one decoded JSON-RPC message object.
   * @returns {Promise<object|null>} response object, or null for notifications.
   */
  async function handle(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return rpcError(null, -32600, 'invalid request')
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== undefined
    const id = hasId ? message.id : undefined
    if (hasId && id !== null && typeof id !== 'number' && typeof id !== 'string') {
      return rpcError(null, -32600, 'invalid request')
    }
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(hasId ? id : null, -32600, 'invalid request')
    }
    const method = message.method

    // 0.4.0 dual-era: a request carrying the modern per-request `_meta` is
    // served by the stateless modern path. `initialize` is never modern (the
    // handshake is the legacy discriminator), and when ADVISERS_MCP_MODERN=off
    // no request takes this branch, so the legacy dispatcher below is byte-for-
    // byte the pre-0.4 surface.
    if (modernEnabled && method !== 'initialize') {
      const modernMeta = modernRequestMeta(message.params)
      if (modernMeta) return handleModernRequest(hasId, id, method, message.params, modernMeta)
    }

    try {
      if (method === 'initialize') {
        const params = paramsObject(message.params)
        return hasId ? reply(id, initializeResult(params.protocolVersion)) : null
      }
      if (method === 'notifications/initialized') return hasId ? reply(id, {}) : null
      if (method === 'ping') return hasId ? reply(id, {}) : null
      if (method === 'tools/list') {
        paramsObject(message.params)
        return hasId ? reply(id, { tools: toolsList() }) : null
      }
      if (method === 'tools/call') {
        if (!hasId) return null
        return await handleToolsCall(id, message.params)
      }
      if (method === 'resources/list') {
        paramsObject(message.params)
        return hasId ? reply(id, { resources: RESOURCE_DEFINITIONS.map((entry) => ({ ...entry })) }) : null
      }
      if (method === 'resources/read') {
        if (!hasId) return null
        return await handleResourcesRead(id, message.params)
      }
      return hasId ? rpcError(id, -32601, 'unknown method') : null
    } catch (error) {
      if (!hasId) return null
      if (error instanceof RpcError) return rpcError(id, error.code, error.message)
      return rpcError(id, -32603, 'internal error')
    }
  }

  /**
   * Handle one raw stdio line. Enforces the 1 MiB line cap and never echoes
   * parse/validation failures back as raw text.
   * @returns {Promise<object|null>}
   */
  async function handleLine(line) {
    if (typeof line !== 'string') return rpcError(null, -32600, 'invalid request')
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      return rpcError(null, -32600, 'request exceeds the ' + MAX_LINE_BYTES + ' byte line limit')
    }
    const text = line.trim()
    if (!text) return null
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return rpcError(null, -32700, 'parse error')
    }
    return handle(message)
  }

  /**
   * Consume newline-delimited JSON-RPC requests from input and write responses
   * to output. Both are Node streams; output is never ended.
   */
  async function serve(input, output) {
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    let bufferBytes = 0
    let discarding = false

    const writeResponse = (response) => {
      try {
        output.write(JSON.stringify(response) + '\n')
      } catch {
        // A closed stdout means the client went away; keep draining input.
      }
    }
    const resetLine = () => {
      buffer = ''
      bufferBytes = 0
    }
    const oversized = () => {
      discarding = true
      resetLine()
      writeResponse(rpcError(null, -32600, 'request exceeds the ' + MAX_LINE_BYTES + ' byte line limit'))
    }
    const append = (piece) => {
      if (!piece || discarding) return
      bufferBytes += Buffer.byteLength(piece, 'utf8')
      if (bufferBytes > MAX_LINE_BYTES) {
        oversized()
        return
      }
      buffer += piece
    }
    const emitLine = async (line) => {
      try {
        const response = await handleLine(line)
        if (response) writeResponse(response)
      } catch {
        writeResponse(rpcError(null, -32603, 'internal error'))
      }
    }
    const completeLine = async () => {
      if (discarding) {
        discarding = false
        resetLine()
        return
      }
      const line = buffer
      resetLine()
      await emitLine(line)
    }

    for await (const chunk of input) {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      let start = 0
      let index
      while ((index = text.indexOf('\n', start)) !== -1) {
        append(text.slice(start, index))
        await completeLine()
        start = index + 1
      }
      append(text.slice(start))
    }
    append(decoder.end())
    if (!discarding && buffer.trim()) await emitLine(buffer)
    resetLine()
    discarding = false
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    handle,
    handleLine,
    serve,
    tools: toolsList,
    resources: () => RESOURCE_DEFINITIONS.map((entry) => ({ ...entry })),
  }
}
