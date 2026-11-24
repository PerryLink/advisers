/**
 * Portable home bundle v1 (Advisers 0.5.0, plan 121/126 WF1 050-B1/B2).
 *
 * A bundle is a plaintext directory that carries a whole local Advisers home
 * so it can be moved to another machine (or opened after the vendor stops
 * maintaining the product) and imported into a clean home:
 *
 *   manifest.json   format/version/scope/schemaVersion/counts/dataDigest/files
 *   ledger.json     authoritative data (export --all compatible payload subset)
 *   facts.md        human-readable projection (never imported)
 *   kb/<id>.md      human-readable projection of kb_documents/kb_chunks
 *   pages/<id>.md   human-readable projection of the derived kb_pages table
 *   IMPORT.md       fixed human instructions (what this is, how to import/verify)
 *   FORMAT.md       format contract: layout, table/column dictionary, dataDigest
 *                   algorithm and minimal reader pseudocode (0.5.1; covered by
 *                   SHA256SUMS but OPTIONAL so 0.5.0 bundles stay readable)
 *   SHA256SUMS      coreutils-style sha256 of every other file in the directory
 *
 * dataDigest v1 (the portability acceptance metric):
 *   domain  = DATA_TABLES minus audit minus kb_pages (BUNDLE_DATA_TABLES, sorted)
 *   digest  = sha256(JSON.stringify(canonicalize({
 *               version: 1,
 *               tables: [{ name, rows, data } ... sorted by name],
 *             })))
 *   - each data array keeps the store row order (sqlite rowid order);
 *   - object keys are canonicalized (sorted) so schema column order is not
 *     part of the metric;
 *   - generatedAt/exportedAt (time fields) are NOT part of the digest, so two
 *     exports of the same home differ only in the time fields;
 *   - audit and kb_pages are excluded because the local audit hash chain is
 *     keyed by this HOME's audit.key (only sourceAudit count/headHash travels)
 *     and kb_pages is a deterministic projection rebuilt on import;
 *   - counts are rows per domain table and are authoritative next to the digest.
 *
 * verificationBasis is 'local-checksums-only': SHA-256 proves that the files of
 * the bundle are internally consistent and detect edits made after generation.
 * It is not a signature, not a trusted timestamp and not notarization: whoever
 * can rewrite the whole directory can recompute the checksums.
 *
 * Library-only: no bin/ wiring, no schema change, no new runtime dependency and
 * no network call. Temporary HOME fixtures in tests; the real home is never
 * touched unless the caller passes it explicitly.
 */
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { readAuditHead } from './audit-anchor.js'
import { createManagedBackup } from './backup.js'
import { parseClientPackSums } from './client-pack.js'
import { mkdirWithRetrySync, renameWithRetrySync, rmWithRetrySync } from './fs-safe.js'
import { kbPageRebuild } from './kb-pages.js'
import { DATA_TABLES, SCHEMA_VERSION, SqliteStore, entityError, openReadStore } from './sqlite.js'
import { inspectLocalLedger } from './sync.js'

const LF = String.fromCharCode(10)
const BS = String.fromCharCode(92)
const CR = String.fromCharCode(13)

export const BUNDLE_MANIFEST_FORMAT = 'advisers-bundle'
export const BUNDLE_MANIFEST_VERSION = 1
export const BUNDLE_SCOPE = 'local-all'
export const BUNDLE_VERIFICATION_BASIS = 'local-checksums-only'

export const BUNDLE_MANIFEST_FILE = 'manifest.json'
export const BUNDLE_LEDGER_FILE = 'ledger.json'
export const BUNDLE_IMPORT_FILE = 'IMPORT.md'
export const BUNDLE_FORMAT_FILE = 'FORMAT.md'
export const BUNDLE_SHA256SUMS_FILE = 'SHA256SUMS'
export const BUNDLE_FACTS_FILE = 'facts.md'
export const BUNDLE_KB_DIR = 'kb'
export const BUNDLE_PAGES_DIR = 'pages'

/**
 * Files every bundle v1 must contain (SHA256SUMS is implied by the layout).
 * FORMAT.md is deliberately not required: it was added in 0.5.1 and a 0.5.0
 * bundle without it must keep verifying/importing (backward compatibility).
 */
export const BUNDLE_REQUIRED_FILES = Object.freeze([
  BUNDLE_MANIFEST_FILE, BUNDLE_LEDGER_FILE, BUNDLE_IMPORT_FILE, BUNDLE_FACTS_FILE,
])

export const BUNDLE_FILE_MODE = 0o600
export const BUNDLE_DIR_MODE = 0o700

export const BUNDLE_LIMIT_CODE = 'E_BUNDLE_LIMIT'

/** Stable error codes used by this module (registered in lib/error-codes.js separately). */
export const BUNDLE_ERROR_CODES = Object.freeze({
  INVALID: 'E_BUNDLE_INVALID',
  TAMPERED: 'E_BUNDLE_TAMPERED',
  DIGEST_MISMATCH: 'E_BUNDLE_TAMPERED',
  LIMIT: BUNDLE_LIMIT_CODE,
  PASSPHRASE: 'E_BUNDLE_PASSPHRASE',
  TARGET: 'E_BUNDLE_TARGET',
  SQLITE_REQUIRED: 'E_BUNDLE_SQLITE_REQUIRED',
  IMPORT_BACKUP: 'E_BUNDLE_IMPORT_BACKUP',
})

export const BUNDLE_ERROR_HINTS = Object.freeze({
  E_BUNDLE_INVALID: 'the directory is not a well-formed Advisers bundle v1; nothing was imported',
  E_BUNDLE_TAMPERED: 'the bundle does not match its own SHA256SUMS/dataDigest, or it is not the bundle you expected (expectDataDigest mismatch); re-export it from the source home and compare digests instead of editing it',
  E_BUNDLE_LIMIT: 'the bundle exceeds a v1 resource limit; refusing to read a directory that could exhaust memory or time',
  E_BUNDLE_PASSPHRASE: 'bundle v1 is plaintext-only in 0.5.0; encrypted bundles (B3) are a later-version opt-in',
  E_BUNDLE_TARGET: 'the target directory or local database is not safe for this operation; nothing was changed',
  E_BUNDLE_SQLITE_REQUIRED: 'bundle export/import needs the SQLite store (sqlite mode); the JSON store has no SQLite-only tables to carry',
  E_BUNDLE_IMPORT_BACKUP: 'the pre-import managed backup could not be created; the local database was left untouched (fail closed)',
})

export function describeBundleCode(code) {
  return BUNDLE_ERROR_HINTS[code] ?? ('bundle operation failed: ' + String(code ?? 'unknown error'))
}

/** Tables whose audit row chain is machine-local and therefore never travels. */
export const BUNDLE_EXCLUDED_TABLES = Object.freeze(['audit', 'kb_pages'])

/**
 * The dataDigest domain: DATA_TABLES minus audit minus kb_pages, sorted.
 * Order is part of the contract (the manifest lists the same order in tables[]).
 */
export const BUNDLE_DATA_TABLES = Object.freeze(
  DATA_TABLES.filter((table) => !BUNDLE_EXCLUDED_TABLES.includes(table)).slice().sort(),
)

/**
 * Tables added to the bundle dataDigest domain by a later schema version.
 * Key = schema version that introduced the table(s), value = the table names.
 *
 * A 0.5.0 bundle was written by schema v22 (20 data tables); v23 adds the three
 * handoff/waiting tables. Accepting a v22 bundle into a v23 home must not
 * weaken the CURRENT domain: the legacy bundle has to list exactly the legacy
 * domain for its own schemaVersion, and its dataDigest is computed over that
 * domain. Unknown/older versions are handled by removing every addition newer
 * than the recorded schemaVersion (no bundle v1 shipped before v22).
 */
export const BUNDLE_TABLE_ADDITIONS = Object.freeze({
  23: Object.freeze(['handoff_claims', 'handoffs', 'waiting_replies']),
})

/** The exact dataDigest domain a bundle with this schemaVersion must carry. */
export function bundleDataTablesForSchema(schemaVersion) {
  if (!Number.isInteger(schemaVersion)) return [...BUNDLE_DATA_TABLES]
  const tables = new Set(BUNDLE_DATA_TABLES)
  for (const [versionText, added] of Object.entries(BUNDLE_TABLE_ADDITIONS)) {
    if (Number(versionText) > schemaVersion) {
      for (const table of added) tables.delete(table)
    }
  }
  return [...tables].sort()
}

/** What deliberately does not travel with a bundle (advisory, into the manifest). */
export const BUNDLE_EXCLUDED = Object.freeze([
  'audit',
  'kb_pages',
  'mail_cursors',
  'kb_fts',
  'kb_pages_fts',
  'credentials',
  'audit.key',
  'audit-anchor.json',
  'scheduler',
  'logs',
  'briefs',
  'soul',
  'workspace',
  'sync.state.json',
  'undo',
  'exports',
  'receipts',
])

export const BUNDLE_LIMIT_DEFAULTS = Object.freeze({
  maxEntries: 4096,
  maxDepth: 4,
  maxFileBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxSumsBytes: 2 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxLedgerBytes: 512 * 1024 * 1024,
  maxImportBytes: 1024 * 1024,
  maxFormatBytes: 1024 * 1024,
  maxFactsBytes: 8 * 1024 * 1024,
})

const LIMIT_LABELS = Object.freeze({
  maxEntries: 'entry count',
  maxDepth: 'directory depth',
  maxFileBytes: 'single file size',
  maxTotalBytes: 'total size',
  maxSumsBytes: 'SHA256SUMS size',
  maxManifestBytes: 'manifest.json size',
  maxLedgerBytes: 'ledger.json size',
  maxImportBytes: 'IMPORT.md size',
  maxFormatBytes: 'FORMAT.md size',
  maxFactsBytes: 'facts.md size',
})

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

const BUNDLE_LAYOUT_TOP_LEVEL = new Set([
  BUNDLE_MANIFEST_FILE, BUNDLE_LEDGER_FILE, BUNDLE_IMPORT_FILE, BUNDLE_FORMAT_FILE, BUNDLE_SHA256SUMS_FILE, BUNDLE_FACTS_FILE,
])

const MAX_BUNDLE_PATH_CHARS = 120

/* small helpers                                                              */

function bundleError(code, message, hint) {
  return entityError(code, message, hint)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function addError(errors, message) {
  if (errors.length < 300) errors.push(message)
  else if (errors.length === 300) errors.push('... too many errors; further details suppressed')
}

function isHexLower(value) {
  if (typeof value !== 'string' || value.length !== 64) return false
  for (let index = 0; index < 64; index += 1) {
    const code = value.charCodeAt(index)
    if ((code >= 48 && code <= 57) || (code >= 97 && code <= 102)) continue
    return false
  }
  return true
}

function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isDateText(value) {
  if (typeof value !== 'string' || !value) return false
  return Number.isFinite(Date.parse(value))
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

function toBuffer(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle file content must be a string, Buffer or Uint8Array')
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

function normalizeLimits(input) {
  const limits = { ...BUNDLE_LIMIT_DEFAULTS }
  if (!isPlainObject(input)) return limits
  for (const key of Object.keys(BUNDLE_LIMIT_DEFAULTS)) {
    if (!(key in input)) continue
    const value = Number(input[key])
    if (Number.isFinite(value) && value >= 0) limits[key] = Math.floor(value)
  }
  return limits
}

function makeViolation(limits, limit, actual, file) {
  return { code: BUNDLE_LIMIT_CODE, limit, max: limits[limit], actual, file: file ?? null }
}

function limitMessage(violation) {
  const label = LIMIT_LABELS[violation.limit] ?? violation.limit
  return BUNDLE_LIMIT_CODE + ': bundle ' + label + ' exceeded the limit ' + violation.max +
    ' (actual ' + violation.actual + (violation.file ? ', first at ' + violation.file : '') + '); refusing to read a directory that could exhaust memory or time.'
}

function advisersVersion(options) {
  const supplied = options?.env?.advisersVersion
  if (typeof supplied === 'string' && supplied) return supplied
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * Path fence for every relative path inside a bundle: forward-slash relative
 * paths only, no absolute/drive/backslash/traversal, no Windows reserved names
 * or trailing dot/space, no control characters and at most 120 characters. All
 * bundle paths are POSIX-style regardless of the host OS.
 */
export function isUnsafeBundlePath(name) {
  if (typeof name !== 'string' || !name) return true
  if (name.length > MAX_BUNDLE_PATH_CHARS) return true
  if (name.startsWith('/')) return true
  if (name.includes(BS)) return true
  const parts = name.split('/')
  if (parts.length > 4) return true
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return true
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index)
      if (code < 0x20 || code === 0x7f) return true
    }
    if (/[<>:\"|?*]/.test(part)) return true
    if (part.endsWith('.') || part.endsWith(' ')) return true
    const stem = part.split('.')[0].toUpperCase()
    if (WINDOWS_RESERVED_NAMES.has(stem)) return true
  }
  if (/^[A-Za-z]:$/.test(parts[0])) return true
  return false
}

/** v1 layout allowlist: five top-level names plus kb/ and pages/ children. */
export function isBundleLayoutPath(name) {
  if (typeof name !== 'string' || !name) return false
  if (BUNDLE_LAYOUT_TOP_LEVEL.has(name)) return true
  if (name.startsWith(BUNDLE_KB_DIR + '/') && name.length > BUNDLE_KB_DIR.length + 1) return true
  if (name.startsWith(BUNDLE_PAGES_DIR + '/') && name.length > BUNDLE_PAGES_DIR.length + 1) return true
  return false
}

function isInside(parent, child) {
  const base = resolve(parent)
  const target = resolve(child)
  return target === base || target.startsWith(base + sep)
}

/* -------------------------------------------------------------------------- */
/* dataDigest v1                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Compute dataDigest v1 + counts for one data object.
 *
 * `data` must be the full domain (BUNDLE_DATA_TABLES) mapping table -> raw rows
 * in store row order (sqlite rowid order). The result is a pure function of the
 * rows: generatedAt/exportedAt are not inputs and object keys are canonicalized.
 *
 * @returns {{dataDigest: string, tables: string[], counts: Record<string, number>}}
 */
export function computeBundleDataDigest(data, options = {}) {
  const tables = Array.isArray(options.tables) && options.tables.length ? [...options.tables] : [...BUNDLE_DATA_TABLES]
  if (!isPlainObject(data)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data must be an object mapping table -> rows')
  const counts = {}
  const payloadTables = []
  for (const table of tables) {
    const rows = data[table]
    if (!Array.isArray(rows)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.' + table + ' must be an array of rows')
    counts[table] = rows.length
    payloadTables.push({ name: table, rows: rows.length, data: rows })
  }
  const payload = { version: 1, tables: payloadTables }
  return { dataDigest: sha256Hex(JSON.stringify(canonicalize(payload))), tables: [...tables], counts }
}

/**
 * Same digest for a live SqliteStore (export acceptance: two exports of the
 * same home must report the same dataDigest/counts).
 */
export function dataDigestForStore(store) {
  const data = readDataTables(store)
  return computeBundleDataDigest(data)
}

/**
 * Read the digest domain from a store in a deterministic order.
 *
 * Values are the raw snake_case rows exportDataTables() has always written;
 * rows are ordered by sqlite rowid explicitly so the same home produces the
 * same digest on every run (an import inserts rows in that order, so the
 * post-import home yields the same order again).
 */
function readDataTables(store) {
  if (!store || typeof store !== 'object') {
    throw bundleError(BUNDLE_ERROR_CODES.SQLITE_REQUIRED, 'bundle export requires an open SqliteStore (or home/dbPath pointing at a SQLite database)')
  }
  const data = {}
  if (store.db && typeof store.db.prepare === 'function') {
    for (const table of BUNDLE_DATA_TABLES) {
      data[table] = store.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()
    }
    return data
  }
  if (typeof store.exportDataTables === 'function') {
    Object.assign(data, store.exportDataTables([...BUNDLE_DATA_TABLES]))
    return data
  }
  throw bundleError(BUNDLE_ERROR_CODES.SQLITE_REQUIRED, 'the provided store does not expose the SQLite tables (no db or exportDataTables())')
}

/** Audit summary that travels in ledger.json (count + chain head hash only). */
function readSourceAudit(store) {
  const warnings = []
  try {
    const head = readAuditHead(store, { verifyChain: false })
    if (head?.ok && isNonNegativeInteger(head.count)) {
      return { sourceAudit: { count: head.count, headHash: typeof head.headHash === 'string' ? head.headHash : '' }, warnings }
    }
    warnings.push('audit head unavailable for the bundle sourceAudit (' + String(head?.code ?? 'unknown') + '); the bundle records sourceAudit{count:null,headHash:null}')
  } catch (error) {
    warnings.push('audit head unavailable for the bundle sourceAudit: ' + String(error?.message ?? error).slice(0, 200))
  }
  return { sourceAudit: { count: null, headHash: null }, warnings }
}

/* -------------------------------------------------------------------------- */
/* human-readable projections (never imported)                                */
/* -------------------------------------------------------------------------- */

function projectionSafeId(id, label) {
  const name = String(id ?? '')
  if (!name || isUnsafeBundlePath(name)) {
    throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'cannot project ' + label + ' with an unsafe id: ' + JSON.stringify(name).slice(0, 80))
  }
  return name
}

function renderFactsMarkdown(facts) {
  const lines = [
    '# Facts',
    '',
    '> Human-readable projection. The authoritative copy is data.facts in ledger.json;',
    '> this file is never imported and its checksum only proves it was not edited',
    '> after the bundle was generated.',
    '',
    'Rows: ' + String(Array.isArray(facts) ? facts.length : 0),
    '',
  ]
  for (const fact of Array.isArray(facts) ? facts : []) {
    lines.push('## ' + String(fact?.subject ?? '') + ' · ' + String(fact?.predicate ?? ''))
    lines.push('')
    lines.push('- value: ' + String(fact?.object ?? ''))
    lines.push('- id: ' + String(fact?.id ?? ''))
    lines.push('- recordedAt: ' + String(fact?.recordedAt ?? ''))
    lines.push('- authority: ' + String(fact?.authority ?? '') + ' · confidence: ' + String(fact?.confidence ?? ''))
    lines.push('- status: ' + String(fact?.status ?? '') + (fact?.deletedAt ? ' · deletedAt: ' + String(fact.deletedAt) : ''))
    lines.push('')
  }
  return lines.join(LF) + LF
}

function renderKbDocumentMarkdown(doc, chunks) {
  const lines = [
    '# ' + String(doc.title ?? ''),
    '',
    '> Human-readable projection of one KB document. The authoritative metadata is',
    '> data.kb_documents in ledger.json; this file is never imported.',
    '',
    '- id: ' + String(doc.id ?? ''),
    '- kind: ' + String(doc.kind ?? ''),
    '- status: ' + String(doc.status ?? ''),
    '- source_name: ' + String(doc.source_name ?? ''),
    '- source_sha256: ' + String(doc.source_sha256 ?? ''),
    '- created_at: ' + String(doc.created_at ?? ''),
    '',
  ]
  const ordered = Array.isArray(chunks) ? [...chunks].sort((left, right) => Number(left.seq ?? 0) - Number(right.seq ?? 0)) : []
  for (const chunk of ordered) lines.push(String(chunk.text ?? ''))
  return lines.join(LF) + LF
}

function buildKbProjections(data) {
  const files = new Map()
  const docs = Array.isArray(data.kb_documents) ? data.kb_documents : []
  const chunksByDoc = new Map()
  for (const chunk of Array.isArray(data.kb_chunks) ? data.kb_chunks : []) {
    const key = String(chunk.doc_id ?? '')
    if (!chunksByDoc.has(key)) chunksByDoc.set(key, [])
    chunksByDoc.get(key).push(chunk)
  }
  for (const doc of docs) {
    const id = projectionSafeId(doc?.id, 'kb_document')
    files.set(BUNDLE_KB_DIR + '/' + id + '.md', Buffer.from(renderKbDocumentMarkdown(doc, chunksByDoc.get(String(doc.id)) ?? []), 'utf8'))
  }
  return files
}

function buildPagesProjections(store) {
  const files = new Map()
  if (!store?.db || typeof store.db.prepare !== 'function') return files
  let rows = []
  try {
    rows = store.db.prepare('SELECT id, markdown FROM kb_pages ORDER BY rowid').all()
  } catch {
    return files
  }
  for (const row of rows) {
    const id = projectionSafeId(row.id, 'kb_page')
    const markdown = String(row.markdown ?? '')
    files.set(BUNDLE_PAGES_DIR + '/' + id + '.md', Buffer.from(markdown.endsWith(LF) ? markdown : markdown + LF, 'utf8'))
  }
  return files
}

/* -------------------------------------------------------------------------- */
/* IMPORT.md (fixed template)                                                 */
/* -------------------------------------------------------------------------- */

function importMarkdownStaticLines() {
  return [
    'Advisers portable home bundle v' + BUNDLE_MANIFEST_VERSION,
    '===============================================',
    '',
    'This directory is a complete, plaintext export of one local Advisers home.',
    'It is designed for moving to another machine, restoring after a lost device,',
    'or keeping your own copy if the product is discontinued. Nothing here needs',
    'the original installation, an account or a network connection.',
    '',
  ]
}

function importMarkdownHeaderLines({ version, generatedAt, schemaVersion, dataDigest, fileCount, checksumCount, sourceAudit }) {
  return [
    'Format:        ' + BUNDLE_MANIFEST_FORMAT + ' v' + BUNDLE_MANIFEST_VERSION,
    'Scope:         ' + BUNDLE_SCOPE + ' (one whole home; no per-subject selection)',
    'Generated at:  ' + String(generatedAt),
    'Generator:     advisers ' + String(version ?? 'unknown'),
    'Schema:        v' + String(schemaVersion),
    'Verification:  ' + BUNDLE_VERIFICATION_BASIS,
    'Files:         ' + String(fileCount) + ' data file(s) + manifest.json; ' + String(checksumCount) + ' checksum(s)',
    'dataDigest:    ' + String(dataDigest),
    'sourceAudit:   count=' + String(sourceAudit?.count ?? 'unavailable') + ' head=' + String(sourceAudit?.headHash ?? 'unavailable'),
    '',
  ]
}

function importMarkdownBodyLines() {
  return [
    'Contents',
    '--------',
    'manifest.json   format/version/schemaVersion/counts/dataDigest/tables/files',
    'ledger.json     AUTHORITATIVE data: ledger snapshot + data tables (JSON)',
    'FORMAT.md       format contract: layout, table/column dictionary, dataDigest algorithm, reader pseudocode',
    'facts.md        human-readable fact projection (never imported)',
    'kb/*.md         human-readable KB document projections (never imported)',
    'pages/*.md      human-readable KB page projections (never imported; pages are rebuilt on import)',
    'IMPORT.md       this file',
    'SHA256SUMS      sha256 of every other file in this directory',
    '',
  ]
}

function importMarkdownHowToLines() {
  return [
    'How to import (clean machine; use a fresh ADVISERS_HOME)',
    '------------------------------------------------------',
    '1. Install Advisers 0.5.0 or newer.',
    '2. Verify first (reads only, writes nothing):',
    '   advisers import --bundle <this directory> --verify --dry-run --json',
    '3. Import (a pre-import managed backup is created automatically when a',
    '   local database already exists; a new empty home is bootstrapped):',
    '   ADVISERS_ACCEPT_TOS=1 advisers import --bundle <this directory> --verify --json',
    '4. Run `advisers doctor --check-db --json`.',
    '5. Run `advisers export --bundle <new directory> --json` and compare that',
    '   dataDigest/counts with this manifest: they must be equal.',
    '',
    'Verify without Advisers',
    '----------------------',
    'The local database is not opened and no network is used:',
    '  Linux/macOS:  sha256sum -c SHA256SUMS',
    '  Windows:      Get-FileHash -Algorithm SHA256 <file> (compare with SHA256SUMS)',
    'or re-run `advisers import --bundle <this directory> --verify --dry-run --json`.',
    '',
  ]
}

function importMarkdownRulesLines() {
  return [
    'Import rules',
    '------------',
    '- Only ledger.json is imported. The Markdown files are human projections and',
    '  are never read back; a hand-edited projection only breaks verification.',
    '- kb_pages and the FTS search indexes are NOT in the bundle: they are',
    '  deterministic projections rebuilt from kb_documents/kb_chunks on import.',
    '- The local audit hash chain is NOT replaced (it is HMAC-keyed by the target',
    '  home). Only sourceAudit{count,headHash} of the source home is recorded.',
    '- credentials, audit.key, audit-anchor.json, scheduler work, logs, briefs,',
    '  soul, workspace, sync.state.json, undo, exports and receipts never leave',
    '  the source home and are never part of a bundle.',
    '',
  ]
}

function importMarkdownBoundaryLines() {
  return [
    'Boundary of the checksums',
    '-------------------------',
    'SHA-256 here proves that this directory is internally consistent and that it',
    'was not edited after generation. It is NOT a signature, NOT a trusted',
    'timestamp and NOT notarization: anyone able to rewrite the whole directory',
    'can recompute all checksums. Do not treat verification as proof of who',
    'generated the bundle or when.',
    '',
    'Privacy warning',
    '---------------',
    'This bundle is PLAINTEXT. It contains customer records, mail bodies, money',
    'amounts and other personal data from the source home. Store it on an',
    'encrypted disk, do not put it in a shared or synced folder that other',
    'people can read, and delete copies you no longer need. Encryption',
    '(--encrypted) is not part of bundle v1 in 0.5.0.',
    '',
    'If Advisers is discontinued',
    '---------------------------',
    'ledger.json is a documented JSON document (Advisers ledger snapshot v1 plus',
    'raw data tables). It contains no executable scripts; FORMAT.md in this',
    'directory describes the layout, every table and column, the dataDigest',
    'algorithm and a minimal reader pseudocode, so a future reader needs only a',
    'JSON parser to recover the data. (FORMAT.md was added in 0.5.1; a 0.5.0',
    'bundle has no FORMAT.md but stays readable by newer readers.)',
  ]
}

function renderImportMarkdown({ version, generatedAt, schemaVersion, counts, dataDigest, fileCount, checksumCount, sourceAudit }) {
  const countLines = Object.keys(isPlainObject(counts) ? counts : {}).sort().map((key) => '  ' + key + ': ' + String(counts[key]))
  return [
    ...importMarkdownStaticLines(),
    ...importMarkdownHeaderLines({ version, generatedAt, schemaVersion, dataDigest, fileCount, checksumCount, sourceAudit }),
    ...importMarkdownBodyLines(),
    'Rows per table (authoritative: manifest.json counts)',
    '--------------------------------------------------',
    ...(countLines.length ? countLines : ['  (no data tables)']),
    '',
    ...importMarkdownHowToLines(),
    ...importMarkdownRulesLines(),
    ...importMarkdownBoundaryLines(),
  ].join(LF) + LF
}

/* -------------------------------------------------------------------------- */
/* FORMAT.md (in-bundle format contract; added in 0.5.1)                       */
/* -------------------------------------------------------------------------- */

/**
 * Table/column dictionary for FORMAT.md. PRAGMA table_info is the schema source
 * when the build store can answer it; a row-derived union is the fallback so a
 * format document is always emitted (it never throws over metadata).
 */
function describeBundleTables(store, data) {
  const tables = []
  for (const table of BUNDLE_DATA_TABLES) {
    const rows = Array.isArray(data[table]) ? data[table] : []
    let columns = null
    try {
      if (store?.db && typeof store.db.prepare === 'function') columns = bundleTableColumns(store, table)
    } catch { columns = null }
    if (!Array.isArray(columns) || columns.length === 0) {
      const names = new Set()
      for (const row of rows) {
        if (!isPlainObject(row)) continue
        for (const key of Object.keys(row)) names.add(key)
      }
      columns = [...names].sort().map((name) => ({ name, type: null, notnull: null, hasDefault: null, pk: null }))
    }
    tables.push({ name: table, rows: rows.length, columns })
  }
  return tables
}

function formatColumnLine(column) {
  const flags = []
  if (typeof column.type === 'string' && column.type) flags.push(column.type)
  if (column.pk === true) flags.push('primary key')
  if (column.notnull === true) flags.push('not null')
  if (column.hasDefault === true) flags.push('has default')
  return '  - ' + String(column.name) + (flags.length ? ' (' + flags.join(', ') + ')' : '')
}

/** LedgerSnapshot v1 entity field dictionary: union of the keys present in this export. */
function describeLedgerEntities(ledger) {
  const entities = ['matters', 'facts', 'commitments', 'preferences', 'links', 'updates', 'routines', 'routinePatches']
  const described = []
  for (const name of entities) {
    const rows = Array.isArray(ledger?.[name]) ? ledger[name] : []
    const fields = new Set()
    for (const row of rows) {
      if (!isPlainObject(row)) continue
      for (const key of Object.keys(row)) fields.add(key)
    }
    described.push({ name: name, rows: rows.length, fields: [...fields].sort() })
  }
  const routes = isPlainObject(ledger?.routes) ? Object.keys(ledger.routes).sort() : []
  return { entities: described, routes }
}

/**
 * Render FORMAT.md: the self-describing contract carried inside the bundle.
 *
 * It is a pure function of the schema/data/version inputs (no time field), so
 * two exports of the same home with the same generator version produce byte-
 * identical FORMAT.md - the acceptance metric stays dataDigest, not file bytes.
 * Nothing here is executable code.
 */
function renderFormatMarkdown({ version, schemaVersion, dataDigest, tables, counts, excluded, ledger }) {
  const lines = [
    '# Advisers portable home bundle - FORMAT v1',
    '',
    '> This file is the self-describing format contract of this directory. It is',
    '> covered by SHA256SUMS like every other file: editing it breaks verification.',
    '> The authoritative data is ledger.json; this document adds no fields.',
    '',
    'Generator:     advisers ' + String(version ?? 'unknown'),
    'Schema:        v' + String(schemaVersion),
    'dataDigest:    ' + String(dataDigest),
    'Verification:  ' + BUNDLE_VERIFICATION_BASIS,
    '',
    '## 1. Layout (bundle v1)',
    '',
    '| path | contents | imported? |',
    '| --- | --- | --- |',
    '| manifest.json | format/version/scope/schemaVersion/counts/tables/dataDigest/files | metadata |',
    '| ledger.json | LedgerSnapshot v1 + raw data tables (JSON) | yes (authoritative) |',
    '| FORMAT.md | this format contract | no |',
    '| IMPORT.md | fixed human import/verify instructions | no |',
    '| facts.md | human-readable fact projection | no |',
    '| kb/<id>.md | one projection per kb_documents row | no |',
    '| pages/<id>.md | derived kb_pages projections (rebuilt on import) | no |',
    '| SHA256SUMS | sha256 of every other file (coreutils format) | verification only |',
    '',
    'The v1 layout is closed: any other file or subdirectory is refused. FORMAT.md',
    'is OPTIONAL in v1 because bundles written by Advisers 0.5.0 do not carry it; a',
    '0.5.0 reader does not know FORMAT.md and refuses a directory that has it.',
    '',
    '## 2. manifest.json (bundle v1)',
    '',
    '- format: "advisers-bundle"',
    '- version: 1',
    '- scope: "local-all" (one whole home; no per-subject selection)',
    '- subject: null',
    '- verificationBasis: "local-checksums-only"',
    '- generatedAt: ISO-8601 time field (NOT part of dataDigest)',
    '- generator: {advisersVersion, nodeVersion, command}',
    '- schemaVersion: source ledger schema number (see section 6)',
    '- counts: {table: rowCount} for exactly the tables listed in tables',
    '- tables: sorted dataDigest-domain table names (section 3)',
    '- dataDigest: 64 lowercase hex (section 3)',
    '- files: [{path, size, sha256}] every file except manifest.json and SHA256SUMS',
    '- fileCount: files.length; checksumCount: files.length + 1',
    '- excluded: tables/state that never travel with a bundle',
    '- disclaimer: true',
    '',
    '## 3. dataDigest v1',
    '',
    'The dataDigest domain is manifest.tables: the ledger data tables (DATA_TABLES',
    'minus the machine-local audit table and the derived kb_pages table), sorted.',
    '',
    '    payload = {',
    '      "version": 1,',
    '      "tables": [ { "name": <table>, "rows": <rowCount>, "data": [<row>, ...] } ... sorted by name ]',
    '    }',
    '    dataDigest = sha256(JSON.stringify(canonicalize(payload)))',
    '',
    'canonicalize() recursively sorts object keys; array order is preserved. Each',
    'data array keeps the SQLite rowid order of the source home; generatedAt and',
    'exportedAt are NOT inputs. counts per table are authoritative next to the',
    'digest. audit travels only as sourceAudit{count, headHash} (it is keyed by the',
    'source home audit.key); kb_pages is rebuilt on import and never digested.',
    '',
    '## 4. ledger.json',
    '',
    '    {',
    '      "version": <generator version string>,',
    '      "schemaVersion": <number>,',
    '      "exportedAt": <ISO-8601>,',
    '      "ledger": <LedgerSnapshot v1>,',
    '      "data": { <table>: [<raw snake_case row>, ...] },',
    '      "auditAnchor": null,',
    '      "sourceAudit": { "count": <number|null>, "headHash": <64 hex|null> }',
    '    }',
    '',
    'LedgerSnapshot v1 arrays: matters, facts, commitments, preferences, links,',
    'updates, routines, routinePatches; plus a routes object. The data tables are',
    'raw rows in source rowid order. sourceAudit describes the SOURCE home audit',
    'chain only; it is never imported into the target chain.',
    '',
  ]
  const ledgerDictionary = describeLedgerEntities(ledger)
  lines.push('LedgerSnapshot v1 field dictionary (union of keys present in this export):')
  lines.push('')
  for (const entity of ledgerDictionary.entities) {
    lines.push('- ' + entity.name + ' (' + entity.rows + ' row' + (entity.rows === 1 ? '' : 's') + ')')
    lines.push('  - fields: ' + (entity.fields.length ? entity.fields.join(', ') : '(none in this bundle)'))
  }
  lines.push('- routes')
  lines.push('  - fields: ' + (ledgerDictionary.routes.length ? ledgerDictionary.routes.join(', ') : '(none in this bundle)'))
  lines.push('')
  lines.push('## 5. Tables and columns (schema v' + String(schemaVersion) + ')')
  lines.push('')
  for (const table of tables) {
    lines.push('- ' + table.name + ' (' + table.rows + ' row' + (table.rows === 1 ? '' : 's') + ')')
    for (const column of table.columns) lines.push(formatColumnLine(column))
    lines.push('')
  }
  lines.push(
    'Row counts recorded in manifest.counts must equal the array lengths above.',
    'The column list is generated from PRAGMA table_info at export time; an import',
    'refuses a row with a column this reader does not know (a newer schema must not',
    'be applied silently) and fills columns missing from an older row with defaults.',
    '',
    '## 6. Version and forward policy',
    '',
    '- Bundle format v1 is frozen: a reader that knows v1 accepts every v1 bundle',
    '  (with or without FORMAT.md).',
    '- A reader MUST refuse schemaVersion newer than the schema it supports.',
    '- A reader SHOULD accept an older schemaVersion by taking column defaults for',
    '  missing columns (an older bundle is a migration input, not a new format).',
    '- A bundle declares its own dataDigest domain in manifest.tables for the',
    '  schemaVersion it was written with: a 0.5.0 (v22) bundle has 20 data tables;',
    '  v23 adds handoff_claims/handoffs/waiting_replies. Tables added after a',
    '  bundle\'s schemaVersion are imported EMPTY, and two bundles of different',
    '  schemas can be compared on the shared older table set.',
    '- An importer MUST refuse unknown columns in a data row instead of guessing.',
    '- Unknown extra files/directories are refused: the v1 layout is closed.',
    '- Checksums are local-checksums-only: they prove internal consistency, not',
    '  authorship, a trusted timestamp or notarization.',
    '',
    '## 7. Minimal reader pseudocode (not executable code)',
    '',
    '    manifest = parse_json(read("manifest.json"))',
    '    assert manifest.format == "advisers-bundle" and manifest.version == 1',
    '    for line in split_lines(read("SHA256SUMS")):',
    '        (digest, path) = parse_coreutils_line(line)',
    '        assert sha256(read(path)) == digest',
    '    assert set(manifest.files.path) == set(all files except manifest/SHA256SUMS)',
    '    payload = parse_json(read("ledger.json"))',
    '    assert payload.schemaVersion <= reader.supportedSchemaVersion',
    '    for table in manifest.tables:',
    '        rows = payload.data[table]',
    '        assert len(rows) == manifest.counts[table]',
    '    recompute dataDigest exactly as section 3',
    '    assert recomputed == manifest.dataDigest',
    '    import payload.ledger and payload.data tables (FORMAT.md/IMPORT.md/',
    '      facts.md/kb/*.md/pages/*.md are informational and never imported)',
    '',
    '## 8. Boundary',
    '',
    '- This directory is PLAINTEXT: it contains customer records, mail bodies and',
    '  money amounts from the source home. Store it on an encrypted disk and delete',
    '  copies you no longer need. Encryption is not part of bundle v1.',
    '- SHA-256 proves the directory is internally consistent and was not edited',
    '  after generation. It is NOT a signature, NOT a trusted timestamp and NOT',
    '  notarization: whoever can rewrite the whole directory can recompute it.',
    '- Nothing in this directory is executable. A reader needs only a JSON parser',
    '  and SHA-256.',
    '',
    'Never-travel list (excluded from every bundle): ' + excluded.join(', ') + '.',
  )
  return lines.join(LF) + LF
}

/* -------------------------------------------------------------------------- */
/* build                                                                      */
/* -------------------------------------------------------------------------- */

function normalizeGeneratedAt(value) {
  const text = value === undefined || value === null
    ? new Date().toISOString()
    : (value instanceof Date ? value.toISOString() : String(value))
  if (!isDateText(text)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'generatedAt must be an ISO date-time')
  return text
}

function bundleFailure(error, warnings = []) {
  const rawCode = typeof error?.code === 'string' ? error.code : null
  const code = rawCode && BUNDLE_ERROR_HINTS[rawCode] ? rawCode : BUNDLE_ERROR_CODES.INVALID
  return {
    ok: false,
    code,
    errors: [String(error?.message ?? error).slice(0, 600)],
    warnings,
    files: null,
    manifest: null,
  }
}

function enforceBuildLimits(fileContents, limits) {
  let totalBytes = 0
  if (fileContents.size > limits.maxEntries) throw bundleLimit('maxEntries', fileContents.size, null, limits)
  for (const [name, content] of fileContents) {
    if (isUnsafeBundlePath(name)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'refusing to write an unsafe bundle path: ' + JSON.stringify(name).slice(0, 120))
    if (!isBundleLayoutPath(name)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'refusing to write a path outside the bundle v1 layout: ' + name)
    const parts = name.split('/')
    if (parts.length > limits.maxDepth) throw bundleLimit('maxDepth', parts.length, name, limits)
    const bytes = toBuffer(content)
    if (bytes.length > limits.maxFileBytes) throw bundleLimit('maxFileBytes', bytes.length, name, limits)
    totalBytes += bytes.length
    if (totalBytes > limits.maxTotalBytes) throw bundleLimit('maxTotalBytes', totalBytes, name, limits)
  }
  return totalBytes
}

function bundleLimit(limit, actual, file, limits) {
  const violation = makeViolation(limits, limit, actual, file)
  return bundleError(BUNDLE_LIMIT_CODE, limitMessage(violation), 'bundle v1 limits: ' + JSON.stringify(BUNDLE_LIMIT_DEFAULTS))
}

function fileRecords(fileContents) {
  const records = []
  for (const name of [...fileContents.keys()].sort()) {
    if (name === BUNDLE_SHA256SUMS_FILE || name === BUNDLE_MANIFEST_FILE) continue
    const bytes = toBuffer(fileContents.get(name))
    records.push({ path: name, size: bytes.length, sha256: sha256Hex(bytes) })
  }
  return records
}

function buildSums(fileContents) {
  const names = [...fileContents.keys()].filter((name) => name !== BUNDLE_SHA256SUMS_FILE).sort()
  const lines = []
  for (const name of names) {
    if (isUnsafeBundlePath(name)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'unsafe bundle path while building SHA256SUMS: ' + name)
    lines.push(sha256Hex(toBuffer(fileContents.get(name))) + '  ' + name)
  }
  return lines.length ? lines.join(LF) + LF : ''
}

/**
 * Build the bundle file map in memory (no disk write, read-only on the store).
 *
 * @param {object} options
 * @param {object} [options.store] an open SqliteStore-like object (read-only is
 *        enough); when omitted, home/dbPath is opened read-only and closed.
 * @param {string|Date} [options.generatedAt] defaults to now (a time field only).
 * @param {{advisersVersion?: string}} [options.env] generator version override.
 * @param {boolean} [options.includeProjections=true] write kb/*.md and pages/*.md
 *        human projections (facts.md is always written: it is part of the layout).
 * @param {boolean} [options.includeFormat=true] write FORMAT.md (the in-bundle
 *        format contract). Readers treat it as optional so legacy 0.5.0 bundles
 *        stay verifiable; tests may pass false to model that legacy layout.
 * @returns {{ok:boolean, code:string|null, files:Map<string,Buffer>|null,
 *   manifest:object|null, manifestText?:string, manifestDigest?:string,
 *   summary?:object, errors:string[], warnings:string[]}}
 */
export function buildBundle(options = {}) {
  const warnings = []
  let store = options.store ?? null
  let ownedStore = null
  try {
    if (!store) {
      const home = options.home ? resolve(String(options.home)) : null
      const dbPath = options.dbPath ? resolve(String(options.dbPath)) : (home ? join(home, 'state.db') : null)
      if (!dbPath) return { ok: false, code: BUNDLE_ERROR_CODES.SQLITE_REQUIRED, errors: ['bundle export needs { store } or { home }/{ dbPath } pointing at a SQLite database'], warnings }
      if (!existsSync(dbPath)) {
        const jsonHint = home && existsSync(join(home, 'state.json')) ? ' (the home uses the JSON store: state.json)' : ''
        return { ok: false, code: BUNDLE_ERROR_CODES.SQLITE_REQUIRED, errors: ['no SQLite database at ' + dbPath + '; export --bundle requires the SQLite store' + jsonHint], warnings }
      }
      ownedStore = openReadStore(dbPath)
      store = ownedStore
    }
    const schemaVersion = typeof store.schemaVersion === 'function' ? store.schemaVersion() : null
    if (!Number.isInteger(schemaVersion)) return { ok: false, code: BUNDLE_ERROR_CODES.INVALID, errors: ['cannot read meta.schema_version from the source database; refusing to export an unversioned bundle'], warnings }
    if (schemaVersion > SCHEMA_VERSION) return { ok: false, code: BUNDLE_ERROR_CODES.INVALID, errors: ['source database schema v' + schemaVersion + ' is newer than this CLI (v' + SCHEMA_VERSION + '); upgrade advisers first'], warnings }
    if (schemaVersion < SCHEMA_VERSION) return { ok: false, code: BUNDLE_ERROR_CODES.INVALID, errors: ['source database schema v' + schemaVersion + ' is older than the current v' + SCHEMA_VERSION + '; run advisers doctor (or any write command) to migrate it before exporting'], warnings }
    const generatedAt = normalizeGeneratedAt(options.generatedAt)
    const version = advisersVersion(options) ?? 'unknown'
    const limits = normalizeLimits(options.limits)
    const includeProjections = options.includeProjections !== false
    const data = readDataTables(store)
    const ledger = typeof store.load === 'function' ? store.load() : null
    if (!isPlainObject(ledger) || !Array.isArray(ledger.matters)) return { ok: false, code: BUNDLE_ERROR_CODES.INVALID, errors: ['the store did not return a ledger snapshot (store.load() is required for a bundle)'], warnings }
    const audit = readSourceAudit(store)
    for (const warning of audit.warnings) warnings.push(warning)
    const digest = computeBundleDataDigest(data)
    const ledgerPayload = {
      version,
      schemaVersion,
      exportedAt: generatedAt,
      ledger,
      data,
      auditAnchor: null,
      sourceAudit: audit.sourceAudit,
    }
    const fileContents = new Map()
    fileContents.set(BUNDLE_LEDGER_FILE, Buffer.from(JSON.stringify(ledgerPayload, null, 2) + LF, 'utf8'))
    fileContents.set(BUNDLE_FACTS_FILE, Buffer.from(renderFactsMarkdown(ledger.facts), 'utf8'))
    if (includeProjections) {
      for (const [name, buffer] of buildKbProjections(data)) fileContents.set(name, buffer)
      for (const [name, buffer] of buildPagesProjections(store)) fileContents.set(name, buffer)
    }
    enforceBuildLimits(fileContents, limits)
    // 0.5.1: FORMAT.md carries the format contract inside the bundle. It is
    // optional on read (0.5.0 bundles have none) but written by default; tests
    // that need to model a legacy 0.5.0 layout pass includeFormat:false.
    const includeFormat = options.includeFormat !== false
    const fileCount = fileContents.size + (includeFormat ? 2 : 1)
    const checksumCount = fileCount + 1
    if (includeFormat) {
      fileContents.set(BUNDLE_FORMAT_FILE, Buffer.from(renderFormatMarkdown({
        version, schemaVersion, dataDigest: digest.dataDigest, counts: digest.counts, ledger,
        tables: describeBundleTables(store, data), excluded: [...BUNDLE_EXCLUDED],
      }), 'utf8'))
    }
    fileContents.set(BUNDLE_IMPORT_FILE, Buffer.from(renderImportMarkdown({
      version, generatedAt, schemaVersion, counts: digest.counts, dataDigest: digest.dataDigest,
      fileCount, checksumCount, sourceAudit: audit.sourceAudit,
    }), 'utf8'))
    const dataFiles = fileRecords(fileContents)
    const manifest = {
      format: BUNDLE_MANIFEST_FORMAT,
      version: BUNDLE_MANIFEST_VERSION,
      verificationBasis: BUNDLE_VERIFICATION_BASIS,
      scope: BUNDLE_SCOPE,
      subject: null,
      generatedAt,
      generator: {
        advisersVersion: version,
        nodeVersion: process.version,
        command: 'export --bundle',
      },
      schemaVersion,
      counts: digest.counts,
      tables: digest.tables,
      dataDigest: digest.dataDigest,
      files: dataFiles,
      fileCount: dataFiles.length,
      checksumCount: dataFiles.length + 1,
      excluded: [...BUNDLE_EXCLUDED],
      disclaimer: true,
    }
    const manifestText = stableStringify(manifest)
    fileContents.set(BUNDLE_MANIFEST_FILE, Buffer.from(manifestText, 'utf8'))
    fileContents.set(BUNDLE_SHA256SUMS_FILE, Buffer.from(buildSums(fileContents), 'utf8'))
    const totalBytes = enforceBuildLimits(fileContents, limits)
    return {
      ok: true,
      code: null,
      files: fileContents,
      manifest,
      manifestText,
      manifestDigest: sha256Hex(manifestText),
      summary: {
        format: BUNDLE_MANIFEST_FORMAT,
        version: BUNDLE_MANIFEST_VERSION,
        scope: BUNDLE_SCOPE,
        subject: null,
        verificationBasis: BUNDLE_VERIFICATION_BASIS,
        generatedAt,
        generator: manifest.generator,
        schemaVersion,
        counts: digest.counts,
        tables: digest.tables,
        dataDigest: digest.dataDigest,
        sourceAudit: audit.sourceAudit,
        fileCount: dataFiles.length,
        checksumCount: dataFiles.length + 1,
        bytes: totalBytes,
        files: dataFiles.map((record) => ({ path: record.path, size: record.size, sha256: record.sha256 })),
        excluded: [...BUNDLE_EXCLUDED],
      },
      errors: [],
      warnings,
    }
  } catch (error) {
    return bundleFailure(error, warnings)
  } finally {
    if (ownedStore) { try { ownedStore.close() } catch {} }
  }
}

/* -------------------------------------------------------------------------- */
/* verify (offline, zero write, no HOME/ledger access)                        */
/* -------------------------------------------------------------------------- */

function walkBundleTree(root, limits) {
  const files = []
  const errors = []
  const stack = [{ relativeDir: '', depth: 0 }]
  let entryCount = 0
  let totalBytes = 0
  let violation = null
  const trip = (limit, actual, file) => {
    violation = makeViolation(limits, limit, actual, file)
    addError(errors, limitMessage(violation))
  }
  while (stack.length && !violation) {
    const { relativeDir, depth } = stack.pop()
    const directory = relativeDir ? join(root, ...relativeDir.split('/')) : root
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) }
    catch (error) { addError(errors, 'cannot read directory ' + (relativeDir || '.') + ': ' + (error.code || error.message)); continue }
    for (const entry of entries) {
      entryCount += 1
      const relativePath = relativeDir ? relativeDir + '/' + entry.name : entry.name
      if (entryCount > limits.maxEntries) { trip('maxEntries', entryCount, relativePath); break }
      if (entry.isSymbolicLink()) { addError(errors, 'symbolic links are not allowed in a bundle: ' + relativePath); continue }
      if (entry.isDirectory()) {
        const childDepth = depth + 1
        if (childDepth > limits.maxDepth) { trip('maxDepth', childDepth, relativePath); break }
        if (!(relativePath === BUNDLE_KB_DIR || relativePath === BUNDLE_PAGES_DIR)) {
          addError(errors, 'unexpected directory in a bundle v1: ' + relativePath)
          continue
        }
        stack.push({ relativeDir: relativePath, depth: childDepth })
        continue
      }
      if (!entry.isFile()) { addError(errors, 'unsupported file type in a bundle: ' + relativePath); continue }
      if (isUnsafeBundlePath(relativePath)) { addError(errors, 'unsafe path in a bundle: ' + relativePath); continue }
      if (!isBundleLayoutPath(relativePath)) { addError(errors, 'unexpected file in a bundle v1 (unknown extra file): ' + relativePath); continue }
      let info
      try { info = statSync(join(root, ...relativePath.split('/'))) }
      catch (error) { addError(errors, 'cannot stat ' + relativePath + ': ' + (error.code || error.message)); continue }
      if (info.size > limits.maxFileBytes) { trip('maxFileBytes', info.size, relativePath); break }
      totalBytes += info.size
      if (totalBytes > limits.maxTotalBytes) { trip('maxTotalBytes', totalBytes, relativePath); break }
      files.push(relativePath)
    }
  }
  if (!violation) files.sort()
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
      if (bytes > limits.maxFileBytes) return { violation: makeViolation(limits, 'maxFileBytes', bytes, null) }
      hash.update(buffer.subarray(0, count))
    }
  } finally {
    try { closeSync(fd) } catch {}
  }
  return { sha256: hash.digest('hex'), bytes }
}

function readBoundedFile(file, maxBytes, limitName, label) {
  let info
  try { info = statSync(file) } catch (error) { return { error: 'cannot stat ' + label + ': ' + (error.code || error.message) } }
  if (!info.isFile()) return { error: label + ' is not a regular file' }
  if (info.size > maxBytes) {
    const violation = makeViolation({ ...BUNDLE_LIMIT_DEFAULTS, [limitName]: maxBytes }, limitName, info.size, label)
    return { violation, error: limitMessage(violation) }
  }
  try { return { text: readFileSync(file, 'utf8') } }
  catch (error) { return { error: 'cannot read ' + label + ': ' + (error.code || error.message) } }
}

function validateStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function validateLedgerSnapshotShape(snapshot) {
  const errors = []
  if (!isPlainObject(snapshot)) return ['ledger.json ledger must be an object (LedgerSnapshot v1)']
  if (snapshot.version !== 1) errors.push('ledger.version must be 1')
  for (const table of ['matters', 'facts', 'commitments', 'preferences', 'links', 'updates', 'routines', 'routinePatches']) {
    if (!Array.isArray(snapshot[table])) errors.push('ledger.' + table + ' must be an array')
  }
  if (!isPlainObject(snapshot.routes)) errors.push('ledger.routes must be an object')
  return errors
}

function validateLedgerPayload(payload, manifest, limits, flags) {
  const errors = []
  const warnings = []
  if (!isPlainObject(payload)) return { errors: ['ledger.json must be a JSON object'], warnings, data: null }
  if (typeof payload.version !== 'string' || !payload.version) errors.push('ledger.version (generator version) must be a non-empty string')
  if (!isNonNegativeInteger(payload.schemaVersion)) errors.push('ledger.schemaVersion must be a non-negative integer')
  else if (payload.schemaVersion > SCHEMA_VERSION) errors.push('ledger.schemaVersion ' + payload.schemaVersion + ' is newer than this CLI (v' + SCHEMA_VERSION + '); upgrade advisers before importing this bundle')
  else if (payload.schemaVersion !== manifest.schemaVersion) errors.push('ledger.schemaVersion disagrees with manifest.schemaVersion')
  else if (payload.schemaVersion < SCHEMA_VERSION) warnings.push('bundle schema v' + payload.schemaVersion + ' is older than this CLI (v' + SCHEMA_VERSION + '); missing columns take their defaults on import and tables added by a later schema are imported empty')
  if (!isDateText(payload.exportedAt)) errors.push('ledger.exportedAt must be an ISO date-time')
  if (payload.auditAnchor !== null) errors.push('ledger.auditAnchor must be null: the source audit chain is machine-local and only sourceAudit travels')
  if (!isPlainObject(payload.sourceAudit)) {
    errors.push('ledger.sourceAudit must be {count, headHash}')
  } else {
    const count = payload.sourceAudit.count
    const head = payload.sourceAudit.headHash
    if (count !== null && !isNonNegativeInteger(count)) errors.push('ledger.sourceAudit.count must be a non-negative integer or null')
    if (head !== null && head !== '' && !isHexLower(head)) errors.push('ledger.sourceAudit.headHash must be 64 lowercase hex, an empty string or null')
    if (count === null) warnings.push('the bundle records no source audit head (sourceAudit.count is null)')
  }
  for (const message of validateLedgerSnapshotShape(payload.ledger)) errors.push(message)
  const data = payload.data
  if (!isPlainObject(data)) {
    errors.push('ledger.data must be an object mapping table -> rows')
    return { errors, warnings, data: null }
  }
  const keys = Object.keys(data).sort()
  // The digest domain is the bundle's own schema domain: a v22 (0.5.0) bundle
  // legitimately has no v23 handoff/waiting tables, so validate against the
  // domain its manifest.schemaVersion declares (bundleDataTablesForSchema).
  const expected = bundleDataTablesForSchema(manifest?.schemaVersion)
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    errors.push('ledger.data must contain exactly the bundle data tables for schema v' + String(manifest?.schemaVersion) + ' (' + expected.join(', ') + ')')
  }
  for (const table of expected) {
    if (!Array.isArray(data[table])) { errors.push('ledger.data.' + table + ' must be an array'); continue }
    if (isNonNegativeInteger(manifest?.counts?.[table]) && manifest.counts[table] !== data[table].length) {
      errors.push('manifest.counts.' + table + ' is ' + manifest.counts[table] + ' but ledger.data.' + table + ' has ' + data[table].length + ' row(s)')
    }
    if (data[table].some((row) => !isPlainObject(row))) errors.push('ledger.data.' + table + ' must contain objects')
  }
  for (const table of BUNDLE_EXCLUDED_TABLES) {
    if (Object.prototype.hasOwnProperty.call(data, table)) {
      // excluded-table presence is a structural violation, not a checksum mismatch
      errors.push('ledger.data must not carry the excluded table ' + table + ' (it is machine-local/derived)')
    }
  }
  if (errors.length === 0) {
    try {
      const digest = computeBundleDataDigest(data, { tables: expected })
      flags.computedDataDigest = digest.dataDigest
      if (digest.dataDigest !== manifest.dataDigest) {
        flags.tampered = true
        errors.push('dataDigest mismatch: manifest says ' + String(manifest.dataDigest).slice(0, 12) + '..., recomputed ' + digest.dataDigest.slice(0, 12) + '... (ledger.json was edited)')
      }
    } catch (error) {
      errors.push('cannot recompute dataDigest: ' + String(error?.message ?? error))
    }
  }
  return { errors, warnings, data }
}

function validateManifest(manifest, parsedEntries, fileSet, result, limits, flags) {
  const errors = []
  const warnings = []
  const fail = (message) => addError(errors, message)
  if (!isPlainObject(manifest)) { fail('manifest.json must be a JSON object'); return { errors, warnings } }
  if (manifest.format !== BUNDLE_MANIFEST_FORMAT) fail('manifest.format must be "' + BUNDLE_MANIFEST_FORMAT + '"')
  if (manifest.version !== BUNDLE_MANIFEST_VERSION) fail('manifest.version must be ' + BUNDLE_MANIFEST_VERSION)
  if (manifest.scope !== BUNDLE_SCOPE) fail('manifest.scope must be "' + BUNDLE_SCOPE + '"')
  if (manifest.subject !== null) fail('manifest.subject must be null (a bundle is one whole home, not a per-subject selection)')
  if (manifest.verificationBasis !== BUNDLE_VERIFICATION_BASIS) fail('manifest.verificationBasis must be "' + BUNDLE_VERIFICATION_BASIS + '"')
  if (manifest.disclaimer !== true) fail('manifest.disclaimer must be true')
  if (!isDateText(manifest.generatedAt)) fail('manifest.generatedAt must be an ISO date-time')
  if (!isPlainObject(manifest.generator)) fail('manifest.generator must be an object')
  else {
    if (typeof manifest.generator.advisersVersion !== 'string' || !manifest.generator.advisersVersion) fail('manifest.generator.advisersVersion must be a non-empty string')
    if (typeof manifest.generator.command !== 'string' || !manifest.generator.command) fail('manifest.generator.command must be a non-empty string')
  }
  if (!isNonNegativeInteger(manifest.schemaVersion)) fail('manifest.schemaVersion must be a non-negative integer')
  else if (manifest.schemaVersion > SCHEMA_VERSION) fail('manifest.schemaVersion ' + manifest.schemaVersion + ' is newer than this CLI (v' + SCHEMA_VERSION + '); upgrade advisers before reading this bundle')
  // A bundle declares its own data table set (sorted) for the schemaVersion it
  // was written with: v22 bundles have 20 tables, v23 adds 3 more.
  const tables = bundleDataTablesForSchema(manifest.schemaVersion)
  if (!validateStringArray(manifest.tables) || manifest.tables.length !== tables.length || manifest.tables.some((table, index) => table !== tables[index])) {
    fail('manifest.tables must list the bundle data tables for schema v' + String(manifest.schemaVersion) + ' in sorted order (' + tables.join(', ') + ')')
  }
  if (isNonNegativeInteger(manifest.schemaVersion) && manifest.schemaVersion < SCHEMA_VERSION && tables.length < BUNDLE_DATA_TABLES.length) {
    warnings.push('bundle schema v' + manifest.schemaVersion + ' predates v' + SCHEMA_VERSION + ': its dataDigest domain has ' + tables.length + ' of ' + BUNDLE_DATA_TABLES.length + ' tables; tables added by a later schema are imported empty')
  }
  if (!isPlainObject(manifest.counts)) fail('manifest.counts must be an object')
  else {
    const keys = Object.keys(manifest.counts).sort()
    if (keys.length !== tables.length || keys.some((key, index) => key !== tables[index])) fail('manifest.counts must have exactly one key per bundle data table')
    for (const table of tables) if (!isNonNegativeInteger(manifest.counts[table])) fail('manifest.counts.' + table + ' must be a non-negative integer')
  }
  if (!isHexLower(manifest.dataDigest)) fail('manifest.dataDigest must be 64 lowercase hex')
  if (!validateStringArray(manifest.excluded)) fail('manifest.excluded must be an array of strings')
  else {
    for (const required of BUNDLE_EXCLUDED_TABLES) if (!manifest.excluded.includes(required)) fail('manifest.excluded must record the excluded table ' + required)
  }
  if (!Array.isArray(manifest.files)) { fail('manifest.files must be an array'); return { errors, warnings } }
  if (!isNonNegativeInteger(manifest.fileCount)) fail('manifest.fileCount must be a non-negative integer')
  else if (manifest.fileCount !== manifest.files.length) fail('manifest.fileCount does not match manifest.files.length')
  const listed = new Set()
  for (const record of manifest.files) {
    if (!isPlainObject(record)) { fail('manifest.files entries must be objects'); continue }
    if (typeof record.path !== 'string' || isUnsafeBundlePath(record.path)) { fail('manifest.files has an unsafe path'); continue }
    if (!isBundleLayoutPath(record.path)) { fail('manifest.files lists a path outside the bundle v1 layout: ' + record.path); continue }
    if (record.path === BUNDLE_MANIFEST_FILE || record.path === BUNDLE_SHA256SUMS_FILE) { fail('manifest.files must not list ' + record.path); continue }
    if (listed.has(record.path)) { fail('manifest.files lists ' + record.path + ' twice'); continue }
    listed.add(record.path)
    if (!isNonNegativeInteger(record.size)) fail('manifest.files size for ' + record.path + ' must be a non-negative integer')
    if (!isHexLower(record.sha256)) fail('manifest.files sha256 for ' + record.path + ' must be 64 lowercase hex')
    if (!parsedEntries.has(record.path)) { fail('manifest.files lists ' + record.path + ' but SHA256SUMS does not cover it') }
    else {
      if (isHexLower(record.sha256) && parsedEntries.get(record.path) !== record.sha256) {
        flags.tampered = true
        fail('manifest sha256 disagrees with SHA256SUMS for ' + record.path)
      }
      if (fileSet.has(record.path) && isNonNegativeInteger(record.size)) {
        try {
          const info = statSync(join(result.dir, ...record.path.split('/')))
          if (info.size !== record.size) { flags.tampered = true; fail('manifest size disagrees with the file on disk for ' + record.path) }
        } catch (error) { fail('cannot stat ' + record.path + ': ' + (error.code || error.message)) }
      }
    }
    if (fileSet.has(record.path) && !parsedEntries.has(record.path)) fail('file not covered by SHA256SUMS: ' + record.path)
  }
  for (const name of parsedEntries.keys()) {
    if (name === BUNDLE_MANIFEST_FILE) continue
    if (!listed.has(name)) fail('SHA256SUMS covers ' + name + ' but manifest.files does not list it')
  }
  if (isNonNegativeInteger(manifest.fileCount) && manifest.fileCount !== parsedEntries.size - 1) {
    fail('manifest.fileCount is ' + manifest.fileCount + ' but SHA256SUMS covers ' + (parsedEntries.size - 1) + ' data file(s)')
  }
  if (!isNonNegativeInteger(manifest.checksumCount)) fail('manifest.checksumCount must be a non-negative integer')
  else if (manifest.checksumCount !== parsedEntries.size) fail('manifest.checksumCount is ' + manifest.checksumCount + ' but SHA256SUMS has ' + parsedEntries.size + ' entries')
  for (const required of BUNDLE_REQUIRED_FILES) {
    if (required === BUNDLE_MANIFEST_FILE) continue
    if (!parsedEntries.has(required)) fail('SHA256SUMS does not cover ' + required)
    if (!fileSet.has(required)) fail('missing file: ' + required)
    if (!listed.has(required)) fail('manifest.files does not list the required file ' + required)
  }
  for (const name of fileSet) {
    if (name === BUNDLE_SHA256SUMS_FILE) continue
    if (!parsedEntries.has(name)) fail('file not covered by SHA256SUMS: ' + name)
  }
  return { errors, warnings }
}

/**
 * Normalize an --expect-dataDigest value: undefined/empty -> null (no
 * expectation), otherwise lowercase 64-hex. Returns { value, error } and never
 * throws (bad input becomes a verification error).
 */
function normalizeExpectedDataDigest(value) {
  if (value === undefined || value === null || value === '') return { value: null, error: null }
  const text = String(value).trim().toLowerCase()
  if (!isHexLower(text)) return { value: text, error: 'expectDataDigest must be 64 lowercase hex characters' }
  return { value: text, error: null }
}

/**
 * Verify a bundle directory offline: zero writes, no HOME creation, no ledger
 * access. Returns a machine-readable result instead of throwing on bad input.
 *
 * @param {string} dir bundle directory produced by exportBundle/buildBundle
 * @param {{limits?:object, includePayload?:boolean, expectDataDigest?:string}} [options]
 *   expectDataDigest (0.5.1 acceptance UX): when supplied, the recomputed
 *   dataDigest must equal it; the result carries expectedDigest and
 *   dataDigestMatch and a mismatch fails verification with
 *   E_BUNDLE_TAMPERED (the directory may be valid but is not the expected one).
 * @returns {object} see docs/PORTABILITY.md; `payload` is only filled when
 *   includePayload is true (internal import re-use; never serialize it).
 */
export function verifyBundleDir(dir, options = {}) {
  const errors = []
  const warnings = []
  const limits = normalizeLimits(options?.limits)
  const flags = { tampered: false, expectMismatch: false, computedDataDigest: null }
  const result = {
    ok: false,
    code: null,
    dir: String(dir),
    format: null,
    version: null,
    scope: null,
    subject: null,
    verificationBasis: null,
    generatedAt: null,
    schemaVersion: null,
    counts: {},
    tables: [],
    dataDigest: null,
    computedDataDigest: null,
    expectedDigest: null,
    dataDigestMatch: null,
    manifestDigest: null,
    fileCount: 0,
    checksumCount: 0,
    files: [],
    checksums: {},
    manifest: null,
    totalBytes: 0,
    limits: { ...limits },
    limitViolation: null,
    errors,
    warnings,
  }
  const expected = normalizeExpectedDataDigest(options?.expectDataDigest)
  result.expectedDigest = expected.value
  if (expected.error) {
    addError(errors, expected.error)
    result.dataDigestMatch = false
  }
  if (typeof dir !== 'string' || !dir.trim()) { addError(errors, 'a bundle directory is required'); result.code = result.code ?? BUNDLE_ERROR_CODES.INVALID; return result }
  let root
  try { root = resolve(dir) } catch (error) { addError(errors, 'invalid bundle path: ' + (error.message || error)); result.code = result.code ?? BUNDLE_ERROR_CODES.INVALID; return result }
  result.dir = root
  if (!existsSync(root)) { addError(errors, 'bundle directory not found: ' + root); result.code = result.code ?? BUNDLE_ERROR_CODES.INVALID; return result }
  let rootStat
  try { rootStat = lstatSync(root) } catch (error) { addError(errors, 'cannot stat bundle directory: ' + (error.code || error.message)); result.code = result.code ?? BUNDLE_ERROR_CODES.INVALID; return result }
  if (rootStat.isSymbolicLink()) { addError(errors, 'the bundle directory must be a real directory, not a symbolic link: ' + root); result.code = result.code ?? BUNDLE_ERROR_CODES.INVALID; return result }
  if (!rootStat.isDirectory()) { addError(errors, 'bundle path is not a directory: ' + root); result.code = result.code ?? BUNDLE_ERROR_CODES.INVALID; return result }
  const walked = walkBundleTree(root, limits)
  for (const error of walked.errors) addError(errors, error)
  result.files = [...walked.files]
  result.fileCount = walked.files.length
  result.totalBytes = walked.totalBytes
  if (walked.violation) {
    result.code = BUNDLE_LIMIT_CODE
    result.limitViolation = walked.violation
    return result
  }
  const fileSet = new Set(walked.files)
  if (!fileSet.has(BUNDLE_SHA256SUMS_FILE)) { addError(errors, 'missing file: ' + BUNDLE_SHA256SUMS_FILE); result.code = result.code ?? BUNDLE_ERROR_CODES.INVALID; return result }
  let sumsText
  try {
    const info = statSync(join(root, BUNDLE_SHA256SUMS_FILE))
    if (info.size > limits.maxSumsBytes) {
      const violation = makeViolation(limits, 'maxSumsBytes', info.size, BUNDLE_SHA256SUMS_FILE)
      addError(errors, limitMessage(violation))
      result.code = BUNDLE_LIMIT_CODE
      result.limitViolation = violation
      return result
    }
    sumsText = readFileSync(join(root, BUNDLE_SHA256SUMS_FILE), 'utf8')
  } catch (error) { addError(errors, 'cannot read SHA256SUMS: ' + (error.code || error.message)); result.code = result.code ?? BUNDLE_ERROR_CODES.INVALID; return result }
  if (sumsText.includes(CR)) addError(errors, 'SHA256SUMS must use LF line endings (no CR); regenerate the bundle instead of converting it')
  const parsed = parseClientPackSums(sumsText)
  for (const error of parsed.errors) addError(errors, error)
  result.checksumCount = parsed.entries.size
  result.checksums = Object.fromEntries([...parsed.entries.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1)))
  for (const name of parsed.entries.keys()) {
    if (isUnsafeBundlePath(name)) { addError(errors, 'unsafe path in SHA256SUMS: ' + name); continue }
    if (!isBundleLayoutPath(name)) addError(errors, 'SHA256SUMS lists a path outside the bundle v1 layout: ' + name)
    if (!fileSet.has(name)) addError(errors, 'missing file: ' + name)
  }
  for (const name of fileSet) {
    if (name === BUNDLE_SHA256SUMS_FILE) continue
    if (!parsed.entries.has(name)) addError(errors, 'file not covered by SHA256SUMS: ' + name)
  }
  if (!fileSet.has(BUNDLE_MANIFEST_FILE)) { addError(errors, 'missing file: ' + BUNDLE_MANIFEST_FILE); result.code = result.code ?? BUNDLE_ERROR_CODES.INVALID; return result }
  let hashedTotal = 0
  for (const name of [...parsed.entries.keys()].sort()) {
    if (!fileSet.has(name)) continue
    const full = join(root, ...name.split('/'))
    try {
      const hashed = hashFileWithLimit(full, limits)
      if (hashed.violation) {
        hashed.violation.file = name
        addError(errors, limitMessage(hashed.violation))
        result.code = BUNDLE_LIMIT_CODE
        result.limitViolation = hashed.violation
        return result
      }
      hashedTotal += hashed.bytes
      if (hashedTotal > limits.maxTotalBytes) {
        const violation = makeViolation(limits, 'maxTotalBytes', hashedTotal, name)
        addError(errors, limitMessage(violation))
        result.code = BUNDLE_LIMIT_CODE
        result.limitViolation = violation
        return result
      }
      if (hashed.sha256 !== parsed.entries.get(name)) {
        flags.tampered = true
        addError(errors, 'hash mismatch: ' + name + ' (expected ' + parsed.entries.get(name).slice(0, 12) + '..., computed ' + hashed.sha256.slice(0, 12) + '...)')
      }
    } catch (error) { addError(errors, 'cannot read file ' + name + ': ' + (error.code || error.message)) }
  }
  let manifest = null
  try {
    const read = readBoundedFile(join(root, BUNDLE_MANIFEST_FILE), limits.maxManifestBytes, 'maxManifestBytes', BUNDLE_MANIFEST_FILE)
    if (read.violation) { addError(errors, limitMessage(read.violation)); result.code = BUNDLE_LIMIT_CODE; result.limitViolation = read.violation; return result }
    if (read.error) { addError(errors, read.error); result.code = result.code ?? BUNDLE_ERROR_CODES.INVALID; return result }
    result.manifestDigest = sha256Hex(read.text)
    manifest = JSON.parse(read.text)
  } catch (error) { addError(errors, 'manifest.json is not valid JSON: ' + (error.message || error)); result.code = flags.tampered ? BUNDLE_ERROR_CODES.TAMPERED : (result.code ?? BUNDLE_ERROR_CODES.INVALID); return result }
  result.manifest = manifest
  if (isPlainObject(manifest)) {
    result.format = typeof manifest.format === 'string' ? manifest.format : null
    result.version = Number.isInteger(manifest.version) ? manifest.version : null
    result.scope = typeof manifest.scope === 'string' ? manifest.scope : null
    result.subject = isPlainObject(manifest.subject) ? manifest.subject : null
    result.verificationBasis = typeof manifest.verificationBasis === 'string' ? manifest.verificationBasis : null
    result.generatedAt = typeof manifest.generatedAt === 'string' ? manifest.generatedAt : null
    result.schemaVersion = Number.isInteger(manifest.schemaVersion) ? manifest.schemaVersion : null
    result.counts = isPlainObject(manifest.counts) ? { ...manifest.counts } : {}
    result.tables = validateStringArray(manifest.tables) ? [...manifest.tables] : []
    result.dataDigest = typeof manifest.dataDigest === 'string' ? manifest.dataDigest : null
  }
  const manifestCheck = validateManifest(manifest, parsed.entries, fileSet, result, limits, flags)
  for (const message of manifestCheck.errors) addError(errors, message)
  for (const warning of manifestCheck.warnings) warnings.push(warning)
  if (!fileSet.has(BUNDLE_LEDGER_FILE)) { addError(errors, 'missing file: ' + BUNDLE_LEDGER_FILE) }
  else {
    try {
      const read = readBoundedFile(join(root, BUNDLE_LEDGER_FILE), limits.maxLedgerBytes, 'maxLedgerBytes', BUNDLE_LEDGER_FILE)
      if (read.violation) { addError(errors, limitMessage(read.violation)); result.code = BUNDLE_LIMIT_CODE; result.limitViolation = read.violation; return result }
      if (read.error) addError(errors, read.error)
      else {
        const payload = JSON.parse(read.text)
        const payloadCheck = validateLedgerPayload(payload, manifest, limits, flags)
        for (const message of payloadCheck.errors) addError(errors, message)
        for (const warning of payloadCheck.warnings) warnings.push(warning)
        result.computedDataDigest = flags.computedDataDigest
        if (payloadCheck.data) checkProjections(root, payloadCheck.data, result, limits, errors, warnings)
        if (options.includePayload === true) result.payload = payload
      }
    } catch (error) { addError(errors, 'ledger.json is not valid JSON: ' + (error.message || error)) }
  }
  // 0.5.1 acceptance UX: compare the recomputed digest with the expected one.
  // A bundle can be internally valid yet not the bundle the receiver expected,
  // so a mismatch fails verification (E_BUNDLE_TAMPERED: no new error code).
  if (expected.value !== null) {
    const actual = typeof result.computedDataDigest === 'string' ? result.computedDataDigest : result.dataDigest
    result.dataDigestMatch = typeof actual === 'string' && actual === expected.value
    if (!result.dataDigestMatch) {
      flags.expectMismatch = true
      addError(errors, 'dataDigest does not match the expected digest: expected ' + expected.value + ', computed ' + String(actual ?? 'unavailable'))
    }
  }
  if (fileSet.has(BUNDLE_IMPORT_FILE)) {
    try {
      const read = readBoundedFile(join(root, BUNDLE_IMPORT_FILE), limits.maxImportBytes, 'maxImportBytes', BUNDLE_IMPORT_FILE)
      if (read.violation) { result.code = BUNDLE_LIMIT_CODE; result.limitViolation = read.violation; addError(errors, limitMessage(read.violation)) }
      else if (read.error) addError(errors, read.error)
      else if (read.text.includes(CR)) addError(errors, 'IMPORT.md must use LF line endings (no CR)')
      else if (!read.text.includes(BUNDLE_SHA256SUMS_FILE)) warnings.push('IMPORT.md does not mention ' + BUNDLE_SHA256SUMS_FILE)
      else if (!read.text.toLowerCase().includes('not a signature')) warnings.push('IMPORT.md does not state that the checksums are not a signature')
    } catch (error) { addError(errors, 'cannot read IMPORT.md: ' + (error.code || error.message)) }
  }
  // FORMAT.md is optional (0.5.0 bundles have none) but, when present, it is a
  // checksum-covered part of the layout and must be a readable LF Markdown file.
  if (fileSet.has(BUNDLE_FORMAT_FILE)) {
    try {
      const read = readBoundedFile(join(root, BUNDLE_FORMAT_FILE), limits.maxFormatBytes, 'maxFormatBytes', BUNDLE_FORMAT_FILE)
      if (read.violation) { result.code = BUNDLE_LIMIT_CODE; result.limitViolation = read.violation; addError(errors, limitMessage(read.violation)) }
      else if (read.error) addError(errors, read.error)
      else if (read.text.includes(CR)) addError(errors, 'FORMAT.md must use LF line endings (no CR)')
      else if (!read.text.trim()) addError(errors, 'FORMAT.md is empty')
      else if (!read.text.includes(BUNDLE_LEDGER_FILE)) warnings.push('FORMAT.md does not mention ' + BUNDLE_LEDGER_FILE)
    } catch (error) { addError(errors, 'cannot read FORMAT.md: ' + (error.code || error.message)) }
  } else {
    warnings.push('bundle has no ' + BUNDLE_FORMAT_FILE + ' (legacy Advisers 0.5.0 layout); the v1 layout and dataDigest algorithm are documented in docs/PORTABILITY.md')
  }
  warnings.push('verification basis is ' + BUNDLE_VERIFICATION_BASIS + ': SHA-256 proves bundle internal consistency only, not authorship or generation time')
  result.ok = errors.length === 0
  result.code = result.ok
    ? null
    : (result.limitViolation
      ? BUNDLE_LIMIT_CODE
      : ((flags.tampered || flags.expectMismatch) ? BUNDLE_ERROR_CODES.TAMPERED : BUNDLE_ERROR_CODES.INVALID))
  return result
}

/** Cross-check the human projections against ledger.json (structural only). */
function checkProjections(root, data, result, limits, errors, warnings) {
  const docs = Array.isArray(data.kb_documents) ? data.kb_documents : []
  const kbFiles = result.files.filter((name) => name.startsWith(BUNDLE_KB_DIR + '/'))
  if (kbFiles.length !== docs.length) {
    errors.push('projection count mismatch: ' + kbFiles.length + ' kb/*.md file(s) for ' + docs.length + ' kb_document row(s); regenerate the bundle instead of deleting/adding files')
  }
  const expectedKb = new Set()
  let idsSafe = true
  for (const doc of docs) {
    const id = String(doc?.id ?? '')
    if (!id || isUnsafeBundlePath(id)) { idsSafe = false; continue }
    expectedKb.add(BUNDLE_KB_DIR + '/' + id + '.md')
  }
  if (idsSafe) {
    for (const name of kbFiles) if (!expectedKb.has(name)) errors.push('unexpected kb projection (no matching kb_documents row): ' + name)
    for (const name of expectedKb) if (!result.files.includes(name)) errors.push('missing kb projection for a kb_documents row: ' + name)
  }
  if (!result.files.includes(BUNDLE_FACTS_FILE)) {
    errors.push('missing file: ' + BUNDLE_FACTS_FILE)
    return
  }
  try {
    const read = readBoundedFile(join(root, BUNDLE_FACTS_FILE), limits.maxFactsBytes, 'maxFactsBytes', BUNDLE_FACTS_FILE)
    if (read.violation) { result.code = BUNDLE_LIMIT_CODE; result.limitViolation = read.violation; errors.push(limitMessage(read.violation)) }
    else if (read.error) errors.push(read.error)
    else if (!read.text.trim()) errors.push(BUNDLE_FACTS_FILE + ' is empty')
    else if (!read.text.startsWith('# Facts')) warnings.push(BUNDLE_FACTS_FILE + ' does not start with the expected "# Facts" heading')
  } catch (error) { errors.push('cannot read ' + BUNDLE_FACTS_FILE + ': ' + (error.code || error.message)) }
}

/** Alias requested by the 0.5.0 bin contract: verifyBundle(dir, options). */
export function verifyBundle(dir, options = {}) {
  return verifyBundleDir(dir, options)
}

/**
 * Read only manifest.format/version/scope from a directory (bounded), for
 * `import --bundle --dry-run --verify` TOS/usage pre-scan without trusting the
 * rest of the directory. Never throws on bad input.
 */
export function readBundleManifestHeader(dir, options = {}) {
  const limits = normalizeLimits(options?.limits)
  const out = { ok: false, format: null, version: null, scope: null, error: null }
  if (typeof dir !== 'string' || !dir.trim()) { out.error = 'a bundle directory is required'; return out }
  let root
  try { root = resolve(dir) } catch { out.error = 'invalid path'; return out }
  if (!existsSync(root)) { out.error = 'directory not found'; return out }
  const manifestPath = join(root, BUNDLE_MANIFEST_FILE)
  if (!existsSync(manifestPath)) { out.error = 'manifest.json not found'; return out }
  try {
    const info = lstatSync(manifestPath)
    if (info.isSymbolicLink() || !info.isFile()) { out.error = 'manifest.json is not a regular file'; return out }
    if (info.size > limits.maxManifestBytes) { out.error = 'manifest.json exceeds the size limit'; return out }
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!isPlainObject(parsed)) { out.error = 'manifest.json is not an object'; return out }
    out.format = typeof parsed.format === 'string' ? parsed.format : null
    out.version = Number.isInteger(parsed.version) ? parsed.version : null
    out.scope = typeof parsed.scope === 'string' ? parsed.scope : null
    out.ok = Boolean(out.format)
    return out
  } catch (error) {
    out.error = String(error?.message ?? error)
    return out
  }
}

/* -------------------------------------------------------------------------- */
/* write / export                                                             */
/* -------------------------------------------------------------------------- */

function assertSafeBundleTarget(target, home) {
  if (!home) return
  const resolvedHome = resolve(home)
  if (resolve(target) === resolvedHome) throw bundleError(BUNDLE_ERROR_CODES.TARGET, 'refusing to write a bundle over ADVISERS_HOME itself (' + resolvedHome + '); choose a separate directory')
  for (const forbidden of ['backups', 'credentials', 'scheduler']) {
    const dir = join(resolvedHome, forbidden)
    if (isInside(dir, target)) {
      throw bundleError(BUNDLE_ERROR_CODES.TARGET, 'refusing to write a bundle inside $ADVISERS_HOME/' + forbidden + ' (' + resolve(target) + '); choose a directory outside the home')
    }
  }
}

function assertNotSymlinkTarget(target) {
  let info = null
  try { info = lstatSync(target) } catch (error) { if (error?.code === 'ENOENT') return; throw error }
  if (info.isSymbolicLink()) throw bundleError(BUNDLE_ERROR_CODES.TARGET, 'refusing to write through a symbolic link at the bundle target: ' + target)
}

function uniqueReplacedPath(target) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let candidate = target + '.replaced-' + stamp
  for (let index = 2; index < 1000; index += 1) {
    if (!existsSync(candidate)) return candidate
    candidate = target + '.replaced-' + stamp + '-' + index
  }
  return candidate
}

function writeBundleFiles(staging, fileContents) {
  for (const [name, content] of [...fileContents.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1))) {
    if (isUnsafeBundlePath(name) || !isBundleLayoutPath(name)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'refusing to write an unsafe bundle path: ' + JSON.stringify(name).slice(0, 120))
    const full = join(staging, ...name.split('/'))
    mkdirWithRetrySync(dirname(full), { mode: BUNDLE_DIR_MODE })
    writeFileSync(full, toBuffer(content), { mode: BUNDLE_FILE_MODE })
    try { chmodSync(full, BUNDLE_FILE_MODE) } catch {}
  }
}

/**
 * Write a built bundle atomically: staging directory in the target's parent
 * (same filesystem, Windows AV/rename retries), 0700 dirs / 0600 files, verify
 * the bytes that reached disk, then rename into place. A non-empty target is
 * refused unless force is true; with force the old tree is moved aside to
 * `<dir>.replaced-<UTC>` and is NEVER deleted.
 *
 * @returns {{outDir:string, replaced:string|null, staging:string, verification:object|null}}
 */
export function writeBundleDir(outDir, built, options = {}) {
  if (!isPlainObject(built) || !(built.files instanceof Map) || !isPlainObject(built.manifest)) {
    throw new TypeError('writeBundleDir expects the buildBundle result')
  }
  if (typeof outDir !== 'string' || !outDir.trim()) throw bundleError(BUNDLE_ERROR_CODES.TARGET, 'an explicit bundle output directory is required (export --bundle <dir>)')
  const force = options.force === true
  const target = resolve(outDir)
  const home = options.home ? resolve(String(options.home)) : null
  const limits = normalizeLimits(options.limits)
  assertSafeBundleTarget(target, home)
  mkdirWithRetrySync(dirname(target))
  assertNotSymlinkTarget(target)
  const staging = target + '.tmp-' + process.pid + '-' + createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)
  let replaced = null
  let verification = null
  try {
    mkdirWithRetrySync(staging, { mode: BUNDLE_DIR_MODE })
    try { chmodSync(staging, BUNDLE_DIR_MODE) } catch {}
    writeBundleFiles(staging, built.files)
    if (options.verify !== false) {
      verification = verifyBundleDir(staging, { limits })
      if (!verification.ok) {
        throw bundleError(verification.code ?? BUNDLE_ERROR_CODES.INVALID, 'written bundle failed offline verification: ' + verification.errors.slice(0, 3).join(' | '))
      }
    }
    if (existsSync(target)) {
      const info = lstatSync(target)
      if (!info.isDirectory() || info.isSymbolicLink()) throw bundleError(BUNDLE_ERROR_CODES.TARGET, 'bundle output exists and is not a real directory: ' + target)
      const entries = readdirSync(target)
      if (entries.length && !force) {
        throw bundleError(BUNDLE_ERROR_CODES.TARGET, 'bundle output directory is not empty: ' + target, 'choose a fresh directory or pass force:true (the old tree is renamed, never deleted)')
      }
      if (entries.length) {
        replaced = uniqueReplacedPath(target)
        renameWithRetrySync(target, replaced)
      } else {
        rmdirSync(target)
      }
    }
    renameWithRetrySync(staging, target)
  } catch (error) {
    try { rmWithRetrySync(staging) } catch {}
    if (replaced && !existsSync(target)) {
      try { renameWithRetrySync(replaced, target) } catch {}
    }
    throw error
  }
  try { chmodSync(target, BUNDLE_DIR_MODE) } catch {}
  return { outDir: target, replaced, staging, verification }
}

function exportErrorResult(error, warnings) {
  const rawCode = typeof error?.code === 'string' ? error.code : null
  const code = rawCode && BUNDLE_ERROR_HINTS[rawCode] ? rawCode : BUNDLE_ERROR_CODES.INVALID
  return { ok: false, code, out: null, replaced: null, errors: [String(error?.message ?? error).slice(0, 600)], warnings: warnings ?? [], manifest: null }
}

/**
 * Build + atomically write + offline-verify a bundle directory. This is the
 * one call the CLI needs for `export --bundle <dir>`.
 *
 * @returns {object} JSON summary: ok/code/out/replaced/format/version/scope/
 *   generatedAt/schemaVersion/counts/tables/dataDigest/manifestDigest/
 *   fileCount/checksumCount/bytes/sourceAudit/manifest/verification/errors/warnings
 */
export function exportBundle(options = {}) {
  const warnings = []
  if (options?.encrypted === true) {
    return { ok: false, code: BUNDLE_ERROR_CODES.PASSPHRASE, out: null, replaced: null, errors: ['bundle v1 is plaintext-only in 0.5.0; --encrypted (B3) is a later-version opt-in and is not implemented'], warnings }
  }
  const outDir = typeof options?.outDir === 'string' ? options.outDir.trim() : ''
  if (!outDir) return { ok: false, code: BUNDLE_ERROR_CODES.TARGET, out: null, replaced: null, errors: ['an explicit bundle output directory is required (export --bundle <dir>)'], warnings }
  const built = buildBundle(options)
  for (const warning of built.warnings ?? []) warnings.push(warning)
  if (!built.ok) return { ok: false, code: built.code, out: null, replaced: null, errors: built.errors ?? [], warnings, manifest: null }
  let written
  try {
    written = writeBundleDir(outDir, built, { force: options.force === true, home: options.home, limits: options.limits })
  } catch (error) {
    return exportErrorResult(error, warnings)
  }
  const summary = built.summary
  return {
    ok: true,
    code: null,
    out: written.outDir,
    replaced: written.replaced ?? null,
    format: summary.format,
    version: summary.version,
    scope: summary.scope,
    subject: summary.subject,
    verificationBasis: summary.verificationBasis,
    generatedAt: summary.generatedAt,
    generator: summary.generator,
    schemaVersion: summary.schemaVersion,
    counts: summary.counts,
    tables: summary.tables,
    dataDigest: summary.dataDigest,
    manifestDigest: built.manifestDigest,
    fileCount: summary.fileCount,
    checksumCount: summary.checksumCount,
    bytes: summary.bytes,
    sourceAudit: summary.sourceAudit,
    files: summary.files,
    excluded: summary.excluded,
    manifest: built.manifest,
    verification: written.verification,
    errors: [],
    warnings,
  }
}

/* -------------------------------------------------------------------------- */
/* import                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Inspect the local import target without writing: is the database absent,
 * empty (a fresh init/TOS database) or does it already hold data? A DB with
 * only `tos.*`/`sync.*` audit rows counts as empty, exactly like sync pull.
 */
function inspectImportTarget(dbPath, store) {
  const result = { exists: false, empty: true, dataRows: 0, counts: {}, ledger: null, error: null }
  if (store && store.db && typeof store.db.prepare === 'function') {
    result.exists = true
    try {
      const tableNames = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
      for (const table of BUNDLE_DATA_TABLES) {
        if (!tableNames.has(table)) continue
        const count = Number(store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()?.n ?? 0)
        result.counts[table] = count
        result.dataRows += count
      }
    } catch (error) { result.empty = false; result.error = String(error?.message ?? error); return result }
    try { result.ledger = inspectLocalLedger(store.path) } catch (error) { result.empty = false; result.error = String(error?.message ?? error); return result }
    if (result.ledger?.error) { result.empty = false; result.error = result.ledger.error; return result }
    result.empty = Boolean(result.ledger?.empty) && result.dataRows === 0
    return result
  }
  let info
  try { info = statSync(dbPath) } catch (error) {
    if (error?.code === 'ENOENT') return result
    result.empty = false; result.error = String(error?.message ?? error); return result
  }
  result.exists = true
  if (!info.isFile() || info.size === 0) { result.empty = false; result.error = 'the local database is not a regular non-empty file'; return result }
  try { result.ledger = inspectLocalLedger(dbPath) } catch (error) { result.empty = false; result.error = String(error?.message ?? error); return result }
  if (result.ledger?.error) { result.empty = false; result.error = result.ledger.error; return result }
  let db = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const tableNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
    for (const table of BUNDLE_DATA_TABLES) {
      if (!tableNames.has(table)) continue
      const count = Number(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()?.n ?? 0)
      result.counts[table] = count
      result.dataRows += count
    }
  } catch (error) {
    result.empty = false; result.error = String(error?.message ?? error); return result
  } finally { if (db) { try { db.close() } catch {} } }
  result.empty = Boolean(result.ledger?.empty) && result.dataRows === 0
  return result
}

function bundleTableColumns(store, table) {
  return store.db.prepare('PRAGMA table_info(' + table + ')').all().map((row) => ({
    name: row.name,
    notnull: Number(row.notnull) === 1,
    hasDefault: row.dflt_value !== null,
    pk: Number(row.pk) > 0,
  }))
}

/** Wholesale replace one table from raw bundle rows (unknown/missing columns refuse). */
function replaceBundleTable(store, table, rows) {
  const columns = bundleTableColumns(store, table)
  const allowed = new Map(columns.map((column) => [column.name, column]))
  const required = columns.filter((column) => column.notnull && !column.hasDefault && !column.pk).map((column) => column.name)
  store.db.prepare('DELETE FROM ' + table).run()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!isPlainObject(row)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.' + table + '[' + index + '] must be an object')
    const names = []
    for (const name of Object.keys(row)) {
      if (!allowed.has(name)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.' + table + '[' + index + '] has an unknown column ' + name + ' (the bundle was written by a newer schema than this CLI)')
      names.push(name)
    }
    for (const name of required) {
      if (!Object.prototype.hasOwnProperty.call(row, name)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.' + table + '[' + index + '] is missing the required column ' + name)
    }
    if (!names.length) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.' + table + '[' + index + '] has no columns')
    // Quote every identifier: v23 mail_messages."references" is a SQLite keyword.
    store.db.prepare('INSERT INTO ' + table + ' (' + names.map((name) => '"' + name + '"').join(',') + ') VALUES (' + names.map(() => '?').join(',') + ')')
      .run(...names.map((name) => row[name] === undefined ? null : row[name]))
  }
  return rows.length
}

/**
 * Restore every bundle data table inside the import transaction, then keep the
 * database referentially coherent (the same rules import --replace has used
 * since 0.3.0/0.4.0) and clear the derived kb_pages projection. Any throw rolls
 * the ledger and every table back; the pre-import backup stays as the net.
 */
function restoreBundleData(store, data) {
  const report = { tables: {}, reconciled: { deliveries: 0, kbDocuments: 0, kbFactLinks: 0, kbPagesCleared: 0 }, ftsRebuilt: false }
  for (const table of BUNDLE_DATA_TABLES) {
    // A bundle written by an older schema (0.5.0 = v22) has no v23 tables yet;
    // they are additive and therefore imported as empty rather than undefined.
    report.tables[table] = replaceBundleTable(store, table, Array.isArray(data[table]) ? data[table] : [])
  }
  const clientIds = new Set(store.db.prepare('SELECT id FROM clients').all().map((row) => row.id))
  const projectRows = new Map(store.db.prepare('SELECT id, client_id FROM projects').all().map((row) => [row.id, row]))
  const matterRows = new Map(store.db.prepare('SELECT id, client_id, project_id FROM matters').all().map((row) => [row.id, row]))
  for (const project of projectRows.values()) {
    if (!clientIds.has(project.client_id)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.projects references a missing client: ' + String(project.client_id))
  }
  for (const matter of matterRows.values()) {
    if (matter.client_id !== null && matter.client_id !== undefined && !clientIds.has(matter.client_id)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle ledger matter ' + matter.id + ' references a missing client')
    if (matter.project_id !== null && matter.project_id !== undefined) {
      const project = projectRows.get(matter.project_id)
      if (!project) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle ledger matter ' + matter.id + ' references a missing project')
      if (matter.client_id === null || matter.client_id === undefined || project.client_id !== matter.client_id) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle ledger matter ' + matter.id + ' belongs to a project of another client')
    }
  }
  for (const note of store.db.prepare('SELECT id, client_id, project_id, matter_id FROM client_notes').all()) {
    if (!clientIds.has(note.client_id)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.client_notes references a missing client')
    if (note.project_id !== null && note.project_id !== undefined) {
      const project = projectRows.get(note.project_id)
      if (!project || project.client_id !== note.client_id) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.client_notes references a project of another client')
    }
    if (note.matter_id !== null && note.matter_id !== undefined) {
      const matter = matterRows.get(note.matter_id)
      if (!matter) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.client_notes references a missing matter')
      if (matter.client_id !== null && matter.client_id !== undefined && matter.client_id !== note.client_id) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.client_notes references a matter of another client')
    }
  }
  for (const delivery of store.db.prepare('SELECT id, client_id, project_id, matter_id FROM deliveries').all()) {
    let clientId = delivery.client_id ?? null
    let projectId = delivery.project_id ?? null
    const before = String(clientId) + ':' + String(projectId)
    if (projectId !== null) {
      const project = projectRows.get(projectId)
      if (!project) { clientId = null; projectId = null }
      else clientId = project.client_id
    } else if (clientId !== null && !clientIds.has(clientId)) {
      clientId = null
    }
    if (projectId === null && clientId === null && delivery.matter_id !== null && delivery.matter_id !== undefined) {
      const matter = matterRows.get(delivery.matter_id)
      if (matter && matter.client_id !== null && matter.client_id !== undefined && clientIds.has(matter.client_id)) {
        clientId = matter.client_id
        const project = matter.project_id === null || matter.project_id === undefined ? undefined : projectRows.get(matter.project_id)
        if (project && project.client_id === clientId) projectId = project.id
      }
    }
    if (before !== String(clientId) + ':' + String(projectId)) {
      store.db.prepare('UPDATE deliveries SET client_id = ?, project_id = ? WHERE id = ?').run(clientId, projectId, delivery.id)
      report.reconciled.deliveries += 1
    }
  }
  const docIds = new Set(store.db.prepare('SELECT id FROM kb_documents').all().map((row) => row.id))
  for (const chunk of store.db.prepare('SELECT id, doc_id FROM kb_chunks').all()) {
    if (!docIds.has(chunk.doc_id)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.kb_chunks references a missing document: ' + String(chunk.doc_id))
  }
  const matterIds = new Set(store.db.prepare('SELECT id FROM matters').all().map((row) => row.id))
  for (const doc of store.db.prepare('SELECT id, client_id, project_id, matter_id FROM kb_documents').all()) {
    const nextClient = doc.client_id !== null && clientIds.has(doc.client_id) ? doc.client_id : null
    const nextProject = doc.project_id !== null && projectRows.has(doc.project_id) ? doc.project_id : null
    const nextMatter = doc.matter_id !== null && matterIds.has(doc.matter_id) ? doc.matter_id : null
    if (nextClient !== doc.client_id || nextProject !== doc.project_id || nextMatter !== doc.matter_id) {
      store.db.prepare('UPDATE kb_documents SET client_id = ?, project_id = ?, matter_id = ? WHERE id = ?').run(nextClient, nextProject, nextMatter, doc.id)
      report.reconciled.kbDocuments += 1
    }
  }
  for (const link of store.db.prepare('SELECT fact_id, doc_id FROM kb_fact_links').all()) {
    if (!docIds.has(link.doc_id)) {
      store.db.prepare('DELETE FROM kb_fact_links WHERE fact_id = ? AND doc_id = ?').run(link.fact_id, link.doc_id)
      report.reconciled.kbFactLinks += 1
    }
  }
  report.reconciled.kbPagesCleared = Number(store.db.prepare('DELETE FROM kb_pages').run().changes ?? 0)
  try { store.rebuildAllFtsIndexes(); report.ftsRebuilt = true } catch { report.ftsRebuilt = false }
  const commitmentIds = new Set(store.db.prepare('SELECT id FROM commitments').all().map((row) => row.id))
  const receivableRows = store.db.prepare('SELECT id, commitment_id, client_id, currency FROM receivables').all()
  for (const row of receivableRows) {
    if (!commitmentIds.has(row.commitment_id)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.receivables references a missing commitment: ' + String(row.commitment_id))
    if (!clientIds.has(row.client_id)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.receivables references a missing client: ' + String(row.client_id))
  }
  for (const payment of store.db.prepare('SELECT id, client_id, commitment_id, currency FROM payments').all()) {
    if (!clientIds.has(payment.client_id)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.payments references a missing client')
    if (payment.commitment_id !== null && !commitmentIds.has(payment.commitment_id)) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.payments references a missing commitment')
    if (payment.commitment_id !== null) {
      const receivable = receivableRows.find((row) => row.commitment_id === payment.commitment_id)
      if (receivable && receivable.currency !== payment.currency) throw bundleError(BUNDLE_ERROR_CODES.INVALID, 'bundle data.payments currency does not match its receivable: ' + String(payment.id))
    }
  }
  return report
}

function importFailure(code, message, extra = {}) {
  return {
    ok: false,
    code,
    dryRun: Boolean(extra.dryRun),
    bundleDir: extra.bundleDir ?? null,
    bootstrap: extra.bootstrap ?? null,
    replaceRequired: extra.replaceRequired ?? null,
    backup: extra.backup ?? null,
    rolledBack: extra.rolledBack === true,
    dataDigest: extra.dataDigest ?? null,
    computedDataDigest: extra.computedDataDigest ?? null,
    expectedDigest: extra.expectedDigest ?? null,
    dataDigestMatch: extra.dataDigestMatch ?? null,
    counts: extra.counts ?? {},
    tables: extra.tables ?? [],
    restored: extra.restored ?? null,
    pagesRebuilt: extra.pagesRebuilt ?? 0,
    ftsRebuilt: extra.ftsRebuilt === true,
    syncStateCleared: extra.syncStateCleared === true,
    schemaVersion: extra.schemaVersion ?? null,
    verification: extra.verification ?? null,
    errors: [].concat(extra.errors ?? [message]).map((item) => String(item).slice(0, 600)),
    warnings: extra.warnings ?? [],
  }
}

/**
 * Verify + import a bundle into a local SQLite home.
 *
 * Order is fail-closed: offline verify (zero write) -> inspect the local
 * database (read only) -> dry-run plan (zero write, no HOME creation) ->
 * pre-import managed backup (existing DB only, failure aborts) -> one
 * saveWithAudit transaction restoring the ledger + every data table -> clear
 * the derived kb_pages and rebuild it + FTS -> clear sync.state.json.
 *
 * @param {object} options
 * @param {string} options.bundleDir bundle directory (alias `dir`)
 * @param {string} [options.home] ADVISERS_HOME of the target (derived from
 *        dbPath/store when omitted)
 * @param {string} [options.dbPath] target SQLite file (default <home>/state.db)
 * @param {object} [options.store] an already-open writable store (reused, not closed)
 * @param {boolean} [options.replace=false] required when the local DB has data
 * @param {boolean} [options.dryRun=false] verify + plan only, zero writes
 * @param {boolean} [options.verify=true] verification is mandatory; false is refused
 * @param {string} [options.expectDataDigest] 0.5.1 acceptance: fail closed when
 *        the bundle dataDigest differs (E_BUNDLE_TAMPERED, zero writes) and
 *        report expectedDigest/dataDigestMatch in the JSON result
 * @param {boolean} [options.rebuildPages=true] rebuild kb_pages after import
 * @param {boolean} [options.backup=true] pre-import managed backup when a DB exists
 * @returns {object} JSON-safe result (see docs/PORTABILITY.md)
 */
export function importBundle(options = {}) {
  const warnings = []
  const dryRun = options.dryRun === true
  const replace = options.replace === true
  const rebuildPages = options.rebuildPages !== false
  const wantBackup = options.backup !== false
  const limits = normalizeLimits(options.limits)
  const bundleDir = options.bundleDir ?? options.dir ?? options.from ?? null
  if (typeof bundleDir !== 'string' || !bundleDir.trim()) return importFailure(BUNDLE_ERROR_CODES.INVALID, 'a bundle directory is required (import --bundle <dir>)', { dryRun })
  if (options.verify === false) {
    return importFailure(BUNDLE_ERROR_CODES.INVALID, 'refusing to import without verification: bundle import always verifies the directory first (drop verify:false)', { dryRun, bundleDir })
  }
  const verification = verifyBundleDir(bundleDir, {
    limits,
    includePayload: !dryRun,
    ...(options.expectDataDigest === undefined ? {} : { expectDataDigest: options.expectDataDigest }),
  })
  if (!verification.ok) {
    return importFailure(verification.code ?? BUNDLE_ERROR_CODES.INVALID, 'bundle verification failed; nothing was imported', {
      dryRun, bundleDir: verification.dir, verification, warnings, errors: verification.errors.length ? verification.errors : ['bundle verification failed'],
      expectedDigest: verification.expectedDigest, dataDigestMatch: verification.dataDigestMatch,
    })
  }
  const manifest = verification.manifest
  /** 0.5.1 acceptance fields, carried by every import result (null when not requested). */
  const accept = { expectedDigest: verification.expectedDigest, dataDigestMatch: verification.dataDigestMatch }
  let store = options.store ?? null
  let ownedStore = null
  const home = options.home ? resolve(String(options.home)) : (store?.path ? dirname(resolve(store.path)) : (options.dbPath ? dirname(resolve(String(options.dbPath))) : null))
  const dbPath = options.dbPath ? resolve(String(options.dbPath)) : (store?.path ? resolve(store.path) : (home ? join(home, 'state.db') : null))
  if (!dbPath) {
    return importFailure(BUNDLE_ERROR_CODES.SQLITE_REQUIRED, 'bundle import needs { home }, { dbPath } or { store } pointing at the SQLite database', { dryRun, bundleDir: verification.dir, verification, ...accept })
  }
  if (!store && !options.dbPath && home && existsSync(join(home, 'state.json')) && !existsSync(dbPath)) {
    return importFailure(BUNDLE_ERROR_CODES.SQLITE_REQUIRED, 'the target home uses the JSON store (state.json); bundle import requires the SQLite store (ADVISERS_STORE=sqlite)', { dryRun, bundleDir: verification.dir, verification, warnings, ...accept })
  }
  /** local target state, read-only */
  const target = inspectImportTarget(dbPath, store)
  const bridge = { dryRun, bundleDir: verification.dir, bootstrap: !target.exists || target.empty, verification, warnings, ...accept }
  if (target.error) {
    return importFailure(BUNDLE_ERROR_CODES.TARGET, 'cannot inspect the local database before importing (' + target.error + '); nothing was changed', { ...bridge, errors: ['cannot inspect the local database: ' + target.error] })
  }
  const replaceRequired = target.exists && !target.empty && !replace
  if (dryRun) {
    return {
      ok: true, code: null, dryRun: true, bundleDir: verification.dir,
      bootstrap: !target.exists || target.empty,
      replaceRequired,
      backupPlanned: target.exists,
      dataDigest: manifest.dataDigest,
      computedDataDigest: verification.computedDataDigest,
      expectedDigest: verification.expectedDigest,
      dataDigestMatch: verification.dataDigestMatch,
      counts: manifest.counts,
      tables: manifest.tables,
      schemaVersion: manifest.schemaVersion,
      verification,
      errors: [],
      warnings,
    }
  }
  if (replaceRequired) {
    return importFailure(BUNDLE_ERROR_CODES.TARGET, 'the local database already holds data; pass replace:true to replace it with this bundle', {
      ...bridge, dataDigest: manifest.dataDigest, counts: manifest.counts, tables: manifest.tables, schemaVersion: manifest.schemaVersion,
      errors: ['the local database at ' + dbPath + ' already holds user data (' + String(target.dataRows) + ' data row(s)); pass replace:true to confirm the whole-home replace (a pre-import managed backup is taken first)'],
    })
  }
  const failImport = (code, message, extra = {}) => importFailure(code, message, {
    ...bridge, dataDigest: manifest.dataDigest, counts: manifest.counts, tables: manifest.tables, schemaVersion: manifest.schemaVersion, ...extra,
  })
  try {
    if (!store) {
      try {
        mkdirWithRetrySync(home ?? dirname(dbPath))
        ownedStore = new SqliteStore(dbPath)
        store = ownedStore
      } catch (error) { return failImport(BUNDLE_ERROR_CODES.INVALID, 'cannot open the local database: ' + String(error?.message ?? error)) }
    }
    let backupInfo = null
    if (target.exists && wantBackup) {
      if (!home) return failImport(BUNDLE_ERROR_CODES.IMPORT_BACKUP, 'a pre-import managed backup needs { home }; nothing was imported')
      let made
      try {
        made = createManagedBackup({ home, dbPath, store, tag: 'pre-import', verifyChain: true, writeSha256: true, writeAnchor: true })
      } catch (error) {
        return failImport(BUNDLE_ERROR_CODES.IMPORT_BACKUP, 'the pre-import managed backup failed: ' + String(error?.message ?? error) + '; the local database was left untouched')
      }
      for (const warning of made?.warnings ?? []) warnings.push(warning)
      if (!made?.ok) {
        return failImport(BUNDLE_ERROR_CODES.IMPORT_BACKUP, 'the pre-import managed backup failed; the local database was left untouched', {
          errors: ['pre-import managed backup failed: ' + (made?.errors ?? []).join('; ').slice(0, 400)], backup: { ok: false, code: made?.code ?? null },
        })
      }
      backupInfo = { ok: true, path: made.path, bytes: made.bytes, sha256: made.sha256 ?? null, auditCount: made.audit?.count ?? null, sidecars: made.sidecars ?? null, reused: false }
    }
    const payload = verification.payload
    if (!isPlainObject(payload) || !isPlainObject(payload.ledger) || !isPlainObject(payload.data)) {
      return failImport(BUNDLE_ERROR_CODES.INVALID, 'the verified bundle payload is not usable; nothing was imported', { backup: backupInfo })
    }
    let restored = null
    try {
      store.saveWithAudit(payload.ledger, { actor: 'local', action: 'import.bundle', allowed: true, reason: basename(verification.dir) }, (innerStore) => {
        restored = restoreBundleData(innerStore, payload.data)
      })
    } catch (error) {
      return failImport(BUNDLE_ERROR_CODES.INVALID, 'import transaction failed and was rolled back: ' + String(error?.message ?? error).slice(0, 500), { backup: backupInfo, rolledBack: true })
    }
    let pagesRebuilt = 0
    if (rebuildPages) {
      try {
        const rebuilt = kbPageRebuild(store, {})
        pagesRebuilt = Number(rebuilt?.counts?.written ?? 0)
      } catch (error) { warnings.push('kb page rebuild after import failed: ' + String(error?.message ?? error).slice(0, 200) + ' (run advisers kb page rebuild)') }
    }
    let syncStateCleared = false
    if (home) {
      const syncStatePath = join(home, 'sync.state.json')
      if (existsSync(syncStatePath)) {
        try { rmWithRetrySync(syncStatePath); syncStateCleared = true }
        catch (error) { warnings.push('could not clear sync.state.json: ' + String(error?.message ?? error).slice(0, 200)) }
      }
    }
    return {
      ok: true,
      code: null,
      dryRun: false,
      bundleDir: verification.dir,
      bootstrap: !target.exists || target.empty,
      replaceRequired: false,
      replaced: target.exists,
      backup: backupInfo,
      rolledBack: false,
      dataDigest: manifest.dataDigest,
      computedDataDigest: verification.computedDataDigest,
      expectedDigest: verification.expectedDigest,
      dataDigestMatch: verification.dataDigestMatch,
      counts: manifest.counts,
      tables: manifest.tables,
      schemaVersion: manifest.schemaVersion,
      restored,
      pagesRebuilt,
      ftsRebuilt: restored?.ftsRebuilt === true,
      syncStateCleared,
      verification,
      errors: [],
      warnings,
    }
  } finally {
    if (ownedStore) { try { ownedStore.close() } catch {} }
  }
}

/**
 * 0.5.1 acceptance helper (plan 201): compare two bundle directories without
 * trusting either of them. Each directory is verified offline first; `match` is
 * true only when BOTH verify and their recomputed dataDigest is equal (counts
 * differences are listed for diagnosis).
 *
 * Schema-version aware: when the two bundles were written by different schemas
 * (a 0.5.0 v22 bundle vs a v23 re-export) their dataDigest domains legitimately
 * differ, so the comparison happens on the OLDER bundle's table set and the
 * result reports schemaVersionAdjusted/comparedTables. This is the "did a v22
 * bundle survive the v23 migration" acceptance check.
 *
 * This is the lib side of "bundle compare A B" and of the "did the migration
 * carry the same data?" drill step; it never opens a HOME and never writes.
 *
 * @param {string} dirA first bundle directory
 * @param {string} dirB second bundle directory
 * @param {{limits?:object}} [options]
 * @returns {{ok:boolean, code:string|null, match:boolean,
 *   a:object, b:object, differences:Array<{field:string,a:any,b:any}>,
 *   errors:string[], warnings:string[]}}
 */
export function compareBundleDirs(dirA, dirB, options = {}) {
  const limits = normalizeLimits(options?.limits)
  const a = verifyBundleDir(dirA, { limits })
  const b = verifyBundleDir(dirB, { limits })
  const errors = []
  const differences = []
  if (!a.ok) addError(errors, 'bundle A is not a valid bundle (' + String(a.code ?? 'unknown') + ')')
  if (!b.ok) addError(errors, 'bundle B is not a valid bundle (' + String(b.code ?? 'unknown') + ')')
  const bothValid = a.ok && b.ok
  let match = false
  let domainAdjusted = false
  let comparedTables = null
  let aDomainDigest = null
  let bDomainDigest = null
  if (bothValid) {
    if (a.schemaVersion === b.schemaVersion) {
      comparedTables = [...a.tables]
      aDomainDigest = a.dataDigest
      bDomainDigest = b.dataDigest
    } else {
      // Schema upgrade/downgrade (e.g. a 0.5.0 v22 bundle vs a v23 re-export):
      // the dataDigest domains legitimately differ, so the two bundles are
      // compared on the OLDER bundle's table set. This is the "did the v22
      // bundle survive the v23 migration?" acceptance question.
      const older = (a.schemaVersion ?? 0) <= (b.schemaVersion ?? 0) ? a : b
      comparedTables = [...older.tables]
      domainAdjusted = true
      const aPayload = a.payload ?? verifyBundleDir(dirA, { limits, includePayload: true }).payload
      const bPayload = b.payload ?? verifyBundleDir(dirB, { limits, includePayload: true }).payload
      try {
        aDomainDigest = isPlainObject(aPayload?.data) ? computeBundleDataDigest(aPayload.data, { tables: comparedTables }).dataDigest : null
        bDomainDigest = isPlainObject(bPayload?.data) ? computeBundleDataDigest(bPayload.data, { tables: comparedTables }).dataDigest : null
      } catch (error) {
        addError(errors, 'cannot recompute the shared dataDigest domain: ' + String(error?.message ?? error).slice(0, 200))
      }
    }
    match = typeof aDomainDigest === 'string' && aDomainDigest === bDomainDigest
    const tablesToCompare = domainAdjusted ? comparedTables : [...new Set([...Object.keys(a.counts ?? {}), ...Object.keys(b.counts ?? {})])].sort()
    for (const table of tablesToCompare) {
      const left = a.counts?.[table] ?? null
      const right = b.counts?.[table] ?? null
      if (left !== right) differences.push({ field: 'counts.' + table, a: left, b: right })
    }
    if (!domainAdjusted) {
      if (a.dataDigest !== b.dataDigest) differences.push({ field: 'dataDigest', a: a.dataDigest, b: b.dataDigest })
      if (JSON.stringify(a.tables) !== JSON.stringify(b.tables)) differences.push({ field: 'tables', a: a.tables, b: b.tables })
    }
    if (!match) {
      differences.unshift({
        field: domainAdjusted ? 'dataDigest(domain v' + String((a.schemaVersion ?? 0) <= (b.schemaVersion ?? 0) ? a.schemaVersion : b.schemaVersion) + ')' : 'dataDigest',
        a: aDomainDigest,
        b: bDomainDigest,
      })
      addError(errors, domainAdjusted
        ? 'bundle dataDigest differs on the shared ' + comparedTables.length + '-table domain: A ' + String(aDomainDigest ?? 'unavailable') + ', B ' + String(bDomainDigest ?? 'unavailable')
        : 'bundle dataDigest differs: A ' + String(a.dataDigest ?? 'unavailable') + ', B ' + String(b.dataDigest ?? 'unavailable'))
    }
  }
  const code = !a.ok
    ? (a.code ?? BUNDLE_ERROR_CODES.INVALID)
    : (!b.ok ? (b.code ?? BUNDLE_ERROR_CODES.INVALID) : (match ? null : BUNDLE_ERROR_CODES.TAMPERED))
  const summarize = (result, domainDigest) => ({
    dir: result.dir, ok: result.ok, code: result.code, format: result.format,
    version: result.version, scope: result.scope, schemaVersion: result.schemaVersion,
    dataDigest: result.dataDigest, computedDataDigest: result.computedDataDigest,
    domainDigest: domainDigest ?? result.dataDigest,
    manifestDigest: result.manifestDigest, counts: result.counts, tables: result.tables,
    fileCount: result.fileCount, checksumCount: result.checksumCount,
  })
  return {
    ok: Boolean(bothValid && match),
    code,
    match: Boolean(match),
    schemaVersionAdjusted: Boolean(domainAdjusted),
    comparedTables: comparedTables ? [...comparedTables] : null,
    a: summarize(a, aDomainDigest),
    b: summarize(b, bDomainDigest),
    differences,
    errors,
    warnings: [...new Set([...(a.warnings ?? []), ...(b.warnings ?? [])])],
  }
}

export default Object.freeze({
  BUNDLE_MANIFEST_FORMAT,
  BUNDLE_MANIFEST_VERSION,
  BUNDLE_SCOPE,
  BUNDLE_VERIFICATION_BASIS,
  BUNDLE_MANIFEST_FILE,
  BUNDLE_LEDGER_FILE,
  BUNDLE_IMPORT_FILE,
  BUNDLE_FORMAT_FILE,
  BUNDLE_SHA256SUMS_FILE,
  BUNDLE_FACTS_FILE,
  BUNDLE_KB_DIR,
  BUNDLE_PAGES_DIR,
  BUNDLE_REQUIRED_FILES,
  BUNDLE_FILE_MODE,
  BUNDLE_DIR_MODE,
  BUNDLE_LIMIT_CODE,
  BUNDLE_LIMIT_DEFAULTS,
  BUNDLE_ERROR_CODES,
  BUNDLE_ERROR_HINTS,
  BUNDLE_EXCLUDED_TABLES,
  BUNDLE_EXCLUDED,
  BUNDLE_DATA_TABLES,
  BUNDLE_TABLE_ADDITIONS,
  bundleDataTablesForSchema,
  describeBundleCode,
  isUnsafeBundlePath,
  isBundleLayoutPath,
  computeBundleDataDigest,
  dataDigestForStore,
  buildBundle,
  writeBundleDir,
  exportBundle,
  verifyBundleDir,
  verifyBundle,
  readBundleManifestHeader,
  importBundle,
  compareBundleDirs,
})
