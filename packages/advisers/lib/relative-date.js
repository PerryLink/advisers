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
 * - 今天/明天/后天/大后天: message day + 0/1/2/3.
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
  { re: /今天|今日|今早|今晚|当天|本日/g, resolve: (_m, message) => ({ date: ymd(message), kind: 'day+0', ambiguous: false }) },
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

/**
 * Resolve the first unambiguous relative date in `text` against the message
 * time. Returns null when nothing is found or when expressions conflict.
 */
export function resolveRelativeDate(text, messageDate = new Date(), { timeZone = TIME_ZONE } = {}) {
  const source = String(text ?? '')
  if (!source) return null
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
  if (!found.length) return null
  const dates = new Set(found.map((item) => item.date))
  if (dates.size > 1) return null // conflicting expressions: let the model decide
  found.sort((a, b) => a.start - b.start)
  const chosen = { ...found[0] }
  for (const item of found) if (item.ambiguous) chosen.ambiguous = true
  return chosen
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
