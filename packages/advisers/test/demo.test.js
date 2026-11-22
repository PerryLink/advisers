/**
 * 0.5.0 (WF5 050-U2b): lib/demo.js — isolated synthetic "顾问一单" demo.
 *
 * Layer 1 (fast, fake child runner): isolation contract, payload shape,
 * --clean confirmation/quarantine behaviour, failure preservation.
 * Layer 2 (one integration test): run the real CLI children once and assert the
 * seven-step story really produces quote/proposal/notice DOCX, a v2 receipt
 * pack, a receivable and a VALARM .ics, while the real ADVISERS_HOME stays
 * byte-identical. Office imports are slow on a mounted filesystem, so the
 * integration test carries a generous explicit timeout.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { DemoError, defaultDemoHome, demoHumanLines, runDemo } from '../lib/demo.js'

const ANSI = /\u001b\[/
const BASE_ENV = { ...process.env, ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1' }

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'advisers-demo-test-'))
}

/** Fake child runner that replays the seven-step contract without spawning. */
function fakeRunner({ home, out, calls = [] }) {
  return async (argv, options) => {
    calls.push({ argv: argv.slice(), options })
    const command = argv[0] + ' ' + (argv[1] ?? '')
    const write = (path, text) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, text ?? 'fake') }
    if (command === 'matter add') return { status: 0, stdout: JSON.stringify({ ok: true, matter: { id: 'matter_demo_1' } }), stderr: '' }
    if (command === 'client add') return { status: 0, stdout: JSON.stringify({ ok: true, client: { id: 'cl_demo_1' } }), stderr: '' }
    if (command === 'matter use') return { status: 0, stdout: JSON.stringify({ ok: true, matterId: 'matter_demo_1' }), stderr: '' }
    if (command === 'template quote') {
      write(argv[3]); return { status: 0, stdout: JSON.stringify({ ok: true, template: 'quote', templateVersion: '2', dataSha256: 'a'.repeat(64), quoteNo: 'Q-DEMO', totals: { total: '68000.00' }, verify: { structure: { ok: true } } }), stderr: '' }
    }
    if (command === 'template proposal') {
      write(argv[3]); return { status: 0, stdout: JSON.stringify({ ok: true, template: 'proposal', templateVersion: '2', dataSha256: 'c'.repeat(64), verify: { structure: { ok: true } } }), stderr: '' }
    }
    if (command === 'template notice') {
      write(argv[3]); return { status: 0, stdout: 'wrote ' + argv[3], stderr: '' }
    }
    if (command.startsWith('verify ')) return { status: 0, stdout: JSON.stringify({ ok: true, structure: { ok: true } }), stderr: '' }
    if (command === 'deliveries --receipt') {
      const receiptDir = argv[argv.indexOf('--out') + 1]
      mkdirSync(receiptDir, { recursive: true })
      writeFileSync(join(receiptDir, 'manifest.json'), '{}')
      return { status: 0, stdout: JSON.stringify({ ok: true, scope: 'subject', subject: { kind: 'client', id: 'cl_demo_1', name: '王工（示例）' }, manifestDigest: 'b'.repeat(64), outDir: receiptDir }), stderr: '' }
    }
    if (command === 'receivable add') return { status: 0, stdout: JSON.stringify({ receivable: { id: 'rcv_demo_1', commitmentId: 'cm_demo_1', amount: '20400.00', currency: 'CNY' } }), stderr: '' }
    if (command === 'remind --ics') {
      write(argv[argv.indexOf('--ics') + 1], 'BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:Asia/Shanghai\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nBEGIN:VALARM\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')
      return { status: 0, stdout: 'ics written', stderr: '' }
    }
    if (command === 'evidence verify') return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: '' }
    return { status: 1, stdout: '', stderr: 'advisers: E_USAGE: unexpected fake command ' + argv.join(' ') }
  }
}

test('defaultDemoHome is unique and lives under the OS temp root', () => {
  const first = defaultDemoHome(new Date('2026-11-22T10:00:00Z'))
  const second = defaultDemoHome(new Date('2026-11-22T10:00:00Z'))
  assert.notEqual(first, second)
  assert.ok(first.startsWith(tmpdir() + '/') || first.startsWith(tmpdir() + '\\'), first)
  assert.match(first, /advisers-demo-/)
})

test('runDemo refuses the real ADVISERS_HOME and non-demo directories (no writes)', async () => {
  const root = makeRoot()
  try {
    const sentinel = join(root, 'real-home')
    mkdirSync(sentinel)
    const env = { ...BASE_ENV, ADVISERS_HOME: sentinel }
    await assert.rejects(() => runDemo({ home: sentinel, env }), (error) => error instanceof DemoError && error.code === 'E_IO')
    assert.deepEqual(readdirSync(sentinel), [], 'the real home must stay empty')

    const nonDemo = join(root, 'someone-else')
    mkdirSync(nonDemo)
    writeFileSync(join(nonDemo, 'important.txt'), 'keep me')
    await assert.rejects(() => runDemo({ home: nonDemo, env }), (error) => error instanceof DemoError && error.code === 'E_IO')
    assert.deepEqual(readdirSync(nonDemo), ['important.txt'], 'a non-demo directory must be untouched')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--clean refuses to run without an interactive confirmation and creates nothing', async () => {
  const root = makeRoot()
  try {
    const home = join(root, 'demo-home')
    await assert.rejects(
      () => runDemo({ home, env: BASE_ENV, clean: true, isTTY: false }),
      (error) => error instanceof DemoError && error.code === 'E_USAGE' && /--clean/.test(error.message),
    )
    assert.equal(existsSync(home), false, 'a refused --clean must not create the demo home')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fake end-to-end: isolated payload, 8 steps, artifacts and confirmed --clean removal', async () => {
  const root = makeRoot()
  try {
    const sentinel = join(root, 'real-home')
    mkdirSync(sentinel)
    writeFileSync(join(sentinel, 'state.json'), '{"real":true}')
    const home = join(root, 'demo-home')
    const calls = []
    let confirmed = null
    const payload = await runDemo({
      home,
      env: { ...BASE_ENV, ADVISERS_HOME: sentinel, ADVISERS_API_KEY: 'leak-me', ADVISERS_AUDIT_KEY: 'k'.repeat(32) },
      clean: true,
      isTTY: true,
      now: new Date('2026-11-22T10:00:00Z'),
      ports: {
        runCommand: fakeRunner({ home, calls }),
        confirm: async (question) => { confirmed = question; return true },
      },
    })
    assert.equal(payload.ok, true, JSON.stringify(payload.error))
    assert.equal(payload.command, 'demo')
    assert.equal(payload.demoHome, home)
    assert.deepEqual(payload.steps.map((step) => step.id), ['client', 'quote', 'proposal', 'notice', 'receipt', 'receivable', 'remind', 'verify'])
    assert.ok(payload.steps.every((step) => step.status === 'applied'), JSON.stringify(payload.steps))
    assert.equal(payload.receipt.scope, 'subject')
    assert.equal(payload.receipt.subject.id, 'cl_demo_1')
    assert.match(payload.receipt.manifestDigest, /^[a-f0-9]{64}$/)
    assert.equal(payload.receipt.out, join(home, 'out', 'receipt'))
    assert.equal(payload.next.length, 3)
    assert.deepEqual(payload.warnings, [])
    const paths = payload.artifacts.map((artifact) => artifact.path.replace(/\\/g, '/'))
    for (const expected of ['quote.docx', 'proposal.docx', 'notice.docx', 'demo.ics', 'receipt/manifest.json']) {
      assert.ok(paths.some((path) => path.endsWith(expected)), 'artifact missing: ' + expected)
    }
    for (const artifact of payload.artifacts) {
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/)
      assert.ok(artifact.path.startsWith(join(home, 'out')), 'artifacts stay inside the demo out dir: ' + artifact.path)
    }
    // Child isolation: same home, pre-accepted TOS, no model, no keys.
    assert.ok(calls.length >= 10)
    for (const call of calls) {
      assert.equal(call.options.cwd, home)
      assert.equal(call.options.env.ADVISERS_HOME, home)
      assert.equal(call.options.env.ADVISERS_ACCEPT_TOS, '1')
      assert.equal(call.options.env.ADVISERS_NO_MODEL, '1')
      assert.equal(call.options.env.ADVISERS_API_KEY, undefined)
      assert.equal(call.options.env.ADVISERS_AUDIT_KEY, undefined)
    }
    // The real home was never touched.
    assert.deepEqual(readdirSync(sentinel), ['state.json'])
    assert.equal(readFileSync(join(sentinel, 'state.json'), 'utf8'), '{"real":true}')
    // --clean printed the absolute path before quarantining/deleting.
    assert.ok(confirmed && confirmed.question.includes(home), 'confirmation must carry the absolute path')
    assert.equal(payload.cleanup.removed, true)
    assert.equal(existsSync(home), false, 'the demo home this run created is removed by --clean')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed step keeps the demo home and returns an E_DEMO_STEP payload', async () => {
  const root = makeRoot()
  try {
    const home = join(root, 'demo-home')
    const payload = await runDemo({
      home,
      env: { ...BASE_ENV, ADVISERS_HOME: join(root, 'real-home') },
      isTTY: false,
      ports: { runCommand: async () => ({ status: 1, stdout: '', stderr: 'advisers: E_IO: synthetic failure\n' }) },
    })
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'E_DEMO_STEP')
    assert.match(payload.error.message, /matter add/)
    assert.equal(payload.steps.at(-1).status, 'failed')
    assert.equal(payload.receipt, null)
    assert.deepEqual(payload.next, [])
    assert.ok(payload.warnings.some((warning) => warning.includes('保留')))
    assert.equal(existsSync(home), true, 'a failed demo keeps its home for debugging')
    assert.equal(existsSync(join(home, '.advisers-demo.json')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('demoHumanLines render a plain-text summary', async () => {
  const root = makeRoot()
  try {
    const home = join(root, 'demo-home')
    const payload = await runDemo({
      home,
      env: { ...BASE_ENV, ADVISERS_HOME: join(root, 'real-home') },
      isTTY: false,
      ports: { runCommand: async () => ({ status: 1, stdout: '', stderr: 'advisers: E_IO: boom\n' }) },
    })
    const lines = demoHumanLines(payload)
    assert.ok(lines.length >= 3)
    for (const line of lines) {
      assert.doesNotMatch(line, ANSI)
      assert.ok(!line.includes('\uFFFD'))
    }
    assert.ok(lines.some((line) => line.includes('demo home')))
    assert.ok(lines.some((line) => line.includes('FAILED')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('integration: the real CLI children produce the seven artifacts inside an isolated home', { timeout: 240000 }, async () => {
  const root = makeRoot()
  try {
    const realHome = join(root, 'real-home')
    mkdirSync(realHome)
    const home = join(root, 'demo-home')
    const env = { ...BASE_ENV, ADVISERS_HOME: realHome }
    const payload = await runDemo({ home, env, isTTY: false })
    assert.equal(payload.ok, true, JSON.stringify(payload.error ?? payload.warnings))
    assert.deepEqual(payload.steps.map((step) => step.id), ['client', 'quote', 'proposal', 'notice', 'receipt', 'receivable', 'remind', 'verify'])
    assert.ok(payload.steps.every((step) => step.status === 'applied'), JSON.stringify(payload.steps))
    const byId = Object.fromEntries(payload.steps.map((step) => [step.id, step]))
    assert.ok(byId.quote.checks.some((check) => /^dataSha256=[a-f0-9]{64}$/.test(check)))
    assert.ok(byId.remind.checks.includes('valarm=true'))
    assert.ok(byId.receipt.checks.some((check) => /^manifestDigest=[a-f0-9]{64}$/.test(check)))
    assert.equal(payload.receipt.scope, 'subject')
    assert.match(payload.receipt.manifestDigest, /^[a-f0-9]{64}$/)
    const paths = payload.artifacts.map((artifact) => artifact.path.replace(/\\/g, '/'))
    for (const expected of ['quote.docx', 'proposal.docx', 'notice.docx', 'demo.ics', 'receipt/manifest.json']) {
      assert.ok(paths.some((path) => path.endsWith(expected)), 'artifact missing: ' + expected + ' in ' + paths.join(', '))
    }
    const ics = readFileSync(join(home, 'out', 'demo.ics'), 'utf8')
    assert.match(ics, /BEGIN:VALARM/)
    assert.match(ics, /TZID:Asia\/Shanghai/)
    // The demo writes only its own home; the real home stays empty.
    assert.deepEqual(readdirSync(realHome), [])
    assert.equal(existsSync(join(home, '.advisers-demo.json')), true)
    assert.equal(existsSync(join(home, 'tos.json')), true)
    assert.ok(readdirSync(join(home, 'data')).includes('quote.json'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
