import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { tosEnv } from './tos-fixture.js'

/**
 * 0.4.0 MCP modern dual-era tests against the REAL CLI entry
 * (`advisers mcp --stdio`), not the library.
 *
 * The bin wiring is unchanged by this task: the era switch lives in the library
 * factory and defaults to on, so a plain `advisers mcp --stdio` is dual-era and
 * ADVISERS_MCP_MODERN=off is a one-restart rollback to the exact 0.3.2 surface.
 * The same process must serve legacy and modern requests interleaved (no era
 * stickiness) and give the same payload bytes under both envelopes.
 */

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const MODERN_META = Object.freeze({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-mcp-modern-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return { root, home, work }
}

function cliEnv(home, { modern } = {}) {
  const env = tosEnv(home, {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_STORE: 'sqlite',
  })
  delete env.ADVISERS_MCP_MODERN
  if (modern !== undefined) env.ADVISERS_MCP_MODERN = modern
  return env
}

function runCli(home, work, args) {
  return execFileSync(process.execPath, [bin, ...args], { cwd: work, encoding: 'utf8', env: cliEnv(home) })
}

/** One real stdio session: newline-delimited JSON-RPC in, parsed responses out. */
function mcpSession(home, work, messages, options = {}) {
  const input = messages.map((message) => (typeof message === 'string' ? message : JSON.stringify(message))).join('\n') + '\n'
  const out = spawnSync(process.execPath, [bin, 'mcp', '--stdio'], {
    cwd: work,
    input,
    encoding: 'utf8',
    timeout: 30000,
    env: cliEnv(home, options),
  })
  assert.equal(out.status, 0, 'mcp --stdio exited ' + out.status + ': ' + String(out.stderr).slice(0, 300))
  assert.equal(String(out.stderr).trim(), '', 'stderr must stay clean')
  const lines = String(out.stdout).trim().split('\n').filter(Boolean)
  const responses = lines.map((line) => JSON.parse(line))
  const byId = new Map()
  for (const response of responses) {
    if (response.id !== undefined && response.id !== null) byId.set(response.id, response)
  }
  return { lines, responses, response: (id) => byId.get(id) }
}

function modern(method, params, id) {
  return { jsonrpc: '2.0', id, method, params: { ...(params ?? {}), _meta: MODERN_META } }
}

function legacy(method, params, id) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
}

function toolCall(name, args, id, modernEra = false) {
  const params = { name, arguments: args }
  return modernEra ? modern('tools/call', params, id) : legacy('tools/call', params, id)
}

test('real stdio: one process serves interleaved legacy and modern requests (no era stickiness)', () => {
  const { root, home, work } = setup()
  try {
    runCli(home, work, ['commit', 'add', '发报价单', '--quote', '周五前发报价单', '--due', '2026-12-01T10:00:00+08:00'])
    const session = mcpSession(home, work, [
      modern('server/discover', undefined, 1),
      legacy('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dual-era', version: '1' } }, 2),
      modern('tools/list', undefined, 3),
      legacy('tools/list', undefined, 4),
      toolCall('advisers_today', {}, 5, true),
      toolCall('advisers_today', {}, 6, false),
      modern('resources/read', { uri: 'advisers://today' }, 7),
      legacy('resources/read', { uri: 'advisers://today' }, 8),
      modern('resources/read', { uri: 'advisers://does-not-exist' }, 9),
      legacy('resources/read', { uri: 'advisers://does-not-exist' }, 10),
      modern('tools/list', undefined, 11),
      legacy('initialize', { protocolVersion: '2025-11-25' }, 12),
      { jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: MODERN_META } },
    ])
    // 12 requests with ids; the modern notification must produce no response line.
    assert.equal(session.responses.length, 12)
    assert.equal(session.lines.length, 12)

    const discover = session.response(1)
    assert.equal(discover.result.resultType, 'complete')
    assert.deepEqual(discover.result.supportedVersions, ['2026-07-28'])
    assert.equal(discover.result.ttlMs, 300000)
    assert.equal(discover.result.cacheScope, 'public')
    assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'advisers')

    const init = session.response(2)
    assert.equal(init.result.protocolVersion, '2024-11-05')
    assert.equal(Object.hasOwn(init.result, 'resultType'), false)

    const modernTools = session.response(3).result
    const legacyTools = session.response(4).result
    assert.equal(modernTools.resultType, 'complete')
    assert.equal(modernTools.ttlMs, 300000)
    assert.equal(Object.hasOwn(legacyTools, 'resultType'), false)
    assert.equal(modernTools.tools.length, 8)
    assert.equal(JSON.stringify(modernTools.tools), JSON.stringify(legacyTools.tools))

    const modernToday = session.response(5).result
    const legacyToday = session.response(6).result
    assert.equal(modernToday.resultType, 'complete')
    assert.equal(modernToday.content[0].text, legacyToday.content[0].text)
    assert.ok(JSON.parse(modernToday.content[0].text).commitments.some((row) => row.action === '发报价单'))

    const modernRead = session.response(7).result
    const legacyRead = session.response(8).result
    assert.equal(modernRead.resultType, 'complete')
    assert.equal(modernRead.ttlMs, 0)
    assert.equal(modernRead.cacheScope, 'private')
    assert.equal(modernRead.contents[0].text, legacyRead.contents[0].text)

    assert.equal(session.response(9).error.code, -32602)
    assert.equal(session.response(10).error.code, -32002)

    // repeat modern tools/list: still modern (era is per request, not sticky)
    assert.equal(session.response(11).result.resultType, 'complete')
    assert.equal(session.response(12).result.protocolVersion, '2025-11-25')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('real stdio: modern _meta validation and error mapping over the wire', () => {
  const { root, home, work } = setup()
  try {
    const badVersion = { 'io.modelcontextprotocol/protocolVersion': '2025-11-25', 'io.modelcontextprotocol/clientCapabilities': {} }
    const missingCaps = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }
    const session = mcpSession(home, work, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: badVersion } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: missingCaps } },
      modern('ping', undefined, 3),
      modern('prompts/list', undefined, 4),
      modern('tools/list', { cursor: 'next-page' }, 5),
      modern('resources/list', { cursor: 'next-page' }, 6),
      modern('tools/call', { name: 'no_such_tool', arguments: {} }, 7),
    ])
    assert.equal(session.response(1).error.code, -32022)
    assert.deepEqual(session.response(1).error.data.supported, ['2026-07-28'])
    assert.equal(session.response(1).error.data.requested, '2025-11-25')
    assert.equal(session.response(2).error.code, -32602)
    assert.equal(session.response(3).error.code, -32601)
    assert.equal(session.response(4).error.code, -32601)
    assert.equal(session.response(5).error.code, -32602)
    assert.equal(session.response(6).error.code, -32602)
    assert.equal(session.response(7).error.code, -32602)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('real stdio: ADVISERS_MCP_MODERN=off reverts to the exact 0.3.2 surface', () => {
  const { root, home, work } = setup()
  try {
    const session = mcpSession(home, work, [
      modern('server/discover', undefined, 1),
      modern('tools/list', undefined, 2),
      modern('tools/call', { name: 'advisers_today', arguments: {} }, 3),
      modern('resources/read', { uri: 'advisers://does-not-exist' }, 4),
      legacy('initialize', { protocolVersion: '2024-11-05' }, 5),
      legacy('ping', undefined, 6),
    ], { modern: 'off' })
    assert.equal(session.response(1).error.code, -32601, 'server/discover stays unknown when modern is off')
    const tools = session.response(2).result
    assert.equal(Object.hasOwn(tools, 'resultType'), false)
    assert.equal(tools.tools.length, 8)
    const today = session.response(3).result
    assert.equal(Object.hasOwn(today, 'resultType'), false)
    assert.equal(today.isError, false)
    assert.equal(session.response(4).error.code, -32002)
    assert.equal(session.response(5).result.protocolVersion, '2024-11-05')
    assert.deepEqual(session.response(6).result, {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('real stdio: ADVISERS_MCP_MODERN unset/any-other-value keeps dual-era on', () => {
  const { root, home, work } = setup()
  try {
    for (const value of [undefined, 'on', '1', 'yes']) {
      const session = mcpSession(home, work, [
        { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: MODERN_META } },
      ], { modern: value })
      const result = session.response(1).result
      assert.equal(result.resultType, 'complete', 'ADVISERS_MCP_MODERN=' + String(value))
      assert.deepEqual(result.supportedVersions, ['2026-07-28'])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
