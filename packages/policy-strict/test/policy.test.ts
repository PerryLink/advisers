import assert from 'node:assert/strict'
import test from 'node:test'
import { StrictPolicyPack } from '../src/index.ts'

test('strict pack allows understanding and denies companion', () => {
  const pack = new StrictPolicyPack()
  assert.equal(pack.resolve({ use: 'understanding' }).allowed, true)
  assert.equal(pack.resolve({ use: 'companion', age: 25, consent: true }).allowed, false)
  assert.equal(pack.resolve({ use: 'companion', age: 16, consent: true }).code, 'MINOR')
  const crisis = pack.assessCrisis('我不想活了')
  assert.equal(crisis.crisis, true)
  assert.equal(pack.resolve({ use: 'understanding', crisis: true }).action, 'crisis')
})
