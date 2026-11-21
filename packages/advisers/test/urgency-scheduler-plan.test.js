import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CRON_MARKER,
  DEFAULT_CRON_SCHEDULE,
  DEFAULT_MORNING_CRON_SCHEDULE,
  DEFAULT_MORNING_TASK_NAME,
  DEFAULT_MORNING_TASK_TIME,
  DEFAULT_MORNING_WEEKDAYS,
  DEFAULT_TASK_NAME,
  DEFAULT_TASK_TIME,
  MORNING_CRON_MARKER,
  SCHEDULER_STATUS_VERSION,
  SCHEDULER_STATUS_VERSION_V2,
  addCronEntry,
  buildSchtasksCommand,
  defaultSchedulerStatusV2,
  getCronEntries,
  getCronEntry,
  planCronInstall,
  planCronInstallBlocks,
  planCronStatusBlocks,
  planCronUninstall,
  planCronUninstallBlocks,
  planSchedulerBlocks,
  planWindowsInstallBlocks,
  planWindowsUninstallBlocks,
  readSchedulerStatus,
  readSchedulerStatusV2,
  recordSchedulerRun,
  recordSchedulerRunV2,
  schedulerPaths,
  validateTaskDays,
} from '../lib/scheduler.js'

const EXISTING_CRONTAB = '# backup\n0 1 * * * /usr/bin/backup --daily\n'
const REMIND_COMMAND = 'node cli.js remind --deliver --notify'
const MORNING_COMMAND = 'node cli.js morning --archive'
const BLOCKS = [
  { marker: CRON_MARKER, schedule: DEFAULT_CRON_SCHEDULE, command: REMIND_COMMAND },
  { marker: MORNING_CRON_MARKER, schedule: DEFAULT_MORNING_CRON_SCHEDULE, command: MORNING_COMMAND },
]

test('two-block cron install produces one atomic, byte-stable crontab write', () => {
  assert.equal(CRON_MARKER, 'advisers-remind')
  assert.equal(MORNING_CRON_MARKER, 'advisers-morning')
  assert.equal(DEFAULT_CRON_SCHEDULE, '0 9 * * *')
  assert.equal(DEFAULT_MORNING_CRON_SCHEDULE, '30 8 * * 1-5')
  assert.deepEqual([...DEFAULT_MORNING_WEEKDAYS], ['MON', 'TUE', 'WED', 'THU', 'FRI'])

  const plan = planCronInstallBlocks({ existingText: EXISTING_CRONTAB, blocks: BLOCKS })
  assert.equal(plan.platform, 'cron')
  assert.equal(plan.action, 'install')
  assert.equal(plan.dryRun, true, 'dry-run is the default everywhere')
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.markers, [CRON_MARKER, MORNING_CRON_MARKER])
  assert.equal(plan.commands.length, 1, 'both blocks are installed with one crontab write')
  assert.equal(plan.commands[0].command, 'crontab')
  assert.deepEqual(plan.commands[0].args, ['-'])
  assert.equal(plan.commands[0].stdin, plan.text)
  assert.deepEqual(plan.blocks.map((block) => [block.marker, block.changed, block.added, block.updated]), [
    [CRON_MARKER, true, true, false],
    [MORNING_CRON_MARKER, true, true, false],
  ])
  const expected = [
    '# backup',
    '0 1 * * * /usr/bin/backup --daily',
    '# >>> advisers-remind >>>',
    '0 9 * * * node cli.js remind --deliver --notify',
    '# <<< advisers-remind <<<',
    '# >>> advisers-morning >>>',
    '30 8 * * 1-5 node cli.js morning --archive',
    '# <<< advisers-morning <<<',
    '',
  ].join('\n')
  assert.equal(plan.text, expected, 'the exact crontab text is the plan snapshot')

  const entries = getCronEntries(plan.text, { markers: [CRON_MARKER, MORNING_CRON_MARKER] })
  assert.deepEqual(entries.map((entry) => [entry.marker, entry.installed, entry.schedule, entry.command, entry.malformed]), [
    [CRON_MARKER, true, '0 9 * * *', REMIND_COMMAND, false],
    [MORNING_CRON_MARKER, true, '30 8 * * 1-5', MORNING_COMMAND, false],
  ])

  const again = planCronInstallBlocks({ existingText: plan.text, blocks: BLOCKS })
  assert.equal(again.changed, false)
  assert.deepEqual(again.commands, [])
  assert.ok(again.blocks.every((block) => block.alreadyInstalled === true))

  const partial = planCronInstallBlocks({ existingText: addCronEntry('', { command: REMIND_COMMAND }).text, blocks: BLOCKS })
  assert.equal(partial.changed, true)
  assert.deepEqual(partial.blocks.map((block) => [block.marker, block.changed]), [[CRON_MARKER, false], [MORNING_CRON_MARKER, true]])
})

test('two-block uninstall removes only the managed blocks and preserves every other line', () => {
  const installed = planCronInstallBlocks({ existingText: EXISTING_CRONTAB, blocks: BLOCKS }).text
  const plan = planCronUninstallBlocks({ existingText: installed, markers: [MORNING_CRON_MARKER, CRON_MARKER] })
  assert.equal(plan.platform, 'cron')
  assert.equal(plan.action, 'uninstall')
  assert.equal(plan.dryRun, true)
  assert.equal(plan.changed, true)
  assert.equal(plan.installed, false)
  assert.deepEqual(plan.markers, [MORNING_CRON_MARKER, CRON_MARKER])
  assert.deepEqual(plan.removedMarkers, [MORNING_CRON_MARKER, CRON_MARKER])
  assert.equal(plan.commands.length, 1)
  assert.equal(plan.text, EXISTING_CRONTAB)

  const again = planCronUninstallBlocks({ existingText: plan.text, markers: [MORNING_CRON_MARKER, CRON_MARKER] })
  assert.equal(again.changed, false)
  assert.deepEqual(again.removedMarkers, [])
  assert.deepEqual(again.commands, [])

  const remindOnly = addCronEntry(EXISTING_CRONTAB, { command: REMIND_COMMAND }).text
  const one = planCronUninstallBlocks({ existingText: remindOnly, markers: [MORNING_CRON_MARKER, CRON_MARKER] })
  assert.deepEqual(one.removedMarkers, [CRON_MARKER])
  assert.equal(one.text, EXISTING_CRONTAB)
})

test('the single-block 0.3.2 API stays byte-identical to the multi-block path', () => {
  const single = planCronInstall({ existingText: EXISTING_CRONTAB, command: REMIND_COMMAND })
  const multi = planCronInstallBlocks({ existingText: EXISTING_CRONTAB, blocks: [BLOCKS[0]] })
  assert.equal(multi.text, single.text)
  assert.deepEqual(multi.commands, single.commands)
  assert.equal(multi.changed, single.changed)
  assert.equal(getCronEntry(single.text).command, REMIND_COMMAND)

  const uninstallSingle = planCronUninstall({ existingText: single.text })
  const uninstallMulti = planCronUninstallBlocks({ existingText: single.text, markers: [CRON_MARKER] })
  assert.equal(uninstallMulti.text, uninstallSingle.text)
  assert.deepEqual(uninstallMulti.commands, uninstallSingle.commands)

  const status = planCronStatusBlocks({ existingText: single.text, markers: [CRON_MARKER] })
  assert.equal(status.entries.length, 1)
  assert.equal(status.entries[0].installed, true)
  assert.deepEqual(status.commands, [{ command: 'crontab', args: ['-l'] }])
})

test('multi-block plans validate markers, schedules and commands', () => {
  assert.throws(() => planCronInstallBlocks({ existingText: '', blocks: [] }), TypeError)
  assert.throws(() => planCronInstallBlocks({ existingText: '', blocks: 'nope' }), TypeError)
  assert.throws(() => planCronInstallBlocks({ existingText: '', blocks: [BLOCKS[0], BLOCKS[0]] }), TypeError, 'duplicate markers are rejected')
  assert.throws(() => planCronInstallBlocks({ existingText: '', blocks: [{ marker: 'bad marker', command: 'node x' }] }), TypeError)
  assert.throws(() => planCronInstallBlocks({ existingText: '', blocks: [{ marker: 'ok', command: 'node x\nrm -rf /' }] }), TypeError)
  assert.throws(() => planCronInstallBlocks({ existingText: '', blocks: [{ marker: 'ok', command: 'node x', schedule: 'bad schedule' }] }), TypeError)
  assert.throws(() => getCronEntries('', { markers: [] }), TypeError)
  assert.throws(() => getCronEntries('', { markers: [CRON_MARKER, CRON_MARKER] }), TypeError)
  assert.throws(() => planCronUninstallBlocks({ existingText: '', markers: 'advisers-remind' }), TypeError)
})

test('Windows daily + weekly-with-days plans are argv snapshots and dry-run by default', () => {
  const plan = planWindowsInstallBlocks({
    blocks: [
      { marker: CRON_MARKER, taskName: DEFAULT_TASK_NAME, command: REMIND_COMMAND, time: DEFAULT_TASK_TIME, schedule: 'daily' },
      { marker: MORNING_CRON_MARKER, taskName: DEFAULT_MORNING_TASK_NAME, command: MORNING_COMMAND, time: DEFAULT_MORNING_TASK_TIME, schedule: 'weekly', days: [...DEFAULT_MORNING_WEEKDAYS] },
    ],
  })
  assert.equal(plan.platform, 'win32')
  assert.equal(plan.action, 'install')
  assert.equal(plan.dryRun, true)
  assert.equal(plan.changed, true)
  assert.equal(plan.commands.length, 2)
  assert.deepEqual(plan.commands[0].args, ['/Create', '/TN', DEFAULT_TASK_NAME, '/TR', REMIND_COMMAND, '/SC', 'DAILY', '/ST', DEFAULT_TASK_TIME, '/F'])
  assert.deepEqual(plan.commands[1].args, ['/Create', '/TN', DEFAULT_MORNING_TASK_NAME, '/TR', MORNING_COMMAND, '/SC', 'WEEKLY', '/D', 'MON,TUE,WED,THU,FRI', '/ST', DEFAULT_MORNING_TASK_TIME, '/F'])
  assert.deepEqual(plan.blocks.map((block) => [block.taskName, block.schedule, block.days]), [
    [DEFAULT_TASK_NAME, 'daily', undefined],
    [DEFAULT_MORNING_TASK_NAME, 'weekly', ['MON', 'TUE', 'WED', 'THU', 'FRI']],
  ])

  const uninstall = planWindowsUninstallBlocks({ blocks: plan.blocks })
  assert.equal(uninstall.action, 'uninstall')
  assert.equal(uninstall.dryRun, true)
  assert.deepEqual(uninstall.commands.map((command) => command.args), [
    ['/Delete', '/TN', DEFAULT_TASK_NAME, '/F'],
    ['/Delete', '/TN', DEFAULT_MORNING_TASK_NAME, '/F'],
  ])

  assert.deepEqual(
    buildSchtasksCommand({ action: 'create', taskName: 'T', command: 'node x', time: '08:30', schedule: 'weekly' }).args,
    ['/Create', '/TN', 'T', '/TR', 'node x', '/SC', 'WEEKLY', '/D', 'MON,TUE,WED,THU,FRI', '/ST', '08:30', '/F'],
    'weekly defaults to the work week',
  )
  assert.deepEqual(validateTaskDays('mon,tue,mon,wed'), ['MON', 'TUE', 'WED'])
  assert.throws(() => validateTaskDays([]), TypeError)
  assert.throws(() => validateTaskDays('MONDAY'), TypeError)
  assert.throws(() => buildSchtasksCommand({ action: 'create', command: 'node x', schedule: 'hourly' }), TypeError)
  assert.throws(() => buildSchtasksCommand({ action: 'create', command: 'node x', days: ['MON'] }), TypeError, 'a daily schedule does not take days')
  assert.throws(() => planWindowsInstallBlocks({ blocks: [{ command: 'node x', schedule: 'weekly', days: ['FUNDAY'] }] }), TypeError)
})

test('planSchedulerBlocks dispatches by platform and keeps dry-run default', () => {
  const linux = planSchedulerBlocks({ platform: 'linux', action: 'install', existingText: '', blocks: BLOCKS })
  assert.equal(linux.platform, 'cron')
  assert.equal(linux.dryRun, true)
  assert.equal(linux.commands.length, 1)

  const darwinStatus = planSchedulerBlocks({ platform: 'darwin', action: 'status', existingText: linux.text })
  assert.deepEqual(darwinStatus.entries.map((entry) => [entry.marker, entry.installed]), [
    [CRON_MARKER, true],
    [MORNING_CRON_MARKER, true],
  ])

  const win = planSchedulerBlocks({ platform: 'win32', action: 'install', blocks: [{ command: REMIND_COMMAND, taskName: DEFAULT_TASK_NAME }] })
  assert.equal(win.platform, 'win32')
  const winStatus = planSchedulerBlocks({ platform: 'win32', action: 'status', blocks: [{ taskName: DEFAULT_TASK_NAME }, { taskName: DEFAULT_MORNING_TASK_NAME }] })
  assert.equal(winStatus.entries.length, 2)
  assert.deepEqual(winStatus.entries[1].commands[0].args, ['/Query', '/TN', DEFAULT_MORNING_TASK_NAME])
  assert.throws(() => planSchedulerBlocks({ platform: 'aix', action: 'install', blocks: BLOCKS }), TypeError)
})

test('status v2 keeps both sections, upgrades v1 files and writes atomically', () => {
  const home = mkdtempSync(join(tmpdir(), 'advisers-scheduler-v2-'))
  try {
    const paths = schedulerPaths({ homeDir: home })
    assert.equal(SCHEDULER_STATUS_VERSION, 1)
    assert.equal(SCHEDULER_STATUS_VERSION_V2, 2)
    assert.deepEqual(defaultSchedulerStatusV2(), {
      version: 2,
      remind: { lastRun: null, lastResult: null, lastCount: null, lastChannel: null },
      morning: { lastRun: null, lastResult: null, lastCount: null, lastPath: null },
      updatedAt: null,
    })

    const missing = readSchedulerStatusV2({ homeDir: home })
    assert.equal(missing.version, 2)
    assert.equal(missing.exists, false)
    assert.equal(missing.corrupt, false)
    assert.equal(missing.legacy, false)
    assert.equal(missing.remind.lastRun, null)
    assert.equal(missing.morning.lastRun, null)

    // A 0.3.2 (v1) status file still reads: flat fields map into the remind section.
    recordSchedulerRun({ homeDir: home, at: '2026-11-21T09:00:00+08:00', count: 3, channel: 'webhook', dryRun: false })
    const legacy = readSchedulerStatusV2({ homeDir: home })
    assert.equal(legacy.legacy, true)
    assert.equal(legacy.version, 2)
    assert.equal(legacy.remind.lastRun, '2026-11-21T01:00:00.000Z')
    assert.equal(legacy.remind.lastCount, 3)
    assert.equal(legacy.remind.lastChannel, 'webhook')
    assert.equal(legacy.morning.lastRun, null)
    assert.equal(readSchedulerStatus({ homeDir: home }).version, 1, 'the v1 reader is untouched')

    const dry = recordSchedulerRunV2({ homeDir: home, at: '2026-11-21T09:30:00+08:00', section: 'remind', count: 4, channel: 'webhook' })
    assert.equal(dry.written, false)
    assert.equal(dry.status.version, 2)
    assert.equal(dry.status.remind.lastRun, '2026-11-21T01:30:00.000Z')
    assert.equal(readSchedulerStatusV2({ homeDir: home }).legacy, true, 'a dry run leaves the v1 file alone')

    const reminds = recordSchedulerRunV2({ homeDir: home, at: '2026-11-21T09:30:00+08:00', section: 'remind', count: 4, channel: 'webhook', dryRun: false })
    assert.equal(reminds.written, true)
    assert.equal(reminds.path, paths.statusFile)
    const stored = JSON.parse(readFileSync(paths.statusFile, 'utf8'))
    assert.deepEqual(Object.keys(stored).sort(), ['morning', 'remind', 'updatedAt', 'version'])
    assert.equal(stored.version, 2)
    assert.equal(stored.remind.lastRun, '2026-11-21T01:30:00.000Z')
    assert.equal(stored.remind.lastResult, 'ok')
    assert.equal(stored.remind.lastCount, 4)
    assert.equal(stored.remind.lastChannel, 'webhook')
    assert.deepEqual(stored.morning, { lastRun: null, lastResult: null, lastCount: null, lastPath: null })
    if (process.platform !== 'win32') assert.equal(statSync(paths.statusFile).mode & 0o777, 0o600)

    const morning = recordSchedulerRunV2({ homeDir: home, at: '2026-11-21T08:30:00+08:00', section: 'morning', count: 2, result: 'ok', path: join(home, 'briefs', '2026-11-21.md'), dryRun: false })
    assert.equal(morning.written, true)
    const after = readSchedulerStatusV2({ homeDir: home })
    assert.equal(after.legacy, false)
    assert.equal(after.remind.lastRun, '2026-11-21T01:30:00.000Z', 'the remind section survives a morning write')
    assert.equal(after.morning.lastRun, '2026-11-21T00:30:00.000Z')
    assert.equal(after.morning.lastResult, 'ok')
    assert.equal(after.morning.lastCount, 2)
    assert.equal(after.morning.lastPath, join(home, 'briefs', '2026-11-21.md'))
    assert.equal(after.updatedAt, '2026-11-21T00:30:00.000Z')
    // A 0.3.2 reader still sees the remind section of a v2 file (cross-version read).
    const v1View = readSchedulerStatus({ homeDir: home })
    assert.equal(v1View.version, 1)
    assert.equal(v1View.lastRun, '2026-11-21T01:30:00.000Z')
    assert.equal(v1View.lastResult, 'ok')
    assert.equal(v1View.lastCount, 4)
    assert.equal(v1View.lastChannel, 'webhook')
    assert.ok(!Object.hasOwn(after.morning, 'lastChannel'), 'the morning section uses lastPath, not lastChannel')

    // A corrupt file degrades instead of throwing, and the next record recovers it.
    writeFileSync(paths.statusFile, '{not json')
    const corrupt = readSchedulerStatusV2({ homeDir: home })
    assert.equal(corrupt.corrupt, true)
    assert.equal(corrupt.remind.lastRun, null)
    assert.equal(corrupt.morning.lastRun, null)
    const recovered = recordSchedulerRunV2({ homeDir: home, at: '2026-11-22T09:00:00+08:00', section: 'remind', count: 1, dryRun: false })
    assert.equal(recovered.written, true)
    assert.equal(readSchedulerStatusV2({ homeDir: home }).corrupt, false)

    assert.throws(() => recordSchedulerRunV2({ homeDir: home, section: 'weekly' }), TypeError)
    assert.throws(() => recordSchedulerRunV2({ homeDir: home, at: 'not-a-date', dryRun: false }), RangeError)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
