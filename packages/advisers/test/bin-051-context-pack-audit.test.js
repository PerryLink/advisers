/**
 * 0.5.1 (051-M8, plan 202 A4 / 210 M8): context-pack create records one
 * context_pack.create audit row (the local disclosure receipt).
 *
 * Acceptance: the candidate look still writes no audit; writing a pack appends a
 * single allowed row whose reason names subject/purpose/items/manifestDigest and
 * a recipient hash but never the recipient name/email; --json carries the same
 * audit object and the human output names the action.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1' }

function makeRoot() { return mkdtempSync(join(tmpdir(), 'advisers-051-cpaudit-')) }
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
function auditEntries(home) {
  return json(ok(run(home, ['audit', '--json']), 'audit --json')).entries ?? []
}

function seed(home) {
  const accepted = { ADVISERS_ACCEPT_TOS: '1' }
  ok(run(home, ['init'], accepted), 'init')
  const client = json(ok(run(home, ['client', 'add', '王工', '--json'], accepted), 'client add')).client
  const matter = json(ok(run(home, ['matter', 'add', '官网改版', '--client', client.id, '--json'], accepted), 'matter add')).matter
  ok(run(home, ['commit', 'add', '发报价单', '--quote', '周五前发报价单', '--matter', matter.id, '--json'], accepted), 'commit add')
  return { client, matter }
}

test('candidate look writes no audit; a written pack appends one context_pack.create row', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  const out = join(root, 'pack')
  try {
    const { client } = seed(home)
    const before = auditEntries(home).length
    const candidates = json(ok(run(home, ['context-pack', 'create', '--subject', 'client:' + client.id, '--json']), 'candidates'))
    assert.equal(candidates.ok, true)
    assert.equal(candidates.mode, 'candidates')
    assert.equal(auditEntries(home).length, before, 'the candidate look must not write an audit row')

    const created = json(ok(run(home, ['context-pack', 'create', '--subject', 'client:' + client.id, '--yes',
      '--recipient', 'Claude Code', '--recipient-email', 'ops@example.com', '--purpose', 'external-review',
      '--out', out, '--json']), 'create'))
    assert.equal(created.ok, true)
    assert.equal(created.audit.ok, true)
    assert.equal(created.audit.action, 'context_pack.create')
    assert.equal(created.audit.items, created.disclosure.itemCount)
    assert.equal(created.audit.manifestDigest, created.manifestDigest)
    assert.match(created.audit.recipientHash, /^[0-9a-f]{64}$/)
    for (const secret of ['Claude Code', 'ops@example.com']) {
      assert.equal(JSON.stringify(created.audit).includes(secret), false, 'audit must not carry the recipient ' + secret)
    }

    const entries = auditEntries(home)
    const rows = entries.filter((entry) => entry.action === 'context_pack.create')
    assert.equal(rows.length, 1, 'exactly one context_pack.create row')
    assert.equal(rows[0].allowed, true)
    assert.match(rows[0].reason, /purpose=external-review/)
    assert.match(rows[0].reason, /manifestDigest=[0-9a-f]{64}/)
    assert.match(rows[0].reason, /recipientHash=[0-9a-f]{64}/)
    assert.equal(rows[0].reason.includes('Claude Code'), false)
    assert.equal(rows[0].reason.includes('ops@example.com'), false)

    const verify = json(ok(run(home, ['context-pack', 'verify', out, '--json']), 'verify'))
    assert.equal(verify.ok, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('human create output names the audit action', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  try {
    const { client } = seed(home)
    const created = ok(run(home, ['context-pack', 'create', '--subject', 'client:' + client.id, '--yes',
      '--recipient', 'Claude Code', '--purpose', 'client-delivery', '--out', join(root, 'pack')]))
    assert.match(created.stdout, /audit: context_pack.create/)
    assert.match(created.stdout, /manifestDigest=/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

/** Re-sign a pack after editing manifest.expiresAt into the past (test-only). */
function expirePack(dir) {
  const manifestPath = join(dir, 'manifest.json')
  const text = readFileSync(manifestPath, 'utf8')
  const escaped = text.replace(/"expiresAt":\s*"[^"]+"/, '"expiresAt": "2020-01-01T00:00:00.000Z"')
  assert.notEqual(escaped, text, 'the pack manifest carries expiresAt')
  writeFileSync(manifestPath, escaped)
  const sums = ['manifest.json', 'README.txt'].map((name) =>
    createHash('sha256').update(readFileSync(join(dir, name))).digest('hex') + '  ' + name).join('\n') + '\n'
  writeFileSync(join(dir, 'SHA256SUMS'), sums)
}

test('verify surfaces expiry as a warning without changing the 0/1 result', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  const out = join(root, 'pack')
  try {
    const { client } = seed(home)
    ok(run(home, ['context-pack', 'create', '--subject', 'client:' + client.id, '--yes',
      '--recipient', 'Claude Code', '--purpose', 'external-review', '--out', out, '--json']), 'create')
    expirePack(out)
    const verified = json(ok(run(home, ['context-pack', 'verify', out, '--json']), 'verify expired'))
    assert.equal(verified.ok, true, 'an expired disclosure record still verifies')
    assert.equal(verified.expired, true)
    assert.equal(verified.expiresAt, '2020-01-01T00:00:00.000Z')
    assert.ok((verified.warnings ?? []).some((line) => /expired/i.test(String(line))))
    const human = ok(run(home, ['context-pack', 'verify', out]), 'human verify expired')
    assert.match(human.stdout, /expiresAt=2020-01-01T00:00:00\.000Z/)
    assert.match(human.stdout, /已过期/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
