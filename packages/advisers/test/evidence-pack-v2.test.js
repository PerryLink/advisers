/**
 * Evidence pack v2 (0.4): typed source rows, byKind/notCheckedCount/
 * verificationBasis, and the offline receipt verifier cross-checking those
 * counts (v1 packs stay accepted).
 *
 * A v2 pack adds honest claims only: every source says how it was resolved
 * (verified at build time) and the pack declares verificationBasis:'build-time'
 * because offline verification cannot replay turns. The verifier must reject a
 * pack whose declared counts disagree with its entries, whose basis is
 * overclaimed, or that marks manual evidence as verified.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'
import {
  EVIDENCE_KINDS,
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
  VERIFICATION_BASIS,
  buildEvidencePack,
  buildReceiptPack,
  sha256Hex,
} from '../lib/evidence.js'
import { verifyReceiptPackDir } from '../lib/receipt-verify.js'

const FIXED_NOW = new Date('2026-11-21T03:00:00.000Z')
const GOOD_QUOTE = '我周五前把报价发给你'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-pack-v2-'))
  const store = new SqliteStore(join(dir, 'state.db'))
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '客户 A' })
  const turn = store.addTurn({ conversationId: 'conv-1', role: 'user', content: '背景：' + GOOD_QUOTE })
  const verified = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'agent',
    creditor: '王工',
    action: '发报价',
    evidence: [{ sessionId: 'conv-1', turnId: turn.id, quote: GOOD_QUOTE }],
  })
  const mailed = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'agent',
    creditor: '李总',
    action: '确认合同',
    evidence: [{ quote: '请把合同发我', type: 'mail', messageId: '<m1@example.com>', subject: '合同' }],
  })
  const kbFact = ledger.remember({
    subject: '合同',
    predicate: 'says',
    object: '付款周期',
    matterId: matter.id,
    evidence: [{ quote: '付款周期为 30 天', type: 'kb_chunk', docId: 'doc_1', chunkIndex: 0 }],
  })
  const manual = ledger.addPreference({ kind: 'preference', statement: '邮件先结论', evidence: [{ kind: 'manual', quote: '先结论再细节' }] })
  return {
    dir,
    store,
    ledger,
    verified,
    mailed,
    kbFact,
    manual,
    cleanup() {
      try {
        store.close()
      } catch {}
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function packFor(f) {
  return buildEvidencePack({
    store: f.store,
    ledger: f.ledger,
    ids: { commitments: [f.verified.id, f.mailed.id], facts: [f.kbFact.id], preferences: [f.manual.id] },
    now: FIXED_NOW,
  })
}

function tallyManifestEntries(entries) {
  const byKind = {}
  for (const kind of EVIDENCE_KINDS) byKind[kind] = 0
  let notChecked = 0
  let items = 0
  for (const entry of entries) {
    for (const key of ['sources', 'missing', 'unverifiable', 'notChecked']) {
      const list = entry[key] ?? []
      if (key === 'notChecked') notChecked += list.length
      for (const item of list) {
        items += 1
        const kind = EVIDENCE_KINDS.includes(item.kind) ? item.kind : 'observed'
        byKind[kind] += 1
      }
    }
  }
  return { byKind, notChecked, items }
}

test('evidence pack v2 declares typed sources, byKind/notCheckedCount and build-time basis', () => {
  const f = fixture()
  try {
    const pack = packFor(f)
    const manifest = JSON.parse(pack.files['manifest.json'])
    assert.equal(manifest.format, MANIFEST_FORMAT)
    assert.equal(manifest.version, MANIFEST_VERSION)
    assert.equal(MANIFEST_VERSION, 2)
    assert.equal(manifest.verificationBasis, VERIFICATION_BASIS)
    assert.deepEqual(manifest.byKind, { observed: 3, derived: 0, inferred: 0, manual: 1 })
    const tallied = tallyManifestEntries(manifest.entries)
    assert.equal(manifest.notCheckedCount, tallied.notChecked)
    assert.equal(manifest.notCheckedCount, 1)
    const declared = Object.values(manifest.byKind).reduce((sum, value) => sum + value, 0)
    assert.equal(declared, tallied.items)

    const verifiedEntry = manifest.entries.find((entry) => entry.id === f.verified.id)
    assert.equal(verifiedEntry.sources.length, 1)
    const source = verifiedEntry.sources[0]
    assert.equal(source.kind, 'observed')
    assert.equal(source.type, 'conversation')
    assert.equal(source.resolution, 'verified')
    assert.equal(source.quoteVerified, true)
    assert.equal(source.quoteSha256, sha256Hex(GOOD_QUOTE))

    const mailEntry = manifest.entries.find((entry) => entry.id === f.mailed.id)
    assert.equal(mailEntry.sources.length, 0)
    assert.equal(mailEntry.unverifiable.length, 1)
    assert.equal(mailEntry.unverifiable[0].type, 'mail')
    assert.equal(mailEntry.unverifiable[0].reason, 'source_not_retained')
    assert.equal(mailEntry.unverifiable[0].resolution, 'unverifiable')
    assert.equal(mailEntry.unverifiable[0].messageId, '<m1@example.com>')

    const kbEntry = manifest.entries.find((entry) => entry.id === f.kbFact.id)
    assert.equal(kbEntry.notChecked.length, 1)
    assert.equal(kbEntry.notChecked[0].type, 'kb_chunk')
    assert.equal(kbEntry.notChecked[0].reason, 'kb_lookup_unavailable')
    assert.equal(kbEntry.notChecked[0].resolution, 'not_checked')

    const manualEntry = manifest.entries.find((entry) => entry.id === f.manual.id)
    assert.equal(manualEntry.unverifiable[0].kind, 'manual')
    assert.equal(manualEntry.unverifiable[0].resolution, 'unverifiable')

    assert.equal(pack.summary.version, 2)
    assert.equal(pack.summary.verificationBasis, VERIFICATION_BASIS)
    assert.equal(pack.summary.notCheckedCount, 1)
    assert.deepEqual(pack.summary.byKind, manifest.byKind)
    const readme = pack.files['README.txt']
    assert.match(readme, /basis:\s+build-time/)
    assert.match(readme, /not checked/)
    assert.match(readme, /version:\s+2 \(typed sources/)

    // Byte-deterministic for the same inputs and clock.
    assert.deepEqual(packFor(f).files, pack.files)
  } finally {
    f.cleanup()
  }
})

function resealManifest(packDir, mutate) {
  const manifestPath = join(packDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  mutate(manifest)
  const text = JSON.stringify(manifest, null, 2) + '\n'
  writeFileSync(manifestPath, text)
  const sumsPath = join(packDir, 'SHA256SUMS')
  const digest = sha256Hex(text)
  writeFileSync(
    sumsPath,
    readFileSync(sumsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => (line.endsWith('  manifest.json') ? digest + '  manifest.json' : line))
      .join('\n') + '\n',
  )
}

test('a v2 evidence pack round-trips through a receipt pack and verifies offline', async () => {
  const f = fixture()
  const root = mkdtempSync(join(tmpdir(), 'advisers-receipt-v2-'))
  try {
    const artifact = join(root, 'deliverable.docx')
    writeFileSync(artifact, 'deliverable bytes')
    const outDir = join(root, 'receipt')
    const pack = packFor(f)
    const receipt = await buildReceiptPack({
      deliveries: [{ id: 'del_1', title: '报价确认单', tool: 'deliver:confirmation', files: [artifact] }],
      evidence: pack,
      verifyResults: { ok: true },
      now: FIXED_NOW,
      outDir,
      docxBuilder: false,
    })
    assert.equal(receipt.summary.version, 2)
    assert.equal(receipt.summary.evidence.verificationBasis, VERIFICATION_BASIS)
    assert.equal(receipt.summary.evidence.notCheckedCount, 1)
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.evidence.version, 2)
    assert.equal(manifest.evidence.verificationBasis, VERIFICATION_BASIS)
    assert.equal(manifest.evidence.notCheckedCount, 1)
    assert.deepEqual(manifest.evidence.byKind, { observed: 3, derived: 0, inferred: 0, manual: 1 })
    assert.equal(manifest.evidence.unverifiableCount, 2)

    const verified = verifyReceiptPackDir(outDir)
    assert.equal(verified.ok, true, verified.errors.join(' | '))
    assert.deepEqual(verified.errors, [])

    const cases = [
      ['byKind', (value) => { value.evidence.byKind.observed += 1 }, /byKind\.observed disagrees/],
      ['notCheckedCount', (value) => { value.evidence.notCheckedCount += 1 }, /notCheckedCount disagrees/],
      ['unverifiableCount', (value) => { value.evidence.unverifiableCount -= 1 }, /unverifiableCount disagrees/],
      ['basis', (value) => { value.evidence.verificationBasis = 'external-verified' }, /verificationBasis/],
      [
        'manual-resolved',
        (value) => {
          const entry = value.evidence.entries.find((item) => item.id === f.manual.id)
          const manualItem = entry.unverifiable.shift()
          entry.sources.push({ ...manualItem, resolution: 'verified' })
          value.evidence.verificationBasis = 'build-time'
        },
        /manual evidence must not be marked verified/,
      ],
    ]
    for (const [name, mutate, needle] of cases) {
      const copy = join(root, 'tampered-' + name)
      cpSync(outDir, copy, { recursive: true })
      resealManifest(copy, mutate)
      const result = verifyReceiptPackDir(copy)
      assert.equal(result.ok, false, name + ' must fail verification')
      assert.ok(
        result.errors.some((error) => needle.test(error)),
        name + ' expected ' + needle + ' in: ' + result.errors.join(' | '),
      )
    }
  } finally {
    f.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a v1 evidence summary still builds and verifies (legacy compatibility)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-receipt-v1-'))
  try {
    const artifact = join(root, 'd.docx')
    writeFileSync(artifact, 'x')
    const outDir = join(root, 'receipt')
    const quote = '旧版证据'
    await buildReceiptPack({
      deliveries: [{ id: 'd1', files: [artifact] }],
      evidence: {
        summary: {
          format: 'advisers-evidence-pack',
          version: 1,
          entries: [
            {
              kind: 'commitment',
              id: 'cm_legacy',
              found: true,
              sources: [{ sessionId: 'conv-1', turnId: 'turn_1', quote, quoteChars: Array.from(quote).length, truncated: false, quoteSha256: sha256Hex(quote) }],
              missing: [],
            },
          ],
        },
      },
      now: FIXED_NOW,
      outDir,
      docxBuilder: false,
    })
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.evidence.version, 1)
    assert.equal('byKind' in manifest.evidence, false, 'v1 packs keep the historical evidence shape')
    const verified = verifyReceiptPackDir(outDir)
    assert.equal(verified.ok, true, verified.errors.join(' | '))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
