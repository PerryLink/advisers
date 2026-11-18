import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const NOW = '2026-11-18T02:00:00.000Z'

function env(home, extra = {}) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra })
}
function cli(home, args, extra = {}) {
  return execFileSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8' })
}
function cliFail(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8' })
}
const evidence = [{ sessionId: 'conv', turnId: 'turn', quote: 'q' }]

function seed(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-agenda-' + prefix + '-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  const store = new SqliteStore(join(home, 'state.db'))
  const ledger = new Ledger()
  const a = ledger.addMatter({ title: '客户A' })
  const b = ledger.addMatter({ title: '客户B' })
  ledger.addCommitment({ matterId: a.id, debtor: 'user', creditor: '王工', action: '上周报价', dueAt: '2026-11-16', evidence })
  ledger.addCommitment({ matterId: a.id, debtor: 'user', creditor: '王工', action: '今天到期', dueAt: '2026-11-18', evidence })
  ledger.addCommitment({ matterId: a.id, debtor: 'user', creditor: '王工', action: '今天定时交付', dueAt: '2026-11-18T18:00:00+08:00', evidence })
  ledger.addCommitment({ matterId: a.id, debtor: 'user', creditor: '王工', action: '明天开会', dueAt: '2026-11-19T10:00:00+08:00', evidence })
  ledger.addCommitment({ matterId: a.id, debtor: 'user', creditor: '王工', action: '整理案例集', evidence })
  ledger.addCommitment({ matterId: a.id, debtor: 'third:王工', creditor: '王工', action: '等客户确认', dueAt: '2026-11-20', evidence })
  ledger.addCommitment({ matterId: b.id, debtor: 'user', creditor: '李工', action: 'B事项', dueAt: '2026-11-21', evidence })
  store.save(ledger.toJSON())
  const calendar = (uid, summary, startsAt, endsAt, rrule) => store.upsertCalendarEvent({ uid, summary, startsAt, endsAt, allDay: false, tzid: 'Asia/Shanghai', rrule, source: 'test.ics' })
  calendar('evt_weekly', '客户周会', '2026-11-10T10:00:00+08:00', '2026-11-10T11:00:00+08:00', 'FREQ=WEEKLY;BYDAY=TU;COUNT=10')
  calendar('evt_a', '冲突会议A', '2026-11-19T10:00:00+08:00', '2026-11-19T11:00:00+08:00', null)
  calendar('evt_b', '冲突会议B', '2026-11-19T10:30:00+08:00', '2026-11-19T11:30:00+08:00', null)
  store.close()
  return { root, home, work, matterA: a.id, matterB: b.id }
}

test('agenda --json merges commitments + RRULE calendar, groups by Shanghai local day and is deterministic', () => {
  const s = seed('json')
  try {
    const first = cli(s.home, ['agenda', '--now', NOW, '--json'])
    const second = cli(s.home, ['agenda', '--now', NOW, '--json'])
    assert.equal(first, second, 'fixed --now output must be byte-identical')
    const data = JSON.parse(first)
    assert.equal(data.ok, true)
    assert.equal(data.command, 'agenda')
    assert.deepEqual(data.window, { from: '2026-11-18', to: '2026-11-24', days: 7, timezone: 'Asia/Shanghai' })
    assert.equal(data.overdue.length, 1)
    assert.equal(data.overdue[0].title, '上周报价')
    assert.equal(data.overdue[0].localDate, '2026-11-16')
    assert.equal(data.overdue[0].allDay, true)
    assert.equal(data.overdue[0].ref.kind, 'commitment')
    assert.equal(data.days.length, 7)
    assert.equal(data.days[0].date, '2026-11-18')
    assert.equal(data.days[0].weekday, '周三')
    assert.equal(data.days[0].load, 2)
    assert.equal(data.days[0].items[0].title, '今天定时交付', 'timed items sort before all-day items')
    assert.equal(data.days[0].items[0].localTime, '18:00')
    assert.equal(data.days[0].items[0].allDay, false)
    assert.equal(data.days[0].items[1].title, '今天到期')
    assert.equal(data.days[0].items[1].localTime, null)
    assert.equal(data.days[0].items[1].at, '2026-11-18T15:59:59.999Z', 'date-only dueAt means end of the Shanghai day')
    const meeting = data.days.find((day) => day.date === '2026-11-24').items.find((item) => item.title === '客户周会')
    assert.ok(meeting, 'a weekly RRULE occurrence is visible on a non-DTSTART day')
    assert.equal(meeting.kind, 'calendar')
    assert.equal(meeting.localTime, '10:00')
    assert.equal(meeting.meta.rrule, 'FREQ=WEEKLY;BYDAY=TU;COUNT=10')
    assert.equal(data.counts.waiting, 1)
    assert.equal(data.counts.unscheduled, 1)
    assert.equal(data.counts.conflicts, 2)
    assert.equal(data.counts.perDayLoad['2026-11-18'], 2)
    assert.deepEqual(data.degraded, [])
    const conflictDates = data.conflicts.map((conflict) => conflict.date)
    assert.ok(conflictDates.every((date) => date === '2026-11-19'))
    // --matter narrows the same view and never invents rows.
    const filtered = JSON.parse(cli(s.home, ['agenda', '--now', NOW, '--matter', s.matterB, '--json']))
    assert.equal(filtered.overdue.length, 0)
    const filteredItems = filtered.days.flatMap((day) => day.items)
    assert.ok(filteredItems.some((item) => item.title === 'B事项'))
    assert.equal(filteredItems.some((item) => item.title === '今天到期'), false)
    assert.match(cli(s.home, ['agenda', '--now', NOW]), /客户周会/)
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('agenda/digest morning reject bad window flags with E_USAGE', () => {
  const s = seed('usage')
  try {
    for (const args of [['agenda', '--days', '0'], ['agenda', '--days', '32'], ['agenda', '--now', 'not-a-date'], ['digest', 'morning', '--days', '0']]) {
      const failed = cliFail(s.home, args)
      assert.equal(failed.status, 1, args.join(' ') + ' must fail')
      assert.match(failed.stderr, /E_USAGE/)
    }
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('digest morning is a deterministic no-model brief; morning alias and digest morning agree', () => {
  const s = seed('morning')
  try {
    const first = cli(s.home, ['digest', 'morning', '--now', NOW])
    const second = cli(s.home, ['digest', 'morning', '--now', NOW])
    assert.equal(first, second, 'the same fixed input must produce identical bytes')
    assert.match(first, /^# 晨报 2026-11-18（周三）/)
    assert.match(first, /数据哈希 sha256:[0-9a-f]{16}/)
    assert.match(first, /## 今天必须做/)
    assert.match(first, /## 逾期（1）/)
    assert.match(first, /## 未来 7 天/)
    assert.match(first, /## 等待他人（1）/)
    assert.match(first, /## 风险/)
    assert.match(first, /客户周会/)
    assert.equal(cli(s.home, ['morning', '--now', NOW]), first, 'morning is an alias of digest morning')
    const json = JSON.parse(cli(s.home, ['digest', 'morning', '--now', NOW, '--json']))
    assert.equal(json.ok, true)
    assert.equal(json.command, 'morning')
    assert.equal(json.localDay, '2026-11-18')
    assert.match(json.dataSha256, /^[0-9a-f]{64}$/)
    assert.equal(json.mustDo.length, 2)
    assert.equal(json.overdue.length, 1)
    assert.equal(json.counts.overdue, 1)
    assert.equal(json.counts.waiting, 1)
    assert.ok(json.upcoming.length >= 4)
    const again = JSON.parse(cli(s.home, ['digest', 'morning', '--now', NOW, '--json']))
    assert.equal(again.dataSha256, json.dataSha256)
    // No network/model is possible on these deterministic paths: a configured
    // (but dead) API endpoint must not change the result or fail the command.
    const noModelEnv = { ADVISERS_NO_MODEL: '', ADVISERS_API_KEY: 'fake', ADVISERS_BASE_URL: 'http://127.0.0.1:9' }
    const offline = cli(s.home, ['digest', 'morning', '--now', NOW], noModelEnv)
    assert.equal(offline, first)
    assert.doesNotMatch(cli(s.home, ['agenda', '--now', NOW, '--json'], noModelEnv), /ECONN|fetch failed/)
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})
