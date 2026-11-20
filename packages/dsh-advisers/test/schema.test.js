import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply } from '../index.js'

// Isolate the suite from the developer's real ~/.advisers: the ledger read tools
// now open the real ledger when one exists, and these tests exercise the marked
// preview fallback with seeded in-memory data.
const EMPTY_ROOT = mkdtempSync(join(tmpdir(), 'advisers-dsh-schema-'))
process.env.ADVISERS_HOME = join(EMPTY_ROOT, 'home')
delete process.env.ADVISERS_STORE
after(() => { rmSync(EMPTY_ROOT, { recursive: true, force: true }) })

const ALL_TOOL_NAMES = ['advisers_brief', 'advisers_clients', 'advisers_evidence', 'advisers_office', 'advisers_today', 'advisers_who']
const READ_ONLY_TOOL_NAMES = ['advisers_evidence', 'advisers_today', 'advisers_who']
const EXEC = { signal: new AbortController().signal, deferContext() {}, concludeTurn() {} }
const DAY_MS = 24 * 60 * 60 * 1000

function mount(config = {}) {
  const tools = []
  let runtime
  const ctx = {
    provide(serviceName, value) { if (serviceName === 'advisers') runtime = value },
    tools: { register(tool) { tools.push(tool); return () => {} } },
  }
  apply(ctx, config)
  return { tools, runtime, byName: new Map(tools.map((tool) => [tool.name, tool])) }
}

/** Execute one tool and enforce its canonical schema plus renderer contract. */
async function execute(tool, args = {}) {
  const value = await tool.execute(args, EXEC)
  const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
  assert.deepEqual(violations, [], `${tool.name} returned a value outside its output schema`)
  const content = tool.output.render(args, value)
  assert.ok(Array.isArray(content) && content.length === 1, `${tool.name} render must return one content block`)
  assert.equal(content[0].type, 'text')
  assert.equal(typeof content[0].text, 'string')
  return value
}

function seedLedger(runtime) {
  const now = Date.now()
  const matter = runtime.ledger.addMatter({ title: 'Q4 planning', domain: 'work' })
  const overdue = runtime.ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: 'boss',
    action: 'send overdue report',
    dueAt: new Date(now - 2 * DAY_MS).toISOString(),
    evidence: [{ sessionId: 's1', turnId: 't1', quote: 'ship it' }],
  })
  const dueToday = runtime.ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: 'boss',
    action: 'finish today report',
    dueAt: new Date(now).toISOString(),
    evidence: [{ sessionId: 's1', turnId: 't2', quote: 'today quote' }],
  })
  const waiting = runtime.ledger.addCommitment({
    matterId: matter.id,
    debtor: 'third:alice',
    creditor: 'me',
    action: 'alice sends deck',
    dueAt: new Date(now + 2 * DAY_MS).toISOString(),
    evidence: [{ sessionId: 's2', turnId: 't3', quote: 'alice quote' }],
  })
  const noDue = runtime.ledger.addCommitment({
    matterId: matter.id,
    debtor: 'agent',
    creditor: 'me',
    action: 'untimed task',
    evidence: [{ quote: 'missing turn ids' }],
  })
  const fact = runtime.ledger.remember({
    subject: 'client',
    predicate: 'likes',
    object: 'tea',
    evidence: [{ quote: 'fact quote', ref: 's2#t2' }],
  })
  const preference = runtime.ledger.addPreference({
    kind: 'preference',
    statement: 'short replies',
    evidence: [{ quote: 'pref quote', ref: 's3#t3' }],
  })
  return { matter, overdue, dueToday, waiting, noDue, fact, preference }
}

test('DSH bundle registers six tools with host-valid schemas', () => {
  const { tools, byName } = mount({ workspace: process.cwd() })

  assert.equal(tools.length, 6)
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ALL_TOOL_NAMES)

  for (const tool of tools) {
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.parameters), `${tool.name} parameter schema`)
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema), `${tool.name} output schema`)
    assert.equal(typeof tool.output.render, 'function')
  }

  // The 5-tool expansion must not change the two original tool schemas.
  const brief = byName.get('advisers_brief')
  assert.deepEqual(Object.keys(brief.parameters.properties), ['text'])
  assert.deepEqual(brief.parameters.required, ['text'])
  const office = byName.get('advisers_office')
  assert.deepEqual(Object.keys(office.parameters.properties), ['kind', 'out', 'spec'])
  assert.deepEqual(office.parameters.required, ['kind', 'out', 'spec'])

  // Read-only tools use the same { ok, data | error } envelope and accept only documented args.
  for (const name of READ_ONLY_TOOL_NAMES) {
    const tool = byName.get(name)
    assert.ok(Array.isArray(tool.output.schema.oneOf) && tool.output.schema.oneOf.length === 2, `${name} envelope`)
    assert.notDeepEqual(validateJsonSchemaValue(tool.output.schema, { ok: true }, 'value'), [])
    assert.deepEqual(
      validateJsonSchemaValue(tool.output.schema, { ok: false, error: { code: 'X', message: 'm' } }, 'value'),
      [],
    )
  }
  assert.deepEqual(validateJsonSchemaValue(byName.get('advisers_today').parameters, {}, 'arguments'), [])
  assert.deepEqual(validateJsonSchemaValue(byName.get('advisers_who').parameters, {}, 'arguments'), [])
  assert.deepEqual(validateJsonSchemaValue(byName.get('advisers_evidence').parameters, { id: 'cm_x' }, 'arguments'), [])
  assert.notDeepEqual(validateJsonSchemaValue(byName.get('advisers_evidence').parameters, {}, 'arguments'), [])
})

test('advisers_brief keeps its original IntentBrief behavior', async () => {
  const { byName } = mount()
  const value = await execute(byName.get('advisers_brief'), { text: '做一份 Q4 汇报 PPT，周五前给老板' })
  assert.equal(typeof value.goal, 'string')
  assert.equal(typeof value.deliverable, 'string')
  assert.equal(typeof value.action, 'string')
  assert.equal(typeof value.risk, 'string')
  assert.ok(Array.isArray(value.questions) && value.questions.length <= 1)
  assert.equal(typeof value.readback, 'string')
  assert.ok(value.readback.length > 0)
})

test('read-only tools read the ledger without mutating it or sending messages', async () => {
  const { byName, runtime } = mount()
  const seeded = seedLedger(runtime)
  const audits = []
  runtime.audit = (event) => audits.push(event)
  let sends = 0
  runtime.send = async () => { sends += 1; return { ok: true } }
  const before = JSON.stringify(runtime.ledger.toJSON())

  const today = await execute(byName.get('advisers_today'))
  assert.equal(today.ok, true)
  assert.equal(today.data.counts.open, 4)
  assert.equal(today.data.counts.overdue, 1)
  assert.equal(today.data.counts.today, 1)
  assert.equal(today.data.counts.week, 1)
  assert.equal(today.data.counts.waiting, 1)
  assert.equal(today.data.counts.noDue, 1)
  assert.equal(today.data.next.id, seeded.overdue.id)
  assert.equal(today.data.truncated, false)

  const who = await execute(byName.get('advisers_who'))
  assert.equal(who.ok, true)
  assert.deepEqual(who.data.counts, { mine: 3, waiting: 1, open: 4 })
  assert.ok(who.data.mine.some((commitment) => commitment.id === seeded.overdue.id))
  assert.ok(who.data.waiting.some((commitment) => commitment.id === seeded.waiting.id))

  const commitmentEvidence = await execute(byName.get('advisers_evidence'), { id: seeded.dueToday.id })
  assert.equal(commitmentEvidence.ok, true)
  assert.equal(commitmentEvidence.data.kind, 'commitment')
  assert.equal(commitmentEvidence.data.verified, false)
  assert.deepEqual(commitmentEvidence.data.sources.map((source) => source.ref), ['s1#t2'])
  assert.deepEqual(commitmentEvidence.data.missing, [])

  const invalidEvidence = await execute(byName.get('advisers_evidence'), { id: seeded.noDue.id })
  assert.deepEqual(invalidEvidence.data.sources, [])
  assert.deepEqual(invalidEvidence.data.missing.map((entry) => entry.reason), ['invalid_evidence'])

  const factEvidence = await execute(byName.get('advisers_evidence'), { id: seeded.fact.id })
  assert.equal(factEvidence.data.kind, 'fact')
  assert.deepEqual(factEvidence.data.sources.map((source) => source.ref), ['s2#t2'])

  const preferenceEvidence = await execute(byName.get('advisers_evidence'), { id: seeded.preference.id })
  assert.equal(preferenceEvidence.data.kind, 'preference')
  assert.deepEqual(preferenceEvidence.data.sources.map((source) => source.ref), ['s3#t3'])

  assert.equal(JSON.stringify(runtime.ledger.toJSON()), before, 'read-only tools must not mutate the ledger')
  assert.equal(sends, 0, 'read-only tools must not send messages')
  assert.equal(audits.length, 6, 'each successful read is reported to the optional audit sink')
  for (const event of audits) {
    assert.equal(event.actor, 'dsh')
    assert.equal(event.action, 'tool.read')
    assert.equal(event.allowed, true)
    assert.equal(typeof event.reason, 'string')
  }
})

test('read-only tools return structured error codes instead of throwing', async () => {
  const { byName, runtime } = mount()
  const evidence = byName.get('advisers_evidence')

  // With no audit sink installed the default path is still readable (empty ledger included).
  const emptyToday = await execute(byName.get('advisers_today'))
  assert.equal(emptyToday.ok, true)
  assert.deepEqual(emptyToday.data.counts, { open: 0, overdue: 0, today: 0, week: 0, waiting: 0, noDue: 0 })
  assert.equal(emptyToday.data.next, undefined)
  const emptyWho = await execute(byName.get('advisers_who'))
  assert.equal(emptyWho.ok, true)
  assert.deepEqual(emptyWho.data.counts, { mine: 0, waiting: 0, open: 0 })

  const unknownPrefix = await execute(evidence, { id: 'matter_1' })
  assert.equal(unknownPrefix.ok, false)
  assert.equal(unknownPrefix.error.code, 'UNKNOWN_ID_PREFIX')
  assert.equal(typeof unknownPrefix.error.message, 'string')

  const missing = await execute(evidence, { id: 'cm_missing' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'EVIDENCE_NOT_FOUND')
  assert.ok(missing.error.message.includes('cm_missing'))

  const empty = await execute(evidence, { id: '   ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'INVALID_ARGUMENT')

  // Missing required args are rejected by the host's typed argument validation.
  await assert.rejects(evidence.execute({}, EXEC), (error) => error.code === 'INVALID_ARGS')

  // Unexpected ledger failures are contained as a structured error, never a raw throw.
  runtime.ledger.openCommitments = () => { throw new Error('ledger unavailable') }
  runtime.audit = () => { throw new Error('audit sink unavailable') }
  const internal = await execute(byName.get('advisers_today'))
  assert.equal(internal.ok, false)
  assert.equal(internal.error.code, 'INTERNAL_ERROR')
  const rendered = byName.get('advisers_today').output.render({}, internal)
  assert.ok(rendered[0].text.startsWith('INTERNAL_ERROR:'), 'error render starts with the structured code')
})
