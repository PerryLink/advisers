import assert from 'node:assert/strict'
import test from 'node:test'

import { kbAdd, kbList, kbSearch, kbShow } from '../lib/kb.js'
import { kbPageRebuild } from '../lib/kb-pages.js'
import { createKbStore, seedLedger } from './kb-fixture.js'

async function fixtureWithDocs() {
  const fixture = createKbStore('advisers-kb-search-')
  const { acme, secret } = seedLedger(fixture.store)
  fixture.writeFile('quote.md', '# 报价单 2026\n\n客户 ACME 需要网站改版报价，总价 80000 元。\n\n周五前发送报价单。')
  fixture.writeFile('notes.md', '# 会议记录\n\n讨论报价策略与预算。')
  fixture.writeFile('secret.md', '# Secret plan\n\n机密内容 secret acquisition alpha.')
  const quote = await kbAdd(fixture.store, { file: 'quote.md', cwd: fixture.root, kind: 'quote', clientId: acme.id, matterId: 'm_acme', title: '报价单 2026' })
  const notes = await kbAdd(fixture.store, { file: 'notes.md', cwd: fixture.root, kind: 'note', title: '会议记录' })
  const secretDoc = await kbAdd(fixture.store, { file: 'secret.md', cwd: fixture.root, kind: 'note', clientId: secret.id, matterId: 'm_secret', secrecy: 2, title: 'Secret plan' })
  return { fixture, acme, secret, quote, notes, secretDoc }
}

test('kb search: FTS MATCH for 3+ characters, title hits rank before chunk hits', async () => {
  const { fixture, quote } = await fixtureWithDocs()
  try {
    const result = kbSearch(fixture.store, '报价单')
    assert.equal(result.ok, true)
    assert.equal(result.command, 'search')
    assert.deepEqual(result.degraded, [])
    assert.ok(result.counts.kbChunks >= 1)
    assert.ok(result.counts.kbDocs >= 1)
    assert.equal(result.hits[0].kind, 'kb_doc', 'title hits come first')
    assert.equal(result.hits[0].docId, quote.document.id)
    const chunkHit = result.hits.find((hit) => hit.kind === 'kb_chunk')
    assert.ok(chunkHit)
    assert.equal(chunkHit.matchPath, 'match')
    assert.match(chunkHit.snippet, /报价单/)
    assert.ok(chunkHit.highlights.length >= 1)
    for (const range of chunkHit.highlights) {
      assert.ok(range.start >= 0 && range.end > range.start && range.end <= chunkHit.snippet.length)
      assert.equal(chunkHit.snippet.slice(range.start, range.end), '报价单')
    }
    assert.ok([...chunkHit.snippet].length <= 240)
    assert.equal(chunkHit.ref.kind, 'kb_chunk')
  } finally { fixture.cleanup() }
})

test('kb search: 2-character queries use LIKE and report degraded reasons', async () => {
  const { fixture } = await fixtureWithDocs()
  try {
    const result = kbSearch(fixture.store, '报价')
    assert.ok(result.degraded.includes('short_query_like'))
    assert.ok(result.counts.kbChunks >= 2, 'both the quote and the notes documents contain 报价')
    const chunkHits = result.hits.filter((hit) => hit.kind === 'kb_chunk')
    assert.ok(chunkHits.length >= 1)
    assert.equal(chunkHits[0].matchPath, 'like')
    for (const hit of chunkHits) {
      assert.ok(hit.highlights.length >= 1)
      for (const range of hit.highlights) assert.equal(hit.snippet.slice(range.start, range.end), '报价')
    }
    const single = kbSearch(fixture.store, '报')
    assert.ok(single.degraded.includes('short_query_like'))
    assert.ok(single.counts.kbChunks >= 1)
  } finally { fixture.cleanup() }
})

test('kb search: FTS syntax and control characters never throw', async () => {
  const { fixture } = await fixtureWithDocs()
  try {
    for (const query of ['"*(报价)*"', 'NEAR(报价 单)', '报价 AND', '-报价单', '***']) {
      const result = kbSearch(fixture.store, query)
      assert.equal(result.ok, true)
      assert.ok(Array.isArray(result.hits))
    }
    assert.throws(() => kbSearch(fixture.store, '   '), (error) => error.code === 'E_USAGE')
    assert.throws(() => kbSearch(fixture.store, 'x'.repeat(201)), (error) => error.code === 'E_QUERY_TOO_LONG')
    assert.throws(() => kbSearch(fixture.store, '报价单', { scope: 'bogus' }), (error) => error.code === 'E_KB_INVALID')
    assert.throws(() => kbSearch(fixture.store, null), (error) => error.code === 'E_KB_INVALID')
  } finally { fixture.cleanup() }
})

test('kb search: snippets strip terminal escapes/control chars and highlights stay inside', async () => {
  const fixture = createKbStore('advisers-kb-inject-')
  try {
    seedLedger(fixture.store)
    fixture.writeFile('evil.md', '标题\n\n\u001b[31m报价单\u0007 前半句，\u202e报价单后半句\r\n')
    await kbAdd(fixture.store, { file: 'evil.md', cwd: fixture.root, title: 'evil' })
    const result = kbSearch(fixture.store, '报价单')
    assert.equal(result.degraded.length, 0)
    const hit = result.hits.find((entry) => entry.kind === 'kb_chunk')
    assert.ok(hit)
    assert.equal(hit.snippet.includes('\u001b'), false)
    assert.equal(hit.snippet.includes('\u0007'), false)
    assert.equal(hit.snippet.includes('\u202e'), false)
    assert.equal(hit.snippet.includes('\n'), false)
    for (const range of hit.highlights) assert.equal(hit.snippet.slice(range.start, range.end), '报价单')
  } finally { fixture.cleanup() }
})

test('kb search: limit/total/truncated and kind/client filters', async () => {
  const { fixture, quote, notes, acme } = await fixtureWithDocs()
  try {
    const limited = kbSearch(fixture.store, '报价', { limit: 1 })
    assert.equal(limited.limit, 1)
    assert.equal(limited.hits.length, 1)
    assert.ok(limited.total >= 2)
    assert.equal(limited.truncated, true)
    const noteOnly = kbSearch(fixture.store, '报价', { kind: 'note' })
    assert.ok(noteOnly.counts.kbChunks >= 1)
    assert.equal(noteOnly.hits.every((hit) => hit.docId === notes.document.id), true)
    const clientOnly = kbSearch(fixture.store, '报价', { clientId: acme.id })
    assert.ok(clientOnly.counts.kbChunks >= 1)
    assert.equal(clientOnly.hits.every((hit) => hit.docId === quote.document.id), true)
    assert.throws(() => kbSearch(fixture.store, '报价', { kind: 'bogus' }), (error) => error.code === 'E_KB_INVALID')
  } finally { fixture.cleanup() }
})

test('kb search: clearance filters before counting and only reports protectedExcluded', async () => {
  const { fixture, secretDoc } = await fixtureWithDocs()
  try {
    const hidden = kbSearch(fixture.store, '机密内容', { clearance: 0 })
    assert.equal(hidden.total, 0)
    assert.equal(hidden.counts.kbChunks, 0)
    assert.equal(hidden.counts.kbDocs, 0)
    assert.ok(hidden.protectedExcluded >= 1)
    assert.equal(hidden.hits.length, 0)
    const visible = kbSearch(fixture.store, '机密内容', { clearance: 3 })
    assert.ok(visible.counts.kbChunks >= 1)
    assert.equal(visible.protectedExcluded, 0)
    const listHidden = kbList(fixture.store, { clearance: 0 })
    assert.equal(listHidden.total, 2)
    assert.equal(listHidden.protectedExcluded, 1)
    const listVisible = kbList(fixture.store, { clearance: 3 })
    assert.equal(listVisible.total, 3)
    assert.throws(() => kbShow(fixture.store, secretDoc.document.id, { clearance: 0 }), (error) => error.code === 'E_KB_NOT_FOUND')
    const shown = kbShow(fixture.store, secretDoc.document.id, { clearance: 3 })
    assert.equal(shown.document.secrecy, 2)
  } finally { fixture.cleanup() }
})

test('kb search: pages scope queries rebuilt pages', async () => {
  const { fixture } = await fixtureWithDocs()
  try {
    const rebuilt = kbPageRebuild(fixture.store, {})
    assert.ok(rebuilt.counts.built >= 2)
    // Client/project/timeline/facts pages derive from the ledger, not from KB
    // documents, so the query must be a ledger term (the client name here).
    const pages = kbSearch(fixture.store, 'ACME', { scope: 'pages' })
    assert.ok(pages.counts.kbPages >= 1)
    assert.ok(pages.hits.length >= 1)
    assert.equal(pages.hits[0].kind, 'kb_page')
    assert.ok(pages.hits[0].snippet.length > 0)
    assert.equal(pages.hits[0].ref.kind, 'kb_page')
    const all = kbSearch(fixture.store, 'ACME', { scope: 'all' })
    assert.ok(all.counts.kbChunks >= 1)
    assert.ok(all.counts.kbPages >= 1)
    assert.ok(all.hits.some((hit) => hit.kind === 'kb_chunk'))
    assert.ok(all.hits.some((hit) => hit.kind === 'kb_page'))
  } finally { fixture.cleanup() }
})
