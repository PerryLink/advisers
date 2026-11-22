/**
 * Tests for lib/fact-entry.js (manual fact entry, 0.4.x).
 *
 * Every test opens a throwaway SqliteStore under a mktemp directory, so the
 * real ~/.advisers is never touched (same isolation rule as the KB/mail tests:
 * a temporary ADVISERS_HOME-style root, ADVISERS_ACCEPT_TOS=1 when run via the
 * package test command). No test writes outside its tmpdir.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteStore } from '../lib/sqlite.js'
import {
  FACT_ENTRY_ACTION,
  FACT_ENTRY_LIMITS,
  FACT_ENTRY_RELATIONS,
  factAdd,
  factEntry,
} from '../lib/fact-entry.js'

const AT = '2026-01-01T00:00:00.000Z'
const NOW = '2026-11-22T02:00:00.000Z'
const FACT_ID_RE = /^fact_[0-9a-f]{16}$/

function openStore() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-fact-entry-'))
  const store = new SqliteStore(join(root, 'state.db'))
  return {
    root,
    store,
    cleanup() {
      try { store.close() } catch {}
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    },
  }
}

function auditRows(store) {
  return store.db.prepare('SELECT seq, actor, action, allowed, reason FROM audit ORDER BY seq').all()
}

function countFacts(store) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM facts').get().n
}

function seedFact(store, row) {
  store.mutate(() => {
    store.insertFact({
      id: row.id,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      recordedAt: row.recordedAt ?? AT,
      authority: row.authority ?? 'user',
      confidence: row.confidence ?? 0.9,
      evidence: row.evidence ?? [],
      status: row.status ?? 'confirmed',
      validFrom: row.validFrom ?? AT,
      ...(row.matterId === undefined ? {} : { matterId: row.matterId }),
      ...(row.expiredAt === undefined ? {} : { expiredAt: row.expiredAt }),
      ...(row.deletedAt === undefined ? {} : { deletedAt: row.deletedAt }),
      ...(row.validTo === undefined ? {} : { validTo: row.validTo }),
      ...(row.supersededBy === undefined ? {} : { supersededBy: row.supersededBy }),
      ...(row.supersedes === undefined ? {} : { supersedes: row.supersedes }),
    })
  })
}

function seedMatter(store, id, title = 'ACME relaunch') {
  store.mutate(() => store.insertMatter({
    id,
    title,
    status: 'active',
    domain: 'work',
    secrecy: 0,
    participants: [],
    deadlines: [],
    openQuestions: [],
    createdAt: AT,
    updatedAt: AT,
  }))
}

function seedKbDoc(store, id, { status = 'active', deletedAt = null } = {}) {
  store.db.prepare(
    'INSERT INTO kb_documents(id,kind,title,source_sha256,size_bytes,extractor,status,created_at,captured_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(id, 'note', 'Quote note', String(id).padEnd(64, '0'), 12, 'text', status, AT, AT, deletedAt)
}

function linksOf(store, factId) {
  return store.db.prepare('SELECT doc_id, chunk_id, relation, created_at FROM kb_fact_links WHERE fact_id = ? ORDER BY relation')
    .all(factId).map((row) => ({ ...row }))
}

test('fact add: writes a user/confirmed fact with now defaults and one audit row', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    const before = auditRows(store).length
    const result = factAdd(store, {
      subject: '  ACME  ',
      predicate: 'quote.total',
      object: '80000',
      quote: 'budget is 80000',
    }, { now: NOW })
    assert.equal(result.ok, true)
    assert.equal(result.deduped, false)
    assert.equal(result.audit.action, FACT_ENTRY_ACTION)
    const fact = result.fact
    assert.match(fact.id, FACT_ID_RE)
    assert.equal(fact.subject, 'ACME')
    assert.equal(fact.predicate, 'quote.total')
    assert.equal(fact.object, '80000')
    assert.equal(fact.authority, 'user')
    assert.equal(fact.status, 'confirmed')
    assert.equal(fact.confidence, 1)
    assert.equal(fact.recordedAt, NOW)
    assert.equal(fact.validFrom, NOW, 'validFrom defaults to now')
    assert.deepEqual(fact.evidence, [{ quote: 'budget is 80000' }])
    assert.equal(fact.matterId, undefined)
    assert.equal(fact.supersedes, undefined)
    assert.deepEqual(store.getFact(fact.id), fact, 'the returned row is the persisted row')
    const rows = auditRows(store)
    assert.equal(rows.length, before + 1)
    const newest = rows[rows.length - 1]
    assert.equal(newest.actor, 'local')
    assert.equal(newest.action, FACT_ENTRY_ACTION)
    assert.equal(newest.allowed, 1)
    assert.ok(newest.reason.includes(fact.id))
    assert.ok(!newest.reason.includes('ACME'), 'audit carries ids only, never the subject')
    assert.ok(!newest.reason.includes('budget is 80000'), 'audit carries ids only, never the quote')
  } finally { fixture.cleanup() }
})

test('fact add: matter + validFrom forms are validated and stored', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    seedMatter(store, 'm_acme')
    const iso = factAdd(store, {
      subject: 'ACME', predicate: 'deadline', object: '2026-12-01', quote: 'due Dec 1',
      matterId: ' m_acme ', validFrom: '2026-12-01T09:00:00+08:00',
    }, { now: NOW })
    assert.equal(iso.fact.matterId, 'm_acme')
    assert.equal(iso.fact.validFrom, '2026-12-01T01:00:00.000Z', 'instants are normalized to UTC')
    const day = factAdd(store, {
      subject: 'ACME', predicate: 'kickoff', object: 'Monday', quote: 'kickoff Monday',
      matterId: 'm_acme', validFrom: '2026-12-01',
    }, { now: NOW })
    assert.equal(day.fact.validFrom, '2026-12-01', 'a date-only validFrom keeps the Shanghai day semantics')
    assert.throws(
      () => factAdd(store, { subject: 'ACME', predicate: 'x', object: 'y', quote: 'q', validFrom: 'next friday' }, { now: NOW }),
      (error) => error.code === 'E_USAGE' && /validFrom/.test(error.message),
    )
    assert.throws(
      () => factAdd(store, { subject: 'ACME', predicate: 'x', object: 'y', quote: 'q', validFrom: '2026-02-30' }, { now: NOW }),
      (error) => error.code === 'E_USAGE',
    )
    assert.throws(
      () => factAdd(store, { subject: 'ACME', predicate: 'x', object: 'y', quote: 'q', matterId: 'm_missing' }, { now: NOW }),
      (error) => error.code === 'E_MATTER_NOT_FOUND',
    )
    assert.equal(countFacts(store), 2, 'rejected entries wrote nothing')
  } finally { fixture.cleanup() }
})

test('fact add: missing/empty fields and a missing quote are rejected with E_USAGE', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    const before = auditRows(store).length
    const good = { subject: 'ACME', predicate: 'quote.total', object: '80000', quote: 'budget is 80000' }
    const bad = [
      { ...good, subject: undefined },
      { ...good, subject: '' },
      { ...good, subject: '   ' },
      { ...good, subject: null },
      { ...good, subject: 42 },
      { ...good, predicate: undefined },
      { ...good, predicate: '  ' },
      { ...good, object: undefined },
      { ...good, object: '' },
      { ...good, quote: undefined },
      { ...good, quote: '' },
      { ...good, quote: '   ' },
      { ...good, subject: 's'.repeat(FACT_ENTRY_LIMITS.subject + 1) },
      { ...good, predicate: 'p'.repeat(FACT_ENTRY_LIMITS.predicate + 1) },
      { ...good, object: 'o'.repeat(FACT_ENTRY_LIMITS.object + 1) },
      { ...good, quote: 'q'.repeat(FACT_ENTRY_LIMITS.quote + 1) },
    ]
    for (const input of bad) {
      assert.throws(() => factAdd(store, input, { now: NOW }), (error) => error.code === 'E_USAGE', JSON.stringify(input))
    }
    assert.equal(countFacts(store), 0)
    assert.equal(auditRows(store).length, before, 'rejected input appends no audit row')
  } finally { fixture.cleanup() }
})

test('fact add: operator text is folded/sanitized before it reaches the ledger', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    const result = factAdd(store, {
      subject: 'ACME\n   Ltd',
      predicate: 'quote\ttotal',
      object: '80\u0007000',
      quote: '\u001b[31mbudget\u001b[0m\u202e 80000\u0007',
    }, { now: NOW })
    assert.equal(result.fact.subject, 'ACME Ltd')
    assert.equal(result.fact.predicate, 'quote total')
    assert.equal(result.fact.object, '80 000')
    assert.equal(result.fact.evidence[0].quote, 'budget 80000', 'terminal escapes, bidi and control chars are stripped')
  } finally { fixture.cleanup() }
})

test('fact add: a duplicate active fact is an idempotent no-op (deduped:true)', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    seedMatter(store, 'm_acme')
    const first = factAdd(store, { subject: 'ACME', predicate: 'quote.total', object: '80000', quote: 'budget is 80000' }, { now: NOW })
    const auditAfterFirst = auditRows(store).length
    const second = factAdd(store, { subject: 'ACME', predicate: 'quote.total', object: '80000', quote: 'confirmed again later' }, { now: '2026-11-23T02:00:00.000Z' })
    assert.equal(second.ok, true)
    assert.equal(second.deduped, true)
    assert.equal(second.audit, null)
    assert.equal(second.fact.id, first.fact.id)
    assert.deepEqual(second.fact.evidence, [{ quote: 'budget is 80000' }], 'a repeat entry does not merge or replace evidence')
    assert.equal(second.fact.recordedAt, NOW, 'a repeat entry does not refresh recordedAt')
    assert.equal(countFacts(store), 1)
    assert.equal(auditRows(store).length, auditAfterFirst, 'a deduped call appends no audit row')
    const otherMatter = factAdd(store, { subject: 'ACME', predicate: 'quote.total', object: '80000', quote: 'same object, other matter', matterId: 'm_acme' }, { now: NOW })
    assert.equal(otherMatter.deduped, false, 'matter scoping is part of the duplicate key')
    const otherObject = factAdd(store, { subject: 'ACME', predicate: 'quote.total', object: '90000', quote: 'quote changed' }, { now: NOW })
    assert.equal(otherObject.deduped, false, 'a different object is a new fact, not a duplicate')
    assert.equal(countFacts(store), 3)
  } finally { fixture.cleanup() }
})

test('fact add: only ACTIVE identical rows count as duplicates', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    seedFact(store, { id: 'f_expired', subject: 'ACME', predicate: 'quote.total', object: '80000', expiredAt: AT })
    seedFact(store, { id: 'f_superseded', subject: 'ACME', predicate: 'quote.owner', object: 'Wang', status: 'superseded', supersededBy: 'f_newer' })
    seedFact(store, { id: 'f_deleted', subject: 'ACME', predicate: 'quote.currency', object: 'CNY', deletedAt: AT })
    const result = factAdd(store, { subject: 'ACME', predicate: 'quote.total', object: '80000', quote: 'budget is 80000' }, { now: NOW })
    assert.equal(result.deduped, false, 'expired identical row does not dedupe')
    assert.equal(factAdd(store, { subject: 'ACME', predicate: 'quote.owner', object: 'Wang', quote: 'owner Wang' }, { now: NOW }).deduped, false)
    assert.equal(factAdd(store, { subject: 'ACME', predicate: 'quote.currency', object: 'CNY', quote: 'currency CNY' }, { now: NOW }).deduped, false)
  } finally { fixture.cleanup() }
})

test('fact add: evidence source object is preserved verbatim and bounded', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    const withSource = factAdd(store, {
      subject: 'ACME', predicate: 'quote.total', object: '80000', quote: 'budget is 80000',
      source: { type: 'mail', ref: 'eml:acct_local_eml:msg_1', subject: 'Quote follow-up' },
    }, { now: NOW })
    assert.deepEqual(withSource.fact.evidence[0], {
      quote: 'budget is 80000',
      source: { type: 'mail', ref: 'eml:acct_local_eml:msg_1', subject: 'Quote follow-up' },
    })
    const plain = factAdd(store, { subject: 'ACME', predicate: 'quote.owner', object: 'Wang', quote: 'owner is Wang' }, { now: NOW })
    assert.deepEqual(Object.keys(plain.fact.evidence[0]), ['quote'], 'source is optional and never invented')
    assert.throws(
      () => factAdd(store, { subject: 'ACME', predicate: 'x', object: 'y', quote: 'q', source: ['not-an-object'] }, { now: NOW }),
      (error) => error.code === 'E_USAGE',
    )
    assert.throws(
      () => factAdd(store, { subject: 'ACME', predicate: 'x', object: 'y', quote: 'q', source: { blob: 'x'.repeat(FACT_ENTRY_LIMITS.sourceBytes) } }, { now: NOW }),
      (error) => error.code === 'E_USAGE' && /too large/.test(error.message),
    )
    const circular = {}
    circular.self = circular
    assert.throws(
      () => factAdd(store, { subject: 'ACME', predicate: 'x', object: 'y', quote: 'q', source: circular }, { now: NOW }),
      (error) => error.code === 'E_USAGE' && /JSON-serializable/.test(error.message),
    )
    assert.equal(countFacts(store), 2)
  } finally { fixture.cleanup() }
})

test('fact add: supersedes replaces the current fact for the same identity', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    seedFact(store, { id: 'f_old', subject: 'ACME', predicate: 'quote.total', object: '80000' })
    seedFact(store, { id: 'f_other', subject: 'ACME', predicate: 'quote.subtotal', object: '1000' })
    const result = factAdd(store, {
      subject: 'ACME', predicate: 'quote.total', object: '90000', quote: 'the quote is now 90000', supersedes: 'f_old',
    }, { now: NOW })
    assert.equal(result.deduped, false)
    assert.equal(result.fact.supersedes, 'f_old')
    assert.ok(result.audit.reason.includes('supersedes f_old'))
    const old = store.getFact('f_old')
    assert.equal(old.status, 'superseded')
    assert.equal(old.supersededBy, result.fact.id)
    assert.equal(old.expiredAt, NOW)
    assert.equal(old.validTo, NOW)
    assert.throws(
      () => factAdd(store, { subject: 'ACME', predicate: 'quote.total', object: '95000', quote: 'q', supersedes: 'f_missing' }, { now: NOW }),
      (error) => error.code === 'E_FACT_NOT_FOUND',
    )
    assert.throws(
      () => factAdd(store, { subject: 'ACME', predicate: 'other', object: '95000', quote: 'q', supersedes: 'f_other' }, { now: NOW }),
      (error) => error.code === 'E_USAGE' && /subject\/predicate\/matter/.test(error.message),
      'only the current fact of the same identity can be superseded',
    )
    assert.throws(
      () => factAdd(store, { subject: 'ACME', predicate: 'quote.total', object: '96000', quote: 'q', supersedes: 'f_old' }, { now: NOW }),
      (error) => error.code === 'E_USAGE' && /not an active confirmed fact/.test(error.message),
      'an already superseded fact is not active',
    )
    assert.equal(countFacts(store), 3, 'rejected supersede attempts wrote nothing')
  } finally { fixture.cleanup() }
})

test('fact add: relation links the new fact to one KB document (source|mentions)', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    seedKbDoc(store, 'kb_quote')
    seedKbDoc(store, 'kb_gone', { status: 'deleted', deletedAt: AT })
    const linked = factAdd(store, {
      subject: 'ACME', predicate: 'quote.total', object: '80000', quote: 'budget is 80000',
      docId: 'kb_quote', relation: 'mentions',
    }, { now: NOW })
    assert.deepEqual(linksOf(store, linked.fact.id), [{ doc_id: 'kb_quote', chunk_id: null, relation: 'mentions', created_at: NOW }])
    const defaulted = factAdd(store, { subject: 'ACME', predicate: 'quote.owner', object: 'Wang', quote: 'owner is Wang', docId: 'kb_quote' }, { now: NOW })
    assert.deepEqual(linksOf(store, defaulted.fact.id).map((row) => row.relation), ['source'], 'docId without relation defaults to source (kbLink default)')
    assert.deepEqual(FACT_ENTRY_RELATIONS, ['source', 'mentions'])
    assert.throws(
      () => factAdd(store, { subject: 'ACME', predicate: 'x', object: 'y', quote: 'q', relation: 'source' }, { now: NOW }),
      (error) => error.code === 'E_USAGE' && /docId/.test(error.message),
    )
    assert.throws(
      () => factAdd(store, { subject: 'ACME', predicate: 'x', object: 'y', quote: 'q', docId: 'kb_quote', relation: 'supersedes' }, { now: NOW }),
      (error) => error.code === 'E_KB_INVALID' && /supersedes/.test(error.hint ?? error.message),
      'supersedes is a fact pointer, not a relation',
    )
    assert.throws(
      () => factAdd(store, { subject: 'ACME', predicate: 'x', object: 'y', quote: 'q', docId: 'kb_missing' }, { now: NOW }),
      (error) => error.code === 'E_KB_NOT_FOUND',
    )
    assert.throws(
      () => factAdd(store, { subject: 'ACME', predicate: 'x', object: 'y', quote: 'q', docId: 'kb_gone' }, { now: NOW }),
      (error) => error.code === 'E_KB_NOT_FOUND',
    )
    assert.equal(countFacts(store), 2)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM kb_fact_links').get().n, 2)
  } finally { fixture.cleanup() }
})

test('fact add: a failure after the insert rolls back the fact, the supersede update and the audit row', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    seedFact(store, { id: 'f_old', subject: 'ACME', predicate: 'quote.total', object: '80000' })
    const beforeAudit = auditRows(store).length
    const realUpdate = store.updateFact
    store.updateFact = () => { throw new Error('injected update failure') }
    try {
      assert.throws(
        () => factAdd(store, { subject: 'ACME', predicate: 'quote.total', object: '90000', quote: 'q', supersedes: 'f_old' }, { now: NOW }),
        /injected update failure/,
      )
    } finally {
      store.updateFact = realUpdate
    }
    assert.equal(countFacts(store), 1, 'the inserted fact was rolled back')
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE object = '90000'").get().n, 0)
    const old = store.getFact('f_old')
    assert.equal(old.status, 'confirmed', 'the superseded update was rolled back')
    assert.equal(old.supersededBy, undefined)
    assert.equal(old.expiredAt, undefined)
    assert.equal(auditRows(store).length, beforeAudit, 'no audit row survives a rolled-back write')
  } finally { fixture.cleanup() }
})

test('fact entry: module surface', () => {
  assert.equal(factEntry, factAdd, 'factEntry is the file-name alias of factAdd')
  assert.equal(typeof factAdd, 'function')
  assert.equal(FACT_ENTRY_ACTION, 'fact.add')
  assert.throws(() => factAdd(null, {}), TypeError)
  assert.throws(() => factAdd({ db: {} }, {}), TypeError)
})
