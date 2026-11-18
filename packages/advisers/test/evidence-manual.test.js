import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

function env(home, extra = {}) {
  return tosEnv(home, { ...process.env, ADVISERS_HOME: home, ADVISERS_CORE_LOCAL: '1', ADVISERS_OFFICE_LOCAL: '1', ADVISERS_NO_MODEL: '1', ADVISERS_STORE: 'sqlite', ...extra })
}
function cli(home, args, extra = {}) {
  return execFileSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8' })
}
function cliFail(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8' })
}
function setup(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-manual-' + prefix + '-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  return { root, home, work }
}

test('commit add --quote writes a manual source; evidence show says operator-entered, never missing', () => {
  const s = setup('show')
  try {
    const quote = '周一前把修订报价单发给王工'
    const added = cli(s.home, ['commit', 'add', '发修订报价', '--quote', quote])
    const id = added.split(/\s+/)[0]
    const stored = JSON.parse(cli(s.home, ['commit', 'ls', '--json']))[0]
    const evidence = stored.evidence[0]
    assert.equal(evidence.kind, 'manual')
    assert.equal(evidence.source, 'operator')
    assert.equal(evidence.quoteSha256, sha256(quote))
    assert.equal('turnId' in evidence, false, 'no forged turnId is written')
    assert.equal('sessionId' in evidence, false, 'no forged sessionId is written')
    const shown = JSON.parse(cli(s.home, ['evidence', 'show', id, '--json']))
    assert.equal(shown.schemaVersion, 2)
    assert.deepEqual(shown.sources, [])
    assert.deepEqual(shown.missing, [])
    assert.equal(shown.unverifiable.length, 1)
    const manual = shown.unverifiable[0]
    assert.equal(manual.kind, 'manual')
    assert.equal(manual.resolution, 'unverifiable')
    assert.equal(manual.reason, 'operator_entered')
    assert.equal(manual.quote, quote)
    assert.equal(manual.quoteSha256, sha256(quote))
    assert.ok(manual.capturedAt)
    assert.equal(shown.summary.missing, 0)
    assert.equal(shown.summary.operatorEntered, 1)
    const human = cli(s.home, ['evidence', 'show', id])
    assert.match(human, /操作者录入/)
    assert.match(human, /未外部核验/)
    assert.doesNotMatch(human, /MISSING/)
    assert.doesNotMatch(human, /turn_not_found/)
    // commit done evidence is manual too (no fake turn).
    cli(s.home, ['commit', 'done', id, '--evidence', '已发送并留档'])
    const afterDone = JSON.parse(cli(s.home, ['evidence', 'show', id, '--json']))
    assert.equal(afterDone.unverifiable.length, 2)
    assert.deepEqual(afterDone.missing, [])
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('legacy {sessionId:local,turnId:cli} rows are mapped to manual on read and never rewritten', () => {
  const s = setup('legacy')
  try {
    mkdirSync(s.home, { recursive: true })
    const store = new SqliteStore(join(s.home, 'state.db'))
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: '旧数据' })
    const legacy = ledger.addCommitment({
      matterId: matter.id,
      debtor: 'user',
      creditor: '王工',
      action: '旧手工承诺',
      evidence: [{ sessionId: 'local', turnId: 'cli', quote: '旧手工原话' }],
    })
    store.save(ledger.toJSON())
    store.close()
    const shown = JSON.parse(cli(s.home, ['evidence', 'show', legacy.id, '--json']))
    assert.deepEqual(shown.sources, [])
    assert.deepEqual(shown.missing, [])
    assert.equal(shown.unverifiable.length, 1)
    assert.equal(shown.unverifiable[0].reason, 'operator_entered')
    assert.equal(shown.unverifiable[0].quoteSha256, sha256('旧手工原话'))
    // Read-time mapping only: the stored JSON column is unchanged.
    const verifyStore = new SqliteStore(join(s.home, 'state.db'))
    const snapshot = verifyStore.load()
    verifyStore.close()
    const row = snapshot.commitments.find((item) => item.id === legacy.id)
    assert.equal(row.evidence[0].sessionId, 'local')
    assert.equal(row.evidence[0].turnId, 'cli')
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('deliveries --receipt counts manual as operatorEntered and keeps missingCount at 0', () => {
  const s = setup('receipt')
  try {
    const quote = '周五前把报价发给王工'
    const id = cli(s.home, ['commit', 'add', '发报价', '--quote', quote]).split(/\s+/)[0]
    const deliverOut = join(s.work, 'confirmation.docx')
    cli(s.home, ['deliver', '--commit', id, '--out', deliverOut, '--json'])
    const receiptDir = join(s.work, 'receipt')
    const receipt = JSON.parse(cli(s.home, ['deliveries', '--receipt', '--out', receiptDir, '--json']))
    assert.equal(receipt.ok, true)
    assert.equal(receipt.evidence.missingCount, 0, 'manual evidence is not missing')
    assert.equal(receipt.evidence.operatorEnteredCount, 1)
    assert.equal(receipt.evidence.unverifiableCount, 1)
    const manifest = JSON.parse(readFileSync(join(receiptDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.evidence.missingCount, 0)
    const entry = manifest.evidence.entries.find((item) => item.id === id)
    assert.equal(entry.missing.length, 0)
    assert.equal(entry.sources.length, 0)
    assert.equal(entry.unverifiable.length, 1)
    assert.equal(entry.unverifiable[0].reason, 'operator_entered')
    assert.equal(entry.unverifiable[0].quoteSha256, sha256(quote))
    assert.doesNotMatch(JSON.stringify(manifest), /turn_not_found/)
    const verified = JSON.parse(cli(s.home, ['evidence', 'verify', receiptDir]))
    assert.equal(verified.ok, true)
    assert.deepEqual(verified.errors, [])
  } finally { rmSync(s.root, { recursive: true, force: true }) }
})
