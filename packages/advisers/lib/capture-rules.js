/**
 * Local capture rules + read-only inbox projection (0.4.3 task 043-2 / 92 §2).
 *
 * Two independent responsibilities, both deterministic and offline:
 *
 * 1. `localCaptureCandidates()` turns plain text (stdin / a text file already
 *    extracted by the caller, never mail headers) into pending commitment
 *    candidates with the local rules that already power `mail extract --local`.
 *    It reuses `lib/mail-extract.js` (triggers, verbatim quotes, relative dates
 *    via lib/relative-date.js, money/currency, client/project hints) by
 *    wrapping the text in a header-less pseudo message, then adds the two
 *    capture-only rules: a clause-level negation guard (mail has a sender who
 *    can be asked; a pasted note does not, so "我不会在周五前交付" must not
 *    become a promise) and a conversation evidence source whose pointer is
 *    `capture:<sha256(text) first 16 hex>` (no file path, no body copy).
 *    Zero model calls, zero network, no fs, no console and no store writes:
 *    persistence stays in `bin/advisers.js` (addTurn + proposeCandidate,
 *    pending only; capture never auto-accepts).
 *
 * 2. `inboxList()` / `inboxShow()` are read-only projections over the
 *    `memory_candidates` table of an ALREADY OPENED SqliteStore (same style as
 *    lib/customer-read.js and lib/kb.js). Pending candidates only; source
 *    filter before counting; matter-secrecy clearance filter before paging,
 *    with protected rows reported as a count (`protectedExcluded`) and never
 *    as ids/quotes. Both run inside one `store.read()` snapshot and write
 *    nothing.
 *
 * Known limits (documented, not bugs): rules are calibrated for typical
 * Chinese/English business prose; negation is one clause-level guard, not
 * parsing; ambiguous/conflicting relative dates degrade to no `dueAt` exactly
 * like `mail extract --local`; every candidate is reviewed by a human before
 * it reaches the ledger.
 */
import { createHash } from 'node:crypto'

import { extractLocalCandidates, LOCAL_MAX_CANDIDATES, MAX_QUOTE_CHARS } from './mail-extract.js'
import { validateSource } from './source.js'
import { stripBidiControls, stripBom, stripControlChars, stripTerminalSequences } from './text-safe.js'

/** Same cap as the model capture path (lib/capture.js MAX_CHARS); stdin/file is capped before any rule runs. */
export const CAPTURE_RULES_MAX_CHARS = 20_000
/** One capture text yields at most this many candidates (the mail-extract rule cap). */
export const CAPTURE_RULES_MAX_CANDIDATES = LOCAL_MAX_CANDIDATES
/** Hard cap for a verbatim quote (mail-extract rule). */
export const CAPTURE_RULES_MAX_QUOTE_CHARS = MAX_QUOTE_CHARS
/** Capture channels accepted by `capture --source` (provenance only; no behavioural difference). */
export const CAPTURE_CHANNELS = Object.freeze(['wechat', 'meeting', 'email', 'note', 'stdin', 'transcript', 'contract'])
/** Default channel for a pasted/stdin capture (the 0.4.x capture default). */
export const CAPTURE_DEFAULT_CHANNEL = 'wechat'

/* -------------------------------------------------------------------------- */
/* capture rules                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Clause boundary for the negation guard. Comma is a boundary on purpose:
 * "还没有发，我周五前发" keeps the positive clause.
 */
const CLAUSE_PUNCT_RE = /[，,；;。！？!?\n]/u

/**
 * Action verbs mirrored from lib/mail-extract.js (ACTION_VERBS /
 * EN_ACTION_VERBS). They are used only to locate the action-bearing clause of
 * a candidate quote for the negation guard; the extraction itself still comes
 * from mail-extract. Keep in sync if that list changes.
 */
const CN_ACTION_VERBS = Object.freeze([
  '发送', '发', '提交', '交付', '回复', '确认', '提供', '安排', '完成', '给出',
  '上线', '付款', '打款', '支付', '签署', '签', '寄', '送', '对接', '处理',
  '反馈', '准备', '整理', '跟进', '汇报', '报价', '回访', '续约',
])
const EN_ACTION_RE = /\b(?:send|submit|deliver|reply|confirm|provide|finish|complete|pay|share|prepare|upload|review|fix|quote)\b/i

/**
 * Strong negated-obligation markers. Deliberately conservative: bare 不 / 没
 * are not enough ("报价不错" must stay a promise), and 还没 is a status, not a
 * negation of the promise that follows.
 */
const CN_NEG_MODAL_RE = /(?:不会|不能|没法|无法|不打算|没打算|没有打算|不准备|不承诺|不保证|没有承诺|没承诺|并未承诺|从未承诺|拒绝|不可能|无需|不必|不用|不再|不一定能)/u
const CN_NEG_VERB_RE = /(?<![还尚正])(?:没有|没|未)(?:[^，,；;。！？!?\n]{0,8}?)(?:答应|承诺|同意|保证|发送|提交|交付|付款|支付|回复|完成|提供|安排|确认|发|给|做|交)/u
const CN_NEG_SUFFIX_RE = /不(?:了|完|成|及|出去|回来)/u
const EN_NEG_RE = /\b(?:will\s+not|won't|would\s+not|wouldn't|cannot|can't|can\s+not|is\s+not|are\s+not|am\s+not|not\s+going\s+to|never|do\s+not|don't|does\s+not|doesn't|did\s+not|didn't|have\s+not|haven't|has\s+not|hasn't|no\s+need\s+to|unable\s+to|not\s+able\s+to)\b/iu

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function normalizedCaptureText(value) {
  return stripBom(String(value == null ? '' : value)).replace(/\r\n?/gu, '\n').trim()
}

/**
 * Normalise one capture input exactly like the stdin path needs: strip a
 * leading BOM, fold CRLF/CR to LF, trim, then enforce the 20 000-code-unit cap
 * (the same String#length unit lib/capture.js counts).
 *
 * @param {unknown} text
 * @returns {{ok: boolean, code?: string, message?: string, text: string, length: number}}
 */
export function normalizeCaptureText(text) {
  const normalized = normalizedCaptureText(text)
  const length = normalized.length
  if (!length) {
    return { ok: false, code: 'E_CAPTURE_EMPTY', message: 'capture input is empty', text: '', length: 0 }
  }
  if (length > CAPTURE_RULES_MAX_CHARS) {
    return {
      ok: false,
      code: 'E_CAPTURE_TOO_LONG',
      message: 'capture input is too long (max ' + CAPTURE_RULES_MAX_CHARS + ' chars)',
      text: '',
      length,
    }
  }
  return { ok: true, text: normalized, length }
}

/** Stable conversation pointer for one capture text: `capture:<16 hex sha256>`. */
export function captureTextRef(text) {
  return 'capture:' + sha256Hex(normalizedCaptureText(text)).slice(0, 16)
}

function resolveAnchor(date, now) {
  for (const value of [date, now]) {
    if (value === undefined || value === null) continue
    const candidate = value instanceof Date ? value : new Date(value)
    if (Number.isFinite(candidate.getTime())) return candidate
  }
  return new Date()
}

/** First action-verb index in a quote (CN verbs + the English list); -1 when none. */
function firstActionIndex(quote) {
  let first = -1
  for (const verb of CN_ACTION_VERBS) {
    const index = quote.indexOf(verb)
    if (index !== -1 && (first === -1 || index < first)) first = index
  }
  const english = EN_ACTION_RE.exec(quote)
  if (english && (first === -1 || english.index < first)) first = english.index
  return first
}

/** Index range of the clause that contains `index` (split on clause punctuation). */
function clauseAt(quote, index) {
  let start = 0
  for (let cursor = 0; cursor <= quote.length; cursor += 1) {
    const atEnd = cursor === quote.length
    if (!atEnd && !CLAUSE_PUNCT_RE.test(quote[cursor])) continue
    if (index >= start && index < cursor) return quote.slice(start, cursor)
    if (index === cursor) return ''
    start = cursor + 1
  }
  return quote.slice(start)
}

function hasStrongNegation(clause) {
  return CN_NEG_MODAL_RE.test(clause) || CN_NEG_VERB_RE.test(clause) || CN_NEG_SUFFIX_RE.test(clause) || EN_NEG_RE.test(clause)
}

/**
 * Drop a candidate whose primary action sits in a negated clause
 * ("我不会在周五前交付" / "I will not send the quote") while keeping a
 * candidate whose action is a positive clause ("报价不错，我周五前交付").
 * The guard only drops on an action-bearing clause, so a negated aside
 * ("别担心，我周五前发") never removes a real promise.
 */
function isNegatedCandidate(candidate) {
  const quote = String(candidate?.quote ?? '').trim()
  if (!quote) return false
  const action = String(candidate?.action ?? '')
  if (action && hasStrongNegation(action)) return true
  const index = firstActionIndex(quote)
  if (index === -1) return hasStrongNegation(quote)
  return hasStrongNegation(clauseAt(quote, index))
}

/**
 * Build (and validate) the conversation source stored on one candidate's
 * evidence. The pointer is the text hash; quotes never carry a file path.
 */
function captureEvidenceSource(candidate, { textRef, capturedAt }) {
  const checked = validateSource({
    type: 'conversation',
    ref: textRef,
    quote: candidate.quote,
    capturedAt,
  })
  return checked.ok ? checked.source : undefined
}

/**
 * Deterministic local extraction for one plain-text capture.
 *
 * Input text must already be the text the user wants analysed; `--file`
 * binary/doc extraction stays in bin/attachments and stdin reading stays in
 * bin as well. Returns `{ok:false, code, message, candidates: []}` for empty,
 * over-long or unusable input (fail closed, codes registered for 0.4.3).
 *
 * @param {{text?: unknown, source?: string, date?: string|Date, now?: string|Date,
 *   matterId?: string, clients?: object[], projects?: object[]}} [options]
 * @returns {{ok: true, candidates: object[], textRef: string, channel: string,
 *   capturedAt: string} | {ok: false, code: string, message: string,
 *   candidates: object[], length: number}}
 */
export function localCaptureCandidates(options = {}) {
  const { text, source, date, now, matterId, clients, projects } = options
  const prepared = normalizeCaptureText(text)
  if (!prepared.ok) return { ...prepared, candidates: [] }
  const channel = typeof source === 'string' && source.trim() ? source.trim() : CAPTURE_DEFAULT_CHANNEL
  const anchor = resolveAnchor(date, now)
  const capturedAt = anchor.toISOString()
  const textRef = 'capture:' + sha256Hex(prepared.text).slice(0, 16)
  const { candidates } = extractLocalCandidates({
    text: prepared.text,
    subject: '',
    from: '',
    receivedAt: capturedAt,
    clients: Array.isArray(clients) ? clients : [],
    projects: Array.isArray(projects) ? projects : [],
    now: anchor,
  })
  const out = []
  for (const candidate of candidates) {
    if (isNegatedCandidate(candidate)) continue
    const evidenceSource = captureEvidenceSource(candidate, { textRef, capturedAt })
    if (!evidenceSource) continue
    out.push({
      ...candidate,
      ...(matterId ? { matterId } : {}),
      channel,
      source: evidenceSource,
    })
  }
  return { ok: true, candidates: out, textRef, channel, capturedAt }
}

/**
 * Map one candidate from `localCaptureCandidates()` to the `memory_candidates`
 * record shape `store.proposeCandidate()` expects (kind commitment, payload +
 * evidence, pending only). Pass the turn/session ids created by the caller so
 * `memory accept` keeps its evidence-chain check; nothing is written here.
 *
 * Returns undefined (fail closed) when the candidate has no verbatim quote or
 * no usable evidence source.
 */
export function toCaptureMemoryCandidate(candidate, options = {}) {
  if (!candidate || typeof candidate !== 'object') return undefined
  const quote = typeof candidate.quote === 'string' ? candidate.quote.trim() : ''
  if (!quote) return undefined
  const { text, now, turnId, conversationId } = options
  const matterId = options.matterId ?? candidate.matterId
  const capturedAt = typeof candidate.receivedAt === 'string' && Number.isFinite(Date.parse(candidate.receivedAt))
    ? new Date(candidate.receivedAt).toISOString()
    : resolveAnchor(now).toISOString()
  let evidenceSource = candidate.source && typeof candidate.source === 'object' ? candidate.source : undefined
  if (!evidenceSource) {
    const prepared = normalizeCaptureText(text)
    if (!prepared.ok) return undefined
    evidenceSource = captureEvidenceSource({ quote }, {
      textRef: 'capture:' + sha256Hex(prepared.text).slice(0, 16),
      capturedAt,
    })
  }
  if (!evidenceSource) return undefined
  const payload = {
    ...(matterId ? { matterId } : {}),
    debtor: candidate.debtor === 'third' ? 'third' : 'user',
    creditor: candidate.creditor || 'someone',
    action: candidate.action,
    ...(candidate.dueAt ? { dueAt: candidate.dueAt } : {}),
    ...(candidate.dueBasis ? { dueBasis: candidate.dueBasis } : {}),
    ...(candidate.dueAmbiguous ? { dueAmbiguous: true } : {}),
    capability: 'none',
    extractor: 'local',
    ...(candidate.modal ? { modal: candidate.modal } : {}),
    ...(candidate.uncertainty ? { uncertainty: candidate.uncertainty } : {}),
    ...(candidate.amountMinor ? { amountMinor: candidate.amountMinor, currency: candidate.currency ?? 'CNY' } : {}),
    ...(candidate.clientHint ? { clientHint: candidate.clientHint } : {}),
    ...(candidate.projectHint ? { projectHint: candidate.projectHint } : {}),
  }
  return {
    kind: 'commitment',
    payload,
    evidence: [{
      quote,
      ...(turnId ? { turnId } : {}),
      ...(conversationId ? { sessionId: conversationId } : {}),
      source: evidenceSource,
    }],
  }
}

/* -------------------------------------------------------------------------- */
/* inbox read projection                                                      */
/* -------------------------------------------------------------------------- */

/** Source filter values accepted by `inbox ls --source`. */
export const INBOX_SOURCES = Object.freeze(['capture', 'mail', 'all'])
/** Default page size for `inbox ls`. */
export const INBOX_LIST_LIMIT = 50
/** Hard cap for one `inbox ls` page. */
export const INBOX_LIST_LIMIT_MAX = 200
/** Local CLI default clearance; 0 hides every protected matter candidate. */
export const INBOX_DEFAULT_CLEARANCE = 3
/** One inbox row keeps at most this many quote characters. */
export const INBOX_QUOTE_MAX_CHARS = 120

function clampLimit(value) {
  if (value === undefined || value === null) return INBOX_LIST_LIMIT
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) return INBOX_LIST_LIMIT
  return Math.min(number, INBOX_LIST_LIMIT_MAX)
}

function clampOffset(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : 0
}

function normalizeClearance(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.floor(number)
}

function normalizeSourceFilter(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : 'all'
  return INBOX_SOURCES.includes(text) ? text : 'all'
}

function assertInboxStore(store) {
  if (!store || !store.db || typeof store.db.prepare !== 'function' || typeof store.read !== 'function') {
    throw new TypeError('inbox requires an opened SqliteStore (memory candidates are SQLite-only)')
  }
}

/** Single-line, control/terminal-safe quote capped at `max` code points. */
function safeQuote(value, max = INBOX_QUOTE_MAX_CHARS) {
  const text = stripControlChars(stripBidiControls(stripTerminalSequences(String(value == null ? '' : value))), { keepNewlines: false, keepTabs: false, replacement: ' ' })
    .replace(/\s+/gu, ' ')
    .trim()
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

function parseStoredJson(value) {
  if (typeof value !== 'string') return undefined
  try { return JSON.parse(value) } catch { return undefined }
}

/** Parse one memory_candidates row; undefined when the stored JSON is corrupt. */
function parseCandidateRow(row) {
  const payload = parseStoredJson(row.payload)
  const evidence = parseStoredJson(row.evidence)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  if (!Array.isArray(evidence)) return undefined
  return {
    id: String(row.id),
    kind: String(row.kind),
    payload,
    evidence,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at ?? undefined,
    rejectReason: row.reject_reason ?? undefined,
  }
}

/**
 * Source classification: mail-extracted candidates carry a `mail` (or legacy
 * `email`) evidence source; a future extractor whose name starts with `mail`
 * counts as mail too; everything else (conversation/transcript/unknown) is a
 * capture candidate.
 */
function candidateSource(payload, evidence) {
  for (const entry of evidence) {
    const type = typeof entry?.source?.type === 'string' ? entry.source.type.trim().toLowerCase() : ''
    if (type === 'mail' || type === 'email') return 'mail'
  }
  const extractor = typeof payload.extractor === 'string' ? payload.extractor.trim().toLowerCase() : ''
  return extractor.startsWith('mail') ? 'mail' : 'capture'
}

function firstEvidenceQuote(evidence) {
  for (const entry of evidence) {
    if (entry && typeof entry.quote === 'string' && entry.quote) return entry.quote
  }
  return ''
}

/** Secrecy map for every matter: missing/dirty values fail closed to Infinity. */
function matterSecrecyMap(store) {
  const rows = store.db.prepare('SELECT id, secrecy FROM matters').all()
  const map = new Map()
  for (const row of rows) {
    const level = row.secrecy === null || row.secrecy === undefined ? 0 : Number(row.secrecy)
    map.set(String(row.id), Number.isFinite(level) ? level : Number.POSITIVE_INFINITY)
  }
  return map
}

/** The candidate matter's secrecy; no matter -> 0; unresolvable/dirty matter -> Infinity. */
function candidateSecrecy(payload, secrecyByMatter) {
  const matterId = payload?.matterId
  if (matterId === undefined || matterId === null || matterId === '') return 0
  if (typeof matterId !== 'string' || !secrecyByMatter.has(matterId)) return Number.POSITIVE_INFINITY
  return secrecyByMatter.get(matterId)
}

/**
 * One inbox list row. Field names are the documented 0.4.3 projection; the
 * quote is a safe single line capped at INBOX_QUOTE_MAX_CHARS and no payload
 * notes/body text is ever returned.
 */
function inboxItem(row, source) {
  const { payload, evidence } = row
  return {
    id: row.id,
    kind: row.kind,
    source,
    extractor: typeof payload.extractor === 'string' && payload.extractor ? payload.extractor : 'unknown',
    action: typeof payload.action === 'string' ? payload.action : null,
    quote: safeQuote(firstEvidenceQuote(evidence)) || null,
    dueAt: typeof payload.dueAt === 'string' ? payload.dueAt : null,
    dueBasis: typeof payload.dueBasis === 'string' ? payload.dueBasis : null,
    dueAmbiguous: payload.dueAmbiguous === true,
    clientHint: payload.clientHint && typeof payload.clientHint === 'object' ? payload.clientHint : null,
    projectHint: payload.projectHint && typeof payload.projectHint === 'object' ? payload.projectHint : null,
    matterId: typeof payload.matterId === 'string' ? payload.matterId : null,
    createdAt: row.createdAt,
  }
}

/**
 * List pending memory candidates for `inbox ls` (read-only, one snapshot).
 *
 * Filter order matters: source first, then the clearance gate, then counting,
 * then paging. `total` counts visible pending candidates only; hidden rows
 * contribute to `protectedExcluded` and their ids/quotes are never returned.
 * Newest-first with an id-descending tie-break keeps pages deterministic.
 * Corrupt candidate rows are skipped and counted in `skipped` (never shown).
 *
 * @param {object} store opened SqliteStore
 * @param {{source?: 'capture'|'mail'|'all', limit?: number, offset?: number, clearance?: number}} [options]
 */
export function inboxList(store, options = {}) {
  assertInboxStore(store)
  const filter = normalizeSourceFilter(options.source)
  const clearance = normalizeClearance(options.clearance === undefined ? INBOX_DEFAULT_CLEARANCE : options.clearance)
  const limit = clampLimit(options.limit)
  const offset = clampOffset(options.offset)
  return store.read(() => {
    const rows = store.db.prepare("SELECT id, kind, payload, evidence, status, created_at, reviewed_at, reject_reason FROM memory_candidates WHERE status = 'pending' ORDER BY created_at DESC, id DESC").all()
    const secrecyByMatter = matterSecrecyMap(store)
    const visible = []
    let protectedExcluded = 0
    let skipped = 0
    for (const raw of rows) {
      const row = parseCandidateRow(raw)
      if (!row) { skipped += 1; continue }
      const source = candidateSource(row.payload, row.evidence)
      if (filter !== 'all' && source !== filter) continue
      if (candidateSecrecy(row.payload, secrecyByMatter) > clearance) { protectedExcluded += 1; continue }
      visible.push(inboxItem(row, source))
    }
    visible.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    const total = visible.length
    const items = visible.slice(offset, offset + limit)
    return {
      ok: true,
      command: 'inbox ls',
      items,
      total,
      truncated: offset + items.length < total,
      limit,
      offset,
      clearance,
      source: filter,
      protectedExcluded,
      skipped,
    }
  })
}

/**
 * Show one pending candidate for `inbox show` (read-only, one snapshot).
 *
 * Returns a discriminable result instead of throwing on a missing/hidden id:
 *   {ok: true, command: 'inbox show', candidate, clearance}
 *   {ok: false, code: 'E_CANDIDATE_NOT_FOUND', hint: 'advisers inbox ls'}
 *   {ok: false, code: 'E_POLICY_DENIED', hint: '提高 --clearance（0-3）'}
 * A non-pending id is reported as not found (the inbox is pending-only) and a
 * protected id never leaks its kind/quote through this helper.
 *
 * @param {object} store opened SqliteStore
 * @param {string} id memory_candidates id
 * @param {{clearance?: number}} [options]
 */
export function inboxShow(store, id, options = {}) {
  assertInboxStore(store)
  const clearance = normalizeClearance(options.clearance === undefined ? INBOX_DEFAULT_CLEARANCE : options.clearance)
  const key = typeof id === 'string' ? id.trim() : ''
  return store.read(() => {
    const notFound = { ok: false, code: 'E_CANDIDATE_NOT_FOUND', hint: 'advisers inbox ls' }
    if (!key) return notFound
    const raw = store.db.prepare("SELECT id, kind, payload, evidence, status, created_at, reviewed_at, reject_reason FROM memory_candidates WHERE id = ? AND status = 'pending'").get(key)
    if (!raw) return notFound
    const row = parseCandidateRow(raw)
    if (!row) return notFound
    const secrecyByMatter = matterSecrecyMap(store)
    if (candidateSecrecy(row.payload, secrecyByMatter) > clearance) {
      return { ok: false, code: 'E_POLICY_DENIED', hint: '提高 --clearance（0-3）' }
    }
    const source = candidateSource(row.payload, row.evidence)
    const item = inboxItem(row, source)
    return {
      ok: true,
      command: 'inbox show',
      candidate: {
        ...item,
        quote: safeQuote(firstEvidenceQuote(row.evidence), CAPTURE_RULES_MAX_QUOTE_CHARS) || null,
        status: row.status,
        payload: row.payload,
        evidence: row.evidence,
      },
      clearance,
    }
  })
}
