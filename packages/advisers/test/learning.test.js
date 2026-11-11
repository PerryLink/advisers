import assert from 'node:assert/strict'
import test from 'node:test'
import { applyPreferenceDecay, buildRoutineCandidate, correctionStatement } from '../lib/learning.js'

test('extracts corrections without treating ordinary tasks as preferences', () => {
  assert.equal(correctionStatement('不是先列事实，是先给结论'), '先给结论')
  assert.equal(correctionStatement('以后周报都先给结论'), '以后周报都先给结论')
  assert.equal(correctionStatement('做成一份周报'), null)
})

test('preference decays every 30 days and deprecates below 0.3', () => {
  const prefs = [
    { status: 'confirmed', confidence: 0.8, validFrom: '2026-01-01T00:00:00Z', lastConfirmed: '2026-01-01T00:00:00Z' },
    { status: 'confirmed', confidence: 0.8, validFrom: '2026-10-30T00:00:00Z' },
  ]
  const changed = applyPreferenceDecay(prefs, new Date('2026-08-01T00:00:00Z'))
  assert.equal(changed.length, 1)
  assert.ok(prefs[0].confidence < 0.3)
  assert.equal(prefs[0].status, 'deprecated')
  assert.equal(prefs[1].confidence, 0.8)
})

test('routine candidate requires at least two tools', () => {
  assert.equal(buildRoutineCandidate({ text: 'x', toolLog: [{ name: 'file_write' }] }), null)
  const routine = buildRoutineCandidate({ text: '周报流程', artifacts: ['out/week.docx'], toolLog: [{ name: 'office_template' }, { name: 'file_read' }, { name: 'file_write' }] })
  assert.equal(routine.name, '周报流程')
  assert.deepEqual(routine.steps, ['office_template', 'file_read', 'file_write'])
  assert.deepEqual(routine.verification, ['file:out/week.docx'])
  assert.equal(routine.createdBy, 'agent')
})

test('hard constraints never decay or get deprecated', () => {
  const prefs = [{ priority: 'hard', status: 'confirmed', confidence: 0.9, validFrom: '2024-01-01T00:00:00Z' }]
  applyPreferenceDecay(prefs, new Date('2026-11-11T00:00:00Z'))
  assert.equal(prefs[0].confidence, 0.9)
  assert.equal(prefs[0].status, 'confirmed')
})
