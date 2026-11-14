/**
 * E3: evidence chain and evidence pack.
 *
 * Every ledger row that claims something about the world must point back to the
 * conversation turn it came from. This module walks those pointers (a turn is
 * only trusted when both its id and its conversation id agree with the
 * evidence record), and then packages the references — never the full
 * transcript — into a small verifiable directory:
 *
 *   manifest.json   entries + resolved sources (quote capped at 500 chars) + SHA-256
 *   README.txt      human summary and verification instructions
 *   SHA256SUMS      sha256 of manifest.json and README.txt
 *
 * Constraints baked into the design:
 * - Offline: this module only imports node:crypto, injects `store` + `ledger`.
 * - No fabrication: an unknown turn, a session mismatch or an unparseable
 *   `session#turn` ref goes to `missing`; nothing is guessed.
 * - No leaks: no absolute filesystem paths, no full turn/transcript bodies and
 *   no matter summaries/snippets other than the evidence quotes themselves.
 * - SHA256SUMS is tamper-evidence (accidental/deterministic edits), not a
 *   signature: whoever can rewrite the whole pack can recompute the sums.
 *
 * The directory writer/CLI entry point is intentionally out of scope here.
 */

import { createHash } from 'node:crypto'

/** Quotes are verbatim evidence but capped, so a pack never carries a full body. */
export const MAX_QUOTE_CHARS = 500
export const MANIFEST_FORMAT = 'advisers-evidence-pack'
export const MANIFEST_VERSION = 1
/** Header for the optional DOCX table helper, kept next to the rows it describes. */
export const DOCX_EVIDENCE_HEADERS = ['类型', '证据ID', '来源(session#turn)', '摘录', '状态']

const REQUIRED_PACK_FILES = ['manifest.json', 'README.txt']
const README_ENTRY_CAP = 100
const README_REF_CAP = 5

const KIND_ALIASES = Object.freeze({
  commitment: 'commitment',
  commitments: 'commitment',
  cm: 'commitment',
  fact: 'fact',
  facts: 'fact',
  preference: 'preference',
  preferences: 'preference',
  pref: 'preference',
})

// ---------------------------------------------------------------------------
// bytes, hashes and canonical JSON
// ---------------------------------------------------------------------------

function toBytes(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return null
}

function textOf(value) {
  if (typeof value === 'string') return value
  const bytes = toBytes(value)
  return bytes ? bytes.toString('utf8') : null
}

/** SHA-256 hex digest of a UTF-8 string or raw bytes. */
export function sha256Hex(data) {
  const bytes = toBytes(data)
  if (!bytes) throw new TypeError('sha256Hex expects a string, Buffer, Uint8Array or ArrayBuffer')
  return createHash('sha256').update(bytes).digest('hex')
}

function normalizeJson(value) {
  if (value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item))
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue
      out[key] = normalizeJson(value[key])
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}

/**
 * Deterministic JSON text: object keys are sorted at every depth and
 * `undefined` fields are dropped, so identical inputs produce identical bytes.
 */
export function stableStringify(value, { space = 2 } = {}) {
  return JSON.stringify(normalizeJson(value), null, space)
}

function isoDate(value) {
  if (value === undefined || value === null) return new Date().toISOString()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError(`invalid date: ${value}`)
  return date.toISOString()
}

// ---------------------------------------------------------------------------
// source refs: `sessionId#turnId`
// ---------------------------------------------------------------------------

/**
 * Parse a `SourceRef.ref` of the form `sessionId#turnId`.
 * Returns `null` when the ref cannot be parsed — callers must put that into
 * `missing` rather than guessing a session.
 */
export function parseSourceRef(ref) {
  if (typeof ref !== 'string') return null
  const text = ref.trim()
  const split = text.indexOf('#')
  if (split <= 0) return null
  const sessionId = text.slice(0, split)
  const turnId = text.slice(split + 1)
  if (!sessionId || !turnId || turnId.includes('#')) return null
  return { sessionId, turnId }
}

function lookupTurn(store, sessionId, turnId) {
  if (!store || typeof store !== 'object') return { turn: undefined, failed: false }
  let failed = false
  if (typeof store.getTurn === 'function') {
    try {
      const turn = store.getTurn(turnId)
      if (turn) return { turn }
    } catch {
      failed = true
    }
  }
  // Older stores (and this module at HEAD before getTurn landed) only expose
  // listTurns; scan the evidence's own session, never another one.
  if (sessionId && typeof store.listTurns === 'function') {
    try {
      const turns = store.listTurns(sessionId, 10_000)
      const found = Array.isArray(turns) ? turns.find((turn) => turn?.id === turnId) : undefined
      if (found) return { turn: found }
      failed = false
    } catch {
      failed = true
    }
  }
  return { turn: undefined, failed }
}

// ---------------------------------------------------------------------------
// ledger lookups (Ledger has no getFact/getCommitment by id)
// ---------------------------------------------------------------------------

function findCommitment(ledger, id) {
  if (!ledger || !id) return undefined
  if (typeof ledger.getCommitment === 'function') {
    const hit = ledger.getCommitment(id)
    if (hit) return hit
  }
  const rows = typeof ledger.listCommitments === 'function' ? ledger.listCommitments() : []
  return rows.find((row) => row?.id === id)
}

function findFact(ledger, id) {
  if (!ledger || !id) return undefined
  if (typeof ledger.getFact === 'function') {
    const hit = ledger.getFact(id)
    if (hit) return hit
  }
  let rows = []
  if (typeof ledger.listFacts === 'function') {
    try {
      rows = ledger.listFacts(undefined, true)
    } catch {
      try {
        rows = ledger.listFacts()
      } catch {
        rows = []
      }
    }
  }
  let hit = rows.find((row) => row?.id === id)
  if (hit) return hit
  // Last resort: the portable snapshot, which includes tombstones/history.
  try {
    return (ledger.toJSON?.().facts ?? []).find((row) => row?.id === id)
  } catch {
    return undefined
  }
}

function findPreference(ledger, id) {
  if (!ledger || !id) return undefined
  if (typeof ledger.findPreference === 'function') {
    const hit = ledger.findPreference(id)
    if (hit) return hit
  }
  let rows = []
  try {
    rows = ledger.listPreferences({ includeCandidates: true })
  } catch {
    rows = []
  }
  return rows.find((row) => row?.id === id)
}

// ---------------------------------------------------------------------------
// evidence traceback
// ---------------------------------------------------------------------------

function sourceRefKey(item) {
  if (!item || typeof item !== 'object') return `\u0000${String(item)}`
  return `${typeof item.ref === 'string' ? item.ref : ''}\u0000${typeof item.quote === 'string' ? item.quote : ''}`
}

function primarySourceCandidates(source) {
  if (!source || typeof source !== 'object') return []
  const hasRef = typeof source.ref === 'string' && source.ref.length > 0
  const hasQuote = typeof source.quote === 'string' && source.quote.length > 0
  return hasRef || hasQuote ? [source] : []
}

function collectSourceRefs(...lists) {
  const seen = new Set()
  const out = []
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const key = sourceRefKey(item)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

function resolveSourceRefs(store, items) {
  const sources = []
  const missing = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      missing.push({ reason: 'invalid_source' })
      continue
    }
    const quote = typeof item.quote === 'string' ? item.quote : ''
    const ref = typeof item.ref === 'string' ? item.ref : ''
    if (!ref) {
      missing.push({ quote, reason: 'no_ref' })
      continue
    }
    const parsed = parseSourceRef(ref)
    if (!parsed) {
      missing.push({ ref, quote, reason: 'unparseable_ref' })
      continue
    }
    const lookup = lookupTurn(store, parsed.sessionId, parsed.turnId)
    if (!lookup.turn) {
      missing.push({
        ref,
        quote,
        sessionId: parsed.sessionId,
        turnId: parsed.turnId,
        reason: lookup.failed ? 'lookup_failed' : 'turn_not_found',
      })
      continue
    }
    if (lookup.turn.conversationId !== parsed.sessionId) {
      missing.push({ ref, quote, sessionId: parsed.sessionId, turnId: parsed.turnId, reason: 'session_mismatch' })
      continue
    }
    sources.push({ sessionId: parsed.sessionId, turnId: parsed.turnId, quote, turn: lookup.turn })
  }
  return { sources, missing }
}

/**
 * Trace a commitment's evidence back to real turns.
 *
 * @returns {{ commitment: object|undefined,
 *             sources: Array<{sessionId: string, turnId: string, quote: string, turn: object}>,
 *             missing: Array<{sessionId?: string, turnId?: string, quote?: string, id?: string, reason: string}> }}
 */
export function evidenceForCommitment(store, ledger, commitmentId) {
  const commitment = findCommitment(ledger, commitmentId)
  if (!commitment) {
    return { commitment: undefined, sources: [], missing: [{ id: commitmentId, reason: 'commitment_not_found' }] }
  }
  const sources = []
  const missing = []
  const evidence = Array.isArray(commitment.evidence) ? commitment.evidence : []
  for (const item of evidence) {
    const sessionId = typeof item?.sessionId === 'string' ? item.sessionId : ''
    const turnId = typeof item?.turnId === 'string' ? item.turnId : ''
    const quote = typeof item?.quote === 'string' ? item.quote : ''
    if (!sessionId || !turnId) {
      missing.push({
        sessionId: sessionId || undefined,
        turnId: turnId || undefined,
        quote,
        reason: 'invalid_evidence',
      })
      continue
    }
    const lookup = lookupTurn(store, sessionId, turnId)
    if (!lookup.turn) {
      missing.push({ sessionId, turnId, quote, reason: lookup.failed ? 'lookup_failed' : 'turn_not_found' })
      continue
    }
    if (lookup.turn.conversationId !== sessionId) {
      missing.push({ sessionId, turnId, quote, reason: 'session_mismatch' })
      continue
    }
    sources.push({ sessionId, turnId, quote, turn: lookup.turn })
  }
  return { commitment, sources, missing }
}

/** Trace a fact's `SourceRef[]` (plus its primary `source`) back to turns. */
export function evidenceForFact(store, ledger, factId) {
  const fact = findFact(ledger, factId)
  if (!fact) {
    return { fact: undefined, sources: [], missing: [{ id: factId, reason: 'fact_not_found' }] }
  }
  const refs = collectSourceRefs(fact.evidence, primarySourceCandidates(fact.source))
  const resolved = resolveSourceRefs(store, refs)
  return { fact, sources: resolved.sources, missing: resolved.missing }
}

/** Trace a preference's `SourceRef[]` (plus its primary `source`) back to turns. */
export function evidenceForPreference(store, ledger, preferenceId) {
  const preference = findPreference(ledger, preferenceId)
  if (!preference) {
    return { preference: undefined, sources: [], missing: [{ id: preferenceId, reason: 'preference_not_found' }] }
  }
  const refs = collectSourceRefs(preference.evidence, primarySourceCandidates(preference.source))
  const resolved = resolveSourceRefs(store, refs)
  return { preference, sources: resolved.sources, missing: resolved.missing }
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

function compareEntries(a, b) {
  const left = `${a?.kind ?? ''}\u0000${a?.id ?? ''}`
  const right = `${b?.kind ?? ''}\u0000${b?.id ?? ''}`
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Build the manifest bytes. `entries` are the compact evidence entries produced
 * by `buildEvidencePack` (an entry may also be any JSON-serializable object).
 * Passing a fixed `createdAt` makes the output reproducible byte-for-byte.
 *
 * @returns {string} canonical JSON text with a trailing newline
 */
export function manifestFor(entries, { createdAt } = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({ ...entry }))
  list.sort(compareEntries)
  return `${stableStringify({
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    createdAt: isoDate(createdAt),
    entryCount: list.length,
    entries: list,
  })}\n`
}

// ---------------------------------------------------------------------------
// pack assembly
// ---------------------------------------------------------------------------

function clampQuote(value) {
  const text = typeof value === 'string' ? value : ''
  const chars = Array.from(text)
  const truncated = chars.length > MAX_QUOTE_CHARS
  const quote = truncated ? chars.slice(0, MAX_QUOTE_CHARS).join('') : text
  return { quote, quoteChars: chars.length, truncated, quoteSha256: sha256Hex(quote) }
}

function formatRef(sessionId, turnId) {
  const parts = []
  if (typeof sessionId === 'string' && sessionId) parts.push(sessionId)
  if (typeof turnId === 'string' && turnId) parts.push(turnId)
  return parts.join('#')
}

function compactSource(source) {
  const clamped = clampQuote(source?.quote)
  const entry = {
    sessionId: typeof source?.sessionId === 'string' ? source.sessionId : '',
    turnId: typeof source?.turnId === 'string' ? source.turnId : '',
    ...clamped,
  }
  // Turn sequence/role are provenance metadata, not body text.
  if (Number.isInteger(source?.turn?.seq)) entry.turnSeq = source.turn.seq
  if (typeof source?.turn?.role === 'string') entry.turnRole = source.turn.role
  return entry
}

function compactMissing(item) {
  const out = { reason: typeof item?.reason === 'string' ? item.reason : 'unknown' }
  for (const key of ['id', 'ref', 'sessionId', 'turnId']) {
    if (typeof item?.[key] === 'string' && item[key]) out[key] = item[key]
  }
  if (typeof item?.quote === 'string' && item.quote.length) Object.assign(out, clampQuote(item.quote))
  return out
}

function compactEntry(entry) {
  return {
    kind: typeof entry.kind === 'string' ? entry.kind : 'unknown',
    id: String(entry.id ?? ''),
    found: Boolean(entry.found),
    sources: (Array.isArray(entry.sources) ? entry.sources : []).map(compactSource),
    missing: (Array.isArray(entry.missing) ? entry.missing : []).map(compactMissing),
  }
}

function inferKindFromId(id) {
  if (/^cm[_:]/.test(id)) return 'commitment'
  if (/^fact[_:]/.test(id)) return 'fact'
  if (/^pref[_:]/.test(id)) return 'preference'
  return undefined
}

function normalizeKind(kind) {
  if (typeof kind !== 'string') return undefined
  return KIND_ALIASES[kind.trim().toLowerCase()]
}

function classifyKind(ledger, id, kind) {
  const explicit = normalizeKind(kind)
  if (explicit) return explicit
  const inferred = inferKindFromId(id)
  if (inferred) return inferred
  if (findCommitment(ledger, id)) return 'commitment'
  if (findFact(ledger, id)) return 'fact'
  if (findPreference(ledger, id)) return 'preference'
  return 'unknown'
}

function normalizeRequestedIds(ids, ledger) {
  const out = { commitments: [], facts: [], preferences: [], unknown: [] }
  const seen = new Set()
  const push = (id, kind) => {
    const value = id === undefined || id === null ? '' : String(id).trim()
    if (!value) return
    const resolved = classifyKind(ledger, value, kind)
    const key = `${resolved}\u0000${value}`
    if (seen.has(key)) return
    seen.add(key)
    if (resolved === 'commitment') out.commitments.push(value)
    else if (resolved === 'fact') out.facts.push(value)
    else if (resolved === 'preference') out.preferences.push(value)
    else out.unknown.push(value)
  }
  const pushItem = (item, fallbackKind) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const kind = normalizeKind(item.kind ?? item.type) ?? fallbackKind
      push(item.id ?? item.value, kind)
      return
    }
    push(item, fallbackKind)
  }
  const pushMany = (value, fallbackKind) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      for (const item of value) pushItem(item, fallbackKind)
      return
    }
    pushItem(value, fallbackKind)
  }
  if (Array.isArray(ids) || typeof ids === 'string') {
    pushMany(ids, undefined)
  } else if (ids && typeof ids === 'object') {
    pushMany(ids.commitments ?? ids.commitmentIds ?? ids.commitment, 'commitment')
    pushMany(ids.facts ?? ids.factIds ?? ids.fact, 'fact')
    pushMany(ids.preferences ?? ids.preferenceIds ?? ids.preference, 'preference')
    if (ids.ids !== undefined) pushMany(ids.ids, undefined)
  }
  return out
}

function buildReadme({ createdAt, entries, manifestDigest }) {
  const counts = { commitment: 0, fact: 0, preference: 0, unknown: 0 }
  let sourceCount = 0
  let missingCount = 0
  let truncatedCount = 0
  for (const entry of entries) {
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
    sourceCount += entry.sources.length
    missingCount += entry.missing.length
    truncatedCount += entry.sources.filter((source) => source.truncated).length
  }
  const lines = [
    'Advisers evidence pack',
    '======================',
    '',
    `format:   ${MANIFEST_FORMAT} v${MANIFEST_VERSION}`,
    `created:  ${createdAt}`,
    `entries:  ${entries.length} (commitment ${counts.commitment}, fact ${counts.fact}, preference ${counts.preference}, unknown ${counts.unknown})`,
    `sources:  ${sourceCount} resolved, ${missingCount} missing`,
    `quotes:   verbatim, at most ${MAX_QUOTE_CHARS} characters each; ${truncatedCount} truncated`,
    '',
    'Files',
    '-----',
    `manifest.json  sha256 ${manifestDigest}`,
    'README.txt     this file',
    'SHA256SUMS     sha256 of manifest.json and README.txt',
    '',
    'Verify',
    '------',
    'Run `sha256sum -c SHA256SUMS` in a directory containing manifest.json and README.txt.',
    'The checksums detect later edits to the pack. They are not a signature: anyone able to',
    'rewrite the whole pack can recompute them.',
    '',
    'Entries (quotes and full traceback live in manifest.json)',
    '--------------------------------------------------------',
  ]
  if (!entries.length) lines.push('(no evidence requested)')
  const shown = entries.slice(0, README_ENTRY_CAP)
  for (const entry of shown) {
    lines.push(
      `- ${entry.kind} ${entry.id}  sources=${entry.sources.length} missing=${entry.missing.length}${entry.found ? '' : ' (record not found)'}`,
    )
    const refs = entry.sources.slice(0, README_REF_CAP)
    for (const source of refs) {
      lines.push(`    source ${formatRef(source.sessionId, source.turnId)}${source.truncated ? ' (quote truncated)' : ''}`)
    }
    if (entry.sources.length > refs.length) lines.push(`    ... ${entry.sources.length - refs.length} more source(s)`)
    const missingShown = entry.missing.slice(0, README_REF_CAP)
    for (const item of missingShown) {
      const ref = item.ref || formatRef(item.sessionId, item.turnId) || item.id || ''
      lines.push(`    missing ${item.reason}${ref ? ` (${ref})` : ''}`)
    }
    if (entry.missing.length > missingShown.length) {
      lines.push(`    ... ${entry.missing.length - missingShown.length} more missing`)
    }
  }
  if (entries.length > shown.length) {
    lines.push(`... ${entries.length - shown.length} more entr${entries.length - shown.length === 1 ? 'y' : 'ies'} — see manifest.json`)
  }
  lines.push(
    '',
    'Privacy and scope',
    '-----------------',
    '- Built locally from the ledger and the turn store; this module performs no network calls.',
    `- Contains references (session#turn), verbatim quotes capped at ${MAX_QUOTE_CHARS} characters, and SHA-256 digests only.`,
    '- Contains no absolute filesystem paths, no full turn/transcript bodies, and no matter summaries.',
    '- Deleting the pack does not modify the local ledger or database.',
    '- Hashes prove the pack was not altered after generation; they do not prove the quotes are true.',
  )
  return `${lines.join('\n')}\n`
}

/**
 * Assemble the three-file evidence pack.
 *
 * @param {object} options
 * @param {object} options.store  SqliteStore-like (`getTurn`/`listTurns`, `getTurn` optional)
 * @param {object} options.ledger Ledger instance (listCommitments/listFacts/findPreference)
 * @param {object|Array|string} [options.ids] `{commitments, facts, preferences}`, an id array,
 *        a single id, or `[{kind, id}]`. `cm_`/`fact_`/`pref_` prefixes are inferred.
 * @param {Date|string} [options.now]
 * @returns {{ files: Record<string, string>, summary: object }}
 *          files: `{ 'manifest.json': string, 'README.txt': string, 'SHA256SUMS': string }`
 */
export function buildEvidencePack({ store, ledger, ids, now = new Date() } = {}) {
  if (!ledger || typeof ledger !== 'object') throw new TypeError('buildEvidencePack requires a ledger')
  if (!store || typeof store !== 'object') throw new TypeError('buildEvidencePack requires a store')
  const createdAt = isoDate(now)
  const requested = normalizeRequestedIds(ids, ledger)
  const entries = []

  for (const id of requested.commitments) {
    const result = evidenceForCommitment(store, ledger, id)
    entries.push({
      kind: 'commitment',
      id,
      found: Boolean(result.commitment),
      sources: result.sources,
      missing: result.missing,
    })
  }
  for (const id of requested.facts) {
    const result = evidenceForFact(store, ledger, id)
    entries.push({ kind: 'fact', id, found: Boolean(result.fact), sources: result.sources, missing: result.missing })
  }
  for (const id of requested.preferences) {
    const result = evidenceForPreference(store, ledger, id)
    entries.push({
      kind: 'preference',
      id,
      found: Boolean(result.preference),
      sources: result.sources,
      missing: result.missing,
    })
  }
  for (const id of requested.unknown) {
    entries.push({ kind: 'unknown', id, found: false, sources: [], missing: [{ id, reason: 'record_not_found' }] })
  }

  const compacted = entries
    .map(compactEntry)
    .sort(compareEntries)

  const manifestJson = manifestFor(compacted, { createdAt })
  const manifestDigest = sha256Hex(manifestJson)
  const readme = buildReadme({ createdAt, entries: compacted, manifestDigest })
  const readmeDigest = sha256Hex(readme)
  const sums = [`${readmeDigest}  README.txt`, `${manifestDigest}  manifest.json`].join('\n') + '\n'

  const counts = { commitment: 0, fact: 0, preference: 0, unknown: 0 }
  let sourceCount = 0
  let missingCount = 0
  let truncatedCount = 0
  for (const entry of compacted) {
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
    sourceCount += entry.sources.length
    missingCount += entry.missing.length
    truncatedCount += entry.sources.filter((source) => source.truncated).length
  }

  return {
    files: {
      'manifest.json': manifestJson,
      'README.txt': readme,
      'SHA256SUMS': sums,
    },
    summary: {
      format: MANIFEST_FORMAT,
      version: MANIFEST_VERSION,
      createdAt,
      entryCount: compacted.length,
      counts,
      sourceCount,
      missingCount,
      truncatedCount,
      notFound: compacted.filter((entry) => !entry.found).map((entry) => entry.id),
      fileHashes: { 'manifest.json': manifestDigest, 'README.txt': readmeDigest },
      entries: compacted,
    },
  }
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

function isUnsafePackPath(name) {
  if (!name) return true
  if (name.startsWith('/') || name.startsWith('\\')) return true
  if (/^[A-Za-z]:[\\/]/.test(name)) return true
  return name.split(/[\\/]/).some((part) => part === '..')
}

/**
 * Recompute SHA256SUMS. A pack is `ok` only when every checksum matches, both
 * core files are covered, the manifest parses, and no extra file is smuggled in
 * unhashed. Tampering with any pack file must flip `ok` to false.
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
export function verifyPack(files) {
  const errors = []
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return { ok: false, errors: ['pack must be an object mapping file names to contents'] }
  }
  const sumsText = textOf(files.SHA256SUMS)
  if (sumsText === null) return { ok: false, errors: ['SHA256SUMS is missing or unreadable'] }

  const listed = new Map()
  for (const raw of sumsText.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line)
    if (!match) {
      errors.push(`malformed SHA256SUMS line: ${line.slice(0, 80)}`)
      continue
    }
    const name = match[2].trim()
    if (!name) {
      errors.push('malformed SHA256SUMS line: empty file name')
      continue
    }
    if (isUnsafePackPath(name)) {
      errors.push(`unsafe path in SHA256SUMS: ${name}`)
      continue
    }
    if (name === 'SHA256SUMS') {
      errors.push('SHA256SUMS must not list itself')
      continue
    }
    if (listed.has(name)) {
      errors.push(`duplicate entry in SHA256SUMS: ${name}`)
      continue
    }
    listed.set(name, match[1].toLowerCase())
  }

  for (const name of REQUIRED_PACK_FILES) {
    if (!listed.has(name)) errors.push(`SHA256SUMS does not cover ${name}`)
  }

  for (const [name, expected] of listed) {
    const bytes = toBytes(files[name])
    if (!bytes) {
      errors.push(`missing file: ${name}`)
      continue
    }
    if (sha256Hex(bytes) !== expected) errors.push(`hash mismatch: ${name}`)
  }

  for (const name of Object.keys(files)) {
    if (name === 'SHA256SUMS') continue
    if (!listed.has(name)) errors.push(`file not covered by SHA256SUMS: ${name}`)
    if (files[name] === undefined || files[name] === null) errors.push(`missing file: ${name}`)
  }

  const manifestText = textOf(files['manifest.json'])
  if (manifestText !== null) {
    try {
      const manifest = JSON.parse(manifestText)
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        errors.push('manifest.json is not a JSON object')
      }
    } catch {
      errors.push('manifest.json is not valid JSON')
    }
  }

  return { ok: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// optional CLI helper: rows for the office DOCX builder (no docx is created here)
// ---------------------------------------------------------------------------

function entryFromResult(result) {
  const record = result?.commitment ?? result?.fact ?? result?.preference
  if (!record) return undefined
  const kind = result.commitment ? 'commitment' : result.fact ? 'fact' : 'preference'
  return {
    kind,
    id: record.id,
    found: true,
    sources: Array.isArray(result.sources) ? result.sources : [],
    missing: Array.isArray(result.missing) ? result.missing : [],
  }
}

function extractEntries(input) {
  if (!input) return []
  if (typeof input === 'string') {
    try {
      return extractEntries(JSON.parse(input))
    } catch {
      return []
    }
  }
  if (Array.isArray(input)) {
    const out = []
    for (const item of input) {
      if (!item || typeof item !== 'object') continue
      if (item.commitment || item.fact || item.preference) {
        const entry = entryFromResult(item)
        if (entry) out.push(entry)
        continue
      }
      out.push(item)
    }
    return out
  }
  if (input.summary && Array.isArray(input.summary.entries)) return input.summary.entries
  if (Array.isArray(input.entries)) return input.entries
  if (input.files && input.files['manifest.json'] !== undefined) {
    try {
      return extractEntries(JSON.parse(textOf(input.files['manifest.json']) ?? ''))
    } catch {
      return []
    }
  }
  if (input.commitment || input.fact || input.preference) {
    const entry = entryFromResult(input)
    return entry ? [entry] : []
  }
  return []
}

/**
 * Flatten a pack (or evidence results, or `manifest.json` entries) into rows for
 * `office`'s DOCX table builder. Columns follow DOCX_EVIDENCE_HEADERS:
 * `[kind, id, session#turn, quote (<= 500 chars), 'ok' | 'missing: <reason>']`.
 * This helper never writes a DOCX — the CLI owns that.
 *
 * @returns {string[][]}
 */
export function toDocxRows(input, { maxRows = 200 } = {}) {
  const entries = extractEntries(input)
  const rows = []
  for (const entry of entries) {
    const kind = String(entry.kind ?? 'unknown')
    const id = String(entry.id ?? '')
    const sources = Array.isArray(entry.sources) ? entry.sources : []
    const missing = Array.isArray(entry.missing) ? entry.missing : []
    if (!sources.length && !missing.length) {
      rows.push([kind, id, '', '', entry.found === false ? '记录不存在' : '无证据'])
      continue
    }
    for (const source of sources) {
      rows.push([
        kind,
        id,
        formatRef(source.sessionId, source.turnId),
        clampQuote(source.quote).quote,
        entry.found === false ? '记录不存在' : 'ok',
      ])
    }
    for (const item of missing) {
      rows.push([
        kind,
        id,
        item.ref || formatRef(item.sessionId, item.turnId) || String(item.id ?? ''),
        clampQuote(item.quote).quote,
        `missing: ${item.reason ?? 'unknown'}`,
      ])
    }
  }
  if (rows.length > maxRows) {
    const hidden = rows.length - maxRows
    const kept = rows.slice(0, Math.max(0, maxRows - 1))
    return [...kept, ['…', '', '', '', `${hidden} 行未显示`]]
  }
  return rows
}
