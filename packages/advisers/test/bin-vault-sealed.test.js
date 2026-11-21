import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { assertPrivateMode } from './win-compat.mjs'

// Robustness audit P1-1/P1-2/P2-1: sealed vault visibility, plaintext copy
// cleanup on `vault seal --remove`, and 0600 WAL/SHM sidecars.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const PASSPHRASE = 'correct horse battery'

function env(home, extra = {}) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_STORE: 'sqlite', ADVISERS_NO_MODEL: '1', ...extra })
}
function run(home, args, extra = {}) {
  return execFileSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8' })
}
function runResult(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8' })
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(100)
  }
  return false
}

test('vault sealed: ordinary commands fail fast with E_VAULT_SEALED instead of creating an empty DB', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-sealed-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  try {
    run(home, ['commit', 'add', '秘密承诺', '--quote', 'q'])
    run(home, ['vault', 'seal', '--remove'], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    assert.equal(existsSync(join(home, 'state.db')), false)
    assert.ok(existsSync(join(home, 'state.db.vault')))

    for (const args of [['today'], ['commit', 'ls'], ['audit'], ['status']]) {
      const result = runResult(home, args)
      assert.equal(result.status, 1, `advisers ${args.join(' ')} should fail while sealed`)
      assert.match(result.stderr, /E_VAULT_SEALED/, args.join(' '))
      assert.equal(existsSync(join(home, 'state.db')), false, 'a sealed vault must never be replaced by an empty DB')
    }

    const doctor = run(home, ['doctor'])
    assert.match(doctor, /vault\s+sealed/)
    assert.match(doctor, /skipped \(vault sealed\)/)

    const backupFile = join(root, 'backup.db')
    const backup = runResult(home, ['backup', backupFile])
    assert.equal(backup.status, 1)
    assert.match(backup.stderr, /E_VAULT_SEALED/)
    assert.equal(existsSync(backupFile), false)

    assert.match(run(home, ['vault', 'status']), /encrypted at rest/)
    run(home, ['vault', 'unseal'], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    assert.match(run(home, ['commit', 'ls']), /秘密承诺/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('vault seal --remove purges unseal/migrate/import/sync plaintext copies and reports failures', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-seal-copies-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  try {
    run(home, ['commit', 'add', '秘密承诺', '--quote', 'q'])
    // Keep plaintext first, unseal produces state.db.before-unseal-*, then add
    // the other plaintext copies the audit found.
    run(home, ['vault', 'seal'], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    run(home, ['vault', 'unseal'], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    const unsealCopies = readdirSync(home).filter((name) => name.startsWith('state.db.before-unseal-'))
    assert.ok(unsealCopies.length >= 1, 'unseal should leave a documented before-unseal backup')
    const planted = ['state.db.before-migrate-123', 'state.db.before-sync-456', 'import-backup-789.db', '.state.db.unseal-dead-wal']
    for (const name of planted) writeFileSync(join(home, name), 'plaintext sqlite copy')
    const sealed = run(home, ['vault', 'seal', '--remove'], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    assert.match(sealed, /plaintext removed/i)
    assert.equal(existsSync(join(home, 'state.db')), false)
    for (const name of [...unsealCopies, ...planted]) {
      assert.equal(existsSync(join(home, name)), false, `plaintext copy still present: ${name}`)
    }
    assert.ok(existsSync(join(home, 'state.db.vault')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  const root2 = mkdtempSync(join(tmpdir(), 'advisers-bin-seal-fail-'))
  const home2 = join(root2, 'home')
  mkdirSync(home2, { recursive: true })
  try {
    run(home2, ['commit', 'add', '秘密承诺', '--quote', 'q'])
    // A directory cannot be removed with rmSync(file); the CLI must report the
    // failure, exit non-zero and NOT claim that plaintext was removed.
    mkdirSync(join(home2, 'import-backup-broken.db'))
    writeFileSync(join(home2, 'import-backup-broken.db', 'inside'), 'x')
    const failed = runResult(home2, ['vault', 'seal', '--remove'], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /could not be removed/)
    assert.match(failed.stderr, /import-backup-broken\.db/)
    assert.doesNotMatch(failed.stdout, /plaintext removed/i)
    assert.ok(existsSync(join(home2, 'state.db.vault')))
  } finally {
    rmSync(root2, { recursive: true, force: true })
  }
})

test('bin vault: WAL/SHM sidecar files are 0600 while the database is open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-wal-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const child = spawn(process.execPath, [bin, 'ui', '--port', '0'], { env: env(home), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  try {
    assert.ok(await waitFor(() => /advisers ui/.test(stdout)), 'ui server did not start: ' + stderr)
    assert.ok(await waitFor(() => existsSync(join(home, 'state.db-wal'))), 'WAL file was not created')
    for (const name of ['state.db', 'state.db-wal', 'state.db-shm']) {
      const file = join(home, name)
      if (!existsSync(file)) continue
      assertPrivateMode(file, 0o600, name + ' (open database file)')
    }
  } finally {
    child.kill('SIGINT')
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)])
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
