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

/** Proactive 0.4: second managed crontab block for the archived morning brief. */
export const MORNING_CRON_MARKER = 'advisers-morning'
export const DEFAULT_MORNING_CRON_SCHEDULE = '30 8 * * 1-5'
export const DEFAULT_MORNING_TASK_NAME = 'Advisers Morning'
export const DEFAULT_MORNING_TASK_TIME = '08:30'
/** Windows weekly day abbreviations accepted by `schtasks /D`. */
export const DEFAULT_MORNING_WEEKDAYS = Object.freeze(['MON', 'TUE', 'WED', 'THU', 'FRI'])
export const DEFAULT_MORNING_ARGS = Object.freeze(['morning', '--archive'])

/** Version 2 scheduler status: per-section lastRun for remind + morning. */
export const SCHEDULER_STATUS_VERSION_V2 = 2
export const SCHEDULER_SECTIONS = Object.freeze(['remind', 'morning'])
/** Platforms where `crontab(1)` is the user-level scheduler. */
export const CRON_PLATFORMS = Object.freeze(['linux', 'darwin', 'freebsd', 'openbsd', 'sunos'])

const MARKER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const CRON_FIELD = /^[0-9A-Za-z*,/-]+$/
const TASK_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
const TASK_DAY = /^(MON|TUE|WED|THU|FRI|SAT|SUN)$/

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


function normalizeMarkers(markers) {
  if (!Array.isArray(markers) || !markers.length) throw new TypeError('markers must be a non-empty array')
  const seen = new Set()
  const list = []
  for (const marker of markers) {
    const safe = validateMarker(marker)
    if (seen.has(safe)) throw new TypeError(`duplicate scheduler marker: ${safe}`)
    seen.add(safe)
    list.push(safe)
  }
  return list
}

function normalizeCronBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw new TypeError('blocks must be a non-empty array')
  const seen = new Set()
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') throw new TypeError('each scheduler block must be an object')
    const marker = validateMarker(block.marker)
    if (seen.has(marker)) throw new TypeError(`duplicate scheduler marker: ${marker}`)
    seen.add(marker)
    return {
      marker,
      schedule: validateCronSchedule(block.schedule ?? DEFAULT_CRON_SCHEDULE),
      command: validateCronCommand(block.command),
    }
  })
}

/**
 * Read several managed blocks in the caller-supplied `markers` order.
 * Unmanaged crontab lines are never inspected or modified.
 *
 * @returns {Array<{marker: string, installed: boolean, schedule: string|null,
 *   command: string|null, malformed: boolean}>}
 */
export function getCronEntries(text, { markers = [CRON_MARKER] } = {}) {
  const list = normalizeMarkers(markers)
  return list.map((marker) => ({ marker, ...getCronEntry(text, { marker }) }))
}

/**
 * Append or replace several managed blocks in one pass. Blocks are applied in
 * order to the evolving text; every other crontab line is preserved verbatim.
 *
 * @returns {{text: string, changed: boolean, blocks: Array<{marker: string,
 *   changed: boolean, added: boolean, alreadyInstalled: boolean, updated: boolean}>}}
 */
export function addCronBlocks(text, { blocks } = {}) {
  const list = normalizeCronBlocks(blocks)
  let current = String(text ?? '')
  let changed = false
  const results = []
  for (const block of list) {
    const change = addCronEntry(current, block)
    current = change.text
    changed = changed || change.changed
    results.push({
      marker: block.marker,
      changed: change.changed,
      added: change.added,
      alreadyInstalled: change.alreadyInstalled,
      updated: change.updated,
    })
  }
  return { text: current, changed, blocks: results }
}

/**
 * Remove several managed blocks by marker, leaving every unmanaged line as-is.
 * A marker that is not installed is reported (not an error), so uninstall is
 * idempotent for both blocks.
 *
 * @returns {{text: string, changed: boolean, removedMarkers: string[]}}
 */
export function removeCronBlocks(text, { markers } = {}) {
  const list = normalizeMarkers(markers)
  let current = String(text ?? '')
  const removedMarkers = []
  for (const marker of list) {
    const change = removeCronEntry(current, { marker })
    current = change.text
    if (change.removed) removedMarkers.push(marker)
  }
  return { text: current, changed: removedMarkers.length > 0, removedMarkers }
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
 * Validate a Windows weekly day list (`MON`..`SUN`), as an array or a
 * comma-separated string. Duplicates collapse and the input order is preserved.
 *
 * @param {string[]|string} days
 * @returns {string[]}
 */
export function validateTaskDays(days) {
  const items = Array.isArray(days) ? days : typeof days === 'string' ? days.split(',') : null
  if (!items) throw new TypeError('task days must be an array or a comma-separated string')
  const seen = new Set()
  const normalized = []
  for (const item of items) {
    const text = String(item ?? '').trim().toUpperCase()
    if (!TASK_DAY.test(text)) throw new TypeError(`invalid task day: ${String(item)} (expected MON..SUN)`)
    if (seen.has(text)) continue
    seen.add(text)
    normalized.push(text)
  }
  if (!normalized.length) throw new TypeError('task days must not be empty')
  return normalized
}

/**
 * Generate the schtasks argv for create/delete/query. Nothing is executed.
 *
 * Proactive 0.4 adds an additive `schedule: 'daily'|'weekly'` (+ `days` for
 * weekly); the default daily argv is byte-identical to 0.3.2.
 *
 * @returns {{ command: 'schtasks', args: string[] }}
 */
export function buildSchtasksCommand({ action = 'create', taskName = DEFAULT_TASK_NAME, command, time = DEFAULT_TASK_TIME, schedule = 'daily', days } = {}) {
  const safeTask = validateTaskName(taskName)
  if (action === 'create') {
    const safeCommand = validateCronCommand(command)
    const safeTime = validateTaskTime(time)
    if (schedule === 'daily') {
      if (days !== undefined && days !== null) throw new TypeError('a daily schtasks schedule does not take days')
      return { command: 'schtasks', args: ['/Create', '/TN', safeTask, '/TR', safeCommand, '/SC', 'DAILY', '/ST', safeTime, '/F'] }
    }
    if (schedule === 'weekly') {
      const safeDays = validateTaskDays(days ?? DEFAULT_MORNING_WEEKDAYS)
      return { command: 'schtasks', args: ['/Create', '/TN', safeTask, '/TR', safeCommand, '/SC', 'WEEKLY', '/D', safeDays.join(','), '/ST', safeTime, '/F'] }
    }
    throw new TypeError(`unknown schtasks schedule: ${String(schedule)}`)
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


/**
 * Dry-run plan for installing several cron blocks at once (one `crontab -`
 * write for all changes, matching 0.3.2's single-block contract).
 */
export function planCronInstallBlocks({ existingText = '', blocks, dryRun = true } = {}) {
  const list = normalizeCronBlocks(blocks)
  const change = addCronBlocks(existingText, { blocks: list })
  return {
    platform: 'cron',
    action: 'install',
    dryRun: dryRun !== false,
    changed: change.changed,
    installed: true,
    markers: list.map((block) => block.marker),
    blocks: change.blocks,
    text: change.text,
    commands: change.changed ? [crontabWriteCommand(change.text)] : [],
  }
}

/** Dry-run plan for removing several cron blocks at once. */
export function planCronUninstallBlocks({ existingText = '', markers, dryRun = true } = {}) {
  const list = normalizeMarkers(markers)
  const change = removeCronBlocks(existingText, { markers: list })
  return {
    platform: 'cron',
    action: 'uninstall',
    dryRun: dryRun !== false,
    changed: change.changed,
    installed: false,
    markers: list,
    removedMarkers: change.removedMarkers,
    text: change.text,
    commands: change.changed ? [crontabWriteCommand(change.text)] : [],
  }
}

/** Read-only status for several cron blocks (the CLI executes the read command). */
export function planCronStatusBlocks({ existingText = '', markers = [CRON_MARKER, MORNING_CRON_MARKER] } = {}) {
  const list = normalizeMarkers(markers)
  return {
    platform: 'cron',
    action: 'status',
    dryRun: true,
    entries: list.map((marker) => getCronEntry(existingText, { marker })),
    commands: [crontabReadCommand()],
  }
}
/** Dry-run plan for a Windows Task Scheduler install (argv only, not executed). */
export function planWindowsInstall({ command, taskName = DEFAULT_TASK_NAME, time = DEFAULT_TASK_TIME, schedule = 'daily', days, dryRun = true } = {}) {
  if (schedule !== 'daily' && schedule !== 'weekly') throw new TypeError(`unknown schtasks schedule: ${String(schedule)}`)
  const plan = {
    platform: 'win32',
    action: 'install',
    dryRun: dryRun !== false,
    changed: true,
    installed: null,
    taskName: validateTaskName(taskName),
    time: validateTaskTime(time),
    schedule,
    commands: [buildSchtasksCommand({ action: 'create', taskName, command, time, schedule, ...(days === undefined ? {} : { days }) })],
  }
  if (schedule === 'weekly') plan.days = validateTaskDays(days ?? DEFAULT_MORNING_WEEKDAYS)
  return plan
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

function normalizeWindowsInstallBlock(block) {
  if (!block || typeof block !== 'object') throw new TypeError('each scheduler block must be an object')
  const schedule = block.schedule === undefined ? (block.days === undefined ? 'daily' : 'weekly') : block.schedule
  if (schedule !== 'daily' && schedule !== 'weekly') throw new TypeError(`unknown schtasks schedule: ${String(schedule)}`)
  const taskName = validateTaskName(block.taskName ?? (schedule === 'weekly' ? DEFAULT_MORNING_TASK_NAME : DEFAULT_TASK_NAME))
  const time = validateTaskTime(block.time ?? (schedule === 'weekly' ? DEFAULT_MORNING_TASK_TIME : DEFAULT_TASK_TIME))
  const days = schedule === 'weekly' ? validateTaskDays(block.days ?? DEFAULT_MORNING_WEEKDAYS) : undefined
  return {
    marker: block.marker === undefined || block.marker === null ? null : validateMarker(block.marker),
    taskName,
    command: validateCronCommand(block.command),
    time,
    schedule,
    days,
  }
}

function normalizeWindowsTaskList(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw new TypeError('blocks must be a non-empty array')
  return blocks.map((block) => {
    if (typeof block === 'string') return { taskName: validateTaskName(block) }
    if (!block || typeof block !== 'object') throw new TypeError('each scheduler block must be an object or a task name')
    if (block.taskName === undefined || block.taskName === null) throw new TypeError('windows scheduler blocks require taskName')
    return { taskName: validateTaskName(block.taskName) }
  })
}

/**
 * Dry-run plan for installing several Windows scheduled tasks (argv only).
 * Each block carries its own taskName/time/schedule/days; the daily argv is
 * byte-identical to the 0.3.2 single-task plan.
 */
export function planWindowsInstallBlocks({ blocks, dryRun = true } = {}) {
  if (!Array.isArray(blocks) || !blocks.length) throw new TypeError('blocks must be a non-empty array')
  const list = blocks.map(normalizeWindowsInstallBlock)
  return {
    platform: 'win32',
    action: 'install',
    dryRun: dryRun !== false,
    changed: true,
    installed: null,
    blocks: list.map((block) => ({
      marker: block.marker,
      taskName: block.taskName,
      time: block.time,
      schedule: block.schedule,
      ...(block.days ? { days: block.days } : {}),
    })),
    commands: list.map((block) => buildSchtasksCommand({
      action: 'create',
      taskName: block.taskName,
      command: block.command,
      time: block.time,
      schedule: block.schedule,
      ...(block.days ? { days: block.days } : {}),
    })),
  }
}

/** Dry-run plan for removing several Windows scheduled tasks (argv only). */
export function planWindowsUninstallBlocks({ blocks, dryRun = true } = {}) {
  const list = normalizeWindowsTaskList(blocks)
  return {
    platform: 'win32',
    action: 'uninstall',
    dryRun: dryRun !== false,
    changed: true,
    installed: false,
    blocks: list.map((block) => ({ taskName: block.taskName })),
    commands: list.map((block) => buildSchtasksCommand({ action: 'delete', taskName: block.taskName })),
  }
}

/** Read-only plan for several Windows scheduled tasks (the CLI runs the query). */
export function planWindowsStatusBlocks({ blocks } = {}) {
  const list = normalizeWindowsTaskList(blocks)
  return {
    platform: 'win32',
    action: 'status',
    dryRun: true,
    installed: null,
    entries: list.map((block) => ({
      taskName: block.taskName,
      installed: null,
      commands: [buildSchtasksCommand({ action: 'query', taskName: block.taskName })],
    })),
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


/**
 * Platform dispatcher for the multi-block install/uninstall/status plans.
 * Accepts `{ blocks }` for install, `{ markers }`/`{ blocks }` for uninstall and
 * the same options for status; never executes a system command.
 */
export function planSchedulerBlocks(options = {}) {
  const opts = options ?? {}
  const platform = opts.platform ?? process.platform
  const action = opts.action ?? 'install'
  if (platform === 'win32') {
    if (action === 'install') return planWindowsInstallBlocks(opts)
    if (action === 'uninstall') return planWindowsUninstallBlocks(opts)
    if (action === 'status') return planWindowsStatusBlocks(opts)
  } else if (CRON_PLATFORMS.includes(platform)) {
    if (action === 'install') return planCronInstallBlocks(opts)
    if (action === 'uninstall') return planCronUninstallBlocks(opts)
    if (action === 'status') return planCronStatusBlocks(opts)
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
  // Cross-version read: a v2 document maps its `remind` section back to the flat
  // v1 fields, so a 0.3.2 reader never loses lastRun after a v2 writer ran.
  const source = parsed.version === SCHEDULER_STATUS_VERSION_V2 && parsed.remind && typeof parsed.remind === 'object'
    ? parsed.remind
    : parsed
  const status = defaultSchedulerStatus()
  if (typeof source.lastRun === 'string' && !Number.isNaN(Date.parse(source.lastRun))) status.lastRun = new Date(source.lastRun).toISOString()
  if (typeof source.lastResult === 'string' && source.lastResult) status.lastResult = source.lastResult
  if (Number.isFinite(source.lastCount)) status.lastCount = Number(source.lastCount)
  if (typeof source.lastChannel === 'string' && source.lastChannel) status.lastChannel = source.lastChannel
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

/* ------------------------------------------------------------------ */
/* Status v2: per-section lastRun for remind + morning (additive to v1) */
/* ------------------------------------------------------------------ */

/** `remind` section of the version-2 status document. */
export function defaultSchedulerRemindStatus() {
  return { lastRun: null, lastResult: null, lastCount: null, lastChannel: null }
}

/** `morning` section of the version-2 status document. */
export function defaultSchedulerMorningStatus() {
  return { lastRun: null, lastResult: null, lastCount: null, lastPath: null }
}

export function defaultSchedulerStatusV2() {
  return {
    version: SCHEDULER_STATUS_VERSION_V2,
    remind: defaultSchedulerRemindStatus(),
    morning: defaultSchedulerMorningStatus(),
    updatedAt: null,
  }
}

function readStatusDocument(options = {}) {
  const { statusFile } = schedulerPaths(options ?? {})
  let raw
  try {
    raw = readFileSync(statusFile, 'utf8')
  } catch (error) {
    return { statusFile, doc: null, exists: false, corrupt: false, error: error?.code === 'ENOENT' ? null : 'read-error' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { statusFile, doc: null, exists: true, corrupt: true, error: null }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { statusFile, doc: null, exists: true, corrupt: true, error: null }
  }
  return { statusFile, doc: parsed, exists: true, corrupt: false, error: null }
}

function sanitizeStatusTime(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

function readRemindStatusSection(source) {
  const section = defaultSchedulerRemindStatus()
  if (!source || typeof source !== 'object' || Array.isArray(source)) return section
  section.lastRun = sanitizeStatusTime(source.lastRun)
  if (typeof source.lastResult === 'string' && source.lastResult) section.lastResult = source.lastResult
  if (Number.isFinite(source.lastCount)) section.lastCount = Number(source.lastCount)
  if (typeof source.lastChannel === 'string' && source.lastChannel) section.lastChannel = source.lastChannel
  return section
}

function readMorningStatusSection(source) {
  const section = defaultSchedulerMorningStatus()
  if (!source || typeof source !== 'object' || Array.isArray(source)) return section
  section.lastRun = sanitizeStatusTime(source.lastRun)
  if (typeof source.lastResult === 'string' && source.lastResult) section.lastResult = source.lastResult
  if (Number.isFinite(source.lastCount)) section.lastCount = Number(source.lastCount)
  if (typeof source.lastPath === 'string' && source.lastPath) section.lastPath = source.lastPath
  return section
}

/**
 * Read the version-2 scheduler status. A v1 (flat) file is mapped into the
 * `remind` section instead of failing — upgrading never loses lastRun — and a
 * corrupt file degrades to defaults. `legacy: true` means the file on disk is
 * still the v1 layout (the next record writes v2).
 *
 * @returns {{version: 2, remind: object, morning: object, updatedAt: string|null,
 *   exists: boolean, corrupt: boolean, legacy: boolean, error: string|null, path: string}}
 */
export function readSchedulerStatusV2(options = {}) {
  const read = readStatusDocument(options)
  const base = defaultSchedulerStatusV2()
  if (!read.exists) return { ...base, exists: false, corrupt: false, legacy: false, error: read.error, path: read.statusFile }
  if (read.corrupt) return { ...base, exists: true, corrupt: true, legacy: false, error: null, path: read.statusFile }
  const doc = read.doc
  const legacy = doc.version !== SCHEDULER_STATUS_VERSION_V2
  return {
    version: SCHEDULER_STATUS_VERSION_V2,
    remind: readRemindStatusSection(legacy ? doc : doc.remind),
    morning: readMorningStatusSection(legacy ? null : doc.morning),
    updatedAt: sanitizeStatusTime(doc.updatedAt),
    exists: true,
    corrupt: false,
    legacy,
    error: null,
    path: read.statusFile,
  }
}

/**
 * Record one run in a section of the version-2 status file. Reads the current
 * document first (mapping v1 or recovering from a corrupt file), updates only
 * the named section and writes atomically. Defaults to dry-run; pass
 * `dryRun: false` (the CLI does this after a real run) to write the file.
 *
 * @returns {{status: object, path: string, written: boolean}}
 */
export function recordSchedulerRunV2({ homeDir, at = new Date(), section = 'remind', result = 'ok', count = null, channel = null, path = null, dryRun = true } = {}) {
  if (!SCHEDULER_SECTIONS.includes(section)) throw new TypeError(`unknown scheduler status section: ${String(section)}`)
  const when = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(when.getTime())) throw new RangeError('invalid scheduler run time')
  const paths = schedulerPaths({ homeDir })
  const current = readSchedulerStatusV2({ homeDir })
  const stamp = when.toISOString()
  const next = {
    version: SCHEDULER_STATUS_VERSION_V2,
    remind: { ...current.remind },
    morning: { ...current.morning },
    updatedAt: stamp,
  }
  const target = section === 'remind' ? next.remind : next.morning
  target.lastRun = stamp
  target.lastResult = typeof result === 'string' && result ? result : 'ok'
  target.lastCount = Number.isFinite(count) ? Number(count) : null
  if (section === 'remind') target.lastChannel = typeof channel === 'string' && channel ? channel : null
  else target.lastPath = typeof path === 'string' && path ? path : null
  if (dryRun !== false) return { status: next, path: paths.statusFile, written: false }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  const temp = `${paths.statusFile}.${process.pid}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, paths.statusFile)
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      // Best-effort cleanup only; the original error is the one that matters.
    }
    throw error
  }
  return { status: next, path: paths.statusFile, written: true }
}
