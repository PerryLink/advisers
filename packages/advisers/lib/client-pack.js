/**
 * Client status pack v2 - the offline-verifiable directory form of
 * client export (0.4.0; design 48-customer-v2 section 3.5).
 *
 * A pack is a directory produced by exportClientStatusPack:
 *
 *   manifest.json   format "advisers-client-status-pack", version 1,
 *                   scope "client", subject {kind,id,name}, generatedAt,
 *                   counts, verificationBasis "local-checksums-only",
 *                   files [{path,size,sha256}], generator, fileCount
 *   status.md       the human status sheet (same content as client export)
 *   status.json     the machine status payload (client export --json minus the
 *                   self-referencing out/bytes/sha256 fields)
 *   README.txt      scope, disclaimer and verification steps
 *   SHA256SUMS      coreutils format, every pack file except itself
 *
 * 0.4.0 deliberately contains NO receivable/payment amounts. includeReceivables
 * is reserved for 0.4.1 after legal sign-off: buildClientStatusPack accepts the
 * option only when false/undefined and fails closed otherwise. A status.json
 * that carries money-like fields is rejected by both the builder and the
 * verifier, so an accidental client-show receivables block can never leak into
 * an external pack in this format version.
 *
 * verifyClientStatusPackDir() is the independent offline verifier (it shares no
 * code with the delivery-receipt verifier): it needs no network and no
 * ~/.advisers database. It detects edits, missing files, extra files,
 * duplicate/unsafe SHA256SUMS entries, malformed JSON, schema drift and
 * manifest/checksum disagreement. Like the receipt verifier it cannot detect a
 * forger who rewrites the whole pack and recomputes every checksum; the
 * verificationBasis field exists so no surface claims more than internal
 * consistency. bin/advisers.js dispatches evidence verify by
 * manifest.format (see readClientPackManifestHeader).
 *
 * Resource limits mirror the untrusted-receipt-pack contract: a counterparty
 * pack is walked and hashed with hard caps on entries, depth, single-file size,
 * total bytes, SHA256SUMS and manifest/status bodies, so a hostile directory
 * cannot exhaust memory or time before an integrity verdict is produced.
 */

import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { entityError } from './sqlite.js'

/* -------------------------------------------------------------------------- */
/* constants                                                                  */
/* -------------------------------------------------------------------------- */

const LF = String.fromCharCode(10)
const BS = String.fromCharCode(92)

/** Manifest format string; evidence verify dispatches on this value. */
export const CLIENT_PACK_MANIFEST_FORMAT = 'advisers-client-status-pack'
/** Current (and only) manifest version. */
export const CLIENT_PACK_MANIFEST_VERSION = 1
/** The pack contains exactly one client's data. */
export const CLIENT_PACK_SCOPE = 'client'
/** Offline verification basis: internal consistency + SHA-256 only. */
export const CLIENT_PACK_VERIFICATION_BASIS = 'local-checksums-only'
/** Files every status pack must carry (SHA256SUMS covers all of them). */
export const CLIENT_PACK_REQUIRED_FILES = Object.freeze(['manifest.json', 'status.md', 'status.json', 'README.txt'])
/** Checksums file name. */
export const CLIENT_PACK_SHA256SUMS_FILE = 'SHA256SUMS'
/** Pack files are owner-read/write only. */
export const CLIENT_PACK_FILE_MODE = 0o600
/** Pack directory is owner-only. */
export const CLIENT_PACK_DIR_MODE = 0o700
/** Stable error code for a pack that exceeds a resource cap. */
export const CLIENT_PACK_LIMIT_CODE = 'E_CLIENT_PACK_LIMIT'
/**
 * Resource limits for building and verifying a pack. A received pack is
 * untrusted input; a normal pack is orders of magnitude below every limit.
 */
export const CLIENT_PACK_LIMIT_DEFAULTS = Object.freeze({
  maxEntries: 1000,
  maxDepth: 6,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxSumsBytes: 64 * 1024,
  maxManifestBytes: 512 * 1024,
})
const LIMIT_LABELS = Object.freeze({
  maxEntries: 'entry count',
  maxDepth: 'directory depth',
  maxFileBytes: 'single file size',
  maxTotalBytes: 'total pack size',
  maxSumsBytes: 'SHA256SUMS size',
  maxManifestBytes: 'manifest size',
})
/** Money-like keys a client status pack v1 must never contain. */
const FORBIDDEN_MONEY_KEYS = Object.freeze([
  'receivables', 'payments', 'amountMinor', 'amount', 'paidMinor', 'paid',
  'outstandingMinor', 'outstanding', 'overdueMinor', 'overpaidMinor', 'unmatchedMinor', 'currency',
])
const DISCLAIMER_ZH = '本文件是状态说明，不是对账单、催款函、发票、收据、合同、法律意见或送达证明；本地生成、无签名、未锚定（仅本地自证）。SHA-256 仅用于检测生成后的改动。'
const DISCLAIMER_EN = 'This is a status summary, not a statement of account, dunning letter, invoice, receipt, contract, legal opinion or proof of delivery. It is generated locally, unsigned and unanchored; SHA-256 only detects edits made after generation.'

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

function packError(message, hint) {
  return entityError('E_CLIENT_PACK_INVALID', message, hint)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function addError(errors, message) {
  if (errors.length < 300) errors.push(message)
  else if (errors.length === 300) errors.push('... too many errors; further details suppressed')
}

function isDateText(value) {
  if (typeof value !== 'string' || !value) return false
  return Number.isFinite(Date.parse(value))
}

function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

function toBuffer(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw packError('client status pack file content must be a string, Buffer or Uint8Array')
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

/** Absolute/backslash/traversal path guard; only forward-slash relative paths. */
export function isUnsafeClientPackPath(name) {
  if (typeof name !== 'string' || !name) return true
  if (name.startsWith('/') || name.startsWith(BS)) return true
  if (name.includes(BS)) return true
  const parts = name.split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return true
  }
  if (parts.length > 1 && name.endsWith('/')) return true
  const first = parts[0]
  if (first.length === 2 && first.charCodeAt(1) === 58) return true
  return false
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

function normalizeLimits(input) {
  const limits = { ...CLIENT_PACK_LIMIT_DEFAULTS }
  if (!isPlainObject(input)) return limits
  for (const key of Object.keys(CLIENT_PACK_LIMIT_DEFAULTS)) {
    if (!(key in input)) continue
    const value = Number(input[key])
    if (Number.isFinite(value) && value > 0) limits[key] = Math.floor(value)
  }
  return limits
}

function makeViolation(limits, limit, actual, file) {
  return { code: CLIENT_PACK_LIMIT_CODE, limit, max: limits[limit], actual, file: file ?? null }
}

function limitMessage(violation) {
  const label = LIMIT_LABELS[violation.limit] ?? violation.limit
  return CLIENT_PACK_LIMIT_CODE + ': client status pack ' + label + ' exceeded the limit ' + violation.max +
    ' (actual ' + violation.actual + (violation.file ? ', first at ' + violation.file : '') + '); refusing to read a pack that could exhaust memory or time.'
}

/** Find the first money-like key in a status payload (depth-capped). */
function findMoneyField(value, path = '', depth = 0) {
  if (depth > 8) return null
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findMoneyField(value[index], path + '[' + index + ']', depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (!isPlainObject(value)) return null
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_MONEY_KEYS.includes(key)) return path ? path + '.' + key : key
    const hit = findMoneyField(value[key], path ? path + '.' + key : key, depth + 1)
    if (hit) return hit
  }
  return null
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

/* -------------------------------------------------------------------------- */
/* file map -> manifest/checksums                                             */
/* -------------------------------------------------------------------------- */

function buildSums(fileContents) {
  const names = [...fileContents.keys()].filter((name) => name !== CLIENT_PACK_SHA256SUMS_FILE).sort()
  const lines = []
  for (const name of names) {
    if (isUnsafeClientPackPath(name)) throw packError('unsafe pack path: ' + name)
    const bytes = toBuffer(fileContents.get(name))
    lines.push(sha256Hex(bytes) + '  ' + name)
  }
  return lines.length ? lines.join(LF) + LF : ''
}

function fileRecords(fileContents) {
  const records = []
  for (const name of [...fileContents.keys()].sort()) {
    if (name === CLIENT_PACK_SHA256SUMS_FILE) continue
    const bytes = toBuffer(fileContents.get(name))
    records.push({ path: name, size: bytes.length, sha256: sha256Hex(bytes) })
  }
  return records
}

/* -------------------------------------------------------------------------- */
/* status markdown fallback                                                   */
/* -------------------------------------------------------------------------- */

function renderStatusMarkdown(status) {
  const subject = status?.subject ?? {}
  const lines = [
    '# 客户状态包 · ' + String(subject.name ?? ''),
    '',
    '> 范围：本文件只含客户 ' + String(subject.id ?? '') + '（' + String(subject.name ?? '') + '）的数据；其他客户数据、全局 facts/preferences、对话原文、证据 quote 与备注正文不在本文件内。',
    '> ' + DISCLAIMER_ZH,
    '',
  ]
  const counts = isPlainObject(status?.counts) ? status.counts : {}
  if (Object.keys(counts).length) {
    lines.push('## 概况', '')
    lines.push(Object.keys(counts).sort().map((key) => key + ': ' + String(counts[key])).join(' · '))
    lines.push('')
  }
  if (Array.isArray(status?.timeline) && status.timeline.length) {
    lines.push('## 最近时间线', '')
    for (const item of status.timeline.slice(0, 20)) {
      lines.push('- ' + String(item?.at ?? '') + '  ' + String(item?.kind ?? '') + '  ' + String(item?.title ?? ''))
    }
    lines.push('')
  }
  lines.push('## 边界与校验', '')
  lines.push('- 生成时间：' + String(status?.generatedAt ?? '') + ' · clearance=0 · verificationBasis=' + CLIENT_PACK_VERIFICATION_BASIS)
  lines.push('- ' + DISCLAIMER_EN)
  return lines.join(LF) + LF
}

/* -------------------------------------------------------------------------- */
/* README                                                                     */
/* -------------------------------------------------------------------------- */

function renderReadme({ subject, generatedAt, version, counts, fileCount }) {
  const countLines = isPlainObject(counts) && Object.keys(counts).length
    ? Object.keys(counts).sort().map((key) => '  ' + key + ': ' + String(counts[key]))
    : ['  (none recorded)']
  return [
    'Advisers client status pack',
    '===========================',
    '',
    'Subject: ' + String(subject.name ?? '') + ' (' + String(subject.id ?? '') + ')',
    'Generated at: ' + generatedAt,
    'Generator: advisers ' + (version ?? 'unknown'),
    'Format: ' + CLIENT_PACK_MANIFEST_FORMAT + ' v' + CLIENT_PACK_MANIFEST_VERSION + ' · scope=' + CLIENT_PACK_SCOPE,
    'Verification basis: ' + CLIENT_PACK_VERIFICATION_BASIS,
    '',
    'Contents',
    '--------',
    'manifest.json   subject, scope, counts, file list and sha256 of every file',
    'status.md       human-readable status summary',
    'status.json     machine-readable status payload (no self-referencing path/hash)',
    'README.txt      this file',
    'SHA256SUMS      sha256 of every other file in this directory',
    'File count: ' + fileCount,
    '',
    'Counts',
    '------',
    ...countLines,
    '',
    'Scope',
    '-----',
    'This pack contains data for exactly one client (' + String(subject.id ?? '') + ').',
    'It does not contain other clients, global facts/preferences, conversation',
    'transcripts, evidence quotes or note bodies. It does NOT contain receivable',
    'or payment amounts in 0.4.0: local bookkeeping amounts stay in the local',
    'database until a later format version is reviewed.',
    '',
    'Disclaimer',
    '----------',
    DISCLAIMER_ZH,
    DISCLAIMER_EN,
    '',
    'Verify (offline; no ~/.advisers database needed)',
    '------------------------------------------------',
    '1. advisers evidence verify <this-directory>',
    '2. or with coreutils: cd <this-directory> && sha256sum -c SHA256SUMS',
    '',
    'The checksums detect edits made after generation. They are not a signature,',
    'not a trusted timestamp and not notarization: anyone able to rewrite the whole',
    'pack can recompute them. Offline verification proves that the pack is',
    'internally consistent; it does not prove who generated it or when.',
    '',
    'Privacy',
    '-------',
    '- Built locally; no network calls; verification does not open the ledger.',
    '- Contains SHA-256 digests and a bounded status summary; no full ledger dump.',
    '- Deleting this pack does not modify the local ledger or database.',
  ].join(LF) + LF
}

/* -------------------------------------------------------------------------- */
/* builder                                                                    */
/* -------------------------------------------------------------------------- */

function normalizeSubject(raw) {
  if (!isPlainObject(raw)) throw packError('a client status pack requires a subject {kind:"client", id, name}')
  if (raw.kind !== 'client') throw packError('client status pack subject kind must be "client"')
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!id) throw packError('client status pack subject id is required')
  if (!name) throw packError('client status pack subject name is required')
  if (Array.from(name).length > 200) throw packError('client status pack subject name is too long')
  return { kind: 'client', id, name }
}

/**
 * Build the pack file map in memory (no disk writes, no ~/.advisers access).
 *
 * @param {object} options
 * @param {object} options.status the client export --json payload (client
 *        subject, counts, timeline, ...); out/bytes/sha256 are stripped from
 *        status.json. Money-like keys are rejected.
 * @param {string} [options.markdown] the status sheet markdown; when omitted a
 *        deterministic fallback summary is rendered from status.
 * @param {Buffer|Uint8Array} [options.docx] optional status.docx bytes.
 * @param {string|Date} [options.generatedAt] defaults to now.
 * @param {{advisersVersion?:string, nodeVersion?:string, command?:string}} [options.env]
 * @param {boolean} [options.includeReceivables=false] reserved for 0.4.1; true
 *        fails closed in 0.4.0 (legal review pending).
 * @returns {{files: Map<string, Buffer>, manifest: object, manifestText: string,
 *            manifestDigest: string, summary: object}}
 */
export function buildClientStatusPack(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('buildClientStatusPack expects an options object')
  if (options.includeReceivables !== undefined && typeof options.includeReceivables !== 'boolean') {
    throw packError('includeReceivables must be a boolean')
  }
  if (options.includeReceivables === true) {
    throw entityError(
      'E_CLIENT_PACK_RECEIVABLES_UNSUPPORTED',
      'client status pack v1 does not include receivable/payment amounts',
      'amounts stay local in 0.4.0; --include-receivables is reserved until legal review (0.4.1)',
    )
  }
  const statusInput = options.status
  if (!isPlainObject(statusInput)) throw packError('a client status payload (status object) is required')
  const generatedAt = options.generatedAt === undefined || options.generatedAt === null
    ? new Date().toISOString()
    : (options.generatedAt instanceof Date ? options.generatedAt.toISOString() : String(options.generatedAt))
  if (!isDateText(generatedAt)) throw packError('generatedAt must be an ISO date-time')
  const subject = normalizeSubject(options.subject ?? statusInput.subject)
  const counts = isPlainObject(statusInput.counts) ? statusInput.counts : {}
  const version = advisersVersion(options)
  const generator = {
    advisersVersion: version,
    nodeVersion: process.version,
    command: options.env?.command ?? 'client export --pack',
  }
  const statusJson = { ...statusInput }
  delete statusJson.out
  delete statusJson.bytes
  delete statusJson.sha256
  const moneyPath = findMoneyField(statusJson)
  if (moneyPath) {
    throw packError('client status pack v1 must not contain money fields (found "' + moneyPath + '")', 'keep receivable/payment amounts out of export --pack')
  }
  const statusJsonText = stableStringify(statusJson)
  const markdown = typeof options.markdown === 'string' && options.markdown.trim()
    ? (options.markdown.endsWith(LF) ? options.markdown : options.markdown + LF)
    : renderStatusMarkdown({ ...statusJson, generatedAt })
  const fileContents = new Map()
  fileContents.set('status.json', Buffer.from(statusJsonText, 'utf8'))
  fileContents.set('status.md', Buffer.from(markdown, 'utf8'))
  if (options.docx !== undefined && options.docx !== null) {
    fileContents.set('status.docx', toBuffer(options.docx))
  }
  const dataFileCount = fileContents.size
  fileContents.set('README.txt', Buffer.from(renderReadme({
    subject,
    generatedAt,
    version,
    counts,
    fileCount: dataFileCount + 1,
  }), 'utf8'))
  const dataRecords = fileRecords(fileContents)
  const manifest = {
    format: CLIENT_PACK_MANIFEST_FORMAT,
    version: CLIENT_PACK_MANIFEST_VERSION,
    scope: CLIENT_PACK_SCOPE,
    subject,
    generatedAt,
    generator,
    counts,
    verificationBasis: CLIENT_PACK_VERIFICATION_BASIS,
    disclaimer: true,
    fileCount: dataRecords.length,
    files: dataRecords,
  }
  const manifestText = stableStringify(manifest)
  fileContents.set('manifest.json', Buffer.from(manifestText, 'utf8'))
  fileContents.set(CLIENT_PACK_SHA256SUMS_FILE, Buffer.from(buildSums(fileContents), 'utf8'))
  const manifestDigest = sha256Hex(manifestText)
  return {
    files: fileContents,
    manifest,
    manifestText,
    manifestDigest,
    summary: {
      format: CLIENT_PACK_MANIFEST_FORMAT,
      version: CLIENT_PACK_MANIFEST_VERSION,
      scope: CLIENT_PACK_SCOPE,
      subject,
      generatedAt,
      counts,
      verificationBasis: CLIENT_PACK_VERIFICATION_BASIS,
      fileCount: dataRecords.length,
      checksumCount: fileContents.size - 1,
      files: dataRecords,
      manifestDigest,
      includeReceivables: false,
    },
  }
}

/**
 * Write a built pack atomically: staging directory 0700 / files 0600, verify the
 * bytes that reached the disk, then rename into place. A non-empty target is
 * refused unless overwrite is true; when overwriting, the old tree is moved
 * aside (.replaced-<timestamp>) instead of deleted.
 */
export function writeClientStatusPackDir(outDir, built, options = {}) {
  if (!isPlainObject(built) || !(built.files instanceof Map)) throw new TypeError('writeClientStatusPackDir expects the buildClientStatusPack result')
  if (typeof outDir !== 'string' || !outDir.trim()) throw packError('a pack output directory is required')
  const overwrite = options?.overwrite === true
  const target = resolve(outDir)
  mkdirSync(dirname(target), { recursive: true })
  const fileContents = built.files
  for (const name of fileContents.keys()) {
    if (isUnsafeClientPackPath(name)) throw packError('refusing to write unsafe pack path: ' + name)
  }
  let replaced = null
  if (existsSync(target)) {
    const info = statSync(target)
    if (!info.isDirectory()) throw packError('client status pack output exists and is not a directory: ' + target)
    const entries = readdirSync(target)
    if (entries.length && !overwrite) {
      throw packError('client status pack output directory is not empty: ' + target, 'choose a fresh directory or pass overwrite: true')
    }
    if (entries.length) {
      replaced = target + '.replaced-' + new Date().toISOString().replace(/[:.]/g, '-')
      renameSync(target, replaced)
    } else {
      rmdirSync(target)
    }
  }
  const staging = target + '.tmp-' + process.pid + '-' + createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)
  mkdirSync(staging, { recursive: true, mode: CLIENT_PACK_DIR_MODE })
  try { chmodSync(staging, CLIENT_PACK_DIR_MODE) } catch {}
  try {
    for (const path of [...fileContents.keys()].sort()) {
      const bytes = toBuffer(fileContents.get(path))
      const full = join(staging, ...path.split('/'))
      mkdirSync(dirname(full), { recursive: true, mode: CLIENT_PACK_DIR_MODE })
      writeFileSync(full, bytes, { mode: CLIENT_PACK_FILE_MODE })
      try { chmodSync(full, CLIENT_PACK_FILE_MODE) } catch {}
    }
    // Verify what actually reached the disk, not the in-memory strings.
    for (const [path, content] of fileContents) {
      const expected = toBuffer(content)
      const full = join(staging, ...path.split('/'))
      const actual = readFileSync(full)
      if (actual.length !== expected.length) throw packError('written pack file has the wrong size: ' + path)
      if (sha256Hex(actual) !== sha256Hex(expected)) throw packError('written pack file hash mismatch: ' + path)
      if (process.platform !== 'win32' && (statSync(full).mode & 0o777) !== CLIENT_PACK_FILE_MODE) {
        throw packError('written pack file mode is not 0600: ' + path)
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
  try { chmodSync(target, CLIENT_PACK_DIR_MODE) } catch {}
  return { outDir: target, replaced }
}

/**
 * Build + write + offline-verify a client status pack directory. This is the
 * one call bin/advisers.js needs for 'client export <id> --pack'.
 *
 * @returns {object} JSON summary: format/version/scope/subject/out/generatedAt/
 *   fileCount/checksumCount/bytes/manifestDigest/files/verification/replaced
 */
export function exportClientStatusPack(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('exportClientStatusPack expects an options object')
  if (typeof options.outDir !== 'string' || !options.outDir.trim()) throw packError('outDir is required for exportClientStatusPack')
  const built = buildClientStatusPack(options)
  const written = writeClientStatusPackDir(options.outDir, built, { overwrite: options.overwrite === true })
  const verification = verifyClientStatusPackDir(written.outDir, { limits: options.limits })
  if (!verification.ok) {
    throw packError('written client status pack failed verification: ' + verification.errors.slice(0, 3).join(' | '))
  }
  const totalBytes = [...built.files.values()].reduce((sum, content) => sum + toBuffer(content).length, 0)
  return {
    ok: true,
    format: CLIENT_PACK_MANIFEST_FORMAT,
    version: CLIENT_PACK_MANIFEST_VERSION,
    scope: CLIENT_PACK_SCOPE,
    subject: built.summary.subject,
    out: written.outDir,
    replaced: written.replaced,
    generatedAt: built.summary.generatedAt,
    counts: built.summary.counts,
    verificationBasis: CLIENT_PACK_VERIFICATION_BASIS,
    fileCount: built.summary.fileCount,
    checksumCount: built.summary.checksumCount,
    bytes: totalBytes,
    manifestDigest: built.manifestDigest,
    includeReceivables: false,
    files: built.summary.files.map((record) => ({ path: record.path, size: record.size, sha256: record.sha256 })),
    verification,
  }
}

/* -------------------------------------------------------------------------- */
/* verifier                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Parse the strict coreutils-style SHA256SUMS of a client status pack.
 * Every non-empty line must be 64 lowercase hex + two spaces + safe relative
 * path; SHA256SUMS must not list itself and no path may repeat.
 */
export function parseClientPackSums(text) {
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
      addError(errors, 'malformed SHA256SUMS line ' + lineNumber + ': ' + line.slice(0, 80))
      return
    }
    const digest = line.slice(0, 64)
    const name = line.slice(66)
    if (!isHexLower(digest)) {
      addError(errors, 'malformed SHA256SUMS digest on line ' + lineNumber)
      return
    }
    if (line.trim() !== line) {
      addError(errors, 'SHA256SUMS line ' + lineNumber + ': leading/trailing whitespace')
      return
    }
    if (name === CLIENT_PACK_SHA256SUMS_FILE) {
      addError(errors, 'SHA256SUMS must not list itself')
      return
    }
    if (isUnsafeClientPackPath(name)) {
      addError(errors, 'unsafe path in SHA256SUMS: ' + name)
      return
    }
    if (entries.has(name)) {
      addError(errors, 'duplicate entry in SHA256SUMS: ' + name)
      return
    }
    entries.set(name, digest)
  })
  return { entries, errors }
}

function walkPackFiles(root, limits) {
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
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      addError(errors, 'cannot read directory ' + (relativeDir || '.') + ': ' + (error.code || error.message))
      continue
    }
    for (const entry of entries) {
      entryCount += 1
      const relativePath = relativeDir ? relativeDir + '/' + entry.name : entry.name
      if (entryCount > limits.maxEntries) { trip('maxEntries', entryCount, relativePath); break }
      if (entry.isSymbolicLink()) {
        addError(errors, 'symbolic links are not allowed in a client status pack: ' + relativePath)
        continue
      }
      if (entry.isDirectory()) {
        const childDepth = depth + 1
        if (childDepth > limits.maxDepth) { trip('maxDepth', childDepth, relativePath); break }
        stack.push({ relativeDir: relativePath, depth: childDepth })
        continue
      }
      if (!entry.isFile()) {
        addError(errors, 'unsupported file type in client status pack: ' + relativePath)
        continue
      }
      let info
      try {
        info = statSync(join(root, ...relativePath.split('/')))
      } catch (error) {
        addError(errors, 'cannot stat ' + relativePath + ': ' + (error.code || error.message))
        continue
      }
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

function readBoundedText(file, limits, label) {
  const info = statSync(file)
  if (info.size > limits.maxFileBytes) {
    return { error: limitMessage(makeViolation(limits, 'maxFileBytes', info.size, label)), violation: makeViolation(limits, 'maxFileBytes', info.size, label) }
  }
  return { text: readFileSync(file, 'utf8') }
}

function validateManifest(manifest, fileSet, entries, limits, result, errors, warnings) {
  if (!isPlainObject(manifest)) {
    addError(errors, 'manifest.json must be a JSON object')
    return
  }
  if (manifest.format !== CLIENT_PACK_MANIFEST_FORMAT) addError(errors, 'manifest.format must be "' + CLIENT_PACK_MANIFEST_FORMAT + '"')
  if (manifest.version !== CLIENT_PACK_MANIFEST_VERSION) addError(errors, 'manifest.version must be ' + CLIENT_PACK_MANIFEST_VERSION)
  if (manifest.scope !== CLIENT_PACK_SCOPE) addError(errors, 'manifest.scope must be "' + CLIENT_PACK_SCOPE + '"')
  if (manifest.verificationBasis !== CLIENT_PACK_VERIFICATION_BASIS) addError(errors, 'manifest.verificationBasis must be "' + CLIENT_PACK_VERIFICATION_BASIS + '"')
  if (!isDateText(manifest.generatedAt)) addError(errors, 'manifest.generatedAt must be an ISO date-time')
  if (!isPlainObject(manifest.counts)) addError(errors, 'manifest.counts must be an object')
  if (!isPlainObject(manifest.subject) || manifest.subject.kind !== 'client' || typeof manifest.subject.id !== 'string' || !manifest.subject.id || typeof manifest.subject.name !== 'string' || !manifest.subject.name) {
    addError(errors, 'manifest.subject must be {kind:"client", id, name}')
  }
  if (!Array.isArray(manifest.files)) {
    addError(errors, 'manifest.files must be an array')
    return
  }
  if (!isNonNegativeInteger(manifest.fileCount)) addError(errors, 'manifest.fileCount must be a non-negative integer')
  else if (manifest.fileCount !== manifest.files.length) addError(errors, 'manifest.fileCount does not match manifest.files.length')
  const listed = new Set()
  for (const record of manifest.files) {
    if (!isPlainObject(record)) { addError(errors, 'manifest.files entries must be objects'); continue }
    if (typeof record.path !== 'string' || isUnsafeClientPackPath(record.path)) { addError(errors, 'manifest.files has an unsafe path'); continue }
    if (record.path === CLIENT_PACK_SHA256SUMS_FILE || record.path === 'manifest.json') { addError(errors, 'manifest.files must not list ' + record.path); continue }
    if (listed.has(record.path)) { addError(errors, 'manifest.files lists ' + record.path + ' twice'); continue }
    listed.add(record.path)
    if (!entries.has(record.path)) addError(errors, 'manifest.files lists ' + record.path + ' but SHA256SUMS does not cover it')
    if (!isNonNegativeInteger(record.size)) addError(errors, 'manifest.files size for ' + record.path + ' must be a non-negative integer')
    if (!isHexLower(record.sha256)) addError(errors, 'manifest.files sha256 for ' + record.path + ' must be 64 lowercase hex')
    else if (entries.has(record.path) && entries.get(record.path) !== record.sha256) addError(errors, 'manifest sha256 disagrees with SHA256SUMS for ' + record.path)
    if (fileSet.has(record.path)) {
      try {
        const info = statSync(join(result.dir, ...record.path.split('/')))
        if (isNonNegativeInteger(record.size) && info.size !== record.size) addError(errors, 'manifest size disagrees with the file on disk for ' + record.path)
      } catch (error) {
        addError(errors, 'cannot stat ' + record.path + ': ' + (error.code || error.message))
      }
    }
  }
  for (const name of entries.keys()) {
    if (name === 'manifest.json') continue
    if (!listed.has(name)) addError(errors, 'SHA256SUMS covers ' + name + ' but manifest.files does not list it')
  }
  const expectedChecksums = entries.size - 1
  if (manifest.fileCount !== expectedChecksums) addError(errors, 'manifest.fileCount is ' + manifest.fileCount + ' but SHA256SUMS covers ' + expectedChecksums + ' data file(s)')
  // status.json / status.md are part of the contracted layout.
  for (const required of CLIENT_PACK_REQUIRED_FILES) {
    if (!entries.has(required)) addError(errors, 'SHA256SUMS does not cover ' + required)
    if (!fileSet.has(required)) addError(errors, 'missing file: ' + required)
  }
  // status.json must describe the same subject and must not smuggle money in.
  if (fileSet.has('status.json')) {
    let statusJson = null
    try {
      const read = readBoundedText(join(result.dir, 'status.json'), limits, 'status.json')
      if (read.violation) return read.violation
      statusJson = JSON.parse(read.text)
    } catch (error) {
      addError(errors, 'status.json is not valid JSON: ' + (error.message || error))
    }
    if (isPlainObject(statusJson)) {
      const statusSubject = isPlainObject(statusJson.subject) ? statusJson.subject : null
      if (statusSubject && isPlainObject(manifest.subject)) {
        if (statusSubject.id !== manifest.subject.id) addError(errors, 'status.json subject id disagrees with manifest.subject.id')
        if (typeof statusSubject.kind === 'string' && statusSubject.kind !== manifest.subject.kind) addError(errors, 'status.json subject kind disagrees with manifest.subject.kind')
      } else {
        warnings.push('status.json has no subject block to cross-check against manifest.subject')
      }
      const moneyPath = findMoneyField(statusJson)
      if (moneyPath) addError(errors, 'status.json contains money fields (found "' + moneyPath + '") which format v1 forbids')
    }
  }
  if (fileSet.has('status.md')) {
    try {
      const read = readBoundedText(join(result.dir, 'status.md'), limits, 'status.md')
      if (read.violation) return read.violation
      if (!read.text.trim()) addError(errors, 'status.md is empty')
    } catch (error) {
      addError(errors, 'cannot read status.md: ' + (error.code || error.message))
    }
  }
  if (fileSet.has('README.txt')) {
    try {
      const read = readBoundedText(join(result.dir, 'README.txt'), limits, 'README.txt')
      if (read.violation) return read.violation
      if (!read.text.includes(CLIENT_PACK_SHA256SUMS_FILE)) warnings.push('README.txt does not mention ' + CLIENT_PACK_SHA256SUMS_FILE)
    } catch (error) {
      addError(errors, 'cannot read README.txt: ' + (error.code || error.message))
    }
  }
  return null
}

/**
 * Verify a client status pack directory offline.
 *
 * @param {string} dir pack directory produced by exportClientStatusPack
 * @param {{limits?: Partial<typeof CLIENT_PACK_LIMIT_DEFAULTS>}} [options]
 * @returns {{ok:boolean, code:string|null, errors:string[], warnings:string[],
 *            dir:string, format:string|null, version:number|null,
 *            subject:object|null, scope:string|null, verificationBasis:string|null,
 *            fileCount:number, checksumCount:number, files:string[],
 *            checksums:Record<string,string>, manifest:object|null,
 *            totalBytes:number, limits:object, limitViolation:object|null}}
 */
export function verifyClientStatusPackDir(dir, options = {}) {
  const errors = []
  const warnings = []
  const files = []
  const limits = normalizeLimits(options?.limits)
  const result = {
    ok: false,
    code: null,
    errors,
    warnings,
    dir: String(dir),
    format: null,
    version: null,
    subject: null,
    scope: null,
    verificationBasis: null,
    fileCount: 0,
    checksumCount: 0,
    files,
    checksums: {},
    manifest: null,
    totalBytes: 0,
    limits: { ...limits },
    limitViolation: null,
  }
  const failLimit = (violation) => {
    result.code = CLIENT_PACK_LIMIT_CODE
    result.limitViolation = violation
    result.ok = false
    return result
  }
  if (typeof dir !== 'string' || !dir.trim()) {
    addError(errors, 'a client status pack directory is required')
    return result
  }
  let root
  try {
    root = resolve(dir)
  } catch (error) {
    addError(errors, 'invalid client status pack path: ' + (error.message || error))
    return result
  }
  result.dir = root
  if (!existsSync(root)) {
    addError(errors, 'client status pack directory not found: ' + root)
    return result
  }
  let rootStat
  try {
    rootStat = statSync(root)
  } catch (error) {
    addError(errors, 'cannot stat client status pack directory: ' + (error.code || error.message))
    return result
  }
  if (!rootStat.isDirectory()) {
    addError(errors, 'client status pack path is not a directory: ' + root)
    return result
  }
  const walked = walkPackFiles(root, limits)
  for (const error of walked.errors) addError(errors, error)
  for (const file of walked.files) files.push(file)
  result.fileCount = files.length
  result.totalBytes = walked.totalBytes
  if (walked.violation) return failLimit(walked.violation)
  const fileSet = new Set(files)

  if (!fileSet.has(CLIENT_PACK_SHA256SUMS_FILE)) {
    addError(errors, 'missing file: ' + CLIENT_PACK_SHA256SUMS_FILE)
    return result
  }
  let sumsText
  try {
    const info = statSync(join(root, CLIENT_PACK_SHA256SUMS_FILE))
    if (info.size > limits.maxSumsBytes) {
      const violation = makeViolation(limits, 'maxSumsBytes', info.size, CLIENT_PACK_SHA256SUMS_FILE)
      addError(errors, limitMessage(violation))
      return failLimit(violation)
    }
    sumsText = readFileSync(join(root, CLIENT_PACK_SHA256SUMS_FILE), 'utf8')
  } catch (error) {
    addError(errors, 'cannot read SHA256SUMS: ' + (error.code || error.message))
    return result
  }
  const parsed = parseClientPackSums(sumsText)
  for (const error of parsed.errors) addError(errors, error)
  result.checksumCount = parsed.entries.size
  result.checksums = Object.fromEntries([...parsed.entries.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1)))

  for (const required of CLIENT_PACK_REQUIRED_FILES) {
    if (!parsed.entries.has(required)) addError(errors, 'SHA256SUMS does not cover ' + required)
    if (!fileSet.has(required)) addError(errors, 'missing file: ' + required)
  }
  for (const name of parsed.entries.keys()) if (!fileSet.has(name)) addError(errors, 'missing file: ' + name)
  for (const name of fileSet) {
    if (name === CLIENT_PACK_SHA256SUMS_FILE) continue
    if (!parsed.entries.has(name)) addError(errors, 'file not covered by SHA256SUMS: ' + name)
  }

  let hashedTotal = 0
  for (const [name, expected] of parsed.entries) {
    if (!fileSet.has(name)) continue
    const full = join(root, ...name.split('/'))
    try {
      const hashed = hashFileWithLimit(full, limits)
      if (hashed.violation) {
        hashed.violation.file = name
        addError(errors, limitMessage(hashed.violation))
        return failLimit(hashed.violation)
      }
      hashedTotal += hashed.bytes
      if (hashedTotal > limits.maxTotalBytes) {
        const violation = makeViolation(limits, 'maxTotalBytes', hashedTotal, name)
        addError(errors, limitMessage(violation))
        return failLimit(violation)
      }
      if (hashed.sha256 !== expected) addError(errors, 'hash mismatch: ' + name + ' (expected ' + expected.slice(0, 12) + '..., computed ' + hashed.sha256.slice(0, 12) + '...)')
    } catch (error) {
      addError(errors, 'cannot read file ' + name + ': ' + (error.code || error.message))
    }
  }

  if (!fileSet.has('manifest.json')) return result
  let manifest = null
  try {
    const info = statSync(join(root, 'manifest.json'))
    if (info.size > limits.maxManifestBytes) {
      const violation = makeViolation(limits, 'maxManifestBytes', info.size, 'manifest.json')
      addError(errors, limitMessage(violation))
      return failLimit(violation)
    }
    manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  } catch (error) {
    addError(errors, 'manifest.json is not valid JSON: ' + (error.message || error))
    return result
  }
  result.manifest = manifest
  if (isPlainObject(manifest)) {
    result.format = typeof manifest.format === 'string' ? manifest.format : null
    result.version = Number.isInteger(manifest.version) ? manifest.version : null
    result.scope = typeof manifest.scope === 'string' ? manifest.scope : null
    result.verificationBasis = typeof manifest.verificationBasis === 'string' ? manifest.verificationBasis : null
    result.subject = isPlainObject(manifest.subject) ? manifest.subject : null
  }
  const violation = validateManifest(manifest, fileSet, parsed.entries, limits, result, errors, warnings)
  if (violation) return failLimit(violation)
  warnings.push('verification basis is ' + CLIENT_PACK_VERIFICATION_BASIS + ': SHA-256 proves pack internal consistency only, not authorship or generation time')
  result.ok = errors.length === 0
  return result
}

/**
 * Read only manifest.format/version from a directory (bounded). bin/evidence
 * verify uses this to dispatch between the receipt verifier and this pack
 * verifier without trusting the rest of the manifest.
 *
 * @returns {{ok:boolean, format:string|null, version:number|null, error:string|null}}
 */
export function readClientPackManifestHeader(dir, options = {}) {
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

export default Object.freeze({
  CLIENT_PACK_MANIFEST_FORMAT,
  CLIENT_PACK_MANIFEST_VERSION,
  CLIENT_PACK_SCOPE,
  CLIENT_PACK_VERIFICATION_BASIS,
  CLIENT_PACK_REQUIRED_FILES,
  CLIENT_PACK_SHA256SUMS_FILE,
  CLIENT_PACK_FILE_MODE,
  CLIENT_PACK_DIR_MODE,
  CLIENT_PACK_LIMIT_CODE,
  CLIENT_PACK_LIMIT_DEFAULTS,
  isUnsafeClientPackPath,
  buildClientStatusPack,
  writeClientStatusPackDir,
  exportClientStatusPack,
  parseClientPackSums,
  verifyClientStatusPackDir,
  readClientPackManifestHeader,
})
