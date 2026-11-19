/**
 * Output policy: TTY detection, plain/accessible modes and colour resolution.
 *
 * One policy object is computed at process start and passed to render* functions;
 * it decides every terminal capability question in one place:
 *
 *   plain          no SGR, no cursor control (CR, clear-line, hide cursor, alt-screen)
 *   accessible     plain + [状态] status lines + no timed refresh (screen readers)
 *   color          SGR allowed (see lib/tui/color.js for the precedence)
 *   cursorControl  CR / ESC[2K / cursor visibility sequences allowed
 *   statusRefresh  the status line may be rewritten in place (TTY, not accessible)
 *   interactive    stdin is a TTY, so a shell may prompt
 *
 * Precedence: --accessible and --plain force plain; otherwise non-TTY stdout or
 * TERM=dumb forces plain; colour still follows --color/NO_COLOR inside non-plain
 * mode. A non-TTY stdin means no prompt is possible (interactive=false) even when
 * stdout is a TTY.
 */
import { noColorEnv, readColorArg, resolveColorEnabled } from './color.js'

const TRUTHY_ENV = /^(1|true|yes|on)$/i
const FALSY_ENV = /^(0|false|no|off)$/i

/**
 * Environment flag: set and not empty/false.
 *
 * @param {Record<string, unknown> | undefined} env
 * @param {string} name
 * @returns {boolean}
 */
export function envFlag(env, name) {
  if (!env) return false
  const value = env[name]
  if (value === undefined || value === null) return false
  const text = String(value).trim()
  if (text === '') return false
  if (FALSY_ENV.test(text)) return false
  if (TRUTHY_ENV.test(text)) return true
  return true
}

/**
 * Resolve the output policy for one invocation.
 *
 * @param {{
 *   argv?: string[],
 *   env?: Record<string, unknown>,
 *   stdinIsTTY?: boolean,
 *   stdoutIsTTY?: boolean,
 *   stderrIsTTY?: boolean,
 * }} [options]
 * @returns {Readonly<{ mode: 'tty' | 'plain' | 'accessible', color: boolean, plain: boolean,
 *   accessible: boolean, cursorControl: boolean, statusRefresh: boolean,
 *   interactive: boolean, stdinIsTTY: boolean, stdoutIsTTY: boolean, stderrIsTTY: boolean,
 *   colorMode: 'auto' | 'always' | 'never', reason: string, colorReason: string }>}
 */
export function resolveOutputPolicy({ argv = [], env = process.env, stdinIsTTY = false, stdoutIsTTY = false, stderrIsTTY = false } = {}) {
  const args = Array.isArray(argv) ? argv : []
  const colorArg = readColorArg(args)
  if (colorArg.invalid) throw new RangeError('--color must be auto, always or never')
  const accessible = args.includes('--accessible') || envFlag(env, 'ADVISERS_ACCESSIBLE')
  const plainFlag = args.includes('--plain') || envFlag(env, 'ADVISERS_PLAIN')
  const hardPlain = accessible || plainFlag
  const term = typeof env?.TERM === 'string' ? env.TERM : ''
  const autoPlain = !stdoutIsTTY || term === 'dumb'
  let reason = 'tty'
  if (accessible) reason = 'accessible'
  else if (plainFlag) reason = '--plain'
  else if (!stdoutIsTTY) reason = 'stdout-not-tty'
  else if (term === 'dumb') reason = 'term-dumb'
  const colorMode = colorArg.found ? colorArg.mode : 'auto'
  let color = false
  let colorReason = 'plain'
  if (!hardPlain) {
    color = resolveColorEnabled({ mode: colorMode, env, stdoutIsTTY, term })
    if (colorMode === 'always') colorReason = 'forced-always'
    else if (colorMode === 'never') colorReason = 'forced-never'
    else if (noColorEnv(env)) colorReason = 'no-color-env'
    else if (term === 'dumb') colorReason = 'term-dumb'
    else if (!stdoutIsTTY) colorReason = 'stdout-not-tty'
    else colorReason = 'auto-tty'
  }
  // --plain/--accessible always mean "no ANSI at all"; auto-detection (non-TTY stdout,
  // TERM=dumb) disables colour in auto mode and always suppresses cursor control. An
  // explicit --color=always keeps its SGR even in auto-plain mode, but cursor control
  // stays off, so `plain` still describes the suppressed interactive features.
  const plain = hardPlain || autoPlain
  const cursorControl = stdoutIsTTY && !hardPlain && !autoPlain
  const statusRefresh = cursorControl && !accessible
  return Object.freeze({
    mode: accessible ? 'accessible' : plain ? 'plain' : 'tty',
    color,
    plain,
    accessible,
    cursorControl,
    statusRefresh,
    interactive: stdinIsTTY,
    stdinIsTTY,
    stdoutIsTTY,
    stderrIsTTY,
    colorMode,
    reason,
    colorReason,
    hardPlain,
    autoPlain,
  })
}

