import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AdvisersRuntime,
  Ledger,
  assembleContext,
  buildFocusFrame,
  estimateTokens,
  buildIntentBrief,
  assertAffectAllowed,
  DEFAULT_AFFECT_POLICY,
  assessDependency,
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
    trusted: true,
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

test('ledger snapshot round-trips matters, preferences, links, and updates', () => {
  const ledger = new Ledger()
  const a = ledger.addMatter({ title: 'A' })
  const b = ledger.addMatter({ title: 'B' })
  ledger.addPreference({ kind: 'preference', statement: '先结论' })
  ledger.proposeLink({ fromMatter: a.id, toMatter: b.id, type: 'impact' })
  ledger.proposeUpdate({ sourceMatter: a.id, targetMatter: b.id, change: 'B 改期' })
  const restored = Ledger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())))
  assert.equal(restored.listMatters().length, 2)
  assert.equal(restored.listPreferences().length, 1)
  assert.equal(restored.listLinks().length, 1)
  assert.equal(restored.listUpdates().length, 1)
})

test('one principal has one thread across conversations; another account does not', async () => {
  const runtime = new AdvisersRuntime()
  const base = { linkId: 'email', accountId: 'me', sender: { id: 'me' }, timestamp: new Date().toISOString() }
  const a = await runtime.handleInbound({ ...base, conversationId: 'c1', messageId: 'm1', text: 'one' })
  const b = await runtime.handleInbound({ ...base, conversationId: 'c2', messageId: 'm2', text: 'two' })
  const c = await runtime.handleInbound({ ...base, accountId: 'other', conversationId: 'c3', messageId: 'm3', text: 'three' })
  assert.equal(a.threadId, b.threadId)
  assert.notEqual(a.threadId, c.threadId)
  assert.equal(runtime.listEpisodes(a.threadId).length, 2)
})

test('secrecy above clearance is denied', () => {
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: 'health', secrecy: 2 })
  assert.throws(
    () => assembleContext({ matter, ledger, clearance: 1 }),
    /requires secrecy 2/,
  )
})

test('intent brief asks when the request is vague, executes when it is clear', () => {
  const vague = buildIntentBrief('那个搞一下')
  assert.equal(vague.action, 'ask')
  assert.ok(vague.questions.length > 0)

  const clear = buildIntentBrief('做一份 Q4 预算 Excel，周五前给老板，包含三张表')
  assert.equal(clear.deliverable, 'xlsx')
  assert.equal(clear.risk, 'high')
  assert.notEqual(clear.action, 'ask')

  const probation = buildIntentBrief('整理一下客户反馈', { stage: 'probation' })
  const trusted = buildIntentBrief('整理一下客户反馈', { stage: 'trusted' })
  assert.ok(probation.action !== 'execute' || trusted.action === 'execute')
})

test('affect policy separates understanding from companion/roleplay', () => {
  assert.doesNotThrow(() => assertAffectAllowed(DEFAULT_AFFECT_POLICY, 'understanding'))
  assert.throws(() => assertAffectAllowed(DEFAULT_AFFECT_POLICY, 'companion'))
  assert.throws(() => assertAffectAllowed(DEFAULT_AFFECT_POLICY, 'roleplay'))
  const companion = { ...DEFAULT_AFFECT_POLICY, mode: 'companion' as const, roleplay: true, ageGate: '18+' as const }
  assert.doesNotThrow(() => assertAffectAllowed(companion, 'companion'))
  assert.doesNotThrow(() => assertAffectAllowed(companion, 'roleplay'))
})

test('intent block sits between soul and context', async () => {
  const runtime = new AdvisersRuntime()
  const ctx = await runtime.handleInbound({
    linkId: 'cli', accountId: 'me', conversationId: 'c1', messageId: 'm1',
    sender: { id: 'me' }, text: '做一份 Q4 预算 Excel，周五前给老板',
    timestamp: new Date().toISOString(),
  })
  assert.match(ctx.prompt, /<intent>/)
  assert.ok(ctx.prompt.indexOf('<intent>') < ctx.prompt.indexOf('<advisers-context>'))
  assert.equal(ctx.intent?.deliverable, 'xlsx')
})

test('routine is a draft until a human approves it', () => {
  const ledger = new Ledger()
  const routine = ledger.addRoutine({
    name: '周报',
    description: '每周五给老板的周报',
    trigger: ['周五'],
    steps: ['汇总本周', '写风险', '给结论'],
    preferences: ['先结论'],
    pitfalls: ['不要流水账'],
    verification: ['老板 1 分钟内能读完'],
    createdBy: 'user',
  })
  assert.equal(routine.status, 'draft')
  assert.equal(ledger.listRoutines('active').length, 0)
  ledger.approveRoutine(routine.id)
  assert.equal(ledger.listRoutines('active').length, 1)
  const restored = Ledger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())))
  assert.equal(restored.listRoutines('active').length, 1)
})

test('routine patch is a diff; version changes only after apply', () => {
  const ledger = new Ledger()
  const routine = ledger.addRoutine({
    name: '周报', description: 'v1', trigger: ['周五'], steps: ['汇总'],
    preferences: [], pitfalls: [], verification: [], createdBy: 'user',
  })
  const patch = ledger.proposeRoutinePatch(routine.id, { description: 'v2', steps: ['汇总', '风险'] })
  assert.equal(patch.status, 'pending')
  assert.match(patch.diff, /- description: "v1"/)
  assert.match(patch.diff, /\+ steps:/)
  assert.equal(ledger.listRoutines()[0]?.version, 1)
  ledger.applyRoutinePatch(patch.id)
  assert.equal(ledger.listRoutines()[0]?.version, 2)
  assert.equal(ledger.listRoutines()[0]?.description, 'v2')
  ledger.revertRoutinePatch(patch.id)
  assert.equal(ledger.listRoutines()[0]?.version, 3)
  assert.equal(ledger.listRoutines()[0]?.description, 'v1')
})

test('confirmed matter links become hints, not injected bodies', async () => {
  const ledger = new Ledger()
  const runtime = new AdvisersRuntime({ ledger })
  const base = {
    linkId: 'email', accountId: 'me', conversationId: 'c', sender: { id: 'me' },
    timestamp: new Date().toISOString(),
  }
  const first = await runtime.handleInbound({ ...base, messageId: 'm1', text: 'A 的报价要发了' })
  const b = ledger.addMatter({ title: '项目 B', summary: 'B 的排期 SECRET' })
  const link = ledger.proposeLink({ fromMatter: first.matter.id, toMatter: b.id, type: 'impact' })
  ledger.confirmLink(link.id)
  const ctx = await runtime.handleInbound({ ...base, messageId: 'm2', text: '继续' })
  assert.equal(ctx.matter.id, first.matter.id)
  assert.equal(ctx.hints.length, 1)
  assert.equal(ctx.hints[0]?.matterId, b.id)
  assert.doesNotMatch(ctx.prompt, /SECRET/)
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
    trusted: true,
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

test('ledger snapshot round-trips matters, preferences, links, and updates', () => {
  const ledger = new Ledger()
  const a = ledger.addMatter({ title: 'A' })
  const b = ledger.addMatter({ title: 'B' })
  ledger.addPreference({ kind: 'preference', statement: '先结论' })
  ledger.proposeLink({ fromMatter: a.id, toMatter: b.id, type: 'impact' })
  ledger.proposeUpdate({ sourceMatter: a.id, targetMatter: b.id, change: 'B 改期' })
  const restored = Ledger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())))
  assert.equal(restored.listMatters().length, 2)
  assert.equal(restored.listPreferences().length, 1)
  assert.equal(restored.listLinks().length, 1)
  assert.equal(restored.listUpdates().length, 1)
})

test('one principal has one thread across conversations; another account does not', async () => {
  const runtime = new AdvisersRuntime()
  const base = { linkId: 'email', accountId: 'me', sender: { id: 'me' }, timestamp: new Date().toISOString() }
  const a = await runtime.handleInbound({ ...base, conversationId: 'c1', messageId: 'm1', text: 'one' })
  const b = await runtime.handleInbound({ ...base, conversationId: 'c2', messageId: 'm2', text: 'two' })
  const c = await runtime.handleInbound({ ...base, accountId: 'other', conversationId: 'c3', messageId: 'm3', text: 'three' })
  assert.equal(a.threadId, b.threadId)
  assert.notEqual(a.threadId, c.threadId)
  assert.equal(runtime.listEpisodes(a.threadId).length, 2)
})

test('secrecy above clearance is denied', () => {
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: 'health', secrecy: 2 })
  assert.throws(
    () => assembleContext({ matter, ledger, clearance: 1 }),
    /requires secrecy 2/,
  )
})

test('intent brief asks when the request is vague, executes when it is clear', () => {
  const vague = buildIntentBrief('那个搞一下')
  assert.equal(vague.action, 'ask')
  assert.ok(vague.questions.length > 0)

  const clear = buildIntentBrief('做一份 Q4 预算 Excel，周五前给老板，包含三张表')
  assert.equal(clear.deliverable, 'xlsx')
  assert.equal(clear.risk, 'high')
  assert.notEqual(clear.action, 'ask')

  const probation = buildIntentBrief('整理一下客户反馈', { stage: 'probation' })
  const trusted = buildIntentBrief('整理一下客户反馈', { stage: 'trusted' })
  assert.ok(probation.action !== 'execute' || trusted.action === 'execute')
})

test('affect policy separates understanding from companion/roleplay', () => {
  assert.doesNotThrow(() => assertAffectAllowed(DEFAULT_AFFECT_POLICY, 'understanding'))
  assert.throws(() => assertAffectAllowed(DEFAULT_AFFECT_POLICY, 'companion'))
  assert.throws(() => assertAffectAllowed(DEFAULT_AFFECT_POLICY, 'roleplay'))
  const companion = { ...DEFAULT_AFFECT_POLICY, mode: 'companion' as const, roleplay: true, ageGate: '18+' as const }
  assert.doesNotThrow(() => assertAffectAllowed(companion, 'companion'))
  assert.doesNotThrow(() => assertAffectAllowed(companion, 'roleplay'))
})

test('intent block sits between soul and context', async () => {
  const runtime = new AdvisersRuntime()
  const ctx = await runtime.handleInbound({
    linkId: 'cli', accountId: 'me', conversationId: 'c1', messageId: 'm1',
    sender: { id: 'me' }, text: '做一份 Q4 预算 Excel，周五前给老板',
    timestamp: new Date().toISOString(),
  })
  assert.match(ctx.prompt, /<intent>/)
  assert.ok(ctx.prompt.indexOf('<intent>') < ctx.prompt.indexOf('<advisers-context>'))
  assert.equal(ctx.intent?.deliverable, 'xlsx')
})

test('routine is a draft until a human approves it', () => {
  const ledger = new Ledger()
  const routine = ledger.addRoutine({
    name: '周报',
    description: '每周五给老板的周报',
    trigger: ['周五'],
    steps: ['汇总本周', '写风险', '给结论'],
    preferences: ['先结论'],
    pitfalls: ['不要流水账'],
    verification: ['老板 1 分钟内能读完'],
    createdBy: 'user',
  })
  assert.equal(routine.status, 'draft')
  assert.equal(ledger.listRoutines('active').length, 0)
  ledger.approveRoutine(routine.id)
  assert.equal(ledger.listRoutines('active').length, 1)
  const restored = Ledger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())))
  assert.equal(restored.listRoutines('active').length, 1)
})

test('routine patch is a diff; version changes only after apply', () => {
  const ledger = new Ledger()
  const routine = ledger.addRoutine({
    name: '周报', description: 'v1', trigger: ['周五'], steps: ['汇总'],
    preferences: [], pitfalls: [], verification: [], createdBy: 'user',
  })
  const patch = ledger.proposeRoutinePatch(routine.id, { description: 'v2', steps: ['汇总', '风险'] })
  assert.equal(patch.status, 'pending')
  assert.match(patch.diff, /- description: "v1"/)
  assert.match(patch.diff, /\+ steps:/)
  assert.equal(ledger.listRoutines()[0]?.version, 1)
  ledger.applyRoutinePatch(patch.id)
  assert.equal(ledger.listRoutines()[0]?.version, 2)
  assert.equal(ledger.listRoutines()[0]?.description, 'v2')
  ledger.revertRoutinePatch(patch.id)
  assert.equal(ledger.listRoutines()[0]?.version, 3)
  assert.equal(ledger.listRoutines()[0]?.description, 'v1')
})



test('dependency guard escalates replacement of human contact', () => {
  assert.equal(assessDependency({ minutesToday: 10, sessionsToday: 1 }).level, 'ok')
  assert.equal(assessDependency({ minutesToday: 180, sessionsToday: 2 }).level, 'warn')
  assert.equal(assessDependency({ minutesToday: 10, sessionsToday: 1, substitutesHumanContact: true }).level, 'limit')
})

test('seen store makes ingest idempotent across runtime instances', async () => {
  const seen = new Set<string>()
  const store = { has: (key: string) => seen.has(key), add: (key: string) => { seen.add(key) } }
  const event = {
    linkId: 'email', accountId: 'me', conversationId: 'c', messageId: 'm1',
    sender: { id: 'me' }, text: '同一封邮件', timestamp: new Date().toISOString(),
  }
  const first = new AdvisersRuntime({ seen: store })
  assert.equal((await first.ingest(event)).accepted, true)
  const second = new AdvisersRuntime({ seen: store })
  assert.equal((await second.ingest(event)).accepted, false)
})

test('routine lifecycle: stale, deprecate, restore', () => {
  const ledger = new Ledger()
  const routine = ledger.addRoutine({ name: 'x', description: '', trigger: [], steps: ['a'], preferences: [], pitfalls: [], verification: [], createdBy: 'user' })
  ledger.approveRoutine(routine.id)
  assert.throws(() => ledger.approveRoutine(routine.id), /only draft/)
  assert.equal(ledger.staleRoutine(routine.id).status, 'stale')
  assert.equal(ledger.deprecateRoutine(routine.id).status, 'deprecated')
  assert.equal(ledger.restoreRoutine(routine.id).status, 'draft')
})
