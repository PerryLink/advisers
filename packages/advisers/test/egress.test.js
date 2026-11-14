import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { egressDeniedReason, secrecyLevel } from '../lib/egress.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

test('egress guard treats numeric secrecy levels as protected (fail closed)', () => {
  assert.equal(secrecyLevel({ secrecy: 0 }), 0)
  assert.equal(secrecyLevel({ secrecy: 2 }), 2)
  assert.equal(secrecyLevel({}), 0)
  assert.equal(egressDeniedReason({ secrecy: 0 }, 'research'), null)
  assert.match(egressDeniedReason({ secrecy: 2 }, 'research'), /protected matters/)
  // A malformed value must not silently pass a protected matter through.
  assert.match(egressDeniedReason({ secrecy: 'secret' }, 'research'), /invalid/)
  assert.match(egressDeniedReason(undefined, 'research'), /not found/)
})

test('research CLI refuses a protected matter before any network call', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-egress-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  const now = new Date().toISOString()
  const matter = {
    id: 'matter_secret',
    title: '秘密客户',
    status: 'active',
    domain: 'general',
    secrecy: 2,
    participants: [],
    deadlines: [],
    openQuestions: [],
    createdAt: now,
    updatedAt: now,
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    matters: [matter],
    facts: [],
    commitments: [],
    preferences: [],
    links: [],
    updates: [],
    routes: {},
    routines: [],
    routinePatches: [],
  }))
  try {
    assert.throws(
      () => execFileSync(process.execPath, [bin, 'research', '--web', '敏感问题'], {
        cwd: work,
        env: {
          ...process.env,
          ADVISERS_HOME: home,
          ADVISERS_STORE: 'json',
          ADVISERS_CORE_LOCAL: '1',
          ADVISERS_OFFICE_LOCAL: '1',
          ADVISERS_NO_MODEL: '1',
          ADVISERS_API_KEY: 'test-key-not-used',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      (error) => /protected matters/.test(String(error.stderr)),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
