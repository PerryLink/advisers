import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'

// Windows P0 regression (0.3 research 16-ops-security-privacy.md §4.1 / R1):
// lib/fs-safe.js used to fsync a read-only file handle, which Windows rejects
// with `EPERM: operation not permitted, fsync`. The broken paths were
// `backup`, `import --replace`, `vault unseal` and the pre-migration backup.
// This test runs the same sequence as the windows-smoke CI job on every
// platform (the Linux runners included), so a regression is caught before the
// Windows-only CI job: seed -> backup -> export --out -> import --replace ->
// vault seal --out -> vault unseal <vault>. It also asserts the durable target
// files are non-empty and no fs-safe temp file is left behind.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const PASSPHRASE = 'correct horse battery'
const MESSAGE = 'Windows fsync regression commitment'

function env(home) {
  return tosEnv(home, {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_STORE: 'sqlite',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_VAULT_PASSPHRASE: PASSPHRASE,
  })
}

function run(home, args) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home), encoding: 'utf8' })
}

function runOk(home, args) {
  const result = run(home, args)
  assert.equal(result.status, 0, `advisers ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  return result
}

test('backup/export/import --replace/vault seal+unseal work on the durable fsync paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-durable-paths-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  try {
    runOk(home, ['commit', 'add', MESSAGE, '--quote', 'q'])

    // 1) `advisers backup <path>`: copy + fsyncFileSync(path) in bin backup().
    const backup = join(root, 'smoke-backup.db')
    runOk(home, ['backup', backup])
    assert.ok(existsSync(backup), 'backup file must exist')
    assert.ok(statSync(backup).size > 0, 'backup must be non-empty')
    assert.equal(statSync(backup).size, statSync(join(home, 'state.db')).size, 'backup must be a complete copy at checkpoint time')
    assert.equal(statSync(backup).mode & 0o777, 0o600, 'backup must stay private')

    // 2) `advisers export --out`: durable atomic write (temp file + fsync + rename).
    const exported = join(root, 'smoke-export.json')
    runOk(home, ['export', '--out', exported])
    assert.ok(existsSync(exported), 'export file must exist')
    assert.ok(statSync(exported).size > 0, 'export must be non-empty')
    const payload = JSON.parse(readFileSync(exported, 'utf8'))
    assert.ok(Array.isArray(payload.matters), 'export must contain the ledger matters array')

    // 3) `advisers import <export.json> --replace`: pre-import backup is
    //    copyFileWithRetrySync(DB, backup) + fsyncFileSync(backup) (bin:3939-3941).
    runOk(home, ['import', exported, '--replace'])
    const importBackups = readdirSync(home).filter((name) => name.startsWith('import-backup-') && name.endsWith('.db'))
    assert.equal(importBackups.length, 1, 'import must keep exactly its pre-import backup')
    assert.ok(statSync(join(home, importBackups[0])).size > 0, 'pre-import backup must be non-empty')

    // 4) `advisers vault seal --out <file>`: staged write, verified before commit.
    const vault = join(root, 'smoke-state.vault')
    runOk(home, ['vault', 'seal', '--out', vault])
    assert.ok(existsSync(vault), 'sealed vault must exist')
    assert.ok(statSync(vault).size > 0, 'sealed vault must be non-empty')

    // 5) `advisers vault unseal <file>`: pre-unseal copy + fsync (bin:5843-5850)
    //    used to fail on Windows; the ledger must survive the round trip.
    runOk(home, ['vault', 'unseal', vault])
    const unsealBackups = readdirSync(home).filter((name) => name.startsWith('state.db.before-unseal-'))
    assert.ok(unsealBackups.length >= 1, 'unseal must keep its pre-unseal backup')
    assert.ok(statSync(join(home, unsealBackups[0])).size > 0, 'pre-unseal backup must be non-empty')
    const commitList = runOk(home, ['commit', 'ls']).stdout
    assert.ok(commitList.includes(MESSAGE), 'the unsealed database must still contain the seeded commitment')

    // SQLite may create <temp>-wal/-shm while verifying the staged unseal image;
    // those are pre-existing plaintext artifacts reported by `vault status`, not
    // fs-safe temp files. Only the staged file itself and fs-safe ".tmp-*" names
    // must be gone after a successful commit.
    const tempResidue = readdirSync(home).filter((name) =>
      name.includes('.tmp-') ||
      (name.startsWith('.state.db.unseal-') && !name.endsWith('-wal') && !name.endsWith('-shm')))
    assert.deepEqual(tempResidue, [], 'no fs-safe temp file may survive a successful durable write')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
