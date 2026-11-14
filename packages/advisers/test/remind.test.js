import assert from 'node:assert/strict'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import {
  ALL_RULES,
  DEFAULT_RULES,
  SNOOZE_WAKE_RULE,
  TIME_ZONE,
  buildReminders,
  escapeIcsText,
  formatIcsDate,
  localDay,
  localMinutesOfDay,
  parseIcsDate,
  toIcs,
} from '../lib/remind.js'

const NOW_10 = '2026-11-14T10:00:00+08:00'
const NOW_1830 = '2026-11-14T18:30:00+08:00'
const REQUIRED_RULES = ['due-1d', 'due-today-09', 'due-today-18', 'overdue-daily', 'snooze-wake']

function fixture() {
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '秘密事项', secrecy: 2 })
  const add = (action, dueAt, extra = {}) => {
    const commitment = ledger.addCommitment({
      matterId: matter.id,
      debtor: 'user',
      creditor: '秘密联系人',
      action,
      dueAt,
      capability: 'calendar',
      evidence: [{ sessionId: 'session_secret', turnId: 'turn_secret', quote: '机密原话' }],
    })
    Object.assign(commitment, extra)
    return commitment
  }
  const commitments = {
    today: add('今天交周报', '2026-11-14T18:00:00+08:00'),
    tomorrow: add('明天发报价', '2026-11-15T09:00:00+08:00'),
    overdue: add('逾期跟进合同', '2026-11-12T18:00:00+08:00'),
    future: add('下周评审', '2026-11-18T12:00:00+08:00'),
    snoozed: add('被 snooze 的提醒', '2026-11-16T10:00:00+08:00', { status: 'snoozed' }),
  }
  const ids = Object.fromEntries(Object.entries(commitments).map(([key, commitment]) => [key, commitment.id]))
  return {
    ledger,
    matter,
    ids,
    commitments,
    snoozedUntil: new Map([[ids.snoozed, '2026-11-14T17:00:00+08:00']]),
  }
}

const forCommitment = (reminders, id, ruleId) =>
  reminders.find((reminder) => reminder.commitmentId === id && (ruleId === undefined || reminder.ruleId === ruleId))

const uniqueKey = (reminder, now) => `${reminder.commitmentId}\u0000${reminder.bucket}\u0000${reminder.ruleId}\u0000${localDay(now)}`

test('buildReminders maps today/tomorrow/overdue/future to buckets and levels', () => {
  const { ledger, ids, snoozedUntil } = fixture()
  const reminders = buildReminders(ledger, { now: NOW_10, snoozedUntil })

  assert.equal(reminders.length, 4, 'only the four visible commitments fire at 10:00')
  const today = forCommitment(reminders, ids.today)
  assert.equal(today.bucket, 'due-today')
  assert.equal(today.level, 'L2')
  assert.equal(today.ruleId, 'due-today-09')
  assert.equal(today.action, '今天交周报')
  assert.equal(today.dueAt, '2026-11-14T18:00:00+08:00')

  const tomorrow = forCommitment(reminders, ids.tomorrow)
  assert.equal(tomorrow.bucket, 'due-1d')
  assert.equal(tomorrow.level, 'L1')
  assert.equal(tomorrow.ruleId, 'due-1d')

  const overdue = forCommitment(reminders, ids.overdue)
  assert.equal(overdue.bucket, 'overdue')
  assert.equal(overdue.level, 'L2', 'L3 is disabled by default')
  assert.equal(overdue.ruleId, 'overdue-daily')

  const future = forCommitment(reminders, ids.future)
  assert.equal(future.bucket, 'upcoming')
  assert.equal(future.level, 'L1')
  assert.equal(future.ruleId, 'upcoming')

  assert.equal(forCommitment(reminders, ids.snoozed), undefined, 'active snooze suppresses all reminders')
  for (const reminder of reminders) {
    assert.deepEqual(Object.keys(reminder).sort(), ['action', 'bucket', 'commitmentId', 'dueAt', 'level', 'ruleId'])
  }
  const keys = reminders.map((reminder) => uniqueKey(reminder, NOW_10))
  assert.equal(new Set(keys).size, keys.length, 'returned reminders are unique')
})

test('all five required rules can fire and defaults expose them', () => {
  const { ledger, ids, snoozedUntil } = fixture()
  const at10 = buildReminders(ledger, { now: NOW_10, snoozedUntil })
  const at1830 = buildReminders(ledger, { now: NOW_1830, snoozedUntil })
  const observed = new Set([...at10, ...at1830].map((reminder) => reminder.ruleId))

  for (const ruleId of REQUIRED_RULES) assert.ok(observed.has(ruleId), `expected ${ruleId} to fire at some point`)
  assert.ok(observed.size >= 5, 'at least five distinct rules are exercised')
  for (const ruleId of REQUIRED_RULES) assert.ok(DEFAULT_RULES.some((rule) => rule.id === ruleId), `DEFAULT_RULES should include ${ruleId}`)
  assert.ok(DEFAULT_RULES.length >= 5)
  assert.ok(ALL_RULES.length >= 5)
  assert.equal(SNOOZE_WAKE_RULE.id, 'snooze-wake')

  const todayRules = at1830.filter((reminder) => reminder.commitmentId === ids.today).map((reminder) => reminder.ruleId)
  assert.deepEqual(todayRules, ['due-today-09', 'due-today-18'])
})

test('09:00 and 18:00 same-day rule boundaries are local Asia/Shanghai', () => {
  const { ledger, ids, snoozedUntil } = fixture()
  const rulesAt = (now) =>
    buildReminders(ledger, { now, snoozedUntil })
      .filter((reminder) => reminder.commitmentId === ids.today)
      .map((reminder) => reminder.ruleId)

  assert.deepEqual(rulesAt('2026-11-14T08:59:00+08:00'), [])
  assert.deepEqual(rulesAt('2026-11-14T09:00:00+08:00'), ['due-today-09'])
  assert.deepEqual(rulesAt('2026-11-14T17:59:00+08:00'), ['due-today-09'])
  assert.deepEqual(rulesAt('2026-11-14T18:00:00+08:00'), ['due-today-09', 'due-today-18'])
  assert.equal(localDay('2026-11-13T16:30:00Z'), '2026-11-14')
  assert.equal(localMinutesOfDay('2026-11-14T09:00:00+08:00'), 9 * 60)
  assert.equal(localMinutesOfDay('2026-11-14T18:00:00+08:00'), 18 * 60)
})

test('dedupe is by commitmentId + bucket + ruleId + localDay', () => {
  const { ledger, snoozedUntil } = fixture()
  const once = buildReminders(ledger, { now: NOW_10, snoozedUntil })
  const duplicatedRules = buildReminders(ledger, {
    now: NOW_10,
    snoozedUntil,
    rules: [...DEFAULT_RULES, ...DEFAULT_RULES],
  })
  assert.deepEqual(duplicatedRules, once, 'duplicated rule lists collapse to unique reminders')

  const keys = duplicatedRules.map((reminder) => uniqueKey(reminder, NOW_10))
  assert.equal(new Set(keys).size, keys.length)
})

test('snooze hides reminders until the deadline, then snooze-wake fires', () => {
  const { ledger, ids, snoozedUntil } = fixture()

  const before = buildReminders(ledger, { now: '2026-11-14T16:59:00+08:00', snoozedUntil })
  assert.ok(!before.some((reminder) => reminder.commitmentId === ids.snoozed))

  const atWake = buildReminders(ledger, { now: '2026-11-14T17:00:00+08:00', snoozedUntil })
  const wake = forCommitment(atWake, ids.snoozed, 'snooze-wake')
  assert.ok(wake, 'snooze-wake is emitted when the stored snooze expires')
  assert.equal(wake.bucket, 'upcoming')
  assert.equal(wake.level, 'L1')

  const afterWake = buildReminders(ledger, { now: NOW_1830, snoozedUntil })
  assert.equal(afterWake.filter((reminder) => reminder.ruleId === 'snooze-wake').length, 1)

  const cleared = buildReminders(ledger, { now: NOW_1830, snoozedUntil: new Map() })
  assert.ok(!cleared.some((reminder) => reminder.commitmentId === ids.snoozed && reminder.ruleId === 'snooze-wake'))
  assert.ok(cleared.some((reminder) => reminder.commitmentId === ids.snoozed && reminder.ruleId === 'upcoming'))

  const objectForm = { [ids.snoozed]: '2026-11-14T17:00:00+08:00' }
  const objectFormPending = buildReminders(ledger, { now: '2026-11-14T16:00:00+08:00', snoozedUntil: objectForm })
  assert.ok(!objectFormPending.some((reminder) => reminder.commitmentId === ids.snoozed))

  assert.equal(ledger.listCommitments().find((commitment) => commitment.id === ids.snoozed).status, 'snoozed', 'planning never mutates the ledger')
})

test('horizon, done/dropped and duck-typed ledgers', () => {
  const now = NOW_10
  const entries = [
    { id: 'cm_far', status: 'open', action: '八天后', dueAt: '2026-11-22T10:00:00+08:00' },
    { id: 'cm_three', status: 'open', action: '三天后', dueAt: '2026-11-17T12:00:00+08:00' },
    { id: 'cm_done', status: 'done', action: '已完成', dueAt: '2026-11-14T18:00:00+08:00' },
    { id: 'cm_dropped', status: 'dropped', action: '已放弃', dueAt: '2026-11-14T18:00:00+08:00' },
    { id: 'cm_no_due', status: 'open', action: '没有截止' },
  ]
  const ledgerLike = { listCommitments: () => entries }

  const within = buildReminders(ledgerLike, { now })
  assert.deepEqual(within.map((reminder) => reminder.commitmentId), ['cm_three'])
  assert.equal(within[0].bucket, 'upcoming')

  const wider = buildReminders(ledgerLike, { now, horizonDays: 10 })
  assert.deepEqual(wider.map((reminder) => reminder.commitmentId).sort(), ['cm_far', 'cm_three'])

  assert.throws(() => buildReminders({}, { now }), TypeError)
})

test('L3 is opt-in and only for severe overdue', () => {
  const { ledger, ids, snoozedUntil } = fixture()
  const withoutL3 = buildReminders(ledger, { now: NOW_10, snoozedUntil })
  assert.equal(forCommitment(withoutL3, ids.overdue).level, 'L2')
  assert.ok(withoutL3.every((reminder) => reminder.level !== 'L3'))

  const withL3 = buildReminders(ledger, { now: NOW_10, snoozedUntil, allowL3: true })
  assert.equal(forCommitment(withL3, ids.overdue).level, 'L3')
  assert.equal(forCommitment(withL3, ids.today).level, 'L2')
  assert.equal(forCommitment(withL3, ids.future).level, 'L1')

  const mild = { listCommitments: () => [{ id: 'cm_mild', status: 'open', action: '轻度逾期', dueAt: '2026-11-13T18:00:00+08:00' }] }
  const mildReminder = buildReminders(mild, { now: NOW_10, allowL3: true })
  assert.equal(mildReminder[0].level, 'L2', 'less than 24h late is not severe')
})

test('toIcs renders stable events, alarms and only title/due/UID', () => {
  const { ledger, matter, ids, snoozedUntil } = fixture()
  const reminders = buildReminders(ledger, { now: NOW_1830, snoozedUntil })
  const ics = toIcs(reminders, { now: NOW_1830, uidPrefix: 'advisers-test' })

  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'))
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'))
  assert.match(ics, /\r\nVERSION:2\.0\r\n/)
  assert.match(ics, /\r\nPRODID:[^\r\n]+\r\n/)
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 5, 'one event per commitment instant (nudges dedupe by UID)')
  assert.equal((ics.match(/END:VEVENT/g) ?? []).length, 5)
  assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, 10)
  assert.equal((ics.match(/TRIGGER:-P1D/g) ?? []).length, 5)
  assert.equal((ics.match(/TRIGGER:-PT1H/g) ?? []).length, 5)
  assert.equal((ics.match(/DTSTAMP:20261114T103000Z/g) ?? []).length, 5)
  assert.ok(ics.includes('DTSTART:20261114T100000Z'), 'today 18:00+08 is 10:00Z')
  assert.ok(ics.includes('SUMMARY:今天交周报'))
  assert.match(ics, /\r\nDESCRIPTION:到期：2026-11-14 18:00（Asia\/Shanghai）\r\n/)

  const uids = [...ics.matchAll(/\r\nUID:([^\r\n]+)/g)].map((match) => match[1])
  assert.equal(uids.length, 5)
  assert.equal(new Set(uids).size, 5, 'UIDs are unique')
  const expectedUids = [...new Set(reminders.map((reminder) => `advisers-test-${reminder.commitmentId}-${reminder.dueAt}`))]
  assert.equal(uids.length, expectedUids.length)
  for (const uid of expectedUids) assert.ok(uids.includes(uid), `stable UID ${uid}`)

  // Privacy: the export never carries creditor, matter, evidence or rule metadata.
  assert.ok(!ics.includes('秘密联系人'))
  assert.ok(!ics.includes('机密原话'))
  assert.ok(!ics.includes('session_secret'))
  assert.ok(!ics.includes('turn_secret'))
  assert.ok(!ics.includes(matter.id))
  assert.ok(!ics.includes('snooze-wake'))
  assert.ok(!ics.includes('overdue-daily'))
  assert.ok(!ics.includes('matterId'))
  assert.ok(!ics.includes('ruleId'))

  assert.equal(toIcs(reminders, { now: NOW_1830, uidPrefix: 'advisers-test' }), ics, 'exporting twice is byte-identical')
  assert.equal(toIcs(reminders, { now: new Date(NOW_1830), uidPrefix: 'advisers-test' }), ics, 'Date and ISO now agree')
})

test('toIcs escapes commas, semicolons, newlines and backslashes', () => {
  assert.equal(escapeIcsText('a,b;c\nd\\e'), 'a\\,b\\;c\\nd\\\\e')

  const reminders = [
    {
      commitmentId: 'cm_esc',
      action: '报价, 已发; 周报\n第二行',
      dueAt: '2026-11-14T18:00:00+08:00',
      bucket: 'due-today',
      level: 'L2',
      ruleId: 'due-today-18',
    },
  ]
  const ics = toIcs(reminders, { now: NOW_10, uidPrefix: 'esc' })
  assert.ok(ics.includes('UID:esc-cm_esc-2026-11-14T18:00:00+08:00'))
  assert.ok(ics.includes('SUMMARY:报价\\, 已发\\; 周报\\n第二行\r\n'), 'SUMMARY is a single escaped line')
  assert.ok(!ics.includes('SUMMARY:报价, 已发'))
  assert.equal((ics.match(/报价\\, 已发\\; 周报\\n第二行/g) ?? []).length, 3, 'summary plus two alarm descriptions')
  assert.equal((ics.match(/\r\nSUMMARY:/g) ?? []).length, 1)
  assert.equal((ics.match(/\r\nBEGIN:VEVENT/g) ?? []).length, 1)
})

test('parseIcsDate and formatIcsDate round-trip UTC and Shanghai wall time', () => {
  assert.equal(formatIcsDate(new Date('2026-11-14T10:30:00Z')), '20261114T103000Z')
  assert.equal(formatIcsDate('2026-11-14T18:30:00+08:00'), '20261114T103000Z')
  assert.equal(parseIcsDate('20261114T103000Z').toISOString(), '2026-11-14T10:30:00.000Z')
  assert.equal(parseIcsDate('20261114T183000').toISOString(), '2026-11-14T10:30:00.000Z')
  assert.equal(parseIcsDate('2026-11-14T18:30:00+08:00').toISOString(), '2026-11-14T10:30:00.000Z')
  assert.equal(formatIcsDate(parseIcsDate('20261114T103000Z')), '20261114T103000Z')
  assert.equal(TIME_ZONE, 'Asia/Shanghai')
  assert.throws(() => parseIcsDate('not-a-date'), RangeError)
  assert.throws(() => formatIcsDate('2026-13-40'), RangeError)
})

test('empty reminder lists still produce a valid minimal calendar', () => {
  const ics = toIcs([], { now: NOW_10 })
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'))
  assert.ok(ics.includes('VERSION:2.0'))
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'))
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 0)
})
