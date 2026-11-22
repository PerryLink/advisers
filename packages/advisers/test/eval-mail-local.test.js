import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const RUNNER = join(REPO_ROOT, 'eval', 'run-mail-local-gold.mjs')
const GOLD_DIR = join(REPO_ROOT, 'eval', 'mail-local-gold')
const GATED_METRICS = ['precision', 'recall', 'f1', 'dueAccuracy', 'authorAccuracy']
const KNOWN_LIMITATION_FILES = [
  '09-en-relative-friday.eml',
  '19-zh-implied-subject.eml',
  '20-en-month-date.eml',
  '30-neg-marketing-we.eml',
]

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-mail-gold-test-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return {
    root,
    home,
    cleanup() {
      // Only ever remove the mkdtemp directory this test created.
      if (!root.startsWith(tmpdir())) throw new Error('refusing to remove a path outside the temp dir: ' + root)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function runnerEnv(home) {
  const env = { ...process.env, ADVISERS_HOME: home, ADVISERS_ACCEPT_TOS: '1' }
  delete env.ADVISERS_API_KEY
  delete env.DEEPSEEK_API_KEY
  delete env.ADVISERS_MODEL
  return env
}

function runRunner(args, home) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    env: runnerEnv(home),
    encoding: 'utf8',
    timeout: 120_000,
  })
}

function parseStdout(run) {
  try {
    return JSON.parse(run.stdout)
  } catch {
    throw new Error('runner stdout is not JSON (status ' + run.status + '): ' + run.stdout.slice(0, 400) + ' stderr: ' + run.stderr.slice(0, 400))
  }
}

function writeFixture(dir, name, body, from, date) {
  const content = [
    'From: ' + from,
    'To: me@example.com',
    'Subject: gold test fixture',
    'Date: ' + date,
    'Message-ID: <' + name.replace('.eml', '') + '@test.example>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
    '',
  ].join('\r\n')
  writeFileSync(join(dir, name), content)
}

test('gold eval passes with the documented result shape and thresholds', () => {
  const box = sandbox()
  try {
    const run = runRunner(['--json'], box.home)
    assert.equal(run.status, 0, run.stderr)
    const result = parseStdout(run)

    assert.equal(result.suite, 'mail-local-gold')
    assert.equal(result.schema, 'advisers.mail-local-gold/v1')
    assert.equal(result.mode, 'local-rules')
    assert.equal(result.deterministic, true)
    assert.equal(result.model.enabled, false)
    assert.equal(result.model.calls, 0)
    assert.equal(result.network.guarded, true)
    assert.equal(result.network.attempts, 0)
    assert.equal(result.passed, true)
    assert.deepEqual(result.thresholdFailures, [])
    assert.deepEqual(result.errors, [])

    // Gold-set size contract: 20-30 .eml fixtures, all labeled, none dangling.
    assert.ok(result.gold.fixtures >= 20 && result.gold.fixtures <= 30, 'fixtures=' + result.gold.fixtures)
    assert.equal(result.gold.fixtures, result.cases.length)
    assert.ok(result.gold.expectedCandidates >= 1)
    assert.ok(result.gold.positiveMessages >= 1)
    assert.ok(result.gold.negativeMessages >= 1)
    const onDisk = readdirSync(GOLD_DIR).filter((file) => file.endsWith('.eml')).sort()
    assert.deepEqual(result.cases.map((row) => row.file).sort(), onDisk)
    for (const row of result.cases) {
      assert.ok(row.file.endsWith('.eml'), row.file)
      assert.equal(typeof row.author, 'string')
      assert.ok(row.author.length > 0, row.file + ' author')
      assert.ok(Array.isArray(row.expected), row.file + ' expected')
      assert.ok(Array.isArray(row.predicted), row.file + ' predicted')
      assert.ok(Array.isArray(row.missing) && Array.isArray(row.extra), row.file + ' issues')
      assert.equal(typeof row.matched, 'number')
      assert.ok(Array.isArray(row.dueMismatches) && Array.isArray(row.authorMismatches) && Array.isArray(row.amountMismatches))
    }

    // Every gated metric is a number in [0, 1] that meets its own threshold.
    for (const metric of GATED_METRICS) {
      const value = result.metrics[metric]
      assert.equal(typeof value, 'number', metric)
      assert.ok(value >= 0 && value <= 1, metric + '=' + value)
      assert.ok(value >= result.thresholds[metric], metric + ' failed its own threshold')
    }
    const precision = result.metrics.precision
    const recall = result.metrics.recall
    const expectedF1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
    assert.ok(Math.abs(result.metrics.f1 - expectedF1) < 0.0002, 'f1=' + result.metrics.f1 + ' expected=' + expectedF1)
    assert.ok(result.metrics.dueAccuracy >= result.thresholds.dueAccuracy)
    assert.ok(result.metrics.authorAccuracy >= result.thresholds.authorAccuracy)

    // Known limitations are labeled as such rather than hidden.
    for (const file of KNOWN_LIMITATION_FILES) {
      const row = result.cases.find((entry) => entry.file === file)
      assert.ok(row, 'missing known-limitation fixture ' + file)
      assert.match(row.note || '', /^Known/, file + ' must document its known limitation')
    }

    // Zero side effects: the runner never writes ADVISERS_HOME / a database.
    assert.deepEqual(readdirSync(box.home), [])

    const listed = runRunner(['--list'], box.home)
    assert.equal(listed.status, 0, listed.stderr)
    assert.equal(listed.stdout.trim().split('\n').length, result.gold.fixtures)
  } finally {
    box.cleanup()
  }
})

test('gold eval is deterministic across runs', () => {
  const box = sandbox()
  try {
    const first = runRunner(['--json'], box.home)
    const second = runRunner(['--json'], box.home)
    assert.equal(first.status, 0, first.stderr)
    assert.equal(second.status, 0, second.stderr)
    const left = parseStdout(first)
    const right = parseStdout(second)
    assert.deepEqual(left.metrics, right.metrics)
    assert.deepEqual(left.counts, right.counts)
    assert.deepEqual(left.cases, right.cases)
    assert.deepEqual(readdirSync(box.home), [])
  } finally {
    box.cleanup()
  }
})

test('human report is readable and exit code 0', () => {
  const box = sandbox()
  try {
    const run = runRunner([], box.home)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stderr, '')
    assert.match(run.stdout, /advisers eval:mail-local/)
    assert.match(run.stdout, /candidate precision/)
    assert.match(run.stdout, /candidate recall/)
    assert.match(run.stdout, /due accuracy/)
    assert.match(run.stdout, /PASS - all gated metrics meet their thresholds\./)
    assert.match(run.stdout, /model calls 0; network attempts 0/)
  } finally {
    box.cleanup()
  }
})

test('a metric below its threshold exits 1 and reports the regression', () => {
  const box = sandbox()
  try {
    const fixtures = join(box.root, 'threshold-gold')
    mkdirSync(fixtures, { recursive: true })
    writeFixture(fixtures, '01-threshold-ok.eml', '我周五前把报价发给你。', '王工 <wang@example.cn>', 'Fri, 20 Nov 2026 09:00:00 +0800')
    writeFixture(fixtures, '02-threshold-miss.eml', '请周五前把报价单发给我。', '陈工 <chen@example.cn>', 'Mon, 16 Nov 2026 09:00:00 +0800')
    const labels = {
      schema: 'advisers.mail-local-gold/v1',
      timeZone: 'Asia/Shanghai',
      cases: [
        { file: '01-threshold-ok.eml', author: '王工', expect: [{ action: '发报价', dueAt: '2026-11-20' }] },
        { file: '02-threshold-miss.eml', author: '陈工', expect: [{ action: '发报价单', dueAt: '2026-11-20' }] },
      ],
    }
    writeFileSync(join(fixtures, 'labels.json'), JSON.stringify(labels, null, 2) + '\n')

    const run = runRunner(['--json', '--fixtures', fixtures], box.home)
    assert.equal(run.status, 1)
    const result = parseStdout(run)
    assert.equal(result.passed, false)
    assert.deepEqual(result.errors, [])
    assert.ok(result.thresholdFailures.some((failure) => failure.metric === 'recall'), JSON.stringify(result.thresholdFailures))
    assert.ok(result.metrics.recall < result.thresholds.recall)
  } finally {
    box.cleanup()
  }
})

test('invalid gold set fails closed and unknown arguments are usage errors', () => {
  const box = sandbox()
  try {
    const fixtures = join(box.root, 'invalid-gold')
    mkdirSync(fixtures, { recursive: true })
    const labels = {
      schema: 'advisers.mail-local-gold/v1',
      timeZone: 'Asia/Shanghai',
      cases: [{ file: '01-missing.eml', author: '王工', expect: [] }],
    }
    writeFileSync(join(fixtures, 'labels.json'), JSON.stringify(labels, null, 2) + '\n')

    const invalid = runRunner(['--json', '--fixtures', fixtures], box.home)
    assert.equal(invalid.status, 1)
    const result = parseStdout(invalid)
    assert.equal(result.passed, false)
    assert.ok(result.errors.some((error) => error.includes('missing fixture')), JSON.stringify(result.errors))

    const usage = spawnSync(process.execPath, [RUNNER, '--bogus'], {
      cwd: REPO_ROOT,
      env: runnerEnv(box.home),
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(usage.status, 2)
    assert.match(usage.stderr, /unknown argument/)
  } finally {
    box.cleanup()
  }
})
