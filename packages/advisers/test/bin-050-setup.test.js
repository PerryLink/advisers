/**
 * 0.5.0 (050-U2, 126 门 5): the non-TTY `setup` matrix.
 *
 * Acceptance: fresh `setup --json --yes --accept-tos --no-demo` exits 0 and
 * creates HOME/audit.key/state.db/soul/tos.json; without TOS acceptance the same
 * apply exits 3 with stdout empty and HOME byte-empty (its own read-only gate,
 * not the global one); `--dry-run` prints a plan and writes nothing; a bare
 * `setup --json` is E_USAGE; a second run is idempotent (tos/init skipped).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1' }

function makeRoot() { return mkdtempSync(join(tmpdir(), 'advisers-050-setup-')) }
function run(root, args, extra = {}) {
  const env = { ...process.env, ...BASE_ENV, ...extra }
  delete env.ADVISERS_ACCEPT_TOS
  if (extra.ADVISERS_ACCEPT_TOS !== undefined) env.ADVISERS_ACCEPT_TOS = extra.ADVISERS_ACCEPT_TOS
  return spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', input: '', timeout: 120000 })
}
function json(result) { return JSON.parse(result.stdout) }

test('setup fresh apply with --accept-tos exits 0 and creates the home', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  try {
    const result = run(root, ['setup', '--json', '--yes', '--accept-tos', '--no-demo'], { ADVISERS_HOME: home })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    const payload = json(result)
    assert.equal(payload.ok, true)
    assert.equal(payload.command, 'setup')
    assert.equal(payload.mode, 'applied')
    assert.equal(payload.tos.accepted, true)
    assert.equal(payload.soul.present, true)
    assert.ok(Array.isArray(payload.steps) && payload.steps.some((step) => step.id === 'init'))
    assert.ok(payload.next.length >= 1, 'setup must suggest next commands')
    for (const name of ['audit.key', 'state.db', 'soul.md', 'tos.json']) {
      assert.ok(existsSync(join(home, name)), 'setup must create ' + name)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('setup without TOS acceptance exits 3 with an empty HOME (read-only gate)', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  try {
    const result = run(root, ['setup', '--json', '--yes', '--no-demo'], { ADVISERS_HOME: home })
    assert.equal(result.status, 3, result.stdout + result.stderr)
    assert.equal(result.stdout, '', 'the TOS refusal must keep stdout empty')
    assert.match(result.stderr, /E_TOS_REQUIRED/)
    assert.equal(existsSync(home), false, 'a refused setup must not create HOME')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('setup --dry-run plans without writing, even without TOS acceptance', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  try {
    const result = run(root, ['setup', '--dry-run', '--json'], { ADVISERS_HOME: home })
    assert.equal(result.status, 0, result.stderr)
    const payload = json(result)
    assert.equal(payload.mode, 'plan')
    assert.ok(Array.isArray(payload.wouldWrite) && payload.wouldWrite.length > 0, 'the plan lists wouldWrite')
    assert.ok(payload.wouldWrite.includes(home), 'the plan names the HOME it would create')
    assert.equal(existsSync(home), false, '--dry-run must not create HOME')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('setup without --yes is E_USAGE; the second apply is idempotent', () => {
  const root = makeRoot()
  const home = join(root, 'home')
  try {
    const bare = run(root, ['setup', '--json'], { ADVISERS_HOME: home })
    assert.equal(bare.status, 1)
    assert.equal(bare.stdout, '')
    assert.match(bare.stderr, /E_USAGE/)
    assert.equal(existsSync(home), false)

    const first = run(root, ['setup', '--json', '--yes', '--accept-tos', '--no-demo'], { ADVISERS_HOME: home })
    assert.equal(first.status, 0, first.stderr)
    const filesBefore = readdirSync(home).sort().join(',')
    const second = run(root, ['setup', '--json', '--yes', '--accept-tos', '--no-demo'], { ADVISERS_HOME: home })
    assert.equal(second.status, 0, second.stderr)
    const payload = json(second)
    const status = Object.fromEntries(payload.steps.map((step) => [step.id, step.status]))
    assert.equal(status.tos, 'skipped', 'a second setup must not re-accept the TOS')
    assert.equal(status.init, 'skipped', 'a second setup must not rewrite HOME files')
    assert.equal(readdirSync(home).sort().join(','), filesBefore, 'the second run adds no files')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
