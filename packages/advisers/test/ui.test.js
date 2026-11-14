import assert from 'node:assert/strict'
import test from 'node:test'
import { createReadOnlyServer } from '../lib/ui.js'

test('E8: read-only UI serves GET endpoints and rejects writes', async () => {
  const snapshot = {
    today: () => ({ open: 1, commitments: [{ id: 'cm_1', action: '发报价' }] }),
    commitments: () => [{ id: 'cm_1', status: 'open' }],
    who: () => ({ mine: [], waiting: [] }),
    reminders: () => [],
  }
  const app = createReadOnlyServer({ snapshot })
  const url = await app.listen()
  try {
    const page = await fetch(url + '/')
    assert.match(await page.text(), /本地只读视图/)
    const today = await (await fetch(url + '/api/today')).json()
    assert.equal(today.commitments[0].action, '发报价')
    const write = await fetch(url + '/api/today', { method: 'POST' })
    assert.equal(write.status, 405)
    const missing = await fetch(url + '/api/nope')
    assert.equal(missing.status, 404)
  } finally { await app.close() }
})
