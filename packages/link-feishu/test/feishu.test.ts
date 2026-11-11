import assert from 'node:assert/strict'
import test from 'node:test'
import { FeishuLink, normalizeEvent, normalizeMergedEvent, verifyChallenge } from '../src/index.ts'
import { FeishuApiTransport } from '../src/api.ts'

const payload = {
  header: { event_id: 'evt-1', event_type: 'im.message.receive_v1', token: 'tok', create_time: '1' },
  event: {
    sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
    message: {
      message_id: 'om_1', root_id: 'om_root', chat_id: 'oc_1', chat_type: 'group',
      message_type: 'text', content: JSON.stringify({ text: '周五前给报价' }),
      mentions: [{ id: { open_id: 'ou_bot' } }],
    },
  },
}

test('normalizes a Feishu message event', () => {
  const m = normalizeEvent(payload, { verificationToken: 'tok', botOpenId: 'ou_bot' })
  assert.equal(m?.openId, 'ou_1')
  assert.equal(m?.chatId, 'oc_1')
  assert.equal(m?.text, '周五前给报价')
  assert.equal(m?.mentionedBot, true)
  assert.equal(m?.threadId, 'om_root')
})

test('ignores wrong token and bot sender', () => {
  assert.equal(normalizeEvent(payload, { verificationToken: 'wrong' }), undefined)
  assert.equal(normalizeEvent({ ...payload, event: { ...payload.event, sender: { sender_type: 'app' } } }), undefined)
})

test('FeishuLink ingests addressed group messages and reports send failures', async () => {
  const received: any[] = []
  const link = new FeishuLink({ async send() { return { messageId: 'om_out' } } }, { verificationToken: 'tok', botOpenId: 'ou_bot' })
  await link.start({ async ingest(event) { received.push(event); return { accepted: true } }, async resolvePrincipal() { return 'p' } })
  await link.receive(payload)
  assert.equal(received.length, 1)
  assert.equal(received[0].addressed, true)
  assert.equal(received[0].conversationId, 'oc_1')
  assert.equal((await link.send({ conversationId: 'oc_1', text: 'hi' })).ok, true)
})

test('FeishuApiTransport caches tenant token and sends text', async () => {
  let tokenCalls = 0
  const calls: any[] = []
  const fakeFetch = async (url: string, init: any) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined })
    if (url.includes('tenant_access_token')) {
      tokenCalls++
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_x' } }), { status: 200 })
  }
  const api = new FeishuApiTransport({ appId: 'a', appSecret: 's', fetchImpl: fakeFetch as any })
  assert.equal((await api.send({ chatId: 'oc_1', text: 'hi' })).messageId, 'om_x')
  assert.equal((await api.send({ chatId: 'oc_1', text: 'again' })).messageId, 'om_x')
  assert.equal(tokenCalls, 1)
  assert.match(calls[1].url, /im\/v1\/messages/)
  assert.equal(calls[1].body.receive_id, 'oc_1')
})

test('verifies URL challenge and dedupes by message_id', async () => {
  assert.equal(verifyChallenge({ type: 'url_verification', token: 'tok', challenge: 'c1' }, 'tok'), 'c1')
  assert.equal(verifyChallenge({ type: 'url_verification', token: 'bad', challenge: 'c1' }, 'tok'), undefined)
  const events: any[] = []
  const link = new FeishuLink({ async send() { return { messageId: 'x' } } }, { verificationToken: 'tok', botOpenId: 'ou_bot' })
  await link.start({ async ingest(e) { events.push(e); return { accepted: true } }, async resolvePrincipal() { return 'p' } })
  await link.receive(payload)
  await link.receive({ ...payload, header: { ...payload.header, event_id: 'evt-2' } })
  assert.equal(events[0].dedupeKey, 'om_1')
  assert.equal(events[1].dedupeKey, 'om_1')
})


test('merged long-connection event maps like a webhook event', () => {
  const merged = { event_id: 'evt-2', token: 'tok', sender: payload.event.sender, message: payload.event.message }
  const m = normalizeMergedEvent(merged, { botOpenId: 'ou_bot' })
  assert.equal(m?.messageId, 'om_1')
  assert.equal(m?.text, '周五前给报价')
  assert.equal(m?.mentionedBot, true)
})

test('FeishuLink starts and stops an injected source', async () => {
  let started = 0, stopped = 0
  const source = { async start() { started++ }, async stop() { stopped++ } }
  const link = new FeishuLink({ async send() { return { messageId: 'x' } } }, { source })
  await link.start({ async ingest() { return { accepted: true } }, async resolvePrincipal() { return 'p' } })
  await link.stop()
  assert.equal(started, 1)
  assert.equal(stopped, 1)
})
