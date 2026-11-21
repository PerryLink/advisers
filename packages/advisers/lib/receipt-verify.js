/**
 * Offline verifier for Advisers delivery receipt packs (manifest v1 and v2).
 *
 * A receipt pack is a directory produced by buildReceiptPack in lib/evidence.js:
 *
 *   manifest.json    deliveries (relative path / size / SHA-256), generator
 *                    environment, verify results, recipient, anchors, evidence
 *   README.txt       human summary + verification instructions
 *   receipt.docx     generated delivery receipt (DOCX)
 *   SHA256SUMS       lowercase sha256 + two spaces + relative path, for every
 *                    file above and every deliveries/... artifact
 *   deliveries/...   byte-for-byte copies of the delivered artifacts
 *
 * verifyReceiptPackDir() needs no network and no ~/.advisers database: it reads
 * only the given directory. It detects edits, missing files, extra files,
 * duplicate/unsafe SHA256SUMS entries, bad paths, malformed JSON and schema
 * drift. It cannot detect a forger who rewrites the whole pack and recomputes
 * every checksum — that is what an external signature/anchor would add, and the
 * README must disclose when there is none.
 *
 * Anchors (manifest.anchors) are NOT verified by this tool (security audit
 * SEC2-05, 2026-11-17): only their shape and their file digest cross-check are
 * validated, and the proof itself is opaque. A pack with recorded anchors is
 * therefore reported as anchorsVerified:false / anchored:false with an explicit
 * warning; the adapter named in each anchor must verify its proof out of band.
 *
 * The verifier deliberately does not trust manifest.json before SHA256SUMS
 * matches: checksums are verified first, then the manifest schema is checked.
 *
 * Resource limits (0.3.0, 04-0.3-research §4.12): a receipt pack arrives from a
 * counterparty, so every read is capped -- entries, directory depth, single-file
 * size, total bytes, SHA256SUMS size and manifest size (RECEIPT_LIMIT_DEFAULTS).
 * Hits are reported with the stable code E_RECEIPT_LIMIT plus structured
 * metadata {limit, max, actual, file}; files are hashed in 1 MiB chunks instead
 * of being loaded whole, and receipt.docx is scanned in chunks as well. Normal
 * v1/v1.1 packs are far below every limit and are unaffected.
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  EVIDENCE_KINDS,
  EVIDENCE_PACK_VERSIONS,
  EVIDENCE_RESOLUTIONS,
  MAX_QUOTE_CHARS,
  RECEIPT_DELIVERIES_PREFIX,
  RECEIPT_MANIFEST_FORMAT,
  RECEIPT_MANIFEST_VERSIONS,
  RECEIPT_REQUIRED_FILES,
  RECEIPT_SCOPES,
  RECEIPT_SHA256SUMS_FILE,
  RECEIPT_SUBJECT_KINDS,
  VERIFICATION_BASES,
  isUnsafePackPath,
  sha256Hex,
} from './evidence.js'

const MAX_ERRORS = 300
const SUMS_LINE_RE = /^([0-9a-f]{64})  (.+)$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

/** Stable error code for a receipt pack that exceeds a resource limit. */
export const RECEIPT_LIMIT_CODE = 'E_RECEIPT_LIMIT'
/**
 * Resource limits for verifying an UNTRUSTED receipt pack (04-0.3-research
 * §4.12). A receipt pack arrives from a counterparty: without caps, a 100k-file
 * directory, a 100-level path nest, a multi-GiB file or a huge SHA256SUMS could
 * exhaust memory/time before any integrity result is produced. Limits apply to
 * both the directory walk and every read/hash, so a file growing during the
 * check cannot bypass the stat-time cap. Normal packs (5 required files + a
 * handful of deliveries) are orders of magnitude below every limit.
 */
export const RECEIPT_LIMIT_DEFAULTS = Object.freeze({
  maxEntries: 5000,
  maxDepth: 8,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxSumsBytes: 64 * 1024,
  maxManifestBytes: 1024 * 1024,
})
const LIMIT_LABELS = Object.freeze({
  maxEntries: 'entry count',
  maxDepth: 'directory depth',
  maxFileBytes: 'single file size',
  maxTotalBytes: 'total pack size',
  maxSumsBytes: 'SHA256SUMS size',
  maxManifestBytes: 'manifest size',
})

function normalizeLimits(input) {
  const limits = { ...RECEIPT_LIMIT_DEFAULTS }
  if (!input || typeof input !== 'object') return limits
  for (const key of Object.keys(RECEIPT_LIMIT_DEFAULTS)) {
    if (!(key in input)) continue
    const value = Number(input[key])
    if (Number.isFinite(value) && value > 0) limits[key] = Math.floor(value)
  }
  return limits
}

function limitMessage(violation) {
  const label = LIMIT_LABELS[violation.limit] ?? violation.limit
  return RECEIPT_LIMIT_CODE + ': receipt pack ' + label + ' exceeded the limit ' + violation.max +
    ' (actual ' + violation.actual + (violation.file ? ', first at ' + violation.file : '') + '); refusing to read a pack that could exhaust memory or time. ' +
    'A legitimate pack is far below these limits; inspect the pack before retrying.'
}

function makeViolation(limits, limit, actual, file) {
  return { code: RECEIPT_LIMIT_CODE, limit, max: limits[limit], actual, file: file ?? null }
}

function addError(errors, message) {
  if (errors.length < MAX_ERRORS) errors.push(message)
  else if (errors.length === MAX_ERRORS) errors.push('... too many errors; further details suppressed')
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSha256Hex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * Parse the strict receipt-pack SHA256SUMS format. SHA256SUMS must not list
 * itself (it cannot contain its own digest).
 *
 * @returns {{entries: Map<string, string>, errors: string[]}}
 */
export function parseReceiptSums(text) {
  const entries = new Map()
  const errors = []
  if (typeof text !== 'string') {
    addError(errors, 'SHA256SUMS is missing or unreadable')
    return { entries, errors }
  }
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, index) => {
    const lineNumber = index + 1
    if (raw === '') return
    if (raw.trim() !== raw) {
      addError(errors, 'SHA256SUMS line ' + lineNumber + ': leading/trailing whitespace')
      return
    }
    const match = SUMS_LINE_RE.exec(raw)
    if (!match) {
      addError(errors, 'malformed SHA256SUMS line ' + lineNumber + ': ' + raw.slice(0, 80))
      return
    }
    const name = match[2]
    if (name === RECEIPT_SHA256SUMS_FILE) {
      addError(errors, 'SHA256SUMS must not list itself')
      return
    }
    if (isUnsafePackPath(name)) {
      addError(errors, 'unsafe path in SHA256SUMS: ' + name)
      return
    }
    if (entries.has(name)) {
      addError(errors, 'duplicate entry in SHA256SUMS: ' + name)
      return
    }
    entries.set(name, match[1])
  })
  return { entries, errors }
}

/**
 * Walk the pack directory with hard caps on entries, depth, per-file size and
 * total size. Stops at the first violation so a hostile pack (100k entries, a
 * deep nest, huge files) is rejected in roughly O(limit) work instead of O(pack).
 * Returns the violation as a structured object for stable CLI/JSON reporting.
 */
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
    let dirents
    try {
      dirents = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      addError(errors, 'cannot read directory ' + (relativeDir || '.') + ': ' + (error.code || error.message))
      continue
    }
    for (const dirent of dirents) {
      entryCount += 1
      const relativePath = relativeDir ? relativeDir + '/' + dirent.name : dirent.name
      if (entryCount > limits.maxEntries) { trip('maxEntries', entryCount, relativePath); break }
      if (dirent.isSymbolicLink()) {
        addError(errors, 'symbolic links are not allowed in a receipt pack: ' + relativePath)
        continue
      }
      if (dirent.isDirectory()) {
        const childDepth = depth + 1
        if (childDepth > limits.maxDepth) { trip('maxDepth', childDepth, relativePath); break }
        stack.push({ relativeDir: relativePath, depth: childDepth })
        continue
      }
      if (!dirent.isFile()) {
        addError(errors, 'unsupported file type in receipt pack: ' + relativePath)
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

/**
 * Streaming sha256 with a hard byte cap (1 MiB chunks, bounded memory).
 * Returns {sha256, bytes} or {violation} when the file grew past maxBytes
 * after the stat-time check (a file can be swapped/grown between stat and read).
 */
function hashFileWithLimit(file, limits, { chunkSize = 1024 * 1024 } = {}) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(chunkSize, 1024 * 1024))
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

/**
 * receipt.docx structural smoke check without loading the file into memory:
 * ZIP magic in the first bytes + the word/document.xml entry name somewhere in
 * the archive. Never calls Office/WPS. Enforces the single-file byte cap while
 * scanning, since the file may have grown after the walk.
 */
function checkDocxStructure(file, limits) {
  const needle = Buffer.from('word/document.xml', 'utf8')
  const chunkSize = 64 * 1024
  const buffer = Buffer.allocUnsafe(chunkSize)
  let position = 0
  let bytes = 0
  let zip = false
  let hasDocument = false
  let carry = Buffer.alloc(0)
  const fd = openSync(file, 'r')
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, position)
      if (!count) break
      position += count
      bytes += count
      if (bytes > limits.maxFileBytes) return { violation: makeViolation(limits, 'maxFileBytes', bytes, null) }
      const chunk = buffer.subarray(0, count)
      if (bytes === count && count >= 4) zip = chunk[0] === 0x50 && chunk[1] === 0x4b
      const scan = carry.length ? Buffer.concat([carry, chunk]) : chunk
      if (!hasDocument && scan.includes(needle)) hasDocument = true
      carry = scan.subarray(Math.max(0, scan.length - (needle.length - 1)))
    }
  } finally {
    try { closeSync(fd) } catch {}
  }
  return { zip, hasDocument, bytes }
}

// --- manifest schema (format v1/v2; keep it in sync with buildReceiptPack) ----

function validateGenerator(generator, errors) {
  if (!isPlainObject(generator)) {
    addError(errors, 'schema: manifest.generator must be an object')
    return
  }
  for (const key of ['advisersVersion', 'templateName', 'templateVersion', 'command']) {
    if (!(key in generator)) addError(errors, 'schema: manifest.generator.' + key + ' is missing')
    else if (!(generator[key] === null || typeof generator[key] === 'string')) {
      addError(errors, 'schema: manifest.generator.' + key + ' must be a string or null')
    }
  }
  if (typeof generator.nodeVersion !== 'string' || !generator.nodeVersion) {
    addError(errors, 'schema: manifest.generator.nodeVersion must be a non-empty string')
  }
  if (typeof generator.platform !== 'string' || !generator.platform) {
    addError(errors, 'schema: manifest.generator.platform must be a non-empty string')
  }
}

function validateRecipient(recipient, errors) {
  if (recipient === null) return
  if (!isPlainObject(recipient)) {
    addError(errors, 'schema: manifest.recipient must be null or an object')
    return
  }
  for (const key of ['name', 'email', 'note']) {
    if (!(key in recipient)) addError(errors, 'schema: manifest.recipient.' + key + ' is missing')
    else if (!(recipient[key] === null || typeof recipient[key] === 'string')) {
      addError(errors, 'schema: manifest.recipient.' + key + ' must be a string or null')
    }
  }
}

// --- manifest v2 additions (subject / scope / row-level lineage) -------------

function validateSubject(subject, errors) {
  const where = 'manifest.subject'
  if (!isPlainObject(subject)) {
    addError(errors, 'schema: ' + where + ' must be an object')
    return
  }
  if (!RECEIPT_SUBJECT_KINDS.includes(subject.kind)) {
    addError(errors, 'schema: ' + where + '.kind must be one of ' + RECEIPT_SUBJECT_KINDS.map((kind) => '"' + kind + '"').join(', '))
  }
  if (subject.kind === 'none') {
    if ('id' in subject || 'name' in subject) {
      addError(errors, "schema: " + where + " must not carry id/name when kind is 'none'")
    }
    return
  }
  for (const key of ['id', 'name']) {
    if (key in subject && !isNonEmptyString(subject[key])) {
      addError(errors, 'schema: ' + where + '.' + key + ' must be a non-empty string')
    }
  }
  if (!isNonEmptyString(subject.id) && !isNonEmptyString(subject.name)) {
    addError(errors, 'schema: ' + where + ' requires at least one of id/name')
  }
}

function validateScope(scope, errors) {
  if (!RECEIPT_SCOPES.includes(scope)) {
    addError(errors, 'schema: manifest.scope must be one of ' + RECEIPT_SCOPES.map((value) => '"' + value + '"').join(', '))
  }
}

/** v2-only row lineage. v1 rows keep their exact old validation. */
function validateDeliveryLineage(delivery, where, errors) {
  for (const key of ['clientId', 'projectId', 'matterId']) {
    if (key in delivery && !isNonEmptyString(delivery[key])) {
      addError(errors, 'schema: ' + where + '.' + key + ' must be a non-empty string')
    }
  }
  if (!('template' in delivery)) return
  const template = delivery.template
  if (!isPlainObject(template)) {
    addError(errors, 'schema: ' + where + '.template must be an object')
    return
  }
  for (const key of ['name', 'version']) {
    if (!isNonEmptyString(template[key])) {
      addError(errors, 'schema: ' + where + '.template.' + key + ' must be a non-empty string')
    }
  }
  if ('quoteNo' in template && !isNonEmptyString(template.quoteNo)) {
    addError(errors, 'schema: ' + where + '.template.quoteNo must be a non-empty string')
  }
  if ('dataSha256' in template && !isSha256Hex(template.dataSha256)) {
    addError(errors, 'schema: ' + where + '.template.dataSha256 must be 64 lowercase hex characters')
  }
}

function validateDelivery(delivery, index, sums, deliveryFiles, errors, version) {
  const where = 'manifest.deliveries[' + index + ']'
  if (!isPlainObject(delivery)) {
    addError(errors, 'schema: ' + where + ' must be an object')
    return
  }
  if (version === 2) validateDeliveryLineage(delivery, where, errors)
  if (typeof delivery.id !== 'string' || !delivery.id) addError(errors, 'schema: ' + where + '.id must be a non-empty string')
  if (!('title' in delivery) || !(delivery.title === null || typeof delivery.title === 'string')) {
    addError(errors, 'schema: ' + where + '.title must be a string or null')
  }
  if (!('tool' in delivery) || !(delivery.tool === null || typeof delivery.tool === 'string')) {
    addError(errors, 'schema: ' + where + '.tool must be a string or null')
  }
  if (!('validation' in delivery) || !(delivery.validation === null || typeof delivery.validation === 'string')) {
    addError(errors, 'schema: ' + where + '.validation must be a string or null')
  }
  if (!('createdAt' in delivery) || !(delivery.createdAt === null || isIsoDate(delivery.createdAt))) {
    addError(errors, 'schema: ' + where + '.createdAt must be null or an ISO-8601 UTC timestamp')
  }
  if (!Array.isArray(delivery.files) || delivery.files.length === 0) {
    addError(errors, 'schema: ' + where + '.files must be a non-empty array')
    return
  }
  delivery.files.forEach((file, fileIndex) => {
    const fileWhere = where + '.files[' + fileIndex + ']'
    if (!isPlainObject(file)) {
      addError(errors, 'schema: ' + fileWhere + ' must be an object')
      return
    }
    if (typeof file.path !== 'string' || isUnsafePackPath(file.path)) {
      addError(errors, 'schema: ' + fileWhere + '.path must be a safe relative path')
      return
    }
    if (!file.path.startsWith(RECEIPT_DELIVERIES_PREFIX)) {
      addError(errors, 'schema: ' + fileWhere + '.path must start with ' + RECEIPT_DELIVERIES_PREFIX)
    }
    if (typeof file.name !== 'string' || !file.name) addError(errors, 'schema: ' + fileWhere + '.name must be a non-empty string')
    if (!isNonNegativeInteger(file.size)) addError(errors, 'schema: ' + fileWhere + '.size must be a non-negative integer')
    if (!isSha256Hex(file.sha256)) addError(errors, 'schema: ' + fileWhere + '.sha256 must be 64 lowercase hex characters')
    const listed = sums.get(file.path)
    if (listed === undefined) addError(errors, 'file referenced by manifest is not covered by SHA256SUMS: ' + file.path)
    else if (isSha256Hex(file.sha256) && listed !== file.sha256) {
      addError(errors, 'manifest digest disagrees with SHA256SUMS for ' + file.path)
    }
    if (deliveryFiles.has(file.path)) addError(errors, 'duplicate delivery file path in manifest: ' + file.path)
    else deliveryFiles.set(file.path, file.sha256)
  })
}

function validateVerifyResult(result, where, errors) {
  if (!isPlainObject(result)) {
    addError(errors, 'schema: ' + where + ' must be an object')
    return false
  }
  if (!(result.source === null || typeof result.source === 'string')) addError(errors, 'schema: ' + where + '.source must be a string or null')
  if (typeof result.ok !== 'boolean') addError(errors, 'schema: ' + where + '.ok must be a boolean')
  if (!(result.checkedAt === null || isIsoDate(result.checkedAt))) addError(errors, 'schema: ' + where + '.checkedAt must be null or an ISO-8601 UTC timestamp')
  if (!Array.isArray(result.errors) || result.errors.some((item) => typeof item !== 'string')) {
    addError(errors, 'schema: ' + where + '.errors must be an array of strings')
  }
  if (!Array.isArray(result.checks)) {
    addError(errors, 'schema: ' + where + '.checks must be an array')
  } else {
    result.checks.forEach((check, checkIndex) => {
      const checkWhere = where + '.checks[' + checkIndex + ']'
      if (!isPlainObject(check)) {
        addError(errors, 'schema: ' + checkWhere + ' must be an object')
        return
      }
      if (typeof check.id !== 'string' || !check.id) addError(errors, 'schema: ' + checkWhere + '.id must be a non-empty string')
      if (typeof check.ok !== 'boolean') addError(errors, 'schema: ' + checkWhere + '.ok must be a boolean')
      for (const key of ['severity', 'detail']) {
        if (key in check && typeof check[key] !== 'string') addError(errors, 'schema: ' + checkWhere + '.' + key + ' must be a string')
      }
      if ('skipped' in check && typeof check.skipped !== 'boolean') addError(errors, 'schema: ' + checkWhere + '.skipped must be a boolean')
    })
  }
  if (!(result.summary === null || typeof result.summary === 'string')) addError(errors, 'schema: ' + where + '.summary must be a string or null')
  return result.ok === true
}

function validateAnchor(anchor, index, sums, errors) {
  const where = 'manifest.anchors[' + index + ']'
  if (!isPlainObject(anchor)) {
    addError(errors, 'schema: ' + where + ' must be an object')
    return
  }
  if (typeof anchor.file !== 'string' || isUnsafePackPath(anchor.file)) addError(errors, 'schema: ' + where + '.file must be a safe relative path')
  if (!isSha256Hex(anchor.fileSha256)) addError(errors, 'schema: ' + where + '.fileSha256 must be 64 lowercase hex characters')
  if (typeof anchor.adapterId !== 'string' || !anchor.adapterId) addError(errors, 'schema: ' + where + '.adapterId must be a non-empty string')
  if (!(anchor.issuedAt === null || isIsoDate(anchor.issuedAt))) addError(errors, 'schema: ' + where + '.issuedAt must be null or an ISO-8601 UTC timestamp')
  if (typeof anchor.proof !== 'string' || !anchor.proof.length) addError(errors, 'schema: ' + where + '.proof must be a non-empty string')
  if (typeof anchor.file === 'string' && !isUnsafePackPath(anchor.file)) {
    const listed = sums.get(anchor.file)
    if (listed === undefined) addError(errors, 'anchor file is not covered by SHA256SUMS: ' + anchor.file)
    else if (isSha256Hex(anchor.fileSha256) && listed !== anchor.fileSha256) {
      addError(errors, 'anchor fileSha256 disagrees with SHA256SUMS for ' + anchor.file)
    }
  }
}

const TYPED_ITEM_STRING_FIELDS = Object.freeze(['ref', 'sessionId', 'turnId', 'messageId', 'subject', 'docId', 'pageId', 'url', 'tool', 'chunkId'])

function validateEvidenceQuote(source, where, errors) {
  if (typeof source.quote !== 'string') {
    addError(errors, 'schema: ' + where + '.quote must be a string')
    return
  }
  if (Array.from(source.quote).length > MAX_QUOTE_CHARS) {
    addError(errors, 'schema: ' + where + '.quote is longer than ' + MAX_QUOTE_CHARS + ' characters')
  }
  if (!isSha256Hex(source.quoteSha256)) addError(errors, 'schema: ' + where + '.quoteSha256 must be 64 lowercase hex characters')
  else if (sha256Hex(source.quote) !== source.quoteSha256) {
    addError(errors, 'evidence quoteSha256 mismatch at ' + where)
  }
  if (!isNonNegativeInteger(source.quoteChars)) addError(errors, 'schema: ' + where + '.quoteChars must be a non-negative integer')
  else if (source.quoteChars < Array.from(source.quote).length) {
    addError(errors, 'schema: ' + where + '.quoteChars is smaller than the stored quote')
  }
  if (typeof source.truncated !== 'boolean') addError(errors, 'schema: ' + where + '.truncated must be a boolean')
}

function validateEvidenceSourceV2(source, where, errors) {
  if (!isPlainObject(source)) {
    addError(errors, 'schema: ' + where + ' must be an object')
    return
  }
  if (!EVIDENCE_KINDS.includes(source.kind)) {
    addError(errors, 'schema: ' + where + '.kind must be one of ' + EVIDENCE_KINDS.map((kind) => '"' + kind + '"').join(', '))
  }
  if (typeof source.type !== 'string' || !source.type) addError(errors, 'schema: ' + where + '.type must be a non-empty string')
  if (!EVIDENCE_RESOLUTIONS.includes(source.resolution)) {
    addError(errors, 'schema: ' + where + '.resolution must be one of ' + EVIDENCE_RESOLUTIONS.map((value) => '"' + value + '"').join(', '))
  } else if (source.resolution !== 'verified') {
    // The sources[] array is "locally resolved at build time". Unverifiable or
    // not_checked items belong in their own arrays; a pack must not smuggle
    // manual/unverifiable evidence in as a source.
    addError(errors, 'schema: ' + where + '.resolution must be "verified" for entries in sources[]')
  }
  if ((source.kind === 'manual' || source.type === 'manual') && source.resolution === 'verified') {
    addError(errors, 'manual evidence must not be marked verified: ' + where)
  }
  if (source.type === 'conversation') {
    if (typeof source.sessionId !== 'string') addError(errors, 'schema: ' + where + '.sessionId must be a string')
    if (typeof source.turnId !== 'string') addError(errors, 'schema: ' + where + '.turnId must be a string')
  } else {
    if ('sessionId' in source && typeof source.sessionId !== 'string') addError(errors, 'schema: ' + where + '.sessionId must be a string')
    if ('turnId' in source && typeof source.turnId !== 'string') addError(errors, 'schema: ' + where + '.turnId must be a string')
  }
  validateEvidenceQuote(source, where, errors)
  if ('quoteVerified' in source && typeof source.quoteVerified !== 'boolean') {
    addError(errors, 'schema: ' + where + '.quoteVerified must be a boolean')
  }
  for (const key of TYPED_ITEM_STRING_FIELDS) {
    if (key in source && typeof source[key] !== 'string') addError(errors, 'schema: ' + where + '.' + key + ' must be a string')
  }
  if ('retained' in source && typeof source.retained !== 'boolean') addError(errors, 'schema: ' + where + '.retained must be a boolean')
  if ('chunkIndex' in source && !isNonNegativeInteger(source.chunkIndex)) {
    addError(errors, 'schema: ' + where + '.chunkIndex must be a non-negative integer')
  }
  if ('sourceDigest' in source && !isSha256Hex(source.sourceDigest)) {
    addError(errors, 'schema: ' + where + '.sourceDigest must be 64 lowercase hex characters')
  }
  if ('turnSeq' in source && !Number.isInteger(source.turnSeq)) addError(errors, 'schema: ' + where + '.turnSeq must be an integer')
  if ('turnRole' in source && typeof source.turnRole !== 'string') addError(errors, 'schema: ' + where + '.turnRole must be a string')
}

function validateEvidenceSource(source, where, errors, version) {
  if (version >= 2) {
    validateEvidenceSourceV2(source, where, errors)
    return
  }
  if (!isPlainObject(source)) {
    addError(errors, 'schema: ' + where + ' must be an object')
    return
  }
  if (typeof source.sessionId !== 'string') addError(errors, 'schema: ' + where + '.sessionId must be a string')
  if (typeof source.turnId !== 'string') addError(errors, 'schema: ' + where + '.turnId must be a string')
  validateEvidenceQuote(source, where, errors)
  if ('turnSeq' in source && !Number.isInteger(source.turnSeq)) addError(errors, 'schema: ' + where + '.turnSeq must be an integer')
  if ('turnRole' in source && typeof source.turnRole !== 'string') addError(errors, 'schema: ' + where + '.turnRole must be a string')
}

function validateEvidenceTypedItem(item, where, errors, { requireKind = false } = {}) {
  if (!isPlainObject(item)) {
    addError(errors, 'schema: ' + where + ' must be an object')
    return false
  }
  if (typeof item.reason !== 'string' || !item.reason) addError(errors, 'schema: ' + where + '.reason must be a non-empty string')
  if (requireKind && !EVIDENCE_KINDS.includes(item.kind)) {
    addError(errors, 'schema: ' + where + '.kind must be one of ' + EVIDENCE_KINDS.map((kind) => '"' + kind + '"').join(', '))
  } else if ('kind' in item && !EVIDENCE_KINDS.includes(item.kind)) {
    addError(errors, 'schema: ' + where + '.kind must be one of ' + EVIDENCE_KINDS.map((kind) => '"' + kind + '"').join(', '))
  }
  if ('type' in item && (typeof item.type !== 'string' || !item.type)) addError(errors, 'schema: ' + where + '.type must be a non-empty string')
  for (const key of TYPED_ITEM_STRING_FIELDS) {
    if (key in item && typeof item[key] !== 'string') addError(errors, 'schema: ' + where + '.' + key + ' must be a string')
  }
  if ('retained' in item && typeof item.retained !== 'boolean') addError(errors, 'schema: ' + where + '.retained must be a boolean')
  if ('chunkIndex' in item && !isNonNegativeInteger(item.chunkIndex)) {
    addError(errors, 'schema: ' + where + '.chunkIndex must be a non-negative integer')
  }
  if ('quote' in item) {
    if (typeof item.quote !== 'string') addError(errors, 'schema: ' + where + '.quote must be a string')
    else {
      if (Array.from(item.quote).length > MAX_QUOTE_CHARS) {
        addError(errors, 'schema: ' + where + '.quote is longer than ' + MAX_QUOTE_CHARS + ' characters')
      }
      if (!isSha256Hex(item.quoteSha256) || sha256Hex(item.quote) !== item.quoteSha256) {
        addError(errors, 'evidence quoteSha256 mismatch at ' + where)
      }
    }
  }
  return true
}

function validateEvidenceEntry(entry, index, errors, version) {
  const where = 'manifest.evidence.entries[' + index + ']'
  if (!isPlainObject(entry)) {
    addError(errors, 'schema: ' + where + ' must be an object')
    return
  }
  if (typeof entry.kind !== 'string' || !entry.kind) addError(errors, 'schema: ' + where + '.kind must be a non-empty string')
  if (typeof entry.id !== 'string') addError(errors, 'schema: ' + where + '.id must be a string')
  if (typeof entry.found !== 'boolean') addError(errors, 'schema: ' + where + '.found must be a boolean')
  if (!Array.isArray(entry.sources)) addError(errors, 'schema: ' + where + '.sources must be an array')
  else entry.sources.forEach((source, sourceIndex) => validateEvidenceSource(source, where + '.sources[' + sourceIndex + ']', errors, version))
  if (!Array.isArray(entry.missing)) addError(errors, 'schema: ' + where + '.missing must be an array')
  else {
    entry.missing.forEach((item, itemIndex) => {
      const itemWhere = where + '.missing[' + itemIndex + ']'
      if (version >= 2) {
        validateEvidenceTypedItem(item, itemWhere, errors)
        return
      }
      if (!isPlainObject(item)) {
        addError(errors, 'schema: ' + itemWhere + ' must be an object')
        return
      }
      if (typeof item.reason !== 'string' || !item.reason) addError(errors, 'schema: ' + itemWhere + '.reason must be a non-empty string')
      for (const key of ['id', 'ref', 'sessionId', 'turnId']) {
        if (key in item && typeof item[key] !== 'string') addError(errors, 'schema: ' + itemWhere + '.' + key + ' must be a string')
      }
      if ('quote' in item) {
        if (typeof item.quote !== 'string') addError(errors, 'schema: ' + itemWhere + '.quote must be a string')
        else {
          if (Array.from(item.quote).length > MAX_QUOTE_CHARS) {
            addError(errors, 'schema: ' + itemWhere + '.quote is longer than ' + MAX_QUOTE_CHARS + ' characters')
          }
          if (!isSha256Hex(item.quoteSha256) || sha256Hex(item.quote) !== item.quoteSha256) {
            addError(errors, 'evidence quoteSha256 mismatch at ' + itemWhere)
          }
        }
      }
    })
  }
  for (const key of ['unverifiable', 'notChecked']) {
    if (!(key in entry)) continue
    if (!Array.isArray(entry[key])) {
      addError(errors, 'schema: ' + where + '.' + key + ' must be an array')
      continue
    }
    entry[key].forEach((item, itemIndex) => {
      validateEvidenceTypedItem(item, where + '.' + key + '[' + itemIndex + ']', errors, { requireKind: key === 'notChecked' })
    })
  }
}

function tallyEvidenceItems(entries) {
  const byKind = {}
  for (const kind of EVIDENCE_KINDS) byKind[kind] = 0
  let sourceCount = 0
  let missingCount = 0
  let unverifiableCount = 0
  let operatorEnteredCount = 0
  let notCheckedCount = 0
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue
    for (const key of ['sources', 'missing', 'unverifiable', 'notChecked']) {
      const list = Array.isArray(entry[key]) ? entry[key] : []
      if (key === 'sources') sourceCount += list.length
      else if (key === 'missing') missingCount += list.length
      else if (key === 'unverifiable') unverifiableCount += list.length
      else notCheckedCount += list.length
      for (const item of list) {
        const kind = EVIDENCE_KINDS.includes(item?.kind) ? item.kind : 'observed'
        byKind[kind] += 1
        if (key === 'unverifiable' && (item?.kind === 'manual' || item?.type === 'manual')) operatorEnteredCount += 1
      }
    }
  }
  return { byKind, sourceCount, missingCount, unverifiableCount, operatorEnteredCount, notCheckedCount }
}

function validateEvidenceV2(evidence, errors) {
  const tallied = tallyEvidenceItems(evidence.entries)
  if (!isNonNegativeInteger(evidence.notCheckedCount)) {
    addError(errors, 'schema: manifest.evidence.notCheckedCount must be a non-negative integer (v2)')
  } else if (evidence.notCheckedCount !== tallied.notCheckedCount) {
    addError(errors, 'schema: manifest.evidence.notCheckedCount disagrees with the entries')
  }
  if (!isNonNegativeInteger(evidence.unverifiableCount)) {
    addError(errors, 'schema: manifest.evidence.unverifiableCount must be a non-negative integer (v2)')
  } else if (evidence.unverifiableCount !== tallied.unverifiableCount) {
    addError(errors, 'schema: manifest.evidence.unverifiableCount disagrees with the entries')
  }
  if (!isNonNegativeInteger(evidence.operatorEnteredCount)) {
    addError(errors, 'schema: manifest.evidence.operatorEnteredCount must be a non-negative integer (v2)')
  } else if (evidence.operatorEnteredCount !== tallied.operatorEnteredCount) {
    addError(errors, 'schema: manifest.evidence.operatorEnteredCount disagrees with the entries')
  }
  if (!isPlainObject(evidence.byKind)) {
    addError(errors, 'schema: manifest.evidence.byKind must be an object (v2)')
  } else {
    let declaredTotal = 0
    for (const kind of Object.keys(evidence.byKind)) {
      if (!EVIDENCE_KINDS.includes(kind)) addError(errors, 'schema: manifest.evidence.byKind has an unknown kind: ' + kind)
    }
    for (const kind of EVIDENCE_KINDS) {
      const value = evidence.byKind[kind]
      if (!isNonNegativeInteger(value)) {
        addError(errors, 'schema: manifest.evidence.byKind.' + kind + ' must be a non-negative integer')
      } else {
        declaredTotal += value
        if (value !== tallied.byKind[kind]) {
          addError(errors, 'schema: manifest.evidence.byKind.' + kind + ' disagrees with the entries')
        }
      }
    }
    const totalItems = tallied.sourceCount + tallied.missingCount + tallied.unverifiableCount + tallied.notCheckedCount
    if (declaredTotal !== totalItems) addError(errors, 'schema: manifest.evidence.byKind does not sum to the evidence item total')
  }
  if (typeof evidence.verificationBasis !== 'string' || !VERIFICATION_BASES.includes(evidence.verificationBasis)) {
    addError(errors, 'schema: manifest.evidence.verificationBasis must be one of ' + VERIFICATION_BASES.map((value) => '"' + value + '"').join(', ') + ' (v2)')
  }
}

function validateEvidence(evidence, errors) {
  if (!isPlainObject(evidence)) {
    addError(errors, 'schema: manifest.evidence must be an object')
    return
  }
  if (typeof evidence.format !== 'string' || !evidence.format) addError(errors, 'schema: manifest.evidence.format must be a non-empty string')
  if (!Number.isInteger(evidence.version) || !EVIDENCE_PACK_VERSIONS.includes(evidence.version)) {
    addError(errors, 'schema: manifest.evidence.version must be ' + EVIDENCE_PACK_VERSIONS.join(' or ') + ' (got ' + JSON.stringify(evidence.version) + ')')
  }
  if (!Array.isArray(evidence.entries)) {
    addError(errors, 'schema: manifest.evidence.entries must be an array')
    return
  }
  const version = Number.isInteger(evidence.version) ? evidence.version : 1
  evidence.entries.forEach((entry, index) => validateEvidenceEntry(entry, index, errors, version))
  if (evidence.entryCount !== evidence.entries.length) {
    addError(errors, 'schema: manifest.evidence.entryCount must equal the number of entries')
  }
  if (!isNonNegativeInteger(evidence.sourceCount)) addError(errors, 'schema: manifest.evidence.sourceCount must be a non-negative integer')
  if (!isNonNegativeInteger(evidence.missingCount)) addError(errors, 'schema: manifest.evidence.missingCount must be a non-negative integer')
  const actualCounts = {}
  let sourceCount = 0
  let missingCount = 0
  for (const entry of evidence.entries) {
    if (!isPlainObject(entry)) continue
    actualCounts[entry.kind] = (actualCounts[entry.kind] || 0) + 1
    if (Array.isArray(entry.sources)) sourceCount += entry.sources.length
    if (Array.isArray(entry.missing)) missingCount += entry.missing.length
  }
  if (isNonNegativeInteger(evidence.sourceCount) && evidence.sourceCount !== sourceCount) {
    addError(errors, 'schema: manifest.evidence.sourceCount disagrees with the entries')
  }
  if (isNonNegativeInteger(evidence.missingCount) && evidence.missingCount !== missingCount) {
    addError(errors, 'schema: manifest.evidence.missingCount disagrees with the entries')
  }
  if (!isPlainObject(evidence.counts)) {
    addError(errors, 'schema: manifest.evidence.counts must be an object')
  } else {
    let declared = 0
    for (const [kind, value] of Object.entries(actualCounts)) {
      if (evidence.counts[kind] !== value) addError(errors, 'schema: manifest.evidence.counts.' + kind + ' disagrees with the entries')
    }
    for (const value of Object.values(evidence.counts)) {
      if (!isNonNegativeInteger(value)) {
        addError(errors, 'schema: manifest.evidence.counts values must be non-negative integers')
        break
      }
      declared += value
    }
    if (declared !== evidence.entries.length) addError(errors, 'schema: manifest.evidence.counts do not sum to entryCount')
  }
  if (version >= 2) validateEvidenceV2(evidence, errors)
}

function validateReceiptManifest(manifest, sums, errors, result) {
  if (!isPlainObject(manifest)) {
    addError(errors, 'schema: manifest.json must be a JSON object')
    return
  }
  if (manifest.format !== RECEIPT_MANIFEST_FORMAT) {
    addError(errors, 'schema: manifest.format must be ' + RECEIPT_MANIFEST_FORMAT)
  }
  // v1 packs were written by 0.2.x/0.3.x and must keep verifying exactly as
  // before; v2 adds subject/scope/lineage checks below. Anything else is drift.
  if (!RECEIPT_MANIFEST_VERSIONS.includes(manifest.version)) {
    addError(
      errors,
      'schema: manifest.version must be ' + RECEIPT_MANIFEST_VERSIONS.join(' or ') + ' (got ' + JSON.stringify(manifest.version) + ')',
    )
  }
  if (!isIsoDate(manifest.createdAt)) addError(errors, 'schema: manifest.createdAt must be an ISO-8601 UTC timestamp')
  validateGenerator(manifest.generator, errors)
  validateRecipient(manifest.recipient, errors)
  const version = manifest.version
  if (version === 2) {
    if (!('scope' in manifest)) addError(errors, 'schema: manifest.scope is required for manifest version 2')
    else validateScope(manifest.scope, errors)
    if ('subject' in manifest) validateSubject(manifest.subject, errors)
  }

  const deliveryFiles = new Map()
  if (!Array.isArray(manifest.deliveries) || manifest.deliveries.length === 0) {
    addError(errors, 'schema: manifest.deliveries must be a non-empty array')
  } else {
    const ids = new Set()
    manifest.deliveries.forEach((delivery, index) => {
      if (isPlainObject(delivery) && typeof delivery.id === 'string' && delivery.id) {
        if (ids.has(delivery.id)) addError(errors, 'schema: manifest.deliveries[' + index + '].id is duplicated: ' + delivery.id)
        else ids.add(delivery.id)
      }
      validateDelivery(delivery, index, sums, deliveryFiles, errors, version)
    })
  }

  if (!isPlainObject(manifest.receipt)) {
    addError(errors, 'schema: manifest.receipt must be an object')
  } else {
    if (manifest.receipt.path !== 'receipt.docx') addError(errors, 'schema: manifest.receipt.path must be "receipt.docx"')
    if (!isNonNegativeInteger(manifest.receipt.size)) addError(errors, 'schema: manifest.receipt.size must be a non-negative integer')
    if (!isSha256Hex(manifest.receipt.sha256)) addError(errors, 'schema: manifest.receipt.sha256 must be 64 lowercase hex characters')
    const listed = sums.get('receipt.docx')
    if (listed === undefined) addError(errors, 'receipt.docx is not covered by SHA256SUMS')
    else if (isSha256Hex(manifest.receipt.sha256) && listed !== manifest.receipt.sha256) {
      addError(errors, 'manifest digest disagrees with SHA256SUMS for receipt.docx')
    }
  }

  let expectedStatus = 'not-recorded'
  if (!Array.isArray(manifest.verify)) {
    addError(errors, 'schema: manifest.verify must be an array')
  } else {
    let allOk = true
    manifest.verify.forEach((result, index) => {
      if (isPlainObject(result) && result.ok === true) {
        validateVerifyResult(result, 'manifest.verify[' + index + ']', errors)
      } else {
        allOk = false
        validateVerifyResult(result, 'manifest.verify[' + index + ']', errors)
      }
    })
    if (manifest.verify.length) expectedStatus = allOk ? 'passed' : 'failed'
  }
  if (manifest.verifyStatus !== expectedStatus) {
    addError(errors, 'schema: manifest.verifyStatus is ' + JSON.stringify(manifest.verifyStatus) + ' but the verify array implies ' + JSON.stringify(expectedStatus))
  }

  if (!Array.isArray(manifest.anchors)) addError(errors, 'schema: manifest.anchors must be an array')
  else {
    result.anchorsRecorded = manifest.anchors.length
    manifest.anchors.forEach((anchor, index) => validateAnchor(anchor, index, sums, errors))
    if (manifest.anchors.length > 0) {
      // Never present a recorded anchor as verified: the proof was not checked
      // against the named adapter (SEC2-05).
      result.warnings.push('anchors are recorded but NOT cryptographically verified by this tool; verify each proof with the adapter that issued it and do not treat this pack as externally anchored')
    }
  }

  validateEvidence(manifest.evidence, errors)

  const expectedFileCount = RECEIPT_REQUIRED_FILES.length + deliveryFiles.size
  if (manifest.fileCount !== expectedFileCount) {
    addError(errors, 'schema: manifest.fileCount is ' + manifest.fileCount + ' but manifest lists ' + expectedFileCount + ' files')
  }
  if (manifest.fileCount !== sums.size) {
    addError(errors, 'schema: manifest.fileCount is ' + manifest.fileCount + ' but SHA256SUMS has ' + sums.size + ' entries')
  }
  for (const required of RECEIPT_REQUIRED_FILES) {
    if (!sums.has(required)) addError(errors, 'SHA256SUMS does not cover ' + required)
  }
}

// --- directory verifier ------------------------------------------------------

/**
 * Verify a receipt pack directory offline.
 *
 * @param {string} dir pack directory produced by buildReceiptPack({outDir})
 * @param {{limits?: Partial<typeof RECEIPT_LIMIT_DEFAULTS>}} [options]
 *   `limits` lowers/raises the resource caps (tests and the future WebCrypto
 *   verification page use smaller values; the defaults are the contract).
 * @returns {{ok: boolean, errors: string[], warnings: string[], dir: string,
 *            fileCount: number, checksumCount: number, files: string[],
 *            checksums: Record<string, string>, manifest: object|null,
 *            anchorsRecorded: number, anchorsVerified: boolean, anchored: boolean,
 *            limits: object, totalBytes: number, limitViolation: object|null,
 *            code: string|null}}
 *   `code` is 'E_RECEIPT_LIMIT' when a resource cap was hit (with metadata in
 *   limitViolation: {code, limit, max, actual, file}); ok is false in that case
 *   and no manifest/checksum result is trusted.
 */
export function verifyReceiptPackDir(dir, options = {}) {
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
    fileCount: 0,
    checksumCount: 0,
    files,
    checksums: {},
    manifest: null,
    // Anchors are recorded, never verified, by this offline tool (SEC2-05).
    // `ok` covers pack integrity only; it must not be read as "anchored".
    anchorsRecorded: 0,
    anchorsVerified: false,
    anchored: false,
    limits: { ...limits },
    totalBytes: 0,
    limitViolation: null,
  }
  const failLimit = (violation) => {
    result.code = RECEIPT_LIMIT_CODE
    result.limitViolation = violation
    result.ok = false
    return result
  }
  let root
  try {
    root = resolve(String(dir))
  } catch (error) {
    addError(errors, 'invalid receipt pack path: ' + (error.message || error))
    return result
  }
  result.dir = root
  if (!existsSync(root)) {
    addError(errors, 'receipt pack directory not found: ' + root)
    return result
  }
  let rootStat
  try {
    rootStat = statSync(root)
  } catch (error) {
    addError(errors, 'cannot stat receipt pack directory: ' + (error.code || error.message))
    return result
  }
  if (!rootStat.isDirectory()) {
    addError(errors, 'receipt pack path is not a directory: ' + root)
    return result
  }

  const walked = walkPackFiles(root, limits)
  for (const error of walked.errors) addError(errors, error)
  for (const file of walked.files) files.push(file)
  result.fileCount = files.length
  result.totalBytes = walked.totalBytes
  if (walked.violation) return failLimit(walked.violation)
  const fileSet = new Set(files)

  const sumsPath = join(root, RECEIPT_SHA256SUMS_FILE)
  if (!fileSet.has(RECEIPT_SHA256SUMS_FILE)) {
    addError(errors, 'missing file: ' + RECEIPT_SHA256SUMS_FILE)
    return result
  }
  let sumsText
  try {
    const sumsStat = statSync(sumsPath)
    if (sumsStat.size > limits.maxSumsBytes) {
      const violation = makeViolation(limits, 'maxSumsBytes', sumsStat.size, RECEIPT_SHA256SUMS_FILE)
      addError(errors, limitMessage(violation))
      return failLimit(violation)
    }
    sumsText = readFileSync(sumsPath, 'utf8')
  } catch (error) {
    addError(errors, 'cannot read SHA256SUMS: ' + (error.code || error.message))
    return result
  }
  const parsed = parseReceiptSums(sumsText)
  for (const error of parsed.errors) addError(errors, error)
  result.checksumCount = parsed.entries.size
  result.checksums = Object.fromEntries([...parsed.entries.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1)))

  for (const required of RECEIPT_REQUIRED_FILES) {
    if (!parsed.entries.has(required)) addError(errors, 'SHA256SUMS does not cover ' + required)
    if (!fileSet.has(required)) addError(errors, 'missing file: ' + required)
  }
  for (const name of parsed.entries.keys()) {
    if (!fileSet.has(name)) addError(errors, 'missing file: ' + name)
  }
  for (const name of fileSet) {
    if (name === RECEIPT_SHA256SUMS_FILE) continue
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
      const actual = hashed.sha256
      if (actual !== expected) {
        addError(errors, 'hash mismatch: ' + name + ' (expected ' + expected.slice(0, 12) + '..., computed ' + actual.slice(0, 12) + '...)')
      }
    } catch (error) {
      addError(errors, 'cannot read file ' + name + ': ' + (error.code || error.message))
    }
  }

  // receipt.docx structural smoke check (never call Office/WPS to verify it).
  // Streamed with a byte cap: an untrusted pack must not be able to make the
  // verifier allocate a multi-GiB Buffer before reporting a limit error.
  if (fileSet.has('receipt.docx')) {
    try {
      const docx = checkDocxStructure(join(root, 'receipt.docx'), limits)
      if (docx.violation) {
        docx.violation.file = 'receipt.docx'
        addError(errors, limitMessage(docx.violation))
        return failLimit(docx.violation)
      }
      if (!docx.zip) {
        addError(errors, 'receipt.docx is not a ZIP/DOCX file')
      } else if (!docx.hasDocument) {
        addError(errors, 'receipt.docx is missing word/document.xml')
      }
    } catch (error) {
      addError(errors, 'cannot read receipt.docx: ' + (error.code || error.message))
    }
  }

  if (!fileSet.has('manifest.json')) return result
  let manifest = null
  try {
    const manifestStat = statSync(join(root, 'manifest.json'))
    if (manifestStat.size > limits.maxManifestBytes) {
      const violation = makeViolation(limits, 'maxManifestBytes', manifestStat.size, 'manifest.json')
      addError(errors, limitMessage(violation))
      return failLimit(violation)
    }
    manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  } catch (error) {
    addError(errors, 'manifest.json is not valid JSON: ' + (error.message || error))
    return result
  }
  result.manifest = manifest
  validateReceiptManifest(manifest, parsed.entries, errors, result)

  // Size statements in the manifest must match the bytes on disk.
  if (isPlainObject(manifest)) {
    const sizeRecords = []
    if (Array.isArray(manifest.deliveries)) {
      for (const delivery of manifest.deliveries) {
        if (isPlainObject(delivery) && Array.isArray(delivery.files)) {
          for (const file of delivery.files) if (isPlainObject(file)) sizeRecords.push(file)
        }
      }
    }
    if (isPlainObject(manifest.receipt)) sizeRecords.push(manifest.receipt)
    for (const record of sizeRecords) {
      if (typeof record.path !== 'string' || isUnsafePackPath(record.path) || !fileSet.has(record.path)) continue
      try {
        const size = statSync(join(root, ...record.path.split('/'))).size
        if (isNonNegativeInteger(record.size) && size !== record.size) {
          addError(errors, 'schema: manifest size disagrees with the file on disk for ' + record.path)
        }
      } catch (error) {
        addError(errors, 'cannot stat ' + record.path + ': ' + (error.code || error.message))
      }
    }
    if (Array.isArray(manifest.anchors) && manifest.anchors.length === 0) {
      warnings.push('pack is not externally anchored: SHA-256 proves internal consistency only')
    }
    if (manifest.verifyStatus === 'not-recorded') warnings.push('no verify results were recorded in this pack')
  }

  result.ok = errors.length === 0
  return result
}
