import assert from 'node:assert/strict'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import {
  MAX_REMINDER_OFFSETS,
  buildReminders,
  describeReminderOffset,
  normalizeReminderOffsets,
  parseReminderOffset,
  reminderAlarmTime,
  reminderAlarms,
  toIcs,
} from '../lib/remind.js'

const DUE = '2026-11-20T18:00:00+08:00'
const DUE_UTC = '2026-11-20T10:00:00Z'
const NOW_DUE_1D = '2026-11-19T10:00:00+08:00'
const NOW_EXPORT = '2026-11-19T10:30:00+08:00'

const legacyLedger = (commitments) => ({ listCommitments: () => commitments })
const plain = (id, extra = {}) => ({ id, status: 'open', action: `action-${id}`, dueAt: DUE, ...extra })

test('parseReminderOffset accepts the documented grammar and canonicalises it', () => {
  assert.equal(parseReminderOffset('-1d').offset, '-1d')
  assert.equal(parseReminderOffset('+2d').offset, '+2d')
  assert.equal(parseReminderOffset('-2h').offset, '-2h')
  assert.equal(parseReminderOffset('+90m').offset, '+90m')
  assert.equal(parseReminderOffset(' +0d09:00 ').offset, '+0d09:00')
  assert.equal(parseReminderOffset('+0d9:05').offset, '+0d09:05')
  assert.equal(parseReminderOffset('-1d08:30').offset, '-1d08:30')
  // A zero-day wall-clock offset has no direction; canonical form is '+'.
  assert.equal(parseReminderOffset('-0d09:00').offset, '+0d09:00')

  const parsed = parseReminderOffset('-1d08:30')
  assert.equal(parsed.sign, -1)
  assert.deepEqual(parsed.days, 1)
  assert.deepEqual(parsed.timeOfDay, { hour: 8, minute: 30 })

  for (const invalid of ['', '1d', '-1', '-1y', '-1d 09:00', '-1h09:00', '-1d24:00', '-1d09:60', '--1d', null, 42, {}]) {
    assert.throws(() => parseReminderOffset(invalid), 'expected an error for ' + String(invalid))
  }
  assert.throws(() => parseReminderOffset('-4000d'), RangeError)
  assert.throws(() => parseReminderOffset(`-${'9'.repeat(20)}d`))
})

test('normalizeReminderOffsets dedupes, preserves order and rejects bad lists', () => {
  assert.deepEqual(normalizeReminderOffsets(['-1d', '-2h', '-1d']), ['-1d', '-2h'])
  assert.deepEqual(normalizeReminderOffsets(['-2h', '-1d']), ['-2h', '-1d'])
  assert.deepEqual(normalizeReminderOffsets(null), [])
  assert.deepEqual(normalizeReminderOffsets(undefined), [])
  assert.throws(() => normalizeReminderOffsets('-1d'), TypeError)
  assert.throws(() => normalizeReminderOffsets(['-1d', 'soon']), TypeError)
  const tooMany = Array.from({ length: MAX_REMINDER_OFFSETS + 1 }, (_, index) => `-${index + 1}h`)
  assert.throws(() => normalizeReminderOffsets(tooMany), RangeError)
})

test('describeReminderOffset produces human labels', () => {
  assert.equal(describeReminderOffset('-1d'), '提前 1 天')
  assert.equal(describeReminderOffset('+2d'), '延后 2 天')
  assert.equal(describeReminderOffset('-2h'), '提前 2 小时')
  assert.equal(describeReminderOffset('+30m'), '延后 30 分钟')
  assert.equal(describeReminderOffset('+0d09:00'), '当天 09:00')
  assert.equal(describeReminderOffset('-1d08:30'), '提前 1 天 08:30')
  assert.equal(describeReminderOffset('+0d'), '到期时')
})

test('reminderAlarmTime resolves absolute instants in Asia/Shanghai', () => {
  const iso = (value) => value.toISOString()
  // Due is 2026-11-20 18:00 +08:00 == 10:00Z.
  assert.equal(iso(reminderAlarmTime(DUE, '-1d')), '2026-11-19T10:00:00.000Z')
  assert.equal(iso(reminderAlarmTime(DUE, '-2h')), '2026-11-20T08:00:00.000Z')
  assert.equal(iso(reminderAlarmTime(DUE, '+0d09:00')), '2026-11-20T01:00:00.000Z')
  assert.equal(iso(reminderAlarmTime(DUE, '-1d08:30')), '2026-11-19T00:30:00.000Z')
  assert.equal(iso(reminderAlarmTime(DUE, '+0d')), '2026-11-20T10:00:00.000Z')
  // The same instant expressed as UTC must yield identical alarm instants.
  assert.equal(iso(reminderAlarmTime(DUE_UTC, '+0d09:00')), '2026-11-20T01:00:00.000Z')
  assert.equal(iso(reminderAlarmTime(Date.parse(DUE), '-1d')), '2026-11-19T10:00:00.000Z')
  assert.equal(iso(reminderAlarmTime(new Date(DUE), '-1d')), '2026-11-19T10:00:00.000Z')
  assert.throws(() => reminderAlarmTime('not-a-date', '-1d'), RangeError)
})

test('reminderAlarms sorts by instant, dedupes same instants and skips bad offsets', () => {
  const alarms = reminderAlarms(DUE, ['-2h', '-1d', '+0d09:00', 'nope', '-1d'])
  assert.deepEqual(
    alarms.map((alarm) => [alarm.offset, alarm.at.toISOString()]),
    [
      ['-1d', '2026-11-19T10:00:00.000Z'],
      ['+0d09:00', '2026-11-20T01:00:00.000Z'],
      ['-2h', '2026-11-20T08:00:00.000Z'],
    ],
  )
  assert.deepEqual(alarms.map((alarm) => alarm.label), ['提前 1 天', '当天 09:00', '提前 2 小时'])

  // -24h and -1d are the same instant; only the first one survives.
  assert.equal(reminderAlarms(DUE, ['-24h', '-1d']).length, 1)
  assert.deepEqual(reminderAlarms(DUE, []), [])
  assert.deepEqual(reminderAlarms(DUE, ['nope']), [])
})

test('buildReminders reads per-commitment offsets without changing old reminder shape', () => {
  const commitments = [
    plain('cm_custom', { reminderOffsets: ['-1d', '-2h'] }),
    plain('cm_plain'),
    plain('cm_partial', { reminderOffsets: ['nope', '-1d'] }),
    plain('cm_empty', { reminderOffsets: [] }),
  ]
  const reminders = buildReminders(legacyLedger(commitments), { now: NOW_DUE_1D })
  const byId = (id) => reminders.find((reminder) => reminder.commitmentId === id)

  assert.deepEqual(byId('cm_custom').reminderOffsets, ['-1d', '-2h'])
  assert.ok(!('reminderOffsets' in byId('cm_plain')), 'legacy reminder shape is unchanged')
  assert.deepEqual(Object.keys(byId('cm_plain')).sort(), ['action', 'bucket', 'commitmentId', 'dueAt', 'level', 'ruleId'])
  assert.deepEqual(byId('cm_partial').reminderOffsets, ['-1d'], 'invalid entries are skipped, valid ones survive')
  assert.ok(!('reminderOffsets' in byId('cm_empty')), 'an empty list falls back to the legacy alarms')
})

test('buildReminders accepts injected offsets, metadata and a global default', () => {
  const commitments = [plain('cm_one'), plain('cm_two', { reminderOffsets: ['-1d'] })]
  const now = NOW_DUE_1D
  const offsetsFor = (options, ledger = legacyLedger(commitments)) => {
    const reminders = buildReminders(ledger, { now, ...options })
    return Object.fromEntries(reminders.map((reminder) => [reminder.commitmentId, reminder.reminderOffsets]))
  }

  assert.deepEqual(offsetsFor({ reminderOffsets: new Map([['cm_one', ['-3h']]]) }), {
    cm_one: ['-3h'],
    cm_two: ['-1d'],
  })
  assert.deepEqual(offsetsFor({ reminderOffsets: { 'cm_one': ['-30m'] } }), {
    cm_one: ['-30m'],
    cm_two: ['-1d'],
  })
  assert.deepEqual(offsetsFor({ reminderOffsets: (commitment) => (commitment.id === 'cm_one' ? ['+0d09:00'] : undefined) }), {
    cm_one: ['+0d09:00'],
    cm_two: ['-1d'],
  })
  // Injected values win over the commitment field; invalid injected values fall through to it.
  assert.deepEqual(offsetsFor({ reminderOffsets: new Map([['cm_two', ['-2h']]]) }), {
    cm_one: undefined,
    cm_two: ['-2h'],
  })
  assert.deepEqual(offsetsFor({ reminderOffsets: new Map([['cm_two', ['bogus']]]) }), {
    cm_one: undefined,
    cm_two: ['-1d'],
  })

  // commitment.meta and ledger.getMeta are duck-typed fallbacks.
  const metaCommitments = [
    { ...plain('cm_meta'), meta: { get: (key) => (key === 'reminderOffsets:cm_meta' ? ['-4h'] : undefined) } },
  ]
  assert.deepEqual(offsetsFor({}, legacyLedger(metaCommitments)), { cm_meta: ['-4h'] })

  const storeLedger = {
    listCommitments: () => [plain('cm_store')],
    getMeta: (key) => (key === 'reminderOffsets:cm_store' ? ['-5h'] : undefined),
  }
  assert.deepEqual(offsetsFor({}, storeLedger), { cm_store: ['-5h'] })

  // Global default: only commitments without their own list pick it up.
  const globalReminders = buildReminders(legacyLedger([plain('cm_default'), plain('cm_own', { reminderOffsets: ['-1d'] })]), {
    now,
    defaultReminderOffsets: ['-6h'],
  })
  assert.equal(globalReminders.find((r) => r.commitmentId === 'cm_default').reminderOffsets[0], '-6h')
  assert.equal(globalReminders.find((r) => r.commitmentId === 'cm_own').reminderOffsets[0], '-1d')
})

test('toIcs emits one absolute DATE-TIME VALARM per custom offset', () => {
  const reminders = [
    {
      commitmentId: 'cm_1',
      action: '发报价',
      dueAt: DUE,
      bucket: 'due-1d',
      level: 'L1',
      ruleId: 'due-1d',
      reminderOffsets: ['-1d', '-2h', '+0d09:00'],
    },
  ]
  const ics = toIcs(reminders, { now: NOW_EXPORT, uidPrefix: 'advisers-test' })

  assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, 3, 'one VALARM per rule')
  assert.equal((ics.match(/END:VALARM/g) ?? []).length, 3)
  assert.ok(!ics.includes('TRIGGER:-P1D'), 'custom offsets replace the legacy relative alarms')
  assert.ok(!ics.includes('TRIGGER:-PT1H'))
  assert.ok(ics.includes('TRIGGER;VALUE=DATE-TIME:20261119T100000Z'))
  assert.ok(ics.includes('TRIGGER;VALUE=DATE-TIME:20261120T080000Z'))
  assert.ok(ics.includes('TRIGGER;VALUE=DATE-TIME:20261120T010000Z'))
  assert.ok(ics.includes('DESCRIPTION:提醒：发报价（提前 1 天）'))
  assert.ok(ics.includes('DESCRIPTION:提醒：发报价（提前 2 小时）'))
  assert.ok(ics.includes('DESCRIPTION:提醒：发报价（当天 09:00）'))

  // Calendar order is chronological: -1d, +0d09:00, -2h.
  const triggerOrder = [...ics.matchAll(/TRIGGER;VALUE=DATE-TIME:(\d{8}T\d{6}Z)/g)].map((match) => match[1])
  assert.deepEqual(triggerOrder, ['20261119T100000Z', '20261120T010000Z', '20261120T080000Z'])
  assert.ok(ics.includes('UID:advisers-test-cm_1-2026-11-20T18:00:00+08:00'))
  assert.ok(!ics.includes('creditor'))
  assert.ok(!ics.includes('secret'))

  // Stable UID: changing the offsets (or the export instant) keeps the event identity.
  const changed = toIcs([{ ...reminders[0], reminderOffsets: ['-30m'] }], { now: '2026-11-19T11:00:00+08:00', uidPrefix: 'advisers-test' })
  const uidOf = (text) => text.match(/\r\nUID:([^\r\n]+)/)[1]
  assert.equal(uidOf(changed), uidOf(ics))
  assert.notEqual(changed, ics)
})

test('toIcs keeps the legacy alarms when no custom offsets are configured', () => {
  const baseReminder = {
    commitmentId: 'cm_legacy',
    action: '发合同',
    dueAt: DUE,
    bucket: 'due-1d',
    level: 'L1',
    ruleId: 'due-1d',
  }
  const expectedLegacy = (ics) => {
    assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, 2)
    assert.equal((ics.match(/TRIGGER:-P1D/g) ?? []).length, 1)
    assert.equal((ics.match(/TRIGGER:-PT1H/g) ?? []).length, 1)
    assert.ok(!ics.includes('TRIGGER;VALUE=DATE-TIME'))
  }

  expectedLegacy(toIcs([baseReminder], { now: NOW_EXPORT }))
  expectedLegacy(toIcs([{ ...baseReminder, reminderOffsets: [] }], { now: NOW_EXPORT }))
  expectedLegacy(toIcs([{ ...baseReminder, reminderOffsets: ['nonsense'] }], { now: NOW_EXPORT }))

  // An option-level list applies only when the reminder itself has no list.
  const withOption = toIcs([baseReminder], { now: NOW_EXPORT, reminderOffsets: ['-30m'] })
  assert.ok(withOption.includes('TRIGGER;VALUE=DATE-TIME:20261120T093000Z'))
  assert.ok(!withOption.includes('TRIGGER:-P1D'))

  const ownWins = toIcs([{ ...baseReminder, reminderOffsets: ['-2h'] }], { now: NOW_EXPORT, reminderOffsets: ['-30m'] })
  assert.ok(ownWins.includes('TRIGGER;VALUE=DATE-TIME:20261120T080000Z'))
  assert.ok(!ownWins.includes('20261120T093000Z'))
})
test('core ledger reminderOffsets flow through buildReminders into the calendar', () => {
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '提醒集成' })
  const commitment = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'agent',
    creditor: '客户',
    action: '发送报价单',
    dueAt: DUE,
    evidence: [{ sessionId: 's1', turnId: 't1', quote: '提醒我发报价' }],
    reminderOffsets: ['-1d', '+0d09:00'],
  })

  const reminders = buildReminders(ledger, { now: NOW_DUE_1D })
  const reminder = reminders.find((entry) => entry.commitmentId === commitment.id)
  assert.ok(reminder)
  assert.deepEqual(reminder.reminderOffsets, ['-1d', '+0d09:00'])

  const ics = toIcs([reminder], { now: NOW_EXPORT, uidPrefix: 'advisers-test' })
  assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, 2)
  assert.ok(ics.includes('TRIGGER;VALUE=DATE-TIME:20261119T100000Z'))
  assert.ok(ics.includes('TRIGGER;VALUE=DATE-TIME:20261120T010000Z'))
  assert.ok(ics.includes(`UID:advisers-test-${commitment.id}-${DUE}`))

  // Updates persist through the core ledger snapshot too.
  ledger.updateCommitment(commitment.id, { reminderOffsets: ['-2h'] })
  assert.deepEqual(ledger.listCommitments()[0].reminderOffsets, ['-2h'])
  const reloaded = Ledger.fromJSON(ledger.toJSON())
  assert.deepEqual(reloaded.listCommitments()[0].reminderOffsets, ['-2h'])
  const updated = toIcs(buildReminders(reloaded, { now: NOW_DUE_1D }), { now: NOW_EXPORT })
  assert.ok(updated.includes('TRIGGER;VALUE=DATE-TIME:20261120T080000Z'))
  assert.ok(!updated.includes('TRIGGER;VALUE=DATE-TIME:20261120T010000Z'))
})
