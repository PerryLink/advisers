import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_TIMELINE_LIMIT,
  MAX_TIMELINE_LIMIT,
  TIMELINE_DEGRADED,
  TIMELINE_KIND_ORDER,
  createCommitment,
  deriveClientTimeline,
  filterTimelineItems,
  splitOpenCommitments,
  summarizeClientCounts,
  timelineTitle,
  timelineTitleFromSummary,
  type TimelineItem,
} from '../src/index.ts'

const NOW = '2026-11-20T00:00:00.000Z'

function ports(now = NOW) {
  let seq = 0
  return {
    clock: { now: () => now },
    ids: { next: (prefix: string) => `${prefix}_${++seq}` },
  }
}

test('createCommitment stamps createdAt for the derived timeline (additive)', () => {
  const created = createCommitment(ports(), {
    matterId: 'm1',
    debtor: 'agent',
    creditor: 'user',
    action: '发报价',
    evidence: [{ sessionId: 's1', turnId: 't1', quote: '周五前发' }],
  })
  assert.equal(created.createdAt, NOW)
  assert.equal(created.status, 'open')
})

test('Matter ownership ids survive the wire round-trip additively', () => {
  const matter = {
    id: 'm1', title: '王工 · 官网改版', status: 'active' as const, domain: 'consulting', secrecy: 0 as const,
    participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW,
    clientId: 'cl_wang', projectId: 'prj_site',
  }
  const json = JSON.parse(JSON.stringify({ version: 1, matters: [matter] }))
  assert.equal(json.matters[0].clientId, 'cl_wang')
  assert.equal(json.matters[0].projectId, 'prj_site')
})

test('deriveClientTimeline merges sources by instant DESC, kind order, then id', () => {
  const result = deriveClientTimeline({
    matters: [
      { id: 'm_site', clientId: 'cl_wang', projectId: 'prj_site', secrecy: 1 },
      { id: 'm_other', clientId: 'cl_li', projectId: 'prj_other' },
    ],
    deliveries: [
      { id: 'del_b', matterId: 'm_site', title: '报价单', templateName: 'quote', createdAt: '2026-11-17T03:00:00.000Z' },
      { id: 'del_a', matterId: 'm_site', createdAt: '2026-11-17T03:00:00.000Z' }, // same instant, id breaks the tie
    ],
    notes: [{ id: 'note_call', clientId: 'cl_wang', projectId: 'prj_site', at: '2026-11-18T09:00:00.000Z', summary: '电话确认预算 8 万\n第二行不显示' }],
    commitments: [{ id: 'cm_quote', matterId: 'm_site', action: '发修订报价', debtor: 'agent', creditor: '王工', status: 'open', createdAt: '2026-11-10T01:00:00.000Z' }],
    facts: [{ id: 'fact_budget', matterId: 'm_site', subject: '王工', predicate: '预算', object: '8 万', recordedAt: '2026-11-01T00:00:00.000Z' }],
  })
  assert.deepEqual(result.degraded, [])
  assert.equal(result.total, 5)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.items.map((item) => item.ref.id), ['note_call', 'del_a', 'del_b', 'cm_quote', 'fact_budget'])
  // Every matter-derived item inherits the project id and the matter secrecy.
  const delivery = result.items.find((item) => item.ref.id === 'del_b')!
  assert.equal(delivery.projectId, 'prj_site')
  assert.equal(delivery.secrecy, 1)
  assert.equal(delivery.templateName, 'quote')
  assert.equal(delivery.title, '报价单')
  assert.equal(result.items.find((item) => item.ref.id === 'del_a')!.title, 'del_a', 'a delivery without title/tool falls back to its id')
  assert.equal(result.items.find((item) => item.kind === 'note')!.title, '电话确认预算 8 万', 'the note title is its first line')
  assert.deepEqual(result.items.find((item) => item.kind === 'commitment')!.ref, { kind: 'commitment', id: 'cm_quote' })
})

test('deriveClientTimeline places a commitment at createdAt, never at dueAt', () => {
  const result = deriveClientTimeline({
    commitments: [
      { id: 'cm_future', matterId: 'm1', action: '下周交付', debtor: 'agent', creditor: '王工', status: 'open', dueAt: '2026-12-31T00:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cm_done', matterId: 'm1', action: '已发合同', debtor: 'agent', creditor: '王工', status: 'done', doneAt: '2026-11-05T00:00:00.000Z' },
      { id: 'cm_legacy', matterId: 'm1', action: '旧承诺', debtor: 'agent', creditor: '王工', status: 'open', dueAt: '2026-11-30T00:00:00.000Z' },
      { id: 'cm_dropped', matterId: 'm1', action: '已取消', debtor: 'agent', creditor: '王工', status: 'dropped', doneAt: '2026-11-06T00:00:00.000Z' },
    ],
  })
  const byId = new Map(result.items.map((item) => [item.ref.id, item]))
  assert.equal(byId.get('cm_future')!.at, '2026-11-01T00:00:00.000Z', 'not the future due date')
  assert.equal(byId.get('cm_future')!.dueAt, '2026-12-31T00:00:00.000Z', 'dueAt stays a displayed field')
  assert.equal(byId.get('cm_done')!.at, '2026-11-05T00:00:00.000Z', 'a done commitment with no creation instant falls back to doneAt')
  assert.equal(byId.has('cm_legacy'), false, 'an open commitment with no timestamp cannot be placed')
  assert.deepEqual(result.degraded, [TIMELINE_DEGRADED.commitmentMissingCreatedAt])
})

test('deriveClientTimeline reports unparseable timestamps instead of inventing an instant', () => {
  const result = deriveClientTimeline({
    deliveries: [{ id: 'del_bad', matterId: 'm1', createdAt: 'not-a-date' }],
    notes: [{ id: 'note_bad', clientId: 'cl', at: '', summary: 'x' }],
    facts: [{ id: 'fact_bad', subject: 'a', predicate: 'b', object: 'c', recordedAt: '2026-13-40' }],
  })
  assert.deepEqual(result.items, [])
  assert.deepEqual(result.degraded, [
    TIMELINE_DEGRADED.deliveryInvalidCreatedAt,
    TIMELINE_DEGRADED.factInvalidRecordedAt,
    TIMELINE_DEGRADED.noteInvalidAt,
  ].sort())
})

test('timeline filtering: limit/total/truncated, since and kinds', () => {
  const sources = {
    deliveries: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'].map((day, index) => ({
      id: `del_${index}`,
      matterId: 'm1',
      createdAt: `${day}T00:00:00.000Z`,
    })),
    notes: [{ id: 'note_1', clientId: 'cl', at: '2026-11-05T00:00:00.000Z', summary: '决策' }],
  }
  const page = deriveClientTimeline(sources, { limit: 2 })
  assert.deepEqual(page.items.map((item) => item.ref.id), ['note_1', 'del_3'])
  assert.equal(page.total, 5)
  assert.equal(page.truncated, true)
  const all = deriveClientTimeline(sources, { limit: MAX_TIMELINE_LIMIT + 500 })
  assert.equal(all.items.length, 5, 'an oversized limit is clamped, not rejected')
  assert.equal(DEFAULT_TIMELINE_LIMIT, 20)
  const since = deriveClientTimeline(sources, { since: '2026-11-03T00:00:00.000Z' })
  assert.deepEqual(since.items.map((item) => item.ref.id), ['note_1', 'del_3', 'del_2'])
  const kinds = deriveClientTimeline(sources, { kinds: ['note'] })
  assert.deepEqual(kinds.items.map((item) => item.ref.id), ['note_1'])
  assert.equal(kinds.total, 1)
  const none = deriveClientTimeline(sources, { kinds: [] })
  assert.deepEqual(none.items, [])
  assert.equal(none.total, 0)
  assert.throws(() => deriveClientTimeline(sources, { kinds: ['email' as never] }), /unknown timeline kind/)
  assert.throws(() => deriveClientTimeline(sources, { since: 'soon' }), /since must be/)
})

test('filterTimelineItems sorts defensively and keeps the frozen kind order', () => {
  const items: TimelineItem[] = [
    { at: '2026-11-01T00:00:00.000Z', kind: 'fact', title: 'f', ref: { kind: 'fact', id: 'f2' } },
    { at: '2026-11-02T00:00:00.000Z', kind: 'commitment', title: 'c', ref: { kind: 'commitment', id: 'c1' } },
    { at: '2026-11-02T00:00:00.000Z', kind: 'delivery', title: 'd', ref: { kind: 'delivery', id: 'd9' } },
    { at: '2026-11-02T00:00:00.000Z', kind: 'note', title: 'n', ref: { kind: 'note', id: 'n5' } },
  ]
  const page = filterTimelineItems(items)
  assert.deepEqual(page.items.map((item) => item.ref.id), ['d9', 'n5', 'c1', 'f2'])
  assert.deepEqual([...TIMELINE_KIND_ORDER], ['delivery', 'note', 'commitment', 'fact'])
})

test('timeline titles are single-line and capped at 120 characters', () => {
  const long = 'x'.repeat(200)
  assert.equal(timelineTitle('a\n b'), 'a b')
  assert.equal(timelineTitle(long).length, 120)
  assert.equal(timelineTitleFromSummary('第一行\n第二行'), '第一行')
  assert.equal(timelineTitleFromSummary(''), '(note)')
})

test('splitOpenCommitments: mine vs waiting, due-date order with nulls last', () => {
  const { mine, waiting } = splitOpenCommitments([
    { id: 'cm_late', matterId: 'm1', action: '晚', debtor: 'agent', creditor: '王工', status: 'open', dueAt: '2026-12-01T00:00:00.000Z' },
    { id: 'cm_none', matterId: 'm1', action: '无截止', debtor: 'user', creditor: '王工', status: 'open' },
    { id: 'cm_early', matterId: 'm1', action: '早', debtor: 'user', creditor: '王工', status: 'open', dueAt: '2026-11-21T00:00:00.000Z' },
    { id: 'cm_done', matterId: 'm1', action: '已完成', debtor: 'agent', creditor: '王工', status: 'done', dueAt: '2026-11-01T00:00:00.000Z' },
    { id: 'cm_wait', matterId: 'm1', action: '等确认', debtor: 'third:王工', creditor: 'user', status: 'open' },
  ], [{ id: 'm1', projectId: 'prj_site', secrecy: 2 }])
  assert.deepEqual(mine.map((row) => row.id), ['cm_early', 'cm_late', 'cm_none'])
  assert.deepEqual(waiting.map((row) => row.id), ['cm_wait'])
  assert.equal(mine[0]!.projectId, 'prj_site')
  assert.equal(mine[0]!.secrecy, 2)
})

test('summarizeClientCounts derives client show counters deterministically', () => {
  const counts = summarizeClientCounts({
    matters: [{ id: 'm1', status: 'active' }, { id: 'm2', status: 'archived' }],
    deliveries: [{ id: 'd1', createdAt: NOW }],
    notes: [{ id: 'n1', clientId: 'cl', at: NOW, summary: 'x' }],
    commitments: [
      { id: 'c1', matterId: 'm1', action: 'a', debtor: 'agent', creditor: '王工', status: 'open', dueAt: '2026-11-19T00:00:00.000Z' },
      { id: 'c2', matterId: 'm1', action: 'b', debtor: 'third:王工', creditor: 'user', status: 'open', dueAt: '2026-12-01T00:00:00.000Z' },
      { id: 'c3', matterId: 'm1', action: 'c', debtor: 'agent', creditor: '王工', status: 'done' },
    ],
  }, { now: NOW })
  assert.deepEqual(counts, {
    matters: 2, mattersArchived: 1, deliveries: 1, notes: 1, commitments: 3,
    openMine: 1, openWaiting: 1, overdue: 1,
  })
  assert.throws(() => summarizeClientCounts({}, { now: 'nope' }), /now must be/)
})
