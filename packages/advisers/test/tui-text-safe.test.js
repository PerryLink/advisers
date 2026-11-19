import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CONSOLE_TEXT_MAX,
  sanitizeConsoleText,
  stripBidiControls,
  stripBom,
  stripControlChars,
  stripTerminalSequences,
  TRUNCATION_MARK,
} from '../lib/text-safe.js'

const ESC = '\u001b'
const BEL = '\u0007'
const ST = ESC + '\\'

test('stripBom removes only a leading BOM', () => {
  assert.equal(stripBom('\uFEFFhello'), 'hello')
  assert.equal(stripBom('hello'), 'hello')
  assert.equal(stripBom('he\uFEFFllo'), 'he\uFEFFllo')
  assert.equal(stripBom(''), '')
  assert.equal(stripBom(null), '')
})

test('stripTerminalSequences removes CSI/OSC/DCS/SOS/PM/APC payloads', () => {
  assert.equal(stripTerminalSequences(ESC + '[2Jclear'), 'clear')
  assert.equal(stripTerminalSequences(ESC + '[31mred' + ESC + '[39m'), 'red')
  assert.equal(stripTerminalSequences(ESC + ']0;PWNED' + BEL + 'title'), 'title')
  assert.equal(stripTerminalSequences(ESC + ']8;;https://evil.example' + BEL + 'link' + ESC + ']8;;' + BEL), 'link')
  assert.equal(stripTerminalSequences(ESC + ']0;title' + ST + 'safe'), 'safe')
  assert.equal(stripTerminalSequences(ESC + 'P1;2|payload' + ST + 'safe'), 'safe')
  assert.equal(stripTerminalSequences(ESC + '_apc-payload' + ST + 'safe'), 'safe')
  assert.equal(stripTerminalSequences('\u009b31mred\u009b0m'), 'red')
  assert.equal(stripTerminalSequences('plain text'), 'plain text')
  assert.equal(stripTerminalSequences(42), '42')
})

test('stripBidiControls removes bidi overrides and zero-width marks', () => {
  assert.equal(stripBidiControls('a\u202Eb'), 'ab')
  assert.equal(stripBidiControls('a\u200Eb\u200Fc'), 'abc')
  assert.equal(stripBidiControls('a\u2066b\u2069c'), 'abc')
  assert.equal(stripBidiControls('a\u061Cb'), 'ab')
  assert.equal(stripBidiControls('a\uFEFFb'), 'ab')
  assert.equal(stripBidiControls('你好，世界😀'), '你好，世界😀')
})

test('stripControlChars keeps or folds line structure by option', () => {
  assert.equal(stripControlChars('a\nb\tc\u0007d'), 'a\nb\tc d')
  assert.equal(stripControlChars('a\nb\tc', { keepNewlines: false }), 'a b\tc')
  assert.equal(stripControlChars('a\tb', { keepTabs: false }), 'a b')
  assert.equal(stripControlChars('a\u009bb'), 'a b')
})

test('sanitizeConsoleText folds a webhook body into one safe line', () => {
  const body = 'HTTP 500 ' + ESC + '[2J' + ESC + ']0;PWNED' + BEL + 'bad\r\nforged log line\u202Egpj' + BEL + ESC + ']8;;https://evil.example' + BEL
  const safe = sanitizeConsoleText(body)
  assert.equal(typeof safe, 'string')
  assert.ok(!safe.includes(ESC), 'no ESC')
  assert.ok(!safe.includes('\r'), 'no CR')
  assert.ok(!safe.includes('\n'), 'no LF')
  assert.ok(!safe.includes(BEL), 'no BEL')
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(safe), 'no C0/C1/DEL')
  assert.ok(!safe.includes('\u202E'), 'no bidi override')
  assert.match(safe, /HTTP 500/)
  assert.match(safe, /bad forged log line/)
  assert.ok(!safe.includes('PWNED'), 'OSC payload removed')
})

test('sanitizeConsoleText handles IMAP greeting/status injection samples', () => {
  const samples = [
    'A1 NO [AUTHENTICATIONFAILED] Invalid credentials ' + ESC + '[31m',
    ESC + ']0;hijacked-title' + BEL + 'A2 OK done',
    'A3 BAD \u202Emirror',
  ]
  for (const sample of samples) {
    const safe = sanitizeConsoleText(sample)
    assert.ok(!safe.includes(ESC))
    assert.ok(!safe.includes(BEL))
    assert.ok(!/[\u202a-\u202e]/.test(safe))
  }
})

test('sanitizeConsoleText truncates by code points inside the budget', () => {
  assert.equal(sanitizeConsoleText('abcdefghij', { max: 5 }), 'abcd' + TRUNCATION_MARK)
  assert.equal(sanitizeConsoleText('abcdefghij', { max: 10 }), 'abcdefghij')
  assert.equal(sanitizeConsoleText('abcdefghij', { max: 1 }), 'a')
  assert.equal(sanitizeConsoleText('abcdefghij', { max: 0 }), '')
  assert.equal(sanitizeConsoleText('😀😀😀😀', { max: 3 }), '😀😀' + TRUNCATION_MARK)
  assert.equal(DEFAULT_CONSOLE_TEXT_MAX, 2000)
  assert.equal(Array.from(sanitizeConsoleText('你'.repeat(3000))).length, 2000)
})

test('sanitizeConsoleText is total over non-string values', () => {
  assert.equal(sanitizeConsoleText(null), '')
  assert.equal(sanitizeConsoleText(undefined), '')
  assert.equal(sanitizeConsoleText(42), '42')
  assert.equal(sanitizeConsoleText(true), 'true')
  assert.equal(sanitizeConsoleText({ a: 1 }), '[object Object]')
  assert.equal(sanitizeConsoleText('a'.repeat(10) + ESC + '[2J'), 'a'.repeat(10))
})

test('sanitizeConsoleText preserves normal Chinese punctuation and emoji', () => {
  assert.equal(sanitizeConsoleText('你好，世界！'), '你好，世界！')
  assert.equal(sanitizeConsoleText('😀🎉'), '😀🎉')
  assert.equal(sanitizeConsoleText('a\tb'), 'a\tb')
  assert.equal(sanitizeConsoleText('a\tb', { keepTabs: false }), 'a b')
  assert.equal(sanitizeConsoleText('  spaced  '), 'spaced')
})

test('sanitizeConsoleText never returns a second line for adversarial corpora', () => {
  const corpus = [
    ESC + '[2J' + ESC + '[H' + ESC + '[?25l',
    ESC + ']0;title' + BEL + 'body',
    'a\u0007b\u0008c\u000bd\u000ce\u007ff',
    'line1\r\nline2\rline3\nline4',
    'safe\u202Etxt.exe\u202C',
    '\u200B\u200C\u200D\u200E\u200F\uFEFF',
  ]
  for (const raw of corpus) {
    const safe = sanitizeConsoleText(raw)
    assert.ok(!safe.includes('\n'), 'one line only')
    assert.ok(!safe.includes('\r'), 'no CR')
    assert.ok(!safe.includes(ESC), 'no ESC')
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(safe), 'no remaining control bytes')
  }
})

