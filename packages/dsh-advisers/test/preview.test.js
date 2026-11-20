import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply } from '../index.js'

// Preview fallback contract (0.2.3 task-85, kept for the 0.3.0 fallback path).
//
// The three ledger read tools read the real ledger when one is readable (see
// ledger-read.test.js). This suite pins the FALLBACK: with no readable ledger the
// tools return the 0.2.x in-memory preview and a required source marker, so an
// empty preview is never mistaken for a real empty ledger:
//   - every successful read payload carries preview / source / note;
//   - the 0.2.x payload fields, values and error codes are unchanged (additive);
//   - rendered text and tool descriptions disclose the fallback;
//   - a later edit cannot silently drop the fields (they are schema-required).

// 0.3.0: these tools read the REAL ledger when one exists. These tests cover the
// preview FALLBACK (no readable ledger): point ADVISERS_HOME at a fresh, empty
// directory so a developer's real ~/.advisers can never be read by the suite.
const EMPTY_ROOT = mkdtempSync(join(tmpdir(), 'advisers-dsh-preview-'))
const EMPTY_HOME = join(EMPTY_ROOT, 'home')
process.env.ADVISERS_HOME = EMPTY_HOME
delete process.env.ADVISERS_STORE
after(() => { rmSync(EMPTY_ROOT, { recursive: true, force: true }) })

const READ_ONLY_TOOL_NAMES = ['advisers_evidence', 'advisers_today', 'advisers_who']
const PREVIEW_FIELDS = ['note', 'preview', 'source']
// 0.2.2 payload keys, i.e. everything except the additive preview fields.
const LEGACY_DATA_FIELDS = {
  advisers_today: ['counts', 'localDay', 'noDue', 'now', 'overdue', 'timezone', 'today', 'truncated', 'waiting', 'week'],
  advisers_who: ['counts', 'mine', 'truncated', 'waiting'],
  advisers_evidence: ['counts', 'id', 'kind', 'missing', 'record', 'sources', 'truncated', 'verified'],
}
const EXEC = { signal: new AbortController().signal, deferContext() {}, concludeTurn() {} }

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
  assert.deepEqual(violations, [], tool.name + ' returned a value outside its output schema')
  const content = tool.output.render(args, value)
  assert.ok(Array.isArray(content) && content.length === 1, tool.name + ' render must return one block')
  assert.equal(content[0].type, 'text')
  assert.equal(typeof content[0].text, 'string')
  return { value, text: content[0].text }
}

function seedLedger(runtime) {
  const matter = runtime.ledger.addMatter({ title: 'Q4 planning', domain: 'work' })
  const commitment = runtime.ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: 'boss',
    action: 'send the Q4 deck',
    dueAt: new Date().toISOString(),
    evidence: [{ sessionId: 's1', turnId: 't1', quote: 'ship it' }],
  })
  return { matter, commitment }
}

test('read-tool schemas require the source marker (0.3.0 contract)', () => {
  const { byName } = mount()
  for (const name of READ_ONLY_TOOL_NAMES) {
    const tool = byName.get(name)
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema), name + ' output schema')
    const success = tool.output.schema.oneOf.find((branch) => branch.properties?.ok?.const === true)
    assert.ok(success, name + ' must keep the ok:true branch')
    const properties = success.properties.data.properties
    // defineTool normalizes per-property `required: true` into a parent array.
    const required = success.properties.data.required
    assert.equal(properties.preview?.type, 'boolean')
    assert.equal(properties.source?.type, 'string')
    // 0.3.0: the value is data, not a constant; the real-ledger source is allowed
    // but the preview source must stay a valid branch.
    assert.deepEqual(properties.source?.enum, ['preview-no-ledger', 'ledger-readonly'])
    assert.equal(properties.note?.type, 'string')
    assert.ok(required.includes('preview'), name + ' data.preview must be required')
    assert.ok(required.includes('source'), name + ' data.source must be required')
    assert.ok(required.includes('note'), name + ' data.note must be required')
  }
  // A 0.2.2-shaped today payload (old fields only) no longer validates, so the
  // host schema gate fails if a later edit drops the disclosure.
  const oldToday = {
    now: '2026-11-18T00:00:00.000Z',
    timezone: 'Asia/Shanghai',
    localDay: '2026-11-18',
    counts: { open: 0, overdue: 0, today: 0, week: 0, waiting: 0, noDue: 0 },
    overdue: [], today: [], week: [], waiting: [], noDue: [],
    truncated: false,
  }
  assert.notDeepEqual(
    validateJsonSchemaValue(byName.get('advisers_today').output.schema, { ok: true, data: oldToday }, 'value'),
    [],
  )
})

test('every read result carries preview:true / source:"preview-no-ledger" / note', async () => {
  const { byName, runtime } = mount()
  const seeded = seedLedger(runtime)
  const results = {
    advisers_today: await execute(byName.get('advisers_today')),
    advisers_who: await execute(byName.get('advisers_who')),
    advisers_evidence: await execute(byName.get('advisers_evidence'), { id: seeded.commitment.id }),
  }
  const notes = new Set()
  for (const [name, { value }] of Object.entries(results)) {
    assert.equal(value.ok, true, name + ' should succeed')
    assert.equal(value.data.preview, true, name + ' must set data.preview')
    assert.equal(value.data.source, 'preview-no-ledger', name + ' must set data.source')
    assert.equal(typeof value.data.note, 'string', name + ' must set data.note')
    assert.match(value.data.note, /~\/\.advisers\/state\.db/, name + ' note must name the unwired ledger')
    assert.match(value.data.note, /CLI|MCP/, name + ' note must point at a real-data alternative')
    assert.ok(value.data.note.length >= 40, name + ' note must be a real disclosure')
    notes.add(value.data.note)
  }
  assert.equal(notes.size, 1, 'all three read tools must carry the same disclosure text')
})

test('preview marker is additive: 0.2.x fields and values do not regress', async () => {
  const { byName, runtime } = mount()
  const seeded = seedLedger(runtime)
  const today = (await execute(byName.get('advisers_today'))).value
  const who = (await execute(byName.get('advisers_who'))).value
  const evidence = (await execute(byName.get('advisers_evidence'), { id: seeded.commitment.id })).value

  for (const [name, value] of [['advisers_today', today], ['advisers_who', who], ['advisers_evidence', evidence]]) {
    // `next` is the optional 0.2.x today field (present when an open commitment
    // has a due date); include it when the payload carries it.
    const legacy = LEGACY_DATA_FIELDS[name].slice()
    if (name === 'advisers_today' && value.data.next !== undefined) legacy.push('next')
    assert.deepEqual(
      Object.keys(value.data).sort(),
      [...legacy, ...PREVIEW_FIELDS].sort(),
      name + ' payload keys must be the 0.2.x keys plus the three preview fields',
    )
  }

  assert.deepEqual(today.data.counts, { open: 1, overdue: 0, today: 1, week: 0, waiting: 0, noDue: 0 })
  assert.deepEqual(today.data.overdue, [])
  assert.equal(today.data.today.length, 1)
  assert.equal(today.data.today[0].id, seeded.commitment.id)
  assert.equal(today.data.next.id, seeded.commitment.id)
  assert.equal(today.data.timezone, 'Asia/Shanghai')
  assert.equal(today.data.truncated, false)

  assert.deepEqual(who.data.counts, { mine: 1, waiting: 0, open: 1 })
  assert.equal(who.data.mine[0].id, seeded.commitment.id)
  assert.deepEqual(who.data.waiting, [])

  assert.equal(evidence.data.id, seeded.commitment.id)
  assert.equal(evidence.data.kind, 'commitment')
  assert.equal(evidence.data.record.type, 'commitment')
  assert.equal(evidence.data.verified, false)
  assert.deepEqual(evidence.data.sources.map((source) => source.ref), ['s1#t1'])
  assert.deepEqual(evidence.data.missing, [])
  assert.deepEqual(evidence.data.counts, { sources: 1, missing: 0 })
  assert.equal(evidence.data.truncated, false)
})

test('rendered tool text discloses the preview before the counts', async () => {
  const { byName, runtime } = mount()
  const seeded = seedLedger(runtime)
  const today = await execute(byName.get('advisers_today'))
  const who = await execute(byName.get('advisers_who'))
  const evidence = await execute(byName.get('advisers_evidence'), { id: seeded.commitment.id })
  assert.match(today.text, /^\[preview: no ledger\] today /)
  assert.match(who.text, /^\[preview: no ledger\] who: /)
  assert.match(evidence.text, /^\[preview: no ledger\] commitment /)
  // The 0.2.x summary is still rendered after the tag.
  assert.match(today.text, /\d+ due today/)
  assert.match(who.text, /owed by me/)
  assert.match(evidence.text, /source\(s\)/)
})

test('empty preview is not presented as a real empty ledger', async () => {
  const { byName } = mount()
  const today = await execute(byName.get('advisers_today'))
  assert.deepEqual(today.value.data.counts, { open: 0, overdue: 0, today: 0, week: 0, waiting: 0, noDue: 0 })
  assert.equal(today.value.data.preview, true)
  assert.equal(today.value.data.next, undefined)

  const evidence = await execute(byName.get('advisers_evidence'), { id: 'cm_from_the_real_ledger' })
  assert.equal(evidence.value.ok, false)
  assert.equal(evidence.value.error.code, 'EVIDENCE_NOT_FOUND')
  assert.match(evidence.value.error.message, /preview ledger/)
  assert.doesNotMatch(evidence.value.error.message, /deleted/)
})

test('structured error codes and the 0.2.x error envelope are preserved', async () => {
  const { byName, runtime } = mount()
  const evidence = byName.get('advisers_evidence')
  // The error branch is unchanged: a 0.2.2-shaped error still validates.
  assert.deepEqual(
    validateJsonSchemaValue(evidence.output.schema, { ok: false, error: { code: 'EVIDENCE_NOT_FOUND', message: 'm' } }, 'value'),
    [],
  )

  const unknownPrefix = await execute(evidence, { id: 'matter_1' })
  assert.equal(unknownPrefix.value.ok, false)
  assert.equal(unknownPrefix.value.error.code, 'UNKNOWN_ID_PREFIX')
  assert.match(unknownPrefix.text, /^UNKNOWN_ID_PREFIX: /)

  const missing = await execute(evidence, { id: 'cm_missing' })
  assert.equal(missing.value.ok, false)
  assert.equal(missing.value.error.code, 'EVIDENCE_NOT_FOUND')
  assert.match(missing.value.error.message, /cm_missing/)
  assert.match(missing.text, /^EVIDENCE_NOT_FOUND: /)

  const empty = await execute(evidence, { id: '   ' })
  assert.equal(empty.value.error.code, 'INVALID_ARGUMENT')

  // Unexpected failures stay contained as INTERNAL_ERROR instead of a raw throw.
  runtime.ledger.openCommitments = () => { throw new Error('ledger unavailable') }
  const internal = await execute(byName.get('advisers_today'))
  assert.equal(internal.value.ok, false)
  assert.equal(internal.value.error.code, 'INTERNAL_ERROR')
  assert.match(internal.text, /^INTERNAL_ERROR: /)
})

test('tool descriptions advertise the real-ledger read and the preview fallback (tools/list)', () => {
  const { byName } = mount()
  for (const name of READ_ONLY_TOOL_NAMES) {
    const description = byName.get(name).description
    assert.match(description, /read-only/i, name + ' description must say read-only')
    assert.match(description, /~\/\.advisers\/state\.db/, name + ' description must name the ledger')
    assert.match(description, /preview/i, name + ' description must disclose the preview fallback')
    assert.match(description, /real local Advisers ledger/, name + ' description must point at the real ledger')
    assert.match(description, /(Never writes the ledger|write the ledger, or send a message)/, name + ' keeps the read-only promise')
  }
  // advisers_brief and advisers_office do not depend on the ledger and are unchanged.
  assert.doesNotMatch(byName.get('advisers_brief').description, /preview/i)
  assert.doesNotMatch(byName.get('advisers_office').description, /preview/i)
  assert.deepEqual(
    [...byName.keys()].sort(),
    ['advisers_brief', 'advisers_clients', 'advisers_evidence', 'advisers_office', 'advisers_today', 'advisers_who'],
  )
})
