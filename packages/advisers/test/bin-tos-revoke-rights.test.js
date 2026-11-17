import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'

// Privacy audit P2-5 (TOS §2.1 / §9.8): after revoking consent the data-rights
// commands (audit/export/privacy/purge) and tos itself must stay available;
// otherwise the user must re-consent before exporting or deleting their own
// local data. Gated model/ledger writes stay blocked (exit 3).

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

test('bin tos: revoke keeps data-rights commands usable and still gates normal commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-tos-rights-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const baseEnv = tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_STORE: 'sqlite', ADVISERS_NO_MODEL: '1' })
  const run = (args, env = baseEnv) => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' })
  try {
    assert.equal(run(['commit', 'add', '发报价', '--quote', 'q']).status, 0)
    const matterId = run(['ls']).stdout.trim().split(/\s+/)[0]
    assert.match(matterId, /^matter_/)

    const revoked = run(['tos', 'revoke', '--yes'])
    assert.equal(revoked.status, 0)
    assert.match(revoked.stdout, /撤回|revoke/i)

    // The env must no longer carry consent: every command below runs on its own.
    const noConsent = { ...baseEnv }
    delete noConsent.ADVISERS_ACCEPT_TOS
    const exportFile = join(root, 'export.json')
    const rights = [
      ['audit'],
      ['privacy', '--prove'],
      ['privacy', '--json'],
      ['export', '--out', exportFile],
      ['purge', matterId, '--yes'],
      ['tos', 'status'],
    ]
    for (const args of rights) {
      const result = run(args, noConsent)
      assert.equal(result.status, 0, `advisers ${args.join(' ')} must not be blocked after revoke\n${result.stderr}`)
    }
    assert.ok(existsSync(exportFile), 'export --out must produce the data-rights file after revoke')

    const gated = run(['commit', 'ls'], noConsent)
    assert.equal(gated.status, 3, 'gated commands stay blocked after revoke')
    assert.match(gated.stderr, /E_TOS_REQUIRED/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
