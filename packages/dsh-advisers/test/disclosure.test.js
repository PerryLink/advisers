/**
 * 0.5.0 M1: DSH read disclosure/view (additive) contract.
 *
 * The DSH adapter is read-only and never writes the advisers tamper-evident
 * audit chain, so its disclosure is always audited:false. The preview/JSON
 * fallback never claims more than `pending`; a real ledger read derives row
 * views from the local read model only (the adapter has no turn store).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { apply } from '../index.js'
import { createLedgerReader } from '../lib/read.js'
import { SqliteStore } from '../../advisers/lib/sqlite.js'
import { seedAcceptedTos } from '../../advisers/test/tos-fixture.js'

const tempRoots = []
function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}
after(() => {
  for (const root of tempRoots) { try { rmSync(root, { recursive: true, force: true }) } catch {} }
})

const EMPTY_HOME = join(makeRoot('adv-dsh-disclosure-empty-'), 'home')
const originalHome = process.env.ADVISERS_HOME
const originalStore = process.env.ADVISERS_STORE
process.env.ADVISERS_HOME = EMPTY_HOME
delete process.env.ADVISERS_STORE
after(() => {
  if (originalHome === undefined) delete process.env.ADVISERS_HOME
  else process.env.ADVISERS_HOME = originalHome
  if (originalStore === undefined) delete process.env.ADVISERS_STORE
  else process.env.ADVISERS_STORE = originalStore
})

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

function seedRealLedger(home) {
  seedAcceptedTos(home)
  const createdAt = '2026-01-01T00:00:00.000Z'
  const store = new SqliteStore(join(home, 'state.db'))
  const seeded = {}
  try {
    store.mutate(() => {
      store.insertMatter({ id: 'm_public', title: 'Q4', status: 'active', domain: 'work', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt, updatedAt: createdAt })
      const client = store.addClient({ name: 'ACME', aliases: [], tags: [], secrecyDefault: 0 })
      const project = store.addProject({ clientId: client.id, name: 'Website' })
      store.setMatterClient('m_public', { clientId: client.id, projectId: project.id })
      store.insertCommitment({ id: 'cm_open', matterId: 'm_public', debtor: 'user', creditor: 'boss', action: 'send the quote', timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none', createdAt })
      store.insertCommitment({ id: 'cm_done', matterId: 'm_public', debtor: 'user', creditor: 'boss', action: 'finished work', timezone: 'Asia/Shanghai', status: 'done', evidence: [], capability: 'none', createdAt })
      store.insertFact({ id: 'fact_confirmed', matterId: 'm_public', subject: 'client', predicate: 'prefers', object: 'tea', recordedAt: createdAt, authority: 'user', confidence: 0.9, evidence: [], status: 'confirmed' })
      seeded.client = client
      seeded.project = project
    }, { actor: 'test', action: 'seed', allowed: true, reason: 'fixture' })
  } finally { store.close() }
  return seeded
}

function assertDisclosureShape(disclosure, { tool, basis }) {
  assert.equal(disclosure.surface, 'dsh')
  assert.equal(disclosure.tool, tool)
  assert.equal(disclosure.basis, basis)
  assert.equal(disclosure.audited, false, 'the DSH adapter never writes the tamper-evident audit chain')
  assert.match(disclosure.callId, /^dc_[0-9a-f]{16}$/)
  assert.match(disclosure.digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(disclosure.callId, 'dc_' + disclosure.digest.slice(7, 23))
  assert.deepEqual(Object.keys(disclosure.view), ['verified', 'pending', 'historical', 'derived'])
}

test('host schemas require the additive disclosure block and row view labels', () => {
  const { byName } = mount()
  for (const name of ['advisers_today', 'advisers_who', 'advisers_evidence', 'advisers_clients']) {
    const success = byName.get(name).output.schema.oneOf.filter((branch) => branch.properties?.ok?.const === true)
    assert.ok(success.length > 0, name)
    for (const branch of success) {
      assert.ok(branch.properties.data.required.includes('disclosure'), name + ' data.disclosure must be required')
      assert.equal(branch.properties.data.properties.disclosure.properties.audited.const, false)
    }
  }
  const today = byName.get('advisers_today').output.schema.oneOf.find((branch) => branch.properties?.ok?.const === true)
  assert.ok(today.properties.data.properties.disclosure.required.includes('audited'))
})

test('preview: basis=preview, audited=false, every row pending (never verified)', async () => {
  const { runtime } = mount()
  const matter = runtime.ledger.addMatter({ title: 'preview', secrecy: 0 })
  const commitment = runtime.ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: 'boss',
    action: 'send the deck',
    dueAt: new Date().toISOString(),
    evidence: [{ sessionId: 's1', turnId: 't1', quote: 'ship it' }],
  })
  const reader = createLedgerReader({ mode: 'preview' }, { runtime })

  const today = (await reader.todayView()).data
  assertDisclosureShape(today.disclosure, { tool: 'advisers_today', basis: 'preview' })
  assert.equal(today.disclosure.audited, false)
  assert.ok(today.today.length > 0)
  assert.equal(today.today[0].view, 'pending')
  assert.deepEqual(today.disclosure.view, { verified: 0, pending: today.overdue.length + today.today.length + today.week.length + today.waiting.length + today.noDue.length, historical: 0, derived: 0 })

  const who = (await reader.whoView()).data
  assertDisclosureShape(who.disclosure, { tool: 'advisers_who', basis: 'preview' })
  assert.equal(who.mine[0].view, 'pending')

  const evidence = (await reader.evidenceView({ id: commitment.id })).data
  assertDisclosureShape(evidence.disclosure, { tool: 'advisers_evidence', basis: 'preview' })
  assert.equal(evidence.record.view, 'pending')
  assert.equal(evidence.verified, false)
  assert.equal(evidence.disclosure.view.pending, 1)

  const clients = (await reader.clientsView({ action: 'list' })).data
  assertDisclosureShape(clients.disclosure, { tool: 'advisers_clients', basis: 'preview' })
  assert.deepEqual(clients.clients, [])
  assert.equal(clients.disclosure.view.derived, 0)
})

test('real ledger: basis=local-resolution, closed rows are historical, clients are derived', async () => {
  const home = join(makeRoot('adv-dsh-disclosure-'), 'home')
  const seeded = seedRealLedger(home)
  const reader = createLedgerReader({ home })

  const today = (await reader.todayView()).data
  assertDisclosureShape(today.disclosure, { tool: 'advisers_today', basis: 'local-resolution' })
  const openRow = [...today.today, ...today.noDue, ...today.overdue, ...today.week, ...today.waiting].find((row) => row.id === 'cm_open')
  assert.equal(openRow.view, 'pending')
  assert.equal(today.disclosure.audited, false)

  const doneEvidence = (await reader.evidenceView({ id: 'cm_done' })).data
  assert.equal(doneEvidence.record.view, 'historical')
  assert.equal(doneEvidence.disclosure.view.historical, 1)
  const openEvidence = (await reader.evidenceView({ id: 'cm_open' })).data
  assert.equal(openEvidence.record.view, 'pending', 'the adapter has no turn store, so it never claims verified')
  const factEvidence = (await reader.evidenceView({ id: 'fact_confirmed' })).data
  assert.equal(factEvidence.record.view, 'pending')

  const clients = (await reader.clientsView({ action: 'list' })).data
  assertDisclosureShape(clients.disclosure, { tool: 'advisers_clients', basis: 'local-resolution' })
  assert.equal(clients.clients.length, 1)
  assert.equal(clients.clients[0].id, seeded.client.id)
  assert.equal(clients.clients[0].view, 'derived')
  assert.equal(clients.disclosure.view.derived, 1)
  assert.equal(clients.disclosure.audited, false)

  const show = (await reader.clientsView({ action: 'show', id: seeded.client.id })).data
  assert.equal(show.client.view, 'derived')
  assert.equal(show.disclosure.tool, 'advisers_clients')
})

test('the mounted DSH tools validate their whole payload (disclosure included) against the host schema', async () => {
  const home = join(makeRoot('adv-dsh-disclosure-mounted-'), 'home')
  seedRealLedger(home)
  const { byName } = mount({ home })
  for (const [name, args] of [
    ['advisers_today', {}],
    ['advisers_who', {}],
    ['advisers_evidence', { id: 'cm_open' }],
    ['advisers_clients', { action: 'list' }],
  ]) {
    const tool = byName.get(name)
    const value = await tool.execute(args, EXEC)
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), [], name + ' payload must stay inside the host output schema')
    if (value.ok === true) {
      assert.equal(value.data.disclosure.surface, 'dsh', name)
      assert.equal(value.data.disclosure.audited, false, name)
    }
  }
})

test('disclosure is metadata only and content-addressed (same read = same callId)', async () => {
  const home = join(makeRoot('adv-dsh-disclosure-ids-'), 'home')
  seedRealLedger(home)
  const reader = createLedgerReader({ home })
  const first = (await reader.todayView()).data
  const second = (await reader.todayView()).data
  assert.equal(second.disclosure.callId, first.disclosure.callId)
  assert.equal(second.disclosure.digest, first.disclosure.digest)
  const text = JSON.stringify(first.disclosure)
  for (const needle of ['send the quote', 'cm_open', 'boss', 'ACME']) {
    assert.ok(!text.includes(needle), 'disclosure must not contain the value ' + needle)
  }
})
