/**
 * Deterministic Chinese relative-date resolver for `advisers capture`.
 *
 * Why this exists: the model is good at spotting commitments but unreliable at
 * calendar arithmetic, and the prompt used to hand it a UTC timestamp while
 * claiming `Asia/Shanghai` (a message sent 00:00–07:59 Beijing time showed the
 * previous UTC date). This module anchors every relative date on the message
 * time in Asia/Shanghai and returns a concrete local date. The model's `dueAt`
 * is still used for expressions this resolver does not understand, and its
 * time-of-day is preserved when only the date had to be corrected.
 *
 * Semantics (documented, tested):
 * - 今天/明天/后天/大后天: message day + 0/1/2/3. "当天" is intentionally
 *   NOT resolved: it usually refers to a previously mentioned event day, not the
 *   message day (gold review 2026-11-14, gold-029).
 * - 周X/星期X/礼拜X: upcoming X in the message's Monday-based week; if X is
 *   today it is today (marked ambiguous because "周五前" said on Friday can
 *   also mean next Friday).
 * - 本周X/下周X/下下周X: that week explicitly; past days are kept as-is.
 * - 月底/季度末/年底: last calendar day of the containing month/quarter/year;
 *   same-day is marked ambiguous.
 * - N 天/周/个月后: calendar offset.
 * - 绝对日期 (2027年1月10日 / 11月13日 / 11/13): explicit year is kept;
 *   month-day without a year rolls to next year when the date is already past.
 * - Time-of-day: explicit clock (下午3点半, 14:30) else 下班前=18:00,
 *   中午前=12:00, 上班前=09:00, otherwise 18:00 Asia/Shanghai.
 *
 * `resolveDueInput` (0.4.3, plan 92 §1) wraps the resolver for CLI `--due`
 * flags: ISO date-times pass through byte-for-byte, `YYYY-MM-DD` becomes that
 * day 18:00, and unknown/conflicting input returns a structured failure so the
 * caller errors instead of guessing or storing the raw string.
 */

const TIME_ZONE = 'Asia/Shanghai'
const DEFAULT_TIME = '18:00'
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEKDAY_INDEX = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }

const pad = (n) => String(n).padStart(2, '0')
const ymd = (p) => `${p.y}-${pad(p.m)}-${pad(p.d)}`
const calendarDay = (p) => Math.floor(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000)

function weekdayIndex(p) {
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()
}

function isoWeekday(p) {
  const day = weekdayIndex(p)
  return day === 0 ? 7 : day
}

function addDays(p, days) {
  const date = new Date(Date.UTC(p.y, p.m - 1, p.d) + days * 86_400_000)
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() }
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

/** True for a real Gregorian date written with a full year (no 19xx mapping). */
function validCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return false
  if (!Number.isInteger(month) || month < 1 || month > 12) return false
  if (!Number.isInteger(day) || day < 1) return false
  const last = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
  return day <= last
}

function addMonths(p, months) {
  const total = p.y * 12 + (p.m - 1) + months
  const y = Math.floor(total / 12)
  const m = (total % 12) + 1
  return { y, m, d: Math.min(p.d, lastDayOfMonth(y, m)) }
}

function weekStart(p) {
  return addDays(p, 1 - isoWeekday(p))
}

/** Calendar parts of an instant in the given zone. */
export function localParts(date = new Date(), timeZone = TIME_ZONE) {
  const instant = date instanceof Date ? date : new Date(date)
  if (!Number.isFinite(instant.getTime())) throw new Error('invalid date')
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const fields = {}
  for (const part of formatter.formatToParts(instant)) if (part.type !== 'literal') fields[part.type] = part.value
  const p = { y: Number(fields.year), m: Number(fields.month), d: Number(fields.day), hh: Number(fields.hour), mm: Number(fields.minute) }
  const day = weekdayIndex(p)
  return { ...p, date: ymd(p), weekdayIndex: day, weekday: WEEKDAY_LABELS[day], isoWeekday: isoWeekday(p), timeZone }
}

/** Human-readable message clock injected into the capture prompt. */
export function describeMessageTime(date = new Date(), timeZone = TIME_ZONE) {
  const p = localParts(date, timeZone)
  return { ...p, wall: `${p.date} ${pad(p.hh)}:${pad(p.mm)}`, label: `${p.date} ${pad(p.hh)}:${pad(p.mm)} ${p.weekday}（${timeZone}）` }
}

const CN_NUMBER = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

function parseNumber(text) {
  if (/^\d+$/.test(text)) return Number(text)
  if (text === '十') return 10
  if (text.length === 1) return CN_NUMBER[text] ?? null
  if (text.startsWith('十')) return 10 + (CN_NUMBER[text[1]] ?? 0)
  const match = /^([一二两三四五六七八九])十([一二三四五六七八九])?$/.exec(text)
  if (match) return (CN_NUMBER[match[1]] ?? 0) * 10 + (match[2] ? CN_NUMBER[match[2]] : 0)
  return null
}

function clockFromText(text) {
  const periodMatch = /(凌晨|早上|上午|中午|下午|傍晚|晚上)\s*(\d{1,2})\s*(?:[:：]\s*(\d{1,2})|点\s*(半|\d{1,2}\s*分?)?)/.exec(text)
  if (periodMatch) {
    const period = periodMatch[1]
    let hour = Number(periodMatch[2])
    let minute = periodMatch[3] ? Number(periodMatch[3]) : periodMatch[4] === '半' ? 30 : Number(String(periodMatch[4] ?? '').replace(/\D/g, '')) || 0
    if (period === '凌晨') hour = hour === 12 ? 0 : hour
    else if (period === '中午') hour = hour < 11 ? hour + 12 : hour
    else if (period === '下午' || period === '傍晚') hour = hour < 12 ? hour + 12 : hour
    else if (period === '晚上') hour = hour === 12 ? 0 : hour < 12 ? hour + 12 : hour
    if (hour <= 23 && minute <= 59) return `${pad(hour)}:${pad(minute)}`
  }
  const plain = /(?<!\d)([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)(?!\d)/.exec(text)
  if (plain) return `${pad(Number(plain[1]))}:${pad(Number(plain[2]))}`
  if (/下班前/.test(text)) return '18:00'
  if (/中午前|午饭前/.test(text)) return '12:00'
  if (/上班前/.test(text)) return '09:00'
  return DEFAULT_TIME
}

function explicitDate(year, month, day, { message, hasYear }) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  if (!Number.isInteger(day) || day < 1 || day > 31) return null
  if (day > lastDayOfMonth(year, month)) return null
  let p = { y: year, m: month, d: day }
  if (!hasYear && calendarDay(p) < calendarDay(message)) p = { ...p, y: p.y + 1 }
  return { date: ymd(p), kind: 'explicit', ambiguous: false }
}

function weekdayDate(targetIso, mode, message) {
  const start = weekStart(message)
  if (mode === 'next-next') return { date: ymd(addDays(start, 14 + targetIso - 1)), kind: 'week-next-next', ambiguous: false }
  if (mode === 'next') return { date: ymd(addDays(start, 7 + targetIso - 1)), kind: 'week-next', ambiguous: false }
  const current = addDays(start, targetIso - 1)
  if (mode === 'current') {
    return { date: ymd(current), kind: 'week-current', ambiguous: false, past: calendarDay(current) < calendarDay(message) }
  }
  let target = current
  if (calendarDay(target) < calendarDay(message)) target = addDays(target, 7)
  return { date: ymd(target), kind: 'week-auto', ambiguous: calendarDay(target) === calendarDay(message) }
}

function monthEnd(monthOffset, message) {
  const month = addMonths({ y: message.y, m: message.m, d: 1 }, monthOffset)
  const last = lastDayOfMonth(month.y, month.m)
  return { date: `${month.y}-${pad(month.m)}-${pad(last)}`, kind: monthOffset ? 'month-end-next' : 'month-end', ambiguous: monthOffset === 0 && message.d === last }
}

function quarterEnd(offset, message) {
  const startMonth = Math.ceil(message.m / 3) * 3 + offset * 3
  const total = message.y * 12 + (startMonth - 1)
  const y = Math.floor(total / 12)
  const m = (total % 12) + 1
  const last = lastDayOfMonth(y, m)
  return { date: `${y}-${pad(m)}-${pad(last)}`, kind: offset ? 'quarter-end-next' : 'quarter-end', ambiguous: false }
}

function yearEnd(offset, message) {
  const y = message.y + offset
  return { date: `${y}-12-31`, kind: offset ? 'year-end-next' : 'year-end', ambiguous: offset === 0 && message.m === 12 && message.d === 31 }
}

function endOfWeek(offset, message) {
  const start = addDays(weekStart(message), offset * 7)
  const sunday = addDays(start, 6)
  return { date: ymd(sunday), kind: offset ? 'week-end-next' : 'week-end', ambiguous: false }
}

/** All relative-date patterns. More specific patterns come first. */
const PATTERNS = [
  // 2027年1月10日 / 2027-01-10 / 2027.1.10
  {
    re: /(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*[日号]?/g,
    resolve: (match, message) => explicitDate(Number(match[1]), Number(match[2]), Number(match[3]), { message, hasYear: true }),
  },
  // 11月13日 / 11月13号
  {
    re: /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g,
    resolve: (match, message) => explicitDate(message.y, Number(match[1]), Number(match[2]), { message, hasYear: false }),
  },
  // 11/13
  {
    re: /(?<![\d/])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/g,
    resolve: (match, message) => explicitDate(message.y, Number(match[1]), Number(match[2]), { message, hasYear: false }),
  },
  { re: /大后天/g, resolve: (_m, message) => ({ date: ymd(addDays(message, 3)), kind: 'day+3', ambiguous: false }) },
  { re: /(?<!大)后天/g, resolve: (_m, message) => ({ date: ymd(addDays(message, 2)), kind: 'day+2', ambiguous: false }) },
  { re: /明天|明日|明早|明晚|明儿/g, resolve: (_m, message) => ({ date: ymd(addDays(message, 1)), kind: 'day+1', ambiguous: false }) },
  { re: /今天|今日|今早|今晚|本日/g, resolve: (_m, message) => ({ date: ymd(message), kind: 'day+0', ambiguous: false }) },
  {
    re: /下下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/g,
    resolve: (match, message) => weekdayDate(WEEKDAY_INDEX[match[1]], 'next-next', message),
  },
  {
    re: /(?<!下)下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/g,
    resolve: (match, message) => weekdayDate(WEEKDAY_INDEX[match[1]], 'next', message),
  },
  {
    re: /(?:本|这)(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/g,
    resolve: (match, message) => weekdayDate(WEEKDAY_INDEX[match[1]], 'current', message),
  },
  {
    re: /(?<![下本这个每上])(?:周|星期|礼拜)([一二三四五六日天])/g,
    resolve: (match, message) => weekdayDate(WEEKDAY_INDEX[match[1]], 'auto', message),
  },
  // 下下个月底 / 下下月底
  {
    re: /(?<!下)下下(?:个)?月(?:底|末)/g,
    resolve: (_m, message) => monthEnd(2, message),
  },
  // 下个月底 / 下月底 / 下月末
  {
    re: /(?<!下)下(?:个)?月(?:底|末)/g,
    resolve: (_m, message) => monthEnd(1, message),
  },
  // 2026年10月底 / 2026年10月末
  {
    re: /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(?:底|末)/g,
    resolve: (match) => {
      const year = Number(match[1]); const month = Number(match[2])
      if (month < 1 || month > 12) return null
      const last = lastDayOfMonth(year, month)
      return { date: `${year}-${pad(month)}-${pad(last)}`, kind: 'month-end-explicit', ambiguous: false }
    },
  },
  // 10月底 / 10月末 (numeric month)
  {
    re: /(?<!年)(\d{1,2})\s*月\s*(?:底|末)/g,
    resolve: (match, message) => {
      const month = Number(match[1])
      if (month < 1 || month > 12) return null
      const year = month < message.m ? message.y + 1 : message.y
      const last = lastDayOfMonth(year, month)
      return { date: `${year}-${pad(month)}-${pad(last)}`, kind: 'month-end-explicit', ambiguous: false }
    },
  },
  // 本月底 / 这个月底 / 月底 / 月末
  {
    re: /(?<![下个\d])(?:本|这个)?月(?:底|末)/g,
    resolve: (_m, message) => monthEnd(0, message),
  },
  // 下季度末 / 下季末
  {
    re: /(?<!下)下(?:个)?季(?:度)?末/g,
    resolve: (_m, message) => quarterEnd(1, message),
  },
  // 本季度末 / 季度末 / 季末
  {
    re: /(?<![下个])(?:本|这个)?季(?:度)?末/g,
    resolve: (_m, message) => quarterEnd(0, message),
  },
  // 2027年底 / 2027年末
  {
    re: /(\d{4})\s*年\s*(?:底|末)/g,
    resolve: (match) => ({ date: `${Number(match[1])}-12-31`, kind: 'year-end-explicit', ambiguous: false }),
  },
  // 明年底 / 明年末 / 明年年末
  {
    re: /明(?:年)?(?:年)?[底末]/g,
    resolve: (_m, message) => yearEnd(1, message),
  },
  // 今年底 / 本年底 / 年底 / 年末
  {
    re: /(?<!明)(?<!下)(?<!\d)(?:本|今|今年)?年底|(?<!明)(?<!\d)(?:本|今)?年末/g,
    resolve: (_m, message) => yearEnd(0, message),
  },
  // N 天后 / N 天之后 / N 天以后
  {
    re: /(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*天(?:后|之后|以后)/g,
    resolve: (match, message) => {
      const n = parseNumber(match[1])
      return n == null ? null : { date: ymd(addDays(message, n)), kind: 'days-after', ambiguous: false }
    },
  },
  // N 周后 / N 个星期后 / N 礼拜后
  {
    re: /(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(?:周|个?星期|礼拜)(?:后|之后|以后)/g,
    resolve: (match, message) => {
      const n = parseNumber(match[1])
      return n == null ? null : { date: ymd(addDays(message, n * 7)), kind: 'weeks-after', ambiguous: false }
    },
  },
  // N 个月后
  {
    re: /(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*个?月(?:后|之后|以后)/g,
    resolve: (match, message) => {
      const n = parseNumber(match[1])
      return n == null ? null : { date: ymd(addMonths(message, n)), kind: 'months-after', ambiguous: false }
    },
  },
  // 半个月后
  {
    re: /半个?月(?:后|之后|以后)/g,
    resolve: (_m, message) => ({ date: ymd(addDays(message, 15)), kind: 'half-month-after', ambiguous: true }),
  },
  // 本周内 / 这周内 / 下周内 / 本月内 / 下月内
  {
    re: /(?<!下)(?:本|这)(?:个)?(?:周|星期|礼拜)(?:内|之前|以前)/g,
    resolve: (_m, message) => endOfWeek(0, message),
  },
  {
    re: /(?<!下)下(?:个)?(?:周|星期|礼拜)(?:内|之前|以前)/g,
    resolve: (_m, message) => endOfWeek(1, message),
  },
  {
    re: /(?<!下)(?:本|这个)月(?:内|之前|以前)/g,
    resolve: (_m, message) => monthEnd(0, message),
  },
  {
    re: /(?<!下)下个?月(?:内|之前|以前)/g,
    resolve: (_m, message) => monthEnd(1, message),
  },
]

/** Every expression the patterns resolve in `source`, with a conflict flag. */
function scanRelativeDates(source, messageDate, { timeZone = TIME_ZONE } = {}) {
  const message = localParts(messageDate, timeZone)
  const time = clockFromText(source)
  const found = []
  for (const { re, resolve } of PATTERNS) {
    for (const match of source.matchAll(re)) {
      const result = resolve(match, message)
      if (!result) continue
      found.push({ ...result, time, matched: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })
    }
  }
  return { found, conflict: new Set(found.map((item) => item.date)).size > 1 }
}

/** Earliest candidate; ambiguous when any candidate on that date was. */
function pickRelativeDate(found) {
  found.sort((a, b) => a.start - b.start)
  const chosen = { ...found[0] }
  for (const item of found) if (item.ambiguous) chosen.ambiguous = true
  return chosen
}

/**
 * Resolve the first unambiguous relative date in `text` against the message
 * time. Returns null when nothing is found or when expressions conflict.
 */
export function resolveRelativeDate(text, messageDate = new Date(), { timeZone = TIME_ZONE } = {}) {
  const source = String(text ?? '')
  if (!source) return null
  const { found, conflict } = scanRelativeDates(source, messageDate, { timeZone })
  if (!found.length || conflict) return null // conflicting expressions: let the model decide
  return pickRelativeDate(found)
}

/**
 * Correct a model-provided dueAt with the deterministic resolver.
 * - No resolvable expression: keep a valid model dueAt as-is (`basis: 'model'`).
 * - Resolvable expression: force the resolved local date, keep model time-of-day
 *   when the model's date was different but its time was meaningful.
 */
export function normalizeDue({ dueAt, quote, text, messageDate = new Date(), timeZone = TIME_ZONE } = {}) {
  const modelDue = dueAt && Number.isFinite(Date.parse(dueAt)) ? new Date(Date.parse(dueAt)) : null
  const sources = [quote, text].filter((value, index, all) => value && all.indexOf(value) === index)
  let resolved = null
  let matchedSource = null
  for (const source of sources) {
    const result = resolveRelativeDate(source, messageDate, { timeZone })
    if (result) {
      resolved = result
      matchedSource = source
      break
    }
  }
  if (!resolved) {
    return {
      dueAt: modelDue ? modelDue.toISOString() : undefined,
      basis: modelDue ? 'model' : undefined,
      resolved: null,
      ambiguous: false,
    }
  }
  if (modelDue) {
    const local = localParts(modelDue, timeZone)
    if (local.date === resolved.date) {
      return { dueAt: modelDue.toISOString(), basis: 'rule', resolved, matchedSource, ambiguous: resolved.ambiguous }
    }
    const time = local.hh === 0 && local.mm === 0 ? resolved.time : `${pad(local.hh)}:${pad(local.mm)}`
    return {
      dueAt: new Date(`${resolved.date}T${time}:00+08:00`).toISOString(),
      basis: 'rule',
      resolved,
      matchedSource,
      ambiguous: resolved.ambiguous,
    }
  }
  return {
    dueAt: new Date(`${resolved.date}T${resolved.time}:00+08:00`).toISOString(),
    basis: 'rule',
    resolved,
    matchedSource,
    ambiguous: resolved.ambiguous,
  }
}

const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/

/** UTC milliseconds for wall-clock parts; avoids Date.UTC's 0-99 -> 19xx map. */
function wallClockUtcMillis(year, month, day, hour, minute, second = 0, milli = 0) {
  const iso = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.${String(milli).padStart(3, '0')}Z`
  return Date.parse(iso)
}

/** UTC offset (minutes) of `timeZone` at the wall clock `date` `time`. */
function zoneOffsetMinutes(date, time, timeZone) {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const asUtc = wallClockUtcMillis(year, month, day, hour, minute)
  const wall = localParts(new Date(asUtc), timeZone)
  return Math.round((wallClockUtcMillis(wall.y, wall.m, wall.d, wall.hh, wall.mm) - asUtc) / 60_000)
}

/** `YYYY-MM-DDTHH:MM:00±hh:mm` for the wall clock in `timeZone`. */
function isoWithZoneOffset(date, time, timeZone) {
  const offset = zoneOffsetMinutes(date, time, timeZone)
  const abs = Math.abs(offset)
  return `${date}T${time}:00${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** Calendar day (in `timeZone`) for an ISO date-time match, or null if invalid. */
function calendarForIsoDateTime(match, timeZone) {
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const hour = Number(match[4]); const minute = Number(match[5])
  const second = match[6] == null ? 0 : Number(match[6])
  const milli = match[7] == null ? 0 : Number(match[7].slice(0, 3).padEnd(3, '0'))
  if (!validCalendarDate(year, month, day)) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  const offsetHour = match[10] == null ? 0 : Number(match[10])
  const offsetMinute = match[11] == null ? 0 : Number(match[11])
  if (offsetHour > 23 || offsetMinute > 59) return null
  if (match[8] == null && match[9] == null) return `${match[1]}-${match[2]}-${match[3]}`
  const offsetMs = (match[9] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60_000
  const instant = wallClockUtcMillis(year, month, day, hour, minute, second, milli) - offsetMs
  if (!Number.isFinite(instant)) return null
  return localParts(new Date(instant), timeZone).date
}

function dueSuccess({ at, calendar, basis, matched, ambiguous }) {
  return { ok: true, at, calendar, basis, matched, ambiguous, conflict: false }
}

function dueFailure(reason, found = []) {
  return { ok: false, reason, detail: { found } }
}

/**
 * Resolve a CLI `--due` value into a concrete due instant or a refusal.
 *
 * - `YYYY-MM-DD` (basis 'iso-date'): that calendar day at 18:00 in the anchor
 *   zone; `at` is a local ISO string with an explicit offset.
 * - ISO date-times and other `Date.parse`-able strings (basis 'iso'): passed
 *   through byte-for-byte (`at` === trimmed input), preserving 0.4.2 callers
 *   that already pass ISO; `calendar` is the anchor zone's calendar day.
 * - Chinese relative expressions (basis 'rule'): same PATTERNS/anchor/time-of-day
 *   as `resolveRelativeDate`; `at` is `calendar` + resolved time with offset.
 * - Different dates in one value -> `{ok:false, reason:'conflict', detail:{found}}`.
 * - Nothing understood (尽快/asap/工作日/农历/两周内/下周) -> reason 'unresolved'
 *   with `found: []`. Callers must error, never guess or store the raw string.
 *
 * `matched` is the matched expression for rules and the whole input for ISO
 * passthrough. `ambiguous` mirrors `resolveRelativeDate` (same-day 周五前,
 * month-end day, 半个月后) and never blocks resolution.
 */
export function resolveDueInput(raw, { now = new Date(), timeZone = TIME_ZONE } = {}) {
  const source = String(raw ?? '').trim()
  if (!source) return dueFailure('unresolved')

  const dateOnly = ISO_DATE_ONLY.exec(source)
  if (dateOnly) {
    const [year, month, day] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])]
    if (!validCalendarDate(year, month, day)) return dueFailure('unresolved')
    return dueSuccess({ at: isoWithZoneOffset(source, DEFAULT_TIME, timeZone), calendar: source, basis: 'iso-date', matched: source, ambiguous: false })
  }

  // Date + time is ISO territory: never let Date.parse normalise 2026-02-30 to
  // March and never treat a malformed time as a relative expression.
  const dateTime = ISO_DATE_TIME.exec(source)
  if (dateTime || /^\d{4}-\d{2}-\d{2}[T ]/.test(source)) {
    const calendar = dateTime ? calendarForIsoDateTime(dateTime, timeZone) : null
    if (!calendar) return dueFailure('unresolved')
    return dueSuccess({ at: source, calendar, basis: 'iso', matched: source, ambiguous: false })
  }

  const parsedMillis = Date.parse(source)
  if (Number.isFinite(parsedMillis)) {
    return dueSuccess({ at: source, calendar: localParts(new Date(parsedMillis), timeZone).date, basis: 'iso', matched: source, ambiguous: false })
  }

  const { found, conflict } = scanRelativeDates(source, now, { timeZone })
  if (!found.length) return dueFailure('unresolved')
  if (conflict) {
    const ordered = [...found].sort((a, b) => a.start - b.start)
    return dueFailure('conflict', [...new Set(ordered.map((item) => item.date))])
  }
  const resolved = pickRelativeDate(found)
  return dueSuccess({ at: isoWithZoneOffset(resolved.date, resolved.time, timeZone), calendar: resolved.date, basis: 'rule', matched: resolved.matched, ambiguous: resolved.ambiguous })
}
