/**
 * Shared fixture for suites that spawn the CLI.
 *
 * Those suites exercise product behaviour, not the TOS consent gate. They start
 * from an already-accepted record so the gate stays inert and the existing audit
 * chain assertions (e.g. "verified (0 entries)") keep their meaning; the gate
 * itself is covered end-to-end by test/tos-gate.test.js (which never imports this
 * helper).
 *
 * ADVISERS_ACCEPT_TOS=1 is added as well, so a fresh home (or a future manifest
 * bump that invalidates the seeded record) still runs non-interactively instead
 * of failing with E_TOS_REQUIRED.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../lib/tos/manifest.json', import.meta.url)), 'utf8'))
const entry = (manifest.files ?? []).find((file) => file.source === manifest.canonical) ?? (manifest.files ?? [])[0]

/** Seed HOME/tos.json with the current packaged TOS version/hash (no audit row). */
export function seedAcceptedTos(home) {
  if (!entry?.sha256) throw new Error('packaged TOS manifest is missing the TOS file hash')
  const target = join(home, 'tos.json')
  if (existsSync(target)) return target
  mkdirSync(home, { recursive: true })
  writeFileSync(target, JSON.stringify({
    version: manifest.version,
    sha256: entry.sha256,
    acceptedAt: '2026-11-17T00:00:00.000Z',
    channel: 'interactive',
    nonInteractive: false,
  }) + '\n', { mode: 0o600 })
  return target
}

/** Build a spawn env that is already TOS-accepted (and non-TTY-safe). */
export function tosEnv(home, env = process.env) {
  seedAcceptedTos(home)
  return { ...env, ADVISERS_HOME: home, ADVISERS_ACCEPT_TOS: '1' }
}
