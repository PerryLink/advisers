/**
 * Shared spawn helpers for the 0.3.0 Wave 2 bin/ operations tests
 * (audit anchor, backup/restore, doctor --repair, status.contracts, export
 * anchor, TOS env hardening). Each test runs the real CLI against a throwaway
 * ADVISERS_HOME seeded with a current-TOS acceptance record (tos-fixture.js).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tosEnv } from './tos-fixture.js'

export const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

export function makeHome(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-ops-' + prefix + '-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home }
}

export function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

export function cliEnv(home, extra = {}) {
  const base = {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_STORE: 'sqlite',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_YES: '1',
  }
  delete base.ADVISERS_MODEL
  delete base.ADVISERS_BASE_URL
  delete base.ADVISERS_TOS_VERSION
  delete base.ADVISERS_AUDIT_KEY
  return tosEnv(home, { ...base, ...extra })
}

export function runCli(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: cliEnv(home, extra), encoding: 'utf8' })
}

export function runOk(home, args, extra = {}) {
  const result = runCli(home, args, extra)
  if (result.status !== 0) {
    throw new Error('advisers ' + args.join(' ') + ' exited ' + result.status + '\nstdout: ' + result.stdout + '\nstderr: ' + result.stderr)
  }
  return result
}

export function jsonOf(result) {
  return JSON.parse(result.stdout)
}

export function auditJson(home) {
  return jsonOf(runOk(home, ['audit', '--json']))
}

export function seedCommitment(home, action = '发报价') {
  return runOk(home, ['commit', 'add', action, '--quote', 'q'])
}
