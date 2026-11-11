import assert from 'node:assert/strict'
import test from 'node:test'
import { PermitGate } from '../src/index.ts'

test('permit is conversation-bound, expiring, signed and one-shot', () => {
  let now = 1_000
  const gate = new PermitGate('secret', () => now)
  const req = { conversationId: 'oc_1', accountId: 'feishu', approvalId: 'ap_1' }
  const permit = gate.issue(req, 1000)
  assert.equal(gate.verify(permit, req).ok, true)
  assert.equal(gate.verify(permit, { ...req, conversationId: 'oc_2' }).reason, 'wrong-conversation')
  assert.equal(gate.verify(permit, { ...req, accountId: 'other' }).reason, 'wrong-account')
  assert.equal(gate.consume(permit), true)
  assert.equal(gate.verify(permit, req).reason, 'consumed')
  now = 2_001
  const expired = gate.issue(req, 1)
  now = 2_003
  assert.equal(gate.verify(expired, req).reason, 'expired')
})

test('permit rejects a tampered signature', () => {
  const gate = new PermitGate('secret')
  const permit = gate.issue({ conversationId: 'oc_1' })
  assert.equal(gate.verify({ ...permit, conversationId: 'oc_2' }, { conversationId: 'oc_2' }).reason, 'bad-signature')
})
