/**
 * Local, read-only mail followup engine (0.5.1, plan 92 section S5 / section 4).
 *
 * A followup is an ordinary commitment (debtor:third, capability:none) plus one
 * waiting_replies row that records WHAT local header evidence exists for the
 * reply. This module never sends mail, never opens a network connection and
 * never writes anything outside the commitments table, the waiting_replies
 * table and one audit row per mutating call.
 *
 * State machine (only these transitions exist):
 *   waiting -> replied | unknown | dismissed
 *   unknown -> replied | waiting | dismissed
 *   replied / dismissed are terminal (check never rewrites them; a manual
 *   dismiss on an already dismissed row with the same reason is a no-op).
 *
 * Replied rule (plan 92 section 4.1): a row is a reply only when it is not
 * outbound, arrived after the anchor, and matches the anchor by In-Reply-To,
 * References or thread_root. Everything else is classified into
 * ignoredReplies[] / possibleReplies[] and NEVER changes the state:
 *   auto-submitted / auto-reply subject / machine sender  -> ignored
 *   foreign sender (different address, different domain)  -> possible
 *   same counterparty + same subject without headers      -> possible
 * A missing anchor or a legacy anchor without threading headers makes the
 * state unknown. Nothing here asserts that a reply does not exist elsewhere:
 * the verdict is "not found in the local ledger".
 */
import { randomBytes } from 'node:crypto'

import { MAIL_ERROR_CODES, mailError } from './mail-errors.js'
import { isAutoSubmittedValue } from './mail-parse.js'
import { normalizeReminderOffsets } from './remind.js'
import {
  MAIL_SENT_MAILBOX_RE,
  getMailMessage,
  isoOf,
  mailAddressOf,
  mailDomainOf,
  parseJson,
} from './mail-store.js'
import { mailEvidenceSource } from './mail-extract.js'
import { entityError } from './sqlite.js'

// Same core fallback ladder as lib/receivables.js and bin/advisers.js so a
// checkout without a published advisers-core still works.
let core
if (process.env.ADVISERS_CORE_LOCAL === '1') {
  core = await import('../../core/dist/index.js')
} else {
  try {
    core = await import('advisers-core')
  } catch {
    core = await import('../../core/dist/index.js')
  }
}
const { createCommitment } = core

export const FOLLOWUP_STATES = Object.freeze(['waiting', 'replied', 'unknown', 'dismissed'])
export const FOLLOWUP_ACTIVE_STATES = Object.freeze(['waiting', 'unknown'])
export const FOLLOWUP_DISMISS_REASONS = Object.freeze(['replied-elsewhere', 'no-follow-up', 'wrong-thread', 'other'])
export const FOLLOWUP_DEFAULT_DUE_DAYS = 3
export const FOLLOWUP_DEFAULT_DUE_HOUR = 18
export const FOLLOWUP_DEFAULT_TIME_ZONE = 'Asia/Shanghai'
export const FOLLOWUP_DEFAULT_LIMIT = 50
export const FOLLOWUP_MAX_LIMIT = 500
export const FOLLOWUP_AMBIGUOUS_WINDOW_DAYS = 30
export const FOLLOWUP_MAX_ACTION_CHARS = 200
export const FOLLOWUP_MAX_NOTE_CHARS = 500
export const FOLLOWUP_MAX_CANDIDATES = 2000
export const FOLLOWUP_DEFAULT_MATTER_TITLE = '默认事项'
export const FOLLOWUP_AUTO_SUBJECT_RE = /^(自动回复|自動回覆|Auto[- ]?Reply|Out of Office)/i
export const FOLLOWUP_AUTO_SENDERS = Object.freeze(['mailer-daemon', 'postmaster', 'no-reply', 'noreply', 'do-not-reply'])
export const FOLLOWUP_ERROR_CODES = Object.freeze({
  EXISTS: 'E_FOLLOWUP_EXISTS',
  INVALID: 'E_FOLLOWUP_INVALID',
  NOT_FOUND: 'E_FOLLOWUP_NOT_FOUND',
})

const DAY_MS = 86_400_000
const SHANGHAI_OFFSET_MS = 8 * 3600_000
const STATE_ORDER = Object.freeze({ waiting: 0, unknown: 1, replied: 2, dismissed: 3 })

function followupError(code, message, hint) {
  const error = new Error(code + ': ' + message + (hint ? ' (hint: ' + hint + ')' : ''))
  error.code = code
  if (hint) error.hint = hint
  return error
}

function newId(prefix) {
  return prefix + '_' + randomBytes(8).toString('hex')
}

function nowIso(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  if (!Number.isFinite(date.getTime())) throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'invalid clock value')
  return date.toISOString()
}

function singleLine(value, max) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) : text
}

function parseBasis(row) {
  const basis = parseJson(row?.basis, null)
  return basis && typeof basis === 'object' ? basis : {}
}

function basisArray(basis, key) {
  return Array.isArray(basis[key]) ? basis[key] : []
}

/**
 * Fail closed when the v23 mail columns / waiting_replies table are missing:
 * followup must never silently behave as if no replies exist.
 */
export function assertFollowupTables(store) {
  if (!store || typeof store.db?.prepare !== 'function') {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'mail followup requires the SQLite ledger (JSON store is not supported)')
  }
  let tables
  try {
    tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  } catch (error) {
    throw mailError(MAIL_ERROR_CODES.CONFIG, 'the ledger database is not readable: ' + String(error?.message ?? error).slice(0, 200))
  }
  const present = new Set(tables)
  const missingTables = ['mail_messages', 'mail_accounts', 'waiting_replies'].filter((name) => !present.has(name))
  if (missingTables.length) {
    throw mailError('E_SCHEMA_STALE', 'mail followup requires the v23 schema but this ledger is missing: ' + missingTables.join(', '), 'upgrade advisers and run advisers init to migrate the ledger')
  }
  const columns = new Set(store.db.prepare('PRAGMA table_info(mail_messages)').all().map((row) => row.name))
  const required = ['in_reply_to', 'references', 'thread_root', 'direction', 'auto_submitted']
  const missingColumns = required.filter((name) => !columns.has(name))
  if (missingColumns.length) {
    throw mailError('E_SCHEMA_STALE', 'mail followup requires the v23 mail_messages columns but this ledger is missing: ' + missingColumns.join(', '), 'upgrade advisers and run advisers init to migrate the ledger')
  }
}

/**
 * Coverage is a local fact, not a quality claim: how many mailboxes have a
 * sync cursor and whether any of them is a Sent mailbox. Without a synced Sent
 * mailbox the engine can never see outbound replies, so the human output must
 * not present a followup as "not replied".
 */
export function mailFollowupCoverage(store) {
  // Only a real sync cursor is evidence that a mailbox was read: a configured
  // Sent mailbox that was never synced still cannot prove "no reply exists".
  const cursors = store.db.prepare('SELECT account_id, mailbox, status FROM mail_cursors').all()
  const boxes = new Set()
  let sentMailboxSeen = false
  for (const cursor of cursors) {
    const mailbox = String(cursor.mailbox ?? '').trim()
    if (!mailbox) continue
    boxes.add(cursor.account_id + '\u0000' + mailbox)
    if (MAIL_SENT_MAILBOX_RE.test(mailbox)) sentMailboxSeen = true
  }
  const warnings = []
  if (!sentMailboxSeen) warnings.push('sent-mailbox-not-synced')
  return { syncedMailboxes: boxes.size, sentMailboxSeen, basis: 'headers', warnings }
}

/* ------------------------------------------------------------------ */
/* Anchor + ids                                                       */
/* ------------------------------------------------------------------ */

function anchorForRow(store, row) {
  if (row.anchor_row_id) {
    try { return getMailMessage(store, String(row.anchor_row_id)) } catch { /* fall through */ }
  }
  if (row.anchor_message_id) {
    try { return getMailMessage(store, String(row.anchor_message_id)) } catch { /* deleted or purged account */ }
  }
  return undefined
}

function resolveAnchor(store, input) {
  const mailRef = typeof input.mail === 'string' && input.mail.trim() ? input.mail.trim() : ''
  const threadRef = typeof input.thread === 'string' && input.thread.trim() ? input.thread.trim() : ''
  if ((mailRef ? 1 : 0) + (threadRef ? 1 : 0) !== 1) {
    throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'pass exactly one of --mail or --thread', 'usage: advisers mail followup add (--mail <row-id|message-id> | --thread <message-id>)')
  }
  if (mailRef) {
    const anchor = getMailMessage(store, mailRef)
    return { anchor, threadRoot: anchor.threadRoot ?? anchor.messageId ?? null }
  }
  const named = getMailMessage(store, threadRef)
  const threadRoot = named.threadRoot ?? named.messageId ?? null
  if (!threadRoot) {
    throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'the named message has no Message-ID or threading headers, so its thread cannot be resolved', 'use --mail <row-id> for this message instead')
  }
  const latest = store.db.prepare('SELECT id FROM mail_messages WHERE thread_root = ? ORDER BY received_at DESC, rowid DESC LIMIT 1').get(threadRoot)
  if (!latest) throw followupError(FOLLOWUP_ERROR_CODES.NOT_FOUND, 'no message found for thread ' + threadRoot)
  return { anchor: getMailMessage(store, latest.id), threadRoot }
}

/* ------------------------------------------------------------------ */
/* Field validation                                                   */
/* ------------------------------------------------------------------ */

function displayNameOf(value) {
  const text = String(value == null ? '' : value).trim()
  const match = /^([^<>]*)<[^<>]*>$/.exec(text)
  const name = (match ? match[1] : '').trim().replace(/^["']+|["']+$/g, '')
  return singleLine(name, 120)
}

function resolveCounterparty(anchor, input) {
  const explicit = typeof input.counterparty === 'string' ? input.counterparty.trim() : ''
  if (explicit) {
    const address = mailAddressOf(explicit)
    if (!address) throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'counterparty must be an email address: ' + JSON.stringify(explicit), 'pass e.g. --counterparty wang@acme.cn')
    return address
  }
  if (anchor.direction === 'outbound') {
    throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'the anchor message was sent by you; pass --counterparty <addr> (the local ledger stores no To header)', 'usage: advisers mail followup add --mail <id> --counterparty wang@acme.cn')
  }
  const address = mailAddressOf(anchor.from)
  if (!address) throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'cannot derive a counterparty address from the anchor message; pass --counterparty <addr>')
  return address
}

function creditorFor(anchor, counterparty) {
  if (anchor.direction === 'outbound') return counterparty
  return displayNameOf(anchor.from) || counterparty
}

function normalizeDueAt(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const check = new Date(text + 'T00:00:00Z')
    if (!Number.isFinite(check.getTime())) throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'due date is not a real calendar date: ' + JSON.stringify(text), 'pass YYYY-MM-DD or an ISO instant')
    return text
  }
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'due date is not an ISO instant: ' + JSON.stringify(text), 'pass an ISO instant or let the CLI resolve a relative --due first')
  return text
}

/**
 * Default due: anchor received_at + 3 days at 18:00 Asia/Shanghai (plan 92
 * section 4). Computed on the Shanghai calendar day, not on a fixed 72h offset.
 */
export function defaultFollowupDue(anchorAt) {
  const parsed = Date.parse(String(anchorAt ?? ''))
  if (!Number.isFinite(parsed)) return null
  const shanghai = new Date(parsed + SHANGHAI_OFFSET_MS)
  const year = shanghai.getUTCFullYear()
  const month = shanghai.getUTCMonth()
  const day = shanghai.getUTCDate() + FOLLOWUP_DEFAULT_DUE_DAYS
  return new Date(Date.UTC(year, month, day, FOLLOWUP_DEFAULT_DUE_HOUR - 8, 0, 0)).toISOString()
}

function normalizeOffsets(value) {
  if (value == null) return undefined
  const list = Array.isArray(value) ? value : String(value).split(',')
  const cleaned = list.map((entry) => String(entry).trim()).filter(Boolean)
  if (!cleaned.length) return undefined
  try {
    return normalizeReminderOffsets(cleaned)
  } catch (error) {
    throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'invalid --remind-offsets: ' + String(error?.message ?? error), 'use forms like -3d or -1d,-2h')
  }
}

function defaultAction(anchor) {
  const subject = singleLine(anchor.subject, 120)
  return singleLine('等待回复：' + (subject || '邮件'), FOLLOWUP_MAX_ACTION_CHARS)
}

function anchorEvidence(anchor) {
  const quote = singleLine(anchor.subject, 200) || '(no subject)'
  return { quote, source: mailEvidenceSource(anchor) }
}

/**
 * Commitments require a matter (NOT NULL). Follow the bin resolveWriteMatterId
 * ladder: explicit --matter, the active-matter route, the last session matter,
 * the first active matter, then create the same "默认事项" fallback. Nothing
 * here creates a client or a project: mail followup never invents business data.
 */
function resolveMatterForFollowup(store, explicit, now) {
  const value = typeof explicit === 'string' ? explicit.trim() : ''
  if (value) {
    const matter = store.getMatter(value)
    if (!matter) throw entityError('E_MATTER_NOT_FOUND', 'unknown matter: ' + value, 'advisers matter ls')
    if (matter.status !== 'active') throw entityError('E_MATTER_ARCHIVED', 'matter is archived: ' + value, 'advisers matter ls')
    return matter.id
  }
  try {
    const routedId = store.getMeta?.('active_matter_id')
    if (routedId) {
      const routed = store.getMatter(String(routedId))
      if (routed && routed.status === 'active') return routed.id
    }
  } catch { /* optional routing */ }
  try {
    const latest = store.listSessions?.(1)?.[0]
    if (latest?.matterId) {
      const sessionMatter = store.getMatter(String(latest.matterId))
      if (sessionMatter && sessionMatter.status === 'active') return sessionMatter.id
    }
  } catch { /* optional routing */ }
  const active = store.firstActiveMatter?.()
  if (active?.id) return active.id
  const timestamp = now
  const matter = {
    id: newId('matter'),
    title: FOLLOWUP_DEFAULT_MATTER_TITLE,
    status: 'active',
    domain: 'general',
    secrecy: 0,
    participants: [],
    deadlines: [],
    openQuestions: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  store.insertMatter(matter)
  return matter.id
}


/* ------------------------------------------------------------------ */
/* Projections                                                        */
/* ------------------------------------------------------------------ */

function daysBetween(fromIso, toIso) {
  const from = Date.parse(String(fromIso ?? ''))
  const to = Date.parse(String(toIso ?? ''))
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.max(0, Math.floor((to - from) / DAY_MS))
}

function mapFollowupItem(store, row, { now, anchor } = {}) {
  const basis = parseBasis(row)
  const resolvedAnchor = anchor ?? anchorForRow(store, row)
  const commitment = store.getCommitment(row.commitment_id)
  const state = String(row.state ?? 'unknown')
  const endIso = row.replied_at ?? (state === 'waiting' || state === 'unknown' ? now : (row.updated_at ?? now))
  const item = {
    id: row.id,
    commitmentId: row.commitment_id,
    accountId: row.account_id ?? undefined,
    anchorRowId: row.anchor_row_id ?? undefined,
    anchorMessageId: row.anchor_message_id,
    threadRoot: row.thread_root,
    counterparty: row.counterparty,
    subject: resolvedAnchor?.subject ?? '',
    anchorAt: row.anchor_at,
    dueAt: commitment?.dueAt ?? undefined,
    state,
    daysWaiting: daysBetween(row.anchor_at, endIso),
    replies: basisArray(basis, 'replies'),
    ignoredReplies: basisArray(basis, 'ignored'),
    possibleReplies: basisArray(basis, 'possible'),
    warnings: basisArray(basis, 'warnings'),
    lastCheckedAt: row.checked_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.replied_at) item.repliedAt = row.replied_at
  if (row.replied_row_id) item.repliedRowId = row.replied_row_id
  if (row.dismiss_reason) item.dismissReason = row.dismiss_reason
  if (basis.dismissNote) item.dismissNote = basis.dismissNote
  if (basis.note) item.note = basis.note
  return item
}

function commitmentView(commitment) {
  if (!commitment) return undefined
  const view = {
    id: commitment.id,
    action: commitment.action,
    debtor: commitment.debtor,
    creditor: commitment.creditor,
    capability: commitment.capability,
    status: commitment.status,
    timezone: commitment.timezone,
    createdAt: commitment.createdAt,
  }
  if (commitment.dueAt != null) view.dueAt = commitment.dueAt
  if (commitment.matterId != null) view.matterId = commitment.matterId
  if (Array.isArray(commitment.reminderOffsets) && commitment.reminderOffsets.length) view.reminderOffsets = commitment.reminderOffsets
  return view
}

function requireFollowupRow(store, id) {
  if (typeof id !== 'string' || !id.trim()) throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'a follow-up id is required', 'run advisers mail followup ls')
  const value = id.trim()
  const row = store.db.prepare('SELECT * FROM waiting_replies WHERE id = ?').get(value)
  if (!row) throw followupError(FOLLOWUP_ERROR_CODES.NOT_FOUND, 'mail followup not found: ' + value, 'run advisers mail followup ls --all')
  return row
}

function readFollowup(store, id, { now, coverage } = {}) {
  const row = requireFollowupRow(store, id)
  return mapFollowupItem(store, row, { now: now ?? nowIso(), coverage })
}

/* ------------------------------------------------------------------ */
/* Reply detection                                                    */
/* ------------------------------------------------------------------ */

function candidateEntry(row, extra) {
  const entry = {
    rowId: row.id,
    receivedAt: row.received_at,
    from: row.from_addr ?? '',
  }
  if (row.message_id) entry.messageId = row.message_id
  return extra ? { ...entry, ...extra } : entry
}

function autoReplyReason(candidate) {
  if (isAutoSubmittedValue(candidate.auto_submitted)) return 'auto-submitted'
  if (FOLLOWUP_AUTO_SUBJECT_RE.test(String(candidate.subject ?? ''))) return 'auto-subject'
  const sender = mailAddressOf(candidate.from_addr ?? '')
  if (sender) {
    const local = sender.slice(0, sender.indexOf('@')).toLowerCase()
    if (FOLLOWUP_AUTO_SENDERS.includes(local)) return 'auto-sender'
  }
  return null
}

function classifyCandidate(candidate, row) {
  const auto = autoReplyReason(candidate)
  if (auto) return { kind: 'ignored', entry: candidateEntry(candidate, { reason: auto }) }
  const sender = mailAddressOf(candidate.from_addr ?? '')
  const sameSender = Boolean(sender) && sender === String(row.counterparty ?? '').toLowerCase()
  const sameDomain = Boolean(sender) && mailDomainOf(sender) === mailDomainOf(row.counterparty)
  if (!sameSender && !sameDomain) {
    return { kind: 'possible', entry: candidateEntry(candidate, { basis: 'thread+foreign-sender' }) }
  }
  return { kind: 'replied', entry: candidateEntry(candidate) }
}

function collectThreadCandidates(store, { anchor, anchorMessageId, threadRoot, anchorAt }) {
  if (!anchor?.id) return []
  const rows = store.db.prepare(
    "SELECT * FROM mail_messages WHERE id != ? AND COALESCE(direction, 'unknown') != 'outbound' AND received_at > ? ORDER BY received_at ASC, rowid ASC LIMIT ?",
  ).all(anchor.id, anchorAt, FOLLOWUP_MAX_CANDIDATES)
  return rows.filter((candidate) => {
    if (anchorMessageId && candidate.in_reply_to === anchorMessageId) return true
    if (anchorMessageId && parseJson(candidate.references, []).includes(anchorMessageId)) return true
    if (threadRoot && candidate.thread_root === threadRoot) return true
    return false
  })
}

function subjectKey(value) {
  return singleLine(value, 500)
    .replace(/^((re|fw|fwd|回复|答复|转发)\s*[:：]\s*)+/i, '')
    .trim()
    .toLowerCase()
}

function collectAmbiguousCandidates(store, { anchor, row }) {
  if (!anchor?.id) return []
  const anchorAt = row.anchor_at
  const start = Date.parse(String(anchorAt ?? ''))
  if (!Number.isFinite(start)) return []
  const end = new Date(start + FOLLOWUP_AMBIGUOUS_WINDOW_DAYS * DAY_MS).toISOString()
  const targetSubject = subjectKey(anchor.subject)
  if (!targetSubject) return []
  const counterparty = String(row.counterparty ?? '').toLowerCase()
  const rows = store.db.prepare(
    "SELECT * FROM mail_messages WHERE id != ? AND COALESCE(direction, 'unknown') != 'outbound' AND received_at > ? AND received_at <= ? ORDER BY received_at ASC, rowid ASC LIMIT 500",
  ).all(anchor.id, anchorAt, end)
  return rows.filter((candidate) => {
    if (mailAddressOf(candidate.from_addr ?? '') !== counterparty) return false
    return subjectKey(candidate.subject) === targetSubject
  })
}

/**
 * Recompute one active followup. Pure read: returns the next state + basis.
 * The caller decides whether anything changed and whether to write.
 */
function evaluateFollowup(store, row, { now, coverage }) {
  const warnings = []
  const anchor = anchorForRow(store, row)
  const method = 'headers'
  if (!anchor) {
    warnings.push('anchor-missing')
    const basis = { method, replies: [], ignored: [], possible: [], warnings }
    return { state: 'unknown', repliedRowId: null, repliedAt: null, basis, basisJson: JSON.stringify(basis) }
  }
  if (!anchor.threadRoot) {
    // v23 does not backfill old rows: without original headers the engine must
    // report unknown instead of pretending there was no reply.
    warnings.push('no-threading-headers')
    const basis = { method, replies: [], ignored: [], possible: [], warnings }
    return { state: 'unknown', repliedRowId: null, repliedAt: null, basis, basisJson: JSON.stringify(basis) }
  }
  const anchorMessageId = row.anchor_message_id || anchor.messageId || null
  const threadRoot = anchor.threadRoot || row.thread_root || null
  const replies = []
  const ignored = []
  const possible = []
  const threaded = collectThreadCandidates(store, { anchor, anchorMessageId, threadRoot, anchorAt: row.anchor_at })
  const threadedIds = new Set(threaded.map((candidate) => candidate.id))
  for (const candidate of threaded) {
    const classification = classifyCandidate(candidate, row)
    if (classification.kind === 'ignored') ignored.push(classification.entry)
    else if (classification.kind === 'possible') possible.push(classification.entry)
    else replies.push(classification.entry)
  }
  for (const candidate of collectAmbiguousCandidates(store, { anchor, row })) {
    if (threadedIds.has(candidate.id)) continue
    const classification = classifyCandidate(candidate, row)
    if (classification.kind === 'ignored') ignored.push(classification.entry)
    else possible.push({ ...candidateEntry(candidate), basis: 'subject-window' })
  }
  let state = 'waiting'
  let repliedRowId = null
  let repliedAt = null
  if (replies.length) {
    state = 'replied'
    repliedRowId = replies[replies.length - 1].rowId
    repliedAt = replies[replies.length - 1].receivedAt
  }
  const basis = { method, replies, ignored, possible, warnings }
  return { state, repliedRowId, repliedAt, basis, basisJson: JSON.stringify(basis) }
}

function basisChanged(previousJson, nextBasis) {
  const previous = parseJson(previousJson, null)
  if (!previous || typeof previous !== 'object') return true
  return JSON.stringify(previous) !== JSON.stringify(nextBasis)
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Create one followup commitment + its waiting_replies row in one audited
 * transaction. Idempotent per (anchor_message_id, counterparty) while the
 * existing row is active.
 */
export function mailFollowupAdd(store, input = {}, options = {}) {
  assertFollowupTables(store)
  if (!store || typeof store.mutate !== 'function') throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'mail followup add requires a writable SQLite ledger')
  const now = nowIso(options.now)
  const actor = options.actor ?? 'local'
  const { anchor, threadRoot } = resolveAnchor(store, input)
  const counterparty = resolveCounterparty(anchor, input)
  const anchorMessageId = anchor.messageId || threadRoot
  if (!anchorMessageId) throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'the anchor message has neither a Message-ID nor a thread root', 'sync or import a message that keeps its Message-ID header')
  const existing = store.db.prepare(
    "SELECT id FROM waiting_replies WHERE anchor_message_id = ? AND counterparty = ? AND state IN ('waiting', 'unknown') LIMIT 1",
  ).get(anchorMessageId, counterparty)
  if (existing) {
    throw followupError(FOLLOWUP_ERROR_CODES.EXISTS, 'an active followup already tracks ' + counterparty + ' on message ' + anchorMessageId + ' (' + existing.id + ')', 'run advisers mail followup ls')
  }
  const actionText = singleLine(input.action, FOLLOWUP_MAX_ACTION_CHARS) || defaultAction(anchor)
  const dueAt = input.dueAt == null || input.dueAt === '' ? defaultFollowupDue(anchor.receivedAt) : normalizeDueAt(input.dueAt)
  const reminderOffsets = normalizeOffsets(input.reminderOffsets)
  const followupId = newId('wr')
  const audit = { actor, action: 'followup.add', allowed: true, reason: '' }
  const made = store.mutate((s) => {
    const matterId = resolveMatterForFollowup(s, input.matterId, now)
    const commitment = createCommitment(
      { clock: { now: () => now }, ids: { next: (prefix) => newId(String(prefix)) } },
      {
        matterId,
        debtor: 'third',
        creditor: creditorFor(anchor, counterparty),
        action: actionText,
        ...(dueAt ? { dueAt } : {}),
        timezone: FOLLOWUP_DEFAULT_TIME_ZONE,
        capability: 'none',
        evidence: [anchorEvidence(anchor)],
        ...(reminderOffsets && reminderOffsets.length ? { reminderOffsets } : {}),
      },
    )
    s.insertCommitment(commitment)
    const basis = { method: 'headers', replies: [], ignored: [], possible: [], warnings: [] }
    s.db.prepare(
      'INSERT INTO waiting_replies(id,commitment_id,account_id,anchor_row_id,anchor_message_id,thread_root,counterparty,anchor_at,state,replied_row_id,replied_at,basis,checked_at,dismiss_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(followupId, commitment.id, anchor.accountId ?? null, anchor.id, anchorMessageId, threadRoot, counterparty, anchor.receivedAt, 'waiting', null, null, JSON.stringify(basis), null, null, now, now)
    audit.reason = followupId + ' ' + commitment.id
    return { commitment }
  }, audit)
  const followup = readFollowup(store, followupId, { now })
  return {
    ok: true,
    command: 'mail followup add',
    followup,
    commitment: commitmentView(made.result.commitment),
    dueBasis: input.dueAt == null || input.dueAt === '' ? 'waiting-default' : 'explicit',
  }
}

/** List followups with coverage warnings; no writes. */
export function mailFollowupLs(store, options = {}) {
  assertFollowupTables(store)
  const now = nowIso(options.now)
  const coverage = mailFollowupCoverage(store)
  const state = options.state == null || options.state === '' ? 'waiting' : String(options.state)
  if (state !== 'all' && !FOLLOWUP_STATES.includes(state)) {
    throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'unknown followup state: ' + state, 'use waiting|replied|unknown|dismissed|all')
  }
  const limit = Math.max(1, Math.min(FOLLOWUP_MAX_LIMIT, Number(options.limit) || FOLLOWUP_DEFAULT_LIMIT))
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0))
  const staleDays = options.staleDays == null || options.staleDays === '' ? null : Number(options.staleDays)
  if (staleDays != null && (!Number.isFinite(staleDays) || staleDays < 0)) {
    throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'stale days must be a non-negative number')
  }
  const rows = state === 'all'
    ? store.db.prepare('SELECT * FROM waiting_replies ORDER BY created_at DESC, rowid DESC').all()
    : store.db.prepare('SELECT * FROM waiting_replies WHERE state = ? ORDER BY created_at DESC, rowid DESC').all(state)
  let items = rows.map((row) => mapFollowupItem(store, row, { now, coverage }))
  if (staleDays != null) {
    items = items.filter((item) => item.state === 'waiting' && item.daysWaiting >= staleDays)
  }
  items.sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || String(b.createdAt).localeCompare(String(a.createdAt)))
  const total = items.length
  const page = items.slice(offset, offset + limit)
  return { ok: true, command: 'mail followup ls', coverage, items: page, total, truncated: offset + page.length < total }
}

/** One followup with its anchor-derived projection; no writes. */
export function mailFollowupShow(store, id, options = {}) {
  assertFollowupTables(store)
  const now = nowIso(options.now)
  const coverage = mailFollowupCoverage(store)
  const row = requireFollowupRow(store, id)
  return { ok: true, command: 'mail followup show', followup: mapFollowupItem(store, row, { now, coverage }), coverage }
}

/**
 * Recompute waiting/unknown rows from local headers. Dry run writes nothing at
 * all; a real run updates only rows whose state or basis changed and appends
 * exactly one followup.check audit row.
 */
export function mailFollowupCheck(store, options = {}) {
  assertFollowupTables(store)
  if (!store || typeof store.mutate !== 'function') throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'mail followup check requires a writable SQLite ledger')
  const now = nowIso(options.now)
  const dryRun = options.dryRun === true
  const coverage = mailFollowupCoverage(store)
  const rows = store.db.prepare("SELECT * FROM waiting_replies WHERE state IN ('waiting', 'unknown') ORDER BY created_at ASC, rowid ASC").all()
  const evaluated = rows.map((row) => ({ row, next: evaluateFollowup(store, row, { now, coverage }) }))
  const changes = evaluated.filter(({ row, next }) => next.state !== row.state || basisChanged(row.basis, next.basis))
  const changed = changes.map(({ row, next }) => ({ id: row.id, from: row.state, to: next.state, basis: next.basis }))
  if (dryRun) {
    return { ok: true, command: 'mail followup check', dryRun: true, checked: rows.length, wouldChange: changed, coverage }
  }
  const audit = { actor: options.actor ?? 'local', action: 'followup.check', allowed: true, reason: rows.length + ' checked, ' + changes.length + ' changed' }
  store.mutate((s) => {
    for (const { row, next } of changes) {
      s.db.prepare('UPDATE waiting_replies SET state = ?, replied_row_id = ?, replied_at = ?, basis = ?, checked_at = ?, updated_at = ? WHERE id = ?').run(next.state, next.repliedRowId, next.repliedAt, next.basisJson, now, now, row.id)
    }
  }, audit)
  return { ok: true, command: 'mail followup check', dryRun: false, checked: rows.length, changed, coverage }
}

/** Dismiss one waiting/unknown followup with a fixed reason code. */
export function mailFollowupDismiss(store, id, input = {}, options = {}) {
  assertFollowupTables(store)
  if (!store || typeof store.mutate !== 'function') throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'mail followup dismiss requires a writable SQLite ledger')
  const now = nowIso(options.now)
  const row = requireFollowupRow(store, id)
  const reason = String(input.reason ?? '').trim()
  if (!FOLLOWUP_DISMISS_REASONS.includes(reason)) {
    throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'dismiss requires --reason ' + FOLLOWUP_DISMISS_REASONS.join('|'), 'usage: advisers mail followup dismiss <id> --reason ' + FOLLOWUP_DISMISS_REASONS[0])
  }
  const note = input.note == null ? null : singleLine(input.note, FOLLOWUP_MAX_NOTE_CHARS) || null
  if (row.state === 'dismissed') {
    if (row.dismiss_reason === reason) {
      return { ok: true, command: 'mail followup dismiss', followup: mapFollowupItem(store, row, { now }), alreadyDismissed: true }
    }
    throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'followup ' + row.id + ' is already dismissed with reason ' + row.dismiss_reason, 'run advisers mail followup ls --all')
  }
  if (row.state === 'replied') throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'followup ' + row.id + ' is already marked replied', 'run advisers mail followup ls --all')
  const audit = { actor: options.actor ?? 'local', action: 'followup.dismiss', allowed: true, reason: row.id + ' ' + reason }
  store.mutate((s) => {
    const basis = parseBasis(row)
    basis.dismissReason = reason
    if (note) basis.dismissNote = note
    s.db.prepare('UPDATE waiting_replies SET state = ?, dismiss_reason = ?, basis = ?, updated_at = ? WHERE id = ?').run('dismissed', reason, JSON.stringify(basis), now, row.id)
  }, audit)
  return { ok: true, command: 'mail followup dismiss', followup: readFollowup(store, row.id, { now }) }
}

/** Manually mark a followup replied (basis.method = manual); never guesses. */
export function mailFollowupMarkReplied(store, id, input = {}, options = {}) {
  assertFollowupTables(store)
  if (!store || typeof store.mutate !== 'function') throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'mail followup mark-replied requires a writable SQLite ledger')
  const now = nowIso(options.now)
  const row = requireFollowupRow(store, id)
  const note = input.note == null ? null : singleLine(input.note, FOLLOWUP_MAX_NOTE_CHARS) || null
  if (row.state === 'replied') {
    return { ok: true, command: 'mail followup mark-replied', followup: mapFollowupItem(store, row, { now }), alreadyReplied: true }
  }
  if (row.state === 'dismissed') throw followupError(FOLLOWUP_ERROR_CODES.INVALID, 'followup ' + row.id + ' is dismissed; add a new followup instead of reviving this row', 'run advisers mail followup ls --all')
  const audit = { actor: options.actor ?? 'local', action: 'followup.mark-replied', allowed: true, reason: row.id }
  store.mutate((s) => {
    const previous = parseBasis(row)
    const basis = {
      method: 'manual',
      replies: basisArray(previous, 'replies'),
      ignored: basisArray(previous, 'ignored'),
      possible: basisArray(previous, 'possible'),
      warnings: basisArray(previous, 'warnings'),
    }
    if (note) basis.note = note
    s.db.prepare("UPDATE waiting_replies SET state = 'replied', replied_at = ?, basis = ?, checked_at = ?, updated_at = ? WHERE id = ?").run(now, JSON.stringify(basis), now, now, row.id)
  }, audit)
  return { ok: true, command: 'mail followup mark-replied', followup: readFollowup(store, row.id, { now }) }
}
