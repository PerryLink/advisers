import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'
import {
  DOCX_EVIDENCE_HEADERS,
  MANIFEST_FORMAT,
  MAX_QUOTE_CHARS,
  buildEvidencePack,
  evidenceForCommitment,
  evidenceForFact,
  evidenceForPreference,
  manifestFor,
  parseSourceRef,
  sha256Hex,
  stableStringify,
  toDocxRows,
  verifyPack,
} from '../lib/evidence.js'

const FIXED_NOW = new Date('2026-11-14T03:00:00.000Z')
const GOOD_QUOTE = '我周五前把报价发给王工'

const SHA_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-evidence-'))
  const store = new SqliteStore(join(dir, 'state.db'))
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '客户 A 报价' })
  const turn = store.addTurn({
    conversationId: 'conv-1',
    role: 'user',
    content: `${GOOD_QUOTE}，请放心。`,
  })
  const commitment = ledger.addCommitment({
    matterId: matter.id,
    debtor: 'agent',
    creditor: '王工',
    action: '发报价',
    dueAt: '2026-11-20T18:00:00+08:00',
    evidence: [{ sessionId: 'conv-1', turnId: turn.id, quote: GOOD_QUOTE }],
  })
  const fact = ledger.remember({
    subject: '客户A',
    predicate: 'wants',
    object: '报价',
    matterId: matter.id,
    evidence: [{ quote: GOOD_QUOTE, ref: `conv-1#${turn.id}` }],
  })
  const preference = ledger.addPreference({
    kind: 'preference',
    statement: '邮件先结论',
    evidence: [{ quote: '请放心', ref: `conv-1#${turn.id}` }],
  })
  return {
    dir,
    store,
    ledger,
    matter,
    turn,
    commitment,
    fact,
    preference,
    cleanup() {
      try {
        store.close()
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function usingFixture(fn) {
  const f = fixture()
  try {
    return fn(f)
  } finally {
    f.cleanup()
  }
}

function buildFor(f, ids) {
  return buildEvidencePack({ store: f.store, ledger: f.ledger, ids, now: FIXED_NOW })
}

function sumsMap(sums) {
  const map = new Map()
  for (const line of sums.trim().split(/\r?\n/)) {
    const [hash, name] = line.split(/\s+/)
    map.set(name, hash)
  }
  return map
}

// ---------------------------------------------------------------------------
// hashing / canonical JSON / ref parsing
// ---------------------------------------------------------------------------

test('sha256Hex is deterministic for strings and bytes', () => {
  assert.equal(sha256Hex(''), SHA_EMPTY)
  assert.equal(sha256Hex('abc'), SHA_ABC)
  assert.equal(sha256Hex(Buffer.from('abc', 'utf8')), SHA_ABC)
  assert.equal(sha256Hex(new TextEncoder().encode('abc')), SHA_ABC)
  assert.throws(() => sha256Hex(null), /expects a string, Buffer/)
})

test('stableStringify sorts keys at every depth and drops undefined', () => {
  const text = stableStringify({ b: 1, a: { d: 2, c: undefined } })
  assert.equal(text, JSON.stringify({ a: { d: 2 }, b: 1 }, null, 2))
  assert.deepEqual(Object.keys(JSON.parse(stableStringify({ z: 1, a: 2 }))), ['a', 'z'])
})

test('parseSourceRef only accepts sessionId#turnId', () => {
  assert.deepEqual(parseSourceRef('conv-1#turn_abc'), { sessionId: 'conv-1', turnId: 'turn_abc' })
  assert.deepEqual(parseSourceRef(' conv-1#turn_abc '), { sessionId: 'conv-1', turnId: 'turn_abc' })
  assert.equal(parseSourceRef('turn_abc'), null)
  assert.equal(parseSourceRef('#turn_abc'), null)
  assert.equal(parseSourceRef('conv-1#'), null)
  assert.equal(parseSourceRef('a#b#c'), null)
  assert.equal(parseSourceRef(undefined), null)
})

// ---------------------------------------------------------------------------
// traceback
// ---------------------------------------------------------------------------

test('evidenceForCommitment resolves the recorded turn', () => {
  usingFixture((f) => {
    const result = evidenceForCommitment(f.store, f.ledger, f.commitment.id)
    assert.equal(result.commitment.id, f.commitment.id)
    assert.deepEqual(result.missing, [])
    assert.equal(result.sources.length, 1)
    const [source] = result.sources
    assert.equal(source.sessionId, 'conv-1')
    assert.equal(source.turnId, f.turn.id)
    assert.equal(source.quote, GOOD_QUOTE)
    assert.equal(source.turn.id, f.turn.id)
    assert.match(source.turn.content, /报价发给王工/)
  })
})

test('evidenceForCommitment sends mismatches and unknown turns to missing', () => {
  usingFixture((f) => {
    const commitment = f.ledger.addCommitment({
      matterId: f.matter.id,
      debtor: 'user',
      creditor: '王工',
      action: '发报价',
      evidence: [
        { sessionId: 'conv-1', turnId: f.turn.id, quote: 'good' },
        { sessionId: 'conv-other', turnId: f.turn.id, quote: 'wrong session' },
        { sessionId: 'conv-1', turnId: 'turn_missing', quote: 'gone' },
        { quote: 'no ids' },
      ],
    })
    const result = evidenceForCommitment(f.store, f.ledger, commitment.id)
    assert.equal(result.sources.length, 1)
    assert.equal(result.sources[0].turn.id, f.turn.id)
    assert.deepEqual(result.missing.map((item) => item.reason), [
      'session_mismatch',
      'turn_not_found',
      'invalid_evidence',
    ])
    // never fabricate a source out of a missing one
    assert.equal(
      result.sources.some((source) => source.sessionId !== 'conv-1'),
      false,
    )

    const ghost = evidenceForCommitment(f.store, f.ledger, 'cm_ghost')
    assert.equal(ghost.commitment, undefined)
    assert.deepEqual(ghost.sources, [])
    assert.equal(ghost.missing[0].reason, 'commitment_not_found')
  })
})

test('evidence lookup falls back to listTurns when the store has no getTurn', () => {
  usingFixture((f) => {
    // At HEAD SqliteStore had no getTurn (it landed via a separate patch); the
    // evidence module must still work without guessing a session.
    const legacyStore = { listTurns: (conversationId) => (conversationId === 'conv-1' ? [f.turn] : []) }
    const result = evidenceForCommitment(legacyStore, f.ledger, f.commitment.id)
    assert.equal(result.sources.length, 1)
    assert.equal(result.sources[0].turn.id, f.turn.id)
  })
})

test('evidenceForFact parses session#turn refs and reports unparseable ones', () => {
  usingFixture((f) => {
    const good = evidenceForFact(f.store, f.ledger, f.fact.id)
    assert.equal(good.fact.id, f.fact.id)
    assert.deepEqual(good.missing, [])
    assert.equal(good.sources.length, 1)
    assert.equal(good.sources[0].sessionId, 'conv-1')
    assert.equal(good.sources[0].turnId, f.turn.id)
    assert.match(good.sources[0].turn.content, /报价发给王工/)

    const bad = f.ledger.remember({
      subject: '客户A',
      predicate: 'noise',
      object: 'x',
      matterId: f.matter.id,
      evidence: [
        { quote: 'bare turn id', ref: 'turn_without_session' },
        { quote: 'gone', ref: 'conv-1#turn_missing' },
        { quote: 'legacy', ref: `legacy#${f.turn.id}` },
        { quote: 'no ref at all' },
      ],
    })
    const badResult = evidenceForFact(f.store, f.ledger, bad.id)
    assert.deepEqual(badResult.sources, [])
    assert.deepEqual(badResult.missing.map((item) => item.reason), [
      'unparseable_ref',
      'turn_not_found',
      'session_mismatch',
      'no_ref',
    ])

    // A fact with no evidence[] but a primary source still resolves.
    const viaSource = f.ledger.remember({
      subject: '客户A',
      predicate: 'sourcefallback',
      object: 'y',
      matterId: f.matter.id,
      evidence: [],
      source: { quote: 'q', ref: `conv-1#${f.turn.id}` },
    })
    const viaSourceResult = evidenceForFact(f.store, f.ledger, viaSource.id)
    assert.equal(viaSourceResult.sources.length, 1)
    assert.equal(viaSourceResult.sources[0].turnId, f.turn.id)

    const ghost = evidenceForFact(f.store, f.ledger, 'fact_ghost')
    assert.equal(ghost.fact, undefined)
    assert.equal(ghost.missing[0].reason, 'fact_not_found')
  })
})

test('evidenceForPreference resolves refs and reports missing records', () => {
  usingFixture((f) => {
    const good = evidenceForPreference(f.store, f.ledger, f.preference.id)
    assert.equal(good.preference.id, f.preference.id)
    assert.equal(good.sources.length, 1)
    assert.equal(good.sources[0].turnId, f.turn.id)
    assert.equal(good.sources[0].quote, '请放心')

    const bad = f.ledger.addPreference({
      kind: 'preference',
      statement: '坏引用',
      evidence: [{ quote: 'x', ref: 'nohash' }],
    })
    const badResult = evidenceForPreference(f.store, f.ledger, bad.id)
    assert.deepEqual(badResult.sources, [])
    assert.equal(badResult.missing[0].reason, 'unparseable_ref')

    const ghost = evidenceForPreference(f.store, f.ledger, 'pref_ghost')
    assert.equal(ghost.preference, undefined)
    assert.equal(ghost.missing[0].reason, 'preference_not_found')
  })
})

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

test('manifestFor is byte-stable and key-sorted regardless of entry order', () => {
  const entries = [
    {
      kind: 'fact',
      id: 'fact_b',
      found: true,
      sources: [
        { sessionId: 's', turnId: 't', quote: 'q', quoteSha256: sha256Hex('q'), quoteChars: 1, truncated: false },
      ],
      missing: [],
    },
    { kind: 'commitment', id: 'cm_a', found: true, sources: [], missing: [{ reason: 'turn_not_found', ref: 's#t' }] },
  ]
  const createdAt = FIXED_NOW.toISOString()
  const first = manifestFor(entries, { createdAt })
  const second = manifestFor([...entries].reverse(), { createdAt })
  assert.equal(first, second)
  assert.ok(first.endsWith('\n'))

  const parsed = JSON.parse(first)
  assert.equal(parsed.format, MANIFEST_FORMAT)
  assert.equal(parsed.createdAt, createdAt)
  assert.equal(parsed.entryCount, 2)
  assert.deepEqual(parsed.entries.map((entry) => entry.id), ['cm_a', 'fact_b'])
  for (const object of [parsed, ...parsed.entries]) {
    assert.deepEqual(Object.keys(object), Object.keys(object).sort())
  }
  assert.equal(first.includes('undefined'), false)
  assert.notEqual(manifestFor(entries, { createdAt: '2026-11-15T00:00:00.000Z' }), first)
})

// ---------------------------------------------------------------------------
// pack assembly + checksums
// ---------------------------------------------------------------------------

test('buildEvidencePack emits manifest, README and covering SHA256SUMS', () => {
  usingFixture((f) => {
    const pack = buildFor(f, {
      commitments: [f.commitment.id],
      facts: [f.fact.id],
      preferences: [f.preference.id],
    })
    assert.deepEqual(Object.keys(pack.files), ['manifest.json', 'README.txt', 'SHA256SUMS'])

    const manifest = JSON.parse(pack.files['manifest.json'])
    assert.equal(manifest.format, MANIFEST_FORMAT)
    assert.equal(manifest.createdAt, FIXED_NOW.toISOString())
    assert.equal(manifest.entryCount, 3)
    assert.deepEqual(manifest.entries.map((entry) => entry.kind), ['commitment', 'fact', 'preference'])

    const commitmentEntry = manifest.entries.find((entry) => entry.kind === 'commitment')
    assert.equal(commitmentEntry.found, true)
    assert.equal(commitmentEntry.sources.length, 1)
    assert.equal(commitmentEntry.sources[0].sessionId, 'conv-1')
    assert.equal(commitmentEntry.sources[0].turnId, f.turn.id)
    assert.equal(commitmentEntry.sources[0].quote, GOOD_QUOTE)
    assert.equal(commitmentEntry.sources[0].turnSeq, f.turn.seq)
    assert.equal(commitmentEntry.sources[0].turnRole, 'user')
    assert.equal(commitmentEntry.sources[0].quoteSha256, sha256Hex(GOOD_QUOTE))
    assert.equal(commitmentEntry.sources[0].truncated, false)
    assert.equal(commitmentEntry.missing.length, 0)

    const sums = sumsMap(pack.files['SHA256SUMS'])
    assert.equal(sums.size, 2)
    assert.equal(sums.get('manifest.json'), sha256Hex(pack.files['manifest.json']))
    assert.equal(sums.get('README.txt'), sha256Hex(pack.files['README.txt']))

    assert.equal(pack.summary.entryCount, 3)
    assert.equal(pack.summary.sourceCount, 3)
    assert.equal(pack.summary.missingCount, 0)
    assert.deepEqual(pack.summary.notFound, [])
    assert.equal(pack.summary.fileHashes['manifest.json'], sums.get('manifest.json'))

    // Same inputs + same clock must produce identical bytes.
    const again = buildFor(f, {
      commitments: [f.commitment.id],
      facts: [f.fact.id],
      preferences: [f.preference.id],
    })
    assert.deepEqual(again.files, pack.files)
    assert.deepEqual(again.summary.entries, pack.summary.entries)

    assert.deepEqual(verifyPack(pack.files), { ok: true, errors: [] })
  })
})

test('verifyPack detects tampering in every pack file', () => {
  usingFixture((f) => {
    const pack = buildFor(f, { commitments: [f.commitment.id] })
    assert.equal(verifyPack(pack.files).ok, true)

    const variants = [
      ['manifest.json', (text) => text.replace('"entryCount"', '"entryCount" '), 'manifest.json'],
      ['README.txt', (text) => `${text}\ntampered`, 'README.txt'],
      // For SHA256SUMS the verifier reports the file whose digest no longer matches.
      ['SHA256SUMS', (text) => text.replace(/^[0-9a-f]/m, (char) => (char === '0' ? '1' : '0')), 'hash mismatch'],
    ]
    for (const [name, mutate, expectedError] of variants) {
      const broken = { ...pack.files, [name]: mutate(pack.files[name]) }
      const result = verifyPack(broken)
      assert.equal(result.ok, false, `${name} tampering must fail verification`)
      assert.ok(result.errors.length > 0, `${name} tampering must report an error`)
      assert.equal(
        result.errors.some((error) => error.includes(expectedError)),
        true,
        `${name} tampering must report "${expectedError}": ${result.errors.join(' | ')}`,
      )
    }

    const { 'README.txt': _omitted, ...withoutReadme } = pack.files
    assert.equal(verifyPack(withoutReadme).ok, false)
    assert.equal(verifyPack({ ...pack.files, 'extra.txt': 'smuggled' }).ok, false)
    assert.equal(verifyPack({ 'manifest.json': pack.files['manifest.json'], 'README.txt': pack.files['README.txt'] }).ok, false)
    assert.equal(verifyPack({}).ok, false)
    assert.equal(verifyPack(null).ok, false)

    const tamperedManifest = { ...pack.files, 'manifest.json': '{not json' }
    assert.equal(verifyPack(tamperedManifest).ok, false)
    assert.ok(verifyPack(tamperedManifest).errors.some((error) => /manifest\.json/.test(error)))
  })
})

test('verifyPack accepts Buffer contents as well as strings', () => {
  usingFixture((f) => {
    const pack = buildFor(f, { commitments: [f.commitment.id] })
    const asBuffers = Object.fromEntries(
      Object.entries(pack.files).map(([name, text]) => [name, Buffer.from(text, 'utf8')]),
    )
    assert.deepEqual(verifyPack(asBuffers), { ok: true, errors: [] })
    const broken = { ...asBuffers, 'README.txt': Buffer.concat([asBuffers['README.txt'], Buffer.from('x')]) }
    assert.equal(verifyPack(broken).ok, false)
  })
})

// ---------------------------------------------------------------------------
// privacy contract: no absolute paths, no full bodies, quotes capped
// ---------------------------------------------------------------------------

test('pack keeps only references, capped quotes and hashes', () => {
  usingFixture((f) => {
    const secretBody = '客户正文全文标记：这段内容绝不能出现在证据包里。'
    const longTurn = f.store.addTurn({
      conversationId: 'conv-2',
      role: 'user',
      content: `${secretBody}${'长'.repeat(900)}`,
    })
    const longQuote = `原话：${'张'.repeat(700)}`
    const commitment = f.ledger.addCommitment({
      matterId: f.matter.id,
      debtor: 'user',
      creditor: '王工',
      action: '内部动作标记：不要外泄全文',
      evidence: [{ sessionId: 'conv-2', turnId: longTurn.id, quote: longQuote }],
    })
    const pack = buildFor(f, { commitments: [commitment.id] })
    const manifestText = pack.files['manifest.json']
    const readme = pack.files['README.txt']
    const manifest = JSON.parse(manifestText)
    const source = manifest.entries[0].sources[0]

    assert.equal(source.truncated, true)
    assert.equal(source.quoteChars, longQuote.length)
    assert.equal(Array.from(source.quote).length, MAX_QUOTE_CHARS)
    assert.equal(source.quote, longQuote.slice(0, MAX_QUOTE_CHARS))
    assert.equal(source.quoteSha256, sha256Hex(source.quote))

    assert.equal(manifestText.includes('长'.repeat(MAX_QUOTE_CHARS + 1)), false)
    assert.equal(manifestText.includes(secretBody), false)
    assert.equal(readme.includes(secretBody), false)
    assert.equal(manifestText.includes('内部动作标记'), false)
    assert.equal(readme.includes('内部动作标记'), false)

    for (const text of [manifestText, readme, pack.files['SHA256SUMS']]) {
      assert.equal(text.includes(f.dir), false, 'pack must not leak the database directory')
      assert.equal(text.includes(tmpdir()), false, 'pack must not leak the temp root')
      assert.equal(text.includes(process.cwd()), false, 'pack must not leak the working directory')
      assert.equal(/\/mnt\/|[A-Za-z]:\\/.test(text), false, 'pack must not contain absolute paths')
    }

    // Missing evidence quotes are capped too.
    const badFact = f.ledger.remember({
      subject: '客户A',
      predicate: 'badref',
      object: 'z',
      matterId: f.matter.id,
      evidence: [{ quote: '丢'.repeat(600), ref: 'definitely-not-a-ref' }],
    })
    const badPack = buildFor(f, { facts: [badFact.id] })
    const missing = JSON.parse(badPack.files['manifest.json']).entries[0].missing[0]
    assert.equal(missing.reason, 'unparseable_ref')
    assert.equal(Array.from(missing.quote).length, MAX_QUOTE_CHARS)
    assert.equal(missing.truncated, true)
    assert.equal(missing.quoteSha256, sha256Hex(missing.quote))
    assert.equal(badPack.files['manifest.json'].includes('丢'.repeat(MAX_QUOTE_CHARS + 1)), false)

    assert.equal(verifyPack(pack.files).ok, true)
    assert.equal(verifyPack(badPack.files).ok, true)
  })
})

// ---------------------------------------------------------------------------
// flexible ids + transparent not-found handling
// ---------------------------------------------------------------------------

test('buildEvidencePack accepts flexible id inputs and reports not-found records', () => {
  usingFixture((f) => {
    const pack = buildFor(f, [f.commitment.id, f.fact.id, f.preference.id, 'ghost_123'])
    const manifest = JSON.parse(pack.files['manifest.json'])
    assert.deepEqual(manifest.entries.map((entry) => entry.kind), [
      'commitment',
      'fact',
      'preference',
      'unknown',
    ])
    assert.deepEqual(pack.summary.notFound, ['ghost_123'])
    const ghost = manifest.entries.find((entry) => entry.id === 'ghost_123')
    assert.equal(ghost.found, false)
    assert.deepEqual(ghost.sources, [])
    assert.equal(ghost.missing[0].reason, 'record_not_found')
    assert.equal(verifyPack(pack.files).ok, true)

    const viaObject = buildFor(f, { commitments: f.commitment.id, facts: [f.fact.id] })
    assert.equal(JSON.parse(viaObject.files['manifest.json']).entryCount, 2)

    const empty = buildFor(f, undefined)
    assert.equal(JSON.parse(empty.files['manifest.json']).entryCount, 0)
    assert.match(empty.files['README.txt'], /\(no evidence requested\)/)
    assert.equal(verifyPack(empty.files).ok, true)

    const byObjects = buildFor(f, [
      { kind: 'commitment', id: f.commitment.id },
      { kind: 'fact', id: f.fact.id },
    ])
    assert.equal(JSON.parse(byObjects.files['manifest.json']).entryCount, 2)
  })
})

// ---------------------------------------------------------------------------
// optional DOCX helper
// ---------------------------------------------------------------------------

test('toDocxRows flattens evidence into office table rows', () => {
  usingFixture((f) => {
    const longTurn = f.store.addTurn({ conversationId: 'conv-2', role: 'user', content: 'x'.repeat(900) })
    const commitment = f.ledger.addCommitment({
      matterId: f.matter.id,
      debtor: 'user',
      creditor: '王工',
      action: '发报价',
      evidence: [{ sessionId: 'conv-2', turnId: longTurn.id, quote: 'y'.repeat(900) }],
    })
    const badFact = f.ledger.remember({
      subject: '客户A',
      predicate: 'badref',
      object: 'z',
      matterId: f.matter.id,
      evidence: [{ quote: 'z', ref: 'bad-ref' }],
    })
    const pack = buildFor(f, { commitments: [commitment.id], facts: [badFact.id] })

    const rows = toDocxRows(pack.summary.entries)
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.length, DOCX_EVIDENCE_HEADERS.length)
      for (const cell of row) assert.equal(typeof cell, 'string')
    }
    const resolved = rows.find((row) => row[4] === 'ok')
    assert.equal(resolved[0], 'commitment')
    assert.match(resolved[2], /^conv-2#turn_/)
    assert.ok(Array.from(resolved[3]).length <= MAX_QUOTE_CHARS)
    const missing = rows.find((row) => row[4].startsWith('missing:'))
    assert.match(missing[4], /unparseable_ref/)

    // Whole pack output, raw evidence results and manifest JSON all work.
    assert.deepEqual(toDocxRows(pack), rows)
    const rawRows = toDocxRows([evidenceForCommitment(f.store, f.ledger, commitment.id)])
    assert.equal(rawRows.length, 1)
    assert.equal(rawRows[0][0], 'commitment')
    assert.deepEqual(toDocxRows(pack.files['manifest.json']), rows)
  })
})
