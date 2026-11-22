/**
 * 0.4.3 (043-7, plan 96 §3.1 M0a): `-h`/`--help` anywhere is a pure help
 * request. 0.4.2 had 22/66 compliant paths; `init --help` executed init, `ui
 * --help` bound a port, `purge --help` read the flag as a matter id.
 *
 * The matrix asserts exit 0, one `usage: advisers ...` line on stdout, empty
 * stderr on the generic paths, and that a shared fresh home stays byte-empty
 * (no soul.md from init, no state.db from dispatch).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_ACCEPT_TOS: '1', ADVISERS_NO_MODEL: '1', ADVISERS_CORE_LOCAL: '1' }

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'advisers-043-help-'))
}

function run(home, args) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home },
    encoding: 'utf8', input: '', timeout: 60000,
  })
  return { ...result, elapsedMs: Date.now() - started }
}

const HELP_MATRIX = [
  ['init', '--help'],
  ['ui', '--help'],
  ['purge', '--help'],
  ['soul', 'set', '--help'],
  ['doctor', '--help'],
  ['commit', 'add', '--help'],
  ['commit', 'edit', '--help'],
  ['kb', 'add', '--help'],
  ['kb', 'page', 'ls', '--help'],
  ['mail', 'account', 'add', '--help'],
  ['mail', 'sync', '--help'],
  ['client', 'show', '--help'],
  ['client', 'note', 'add', '--help'],
  ['project', 'show', '--help'],
  ['receivable', 'add', '--help'],
  ['receivable', 'export', '--help'],
  ['payment', 'add', '--help'],
  ['inbox', 'ls', '--help'],
  ['profile', 'export', '--help'],
  ['remind', 'install', '--help'],
  ['template', 'quote', '--help'],
  ['tos', 'show', '--help'],
  ['sync', 'pull', '--help'],
  ['backups', 'verify', '--help'],
  ['evidence', 'verify', '--help'],
  ['nonsense-command', '--help'],
]

test('every command/subcommand --help is a pure exit-0 usage request', () => {
  const home = makeHome()
  try {
    for (const args of HELP_MATRIX) {
      const result = run(home, args)
      assert.equal(result.status, 0, args.join(' ') + ' must exit 0 (stderr: ' + result.stderr + ')')
      assert.match(result.stdout, /^usage: advisers /m, args.join(' ') + ' must print a usage line')
      assert.equal(result.stderr, '', args.join(' ') + ' must not write stderr')
      assert.ok(result.elapsedMs < 5000, args.join(' ') + ' must not block (' + result.elapsedMs + 'ms)')
    }
    assert.deepEqual(readdirSync(home), [], 'help requests must not create files in HOME')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('top-level --help / -h keep the general help and create no home', () => {
  const home = makeHome()
  try {
    for (const flag of ['--help', '-h']) {
      const result = run(home, [flag])
      assert.equal(result.status, 0)
      assert.match(result.stdout, /advisers — a staff of AI advisers/)
      assert.match(result.stdout, /Usage:/)
    }
    assert.deepEqual(readdirSync(home), [])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('init --help writes no soul.md and purge --help does not read a matter id', () => {
  const home = makeHome()
  try {
    assert.equal(run(home, ['init', '--help']).status, 0)
    assert.deepEqual(readdirSync(home), [], 'init --help must not initialise HOME')
    const purge = run(home, ['purge', '--help'])
    assert.equal(purge.status, 0)
    assert.match(purge.stdout, /usage: advisers purge <matter-id>/)
    assert.doesNotMatch(purge.stderr, /E_USAGE|unknown matter/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('the help short-circuit works before TOS acceptance', () => {
  const home = makeHome()
  try {
    const result = spawnSync(process.execPath, [bin, 'commit', 'add', '--help'], {
      env: { ...process.env, ADVISERS_HOME: home, ADVISERS_NO_MODEL: '1' },
      encoding: 'utf8', input: '', timeout: 60000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /usage: advisers commit add/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})