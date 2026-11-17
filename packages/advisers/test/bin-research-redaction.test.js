import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'

// Privacy audit P1-2 / security audit: lib/research.js no longer copies the
// upstream response body into errors, but the CLI must also never print an
// upstream body or a stack trace for a failed research call. The mock provider
// runs in this process, so the CLI is spawned asynchronously (spawnSync would
// block the event loop and the mock could never answer).

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

test('bin research: a mock 401 that echoes the API key prints only stable status/code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-research-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const secret = 'sk-live-RESEARCH-SECRET-9f2c1ab7'
  const provider = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: `Authentication Fails, Your api key: ${secret} is invalid`,
        },
      }))
    })
  })
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
  try {
    const child = spawn(process.execPath, [bin, 'research', '--web', '季度总结'], {
      env: tosEnv(home, {
        ...process.env,
        ADVISERS_HOME: home,
        ADVISERS_CORE_LOCAL: '1',
        ADVISERS_OFFICE_LOCAL: '1',
        ADVISERS_STORE: 'sqlite',
        ADVISERS_NO_MODEL: '1',
        ADVISERS_API_KEY: 'test-key',
        ADVISERS_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code))
    })
    assert.equal(status, 1)
    assert.match(output, /research failed: HTTP 401 \(AUTH\)/)
    assert.equal(output.includes(secret), false, 'the API key from the upstream body leaked to the CLI output')
    assert.equal(output.includes('Authentication Fails'), false, 'the upstream body leaked to the CLI output')
    assert.doesNotMatch(output, /\n\s+at /, 'a stack trace was printed')
    assert.doesNotMatch(output, /ResearchError/, 'the internal error class name was printed')
  } finally {
    provider.close()
    rmSync(root, { recursive: true, force: true })
  }
})
