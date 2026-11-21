/**
 * 0.4.0 interactive shell (lib/shell.js) tests.
 *
 * Two layers:
 *   - fake IO: PassThrough streams with isTTY/columns/setRawMode, so the readline
 *     state machine, the plain/pipe split, sanitisation, width handling and the paste
 *     guard are deterministic in CI;
 *   - a real PTY (Linux, util-linux `script -qec`): Ctrl+C / Esc / paste / readline
 *     history / prompt routing need a terminal line discipline, so a tiny harness runs
 *     lib/shell.js unchanged under a PTY.
 *
 * Every case uses a mktemp home (ADVISERS_HOME) and never touches the real ~/.advisers.
 * The module is library-only in 0.4.0 (bin wiring is a separate integration), so the
 * tests inject JSON-ready handlers instead of a store or a model.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test, { after, before } from 'node:test'

import {
  ALLOWED_SGR_CODES,
  hasUnsafeDisplayChars,
  renderResult,
  strWidth,
} from '../lib/tui/index.js'
import {
  PASTE_MAX_CHARS,
  SHELL_CORE_COMMANDS,
  SHELL_STATES,
  createCommandCompleter,
  isAffirmativeAnswer,
  mergePastedText,
  parseShellLine,
  resolveShellWidth,
  runShell,
  sanitizeRenderedLine,
  sanitizeShellLine,
  shellHelpBlock,
  shellMoreBlock,
  shouldEnterShell,
} from '../lib/shell.js'

const ESC = String.fromCharCode(27)
const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const BEL = String.fromCharCode(7)
const CTRL_C = String.fromCharCode(3)
const CTRL_D = String.fromCharCode(4)
const BIDI_RLO = String.fromCharCode(0x202e)
const PASTE_OPEN = ESC + '[200~'
const PASTE_CLOSE = ESC + '[201~'
const PROMPT = String.fromCharCode(0x203a) + ' '
const SHELL_URL = new URL('../lib/shell.js', import.meta.url).href

/** Bytes that must never reach a human line (ESC, C0 except LF/CR, C1). */
function hasControlByte(text) {
  for (const character of String(text)) {
    const code = character.codePointAt(0)
    if ((code < 32 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) return true
  }
  return false
}

/** Bidi overrides/isolates and U+FEFF. */
function hasBidiControl(text) {
  for (const character of String(text)) {
    const code = character.codePointAt(0)
    if (code === 0x061c || code === 0x200e || code === 0x200f) return true
    if (code >= 0x202a && code <= 0x202e) return true
    if (code >= 0x2066 && code <= 0x2069) return true
    if (code === 0xfeff) return true
  }
  return false
}

/** Every SGR code present in the text (for the 16-colour whitelist audit). */
function sgrCodes(text) {
  const found = []
  let index = 0
  while (index < text.length) {
    const at = text.indexOf(ESC + '[', index)
    if (at === -1) break
    let cursor = at + 2
    let digits = ''
    while (cursor < text.length) {
      const character = text[cursor]
      if (!(character >= '0' && character <= '9') && character !== ';') break
      digits += character
      cursor += 1
    }
    if (digits !== '' && text[cursor] === 'm') {
      found.push(digits)
      index = cursor + 1
    } else {
      index = at + 2
    }
  }
  return found
}

/** Remove every SGR sequence (used to prove no other escape family is present). */
function stripSgr(text) {
  let out = ''
  let index = 0
  while (index < text.length) {
    const at = text.indexOf(ESC + '[', index)
    if (at === -1) {
      out += text.slice(index)
      break
    }
    let cursor = at + 2
    let digits = ''
    while (cursor < text.length) {
      const character = text[cursor]
      if (!(character >= '0' && character <= '9') && character !== ';') break
      digits += character
      cursor += 1
    }
    if (digits !== '' && text[cursor] === 'm') {
      out += text.slice(index, at)
      index = cursor + 1
    } else {
      out += text.slice(index, at + 2)
      index = at + 2
    }
  }
  return out
}

function splitLines(text) {
  return String(text).split(LF).map((line) => (line.endsWith(CR) ? line.slice(0, -1) : line))
}

function workspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-shell-' + prefix + '-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home }
}

// The safety rule for every Advisers test: point ADVISERS_HOME at a mktemp directory
// for this file's lifetime, so a regression that reaches for a store can never touch
// the developer's real ~/.advisers.
let TEST_AREA = null
before(() => {
  TEST_AREA = workspace('env')
  process.env.ADVISERS_HOME = TEST_AREA.home
})
after(() => {
  if (TEST_AREA) rmSync(TEST_AREA.root, { recursive: true, force: true })
})

function fakeIO(options = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  stdin.isTTY = options.stdinTTY !== false
  stdout.isTTY = options.stdoutTTY !== false
  stderr.isTTY = options.stderrTTY === true
  stdout.columns = Number.isInteger(options.columns) ? options.columns : 100
  stdin.setRawMode = () => {}
  const out = []
  const err = []
  stdout.on('data', (chunk) => out.push(chunk.toString()))
  stderr.on('data', (chunk) => err.push(chunk.toString()))
  return {
    stdin,
    stdout,
    stderr,
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
    allText: () => out.join('') + err.join(''),
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function until(predicate, label, timeoutMs = 4000) {
  const started = Date.now()
  while (true) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + label)
    await sleep(5)
  }
}

async function waitForPrompt(io) {
  await until(() => (io.stdoutText() + io.stderrText()).includes(PROMPT), 'shell prompt')
}

function feed(io, line, terminator) {
  io.stdin.write(line + (terminator === undefined ? LF : terminator))
}

test('shouldEnterShell: non-TTY stdin never enters, --json is a usage error, TTY enters', () => {
  assert.deepEqual({ ...shouldEnterShell({ stdinIsTTY: false, stdoutIsTTY: true }) }, { enter: false, reason: 'stdin-not-tty', exitCode: 0 })
  assert.deepEqual({ ...shouldEnterShell({ stdinIsTTY: true, stdoutIsTTY: false }) }, { enter: true, reason: 'interactive', exitCode: 0 })
  assert.deepEqual({ ...shouldEnterShell({ argv: ['--json'], stdinIsTTY: true, stdoutIsTTY: true }) }, { enter: false, reason: 'json-unsupported', exitCode: 1 })
  assert.deepEqual({ ...shouldEnterShell({ env: { ADVISERS_NO_SHELL: '1' }, stdinIsTTY: true, stdoutIsTTY: true }) }, { enter: false, reason: 'disabled', exitCode: 0 })
  assert.equal(shouldEnterShell({ env: { ADVISERS_NO_SHELL: '0' }, stdinIsTTY: true }).enter, true)
})

test('parseShellLine: commands, text, whitespace escapes and argument capture', () => {
  assert.equal(parseShellLine('').kind, 'empty')
  assert.equal(parseShellLine('   ').kind, 'empty')
  const text = parseShellLine('帮我把报价改成 85 折')
  assert.equal(text.kind, 'text')
  assert.equal(text.text, '帮我把报价改成 85 折')
  const help = parseShellLine('/help')
  assert.equal(help.kind, 'command')
  assert.equal(help.name, '/help')
  assert.deepEqual(help.args, [])
  const resume = parseShellLine('/resume 2')
  assert.equal(resume.name, '/resume')
  assert.deepEqual(resume.args, ['2'])
  assert.equal(resume.arg, '2')
  const file = parseShellLine('/file /tmp/报价 最终版.docx')
  assert.equal(file.name, '/file')
  assert.equal(file.arg, '/tmp/报价 最终版.docx')
  assert.deepEqual(file.args, ['/tmp/报价', '最终版.docx'])
  assert.equal(parseShellLine('/HELP').name, '/help')
  assert.equal(parseShellLine('/evidence ev_1').arg, 'ev_1')
  const escaped = parseShellLine('//这是一个句首斜杠的句子')
  assert.equal(escaped.kind, 'text')
  assert.equal(escaped.text, '/这是一个句首斜杠的句子')
  const spaced = parseShellLine(' /这不是命令')
  assert.equal(spaced.kind, 'text')
  assert.equal(spaced.text, '/这不是命令')
  assert.equal(parseShellLine('  普通文本').text, '普通文本')
})

test('mergePastedText: multi-line paste folds to one safe line and caps at 4000 chars', () => {
  const merged = mergePastedText('第一行' + LF + '第二行' + CR + LF + '第三行')
  assert.equal(merged.text, '第一行 第二行 第三行')
  assert.equal(merged.lines, 3)
  assert.equal(merged.truncated, false)
  const evil = ESC + '[2J' + ESC + ']0;pwned' + BEL + BIDI_RLO + '报价' + ESC + '[31m'
  const safe = mergePastedText(evil)
  assert.equal(safe.text.includes('报价'), true, 'normal CJK must be preserved')
  assert.equal(safe.text.includes(ESC), false, 'paste stripped ESC')
  assert.equal(safe.text.includes(BEL), false, 'paste stripped BEL')
  assert.equal(hasBidiControl(safe.text), false, 'paste stripped bidi')
  const huge = mergePastedText('a'.repeat(PASTE_MAX_CHARS + 500))
  assert.equal(huge.truncated, true)
  assert.ok(huge.text.length <= PASTE_MAX_CHARS + 1)
  assert.deepEqual(mergePastedText(''), { text: '', lines: 0, chars: 0, truncated: false })
})

test('resolveShellWidth: --width then env then columns, always clamped to 40..200', () => {
  assert.equal(resolveShellWidth(120, {}, []), 120)
  assert.equal(resolveShellWidth({ columns: 100 }, {}, []), 100)
  assert.equal(resolveShellWidth({ columns: 100 }, { ADVISERS_SHELL_WIDTH: '40' }, []), 40)
  assert.equal(resolveShellWidth({ columns: 100 }, {}, ['--width', '60']), 60)
  assert.equal(resolveShellWidth({ columns: 100 }, {}, ['--width=200']), 200)
  assert.equal(resolveShellWidth({ columns: 90 }, {}, ['--width', 'nope']), 90)
  assert.equal(resolveShellWidth({ columns: 10 }, {}, []), 40)
  assert.equal(resolveShellWidth({ columns: 500 }, {}, []), 200)
  assert.equal(resolveShellWidth(undefined, {}, []), 80)
})

test('createCommandCompleter: slash-only static completion', () => {
  const complete = createCommandCompleter()
  assert.deepEqual(complete('/he'), [['/help'], '/he'])
  assert.deepEqual(complete('hello'), [[], 'hello'])
  assert.deepEqual(complete('/resume 2'), [[], '/resume 2'])
  const all = complete('/zzz')[0]
  assert.equal(all.length, SHELL_CORE_COMMANDS.length)
  assert.equal(complete('/')[0].includes('/quit'), true)
})

test('sanitizeShellLine / sanitizeRenderedLine: every human line is injection-safe', () => {
  const evil = '报' + ESC + '[2J' + '价' + ESC + ']0;pwned' + BEL + BIDI_RLO + LF + '第二行'
  const safe = sanitizeShellLine(evil)
  assert.equal(safe.includes('报价'), true)
  assert.equal(safe.includes(ESC), false)
  assert.equal(safe.includes(BEL), false)
  assert.equal(hasBidiControl(safe), false)
  assert.equal(safe.includes(LF), false, 'one physical line only')
  assert.equal(hasUnsafeDisplayChars(safe), false)
  const dimmed = ESC + '[2m' + '暗色' + ESC + '[22m'
  assert.equal(sanitizeRenderedLine(dimmed, { color: false }), '暗色')
  assert.equal(sanitizeRenderedLine(dimmed, { color: true }), dimmed)
  // Combined codes built from whitelisted values are allowed (same audit as the
  // kernel: each code must be in ALLOWED_SGR_CODES); 256-colour is not.
  const combined = ESC + '[1;31m' + '加粗红' + ESC + '[39m'
  assert.equal(sanitizeRenderedLine(combined, { color: true }), combined)
  const fakeColor = ESC + '[38;5;196m' + '冒充' + ESC + '[39m'
  const fakeSafe = sanitizeRenderedLine(fakeColor, { color: true })
  assert.equal(fakeSafe.includes('38;5;196'), false, '256-colour must be stripped')
  assert.equal(fakeSafe, '冒充' + ESC + '[39m')
  const injected = '正文' + ESC + ']8;;http://evil' + BEL + '链接' + ESC + ']8;;' + BEL
  const kept = sanitizeRenderedLine(injected, { color: true })
  assert.equal(kept.includes(ESC), false)
  assert.equal(kept.includes('正文'), true)
})

test('isAffirmativeAnswer: default is no', () => {
  for (const yes of ['y', 'Y', 'yes', 'YES', '  y  ', '是']) assert.equal(isAffirmativeAnswer(yes), true)
  for (const no of ['', 'n', 'no', 'yep', '是 的', '1']) assert.equal(isAffirmativeAnswer(no), false)
  assert.equal(isAffirmativeAnswer(undefined), false)
})

test('help and /more blocks render inside 10/80-column budgets with normal words', () => {
  const help = renderResult(shellHelpBlock(), { width: 80, color: false })
  assert.ok(help.length <= 10, 'help must stay <= 10 lines, got ' + help.length)
  assert.ok(help.every((line) => strWidth(line) <= 80))
  assert.ok(help.every((line) => !hasUnsafeDisplayChars(line)))
  const joined = help.join(LF)
  assert.ok(joined.includes('/help'))
  assert.ok(joined.includes('/quit'))
  assert.ok(joined.includes('advisers --help'))
  const narrow = renderResult(shellHelpBlock(), { width: 40, color: false })
  assert.ok(narrow.every((line) => strWidth(line) <= 40))
  const more = renderResult(shellMoreBlock(), { width: 80, color: false, maxItems: 100 })
  const moreJoined = more.join(LF)
  for (const expected of ['/deliveries', '/agenda', '/audit', '/brief <text>']) assert.ok(moreJoined.includes(expected), expected)
  assert.ok(more.every((line) => strWidth(line) <= 80))
})

// ---------------------------------------------------------------------------
// Fake IO: deterministic shell behaviour
// ---------------------------------------------------------------------------

test('fake IO: prompts/status go to stderr, result blocks to stdout (snapshot)', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: false, stderrTTY: true, columns: 80 })
  const handlers = {
    status: () => ({ model: 'fake-model' }),
    history: () => ({ sessions: [{ id: 'local_1', title: '报价会话' }, { id: 'local_2', title: '周报' }] }),
    turn: async (payload) => ({ reply: '答复：' + payload.text, next: '/help' }),
  }
  const done = runShell({ argv: ['--plain'], env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers })
  await waitForPrompt(io)
  feed(io, '/help')
  await sleep(30)
  feed(io, '/history')
  await sleep(30)
  feed(io, '你好')
  await until(() => io.stdoutText().includes('答复：你好'), 'turn result')
  feed(io, '/quit')
  const result = await done
  assert.deepEqual({ ...result }, { entered: true, exitCode: 0, reason: 'quit', turns: 1 })
  assert.deepEqual(splitLines(io.stdoutText()), [
    '  核心命令（业务写操作留在 CLI）',
    '  业务命令用 advisers --help；以空格或 // 开头可发送以 / 开头的文本。',
    '  - /help /more 帮助 / 旧命令全量',
    '  - /status 状态；/history /resume <n|id> /new 会话',
    '  - /file <path> /files /clear 附件',
    '  - /retry /verbose 重试上一轮 / 明细',
    '  - /today /remind /who /client /evidence 只读视图',
    '  - /quit（/exit、Ctrl+D）退出；Esc / Ctrl+C 中断本轮',
    '  最近会话',
    '  - 1. 报价会话 [local_1]',
    '  - 2. 周报 [local_2]',
    '  下一步：/resume <n|id> 恢复',
    '  答复：你好',
    '  下一步：/help',
    '',
  ])
  const stderr = io.stderrText()
  assert.ok(stderr.includes('advisers: 输出不是终端'), 'stdout-pipe notice on stderr')
  assert.ok(stderr.includes('就绪 · fake-model'), 'status line on stderr')
  assert.ok(stderr.includes(PROMPT), 'prompt on stderr')
  assert.ok(stderr.includes('工作中'), 'busy status on stderr')
  assert.equal(io.stdoutText().includes(PROMPT), false, 'prompt never pollutes stdout')
  assert.equal(io.stdoutText().includes('就绪'), false, 'status never pollutes stdout')
  assert.equal(hasControlByte(io.allText()), false)
  assert.equal(hasBidiControl(io.allText()), false)
})

test('fake IO: --plain on a TTY is byte-clean (no ESC, no cursor control)', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: true, columns: 80 })
  const handlers = { status: () => ({}) }
  const done = runShell({ argv: ['--plain'], env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers })
  await waitForPrompt(io)
  feed(io, '/help')
  await sleep(30)
  feed(io, '/quit')
  const result = await done
  assert.equal(result.exitCode, 0)
  assert.equal(io.allText().includes(ESC), false, 'plain mode must not emit ESC')
  assert.equal(io.allText().includes(CR), false, 'plain mode must not emit CR')
  assert.equal(hasControlByte(io.allText()), false)
  assert.ok(io.stdoutText().includes('就绪'))
})

test('fake IO: non-TTY stdin and --json never enter the shell and write nothing', async () => {
  const nonTty = fakeIO({ stdinTTY: false, stdoutTTY: false })
  const nonTtyResult = await runShell({ argv: [], env: {}, stdin: nonTty.stdin, stdout: nonTty.stdout, stderr: nonTty.stderr, handlers: {} })
  assert.deepEqual({ ...nonTtyResult }, { entered: false, exitCode: 0, reason: 'stdin-not-tty', turns: 0 })
  assert.equal(nonTty.allText(), '')

  const json = fakeIO({ stdinTTY: true, stdoutTTY: true })
  const jsonResult = await runShell({ argv: ['--json'], env: {}, stdin: json.stdin, stdout: json.stdout, stderr: json.stderr, handlers: {} })
  assert.deepEqual({ ...jsonResult }, { entered: false, exitCode: 1, reason: 'json-unsupported', turns: 0 })
  assert.equal(json.allText(), '')
})

test('fake IO: width is re-read on every render and ADVISERS_SHELL_WIDTH overrides it', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: false, columns: 120 })
  const long = '长'.repeat(80)
  const handlers = {
    status: () => ({}),
    turn: async (payload) => ({ reply: payload.text + '：' + long }),
  }
  const done = runShell({ argv: ['--plain'], env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers })
  await waitForPrompt(io)
  feed(io, '一')
  await until(() => io.stdoutText().includes('长'), 'first reply')
  const firstLines = splitLines(io.stdoutText()).filter((line) => line !== '')
  assert.ok(firstLines.every((line) => strWidth(line) <= 120))
  assert.ok(firstLines.some((line) => strWidth(line) > 60), '120-column render should use more than 60 columns')

  io.stdout.columns = 60
  feed(io, '二')
  await until(() => io.stdoutText().includes('二：'), 'second reply')
  const all = io.stdoutText()
  const second = all.slice(all.indexOf('二：'))
  for (const line of splitLines(second)) assert.ok(strWidth(line) <= 60, 'line exceeds 60: ' + line)
  feed(io, '/quit')
  await done

  const narrow = fakeIO({ stdinTTY: true, stdoutTTY: false, columns: 100 })
  const narrowDone = runShell({ argv: [], env: { ADVISERS_SHELL_WIDTH: '40' }, stdin: narrow.stdin, stdout: narrow.stdout, stderr: narrow.stderr, handlers })
  await waitForPrompt(narrow)
  feed(narrow, '内容')
  await until(() => narrow.stdoutText().includes('内容'), 'narrow reply')
  feed(narrow, '/quit')
  await narrowDone
  for (const line of splitLines(narrow.stdoutText())) assert.ok(strWidth(line) <= 40, 'env width line exceeds 40: ' + line)
})

test('fake IO: ANSI/OSC/bidi injection from handlers is sanitised on every output line', async () => {
  const evil = ESC + '[2J' + ESC + ']0;pwned' + BEL + BIDI_RLO + '报价' + ESC + '[31m'
  const evilBlock = { headline: evil, summary: evil, lines: [evil], artifacts: [{ path: evil, bytes: 12, verified: true }], checks: [evil], warnings: [evil, evil], next: evil }
  const handlers = {
    status: () => ({ model: evil }),
    turn: async () => ({ ...evilBlock, reply: evil }),
    history: () => ({ sessions: [{ id: 's1', title: evil }] }),
    legacyCommand: () => ({ headline: evil, lines: [evil] }),
  }
  const io = fakeIO({ stdinTTY: true, stdoutTTY: false, columns: 80 })
  const done = runShell({ argv: ['--plain'], env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers })
  await waitForPrompt(io)
  for (const line of ['你好', '/status', '/history', '/file ' + evil, '/files', '/legacytime']) {
    feed(io, line)
    await sleep(30)
  }
  feed(io, '/quit')
  await done
  const all = io.allText()
  assert.equal(all.includes(ESC), false, 'ESC leaked to a human line')
  assert.equal(all.includes(BEL), false, 'BEL leaked to a human line')
  assert.equal(all.includes(ESC + '[2J'), false, 'clear-screen leaked')
  assert.equal(hasBidiControl(all), false, 'bidi override leaked')
  assert.equal(hasControlByte(all), false, 'C0/C1 leaked')
  assert.ok(all.includes('报价'), 'normal CJK text must survive sanitisation')
})

test('fake IO: colour mode emits only the 16-colour SGR whitelist, --plain emits none', async () => {
  const run = async (argv, columns) => {
    const io = fakeIO({ stdinTTY: true, stdoutTTY: true, columns })
    const handlers = { status: () => ({}), turn: async () => ({ reply: '回复' }) }
    const done = runShell({ argv, env: { TERM: 'xterm-256color' }, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers })
    await waitForPrompt(io)
    feed(io, 'hi', CR)
    await until(() => io.stdoutText().includes('回复'), 'reply')
    feed(io, '/quit', CR)
    const result = await done
    return { io, result }
  }
  const colour = await run([], 100)
  assert.equal(colour.result.exitCode, 0)
  const codes = sgrCodes(colour.io.allText())
  assert.ok(codes.length > 0, 'TTY colour mode should emit at least one SGR')
  for (const code of codes) {
    const parts = code.split(';').map((part) => Number.parseInt(part, 10))
    for (const part of parts) assert.ok(ALLOWED_SGR_CODES.includes(part), 'non-whitelisted SGR code ' + code)
  }
  assert.equal(colour.io.allText().includes(ESC + '[2J'), false, 'clear-screen is forbidden')
  assert.equal(colour.io.allText().includes(ESC + ']'), false, 'OSC is forbidden')
  // readline itself may emit CSI cursor-control sequences (e.g. ESC[?25l / ESC[1G)
  // while redrawing the prompt; those are terminal control, not app text. SGR is
  // audited above, OSC/clear-screen are rejected below/above, so what remains must
  // not contain a non-CSI escape family (e.g. a two-byte ESC sequence).
  const streamText = stripSgr(colour.io.allText()).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  assert.equal(streamText.includes(ESC), false, 'non-CSI escapes are forbidden on app-written lines')

  const plain = await run(['--plain'], 100)
  assert.equal(plain.io.allText().includes(ESC), false, '--plain must emit no ESC at all')
})

test('fake IO: idle Ctrl+C clears the line, hints, and exits on the second press', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: true, columns: 80 })
  const handlers = { status: () => ({}) }
  let settled = false
  const done = runShell({ env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers })
  done.then(() => { settled = true })
  await waitForPrompt(io)
  io.stdin.write(CTRL_C)
  await until(() => io.allText().includes('再按一次 Ctrl+C'), 'Ctrl+C hint')
  assert.equal(settled, false, 'first Ctrl+C must not exit')
  io.stdin.write(CTRL_C)
  const result = await done
  assert.deepEqual({ ...result }, { entered: true, exitCode: 0, reason: 'sigint', turns: 0 })
})

test('fake IO: Ctrl+C during a turn aborts it through AbortSignal and keeps the shell alive', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: true, columns: 100 })
  let aborted = false
  const states = []
  const handlers = {
    status: () => ({}),
    turn: (payload) => new Promise((resolve, reject) => {
      payload.signal.addEventListener('abort', () => {
        aborted = true
        reject(Object.assign(new Error('cancelled by user'), { code: 'CANCELLED_BY_USER' }))
      })
    }),
  }
  const done = runShell({ env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers, onState: (transition) => states.push(transition.from + '->' + transition.to) })
  await waitForPrompt(io)
  feed(io, '阻塞任务', CR)
  await until(() => io.allText().includes('工作中'), 'busy status')
  io.stdin.write(CTRL_C)
  await until(() => io.allText().includes('已中断本轮'), 'interrupted block')
  assert.equal(aborted, true, 'the turn handler must observe the abort')
  feed(io, '/quit', CR)
  const result = await done
  assert.deepEqual({ ...result }, { entered: true, exitCode: 0, reason: 'quit', turns: 1 })
  assert.ok(states.includes(SHELL_STATES.IDLE + '->' + SHELL_STATES.WORKING))
  // Typing the interrupt also marks buffered input, so the abort can pass through
  // QUEUED; either path must end back at IDLE.
  assert.ok(states.includes(SHELL_STATES.WORKING + '->' + SHELL_STATES.QUEUED) || states.includes(SHELL_STATES.WORKING + '->' + SHELL_STATES.IDLE))
  assert.ok(states[states.length - 1] === SHELL_STATES.QUEUED + '->' + SHELL_STATES.IDLE || states[states.length - 1] === SHELL_STATES.WORKING + '->' + SHELL_STATES.IDLE, JSON.stringify(states))
})

test('fake IO: Esc during a turn aborts it after the ESC hold window', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: true, columns: 100 })
  let aborted = false
  const handlers = {
    status: () => ({}),
    turn: (payload) => new Promise((resolve, reject) => {
      payload.signal.addEventListener('abort', () => {
        aborted = true
        reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED_BY_USER' }))
      })
    }),
  }
  const done = runShell({ env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers })
  await waitForPrompt(io)
  feed(io, '阻塞任务', CR)
  await until(() => io.allText().includes('工作中'), 'busy status')
  io.stdin.write(ESC)
  await until(() => io.allText().includes('已中断本轮'), 'interrupted block', 4000)
  assert.equal(aborted, true, 'the turn handler must observe the abort')
  feed(io, '/quit', CR)
  const result = await done
  assert.equal(result.exitCode, 0)
  assert.equal(result.turns, 1)
})

test('fake IO: a 3-line paste becomes exactly one turn and never auto-executes', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: true, columns: 100 })
  const turns = []
  const handlers = {
    status: () => ({}),
    turn: async (payload) => { turns.push(payload.text); return { reply: 'ok:' + payload.text } },
  }
  const done = runShell({ env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers })
  await waitForPrompt(io)
  io.stdin.write(PASTE_OPEN + '第一行' + CR + LF + '第二行' + CR + LF + '第三行' + PASTE_CLOSE)
  await sleep(150)
  assert.deepEqual(turns, [], 'paste must not execute before Enter')
  assert.equal(io.allText().includes('已合并'), false, 'no merge notice before submit')
  io.stdin.write(CR)
  await until(() => turns.length === 1, 'one paste turn')
  assert.deepEqual(turns, ['第一行 第二行 第三行'])
  await until(() => io.allText().includes('已合并 3 行粘贴为一条输入'), 'paste notice')
  feed(io, '/quit', CR)
  const result = await done
  assert.equal(result.exitCode, 0)
  assert.equal(result.turns, 1)
})

test('fake IO: confirmation is modal and defaults to no (y / n / Enter / Ctrl+C)', async () => {
  async function confirmRun(answerBytes) {
    const io = fakeIO({ stdinTTY: true, stdoutTTY: true, columns: 90 })
    let answer = 'unset'
    const handlers = {
      status: () => ({}),
      turn: async (payload) => {
        answer = await payload.confirm({ path: 'out/x.docx', reason: '文件已存在' })
        return { reply: '确认结果' }
      },
    }
    const done = runShell({ env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers })
    await waitForPrompt(io)
    feed(io, '重做报价', CR)
    await until(() => io.allText().includes('需要确认'), 'confirm block')
    io.stdin.write(answerBytes)
    await until(() => io.allText().includes('确认结果'), 'turn resumed after confirm')
    feed(io, '/quit', CR)
    const result = await done
    return { io, result, answer }
  }
  const yes = await confirmRun('y' + CR)
  assert.equal(yes.answer, true)
  const out = yes.io.allText()
  assert.ok(out.includes('! 需要确认：覆盖写入'))
  assert.ok(out.includes('原因：文件已存在'))
  assert.ok(out.includes('写入：out/x.docx'))
  assert.ok(out.includes('y 写入 / n 取消（默认 n）'))
  assert.equal(yes.result.exitCode, 0)

  assert.equal((await confirmRun('n' + CR)).answer, false)
  assert.equal((await confirmRun(CR)).answer, false)
  assert.equal((await confirmRun(CTRL_C)).answer, false)
})

test('fake IO: input typed during a turn is queued (QUEUED) and runs after it', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: true, columns: 100 })
  const calls = []
  const states = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const handlers = {
    status: () => ({}),
    turn: async (payload) => {
      calls.push(payload.text)
      if (payload.text === '慢任务') await gate
      return { reply: '完成:' + payload.text }
    },
  }
  const done = runShell({
    env: {},
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    handlers,
    onState: (transition) => states.push(transition.from + '->' + transition.to),
  })
  await waitForPrompt(io)
  feed(io, '慢任务', CR)
  await until(() => calls.length === 1 && io.allText().includes('工作中'), 'busy turn')
  feed(io, '第二条', CR)
  await until(() => states.includes(SHELL_STATES.WORKING + '->' + SHELL_STATES.QUEUED), 'queued state')
  release()
  await until(() => calls.length === 2, 'queued turn ran')
  assert.deepEqual(calls, ['慢任务', '第二条'])
  feed(io, '/quit', CR)
  const result = await done
  assert.equal(result.turns, 2)
  assert.equal(result.exitCode, 0)
})

test('fake IO: Ctrl+D and stdin end both exit with reason eof', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: true, columns: 80 })
  const done = runShell({ env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers: { status: () => ({}) } })
  await waitForPrompt(io)
  io.stdin.write(CTRL_D)
  const result = await done
  assert.deepEqual({ ...result }, { entered: true, exitCode: 0, reason: 'eof', turns: 0 })

  const pipe = fakeIO({ stdinTTY: true, stdoutTTY: false, columns: 80 })
  const pipeDone = runShell({ argv: ['--plain'], env: {}, stdin: pipe.stdin, stdout: pipe.stdout, stderr: pipe.stderr, handlers: { status: () => ({}) } })
  await waitForPrompt(pipe)
  pipe.stdin.end()
  const pipeResult = await pipeDone
  assert.equal(pipeResult.reason, 'eof')
  assert.equal(pipeResult.exitCode, 0)
})

test('fake IO: full command surface routes handlers and renders kernel blocks', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: false, columns: 90 })
  const calls = []
  const handlers = {
    status: () => { calls.push('status'); return { headline: '状态块', lines: ['home: /tmp/fake'] } },
    history: () => { calls.push('history'); return { sessions: [{ id: 'local_1', title: '会话一' }] } },
    resume: (payload) => { calls.push('resume:' + payload.arg); return { headline: '已恢复', lines: ['local_1 会话一'] } },
    newSession: () => { calls.push('new'); return { headline: '新会话', lines: ['local_9'] } },
    today: () => { calls.push('today'); return { headline: '今天', lines: ['1 件到期'] } },
    remind: () => { calls.push('remind'); return { headline: '提醒', lines: ['1 条到期'] } },
    who: () => { calls.push('who'); return { headline: '人情', lines: ['1 条'] } },
    client: (payload) => { calls.push('client:' + payload.arg); return { headline: '客户', lines: ['cl_1 王工'] } },
    evidence: (payload) => { calls.push('evidence:' + payload.arg); return { headline: '证据', lines: ['ev_1 ok'] } },
    legacyCommand: (payload) => {
      calls.push('legacy:' + payload.name)
      if (payload.name === '/deliveries') return { headline: '旧命令', lines: ['out/weekly.docx'] }
      return undefined
    },
    turn: async (payload) => {
      calls.push('turn:' + payload.text)
      return { reply: '答复:' + payload.text, tools: [{ name: 'fs.write', ok: true }], durationMs: 5, internal: ['内部细节'] }
    },
  }
  const done = runShell({ argv: ['--plain'], env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers })
  await waitForPrompt(io)
  const script = [
    '/status', '/history', '/resume 2', '/new', '/file out/a.docx', '/files', '/clear',
    'hi', '/retry', '/verbose', 'second', '/more', '/deliveries', '/nothing',
    '/today', '/remind', '/who', '/client cl_1', '/evidence ev_1', '/quit',
  ]
  for (const line of script) {
    feed(io, line)
    await sleep(line === '/quit' ? 0 : 45)
  }
  const result = await done
  assert.equal(result.exitCode, 0)
  const out = io.stdoutText()
  for (const expected of [
    '状态块', 'home: /tmp/fake', '最近会话', '1. 会话一 [local_1]', '已恢复', '新会话', 'local_9',
    '已附加', 'out/a.docx', '附件已清空', '答复:hi', '答复:second', '明细已开启', 'fs.write', '内部细节',
    '旧命令', 'out/weekly.docx', '未知命令：/nothing', '今天', '1 件到期', '提醒', '人情', '客户', 'cl_1 王工', '证据', 'ev_1 ok', '/deliveries',
  ]) {
    assert.ok(out.includes(expected), 'missing output: ' + expected)
  }
  assert.ok(calls.includes('resume:2'), JSON.stringify(calls))
  assert.ok(calls.includes('new'), JSON.stringify(calls))
  assert.equal(calls.filter((call) => call === 'turn:hi').length, 2, 'retry reruns the last turn')
  assert.ok(calls.includes('client:cl_1'))
  assert.ok(calls.includes('evidence:ev_1'))
  assert.ok(calls.includes('legacy:/deliveries'))
  assert.ok(calls.includes('today') && calls.includes('remind') && calls.includes('who'))
  assert.ok(calls.filter((call) => call === 'status').length >= 2, 'status handler drives the status line too')
  assert.equal(hasControlByte(io.allText()), false)
})

test('fake IO: // and leading-space escapes send text that starts with a slash', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: false, columns: 90 })
  const turns = []
  const handlers = { status: () => ({}), turn: async (payload) => { turns.push(payload.text); return { reply: '好' } } }
  const done = runShell({ argv: ['--plain'], env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers })
  await waitForPrompt(io)
  feed(io, '//这是一个句首斜杠的句子')
  await sleep(30)
  feed(io, ' /这也保留斜杠')
  await sleep(30)
  feed(io, '')
  await sleep(20)
  feed(io, '普通文本')
  await until(() => turns.length === 3, 'three text turns')
  feed(io, '/quit')
  await done
  assert.deepEqual(turns, ['/这是一个句首斜杠的句子', '/这也保留斜杠', '普通文本'])
})

test('fake IO: a turn question becomes the next turn context (or the answer handler)', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: false, columns: 90 })
  const turns = []
  const handlers = {
    status: () => ({}),
    turn: async (payload) => {
      turns.push(payload.text)
      if (turns.length === 1) return { reply: '请补充', question: '哪个客户？' }
      return { reply: '收到' }
    },
  }
  const done = runShell({ argv: ['--plain'], env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers })
  await waitForPrompt(io)
  feed(io, 'hi')
  await until(() => io.stdoutText().includes('需要补充'), 'question block')
  feed(io, '王工')
  await until(() => turns.length === 2, 'answer turn')
  assert.equal(turns[1], 'hi' + LF + '补充：王工')
  feed(io, '/quit')
  await done

  const answerIo = fakeIO({ stdinTTY: true, stdoutTTY: false, columns: 90 })
  let answered = null
  let answerTurns = 0
  const answerHandlers = {
    status: () => ({}),
    turn: async () => { answerTurns += 1; return { reply: '请补充', question: '哪个客户？' } },
    answer: (payload) => { answered = payload; return { headline: '已收到补充', lines: [payload.answer] } },
  }
  const answerDone = runShell({ argv: ['--plain'], env: {}, stdin: answerIo.stdin, stdout: answerIo.stdout, stderr: answerIo.stderr, handlers: answerHandlers })
  await waitForPrompt(answerIo)
  feed(answerIo, 'hi')
  await until(() => answerIo.stdoutText().includes('需要补充'), 'question block (answer handler)')
  feed(answerIo, '王工')
  await until(() => answerIo.stdoutText().includes('已收到补充'), 'answer handler output')
  assert.equal(answered.question, '哪个客户？')
  assert.equal(answered.answer, '王工')
  assert.equal(answerTurns, 1, 'answer handler replaces the follow-up turn')
  feed(answerIo, '/quit')
  await answerDone
})

test('fake IO: store, allowPaths and ctx are passed through to handlers', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: false, columns: 90 })
  const store = { marker: 'fake-store' }
  let statusCtx = null
  let turnPayload = null
  let turnCtx = null
  const handlers = {
    status: (payload, ctx) => { statusCtx = ctx; return {} },
    turn: async (payload, ctx) => {
      turnPayload = payload
      turnCtx = ctx
      return { reply: 'ok' }
    },
  }
  const done = runShell({ argv: ['--plain'], env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, store, allowPaths: ['/tmp/allowed-dir'], handlers })
  await waitForPrompt(io)
  feed(io, 'hi')
  await until(() => turnPayload !== null, 'turn handler')
  assert.equal(statusCtx.store, store)
  assert.equal(turnPayload.store, store)
  assert.equal(turnCtx.store, store)
  assert.deepEqual(turnPayload.allowPaths, ['/tmp/allowed-dir'])
  assert.deepEqual([...turnCtx.allowPaths], ['/tmp/allowed-dir'])
  assert.equal(typeof turnCtx.width, 'function')
  assert.equal(turnCtx.width() >= 40, true)
  assert.equal(typeof turnPayload.confirm, 'function')
  assert.ok(turnPayload.signal && typeof turnPayload.signal.addEventListener === 'function')
  assert.equal(turnPayload.answerTo, null)
  feed(io, '/quit')
  await done
})

test('fake IO: opening block and missing-handler failures are explicit', async () => {
  const io = fakeIO({ stdinTTY: true, stdoutTTY: false, columns: 90 })
  const handlers = { status: () => ({}), opening: () => ({ lines: ['开场白一行'] }) }
  const done = runShell({ argv: ['--plain'], env: {}, stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, handlers })
  await waitForPrompt(io)
  assert.ok(io.stdoutText().includes('开场白一行'))
  feed(io, '/quit')
  await done

  const suppressed = fakeIO({ stdinTTY: true, stdoutTTY: false, columns: 90 })
  const suppressedDone = runShell({ argv: ['--plain'], env: { ADVISERS_SHELL_NO_OPENING: '1' }, stdin: suppressed.stdin, stdout: suppressed.stdout, stderr: suppressed.stderr, handlers })
  await waitForPrompt(suppressed)
  assert.equal(suppressed.stdoutText().includes('开场白一行'), false)
  feed(suppressed, '/quit')
  await suppressedDone

  const missing = fakeIO({ stdinTTY: true, stdoutTTY: false, columns: 90 })
  const missingDone = runShell({ argv: ['--plain'], env: {}, stdin: missing.stdin, stdout: missing.stdout, stderr: missing.stderr, handlers: {} })
  await waitForPrompt(missing)
  feed(missing, '你好')
  await until(() => missing.stdoutText().includes('对话未接线'), 'missing turn handler')
  feed(missing, '/today')
  await until(() => missing.stdoutText().includes('/today 未接线'), 'missing read-only handler')
  feed(missing, '/quit')
  const result = await missingDone
  assert.equal(result.exitCode, 0)
})

// ---------------------------------------------------------------------------
// Real PTY: keyboard semantics need a terminal line discipline
// ---------------------------------------------------------------------------

const SCRIPT_AVAILABLE = spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0
const PTY_SKIP = process.platform === 'win32' ? 'PTY tests are Linux/macOS only' : (SCRIPT_AVAILABLE ? false : 'requires util-linux script(1)')

function harnessSource() {
  return [
    "import { createWriteStream } from 'node:fs'",
    'import { runShell } from ' + JSON.stringify(SHELL_URL),
    'const outFile = process.env.SHELL_TEST_OUT',
    'const stdout = outFile ? createWriteStream(outFile) : process.stdout',
    'const handlers = {',
    "  status: () => ({ model: 'fake-model' }),",
    '  turn: (payload) => {',
    "    if (payload.text === 'block') {",
    '      return new Promise((resolve, reject) => {',
    "        payload.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled by user'), { code: 'CANCELLED_BY_USER' })))",
    '      })',
    '    }',
    "    return Promise.resolve({ reply: 'reply:' + payload.text, next: '/help' })",
    '  },',
    "  who: () => ({ headline: '我欠别人（1）', lines: ['  1  老王 · 发报价'] }),",
    '}',
    'const result = await runShell({ argv: process.argv.slice(2), env: process.env, stdin: process.stdin, stdout, stderr: process.stderr, handlers })',
    'process.exitCode = result.exitCode',
    '',
  ].join(LF)
}

function ptyWorkspace(prefix) {
  const area = workspace(prefix)
  const harnessPath = join(area.root, 'harness.mjs')
  writeFileSync(harnessPath, harnessSource(), 'utf8')
  return { root: area.root, home: area.home, harnessPath }
}

function cleanPtyEnv(home, extra = {}) {
  const env = { ...process.env }
  for (const name of ['NO_COLOR', 'ADVISERS_PLAIN', 'ADVISERS_ACCESSIBLE', 'ADVISERS_SHELL_WIDTH', 'ADVISERS_NO_SHELL', 'ADVISERS_SHELL_CANONICAL', 'ADVISERS_SHELL_NO_OPENING', 'SHELL_TEST_OUT']) delete env[name]
  env.ADVISERS_HOME = home
  env.TERM = 'xterm-256color'
  for (const [name, value] of Object.entries(extra)) env[name] = String(value)
  return env
}

class PtySession {
  constructor(child) {
    this.child = child
    this.parts = []
    child.stdout.on('data', (chunk) => this.parts.push(chunk.toString()))
    child.stderr.on('data', (chunk) => this.parts.push(chunk.toString()))
    this.exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }))
    })
  }

  static start({ harnessPath, home, args = [], env = {} }) {
    const command = process.execPath + ' ' + JSON.stringify(harnessPath) + args.map((argument) => ' ' + JSON.stringify(argument)).join('')
    const child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], { env: cleanPtyEnv(home, env), stdio: ['pipe', 'pipe', 'pipe'] })
    return new PtySession(child)
  }

  get text() {
    return this.parts.join('')
  }

  count(needle) {
    return this.text.split(needle).length - 1
  }

  write(data) {
    this.child.stdin.write(data)
  }

  async waitFor(needle, timeoutMs = 7000) {
    const started = Date.now()
    while (!this.text.includes(needle)) {
      if (Date.now() - started > timeoutMs) throw new Error('PTY timed out waiting for ' + JSON.stringify(needle) + '; tail: ' + JSON.stringify(this.text.slice(-700)))
      await sleep(10)
    }
  }

  async waitForCount(needle, count, timeoutMs = 7000) {
    const started = Date.now()
    while (this.count(needle) < count) {
      if (Date.now() - started > timeoutMs) throw new Error('PTY timed out waiting for ' + count + 'x ' + JSON.stringify(needle) + '; tail: ' + JSON.stringify(this.text.slice(-700)))
      await sleep(10)
    }
  }

  async finish() {
    try { this.child.stdin.end() } catch {}
    const outcome = await Promise.race([this.exited, sleep(5000).then(() => null)])
    if (outcome === null) {
      try { this.child.kill('SIGKILL') } catch {}
      return { code: null, signal: 'TIMEOUT' }
    }
    return outcome
  }

  kill() {
    try { this.child.kill('SIGKILL') } catch {}
  }
}

test('PTY: --plain is byte-clean (zero ESC) and exits 0', { skip: PTY_SKIP }, async () => {
  const area = ptyWorkspace('pty-plain')
  const session = PtySession.start({ harnessPath: area.harnessPath, home: area.home, args: ['--plain'] })
  try {
    await session.waitFor(PROMPT)
    session.write('/help' + CR)
    await session.waitFor('核心命令')
    session.write('/quit' + CR)
    const outcome = await session.finish()
    assert.equal(outcome.code, 0, 'PTY transcript: ' + JSON.stringify(session.text.slice(-500)))
    assert.equal(session.text.includes(ESC), false, 'plain mode must not emit ESC on a real TTY')
    assert.equal(session.text.includes('输出不是终端'), false, 'stdout is a TTY in this scenario')
  } finally {
    session.kill()
    rmSync(area.root, { recursive: true, force: true })
  }
})

test('PTY: idle Ctrl+C hints, then a second press exits 0', { skip: PTY_SKIP }, async () => {
  const area = ptyWorkspace('pty-sigint-idle')
  const session = PtySession.start({ harnessPath: area.harnessPath, home: area.home })
  try {
    await session.waitFor(PROMPT)
    session.write(CTRL_C)
    await session.waitFor('再按一次 Ctrl+C')
    session.write(CTRL_C)
    const outcome = await session.finish()
    assert.equal(outcome.code, 0, 'PTY transcript: ' + JSON.stringify(session.text.slice(-500)))
    assert.ok(session.text.includes('再按一次 Ctrl+C'))
  } finally {
    session.kill()
    rmSync(area.root, { recursive: true, force: true })
  }
})

test('PTY: Ctrl+C aborts a running turn and the shell stays usable', { skip: PTY_SKIP }, async () => {
  const area = ptyWorkspace('pty-sigint-work')
  const session = PtySession.start({ harnessPath: area.harnessPath, home: area.home })
  try {
    await session.waitFor(PROMPT)
    session.write('block' + CR)
    await session.waitFor('工作中')
    session.write(CTRL_C)
    await session.waitFor('已中断本轮')
    session.write('after' + CR)
    await session.waitFor('reply:after')
    session.write('/quit' + CR)
    const outcome = await session.finish()
    assert.equal(outcome.code, 0, 'PTY transcript: ' + JSON.stringify(session.text.slice(-700)))
    assert.ok(session.text.includes('已中断本轮'))
    assert.ok(session.text.includes('reply:after'), 'the shell must keep running after the abort')
  } finally {
    session.kill()
    rmSync(area.root, { recursive: true, force: true })
  }
})

test('PTY: Esc aborts a running turn', { skip: PTY_SKIP }, async () => {
  const area = ptyWorkspace('pty-esc')
  const session = PtySession.start({ harnessPath: area.harnessPath, home: area.home })
  try {
    await session.waitFor(PROMPT)
    session.write('block' + CR)
    await session.waitFor('工作中')
    session.write(ESC)
    await session.waitFor('已中断本轮', 5000)
    session.write('/quit' + CR)
    const outcome = await session.finish()
    assert.equal(outcome.code, 0, 'PTY transcript: ' + JSON.stringify(session.text.slice(-700)))
  } finally {
    session.kill()
    rmSync(area.root, { recursive: true, force: true })
  }
})

test('PTY: a 3-line bracketed paste becomes exactly one turn', { skip: PTY_SKIP }, async () => {
  const area = ptyWorkspace('pty-paste')
  const session = PtySession.start({ harnessPath: area.harnessPath, home: area.home })
  try {
    await session.waitFor(PROMPT)
    session.write(PASTE_OPEN + '第一行' + CR + LF + '第二行' + CR + LF + '第三行' + PASTE_CLOSE)
    await sleep(120)
    session.write(CR)
    await session.waitFor('已合并 3 行粘贴')
    await session.waitFor('reply:第一行 第二行 第三行')
    session.write('/quit' + CR)
    const outcome = await session.finish()
    assert.equal(outcome.code, 0, 'PTY transcript: ' + JSON.stringify(session.text.slice(-700)))
    assert.equal(session.count('reply:'), 1, 'the paste must produce exactly one turn')
  } finally {
    session.kill()
    rmSync(area.root, { recursive: true, force: true })
  }
})

test('PTY: readline in-memory history recalls the previous line', { skip: PTY_SKIP }, async () => {
  const area = ptyWorkspace('pty-history')
  const session = PtySession.start({ harnessPath: area.harnessPath, home: area.home })
  try {
    await session.waitFor(PROMPT)
    session.write('hello' + CR)
    await session.waitForCount('reply:hello', 1)
    session.write(ESC + '[A' + CR)
    await session.waitForCount('reply:hello', 2)
    session.write('/quit' + CR)
    const outcome = await session.finish()
    assert.equal(outcome.code, 0, 'PTY transcript: ' + JSON.stringify(session.text.slice(-700)))
    assert.equal(session.count('reply:hello'), 2)
  } finally {
    session.kill()
    rmSync(area.root, { recursive: true, force: true })
  }
})

test('PTY: stdin TTY + stdout pipe keeps prompts/status off stdout and results clean', { skip: PTY_SKIP }, async () => {
  const area = ptyWorkspace('pty-split')
  const outPath = join(area.root, 'stdout.out')
  const session = PtySession.start({ harnessPath: area.harnessPath, home: area.home, env: { SHELL_TEST_OUT: outPath } })
  try {
    await session.waitFor(PROMPT)
    await session.waitFor('输出不是终端')
    session.write('hello' + CR)
    await until(() => existsSync(outPath) && readFileSync(outPath, 'utf8').includes('reply:hello'), 'stdout file result', 7000)
    session.write('/quit' + CR)
    const outcome = await session.finish()
    assert.equal(outcome.code, 0, 'PTY transcript: ' + JSON.stringify(session.text.slice(-700)))
    await sleep(50)
    const fileText = readFileSync(outPath, 'utf8')
    assert.deepEqual(splitLines(fileText), ['  reply:hello', '  下一步：/help', ''])
    assert.equal(fileText.includes(PROMPT), false, 'prompt must not pollute the stdout pipe')
    assert.equal(fileText.includes('就绪'), false, 'status must not pollute the stdout pipe')
    assert.equal(fileText.includes(ESC), false, 'plain pipe output must have no ESC')
    assert.equal(fileText.includes(CR), false, 'plain pipe output must have no CR')
    assert.ok(session.text.includes('就绪'), 'status line goes to stderr (the PTY)')
    assert.ok(session.text.includes(PROMPT), 'prompt goes to stderr (the PTY)')
  } finally {
    session.kill()
    rmSync(area.root, { recursive: true, force: true })
  }
})

test('PTY: colour mode emits only the SGR whitelist and never OSC/clear-screen', { skip: PTY_SKIP }, async () => {
  const area = ptyWorkspace('pty-colour')
  const session = PtySession.start({ harnessPath: area.harnessPath, home: area.home })
  try {
    await session.waitFor(PROMPT)
    session.write('/help' + CR)
    await session.waitFor('核心命令')
    session.write('/quit' + CR)
    const outcome = await session.finish()
    assert.equal(outcome.code, 0, 'PTY transcript: ' + JSON.stringify(session.text.slice(-700)))
    const text = session.text
    const codes = sgrCodes(text)
    assert.ok(codes.length > 0, 'a colour TTY should emit at least one SGR')
    for (const code of codes) {
      for (const part of code.split(';')) assert.ok(ALLOWED_SGR_CODES.includes(Number.parseInt(part, 10)), 'non-whitelisted SGR ' + code)
    }
    assert.equal(text.includes(ESC + '[2J'), false, 'clear-screen is forbidden')
    assert.equal(text.includes(ESC + ']'), false, 'OSC is forbidden')
    assert.equal(hasBidiControl(text), false)
  } finally {
    session.kill()
    rmSync(area.root, { recursive: true, force: true })
  }
})
