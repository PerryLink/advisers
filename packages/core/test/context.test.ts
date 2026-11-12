import assert from 'node:assert/strict'
import test from 'node:test'
import { Ledger, assembleContext } from '../src/index.ts'

test('context injects active routine index only, never draft routines', () => {
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: '周报' })
  const active = ledger.addRoutine({ name: '周报流程', description: '从数据到 DOCX', trigger: [], steps: ['office_template'], preferences: [], pitfalls: [], verification: [], createdBy: 'user' })
  ledger.approveRoutine(active.id)
  ledger.addRoutine({ name: '草稿流程', description: '未批准', trigger: [], steps: ['x'], preferences: [], pitfalls: [], verification: [], createdBy: 'user' })
  const context = assembleContext({ matter, ledger, routines: ledger.listRoutines() })
  assert.match(context.prompt, /周报流程/)
  assert.doesNotMatch(context.prompt, /草稿流程/)
  assert.match(context.prompt, /routine_view/)
})
