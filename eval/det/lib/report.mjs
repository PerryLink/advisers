/**
 * Result schema v2 for the deterministic eval suite (0.5.0 WF4 Q1).
 *
 * One file per run under `eval/results/det/` (gitignored) plus latest.json. The
 * shape is the shared quality-result v2 contract (`eval/lib/quality-report.mjs`,
 * `eval/schema/quality-result-v2.schema.json`) with `mode:"det"`: structural
 * results only — no model-quality numbers may appear here. Absolute paths are
 * replaced with <TMP>/<HOME>/<WORK>/<REPO>, PII is scanned, failures only keep a
 * `detailSha256`, and every unmeasured quality dimension is an explicit null in
 * `unknowns`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import {
  buildQualityReport,
  gate,
  sha256File,
  sha256Hex,
  sanitizeQualityReport,
} from '../../lib/quality-report.mjs'
import { BASELINE_PATH, RESULTS_DIR, REPO_ROOT, cliInfo, normalizeText } from './harness.mjs'

export const RESULT_SCHEMA_VERSION = 2
const FIXTURE_FILE = join(REPO_ROOT, 'eval/det/fixtures/morning-ledger.mjs')
const DET_COMMAND = ['node', 'scripts/eval-det.mjs']

function walk(value, fn) {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((item) => walk(item, fn))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, fn)]))
  }
  return value
}

/** Replace every known temp path with its placeholder and bound detail length. */
export function sanitizeDeep(value, { workdirs = [] } = {}) {
  return walk(value, (text) => {
    let out = text
    for (const workdir of workdirs) out = normalizeText(out, workdir)
    out = out.split(REPO_ROOT).join('<REPO>')
    return out.length > 2000 ? out.slice(0, 2000) + '…' : out
  })
}

function fixtureBlock() {
  try {
    return { sha256: sha256File(FIXTURE_FILE), count: 1 }
  } catch {
    return { sha256: sha256Hex('morning-ledger-v1'), count: 1 }
  }
}

function baselineBlock(baseline) {
  let sha = null
  try { sha = sha256File(BASELINE_PATH) } catch { sha = null }
  return { file: 'eval/det/baseline.json', sha256: sha, recordedAt: baseline?.recordedAt ?? null }
}

/** Convert per-case checks into a stable, sanitized schema-v2 result object. */
export function buildResult({ cases, startedAt, durationMs, baseline, filters, workdirs = [], network = { attempts: 0, kinds: {} }, command = [] }) {
  const checksTotal = cases.reduce((sum, testCase) => sum + testCase.checks.length, 0)
  const failedCases = cases.filter((testCase) => !testCase.checks.every((check) => check.pass)).length
  const result = buildQualityReport({
    suite: 'det',
    suiteVersion: baseline?.suiteVersion ?? 1,
    mode: 'det',
    startedAt,
    durationMs,
    // The command line is evidence, but an --out absolute path must not leak
    // into the result file; replace any absolute argument with a placeholder.
    command: (command.length ? command : [...DET_COMMAND]).map((part) => (isAbsolute(String(part)) ? '<ABS>' : String(part))),
    filters: filters ?? ['all'],
    corpus: null,
    fixtures: fixtureBlock(),
    cli: cliInfo(),
    model: null,
    baseline: baselineBlock(baseline),
    metrics: null,
    gates: [],
    totals: {
      cases: cases.length,
      passed: cases.filter((testCase) => testCase.checks.every((check) => check.pass)).length,
      failed: failedCases,
      checks: checksTotal,
      checksFailed: cases.reduce((sum, testCase) => sum + testCase.checks.filter((check) => !check.pass).length, 0),
    },
    network: { guarded: true, attempts: Number(network?.attempts ?? 0), kinds: network?.kinds ?? {} },
    cases: cases.map((testCase) => ({
      id: testCase.id,
      group: testCase.group,
      title: testCase.title,
      pass: testCase.checks.every((check) => check.pass),
      durationMs: testCase.durationMs,
      checks: testCase.checks,
    })),
    environment: {
      timezone: 'Asia/Shanghai',
      home: '<TMP>/home',
      noModel: true,
      apiKeys: 'stripped',
      networkBlock: 'preload',
      nodeOptions: '--import=eval/det/lib/network-block.mjs',
    },
    reproduce: {
      command: 'pnpm eval:det',
      env: { TZ: 'Asia/Shanghai', noModel: true, network: 'blocked', acceptTos: true },
      fixedNow: '2026-11-20T01:00:00.000Z',
      seed: 0,
    },
  })
  const sanitized = sanitizeQualityReport(result, { roots: workdirs })
  // Defense in depth: the gate must not ship a result that leaks a local path.
  let leak = null
  for (const root of [...workdirs.map((workdir) => workdir.root), REPO_ROOT]) {
    if (root && JSON.stringify(sanitized).includes(root)) { leak = root; break }
  }
  const failures = []
  for (const testCase of sanitized.cases) {
    for (const check of testCase.checks) {
      if (!check.pass) failures.push({ caseId: testCase.id, checkId: check.id, code: 'CHECK_FAILED', detailSha256: sha256Hex(String(check.detail ?? 'no detail')) })
    }
  }
  if (leak) {
    failures.push({ caseId: 'det.harness.result-redaction', checkId: 'no-absolute-paths', code: 'RESULT_LEAK', detailSha256: sha256Hex(String(leak)) })
    sanitized.leak = true
    sanitized.totals.failed += 1
    sanitized.totals.checksFailed += 1
  }
  sanitized.failures = failures.slice(0, 50)
  if (failures.length > 50) sanitized.errors = [{ code: 'FAILURES_TRUNCATED', count: failures.length - 50 }]
  sanitized.gates = [
    gate('cases.failed', sanitized.totals.failed, 0, '='),
    gate('checks.failed', sanitized.totals.checksFailed, 0, '='),
    gate('network.attempts', sanitized.network.attempts, 0, '='),
  ]
  return sanitized
}

/** UTC timestamp filename component: 20261120T012345Z. */
function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/** Write `results/det-<stamp>.json` and `results/latest.json`. */
export function writeResult(result, { outFile, outDir = RESULTS_DIR, noWrite = false } = {}) {
  if (noWrite) return { path: null, latestPath: null }
  const dir = outFile ? dirname(outFile) : outDir
  mkdirSync(dir, { recursive: true })
  const body = JSON.stringify(result, null, 2) + '\n'
  if (outFile) {
    writeFileSync(outFile, body)
    return { path: outFile, latestPath: null }
  }
  const path = join(outDir, 'det-' + stamp(new Date(result.startedAt)) + '.json')
  const latestPath = join(outDir, 'latest.json')
  writeFileSync(path, body)
  writeFileSync(latestPath, body)
  return { path, latestPath }
}

/** Human-readable report for CI logs. Failures are printed in full. */
export function printReport(result, { verbose = false } = {}) {
  const lines = []
  for (const testCase of result.cases) {
    const failedChecks = testCase.checks.filter((check) => !check.pass)
    if (!failedChecks.length && !verbose) continue
    lines.push((failedChecks.length ? 'FAIL ' : 'PASS ') + testCase.id + ' (' + testCase.durationMs + 'ms)' + (testCase.title ? ' — ' + testCase.title : ''))
    for (const check of failedChecks) lines.push('  × ' + check.id + (check.detail ? ': ' + check.detail : ''))
  }
  for (const failure of result.failures) {
    if (failure.code !== 'RESULT_LEAK') continue
    lines.push('FAIL ' + failure.caseId + ' × ' + failure.checkId)
  }
  const totals = result.totals
  const summary = 'advisers eval:det — ' + totals.passed + '/' + totals.cases + ' cases, ' + totals.checksFailed + '/' + totals.checks + ' checks failed, ' + Math.round(result.durationMs / 100) / 10 + 's'
  lines.push(result.totals.failed === 0 ? 'PASS ' + summary : 'FAIL ' + summary)
  if (result.network.attempts > 0) lines.push('FAIL network: ' + result.network.attempts + ' blocked attempt(s) — ' + JSON.stringify(result.network.kinds))
  return lines.join('\n')
}
