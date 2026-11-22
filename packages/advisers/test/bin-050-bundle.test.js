/**
 * 0.5.0 (050-B1/B2, 126 门 1): `export --bundle` / `import --bundle` wiring.
 *
 * The lib-level format tests live in test/bundle-*.test.js; this file drives the
 * CLI surface through the real bin: a clean-home round trip compares dataDigest,
 * the verify/dry-run pair is a zero-write TOS-exempt plan, a tampered bundle is
 * refused with zero writes, and the legacy export/import path is unchanged.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1' }

function makeDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}
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
  try { return JSON.parse(result.stdout) } catch (error) { throw new Error('not JSON: ' + result.stdout.slice(0, 400) + ' / ' + result.stderr) }
}

test('bundle v1 round trip: dataDigest parity on a clean home, dry-run is zero write', () => {
  const root = makeDir('advisers-050-bundle-')
  const h1 = join(root, 'h1')
  const h2 = join(root, 'h2')
  const bundleDir = join(root, 'bundle')
  mkdirSync(h2)
  try {
    const seed = run(h1, ['commit', 'add', '发报价单', '--quote', '周五前发报价单', '--json'], { ADVISERS_ACCEPT_TOS: '1' })
    ok(seed, 'seed commit')
    const exported = ok(run(h1, ['export', '--bundle', bundleDir, '--json'], { ADVISERS_ACCEPT_TOS: '1' }), 'export --bundle')
    const exp = json(exported)
    assert.equal(exp.ok, true)
    assert.equal(exp.mode, 'bundle')
    assert.equal(exp.verificationBasis, 'local-checksums-only')
    assert.match(exp.dataDigest, /^[0-9a-f]{64}$/)
    const bundleLedger = JSON.parse(readFileSync(join(bundleDir, 'ledger.json'), 'utf8'))
    assert.equal(bundleLedger.ledger.commitments.length, 1)
    assert.ok(Array.isArray(exp.tables) && exp.tables.length > 0)
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.format, 'advisers-bundle')
    assert.equal(manifest.dataDigest, exp.dataDigest)

    // TOS-exempt plan on a clean machine: verifies the directory, writes nothing.
    const dry = ok(run(h2, ['import', '--bundle', bundleDir, '--verify', '--dry-run', '--json']), 'import dry-run')
    const dryPayload = json(dry)
    assert.equal(dryPayload.ok, true)
    assert.equal(dryPayload.dryRun, true)
    assert.equal(dryPayload.dataDigest, exp.dataDigest)
    assert.deepEqual(readdirSync(h2), [], 'dry-run must not create HOME')

    const imported = ok(run(h2, ['import', '--bundle', bundleDir, '--verify', '--json'], { ADVISERS_ACCEPT_TOS: '1' }), 'import --bundle')
    const imp = json(imported)
    assert.equal(imp.ok, true)
    assert.equal(imp.dataDigest, exp.dataDigest)
    ok(run(h2, ['doctor', '--check-db', '--json']), 'doctor after import')

    // Exporting the imported home again must produce the same dataDigest.
    const bundle2 = join(root, 'bundle2')
    const reexport = json(ok(run(h2, ['export', '--bundle', bundle2, '--json'], { ADVISERS_ACCEPT_TOS: '1' }), 're-export'))
    assert.equal(reexport.dataDigest, exp.dataDigest, 'dataDigest parity after a clean-home round trip')
    assert.deepEqual(reexport.counts, exp.counts, 'counts parity after a clean-home round trip')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('bundle flags fail closed: --encrypted unsupported, tampered bundle refused with zero writes', () => {
  const root = makeDir('advisers-050-bundle-neg-')
  const h1 = join(root, 'h1')
  const h2 = join(root, 'h2')
  const bundleDir = join(root, 'bundle')
  mkdirSync(h2)
  try {
    ok(run(h1, ['commit', 'add', 'x', '--quote', 'q'], { ADVISERS_ACCEPT_TOS: '1' }), 'seed')
    ok(run(h1, ['export', '--bundle', bundleDir], { ADVISERS_ACCEPT_TOS: '1' }), 'export')
    const encrypted = run(h1, ['export', '--bundle', join(root, 'b2'), '--encrypted', '--json'], { ADVISERS_ACCEPT_TOS: '1' })
    assert.equal(encrypted.status, 1)
    assert.match(encrypted.stderr, /plaintext|encrypted/i)

    // Tamper with one bundle file: verify must fail and the target home stay empty.
    const tampered = join(root, 'tampered')
    cpSync(bundleDir, tampered, { recursive: true })
    const ledgerPath = join(tampered, 'ledger.json')
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8') + ' ')
    const refused = run(h2, ['import', '--bundle', tampered, '--verify', '--dry-run', '--json'])
    assert.equal(refused.status, 1, 'a tampered bundle must be refused')
    const payload = json(refused)
    assert.equal(payload.ok, false)
    assert.match(String(payload.code), /^E_BUNDLE_/)
    assert.deepEqual(readdirSync(h2), [], 'a refused import must not write HOME')

    // A bundle target that is a non-empty directory without --force is refused.
    const nonEmpty = join(root, 'exists')
    ok(run(h1, ['export', '--bundle', nonEmpty], { ADVISERS_ACCEPT_TOS: '1' }), 'first export')
    const again = run(h1, ['export', '--bundle', nonEmpty, '--json'], { ADVISERS_ACCEPT_TOS: '1' })
    assert.equal(again.status, 1, 'non-empty target without --force must be refused')
    const againPayload = json(again)
    assert.equal(againPayload.ok, false)
    assert.equal(againPayload.code, 'E_BUNDLE_TARGET')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('real import requires TOS acceptance (exit 3, zero writes) while the verify/dry-run plan does not', () => {
  const root = makeDir('advisers-050-bundle-tos-')
  const h1 = join(root, 'h1')
  const h2 = join(root, 'h2')
  const bundleDir = join(root, 'bundle')
  try {
    ok(run(h1, ['commit', 'add', 'x', '--quote', 'q'], { ADVISERS_ACCEPT_TOS: '1' }), 'seed')
    ok(run(h1, ['export', '--bundle', bundleDir], { ADVISERS_ACCEPT_TOS: '1' }), 'export')
    const refused = run(h2, ['import', '--bundle', bundleDir, '--verify'])
    assert.equal(refused.status, 3, 'non-TTY import without TOS acceptance must exit 3')
    assert.equal(refused.stdout, '')
    assert.match(refused.stderr, /E_TOS_REQUIRED/)
    // The same command with the dry-run plan is exempt (offline verification).
    ok(run(h2, ['import', '--bundle', bundleDir, '--verify', '--dry-run']), 'exempt dry-run')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('legacy export --all / import <file> bytes are unchanged', () => {
  const root = makeDir('advisers-050-legacy-')
  const h1 = join(root, 'h1')
  const h2 = join(root, 'h2')
  const exportFile = join(root, 'export.json')
  try {
    ok(run(h1, ['commit', 'add', '旧路径', '--quote', 'q'], { ADVISERS_ACCEPT_TOS: '1' }), 'seed')
    const exported = ok(run(h1, ['export', '--all', '--out', exportFile], { ADVISERS_ACCEPT_TOS: '1' }), 'export --all')
    assert.match(exported.stdout, /wrote /)
    const payload = JSON.parse(readFileSync(exportFile, 'utf8'))
    assert.equal(typeof payload.ledger, 'object')
    assert.equal(typeof payload.data, 'object')
    assert.equal(payload.schemaVersion, 22)
    const imported = ok(run(h2, ['import', exportFile, '--replace'], { ADVISERS_ACCEPT_TOS: '1' }), 'legacy import')
    assert.match(imported.stdout, /imported 1 matters/)
    // A bundle/context-pack directory is refused by the legacy verb with a hint.
    const dir = join(root, 'bundle')
    ok(run(h1, ['export', '--bundle', dir], { ADVISERS_ACCEPT_TOS: '1' }), 'bundle for refusal')
    const refused = run(h2, ['import', dir, '--replace'], { ADVISERS_ACCEPT_TOS: '1' })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /import --bundle/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})