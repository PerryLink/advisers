import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_TIMEZONE,
  MAX_HUMAN_TOP,
  MODEL_VERSION,
  TERM_IDS,
  URGENCY_LEVELS,
  attachUrgency,
  buildRemindPayload,
  computeUrgency,
  describeWhyNow,
  levelForScore,
  localDayOfInstant,
  parseDueValue,
  scoreUrgency,
  selectTopUrgent,
} from '../lib/urgency.js'

const NOW = '2026-11-21T09:00:00+08:00'
const NOW_MS = Date.parse(NOW)
const DAY_MS = 86400000

function urgencyOf(item, now = NOW, timezone) {
  return scoreUrgency(item, { now, timezone })
}

function termMap(score) {
  return Object.fromEntries(score.terms.map((term) => [term.id, term.contribution]))
}

test('urgency v1 matches the frozen reference cases from the 0.4 research', () => {
  const overdue = urgencyOf({ id: 'c1', action: 'x', debtor: 'user', dueAt: '2026-11-18T18:00:00+08:00' })
  assert.equal(overdue.modelVersion, MODEL_VERSION)
  assert.equal(overdue.score, 44)
  assert.equal(overdue.level, 'medium')
  assert.deepEqual(overdue.terms.map((term) => term.id), ['overdue', 'mine', 'timed'])
  assert.deepEqual(termMap(overdue), { overdue: 36, mine: 6, timed: 2 })
  assert.deepEqual(overdue.topFactors, ['overdue', 'mine', 'timed'])
  assert.equal(overdue.whyNow, '逾期 3 天 · 你答应对方 · 有具体时刻')
  assert.equal(overdue.dueAt, '2026-11-18T10:00:00.000Z')
  assert.equal(overdue.degraded, null)
  assert.equal(overdue.excluded, false)

  const old = urgencyOf({ id: 'c2', debtor: 'user', dueAt: '2026-10-22T18:00:00+08:00', reminderOffsets: ['-1d', '-2h'] })
  assert.equal(old.score, 62)
  assert.equal(old.level, 'high')

  const today = urgencyOf({ id: 'c3', debtor: 'user', dueAt: '2026-11-21T18:00:00+08:00' })
  assert.equal(today.score, 38)
  assert.equal(today.level, 'medium')

  const upcoming = urgencyOf({ id: 'c4', debtor: 'third:client', dueAt: '2026-11-28' })
  assert.equal(upcoming.score, 13)
  assert.equal(upcoming.level, 'low')
  assert.deepEqual(termMap(upcoming), { due_near: 3, third: 10 })
})

test('score is exactly the sum of terms, 0..100 clamped, with a stable shape', () => {
  const debtors = [null, 'user', 'agent', 'third', 'third:client', 'other']
  const statuses = [undefined, 'open', 'done', 'dropped', 'snoozed']
  for (let dayOffset = -40; dayOffset <= 10; dayOffset += 1) {
    const dueAt = new Date(NOW_MS + dayOffset * DAY_MS).toISOString()
    for (const debtor of debtors) {
      for (const status of statuses) {
        const item = { id: 'x', action: 'a', dueAt, debtor, status, reminderOffsets: dayOffset % 3 === 0 ? ['-1d', '-2h', '+1d'] : [] }
        const score = urgencyOf(item)
        assert.equal(score.modelVersion, MODEL_VERSION)
        const excluded = status === 'done' || status === 'dropped' || status === 'snoozed'
        assert.equal(score.excluded, excluded)
        if (excluded) {
          assert.equal(score.score, 0)
          assert.deepEqual(score.terms, [])
          assert.equal(score.degraded, null)
          continue
        }
        const sum = score.terms.reduce((total, term) => total + term.contribution, 0)
        assert.equal(score.score, sum, 'sum(terms) must equal score')
        assert.ok(score.score >= 0 && score.score <= 100)
        assert.equal(score.level, levelForScore(score.score))
        assert.ok(URGENCY_LEVELS.includes(score.level))
        const ids = score.terms.map((term) => term.id)
        assert.equal(new Set(ids).size, ids.length, 'term ids are unique')
        for (const id of ids) assert.ok(TERM_IDS.includes(id))
        for (const term of score.terms) {
          assert.ok(Number.isInteger(term.contribution) && term.contribution > 0)
          assert.equal(typeof term.explain, 'string')
          assert.ok(!/secrecy/i.test(term.explain))
        }
        assert.equal(score.whyNow, describeWhyNow(score.terms))
        assert.ok(Array.from(score.whyNow).length <= 200)
      }
    }
  }
})

test('determinism: identical inputs are byte-identical, same local day is stable, order independent', () => {
  const item = { id: 'c1', debtor: 'user', dueAt: '2026-11-21T18:00:00+08:00', createdAt: '2026-10-01T10:00:00+08:00', reminderOffsets: ['-1d'] }
  const first = JSON.stringify(computeUrgency({ items: [item], now: NOW }))
  const second = JSON.stringify(computeUrgency({ items: [item], now: NOW }))
  assert.equal(first, second)

  const morning = urgencyOf(item, '2026-11-21T09:00:00+08:00')
  const lateMorning = urgencyOf(item, '2026-11-21T11:30:00+08:00')
  assert.deepEqual(morning, lateMorning, 'same local day must not change urgency')

  const a = { id: 'a', dueAt: '2026-11-21T18:00:00+08:00' }
  const b = { id: 'b', dueAt: '2026-11-23T18:00:00+08:00' }
  const forward = computeUrgency({ items: [a, b], now: NOW })
  const reverse = computeUrgency({ items: [b, a], now: NOW })
  assert.deepEqual(forward, [...reverse].reverse())
})

test('dirty data degrades without throwing while invalid options still throw', () => {
  for (const item of [null, {}, { id: 'x' }, { id: 'x', dueAt: 'not-a-date' }, { id: 'x', dueAt: '' }, [1, 2, 3], 'string']) {
    const score = urgencyOf(item)
    assert.equal(score.score, 0)
    assert.equal(score.level, 'low')
    assert.deepEqual(score.terms, [])
    assert.equal(score.whyNow, '')
    assert.equal(score.modelVersion, MODEL_VERSION)
    assert.equal(score.degraded, 'urgency_failed')
  }
  assert.throws(() => scoreUrgency({ dueAt: NOW }, { now: 'bad-now' }), RangeError)
  assert.throws(() => scoreUrgency({ dueAt: NOW }, { now: NOW, timezone: 'Mars/Olympus' }), RangeError)
  assert.throws(() => computeUrgency({ items: 'nope', now: NOW }), TypeError)
  assert.throws(() => attachUrgency('nope', { now: NOW }), TypeError)
  assert.throws(() => selectTopUrgent('nope'), TypeError)
})

test('excluded statuses score zero without a degradation warning', () => {
  for (const status of ['done', 'dropped', 'snoozed']) {
    const score = urgencyOf({ id: 'c1', status, dueAt: '2026-11-18T18:00:00+08:00' })
    assert.equal(score.excluded, true)
    assert.equal(score.score, 0)
    assert.deepEqual(score.terms, [])
    assert.equal(score.degraded, null)
  }
})

test('secrecy and content never participate in the score or leak into whyNow', () => {
  const base = { id: 'c1', action: '绝密行动', debtor: 'user', dueAt: '2026-11-21T18:00:00+08:00' }
  const openScore = urgencyOf({ ...base, secrecy: 0 })
  const secretScore = urgencyOf({ ...base, secrecy: 3, matterId: 'm1', creditor: '客户甲', quote: '私密引文' })
  assert.deepEqual(secretScore, openScore)
  const serialized = JSON.stringify(secretScore)
  for (const forbidden of ['secrecy', '绝密行动', '客户甲', '私密引文']) {
    assert.ok(!serialized.includes(forbidden), 'urgency must not contain ' + forbidden)
  }
})

test('level boundaries are pinned', () => {
  assert.equal(levelForScore(0), 'low')
  assert.equal(levelForScore(24), 'low')
  assert.equal(levelForScore(25), 'medium')
  assert.equal(levelForScore(49), 'medium')
  assert.equal(levelForScore(50), 'high')
  assert.equal(levelForScore(74), 'high')
  assert.equal(levelForScore(75), 'critical')
  assert.equal(levelForScore(100), 'critical')
  assert.equal(levelForScore(-5), 'low')
  assert.equal(levelForScore(500), 'critical')
  assert.equal(levelForScore(Number.NaN), 'low')
})

test('due_near is monotone over the 1..7 day horizon and stops after it', () => {
  const expected = [21, 18, 15, 12, 9, 6, 3]
  for (let days = 1; days <= 7; days += 1) {
    const dueAt = new Date(NOW_MS + days * DAY_MS).toISOString()
    const score = urgencyOf({ dueAt })
    assert.equal(termMap(score).due_near, expected[days - 1], 'day ' + days)
    assert.equal(termMap(score).due_today, undefined)
    assert.equal(termMap(score).overdue, undefined)
  }
  const ninth = urgencyOf({ dueAt: new Date(NOW_MS + 8 * DAY_MS).toISOString() })
  assert.equal(termMap(ninth).due_near, undefined, 'outside the 7-day horizon there is no due_near term')
  assert.equal(ninth.score, 2, 'only the concrete-time term remains')
})

test('overdue contribution grows with whole local days and caps at 50', () => {
  const cases = [[1, 32], [2, 34], [5, 40], [10, 50], [30, 50]]
  for (const [days, expected] of cases) {
    const dueAt = new Date(NOW_MS - days * DAY_MS).toISOString()
    const score = urgencyOf({ dueAt })
    assert.equal(termMap(score).overdue, expected, days + ' days overdue')
    assert.equal(score.score, expected + 2)
  }
})

test('date-only dueAt means end of the local day, not overdue during that day', () => {
  const before = urgencyOf({ dueAt: '2026-11-21' }, '2026-11-21T23:00:00+08:00')
  assert.deepEqual(termMap(before), { due_today: 30 })
  const after = urgencyOf({ dueAt: '2026-11-21' }, '2026-11-22T00:00:01+08:00')
  assert.equal(termMap(after).overdue, 32)
  assert.equal(parseDueValue('2026-11-21', 'Asia/Shanghai').ms, Date.parse('2026-11-21T23:59:59.999+08:00'))
  assert.equal(parseDueValue('2026-11-21', 'UTC').ms, Date.parse('2026-11-21T23:59:59.999Z'))
})

test('timezone changes the local-day bucket deterministically', () => {
  const item = { id: 'c1', dueAt: '2026-11-20T15:00:00Z' }
  const utc = scoreUrgency(item, { now: '2026-11-20T16:00:00Z', timezone: 'UTC' })
  const shanghai = scoreUrgency(item, { now: '2026-11-20T16:00:00Z', timezone: 'Asia/Shanghai' })
  assert.equal(termMap(utc).overdue, 30, 'UTC: due one hour ago on the same UTC day')
  assert.equal(utc.score, 32)
  assert.equal(termMap(shanghai).overdue, 32, 'Asia/Shanghai: one local day late')
  assert.equal(shanghai.score, 34)
  assert.equal(localDayOfInstant(Date.parse('2026-11-20T16:00:00Z'), 'Asia/Shanghai'), '2026-11-21')
  assert.equal(localDayOfInstant(Date.parse('2026-11-20T16:00:00Z'), 'UTC'), '2026-11-20')
  assert.equal(localDayOfInstant(Date.parse('2026-11-20T16:00:00Z')), '2026-11-21', 'default timezone is Asia/Shanghai')
  assert.equal(DEFAULT_TIMEZONE, 'Asia/Shanghai')
})

test('max 3 is a presentation helper only: deterministic sort, no mutation', () => {
  const items = [
    { id: 'c', dueAt: '2026-11-22T10:00:00+08:00' },
    { id: 'a', dueAt: '2026-11-21T18:00:00+08:00' },
    { id: 'b', dueAt: '2026-11-21T18:00:00+08:00' },
    { id: 'd', dueAt: '2026-11-30' },
    { id: 'e', status: 'done', dueAt: '2026-11-01T10:00:00+08:00' },
  ]
  const attached = attachUrgency(items, { now: NOW })
  assert.equal(attached.length, 5)
  assert.ok(attached.every((entry) => entry.urgency && entry.urgency.modelVersion === MODEL_VERSION))
  assert.ok(items.every((entry) => entry.urgency === undefined), 'attachUrgency never mutates input items')
  const snapshot = JSON.stringify(attached)
  const top = selectTopUrgent(attached)
  assert.equal(top.length, MAX_HUMAN_TOP)
  assert.deepEqual(top.map((entry) => entry.id), ['a', 'b', 'c'])
  assert.equal(JSON.stringify(attached), snapshot, 'selectTopUrgent never mutates its input')
  assert.equal(selectTopUrgent(attached, { limit: 1 }).length, 1)
  assert.ok(!selectTopUrgent(attached).some((entry) => entry.id === 'e'), 'excluded items never enter the human top list')
  assert.throws(() => selectTopUrgent(attached, { limit: 0 }), RangeError)
  assert.throws(() => selectTopUrgent(attached, { limit: 1.5 }), RangeError)
})

test('remind JSON helper is additive, deterministic and never mutates rows', () => {
  const reminders = [
    { commitmentId: 'c1', action: '发报价', dueAt: '2026-11-21T18:00:00+08:00', bucket: 'due-today', level: 'L2', ruleId: 'due-today-09' },
    { commitmentId: 'c2', action: '等回复', dueAt: '2026-11-23', bucket: 'upcoming', level: 'L1', ruleId: 'upcoming' },
  ]
  const payload = buildRemindPayload(reminders, { now: NOW })
  assert.equal(payload.ok, true)
  assert.equal(payload.command, 'remind')
  assert.equal(payload.now, '2026-11-21T01:00:00.000Z')
  assert.equal(payload.timezone, DEFAULT_TIMEZONE)
  assert.deepEqual(Object.keys(payload).sort(), ['command', 'now', 'ok', 'reminders', 'timezone'])
  assert.equal(payload.reminders.length, 2)
  const [first, second] = payload.reminders
  assert.equal(first.commitmentId, 'c1')
  assert.equal(first.action, '发报价')
  assert.equal(first.level, 'L2')
  assert.equal(first.urgency.score, 32)
  assert.equal(second.urgency.degraded, null)
  assert.equal(JSON.stringify(buildRemindPayload(reminders, { now: NOW })), JSON.stringify(payload))
  assert.deepEqual(reminders.map((entry) => Object.keys(entry).sort()), [
    ['action', 'bucket', 'commitmentId', 'dueAt', 'level', 'ruleId'],
    ['action', 'bucket', 'commitmentId', 'dueAt', 'level', 'ruleId'],
  ], 'buildRemindPayload never mutates the reminder rows')
  const plain = buildRemindPayload(reminders, { now: NOW, includeUrgency: false })
  assert.ok(plain.reminders.every((entry) => entry.urgency === undefined))
  assert.throws(() => buildRemindPayload('nope', { now: NOW }), TypeError)
})

test('age, reminder-offset and timed terms follow the frozen table', () => {
  const base = { dueAt: '2026-11-25', allDay: true }
  assert.equal(termMap(urgencyOf({ ...base, createdAt: '2026-11-07T10:00:00+08:00' })).age, undefined, '14 days is not older than 14')
  assert.equal(termMap(urgencyOf({ ...base, createdAt: '2026-11-06T10:00:00+08:00' })).age, 1)
  assert.equal(termMap(urgencyOf({ ...base, createdAt: '2026-10-15T10:00:00+08:00' })).age, 4)
  assert.equal(termMap(urgencyOf({ ...base, createdAt: '2026-10-01T10:00:00+08:00' })).age, 6)
  assert.equal(termMap(urgencyOf({ dueAt: '2026-11-25', reminderOffsets: ['-1d'] })).remind_offsets, 2)
  const seven = ['-1d', '-2d', '+1h', '-3h', '+0d09:00', '-1d08:00', '+2d']
  assert.equal(termMap(urgencyOf({ dueAt: '2026-11-25', reminderOffsets: seven })).remind_offsets, 6)
  assert.equal(termMap(urgencyOf({ dueAt: '2026-11-22', allDay: true })).timed, undefined)
  assert.equal(termMap(urgencyOf({ dueAt: '2026-11-22T10:00:00+08:00' })).timed, 2)
  assert.equal(termMap(urgencyOf({ at: '2026-11-22T02:00:00.000Z', allDay: true })).timed, undefined)
  assert.equal(termMap(urgencyOf({ at: '2026-11-22T02:00:00.000Z', allDay: false })).timed, 2)
})

test('whyNow joins explanations and caps at 200 code points', () => {
  assert.equal(describeWhyNow([]), '')
  assert.equal(describeWhyNow([{ explain: '逾期 3 天' }, { explain: '你答应对方' }]), '逾期 3 天 · 你答应对方')
  const long = describeWhyNow([{ explain: '紧'.repeat(150) }, { explain: '急'.repeat(150) }])
  assert.equal(Array.from(long).length, 200)
  const emoji = describeWhyNow([{ explain: '😀'.repeat(300) }])
  assert.equal(Array.from(emoji).length, 200)
})

test('an optional records lookup restores debtor/createdAt/offsets for derived items', () => {
  // A morning/agenda commitment item only carries derived display fields.
  const item = { id: 'c1', kind: 'commitment', title: 'x', allDay: false, at: '2026-11-21T10:00:00.000Z', localDate: '2026-11-21', localTime: '18:00' }
  const plain = scoreUrgency(item, { now: NOW })
  assert.deepEqual(plain.terms.map((term) => term.id), ['due_today', 'timed'])
  assert.equal(plain.score, 32)

  const record = { id: 'c1', debtor: 'third:client', createdAt: '2026-10-01T10:00:00+08:00', reminderOffsets: ['-1d', '-2h'] }
  const byMap = scoreUrgency(item, { now: NOW, records: new Map([['c1', record]]) })
  assert.deepEqual(byMap.terms.map((term) => term.id), ['due_today', 'third', 'remind_offsets', 'age', 'timed'])
  assert.equal(termMap(byMap).third, 10)
  assert.equal(termMap(byMap).remind_offsets, 4)
  assert.equal(termMap(byMap).age, 6)
  assert.equal(byMap.score, 52)
  assert.equal(byMap.level, 'high')

  // An object keyed by id and a function lookup behave the same.
  assert.deepEqual(scoreUrgency(item, { now: NOW, records: { c1: record } }), byMap)
  assert.deepEqual(scoreUrgency(item, { now: NOW, records: (id) => (id === 'c1' ? record : null) }), byMap)

  // Item-level fields win over the record, so a caller can always override.
  const overridden = scoreUrgency({ ...item, debtor: 'user' }, { now: NOW, records: { c1: record } })
  assert.equal(termMap(overridden).mine, 6)
  assert.equal(termMap(overridden).third, undefined)

  // attachUrgency / computeUrgency forward the lookup; unknown ids are ignored.
  const attached = attachUrgency([item, { id: 'missing', at: '2026-11-21T10:00:00.000Z' }], { now: NOW, records: { c1: record } })
  assert.equal(attached[0].urgency.score, 52)
  assert.deepEqual(attached[1].urgency.terms.map((term) => term.id), ['due_today', 'timed'])
  assert.throws(() => computeUrgency({ items: [item], now: NOW, records: [] }), TypeError)
})
test('the urgency module stays pure: no filesystem, network, sqlite or model imports', () => {
  const source = readFileSync(new URL('../lib/urgency.js', import.meta.url), 'utf8')
  for (const forbidden of ['node:fs', 'node:child_process', 'node:sqlite', 'node:http', 'node:https', 'node:net', 'better-sqlite3', 'fetch(', 'console.', 'process.env']) {
    assert.ok(!source.includes(forbidden), 'urgency.js must not reference ' + forbidden)
  }
})
test('parseDueValue accepts the storage formats and rejects dirty values', () => {
  assert.equal(parseDueValue('2026-11-21T18:00:00+08:00', 'Asia/Shanghai').ms, Date.parse('2026-11-21T18:00:00+08:00'))
  assert.equal(parseDueValue('2026-11-21 18:00', 'Asia/Shanghai').ms, Date.parse('2026-11-21T18:00:00+08:00'))
  assert.equal(parseDueValue('2026-11-21T18:00:00Z', 'Asia/Shanghai').ms, Date.parse('2026-11-21T18:00:00Z'))
  assert.equal(parseDueValue('2026-02-30', 'Asia/Shanghai'), null)
  assert.equal(parseDueValue('2026-11-21T25:00', 'Asia/Shanghai'), null)
  assert.equal(parseDueValue('garbage', 'Asia/Shanghai'), null)
  assert.equal(parseDueValue(null, 'Asia/Shanghai'), null)
  assert.equal(parseDueValue(new Date('2026-11-21T00:00:00Z'), 'Asia/Shanghai').ms, Date.parse('2026-11-21T00:00:00Z'))
})
