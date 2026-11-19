import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALLOWED_SGR_CODES,
  COLOR_MODES,
  hasOnlyWhitelistedSgr,
  noColorEnv,
  parseColorMode,
  readColorArg,
  resolveColorEnabled,
  sgrCodes,
  SGR,
  stripSgr,
  styleText,
} from '../lib/tui/color.js'
import { envFlag, resolveOutputPolicy } from '../lib/tui/policy.js'

const ESC = '\u001b'

test('parseColorMode accepts exactly auto/always/never', () => {
  assert.deepEqual(COLOR_MODES, ['auto', 'always', 'never'])
  assert.equal(parseColorMode('auto'), 'auto')
  assert.equal(parseColorMode(' ALWAYS '), 'always')
  assert.equal(parseColorMode('never'), 'never')
  assert.equal(parseColorMode('sometimes'), null)
  assert.equal(parseColorMode(undefined), null)
})

test('readColorArg supports --color=value and --color value', () => {
  assert.deepEqual(readColorArg(['--color=never']), { found: true, mode: 'never', invalid: false })
  assert.deepEqual(readColorArg(['--color', 'always']), { found: true, mode: 'always', invalid: false })
  assert.deepEqual(readColorArg(['--plain', '--color=auto']), { found: true, mode: 'auto', invalid: false })
  assert.deepEqual(readColorArg(['--color=bogus']), { found: true, mode: null, invalid: true })
  assert.deepEqual(readColorArg([]), { found: false, mode: null, invalid: false })
})

test('NO_COLOR follows the convention: present and non-empty disables colour', () => {
  assert.equal(noColorEnv({ NO_COLOR: '1' }), true)
  assert.equal(noColorEnv({ NO_COLOR: 'anything' }), true)
  assert.equal(noColorEnv({ NO_COLOR: '' }), false)
  assert.equal(noColorEnv({}), false)
})

test('colour resolution precedence: explicit flag > NO_COLOR/TERM/non-TTY', () => {
  assert.equal(resolveColorEnabled({ mode: 'always', env: { NO_COLOR: '1', TERM: 'dumb' }, stdoutIsTTY: false }), true)
  assert.equal(resolveColorEnabled({ mode: 'never', env: { TERM: 'xterm' }, stdoutIsTTY: true }), false)
  assert.equal(resolveColorEnabled({ mode: 'auto', env: { TERM: 'xterm' }, stdoutIsTTY: true }), true)
  assert.equal(resolveColorEnabled({ mode: 'auto', env: {}, stdoutIsTTY: false }), false)
  assert.equal(resolveColorEnabled({ mode: 'auto', env: { TERM: 'dumb' }, stdoutIsTTY: true }), false)
  assert.equal(resolveColorEnabled({ mode: 'auto', env: { NO_COLOR: '1', TERM: 'xterm' }, stdoutIsTTY: true }), false)
})

test('styleText emits only whitelisted 16-colour SGR codes', () => {
  assert.equal(styleText('x', 'dim', { enabled: false }), 'x')
  assert.equal(styleText('x', 'dim'), ESC + '[2mx' + ESC + '[22m')
  assert.equal(styleText('x', 'red'), ESC + '[31mx' + ESC + '[39m')
  assert.equal(styleText('x', ['dim', 'yellow']), ESC + '[2m' + ESC + '[33mx' + ESC + '[39m' + ESC + '[22m')
  assert.equal(styleText('x', null), 'x')
  for (const name of ['dim', 'red', 'green', 'yellow']) {
    const codes = sgrCodes(styleText('x', name))
    assert.ok(codes.length > 0)
    assert.ok(codes.every((code) => ALLOWED_SGR_CODES.includes(code)), name)
  }
  assert.deepEqual(ALLOWED_SGR_CODES, [1, 2, 22, 31, 32, 33, 39])
  assert.equal(SGR.red, 31)
})

test('stripSgr/sgrCodes/hasOnlyWhitelistedSgr audit emitted colour', () => {
  const styled = styleText('你好', 'green')
  assert.equal(stripSgr(styled), '你好')
  assert.deepEqual(sgrCodes(styled), [32, 39])
  assert.equal(hasOnlyWhitelistedSgr(styled), true)
  assert.equal(hasOnlyWhitelistedSgr(ESC + '[38;5;196mred'), false)
  assert.equal(hasOnlyWhitelistedSgr(ESC + '[48;2;1;2;3mbackground'), false)
  assert.equal(hasOnlyWhitelistedSgr(ESC + '[7mreverse'), false)
})

test('envFlag recognises on/off spellings', () => {
  assert.equal(envFlag({ ADVISERS_ACCESSIBLE: '1' }, 'ADVISERS_ACCESSIBLE'), true)
  assert.equal(envFlag({ ADVISERS_ACCESSIBLE: 'true' }, 'ADVISERS_ACCESSIBLE'), true)
  assert.equal(envFlag({ ADVISERS_ACCESSIBLE: '0' }, 'ADVISERS_ACCESSIBLE'), false)
  assert.equal(envFlag({ ADVISERS_ACCESSIBLE: 'off' }, 'ADVISERS_ACCESSIBLE'), false)
  assert.equal(envFlag({ ADVISERS_ACCESSIBLE: '' }, 'ADVISERS_ACCESSIBLE'), false)
  assert.equal(envFlag({}, 'ADVISERS_ACCESSIBLE'), false)
})

test('output policy: TTY, piped, plain, accessible and dumb terminal', () => {
  const tty = resolveOutputPolicy({ argv: [], env: { TERM: 'xterm-256color' }, stdinIsTTY: true, stdoutIsTTY: true })
  assert.equal(tty.mode, 'tty')
  assert.equal(tty.color, true)
  assert.equal(tty.plain, false)
  assert.equal(tty.cursorControl, true)
  assert.equal(tty.statusRefresh, true)
  assert.equal(tty.interactive, true)

  const piped = resolveOutputPolicy({ argv: [], env: { TERM: 'xterm' }, stdinIsTTY: false, stdoutIsTTY: false })
  assert.equal(piped.mode, 'plain')
  assert.equal(piped.color, false)
  assert.equal(piped.cursorControl, false)
  assert.equal(piped.statusRefresh, false)
  assert.equal(piped.interactive, false)

  const plain = resolveOutputPolicy({ argv: ['--plain'], env: { TERM: 'xterm' }, stdinIsTTY: true, stdoutIsTTY: true })
  assert.equal(plain.mode, 'plain')
  assert.equal(plain.plain, true)
  assert.equal(plain.color, false)
  assert.equal(plain.cursorControl, false)

  const dumb = resolveOutputPolicy({ argv: [], env: { TERM: 'dumb' }, stdinIsTTY: true, stdoutIsTTY: true })
  assert.equal(dumb.mode, 'plain')
  assert.equal(dumb.reason, 'term-dumb')

  const noColor = resolveOutputPolicy({ argv: [], env: { TERM: 'xterm', NO_COLOR: '1' }, stdinIsTTY: true, stdoutIsTTY: true })
  assert.equal(noColor.mode, 'tty')
  assert.equal(noColor.color, false)
  assert.equal(noColor.cursorControl, true)
  assert.equal(noColor.reason, 'tty')
})

test('output policy: accessible implies plain + [状态] mode and no refresh', () => {
  const accessible = resolveOutputPolicy({ argv: ['--accessible'], env: { TERM: 'xterm' }, stdinIsTTY: true, stdoutIsTTY: true })
  assert.equal(accessible.mode, 'accessible')
  assert.equal(accessible.accessible, true)
  assert.equal(accessible.plain, true)
  assert.equal(accessible.color, false)
  assert.equal(accessible.cursorControl, false)
  assert.equal(accessible.statusRefresh, false)
  const viaEnv = resolveOutputPolicy({ argv: [], env: { TERM: 'xterm', ADVISERS_ACCESSIBLE: '1' }, stdinIsTTY: true, stdoutIsTTY: true })
  assert.equal(viaEnv.mode, 'accessible')
})

test('output policy: explicit --color=always wins, invalid value throws', () => {
  const forced = resolveOutputPolicy({ argv: ['--color=always'], env: { NO_COLOR: '1', TERM: 'dumb' }, stdinIsTTY: true, stdoutIsTTY: true })
  assert.equal(forced.color, true)
  assert.equal(forced.colorMode, 'always')
  assert.equal(forced.colorReason, 'forced-always')
  assert.equal(forced.cursorControl, false, 'dumb terminal still gets no cursor control')
  assert.equal(forced.plain, true, 'auto-plain stays on even when colour is forced')
  const forcedNaive = resolveOutputPolicy({ argv: ['--color=always'], env: { TERM: 'xterm' }, stdinIsTTY: true, stdoutIsTTY: true })
  assert.equal(forcedNaive.color, true)
  assert.equal(forcedNaive.plain, false)
  const forcedPlain = resolveOutputPolicy({ argv: ['--plain', '--color=always'], env: { TERM: 'xterm' }, stdinIsTTY: true, stdoutIsTTY: true })
  assert.equal(forcedPlain.color, false, '--plain wins over --color=always')
  const never = resolveOutputPolicy({ argv: ['--color', 'never'], env: { TERM: 'xterm' }, stdinIsTTY: true, stdoutIsTTY: true })
  assert.equal(never.color, false)
  assert.equal(never.colorMode, 'never')
  assert.throws(() => resolveOutputPolicy({ argv: ['--color=sometimes'], env: {}, stdinIsTTY: true, stdoutIsTTY: true }), /--color must be auto, always or never/)
})

test('output policy: TTY stdin with piped stdout is interactive but plain', () => {
  const policy = resolveOutputPolicy({ argv: [], env: { TERM: 'xterm' }, stdinIsTTY: true, stdoutIsTTY: false })
  assert.equal(policy.interactive, true)
  assert.equal(policy.mode, 'plain')
  assert.equal(policy.color, false)
  assert.equal(policy.reason, 'stdout-not-tty')
})

