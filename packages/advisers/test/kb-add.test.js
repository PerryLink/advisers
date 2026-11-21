import assert from 'node:assert/strict'
import test from 'node:test'

import {
  kbAdd,
  kbAddMany,
  kbLink,
  kbList,
  kbPurge,
  kbReindex,
  kbRm,
  kbSearch,
  kbShow,
  kbUnlink,
  verifyKbFts,
} from '../lib/kb.js'
import { createKbStore, seedLedger } from './kb-fixture.js'

const DOC = '# 报价单\n\n客户 ACME 需要网站改版报价，总价 80000 元。\n\n## 备注\n\n周五前发送。'

test('kb add: indexes one document, audits once and never stores a path', async () => {
  const fixture = createKbStore('advisers-kb-add-')
  try {
    const { acme, project } = seedLedger(fixture.store)
    fixture.writeFile('报价单.md', DOC)
    const result = await kbAdd(fixture.store, {
      file: '报价单.md',
      cwd: fixture.root,
      kind: 'quote',
      clientId: acme.id,
      projectId: project.id,
      matterId: 'm_acme',
    })
    assert.equal(result.ok, true)
    assert.equal(result.counts.added, 1)
    assert.ok(result.counts.chunks >= 1)
    assert.equal(result.document.sourceName, '报价单.md')
    assert.equal(result.document.title, '报价单')
    assert.equal(result.document.kind, 'quote')
    assert.equal(result.document.clientId, acme.id)
    assert.equal(result.document.projectId, project.id)
    assert.equal(result.document.matterId, 'm_acme')
    assert.equal(result.document.extractor, 'plain')
    assert.equal(result.document.encoding, 'utf-8')
    // The returned JSON and the audit reason never carry the temporary path or the title.
    assert.equal(JSON.stringify(result).includes(fixture.root), false)
    const audits = fixture.store.listAudit(50).filter((entry) => entry.action === 'kb.add')
    assert.equal(audits.length, 1)
    assert.equal(String(audits[0].reason ?? '').includes(fixture.root), false)
    assert.equal(String(audits[0].reason ?? '').includes('报价单'), false)
    const listed = kbList(fixture.store)
    assert.equal(listed.total, 1)
    assert.equal(listed.documents[0].chunkCount, result.counts.chunks)
    const shown = kbShow(fixture.store, result.document.id, { chunks: 5 })
    assert.equal(shown.chunks.length, result.counts.chunks)
    assert.ok(shown.chunks[0].text.length <= 400)
    assert.equal(shown.chunks[0].charCount > 0, true)
  } finally { fixture.cleanup() }
})

test('kb add: duplicate is a skip-level error, --replace tombstones the old row', async () => {
  const fixture = createKbStore('advisers-kb-dup-')
  try {
    fixture.writeFile('a.md', '# A\n\nfirst body')
    const first = await kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root })
    await assert.rejects(
      () => kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root }),
      (error) => error.code === 'E_KB_DUPLICATE' && error.existingId === first.document.id && error.skip === true,
    )
    const replaced = await kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root, replace: true })
    assert.equal(replaced.replacedId, first.document.id)
    assert.notEqual(replaced.document.id, first.document.id)
    const active = kbList(fixture.store)
    assert.equal(active.total, 1)
    const all = kbList(fixture.store, { all: true })
    assert.equal(all.total, 2)
    const tombstone = all.documents.find((doc) => doc.id === first.document.id)
    assert.equal(tombstone.status, 'deleted')
    assert.ok(tombstone.deletedAt)
    const hits = kbSearch(fixture.store, 'first')
    assert.ok(hits.total >= 1, 'the replacement document with the same bytes is searchable')
    assert.equal(hits.hits.some((hit) => hit.docId === first.document.id), false, 'tombstoned chunks must not be searchable')
  } finally { fixture.cleanup() }
})

test('kb add: batch aggregation counts added / skipped / failed per file', async () => {
  const fixture = createKbStore('advisers-kb-batch-')
  try {
    fixture.writeFile('a.md', '# A\n\nbatch one')
    await kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root })
    fixture.writeFile('b.md', '# B\n\nbatch two')
    fixture.writeFile('c.exe', Buffer.from('not a document'))
    const result = await kbAddMany(fixture.store, { files: ['a.md', 'missing.md', 'b.md', 'c.exe'], cwd: fixture.root })
    assert.equal(result.counts.added, 1)
    assert.equal(result.counts.skipped, 1)
    assert.equal(result.counts.failed, 2)
    assert.equal(result.ok, true)
    assert.equal(result.skipped[0].code, 'E_KB_DUPLICATE')
    assert.equal(result.failed[0].file, 'missing.md')
    assert.equal(result.failed.some((entry) => entry.code === 'E_KB_UNSUPPORTED'), true)
    assert.equal(JSON.stringify(result).includes(fixture.root), false)
    await assert.rejects(() => kbAddMany(fixture.store, { files: [] }), (error) => error.code === 'E_KB_INVALID')
  } finally { fixture.cleanup() }
})

test('kb add: ownership resolution and typed argument errors', async () => {
  const fixture = createKbStore('advisers-kb-owner-')
  try {
    const { acme, project, secret } = seedLedger(fixture.store)
    fixture.writeFile('a.md', '# A\n\nowner test')
    const byProject = await kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root, projectId: project.id })
    assert.equal(byProject.document.clientId, acme.id, 'client is resolved from the project')
    const byMatter = await kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root, matterId: 'm_acme', replace: true })
    assert.equal(byMatter.document.projectId, project.id, 'project is resolved from the matter')
    await assert.rejects(
      () => kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root, clientId: secret.id, matterId: 'm_acme' }),
      (error) => error.code === 'E_MATTER_CLIENT_MISMATCH',
    )
    await assert.rejects(() => kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root, matterId: 'm_missing' }), (error) => error.code === 'E_MATTER_NOT_FOUND')
    await assert.rejects(() => kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root, projectId: 'prj_missing' }), (error) => error.code === 'E_PROJECT_NOT_FOUND')
    await assert.rejects(() => kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root, clientId: 'cl_missing' }), (error) => error.code === 'E_CLIENT_NOT_FOUND')
    await assert.rejects(() => kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root, secrecy: 4 }), (error) => error.code === 'E_KB_INVALID')
    await assert.rejects(() => kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root, kind: 'bogus' }), (error) => error.code === 'E_KB_INVALID')
    await assert.rejects(() => kbAdd(fixture.store, { file: 'nope.md', cwd: fixture.root }), (error) => error.code === 'E_KB_READ')
  } finally { fixture.cleanup() }
})

test('kb add: scanned/image files are recorded as needsOcr without fake content', async () => {
  const fixture = createKbStore('advisers-kb-ocr-')
  try {
    fixture.writeFile('scan.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
    const result = await kbAdd(fixture.store, { file: 'scan.png', cwd: fixture.root })
    assert.equal(result.document.needsOcr, true)
    assert.equal(result.document.chunkCount, 0)
    assert.equal(result.document.textBytes, 0)
    assert.equal(result.needsOcr, true)
    assert.ok(result.warnings.length >= 1)
    const scanHits = kbSearch(fixture.store, 'scan')
    assert.equal(scanHits.counts.kbChunks, 0)
    assert.equal(scanHits.hits.every((hit) => hit.kind !== 'kb_chunk'), true)
  } finally { fixture.cleanup() }
})

test('kb lifecycle: ls/show/rm/purge are honest about replay and deletion', async () => {
  const fixture = createKbStore('advisers-kb-life-')
  try {
    const { acme } = seedLedger(fixture.store)
    fixture.writeFile('quote.md', '# Quote\n\nsecret quote body 12345')
    const added = await kbAdd(fixture.store, { file: 'quote.md', cwd: fixture.root, clientId: acme.id, kind: 'quote' })
    const id = added.document.id
    const filtered = kbList(fixture.store, { clientId: acme.id, kind: 'quote' })
    assert.equal(filtered.total, 1)
    const removed = kbRm(fixture.store, id)
    assert.equal(removed.counts.chunks, added.counts.chunks)
    assert.throws(() => kbShow(fixture.store, id), (error) => error.code === 'E_KB_NOT_FOUND')
    assert.throws(() => kbRm(fixture.store, id), (error) => error.code === 'E_KB_NOT_FOUND')
    assert.equal(kbList(fixture.store, { all: true }).total, 1)
    assert.equal(kbList(fixture.store, { all: true }).documents[0].status, 'deleted')
    const dry = kbPurge(fixture.store, id)
    assert.equal(dry.dryRun, true)
    assert.equal(dry.purged, false)
    assert.equal(dry.counts.chunks, 0)
    assert.ok(fixture.store.db.prepare('SELECT id FROM kb_documents WHERE id = ?').get(id))
    const purged = kbPurge(fixture.store, id, { yes: true })
    assert.equal(purged.purged, true)
    assert.equal(fixture.store.db.prepare('SELECT id FROM kb_documents WHERE id = ?').get(id), undefined)
    assert.equal(kbList(fixture.store, { all: true }).total, 0)
    const actions = fixture.store.listAudit(50).map((entry) => entry.action)
    assert.ok(actions.includes('kb.rm'))
    assert.ok(actions.includes('kb.purge'))
  } finally { fixture.cleanup() }
})

test('kb reindex: detects FTS drift and repairs it from kb_chunks', async () => {
  const fixture = createKbStore('advisers-kb-reindex-')
  try {
    fixture.writeFile('a.md', '# A\n\ndrift body 111')
    fixture.writeFile('b.md', '# B\n\ndrift body 222')
    await kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root })
    await kbAdd(fixture.store, { file: 'b.md', cwd: fixture.root })
    const healthy = verifyKbFts(fixture.store)
    assert.equal(healthy.ok, true)
    assert.equal(healthy.tables.kb_fts.count, 2)
    // Simulate a lost index: external-content FTS supports delete-all.
    fixture.store.db.exec("INSERT INTO kb_fts(kb_fts) VALUES('delete-all')")
    const drifted = verifyKbFts(fixture.store)
    assert.equal(drifted.ok, false)
    const repaired = kbReindex(fixture.store)
    assert.equal(repaired.ok, true)
    assert.ok(repaired.rebuilt.includes('kb_fts'))
    assert.equal(repaired.integrity.tables.kb_fts.count, repaired.counts.chunks)
    assert.ok(kbSearch(fixture.store, 'drift').total > 0)
    const forced = kbReindex(fixture.store, { rebuild: true })
    assert.equal(forced.ok, true)
    assert.equal(fixture.store.listAudit(50).filter((entry) => entry.action === 'kb.reindex').length >= 2, true)
  } finally { fixture.cleanup() }
})

test('kb link/unlink: explicit fact provenance is validated and idempotent', async () => {
  const fixture = createKbStore('advisers-kb-link-')
  try {
    seedLedger(fixture.store)
    fixture.writeFile('a.md', '# A\n\nlink body')
    const added = await kbAdd(fixture.store, { file: 'a.md', cwd: fixture.root })
    const linked = kbLink(fixture.store, { docId: added.document.id, factId: 'fact_quote', relation: 'source' })
    assert.equal(linked.link.relation, 'source')
    const rows = fixture.store.db.prepare('SELECT fact_id, doc_id, relation FROM kb_fact_links').all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].fact_id, 'fact_quote')
    const unlinked = kbUnlink(fixture.store, { docId: added.document.id, factId: 'fact_quote' })
    assert.equal(unlinked.removed, 1)
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS n FROM kb_fact_links').get().n, 0)
    const again = kbUnlink(fixture.store, { docId: added.document.id, factId: 'fact_quote' })
    assert.equal(again.removed, 0)
    assert.throws(() => kbLink(fixture.store, { docId: added.document.id, factId: 'fact_missing' }), (error) => error.code === 'E_FACT_NOT_FOUND')
    assert.throws(() => kbLink(fixture.store, { docId: added.document.id, factId: 'fact_quote', relation: 'bogus' }), (error) => error.code === 'E_KB_INVALID')
    assert.throws(() => kbLink(fixture.store, { docId: 'kb_missing', factId: 'fact_quote' }), (error) => error.code === 'E_KB_NOT_FOUND')
  } finally { fixture.cleanup() }
})
