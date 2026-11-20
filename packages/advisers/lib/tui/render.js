/**
 * Pure renderers for the 0.3.0 output kernel: status line, result/error/confirm blocks
 * and the read-only snapshot. No I/O, no readline, no clock, no store access.
 *
 * The same functions serve three consumers, which is the point of the kernel:
 *   - the future interactive shell (0.3.2) and the existing CLI human output;
 *   - --once / redirected / --plain / --accessible byte snapshots;
 *   - golden unit tests.
 *
 * Layout rules (docs/TUI.md):
 *   - append-only lines, no borders, no tabs, no full-width padding;
 *   - every line is display width <= the requested width (prefix included);
 *   - prefixes are stable: '> ', '  - ', '  文件：', '  校验：', '  ! ',
 *     '  下一步：', '! 没做成：', '! 需要确认：', '[状态] ';
 *   - sanitisation happens before measurement/wrapping: model output, tool results,
 *     IMAP subjects and webhook bodies are untrusted text and are treated as data;
 *   - colour (when enabled) only ever uses the 16-colour SGR whitelist and never
 *     carries the only meaning - every line keeps its textual prefix.
 *
 * Options accepted by every renderer: { width, color, accessible, labels, ... }.
 * A resolveOutputPolicy() object can be spread into the options; width is normally
 * clampColumns(process.stdout.columns).
 */
import { styleText } from './color.js'
import { DEFAULT_LABELS } from './labels.js'
import { sanitizeDisplay } from './sanitize.js'
import { clampColumns, strWidth, truncateMiddle, truncateToWidth, wrap } from './width.js'

const ROLE_PREFIX = Object.freeze({
  fact: 'indent',
  body: 'indent',
  item: 'itemPrefix',
  check: 'checkPrefix',
  warning: 'warningPrefix',
  next: 'nextPrefix',
  reason: 'reasonPrefix',
  kept: 'keptPrefix',
  write: 'writePrefix',
  summary: 'summaryPrefix',
  digest: 'digestPrefix',
  code: 'codePrefix',
})

const ROLE_STYLE = Object.freeze({
  warning: 'yellow',
  next: 'dim',
  code: 'dim',
})

/**
 * Format a byte count for an artifact line (`23.4 KB`).
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.floor(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const rounded = Math.round(value * 10) / 10
  return `${rounded} ${units[index]}`
}

/**
 * Format a duration for the verbose duration line (`320ms`, `1.2s`, `2m5s`).
 *
 * @param {number} milliseconds
 * @returns {string}
 */
export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return ''
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60000) return `${Math.round(milliseconds / 100) / 10}s`
  const totalSeconds = Math.round(milliseconds / 1000)
  return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`
}

/**
 * Render the one-line status. Returns a single string, never a multi-line block.
 *
 * Kinds: idle (default), busy, confirm, error, offline. With `accessible: true` the
 * symbol is replaced by `[状态] ` (screen-reader friendly) and colour is disabled.
 * When the width is too small, right-most segments are dropped in order (hint, model,
 * today summary), then the line is truncated with an ellipsis.
 *
 * @param {{
 *   kind?: 'idle' | 'busy' | 'confirm' | 'error' | 'offline',
 *   today?: { due?: number, overdue?: number },
 *   model?: string | null, local?: boolean,
 *   hint?: string | null, seconds?: number, reason?: string,
 * }} [status]
 * @param {{ width?: number, color?: boolean, accessible?: boolean, labels?: object }} [options]
 * @returns {string}
 */
export function renderStatus(status = {}, options = {}) {
  const { width, color, accessible, labels } = renderOptions(options)
  const value = status ?? {}
  const kind = typeof value.kind === 'string' ? value.kind : 'idle'
  const segments = []
  let symbol = '*'
  let style = 'dim'
  let dropFront = false
  if (kind === 'busy') {
    symbol = '~'
    style = 'yellow'
    segments.push(Number.isFinite(value.seconds) ? labels.statusBusy(Math.max(0, Math.floor(value.seconds))) : labels.statusBusyNoTimer)
  } else if (kind === 'confirm') {
    symbol = '!'
    style = 'yellow'
    segments.push(labels.statusConfirm)
  } else if (kind === 'error') {
    symbol = '!'
    style = 'red'
    const reason = sanitizeDisplay(value.reason === undefined || value.reason === null || value.reason === '' ? labels.statusUnknownReason : value.reason, { singleLine: true })
    segments.push(labels.statusError(reason))
  } else if (kind === 'offline') {
    style = 'yellow'
    // Degrade from the front: dropping the offline signal would claim health.
    dropFront = true
    segments.push(labels.statusReady)
    segments.push(labels.statusOffline)
  } else {
    segments.push(labels.statusReady)
    if (value.today && typeof value.today === 'object') {
      const due = toCount(value.today.due)
      const overdue = toCount(value.today.overdue)
      segments.push(due === 0 && overdue === 0 ? labels.statusTodayClear : labels.statusToday(due, overdue))
    }
    if (value.local === true || value.model === 'local') segments.push(labels.statusLocalModel)
    else if (typeof value.model === 'string' && value.model.length > 0) segments.push(sanitizeDisplay(value.model, { singleLine: true }))
    const hint = value.hint === undefined ? labels.statusHelpHint : value.hint
    if (hint !== null && hint !== undefined && hint !== '') segments.push(sanitizeDisplay(hint, { singleLine: true }))
  }
  const prefix = accessible ? labels.statusAccessiblePrefix : `${symbol} `
  const compose = () => prefix + segments.join(labels.statusSeparator)
  while (segments.length > 1 && strWidth(compose()) > width) {
    if (dropFront) segments.shift()
    else segments.pop()
  }
  let line = compose()
  if (strWidth(line) > width) line = truncateToWidth(line, width)
  if (color && !accessible) line = styleText(prefix, style) + line.slice(prefix.length)
  return line
}

/**
 * Render a result/error/notice block as display lines (append-only, no trailing newline).
 *
 * @param {{
 *   kind?: 'result' | 'error' | 'notice',
 *   prompt?: string,
 *   headline?: string,
 *   summary?: string,
 *   lines?: Array<string | { text: string, role?: string }>,
 *   artifacts?: Array<{ path: string, bytes?: number, verified?: boolean | null }>,
 *   checks?: string[],
 *   warnings?: string[],
 *   next?: string,
 *   durationMs?: number,
 *   tools?: Array<{ name: string, ok: boolean }>,
 *   code?: string,
 * }} [block]
 * @param {{ width?: number, color?: boolean, accessible?: boolean, labels?: object, maxLines?: number, maxItems?: number, verbose?: boolean }} [options]
 * @returns {string[]}
 */
export function renderResult(block = {}, options = {}) {
  const { width, color, labels, maxLines, maxItems, verbose } = renderOptions(options)
  const value = block ?? {}
  const kind = value.kind === 'error' ? 'error' : value.kind === 'notice' ? 'notice' : 'result'
  const out = []
  if (value.prompt !== undefined && value.prompt !== null && value.prompt !== '') {
    const text = sanitizeDisplay(value.prompt, { singleLine: true })
    const available = Math.max(1, width - strWidth(labels.userPrefix))
    const line = labels.userPrefix + truncateToWidth(text, available)
    out.push(color ? styleText(line, 'dim') : line)
  }
  if (kind === 'error') {
    pushField(out, value.headline ?? value.title ?? '', { prefix: labels.errorPrefix, width, color, style: 'red' })
  } else if (value.headline !== undefined && value.headline !== null && value.headline !== '') {
    pushField(out, value.headline, { prefix: labels.indent, width })
  }
  if (value.summary !== undefined && value.summary !== null && value.summary !== '') pushSummary(out, value.summary, { width, maxLines, labels })
  let itemCount = 0
  for (const raw of Array.isArray(value.lines) ? value.lines : []) {
    const line = typeof raw === 'string' ? { text: raw } : raw
    if (line === null || typeof line !== 'object' || line.text === undefined || line.text === null) continue
    if (typeof line.text === 'string' && line.text.trim() === '') continue
    const role = typeof line.role === 'string' && ROLE_PREFIX[line.role] !== undefined ? line.role : 'fact'
    if (role === 'item') {
      itemCount += 1
      if (itemCount > maxItems) continue
    }
    const prefix = labels[ROLE_PREFIX[role]]
    const style = ROLE_STYLE[role]
    pushField(out, line.text, { prefix, width, color: color && style !== undefined, style })
  }
  if (itemCount > maxItems) out.push(labels.overflowItems(itemCount - maxItems))
  for (const artifact of Array.isArray(value.artifacts) ? value.artifacts : []) {
    if (artifact === null || typeof artifact !== 'object') continue
    if (typeof artifact.path !== 'string' || artifact.path === '') continue
    pushField(out, artifactLine(artifact, width, labels), { prefix: labels.filePrefix, width })
  }
  for (const check of Array.isArray(value.checks) ? value.checks : []) {
    if (check === undefined || check === null || String(check).trim() === '') continue
    pushField(out, check, { prefix: labels.checkPrefix, width })
  }
  const warnings = Array.isArray(value.warnings) ? value.warnings.filter((warning) => warning !== undefined && warning !== null && warning !== '') : []
  if (warnings.length > 0) {
    const suffix = warnings.length > 1 ? labels.warningOverflow(warnings.length - 1) : ''
    pushField(out, `${warnings[0]}${suffix}`, { prefix: labels.warningPrefix, width, color, style: 'yellow' })
  }
  if (value.next !== undefined && value.next !== null && value.next !== '') pushField(out, value.next, { prefix: labels.nextPrefix, width, color, style: 'dim' })
  if (kind === 'error' && value.code !== undefined && value.code !== null && value.code !== '') pushField(out, value.code, { prefix: labels.codePrefix, width, color, style: 'dim' })
  if (verbose) {
    for (const tool of Array.isArray(value.tools) ? value.tools : []) {
      if (tool === null || typeof tool !== 'object') continue
      const name = sanitizeDisplay(tool.name ?? 'tool', { singleLine: true })
      out.push(labels.verboseTool(name, tool.ok === true))
    }
    if (Number.isFinite(value.durationMs)) out.push(labels.verboseDuration(formatDuration(value.durationMs)))
  }
  return out
}

/**
 * Render a failure block: `! 没做成：<what>` + 原因 / 已保留 / 下一步 / 代码.
 *
 * @param {{ title?: string, what?: string, reason?: string, kept?: string, next?: string, code?: string, lines?: Array<string | object>, warnings?: string[], prompt?: string }} [error]
 * @param {object} [options] same options as renderResult
 * @returns {string[]}
 */
export function renderError(error = {}, options = {}) {
  const value = error ?? {}
  const lines = []
  if (value.reason !== undefined && value.reason !== null && value.reason !== '') lines.push({ role: 'reason', text: value.reason })
  for (const extra of Array.isArray(value.lines) ? value.lines : []) lines.push(extra)
  if (value.kept !== undefined && value.kept !== null && value.kept !== '') lines.push({ role: 'kept', text: value.kept })
  return renderResult({
    kind: 'error',
    prompt: value.prompt,
    headline: value.title ?? value.what ?? '',
    lines,
    warnings: value.warnings,
    next: value.next,
    code: value.code,
  }, options)
}

/**
 * Render a confirmation block. Default answer is always No; the caller renders the
 * outcome and passes the digest back to policy (the shell only renders/echoes it).
 *
 * @param {{ title?: string, what?: string, reason?: string, write?: string, summary?: string, digest?: string, prompt?: string }} [confirm]
 * @param {object} [options] same options as renderResult
 * @returns {string[]}
 */
export function renderConfirm(confirm = {}, options = {}) {
  const { width, color, labels } = renderOptions(options)
  const value = confirm ?? {}
  const out = []
  pushField(out, value.title ?? value.what ?? '', { prefix: labels.confirmPrefix, width, color, style: 'yellow' })
  if (value.reason !== undefined && value.reason !== null && value.reason !== '') pushField(out, value.reason, { prefix: labels.reasonPrefix, width })
  if (value.write !== undefined && value.write !== null && value.write !== '') pushField(out, value.write, { prefix: labels.writePrefix, width })
  if (value.summary !== undefined && value.summary !== null && value.summary !== '') pushField(out, value.summary, { prefix: labels.summaryPrefix, width })
  if (value.digest !== undefined && value.digest !== null && value.digest !== '') pushField(out, value.digest, { prefix: labels.digestPrefix, width })
  const prompt = value.prompt === undefined ? labels.confirmPrompt : value.prompt
  if (prompt !== null && prompt !== undefined && prompt !== '') {
    const text = sanitizeDisplay(prompt, { singleLine: true })
    const available = Math.max(1, width - strWidth(labels.indent))
    const line = labels.indent + truncateToWidth(text, available)
    out.push(color ? styleText(line, 'dim') : line)
  }
  return out
}

/**
 * Render the read-only `tui --once` snapshot shape as display lines.
 *
 * The current dashboard text stays owned by bin/advisers.js until the Wave-2 wiring;
 * this renderer exists so a future snapshot/--plain path shares the same width and
 * sanitisation rules. Sections are rendered in order with a blank line between them.
 *
 * @param {{ title?: string, sections?: Array<{ heading?: string, lines?: string[] }> }} [snapshot]
 * @param {{ width?: number, color?: boolean, labels?: object }} [options]
 * @returns {string[]}
 */
export function renderSnapshot(snapshot = {}, options = {}) {
  const { width, labels } = renderOptions(options)
  const value = snapshot ?? {}
  const out = []
  if (value.title !== undefined && value.title !== null && value.title !== '') pushField(out, value.title, { prefix: '', width })
  for (const section of Array.isArray(value.sections) ? value.sections : []) {
    if (section === null || typeof section !== 'object') continue
    if (out.length > 0) out.push('')
    if (section.heading !== undefined && section.heading !== null && section.heading !== '') pushField(out, section.heading, { prefix: '', width })
    for (const line of Array.isArray(section.lines) ? section.lines : []) pushField(out, line, { prefix: labels.indent, width })
  }
  return out
}

function renderOptions(options = {}) {
  const value = options ?? {}
  const accessible = value.accessible === true
  return {
    width: clampColumns(value.width),
    color: value.color === true && !accessible,
    accessible,
    labels: value.labels ?? DEFAULT_LABELS,
    maxLines: Number.isInteger(value.maxLines) && value.maxLines >= 0 ? value.maxLines : 20,
    maxItems: Number.isInteger(value.maxItems) && value.maxItems >= 0 ? value.maxItems : 8,
    verbose: value.verbose === true,
  }
}

function pushField(out, value, { prefix = '', width, color = false, style = null }) {
  const text = sanitizeDisplay(value, { singleLine: true, expandTabs: true })
  if (text === '' && prefix === '') return
  const prefixWidth = strWidth(prefix)
  const continuation = ' '.repeat(prefixWidth)
  const bodyWidth = Math.max(1, width - prefixWidth)
  const lines = text === '' ? [''] : wrap(text, bodyWidth)
  for (let index = 0; index < lines.length; index += 1) {
    const line = ((index === 0 ? prefix : continuation) + lines[index]).replace(/ +$/, '')
    out.push(color && style !== null ? styleText(line, style) : line)
  }
}

function pushSummary(out, value, { width, maxLines, labels }) {
  const text = sanitizeDisplay(value, { expandTabs: true })
  const lines = []
  for (const sourceLine of text.split('\n')) {
    if (sourceLine === '') {
      lines.push('')
      continue
    }
    for (const wrapped of wrap(sourceLine, Math.max(1, width - strWidth(labels.indent)))) lines.push(labels.indent + wrapped)
  }
  if (lines.length <= maxLines) {
    out.push(...lines)
    return
  }
  out.push(...lines.slice(0, maxLines))
  out.push(labels.overflowLines(lines.length - maxLines))
}

function artifactLine(artifact, width, labels) {
  const prefixWidth = strWidth(labels.filePrefix)
  const available = Math.max(1, width - prefixWidth)
  const parts = []
  if (Number.isFinite(artifact.bytes)) parts.push(formatBytes(artifact.bytes))
  if (artifact.verified === true) parts.push('结构通过')
  if (artifact.verified === false) parts.push('校验失败')
  const suffix = parts.length > 0 ? `（${parts.join('，')}）` : ''
  const path = sanitizeDisplay(artifact.path ?? '', { singleLine: true })
  const pathBudget = available - strWidth(suffix)
  const displayPath = strWidth(path) > pathBudget ? truncateMiddle(path, Math.max(1, pathBudget)) : path
  const line = displayPath + suffix
  return strWidth(line) > available ? truncateMiddle(line, available) : line
}

function toCount(value) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

