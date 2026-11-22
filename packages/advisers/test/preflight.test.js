/**
 * 0.5.0 (WF5 050-U2a): lib/preflight.js is the read-only environment probe used
 * by `advisers setup --dry-run`. It must never create HOME, state.db, WAL files
 * or a writer lock — that is exactly why setup does not reuse doctor (doctor
 * calls ensureHome). The checks are informational: a failed check still lets the
 * wizard continue, so every failure also carries a copy-pasteable hint.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  MINIMUM_NODE,
  PREFLIGHT_CHECK_IDS,
  defaultHomePath,
  preflightLines,
  runPreflight,
} from '../lib/preflight.js'

const ANSI = /\u001b\[/
const BASE_ENV = { ...process.env, ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1' }

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'advisers-preflight-'))
}

test('preflight reports the four stable checks and passes on a healthy machine', () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    const result = runPreflight({ home, env: BASE_ENV })
    assert.deepEqual(result.checks.map((check) => check.id), [...PREFLIGHT_CHECK_IDS])
    assert.equal(result.ok, true, JSON.stringify(result.checks))
    assert.equal(result.home, home)
    assert.equal(result.checks.find((check) => check.id === 'node').ok, true)
    assert.equal(result.checks.find((check) => check.id === 'sqlite').ok, true)
    assert.equal(result.checks.find((check) => check.id === 'office').ok, true)
    assert.equal(result.checks.find((check) => check.id === 'home').ok, true)
    for (const check of result.checks) {
      assert.equal(typeof check.detail, 'string')
      assert.ok(check.detail.length > 0, check.id + ' must carry a detail')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a dry-run preflight creates nothing (no HOME, no state.db, no WAL, no lock)', () => {
  const root = makeRoot()
  try {
    const home = join(root, 'not-created', 'nested-home')
    const result = runPreflight({ home, env: BASE_ENV })
    assert.equal(result.checks.find((check) => check.id === 'home').ok, true)
    assert.equal(existsSync(home), false, 'preflight must not create HOME')
    assert.equal(existsSync(join(home, 'state.db')), false)
    assert.equal(existsSync(join(home, 'instance.lock')), false)
    assert.deepEqual(readdirSync(root), [], 'the whole temp root must stay empty')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an existing HOME directory is probed read-only', () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const result = runPreflight({ home, env: BASE_ENV })
    const homeCheck = result.checks.find((check) => check.id === 'home')
    assert.equal(homeCheck.ok, true, homeCheck.hint ?? '')
    assert.equal(homeCheck.detail, home)
    assert.deepEqual(readdirSync(home), [], 'preflight must not write into HOME')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file at ADVISERS_HOME fails closed with a hint', () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home-file')
    writeFileSync(home, 'not a directory')
    const result = runPreflight({ home, env: BASE_ENV })
    const homeCheck = result.checks.find((check) => check.id === 'home')
    assert.equal(homeCheck.ok, false)
    assert.match(homeCheck.hint, /目录|directory/)
    assert.equal(result.ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Node version floor is 22.16 (node:sqlite) and accepts 24/23', () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    assert.deepEqual(MINIMUM_NODE, { major: 22, minor: 16 })
    for (const version of ['v22.16.0', 'v22.17.1', 'v24.0.0', 'v23.5.0']) {
      const check = runPreflight({ home, env: BASE_ENV, nodeVersion: version }).checks.find((entry) => entry.id === 'node')
      assert.equal(check.ok, true, version + ' must pass')
    }
    for (const version of ['v22.15.9', 'v20.11.0', 'v18.20.0', 'nonsense']) {
      const check = runPreflight({ home, env: BASE_ENV, nodeVersion: version }).checks.find((entry) => entry.id === 'node')
      assert.equal(check.ok, false, version + ' must fail')
      assert.ok(check.hint.length > 0)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('human lines stay short, plain and include hints for failures', () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    const okResult = runPreflight({ home, env: BASE_ENV })
    const lines = preflightLines(okResult)
    assert.ok(lines.length >= 5 && lines.length <= 6, 'header + 4 checks (+hints): ' + lines.length)
    assert.match(lines[0], /环境检查/)
    for (const line of lines) {
      assert.doesNotMatch(line, ANSI)
      assert.ok(!line.includes('\uFFFD'))
    }
    const failed = runPreflight({ home, env: BASE_ENV, nodeVersion: 'v20.1.0' })
    const failedLines = preflightLines(failed)
    assert.ok(failedLines.some((line) => /FAIL/.test(line)))
    assert.ok(failedLines.some((line) => /hint:/.test(line)))
    assert.ok(failedLines.length <= 7)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('defaultHomePath follows ADVISERS_HOME else ~/.advisers', () => {
  assert.equal(defaultHomePath({ ADVISERS_HOME: '/tmp/custom-home' }), '/tmp/custom-home')
  assert.ok(defaultHomePath({}).endsWith('.advisers'))
})
