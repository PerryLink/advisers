/**
 * Audit tail anchor (Advisers 0.3.0 operations library).
 *
 * The audit table is a hash/MAC chain: every row commits to the previous row's
 * hash, so editing or deleting a row in the middle makes verifyAudit() fail.
 * A *tail* deletion is different: the remaining rows still form a valid chain.
 * This module records a checkpoint that makes a later tail deletion detectable:
 *
 *   $ADVISERS_HOME/audit-anchor.json
 *   {
 *     "format": "advisers-audit-anchor",
 *     "version": 1,
 *     "dbId": "sha256:...",
 *     "count": 1234,
 *     "lastSeq": 1234,
 *     "headHash": "<64 hex>",
 *     "createdAt": "2026-11-19T05:00:00.000Z",
 *     "generator": "advisers/0.3.0",
 *     "keyed": true,
 *     "hmac": "<64 hex|null>"
 *   }
 *
 * Detection semantics (deliberately narrow and honest, 04-0.3-research §4.7):
 *   - current count < anchor count -> E_AUDIT_TAIL_TRUNCATED (tail deleted or DB
 *     rolled back to an older snapshot);
 *   - current count == anchor count but the head hash differs ->
 *     E_AUDIT_HEAD_MISMATCH (last row rewritten, or delete+append);
 *   - current count > anchor count -> ok, status 'grown', caller should anchor
 *     again;
 *   - no anchor -> E_AUDIT_ANCHOR_ABSENT: a yellow state, not proof of
 *     tampering (no baseline was recorded).
 *
 * A local HMAC anchor reduces deniability for accidental edits and casual
 * tampering. It is NOT third-party attestation: the same user who can edit the
 * database can rewrite the anchor, and audit.key is readable by that user.
 * Documentation must never call it tamper-proof / notarised / compliance-grade.
 *
 * The module never repairs, truncates or re-writes the audit chain. It refuses
 * to write an anchor for a broken chain (E_AUDIT_CHAIN_BROKEN) so a bad state is
 * never recorded as a good baseline. Library-only: no bin/ wiring (Wave 2), no
 * network, no new dependency.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './fs-safe.js'

export const AUDIT_ANCHOR_FORMAT = 'advisers-audit-anchor'
export const AUDIT_ANCHOR_VERSION = 1
export const AUDIT_ANCHOR_FILE = 'audit-anchor.json'
export const AUDIT_ANCHOR_MAX_BYTES = 64 * 1024
export const AUDIT_ANCHOR_KEY_ENV = 'ADVISERS_AUDIT_KEY'
export const AUDIT_KEY_FILE_NAME = 'audit.key'
export const AUDIT_MIN_KEY_CHARS = 16

const HEX64_RE = /^[0-9a-f]{64}$/
const DB_ID_RE = /^sha256:[0-9a-f]{64}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
/** Cheap count fallback cap for store-like objects without a raw db handle. */
const LIST_FALLBACK_MAX = 10000

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function isHex64(value) {
  return typeof value === 'string' && HEX64_RE.test(value)
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

/**
 * Stable database identity for anchor cross-checks.
 *
 * Derived from the genesis audit row hash, so every backup/restore of the same
 * ledger shares it, while an anchor copied from a different database does not
 * verify. When the audit is still empty there is no genesis row, hence the
 * 'empty' sentinel; merging logic treats an anchor written at count 0 as
 * compatible with any later non-empty state (its count comparison still holds).
 */
export function computeAuditDbId(genesisHash) {
  const seed = typeof genesisHash === 'string' && genesisHash ? genesisHash : 'empty'
  return 'sha256:' + sha256Hex('advisers-audit-db\n' + seed)
}

/** Deterministic canonical payload covered by the anchor HMAC (hmac excluded). */
export function canonicalAuditAnchorPayload(anchor) {
  const payload = {}
  for (const key of Object.keys(anchor).sort()) {
    if (key === 'hmac') continue
    payload[key] = anchor[key]
  }
  return JSON.stringify(payload)
}

/** HMAC-SHA256(anchorKey, canonical anchor fields); null when no key is used. */
export function computeAuditAnchorHmac(anchor, key) {
  if (typeof key !== 'string' || key.length === 0) return null
  return createHmac('sha256', key).update(canonicalAuditAnchorPayload(anchor)).digest('hex')
}

function hmacMatches(anchor, key) {
  const expected = computeAuditAnchorHmac(anchor, key)
  if (typeof expected !== 'string' || typeof anchor?.hmac !== 'string') return false
  const left = Buffer.from(expected, 'hex')
  const right = Buffer.from(anchor.hmac, 'hex')
  if (left.length === 0 || left.length !== right.length) return false
  try { return timingSafeEqual(left, right) } catch { return false }
}

/** Raw DatabaseSync behind a SqliteStore, when the store exposes it. */
function rawDbOf(store) {
  const db = store?.db
  return db && typeof db.prepare === 'function' ? db : null
}

function readRow(db, sql, ...params) {
  try { return db.prepare(sql).get(...params) ?? null } catch { return null }
}

/**
 * Read the audit tail (count / lastSeq / headHash / genesisHash / dbId).
 *
 * @param {object} store SqliteStore (writable or read-only).
 * @param {{verifyChain?: boolean, listFallbackMax?: number}} [options]
 *   verifyChain=true re-verifies the whole chain first and refuses to produce a
 *   head for a broken chain (default for 'audit --write-anchor'). Callers that
 *   already verified the chain (or cannot afford the O(n) pass for a backup
 *   sidecar) pass verifyChain=false: then only the last row is trusted for
 *   anchoring, and `chainVerified` stays false.
 * @returns {{ok: boolean, code: string|null, count: number|null, lastSeq: number|null,
 *   headHash: string, genesisHash: string|null, dbId: string|null,
 *   chainVerified: boolean, brokenAt: number|null, errors: string[]}}
 */
export function readAuditHead(store, { verifyChain = true, listFallbackMax = LIST_FALLBACK_MAX } = {}) {
  const result = {
    ok: false,
    code: null,
    count: null,
    lastSeq: null,
    headHash: '',
    genesisHash: null,
    dbId: null,
    chainVerified: false,
    brokenAt: null,
    errors: [],
  }
  if (!store || typeof store.listAudit !== 'function') {
    result.code = 'E_AUDIT_ANCHOR_STORE'
    result.errors.push('readAuditHead requires a SqliteStore-like object with listAudit()/verifyAudit()')
    return result
  }
  const db = rawDbOf(store)
  let count = null
  if (verifyChain) {
    if (typeof store.verifyAudit !== 'function') {
      result.code = 'E_AUDIT_ANCHOR_STORE'
      result.errors.push('readAuditHead(verifyChain=true) requires store.verifyAudit()')
      return result
    }
    let verify
    try { verify = store.verifyAudit() } catch (error) {
      result.code = 'E_AUDIT_CHAIN_BROKEN'
      result.errors.push('cannot verify the audit chain: ' + String(error?.message ?? error).slice(0, 200))
      return result
    }
    if (!verify || verify.ok !== true) {
      result.code = 'E_AUDIT_CHAIN_BROKEN'
      result.brokenAt = Number.isInteger(verify?.seq) ? verify.seq : null
      result.errors.push('audit chain is broken' + (result.brokenAt === null ? '' : ' at seq ' + result.brokenAt) + '; refusing to anchor a broken chain')
      return result
    }
    count = Number.isInteger(verify.count) ? verify.count : null
    result.chainVerified = true
  }
  if (count === null) {
    if (db) {
      const row = readRow(db, 'SELECT COUNT(*) AS n FROM audit')
      if (row && Number.isInteger(Number(row.n))) count = Number(row.n)
    } else if (typeof store.verifyAudit === 'function') {
      const verify = store.verifyAudit()
      if (verify?.ok === true && Number.isInteger(verify.count)) {
        count = verify.count
        result.chainVerified = true
      } else {
        result.code = 'E_AUDIT_CHAIN_BROKEN'
        result.brokenAt = Number.isInteger(verify?.seq) ? verify.seq : null
        result.errors.push('audit chain is broken; refusing to anchor a broken chain')
        return result
      }
    }
  }
  if (count === null) {
    result.code = 'E_AUDIT_CHAIN_BROKEN'
    result.errors.push('cannot determine the number of audit rows; refusing to anchor')
    return result
  }
  result.count = count
  let tail = null
  if (db) {
    const row = readRow(db, 'SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1')
    if (row) tail = { seq: Number(row.seq), hash: String(row.hash ?? '') }
  } else {
    try { tail = store.listAudit(1)[0] ?? null } catch { tail = null }
  }
  if (count > 0) {
    if (!tail || !isHex64(tail.hash)) {
      result.code = 'E_AUDIT_HEAD_INVALID'
      result.errors.push('cannot read a valid last audit row hash; refusing to anchor')
      return result
    }
    result.lastSeq = tail.seq
    result.headHash = tail.hash
  } else {
    result.lastSeq = 0
    result.headHash = ''
  }
  if (db) {
    const genesis = readRow(db, 'SELECT hash FROM audit ORDER BY seq ASC LIMIT 1')
    if (genesis && isHex64(String(genesis.hash ?? ''))) result.genesisHash = String(genesis.hash)
  } else if (count > 0 && count <= listFallbackMax) {
    try {
      const rows = store.listAudit(count)
      const oldest = rows[rows.length - 1]
      if (oldest && isHex64(String(oldest.hash ?? ''))) result.genesisHash = String(oldest.hash)
    } catch {}
  }
  result.dbId = computeAuditDbId(result.genesisHash)
  result.ok = true
  return result
}

/**
 * Build an anchor object from a head snapshot. Pure: no filesystem, no DB.
 *
 * `key` is the audit HMAC key (usually $ADVISERS_HOME/audit.key loaded by
 * bin/). With no key the anchor is written unkeyed (hmac:null, keyed:false) and
 * verification reports a warning: a same-user attacker can then edit the anchor
 * too, which is an honest limitation rather than a silent claim.
 */
export function buildAuditAnchor({ head, key = null, generator = 'advisers', createdAt = new Date().toISOString(), dbId } = {}) {
  if (!isPlainObject(head) || !isNonNegativeInteger(head.count)) {
    throw new TypeError('buildAuditAnchor requires a head object with a non-negative integer count')
  }
  const resolvedDbId = typeof dbId === 'string' && DB_ID_RE.test(dbId)
    ? dbId
    : (typeof head.dbId === 'string' && DB_ID_RE.test(head.dbId)
      ? head.dbId
      : computeAuditDbId(head.genesisHash))
  const anchor = {
    format: AUDIT_ANCHOR_FORMAT,
    version: AUDIT_ANCHOR_VERSION,
    dbId: resolvedDbId,
    count: head.count,
    lastSeq: isNonNegativeInteger(head.lastSeq) ? head.lastSeq : head.count,
    headHash: typeof head.headHash === 'string' ? head.headHash : '',
    createdAt,
    generator: typeof generator === 'string' && generator ? generator : 'advisers',
    keyed: typeof key === 'string' && key.length > 0,
    hmac: null,
  }
  if (anchor.count > 0 && !isHex64(anchor.headHash)) {
    throw new TypeError('buildAuditAnchor requires a 64-hex headHash when count > 0')
  }
  if (!isIsoDate(anchor.createdAt)) throw new TypeError('buildAuditAnchor createdAt must be an ISO-8601 UTC timestamp')
  anchor.hmac = computeAuditAnchorHmac(anchor, anchor.keyed ? key : null)
  return anchor
}

/** Shape/schema validation for an anchor parsed from disk or JSON. */
export function validateAuditAnchor(anchor) {
  const errors = []
  if (!isPlainObject(anchor)) return { ok: false, errors: ['audit anchor must be a JSON object'] }
  if (anchor.format !== AUDIT_ANCHOR_FORMAT) errors.push('anchor.format must be ' + AUDIT_ANCHOR_FORMAT)
  if (anchor.version !== AUDIT_ANCHOR_VERSION) errors.push('anchor.version must be ' + AUDIT_ANCHOR_VERSION)
  if (typeof anchor.dbId !== 'string' || !DB_ID_RE.test(anchor.dbId)) errors.push('anchor.dbId must be sha256:<64 lowercase hex>')
  if (!isNonNegativeInteger(anchor.count)) errors.push('anchor.count must be a non-negative integer')
  if (!isNonNegativeInteger(anchor.lastSeq)) errors.push('anchor.lastSeq must be a non-negative integer')
  if (anchor.count === 0) {
    if (anchor.headHash !== '') errors.push('anchor.headHash must be an empty string when count is 0')
  } else if (!isHex64(anchor.headHash)) {
    errors.push('anchor.headHash must be 64 lowercase hex characters')
  }
  if (typeof anchor.createdAt !== 'string' || !isIsoDate(anchor.createdAt)) errors.push('anchor.createdAt must be an ISO-8601 UTC timestamp')
  if (typeof anchor.generator !== 'string' || !anchor.generator) errors.push('anchor.generator must be a non-empty string')
  if (typeof anchor.keyed !== 'boolean') errors.push('anchor.keyed must be a boolean')
  if (typeof anchor.keyed === 'boolean') {
    if (anchor.keyed) {
      if (!isHex64(anchor.hmac)) errors.push('anchor.hmac must be 64 lowercase hex characters when keyed is true')
    } else if (anchor.hmac !== null) {
      errors.push('anchor.hmac must be null when keyed is false')
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Resolve the HMAC key for anchor reads/writes.
 *
 * Precedence: explicit `key` option (undefined means 'not given', null means
 * 'explicitly unkeyed'), then $ADVISERS_AUDIT_KEY, then $ADVISERS_HOME/audit.key
 * (the file bin/ creates with mode 0600). Never throws: a missing key yields
 * {key:null} so the caller can choose an unkeyed anchor with a warning.
 */
export function resolveAuditAnchorKey({ home, key, env = process.env } = {}) {
  if (key !== undefined) {
    const value = typeof key === 'string' && key.length > 0 ? key : null
    return { key: value, source: value ? 'argument' : 'argument-none' }
  }
  const fromEnv = env?.[AUDIT_ANCHOR_KEY_ENV]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return { key: fromEnv, source: 'env' }
  if (home) {
    const file = join(home, AUDIT_KEY_FILE_NAME)
    try {
      if (existsSync(file)) {
        const value = readFileSync(file, 'utf8').trim()
        if (value.length > 0) return { key: value, source: 'file', path: file }
      }
    } catch (error) {
      return { key: null, source: 'file-unreadable', path: file, warning: 'cannot read ' + file + ': ' + String(error?.message ?? error).slice(0, 160) }
    }
  }
  return { key: null, source: 'none' }
}

/** Read and validate the anchor file. Missing file is {ok:true, found:false}. */
export function readAuditAnchor({ home, file, maxBytes = AUDIT_ANCHOR_MAX_BYTES, fs } = {}) {
  const target = file ?? (home ? join(home, AUDIT_ANCHOR_FILE) : null)
  const result = { ok: false, found: false, code: null, path: target, anchor: null, errors: [], warnings: [] }
  if (!target) {
    result.code = 'E_AUDIT_ANCHOR_PATH'
    result.errors.push('readAuditAnchor requires {home} or {file}')
    return result
  }
  const stat = fs?.statSync ?? statSync
  const read = fs?.readFileSync ?? readFileSync
  let info
  try {
    info = stat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') { result.ok = true; result.found = false; return result }
    result.code = 'E_AUDIT_ANCHOR_UNREADABLE'
    result.errors.push('cannot stat ' + target + ': ' + String(error?.code ?? error?.message ?? error))
    return result
  }
  result.found = true
  if (!info.isFile()) {
    result.code = 'E_AUDIT_ANCHOR_INVALID'
    result.errors.push('audit anchor path is not a regular file: ' + target)
    return result
  }
  if (Number.isFinite(maxBytes) && info.size > maxBytes) {
    result.code = 'E_AUDIT_ANCHOR_TOO_LARGE'
    result.errors.push('audit anchor is ' + info.size + ' bytes, over the ' + maxBytes + ' byte limit')
    return result
  }
  let text
  try { text = read(target, 'utf8') } catch (error) {
    result.code = 'E_AUDIT_ANCHOR_UNREADABLE'
    result.errors.push('cannot read ' + target + ': ' + String(error?.code ?? error?.message ?? error))
    return result
  }
  let parsed
  try { parsed = JSON.parse(text) } catch (error) {
    result.code = 'E_AUDIT_ANCHOR_INVALID'
    result.errors.push('audit anchor is not valid JSON: ' + String(error?.message ?? error).slice(0, 200))
    return result
  }
  const shape = validateAuditAnchor(parsed)
  if (!shape.ok) {
    result.code = 'E_AUDIT_ANCHOR_INVALID'
    for (const error of shape.errors) result.errors.push('schema: ' + error)
    return result
  }
  result.ok = true
  result.anchor = parsed
  if (!parsed.keyed) result.warnings.push('audit anchor is not keyed (keyed:false): it cannot detect a same-user attacker who rewrites both the database and the anchor')
  return result
}

/**
 * Compare a live audit head against a recorded anchor (normal 'audit' path).
 *
 * allowBehind is for explicit time-travel/restore checks only; for a live
 * database a count below the anchor is a tail truncation. Returns a structured
 * result instead of throwing so bin/ can print yellow vs red and choose an exit
 * code.
 */
export function verifyAuditAnchor({ anchor, head, key, allowBehind = false } = {}) {
  const result = {
    ok: false,
    status: 'invalid',
    code: null,
    keyed: Boolean(anchor?.keyed),
    hmacVerified: false,
    count: isNonNegativeInteger(head?.count) ? head.count : null,
    anchorCount: isNonNegativeInteger(anchor?.count) ? anchor.count : null,
    headHash: typeof head?.headHash === 'string' ? head.headHash : null,
    anchorHeadHash: typeof anchor?.headHash === 'string' ? anchor.headHash : null,
    lastSeq: isNonNegativeInteger(head?.lastSeq) ? head.lastSeq : null,
    anchorLastSeq: isNonNegativeInteger(anchor?.lastSeq) ? anchor.lastSeq : null,
    dbId: typeof head?.dbId === 'string' ? head.dbId : null,
    anchorDbId: typeof anchor?.dbId === 'string' ? anchor.dbId : null,
    needsReanchor: false,
    errors: [],
    warnings: [],
  }
  const shape = validateAuditAnchor(anchor)
  if (!shape.ok) {
    result.code = 'E_AUDIT_ANCHOR_INVALID'
    for (const error of shape.errors) result.errors.push(error)
    return result
  }
  if (!isPlainObject(head) || !isNonNegativeInteger(head.count)) {
    result.code = 'E_AUDIT_ANCHOR_HEAD_INVALID'
    result.errors.push('verifyAuditAnchor requires a head with a non-negative integer count (see readAuditHead)')
    return result
  }
  if (anchor.keyed) {
    if (typeof key !== 'string' || key.length === 0) {
      result.code = 'E_AUDIT_ANCHOR_KEY_MISSING'
      result.errors.push('the anchor is HMAC-keyed but no audit key is available; set ' + AUDIT_ANCHOR_KEY_ENV + ' or restore ' + AUDIT_KEY_FILE_NAME)
      return result
    }
    if (!hmacMatches(anchor, key)) {
      result.code = 'E_AUDIT_ANCHOR_HMAC_MISMATCH'
      result.errors.push('audit anchor HMAC does not match: the anchor was edited, or it was written with a different audit key')
      return result
    }
    result.hmacVerified = true
  } else {
    result.warnings.push('audit anchor is unkeyed: a same-user attacker can edit the database and the anchor together')
  }
  // dbId only identifies the ledger once a genesis row exists on both sides;
  // an anchor written on an empty audit is compatible with later growth.
  if (anchor.count > 0 && head.count > 0 && typeof head.dbId === 'string' && head.dbId !== anchor.dbId) {
    result.code = 'E_AUDIT_ANCHOR_DB_MISMATCH'
    result.errors.push('the anchor belongs to a different database (dbId mismatch); it cannot certify this ledger')
    return result
  }
  if (head.count < anchor.count) {
    if (!allowBehind) {
      result.code = 'E_AUDIT_TAIL_TRUNCATED'
      result.errors.push('audit has ' + head.count + ' rows but the anchor recorded ' + anchor.count + ': the audit tail was deleted or the database was rolled back to an older copy')
      return result
    }
    result.ok = true
    result.status = 'behind'
    result.warnings.push('current audit is older than the anchor (' + head.count + ' < ' + anchor.count + ' rows); time-travel was explicitly allowed')
    return result
  }
  if (head.count === anchor.count) {
    if (head.headHash !== anchor.headHash || head.lastSeq !== anchor.lastSeq) {
      result.code = 'E_AUDIT_HEAD_MISMATCH'
      result.errors.push('audit count matches the anchor (' + anchor.count + ') but the head hash/seq does not: the last row was rewritten (or deleted and re-appended)')
      return result
    }
    result.ok = true
    result.status = 'match'
    return result
  }
  if (typeof head.lastSeq === 'number' && head.lastSeq < anchor.lastSeq) {
    result.code = 'E_AUDIT_TAIL_TRUNCATED'
    result.errors.push('audit last seq ' + head.lastSeq + ' is behind the anchor lastSeq ' + anchor.lastSeq + ': the tail was deleted')
    return result
  }
  result.ok = true
  result.status = 'grown'
  result.needsReanchor = true
  result.warnings.push('audit grew from ' + anchor.count + ' to ' + head.count + ' rows since the anchor; write a fresh anchor (for example `advisers audit --write-anchor`)')
  return result
}

/**
 * Compare a backup's audit head against the current anchor (restore path).
 *
 * Direction is inverted compared to a live database: a backup OLDER than the
 * anchor is legitimate time travel, so it is reported as 'behind' and accepted
 * only when the caller explicitly passes allowAnchorBehind (bin:
 * `restore --allow-anchor-behind`). A backup NEWER than the anchor is normal
 * (the anchor was simply not refreshed); status 'ahead'.
 */
export function verifyRestoreAnchor({ anchor, head, key, allowAnchorBehind = false } = {}) {
  const result = verifyAuditAnchor({ anchor, head, key, allowBehind: true })
  if (!result.ok) return result
  if (head.count < anchor.count) {
    if (!allowAnchorBehind) {
      result.ok = false
      result.status = 'behind'
      result.code = 'E_AUDIT_ANCHOR_BEHIND'
      result.errors.push('the backup is older than the audit anchor (' + head.count + ' < ' + anchor.count + ' rows); pass allowAnchorBehind / `restore --allow-anchor-behind` only if this time-travel is intended')
      return result
    }
    result.status = 'behind'
    result.warnings.push('restoring a backup older than the audit anchor was explicitly allowed; the restored ledger will look like a rollback until a fresh anchor is written')
    return result
  }
  if (head.count === anchor.count) {
    result.status = 'match'
    return result
  }
  result.status = 'ahead'
  result.warnings.push('the backup has more audit rows than the anchor (' + head.count + ' > ' + anchor.count + '); the anchor is stale, which is normal if audit writes happened after the anchor')
  return result
}

/**
 * Read the anchor (if any) and compare it with the live audit head.
 * Returns {ok:false, code:'E_AUDIT_ANCHOR_ABSENT', status:'absent'} when no
 * anchor exists: callers report that as yellow, not as a broken chain.
 */
export function verifyAuditAgainstAnchor({ home, file, store, head, key, env, allowBehind = false, verifyChain = true } = {}) {
  const target = file ?? (home ? join(home, AUDIT_ANCHOR_FILE) : null)
  const read = readAuditAnchor({ file: target })
  if (!read.found) {
    return {
      ok: false, found: false, status: 'absent', code: 'E_AUDIT_ANCHOR_ABSENT', path: target,
      anchor: null, head: null, keySource: null,
      errors: ['no audit anchor has been recorded yet; run `advisers audit --write-anchor` to create a baseline'],
      warnings: [],
    }
  }
  if (!read.ok) {
    return { ok: false, found: true, status: 'invalid', code: read.code, path: target, anchor: null, head: null, keySource: null, errors: read.errors, warnings: read.warnings }
  }
  const keyInfo = resolveAuditAnchorKey({ home, key, env })
  const headInfo = head ?? (store ? readAuditHead(store, { verifyChain }) : null)
  if (!headInfo || headInfo.ok !== true) {
    return {
      ok: false, found: true, status: 'chain-broken', code: headInfo?.code ?? 'E_AUDIT_CHAIN_BROKEN', path: target,
      anchor: read.anchor, head: headInfo ?? null, keySource: keyInfo.source,
      errors: headInfo?.errors ?? ['no audit head available'], warnings: read.warnings,
    }
  }
  const verified = verifyAuditAnchor({ anchor: read.anchor, head: headInfo, key: keyInfo.key, allowBehind })
  return {
    ...verified,
    found: true,
    path: target,
    anchor: read.anchor,
    head: headInfo,
    keySource: keyInfo.source,
    warnings: [...read.warnings, ...verified.warnings],
  }
}

/**
 * Explicit `audit --expect-count/--expect-head` check (works with no anchor).
 * This is the A8 acceptance path: write an anchor, delete the last audit row,
 * `audit --expect-head <old head>` must fail.
 */
export function verifyExpectedAudit(store, { expectedCount = null, expectedHead = null } = {}) {
  const head = readAuditHead(store, { verifyChain: false })
  if (!head.ok) return { ok: false, code: head.code, count: head.count, headHash: head.headHash, errors: head.errors }
  const errors = []
  let count = null
  let headWanted = null
  if (expectedCount !== null && expectedCount !== undefined) {
    count = Number(expectedCount)
    if (!Number.isInteger(count) || count < 0) {
      errors.push('expected audit count must be a non-negative integer')
      count = null
    } else if (head.count !== count) {
      errors.push('audit has ' + head.count + ' rows but --expect-count is ' + count + ': the tail was deleted or the database was rolled back')
    }
  }
  if (expectedHead !== null && expectedHead !== undefined) {
    headWanted = String(expectedHead).trim().toLowerCase()
    if (!isHex64(headWanted)) {
      errors.push('expected audit head must be 64 lowercase hex characters')
      headWanted = null
    } else if (head.headHash !== headWanted) {
      errors.push('audit head is ' + (head.headHash || '(empty)') + ' but --expect-head is ' + headWanted + ': the tail was rewritten or rolled back')
    }
  }
  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? null : 'E_AUDIT_EXPECT_MISMATCH',
    count: head.count,
    headHash: head.headHash,
    lastSeq: head.lastSeq,
    expectedCount: count,
    expectedHead: headWanted,
    errors,
  }
}

/**
 * Convenience for export/backup/sync/seal: return the anchor object for the
 * current head WITHOUT writing a file, so `export --all` can embed a top-level
 * `auditAnchor` and `sync push` can put it in the encrypted payload metadata.
 * verifyChain=true by default (anchoring a broken chain is refused).
 */
export function buildAuditAnchorForStore({ store, key, home, env, generator = 'advisers', createdAt = new Date().toISOString(), verifyChain = true } = {}) {
  if (!store) return { ok: false, code: 'E_AUDIT_ANCHOR_STORE', errors: ['buildAuditAnchorForStore requires {store}'], warnings: [] }
  const keyInfo = resolveAuditAnchorKey({ home, key, env })
  const head = readAuditHead(store, { verifyChain })
  const warnings = keyInfo.warning ? [keyInfo.warning] : []
  if (!head.ok) return { ok: false, code: head.code, errors: [...head.errors], warnings }
  let anchor
  try {
    anchor = buildAuditAnchor({ head, key: keyInfo.key, generator, createdAt })
  } catch (error) {
    return { ok: false, code: 'E_AUDIT_ANCHOR_INVALID', errors: [String(error?.message ?? error).slice(0, 200)], warnings }
  }
  if (!anchor.keyed) warnings.push('building an unkeyed audit anchor (no audit key available): it cannot detect a same-user attacker who rewrites the database and the anchor together')
  return { ok: true, anchor, head, keyed: anchor.keyed, keySource: keyInfo.source, warnings }
}

/**
 * Write $ADVISERS_HOME/audit-anchor.json atomically (same-directory temp +
 * fsync + rename, mode 0600; Windows fsync uses the writable-handle path fixed
 * in fs-safe.js).
 *
 * Either pass a `store` (chain is verified unless verifyChain:false) or a
 * precomputed `head` from readAuditHead. A broken chain is refused
 * (E_AUDIT_CHAIN_BROKEN) so a bad state never becomes a baseline.
 */
export function writeAuditAnchor({ home, file, store, head, key, env, generator = 'advisers', createdAt = new Date().toISOString(), verifyChain = true, mode = 0o600, fs } = {}) {
  const target = file ?? (home ? join(home, AUDIT_ANCHOR_FILE) : null)
  if (!target) return { ok: false, code: 'E_AUDIT_ANCHOR_PATH', errors: ['writeAuditAnchor requires {home} or {file}'], warnings: [] }
  const keyInfo = resolveAuditAnchorKey({ home, key, env })
  let headInfo = head
  if (!headInfo) {
    if (!store) return { ok: false, code: 'E_AUDIT_ANCHOR_STORE', errors: ['writeAuditAnchor requires {store} or {head}'], warnings: [] }
    headInfo = readAuditHead(store, { verifyChain })
  }
  if (!headInfo || headInfo.ok !== true) {
    return {
      ok: false, path: target,
      code: headInfo?.code ?? 'E_AUDIT_CHAIN_BROKEN',
      errors: headInfo?.errors ?? ['no audit head available'],
      warnings: keyInfo.warning ? [keyInfo.warning] : [],
    }
  }
  let anchor
  try {
    anchor = buildAuditAnchor({ head: headInfo, key: keyInfo.key, generator, createdAt })
  } catch (error) {
    return { ok: false, path: target, code: 'E_AUDIT_ANCHOR_INVALID', errors: [String(error?.message ?? error).slice(0, 200)], warnings: [] }
  }
  const warnings = []
  if (keyInfo.warning) warnings.push(keyInfo.warning)
  if (!anchor.keyed) warnings.push('writing an unkeyed audit anchor (no audit key available): it cannot detect a same-user attacker who rewrites the database and the anchor together')
  try {
    atomicWriteFileSync(target, JSON.stringify(anchor, null, 2) + '\n', { fs, mode })
  } catch (error) {
    return { ok: false, path: target, code: error?.code ?? 'E_AUDIT_ANCHOR_WRITE_FAILED', errors: [String(error?.message ?? error).slice(0, 300)], warnings }
  }
  return { ok: true, path: target, anchor, keySource: keyInfo.source, keyed: anchor.keyed, warnings }
}

/** One-line actionable hint per stable anchor error code (bin/ messages). */
export const AUDIT_ANCHOR_ERROR_HINTS = Object.freeze({
  E_AUDIT_ANCHOR_ABSENT: 'no audit anchor has been recorded yet; run `advisers audit --write-anchor` to create a baseline',
  E_AUDIT_ANCHOR_INVALID: 'the audit anchor file is malformed; inspect it and write a fresh anchor (never delete audit rows to make it match)',
  E_AUDIT_ANCHOR_TOO_LARGE: 'the audit anchor file is unexpectedly large; inspect it before trusting it',
  E_AUDIT_ANCHOR_UNREADABLE: 'the audit anchor file cannot be read; check permissions and the path',
  E_AUDIT_ANCHOR_KEY_MISSING: 'the audit anchor is HMAC-keyed but the audit key is unavailable; restore $ADVISERS_HOME/audit.key (do not regenerate it, the existing chain would verify as BROKEN)',
  E_AUDIT_ANCHOR_HMAC_MISMATCH: 'the audit anchor HMAC does not match; treat this as tampering or a changed audit key and restore from a trusted backup',
  E_AUDIT_ANCHOR_DB_MISMATCH: 'the audit anchor belongs to a different database; do not use it to certify this ledger',
  E_AUDIT_TAIL_TRUNCATED: 'the audit tail was deleted or the database was rolled back; do not delete or rebuild audit rows — restore from a trusted backup and investigate',
  E_AUDIT_HEAD_MISMATCH: 'the audit last row was rewritten or rolled back; restore from a trusted backup and investigate',
  E_AUDIT_CHAIN_BROKEN: 'the audit chain is broken (a middle row was edited or deleted); nothing will repair it automatically — export evidence and restore from a trusted backup',
  E_AUDIT_ANCHOR_BEHIND: 'the backup is older than the audit anchor; pass --allow-anchor-behind only if this time-travel is intended',
  E_AUDIT_EXPECT_MISMATCH: 'the audit does not match the expected count/head; the tail may have been deleted or rolled back',
})

export function describeAuditAnchorCode(code) {
  return AUDIT_ANCHOR_ERROR_HINTS[code] ?? ('audit anchor check failed: ' + String(code ?? 'unknown error'))
}
