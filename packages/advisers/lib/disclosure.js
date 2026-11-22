/**
 * Read disclosure (M1, 0.5.0): one pure module that labels every read row with
 * a view state and describes the disclosure of a read result (fields, view
 * counts, clearance, digest, content-addressed call id).
 *
 * Vocabulary (docs/MCP.md / docs/LEDGER-READ-API.md; 122 §3.5):
 *   verified    local evidence resolved at least once (NOT "the record is true";
 *               it only says the local pointer/turn was resolvable);
 *   pending     current record without a resolved local evidence pointer;
 *   historical  no longer current (done/dropped/superseded/deprecated/expired);
 *   derived     computed projection with no evidence pointer of its own (clients).
 *
 * The module is metadata-only: buildDisclosure() never embeds record values, a
 * quote, an absolute path or a timestamp. callId/digest are content-addressed
 * over the disclosure metadata so the same read shape yields the same ids;
 * uniqueness over time is supplied by the audit sequence, not by a nonce.
 */
import { createHash } from 'node:crypto'

/** Closed view vocabulary for row labels. */
export const READ_VIEWS = Object.freeze(['verified', 'pending', 'historical', 'derived'])
/** Closed verification-basis vocabulary. */
export const READ_BASIS = Object.freeze(['local-resolution', 'preview'])
/** Advisory surfaces this disclosure vocabulary is shipped to. */
export const DISCLOSURE_SURFACES = Object.freeze(['mcp', 'dsh'])

const VIEW_COUNT_KEYS = Object.freeze(['verified', 'pending', 'historical', 'derived'])
const HISTORICAL_COMMITMENT_STATUSES = new Set(['done', 'dropped'])
const HISTORICAL_FACT_STATUSES = new Set(['superseded', 'deleted'])
const HISTORICAL_PREFERENCE_STATUSES = new Set(['deprecated'])

/** Deterministic JSON (recursively sorted keys) used only for hashing. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
}

/** Lowercase sha256 hex of a UTF-8 string. */
export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function countOf(value) {
  return Array.isArray(value) ? value.length : 0
}

/**
 * Verification summary of one evidence traceback (the resolver buckets from
 * lib/evidence.js: sources/missing/unverifiable/notChecked).
 */
export function verificationOf(result, totals = {}) {
  const resolved = Number.isInteger(totals.resolved) ? totals.resolved : countOf(result?.sources)
  const missing = Number.isInteger(totals.missing) ? totals.missing : countOf(result?.missing)
  const unverifiable = Number.isInteger(totals.unverifiable) ? totals.unverifiable : countOf(result?.unverifiable)
  const notChecked = Number.isInteger(totals.notChecked) ? totals.notChecked : countOf(result?.notChecked)
  return { basis: 'local-resolution', resolved, missing, unverifiable, notChecked }
}

/**
 * Row view label. `verification` is the output of verificationOf() (or null
 * when the read path could not resolve evidence at all, which stays pending).
 */
export function viewOf(kind, row, verification) {
  if (kind === 'client') return 'derived'
  const resolved = Number.isInteger(verification?.resolved) ? verification.resolved : 0
  const status = typeof row?.status === 'string' ? row.status : ''
  if (kind === 'commitment') {
    if (HISTORICAL_COMMITMENT_STATUSES.has(status)) return 'historical'
    return resolved > 0 ? 'verified' : 'pending'
  }
  if (kind === 'fact') {
    if (HISTORICAL_FACT_STATUSES.has(status)) return 'historical'
    if (row?.expiredAt) return 'historical'
    return status === 'confirmed' && resolved > 0 ? 'verified' : 'pending'
  }
  if (kind === 'preference') {
    if (HISTORICAL_PREFERENCE_STATUSES.has(status)) return 'historical'
    return status === 'confirmed' && resolved > 0 ? 'verified' : 'pending'
  }
  return 'pending'
}

/** Count a batch of row view labels into the closed count object. */
export function viewCountsOf(views) {
  const counts = { verified: 0, pending: 0, historical: 0, derived: 0 }
  for (const view of Array.isArray(views) ? views : []) {
    if (Object.prototype.hasOwnProperty.call(counts, view)) counts[view] += 1
  }
  return counts
}

/**
 * Sorted union of the own keys of the returned rows (never values). The
 * row-level `view` label is itself metadata and is excluded from the list.
 */
export function fieldsOf(rows) {
  const fields = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    for (const key of Object.keys(row)) if (key !== 'view') fields.add(key)
  }
  return [...fields].sort()
}

function normalizeCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
}

function normalizeFields(fields) {
  const set = new Set()
  for (const field of Array.isArray(fields) ? fields : []) {
    if (typeof field === 'string' && field && field !== 'view') set.add(field)
  }
  return [...set].sort()
}

function disclosureCore(disclosure) {
  return {
    surface: disclosure.surface,
    tool: disclosure.tool,
    basis: disclosure.basis,
    fields: disclosure.fields,
    view: disclosure.view,
    clearance: disclosure.clearance,
    protectedExcluded: disclosure.protectedExcluded,
    truncated: disclosure.truncated,
  }
}

/**
 * Build the disclosure block attached to a successful read result.
 *
 * @param {{surface?: 'mcp'|'dsh', tool: string, basis?: 'local-resolution'|'preview',
 *   fields?: string[], views?: string[], clearance?: number,
 *   protectedExcluded?: number, truncated?: boolean, audited?: boolean}} input
 * @returns {object} {surface, tool, basis, callId, fields, view, clearance,
 *   protectedExcluded, truncated, audited, digest}
 */
export function buildDisclosure(input = {}) {
  const surface = DISCLOSURE_SURFACES.includes(input.surface) ? input.surface : 'mcp'
  const tool = typeof input.tool === 'string' && input.tool ? input.tool : 'read'
  const basis = READ_BASIS.includes(input.basis) ? input.basis : 'local-resolution'
  const disclosure = {
    surface,
    tool,
    basis,
    callId: '',
    fields: normalizeFields(input.fields),
    view: viewCountsOf(input.views),
    clearance: normalizeCount(input.clearance),
    protectedExcluded: normalizeCount(input.protectedExcluded),
    truncated: input.truncated === true,
    audited: input.audited === true,
    digest: '',
  }
  const digest = 'sha256:' + sha256Hex(canonicalJson(disclosureCore(disclosure)))
  disclosure.callId = 'dc_' + digest.slice('sha256:'.length, 'sha256:'.length + 16)
  disclosure.digest = digest
  return disclosure
}

/** Content digest of the disclosure metadata ('sha256:<64hex>'). */
export function disclosureDigest(disclosure) {
  return 'sha256:' + sha256Hex(canonicalJson(disclosureCore(disclosure ?? {})))
}

/**
 * Set the audit outcome of a disclosure. The payload is built before the
 * single mcp.call audit row is written, so the boolean is finalized afterwards;
 * the digest/callId are NOT affected by the audit outcome.
 */
export function withAudited(disclosure, audited, warning) {
  if (!disclosure || typeof disclosure !== 'object' || Array.isArray(disclosure)) return disclosure
  disclosure.audited = audited === true
  if (audited !== true && typeof warning === 'string' && warning) disclosure.warning = warning
  else if (Object.prototype.hasOwnProperty.call(disclosure, 'warning')) delete disclosure.warning
  return disclosure
}

/**
 * Audit reason extension for one successful read: callId, view counts, clearance,
 * disclosed field names and digest. Never carries record values or paths.
 */
export function disclosureAuditReason(label, disclosure) {
  const text = typeof label === 'string' && label ? label : 'read'
  if (!disclosure || typeof disclosure !== 'object') return text
  const view = disclosure.view ?? {}
  const counts = VIEW_COUNT_KEYS.map((key) => key + ':' + String(Number(view[key]) || 0)).join(',')
  const fields = Array.isArray(disclosure.fields) ? disclosure.fields.join(',') : ''
  return text + ' callId=' + String(disclosure.callId) + ' view=' + counts + ' clearance=' + String(disclosure.clearance) + ' fields=' + fields + ' digest=' + String(disclosure.digest)
}
