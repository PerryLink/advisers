import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import { buildDocx } from '../../office/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

function env(home, extra = {}) {
  return { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra }
}
function cli(home, args, extra = {}, cwd = process.cwd()) {
  return execFileSync(process.execPath, [bin, ...args], { cwd, env: env(home, extra), encoding: 'utf8' })
}
function cliFail(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8' })
}

test('E0-T1: advisors audit verifies fresh/recorded chains and fails closed on tamper', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-e0-audit-'))
  const home = join(root, 'home')
  try {
    assert.match(cli(home, ['audit']), /verified \(0 entries\)/)
    cli(home, ['commit', 'add', '发报价', '--quote', 'q'])
    const out = cli(home, ['audit'])
    assert.match(out, /verified \(1 entries\)/)
    const bad = cliFail(home, ['audit'], { ADVISERS_AUDIT_KEY: '0'.repeat(64) })
    assert.equal(bad.status, 1)
    assert.match(bad.stdout, /BROKEN at seq 1/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E0-T2: memory accept preserves a real source turn and rejects dangling evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-e0-evidence-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  try {
    const store = new SqliteStore(join(home, 'state.db'))
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: '客户 A' })
    const turn = store.addTurn({ conversationId: 'conv_real', role: 'user', content: '周五前给王工发报价' })
    const ok = store.proposeCandidate({
      kind: 'commitment',
      payload: { matterId: matter.id, debtor: 'user', creditor: '王工', action: '发报价', capability: 'none' },
      evidence: [{ quote: '周五前给王工发报价', sessionId: 'conv_real', turnId: turn.id }],
    })
    const dangling = store.proposeCandidate({
      kind: 'commitment',
      payload: { matterId: matter.id, debtor: 'user', creditor: '王工', action: '发报价', capability: 'none' },
      evidence: [{ quote: '伪造', sessionId: 'conv_real', turnId: 'turn_missing' }],
    })
    const legacy = store.proposeCandidate({
      kind: 'commitment',
      payload: { matterId: matter.id, debtor: 'user', creditor: '王工', action: '发报价', capability: 'none' },
      evidence: [{ quote: '旧候选', turnId: 'capture_123' }],
    })
    store.save(ledger.toJSON())
    store.close?.()

    cli(home, ['memory', 'accept', ok.id])
    const bad = cliFail(home, ['memory', 'accept', dangling.id])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr + bad.stdout, /evidence turn not found/)
    cli(home, ['memory', 'accept', legacy.id])

    const verifyStore = new SqliteStore(join(home, 'state.db'))
    const verifyLedger = Ledger.fromJSON(verifyStore.load())
    const commitments = verifyLedger.listCommitments()
    const real = commitments.find((c) => c.action === '发报价' && c.evidence?.[0]?.sessionId === 'conv_real')
    assert.ok(real, 'real evidence should retain sessionId')
    assert.ok(verifyStore.getTurn(real.evidence[0].turnId), 'real turn should exist')
    const old = commitments.find((c) => c.evidence?.[0]?.quote === '旧候选')
    assert.equal(old.evidence[0].sessionId, 'legacy')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E9: privacy --prove and secret-matter capture fail closed without network', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-e0-privacy-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  try {
    assert.match(cli(home, ['privacy', '--prove']), /\[PASS\] audit verified/)
    const parsed = JSON.parse(cli(home, ['privacy', '--json']))
    assert.equal(parsed.telemetry, 'none')
    assert.equal(parsed.default_egress, 'none')

    const store = new SqliteStore(join(home, 'state.db'))
    const ledger = new Ledger()
    const secret = ledger.addMatter({ title: '秘密客户', secrecy: 2 })
    store.save(ledger.toJSON())
    store.close?.()
    const out = cliFail(home, ['capture', '--matter', secret.id, '明天发报价'], {
      ADVISERS_NO_MODEL: '0', ADVISERS_API_KEY: 'fake', ADVISERS_BASE_URL: 'http://127.0.0.1:9',
    })
    assert.equal(out.status, 1)
    assert.match(out.stderr + out.stdout, /protected matters/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

