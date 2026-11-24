/**
 * 0.4.3 (043-1, plan 92 §5): `mail sync --watch` JSON / exit-code contract.
 *
 * Locks the three 0.4.2 defects fixed in 0.4.3:
 *  - `--json` stdout used to contain human round lines (not a single document);
 *  - an all-failed `--max-runs 1` used to exit 0 (scripts could not tell);
 *  - SIGINT and SIGTERM shared one handler and both produced 130.
 * Also covers `--once` / `--json-lines` and the immediate empty-account check.
 * Every test uses a mktemp ADVISERS_HOME and a refused 127.0.0.1:1 account:
 * zero network reachability, no real HOME, no credentials.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_ACCEPT_TOS: '1', ADVISERS_NO_MODEL: '1', ADVISERS_CORE_LOCAL: '1' }

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'advisers-043-watch-'))
}

function envFor(home) {
  return { ...process.env, ...BASE_ENV, ADVISERS_HOME: home }
}

function run(home, args, input = '') {
  return spawnSync(process.execPath, [bin, ...args], { env: envFor(home), encoding: 'utf8', input, timeout: 120000 })
}

function addRefusedAccount(home) {
  const result = run(home, ['mail', 'account', 'add', '--name', 'refused', '--host', '127.0.0.1', '--port', '1', '--tls', 'tls', '--user', 'u', '--pass-stdin'], 'pw\n')
  assert.equal(result.status, 0, 'account fixture failed: ' + result.stderr)
}

function spawnWatch(home, args) {
  const child = spawn(process.execPath, [bin, ...args], { env: envFor(home), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr })))
  return { child, exited, output: () => ({ stdout, stderr }) }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

test('watch --json on an empty home fails immediately with E_MAIL_CONFIG (no empty round)', () => {
  const home = makeHome()
  try {
    const result = run(home, ['mail', 'sync', '--watch', '--max-runs', '1', '--json'])
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '', 'stdout must stay empty on a pre-flight failure')
    const error = JSON.parse(result.stderr.trim())
    assert.equal(error.error.code, 'E_MAIL_CONFIG')
    assert.equal(error.error.hint, 'add one with advisers mail account add')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('--once --json prints exactly one JSON document and exits 1 when the round fails', () => {
  const home = makeHome()
  try {
    addRefusedAccount(home)
    const result = run(home, ['mail', 'sync', '--once', '--json'])
    assert.equal(result.status, 1, 'all rounds failed must exit 1')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.runs, 1)
    assert.equal(summary.success, 0)
    assert.equal(summary.errors, 1)
    assert.equal(summary.stopped, 'max-runs')
    assert.equal(summary.interruptedBy, null)
    assert.equal(summary.maxRuns, 1)
    assert.match(result.stderr, /round 1 failed:/, 'round lines go to stderr in --json mode')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('--json-lines emits one parseable JSON document per round and a summary last', () => {
  const home = makeHome()
  try {
    addRefusedAccount(home)
    const result = run(home, ['mail', 'sync', '--once', '--json-lines'])
    assert.equal(result.status, 1)
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].type, 'round')
    assert.equal(lines[0].run, 1)
    assert.equal(lines[0].ok, false)
    assert.ok(Array.isArray(lines[0].perAccount))
    assert.equal(typeof lines[0].error, 'string')
    assert.equal(lines[1].type, 'summary')
    assert.equal(lines[1].runs, 1)
    assert.equal(lines[1].interruptedBy, null)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('human watch prints a startup line, stderr round lines and one final line', () => {
  const home = makeHome()
  try {
    addRefusedAccount(home)
    const result = run(home, ['mail', 'sync', '--once'])
    assert.equal(result.status, 1)
    assert.match(result.stdout, /^watch: interval=300s mailbox=INBOX/)
    assert.match(result.stdout, /mail watch stopped: max-runs runs=1 success=0 errors=1/)
    assert.match(result.stderr, /第 1 轮失败：E_IMAP_/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('invalid loop/output combinations are E_USAGE before any round', () => {
  const home = makeHome()
  try {
    for (const args of [
      ['mail', 'sync', '--watch', '--once'],
      ['mail', 'sync', '--watch', '--json', '--json-lines'],
      ['mail', 'sync', '--json-lines'],
      ['mail', 'sync', '--once', '--interval', '1s'],
      ['mail', 'sync', '--interval', '1s'],
    ]) {
      const result = run(home, args)
      assert.equal(result.status, 1, args.join(' ') + ' should be E_USAGE')
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /E_USAGE/)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('SIGINT exits 130 and reports interruptedBy=SIGINT in the JSON summary', { skip: process.platform === 'win32' ? 'Windows does not deliver POSIX SIGINT to a child the same way; the Linux CI covers it' : false }, async () => {
  const home = makeHome()
  try {
    addRefusedAccount(home)
    const watched = spawnWatch(home, ['mail', 'sync', '--watch', '--json'])
    await sleep(3000)
    watched.child.kill('SIGINT')
    const result = await watched.exited
    assert.equal(result.code, 130)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.interruptedBy, 'SIGINT')
    assert.equal(summary.stopped, 'aborted')
    assert.ok(summary.runs >= 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('SIGTERM exits 143 (not 130) and reports interruptedBy=SIGTERM', { skip: process.platform === 'win32' ? 'Windows has no POSIX SIGTERM child semantics; the Linux CI covers it' : false }, async () => {
  const home = makeHome()
  try {
    addRefusedAccount(home)
    const watched = spawnWatch(home, ['mail', 'sync', '--watch', '--json'])
    await sleep(3000)
    watched.child.kill('SIGTERM')
    const result = await watched.exited
    assert.equal(result.code, 143)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.interruptedBy, 'SIGTERM')
    assert.equal(summary.stopped, 'aborted')
  } finally { rmSync(home, { recursive: true, force: true }) }
})