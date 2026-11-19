import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertJsonPure,
  errorEnvelope,
  findJsonImpurity,
  isJsonPure,
  JSON_PURITY_CODE,
  JsonPurityError,
  stringifyJson,
} from '../lib/tui/json.js'

const ESC = '\u001b'

test('stringifyJson is deterministic and rejects non-serialisable roots', () => {
  assert.equal(stringifyJson({ b: 1, a: 2 }), '{"b":1,"a":2}')
  assert.equal(stringifyJson([1, 2, 3]), '[1,2,3]')
  assert.equal(stringifyJson({ a: 1 }, { space: 2 }), '{\n  "a": 1\n}')
  assert.throws(() => stringifyJson(undefined), /not JSON-serialisable/)
  assert.throws(() => stringifyJson(() => 1), /not JSON-serialisable/)
})

test('stringifyJson sanitize option applies jsonSafe to strings only', () => {
  const value = { message: ESC + '[2J' + 'hello' + '\u0085', nested: ['a' + '\u202E' + 'b'], count: 2 }
  const raw = stringifyJson(value)
  assert.ok(!raw.includes(ESC), 'JSON.stringify escapes ESC into a text sequence')
  assert.ok(raw.includes('\u0085'), 'raw C1 stays in data by default (data fidelity)')
  assert.ok(raw.includes('\u202E'), 'raw bidi stays in data by default')
  assert.equal(isJsonPure(raw), false)
  assert.equal(stringifyJson(value, { sanitize: true }), '{"message":"hello","nested":["ab"],"count":2}')
  assert.equal(isJsonPure(stringifyJson(value, { sanitize: true })), true)
})

test('isJsonPure accepts exactly one clean JSON document', () => {
  assert.equal(isJsonPure('{"ok":true,"command":"status"}'), true)
  assert.equal(isJsonPure('[1,2,3]'), true)
  assert.equal(isJsonPure('  {"a":"中文😀"}  '), true)
  assert.equal(isJsonPure('{"a":"line1\\nline2"}'), true)
  assert.equal(isJsonPure('{"a":"\\u001b[31m"}'), true, 'escaped control text is pure JSON')
  assert.equal(isJsonPure(''), false)
  assert.equal(isJsonPure('   '), false)
  assert.equal(isJsonPure('hello'), false)
  assert.equal(isJsonPure('{"ok":true} trailing'), false)
  assert.equal(isJsonPure('{"ok":true}{\"second\":1}'), false)
  assert.equal(isJsonPure('E_TOS_REQUIRED: 请先接受 TOS'), false)
  assert.equal(isJsonPure(ESC + '[2J{"ok":true}'), false)
  assert.equal(isJsonPure(42), false)
})

test('isJsonPure rejects raw C0/C1/DEL bytes that a terminal would interpret', () => {
  assert.equal(isJsonPure('{"a":"x\u0085y"}'), false)
  assert.equal(isJsonPure('{"a":"x\u0007y"}'), false)
  assert.equal(isJsonPure('{"a":"x\u007fy"}'), false)
  assert.equal(isJsonPure('{"a":"apostrophe-free"}'), true)
})

test('findJsonImpurity reports the first failure reason', () => {
  assert.equal(findJsonImpurity('{"ok":true}'), null)
  assert.deepEqual(findJsonImpurity(''), { reason: 'empty', offset: -1 })
  assert.deepEqual(findJsonImpurity('not json'), { reason: 'not-json', offset: -1 })
  assert.deepEqual(findJsonImpurity('{"a":"x\u0007y"}'), { reason: 'not-json', offset: -1 }, 'raw C0 makes the document unparsable')
  assert.deepEqual(findJsonImpurity('{"a":"x\u0085y"}'), { reason: 'c1-control', offset: 7 })
})

test('assertJsonPure returns clean text and throws JsonPurityError otherwise', () => {
  assert.equal(assertJsonPure('{"ok":true}'), '{"ok":true}')
  for (const bad of ['hello', '', ESC + '[2J{}', '{"a":"x\u0085"}']) {
    assert.throws(() => assertJsonPure(bad, { label: 'stdout' }), (error) => {
      assert.ok(error instanceof JsonPurityError)
      assert.equal(error.code, JSON_PURITY_CODE)
      assert.match(error.message, /^stdout: /)
      return true
    })
  }
})

test('JSON purity corpus: every human-facing output is rejected', () => {
  const humanOutputs = [
    'Advisers TUI',
    '> 看一下王工现在到哪一步',
    '  文件：out/a.docx（23.4 KB）',
    '! 没做成：同步邮件（work）',
    ESC + '[2J' + ESC + '[H',
    '{"ok":true}\nplain trailing prose',
  ]
  for (const output of humanOutputs) assert.equal(isJsonPure(output), false, JSON.stringify(output))
})

test('errorEnvelope has the documented failure shape and sanitises details', () => {
  assert.deepEqual(errorEnvelope({ code: 'E_IMAP_UIDVALIDITY', message: '游标失效', hint: 'advisers mail sync work --full' }), {
    error: { code: 'E_IMAP_UIDVALIDITY', message: '游标失效', hint: 'advisers mail sync work --full' },
  })
  const withDetails = errorEnvelope({ code: 'E_X', message: 'm', details: { raw: ESC + '[2Jx' } })
  assert.deepEqual(withDetails, { error: { code: 'E_X', message: 'm', details: { raw: 'x' } } })
  assert.deepEqual(errorEnvelope({}), { error: { code: 'E_UNKNOWN', message: '' } })
  assert.equal(isJsonPure(stringifyJson(withDetails)), true)
})

