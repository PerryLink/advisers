import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const RUNNER = join(REPO_ROOT, 'eval', 'kb-retrieval', 'run.mjs')
const QUERIES_PATH = join(REPO_ROOT, 'eval', 'kb-retrieval', 'queries.json')
const SHA256_RE = /^[0-9a-f]{64}$/

function runRunner(args) {
  const env = { ...process.env }
  delete env.ADVISERS_API_KEY
  delete env.DEEPSEEK_API_KEY
  delete env.ADVISERS_MODEL
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  })
}

function parseStdout(run) {
  try {
    return JSON.parse(run.stdout)
  } catch {
    throw new Error('runner stdout is not JSON (status ' + run.status + '): ' + run.stdout.slice(0, 400) + ' stderr: ' + run.stderr.slice(0, 400))
  }
}

test('kb-retrieval gold set shape and thresholds are declared in queries.json', () => {
  const gold = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'))
  assert.equal(gold.schema, 'advisers.kb-retrieval/v1')
  assert.equal(gold.provenance, 'synthetic')
  assert.equal(gold.license, 'CC-BY-NC-SA-4.0')
  assert.equal(gold.documents.length, 25)
  assert.equal(gold.queries.length, 50)
  assert.deepEqual(gold.categories, { 'zh-2char': 12, 'zh-3plus': 18, mixed: 8, 'title-hit': 6, 'no-hit': 6 })
  const counts = {}
  for (const query of gold.queries) {
    counts[query.category] = (counts[query.category] || 0) + 1
    assert.ok(Array.isArray(query.relevant), query.id)
    for (const name of query.relevant) assert.ok(gold.documents.includes(name), query.id + ' -> ' + name)
    if (query.category === 'no-hit') assert.deepEqual(query.relevant, [], query.id)
    else assert.ok(query.relevant.length > 0, query.id)
  }
  assert.deepEqual(counts, gold.categories)
})

test('kb-retrieval runs the shipped CLI in a temp HOME and emits a green schema-v2 report', () => {
  const resultsFile = join(REPO_ROOT, 'eval', 'results', 'kb-retrieval', 'latest.json')
  const beforeMtime = existsSync(resultsFile) ? statSync(resultsFile).mtimeMs : null
  const run = runRunner(['--json', '--no-write'])
  assert.equal(run.status, 0, run.stderr)
  const report = parseStdout(run)
  const afterMtime = existsSync(resultsFile) ? statSync(resultsFile).mtimeMs : null
  assert.equal(afterMtime, beforeMtime, '--no-write must not rewrite eval/results/kb-retrieval/latest.json')

  assert.equal(report.schemaVersion, 2)
  assert.equal(report.suite, 'kb-retrieval')
  assert.equal(report.mode, 'local-gold')
  assert.match(report.corpus.sha256, SHA256_RE)
  assert.equal(report.corpus.provenance, 'synthetic')
  assert.equal(report.corpus.rows, 75)
  assert.equal(report.fixtures.count, 25)
  assert.equal(report.metrics.n, 44)
  assert.equal(report.metrics.counts.documents, 25)
  assert.equal(report.metrics.counts.queries, 50)
  assert.equal(report.metrics.counts.noHitQueries, 6)
  assert.equal(report.network.attempts, 0)
  assert.equal(report.network.guarded, true)
  assert.deepEqual(report.failures, [])
  assert.equal(report.totals.failed, 0)
  assert.equal(report.totals.checksFailed, 0)

  // Gated retrieval metrics meet their thresholds and are all present.
  const gateIds = report.gates.map((entry) => entry.id)
  for (const id of ['kb.precisionAt5', 'kb.mrrAt10', 'kb.shortQueryHitAt5', 'kb.noHitFalsePositiveRate', 'kb.gold_valid']) assert.ok(gateIds.includes(id), id)
  assert.ok(report.gates.every((entry) => entry.pass === true), JSON.stringify(report.gates))
  assert.ok(report.metrics.precisionAt5 >= 0.8)
  assert.ok(report.metrics.mrrAt10 >= 0.65)
  assert.ok(report.metrics.shortQueryHitAt5 >= 0.75)
  assert.ok(report.metrics.noHitFalsePositiveRate <= 0.1)
  // The synthetic set is not designed to be perfect: the ambiguous 2-char
  // '评审' query is a documented ranking miss, so P@5 must be below 1.0.
  assert.ok(report.metrics.precisionAt5 < 1.0)
  assert.equal(report.metrics.ci95.shortQueryHitAt5.n, 12)

  // Every query has a case row; no-hit queries must not return hits.
  assert.equal(report.cases.length, 50)
  for (const row of report.cases.filter((entry) => entry.category === 'no-hit')) {
    assert.equal(row.hits, 0, row.id)
    assert.equal(row.rank, null, row.id)
  }
  const ambiguous = report.cases.find((row) => row.query === '评审')
  assert.ok(ambiguous, 'missing ambiguous 评审 query')
  assert.ok(ambiguous.rank === null || ambiguous.rank > 5, 'expected a real 2-char ranking miss')
})

test('unknown arguments are usage errors', () => {
  const run = runRunner(['--bogus'])
  assert.equal(run.status, 2)
  assert.match(run.stderr, /unknown argument/)
  const help = runRunner(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /eval\/kb-retrieval\/run\.mjs/)
})
