import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { pushSnapshot } from '../lib/sync.js'

// 0.2.3 Wave 1 (robustness audit P1-1): sync pull must explain the library
// decision (bootstrapped / forced / unchanged / older snapshot), and a failed
// pull must not leave plaintext staging files behind.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const PASSPHRASE = 'correct horse battery'
const SNAPSHOT_AT = new Date('2026-11-01T00:00:00.000Z')

function env(home, extra = {}) {
  return tosEnv(home, {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_STORE: 'sqlite',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_SYNC_PASSPHRASE: PASSPHRASE,
    ...extra,
  })
}
function run(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8' })
}
function runOk(home, args, extra = {}) {
  const result = run(home, args, extra)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}
function makeHome(root, name) {
  const home = join(root, name)
  mkdirSync(home, { recursive: true })
  return home
}
function pullTemps(home) {
  return readdirSync(home).filter((name) => name.startsWith('.advisers-pull-verify-'))
}

test('sync pull: a new device reports bootstrapped; a repeated pull refuses and --force reports forced', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-sync-msg-'))
  try {
    const homeA = makeHome(root, 'home-a')
    const homeB = makeHome(root, 'home-b')
    const dir = join(root, 'sync')
    runOk(homeA, ['commit', 'add', '快照承诺', '--quote', 'q'])
    const pushed = pushSnapshot({ dir, dbPath: join(homeA, 'state.db'), passphrase: PASSPHRASE, device: 'device-a', createdAt: SNAPSHOT_AT })
    assert.ok(existsSync(pushed.file))

    const first = runOk(homeB, ['sync', 'pull', '--dir', dir])
    assert.match(first.stdout, /pulled \(bootstrapped\):/, first.stdout + first.stderr)
    assert.match(first.stdout, /device-a/)
    assert.match(first.stdout, /installed snapshot/)
    assert.match(runOk(homeB, ['commit', 'ls']).stdout, /快照承诺/)
    assert.deepEqual(pullTemps(homeB), [], 'a successful pull must leave no staging file')

    // The pull appended an audit row, so the local ledger is newer by mtime: a
    // repeated plain pull refuses (0.2.2 behavior kept), --force reports forced.
    const second = run(homeB, ['sync', 'pull', '--dir', dir])
    assert.equal(second.status, 1, second.stdout + second.stderr)
    assert.match(second.stderr, /refusing to overwrite/)
    const forced = runOk(homeB, ['sync', 'pull', '--dir', dir, '--force'])
    assert.match(forced.stdout, /pulled \(forced\):/, forced.stdout)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sync pull: an older snapshot is refused on a non-empty different-device home, then forced with a loud warning', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-sync-older-'))
  try {
    const homeA = makeHome(root, 'home-a')
    const homeC = makeHome(root, 'home-c')
    const dir = join(root, 'sync')
    runOk(homeA, ['commit', 'add', '快照承诺', '--quote', 'q'])
    pushSnapshot({ dir, dbPath: join(homeA, 'state.db'), passphrase: PASSPHRASE, device: 'device-a', createdAt: SNAPSHOT_AT })

    // A non-empty local ledger written now is newer than the snapshot.
    runOk(homeC, ['commit', 'add', '本地承诺', '--quote', 'q'])
    writeFileSync(join(homeC, 'sync.device'), 'device-c\n')

    const refused = run(homeC, ['sync', 'pull', '--dir', dir])
    assert.equal(refused.status, 1, refused.stdout + refused.stderr)
    assert.match(refused.stderr, /refusing to overwrite/)
    assert.match(runOk(homeC, ['commit', 'ls']).stdout, /本地承诺/, 'the refused pull must not modify the local ledger')
    assert.deepEqual(pullTemps(homeC), [])

    const forced = runOk(homeC, ['sync', 'pull', '--dir', dir, '--force'])
    assert.match(forced.stdout, /pulled \(forced\):/, forced.stdout)
    assert.match(forced.stderr, /OLDER/, 'a forced older snapshot must be called out loudly')
    assert.match(forced.stdout, /backed up to/)
    assert.match(runOk(homeC, ['commit', 'ls']).stdout, /快照承诺/)
    assert.equal(runOk(homeC, ['commit', 'ls']).stdout.includes('本地承诺'), false)
    assert.ok(readdirSync(homeC).some((name) => name.startsWith('state.db.before-sync-')), 'a forced replace must keep a backup')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sync pull failure cleans stale plaintext staging files and never installs a partial database', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-sync-fail-'))
  try {
    const homeA = makeHome(root, 'home-a')
    const homeD = makeHome(root, 'home-d')
    const dir = join(root, 'sync')
    runOk(homeA, ['commit', 'add', '快照承诺', '--quote', 'q'])
    pushSnapshot({ dir, dbPath: join(homeA, 'state.db'), passphrase: PASSPHRASE, device: 'device-a', createdAt: SNAPSHOT_AT })

    const stale = join(homeD, '.advisers-pull-verify-999999-stale')
    writeFileSync(stale, 'plaintext staged database')
    utimesSync(stale, new Date(Date.now() - 2 * 60 * 60 * 1000), new Date(Date.now() - 2 * 60 * 60 * 1000))

    const failed = run(homeD, ['sync', 'pull', '--dir', dir], { ADVISERS_SYNC_PASSPHRASE: 'wrong passphrase' })
    assert.equal(failed.status, 1, failed.stdout + failed.stderr)
    assert.match(failed.stderr, /sync pull failed/)
    assert.equal(existsSync(stale), false, 'a failed pull must sweep stale plaintext staging files')
    assert.deepEqual(pullTemps(homeD), [], 'no staging file may survive a failed pull')
    assert.equal(existsSync(join(homeD, 'state.db')), false, 'a failed pull must not install a database')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
