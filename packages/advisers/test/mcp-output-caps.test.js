import assert from 'node:assert/strict'
import test from 'node:test'

import { Ledger } from '../../core/dist/index.js'
import {
  MCP_MAX_RESULT_BYTES,
  MCP_OUTPUT_LIMITS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  createMcpServer,
} from '../lib/mcp-server.js'

/**
 * 0.3.0 P0-T3: MCP read-surface usability + protocol negotiation (2026-11-20).
 *
 * Before this, any list tool that returned the whole ledger tripped the content
 * classifier's 100k-character fail-closed limit and answered CONTENT_BLOCKED on
 * a large ledger. The tools now cap AFTER the per-item clearance filter and
 * BEFORE the egress classifier, and report the true post-filter counts.
 */

const NOW = () => new Date('2026-11-20T03:00:00.000Z')
const CLASSIFIER_MAX_CHARS = 100_000

function fixture({ commitments = 0, done = 0, hugeEvidence = 0, matterId } = {}) {
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '客户 A 报价', secrecy: 0, participants: ['王工'] })
  const add = (action, extra = {}) => ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: '王工',
    action,
    dueAt: '2026-11-21T10:00:00+08:00',
    capability: 'todo',
    evidence: [{ sessionId: 's', turnId: 't', quote: action }],
    ...extra,
  })
  for (let i = 0; i < commitments; i++) add('发送第' + i + '版报价单')
  for (let i = 0; i < hugeEvidence; i++) {
    add('超大证据' + i, { evidence: [{ sessionId: 's', turnId: 't', quote: 'x'.repeat(5000) }] })
  }
  for (let i = 0; i < done; i++) {
    const row = add('已完成' + i)
    ledger.completeCommitment(row.id, [{ sessionId: 's', turnId: 't', quote: '完成' }])
  }
  const audit = []
  const server = createMcpServer({ ledger, version: '0.3.0-test', audit: (entry) => { audit.push(entry) }, now: NOW })
  const call = (method, params, id = 1) => server.handle({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
  const callTool = async (name, args = {}, id = 1) => {
    const response = await call('tools/call', { name, arguments: args }, id)
    const text = response.result?.content?.[0]?.text ?? ''
    let data
    try { data = JSON.parse(text) } catch { data = undefined }
    return { response, isError: response.result?.isError === true, text, data, textBytes: Buffer.byteLength(text) }
  }
  return { ledger, matter, audit, server, call, callTool }
}

test('large ledger: the three read tools stay usable and bounded, never CONTENT_BLOCKED', async () => {
  const f = fixture({ commitments: 1200, done: 40 })
  const today = await f.callTool('advisers_today', {})
  assert.equal(today.isError, false, today.text)
  assert.ok(today.textBytes < CLASSIFIER_MAX_CHARS)
  assert.equal(today.data.open, 1200)
  assert.equal(today.data.total, 1200)
  assert.equal(today.data.truncated, true)
  assert.equal(today.data.commitments.length, MCP_OUTPUT_LIMITS.todayCommitments)

  const commitLs = await f.callTool('advisers_commit_ls', {})
  assert.equal(commitLs.isError, false, commitLs.text)
  assert.ok(commitLs.textBytes < CLASSIFIER_MAX_CHARS)
  assert.equal(commitLs.data.total, 1200)
  assert.equal(commitLs.data.truncated, true)
  assert.equal(commitLs.data.commitments.length, MCP_OUTPUT_LIMITS.commitRows)
  assert.equal(commitLs.data.limit, MCP_OUTPUT_LIMITS.commitRows)

  const all = await f.callTool('advisers_commit_ls', { all: true })
  assert.equal(all.isError, false, all.text)
  assert.equal(all.data.total, 1240)
  assert.equal(all.data.commitments.length, MCP_OUTPUT_LIMITS.commitRows)

  const remind = await f.callTool('advisers_remind', {})
  assert.equal(remind.isError, false, remind.text)
  assert.ok(remind.textBytes < CLASSIFIER_MAX_CHARS)
  assert.equal(remind.data.truncated, true)
  assert.equal(remind.data.reminders.length, MCP_OUTPUT_LIMITS.reminders)
  assert.ok(remind.data.total > MCP_OUTPUT_LIMITS.reminders)

  const who = await f.callTool('advisers_who', {})
  assert.equal(who.isError, false, who.text)
  assert.ok(who.textBytes < CLASSIFIER_MAX_CHARS)
  assert.equal(who.data.truncated, true)
  assert.equal(who.data.mineTotal, 1200)
  assert.equal(who.data.mine.length, MCP_OUTPUT_LIMITS.whoRows)
})

test('commit_ls limit is validated and applied (1..200, default 50)', async () => {
  const f = fixture({ commitments: 300 })
  const limited = await f.callTool('advisers_commit_ls', { limit: 7 })
  assert.equal(limited.isError, false)
  assert.equal(limited.data.commitments.length, 7)
  assert.equal(limited.data.total, 300)
  assert.equal(limited.data.truncated, true)
  assert.equal(limited.data.limit, 7)

  const max = await f.callTool('advisers_commit_ls', { limit: 200 })
  assert.equal(max.data.commitments.length, 200)

  for (const [args, needle] of [
    [{ limit: 0 }, 'limit must be an integer between 1 and 200'],
    [{ limit: 201 }, 'limit must be an integer between 1 and 200'],
    [{ limit: 1.5 }, 'limit must be an integer between 1 and 200'],
    [{ limit: '5' }, 'limit must be an integer between 1 and 200'],
  ]) {
    const bad = await f.call('tools/call', { name: 'advisers_commit_ls', arguments: args }, 9)
    assert.equal(bad.error.code, -32602, JSON.stringify(args))
    assert.ok(bad.error.message.includes(needle), bad.error.message)
  }
})

test('resources read the same bounded models as the tools', async () => {
  const f = fixture({ commitments: 1200 })
  const commitments = await f.call('resources/read', { uri: 'advisers://commitments' }, 2)
  const text = commitments.result.contents[0].text
  assert.ok(Buffer.byteLength(text) < CLASSIFIER_MAX_CHARS)
  const data = JSON.parse(text)
  assert.equal(data.total, 1200)
  assert.equal(data.truncated, true)
  assert.equal(data.commitments.length, MCP_OUTPUT_LIMITS.commitRows)
})

test('last-resort byte budget trims oversized list payloads before the classifier', async () => {
  const f = fixture({ commitments: 5, hugeEvidence: 30 })
  const who = await f.callTool('advisers_who', {})
  assert.equal(who.isError, false, who.text.slice(0, 300))
  assert.ok(who.textBytes < CLASSIFIER_MAX_CHARS)
  assert.ok(who.textBytes <= MCP_MAX_RESULT_BYTES + 4096, 'payload trimmed to the byte budget')
  assert.equal(who.data.truncated, true)
  assert.ok(who.data.mineTotal >= 35)
  assert.ok(who.data.mine.length < MCP_OUTPUT_LIMITS.whoRows)
})

test('initialize negotiates the legacy protocol versions and keeps 2024-11-05 as default', async () => {
  const f = fixture({ commitments: 1 })
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ['2024-11-05', '2025-06-18', '2025-11-25'])
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    const response = await f.call('initialize', { protocolVersion: version })
    assert.equal(response.result.protocolVersion, version)
  }
  for (const params of [{}, { protocolVersion: '1900-01-01' }, { protocolVersion: '2026-07-28' }, { protocolVersion: 42 }]) {
    const response = await f.call('initialize', params)
    assert.equal(response.result.protocolVersion, PROTOCOL_VERSION, JSON.stringify(params))
  }
  // Unchanged legacy surface: no server/discover, tools/list still 7 entries.
  const discover = await f.call('server/discover', {})
  assert.equal(discover.error.code, -32601)
  const tools = await f.call('tools/list')
  assert.equal(tools.result.tools.length, 7)
})
