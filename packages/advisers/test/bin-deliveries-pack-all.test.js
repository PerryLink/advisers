import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'

// Performance audit P1-1: `deliveries --pack` capped at 2000 entries, and the
// documented `--all` escape hatch was parsed but never passed to
// buildEvidencePack(), so large ledgers always failed. Default must now fail
// with a hint; `--all` must build the full pack.

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function env(home) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_STORE: 'sqlite', ADVISERS_NO_MODEL: '1' })
}
function run(home, args) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home), encoding: 'utf8' })
}

test('bin deliveries --pack: default cap fails with a hint and --all builds the full pack', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-pack-all-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  try {
    const store = new SqliteStore(join(home, 'state.db'))
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: '大包测试' })
    for (let index = 0; index < 2001; index += 1) {
      ledger.addCommitment({ matterId: matter.id, debtor: 'user', creditor: '王工', action: '任务' + index, capability: 'todo', evidence: [{ sessionId: 'conv', turnId: 'turn', quote: 'q' }] })
    }
    store.save(ledger.toJSON())
    store.close?.()

    const cappedDir = join(root, 'capped')
    const capped = run(home, ['deliveries', '--pack', '--out', cappedDir])
    assert.equal(capped.status, 1, capped.stderr)
    assert.match(capped.stderr, /evidence pack would include 2001 entries \(limit 2000\)/)
    assert.match(capped.stderr, /--all/)
    assert.match(capped.stderr, /hint: /)
    assert.equal(existsSync(cappedDir), false, 'a capped pack must not leave a partial directory')

    const allDir = join(root, 'all')
    const all = run(home, ['deliveries', '--pack', '--out', allDir, '--all'])
    assert.equal(all.status, 0, all.stderr)
    const payload = JSON.parse(all.stdout)
    assert.equal(payload.verification.ok, true)
    assert.ok(existsSync(join(allDir, 'manifest.json')))
    assert.ok(existsSync(join(allDir, 'SHA256SUMS')))
    const manifest = JSON.parse(readFileSync(join(allDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.entryCount, 2001)
    assert.equal(manifest.entries.length, 2001)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
