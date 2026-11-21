/**
 * Proactive 0.4 — deterministic urgency v1.
 *
 * Pure module: no SQLite, no network, no filesystem, no model. When `now` is
 * injected the output is a pure function of (items, now, timezone): the same
 * input always produces byte-identical JSON. Scores are an explainable
 * ordering aid, never a priority verdict: `score` is exactly the sum of the
 * named `terms`, each term carries its own Chinese explanation, and `whyNow`
 * is the joined explanation (capped at 200 code points).
 *
 * The `max 3` rule lives only in human priority views (`selectTopUrgent`, default
 * MAX_HUMAN_TOP = 3). Urgency is derived at read time and never enters
 * `dataSha256` (that hash covers the source brief data only). Bump
 * MODEL_VERSION when any weight or threshold in this file changes.
 */

/** Frozen model version for the v1 term table. */
export const MODEL_VERSION = 1
/** Local-day reference used by every reminder/agenda view (no host-TZ reads). */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'
/** Human priority views show at most this many entries. */
export const MAX_HUMAN_TOP = 3
/** Score bands, low to critical (stable contract for callers). */
export const URGENCY_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical'])
/** Canonical term order (also the deterministic tie-break for topFactors). */
export const TERM_IDS = Object.freeze(['overdue', 'due_today', 'due_near', 'third', 'mine', 'remind_offsets', 'age', 'timed'])

const DAY_MS = 86400000
/** Asia/Shanghai has been UTC+8 without DST since 1991 (same constant as remind.js). */
const SHANGHAI_OFFSET_MS = 8 * 3600000
const MAX_WHY_NOW_CHARS = 200
const MAX_DAYS_LOOKAHEAD = 7

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/

const EXCLUDED_STATUSES = new Set(['done', 'dropped', 'snoozed'])
const TZ_DAY_FORMATTERS = new Map()
const TZ_PARTS_FORMATTERS = new Map()

const clampScore = (value) => Math.max(0, Math.min(100, value))

/**
 * Map a 0..100 score to its band. Exported so the CLI and tests agree with the
 * term table instead of duplicating thresholds.
 * @param {number} score
 * @returns {'low'|'medium'|'high'|'critical'}
 */
export function levelForScore(score) {
  const value = Number.isFinite(score) ? clampScore(score) : 0
  if (value < 25) return 'low'
  if (value < 50) return 'medium'
  if (value < 75) return 'high'
  return 'critical'
}

function resolveTimezone(timezone) {
  const text = timezone === undefined || timezone === null || timezone === '' ? DEFAULT_TIMEZONE : String(timezone).trim()
  if (!text) throw new RangeError('invalid timezone: empty value')
  if (text !== DEFAULT_TIMEZONE && !TZ_DAY_FORMATTERS.has(text)) {
    try {
      TZ_DAY_FORMATTERS.set(text, new Intl.DateTimeFormat('en-US', { timeZone: text, year: 'numeric', month: '2-digit', day: '2-digit' }))
      TZ_PARTS_FORMATTERS.set(text, new Intl.DateTimeFormat('en-US', {
        timeZone: text, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }))
    } catch {
      throw new RangeError('invalid timezone: ' + String(timezone))
    }
  }
  return text
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime())
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? null : new Date(ms)
}

function resolveNow(value) {
  if (value === undefined || value === null) return new Date()
  const date = toDate(value)
  if (!date) throw new RangeError('invalid now: ' + String(value))
  return date
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function dayString(year, month, day) {
  return String(year).padStart(4, '0') + '-' + pad2(month) + '-' + pad2(day)
}

function validCalendarDay(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

function localDayIndex(day) {
  const parts = String(day).split('-').map(Number)
  return Math.round(Date.UTC(parts[0], parts[1] - 1, parts[2]) / DAY_MS)
}

/** Local calendar day (YYYY-MM-DD) of an instant in `timezone`. */
export function localDayOfInstant(ms, timezone = DEFAULT_TIMEZONE) {
  const tz = resolveTimezone(timezone)
  if (tz === DEFAULT_TIMEZONE) {
    const wall = new Date(ms + SHANGHAI_OFFSET_MS)
    return dayString(wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate())
  }
  const parts = TZ_DAY_FORMATTERS.get(tz).formatToParts(new Date(ms))
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return dayString(pick('year'), pick('month'), pick('day'))
}

function zoneOffsetMs(instantMs, timezone) {
  if (timezone === DEFAULT_TIMEZONE) return SHANGHAI_OFFSET_MS
  const parts = TZ_PARTS_FORMATTERS.get(timezone).formatToParts(new Date(instantMs))
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const wholeSecond = Math.floor(instantMs / 1000) * 1000
  return Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second')) - wholeSecond
}

/** Convert a wall-clock reading in `timezone` to an absolute instant (ms). */
function zonedWallMs(year, month, day, hour, minute, second, millisecond, timezone) {
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  if (!Number.isFinite(wallUtc)) return null
  if (timezone === DEFAULT_TIMEZONE) return wallUtc - SHANGHAI_OFFSET_MS
  let instant = wallUtc
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = wallUtc - zoneOffsetMs(instant, timezone)
    if (next === instant) break
    instant = next
  }
  return instant
}

function parseClock(match) {
  const [, year, month, day, hour, minute, second = '0', fraction = '0'] = match
  const y = Number(year)
  const mo = Number(month)
  const d = Number(day)
  const h = Number(hour)
  const mi = Number(minute)
  const s = Number(second)
  const ms = Number(fraction.padEnd(3, '0'))
  if (!validCalendarDay(y, mo, d)) return null
  if (h > 23 || mi > 59 || s > 59) return null
  return { y, mo, d, h, mi, s, ms }
}

/**
 * Resolve a due value to an absolute instant. Mirrors the agenda view:
 * - `YYYY-MM-DD` means end of that local day (23:59:59.999);
 * - an ISO/wall-clock string without a zone is read in `timezone`;
 * - a value with a zone is its absolute instant.
 * Returns `{ ms, dateOnly }` or null for dirty data (never throws).
 */
export function parseDueValue(value, timezone = DEFAULT_TIMEZONE) {
  const tz = resolveTimezone(timezone)
  if (value instanceof Date || typeof value === 'number') {
    const date = toDate(value)
    return date ? { ms: date.getTime(), dateOnly: false } : null
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const dateOnly = DATE_ONLY_RE.exec(text)
  if (dateOnly) {
    const clock = parseClock(['', dateOnly[1], dateOnly[2], dateOnly[3], '00', '00'])
    if (!clock) return null
    const ms = zonedWallMs(clock.y, clock.mo, clock.d, 23, 59, 59, 999, tz)
    return Number.isFinite(ms) ? { ms, dateOnly: true } : null
  }
  const wallClock = LOCAL_DATE_TIME_RE.exec(text)
  if (wallClock) {
    const clock = parseClock(wallClock)
    if (!clock) return null
    const ms = zonedWallMs(clock.y, clock.mo, clock.d, clock.h, clock.mi, clock.s, clock.ms, tz)
    return Number.isFinite(ms) ? { ms, dateOnly: false } : null
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? { ms: parsed, dateOnly: false } : null
}

function term(id, contribution, explain) {
  return { id, contribution, explain }
}

/**
 * Keep `whyNow` deterministic and bounded: join explanations, then cap at 200
 * Unicode code points (never split a surrogate pair).
 *
 * @param {Array<{explain?: string}>|{terms?: Array<{explain?: string}>}} terms
 * @returns {string}
 */
export function describeWhyNow(terms) {
  const list = Array.isArray(terms) ? terms : (terms && Array.isArray(terms.terms) ? terms.terms : [])
  const text = list
    .filter((entry) => entry && typeof entry.explain === 'string' && entry.explain)
    .map((entry) => entry.explain)
    .join(' · ')
  return Array.from(text).slice(0, MAX_WHY_NOW_CHARS).join('')
}

function neutralScore({ id = null, excluded = false, degraded = null } = {}) {
  return {
    id,
    modelVersion: MODEL_VERSION,
    score: 0,
    level: 'low',
    terms: [],
    topFactors: [],
    whyNow: '',
    dueAt: null,
    excluded,
    degraded,
  }
}

function normalizeItem(item, timezone, records) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const rawId = item.id ?? item.commitmentId ?? null
  const id = rawId === null || rawId === undefined ? null : String(rawId)
  // Derived views (agenda/morning items) drop ledger-only fields; an optional
  // `records` lookup restores debtor/createdAt/offsets without changing the
  // item's JSON shape. Item-level fields always win.
  const record = lookupRecord(records, id)
  const status = typeof item.status === 'string' ? item.status : (typeof record?.status === 'string' ? record.status : null)
  const dueValue = item.at ?? item.dueAt ?? item.due ?? record?.dueAt ?? null
  const due = parseDueValue(dueValue, timezone)
  const forcedAllDay = item.allDay === true ? true : item.allDay === false ? false : null
  const dateOnly = forcedAllDay === null ? Boolean(due && due.dateOnly) : forcedAllDay
  const debtor = typeof item.debtor === 'string'
    ? item.debtor
    : (item.meta && typeof item.meta.debtor === 'string'
      ? item.meta.debtor
      : (typeof record?.debtor === 'string' ? record.debtor : null))
  const rawCreatedAt = item.createdAt ?? item.created_at ?? item.created ?? record?.createdAt ?? record?.created_at ?? null
  const createdAt = parseDueValue(rawCreatedAt, timezone)
  const offsets = Array.isArray(item.reminderOffsets)
    ? item.reminderOffsets
    : Array.isArray(item.reminder_offsets)
      ? item.reminder_offsets
      : (Array.isArray(record?.reminderOffsets) ? record.reminderOffsets : [])
  return {
    id,
    status,
    due,
    dateOnly,
    debtor,
    createdAt,
    reminderOffsetsCount: offsets.length,
  }
}

function scoreNormalized(normalized, context) {
  if (!normalized) return neutralScore({ degraded: 'urgency_failed' })
  if (EXCLUDED_STATUSES.has(normalized.status)) return neutralScore({ id: normalized.id, excluded: true })
  if (!normalized.due) return neutralScore({ id: normalized.id, degraded: 'urgency_failed' })
  const { timezone, nowMs, todayIndex } = context
  const dueMs = normalized.due.ms
  const dueDay = localDayOfInstant(dueMs, timezone)
  const dueIndex = localDayIndex(dueDay)
  const dayOffset = dueIndex - todayIndex
  const terms = []
  if (dueMs < nowMs) {
    const overdueDays = Math.max(0, todayIndex - dueIndex)
    terms.push(term('overdue', Math.min(50, 30 + 2 * overdueDays), overdueDays > 0 ? '逾期 ' + overdueDays + ' 天' : '今天已到期'))
  } else if (dayOffset === 0) {
    terms.push(term('due_today', 30, '今天到期'))
  } else if (dayOffset >= 1 && dayOffset <= MAX_DAYS_LOOKAHEAD) {
    terms.push(term('due_near', Math.max(0, Math.min(21, 24 - 3 * dayOffset)), dayOffset + ' 天后到期'))
  }
  if (normalized.debtor === 'third' || normalized.debtor?.startsWith('third:')) {
    terms.push(term('third', 10, '可向对方催办'))
  } else if (normalized.debtor === 'user' || normalized.debtor === 'agent') {
    terms.push(term('mine', 6, '你答应对方'))
  }
  if (normalized.reminderOffsetsCount > 0) {
    terms.push(term('remind_offsets', Math.min(6, 2 * normalized.reminderOffsetsCount), '已设置 ' + normalized.reminderOffsetsCount + ' 个提醒'))
  }
  if (normalized.createdAt) {
    const createdIndex = localDayIndex(localDayOfInstant(normalized.createdAt.ms, timezone))
    const ageDays = Math.max(0, todayIndex - createdIndex)
    if (ageDays > 14) terms.push(term('age', Math.min(6, 1 + Math.floor((ageDays - 14) / 7)), '承诺已创建 ' + ageDays + ' 天'))
  }
  if (!normalized.dateOnly) terms.push(term('timed', 2, '有具体时刻'))
  const rawScore = terms.reduce((sum, entry) => sum + entry.contribution, 0)
  const score = clampScore(rawScore)
  const topFactors = terms
    .slice()
    .sort((left, right) => right.contribution - left.contribution || TERM_IDS.indexOf(left.id) - TERM_IDS.indexOf(right.id))
    .map((entry) => entry.id)
  return {
    id: normalized.id,
    modelVersion: MODEL_VERSION,
    score,
    level: levelForScore(score),
    terms,
    topFactors,
    whyNow: describeWhyNow(terms),
    dueAt: new Date(dueMs).toISOString(),
    excluded: false,
    degraded: null,
  }
}

function normalizeRecords(records) {
  if (records === undefined || records === null) return null
  if (records instanceof Map || typeof records === 'function') return records
  if (typeof records === 'object' && !Array.isArray(records)) return records
  throw new TypeError('records must be a Map, an object keyed by id, or a function')
}

function lookupRecord(records, id) {
  if (!records || id === null || id === undefined) return null
  const key = String(id)
  let record = null
  if (records instanceof Map) record = records.get(key) ?? records.get(id) ?? null
  else if (typeof records === 'function') record = records(key) ?? records(id) ?? null
  else record = records[key] ?? null
  return record && typeof record === 'object' && !Array.isArray(record) ? record : null
}

function buildContext({ now, timezone, records } = {}) {
  const nowDate = resolveNow(now)
  const tz = resolveTimezone(timezone)
  const nowMs = nowDate.getTime()
  const today = localDayOfInstant(nowMs, tz)
  return { now: nowDate, nowMs, timezone: tz, today, todayIndex: localDayIndex(today), records: normalizeRecords(records) }
}

/**
 * Score one item (an agenda commitment item, a reminder row, or a raw
 * commitment). Never throws for dirty data: an unparseable/missing due date
 * returns a zero score with `degraded: 'urgency_failed'` instead.
 *
 * @param {object} item
 * @param {{now?: Date|string|number, timezone?: string,
 *   records?: Map<string, object>|object|Function}} [options] Optional
 *   ledger-record lookup used to fill debtor/createdAt/reminderOffsets for
 *   derived views (agenda/morning items) that do not carry those fields.
 * @returns {{ id: string|null, modelVersion: number, score: number,
 *   level: 'low'|'medium'|'high'|'critical',
 *   terms: Array<{id: string, contribution: number, explain: string}>,
 *   topFactors: string[], whyNow: string, dueAt: string|null,
 *   excluded: boolean, degraded: null|'urgency_failed' }}
 */
export function scoreUrgency(item, options = {}) {
  const context = buildContext(options)
  return scoreNormalized(normalizeItem(item, context.timezone, context.records), context)
}

/**
 * Compute urgency for a list of items. The result is 1:1 with `items` (same
 * order and length), so callers can zip it back without matching ids.
 *
 * @param {{items: Array<object>, now?: Date|string|number, timezone?: string,
 *   records?: Map<string, object>|object|Function}} options
 * @returns {Array<object>} one score object per input item
 */
export function computeUrgency(options = {}) {
  const opts = options ?? {}
  if (!Array.isArray(opts.items)) throw new TypeError('computeUrgency requires items[]')
  const context = buildContext(opts)
  return opts.items.map((item) => scoreNormalized(normalizeItem(item, context.timezone, context.records), context))
}

/**
 * Return copies of `items` with an additive `urgency` field attached. The
 * input array/objects are never mutated.
 *
 * @param {Array<object>} items
 * @param {{now?: Date|string|number, timezone?: string,
 *   records?: Map<string, object>|object|Function}} [options]
 * @returns {Array<object>}
 */
export function attachUrgency(items, options = {}) {
  if (!Array.isArray(items)) throw new TypeError('attachUrgency requires items[]')
  const scores = computeUrgency({ ...(options ?? {}), items })
  return items.map((item, index) => ({
    ...(item && typeof item === 'object' && !Array.isArray(item) ? item : {}),
    urgency: scores[index],
  }))
}

function compareNullable(left, right) {
  if (left === right) return 0
  if (left === null || left === undefined) return 1
  if (right === null || right === undefined) return -1
  return left < right ? -1 : 1
}

/**
 * Human priority view: at most `limit` entries, ordered score desc -> dueAt
 * asc -> id asc. Accepts entries whose `urgency` was attached by
 * {@link attachUrgency} (or bare score objects). Shallow copies are returned;
 * `excluded` scores are skipped. This is a presentation helper only — it never
 * changes hashes, ledgers or payloads.
 *
 * @param {Array<object>} items
 * @param {{limit?: number}} [options]
 * @returns {Array<object>}
 */
export function selectTopUrgent(items, options = {}) {
  if (!Array.isArray(items)) throw new TypeError('selectTopUrgent requires items[]')
  const limit = options?.limit ?? MAX_HUMAN_TOP
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
  const ranked = []
  items.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const urgency = item.urgency && typeof item.urgency === 'object'
      ? item.urgency
      : (item.modelVersion !== undefined && item.score !== undefined ? item : null)
    if (!urgency || urgency.excluded === true) return
    ranked.push({
      index,
      item,
      score: Number.isFinite(urgency.score) ? urgency.score : 0,
      dueAt: typeof urgency.dueAt === 'string' ? urgency.dueAt : null,
      id: urgency.id == null ? null : String(urgency.id),
    })
  })
  ranked.sort((left, right) =>
    right.score - left.score ||
    compareNullable(left.dueAt, right.dueAt) ||
    compareNullable(left.id, right.id) ||
    left.index - right.index,
  )
  return ranked.slice(0, limit).map((entry) => ({ ...entry.item }))
}

/**
 * Additive `remind --json` payload helper for the CLI integration: keeps the
 * existing `now`/`reminders` keys and adds `ok`/`command`/`timezone` plus the
 * optional per-row `urgency`. `now` is echoed from the injected instant so a
 * fixed `--now` run is byte-reproducible.
 *
 * @param {Array<object>} reminders output of buildReminders()
 * @param {{now?: Date|string|number, timezone?: string, includeUrgency?: boolean,
 *   records?: Map<string, object>|object|Function}} [options]
 * @returns {{ok: true, command: 'remind', now: string, timezone: string, reminders: Array<object>}}
 */
export function buildRemindPayload(reminders, options = {}) {
  if (!Array.isArray(reminders)) throw new TypeError('buildRemindPayload requires reminders[]')
  const opts = options ?? {}
  const nowDate = resolveNow(opts.now)
  const timezone = resolveTimezone(opts.timezone)
  const decorated = opts.includeUrgency === false
    ? reminders.map((reminder) => ({ ...reminder }))
    : attachUrgency(reminders, { now: nowDate, timezone, records: opts.records })
  return {
    ok: true,
    command: 'remind',
    now: nowDate.toISOString(),
    timezone,
    reminders: decorated,
  }
}
