/**
 * Receivable CSV export (0.4.3; implementation spec 93 section 5).
 *
 * "Export, do not take over": this module turns the receivable read model into
 * an RFC 4180 CSV that an accountant can import. It writes no file, opens no
 * network, prints no amount by itself and never generates invoices, statements
 * or totals. Timestamps are rendered as Asia/Shanghai dates (YYYY-MM-DD) and
 * amounts use the preformatted decimal strings from the read model, so a given
 * snapshot + now exports byte-for-byte the same CSV twice.
 *
 * Format (csvVersion 1, profile "generic"):
 *   receivable_id,client_name,date,label,currency,amount,paid,outstanding,
 *   due_at,state,overdue_days,kind,quote_no,delivery_id,commitment_id,memo
 *
 *  - CRLF records, RFC 4180 quoting (comma / quote / newline), UTF-8 and no
 *    BOM by default; `bom: true` prepends U+FEFF for spreadsheet apps;
 *  - no totals row and no cross-currency total (amounts stay per row);
 *  - deterministic order: overdue first, then due date ascending (no due date
 *    last), then createdAt descending, then id (mirrors
 *    compareReceivableRows in lib/receivables.js);
 *  - spreadsheet formula injection is neutralised with a leading apostrophe
 *    when a text cell starts with `=`, `+`, `-`, `@`, TAB or CR;
 *  - `date` is the receivable's creation date in Asia/Shanghai; `due_at` is the
 *    stored due date (date-only kept, instants converted to +08:00 date). The
 *    spec's explicit column list (93:70) omits `date`, while its accounting
 *    mapping requires a 日期 -> InvoiceDate column, so this csvVersion keeps
 *    `date` (an additive superset from day one);
 *  - `quote_no` is only read through the receivable's `delivery_id` ->
 *    deliveries.quote_no link, never guessed; NULL/missing is an empty cell.
 *
 * The caller (bin) owns the explicit `--out` path, atomic 0600 writes,
 * stdout (`--out -`), audit rows and the "not an invoice/statement" wording.
 * Column profiles for Wave/Xero/FreshBooks are deliberately not implemented
 * until their official import templates are verified (93:70).
 *
 * @module receivable-csv
 */

import { receivableList } from './receivables.js'

/** Version of the emitted column layout (bump on any column change). */
export const CSV_VERSION = 1

/** The only column profile implemented so far. */
export const CSV_PROFILE = 'generic'

/** Generic-profile columns in output order. */
export const GENERIC_COLUMNS = Object.freeze([
  'receivable_id',
  'client_name',
  'date',
  'label',
  'currency',
  'amount',
  'paid',
  'outstanding',
  'due_at',
  'state',
  'overdue_days',
  'kind',
  'quote_no',
  'delivery_id',
  'commitment_id',
  'memo',
])

/** Default row cap per export call (receivableList's hard maximum). */
const DEFAULT_EXPORT_LIMIT = 500
const SHANGHAI_OFFSET_MS = 8 * 3600_000
const DAY_MS = 86_400_000
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/
// Leading characters a spreadsheet may treat as a formula. Tab/CR are included
// because some spreadsheet versions strip them before evaluating the rest.
const FORMULA_PREFIX = /^[=+\-@\t\r]/

function csvError(message, hint) {
  const error = new Error(message)
  error.code = 'E_RECEIVABLE_INVALID'
  if (hint) error.hint = hint
  return error
}

function profileOf(options) {
  const profile = options.profile ?? CSV_PROFILE
  if (profile !== CSV_PROFILE) {
    throw csvError('receivable CSV profile must be "' + CSV_PROFILE + '"; official accounting-system templates are not verified yet', 'omit --profile or pass --profile generic')
  }
  return profile
}

function boundsOf(options) {
  if (options.limit === undefined || options.limit === null || options.limit === '') return DEFAULT_EXPORT_LIMIT
  const limit = Number(options.limit)
  if (!Number.isFinite(limit) || limit < 1) throw csvError('export limit must be a positive integer')
  return Math.min(DEFAULT_EXPORT_LIMIT, Math.trunc(limit))
}

/* ----------------------------- date rendering ----------------------------- */

/** Stored due instant, mirroring receivableDueInstant() (date-only = day end). */
function dueMsOf(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  if (DATE_ONLY.test(text)) {
    const parts = text.split('-').map(Number)
    if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[2] > 31) return null
    const ms = Date.UTC(parts[0], parts[1] - 1, parts[2]) - SHANGHAI_OFFSET_MS + DAY_MS - 1
    return Number.isFinite(ms) ? ms : null
  }
  if (LOCAL_DATE_TIME.test(text)) {
    const normalized = text.replace(' ', 'T')
    const withSeconds = normalized.length >= 19 ? normalized : normalized + ':00'
    const withMs = withSeconds.includes('.') ? withSeconds : withSeconds + '.000'
    const ms = Date.parse(withMs + '+08:00')
    return Number.isFinite(ms) ? ms : null
  }
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/** A stored date/instant rendered as an Asia/Shanghai calendar date. */
function toShanghaiDate(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text) return ''
  if (DATE_ONLY.test(text)) return text
  if (LOCAL_DATE_TIME.test(text)) return text.slice(0, 10)
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) return ''
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

/* ----------------------------- row rendering ------------------------------ */

/** Deterministic row order: overdue, due ascending, createdAt desc, id. */
function compareRows(left, right) {
  const leftOverdue = left.state === 'overdue' ? 0 : 1
  const rightOverdue = right.state === 'overdue' ? 0 : 1
  if (leftOverdue !== rightOverdue) return leftOverdue - rightOverdue
  const leftDue = dueMsOf(left.dueAt)
  const rightDue = dueMsOf(right.dueAt)
  if (leftDue !== rightDue) {
    if (leftDue === null) return 1
    if (rightDue === null) return -1
    return leftDue - rightDue
  }
  const leftCreated = typeof left.createdAt === 'string' ? left.createdAt : ''
  const rightCreated = typeof right.createdAt === 'string' ? right.createdAt : ''
  if (leftCreated !== rightCreated) return leftCreated < rightCreated ? 1 : -1
  const leftId = String(left.id ?? '')
  const rightId = String(right.id ?? '')
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

/** Fallback formatting for callers that pass minor units instead of strings. */
function formatMinor(minor) {
  const value = BigInt(Math.trunc(Number(minor)))
  const negative = value < 0n
  const absolute = negative ? -value : value
  return (negative ? '-' : '') + (absolute / 100n).toString() + '.' + (absolute % 100n).toString().padStart(2, '0')
}

function moneyCell(row, field) {
  const text = row[field]
  if (typeof text === 'string' && text !== '') return text
  const minor = row[field + 'Minor']
  if (typeof minor === 'number' && Number.isFinite(minor)) return formatMinor(minor)
  return ''
}

function textCell(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

function cellOf(row, column, quoteNoByDeliveryId) {
  switch (column) {
    case 'receivable_id': return textCell(row.id)
    case 'client_name': return textCell(row.clientName)
    case 'date': return toShanghaiDate(row.createdAt)
    case 'label': return textCell(row.label)
    case 'currency': return textCell(row.currency)
    case 'amount': return moneyCell(row, 'amount')
    case 'paid': return moneyCell(row, 'paid')
    case 'outstanding': return moneyCell(row, 'outstanding')
    case 'due_at': return toShanghaiDate(row.dueAt)
    case 'state': return textCell(row.state)
    case 'overdue_days': return row.overdueDays === undefined || row.overdueDays === null ? '' : textCell(row.overdueDays)
    case 'kind': return textCell(row.kind)
    case 'quote_no': {
      const direct = row.quoteNo
      if (typeof direct === 'string' && direct !== '') return direct
      const linked = row.deliveryId && quoteNoByDeliveryId ? quoteNoByDeliveryId.get(row.deliveryId) : undefined
      return typeof linked === 'string' ? linked : ''
    }
    case 'delivery_id': return textCell(row.deliveryId)
    case 'commitment_id': return textCell(row.commitmentId)
    case 'memo': return textCell(row.memo)
    default: return ''
  }
}

/** Neutralise a spreadsheet formula without changing ordinary values. */
function protectFormula(text) {
  if (!text) return text
  return FORMULA_PREFIX.test(text) ? "'" + text : text
}

/** RFC 4180 field: quote when it contains comma/quote/CR/LF, double the quotes. */
function csvField(text) {
  const guarded = protectFormula(text)
  if (/[",\r\n]/.test(guarded)) return '"' + guarded.split('"').join('""') + '"'
  return guarded
}

/* --------------------------------- API ----------------------------------- */

/**
 * Render receivable read-model rows as an RFC 4180 CSV.
 *
 * Pure: the input array/objects are not mutated, no file/network/clock access.
 * Rows are sorted deterministically (see compareRows) before rendering.
 *
 * @param {object[]} rows receivable rows from receivableList()
 * @param {{bom?: boolean, profile?: string, quoteNoByDeliveryId?: Map<string,string>}} [options]
 * @returns {{csv: string, bytes: number, columns: string[], rowCount: number,
 *            csvVersion: number, profile: string, bom: boolean}}
 */
export function buildReceivableCsv(rows, options = {}) {
  if (!Array.isArray(rows)) throw new TypeError('buildReceivableCsv requires an array of receivable rows')
  const profile = profileOf(options)
  const bom = options.bom === true
  const quoteNoByDeliveryId = options.quoteNoByDeliveryId instanceof Map ? options.quoteNoByDeliveryId : null
  const ordered = rows.slice().sort(compareRows)
  const lines = [GENERIC_COLUMNS.join(',')]
  for (const row of ordered) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('buildReceivableCsv rows must be objects')
    lines.push(GENERIC_COLUMNS.map((column) => csvField(cellOf(row, column, quoteNoByDeliveryId))).join(','))
  }
  const csv = (bom ? '\uFEFF' : '') + lines.join('\r\n') + '\r\n'
  return {
    csv: csv,
    bytes: Buffer.byteLength(csv, 'utf8'),
    columns: GENERIC_COLUMNS.slice(),
    rowCount: ordered.length,
    csvVersion: CSV_VERSION,
    profile: profile,
    bom: bom,
  }
}

/**
 * Collect the filtered receivables and return the CSV payload for bin to write.
 *
 * Clearance is applied first (rows above clearance are only counted, never
 * rendered: `protectedExcluded`), then the documented filters, then the
 * deterministic order. The export is unpaged by design: if more than
 * DEFAULT_EXPORT_LIMIT rows match, this throws E_RECEIVABLE_INVALID instead of
 * silently dropping rows (a partial accounting import is worse than an error).
 *
 * @param {object} store opened SqliteStore (JSON store has no money sidecars)
 * @param {object} [options] clientId/client, projectId/project, currency,
 *   status, dueWithin/due-within, clearance, now, bom, profile, limit
 * @returns {{ok: boolean, command: string, csvVersion: number, profile: string,
 *            bom: boolean, columns: string[], csv: string, bytes: number,
 *            rowCount: number, total: number, clearance: number,
 *            protectedExcluded: number}}
 */
export function exportReceivablesCsv(store, options = {}) {
  const profile = profileOf(options)
  const bom = options.bom === true
  const limit = boundsOf(options)
  const filters = {}
  for (const key of ['clientId', 'client', 'projectId', 'project', 'currency', 'status', 'dueWithin', 'due-within', 'clearance', 'now']) {
    if (options[key] !== undefined) filters[key] = options[key]
  }
  const list = receivableList(store, { ...filters, limit })
  if (list.truncated) {
    throw csvError(
      'receivable export matched more than ' + limit + ' rows; narrow the filter with --client/--project/--currency/--status/--due-within and export in batches',
      'a CSV is never silently truncated',
    )
  }
  const quoteNoByDeliveryId = new Map()
  const deliveryIds = [...new Set(list.receivables.map((row) => row.deliveryId).filter((id) => typeof id === 'string' && id)) ]
  if (deliveryIds.length) {
    store.read(() => {
      const placeholders = deliveryIds.map(() => '?').join(',')
      for (const row of store.db.prepare('SELECT id, quote_no FROM deliveries WHERE id IN (' + placeholders + ')').all(...deliveryIds)) {
        if (typeof row.quote_no === 'string' && row.quote_no !== '') quoteNoByDeliveryId.set(row.id, row.quote_no)
      }
    })
  }
  const built = buildReceivableCsv(list.receivables, { bom, profile, quoteNoByDeliveryId })
  return {
    ok: true,
    command: 'receivable export',
    csvVersion: built.csvVersion,
    profile: built.profile,
    bom: built.bom,
    columns: built.columns,
    csv: built.csv,
    bytes: built.bytes,
    rowCount: built.rowCount,
    total: list.total,
    clearance: list.clearance,
    protectedExcluded: list.protectedExcluded,
  }
}

export default Object.freeze({
  CSV_VERSION,
  CSV_PROFILE,
  GENERIC_COLUMNS,
  buildReceivableCsv,
  exportReceivablesCsv,
})
