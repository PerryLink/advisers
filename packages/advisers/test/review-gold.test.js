import assert from 'node:assert/strict'
import test from 'node:test'
import { lintReview, parseReview } from '../lib/review.js'

const run = { task: '周报', tools: ['office_template', 'file_read'], artifacts: ['out/week.docx'] }

test('20-case review gold set: accepts only evidence-backed proposals', () => {
  const cases = [
    ['SAVE', '周报', true], ['SAVE', '周报', true], ['FOLD_INTO', 'routine_1', true],
    ['NONE', '', true], ['SAVE', '周报', false], ['SAVE', '周报', false],
    ['FOLD_INTO', 'routine_1', false], ['NONE', '', true], ['SAVE', '周报', true],
    ['SAVE', '周报', true], ['SAVE', '周报', false], ['FOLD_INTO', 'missing', false],
    ['NONE', '', true], ['SAVE', '周报', true], ['SAVE', '周报', false],
    ['FOLD_INTO', 'routine_1', true], ['NONE', '', true], ['SAVE', '周报', true],
    ['SAVE', '周报', false], ['NONE', '', true],
  ]
  let accepted = 0
  for (const [verdict, fold, ok] of cases) {
    const parsed = parseReview(JSON.stringify({
      verdict,
      name: verdict === 'SAVE' ? '周报' : '',
      description: verdict === 'SAVE' ? '周报流程' : '',
      steps: verdict === 'SAVE' ? ['office_template', 'file_read'] : [],
      verification: verdict === 'SAVE' ? ['file:out/week.docx'] : [],
      foldInto: fold,
    }))
    if (!ok && verdict === 'SAVE') parsed.steps = ['curl']
    if (!ok && verdict === 'FOLD_INTO') parsed.foldInto = 'missing'
    const routines = [{ id: 'routine_1', name: '周报' }]
    assert.equal(lintReview(parsed, { run, routines }).ok, ok, `${verdict}/${fold}`)
    if (ok) accepted++
  }
  assert.equal(accepted, 13)
})
