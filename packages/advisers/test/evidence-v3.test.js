/**
 * Evidence 2.0 (0.4 subset): four-state resolver + typed source v2.
 *
 * Regression anchor: the 0.4 research experiments A-1/A-2 reported mail and
 * KB refs as `missing(invalid_evidence/unparseable_ref)` because the resolver
 * only read the legacy session#turn pointer. They must now be honest
 * unverifiable/not_checked rows (never missing) unless a local lookup proves a
 * quote mismatch or a deleted store row.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'
import {
  EVIDENCE_KINDS,
  EVIDENCE_RESOLUTIONS,
  VERIFICATION_BASIS,
  buildEvidencePack,
  evidenceDescriptor,
  evidenceForCommitment,
  evidenceForFact,
  resolveEvidenceSource,
  sha256Hex,
  sourceTypeFromRef,
} from '../lib/evidence.js'

const GOOD_QUOTE = '我周五前把报价发给你'

function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-evidence-v3-'))
  const store = new SqliteStore(join(dir, 'state.db'))
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '客户 A' })
  const turn = store.addTurn({ conversationId: 'conv-1', role: 'user', content: '背景：' + GOOD_QUOTE + '，请放心。' })
  const typed =
    typeof options.typedStore === 'function'
      ? options.typedStore({ store, ledger, matter, turn })
      : { getTurn: (id) => store.getTurn(id), listTurns: (conversationId, limit) => store.listTurns(conversationId, limit) }
  return {
    dir,
    store: typed,
    ledger,
    matter,
    turn,
    cleanup() {
      try {
        store.close()
      } catch {}
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function usingFixture(options, fn) {
  const f = fixture(options)
  try {
    return fn(f)
  } finally {
    f.cleanup()
  }
}

function mailStore(messages) {
  const byId = new Map(messages.map((message) => [message.message_id ?? message.messageId, message]))
  return ({ store }) => ({
    getTurn: (id) => store.getTurn(id),
    listTurns: (conversationId, limit) => store.listTurns(conversationId, limit),
    getMailMessage: (selector) => byId.get(selector.messageId) ?? null,
  })
}

function kbStore({ chunk = null, page = null } = {}) {
  return ({ store }) => ({
    getTurn: (id) => store.getTurn(id),
    listTurns: (conversationId, limit) => store.listTurns(conversationId, limit),
    getKbChunk: () => chunk,
    getKbPage: () => page,
  })
}

function commitmentWith(f, evidence) {
  return f.ledger.addCommitment({ matterId: f.matter.id, debtor: 'agent', creditor: '王工', action: '发报价', evidence })
}

// ---------------------------------------------------------------------------
// A-1 / A-2: mail and KB refs are no longer missing
// ---------------------------------------------------------------------------

test('A-1: a mailed commitment evidence is unverifiable, not missing(invalid_evidence)', () => {
  usingFixture({}, (f) => {
    const commitment = commitmentWith(f, [{ quote: '请把报价发给我', type: 'mail', messageId: '<m1@example.com>', subject: '报价' }])
    const result = evidenceForCommitment(f.store, f.ledger, commitment.id)
    assert.deepEqual(result.missing, [])
    assert.equal(result.sources.length, 0)
    assert.equal(result.unverifiable.length, 1)
    const [item] = result.unverifiable
    assert.equal(item.reason, 'source_not_retained')
    assert.equal(item.type, 'mail')
    assert.equal(item.kind, 'observed')
    assert.equal(item.resolution, 'unverifiable')
    assert.equal(item.quote, '请把报价发给我')
    assert.equal(item.messageId, '<m1@example.com>')
    assert.deepEqual(result.notChecked, [])
    assert.equal(result.notCheckedCount, 0)
    assert.equal(result.verificationBasis, VERIFICATION_BASIS)

    const pack = buildEvidencePack({ store: f.store, ledger: f.ledger, ids: [commitment.id] })
    assert.equal(pack.summary.missingCount, 0, 'mail evidence must not be counted as missing')
    assert.equal(pack.summary.unverifiableCount, 1)
  })
})

test('A-2: a fact with ref mail:<id> and source v2 is not missing(unparseable_ref)', () => {
  usingFixture({}, (f) => {
    const fact = f.ledger.remember({
      subject: '王工',
      predicate: 'asked',
      object: '报价',
      matterId: f.matter.id,
      evidence: [{ quote: '请把报价发给我', ref: 'mail:<m2@example.com>', source: { sourceVersion: 2, type: 'mail', messageId: '<m2@example.com>' } }],
    })
    const result = evidenceForFact(f.store, f.ledger, fact.id)
    assert.deepEqual(result.missing, [])
    assert.equal(result.unverifiable.length, 1)
    assert.equal(result.unverifiable[0].type, 'mail')
    assert.equal(result.unverifiable[0].reason, 'source_not_retained')
  })
})

// ---------------------------------------------------------------------------
// four states for typed sources (mail / KB / web / tool)
// ---------------------------------------------------------------------------

test('mail: a retained body verifies the quote; a forged quote becomes missing', () => {
  usingFixture(
    {
      typedStore: mailStore([
        { message_id: '<m1@example.com>', subject: '报价', body_text: '王工：请把报价单周五前发给我。', retained: true },
      ]),
    },
    (f) => {
      const good = commitmentWith(f, [{ quote: '请把报价单周五前发给我', type: 'mail', messageId: '<m1@example.com>' }])
      const result = evidenceForCommitment(f.store, f.ledger, good.id)
      assert.deepEqual(result.missing, [])
      assert.equal(result.sources.length, 1)
      const [source] = result.sources
      assert.equal(source.type, 'mail')
      assert.equal(source.kind, 'observed')
      assert.equal(source.resolution, 'verified')
      assert.equal(source.quoteVerified, true)
      assert.equal(source.retained, true)
      assert.equal(source.sourceDigest, sha256Hex('王工：请把报价单周五前发给我。'))
      assert.equal(source.messageId, '<m1@example.com>')

      const forged = commitmentWith(f, [{ quote: '请把合同原件发给我', type: 'mail', messageId: '<m1@example.com>' }])
      const forgedResult = evidenceForCommitment(f.store, f.ledger, forged.id)
      assert.deepEqual(forgedResult.sources, [])
      assert.equal(forgedResult.missing.length, 1)
      assert.equal(forgedResult.missing[0].reason, 'quote_mismatch')
    },
  )
})

test('mail: a purged body is unverifiable(mail_body_purged), never missing', () => {
  usingFixture(
    { typedStore: mailStore([{ message_id: '<m1@example.com>', purged_at: '2026-11-21T00:00:00.000Z', body_text: null }]) },
    (f) => {
      const commitment = commitmentWith(f, [{ quote: '请把报价发给我', type: 'mail', messageId: '<m1@example.com>', retained: true }])
      const result = evidenceForCommitment(f.store, f.ledger, commitment.id)
      assert.deepEqual(result.missing, [])
      assert.equal(result.unverifiable[0].reason, 'mail_body_purged')
      assert.equal(result.unverifiable[0].retained, false)
    },
  )
})

test('mail: a retained body that is missing from the store is missing(message_not_found)', () => {
  usingFixture({ typedStore: mailStore([]) }, (f) => {
    const commitment = commitmentWith(f, [{ quote: 'q', type: 'mail', messageId: '<gone@example.com>', retained: true }])
    const result = evidenceForCommitment(f.store, f.ledger, commitment.id)
    assert.equal(result.missing.length, 1)
    assert.equal(result.missing[0].reason, 'message_not_found')
  })
})

test('kb_chunk: verified / deleted / quote-mismatch / lookup-unavailable states', () => {
  usingFixture(
    { typedStore: kbStore({ chunk: { id: 'chunk_1', doc_id: 'doc_1', seq: 0, text: '合同第八条：付款周期为 30 天。', status: 'active' } }) },
    (f) => {
      const fact = f.ledger.remember({
        subject: '合同',
        predicate: 'says',
        object: '付款周期',
        matterId: f.matter.id,
        evidence: [{ quote: '付款周期为 30 天', type: 'kb_chunk', docId: 'doc_1', chunkIndex: 0 }],
      })
      const result = evidenceForFact(f.store, f.ledger, fact.id)
      assert.deepEqual(result.missing, [])
      assert.equal(result.sources.length, 1)
      assert.equal(result.sources[0].type, 'kb_chunk')
      assert.equal(result.sources[0].resolution, 'verified')
      assert.equal(result.sources[0].docId, 'doc_1')
      assert.equal(result.sources[0].chunkIndex, 0)
      assert.equal(result.sources[0].sourceDigest, sha256Hex('合同第八条：付款周期为 30 天。'))
    },
  )
  usingFixture(
    { typedStore: kbStore({ chunk: { id: 'chunk_1', doc_id: 'doc_1', seq: 0, text: 'x', deleted_at: '2026-11-21T00:00:00.000Z' } }) },
    (f) => {
      const fact = f.ledger.remember({ subject: 's', predicate: 'p', object: 'o', matterId: f.matter.id, evidence: [{ quote: 'x', type: 'kb_chunk', docId: 'doc_1' }] })
      const result = evidenceForFact(f.store, f.ledger, fact.id)
      assert.equal(result.missing.length, 1)
      assert.equal(result.missing[0].reason, 'chunk_not_found', 'a deleted chunk is a missing source')
    },
  )
  usingFixture(
    { typedStore: kbStore({ chunk: { id: 'chunk_1', doc_id: 'doc_1', seq: 0, text: '合同第八条：付款周期为 30 天。' } }) },
    (f) => {
      const fact = f.ledger.remember({ subject: 's', predicate: 'p', object: 'o', matterId: f.matter.id, evidence: [{ quote: '伪造引用', type: 'kb_chunk', docId: 'doc_1' }] })
      const result = evidenceForFact(f.store, f.ledger, fact.id)
      assert.equal(result.missing[0].reason, 'quote_mismatch')
    },
  )
  usingFixture({}, (f) => {
    const fact = f.ledger.remember({ subject: 's', predicate: 'p', object: 'o', matterId: f.matter.id, evidence: [{ quote: 'q', type: 'kb_chunk', docId: 'doc_1' }] })
    const result = evidenceForFact(f.store, f.ledger, fact.id)
    assert.deepEqual(result.missing, [], 'no lookup capability is not_checked, not missing')
    assert.equal(result.notChecked.length, 1)
    assert.equal(result.notChecked[0].reason, 'kb_lookup_unavailable')
    assert.equal(result.notCheckedCount, 1)
  })
})

test('kb_page: verified / deleted states', () => {
  usingFixture(
    { typedStore: kbStore({ page: { id: 'page_1', title: '客户 A 周报', markdown: '# 周报\n本周完成报价。', status: 'generated' } }) },
    (f) => {
      const fact = f.ledger.remember({ subject: 's', predicate: 'p', object: 'o', matterId: f.matter.id, evidence: [{ quote: '本周完成报价', type: 'kb_page', pageId: 'page_1' }] })
      const result = evidenceForFact(f.store, f.ledger, fact.id)
      assert.equal(result.sources.length, 1)
      assert.equal(result.sources[0].type, 'kb_page')
      assert.equal(result.sources[0].sourceDigest, sha256Hex('# 周报\n本周完成报价。'))
    },
  )
  usingFixture(
    { typedStore: kbStore({ page: { id: 'page_1', markdown: 'x', deleted_at: '2026-11-21T00:00:00.000Z' } }) },
    (f) => {
      const fact = f.ledger.remember({ subject: 's', predicate: 'p', object: 'o', matterId: f.matter.id, evidence: [{ quote: 'x', type: 'kb_page', pageId: 'page_1' }] })
      const result = evidenceForFact(f.store, f.ledger, fact.id)
      assert.equal(result.missing[0].reason, 'page_not_found')
    },
  )
})

test('web and tool sources are unverifiable by design; ref schemes classify them', () => {
  usingFixture({}, (f) => {
    const fact = f.ledger.remember({
      subject: 's',
      predicate: 'p',
      object: 'o',
      matterId: f.matter.id,
      evidence: [
        { quote: '新闻标题', ref: 'web:https://example.com/a' },
        { quote: '工具输出', ref: 'tool:turn_1#read_file' },
      ],
    })
    const result = evidenceForFact(f.store, f.ledger, fact.id)
    assert.deepEqual(result.missing, [])
    assert.equal(result.unverifiable.length, 2)
    assert.deepEqual(result.unverifiable.map((item) => item.type).sort(), ['tool', 'web'])
    assert.equal(result.unverifiable.find((item) => item.type === 'web').reason, 'source_not_retained')
    assert.equal(result.unverifiable.find((item) => item.type === 'tool').reason, 'tool_result_not_retained')
  })
  assert.equal(sourceTypeFromRef('mail:<a>'), 'mail')
  assert.equal(sourceTypeFromRef('imap:acct:1:42'), 'mail')
  assert.equal(sourceTypeFromRef('kb:doc#0'), 'kb_chunk')
  assert.equal(sourceTypeFromRef('kb_page:page_1'), 'kb_page')
  assert.equal(sourceTypeFromRef('https://example.com'), 'web')
  assert.equal(sourceTypeFromRef('tool:t#x'), 'tool')
  assert.equal(sourceTypeFromRef('session#turn'), '')
})

// ---------------------------------------------------------------------------
// source v2 priority + manual ordering
// ---------------------------------------------------------------------------

test('source v2 wins over a broken legacy pointer', () => {
  usingFixture({}, (f) => {
    const commitment = commitmentWith(f, [
      {
        quote: GOOD_QUOTE,
        sessionId: 'wrong-conv',
        turnId: 'missing-turn',
        source: { sourceVersion: 2, type: 'conversation', ref: 'conv-1#' + f.turn.id, quote: GOOD_QUOTE },
      },
    ])
    const result = evidenceForCommitment(f.store, f.ledger, commitment.id)
    assert.deepEqual(result.missing, [])
    assert.equal(result.sources.length, 1)
    assert.equal(result.sources[0].sessionId, 'conv-1')
    assert.equal(result.sources[0].turnId, f.turn.id)
    assert.equal(result.sources[0].type, 'conversation')
  })
})

test('manual evidence is always unverifiable and never a verified source', () => {
  usingFixture({}, (f) => {
    const commitment = commitmentWith(f, [{ kind: 'manual', quote: GOOD_QUOTE, capturedAt: '2026-11-21T03:00:00.000Z', command: 'commit add' }])
    const result = evidenceForCommitment(f.store, f.ledger, commitment.id)
    assert.deepEqual(result.sources, [])
    assert.deepEqual(result.missing, [])
    assert.equal(result.unverifiable.length, 1)
    assert.equal(result.unverifiable[0].kind, 'manual')
    assert.equal(result.unverifiable[0].type, 'manual')
    assert.equal(result.unverifiable[0].reason, 'operator_entered')
    assert.equal(result.byKind.manual, 1)
  })
})

// ---------------------------------------------------------------------------
// resolver contract + summary consistency
// ---------------------------------------------------------------------------

test('resolveEvidenceSource returns one of the four documented states', () => {
  usingFixture({ typedStore: mailStore([{ message_id: '<m1>', body_text: 'abc' }]) }, (f) => {
    const states = [
      resolveEvidenceSource(f.store, { sessionId: 'conv-1', turnId: f.turn.id, quote: GOOD_QUOTE }),
      resolveEvidenceSource(f.store, { sessionId: 'conv-1', turnId: 'nope', quote: 'x' }),
      resolveEvidenceSource(f.store, { type: 'mail', messageId: '<missing>' }),
      resolveEvidenceSource(f.store, { type: 'kb_chunk', docId: 'doc_1' }),
      resolveEvidenceSource(f.store, { kind: 'manual', quote: 'q' }),
    ]
    for (const state of states) assert.ok(EVIDENCE_RESOLUTIONS.includes(state.resolution), JSON.stringify(state))
    assert.deepEqual(states.map((state) => state.resolution), ['verified', 'missing', 'unverifiable', 'not_checked', 'unverifiable'])
    assert.equal(states[0].entry.sessionId, 'conv-1')
    assert.equal(states[1].item.reason, 'turn_not_found')
    assert.equal(resolveEvidenceSource(f.store, null).resolution, 'missing')
    assert.equal(resolveEvidenceSource(f.store, 'nope').resolution, 'missing')
  })
})

test('evidenceDescriptor merges nested source v2 and recognises typed pointer fields', () => {
  const mail = evidenceDescriptor({ quote: 'q', source: { sourceVersion: 2, type: 'mail', messageId: '<m1>', subject: 'S', retained: true } })
  assert.equal(mail.type, 'mail')
  assert.equal(mail.messageId, '<m1>')
  assert.equal(mail.subject, 'S')
  assert.equal(mail.retained, true)
  assert.equal(mail.quote, 'q')
  const legacy = evidenceDescriptor({ sessionId: 'conv-1', turnId: 'turn_1', quote: 'q' })
  assert.equal(legacy.type, 'conversation')
  assert.equal(legacy.ref, 'conv-1#turn_1')
  const kb = evidenceDescriptor({ ref: 'kb:doc_1#2', quote: 'q' })
  assert.equal(kb.type, 'kb_chunk')
  const manual = evidenceDescriptor({ type: 'manual', quote: 'q' })
  assert.equal(manual.type, 'manual')
})

test('byKind / notCheckedCount are consistent with the bucket arrays', () => {
  usingFixture({ typedStore: kbStore({ chunk: null }) }, (f) => {
    const commitment = commitmentWith(f, [
      { sessionId: 'conv-1', turnId: f.turn.id, quote: GOOD_QUOTE },
      { quote: 'manual bit', kind: 'manual' },
      { quote: 'q', type: 'kb_chunk', docId: 'missing_doc' },
    ])
    const result = evidenceForCommitment(f.store, f.ledger, commitment.id)
    assert.equal(result.notCheckedCount, result.notChecked.length)
    const expected = result.sources.length + result.missing.length + result.unverifiable.length + result.notChecked.length
    const tallied = Object.values(result.byKind).reduce((sum, value) => sum + value, 0)
    assert.equal(tallied, expected)
    for (const kind of Object.keys(result.byKind)) assert.ok(EVIDENCE_KINDS.includes(kind))
    // same inputs must produce the same bytes
    assert.deepEqual(evidenceForCommitment(f.store, f.ledger, commitment.id), result)
  })
})

test('the lookups seam wires the mail/KB data lines without touching the store', () => {
  usingFixture({}, (f) => {
    const row = { messageId: '<m9@example.com>', subject: '合同', bodyText: '合同请周五前确认。', retained: true }
    const commitment = commitmentWith(f, [
      { quote: '合同请周五前确认', type: 'mail', ref: 'eml:acct:msg_1', messageId: '<m9@example.com>' },
    ])
    const without = evidenceForCommitment(f.store, f.ledger, commitment.id)
    assert.deepEqual(without.missing, [])
    assert.equal(without.unverifiable.length, 1, 'without a lookup the mail source is unverifiable')

    const selectorCalls = []
    const withLookup = evidenceForCommitment(f.store, f.ledger, commitment.id, undefined, {
      lookup: {
        mail: (selector) => {
          selectorCalls.push(selector)
          return row.messageId === selector.messageId ? row : null
        },
      },
    })
    assert.deepEqual(withLookup.missing, [])
    assert.equal(withLookup.sources.length, 1)
    assert.equal(withLookup.sources[0].type, 'mail')
    assert.equal(withLookup.sources[0].messageId, '<m9@example.com>')
    assert.equal(withLookup.sources[0].sourceDigest, sha256Hex('合同请周五前确认。'))
    assert.equal(selectorCalls.length, 1)
    assert.equal(selectorCalls[0].messageId, '<m9@example.com>')
    assert.equal(selectorCalls[0].ref, 'eml:acct:msg_1')

    // The same seam works through buildEvidencePack({lookups}).
    const pack = buildEvidencePack({
      store: f.store,
      ledger: f.ledger,
      ids: [commitment.id],
      lookups: { mail: () => row },
    })
    assert.equal(pack.summary.sourceCount, 1)
    assert.equal(pack.summary.unverifiableCount, 0)
    assert.equal(sourceTypeFromRef('eml:acct:msg_1'), 'mail')
  })
})
