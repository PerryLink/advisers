/**
 * Advisers 0.4.0 interactive shell - library layer (no bin wiring).
 *
 * The shell is an append-only readline loop with a four-state machine, the result /
 * status / error / confirmation blocks of the 0.3.x output kernel, and a strict
 * "every human line goes through sanitizeDisplay" rule. It deliberately does NOT own
 * business logic: the caller (bin/advisers.js) injects JSON-ready read-only views and
 * one turn executor through `handlers`. That keeps this module testable without a
 * store or a model, and keeps the 11k-line bin free of a second command surface.
 *
 * States (SHELL_STATES):
 *
 *   IDLE --submit--> WORKING --done/failed--> IDLE
 *     ^                |--confirm--> CONFIRM --y--> WORKING / --n|Enter|Esc--> IDLE
 *     |                +--Ctrl+C|Esc--> IDLE (interrupted block, AbortController)
 *     +-- /quit, /exit, Ctrl+D, EOF --> exit 0
 *     +-- input while WORKING --> QUEUED (buffered by readline; one prompt later)
 *
 * Keyboard semantics:
 *   - idle Ctrl+C: clear the current line, then exit on a second press within 2s;
 *   - working Ctrl+C / Esc: abort the in-flight turn through the AbortSignal;
 *   - confirm Ctrl+C / Esc: answer "no" (the default is always no);
 *   - Ctrl+D / EOF: leave with exit code 0;
 *   - plain mode (--plain/--accessible/non-TTY stdout) uses a canonical readline
 *     (terminal:false, zero ESC); there Esc is unavailable and Ctrl+C arrives as
 *     SIGINT, which the shell treats exactly like the raw-mode key.
 *
 * Non-TTY split:
 *   - stdin not a TTY: runShell() does not enter (entered:false); the caller keeps
 *     the existing "help and exit" behaviour;
 *   - stdin TTY + stdout pipe: prompt/status/confirmation go to stderr, results to
 *     stdout, one notice is written to stderr; no SGR/cursor control is emitted;
 *   - stdin TTY + stdout TTY: the normal shell.
 *
 * Injection defence: every line the shell writes (own literals, handler blocks, status
 * lines, the paste notice) is passed through sanitizeDisplay() again; kernel renderers
 * already sanitise, so this is belt-and-braces. Model/tool/store text always reaches
 * the screen through the kernel renderers as data, never as terminal control.
 *
 * Public API (the bin integration contract):
 *
 *   const result = await runShell({
 *     argv, env, stdin, stdout, stderr,
 *     store,               // passed through to handlers via ctx.store
 *     allowPaths,          // passed to handlers.turn and ctx.allowPaths
 *     handlers: {
 *       status(ctx) -> { today?, model?, local?, hint?, kind?, lines?, headline?, ... }
 *       turn(payload, ctx) -> turnResult   (see TurnResult below)
 *       history(payload, ctx) -> block | { sessions: [{ n?, id, title?, updatedAt? }] }
 *       resume(payload, ctx) -> block      ({ arg } is the user argument)
 *       newSession(ctx) -> block
 *       today(payload, ctx) -> block
 *       remind(payload, ctx) -> block
 *       who(payload, ctx) -> block
 *       client(payload, ctx) -> block      ({ args, arg }; e.g. "list" or a client id)
 *       evidence(payload, ctx) -> block    ({ arg } is the evidence id)
 *       legacyCommand(payload, ctx) -> block | undefined   (old /commands; undefined = unknown)
 *       answer(payload, ctx) -> block      (optional: answers a turn's follow-up question)
 *       opening(ctx) -> block | string[]   (optional: <=2 startup lines)
 *     },
 *     onState,             // optional test hook: ({ from, to, reason }) => void
 *   })
 *
 * `turnResult` is JSON-ready:
 *   { reply?, summary?, headline?, lines?, artifacts?, checks?, warnings?, next?,
 *     tools?: [{ name, ok }], durationMs?, internal?: string[], question?,
 *     interrupted?, error?: { title?, reason?, kept?, next?, code? } }
 * Handler blocks are the kernel shapes: renderResult/renderError/renderConfirm input
 * objects (or a plain string[]). Throwing an Error with a `code` property renders the
 * failure block with that code.
 *
 * Run result: { entered, exitCode, reason, turns }. Reasons: interactive -> quit / eof /
 * sigint / error; not entered -> stdin-not-tty / json-unsupported / disabled.
 *
 * Wiring note (0.4.0): bin/advisers.js keeps the TOS gate, model/store setup and the
 * existing runTurnInner; it passes a turn handler that adapts runTurnInner to the
 * turnResult shape. This module imports no bin code, reads no env at import time and
 * performs no I/O until runShell() is called.
 *
 * @module lib/shell
 */

import * as readline from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { Transform } from 'node:stream'

import {
  ALLOWED_SGR_CODES,
  clampColumns,
  envFlag,
  renderConfirm,
  renderError,
  renderResult,
  renderStatus,
  resolveOutputPolicy,
  sanitizeDisplay,
} from './tui/index.js'

/** Prompt printed before every input line (single static, sanitised string). */
export const SHELL_PROMPT = '\u203a '
/** The shell's four states. `queued` means input arrived while a turn was running. */
export const SHELL_STATES = Object.freeze({
  IDLE: 'idle',
  WORKING: 'working',
  CONFIRM: 'confirm',
  QUEUED: 'queued',
})
/** Core command surface shipped by the shell. */
export const SHELL_CORE_COMMANDS = Object.freeze([
  '/help',
  '/status',
  '/history',
  '/resume',
  '/new',
  '/file',
  '/files',
  '/clear',
  '/retry',
  '/verbose',
  '/more',
  '/quit',
  '/today',
  '/remind',
  '/who',
  '/client',
  '/evidence',
  '/exit',
])
/** Bracketed-paste markers emitted by xterm/VTE/Windows Terminal 1.7+. */
export const PASTE_START = '\u001b[200~'
export const PASTE_END = '\u001b[201~'
/** Pasted text is merged to one line and capped at this many characters. */
export const PASTE_MAX_CHARS = 4000
/** A lone ESC is held this long so it cannot corrupt the next typed character. */
export const ESCAPE_HOLD_MS = 200
/** Second idle Ctrl+C within this window exits the shell. */
export const SIGINT_WINDOW_MS = 2000

const EOF = Symbol('shell-eof')
const CANCEL = Symbol('shell-cancel')

const LEGACY_COMMANDS = Object.freeze([
  ['/deliveries', 'recent generated files'],
  ['/correct <text>', 'record a correction (second time promotes it)'],
  ['/matter use <id>', 'set the default matter for later writes'],
  ['/agenda', '7-day agenda (commitments + calendar)'],
  ['/memory', 'what I remember'],
  ['/commit add|ls ...', 'commitments (business write: prefer the CLI)'],
  ['/done <id> --evidence <text>', 'complete a commitment'],
  ['/search <text>', 'full-text search old turns'],
  ['/tick', 'due in the next 7 days'],
  ['/week', 'last 7 days'],
  ['/digest [day|week]', 'today/week digest'],
  ['/diff', 'show the last changed file'],
  ['/undo', 'restore the last overwritten/created file'],
  ['/links', 'candidate/confirmed links'],
  ['/forget <id>', 'forget a preference'],
  ['/prefs', 'list preferences (including candidates)'],
  ['/audit', 'verify and show the audit hash chain'],
  ['/decay', 'apply 30-day preference decay'],
  ['/why <pref-id>', 'explain a preference'],
  ['/routine save', 'save the last task as a draft routine'],
  ['/brief <text>', 'print the IntentBrief without calling the model'],
  ['/debug', 'toggle full context'],
])

/**
 * Resolve the render width for one render pass. The width is re-read on every call
 * (requirement: "width each render"), so a SIGWINCH is picked up without redraw logic.
 *
 * Precedence: `--width N` / `--width=N` argv, then `ADVISERS_SHELL_WIDTH` env, then
 * `streamOrColumns.columns`; clamped to 40..200 by the kernel.
 *
 * @param {number | { columns?: number } | null | undefined} streamOrColumns
 * @param {Record<string, unknown>} [env]
 * @param {string[]} [argv]
 * @returns {number}
 */
export function resolveShellWidth(streamOrColumns, env = {}, argv = []) {
  const fromArgv = readWidthArg(argv)
  const fromEnv = Number.parseInt(String(env?.ADVISERS_SHELL_WIDTH ?? ''), 10)
  const columns = typeof streamOrColumns === 'number' ? streamOrColumns : streamOrColumns?.columns
  let candidate = fromArgv
  if (candidate === undefined && Number.isFinite(fromEnv)) candidate = fromEnv
  if (candidate === undefined) candidate = columns
  return clampColumns(candidate)
}

function readWidthArg(argv) {
  if (!Array.isArray(argv)) return undefined
  for (let index = 0; index < argv.length; index += 1) {
    const value = typeof argv[index] === 'string' ? argv[index] : ''
    if (value === '--width') {
      const next = Number.parseInt(String(argv[index + 1] ?? ''), 10)
      if (Number.isFinite(next)) return next
      index += 1
    } else if (value.startsWith('--width=')) {
      const next = Number.parseInt(value.slice('--width='.length), 10)
      if (Number.isFinite(next)) return next
    }
  }
  return undefined
}

/**
 * Decide whether the interactive shell may run. Non-TTY stdin keeps the 0.3.x
 * "print help, exit 0" path; `--json` is not supported by the human shell.
 *
 * @param {{ argv?: string[], env?: Record<string, unknown>, stdinIsTTY?: boolean, stdoutIsTTY?: boolean, stderrIsTTY?: boolean }} [options]
 * @returns {Readonly<{ enter: boolean, reason: string, exitCode: number }>}
 */
export function shouldEnterShell({ argv = [], env = {}, stdinIsTTY = false, stdoutIsTTY = false, stderrIsTTY = false } = {}) {
  void stdoutIsTTY
  void stderrIsTTY
  if (Array.isArray(argv) && argv.includes('--json')) return Object.freeze({ enter: false, reason: 'json-unsupported', exitCode: 1 })
  if (envFlag(env, 'ADVISERS_NO_SHELL')) return Object.freeze({ enter: false, reason: 'disabled', exitCode: 0 })
  if (!stdinIsTTY) return Object.freeze({ enter: false, reason: 'stdin-not-tty', exitCode: 0 })
  return Object.freeze({ enter: true, reason: 'interactive', exitCode: 0 })
}

/**
 * Classify one input line. Rules:
 *   - blank -> empty;
 *   - a line starting with `//` sends the text starting with one `/`;
 *   - a line whose first character is whitespace but which trims to `/...` is text
 *     (the documented escape for a real message that begins with a slash);
 *   - otherwise `/name args...` is a command (name lower-cased) and everything else is
 *     natural-language text for the turn executor.
 *
 * @param {string} rawLine
 * @returns {{ kind: 'empty'|'command'|'text', raw: string, text: string, name: string|null, args: string[], arg?: string }}
 */
export function parseShellLine(rawLine) {
  const raw = typeof rawLine === 'string' ? rawLine : String(rawLine ?? '')
  if (raw.trim() === '') return { kind: 'empty', raw, text: '', name: null, args: [] }
  if (raw.startsWith('//')) return { kind: 'text', raw, text: raw.slice(1), name: null, args: [] }
  if (/^\s+\//.test(raw)) return { kind: 'text', raw, text: raw.replace(/^\s+/, ''), name: null, args: [] }
  const line = raw.trim()
  if (!line.startsWith('/')) return { kind: 'text', raw, text: line, name: null, args: [] }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(line)
  const name = (match?.[1] ?? line).toLowerCase()
  const arg = (match?.[2] ?? '').trim()
  return { kind: 'command', raw, text: line, name, args: arg === '' ? [] : arg.split(/\s+/), arg }
}

/**
 * Merge a bracketed-paste payload into one display line: strip terminal sequences,
 * fold CR/LF/tabs to spaces, collapse runs of spaces, cap at `maxChars`.
 *
 * Pure function (unit-tested); used by PasteGuard and safe to call standalone.
 *
 * @param {string} raw
 * @param {{ maxChars?: number }} [options]
 * @returns {{ text: string, lines: number, chars: number, truncated: boolean }}
 */
export function mergePastedText(raw, { maxChars = PASTE_MAX_CHARS } = {}) {
  const source = typeof raw === 'string' ? raw : String(raw ?? '')
  if (source === '') return { text: '', lines: 0, chars: 0, truncated: false }
  const display = sanitizeDisplay(source, { expandTabs: true })
  const lines = display.split('\n').length
  let text = display.replace(/[\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : PASTE_MAX_CHARS
  let truncated = false
  if (text.length > limit) {
    text = text.slice(0, limit) + '\u2026'
    truncated = true
  }
  return { text, lines, chars: source.length, truncated }
}

/**
 * Sanitise one line that the shell is about to write. Keeps leading indentation
 * (block prefixes) but forbids multi-line output: escape sequences, OSC/DCS, bidi
 * overrides, C0/C1 control characters are stripped by sanitizeDisplay.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeShellLine(value) {
  const text = sanitizeDisplay(value === null || value === undefined ? '' : value, { expandTabs: true })
  return text.replace(/\r?\n/g, ' ')
}

/**
 * Sanitise one rendered line for the wire. In colour mode the kernel's whitelisted
 * 16-colour SGR sequences are preserved (they are the only escape bytes the kernel can
 * emit), everything else - including any non-whitelisted SGR, OSC, CSI, bidi - is
 * stripped by sanitizeDisplay. In plain mode it is exactly sanitizeShellLine().
 *
 * @param {unknown} value
 * @param {{ color?: boolean }} [options]
 * @returns {string}
 */
export function sanitizeRenderedLine(value, { color = false } = {}) {
  const raw = typeof value === 'string' ? value : String(value === null || value === undefined ? '' : value)
  if (!color) return sanitizeShellLine(raw)
  const pattern = /\u001b\[([0-9;]+)m/g
  let out = ''
  let last = 0
  let match
  while ((match = pattern.exec(raw)) !== null) {
    out += sanitizeDisplay(raw.slice(last, match.index), { expandTabs: true })
    const codes = match[1].split(';').map((part) => Number.parseInt(part, 10))
    if (codes.length > 0 && codes.every((code) => ALLOWED_SGR_CODES.includes(code))) out += match[0]
    last = pattern.lastIndex
  }
  out += sanitizeDisplay(raw.slice(last), { expandTabs: true })
  return out.replace(/\r?\n/g, ' ')
}

/**
 * `/help` block (core commands, <=10 rendered lines at normal widths).
 *
 * @returns {{ headline: string, lines: Array<{ role: string, text: string }>, summary: string }}
 */
export function shellHelpBlock() {
  return {
    headline: '核心命令（业务写操作留在 CLI）',
    lines: [
      { role: 'item', text: '/help /more      帮助 / 旧命令全量' },
      { role: 'item', text: '/status          状态；/history /resume <n|id> /new 会话' },
      { role: 'item', text: '/file <path> /files /clear  附件' },
      { role: 'item', text: '/retry /verbose  重试上一轮 / 明细' },
      { role: 'item', text: '/today /remind /who /client /evidence  只读视图' },
      { role: 'item', text: '/quit（/exit、Ctrl+D）退出；Esc / Ctrl+C 中断本轮' },
    ],
    summary: '业务命令用 advisers --help；以空格或 // 开头可发送以 / 开头的文本。',
  }
}

/**
 * `/more` block: the pre-0.4 REPL command list, still routed through the caller's
 * `legacyCommand` handler when wired.
 *
 * @returns {{ headline: string, lines: Array<{ role: string, text: string }> }}
 */
export function shellMoreBlock() {
  return {
    headline: '旧命令（壳保留入口；写操作请用结果块给出的 advisers 命令）',
    lines: LEGACY_COMMANDS.map(([name, description]) => ({ role: 'item', text: `${name}  ${description}` })),
  }
}

/**
 * Static readline completer for the `/` command surface.
 *
 * @param {readonly string[]} [names]
 * @returns {(line: string) => [string[], string]}
 */
export function createCommandCompleter(names = SHELL_CORE_COMMANDS) {
  const table = Array.isArray(names) && names.length > 0 ? [...names] : [...SHELL_CORE_COMMANDS]
  return (line) => {
    const text = typeof line === 'string' ? line : String(line ?? '')
    const trimmed = text.trimStart()
    if (!trimmed.startsWith('/') || /\s/.test(trimmed)) return [[], text]
    const hits = table.filter((name) => name.startsWith(trimmed))
    return [hits.length > 0 ? hits : table, text]
  }
}

/**
 * Positive answer for a confirmation. Everything else (including Enter and EOF) is
 * "no": the default is always no.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAffirmativeAnswer(value) {
  if (typeof value !== 'string') return false
  return /^(?:y|yes|\u662f)$/i.test(value.trim())
}

/** Largest suffix of `buffer` that is a proper prefix of `marker` (0..marker.length-1). */
function partialMarkerSuffix(buffer, marker) {
  const max = Math.min(marker.length - 1, buffer.length)
  for (let keep = max; keep > 0; keep -= 1) {
    if (buffer.endsWith(marker.slice(0, keep))) return keep
  }
  return 0
}

/**
 * Input normaliser placed between stdin and readline.
 *
 * It does three jobs that node:readline does not do for us:
 *   1. bracketed paste (`ESC[200~` .. `ESC[201~`) is merged into one line so a
 *      multi-line paste cannot execute several turns; the hook receives
 *      `{ text, lines, chars, truncated }`;
 *   2. in raw-terminal mode a lone ESC is recognised after a short hold and reported
 *      as an interrupt, instead of corrupting the next typed character;
 *   3. in raw-terminal mode Ctrl+C (0x03) is reported as an interrupt and removed, so
 *      it works while readline is paused during a turn.
 *
 * It proxies setRawMode()/isTTY so readline can put the real terminal into raw mode
 * even though its own input is this Transform.
 *
 * @param {{
 *   interactive?: boolean,
 *   onPaste?: (meta: { text: string, lines: number, chars: number, truncated: boolean }) => void,
 *   onInterrupt?: (kind: 'sigint'|'escape') => void,
 *   onActivity?: () => void,
 *   escapeDelay?: number,
 *   maxChars?: number,
 * }} [options]
 * @returns {Transform & { dispose: () => void, isTTY?: boolean, setRawMode?: (mode: boolean) => void }}
 */
export function createPasteGuard(options = {}) {
  const guard = new PasteGuard(options)
  return guard
}

class PasteGuard extends Transform {
  constructor({ interactive = true, onPaste = null, onInterrupt = null, onActivity = null, escapeDelay = ESCAPE_HOLD_MS, maxChars = PASTE_MAX_CHARS } = {}) {
    super()
    this.interactive = interactive !== false
    this.pasteHook = typeof onPaste === 'function' ? onPaste : null
    this.interruptHook = typeof onInterrupt === 'function' ? onInterrupt : null
    this.activityHook = typeof onActivity === 'function' ? onActivity : null
    this.escapeDelay = Number.isFinite(escapeDelay) ? Math.max(10, Math.floor(escapeDelay)) : ESCAPE_HOLD_MS
    this.maxChars = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : PASTE_MAX_CHARS
    this.decoder = new StringDecoder('utf8')
    this.inPaste = false
    this.pasteParts = []
    this.pasteChars = 0
    this.pasteNewlines = 0
    this.pasteTruncated = false
    this.hold = ''
    this.holdTimer = null
    this.disposed = false
    this.isRaw = false
  }

  _transform(chunk, encoding, callback) {
    let text
    try {
      text = this.decoder.write(chunk)
    } catch (error) {
      callback(error)
      return
    }
    try {
      this.consume(text)
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _flush(callback) {
    try {
      this.consume(this.decoder.end())
      this.flushHold()
      callback()
    } catch (error) {
      callback(error)
    }
  }

  dispose() {
    this.disposed = true
    this.clearHoldTimer()
    this.hold = ''
    this.pasteHook = null
    this.interruptHook = null
    this.activityHook = null
  }

  consume(text) {
    if (this.disposed) return
    if (text) this.emitActivity()
    let buffer = this.hold + text
    this.hold = ''
    for (;;) {
      if (this.inPaste) {
        const endIndex = buffer.indexOf(PASTE_END)
        if (endIndex !== -1) {
          this.appendPaste(buffer.slice(0, endIndex))
          buffer = buffer.slice(endIndex + PASTE_END.length)
          this.finishPaste()
          continue
        }
        const keep = partialMarkerSuffix(buffer, PASTE_END)
        this.appendPaste(keep > 0 ? buffer.slice(0, buffer.length - keep) : buffer)
        if (keep > 0) this.holdText(buffer.slice(buffer.length - keep))
        return
      }
      const startIndex = buffer.indexOf(PASTE_START)
      if (startIndex !== -1) {
        this.plain(buffer.slice(0, startIndex))
        buffer = buffer.slice(startIndex + PASTE_START.length)
        this.inPaste = true
        this.pasteParts = []
        this.pasteChars = 0
        this.pasteNewlines = 0
        this.pasteTruncated = false
        continue
      }
      const keep = partialMarkerSuffix(buffer, PASTE_START)
      if (keep > 0) {
        this.plain(buffer.slice(0, buffer.length - keep))
        this.holdText(buffer.slice(buffer.length - keep))
      } else {
        this.plain(buffer)
      }
      return
    }
  }

  plain(text) {
    if (!text) return
    let value = text
    if (this.interactive) {
      if (value.indexOf('\u0003') !== -1) {
        value = value.split('\u0003').join('')
        this.emitInterrupt('sigint')
      }
      if (value === '\u001b') {
        this.emitInterrupt('escape')
        return
      }
    }
    if (!value) return
    this.push(value)
  }

  appendPaste(segment) {
    if (!segment) return
    for (const char of segment) if (char === '\n') this.pasteNewlines += 1
    if (this.pasteTruncated) return
    const remaining = this.maxChars - this.pasteChars
    if (remaining <= 0) {
      this.pasteTruncated = true
      return
    }
    if (segment.length > remaining) {
      this.pasteParts.push(segment.slice(0, remaining))
      this.pasteChars = this.maxChars
      this.pasteTruncated = true
      return
    }
    this.pasteParts.push(segment)
    this.pasteChars += segment.length
  }

  finishPaste() {
    const raw = this.pasteParts.join('')
    const lines = raw === '' ? 0 : this.pasteNewlines + 1
    const truncated = this.pasteTruncated
    this.inPaste = false
    this.pasteParts = []
    this.pasteChars = 0
    this.pasteNewlines = 0
    this.pasteTruncated = false
    const merged = mergePastedText(raw, { maxChars: this.maxChars })
    const meta = {
      text: merged.text,
      lines: lines > 0 ? lines : merged.lines,
      chars: merged.chars,
      truncated: truncated || merged.truncated,
    }
    if (this.pasteHook) {
      try {
        this.pasteHook(meta)
      } catch {}
    }
    if (merged.text) this.push(merged.text)
  }

  holdText(text) {
    this.hold = text
    this.clearHoldTimer()
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
      this.flushHold()
    }, this.escapeDelay)
    if (this.holdTimer && typeof this.holdTimer.unref === 'function') this.holdTimer.unref()
  }

  flushHold() {
    this.clearHoldTimer()
    const held = this.hold
    this.hold = ''
    if (!held) return
    if (this.inPaste) this.appendPaste(held)
    else this.plain(held)
  }

  clearHoldTimer() {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
  }

  emitActivity() {
    if (!this.activityHook) return
    try {
      this.activityHook()
    } catch {}
  }

  emitInterrupt(kind) {
    if (!this.interruptHook) return
    try {
      this.interruptHook(kind)
    } catch {}
  }
}

/**
 * Run the Advisers 0.4.0 interactive shell.
 *
 * The caller owns the process: this function does not call process.exit(), does not
 * touch the TOS gate/store/model and does not write to console.*; it only reads/writes
 * the streams it was given. See the module header for the handler contract.
 *
 * @param {{
 *   argv?: string[],
 *   env?: Record<string, unknown>,
 *   stdin?: NodeJS.ReadableStream,
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream,
 *   store?: unknown,
 *   allowPaths?: string[],
 *   handlers?: Record<string, Function>,
 *   onState?: (transition: { from: string, to: string, reason: string }) => void,
 * }} [options]
 * @returns {Promise<Readonly<{ entered: boolean, exitCode: number, reason: string, turns: number }>>}
 */
export async function runShell(options = {}) {
  const opt = options && typeof options === 'object' ? options : {}
  const argv = Array.isArray(opt.argv) ? opt.argv : []
  const env = opt.env && typeof opt.env === 'object' ? opt.env : {}
  const stdin = opt.stdin
  const stdout = opt.stdout
  const stderr = opt.stderr
  const store = opt.store === undefined ? null : opt.store
  const allowPaths = Array.isArray(opt.allowPaths) ? [...opt.allowPaths] : []
  const handlers = opt.handlers && typeof opt.handlers === 'object' ? opt.handlers : {}
  const onStateHook = typeof opt.onState === 'function' ? opt.onState : null

  const stdinIsTTY = Boolean(stdin?.isTTY)
  const stdoutIsTTY = Boolean(stdout?.isTTY)
  const stderrIsTTY = Boolean(stderr?.isTTY)
  const entry = shouldEnterShell({ argv, env, stdinIsTTY, stdoutIsTTY, stderrIsTTY })
  if (!entry.enter) return Object.freeze({ entered: false, exitCode: entry.exitCode, reason: entry.reason, turns: 0 })

  let policy
  try {
    policy = resolveOutputPolicy({ argv, env, stdinIsTTY, stdoutIsTTY, stderrIsTTY })
  } catch {
    return Object.freeze({ entered: false, exitCode: 1, reason: 'invalid-options', turns: 0 })
  }
  if (!stdin || typeof stdin.on !== 'function' || typeof stdin.pipe !== 'function' || !stdout || typeof stdout.write !== 'function' || !stderr || typeof stderr.write !== 'function') {
    return Object.freeze({ entered: false, exitCode: 1, reason: 'invalid-streams', turns: 0 })
  }

  // Raw terminal (readline terminal:true) only when the policy keeps cursor control
  // and the input is a terminal. --plain/--accessible/non-TTY stdout => canonical
  // (terminal:false), which is the documented 0-ESC mode.
  const terminal = stdinIsTTY && !policy.plain && !envFlag(env, 'ADVISERS_SHELL_CANONICAL')
  // Where prompts, the status line and confirmation blocks go: stdout when it is a
  // terminal, otherwise stderr (docs/TUI.md section 6: stdout stays pipe-clean).
  const promptStream = stdoutIsTTY ? stdout : stderr
  const uiStream = promptStream
  const lineEnding = terminal ? '\r\n' : '\n'

  let rl = null
  let closed = false
  let state = SHELL_STATES.IDLE
  let exitReason = 'quit'
  let exitCode = 0
  let turns = 0
  let lastFailure = null
  let verbose = envFlag(env, 'ADVISERS_PROGRESS') || envFlag(env, 'ADVISERS_DEBUG')
  let pendingFiles = []
  let lastTurn = null
  let pendingQuestion = null
  let pendingPaste = null
  let pendingConfirm = null
  let lastSigintAt = 0
  let activeAbort = null
  const lineQueue = []
  let lineWaiter = null

  /** Re-read the width on every render (SIGWINCH safe, tests use the env override). */
  function widthNow() {
    return resolveShellWidth(stdout, env, argv)
  }

  function renderOptions(extra = {}) {
    return {
      width: widthNow(),
      color: policy.color,
      accessible: policy.accessible,
      ...extra,
    }
  }

  function writeLines(lines, stream = stdout) {
    if (!stream || typeof stream.write !== 'function') return
    const list = Array.isArray(lines) ? lines : [lines]
    let payload = ''
    for (const line of list) payload += sanitizeRenderedLine(line, { color: policy.color }) + lineEnding
    if (payload) stream.write(payload)
  }

  function setState(next, reason = '') {
    if (state === next) return
    const from = state
    state = next
    if (onStateHook) {
      try {
        onStateHook({ from, to: next, reason })
      } catch {}
    }
  }

  function errorMessage(error) {
    const raw = error && typeof error.message === 'string' && error.message !== '' ? error.message : String(error === undefined || error === null ? '未知错误' : error)
    return sanitizeShellLine(raw).slice(0, 400)
  }

  function errorCode(error) {
    return error && typeof error.code === 'string' ? error.code : undefined
  }

  function isCancellation(error) {
    if (!error) return false
    const code = typeof error.code === 'string' ? error.code : ''
    return code === 'CANCELLED_BY_USER' || code === 'ABORT_ERR' || error.name === 'AbortError' || error.name === 'CanceledError'
  }

  function isBlockish(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const keys = ['headline', 'summary', 'lines', 'artifacts', 'checks', 'warnings', 'next', 'prompt', 'tools', 'durationMs', 'title', 'reason', 'kept', 'code']
    return keys.some((key) => value[key] !== undefined)
  }

  function resultBlock(value) {
    const block = {}
    if (value.headline !== undefined) block.headline = value.headline
    if (value.summary !== undefined) block.summary = value.summary
    else if (value.reply !== undefined) block.summary = value.reply
    if (value.lines !== undefined) block.lines = value.lines
    if (value.artifacts !== undefined) block.artifacts = value.artifacts
    if (value.checks !== undefined) block.checks = value.checks
    if (value.warnings !== undefined) block.warnings = value.warnings
    if (value.next !== undefined) block.next = value.next
    if (value.tools !== undefined) block.tools = value.tools
    if (value.durationMs !== undefined) block.durationMs = value.durationMs
    return block
  }

  function normalizeErrorBlock(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return {
        title: value.title ?? value.headline ?? value.what,
        reason: value.reason ?? value.message,
        kept: value.kept,
        next: value.next,
        code: value.code,
      }
    }
    return { title: '操作失败', reason: String(value === undefined || value === null ? '未知错误' : value) }
  }

  function renderFailure(label, error) {
    writeLines(renderError({
      title: label,
      reason: errorMessage(error),
      next: '/retry 重试，或 /help 查看命令',
      code: errorCode(error),
    }, renderOptions()), stdout)
  }

  function renderInterrupted() {
    writeLines(renderResult({
      kind: 'notice',
      headline: '已中断本轮',
      summary: '结果没有保存；需要时用 /retry 重试。',
      next: '/retry',
    }, renderOptions()), stdout)
  }

  function renderSessions(sessions) {
    const lines = []
    for (let index = 0; index < sessions.length; index += 1) {
      const session = sessions[index] && typeof sessions[index] === 'object' ? sessions[index] : {}
      const number = session.n === undefined ? index + 1 : session.n
      const title = session.title === undefined || session.title === null ? '(untitled)' : session.title
      const id = session.id === undefined || session.id === null ? (session.conversationId ?? '') : session.id
      lines.push({ role: 'item', text: String(number) + '. ' + String(title) + '  [' + String(id) + ']' })
    }
    writeLines(renderResult({
      headline: '最近会话',
      lines: lines.length > 0 ? lines : [{ role: 'fact', text: '（没有历史会话）' }],
      next: '/resume <n|id> 恢复',
    }, renderOptions({ maxItems: 100 })), stdout)
  }

  function renderHandlerOutcome(label, outcome) {
    if (outcome.missing) {
      writeLines(renderError({
        title: '/' + label + ' 未接线',
        reason: '当前构建没有接线这个只读视图。',
        next: '在 CLI 里用 advisers ' + label,
      }, renderOptions()), stdout)
      return
    }
    if (!outcome.ok) {
      renderFailure('/' + label + ' 失败', outcome.error)
      return
    }
    const value = outcome.value
    if (value === undefined || value === null) {
      writeLines(renderResult({ kind: 'notice', headline: '完成' }, renderOptions()), stdout)
      return
    }
    if (Array.isArray(value)) {
      writeLines(renderResult({ lines: value }, renderOptions({ maxItems: 60 })), stdout)
      return
    }
    if (typeof value === 'string') {
      writeLines(renderResult({ summary: value }, renderOptions()), stdout)
      return
    }
    if (value.error !== undefined && value.error !== null) {
      writeLines(renderError(normalizeErrorBlock(value.error), renderOptions()), stdout)
      return
    }
    if (value.kind === 'error') {
      writeLines(renderError(normalizeErrorBlock(value), renderOptions()), stdout)
      return
    }
    if (value.kind === 'confirm') {
      writeLines(renderConfirm(value, renderOptions()), stdout)
      return
    }
    if (Array.isArray(value.sessions)) {
      renderSessions(value.sessions)
      return
    }
    if (isBlockish(value)) {
      writeLines(renderResult(resultBlock(value), renderOptions({ maxItems: 60 })), stdout)
      return
    }
    writeLines(renderResult({ kind: 'notice', headline: '完成' }, renderOptions()), stdout)
  }

  function renderTurnOutcome(value) {
    if (value === undefined || value === null) return
    if (typeof value === 'string') {
      writeLines(renderResult({ summary: value }, renderOptions()), stdout)
      return
    }
    if (Array.isArray(value)) {
      writeLines(renderResult({ lines: value }, renderOptions({ maxItems: 40 })), stdout)
      return
    }
    if (value.interrupted === true) {
      renderInterrupted()
      return
    }
    if (value.error !== undefined && value.error !== null) {
      writeLines(renderError(normalizeErrorBlock(value.error), renderOptions()), stdout)
      return
    }
    if (value.kind === 'error') {
      writeLines(renderError(normalizeErrorBlock(value), renderOptions()), stdout)
      return
    }
    if (value.kind === 'confirm') {
      writeLines(renderConfirm(value, renderOptions()), stdout)
      return
    }
    if (value.kind === 'notice') {
      writeLines(renderResult(value, renderOptions()), stdout)
      return
    }
    const block = resultBlock(value)
    writeLines(renderResult(block, renderOptions(verbose ? { verbose: true } : {})), stdout)
    if (verbose && Array.isArray(value.internal)) {
      writeLines(value.internal.map((line) => '  \u00b7 ' + sanitizeShellLine(line)), stdout)
    }
    if (typeof value.question === 'string' && value.question.trim() !== '') {
      pendingQuestion = value.question.trim()
      writeLines(renderResult({
        kind: 'notice',
        headline: '需要补充',
        summary: pendingQuestion,
        next: '直接回答；/retry 重试上一轮',
      }, renderOptions()), stdout)
    }
  }

  async function callHandler(name, payload = {}) {
    const fn = handlers[name]
    if (typeof fn !== 'function') return { ok: false, missing: true }
    try {
      return { ok: true, value: await fn(payload, ctx) }
    } catch (error) {
      return { ok: false, error }
    }
  }

  const ctx = Object.freeze({
    env,
    store,
    allowPaths: Object.freeze([...allowPaths]),
    stdout,
    stderr,
    ui: uiStream,
    width: () => widthNow(),
    policy,
    terminal,
  })

  async function renderIdleStatus() {
    let data = {}
    if (!lastFailure) {
      const outcome = await callHandler('status')
      if (outcome.ok && outcome.value && typeof outcome.value === 'object' && !Array.isArray(outcome.value)) data = outcome.value
    }
    const status = { ...data }
    if (lastFailure) {
      status.kind = 'error'
      status.reason = lastFailure
    } else if (status.kind === undefined) {
      status.kind = 'idle'
    }
    writeLines([renderStatus(status, renderOptions())], uiStream)
  }

  function createConfirm() {
    return async (request = {}) => {
      const value = request && typeof request === 'object' ? request : {}
      writeLines(renderConfirm({
        title: value.title === undefined ? (value.what === undefined ? (value.path ? '覆盖写入' : '继续操作') : value.what) : value.title,
        reason: value.reason,
        write: value.write === undefined ? value.path : value.write,
        summary: value.summary,
        digest: value.digest,
        prompt: value.prompt,
      }, renderOptions()), uiStream)
      setState(SHELL_STATES.CONFIRM, 'confirm')
      try { rl.resume() } catch {}
      try { rl.prompt() } catch {}
      const answer = await new Promise((resolve) => {
        pendingConfirm = (line) => {
          pendingConfirm = null
          resolve(line)
        }
      })
      setState(SHELL_STATES.WORKING, 'confirm-answered')
      try { rl.pause() } catch {}
      return answer !== CANCEL && answer !== EOF && isAffirmativeAnswer(answer)
    }
  }

  async function runTurn(text, turnOptions = {}) {
    const attachments = turnOptions.attachments === undefined ? pendingFiles : turnOptions.attachments
    const answerTo = turnOptions.answerTo === undefined ? null : turnOptions.answerTo
    const fn = handlers.turn
    if (typeof fn !== 'function') {
      writeLines(renderError({
        title: '对话未接线',
        reason: '当前构建没有提供 turn handler。',
        next: '使用 advisers --help 查看 CLI 命令',
      }, renderOptions()), stdout)
      return false
    }
    const files = Array.isArray(attachments) ? [...attachments] : []
    const controller = new AbortController()
    const payload = {
      text: String(text === undefined || text === null ? '' : text),
      attachments: files,
      allowPaths: [...allowPaths],
      signal: controller.signal,
      confirm: createConfirm(),
      answerTo,
      store,
    }
    if (answerTo === null) lastTurn = { text: payload.text, attachments: files }
    activeAbort = controller
    turns += 1
    setState(SHELL_STATES.WORKING, 'turn')
    writeLines([renderStatus({ kind: 'busy' }, renderOptions())], uiStream)
    try { rl.pause() } catch {}
    let outcome
    try {
      outcome = { ok: true, value: await fn(payload, ctx) }
    } catch (error) {
      outcome = { ok: false, error }
    } finally {
      activeAbort = null
    }
    const cancelled = controller.signal.aborted
      || (outcome.ok === false && isCancellation(outcome.error))
      || (outcome.ok === true && outcome.value !== null && typeof outcome.value === 'object' && outcome.value.interrupted === true)
    let success = false
    if (cancelled) {
      lastFailure = null
      renderInterrupted()
    } else if (!outcome.ok) {
      lastFailure = errorMessage(outcome.error)
      writeLines(renderError({
        title: '任务失败',
        reason: lastFailure,
        kept: '任务和会话；没有丢文件',
        next: '/retry 重试',
        code: errorCode(outcome.error),
      }, renderOptions()), stdout)
    } else {
      lastFailure = null
      success = true
      renderTurnOutcome(outcome.value)
    }
    setState(SHELL_STATES.IDLE, 'turn-done')
    await renderIdleStatus()
    return success
  }

  async function commandStatus() {
    const outcome = await callHandler('status')
    if (outcome.missing) {
      renderHandlerOutcome('status', outcome)
      return
    }
    if (!outcome.ok) {
      renderFailure('/status 失败', outcome.error)
      return
    }
    const value = outcome.value
    if (value === undefined || value === null) {
      writeLines([renderStatus({ kind: 'idle' }, renderOptions())], stdout)
      return
    }
    if (isBlockish(value)) {
      renderHandlerOutcome('status', outcome)
      return
    }
    const status = { ...value }
    if (status.kind === undefined) status.kind = 'idle'
    writeLines([renderStatus(status, renderOptions())], stdout)
  }

  async function commandReadOnly(name, payload) {
    const outcome = await callHandler(name, payload)
    renderHandlerOutcome(name, outcome)
  }

  async function commandResume(arg) {
    if (!arg) {
      writeLines(renderError({ title: '用法', reason: '/resume <编号|会话 id>', next: '/history 查看编号' }, renderOptions()), stdout)
      return
    }
    const outcome = await callHandler('resume', { arg, args: [arg] })
    renderHandlerOutcome('resume', outcome)
    const failed = !outcome.ok || (outcome.value && typeof outcome.value === 'object' && (outcome.value.error || outcome.value.kind === 'error'))
    if (!failed) pendingFiles = []
  }

  async function commandNew() {
    const outcome = await callHandler('newSession')
    if (outcome.missing) {
      writeLines(renderResult({
        kind: 'notice',
        headline: '新会话',
        summary: '当前构建没有接线 newSession；下一条消息仍写在当前会话。',
        next: 'advisers --help 查看 CLI 的会话命令',
      }, renderOptions()), stdout)
      return
    }
    renderHandlerOutcome('new', outcome)
    if (outcome.ok) {
      pendingFiles = []
      pendingQuestion = null
    }
  }

  function commandAttach(arg) {
    const path = typeof arg === 'string' ? arg.trim() : ''
    if (!path) {
      writeLines(renderError({ title: '用法', reason: '/file <path>', next: '把文件放到工作区后重试' }, renderOptions()), stdout)
      return
    }
    pendingFiles.push(path)
    writeLines(renderResult({
      kind: 'notice',
      headline: '已附加',
      summary: path,
      next: String(pendingFiles.length) + ' 个待发送附件；/files 查看，/clear 清空',
    }, renderOptions()), stdout)
  }

  function commandFiles() {
    if (pendingFiles.length === 0) {
      writeLines(renderResult({ kind: 'notice', headline: '没有待发送附件' }, renderOptions()), stdout)
      return
    }
    writeLines(renderResult({
      headline: '待发送附件',
      lines: pendingFiles.map((path) => ({ role: 'item', text: path })),
      next: '/clear 清空',
    }, renderOptions({ maxItems: 40 })), stdout)
  }

  async function commandRetry() {
    if (!lastTurn) {
      writeLines(renderResult({ kind: 'notice', headline: '没有可重试的上一轮' }, renderOptions()), stdout)
      return
    }
    await runTurn(lastTurn.text, { attachments: lastTurn.attachments })
  }

  async function commandLegacy(command) {
    const outcome = await callHandler('legacyCommand', { line: command.line, name: command.name, args: command.args, arg: command.arg })
    const unhandled = outcome.missing || (outcome.ok && (outcome.value === undefined || outcome.value === null || outcome.value === false))
    if (unhandled) {
      writeLines(renderError({
        title: '未知命令：' + command.name,
        reason: '壳里没有这个命令。',
        next: '/help 核心命令；/more 旧命令；以空格或 // 开头可发送以 / 开头的文本',
      }, renderOptions()), stdout)
      return
    }
    renderHandlerOutcome(command.name.replace(/^\//, ''), outcome)
  }

  async function dispatchCommand(command) {
    switch (command.name) {
      case '/help':
        writeLines(renderResult(shellHelpBlock(), renderOptions({ maxItems: 20 })), stdout)
        return
      case '/more':
        writeLines(renderResult(shellMoreBlock(), renderOptions({ maxItems: 100 })), stdout)
        return
      case '/status':
        await commandStatus()
        return
      case '/verbose':
        verbose = !verbose
        writeLines(renderResult({
          kind: 'notice',
          headline: verbose ? '明细已开启' : '明细已关闭',
          summary: verbose ? '工具/耗时/内部行会显示在结果块里。' : undefined,
        }, renderOptions()), stdout)
        return
      case '/history':
        await commandReadOnly('history', { args: command.args, arg: command.arg })
        return
      case '/resume':
        await commandResume(command.arg)
        return
      case '/new':
        await commandNew()
        return
      case '/file':
        commandAttach(command.arg)
        return
      case '/files':
        commandFiles()
        return
      case '/clear':
        pendingFiles = []
        writeLines(renderResult({ kind: 'notice', headline: '附件已清空' }, renderOptions()), stdout)
        return
      case '/retry':
        await commandRetry()
        return
      case '/today':
      case '/remind':
      case '/who':
      case '/client':
      case '/evidence':
        await commandReadOnly(command.name.slice(1), { args: command.args, arg: command.arg })
        return
      default:
        await commandLegacy(command)
    }
  }

  async function processLine(rawLine) {
    const parsed = parseShellLine(rawLine)
    if (parsed.kind === 'empty') return
    try { rl.pause() } catch {}
    setState(SHELL_STATES.IDLE, 'line')
    try {
      if (parsed.kind === 'command') {
        if (parsed.name === '/quit' || parsed.name === '/exit') {
          requestExit('quit', 0)
          return
        }
        await dispatchCommand(parsed)
        return
      }
      let text = parsed.text
      let answerTo = null
      if (pendingQuestion !== null) {
        answerTo = pendingQuestion
        pendingQuestion = null
        if (typeof handlers.answer === 'function') {
          const outcome = await callHandler('answer', { question: answerTo, answer: parsed.text, text: lastTurn ? lastTurn.text : '' })
          renderHandlerOutcome('answer', outcome)
          return
        }
        text = (lastTurn && lastTurn.text ? lastTurn.text + '\n' : '') + '补充：' + parsed.text
      }
      const ok = await runTurn(text, { answerTo })
      if (ok && answerTo === null) pendingFiles = []
    } catch (error) {
      writeLines(renderError({
        title: '壳命令失败',
        reason: errorMessage(error),
        next: '/help 或 /quit',
        code: errorCode(error),
      }, renderOptions()), stderr)
    }
  }

  function nextLine() {
    if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift())
    if (closed) return Promise.resolve(EOF)
    return new Promise((resolve) => {
      lineWaiter = resolve
    })
  }

  function routeLine(line) {
    if (pendingConfirm) {
      const resolve = pendingConfirm
      pendingConfirm = null
      resolve(line)
      return
    }
    if (lineWaiter) {
      const resolve = lineWaiter
      lineWaiter = null
      resolve(line)
      return
    }
    lineQueue.push(line)
  }

  function handleInterrupt(kind) {
    if (state === SHELL_STATES.CONFIRM) {
      if (pendingConfirm) {
        const resolve = pendingConfirm
        pendingConfirm = null
        resolve(CANCEL)
      }
      return
    }
    if (state === SHELL_STATES.WORKING || state === SHELL_STATES.QUEUED) {
      if (activeAbort && !activeAbort.signal.aborted) {
        try { activeAbort.abort() } catch {}
      }
      return
    }
    if (kind !== 'sigint') return
    const now = Date.now()
    if (now - lastSigintAt <= SIGINT_WINDOW_MS) {
      requestExit('sigint', 0)
      return
    }
    lastSigintAt = now
    showIdleSigintHint()
  }

  function showIdleSigintHint() {
    if (closed) return
    try {
      rl.line = ''
      rl.cursor = 0
    } catch {}
    const hint = sanitizeShellLine('（再按一次 Ctrl+C 退出；或输入 /quit）')
    try {
      if (terminal) promptStream.write('\r\n' + hint + '\r\n')
      else promptStream.write('\n' + hint + '\n')
    } catch {}
    try { rl.prompt() } catch {}
  }

  function requestExit(reason, code = 0) {
    if (closed) return
    exitReason = reason
    exitCode = code
    closed = true
    if (lineWaiter) {
      const resolve = lineWaiter
      lineWaiter = null
      resolve(EOF)
    }
    if (pendingConfirm) {
      const resolve = pendingConfirm
      pendingConfirm = null
      resolve(CANCEL)
    }
    try { rl.close() } catch {}
  }

  function cleanup() {
    pendingConfirm = null
    lineWaiter = null
    try { if (activeAbort && !activeAbort.signal.aborted) activeAbort.abort() } catch {}
    try { if (rl && !rl.closed) rl.close() } catch {}
    try { if (typeof stdin.unpipe === 'function') stdin.unpipe(guard) } catch {}
    try { guard.dispose() } catch {}
    try { process.off('SIGINT', onProcessSigint) } catch {}
  }

  const guard = createPasteGuard({
    interactive: terminal,
    onPaste: (meta) => { pendingPaste = meta },
    onInterrupt: (kind) => handleInterrupt(kind),
    onActivity: () => {
      if (state === SHELL_STATES.WORKING || state === SHELL_STATES.QUEUED) setState(SHELL_STATES.QUEUED, 'input-buffered')
    },
  })
  guard.isTTY = stdinIsTTY
  guard.isRaw = false
  guard.setRawMode = (mode) => {
    guard.isRaw = Boolean(mode)
    try { if (typeof stdin.setRawMode === 'function') stdin.setRawMode(mode) } catch {}
  }
  stdin.pipe(guard)

  rl = readline.createInterface({
    input: guard,
    output: promptStream,
    terminal,
    historySize: 200,
    removeHistoryDuplicates: true,
    completer: createCommandCompleter(),
  })
  rl.setPrompt(SHELL_PROMPT)
  rl.on('line', routeLine)
  rl.on('close', () => {
    if (!closed) {
      exitReason = 'eof'
      exitCode = 0
    }
    closed = true
    if (pendingConfirm) {
      const resolve = pendingConfirm
      pendingConfirm = null
      resolve(EOF)
    }
    if (lineWaiter) {
      const resolve = lineWaiter
      lineWaiter = null
      resolve(EOF)
    }
    if (activeAbort && !activeAbort.signal.aborted) {
      try { activeAbort.abort() } catch {}
    }
  })

  const onProcessSigint = () => handleInterrupt('sigint')
  const ownsProcessStdin = stdin === process.stdin
  if (ownsProcessStdin) process.on('SIGINT', onProcessSigint)

  try {
    if (!stdoutIsTTY) writeLines(['advisers: 输出不是终端，提示与状态改到 stderr；结果在 stdout'], stderr)
    await renderIdleStatus()
    if (!envFlag(env, 'ADVISERS_SHELL_NO_OPENING')) {
      const opening = await callHandler('opening')
      if (opening.ok && opening.value !== undefined && opening.value !== null && opening.value !== false) {
        renderHandlerOutcome('opening', opening)
      }
    }
    try { rl.prompt() } catch {}
    while (!closed) {
      const line = await nextLine()
      if (line === EOF || line === CANCEL) break
      if (closed) break
      const paste = pendingPaste
      pendingPaste = null
      if (paste && (paste.lines > 1 || paste.truncated)) {
        const notice = paste.truncated
          ? '已合并 ' + String(paste.lines) + ' 行粘贴为一条输入（超过 ' + String(PASTE_MAX_CHARS) + ' 字，已截断）'
          : '已合并 ' + String(paste.lines) + ' 行粘贴为一条输入'
        writeLines(renderResult({ kind: 'notice', headline: notice }, renderOptions()), stdout)
      }
      await processLine(line)
      if (closed) break
      setState(SHELL_STATES.IDLE, 'prompt')
      try { rl.resume() } catch {}
      try { rl.prompt() } catch {}
    }
  } catch (error) {
    writeLines(renderError({
      title: '交互壳异常',
      reason: errorMessage(error),
      next: 'advisers --help',
      code: errorCode(error),
    }, renderOptions()), stderr)
    exitReason = 'error'
    exitCode = 1
  } finally {
    cleanup()
  }

  return Object.freeze({ entered: true, exitCode, reason: exitReason, turns })
}
