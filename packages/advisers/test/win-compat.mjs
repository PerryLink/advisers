// Windows/POSIX fixture compatibility helpers.
//
// Origin: the 0.4.0 Windows full-suite triage
// (01-research/advisers-hardening-2026-11-17/04-0.4-implementation/50-windows-triage.md,
// section 3). The Windows CI job runs the same test files as Linux/macOS, but
// several fixtures encode POSIX-only assumptions: permission bits (Windows uses
// ACLs; stat() reports 0666/0777), symlink creation needs
// SeCreateSymbolicLinkPrivilege, a POSIX-shell shebang script cannot be executed
// by child_process.spawn, and the read-only directory/read-only-file fixtures
// cannot be expressed with chmod(). The helpers below keep those differences in
// one place and make every conditional skip carry an auditable reason.
//
// This module is test-only. It is not shipped (packages/advisers/package.json
// `files` lists lib/, bin/ and the package docs only) and it is not picked up by
// the test runner glob (test/*.test.js). Keep it dependency-free and CommonJS
// ESM only (no build step): tests import it with `./win-compat.mjs`.
//
// The `platform` arguments exist so the Windows/POSIX branches can be unit-tested
// on any host (win-compat.test.js forces 'win32' on Linux and 'linux' on
// Windows). Production callers should omit them.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

export const IS_WINDOWS = process.platform === 'win32'

/** True on Windows. The optional platform argument is for unit tests. */
export function isWindows(platform = process.platform) {
  return platform === 'win32'
}

/**
 * POSIX permission bits of a path (e.g. 0o600), or null when the platform has no
 * POSIX mode bits (Windows: stat().mode is synthesised, ACLs are the real
 * protection). Existence is always asserted because statSync throws ENOENT.
 */
export function posixMode(file, platform = process.platform) {
  const stat = statSync(file)
  if (isWindows(platform)) return null
  return stat.mode & 0o777
}

/**
 * Assert that a fixture-created file/directory has the intended private POSIX
 * mode. On Windows only existence and the expected kind (file vs directory) are
 * asserted: fs.chmod() cannot express POSIX permissions there and the test
 * suite's 0600/0700 contract is POSIX-only (docs/WINDOWS.md section 6).
 */
export function assertPrivateMode(file, expectedMode, label = 'file', platform = process.platform) {
  const stat = statSync(file)
  if (isWindows(platform)) {
    assert.equal(typeof stat.mode, 'number', label + ' exists')
    if (expectedMode === 0o700) assert.equal(stat.isDirectory(), true, label + ' must be a directory')
    else assert.equal(stat.isFile(), true, label + ' must be a regular file')
    return
  }
  const actual = stat.mode & 0o777
  assert.equal(actual, expectedMode, label + ' must be 0' + expectedMode.toString(8) + ' (actual 0' + actual.toString(8) + ')')
}

/**
 * Why a symlink fixture could not be created, or null when the error is not the
 * Windows privilege limitation. Windows without Developer Mode or elevation
 * rejects fs.symlinkSync with EPERM (EACCES in some locales/hardening) because
 * creating links is SeCreateSymbolicLinkPrivilege.
 */
export function symlinkUnsupportedReason(error, platform = process.platform) {
  if (!isWindows(platform)) return null
  const code = error && error.code
  if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') {
    return 'symlink fixture needs SeCreateSymbolicLinkPrivilege (Developer Mode or an elevated shell); fs.symlinkSync failed with ' + code
  }
  return null
}

/**
 * Create a symlink, or report { ok:false, reason } when Windows refuses the
 * privilege. Other errors (e.g. ENOENT for a missing target) are re-thrown: they
 * are fixture bugs, not platform differences.
 */
export function trySymlink(target, path, type = 'file', platform = process.platform) {
  try {
    symlinkSync(target, path, type)
    return { ok: true }
  } catch (error) {
    const reason = symlinkUnsupportedReason(error, platform)
    if (reason) return { ok: false, reason }
    throw error
  }
}

/**
 * Create a symlink or mark the current node:test test skipped with an auditable
 * reason. Returns false when the test was skipped, so callers write:
 *   if (!symlinkOrSkip(t, target, path)) return
 */
export function symlinkOrSkip(t, target, path, type = 'file', platform = process.platform) {
  const result = trySymlink(target, path, type, platform)
  if (result.ok) return true
  t.skip('Windows: ' + result.reason)
  return false
}

/**
 * Skip the current node:test test on Windows for a platform/product limitation a
 * fixture cannot fix (e.g. an external adapter command is a single executable
 * path on Windows; POSIX shebang probes cannot run there). Returns true when the
 * test was skipped, so callers write:
 *   if (skipOnWindows(t, 'reason tracked in the windows triage')) return
 */
export function skipOnWindows(t, reason, platform = process.platform) {
  if (!isWindows(platform)) return false
  t.skip('Windows: ' + reason)
  return true
}

/**
 * rm -rf with bounded retries. On Windows a chmod(0o400/0o000) fixture can leave
 * the read-only attribute behind, which rmSync reports as EPERM, so clear it
 * first. Used by tests that clean up a directory they made read-only.
 */
export function rmrf(dir, platform = process.platform) {
  if (isWindows(platform)) {
    for (const entry of walk(dir)) {
      try { chmodSync(entry.path, entry.dir ? 0o700 : 0o600) } catch {}
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

function walk(dir) {
  const out = [{ path: dir, dir: true }]
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      out.push({ path: absolute, dir: entry.isDirectory() })
      if (entry.isDirectory()) out.push(...walk(absolute))
    }
  } catch {}
  return out
}

/**
 * Spawn a Node script through process.execPath. Works on POSIX and Windows
 * without a shebang or an executable bit (child_process.spawn cannot execute
 * .sh/.js scripts directly on Windows: EFTYPE/EINVAL).
 */
export function spawnNode(scriptPath, args = [], options = {}) {
  return spawn(process.execPath, [scriptPath, ...args], options)
}

/** spawnSync counterpart of spawnNode(). */
export function spawnNodeSync(scriptPath, args = [], options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], options)
}
