import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'

test('sqlite store round-trips ledger snapshot across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-sqlite-'))
  const db = join(dir, 'state.db')
  try {
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: '客户 A', summary: '报价' })
    ledger.remember({ subject: 'user', predicate: 'prefers', object: '先结论', matterId: matter.id })
    ledger.addPreference({ kind: 'preference', statement: '邮件先结论' })
    ledger.addCommitment({
      matterId: matter.id,
      debtor: 'agent',
      creditor: 'user',
      action: '发报价',
      evidence: [{ sessionId: 's', turnId: 't', quote: '周五前发' }],
    })
    ledger.addRoutine({
      name: '周报', description: '周五给老板', trigger: ['周五'], steps: ['汇总'],
      preferences: [], pitfalls: [], verification: [], createdBy: 'user',
    })
    const routine = ledger.addRoutine({
      name: '周报2', description: 'v1', trigger: ['周五'], steps: ['汇总'],
      preferences: [], pitfalls: [], verification: [], createdBy: 'user',
    })
    ledger.proposeRoutinePatch(routine.id, { description: 'v2' })
    ledger.setRoute('cli:cli', matter.id)

    const store = new SqliteStore(db)
    store.save(ledger.toJSON())
    store.close()

    const reopened = new SqliteStore(db)
    const restored = Ledger.fromJSON(reopened.load())
    assert.equal(restored.listMatters().length, 1)
    assert.equal(restored.listPreferences().length, 1)
    assert.equal(restored.openCommitments(matter.id).length, 1)
    assert.equal(restored.listRoutines().length, 2)
    assert.equal(restored.listRoutinePatches().length, 1)
    assert.equal(restored.getRoute('cli:cli'), matter.id)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('seen store persists dedupe keys across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-seen-'))
  const db = join(dir, 'state.db')
  try {
    const a = new SqliteStore(db)
    assert.equal(a.seenStore().has('email:me:m1'), false)
    a.seenStore().add('email:me:m1')
    a.close()
    const b = new SqliteStore(db)
    assert.equal(b.seenStore().has('email:me:m1'), true)
    b.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessions and deliveries persist for local history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-history-'))
  const db = join(dir, 'state.db')
  try {
    const store = new SqliteStore(db)
    store.upsertSession({ conversationId: 'local', matterId: 'm1', title: 'Q4 周报' })
    const id = store.addDelivery({ matterId: 'm1', conversationId: 'local', files: ['out/weekly.docx'], tool: 'office_build', title: 'Q4 周报' })
    assert.match(id, /^del_/)
    store.close()
    const reopened = new SqliteStore(db)
    assert.equal(reopened.listSessions()[0].conversationId, 'local')
    assert.deepEqual(reopened.listDeliveries()[0].files, ['out/weekly.docx'])
    assert.equal(reopened.listDeliveries()[0].title, 'Q4 周报')
    assert.equal(reopened.countDeliveries(), 1)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit log hash chain detects tampering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-audit-'))
  const db = join(dir, 'state.db')
  try {
    const store = new SqliteStore(db)
    store.appendAudit({ actor: 'local', action: 'correct', allowed: true, reason: 'user correction' })
    store.appendAudit({ actor: 'local', action: 'link.apply', allowed: true, reason: 'one-side write' })
    assert.deepEqual(store.verifyAudit(), { ok: true, count: 2 })
    store.db.prepare("UPDATE audit SET reason = 'tampered' WHERE seq = 1").run()
    assert.equal(store.verifyAudit().ok, false)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('turns and session summaries persist across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-turns-'))
  const db = join(dir, 'state.db')
  try {
    const store = new SqliteStore(db)
    store.addTurn({ conversationId: 'c1', role: 'user', content: '先列结论' })
    store.addTurn({ conversationId: 'c1', role: 'assistant', content: '好' })
    store.upsertSessionSummary({ conversationId: 'c1', summary: '已完成第一版', throughSeq: 2 })
    store.close()
    const again = new SqliteStore(db)
    assert.equal(again.listTurns('c1').length, 2)
    assert.equal(again.listTurns('c1')[0].content, '先列结论')
    assert.equal(again.getSessionSummary('c1').summary, '已完成第一版')
    again.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('turn search handles Chinese short queries and purge removes FTS rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-fts-'))
  const db = join(dir, 'state.db')
  try {
    const store = new SqliteStore(db)
    store.addTurn({ conversationId: 'c1', role: 'user', content: '预算总额是420' })
    store.addTurn({ conversationId: 'c1', role: 'assistant', content: '收到' })
    assert.equal(store.searchTurns('预算', { conversationId: 'c1' }).length, 1)
    assert.equal(store.searchTurns('总额是', { conversationId: 'c1' }).length, 1)
    store.purgeMatterData('missing')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fact temporal/authority fields survive SQLite round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-facts-'))
  const db = join(dir, 'state.db')
  try {
    const store = new SqliteStore(db)
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: 'm' })
    const first = ledger.remember({ matterId: matter.id, subject: 'u', predicate: 'city', object: '上海' })
    const second = ledger.remember({ matterId: matter.id, subject: 'u', predicate: 'city', object: '北京', evidence: [{ quote: '改到北京' }] })
    store.save(ledger.toJSON())
    store.close()
    const again = new SqliteStore(db)
    const loaded = Ledger.fromJSON(again.load())
    const facts = loaded.listFacts(matter.id, true)
    assert.equal(facts.length, 2)
    const current = loaded.listFacts(matter.id)
    assert.equal(current.length, 1)
    assert.equal(current[0].object, '北京')
    assert.equal(current[0].evidence?.[0]?.quote, '改到北京')
    assert.equal(loaded.factHistory(current[0].id).length, 2)
    again.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('nudge ledger dedupes per day/level and counts budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-nudge-'))
  const db = join(dir, 'state.db')
  try {
    const store = new SqliteStore(db)
    assert.ok(store.addNudge({ localDay: '2026-11-11', level: 'L2', commitmentId: 'cm1', body: '发报价' }))
    assert.equal(store.addNudge({ localDay: '2026-11-11', level: 'L2', commitmentId: 'cm1', body: '发报价' }), null)
    assert.equal(store.countNudges('2026-11-11', 'L2'), 1)
    const n = store.listNudges(1)[0]
    assert.equal(store.setNudgeOutcome(n.id, 'ignored'), true)
    assert.equal(store.listNudges(1)[0].outcome, 'ignored')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task runs persist trajectories for review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-runs-'))
  const db = join(dir, 'state.db')
  try {
    const store = new SqliteStore(db)
    const id = store.addTaskRun({ conversationId: 'c', task: '周报', tools: [{ name: 'office_template', ok: true }], artifacts: ['out/a.docx'], outcome: 'ok' })
    const row = store.listTaskRuns(1)[0]
    assert.equal(row.id, id)
    assert.equal(row.artifacts[0], 'out/a.docx')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('purge removes turns, summaries, nudges and task runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-purge2-'))
  const db = join(dir, 'state.db')
  try {
    const store = new SqliteStore(db)
    store.upsertSession({ conversationId: 'c1', matterId: 'm1', title: 't' })
    store.addTurn({ conversationId: 'c1', role: 'user', content: 'secret' })
    store.upsertSessionSummary({ conversationId: 'c1', summary: 'secret summary', throughSeq: 1 })
    store.addTaskRun({ conversationId: 'c1', task: 'secret task', tools: [], artifacts: [], outcome: 'ok' })
    store.addNudge({ localDay: '2026-11-12', level: 'L2', commitmentId: 'cm1', body: 'secret nudge' })
    const counts = store.purgeMatterData('m1')
    assert.equal(counts.sessions, 1)
    assert.equal(counts.turns, 1)
    assert.equal(counts.summaries, 1)
    assert.equal(counts.runs, 1)
    assert.equal(counts.nudges, 0)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('keyed audit chain rejects tampering and wrong key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-hmac-'))
  const db = join(dir, 'state.db')
  const old = process.env.ADVISERS_AUDIT_KEY
  try {
    process.env.ADVISERS_AUDIT_KEY = 'test-key'
    const store = new SqliteStore(db)
    store.appendAudit({ actor: 'local', action: 'send', allowed: false, reason: 'denied' })
    assert.equal(store.verifyAudit().ok, true)
    store.db.prepare("UPDATE audit SET reason = 'forged' WHERE seq = 1").run()
    assert.equal(store.verifyAudit().ok, false)
    store.close()
  } finally {
    if (old === undefined) delete process.env.ADVISERS_AUDIT_KEY
    else process.env.ADVISERS_AUDIT_KEY = old
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory search finds matter-scoped facts with and without a matter filter', async () => {
  const { Ledger } = await import('../../core/dist/index.js')
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '客户' })
  ledger.remember({ subject: 'client', predicate: 'budget', object: '上海客户预算 300 万', matterId: matter.id })
  const dir = mkdtempSync(join(tmpdir(), 'advisers-mem-'))
  const store = new SqliteStore(join(dir, 'state.db'))
  store.save(ledger.toJSON())
  assert.equal(store.searchMemory('上海', { matterId: matter.id }).length, 1)
  assert.equal(store.searchMemory('上海').length, 1)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('turn search can be confined to a matter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-turn-'))
  try {
    const store = new SqliteStore(join(dir, 'state.db'))
    store.upsertSession({ conversationId: 'c1', matterId: 'm1', title: 'a' })
    store.upsertSession({ conversationId: 'c2', matterId: 'm2', title: 'b' })
    store.addTurn({ conversationId: 'c1', role: 'user', content: 'secret A' })
    store.addTurn({ conversationId: 'c2', role: 'user', content: 'secret B' })
    const rows = store.searchTurns('secret', { matterId: 'm1' })
    assert.equal(rows.length, 1)
    assert.match(rows[0].content, /A/)
    store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('purge removes candidate payloads for the matter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-purge-cand-'))
  try {
    const store = new SqliteStore(join(dir, 'state.db'))
    store.proposeCandidate({ kind: 'fact', payload: { subject: 'user', predicate: 'secret', object: 'SECRET', matterId: 'm1' }, evidence: [{ quote: 'SECRET' }] })
    assert.equal(store.purgeMatterData('m1').candidates, 1)
    assert.equal(store.listCandidates('all').length, 0)
    store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('permit replay store is atomic and survives reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-permit-'))
  try {
    const path = join(dir, 'state.db')
    const a = new SqliteStore(path)
    const replay = a.permitReplayStore()
    assert.equal(replay.claim('p1', Date.now() + 60_000), true)
    assert.equal(replay.claim('p1', Date.now() + 60_000), false)
    a.close()
    const b = new SqliteStore(path)
    assert.equal(b.permitReplayStore().has('p1'), true)
    assert.equal(b.permitReplayStore().claim('p1', Date.now() + 60_000), false)
    b.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('purge leaves no planted secret bytes in the database file', async () => {
  const { Ledger } = await import('../../core/dist/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'advisers-purge-bytes-'))
  const path = join(dir, 'state.db')
  try {
    const store = new SqliteStore(path)
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: '客户' })
    ledger.remember({ matterId: matter.id, subject: 'client', predicate: 'secret', object: 'SECRET_PURGE_BYTES' })
    ledger.purgeMatter(matter.id)
    store.save(ledger.toJSON())
    store.purgeMatterData(matter.id)
    store.close()
    const raw = (await import('node:fs')).readFileSync(path)
    assert.equal(raw.includes(Buffer.from('SECRET_PURGE_BYTES')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
