import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
function cli(home, args, env = {}) {
  return execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ...env } })
}
function cliFail(home, args, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ...env } })
}

test('P2: file-based E2EE snapshot push/pull and no plaintext in the sync dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-sync-'))
  const home = join(root, 'home'); const dir = join(root, 'sync')
  mkdirSync(home, { recursive: true })
  const pass = { ADVISERS_SYNC_PASSPHRASE: 'correct horse battery' }
  try {
    cli(home, ['commit', 'add', '第一份承诺', '--quote', 'q'], pass)
    assert.match(cli(home, ['sync', 'push', '--dir', dir, '--device', 'test-device'], pass), /pushed/)
    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    assert.ok(files[0].startsWith('advisers-test-device-'))
    assert.equal(readFileSync(join(dir, files[0]), 'utf8').includes('第一份承诺'), false)
    const status = JSON.parse(cli(home, ['sync', 'status', '--dir', dir, '--json'], pass))
    assert.equal(status.length, 1)
    cli(home, ['commit', 'add', '只在本机的第二份承诺', '--quote', 'q'], pass)
    assert.match(cli(home, ['sync', 'pull', '--dir', dir], pass), /pulled/)
    const commits = cli(home, ['commit', 'ls'], pass)
    assert.match(commits, /第一份承诺/)
    assert.equal(commits.includes('只在本机的第二份承诺'), false)
    assert.ok(readdirSync(home).some((f) => f.startsWith('state.db.before-sync-')))
    const bad = cliFail(home, ['sync', 'pull', '--dir', dir], { ADVISERS_SYNC_PASSPHRASE: 'wrong passphrase' })
    assert.equal(bad.status, 1)
    assert.match(bad.stderr + bad.stdout, /wrong passphrase|tampered/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
