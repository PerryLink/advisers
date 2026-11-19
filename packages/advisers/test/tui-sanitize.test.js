import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasUnsafeDisplayChars,
  isDisplaySafe,
  jsonSafe,
  sanitizeDisplay,
  sanitizeJsonString,
} from '../lib/tui/sanitize.js'

const ESC = '\u001b'
const BEL = '\u0007'

test('sanitizeDisplay strips CSI/OSC/DCS/APC and C1, normalises line breaks', () => {
  assert.equal(sanitizeDisplay(ESC + '[2J' + ESC + '[Hclear'), 'clear')
  assert.equal(sanitizeDisplay(ESC + ']0;PWNED' + BEL + 'title'), 'title')
  assert.equal(sanitizeDisplay(ESC + ']8;;https://evil.example' + BEL + 'link' + ESC + ']8;;' + BEL), 'link')
  assert.equal(sanitizeDisplay(ESC + 'P1;2|payload' + ESC + '\\safe'), 'safe')
  assert.equal(sanitizeDisplay(ESC + '_apc' + ESC + '\\safe'), 'safe')
  assert.equal(sanitizeDisplay('\u009b31mred\u009b0m'), 'red')
  assert.equal(sanitizeDisplay('a\r\nb\rc'), 'a\nb\nc')
  assert.equal(sanitizeDisplay('a' + ESC + '[31mb' + ESC + '[39mc'), 'abc')
  assert.equal(sanitizeDisplay('a' + BEL + 'b\u0007'), 'ab')
})

test('sanitizeDisplay keeps normal text, emoji ZWJ families, tabs and newlines', () => {
  assert.equal(sanitizeDisplay('你好，世界！'), '你好，世界！')
  assert.equal(sanitizeDisplay('😀🎉'), '😀🎉')
  assert.equal(sanitizeDisplay('👨\u200D👩\u200D👧\u200D👦 family'), '👨\u200D👩\u200D👧\u200D👦 family')
  assert.equal(sanitizeDisplay('a\tb\nc'), 'a\tb\nc')
  assert.equal(sanitizeDisplay(null), '')
  assert.equal(sanitizeDisplay(undefined), '')
  assert.equal(sanitizeDisplay(42), '42')
})

test('sanitizeDisplay singleLine folds whitespace for one-line fields', () => {
  assert.equal(sanitizeDisplay('a\nb\tc', { singleLine: true }), 'a b c')
  assert.equal(sanitizeDisplay('  spaced   text  ', { singleLine: true }), 'spaced text')
  assert.equal(sanitizeDisplay('a\u202Eb\u200Ec', { singleLine: true }), 'abc')
  assert.ok(!/[\n\t]/.test(sanitizeDisplay('x\ny\tz', { singleLine: true })))
})

test('sanitizeDisplay truncates by display width, not by code units', () => {
  assert.equal(sanitizeDisplay('你好世界你好', { maxWidth: 5 }), '你好…')
  assert.equal(sanitizeDisplay('abcdefgh', { maxWidth: 5 }), 'abcd…')
  assert.equal(sanitizeDisplay('你好\n世界', { maxWidth: 3 }), '你…\n世…')
  assert.equal(sanitizeDisplay('short', { maxWidth: 10 }), 'short')
  assert.equal(sanitizeDisplay('abcdef', { maxChars: 4 }), 'abc…')
})

test('sanitizeDisplay expands tabs on request', () => {
  assert.equal(sanitizeDisplay('a\tb', { expandTabs: true, tabSize: 4 }), 'a   b')
  assert.equal(sanitizeDisplay('你好\tb', { expandTabs: true }), '你好    b')
})

test('display sanitisation corpus leaves no terminal-forging characters', () => {
  const corpus = [
    ESC + '[2J' + ESC + '[H' + ESC + '[?25l' + ESC + '[?1049h',
    ESC + ']0;title' + BEL + 'body',
    ESC + ']8;;https://evil.example' + BEL + 'click' + ESC + ']8;;' + BEL,
    ESC + 'P1;2|dcs-payload' + ESC + '\\tail',
    'a\u0007b\u0008c\u000bd\u000ce\u007ff',
    'line1\r\nline2\rline3',
    'safe\u202Etxt.exe\u202C\u2066\u2069\u061C\uFEFF',
    '\u009b31mred\u009b0m',
  ]
  for (const raw of corpus) {
    const safe = sanitizeDisplay(raw, { singleLine: true })
    assert.equal(hasUnsafeDisplayChars(safe), false, JSON.stringify(safe))
    assert.equal(isDisplaySafe(safe), true)
    assert.ok(!safe.includes(ESC))
    assert.ok(!safe.includes('\r'))
  }
})

test('hasUnsafeDisplayChars flags only control/bidi characters', () => {
  assert.equal(hasUnsafeDisplayChars('plain 中文 😀'), false)
  assert.equal(hasUnsafeDisplayChars('👨\u200D👩\u200D👧\u200D👦'), false)
  assert.equal(hasUnsafeDisplayChars('a\tb\nc'), false)
  assert.equal(hasUnsafeDisplayChars(ESC + '[31m'), true)
  assert.equal(hasUnsafeDisplayChars('\u0007'), true)
  assert.equal(hasUnsafeDisplayChars('\u009b'), true)
  assert.equal(hasUnsafeDisplayChars('\u202E'), true)
  assert.equal(hasUnsafeDisplayChars('\u200E'), true)
  assert.equal(hasUnsafeDisplayChars('\uFEFF'), true)
  assert.equal(isDisplaySafe('你好'), true)
  assert.equal(isDisplaySafe(ESC + '[2J'), false)
})

test('jsonSafe deep-sanitises strings and keys without mutating the input', () => {
  const input = {
    a: ESC + '[2Jx',
    b: ['a\u202Eb', 'ok'],
    你好: '世界',
    c: 1,
    d: null,
    e: { nested: 'a' + BEL + 'b' },
  }
  const safe = jsonSafe(input)
  assert.deepEqual(safe, { a: 'x', b: ['ab', 'ok'], 你好: '世界', c: 1, d: null, e: { nested: 'ab' } })
  assert.equal(input.a, ESC + '[2Jx', 'input object is not mutated')
  const escapedKey = jsonSafe({ [ESC + '[31mkey']: 'v' })
  assert.deepEqual(escapedKey, { key: 'v' })
})

test('jsonSafe keeps newlines/tabs and emoji clusters, strips CR and bidi', () => {
  assert.equal(jsonSafe('line1\r\nline2'), 'line1\nline2')
  assert.equal(jsonSafe('a\tb'), 'a\tb')
  assert.equal(jsonSafe('👨\u200D👩\u200D👧\u200D👦'), '👨\u200D👩\u200D👧\u200D👦')
  assert.equal(jsonSafe('a\u202Eb'), 'ab')
  assert.equal(jsonSafe(42), 42)
  assert.equal(jsonSafe(null), null)
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => jsonSafe(cyclic), /cyclic/)
})

test('sanitizeJsonString handles one field', () => {
  assert.equal(sanitizeJsonString('a\r\nb'), 'a\nb')
  assert.equal(sanitizeJsonString(ESC + '[31mred' + ESC + '[39m'), 'red')
  assert.equal(sanitizeJsonString('x\u0085y'), 'xy')
  assert.equal(sanitizeJsonString(null), '')
})

test('sanitisation and rendering are total over adversarial Unicode fuzz input', () => {
  const pool = [
    0x0000, 0x0007, 0x000a, 0x000d, 0x001b, 0x007f, 0x0085, 0x009b, 0x0301, 0x061c,
    0x200b, 0x200d, 0x200e, 0x202e, 0x2066, 0x20e3, 0x2600, 0x2705, 0x3000, 0x4f60,
    0xfe0f, 0xfeff, 0x1f1e8, 0x1f1f3, 0x1f3fb, 0x1f600, 0xd800, 0xdc00,
  ]
  let state = 20261120
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state
  }
  for (let round = 0; round < 200; round += 1) {
    let text = ''
    const length = 1 + (next() % 40)
    for (let index = 0; index < length; index += 1) text += String.fromCodePoint(pool[next() % pool.length])
    const safe = sanitizeDisplay(text, { singleLine: true, maxWidth: 20 })
    assert.equal(typeof safe, 'string')
    assert.equal(hasUnsafeDisplayChars(safe), false, JSON.stringify(text))
    assert.ok(!/[\n\r]/.test(safe))
    const json = sanitizeJsonString(text)
    assert.equal(typeof json, 'string')
    assert.equal(hasUnsafeDisplayChars(json.replace(/[\n\t]/g, '')), false, JSON.stringify(text))
    assert.doesNotThrow(() => jsonSafe({ text }))
  }
})
