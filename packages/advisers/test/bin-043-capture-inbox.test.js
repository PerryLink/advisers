/**
 * 0.4.3 (043-2, plan 92 §2): keyless capture (`--file -` / `--rules`) and the
 * read-only `inbox ls/show` surface.
 *
 * 0.4.2 `capture` required ADVISERS_API_KEY and treated `--file -` as a path.
 * 0.4.3: stdin + deterministic local rules produce pending candidates with no
 * key and no network, and `inbox` is a pure read over those candidates.
 * Every home is a mktemp ADVISERS_HOME; the only model URL is a refused
 * 127.0.0.1:1 so a model attempt would fail the test.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_ACCEPT_TOS: '1', ADVISERS_NO_MODEL: '1', ADVISERS_CORE_LOCAL: '1' }
const CAPTURE_TEXT = '我下周三前把报价发给王工。'

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'advisers-043-capture-'))
}

function run(home, args, { input = '', env = {} } = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home, ...env },
    encoding: 'utf8', input, timeout: 60000,
  })
}

function json(result) {
  return JSON.parse(result.stdout)
}

function captureStdin(home, text = CAPTURE_TEXT, extra = []) {
  return run(home, ['capture', '--file', '-', '--json', ...extra], { input: text })
}

test('keyless capture --file - produces pending candidates and says so on stderr', () => {
  const home = makeHome()
  try {
    const result = captureStdin(home)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /\[local\] 未配置模型：本地规则生成候选，未出网/)
    const payload = json(result)
    assert.equal(payload.ok, true)
    assert.equal(payload.command, 'capture')
    assert.equal(payload.source, 'stdin')
    assert.equal(payload.count, 1)
    assert.equal(payload.candidates[0].status, 'pending')
    assert.equal(payload.candidates[0].kind, 'commitment')
    assert.ok(payload.candidates[0].payload.extractor === 'local')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('stdin normalises BOM/CRLF before the local rules see the text', () => {
  const home = makeHome()
  try {
    const result = captureStdin(home, '\uFEFF' + CAPTURE_TEXT + '\r\n其次我周五前交周报。\r\n')
    assert.equal(result.status, 0, result.stderr)
    const payload = json(result)
    assert.equal(payload.count, 1)
    for (const candidate of payload.candidates) {
      for (const evidence of candidate.evidence ?? []) {
        assert.doesNotMatch(evidence.quote, /\r|\uFEFF/, 'quote is normalised')
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('empty stdin and oversized input are the registered capture errors', () => {
  const home = makeHome()
  try {
    const empty = run(home, ['capture', '--file', '-'], { input: '  \r\n ' })
    assert.equal(empty.status, 1)
    assert.match(empty.stderr, /E_CAPTURE_EMPTY/)
    const oversized = captureStdin(home, '我'.repeat(20001))
    assert.equal(oversized.status, 1)
    assert.match(oversized.stderr, /E_CAPTURE_TOO_LONG/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('--rules forces the local path even with an API key (zero network)', () => {
  const home = makeHome()
  try {
    const result = captureStdin(home, CAPTURE_TEXT, ['--rules'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(json(result).count, 1)
    assert.doesNotMatch(result.stderr, /ADVISERS_API_KEY/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('--model without a key keeps the 0.4.2 error', () => {
  const home = makeHome()
  try {
    const result = captureStdin(home, CAPTURE_TEXT, ['--model'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /capture requires ADVISERS_API_KEY/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('inbox ls/show are read-only projections of the captured candidate', () => {
  const home = makeHome()
  try {
    assert.equal(captureStdin(home).status, 0)
    const listed = run(home, ['inbox', 'ls', '--json'])
    assert.equal(listed.status, 0, listed.stderr)
    const payload = json(listed)
    assert.equal(payload.ok, true)
    assert.equal(payload.command, 'inbox ls')
    assert.equal(payload.total, 1)
    assert.equal(payload.items.length, 1)
    const item = payload.items[0]
    for (const key of ['id', 'kind', 'source', 'extractor', 'action', 'quote', 'dueAt', 'dueBasis', 'dueAmbiguous', 'clientHint', 'projectHint', 'matterId', 'createdAt']) {
      assert.ok(key in item, 'inbox item has ' + key)
    }
    assert.equal(item.source, 'capture')
    const shown = run(home, ['inbox', 'show', item.id, '--json'])
    assert.equal(shown.status, 0, shown.stderr)
    const detail = json(shown)
    assert.equal(detail.ok, true)
    assert.equal(detail.candidate.id, item.id)
    assert.equal(detail.candidate.status, 'pending')
    assert.ok(Array.isArray(detail.candidate.evidence))
    // The read surface must not accept the candidate: it is still pending after
    // both reads, and the ledger gained no commitment.
    assert.equal(json(run(home, ['inbox', 'ls', '--json'])).items[0].status, undefined)
    assert.equal(json(run(home, ['commit', 'ls', '--json'])).length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('inbox show missing id is E_CANDIDATE_NOT_FOUND with empty stdout', () => {
  const home = makeHome()
  try {
    const result = run(home, ['inbox', 'show', 'cand_missing', '--json'])
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr.trim())
    assert.equal(error.error.code, 'E_CANDIDATE_NOT_FOUND')
    assert.equal(error.error.hint, 'advisers inbox ls')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('inbox human output carries the read-only next commands', () => {
  const home = makeHome()
  try {
    assert.equal(captureStdin(home).status, 0)
    const result = run(home, ['inbox', 'ls'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /advisers memory accept cand_/)
    assert.match(result.stdout, /\| reject cand_\w+ --reason <not-commitment\|request-only\|/)
    assert.match(result.stdout, /total=1 /)
  } finally { rmSync(home, { recursive: true, force: true }) }
})