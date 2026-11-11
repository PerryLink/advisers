import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHistory, buildOpening, selectTurns, shouldSummarize, summarizeTurns } from '../lib/context-window.js'

const turns = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, role: i % 2 ? 'assistant' : 'user', content: `turn ${i + 1}` }))

test('selects recent turns chronologically and within budget', () => {
  const selected = selectTurns(turns, { maxTurns: 5, maxTokens: 100 })
  assert.deepEqual(selected.map((t) => t.seq), [26, 27, 28, 29, 30])
  const history = buildHistory({ turns, summary: 'old summary', throughSeq: 20 })
  assert.equal(history.turns.length, 10)
  assert.equal(history.turns[0].seq, 21)
  assert.equal(history.summary, 'old summary')
})

test('summary triggers after the configured number of fresh turns', () => {
  assert.equal(shouldSummarize(turns, 20, 10), true)
  assert.equal(shouldSummarize(turns, 25, 10), false)
  assert.match(summarizeTurns(turns.slice(0, 3)), /用户：turn 1/)
})

test('opening has last progress, due commitments and one default action', () => {
  const opening = buildOpening({
    turns: [{ seq: 1, role: 'user', content: '把预算改成 420' }],
    commitments: [{ status: 'open', action: '发报价给张总', dueAt: new Date(Date.now() + 3600_000).toISOString() }],
  })
  assert.match(opening, /上次你说：把预算改成 420/)
  assert.match(opening, /今天到期：发报价给张总/)
  assert.match(opening, /默认动作：先处理到期承诺/)
})
