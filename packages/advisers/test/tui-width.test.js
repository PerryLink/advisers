import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  charWidth,
  clampColumns,
  codePointWidth,
  expandTabs,
  graphemes,
  padToWidth,
  strWidth,
  truncateMiddle,
  truncateToWidth,
  wrap,
} from '../lib/tui/width.js'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/tui-cjk.json', import.meta.url), 'utf8'))

const CJK_CLOSERS = new Set(['，', '。', '、', '；', '：', '！', '？', '）', '》', '」', '』', '】', '〕', '〉', '”', '’'])
const CJK_OPENERS = new Set(['（', '《', '「', '『', '【', '〔', '〈', '“', '‘'])

function isSingleClusterLine(line) {
  return graphemes(line).length === 1
}

function makeRng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const RANDOM_TOKENS = [
  '你', '好', '中', '文', '，', '。', '、', '；', '！', '？', '（', '）', '《', '》',
  ' ', 'ab', 'cd', 'word', '/path/to', '...', '😀', '🎉', '👨\u200D👩\u200D👧\u200D👦',
  'e\u0301', '１２', '·', '—', '\t', 'https://example.com/x',
]

function randomText(rng, length) {
  let text = ''
  let previous = -1
  while (text.length < length) {
    const index = Math.floor(rng() * RANDOM_TOKENS.length)
    if (index === previous && RANDOM_TOKENS[index] === ' ') continue
    previous = index
    text += RANDOM_TOKENS[index]
  }
  return text
}

test('CJK/emoji/combining display-width fixture table', () => {
  assert.equal(fixtures.widths.length, 31)
  for (const fixture of fixtures.widths) {
    assert.equal(strWidth(fixture.text), fixture.strWidth, 'strWidth(' + fixture.name + ')')
    assert.equal(Array.from(fixture.text).length, fixture.codepoints, 'codepoints(' + fixture.name + ')')
    assert.equal(graphemes(fixture.text).length, fixture.graphemes, 'graphemes(' + fixture.name + ')')
  }
})

test('emoji ZWJ families, flags, keycaps and skin tones count once', () => {
  assert.equal(strWidth('👨\u200D👩\u200D👧\u200D👦'), 2)
  assert.equal(graphemes('👨\u200D👩\u200D👧\u200D👦').length, 1)
  assert.equal(strWidth('🇨🇳'), 2)
  assert.equal(graphemes('🇨🇳').length, 1)
  assert.equal(strWidth('1\uFE0F\u20E3'), 2)
  assert.equal(strWidth('👨🏽\u200D💻'), 2)
  assert.deepEqual(graphemes('e\u0301你😀', { segmenter: null }), ['e\u0301', '你', '😀'])
})

test('ambiguous East_Asian_Width defaults to 1 and is opt-in to 2', () => {
  assert.equal(strWidth('·—…“”'), 5)
  assert.equal(strWidth('·—…“”', { ambiguousWidth: 2 }), 10)
  assert.equal(strWidth('€①'), 2)
  assert.equal(strWidth('€①', { ambiguousWidth: 2 }), 4)
})

test('ANSI/OSC sequences contribute no display width', () => {
  assert.equal(strWidth('\u001b[31m红色你好\u001b[39m'), 8)
  assert.equal(strWidth('\u001b]8;;https://example.com\u0007链接\u001b]8;;\u0007'), 4)
  assert.equal(strWidth('\u001b[2J\u001b[H'), 0)
  assert.equal(strWidth('\u001b]0;title\u0007abc'), 3)
})

test('grapheme fallback (no Intl.Segmenter) keeps combining marks together', () => {
  assert.deepEqual(graphemes('e\u0301\u0302x', { segmenter: null }), ['e\u0301\u0302', 'x'])
  assert.deepEqual(graphemes('👨\u200D👩\u200D👧\u200D👦', { segmenter: null }), ['👨\u200D👩\u200D👧\u200D👦'])
})

test('wrap fixtures match golden lines and respect the width', () => {
  assert.equal(fixtures.wraps.length, 17)
  for (const fixture of fixtures.wraps) {
    assert.deepEqual(wrap(fixture.text, fixture.width), fixture.lines, 'wrap(' + fixture.name + ')')
    for (const line of fixture.lines) {
      const lineWidth = strWidth(line)
      assert.ok(lineWidth <= fixture.width || isSingleClusterLine(line), fixture.name + ': ' + JSON.stringify(line) + ' width ' + lineWidth)
      assert.equal(line, line.replace(/^ +| +$/g, ''), fixture.name + ': wrapped line must not carry edge spaces')
    }
  }
})

test('wrap invariants hold for seeded mixed text at 40/80/200 columns', () => {
  for (let seed = 1; seed <= 6; seed += 1) {
    const rng = makeRng(seed)
    const text = randomText(rng, 160)
    for (const width of [40, 80, 200]) {
      const lines = wrap(text, width)
      assert.ok(lines.length > 0, 'wrap returns at least one line')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const lineWidth = strWidth(line)
        assert.ok(lineWidth <= width || isSingleClusterLine(line), 'seed ' + seed + ': line width ' + lineWidth + ' > ' + width + ': ' + JSON.stringify(line))
        if (index > 0 && line.length > 0 && CJK_CLOSERS.has(line[0])) {
          assert.ok(strWidth(lines[index - 1]) >= width, 'seed ' + seed + ': closing punctuation must not start a soft-wrapped line: ' + JSON.stringify(line))
        }
        if (index < lines.length - 1 && line.length > 0 && CJK_OPENERS.has(line[line.length - 1])) {
          assert.ok(lineWidth >= width, 'seed ' + seed + ': opening punctuation must not end a soft-wrapped line: ' + JSON.stringify(line))
        }
      }
      const visible = (value) => value.replace(/[ \t\n]/g, '')
      assert.equal(visible(lines.join('')), visible(text), 'seed ' + seed + ': wrap lost or invented content at ' + width)
    }
  }
})

test('wrap keystones: single grapheme overflow, CRLF, tabs, blank lines, spaces', () => {
  assert.deepEqual(wrap('👨\u200D👩\u200D👧\u200D👦', 1), ['👨\u200D👩\u200D👧\u200D👦'])
  assert.deepEqual(wrap('😀', 1), ['😀'])
  assert.deepEqual(wrap('a\r\nb', 10), ['a', 'b'])
  assert.deepEqual(wrap('a\n\nb', 10), ['a', '', 'b'])
  assert.deepEqual(wrap('a\tb', 10, { tabSize: 4 }), ['a   b'])
  assert.deepEqual(wrap('', 10), [''])
  assert.deepEqual(wrap('a  b c', 10), ['a  b c'])
  assert.deepEqual(wrap('abcde   ', 5), ['abcde'])
})

test('truncateToWidth never exceeds the budget and keeps an ellipsis', () => {
  const text = '你好世界你好世界'
  for (let limit = 0; limit <= 12; limit += 1) {
    const truncated = truncateToWidth(text, limit)
    assert.ok(strWidth(truncated) <= limit, 'limit ' + limit + ': ' + JSON.stringify(truncated))
    if (limit > 0 && strWidth(text) > limit) assert.match(truncated, /…$/)
  }
  assert.equal(truncateToWidth('abc', 5), 'abc')
  assert.equal(truncateToWidth('', 0), '')
  assert.equal(truncateToWidth('abcdef', 0), '')
  assert.equal(strWidth(truncateToWidth('é'.repeat(20), 7)), 7)
})

test('truncateMiddle keeps the head and the tail for long paths', () => {
  const path = '/mnt/d/Projects/dsh/plugins/advisers/packages/advisers/lib/tui/width.js'
  const truncated = truncateMiddle(path, 30)
  assert.ok(strWidth(truncated) <= 30)
  assert.ok(truncated.startsWith('/mnt/d/Projects'))
  assert.ok(truncated.endsWith('width.js'))
  assert.match(truncated, /…/)
  assert.equal(truncateMiddle('short', 30), 'short')
})

test('padToWidth pads to the requested column count without truncation', () => {
  assert.equal(padToWidth('abc', 6), 'abc   ')
  assert.equal(padToWidth('abc', 6, { align: 'right' }), '   abc')
  assert.equal(padToWidth('你好', 5), '你好 ')
  assert.equal(padToWidth('abcdef', 3), 'abcdef')
  assert.equal(strWidth(padToWidth('你好', 7, { align: 'right' })), 7)
})

test('expandTabs tracks display columns', () => {
  assert.equal(expandTabs('a\tb', 4), 'a   b')
  assert.equal(expandTabs('你好\tb', 4), '你好    b')
  assert.equal(expandTabs('\t', 4), '    ')
  assert.equal(expandTabs('no-tabs', 4), 'no-tabs')
})

test('charWidth/codePointWidth and clampColumns boundaries', () => {
  assert.equal(charWidth('你'), 2)
  assert.equal(charWidth('a'), 1)
  assert.equal(charWidth('😀'), 2)
  assert.equal(charWidth(0x1f600), 2)
  assert.equal(charWidth(0x4f60), 2)
  assert.equal(charWidth(0x65e0), 2)
  assert.equal(codePointWidth(0x0301), 0)
  assert.equal(codePointWidth(0x200d), 0)
  assert.equal(codePointWidth(0x09), 0)
  assert.equal(codePointWidth(-1), 0)
  assert.equal(clampColumns(undefined), 80)
  assert.equal(clampColumns(10), 40)
  assert.equal(clampColumns(500), 200)
  assert.equal(clampColumns(120), 120)
  assert.equal(clampColumns('64'), 64)
})

test('wrap is total and width-bounded over adversarial Unicode fuzz input', () => {
  const pool = [
    0x0000, 0x0007, 0x0009, 0x000a, 0x000d, 0x001b, 0x0301, 0x200b, 0x200d, 0x202e,
    0x20e3, 0x2600, 0x3000, 0x4f60, 0x597d, 0xfe0f, 0x1f1e8, 0x1f1f3, 0x1f600, 0xd800,
    0x0020, 0x0041, 0x0042, 0xff0c, 0xff08, 0xff09, 0x2014,
  ]
  let state = 99112026
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state
  }
  for (let round = 0; round < 100; round += 1) {
    let text = ''
    const length = 1 + (next() % 60)
    for (let index = 0; index < length; index += 1) text += String.fromCodePoint(pool[next() % pool.length])
    for (const width of [1, 2, 3, 5, 8, 13, 21]) {
      const lines = wrap(text, width)
      assert.ok(lines.length > 0)
      for (const line of lines) {
        const lineWidth = strWidth(line)
        assert.ok(lineWidth <= width || graphemes(line).length === 1, JSON.stringify(text) + ' @' + width + ' -> ' + JSON.stringify(line))
      }
      const visible = (value) => value.replace(/[ \t\n\r]/g, '')
      assert.equal(visible(lines.join('')), visible(text), JSON.stringify(text) + ' @' + width)
    }
  }
})
