import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SqliteStore, openReadStore } from '../lib/sqlite.js'
import {
  CONTEXT_PACK_AUDIT_ACTION,
  CONTEXT_PACK_ITEM_VERIFICATION_BASIS,
  buildContextPack,
  contextPackRecipientHash,
  createContextPack,
  verifyContextPackDir,
  writeContextPackDir,
} from '../lib/context-pack.js'

// 0.5.1 task-121 (M8 P0-B): context_pack.create audit row + expired-pack warning.
//
// The audit row is the minimal local disclosure receipt: action, subject
// kind/id, purpose, item count, manifestDigest and a one-way recipientHash -
// never the subject name or the recipient name/email. A failed audit write is
// fail-closed: the just-written pack is removed again. An expired pack still
// verifies (expiry is a disclosure record, not access control) and only warns.
// Temporary DB/directories only; the real ~/.advisers is never touched.

const NOW = '2026-11-01T00:00:00.000Z'
const FIXED = Date.parse('2026-11-22T00:00:00Z')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-context-audit-'))
  process.env.ADVISERS_HOME = root
  const store = new SqliteStore(join(root, 'state.db'))
  return { root, store, dbPath: join(root, 'state.db') }
}

function close(env) {
  try { env.store.close() } catch {}
  rmSync(env.root, { recursive: true, force: true })
}

/** One client/matter/commitment so a selection can be assembled and packed. */
function seed(store) {
  const wang = store.addClient({ name: '王工' })
  store.mutate(() => store.insertMatter({
    id: 'm_web', title: '官网改版', status: 'active', domain: 'general', secrecy: 0,
    participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW, clientId: wang.id,
  }))
  store.mutate(() => store.db.prepare('INSERT INTO turns(id, conversation_id, seq, role, content, created_at) VALUES(?,?,?,?,?,?)')
    .run('turn9', 'conv1', 1, 'user', '周五前发报价单', NOW))
  store.mutate(() => store.insertCommitment({
    id: 'cm_quote', matterId: 'm_web', debtor: 'user', creditor: 'third:wang', action: '发报价单',
    timezone: 'Asia/Shanghai', status: 'open', capability: 'none', createdAt: NOW,
    evidence: [{ sessionId: 'conv1', turnId: 'turn9', quote: '周五前发报价单' }],
  }))
  return wang
}

function auditRows(store) {
  return store.db.prepare('SELECT * FROM audit ORDER BY seq').all()
}

function itemOf(kind, payload, extra = {}) {
  return {
    id: extra.id ?? kind + '_1',
    kind,
    view: extra.view ?? 'pending',
    verification: { basis: CONTEXT_PACK_ITEM_VERIFICATION_BASIS, resolved: 0, missing: 0, unverifiable: 0, notChecked: 0 },
    payload,
  }
}

function buildPack(overrides = {}) {
  return buildContextPack({
    subject: { kind: 'client', id: 'cl_wang', name: '王工' },
    items: [itemOf('commitment', { action: '发报价单', debtor: 'user', creditor: 'third:wang', status: 'open' })],
    recipient: 'Claude Code',
    purpose: 'external-review',
    expiresAt: '2099-01-01T00:00:00.000Z',
    generatedAt: '2026-11-22T00:00:00.000Z',
    autoAssembled: true,
    candidateCount: 1,
    excluded: { secrecy: 0, stale: 0, unsupportedKind: 0, notFound: 0 },
    ...overrides,
  })
}

test('context-pack create writes exactly one context_pack.create audit row with ids/hashes only', () => {
  const env = setup()
  try {
    const wang = seed(env.store)
    const before = auditRows(env.store).length
    const out = join(env.root, 'pack')
    const result = createContextPack({
      store: env.store,
      subject: 'client:' + wang.id,
      ids: 'cm_quote',
      recipient: { name: 'Claude Code', email: 'claude@example.com' },
      purpose: 'external-review',
      out,
      now: FIXED,
    })
    assert.equal(result.ok, true, JSON.stringify(result.errors ?? null))
    assert.equal(result.audit.ok, true)
    assert.equal(result.audit.action, CONTEXT_PACK_AUDIT_ACTION)
    assert.equal(result.audit.action, 'context_pack.create')
    assert.equal(result.audit.subject.kind, 'client')
    assert.equal(result.audit.subject.id, wang.id)
    assert.equal(result.audit.purpose, 'external-review')
    assert.equal(result.audit.items, 1)
    assert.equal(result.audit.manifestDigest, result.manifestDigest)
    assert.match(result.audit.recipientHash, /^[0-9a-f]{64}$/)
    assert.equal(result.audit.recipientHash, contextPackRecipientHash({ name: 'Claude Code', email: 'claude@example.com' }))

    const rows = auditRows(env.store)
    assert.equal(rows.length, before + 1, 'create must append exactly one audit row')
    const row = rows[rows.length - 1]
    assert.equal(row.actor, 'local')
    assert.equal(row.action, 'context_pack.create')
    assert.equal(row.allowed, 1)
    assert.match(row.reason, new RegExp('subject=client:' + wang.id))
    assert.match(row.reason, /purpose=external-review/)
    assert.match(row.reason, /items=1/)
    assert.ok(row.reason.includes('manifestDigest=' + result.manifestDigest))
    assert.ok(row.reason.includes('recipientHash=' + result.audit.recipientHash))
    assert.ok(row.reason.length <= 300, 'the audit reason must stay within the 300-char convention')
    for (const forbidden of ['王工', 'Claude Code', 'claude@example.com']) {
      assert.equal(row.reason.includes(forbidden), false, 'the audit reason must not contain ' + forbidden)
    }
    // The pack itself still verifies offline and records the recipient/purpose.
    const verified = verifyContextPackDir(out)
    assert.equal(verified.ok, true, JSON.stringify(verified.errors))
    assert.equal(verified.manifestDigest, result.manifestDigest)
  } finally { close(env) }
})

test('a failed audit write removes the just-written pack and writes no row (fail closed)', () => {
  const env = setup()
  try {
    const wang = seed(env.store)
    const before = auditRows(env.store).length
    const out = join(env.root, 'pack-readonly')
    const readOnly = openReadStore(env.dbPath)
    try {
      assert.throws(
        () => createContextPack({
          store: readOnly,
          subject: 'client:' + wang.id,
          ids: 'cm_quote',
          recipient: 'Claude Code',
          purpose: 'external-review',
          out,
          now: FIXED,
        }),
        (error) => error.code === 'E_CONTEXT_PACK_INVALID' && /audit row failed/.test(error.message),
      )
    } finally { try { readOnly.close() } catch {} }
    assert.equal(existsSync(out), false, 'a pack without its audit row must not survive')
    assert.equal(auditRows(env.store).length, before, 'no context_pack.create row may be written')
  } finally { close(env) }
})

test('verify warns (never fails) for an expired pack and reports expiresAt/expired', () => {
  const env = setup()
  try {
    const expiredDir = join(env.root, 'pack-expired')
    const expiredBuilt = buildPack({ expiresAt: '2020-01-01T00:00:00.000Z' })
    writeContextPackDir(expiredDir, expiredBuilt)
    const expired = verifyContextPackDir(expiredDir)
    assert.equal(expired.ok, true, JSON.stringify(expired.errors))
    assert.equal(expired.expiresAt, '2020-01-01T00:00:00.000Z')
    assert.equal(expired.expired, true)
    assert.ok(expired.warnings.some((warning) => /expired at/.test(warning)), JSON.stringify(expired.warnings))
    assert.equal(expired.code, null)

    const futureDir = join(env.root, 'pack-future')
    writeContextPackDir(futureDir, buildPack())
    const future = verifyContextPackDir(futureDir)
    assert.equal(future.ok, true)
    assert.equal(future.expiresAt, '2099-01-01T00:00:00.000Z')
    assert.equal(future.expired, false)
    assert.ok(!future.warnings.some((warning) => /expired at/.test(warning)))

    // Expiry never changes the 0/1 verifier semantics: an expired pack whose
    // bytes were edited is still invalid.
    const edited = buildPack({ expiresAt: '2020-01-01T00:00:00.000Z' })
    const editedDir = join(env.root, 'pack-edited')
    writeContextPackDir(editedDir, edited)
    writeFileSync(join(editedDir, 'README.txt'), readFileSync(join(editedDir, 'README.txt'), 'utf8') + 'tampered\n')
    assert.equal(verifyContextPackDir(editedDir).ok, false)
  } finally { close(env) }
})
