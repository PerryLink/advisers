import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewDocument, parseDocReview } from '../lib/doc-review.js'

test('parseDocReview validates findings', () => {
  const r = parseDocReview(JSON.stringify({ summary: 'ok', findings: [{ severity: 'blocker', message: '合计不对', evidence: '合计 100' }, { severity: 'warn', message: '缺日期' }] }))
  assert.equal(r.findings.length, 2)
  assert.equal(r.findings[0].severity, 'blocker')
})

test('reviewDocument uses thinking without tools', async () => {
  let body
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '通过', findings: [] }) } }], usage: { total_tokens: 1 } }), { status: 200 })
  }
  const result = await reviewDocument({ text: '预算合计 100', request: '检查合计', apiKey: 'k', fetchImpl })
  assert.equal(result.summary, '通过')
  assert.equal(body.thinking.type, 'enabled')
  assert.equal('tools' in body, false)
})
