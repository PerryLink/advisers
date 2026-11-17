import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'

// Security audit SEC2-07: the local read-only UI bind is 127.0.0.1, but it did
// not validate the Host header, so DNS rebinding could read ledger views from an
// attacker origin. Only 127.0.0.1 / localhost / ::1 Host values are accepted.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function env(home) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_STORE: 'sqlite', ADVISERS_NO_MODEL: '1' })
}

function get(port, host, path = '/api/today') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host, connection: 'close' } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('bin ui: Host header validation rejects DNS-rebinding hosts but allows loopback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-ui-host-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const child = spawn(process.execPath, [bin, 'ui', '--port', '0'], { env: env(home), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  try {
    const started = Date.now()
    while (Date.now() - started < 8000 && !/http:\/\/127\.0\.0\.1:\d+/.test(stdout)) await sleep(100)
    const match = /127\.0\.0\.1:(\d+)/.exec(stdout)
    assert.ok(match, 'ui did not print its URL: ' + stdout + stderr)
    const port = Number(match[1])

    const evil = await get(port, 'evil.example')
    assert.equal(evil.status, 403)
    assert.doesNotMatch(evil.body, /commitments/, 'the 403 body must not leak ledger data')

    const rebinding = await get(port, `attacker.example:${port}`)
    assert.equal(rebinding.status, 403)

    const loopback = await get(port, `127.0.0.1:${port}`)
    assert.equal(loopback.status, 200)
    assert.match(loopback.body, /commitments/)

    const localhost = await get(port, `localhost:${port}`)
    assert.equal(localhost.status, 200)
  } finally {
    child.kill('SIGINT')
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)])
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
