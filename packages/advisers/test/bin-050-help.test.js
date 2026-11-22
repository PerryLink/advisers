/**
 * 0.5.0 (050-U1): `advisers help <topic>` + the additive --help usage lines.
 *
 * Acceptance (126 U1 / 124 §4): `help quote` and `help 报价` are byte-identical
 * and <= 20 lines; an unknown topic exits 1 with stdout empty and a hint; every
 * 0.5.0 command path answers -h/--help as a pure read (exit 0, one usage line,
 * no HOME side effect); the top-level help mentions `help <topic>`.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const NL = String.fromCharCode(10)
const ESC = String.fromCharCode(27)
const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_ACCEPT_TOS: '1' }

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'advisers-050-help-'))
}
function run(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home, ...extra },
    encoding: 'utf8', input: '', timeout: 60000,
  })
}

test('help <topic> and its Chinese alias are byte-identical and short', () => {
  const home = makeHome()
  try {
    const pairs = [['quote', '报价'], ['remind', '提醒'], ['errors', '排错']]
    for (const [en, zh] of pairs) {
      const a = run(home, ['help', en])
      const b = run(home, ['help', zh])
      assert.equal(a.status, 0, a.stderr)
      assert.equal(b.status, 0, b.stderr)
      assert.equal(a.stdout, b.stdout, en + '/' + zh + ' must be byte-identical')
      const lineCount = a.stdout.replace(new RegExp(NL + '$'), '').split(NL).length
      assert.ok(lineCount <= 20, en + ' help must be <= 20 lines (got ' + lineCount + ')')
      assert.equal(a.stdout.includes(ESC), false, 'help output must not contain ANSI')
    }
    assert.deepEqual(readdirSync(home), [], 'help topics must not write HOME')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('help --list and an unknown topic', () => {
  const home = makeHome()
  try {
    const list = run(home, ['help', '--list'])
    assert.equal(list.status, 0, list.stderr)
    const rows = list.stdout.split(NL).map((line) => line.trim())
    for (const id of ['start', 'quote', 'remind', 'deliver', 'receipt', 'mail', 'kb', 'privacy', 'reach', 'errors']) {
      assert.ok(rows.some((line) => line.startsWith(id + ' ')), 'missing topic ' + id)
    }
    const unknown = run(home, ['help', 'nope'])
    assert.equal(unknown.status, 1)
    assert.equal(unknown.stdout, '', 'unknown topic must keep stdout empty')
    assert.match(unknown.stderr, /E_USAGE/)
    assert.match(unknown.stderr, /advisers help --list/)
    const known = run(home, ['help', 'commit', 'add'])
    assert.equal(known.status, 0)
    assert.ok(known.stdout.startsWith('usage: advisers commit add'), known.stdout)
    assert.deepEqual(readdirSync(home), [])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('every 0.5.0 command path answers --help as a pure read', () => {
  const home = makeHome()
  try {
    const matrix = [
      ['export', '--help'],
      ['import', '--help'],
      ['context-pack', '--help'],
      ['context-pack', 'create', '--help'],
      ['context-pack', 'verify', '--help'],
      ['setup', '--help'],
      ['demo', '--help'],
      ['sync', '--help'],
      ['sync', 'status', '--help'],
      ['help', '--help'],
    ]
    for (const args of matrix) {
      const result = run(home, args)
      assert.equal(result.status, 0, args.join(' ') + ': ' + result.stderr)
      assert.ok(result.stdout.startsWith('usage: advisers '), args.join(' ') + ' must print a usage line')
      assert.equal(result.stderr, '', args.join(' ') + ' must not write stderr')
    }
    assert.deepEqual(readdirSync(home), [], '-h/--help must never write HOME')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('top-level help advertises exactly one topic entry line', () => {
  const home = makeHome()
  try {
    const top = run(home, ['--help'])
    assert.equal(top.status, 0)
    const rows = top.stdout.split(NL)
    const matches = rows.filter((line) => line.includes('advisers help [<topic>] [--list]'))
    assert.equal(matches.length, 1, 'exactly one `help <topic>` entry line')
    assert.deepEqual(readdirSync(home), [])
  } finally { rmSync(home, { recursive: true, force: true }) }
})
