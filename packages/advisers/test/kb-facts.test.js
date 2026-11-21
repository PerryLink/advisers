import assert from 'node:assert/strict'
import test from 'node:test'

import { kbAdd, kbLink } from '../lib/kb.js'
import { factAsOf, factHistory, factShow, normalizeAsOf } from '../lib/kb-facts.js'
import { createKbStore, seedLedger } from './kb-fixture.js'

function insertFact(store, row) {
  store.mutate(() => {
    store.insertFact({
      id: row.id,
      matterId: row.matterId ?? 'm_acme',
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      recordedAt: row.recordedAt,
      authority: row.authority ?? 'user',
      confidence: row.confidence ?? 0.9,
      evidence: row.evidence ?? [],
      status: row.status ?? 'confirmed',
      validFrom: row.validFrom,
      validTo: row.validTo,
      supersedes: row.supersedes,
      supersededBy: row.supersededBy,
      deletedAt: row.deletedAt,
      deletedReason: row.deletedReason,
    })
  })
}

function byKey(items, subject, predicate) {
  return items.find((item) => item.subject === subject && item.predicate === predicate)
}

test('fact show: full shape, evidence, client and explicit KB sources', async () => {
  const fixture = createKbStore('advisers-kb-fact-show-')
  try {
    const { acme } = seedLedger(fixture.store)
    const shown = factShow(fixture.store, 'fact_quote')
    assert.equal(shown.ok, true)
    assert.equal(shown.fact.subject, 'ACME')
    assert.equal(shown.fact.predicate, 'quote.total')
    assert.equal(shown.fact.object, '80000')
    assert.equal(shown.fact.clientId, acme.id)
    assert.equal(shown.fact.matterId, 'm_acme')
    assert.equal(shown.fact.evidence[0].quote, 'budget is 80000')
    assert.equal(shown.fact.fallback.validFromFromRecordedAt, false)
    assert.deepEqual(shown.kbSources, [])
    fixture.writeFile('quote.md', '# quote\n\ntotal 80000')
    const added = await kbAdd(fixture.store, { file: 'quote.md', cwd: fixture.root, clientId: acme.id })
    kbLink(fixture.store, { docId: added.document.id, factId: 'fact_quote', relation: 'source' })
    const withSources = factShow(fixture.store, 'fact_quote')
    assert.equal(withSources.kbSources.length, 1)
    assert.equal(withSources.kbSources[0].docId, added.document.id)
    assert.equal(withSources.kbSources[0].title, 'quote')
    assert.equal(withSources.kbSources[0].relation, 'source')
    assert.throws(() => factShow(fixture.store, 'fact_missing'), (error) => error.code === 'E_FACT_NOT_FOUND')
  } finally { fixture.cleanup() }
})

test('fact history: oldest -> newest, broken links and cycles stay non-fatal', () => {
  const fixture = createKbStore('advisers-kb-fact-history-')
  try {
    seedLedger(fixture.store)
    insertFact(fixture.store, { id: 'f_old', subject: 'Gamma', predicate: 'status', object: 'v1', recordedAt: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', status: 'superseded', supersededBy: 'f_new' })
    insertFact(fixture.store, { id: 'f_new', subject: 'Gamma', predicate: 'status', object: 'v2', recordedAt: '2026-02-01T00:00:00.000Z', validFrom: '2026-02-01T00:00:00.000Z', status: 'confirmed', supersedes: 'f_old' })
    const history = factHistory(fixture.store, 'f_new')
    assert.deepEqual(history.items.map((item) => item.id), ['f_old', 'f_new'])
    assert.deepEqual(history.warnings, [])
    insertFact(fixture.store, { id: 'f_broken', subject: 'Broken', predicate: 'p', object: 'o', recordedAt: '2026-01-01T00:00:00.000Z', supersedes: 'f_missing_back', supersededBy: 'f_missing_forward' })
    const broken = factHistory(fixture.store, 'f_broken')
    assert.equal(broken.items.length, 1)
    assert.equal(broken.warnings.length, 2)
    insertFact(fixture.store, { id: 'cyc_1', subject: 'Cycle', predicate: 'p', object: 'a', recordedAt: '2026-01-01T00:00:00.000Z', supersededBy: 'cyc_2' })
    insertFact(fixture.store, { id: 'cyc_2', subject: 'Cycle', predicate: 'p', object: 'b', recordedAt: '2026-01-02T00:00:00.000Z', supersededBy: 'cyc_1' })
    const cycle = factHistory(fixture.store, 'cyc_1')
    assert.ok(cycle.warnings.some((warning) => /cycle/i.test(warning)))
    assert.throws(() => factHistory(fixture.store, 'fact_missing'), (error) => error.code === 'E_FACT_NOT_FOUND')
  } finally { fixture.cleanup() }
})

test('fact as-of: validFrom/validTo, supersede boundary and group selection', () => {
  const fixture = createKbStore('advisers-kb-fact-asof-')
  try {
    seedLedger(fixture.store)
    insertFact(fixture.store, { id: 'g_old', subject: 'Gamma', predicate: 'amount', object: '80000', recordedAt: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-06-01T00:00:00.000Z', status: 'superseded', supersededBy: 'g_new' })
    insertFact(fixture.store, { id: 'g_new', subject: 'Gamma', predicate: 'amount', object: '90000', recordedAt: '2026-06-01T00:00:00.000Z', validFrom: '2026-06-01T00:00:00.000Z', status: 'confirmed', supersedes: 'g_old' })
    const march = factAsOf(fixture.store, { at: '2026-03-01' })
    const marchItem = byKey(march.items, 'Gamma', 'amount')
    assert.equal(marchItem.id, 'g_old')
    assert.equal(marchItem.object, '80000')
    assert.equal(marchItem.status, 'superseded', 'a superseded fact was true in the past')
    // validTo is exclusive: at 2026-06-01T00:00Z the old row has expired and the
    // new row starts (validFrom 2026-06-01T00:00Z).
    const june = factAsOf(fixture.store, { at: '2026-06-01T08:00:00+08:00' })
    assert.equal(byKey(june.items, 'Gamma', 'amount').id, 'g_new')
    const before = factAsOf(fixture.store, { at: '2025-12-31' })
    assert.equal(byKey(before.items, 'Gamma', 'amount'), undefined)
    // Two overlapping rows in one group: the later effective start wins.
    insertFact(fixture.store, { id: 'g_later', subject: 'Gamma', predicate: 'owner', object: 'Wang', recordedAt: '2026-03-01T00:00:00.000Z', validFrom: '2026-03-01T00:00:00.000Z', status: 'confirmed' })
    insertFact(fixture.store, { id: 'g_earlier', subject: 'Gamma', predicate: 'owner', object: 'Li', recordedAt: '2026-02-01T00:00:00.000Z', validFrom: '2026-02-01T00:00:00.000Z', status: 'confirmed' })
    const overlap = factAsOf(fixture.store, { at: '2026-04-01' })
    assert.equal(byKey(overlap.items, 'Gamma', 'owner').id, 'g_later')
    assert.ok(overlap.counts.overlappingGroups >= 1)
    assert.ok(overlap.warnings.some((warning) => /overlapping/i.test(warning)))
  } finally { fixture.cleanup() }
})

test('fact as-of: Asia/Shanghai local-day boundary and explicit limits', () => {
  const fixture = createKbStore('advisers-kb-fact-day-')
  try {
    seedLedger(fixture.store)
    insertFact(fixture.store, { id: 'day_early', subject: 'Day', predicate: 'k', object: 'early', recordedAt: '2026-01-01T00:30:00.000Z', validFrom: '2026-01-01T00:30:00.000Z' })
    insertFact(fixture.store, { id: 'day_late', subject: 'Day', predicate: 'k2', object: 'late', recordedAt: '2026-01-01T10:00:00.000Z', validFrom: '2026-01-01T10:00:00.000Z' })
    const midnight = factAsOf(fixture.store, { at: '2026-01-01' })
    assert.equal(midnight.asOfLocalDay, '2026-01-01')
    assert.equal(midnight.at, '2025-12-31T16:00:00.000Z')
    assert.equal(byKey(midnight.items, 'Day', 'k'), undefined, '00:30 Shanghai is after local midnight')
    const morning = factAsOf(fixture.store, { at: '2026-01-01T09:00:00+08:00' })
    assert.equal(byKey(morning.items, 'Day', 'k').id, 'day_early')
    assert.equal(byKey(morning.items, 'Day', 'k2'), undefined)
    assert.equal(byKey(factAsOf(fixture.store, { at: '2026-01-01T19:00:00+08:00' }).items, 'Day', 'k2').id, 'day_late')
    assert.throws(() => factAsOf(fixture.store, { at: 'not-a-date' }), (error) => error.code === 'E_USAGE')
    assert.throws(() => factAsOf(fixture.store, { at: '2026-02-30' }), (error) => error.code === 'E_USAGE')
    assert.throws(() => factAsOf(fixture.store, {}), (error) => error.code === 'E_USAGE')
    assert.throws(() => factAsOf(fixture.store, { at: '2026-03-01', clientId: 'cl_missing' }), (error) => error.code === 'E_CLIENT_NOT_FOUND')
    const limited = factAsOf(fixture.store, { at: '2026-03-01', limit: 1 })
    assert.equal(limited.items.length, 1)
    assert.ok(limited.items.length < limited.counts.groups)
    assert.equal(limited.truncated, true)
  } finally { fixture.cleanup() }
})

test('fact as-of: recordedAt fallback, tombstones and client/matter filters', () => {
  const fixture = createKbStore('advisers-kb-fact-deleted-')
  try {
    const { acme } = seedLedger(fixture.store)
    insertFact(fixture.store, { id: 'fallback', subject: 'Fallback', predicate: 'p', object: 'only-recorded', recordedAt: '2026-03-01T00:00:00.000Z' })
    const beforeRecorded = factAsOf(fixture.store, { at: '2026-02-01' })
    assert.equal(byKey(beforeRecorded.items, 'Fallback', 'p'), undefined)
    const afterRecorded = factAsOf(fixture.store, { at: '2026-03-01T09:00:00+08:00' })
    assert.equal(byKey(afterRecorded.items, 'Fallback', 'p').effectiveFrom, '2026-03-01T00:00:00.000Z')
    assert.ok(afterRecorded.degraded.includes('valid_from_fallback_recorded_at'))
    insertFact(fixture.store, { id: 'tombstone', subject: 'Tombstone', predicate: 'p', object: 'gone', recordedAt: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', deletedAt: '2026-07-01T00:00:00.000Z', deletedReason: 'wrong' })
    assert.equal(byKey(factAsOf(fixture.store, { at: '2026-03-01' }).items, 'Tombstone', 'p'), undefined)
    const withDeleted = factAsOf(fixture.store, { at: '2026-03-01', includeDeleted: true })
    const tombstoneItem = byKey(withDeleted.items, 'Tombstone', 'p')
    assert.equal(tombstoneItem.id, 'tombstone')
    assert.equal(tombstoneItem.deletedAt, '2026-07-01T00:00:00.000Z')
    assert.equal(tombstoneItem.deletedReason, 'wrong')
    assert.equal(byKey(factAsOf(fixture.store, { at: '2026-08-01', includeDeleted: true }).items, 'Tombstone', 'p'), undefined)
    const clientScoped = factAsOf(fixture.store, { at: '2026-03-01', clientId: acme.id })
    assert.ok(clientScoped.items.every((item) => item.clientId === acme.id))
    const matterScoped = factAsOf(fixture.store, { at: '2026-03-01', matterId: 'm_acme', subject: 'ACME' })
    assert.ok(matterScoped.items.every((item) => item.matterId === 'm_acme' && item.subject === 'ACME'))
    assert.throws(() => factAsOf(fixture.store, { at: '2026-03-01', matterId: 'm_missing' }), (error) => error.code === 'E_MATTER_NOT_FOUND')
    // Determinism: the same rows + instant produce byte-identical JSON.
    assert.deepEqual(factAsOf(fixture.store, { at: '2026-03-01' }), factAsOf(fixture.store, { at: '2026-03-01' }))
    assert.equal(normalizeAsOf('2026-03-01').asOfLocalDay, '2026-03-01')
  } finally { fixture.cleanup() }
})
