/**
 * Context pack v1 (0.5.0 / WF3 050-C1, docs 122 section 3.3-3.4).
 *
 * A context pack is the offline-verifiable directory form of an explicitly
 * selected slice of the local ledger, handed to another AI/agent:
 *
 *   manifest.json  format 'advisers-context-pack', version 1, subject,
 *                  recipient/purpose/expiresAt disclosure record, a
 *                  disclosure block and every item payload with its sha256
 *   README.txt     human-readable boundary and verification steps
 *   SHA256SUMS     coreutils format, every other file in the directory
 *
 * Directory and file modes are 0700 / 0600. The builder refuses money keys,
 * mail/KB/attachment bodies, file paths and every field outside the frozen
 * per-kind payload whitelist, and enforces the v1 caps (16 items, 8 KiB per
 * item, 32 KiB for items, 64 KiB manifest, 256 KiB pack).
 *
 * verifyContextPackDir() is an independent OFFLINE verifier: it reads no
 * ledger, no HOME and no network; it treats the directory as untrusted input,
 * bounds every read (entries/depth/file/total/sums/manifest) and checks the
 * SHA256SUMS, the manifest schema, the payload whitelist, the disclosure
 * invariants and the per-item sha256. Like the client status pack it can only
 * prove internal consistency: anyone able to rewrite the whole pack can
 * recompute the sums, so no surface may call this a signature, a timestamp or
 * proof of authorship. verificationBasis is 'local-checksums-only'.
 *
 * There is deliberately NO import path: a context pack can never be re-ingested
 * into a ledger (assertContextPackNotImportable() is the explicit refusal for
 * the legacy import command). recipient/purpose/expiresAt are disclosure
 * records, not authentication, not DRM and not access control; the two
 * confers*Authority flags are always false and the verifier enforces that.
 *
 * Reuse boundary: the frozen receipt verifier (lib/receipt-verify.js) and the
 * frozen client pack verifier (lib/client-pack.js) are NOT modified. The small
 * SHA256SUMS/limit helpers are duplicated here on purpose: a third format must
 * not risk the two frozen verifiers.
 */

import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { collectContextCandidates, compareContextCandidateRecords, CONTEXT_CANDIDATE_LIMIT_DEFAULT, CONTEXT_CANDIDATE_LIMIT_MAX, CONTEXT_EXCLUSION_REASONS, loadContextCandidateForSelection, normalizeContextCandidateLimit, normalizeContextPackSubject } from './context-candidates.js'
import { evidenceDescriptor, evidenceKindOf } from './evidence.js'
import { entityError } from './sqlite.js'

/* -------------------------------------------------------------------------- */
/* constants                                                                  */
/* -------------------------------------------------------------------------- */

const LF = String.fromCharCode(10)
const BS = String.fromCharCode(92)
/** Manifest format string; evidence verify dispatches on this value. */
export const CONTEXT_PACK_FORMAT = 'advisers-context-pack'
/** Current (and only) manifest version. */
export const CONTEXT_PACK_MANIFEST_VERSION = 1
/** Offline verification basis: internal consistency + SHA-256 only. */
export const CONTEXT_PACK_VERIFICATION_BASIS = 'local-checksums-only'
/** Per-item verification basis: resolved against THIS local ledger at build. */
export const CONTEXT_PACK_ITEM_VERIFICATION_BASIS = 'local-resolution'
/** Checksums file name. */
export const CONTEXT_PACK_SHA256SUMS_FILE = 'SHA256SUMS'
/** Pack files are owner-read/write only. */
export const CONTEXT_PACK_FILE_MODE = 0o600
/** Pack directory is owner-only. */
export const CONTEXT_PACK_DIR_MODE = 0o700
/** The three files every context pack carries (SHA256SUMS covers the rest). */
export const CONTEXT_PACK_REQUIRED_FILES = Object.freeze(['manifest.json', 'README.txt'])
/** Stable error code for a pack that exceeds a resource cap. */
export const CONTEXT_PACK_LIMIT_CODE = 'E_CONTEXT_PACK_LIMIT'
/** Stable error code for a structurally invalid pack/manifest/item. */
export const CONTEXT_PACK_INVALID_CODE = 'E_CONTEXT_PACK_INVALID'
/** Stable error code for an import attempt of a context pack (no re-ingest). */
export const CONTEXT_PACK_IMPORT_UNSUPPORTED_CODE = 'E_CONTEXT_PACK_IMPORT_UNSUPPORTED'
/** Stable error code for an --expect-manifest-sha256 mismatch. */
export const CONTEXT_PACK_DIGEST_MISMATCH_CODE = 'E_CONTEXT_PACK_DIGEST_MISMATCH'
/**
 * Audit action of one successful context-pack disclosure (0.5.1 M8 P0-B): the
 * minimal "I disclosed what to whom" receipt. Ids and hashes only - never the
 * subject name, recipient name or recipient email.
 */
export const CONTEXT_PACK_AUDIT_ACTION = 'context_pack.create'
/** Item kind order used by manifest rendering (fixed for reproducibility). */
export const CONTEXT_PACK_ITEM_KINDS = Object.freeze(['commitment', 'fact', 'preference', 'delivery'])
/** Closed purpose vocabulary: a disclosure label, never an authorization. */
export const CONTEXT_PACK_PURPOSES = Object.freeze(['client-delivery', 'external-review', 'handoff'])
/** Item view labels a v1 pack may carry. */
export const CONTEXT_PACK_ITEM_VIEWS = Object.freeze(['verified', 'pending', 'historical'])
/**
 * Hard v1 caps. A received pack is untrusted: the builder and the verifier
 * enforce the same numbers; the extra walk caps bound a hostile directory
 * before any hashing happens.
 */
export const CONTEXT_PACK_LIMIT_DEFAULTS = Object.freeze({
  maxItems: 16,
  maxItemBytes: 8 * 1024,
  maxItemsBytes: 32 * 1024,
  maxManifestBytes: 64 * 1024,
  maxPackBytes: 256 * 1024,
  maxSumsBytes: 64 * 1024,
  maxEntries: 16,
  maxDepth: 1,
})
const LIMIT_LABELS = Object.freeze({
  maxItems: 'item count',
  maxItemBytes: 'single item size',
  maxItemsBytes: 'items size',
  maxManifestBytes: 'manifest size',
  maxPackBytes: 'total pack size',
  maxSumsBytes: 'SHA256SUMS size',
  maxEntries: 'entry count',
  maxDepth: 'directory depth',
})
/**
 * Per-kind payload whitelist (docs 122 section 3.3). A key outside the list is
 * an error, not a warning: the pack must not grow new fields silently.
 */
export const CONTEXT_PACK_PAYLOAD_FIELDS = Object.freeze({
  commitment: Object.freeze(['action', 'debtor', 'creditor', 'dueAt', 'status', 'matterId', 'evidence']),
  fact: Object.freeze(['subject', 'predicate', 'object', 'validFrom', 'validTo', 'recordedAt', 'matterId', 'quote', 'quoteSha256']),
  preference: Object.freeze(['kind', 'statement', 'scope', 'priority', 'validFrom', 'expiresAt', 'quote', 'quoteSha256']),
  delivery: Object.freeze(['title', 'tool', 'templateName', 'createdAt', 'matterId']),
})
/** Required payload fields per kind (everything else is optional). */
const PAYLOAD_REQUIRED = Object.freeze({
  commitment: Object.freeze(['action']),
  fact: Object.freeze(['subject', 'predicate', 'object']),
  preference: Object.freeze(['kind', 'statement']),
  delivery: Object.freeze(['title', 'createdAt']),
})
/** Evidence pointer keys a packed commitment.evidence[] entry may carry. */
const EVIDENCE_POINTER_FIELDS = Object.freeze(['type', 'ref', 'sessionId', 'turnId', 'messageId', 'docId', 'pageId', 'chunkIndex', 'url', 'tool', 'toolName', 'retained', 'kind'])
const EVIDENCE_KIND_VALUES = Object.freeze(['observed', 'derived', 'inferred', 'manual'])
/**
 * Keys a context pack v1 must never contain (money/body/file shapes). The list
 * extends client-pack's money guard with body/attachment/path names; the check
 * is case-insensitive and depth-capped, so an accidental camelCase variant or a
 * nested object cannot smuggle an amount, a mail body or a file path into the
 * manifest.
 */
const FORBIDDEN_KEY_PATTERNS = Object.freeze([
  'amount', 'amountminor', 'paid', 'paidminor', 'outstanding', 'outstandingminor',
  'currency', 'receivables', 'payments', 'body', 'bodytext', 'html', 'attachments',
  'raw', 'headers', 'filebytes', 'filepath', 'files', 'file', 'path', 'paths',
  'attachments', 'quotehtml', 'rawbody', 'emailbody', 'contentbytes',
])
/** Disclosure block keys; unknown keys are warnings (additive forward compat). */
const DISCLOSURE_KEYS = Object.freeze(['autoAssembled', 'candidateCount', 'selectedCount', 'itemCount', 'fields', 'includesQuotes', 'includesOriginalSources', 'confersReadAuthority', 'confersExecutionAuthority', 'excluded'])
/** Manifest top-level keys; unknown keys are warnings (forward compatibility). */
const MANIFEST_KEYS = Object.freeze(['format', 'version', 'generatedAt', 'generator', 'subject', 'recipient', 'purpose', 'expiresAt', 'verificationBasis', 'disclosure', 'items', 'fileCount'])
const ITEM_KEYS = Object.freeze(['id', 'kind', 'view', 'fields', 'verification', 'payload', 'sha256'])
const EXCLUDED_BY_REASON = Object.freeze([...CONTEXT_EXCLUSION_REASONS])
const DAY_MS = 86400_000

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

function invalid(message, hint) {
  return entityError(CONTEXT_PACK_INVALID_CODE, message, hint)
}

function limitError(violation) {
  const label = LIMIT_LABELS[violation.limit] ?? violation.limit
  return entityError(CONTEXT_PACK_LIMIT_CODE, 'context pack ' + label + ' exceeded the limit ' + violation.max + ' (actual ' + violation.actual + '); refusing to build or read a pack outside the v1 caps.')
}

function makeViolation(limits, limit, actual) {
  return { code: CONTEXT_PACK_LIMIT_CODE, limit, max: limits[limit], actual }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function addError(errors, message) {
  if (errors.length < 300) errors.push(message)
  else if (errors.length === 300) errors.push('... too many errors; further details suppressed')
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

function toBuffer(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw invalid('context pack file content must be a string, Buffer or Uint8Array')
}

/** Deterministic JSON text (object keys sorted, two-space indent, trailing LF). */
function stableStringify(value) {
  return JSON.stringify(canonicalize(value), null, 2) + LF
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isPlainObject(value)) {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key])
    return out
  }
  return value
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** One-way recipient fingerprint used by the audit row (never the raw name/email). */
export function contextPackRecipientHash(recipient) {
  const name = typeof recipient?.name === 'string' ? recipient.name : ''
  const email = typeof recipient?.email === 'string' ? recipient.email : null
  return sha256Hex(JSON.stringify({ email, name }))
}

/**
 * Audit row for one written context pack (append it through store.appendAudit).
 * Reason format (single line, ids/hashes only):
 *   subject=<kind>:<id> purpose=<purpose> items=<n> manifestDigest=<64hex> recipientHash=<64hex>
 */
export function contextPackAuditRow({ subject, purpose, itemCount, manifestDigest, recipient }) {
  const recipientHash = contextPackRecipientHash(recipient)
  const reason = 'subject=' + String(subject?.kind ?? '') + ':' + String(subject?.id ?? '')
    + ' purpose=' + String(purpose ?? '')
    + ' items=' + String(itemCount ?? 0)
    + ' manifestDigest=' + String(manifestDigest ?? '')
    + ' recipientHash=' + recipientHash
  return { actor: 'local', action: CONTEXT_PACK_AUDIT_ACTION, allowed: true, reason: reason.slice(0, 300), recipientHash }
}

function isHexLower(value) {
  if (typeof value !== 'string' || value.length !== 64) return false
  for (let i = 0; i < 64; i += 1) {
    const code = value.charCodeAt(i)
    if ((code >= 48 && code <= 57) || (code >= 97 && code <= 102)) continue
    return false
  }
  return true
}

/** Absolute/backslash/traversal path guard; only forward-slash relative paths. */
export function isUnsafeContextPackPath(name) {
  if (typeof name !== 'string' || !name) return true
  if (name.startsWith('/') || name.startsWith(BS)) return true
  if (name.includes(BS)) return true
  const parts = name.split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return true
  }
  if (parts.length > 1) return true
  const first = parts[0]
  if (first.length === 2 && first.charCodeAt(1) === 58) return true
  return false
}

function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isDateText(value) {
  if (typeof value !== 'string' || !value) return false
  return Number.isFinite(Date.parse(value))
}

function normalizeLimits(input) {
  const limits = { ...CONTEXT_PACK_LIMIT_DEFAULTS }
  if (!isPlainObject(input)) return limits
  for (const key of Object.keys(CONTEXT_PACK_LIMIT_DEFAULTS)) {
    if (!(key in input)) continue
    const value = Number(input[key])
    if (Number.isFinite(value) && value > 0) limits[key] = Math.floor(value)
  }
  return limits
}

function advisersVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null
  } catch {
    return null
  }
}

function generatorOf(env) {
  return {
    advisersVersion: typeof env?.advisersVersion === 'string' && env.advisersVersion ? env.advisersVersion : advisersVersion(),
    nodeVersion: typeof env?.nodeVersion === 'string' && env.nodeVersion ? env.nodeVersion : process.version,
    platform: typeof env?.platform === 'string' && env.platform ? env.platform : process.platform,
    command: typeof env?.command === 'string' && env.command ? env.command : 'context-pack create',
  }
}

function normalizeGeneratedAt(value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString()
  const text = value instanceof Date ? value.toISOString() : String(value)
  if (!isDateText(text)) throw invalid('generatedAt must be an ISO date-time')
  return new Date(Date.parse(text)).toISOString()
}

function normalizeSubject(raw) {
  if (!isPlainObject(raw)) throw invalid('a context pack requires a subject {kind,id,name}')
  const subject = normalizeContextPackSubject(raw)
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) throw invalid('context pack subject name is required', 'the candidate assembler supplies the client/matter display name')
  if (Array.from(name).length > 200) throw invalid('context pack subject name is too long')
  return { kind: subject.kind, id: subject.id, name }
}

function normalizeRecipient(raw) {
  if (typeof raw === 'string') {
    const name = raw.trim()
    if (!name) throw invalid('recipient name is required')
    if (Array.from(name).length > 200) throw invalid('recipient name is too long')
    return { name }
  }
  if (!isPlainObject(raw)) throw invalid('a context pack requires recipient {name,email?}', 'pass --recipient <name>; recipient/purpose/expiry are disclosure records, not authentication')
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) throw invalid('recipient name is required')
  if (Array.from(name).length > 200) throw invalid('recipient name is too long')
  const recipient = { name }
  if (raw.email !== undefined && raw.email !== null && raw.email !== '') {
    if (typeof raw.email !== 'string') throw invalid('recipient email must be a string')
    const email = raw.email.trim()
    if (!email || Array.from(email).length > 200) throw invalid('recipient email must be a non-empty string of at most 200 characters')
    recipient.email = email
  }
  return recipient
}

function normalizePurpose(value) {
  const purpose = typeof value === 'string' ? value.trim() : ''
  if (!purpose) throw invalid('context pack purpose is required', 'use one of ' + CONTEXT_PACK_PURPOSES.join(', '))
  if (!CONTEXT_PACK_PURPOSES.includes(purpose)) throw invalid('unknown context pack purpose: ' + purpose, 'use one of ' + CONTEXT_PACK_PURPOSES.join(', '))
  return purpose
}

/** Default expiry is generatedAt + 24h; --expires accepts 24h/7d or an ISO. */
export function resolveContextPackExpiresAt(value, now = Date.now()) {
  const nowMs = Number(now)
  const base = Number.isFinite(nowMs) ? nowMs : Date.now()
  if (value === undefined || value === null || value === '') return new Date(base + DAY_MS).toISOString()
  const text = String(value).trim()
  const match = /^(\d+)(m|h|d)$/i.exec(text)
  if (match) {
    const amount = Number(match[1])
    const unit = match[2].toLowerCase()
    const unitMs = unit === 'd' ? DAY_MS : unit === 'h' ? 3600_000 : 60_000
    if (!Number.isFinite(amount) || amount < 1) throw invalid('expires must be a positive duration like 24h', 'examples: --expires 24h, --expires 7d, --expires 2026-12-01T00:00:00Z')
    return new Date(base + amount * unitMs).toISOString()
  }
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) throw invalid('expires must be a duration like 24h or an ISO date-time')
  if (ms <= base) throw invalid('expiresAt must be in the future')
  return new Date(ms).toISOString()
}

function normalizeNow(value) {
  if (value === undefined || value === null) return Date.now()
  if (value instanceof Date) return value.getTime()
  const number = Number(value)
  if (Number.isFinite(number)) return number
  const ms = Date.parse(String(value))
  if (!Number.isFinite(ms)) throw invalid('now must be epoch milliseconds or an ISO date-time')
  return ms
}

/**
 * Suggested default output directory (pure path helper; bin owns HOME).
 * $ADVISERS_HOME/exports/context-<subject-id>-<timestamp>/
 */
export function suggestContextPackOutDir(homeDir, subject, generatedAt = new Date().toISOString()) {
  if (typeof homeDir !== 'string' || !homeDir.trim()) throw invalid('homeDir is required to suggest an output directory')
  const normalized = normalizeContextPackSubject(subject)
  const stamp = String(generatedAt).replace(/[:.]/g, '-')
  return join(homeDir, 'exports', 'context-' + normalized.kind + '-' + normalized.id + '-' + stamp)
}

/* -------------------------------------------------------------------------- */
/* validation (shared by builder and verifier)                                */
/* -------------------------------------------------------------------------- */

function forbiddenKeyPath(value, path = '', depth = 0) {
  if (depth > 8) return null
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = forbiddenKeyPath(value[index], path + '[' + index + ']', depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (!isPlainObject(value)) return null
  for (const key of Object.keys(value)) {
    const lower = key.toLowerCase()
    if (FORBIDDEN_KEY_PATTERNS.includes(lower)) return path ? path + '.' + key : key
    const hit = forbiddenKeyPath(value[key], path ? path + '.' + key : key, depth + 1)
    if (hit) return hit
  }
  return null
}

function validateEvidencePointers(list, where, errors) {
  if (!Array.isArray(list)) { addError(errors, where + ' must be an array'); return }
  if (list.length > 50) addError(errors, where + ' has more than 50 pointers')
  list.forEach((entry, index) => {
    const at = where + '[' + index + ']'
    if (!isPlainObject(entry)) { addError(errors, at + ' must be an object'); return }
    for (const key of Object.keys(entry)) {
      if (!EVIDENCE_POINTER_FIELDS.includes(key)) { addError(errors, at + ' has an unknown pointer field: ' + key); continue }
      const value = entry[key]
      if (key === 'chunkIndex') { if (!isNonNegativeInteger(value)) addError(errors, at + '.chunkIndex must be a non-negative integer') }
      else if (key === 'retained') { if (typeof value !== 'boolean') addError(errors, at + '.retained must be a boolean') }
      else if (key === 'kind') { if (!EVIDENCE_KIND_VALUES.includes(value)) addError(errors, at + '.kind must be one of ' + EVIDENCE_KIND_VALUES.join(', ')) }
      else if (typeof value !== 'string' || !value || Array.from(value).length > 2000) addError(errors, at + '.' + key + ' must be a non-empty string of at most 2000 characters')
    }
  })
}

function validateQuote(payload, kind, errors) {
  const hasQuote = Object.hasOwn(payload, 'quote')
  const hasSha = Object.hasOwn(payload, 'quoteSha256')
  if (!hasQuote && !hasSha) return
  if (!hasQuote || !hasSha) { addError(errors, kind + ' payload must carry quote and quoteSha256 together'); return }
  const quote = payload.quote
  if (typeof quote !== 'string' || !quote) { addError(errors, kind + ' payload quote must be a non-empty string'); return }
  if (Array.from(quote).length > 500) addError(errors, kind + ' payload quote is longer than 500 characters')
  if (!isHexLower(payload.quoteSha256)) addError(errors, kind + ' payload quoteSha256 must be 64 lowercase hex characters')
  else if (sha256Hex(quote) !== payload.quoteSha256) addError(errors, kind + ' payload quoteSha256 does not match the quote')
}

function validatePreferenceScope(scope, errors) {
  if (!isPlainObject(scope)) { addError(errors, 'preference payload scope must be an object'); return }
  for (const key of Object.keys(scope)) {
    if (key !== 'level' && key !== 'value') addError(errors, 'preference payload scope has an unknown field: ' + key)
  }
  if (!['global', 'project', 'matter', 'audience'].includes(scope.level)) addError(errors, 'preference payload scope.level must be global|project|matter|audience')
  if (scope.value !== undefined && (typeof scope.value !== 'string' || !scope.value || Array.from(scope.value).length > 200)) addError(errors, 'preference payload scope.value must be a short string')
}

function validatePayload(kind, payload, where = 'payload') {
  const errors = []
  if (!isPlainObject(payload)) { addError(errors, where + ' must be an object'); return errors }
  const allowed = CONTEXT_PACK_PAYLOAD_FIELDS[kind]
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) addError(errors, where + ' has a field outside the ' + kind + ' whitelist: ' + key)
  for (const key of PAYLOAD_REQUIRED[kind]) {
    const value = payload[key]
    if (typeof value !== 'string' || !value.trim()) addError(errors, where + '.' + key + ' is required and must be a non-empty string')
  }
  if (Object.hasOwn(payload, 'evidence')) validateEvidencePointers(payload.evidence, where + '.evidence', errors)
  if (kind === 'fact' || kind === 'preference') validateQuote(payload, kind, errors)
  if (kind === 'preference' && Object.hasOwn(payload, 'scope')) validatePreferenceScope(payload.scope, errors)
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value) || isPlainObject(value)) continue
    if (typeof value === 'boolean' || typeof value === 'number') { addError(errors, where + '.' + key + ' must be a string (v1 payloads are text only)'); continue }
    if (typeof value !== 'string' && value !== undefined) addError(errors, where + '.' + key + ' has an unsupported type')
  }
  const forbidden = forbiddenKeyPath(payload)
  if (forbidden) addError(errors, where + ' contains a forbidden key (money/body/file shape): ' + forbidden)
  return errors
}

function normalizeVerification(raw) {
  if (!isPlainObject(raw)) throw invalid('item verification must be an object')
  if (raw.basis !== CONTEXT_PACK_ITEM_VERIFICATION_BASIS) throw invalid('item verification.basis must be "' + CONTEXT_PACK_ITEM_VERIFICATION_BASIS + '"')
  const verification = { basis: CONTEXT_PACK_ITEM_VERIFICATION_BASIS }
  for (const key of ['resolved', 'missing', 'unverifiable', 'notChecked']) {
    const value = raw[key]
    if (!isNonNegativeInteger(value)) throw invalid('item verification.' + key + ' must be a non-negative integer')
    verification[key] = value
  }
  return verification
}

function itemSha256(payload) {
  return sha256Hex(stableStringify(payload))
}

function validateItemShape(item, index, errors) {
  const where = 'items[' + index + ']'
  if (!isPlainObject(item)) { addError(errors, where + ' must be an object'); return false }
  let valid = true
  for (const key of Object.keys(item)) if (!ITEM_KEYS.includes(key)) { addError(errors, where + ' has an unknown item key: ' + key); valid = false }
  if (typeof item.id !== 'string' || !item.id.trim() || Array.from(item.id).length > 200) { addError(errors, where + '.id must be a non-empty string of at most 200 characters'); valid = false }
  if (!CONTEXT_PACK_ITEM_KINDS.includes(item.kind)) { addError(errors, where + '.kind must be one of ' + CONTEXT_PACK_ITEM_KINDS.join(', ')); return false }
  if (!CONTEXT_PACK_ITEM_VIEWS.includes(item.view)) { addError(errors, where + '.view must be one of ' + CONTEXT_PACK_ITEM_VIEWS.join(', ')); valid = false }
  if (!Array.isArray(item.fields) || !item.fields.every((field) => typeof field === 'string') || new Set(item.fields).size !== item.fields.length) {
    addError(errors, where + '.fields must be a unique string array'); valid = false
  }
  if (!isPlainObject(item.verification)) { addError(errors, where + '.verification must be an object'); valid = false }
  else {
    if (item.verification.basis !== CONTEXT_PACK_ITEM_VERIFICATION_BASIS) addError(errors, where + '.verification.basis must be "' + CONTEXT_PACK_ITEM_VERIFICATION_BASIS + '"')
    for (const key of ['resolved', 'missing', 'unverifiable', 'notChecked']) {
      if (!isNonNegativeInteger(item.verification[key])) addError(errors, where + '.verification.' + key + ' must be a non-negative integer')
    }
    for (const key of Object.keys(item.verification)) {
      if (!['basis', 'resolved', 'missing', 'unverifiable', 'notChecked'].includes(key)) addError(errors, where + '.verification has an unknown field: ' + key)
    }
  }
  const payloadErrors = validatePayload(item.kind, item.payload, where + '.payload')
  for (const error of payloadErrors) { addError(errors, error); valid = false }
  if (isPlainObject(item.payload)) {
    const expectedFields = Object.keys(item.payload).sort()
    if (Array.isArray(item.fields) && JSON.stringify(item.fields) !== JSON.stringify(expectedFields)) {
      addError(errors, where + '.fields must be exactly the sorted payload field names')
      valid = false
    }
    if (!isHexLower(item.sha256)) addError(errors, where + '.sha256 must be 64 lowercase hex characters')
    else if (item.sha256 !== itemSha256(item.payload)) addError(errors, where + '.sha256 does not match the canonical payload bytes')
  }
  return valid
}

function normalizeItemInput(input) {
  if (!isPlainObject(input)) throw invalid('a context pack item must be an object')
  const errors = []
  const normalized = {
    id: input.id,
    kind: input.kind,
    view: input.view,
    verification: input.verification,
    payload: input.payload,
    fields: isPlainObject(input.payload) ? Object.keys(input.payload).sort() : [],
    sha256: isPlainObject(input.payload) ? itemSha256(input.payload) : '',
  }
  validateItemShape(normalized, 0, errors)
  if (errors.length) throw invalid(errors[0])
  return normalized
}

/* -------------------------------------------------------------------------- */
/* README                                                                     */
/* -------------------------------------------------------------------------- */

function renderReadme({ subject, recipient, purpose, expiresAt, generatedAt, itemCount, format, version }) {
  return [
    'Advisers context pack',
    '======================',
    '',
    'Subject: ' + subject.name + ' (' + subject.kind + ':' + subject.id + ')',
    'Recipient: ' + recipient.name + (recipient.email ? ' <' + recipient.email + '>' : ''),
    'Purpose: ' + purpose,
    'Generated at: ' + generatedAt,
    'Expires at: ' + expiresAt,
    'Format: ' + format + ' v' + version,
    'Verification basis: ' + CONTEXT_PACK_VERIFICATION_BASIS,
    'Items: ' + itemCount,
    '',
    'Contents',
    '--------',
    'manifest.json   subject, recipient, purpose, disclosure block and every item payload',
    'README.txt      this file',
    'SHA256SUMS      sha256 of every other file in this directory (coreutils format)',
    '',
    'Boundary',
    '--------',
    '- This pack contains only the items the operator selected from the local ledger.',
    '  It does not contain money/amount fields, mail bodies, attachments, KB full text,',
    '  delivery file bytes or file paths; those stay local in every format version.',
    '- recipient/purpose/expiresAt are DISCLOSURE RECORDS. They are not authentication,',
    '  not DRM, not access control and not a signature; once the recipient receives the',
    '  pack it can be copied and forwarded.',
    '- The flags confersReadAuthority and confersExecutionAuthority are always false:',
    '  this pack grants no read permission over the local ledger and no ability to act.',
    '- There is NO import path. A context pack is one-way disclosure data and cannot be',
    '  re-ingested into a ledger (the import command refuses this format explicitly).',
    '- Quote text is excluded by default; when included it is bounded to 500 characters',
    '  per item and covered by quoteSha256. item.view=verified only means the evidence',
    '  pointer resolved against the LOCAL ledger at build time; it is not a truth claim.',
    '',
    'Verify (offline; no ~/.advisers database and no network needed)',
    '---------------------------------------------------------------',
    '1. advisers context-pack verify <this-directory>',
    '2. or with coreutils: cd <this-directory> && sha256sum -c SHA256SUMS',
    '',
    'The checksums detect edits made after generation. They are not a signature, not a',
    'trusted timestamp and not notarization: anyone able to rewrite the whole pack can',
    'recompute them. Offline verification proves the pack is internally consistent; it',
    'does not prove who generated it or when.',
    '',
    'Privacy',
    '-------',
    '- Built locally; verification opens no ledger and makes no network call.',
    '- The pack is a bounded disclosure slice, not a ledger dump.',
    '- Deleting this pack does not modify the local ledger or database.',
    '',
  ].join(LF)
}

function buildSums(fileContents) {
  const names = [...fileContents.keys()].filter((name) => name !== CONTEXT_PACK_SHA256SUMS_FILE).sort()
  const lines = []
  for (const name of names) {
    if (isUnsafeContextPackPath(name)) throw invalid('unsafe pack path: ' + name)
    const bytes = toBuffer(fileContents.get(name))
    lines.push(sha256Hex(bytes) + '  ' + name)
  }
  return lines.length ? lines.join(LF) + LF : ''
}

/* -------------------------------------------------------------------------- */
/* builder                                                                    */
/* -------------------------------------------------------------------------- */

function normalizeExcluded(raw) {
  const byReason = {}
  for (const key of CONTEXT_EXCLUSION_REASONS) byReason[key] = 0
  if (raw === undefined || raw === null) return { total: 0, byReason }
  if (!isPlainObject(raw)) throw invalid('disclosure.excluded must be an object')
  const source = isPlainObject(raw.byReason) ? raw.byReason : raw
  for (const key of Object.keys(source)) {
    if (CONTEXT_EXCLUSION_REASONS.includes(key)) continue
    if (key === 'total') continue
    throw invalid('disclosure.excluded.byReason has an unknown reason: ' + key, 'v1 reasons are ' + CONTEXT_EXCLUSION_REASONS.join(', '))
  }
  let sum = 0
  for (const key of CONTEXT_EXCLUSION_REASONS) {
    const value = source[key] === undefined ? 0 : source[key]
    if (!isNonNegativeInteger(value)) throw invalid('disclosure.excluded.byReason.' + key + ' must be a non-negative integer')
    byReason[key] = value
    sum += value
  }
  const total = raw.total === undefined ? sum : raw.total
  if (!isNonNegativeInteger(total) || total !== sum) throw invalid('disclosure.excluded.total must equal the sum of byReason')
  return { total, byReason }
}

function normalizeExpiresAt(value, generatedAt) {
  if (value === undefined || value === null || value === '') return resolveContextPackExpiresAt(undefined, Date.parse(generatedAt))
  const text = value instanceof Date ? value.toISOString() : String(value)
  if (!isDateText(text)) throw invalid('context pack expiresAt must be an ISO date-time')
  return new Date(Date.parse(text)).toISOString()
}

/**
 * Build the pack file map in memory (no disk writes, no ledger access).
 *
 * @param {object} options subject/items/recipient/purpose/expiresAt plus the
 *        disclosure inputs (autoAssembled, candidateCount, excluded) and an
 *        optional deterministic generatedAt/env/limits.
 * @returns {{files: Map<string, Buffer>, manifest: object, manifestText: string,
 *            manifestDigest: string, summary: object}}
 */
export function buildContextPack(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('buildContextPack expects an options object')
  const limits = normalizeLimits(options.limits)
  const generatedAt = normalizeGeneratedAt(options.generatedAt)
  const subject = normalizeSubject(options.subject)
  const recipient = normalizeRecipient(options.recipient)
  const purpose = normalizePurpose(options.purpose)
  const expiresAt = normalizeExpiresAt(options.expiresAt, generatedAt)
  const rawItems = options.items
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw invalid('a context pack requires at least one item')
  if (rawItems.length > limits.maxItems) throw limitError(makeViolation(limits, 'maxItems', rawItems.length))
  const items = rawItems.map((item) => normalizeItemInput(item))
  for (const item of items) {
    const size = byteLength(stableStringify(item))
    if (size > limits.maxItemBytes) throw limitError(makeViolation(limits, 'maxItemBytes', size))
  }
  const itemsBytes = byteLength(stableStringify(items))
  if (itemsBytes > limits.maxItemsBytes) throw limitError(makeViolation(limits, 'maxItemsBytes', itemsBytes))
  const candidateCount = options.candidateCount === undefined ? items.length : options.candidateCount
  if (!isNonNegativeInteger(candidateCount) || candidateCount < items.length) throw invalid('disclosure.candidateCount must be an integer at least the item count')
  const disclosure = {
    autoAssembled: options.autoAssembled === true,
    candidateCount,
    selectedCount: items.length,
    itemCount: items.length,
    fields: [...new Set(items.flatMap((item) => item.fields))].sort(),
    includesQuotes: items.some((item) => Object.hasOwn(item.payload, 'quote')),
    includesOriginalSources: false,
    confersReadAuthority: false,
    confersExecutionAuthority: false,
    excluded: normalizeExcluded(options.excluded),
  }
  const manifest = {
    format: CONTEXT_PACK_FORMAT,
    version: CONTEXT_PACK_MANIFEST_VERSION,
    generatedAt,
    generator: generatorOf(options.env),
    subject,
    recipient,
    purpose,
    expiresAt,
    verificationBasis: CONTEXT_PACK_VERIFICATION_BASIS,
    disclosure,
    items,
    fileCount: 3,
  }
  const manifestText = stableStringify(manifest)
  const manifestBytes = byteLength(manifestText)
  if (manifestBytes > limits.maxManifestBytes) throw limitError(makeViolation(limits, 'maxManifestBytes', manifestBytes))
  const readmeText = renderReadme({
    subject,
    recipient,
    purpose,
    expiresAt,
    generatedAt,
    itemCount: items.length,
    format: CONTEXT_PACK_FORMAT,
    version: CONTEXT_PACK_MANIFEST_VERSION,
  })
  const fileContents = new Map()
  fileContents.set('README.txt', Buffer.from(readmeText, 'utf8'))
  fileContents.set('manifest.json', Buffer.from(manifestText, 'utf8'))
  fileContents.set(CONTEXT_PACK_SHA256SUMS_FILE, Buffer.from(buildSums(fileContents), 'utf8'))
  let totalBytes = 0
  for (const content of fileContents.values()) totalBytes += content.length
  if (totalBytes > limits.maxPackBytes) throw limitError(makeViolation(limits, 'maxPackBytes', totalBytes))
  const manifestDigest = sha256Hex(manifestText)
  return {
    files: fileContents,
    manifest,
    manifestText,
    manifestDigest,
    summary: {
      format: CONTEXT_PACK_FORMAT,
      version: CONTEXT_PACK_MANIFEST_VERSION,
      subject,
      recipient,
      purpose,
      expiresAt,
      generatedAt,
      fileCount: 3,
      checksumCount: 2,
      bytes: totalBytes,
      manifestDigest,
      verificationBasis: CONTEXT_PACK_VERIFICATION_BASIS,
      disclosure,
    },
  }
}

/**
 * Write a built pack atomically: staging directory 0700 / files 0600 next to the
 * target (same filesystem, so rename cannot hit EXDEV), verify the bytes that
 * reached the disk, then rename into place. A non-empty target is refused unless
 * overwrite is true; when overwriting, the old tree is moved aside
 * (.replaced-<timestamp>) instead of deleted.
 */
export function writeContextPackDir(outDir, built, options = {}) {
  if (!isPlainObject(built) || !(built.files instanceof Map)) throw new TypeError('writeContextPackDir expects the buildContextPack result')
  if (typeof outDir !== 'string' || !outDir.trim()) throw invalid('a context pack output directory is required')
  const overwrite = options?.overwrite === true
  const target = resolve(outDir)
  mkdirSync(dirname(target), { recursive: true })
  const fileContents = built.files
  for (const name of fileContents.keys()) {
    if (isUnsafeContextPackPath(name)) throw invalid('refusing to write unsafe pack path: ' + name)
  }
  let replaced = null
  if (existsSync(target)) {
    const info = statSync(target)
    if (!info.isDirectory()) throw invalid('context pack output exists and is not a directory')
    const entries = readdirSync(target)
    if (entries.length && !overwrite) throw invalid('context pack output directory is not empty', 'choose a fresh directory or pass --force')
    if (entries.length) {
      replaced = target + '.replaced-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + sha256Hex(String(Math.random())).slice(0, 8)
      renameSync(target, replaced)
    } else {
      rmdirSync(target)
    }
  }
  const staging = target + '.tmp-' + process.pid + '-' + sha256Hex(String(Math.random())).slice(0, 8)
  mkdirSync(staging, { recursive: true, mode: CONTEXT_PACK_DIR_MODE })
  try { chmodSync(staging, CONTEXT_PACK_DIR_MODE) } catch {}
  try {
    for (const name of [...fileContents.keys()].sort()) {
      const bytes = toBuffer(fileContents.get(name))
      writeFileSync(join(staging, name), bytes, { mode: CONTEXT_PACK_FILE_MODE })
      try { chmodSync(join(staging, name), CONTEXT_PACK_FILE_MODE) } catch {}
    }
    for (const [name, content] of fileContents) {
      const expected = toBuffer(content)
      const actual = readFileSync(join(staging, name))
      if (actual.length !== expected.length) throw invalid('written pack file has the wrong size: ' + name)
      if (sha256Hex(actual) !== sha256Hex(expected)) throw invalid('written pack file hash mismatch: ' + name)
      if (process.platform !== 'win32' && (statSync(join(staging, name)).mode & 0o777) !== CONTEXT_PACK_FILE_MODE) {
        throw invalid('written pack file mode is not 0600: ' + name)
      }
    }
    renameSync(staging, target)
  } catch (error) {
    try { rmSync(staging, { recursive: true, force: true }) } catch {}
    if (replaced) {
      try { renameSync(replaced, target) } catch {
        error.message = error.message + ' (previous pack contents are preserved at ' + replaced + ')'
      }
    }
    throw error
  }
  try { chmodSync(target, CONTEXT_PACK_DIR_MODE) } catch {}
  return { outDir: target, replaced }
}

/* -------------------------------------------------------------------------- */
/* candidate record -> v1 item payload (frozen whitelist)                     */
/* -------------------------------------------------------------------------- */

function sanitizeEvidencePointers(list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    if (!isPlainObject(item)) continue
    const pointer = evidenceDescriptor(item)
    if (!pointer) continue
    const entry = {}
    if (typeof pointer.type === 'string' && pointer.type) entry.type = pointer.type
    const source = isPlainObject(item.source) ? item.source : {}
    for (const key of ['ref', 'sessionId', 'turnId', 'messageId', 'docId', 'pageId', 'url', 'tool', 'toolName']) {
      const value = item[key] !== undefined ? item[key] : source[key] !== undefined ? source[key] : pointer[key]
      if (typeof value === 'string' && value) entry[key] = value
    }
    if (Number.isInteger(pointer.chunkIndex)) entry.chunkIndex = pointer.chunkIndex
    if (typeof pointer.retained === 'boolean') entry.retained = pointer.retained
    entry.kind = evidenceKindOf(item)
    out.push(entry)
    if (out.length >= 50) break
  }
  return out
}

function normalizePreferenceScopeForPack(scope) {
  if (!isPlainObject(scope)) return { level: 'matter' }
  const level = ['global', 'project', 'matter', 'audience'].includes(scope.level) ? scope.level : 'matter'
  const normalized = { level }
  if (typeof scope.value === 'string' && scope.value) normalized.value = scope.value
  return normalized
}

function stringValue(value) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

/**
 * Map one candidate record to the frozen v1 item payload. Only whitelisted
 * keys are copied; evidence is reduced to pointer fields (never quote/body).
 */
export function buildContextPackItem(record, options = {}) {
  const includeQuotes = options.includeQuotes === true
  const warnings = Array.isArray(options.warnings) ? options.warnings : []
  const entity = record.entity
  const payload = {}
  if (record.kind === 'commitment') {
    payload.action = stringValue(entity.action)
    if (entity.debtor) payload.debtor = stringValue(entity.debtor)
    if (entity.creditor) payload.creditor = stringValue(entity.creditor)
    if (entity.dueAt) payload.dueAt = stringValue(entity.dueAt)
    payload.status = 'open'
    if (entity.matterId) payload.matterId = stringValue(entity.matterId)
    const pointers = sanitizeEvidencePointers(entity.evidence)
    if (pointers.length) payload.evidence = pointers
  } else if (record.kind === 'fact') {
    payload.subject = stringValue(entity.subject)
    payload.predicate = stringValue(entity.predicate)
    payload.object = stringValue(entity.object)
    if (entity.validFrom) payload.validFrom = stringValue(entity.validFrom)
    if (entity.validTo) payload.validTo = stringValue(entity.validTo)
    if (entity.recordedAt) payload.recordedAt = stringValue(entity.recordedAt)
    if (entity.matterId) payload.matterId = stringValue(entity.matterId)
  } else if (record.kind === 'preference') {
    payload.kind = stringValue(entity.kind)
    payload.statement = stringValue(entity.statement)
    payload.scope = normalizePreferenceScopeForPack(entity.scope)
    if (entity.priority) payload.priority = stringValue(entity.priority)
    if (entity.validFrom) payload.validFrom = stringValue(entity.validFrom)
    if (entity.expiresAt) payload.expiresAt = stringValue(entity.expiresAt)
  } else {
    payload.title = stringValue(entity.title) || stringValue(entity.tool) || String(entity.id)
    if (entity.tool) payload.tool = stringValue(entity.tool)
    if (entity.templateName) payload.templateName = stringValue(entity.templateName)
    payload.createdAt = stringValue(entity.createdAt)
    if (entity.matterId) payload.matterId = stringValue(entity.matterId)
  }
  if (includeQuotes && (record.kind === 'fact' || record.kind === 'preference') && typeof record.quote === 'string' && record.quote.trim()) {
    const chars = Array.from(record.quote)
    if (chars.length <= 500) {
      payload.quote = record.quote
      payload.quoteSha256 = sha256Hex(record.quote)
    } else {
      warnings.push('quote for ' + record.ref + ' is longer than 500 characters and was omitted')
    }
  }
  return { id: record.ref, kind: record.kind, view: record.view, verification: record.verification, payload }
}

/* -------------------------------------------------------------------------- */
/* candidate payload / create                                                 */
/* -------------------------------------------------------------------------- */

function candidatePayload(collection, clearance) {
  const refs = collection.candidates.map((candidate) => candidate.ref)
  const shown = refs.slice(0, 10)
  const idHint = shown.length ? shown.join(',') + (refs.length > shown.length ? ',...' : '') : '<ref,...>'
  const next = 'advisers context-pack create --subject ' + collection.subject.kind + ':' + collection.subject.id
    + ' --ids ' + idHint + ' --recipient "<name>" --purpose client-delivery --out <dir>'
  return {
    ok: true,
    command: 'context-pack create',
    mode: 'candidates',
    subject: collection.subject,
    generatedAt: collection.generatedAt,
    candidates: collection.candidates,
    counts: collection.counts,
    excluded: collection.excluded,
    limits: {
      ...CONTEXT_PACK_LIMIT_DEFAULTS,
      candidateLimit: { default: CONTEXT_CANDIDATE_LIMIT_DEFAULT, max: CONTEXT_CANDIDATE_LIMIT_MAX },
      clearance: Number.isFinite(Number(clearance)) ? Number(clearance) : 0,
    },
    next,
  }
}

/** Public read-only candidate JSON (bin renders it; nothing is written). */
export function listContextCandidates(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('listContextCandidates expects an options object')
  if (!options.store) throw invalid('listContextCandidates requires an opened SQLite store')
  const nowMs = normalizeNow(options.now)
  const limit = options.limit === undefined ? options.candidateLimit : options.limit
  const collection = collectContextCandidates({
    store: options.store,
    subject: options.subject,
    limit,
    since: options.since,
    now: nowMs,
    clearance: options.clearance,
  })
  return candidatePayload(collection, options.clearance)
}

function normalizeSelectionIds(value) {
  if (value === undefined || value === null) return undefined
  const list = Array.isArray(value) ? value : String(value).split(',')
  const out = []
  for (const raw of list) {
    const id = String(raw ?? '').trim()
    if (id) out.push(id)
  }
  return out
}

/**
 * One-call CLI entry point: candidate mode when neither ids nor yes is given,
 * pack mode otherwise. Always fail closed: the selected ids must be packable
 * current rows inside the subject scope, and a pack is written only after the
 * operator explicitly selected (--ids) or confirmed (--yes) the candidates.
 *
 * Write path (ids/yes) requires a WRITABLE store: after the pack is written and
 * self-verified a `context_pack.create` audit row (ids/hashes only) is appended;
 * if that audit row cannot be written the pack is removed again (fail closed).
 * Candidate mode only reads and works with a read-only store.
 *
 * @param {object} options {store, subject, ids?, yes?, recipient?, purpose?,
 *   expires?, out?, force?, includeQuotes?, since?, now?, clearance?,
 *   candidateLimit?}
 */
export function createContextPack(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('createContextPack expects an options object')
  if (options.expectManifestSha256 !== undefined && options.expectManifestSha256 !== null) {
    throw invalid('--expect-manifest-sha256 is only supported on context-pack verify', 'the manifest digest does not exist before the pack is built (plan 126 section 8-2)')
  }
  if (!options.store) throw invalid('createContextPack requires an opened SQLite store')
  const nowMs = normalizeNow(options.now)
  const ids = normalizeSelectionIds(options.ids)
  const yes = options.yes === true
  if (ids !== undefined && yes) throw invalid('pass either ids or yes, not both')
  if (ids === undefined && !yes) {
    return listContextCandidates({
      store: options.store,
      subject: options.subject,
      limit: options.candidateLimit ?? options.limit,
      since: options.since,
      now: nowMs,
      clearance: options.clearance,
    })
  }
  const recipient = normalizeRecipient(options.recipient)
  const purpose = normalizePurpose(options.purpose)
  const generatedAt = new Date(nowMs).toISOString()
  const expiresAt = resolveContextPackExpiresAt(options.expires, nowMs)
  if (typeof options.out !== 'string' || !options.out.trim()) {
    throw invalid('a context pack output directory is required', 'pass --out <dir> or use suggestContextPackOutDir(ADVISERS_HOME, subject)')
  }
  const includeQuotes = options.includeQuotes === true
  const warnings = []
  let collection
  let records
  if (yes) {
    collection = collectContextCandidates({
      store: options.store,
      subject: options.subject,
      limit: CONTEXT_PACK_LIMIT_DEFAULTS.maxItems + 1,
      since: options.since,
      now: nowMs,
      clearance: options.clearance,
      withRecords: true,
    })
    if (collection.counts.candidateTotal > CONTEXT_PACK_LIMIT_DEFAULTS.maxItems) {
      throw limitError(makeViolation(CONTEXT_PACK_LIMIT_DEFAULTS, 'maxItems', collection.counts.candidateTotal))
    }
    if (!Array.isArray(collection.records) || collection.records.length === 0) {
      throw invalid('no selectable candidates for this subject', 'review candidates first and pass --ids with explicit refs')
    }
    records = collection.records
  } else {
    if (!ids.length) throw invalid('ids must not be empty', 'pass --ids <ref,...> or --yes to confirm all selectable candidates')
    collection = collectContextCandidates({
      store: options.store,
      subject: options.subject,
      limit: 1,
      since: options.since,
      now: nowMs,
      clearance: options.clearance,
    })
    const seen = new Set()
    records = []
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      records.push(loadContextCandidateForSelection({ store: options.store, subject: options.subject, id, now: nowMs, clearance: options.clearance }))
    }
    records.sort(compareContextCandidateRecords)
  }
  const items = records.map((record) => buildContextPackItem(record, { includeQuotes, warnings }))
  const built = buildContextPack({
    subject: { ...collection.subject },
    items,
    recipient,
    purpose,
    expiresAt,
    generatedAt,
    autoAssembled: true,
    candidateCount: collection.counts.candidateTotal,
    excluded: collection.excluded,
    env: { command: 'context-pack create' },
  })
  const written = writeContextPackDir(options.out, built, { overwrite: options.force === true })
  const verification = verifyContextPackDir(written.outDir)
  if (!verification.ok) throw invalid('the written context pack failed self-verification: ' + verification.errors.slice(0, 3).join(' | '))
  // 0.5.1 M8 P0-B: a disclosure pack without a local audit row is an unaudited
  // disclosure. The row carries ids/hashes only (never the subject name or the
  // recipient name/email). If the audit cannot be written the just-written pack
  // is removed again (fail closed): the command never reports a disclosure it
  // did not record.
  const auditRow = contextPackAuditRow({
    subject: built.summary.subject,
    purpose: built.summary.purpose,
    itemCount: items.length,
    manifestDigest: built.summary.manifestDigest,
    recipient: built.summary.recipient,
  })
  let audit
  try {
    if (!options.store || typeof options.store.appendAudit !== 'function') {
      throw new Error('a writable SQLite store with appendAudit() is required')
    }
    options.store.appendAudit(auditRow)
    audit = {
      ok: true,
      action: auditRow.action,
      reason: auditRow.reason,
      subject: { kind: built.summary.subject.kind, id: built.summary.subject.id },
      purpose: built.summary.purpose,
      items: items.length,
      manifestDigest: built.summary.manifestDigest,
      recipientHash: auditRow.recipientHash,
    }
  } catch (error) {
    try { rmSync(written.outDir, { recursive: true, force: true }) } catch {}
    const note = written.replaced ? ' (the previous pack is preserved at ' + written.replaced + ')' : ''
    throw entityError(CONTEXT_PACK_INVALID_CODE,
      'the context pack was written but the ' + CONTEXT_PACK_AUDIT_ACTION + ' audit row failed; the pack was removed (fail closed): ' + String(error?.message ?? error).slice(0, 200) + note,
      'context-pack create needs a writable SQLite store: the audit row is the disclosure receipt')
  }
  return {
    ok: true,
    command: 'context-pack create',
    format: built.summary.format,
    version: built.summary.version,
    out: written.outDir,
    replaced: written.replaced,
    manifestDigest: built.summary.manifestDigest,
    verificationBasis: built.summary.verificationBasis,
    subject: built.summary.subject,
    recipient: built.summary.recipient,
    purpose: built.summary.purpose,
    expiresAt: built.summary.expiresAt,
    generatedAt: built.summary.generatedAt,
    disclosure: built.summary.disclosure,
    audit,
    fileCount: 3,
    checksumCount: 2,
    bytes: built.summary.bytes,
    warnings,
    verification: {
      ok: verification.ok,
      format: verification.format,
      version: verification.version,
      manifestDigest: verification.manifestDigest,
      fileCount: verification.fileCount,
      checksumCount: verification.checksumCount,
      warnings: verification.warnings,
    },
  }
}

/* -------------------------------------------------------------------------- */
/* verifier                                                                   */
/* -------------------------------------------------------------------------- */

function limitMessage(violation) {
  const label = LIMIT_LABELS[violation.limit] ?? violation.limit
  return CONTEXT_PACK_LIMIT_CODE + ': context pack ' + label + ' exceeded the limit ' + violation.max + ' (actual ' + violation.actual + '); refusing to read a pack that could exhaust memory or time.'
}

/** Strict coreutils-style SHA256SUMS: 64 lowercase hex + two spaces + name. */
export function parseContextPackSums(text) {
  const entries = new Map()
  const errors = []
  if (typeof text !== 'string') {
    addError(errors, 'SHA256SUMS is missing or unreadable')
    return { entries, errors }
  }
  const lines = text.split(LF)
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1
    const line = rawLine.endsWith(String.fromCharCode(13)) ? rawLine.slice(0, -1) : rawLine
    if (line === '') return
    if (line.length < 67 || line.charAt(64) !== ' ' || line.charAt(65) !== ' ') {
      addError(errors, 'malformed SHA256SUMS line ' + lineNumber)
      return
    }
    const digest = line.slice(0, 64)
    const name = line.slice(66)
    if (!isHexLower(digest)) { addError(errors, 'malformed SHA256SUMS digest on line ' + lineNumber); return }
    if (line.trim() !== line) { addError(errors, 'SHA256SUMS line ' + lineNumber + ' has leading/trailing whitespace'); return }
    if (name === CONTEXT_PACK_SHA256SUMS_FILE) { addError(errors, 'SHA256SUMS must not list itself'); return }
    if (isUnsafeContextPackPath(name)) { addError(errors, 'unsafe path in SHA256SUMS: ' + name); return }
    if (entries.has(name)) { addError(errors, 'duplicate entry in SHA256SUMS: ' + name); return }
    entries.set(name, digest)
  })
  return { entries, errors }
}

function walkPackFiles(root, limits) {
  const files = []
  const errors = []
  let entryCount = 0
  let totalBytes = 0
  let violation = null
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    addError(errors, 'cannot read the context pack directory: ' + (error.code || error.message))
    return { files, errors, violation, totalBytes, entryCount }
  }
  for (const entry of entries) {
    entryCount += 1
    const name = entry.name
    if (entryCount > limits.maxEntries) {
      violation = makeViolation(limits, 'maxEntries', entryCount)
      addError(errors, limitMessage(violation))
      break
    }
    if (entry.isSymbolicLink()) { addError(errors, 'symbolic links are not allowed in a context pack: ' + name); continue }
    if (entry.isDirectory()) { addError(errors, 'directories are not allowed in a context pack: ' + name); continue }
    if (!entry.isFile()) { addError(errors, 'unsupported file type in a context pack: ' + name); continue }
    if (isUnsafeContextPackPath(name)) { addError(errors, 'unsafe file name in a context pack: ' + name); continue }
    let info
    try { info = statSync(join(root, name)) } catch (error) { addError(errors, 'cannot stat ' + name + ': ' + (error.code || error.message)); continue }
    if (info.size > limits.maxPackBytes) {
      violation = makeViolation(limits, 'maxPackBytes', info.size)
      addError(errors, limitMessage(violation))
      break
    }
    totalBytes += info.size
    if (totalBytes > limits.maxPackBytes) {
      violation = makeViolation(limits, 'maxPackBytes', totalBytes)
      addError(errors, limitMessage(violation))
      break
    }
    files.push(name)
  }
  files.sort()
  return { files, errors, violation, totalBytes, entryCount }
}

function hashFileWithLimit(file, limits) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let bytes = 0
  const fd = openSync(file, 'r')
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null)
      if (!count) break
      bytes += count
      if (bytes > limits.maxPackBytes) return { violation: makeViolation(limits, 'maxPackBytes', bytes) }
      hash.update(buffer.subarray(0, count))
    }
  } finally {
    try { closeSync(fd) } catch {}
  }
  return { sha256: hash.digest('hex'), bytes }
}

function readBoundedText(file, limits) {
  const info = statSync(file)
  if (info.size > limits.maxPackBytes) return { violation: makeViolation(limits, 'maxPackBytes', info.size) }
  return { text: readFileSync(file, 'utf8') }
}

function validateDisclosureBlock(disclosure, items, errors, warnings) {
  if (!isPlainObject(disclosure)) { addError(errors, 'manifest.disclosure must be an object'); return }
  for (const key of Object.keys(disclosure)) {
    if (!DISCLOSURE_KEYS.includes(key)) warnings.push('manifest.disclosure has an unknown key (ignored forward-compatible field): ' + key)
  }
  if (typeof disclosure.autoAssembled !== 'boolean') addError(errors, 'manifest.disclosure.autoAssembled must be a boolean')
  for (const key of ['candidateCount', 'selectedCount', 'itemCount']) {
    if (!isNonNegativeInteger(disclosure[key])) addError(errors, 'manifest.disclosure.' + key + ' must be a non-negative integer')
  }
  if (isNonNegativeInteger(disclosure.itemCount) && disclosure.itemCount !== items.length) addError(errors, 'manifest.disclosure.itemCount does not match manifest.items.length')
  if (isNonNegativeInteger(disclosure.selectedCount) && disclosure.selectedCount !== items.length) addError(errors, 'manifest.disclosure.selectedCount does not match manifest.items.length')
  if (isNonNegativeInteger(disclosure.candidateCount) && isNonNegativeInteger(disclosure.selectedCount) && disclosure.candidateCount < disclosure.selectedCount) {
    addError(errors, 'manifest.disclosure.candidateCount must be at least selectedCount')
  }
  const expectedFields = [...new Set(items.flatMap((item) => (Array.isArray(item.fields) ? item.fields : [])))].sort()
  if (!Array.isArray(disclosure.fields) || !disclosure.fields.every((field) => typeof field === 'string') || new Set(disclosure.fields).size !== disclosure.fields.length) {
    addError(errors, 'manifest.disclosure.fields must be a unique string array')
  } else if (JSON.stringify(disclosure.fields) !== JSON.stringify(expectedFields)) {
    addError(errors, 'manifest.disclosure.fields must equal the union of item fields')
  }
  const includesQuotes = items.some((item) => isPlainObject(item.payload) && Object.hasOwn(item.payload, 'quote'))
  if (disclosure.includesQuotes !== includesQuotes) addError(errors, 'manifest.disclosure.includesQuotes disagrees with the items')
  if (disclosure.includesOriginalSources !== false) addError(errors, 'manifest.disclosure.includesOriginalSources must be false in v1')
  if (disclosure.confersReadAuthority !== false) addError(errors, 'manifest.disclosure.confersReadAuthority must be false in v1')
  if (disclosure.confersExecutionAuthority !== false) addError(errors, 'manifest.disclosure.confersExecutionAuthority must be false in v1')
  if (!isPlainObject(disclosure.excluded)) { addError(errors, 'manifest.disclosure.excluded must be an object'); return }
  if (!isNonNegativeInteger(disclosure.excluded.total)) addError(errors, 'manifest.disclosure.excluded.total must be a non-negative integer')
  if (!isPlainObject(disclosure.excluded.byReason)) { addError(errors, 'manifest.disclosure.excluded.byReason must be an object'); return }
  let sum = 0
  for (const key of CONTEXT_EXCLUSION_REASONS) {
    const value = disclosure.excluded.byReason[key]
    if (!isNonNegativeInteger(value)) { addError(errors, 'manifest.disclosure.excluded.byReason.' + key + ' must be a non-negative integer'); continue }
    sum += value
  }
  for (const key of Object.keys(disclosure.excluded.byReason)) {
    if (CONTEXT_EXCLUSION_REASONS.includes(key)) continue
    const value = disclosure.excluded.byReason[key]
    if (!isNonNegativeInteger(value)) addError(errors, 'manifest.disclosure.excluded.byReason has an unknown non-integer reason: ' + key)
    else { sum += value; warnings.push('manifest.disclosure.excluded.byReason has an unknown reason (ignored forward-compatible field): ' + key) }
  }
  if (isNonNegativeInteger(disclosure.excluded.total) && disclosure.excluded.total !== sum) addError(errors, 'manifest.disclosure.excluded.total must equal the sum of byReason')
}

function validateManifest(manifest, { limits, errors, warnings }) {
  if (!isPlainObject(manifest)) { addError(errors, 'manifest.json must be a JSON object'); return null }
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.includes(key)) warnings.push('manifest has an unknown top-level key (ignored forward-compatible field): ' + key)
  }
  if (manifest.format !== CONTEXT_PACK_FORMAT) addError(errors, 'manifest.format must be "' + CONTEXT_PACK_FORMAT + '"')
  if (manifest.version !== CONTEXT_PACK_MANIFEST_VERSION) addError(errors, 'manifest.version must be ' + CONTEXT_PACK_MANIFEST_VERSION)
  if (!isDateText(manifest.generatedAt)) addError(errors, 'manifest.generatedAt must be an ISO date-time')
  if (!isPlainObject(manifest.generator)) addError(errors, 'manifest.generator must be an object')
  else {
    for (const key of ['nodeVersion', 'platform', 'command']) {
      if (typeof manifest.generator[key] !== 'string' || !manifest.generator[key]) addError(errors, 'manifest.generator.' + key + ' must be a non-empty string')
    }
    if (Object.hasOwn(manifest.generator, 'advisersVersion') && manifest.generator.advisersVersion !== null && typeof manifest.generator.advisersVersion !== 'string') {
      addError(errors, 'manifest.generator.advisersVersion must be a string or null')
    }
  }
  if (!isPlainObject(manifest.subject)) addError(errors, 'manifest.subject must be an object')
  else {
    if (!['client', 'matter'].includes(manifest.subject.kind)) addError(errors, 'manifest.subject.kind must be client or matter')
    if (typeof manifest.subject.id !== 'string' || !manifest.subject.id) addError(errors, 'manifest.subject.id must be a non-empty string')
    if (typeof manifest.subject.name !== 'string' || !manifest.subject.name || Array.from(manifest.subject.name).length > 200) addError(errors, 'manifest.subject.name must be a non-empty string of at most 200 characters')
  }
  if (!isPlainObject(manifest.recipient)) addError(errors, 'manifest.recipient must be an object')
  else {
    if (typeof manifest.recipient.name !== 'string' || !manifest.recipient.name || Array.from(manifest.recipient.name).length > 200) addError(errors, 'manifest.recipient.name must be a non-empty string of at most 200 characters')
    if (manifest.recipient.email !== undefined && (typeof manifest.recipient.email !== 'string' || !manifest.recipient.email || Array.from(manifest.recipient.email).length > 200)) {
      addError(errors, 'manifest.recipient.email must be a non-empty string of at most 200 characters when present')
    }
  }
  if (!CONTEXT_PACK_PURPOSES.includes(manifest.purpose)) addError(errors, 'manifest.purpose must be one of ' + CONTEXT_PACK_PURPOSES.join(', '))
  if (!isDateText(manifest.expiresAt)) addError(errors, 'manifest.expiresAt must be an ISO date-time')
  if (manifest.verificationBasis !== CONTEXT_PACK_VERIFICATION_BASIS) addError(errors, 'manifest.verificationBasis must be "' + CONTEXT_PACK_VERIFICATION_BASIS + '"')
  if (manifest.fileCount !== 3) addError(errors, 'manifest.fileCount must be 3 in context pack v1')
  if (!Array.isArray(manifest.items)) { addError(errors, 'manifest.items must be an array'); return null }
  if (manifest.items.length === 0) addError(errors, 'manifest.items must not be empty')
  if (manifest.items.length > limits.maxItems) return makeViolation(limits, 'maxItems', manifest.items.length)
  let itemsBytes = 0
  try { itemsBytes = byteLength(stableStringify(manifest.items)) } catch { itemsBytes = limits.maxItemsBytes + 1 }
  if (itemsBytes > limits.maxItemsBytes) return makeViolation(limits, 'maxItemsBytes', itemsBytes)
  manifest.items.forEach((item, index) => validateItemShape(item, index, errors))
  for (const item of manifest.items) {
    let size = limits.maxItemBytes + 1
    try { size = byteLength(stableStringify(item)) } catch { size = limits.maxItemBytes + 1 }
    if (size > limits.maxItemBytes) return makeViolation(limits, 'maxItemBytes', size)
  }
  validateDisclosureBlock(manifest.disclosure, manifest.items, errors, warnings)
  return null
}

function applyLimitResult(result, violation, errors) {
  result.code = CONTEXT_PACK_LIMIT_CODE
  result.limitViolation = violation
  addError(errors, limitMessage(violation))
  return result
}

/**
 * Verify a context pack directory offline (untrusted input; bounded reads).
 *
 * @param {string} dir pack directory
 * @param {{limits?: object, expectManifestSha256?: string}} [options]
 * @returns {object} {ok,code,errors,warnings,dir,format,version,fileCount,
 *   checksumCount,files,manifestDigest,verificationBasis,expectedSha256,
 *   matchesExpected,limits,limitViolation}
 */
export function verifyContextPackDir(dir, options = {}) {
  const errors = []
  const warnings = []
  const limits = normalizeLimits(options?.limits)
  const result = {
    ok: false,
    code: null,
    errors,
    warnings,
    dir: String(dir),
    format: null,
    version: null,
    fileCount: 0,
    checksumCount: 0,
    bytes: 0,
    files: [],
    manifestDigest: null,
    verificationBasis: null,
    expiresAt: null,
    expired: null,
    expectedSha256: null,
    matchesExpected: null,
    limits: { ...limits },
    limitViolation: null,
  }
  if (typeof dir !== 'string' || !dir.trim()) { addError(errors, 'a context pack directory is required'); return result }
  let expected = null
  if (options?.expectManifestSha256 !== undefined && options.expectManifestSha256 !== null) {
    const value = String(options.expectManifestSha256).trim()
    result.expectedSha256 = value
    if (!isHexLower(value)) { addError(errors, '--expect-manifest-sha256 must be 64 lowercase hex characters'); result.matchesExpected = false }
    else expected = value
  }
  let root
  try { root = resolve(dir) } catch { addError(errors, 'invalid context pack path'); return result }
  if (!existsSync(root)) { addError(errors, 'context pack directory not found'); return result }
  let rootStat
  try { rootStat = statSync(root) } catch { addError(errors, 'cannot stat the context pack directory'); return result }
  if (!rootStat.isDirectory()) { addError(errors, 'context pack path is not a directory'); return result }
  const walked = walkPackFiles(root, limits)
  for (const error of walked.errors) addError(errors, error)
  result.files = walked.files.slice()
  result.fileCount = walked.files.length
  result.bytes = walked.totalBytes
  if (walked.violation) return applyLimitResult(result, walked.violation, errors)
  const fileSet = new Set(walked.files)
  const allowedFiles = new Set([...CONTEXT_PACK_REQUIRED_FILES, CONTEXT_PACK_SHA256SUMS_FILE])
  for (const name of walked.files) if (!allowedFiles.has(name)) addError(errors, 'unexpected file in a context pack: ' + name)
  for (const required of CONTEXT_PACK_REQUIRED_FILES) if (!fileSet.has(required)) addError(errors, 'missing file: ' + required)
  if (!fileSet.has(CONTEXT_PACK_SHA256SUMS_FILE)) { addError(errors, 'missing file: ' + CONTEXT_PACK_SHA256SUMS_FILE); return result }
  let sumsText
  try {
    const info = statSync(join(root, CONTEXT_PACK_SHA256SUMS_FILE))
    if (info.size > limits.maxSumsBytes) {
      const violation = makeViolation(limits, 'maxSumsBytes', info.size)
      addError(errors, limitMessage(violation))
      result.code = CONTEXT_PACK_LIMIT_CODE
      result.limitViolation = violation
      return result
    }
    sumsText = readFileSync(join(root, CONTEXT_PACK_SHA256SUMS_FILE), 'utf8')
  } catch { addError(errors, 'cannot read SHA256SUMS'); return result }
  const parsed = parseContextPackSums(sumsText)
  for (const error of parsed.errors) addError(errors, error)
  result.checksumCount = parsed.entries.size
  if (parsed.entries.size !== 2) addError(errors, 'SHA256SUMS must cover exactly manifest.json and README.txt')
  for (const required of CONTEXT_PACK_REQUIRED_FILES) if (!parsed.entries.has(required)) addError(errors, 'SHA256SUMS does not cover ' + required)
  for (const name of parsed.entries.keys()) {
    if (!allowedFiles.has(name)) addError(errors, 'SHA256SUMS lists an unexpected file: ' + name)
    if (!fileSet.has(name)) addError(errors, 'missing file: ' + name)
  }
  for (const name of fileSet) {
    if (name === CONTEXT_PACK_SHA256SUMS_FILE) continue
    if (!parsed.entries.has(name)) addError(errors, 'file not covered by SHA256SUMS: ' + name)
  }
  for (const [name, expectedHash] of parsed.entries) {
    if (!fileSet.has(name)) continue
    try {
      const hashed = hashFileWithLimit(join(root, name), limits)
      if (hashed.violation) return applyLimitResult(result, hashed.violation, errors)
      if (hashed.sha256 !== expectedHash) addError(errors, 'hash mismatch: ' + name)
    } catch { addError(errors, 'cannot read file ' + name) }
  }
  if (!fileSet.has('manifest.json')) return result
  let manifest = null
  let manifestBytes = null
  try {
    const info = statSync(join(root, 'manifest.json'))
    if (info.size > limits.maxManifestBytes) {
      const violation = makeViolation(limits, 'maxManifestBytes', info.size)
      addError(errors, limitMessage(violation))
      result.code = CONTEXT_PACK_LIMIT_CODE
      result.limitViolation = violation
      return result
    }
    manifestBytes = readFileSync(join(root, 'manifest.json'))
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch { addError(errors, 'manifest.json is not valid JSON'); return result }
  result.manifestDigest = sha256Hex(manifestBytes)
  if (isPlainObject(manifest)) {
    result.format = typeof manifest.format === 'string' ? manifest.format : null
    result.version = Number.isInteger(manifest.version) ? manifest.version : null
    result.verificationBasis = typeof manifest.verificationBasis === 'string' ? manifest.verificationBasis : null
  }
  if (expected !== null) {
    result.matchesExpected = result.manifestDigest === expected
    if (!result.matchesExpected) {
      addError(errors, 'manifest digest does not match --expect-manifest-sha256')
      result.code = CONTEXT_PACK_DIGEST_MISMATCH_CODE
    }
  }
  const violation = validateManifest(manifest, { limits, errors, warnings })
  if (violation) return applyLimitResult(result, violation, errors)
  // 0.5.1 (202 A4/P2): expiry is a disclosure record, not access control. An
  // expired pack still verifies (0/1 semantics unchanged); it only warns so a
  // receiver/agent can notice the disclosure window has passed.
  result.expiresAt = typeof manifest.expiresAt === 'string' ? manifest.expiresAt : null
  if (result.expiresAt !== null) {
    const expiresMs = Date.parse(result.expiresAt)
    if (Number.isFinite(expiresMs)) {
      result.expired = expiresMs < Date.now()
      if (result.expired) {
        warnings.push('the context pack expired at ' + result.expiresAt + ': expiry is a disclosure record only, not access control; it does not block verification or prove who received the pack')
      }
    }
  }
  if (fileSet.has('README.txt')) {
    try {
      const read = readBoundedText(join(root, 'README.txt'), limits)
      if (read.violation) return applyLimitResult(result, read.violation, errors)
      if (!read.text.trim()) addError(errors, 'README.txt is empty')
      else {
        if (!read.text.includes(CONTEXT_PACK_SHA256SUMS_FILE)) warnings.push('README.txt does not mention SHA256SUMS')
        if (!read.text.includes('not a signature') && !read.text.includes('不是签名')) warnings.push('README.txt does not state that checksums are not a signature')
        if (!read.text.includes('no import path') && !read.text.includes('NO import path') && !read.text.includes('不可回灌') && !read.text.includes('no re-ingest')) {
          warnings.push('README.txt does not state that a context pack has no import path')
        }
      }
    } catch { addError(errors, 'cannot read README.txt') }
  }
  warnings.push('verification basis is ' + CONTEXT_PACK_VERIFICATION_BASIS + ': SHA-256 proves pack internal consistency only, not authorship or generation time')
  if (result.code === null && errors.length > 0) result.code = CONTEXT_PACK_INVALID_CODE
  result.ok = errors.length === 0
  return result
}

/* -------------------------------------------------------------------------- */
/* format dispatch helpers (evidence verify / import refusal)                 */
/* -------------------------------------------------------------------------- */

/**
 * Read only manifest.format/version from a directory (bounded). bin/evidence
 * verify uses this to dispatch context -> client -> receipt without trusting
 * the rest of the manifest.
 */
export function readContextPackManifestHeader(dir, options = {}) {
  const limits = normalizeLimits(options?.limits)
  const out = { ok: false, format: null, version: null, error: null }
  if (typeof dir !== 'string' || !dir.trim()) { out.error = 'a pack directory is required'; return out }
  let root
  try { root = resolve(dir) } catch { out.error = 'invalid path'; return out }
  if (!existsSync(root)) { out.error = 'directory not found'; return out }
  const manifestPath = join(root, 'manifest.json')
  if (!existsSync(manifestPath)) { out.error = 'manifest.json not found'; return out }
  try {
    const info = statSync(manifestPath)
    if (!info.isFile()) { out.error = 'manifest.json is not a file'; return out }
    if (info.size > limits.maxManifestBytes) { out.error = 'manifest.json exceeds the size limit'; return out }
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!isPlainObject(parsed)) { out.error = 'manifest.json is not an object'; return out }
    out.format = typeof parsed.format === 'string' ? parsed.format : null
    out.version = Number.isInteger(parsed.version) ? parsed.version : null
    out.ok = Boolean(out.format)
    return out
  } catch (error) {
    out.error = String(error?.message ?? error)
    return out
  }
}

/** Cheap header probe used by the CLI/import guard. */
export function isContextPackDir(dir, options = {}) {
  const header = readContextPackManifestHeader(dir, options)
  return header.ok && header.format === CONTEXT_PACK_FORMAT
}

/**
 * Refuse to import a context pack: the format is disclosure-only and has no
 * re-ingest path (a pack can never become read authority, claims or actions).
 * Returns false when the directory is not a context pack.
 */
export function assertContextPackNotImportable(dir, options = {}) {
  let header
  try { header = readContextPackManifestHeader(dir, options) } catch { return false }
  if (!header.ok || header.format !== CONTEXT_PACK_FORMAT) return false
  throw entityError(
    CONTEXT_PACK_IMPORT_UNSUPPORTED_CODE,
    'a context pack cannot be imported: it is a one-way disclosure package, not a ledger export',
    'use export/import (or export --bundle) for ledger data; context packs have no re-ingest path in 0.5.0',
  )
}

export default Object.freeze({
  CONTEXT_PACK_FORMAT,
  CONTEXT_PACK_MANIFEST_VERSION,
  CONTEXT_PACK_VERIFICATION_BASIS,
  CONTEXT_PACK_ITEM_VERIFICATION_BASIS,
  CONTEXT_PACK_SHA256SUMS_FILE,
  CONTEXT_PACK_FILE_MODE,
  CONTEXT_PACK_DIR_MODE,
  CONTEXT_PACK_REQUIRED_FILES,
  CONTEXT_PACK_LIMIT_CODE,
  CONTEXT_PACK_INVALID_CODE,
  CONTEXT_PACK_IMPORT_UNSUPPORTED_CODE,
  CONTEXT_PACK_DIGEST_MISMATCH_CODE,
  CONTEXT_PACK_AUDIT_ACTION,
  CONTEXT_PACK_ITEM_KINDS,
  CONTEXT_PACK_PURPOSES,
  CONTEXT_PACK_ITEM_VIEWS,
  CONTEXT_PACK_LIMIT_DEFAULTS,
  CONTEXT_PACK_PAYLOAD_FIELDS,
  isUnsafeContextPackPath,
  contextPackRecipientHash,
  contextPackAuditRow,
  suggestContextPackOutDir,
  resolveContextPackExpiresAt,
  buildContextPack,
  buildContextPackItem,
  writeContextPackDir,
  createContextPack,
  listContextCandidates,
  parseContextPackSums,
  verifyContextPackDir,
  readContextPackManifestHeader,
  isContextPackDir,
  assertContextPackNotImportable,
})
