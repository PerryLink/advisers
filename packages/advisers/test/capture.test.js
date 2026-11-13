import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCaptureCandidates, captureCandidates } from '../lib/capture.js'

test('capture keeps only verbatim quotes and valid due dates', () => {
  const text = '王工：周五前把报价发给我。我：好的，我周五前发。'
  const rows = validateCaptureCandidates([
    { action: '发报价', debtor: 'user', creditor: '王工', dueAt: '2026-11-14T10:00:00+08:00', quote: '我周五前发', modal: 'firm' },
    { action: '编造', debtor: 'user', quote: '我下周发' },
  ], text, { now: new Date('2026-11-12T10:00:00+08:00') })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].action, '发报价')
  assert.match(rows[0].dueAt, /2026-11-14/)
})

test('capture calls the model and returns structural candidates', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.reasoning_effort, 'high')
    assert.equal(body.thinking.type, 'enabled')
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [{ action: '发报价', debtor: 'user', creditor: '王工', dueAt: '2026-11-14T10:00:00+08:00', quote: '周五前发报价给王工', modal: 'firm', confidence: 0.9 }] }) } }], usage: { total_tokens: 1 } }), { status: 200 })
  }
  const result = await captureCandidates({ text: '周五前发报价给王工', apiKey: 'k', fetchImpl, now: new Date('2026-11-12T10:00:00+08:00') })
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].creditor, '王工')
})
