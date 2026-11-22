/**
 * 0.5.0 (050-U2, 126 门 5): `advisers demo` isolation.
 *
 * Acceptance: `demo --json` exits 0, runs seven steps in an isolated temp HOME,
 * never touches the real HOME (state.db sha256 + file list unchanged), emits a
 * subject-scoped receipt and a copyable next[] list, and `--clean` refuses a
 * non-TTY run (three-phase delete needs interactive confirmation).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const BASE_ENV = { ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_ACCEPT_TOS: '1' }

function makeHome() { return mkdtempSync(join(tmpdir(), 'advisers-050-demo-real-')) }
function run(home, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, ...BASE_ENV, ADVISERS_HOME: home },
    encoding: 'utf8', input: '', timeout: 180000,
  })
}
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

test('demo --json runs the synthetic one-deal flow in an isolated home', () => {
  const home = makeHome()
  let demoHome = null
  try {
    const init = run(home, ['init'])
    assert.equal(init.status, 0, init.stderr)
    const seed = run(home, ['commit', 'add', '真实数据', '--quote', 'q'])
    assert.equal(seed.status, 0, seed.stderr)
    const dbBefore = sha256File(join(home, 'state.db'))
    const filesBefore = readdirSync(home).sort().join(',')

    const result = run(home, ['demo', '--json'])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    demoHome = payload.demoHome
    assert.equal(payload.ok, true)
    assert.equal(payload.command, 'demo')
    assert.ok(demoHome && demoHome !== home, 'demo must use its own home')
    assert.equal(existsSync(demoHome), true)
    const ids = payload.steps.map((step) => step.id)
    for (const id of ['client', 'quote', 'proposal', 'notice', 'receipt', 'receivable', 'remind', 'verify']) {
      assert.ok(ids.includes(id), 'demo step missing: ' + id)
    }
    assert.ok(payload.steps.every((step) => step.status === 'applied'), 'every demo step applies')
    assert.ok(Array.isArray(payload.artifacts) && payload.artifacts.length >= 7)
    assert.equal(payload.receipt.scope, 'subject')
    assert.match(payload.receipt.manifestDigest, /^[0-9a-f]{64}$/)
    assert.ok(Array.isArray(payload.next) && payload.next.length >= 3, 'demo must print copyable next commands')

    // The real HOME is byte-identical after the demo.
    assert.equal(sha256File(join(home, 'state.db')), dbBefore, 'demo must not write the real state.db')
    assert.equal(readdirSync(home).sort().join(','), filesBefore, 'demo must not add files to the real HOME')
  } finally {
    if (demoHome && demoHome.startsWith(tmpdir())) rmSync(demoHome, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('demo --clean refuses a non-TTY run before creating anything', () => {
  const home = makeHome()
  try {
    const result = run(home, ['demo', '--json', '--clean'])
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stderr, /E_USAGE/)
    assert.match(result.stderr, /--clean/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
