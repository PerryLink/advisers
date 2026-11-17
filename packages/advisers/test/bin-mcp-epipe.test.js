import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'

// Robustness audit P2-3: when an MCP client closed stdout, the resulting EPIPE
// was an asynchronous stream error that bypassed the library's try/catch, hit
// the global uncaughtException handler and exited 1 ("advisers: write EPIPE").
// The CLI must treat a closed client as a normal end of session (exit 0).

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function env(home) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_STORE: 'sqlite', ADVISERS_NO_MODEL: '1' })
}

test('bin mcp: a closed client stdout (EPIPE) ends the session gracefully with exit 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-mcp-epipe-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const child = spawn(process.execPath, [bin, 'mcp', '--stdio'], { env: env(home), stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
    const started = Date.now()
    while (Date.now() - started < 8000 && !stdout.includes('"id":1')) await sleep(50)
    assert.match(stdout, /"protocolVersion"/, 'server did not answer initialize: ' + stderr)

    // Simulate the host going away: close the parent's read end of the child's
    // stdout, then trigger one more response write.
    child.stdout.destroy()
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
    const code = await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(8000).then(() => 'timeout'),
    ])
    assert.notEqual(code, 'timeout', 'MCP server did not exit after EPIPE')
    assert.equal(code, 0, stderr)
    assert.doesNotMatch(stderr, /write EPIPE/)
    assert.doesNotMatch(stderr, /EPIPE/)
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
