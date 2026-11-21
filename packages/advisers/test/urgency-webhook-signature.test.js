import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  WEBHOOK_ENV,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SCHEMA,
  WEBHOOK_SECRET_ENV,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  buildWebhookHeaders,
  createWebhookReplayGuard,
  isWebhookSigningConfigured,
  parseWebhookSecret,
  sendWebhookNotification,
  signWebhook,
  summarizeReminders,
  verifyWebhookSignature,
} from '../lib/notify.js'

// The canonical Standard Webhooks v1 test vector (spec README signature example).
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
const SECRET_RAW = 'local-shared-secret'
const REFERENCE_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek'
const REFERENCE_TIMESTAMP = 1614265330
const REFERENCE_BODY = '{"test": 2432232314}'
const REFERENCE_SIGNATURE = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='

const REMINDERS = [
  { commitmentId: 'cm_a', action: '私密行动 A', dueAt: '2026-11-20T18:00:00+08:00', bucket: 'due-1d', level: 'L1', ruleId: 'due-1d' },
  { commitmentId: 'cm_b', action: '私密行动 B', dueAt: '2026-11-21T09:00:00+08:00', bucket: 'due-today', level: 'L2', ruleId: 'due-today-09' },
]

function restoreEnv(key, previous) {
  if (previous === undefined) delete process.env[key]
  else process.env[key] = previous
}

async function startServer(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: 'http://127.0.0.1:' + port + '/hook',
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function captureServer(collected) {
  return startServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      collected.push({ method: request.method, url: request.url, headers: request.headers, body })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
  })
}

test('Standard Webhooks reference vector signs byte-for-byte', () => {
  assert.equal(WEBHOOK_SIGNATURE_VERSION, 'v1')
  assert.equal(WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS, 300)
  assert.equal(WEBHOOK_ID_HEADER, 'webhook-id')
  assert.equal(WEBHOOK_TIMESTAMP_HEADER, 'webhook-timestamp')
  assert.equal(WEBHOOK_SIGNATURE_HEADER, 'webhook-signature')
  assert.equal(
    signWebhook(SECRET, { id: REFERENCE_ID, timestamp: REFERENCE_TIMESTAMP, body: REFERENCE_BODY }),
    REFERENCE_SIGNATURE,
  )
  assert.deepEqual(
    buildWebhookHeaders({ secret: SECRET, id: REFERENCE_ID, timestamp: REFERENCE_TIMESTAMP, body: REFERENCE_BODY }),
    {
      [WEBHOOK_ID_HEADER]: REFERENCE_ID,
      [WEBHOOK_TIMESTAMP_HEADER]: String(REFERENCE_TIMESTAMP),
      [WEBHOOK_SIGNATURE_HEADER]: REFERENCE_SIGNATURE,
    },
  )
  // The decoded whsec_ key is the base64 payload, not the prefix text.
  assert.equal(parseWebhookSecret(SECRET).toString('base64'), 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw')
})

test('parseWebhookSecret decodes whsec_ base64, accepts raw strings and rejects garbage', () => {
  const key = parseWebhookSecret(SECRET)
  assert.ok(Buffer.isBuffer(key))
  assert.equal(key.length, 24)
  assert.deepEqual(parseWebhookSecret(SECRET_RAW), Buffer.from(SECRET_RAW, 'utf8'))
  for (const invalid of ['', '   ', null, undefined, 42, 'whsec_', 'whsec_***', 'whsec_A']) {
    assert.equal(parseWebhookSecret(invalid), null, 'rejects ' + String(invalid))
  }
  assert.equal(isWebhookSigningConfigured({ [WEBHOOK_SECRET_ENV]: SECRET }), true)
  assert.equal(isWebhookSigningConfigured({ [WEBHOOK_SECRET_ENV]: '   ' }), false)
  assert.equal(isWebhookSigningConfigured({}), false)
})

test('signWebhook is deterministic and covers id, timestamp and exact body bytes', () => {
  const base = () => signWebhook(SECRET, { id: 'id-1', timestamp: 1700000000, body: '{"count":1}' })
  assert.equal(base(), base())
  assert.notEqual(base(), signWebhook(SECRET, { id: 'id-2', timestamp: 1700000000, body: '{"count":1}' }))
  assert.notEqual(base(), signWebhook(SECRET, { id: 'id-1', timestamp: 1700000001, body: '{"count":1}' }))
  assert.notEqual(base(), signWebhook(SECRET, { id: 'id-1', timestamp: 1700000000, body: '{"count": 1}' }))
  assert.notEqual(base(), signWebhook(SECRET_RAW, { id: 'id-1', timestamp: 1700000000, body: '{"count":1}' }))
  assert.equal(
    signWebhook(SECRET, { id: 'id-1', timestamp: 1700000000, body: Buffer.from('{"count":1}') }),
    base(),
    'string and Buffer bodies sign the same bytes',
  )
  assert.throws(() => signWebhook('', { id: 'id', timestamp: 1, body: 'x' }), TypeError)
  assert.throws(() => signWebhook('whsec_***', { id: 'id', timestamp: 1, body: 'x' }), TypeError)
  assert.throws(() => signWebhook(SECRET, { id: 'bad\nid', timestamp: 1, body: 'x' }), TypeError)
  assert.throws(() => signWebhook(SECRET, { id: 'id', timestamp: 1.5, body: 'x' }), TypeError)
})

test('verifyWebhookSignature accepts valid deliveries and rejects tampering, windows and headers', () => {
  const nowMs = REFERENCE_TIMESTAMP * 1000
  const headers = buildWebhookHeaders({ secret: SECRET, id: REFERENCE_ID, timestamp: REFERENCE_TIMESTAMP, body: REFERENCE_BODY })
  assert.deepEqual(
    verifyWebhookSignature({ secret: SECRET, headers, body: REFERENCE_BODY, now: nowMs }),
    { valid: true, id: REFERENCE_ID, timestamp: REFERENCE_TIMESTAMP, version: 'v1' },
  )
  assert.deepEqual(
    verifyWebhookSignature({ secret: SECRET, headers, body: REFERENCE_BODY + ' ', now: nowMs }),
    { valid: false, reason: 'invalid-signature' },
  )
  assert.equal(verifyWebhookSignature({ secret: SECRET_RAW, headers, body: REFERENCE_BODY, now: nowMs }).reason, 'invalid-signature')
  assert.equal(verifyWebhookSignature({ secret: SECRET, headers, body: REFERENCE_BODY, now: (REFERENCE_TIMESTAMP + 301) * 1000 }).reason, 'timestamp-out-of-window')
  assert.equal(verifyWebhookSignature({ secret: SECRET, headers, body: REFERENCE_BODY, now: (REFERENCE_TIMESTAMP - 301) * 1000 }).reason, 'timestamp-out-of-window')
  assert.equal(verifyWebhookSignature({ secret: SECRET, headers, body: REFERENCE_BODY, now: (REFERENCE_TIMESTAMP + 300) * 1000 }).valid, true, 'the 5 minute window boundary is inclusive')
  const missing = verifyWebhookSignature({ secret: SECRET, headers: {}, body: REFERENCE_BODY, now: nowMs })
  assert.equal(missing.valid, false)
  assert.equal(missing.reason, 'missing-header')
  assert.deepEqual(missing.missing.sort(), [WEBHOOK_ID_HEADER, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER].sort())
  assert.equal(verifyWebhookSignature({ secret: SECRET, headers: { ...headers, [WEBHOOK_TIMESTAMP_HEADER]: 'not-a-number' }, body: REFERENCE_BODY, now: nowMs }).reason, 'invalid-timestamp')
  assert.equal(verifyWebhookSignature({ secret: 'whsec_***', headers, body: REFERENCE_BODY, now: nowMs }).reason, 'invalid-secret')
  // Header lookup is case-insensitive and multiple space-separated signatures are tried.
  const mixedCase = {
    'Webhook-ID': REFERENCE_ID,
    'WEBHOOK-TIMESTAMP': String(REFERENCE_TIMESTAMP),
    'Webhook-Signature': 'v1,bad ' + REFERENCE_SIGNATURE,
  }
  assert.equal(verifyWebhookSignature({ secret: SECRET, headers: mixedCase, body: REFERENCE_BODY, now: nowMs }).valid, true)
  // A Web Headers-style object (duck-typed get()) works too.
  const bag = new Map([
    [WEBHOOK_ID_HEADER, REFERENCE_ID],
    [WEBHOOK_TIMESTAMP_HEADER, String(REFERENCE_TIMESTAMP)],
    [WEBHOOK_SIGNATURE_HEADER, REFERENCE_SIGNATURE],
  ])
  const headerBag = { get: (name) => bag.get(String(name).toLowerCase()) }
  assert.equal(verifyWebhookSignature({ secret: SECRET, headers: headerBag, body: REFERENCE_BODY, now: nowMs }).valid, true)
})

test('replay guard rejects a repeated webhook-id and evicts ids outside the window', () => {
  const guard = createWebhookReplayGuard({ toleranceSeconds: 300, maxEntries: 3 })
  const nowSeconds = 1700000000
  const at = (id, timestamp) => guard.check({ id, timestamp, now: timestamp * 1000 })
  const outOfWindow = guard.check({ id: 'id-3', timestamp: nowSeconds - 400, now: nowSeconds * 1000 })
  assert.deepEqual(at('id-1', nowSeconds), { accepted: true })
  assert.deepEqual(at('id-1', nowSeconds), { accepted: false, reason: 'replay' })
  assert.deepEqual(at('id-2', nowSeconds), { accepted: true })
  assert.deepEqual(at('id-1', nowSeconds + 200), { accepted: false, reason: 'replay' }, 'still inside the window')
  assert.deepEqual(at('id-1', nowSeconds + 301), { accepted: true }, 'evicted once the original timestamp left the window')
  assert.deepEqual(at('id-1', nowSeconds + 301), { accepted: false, reason: 'replay' })
  assert.deepEqual(outOfWindow, { accepted: false, reason: 'timestamp-out-of-window' })
  assert.throws(() => createWebhookReplayGuard({ toleranceSeconds: -1 }), RangeError)
  assert.throws(() => createWebhookReplayGuard({ maxEntries: 0 }), RangeError)

  const composed = createWebhookReplayGuard({ toleranceSeconds: 300 })
  const headers = buildWebhookHeaders({ secret: SECRET, id: REFERENCE_ID, timestamp: REFERENCE_TIMESTAMP, body: REFERENCE_BODY })
  const nowMs = REFERENCE_TIMESTAMP * 1000
  assert.equal(composed.verify({ secret: SECRET, headers, body: REFERENCE_BODY, now: nowMs }).valid, true)
  assert.deepEqual(composed.verify({ secret: SECRET, headers, body: REFERENCE_BODY, now: nowMs }), { valid: false, reason: 'replay' })
  assert.equal(composed.size(), 1)
})

test('sendWebhookNotification with an explicit secret adds only headers and keeps the payload byte-identical', async () => {
  const collected = []
  const server = await captureServer(collected)
  try {
    const nowMs = REFERENCE_TIMESTAMP * 1000
    const result = await sendWebhookNotification(REMINDERS, { url: server.url, secret: SECRET, now: nowMs, id: REFERENCE_ID })
    assert.equal(result.sent, true)
    assert.equal(result.signing, 'standard-webhooks')
    assert.equal(result.warning, undefined)
    assert.equal(result.webhookId, REFERENCE_ID)
    assert.equal(result.webhookTimestamp, REFERENCE_TIMESTAMP)
    assert.equal(collected.length, 1)
    const captured = collected[0]
    assert.equal(captured.method, 'POST')
    assert.equal(captured.body, JSON.stringify(summarizeReminders(REMINDERS)), 'the body bytes are unchanged from 0.3.2')
    assert.deepEqual(JSON.parse(captured.body), summarizeReminders(REMINDERS))
    assert.deepEqual(Object.keys(JSON.parse(captured.body)).sort(), ['count', 'dates', 'levels', 'schema'])
    assert.equal(JSON.parse(captured.body).schema, WEBHOOK_SCHEMA)
    for (const forbidden of ['私密', 'cm_a', 'action', 'creditor', 'quote']) {
      assert.ok(!captured.body.includes(forbidden), 'payload must not contain ' + forbidden)
    }
    assert.equal(captured.headers[WEBHOOK_ID_HEADER], REFERENCE_ID)
    assert.equal(captured.headers[WEBHOOK_TIMESTAMP_HEADER], String(REFERENCE_TIMESTAMP))
    assert.equal(captured.headers[WEBHOOK_SIGNATURE_HEADER], signWebhook(SECRET, { id: REFERENCE_ID, timestamp: REFERENCE_TIMESTAMP, body: captured.body }))
    assert.equal(
      verifyWebhookSignature({ secret: SECRET, headers: captured.headers, body: captured.body, now: nowMs }).valid,
      true,
      'the receiver-side verifier accepts the delivery',
    )
  } finally {
    await server.close()
  }
})

test('the env secret signs by default and the payload stays counts-only', async () => {
  const collected = []
  const server = await captureServer(collected)
  const previous = process.env[WEBHOOK_SECRET_ENV]
  process.env[WEBHOOK_SECRET_ENV] = SECRET
  try {
    const result = await sendWebhookNotification(REMINDERS, { url: server.url, now: REFERENCE_TIMESTAMP * 1000, id: REFERENCE_ID })
    assert.equal(result.sent, true)
    assert.equal(result.signing, 'standard-webhooks')
    assert.equal(
      collected[0].headers[WEBHOOK_SIGNATURE_HEADER],
      signWebhook(SECRET, { id: REFERENCE_ID, timestamp: REFERENCE_TIMESTAMP, body: collected[0].body }),
    )
    assert.equal(collected[0].body, JSON.stringify(summarizeReminders(REMINDERS)))
    assert.ok(!collected[0].body.includes('私密'))
  } finally {
    restoreEnv(WEBHOOK_SECRET_ENV, previous)
    await server.close()
  }
})

test('a configured webhook without a secret still delivers unsigned and says so', async () => {
  const collected = []
  const server = await captureServer(collected)
  const previous = process.env[WEBHOOK_SECRET_ENV]
  delete process.env[WEBHOOK_SECRET_ENV]
  try {
    const result = await sendWebhookNotification(REMINDERS, { url: server.url })
    assert.equal(result.sent, true)
    assert.equal(result.signing, 'none')
    assert.equal(result.warning, 'missing-secret')
    assert.equal(collected.length, 1)
    assert.equal(collected[0].headers[WEBHOOK_SIGNATURE_HEADER], undefined)
    assert.equal(collected[0].headers[WEBHOOK_ID_HEADER], undefined)
    assert.equal(collected[0].body, JSON.stringify(summarizeReminders(REMINDERS)), 'the payload is unchanged in unsigned mode')
  } finally {
    restoreEnv(WEBHOOK_SECRET_ENV, previous)
    await server.close()
  }
})

test('an invalid secret refuses to send instead of silently downgrading to unsigned', async () => {
  let fetched = 0
  const result = await sendWebhookNotification(REMINDERS, {
    url: 'https://example.invalid/hook',
    secret: 'whsec_***',
    fetch: () => { fetched += 1; throw new Error('must not fetch') },
  })
  assert.deepEqual(result, { sent: false, channel: 'webhook', configured: true, error: 'invalid-secret' })
  assert.equal(fetched, 0)
})

test('invalid signing options are structured failures and never send', async () => {
  let fetched = 0
  const fetchSpy = () => { fetched += 1; throw new Error('must not fetch') }
  const badId = await sendWebhookNotification(REMINDERS, { url: 'https://example.invalid/hook', secret: SECRET, id: 'bad\nid', fetch: fetchSpy })
  assert.equal(badId.sent, false)
  assert.equal(badId.error, 'invalid-options')
  const badNow = await sendWebhookNotification(REMINDERS, { url: 'https://example.invalid/hook', secret: SECRET, now: 'not-a-date', fetch: fetchSpy })
  assert.equal(badNow.sent, false)
  assert.equal(badNow.error, 'invalid-options')
  assert.equal(fetched, 0)
})
