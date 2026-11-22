/**
 * Tests for the deterministic eval suite (`pnpm eval:det`).
 *
 * The suite itself is a gate, so these tests cover its mechanics: the harness
 * contract (temp HOME, stripped keys, path scrubbing), the network-block
 * preload, pass/fail result semantics, the baseline file and the CLI wiring.
 * They run one small suite group end-to-end so the entry point is exercised.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const scriptPath = join(repoRoot, 'scripts/eval-det.mjs')
const load = (relativePath) => import(pathToFileURL(join(repoRoot, relativePath)).href)

const harness = await load('eval/det/lib/harness.mjs')
const report = await load('eval/det/lib/report.mjs')
const runner = await load('eval/det/lib/runner.mjs')
const baselineLib = await load('eval/det/lib/baseline.mjs')

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix + '-'))
}

test('eval-det: control-byte and ANSI detection', () => {
  assert.equal(harness.hasAnsi('plain text'), false)
  assert.equal(harness.hasAnsi('\u001b[2Jcleared'), true)
  assert.deepEqual(harness.controlViolations('ok\nline\ttab'), [])
  assert.deepEqual(harness.controlViolations('bad\rcr'), ['cr'])
  assert.deepEqual(harness.controlViolations('bad\u0007bell'), ['c0'])
  assert.deepEqual(harness.controlViolations('\u001b[31mred'), ['esc'])
})

test('eval-det: normalizeText scrubs temp roots and the repo root', () => {
  const workdir = harness.createWorkdir('normalize')
  try {
    assert.equal(harness.normalizeText(workdir.home + '/state.db', workdir), '<HOME>/state.db')
    assert.equal(harness.normalizeText(workdir.work + '/out.docx', workdir), '<WORK>/out.docx')
    assert.equal(harness.normalizeText(workdir.root + '/x', workdir), '<TMP>/x')
    assert.equal(harness.normalizeText(harness.REPO_ROOT + '/package.json', workdir), '<REPO>/package.json')
    assert.equal(harness.normalizeText('no paths here', workdir), 'no paths here')
  } finally {
    harness.cleanupWorkdir(workdir)
  }
})

test('eval-det: buildEnv strips provider keys and installs the network block', () => {
  const workdir = harness.createWorkdir('env')
  const previous = {}
  try {
    for (const key of ['ADVISERS_API_KEY', 'DEEPSEEK_API_KEY', 'ADVISERS_MODEL', 'ADVISERS_BASE_URL', 'FORCE_COLOR']) {
      previous[key] = process.env[key]
      process.env[key] = 'unit-test-value'
    }
    const env = harness.buildEnv(workdir)
    for (const key of Object.keys(previous)) assert.equal(env[key], undefined, key + ' must be stripped')
    assert.equal(env.TZ, 'Asia/Shanghai')
    assert.equal(env.ADVISERS_HOME, workdir.home)
    assert.equal(env.ADVISERS_NO_MODEL, '1')
    assert.equal(env.ADVISERS_ACCEPT_TOS, '1')
    assert.match(env.NODE_OPTIONS ?? '', /--import=file:\/\/.*network-block\.mjs/)
    const gated = harness.buildEnv(workdir, { acceptTos: false })
    assert.equal(gated.ADVISERS_ACCEPT_TOS, undefined)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    harness.cleanupWorkdir(workdir)
  }
})

test('eval-det: network-block preload records and rejects egress in a child', () => {
  const dir = tempDir('eval-det-net')
  try {
    const childPath = join(dir, 'child.mjs')
    writeFileSync(childPath, [
      "try { await fetch('http://example.invalid/') } catch (error) { console.log('blocked:' + error.code) }",
      "try { const net = await import('node:net'); net.default.connect(80, 'example.invalid') } catch (error) { console.log('net:' + error.code) }",
      "console.log('done')",
    ].join('\n'))
    const logPath = join(dir, 'net.log')
    const result = spawnSync(process.execPath, [childPath], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '--import=' + pathToFileURL(join(repoRoot, 'eval/det/lib/network-block.mjs')).href, ADVISERS_EVAL_NET_LOG: logPath },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /blocked:E_EVAL_NETWORK/)
    assert.match(result.stdout, /net:E_EVAL_NETWORK/)
    const attempts = harness.networkAttempts(logPath)
    assert.ok(attempts.some((attempt) => attempt.kind === 'fetch'), 'fetch attempt must be logged')
    assert.ok(attempts.some((attempt) => attempt.kind === 'net.connect'), 'net.connect must be logged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('eval-det: sanitizeDeep and buildResult never leak a temp path', () => {
  const workdir = harness.createWorkdir('sanitize')
  try {
    const sanitized = report.sanitizeDeep({ detail: workdir.home + '/secret.db' }, { workdirs: [workdir] })
    assert.equal(sanitized.detail, '<HOME>/secret.db')
    const result = report.buildResult({
      cases: [
        { id: 'unit.pass', group: 'unit', title: '', durationMs: 1, checks: [{ id: 'ok', pass: true }] },
        { id: 'unit.fail', group: 'unit', title: '', durationMs: 1, checks: [{ id: 'detail', pass: false, detail: workdir.home + '/leak' }] },
      ],
      startedAt: new Date().toISOString(),
      durationMs: 2,
      baseline: { suiteVersion: 1, fixture: 'unit' },
      filters: ['unit'],
      workdirs: [workdir],
      network: { attempts: 0, kinds: {} },
    })
    assert.equal(result.totals.cases, 2)
    assert.equal(result.totals.failed, 1)
    assert.equal(result.totals.checksFailed, 1)
    assert.equal(result.failures.length, 1)
    assert.ok(!JSON.stringify(result).includes(workdir.home), 'result must not contain the temp home')
    assert.ok(!JSON.stringify(result).includes(repoRoot), 'result must not contain the repo root')
  } finally {
    harness.cleanupWorkdir(workdir)
  }
})

test('eval-det: runner semantics — exceptions and failed checks fail the case', async () => {
  const cases = [
    { id: 'unit.pass', group: 'unit', async run() { return { checks: [{ id: 'ok', pass: true }] } } },
    { id: 'unit.check-fail', group: 'unit', async run() { return { checks: [{ id: 'nope', pass: false, detail: 'boom' }] } } },
    { id: 'unit.throws', group: 'unit', async run() { throw new Error('exploded') } },
    { id: 'unit.no-checks', group: 'unit', async run() { return {} } },
  ]
  const results = await runner.runCases(cases)
  assert.equal(results.length, 4)
  assert.equal(results[0].checks.every((check) => check.pass), true)
  assert.equal(results[1].checks[0].pass, false)
  assert.equal(results[2].checks[0].id, 'case.exception')
  assert.equal(results[3].checks[0].pass, false, 'a case with no checks must fail closed')
})

test('eval-det: baseline file freezes the deterministic contract', () => {
  assert.ok(existsSync(join(repoRoot, 'eval/det/baseline.json')), 'baseline.json must be committed')
  const baseline = baselineLib.readBaseline()
  assert.equal(baseline.fixture, 'morning-ledger-v1')
  assert.match(baseline.golden.morning.dataSha256, /^[0-9a-f]{64}$/)
  assert.match(baseline.golden.morning.digestMarkdownSha256, /^[0-9a-f]{64}$/)
  assert.equal(baseline.golden.morning.now, '2026-11-20T01:00:00.000Z')
  assert.equal(baseline.contract.exitCodes.success, 0)
  assert.equal(baseline.contract.exitCodes.userError, 1)
  assert.equal(baseline.contract.exitCodes.tosRequired, 3)
  assert.equal(baseline.contract.mcp.requiredTools.length, 8)
  assert.equal(baseline.contract.mcp.requiredResources.length, 5)
  assert.ok(baseline.contract.mcp.requiredTools.includes('advisers_today'))
  assert.ok(baseline.contract.mcp.requiredResources.includes('advisers://today'))
})

test('eval-det: root package.json exposes the eval:det script', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['eval:det'], 'node scripts/eval-det.mjs')
})

test('eval-det: entry point runs a green suite and writes a sanitized result', () => {
  const dir = tempDir('eval-det-cli')
  try {
    const outFile = join(dir, 'det.json')
    const run = spawnSync(process.execPath, [scriptPath, '--suite', 'exit', '--out', outFile], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 180000,
    })
    assert.equal(run.status, 0, 'exit suite must pass: ' + run.stdout + run.stderr)
    assert.ok(existsSync(outFile), 'result file must be written')
    const result = JSON.parse(readFileSync(outFile, 'utf8'))
    assert.equal(result.schemaVersion, 2)
    assert.equal(result.suite, 'det')
    assert.equal(result.mode, 'det')
    assert.deepEqual(result.filters, ['exit'])
    assert.ok(result.totals.cases >= 4)
    assert.equal(result.totals.failed, 0)
    assert.equal(result.network.attempts, 0)
    assert.equal(result.network.guarded, true)
    assert.equal(result.cli.version, JSON.parse(readFileSync(join(repoRoot, 'packages/advisers/package.json'), 'utf8')).version)
    assert.equal(typeof result.cli.dirty, 'boolean')
    assert.equal(typeof result.environment.home, 'string')
    assert.ok(Array.isArray(result.command) && result.command.length > 0, 'command must be recorded')
    assert.equal(result.metrics, null, 'mode det must not carry quality metrics')
    assert.equal(result.model, null)
    assert.ok(Array.isArray(result.unknowns), 'unknowns must be explicit')
    for (const id of ['modelQuality', 'humanGold', 'liveModelQuality']) {
      const entry = result.unknowns.find((unknown) => unknown.id === id)
      assert.ok(entry, id + ' must be listed in unknowns')
      assert.equal(entry.value, null, id + ' must be explicit null')
    }
    for (const entry of result.gates) assert.equal(entry.pass, true, entry.id + ' gate must pass')
    for (const failure of result.failures) assert.match(failure.detailSha256, /^[0-9a-f]{64}$/)
    assert.ok(!JSON.stringify(result).includes(dir), 'result must not contain the output temp dir')
    assert.ok(!JSON.stringify(result).includes(repoRoot), 'result must not contain the repo root')
    for (const testCase of result.cases) assert.ok(testCase.checks.length > 0, testCase.id + ' must report checks')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('eval-det: entry point rejects unknown suites with exit code 2', () => {
  const run = spawnSync(process.execPath, [scriptPath, '--suite', 'does-not-exist'], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /unknown suite/)
})

test('eval-det: --list prints case ids without running the CLI', () => {
  const run = spawnSync(process.execPath, [scriptPath, '--list', '--suite', 'determinism'], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /det\.morning\.golden-hash/)
  assert.match(run.stdout, /det\.agenda\.json-byte-stable/)
  assert.doesNotMatch(run.stdout, /det\.mcp\./)
})

const qualityLib = await load('eval/lib/quality-report.mjs')

test('eval-det: quality-report v2 builder/validator and the committed schema agree', () => {
  assert.equal(qualityLib.QUALITY_SCHEMA_VERSION, 2)
  const schema = JSON.parse(readFileSync(join(repoRoot, 'eval/schema/quality-result-v2.schema.json'), 'utf8'))
  assert.equal(schema.properties.schemaVersion.const, 2)
  for (const key of ['suite', 'mode', 'corpus', 'fixtures', 'cli', 'baseline', 'metrics', 'gates', 'totals', 'network', 'unknowns', 'failures', 'redaction', 'reproduce']) {
    assert.ok(schema.required.includes(key), 'schema.required must include ' + key)
  }
  const report = qualityLib.buildQualityReport({
    suite: 'unit-suite',
    suiteVersion: 1,
    mode: 'det',
    command: ['node', 'scripts/eval-det.mjs', '--no-write'],
    fixtures: { sha256: qualityLib.sha256Hex('fixture'), count: 1 },
    totals: { cases: 1, passed: 1, failed: 0, checks: 1, checksFailed: 0 },
    cli: { version: '0.4.3', commit: 'f29d268', node: process.version, os: process.platform, dirty: true },
    baseline: { file: 'eval/det/baseline.json', sha256: qualityLib.sha256File(join(repoRoot, 'eval/det/baseline.json')), recordedAt: '2026-11-21T04:35:27.000Z' },
    gates: [qualityLib.gate('cases.failed', 0, 0, '=')],
    reproduce: { command: 'node scripts/eval-det.mjs', env: { TZ: 'Asia/Shanghai' }, fixedNow: null, seed: null },
  })
  const verdict = qualityLib.validateQualityReport(report)
  assert.equal(verdict.ok, true, JSON.stringify(verdict.errors))
  // Explicit-null rule: a measured-quality value in mode det is rejected.
  const withQuality = { ...report, metrics: { modelQuality: 0 } }
  const qualityVerdict = qualityLib.validateQualityReport(withQuality)
  assert.equal(qualityVerdict.ok, false)
  assert.ok(qualityVerdict.errors.some((error) => error.code === 'MODE_METRICS'))
  // Release evidence additionally requires a commit and a clean worktree.
  const dirtyRelease = qualityLib.validateQualityReport(report, { release: true })
  assert.equal(dirtyRelease.ok, false)
  assert.ok(dirtyRelease.errors.some((error) => error.code === 'RELEASE_DIRTY'))
})

test('eval-det: check-eval-report self-test passes', () => {
  const run = spawnSync(process.execPath, [join(repoRoot, 'scripts/check-eval-report.mjs'), '--self-test'], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /self-test — 5\/5 passed/)
})

test('eval-det: memory and projection suites are registered with their case counts', () => {
  const memory = spawnSync(process.execPath, [scriptPath, '--list', '--suite', 'memory'], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(memory.status, 0, memory.stderr)
  assert.equal(memory.stdout.trim().split('\n').length, 12, 'memory group must expose 12 cases')
  assert.match(memory.stdout, /det\.memory\.overlapping-intervals-warn-and-resolve/)
  const projection = spawnSync(process.execPath, [scriptPath, '--list', '--suite', 'projection'], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(projection.status, 0, projection.stderr)
  assert.equal(projection.stdout.trim().split('\n').length, 5, 'projection group must expose 5 cases')
  assert.match(projection.stdout, /det\.projection\.today-parity/)
})
