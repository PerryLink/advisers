import assert from 'node:assert/strict'
import test from 'node:test'
import { Ledger, type CommitmentInput } from '../src/index.ts'

const EVIDENCE = [{ sessionId: 'session_1', turnId: 'turn_1', quote: '周五前提醒我发报价' }]

function fixture() {
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '提醒账本测试' })
  return { ledger, matter }
}

function input(matterId: string, extra: Partial<CommitmentInput> = {}): CommitmentInput {
  return {
    matterId,
    debtor: 'agent',
    creditor: 'user',
    action: '发报价',
    dueAt: '2026-11-20T18:00:00+08:00',
    evidence: EVIDENCE,
    ...extra,
  }
}

test('addCommitment stores reminderOffsets and keeps old callers field-free', () => {
  const { ledger, matter } = fixture()

  const plain = ledger.addCommitment(input(matter.id))
  assert.equal(plain.reminderOffsets, undefined)
  assert.ok(!('reminderOffsets' in plain), 'a commitment created without offsets must not grow the key')

  const custom = ledger.addCommitment(input(matter.id, { reminderOffsets: ['-1d', '-2h', '+0d09:00'] }))
  assert.deepEqual(custom.reminderOffsets, ['-1d', '-2h', '+0d09:00'])

  // The ledger owns a copy: later mutation of the caller's array must not leak in.
  const offsets = ['-30m']
  const copySource = ledger.addCommitment(input(matter.id, { reminderOffsets: offsets }))
  offsets.push('-3d')
  assert.deepEqual(copySource.reminderOffsets, ['-30m'])
})

test('updateCommitment replaces and clears reminderOffsets without touching other fields', () => {
  const { ledger, matter } = fixture()
  const commitment = ledger.addCommitment(input(matter.id, { reminderOffsets: ['-1d'] }))

  ledger.updateCommitment(commitment.id, { reminderOffsets: ['-2h', '+0d09:00'] })
  assert.deepEqual(commitment.reminderOffsets, ['-2h', '+0d09:00'])
  assert.equal(commitment.action, '发报价')
  assert.equal(commitment.dueAt, '2026-11-20T18:00:00+08:00')
  assert.equal(commitment.status, 'open')

  // Omit to leave unchanged.
  ledger.updateCommitment(commitment.id, { action: '发合同' })
  assert.equal(commitment.action, '发合同')
  assert.deepEqual(commitment.reminderOffsets, ['-2h', '+0d09:00'])

  // null clears the field entirely (old default alarms apply again).
  ledger.updateCommitment(commitment.id, { reminderOffsets: null })
  assert.equal(commitment.reminderOffsets, undefined)
  assert.ok(!('reminderOffsets' in commitment))

  assert.throws(() => ledger.updateCommitment('cm_missing', { action: 'x' }), /unknown commitment/)
  assert.throws(() => ledger.updateCommitment(commitment.id, { reminderOffsets: ['-1d', 3] as unknown as string[] }), TypeError)
})

test('snapshot serialization round-trips reminderOffsets', () => {
  const { ledger, matter } = fixture()
  const commitment = ledger.addCommitment(input(matter.id, { reminderOffsets: ['-1d', '-2h'] }))

  const snapshot = ledger.toJSON()
  const serialized = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot
  assert.deepEqual(serialized.commitments[0]?.reminderOffsets, ['-1d', '-2h'])

  const restored = Ledger.fromJSON(serialized)
  const reloaded = restored.listCommitments().find((entry) => entry.id === commitment.id)
  assert.ok(reloaded)
  assert.deepEqual(reloaded.reminderOffsets, ['-1d', '-2h'])
  assert.equal(reloaded.action, '发报价')
})

test('snapshots written before reminderOffsets keep loading unchanged', () => {
  const { ledger, matter } = fixture()
  const commitment = ledger.addCommitment(input(matter.id))
  const snapshot = ledger.toJSON()

  // Simulate a pre-0.2.0 snapshot: serialize then delete the new optional fields.
  const legacy = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>
  const legacyCommitments = (legacy.commitments as Array<Record<string, unknown>>).map((entry) => {
    const copy = { ...entry }
    delete copy.reminderOffsets
    return copy
  })
  legacy.commitments = legacyCommitments

  const restored = Ledger.fromJSON(legacy as unknown as typeof snapshot)
  const reloaded = restored.listCommitments().find((entry) => entry.id === commitment.id)
  assert.ok(reloaded)
  assert.equal(reloaded.reminderOffsets, undefined)
  assert.ok(!('reminderOffsets' in reloaded))
  assert.equal(restored.listCommitments().length, 1)

  // A minimal legacy snapshot (only version) must not throw either.
  const empty = Ledger.fromJSON({ version: 1, matters: [], facts: [], commitments: [], preferences: [], links: [], updates: [], routes: {}, routines: [] } as unknown as typeof snapshot)
  assert.deepEqual(empty.listCommitments(), [])
})

test('a forward-compatible snapshot entry with extra keys still loads', () => {
  const { ledger, matter } = fixture()
  const commitment = ledger.addCommitment(input(matter.id, { reminderOffsets: ['-1d'] }))
  const snapshot = ledger.toJSON()
  const entry = snapshot.commitments.find((candidate) => candidate.id === commitment.id)
  assert.ok(entry)
  ;(entry as unknown as Record<string, unknown>).unknownField = 'ignored'

  const restored = Ledger.fromJSON(snapshot)
  const reloaded = restored.listCommitments()[0]
  assert.ok(reloaded)
  assert.deepEqual(reloaded.reminderOffsets, ['-1d'])
  assert.equal(reloaded.id, commitment.id)
})
