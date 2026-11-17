import assert from 'node:assert/strict'
import test from 'node:test'
import { research, ResearchError } from '../lib/research.js'

// Privacy audit 2026-11-17 P1-2: lib/research.js used to splice the upstream
// response body (first 300 chars) into ResearchError.message. DeepSeek's 401
// body echoes the submitted API key, so a bad/revoked key (or a gateway that
// echoes credentials) ended up in stderr/CI logs/screenshots. The error must now
// carry only stable fields (HTTP status + stable code).

test('research 401 error never echoes the upstream body or the API key', async () => {
  const secret = 'sk-live-APIKEY-SECRET-9f2c1ab7'
  const upstreamBody = JSON.stringify({
    type: 'error',
    error: {
      type: 'authentication_error',
      message: `Authentication Fails, Your api key: ${secret} is invalid (request_id: 6de34a4d)`,
    },
  }) + '\u001b[31m ANSI \u0007'
  const fetchImpl = async () => new Response(upstreamBody, { status: 401, headers: { 'content-type': 'application/json' } })

  await assert.rejects(
    () => research({ query: 'Q4 总结', apiKey: 'k', fetchImpl, retries: 0 }),
    (error) => {
      assert.ok(error instanceof ResearchError, 'a ResearchError is thrown')
      assert.equal(error.status, 401)
      assert.equal(error.code, 'AUTH')
      assert.equal(error.retryable, false)
      assert.ok(!error.message.includes(secret), 'the API key must not appear in the error message')
      assert.ok(!error.message.includes('Authentication Fails'), 'the upstream message must not be copied')
      assert.ok(!/["{}]/.test(error.message), 'no JSON fragment survives in the error message: ' + error.message)
      assert.ok(!/[\u0000-\u001f\u007f]/.test(error.message), 'no control characters in the error message')
      assert.match(error.message, /research HTTP 401/)
      assert.match(error.message, /AUTH/)
      return true
    },
  )
})

test('research retryable upstream errors also keep only the stable code', async () => {
  const secret = 'SECRET-BODY-MUST-NOT-LEAK'
  const fetchImpl = async () => new Response('upstream exploded: ' + secret + '\n\u0000', { status: 502 })

  await assert.rejects(
    () => research({ query: 'Q4', apiKey: 'k', fetchImpl, retries: 0 }),
    (error) => {
      assert.equal(error.status, 502)
      assert.equal(error.code, 'UPSTREAM')
      assert.equal(error.retryable, true)
      assert.ok(!error.message.includes(secret))
      assert.ok(!/upstream exploded/.test(error.message))
      return true
    },
  )
})
