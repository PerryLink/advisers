import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
function run(home, args, cwd) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite' },
  })
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-json-'))
  const home = join(root, 'home'); const work = join(root, 'work')
  mkdirSync(home, { recursive: true }); mkdirSync(work, { recursive: true })
  return { root, home, work }
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

test('E6-T2: MCP stdio server initializes, lists tools, and serves read-only data', () => {
  const { root, home, work } = setup()
  try {
    run(home, ['commit', 'add', '发报价', '--quote', 'q'], work)
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'advisers_today', arguments: {} } },
    ].map((x) => JSON.stringify(x)).join('\n') + '\n'
    const out = spawnSync(process.execPath, [bin, 'mcp', '--stdio'], {
      cwd: work, input, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite' },
    })
    assert.equal(out.status, 0, out.stderr)
    const lines = out.stdout.trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines[0].result.serverInfo.name, 'advisers')
    assert.ok(lines[1].result.tools.some((t) => t.name === 'advisers_today'))
    const call = lines.find((l) => l.id === 3)
    assert.equal(call.result.isError, false)
    assert.match(call.result.content[0].text, /发报价/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
