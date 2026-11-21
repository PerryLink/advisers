/**
 * Source provenance schema v2 (E2).
 *
 * Every candidate accepted into a commitment/fact/preference keeps a pointer to
 * the local input it came from (docs/SOURCE-SCHEMA.md). v1 stored whatever the
 * capture/import path happened to have, and evidence rows kept sessionId/turnId
 * next to it. The two consequences were:
 *
 *   - mail / calendar / transcript provenance had different ad-hoc field names
 *     in every entry point (uid vs messageId, speakers vs speaker, ...);
 *   - there was no version marker, so a reader could not tell v1 from a future
 *     schema.
 *
 * v2 is the canonical shape below, with an explicit sourceVersion marker:
 *
 *   { sourceVersion: 2, type, quote, ref, messageId, subject, file, mime,
 *     speaker, tStart, tEnd, capturedAt }
 *
 * 0.4 extends the canonical type list (kb_chunk, kb_page, web, tool) without
 * changing the shape: typed pointer fields (docId/pageId/url/tool) and the
 * additive flags (chunkIndex, retained, derivedFrom) are preserved as
 * extensions so older readers keep ignoring them.
 *
 * normalizeSource() maps legacy rows into this shape (and preserves unknown
 * fields as extensions so old consumers keep working); validateSource() reports
 * schema problems; toLegacySource() produces the lossy v1 view for consumers
 * that have not migrated yet. Everything here is pure: no database, no
 * filesystem, no network.
 *
 * @module source
 */

/** Current source schema version. */
export const SOURCE_VERSION = 2

/**
 * Canonical source types; any other stored type is preserved with a warning.
 *
 * 0.4 adds the data-bearing types introduced by the mail/KB evidence lines:
 *   kb_chunk / kb_page  local KB chunk/page ids (stable, never reused)
 *   web                 a URL reference; the page itself is never cached
 *   tool                a tool result reference; tool bodies are not turns
 * The four 0.2.0 types stay byte-compatible: normalizeSource() never rewrites
 * stored rows, and old readers keep ignoring the new type values.
 */
export const SOURCE_TYPES = Object.freeze([
  'conversation',
  'mail',
  'calendar',
  'transcript',
  'kb_chunk',
  'kb_page',
  'web',
  'tool',
])

/** Legacy type spellings that map onto a canonical type. */
export const SOURCE_TYPE_ALIASES = Object.freeze({ email: 'mail' })

/**
 * Pointer fields that identify the source for each type (in addition to the
 * generic `ref`). Used by validateSource() and lib/evidence.js to decide
 * whether a typed source can be resolved without inventing a conversation turn.
 */
export const SOURCE_POINTER_FIELDS = Object.freeze({
  conversation: Object.freeze(['ref']),
  mail: Object.freeze(['ref', 'messageId', 'file']),
  calendar: Object.freeze(['ref']),
  transcript: Object.freeze(['ref', 'file']),
  kb_chunk: Object.freeze(['ref', 'docId']),
  kb_page: Object.freeze(['ref', 'pageId']),
  web: Object.freeze(['ref', 'url']),
  tool: Object.freeze(['ref', 'turnId', 'tool']),
})

const VERSION_KEYS = ['sourceVersion', 'source_v', 'source_version']
const FIELDS = Object.freeze([
  'type',
  'quote',
  'ref',
  'messageId',
  'subject',
  'file',
  'mime',
  'speaker',
  'tStart',
  'tEnd',
  'capturedAt',
])
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[^;]+)*$/i

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function basename(value) {
  const text = trimmedString(value)
  if (!text) return ''
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

function hasPathSeparator(value) {
  return typeof value === 'string' && /[\\/]/.test(value)
}

function readVersion(raw) {
  for (const key of VERSION_KEYS) {
    if (raw[key] === undefined || raw[key] === null) continue
    const numeric = Number(raw[key])
    return Number.isFinite(numeric) ? numeric : Number.NaN
  }
  return undefined
}

function canonicalType(value) {
  const text = trimmedString(value).toLowerCase()
  if (!text) return ''
  return SOURCE_TYPE_ALIASES[text] ?? text
}

function isCanonicalField(key) {
  return FIELDS.includes(key) || VERSION_KEYS.includes(key)
}

function isTimestamp(value) {
  return typeof value === 'string' && ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value))
}

/**
 * Normalise a v1 or v2 source row into the canonical v2 shape.
 *
 * Legacy mapping (documented in docs/SOURCE-SCHEMA.md):
 *   - email -> mail;
 *   - sessionId (+ turnId) -> ref 'sessionId#turnId'; turnId alone -> 'legacy#turnId';
 *   - calendar uid -> ref when no ref is present;
 *   - speakers[] -> speaker (first non-empty);
 *   - file is reduced to its basename (the schema never stores directories).
 *
 * Unknown fields (e.g. the imap channel / mail from) are preserved as
 * extensions so older readers and later migrations do not lose information.
 * The function never throws: non-object input returns null.
 *
 * @param {object|null|undefined} raw stored or freshly built source object
 * @returns {object|null} canonical v2 source, or null when input is not an object
 */
export function normalizeSource(raw) {
  if (!isPlainObject(raw)) return null
  const out = { sourceVersion: SOURCE_VERSION }

  const consumed = new Set()
  const type = canonicalType(raw.type)
  out.type = type || 'conversation'

  const quote = typeof raw.quote === 'string' ? raw.quote : ''
  if (quote) out.quote = quote

  let ref = trimmedString(raw.ref)
  if (!ref) {
    const sessionId = trimmedString(raw.sessionId)
    const turnId = trimmedString(raw.turnId)
    if (sessionId) {
      ref = turnId ? sessionId + '#' + turnId : sessionId
      consumed.add('sessionId').add('turnId')
    } else if (turnId) {
      ref = 'legacy#' + turnId
      consumed.add('turnId')
    }
  }
  if (!ref && out.type === 'calendar') {
    ref = trimmedString(raw.uid)
    if (ref) consumed.add('uid')
  }
  if (ref) out.ref = ref

  for (const field of ['messageId', 'subject']) {
    const value = trimmedString(raw[field])
    if (value) out[field] = value
  }

  const file = basename(raw.file)
  if (file) out.file = file

  const mime = trimmedString(raw.mime).toLowerCase()
  if (mime) out.mime = mime

  let speaker = trimmedString(raw.speaker)
  if (!speaker && Array.isArray(raw.speakers)) {
    speaker = raw.speakers.map((item) => trimmedString(item)).find(Boolean) ?? ''
    if (speaker) consumed.add('speakers')
  }
  if (speaker) out.speaker = speaker

  for (const field of ['tStart', 'tEnd', 'capturedAt']) {
    const value = trimmedString(raw[field])
    if (value) out[field] = value
  }

  // Forward/backward compatibility: keep fields this version does not know so
  // that rendering older rows never silently drops provenance.
  for (const key of Object.keys(raw)) {
    if (isCanonicalField(key) || consumed.has(key)) continue
    if (raw[key] === undefined) continue
    out[key] = raw[key]
  }
  return out
}

/**
 * Validate a stored or freshly built source object against schema v2.
 *
 * Errors mean the row must not be written as a v2 source; warnings mean a
 * legacy/unknown value was tolerated. Returns the normalised object so callers
 * can validate and normalise in one pass.
 *
 * @param {unknown} raw source object (v1 or v2 shape)
 * @returns {{ ok: boolean, errors: string[], warnings: string[], source: object|null }}
 */
export function validateSource(raw) {
  const errors = []
  const warnings = []
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['source must be an object'], warnings, source: null }
  }

  const version = readVersion(raw)
  if (version !== undefined) {
    if (Number.isNaN(version)) {
      errors.push('sourceVersion must be numeric')
    } else if (version !== 1 && version !== SOURCE_VERSION) {
      warnings.push('unknown sourceVersion ' + version + '; normalised as v2')
    }
  }

  const legacyMarkers = ['sessionId', 'turnId', 'uid', 'speakers'].filter((key) => raw[key] !== undefined && raw[key] !== null && raw[key] !== '')
  if (version === 1 || (version === undefined && legacyMarkers.length > 0)) {
    warnings.push('legacy v1 source mapped to v2')
  }

  for (const field of FIELDS) {
    if (field === 'type') continue // handled below (aliases allowed)
    if (raw[field] === undefined || raw[field] === null) continue
    if (typeof raw[field] !== 'string') errors.push(field + ' must be a string')
  }

  const normalized = normalizeSource(raw)
  if (!normalized) {
    return { ok: false, errors: ['source must be an object'], warnings, source: null }
  }

  if (raw.type !== undefined && raw.type !== null) {
    if (typeof raw.type !== 'string') {
      errors.push('type must be a string')
    } else if (!canonicalType(raw.type)) {
      errors.push('type must not be empty')
    } else if (!SOURCE_TYPES.includes(canonicalType(raw.type))) {
      warnings.push('unknown source type "' + canonicalType(raw.type) + '" kept as-is')
    }
  }
  if (raw.type === undefined || raw.type === null) {
    warnings.push('missing source type; defaulted to conversation')
  }

  if (raw.file !== undefined && typeof raw.file === 'string' && hasPathSeparator(raw.file)) {
    errors.push('file must be a basename, not a path')
  }
  for (const field of ['docId', 'pageId', 'url', 'tool']) {
    if (raw[field] === undefined || raw[field] === null) continue
    if (typeof raw[field] !== 'string' || !raw[field].trim()) errors.push(field + ' must be a non-empty string')
  }
  if (raw.chunkIndex !== undefined && raw.chunkIndex !== null) {
    if (!Number.isInteger(raw.chunkIndex) || raw.chunkIndex < 0) errors.push('chunkIndex must be a non-negative integer')
  }
  if (raw.retained !== undefined && raw.retained !== null && typeof raw.retained !== 'boolean') {
    errors.push('retained must be a boolean')
  }
  if (raw.derivedFrom !== undefined && raw.derivedFrom !== null) {
    if (!Array.isArray(raw.derivedFrom)) errors.push('derivedFrom must be an array of strings')
    else if (raw.derivedFrom.some((item) => typeof item !== 'string' || !item.trim())) {
      errors.push('derivedFrom entries must be non-empty strings')
    }
  }
  if (raw.mime !== undefined && typeof raw.mime === 'string' && raw.mime.trim() && !MIME_TYPE.test(raw.mime.trim())) {
    errors.push('mime must look like type/subtype')
  }

  for (const field of ['tStart', 'tEnd', 'capturedAt']) {
    if (raw[field] === undefined || raw[field] === null) continue
    if (typeof raw[field] !== 'string') continue // already reported above
    if (!isTimestamp(raw[field])) {
      errors.push(field + ' must be an ISO 8601 date or datetime')
      continue
    }
    if (field === 'capturedAt' && Date.parse(raw[field]) > Date.now() + 24 * 60 * 60 * 1000) {
      warnings.push('capturedAt is in the future')
    }
  }
  if (isTimestamp(raw.tStart) && isTimestamp(raw.tEnd)) {
    if (Date.parse(raw.tStart) > Date.parse(raw.tEnd)) errors.push('tStart must not be after tEnd')
  }

  const hasPointer = Boolean(
    normalized.ref ||
      normalized.messageId ||
      normalized.file ||
      normalized.docId ||
      normalized.pageId ||
      normalized.url ||
      (normalized.turnId && normalized.tool),
  )
  const hasQuote = typeof normalized.quote === 'string' && normalized.quote.length > 0
  if (!hasPointer && !hasQuote) {
    errors.push('source has neither a pointer (ref/messageId/file) nor a quote')
  }

  return { ok: errors.length === 0, errors, warnings, source: normalized }
}

/** Canonical (lower-cased, alias-mapped) source type value, or '' when absent. */
export function canonicalSourceType(value) {
  return canonicalType(value)
}

/** Canonical (lower-cased, alias-mapped) source type, or '' when absent. */
export function sourceTypeOf(raw) {
  if (!isPlainObject(raw)) return ''
  const direct = canonicalType(raw.type)
  if (direct) return direct
  return ''
}

/**
 * JSON-ready pointer description used by the evidence resolver.
 *
 * Normalises a v1/v2/typed source (or a legacy commitment evidence item that
 * carries sessionId/turnId) and returns only the fields needed to resolve it:
 * {type, quote, ref, messageId, subject, docId, pageId, chunkIndex, url, tool,
 *  retained, derivedFrom}. Missing fields are omitted; unknown input -> null.
 * It never invents a ref and never reads a database.
 */
export function describeSourcePointer(raw) {
  const normalized = normalizeSource(raw)
  if (!normalized) return null
  const pointer = { type: normalized.type }
  for (const field of ['quote', 'ref', 'messageId', 'subject', 'docId', 'pageId', 'chunkIndex', 'url', 'tool', 'retained', 'derivedFrom']) {
    if (normalized[field] !== undefined && normalized[field] !== null && normalized[field] !== '') pointer[field] = normalized[field]
  }
  return pointer
}

/** True when a row already carries the v2 version marker. */
export function isSourceV2(raw) {
  if (!isPlainObject(raw)) return false
  return readVersion(raw) === SOURCE_VERSION
}

/**
 * Lossy v1 view for consumers that have not migrated yet.
 *
 * v1 never had mime/speaker/tStart/tEnd or the version marker, so those are
 * dropped; a calendar ref becomes the legacy uid and a transcript speaker
 * becomes the legacy speakers[] array. Use this only at a compatibility
 * boundary; writing new rows should use normalizeSource().
 *
 * @param {object|null|undefined} source v1 or v2 source object
 * @returns {object|null} v1-shaped source, or null for non-object input
 */
export function toLegacySource(source) {
  const normalized = normalizeSource(source)
  if (!normalized) return null
  const legacy = { type: normalized.type }
  for (const field of ['quote', 'ref', 'messageId', 'subject', 'file', 'capturedAt']) {
    if (normalized[field] !== undefined) legacy[field] = normalized[field]
  }
  if (normalized.type === 'calendar' && normalized.ref) legacy.uid = normalized.ref
  if (normalized.speaker) legacy.speakers = [normalized.speaker]
  for (const key of Object.keys(normalized)) {
    if (['sourceVersion'].includes(key)) continue
    if (['type', 'quote', 'ref', 'messageId', 'subject', 'file', 'capturedAt', 'mime', 'speaker', 'tStart', 'tEnd'].includes(key)) continue
    if (key === 'uid' || key === 'speakers') continue
    legacy[key] = normalized[key]
  }
  return legacy
}
