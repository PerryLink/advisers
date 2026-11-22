/**
 * 0.5.0 M1: MCP read disclosure/view (additive) contract.
 *
 * Pins:
 * - the five read tools and five resources add row-level `view` + one
 *   `disclosure` block; the catalogue, the two write tools, errors and the
 *   remind payload keep their old bytes;
 * - legacy and modern era payload bytes stay identical;
 * - the single mcp.call audit reason carries callId/view counts/clearance/
 *   fields/digest and never record values;
 * - disclosure is content-addressed metadata (same read shape -> same callId);
 * - audited=false + warning when this process has no audit sink.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'
import {
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  RESOURCE_URIS,
  TOOL_NAMES,
  createMcpServer,
} from '../lib/mcp-server.js'

const NOW = () => new Date('2026-11-22T03:00:00.000Z')
const MODERN_META = Object.freeze({ [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION, [META_CLIENT_CAPABILITIES]: {} })
const READ_TOOLS = ['advisers_today', 'advisers_commit_ls', 'advisers_who', 'advisers_evidence', 'advisers_clients']

function fixture({ auditSink = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-mcp-disclosure-'))
  const store = new SqliteStore(join(root, 'state.db'))
  const ledger = new Ledger()
  const publicMatter = ledger.addMatter({ title: '公开项目', secrecy: 0 })
  const secretMatter = ledger.addMatter({ title: '机密项目', secrecy: 2 })
  const turn = store.addTurn({ conversationId: 'conv-1', role: 'user', content: '周五前把报价发给王工' })
  const verified = ledger.addCommitment({
    matterId: publicMatter.id,
    debtor: 'user',
    creditor: '王工',
    action: '发送报价单',
    dueAt: '2026-12-01T10:00:00+08:00',
    evidence: [{ sessionId: 'conv-1', turnId: turn.id, quote: '周五前把报价发给王工' }],
  })
  const manual = ledger.addCommitment({
    matterId: publicMatter.id,
    debtor: 'user',
    creditor: '王工',
    action: '手工条目',
    dueAt: '2026-12-02T10:00:00+08:00',
    evidence: [{ quote: 'operator entry' }],
  })
  const done = ledger.addCommitment({
    matterId: publicMatter.id,
    debtor: 'user',
    creditor: '王工',
    action: '已完成承诺',
    dueAt: '2026-12-03T10:00:00+08:00',
    evidence: [{ quote: 'operator entry' }],
  })
  ledger.completeCommitment(done.id, [{ sessionId: 'conv-1', turnId: turn.id, quote: '已完成承诺' }])
  ledger.addCommitment({
    matterId: secretMatter.id,
    debtor: 'user',
    creditor: '某人',
    action: '机密承诺',
    dueAt: '2026-12-04T10:00:00+08:00',
    evidence: [{ quote: 'operator entry' }],
  })
  const client = store.addClient({ name: 'ACME', tags: ['quote'], secrecyDefault: 0 })
  const audits = []
  const server = createMcpServer({
    store,
    ledger,
    version: '0.5.0-test',
    now: NOW,
    ...(auditSink ? { audit: (entry) => { audits.push(entry) } } : {}),
  })
  const call = (method, params, id = 1) => server.handle({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
  const malformed = (text) => server.handleLine(text)
  const callTool = async (name, args = {}, id = 1) => {
    const response = await call('tools/call', { name, arguments: args }, id)
    const text = response.result?.content?.[0]?.text
    let data
    try { data = text === undefined ? undefined : JSON.parse(text) } catch { data = undefined }
    return { response, data, text, isError: response.result?.isError === true }
  }
  const readResource = async (uri, id = 1) => {
    const response = await call('resources/read', { uri }, id)
    return JSON.parse(response.result.contents[0].text)
  }
  const modernTool = async (name, args = {}, id = 1) => {
    const response = await call('tools/call', { name, arguments: args, _meta: MODERN_META }, id)
    return response.result.content[0].text
  }
  const cleanup = () => {
    try { store.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
  return { store, ledger, client, verified, manual, done, audits, server, call, callTool, readResource, modernTool, malformed, cleanup }
}

function stripAdditive(value) {
  const copy = JSON.parse(JSON.stringify(value))
  delete copy.disclosure
  for (const key of ['commitments', 'mine', 'waiting', 'clients', 'timeline']) {
    if (Array.isArray(copy[key])) for (const row of copy[key]) if (row && typeof row === 'object') delete row.view
  }
  for (const key of ['commitment', 'fact', 'preference', 'client']) {
    if (copy[key] && typeof copy[key] === 'object' && !Array.isArray(copy[key])) delete copy[key].view
  }
  return copy
}

test('catalogue and write tools keep their 0.4.3 bytes; only read payloads are additive', async () => {
  const f = fixture()
  try {
    const tools = (await f.call('tools/list')).result.tools
    assert.deepEqual(tools.map((tool) => tool.name), [...TOOL_NAMES])
    assert.equal(tools.length, 8)
    assert.deepEqual((await f.call('resources/list')).result.resources.map((row) => row.uri), [...RESOURCE_URIS])
    assert.ok(!JSON.stringify(tools).includes('disclosure'))

    // Both write tools keep their exact old payload shape (no disclosure/view).
    const capture = await f.callTool('advisers_capture_candidate', { action: '记一个候选', quote: '记一个候选' })
    assert.deepEqual(Object.keys(capture.data), ['ok', 'candidate', 'note'])
    assert.deepEqual(Object.keys(capture.data.candidate), ['id', 'kind', 'status'])

    const pack = await f.callTool('advisers_pack_verify', { dir: join(tmpdir(), 'no-such-pack') })
    assert.equal(pack.isError, true)

    // The reminder payload is deliberately unchanged (5 read tools only).
    const remind = await f.callTool('advisers_remind', {})
    assert.deepEqual(Object.keys(remind.data), ['reminders', 'clearance', 'protectedExcluded', 'total', 'truncated'])
  } finally { f.cleanup() }
})

test('today: row views + disclosure describe exactly the returned rows (clearance-aware)', async () => {
  const f = fixture()
  try {
    const { data } = await f.callTool('advisers_today', {})
    const byId = new Map(data.commitments.map((row) => [row.id, row]))
    assert.equal(byId.get(f.verified.id).view, 'verified')
    assert.equal(byId.get(f.manual.id).view, 'pending')
    assert.equal(byId.has(f.done.id), false, 'done rows are not open commitments')
    assert.equal(data.protectedExcluded, 1, 'the secrecy=2 matter row is counted, never returned')
    assert.ok(!JSON.stringify(data).includes('机密承诺'))

    const disclosure = data.disclosure
    assert.equal(disclosure.surface, 'mcp')
    assert.equal(disclosure.tool, 'advisers_today')
    assert.equal(disclosure.basis, 'local-resolution')
    assert.equal(disclosure.audited, true)
    assert.equal(disclosure.clearance, 0)
    assert.equal(disclosure.protectedExcluded, 1)
    assert.equal(disclosure.truncated, false)
    assert.deepEqual(disclosure.view, { verified: 1, pending: 1, historical: 0, derived: 0 })
    assert.deepEqual(disclosure.fields, ['action', 'creditor', 'debtor', 'dueAt', 'id'].sort())
    assert.match(disclosure.callId, /^dc_[0-9a-f]{16}$/)
    assert.match(disclosure.digest, /^sha256:[0-9a-f]{64}$/)
    assert.ok(disclosure.callId.startsWith('dc_' + disclosure.digest.slice(7, 23)))

    // Old fields/values/order unchanged; `view` is the only row addition.
    assert.deepEqual(Object.keys(data), ['open', 'commitments', 'clearance', 'protectedExcluded', 'total', 'truncated', 'disclosure'])
    assert.deepEqual(Object.keys(data.commitments[0]), ['id', 'debtor', 'creditor', 'action', 'dueAt', 'view'])
    assert.deepEqual(stripAdditive(data), { open: 2, commitments: [{ id: f.verified.id, debtor: 'user', creditor: '王工', action: '发送报价单', dueAt: '2026-12-01T10:00:00+08:00' }, { id: f.manual.id, debtor: 'user', creditor: '王工', action: '手工条目', dueAt: '2026-12-02T10:00:00+08:00' }], clearance: 0, protectedExcluded: 1, total: 2, truncated: false })
  } finally { f.cleanup() }
})

test('commit_ls/who/evidence: view mapping and disclosure counts', async () => {
  const f = fixture()
  try {
    const all = (await f.callTool('advisers_commit_ls', { all: true })).data
    const views = new Map(all.commitments.map((row) => [row.id, row.view]))
    assert.equal(views.get(f.verified.id), 'verified')
    assert.equal(views.get(f.manual.id), 'pending')
    assert.equal(views.get(f.done.id), 'historical')
    assert.deepEqual(all.disclosure.view, { verified: 1, pending: 1, historical: 1, derived: 0 })

    const who = (await f.callTool('advisers_who', {})).data
    assert.deepEqual(who.mine.map((row) => row.view), ['verified', 'pending'])
    assert.equal(who.disclosure.tool, 'advisers_who')
    assert.deepEqual(who.disclosure.view, { verified: 1, pending: 1, historical: 0, derived: 0 })
    assert.ok(who.disclosure.fields.includes('evidence'), 'who returns full commitment rows')

    const evidence = (await f.callTool('advisers_evidence', { id: f.verified.id })).data
    assert.equal(evidence.commitment.view, 'verified')
    assert.equal(evidence.disclosure.tool, 'advisers_evidence')
    assert.deepEqual(evidence.disclosure.view, { verified: 1, pending: 0, historical: 0, derived: 0 })
    assert.ok(evidence.disclosure.fields.includes('action'))

    const doneEvidence = (await f.callTool('advisers_evidence', { id: f.done.id })).data
    assert.equal(doneEvidence.commitment.view, 'historical')
    const missing = await f.callTool('advisers_evidence', { id: 'cm_does_not_exist' })
    assert.equal(missing.isError, false)
    assert.equal(missing.data.commitment, undefined)
    assert.deepEqual(missing.data.disclosure.view, { verified: 0, pending: 0, historical: 0, derived: 0 })
    assert.deepEqual(missing.data.disclosure.fields, [])
  } finally { f.cleanup() }
})

test('clients: derived row views and disclosure; note/body text never appears', async () => {
  const f = fixture()
  try {
    const list = (await f.callTool('advisers_clients', { action: 'list' })).data
    assert.equal(list.clients.length, 1)
    assert.equal(list.clients[0].view, 'derived')
    assert.equal(list.disclosure.tool, 'advisers_clients')
    assert.deepEqual(list.disclosure.view, { verified: 0, pending: 0, historical: 0, derived: 1 })
    assert.equal(list.disclosure.audited, true)

    const show = (await f.callTool('advisers_clients', { action: 'show', id: f.client.id })).data
    assert.equal(show.client.view, 'derived')
    assert.deepEqual(show.disclosure.view, { verified: 0, pending: 0, historical: 0, derived: 1 })
  } finally { f.cleanup() }
})

test('all five resources carry the same additive disclosure (tool = the resource uri)', async () => {
  const f = fixture()
  try {
    for (const uri of RESOURCE_URIS) {
      const payload = await f.readResource(uri)
      assert.ok(payload.disclosure, uri + ' must carry a disclosure')
      assert.equal(payload.disclosure.surface, 'mcp', uri)
      assert.equal(payload.disclosure.tool, uri, uri)
      assert.equal(payload.disclosure.audited, true, uri)
      assert.match(payload.disclosure.callId, /^dc_[0-9a-f]{16}$/, uri)
    }
    const clients = await f.readResource('advisers://clients')
    assert.equal(clients.clients[0].view, 'derived')
    const evidence = await f.readResource('advisers://evidence')
    assert.ok(evidence.commitments.every((row) => ['verified', 'pending'].includes(row.view)))
  } finally { f.cleanup() }
})

test('the single mcp.call audit row carries disclosure metadata only, never values', async () => {
  const f = fixture()
  try {
    await f.callTool('advisers_today', {})
    const todayAudit = f.audits.find((entry) => entry.action === 'mcp.call' && entry.reason.startsWith('advisers_today '))
    assert.ok(todayAudit, 'a successful read must be audited')
    assert.equal(todayAudit.actor, 'mcp')
    assert.equal(todayAudit.allowed, true)
    assert.match(todayAudit.reason, /^advisers_today callId=dc_[0-9a-f]{16} view=verified:1,pending:1,historical:0,derived:0 clearance=0 fields=action,creditor,debtor,dueAt,id digest=sha256:[0-9a-f]{64}$/)
    for (const needle of ['王工', '发送报价单', '手工条目', f.verified.id]) {
      assert.ok(!todayAudit.reason.includes(needle), 'audit reason must not contain ' + needle)
    }

    await f.readResource('advisers://today')
    const resourceAudit = f.audits.find((entry) => entry.reason.startsWith('resource:advisers://today '))
    assert.ok(resourceAudit, 'a resource read must be audited')
    assert.equal(resourceAudit.action, 'mcp.call')
    assert.match(resourceAudit.reason, /^resource:advisers:\/\/today callId=dc_/)

    // A failed read keeps its old reason (no disclosure was returned).
    await f.callTool('advisers_evidence', { id: 'zzz' })
    const failed = f.audits.find((entry) => entry.reason === 'advisers_evidence' && entry.allowed === false)
    assert.ok(failed, 'a failed read is still audited with the legacy reason')
  } finally { f.cleanup() }
})

test('no audit sink: disclosure says audited=false with a warning (read still succeeds)', async () => {
  const f = fixture({ auditSink: false })
  try {
    const { data } = await f.callTool('advisers_today', {})
    assert.equal(data.disclosure.audited, false)
    assert.match(data.disclosure.warning, /tamper-evident/)
    assert.match(data.disclosure.callId, /^dc_[0-9a-f]{16}$/, 'ids do not depend on the audit outcome')
  } finally { f.cleanup() }
})

test('disclosure ids are content-addressed: the same read shape yields the same callId', async () => {
  const f = fixture()
  try {
    const first = (await f.callTool('advisers_today', {}, 1)).data
    const second = (await f.callTool('advisers_today', {}, 2)).data
    assert.equal(second.disclosure.callId, first.disclosure.callId)
    assert.equal(second.disclosure.digest, first.disclosure.digest)
    const all = (await f.callTool('advisers_commit_ls', { all: true }, 3)).data
    assert.notEqual(all.disclosure.callId, first.disclosure.callId, 'a different row set is a different disclosure')
  } finally { f.cleanup() }
})

test('legacy and modern era read payloads stay byte-identical (disclosure included)', async () => {
  const f = fixture()
  try {
    for (const [name, args] of [
      ['advisers_today', {}],
      ['advisers_commit_ls', { all: true }],
      ['advisers_who', {}],
      ['advisers_evidence', { id: f.verified.id }],
      ['advisers_clients', { action: 'list' }],
    ]) {
      const legacy = (await f.callTool(name, args)).data
      const modernText = await f.modernTool(name, args)
      assert.equal(modernText, JSON.stringify(legacy, null, 2), name + ' modern/legacy bytes')
      assert.ok(modernText.includes('disclosure'), name + ' must carry the disclosure in both eras')
    }
    for (const uri of RESOURCE_URIS) {
      const legacyResponse = await f.call('resources/read', { uri })
      const modernResponse = await f.call('resources/read', { uri, _meta: MODERN_META })
      assert.equal(modernResponse.result.contents[0].text, legacyResponse.result.contents[0].text, uri + ' modern/legacy bytes')
    }
  } finally { f.cleanup() }
})

test('the disclosure block itself never embeds record values, quotes or paths', async () => {
  const f = fixture()
  try {
    for (const [name, args] of [
      ['advisers_today', {}],
      ['advisers_commit_ls', { all: true }],
      ['advisers_who', {}],
      ['advisers_evidence', { id: f.verified.id }],
      ['advisers_clients', { action: 'list' }],
    ]) {
      const text = JSON.stringify((await f.callTool(name, args)).data.disclosure)
      for (const needle of ['王工', '发送报价单', '手工条目', '机密', 'cm_', 'pref_', 'fact_', 'ACME']) {
        assert.ok(!text.includes(needle), name + ' disclosure must not contain ' + needle)
      }
  }
  } finally { f.cleanup() }
})
