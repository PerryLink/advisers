/**
 * 0.4.x follow-up CLI wiring: manual fact entry, read-only mail account probe,
 * sync pull --dry-run and the foreground mail watch loop.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function setup(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-042-' + prefix + '-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return { root, home, work }
}
function env(home, extra = {}) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra })
}
function run(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8', input: '', timeout: 120000 })
}
function ok(home, args, extra = {}) {
  const result = run(home, args, extra)
  assert.equal(result.status, 0, args.join(' ') + ' failed: ' + result.stderr)
  return result.stdout
}
function json(home, args, extra = {}) { return JSON.parse(ok(home, args, extra)) }
function sha(file) { return createHash('sha256').update(readFileSync(file)).digest('hex') }

test('fact add writes a user-authority confirmed fact with evidence and is idempotent', () => {
  const { root, home } = setup('fact-add')
  try {
    ok(home, ['init'])
    const added = json(home, ['fact', 'add', '客户:王工', '预算', '8万', '--quote', '王工说预算 8 万', '--json'])
    assert.equal(added.fact.authority, 'user')
    assert.equal(added.fact.status, 'confirmed')
    assert.equal(added.fact.evidence[0].quote, '王工说预算 8 万')
    assert.match(added.fact.id, /^fact_[0-9a-f]{16}$/)
    const again = json(home, ['fact', 'add', '客户:王工', '预算', '8万', '--quote', '王工说预算 8 万', '--json'])
    assert.equal(again.deduped, true)
    assert.equal(again.fact.id, added.fact.id)
    const shown = json(home, ['fact', 'show', added.fact.id, '--json'])
    assert.equal(shown.fact.id, added.fact.id)
    const missingQuote = run(home, ['fact', 'add', 'a', 'b', 'c'])
    assert.equal(missingQuote.status, 1)
    assert.match(missingQuote.stderr, /--quote is required/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('mail account test rejects the local .eml account without any network', () => {
  const { root, home, work } = setup('mail-test')
  try {
    ok(home, ['init'])
    const eml = join(work, 'a.eml')
    // tosEnv sets TOS acceptance; mail import needs a file, not a mailbox.
    writeFileSync(eml, [
      'From: a@example.com',
      'To: me@example.com',
      'Subject: hi',
      'Date: Fri, 21 Nov 2026 09:00:00 +0800',
      'Message-ID: <a@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'hello',
      '',
    ].join('\r\n'))
    json(home, ['mail', 'import', eml, '--json'])
    const result = run(home, ['mail', 'account', 'test', 'acct_local_eml', '--json'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /E_MAIL_CONFIG/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('mail sync --watch fails fast on an empty home and validates its interval', () => {
  const { root, home } = setup('mail-watch')
  try {
    ok(home, ['init'])
    // 0.4.3: an empty account list is a startup configuration error, not an
    // empty round; the detailed watch summary is covered by bin-043 tests.
    const result = run(home, ['mail', 'sync', '--watch', '--max-runs', '1', '--json'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /E_MAIL_CONFIG/)
    const bad = run(home, ['mail', 'sync', '--watch', '--interval', 'nope'])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /--interval/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('sync pull --dry-run predicts without replacing the database', () => {
  const { root, home } = setup('sync-dry')
  const dir = join(root, 'sync')
  try {
    ok(home, ['init'])
    ok(home, ['commit', 'add', '测试事项', '--quote', 'q'])
    const pass = { ADVISERS_SYNC_PASSPHRASE: 'test-passphrase' }
    ok(home, ['sync', 'push', '--dir', dir], pass)
    const before = sha(join(home, 'state.db'))
    const out = ok(home, ['sync', 'pull', '--dir', dir, '--dry-run'], pass)
    assert.match(out, /dry-run:/)
    assert.equal(sha(join(home, 'state.db')), before)
    const payload = json(home, ['sync', 'pull', '--dir', dir, '--dry-run', '--json'], pass)
    assert.equal(payload.dryRun, true)
    assert.equal(payload.changed, false)
    assert.equal(payload.wouldChange, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
