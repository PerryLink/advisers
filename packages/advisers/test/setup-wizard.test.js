/**
 * 0.5.0 (WF5 050-U2a): lib/setup.js plan/apply, idempotency and TOS boundaries.
 *
 * These tests call the library directly (no bin), so the TOS contract is the
 * library contract: setup never writes tos.json and never writes a tos.* audit
 * row; bin owns the actual gate. A rejected TOS or a missing --yes must leave
 * the fresh HOME byte-empty, which is the acceptance in 124 §2.2 / 126 门 5.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SETUP_STEP_IDS,
  SetupError,
  buildSetupPlan,
  inspectSetupTos,
  runSetup,
  setupHumanLines,
  setupNextCards,
} from '../lib/setup.js'
import { currentTos, readManifest, writeAcceptance } from '../lib/tos/index.js'
import { assertPrivateMode } from './win-compat.mjs'

const ANSI = /\u001b\[/
const BASE_ENV = { ...process.env, ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1' }

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'advisers-setup-'))
}

/** Write a valid TOS acceptance record the way bin's gate records it. */
function acceptTos(home) {
  const info = currentTos({ version: readManifest().version })
  writeAcceptance(home, {
    version: info.version,
    sha256: info.sha256,
    acceptedAt: new Date().toISOString(),
    channel: 'flag',
    nonInteractive: true,
  })
  return info
}

function homeFiles(home) {
  try { return readdirSync(home).sort() } catch { return [] }
}

test('setup step ids and next-step cards match the 124 contract', () => {
  assert.deepEqual(SETUP_STEP_IDS, ['env', 'tos', 'init', 'model', 'mail', 'demo', 'next'])
  const cards = setupNextCards()
  assert.equal(cards.length, 3)
  for (const card of cards) {
    assert.equal(typeof card.label, 'string')
    assert.ok(card.command.startsWith('advisers '))
    assert.ok(card.label.length > 0)
  }
})

test('buildSetupPlan is a read-only plan: no HOME, no state.db, explicit wouldWrite', () => {
  const root = makeRoot()
  try {
    const home = join(root, 'fresh-home')
    const plan = buildSetupPlan({ home, env: { ...BASE_ENV, ADVISERS_HOME: home } })
    assert.equal(plan.ok, true)
    assert.equal(plan.mode, 'plan')
    assert.equal(plan.command, 'setup')
    assert.deepEqual(plan.steps.map((step) => step.id), [...SETUP_STEP_IDS])
    assert.equal(plan.steps.find((step) => step.id === 'init').status, 'planned')
    assert.equal(plan.steps.find((step) => step.id === 'env').status, 'planned')
    assert.equal(plan.steps.find((step) => step.id === 'demo').status, 'planned')
    assert.equal(plan.demo, null)
    assert.ok(Array.isArray(plan.wouldWrite))
    for (const expected of [home, join(home, 'audit.key'), join(home, 'state.db'), join(home, 'soul.md'), join(home, 'soul.meta.json')]) {
      assert.ok(plan.wouldWrite.includes(expected), 'wouldWrite must list ' + expected)
    }
    assert.equal(plan.doctor.ok, true)
    assert.equal(plan.tos.accepted, false)
    assert.equal(existsSync(home), false, 'plan must not create HOME')
    assert.deepEqual(readdirSync(root), [], 'plan must not write anything')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan reflects an accepted TOS and --no-demo without writing', () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    acceptTos(home)
    const plan = buildSetupPlan({ home, env: { ...BASE_ENV, ADVISERS_HOME: home }, options: { noDemo: true } })
    assert.equal(plan.tos.accepted, true)
    assert.equal(plan.tos.channel, 'flag')
    assert.match(plan.steps.find((step) => step.id === 'tos').detail, /已接受/)
    assert.equal(plan.steps.find((step) => step.id === 'demo').status, 'skipped')
    assert.equal(plan.soul.present, false)
    assert.deepEqual(homeFiles(home), ['tos.json'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inspectSetupTos reads only: missing/flag/env/TTY/rejected-version matrix', () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    const missing = inspectSetupTos({ home, env: { ...BASE_ENV }, isTTY: false })
    assert.equal(missing.accepted, false)
    assert.equal(missing.reason, 'missing')
    assert.equal(missing.channel, null)
    assert.equal(missing.explicit, null)

    const viaEnv = inspectSetupTos({ home, env: { ...BASE_ENV, ADVISERS_ACCEPT_TOS: '1' }, isTTY: false })
    assert.deepEqual(viaEnv.explicit, { ok: true, channel: 'env', nonInteractive: true })
    assert.equal(viaEnv.accepted, false, 'inspect must not record the acceptance itself')

    const viaFlag = inspectSetupTos({ home, env: { ...BASE_ENV }, isTTY: false, acceptTosFlag: true })
    assert.deepEqual(viaFlag.explicit, { ok: true, channel: 'flag', nonInteractive: true })

    const ttyEnvIgnored = inspectSetupTos({ home, env: { ...BASE_ENV, ADVISERS_ACCEPT_TOS: '1' }, isTTY: true })
    assert.equal(ttyEnvIgnored.explicit, null, 'ADVISERS_ACCEPT_TOS never applies on a TTY')

    const badVersion = inspectSetupTos({ home, env: { ...BASE_ENV }, isTTY: false, acceptTosFlag: 'v0.0.0-not-current' })
    assert.match(badVersion.error, /--accept-tos version/)

    assert.deepEqual(homeFiles(home), [], 'inspectSetupTos must not write anything')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runSetup refuses a non-interactive write without --yes and writes nothing', async () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    const info = acceptTos(home)
    try {
      await runSetup({ home, env: { ...BASE_ENV, ADVISERS_HOME: home }, isTTY: false, options: { json: true } })
      assert.fail('runSetup must throw E_USAGE without --yes')
    } catch (error) {
      assert.ok(error instanceof SetupError)
      assert.equal(error.code, 'E_USAGE')
      assert.equal(error.exitCode, 1)
    }
    assert.deepEqual(homeFiles(home), ['tos.json'], 'no --yes must not write HOME')
    assert.deepEqual(readdirSync(root), ['home'])
    assert.ok(info.version)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runSetup refuses to write when the TOS record is missing (exit code 3, zero write)', async () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    try {
      await runSetup({ home, env: { ...BASE_ENV, ADVISERS_HOME: home }, isTTY: false, options: { yes: true, json: true, noDemo: true } })
      assert.fail('runSetup must throw E_TOS_REQUIRED without an acceptance record')
    } catch (error) {
      assert.ok(error instanceof SetupError)
      assert.equal(error.code, 'E_TOS_REQUIRED')
      assert.equal(error.exitCode, 3)
    }
    assert.equal(existsSync(home), false, 'a rejected setup must leave HOME byte-empty')
    assert.deepEqual(readdirSync(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runSetup --dry-run returns the plan and writes nothing', async () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    const payload = await runSetup({ home, env: { ...BASE_ENV, ADVISERS_HOME: home }, isTTY: false, options: { dryRun: true, json: true } })
    assert.equal(payload.mode, 'plan')
    assert.equal(payload.ok, true)
    assert.equal(existsSync(home), false)
    assert.deepEqual(readdirSync(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runSetup applies idempotently: HOME 0700, audit.key/soul 0600, schema, no tos audit', async () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    acceptTos(home)
    const env = { ...BASE_ENV, ADVISERS_HOME: home }
    const first = await runSetup({ home, env, isTTY: false, options: { yes: true, json: true, noDemo: true } })
    assert.equal(first.ok, true, JSON.stringify(first.steps))
    assert.equal(first.mode, 'applied')
    assert.equal(first.tos.accepted, true)
    assert.equal(first.soul.present, true)
    assert.equal(first.demo, null)
    const byId = Object.fromEntries(first.steps.map((step) => [step.id, step]))
    assert.equal(byId.env.status, 'applied')
    assert.equal(byId.tos.status, 'skipped')
    assert.equal(byId.init.status, 'applied')
    assert.equal(byId.mail.status, 'skipped')
    assert.equal(byId.demo.status, 'skipped')
    assert.equal(byId.next.status, 'applied')
    assert.deepEqual(homeFiles(home), ['audit.key', 'soul.md', 'soul.meta.json', 'state.db', 'tos.json'])
    assertPrivateMode(home, 0o700, 'HOME')
    assertPrivateMode(join(home, 'audit.key'), 0o600, 'audit.key')
    assertPrivateMode(join(home, 'soul.md'), 0o600, 'soul.md')
    assert.match(readFileSync(join(home, 'audit.key'), 'utf8').trim(), /^[a-f0-9]{64}$/)
    const auditCount = () => {
      return import('../lib/sqlite.js').then(({ SqliteStore }) => {
        const store = new SqliteStore(join(home, 'state.db'), { readOnly: true })
        try { return store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'tos.%'").get().n } finally { store.close() }
      })
    }
    assert.equal(await auditCount(), 0, 'setup must not write tos.* audit rows')
    const soulBefore = readFileSync(join(home, 'soul.md'), 'utf8')
    const keyBefore = readFileSync(join(home, 'audit.key'), 'utf8')
    const dbMtimeBefore = statSync(join(home, 'state.db')).mtimeMs

    const second = await runSetup({ home, env, isTTY: false, options: { yes: true, json: true, noDemo: true } })
    assert.equal(second.ok, true)
    assert.equal(second.steps.find((step) => step.id === 'init').status, 'skipped')
    assert.equal(second.steps.find((step) => step.id === 'tos').status, 'skipped')
    // A read-only open can add SQLite -wal/-shm sidecars; ignore those and
    // assert the durable setup files themselves are not touched or recreated.
    assert.deepEqual(homeFiles(home).filter((name) => !/-(wal|shm)$/.test(name)), ['audit.key', 'soul.md', 'soul.meta.json', 'state.db', 'tos.json'], 'second run adds no files')
    assert.equal(readFileSync(join(home, 'soul.md'), 'utf8'), soulBefore, 'soul must not be overwritten')
    assert.equal(readFileSync(join(home, 'audit.key'), 'utf8'), keyBefore, 'audit.key must not be rotated')
    assert.equal(statSync(join(home, 'state.db')).mtimeMs, dbMtimeBefore, 'second run must not recreate state.db')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--name and --soul-file shape the initial soul without overwriting an existing one', async () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    acceptTos(home)
    const env = { ...BASE_ENV, ADVISERS_HOME: home }
    await runSetup({ home, env, isTTY: false, options: { yes: true, json: true, noDemo: true, name: '王工' } })
    assert.match(readFileSync(join(home, 'soul.md'), 'utf8'), /王工的幕僚/)

    const home2 = join(root, 'home2')
    acceptTos(home2)
    const soulFile = join(root, 'soul.txt')
    writeFileSync(soulFile, '自定义人格：先给结论。\n', 'utf8')
    await runSetup({ home: home2, env: { ...BASE_ENV, ADVISERS_HOME: home2 }, isTTY: false, options: { yes: true, json: true, noDemo: true, soulFile } })
    assert.equal(readFileSync(join(home2, 'soul.md'), 'utf8'), '自定义人格：先给结论。\n')

    // Existing soul is never overwritten by setup (that is `soul set` + L2).
    await runSetup({ home: home2, env: { ...BASE_ENV, ADVISERS_HOME: home2 }, isTTY: false, options: { yes: true, json: true, noDemo: true, soulFile: join(root, 'other.txt') } })
    assert.equal(readFileSync(join(home2, 'soul.md'), 'utf8'), '自定义人格：先给结论。\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--mail eml:<path> runs the existing mail import child with the setup HOME and no API key', async () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    acceptTos(home)
    const eml = join(root, 'sample.eml')
    writeFileSync(eml, 'From: a@example.com\r\nSubject: hi\r\n\r\nhello\r\n')
    const calls = []
    const ports = {
      runCommand: async (argv, options) => {
        calls.push({ argv, options })
        return { status: 0, stdout: JSON.stringify({ files: 1, scanned: 1, inserted: 1, skipped: 0, failed: 0 }), stderr: '' }
      },
    }
    const env = { ...BASE_ENV, ADVISERS_HOME: home, ADVISERS_API_KEY: 'should-not-leak' }
    const payload = await runSetup({ home, env, isTTY: false, options: { yes: true, json: true, noDemo: true, mail: 'eml:' + eml }, ports })
    assert.equal(payload.ok, true)
    const mail = payload.steps.find((step) => step.id === 'mail')
    assert.equal(mail.status, 'applied')
    assert.match(mail.detail, /inserted=1/)
    assert.equal(payload.mail.mode, 'eml')
    const call = calls.find((entry) => entry.argv[0] === 'mail')
    assert.ok(call, 'mail import must be invoked through the child command')
    assert.deepEqual(call.argv, ['mail', 'import', eml, '--json'])
    assert.equal(call.options.env.ADVISERS_HOME, home)
    assert.equal(call.options.env.ADVISERS_API_KEY, undefined, 'API keys must not leak into setup children')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failing demo is a warning, not a setup failure', async () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    acceptTos(home)
    const ports = {
      runCommand: async () => ({ status: 1, stdout: '', stderr: 'advisers: E_IO: synthetic demo failure\n' }),
    }
    const payload = await runSetup({ home, env: { ...BASE_ENV, ADVISERS_HOME: home }, isTTY: false, options: { yes: true, json: true }, ports })
    assert.equal(payload.ok, true, 'demo failure must not fail setup')
    const demo = payload.steps.find((step) => step.id === 'demo')
    assert.equal(demo.status, 'failed')
    assert.equal(payload.demo, null)
    assert.ok(payload.warnings.some((warning) => warning.includes('demo')), JSON.stringify(payload.warnings))
    assert.equal(payload.steps.find((step) => step.id === 'next').status, 'applied')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('setupHumanLines are plain text and show steps/next actions', async () => {
  const root = makeRoot()
  try {
    const home = join(root, 'home')
    acceptTos(home)
    const payload = await runSetup({ home, env: { ...BASE_ENV, ADVISERS_HOME: home }, isTTY: false, options: { yes: true, json: true, noDemo: true } })
    const lines = setupHumanLines(payload)
    assert.ok(lines.length > 8)
    for (const line of lines) {
      assert.doesNotMatch(line, ANSI)
      assert.ok(!line.includes('\uFFFD'))
    }
    assert.ok(lines.some((line) => line.includes(home)))
    assert.ok(lines.some((line) => line.includes('下一步')))
    const plan = buildSetupPlan({ home: join(root, 'plan-home'), env: { ...BASE_ENV } })
    assert.ok(setupHumanLines(plan).some((line) => /dry-run/.test(line)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
