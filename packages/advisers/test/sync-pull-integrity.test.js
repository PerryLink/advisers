import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { decryptJson, encryptJson } from '../lib/vault.js'

// Robustness audit 2026-11-17 P1-4: sync pull used to replace the live database
// with any snapshot whose envelope SHA-256 was self-consistent — a byte-corrupted
// (but re-encrypted) payload became the main database and only a later audit
// write failed. Pull must now stage the bytes, run PRAGMA quick_check on the
// staged file BEFORE replacing the library, keep the backup, and leave the local
// database untouched when the snapshot is malformed.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const PASSPHRASE = 'correct horse battery'
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function cli(home, args, env = {}) {
  return execFileSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: tosEnv(home, {
      ...process.env,
      ADVISERS_HOME: home,
      ADVISERS_CORE_LOCAL: '1',
      ADVISERS_OFFICE_LOCAL: '1',
      ADVISERS_NO_MODEL: '1',
      ADVISERS_SYNC_PASSPHRASE: PASSPHRASE,
      ...env,
    }),
  })
}

function cliFail(home, args, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: tosEnv(home, {
      ...process.env,
      ADVISERS_HOME: home,
      ADVISERS_CORE_LOCAL: '1',
      ADVISERS_OFFICE_LOCAL: '1',
      ADVISERS_NO_MODEL: '1',
      ADVISERS_SYNC_PASSPHRASE: PASSPHRASE,
      ...env,
    }),
  })
}

function quickCheck(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare('PRAGMA quick_check').get()?.quick_check
  } finally {
    db.close()
  }
}

function corruptSnapshot(snapshotFile) {
  const envelope = JSON.parse(readFileSync(snapshotFile, 'utf8'))
  const payload = decryptJson(envelope, PASSPHRASE)
  const garbage = Buffer.from('this snapshot is not a sqlite database but its sha256 is self-consistent ' + 'x'.repeat(128))
  const forged = { ...payload, db: garbage.toString('base64'), sha256: sha256(garbage) }
  writeFileSync(snapshotFile, JSON.stringify(encryptJson(forged, PASSPHRASE)) + '\n')
}

test('sync pull refuses a sha256-consistent but corrupt snapshot and keeps the local database', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-sync-integrity-'))
  const home = join(root, 'home')
  const dir = join(root, 'sync')
  mkdirSync(home, { recursive: true })
  try {
    cli(home, ['commit', 'add', '第一份承诺', '--quote', 'q'])
    cli(home, ['sync', 'push', '--dir', dir, '--device', 'test-device'])
    const dbPath = join(home, 'state.db')
    const localBefore = readFileSync(dbPath)
    assert.equal(quickCheck(dbPath), 'ok', 'precondition: the local database is valid')

    const snapshotFile = join(dir, readdirSync(dir).find((name) => name.endsWith('.enc.json')))
    corruptSnapshot(snapshotFile)

    const failed = cliFail(home, ['sync', 'pull', '--dir', dir, '--force'])
    assert.equal(failed.status, 1)
    assert.match(
      failed.stderr + failed.stdout,
      /refusing to replace the local database|integrity check/,
      'the error names the integrity failure',
    )

    // The live database was not touched (same bytes, still valid) ...
    assert.equal(sha256(readFileSync(dbPath)), sha256(localBefore))
    assert.equal(quickCheck(dbPath), 'ok')
    // ... the pre-pull state is available as a backup ...
    const backups = readdirSync(home).filter((name) => name.startsWith('state.db.before-sync-'))
    assert.equal(backups.length, 1, 'a backup is kept on failure')
    assert.equal(sha256(readFileSync(join(home, backups[0]))), sha256(localBefore))
    // ... and the commitment is still there, not replaced by a malformed DB.
    assert.match(cli(home, ['commit', 'ls']), /第一份承诺/)
    // No staging leftovers.
    assert.deepEqual(readdirSync(home).filter((name) => name.startsWith('.advisers-pull-verify-')), [])

    // A valid snapshot pulled afterwards still installs, with its own backup.
    cli(home, ['sync', 'push', '--dir', dir, '--device', 'test-device'])
    assert.match(cli(home, ['sync', 'pull', '--dir', dir, '--force']), /pulled/)
    assert.equal(quickCheck(dbPath), 'ok')
    assert.match(cli(home, ['commit', 'ls']), /第一份承诺/)
    assert.ok(readdirSync(home).filter((name) => name.startsWith('state.db.before-sync-')).length >= 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
