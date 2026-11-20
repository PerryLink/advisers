import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { apply } from '../index.js'
import { ERROR_CODES } from '../lib/read.js'
import { SqliteStore } from '../../advisers/lib/sqlite.js'
import { seedAcceptedTos } from '../../advisers/test/tos-fixture.js'

// 0.3.2 M3: advisers_clients (customer list/show) through the read-only facade.
//
// Covers the real-ledger path (clearance 0, exact counts, no note bodies), the
// marked preview fallback (empty list; show -> CLIENT_NOT_FOUND), the JSON-store
// path (customerEntities:false, no invented rows), structured gate errors, the
// read-only side effects, and the tool schema/render contract.

const tempRoots = []
function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}
after(() => {
  for (const root of tempRoots) { try { rmSync(root, { recursive: true, force: true }) } catch {} }
})

const EMPTY_HOME = join(makeRoot('adv-dsh-clients-empty-'), 'home')
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
const NOTE_TEXT = '电话确认预算 8 万'
const CONVERSATION_TEXT = '客户说预算还没批'

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

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function dirSnapshot(home) {
  try { return readdirSync(home).sort() } catch { return [] }
}

const SEED = {
  secretAction: 'secret acquisition memo',
}

function seedCustomerLedger(home) {
  seedAcceptedTos(home)
  const createdAt = '2026-01-01T00:00:00.000Z'
  const store = new SqliteStore(join(home, 'state.db'))
  const seeded = {}
  try {
    store.mutate(() => {
      const client = store.addClient({ name: 'ACME', aliases: ['ACME Ltd'], tags: ['quote'], secrecyDefault: 0 })
      const secretClient = store.addClient({ name: 'Secret Target', secrecyDefault: 2 })
      const project = store.addProject({ clientId: client.id, name: 'Website relaunch' })
      store.insertMatter({ id: 'm_acme', title: 'ACME quote', status: 'active', domain: 'work', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt, updatedAt: createdAt })
      store.insertMatter({ id: 'm_secret', title: 'M&A target', status: 'active', domain: 'work', secrecy: 2, participants: [], deadlines: [], openQuestions: [], createdAt, updatedAt: createdAt })
      store.setMatterClient('m_acme', { clientId: client.id, projectId: project.id })
      store.setMatterClient('m_secret', { clientId: secretClient.id })
      store.insertCommitment({
        id: 'cm_acme', matterId: 'm_acme', debtor: 'user', creditor: 'ACME', action: 'send the quote',
        timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none',
        createdAt: '2026-01-02T00:00:00.000Z', dueAt: '2026-12-01T10:00:00+08:00',
      })
      store.insertCommitment({
        id: 'cm_secret', matterId: 'm_secret', debtor: 'user', creditor: 'ACME', action: SEED.secretAction,
        timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none',
        createdAt: '2026-01-03T00:00:00.000Z',
      })
      store.addDelivery({ matterId: 'm_acme', conversationId: 'conv-1', files: ['quote.pdf'], tool: 'deliver:quote', title: 'quote.pdf' })
      store.addClientNote({ clientId: client.id, summary: NOTE_TEXT, kind: 'call', at: '2026-01-05T00:00:00.000Z' })
      seeded.client = client
      seeded.secretClient = secretClient
      seeded.project = project
    }, { actor: 'test', action: 'seed', allowed: true, reason: 'fixture' })
    store.addTurn({ conversationId: 'conv-1', role: 'client', content: CONVERSATION_TEXT })
  } finally { store.close() }
  return { home, db: join(home, 'state.db'), ...seeded }
}

test('dsh clients: the bundle registers 6 tools and advisers_clients has a host-valid schema', () => {
  const { tools, byName } = mount()
  assert.equal(tools.length, 6)
  const tool = byName.get('advisers_clients')
  assert.ok(tool, 'advisers_clients must be registered')
  assert.doesNotThrow(() => assertSupportedJsonSchema(tool.parameters), 'parameters schema')
  assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema), 'output schema')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.deepEqual(tool.parameters.properties.action.enum, ['list', 'show'])
  assert.equal(tool.parameters.properties.id.type, 'string')
  assert.equal(tool.parameters.properties.limit.type, 'number')
  const success = tool.output.schema.oneOf.filter((branch) => branch.properties?.ok?.const === true)
  const failure = tool.output.schema.oneOf.filter((branch) => branch.properties?.ok?.const === false)
  assert.equal(success.length, 2, 'list and show have distinct success payloads')
  assert.equal(failure.length, 1)
  assert.equal(typeof tool.output.render, 'function')
})

test('dsh clients: no ledger -> marked preview list; show is CLIENT_NOT_FOUND, never fake data', async () => {
  const { byName } = mount()
  assert.equal(existsSync(EMPTY_HOME), false, 'fixture: the env home does not exist')
  const list = await execute(byName.get('advisers_clients'), { action: 'list' })
  assert.equal(list.value.ok, true)
  assert.equal(list.value.data.preview, true)
  assert.equal(list.value.data.source, 'preview-no-ledger')
  assert.equal(list.value.data.clients.length, 0)
  assert.equal(list.value.data.total, 0)
  assert.equal(list.value.data.customerEntities, false)
  assert.equal(list.value.data.clearance, 0)
  assert.equal(list.value.data.protectedExcluded, 0)
  assert.match(list.text, /^\[preview: no ledger\] clients: 0\/0 shown/)
  assert.equal(existsSync(EMPTY_HOME), false, 'a preview read must not create the home directory')

  const show = await execute(byName.get('advisers_clients'), { action: 'show', id: 'cl_preview' })
  assert.equal(show.value.ok, false)
  assert.equal(show.value.error.code, ERROR_CODES.CLIENT_NOT_FOUND)
  assert.match(show.value.error.message, /preview ledger/)
  assert.match(show.text, /^CLIENT_NOT_FOUND: /)
  assert.equal(existsSync(EMPTY_HOME), false)
})

test('dsh clients: real ledger list/show reads the read-only facade at clearance 0', async () => {
  const home = join(makeRoot('adv-dsh-clients-real-'), 'home')
  const seeded = seedCustomerLedger(home)
  const before = hashFile(seeded.db)
  const beforeEntries = dirSnapshot(home)
  const { byName } = mount({ home })
  const tool = byName.get('advisers_clients')

  const list = await execute(tool, { action: 'list' })
  assert.equal(list.value.ok, true, list.text)
  const data = list.value.data
  assert.equal(data.preview, false)
  assert.equal(data.source, 'ledger-readonly')
  assert.equal(data.backend, 'sqlite')
  assert.equal(data.customerEntities, true)
  assert.equal(data.clearance, 0)
  assert.equal(data.limit, 20)
  assert.equal(data.total, 2)
  assert.equal(data.clients.length, 2)
  const acme = data.clients.find((row) => row.id === seeded.client.id)
  assert.ok(acme, 'the visible client row is present')
  assert.equal(acme.counts.matters, 1)
  assert.equal(acme.counts.deliveries, 1)
  assert.equal(acme.counts.notes, 1)
  assert.equal(acme.counts.commitments, 1)
  assert.equal(acme.counts.openMine, 1)
  assert.equal(acme.counts.overdue, 0)
  assert.equal(acme.protectedExcluded, 0)
  const secretRow = data.clients.find((row) => row.id === seeded.secretClient.id)
  assert.equal(secretRow.counts.matters, 0, 'clearance 0 hides the secrecy=2 matter')
  assert.equal(secretRow.protectedExcluded, 1)
  assert.ok(!JSON.stringify(data).includes(NOTE_TEXT), 'the list projection carries no note body')
  assert.ok(!JSON.stringify(data).includes(SEED.secretAction), 'protected content must not leak')

  const show = await execute(tool, { action: 'show', id: seeded.client.id })
  assert.equal(show.value.ok, true, show.text)
  const view = show.value.data
  assert.equal(view.action, 'show')
  assert.equal(view.client.id, seeded.client.id)
  assert.equal(view.client.name, 'ACME')
  assert.equal('notes' in view.client, false, 'note bodies are not part of the identity')
  assert.equal(view.projects.length, 1)
  assert.equal(view.projects[0].id, seeded.project.id)
  assert.equal(view.projects[0].counts.matters, 1)
  assert.equal(view.counts.notes, 1)
  assert.equal(view.open.mine.length, 1)
  assert.deepEqual(view.timeline.map((item) => item.kind).sort(), ['commitment', 'delivery'])
  assert.equal(view.timelineTotal, 2)
  assert.equal(view.timelineTruncated, false)
  const serialized = JSON.stringify(view)
  assert.ok(!serialized.includes(NOTE_TEXT), 'the show projection carries no note body')
  assert.ok(!serialized.includes(CONVERSATION_TEXT), 'conversation text must never reach the payload')
  assert.ok(!serialized.includes(SEED.secretAction), 'protected content must not leak')
  assert.match(show.text, /^client ACME \(cl_/)

  const secretShow = await execute(tool, { action: 'show', id: seeded.secretClient.id })
  assert.equal(secretShow.value.ok, true)
  assert.equal(secretShow.value.data.counts.matters, 0)
  assert.equal(secretShow.value.data.protectedExcluded, 1)
  assert.deepEqual(secretShow.value.data.timeline, [])
  assert.ok(!JSON.stringify(secretShow.value).includes(SEED.secretAction))

  // Read-only: byte-identical database, no HOME writer lock, no extra files.
  assert.equal(hashFile(seeded.db), before, 'a client read must not modify state.db')
  assert.equal(existsSync(join(home, 'instance.lock')), false, 'a client read must not take the HOME write lock')
  const allowedNew = new Set(['state.db-wal', 'state.db-shm'])
  for (const entry of dirSnapshot(home)) {
    assert.ok(beforeEntries.includes(entry) || allowedNew.has(entry), 'unexpected file created by a read: ' + entry)
  }
})

test('dsh clients: unknown id and bad arguments map to stable structured errors', async () => {
  const home = join(makeRoot('adv-dsh-clients-args-'), 'home')
  seedCustomerLedger(home)
  const { byName } = mount({ home })
  const tool = byName.get('advisers_clients')

  const missing = await execute(tool, { action: 'show', id: 'cl_missing' })
  assert.equal(missing.value.ok, false)
  assert.equal(missing.value.error.code, ERROR_CODES.CLIENT_NOT_FOUND)
  assert.match(missing.value.error.hint, /advisers client list/)
  assert.match(missing.text, /^CLIENT_NOT_FOUND: /)

  // Host argument validation happens before execute (missing/enum/type).
  await assert.rejects(() => tool.execute({}, EXEC), /missing required property "action"/)
  await assert.rejects(() => tool.execute({ action: 'delete' }, EXEC), /must be one of/) 
  await assert.rejects(() => tool.execute({ action: 'list', limit: 'x' }, EXEC), /must be a number/)
  const noId = await execute(tool, { action: 'show' })
  assert.equal(noId.value.error.code, ERROR_CODES.INVALID_ARGUMENT)
  for (const limit of [0, 51]) {
    const bad = await execute(tool, { action: 'list', limit })
    assert.equal(bad.value.error.code, ERROR_CODES.INVALID_ARGUMENT, 'limit ' + String(limit))
  }
})

test('dsh clients: legacy JSON store has no customer tables -> empty list marked customerEntities:false', async () => {
  const home = join(makeRoot('adv-dsh-clients-json-'), 'home')
  mkdirSync(home, { recursive: true })
  seedAcceptedTos(home)
  const state = {
    version: 1,
    matters: [],
    commitments: [],
    facts: [],
    preferences: [],
    links: [],
    updates: [],
    routines: [],
    routinePatches: [],
    routes: {},
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const stateHash = hashFile(join(home, 'state.json'))
  process.env.ADVISERS_STORE = 'json'
  try {
    const { byName } = mount({ home })
    const tool = byName.get('advisers_clients')
    const list = await execute(tool, { action: 'list' })
    assert.equal(list.value.ok, true, list.text)
    assert.equal(list.value.data.backend, 'json')
    assert.equal(list.value.data.preview, false)
    assert.equal(list.value.data.source, 'ledger-readonly')
    assert.equal(list.value.data.customerEntities, false)
    assert.deepEqual(list.value.data.clients, [])
    assert.equal(list.value.data.total, 0)
    assert.match(list.value.data.note, /JSON ledger/)
    assert.match(list.text, /no customer tables/)

    const show = await execute(tool, { action: 'show', id: 'cl_json' })
    assert.equal(show.value.ok, false)
    assert.equal(show.value.error.code, ERROR_CODES.CLIENT_NOT_FOUND)
    assert.match(show.value.error.hint, /ADVISERS_STORE=sqlite/)
  } finally {
    delete process.env.ADVISERS_STORE
  }
  assert.equal(hashFile(join(home, 'state.json')), stateHash, 'a JSON read must not modify state.json')
})

test('dsh clients: TOS and vault gates are structured errors, not preview or empty data', async () => {
  const noTosHome = join(makeRoot('adv-dsh-clients-tos-'), 'home')
  mkdirSync(noTosHome, { recursive: true })
  // A real ledger without a TOS acceptance record: the gate, not preview, wins.
  const bare = new SqliteStore(join(noTosHome, 'state.db'))
  bare.close()
  const noTos = mount({ home: noTosHome })
  const blocked = await execute(noTos.byName.get('advisers_clients'), { action: 'list' })
  assert.equal(blocked.value.ok, false)
  assert.equal(blocked.value.error.code, ERROR_CODES.LEDGER_TOS_REQUIRED)
  assert.equal(blocked.value.data, undefined)
  assert.match(blocked.text, /^LEDGER_TOS_REQUIRED: /)

  const sealedHome = join(makeRoot('adv-dsh-clients-vault-'), 'home')
  seedAcceptedTos(sealedHome)
  writeFileSync(join(sealedHome, 'state.db.vault'), 'sealed')
  const sealed = mount({ home: sealedHome })
  const sealedResult = await execute(sealed.byName.get('advisers_clients'), { action: 'list' })
  assert.equal(sealedResult.value.ok, false)
  assert.equal(sealedResult.value.error.code, ERROR_CODES.LEDGER_VAULT_SEALED)
  assert.equal(sealedResult.value.data, undefined)
})

test('dsh clients: description and render disclose the real ledger, preview and read-only promise', () => {
  const { byName } = mount()
  const description = byName.get('advisers_clients').description
  assert.match(description, /read-only/i)
  assert.match(description, /~\/\.advisers\/state\.db/)
  assert.match(description, /preview/i)
  assert.match(description, /real local Advisers ledger/)
  assert.match(description, /clearance 0/i)
  assert.match(description, /note bodies/i)
  assert.match(description, /customerEntities:false/)
  assert.match(description, /never sends a message|Never writes the ledger/i)
  // The other four ledger-independent tools keep their own descriptions.
  assert.doesNotMatch(byName.get('advisers_brief').description, /preview/i)
  assert.doesNotMatch(byName.get('advisers_office').description, /preview/i)
})
