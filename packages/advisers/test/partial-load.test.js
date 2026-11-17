import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'

/**
 * P1-2 (0.2.2): partial ledger loading.
 *
 * The CLI reads only the tables a command needs instead of the whole 9-table
 * snapshot (full load: 488ms at 50k rows in the round-2 performance audit).
 * These tests pin the two invariants that make that safe:
 *  1. every partial loader returns exactly the rows a full load() would return
 *     for the same table/filter (so command output cannot drift), and
 *  2. saving a partially loaded ledger never deletes rows of tables/rows it did
 *     not read (tick wakes a snoozed commitment and saves).
 */

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const CLI_ENV = (home) => tosEnv(home, {
  ...process.env,
  ADVISERS_CORE_LOCAL: '1',
  ADVISERS_OFFICE_LOCAL: '1',
  ADVISERS_NO_MODEL: '1',
  ADVISERS_STORE: 'sqlite',
})

function setup(name) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-partial-' + name + '-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return { root, home, work, db: join(home, 'state.db') }
}

function cli(home, args, cwd) {
  return execFileSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: CLI_ENV(home) })
}

/** A ledger exercising every table + filterable status/kind. */
function seedLedger() {
  const ledger = new Ledger()
  const a = ledger.addMatter({ title: '客户 A', summary: '报价' })
  const b = ledger.addMatter({ title: '客户 B' })
  ledger.remember({ subject: '客户A', predicate: '要求', object: '先给总价', matterId: a.id })
  ledger.remember({ subject: '客户B', predicate: '要求', object: '英文合同', matterId: b.id })
  ledger.addPreference({ kind: 'preference', statement: '邮件先结论' })
  ledger.addPreference({ kind: 'taboo', statement: '不要提健身' })
  const future = new Date(Date.now() + 3 * 86400_000).toISOString()
  const open = ledger.addCommitment({
    matterId: a.id, debtor: 'agent', creditor: 'user', action: '发报价', dueAt: future,
    reminderOffsets: ['-1d', '-2h'], evidence: [{ sessionId: 'conv-1', turnId: 't1', quote: '周五前发' }],
  })
  const done = ledger.addCommitment({
    matterId: a.id, debtor: 'user', creditor: '王工', action: '已完成的交付',
    evidence: [{ sessionId: 'conv-1', turnId: 't2', quote: '已完成' }],
  })
  ledger.completeCommitment(done.id, [{ sessionId: 'conv-1', turnId: 't3', quote: '交付验收' }])
  const snoozed = ledger.addCommitment({
    matterId: b.id, debtor: 'third:王工', creditor: '我', action: '等王工回复', dueAt: future,
    evidence: [{ sessionId: 'conv-1', turnId: 't4', quote: '等回复' }],
  })
  snoozed.status = 'snoozed'
  ledger.proposeLink({ fromMatter: a.id, toMatter: b.id, type: 'related', evidence: ['同一客户'] })
  ledger.proposeUpdate({ sourceMatter: a.id, targetMatter: b.id, change: '共享报价口径' })
  const routine = ledger.addRoutine({
    name: '周报', description: '周五给老板', trigger: ['周五'], steps: ['汇总'],
    preferences: [], pitfalls: [], verification: [], createdBy: 'user',
  })
  ledger.approveRoutine(routine.id)
  ledger.proposeRoutinePatch(routine.id, { description: '周五下午给老板' })
  ledger.setRoute('cli:cli', a.id)
  return { ledger, a, b, open, done, snoozed, routine }
}

/** Persist the seed plus non-ledger rows (turns/sessions/deliveries/model calls). */
function seedStore(db) {
  const seeded = seedLedger()
  const store = new SqliteStore(db)
  store.save(seeded.ledger.toJSON())
  for (let i = 1; i <= 8; i++) store.addTurn({ conversationId: 'conv-1', role: i % 2 ? 'user' : 'assistant', content: '第' + i + '轮对话：报价单与交付' })
  for (let i = 1; i <= 3; i++) store.addTurn({ conversationId: 'conv-2', role: 'user', content: '另一会话 ' + i })
  store.upsertSession({ conversationId: 'conv-1', matterId: seeded.a.id, title: '报价会话' })
  store.upsertSession({ conversationId: 'conv-2', matterId: seeded.b.id, title: '合同会话' })
  store.addDelivery({ matterId: seeded.a.id, conversationId: 'conv-1', files: ['out/quote.docx'], tool: 'office', title: '报价单', validation: 'ok' })
  store.addModelCall({ conversationId: 'conv-1', matterId: seeded.a.id, task: 'chat', model: 'deepseek-chat', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, durationMs: 900 })
  return { store, seeded }
}

test('partial loaders return the same rows as a full load (tables, filters, turns, counts)', () => {
  const { root, db } = setup('parity')
  try {
    const { store, seeded } = seedStore(db)
    try {
      const full = store.load()
      assert.deepEqual(store.loadMatters(), full.matters)
      assert.deepEqual(store.loadFacts(), full.facts)
      assert.deepEqual(store.loadCommitments(), full.commitments)
      assert.deepEqual(store.loadPreferences(), full.preferences)
      assert.deepEqual(store.loadLinks(), full.links)
      assert.deepEqual(store.loadUpdates(), full.updates)
      assert.deepEqual(store.loadRoutines(), full.routines)
      assert.deepEqual(store.loadRoutinePatches(), full.routinePatches)
      assert.deepEqual(store.loadRoutes(), full.routes)
      assert.deepEqual(store.loadSnapshot(), full)

      // Filtered loads keep the full-load order (ORDER BY rowid) and the exact set.
      assert.deepEqual(store.loadCommitments({ status: 'open' }), full.commitments.filter((c) => c.status === 'open'))
      assert.deepEqual(store.loadCommitments({ status: 'open', matterId: seeded.a.id }), full.commitments.filter((c) => c.status === 'open' && c.matterId === seeded.a.id))
      assert.deepEqual(store.loadFacts({ status: 'confirmed' }), full.facts.filter((f) => f.status === 'confirmed'))
      assert.deepEqual(store.loadFacts({ matterId: seeded.b.id }), full.facts.filter((f) => f.matterId === seeded.b.id))
      assert.deepEqual(store.loadPreferences({ kind: 'taboo' }), full.preferences.filter((p) => p.kind === 'taboo'))
      assert.deepEqual(store.loadLinks({ excludeRejected: true }), full.links.filter((l) => l.status !== 'rejected'))
      assert.deepEqual(store.loadRoutines({ status: 'active' }), full.routines.filter((r) => r.status === 'active'))
      assert.deepEqual(store.loadRoutinePatches({ status: 'pending' }), full.routinePatches.filter((p) => p.status === 'pending'))

      // Sampling: first/middle/last rows are byte-identical to the full load.
      const sample = (rows) => [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]].filter(Boolean)
      assert.deepEqual(sample(store.loadCommitments()), sample(full.commitments))
      assert.deepEqual(sample(store.loadFacts()), sample(full.facts))
      assert.deepEqual(sample(store.loadPreferences()), sample(full.preferences))

      // Latest-N turns match listTurns() (the read used by the chat context window).
      assert.deepEqual(store.loadTurns({ conversationId: 'conv-1', limit: 5 }), store.listTurns('conv-1', 5))
      assert.deepEqual(store.loadTurns({ conversationId: 'conv-1' }), store.listTurns('conv-1', 100))
      // Without a conversation id the latest-N window is still seq DESC (conv-1
      // holds the newest turns in this fixture).
      assert.deepEqual(store.loadTurns({ limit: 4 }), store.loadTurns({ conversationId: 'conv-1', limit: 4 }))
      assert.equal(store.loadTurns().length, 11)

      // COUNT helpers agree with the materialised rows and with Ledger filters.
      assert.equal(store.countMatters(), full.matters.length)
      assert.equal(store.countMatters({ status: 'active' }), seeded.ledger.listMatters().length)
      assert.equal(store.countFacts(), full.facts.length)
      assert.equal(store.countFacts({ status: 'confirmed' }), seeded.ledger.listFacts().length)
      assert.equal(store.countCommitments(), full.commitments.length)
      assert.equal(store.countCommitments({ status: 'open' }), seeded.ledger.openCommitments().length)
      assert.equal(store.countPreferences(), full.preferences.length)
      assert.equal(store.countPreferences({ status: 'confirmed' }), seeded.ledger.listPreferences().length)
      assert.equal(store.countRoutines(), full.routines.length)
      assert.equal(store.countLinks({ excludeRejected: true }), seeded.ledger.listLinks().length)
      assert.equal(store.countSessions(), 2)
      assert.equal(store.countTurns({ conversationId: 'conv-1' }), 8)
      assert.deepEqual(store.sumModelUsage(), { calls: 1, prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0, cached_tokens: 0, total_tokens: 150 })

      // A partial snapshot produces the same in-memory view for the tables it holds.
      const partial = Ledger.fromParts({ version: 1, commitments: store.loadCommitments({ status: 'open' }) })
      const restoredFull = Ledger.fromJSON(full)
      assert.deepEqual(partial.openCommitments().map((c) => c.id), restoredFull.openCommitments().map((c) => c.id))
      assert.deepEqual(partial.listCommitments().map((c) => c.action), seeded.ledger.listCommitments().filter((c) => c.status === 'open').map((c) => c.action))
      // reminderOffsets survive the partial path exactly like the full path.
      assert.deepEqual(partial.listCommitments()[0].reminderOffsets, ['-1d', '-2h'])
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('saving a partially loaded ledger keeps the tables and rows it did not read', () => {
  const { root, db } = setup('save')
  try {
    const { store, seeded } = seedStore(db)
    store.close()

    const writer = new SqliteStore(db)
    const open = writer.loadCommitments({ status: 'open' })
    const partial = Ledger.fromParts({ version: 1, commitments: open })
    const target = partial.listCommitments().find((c) => c.id === seeded.open.id)
    target.action = '发报价（更新）'
    writer.save(partial.toJSON())
    writer.close()

    const reopened = new SqliteStore(db)
    try {
      const full = reopened.load()
      assert.equal(full.matters.length, 2, 'matters survive a commitments-only save')
      assert.equal(full.facts.length, 2, 'facts survive a commitments-only save')
      assert.equal(full.preferences.length, 2, 'preferences survive a commitments-only save')
      assert.equal(full.links.length, 1)
      assert.equal(full.updates.length, 1)
      assert.equal(full.routines.length, 1)
      assert.equal(full.routinePatches.length, 1)
      assert.equal(full.routes['cli:cli'], seeded.a.id)
      assert.equal(full.commitments.length, 3, 'the done commitment was not loaded and must not be deleted')
      assert.equal(full.commitments.find((c) => c.id === seeded.done.id).status, 'done')
      assert.equal(full.commitments.find((c) => c.id === seeded.open.id).action, '发报价（更新）')
      assert.ok(full.commitments.find((c) => c.id === seeded.snoozed.id))

      // Mixing a full load with a later partial load must stay conservative: the
      // partial save may only remove rows that a partial loader actually read.
      const mixed = new SqliteStore(db)
      try {
        mixed.load()
        const open2 = mixed.loadCommitments({ status: 'open' })
        mixed.save(Ledger.fromParts({ version: 1, commitments: open2 }).toJSON())
      } finally { mixed.close() }
      const afterMixed = new SqliteStore(db)
      try {
        const fullAfter = afterMixed.load()
        assert.equal(fullAfter.facts.length, 2)
        assert.equal(fullAfter.matters.length, 2)
        assert.equal(fullAfter.commitments.length, 3)
      } finally { afterMixed.close() }
    } finally { reopened.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('tick wakes an expired snooze and persists it without dropping unread tables', () => {
  const { root, home, work, db } = setup('tick')
  try {
    const { store, seeded } = seedStore(db)
    // Make the snoozed commitment wake up on the next tick.
    store.setMeta('snooze:' + seeded.snoozed.id, new Date(Date.now() - 3600_000).toISOString())
    const before = { facts: store.countFacts(), matters: store.countMatters(), prefs: store.countPreferences(), routines: store.countRoutines(), links: store.countLinks() }
    store.close()

    const output = cli(home, ['tick', '--json'], work)
    const result = JSON.parse(output)
    assert.ok(result.due.some((c) => c.id === seeded.open.id), 'the open commitment is due')
    assert.ok(result.due.some((c) => c.id === seeded.snoozed.id), 'the woken snooze is due')

    const reopened = new SqliteStore(db)
    try {
      const full = reopened.load()
      assert.equal(full.facts.length, before.facts, 'tick must not truncate facts')
      assert.equal(full.matters.length, before.matters, 'tick must not truncate matters')
      assert.equal(full.preferences.length, before.prefs, 'tick must not truncate preferences')
      assert.equal(full.routines.length, before.routines, 'tick must not truncate routines')
      assert.equal(full.links.length, before.links, 'tick must not truncate links')
      assert.equal(full.commitments.find((c) => c.id === seeded.snoozed.id).status, 'open', 'the snooze wake-up was persisted')
      assert.equal(reopened.getMeta('snooze:' + seeded.snoozed.id), undefined)
      assert.equal(reopened.listAudit(10).length, 0, 'tick still writes no audit rows')
    } finally { reopened.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
