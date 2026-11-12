import assert from 'node:assert/strict'
import test from 'node:test'
import { GatedLink, PermitGate } from '../src/index.ts'

function fake() {
  let calls = 0
  return {
    link: {
      id: 'fake', capabilities: { threads: false, cards: false, media: false, approvals: false },
      async start() {}, async stop() {}, async send() { calls++; return { ok: true, messageId: 'm' } },
    },
    calls: () => calls,
  }
}

test('GatedLink requires a bound one-shot permit', async () => {
  const gate = new PermitGate('secret')
  const f = fake()
  const link = new GatedLink(f.link, gate, 'acct')
  const draft = { text: 'hello' }
  const req = { linkId: 'fake', accountId: 'acct', conversationId: 'c', purpose: 'reply' as const, draft }
  assert.equal((await link.send({ conversationId: 'c', text: 'hello' })).denied, true)
  const permit = gate.issue(req)
  assert.equal((await link.send({ conversationId: 'c', text: 'hello', permit })).ok, true)
  assert.equal((await link.send({ conversationId: 'c', text: 'hello', permit })).denied, true)
  const permit2 = gate.issue(req)
  assert.equal((await link.send({ conversationId: 'c', text: 'edited', permit: permit2 })).denied, true)
  assert.equal(f.calls(), 1)
})
