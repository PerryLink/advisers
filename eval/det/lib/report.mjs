/**
 * Result schema v1 for the deterministic eval suite.
 *
 * One file per run under eval/det/results/ (gitignored) plus latest.json. The
 * shape follows the 0.3 eval design (04-0.3-research/15-eval-contracts.md §3.3)
 * with `mode:"det"` and structural metrics only: no model quality numbers can
 * appear here. Absolute paths are replaced with <TMP>/<HOME>/<WORK>/<REPO> and
 * the result is scanned again before it is written.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RESULTS_DIR, REPO_ROOT, cliInfo, normalizeText } from './harness.mjs'

export const RESULT_SCHEMA_VERSION = 1

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

/** Convert per-case checks into a stable, sanitized result object. */
export function buildResult({ cases, startedAt, durationMs, baseline, filters, workdirs = [], network = { attempts: 0, kinds: {} } }) {
  const failures = []
  for (const testCase of cases) {
    for (const check of testCase.checks) {
      if (!check.pass) failures.push({ caseId: testCase.id, checkId: check.id, code: 'CHECK_FAILED', detail: check.detail ?? '' })
    }
  }
  const checksTotal = cases.reduce((sum, testCase) => sum + testCase.checks.length, 0)
  const checksFailed = failures.length
  const result = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    suite: 'det',
    suiteVersion: baseline?.suiteVersion ?? 1,
    mode: 'det',
    startedAt,
    durationMs,
    filters: filters ?? ['all'],
    baseline: {
      file: 'eval/det/baseline.json',
      fixture: baseline?.fixture ?? null,
      recordedAt: baseline?.recordedAt ?? null,
    },
    cli: cliInfo(),
    environment: {
      timezone: 'Asia/Shanghai',
      home: '<TMP>/home',
      noModel: true,
      apiKeys: 'stripped',
      networkBlock: 'preload',
      nodeOptions: '--import=eval/det/lib/network-block.mjs',
    },
    totals: {
      cases: cases.length,
      passed: cases.filter((testCase) => testCase.checks.every((check) => check.pass)).length,
      failed: cases.filter((testCase) => !testCase.checks.every((check) => check.pass)).length,
      checks: checksTotal,
      checksFailed,
    },
    network,
    cases: cases.map((testCase) => ({
      id: testCase.id,
      group: testCase.group,
      title: testCase.title,
      pass: testCase.checks.every((check) => check.pass),
      durationMs: testCase.durationMs,
      checks: testCase.checks,
    })),
    failures: failures.slice(0, 50),
    errors: failures.length > 50 ? [{ code: 'FAILURES_TRUNCATED', count: failures.length - 50 }] : [],
    redaction: { version: 1, rules: ['abs-path', 'temp-home', 'repo-root'] },
  }
  const sanitized = sanitizeDeep(result, { workdirs })
  // Defense in depth: the gate must not ship a result that leaks a local path.
  for (const root of [...workdirs.map((workdir) => workdir.root), REPO_ROOT]) {
    if (root && JSON.stringify(sanitized).includes(root)) {
      sanitized.leak = true
      sanitized.failures.push({ caseId: 'det.harness.result-redaction', checkId: 'no-absolute-paths', code: 'RESULT_LEAK', detail: 'result still contains an absolute path' })
      sanitized.totals.failed += 1
      sanitized.totals.checksFailed += 1
      break
    }
  }
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
    if (result.cases.some((testCase) => testCase.id === failure.caseId && testCase.checks.some((check) => !check.pass))) continue
    lines.push('FAIL ' + failure.caseId + ' × ' + failure.checkId + ': ' + failure.detail)
  }
  const totals = result.totals
  const summary = 'advisers eval:det — ' + totals.passed + '/' + totals.cases + ' cases, ' + totals.checksFailed + '/' + totals.checks + ' checks failed, ' + Math.round(result.durationMs / 100) / 10 + 's'
  lines.push(result.totals.failed === 0 ? 'PASS ' + summary : 'FAIL ' + summary)
  if (result.network.attempts > 0) lines.push('FAIL network: ' + result.network.attempts + ' blocked attempt(s) — ' + JSON.stringify(result.network.kinds))
  return lines.join('\n')
}
