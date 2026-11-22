import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SqliteStore } from '../lib/sqlite.js'
import {
  MCP_OUTPUT_LIMITS,
  RESOURCE_URIS,
  TOOL_NAMES,
  createMcpServer,
} from '../lib/mcp-server.js'

// 0.3.2 M3: read-only customer projection over the MCP surface.
//
// The tool must never expose note bodies or conversation text, must filter
// secrecy BEFORE counting/paging, must cap list pages, and must degrade to a
// structured ToolError (never a crash, never fake rows) when the customer
// tables are unavailable (JSON store / embedder store without the customer API).

const NOW = () => new Date('2026-11-20T03:00:00.000Z')
const NOTE_TEXT = '电话确认预算 8 万，下周给方案'
const CONVERSATION_TEXT = '客户说预算还没批'

function fixture({ clearance = 0, extraClients = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-mcp-clients-'))
  const store = new SqliteStore(join(root, 'state.db'))
  const at = '2026-01-01T00:00:00.000Z'
  store.mutate(() => {
    const matter = (id, title, secrecy) => store.insertMatter({
      id, title, status: 'active', domain: 'work', secrecy,
      participants: [], deadlines: [], openQuestions: [], createdAt: at, updatedAt: at,
    })
    const commitment = (id, matterId, action, extra = {}) => store.insertCommitment({
      id, matterId, debtor: 'user', creditor: 'ACME', action, timezone: 'Asia/Shanghai',
      status: 'open', evidence: [], capability: 'none', createdAt: at, ...extra,
    })
    matter('m_acme', 'ACME quote', 0)
    matter('m_secret', 'secret acquisition', 2)
    matter('m_level1', 'level one matter', 0)
    commitment('cm_acme', 'm_acme', 'send the quote', { createdAt: '2026-01-02T00:00:00.000Z', dueAt: '2026-12-01T10:00:00+08:00' })
    commitment('cm_secret', 'm_secret', 'draft the secret acquisition memo', { createdAt: '2026-01-03T00:00:00.000Z' })
    commitment('cm_level1', 'm_level1', 'level one follow up', { createdAt: '2026-01-04T00:00:00.000Z' })
  })
  const acme = store.addClient({ name: 'ACME', aliases: ['ACME Ltd'], tags: ['quote'], secrecyDefault: 0 })
  const secret = store.addClient({ name: 'Secret Target', secrecyDefault: 2 })
  const level1 = store.addClient({ name: 'Level One', secrecyDefault: 1 })
  const archived = store.addClient({ name: 'Old Client' })
  store.archiveClient(archived.id)
  const project = store.addProject({ clientId: acme.id, name: 'Website relaunch' })
  store.setMatterClient('m_acme', { clientId: acme.id, projectId: project.id })
  store.setMatterClient('m_secret', { clientId: secret.id })
  store.setMatterClient('m_level1', { clientId: level1.id })
  store.addDelivery({ matterId: 'm_acme', conversationId: 'conv-1', files: ['quote.pdf'], tool: 'deliver:quote', title: 'quote.pdf' })
  store.addClientNote({ clientId: acme.id, summary: NOTE_TEXT, kind: 'call', at: '2026-01-05T00:00:00.000Z' })
  store.addTurn({ conversationId: 'conv-1', role: 'client', content: CONVERSATION_TEXT })
  for (let index = 0; index < extraClients; index += 1) {
    store.addClient({ name: 'Extra ' + String(index).padStart(3, '0') })
  }
  const audits = []
  const server = createMcpServer({
    store,
    version: '0.3.2-test',
    clearance,
    now: NOW,
    audit: (entry) => { audits.push(entry) },
  })
  const call = (method, params, id = 1) => server.handle({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
  const callTool = async (name, args, id = 1) => {
    const response = await call('tools/call', { name, arguments: args }, id)
    const text = response.result?.content?.[0]?.text
    let data
    try { data = text === undefined ? undefined : JSON.parse(text) } catch { data = undefined }
    return { response, isError: response.result?.isError === true, text, data }
  }
  const cleanup = () => {
    try { store.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
  return { root, store, acme, secret, level1, archived, project, audits, server, call, callTool, cleanup }
}

test('mcp clients: tools/list and resources/list advertise the read-only customer surface', async () => {
  const f = fixture()
  try {
    const list = await f.call('tools/list')
    assert.deepEqual(list.result.tools.map((tool) => tool.name), [...TOOL_NAMES])
    assert.equal(list.result.tools.length, 8)
    const clients = list.result.tools.find((tool) => tool.name === 'advisers_clients')
    assert.ok(clients, 'advisers_clients must be advertised')
    assert.equal(clients.annotations.readOnlyHint, true)
    assert.equal(clients.annotations.destructiveHint, false)
    assert.equal(clients.inputSchema.type, 'object')
    assert.deepEqual(clients.inputSchema.required, ['action'])
    assert.deepEqual(clients.inputSchema.properties.action.enum, ['list', 'show'])
    assert.equal(clients.inputSchema.properties.limit.maximum, MCP_OUTPUT_LIMITS.clientsMax)
    assert.equal(clients.inputSchema.properties.timelineLimit.maximum, MCP_OUTPUT_LIMITS.clientTimelineMax)
    assert.match(clients.description, /customer/i)
    assert.match(clients.description, /never returned/i)

    const resources = await f.call('resources/list')
    assert.deepEqual(resources.result.resources.map((entry) => entry.uri), [...RESOURCE_URIS])
    assert.equal(resources.result.resources.length, 5)
    assert.ok(resources.result.resources.find((entry) => entry.uri === 'advisers://clients'))
  } finally { f.cleanup() }
})

test('mcp clients: list filters secrecy before counting and reports clearance/protectedExcluded', async () => {
  const f = fixture()
  try {
    const list = await f.callTool('advisers_clients', { action: 'list' })
    assert.equal(list.isError, false, list.text)
    assert.equal(list.data.clearance, 0)
    assert.equal(list.data.total, 3, 'three active clients')
    assert.equal(list.data.truncated, false)
    assert.equal(list.data.limit, MCP_OUTPUT_LIMITS.clients)
    assert.deepEqual(list.data.clients.map((row) => row.name), ['ACME', 'Level One', 'Secret Target'])

    const acme = list.data.clients.find((row) => row.id === f.acme.id)
    assert.equal(acme.counts.matters, 1)
    assert.equal(acme.counts.deliveries, 1)
    assert.equal(acme.counts.notes, 1)
    assert.equal(acme.counts.commitments, 1)
    assert.equal(acme.counts.openMine, 1)
    assert.equal(acme.counts.openWaiting, 0)
    assert.equal(acme.counts.overdue, 0)
    assert.equal(acme.nextDueAt, '2026-12-01T10:00:00.000+08:00')
    assert.equal(acme.clearance, 0)
    assert.equal(acme.protectedExcluded, 0)

    const secret = list.data.clients.find((row) => row.id === f.secret.id)
    assert.equal(secret.counts.matters, 0, 'the secret=2 matter is above clearance 0')
    assert.equal(secret.counts.commitments, 0)
    assert.equal(secret.protectedExcluded, 1)
    assert.ok(!JSON.stringify(list.data).includes('secret acquisition'), 'protected matter content must not leak')

    const level1 = list.data.clients.find((row) => row.id === f.level1.id)
    assert.equal(level1.counts.matters, 0)
    assert.equal(level1.protectedExcluded, 1)

    // The same store at clearance 1 keeps the default-2 client protected but
    // reveals the default-1 client: the gate is max(client default, matter).
    const higher = createMcpServer({ store: f.store, version: '0.3.2-test', clearance: 1, now: NOW })
    const response = await higher.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'advisers_clients', arguments: { action: 'list' } } })
    const data = JSON.parse(response.result.content[0].text)
    assert.equal(data.clearance, 1)
    const level1AtOne = data.clients.find((row) => row.id === f.level1.id)
    assert.equal(level1AtOne.counts.matters, 1)
    assert.equal(level1AtOne.protectedExcluded, 0)
    const secretAtOne = data.clients.find((row) => row.id === f.secret.id)
    assert.equal(secretAtOne.counts.matters, 0)
    assert.equal(secretAtOne.protectedExcluded, 1)
  } finally { f.cleanup() }
})

test('mcp clients: all/limit/total/truncated contract and input validation', async () => {
  const f = fixture()
  try {
    const all = await f.callTool('advisers_clients', { action: 'list', all: true })
    assert.equal(all.data.total, 4, 'all=true includes the archived client')
    assert.ok(all.data.clients.find((row) => row.id === f.archived.id && row.status === 'archived'))

    const capped = await f.callTool('advisers_clients', { action: 'list', limit: 2 })
    assert.equal(capped.data.clients.length, 2)
    assert.equal(capped.data.total, 3)
    assert.equal(capped.data.limit, 2)
    assert.equal(capped.data.truncated, true)

    const tooLarge = await f.call('tools/call', { name: 'advisers_clients', arguments: { action: 'list', limit: 51 } }, 7)
    assert.equal(tooLarge.error.code, -32602)
    const noAction = await f.call('tools/call', { name: 'advisers_clients', arguments: {} }, 8)
    assert.equal(noAction.error.code, -32602)
    const badAction = await f.call('tools/call', { name: 'advisers_clients', arguments: { action: 'delete' } }, 9)
    assert.equal(badAction.error.code, -32602)
  } finally { f.cleanup() }
})

test('mcp clients: show returns identity, projects, counts, open items and a delivery/commitment timeline only', async () => {
  const f = fixture()
  try {
    const show = await f.callTool('advisers_clients', { action: 'show', id: f.acme.id })
    assert.equal(show.isError, false, show.text)
    const data = show.data
    assert.equal(data.client.id, f.acme.id)
    assert.equal(data.client.name, 'ACME')
    assert.equal('notes' in data.client, false, 'note bodies are not part of the identity')
    assert.equal(data.client.secrecyDefault, 0)
    assert.equal(data.projects.length, 1)
    assert.equal(data.projects[0].id, f.project.id)
    assert.equal(data.projects[0].counts.matters, 1)
    assert.equal(data.counts.matters, 1)
    assert.equal(data.counts.deliveries, 1)
    assert.equal(data.counts.notes, 1)
    assert.equal(data.counts.commitments, 1)
    assert.equal(data.open.mine.length, 1)
    assert.equal(data.open.mine[0].id, 'cm_acme')
    assert.equal(data.open.mineTotal, 1)
    assert.equal(data.open.waitingTotal, 0)
    assert.equal(data.nextDueAt, '2026-12-01T10:00:00.000+08:00')
    assert.deepEqual(data.timeline.map((item) => item.kind).sort(), ['commitment', 'delivery'])
    for (const item of data.timeline) {
      assert.equal(typeof item.at, 'string')
      assert.equal(typeof item.title, 'string')
      assert.deepEqual(Object.keys(item.ref).sort(), ['id', 'kind'])
      assert.equal(item.ref.kind, item.kind)
      assert.equal(item.matterId, 'm_acme')
      assert.equal(typeof item.secrecy, 'number')
    }
    // Delivery > commitment when both are present (frozen order for the same instant).
    assert.equal(data.timeline[0].kind, 'delivery')
    assert.equal(data.timelineTotal, 2)
    assert.equal(data.timelineTruncated, false)
    assert.equal(data.clearance, 0)
    assert.equal(data.protectedExcluded, 0, 'this client has no protected matter')

    const serialized = JSON.stringify(data)
    assert.ok(!serialized.includes(NOTE_TEXT), 'note body must never reach the wire')
    assert.ok(!serialized.includes(CONVERSATION_TEXT), 'conversation text must never reach the wire')

    const limited = await f.callTool('advisers_clients', { action: 'show', id: f.acme.id, timelineLimit: 1 })
    assert.equal(limited.data.timeline.length, 1)
    assert.equal(limited.data.timelineTotal, 2)
    assert.equal(limited.data.timelineTruncated, true)

    const secretShow = await f.callTool('advisers_clients', { action: 'show', id: f.secret.id })
    assert.equal(secretShow.isError, false)
    assert.equal(secretShow.data.counts.matters, 0)
    assert.equal(secretShow.data.protectedExcluded, 1)
    assert.deepEqual(secretShow.data.timeline, [])
    assert.ok(!JSON.stringify(secretShow.data).includes('secret acquisition'))
  } finally { f.cleanup() }
})

test('mcp clients: unknown client is a structured tool error without echoing the id', async () => {
  const f = fixture()
  try {
    const missing = await f.callTool('advisers_clients', { action: 'show', id: 'cl_do_not_echo_me' })
    assert.equal(missing.isError, true)
    assert.equal(missing.response.error, undefined, 'a tool failure is not a JSON-RPC protocol error')
    assert.match(missing.text, /unknown client id/)
    assert.ok(!missing.text.includes('cl_do_not_echo_me'), 'the raw id must not be echoed')
  } finally { f.cleanup() }
})

test('mcp clients: missing customer tables (JSON store) return a structured ToolError, never a crash', async () => {
  const server = createMcpServer({ version: '0.3.2-test', audit: () => {} })
  const list = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'advisers_clients', arguments: { action: 'list' } } })
  assert.equal(list.result.isError, true)
  assert.match(list.result.content[0].text, /SQLite/)
  const show = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'advisers_clients', arguments: { action: 'show', id: 'cl_x' } } })
  assert.equal(show.result.isError, true)
  assert.match(show.result.content[0].text, /SQLite/)
  const tools = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  assert.equal(tools.result.tools.length, 8, 'the server still answers after a customer-data error')
})

test('mcp clients: list pages stay bounded (limit <= 50; the 64 KiB last-resort budget trims)', async () => {
  const f = fixture({ extraClients: 60 })
  try {
    const declared = await f.callTool('advisers_clients', { action: 'list', limit: 50 })
    assert.equal(declared.data.clients.length, 50)
    assert.equal(declared.data.total, 63)
    assert.equal(declared.data.limit, 50)
    assert.equal(declared.data.truncated, true)

    // Big aliases push the serialized payload past 64 KiB; boundPayload trims the
    // clients list and marks truncated instead of letting the egress classifier
    // fail closed.
    const big = 'x'.repeat(200)
    for (let index = 0; index < 6; index += 1) {
      const aliases = Array.from({ length: 100 }, (_, entry) => big.slice(0, 180) + 'c' + index + '-' + String(entry).padStart(3, '0'))
      f.store.addClient({ name: 'Big ' + index, aliases })
    }
    const bounded = await f.callTool('advisers_clients', { action: 'list', limit: 50 })
    assert.equal(bounded.isError, false, bounded.text)
    assert.equal(bounded.data.truncated, true)
    assert.ok(bounded.data.clients.length < bounded.data.total)
    assert.ok(JSON.stringify(bounded.data).length <= 64 * 1024 + 2048)
  } finally { f.cleanup() }
})

test('mcp clients: advisers://clients resource reads the same bounded list model and is audited', async () => {
  const f = fixture()
  try {
    const response = await f.call('resources/read', { uri: 'advisers://clients' }, 11)
    const payload = JSON.parse(response.result.contents[0].text)
    assert.equal(payload.clients.length, 3)
    assert.equal(payload.total, 3)
    assert.equal(payload.limit, MCP_OUTPUT_LIMITS.clients)
    assert.equal(payload.clearance, 0)
    assert.equal(payload.truncated, false)
    assert.equal(payload.disclosure.surface, 'mcp')
    assert.equal(payload.disclosure.tool, 'advisers://clients')
    assert.equal(payload.disclosure.view.derived, payload.clients.length)
    assert.equal(payload.disclosure.audited, true)
    const audit = f.audits.find((entry) => entry.reason.startsWith('resource:advisers://clients callId=dc_'))
    assert.ok(audit, 'a resource read must be audited')
    assert.equal(audit.actor, 'mcp')
    assert.equal(audit.action, 'mcp.call')
    assert.equal(audit.allowed, true)
  } finally { f.cleanup() }
})

test('mcp clients: every client call is audited and responses frame as one JSON line', async () => {
  const f = fixture()
  try {
    await f.callTool('advisers_clients', { action: 'list' }, 21)
    await f.callTool('advisers_clients', { action: 'show', id: 'cl_missing' }, 22)
    const ok = f.audits.find((entry) => entry.reason.startsWith('advisers_clients callId=dc_') && entry.allowed === true)
    assert.ok(ok, 'a successful customer read must be audited')
    assert.equal(ok.actor, 'mcp')
    assert.equal(ok.action, 'mcp.call')
    const denied = f.audits.find((entry) => entry.reason === 'advisers_clients' && entry.allowed === false)
    assert.ok(denied, 'a failed customer read must be audited too')

    const line = JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'advisers_clients', arguments: { action: 'list' } } })
    const response = await f.server.handleLine(line)
    const serialized = JSON.stringify(response)
    assert.equal(serialized.includes(String.fromCharCode(10)), false, 'the response must be one JSON line')
    assert.equal(JSON.parse(serialized).jsonrpc, '2.0')
  } finally { f.cleanup() }
})
