import assert from 'node:assert/strict'
import test from 'node:test'
import { INTENT_PROBES, Ledger, buildIntentBrief, runIntentProbes } from '../src/index.ts'

test('intent probe suite: 30 cases, at least 90% pass', () => {
  const results = runIntentProbes()
  assert.equal(INTENT_PROBES.length, 30)
  assert.equal(results.length, 30)
  const failed = results.filter((r) => !r.ok)
  if (failed.length) console.error('failed probes:', JSON.stringify(failed, null, 2))
  assert.ok(failed.length <= 3, `${failed.length} probes failed`)
})

test('high-risk requests are never silently executed', () => {
  const results = runIntentProbes().filter((r) => r.actual.risk === 'high')
  assert.ok(results.length >= 5)
  assert.ok(results.every((r) => r.actual.action !== 'execute'))
})

test('recall questions execute instead of asking for a deadline', () => {
  const brief = buildIntentBrief('客户 A 的报价底线是多少？')
  assert.equal(brief.action, 'execute')
  assert.equal(brief.deliverable, 'answer')
  assert.equal(brief.questions.length, 0)
})

test('conversation said facts do not supersede each other', () => {
  const ledger = new Ledger()
  const matter = ledger.addMatter({ title: 'm' })
  ledger.remember({ matterId: matter.id, subject: 'user', predicate: 'said', object: '客户 B 的预算是 80 万。' })
  ledger.remember({ matterId: matter.id, subject: 'user', predicate: 'said', object: '客户 C 的负责人是李总。' })
  assert.equal(ledger.listFacts(matter.id).length, 2)
  assert.equal(ledger.searchFacts('客户 B 的预算是多少？', { matterId: matter.id })[0]?.object, '客户 B 的预算是 80 万。')
})
