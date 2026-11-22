/**
 * 0.5.0 (050-S1.3, 121 §3): additive `backup{}` in `doctor --check-db --json`.
 *
 * The block is read-only and never changes the doctor exit code: a fresh home with
 * user rows and zero backups stays `ok:true` and reports status 'none' with a
 * warning; after `backups` writes a managed copy it reports status 'ok' with a
 * readable newestManaged entry; plain `doctor --json` (no --check-db) keeps its
 * 0.4.3 shape (no backup key).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_ACCEPT_TOS: '1' }

function makeHome() { return mkdtempSync(join(tmpdir(), 'advisers-050-doctor-')) }
function run(home, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home },
    encoding: 'utf8', input: '', timeout: 120000,
  })
}
function ok(result, label) {
  assert.equal(result.status, 0, label + ': ' + (result.stderr || result.stdout))
  return result
}
function json(result) { return JSON.parse(result.stdout) }

test('doctor --check-db --json reports backup freshness without changing the exit code', () => {
  const home = makeHome()
  try {
    ok(run(home, ['commit', 'add', '有一条用户数据', '--quote', 'q']), 'seed')
    const before = json(ok(run(home, ['doctor', '--check-db', '--json']), 'doctor --check-db'))
    assert.equal(before.ok, true, 'zero backups must not turn doctor red')
    assert.equal(typeof before.backup, 'object', 'backup{} must be additive under --check-db')
    assert.equal(before.backup.status, 'none')
    assert.equal(before.backup.managedCount, 0)
    assert.ok(Array.isArray(before.backup.warnings) && before.backup.warnings.length > 0, 'user rows without a backup must warn')
    assert.ok(Array.isArray(before.backup.errors))

    ok(run(home, ['backup']), 'managed backup')
    const after = json(ok(run(home, ['doctor', '--check-db', '--json']), 'doctor after backup'))
    assert.equal(after.ok, true)
    assert.equal(after.backup.status, 'ok')
    assert.ok(after.backup.managedCount >= 1)
    assert.ok(after.backup.newestManaged && after.backup.newestManaged.path, 'newestManaged names the copy')
    assert.equal(after.backup.newestManaged.readable, true)

    // Human mode adds exactly one backup line.
    const human = ok(run(home, ['doctor', '--check-db']), 'doctor human')
    const backupLines = human.stdout.split(String.fromCharCode(10)).filter((line) => line.startsWith('backup  status='))
    assert.equal(backupLines.length, 1, 'human --check-db prints one backup line')

    // Without --check-db the 0.4.3 shape is unchanged (no backup key).
    const plain = json(ok(run(home, ['doctor', '--json']), 'doctor --json'))
    assert.equal(Object.prototype.hasOwnProperty.call(plain, 'backup'), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
