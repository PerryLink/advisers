import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import {
  buildEvidencePack,
  evidenceForCommitment,
  evidenceForFact,
  evidenceForPreference,
  verifyPack,
} from '../lib/evidence.js'
import { SqliteStore } from '../lib/sqlite.js'
import { tosEnv } from './tos-fixture.js'

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))

// 0.2.5 A-3 regression: resolveSourceRefs / evidenceForCommitment used to accept
// any quote as long as the turn existed. A quote must now be a verbatim
// substring of the turn body; a mismatch is a missing(quote_mismatch) row, while
// an empty quote keeps its pre-0.2.3 "pointer only" semantics and manual
// evidence is never touched.

const TURN_CONTENT = '真实的原话在这里，包含引文。'
const TURN = { id: 'turn_1', conversationId: 'conv_1', seq: 1, role: 'user', content: TURN_CONTENT }
const FIXED_NOW = new Date('2026-11-19T03:00:00.000Z')

function store() {
  return { getTurn: (id) => (id === TURN.id ? TURN : undefined) }
}

function ledgerWithMatter() {
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '证据测试' })
  return { ledger, matter }
}

function pointer(extra) {
  return { sessionId: TURN.conversationId, turnId: TURN.id, quote: '', ...extra }
}

test('forged quotes become missing(quote_mismatch), correct quotes resolve, empty quotes stay pointers', () => {
  const { ledger, matter } = ledgerWithMatter()
  const commitment = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: '王工',
    action: '发报价',
    evidence: [
      pointer({ quote: '完全伪造的引用' }),
      pointer({ quote: '真实的原话' }),
      pointer({ quote: '' }),
    ],
  })
  const result = evidenceForCommitment(store(), ledger, commitment.id)
  assert.equal(result.sources.length, 2)
  assert.deepEqual(result.sources.map((source) => source.quote), ['真实的原话', ''])
  assert.deepEqual(result.sources.map((source) => source.sessionId), ['conv_1', 'conv_1'])
  assert.deepEqual(result.missing.map((item) => item.reason), ['quote_mismatch'])
  assert.equal(result.missing[0].quote, '完全伪造的引用')
  assert.equal(result.missing[0].turnId, TURN.id)
  // The forged quote never appears as a resolved source quote.
  assert.equal(result.sources.some((source) => source.quote === '完全伪造的引用'), false)

  // The shared resolver path (facts / preferences) applies the same check.
  const badFact = ledger.remember({
    subject: '客户A',
    predicate: 'quoting',
    object: 'x',
    matterId: matter.id,
    evidence: [{ quote: '伪造引用', ref: 'conv_1#' + TURN.id }],
  })
  const factResult = evidenceForFact(store(), ledger, badFact.id)
  assert.deepEqual(factResult.sources, [])
  assert.deepEqual(factResult.missing.map((item) => item.reason), ['quote_mismatch'])

  const goodPreference = ledger.addPreference({
    kind: 'preference',
    statement: '邮件先结论',
    evidence: [{ quote: '真实的原话', ref: 'conv_1#' + TURN.id }],
  })
  const preferenceResult = evidenceForPreference(store(), ledger, goodPreference.id)
  assert.equal(preferenceResult.sources.length, 1)
  assert.equal(preferenceResult.sources[0].quote, '真实的原话')
  assert.deepEqual(preferenceResult.missing, [])
})

test('legacy pointers and the pre-0.2.5 writer shapes are normalized, real mismatches stay missing', () => {
  const { ledger, matter } = ledgerWithMatter()
  // memory accept wrote {sessionId:'legacy', turnId} for candidates without a session.
  const legacy = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: '王工',
    action: '旧候选',
    evidence: [{ sessionId: 'legacy', turnId: TURN.id, quote: '真实的原话' }],
  })
  const legacyResult = evidenceForCommitment(store(), ledger, legacy.id)
  assert.equal(legacyResult.sources.length, 1)
  assert.equal(legacyResult.sources[0].sessionId, 'conv_1')
  assert.deepEqual(legacyResult.missing, [])

  // lib/agent.js wrote sessionId === turnId; the store is authoritative for the
  // conversation id, so this shape resolves instead of session_mismatch forever.
  const badWriterShape = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: '王工',
    action: 'agent 写的承诺',
    evidence: [{ sessionId: TURN.id, turnId: TURN.id, quote: '真实的原话' }],
  })
  const badShapeResult = evidenceForCommitment(store(), ledger, badWriterShape.id)
  assert.equal(badShapeResult.sources.length, 1)
  assert.equal(badShapeResult.sources[0].sessionId, 'conv_1')

  // ref='legacy#turnId' (memory accept with no session) resolves by turn id.
  const legacyRefFact = ledger.remember({
    subject: '客户A',
    predicate: 'legacy-ref',
    object: 'y',
    matterId: matter.id,
    evidence: [{ quote: '真实的原话', ref: 'legacy#' + TURN.id }],
  })
  const legacyRefResult = evidenceForFact(store(), ledger, legacyRefFact.id)
  assert.equal(legacyRefResult.sources.length, 1)
  assert.equal(legacyRefResult.sources[0].sessionId, 'conv_1')

  // A genuine cross-conversation pointer is still missing, never repaired.
  const wrongSession = ledger.remember({
    subject: '客户A',
    predicate: 'wrong-session',
    object: 'z',
    matterId: matter.id,
    evidence: [{ quote: '真实的原话', ref: 'conv_other#' + TURN.id }],
  })
  const wrongSessionResult = evidenceForFact(store(), ledger, wrongSession.id)
  assert.deepEqual(wrongSessionResult.sources, [])
  assert.deepEqual(wrongSessionResult.missing.map((item) => item.reason), ['session_mismatch'])
})

test('manual evidence is unaffected by quote validation', () => {
  const { ledger, matter } = ledgerWithMatter()
  const manual = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: '王工',
    action: '手工录入',
    evidence: [
      { kind: 'manual', type: 'manual', source: 'operator', quote: '手工原话任意内容' },
      { sessionId: 'local', turnId: 'cli', quote: '旧版本手工原话' },
    ],
  })
  const result = evidenceForCommitment(store(), ledger, manual.id)
  assert.deepEqual(result.sources, [])
  assert.deepEqual(result.missing, [])
  assert.equal(result.unverifiable.length, 2)
  assert.equal(result.unverifiable[0].resolution, 'unverifiable')
  assert.equal(result.unverifiable[0].reason, 'operator_entered')

  const pack = buildEvidencePack({ store: store(), ledger, ids: { commitments: [manual.id] }, now: FIXED_NOW })
  assert.equal(pack.summary.sourceCount, 0)
  assert.equal(pack.summary.missingCount, 0)
  assert.equal(pack.summary.unverifiableCount, 2)
  assert.equal(pack.summary.operatorEnteredCount, 2)
  assert.equal(verifyPack(pack.files).ok, true)
})

test('packs count a quote mismatch as missing and never as a resolved source', () => {
  const { ledger, matter } = ledgerWithMatter()
  const commitment = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'user',
    creditor: '王工',
    action: '发报价',
    evidence: [pointer({ quote: '伪造的引用' }), pointer({ quote: '真实的原话' })],
  })
  const pack = buildEvidencePack({ store: store(), ledger, ids: { commitments: [commitment.id] }, now: FIXED_NOW })
  assert.equal(pack.summary.sourceCount, 1)
  assert.equal(pack.summary.missingCount, 1)
  const manifest = JSON.parse(pack.files['manifest.json'])
  const entry = manifest.entries[0]
  assert.equal(entry.sources.length, 1)
  assert.equal(entry.sources[0].quote, '真实的原话')
  assert.deepEqual(entry.missing.map((item) => item.reason), ['quote_mismatch'])
  assert.equal(verifyPack(pack.files).ok, true)
})

test('bin: memory accept of a session-less candidate leaves a resolvable legacy pointer', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-legacy-pointer-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  try {
    const store = new SqliteStore(join(home, 'state.db'))
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: '旧候选' })
    const turn = store.addTurn({ conversationId: 'conv_real', role: 'user', content: TURN_CONTENT })
    const candidate = store.proposeCandidate({
      kind: 'commitment',
      payload: { matterId: matter.id, debtor: 'user', creditor: '王工', action: '发报价', capability: 'none' },
      // No sessionId: memory accept writes {sessionId:'legacy', turnId} (0.2.5
      // read-side normalization turns that back into the real conversation).
      evidence: [{ quote: '真实的原话', turnId: turn.id }],
    })
    store.save(ledger.toJSON())
    store.close()

    const env = tosEnv(home, {
      ...process.env,
      ADVISERS_HOME: home,
      ADVISERS_CORE_LOCAL: '1',
      ADVISERS_OFFICE_LOCAL: '1',
      ADVISERS_STORE: 'sqlite',
      ADVISERS_NO_MODEL: '1',
    })
    const cli = (args) => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' })
    const accepted = cli(['memory', 'accept', candidate.id])
    assert.equal(accepted.status, 0, accepted.stderr)
    const rows = JSON.parse(cli(['commit', 'ls', '--json']).stdout)
    const commitment = rows.find((row) => row.action === '发报价')
    assert.ok(commitment, 'the accepted candidate must be in the ledger')
    assert.equal(commitment.evidence[0].sessionId, 'legacy')

    const shown = JSON.parse(cli(['evidence', 'show', commitment.id, '--json']).stdout)
    assert.equal(shown.sources.length, 1)
    assert.equal(shown.sources[0].sessionId, 'conv_real')
    assert.equal(shown.sources[0].quote, '真实的原话')
    assert.deepEqual(shown.missing, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
