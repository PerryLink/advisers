/**
 * 0.4.x follow-up CLI wiring: kb/mail review links, quiet-hours delivery policy,
 * notification dedupe and --force-notify.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { SqliteStore } from '../lib/sqlite.js'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const NOW = '2026-11-21T10:00:00+08:00'

function setup(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-040-follow-' + prefix + '-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return { root, home, work }
}
function run(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra }),
    encoding: 'utf8', input: '', timeout: 120000,
  })
}
function ok(home, args, extra = {}) {
  const result = run(home, args, extra)
  assert.equal(result.status, 0, args.join(' ') + ' failed: ' + result.stderr)
  return result.stdout
}
function json(home, args, extra = {}) { return JSON.parse(ok(home, args, extra)) }

test('kb link/unlink are wired and validate fact/document ids', () => {
  const { root, home, work } = setup('kb-link')
  try {
    ok(home, ['init'])
    const file = join(work, 'note.md')
    writeFileSync(file, '# 报价单\n客户报价 8 万元，周五前确认。\n')
    const added = json(home, ['kb', 'add', file, '--title', '报价', '--json'])
    const docId = added.added[0].id
    const store = new SqliteStore(join(home, 'state.db'))
    try {
      const now = new Date(NOW).toISOString()
      store.mutate(() => {
        store.insertFact({ id: 'fact_follow_1', subject: 'client:demo', predicate: 'quote', object: '8w', matterId: null, recordedAt: now, authority: 'user', confidence: 0.9, status: 'confirmed', validFrom: now })
        store.insertFact({ id: 'fact_follow_2', subject: 'client:demo', predicate: 'term', object: 'friday', matterId: null, recordedAt: now, authority: 'user', confidence: 0.9, status: 'confirmed', validFrom: now })
      })
    } finally { store.close() }
    const linked = json(home, ['kb', 'link', docId, '--fact', 'fact_follow_1', '--json'])
    assert.equal(linked.ok, true)
    assert.equal(linked.link.factId, 'fact_follow_1')
    const rejected = run(home, ['kb', 'link', docId, '--fact', 'fact_missing', '--json'])
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /E_FACT_NOT_FOUND/)
    const unlinked = json(home, ['kb', 'unlink', docId, '--fact', 'fact_follow_1', '--json'])
    assert.equal(unlinked.removed, 1)
    assert.match(ok(home, ['kb', 'help']), /kb link/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('mail link/dismiss are wired on an imported message', () => {
  const { root, home, work } = setup('mail-link')
  try {
    ok(home, ['init'])
    const client = json(home, ['client', 'add', '王工', '--json'])
    const clientId = client.client.id
    const eml = join(work, 'quote.eml')
    writeFileSync(eml, [
      'From: wang@example.com',
      'To: me@example.com',
      'Subject: 报价确认',
      'Date: Fri, 21 Nov 2026 09:00:00 +0800',
      'Message-ID: <followup@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '周五前确认报价单。',
      '',
    ].join('\r\n'))
    json(home, ['mail', 'import', eml, '--json'])
    const messages = json(home, ['mail', 'ls', '--json']).messages
    assert.ok(messages.length >= 1)
    const id = messages[0].id
    const linked = json(home, ['mail', 'link', id, '--client', clientId, '--json'])
    assert.equal(linked.message.status, 'linked')
    assert.equal(linked.message.clientId, clientId)
    const dismissed = json(home, ['mail', 'dismiss', id, '--json'])
    assert.equal(dismissed.message.status, 'dismissed')
    assert.match(ok(home, ['mail', 'help']), /mail link/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('remind --deliver honors quiet hours, dedupes per local day and --force-notify', () => {
  const { root, home } = setup('deliver-policy')
  try {
    ok(home, ['init'])
    ok(home, ['commit', 'add', '交周报', '--quote', 'q', '--due', '2026-11-21T09:00:00+08:00'])
    const quiet = ok(home, ['remind', '--deliver', '--notify', '--now', '2026-11-21T23:00:00+08:00', '--quiet-hours', '22:00-08:00'])
    assert.match(quiet, /quiet-suppressed/)
    assert.match(quiet, /通知已静默/)
    const first = ok(home, ['remind', '--deliver', '--notify', '--now', NOW])
    assert.match(first, /通知通道：/)
    assert.doesNotMatch(first, /deduped|quiet-suppressed/)
    const second = ok(home, ['remind', '--deliver', '--notify', '--now', NOW])
    assert.match(second, /deduped/)
    const forced = ok(home, ['remind', '--deliver', '--notify', '--now', NOW, '--force-notify'])
    assert.doesNotMatch(forced, /deduped|quiet-suppressed/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
