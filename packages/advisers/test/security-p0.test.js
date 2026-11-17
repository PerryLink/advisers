import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function env(home, extra = {}) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra })
}
function cli(home, args, extra = {}, cwd = process.cwd()) {
  return execFileSync(process.execPath, [bin, ...args], { cwd, env: env(home, extra), encoding: 'utf8' })
}
function cliFail(home, args, extra = {}, cwd = process.cwd()) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, env: env(home, extra), encoding: 'utf8' })
}
function script(dir, name, body) {
  const file = join(dir, name)
  writeFileSync(file, '#!/bin/sh\n' + body + '\n')
  chmodSync(file, 0o755)
  return file
}

test('P0 security: audit chain stays keyed after office/ocr/timestamp commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-p0-audit-'))
  const home = join(root, 'home')
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(root, 'spec.json'), JSON.stringify({ title: 't', sections: [{ heading: 'h', paragraphs: ['p'] }] }))
    writeFileSync(join(root, 'image.png'), 'not really an image')
    cli(home, ['office', 'docx', 'spec.json', 'out.docx'], {}, root)
    assert.match(cli(home, ['audit'], {}, root), /verified \(1 entries\)/)

    const ocr = script(root, 'fake-ocr.sh', 'echo ocr text')
    cli(home, ['ocr', 'image.png'], { ADVISERS_OCR_CMD: ocr }, root)

    const ts = script(root, 'fake-ts.sh', 'echo proof-bytes')
    cli(home, ['timestamp', 'image.png', '--out', 'proof.txt'], { ADVISERS_TIMESTAMP_CMD: ts }, root)

    const out = cli(home, ['audit'], {}, root)
    assert.match(out, /verified \(3 entries\)/)
    assert.doesNotMatch(out, /BROKEN/)
    const wrongKey = cliFail(home, ['audit'], { ADVISERS_AUDIT_KEY: '0'.repeat(64) }, root)
    assert.equal(wrongKey.status, 1)
    assert.match(wrongKey.stdout, /BROKEN at seq 1/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('P0 security: protected matter blocks model egress for review/brief --deep/learn review', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-p0-secrecy-'))
  const home = join(root, 'home')
  try {
    mkdirSync(home, { recursive: true })
    const store = new SqliteStore(join(home, 'state.db'))
    const ledger = new Ledger()
    ledger.addMatter({ title: 'secret client', secrecy: 2 })
    store.save(ledger.toJSON())
    store.close?.()

    const modelEnv = { ADVISERS_API_KEY: 'test-key', ADVISERS_BASE_URL: 'http://127.0.0.1:9' }
    const brief = cliFail(home, ['brief', '做一个报价', '--deep'], modelEnv, root)
    assert.equal(brief.status, 1)
    assert.match(brief.stdout + brief.stderr, /protected matters/)

    writeFileSync(join(root, 'doc.docx'), 'not a real docx')
    const review = cliFail(home, ['review', 'doc.docx', '--request', 'check'], modelEnv, root)
    assert.equal(review.status, 1)
    assert.match(review.stdout + review.stderr, /protected matters/)

    const learn = cliFail(home, ['learn', 'review', 'run_missing'], modelEnv, root)
    assert.equal(learn.status, 1)
    assert.match(learn.stdout + learn.stderr, /protected matters/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('P0 security: privacy --prove computes checks instead of hardcoding true', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-p0-privacy-'))
  const home = join(root, 'home')
  try {
    mkdirSync(home, { recursive: true })
    cli(home, ['commit', 'add', '发报价', '--quote', 'q'])
    const out = cli(home, ['privacy', '--prove'])
    assert.match(out, /\[PASS\] telemetry disabled/)
    assert.match(out, /\[PASS\] no default network egress/)
    assert.match(out, /\[PASS\] secret matter fail-closed/)
    assert.match(out, /\[PASS\] audit verified/)
    const tampered = cliFail(home, ['privacy', '--prove'], { ADVISERS_AUDIT_KEY: '0'.repeat(64) })
    assert.equal(tampered.status, 1)
    assert.match(tampered.stdout, /\[FAIL\] audit verified/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
