import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const RUNNER = join(REPO_ROOT, 'eval', 'run-mail-local-gold.mjs')
const GOLD_DIR = join(REPO_ROOT, 'eval', 'mail-local-gold')
const GATED_DEV = ['precision', 'recall', 'f1', 'dueAccuracy', 'authorAccuracy', 'negativeFalsePositiveRate']
const GATED_HELDOUT = ['precision', 'recall', 'f1', 'dueAccuracy', 'negativeFalsePositiveRate']
const KNOWN_LIMITATION_FILES = ['09-en-relative-friday.eml', '19-zh-implied-subject.eml', '20-en-month-date.eml', '30-neg-marketing-we.eml']
const SHA256_RE = /^[0-9a-f]{64}$/

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
  return spawnSync(process.execPath, [RUNNER, '--no-write', ...args], {
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

test('dev split: schema-v2 report, 90 fixtures, frozen corpus, all gates green', () => {
  const box = sandbox()
  try {
    const run = runRunner(['--split', 'dev', '--json'], box.home)
    assert.equal(run.status, 0, run.stderr)
    const report = parseStdout(run)

    // Schema-v2 quality report contract shared with eval:det / model-contract.
    assert.equal(report.schemaVersion, 2)
    assert.equal(report.suite, 'mail-local-gold')
    assert.equal(report.mode, 'local-gold')
    assert.equal(report.corpus.id, 'mail-local-gold')
    assert.equal(report.corpus.split, 'dev')
    assert.match(report.corpus.sha256, SHA256_RE)
    assert.equal(report.corpus.rows, 120)
    assert.equal(report.fixtures.count, 90)
    assert.match(report.fixtures.sha256, SHA256_RE)
    assert.equal(report.network.guarded, true)
    assert.equal(report.network.attempts, 0)
    assert.deepEqual(report.failures, [])
    assert.deepEqual(report.unknowns.filter((entry) => ['modelQuality', 'humanGold', 'liveModelQuality'].includes(entry.id)).map((entry) => entry.value), [null, null, null])
    assert.equal(report.totals.failed, 0)
    assert.equal(report.totals.checksFailed, 0)

    // Gold-set size contract: 90 dev fixtures, every case labeled, none dangling.
    assert.equal(report.metrics.n, 90)
    assert.equal(report.metrics.gold.fixtures, 90)
    assert.ok(report.metrics.gold.positiveMessages >= 1)
    assert.ok(report.metrics.gold.negativeMessages >= 1)
    assert.equal(report.cases.length, 90)
    assert.ok(report.cases.every((row) => row.split === 'dev'))
    const onDisk = readdirSync(GOLD_DIR).filter((file) => file.endsWith('.eml'))
    assert.equal(onDisk.length, 120)
    const devFiles = onDisk.filter((file) => Number(file.slice(0, file.indexOf('-'))) <= 90)
    assert.equal(devFiles.length, 90)
    assert.deepEqual(report.cases.map((row) => row.file).sort(), devFiles.sort())

    // Every gated metric passes and both metric families are present.
    const gateIds = report.gates.map((entry) => entry.id)
    for (const metric of GATED_DEV) assert.ok(gateIds.includes('mail.' + metric), metric)
    assert.ok(gateIds.includes('mail.gold_valid'))
    assert.ok(report.gates.every((entry) => entry.pass === true), JSON.stringify(report.gates))
    const precision = report.metrics.precision
    const recall = report.metrics.recall
    const expectedF1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
    assert.ok(Math.abs(report.metrics.f1 - expectedF1) < 0.001)
    assert.ok(report.metrics.precision >= 0.9)
    assert.ok(report.metrics.recall >= 0.85)
    assert.ok(report.metrics.dueAccuracy >= 0.85)
    assert.ok(report.metrics.authorAccuracy >= 0.9)
    assert.ok(report.metrics.negativeFalsePositiveRate <= 0.1)
    assert.ok(report.metrics.ci95.precision.high <= 1)

    // Known limitations stay labeled as such rather than hidden.
    for (const file of KNOWN_LIMITATION_FILES) {
      const row = report.cases.find((entry) => entry.file === file)
      assert.ok(row, 'missing known-limitation fixture ' + file)
      assert.match(row.note || '', /^Known/, file + ' must document its known limitation')
    }

    // Zero side effects: the runner never writes ADVISERS_HOME.
    assert.deepEqual(readdirSync(box.home), [])
  } finally {
    box.cleanup()
  }
})

test('split metadata is valid and the held-out split is frozen and never scored in dev', () => {
  const box = sandbox()
  try {
    const labels = JSON.parse(readFileSync(join(GOLD_DIR, 'labels.json'), 'utf8'))
    assert.equal(labels.schema, 'advisers.mail-local-gold/v2')
    assert.equal(labels.splitSizes.dev, 90)
    assert.equal(labels.splitSizes.heldout, 30)
    assert.deepEqual(labels.splitSizes, { dev: 90, heldout: 30 })
    assert.match(labels.corpusSha256, SHA256_RE)
    assert.equal(labels.license, 'CC-BY-NC-SA-4.0')
    assert.equal(labels.provenance, 'synthetic')
    for (const entry of labels.cases) {
      assert.ok(entry.split === 'dev' || entry.split === 'heldout', entry.file)
      assert.equal(typeof entry.provenance, 'string')
      assert.ok(entry.provenance.length > 0)
      assert.equal(typeof entry.reviewStatus, 'string')
      assert.ok(entry.reviewStatus.length > 0)
      assert.ok(Array.isArray(entry.expect), entry.file)
    }
    const heldout = labels.cases.filter((entry) => entry.split === 'heldout')
    assert.equal(heldout.length, 30)
    for (const entry of heldout) assert.ok(readdirSync(GOLD_DIR).includes(entry.file), entry.file)

    // --list validates labels + corpusSha256 without running the extractor on held-out.
    const listed = runRunner(['--list'], box.home)
    assert.equal(listed.status, 0, listed.stderr)
    const lines = listed.stdout.trim().split('\n')
    assert.equal(lines.length, 120)
    assert.equal(lines.filter((line) => line.startsWith('dev ')).length, 90)
    assert.equal(lines.filter((line) => line.startsWith('heldout ')).length, 30)
    assert.deepEqual(readdirSync(box.home), [])
  } finally {
    box.cleanup()
  }
})

test('dev split metrics and per-case rows are deterministic across runs', () => {
  const box = sandbox()
  try {
    const first = runRunner(['--split', 'dev', '--json'], box.home)
    const second = runRunner(['--split', 'dev', '--json'], box.home)
    assert.equal(first.status, 0, first.stderr)
    assert.equal(second.status, 0, second.stderr)
    const left = parseStdout(first)
    const right = parseStdout(second)
    assert.deepEqual(left.metrics, right.metrics)
    assert.deepEqual(left.gates, right.gates)
    assert.deepEqual(left.cases, right.cases)
    assert.equal(left.corpus.sha256, right.corpus.sha256)
    assert.deepEqual(readdirSync(box.home), [])
  } finally {
    box.cleanup()
  }
})

test('human report is readable and exits 0', () => {
  const box = sandbox()
  try {
    const run = runRunner(['--split', 'dev'], box.home)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stderr, '')
    assert.match(run.stdout, /advisers eval:mail-local/)
    assert.match(run.stdout, /candidate precision/)
    assert.match(run.stdout, /due accuracy/)
    assert.match(run.stdout, /negative false-positive rate/)
    assert.match(run.stdout, /PASS - all gated metrics meet their thresholds\./)
    assert.match(run.stdout, /network attempts 0/)
  } finally {
    box.cleanup()
  }
})

test('legacy v1 custom gold below its threshold exits 1 and reports the failing gate', () => {
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
    const report = parseStdout(run)
    assert.equal(report.suite, 'mail-local-gold')
    const recallGate = report.gates.find((entry) => entry.id === 'mail.recall')
    assert.ok(recallGate, 'missing mail.recall gate')
    assert.equal(recallGate.pass, false)
    assert.ok(recallGate.actual < recallGate.threshold)
    assert.equal(report.corpus.split, 'custom')
  } finally {
    box.cleanup()
  }
})

test('tampered fixture bytes are rejected by the frozen corpusSha256', () => {
  const box = sandbox()
  try {
    const copy = join(box.root, 'tampered-gold')
    cpSync(GOLD_DIR, copy, { recursive: true })
    const target = join(copy, '01-zh-absolute-quote.eml')
    writeFileSync(target, readFileSync(target, 'utf8') + 'tampered\n')
    const run = runRunner(['--json', '--fixtures', copy], box.home)
    assert.equal(run.status, 1)
    const report = parseStdout(run)
    assert.equal(report.totals.failed, 1)
    assert.ok(report.environment.result.errors.some((error) => error.includes('corpusSha256 mismatch')), JSON.stringify(report.environment.result.errors))
  } finally {
    box.cleanup()
  }
})

test('invalid gold set fails closed and usage errors exit 2', () => {
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
    const report = parseStdout(invalid)
    assert.equal(report.totals.failed, 1)
    assert.ok(report.environment.result.errors.some((error) => error.includes('missing fixture')), JSON.stringify(report.environment.result.errors))

    const unknownArg = spawnSync(process.execPath, [RUNNER, '--bogus'], { cwd: REPO_ROOT, env: runnerEnv(box.home), encoding: 'utf8', timeout: 60_000 })
    assert.equal(unknownArg.status, 2)
    assert.match(unknownArg.stderr, /unknown argument/)

    const unknownSplit = spawnSync(process.execPath, [RUNNER, '--split', 'test'], { cwd: REPO_ROOT, env: runnerEnv(box.home), encoding: 'utf8', timeout: 60_000 })
    assert.equal(unknownSplit.status, 2)
    assert.match(unknownSplit.stderr, /unknown split/)
  } finally {
    box.cleanup()
  }
})
