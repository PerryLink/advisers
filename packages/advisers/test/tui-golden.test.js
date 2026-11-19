import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { renderConfirm, renderError, renderResult, renderSnapshot, renderStatus } from '../lib/tui/render.js'
import { hasUnsafeDisplayChars } from '../lib/tui/sanitize.js'
import { graphemes, strWidth } from '../lib/tui/width.js'

const golden = JSON.parse(readFileSync(new URL('./fixtures/tui-golden.json', import.meta.url), 'utf8'))
const ESC = '\u001b'

function renderCase(testCase) {
  const options = { width: testCase.width, ...testCase.options }
  if (testCase.kind === 'status') return [renderStatus(testCase.input, options)]
  if (testCase.kind === 'result') return renderResult(testCase.input, options)
  if (testCase.kind === 'error') return renderError(testCase.input, options)
  if (testCase.kind === 'confirm') return renderConfirm(testCase.input, options)
  if (testCase.kind === 'snapshot') return renderSnapshot(testCase.input, options)
  throw new Error('unknown golden kind: ' + testCase.kind)
}

test('0.3.0 golden human-output snapshots', () => {
  assert.equal(golden.cases.length, 22)
  for (const testCase of golden.cases) {
    assert.deepEqual(renderCase(testCase), testCase.expected, testCase.name)
  }
})

test('every golden line is bounded, safe and deterministic', () => {
  for (const testCase of golden.cases) {
    const lines = renderCase(testCase)
    for (const line of lines) {
      assert.ok(strWidth(line) <= testCase.width || graphemes(line).length === 1, testCase.name + ': ' + JSON.stringify(line))
      assert.equal(hasUnsafeDisplayChars(line), false, testCase.name + ': unsafe ' + JSON.stringify(line))
      assert.ok(!line.includes(ESC), testCase.name + ': colour must be off in goldens')
      assert.ok(!line.includes('\r'), testCase.name + ': no CR')
      assert.equal(line, line.replace(/ +$/g, ''), testCase.name + ': no trailing spaces')
    }
    assert.deepEqual(renderCase(testCase), testCase.expected, testCase.name + ': deterministic')
  }
})

test('goldens stay pure JSON (the fixture itself)', () => {
  const text = readFileSync(new URL('./fixtures/tui-golden.json', import.meta.url), 'utf8')
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
})

