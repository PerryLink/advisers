/**
 * 0.5.1 (051-M8, plan 202 A5 / 210 M8): `advisers_pack_verify` dispatches on
 * manifest.format, so a host agent can verify a received context pack offline.
 *
 * The MCP surface stays frozen (8 tools / 5 resources, same names, schemas and
 * annotations); only the verify payload is additive for context packs while the
 * legacy evidence-pack path keeps its existing bytes.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = {
  ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1',
  ADVISERS_STORE: 'sqlite', ADVISERS_ACCEPT_TOS: '1',
}
const TOOL_NAMES = [
  'advisers_today', 'advisers_commit_ls', 'advisers_who', 'advisers_evidence',
  'advisers_remind', 'advisers_clients', 'advisers_capture_candidate', 'advisers_pack_verify',
]

function makeRoot() { return mkdtempSync(join(tmpdir(), 'advisers-051-mcppack-')) }
function run(home, args, work) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd: work, encoding: 'utf8', env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home }, timeout: 120000,
  })
}
function json(text) {
  try { return JSON.parse(text) } catch (error) { throw new Error('not JSON: ' + String(text).slice(0, 400)) }
}
/** One stdio session: newline-delimited JSON-RPC requests in, parsed responses out. */
function mcp(home, work, messages) {
  const input = messages.map((message) => JSON.stringify(message)).join('\n') + '\n'
  const out = spawnSync(process.execPath, [bin, 'mcp', '--stdio'], {
    cwd: work, input, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home },
  })
  assert.equal(out.status, 0, out.stderr)
  const responses = out.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const byId = new Map(responses.filter((response) => response.id !== undefined).map((response) => [response.id, response]))
  return (id) => byId.get(id)
}
function call(name, args, id) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

test('advisers_pack_verify verifies a context pack offline through the stdio server', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  const work = join(root, 'work')
  const out = join(root, 'pack')
  mkdirSync(work, { recursive: true })
  try {
    run(home, ['init'])
    const client = json(run(home, ['client', 'add', '王工', '--json'])).client
    const matter = json(run(home, ['matter', 'add', '官网改版', '--client', client.id, '--json'])).matter
    run(home, ['commit', 'add', '发报价单', '--quote', '周五前发报价单', '--matter', matter.id, '--json'])
    const created = json(run(home, ['context-pack', 'create', '--subject', 'client:' + client.id, '--yes',
      '--recipient', 'Claude Code', '--purpose', 'external-review', '--out', out, '--json']))
    assert.equal(created.audit.action, 'context_pack.create')

    const response = mcp(home, work, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      call('advisers_pack_verify', { dir: out }, 3),
    ])
    const tools = response(2).result.tools
    assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES, 'the 0.5.0 MCP tool surface is frozen')
    assert.equal(tools.find((tool) => tool.name === 'advisers_pack_verify').annotations.readOnlyHint, true)

    const verified = response(3)
    assert.equal(verified.result.isError, false)
    const payload = JSON.parse(verified.result.content[0].text)
    assert.equal(payload.ok, true)
    assert.equal(payload.format, 'advisers-context-pack')
    assert.equal(payload.version, 1)
    assert.equal(payload.manifestDigest, created.manifestDigest)
    assert.equal(payload.verificationBasis, 'local-checksums-only')
    assert.equal(typeof payload.fileCount, 'number')

    // Tampering is refused by the same read-only tool (still exit 0 at the RPC level).
    const readme = join(out, 'README.txt')
    writeFileSync(readme, readFileSync(readme, 'utf8') + ' tampered')
    const tampered = mcp(home, work, [call('advisers_pack_verify', { dir: out }, 7)])
    const bad = JSON.parse(tampered(7).result.content[0].text)
    assert.equal(bad.ok, false)
    assert.ok(Array.isArray(bad.errors) && bad.errors.length > 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
