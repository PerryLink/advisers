import assert from 'node:assert/strict'
import test from 'node:test'
import { Ledger } from '../src/index.ts'

/**
 * P1-2 (0.2.2): partial ledger loading.
 *
 * The CLI's SqliteStore partial loaders return a subset of the tables a full
 * store.load() would return, so the core Ledger must accept a snapshot that
 * omits tables. fromParts() is the explicit entry point; fromJSON() keeps its
 * historical full-snapshot contract and also tolerates partial snapshots.
 */
function seed() {
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '客户 A', domain: 'consulting', summary: '报价' })
  ledger.remember({ subject: '客户A', predicate: '要求', object: '先给总价', matterId: matter.id })
  ledger.addPreference({ kind: 'preference', statement: '邮件先结论' })
  ledger.addCommitment({
    matterId: matter.id,
    debtor: 'agent',
    creditor: 'user',
    action: '发报价',
    evidence: [{ sessionId: 's1', turnId: 't1', quote: '周五前发' }],
  })
  ledger.addRoutine({
    name: '周报', description: '周五给老板', trigger: ['周五'], steps: ['汇总'],
    preferences: [], pitfalls: [], verification: [], createdBy: 'user',
  })
  return ledger
}

test('fromParts loads a subset and treats omitted tables as empty', () => {
  const full = seed().toJSON()
  const partial = Ledger.fromParts({ version: 1, matters: full.matters, commitments: full.commitments })
  assert.equal(partial.listMatters().length, 1)
  assert.equal(partial.listCommitments().length, 1)
  assert.deepEqual(partial.listFacts(), [])
  assert.deepEqual(partial.listPreferences(), [])
  assert.deepEqual(partial.listRoutines(), [])
  assert.deepEqual(partial.toJSON().facts, [])
})

test('fromParts preserves every provided table row-for-row', () => {
  const full = seed().toJSON()
  const restored = Ledger.fromParts({
    version: 1,
    matters: full.matters,
    facts: full.facts,
    commitments: full.commitments,
    preferences: full.preferences,
    links: full.links,
    updates: full.updates,
    routes: full.routes,
    routines: full.routines,
    routinePatches: full.routinePatches,
  })
  assert.deepEqual(restored.toJSON(), full)
})

test('fromJSON keeps accepting complete snapshots unchanged', () => {
  const full = seed().toJSON()
  const restored = Ledger.fromJSON(JSON.parse(JSON.stringify(full)))
  // Compare the serialized form: JSON drops undefined-valued keys that the
  // in-memory objects keep, which is pre-existing fromJSON() behaviour.
  assert.deepEqual(JSON.parse(JSON.stringify(restored.toJSON())), JSON.parse(JSON.stringify(full)))
  assert.equal(restored.listFacts().length, 1)
  assert.equal(restored.openCommitments().length, 1)
})

test('fromJSON also accepts partial snapshots (missing tables are empty)', () => {
  const full = seed().toJSON()
  const restored = Ledger.fromJSON({
    version: 1,
    commitments: full.commitments,
    preferences: full.preferences,
  } as Parameters<typeof Ledger.fromParts>[0])
  assert.equal(restored.listCommitments().length, 1)
  assert.equal(restored.listPreferences().length, 1)
  assert.deepEqual(restored.listMatters(), [])
})

test('a partial ledger serializes to a well-formed snapshot that round-trips', () => {
  const full = seed().toJSON()
  const partial = Ledger.fromParts({ version: 1, commitments: full.commitments })
  const snapshot = JSON.parse(JSON.stringify(partial.toJSON()))
  assert.equal(snapshot.version, 1)
  for (const table of ['matters', 'facts', 'commitments', 'preferences', 'links', 'updates', 'routines', 'routinePatches']) {
    assert.ok(Array.isArray(snapshot[table]), table + ' must still be an array')
  }
  assert.deepEqual(snapshot.routes, {})
  // JSON.stringify drops undefined-valued keys (dueAt was never set), so compare
  // the fields that carry data rather than the in-memory object identities.
  const pick = (commitments: ReturnType<Ledger['listCommitments']>) => commitments.map((c) => ({ id: c.id, action: c.action, status: c.status, evidence: c.evidence }))
  assert.deepEqual(pick(Ledger.fromJSON(snapshot).listCommitments()), pick(partial.listCommitments()))
})
