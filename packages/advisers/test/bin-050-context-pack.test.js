/**
 * 0.5.0 (050-C1/C2, 122 §3): `context-pack create|verify` CLI surface.
 *
 * Acceptance: candidates are a read-only look (no pack written); `--yes` writes a
 * pack whose manifest has no amount/body/filePath keys; offline verify is exit 0
 * and a tampered pack exits 1; verify needs no HOME (and is TOS-exempt on a clean
 * machine); `evidence verify` dispatches context → client → receipt; `import`
 * refuses a context pack explicitly.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const NL = String.fromCharCode(10)
const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1' }

function makeRoot() { return mkdtempSync(join(tmpdir(), 'advisers-050-pack-')) }
function run(home, args, extra = {}) {
  const env = { ...process.env, ...BASE_ENV, ADVISERS_HOME: home, ...extra }
  if (extra.ADVISERS_ACCEPT_TOS === undefined) delete env.ADVISERS_ACCEPT_TOS
  return spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', input: '', timeout: 120000 })
}
function ok(result, label) {
  assert.equal(result.status, 0, label + ': ' + (result.stderr || result.stdout))
  return result
}
function json(result) { return JSON.parse(result.stdout) }

function seed(home) {
  const accepted = { ADVISERS_ACCEPT_TOS: '1' }
  ok(run(home, ['init'], accepted), 'init')
  const client = json(ok(run(home, ['client', 'add', '王工', '--json'], accepted), 'client add')).client
  const matter = json(ok(run(home, ['matter', 'add', '官网改版', '--client', client.id, '--json'], accepted), 'matter add')).matter
  ok(run(home, ['commit', 'add', '发报价单', '--quote', '周五前发报价单', '--matter', matter.id, '--json'], accepted), 'commit add')
  ok(run(home, ['fact', 'add', '报价', '金额', '80000', '--quote', '报价 80000 元', '--matter', matter.id, '--json'], accepted), 'fact add')
  return { client, matter }
}

test('candidates are read-only; --yes writes a pack that verifies offline', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  const out = join(root, 'pack')
  try {
    const { client } = seed(home)
    const candidates = json(ok(run(home, ['context-pack', 'create', '--subject', 'client:' + client.id, '--json']), 'candidates'))
    assert.equal(candidates.ok, true)
    assert.equal(candidates.mode, 'candidates')
    assert.ok(Array.isArray(candidates.candidates) && candidates.candidates.length >= 2)
    assert.ok(candidates.excluded && candidates.excluded.byReason, 'candidate payload carries excluded counts')
    assert.equal(existsSync(join(home, 'exports')), false, 'candidate mode must not write a pack')
    assert.equal(existsSync(out), false)

    const created = json(ok(run(home, ['context-pack', 'create', '--subject', 'client:' + client.id, '--yes',
      '--recipient', 'Claude Code', '--purpose', 'external-review', '--out', out, '--json'], { ADVISERS_ACCEPT_TOS: '1' }), 'create'))
    assert.equal(created.ok, true)
    assert.equal(created.format, 'advisers-context-pack')
    assert.equal(created.version, 1)
    assert.equal(created.verificationBasis, 'local-checksums-only')
    assert.match(created.manifestDigest, /^[0-9a-f]{64}$/)
    assert.equal(created.disclosure.confersReadAuthority, false)
    assert.equal(created.disclosure.confersExecutionAuthority, false)

    // Forbidden keys never reach the manifest: no amount/body/file path data.
    const manifestText = readFileSync(join(out, 'manifest.json'), 'utf8')
    for (const key of ['"amount', '"paid', '"outstanding', '"currency', '"body', '"html', '"attachments', '"fileBytes', '"filePath']) {
      assert.equal(manifestText.includes(key), false, 'manifest must not contain ' + key)
    }

    const verified = ok(run(home, ['context-pack', 'verify', out, '--json']), 'verify')
    const verifyPayload = json(verified)
    assert.equal(verifyPayload.ok, true)
    assert.equal(verifyPayload.format, 'advisers-context-pack')
    assert.equal(verifyPayload.manifestDigest, created.manifestDigest)

    // The third `evidence verify` dispatch knows the context format.
    const viaEvidence = ok(run(home, ['evidence', 'verify', out, '--json']), 'evidence verify dispatch')
    assert.equal(json(viaEvidence).format, 'advisers-context-pack')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('offline verify is exit 0/1, TOS-exempt and needs no HOME', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  const out = join(root, 'pack')
  const cleanHome = join(root, 'clean-home')
  try {
    const { client } = seed(home)
    ok(run(home, ['context-pack', 'create', '--subject', 'client:' + client.id, '--yes', '--recipient', 'Claude Code',
      '--purpose', 'client-delivery', '--out', out], { ADVISERS_ACCEPT_TOS: '1' }), 'create')
    // A clean machine without a TOS record: verify must still work and write nothing.
    const clean = ok(run(cleanHome, ['context-pack', 'verify', out, '--json']), 'clean-machine verify')
    assert.equal(json(clean).ok, true)
    assert.equal(existsSync(cleanHome), false, 'offline verify must not create HOME')

    const wrongSha = run(home, ['context-pack', 'verify', out, '--expect-manifest-sha256', '0'.repeat(64), '--json'])
    assert.equal(wrongSha.status, 1)
    const wrongPayload = json(wrongSha)
    assert.equal(wrongPayload.ok, false)
    assert.equal(wrongPayload.code, 'E_CONTEXT_PACK_DIGEST_MISMATCH')
    assert.equal(wrongPayload.matchesExpected, false)

    writeFileSync(join(out, 'manifest.json'), readFileSync(join(out, 'manifest.json'), 'utf8') + ' ')
    const tampered = run(home, ['context-pack', 'verify', out, '--json'])
    assert.equal(tampered.status, 1)
    assert.equal(json(tampered).ok, false)

    const extra = join(out, 'extra.txt')
    writeFileSync(extra, 'x')
    const withExtra = run(home, ['context-pack', 'verify', out, '--json'])
    assert.equal(withExtra.status, 1)
    assert.equal(json(withExtra).ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('create fails closed without recipient/purpose and import refuses a context pack', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  const out = join(root, 'pack')
  try {
    const { client } = seed(home)
    const missingRecipient = run(home, ['context-pack', 'create', '--subject', 'client:' + client.id, '--yes',
      '--purpose', 'external-review', '--out', out, '--json'], { ADVISERS_ACCEPT_TOS: '1' })
    assert.equal(missingRecipient.status, 1)
    assert.equal(json(missingRecipient).ok, false)
    assert.equal(existsSync(out), false, 'a failed create must not write a pack')

    ok(run(home, ['context-pack', 'create', '--subject', 'client:' + client.id, '--yes', '--recipient', 'Claude Code',
      '--purpose', 'client-delivery', '--out', out], { ADVISERS_ACCEPT_TOS: '1' }), 'create')
    const refused = run(home, ['import', out, '--replace'])
    assert.equal(refused.status, 1, 'import must refuse a context pack')
    assert.match(refused.stderr, /context pack/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
