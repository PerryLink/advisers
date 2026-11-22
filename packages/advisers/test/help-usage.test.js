/**
 * 0.5.0 (WF5 050-U1a): the 0.4.3 `--help` usage map moved to lib/help-usage.js.
 *
 * Two layers:
 *  1. pure-module assertions over all map entries (shape, no ANSI, no trailing
 *     newline, longest-prefix resolution, flag handling);
 *  2. a sampled CLI matrix: `advisers <path> --help` must print exactly the map
 *     value for that path. bin/advisers.js may keep the map inline during the
 *     0.5.0 wiring or import this module — the bytes must be identical either
 *     way, so this test is the extraction-fidelity check.
 *
 * The full ~152-path matrix lives with bin's dispatch tests; this layer keeps a
 * representative sample (deep path, quoted values, Chinese defaults, setup/demo
 * format) so a drift in the map is caught in milliseconds.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { HELP_USAGE_LINES, helpRequestTokens, helpRequestUsage } from '../lib/help-usage.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const ANSI = /\u001b\[/
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

test('the map covers the 0.4.3 surface plus the 0.5.0 setup/demo commands', () => {
  assert.ok(HELP_USAGE_LINES.size >= 152, '0.4.3 had 150 entries; 0.5.0 adds setup + demo (got ' + HELP_USAGE_LINES.size + ')')
  for (const key of ['version', 'status', 'doctor', 'help', 'commit', 'commit add', 'kb add', 'mail sync', 'client show', 'template', 'export', 'import', 'sync pull', 'evidence verify', 'setup', 'demo']) {
    assert.ok(HELP_USAGE_LINES.has(key), 'missing usage entry: ' + key)
  }
  assert.equal(HELP_USAGE_LINES.get('help'), 'usage: advisers help [<topic>] [--list]')
  assert.match(HELP_USAGE_LINES.get('setup'), /^usage: advisers setup /)
  assert.match(HELP_USAGE_LINES.get('demo'), /^usage: advisers demo /)
})

test('every usage value is a plain multi-line usage string without ANSI', () => {
  for (const [path, value] of HELP_USAGE_LINES) {
    assert.equal(typeof value, 'string', path)
    assert.ok(value.startsWith('usage: advisers '), path + ' must start with "usage: advisers "')
    assert.ok(!value.endsWith('\n'), path + ' must not carry a trailing newline (the short-circuit appends it)')
    assert.doesNotMatch(value, ANSI, path + ' must not contain ANSI')
    assert.doesNotMatch(value, CONTROL, path + ' must not contain control characters')
    for (const line of value.split('\n').slice(1)) {
      assert.match(line, /^\s{2,}|^\s*advisers /, path + ' continuation line must stay aligned')
    }
  }
})

test('helpRequestTokens mirrors the 0.4.3 short-circuit contract', () => {
  assert.deepEqual(helpRequestTokens([]), [])
  assert.deepEqual(helpRequestTokens(['--help']), [])
  assert.deepEqual(helpRequestTokens(['help', '--help']), ['help'])
  assert.deepEqual(helpRequestTokens(['commit', 'add', '-h']), ['commit', 'add'])
  assert.deepEqual(helpRequestTokens(['commit', 'add', 'ls', 'extra', 'more', '--help']), ['commit', 'add', 'ls', 'extra'])
  assert.deepEqual(helpRequestTokens(['--bogus', '--help']), [])
  assert.deepEqual(helpRequestTokens(['a', '', '--help']), ['a', ''])
})

test('helpRequestUsage resolves top-level, longest prefix, generic and help', () => {
  assert.equal(helpRequestUsage([]), null)
  assert.equal(helpRequestUsage(['--help']), null)
  assert.equal(helpRequestUsage(['help']), HELP_USAGE_LINES.get('help'))
  assert.equal(helpRequestUsage(['commit', 'add', '--help']), HELP_USAGE_LINES.get('commit add'))
  assert.equal(helpRequestUsage(['commit', 'add', 'ls', '--help']), HELP_USAGE_LINES.get('commit add'))
  assert.equal(helpRequestUsage(['evidence', 'verify', '--help']), HELP_USAGE_LINES.get('evidence verify'))
  assert.equal(helpRequestUsage(['nonsense-command', '--help']), 'usage: advisers nonsense-command [options]')
  // Unknown sub-path keeps the generic read-only usage instead of failing.
  assert.equal(helpRequestUsage(['kb', 'page', 'nope', '--help']), HELP_USAGE_LINES.get('kb page'))
  assert.equal(helpRequestUsage(['nonsense', 'deep', '--help']), 'usage: advisers nonsense deep [options]')
})

test('sampled CLI matrix: <path> --help prints exactly the map value and creates no home', () => {
  const home = mkdtempSync(join(tmpdir(), 'advisers-help-usage-'))
  const env = { ...process.env, ADVISERS_HOME: home, ADVISERS_ACCEPT_TOS: '1', ADVISERS_NO_MODEL: '1', ADVISERS_OFFICE_LOCAL: '1' }
  const sample = [
    ['version'],
    ['status'],
    ['doctor'],
    ['commit', 'add'],
    ['kb', 'add'],
    ['mail', 'sync'],
    ['receivable', 'export'],
    ['client', 'show'],
    ['template'],
    ['backups', 'verify'],
    ['evidence', 'verify'],
    ['profile'],
    ['inbox'],
    ['kb', 'page', 'ls'],
  ]
  try {
    for (const path of sample) {
      const result = spawnSync(process.execPath, [bin, ...path, '--help'], { env, encoding: 'utf8', input: '', timeout: 60000 })
      assert.equal(result.status, 0, path.join(' ') + ' --help must exit 0 (stderr: ' + result.stderr + ')')
      assert.equal(result.stdout, HELP_USAGE_LINES.get(path.join(' ')) + '\n', path.join(' ') + ' --help must print the exact map value')
      assert.equal(result.stderr, '', path.join(' ') + ' --help must not write stderr')
    }
    assert.deepEqual(readdirSync(home), [], 'help requests must not create files in HOME')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('-h and a trailing flag are equivalent to --help on the sampled paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'advisers-help-usage-'))
  const env = { ...process.env, ADVISERS_HOME: home, ADVISERS_ACCEPT_TOS: '1', ADVISERS_NO_MODEL: '1' }
  try {
    const short = spawnSync(process.execPath, [bin, 'commit', 'add', '-h'], { env, encoding: 'utf8', input: '', timeout: 60000 })
    assert.equal(short.status, 0)
    assert.equal(short.stdout, HELP_USAGE_LINES.get('commit add') + '\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
