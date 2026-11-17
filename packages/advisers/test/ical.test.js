import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_INSTANCES,
  SHANGHAI_TIMEZONE,
  expandRrule,
  parseRrule,
} from '../lib/ical.js'

const WEEKLY_TUE = {
  uid: 'cal-weekly-1',
  summary: '客户周会',
  startsAt: '2026-11-17T10:00:00',
  endsAt: '2026-11-17T11:00:00',
  allDay: false,
  tzid: 'Asia/Shanghai',
  location: '线上',
  rrule: 'FREQ=WEEKLY;COUNT=8',
}

const ALL_DAY_TUE = {
  uid: 'cal-allday-1',
  summary: '全天培训',
  startsAt: '2026-11-17',
  endsAt: '2026-11-18',
  allDay: true,
  rrule: 'FREQ=DAILY;COUNT=3',
}

/* ------------------------------------------------------------------ *
 * Core bug: recurring meetings must appear again after DTSTART.
 * ------------------------------------------------------------------ */

test('expandRrule: an 8-week weekly series is expandable at +7d', () => {
  // This is the regression test for "循环会议只出现一次": today --calendar
  // used to match only the stored DTSTART day. One week after DTSTART the
  // meeting must be visible again.
  assert.equal(SHANGHAI_TIMEZONE, 'Asia/Shanghai')
  const atPlus7d = expandRrule(WEEKLY_TUE, { from: '2026-11-24', to: '2026-11-24' })
  assert.equal(atPlus7d.length, 1)
  assert.equal(atPlus7d[0].startsAt, '2026-11-24T10:00:00+08:00')
  assert.equal(atPlus7d[0].endsAt, '2026-11-24T11:00:00+08:00')
  assert.equal(atPlus7d[0].seriesStartsAt, '2026-11-17T10:00:00+08:00')
  assert.equal(atPlus7d[0].summary, '客户周会')
  assert.equal(atPlus7d[0].location, '线上')
  assert.equal(atPlus7d[0].recurring, true)
  assert.equal(atPlus7d[0].occurrenceIndex, 0)

  const full = expandRrule(WEEKLY_TUE, { from: '2026-11-17', to: '2027-01-06' })
  assert.deepEqual(
    full.map((instance) => instance.startsAt),
    [
      '2026-11-17T10:00:00+08:00',
      '2026-11-24T10:00:00+08:00',
      '2026-12-01T10:00:00+08:00',
      '2026-12-08T10:00:00+08:00',
      '2026-12-15T10:00:00+08:00',
      '2026-12-22T10:00:00+08:00',
      '2026-12-29T10:00:00+08:00',
      '2027-01-05T10:00:00+08:00',
    ],
  )
})

test('expandRrule: a date-only window covers the whole Asia/Shanghai day', () => {
  assert.equal(expandRrule(WEEKLY_TUE, { from: '2026-11-17', to: '2026-11-17' }).length, 1)
  assert.equal(expandRrule(WEEKLY_TUE, { from: '2026-11-18', to: '2026-11-18' }).length, 0)
  // 23:30 Shanghai is still "today", not tomorrow in UTC.
  const late = { ...WEEKLY_TUE, startsAt: '2026-11-17T23:30:00', endsAt: '2026-11-18T00:30:00', rrule: 'FREQ=WEEKLY;COUNT=2' }
  assert.equal(expandRrule(late, { from: '2026-11-17', to: '2026-11-17' }).length, 1)
})

/* ------------------------------------------------------------------ *
 * RRULE subset: COUNT / UNTIL / INTERVAL
 * ------------------------------------------------------------------ */

test('expandRrule: COUNT bounds the series and counts DTSTART', () => {
  const three = expandRrule({ ...WEEKLY_TUE, rrule: 'FREQ=WEEKLY;COUNT=3' }, { from: '2026-11-01', to: '2027-06-30' })
  assert.deepEqual(three.map((instance) => instance.startsAt), [
    '2026-11-17T10:00:00+08:00',
    '2026-11-24T10:00:00+08:00',
    '2026-12-01T10:00:00+08:00',
  ])
  assert.equal(expandRrule({ ...WEEKLY_TUE, rrule: 'FREQ=WEEKLY;COUNT=1' }, { from: '2026-11-01', to: '2027-06-30' }).length, 1)
})

test('expandRrule: UNTIL bounds occurrences (UTC and DATE forms)', () => {
  // 2026-11-24T02:00Z == 2026-11-24T10:00+08:00: UNTIL is inclusive.
  const utcUntil = expandRrule({ ...WEEKLY_TUE, rrule: 'FREQ=WEEKLY;UNTIL=20261124T020000Z' }, { from: '2026-11-01', to: '2027-06-30' })
  assert.deepEqual(utcUntil.map((instance) => instance.startsAt), [
    '2026-11-17T10:00:00+08:00',
    '2026-11-24T10:00:00+08:00',
  ])
  // A DATE UNTIL includes the whole local day.
  const dateUntil = expandRrule(
    { ...WEEKLY_TUE, rrule: 'FREQ=DAILY;UNTIL=20261119' },
    { from: '2026-11-01', to: '2027-06-30' },
  )
  assert.deepEqual(dateUntil.map((instance) => instance.startsAt), [
    '2026-11-17T10:00:00+08:00',
    '2026-11-18T10:00:00+08:00',
    '2026-11-19T10:00:00+08:00',
  ])
})

test('expandRrule: INTERVAL steps days and weeks', () => {
  assert.deepEqual(
    expandRrule({ ...WEEKLY_TUE, rrule: 'FREQ=DAILY;INTERVAL=2;COUNT=4' }, { from: '2026-11-17', to: '2026-12-31' })
      .map((instance) => instance.startsAt),
    [
      '2026-11-17T10:00:00+08:00',
      '2026-11-19T10:00:00+08:00',
      '2026-11-21T10:00:00+08:00',
      '2026-11-23T10:00:00+08:00',
    ],
  )
  assert.deepEqual(
    expandRrule({ ...WEEKLY_TUE, rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=3' }, { from: '2026-11-17', to: '2027-01-31' })
      .map((instance) => instance.startsAt),
    [
      '2026-11-17T10:00:00+08:00',
      '2026-12-01T10:00:00+08:00',
      '2026-12-15T10:00:00+08:00',
    ],
  )
})

/* ------------------------------------------------------------------ *
 * BYDAY
 * ------------------------------------------------------------------ */

test('expandRrule: BYDAY selects weekly weekdays and filters daily rules', () => {
  // DTSTART is Tuesday 2026-11-17. BYDAY=MO,WE has an unsynchronised start;
  // RFC 5545 leaves that undefined, so the stored occurrence is kept as the
  // first instance and the rule continues from there.
  assert.deepEqual(
    expandRrule({ ...WEEKLY_TUE, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4' }, { from: '2026-11-01', to: '2027-01-31' })
      .map((instance) => instance.startsAt),
    [
      '2026-11-17T10:00:00+08:00',
      '2026-11-18T10:00:00+08:00',
      '2026-11-23T10:00:00+08:00',
      '2026-11-25T10:00:00+08:00',
    ],
  )

  // DAILY + BYDAY works as a weekday filter (weekend skipped, not counted).
  const workdays = {
    ...WEEKLY_TUE,
    startsAt: '2026-11-20T09:00:00',
    endsAt: '2026-11-20T10:00:00',
    rrule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=5',
  }
  assert.deepEqual(
    expandRrule(workdays, { from: '2026-11-01', to: '2026-12-31' }).map((instance) => instance.startsAt.slice(0, 10)),
    ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'],
  )

  // WKST changes where an INTERVAL week starts; Saturday stays Saturday here.
  const weekend = {
    ...WEEKLY_TUE,
    startsAt: '2026-11-21T10:00:00',
    endsAt: '2026-11-21T11:00:00',
    rrule: 'FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=SA;COUNT=3',
  }
  assert.deepEqual(
    expandRrule(weekend, { from: '2026-11-01', to: '2027-01-31' }).map((instance) => instance.startsAt.slice(0, 10)),
    ['2026-11-21', '2026-12-05', '2026-12-19'],
  )
})

/* ------------------------------------------------------------------ *
 * EXDATE
 * ------------------------------------------------------------------ */

test('expandRrule: EXDATE removes excluded occurrences (compact, ISO, date-only)', () => {
  const excluded = {
    ...WEEKLY_TUE,
    rrule: 'FREQ=WEEKLY;COUNT=4',
    exdate: ['20261124T100000', '2026-12-08T10:00:00'],
  }
  // COUNT=4 yields 11-17, 11-24, 12-01, 12-08; the two EXDATEs drop 24 and 08.
  assert.deepEqual(
    expandRrule(excluded, { from: '2026-11-17', to: '2027-01-31' }).map((instance) => instance.startsAt),
    ['2026-11-17T10:00:00+08:00', '2026-12-01T10:00:00+08:00'],
  )

  // A comma-separated property string is accepted too (importer-style input).
  const property = { ...excluded, exdate: 'EXDATE;TZID=Asia/Shanghai:20261124T100000,20261201T100000' }
  assert.deepEqual(
    expandRrule(property, { from: '2026-11-17', to: '2027-01-31' }).map((instance) => instance.startsAt),
    ['2026-11-17T10:00:00+08:00', '2026-12-08T10:00:00+08:00'],
  )

  // All-day series: date-only EXDATE drops the day.
  const allDay = { ...ALL_DAY_TUE, exdate: ['2026-11-18'] }
  assert.deepEqual(
    expandRrule(allDay, { from: '2026-11-17', to: '2026-11-30' }).map((instance) => instance.startsAt),
    ['2026-11-17', '2026-11-19'],
  )
})

/* ------------------------------------------------------------------ *
 * Hostile rules are capped (amplification guard)
 * ------------------------------------------------------------------ */

test('expandRrule: hostile series are capped at MAX_INSTANCES (366)', () => {
  assert.equal(MAX_INSTANCES, 366)
  const tenYears = { from: '2026-11-17', to: '2036-11-17' }
  const daily = expandRrule({ ...WEEKLY_TUE, rrule: 'FREQ=DAILY;COUNT=100000' }, tenYears)
  assert.equal(daily.length, MAX_INSTANCES)
  const weeklyAllDays = expandRrule({ ...WEEKLY_TUE, rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU' }, tenYears)
  assert.equal(weeklyAllDays.length, MAX_INSTANCES)
  // No COUNT/UNTIL at all: still bounded.
  const unbounded = expandRrule({ ...WEEKLY_TUE, rrule: 'FREQ=DAILY' }, tenYears)
  assert.equal(unbounded.length, MAX_INSTANCES)
})

/* ------------------------------------------------------------------ *
 * Unsupported rules fall back to the stored occurrence (no guess)
 * ------------------------------------------------------------------ */

test('expandRrule: unsupported or malformed rules keep only the stored occurrence', () => {
  for (const rrule of [
    'FREQ=MONTHLY;BYMONTHDAY=1',
    'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10',
    'FREQ=WEEKLY;COUNT=3;UNTIL=20261201T000000Z',
    'FREQ=WEEKLY;BYDAY=1MO',
    'not-an-rrule',
    '',
  ]) {
    const instances = expandRrule({ ...WEEKLY_TUE, rrule }, { from: '2026-11-17', to: '2026-11-17' })
    assert.equal(instances.length, 1, rrule)
    assert.equal(instances[0].startsAt, '2026-11-17T10:00:00+08:00', rrule)
    assert.equal(instances[0].recurring, false, rrule)
  }
  // The stored occurrence is still clipped to the window.
  assert.equal(expandRrule({ ...WEEKLY_TUE, rrule: 'FREQ=MONTHLY' }, { from: '2026-11-24', to: '2026-11-24' }).length, 0)
})

/* ------------------------------------------------------------------ *
 * Timezone normalisation and non-recurring rows
 * ------------------------------------------------------------------ */

test('expandRrule: UTC and all-day inputs are normalised to Asia/Shanghai', () => {
  const utc = expandRrule(
    { uid: 'utc-1', summary: 'UTC 会议', startsAt: '2026-11-17T02:00:00Z', endsAt: '2026-11-17T03:00:00Z', rrule: 'FREQ=WEEKLY;COUNT=2' },
    { from: '2026-11-24', to: '2026-11-24' },
  )
  assert.equal(utc.length, 1)
  assert.equal(utc[0].startsAt, '2026-11-24T10:00:00+08:00')
  assert.equal(utc[0].endsAt, '2026-11-24T11:00:00+08:00')

  const allDay = expandRrule(ALL_DAY_TUE, { from: '2026-11-18', to: '2026-11-30' })
  assert.deepEqual(allDay.map((instance) => instance.startsAt), ['2026-11-18', '2026-11-19'])
  assert.equal(allDay[0].allDay, true)
  // All-day DTEND is exclusive: 11-18 -> 11-19, so occurrences keep one day.
  assert.deepEqual(allDay.map((instance) => instance.endsAt), ['2026-11-19', '2026-11-20'])
})

test('expandRrule: non-recurring rows and parseIcs-shaped input work once', () => {
  const one = expandRrule(
    { uid: 'single-1', summary: '单次会议', startsAt: '2026-11-17T14:00:00', endsAt: '2026-11-17T15:00:00', allDay: false },
    { from: '2026-11-17', to: '2026-11-17' },
  )
  assert.equal(one.length, 1)
  assert.equal(one[0].startsAt, '2026-11-17T14:00:00+08:00')
  assert.equal(one[0].recurring, false)
  assert.equal(one[0].occurrenceIndex, 0)
  assert.equal(one[0].rrule, null)

  // parseIcs-shaped fields: start/end/allDay are accepted (importer naming).
  const parsed = expandRrule(
    { uid: 'ics-1', summary: '导入形态', start: '2026-11-17', end: '2026-11-18', allDay: true },
    { from: '2026-11-17', to: '2026-11-17' },
  )
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].startsAt, '2026-11-17')
  assert.equal(expandRrule({ uid: 'x', summary: '无时间' }, {}).length, 0)
})

test('expandRrule: default window starts at DTSTART and is bounded', () => {
  const instances = expandRrule(WEEKLY_TUE)
  assert.equal(instances.length, 8)
  assert.equal(instances[0].startsAt, '2026-11-17T10:00:00+08:00')
  // A reversed window yields nothing rather than throwing.
  assert.equal(expandRrule(WEEKLY_TUE, { from: '2026-11-24', to: '2026-11-17' }).length, 0)
})

test('expandRrule: invalid inputs fail loudly, empty events fail closed', () => {
  assert.throws(() => expandRrule(null), TypeError)
  assert.throws(() => expandRrule('event'), TypeError)
  assert.throws(() => expandRrule(WEEKLY_TUE, { from: 'not-a-date' }), TypeError)
  assert.deepEqual(expandRrule({ ...WEEKLY_TUE, startsAt: null }), [])
  assert.deepEqual(expandRrule({ ...WEEKLY_TUE, startsAt: 'someday' }), [])
})

/* ------------------------------------------------------------------ *
 * parseRrule diagnostics (for CLI warnings)
 * ------------------------------------------------------------------ */

test('parseRrule: supports the documented subset and explains refusals', () => {
  const supported = parseRrule('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=SU;COUNT=6')
  assert.equal(supported.supported, true)
  assert.equal(supported.reason, null)
  assert.equal(supported.freq, 'WEEKLY')
  assert.equal(supported.interval, 2)
  assert.equal(supported.count, 6)
  assert.deepEqual(supported.byday, [0, 2])
  assert.equal(supported.wkst, 6)

  assert.equal(parseRrule('').reason, 'missing')
  assert.equal(parseRrule('FREQ=MONTHLY').reason, 'unsupported-freq:MONTHLY')
  assert.equal(parseRrule('FREQ=WEEKLY;BYSETPOS=1').reason, 'unsupported-part:BYSETPOS')
  assert.equal(parseRrule('FREQ=WEEKLY;COUNT=2;UNTIL=20261201T000000Z').reason, 'count-and-until')
  assert.equal(parseRrule('FREQ=WEEKLY;BYDAY=1MO').reason, 'bad-byday')
  assert.equal(parseRrule('FREQ=WEEKLY;INTERVAL=0').reason, 'bad-interval')
  assert.equal(parseRrule('FREQ=WEEKLY;COUNT=0').reason, 'bad-count')
  assert.equal(parseRrule('FREQ=WEEKLY;UNTIL=nope').reason, 'bad-until')
})
