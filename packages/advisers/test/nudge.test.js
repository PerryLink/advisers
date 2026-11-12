import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyNudgeOutcome } from '../lib/nudge.js'

test('classifies nudge feedback', () => {
  assert.equal(classifyNudgeOutcome('别烦，晚点再说'), 'ignored')
  assert.equal(classifyNudgeOutcome('已完成，报价发了'), 'accepted')
  assert.equal(classifyNudgeOutcome('今天做周报'), null)
})
