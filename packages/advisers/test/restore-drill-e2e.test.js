import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// 0.4.3 task-79 (release item 043-6): end-to-end restore drill.
//
// The drill is spawned exactly as CI runs it (`node scripts/restore-drill.mjs`)
// and creates its own mktemp ADVISERS_HOME. Each test also sets ADVISERS_HOME to
// an empty *sentinel* directory: if the script ever wrote to the inherited home
// instead of its own temporary home, the sentinel would change and these tests
// would fail. The drill asserts, in-process:
//   init -> commit/kb seed -> managed backup -> mutate/delete -> restore
//        -> counts + export dataDigest + audit head return to the backup moment
//        -> a db.restore row is chained on top -> doctor --check-db is green.
//
// The drill is wired to Linux CI in .github/workflows/ci.yml; Windows is
// intentionally skipped here because the CLI round trip has not been observed
// on a real Windows runner yet and Windows keeps the library-level restore
// failure matrix (test/restore-drill.test.js) in windows-full. Promote this to
// Windows after the first green native run (see docs/WINDOWS.md).

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'scripts', 'restore-drill.mjs')
const STEP_TIMEOUT_MS = 180000
const WINDOWS_SKIP = process.platform === 'win32'
  ? '0.4.3 wires the CLI restore drill to Linux CI only; Windows keeps the library-level restore failure matrix until the drill is observed on a real Windows runner'
  : false

function makeSentinel() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-restore-drill-e2e-'))
  return { root, home: join(root, 'inherited-home') }
}

function runDrill(args, inheritedHome) {
  const env = { ...process.env, ADVISERS_HOME: inheritedHome }
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: STEP_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  })
  const stdout = result.stdout ?? ''
  const lines = stdout.trim().split('\n').filter(Boolean)
  return { result, stdout, lines }
}

function parseJsonLine(context, stdout, lines) {
  assert.equal(lines.length, 1, `${context}: expected exactly one JSON line on stdout, got ${lines.length}: ${stdout.slice(0, 500)}`)
  try {
    return JSON.parse(lines[0])
  } catch (error) {
    assert.fail(`${context}: stdout is not JSON (${error.message}): ${lines[0].slice(0, 500)}`)
  }
}

test('restore drill: PASS on a throwaway home (backup -> mutate -> restore consistency)', { skip: WINDOWS_SKIP, timeout: STEP_TIMEOUT_MS }, () => {
  const sentinel = makeSentinel()
  try {
    const { result, stdout, lines } = runDrill([], sentinel.home)
    assert.equal(result.status, 0, `drill failed (exit ${result.status})\nstderr:\n${result.stderr}\nstdout:\n${stdout}`)
    const json = parseJsonLine('happy path', stdout, lines)

    assert.equal(json.ok, true)
    assert.equal(json.status, 'PASS')
    assert.equal(json.drill, 'restore-drill')
    assert.equal(json.version, 1)
    assert.deepEqual(json.steps.map((step) => step.name), [
      'preflight', 'init', 'seed', 'backup', 'mutate', 'restore-plan', 'restore-apply', 'verify',
    ])
    assert.deepEqual(json.steps.filter((step) => step.ok !== true), [])

    // The drill runs entirely in a temporary home under the OS temp dir and
    // deletes it afterwards; the inherited ADVISERS_HOME is never touched.
    assert.ok(String(json.home).startsWith(realpathSync(tmpdir())), `drill home is not under the OS temp dir: ${json.home}`)
    assert.equal(json.kept, false)
    assert.equal(json.cleanup.removed, true)
    assert.equal(existsSync(json.home), false, 'the temporary home was not deleted')
    assert.equal(existsSync(sentinel.home), false, 'the inherited ADVISERS_HOME was created')
    assert.deepEqual(readdirSync(sentinel.root), [], 'the inherited home parent was written to')
    assert.match(result.stderr, /restore-drill: PASS/)

    // The restored counts, export dataDigest and audit head match the backup moment.
    assert.match(json.checks.dataDigest.before, /^[0-9a-f]{64}$/)
    assert.equal(json.checks.dataDigest.after, json.checks.dataDigest.before)
    assert.equal(json.checks.dataDigest.equal, true)
    assert.notEqual(json.checks.dataDigest.mutated, json.checks.dataDigest.before)
    assert.equal(json.checks.audit.mutated > json.checks.audit.before, true)
    assert.equal(json.checks.audit.after, json.checks.audit.before + 1)
    assert.equal(json.checks.counts.commitsAfter, json.checks.counts.commitsBefore)
    assert.equal(json.checks.counts.kbDocumentsAfter, json.checks.counts.kbDocumentsBefore)
    assert.equal(json.checks.counts.commitsMutated, json.checks.counts.commitsBefore + 1)
    assert.equal(json.checks.counts.kbDocumentsMutated, 0)

    // The managed backup is real: bytes, sha256 + anchor sidecars, audit head.
    assert.ok(json.checks.backup.bytes > 0)
    assert.match(json.checks.backup.sha256, /^[0-9a-f]{64}$/)
    assert.equal(json.checks.backup.auditCount, json.checks.audit.before)
    assert.equal(json.checks.backup.anchorCount, json.checks.audit.before)
    assert.equal(json.checks.backup.anchorHeadHash, json.checks.audit.headHashBefore)

    // The restore had to time-travel deliberately, kept a pre-restore backup and
    // chained exactly one db.restore row on top of the restored audit chain.
    assert.equal(json.checks.restore.anchorBehindRefused, 'E_AUDIT_ANCHOR_BEHIND')
    assert.equal(json.checks.restore.auditRowSeq, json.checks.audit.before + 1)
    assert.match(json.checks.restore.preRestoreBackup, /-pre-restore\.db$/)
    assert.equal(json.checks.backupsVerify.managedOk, true)
    assert.equal(json.checks.backupsVerify.preRestorePresent, true)

    // doctor --check-db is the release gate for the restored database.
    assert.equal(json.checks.doctor.ok, true)
    assert.deepEqual(json.checks.doctor.failedChecks, [])
    assert.equal(json.checks.isolation.temporaryHome, true)
    assert.equal(json.checks.isolation.homeInsideOsTempDir, true)
  } finally {
    rmSync(sentinel.root, { recursive: true, force: true })
  }
})

test('restore drill: FAIL JSON + exit 1 when the CLI cannot run (home cleaned up)', { skip: WINDOWS_SKIP, timeout: STEP_TIMEOUT_MS }, () => {
  const sentinel = makeSentinel()
  try {
    const fakeCli = join(sentinel.root, 'fake-cli.mjs')
    writeFileSync(fakeCli, 'console.error("fake cli refuses")\nprocess.exit(7)\n', { mode: 0o600 })
    const { result, stdout, lines } = runDrill(['--bin', fakeCli], sentinel.home)
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstdout:\n${stdout}`)
    const json = parseJsonLine('failure path', stdout, lines)
    assert.equal(json.ok, false)
    assert.equal(json.status, 'FAIL')
    assert.equal(json.failedStep, 'init')
    assert.deepEqual(json.steps.map((step) => step.name), ['preflight'])
    assert.equal(json.error.code, 'E_CLI_EXIT')
    assert.equal(json.error.detail.exitCode, 7)
    assert.match(json.error.message, /exited 7/)
    assert.match(json.error.detail.stderr, /fake cli refuses/)
    assert.equal(json.cleanup.removed, true)
    assert.equal(existsSync(json.home), false, 'the temporary home was not deleted on failure')
    assert.equal(existsSync(sentinel.home), false, 'the inherited ADVISERS_HOME was created')
    assert.deepEqual(readdirSync(sentinel.root), ['fake-cli.mjs'], 'the inherited home parent was written to')
  } finally {
    rmSync(sentinel.root, { recursive: true, force: true })
  }
})

test('restore drill: usage errors are FAIL JSON with exit 1 and no temporary home', { skip: WINDOWS_SKIP, timeout: STEP_TIMEOUT_MS }, () => {
  const sentinel = makeSentinel()
  try {
    const { result, stdout, lines } = runDrill(['--bogus'], sentinel.home)
    assert.equal(result.status, 1)
    const json = parseJsonLine('usage error', stdout, lines)
    assert.equal(json.ok, false)
    assert.equal(json.status, 'FAIL')
    assert.equal(json.error.code, 'E_USAGE')
    assert.equal(json.failedStep, null)
    assert.deepEqual(json.steps, [])
    assert.equal(json.home, null)
    assert.equal(json.cleanup.removed, false)
    assert.equal(existsSync(sentinel.home), false)
    assert.deepEqual(readdirSync(sentinel.root), [])
  } finally {
    rmSync(sentinel.root, { recursive: true, force: true })
  }
})
