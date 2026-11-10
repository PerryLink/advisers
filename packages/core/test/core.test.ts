import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AdvisersRuntime,
  Ledger,
  assembleContext,
  buildFocusFrame,
  estimateTokens,
} from '../src/index.ts'

test('focus frame carries global + active matter preferences, never another matter', () => {
  const ledger = new Ledger()
  const a = ledger.addMatter({ title: '客户 A', summary: 'A 的报价' })
  const b = ledger.addMatter({ title: '客户 B', summary: 'SECRET B' })
  ledger.addPreference({ kind: 'taboo', statement: '不要 force push' })
  ledger.addPreference({
    kind: 'preference',
    statement: '给 A 的邮件先结论',
    scope: { level: 'matter', value: a.id },
  })
  ledger.addPreference({
    kind: 'preference',
    statement: '给 B 的邮件用英文',
    scope: { level: 'matter', value: b.id },
  })

  const frame = buildFocusFrame({
    matter: a,
    commitments: [],
    preferences: ledger.listPreferences({ matterId: a.id }),
  })
  const statements = frame.preferences.map((p) => p.statement)
  assert.ok(statements.includes('不要 force push'))
  assert.ok(statements.includes('给 A 的邮件先结论'))
  assert.ok(!statements.includes('给 B 的邮件用英文'))
})

test('facts dedupe on subject + predicate + object', () => {
  const ledger = new Ledger()
  const first = ledger.remember({ subject: 'user', predicate: 'timezone', object: 'Asia/Shanghai' })
  const second = ledger.remember({ subject: 'user', predicate: 'timezone', object: 'Asia/Shanghai' })
  assert.equal(first.id, second.id)
  assert.equal(ledger.listFacts().length, 1)
})

test('commitments require evidence, and done requires external evidence', () => {
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: 'demo' })
  assert.throws(() => ledger.addCommitment({
    matterId: matter.id,
    debtor: 'agent',
    creditor: 'user',
    action: 'send the PDF',
    evidence: [],
  }))

  const commitment = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'agent',
    creditor: 'user',
    action: 'send the PDF',
    evidence: [{ sessionId: 's1', turnId: 't1', quote: '周五前发你' }],
  })
  assert.throws(() => ledger.completeCommitment(commitment.id, []))
  ledger.completeCommitment(commitment.id, [{ sessionId: 's1', turnId: 't9', quote: '已发送' }])
  assert.equal(commitment.status, 'done')
})

test('context carries the active matter, never another matter body', () => {
  const ledger = new Ledger()
  const a = ledger.addMatter({ title: '客户 A', summary: 'A 的报价' })
  const b = ledger.addMatter({ title: '客户 B', summary: 'SECRET B' })
  ledger.addPreference({ kind: 'preference', statement: '邮件先结论' })
  const ctx = assembleContext({
    matter: a,
    ledger,
    related: [{ matterId: b.id, title: '客户 B 的排期', why: '可能影响 A 的交付' }],
  })
  assert.match(ctx.prompt, /<advisers-context>/)
  assert.match(ctx.prompt, /A 的报价/)
  assert.doesNotMatch(ctx.prompt, /SECRET B/)
  assert.equal(ctx.hints.length, 1)
  assert.equal(ctx.hints[0]?.matterId, b.id)
})

test('runtime creates a matter per conversation and returns a focus context', async () => {
  const runtime = new AdvisersRuntime()
  const ctx = await runtime.handleInbound({
    linkId: 'email',
    accountId: 'me',
    conversationId: 'thread-1',
    messageId: 'm1',
    sender: { id: 'me' },
    text: '周五前把报价发给王工',
    timestamp: new Date().toISOString(),
  })
  assert.ok(ctx.matter.id)
  assert.match(ctx.prompt, /周五前把报价发给王工/)
  assert.ok(estimateTokens(ctx.prompt) > 0)
})

test('ingest is idempotent by dedupeKey', async () => {
  const runtime = new AdvisersRuntime()
  const event = {
    linkId: 'email',
    accountId: 'me',
    conversationId: 'thread-2',
    messageId: 'm2',
    dedupeKey: 'mail-2',
    sender: { id: 'me' },
    text: '同一封邮件重投两次',
    timestamp: new Date().toISOString(),
  }
  await runtime.ingest(event)
  await runtime.ingest(event)
  assert.equal(runtime.ledger.listFacts().length, 1)
  assert.equal(runtime.ledger.listMatters().length, 1)
})
