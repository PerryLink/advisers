/**
 * Recurrence expansion for locally imported calendar events (E2, read-only).
 *
 * Pure, offline, dependency-free. Scope is a deliberately small RRULE subset:
 *
 *   FREQ=DAILY|WEEKLY, INTERVAL, COUNT, UNTIL, BYDAY (plain weekdays) and WKST
 *
 * plus simple EXDATE exclusion. Everything is interpreted in a fixed
 * Asia/Shanghai (UTC+08:00) zone: this package ships no time-zone database and
 * mainland China has no DST, so a fixed +08:00 offset is exact for the local
 * calendar display that consumes this module.
 *
 * Why this module exists: importers.parseIcs keeps the RRULE text verbatim
 * ("it is evidence, not something to expand") and the SQLite row stores the
 * series once, so a weekly meeting used to appear in today --calendar only on
 * its DTSTART day. The read-only CLI layer calls expandRrule(event, { from,
 * to }) to turn that one row into the occurrences visible in a date window.
 * Nothing here writes to the database or filesystem.
 *
 * Deliberate limits (also documented in docs/CALENDAR.md):
 *   - unsupported FREQ (MONTHLY/YEARLY/...), BY* parts other than BYDAY, COUNT
 *     together with UNTIL, BYDAY ordinals (e.g. 1MO), or malformed rules are
 *     never guessed: the stored base occurrence is returned unexpanded instead
 *     of inventing dates (a wrong meeting time is worse than a missing one);
 *   - RECURRENCE-ID override components are not resolved;
 *   - at most MAX_INSTANCES (366) instances are returned per call and the
 *     internal scan is bounded, so a hostile RRULE cannot amplify work.
 *
 * @module ical
 */

/** Fixed zone for every stored calendar timestamp in this package. */
export const SHANGHAI_TIMEZONE = 'Asia/Shanghai'

/** Hard cap on the number of occurrences one expandRrule() call may return. */
export const MAX_INSTANCES = 366

const OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// Upper bound on rule candidates examined per call (days or weeks). Keeps a
// hostile rule bounded even when the requested window is far from DTSTART.
const MAX_SCAN_STEPS = 100000
const MAX_INTERVAL = 10000

const WEEKDAY_NAMES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const WEEKDAY_INDEX = new Map(WEEKDAY_NAMES.map((name, index) => [name, index]))
const SUPPORTED_RRULE_KEYS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST'])

const mod = (value, divisor) => ((value % divisor) + divisor) % divisor

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function own(event, keys) {
  for (const key of keys) {
    if (event[key] !== undefined && event[key] !== null) return event[key]
  }
  return undefined
}

function toBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true'
}

/** Monday-based weekday of an epoch-day number (1970-01-01 = Thursday). */
function weekdayOfDay(dayNumber) {
  return mod(dayNumber + 3, 7)
}

function formatDay(dayNumber) {
  const date = new Date(dayNumber * DAY_MS)
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

/** Format an instant as Asia/Shanghai wall-clock ISO time (explicit +08:00). */
function formatTimed(instantMs) {
  const date = new Date(instantMs + OFFSET_MS)
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  const second = String(date.getUTCSeconds()).padStart(2, '0')
  return year + '-' + month + '-' + day + 'T' + hour + ':' + minute + ':' + second + '+08:00'
}

function validYmd(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

function dayNumberFromYmd(year, month, day) {
  if (!validYmd(year, month, day)) return null
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS)
}

/** Parse a date-only value: 'YYYY-MM-DD' or compact iCalendar 'YYYYMMDD'. */
function parseDay(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) match = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  if (!match) return null
  const dayNumber = dayNumberFromYmd(Number(match[1]), Number(match[2]), Number(match[3]))
  return dayNumber == null ? null : { dayNumber }
}

/**
 * Parse a date-time value into an instant (epoch ms).
 *
 * Accepted: Date / finite number / 'YYYY-MM-DDTHH:MM[:SS]' (Asia/Shanghai
 * wall clock when no zone suffix), compact iCalendar 'YYYYMMDDTHHMMSS[Z]',
 * with an optional 'Z' or '+08:00' / '+0800' suffix.
 *
 * @param {unknown} value
 * @returns {{ instantMs: number, dayNumber: number } | null}
 */
function parseDateTime(value) {
  if (value instanceof Date) {
    const instantMs = value.getTime()
    if (!Number.isFinite(instantMs)) return null
    return { instantMs, dayNumber: Math.floor((instantMs + OFFSET_MS) / DAY_MS) }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { instantMs: value, dayNumber: Math.floor((value + OFFSET_MS) / DAY_MS) }
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null

  let match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i.exec(text)
  if (match) {
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const hour = Number(match[4])
    const minute = Number(match[5])
    const second = Number(match[6])
    if (!validYmd(year, month, day) || hour > 23 || minute > 59 || second > 59) return null
    const utc = Date.UTC(year, month - 1, day, hour, minute, second)
    const instantMs = match[7] ? utc : utc - OFFSET_MS
    return { instantMs, dayNumber: Math.floor((instantMs + OFFSET_MS) / DAY_MS) }
  }

  match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(text)
  if (match) {
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const hour = Number(match[4])
    const minute = Number(match[5])
    const second = match[6] == null ? 0 : Number(match[6])
    const millis = match[7] == null ? 0 : Number(match[7].padEnd(3, '0'))
    if (!validYmd(year, month, day) || hour > 23 || minute > 59 || second > 59) return null
    const wallClock = Date.UTC(year, month - 1, day, hour, minute, second, millis)
    const zone = match[8]
    let instantMs
    if (!zone) {
      instantMs = wallClock - OFFSET_MS
    } else if (zone.toUpperCase() === 'Z') {
      instantMs = wallClock
    } else {
      const sign = zone[0] === '-' ? -1 : 1
      const digits = zone.slice(1).replace(':', '')
      const offsetMs = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60 * 1000
      instantMs = wallClock - offsetMs
    }
    return { instantMs, dayNumber: Math.floor((instantMs + OFFSET_MS) / DAY_MS) }
  }
  return null
}

function readStart(event) {
  const raw = own(event, ['startsAt', 'start', 'starts_at', 'dtstart', 'DTSTART'])
  if (raw === undefined) return null
  const allDayFlag = toBoolean(own(event, ['allDay', 'all_day', 'allday']))
  const day = parseDay(raw)
  if (day) {
    return { allDay: true, dayNumber: day.dayNumber, todMs: 0, startMs: day.dayNumber * DAY_MS - OFFSET_MS }
  }
  const parsed = parseDateTime(raw)
  if (!parsed) return null
  if (allDayFlag) {
    return { allDay: true, dayNumber: parsed.dayNumber, todMs: 0, startMs: parsed.dayNumber * DAY_MS - OFFSET_MS }
  }
  return {
    allDay: false,
    dayNumber: parsed.dayNumber,
    todMs: mod(parsed.instantMs + OFFSET_MS, DAY_MS),
    startMs: parsed.instantMs,
  }
}

function readEnd(event, start) {
  const raw = own(event, ['endsAt', 'end', 'ends_at', 'dtend', 'DTEND'])
  if (raw === undefined) return null
  if (start.allDay) {
    const day = parseDay(raw)
    const parsed = day ? null : parseDateTime(raw)
    const dayNumber = day ? day.dayNumber : parsed ? parsed.dayNumber : null
    if (dayNumber == null) return null
    return { durationDays: Math.max(0, dayNumber - start.dayNumber) }
  }
  const day = parseDay(raw)
  if (day) {
    // A date-only DTEND on a timed event is tolerated as Shanghai midnight.
    const durationMs = day.dayNumber * DAY_MS - OFFSET_MS - start.startMs
    return durationMs < 0 ? null : { durationMs }
  }
  const parsed = parseDateTime(raw)
  if (!parsed) return null
  const durationMs = parsed.instantMs - start.startMs
  return durationMs < 0 ? null : { durationMs }
}

function normalizeWindowInstant(value, name, { endOfDay = false } = {}) {
  if (value === undefined || value === null) return null
  if (value instanceof Date) {
    const instantMs = value.getTime()
    if (!Number.isFinite(instantMs)) throw new TypeError('expandRrule: invalid ' + name + ' date')
    return instantMs
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const day = parseDay(value)
  if (day) {
    const startMs = day.dayNumber * DAY_MS - OFFSET_MS
    return endOfDay ? startMs + DAY_MS - 1 : startMs
  }
  const parsed = parseDateTime(value)
  if (!parsed) throw new TypeError('expandRrule: invalid ' + name + ' value: ' + String(value))
  return parsed.instantMs
}

function readWindow(options, start) {
  const fromMs = normalizeWindowInstant(options?.from, 'from')
  const toMs = normalizeWindowInstant(options?.to, 'to', { endOfDay: true })
  const windowFrom = fromMs == null ? start.startMs : fromMs
  const windowTo = toMs == null ? windowFrom + 366 * DAY_MS : toMs
  return { fromMs: windowFrom, toMs: windowTo }
}

function parseUntil(value) {
  const text = asString(value)
  if (!text) return null
  const day = parseDay(text)
  if (day) {
    // A DATE UNTIL bounds the whole local day: inclusive up to 23:59:59.999.
    return { instantMs: day.dayNumber * DAY_MS - OFFSET_MS + DAY_MS - 1 }
  }
  const parsed = parseDateTime(text)
  return parsed ? { instantMs: parsed.instantMs } : null
}

/**
 * Parse the supported RRULE subset. Exported for callers that want to explain
 * why a rule was not expanded (e.g. a CLI warning); expandRrule() itself never
 * throws on an unsupported rule.
 *
 * @param {unknown} text raw RRULE text (leading 'RRULE:' prefix tolerated)
 * @returns {{ freq: 'DAILY'|'WEEKLY'|null, interval: number, count: number|null,
 *   until: {instantMs: number}|null, byday: number[]|null, wkst: number,
 *   supported: boolean, reason: string|null, raw: string|null }}
 */
export function parseRrule(text) {
  const result = {
    freq: null,
    interval: 1,
    count: null,
    until: null,
    byday: null,
    wkst: 0,
    supported: false,
    reason: null,
    raw: null,
  }
  if (typeof text !== 'string' || !text.trim()) {
    result.reason = 'missing'
    return result
  }
  let raw = text.trim()
  if (/^RRULE:/i.test(raw)) raw = raw.slice(raw.indexOf(':') + 1).trim()
  result.raw = raw
  const parts = new Map()
  for (const segment of raw.split(';')) {
    if (!segment.trim()) continue
    const equals = segment.indexOf('=')
    if (equals <= 0) {
      result.reason = 'malformed-rule'
      return result
    }
    const key = segment.slice(0, equals).trim().toUpperCase()
    const value = segment.slice(equals + 1).trim()
    if (parts.has(key)) {
      result.reason = 'duplicate-part:' + key
      return result
    }
    parts.set(key, value)
  }
  for (const key of parts.keys()) {
    if (!SUPPORTED_RRULE_KEYS.has(key)) {
      result.reason = 'unsupported-part:' + key
      return result
    }
  }
  const freq = asString(parts.get('FREQ')).toUpperCase()
  if (freq !== 'DAILY' && freq !== 'WEEKLY') {
    result.reason = freq ? 'unsupported-freq:' + freq : 'missing-freq'
    return result
  }
  result.freq = freq
  if (parts.has('COUNT') && parts.has('UNTIL')) {
    // RFC 5545 forbids both; guessing which one wins risks inventing occurrences.
    result.reason = 'count-and-until'
    return result
  }
  if (parts.has('INTERVAL')) {
    const interval = Number(parts.get('INTERVAL'))
    if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL) {
      result.reason = 'bad-interval'
      return result
    }
    result.interval = interval
  }
  if (parts.has('COUNT')) {
    const count = Number(parts.get('COUNT'))
    if (!Number.isInteger(count) || count < 1) {
      result.reason = 'bad-count'
      return result
    }
    result.count = count
  }
  if (parts.has('UNTIL')) {
    const until = parseUntil(parts.get('UNTIL'))
    if (!until) {
      result.reason = 'bad-until'
      return result
    }
    result.until = until
  }
  if (parts.has('BYDAY')) {
    const byday = []
    for (const token of parts.get('BYDAY').split(',')) {
      const weekday = token.trim().toUpperCase()
      if (!WEEKDAY_INDEX.has(weekday)) {
        result.reason = 'bad-byday'
        return result
      }
      const index = WEEKDAY_INDEX.get(weekday)
      if (!byday.includes(index)) byday.push(index)
    }
    if (!byday.length) {
      result.reason = 'bad-byday'
      return result
    }
    result.byday = byday.sort((a, b) => a - b)
  }
  if (parts.has('WKST')) {
    const weekday = asString(parts.get('WKST')).toUpperCase()
    if (!WEEKDAY_INDEX.has(weekday)) {
      result.reason = 'bad-wkst'
      return result
    }
    result.wkst = WEEKDAY_INDEX.get(weekday)
  }
  result.supported = true
  return result
}

function collectExdates(event) {
  const raw = own(event, ['exdate', 'exdates', 'exDate', 'exDates', 'ex_date'])
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  const days = new Set()
  const instants = new Set()
  for (const value of values) {
    const text = asString(value)
    if (!text) continue
    // Tolerate the full property text: 'EXDATE;TZID=Asia/Shanghai:20261116T100000'.
    const afterParams = /^EXDATE/i.test(text) && text.includes(':') ? text.slice(text.indexOf(':') + 1) : text
    const day = parseDay(afterParams)
    if (day) {
      days.add(day.dayNumber)
      continue
    }
    const parsed = parseDateTime(afterParams)
    if (parsed) instants.add(parsed.instantMs)
  }
  return { days, instants }
}

function isExcluded(exdate, start, dayNumber, occurrenceMs) {
  if (exdate.days.has(dayNumber)) return true
  if (exdate.instants.size === 0) return false
  for (const instantMs of exdate.instants) {
    if (start.allDay) {
      if (Math.floor((instantMs + OFFSET_MS) / DAY_MS) === dayNumber) return true
    } else if (instantMs === occurrenceMs) {
      return true
    }
  }
  return false
}

function makeInstance(event, start, end, dayNumber, occurrenceMs, index, seriesStartsAt, recurring) {
  const startsAt = start.allDay ? formatDay(dayNumber) : formatTimed(occurrenceMs)
  let endsAt = null
  if (end) {
    endsAt = start.allDay ? formatDay(dayNumber + end.durationDays) : formatTimed(occurrenceMs + end.durationMs)
  }
  return {
    uid: event.uid == null ? null : String(event.uid),
    summary: typeof event.summary === 'string' ? event.summary : String(event.summary ?? ''),
    startsAt,
    endsAt,
    allDay: start.allDay,
    tzid: event.tzid == null ? null : String(event.tzid),
    location: event.location == null ? null : String(event.location),
    rrule: typeof event.rrule === 'string' ? event.rrule : null,
    source: event.source == null ? null : event.source,
    recurring,
    occurrenceIndex: index,
    seriesStartsAt,
  }
}

/**
 * Expand one stored calendar event into the occurrences that start inside
 * {from, to} (Asia/Shanghai wall clock, inclusive).
 *
 * Input accepts the camelCase row returned by SqliteStore.listCalendarEvents()
 * (uid/summary/startsAt/endsAt/allDay/tzid/location/rrule/source) as well as
 * snake_case / parseIcs field names (start/end/starts_at/...), plus optional
 * exdate / exdates entries (string, comma-separated string, or array).
 *
 * Returned instance objects keep the row's identity/summary metadata and add:
 *   startsAt / endsAt  'YYYY-MM-DD' (all-day) or
 *                      'YYYY-MM-DDTHH:MM:SS+08:00' (timed);
 *   recurring          true when the instance came from an expanded RRULE;
 *   occurrenceIndex    0-based index inside this expansion result;
 *   seriesStartsAt     formatted DTSTART of the stored series.
 *
 * Window bounds may be Date objects, epoch milliseconds, 'YYYY-MM-DD' dates
 * (a bare 'to' date means end of that local day) or ISO/iCalendar timestamps.
 * They default to the DTSTART instant / DTSTART + 366 days.
 *
 * Events without a usable start return []; unsupported or malformed RRULEs
 * return the single stored occurrence (never throw, never invent dates).
 *
 * @param {object} event stored event row
 * @param {{from?: unknown, to?: unknown}} [options] display window
 * @returns {Array<object>} occurrence instances, at most MAX_INSTANCES
 * @throws {TypeError} when event is not an object or a window bound is invalid
 */
export function expandRrule(event, options = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('expandRrule: event must be an object')
  }
  const start = readStart(event)
  if (!start) return []
  const end = readEnd(event, start)
  const { fromMs, toMs } = readWindow(options, start)
  if (toMs < fromMs) return []
  if (start.startMs > toMs) return []

  const seriesStartsAt = start.allDay ? formatDay(start.dayNumber) : formatTimed(start.startMs)
  const rule = parseRrule(typeof event.rrule === 'string' ? event.rrule : null)
  if (!rule.raw || !rule.supported) {
    // Keep the previous behaviour for rules outside the supported subset: show
    // the stored occurrence when it falls inside the window, never a guessed
    // recurrence.
    if (start.startMs < fromMs) return []
    return [makeInstance(event, start, end, start.dayNumber, start.startMs, 0, seriesStartsAt, false)]
  }

  const records = []
  let emitted = 0
  const consider = (dayNumber, occurrenceMs) => {
    if (rule.until && occurrenceMs > rule.until.instantMs) return 'stop'
    if (rule.count != null && emitted >= rule.count) return 'stop'
    emitted += 1
    if (occurrenceMs >= fromMs && occurrenceMs <= toMs) {
      records.push({ dayNumber, occurrenceMs })
      if (records.length >= MAX_INSTANCES) return 'stop'
    }
    return 'continue'
  }

  // DTSTART is always the first instance of the series, even when it does not
  // match BYDAY (RFC 5545 leaves that combination undefined; keeping the stored
  // occurrence is the only choice that never hides a real meeting).
  let stopped = consider(start.dayNumber, start.startMs) === 'stop'

  let steps = 0
  if (!stopped && rule.freq === 'DAILY') {
    const byday = rule.byday
    let multiplier = 1
    while (steps < MAX_SCAN_STEPS) {
      steps += 1
      const dayNumber = start.dayNumber + multiplier * rule.interval
      multiplier += 1
      if (byday && !byday.includes(weekdayOfDay(dayNumber))) continue
      const occurrenceMs = dayNumber * DAY_MS - OFFSET_MS + start.todMs
      if (occurrenceMs > toMs) break
      if (consider(dayNumber, occurrenceMs) === 'stop') break
    }
  } else if (!stopped) {
    // WEEKLY: walk whole weeks aligned to WKST, stepping INTERVAL weeks.
    const byday = rule.byday ?? [weekdayOfDay(start.dayNumber)]
    const weekdayOffsets = byday.map((weekday) => mod(weekday - rule.wkst, 7)).sort((a, b) => a - b)
    const firstWeekStart = start.dayNumber - mod(weekdayOfDay(start.dayNumber) - rule.wkst, 7)
    let week = 0
    while (steps < MAX_SCAN_STEPS) {
      steps += 1
      const weekStart = firstWeekStart + week * rule.interval * 7
      week += 1
      for (const offset of weekdayOffsets) {
        const dayNumber = weekStart + offset
        if (dayNumber <= start.dayNumber) continue
        const occurrenceMs = dayNumber * DAY_MS - OFFSET_MS + start.todMs
        if (occurrenceMs > toMs) {
          steps = MAX_SCAN_STEPS
          break
        }
        if (consider(dayNumber, occurrenceMs) === 'stop') {
          steps = MAX_SCAN_STEPS
          break
        }
      }
    }
  }

  const exdate = collectExdates(event)
  const keep = (record) => !isExcluded(exdate, start, record.dayNumber, record.occurrenceMs)
  return records
    .filter(keep)
    .map((record, index) => makeInstance(event, start, end, record.dayNumber, record.occurrenceMs, index, seriesStartsAt, true))
}
