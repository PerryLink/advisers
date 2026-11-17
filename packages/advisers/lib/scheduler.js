/**
 * E1-T4: user-level scheduler planning (opt-in).
 *
 * This module never executes a system command. It produces a *plan* — the new
 * crontab text, or the argv for `schtasks` — and the CLI layer decides whether
 * to apply it. A dry-run is therefore the default everywhere in this module.
 *
 * The only side effect is the local state file
 * `~/.advisers/scheduler/status.json` (written atomically, 0600) which records
 * `lastRun` so `remind status` can show whether the schedule actually fires.
 * Tests and callers always pass an explicit `homeDir`; this module never writes
 * outside it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SCHEDULER_DIR = 'scheduler'
export const SCHEDULER_STATUS_FILE = 'status.json'
export const SCHEDULER_STATUS_VERSION = 1
export const CRON_MARKER = 'advisers-remind'
export const DEFAULT_CRON_SCHEDULE = '0 9 * * *'
export const DEFAULT_TASK_NAME = 'Advisers Remind'
export const DEFAULT_TASK_TIME = '09:00'
export const DEFAULT_REMIND_ARGS = Object.freeze(['remind', '--deliver', '--notify'])
/** Platforms where `crontab(1)` is the user-level scheduler. */
export const CRON_PLATFORMS = Object.freeze(['linux', 'darwin', 'freebsd', 'openbsd', 'sunos'])

const MARKER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const CRON_FIELD = /^[0-9A-Za-z*,/-]+$/
const TASK_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/** Quote one argv element for a POSIX shell (cron runs commands via /bin/sh). */
export function quoteShellArgument(value) {
  const text = String(value ?? '')
  if (text === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text
  return "'" + text.replace(/'/g, "'\\''") + "'"
}

/**
 * Build the cron command for `advisers remind --deliver --notify`. Crontab
 * treats `%` as a line separator even inside arguments, so it is escaped.
 */
export function buildCronCommand({ nodeBin = 'node', cliPath = 'advisers', args = DEFAULT_REMIND_ARGS } = {}) {
  if (!Array.isArray(args)) throw new TypeError('cron args must be an array')
  const argv = [nodeBin, cliPath, ...args].map((entry) => {
    if (typeof entry !== 'string') throw new TypeError('cron command arguments must be strings')
    if (/[\r\n\0]/.test(entry)) throw new TypeError('cron command arguments must be single-line')
    return entry
  })
  return argv.map(quoteShellArgument).join(' ').replace(/%/g, '\\%')
}

function validateMarker(marker) {
  const text = String(marker ?? '').trim()
  if (!MARKER_PATTERN.test(text)) throw new TypeError(`invalid scheduler marker: ${String(marker)}`)
  return text
}

/** Validate a five-field cron expression and return it normalised. */
export function validateCronSchedule(schedule) {
  if (typeof schedule !== 'string') throw new TypeError('cron schedule must be a string')
  const text = schedule.trim()
  if (/[\r\n\0]/.test(text)) throw new TypeError('cron schedule must be single-line')
  const fields = text.split(/\s+/)
  if (fields.length !== 5 || fields.some((field) => !CRON_FIELD.test(field))) {
    throw new TypeError(`invalid cron schedule: ${String(schedule)}`)
  }
  return fields.join(' ')
}

function validateCronCommand(command) {
  const text = String(command ?? '').trim()
  if (!text) throw new TypeError('cron command must not be empty')
  if (/[\r\n\0]/.test(text)) throw new TypeError('cron command must be single-line')
  return text
}

function markerTokens(marker) {
  return { start: `# >>> ${marker} >>>`, end: `# <<< ${marker} <<<` }
}

function splitLines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').split('\n')
}

function findCronBlock(lines, marker) {
  const { start: startToken, end: endToken } = markerTokens(marker)
  const start = lines.findIndex((line) => line.trim() === startToken)
  if (start === -1) return null
  const end = lines.findIndex((line, index) => index > start && line.trim() === endToken)
  return { start, end: end === -1 ? lines.length - 1 : end, malformed: end === -1 }
}

/** The managed crontab block, including the two marker comments. */
export function buildCronBlock({ command, schedule = DEFAULT_CRON_SCHEDULE, marker = CRON_MARKER } = {}) {
  const safeMarker = validateMarker(marker)
  const safeSchedule = validateCronSchedule(schedule)
  const safeCommand = validateCronCommand(command)
  const { start, end } = markerTokens(safeMarker)
  return [start, `${safeSchedule} ${safeCommand}`, end].join('\n')
}

/**
 * Inspect a crontab text for the managed block.
 *
 * @returns {{ installed: boolean, marker: string, schedule: string|null,
 *   command: string|null, malformed: boolean }}
 */
export function getCronEntry(text, { marker = CRON_MARKER } = {}) {
  const safeMarker = validateMarker(marker)
  const lines = splitLines(text)
  const block = findCronBlock(lines, safeMarker)
  if (!block) {
    return { installed: false, marker: safeMarker, schedule: null, command: null, malformed: false }
  }
  const job = lines.slice(block.start + 1, block.end).find((line) => line.trim() && !line.trim().startsWith('#'))
  const match = job ? /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/.exec(job) : null
  return {
    installed: true,
    marker: safeMarker,
    schedule: match ? job.trim().split(/\s+/).slice(0, 5).join(' ') : null,
    command: match ? match[1].trim() : null,
    malformed: block.malformed,
  }
}

/**
 * Append or replace the managed crontab block. Pure: the caller writes the
 * returned text (e.g. pipes it to `crontab -`).
 *
 * @returns {{ text: string, changed: boolean, added: boolean,
 *   alreadyInstalled: boolean, updated: boolean }}
 */
export function addCronEntry(text, { command, schedule = DEFAULT_CRON_SCHEDULE, marker = CRON_MARKER } = {}) {
  const original = String(text ?? '')
  const safeMarker = validateMarker(marker)
  const safeSchedule = validateCronSchedule(schedule)
  const safeCommand = validateCronCommand(command)
  const block = buildCronBlock({ command: safeCommand, schedule: safeSchedule, marker: safeMarker })
  const lines = splitLines(original)
  const found = findCronBlock(lines, safeMarker)
  if (found) {
    const current = getCronEntry(original, { marker: safeMarker })
    if (!found.malformed && current.schedule === safeSchedule && current.command === safeCommand) {
      return { text: original, changed: false, added: false, alreadyInstalled: true, updated: false }
    }
    lines.splice(found.start, found.end - found.start + 1, ...block.split('\n'))
    return { text: lines.join('\n'), changed: true, added: false, alreadyInstalled: false, updated: true }
  }
  const base = original === '' || original.endsWith('\n') ? original : `${original}\n`
  return { text: `${base}${block}\n`, changed: true, added: true, alreadyInstalled: false, updated: false }
}

/**
 * Remove the managed crontab block and leave every other line untouched.
 *
 * @returns {{ text: string, changed: boolean, removed: boolean }}
 */
export function removeCronEntry(text, { marker = CRON_MARKER } = {}) {
  const original = String(text ?? '')
  const safeMarker = validateMarker(marker)
  const lines = splitLines(original)
  const found = findCronBlock(lines, safeMarker)
  if (!found) return { text: original, changed: false, removed: false }
  lines.splice(found.start, found.end - found.start + 1)
  // Drop the artifact newline left behind when the block was the whole file.
  const remaining = lines.join('\n')
  return { text: remaining, changed: true, removed: true }
}

export function crontabReadCommand() {
  return { command: 'crontab', args: ['-l'] }
}

export function crontabWriteCommand(text) {
  return { command: 'crontab', args: ['-'], stdin: String(text ?? '') }
}

/** Validate a Windows Task Scheduler task name. */
export function validateTaskName(name) {
  const text = String(name ?? '').trim()
  if (!text) throw new TypeError('task name must not be empty')
  if (/[\r\n\0]/.test(text)) throw new TypeError('task name must be single-line')
  if (text.length > 200) throw new RangeError('task name is too long')
  return text
}

/** Validate a daily run time as `HH:MM` (24h). */
export function validateTaskTime(time) {
  const text = String(time ?? '').trim()
  if (!TASK_TIME.test(text)) throw new TypeError(`invalid task time: ${String(time)} (expected HH:MM)`)
  return text
}

/**
 * Generate the schtasks argv for create/delete/query. Nothing is executed.
 *
 * @returns {{ command: 'schtasks', args: string[] }}
 */
export function buildSchtasksCommand({ action = 'create', taskName = DEFAULT_TASK_NAME, command, time = DEFAULT_TASK_TIME } = {}) {
  const safeTask = validateTaskName(taskName)
  if (action === 'create') {
    const safeCommand = validateCronCommand(command)
    const safeTime = validateTaskTime(time)
    return { command: 'schtasks', args: ['/Create', '/TN', safeTask, '/TR', safeCommand, '/SC', 'DAILY', '/ST', safeTime, '/F'] }
  }
  if (action === 'delete') return { command: 'schtasks', args: ['/Delete', '/TN', safeTask, '/F'] }
  if (action === 'query') return { command: 'schtasks', args: ['/Query', '/TN', safeTask] }
  throw new TypeError(`unknown schtasks action: ${String(action)}`)
}

/** Dry-run plan for a cron-style install. */
export function planCronInstall({ existingText = '', command, schedule = DEFAULT_CRON_SCHEDULE, marker = CRON_MARKER, dryRun = true } = {}) {
  const change = addCronEntry(existingText, { command, schedule, marker })
  return {
    platform: 'cron',
    action: 'install',
    dryRun: dryRun !== false,
    changed: change.changed,
    alreadyInstalled: change.alreadyInstalled,
    installed: true,
    marker: validateMarker(marker),
    schedule: validateCronSchedule(schedule),
    command: validateCronCommand(command),
    text: change.text,
    commands: change.changed ? [crontabWriteCommand(change.text)] : [],
  }
}

/** Dry-run plan for a cron-style uninstall. */
export function planCronUninstall({ existingText = '', marker = CRON_MARKER, dryRun = true } = {}) {
  const change = removeCronEntry(existingText, { marker })
  return {
    platform: 'cron',
    action: 'uninstall',
    dryRun: dryRun !== false,
    changed: change.changed,
    installed: false,
    marker: validateMarker(marker),
    text: change.text,
    commands: change.changed ? [crontabWriteCommand(change.text)] : [],
  }
}

/** Read-only cron status query; the CLI must execute the returned read command. */
export function planCronStatus({ existingText = '', marker = CRON_MARKER } = {}) {
  return {
    platform: 'cron',
    action: 'status',
    dryRun: true,
    ...getCronEntry(existingText, { marker }),
    commands: [crontabReadCommand()],
  }
}

/** Dry-run plan for a Windows Task Scheduler install (argv only, not executed). */
export function planWindowsInstall({ command, taskName = DEFAULT_TASK_NAME, time = DEFAULT_TASK_TIME, dryRun = true } = {}) {
  return {
    platform: 'win32',
    action: 'install',
    dryRun: dryRun !== false,
    changed: true,
    installed: null,
    taskName: validateTaskName(taskName),
    time: validateTaskTime(time),
    commands: [buildSchtasksCommand({ action: 'create', taskName, command, time })],
  }
}

export function planWindowsUninstall({ taskName = DEFAULT_TASK_NAME, dryRun = true } = {}) {
  return {
    platform: 'win32',
    action: 'uninstall',
    dryRun: dryRun !== false,
    changed: true,
    installed: false,
    taskName: validateTaskName(taskName),
    commands: [buildSchtasksCommand({ action: 'delete', taskName })],
  }
}

/** Windows cannot be queried without running schtasks, so the plan carries the query argv. */
export function planWindowsStatus({ taskName = DEFAULT_TASK_NAME } = {}) {
  return {
    platform: 'win32',
    action: 'status',
    dryRun: true,
    installed: null,
    taskName: validateTaskName(taskName),
    commands: [buildSchtasksCommand({ action: 'query', taskName })],
    note: 'The CLI must run the query command; exit code 0 means scheduled.',
  }
}

/** Platform dispatcher used by the CLI: returns a plan, never executes it. */
export function planScheduler(options = {}) {
  const opts = options ?? {}
  const platform = opts.platform ?? process.platform
  const action = opts.action ?? 'install'
  if (platform === 'win32') {
    if (action === 'install') return planWindowsInstall(opts)
    if (action === 'uninstall') return planWindowsUninstall(opts)
    if (action === 'status') return planWindowsStatus(opts)
  } else if (CRON_PLATFORMS.includes(platform)) {
    if (action === 'install') return planCronInstall(opts)
    if (action === 'uninstall') return planCronUninstall(opts)
    if (action === 'status') return planCronStatus(opts)
  }
  throw new TypeError(`unsupported scheduler platform/action: ${String(platform)}/${String(action)}`)
}

/** Resolve `~/.advisers/scheduler/` without assuming a real HOME. */
export function schedulerPaths({ homeDir } = {}) {
  const home = String(homeDir ?? process.env.ADVISERS_HOME ?? join(homedir(), '.advisers'))
  const dir = join(home, SCHEDULER_DIR)
  return { home, dir, statusFile: join(dir, SCHEDULER_STATUS_FILE) }
}

export function defaultSchedulerStatus() {
  return {
    version: SCHEDULER_STATUS_VERSION,
    lastRun: null,
    lastResult: null,
    lastCount: null,
    lastChannel: null,
    updatedAt: null,
  }
}

/**
 * Read `lastRun` state. Missing or corrupt files degrade to defaults instead of
 * throwing, so a damaged status file can never block reminder delivery.
 *
 * @returns {{ version: number, lastRun: string|null, lastResult: string|null,
 *   lastCount: number|null, lastChannel: string|null, updatedAt: string|null,
 *   exists: boolean, corrupt: boolean }}
 */
export function readSchedulerStatus(options = {}) {
  const { statusFile } = schedulerPaths(options ?? {})
  let raw
  try {
    raw = readFileSync(statusFile, 'utf8')
  } catch (error) {
    return { ...defaultSchedulerStatus(), exists: false, corrupt: false, error: error?.code === 'ENOENT' ? null : 'read-error' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...defaultSchedulerStatus(), exists: true, corrupt: true }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...defaultSchedulerStatus(), exists: true, corrupt: true }
  }
  const status = defaultSchedulerStatus()
  if (typeof parsed.lastRun === 'string' && !Number.isNaN(Date.parse(parsed.lastRun))) status.lastRun = new Date(parsed.lastRun).toISOString()
  if (typeof parsed.lastResult === 'string' && parsed.lastResult) status.lastResult = parsed.lastResult
  if (Number.isFinite(parsed.lastCount)) status.lastCount = Number(parsed.lastCount)
  if (typeof parsed.lastChannel === 'string' && parsed.lastChannel) status.lastChannel = parsed.lastChannel
  if (typeof parsed.updatedAt === 'string' && !Number.isNaN(Date.parse(parsed.updatedAt))) status.updatedAt = new Date(parsed.updatedAt).toISOString()
  return { ...status, exists: true, corrupt: false }
}

/**
 * Record one scheduler run in `status.json`. Defaults to dry-run: pass
 * `dryRun: false` (the CLI does this after a real delivery) to write the file.
 *
 * @returns {{ status: object, path: string, written: boolean }}
 */
export function recordSchedulerRun({ homeDir, at = new Date(), result = 'ok', count = null, channel = null, dryRun = true } = {}) {
  const paths = schedulerPaths({ homeDir })
  const when = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(when.getTime())) throw new RangeError('invalid scheduler run time')
  const status = {
    version: SCHEDULER_STATUS_VERSION,
    lastRun: when.toISOString(),
    lastResult: typeof result === 'string' && result ? result : 'ok',
    lastCount: Number.isFinite(count) ? Number(count) : null,
    lastChannel: typeof channel === 'string' && channel ? channel : null,
    updatedAt: when.toISOString(),
  }
  if (dryRun !== false) return { status, path: paths.statusFile, written: false }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  const temp = `${paths.statusFile}.${process.pid}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, paths.statusFile)
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      // Best-effort cleanup only; the original error is the one that matters.
    }
    throw error
  }
  return { status, path: paths.statusFile, written: true }
}
