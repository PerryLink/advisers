import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { SqliteStore } from '../lib/sqlite.js'

// 0.2.3 Wave 1 (robustness audit P1-4/P1-5/P1-6):
// - default doctor stays lightweight (no O(db) quick_check / O(index) FTS);
// - doctor --check-db runs quick_check + FTS integrity + WAL + backup
//   readability + plaintext/temp-file checks and exits non-zero on FAIL;
// - stale sync-pull staging files are cleaned up (only stale + dead pid);
// - .advisers-pull-verify-*, state.db-wal.corrupt-* and fs-safe temp prefixes
//   are counted as plaintext database material.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const PASSPHRASE = 'correct horse battery'

function env(home, extra = {}) {
  return tosEnv(home, {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_STORE: 'sqlite',
    ADVISERS_NO_MODEL: '1',
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
function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-doctor-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home }
}
function seededHome() {
  const made = makeHome()
  runOk(made.home, ['commit', 'add', '发报价给王工', '--quote', 'q'])
  return made
}
function output(result) { return result.stdout + result.stderr }
function oldDate() { return new Date(Date.now() - 2 * 60 * 60 * 1000) }

test('default doctor is lightweight; --check-db adds quick_check/FTS/WAL/backup/plaintext rows', () => {
  const { root, home } = seededHome()
  try {
    const lightweight = runOk(home, ['doctor'])
    assert.match(lightweight.stdout, /PASS  sqlite/)
    assert.match(lightweight.stdout, /PASS  wal/)
    assert.doesNotMatch(lightweight.stdout, /db-quick-check/, 'quick_check must be opt-in')
    assert.doesNotMatch(lightweight.stdout, /db-fts/, 'FTS verification must be opt-in')

    const full = runOk(home, ['doctor', '--check-db'])
    for (const name of ['db-quick-check', 'db-fts', 'db-wal', 'db-backup', 'pull-temps', 'plaintext']) {
      assert.match(full.stdout, new RegExp('PASS  ' + name), name + ' row missing: ' + full.stdout)
    }
    assert.match(full.stdout, /db-fts .*state=ok/)
    assert.match(full.stdout, /db-wal .*journal=wal/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doctor --check-db detects FTS index corruption while the lightweight doctor stays green', () => {
  const { root, home } = seededHome()
  try {
    // Chat turns populate the FTS index. Use a local turn insert through the
    // Store (the CLI path exercised by other suites) and then remove one sync
    // trigger: the source index is no longer maintained => inconsistent.
    const store = new SqliteStore(join(home, 'state.db'))
    try {
      store.db.exec('DROP TRIGGER IF EXISTS turns_ai')
    } finally { store.close?.() }
    runOk(home, ['commit', 'add', '第二条', '--quote', 'q'])

    const lightweight = runOk(home, ['doctor'])
    assert.match(lightweight.stdout, /PASS  sqlite/)

    const full = run(home, ['doctor', '--check-db'])
    assert.equal(full.status, 1, 'doctor --check-db must exit non-zero on FTS corruption')
    const text = output(full)
    assert.match(text, /FAIL  db-fts/)
    assert.match(text, /FTS sync trigger|missing FTS|integrity-check|index/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doctor --check-db detects an unusable WAL and quarantines it as state.db-wal.corrupt-*', () => {
  const { root, home } = seededHome()
  try {
    // Overwrite the WAL with garbage: bad magic => invalid, SQLite would ignore it.
    writeFileSync(join(home, 'state.db-wal'), Buffer.alloc(64, 0x41))
    const full = run(home, ['doctor', '--check-db'])
    assert.equal(full.status, 1, output(full))
    assert.match(full.stdout, /FAIL  db-wal/)
    assert.ok(readdirSync(home).some((name) => name.startsWith('state.db-wal.corrupt-')), 'the unusable WAL must be preserved as evidence')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doctor --check-db cleans only stale dead-pid pull temps and lists plaintext copies', () => {
  const { root, home } = seededHome()
  try {
    const stale = join(home, '.advisers-pull-verify-999999-stale')
    const fresh = join(home, '.advisers-pull-verify-987654-fresh')
    const live = join(home, '.advisers-pull-verify-' + process.pid + '-live')
    for (const file of [stale, fresh, live]) writeFileSync(file, 'plaintext staged db')
    utimesSync(stale, oldDate(), oldDate())
    utimesSync(live, oldDate(), oldDate())

    const full = runOk(home, ['doctor', '--check-db'])
    assert.match(full.stdout, /PASS  pull-temps .*1 stale temp\(s\) removed, 2 kept/)
    assert.equal(existsSync(stale), false, 'a stale dead-pid pull temp must be removed')
    assert.equal(existsSync(fresh), true, 'a fresh pull temp may belong to a running pull')
    assert.equal(existsSync(live), true, 'the temp of a live pid must be kept')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doctor --check-db verifies the newest backup is readable', () => {
  const { root, home } = seededHome()
  try {
    writeFileSync(join(home, 'state.db.before-sync-1000'), readFileSync(join(home, 'state.db')))
    const good = runOk(home, ['doctor', '--check-db'])
    assert.match(good.stdout, /PASS  db-backup .*state\.db\.before-sync-1000/)

    writeFileSync(join(home, 'state.db.before-sync-2000'), 'not a sqlite database')
    const bad = run(home, ['doctor', '--check-db'])
    assert.equal(bad.status, 1, output(bad))
    assert.match(bad.stdout, /FAIL  db-backup/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('vault status/doctor list the new plaintext artifacts, and a sealed vault fails on leftovers', () => {
  const { root, home } = seededHome()
  try {
    const planted = ['state.db.before-unseal-999', 'state.db-wal.corrupt-20261118', '.state.db.tmp-dead', '.pet-brief.json.123.abc.tmp']
    // The before-unseal copy is DB-shaped and is the newest backup candidate, so
    // give it valid SQLite bytes (the other artifacts are crash residue).
    writeFileSync(join(home, planted[0]), readFileSync(join(home, 'state.db')))
    for (const name of planted.slice(1)) writeFileSync(join(home, name), 'plaintext sqlite')
    const status = runOk(home, ['vault', 'status'])
    assert.match(status.stdout, /plaintext copies: 4/)
    for (const name of planted) assert.ok(status.stdout.includes(name), 'vault status must list ' + name)

    // Seal without --remove keeps the live DB but lists the copies; the plaintext
    // check is informational while a plaintext DB exists.
    runOk(home, ['vault', 'seal'], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    const liveDb = runOk(home, ['doctor', '--check-db'])
    assert.match(liveDb.stdout, /PASS  plaintext/)

    // Now seal --remove purges the copies; then replant a leak and doctor must FAIL.
    runOk(home, ['vault', 'seal', '--remove'], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    assert.equal(existsSync(join(home, 'state.db')), false)
    for (const name of planted) assert.equal(existsSync(join(home, name)), false, name + ' must be purged by vault seal --remove')
    writeFileSync(join(home, 'state.db.before-unseal-777'), 'leaked plaintext')
    const sealedBad = run(home, ['doctor', '--check-db'])
    assert.equal(sealedBad.status, 1, output(sealedBad))
    assert.match(sealedBad.stdout, /FAIL  plaintext/)
    assert.match(output(sealedBad), /state\.db\.before-unseal-777/)
    // Cleanup path: --remove purges the leak and doctor goes green again.
    runOk(home, ['vault', 'seal', '--remove'], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    runOk(home, ['doctor', '--check-db'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
