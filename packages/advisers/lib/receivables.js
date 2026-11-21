/**
 * Receivables and payments (0.4.0, schema v22; design 48-customer-v2 sections
 * 3.2/3.3).
 *
 * A receivable is a MONEY SIDECAR, not a fourth ledger:
 *
 *   commitments (the ledger's single "who owes whom" record)
 *     - receivables 1:1 (amount / currency / memo / tombstone, schema v22)
 *         - payments 1:N (cash events; commitment_id NULL = unmatched prepay)
 *
 * Creating a receivable creates its follow-up commitment ("回款跟进") in the
 * same transaction, so reminders/today/who/due-date rules work with zero new
 * tables. The amount never enters the commitment action or evidence quote:
 * reminder payloads, ICS, webhooks and the wire ledger stay amount-free.
 *
 * Rules this module owns:
 *  - integer minor units via BigInt: decimal STRING in, two decimals out, max
 *    1e12 minor units (10,000,000,000.00). No float math, no locale formatting.
 *  - exactly four currencies (CNY/USD/EUR/HKD); no FX, no cross-currency
 *    totals, no automatic rounding of a remainder.
 *  - partial / multiple / over-payment are valid; a payment's currency must
 *    equal the receivable's currency; payments without a receivable are
 *    unmatched prepayments and never reduce an outstanding balance.
 *  - state is DERIVED from tombstone + written-off + amount + due date, never
 *    stored, so it cannot fight the commitment status.
 *  - full payment completes the follow-up commitment in the same transaction
 *    (core.completeCommitment, manual evidence "payment <id>") and records
 *    closed_by_payment_id; payment void reopens it only when it was closed by
 *    money and the outstanding balance is positive again. Evidence history is
 *    never rewritten.
 *  - no hard deletes: void = tombstone. A receivable with active payments
 *    cannot be voided (void the payments first) and its amount cannot be edited
 *    while payments exist.
 *  - clearance = max(client.secrecyDefault, matter.secrecy); hidden rows are
 *    only counted (protectedExcluded) and never leak an id/name/label.
 *  - one audited transaction per write; audit reasons contain ids/counts only,
 *    never an amount, a name, a memo or a free-form reason.
 *
 * Out of scope by design: invoices, receipts, statements of account, dunning
 * letters, bank/payment-channel reconciliation, FX rates. This module records
 * operator-entered local bookkeeping; it never moves money.
 *
 * The CLI wiring is owned by bin/advisers.js; this file is the whole store
 * layer (bin only parses flags / renders text and calls these functions).
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { entityError } from './sqlite.js'
import { normalizeReminderOffsets } from './remind.js'

// The core ledger operations are the frozen commitment contract (one evidence
// rule, one done transition). Same fallback ladder as bin/advisers.js so
// ADVISERS_CORE_LOCAL works in a checkout without a published package.
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
const { createCommitment, completeCommitment } = core

/* -------------------------------------------------------------------------- */
/* constants                                                                  */
/* -------------------------------------------------------------------------- */

const LF = String.fromCharCode(10)
const BS = String.fromCharCode(92)
const NUL = String.fromCharCode(0)

/** Currencies accepted by the money sidecar (same set as the quote templates). */
export const CURRENCIES = Object.freeze(['CNY', 'USD', 'EUR', 'HKD'])
/** Default currency when the caller omits it. */
export const DEFAULT_CURRENCY = 'CNY'
/** Hard per-amount cap: 1e12 minor units = 10,000,000,000.00. */
export const MAX_AMOUNT_MINOR = 1_000_000_000_000n
/** Allowed receivable kinds (operator self-reported, never inferred). */
export const RECEIVABLE_KINDS = Object.freeze(['quote', 'milestone', 'retainer', 'other'])
/** Allowed payment methods (operator self-reported, never verified). */
export const PAYMENT_METHODS = Object.freeze(['bank', 'wechat', 'alipay', 'cash', 'other'])
/** Derived receivable states. Only written_off/void come from stored columns. */
export const RECEIVABLE_STATES = Object.freeze(['open', 'partial', 'overdue', 'settled', 'written_off', 'void'])
/** Local CLI default clearance (docs/CLIENTS.md section 4); external surfaces pass 0. */
export const DEFAULT_CLEARANCE = 3
/** receivable ls page defaults (same family as the customer list limits). */
export const RECEIVABLE_LIST_LIMIT = 50
export const RECEIVABLE_LIST_LIMIT_MAX = 500
/** payment ls page defaults. */
export const PAYMENT_LIST_LIMIT = 50
export const PAYMENT_LIST_LIMIT_MAX = 500
/** Follow-up matter title used when no matter/project anchors the receivable. */
export const RECEIVABLE_MATTER_TITLE = '回款'
/** Currency symbol map used by human views (never by the JSON view here). */
const CURRENCY_SYMBOLS = Object.freeze({ CNY: '¥', USD: '$', EUR: '€', HKD: 'HK$' })

const DAY_MS = 86_400_000
const SHANGHAI_OFFSET_MS = 8 * 3600_000
const LABEL_MAX = 200
const MEMO_MAX = 200
const REASON_MAX = 200
const AGG_KEY_SEP = NUL

/* -------------------------------------------------------------------------- */
/* small pure helpers                                                         */
/* -------------------------------------------------------------------------- */

function invalid(message, hint) {
  return entityError('E_RECEIVABLE_INVALID', message, hint)
}

function invalidPayment(message, hint) {
  return entityError('E_PAYMENT_INVALID', message, hint)
}

function nowIso(value) {
  if (value === undefined || value === null) return new Date().toISOString()
  const date = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(date.getTime())) throw invalid('now must be a valid Date/ISO instant')
  return date.toISOString()
}

function newId(prefix) {
  return prefix + '_' + randomUUID().replace(/-/g, '').slice(0, 16)
}

function isDigitCode(code) {
  return code >= 48 && code <= 57
}

function isAsciiLetterCode(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isHexLowerCode(code) {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102)
}

function isDateOnly(text) {
  if (typeof text !== 'string' || text.length !== 10) return false
  for (let i = 0; i < 10; i += 1) {
    const code = text.charCodeAt(i)
    if (i === 4 || i === 7) { if (code !== 45) return false } else if (!isDigitCode(code)) return false
  }
  return true
}

/** YYYY-MM-DD{ |T}HH:MM[:SS[.mmm]] (no zone). */
function isLocalDateTime(text) {
  if (typeof text !== 'string' || text.length < 16) return false
  if (!isDateOnly(text.slice(0, 10))) return false
  const sep = text.charCodeAt(10)
  if (sep !== 84 && sep !== 32) return false
  if (text.charCodeAt(13) !== 58) return false
  for (let i = 11; i < 16; i += 1) {
    if (i === 13) continue
    if (!isDigitCode(text.charCodeAt(i))) return false
  }
  if (text.length === 16) return true
  if (text.charCodeAt(16) !== 58) return false
  for (let i = 17; i < 19; i += 1) if (!isDigitCode(text.charCodeAt(i))) return false
  if (text.length === 19) return true
  if (text.charCodeAt(19) !== 46) return false
  const fraction = text.slice(20)
  if (fraction.length < 1 || fraction.length > 3) return false
  for (let i = 0; i < fraction.length; i += 1) if (!isDigitCode(fraction.charCodeAt(i))) return false
  return true
}

/** Decimal string: digits, optionally one dot followed by 1+ digits. */
function isDecimalString(text) {
  if (typeof text !== 'string' || !text) return false
  let dot = -1
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === 46) {
      if (dot !== -1 || i === 0 || i === text.length - 1) return false
      dot = i
    } else if (!isDigitCode(code)) return false
  }
  return true
}

function hasControlOrNewline(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === LF || code === 13) return true
    if (code < 32 || code === 127) return true
  }
  return false
}

/** Reject absolute-path-looking free text without leaking it anywhere. */
function looksLikeAbsolutePath(text) {
  if (!text) return false
  if (text.startsWith('/') || text.startsWith(BS)) return true
  if (text.includes(':/') || text.includes(':' + BS)) return true
  for (let i = 0; i + 2 < text.length; i += 1) {
    if (!isAsciiLetterCode(text.charCodeAt(i))) continue
    if (text.charCodeAt(i + 1) !== 58) continue
    const third = text.charCodeAt(i + 2)
    if (third === 47 || third === 92) return true
  }
  return false
}

/** Single-line operator text (label/memo/reason): no control chars, no paths. */
function normalizeOperatorText(field, value, max) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(field + ' must be a string')
  const text = value.trim()
  if (!text) return undefined
  if (hasControlOrNewline(text)) throw invalid(field + ' must be a single line without control characters')
  if (Array.from(text).length > max) throw invalid(field + ' is longer than ' + max + ' characters')
  if (looksLikeAbsolutePath(text)) throw invalid(field + ' must not contain an absolute file path')
  return text
}

/* ------------------------------- money ----------------------------------- */

/** Price text -> BigInt minor units. Accepts a decimal string (or a BigInt). */
export function parseAmountToMinor(value, options = {}) {
  const field = options.field ?? 'amount'
  const code = options.code ?? 'E_RECEIVABLE_INVALID'
  const fail = (message, hint) => entityError(code, message, hint)
  if (typeof value === 'bigint') {
    if (value <= 0n) throw fail(field + ' must be greater than 0')
    if (value > MAX_AMOUNT_MINOR) throw fail(field + ' is out of range (max ' + formatMinorAmount(MAX_AMOUNT_MINOR) + ')')
    return value
  }
  if (typeof value !== 'string') throw fail(field + ' must be a decimal string like "8000.00"')
  const text = value.trim()
  if (!isDecimalString(text)) throw fail(field + ' must be a decimal string like "8000.00" (no sign, comma, exponent or currency symbol)')
  const dot = text.indexOf('.')
  const whole = dot === -1 ? text : text.slice(0, dot)
  const fraction = dot === -1 ? '' : text.slice(dot + 1)
  if (fraction.length > 2) throw fail(field + ' has more than 2 decimal places')
  if (whole.length > 13) throw fail(field + ' is out of range (max ' + formatMinorAmount(MAX_AMOUNT_MINOR) + ')')
  const minor = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2))
  if (minor <= 0n) throw fail(field + ' must be greater than 0')
  if (minor > MAX_AMOUNT_MINOR) throw fail(field + ' is out of range (max ' + formatMinorAmount(MAX_AMOUNT_MINOR) + ')')
  return minor
}

/** BigInt/number minor units -> plain "8000.00" (no thousands separators). */
export function formatMinorAmount(minor) {
  let value
  if (typeof minor === 'bigint') value = minor
  else if (typeof minor === 'number' && Number.isFinite(minor)) value = BigInt(Math.trunc(minor))
  else throw new TypeError('minor units must be a BigInt or finite number')
  const negative = value < 0n
  const absolute = negative ? -value : value
  const whole = absolute / 100n
  const fraction = absolute % 100n
  return (negative ? '-' : '') + whole.toString() + '.' + fraction.toString().padStart(2, '0')
}

/** JSON-safe number for a BigInt minor amount known to be below 2^53. */
function minorToNumber(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error('money amount exceeded Number.MAX_SAFE_INTEGER; refusing to serialise an unsafe integer')
  return number
}

function minorAdd(left, right) {
  return minorToNumber(BigInt(left) + BigInt(right))
}

/** Currency code validation/normalisation (uppercase, four currencies). */
export function parseCurrency(value, options = {}) {
  const code = options.code ?? 'E_RECEIVABLE_INVALID'
  if (value === undefined || value === null || value === '') return DEFAULT_CURRENCY
  if (typeof value !== 'string') throw entityError(code, 'currency must be one of ' + CURRENCIES.join(', '))
  const text = value.trim().toUpperCase()
  if (!CURRENCIES.includes(text)) throw entityError(code, 'currency must be one of ' + CURRENCIES.join(', ') + ' (got ' + value.trim() + ')')
  return text
}

function parseKind(value) {
  if (value === undefined || value === null || value === '') return 'other'
  if (typeof value !== 'string') throw invalid('kind must be one of ' + RECEIVABLE_KINDS.join(', '))
  const text = value.trim()
  if (!RECEIVABLE_KINDS.includes(text)) throw invalid('kind must be one of ' + RECEIVABLE_KINDS.join(', ') + ' (got ' + text + ')')
  return text
}

function parseMethod(value) {
  if (value === undefined || value === null || value === '') return 'other'
  if (typeof value !== 'string') throw invalidPayment('method must be one of ' + PAYMENT_METHODS.join(', '))
  const text = value.trim()
  if (!PAYMENT_METHODS.includes(text)) throw invalidPayment('method must be one of ' + PAYMENT_METHODS.join(', ') + ' (got ' + text + ')')
  return text
}

function parseId(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(field + ' is required')
  return value.trim()
}

/** First defined option among camelCase / CLI-flag spellings. */
function pickOption(options, names) {
  if (!options || typeof options !== 'object') return undefined
  for (const name of names) {
    if (options[name] !== undefined && options[name] !== null) return options[name]
  }
  return undefined
}

/* ------------------------------- dates ----------------------------------- */

function shanghaiDayEndInstant(day) {
  const parts = day.split('-').map(Number)
  return Date.UTC(parts[0], parts[1] - 1, parts[2]) - SHANGHAI_OFFSET_MS + DAY_MS - 1
}

/**
 * Resolve a stored/entered due date to an absolute instant, same rule as the
 * CLI: YYYY-MM-DD -> end of that Asia/Shanghai day, local ISO without zone ->
 * +08:00, anything with Z/offset -> its absolute instant, otherwise null.
 */
export function receivableDueInstant(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  if (isDateOnly(text)) {
    const parts = text.split('-').map(Number)
    if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[2] > 31) return null
    const ms = shanghaiDayEndInstant(text)
    return Number.isFinite(ms) ? ms : null
  }
  if (isLocalDateTime(text)) {
    const normalized = text.replace(' ', 'T')
    const withSeconds = normalized.length >= 19 ? normalized : normalized + ':00'
    const withMs = withSeconds.includes('.') ? withSeconds : withSeconds + '.000'
    const ms = Date.parse(withMs + '+08:00')
    return Number.isFinite(ms) ? ms : null
  }
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/** Validate an operator-entered due date and keep its original spelling. */
function normalizeDueAt(value, eventCode = 'E_RECEIVABLE_INVALID', field = 'due date') {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw entityError(eventCode, field + ' must be a string (YYYY-MM-DD or ISO)')
  const text = value.trim()
  if (!text) return undefined
  const ms = receivableDueInstant(text)
  if (ms === null) throw entityError(eventCode, field + ' is not a valid date: ' + text.slice(0, 40))
  return text
}

/** Normalise an entered payment instant to an explicit-offset ISO string. */
function normalizePaidAt(value, nowMs) {
  const source = value === undefined || value === null || value === '' ? new Date(nowMs) : value
  let ms = null
  let text = null
  if (source instanceof Date) {
    ms = source.getTime()
  } else if (typeof source === 'string') {
    const raw = source.trim()
    if (!raw) throw invalidPayment('paid-at must be a valid date')
    if (isDateOnly(raw)) {
      const parts = raw.split('-').map(Number)
      ms = Date.UTC(parts[0], parts[1] - 1, parts[2]) - SHANGHAI_OFFSET_MS
      text = raw + 'T00:00:00.000+08:00'
    } else if (isLocalDateTime(raw)) {
      const normalized = raw.replace(' ', 'T')
      const withSeconds = normalized.length >= 19 ? normalized : normalized + ':00'
      const withMs = withSeconds.includes('.') ? withSeconds : withSeconds + '.000'
      text = withMs + '+08:00'
      ms = Date.parse(text)
    } else {
      ms = Date.parse(raw)
      text = Number.isFinite(ms) ? new Date(ms).toISOString() : null
    }
  } else {
    throw invalidPayment('paid-at must be a string (YYYY-MM-DD or ISO instant)')
  }
  if (!Number.isFinite(ms)) throw invalidPayment('paid-at is not a valid date')
  if (ms > nowMs + DAY_MS) throw invalidPayment('paid-at is more than a day in the future; record the actual payment date')
  return text ?? new Date(ms).toISOString()
}

function instantOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** UTC instant -> Asia/Shanghai ISO with an explicit +08:00 offset. */
function toShanghaiIso(ms) {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().replace('Z', '+08:00')
}

function normalizeClearance(value, fallback = DEFAULT_CLEARANCE) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(3, Math.max(0, Math.trunc(number)))
}

function normalizeLimit(value, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) throw invalid('limit must be a positive integer')
  return Math.min(max, Math.trunc(number))
}

function normalizeDueWithin(value, nowMs) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw invalid('due-within must be a relative window like 7d/30d or a date')
    return nowMs + Math.trunc(value) * DAY_MS
  }
  if (typeof value !== 'string') throw invalid('due-within must be a relative window like 7d/30d or a date')
  const text = value.trim()
  const unit = text.charAt(text.length - 1)
  const digits = unit === 'd' || unit === 'h' ? text.slice(0, -1) : null
  if (digits !== null && digits.length > 0 && [...digits].every((char) => isDigitCode(char.charCodeAt(0)))) {
    const amount = Number(digits)
    if (!Number.isFinite(amount) || amount < 0) throw invalid('due-within must be a relative window like 7d/30d or a date')
    return nowMs + amount * (unit === 'd' ? DAY_MS : 3600_000)
  }
  const ms = receivableDueInstant(text)
  if (ms === null) throw invalid('due-within must be a relative window like 7d/30d or a date')
  return ms
}

function normalizeSince(value, nowMs) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return nowMs - Math.trunc(value)
  const text = String(value).trim()
  const unit = text.charAt(text.length - 1)
  const digits = unit === 'd' || unit === 'h' ? text.slice(0, -1) : null
  if (digits !== null && digits.length > 0 && [...digits].every((char) => isDigitCode(char.charCodeAt(0)))) {
    const amount = Number(digits)
    if (!Number.isFinite(amount) || amount < 0) throw invalidPayment('since must be a relative window like 90d or an ISO instant')
    return nowMs - amount * (unit === 'd' ? DAY_MS : 3600_000)
  }
  const ms = instantOf(text)
  if (ms === null) throw invalidPayment('since must be a relative window like 90d or an ISO instant')
  return ms
}

function resolveReminderOffsets(value) {
  if (value === undefined || value === null) return undefined
  let list
  if (typeof value === 'string') list = value.split(',')
  else if (Array.isArray(value)) list = value
  else throw invalid('reminder offsets must be an array of offset strings or a comma-separated string')
  try {
    const normalized = normalizeReminderOffsets(list.map((entry) => String(entry).trim()).filter(Boolean))
    return normalized.length ? normalized : []
  } catch (error) {
    throw invalid('invalid reminder offsets: ' + String(error?.message ?? error), 'e.g. "-3d,-1d"')
  }
}

function advisersVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null
  } catch {
    return null
  }
}

function sha256HexText(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** Honest operator-entered evidence; never contains the amount. */
function manualEvidence(quote, command, now) {
  const text = String(quote ?? '')
  const version = advisersVersion()
  return {
    kind: 'manual',
    type: 'manual',
    source: 'operator',
    quote: text,
    quoteSha256: sha256HexText(text),
    capturedAt: now,
    capturedBy: 'local',
    command,
    ...(version ? { cliVersion: version } : {}),
  }
}

/* -------------------------------------------------------------------------- */
/* store access                                                               */
/* -------------------------------------------------------------------------- */

function assertStore(store) {
  if (!store || typeof store !== 'object' || !store.db || typeof store.db.prepare !== 'function'
    || typeof store.read !== 'function' || typeof store.getClient !== 'function') {
    throw new TypeError('receivables requires an opened SqliteStore (money sidecars are SQLite-only; ADVISERS_STORE=json has no money tables)')
  }
}

function requireClientRow(store, clientId, operation = 'receivable') {
  const row = store.db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId)
  if (!row) throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + clientId, 'advisers client list')
  if (row.deleted_at != null || row.status !== 'active') {
    throw entityError('E_CLIENT_ARCHIVED', 'client is archived: ' + clientId + ' (' + operation + ')', 'advisers client list')
  }
  return row
}

const RECEIVABLE_SELECT = 'SELECT r.*, ' +
  'c.name AS client_name, c.secrecy_default AS client_secrecy, c.status AS client_status, c.deleted_at AS client_deleted_at, ' +
  'm.secrecy AS matter_secrecy, m.status AS matter_status, ' +
  'cm.action AS commitment_action, cm.status AS commitment_status, cm.due_at AS commitment_due_at, ' +
  'cm.reminder_offsets AS commitment_reminder_offsets, cm.done_at AS commitment_done_at ' +
  'FROM receivables r ' +
  'LEFT JOIN clients c ON c.id = r.client_id ' +
  'LEFT JOIN matters m ON m.id = r.matter_id ' +
  'LEFT JOIN commitments cm ON cm.id = r.commitment_id '

function selectReceivableRows(store, { clientId = null, projectId = null, currency = null } = {}) {
  const where = []
  const params = []
  if (clientId) { where.push('r.client_id = ?'); params.push(clientId) }
  if (projectId) { where.push('r.project_id = ?'); params.push(projectId) }
  if (currency) { where.push('r.currency = ?'); params.push(currency) }
  const sql = RECEIVABLE_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY r.created_at DESC, r.id ASC'
  return store.db.prepare(sql).all(...params)
}

function selectReceivableRow(store, id) {
  return store.db.prepare(RECEIVABLE_SELECT + ' WHERE r.id = ?').get(id)
}

function selectPayments(store, { clientId = null, commitmentIds = null } = {}) {
  let sql = 'SELECT * FROM payments WHERE 1 = 1'
  const params = []
  if (clientId) { sql += ' AND client_id = ?'; params.push(clientId) }
  if (commitmentIds) {
    if (!commitmentIds.length) return []
    sql += ' AND commitment_id IN (' + commitmentIds.map(() => '?').join(',') + ')'
    params.push(...commitmentIds)
  }
  sql += ' ORDER BY paid_at DESC, created_at DESC, id ASC'
  return store.db.prepare(sql).all(...params)
}

function activePaymentsForCommitments(store, commitmentIds, { includeVoided = false } = {}) {
  if (!commitmentIds.length) return []
  const placeholders = commitmentIds.map(() => '?').join(',')
  const sql = 'SELECT * FROM payments WHERE commitment_id IN (' + placeholders + ')' + (includeVoided ? '' : ' AND deleted_at IS NULL') + ' ORDER BY paid_at DESC, created_at DESC, id ASC'
  return store.db.prepare(sql).all(...commitmentIds)
}

function paymentAggregatesByCommitment(payments) {
  const byKey = new Map()
  for (const payment of payments) {
    if (!payment.commitment_id) continue
    const key = payment.commitment_id + AGG_KEY_SEP + payment.currency
    let aggregate = byKey.get(key)
    if (!aggregate) {
      aggregate = { minor: 0n, count: 0, lastPaidAt: null, lastMs: null }
      byKey.set(key, aggregate)
    }
    aggregate.minor += BigInt(payment.amount_minor)
    aggregate.count += 1
    const ms = instantOf(payment.paid_at) ?? instantOf(payment.created_at)
    if (ms !== null && (aggregate.lastMs === null || ms > aggregate.lastMs)) {
      aggregate.lastMs = ms
      aggregate.lastPaidAt = payment.paid_at
    }
  }
  return byKey
}

/* --------------------------- row projection ------------------------------- */

function effectiveSecrecy(clientSecrecy, matterSecrecy) {
  const clientLevel = Number(clientSecrecy ?? 0)
  const matterLevel = matterSecrecy === undefined || matterSecrecy === null ? 0 : Number(matterSecrecy)
  if (!Number.isFinite(clientLevel) || !Number.isFinite(matterLevel)) return Number.POSITIVE_INFINITY
  return Math.max(clientLevel, matterLevel)
}

function deriveState(row, paidMinor, dueMs, nowMs) {
  if (row.deleted_at) return 'void'
  if (row.written_off_at) return 'written_off'
  if (paidMinor >= BigInt(row.amount_minor)) return 'settled'
  if (dueMs !== null && dueMs < nowMs) return 'overdue'
  if (paidMinor > 0n) return 'partial'
  return 'open'
}

function overdueDaysOf(dueMs, nowMs) {
  if (dueMs === null || dueMs >= nowMs) return null
  return Math.max(0, Math.floor((nowMs - dueMs) / DAY_MS))
}

function agingBucketOf(state, dueMs, nowMs) {
  if (state !== 'open' && state !== 'partial' && state !== 'overdue') return null
  if (dueMs === null) return 'noDue'
  if (dueMs >= nowMs) return 'notDue'
  const days = Math.floor((nowMs - dueMs) / DAY_MS)
  if (days <= 30) return '0_30'
  if (days <= 60) return '31_60'
  if (days <= 90) return '61_90'
  return '90plus'
}

function parseJsonArray(value) {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : undefined
  } catch {
    return undefined
  }
}

function receivableRowProjection(row, aggregate, { nowMs, clearance }) {
  // Missing client / matter / commitment rows mean dangling data: treat as
  // protected (count only) so no id or label can leak through a broken link.
  if (row.client_name === undefined || row.client_name === null) return { hidden: true }
  if (row.matter_id && row.matter_secrecy === undefined) return { hidden: true }
  if (!row.commitment_action) return { hidden: true }
  const secrecy = effectiveSecrecy(row.client_secrecy, row.matter_id ? row.matter_secrecy : null)
  if (secrecy > clearance) return { hidden: true }

  const amountMinor = BigInt(row.amount_minor)
  const paidMinor = aggregate ? aggregate.minor : 0n
  const dueMs = receivableDueInstant(row.commitment_due_at)
  const state = deriveState(row, paidMinor, dueMs, nowMs)
  const rawOutstanding = amountMinor > paidMinor ? amountMinor - paidMinor : 0n
  const outstandingMinor = state === 'void' || state === 'written_off' ? 0n : rawOutstanding
  const overpaidMinor = paidMinor > amountMinor ? paidMinor - amountMinor : 0n
  const reminderOffsets = parseJsonArray(row.commitment_reminder_offsets)

  const receivable = {
    id: row.id,
    commitmentId: row.commitment_id,
    label: String(row.commitment_action ?? ''),
    kind: row.kind,
    ...(row.memo ? { memo: row.memo } : {}),
    clientId: row.client_id,
    clientName: String(row.client_name ?? ''),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.matter_id ? { matterId: row.matter_id } : {}),
    ...(row.delivery_id ? { deliveryId: row.delivery_id } : {}),
    amountMinor: minorToNumber(amountMinor),
    amount: formatMinorAmount(amountMinor),
    currency: row.currency,
    paidMinor: minorToNumber(paidMinor),
    paid: formatMinorAmount(paidMinor),
    outstandingMinor: minorToNumber(outstandingMinor),
    outstanding: formatMinorAmount(outstandingMinor),
    ...(overpaidMinor > 0n ? { overpaidMinor: minorToNumber(overpaidMinor), overpaid: formatMinorAmount(overpaidMinor) } : {}),
    state,
    dueAt: row.commitment_due_at ?? null,
    overdueDays: state === 'overdue' ? overdueDaysOf(dueMs, nowMs) : null,
    payments: {
      count: aggregate ? aggregate.count : 0,
      ...(aggregate?.lastPaidAt ? { lastPaidAt: aggregate.lastPaidAt } : {}),
    },
    ...(reminderOffsets ? { reminderOffsets } : {}),
    createdAt: row.created_at,
    ...(row.updated_at && row.updated_at !== row.created_at ? { updatedAt: row.updated_at } : {}),
    ...(row.written_off_at ? { writtenOffAt: row.written_off_at } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    ...(row.closed_by_payment_id ? { closedByPaymentId: row.closed_by_payment_id } : {}),
  }
  return { hidden: false, receivable, dueMs, amountMinor, paidMinor, outstandingMinor, overpaidMinor, aging: agingBucketOf(state, dueMs, nowMs) }
}

/* ------------------------------ collector --------------------------------- */

function emptyTotals(currency) {
  return {
    currency,
    amountMinor: 0,
    paidMinor: 0,
    outstandingMinor: 0,
    overdueMinor: 0,
    overpaidMinor: 0,
    unmatchedMinor: 0,
    count: 0,
    unsettledCount: 0,
    settledCount: 0,
    overdueCount: 0,
    writtenOffCount: 0,
    voidCount: 0,
    aging: { notDue: 0, '0_30': 0, '31_60': 0, '61_90': 0, '90plus': 0, noDue: 0 },
  }
}

function currencyRank(currency) {
  const index = CURRENCIES.indexOf(currency)
  return index === -1 ? CURRENCIES.length : index
}

function compareReceivableRows(left, right) {
  const leftOverdue = left.receivable.state === 'overdue' ? 0 : 1
  const rightOverdue = right.receivable.state === 'overdue' ? 0 : 1
  if (leftOverdue !== rightOverdue) return leftOverdue - rightOverdue
  const leftDue = left.projection.dueMs
  const rightDue = right.projection.dueMs
  if (leftDue !== rightDue) {
    if (leftDue === null) return 1
    if (rightDue === null) return -1
    return leftDue - rightDue
  }
  const leftCreated = left.receivable.createdAt ?? ''
  const rightCreated = right.receivable.createdAt ?? ''
  if (leftCreated !== rightCreated) return leftCreated < rightCreated ? 1 : -1
  return left.receivable.id < right.receivable.id ? -1 : left.receivable.id > right.receivable.id ? 1 : 0
}

/**
 * One read snapshot: select candidate rows + their payments, apply clearance,
 * derive state, apply the caller's filters, then derive per-currency totals and
 * aging. Paging happens afterwards in receivableList.
 */
function collectReceivables(store, options = {}) {
  assertStore(store)
  const nowMs = Date.parse(nowIso(options.now))
  const clearance = normalizeClearance(options.clearance)
  const clientIdValue = pickOption(options, ['clientId', 'client'])
  const clientId = clientIdValue === undefined ? null : String(clientIdValue).trim()
  const projectIdValue = pickOption(options, ['projectId', 'project'])
  const projectId = projectIdValue === undefined ? null : String(projectIdValue).trim()
  const currencyValue = pickOption(options, ['currency'])
  const currencyFilter = currencyValue === undefined ? null : parseCurrency(currencyValue)
  const statusValue = pickOption(options, ['status'])
  const status = statusValue === undefined ? 'active' : String(statusValue).trim()
  const allowedStatuses = new Set([...RECEIVABLE_STATES, 'active', 'all', 'unsettled'])
  if (!allowedStatuses.has(status)) throw invalid('status must be one of open, partial, overdue, settled, written_off, void, active, all, unsettled')
  const dueWithinMs = normalizeDueWithin(pickOption(options, ['dueWithin', 'due-within']), nowMs)

  return store.read(() => {
    const candidates = selectReceivableRows(store, { clientId, projectId, currency: currencyFilter })
    const commitmentIds = [...new Set(candidates.map((row) => row.commitment_id).filter(Boolean))]
    let payments
    if (projectId) payments = activePaymentsForCommitments(store, commitmentIds)
    else if (clientId) payments = selectPayments(store, { clientId })
    else payments = selectPayments(store)
    const aggregates = paymentAggregatesByCommitment(payments)
    const unmatched = new Map()
    if (!projectId) {
      for (const payment of payments) {
        if (payment.commitment_id) continue
        const agg = unmatched.get(payment.currency) ?? { minor: 0n, count: 0 }
        agg.minor += BigInt(payment.amount_minor)
        agg.count += 1
        unmatched.set(payment.currency, agg)
      }
    }

    const rows = []
    let protectedExcluded = 0
    for (const candidate of candidates) {
      const aggregate = aggregates.get(candidate.commitment_id + AGG_KEY_SEP + candidate.currency) ?? null
      const projection = receivableRowProjection(candidate, aggregate, { nowMs, clearance })
      if (projection.hidden) { protectedExcluded += 1; continue }
      const receivable = projection.receivable
      // Filters run after clearance and before totals/paging.
      if (status === 'active') {
        if (receivable.state === 'void') continue
      } else if (status === 'unsettled') {
        if (!(receivable.state === 'open' || receivable.state === 'partial' || receivable.state === 'overdue')) continue
      } else if (status !== 'all' && receivable.state !== status) {
        continue
      }
      if (dueWithinMs !== null) {
        if (projection.dueMs === null || projection.dueMs > dueWithinMs) continue
      }
      rows.push({ receivable, projection })
    }

    rows.sort(compareReceivableRows)

    const totalsByCurrency = new Map()
    const ensureTotals = (currency) => {
      let totals = totalsByCurrency.get(currency)
      if (!totals) { totals = emptyTotals(currency); totalsByCurrency.set(currency, totals) }
      return totals
    }
    for (const currency of CURRENCIES) ensureTotals(currency)
    for (const { receivable, projection } of rows) {
      const totals = ensureTotals(receivable.currency)
      totals.count += 1
      if (receivable.state === 'void') totals.voidCount += 1
      else totals.amountMinor = minorAdd(totals.amountMinor, receivable.amountMinor)
      if (receivable.state === 'settled') totals.settledCount += 1
      else if (receivable.state === 'open' || receivable.state === 'partial' || receivable.state === 'overdue') totals.unsettledCount += 1
      if (receivable.state === 'written_off') totals.writtenOffCount += 1
      if (receivable.state === 'overdue') totals.overdueCount += 1
      totals.paidMinor = minorAdd(totals.paidMinor, receivable.paidMinor)
      totals.outstandingMinor = minorAdd(totals.outstandingMinor, receivable.outstandingMinor)
      totals.overpaidMinor = minorAdd(totals.overpaidMinor, receivable.overpaidMinor ?? 0)
      if (receivable.state === 'overdue') totals.overdueMinor = minorAdd(totals.overdueMinor, receivable.outstandingMinor)
      if (projection.aging) totals.aging[projection.aging] += 1
    }
    for (const [currency, agg] of unmatched) {
      const totals = ensureTotals(currency)
      totals.unmatchedMinor = minorAdd(totals.unmatchedMinor, minorToNumber(agg.minor))
    }
    const totals = [...totalsByCurrency.values()]
      .filter((entry) => entry.count > 0 || entry.paidMinor > 0 || entry.unmatchedMinor > 0 || entry.overpaidMinor > 0)
      .sort((left, right) => currencyRank(left.currency) - currencyRank(right.currency))

    let nextDueMs = null
    for (const { receivable, projection } of rows) {
      if (receivable.state !== 'open' && receivable.state !== 'partial' && receivable.state !== 'overdue') continue
      if (projection.dueMs === null) continue
      if (nextDueMs === null || projection.dueMs < nextDueMs) nextDueMs = projection.dueMs
    }

    const unsettled = rows.filter(({ receivable }) => receivable.state === 'open' || receivable.state === 'partial' || receivable.state === 'overdue').length
    return {
      rows,
      totals,
      unmatchedPayments: [...unmatched.entries()]
        .map(([currency, agg]) => ({ currency, amountMinor: minorToNumber(agg.minor), amount: formatMinorAmount(agg.minor), count: agg.count }))
        .sort((left, right) => currencyRank(left.currency) - currencyRank(right.currency)),
      protectedExcluded,
      clearance,
      nextDueAt: nextDueMs === null ? null : toShanghaiIso(nextDueMs),
      counts: {
        total: rows.length,
        unsettled,
        settled: rows.filter(({ receivable }) => receivable.state === 'settled').length,
        overdue: rows.filter(({ receivable }) => receivable.state === 'overdue').length,
        writtenOff: rows.filter(({ receivable }) => receivable.state === 'written_off').length,
        void: rows.filter(({ receivable }) => receivable.state === 'void').length,
      },
    }
  })
}

/* -------------------------------------------------------------------------- */
/* writes                                                                     */
/* -------------------------------------------------------------------------- */

function commitmentPorts(now) {
  return {
    clock: { now: () => now },
    ids: { next: (prefix) => newId(prefix) },
  }
}

function mapMatter(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    domain: row.domain,
    secrecy: row.secrecy,
    summary: row.summary ?? undefined,
    participants: safeJson(row.participants, []),
    deadlines: safeJson(row.deadlines, []),
    openQuestions: safeJson(row.open_questions, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.client_id == null ? {} : { clientId: row.client_id }),
    ...(row.project_id == null ? {} : { projectId: row.project_id }),
  }
}

function safeJson(value, fallback) {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function createReceivableMatter(store, { client, projectId, now }) {
  const matter = {
    id: newId('matter'),
    title: RECEIVABLE_MATTER_TITLE,
    status: 'active',
    domain: 'customer',
    secrecy: Number(client.secrecy_default ?? 0),
    participants: [],
    deadlines: [],
    openQuestions: [],
    createdAt: now,
    updatedAt: now,
    clientId: client.id,
    ...(projectId ? { projectId } : {}),
  }
  store.insertMatter(matter)
  return matter
}

function validateProjectForClient(store, projectId, clientId) {
  if (!projectId) return null
  const project = store.getProject(projectId)
  if (!project) throw entityError('E_PROJECT_NOT_FOUND', 'unknown project: ' + projectId, 'advisers project list --client ' + clientId)
  if (project.clientId !== clientId) throw entityError('E_PROJECT_CLIENT_MISMATCH', 'project ' + projectId + ' does not belong to client ' + clientId)
  return project
}

function resolveMatterForReceivable(store, { client, clientId, projectId, matterId, now }) {
  let project = null
  if (projectId) {
    project = store.getProject(projectId)
    if (!project) throw entityError('E_PROJECT_NOT_FOUND', 'unknown project: ' + projectId, 'advisers project list --client ' + clientId)
    if (project.clientId !== clientId) throw entityError('E_PROJECT_CLIENT_MISMATCH', 'project ' + projectId + ' does not belong to client ' + clientId)
    if (project.status !== 'active' || project.deletedAt) throw entityError('E_PROJECT_ARCHIVED', 'project is archived: ' + projectId, 'advisers project list --client ' + clientId)
  }
  if (matterId) {
    const matter = store.getMatter(matterId)
    if (!matter) throw entityError('E_MATTER_NOT_FOUND', 'unknown matter: ' + matterId, 'advisers matter ls')
    if (matter.status !== 'active') throw entityError('E_MATTER_ARCHIVED', 'matter is archived: ' + matterId, 'advisers matter ls')
    if (matter.clientId !== clientId) throw entityError('E_MATTER_CLIENT_MISMATCH', 'matter ' + matterId + ' does not belong to client ' + clientId)
    if (project && matter.projectId && matter.projectId !== project.id) {
      throw invalid('matter ' + matterId + ' belongs to project ' + matter.projectId + ', not ' + project.id)
    }
    const derivedProjectId = project?.id ?? matter.projectId ?? null
    validateProjectForClient(store, derivedProjectId, clientId)
    return { matter, projectId: derivedProjectId, createdMatter: false }
  }
  if (project) {
    if (project.defaultMatterId) {
      const candidate = store.getMatter(project.defaultMatterId)
      if (candidate && candidate.status === 'active' && candidate.clientId === clientId) {
        return { matter: candidate, projectId: project.id, createdMatter: false }
      }
    }
    const existing = store.db.prepare("SELECT * FROM matters WHERE client_id = ? AND title = ? AND status = 'active' AND project_id = ? ORDER BY rowid LIMIT 1").get(clientId, RECEIVABLE_MATTER_TITLE, project.id)
    if (existing) return { matter: mapMatter(existing), projectId: project.id, createdMatter: false }
    return { matter: createReceivableMatter(store, { client, projectId: project.id, now }), projectId: project.id, createdMatter: true }
  }
  const activeMatters = store.db.prepare("SELECT * FROM matters WHERE client_id = ? AND status = 'active' ORDER BY created_at ASC, rowid ASC").all(clientId)
  if (activeMatters.length === 1) {
    const only = mapMatter(activeMatters[0])
    validateProjectForClient(store, only.projectId ?? null, clientId)
    return { matter: only, projectId: only.projectId ?? null, createdMatter: false }
  }
  const existing = store.db.prepare("SELECT * FROM matters WHERE client_id = ? AND title = ? AND status = 'active' AND project_id IS NULL ORDER BY rowid LIMIT 1").get(clientId, RECEIVABLE_MATTER_TITLE)
  if (existing) return { matter: mapMatter(existing), projectId: null, createdMatter: false }
  return { matter: createReceivableMatter(store, { client, projectId: null, now }), projectId: null, createdMatter: true }
}

function validateDeliveryLineage(store, { deliveryId, clientId, matterId }) {
  if (!deliveryId) return
  const delivery = store.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId)
  if (!delivery) throw entityError('E_DELIVERY_INVALID', 'unknown delivery: ' + deliveryId, 'advisers deliveries --json')
  if (delivery.client_id != null && delivery.client_id !== clientId) {
    throw invalid('delivery ' + deliveryId + ' belongs to another client')
  }
  if (delivery.matter_id != null) {
    const matter = store.getMatter(delivery.matter_id)
    if (!matter || matter.clientId !== clientId) throw invalid('delivery ' + deliveryId + ' belongs to a matter outside client ' + clientId)
    if (matterId && delivery.matter_id !== matterId) throw invalid('delivery ' + deliveryId + ' belongs to matter ' + delivery.matter_id + ', not ' + matterId)
  }
}

function insertReceivable(store, row) {
  store.db.prepare('INSERT INTO receivables(id, commitment_id, client_id, project_id, matter_id, delivery_id, amount_minor, currency, kind, memo, closed_by_payment_id, written_off_at, created_at, updated_at, deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    row.id,
    row.commitmentId,
    row.clientId,
    row.projectId ?? null,
    row.matterId ?? null,
    row.deliveryId ?? null,
    row.amountMinor,
    row.currency,
    row.kind,
    row.memo ?? null,
    row.closedByPaymentId ?? null,
    row.writtenOffAt ?? null,
    row.createdAt,
    row.updatedAt,
    row.deletedAt ?? null,
  )
}

function readReceivableResult(store, id, { nowMs, clearance = DEFAULT_CLEARANCE, includeVoidedPayments = false } = {}) {
  if (!id) return null
  const row = selectReceivableRow(store, id)
  if (!row) return null
  const payments = activePaymentsForCommitments(store, [row.commitment_id], { includeVoided: includeVoidedPayments })
  const active = includeVoidedPayments ? payments.filter((payment) => payment.deleted_at === null) : payments
  const aggregate = paymentAggregatesByCommitment(active).get(row.commitment_id + AGG_KEY_SEP + row.currency) ?? null
  const projection = receivableRowProjection(row, aggregate, { nowMs, clearance })
  return { row, payments, projection }
}

/**
 * Create a receivable and its follow-up commitment in one audited transaction.
 *
 * @param {object} store opened writable SqliteStore
 * @param {object} input
 * @param {string} input.clientId live client id
 * @param {string} input.label one-line action ("尾款 12 月"), never an amount
 * @param {string|bigint} input.amount decimal string ("8000.00") or BigInt minor units
 * @param {string} [input.currency=CNY] CNY|USD|EUR|HKD
 * @param {string} [input.dueAt] YYYY-MM-DD or ISO instant (date-only = end of Shanghai day)
 * @param {string} [input.projectId] optional project owned by the client
 * @param {string} [input.matterId] optional active matter owned by the client
 * @param {string} [input.deliveryId] optional delivery owned by the client
 * @param {string} [input.kind=other] quote|milestone|retainer|other
 * @param {string} [input.memo] <=200 chars, single line, no absolute paths
 * @param {string[]|string} [input.reminderOffsets] e.g. ['-3d','-1d'] or "-3d,-1d"
 * @param {boolean} [input.noRemind] do not write reminder offsets
 * @param {string|Date} [input.now] injectable clock
 * @returns {{receivable: object|null, commitment: object, createdMatter: boolean}}
 */
export function receivableAdd(store, input = {}) {
  assertStore(store)
  if (typeof store.mutate !== 'function') throw new TypeError('receivableAdd requires a writable SqliteStore')
  const options = input && typeof input === 'object' ? input : {}
  const now = nowIso(options.now)
  const clientId = parseId(options.clientId, 'clientId')
  const label = normalizeOperatorText('label', options.label, LABEL_MAX)
  if (!label) throw invalid('a receivable label is required')
  const amountMinor = parseAmountToMinor(options.amount)
  const currency = parseCurrency(options.currency)
  const kind = parseKind(options.kind)
  const memo = normalizeOperatorText('memo', options.memo, MEMO_MAX)
  const dueAt = normalizeDueAt(pickOption(options, ['dueAt', 'due']))
  const optionalId = (...names) => {
    const value = pickOption(options, names)
    if (value === undefined) return null
    const text = String(value).trim()
    return text || null
  }
  const projectId = optionalId('projectId', 'project')
  const matterId = optionalId('matterId', 'matter')
  const deliveryId = optionalId('deliveryId', 'delivery')
  const noRemind = pickOption(options, ['noRemind', 'no-remind']) === true
  const reminderOffsets = noRemind ? undefined : resolveReminderOffsets(pickOption(options, ['reminderOffsets', 'remindOffsets', 'remind-offsets']))
  const receivableId = newId('rcv')
  const audit = { actor: 'local', action: 'receivable.add', allowed: true, reason: receivableId }
  const made = store.mutate((s) => {
    const client = requireClientRow(s, clientId, 'receivableAdd')
    const resolved = resolveMatterForReceivable(s, { client, clientId, projectId, matterId, now })
    validateDeliveryLineage(s, { deliveryId, clientId, matterId: resolved.matter.id })
    const commitment = createCommitment(commitmentPorts(now), {
      matterId: resolved.matter.id,
      debtor: 'third:' + String(client.name ?? ''),
      creditor: 'me',
      action: label,
      ...(dueAt ? { dueAt } : {}),
      timezone: 'Asia/Shanghai',
      capability: 'todo',
      evidence: [manualEvidence('receivable ' + receivableId, 'receivable add', now)],
      ...(reminderOffsets && reminderOffsets.length ? { reminderOffsets } : {}),
    })
    s.insertCommitment(commitment)
    insertReceivable(s, {
      id: receivableId,
      commitmentId: commitment.id,
      clientId,
      projectId: resolved.projectId,
      matterId: resolved.matter.id,
      deliveryId,
      amountMinor: minorToNumber(amountMinor),
      currency,
      kind,
      memo,
      createdAt: now,
      updatedAt: now,
    })
    audit.reason = receivableId + ' ' + commitment.id + ' client ' + clientId
    return { resolved, commitment, amountMinor }
  }, audit)
  const result = readReceivableResult(store, receivableId, { nowMs: Date.parse(now) })
  return {
    receivable: result && !result.projection.hidden ? result.projection.receivable : null,
    commitment: made.result.commitment,
    createdMatter: made.result.resolved.createdMatter,
  }
}

/**
 * Edit mutable receivable fields (amount, due date, memo, kind, label/reminders).
 * The amount cannot change while active payments exist (void them first): a
 * silent re-baseline would make every historical payment ambiguous.
 *
 * @param {object} store writable store
 * @param {string} id receivable id
 * @param {{amount?: string|bigint, dueAt?: string, memo?: string|null, kind?: string,
 *          label?: string, reminderOffsets?: string[]|string, noRemind?: boolean}} patch
 * @param {{now?: string|Date}} [options]
 * @returns {{receivable: object|null, commitment: object}}
 */
export function receivableEdit(store, id, patch = {}, options = {}) {
  assertStore(store)
  if (typeof store.mutate !== 'function') throw new TypeError('receivableEdit requires a writable SqliteStore')
  const receivableId = parseId(id, 'receivable id')
  const source = patch && typeof patch === 'object' ? patch : {}
  const requested = { ...source }
  // CLI spellings that differ from the stored field names.
  if (requested.dueAt === undefined && requested.due !== undefined) requested.dueAt = requested.due
  if (requested.reminderOffsets === undefined && requested['remind-offsets'] !== undefined) requested.reminderOffsets = requested['remind-offsets']
  if (requested.noRemind === undefined && requested['no-remind'] !== undefined) requested.noRemind = requested['no-remind']
  const now = nowIso(options.now ?? requested.now)
  const fields = []
  if (requested.amount !== undefined) fields.push('amount')
  if (requested.dueAt !== undefined) fields.push('dueAt')
  if (requested.memo !== undefined) fields.push('memo')
  if (requested.kind !== undefined) fields.push('kind')
  if (requested.label !== undefined) fields.push('label')
  if (requested.reminderOffsets !== undefined || requested.noRemind === true) fields.push('reminders')
  if (!fields.length) throw invalid('nothing to edit (amount, due, memo, kind, label, reminders)')
  const amountMinor = requested.amount === undefined ? undefined : parseAmountToMinor(requested.amount)
  const kind = requested.kind === undefined ? undefined : parseKind(requested.kind)
  const memoProvided = requested.memo !== undefined
  const memo = memoProvided ? normalizeOperatorText('memo', requested.memo, MEMO_MAX) : undefined
  const dueProvided = requested.dueAt !== undefined
  const dueAt = dueProvided ? normalizeDueAt(requested.dueAt) : undefined
  if (dueProvided && !dueAt) throw invalid('due date must not be empty')
  const label = requested.label === undefined ? undefined : normalizeOperatorText('label', requested.label, LABEL_MAX)
  if (requested.label !== undefined && !label) throw invalid('label must not be empty')
  let reminderOffsets
  if (requested.noRemind === true) reminderOffsets = null
  else if (requested.reminderOffsets !== undefined) {
    const normalized = resolveReminderOffsets(requested.reminderOffsets)
    reminderOffsets = normalized && normalized.length ? normalized : null
  }
  const audit = { actor: 'local', action: 'receivable.edit', allowed: true, reason: receivableId + ' fields=' + fields.join(',') }
  const made = store.mutate((s) => {
    const row = s.db.prepare('SELECT * FROM receivables WHERE id = ?').get(receivableId)
    if (!row) throw entityError('E_RECEIVABLE_NOT_FOUND', 'unknown receivable: ' + receivableId, 'advisers receivable ls')
    if (row.deleted_at) throw invalid('receivable is void: ' + receivableId + '; a void record is immutable')
    const commitment = s.getCommitment(row.commitment_id)
    if (!commitment) throw invalid('receivable ' + receivableId + ' points at a missing commitment ' + row.commitment_id)
    const rowPatch = { updated_at: now }
    const commitmentPatch = {}
    if (amountMinor !== undefined) {
      const active = s.db.prepare('SELECT COUNT(*) AS n FROM payments WHERE commitment_id = ? AND deleted_at IS NULL').get(row.commitment_id)
      if (Number(active?.n ?? 0) > 0) {
        throw invalid('cannot change the amount of ' + receivableId + ' while ' + Number(active.n) + ' payment(s) exist', 'advisers payment ls --receivable ' + receivableId)
      }
      rowPatch.amount_minor = minorToNumber(amountMinor)
    }
    if (kind !== undefined) rowPatch.kind = kind
    if (memoProvided) rowPatch.memo = memo ?? null
    if (dueProvided) commitmentPatch.dueAt = dueAt ?? null
    if (label !== undefined) commitmentPatch.action = label
    if (reminderOffsets !== undefined) commitmentPatch.reminderOffsets = reminderOffsets
    const sets = Object.keys(rowPatch)
    s.db.prepare('UPDATE receivables SET ' + sets.map((field) => field + ' = ?').join(', ') + ' WHERE id = ?')
      .run(...sets.map((field) => rowPatch[field]), receivableId)
    if (Object.keys(commitmentPatch).length) s.updateCommitment(row.commitment_id, commitmentPatch)
    return { commitment }
  }, audit)
  const result = readReceivableResult(store, receivableId, { nowMs: Date.parse(now) })
  return {
    receivable: result && !result.projection.hidden ? result.projection.receivable : null,
    commitment: made.result.commitment,
  }
}

/**
 * Void a receivable (tombstone). Fail closed while active payments exist: void
 * the payments first so the reopening chain stays exact. The follow-up
 * commitment is dropped when it is still pending; an auto-completed one is
 * reopened when the void removes its closed_by_payment_id link.
 *
 * @param {object} store writable store
 * @param {string} id receivable id
 * @param {{reason?: string, now?: string|Date}} [options]
 * @returns {{receivable: object|null, alreadyVoid: boolean, reopenedCommitment: boolean,
 *            droppedCommitment: boolean, reason?: string}}
 */
export function receivableVoid(store, id, options = {}) {
  assertStore(store)
  if (typeof store.mutate !== 'function') throw new TypeError('receivableVoid requires a writable SqliteStore')
  const receivableId = parseId(id, 'receivable id')
  const now = nowIso(options.now)
  const reason = normalizeOperatorText('reason', options.reason, REASON_MAX)
  const audit = { actor: 'local', action: 'receivable.void', allowed: true, reason: receivableId }
  const made = store.mutate((s) => {
    const row = s.db.prepare('SELECT * FROM receivables WHERE id = ?').get(receivableId)
    if (!row) throw entityError('E_RECEIVABLE_NOT_FOUND', 'unknown receivable: ' + receivableId, 'advisers receivable ls')
    if (row.deleted_at) return { alreadyVoid: true, reopenedCommitment: false, droppedCommitment: false }
    const active = s.db.prepare('SELECT COUNT(*) AS n FROM payments WHERE commitment_id = ? AND deleted_at IS NULL').get(row.commitment_id)
    if (Number(active?.n ?? 0) > 0) {
      throw invalid('receivable ' + receivableId + ' still has ' + Number(active.n) + ' active payment(s)', 'advisers payment ls --receivable ' + receivableId + ' (void them first)')
    }
    let reopenedCommitment = false
    let droppedCommitment = false
    const commitment = s.getCommitment(row.commitment_id)
    if (row.closed_by_payment_id) {
      if (commitment && commitment.status === 'done') {
        s.updateCommitment(row.commitment_id, { status: 'open', doneAt: null })
        reopenedCommitment = true
      } else if (commitment && (commitment.status === 'open' || commitment.status === 'snoozed')) {
        s.updateCommitment(row.commitment_id, { status: 'dropped' })
        droppedCommitment = true
      }
    } else if (commitment && (commitment.status === 'open' || commitment.status === 'snoozed')) {
      s.updateCommitment(row.commitment_id, { status: 'dropped' })
      droppedCommitment = true
    }
    s.db.prepare('UPDATE receivables SET deleted_at = ?, updated_at = ?, closed_by_payment_id = NULL WHERE id = ?').run(now, now, receivableId)
    return { alreadyVoid: false, reopenedCommitment, droppedCommitment }
  }, audit)
  const result = readReceivableResult(store, receivableId, { nowMs: Date.parse(now), includeVoidedPayments: true })
  return {
    receivable: result && !result.projection.hidden ? result.projection.receivable : null,
    alreadyVoid: made.result.alreadyVoid,
    reopenedCommitment: made.result.reopenedCommitment,
    droppedCommitment: made.result.droppedCommitment,
    ...(reason ? { reason } : {}),
  }
}

function insertPayment(store, row) {
  store.db.prepare('INSERT INTO payments(id, client_id, commitment_id, amount_minor, currency, paid_at, method, memo, created_at, updated_at, deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(
    row.id,
    row.clientId,
    row.commitmentId ?? null,
    row.amountMinor,
    row.currency,
    row.paidAt,
    row.method,
    row.memo ?? null,
    row.createdAt,
    row.updatedAt,
  )
}

/**
 * Record a payment. With a receivable the currency/client must match, the
 * outstanding balance is recomputed from the rows, and a full payment completes
 * the follow-up commitment in the same transaction (unless noComplete).
 * Without a receivable the payment is an unmatched prepayment.
 *
 * @param {object} store writable store
 * @param {{clientId: string, amount: string|bigint, currency?: string, paidAt?: string,
 *          method?: string, memo?: string, receivableId?: string, commitmentId?: string,
 *          noComplete?: boolean, now?: string|Date}} input
 * @returns {{payment: object, receivable: object|null, commitment: object|null,
 *            completedCommitment: boolean}}
 */
export function paymentAdd(store, input = {}) {
  assertStore(store)
  if (typeof store.mutate !== 'function') throw new TypeError('paymentAdd requires a writable SqliteStore')
  const options = input && typeof input === 'object' ? input : {}
  const now = nowIso(options.now)
  const nowMs = Date.parse(now)
  const clientId = parseId(options.clientId, 'clientId')
  const amountMinor = parseAmountToMinor(options.amount, { code: 'E_PAYMENT_INVALID' })
  // A payment linked to a receivable infers its currency from that receivable;
  // an unmatched prepayment defaults to CNY. An explicit --currency always wins.
  const currencyInput = options.currency === undefined || options.currency === null || options.currency === '' ? null : parseCurrency(options.currency, { code: 'E_PAYMENT_INVALID' })
  const paidAt = normalizePaidAt(pickOption(options, ['paidAt', 'paid-at']), nowMs)
  const method = parseMethod(options.method)
  const memo = normalizeOperatorText('memo', options.memo, MEMO_MAX)
  const noCompleteValue = pickOption(options, ['noComplete', 'no-complete'])
  if (noCompleteValue !== undefined && typeof noCompleteValue !== 'boolean') throw invalidPayment('noComplete must be a boolean')
  const noComplete = noCompleteValue === true
  const optionalId = (...names) => {
    const value = pickOption(options, names)
    if (value === undefined) return null
    const text = String(value).trim()
    return text || null
  }
  const receivableId = optionalId('receivableId', 'receivable')
  const explicitCommitmentId = optionalId('commitmentId', 'commitment')
  const paymentId = newId('pay')
  const audit = { actor: 'local', action: 'payment.add', allowed: true, reason: paymentId }
  const made = store.mutate((s) => {
    requireClientRow(s, clientId, 'paymentAdd')
    let receivableRow = null
    let commitmentId = explicitCommitmentId
    if (receivableId) {
      receivableRow = s.db.prepare('SELECT * FROM receivables WHERE id = ?').get(receivableId)
      if (!receivableRow) throw entityError('E_RECEIVABLE_NOT_FOUND', 'unknown receivable: ' + receivableId, 'advisers receivable ls')
      if (receivableRow.deleted_at) throw invalidPayment('receivable is void: ' + receivableId)
      if (receivableRow.written_off_at) throw invalidPayment('receivable is written off: ' + receivableId)
      if (receivableRow.client_id !== clientId) throw invalidPayment('receivable ' + receivableId + ' belongs to client ' + receivableRow.client_id + ', not ' + clientId)
      if (currencyInput && receivableRow.currency !== currencyInput) throw invalidPayment('payment currency ' + currencyInput + ' does not match receivable currency ' + receivableRow.currency + ' (no FX conversion)')
      if (commitmentId && commitmentId !== receivableRow.commitment_id) throw invalidPayment('receivable ' + receivableId + ' is linked to commitment ' + receivableRow.commitment_id + ', not ' + commitmentId)
      commitmentId = receivableRow.commitment_id
    }
    const currency = currencyInput ?? (receivableRow ? receivableRow.currency : DEFAULT_CURRENCY)
    let commitment = commitmentId ? s.getCommitment(commitmentId) : null
    if (commitmentId && !commitment) throw invalidPayment('unknown commitment: ' + commitmentId)
    if (!receivableRow && commitment) {
      const matter = s.getMatter(commitment.matterId)
      if (matter && matter.clientId && matter.clientId !== clientId) throw invalidPayment('commitment ' + commitmentId + ' belongs to another client')
    }
    insertPayment(s, {
      id: paymentId,
      clientId,
      commitmentId,
      amountMinor: minorToNumber(amountMinor),
      currency,
      paidAt,
      method,
      memo,
      createdAt: now,
      updatedAt: now,
    })
    let completedCommitment = false
    if (receivableRow) {
      const total = s.db.prepare('SELECT COALESCE(SUM(amount_minor), 0) AS paid FROM payments WHERE commitment_id = ? AND deleted_at IS NULL AND currency = ?').get(receivableRow.commitment_id, receivableRow.currency)
      const paidMinor = BigInt(total?.paid ?? 0)
      const amount = BigInt(receivableRow.amount_minor)
      if (!noComplete && paidMinor >= amount && !receivableRow.closed_by_payment_id && commitment && commitment.status !== 'done' && commitment.status !== 'dropped') {
        const completed = completeCommitment(commitment, [manualEvidence('payment ' + paymentId, 'payment add', now)], now)
        s.updateCommitment(commitment.id, { status: completed.status, doneAt: completed.doneAt, evidence: completed.evidence })
        s.db.prepare('UPDATE receivables SET closed_by_payment_id = ?, updated_at = ? WHERE id = ?').run(paymentId, now, receivableRow.id)
        completedCommitment = true
        commitment = s.getCommitment(commitment.id)
      }
    }
    audit.reason = paymentId + (receivableRow ? ' ' + receivableRow.id : '') + ' client ' + clientId + ' method=' + method
    return { commitment, completedCommitment, receivableId: receivableRow ? receivableRow.id : null }
  }, audit)
  const result = made.result.receivableId ? readReceivableResult(store, made.result.receivableId, { nowMs }) : null
  return {
    payment: paymentFromDb(store.db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)),
    receivable: result && !result.projection.hidden ? result.projection.receivable : null,
    commitment: made.result.commitment,
    completedCommitment: made.result.completedCommitment,
  }
}

function paymentFromDb(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    ...(row.commitment_id ? { commitmentId: row.commitment_id } : {}),
    amountMinor: Number(row.amount_minor),
    amount: formatMinorAmount(BigInt(row.amount_minor)),
    currency: row.currency,
    paidAt: row.paid_at,
    method: row.method,
    ...(row.memo ? { memo: row.memo } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    createdAt: row.created_at,
    ...(row.updated_at && row.updated_at !== row.created_at ? { updatedAt: row.updated_at } : {}),
  }
}

/**
 * Void a payment (tombstone). When the void drops a settled receivable below its
 * amount, the follow-up commitment that this money completed is reopened; the
 * evidence history stays in place. Voiding an overpayment on an already-done
 * receivable leaves it settled and re-points closed_by_payment_id at a remaining
 * active payment so a later void still reopens correctly.
 *
 * @param {object} store writable store
 * @param {string} id payment id
 * @param {{reason?: string, now?: string|Date}} [options]
 * @returns {{payment: object, receivable: object|null, alreadyVoid: boolean,
 *            reopenedCommitment: boolean, reason?: string}}
 */
export function paymentVoid(store, id, options = {}) {
  assertStore(store)
  if (typeof store.mutate !== 'function') throw new TypeError('paymentVoid requires a writable SqliteStore')
  const paymentId = parseId(id, 'payment id')
  const now = nowIso(options.now)
  const reason = normalizeOperatorText('reason', options.reason, REASON_MAX)
  const audit = { actor: 'local', action: 'payment.void', allowed: true, reason: paymentId }
  const made = store.mutate((s) => {
    const payment = s.db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)
    if (!payment) throw entityError('E_PAYMENT_NOT_FOUND', 'unknown payment: ' + paymentId, 'advisers payment ls')
    if (payment.deleted_at) return { alreadyVoid: true, reopenedCommitment: false, receivableId: null }
    s.db.prepare('UPDATE payments SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, paymentId)
    let reopenedCommitment = false
    let receivableId = null
    if (payment.commitment_id) {
      const receivable = s.db.prepare('SELECT * FROM receivables WHERE commitment_id = ?').get(payment.commitment_id)
      if (receivable && !receivable.deleted_at) {
        receivableId = receivable.id
        const total = s.db.prepare('SELECT COALESCE(SUM(amount_minor), 0) AS paid FROM payments WHERE commitment_id = ? AND deleted_at IS NULL AND currency = ?').get(receivable.commitment_id, receivable.currency)
        const paidMinor = BigInt(total?.paid ?? 0)
        const amount = BigInt(receivable.amount_minor)
        if (receivable.closed_by_payment_id) {
          if (paidMinor >= amount) {
            const remaining = s.db.prepare('SELECT id FROM payments WHERE commitment_id = ? AND deleted_at IS NULL AND currency = ? ORDER BY paid_at DESC, created_at DESC, id ASC LIMIT 1').get(receivable.commitment_id, receivable.currency)
            s.db.prepare('UPDATE receivables SET closed_by_payment_id = ?, updated_at = ? WHERE id = ?').run(remaining?.id ?? paymentId, now, receivable.id)
          } else {
            const commitment = s.getCommitment(receivable.commitment_id)
            if (commitment && commitment.status === 'done') {
              s.updateCommitment(receivable.commitment_id, { status: 'open', doneAt: null })
              reopenedCommitment = true
            }
            s.db.prepare('UPDATE receivables SET closed_by_payment_id = NULL, updated_at = ? WHERE id = ?').run(now, receivable.id)
          }
        }
      }
    }
    audit.reason = paymentId + ' reopen=' + (reopenedCommitment ? '1' : '0') + (receivableId ? ' ' + receivableId : '')
    return { alreadyVoid: false, reopenedCommitment, receivableId }
  }, audit)
  const result = made.result.receivableId ? readReceivableResult(store, made.result.receivableId, { nowMs: Date.parse(now), includeVoidedPayments: true }) : null
  return {
    payment: paymentFromDb(store.db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)),
    receivable: result && !result.projection.hidden ? result.projection.receivable : null,
    alreadyVoid: made.result.alreadyVoid,
    reopenedCommitment: made.result.reopenedCommitment,
    ...(reason ? { reason } : {}),
  }
}

/* -------------------------------------------------------------------------- */
/* reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Page of receivable rows plus per-currency reconciliation totals.
 *
 * @param {object} store opened store (read-only stores are fine)
 * @param {{clientId?:string, projectId?:string, status?:string, currency?:string,
 *          dueWithin?:string|number, clearance?:0|1|2|3, limit?:number,
 *          now?:string|Date}} [options]
 * @returns {{ok:boolean, command:string, receivables:object[], totals:object[],
 *            total:number, truncated:boolean, limit:number, clearance:number,
 *            protectedExcluded:number}}
 */
export function receivableList(store, options = {}) {
  const limit = normalizeLimit(options?.limit, RECEIVABLE_LIST_LIMIT, RECEIVABLE_LIST_LIMIT_MAX)
  const collected = collectReceivables(store, options)
  const page = collected.rows.slice(0, limit).map(({ receivable }) => receivable)
  return {
    ok: true,
    command: 'receivable ls',
    receivables: page,
    totals: collected.totals,
    total: collected.rows.length,
    truncated: collected.rows.length > page.length,
    limit,
    clearance: collected.clearance,
    protectedExcluded: collected.protectedExcluded,
  }
}

/**
 * Reconciliation summary (amounts, aging, overdue) for a client/project scope.
 * No row ids are returned; it is the additive client-show aggregation and the
 * standalone receivables aging/totals view.
 */
export function receivablesSummary(store, options = {}) {
  const collected = collectReceivables(store, options)
  return {
    ok: true,
    command: 'receivable summary',
    currency: options?.currency ? parseCurrency(options.currency) : null,
    ...collected.counts,
    totals: collected.totals,
    unmatchedPayments: collected.unmatchedPayments,
    nextDueAt: collected.nextDueAt,
    clearance: collected.clearance,
    protectedExcluded: collected.protectedExcluded,
  }
}

/**
 * Additive client show --json block: {count, overdueCount, totals[],
 * nextDueAt, protectedExcluded}. Counts only unsettled receivables.
 */
export function clientReceivablesBlock(store, clientId, options = {}) {
  const summary = receivablesSummary(store, { ...(options ?? {}), clientId })
  return {
    count: summary.unsettled,
    overdueCount: summary.overdue,
    totals: summary.totals,
    nextDueAt: summary.nextDueAt,
    protectedExcluded: summary.protectedExcluded,
  }
}

/**
 * One receivable with every payment row (voided payments included and marked),
 * all in one read snapshot. Rows above the clearance fail closed with
 * E_RECEIVABLE_NOT_FOUND instead of leaking an id.
 */
export function receivableShow(store, id, options = {}) {
  assertStore(store)
  const receivableId = parseId(id, 'receivable id')
  const now = nowIso(options?.now)
  const clearance = normalizeClearance(options?.clearance)
  return store.read(() => {
    const row = selectReceivableRow(store, receivableId)
    if (!row) throw entityError('E_RECEIVABLE_NOT_FOUND', 'unknown receivable: ' + receivableId, 'advisers receivable ls')
    const payments = activePaymentsForCommitments(store, [row.commitment_id], { includeVoided: true })
    const active = payments.filter((payment) => payment.deleted_at === null)
    const aggregate = paymentAggregatesByCommitment(active).get(row.commitment_id + AGG_KEY_SEP + row.currency) ?? null
    const projection = receivableRowProjection(row, aggregate, { nowMs: Date.parse(now), clearance })
    if (projection.hidden) throw entityError('E_RECEIVABLE_NOT_FOUND', 'unknown receivable: ' + receivableId, 'advisers receivable ls')
    return {
      ok: true,
      command: 'receivable show',
      receivable: projection.receivable,
      payments: payments.map(paymentFromDb),
      clearance,
      protectedExcluded: 0,
    }
  })
}

/**
 * Page of payment rows (active only), optionally scoped to one client or one
 * receivable. Clearance mirrors the linked receivable/matter.
 */
export function paymentList(store, options = {}) {
  assertStore(store)
  const now = nowIso(options?.now)
  const nowMs = Date.parse(now)
  const clearance = normalizeClearance(options?.clearance)
  const limit = normalizeLimit(options?.limit, PAYMENT_LIST_LIMIT, PAYMENT_LIST_LIMIT_MAX)
  const clientValue = pickOption(options, ['clientId', 'client'])
  const clientId = clientValue === undefined ? null : String(clientValue).trim()
  const receivableValue = pickOption(options, ['receivableId', 'receivable'])
  const receivableId = receivableValue === undefined ? null : String(receivableValue).trim()
  const sinceMs = normalizeSince(pickOption(options, ['since']), nowMs)
  return store.read(() => {
    let commitmentId = null
    if (receivableId) {
      const receivable = store.db.prepare('SELECT * FROM receivables WHERE id = ?').get(receivableId)
      if (!receivable) throw entityError('E_RECEIVABLE_NOT_FOUND', 'unknown receivable: ' + receivableId, 'advisers receivable ls')
      commitmentId = receivable.commitment_id
    }
    const rows = selectPayments(store, { clientId, commitmentIds: commitmentId ? [commitmentId] : null })
      .filter((payment) => payment.deleted_at === null)
    const receivablesByCommitment = new Map()
    const commitmentIds = [...new Set(rows.map((row) => row.commitment_id).filter(Boolean))]
    if (commitmentIds.length) {
      const placeholders = commitmentIds.map(() => '?').join(',')
      for (const row of store.db.prepare('SELECT * FROM receivables WHERE commitment_id IN (' + placeholders + ')').all(...commitmentIds)) {
        receivablesByCommitment.set(row.commitment_id, row)
      }
    }
    const visible = []
    let protectedExcluded = 0
    for (const payment of rows) {
      if (sinceMs !== null) {
        const paidMs = instantOf(payment.paid_at)
        if (paidMs === null || paidMs < sinceMs) continue
      }
      const receivable = payment.commitment_id ? receivablesByCommitment.get(payment.commitment_id) ?? null : null
      const clientRow = store.db.prepare('SELECT * FROM clients WHERE id = ?').get(payment.client_id)
      if (!clientRow) { protectedExcluded += 1; continue }
      let secrecy = Number(clientRow.secrecy_default ?? 0)
      if (receivable && receivable.matter_id) {
        const matter = store.getMatter(receivable.matter_id)
        if (!matter) { protectedExcluded += 1; continue }
        secrecy = Math.max(secrecy, Number(matter.secrecy ?? 0))
      }
      if (!Number.isFinite(secrecy) || secrecy > clearance) { protectedExcluded += 1; continue }
      visible.push({ payment, receivable })
    }
    visible.sort((left, right) => {
      const leftMs = instantOf(left.payment.paid_at) ?? 0
      const rightMs = instantOf(right.payment.paid_at) ?? 0
      if (leftMs !== rightMs) return rightMs - leftMs
      if (left.payment.created_at !== right.payment.created_at) return left.payment.created_at < right.payment.created_at ? 1 : -1
      return left.payment.id < right.payment.id ? -1 : 1
    })
    const page = visible.slice(0, limit).map(({ payment, receivable }) => ({
      ...paymentFromDb(payment),
      ...(receivable ? { receivableId: receivable.id } : {}),
    }))
    return {
      ok: true,
      command: 'payment ls',
      payments: page,
      total: visible.length,
      truncated: visible.length > page.length,
      limit,
      clearance,
      protectedExcluded,
    }
  })
}

/* -------------------------------------------------------------------------- */
/* integration helpers (bin wiring / merge / archive preconditions)           */
/* -------------------------------------------------------------------------- */

/**
 * Active row counts for status --json (additive keys). Voided tombstones are
 * excluded; a settled receivable/payment still counts as an existing row.
 */
export function moneyTableCounts(store) {
  assertStore(store)
  const receivables = Number(store.db.prepare('SELECT COUNT(*) AS n FROM receivables WHERE deleted_at IS NULL').get()?.n ?? 0)
  const payments = Number(store.db.prepare('SELECT COUNT(*) AS n FROM payments WHERE deleted_at IS NULL').get()?.n ?? 0)
  return { receivables, payments }
}

/**
 * Number of unsettled (outstanding > 0, not written off, not void) receivables
 * for one client. client archive uses this to fail closed with
 * E_CLIENT_HAS_OPEN_RECEIVABLES before archiving.
 */
export function openReceivablesCount(store, clientId, options = {}) {
  assertStore(store)
  const id = parseId(clientId, 'clientId')
  const collected = collectReceivables(store, { ...(options ?? {}), clientId: id, clearance: DEFAULT_CLEARANCE, status: 'unsettled' })
  return collected.rows.length
}

/**
 * Re-point a merged client's money rows at the merge target. Call INSIDE the
 * merge transaction AFTER matters/projects were re-pointed: the receivable's
 * project_id is re-derived from its (already moved) matter, so a merged project
 * and a re-linked matter stay consistent. Returns the moved row counts used in
 * the merge JSON summary.
 */
export function moveClientMoneyRows(store, fromId, intoId, options = {}) {
  assertStore(store)
  const from = parseId(fromId, 'from client id')
  const into = parseId(intoId, 'into client id')
  if (from === into) throw entityError('E_CLIENT_MERGE_SELF', 'cannot merge a client into itself')
  if (!store.getClient(from)) throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + from, 'advisers client list')
  if (!store.getClient(into)) throw entityError('E_CLIENT_NOT_FOUND', 'unknown client: ' + into, 'advisers client list')
  const now = nowIso(options.now)
  const movedReceivables = Number(store.db.prepare('UPDATE receivables SET client_id = ?, project_id = (SELECT project_id FROM matters WHERE matters.id = receivables.matter_id), updated_at = ? WHERE client_id = ?').run(into, now, from).changes)
  const movedPayments = Number(store.db.prepare('UPDATE payments SET client_id = ?, updated_at = ? WHERE client_id = ?').run(into, now, from).changes)
  return { movedReceivables, movedPayments }
}

export default Object.freeze({
  CURRENCIES,
  DEFAULT_CURRENCY,
  MAX_AMOUNT_MINOR,
  RECEIVABLE_KINDS,
  PAYMENT_METHODS,
  RECEIVABLE_STATES,
  DEFAULT_CLEARANCE,
  RECEIVABLE_LIST_LIMIT,
  RECEIVABLE_LIST_LIMIT_MAX,
  PAYMENT_LIST_LIMIT,
  PAYMENT_LIST_LIMIT_MAX,
  RECEIVABLE_MATTER_TITLE,
  parseAmountToMinor,
  formatMinorAmount,
  parseCurrency,
  receivableDueInstant,
  receivableAdd,
  receivableEdit,
  receivableVoid,
  receivableList,
  receivableShow,
  receivablesSummary,
  clientReceivablesBlock,
  paymentAdd,
  paymentList,
  paymentVoid,
  moneyTableCounts,
  openReceivablesCount,
  moveClientMoneyRows,
})
