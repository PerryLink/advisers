import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  WEBHOOK_ENV,
  WEBHOOK_SCHEMA,
  isWebhookConfigured,
  sendNotification,
  sendWebhookNotification,
  summarizeReminders,
} from '../lib/notify.js'

const REMINDERS = [
  { commitmentId: 'cm_a', action: '私密行动 A', dueAt: '2026-11-20T18:00:00+08:00', bucket: 'due-1d', level: 'L1', ruleId: 'due-1d' },
  // 2026-11-19T16:30Z is 2026-11-20 00:30 +08:00, so the local date is 11-20.
  { commitmentId: 'cm_b', action: '私密行动 B', dueAt: '2026-11-19T16:30:00Z', bucket: 'due-today', level: 'L2', ruleId: 'due-today-09' },
  { commitmentId: 'cm_c', action: '私密行动 C', dueAt: '2026-11-21T09:00:00+08:00', bucket: 'upcoming', level: 'L3', ruleId: 'upcoming' },
]

async function startServer(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/hook`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function captureServer(collected, respond = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') }) {
  return startServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      collected.push({ method: req.method, url: req.url, headers: req.headers, body })
      respond(res)
    })
  })
}

test('summarizeReminders is counts/levels/dates only, in Asia/Shanghai', () => {
  const summary = summarizeReminders(REMINDERS)
  assert.deepEqual(summary, {
    schema: WEBHOOK_SCHEMA,
    count: 3,
    levels: { L1: 1, L2: 1, L3: 1 },
    dates: ['2026-11-20', '2026-11-21'],
  })
  const serialized = JSON.stringify(summary)
  for (const forbidden of ['私密', 'cm_a', 'action', 'creditor', 'quote', 'secret']) {
    assert.ok(!serialized.includes(forbidden), `payload must not contain ${forbidden}`)
  }

  // Duplicate local dates collapse and the result is sorted.
  const collapsed = summarizeReminders([
    { level: 'L1', dueAt: '2026-11-21T09:00:00+08:00' },
    { level: 'L1', dueAt: '2026-11-20T23:00:00+08:00' },
    { level: 'L1', dueAt: '2026-11-20T03:00:00+08:00' },
  ])
  assert.deepEqual(collapsed.dates, ['2026-11-20', '2026-11-21'])
  assert.throws(() => summarizeReminders('not-an-array'), TypeError)
})

test('webhook is off by default and reports structured not-configured', async () => {
  const previous = process.env[WEBHOOK_ENV]
  delete process.env[WEBHOOK_ENV]
  try {
    assert.equal(isWebhookConfigured(), false)
    const result = await sendWebhookNotification(REMINDERS, {
      fetch: () => { throw new Error('network must not be attempted when unconfigured') },
    })
    assert.deepEqual(result, { sent: false, channel: 'webhook', configured: false, reason: 'not-configured' })

    const explicitEmpty = await sendWebhookNotification(REMINDERS, { url: '' })
    assert.equal(explicitEmpty.sent, false)
    assert.equal(explicitEmpty.configured, false)
  } finally {
    if (previous === undefined) delete process.env[WEBHOOK_ENV]
    else process.env[WEBHOOK_ENV] = previous
  }
  assert.equal(isWebhookConfigured({ [WEBHOOK_ENV]: '   ' }), false)
  assert.equal(isWebhookConfigured({ [WEBHOOK_ENV]: 'https://example.com/hook' }), true)
})

test('ADVISERS_NOTIFY_WEBHOOK opts in and POSTs the sanitized JSON payload', async () => {
  const collected = []
  const server = await captureServer(collected)
  const previous = process.env[WEBHOOK_ENV]
  process.env[WEBHOOK_ENV] = server.url
  try {
    assert.equal(isWebhookConfigured(), true)
    const result = await sendWebhookNotification(REMINDERS, { timeoutMs: 4000 })
    assert.equal(result.sent, true)
    assert.equal(result.channel, 'webhook')
    assert.equal(result.configured, true)
    assert.equal(result.status, 200)
    assert.deepEqual(result.payload, summarizeReminders(REMINDERS))

    assert.equal(collected.length, 1)
    assert.equal(collected[0].method, 'POST')
    assert.equal(collected[0].url, '/hook')
    assert.match(String(collected[0].headers['content-type']), /application\/json/)
    const payload = JSON.parse(collected[0].body)
    assert.deepEqual(payload, summarizeReminders(REMINDERS))
    assert.ok(!collected[0].body.includes('私密'))
  } finally {
    if (previous === undefined) delete process.env[WEBHOOK_ENV]
    else process.env[WEBHOOK_ENV] = previous
    await server.close()
  }
})

test('HTTP failures, refused connections and timeouts are explicit and never throw', async () => {
  const collected = []
  const failing = await captureServer(collected, (res) => {
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.end('upstream unavailable')
  })
  try {
    const httpFailure = await sendWebhookNotification(REMINDERS, { url: failing.url })
    assert.equal(httpFailure.sent, false)
    assert.equal(httpFailure.channel, 'webhook')
    assert.equal(httpFailure.configured, true)
    assert.equal(httpFailure.error, 'http')
    assert.equal(httpFailure.status, 503)
    assert.match(httpFailure.detail, /upstream unavailable/)
  } finally {
    await failing.close()
  }

  // No listener on port 1: the fetch itself fails (the "offline" case).
  const offline = await sendWebhookNotification(REMINDERS, { url: 'http://127.0.0.1:1/hook', timeoutMs: 2000 })
  assert.equal(offline.sent, false)
  assert.equal(offline.configured, true)
  assert.equal(offline.error, 'network')
  assert.ok(offline.detail.length > 0, 'network failures carry a readable detail')

  const timeout = await sendWebhookNotification(REMINDERS, {
    url: 'https://example.invalid/hook',
    fetch: async () => { const error = new Error('aborted'); error.name = 'TimeoutError'; throw error },
  })
  assert.equal(timeout.sent, false)
  assert.equal(timeout.error, 'timeout')

  const invalid = await sendWebhookNotification(REMINDERS, { url: 'not a url', fetch: () => { throw new Error('must not fetch') } })
  assert.equal(invalid.configured, true)
  assert.equal(invalid.error, 'invalid-url')

  const unsupported = await sendWebhookNotification(REMINDERS, { url: 'ftp://example.com/hook', fetch: () => { throw new Error('must not fetch') } })
  assert.equal(unsupported.error, 'unsupported-protocol')
})

test('the local notification adapter is unchanged by the webhook addition', async () => {
  const result = await sendNotification({ title: 't', body: 'b', cmd: '' })
  assert.equal(typeof result.sent, 'boolean')
})
