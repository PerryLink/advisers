import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_TASK_NAME,
  addCronEntry,
  buildCronBlock,
  buildCronCommand,
  buildSchtasksCommand,
  crontabReadCommand,
  crontabWriteCommand,
  getCronEntry,
  planCronInstall,
  planCronStatus,
  planCronUninstall,
  planScheduler,
  planWindowsInstall,
  planWindowsStatus,
  planWindowsUninstall,
  quoteShellArgument,
  readSchedulerStatus,
  recordSchedulerRun,
  removeCronEntry,
  schedulerPaths,
  validateCronSchedule,
  validateTaskName,
  validateTaskTime,
} from '../lib/scheduler.js'

const COMMAND = '/usr/local/bin/node /opt/advisers/cli.js remind --deliver --notify'

test('cron command quoting keeps paths with spaces and escapes crontab percents', () => {
  assert.equal(quoteShellArgument('simple'), 'simple')
  assert.equal(quoteShellArgument('/usr/bin/node'), '/usr/bin/node')
  assert.equal(quoteShellArgument('with space'), "'with space'")
  assert.equal(quoteShellArgument("a'b"), "'a'\\''b'")
  assert.equal(quoteShellArgument(''), "''")

  assert.equal(
    buildCronCommand({ nodeBin: '/usr/local/bin/node', cliPath: '/home/me/My Advisers/cli.js', args: ['remind', '--deliver'] }),
    "/usr/local/bin/node '/home/me/My Advisers/cli.js' remind --deliver",
  )
  assert.equal(buildCronCommand({ nodeBin: 'node', cliPath: 'a%b', args: [] }), 'node a\\%b')
  assert.throws(() => buildCronCommand({ args: ['bad\narg'] }), TypeError)
  assert.throws(() => buildCronCommand({ args: 'not-an-array' }), TypeError)
})

test('cron schedules are validated as five safe fields', () => {
  assert.equal(validateCronSchedule(' 0  9 * * * '), '0 9 * * *')
  assert.equal(validateCronSchedule('*/15 9-18 * * 1-5'), '*/15 9-18 * * 1-5')
  for (const invalid of ['0 9 * *', '0 9 * * * *', '0 9 * * *\nrm -rf /', '0 9 * * *; rm', '', null, 42]) {
    assert.throws(() => validateCronSchedule(invalid), 'expected rejection for ' + String(invalid))
  }
})

test('addCronEntry appends one idempotent managed block', () => {
  const added = addCronEntry('', { command: COMMAND })
  assert.equal(added.changed, true)
  assert.equal(added.added, true)
  assert.equal(added.alreadyInstalled, false)
  assert.ok(added.text.startsWith('# >>> advisers-remind >>>\n'))
  assert.ok(added.text.includes(`0 9 * * * ${COMMAND}\n`))
  assert.ok(added.text.endsWith('# <<< advisers-remind <<<\n'))

  const entry = getCronEntry(added.text)
  assert.equal(entry.installed, true)
  assert.equal(entry.schedule, '0 9 * * *')
  assert.equal(entry.command, COMMAND)
  assert.equal(entry.malformed, false)

  const again = addCronEntry(added.text, { command: COMMAND })
  assert.equal(again.changed, false)
  assert.equal(again.alreadyInstalled, true)
  assert.equal(again.text, added.text)

  const updated = addCronEntry(added.text, { command: COMMAND, schedule: '30 8 * * 1-5' })
  assert.equal(updated.changed, true)
  assert.equal(updated.updated, true)
  assert.equal((updated.text.match(/>>> advisers-remind >>>/g) ?? []).length, 1)
  assert.equal((updated.text.match(/<<< advisers-remind <<</g) ?? []).length, 1)
  assert.ok(updated.text.includes(`30 8 * * 1-5 ${COMMAND}`))
  assert.ok(!updated.text.includes('0 9 * * *'))
})

test('removeCronEntry preserves every other crontab line', () => {
  const existing = '# backup\n0 1 * * * /usr/bin/backup --daily\n'
  const installed = addCronEntry(existing, { command: COMMAND })
  assert.ok(installed.text.startsWith(existing), 'the managed block is appended after existing lines')

  const removed = removeCronEntry(installed.text)
  assert.equal(removed.changed, true)
  assert.equal(removed.removed, true)
  assert.equal(removed.text, existing)

  const absent = removeCronEntry(existing)
  assert.equal(absent.changed, false)
  assert.equal(absent.text, existing)

  // A block whose end marker is missing heals by replacing through EOF.
  const malformed = '# >>> advisers-remind >>>\n0 9 * * * node old.js remind\n'
  assert.equal(getCronEntry(malformed).malformed, true)
  const healed = addCronEntry(malformed, { command: COMMAND })
  assert.equal(healed.changed, true)
  assert.ok(!healed.text.includes('node old.js'))
  assert.equal(getCronEntry(healed.text).malformed, false)
  assert.equal(removeCronEntry(malformed).text, '')
})

test('cron input cannot inject extra crontab lines', () => {
  assert.throws(() => addCronEntry('', { command: 'node x\n0 0 * * * rm -rf /' }), TypeError)
  assert.throws(() => addCronEntry('', { command: '' }), TypeError)
  assert.throws(() => buildCronBlock({ command: 'node x', marker: 'bad marker' }), TypeError)
  assert.throws(() => buildCronBlock({ command: 'node x', marker: 'a\nb' }), TypeError)
  assert.throws(() => getCronEntry('', { marker: 'bad marker' }), TypeError)
})

test('crontab command descriptors are data, not execution', () => {
  assert.deepEqual(crontabReadCommand(), { command: 'crontab', args: ['-l'] })
  assert.deepEqual(crontabWriteCommand('abc\n'), { command: 'crontab', args: ['-'], stdin: 'abc\n' })
})

test('schtasks commands are generated for create/delete/query', () => {
  const created = buildSchtasksCommand({ action: 'create', taskName: 'Advisers Remind', command: 'node C:\\tools\\advisers.js remind', time: '09:00' })
  assert.equal(created.command, 'schtasks')
  assert.deepEqual(created.args, ['/Create', '/TN', 'Advisers Remind', '/TR', 'node C:\\tools\\advisers.js remind', '/SC', 'DAILY', '/ST', '09:00', '/F'])
  assert.deepEqual(buildSchtasksCommand({ action: 'delete', taskName: 'T' }), { command: 'schtasks', args: ['/Delete', '/TN', 'T', '/F'] })
  assert.deepEqual(buildSchtasksCommand({ action: 'query', taskName: 'T' }), { command: 'schtasks', args: ['/Query', '/TN', 'T'] })
  assert.throws(() => buildSchtasksCommand({ action: 'nope' }), TypeError)
  assert.throws(() => validateTaskTime('9:00'), TypeError)
  assert.throws(() => validateTaskTime('24:00'), TypeError)
  assert.throws(() => validateTaskTime('09:60'), TypeError)
  assert.equal(validateTaskTime('08:30'), '08:30')
  assert.throws(() => validateTaskName('a\nb'), TypeError)
  assert.throws(() => validateTaskName('  '), TypeError)
})

test('plans are dry-run by default and never execute anything', () => {
  const install = planCronInstall({ existingText: '', command: COMMAND })
  assert.equal(install.platform, 'cron')
  assert.equal(install.action, 'install')
  assert.equal(install.dryRun, true)
  assert.equal(install.changed, true)
  assert.equal(install.installed, true)
  assert.equal(install.commands.length, 1)
  assert.equal(install.commands[0].command, 'crontab')
  assert.equal(install.commands[0].stdin, install.text)

  const noop = planCronInstall({ existingText: install.text, command: COMMAND })
  assert.equal(noop.changed, false)
  assert.deepEqual(noop.commands, [])
  assert.equal(noop.dryRun, true)

  const uninstall = planCronUninstall({ existingText: install.text })
  assert.equal(uninstall.action, 'uninstall')
  assert.equal(uninstall.changed, true)
  assert.equal(uninstall.text, '')
  assert.deepEqual(uninstall.commands[0].stdin, '')

  const status = planCronStatus({ existingText: install.text })
  assert.equal(status.installed, true)
  assert.equal(status.schedule, '0 9 * * *')
  assert.equal(status.command, COMMAND)
  assert.deepEqual(status.commands, [crontabReadCommand()])

  const winInstall = planWindowsInstall({ command: 'node advisers.js remind', time: '08:30' })
  assert.equal(winInstall.platform, 'win32')
  assert.equal(winInstall.dryRun, true)
  assert.deepEqual(winInstall.commands[0].args, ['/Create', '/TN', DEFAULT_TASK_NAME, '/TR', 'node advisers.js remind', '/SC', 'DAILY', '/ST', '08:30', '/F'])
  assert.deepEqual(planWindowsUninstall({}).commands[0].args, ['/Delete', '/TN', DEFAULT_TASK_NAME, '/F'])
  const winStatus = planWindowsStatus({})
  assert.equal(winStatus.installed, null)
  assert.deepEqual(winStatus.commands[0].args, ['/Query', '/TN', DEFAULT_TASK_NAME])

  assert.equal(planScheduler({ platform: 'linux', action: 'install', existingText: '', command: 'node x' }).platform, 'cron')
  assert.equal(planScheduler({ platform: 'darwin', action: 'status', existingText: '' }).platform, 'cron')
  assert.equal(planScheduler({ platform: 'win32', action: 'install', command: 'node x' }).platform, 'win32')
  assert.throws(() => planScheduler({ platform: 'aix', action: 'install', command: 'node x' }), TypeError)
})

test('status.json records lastRun atomically and tolerates missing/corrupt files', () => {
  const home = mkdtempSync(join(tmpdir(), 'advisers-scheduler-'))
  try {
    const paths = schedulerPaths({ homeDir: home })
    assert.equal(paths.dir, join(home, 'scheduler'))
    assert.equal(paths.statusFile, join(home, 'scheduler', 'status.json'))

    const missing = readSchedulerStatus({ homeDir: home })
    assert.equal(missing.exists, false)
    assert.equal(missing.corrupt, false)
    assert.equal(missing.lastRun, null)
    assert.equal(missing.version, 1)

    // Dry-run by default: the plan carries lastRun but writes nothing.
    const dry = recordSchedulerRun({ homeDir: home, at: '2026-11-17T09:00:00+08:00', count: 3, channel: 'webhook' })
    assert.equal(dry.written, false)
    assert.equal(dry.status.lastRun, '2026-11-17T01:00:00.000Z')
    assert.equal(existsSync(paths.statusFile), false)

    const written = recordSchedulerRun({ homeDir: home, at: '2026-11-17T09:00:00+08:00', count: 3, channel: 'webhook', result: 'ok', dryRun: false })
    assert.equal(written.written, true)
    assert.equal(written.path, paths.statusFile)
    const stored = JSON.parse(readFileSync(paths.statusFile, 'utf8'))
    assert.deepEqual(Object.keys(stored).sort(), ['lastChannel', 'lastCount', 'lastResult', 'lastRun', 'updatedAt', 'version'])
    assert.equal(stored.version, 1)
    assert.equal(stored.lastRun, '2026-11-17T01:00:00.000Z')
    assert.equal(stored.lastResult, 'ok')
    assert.equal(stored.lastCount, 3)
    assert.equal(stored.lastChannel, 'webhook')
    assert.equal(stored.updatedAt, '2026-11-17T01:00:00.000Z')

    const read = readSchedulerStatus({ homeDir: home })
    assert.equal(read.exists, true)
    assert.equal(read.corrupt, false)
    assert.equal(read.lastRun, '2026-11-17T01:00:00.000Z')
    assert.deepEqual(readdirSync(home), ['scheduler'])
    assert.deepEqual(readdirSync(paths.dir), ['status.json'])

    writeFileSync(paths.statusFile, '{not json')
    const corrupt = readSchedulerStatus({ homeDir: home })
    assert.equal(corrupt.corrupt, true)
    assert.equal(corrupt.lastRun, null)

    // A partial/legacy status file keeps the fields that are valid.
    writeFileSync(paths.statusFile, JSON.stringify({ lastRun: '2026-11-16T01:00:00.000Z' }))
    const legacy = readSchedulerStatus({ homeDir: home })
    assert.equal(legacy.corrupt, false)
    assert.equal(legacy.lastRun, '2026-11-16T01:00:00.000Z')
    assert.equal(legacy.lastResult, null)

    assert.throws(() => recordSchedulerRun({ homeDir: home, at: 'not-a-date' }), RangeError)
    const noCount = recordSchedulerRun({ homeDir: home, at: Date.now(), count: 'lots' })
    assert.equal(noCount.written, false)
    assert.equal(noCount.status.lastCount, null)
    assert.equal(noCount.status.lastResult, 'ok')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the scheduler library imports no process-spawning API', () => {
  const source = readFileSync(new URL('../lib/scheduler.js', import.meta.url), 'utf8')
  assert.ok(!/node:child_process|require\(['"]child_process['"]\)/.test(source))
  assert.ok(!/\b(execSync|spawnSync|execFileSync)\b/.test(source))
  assert.ok(!/\bspawn\s*\(/.test(source))
  assert.ok(!/\bexecFile\s*\(/.test(source))
})
