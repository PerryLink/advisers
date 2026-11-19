/**
 * Display width, grapheme segmentation, wrapping, truncation and padding.
 *
 * This is the 0.3.0 output kernel's only width implementation: no runtime
 * dependency, no locale data on disk. It follows Unicode UAX #11 East_Asian_Width:
 *
 *   - W (wide) and F (fullwidth) code points occupy 2 columns;
 *   - combining marks (Mn/Me), format characters (Cf) and variation selectors
 *     occupy 0 columns;
 *   - emoji-presentation code points occupy 2 columns (emoji ZWJ sequences count
 *     the cluster once); flags (two regional indicators) occupy 2 columns;
 *   - everything else, including East_Asian_Width=A (ambiguous), occupies 1 column
 *     by default. ambiguousWidth: 2 is available for terminals the user configured
 *     with double-width ambiguous characters; the table is an approximation and must
 *     not be used to align output (see docs/TUI.md).
 *
 * Segmentation uses Intl.Segmenter (grapheme granularity) so a CJK character, an
 * emoji ZWJ family, a flag, a skin-tone modifier or e + combining acute is never
 * split by wrapping. A deterministic fallback exists for runtimes without
 * Intl.Segmenter (only reachable through the `segmenter: null` test hook).
 *
 * Wrapping rules (docs/TUI.md):
 *   - explicit \n is a hard break; CRLF/CR are normalised to \n;
 *   - tabs are expanded to spaces (terminals disagree about tab stops);
 *   - no line starts with closing punctuation (，。、；：！？）》」』】〕〉”’ etc.);
 *   - no line ends with opening punctuation (（《「『【〔〈“‘ etc.);
 *   - ASCII words stay together when possible and are hard-broken only when they
 *     exceed the width alone (paths/URLs are preferred whole, not guaranteed);
 *   - a single grapheme wider than the limit is emitted on its own line (a CJK
 *     glyph cannot be split without corrupting the character).
 *
 * All functions are pure and allocation-only; no I/O.
 */
import { stripTerminalSequences } from '../text-safe.js'

/** Default wrap width when the caller does not pass a usable value. */
export const DEFAULT_WIDTH = 80

const WIDE_RANGES = [
  [0x1100, 0x115f], // Hangul Jamo initial
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3],
  [0x2f00, 0x2fd5],
  [0x2ff0, 0x2ffb],
  [0x3000, 0x303e],
  [0x3041, 0x3096],
  [0x3099, 0x30ff],
  [0x3105, 0x312f],
  [0x3131, 0x318e],
  [0x3190, 0x31e3],
  [0x31f0, 0x321e],
  [0x3220, 0x3247],
  [0x3250, 0x4dbf],
  [0x4e00, 0xa48c],
  [0xa490, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff1],
  [0x17000, 0x187f7],
  [0x18800, 0x18cd5],
  [0x18d00, 0x18d08],
  [0x1b000, 0x1b11e],
  [0x1b150, 0x1b152],
  [0x1b164, 0x1b167],
  [0x1b170, 0x1b2fb],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]

// Common East_Asian_Width=A code points (pinning the ones users hit in Chinese
// prose and CLI output). The set is not exhaustive; it is only consulted when
// ambiguousWidth is 2, and the kernel never relies on ambiguous characters for
// alignment.
const AMBIGUOUS_RANGES = [
  [0x00a1, 0x00a1], [0x00a4, 0x00a4], [0x00a7, 0x00a8], [0x00aa, 0x00aa],
  [0x00ad, 0x00ae], [0x00b0, 0x00b4], [0x00b6, 0x00ba], [0x00bc, 0x00bf],
  [0x00c6, 0x00c6], [0x00d0, 0x00d0], [0x00d7, 0x00d8], [0x00de, 0x00e1],
  [0x00e6, 0x00e6], [0x00e8, 0x00ea], [0x00ec, 0x00ed], [0x00f0, 0x00f0],
  [0x00f2, 0x00f3], [0x00f7, 0x00fa], [0x00fc, 0x00fc], [0x00fe, 0x00fe],
  [0x0101, 0x0101], [0x0111, 0x0111], [0x0113, 0x0113], [0x011b, 0x011b],
  [0x0126, 0x0127], [0x012b, 0x012b], [0x0131, 0x0133], [0x0138, 0x0138],
  [0x013f, 0x0142], [0x0144, 0x0144], [0x0148, 0x014b], [0x014d, 0x014d],
  [0x0152, 0x0153], [0x0166, 0x0167], [0x016b, 0x016b], [0x01ce, 0x01ce],
  [0x01d0, 0x01d0], [0x01d2, 0x01d2], [0x01d4, 0x01d4], [0x01d6, 0x01d6],
  [0x01d8, 0x01d8], [0x01da, 0x01da], [0x01dc, 0x01dc], [0x0251, 0x0251],
  [0x0261, 0x0261], [0x02c4, 0x02c4], [0x02c7, 0x02c7], [0x02c9, 0x02cb],
  [0x02cd, 0x02cd], [0x02d0, 0x02d0], [0x02d8, 0x02db], [0x02dd, 0x02dd],
  [0x02df, 0x02df], [0x0300, 0x036f], [0x0391, 0x03a1], [0x03a3, 0x03a9],
  [0x03b1, 0x03c1], [0x03c3, 0x03c9], [0x0401, 0x0401], [0x0410, 0x044f],
  [0x0451, 0x0451], [0x2010, 0x2010], [0x2013, 0x2016], [0x2018, 0x2019],
  [0x201c, 0x201d], [0x2020, 0x2022], [0x2024, 0x2027], [0x2030, 0x2030],
  [0x2032, 0x2033], [0x2035, 0x2035], [0x203b, 0x203b], [0x203e, 0x203e],
  [0x2074, 0x2074], [0x207f, 0x207f], [0x2081, 0x2084], [0x20ac, 0x20ac],
  [0x2103, 0x2103], [0x2105, 0x2105], [0x2109, 0x2109], [0x2113, 0x2113],
  [0x2116, 0x2116], [0x2121, 0x2122], [0x2126, 0x2126], [0x212b, 0x212b],
  [0x2153, 0x2154], [0x215b, 0x215e], [0x2160, 0x216b], [0x2170, 0x2179],
  [0x2189, 0x2189], [0x2190, 0x2199], [0x21b8, 0x21b9], [0x21d2, 0x21d2],
  [0x21d4, 0x21d4], [0x21e7, 0x21e7], [0x2200, 0x2200], [0x2202, 0x2203],
  [0x2207, 0x2208], [0x220b, 0x220b], [0x220f, 0x220f], [0x2211, 0x2211],
  [0x2215, 0x2215], [0x221a, 0x221a], [0x221d, 0x2220], [0x2223, 0x2223],
  [0x2225, 0x2225], [0x2227, 0x222c], [0x222e, 0x222e], [0x2234, 0x2237],
  [0x223c, 0x223d], [0x2248, 0x2248], [0x224c, 0x224c], [0x2252, 0x2252],
  [0x2260, 0x2261], [0x2264, 0x2267], [0x226a, 0x226b], [0x226e, 0x226f],
  [0x2282, 0x2283], [0x2286, 0x2287], [0x2295, 0x2295], [0x2299, 0x2299],
  [0x22a5, 0x22a5], [0x22bf, 0x22bf], [0x22da, 0x22db], [0x2305, 0x2306],
  [0x2312, 0x2312], [0x2318, 0x2318], [0x23b0, 0x23b1], [0x23b4, 0x23b5],
  [0x23b8, 0x23b9], [0x23d0, 0x23d0], [0x23dc, 0x23e1], [0x2460, 0x24fe],
  [0x2500, 0x254b],
  [0x2550, 0x2573], [0x2580, 0x258f], [0x2592, 0x2595], [0x25a0, 0x25a1],
  [0x25a3, 0x25a9], [0x25b2, 0x25b3], [0x25b6, 0x25b7], [0x25bc, 0x25bd],
  [0x25c0, 0x25c1], [0x25c6, 0x25c8], [0x25cb, 0x25cb], [0x25ce, 0x25d1],
  [0x25e2, 0x25e5], [0x25ef, 0x25ef], [0x2605, 0x2606], [0x2609, 0x2609],
  [0x260e, 0x260f], [0x261c, 0x261c], [0x261e, 0x261e], [0x2620, 0x2620],
  [0x2622, 0x2622], [0x2624, 0x2624], [0x2626, 0x2626], [0x2628, 0x2628],
  [0x262a, 0x262a], [0x262e, 0x262f], [0x2630, 0x2630], [0x2632, 0x2632],
  [0x2634, 0x2634], [0x2636, 0x2637], [0x263d, 0x2640], [0x2642, 0x2647],
  [0x2654, 0x2654], [0x2660, 0x2667], [0x2669, 0x266f], [0x2671, 0x267e],
  [0x2680, 0x2689], [0x2690, 0x2691], [0x2692, 0x269c], [0x269e, 0x26a0],
  [0x26a2, 0x26b1], [0x26b3, 0x26bc], [0x26bf, 0x26c3], [0x26c6, 0x26c7],
  [0x26c9, 0x26cc], [0x26cd, 0x26cd], [0x26cf, 0x26d3], [0x26d5, 0x26d9],
  [0x26db, 0x26e1], [0x26e3, 0x26e3], [0x26e8, 0x26e9], [0x26eb, 0x26f1],
  [0x26f4, 0x26f4], [0x26f6, 0x26f9], [0x26fb, 0x26fc], [0x26fe, 0x2704],
]

const OPENING_PUNCTUATION = new Set([
  '\u0028', '\u005b', '\u007b', '\uff08', '\uff3b', '\uff5b', '\u3008', '\u300a', '\u300c',
  '\u300e', '\u3010', '\u3014', '\u3016', '\u3018', '\u301a', '\u2018', '\u201c', '\u2039', '\u00ab',
])
const CLOSING_PUNCTUATION = new Set([
  '\u0029', '\u005d', '\u007d', '\uff09', '\uff3d', '\uff5d', '\u3009', '\u300b', '\u300d',
  '\u300f', '\u3011', '\u3015', '\u3017', '\u3019', '\u301b', '\u2019', '\u201d', '\u203a', '\u00bb',
  '\u002c', '\u002e', '\u003a', '\u003b', '\u0021', '\u003f', '\u0025',
  '\uff0c', '\u3002', '\u3001', '\uff1b', '\uff1a', '\uff01', '\uff1f', '\u2026',
])

const ASCII_WORD = /^[0-9A-Za-z_]$/
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u
const REGIONAL_INDICATOR_START = 0x1f1e6
const REGIONAL_INDICATOR_END = 0x1f1ff

let cachedSegmenter

function getSegmenter() {
  if (cachedSegmenter !== undefined) return cachedSegmenter
  cachedSegmenter = typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : null
  return cachedSegmenter
}

/**
 * Split text into user-perceived characters (grapheme clusters).
 *
 * @param {unknown} value
 * @param {{ segmenter?: Intl.Segmenter | null }} [options] `segmenter: null` forces the
 *   deterministic fallback (test hook; production always uses Intl.Segmenter).
 * @returns {string[]}
 */
export function graphemes(value, { segmenter } = {}) {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
  if (text.length === 0) return []
  const active = segmenter === undefined ? getSegmenter() : segmenter
  if (active === null || typeof active === 'undefined') return fallbackGraphemes(text)
  const out = []
  for (const part of active.segment(text)) out.push(part.segment)
  return out
}

function fallbackGraphemes(text) {
  const codePoints = Array.from(text)
  const out = []
  let joinNext = false
  for (const codePoint of codePoints) {
    const code = codePoint.codePointAt(0)
    const previous = out.length > 0 ? out[out.length - 1] : null
    const previousCode = previous === null ? -1 : previous.codePointAt(0)
    const joinsPrevious = previous !== null && (
      joinNext ||
      isZeroWidthCodePoint(code) ||
      code === 0xfe0f ||
      code === 0xfe0e ||
      code === 0x20e3 ||
      (code >= 0x1f3fb && code <= 0x1f3ff) ||
      (isRegionalIndicator(previousCode) && isRegionalIndicator(code) && previous.length === 2)
    )
    if (joinsPrevious) out[out.length - 1] = previous + codePoint
    else out.push(codePoint)
    joinNext = code === 0x200d
  }
  return out
}

/**
 * Width of one code point in columns: 0 for combining/format/control, 2 for
 * East_Asian_Width W/F and emoji presentation, else 1.
 *
 * @param {number} codePoint
 * @param {{ ambiguousWidth?: 1 | 2 }} [options]
 * @returns {number}
 */
export function codePointWidth(codePoint, { ambiguousWidth = 1 } = {}) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return 0
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0
  if (isZeroWidthCodePoint(codePoint)) return 0
  if (isWideCodePoint(codePoint)) return 2
  if (ambiguousWidth === 2 && inRanges(AMBIGUOUS_RANGES, codePoint)) return 2
  return 1
}

/**
 * Width of a grapheme cluster in columns.
 *
 * The cluster counts once: e + combining acute = 1, a ZWJ emoji family = 2,
 * a flag = 2, a keycap = 2, a text-presentation variation selector forces 1.
 *
 * @param {unknown} cluster
 * @param {{ ambiguousWidth?: 1 | 2 }} [options]
 * @returns {number}
 */
export function graphemeWidth(cluster, { ambiguousWidth = 1 } = {}) {
  const text = cluster === null || cluster === undefined ? '' : String(cluster)
  if (text.length === 0) return 0
  if (text.includes('\ufe0e')) return 1
  const codePoints = Array.from(text)
  if (codePoints.length === 0) return 0
  if (text.includes('\ufe0f') || text.includes('\u20e3')) return 2
  const first = codePoints[0].codePointAt(0)
  const second = codePoints.length > 1 ? codePoints[1].codePointAt(0) : -1
  if (isRegionalIndicator(first) && isRegionalIndicator(second)) return 2
  for (const codePoint of codePoints) {
    const width = codePointWidth(codePoint.codePointAt(0), { ambiguousWidth })
    if (width > 0) return width
  }
  return 0
}

/**
 * Width of a string in terminal columns. Escape sequences are ignored (they are
 * stripped before measuring); newlines and tabs are 0 columns.
 *
 * @param {unknown} value
 * @param {{ ambiguousWidth?: 1 | 2, segmenter?: Intl.Segmenter | null }} [options]
 * @returns {number}
 */
export function strWidth(value, { ambiguousWidth = 1, segmenter } = {}) {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
  if (text.length === 0) return 0
  const visible = stripTerminalSequences(text)
  if (visible.length === 0) return 0
  let width = 0
  for (const cluster of graphemes(visible, { segmenter })) width += graphemeWidth(cluster, { ambiguousWidth })
  return width
}

/** Alias kept for callers that prefer the longer name. */
export const stringWidth = strWidth

/**
 * Width of a single character/code point (0-2 columns).
 *
 * @param {string | number} value a code point or a string (first grapheme is measured)
 * @param {{ ambiguousWidth?: 1 | 2 }} [options]
 * @returns {number}
 */
export function charWidth(value, options = {}) {
  if (typeof value === 'number') return codePointWidth(value, options)
  if (typeof value !== 'string' || value.length === 0) return 0
  const [first] = graphemes(value)
  return first === undefined ? 0 : graphemeWidth(first, options)
}

/**
 * Expand tabs to spaces using the display column; terminals disagree about tab
 * stops, so wrapped output never contains a tab.
 *
 * @param {unknown} value
 * @param {number} [tabSize]
 * @returns {string}
 */
export function expandTabs(value, tabSize = 4) {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
  if (text.indexOf('\t') === -1) return text
  const size = Number.isInteger(tabSize) && tabSize > 0 ? tabSize : 4
  let out = ''
  let column = 0
  for (const cluster of graphemes(text)) {
    if (cluster === '\t') {
      const spaces = size - (column % size)
      out += ' '.repeat(spaces)
      column += spaces
      continue
    }
    out += cluster
    column += graphemeWidth(cluster)
  }
  return out
}

/**
 * Hard-wrap text to `width` columns. Returns display lines (no trailing newline).
 *
 * Explicit newlines are preserved (as line breaks); CRLF/CR are normalised. Tabs are
 * expanded. A single grapheme wider than the limit is emitted alone (column overflow
 * is unavoidable without corrupting the character).
 *
 * @param {unknown} value
 * @param {number} width
 * @param {{ ambiguousWidth?: 1 | 2, tabSize?: number, segmenter?: Intl.Segmenter | null }} [options]
 * @returns {string[]}
 */
export function wrap(value, width, { ambiguousWidth = 1, tabSize = 4, segmenter } = {}) {
  const limit = Math.max(1, Math.floor(Number.isFinite(width) ? width : DEFAULT_WIDTH))
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
  const normalized = text.replace(/\r\n?/g, '\n')
  const out = []
  for (const sourceLine of normalized.split('\n')) {
    const expanded = expandTabs(sourceLine, tabSize)
    if (expanded.length === 0) {
      out.push('')
      continue
    }
    for (const line of wrapLine(expanded, limit, { ambiguousWidth, segmenter })) out.push(line)
  }
  return out.length > 0 ? out : ['']
}

function wrapLine(line, limit, { ambiguousWidth, segmenter }) {
  const clusters = graphemes(line, { segmenter })
  if (clusters.length === 0) return ['']
  const widths = clusters.map((cluster) => graphemeWidth(cluster, { ambiguousWidth }))
  const lines = []
  let start = 0
  while (start < clusters.length) {
    let end = start
    let column = 0
    let lastBreak = -1
    while (end < clusters.length && column + widths[end] <= limit) {
      column += widths[end]
      end += 1
      if (end < clusters.length && breakAllowed(clusters, end)) lastBreak = end
    }
    if (end >= clusters.length) {
      lines.push(trimEndSpaces(clusters.slice(start).join('')))
      break
    }
    let cut = lastBreak
    if (cut <= start) cut = end > start ? end : start + 1
    lines.push(trimEndSpaces(clusters.slice(start, cut).join('')))
    start = cut
    while (start < clusters.length && isSpaceCluster(clusters[start])) start += 1
  }
  return lines.length > 0 ? lines : ['']
}

function breakAllowed(clusters, index) {
  if (index <= 0 || index >= clusters.length) return false
  const previous = clusters[index - 1]
  const next = clusters[index]
  if (OPENING_PUNCTUATION.has(previous)) return false
  if (CLOSING_PUNCTUATION.has(next)) return false
  if (isSpaceCluster(previous)) return true
  if (isSpaceCluster(next)) return false
  if (ASCII_WORD.test(previous) && ASCII_WORD.test(next)) return false
  return true
}

function isSpaceCluster(cluster) {
  return cluster === ' ' || cluster === '\t'
}

function trimEndSpaces(text) {
  return text.replace(/[ \t]+$/, '')
}

/**
 * Truncate to a column budget, appending an ellipsis when content is lost.
 *
 * @param {unknown} value
 * @param {number} maxWidth
 * @param {{ ellipsis?: string, ambiguousWidth?: 1 | 2, segmenter?: Intl.Segmenter | null }} [options]
 * @returns {string}
 */
export function truncateToWidth(value, maxWidth, { ellipsis = '\u2026', ambiguousWidth = 1, segmenter } = {}) {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
  const limit = Math.max(0, Math.floor(Number.isFinite(maxWidth) ? maxWidth : DEFAULT_WIDTH))
  if (limit === 0) return ''
  if (strWidth(text, { ambiguousWidth, segmenter }) <= limit) return text
  const markWidth = strWidth(ellipsis, { ambiguousWidth })
  if (markWidth >= limit) {
    const markClusters = graphemes(ellipsis, { segmenter })
    let out = ''
    let used = 0
    for (const cluster of markClusters) {
      const width = graphemeWidth(cluster, { ambiguousWidth })
      if (used + width > limit) break
      out += cluster
      used += width
    }
    return out
  }
  const budget = limit - markWidth
  let out = ''
  let used = 0
  for (const cluster of graphemes(text, { segmenter })) {
    const width = graphemeWidth(cluster, { ambiguousWidth })
    if (used + width > budget) break
    out += cluster
    used += width
  }
  return out + ellipsis
}

/**
 * Truncate in the middle, keeping the start and the end (paths, commands, digests).
 *
 * @param {unknown} value
 * @param {number} maxWidth
 * @param {{ ellipsis?: string, ambiguousWidth?: 1 | 2, segmenter?: Intl.Segmenter | null }} [options]
 * @returns {string}
 */
export function truncateMiddle(value, maxWidth, { ellipsis = '\u2026', ambiguousWidth = 1, segmenter } = {}) {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
  const limit = Math.max(0, Math.floor(Number.isFinite(maxWidth) ? maxWidth : DEFAULT_WIDTH))
  if (limit === 0) return ''
  if (strWidth(text, { ambiguousWidth, segmenter }) <= limit) return text
  const markWidth = strWidth(ellipsis, { ambiguousWidth })
  if (markWidth >= limit - 1) return truncateToWidth(text, limit, { ellipsis, ambiguousWidth, segmenter })
  const budget = limit - markWidth
  const headBudget = Math.ceil(budget / 2)
  const tailBudget = budget - headBudget
  const clusters = graphemes(text, { segmenter })
  let head = ''
  let used = 0
  for (const cluster of clusters) {
    const width = graphemeWidth(cluster, { ambiguousWidth })
    if (used + width > headBudget) break
    head += cluster
    used += width
  }
  let tail = ''
  used = 0
  for (let index = clusters.length - 1; index >= 0; index -= 1) {
    const cluster = clusters[index]
    const width = graphemeWidth(cluster, { ambiguousWidth })
    if (used + width > tailBudget) break
    tail = cluster + tail
    used += width
  }
  return head + ellipsis + tail
}

/**
 * Pad text to exactly `width` columns (no truncation: wider text is returned as is).
 *
 * @param {unknown} value
 * @param {number} width
 * @param {{ align?: 'left' | 'right' | 'center', padChar?: string, ambiguousWidth?: 1 | 2 }} [options]
 * @returns {string}
 */
export function padToWidth(value, width, { align = 'left', padChar = ' ', ambiguousWidth = 1 } = {}) {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
  const target = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0))
  const current = strWidth(text, { ambiguousWidth })
  if (current >= target) return text
  const fill = String(padChar === undefined || padChar === '' ? ' ' : padChar)
  let count = target - current
  let padding = ''
  while (count > 0) {
    padding += fill
    count -= Math.max(1, strWidth(fill, { ambiguousWidth }))
  }
  padding = truncateToWidth(padding, target - current, { ellipsis: ' ', ambiguousWidth })
  if (align === 'right') return padding + text
  if (align === 'center') {
    const left = Math.floor(strWidth(padding, { ambiguousWidth }) / 2)
    const leftPadding = truncateToWidth(padding, left, { ellipsis: ' ', ambiguousWidth })
    const rightPadding = truncateToWidth(padding, strWidth(padding) - strWidth(leftPadding), { ellipsis: ' ', ambiguousWidth })
    return leftPadding + text + rightPadding
  }
  return text + padding
}

/** Alias for padToWidth (research API name). */
export const pad = padToWidth

/**
 * Clamp a terminal column count to the shell's rendering range.
 *
 * @param {unknown} value
 * @param {{ min?: number, max?: number, fallback?: number }} [options]
 * @returns {number}
 */
export function clampColumns(value, { min = 40, max = 200, fallback = DEFAULT_WIDTH } = {}) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  const start = Number.isFinite(number) ? Math.floor(number) : fallback
  return Math.min(max, Math.max(min, start))
}

function isZeroWidthCodePoint(codePoint) {
  if (codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d || codePoint === 0x2060 || codePoint === 0xfeff) return true
  return ZERO_WIDTH.test(String.fromCodePoint(codePoint))
}

function isWideCodePoint(codePoint) {
  if (EMOJI_PRESENTATION.test(String.fromCodePoint(codePoint))) return true
  return inRanges(WIDE_RANGES, codePoint)
}

function isRegionalIndicator(codePoint) {
  return codePoint >= REGIONAL_INDICATOR_START && codePoint <= REGIONAL_INDICATOR_END
}

function inRanges(ranges, codePoint) {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [start, end] = ranges[middle]
    if (codePoint < start) high = middle - 1
    else if (codePoint > end) low = middle + 1
    else return true
  }
  return false
}

