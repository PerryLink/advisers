/**
 * 0.3.0 Wave 2: `status --json` contracts discovery field, the top-level
 * `auditAnchor` in `export --all`, and the P0-S3 TOS env hardening.
 *
 * These assert the user-visible contract the docs/consumers rely on, not the
 * lib internals (covered by contracts/check-contracts and lib/tos tests).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { auditJson, bin, cleanup, makeHome, runCli, runOk, seedCommitment } from './bin-ops-fixture.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../lib/tos/manifest.json', import.meta.url)), 'utf8'))
const MANIFEST_VERSION = manifest.version
const CONTRACT_EXPECTED = JSON.parse(readFileSync(join(repoRoot, 'contracts/versions-v1.json'), 'utf8')).discovery.expected

/** Fresh-home spawn WITHOUT a seeded TOS acceptance record. */
function freshRun(home, args, extra = {}) {
  const env = { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_STORE: 'sqlite', ADVISERS_NO_MODEL: '1' }
  delete env.ADVISERS_ACCEPT_TOS
  delete env.ADVISERS_TOS_VERSION
  delete env.ADVISERS_AUDIT_KEY
  return spawnSync(process.execPath, [bin, ...args], { env: { ...env, ...extra }, encoding: 'utf8' })
}

function tosRecord(home) {
  return JSON.parse(readFileSync(join(home, 'tos.json'), 'utf8'))
}

test('status --json: works on a fresh home without consent and exposes the frozen contracts discovery object', () => {
  const { root, home } = makeHome('status-contracts')
  try {
    const result = freshRun(home, ['status', '--json'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(home, 'tos.json')), false, 'status must never record TOS acceptance')
    const payload = JSON.parse(result.stdout)
    assert.deepEqual(payload.contracts, CONTRACT_EXPECTED)
    assert.equal(payload.contracts.mcpProtocol, '2024-11-05')
    for (const key of ['cliJson', 'errors', 'exitCodes', 'mcpTools', 'mcpResources', 'dshTools', 'petBrief']) {
      assert.equal(typeof payload.contracts[key], 'number', key)
    }
    const bad = freshRun(home, ['status', '--bogus'])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /E_USAGE/)
  } finally { cleanup(root) }
})

test('export --all: the JSON payload carries a top-level auditAnchor matching the current audit head', () => {
  const { root, home } = makeHome('export-anchor')
  try {
    seedCommitment(home)
    const audit = auditJson(home)
    const exported = JSON.parse(runOk(home, ['export', '--all']).stdout)
    assert.ok(exported.auditAnchor, 'export --all must carry auditAnchor')
    assert.equal(exported.auditAnchor.count, audit.head.count)
    assert.equal(exported.auditAnchor.headHash, audit.head.headHash)
    assert.equal(exported.auditAnchor.format, 'advisers-audit-anchor')
    assert.match(exported.auditAnchor.hmac, /^[0-9a-f]{64}$/)
    assert.ok(existsSync(join(home, 'audit-anchor.json')), 'export --all refreshes the local anchor baseline')
    const outFile = join(root, 'export-all.json')
    runOk(home, ['export', '--all', '--out', outFile])
    const filePayload = JSON.parse(readFileSync(outFile, 'utf8'))
    assert.ok(filePayload.auditAnchor)
    assert.equal(filePayload.auditAnchor.count, audit.head.count)
    assert.ok(Array.isArray(filePayload.data.audit))
  } finally { cleanup(root) }
})

test('TOS P0-S3: ADVISERS_TOS_VERSION cannot fake consent or change the recorded/effective version', () => {
  const { root, home } = makeHome('tos-env')
  try {
    // First-run acceptance under a forged env version records the packaged version.
    const first = freshRun(home, ['commit', 'add', '发报价', '--quote', 'q'], { ADVISERS_TOS_VERSION: '2099.1.1', ADVISERS_ACCEPT_TOS: '1' })
    assert.equal(first.status, 0, first.stderr)
    assert.equal(tosRecord(home).version, MANIFEST_VERSION)

    // `tos status` reports the real version and exposes the ignored override.
    const status = JSON.parse(runOk(home, ['tos', 'status', '--json'], { ADVISERS_TOS_VERSION: '2099.1.1' }).stdout)
    assert.equal(status.version, MANIFEST_VERSION)
    assert.equal(status.manifestVersion, MANIFEST_VERSION)
    assert.equal(status.accepted, true)
    assert.equal(status.acceptance.version, MANIFEST_VERSION)
    assert.deepEqual(status.envOverride, { set: true, ignored: true, requestedVersion: '2099.1.1', manifestVersion: MANIFEST_VERSION })
    const real = JSON.parse(runOk(home, ['tos', 'status', '--json']).stdout)
    assert.equal(real.accepted, true, 'the forged env version must not invalidate a real acceptance')
    assert.equal(real.envOverride.set, false)

    // The ignored override is audited once per process with a stable event tag.
    const raw = new DatabaseSync(join(home, 'state.db'), { readOnly: true })
    const ignored = raw.prepare("SELECT seq, action, allowed, reason FROM audit WHERE action = 'tos.env_override_ignored' ORDER BY seq").all()
    raw.close()
    assert.ok(ignored.length >= 1, 'the ignored override must be audited')
    assert.equal(ignored[ignored.length - 1].allowed, 0)
    assert.match(ignored[ignored.length - 1].reason, /TOS_ENV_OVERRIDE_IGNORED/)
    assert.match(ignored[ignored.length - 1].reason, new RegExp('manifestVersion=' + MANIFEST_VERSION.replace(/\./g, '\\.')))

    // Revoked + env only: the gate still blocks (env is not consent).
    runOk(home, ['tos', 'revoke', '--yes'])
    const blocked = freshRun(home, ['commit', 'ls'], { ADVISERS_TOS_VERSION: '2099.1.1' })
    assert.equal(blocked.status, 3)
    assert.match(blocked.stderr, /E_TOS_REQUIRED/)

    // `tos show --as-version` is an explicit display-only debug switch: it never
    // rewrites the acceptance record.
    const recordBefore = tosRecord(home)
    const shown = runOk(home, ['tos', 'show', '--as-version', '2099.1.1'])
    assert.match(shown.stdout, /Advisers 使用条款 v2099\.1\.1/)
    assert.match(shown.stderr, /debug view only/)
    assert.deepEqual(tosRecord(home), recordBefore)
  } finally { cleanup(root) }
})

test('privacy: the JSON facts expose the audit anchor and --prove warns (yellow) when none is recorded', () => {
  const { root, home } = makeHome('privacy-anchor')
  try {
    seedCommitment(home)
    const facts = JSON.parse(runOk(home, ['privacy', '--json']).stdout)
    assert.equal(facts.auditAnchor.found, false)
    assert.equal(facts.auditAnchor.status, 'absent')
    const prove = runOk(home, ['privacy', '--prove']).stdout
    assert.match(prove, /\[WARN\] audit anchor absent/)
    assert.match(prove, /anchor: +absent/)
    runOk(home, ['audit', '--write-anchor'])
    const anchored = JSON.parse(runOk(home, ['privacy', '--json']).stdout)
    assert.equal(anchored.auditAnchor.found, true)
    assert.equal(anchored.auditAnchor.status, 'match')
  } finally { cleanup(root) }
})
