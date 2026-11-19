/**
 * E1 — reminder planning and ICS export.
 *
 * Pure helpers: no SQLite, no network, no filesystem and no process state.
 * All wall-clock reasoning is pinned to Asia/Shanghai, and `now` is injectable
 * so tests (and a future CLI wiring) can replay an exact instant.
 *
 * The caller decides how reminders are delivered; this module only answers
 * "which reminders are due at `now`" and "what does the calendar look like".
 */

const DAY_MS = 86_400_000
/** Asia/Shanghai has been UTC+8 without DST since 1991. */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export const TIME_ZONE = 'Asia/Shanghai'
export const DEFAULT_HORIZON_DAYS = 7

const BUCKETS = new Set(['overdue', 'due-today', 'due-1d', 'upcoming'])
const LEVELS = new Set(['L1', 'L2', 'L3'])

const TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/
const COMPACT_DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/

/** Parse `YYYY-MM-DD HH:mm[:ss]` as Asia/Shanghai wall time. */
function parseWallClock(match) {
  const [, y, mo, d, h = '0', mi = '0', s = '0', fraction] = match
  return buildDate(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s), Number((fraction ?? '0').padEnd(3, '0')), SHANGHAI_OFFSET_MS)
}

/** Parse an RFC5545 compact date-time (`YYYYMMDDTHHMMSS[Z]`) as UTC or Shanghai wall time. */
function parseCompact(match) {
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = match
  return buildDate(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s), 0, z ? 0 : SHANGHAI_OFFSET_MS)
}

function buildDate(year, month, day, hour, minute, second, millisecond, offsetMs) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetMs)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Convert a Date, epoch milliseconds, ISO string, or ICS compact date into a
 * Date. Values without a zone are treated as Asia/Shanghai wall time so the
 * result never depends on the host timezone.
 */
function toDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime())
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value) : null
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const wallClock = LOCAL_DATE_TIME.exec(text)
  if (wallClock) return parseWallClock(wallClock)
  const compact = COMPACT_DATE_TIME.exec(text)
  if (compact) return parseCompact(compact)
  const epoch = Date.parse(text)
  return Number.isNaN(epoch) ? null : new Date(epoch)
}

function requireDate(value, label) {
  const date = toDate(value)
  if (!date) throw new RangeError(`invalid ${label}: ${String(value)}`)
  return date
}

function requireNow(value) {
  if (value === undefined) return new Date()
  return requireDate(value, 'now')
}

/**
 * Local calendar day in Asia/Shanghai, as `YYYY-MM-DD`.
 *
 * 0.3.0 P0-T2: computed with UTC+8 arithmetic instead of
 * Intl.DateTimeFormat.formatToParts. Shanghai has been a fixed UTC+8 offset
 * without DST since 1991, so the two agree for every date the ledger stores;
 * the arithmetic form is ~20x faster, which matters because the reminder and
 * pet-brief views resolve one local day per due row (66k rows at a 200k
 * ledger).
 */
export function localDay(value) {
  const date = toDate(value)
  if (!date) return null
  return localDayOf(date)
}

/** Local calendar day string for an already-parsed instant. */
function localDayOf(date) {
  const wall = new Date(date.getTime() + SHANGHAI_OFFSET_MS)
  const year = wall.getUTCFullYear()
  const month = wall.getUTCMonth() + 1
  const day = wall.getUTCDate()
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Day-of-epoch number of the Asia/Shanghai calendar day for an instant. */
function localDayIndexFromMs(ms) {
  return Math.floor((ms + SHANGHAI_OFFSET_MS) / DAY_MS)
}

/** Minutes since local midnight in Asia/Shanghai (0–1439). */
export function localMinutesOfDay(value) {
  const date = toDate(value)
  if (!date) return null
  const parts = TIME_FORMAT.formatToParts(date)
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return (pick('hour') % 24) * 60 + pick('minute')
}

function localDayIndex(day) {
  const [year, month, date] = day.split('-').map(Number)
  return Math.round(Date.UTC(year, month - 1, date) / DAY_MS)
}

function formatLocalDateTime(date) {
  const wall = new Date(date.getTime() + SHANGHAI_OFFSET_MS)
  const pad = (value) => String(value).padStart(2, '0')
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())} ${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`
}

/** `YYYYMMDDTHHMMSSZ` — the canonical UTC form used by DTSTAMP/DTSTART. */
export function formatIcsDate(value) {
  const date = requireDate(value, 'date')
  const pad = (number, width = 2) => String(number).padStart(width, '0')
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  )
}

/**
 * Parse an ICS date-time value. Both `20261114T103000Z` (UTC) and
 * `20261114T183000` (floating, interpreted as Asia/Shanghai) are accepted, as
 * well as ISO-8601 strings and Date objects for convenience.
 */
export function parseIcsDate(value) {
  return requireDate(value, 'ICS date')
}

/** Escape a value for an iCalendar TEXT field (commas, semicolons, newlines). */
export function escapeIcsText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

const OFFSET_PATTERN = /^([+-])(\d+)([dhm])(?:(\d{1,2}):(\d{2}))?$/
const MAX_OFFSET_DAYS = 3650
const MAX_OFFSET_HOURS = MAX_OFFSET_DAYS * 24
const MAX_OFFSET_MINUTES = MAX_OFFSET_HOURS * 60

/** Upper bound on per-commitment alarms so a ledger row cannot flood a calendar. */
export const MAX_REMINDER_OFFSETS = 24

const pad2 = (value) => String(value).padStart(2, '0')

/**
 * Parse one custom reminder offset relative to the commitment due instant.
 *
 * Accepted grammar (Asia/Shanghai wall clock):
 *   - `-1d` / `+2d`        — whole local days, same clock time as `dueAt`
 *   - `-2h` / `+90m`       — hours or minutes relative to `dueAt`
 *   - `+0d09:00`            — 09:00 on the due day (day shift + wall-clock time)
 *   - `-1d08:30`            — 08:30 on the day before the due day
 *
 * The sign is mandatory. A time-of-day is only valid together with the `d`
 * unit, and a zero-day time-of-day offset is canonicalised to `+`.
 *
 * @returns {{ offset: string, sign: 1|-1, days: number, hours: number,
 *   minutes: number, timeOfDay: { hour: number, minute: number }|null, source: string }}
 */
export function parseReminderOffset(value) {
  if (typeof value !== 'string') throw new TypeError('reminder offset must be a string')
  const text = value.trim().toLowerCase()
  if (!text) throw new TypeError('reminder offset must not be empty')
  const match = OFFSET_PATTERN.exec(text)
  if (!match) throw new TypeError(`invalid reminder offset: ${String(value)}`)
  const [, rawSign, rawAmount, unit, rawHour, rawMinute] = match
  const amount = Number(rawAmount)
  if (!Number.isSafeInteger(amount)) throw new TypeError(`invalid reminder offset amount: ${String(value)}`)
  let days = 0
  let hours = 0
  let minutes = 0
  if (unit === 'd') {
    days = amount
    if (days > MAX_OFFSET_DAYS) throw new RangeError(`reminder offset too large: ${String(value)}`)
  } else if (unit === 'h') {
    hours = amount
    if (hours > MAX_OFFSET_HOURS) throw new RangeError(`reminder offset too large: ${String(value)}`)
  } else {
    minutes = amount
    if (minutes > MAX_OFFSET_MINUTES) throw new RangeError(`reminder offset too large: ${String(value)}`)
  }
  let timeOfDay = null
  if (rawHour !== undefined) {
    if (unit !== 'd') throw new TypeError(`time-of-day is only valid with a day offset: ${String(value)}`)
    const hour = Number(rawHour)
    const minute = Number(rawMinute)
    if (hour > 23 || minute > 59) throw new RangeError(`invalid reminder offset time: ${String(value)}`)
    timeOfDay = Object.freeze({ hour, minute })
  }
  const sign = rawSign === '-' ? -1 : 1
  const canonicalSign = timeOfDay && days === 0 ? '+' : rawSign
  const offset = timeOfDay
    ? `${canonicalSign}${days}d${pad2(timeOfDay.hour)}:${pad2(timeOfDay.minute)}`
    : unit === 'd'
      ? `${canonicalSign}${days}d`
      : unit === 'h'
        ? `${canonicalSign}${hours}h`
        : `${canonicalSign}${minutes}m`
  return Object.freeze({ offset, sign, days, hours, minutes, timeOfDay, source: String(value) })
}

/**
 * Strictly validate and canonicalise a list of offsets. Invalid input throws;
 * use {@link reminderAlarms} for the lenient rendering path.
 */
export function normalizeReminderOffsets(value) {
  if (value == null) return []
  if (!Array.isArray(value)) throw new TypeError('reminderOffsets must be an array of offset strings')
  if (value.length > MAX_REMINDER_OFFSETS) {
    throw new RangeError(`too many reminder offsets (max ${MAX_REMINDER_OFFSETS})`)
  }
  const seen = new Set()
  const normalized = []
  for (const entry of value) {
    const parsed = parseReminderOffset(entry)
    if (seen.has(parsed.offset)) continue
    seen.add(parsed.offset)
    normalized.push(parsed.offset)
  }
  return normalized
}

/** Lenient list reader used for rendering: skips invalid entries instead of throwing. */
function resolveReminderOffsets(value) {
  if (value == null) return []
  let items
  if (Array.isArray(value)) items = value
  else if (typeof value === 'string') items = value.split(',')
  else return []
  const seen = new Set()
  const resolved = []
  for (const item of items.slice(0, MAX_REMINDER_OFFSETS)) {
    try {
      const parsed = parseReminderOffset(item)
      if (seen.has(parsed.offset)) continue
      seen.add(parsed.offset)
      resolved.push(parsed.offset)
    } catch {
      // A single malformed ledger value must not suppress every reminder.
    }
  }
  return resolved
}

/** Shared empty result for the reminder-planning fast path (never mutated). */
const EMPTY_REMINDER_OFFSETS = Object.freeze([])

/** Human label used inside a VALARM DESCRIPTION. */
export function describeReminderOffset(value) {
  const parsed = parseReminderOffset(value)
  if (parsed.timeOfDay) {
    const time = `${pad2(parsed.timeOfDay.hour)}:${pad2(parsed.timeOfDay.minute)}`
    if (parsed.days === 0) return `当天 ${time}`
    return `${parsed.sign < 0 ? '提前' : '延后'} ${parsed.days} 天 ${time}`
  }
  if (parsed.days === 0 && parsed.hours === 0 && parsed.minutes === 0) return '到期时'
  const when = parsed.sign < 0 ? '提前' : '延后'
  if (parsed.days) return `${when} ${parsed.days} 天`
  if (parsed.hours) return `${when} ${parsed.hours} 小时`
  return `${when} ${parsed.minutes} 分钟`
}

/**
 * Absolute instant of one alarm: the due instant shifted by `offset`.
 * All wall-clock arithmetic uses Asia/Shanghai (UTC+8, no DST since 1991).
 */
export function reminderAlarmTime(dueAt, offset) {
  const due = requireDate(dueAt, 'due date')
  const parsed = parseReminderOffset(offset)
  if (parsed.timeOfDay) {
    const wall = new Date(due.getTime() + SHANGHAI_OFFSET_MS)
    const shifted = new Date(
      Date.UTC(
        wall.getUTCFullYear(),
        wall.getUTCMonth(),
        wall.getUTCDate() + parsed.sign * parsed.days,
        parsed.timeOfDay.hour,
        parsed.timeOfDay.minute,
        0,
        0,
      ),
    )
    const date = new Date(shifted.getTime() - SHANGHAI_OFFSET_MS)
    if (Number.isNaN(date.getTime())) throw new RangeError(`invalid reminder offset: ${String(offset)}`)
    return date
  }
  const deltaMs = parsed.sign * (parsed.days * 24 * 60 + parsed.hours * 60 + parsed.minutes) * 60_000
  const date = new Date(due.getTime() + deltaMs)
  if (Number.isNaN(date.getTime())) throw new RangeError(`invalid reminder offset: ${String(offset)}`)
  return date
}

/**
 * Build the VALARM instants for a due date. Duplicate instants collapse so the
 * same calendar reminder is never emitted twice; output is chronological.
 *
 * @returns {Array<{ offset: string, at: Date, label: string }>}
 */
export function reminderAlarms(dueAt, offsets) {
  const normalized = resolveReminderOffsets(offsets)
  const seen = new Set()
  const alarms = []
  for (const offset of normalized) {
    const at = reminderAlarmTime(dueAt, offset)
    const key = String(at.getTime())
    if (seen.has(key)) continue
    seen.add(key)
    alarms.push({ offset, at, label: describeReminderOffset(offset) })
  }
  return alarms.sort((left, right) => left.at.getTime() - right.at.getTime() || left.offset.localeCompare(right.offset))
}

function rule(id, description, test) {
  return Object.freeze({ id, description, test })
}

/**
 * Rule ids required by the E1 contract:
 *   due-1d, due-today-09, due-today-18, overdue-daily, snooze-wake.
 * `upcoming` is an additional advance rule so the `upcoming` bucket is
 * reachable; it is the only rule added on top of the required list.
 */
export const SNOOZE_WAKE_RULE = rule(
  'snooze-wake',
  'Fire once the stored snooze has expired.',
  (context) => context.snoozeExpired === true,
)

export const DEFAULT_RULES = Object.freeze([
  rule('due-1d', 'Remind one local day before the due date.', (context) => context.bucket === 'due-1d'),
  rule(
    'due-today-09',
    'Remind on the due day from 09:00 local time.',
    (context) => context.bucket === 'due-today' && context.minutesOfDay >= 9 * 60,
  ),
  rule(
    'due-today-18',
    'Remind on the due day from 18:00 local time.',
    (context) => context.bucket === 'due-today' && context.minutesOfDay >= 18 * 60,
  ),
  rule('overdue-daily', 'Remind every local day while the commitment is overdue.', (context) => context.bucket === 'overdue'),
  rule('upcoming', 'Advance reminder for commitments due later in the horizon.', (context) => context.bucket === 'upcoming'),
  SNOOZE_WAKE_RULE,
])

export const ALL_RULES = DEFAULT_RULES

const RULES_BY_ID = new Map(DEFAULT_RULES.map((entry) => [entry.id, entry]))

function resolveRule(candidate) {
  if (typeof candidate === 'string') {
    const known = RULES_BY_ID.get(candidate)
    if (!known) throw new TypeError(`unknown reminder rule: ${candidate}`)
    return known
  }
  if (!candidate || typeof candidate !== 'object' || typeof candidate.id !== 'string') {
    throw new TypeError('reminder rules must be rule ids or { id, test } objects')
  }
  return candidate
}

function evaluateRule(def, context) {
  let outcome
  if (typeof def.test === 'function') outcome = def.test(context)
  else if (typeof def.when === 'function') outcome = def.when(context)
  else {
    const known = RULES_BY_ID.get(def.id)
    outcome = known && typeof known.test === 'function' ? known.test(context) : false
  }
  if (!outcome) return null
  if (outcome === true) outcome = {}
  if (typeof outcome !== 'object') return null
  const bucket = outcome.bucket ?? def.bucket ?? context.bucket
  const level = outcome.level ?? def.level ?? context.level
  if (!BUCKETS.has(bucket)) throw new TypeError(`reminder rule ${def.id} produced unknown bucket: ${String(bucket)}`)
  if (!LEVELS.has(level)) throw new TypeError(`reminder rule ${def.id} produced unknown level: ${String(level)}`)
  return { bucket, level, ruleId: def.id }
}

function levelFor(bucket, due, now, allowL3) {
  if (bucket === 'overdue') {
    return allowL3 && now.getTime() - due.getTime() > DAY_MS ? 'L3' : 'L2'
  }
  if (bucket === 'due-today') return 'L2'
  return 'L1'
}

function bucketFor(dayOffset) {
  if (dayOffset < 0) return 'overdue'
  if (dayOffset === 0) return 'due-today'
  if (dayOffset === 1) return 'due-1d'
  return 'upcoming'
}

/** Read a snooze deadline from injected state first, then commitment fields. */
function readSnoozeUntil(commitment, options, ledger) {
  const sources = []
  const injected = options.snoozedUntil
  if (injected instanceof Map) {
    sources.push(injected.get(commitment.id))
  } else if (typeof injected === 'function') {
    sources.push(injected(commitment))
  } else if (injected && typeof injected === 'object') {
    sources.push(injected[commitment.id])
    sources.push(injected[`snooze:${commitment.id}`])
  }
  for (const key of ['snoozedUntil', 'snoozeUntil', 'snoozeAt']) sources.push(commitment[key])
  const meta = commitment.meta
  if (meta && typeof meta === 'object') {
    for (const key of ['snoozedUntil', 'snoozeUntil', `snooze:${commitment.id}`]) sources.push(meta[key])
    if (typeof meta.get === 'function') sources.push(meta.get(`snooze:${commitment.id}`))
  }
  // Optional duck-typed store hook; never required, never SQLite-specific.
  if (ledger && typeof ledger.getMeta === 'function') {
    try {
      sources.push(ledger.getMeta(`snooze:${commitment.id}`))
    } catch {
      // A read-only or closed store must not break planning.
    }
  }
  for (const source of sources) {
    if (source == null) continue
    const date = toDate(source)
    if (date) return date
  }
  return null
}

/**
 * Resolve reminder offsets for one commitment. Priority: injected per-id state
 * (Map/object/function, mirroring snoozes), the commitment field itself, any
 * commitment meta hook, a duck-typed ledger `getMeta`, then the caller's global
 * default. Invalid entries are skipped so one bad ledger row cannot hide every
 * reminder.
 */
function readReminderOffsets(commitment, options, ledger) {
  const meta = commitment.meta
  const injected = options.reminderOffsets
  const sources = []
  if (injected instanceof Map) {
    sources.push(injected.get(commitment.id))
    sources.push(injected.get(`reminderOffsets:${commitment.id}`))
  } else if (typeof injected === 'function') {
    sources.push(injected(commitment))
  } else if (injected && typeof injected === 'object') {
    sources.push(injected[commitment.id])
    sources.push(injected[`reminderOffsets:${commitment.id}`])
  }
  sources.push(commitment.reminderOffsets)
  if (meta && typeof meta === 'object') {
    sources.push(meta.reminderOffsets)
    sources.push(meta[`reminderOffsets:${commitment.id}`])
    if (typeof meta.get === 'function') sources.push(meta.get(`reminderOffsets:${commitment.id}`))
  }
  // Optional duck-typed store hook; never required, never SQLite-specific.
  if (ledger && typeof ledger.getMeta === 'function') {
    try {
      sources.push(ledger.getMeta(`reminderOffsets:${commitment.id}`))
    } catch {
      // A read-only or closed store must not break planning.
    }
  }
  for (const source of sources) {
    const resolved = resolveReminderOffsets(source)
    if (resolved.length) return resolved
  }
  return resolveReminderOffsets(options.defaultReminderOffsets)
}

function outputDueAt(value) {
  if (typeof value === 'string') return value
  const date = toDate(value)
  return date ? date.toISOString() : String(value)
}

/**
 * Build the reminders that are due at `now`.
 *
 * @param {{ listCommitments: () => Array<object> }} ledger Any object with
 *   `listCommitments()`; the core `Ledger` works, and no SQLite is involved.
 * @param {object} [options]
 * @param {Date|string|number} [options.now] Injected current instant.
 * @param {number} [options.horizonDays=7] Future horizon in local days.
 * @param {boolean} [options.allowL3=false] Enable L3 for severely overdue items.
 * @param {Array<object|string>} [options.rules] Rule descriptors or ids.
 * @param {Map|object|Function} [options.snoozedUntil] Per-commitment snooze
 *   deadlines, keyed by commitment id; future deadlines suppress reminders.
 * @param {Map|object|Function} [options.reminderOffsets] Injected
 *   per-commitment offsets (same keying as `snoozedUntil`). Injected values
 *   are checked before the commitment's own `reminderOffsets` field.
 * @param {string[]} [options.defaultReminderOffsets] Global offsets applied
 *   when a commitment has neither its own nor an injected list.
 * @returns {Array<{ commitmentId: string, action: string, dueAt: string,
 *   bucket: 'overdue'|'due-today'|'due-1d'|'upcoming',
 *   level: 'L1'|'L2'|'L3', ruleId: string, reminderOffsets?: string[] }>}
 */
export function buildReminders(ledger, options = {}) {
  if (!ledger || typeof ledger.listCommitments !== 'function') {
    throw new TypeError('buildReminders requires a ledger with listCommitments()')
  }
  const opts = options ?? {}
  const now = requireNow(opts.now)
  const horizonDays = Number.isFinite(opts.horizonDays) && opts.horizonDays >= 0 ? opts.horizonDays : DEFAULT_HORIZON_DAYS
  const allowL3 = opts.allowL3 === true
  const rules = (opts.rules ?? DEFAULT_RULES).map(resolveRule)
  const commitments = ledger.listCommitments()
  if (!Array.isArray(commitments)) throw new TypeError('ledger.listCommitments() must return an array')

  const today = localDay(now)
  const todayIndex = localDayIndex(today)
  const minutesOfDay = localMinutesOfDay(now)
  const seen = new Set()
  const reminders = []

  // 0.3.0 P0-T2: per-call caches. Reminder planning needs one parsed due
  // instant and one local day per row, but a real ledger has only a few
  // hundred distinct dueAt strings at 200k rows; caching the parse turns ~60k
  // regex + Date.parse + Intl lookups into a few hundred and keeps remind/tui
  // inside the 0.3.0 read budget.
  const dueCache = new Map()
  const dueInfo = (value) => {
    const key = typeof value === 'string' ? value : value instanceof Date ? `date:${value.getTime()}` : `ms:${String(value)}`
    let info = dueCache.get(key)
    if (info === undefined) {
      const date = toDate(value)
      info = date ? { date, dayIndex: localDayIndexFromMs(date.getTime()), dueDay: localDayOf(date) } : null
      dueCache.set(key, info)
    }
    return info
  }
  // readSnoozeUntil()/readReminderOffsets() can only find state that was
  // injected, set on the row, or exposed by a duck-typed ledger hook. The
  // common CLI path has none of that, so skip the per-row lookup instead of
  // allocating a candidate array for every commitment.
  const injectedSnooze = opts.snoozedUntil
  const snoozeStatePossible = typeof injectedSnooze === 'function' ||
    (injectedSnooze instanceof Map && injectedSnooze.size > 0) ||
    (Boolean(injectedSnooze) && typeof injectedSnooze === 'object' && !(injectedSnooze instanceof Map) && Object.keys(injectedSnooze).length > 0) ||
    typeof ledger.getMeta === 'function'
  const injectedOffsets = opts.reminderOffsets
  const offsetStatePossible = typeof injectedOffsets === 'function' ||
    (injectedOffsets instanceof Map && injectedOffsets.size > 0) ||
    (Boolean(injectedOffsets) && typeof injectedOffsets === 'object' && !(injectedOffsets instanceof Map) && Object.keys(injectedOffsets).length > 0) ||
    opts.defaultReminderOffsets !== undefined ||
    typeof ledger.getMeta === 'function'

  for (const commitment of commitments) {
    if (!commitment || typeof commitment !== 'object') continue
    if (!commitment.id) continue
    if (commitment.status === 'done' || commitment.status === 'dropped') continue
    if (commitment.dueAt == null || commitment.dueAt === '') continue
    const info = dueInfo(commitment.dueAt)
    if (!info) continue
    const due = info.date

    const snoozeUntil = snoozeStatePossible || commitment.snoozedUntil !== undefined || commitment.snoozeUntil !== undefined ||
      commitment.snoozeAt !== undefined || commitment.meta !== undefined
      ? readSnoozeUntil(commitment, opts, ledger)
      : null
    // An active snooze hides the commitment; once it expires the commitment
    // becomes visible again and the snooze-wake rule fires.
    if (snoozeUntil && snoozeUntil.getTime() > now.getTime()) continue
    const snoozeExpired = Boolean(snoozeUntil)
    const reminderOffsets = offsetStatePossible || commitment.reminderOffsets !== undefined || commitment.meta !== undefined
      ? readReminderOffsets(commitment, opts, ledger)
      : EMPTY_REMINDER_OFFSETS

    const dueDay = info.dueDay
    const dayOffset = info.dayIndex - todayIndex
    if (dayOffset > horizonDays) continue

    const bucket = bucketFor(dayOffset)
    const level = levelFor(bucket, due, now, allowL3)
    const context = {
      commitment,
      due,
      now,
      bucket,
      level,
      dayOffset,
      dueDay,
      localDay: today,
      minutesOfDay,
      snoozeUntil,
      snoozeExpired,
    }

    for (const def of rules) {
      const result = evaluateRule(def, context)
      if (!result) continue
      const key = `${commitment.id}|${result.bucket}|${result.ruleId}|${today}`
      if (seen.has(key)) continue
      seen.add(key)
      reminders.push({
        // Kept out of the output object: the final sort needs the instant,
        // and toDate() per comparator call was the 0.2.x sort's hot spot.
        dueMs: due.getTime(),
        reminder: {
          commitmentId: commitment.id,
          action: commitment.action ?? '',
          dueAt: outputDueAt(commitment.dueAt),
          bucket: result.bucket,
          level: result.level,
          ruleId: result.ruleId,
          // Only present when customised: pre-0.2.0 reminder objects keep their
          // exact shape and toIcs falls back to the legacy relative alarms.
          ...(reminderOffsets.length ? { reminderOffsets } : {}),
        },
      })
    }
  }

  reminders.sort(
    (left, right) =>
      left.dueMs - right.dueMs ||
      left.reminder.commitmentId.localeCompare(right.reminder.commitmentId) ||
      left.reminder.ruleId.localeCompare(right.reminder.ruleId),
  )
  return reminders.map((entry) => entry.reminder)
}

/**
 * Render reminders as an RFC5545 calendar.
 *
 * Only the commitment title, due instant and stable UID are exported — never
 * the creditor, matter, evidence or any other ledger field.
 *
 * @param {Array<object>} reminders Output of {@link buildReminders}.
 * @param {object} [options]
 * @param {Date|string|number} [options.now] DTSTAMP instant.
 * @param {string} [options.uidPrefix='advisers']
 * @param {string[]} [options.reminderOffsets] Fallback custom offsets for
 *   reminders that do not carry their own `reminderOffsets`.
 * @returns {string} CRLF-terminated iCalendar text.
 */
const legacyAlarmLines = (title) => [
  'BEGIN:VALARM',
  'TRIGGER:-P1D',
  'ACTION:DISPLAY',
  `DESCRIPTION:${escapeIcsText(`提醒：${title}（1 天前）`)}`,
  'END:VALARM',
  'BEGIN:VALARM',
  'TRIGGER:-PT1H',
  'ACTION:DISPLAY',
  `DESCRIPTION:${escapeIcsText(`提醒：${title}（1 小时前）`)}`,
  'END:VALARM',
]

/**
 * VALARM lines for one event. Custom offsets become **absolute** DATE-TIME
 * triggers computed in Asia/Shanghai (RFC5545 requires VALUE=DATE-TIME when
 * TRIGGER is absolute) and one VALARM is emitted per rule. With no offsets the
 * pre-0.2.0 relative defaults (-P1D, -PT1H) are preserved byte-for-byte.
 */
function alarmLines(reminder, due, title, options) {
  const configured = reminder.reminderOffsets ?? options.reminderOffsets
  const alarms = reminderAlarms(due, configured)
  if (!alarms.length) return legacyAlarmLines(title)
  return alarms.flatMap((alarm) => [
    'BEGIN:VALARM',
    `TRIGGER;VALUE=DATE-TIME:${formatIcsDate(alarm.at)}`,
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText(`提醒：${title}（${alarm.label}）`)}`,
    'END:VALARM',
  ])
}

export function toIcs(reminders, options = {}) {
  if (!Array.isArray(reminders)) throw new TypeError('toIcs requires an array of reminders')
  const opts = options ?? {}
  const now = requireNow(opts.now)
  const rawPrefix = opts.uidPrefix == null ? '' : String(opts.uidPrefix)
  const uidPrefix = (rawPrefix || 'advisers').replace(/[\r\n]/g, '')

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Advisers//E1 Reminders//EN',
    'CALSCALE:GREGORIAN',
  ]
  const seenUids = new Set()

  for (const reminder of reminders) {
    if (!reminder || typeof reminder !== 'object') {
      throw new TypeError('toIcs received a non-object reminder')
    }
    if (reminder.commitmentId == null || reminder.dueAt == null) {
      throw new TypeError('toIcs reminders require commitmentId and dueAt')
    }
    const due = toDate(reminder.dueAt)
    if (!due) throw new RangeError(`invalid reminder dueAt: ${String(reminder.dueAt)}`)
    const dueAt = outputDueAt(reminder.dueAt)
    // A commitment can collect several nudges on the same day (e.g. 09:00 and
    // 18:00); the calendar carries one stable event per commitment instant.
    const uid = `${uidPrefix}-${String(reminder.commitmentId)}-${dueAt}`.replace(/[\r\n]/g, '')
    if (seenUids.has(uid)) continue
    seenUids.add(uid)

    const title = String(reminder.action ?? '')
    const localDue = formatLocalDateTime(due)
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${formatIcsDate(now)}`,
      `DTSTART:${formatIcsDate(due)}`,
      `SUMMARY:${escapeIcsText(title)}`,
      `DESCRIPTION:${escapeIcsText(`到期：${localDue}（${TIME_ZONE}）`)}`,
      ...alarmLines(reminder, due, title, opts),
      'END:VEVENT',
    )
  }

  lines.push('END:VCALENDAR')
  return `${lines.join('\r\n')}\r\n`
}

export { DAY_MS, SHANGHAI_OFFSET_MS }
