import assert from 'node:assert/strict'
import test from 'node:test'

import {
  KB_PAGE_GENERATOR,
  canonicalJson,
  clientPageId,
  factsPageId,
  kbPageDiff,
  kbPageList,
  kbPageRebuild,
  kbPageShow,
  parseKbPageId,
  projectPageId,
  sha256Hex,
  timelinePageId,
  unifiedDiff,
} from '../lib/kb-pages.js'
import { createKbStore, seedLedger } from './kb-fixture.js'

function pageRows(store) {
  return store.db.prepare('SELECT id, kind, subject_id, title, markdown, json, source_refs, inputs_sha256, generated_at, status FROM kb_pages ORDER BY id').all()
}

test('kb pages: rebuild writes the four kinds with stable ids and no wall clock', () => {
  const fixture = createKbStore('advisers-kb-pages-')
  try {
    const { acme, project } = seedLedger(fixture.store)
    const result = kbPageRebuild(fixture.store, {})
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, false)
    assert.equal(result.counts.built, 7)
    assert.equal(result.counts.written, 7)
    assert.equal(result.counts.unchanged, 0)
    assert.equal(result.counts.skipped, 0)
    const rows = pageRows(fixture.store)
    assert.deepEqual([...new Set(rows.map((row) => row.kind))].sort(), ['client', 'facts', 'project', 'timeline'])
    const byId = new Map(rows.map((row) => [row.id, row]))
    assert.ok(byId.has(clientPageId(acme.id)))
    assert.ok(byId.has(timelinePageId(acme.id)))
    assert.ok(byId.has(projectPageId(project.id)))
    assert.ok(byId.has(factsPageId('ACME', 'm_acme')))
    for (const row of rows) {
      const identity = parseKbPageId(row.id)
      assert.ok(identity, 'page id must be stable and parseable: ' + row.id)
      const data = JSON.parse(row.json)
      assert.equal(data.generator, KB_PAGE_GENERATOR)
      assert.equal(canonicalJson(data), row.json, 'json column is canonical JSON')
      assert.equal(sha256Hex(row.json), row.inputs_sha256, 'inputsSha256 hashes the canonical content')
      assert.equal(row.status, 'generated')
      assert.equal(JSON.stringify(data).includes('generatedAt'), false, 'page content must not contain the wall clock')
      assert.equal(data.generatedAt, undefined)
      assert.match(row.markdown, /^# /)
      const refs = JSON.parse(row.source_refs)
      assert.ok(Array.isArray(refs))
    }
    // Idempotent: a second rebuild writes nothing and keeps every byte.
    const snapshot = new Map(rows.map((row) => [row.id, { markdown: row.markdown, json: row.json, hash: row.inputs_sha256 }]))
    const second = kbPageRebuild(fixture.store, {})
    assert.equal(second.counts.written, 0)
    assert.equal(second.counts.unchanged, 7)
    for (const row of pageRows(fixture.store)) {
      const before = snapshot.get(row.id)
      assert.equal(row.markdown, before.markdown)
      assert.equal(row.json, before.json)
      assert.equal(row.inputs_sha256, before.hash)
    }
    assert.equal(kbPageList(fixture.store, { check: true }).staleCount, 0)
  } finally { fixture.cleanup() }
})

test('kb pages: client/project/timeline/facts content and source refs', () => {
  const fixture = createKbStore('advisers-kb-pages-content-')
  try {
    const { acme, project } = seedLedger(fixture.store)
    kbPageRebuild(fixture.store, {})
    const client = kbPageShow(fixture.store, clientPageId(acme.id))
    assert.equal(client.stale, false)
    assert.equal(client.page.data.client.name, 'ACME')
    assert.equal(client.page.data.counts.matters, 1)
    assert.equal(client.page.data.counts.notes, 1)
    assert.equal(client.page.data.counts.openMine, 1)
    assert.equal(client.page.data.open.mine[0].id, 'cm_acme')
    assert.equal(client.page.data.facts.length, 1)
    assert.equal(client.page.data.facts[0].validFrom, '2026-01-01T00:00:00.000Z')
    assert.ok(client.page.data.timeline.length >= 2)
    assert.ok(client.page.sourceRefs.some((ref) => ref.kind === 'fact' && ref.id === 'fact_quote'))
    assert.ok(client.page.sourceRefs.some((ref) => ref.kind === 'client' && ref.id === acme.id))
    assert.ok(client.page.sourceRefs.some((ref) => ref.kind === 'commitment' && ref.id === 'cm_acme'))
    // Note bodies are counted, never rendered (design 45 section 3.6).
    assert.equal(client.page.markdown.includes('电话确认预算 8 万'), false)
    const projectPage = kbPageShow(fixture.store, projectPageId(project.id))
    assert.equal(projectPage.page.data.project.name, 'Website relaunch')
    assert.equal(projectPage.page.data.matters.length, 1)
    assert.equal(projectPage.page.data.deliveries.length, 1)
    assert.equal(projectPage.page.data.open.mine[0].id, 'cm_acme')
    const timeline = kbPageShow(fixture.store, timelinePageId(acme.id))
    assert.ok(timeline.page.data.timeline.length >= 2)
    assert.ok(timeline.page.data.timelineTotal >= 2)
    const facts = kbPageShow(fixture.store, factsPageId('ACME', 'm_acme'))
    assert.equal(facts.page.data.subject, 'ACME')
    assert.equal(facts.page.data.matterId, 'm_acme')
    assert.equal(facts.page.data.facts.length, 1)
    assert.equal(facts.page.data.facts[0].object, '80000')
    assert.equal(facts.page.data.facts[0].evidence[0].quote, 'budget is 80000')
    assert.ok(facts.page.markdown.includes('quote.total'))
  } finally { fixture.cleanup() }
})

test('kb pages: stale detection reacts only to changed ledger inputs', () => {
  const fixture = createKbStore('advisers-kb-pages-stale-')
  try {
    const { acme } = seedLedger(fixture.store)
    kbPageRebuild(fixture.store, {})
    const before = kbPageShow(fixture.store, clientPageId(acme.id))
    fixture.store.addDelivery({ matterId: 'm_acme', conversationId: 'conv-1', files: ['quote-v2.pdf'], tool: 'deliver:quote', title: 'quote-v2.pdf' })
    const after = kbPageShow(fixture.store, clientPageId(acme.id))
    assert.equal(after.stale, true)
    const diff = kbPageDiff(fixture.store, clientPageId(acme.id))
    assert.equal(diff.stale, true)
    assert.ok(diff.diff.length > 0)
    assert.ok(diff.diff.split('\n').some((line) => line.startsWith('+')))
    const listed = kbPageList(fixture.store, { check: true })
    assert.ok(listed.staleCount >= 2, 'client + timeline (and project) pages must be flagged stale')
    const stored = kbPageShow(fixture.store, clientPageId(acme.id), { stored: true })
    assert.equal(stored.page.markdown, before.page.markdown, 'stored view returns the previous bytes')
    const rebuilt = kbPageRebuild(fixture.store, {})
    assert.ok(rebuilt.counts.written >= 2)
    assert.equal(kbPageShow(fixture.store, clientPageId(acme.id)).stale, false)
    assert.equal(kbPageList(fixture.store, { check: true }).staleCount, 0)
  } finally { fixture.cleanup() }
})

test('kb pages: clearance filters before counting and fails closed on show', () => {
  const fixture = createKbStore('advisers-kb-pages-clear-')
  try {
    const { acme, secret } = seedLedger(fixture.store)
    kbPageRebuild(fixture.store, {})
    const hidden = kbPageList(fixture.store, { clearance: 0 })
    assert.ok(hidden.protectedExcluded >= 3, 'secret client/timeline/facts pages are withheld')
    assert.equal(hidden.pages.some((page) => page.subjectId === secret.id), false)
    assert.ok(hidden.pages.some((page) => page.subjectId === acme.id), 'the visible client page is still listed')
    const visible = kbPageList(fixture.store, { clearance: 3 })
    assert.equal(visible.protectedExcluded, 0)
    assert.ok(visible.pages.some((page) => page.subjectId === secret.id))
    assert.throws(() => kbPageShow(fixture.store, clientPageId(secret.id), { clearance: 0 }), (error) => error.code === 'E_KB_PAGE_NOT_FOUND')
    assert.equal(kbPageShow(fixture.store, clientPageId(secret.id), { clearance: 3 }).page.data.client.name, 'Secret Target')
    const scoped = kbPageRebuild(fixture.store, { clearance: 0 })
    assert.ok(scoped.counts.built < 7)
    assert.throws(() => kbPageShow(fixture.store, clientPageId(secret.id), { clearance: 0 }), (error) => error.code === 'E_KB_PAGE_NOT_FOUND')
  } finally { fixture.cleanup() }
})

test('kb pages: rebuild filters, dry-run and audit accounting', () => {
  const fixture = createKbStore('advisers-kb-pages-rebuild-')
  try {
    const { acme } = seedLedger(fixture.store)
    const first = kbPageRebuild(fixture.store, { kind: 'client' })
    assert.equal(first.counts.built, 2)
    assert.equal(first.pages.every((page) => page.kind === 'client'), true)
    const auditCount = () => fixture.store.listAudit(100).filter((entry) => entry.action === 'kb.page.rebuild').length
    assert.equal(auditCount(), 1)
    const rowsBefore = pageRows(fixture.store).map((row) => row.inputs_sha256 + ':' + row.markdown)
    const dry = kbPageRebuild(fixture.store, { dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.ok(dry.counts.built >= 5)
    assert.equal(auditCount(), 1, 'a dry run writes no audit row')
    assert.deepEqual(pageRows(fixture.store).map((row) => row.inputs_sha256 + ':' + row.markdown), rowsBefore)
    const single = kbPageRebuild(fixture.store, { id: clientPageId(acme.id) })
    assert.equal(single.counts.built, 1)
    assert.equal(single.counts.unchanged, 1)
    assert.throws(() => kbPageRebuild(fixture.store, { id: 'page_client_missing' }), (error) => error.code === 'E_KB_PAGE_NOT_FOUND')
    assert.throws(() => kbPageRebuild(fixture.store, { kind: 'bogus' }), (error) => error.code === 'E_KB_INVALID')
    assert.throws(() => kbPageList(fixture.store, { kind: 'bogus' }), (error) => error.code === 'E_KB_INVALID')
    assert.throws(() => kbPageShow(fixture.store, 'page_client_missing'), (error) => error.code === 'E_KB_PAGE_NOT_FOUND')
    // A page whose source rows vanished is stale with an explicit reason, never faked.
    kbPageRebuild(fixture.store, {})
    fixture.store.db.exec("DELETE FROM facts WHERE subject = 'ACME'")
    const checked = kbPageList(fixture.store, { check: true, kind: 'facts' })
    const orphan = checked.pages.find((page) => page.id === factsPageId('ACME', 'm_acme'))
    assert.ok(orphan)
    assert.equal(orphan.stale, true)
    assert.equal(orphan.staleReason, 'source_missing')
    const untouched = checked.pages.find((page) => page.id === factsPageId('Target', 'm_secret'))
    assert.equal(untouched.stale, false)
    assert.equal(unifiedDiff('a\nb', 'a\nc').split('\n').filter((line) => line.startsWith('+')).length, 1)
  } finally { fixture.cleanup() }
})
