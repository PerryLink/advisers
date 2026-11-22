/**
 * 0.4.2 follow-up: subcommand --help must be a pure help request.
 * Before this fix kb add --help / mail account add --help failed with E_USAGE,
 * client show --help was blocked by the TOS gate, and doctor --help was rejected
 * by the strict flag parser.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function run(args) {
  const home = mkdtempSync(join(tmpdir(), 'advisers-help-'))
  try {
    return spawnSync(process.execPath, [bin, ...args], {
      env: { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1' },
      encoding: 'utf8', input: '', timeout: 60000,
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
}

test('subcommand --help prints the command usage without TOS/HOME setup', () => {
  for (const [args, pattern] of [
    [['kb', 'add', '--help'], /usage: advisers kb add/],
    [['mail', 'account', 'add', '--help'], /mail account add\|ls\|show\|test\|rm/],
    [['client', 'show', '--help'], /usage: advisers client show/],
    [['project', 'show', '--help'], /usage: advisers project show/],
    [['doctor', '--help'], /usage: advisers doctor/],
  ]) {
    const result = run(args)
    assert.equal(result.status, 0, args.join(' ') + ' failed: ' + result.stderr)
    assert.match(result.stdout + result.stderr, pattern)
  }
})

test('top-level --help still works without TOS', () => {
  const result = run(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /advisers/)
})
