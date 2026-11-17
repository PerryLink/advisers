/**
 * E3: evidence chain, evidence pack (v1) and delivery receipt pack (v1.1).
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
 * `buildReceiptPack` is the delivery-receipt upgrade (competitive report
 * 21-w2-delivery-trust.md §2.2 / hardening 13-gap-inventory.md P1-2). It
 * copies the delivered artifacts, a generated receipt.docx, the evidence
 * entries, the generator environment and the verify results into one directory,
 * and SHA256SUMS covers every file — `lib/receipt-verify.js` verifies such a
 * directory offline.
 *
 * Constraints baked into the design:
 * - Offline: no network calls; imports only node:crypto/node:fs/node:path (plus
 *   an optional in-process `advisers-office` build for the receipt DOCX).
 * - No fabrication: an unknown turn, a session mismatch or an unparseable
 *   `session#turn` ref goes to `missing`; nothing is guessed.
 * - No leaks: no absolute filesystem paths, no full turn/transcript bodies and
 *   no matter summaries/snippets other than the evidence quotes themselves.
 * - SHA256SUMS is tamper-evidence (accidental/deterministic edits), not a
 *   signature: whoever can rewrite the whole pack can recompute the sums.
 *
 * The directory writer/CLI entry point for the evidence pack is intentionally
 * out of scope here. `buildReceiptPack` can optionally write the receipt pack
 * directory itself (`outDir`), because the receipt's 0600 mode is part of the
 * format contract.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Quotes are verbatim evidence but capped, so a pack never carries a full body. */
export const MAX_QUOTE_CHARS = 500
export const MANIFEST_FORMAT = 'advisers-evidence-pack'
export const MANIFEST_VERSION = 1
/**
 * Default cap for the "pack everything" path (0.2.0 performance audit P0-3).
 * A pack built from every row in a large ledger is slow and huge; callers must
 * narrow with `ids` or opt into the full pack explicitly (CLI: --ids / --all).
 */
export const DEFAULT_MAX_EVIDENCE_ENTRIES = 2000

/**
 * Raised instead of silently building an enormous pack. The CLI maps this to a
 * non-zero exit code and prints the hint; library callers can inspect
 * `code`/`count`/`limit` and retry with `all: true` after an explicit
 * user confirmation.
 */
export class EvidencePackLimitError extends Error {
  constructor(count, limit) {
    super(
      `evidence pack would include ${count} entries (limit ${limit}); ` +
        'pass --ids to select specific records or --all to build the full pack',
    )
    this.name = 'EvidencePackLimitError'
    this.code = 'EVIDENCE_PACK_TOO_LARGE'
    this.count = count
    this.limit = limit
    this.hint = 'Use --ids cm_...,fact_...,pref_... to narrow the pack, or --all to lift the limit.'
  }
}

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
// ledger lookups
// ---------------------------------------------------------------------------

/**
 * One-shot id index over a ledger snapshot.
 *
 * `buildEvidencePack` used to call `listFacts()`/`listCommitments()` once per
 * requested id, which made the full pack O(N²): 80k entries took 113.75s
 * (performance audit P0-3). Building the index once turns every per-entry
 * lookup into a Map.get, so the full pack is linear. The same index also stops
 * `classifyKind` from re-scanning the ledger for unprefixed ids.
 *
 * The index is a snapshot: do not reuse it after mutating the ledger.
 *
 * @returns {{commitments: Map<string, object>, facts: Map<string, object>,
 *            preferences: Map<string, object>, ledger: object}}
 */
export function createEvidenceIndex(ledger) {
  const commitments = new Map()
  const facts = new Map()
  const preferences = new Map()
  if (!ledger || typeof ledger !== 'object') return { commitments, facts, preferences, ledger }

  try {
    if (typeof ledger.listCommitments === 'function') {
      for (const row of ledger.listCommitments() ?? []) if (row?.id) commitments.set(row.id, row)
    }
  } catch {
    // A partial/legacy ledger may not expose commitments; lookups fall back below.
  }
  let historyIndexed = false
  try {
    let rows = []
    if (typeof ledger.listFacts === 'function') {
      try {
        rows = ledger.listFacts(undefined, true) ?? []
        historyIndexed = true
      } catch {
        rows = ledger.listFacts() ?? []
      }
    }
    for (const row of rows) if (row?.id) facts.set(row.id, row)
  } catch {
    // ignore; the snapshot fallback below still runs
  }
  // Last resort used by the non-indexed findFact: the portable snapshot also
  // includes tombstones/history that a filtered listFacts may omit. Only pay for
  // the O(N) snapshot when the history-inclusive scan was not available.
  if (!historyIndexed && typeof ledger.toJSON === 'function') {
    try {
      for (const row of ledger.toJSON()?.facts ?? []) if (row?.id && !facts.has(row.id)) facts.set(row.id, row)
    } catch {
      // ignore
    }
  }
  try {
    if (typeof ledger.listPreferences === 'function') {
      for (const row of ledger.listPreferences({ includeCandidates: true }) ?? []) if (row?.id) preferences.set(row.id, row)
    }
  } catch {
    // ignore
  }
  return { commitments, facts, preferences, ledger }
}

function findCommitment(ledger, id, index) {
  if (!ledger || !id) return undefined
  if (index?.commitments instanceof Map) return index.commitments.get(id)
  if (typeof ledger.getCommitment === 'function') {
    const hit = ledger.getCommitment(id)
    if (hit) return hit
  }
  const rows = typeof ledger.listCommitments === 'function' ? ledger.listCommitments() : []
  return rows.find((row) => row?.id === id)
}

function findFact(ledger, id, index) {
  if (!ledger || !id) return undefined
  if (index?.facts instanceof Map) return index.facts.get(id)
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

function findPreference(ledger, id, index) {
  if (!ledger || !id) return undefined
  if (index?.preferences instanceof Map) return index.preferences.get(id)
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
export function evidenceForCommitment(store, ledger, commitmentId, index) {
  const commitment = findCommitment(ledger, commitmentId, index)
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
export function evidenceForFact(store, ledger, factId, index) {
  const fact = findFact(ledger, factId, index)
  if (!fact) {
    return { fact: undefined, sources: [], missing: [{ id: factId, reason: 'fact_not_found' }] }
  }
  const refs = collectSourceRefs(fact.evidence, primarySourceCandidates(fact.source))
  const resolved = resolveSourceRefs(store, refs)
  return { fact, sources: resolved.sources, missing: resolved.missing }
}

/** Trace a preference's `SourceRef[]` (plus its primary `source`) back to turns. */
export function evidenceForPreference(store, ledger, preferenceId, index) {
  const preference = findPreference(ledger, preferenceId, index)
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

function classifyKind(ledger, id, kind, index) {
  const explicit = normalizeKind(kind)
  if (explicit) return explicit
  const inferred = inferKindFromId(id)
  if (inferred) return inferred
  if (findCommitment(ledger, id, index)) return 'commitment'
  if (findFact(ledger, id, index)) return 'fact'
  if (findPreference(ledger, id, index)) return 'preference'
  return 'unknown'
}

function normalizeRequestedIds(ids, ledger, index) {
  const out = { commitments: [], facts: [], preferences: [], unknown: [] }
  const seen = new Set()
  const push = (id, kind) => {
    const value = id === undefined || id === null ? '' : String(id).trim()
    if (!value) return
    const resolved = classifyKind(ledger, value, kind, index)
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
 * The default path is capped at `DEFAULT_MAX_EVIDENCE_ENTRIES` entries
 * (performance audit P0-3): a pack over every row of a 50k-row ledger is slow
 * and huge. When the cap would be exceeded this throws
 * `EvidencePackLimitError`; pass `all: true` (CLI: `--all`) after an explicit
 * user confirmation, or narrow the selection with `ids` (CLI: `--ids`).
 *
 * @param {object} options
 * @param {object} options.store  SqliteStore-like (`getTurn`/`listTurns`, `getTurn` optional)
 * @param {object} options.ledger Ledger instance (listCommitments/listFacts/findPreference)
 * @param {object|Array|string} [options.ids] `{commitments, facts, preferences}`, an id array,
 *        a single id, or `[{kind, id}]`. `cm_`/`fact_`/`pref_` prefixes are inferred.
 * @param {Date|string} [options.now]
 * @param {number} [options.limit=DEFAULT_MAX_EVIDENCE_ENTRIES] max entries before
 *        `EvidencePackLimitError` (Infinity disables the cap).
 * @param {boolean} [options.all=false] explicit "build the whole pack" opt-in.
 * @returns {{ files: Record<string, string>, summary: object }}
 *          files: `{ 'manifest.json': string, 'README.txt': string, 'SHA256SUMS': string }`
 */
export function buildEvidencePack({
  store,
  ledger,
  ids,
  now = new Date(),
  limit = DEFAULT_MAX_EVIDENCE_ENTRIES,
  all = false,
} = {}) {
  if (!ledger || typeof ledger !== 'object') throw new TypeError('buildEvidencePack requires a ledger')
  if (!store || typeof store !== 'object') throw new TypeError('buildEvidencePack requires a store')
  const createdAt = isoDate(now)
  const effectiveLimit = all ? Infinity : Number(limit)
  if (!(effectiveLimit === Infinity || (Number.isInteger(effectiveLimit) && effectiveLimit >= 0))) {
    throw new TypeError('buildEvidencePack limit must be a non-negative integer or Infinity')
  }
  const requestedAny = ids !== undefined && ids !== null && !(Array.isArray(ids) && ids.length === 0)
  // Build the lookup index once; every evidenceFor* call below then costs O(1)
  // instead of re-scanning listFacts()/listCommitments() (P0-3: 80k pack went
  // from 113.75s to linear time).
  const index = requestedAny ? createEvidenceIndex(ledger) : undefined
  const requested = normalizeRequestedIds(ids, ledger, index)
  const requestedCount =
    requested.commitments.length + requested.facts.length + requested.preferences.length + requested.unknown.length
  if (requestedCount > effectiveLimit) throw new EvidencePackLimitError(requestedCount, effectiveLimit)
  const entries = []

  for (const id of requested.commitments) {
    const result = evidenceForCommitment(store, ledger, id, index)
    entries.push({
      kind: 'commitment',
      id,
      found: Boolean(result.commitment),
      sources: result.sources,
      missing: result.missing,
    })
  }
  for (const id of requested.facts) {
    const result = evidenceForFact(store, ledger, id, index)
    entries.push({ kind: 'fact', id, found: Boolean(result.fact), sources: result.sources, missing: result.missing })
  }
  for (const id of requested.preferences) {
    const result = evidenceForPreference(store, ledger, id, index)
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

export function isUnsafePackPath(name) {
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
// delivery receipt pack v1.1
//
// Competitive report 21-w2-delivery-trust.md §2.2 and hardening
// 13-gap-inventory.md P1-2: the evidence pack above is an evidence pack; a
// delivery receipt pack is different. This section copies the delivered
// artifacts into one directory, generates receipt.docx, records the generator
// environment and the verify results, and makes SHA256SUMS cover EVERY file
// (manifest.json, README.txt, receipt.docx and every delivery artifact).
//
// lib/receipt-verify.js verifies such a directory offline. This module never
// calls the network and never needs ~/.advisers to assemble the pack.
// ---------------------------------------------------------------------------

export const RECEIPT_MANIFEST_FORMAT = 'advisers-delivery-receipt-pack'
export const RECEIPT_MANIFEST_VERSION = 1
export const RECEIPT_SHA256SUMS_FILE = 'SHA256SUMS'
/** Files every receipt pack must carry; SHA256SUMS covers all of them. */
export const RECEIPT_REQUIRED_FILES = Object.freeze(['manifest.json', 'README.txt', 'receipt.docx'])
/** Delivery artifacts live under this prefix inside the pack. */
export const RECEIPT_DELIVERIES_PREFIX = 'deliveries/'
/** Pack files are owner-read/write only (security audit P1-2 / P2-10). */
export const RECEIPT_FILE_MODE = 0o600
export const RECEIPT_DIR_MODE = 0o700
const RECEIPT_MAX_ANCHOR_PROOF_CHARS = 200_000
const RECEIPT_MAX_TABLE_ROWS = 120
const RECEIPT_MAX_DELIVERY_ROWS = 40
const RECEIPT_MAX_MANIFEST_ITEMS = 200

let advisersVersionCache
function evidenceModuleDirVersion() {
  if (advisersVersionCache !== undefined) return advisersVersionCache
  advisersVersionCache = null
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (typeof pkg.version === 'string' && pkg.version) advisersVersionCache = pkg.version
  } catch {
    // Bundled/copied layouts may not ship package.json next to lib/.
  }
  return advisersVersionCache
}

function receiptText(value) {
  return typeof value === 'string' && value ? value : null
}

function receiptDateText(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback
  try {
    return isoDate(value)
  } catch {
    throw new TypeError('invalid date in receipt pack input: ' + String(value))
  }
}

function receiptShaText(value) {
  return typeof value === 'string' ? value.toLowerCase() : ''
}

function isSha256Hex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function sanitizeSegment(raw, fallback = 'item') {
  let text = String(raw === undefined || raw === null ? '' : raw)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
  text = text.replace(/^\.+/, '').replace(/\.+$/, '')
  if (!text) text = fallback
  return text.slice(0, 120)
}

function basenameOf(filePath) {
  const text = String(filePath === undefined || filePath === null ? '' : filePath).replace(/\\/g, '/')
  return sanitizeSegment(text.slice(text.lastIndexOf('/') + 1), 'file')
}

function uniqueName(name, used) {
  const base = sanitizeSegment(name, 'file')
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = stem + '-' + i + ext
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
  throw new Error('could not derive a unique pack file name from ' + base)
}

const RECEIPT_ABS_PATH_TOKEN = /(^|[\s"'=(,])((?:[A-Za-z]:[\\/]|\/)[^\s"'<>|,)]*)/g
/**
 * Redact absolute filesystem path tokens from operator-supplied free text
 * (generator.command, recipient fields). Relative names such as a/b.docx are
 * left alone; evidence quotes are never scrubbed (verbatim quotes must stay
 * byte-identical to their quoteSha256).
 */
function scrubPathText(value) {
  const text = receiptText(value)
  if (text === null) return null
  let out = text.length > 500 ? text.slice(0, 500) : text
  try {
    out = out.split(process.cwd()).join('<cwd>')
  } catch {
    // process.cwd() can throw if the working directory was deleted; ignore.
  }
  return out.replace(RECEIPT_ABS_PATH_TOKEN, (match, lead) => lead + '<path>')
}

function readDeliveryBytes(source, deliveryId, displayName) {
  try {
    const stat = statSync(source)
    if (!stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' })
    return readFileSync(source)
  } catch (error) {
    const code = error && error.code ? error.code : error.message
    throw new Error('delivery ' + deliveryId + ' file is not readable: ' + displayName + ' (' + code + ')')
  }
}

function normalizeDeliveryFile(file, deliveryId, fileIndex) {
  if (typeof file === 'string') {
    const name = basenameOf(file)
    return { bytes: readDeliveryBytes(file, deliveryId, name), name }
  }
  if (file && typeof file === 'object' && !Array.isArray(file)) {
    const sourcePath = typeof file.sourcePath === 'string' ? file.sourcePath : typeof file.path === 'string' ? file.path : ''
    const name = basenameOf(file.name || (sourcePath ? basenameOf(sourcePath) : 'file-' + (fileIndex + 1)))
    const embedded = file.content !== undefined ? file.content : file.bytes
    if (embedded !== undefined && embedded !== null) {
      const bytes = toBytes(embedded)
      if (!bytes) {
        throw new TypeError('delivery ' + deliveryId + ' file ' + name + ' content must be a string, Buffer, Uint8Array or ArrayBuffer')
      }
      return { bytes, name }
    }
    if (!sourcePath) {
      throw new TypeError('delivery ' + deliveryId + ' file #' + (fileIndex + 1) + ' needs content or sourcePath/path')
    }
    return { bytes: readDeliveryBytes(sourcePath, deliveryId, name), name }
  }
  throw new TypeError('delivery ' + deliveryId + ' file #' + (fileIndex + 1) + ' must be a path string or an object')
}

function normalizeReceiptDeliveries(deliveries) {
  const input = Array.isArray(deliveries) ? deliveries : deliveries ? [deliveries] : []
  if (!input.length) {
    throw new TypeError(
      'buildReceiptPack requires at least one delivery ({deliveries: [{id, title, files, ...}]}); ' +
        'use buildEvidencePack for an evidence-only pack',
    )
  }
  const usedIds = new Set()
  return input.map((delivery, index) => {
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
      throw new TypeError('delivery #' + (index + 1) + ' must be an object')
    }
    const rawId = delivery.id === undefined || delivery.id === null || delivery.id === '' ? 'delivery-' + (index + 1) : String(delivery.id)
    const id = uniqueName(rawId, usedIds)
    const rawFiles = delivery.files !== undefined ? delivery.files : delivery.artifacts !== undefined ? delivery.artifacts : delivery.outputs
    if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
      throw new TypeError('delivery ' + id + ' has no files to include in the receipt pack')
    }
    const usedNames = new Set()
    const files = rawFiles.map((file, fileIndex) => {
      const read = normalizeDeliveryFile(file, id, fileIndex)
      const name = uniqueName(read.name, usedNames)
      const sha256 = sha256Hex(read.bytes)
      return {
        name,
        path: RECEIPT_DELIVERIES_PREFIX + id + '/' + name,
        size: read.bytes.length,
        sha256,
        content: read.bytes,
      }
    })
    let validation = null
    if (delivery.validation !== undefined && delivery.validation !== null) {
      if (typeof delivery.validation === 'string') validation = delivery.validation.slice(0, 500)
      else {
        try {
          validation = JSON.stringify(delivery.validation).slice(0, 500)
        } catch {
          validation = null
        }
      }
    }
    return {
      id,
      title: receiptText(delivery.title),
      tool: receiptText(delivery.tool),
      createdAt: receiptDateText(delivery.createdAt !== undefined ? delivery.createdAt : delivery.created_at, null),
      validation,
      files,
    }
  })
}

// --- evidence entries (re-sanitized: the receipt pack keeps references and
// --- capped quotes only, never full turn bodies) ---------------------------

function receiptSource(source) {
  if (source && typeof source === 'object' && source.turn) return compactSource(source)
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { sessionId: '', turnId: '', quote: '', quoteChars: 0, truncated: false, quoteSha256: sha256Hex('') }
  }
  const rawQuote = typeof source.quote === 'string' ? source.quote : ''
  const chars = Array.from(rawQuote)
  const quote = chars.length > MAX_QUOTE_CHARS ? chars.slice(0, MAX_QUOTE_CHARS).join('') : rawQuote
  let quoteChars = chars.length
  if (Number.isInteger(source.quoteChars) && source.quoteChars >= quoteChars) quoteChars = source.quoteChars
  const entry = {
    sessionId: typeof source.sessionId === 'string' ? source.sessionId : '',
    turnId: typeof source.turnId === 'string' ? source.turnId : '',
    quote,
    quoteChars,
    truncated: typeof source.truncated === 'boolean' ? source.truncated : quoteChars > MAX_QUOTE_CHARS,
    quoteSha256: sha256Hex(quote),
  }
  if (Number.isInteger(source.turnSeq)) entry.turnSeq = source.turnSeq
  if (typeof source.turnRole === 'string') entry.turnRole = source.turnRole
  return entry
}

function receiptMissing(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { reason: 'unknown' }
  const out = { reason: typeof item.reason === 'string' ? item.reason : 'unknown' }
  for (const key of ['id', 'ref', 'sessionId', 'turnId']) {
    if (typeof item[key] === 'string' && item[key]) out[key] = item[key]
  }
  if (typeof item.quote === 'string' && item.quote.length) {
    const clamped = clampQuote(item.quote)
    if (Number.isInteger(item.quoteChars) && item.quoteChars > clamped.quoteChars) {
      clamped.quoteChars = item.quoteChars
      clamped.truncated = true
    }
    Object.assign(out, clamped)
  }
  return out
}

function receiptEvidenceEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  return {
    kind: typeof entry.kind === 'string' ? entry.kind : 'unknown',
    id: String(entry.id === undefined || entry.id === null ? '' : entry.id),
    found: Boolean(entry.found),
    sources: (Array.isArray(entry.sources) ? entry.sources : []).map(receiptSource),
    missing: (Array.isArray(entry.missing) ? entry.missing : []).map(receiptMissing),
  }
}

function normalizeReceiptEvidence(evidence) {
  const meta = { format: MANIFEST_FORMAT, version: MANIFEST_VERSION }
  let list = []
  if (evidence === undefined || evidence === null) {
    list = []
  } else if (typeof evidence === 'string') {
    try {
      return normalizeReceiptEvidence(JSON.parse(evidence))
    } catch {
      list = []
    }
  } else if (Array.isArray(evidence)) {
    list = evidence
  } else if (typeof evidence === 'object') {
    if (evidence.summary && Array.isArray(evidence.summary.entries)) {
      if (typeof evidence.summary.format === 'string') meta.format = evidence.summary.format
      if (Number.isInteger(evidence.summary.version)) meta.version = evidence.summary.version
      list = evidence.summary.entries
    } else if (Array.isArray(evidence.entries)) {
      list = evidence.entries
    } else if (evidence.files && typeof evidence.files === 'object') {
      const manifestText = textOf(evidence.files['manifest.json'])
      if (typeof manifestText === 'string') {
        try {
          const parsed = JSON.parse(manifestText)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            if (typeof parsed.format === 'string') meta.format = parsed.format
            if (Number.isInteger(parsed.version)) meta.version = parsed.version
            list = Array.isArray(parsed.entries) ? parsed.entries : []
          }
        } catch {
          list = []
        }
      }
    }
  }
  const entries = list.map(receiptEvidenceEntry).filter(Boolean)
  entries.sort(compareEntries)
  const counts = { commitment: 0, fact: 0, preference: 0, unknown: 0 }
  let sourceCount = 0
  let missingCount = 0
  for (const entry of entries) {
    counts[entry.kind] = (counts[entry.kind] || 0) + 1
    sourceCount += entry.sources.length
    missingCount += entry.missing.length
  }
  return {
    format: meta.format,
    version: meta.version,
    entryCount: entries.length,
    counts,
    sourceCount,
    missingCount,
    entries,
  }
}

// --- verify results ---------------------------------------------------------

function receiptCheck(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return null
  const out = {
    id: typeof check.id === 'string' ? check.id.slice(0, 120) : 'check',
    ok: Boolean(check.ok),
  }
  if (typeof check.severity === 'string') out.severity = check.severity.slice(0, 20)
  if (typeof check.detail === 'string') out.detail = check.detail.slice(0, 300)
  if (check.skipped === true) out.skipped = true
  return out
}

function receiptStringList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string')
    .slice(0, RECEIPT_MAX_MANIFEST_ITEMS)
    .map((item) => item.slice(0, 300))
}

function receiptVerifyResult(result, index) {
  if (typeof result === 'boolean') {
    return { source: null, ok: result, checkedAt: null, errors: [], checks: [], summary: null }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('verifyResults[' + index + '] must be an object with a boolean ok')
  }
  if (typeof result.ok !== 'boolean') throw new TypeError('verifyResults[' + index + '].ok must be a boolean')
  let checkedAt = null
  try {
    checkedAt = receiptDateText(result.checkedAt !== undefined ? result.checkedAt : result.at, null)
  } catch {
    checkedAt = null
  }
  const checks = Array.isArray(result.checks)
    ? result.checks.map(receiptCheck).filter(Boolean).slice(0, RECEIPT_MAX_MANIFEST_ITEMS)
    : []
  return {
    source: receiptText(result.source !== undefined ? result.source : result.tool !== undefined ? result.tool : result.command),
    ok: result.ok,
    checkedAt,
    errors: receiptStringList(result.errors),
    checks,
    summary: receiptText(result.summary !== undefined ? result.summary : result.detail),
  }
}

function normalizeReceiptVerifyResults(verifyResults) {
  if (verifyResults === undefined || verifyResults === null) return []
  const list = Array.isArray(verifyResults) ? verifyResults : [verifyResults]
  return list.map((item, index) => receiptVerifyResult(item, index))
}

function receiptVerifyStatus(results) {
  if (!results.length) return 'not-recorded'
  return results.every((item) => item.ok) ? 'passed' : 'failed'
}

// --- generator / recipient / optional anchors -------------------------------

function normalizeReceiptGenerator(env) {
  const source = env && typeof env === 'object' && !Array.isArray(env) ? env : {}
  const template = source.template && typeof source.template === 'object' && !Array.isArray(source.template) ? source.template : {}
  const templateName =
    source.templateName !== undefined
      ? source.templateName
      : typeof source.template === 'string'
        ? source.template
        : template.name
  return {
    advisersVersion:
      receiptText(source.advisersVersion !== undefined ? source.advisersVersion : source.version) || evidenceModuleDirVersion(),
    nodeVersion: receiptText(source.nodeVersion !== undefined ? source.nodeVersion : source.node) || process.version,
    platform: receiptText(source.platform) || process.platform,
    templateName: scrubPathText(templateName),
    templateVersion: scrubPathText(source.templateVersion !== undefined ? source.templateVersion : template.version),
    command: scrubPathText(source.command),
  }
}

function normalizeReceiptRecipient(recipient) {
  if (recipient === undefined || recipient === null || recipient === '') return null
  if (typeof recipient === 'string') return { name: scrubPathText(recipient), email: null, note: null }
  if (typeof recipient !== 'object' || Array.isArray(recipient)) {
    throw new TypeError('recipient must be a string or an object {name, email, note}')
  }
  const out = {
    name: scrubPathText(recipient.name !== undefined ? recipient.name : recipient.to),
    email: scrubPathText(recipient.email),
    note: scrubPathText(recipient.note !== undefined ? recipient.note : recipient.description),
  }
  if (!out.name && !out.email && !out.note) return null
  return out
}

function normalizeReceiptAnchors(anchors) {
  if (anchors === undefined || anchors === null) return []
  const list = Array.isArray(anchors) ? anchors : [anchors]
  return list.map((anchor, index) => {
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
      throw new TypeError('anchors[' + index + '] must be an object')
    }
    const file = typeof anchor.file === 'string' ? anchor.file.replace(/\\/g, '/') : ''
    if (isUnsafePackPath(file)) throw new TypeError('anchors[' + index + '].file must be a safe relative pack path')
    const fileSha256 = receiptShaText(anchor.fileSha256)
    if (!isSha256Hex(fileSha256)) {
      throw new TypeError('anchors[' + index + '].fileSha256 must be 64 lowercase hex characters')
    }
    const adapterId = receiptText(anchor.adapterId)
    if (!adapterId) throw new TypeError('anchors[' + index + '].adapterId is required')
    let proof = ''
    if (typeof anchor.proof === 'string') proof = anchor.proof
    else if (Buffer.isBuffer(anchor.proof)) proof = anchor.proof.toString('base64')
    else if (anchor.proof instanceof Uint8Array) proof = Buffer.from(anchor.proof).toString('base64')
    if (!proof) throw new TypeError('anchors[' + index + '].proof is required')
    if (proof.length > RECEIPT_MAX_ANCHOR_PROOF_CHARS) {
      throw new RangeError('anchors[' + index + '].proof is larger than ' + RECEIPT_MAX_ANCHOR_PROOF_CHARS + ' characters')
    }
    return {
      file,
      fileSha256,
      adapterId: adapterId.slice(0, 120),
      issuedAt: receiptDateText(anchor.issuedAt, null),
      proof,
    }
  })
}

// --- minimal deterministic DOCX writer (fallback when advisers-office is not
// --- installed; a DOCX is a ZIP with [Content_Types].xml + word/document.xml) ----

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const ZIP_DOS_TIME = 0
const ZIP_DOS_DATE = 0x0021 // 1980-01-01: fixed so the fallback DOCX is byte-stable

function zipStoredFiles(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(ZIP_DOS_TIME, 10)
    local.writeUInt16LE(ZIP_DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const localBlock = Buffer.concat([local, name, data])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(ZIP_DOS_TIME, 12)
    central.writeUInt16LE(ZIP_DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(localBlock)
    centrals.push(Buffer.concat([central, name]))
    offset += localBlock.length
  }
  const centralBlock = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBlock.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBlock, eocd])
}

function escapeXmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function minimalDocx(spec) {
  const lines = [{ text: spec.title, bold: true }]
  if (spec.subtitle) lines.push({ text: spec.subtitle })
  for (const section of spec.sections || []) {
    if (section.heading) lines.push({ text: section.heading, bold: true })
    for (const paragraph of section.paragraphs || []) lines.push({ text: paragraph })
    for (const bullet of section.bullets || []) lines.push({ text: '- ' + bullet })
    if (section.table) {
      lines.push({ text: section.table.headers.join(' | '), bold: true })
      for (const row of section.table.rows || []) lines.push({ text: row.join(' | ') })
    }
  }
  const paragraphs = lines
    .map((line) => {
      const runProps = line.bold ? '<w:rPr><w:b/></w:rPr>' : ''
      return '<w:p><w:r>' + runProps + '<w:t xml:space="preserve">' + escapeXmlText(line.text) + '</w:t></w:r></w:p>'
    })
    .join('')
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
    '</w:body></w:document>'
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'
  const relationships =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'
  return zipStoredFiles([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(relationships, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ])
}

function assertReceiptDocxBuffer(buffer) {
  const bytes = toBytes(buffer)
  if (!bytes || bytes.length < 4) throw new TypeError('receipt DOCX builder returned no bytes')
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new TypeError('receipt DOCX builder did not return a ZIP/DOCX buffer')
  if (!bytes.includes(Buffer.from('word/document.xml', 'utf8'))) {
    throw new TypeError('receipt DOCX buffer is missing word/document.xml')
  }
  return bytes
}

async function buildReceiptDocxBytes(spec, docxBuilder) {
  if (typeof docxBuilder === 'function') return assertReceiptDocxBuffer(await docxBuilder(spec))
  if (docxBuilder !== false) {
    try {
      const office = await import('advisers-office')
      if (office && typeof office.buildDocx === 'function') {
        return assertReceiptDocxBuffer(await office.buildDocx(spec))
      }
    } catch {
      // Offline/portable install without the optional office peer: use the
      // built-in writer below (still a valid DOCX, just plainer).
    }
  }
  return assertReceiptDocxBuffer(minimalDocx(spec))
}

// --- receipt DOCX content / README / manifest --------------------------------

function formatBytesLabel(size) {
  if (!Number.isFinite(size)) return '?'
  if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MiB'
  if (size >= 1024) return (size / 1024).toFixed(1) + ' KiB'
  return size + ' B'
}

function receiptRecipientLabel(recipient) {
  if (!recipient) return 'none'
  const parts = []
  if (recipient.name) parts.push(recipient.name)
  if (recipient.email) parts.push('<' + recipient.email + '>')
  return parts.length ? parts.join(' ') : 'recorded (see manifest.json)'
}

function receiptDocxSpec(input) {
  const {
    createdAt,
    deliveries,
    evidence,
    verifyResults,
    verifyStatus,
    recipient,
    generator,
    anchors,
    deliveryFiles,
    receiptSha256,
  } = input
  const summary = [
    '包格式：' + RECEIPT_MANIFEST_FORMAT + ' v' + RECEIPT_MANIFEST_VERSION,
    '生成时间：' + createdAt,
    '收件人：' + (recipient && (recipient.name || recipient.email) ? recipient.name || recipient.email : '未填写'),
    '生成环境：Advisers ' + (generator.advisersVersion || 'unknown') + ' / Node ' + generator.nodeVersion + ' / ' + generator.platform,
    '模板：' + (generator.templateName ? generator.templateName + (generator.templateVersion ? '@' + generator.templateVersion : '') : '未记录'),
    '交付：' + deliveries.length + ' 项 / 文件 ' + deliveryFiles.length + ' 个',
    '校验结果：' + (verifyStatus === 'passed' ? '通过' : verifyStatus === 'failed' ? '未通过' : '未记录'),
    '时间锚：' + (anchors.length ? anchors.length + ' 条（外部锚，需按适配器另行验证）' : '未锚定（仅本地自证）'),
  ]
  const sections = [{ heading: '摘要', paragraphs: summary }]
  const deliveryRows = deliveries.slice(0, RECEIPT_MAX_DELIVERY_ROWS).map((delivery) => [
    delivery.id,
    delivery.title || '-',
    delivery.tool || '-',
    delivery.createdAt || '-',
    String(delivery.files.length),
  ])
  sections.push({
    heading: '交付清单',
    ...(deliveryRows.length
      ? { table: { headers: ['交付ID', '标题', '工具', '生成时间', '文件数'], rows: deliveryRows } }
      : { paragraphs: ['（没有交付记录）'] }),
  })
  if (deliveries.length > deliveryRows.length) {
    sections.push({ paragraphs: ['另有 ' + (deliveries.length - deliveryRows.length) + ' 项交付未在本回执中展开，见 manifest.json。'] })
  }
  const fileRows = deliveryFiles
    .slice(0, RECEIPT_MAX_TABLE_ROWS)
    .map((file) => [file.path, formatBytesLabel(file.size), file.sha256])
  fileRows.push(['receipt.docx', '见摘要', receiptSha256])
  sections.push({
    heading: '文件与 SHA-256（交付文件 + 回执）',
    table: { headers: ['文件（包内相对路径）', '大小', 'SHA-256'], rows: fileRows },
    ...(deliveryFiles.length > RECEIPT_MAX_TABLE_ROWS
      ? { paragraphs: ['另有 ' + (deliveryFiles.length - RECEIPT_MAX_TABLE_ROWS) + ' 个交付文件未展开，完整清单见 manifest.json / SHA256SUMS。'] }
      : {}),
  })
  const verifyRows = verifyResults.map((item) => [
    item.source || '未命名',
    item.ok ? '通过' : '未通过',
    item.summary || (item.checks.length ? item.checks.length + ' checks' : item.errors.length ? item.errors.length + ' errors' : '-'),
  ])
  sections.push({
    heading: '校验结果',
    ...(verifyRows.length
      ? { table: { headers: ['来源', '结果', '说明'], rows: verifyRows } }
      : { paragraphs: ['未记录校验结果（verify 未运行或结果未传入）。'] }),
  })
  sections.push({
    heading: '证据摘要',
    paragraphs: [
      '证据条目：' + evidence.entryCount + '（commitment ' + evidence.counts.commitment + ' / fact ' + evidence.counts.fact + ' / preference ' + evidence.counts.preference + ' / unknown ' + evidence.counts.unknown + '）',
      '已解析来源：' + evidence.sourceCount + '；缺失来源：' + evidence.missingCount,
      '完整证据条目（session#turn 引用与截断引用原话）见 manifest.json 的 evidence 字段。',
    ],
  })
  sections.push({
    heading: '声明',
    bullets: [
      '本回执包由 Advisers 在本地生成，生成与验证过程不访问网络。',
      'SHA-256 校验和用于检测生成后的改动；它不是电子签名、第三方时间戳、公证或司法存证。',
      '收件人字段只是操作者填写的记录，不代表对方签收、同意或已收到。',
      '未锚定时，包内时间只是本机时钟记录，可被重新打包者改写。',
    ],
  })
  return { title: '交付回执', subtitle: 'Delivery receipt · ' + createdAt, sections }
}

function receiptFilesList(fileContents) {
  return [...fileContents.entries()]
    .map(([path, content]) => {
      const bytes = toBytes(content)
      return { path, size: bytes.length, sha256: sha256Hex(bytes) }
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

function buildReceiptSums(fileContents) {
  const lines = receiptFilesList(fileContents)
    .filter((file) => file.path !== RECEIPT_SHA256SUMS_FILE)
    .map((file) => file.sha256 + '  ' + file.path)
  return lines.join('\n') + '\n'
}

function buildReceiptReadme(input) {
  const { createdAt, generator, recipient, deliveries, evidence, verifyResults, verifyStatus, anchors, manifestDigest } = input
  const lines = [
    'Advisers delivery receipt pack',
    '==============================',
    '',
    'format:      ' + RECEIPT_MANIFEST_FORMAT + ' v' + RECEIPT_MANIFEST_VERSION,
    'created:     ' + createdAt,
    'recipient:   ' + receiptRecipientLabel(recipient),
    'generator:   advisers ' + (generator.advisersVersion || 'unknown') + ' / node ' + generator.nodeVersion + ' / ' + generator.platform,
    'template:    ' + (generator.templateName ? generator.templateName + (generator.templateVersion ? ' v' + generator.templateVersion : '') : 'not recorded'),
    'command:     ' + (generator.command || 'not recorded'),
    'deliveries:  ' + deliveries.length,
    'verification:' + ' ' + (verifyStatus === 'passed' ? 'passed' : verifyStatus === 'failed' ? 'FAILED' : 'not recorded') + (verifyResults.length ? ' (' + verifyResults.length + ' result(s))' : ''),
    'anchors:     ' + (anchors.length ? anchors.length + ' external anchor(s) recorded' : 'NONE - this pack is not externally anchored (local self-attestation only)'),
    '',
    'These files were delivered (relative paths inside this directory)',
    '------------------------------------------------------------------',
  ]
  for (const delivery of deliveries) {
    lines.push(
      '- ' +
        delivery.id +
        (delivery.title ? ' ' + delivery.title : '') +
        (delivery.tool ? ' [' + delivery.tool + ']' : '') +
        (delivery.createdAt ? ' ' + delivery.createdAt : ''),
    )
    for (const file of delivery.files) {
      lines.push('    ' + file.path + '  (' + formatBytesLabel(file.size) + ')  sha256 ' + file.sha256)
    }
  }
  if (!deliveries.length) lines.push('(none)')
  lines.push(
    '',
    'Files and checksums',
    '-------------------',
    'manifest.json  sha256 ' + manifestDigest,
    'README.txt     this file',
    'receipt.docx   generated delivery receipt (see manifest.json for its sha256)',
    'SHA256SUMS     sha256 of every other file in this pack',
    '',
    'Evidence entries: ' + evidence.entryCount + ' (sources ' + evidence.sourceCount + ', missing ' + evidence.missingCount + ')',
    '(references and capped quotes only; see manifest.json evidence.entries)',
    '',
    'Verify (offline, no ~/.advisers database needed)',
    '-----------------------------------------------',
    '1. advisers evidence verify <this-directory>',
    '2. or with coreutils: cd <this-directory> && sha256sum -c SHA256SUMS',
    '',
    'The checksums detect edits made after generation. They are not a signature,',
    'not a trusted timestamp and not notarization: anyone able to rewrite the whole',
    'pack can recompute them. When the anchors line above says NONE, the pack only',
    'proves internal consistency, not when or by whom it was produced.',
    '',
    'Privacy and scope',
    '-----------------',
    '- Built locally; no network calls; verification does not open the ledger.',
    '- Contains relative paths, copies of the delivered files, SHA-256 digests and',
    '  evidence quotes capped at ' + MAX_QUOTE_CHARS + ' characters; no full turn bodies.',
    '- The recipient field is an operator-entered record. It is not an e-signature',
    '  and does not prove receipt, acceptance or agreement by the recipient.',
    '- Deleting this pack does not modify the local ledger or database.',
  )
  return lines.join('\n') + '\n'
}

function writeReceiptPackDir(targetDir, fileContents, { overwrite = false } = {}) {
  const target = resolve(String(targetDir))
  mkdirSync(dirname(target), { recursive: true })
  let replaced = null
  if (existsSync(target)) {
    const stat = statSync(target)
    if (!stat.isDirectory()) throw new Error('receipt pack outDir exists and is not a directory: ' + target)
    const entries = readdirSync(target)
    if (entries.length && !overwrite) {
      throw new Error('receipt pack outDir is not empty: ' + target + ' (pass overwrite: true or choose a fresh directory)')
    }
    if (entries.length) {
      // Never delete the old directory tree: move it aside instead, so a mistake
      // with --out cannot destroy unrelated files.
      replaced = target + '.replaced-' + new Date().toISOString().replace(/[:.]/g, '-')
      renameSync(target, replaced)
    } else {
      rmdirSync(target)
    }
  }
  const staging = target + '.tmp-' + process.pid + '-' + randomUUID().slice(0, 8)
  mkdirSync(staging, { recursive: true, mode: RECEIPT_DIR_MODE })
  chmodSync(staging, RECEIPT_DIR_MODE)
  try {
    for (const path of [...fileContents.keys()].sort()) {
      if (isUnsafePackPath(path)) throw new Error('refusing to write unsafe pack path: ' + path)
      const bytes = toBytes(fileContents.get(path))
      const full = join(staging, ...path.split('/'))
      mkdirSync(dirname(full), { recursive: true, mode: RECEIPT_DIR_MODE })
      writeFileSync(full, bytes, { mode: RECEIPT_FILE_MODE })
      chmodSync(full, RECEIPT_FILE_MODE)
    }
    // Robustness audit P1-7: verify what actually reached the disk, not the
    // in-memory strings that were meant to be written.
    for (const [path, content] of fileContents) {
      const expected = toBytes(content)
      const full = join(staging, ...path.split('/'))
      const actual = readFileSync(full)
      if (actual.length !== expected.length) throw new Error('written pack file has the wrong size: ' + path)
      if (sha256Hex(actual) !== sha256Hex(expected)) throw new Error('written pack file hash mismatch: ' + path)
      if (process.platform !== 'win32' && (statSync(full).mode & 0o777) !== RECEIPT_FILE_MODE) {
        throw new Error('written pack file mode is not 0600: ' + path)
      }
    }
    renameSync(staging, target)
  } catch (error) {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      // best-effort cleanup of our own staging directory only
    }
    if (replaced) {
      try {
        renameSync(replaced, target)
      } catch {
        error.message = error.message + ' (previous outDir contents are preserved at ' + replaced + ')'
      }
    }
    throw error
  }
  chmodSync(target, RECEIPT_DIR_MODE)
  return { outDir: target, replaced }
}

/**
 * Build a delivery receipt pack (v1.1).
 *
 * The manifest records the delivered files (relative path / size / SHA-256),
 * the generator environment, the verify results, optional recipient and
 * timestamp anchors, and the evidence entries. receipt.docx is generated and
 * both it and every delivered artifact are covered by SHA256SUMS, so
 * verifyReceiptPackDir can detect any edit or missing file offline.
 *
 * @param {object} options
 * @param {Array|object} options.deliveries delivery record(s): {id, title, tool,
 *        createdAt, validation, files}. Each file is a path string, a
 *        {sourcePath} object, or a {content, name} object with embedded bytes.
 * @param {object|Array|string} [options.evidence] buildEvidencePack output,
 *        evidence entries, or an evidence manifest string.
 * @param {object|Array} [options.verifyResults] results with a boolean ok
 *        (verifyPack/verifyOffice results work as-is).
 * @param {object} [options.env] {advisersVersion, nodeVersion, templateName,
 *        templateVersion, command, platform}; missing values are filled from
 *        the current process.
 * @param {object|string} [options.recipient] optional {name, email, note}.
 * @param {object|Array} [options.anchors] optional external timestamp anchors:
 *        {file, fileSha256, adapterId, issuedAt, proof}. An empty list means
 *        "not anchored" and the pack discloses that.
 * @param {Date|string} [options.now]
 * @param {string} [options.outDir] when set, write the pack directory (0700,
 *        files 0600) and verify the bytes on disk. Without it only the file
 *        map is returned and the caller must keep the 0600 contract.
 * @param {boolean} [options.overwrite=false] allow replacing a non-empty
 *        outDir; the old directory is moved aside, never deleted.
 * @param {Function|false} [options.docxBuilder] override receipt.docx builder
 *        ((spec) => Buffer); false forces the built-in portable writer.
 * @param {Buffer|Uint8Array|string} [options.receiptDocx] pre-built receipt
 *        bytes to include instead of generating one (still hashed + covered).
 * @returns {Promise<{files: Record<string, string|Buffer>, summary: object}>}
 */
export async function buildReceiptPack(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('buildReceiptPack expects an options object')
  }
  const createdAt = isoDate(options.now === undefined ? new Date() : options.now)
  const deliveries = normalizeReceiptDeliveries(options.deliveries)
  const evidence = normalizeReceiptEvidence(options.evidence)
  const verifyResults = normalizeReceiptVerifyResults(options.verifyResults)
  const verifyStatus = receiptVerifyStatus(verifyResults)
  const generator = normalizeReceiptGenerator(options.env)
  const recipient = normalizeReceiptRecipient(options.recipient)
  const anchors = normalizeReceiptAnchors(options.anchors)
  const deliveryFiles = []
  for (const delivery of deliveries) for (const file of delivery.files) deliveryFiles.push(file)

  // Generate receipt.docx first: the manifest must carry its SHA-256, and the
  // receipt must not claim a manifest hash that does not exist yet (a hash cycle).
  // The receipt's own hash is therefore listed in SHA256SUMS/manifest, not inside
  // the document (a document cannot contain its own digest).
  const receiptSpec = receiptDocxSpec({
    createdAt,
    deliveries,
    evidence,
    verifyResults,
    verifyStatus,
    recipient,
    generator,
    anchors,
    deliveryFiles,
    receiptSha256: 'see SHA256SUMS',
  })
  const receiptBytes =
    options.receiptDocx !== undefined
      ? assertReceiptDocxBuffer(options.receiptDocx)
      : await buildReceiptDocxBytes(receiptSpec, options.docxBuilder)
  const receiptFile = { path: 'receipt.docx', size: receiptBytes.length, sha256: sha256Hex(receiptBytes) }

  // An anchor must commit to a file whose final bytes already exist. manifest /
  // README / SHA256SUMS are produced after this point, so anchoring them here
  // would be circular; reject those with a clear message instead of lying.
  const knownHashes = new Map()
  for (const file of deliveryFiles) knownHashes.set(file.path, file.sha256)
  knownHashes.set(receiptFile.path, receiptFile.sha256)
  for (const anchor of anchors) {
    if (!knownHashes.has(anchor.file)) {
      throw new TypeError(
        'anchor file must be a delivery file or receipt.docx: ' +
          anchor.file +
          ' (manifest/README/SHA256SUMS are generated after the anchors)',
      )
    }
    if (knownHashes.get(anchor.file) !== anchor.fileSha256) {
      throw new TypeError('anchor fileSha256 does not match the final bytes of ' + anchor.file)
    }
  }

  const fileCount = deliveryFiles.length + RECEIPT_REQUIRED_FILES.length
  const manifestText =
    stableStringify({
      format: RECEIPT_MANIFEST_FORMAT,
      version: RECEIPT_MANIFEST_VERSION,
      createdAt,
      generator,
      recipient,
      deliveries: deliveries.map((delivery) => ({
        id: delivery.id,
        title: delivery.title,
        tool: delivery.tool,
        createdAt: delivery.createdAt,
        validation: delivery.validation,
        files: delivery.files.map((file) => ({ path: file.path, name: file.name, size: file.size, sha256: file.sha256 })),
      })),
      receipt: receiptFile,
      verify: verifyResults,
      verifyStatus,
      anchors,
      evidence,
      fileCount,
    }) + '\n'
  const manifestDigest = sha256Hex(manifestText)

  const fileContents = new Map()
  for (const file of deliveryFiles) fileContents.set(file.path, file.content)
  fileContents.set('receipt.docx', receiptBytes)
  fileContents.set('manifest.json', manifestText)
  const readme = buildReceiptReadme({
    createdAt,
    generator,
    recipient,
    deliveries,
    evidence,
    verifyResults,
    verifyStatus,
    anchors,
    manifestDigest,
  })
  fileContents.set('README.txt', readme)
  // Everything except SHA256SUMS itself is covered by SHA256SUMS.
  fileContents.set(RECEIPT_SHA256SUMS_FILE, buildReceiptSums(fileContents))

  const files = {}
  for (const path of [...fileContents.keys()].sort()) files[path] = fileContents.get(path)
  const summary = {
    format: RECEIPT_MANIFEST_FORMAT,
    version: RECEIPT_MANIFEST_VERSION,
    createdAt,
    deliveryCount: deliveries.length,
    fileCount,
    verifyStatus,
    recipient: recipient || null,
    generator,
    evidence: {
      entryCount: evidence.entryCount,
      counts: evidence.counts,
      sourceCount: evidence.sourceCount,
      missingCount: evidence.missingCount,
    },
    anchored: anchors.length > 0,
    fileMode: RECEIPT_FILE_MODE,
    manifestDigest,
    receiptSha256: receiptFile.sha256,
    files: receiptFilesList(fileContents),
  }
  if (options.outDir !== undefined && options.outDir !== null && options.outDir !== '') {
    const written = writeReceiptPackDir(options.outDir, fileContents, { overwrite: options.overwrite === true })
    summary.outDir = written.outDir
    summary.replaced = written.replaced
    summary.diskVerified = true
  }
  return { files, summary }
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
