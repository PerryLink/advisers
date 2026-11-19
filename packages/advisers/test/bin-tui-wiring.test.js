/**
 * 0.3.0 Wave 3 bin wiring: `advisers tui` isTTY guard, --json purity and the
 * global output-policy flags (plan 26 §6.1/§10.3, docs/TUI.md §6/§9).
 *
 * Every case spawns the real CLI with an empty, closed, non-TTY stdin pipe, so a
 * regression that re-enters readline or clears the screen fails here instead of
 * in a user's CI log.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { isJsonPure } from '../lib/tui/json.js'
import { strWidth } from '../lib/tui/width.js'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/

function workspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-tui-' + prefix + '-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home }
}

function env(home, extra = {}) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra })
}

/** Spawn the CLI with an empty, closed, non-TTY stdin pipe. */
function cli(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8', input: '', timeout: 20000 })
}

function assertPlain(label, result) {
  assert.equal(result.status, 0, label + ': exit ' + result.status + ' stderr=' + result.stderr)
  assert.equal(result.signal, null, label + ': killed by ' + result.signal)
  assert.ok(!result.stdout.includes('\u001b'), label + ': stdout contains ESC')
  assert.ok(!result.stdout.includes('\r'), label + ': stdout contains CR')
  assert.ok(!CONTROL.test(result.stdout), label + ': stdout contains C0/C1 controls')
  assert.ok(!CONTROL.test(result.stderr), label + ': stderr contains C0/C1 controls')
  assert.ok(result.stdout.endsWith('\n'), label + ': stdout does not end with a newline')
}

test('0.3.0: tui never clears the screen and never waits for input when stdin is not a TTY', () => {
  const ws = workspace('non-tty')
  try {
    const seed = cli(ws.home, ['commit', 'add', '发报价', '--quote', 'q'])
    assert.equal(seed.status, 0, seed.stderr)
    for (const args of [['tui'], ['tui', '--once']]) {
      const result = cli(ws.home, args)
      assertPlain(args.join(' '), result)
      assert.match(result.stdout, /Advisers TUI/)
      assert.match(result.stdout, /open commitments/)
      assert.match(result.stdout, /发报价/)
    }
    // The interactive entry is a plain one-shot snapshot on a pipe, not a
    // different (clear-screen) path.
    assert.equal(cli(ws.home, ['tui']).stdout, cli(ws.home, ['tui', '--once']).stdout)
  } finally { rmSync(ws.root, { recursive: true, force: true }) }
})

test('0.3.0: tui --plain/--accessible/--color=never/NO_COLOR are byte-identical and plain', () => {
  const ws = workspace('policy')
  try {
    const seed = cli(ws.home, ['commit', 'add', '发报价', '--quote', 'q'])
    assert.equal(seed.status, 0, seed.stderr)
    const base = cli(ws.home, ['tui', '--once'])
    assertPlain('base', base)
    for (const args of [['--plain'], ['--accessible'], ['--color=never'], ['--color', 'never']]) {
      const result = cli(ws.home, ['tui', '--once', ...args])
      assertPlain('tui ' + args.join(' '), result)
      assert.equal(result.stdout, base.stdout, 'tui ' + args.join(' ') + ' changed the plain snapshot bytes')
    }
    for (const extra of [{ NO_COLOR: '1' }, { ADVISERS_PLAIN: '1' }, { ADVISERS_ACCESSIBLE: '1' }]) {
      const result = cli(ws.home, ['tui', '--once'], extra)
      assertPlain('env ' + Object.keys(extra)[0], result)
      assert.equal(result.stdout, base.stdout, 'env ' + Object.keys(extra)[0] + ' changed the plain snapshot bytes')
    }
  } finally { rmSync(ws.root, { recursive: true, force: true }) }
})

test('0.3.0: tui --json is one pure JSON document and sanitises ledger text', () => {
  const ws = workspace('json')
  try {
    const evil = '报\u001b[2J价\u001b]0;pwned\u0007\u202e'
    const seed = cli(ws.home, ['commit', 'add', evil, '--quote', 'q'])
    assert.equal(seed.status, 0, seed.stderr)
    for (const args of [['tui', '--json'], ['tui', '--once', '--json']]) {
      const result = cli(ws.home, args)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr, '', args.join(' ') + ' wrote diagnostics to stderr')
      assert.ok(isJsonPure(result.stdout), args.join(' ') + ' stdout is not one pure JSON document')
      const payload = JSON.parse(result.stdout)
      assert.equal(payload.ok, true)
      assert.equal(payload.command, 'tui')
      assert.equal(payload.mode, 'snapshot')
      assert.equal(payload.counts.open, 1)
      assert.equal(payload.commitments.length, 1)
      const action = payload.commitments[0].action
      assert.ok(!action.includes('\u001b'), 'json action kept ESC')
      assert.ok(!action.includes('\u0007'), 'json action kept BEL')
      assert.ok(!action.includes('\u202e'), 'json action kept a bidi override')
      assert.ok(action.includes('报') && action.includes('价'), 'sanitisation must keep normal CJK text')
    }
    const human = cli(ws.home, ['tui', '--once'])
    assertPlain('evil-human', human)
    assert.ok(!human.stdout.includes('\u001b[2J'), 'human tui must sanitise ledger text')
  } finally { rmSync(ws.root, { recursive: true, force: true }) }
})

test('0.3.0: --color validates its value; --width wraps CJK inside the column budget', () => {
  const ws = workspace('width')
  try {
    const bad = cli(ws.home, ['tui', '--color', 'sometimes'])
    assert.equal(bad.status, 1)
    assert.equal(bad.stdout, '')
    assert.match(bad.stderr, /E_USAGE/)
    assert.match(bad.stderr, /--color/)
    const forced = cli(ws.home, ['tui', '--once', '--color', 'always'])
    assertPlain('color-always', forced)
    const seed = cli(ws.home, ['commit', 'add', '给王工发修订报价并确认范围说明', '--quote', 'q'])
    assert.equal(seed.status, 0, seed.stderr)
    const narrow = cli(ws.home, ['tui', '--once', '--width', '40'])
    assertPlain('width-40', narrow)
    for (const line of narrow.stdout.split('\n')) {
      assert.ok(strWidth(line) <= 40, 'line exceeds 40 columns (' + strWidth(line) + '): ' + line)
    }
  } finally { rmSync(ws.root, { recursive: true, force: true }) }
})
