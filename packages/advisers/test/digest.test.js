import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDigest } from '../lib/digest.js'

test('digest summarizes turns, deliveries and due commitments', () => {
  const now = new Date('2026-11-12T10:00:00Z')
  const out = buildDigest({
    period: 'day',
    now,
    turns: [{ role: 'user', content: '做周报', createdAt: '2026-11-12T09:00:00Z' }],
    commitments: [{ status: 'open', action: '发报价', dueAt: '2026-11-12T18:00:00Z' }],
    deliveries: [{ createdAt: '2026-11-12T09:30:00Z' }],
  })
  assert.match(out, /1 次对话/)
  assert.match(out, /发报价/)
  assert.match(out, /最近一句：做周报/)
})
