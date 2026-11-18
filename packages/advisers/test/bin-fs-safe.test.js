import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'

// 0.2.3 Wave 1 (robustness audit P1-2): bin durable writes go through
// lib/fs-safe.js. A short write/ENOSPC must fail the command instead of
// installing a truncated file, and the temp file must be removed. The mock fs
// below is injected with NODE_OPTIONS=--require and only short-writes files
// whose path contains the fs-safe ".tmp-" marker (identified via /proc/self/fd).
// Tests that need it are skipped on platforms without /proc/self/fd.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const PASSPHRASE = 'correct horse battery'
const HAS_PROC_FD = process.platform === 'linux' && existsSync('/proc/self/fd')

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

function run(home, args, extra = {}, cwd = process.cwd()) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, env: env(home, extra), encoding: 'utf8' })
}

function runOk(home, args, extra = {}, cwd = process.cwd()) {
  const result = run(home, args, extra, cwd)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}

const PRELOAD = [
  "const fs = require('fs')",
  "const MODE = process.env.ADVISERS_TEST_FS_WRITE || ''",
  "if (MODE) {",
  "  const orig = fs.writeSync",
  "  fs.writeSync = function (fd, buffer, offset, length) {",
  "    let target = ''",
  "    try { target = fs.readlinkSync('/proc/self/fd/' + fd) } catch {}",
  "    const isTemp = String(target).includes('.tmp-') || String(target).includes('.state.db.unseal-')",
  "    const off = typeof offset === 'number' ? offset : 0",
  "    const len = typeof length === 'number' ? length : buffer.length - off",
  "    if (isTemp && MODE === 'zero') return 0",
  "    if (isTemp && (MODE === 'halve' || MODE === 'lie')) {",
  "      if (len <= 1) return orig.call(fs, fd, buffer, off, len)",
  "      const half = Math.max(1, Math.floor(len / 2))",
  "      const wrote = orig.call(fs, fd, buffer, off, half)",
  "      return MODE === 'lie' ? buffer.length - off : wrote",
  "    }",
  "    return orig.apply(fs, arguments)",
  "  }",
  "  require('module').syncBuiltinESMExports()",
  "}",
  '',
].join('\n')

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-fs-safe-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home }
}

function seededHome() {
  const made = makeHome()
  runOk(made.home, ['commit', 'add', '发报价给王工', '--quote', 'q'])
  return made
}

function mockEnv(root, mode) {
  const preload = join(root, 'mock-fs-write.cjs')
  writeFileSync(preload, PRELOAD)
  return { NODE_OPTIONS: '--require ' + preload, ADVISERS_TEST_FS_WRITE: mode }
}

function homeTempFiles(home) {
  return readdirSync(home).filter((name) => name.includes('.tmp-') || name.startsWith('.advisers-pull-verify-'))
}

test('vault seal survives truthful short writes (the write loop completes the file)', { skip: !HAS_PROC_FD }, () => {
  const { root, home } = seededHome()
  try {
    runOk(home, ['vault', 'seal'], { ...mockEnv(root, 'halve'), ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    assert.ok(existsSync(join(home, 'state.db.vault')), 'the sealed file must be installed')
    assert.deepEqual(homeTempFiles(home), [], 'no temp file may survive a successful seal')
    // Prove the sealed bytes are complete by unsealing and reading the ledger.
    runOk(home, ['vault', 'unseal'], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    assert.match(runOk(home, ['commit', 'ls']).stdout, /发报价给王工/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('vault seal refuses a short write: exit 1, no truncated vault, temp removed, database intact', { skip: !HAS_PROC_FD }, () => {
  const { root, home } = seededHome()
  try {
    for (const mode of ['lie', 'zero']) {
      const result = run(home, ['vault', 'seal'], { ...mockEnv(root, mode), ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
      assert.equal(result.status, 1, mode + ': a short write must fail the command: ' + result.stderr)
      assert.match(result.stderr, /E_SHORT_WRITE/)
      assert.equal(existsSync(join(home, 'state.db.vault')), false, mode + ': no truncated vault may be installed')
      assert.deepEqual(homeTempFiles(home), [], mode + ': the staged temp file must be removed')
      assert.match(runOk(home, ['commit', 'ls']).stdout, /发报价给王工/, mode + ': the plaintext database must be intact')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('vault unseal short write leaves the sealed file intact and installs no partial database', { skip: !HAS_PROC_FD }, () => {
  const { root, home } = seededHome()
  try {
    runOk(home, ['vault', 'seal', '--remove'], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    assert.equal(existsSync(join(home, 'state.db')), false)
    const result = run(home, ['vault', 'unseal'], { ...mockEnv(root, 'lie'), ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /E_SHORT_WRITE/)
    assert.ok(existsSync(join(home, 'state.db.vault')), 'the sealed file must be untouched')
    assert.equal(existsSync(join(home, 'state.db')), false, 'no partial database may be installed')
    assert.deepEqual(readdirSync(home).filter((name) => name.startsWith('.state.db.unseal-')), [], 'the unseal temp file must be removed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('vault seal to an unusable target fails cleanly (rename failure removes the temp file)', () => {
  const { root, home } = seededHome()
  try {
    const target = join(home, 'out.vault')
    mkdirSync(target)
    const result = run(home, ['vault', 'seal', '--out', target], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    assert.equal(result.status, 1, result.stderr)
    assert.ok(statSync(target).isDirectory(), 'the pre-existing target must not be clobbered')
    assert.deepEqual(homeTempFiles(home), [], 'a failed commit must remove its temp file')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('export --out and pet-brief --out go through the durable writer (short write fails, no partial file)', { skip: !HAS_PROC_FD }, () => {
  const { root, home } = seededHome()
  try {
    const exportFile = join(root, 'export.json')
    const exportFailed = run(home, ['export', '--out', exportFile], mockEnv(root, 'zero'))
    assert.equal(exportFailed.status, 1, exportFailed.stderr)
    assert.match(exportFailed.stderr, /export failed/)
    assert.match(exportFailed.stderr, /E_SHORT_WRITE/)
    assert.equal(existsSync(exportFile), false, 'no truncated export may be installed')
    assert.deepEqual(readdirSync(root).filter((name) => name.includes('.tmp-')), [], 'the export temp file must be removed')

    const briefFile = join(root, 'pet-brief.json')
    const briefFailed = run(home, ['pet-brief', '--out', briefFile], mockEnv(root, 'zero'))
    assert.equal(briefFailed.status, 1, briefFailed.stderr)
    assert.match(briefFailed.stderr, /E_WRITE/)
    assert.equal(existsSync(briefFile), false, 'no truncated brief may be installed')
    assert.deepEqual(readdirSync(root).filter((name) => name.includes('.tmp-')), [], 'the pet-brief temp file must be removed')

    // The normal path still writes both files atomically with mode 600.
    runOk(home, ['export', '--out', exportFile])
    assert.equal(statSync(exportFile).mode & 0o777, 0o600)
    runOk(home, ['pet-brief', '--out', briefFile])
    assert.equal(statSync(briefFile).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('backup/import copies use the retrying fs helpers and fail closed on an unwritable target', () => {
  const { root, home } = seededHome()
  try {
    const backupFile = join(root, 'backup.db')
    runOk(home, ['backup', backupFile])
    assert.equal(statSync(backupFile).size, statSync(join(home, 'state.db')).size)
    assert.equal(statSync(backupFile).mode & 0o777, 0o600)

    const lockedDir = join(root, 'locked')
    mkdirSync(lockedDir, { mode: 0o500 })
    try {
      const failed = run(home, ['backup', join(lockedDir, 'b.db')])
      assert.equal(failed.status, 1, failed.stderr)
      assert.match(failed.stderr, /backup failed/)
      assert.equal(existsSync(join(lockedDir, 'b.db')), false, 'no partial backup may be left behind')
    } finally {
      chmodSync(lockedDir, 0o700)
    }

    // import --replace writes a pre-import backup (copy + fsync) before saving.
    const exportFile = join(root, 'ledger.json')
    runOk(home, ['export', '--out', exportFile])
    runOk(home, ['import', exportFile, '--replace'])
    const backups = readdirSync(home).filter((name) => name.startsWith('import-backup-'))
    assert.equal(backups.length, 1, 'import must keep its pre-import backup')
    assert.ok(statSync(join(home, backups[0])).size > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
