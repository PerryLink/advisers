/**
 * 0.5.0 (050-S2, 121 S2.4): bin-level sync flags.
 *
 * Covers the three 0.4.3 gaps the plan calls out: `push --dry-run` used to write a
 * real snapshot, `status` had no `--check`, and a stale push refreshed the remote
 * `createdAt` without any conflict gate. The lib-level conflict/precheck tests live
 * in test/sync-{state,conflict,precheck}.test.js; this file drives the CLI.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const PASSPHRASE = 'correct horse battery'
const BASE_ENV = { ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_ACCEPT_TOS: '1', ADVISERS_SYNC_PASSPHRASE: PASSPHRASE }

function makeRoot() { return mkdtempSync(join(tmpdir(), 'advisers-050-sync-')) }
function run(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home, ...extra },
    encoding: 'utf8', input: '', timeout: 120000,
  })
}
function ok(result, label) {
  assert.equal(result.status, 0, label + ': ' + (result.stderr || result.stdout))
  return result
}
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}
function json(result) { return JSON.parse(result.stdout) }

test('sync push --dry-run is a real dry run: no snapshot, no audit, no state', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  const dir = join(root, 'sync')
  try {
    ok(run(home, ['commit', 'add', '承诺', '--quote', 'q']), 'seed')
    const dbHashBefore = sha256File(join(home, 'state.db'))
    const dry = ok(run(home, ['sync', 'push', '--dir', dir, '--dry-run', '--json']), 'push --dry-run')
    const payload = json(dry)
    assert.equal(payload.ok, true)
    assert.equal(payload.dryRun, true)
    assert.equal(payload.wouldPush, true)
    assert.equal(typeof payload.file, 'string')
    assert.equal(existsSync(payload.file), false, 'dry-run must not write the snapshot file')
    assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], [], 'dry-run must not write into the sync dir')
    assert.equal(existsSync(join(home, 'sync.state.json')), false, 'dry-run must not write sync state')
    assert.equal(existsSync(join(home, 'sync.device')), false, 'dry-run must not write sync.device')
    assert.equal(sha256File(join(home, 'state.db')), dbHashBefore, 'dry-run must not checkpoint/audit the database')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('sync push/status: real push writes snapshot + state; status --check reports clear', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  const dir = join(root, 'sync')
  try {
    ok(run(home, ['commit', 'add', '承诺', '--quote', 'q']), 'seed')
    const pushed = json(ok(run(home, ['sync', 'push', '--dir', dir, '--json']), 'push'))
    assert.equal(pushed.ok, true)
    assert.ok(existsSync(pushed.file), 'real push writes the snapshot')
    assert.ok(existsSync(join(home, 'sync.state.json')), 'real push writes sync.state.json')
    assert.ok(existsSync(join(home, 'sync.device')), 'real push remembers the device')

    const check = json(ok(run(home, ['sync', 'status', '--dir', dir, '--check', '--json']), 'status --check'))
    assert.equal(check.status, 'clear')
    assert.equal(check.conflict, false)
    assert.equal(typeof check.localChanged, 'boolean')
    assert.equal(typeof check.remoteAdvanced, 'boolean')
    assert.ok(check.newest && check.newest.file, 'status --check names the newest snapshot')

    // Backward compatibility: plain `sync status --json` is still the array.
    const legacy = ok(run(home, ['sync', 'status', '--dir', dir, '--json']), 'status --json')
    assert.ok(Array.isArray(json(legacy)), 'plain status --json keeps the 0.4.3 array shape')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('sync push refuses a stale overwrite with E_SYNC_CONFLICT and --force keeps a backup', () => {
  const root = makeRoot()
  const a = join(root, 'a')
  const b = join(root, 'b')
  const dir = join(root, 'sync')
  try {
    ok(run(a, ['commit', 'add', '承诺A0', '--quote', 'q']), 'A seed')
    ok(run(a, ['sync', 'push', '--dir', dir, '--device', 'dev-a']), 'A push1')
    ok(run(b, ['sync', 'pull', '--dir', dir]), 'B pull')
    ok(run(b, ['commit', 'add', '承诺B1', '--quote', 'q']), 'B write')
    ok(run(b, ['sync', 'push', '--dir', dir, '--device', 'dev-b']), 'B push')
    ok(run(a, ['commit', 'add', '承诺A1', '--quote', 'q']), 'A write')

    const dbHashBefore = sha256File(join(a, 'state.db'))
    const refused = run(a, ['sync', 'push', '--dir', dir, '--json'])
    assert.equal(refused.status, 1, 'a stale push must exit 1')
    const payload = json(refused)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'E_SYNC_CONFLICT')
    assert.equal(payload.conflict, true)
    assert.equal(payload.localChanged, true)
    assert.equal(payload.remoteAdvanced, true)
    assert.equal(sha256File(join(a, 'state.db')), dbHashBefore, 'a refused push must not modify the database')

    const status = json(ok(run(a, ['sync', 'status', '--dir', dir, '--check', '--json']), 'status --check'))
    assert.equal(status.status, 'conflict')
    assert.equal(status.wouldRefuse, true)

    const forced = ok(run(a, ['sync', 'push', '--dir', dir, '--force']), 'forced push')
    assert.match(forced.stdout, /precheck: conflict overridden by --force/)
    assert.match(forced.stdout, /backup: /)
    assert.ok(readdirSync(a).some((name) => name.startsWith('state.db.before-sync-')), 'a forced push must keep a backup')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('sync requires the passphrase and rejects an unknown flag', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  const dir = join(root, 'sync')
  try {
    ok(run(home, ['commit', 'add', '承诺', '--quote', 'q']), 'seed')
    const noPass = run(home, ['sync', 'push', '--dir', dir], { ADVISERS_SYNC_PASSPHRASE: '' })
    assert.equal(noPass.status, 1)
    assert.match(noPass.stderr, /ADVISERS_SYNC_PASSPHRASE/)
    const bogus = run(home, ['sync', 'push', '--dir', dir, '--bogus'])
    assert.equal(bogus.status, 1)
    assert.match(bogus.stderr, /E_USAGE/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
