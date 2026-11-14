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

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
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

function dayParts(date) {
  const parts = DAY_FORMAT.formatToParts(date)
  const pick = (type) => parts.find((part) => part.type === type)?.value
  return { year: pick('year'), month: pick('month'), day: pick('day') }
}

/** Local calendar day in Asia/Shanghai, as `YYYY-MM-DD`. */
export function localDay(value) {
  const date = toDate(value)
  if (!date) return null
  const { year, month, day } = dayParts(date)
  return `${year}-${month}-${day}`
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
 * @returns {Array<{ commitmentId: string, action: string, dueAt: string,
 *   bucket: 'overdue'|'due-today'|'due-1d'|'upcoming',
 *   level: 'L1'|'L2'|'L3', ruleId: string }>}
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

  for (const commitment of commitments) {
    if (!commitment || typeof commitment !== 'object') continue
    if (!commitment.id) continue
    if (commitment.status === 'done' || commitment.status === 'dropped') continue
    if (commitment.dueAt == null || commitment.dueAt === '') continue
    const due = toDate(commitment.dueAt)
    if (!due) continue

    const snoozeUntil = readSnoozeUntil(commitment, opts, ledger)
    // An active snooze hides the commitment; once it expires the commitment
    // becomes visible again and the snooze-wake rule fires.
    if (snoozeUntil && snoozeUntil.getTime() > now.getTime()) continue
    const snoozeExpired = Boolean(snoozeUntil)

    const dueDay = localDay(due)
    const dayOffset = localDayIndex(dueDay) - todayIndex
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
        commitmentId: commitment.id,
        action: commitment.action ?? '',
        dueAt: outputDueAt(commitment.dueAt),
        bucket: result.bucket,
        level: result.level,
        ruleId: result.ruleId,
      })
    }
  }

  const dueTime = (reminder) => toDate(reminder.dueAt)?.getTime() ?? 0
  reminders.sort(
    (left, right) =>
      dueTime(left) - dueTime(right) ||
      left.commitmentId.localeCompare(right.commitmentId) ||
      left.ruleId.localeCompare(right.ruleId),
  )
  return reminders
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
 * @returns {string} CRLF-terminated iCalendar text.
 */
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
      'END:VEVENT',
    )
  }

  lines.push('END:VCALENDAR')
  return `${lines.join('\r\n')}\r\n`
}

export { DAY_MS, SHANGHAI_OFFSET_MS }
