import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  buildQualityReport,
  gate,
  sha256File,
  sha256Hex,
  standardUnknowns,
  validateQualityReport,
} from '../../../eval/lib/quality-report.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CHECK_REPORT = join(REPO_ROOT, 'scripts', 'check-eval-report.mjs')
const CHECK_RELEASE = join(REPO_ROOT, 'scripts', 'check-release.mjs')
const BASELINE_PATH = join(REPO_ROOT, 'eval', 'quality', 'baselines-v1.json')
const DET_BASELINE_PATH = join(REPO_ROOT, 'eval', 'det', 'baseline.json')
const baselines = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
const COMMIT = 'a73c380'

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 })
}

const baselineRef = { file: 'eval/quality/baselines-v1.json', sha256: sha256File(BASELINE_PATH), recordedAt: baselines.recordedAt }
const detBaselineRef = { file: 'eval/det/baseline.json', sha256: sha256File(DET_BASELINE_PATH), recordedAt: JSON.parse(readFileSync(DET_BASELINE_PATH, 'utf8')).recordedAt ?? null }
const ADVISERS_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'advisers', 'package.json'), 'utf8')).version
const cli = { version: ADVISERS_VERSION, commit: COMMIT, node: process.version, os: process.platform, dirty: false }

function makeDet() {
  return buildQualityReport({
    suite: 'det', suiteVersion: 1, mode: 'det',
    startedAt: '2026-11-24T15:00:00.000Z', durationMs: 10,
    command: ['node', 'scripts/eval-det.mjs'], filters: ['all'],
    corpus: null, fixtures: { sha256: sha256Hex('det'), count: 1 }, cli: { ...cli },
    baseline: detBaselineRef, metrics: null,
    gates: [gate('cases.failed', 0, 0, '='), gate('network.attempts', 0, 0, '=')],
    totals: { cases: 1, passed: 1, failed: 0, checks: 2, checksFailed: 0 },
    network: { guarded: true, attempts: 0 },
    unknowns: standardUnknowns(), failures: [],
    reproduce: { command: 'pnpm eval:det', env: { TZ: 'Asia/Shanghai', noModel: true }, fixedNow: null, seed: 0 },
  })
}
function makeKb() {
  return buildQualityReport({
    suite: 'kb-retrieval', suiteVersion: 1, mode: 'local-gold',
    startedAt: '2026-11-24T15:00:00.000Z', durationMs: 10,
    command: ['node', 'eval/kb-retrieval/run.mjs'], filters: ['all'],
    corpus: { id: 'kb-retrieval', sha256: baselines.suites['kb-retrieval'].corpus.sha256, rows: 75, provenance: 'synthetic', reviewMode: 'implementer-labeled-synthetic', license: 'CC-BY-NC-SA-4.0', split: 'dev' },
    fixtures: { sha256: sha256Hex('kb'), count: 25 }, cli: { ...cli }, baseline: baselineRef,
    metrics: { n: 44, precisionAt5: 0.98, mrrAt10: 0.97, shortQueryHitAt5: 0.92, noHitFalsePositiveRate: 0 },
    gates: [gate('kb.precisionAt5', 0.98, 0.8), gate('kb.mrrAt10', 0.97, 0.65)],
    totals: { cases: 1, passed: 1, failed: 0, checks: 5, checksFailed: 0 },
    network: { guarded: true, attempts: 0 },
    unknowns: standardUnknowns(), failures: [],
    reproduce: { command: 'pnpm eval:kb-retrieval', env: { TZ: 'Asia/Shanghai', noModel: true }, fixedNow: null, seed: 0 },
  })
}
function makeMail(split) {
  const heldout = split === 'heldout'
  return buildQualityReport({
    suite: 'mail-local-gold', suiteVersion: 2, mode: 'local-gold',
    startedAt: '2026-11-24T15:00:00.000Z', durationMs: 10,
    command: ['node', 'eval/run-mail-local-gold.mjs', '--split', split], filters: ['split:' + split],
    corpus: { id: 'mail-local-gold', sha256: baselines.suites['mail-local-gold'].corpus.sha256, rows: 120, provenance: 'synthetic', reviewMode: 'implementer-labeled-synthetic', license: 'CC-BY-NC-SA-4.0', split },
    fixtures: { sha256: sha256Hex('mail-' + split), count: heldout ? 30 : 90 }, cli: { ...cli }, baseline: baselineRef,
    metrics: { n: heldout ? 30 : 90, precision: 0.99, recall: 0.99, f1: 0.99, dueAccuracy: 0.97, authorAccuracy: 1, negativeFalsePositiveRate: 0.04 },
    gates: [gate('mail.precision', 0.99, heldout ? 0.85 : 0.9), gate('mail.negativeFalsePositiveRate', 0.04, 0.1, '<=')],
    totals: { cases: 1, passed: 1, failed: 0, checks: heldout ? 6 : 7, checksFailed: 0 },
    network: { guarded: true, attempts: 0 },
    unknowns: standardUnknowns(), failures: [],
    reproduce: { command: 'pnpm eval:mail-local --split ' + split, env: { TZ: 'Asia/Shanghai', noModel: true }, fixedNow: null, seed: 0 },
  })
}
function makeModelContract() {
  return buildQualityReport({
    suite: 'model-contract', suiteVersion: 1, mode: 'model-contract',
    startedAt: '2026-11-24T15:00:00.000Z', durationMs: 10,
    command: ['node', 'eval/model-contract/run.mjs'], filters: ['all'],
    corpus: null, fixtures: { sha256: sha256Hex('mc'), count: 4 }, cli: { ...cli }, baseline: baselineRef,
    metrics: { n: 12, cases: 12, passed: 12, failed: 0, checks: 15, checksFailed: 0, sockets: 0, socketAttempts: 0, autoConfirmed: 0, stubCalls: 15, reproDataSha: sha256Hex('stubs') },
    gates: [gate('cases.failed', 0, 0, '='), gate('sockets', 0, 0, '='), gate('autoConfirmed', 0, 0, '=')],
    totals: { cases: 12, passed: 12, failed: 0, checks: 15, checksFailed: 0 },
    network: { guarded: true, attempts: 0 },
    unknowns: standardUnknowns(), failures: [],
    reproduce: { command: 'pnpm eval:model-contract', env: { TZ: 'Asia/Shanghai', noModel: true }, fixedNow: null, seed: 0 },
  })
}

function writeEvidence(dir, reports) {
  for (const [name, report] of Object.entries(reports)) {
    const verdict = validateQualityReport(report, { release: true })
    assert.equal(verdict.ok, true, name + ': ' + JSON.stringify(verdict.errors))
    writeFileSync(join(dir, name), JSON.stringify(report, null, 2) + '\n')
  }
}
function fullEvidence() {
  return {
    'det.json': makeDet(),
    'kb-retrieval.json': makeKb(),
    'mail-local-gold-dev.json': makeMail('dev'),
    'mail-local-gold-heldout.json': makeMail('heldout'),
    'model-contract.json': makeModelContract(),
  }
}

const working = mkdtempSync(join(tmpdir(), 'advisers-evidence-test-'))

test('check-eval-report validates a release-evidence directory with no latest.json', () => {
  const dir = join(working, 'reports')
  mkdirSync(dir, { recursive: true })
  writeEvidence(dir, fullEvidence())
  const result = run(CHECK_REPORT, ['--release', dir])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /5 report\(s\), 0 invalid/)
})

test('check-release --eval-evidence consumes a frozen evidence directory', () => {
  const dir = join(working, 'reports')
  const result = run(CHECK_RELEASE, ['--eval-evidence', dir, '--eval-commit', COMMIT])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  for (const slot of ['det', 'kb-retrieval', 'mail-local-gold:dev', 'mail-local-gold:heldout', 'model-contract']) {
    assert.match(result.stdout, new RegExp('PASS eval evidence has exactly one ' + slot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' report'))
  }
  assert.match(result.stdout, /PASS eval evidence commit a73c380 matches expected a73c380/)
  assert.match(result.stdout, /PASS release consistency \(0\.5\.1\)/)
})

test('check-release --eval-evidence fails closed on missing held-out, dirty and commit drift', () => {
  const missing = join(working, 'missing-heldout')
  const missingReports = fullEvidence()
  delete missingReports['mail-local-gold-heldout.json']
  mkdirSync(missing, { recursive: true })
  writeEvidence(missing, missingReports)
  const missingRun = run(CHECK_RELEASE, ['--eval-evidence', missing, '--eval-commit', COMMIT])
  assert.equal(missingRun.status, 1)
  assert.match(missingRun.stdout + missingRun.stderr, /mail-local-gold:heldout.*missing|missing/)

  const dirty = join(working, 'dirty')
  const dirtyReports = fullEvidence()
  dirtyReports['mail-local-gold-dev.json'] = { ...dirtyReports['mail-local-gold-dev.json'], cli: { ...dirtyReports['mail-local-gold-dev.json'].cli, dirty: true } }
  mkdirSync(dirty, { recursive: true })
  writeFileSync(join(dirty, 'mail-local-gold-dev.json'), JSON.stringify(dirtyReports['mail-local-gold-dev.json'], null, 2) + '\n')
  for (const name of Object.keys(dirtyReports)) if (name !== 'mail-local-gold-dev.json') writeFileSync(join(dirty, name), JSON.stringify(dirtyReports[name], null, 2) + '\n')
  const dirtyRun = run(CHECK_RELEASE, ['--eval-evidence', dirty, '--eval-commit', COMMIT])
  assert.equal(dirtyRun.status, 1)
  assert.match(dirtyRun.stdout + dirtyRun.stderr, /RELEASE_DIRTY/)

  const drift = run(CHECK_RELEASE, ['--eval-evidence', join(working, 'reports'), '--eval-commit', 'deadbee'])
  assert.equal(drift.status, 1)
  assert.match(drift.stdout + drift.stderr, /matches expected deadbee/)
})

test('check-release --eval-evidence rejects an ambiguous or non-report JSON directory', () => {
  const duplicate = join(working, 'duplicate')
  mkdirSync(duplicate, { recursive: true })
  writeEvidence(duplicate, fullEvidence())
  copyFileSync(join(duplicate, 'det.json'), join(duplicate, 'det-old.json'))
  const duplicateRun = run(CHECK_RELEASE, ['--eval-evidence', duplicate, '--eval-commit', COMMIT])
  assert.equal(duplicateRun.status, 1)
  assert.match(duplicateRun.stdout + duplicateRun.stderr, /exactly one det report/)

  const junk = join(working, 'junk')
  mkdirSync(junk, { recursive: true })
  writeEvidence(junk, fullEvidence())
  writeFileSync(join(junk, 'notes.json'), JSON.stringify({ hello: 'world' }))
  const junkRun = run(CHECK_RELEASE, ['--eval-evidence', junk, '--eval-commit', COMMIT])
  assert.equal(junkRun.status, 1)
  assert.match(junkRun.stdout + junkRun.stderr, /not a schema-v2 quality report/)
})
