import assert from 'node:assert/strict'
import test from 'node:test'
import { complete } from '../lib/model.js'

test('model posts an OpenAI-compatible request and returns content', async () => {
  let captured
  const fakeFetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ choices: [{ message: { content: '好的' } }] }), { status: 200 })
  }
  const text = await complete({ prompt: 'hello', apiKey: 'k', baseUrl: 'https://example.test/v1/', model: 'm', fetchImpl: fakeFetch })
  assert.equal(text, '好的')
  assert.equal(captured.url, 'https://example.test/v1/chat/completions')
  assert.equal(captured.body.model, 'm')
  assert.equal(captured.body.messages[0].content, 'hello')
  assert.match(captured.init.headers.Authorization, /^Bearer /)
})

test('model surfaces HTTP errors without leaking the key', async () => {
  const fakeFetch = async () => new Response('boom', { status: 500 })
  await assert.rejects(() => complete({ prompt: 'x', apiKey: 'secret', fetchImpl: fakeFetch }), /HTTP 500/)
})

test('model retries 429/5xx and applies timeout/max_tokens', async () => {
  let calls = 0
  const fetchImpl = async (_url, init) => {
    calls++
    const body = JSON.parse(init.body)
    assert.equal(body.max_tokens, 1234)
    if (calls === 1) return new Response('rate limited', { status: 429 })
    if (calls === 2) return new Response('boom', { status: 503 })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } }), { status: 200 })
  }
  const { chatCompletion } = await import('../lib/model.js')
  const result = await chatCompletion({ messages: [{ role: 'user', content: 'hi' }], apiKey: 'k', fetchImpl, maxTokens: 1234, retries: 2 })
  assert.equal(result.content, 'ok')
  assert.equal(calls, 3)
})
