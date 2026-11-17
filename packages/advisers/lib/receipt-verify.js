/**
 * Offline verifier for Advisers delivery receipt packs (format v1.1).
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
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  MAX_QUOTE_CHARS,
  RECEIPT_DELIVERIES_PREFIX,
  RECEIPT_MANIFEST_FORMAT,
  RECEIPT_MANIFEST_VERSION,
  RECEIPT_REQUIRED_FILES,
  RECEIPT_SHA256SUMS_FILE,
  isUnsafePackPath,
  sha256Hex,
} from './evidence.js'

const MAX_ERRORS = 300
const SUMS_LINE_RE = /^([0-9a-f]{64})  (.+)$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

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

function walkPackFiles(root) {
  const files = []
  const errors = []
  const stack = ['']
  while (stack.length) {
    const relativeDir = stack.pop()
    const directory = relativeDir ? join(root, ...relativeDir.split('/')) : root
    let dirents
    try {
      dirents = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      addError(errors, 'cannot read directory ' + (relativeDir || '.') + ': ' + (error.code || error.message))
      continue
    }
    for (const dirent of dirents) {
      const relativePath = relativeDir ? relativeDir + '/' + dirent.name : dirent.name
      if (dirent.isSymbolicLink()) {
        addError(errors, 'symbolic links are not allowed in a receipt pack: ' + relativePath)
        continue
      }
      if (dirent.isDirectory()) {
        stack.push(relativePath)
        continue
      }
      if (!dirent.isFile()) {
        addError(errors, 'unsupported file type in receipt pack: ' + relativePath)
        continue
      }
      files.push(relativePath)
    }
  }
  files.sort()
  return { files, errors }
}

// --- manifest schema (format v1; keep it in sync with buildReceiptPack) ------

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

function validateDelivery(delivery, index, sums, deliveryFiles, errors) {
  const where = 'manifest.deliveries[' + index + ']'
  if (!isPlainObject(delivery)) {
    addError(errors, 'schema: ' + where + ' must be an object')
    return
  }
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

function validateEvidenceSource(source, where, errors) {
  if (!isPlainObject(source)) {
    addError(errors, 'schema: ' + where + ' must be an object')
    return
  }
  if (typeof source.sessionId !== 'string') addError(errors, 'schema: ' + where + '.sessionId must be a string')
  if (typeof source.turnId !== 'string') addError(errors, 'schema: ' + where + '.turnId must be a string')
  if (typeof source.quote !== 'string') addError(errors, 'schema: ' + where + '.quote must be a string')
  else {
    if (Array.from(source.quote).length > MAX_QUOTE_CHARS) {
      addError(errors, 'schema: ' + where + '.quote is longer than ' + MAX_QUOTE_CHARS + ' characters')
    }
    if (!isSha256Hex(source.quoteSha256)) addError(errors, 'schema: ' + where + '.quoteSha256 must be 64 lowercase hex characters')
    else if (typeof source.quote === 'string' && sha256Hex(source.quote) !== source.quoteSha256) {
      addError(errors, 'evidence quoteSha256 mismatch at ' + where)
    }
  }
  if (!isNonNegativeInteger(source.quoteChars)) addError(errors, 'schema: ' + where + '.quoteChars must be a non-negative integer')
  else if (typeof source.quote === 'string' && source.quoteChars < Array.from(source.quote).length) {
    addError(errors, 'schema: ' + where + '.quoteChars is smaller than the stored quote')
  }
  if (typeof source.truncated !== 'boolean') addError(errors, 'schema: ' + where + '.truncated must be a boolean')
  if ('turnSeq' in source && !Number.isInteger(source.turnSeq)) addError(errors, 'schema: ' + where + '.turnSeq must be an integer')
  if ('turnRole' in source && typeof source.turnRole !== 'string') addError(errors, 'schema: ' + where + '.turnRole must be a string')
}

function validateEvidenceEntry(entry, index, errors) {
  const where = 'manifest.evidence.entries[' + index + ']'
  if (!isPlainObject(entry)) {
    addError(errors, 'schema: ' + where + ' must be an object')
    return
  }
  if (typeof entry.kind !== 'string' || !entry.kind) addError(errors, 'schema: ' + where + '.kind must be a non-empty string')
  if (typeof entry.id !== 'string') addError(errors, 'schema: ' + where + '.id must be a string')
  if (typeof entry.found !== 'boolean') addError(errors, 'schema: ' + where + '.found must be a boolean')
  if (!Array.isArray(entry.sources)) addError(errors, 'schema: ' + where + '.sources must be an array')
  else entry.sources.forEach((source, sourceIndex) => validateEvidenceSource(source, where + '.sources[' + sourceIndex + ']', errors))
  if (!Array.isArray(entry.missing)) addError(errors, 'schema: ' + where + '.missing must be an array')
  else {
    entry.missing.forEach((item, itemIndex) => {
      const itemWhere = where + '.missing[' + itemIndex + ']'
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
}

function validateEvidence(evidence, errors) {
  if (!isPlainObject(evidence)) {
    addError(errors, 'schema: manifest.evidence must be an object')
    return
  }
  if (typeof evidence.format !== 'string' || !evidence.format) addError(errors, 'schema: manifest.evidence.format must be a non-empty string')
  if (!Number.isInteger(evidence.version) || evidence.version < 1) addError(errors, 'schema: manifest.evidence.version must be a positive integer')
  if (!Array.isArray(evidence.entries)) {
    addError(errors, 'schema: manifest.evidence.entries must be an array')
    return
  }
  evidence.entries.forEach((entry, index) => validateEvidenceEntry(entry, index, errors))
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
}

function validateReceiptManifest(manifest, sums, errors, result) {
  if (!isPlainObject(manifest)) {
    addError(errors, 'schema: manifest.json must be a JSON object')
    return
  }
  if (manifest.format !== RECEIPT_MANIFEST_FORMAT) {
    addError(errors, 'schema: manifest.format must be ' + RECEIPT_MANIFEST_FORMAT)
  }
  if (manifest.version !== RECEIPT_MANIFEST_VERSION) {
    addError(errors, 'schema: manifest.version must be ' + RECEIPT_MANIFEST_VERSION)
  }
  if (!isIsoDate(manifest.createdAt)) addError(errors, 'schema: manifest.createdAt must be an ISO-8601 UTC timestamp')
  validateGenerator(manifest.generator, errors)
  validateRecipient(manifest.recipient, errors)

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
      validateDelivery(delivery, index, sums, deliveryFiles, errors)
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
 * @returns {{ok: boolean, errors: string[], warnings: string[], dir: string,
 *            fileCount: number, checksumCount: number, files: string[],
 *            checksums: Record<string, string>, manifest: object|null,
 *            anchorsRecorded: number, anchorsVerified: boolean, anchored: boolean}}
 */
export function verifyReceiptPackDir(dir) {
  const errors = []
  const warnings = []
  const files = []
  const result = {
    ok: false,
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

  const walked = walkPackFiles(root)
  for (const error of walked.errors) addError(errors, error)
  for (const file of walked.files) files.push(file)
  result.fileCount = files.length
  const fileSet = new Set(files)

  const sumsPath = join(root, RECEIPT_SHA256SUMS_FILE)
  if (!fileSet.has(RECEIPT_SHA256SUMS_FILE)) {
    addError(errors, 'missing file: ' + RECEIPT_SHA256SUMS_FILE)
    return result
  }
  let sumsText
  try {
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

  for (const [name, expected] of parsed.entries) {
    if (!fileSet.has(name)) continue
    const full = join(root, ...name.split('/'))
    try {
      const actual = sha256Hex(readFileSync(full))
      if (actual !== expected) {
        addError(errors, 'hash mismatch: ' + name + ' (expected ' + expected.slice(0, 12) + '..., computed ' + actual.slice(0, 12) + '...)')
      }
    } catch (error) {
      addError(errors, 'cannot read file ' + name + ': ' + (error.code || error.message))
    }
  }

  // receipt.docx structural smoke check (never call Office/WPS to verify it).
  if (fileSet.has('receipt.docx')) {
    try {
      const bytes = readFileSync(join(root, 'receipt.docx'))
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        addError(errors, 'receipt.docx is not a ZIP/DOCX file')
      } else if (!bytes.includes(Buffer.from('word/document.xml', 'utf8'))) {
        addError(errors, 'receipt.docx is missing word/document.xml')
      }
    } catch (error) {
      addError(errors, 'cannot read receipt.docx: ' + (error.code || error.message))
    }
  }

  if (!fileSet.has('manifest.json')) return result
  let manifest = null
  try {
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
