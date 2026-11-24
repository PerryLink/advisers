#!/usr/bin/env node
/**
 * Produce the frozen release-quality evidence directory (0.5.1 M3).
 *
 * A release may only cite reports produced on the release tree itself: this
 * script refuses a dirty checkout, runs the five zero-model gates (det,
 * kb-retrieval, mail-local dev, mail-local held-out, model-contract), copies each
 * freshly written schema-v2 report into one curated directory, and writes
 * SHA256SUMS + a human-readable EVIDENCE.md. The curated directory is what
 * scripts/check-release.mjs --eval-evidence consumes.
 *
 * The reports are release-grade only when cli.commit is recorded and cli.dirty is
 * false (scripts/check-eval-report.mjs --release); a dirty worktree report is
 * still a valid local regression result but must never become release evidence.
 *
 * Usage:
 *   node eval/evidence.mjs [--out <dir>] [--tag v0.5.0] [--json]
 *
 * Defaults: --out eval/results/release-evidence (gitignored). Run it on a clean
 * checkout of the release commit; for the 0.5.0 retrospective evidence that is
 * tag v0.5.0 (commit a73c380), e.g. from `git worktree add --detach <tmp> v0.5.0`.
 *
 * Exit codes: 0 evidence frozen and all reports release-grade; 1 gate/report/
 * provenance failure; 2 usage error.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative as relativePath, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { productVersion, validateQualityReport } from './lib/quality-report.mjs'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const RESULTS_ROOT = join(REPO_ROOT, 'eval', 'results')
const DEFAULT_OUT = join(RESULTS_ROOT, 'release-evidence')

const USAGE = [
  'usage: node eval/evidence.mjs [--out <dir>] [--tag <tag>] [--json]',
  '',
  '  --out <dir>   evidence directory (default eval/results/release-evidence)',
  '  --tag <tag>   require git tag <tag> to point at HEAD (clean tag evidence)',
  '  --json        also print the evidence summary as JSON on stdout',
].join('\n')

function fail(message) {
  console.error('advisers evidence: ' + message)
  process.exit(1)
}
function usageFail(message) {
  console.error('advisers evidence: ' + message + '\n\n' + USAGE)
  process.exit(2)
}
function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, tag: null, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0) }
    else if (arg === '--json') options.json = true
    else if (arg === '--out') { options.out = argv[++index] ?? ''; if (!options.out) usageFail('--out needs a directory') }
    else if (arg === '--tag') { options.tag = argv[++index] ?? ''; if (!options.tag) usageFail('--tag needs a tag name') }
    else usageFail('unknown argument: ' + arg)
  }
  return options
}

function git(args) {
  const run = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  return run.status === 0 ? run.stdout.trim() : null
}
function gitHead() { return git(['rev-parse', 'HEAD']) ?? '' }
function gitHeadShort() { return git(['rev-parse', '--short', 'HEAD']) ?? '' }
function gitStatus() { return git(['status', '--porcelain', '-uno']) ?? '?' }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function toPosix(path) { return String(path).replaceAll('\\', '/') }

/** One gate: command, the schema-v2 report it rewrites, and the evidence slot. */
const GATES = Object.freeze([
  {
    slot: 'det', suite: 'det', out: 'det.json', report: 'eval/results/det/latest.json',
    args: ['scripts/eval-det.mjs'], reproduce: 'pnpm eval:det',
  },
  {
    slot: 'kb-retrieval', suite: 'kb-retrieval', out: 'kb-retrieval.json', report: 'eval/results/kb-retrieval/latest.json',
    args: ['eval/kb-retrieval/run.mjs'], reproduce: 'pnpm eval:kb-retrieval',
  },
  {
    slot: 'mail-local-gold:dev', suite: 'mail-local-gold', split: 'dev', out: 'mail-local-gold-dev.json',
    report: 'eval/results/mail-local-gold/latest.json',
    args: ['eval/run-mail-local-gold.mjs', '--split', 'dev'], reproduce: 'pnpm eval:mail-local --split dev',
  },
  {
    slot: 'mail-local-gold:heldout', suite: 'mail-local-gold', split: 'heldout', out: 'mail-local-gold-heldout.json',
    report: 'eval/results/mail-local-gold/latest.json',
    args: ['eval/run-mail-local-gold.mjs', '--split', 'heldout'], reproduce: 'pnpm eval:mail-local --split heldout',
  },
  {
    slot: 'model-contract', suite: 'model-contract', out: 'model-contract.json',
    report: 'eval/results/model-contract/latest.json',
    args: ['eval/model-contract/run.mjs'], reproduce: 'pnpm eval:model-contract',
  },
])

function resolveOutPath(value) {
  const absolute = resolve(REPO_ROOT, value)
  const rel = toPosix(relativePath(REPO_ROOT, absolute))
  const insideResults = toPosix(absolute).startsWith(toPosix(RESULTS_ROOT) + '/')
  const insideRepo = rel !== '..' && !rel.startsWith('../')
  if (insideRepo && !insideResults) fail('--out must be under eval/results/ (got ' + rel + '); release evidence stays out of the public tree')
  return { absolute, relative: insideRepo ? rel : absolute, insideResults }
}

function prepareOutDir(target) {
  if (!existsSync(target.absolute)) {
    mkdirSync(target.absolute, { recursive: true })
    return
  }
  if (!target.insideResults) fail('refusing to overwrite existing directory outside eval/results/: ' + target.relative)
  rmSync(target.absolute, { recursive: true, force: true })
  mkdirSync(target.absolute, { recursive: true })
}

function summarizeMetrics(report) {
  const metrics = report.metrics ?? {}
  const wanted = [
    ['n', metrics.n],
    ['precision', metrics.precision],
    ['recall', metrics.recall],
    ['f1', metrics.f1],
    ['dueAccuracy', metrics.dueAccuracy],
    ['authorAccuracy', metrics.authorAccuracy],
    ['negativeFalsePositiveRate', metrics.negativeFalsePositiveRate],
    ['precisionAt5', metrics.precisionAt5],
    ['mrrAt10', metrics.mrrAt10],
    ['shortQueryHitAt5', metrics.shortQueryHitAt5],
    ['noHitFalsePositiveRate', metrics.noHitFalsePositiveRate],
    ['sockets', metrics.sockets],
    ['autoConfirmed', metrics.autoConfirmed],
  ]
  return wanted.filter(([, value]) => value !== undefined).map(([key, value]) => key + '=' + value).join(' ')
}

/** Run one gate and return its freshly written schema-v2 report bytes. */
function runGate(gate, head) {
  const command = [process.execPath, ...gate.args]
  console.log('\n=== evidence gate ' + gate.slot + ': ' + command.join(' ') + ' ===')
  const startedAt = Date.now()
  const run = spawnSync(process.execPath, gate.args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, TZ: 'Asia/Shanghai', ADVISERS_API_KEY: '', DEEPSEEK_API_KEY: '', ADVISERS_NO_MODEL: '1' },
  })
  if (run.error) fail('gate ' + gate.slot + ' could not run: ' + run.error.message)
  if (run.status !== 0) fail('gate ' + gate.slot + ' exited ' + String(run.status) + '; release evidence needs all gates green')
  const reportPath = join(REPO_ROOT, gate.report)
  if (!existsSync(reportPath)) fail('gate ' + gate.slot + ' did not write ' + gate.report)
  if (statSync(reportPath).mtimeMs + 5000 < startedAt) fail('gate ' + gate.slot + ' did not rewrite ' + gate.report + ' (stale report)')
  const bytes = readFileSync(reportPath)
  let report
  try { report = JSON.parse(bytes.toString('utf8')) } catch (error) { fail('gate ' + gate.slot + ' wrote invalid JSON: ' + error.message) }
  if (report.suite !== gate.suite) fail('gate ' + gate.slot + ' wrote suite ' + JSON.stringify(report.suite) + ', expected ' + JSON.stringify(gate.suite))
  if (gate.split && report.corpus?.split !== gate.split) fail('gate ' + gate.slot + ' wrote split ' + JSON.stringify(report.corpus?.split) + ', expected ' + JSON.stringify(gate.split))
  const verdict = validateQualityReport(report, { release: true })
  if (!verdict.ok) {
    for (const error of verdict.errors) console.error('  x ' + error.code + ' ' + error.path + ': ' + error.message)
    fail('gate ' + gate.slot + ' is not release-grade (see the errors above)')
  }
  if (report.cli?.dirty !== false) fail('gate ' + gate.slot + ' recorded cli.dirty=' + String(report.cli?.dirty) + '; run evidence on a clean checkout')
  if (!report.cli?.commit || !head.startsWith(report.cli.commit)) fail('gate ' + gate.slot + ' recorded cli.commit=' + String(report.cli?.commit) + ' which does not match HEAD ' + head)
  return { report, bytes }
}

function evidenceMarkdown({ outRelative, head, headShort, tag, reports, sums, generatedAt }) {
  const lines = []
  lines.push('# Advisers release-quality evidence')
  lines.push('',
    '> Generated by `node eval/evidence.mjs` on a clean checkout. Do not edit these',
    '> files by hand: re-run the script instead. The five `*.json` reports are the',
    '> machine evidence; `SHA256SUMS` freezes their bytes.',
    '',
    '| field | value |',
    '|---|---|',
    '| product version | `' + productVersion() + '` |',
    '| git commit | `' + head + '` (`' + headShort + '`) |',
    '| tag | ' + (tag ? '`' + tag + '` at HEAD' : 'not checked (pass --tag for tag evidence)') + ' |',
    '| generated at | `' + generatedAt + '` |',
    '| node | `' + process.version + '` on `' + process.platform + '` |',
    '| evidence dir | `' + outRelative + '` |',
    '',
    '## Gates',
    '',
    '| gate | report | metrics | totals | gates passed | corpus |',
    '|---|---|---|---|---|---|',
  )
  for (const entry of reports) {
    const report = entry.report
    lines.push('| ' + entry.gate.slot + ' | `' + entry.gate.out + '` | ' + summarizeMetrics(report) +
      ' | cases ' + report.totals.cases + '/' + report.totals.passed + ', checks ' + report.totals.checks + '/' + (report.totals.checks - report.totals.checksFailed) +
      ' | ' + report.gates.filter((gate) => gate.pass).length + '/' + report.gates.length +
      ' | ' + (report.corpus ? report.corpus.id + ' (' + report.corpus.split + ')' : 'n/a') + ' |')
  }
  lines.push('',
    '## Provenance',
    '',
    'Every report records `cli {version, commit, node, os, dirty:false}` and cites',
    '`eval/quality/baselines-v1.json` (thresholds/corpus shas) or',
    '`eval/det/baseline.json` (morning-hash contract) by sha256. The explicit',
    '`unknowns` block keeps `humanGold`, `liveModelQuality`, `modelQuality`,',
    '`semanticCorrectness`, `cost`, `realMailAccount` and `win11RealMachine` as',
    '`null`: no independent human gold set, live-model run, real mail account or',
    'real Windows client was measured here. These gates are synthetic deterministic',
    'regression gates, not accuracy claims.',
    '',
    '## Verify',
    '',
    '```sh',
    'node scripts/check-eval-report.mjs --release ' + outRelative,
    'node scripts/check-release.mjs --eval-evidence ' + outRelative + ' --eval-commit ' + headShort,
    '# on a clean tag checkout the same command runs with --stable --require-tag',
    '```',
    '',
    '## Files',
    '',
  )
  for (const entry of sums) lines.push('- `' + entry.name + '` — sha256 `' + entry.sha256 + '`')
  lines.push('')
  return lines.join('\n')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const head = gitHead()
  const headShort = gitHeadShort()
  if (!head) fail('not a git checkout: cannot record release provenance')
  const status = gitStatus()
  if (status === null) fail('git status failed: cannot prove the checkout is clean')
  if (status !== '') {
    console.error(status.split('\n').slice(0, 20).join('\n'))
    fail('working tree is dirty; release evidence must be produced on a clean checkout (commit or stash the changes first)')
  }
  if (options.tag) {
    const tagged = git(['rev-parse', options.tag + '^{commit}'])
    if (!tagged) fail('tag ' + options.tag + ' does not exist')
    if (tagged !== head) fail('tag ' + options.tag + ' -> ' + tagged.slice(0, 12) + ' is not HEAD ' + head.slice(0, 12))
  }
  const target = resolveOutPath(options.out)
  const reports = []
  for (const gate of GATES) {
    const { report, bytes } = runGate(gate, head)
    reports.push({ gate, report, bytes })
  }
  prepareOutDir(target)
  const sums = []
  for (const entry of reports) {
    const file = join(target.absolute, entry.gate.out)
    writeFileSync(file, entry.bytes)
    sums.push({ name: entry.gate.out, sha256: sha256(entry.bytes) })
  }
  sums.sort((left, right) => (left.name < right.name ? -1 : 1))
  writeFileSync(join(target.absolute, 'SHA256SUMS'), sums.map((entry) => entry.sha256 + '  ' + entry.name).join('\n') + '\n')
  const generatedAt = new Date().toISOString()
  const markdown = evidenceMarkdown({ outRelative: target.relative, head, headShort, tag: options.tag, reports, sums, generatedAt })
  writeFileSync(join(target.absolute, 'EVIDENCE.md'), markdown)
  const summary = {
    ok: true,
    out: target.relative,
    commit: head,
    tag: options.tag,
    generatedAt,
    reports: reports.map((entry) => ({
      slot: entry.gate.slot,
      file: entry.gate.out,
      sha256: sums.find((sum) => sum.name === entry.gate.out)?.sha256,
      n: entry.report.metrics?.n ?? entry.report.totals.cases,
      commit: entry.report.cli.commit,
      dirty: entry.report.cli.dirty,
      corpus: entry.report.corpus,
    })),
  }
  console.log('')
  console.log('PASS release evidence written to ' + target.relative + ' (' + reports.length + ' release-grade reports, commit ' + headShort + ')')
  console.log('INFO next: node scripts/check-eval-report.mjs --release ' + target.relative)
  console.log('INFO next: node scripts/check-release.mjs --eval-evidence ' + target.relative + ' --eval-commit ' + headShort)
  if (options.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
  return 0
}

try {
  process.exit(main())
} catch (error) {
  console.error('advisers evidence: internal error: ' + String(error?.stack ?? error))
  process.exit(1)
}
