import assert from 'node:assert/strict'
import test from 'node:test'
import { INTENT_PROBES, runIntentProbes } from '../src/index.ts'

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
