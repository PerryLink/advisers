import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDue, resolveDueInput, resolveRelativeDate } from '../lib/relative-date.js'

// Fixed command-execution anchor from the 0.4.3 plan: Sunday 2026-11-22 10:00
// Asia/Shanghai. No test depends on the machine wall clock or its time zone.
const ANCHOR = new Date('2026-11-22T10:00:00+08:00')
const SUCCESS_KEYS = ['ambiguous', 'at', 'basis', 'calendar', 'conflict', 'matched', 'ok']
const due = (raw, now = ANCHOR) => resolveDueInput(raw, { now })

test('resolveDueInput resolves Chinese relative dates against the Shanghai anchor', () => {
  const cases = [
    ['今天', '2026-11-22'],
    ['明天发', '2026-11-23'],
    ['后天发', '2026-11-24'],
    ['大后天发', '2026-11-25'],
    ['下周三前', '2026-11-25'],
    ['本周五前', '2026-11-20'], // past days of the current week are kept as-is (resolver semantics)
    ['月底前', '2026-11-30'],
    ['本季度末', '2026-12-31'],
    ['明年底', '2027-12-31'],
    ['11月28日', '2026-11-28'],
    ['2027年1月10日', '2027-01-10'],
    ['3 天后', '2026-11-25'],
    ['两周后', '2026-12-06'],
    ['三个月后', '2027-02-22'],
  ]
  for (const [raw, calendar] of cases) {
    const result = due(raw)
    assert.deepEqual(Object.keys(result).sort(), SUCCESS_KEYS, raw)
    assert.equal(result.ok, true, raw)
    assert.equal(result.basis, 'rule', raw)
    assert.equal(result.calendar, calendar, raw)
    assert.equal(result.at, `${calendar}T18:00:00+08:00`, raw)
    assert.equal(result.ambiguous, false, raw)
    assert.equal(result.conflict, false, raw)
  }
  // The 0.4.3 headline acceptance case (100-release-sequencing §2, 043-1).
  const nextWednesday = due('下周三前')
  assert.equal(nextWednesday.matched, '下周三')
  assert.equal(Date.parse(nextWednesday.at), Date.parse('2026-11-25T18:00:00+08:00'))
})

test('resolveDueInput keeps an explicit time-of-day for relative expressions', () => {
  const result = due('下周三下午3点半前')
  assert.equal(result.calendar, '2026-11-25')
  assert.equal(result.at, '2026-11-25T15:30:00+08:00')
})

test('resolveDueInput anchors on the Asia/Shanghai day, never the UTC day', () => {
  // 2026-11-21T18:00Z is already 2026-11-22 02:00 in Shanghai.
  assert.equal(due('今天', new Date('2026-11-21T18:00:00Z')).calendar, '2026-11-22')
  assert.equal(due('明天', new Date('2026-11-21T18:00:00Z')).calendar, '2026-11-23')
  // 2026-11-22T16:30Z is 2026-11-23 00:30 in Shanghai.
  assert.equal(due('今天', new Date('2026-11-22T16:30:00Z')).calendar, '2026-11-23')
})

test('resolveDueInput reports ambiguity without blocking resolution', () => {
  const friday = due('周五前', new Date('2026-11-27T10:00:00+08:00'))
  assert.equal(friday.ok, true)
  assert.equal(friday.calendar, '2026-11-27')
  assert.equal(friday.ambiguous, true)

  const monthEnd = due('月底前', new Date('2026-11-30T10:00:00+08:00'))
  assert.equal(monthEnd.calendar, '2026-11-30')
  assert.equal(monthEnd.ambiguous, true)

  assert.equal(due('半个月后').ambiguous, true)
})

test('resolveDueInput turns date-only ISO into that day 18:00 Asia/Shanghai', () => {
  const result = due('2026-11-25')
  assert.deepEqual(Object.keys(result).sort(), SUCCESS_KEYS)
  assert.equal(result.ok, true)
  assert.equal(result.basis, 'iso-date')
  assert.equal(result.at, '2026-11-25T18:00:00+08:00')
  assert.equal(result.calendar, '2026-11-25')
  assert.equal(result.ambiguous, false)
  assert.equal(result.conflict, false)
})

test('resolveDueInput passes ISO date-times through byte-for-byte', () => {
  const cases = [
    ['2026-11-25T10:00:00Z', '2026-11-25'], // already 18:00 in Shanghai
    ['2026-11-25T20:00:00Z', '2026-11-26'], // Shanghai calendar day of the same instant
    ['2026-11-25T18:00:00+08:00', '2026-11-25'],
    ['2026-11-25T18:00', '2026-11-25'], // zone-less ISO keeps the written day
  ]
  for (const [raw, calendar] of cases) {
    const result = due(raw)
    assert.equal(result.ok, true, raw)
    assert.equal(result.basis, 'iso', raw)
    assert.equal(result.at, raw, raw) // 0.4.2 callers keep their exact string
    assert.equal(result.calendar, calendar, raw)
  }
})

test('resolveDueInput passes other Date.parse-able strings through unchanged', () => {
  const result = due('Wed, 25 Nov 2026 10:00:00 GMT')
  assert.equal(result.ok, true)
  assert.equal(result.basis, 'iso')
  assert.equal(result.at, 'Wed, 25 Nov 2026 10:00:00 GMT')
  assert.equal(result.calendar, '2026-11-25') // 10:00Z = 18:00 Shanghai
})

test('resolveDueInput refuses invalid calendar dates instead of normalising them', () => {
  // new Date('2026-02-30') silently rolls to March 2; a due date must not.
  for (const raw of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-11-25T25:00:00Z']) {
    const result = due(raw)
    assert.equal(result.ok, false, raw)
    assert.equal(result.reason, 'unresolved', raw)
    assert.deepEqual(result.detail, { found: [] }, raw)
  }
})

test('resolveDueInput separates conflicting dates from unknown input', () => {
  const conflict = due('下周三或月底前')
  assert.deepEqual(Object.keys(conflict).sort(), ['detail', 'ok', 'reason'])
  assert.equal(conflict.ok, false)
  assert.equal(conflict.reason, 'conflict')
  assert.deepEqual(conflict.detail.found, ['2026-11-25', '2026-11-30'])

  for (const raw of ['尽快', 'asap', '两个工作日', '两周内', '农历十月初一', '下周', '', '   ']) {
    const result = due(raw)
    assert.equal(result.ok, false, raw)
    assert.equal(result.reason, 'unresolved', raw)
    assert.deepEqual(result.detail.found, [], raw)
  }
})

test('resolveDueInput honours an explicit timeZone for the anchor and offset', () => {
  // 2026-11-22T00:30Z is still 2026-11-21 in Shanghai but 2026-11-22 in UTC.
  const result = resolveDueInput('今天', { now: new Date('2026-11-22T00:30:00Z'), timeZone: 'UTC' })
  assert.equal(result.calendar, '2026-11-22')
  assert.equal(result.at, '2026-11-22T18:00:00+00:00')
})

test('resolveDueInput leaves resolveRelativeDate/normalizeDue behaviour unchanged', () => {
  const relative = resolveRelativeDate('下周三前', ANCHOR)
  assert.equal(relative.date, '2026-11-25')
  assert.equal(relative.time, '18:00')
  assert.equal(relative.ambiguous, false)
  // capture still treats conflicting expressions as "let the model decide".
  assert.equal(resolveRelativeDate('下周三或月底前', ANCHOR), null)
  const normalized = normalizeDue({ quote: '下周三前发', messageDate: ANCHOR })
  assert.equal(normalized.dueAt, '2026-11-25T10:00:00.000Z')
  assert.equal(normalized.basis, 'rule')
})
