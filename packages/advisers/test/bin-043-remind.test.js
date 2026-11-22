/**
 * 0.4.3 (043-4, plan 90 NOW-8/NOW-9): enhanced `remind --ics` + per-commitment
 * 24h notification cooldown.
 *
 * Covers:
 *  - lib toIcs default bytes unchanged (opt-in only), explicit TZID and VALARM
 *    commitment id when the new options are passed;
 *  - CLI `remind --ics` output imports back through `calendar import --ics`;
 *  - same commitment notified twice within 24h delivers once, the local
 *    reminders.log still records every run, and --force-notify escapes.
 * All homes are mktemp ADVISERS_HOME; no network, no real HOME.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { toIcs } from '../lib/remind.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_ACCEPT_TOS: '1', ADVISERS_NO_MODEL: '1', ADVISERS_CORE_LOCAL: '1' }
const NOW = '2026-11-22T10:00:00+08:00'

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'advisers-043-remind-'))
}

function run(home, args, input = '') {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home },
    encoding: 'utf8', input, timeout: 60000,
  })
}

const reminder = { commitmentId: 'cm_test_1', action: '给王工发报价', dueAt: '2026-11-23T18:00:00+08:00', bucket: 'due-tomorrow', level: 'L2', ruleId: 'tomorrow' }
const ICS_NOW = new Date('2026-11-22T02:00:00Z')

test('toIcs keeps its 0.4.2 bytes unless the new options are opt-in', () => {
  const plain = toIcs([reminder], { now: ICS_NOW })
  assert.ok(!plain.includes('VTIMEZONE'), 'default export has no VTIMEZONE')
  assert.ok(!plain.includes('TZID='), 'default export has no explicit TZID')
  assert.match(plain, /\r\nDTSTART:20261123T100000Z\r\n/)
  assert.ok(!plain.includes('cm_test_1') || /UID:[^\r\n]*cm_test_1/.test(plain), 'id only appears in the UID by default')
  assert.equal((plain.match(/cm_test_1/g) ?? []).length, 1, 'default: commitment id appears only in the UID')
})

test('toIcs tzid + alarmCommitmentId emit VTIMEZONE, wall-clock DTSTART and VALARM ids', () => {
  const enhanced = toIcs([reminder], { now: ICS_NOW, tzid: 'Asia/Shanghai', alarmCommitmentId: true })
  assert.match(enhanced, /BEGIN:VTIMEZONE\r\nTZID:Asia\/Shanghai\r\n/)
  assert.match(enhanced, /DTSTART;TZID=Asia\/Shanghai:20261123T180000/)
  assert.match(enhanced, /X-ADVISERS-COMMITMENT-ID:cm_test_1/)
  assert.match(enhanced, /DESCRIPTION:提醒：给王工发报价（1 天前） · 承诺 cm_test_1/)
  assert.throws(() => toIcs([reminder], { now: ICS_NOW, tzid: 'UTC' }), /only supports tzid=Asia\/Shanghai/)
})

test('remind --ics writes an enhanced calendar that imports back', () => {
  const home = makeHome()
  try {
    const added = run(home, ['commit', 'add', '给王工发报价', '--quote', '周五前把报价发我', '--due', '2026-11-23T18:00:00+08:00'])
    assert.equal(added.status, 0, added.stderr)
    const icsPath = join(home, 'reminders.ics')
    const wrote = run(home, ['remind', '--ics', icsPath, '--now', NOW])
    assert.equal(wrote.status, 0, wrote.stderr)
    assert.match(wrote.stdout, /ics written: .*1 events/)
    const ics = readFileSync(icsPath, 'utf8')
    assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:Asia\/Shanghai\r\n/)
    assert.match(ics, /DTSTART;TZID=Asia\/Shanghai:2026112\dT180000/)
    assert.match(ics, /SUMMARY:给王工发报价/)
    assert.match(ics, /X-ADVISERS-COMMITMENT-ID:cm_/)
    assert.match(ics, /DESCRIPTION:提醒：给王工发报价（[^）]+） · 承诺 cm_/)
    const imported = run(home, ['calendar', 'import', '--ics', icsPath])
    assert.equal(imported.status, 0, imported.stderr)
    assert.match(imported.stdout, /calendar import: 1 events/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('per-commitment 24h cooldown suppresses repeat notifications but keeps the local log', () => {
  const home = makeHome()
  try {
    const added = run(home, ['commit', 'add', '给王工发报价', '--quote', '周五前把报价发我', '--due', '2026-11-22T18:30:00+08:00'])
    assert.equal(added.status, 0, added.stderr)
    const logPath = join(home, 'reminders.log')
    const first = run(home, ['remind', '--deliver', '--notify', '--now', '2026-11-22T18:00:00+08:00'])
    assert.equal(first.status, 0, first.stderr)
    assert.doesNotMatch(first.stdout, /通知通道：cooldown-suppressed/)
    assert.match(first.stdout, /通知通道：/)
    assert.match(first.stderr, /通知冷却：跳过/, 'two same-commitment reminders in one batch deliver one')
    const second = run(home, ['remind', '--deliver', '--notify', '--now', '2026-11-23T08:00:00+08:00'])
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /通知已冷却：同一承诺 24 小时内已经通知过/)
    assert.match(second.stdout, /通知通道：cooldown-suppressed/)
    const forced = run(home, ['remind', '--deliver', '--notify', '--force-notify', '--now', '2026-11-23T08:00:00+08:00'])
    assert.equal(forced.status, 0, forced.stderr)
    assert.doesNotMatch(forced.stdout, /cooldown-suppressed/)
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 3, 'every run appends exactly one local log line')
    assert.ok(lines.every((line) => /\t\d+\t/.test(line)), 'log lines keep the timestamp/count/actions shape')
  } finally { rmSync(home, { recursive: true, force: true }) }
})