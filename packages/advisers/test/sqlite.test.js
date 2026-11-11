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
