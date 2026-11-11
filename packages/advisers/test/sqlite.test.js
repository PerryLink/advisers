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
