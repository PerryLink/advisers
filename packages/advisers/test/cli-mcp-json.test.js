import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const CLI_ENV = (home) => tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite' })
const TOOL_NAMES = [
  'advisers_today',
  'advisers_commit_ls',
  'advisers_who',
  'advisers_evidence',
  'advisers_remind',
  'advisers_capture_candidate',
  'advisers_pack_verify',
]
const RESOURCE_URIS = ['advisers://today', 'advisers://commitments', 'advisers://who', 'advisers://evidence']

function run(home, args, cwd) {
  return execFileSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: CLI_ENV(home) })
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-json-'))
  const home = join(root, 'home'); const work = join(root, 'work')
  mkdirSync(home, { recursive: true }); mkdirSync(work, { recursive: true })
  return { root, home, work }
}
/** One stdio session: newline-delimited JSON-RPC requests in, parsed responses out. */
function mcp(home, work, messages) {
  const input = messages.map((message) => (typeof message === 'string' ? message : JSON.stringify(message))).join('\n') + '\n'
  const out = spawnSync(process.execPath, [bin, 'mcp', '--stdio'], {
    cwd: work, input, encoding: 'utf8', timeout: 30000, env: CLI_ENV(home),
  })
  assert.equal(out.status, 0, out.stderr)
  const responses = out.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const responsesById = new Map(responses.filter((response) => response.id !== undefined && response.id !== null).map((response) => [response.id, response]))
  return { out, responses, response: (id) => responsesById.get(id) }
}
function call(name, args, id) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

test('E6: read-only commands expose stable JSON', () => {
  const { root, home, work } = setup()
  try {
    run(home, ['commit', 'add', '发报价', '--quote', 'q', '--due', '2026-12-01T10:00:00+08:00'], work)
    const status = JSON.parse(run(home, ['status', '--json'], work))
    assert.equal(typeof status.version, 'string')
    assert.equal(status.store.type, 'sqlite')
    const commits = JSON.parse(run(home, ['commit', 'ls', '--json'], work))
    assert.ok(Array.isArray(commits) && commits.some((c) => c.action === '发报价'))
    const who = JSON.parse(run(home, ['who', '--json'], work))
    assert.ok(Array.isArray(who.mine) && Array.isArray(who.waiting))
    const deliveries = JSON.parse(run(home, ['deliveries', '--json'], work))
    assert.ok(Array.isArray(deliveries))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E6-T2: MCP stdio initializes with 7 tools + 4 resources and serves read-only data', () => {
  const { root, home, work } = setup()
  try {
    run(home, ['commit', 'add', '发报价', '--quote', 'q'], work)
    const { response } = mcp(home, work, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'resources/list' },
      call('advisers_today', {}, 4),
    ])
    const init = response(1).result
    assert.equal(init.protocolVersion, '2024-11-05')
    assert.equal(init.serverInfo.name, 'advisers')
    assert.equal(typeof init.serverInfo.version, 'string')
    assert.ok(init.capabilities.tools, 'initialize must advertise tools')
    assert.ok(init.capabilities.resources, 'initialize must advertise resources')

    const tools = response(2).result.tools
    assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES)
    assert.ok(tools.every((tool) => tool.inputSchema && tool.inputSchema.type === 'object'), 'every tool needs an object inputSchema')
    const capture = tools.find((tool) => tool.name === 'advisers_capture_candidate')
    const packVerify = tools.find((tool) => tool.name === 'advisers_pack_verify')
    assert.equal(capture.annotations.readOnlyHint, false, 'capture is a whitelisted write')
    assert.equal(packVerify.annotations.readOnlyHint, true, 'pack verify is read-only')

    const resources = response(3).result.resources
    assert.deepEqual(resources.map((resource) => resource.uri), RESOURCE_URIS)
    assert.ok(resources.every((resource) => resource.mimeType === 'application/json'))

    const call4 = response(4)
    assert.equal(call4.result.isError, false)
    assert.match(call4.result.content[0].text, /发报价/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E6-T3: MCP resources/read serves the four read-only JSON views', () => {
  const { root, home, work } = setup()
  try {
    run(home, ['commit', 'add', '发报价', '--quote', '机密原话', '--due', '2026-12-01T10:00:00+08:00'], work)
    const { response } = mcp(home, work, RESOURCE_URIS.map((uri, index) => ({ jsonrpc: '2.0', id: index + 1, method: 'resources/read', params: { uri } })))
    const read = (id, uri) => {
      const result = response(id).result
      assert.equal(result.contents[0].uri, uri)
      assert.equal(result.contents[0].mimeType, 'application/json')
      return JSON.parse(result.contents[0].text)
    }
    const today = read(1, 'advisers://today')
    assert.equal(typeof today.open, 'number')
    assert.ok(today.commitments.some((commitment) => commitment.action === '发报价'))
    const commitments = read(2, 'advisers://commitments')
    assert.ok(Array.isArray(commitments.commitments) && commitments.commitments.length >= 1)
    const who = read(3, 'advisers://who')
    assert.ok(Array.isArray(who.mine) && Array.isArray(who.waiting))
    const evidence = read(4, 'advisers://evidence')
    assert.ok(evidence.limits && Array.isArray(evidence.commitments) && Array.isArray(evidence.facts) && Array.isArray(evidence.preferences))
    assert.ok(!JSON.stringify(evidence).includes('机密原话'), 'the evidence index carries counts only, never quote text')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E6-T4: MCP protocol errors use the documented codes, the line cap, and never echo raw input', () => {
  const { root, home, work } = setup()
  try {
    const oversized = JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'ping', params: { pad: 'x'.repeat(1024 * 1024) } })
    const { response, responses, out } = mcp(home, work, [
      { jsonrpc: '2.0', id: 10, method: 'not/a/real/method' },
      call('advisers_nope_<script>', {}, 11),
      { jsonrpc: '2.0', id: 12, method: 'resources/read', params: { uri: 'advisers://nope' } },
      '{ this is not json',
      oversized,
      { jsonrpc: '2.0', id: 13, method: 'ping' },
    ])
    assert.equal(response(10).error.code, -32601, 'unknown method must be -32601')
    assert.equal(response(11).error.code, -32602, 'unknown tool must be -32602')
    assert.equal(response(12).error.code, -32002, 'unknown resource URI must be -32002')
    assert.ok(!response(11).error.message.includes('<script>'), 'raw tool name must not be echoed')
    assert.ok(!out.stdout.includes('advisers://nope'), 'raw resource URI must not be echoed')
    const parseError = responses.find((entry) => entry.error?.code === -32700)
    assert.ok(parseError, 'malformed JSON must be -32700')
    assert.equal(parseError.id, null)
    const tooLong = responses.find((entry) => entry.error?.code === -32600)
    assert.ok(tooLong, 'over-limit lines must be -32600')
    assert.equal(tooLong.id, null)
    assert.equal(response(13).result !== undefined, true, 'the stream must keep serving after an oversized line')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E6-T5: MCP capture writes only a pending candidate and each call is audited', () => {
  const { root, home, work } = setup()
  try {
    run(home, ['commit', 'add', '发报价', '--quote', 'q'], work)
    const badPackDir = join(root, 'missing-pack-dir')
    const { response, out } = mcp(home, work, [
      call('advisers_capture_candidate', { action: '把修订报价单发给王工', quote: '周一前把修订报价单发给王工' }, 1),
      call('advisers_capture_candidate', { action: '缺少引文' }, 2),
      call('advisers_pack_verify', { dir: badPackDir }, 3),
      call('advisers_today', {}, 4),
    ])
    const captured = JSON.parse(response(1).result.content[0].text)
    assert.equal(captured.ok, true)
    assert.match(captured.candidate.id, /^cand_/)
    assert.equal(captured.candidate.status, 'pending')
    assert.equal(response(2).error.code, -32602, 'a capture without a quote must be a parameter error')
    assert.equal(response(3).result.isError, true)
    assert.match(response(3).result.content[0].text, /pack directory not found/)
    assert.ok(!out.stdout.includes(badPackDir), 'pack errors must not echo the directory path')

    const candidates = JSON.parse(run(home, ['memory', 'candidates', '--json'], work))
    assert.deepEqual(candidates.map((candidate) => [candidate.id, candidate.status]), [[captured.candidate.id, 'pending']])
    const commitments = JSON.parse(run(home, ['commit', 'ls', '--json'], work))
    assert.ok(!commitments.some((commitment) => commitment.action === '把修订报价单发给王工'), 'MCP capture must not write the ledger')

    const audit = run(home, ['audit'], work)
    assert.match(audit, /audit: verified/)
    assert.match(audit, new RegExp('mcp\\.capture\\.candidate\\tallow\\t' + captured.candidate.id))
    assert.match(audit, /mcp\.call\tallow/)
    assert.match(audit, /mcp\.pack\.verify\tdeny/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
