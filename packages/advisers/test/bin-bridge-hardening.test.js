import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'

// Security audit P1-1 / SEC2-09: the Hermes bridge is a model egress path but
// bypassed the matter-secrecy gate; its outbox files were 0644 in 0755 dirs and
// the inbox reader had no size cap. The CLI must deny secrecy>0 before any
// network call (with an audit row), keep the bridge tree 0700/0600, quarantine
// oversized inbox files, and never put absolute attachment paths in the outbox.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(100)
  }
  return false
}

function seedLedger(home, { secrecy, title }) {
  mkdirSync(home, { recursive: true })
  const store = new SqliteStore(join(home, 'state.db'))
  const ledger = new Ledger()
  ledger.addMatter({ title, secrecy })
  store.save(ledger.toJSON())
  store.close?.()
}

function startBridge({ home, bridgeDir, baseUrl }) {
  const env = tosEnv(home, {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_STORE: 'sqlite',
    ADVISERS_BRIDGE_LOCAL: '1',
    ADVISERS_API_KEY: 'test-key',
    ADVISERS_BASE_URL: baseUrl,
  })
  delete env.ADVISERS_NO_MODEL
  const child = spawn(process.execPath, [bin, 'bridge', '--dir', bridgeDir], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const state = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { state.stdout += chunk })
  child.stderr.on('data', (chunk) => { state.stderr += chunk })
  return { child, state }
}

async function stopBridge(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function startProvider() {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '好的' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

function inboxMessage(bridgeDir, id, text) {
  const inbox = join(bridgeDir, 'inbox', 'advisers')
  mkdirSync(inbox, { recursive: true })
  writeFileSync(join(inbox, `${id}.json`), JSON.stringify({ bridge: 'advisers', id, sender: 'sender-1', text, chat: { id: 'chat-1', type: 'dm' } }))
  return inbox
}

function outboxFiles(bridgeDir) {
  try {
    return readdirSync(join(bridgeDir, 'outbox', 'advisers'))
  } catch {
    return []
  }
}

function bridgeMode(bridgeDir, relPath) {
  const target = join(bridgeDir, relPath)
  return existsSync(target) ? statSync(target).mode & 0o777 : null
}

test('bridge: secrecy>0 denies the model call, permits stay guarded and the outbox is private', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-bridge-deny-'))
  const home = join(root, 'home')
  const bridgeDir = join(root, 'bridge')
  const provider = await startProvider()
  seedLedger(home, { secrecy: 2, title: '绝密客户A并购' })
  const { child, state } = startBridge({ home, bridgeDir, baseUrl: provider.url })
  try {
    assert.ok(await waitFor(() => state.stdout.includes('listening at')), 'bridge did not start: ' + state.stderr)
    inboxMessage(bridgeDir, 'm1', '请把报价发我')
    assert.ok(await waitFor(() => outboxFiles(bridgeDir).length === 1), 'bridge did not write an outbox reply')
    const outbox = readFileSync(join(bridgeDir, 'outbox', 'advisers', outboxFiles(bridgeDir)[0]), 'utf8')
    assert.match(outbox, /protected matter/)
    assert.equal(outbox.includes('绝密客户A并购'), false)
    assert.doesNotMatch(outbox, /"localPath"/)
    assert.doesNotMatch(outbox, /"url":\s*"\//, 'the outbox must not carry absolute attachment paths')
    assert.equal(outbox.includes(root), false, 'the outbox must not leak absolute local paths')
    assert.equal(provider.requests.length, 0, 'a protected matter must not reach the model provider')

    await stopBridge(child)
    assert.equal(statSync(join(bridgeDir, 'outbox', 'advisers', outboxFiles(bridgeDir)[0])).mode & 0o777, 0o600)
    for (const rel of ['inbox/advisers', 'outbox/advisers', 'status/advisers', 'registry', 'quarantine/advisers']) {
      assert.equal(bridgeMode(bridgeDir, rel), 0o700, rel + ' must be 0700')
    }
    const store = new SqliteStore(join(home, 'state.db'))
    try {
      const audits = store.listAudit(50)
      const denied = audits.find((row) => row.actor === 'bridge' && row.action === 'policy.egress_deny')
      assert.ok(denied, 'expected a bridge egress-deny audit row: ' + JSON.stringify(audits.map((row) => [row.actor, row.action])))
      assert.equal(denied.allowed, false)
    } finally {
      store.close?.()
    }
  } finally {
    await stopBridge(child)
    await provider.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge: oversized inbox files are quarantined, never read by the bridge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-bridge-cap-'))
  const home = join(root, 'home')
  const bridgeDir = join(root, 'bridge')
  const provider = await startProvider()
  seedLedger(home, { secrecy: 2, title: 'protected' })
  const { child, state } = startBridge({ home, bridgeDir, baseUrl: provider.url })
  try {
    assert.ok(await waitFor(() => state.stdout.includes('listening at')), 'bridge did not start: ' + state.stderr)
    const inbox = join(bridgeDir, 'inbox', 'advisers')
    mkdirSync(inbox, { recursive: true })
    const huge = JSON.stringify({ bridge: 'advisers', id: 'huge', sender: 's1', text: 'A'.repeat(1024 * 1024 + 4096), chat: { id: 'c1', type: 'dm' } })
    writeFileSync(join(inbox, 'huge.json'), huge)
    const quarantine = join(bridgeDir, 'quarantine', 'advisers')
    assert.ok(await waitFor(() => existsSync(join(quarantine, 'huge.json'))), 'oversized inbox file was not quarantined')
    assert.equal(existsSync(join(inbox, 'huge.json')), false)
    assert.equal(statSync(join(quarantine, 'huge.json')).mode & 0o777, 0o600)
    assert.equal(provider.requests.length, 0)
    assert.equal(outboxFiles(bridgeDir).length, 0, 'a quarantined message must not produce a reply')
  } finally {
    await stopBridge(child)
    await provider.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge: a normal (secrecy=0) matter still reaches the model exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-bridge-allow-'))
  const home = join(root, 'home')
  const bridgeDir = join(root, 'bridge')
  const provider = await startProvider()
  seedLedger(home, { secrecy: 0, title: '公开事项' })
  const { child, state } = startBridge({ home, bridgeDir, baseUrl: provider.url })
  try {
    assert.ok(await waitFor(() => state.stdout.includes('listening at')), 'bridge did not start: ' + state.stderr)
    inboxMessage(bridgeDir, 'm2', '请把报价发我')
    assert.ok(await waitFor(() => outboxFiles(bridgeDir).length === 1), 'bridge did not write an outbox reply')
    assert.equal(provider.requests.length, 1, 'a secrecy=0 matter must still call the model once')
    const outbox = readFileSync(join(bridgeDir, 'outbox', 'advisers', outboxFiles(bridgeDir)[0]), 'utf8')
    assert.match(outbox, /好的/)
  } finally {
    await stopBridge(child)
    await provider.close()
    rmSync(root, { recursive: true, force: true })
  }
})
