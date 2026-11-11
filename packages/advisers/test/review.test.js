import assert from 'node:assert/strict'
import test from 'node:test'
import { Ledger } from '../../core/dist/index.js'
import { lintReview, materializeReview, parseReview } from '../lib/review.js'

const run = { task: '周报', tools: ['office_template', 'file_read'], artifacts: ['out/week.docx'] }

test('review parser strips fences and rejects invented steps/files', () => {
  const parsed = parseReview('```json\n{"verdict":"SAVE","name":"周报","description":"周报流程","steps":["office_template","file_read"],"verification":["file:out/week.docx"]}\n```')
  assert.equal(parsed.verdict, 'SAVE')
  assert.equal(lintReview(parsed, { run }).ok, true)
  assert.equal(lintReview({ ...parsed, steps: ['curl'] }, { run }).ok, false)
  assert.equal(lintReview({ ...parsed, verification: ['file:../secret'] }, { run }).ok, false)
})

test('materialize creates a draft, never active', () => {
  const ledger = new Ledger()
  const parsed = { verdict: 'SAVE', name: '周报', description: '周报流程', steps: ['office_template', 'file_read'], verification: ['file:out/week.docx'] }
  const result = materializeReview(parsed, { run, ledger })
  assert.equal(result.routine.status, 'draft')
})
