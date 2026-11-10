import assert from 'node:assert/strict'
import test from 'node:test'
import { EmailLink } from '../src/index.ts'
import type { InboundEvent } from '../../core/src/link.ts'

test('email link normalizes a forwarded message into an InboundEvent', async () => {
  const received: InboundEvent[] = []
  const host = {
    async ingest(event: InboundEvent) {
      received.push(event)
    },
    async resolvePrincipal() {
      return 'principal:me'
    },
  }
  const link = new EmailLink({
    async send() {
      return { id: 'sent-1' }
    },
  }, 'me@example.com')
  await link.start(host)
  await link.receive({
    from: 'boss@example.com',
    fromName: 'Boss',
    subject: 'Q4 budget',
    body: 'Please send the revised numbers by Friday.',
    messageId: 'mail-1',
    threadId: 'thread-9',
  })
  assert.equal(received.length, 1)
  assert.equal(received[0]?.linkId, 'email')
  assert.equal(received[0]?.conversationId, 'boss@example.com')
  assert.equal(received[0]?.threadId, 'thread-9')
  assert.match(received[0]?.text ?? '', /Q4 budget/)
})

test('email link reports transport failures as DeliveryResult', async () => {
  const link = new EmailLink({
    async send() {
      throw new Error('smtp down')
    },
  }, 'me@example.com')
  const result = await link.send({ conversationId: 'x@example.com', text: 'hi' })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /smtp down/)
})
