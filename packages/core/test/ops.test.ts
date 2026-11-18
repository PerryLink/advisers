import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyRemember,
  authorityRank,
  completeCommitment,
  confirmPreference,
  createCommitment,
  createFact,
  createPreference,
  updateCommitmentFields,
} from '../src/ops.ts'
import { Ledger, LEDGER_SNAPSHOT_TABLES } from '../src/index.ts'
import type { Fact } from '../src/types.ts'

/** Deterministic host ports: fixed clock + prefixed sequence ids. */
function ports(now = '2026-11-18T00:00:00.000Z') {
  let seq = 0
  return {
    clock: { now: () => now },
    ids: { next: (prefix: string) => `${prefix}_${++seq}` },
  }
}

const EVIDENCE = [{ sessionId: 's1', turnId: 't1', quote: '周五前发' }]

test('createCommitment mirrors Ledger.addCommitment defaults and evidence rule', () => {
  const p = ports()
  const created = createCommitment(p, {
    matterId: 'm1',
    debtor: 'agent',
    creditor: 'user',
    action: '发报价',
    evidence: EVIDENCE,
  })
  assert.equal(created.id, 'cm_1')
  assert.equal(created.status, 'open')
  assert.equal(created.timezone, 'Asia/Shanghai')
  assert.equal(created.capability, 'none')
  assert.equal(created.dueAt, undefined)
  assert.ok(!('reminderOffsets' in created), 'no offsets key for old callers')
  assert.throws(() => createCommitment(ports(), { matterId: 'm1', debtor: 'user', creditor: 'u', action: 'x', evidence: [] }), /at least one evidence/)
  const offsets = ['-1d']
  const custom = createCommitment(ports(), { matterId: 'm1', debtor: 'user', creditor: 'u', action: 'x', evidence: EVIDENCE, reminderOffsets: offsets })
  offsets.push('-3d')
  assert.deepEqual(custom.reminderOffsets, ['-1d'], 'the caller array is copied')
})

test('updateCommitmentFields is pure and keeps the patch/reminderOffsets rules', () => {
  const original = createCommitment(ports(), { matterId: 'm1', debtor: 'agent', creditor: 'user', action: '发报价', dueAt: '2026-11-20T18:00:00+08:00', evidence: EVIDENCE, reminderOffsets: ['-1d'] })
  const next = updateCommitmentFields(original, { action: '发合同' })
  assert.notEqual(next, original, 'returns a copy')
  assert.equal(original.action, '发报价', 'input object is not mutated')
  assert.equal(next.action, '发合同')
  assert.deepEqual(next.reminderOffsets, ['-1d'])
  const cleared = updateCommitmentFields(next, { reminderOffsets: null })
  assert.ok(!('reminderOffsets' in cleared))
  assert.throws(() => updateCommitmentFields(next, { reminderOffsets: ['-1d', 3] as unknown as string[] }), TypeError)
})

test('completeCommitment is pure, marks done and appends evidence', () => {
  const original = createCommitment(ports(), { matterId: 'm1', debtor: 'agent', creditor: 'user', action: 'x', evidence: EVIDENCE })
  const done = completeCommitment(original, [{ sessionId: 's1', turnId: 't9', quote: '已发送' }], '2026-11-19T00:00:00.000Z')
  assert.notEqual(done, original)
  assert.equal(done.status, 'done')
  assert.equal(done.doneAt, '2026-11-19T00:00:00.000Z')
  assert.equal(done.evidence.length, 2)
  assert.equal(original.evidence.length, 1)
  assert.throws(() => completeCommitment(original, [], '2026-11-19T00:00:00.000Z'), /external evidence/)
})

test('createPreference mirrors addPreference defaults; confirmPreference promotes at 0.7', () => {
  const pref = createPreference(ports(), { kind: 'preference', statement: '邮件先结论' })
  assert.equal(pref.id, 'pref_1')
  assert.deepEqual(pref.scope, { level: 'global' })
  assert.deepEqual(pref.source, { type: 'user_explicit' })
  assert.equal(pref.confidence, 0.9)
  assert.equal(pref.status, 'confirmed')
  assert.equal(pref.priority, 'soft')
  assert.equal(createPreference(ports(), { kind: 'taboo', statement: '不要 force push' }).priority, 'hard')
  const candidate = createPreference(ports(), { kind: 'preference', statement: 'x', confidence: 0.3, status: 'candidate' })
  const first = confirmPreference(candidate, '2026-11-19T00:00:00.000Z')
  assert.equal(first.preference.confidence, 0.5)
  assert.equal(first.preference.status, 'candidate')
  assert.equal(first.promoted, false)
  const second = confirmPreference(first.preference, '2026-11-20T00:00:00.000Z')
  assert.equal(second.preference.confidence, 0.7)
  assert.equal(second.preference.status, 'confirmed')
  assert.equal(second.promoted, true)
  assert.equal(second.preference.lastConfirmed, '2026-11-20T00:00:00.000Z')
  assert.equal(candidate.confidence, 0.3, 'does not mutate the input preference')
})

test('authorityRank and createFact keep the user-confirmed vs candidate rule', () => {
  assert.deepEqual(['user', 'tool', 'import', 'inferred'].map((a) => authorityRank(a as Fact['authority'])), [100, 60, 60, 40])
  const confirmed = createFact(ports(), { subject: 'user', predicate: 'city', object: '上海' })
  assert.equal(confirmed.status, 'confirmed')
  assert.equal(confirmed.authority, 'user')
  assert.equal(confirmed.confidence, 0.9)
  assert.equal(confirmed.validFrom, '2026-11-18T00:00:00.000Z')
  assert.equal(confirmed.evidence?.length, 0)
  const candidate = createFact(ports(), { subject: 'user', predicate: 'city', object: '北京', authority: 'inferred' })
  assert.equal(candidate.status, 'candidate')
  assert.equal(candidate.confidence, 0.9)
  const fromSource = createFact(ports(), { subject: 'user', predicate: 'city', object: '深圳', source: { quote: '搬到深圳' } })
  assert.deepEqual(fromSource.evidence, [{ quote: '搬到深圳' }], 'a source becomes the evidence fallback')
})

test('applyRemember: same object merges evidence, source, authority and lastSeenAt', () => {
  const p = ports()
  const current: Fact = {
    id: 'fact_old', subject: 'user', predicate: 'city', object: '上海', recordedAt: '2026-11-01T00:00:00.000Z',
    authority: 'inferred', confidence: 0.5, status: 'confirmed', evidence: [{ quote: '上海' }],
  }
  const outcome = applyRemember(current, { subject: 'user', predicate: 'city', object: '上海', authority: 'user', source: { quote: '上海' }, evidence: [{ quote: '上海' }] }, p)
  assert.equal(outcome.op, 'update')
  if (outcome.op !== 'update') return
  assert.equal(outcome.row.id, current.id)
  assert.equal(outcome.row.authority, 'user', 'higher authority wins')
  assert.equal(outcome.row.lastSeenAt, '2026-11-18T00:00:00.000Z')
  assert.equal(outcome.row.evidence?.length, 2)
  assert.equal(current.lastSeenAt, undefined, 'input fact is not mutated')
})

test('applyRemember: lower authority inserts a shadow candidate', () => {
  const current: Fact = { id: 'fact_old', subject: 'user', predicate: 'city', object: '上海', recordedAt: '2026-11-01T00:00:00.000Z', authority: 'user', confidence: 0.9, status: 'confirmed' }
  const outcome = applyRemember(current, { subject: 'user', predicate: 'city', object: '北京', authority: 'inferred' }, ports())
  assert.equal(outcome.op, 'insert')
  if (outcome.op !== 'insert') return
  assert.equal(outcome.row.status, 'candidate')
  assert.equal(outcome.row.shadowedBy, 'fact_old')
  assert.equal(outcome.row.authority, 'inferred')
  assert.equal(outcome.row.confidence, 0.6)
  assert.equal(current.status, 'confirmed')
})

test('applyRemember: normal change supersedes the old fact in both directions', () => {
  const current: Fact = { id: 'fact_old', subject: 'user', predicate: 'city', object: '上海', recordedAt: '2026-11-01T00:00:00.000Z', authority: 'user', confidence: 0.9, status: 'confirmed' }
  const outcome = applyRemember(current, { subject: 'user', predicate: 'city', object: '北京', evidence: [{ quote: '改到北京' }] }, ports())
  assert.equal(outcome.op, 'supersede')
  if (outcome.op !== 'supersede') return
  assert.equal(outcome.old.status, 'superseded')
  assert.equal(outcome.old.expiredAt, '2026-11-18T00:00:00.000Z')
  assert.equal(outcome.old.validTo, '2026-11-18T00:00:00.000Z')
  assert.equal(outcome.old.supersededBy, outcome.row.id)
  assert.equal(outcome.row.supersedes, 'fact_old')
  assert.equal(outcome.row.status, 'confirmed')
})

test('Ledger methods produce exactly the ops result (one shared implementation)', () => {
  const p = ports()
  const ledger = new Ledger(p)
  const matter = ledger.addMatter({ title: '客户' })
  // ids differ by call order; every other field must be identical.
  const idNormalized = <T extends { id: string }>(value: T) => ({ ...value, id: 'ignored' })
  const viaLedger = ledger.addCommitment({ matterId: matter.id, debtor: 'agent', creditor: 'user', action: '发报价', evidence: EVIDENCE })
  const direct = createCommitment(ports(), { matterId: matter.id, debtor: 'agent', creditor: 'user', action: '发报价', evidence: EVIDENCE })
  assert.deepEqual(idNormalized(viaLedger), idNormalized(direct))
  const pref = ledger.addPreference({ kind: 'preference', statement: '邮件先结论' })
  const directPref = createPreference(ports(), { kind: 'preference', statement: '邮件先结论' })
  assert.deepEqual(idNormalized(pref), idNormalized(directPref))
  const fact = ledger.remember({ subject: 'user', predicate: 'city', object: '上海' })
  // remember() always carries the key (undefined when there is no predecessor).
  const directFact = { ...createFact(ports(), { subject: 'user', predicate: 'city', object: '上海' }), supersedes: undefined }
  assert.deepEqual(idNormalized(fact), idNormalized(directFact))
  ledger.updateCommitment(viaLedger.id, { action: '发合同' })
  assert.equal(viaLedger.action, '发合同')
  ledger.completeCommitment(viaLedger.id, [{ sessionId: 's1', turnId: 't9', quote: '已发送' }])
  assert.equal(viaLedger.status, 'done')
})

test('LedgerSnapshot stays in sync with Ledger.toJSON (wire v1 tables)', () => {
  const snapshot = new Ledger().toJSON()
  assert.deepEqual(Object.keys(snapshot).sort(), ['commitments', 'facts', 'links', 'matters', 'preferences', 'routinePatches', 'routines', 'routes', 'updates', 'version'].sort())
  assert.deepEqual([...LEDGER_SNAPSHOT_TABLES].sort(), Object.keys(snapshot).filter((key) => key !== 'version').sort())
  assert.equal(snapshot.version, 1)
})
