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

test('association links and cross-matter updates stay proposals', () => {
  const ledger = new Ledger()
  const a = ledger.addMatter({ title: '客户 A' })
  const b = ledger.addMatter({ title: '项目 B' })

  const link = ledger.proposeLink({
    fromMatter: a.id,
    toMatter: b.id,
    type: 'impact',
    confidence: 0.7,
    evidence: ['A 的签约在周五'],
  })
  assert.equal(link.status, 'candidate')
  assert.equal(ledger.listLinks(a.id, false).length, 0)
  ledger.confirmLink(link.id)
  assert.equal(ledger.listLinks(a.id, false).length, 1)

  const update = ledger.proposeUpdate({
    sourceMatter: a.id,
    targetMatter: b.id,
    change: 'B 的联调提前 3 天',
  })
  assert.equal(update.status, 'pending')
  ledger.resolveUpdate(update.id, 'applied', 'revert: revert B 的联调')
  assert.equal(ledger.listUpdates('applied').length, 1)
})

test('audience-scoped preference only appears for that audience', () => {
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '客户 A' })
  ledger.addPreference({
    kind: 'relationship',
    statement: '对客户说话先给结论',
    scope: { level: 'audience', value: 'client' },
  })
  const forClient = buildFocusFrame({
    matter,
    commitments: [],
    preferences: ledger.listPreferences({ matterId: matter.id, audience: 'client' }),
    audience: 'client',
  })
  const forFriend = buildFocusFrame({
    matter,
    commitments: [],
    preferences: ledger.listPreferences({ matterId: matter.id, audience: 'friend' }),
    audience: 'friend',
  })
  assert.ok(forClient.preferences.some((p) => p.statement.includes('先给结论')))
  assert.ok(!forFriend.preferences.some((p) => p.statement.includes('先给结论')))
})

test('soul is slot #1 before the context block', async () => {
  const soul = {
    id: 'soul_1',
    version: 1,
    content: 'You are my adviser. Be direct.',
    updatedAt: '2026-11-10T00:00:00.000Z',
    updatedBy: 'human' as const,
  }
  const runtime = new AdvisersRuntime({
    ports: {
      clock: { now: () => '2026-11-10T00:00:00.000Z' },
      ids: { next: (prefix) => `${prefix}_x` },
      soul: { load: () => soul, save: () => {} },
    },
  })
  const ctx = await runtime.handleInbound({
    linkId: 'cli',
    accountId: 'me',
    conversationId: 'c1',
    messageId: 'm1',
    sender: { id: 'me' },
    text: '你好',
    timestamp: '2026-11-10T00:00:00.000Z',
  })
  assert.ok(ctx.prompt.indexOf('<soul') >= 0)
  assert.ok(ctx.prompt.indexOf('<soul') < ctx.prompt.indexOf('<advisers-context>'))
  assert.match(ctx.prompt, /Be direct/)
})
