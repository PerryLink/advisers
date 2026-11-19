import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { Ledger } from '../../core/dist/index.js'
import { buildEvidencePack } from '../lib/evidence.js'
import { SqliteStore } from '../lib/sqlite.js'
import {
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  RESOURCE_URIS,
  SERVER_NAME,
  TOOL_NAMES,
  createMcpServer,
} from '../lib/mcp-server.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const devEntry = join(repoRoot, 'scripts', 'mcp-dev.mjs')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-mcp-lib-'))
  const store = new SqliteStore(join(root, 'state.db'))
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '客户 A 报价', secrecy: 0 })
  const turn = store.addTurn({ conversationId: 'conv-1', role: 'user', content: '周五前把报价发给王工' })
  const commitment = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: '王工',
    action: '发报价',
    dueAt: '2026-12-01T10:00:00+08:00',
    evidence: [{ sessionId: 'conv-1', turnId: turn.id, quote: '周五前把报价发给王工' }],
  })
  const audits = []
  const server = createMcpServer({
    store,
    ledger,
    version: '0.2.0-test',
    audit: (entry) => { audits.push(entry) },
    now: () => new Date('2026-11-17T03:00:00.000Z'),
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
  return { root, store, ledger, matter, commitment, audits, server, call, callTool, cleanup }
}

test('mcp: initialize advertises protocol 2024-11-05, tools and resources', async () => {
  const f = fixture()
  try {
    const response = await f.call('initialize', {})
    assert.equal(response.jsonrpc, '2.0')
    assert.equal(response.id, 1)
    assert.equal(response.result.protocolVersion, PROTOCOL_VERSION)
    assert.equal(response.result.protocolVersion, '2024-11-05')
    assert.equal(response.result.serverInfo.name, SERVER_NAME)
    assert.equal(response.result.serverInfo.version, '0.2.0-test')
    assert.equal(typeof response.result.capabilities.tools, 'object')
    assert.equal(typeof response.result.capabilities.resources, 'object')

    const ping = await f.call('ping', {}, 2)
    assert.deepEqual(ping.result, {})
    const notification = await f.server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(notification, null)
  } finally { f.cleanup() }
})

test('mcp: tools/list exposes the 5 read-only tools plus 2 whitelisted tools', async () => {
  const f = fixture()
  try {
    const response = await f.call('tools/list')
    const tools = response.result.tools
    assert.deepEqual(tools.map((tool) => tool.name), [...TOOL_NAMES])
    assert.equal(tools.length, 7)
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object', tool.name + ' schema must be an object')
      assert.equal(typeof tool.description, 'string')
    }
    const capture = tools.find((tool) => tool.name === 'advisers_capture_candidate')
    assert.equal(capture.annotations.readOnlyHint, false)
    assert.deepEqual(capture.inputSchema.required, ['action', 'quote'])
    assert.equal(capture.inputSchema.additionalProperties, false)
    assert.match(capture.description, /PENDING/)
    assert.match(capture.description, /never accepts/)
    const packVerify = tools.find((tool) => tool.name === 'advisers_pack_verify')
    assert.equal(packVerify.annotations.readOnlyHint, true)
    assert.deepEqual(packVerify.inputSchema.required, ['dir'])
    const readOnly = tools.filter((tool) => tool.annotations.readOnlyHint === true).map((tool) => tool.name)
    assert.equal(readOnly.length, 6)
    assert.ok(!readOnly.includes('advisers_capture_candidate'))
  } finally { f.cleanup() }
})

test('mcp: resources/list and resources/read expose the four read-only JSON views', async () => {
  const f = fixture()
  try {
    const list = await f.call('resources/list')
    assert.deepEqual(list.result.resources.map((entry) => entry.uri), [...RESOURCE_URIS])
    assert.equal(list.result.resources.length, 4)
    for (const resource of list.result.resources) {
      assert.equal(resource.mimeType, 'application/json')
      assert.equal(typeof resource.name, 'string')
    }

    const today = await f.call('resources/read', { uri: 'advisers://today' }, 2)
    assert.equal(today.result.contents[0].uri, 'advisers://today')
    assert.equal(today.result.contents[0].mimeType, 'application/json')
    const todayData = JSON.parse(today.result.contents[0].text)
    assert.equal(todayData.open, 1)
    assert.equal(todayData.commitments[0].id, f.commitment.id)

    const commitments = await f.call('resources/read', { uri: 'advisers://commitments' }, 3)
    const commitmentsData = JSON.parse(commitments.result.contents[0].text)
    assert.equal(commitmentsData.commitments.length, 1)
    assert.equal(commitmentsData.commitments[0].status, 'open')

    const who = await f.call('resources/read', { uri: 'advisers://who' }, 4)
    const whoData = JSON.parse(who.result.contents[0].text)
    assert.deepEqual(whoData.mine.map((row) => row.id), [f.commitment.id])
    assert.deepEqual(whoData.waiting, [])

    const evidence = await f.call('resources/read', { uri: 'advisers://evidence' }, 5)
    const evidenceData = JSON.parse(evidence.result.contents[0].text)
    assert.equal(evidenceData.commitments.length, 1)
    assert.equal(evidenceData.commitments[0].id, f.commitment.id)
    assert.equal(evidenceData.commitments[0].found, true)
    assert.equal(evidenceData.commitments[0].sources, 1)

    const unknown = await f.call('resources/read', { uri: 'advisers://nope' }, 6)
    assert.equal(unknown.error.code, -32002)
    assert.ok(!JSON.stringify(unknown).includes('advisers://nope'))
  } finally { f.cleanup() }
})

test('mcp: read-only tools return ledger data without writing', async () => {
  const f = fixture()
  try {
    const today = await f.callTool('advisers_today', {})
    assert.equal(today.isError, false)
    assert.equal(today.data.open, 1)
    assert.equal(f.ledger.listCommitments().length, 1)

    const commitLs = await f.callTool('advisers_commit_ls', { all: true })
    assert.equal(commitLs.isError, false)
    // 0.2.5 A-2: array-shaped results became {commitments, clearance,
    // protectedExcluded} so a filtered read can never look like a complete one.
    assert.equal(commitLs.data.commitments.length, 1)
    assert.equal(commitLs.data.commitments[0].action, '发报价')
    assert.equal(commitLs.data.clearance, 0)
    assert.equal(commitLs.data.protectedExcluded, 0)

    const who = await f.callTool('advisers_who', {})
    assert.equal(who.data.mine.length, 1)
    assert.equal(who.data.clearance, 0)
    assert.equal(who.data.protectedExcluded, 0)

    const evidence = await f.callTool('advisers_evidence', { id: f.commitment.id })
    assert.equal(evidence.isError, false)
    assert.equal(evidence.data.commitment.id, f.commitment.id)
    assert.equal(evidence.data.sources.length, 1)
    assert.equal(evidence.data.sources[0].sessionId, 'conv-1')

    const missing = await f.callTool('advisers_evidence', { id: 'cm_missing' })
    assert.equal(missing.isError, false)
    assert.equal(missing.data.commitment, undefined)
    assert.equal(missing.data.missing[0].reason, 'commitment_not_found')

    const remind = await f.callTool('advisers_remind', {})
    assert.equal(remind.isError, false)
    assert.ok(Array.isArray(remind.data.reminders))
    assert.equal(remind.data.clearance, 0)

    const badPrefix = await f.callTool('advisers_evidence', { id: 'xx_123' })
    assert.equal(badPrefix.isError, true)
    assert.match(badPrefix.text, /unknown evidence id prefix/)
    assert.ok(!badPrefix.text.includes('xx_123'))
    assert.equal(f.ledger.listCommitments().length, 1)
  } finally { f.cleanup() }
})

test('mcp: advisers_capture_candidate creates a PENDING candidate only (never accepts)', async () => {
  const f = fixture()
  try {
    assert.equal(f.ledger.listCommitments().length, 1)
    assert.equal(f.store.listCandidates('all').length, 0)

    const result = await f.callTool('advisers_capture_candidate', {
      action: '把修订报价单发给王工',
      quote: '周一前把修订报价单发给王工，抄送李总',
      debtor: 'user',
      creditor: '王工',
      dueAt: '2026-11-24T10:00:00+08:00',
    }, 11)
    assert.equal(result.response.result.isError, false)
    assert.equal(result.data.ok, true)
    assert.equal(result.data.candidate.kind, 'commitment')
    assert.equal(result.data.candidate.status, 'pending')
    assert.match(result.data.note, /memory accept/)

    // The ledger is untouched: only a candidate row exists.
    assert.equal(f.ledger.listCommitments().length, 1)
    assert.equal(f.store.listCandidates('pending').length, 1)
    assert.equal(f.store.listCandidates('all').length, 1)
    const candidate = f.store.getCandidate(result.data.candidate.id)
    assert.equal(candidate.status, 'pending')
    assert.equal(candidate.payload.action, '把修订报价单发给王工')
    assert.equal(candidate.payload.creditor, '王工')
    assert.equal(candidate.payload.matterId, f.matter.id)
    assert.equal(candidate.evidence[0].quote, '周一前把修订报价单发给王工，抄送李总')

    // The write is audited through the injected callback.
    const audit = f.audits.find((entry) => entry.action === 'mcp.capture.candidate')
    assert.equal(audit.allowed, true)
    assert.equal(audit.reason, result.data.candidate.id)
    assert.equal(audit.actor, 'mcp')
  } finally { f.cleanup() }
})

test('mcp: capture argument validation returns -32602 and writes nothing', async () => {
  const f = fixture()
  try {
    const cases = [
      [{}, 'action'],
      [{ action: 'x' }, 'quote'],
      [{ action: 'x', quote: '' }, 'quote'],
      [{ action: 42, quote: 'q' }, 'action'],
      [{ action: 'x', quote: 'q', bonus: true }, 'unexpected argument'],
      [{ action: 'x', quote: 'q', dueAt: 'not-a-date' }, 'dueAt'],
      [{ action: 'x', quote: 'q', debtor: 'nobody' }, 'debtor'],
      [{ action: 'x', quote: 'q', matterId: 'matter_nope' }, 'unknown matter id'],
    ]
    for (const [args, needle] of cases) {
      const result = await f.callTool('advisers_capture_candidate', args, 20)
      assert.equal(result.response.error.code, -32602, JSON.stringify(args))
      if (needle === 'unexpected argument') assert.equal(result.response.error.message, needle)
      else assert.ok(result.response.error.message.includes(needle), needle + ' not in ' + result.response.error.message)
      // No raw argument value is echoed back in the failure.
      assert.ok(!JSON.stringify(result.response).includes('not-a-date'))
      assert.ok(!JSON.stringify(result.response).includes('matter_nope'))
      assert.ok(!JSON.stringify(result.response).includes('nobody'))
    }
    assert.equal(f.store.listCandidates('all').length, 0)
    assert.equal(f.ledger.listCommitments().length, 1)
    // Failed write attempts are still audited, as denied calls.
    const denied = f.audits.filter((entry) => entry.action === 'mcp.capture.candidate')
    assert.equal(denied.length, cases.length)
    assert.ok(denied.every((entry) => entry.allowed === false))
  } finally { f.cleanup() }
})

test('mcp: protocol errors use -32601/-32602/-32700 without leaking raw input', async () => {
  const f = fixture()
  try {
    const unknownMethod = await f.call('tools/teach', {}, 31)
    assert.equal(unknownMethod.error.code, -32601)

    const badParams = await f.server.handle({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: [] })
    assert.equal(badParams.error.code, -32602)

    const unknownTool = await f.server.handle({ jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: '/etc/passwd', arguments: {} } })
    assert.equal(unknownTool.error.code, -32602)
    assert.ok(!JSON.stringify(unknownTool).includes('/etc/passwd'))

    const badArgs = await f.call('tools/call', { name: 'advisers_commit_ls', arguments: { all: 'yes' } }, 34)
    assert.equal(badArgs.error.code, -32602)
    assert.ok(!JSON.stringify(badArgs).includes('yes'))

    const missingUri = await f.call('resources/read', {}, 35)
    assert.equal(missingUri.error.code, -32602)

    const parseError = await f.server.handleLine('{this is not json')
    assert.equal(parseError.error.code, -32700)
    assert.ok(!JSON.stringify(parseError).includes('this is not json'))

    assert.equal(await f.server.handleLine('   '), null)
  } finally { f.cleanup() }
})

test('mcp: advisers_pack_verify checks a real receipt directory without leaking paths', async () => {
  const f = fixture()
  try {
    const pack = buildEvidencePack({ store: f.store, ledger: f.ledger, ids: { commitments: [f.commitment.id] } })
    const receiptDir = join(f.root, 'receipt')
    mkdirSync(receiptDir, { recursive: true })
    for (const [name, content] of Object.entries(pack.files)) writeFileSync(join(receiptDir, name), content, { mode: 0o600 })
    writeFileSync(join(receiptDir, 'receipt.docx'), Buffer.from('fake-docx'), { mode: 0o600 })

    const result = await f.callTool('advisers_pack_verify', { dir: receiptDir }, 41)
    assert.equal(result.isError, false)
    assert.equal(result.data.ok, true)
    assert.equal(result.data.fileCount, 3)
    assert.equal(result.data.receiptPresent, true)
    assert.deepEqual([...result.data.files].sort(), ['README.txt', 'SHA256SUMS', 'manifest.json'])
    assert.deepEqual(result.data.errors, [])
    const audit = f.audits.find((entry) => entry.action === 'mcp.pack.verify')
    assert.equal(audit.allowed, true)
    assert.equal(audit.actor, 'mcp')

    // Tampering with any pack file flips ok to false.
    writeFileSync(join(receiptDir, 'README.txt'), readFileSync(join(receiptDir, 'README.txt'), 'utf8') + 'tampered\n')
    const tampered = await f.callTool('advisers_pack_verify', { dir: receiptDir }, 42)
    assert.equal(tampered.data.ok, false)
    assert.ok(tampered.data.errors.some((message) => message.includes('hash mismatch')))
    assert.ok(tampered.data.errors.every((message) => !message.includes(f.root)))

    // A missing directory is an execution error whose text hides the path.
    const missingDir = join(f.root, 'no-such-receipt')
    const missing = await f.callTool('advisers_pack_verify', { dir: missingDir }, 43)
    assert.equal(missing.isError, true)
    assert.match(missing.text, /pack directory not found/)
    assert.ok(!missing.text.includes(f.root))
    assert.ok(!missing.text.includes('no-such-receipt'))

    // Injected reader failures are sanitized too.
    const failing = createMcpServer({
      store: f.store,
      ledger: f.ledger,
      audit: () => {},
      readPack: () => { throw new Error('/tmp/secret-receipt-path') },
    })
    const failed = await failing.handle({ jsonrpc: '2.0', id: 44, method: 'tools/call', params: { name: 'advisers_pack_verify', arguments: { dir: '/tmp/secret-receipt-path' } } })
    assert.equal(failed.result.isError, true)
    assert.ok(!JSON.stringify(failed).includes('/tmp/secret-receipt-path'))

    const badDir = await f.callTool('advisers_pack_verify', { dir: 42 }, 45)
    assert.equal(badDir.response.error.code, -32602)
  } finally { f.cleanup() }
})

test('mcp: stdio serve frames newline requests and enforces the line cap', async () => {
  const f = fixture()
  try {
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks = []
    output.on('data', (chunk) => chunks.push(String(chunk)))
    const done = f.server.serve(input, output)

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
    input.write('x'.repeat(MAX_LINE_BYTES + 16) + '\n')
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
    input.end()
    await done

    const lines = chunks.join('').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 3)
    assert.equal(lines[0].id, 1)
    assert.equal(lines[0].result.protocolVersion, '2024-11-05')
    assert.equal(lines[1].error.code, -32600)
    assert.match(lines[1].error.message, /line limit/)
    assert.equal(lines[2].id, 2)
    assert.equal(lines[2].result.tools.length, 7)

    const oversized = await f.server.handleLine('y'.repeat(MAX_LINE_BYTES + 1))
    assert.equal(oversized.error.code, -32600)
  } finally { f.cleanup() }
})

test('mcp: scripts/mcp-dev.mjs serves the library over real stdio', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-mcp-dev-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  try {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'resources/list' },
      { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'advisers://today' } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'advisers_capture_candidate', arguments: { action: 'MCP 候选不入账', quote: '帮我把这件事记成待确认候选' } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'advisers_commit_ls', arguments: { all: true } } },
    ]
    const input = requests.map((request) => JSON.stringify(request)).join('\n') + '\n'
    const out = spawnSync(process.execPath, [devEntry], {
      cwd: repoRoot,
      input,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, ADVISERS_HOME: home },
    })
    assert.equal(out.status, 0, out.stderr)
    const lines = out.stdout.trim().split('\n').map((line) => JSON.parse(line))
    const byId = new Map(lines.map((line) => [line.id, line]))
    assert.equal(byId.get(1).result.protocolVersion, '2024-11-05')
    assert.equal(byId.get(2).result.tools.length, 7)
    assert.deepEqual(byId.get(3).result.resources.map((entry) => entry.uri), [...RESOURCE_URIS])
    assert.equal(JSON.parse(byId.get(4).result.contents[0].text).open, 0)
    const capture = byId.get(5)
    assert.equal(capture.result.isError, false)
    assert.equal(JSON.parse(capture.result.content[0].text).candidate.status, 'pending')
    // 0.3.0 P0-T3: list results also carry total/truncated (+ the commit_ls
    // limit), so a capped result can never look like the whole ledger.
    assert.deepEqual(JSON.parse(byId.get(6).result.content[0].text), {
      commitments: [], clearance: 0, protectedExcluded: 0, total: 0, truncated: false, limit: 50,
    })

    const store = new SqliteStore(join(home, 'state.db'))
    try {
      assert.equal(store.listCandidates('pending').length, 1)
      assert.equal(store.listCandidates('accepted').length, 0)
      assert.equal(Ledger.fromJSON(store.load()).listCommitments().length, 0)
      assert.ok(store.listAudit(20).some((row) => row.action === 'mcp.capture.candidate'))
    } finally {
      store.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
