/**
 * Tests for lib/capture-rules.js (0.4.3 043-2: local capture rules + inbox
 * read projection).
 *
 * Every test uses a mktemp ADVISERS_HOME-style directory; the real ~/.advisers
 * is never touched. The rules tests are pure functions (no store); the inbox
 * tests open a throwaway SqliteStore and seed memory_candidates rows directly
 * so ordering/paging/clearance are deterministic. No network, no model call.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SqliteStore } from '../lib/sqlite.js'
import { validateSource } from '../lib/source.js'
import {
  CAPTURE_RULES_MAX_CHARS,
  INBOX_LIST_LIMIT,
  INBOX_LIST_LIMIT_MAX,
  captureTextRef,
  inboxList,
  inboxShow,
  localCaptureCandidates,
  normalizeCaptureText,
  toCaptureMemoryCandidate,
} from '../lib/capture-rules.js'

const ANCHOR = new Date('2026-11-22T10:00:00+08:00') // Sunday, Asia/Shanghai
const AT = '2026-11-22T10:00:00+08:00'

const localDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(iso))
const excerpt = (text) => String(text).replace(/\s+/gu, '')

function extract(text, options = {}) {
  return localCaptureCandidates({ text, now: ANCHOR, ...options })
}

/* -------------------------------------------------------------------------- */
/* local capture rules                                                        */
/* -------------------------------------------------------------------------- */

test('Chinese promise: verbatim quote, rule due date, local extractor and conversation source', () => {
  const text = '我下周一前把报价发给你。'
  const result = extract(text)
  assert.equal(result.ok, true)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.channel, 'wechat')
  const candidate = result.candidates[0]
  assert.equal(candidate.debtor, 'user')
  assert.match(candidate.action, /发/)
  assert.equal(candidate.modal, 'firm')
  assert.equal(candidate.extractor, 'local')
  assert.ok(excerpt(text).includes(excerpt(candidate.quote)))
  assert.equal(localDate(candidate.dueAt), '2026-11-23')
  assert.equal(candidate.dueBasis, 'rule')
  assert.equal(candidate.source.type, 'conversation')
  assert.equal(candidate.source.ref, captureTextRef(text))
  assert.match(candidate.source.ref, /^capture:[0-9a-f]{16}$/)
  assert.equal(candidate.channel, 'wechat')
  const expectedHash = createHash('sha256').update(text).digest('hex').slice(0, 16)
  assert.equal(candidate.source.ref, 'capture:' + expectedHash)
  assert.equal(validateSource(candidate.source).ok, true)
})

test('English promise is extracted; explicit dates resolve, "by Friday" stays undated', () => {
  const undated = extract('I will send the quote by Friday.')
  assert.equal(undated.ok, true)
  assert.equal(undated.candidates.length, 1)
  assert.equal(undated.candidates[0].debtor, 'user')
  assert.match(undated.candidates[0].action, /send/i)
  // 0.4.3 local rules do not parse English relative dates yet: no invented dueAt.
  assert.equal(undated.candidates[0].dueAt, undefined)
  assert.equal(undated.candidates[0].dueBasis, undefined)

  const dated = extract('I will send the quote by 2026-11-27.')
  assert.equal(dated.candidates.length, 1)
  assert.equal(localDate(dated.candidates[0].dueAt), '2026-11-27')
  assert.equal(dated.candidates[0].dueBasis, 'rule')
})

test('requests, greetings and neutral notes produce no candidate', () => {
  const cases = [
    '请周五前把报价发给我。',
    '麻烦确认一下明天的会议。',
    '会议纪要：讨论了报价和交付排期。',
    '谢谢！',
    '王工说报价没问题。',
  ]
  for (const text of cases) {
    const result = extract(text)
    assert.equal(result.ok, true, text)
    assert.deepEqual(result.candidates, [], 'unexpected candidate for: ' + text)
  }
})

test('relative dates resolve against the capture date (Asia/Shanghai)', () => {
  const morning = extract('我明天上午10点前提交报告。')
  assert.equal(morning.candidates.length, 1)
  assert.equal(morning.candidates[0].dueAt, '2026-11-23T02:00:00.000Z')

  const monthEnd = extract('我月底前完成这一版报价。')
  assert.equal(monthEnd.candidates.length, 1)
  assert.equal(localDate(monthEnd.candidates[0].dueAt), '2026-11-30')

  // Same-day weekday is flagged ambiguous by the shared resolver (not dropped).
  const ambiguous = extract('我周五前交付报告。', { date: '2026-11-27T10:00:00+08:00' })
  assert.equal(ambiguous.candidates.length, 1)
  assert.equal(localDate(ambiguous.candidates[0].dueAt), '2026-11-27')
  assert.equal(ambiguous.candidates[0].dueAmbiguous, true)

  const explicit = extract('我下周一前交付。', { date: '2026-12-01T10:00:00+08:00' })
  assert.equal(explicit.candidates.length, 1)
  assert.equal(localDate(explicit.candidates[0].dueAt), '2026-12-07')
})

test('negated commitments never become candidates', () => {
  const cases = [
    '我不会在周五前交付报告。',
    '我没有承诺周五前交付。',
    '我周五前发不了报价。',
    '无需周五前提交。',
    '我不会发报价，你放心。',
    'I will not send the quote by Friday.',
    'I cannot deliver the report by Friday.',
  ]
  for (const text of cases) {
    const result = extract(text)
    assert.equal(result.ok, true, text)
    assert.deepEqual(result.candidates, [], 'negation leaked a candidate: ' + text)
  }
})

test('a negated aside does not remove a real promise', () => {
  for (const text of ['报价不错，我周五前交付。', '别担心，我周五前发报价。', '我不会太久，周五前发报价。']) {
    const result = extract(text)
    assert.equal(result.ok, true, text)
    assert.equal(result.candidates.length, 1, 'missing candidate for: ' + text)
  }
})

test('input is BOM/CRLF normalised and the source ref hashes the normalised text', () => {
  const raw = '\uFEFF我下周一前把报价发给你。\r\n谢谢'
  const normalised = '我下周一前把报价发给你。\n谢谢'
  const result = extract(raw)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].quote.includes('\r'), false)
  assert.equal(result.textRef, captureTextRef(normalised))
  assert.equal(result.candidates[0].source.ref, captureTextRef(normalised))
})

test('empty and over-long input fail closed with registered 0.4.3 codes', () => {
  for (const text of ['', '   ', '\n\t', '\uFEFF']) {
    const empty = extract(text)
    assert.equal(empty.ok, false)
    assert.equal(empty.code, 'E_CAPTURE_EMPTY')
    assert.deepEqual(empty.candidates, [])
  }
  assert.deepEqual(extract(null), { ok: false, code: 'E_CAPTURE_EMPTY', message: 'capture input is empty', text: '', length: 0, candidates: [] })

  const tooLong = extract('我'.repeat(CAPTURE_RULES_MAX_CHARS + 1))
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.code, 'E_CAPTURE_TOO_LONG')
  assert.equal(tooLong.length, CAPTURE_RULES_MAX_CHARS + 1)
  assert.deepEqual(tooLong.candidates, [])

  const boundary = extract('a'.repeat(CAPTURE_RULES_MAX_CHARS))
  assert.equal(boundary.ok, true)
  assert.deepEqual(boundary.candidates, [])
})

test('normalizeCaptureText reports the normalised text and length', () => {
  assert.deepEqual(normalizeCaptureText('\uFEFF 我周五前发报价。\r\n'), { ok: true, text: '我周五前发报价。', length: 8 })
  const empty = normalizeCaptureText('  ')
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'E_CAPTURE_EMPTY')
})

test('toCaptureMemoryCandidate builds the pending commitment record shape', () => {
  const result = extract('ACME 官网改版我下周一前把 3.5 万元报价发给你。', {
    matterId: 'matter_1',
    source: 'note',
    clients: [{ id: 'cl_1', name: 'ACME', aliases: ['埃斯'] }],
    projects: [{ id: 'pr_1', name: '官网改版', clientId: 'cl_1' }],
  })
  assert.equal(result.candidates.length, 1)
  const record = toCaptureMemoryCandidate(result.candidates[0], {
    text: 'ACME 官网改版我下周一前把 3.5 万元报价发给你。',
    turnId: 'turn_1',
    conversationId: 'conv_1',
  })
  assert.equal(record.kind, 'commitment')
  assert.equal(record.payload.matterId, 'matter_1')
  assert.equal(record.payload.debtor, 'user')
  assert.equal(record.payload.creditor, 'someone')
  assert.ok(record.payload.action.length > 0)
  assert.equal(record.payload.capability, 'none')
  assert.equal(record.payload.extractor, 'local')
  assert.equal(record.payload.modal, 'firm')
  assert.equal(record.payload.dueBasis, 'rule')
  assert.equal(record.payload.amountMinor, 3_500_000)
  assert.equal(record.payload.currency, 'CNY')
  assert.equal(record.payload.clientHint.id, 'cl_1')
  assert.equal(record.payload.projectHint.id, 'pr_1')
  assert.equal(record.evidence.length, 1)
  assert.equal(record.evidence[0].turnId, 'turn_1')
  assert.equal(record.evidence[0].sessionId, 'conv_1')
  assert.equal(record.evidence[0].source.type, 'conversation')
  assert.equal(record.evidence[0].source.quote, record.evidence[0].quote)
  assert.equal(validateSource(record.evidence[0].source).ok, true)
  const fallback = toCaptureMemoryCandidate({ action: '发', quote: '我周五前发报价' }, { text: '我周五前发报价', now: ANCHOR })
  assert.equal(fallback.evidence[0].source.ref, captureTextRef('我周五前发报价'))
  assert.equal(fallback.evidence[0].source.capturedAt, ANCHOR.toISOString())
  assert.equal(toCaptureMemoryCandidate({}), undefined)
  assert.equal(toCaptureMemoryCandidate({ action: '发', quote: '   ' }), undefined)
})

test('local capture never touches the network or a model key', () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.ADVISERS_API_KEY
  try {
    process.env.ADVISERS_API_KEY = 'must-not-be-used'
    globalThis.fetch = () => { throw new Error('local capture used the network') }
    const result = extract('我周五前把报价发给你。')
    assert.equal(result.candidates.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.ADVISERS_API_KEY
    else process.env.ADVISERS_API_KEY = originalKey
  }
})

/* -------------------------------------------------------------------------- */
/* inbox read projection                                                      */
/* -------------------------------------------------------------------------- */

function openStore() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-capture-rules-'))
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

function seedMatter(store, { id, secrecy = 0 }) {
  store.mutate(() => store.insertMatter({
    id,
    title: id,
    status: 'active',
    domain: 'work',
    secrecy,
    participants: [],
    deadlines: [],
    openQuestions: [],
    createdAt: AT,
    updatedAt: AT,
  }))
}

const CONVERSATION_SOURCE = (quote) => ({ type: 'conversation', ref: 'capture:0123456789abcdef', quote, capturedAt: '2026-11-22T01:00:00.000Z' })
const MAIL_SOURCE = (quote) => ({ type: 'mail', ref: 'eml:acct_1:msg_1', quote, capturedAt: '2026-11-22T01:00:00.000Z' })

function capturePayload({ matterId, action = '发报价', quote = '我周五前发报价', extra = {} } = {}) {
  return {
    ...(matterId ? { matterId } : {}),
    debtor: 'user',
    creditor: 'someone',
    action,
    dueAt: '2026-11-27T10:00:00.000Z',
    dueBasis: 'rule',
    capability: 'none',
    extractor: 'local',
    modal: 'firm',
    clientHint: { id: 'cl_1', name: 'ACME', basis: 'message', confidence: 0.6 },
    projectHint: { id: 'pr_1', name: '官网改版', basis: 'message', confidence: 0.6 },
    ...extra,
  }
}

function seedCandidate(store, {
  id, payload, evidence, status = 'pending', createdAt = '2026-11-22T01:00:00.000Z', reviewedAt = null, rejectReason = null,
}) {
  store.db.prepare(
    'INSERT INTO memory_candidates(id,kind,payload,evidence,status,created_at,reviewed_at,reject_reason) VALUES(?,?,?,?,?,?,?,?)',
  ).run(id, 'commitment', typeof payload === 'string' ? payload : JSON.stringify(payload), JSON.stringify(evidence ?? []), status, createdAt, reviewedAt, rejectReason)
}

function seedInboxFixture(store) {
  seedMatter(store, { id: 'm_open', secrecy: 0 })
  seedMatter(store, { id: 'm_secret', secrecy: 2 })
  seedCandidate(store, {
    id: 'cand_capture_1',
    payload: capturePayload({ matterId: 'm_open' }),
    evidence: [{ quote: '我周五前发报价', source: CONVERSATION_SOURCE('我周五前发报价') }],
    createdAt: '2026-11-22T01:00:00.000Z',
  })
  seedCandidate(store, {
    id: 'cand_mail_1',
    payload: capturePayload({ action: '发送季度报告', extra: { extractor: 'mail-local' } }),
    evidence: [{ quote: '我明天把季度报告发给你', source: MAIL_SOURCE('我明天把季度报告发给你') }],
    createdAt: '2026-11-22T02:00:00.000Z',
  })
  seedCandidate(store, {
    id: 'cand_secret',
    payload: capturePayload({ matterId: 'm_secret', action: '交付保密方案' }),
    evidence: [{ quote: '我周五前交付保密方案', source: CONVERSATION_SOURCE('我周五前交付保密方案') }],
    createdAt: '2026-11-22T03:00:00.000Z',
  })
  seedCandidate(store, {
    id: 'cand_missing_matter',
    payload: capturePayload({ matterId: 'm_missing', action: '交付悬空事项' }),
    evidence: [{ quote: '我周五前交付悬空事项', source: CONVERSATION_SOURCE('我周五前交付悬空事项') }],
    createdAt: '2026-11-22T04:00:00.000Z',
  })
  seedCandidate(store, {
    id: 'cand_accepted',
    payload: capturePayload({}),
    evidence: [{ quote: '我周五前发报价', source: CONVERSATION_SOURCE('我周五前发报价') }],
    status: 'accepted',
    createdAt: '2026-11-22T05:00:00.000Z',
  })
  seedCandidate(store, { id: 'cand_corrupt', payload: '{not-json', evidence: [], createdAt: '2026-11-22T06:00:00.000Z' })
  seedCandidate(store, {
    id: 'cand_tie_a',
    payload: capturePayload({ action: '发 A 版' }),
    evidence: [{ quote: '我周五前发 A 版', source: CONVERSATION_SOURCE('我周五前发 A 版') }],
    createdAt: '2026-11-22T01:30:00.000Z',
  })
  seedCandidate(store, {
    id: 'cand_tie_b',
    payload: capturePayload({ action: '发 B 版' }),
    evidence: [{ quote: '我周五前发 B 版', source: CONVERSATION_SOURCE('我周五前发 B 版') }],
    createdAt: '2026-11-22T01:30:00.000Z',
  })
}

test('inbox ls: pending only, newest first with id-desc tie-break, deterministic projection', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    assert.deepEqual(inboxList(store), {
      ok: true,
      command: 'inbox ls',
      items: [],
      total: 0,
      truncated: false,
      limit: INBOX_LIST_LIMIT,
      offset: 0,
      clearance: 3,
      source: 'all',
      protectedExcluded: 0,
      skipped: 0,
    })
    seedInboxFixture(store)
    const result = inboxList(store)
    assert.equal(result.ok, true)
    const ids = result.items.map((item) => item.id)
    assert.deepEqual(ids, ['cand_secret', 'cand_mail_1', 'cand_tie_b', 'cand_tie_a', 'cand_capture_1'])
    assert.equal(result.total, 5)
    assert.equal(result.protectedExcluded, 1, 'the missing matter fails closed above every clearance')
    assert.equal(result.skipped, 1, 'a corrupt candidate row is skipped, never shown')
    assert.equal(result.truncated, false)

    const mail = result.items[1]
    assert.equal(mail.kind, 'commitment')
    assert.equal(mail.source, 'mail')
    assert.equal(mail.extractor, 'mail-local')
    assert.equal(mail.action, '发送季度报告')
    assert.equal(mail.quote, '我明天把季度报告发给你')
    assert.equal(mail.dueAt, '2026-11-27T10:00:00.000Z')
    assert.equal(mail.dueBasis, 'rule')
    assert.equal(mail.dueAmbiguous, false)
    assert.equal(mail.matterId, null)
    assert.equal(mail.clientHint.id, 'cl_1')
    assert.equal(mail.projectHint.id, 'pr_1')
    assert.equal(mail.createdAt, '2026-11-22T02:00:00.000Z')
    assert.equal(result.items[0].source, 'capture')
    assert.equal(result.items[4].matterId, 'm_open')
  } finally { fixture.cleanup() }
})

test('inbox ls: source filter runs before counting and clearance', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    seedInboxFixture(store)
    const mailOnly = inboxList(store, { source: 'mail', clearance: 0 })
    assert.deepEqual(mailOnly.items.map((item) => item.id), ['cand_mail_1'])
    assert.equal(mailOnly.total, 1)
    assert.equal(mailOnly.source, 'mail')
    assert.equal(mailOnly.protectedExcluded, 0)

    const captureOnly = inboxList(store, { source: 'capture', clearance: 0 })
    assert.deepEqual(captureOnly.items.map((item) => item.id), ['cand_tie_b', 'cand_tie_a', 'cand_capture_1'])
    assert.equal(captureOnly.protectedExcluded, 2, 'secret matter + unresolvable matter')

    const unknown = inboxList(store, { source: 'nonsense' })
    assert.equal(unknown.source, 'all')
  } finally { fixture.cleanup() }
})

test('inbox ls: clearance filters before counting and protected rows never leak ids or quotes', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    seedInboxFixture(store)
    const visible = inboxList(store, { clearance: 3 })
    assert.equal(visible.total, 5)
    assert.equal(visible.protectedExcluded, 1)
    const hiddenStrict = inboxList(store, { clearance: 0 })
    assert.equal(hiddenStrict.clearance, 0)
    assert.equal(hiddenStrict.total, 4)
    assert.equal(hiddenStrict.protectedExcluded, 2)
    assert.equal(hiddenStrict.items.some((item) => item.id === 'cand_secret'), false)
    for (const item of hiddenStrict.items) {
      assert.equal(item.id.includes('secret'), false)
    }
    assert.deepEqual(hiddenStrict.items.map((item) => item.id), ['cand_mail_1', 'cand_tie_b', 'cand_tie_a', 'cand_capture_1'])
  } finally { fixture.cleanup() }
})

test('inbox ls: paging is applied after filtering, with limit clamped and offset honoured', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    seedInboxFixture(store)
    const first = inboxList(store, { limit: 2 })
    assert.equal(first.items.length, 2)
    assert.equal(first.total, 5)
    assert.equal(first.truncated, true)
    const second = inboxList(store, { limit: 2, offset: 2 })
    assert.deepEqual(second.items.map((item) => item.id), ['cand_tie_b', 'cand_tie_a'])
    assert.equal(second.truncated, true)
    const last = inboxList(store, { limit: 2, offset: 4 })
    assert.deepEqual(last.items.map((item) => item.id), ['cand_capture_1'])
    assert.equal(last.truncated, false)
    const beyond = inboxList(store, { limit: 2, offset: 99 })
    assert.deepEqual(beyond.items, [])
    assert.equal(beyond.truncated, false)
    assert.equal(inboxList(store, { limit: 0 }).limit, INBOX_LIST_LIMIT)
    assert.equal(inboxList(store, { limit: 10_000 }).limit, INBOX_LIST_LIMIT_MAX)
  } finally { fixture.cleanup() }
})

test('inbox ls: quotes are a safe single line capped at 120 code points', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    const longQuote = '报'.repeat(200) + ' \u001b[31mred\u007f x'
    seedCandidate(store, { id: 'cand_long', payload: capturePayload({ action: '发长报价' }), evidence: [{ quote: longQuote, source: CONVERSATION_SOURCE(longQuote) }] })
    const result = inboxList(store, { clearance: 0 })
    const item = result.items.find((row) => row.id === 'cand_long')
    assert.ok(item)
    assert.equal(Array.from(item.quote).length, 120)
    assert.equal(/[\u0000-\u001f\u007f\u001b]/u.test(item.quote), false)
    assert.equal(item.quote.includes('\u001b'), false)
  } finally { fixture.cleanup() }
})

test('inbox ls: classification falls back to the extractor and canonicalises legacy email sources', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    seedCandidate(store, { id: 'cand_legacy_email', payload: capturePayload({}), evidence: [{ quote: 'x', source: { type: 'email', ref: 'eml:1' } }] })
    seedCandidate(store, { id: 'cand_mail_extractor', payload: capturePayload({ extra: { extractor: 'mail-model' } }), evidence: [{ quote: 'y', source: { type: 'conversation', ref: 'conv:1' } }] })
    seedCandidate(store, { id: 'cand_no_source', payload: capturePayload({}), evidence: [{ quote: 'z' }] })
    const mail = inboxList(store, { source: 'mail', clearance: 0 })
    assert.deepEqual(mail.items.map((item) => item.id).sort(), ['cand_legacy_email', 'cand_mail_extractor'])
    const capture = inboxList(store, { source: 'capture', clearance: 0 })
    assert.deepEqual(capture.items.map((item) => item.id), ['cand_no_source'])
  } finally { fixture.cleanup() }
})

test('inbox ls / inbox show are read-only', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    seedInboxFixture(store)
    const snapshot = () => JSON.stringify(store.db.prepare('SELECT * FROM memory_candidates ORDER BY id').all())
    const candidateRows = snapshot()
    const auditRows = Number(store.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n)
    inboxList(store, { clearance: 0 })
    inboxList(store, { source: 'mail', limit: 1, offset: 1 })
    inboxShow(store, 'cand_capture_1', { clearance: 3 })
    inboxShow(store, 'cand_missing', { clearance: 0 })
    assert.equal(snapshot(), candidateRows)
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n), auditRows)
  } finally { fixture.cleanup() }
})

test('inbox show: full candidate for a pending id', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    seedInboxFixture(store)
    const result = inboxShow(store, 'cand_capture_1', { clearance: 3 })
    assert.equal(result.ok, true)
    assert.equal(result.command, 'inbox show')
    assert.equal(result.clearance, 3)
    const candidate = result.candidate
    assert.equal(candidate.id, 'cand_capture_1')
    assert.equal(candidate.status, 'pending')
    assert.equal(candidate.source, 'capture')
    assert.equal(candidate.action, '发报价')
    assert.equal(candidate.quote, '我周五前发报价')
    assert.deepEqual(candidate.payload, capturePayload({ matterId: 'm_open' }))
    assert.equal(candidate.evidence[0].source.type, 'conversation')
  } finally { fixture.cleanup() }
})

test('inbox show: missing, non-pending and protected ids are discriminable and content-free', () => {
  const fixture = openStore()
  try {
    const { store } = fixture
    seedInboxFixture(store)
    assert.deepEqual(inboxShow(store, 'cand_missing'), { ok: false, code: 'E_CANDIDATE_NOT_FOUND', hint: 'advisers inbox ls' })
    assert.deepEqual(inboxShow(store, ''), { ok: false, code: 'E_CANDIDATE_NOT_FOUND', hint: 'advisers inbox ls' })
    assert.deepEqual(inboxShow(store, 'cand_accepted', { clearance: 3 }), { ok: false, code: 'E_CANDIDATE_NOT_FOUND', hint: 'advisers inbox ls' })
    assert.deepEqual(inboxShow(store, 'cand_corrupt', { clearance: 3 }), { ok: false, code: 'E_CANDIDATE_NOT_FOUND', hint: 'advisers inbox ls' })
    assert.deepEqual(inboxShow(store, 'cand_secret', { clearance: 0 }), { ok: false, code: 'E_POLICY_DENIED', hint: '提高 --clearance（0-3）' })
    assert.deepEqual(inboxShow(store, 'cand_missing_matter', { clearance: 3 }), { ok: false, code: 'E_POLICY_DENIED', hint: '提高 --clearance（0-3）' })
    const visible = inboxShow(store, 'cand_secret', { clearance: 2 })
    assert.equal(visible.ok, true)
    assert.equal(visible.candidate.id, 'cand_secret')
  } finally { fixture.cleanup() }
})

test('inbox helper requires an opened SqliteStore', () => {
  assert.throws(() => inboxList(null), TypeError)
  assert.throws(() => inboxShow({}, 'x'), TypeError)
})
