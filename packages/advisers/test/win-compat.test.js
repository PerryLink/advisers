// Unit tests for the Windows/POSIX fixture helpers (win-compat.mjs).
//
// These tests exercise BOTH platform branches on every host: the Windows
// branches are simulated by passing platform = 'win32' to the helper, so the
// conditional-skip logic is covered by the Linux/macOS CI run too (the real
// Windows job then checks the actual stat()/symlink()/spawn() behaviour).

import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  IS_WINDOWS,
  assertPrivateMode,
  isWindows,
  posixMode,
  rmrf,
  skipOnWindows,
  spawnNode,
  spawnNodeSync,
  symlinkOrSkip,
  symlinkUnsupportedReason,
  trySymlink,
} from './win-compat.mjs'

function makeDir(prefix = 'advisers-win-compat-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('win-compat: IS_WINDOWS mirrors process.platform and isWindows() can be forced', () => {
  assert.equal(IS_WINDOWS, process.platform === 'win32')
  assert.equal(isWindows(), IS_WINDOWS)
  assert.equal(isWindows('win32'), true)
  assert.equal(isWindows('linux'), false)
  assert.equal(isWindows('darwin'), false)
})

test('win-compat: posixMode returns bits on POSIX and null on Windows', () => {
  const dir = makeDir()
  try {
    const file = join(dir, 'private.txt')
    writeFileSync(file, 'x')
    try { chmodSync(file, 0o600) } catch {}
    const actual = posixMode(file, 'linux')
    assert.equal(typeof actual, 'number')
    if (!IS_WINDOWS) assert.equal(actual, 0o600)
    assert.equal(posixMode(file, 'win32'), null)
    assert.equal(posixMode(file), IS_WINDOWS ? null : 0o600)
    assert.throws(() => posixMode(join(dir, 'missing.txt'), 'win32'), /ENOENT/)
  } finally { rmrf(dir) }
})

test('win-compat: assertPrivateMode keeps the POSIX assertion and relaxes on Windows', () => {
  const dir = makeDir()
  try {
    const file = join(dir, 'private.txt')
    writeFileSync(file, 'x')
    try { chmodSync(file, 0o600) } catch {}
    // The real-platform call: POSIX asserts 0600, Windows asserts existence/kind.
    assertPrivateMode(file, 0o600, 'private file')
    // The Windows branch must not throw even when the (simulated 0666) mode differs.
    assertPrivateMode(file, 0o600, 'private file', 'win32')
    // Windows still checks the expected kind, so a directory fails the file assertion.
    assert.throws(() => assertPrivateMode(dir, 0o600, 'not a file', 'win32'), /must be a regular file/)
    assertPrivateMode(dir, 0o700, 'dir', 'win32')
    // On POSIX a wrong mode is a hard failure (the original behaviour is preserved).
    if (!IS_WINDOWS) {
      try { chmodSync(file, 0o644) } catch {}
      assert.throws(() => assertPrivateMode(file, 0o600, 'relaxed file', 'linux'), /must be 0600/)
    }
    assert.throws(() => assertPrivateMode(join(dir, 'missing.txt'), 0o600), /ENOENT/)
  } finally { rmrf(dir) }
})

test('win-compat: symlinkUnsupportedReason only classifies Windows privilege errors', () => {
  const eperm = Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' })
  const eacces = Object.assign(new Error('EACCES: permission denied, symlink'), { code: 'EACCES' })
  const enoent = Object.assign(new Error('ENOENT: no such file or directory, symlink'), { code: 'ENOENT' })
  assert.match(symlinkUnsupportedReason(eperm, 'win32'), /SeCreateSymbolicLinkPrivilege/)
  assert.match(symlinkUnsupportedReason(eacces, 'win32'), /SeCreateSymbolicLinkPrivilege/)
  assert.equal(symlinkUnsupportedReason(eperm, 'linux'), null)
  assert.equal(symlinkUnsupportedReason(enoent, 'win32'), null, 'a missing target is a fixture bug, not a platform limitation')
  assert.equal(symlinkUnsupportedReason(null, 'win32'), null)
})

test('win-compat: trySymlink creates a link where the platform allows it and reports the Windows privilege refusal', async (t) => {
  const dir = makeDir()
  try {
    const target = join(dir, 'target.txt')
    writeFileSync(target, 'target')
    const link = join(dir, 'link.txt')
    const result = trySymlink(target, link)
    if (!result.ok) {
      assert.equal(IS_WINDOWS, true, 'a POSIX host must be able to create the fixture symlink: ' + result.reason)
      assert.match(result.reason, /SeCreateSymbolicLinkPrivilege/)
      t.diagnostic('symlink privilege unavailable on this Windows host: ' + result.reason)
      return
    }
    assert.equal(lstatSync(link).isSymbolicLink(), true)
    assert.equal(readFileSync(link, 'utf8'), 'target')
  } finally { rmrf(dir) }
})

test('win-compat: symlinkOrSkip returns true and creates the link when supported', async (t) => {
  const dir = makeDir()
  try {
    const target = join(dir, 'target.txt')
    writeFileSync(target, 'target')
    const probeLink = join(dir, 'probe-link.txt')
    const capability = trySymlink(target, probeLink)
    if (!capability.ok) {
      if (IS_WINDOWS) return t.skip('Windows without SeCreateSymbolicLinkPrivilege: ' + capability.reason)
      throw new Error('unexpected symlink failure on POSIX: ' + capability.reason)
    }
    rmSync(probeLink, { force: true })
    const link = join(dir, 'link.txt')
    assert.equal(symlinkOrSkip(t, target, link), true)
    assert.equal(lstatSync(link).isSymbolicLink(), true)
  } finally { rmrf(dir) }
})

test('win-compat: skipOnWindows only skips on Windows and carries the audit reason', () => {
  const skipped = []
  const fakeTest = { skip: (message) => skipped.push(message) }
  assert.equal(skipOnWindows(fakeTest, 'adapter probe', 'win32'), true)
  assert.equal(skipped.length, 1)
  assert.match(skipped[0], /^Windows: adapter probe/)
  assert.equal(skipOnWindows(fakeTest, 'adapter probe', 'linux'), false)
  assert.equal(skipped.length, 1, 'POSIX must run the test body, not skip it')
})

test('win-compat: rmrf removes a tree a read-only chmod fixture made undeletable', () => {
  const dir = makeDir()
  const nested = join(dir, 'nested', 'deeper')
  mkdirSync(nested, { recursive: true })
  const file = join(nested, 'readonly.bin')
  writeFileSync(file, 'x')
  // A POSIX chmod(0o400) / Windows read-only attribute fixture; on Windows
  // plain rmSync would report EPERM without clearing the attribute first.
  try { chmodSync(file, 0o400) } catch {}
  rmrf(dir)
  assert.equal(existsSync(dir), false)
  // The simulated Windows branch (chmod walk) must work on any host too.
  const dir2 = makeDir('advisers-win-compat-win-')
  mkdirSync(join(dir2, 'sub'), { recursive: true })
  writeFileSync(join(dir2, 'sub', 'plain.txt'), 'x')
  rmrf(dir2, 'win32')
  assert.equal(existsSync(dir2), false)
})

test('win-compat: spawnNode/spawnNodeSync run a Node script with process.execPath', async () => {
  const dir = makeDir()
  try {
    const script = join(dir, 'argv-probe.mjs')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n"); process.exit(0)\n')
    const child = spawnNode(script, ['alpha', 'beta'], { stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.deepEqual(JSON.parse(stdout), ['alpha', 'beta'])
    const sync = spawnNodeSync(script, ['gamma'], { encoding: 'utf8' })
    assert.equal(sync.status, 0)
    assert.deepEqual(JSON.parse(sync.stdout), ['gamma'])
  } finally { rmrf(dir) }
})
