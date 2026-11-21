import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { extractLocalCandidates, extractMailAmount, matchMailHints, parseFromAddress } from '../lib/mail-extract.js'
import { mailExtract, mailImport, mailList, mailShow, mailSync } from '../lib/mail.js'
import { addTestAccount, makeEml, openMailStore, startMockImap } from './mail-fixture.js'

const localDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(iso))
const MESSAGE_DATE = 'Thu, 12 Nov 2026 09:00:00 +0800'

function importOne(space, { body, subject = '报价', messageId = '<extract@example.com>', from = '王工 <wang@acme.cn>' } = {}) {
  const file = join(space.root, 'one.eml')
  writeFileSync(file, makeEml({ from, subject, messageId, date: MESSAGE_DATE, body }))
  return mailImport(space.store, { path: file, now: new Date('2026-11-20T02:00:00.000Z') })
}

test('local extraction: Chinese promise becomes a verbatim candidate with a rule-resolved due date', () => {
  const text = '王工：周五前把报价发给我。'
  const { candidates } = extractLocalCandidates({
    text: '王工：周五前把报价发给我。\n我：好的，我周五前把报价发给你。',
    subject: '报价', from: '王工 <wang@acme.cn>', receivedAt: new Date(MESSAGE_DATE).toISOString(),
  })
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.debtor, 'user')
  assert.equal(candidate.creditor, '王工')
  assert.equal(candidate.quote, '我：好的，我周五前把报价发给你')
  assert.match(candidate.action, /发/)
  assert.equal(localDate(candidate.dueAt), '2026-11-13')
  assert.equal(candidate.dueBasis, 'rule')
  assert.equal(candidate.extractor, 'local')
  assert.equal(candidate.modal, 'firm')
  assert.ok(candidate.confidence > 0.5)
})

test('local extraction: amounts, currencies and project/client hints are attached to the candidate', () => {
  const { candidates } = extractLocalCandidates({
    text: '我周五前支付 3.5 万元货款。',
    subject: '官网改版 报价', from: 'ACME 王工 <wang@acme.cn>',
    receivedAt: new Date(MESSAGE_DATE).toISOString(),
    clients: [{ id: 'cl_1', name: 'ACME', aliases: ['埃斯'] }],
    projects: [{ id: 'pr_1', name: '官网改版', clientId: 'cl_1' }],
  })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].amountMinor, 3_500_000)
  assert.equal(candidates[0].currency, 'CNY')
  assert.equal(candidates[0].clientHint.id, 'cl_1')
  assert.equal(candidates[0].clientHint.basis, 'address-domain')
  assert.equal(candidates[0].projectHint.id, 'pr_1')
})

test('local extraction: requests, reschedules and vague politeness are not promises', () => {
  const cases = [
    '请周五前把报价发给我。',
    '麻烦确认一下明天的会议。',
    '周五的会改到下午三点。',
    '我回头把报价发你。',
    '您看这样可以吗？',
  ]
  for (const text of cases) {
    const { candidates } = extractLocalCandidates({ text, receivedAt: new Date(MESSAGE_DATE).toISOString() })
    assert.equal(candidates.length, 0, 'unexpected candidate for: ' + text)
  }
})

test('local extraction: English promise is quoted verbatim; unknown dates stay absent instead of invented', () => {
  const text = "I will send the quote by Friday. Could you confirm the scope?"
  const { candidates } = extractLocalCandidates({ text, receivedAt: new Date(MESSAGE_DATE).toISOString() })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].debtor, 'user')
  assert.match(candidates[0].quote, /I will send the quote by Friday/)
  assert.match(candidates[0].action, /send/)
})

test('local extraction: at most 5 candidates per message and quotes are verbatim substrings', () => {
  const lines = []
  for (let index = 0; index < 8; index += 1) lines.push('我下周一前提交第' + index + '份材料')
  const text = lines.join('。') + '。'
  const { candidates } = extractLocalCandidates({ text, receivedAt: new Date(MESSAGE_DATE).toISOString() })
  assert.equal(candidates.length, 5)
  const compact = text.replace(/\s+/g, '')
  for (const candidate of candidates) {
    assert.ok(compact.includes(candidate.quote.replace(/\s+/g, '')), 'quote must be verbatim: ' + candidate.quote)
  }
})

test('amount parser handles CNY symbols/units and USD without float drift', () => {
  assert.deepEqual(extractMailAmount('报价 ¥1,200.50'), { amountMinor: 120050, currency: 'CNY' })
  assert.deepEqual(extractMailAmount('合同金额 3.5 万元'), { amountMinor: 3_500_000, currency: 'CNY' })
  assert.deepEqual(extractMailAmount('定金 5000元'), { amountMinor: 500000, currency: 'CNY' })
  assert.deepEqual(extractMailAmount('invoice USD 99.5'), { amountMinor: 9950, currency: 'USD' })
  assert.deepEqual(extractMailAmount('total $1,000'), { amountMinor: 100000, currency: 'USD' })
  assert.equal(extractMailAmount('没有金额'), null)
  assert.equal(parseFromAddress('"王工" <wang@acme.cn>').domain, 'acme.cn')
  assert.equal(matchMailHints({ from: 'x@acme.cn' }, { clients: [{ id: 'cl_1', name: 'ACME' }] }).clientHint.id, 'cl_1')
})

test('mail extract (local): persists pending memory_candidates, keeps the ledger untouched and marks the message extracted', async () => {
  const space = openMailStore()
  try {
    await importOne(space, { body: '我周五前把报价发给你。报价没问题。' })
    const before = {
      commitments: Number(space.store.db.prepare('SELECT COUNT(*) AS n FROM commitments').get().n),
      facts: Number(space.store.db.prepare('SELECT COUNT(*) AS n FROM facts').get().n),
    }
    const result = await mailExtract(space.store, { now: new Date('2026-11-20T02:00:00.000Z') })
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'local')
    assert.equal(result.scanned, 1)
    assert.equal(result.candidates.length, 1)
    const row = space.store.getCandidate(result.candidates[0].id)
    assert.equal(row.kind, 'commitment')
    assert.equal(row.status, 'pending')
    assert.equal(row.payload.debtor, 'user')
    assert.equal(row.payload.action.length > 0, true)
    assert.equal(localDate(row.payload.dueAt), '2026-11-13')
    assert.equal(row.evidence.length, 1)
    assert.equal(row.evidence[0].source.type, 'mail')
    assert.match(row.evidence[0].source.ref, /^eml:acct_local_eml:/)
    assert.match(row.evidence[0].quote, /我周五前把报价发给你/)
    assert.equal(Number(space.store.db.prepare('SELECT COUNT(*) AS n FROM commitments').get().n), before.commitments, 'extract never writes the ledger')
    assert.equal(Number(space.store.db.prepare('SELECT COUNT(*) AS n FROM facts').get().n), before.facts)
    const message = mailList(space.store, {}).messages[0]
    assert.equal(message.status, 'extracted')
    assert.deepEqual(message.candidateIds, [result.candidates[0].id])
    // A second default run has nothing new to scan (no re-extraction churn).
    const second = await mailExtract(space.store, { now: new Date('2026-11-20T02:00:00.000Z') })
    assert.equal(second.scanned, 0)
    assert.equal(second.candidates.length, 0)
  } finally { space.cleanup() }
})

test('mail extract (local): IMAP-synced rows use an imap:<account>:<uidvalidity>:<uid> evidence ref', async () => {
  const mock = await startMockImap({ messages: [makeEml({ messageId: '<imap-ref@example.com>', body: '我周五前发报价。' })] })
  const space = openMailStore()
  try {
    const account = addTestAccount(space.store, space.home, { port: mock.port })
    await mailSync(space.store, account.id, { home: space.home, connect: mock.connect, now: new Date('2026-11-20T02:00:00.000Z') })
    const result = await mailExtract(space.store, { now: new Date('2026-11-20T02:00:00.000Z') })
    assert.equal(result.candidates.length, 1)
    const row = space.store.getCandidate(result.candidates[0].id)
    assert.match(row.evidence[0].source.ref, new RegExp('^imap:' + account.id + ':100:1$'))
    assert.equal(row.evidence[0].source.messageId, 'imap-ref@example.com')
  } finally {
    await mock.close()
    space.cleanup()
  }
})

test('mail extract: dry-run returns previews and writes nothing', async () => {
  const space = openMailStore()
  try {
    await importOne(space, { body: '我周五前发报价。' })
    const dry = await mailExtract(space.store, { dryRun: true, now: new Date('2026-11-20T02:00:00.000Z') })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.candidates.length, 1)
    assert.equal(dry.candidates[0].preview, true)
    assert.equal(dry.candidates[0].kind, 'commitment')
    assert.equal(space.store.listCandidates('all').length, 0)
    assert.equal(mailList(space.store, {}).messages[0].status, 'new')
  } finally { space.cleanup() }
})

test('mail extract (local) makes zero network calls', async () => {
  const space = openMailStore()
  const originalFetch = globalThis.fetch
  const originalModelEnv = process.env.ADVISERS_API_KEY
  try {
    process.env.ADVISERS_API_KEY = 'must-not-be-used'
    globalThis.fetch = () => { throw new Error('network was used by local extraction') }
    await importOne(space, { body: '我周五前把报价发给你。' })
    const result = await mailExtract(space.store, { now: new Date('2026-11-20T02:00:00.000Z') })
    assert.equal(result.candidates.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    if (originalModelEnv === undefined) delete process.env.ADVISERS_API_KEY
    else process.env.ADVISERS_API_KEY = originalModelEnv
    space.cleanup()
  }
})

test('mail extract: model mode is opt-in and refuses without confirmation/key or on protected matters', async () => {
  const space = openMailStore()
  let fetchCalls = 0
  const fetchImpl = async () => { fetchCalls += 1; throw new Error('should not be called') }
  try {
    await importOne(space, { body: '我周五前发报价。' })
    const base = { fetchImpl, apiKey: 'test-key', now: new Date('2026-11-20T02:00:00.000Z') }
    await assert.rejects(mailExtract(space.store, { ...base, model: true }), (error) => error.code === 'E_MAIL_MODEL_DISABLED')
    await assert.rejects(mailExtract(space.store, { ...base, model: true, confirmModel: true, apiKey: undefined }), (error) => error.code === 'E_MAIL_MODEL_DISABLED')
    await assert.rejects(mailExtract(space.store, { ...base, model: true, confirmModel: true, secrecy: 1 }), (error) => error.code === 'E_MAIL_MODEL_DISABLED')
    assert.equal(fetchCalls, 0)
    assert.equal(space.store.listCandidates('all').length, 0)
    assert.equal(mailList(space.store, {}).messages[0].status, 'new')
  } finally { space.cleanup() }
})

test('mail extract --model: wraps the body as untrusted data, clips it to 8KiB and stores pending candidates', async () => {
  const space = openMailStore()
  const requests = []
  const body = 'A'.repeat(100) + '我周五前发报价。' + 'B'.repeat(9000) + 'ENDMARKER'
  try {
    await importOne(space, { body })
    globalThis.fetch = async (url, init) => {
      requests.push(JSON.parse(init.body))
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ candidates: [{ action: '发报价', debtor: 'user', creditor: '王工', quote: '我周五前发报价', modal: 'firm', confidence: 0.9 }] }) } }],
        usage: { total_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const result = await mailExtract(space.store, {
      model: true, confirmModel: true, apiKey: 'test-key',
      now: new Date('2026-11-20T02:00:00.000Z'),
    })
    assert.equal(result.mode, 'model')
    assert.equal(result.candidates.length, 1)
    assert.equal(requests.length, 1)
    const prompt = requests[0].messages.map((message) => message.content).join('\n')
    assert.match(prompt, /<untrusted-data source="mail:message" trust="untrusted">/)
    assert.equal(prompt.includes('ENDMARKER'), false, 'the model input must be clipped to 8KiB')
    assert.ok(prompt.length < 12_000, 'model input is bounded: ' + prompt.length)
    const row = space.store.getCandidate(result.candidates[0].id)
    assert.equal(row.payload.extractor, 'model')
    assert.equal(row.status, 'pending')
    assert.equal(mailList(space.store, {}).messages[0].status, 'extracted')
  } finally {
    delete globalThis.fetch
    space.cleanup()
  }
})

test('mail show --body returns the retained body and its body hash', async () => {
  const space = openMailStore()
  try {
    await importOne(space, { body: '我周五前发报价。' })
    const message = mailList(space.store, {}).messages[0]
    const before = mailShow(space.store, message.id, { body: true }).message
    assert.match(before.bodyText, /我周五前发报价/)
    assert.match(before.bodySha256, /^[0-9a-f]{64}$/)
  } finally { space.cleanup() }
})
