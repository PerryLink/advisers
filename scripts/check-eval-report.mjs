#!/usr/bin/env node
/**
 * Validate zero-model quality reports against schema v2 and its hard rules.
 *
 * Usage:
 *   node scripts/check-eval-report.mjs [<file|dir|glob> ...] [--release] [--json] [--quiet]
 *   node scripts/check-eval-report.mjs --self-test
 *
 * With no paths it checks every `eval/results/<suite>/latest.json` produced by
 * the zero-model gates (det, kb-retrieval, mail-local, model-contract).
 *
 * Exit codes: 0 every report valid; 1 at least one invalid report; 2 usage /
 * no report found.
 *
 * Default mode accepts `cli.dirty:true` (a local worktree run is still a valid
 * report); --release additionally requires `cli.commit` and `cli.dirty:false`,
 * which is what release evidence is allowed to cite.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative as relativePath, resolve } from 'node:path'

import {
  REPO_ROOT,
  QUALITY_SCHEMA_PATH,
  buildQualityReport,
  gate as makeGate,
  sha256File,
  sha256Hex,
  standardUnknowns,
  validateQualityReport,
} from '../eval/lib/quality-report.mjs'

const USAGE = [
  'usage: node scripts/check-eval-report.mjs [<file|dir|glob> ...] [--release] [--json] [--quiet]',
  '       node scripts/check-eval-report.mjs --self-test',
  '',
  '  --release   release evidence: require cli.commit and cli.dirty === false',
  '  --json      print the verdict as one JSON document',
  '  --quiet     only print failures and the summary',
  '  --self-test validate built-in positive/negative reports and exit',
].join('\n')

function fail(message) {
  console.error('advisers check-eval-report: ' + message)
  process.exit(2)
}

function parseArgs(argv) {
  const options = { paths: [], release: false, json: false, quiet: false, selfTest: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0) }
    else if (arg === '--release') options.release = true
    else if (arg === '--json') options.json = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--self-test') options.selfTest = true
    else if (arg.startsWith('--')) fail('unknown argument: ' + arg)
    else options.paths.push(arg)
  }
  return options
}

function toPosix(path) {
  return String(path).replaceAll('\\', '/')
}

/** Minimal glob matcher for repo-relative patterns (`*`, `**`, `?`). */
function globToRegExp(pattern) {
  let out = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        out += '.*'
        index += 1
        if (pattern[index + 1] === '/') index += 1
      } else out += '[^/]*'
    } else if (char === '?') out += '[^/]'
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + out + '$')
}

function walkFiles(dir, visit) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(path, visit)
    else if (entry.isFile()) visit(path)
  }
}

/** Expand one CLI path: file, directory (latest.json) or glob pattern. */
function expandTarget(target, cwd) {
  const hasGlob = /[*?]/.test(target)
  const absolute = resolve(cwd, target)
  if (!hasGlob) {
    if (!existsSync(absolute)) throw new Error('report path does not exist: ' + target)
    const stat = statSync(absolute)
    if (stat.isDirectory()) {
      const latest = join(absolute, 'latest.json')
      if (!existsSync(latest)) throw new Error('directory has no latest.json: ' + target)
      return [latest]
    }
    return [absolute]
  }
  const pattern = toPosix(target)
  const baseRel = pattern.slice(0, pattern.search(/[*?]/))
  const baseDir = resolve(cwd, baseRel.slice(0, baseRel.lastIndexOf('/') + 1) || '.')
  if (!existsSync(baseDir)) return []
  const regex = globToRegExp(pattern)
  const found = []
  walkFiles(baseDir, (file) => {
    const rel = toPosix(relativePath(cwd, file))
    if (regex.test(rel)) found.push(file)
  })
  return found.sort()
}

function defaultTargets() {
  const resultsDir = join(REPO_ROOT, 'eval/results')
  if (!existsSync(resultsDir)) return []
  const found = []
  for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const latest = join(resultsDir, entry.name, 'latest.json')
    if (existsSync(latest)) found.push(latest)
  }
  return found.sort()
}

function checkFile(file, { release }) {
  let report
  try {
    report = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { file, ok: false, suite: null, mode: null, errors: [{ code: 'INVALID_JSON', path: '$', message: String(error?.message ?? error) }] }
  }
  const verdict = validateQualityReport(report, { release })
  return { file, ok: verdict.ok, suite: report?.suite ?? null, mode: report?.mode ?? null, errors: verdict.errors }
}

function printHuman(results, { quiet }) {
  let failed = 0
  for (const result of results) {
    if (result.ok) {
      if (!quiet) console.log('PASS ' + toPosix(relativePath(REPO_ROOT, result.file)) + ' (' + result.suite + '/' + result.mode + ')')
      continue
    }
    failed += 1
    console.log('FAIL ' + toPosix(relativePath(REPO_ROOT, result.file)))
    for (const error of result.errors) console.log('  × ' + error.code + ' ' + error.path + ': ' + error.message)
  }
  console.log('advisers check-eval-report — ' + results.length + ' report(s), ' + failed + ' invalid')
  return failed === 0 ? 0 : 1
}

/** Built-in positive/negative fixtures for the validator rules. */
function selfTest() {
  const startedAt = '2026-11-22T10:00:00.000Z'
  const base = {
    suite: 'selftest',
    suiteVersion: 1,
    mode: 'det',
    startedAt,
    durationMs: 12,
    command: ['node', 'scripts/eval-det.mjs', '--json', '--no-write'],
    filters: ['selftest'],
    fixtures: { sha256: sha256Hex('fixture'), count: 1 },
    cli: { version: '0.4.3', commit: 'f29d268', node: process.version, os: process.platform, dirty: false },
    baseline: { file: 'eval/det/baseline.json', sha256: sha256File(join(REPO_ROOT, 'eval/det/baseline.json')), recordedAt: '2026-11-21T04:35:27.000Z' },
    totals: { cases: 1, passed: 1, failed: 0, checks: 2, checksFailed: 0 },
    gates: [makeGate('totals.failed', 0, 0, '='), makeGate('network.attempts', 0, 0, '=')],
    network: { guarded: true, attempts: 0 },
    unknowns: standardUnknowns(),
    reproduce: { command: 'pnpm eval:det', env: { TZ: 'Asia/Shanghai', noModel: true }, fixedNow: '2026-11-20T01:00:00.000Z', seed: 0 },
  }
  const cases = []
  const valid = buildQualityReport({ ...base, cases: [{ id: 'selftest.pass', group: 'selftest', pass: true, checks: [{ id: 'ok', pass: true }] }] })
  const validVerdict = validateQualityReport(valid)
  cases.push({ name: 'valid det report accepted', ok: validVerdict.ok, errors: validVerdict.errors })

  const qualityZero = JSON.parse(JSON.stringify(valid))
  qualityZero.metrics = { modelQuality: 0 }
  const zeroVerdict = validateQualityReport(qualityZero)
  cases.push({
    name: 'modelQuality:0 report rejected (explicit null rule)',
    ok: !zeroVerdict.ok && zeroVerdict.errors.some((error) => error.code === 'MODE_METRICS'),
    errors: zeroVerdict.errors,
  })

  const unknownZero = JSON.parse(JSON.stringify(valid))
  unknownZero.unknowns = unknownZero.unknowns.map((entry) => entry.id === 'humanGold' ? { ...entry, value: 0 } : entry)
  const unknownVerdict = validateQualityReport(unknownZero)
  cases.push({
    name: 'unknowns value:0 rejected (explicit null rule)',
    ok: !unknownVerdict.ok && unknownVerdict.errors.some((error) => error.code === 'EXPLICIT_NULL'),
    errors: unknownVerdict.errors,
  })

  const dirtyRelease = JSON.parse(JSON.stringify(valid))
  dirtyRelease.cli.dirty = true
  const cleanVerdict = validateQualityReport(dirtyRelease)
  const releaseVerdict = validateQualityReport(dirtyRelease, { release: true })
  cases.push({
    name: 'dirty worktree accepted by default, rejected by --release',
    ok: cleanVerdict.ok && !releaseVerdict.ok && releaseVerdict.errors.some((error) => error.code === 'RELEASE_DIRTY'),
    errors: releaseVerdict.errors,
  })

  const leak = JSON.parse(JSON.stringify(valid))
  leak.failures = [{ caseId: 'x', code: 'CHECK_FAILED', detailSha256: 'not-a-sha', detail: '/home/alice/state.db' }]
  const leakVerdict = validateQualityReport(leak)
  cases.push({
    name: 'failure detail text + absolute path rejected',
    ok: !leakVerdict.ok && leakVerdict.errors.some((error) => error.code === 'FAILURES') && leakVerdict.errors.some((error) => error.code === 'ABSOLUTE_PATH'),
    errors: leakVerdict.errors,
  })

  let failed = 0
  for (const entry of cases) {
    console.log((entry.ok ? 'PASS ' : 'FAIL ') + entry.name)
    if (!entry.ok) { failed += 1; for (const error of entry.errors) console.log('  × ' + error.code + ' ' + error.path + ': ' + error.message) }
  }
  console.log('advisers check-eval-report self-test — ' + (cases.length - failed) + '/' + cases.length + ' passed')
  return failed === 0 ? 0 : 1
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.selfTest) return selfTest()
  if (!existsSync(QUALITY_SCHEMA_PATH)) fail('missing ' + QUALITY_SCHEMA_PATH)
  let targets = []
  try {
    if (!options.paths.length) targets = defaultTargets()
    else for (const target of options.paths) targets.push(...expandTarget(target, REPO_ROOT))
  } catch (error) {
    fail(String(error?.message ?? error))
  }
  targets = [...new Set(targets)].sort()
  if (!targets.length) fail('no quality report found (run pnpm eval:det / eval:kb-retrieval / eval:mail-local / eval:model-contract first)')
  const results = targets.map((file) => checkFile(file, { release: options.release }))
  if (options.json) {
    const failed = results.filter((result) => !result.ok).length
    process.stdout.write(JSON.stringify({
      ok: failed === 0,
      release: options.release,
      reports: results.length,
      invalid: failed,
      files: results.map((result) => ({ ...result, file: toPosix(relativePath(REPO_ROOT, result.file)) })),
    }, null, 2) + '\n')
    return failed === 0 ? 0 : 1
  }
  return printHuman(results, options)
}

main().then((code) => { process.exit(code) }).catch((error) => {
  console.error('advisers check-eval-report: internal error: ' + String(error?.stack ?? error))
  process.exit(2)
})
