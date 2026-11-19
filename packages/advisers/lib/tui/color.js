/**
 * Colour policy and the 16-colour SGR whitelist (0.3.0 output kernel).
 *
 * Semantics, in priority order (documented in docs/TUI.md and tested):
 *
 *   1. --color=always|never          explicit flag wins over environment
 *   2. NO_COLOR (present, non-empty) disables colour in auto mode
 *   3. TERM=dumb / non-TTY stdout     disables colour in auto mode
 *   4. --plain / --accessible        disable colour and all cursor control
 *
 * Only the following SGR codes may ever be emitted (16-colour safe palette):
 *   1 bold, 2 dim, 22 reset bold/dim, 31 red, 32 green, 33 yellow, 39 reset fg.
 * No 256-colour, truecolour, background, reverse, blink, underline or OSC of any
 * kind. Colour never carries the only meaning: every line has a text prefix too.
 */

/** Accepted --color values. */
export const COLOR_MODES = Object.freeze(['auto', 'always', 'never'])

/** Named SGR codes the kernel may emit. */
export const SGR = Object.freeze({
  bold: 1,
  dim: 2,
  resetIntensity: 22,
  red: 31,
  green: 32,
  yellow: 33,
  resetForeground: 39,
})

/** The complete SGR allowlist. Tests extract every emitted code and compare. */
export const ALLOWED_SGR_CODES = Object.freeze([1, 2, 22, 31, 32, 33, 39])

const SGR_PATTERN = /\u001b\[(\d+(?:;\d+)*)m/g

/**
 * Parse a --color value.
 *
 * @param {unknown} value
 * @returns {'auto' | 'always' | 'never' | null} null when the value is not supported
 */
export function parseColorMode(value) {
  if (typeof value !== 'string') return null
  const mode = value.trim().toLowerCase()
  return COLOR_MODES.includes(mode) ? mode : null
}

/**
 * Find --color in an argv-style array.
 *
 * Supports both `--color=never` and `--color never`.
 *
 * @param {unknown} argv
 * @returns {{ found: boolean, mode: 'auto' | 'always' | 'never' | null, invalid: boolean }}
 */
export function readColorArg(argv) {
  if (!Array.isArray(argv)) return { found: false, mode: null, invalid: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (typeof argument !== 'string') continue
    if (argument === '--color') {
      const mode = parseColorMode(argv[index + 1])
      return { found: true, mode, invalid: mode === null }
    }
    if (argument.startsWith('--color=')) {
      const mode = parseColorMode(argument.slice('--color='.length))
      return { found: true, mode, invalid: mode === null }
    }
  }
  return { found: false, mode: null, invalid: false }
}

/**
 * NO_COLOR convention: present and not an empty string disables colour.
 *
 * @param {NodeJS.ProcessEnv | Record<string, unknown>} [env]
 * @returns {boolean}
 */
export function noColorEnv(env = process.env) {
  return Boolean(env) && typeof env.NO_COLOR === 'string' && env.NO_COLOR !== ''
}

/**
 * Resolve whether SGR colour may be emitted.
 *
 * @param {{ mode?: 'auto' | 'always' | 'never', env?: Record<string, unknown>, stdoutIsTTY?: boolean, term?: string }} [options]
 * @returns {boolean}
 */
export function resolveColorEnabled({ mode = 'auto', env = process.env, stdoutIsTTY = false, term } = {}) {
  if (mode === 'always') return true
  if (mode === 'never') return false
  const terminal = term === undefined ? env?.TERM : term
  if (!stdoutIsTTY) return false
  if (terminal === 'dumb') return false
  if (noColorEnv(env)) return false
  return true
}

/**
 * Wrap text in whitelisted SGR codes.
 *
 * @param {unknown} text
 * @param {string | string[] | null | undefined} style one or more keys of SGR
 * @param {{ enabled?: boolean }} [options]
 * @returns {string}
 */
export function styleText(text, style, { enabled = true } = {}) {
  const value = text === null || text === undefined ? '' : String(text)
  if (!enabled || style === null || style === undefined) return value
  const names = Array.isArray(style) ? style : [style]
  const codes = []
  for (const name of names) {
    if (typeof name !== 'string') continue
    const code = SGR[name]
    if (typeof code === 'number') codes.push(code)
  }
  if (codes.length === 0) return value
  const open = codes.map((code) => `\u001b[${code}m`).join('')
  const close = [...codes].reverse().map((code) => `\u001b[${resetCodeFor(code)}m`).join('')
  return open + value + close
}

function resetCodeFor(code) {
  if (code === SGR.dim || code === SGR.bold) return SGR.resetIntensity
  return SGR.resetForeground
}

/**
 * Remove only SGR colour sequences (other control characters are left for sanitisation).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stripSgr(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(SGR_PATTERN, '')
}

/**
 * Extract every SGR code present in a string (test/audit helper).
 *
 * @param {unknown} value
 * @returns {number[]}
 */
export function sgrCodes(value) {
  if (value === null || value === undefined) return []
  const text = String(value)
  const codes = []
  for (const match of text.matchAll(SGR_PATTERN)) {
    for (const part of match[1].split(';')) codes.push(Number.parseInt(part, 10))
  }
  return codes
}

/**
 * True when every SGR sequence in the string uses a whitelisted code.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasOnlyWhitelistedSgr(value) {
  return sgrCodes(value).every((code) => ALLOWED_SGR_CODES.includes(code))
}

