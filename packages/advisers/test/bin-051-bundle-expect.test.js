/**
 * 0.5.1 (051-M7, plan 201 A5 / 126 five): `import --bundle --verify --expect-dataDigest`.
 *
 * Lib-level verify/import coverage lives in test/bundle-*.test.js; this file drives
 * the CLI surface: a matching expected digest accepts the bundle (a dry-run writes
 * nothing), a mismatching digest is refused with exit 1 and zero writes, and a
 * malformed hex value is E_USAGE. TOS keeps the frozen 0/1/3 matrix.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1' }

function makeDir(prefix) { return mkdtempSync(join(tmpdir(), prefix)) }
function run(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home, ...extra },
    encoding: 'utf8', input: '', timeout: 120000,
  })
}
function ok(result, label) {
  assert.equal(result.status, 0, label + ': ' + (result.stderr || result.stdout))
  return result
}
function json(result) {
  try { return JSON.parse(result.stdout) }
  catch (error) { throw new Error('not JSON: ' + result.stdout.slice(0, 400) + ' / ' + result.stderr) }
}

/** One seeded source home + a plaintext bundle exported from it. */
function seedBundle(root) {
  const h1 = join(root, 'h1')
  const bundleDir = join(root, 'bundle')
  ok(run(h1, ['commit', 'add', '发报价单', '--quote', '周五前发报价单', '--json'], { ADVISERS_ACCEPT_TOS: '1' }), 'seed commit')
  const exported = json(ok(run(h1, ['export', '--bundle', bundleDir, '--json'], { ADVISERS_ACCEPT_TOS: '1' }), 'export'))
  assert.match(exported.dataDigest, /^[0-9a-f]{64}$/)
  return { bundleDir, dataDigest: exported.dataDigest }
}

test('expectDataDigest match: the dry-run plan writes nothing and the import reports match', () => {
  const root = makeDir('advisers-051-bex-')
  const h2 = join(root, 'h2')
  mkdirSync(h2)
  try {
    const { bundleDir, dataDigest } = seedBundle(root)
    const dry = json(ok(run(h2, ['import', '--bundle', bundleDir, '--verify', '--dry-run', '--expect-dataDigest', dataDigest, '--json']), 'dry-run expect match'))
    assert.equal(dry.ok, true)
    assert.equal(dry.dryRun, true)
    assert.equal(dry.dataDigest, dataDigest)
    assert.equal(dry.expectedDigest, dataDigest)
    assert.equal(dry.dataDigestMatch, true)
    assert.deepEqual(readdirSync(h2), [], 'a dry-run plan must not create HOME')

    const imported = json(ok(run(h2, ['import', '--bundle', bundleDir, '--verify', '--expect-dataDigest', dataDigest, '--json'], { ADVISERS_ACCEPT_TOS: '1' }), 'import expect match'))
    assert.equal(imported.ok, true)
    assert.equal(imported.expectedDigest, dataDigest)
    assert.equal(imported.dataDigestMatch, true)
    const reexport = json(ok(run(h2, ['export', '--bundle', join(root, 'bundle2'), '--json'], { ADVISERS_ACCEPT_TOS: '1' }), 're-export'))
    assert.equal(reexport.dataDigest, dataDigest, 'dataDigest parity after the expect-checked import')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('expectDataDigest mismatch: exit 1, E_BUNDLE_TAMPERED and zero writes', () => {
  const root = makeDir('advisers-051-bex-neg-')
  const h2 = join(root, 'h2')
  mkdirSync(h2)
  const wrong = '0'.repeat(64)
  try {
    const { bundleDir } = seedBundle(root)
    const result = run(h2, ['import', '--bundle', bundleDir, '--verify', '--dry-run', '--expect-dataDigest', wrong, '--json'])
    assert.equal(result.status, 1)
    const payload = json(result)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'E_BUNDLE_TAMPERED')
    assert.equal(payload.expectedDigest, wrong)
    assert.equal(payload.dataDigestMatch, false)
    assert.ok((payload.errors ?? []).some((line) => /expected|does not match/i.test(String(line))))
    assert.deepEqual(readdirSync(h2), [], 'a digest mismatch must not write HOME')

    const human = run(h2, ['import', '--bundle', bundleDir, '--verify', '--dry-run', '--expect-dataDigest', wrong])
    assert.equal(human.status, 1)
    assert.match(human.stderr, /expected|does not match/i)
    assert.deepEqual(readdirSync(h2), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('expectDataDigest is strict: malformed hex is E_USAGE and the gated form keeps exit 3', () => {
  const root = makeDir('advisers-051-bex-usage-')
  const home = join(root, 'home')
  mkdirSync(home)
  try {
    const { bundleDir } = seedBundle(root)
    const bad = run(home, ['import', '--bundle', bundleDir, '--verify', '--dry-run', '--expect-dataDigest', 'not-a-digest', '--json'])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /E_USAGE/)
    assert.deepEqual(readdirSync(home), [], 'a usage error must not write HOME')

    const gated = run(home, ['import', '--bundle', bundleDir, '--dry-run', '--expect-dataDigest', '0'.repeat(64), '--json'])
    assert.equal(gated.status, 3, 'without --verify the dry-run is not the TOS-exempt plan')
    assert.match(gated.stderr, /E_TOS_REQUIRED/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
