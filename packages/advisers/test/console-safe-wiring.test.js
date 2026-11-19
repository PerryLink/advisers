/**
 * 0.3.0 Wave 3 console-safe wiring (docs/TUI.md §4): remote text that reaches
 * stderr or reminders.log is sanitised at the boundary.
 *
 *   - lib/notify.js webhook failure detail (remote response body)
 *   - lib/imap.js greeting/tagged status (remote server text)
 *   - bin/advisers.js `remind --deliver` reminders.log append
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { fetchImapMessages } from '../lib/imap.js'
import { sendWebhookNotification } from '../lib/notify.js'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/

function workspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-console-safe-' + prefix + '-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home }
}
function env(home, extra = {}) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ...extra })
}
function cli(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8', input: '', timeout: 20000 })
}
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}
function assertOneSafeLine(label, text) {
  assert.equal(typeof text, 'string', label + ': detail must be a string')
  assert.ok(!text.includes('\u001b'), label + ': kept ESC')
  assert.ok(!text.includes('\u0007'), label + ': kept BEL')
  assert.ok(!text.includes('\r'), label + ': kept CR')
  assert.ok(!text.includes('\n'), label + ': kept a second line')
  assert.ok(!text.includes('\u202e'), label + ': kept a bidi override')
  assert.ok(!CONTROL.test(text), label + ': kept C0/C1 controls')
}

test('0.3.0: webhook HTTP failure detail is one sanitised line', async () => {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('upstream unavailable \u001b[2J\u001b]0;pwned\u0007\r\nforged\tline \u202e')
    })
  })
  const port = await listen(server)
  try {
    const result = await sendWebhookNotification([{ level: 'L1', dueAt: '2026-11-20T10:00:00+08:00' }], { url: 'http://127.0.0.1:' + port + '/hook', timeoutMs: 5000 })
    assert.equal(result.sent, false)
    assert.equal(result.error, 'http')
    assert.equal(result.status, 500)
    assert.match(result.detail, /upstream unavailable/)
    assert.match(result.detail, /forged/)
    assertOneSafeLine('webhook detail', result.detail)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test('0.3.0: IMAP greeting/status injection is stripped from the error line', async () => {
  const greetingServer = net.createServer((socket) => {
    socket.write('* BAD \u001b[2J伪造\u0007 greeting\r\n')
  })
  const greetingPort = await listen(greetingServer)
  try {
    await assert.rejects(
      () => fetchImapMessages({ host: '127.0.0.1', port: greetingPort, secure: false, user: 'u', pass: 'p', limit: 1 }),
      (error) => {
        assert.match(error.message, /IMAP greeting failed/)
        assertOneSafeLine('imap greeting', error.message)
        return true
      },
    )
  } finally { await new Promise((resolve) => greetingServer.close(resolve)) }

  const statusServer = net.createServer((socket) => {
    socket.write('* OK mock IMAP ready\r\n')
    socket.on('data', (chunk) => {
      if (/LOGIN/.test(chunk.toString('utf8'))) socket.write('A1 BAD \u001b[31mrejected\u0007\r\n')
    })
  })
  const statusPort = await listen(statusServer)
  try {
    await assert.rejects(
      () => fetchImapMessages({ host: '127.0.0.1', port: statusPort, secure: false, user: 'u', pass: 'p', limit: 1 }),
      (error) => {
        assert.match(error.message, /IMAP LOGIN failed/)
        assertOneSafeLine('imap status', error.message)
        return true
      },
    )
  } finally { await new Promise((resolve) => statusServer.close(resolve)) }
})

test('0.3.0: reminders.log is one sanitised line even when the ledger action has escapes', () => {
  const ws = workspace('remind')
  try {
    const due = new Date(Date.now() - 86400_000).toISOString()
    const seed = cli(ws.home, ['commit', 'add', '提醒动作', '--quote', 'q', '--due', due], { ADVISERS_STORE: 'json' })
    assert.equal(seed.status, 0, seed.stderr)
    const statePath = join(ws.home, 'state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(state.commitments.length, 1)
    state.commitments[0].action = '通知\u001b[2J伪造\r\n第二行\u0007\u202e'
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n')
    const result = cli(ws.home, ['remind', '--deliver'], { ADVISERS_STORE: 'json' })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(!result.stdout.includes('\u001b'), 'remind console output kept ESC')
    assert.ok(!CONTROL.test(result.stdout), 'remind console output kept controls')
    const log = readFileSync(join(ws.home, 'reminders.log'), 'utf8')
    assertOneSafeLine('reminders.log entry', log.trimEnd())
    assert.match(log, /通知/)
    assert.match(log, /伪造/)
    assert.equal(log.split('\n').filter(Boolean).length, 1, 'one reminder run must append exactly one log line')
  } finally { rmSync(ws.root, { recursive: true, force: true }) }
})
