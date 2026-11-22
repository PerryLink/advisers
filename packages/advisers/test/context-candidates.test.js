import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SqliteStore } from '../lib/sqlite.js'
import {
  collectContextCandidates,
  loadContextCandidateForSelection,
  normalizeContextPackSubject,
  resolveContextPackSubjectScope,
} from '../lib/context-candidates.js'
import { assertContextPackNotImportable, createContextPack, isContextPackDir, verifyContextPackDir } from '../lib/context-pack.js'

// Context pack candidates (0.5.0 / 050-C2): subject scope, timeline order,
// secrecy/stale/unsupportedKind/notFound counting, selection fail-closed and
// the pack integration (candidate mode writes nothing; --ids/--yes write one
// pack that the offline verifier accepts). Temporary DB and directories only.

const NOW = '2026-11-01T00:00:00.000Z'
const FIXED = Date.parse('2026-11-22T00:00:00Z')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-context-candidates-'))
  process.env.ADVISERS_HOME = root
  const store = new SqliteStore(join(root, 'state.db'))
  return { root, store }
}

/** Two clients, protected matter, current and stale rows, a note and a delivery. */
function seed(store) {
  const wang = store.addClient({ name: '王工' })
  const li = store.addClient({ name: '李总' })
  store.mutate(() => store.insertMatter({ id: 'm_web', title: '官网改版', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW, clientId: wang.id }))
  store.mutate(() => store.insertMatter({ id: 'm_secret', title: '保密项目', status: 'active', domain: 'general', secrecy: 2, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW, clientId: wang.id }))
  store.mutate(() => store.insertMatter({ id: 'm_other', title: '李总项目', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW, clientId: li.id }))
  store.mutate(() => store.db.prepare('INSERT INTO turns(id, conversation_id, seq, role, content, created_at) VALUES(?,?,?,?,?,?)').run('turn9', 'conv1', 1, 'user', '周五前发报价单', NOW))
  const commitment = (row) => store.mutate(() => store.insertCommitment({ timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none', createdAt: NOW, ...row }))
  commitment({ id: 'cm_quote', matterId: 'm_web', debtor: 'user', creditor: 'third:wang', action: '发报价单', createdAt: '2026-10-02T00:00:00.000Z', evidence: [{ sessionId: 'conv1', turnId: 'turn9', quote: '周五前发报价单' }] })
  commitment({ id: 'cm_done', matterId: 'm_web', debtor: 'user', creditor: 'third:wang', action: '已发合同', status: 'done', createdAt: '2026-10-03T00:00:00.000Z' })
  commitment({ id: 'cm_secret', matterId: 'm_secret', debtor: 'user', creditor: 'third:wang', action: '保密的事', createdAt: '2026-10-04T00:00:00.000Z' })
  commitment({ id: 'cm_other', matterId: 'm_other', debtor: 'user', creditor: 'third:li', action: '别家的活', createdAt: '2026-10-05T00:00:00.000Z' })
  const fact = (row) => store.mutate(() => store.insertFact({ authority: 'user', confidence: 0.9, status: 'confirmed', validFrom: NOW, evidence: [], ...row }))
  fact({ id: 'fact_price', matterId: 'm_web', subject: '报价', predicate: '金额', object: '80000', recordedAt: '2026-10-06T00:00:00.000Z', evidence: [{ quote: '报价 80000 元', source: { type: 'mail', ref: 'mail:abc', quote: '报价 80000 元' } }] })
  fact({ id: 'fact_old', matterId: 'm_web', subject: '报价', predicate: '金额', object: '70000', recordedAt: '2026-10-01T00:00:00.000Z', status: 'superseded', supersededBy: 'fact_price' })
  fact({ id: 'fact_secret', matterId: 'm_secret', subject: '预算', predicate: '金额', object: '999', recordedAt: '2026-10-01T00:00:00.000Z' })
  fact({ id: 'fact_other', matterId: 'm_other', subject: '报价', predicate: '金额', object: '1', recordedAt: '2026-10-01T00:00:00.000Z' })
  const preference = (row) => store.mutate(() => store.insertPreference({ kind: 'preference', statement: 'x', scope: { level: 'matter', value: 'm_web' }, source: {}, evidence: [], confidence: 1, status: 'confirmed', validFrom: NOW, priority: 'soft', ...row }))
  preference({ id: 'pref_tone', statement: '沟通要简洁', validFrom: '2026-10-01T00:00:00.000Z' })
  preference({ id: 'pref_old', statement: '旧的偏好', status: 'deprecated', validFrom: '2026-09-01T00:00:00.000Z' })
  preference({ id: 'pref_secret', statement: '保密偏好', scope: { level: 'matter', value: 'm_secret' } })
  preference({ id: 'pref_other', statement: '别家偏好', scope: { level: 'matter', value: 'm_other' } })
  preference({ id: 'pref_global', statement: '全局偏好', scope: { level: 'global' } })
  store.addDelivery({ matterId: 'm_web', conversationId: 'conv1', files: ['/secret/path.docx'], tool: 'quote', title: '报价单 v1' })
  store.mutate(() => store.db.prepare("UPDATE deliveries SET created_at = '2026-10-08T00:00:00.000Z'").run())
  store.mutate(() => store.db.prepare('INSERT INTO deliveries(id, matter_id, conversation_id, files, title, created_at, client_id) VALUES(?,?,?,?,?,?,?)').run('del_orphan', 'm_gone', 'conv1', '[]', '孤儿交付', NOW, wang.id))
  store.addClientNote({ clientId: wang.id, matterId: 'm_web', kind: 'note', at: '2026-10-07T00:00:00.000Z', summary: '聊了报价' })
  store.addClientNote({ clientId: wang.id, matterId: 'm_secret', kind: 'note', at: '2026-10-07T00:00:00.000Z', summary: '保密备注' })
  store.addClientNote({ clientId: wang.id, kind: 'note', at: '2026-10-07T00:00:00.000Z', summary: '客户级备注' })
  return { wang, li }
}

function close(env) {
  try { env.store.close() } catch {}
  rmSync(env.root, { recursive: true, force: true })
}

test('normalizeContextPackSubject accepts client:/matter: and rejects unsupported kinds', () => {
  assert.deepEqual(normalizeContextPackSubject('client:cl_wang'), { kind: 'client', id: 'cl_wang' })
  assert.deepEqual(normalizeContextPackSubject(' matter:m_web '), { kind: 'matter', id: 'm_web' })
  assert.deepEqual(normalizeContextPackSubject({ kind: 'client', id: 'cl_x' }), { kind: 'client', id: 'cl_x' })
  assert.throws(() => normalizeContextPackSubject('owner:me'), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
  assert.throws(() => normalizeContextPackSubject('client:'), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
  assert.throws(() => normalizeContextPackSubject('nonsense'), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
})

test('client subject assembles only that client, in frozen timeline order, with exact exclusions', () => {
  const env = setup()
  try {
    const { wang } = seed(env.store)
    const subject = 'client:' + wang.id
    const result = collectContextCandidates({ store: env.store, subject, limit: 10, now: FIXED })
    assert.equal(result.subject.kind, 'client')
    assert.equal(result.subject.name, '王工')
    assert.deepEqual(result.candidates.map((candidate) => candidate.kind), ['delivery', 'fact', 'commitment', 'preference'])
    const clientRefs = result.candidates.map((candidate) => candidate.ref)
    assert.ok(clientRefs.includes('fact_price') && clientRefs.includes('cm_quote') && clientRefs.includes('pref_tone'))
    assert.match(clientRefs[0], /^del_/)
    assert.deepEqual(result.candidates.map((candidate) => candidate.view), ['historical', 'pending', 'verified', 'pending'])
    assert.equal(result.excluded.byReason.secrecy, 4)
    assert.equal(result.excluded.byReason.stale, 3)
    assert.equal(result.excluded.byReason.unsupportedKind, 2)
    assert.equal(result.excluded.byReason.notFound, 1)
    assert.equal(result.excluded.total, 10)
    assert.deepEqual(result.counts.byKind, { delivery: 1, commitment: 1, fact: 1, preference: 1 })
    assert.equal(result.counts.candidateTotal, 4)
    assert.equal(result.counts.candidates, 4)
    assert.equal(result.counts.truncated, false)
    const refs = new Set(result.candidates.map((candidate) => candidate.ref))
    for (const forbidden of ['cm_other', 'fact_other', 'pref_other', 'cm_secret', 'fact_secret', 'pref_secret', 'cm_done', 'fact_old', 'pref_old', 'pref_global']) {
      assert.equal(refs.has(forbidden), false, 'cross-scope and stale rows must not be candidates: ' + forbidden)
    }
  } finally { close(env) }
})

test('matter subject sees only that matter; a protected matter lists no candidates and counts secrecy', () => {
  const env = setup()
  try {
    seed(env.store)
    const visible = collectContextCandidates({ store: env.store, subject: 'matter:m_web', limit: 10, now: FIXED })
    assert.equal(visible.candidates.length, 4)
    const visibleRefs = visible.candidates.map((candidate) => candidate.ref)
    assert.ok(visibleRefs.includes('cm_quote') && visibleRefs.includes('fact_price') && visibleRefs.includes('pref_tone'))
    assert.equal(visible.candidates.filter((candidate) => candidate.kind === 'delivery').length, 1)
    assert.equal(visible.excluded.byReason.secrecy, 0)
    assert.equal(visible.excluded.byReason.stale, 3)
    assert.equal(visible.excluded.byReason.unsupportedKind, 1)
    assert.equal(visible.excluded.total, 4)
    const secret = collectContextCandidates({ store: env.store, subject: 'matter:m_secret', limit: 10, now: FIXED })
    assert.deepEqual(secret.candidates, [])
    assert.deepEqual(secret.counts.byKind, { delivery: 0, commitment: 0, fact: 0, preference: 0 })
    assert.equal(secret.excluded.byReason.secrecy, 4)
    assert.equal(secret.excluded.byReason.stale, 0)
  } finally { close(env) }
})

test('two runs with the same clock are byte-identical', () => {
  const env = setup()
  try {
    const { wang } = seed(env.store)
    const subject = 'client:' + wang.id
    const first = collectContextCandidates({ store: env.store, subject, limit: 10, now: FIXED })
    const second = collectContextCandidates({ store: env.store, subject, limit: 10, now: FIXED })
    assert.equal(JSON.stringify(first), JSON.stringify(second))
  } finally { close(env) }
})

test('candidate limit pages but keeps the exact totals', () => {
  const env = setup()
  try {
    const { wang } = seed(env.store)
    const result = collectContextCandidates({ store: env.store, subject: 'client:' + wang.id, limit: 2, now: FIXED })
    assert.equal(result.candidates.length, 2)
    assert.equal(result.counts.candidateTotal, 4)
    assert.equal(result.counts.truncated, true)
    const since = collectContextCandidates({ store: env.store, subject: 'client:' + wang.id, limit: 10, since: '180d', now: FIXED })
    assert.equal(since.counts.candidateTotal, 4)
    assert.equal(since.candidates.length, 4)
  } finally { close(env) }
})

test('selection fails closed with stable codes and never leaks cross-client ids', () => {
  const env = setup()
  try {
    const { wang } = seed(env.store)
    const subject = 'client:' + wang.id
    const selected = loadContextCandidateForSelection({ store: env.store, subject, id: 'cm_quote', now: FIXED })
    assert.equal(selected.ref, 'cm_quote')
    assert.equal(selected.view, 'verified')
    assert.deepEqual(selected.verification, { basis: 'local-resolution', resolved: 1, missing: 0, unverifiable: 0, notChecked: 0 })
    const expectCode = (id, code) => assert.throws(
      () => loadContextCandidateForSelection({ store: env.store, subject, id, now: FIXED }),
      (error) => error.code === code,
      id + ' should fail with ' + code,
    )
    expectCode('cm_missing', 'E_CONTEXT_PACK_ENTRY_NOT_FOUND')
    expectCode('cm_done', 'E_CONTEXT_PACK_ENTRY_STALE')
    expectCode('cm_secret', 'E_CONTEXT_PACK_SECRECY_BLOCKED')
    expectCode('cm_other', 'E_CONTEXT_PACK_ENTRY_NOT_FOUND')
    expectCode('fact_missing', 'E_CONTEXT_PACK_ENTRY_NOT_FOUND')
    expectCode('note_x', 'E_CONTEXT_PACK_UNSUPPORTED_KIND')
    expectCode('unknown-id', 'E_CONTEXT_PACK_ENTRY_NOT_FOUND')
    assert.throws(() => loadContextCandidateForSelection({ store: env.store, subject: 'matter:m_web', id: 'pref_other', now: FIXED }), (error) => error.code === 'E_CONTEXT_PACK_ENTRY_NOT_FOUND')
  } finally { close(env) }
})

test('JSON / non-SQLite stores fail closed with E_STORE', () => {
  assert.throws(() => collectContextCandidates({ store: {}, subject: 'client:cl_x' }), (error) => error.code === 'E_STORE')
  assert.throws(() => collectContextCandidates({ store: { read: () => ({}), db: { prepare: () => { throw new Error('no db') } } }, subject: 'client:cl_x' }), (error) => error.code === 'E_STORE')
  assert.throws(() => resolveContextPackSubjectScope({}, 'client:cl_x'), (error) => error.code === 'E_STORE')
})

test('candidate mode writes nothing; --ids writes a verified pack with a disclosure block', () => {
  const env = setup()
  try {
    const { wang } = seed(env.store)
    const subject = 'client:' + wang.id
    const out = join(env.root, 'pack')
    const candidates = createContextPack({ store: env.store, subject, now: FIXED })
    assert.equal(candidates.mode, 'candidates')
    assert.equal(candidates.ok, true)
    assert.equal(existsSync(out), false, 'candidate mode must not write')
    assert.ok(Array.isArray(candidates.candidates))
    assert.match(candidates.next, /context-pack create --subject client:/)
    const pack = createContextPack({
      store: env.store,
      subject,
      ids: ['cm_quote', 'fact_price'],
      recipient: 'Claude Code',
      purpose: 'external-review',
      out,
      now: FIXED,
    })
    assert.equal(pack.ok, true)
    assert.equal(pack.disclosure.autoAssembled, true)
    assert.equal(pack.disclosure.candidateCount, 4)
    assert.equal(pack.disclosure.selectedCount, 2)
    assert.equal(pack.disclosure.includesQuotes, false)
    assert.deepEqual(pack.disclosure.excluded.byReason, { secrecy: 4, stale: 3, unsupportedKind: 2, notFound: 1 })
    assert.deepEqual(verifyContextPackDir(out).ok, true)
    assert.equal(isContextPackDir(out), true)
    assert.throws(() => assertContextPackNotImportable(out), (error) => error.code === 'E_CONTEXT_PACK_IMPORT_UNSUPPORTED')
    assert.equal(assertContextPackNotImportable(env.root), false)
    const manifest = readFileSync(join(out, 'manifest.json'), 'utf8')
    assert.equal(manifest.includes('80000'), true, 'selected fact object text is disclosed')
    assert.equal(/(^|[^A-Za-z])amount/i.test(manifest), false, 'no amount keys')
    assert.equal(manifest.includes('filePath') || manifest.includes('fileBytes'), false)
    assert.equal(manifest.includes('周五前发报价单'), false, 'commitment quote text never enters a pack')
  } finally { close(env) }
})

test('--yes packs every selectable candidate; delivery metadata carries no files or paths', () => {
  const env = setup()
  try {
    const { wang } = seed(env.store)
    const subject = 'client:' + wang.id
    const out = join(env.root, 'pack-yes')
    const pack = createContextPack({ store: env.store, subject, yes: true, recipient: 'Claude Code', purpose: 'client-delivery', out, now: FIXED })
    assert.equal(pack.ok, true)
    assert.equal(pack.disclosure.selectedCount, 4)
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    const delivery = manifest.items.find((item) => item.kind === 'delivery')
    assert.ok(delivery, 'delivery metadata is packable')
    assert.deepEqual(Object.keys(delivery.payload).sort(), ['createdAt', 'matterId', 'title', 'tool'])
    assert.equal(JSON.stringify(manifest).includes('/secret/path.docx'), false)
    assert.equal(verifyContextPackDir(out).ok, true)
  } finally { close(env) }
})

test('unconfirmed, missing or cross-client selections never write a pack', () => {
  const env = setup()
  try {
    const { wang } = seed(env.store)
    const subject = 'client:' + wang.id
    const missingOut = join(env.root, 'never-1')
    assert.throws(
      () => createContextPack({ store: env.store, subject, ids: ['cm_missing'], recipient: 'X', purpose: 'handoff', out: missingOut, now: FIXED }),
      (error) => error.code === 'E_CONTEXT_PACK_ENTRY_NOT_FOUND',
    )
    assert.equal(existsSync(missingOut), false)
    const staleOut = join(env.root, 'never-2')
    assert.throws(
      () => createContextPack({ store: env.store, subject, ids: ['cm_done'], recipient: 'X', purpose: 'handoff', out: staleOut, now: FIXED }),
      (error) => error.code === 'E_CONTEXT_PACK_ENTRY_STALE',
    )
    assert.equal(existsSync(staleOut), false)
    const otherOut = join(env.root, 'never-3')
    assert.throws(
      () => createContextPack({ store: env.store, subject, ids: ['cm_other'], recipient: 'X', purpose: 'handoff', out: otherOut, now: FIXED }),
      (error) => error.code === 'E_CONTEXT_PACK_ENTRY_NOT_FOUND',
    )
    assert.equal(existsSync(otherOut), false)
    assert.throws(() => createContextPack({ store: env.store, subject, ids: ['cm_quote'], yes: true, recipient: 'X', purpose: 'handoff', out: otherOut }), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
  } finally { close(env) }
})

test('pack mode requires recipient/purpose/out and a future expiry', () => {
  const env = setup()
  try {
    const { wang } = seed(env.store)
    const subject = 'client:' + wang.id
    const out = join(env.root, 'pack-missing')
    assert.throws(() => createContextPack({ store: env.store, subject, ids: ['cm_quote'], purpose: 'handoff', out, now: FIXED }), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
    assert.throws(() => createContextPack({ store: env.store, subject, ids: ['cm_quote'], recipient: 'X', out, now: FIXED }), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
    assert.throws(() => createContextPack({ store: env.store, subject, ids: ['cm_quote'], recipient: 'X', purpose: 'nope', out, now: FIXED }), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
    assert.throws(() => createContextPack({ store: env.store, subject, ids: ['cm_quote'], recipient: 'X', purpose: 'handoff', now: FIXED }), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
    assert.throws(() => createContextPack({ store: env.store, subject, ids: ['cm_quote'], recipient: 'X', purpose: 'handoff', out, expires: '2020-01-01T00:00:00Z', now: FIXED }), (error) => error.code === 'E_CONTEXT_PACK_INVALID')
    assert.throws(
      () => createContextPack({ store: env.store, subject, ids: ['cm_quote'], recipient: 'X', purpose: 'handoff', out, now: FIXED, expectManifestSha256: '0'.repeat(64) }),
      (error) => error.code === 'E_CONTEXT_PACK_INVALID',
    )
  } finally { close(env) }
})

test('a matter subject pack records kind=matter and its display name', () => {
  const env = setup()
  try {
    seed(env.store)
    const out = join(env.root, 'pack-matter')
    const pack = createContextPack({ store: env.store, subject: 'matter:m_web', ids: ['pref_tone'], recipient: 'Claude Code', purpose: 'handoff', out, now: FIXED })
    assert.deepEqual(pack.subject, { kind: 'matter', id: 'm_web', name: '官网改版' })
    assert.equal(verifyContextPackDir(out).ok, true)
  } finally { close(env) }
})

test('include-quotes discloses a bounded quote for facts but never a commitment quote', () => {
  const env = setup()
  try {
    const { wang } = seed(env.store)
    const subject = 'client:' + wang.id
    const out = join(env.root, 'pack-quotes')
    const pack = createContextPack({ store: env.store, subject, ids: ['fact_price', 'cm_quote'], recipient: 'Claude Code', purpose: 'external-review', includeQuotes: true, out, now: FIXED })
    assert.equal(pack.disclosure.includesQuotes, true)
    assert.equal(verifyContextPackDir(out).ok, true)
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    const fact = manifest.items.find((item) => item.kind === 'fact')
    assert.equal(fact.payload.quote, '报价 80000 元')
    assert.equal(fact.payload.quoteSha256.length, 64)
    const commitment = manifest.items.find((item) => item.kind === 'commitment')
    assert.equal(Object.hasOwn(commitment.payload, 'quote'), false)
    assert.equal(JSON.stringify(manifest).includes('周五前发报价单'), false)
  } finally { close(env) }
})

test('scope resolution rejects archived subjects and unknown ids', () => {
  const env = setup()
  try {
    const { wang } = seed(env.store)
    assert.throws(() => resolveContextPackSubjectScope(env.store, 'client:cl_missing'), (error) => error.code === 'E_CONTEXT_PACK_ENTRY_NOT_FOUND')
    assert.throws(() => resolveContextPackSubjectScope(env.store, 'matter:m_missing'), (error) => error.code === 'E_CONTEXT_PACK_ENTRY_NOT_FOUND')
    env.store.archiveClient(wang.id)
    assert.throws(() => resolveContextPackSubjectScope(env.store, 'client:' + wang.id), (error) => error.code === 'E_CONTEXT_PACK_ENTRY_STALE')
  } finally { close(env) }
})
test('project-scoped preferences are candidates for the client subject only', () => {
  const env = setup()
  try {
    const wang = env.store.addClient({ name: '王工' })
    const li = env.store.addClient({ name: '李总' })
    const project = env.store.addProject({ clientId: wang.id, name: '年度企划' })
    const otherProject = env.store.addProject({ clientId: li.id, name: '别家企划' })
    env.store.mutate(() => env.store.insertPreference({ id: 'pref_project', kind: 'preference', statement: '企划偏好', scope: { level: 'project', value: project.id }, source: {}, evidence: [], confidence: 1, status: 'confirmed', validFrom: NOW, priority: 'soft' }))
    env.store.mutate(() => env.store.insertPreference({ id: 'pref_other_project', kind: 'preference', statement: '别家企划偏好', scope: { level: 'project', value: otherProject.id }, source: {}, evidence: [], confidence: 1, status: 'confirmed', validFrom: NOW, priority: 'soft' }))
    const result = collectContextCandidates({ store: env.store, subject: 'client:' + wang.id, limit: 10, now: FIXED })
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0].kind, 'preference')
    assert.equal(result.counts.byKind.preference, 1)
    assert.equal(result.excluded.total, 0)
  } finally { close(env) }
})

test('a protected client hides every row and counts them only as secrecy', () => {
  const env = setup()
  try {
    const secretClient = env.store.addClient({ name: '保密客户', secrecyDefault: 2 })
    env.store.mutate(() => env.store.insertMatter({ id: 'm_hidden', title: '保密事项', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW, clientId: secretClient.id }))
    env.store.mutate(() => env.store.insertCommitment({ id: 'cm_hidden', matterId: 'm_hidden', debtor: 'user', creditor: 'third:x', action: '保密承诺', timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none', createdAt: NOW }))
    env.store.addClientNote({ clientId: secretClient.id, kind: 'note', at: NOW, summary: '客户级备注' })
    const result = collectContextCandidates({ store: env.store, subject: 'client:' + secretClient.id, limit: 10, now: FIXED })
    assert.deepEqual(result.candidates, [])
    assert.deepEqual(result.counts.byKind, { delivery: 0, commitment: 0, fact: 0, preference: 0 })
    assert.equal(result.excluded.byReason.secrecy, 2)
    assert.equal(result.excluded.byReason.unsupportedKind, 0)
    assert.equal(result.excluded.total, 2)
  } finally { close(env) }
})

test('duplicate ids are de-duplicated and --yes above the 16-item cap fails closed', () => {
  const env = setup()
  try {
    const wang = env.store.addClient({ name: '王工' })
    env.store.mutate(() => env.store.insertMatter({ id: 'm_web', title: '官网改版', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW, clientId: wang.id }))
    for (let index = 0; index < 17; index += 1) {
      env.store.mutate(() => env.store.insertCommitment({ id: 'cm_' + index, matterId: 'm_web', debtor: 'user', creditor: 'third:x', action: '事 ' + index, timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none', createdAt: NOW }))
    }
    const out = join(env.root, 'too-many')
    assert.throws(
      () => createContextPack({ store: env.store, subject: 'client:' + wang.id, yes: true, recipient: 'X', purpose: 'handoff', out, now: FIXED }),
      (error) => error.code === 'E_CONTEXT_PACK_LIMIT' && /item count/.test(error.message),
    )
    assert.equal(existsSync(out), false)
    const deduped = createContextPack({ store: env.store, subject: 'client:' + wang.id, ids: ['cm_0', 'cm_0', 'cm_1'], recipient: 'X', purpose: 'handoff', out: join(env.root, 'dedupe'), now: FIXED })
    assert.equal(deduped.disclosure.selectedCount, 2)
  } finally { close(env) }
})
test('unsupported KB/mail/note ids report E_CONTEXT_PACK_UNSUPPORTED_KIND', () => {
  const env = setup()
  try {
    const { wang } = seed(env.store)
    const subject = 'client:' + wang.id
    for (const id of ['kb_chunk:doc1#0', 'mail:abc', 'note_missing']) {
      assert.throws(
        () => loadContextCandidateForSelection({ store: env.store, subject, id, now: FIXED }),
        (error) => error.code === 'E_CONTEXT_PACK_UNSUPPORTED_KIND',
        id + ' must be unsupported',
      )
    }
  } finally { close(env) }
})
