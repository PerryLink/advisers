/**
 * Advisers 0.3.0 output kernel (pure functions, no terminal I/O).
 *
 * Modules:
 *   width.js     display width / graphemes / wrap / truncate / pad / columns
 *   sanitize.js  sanitizeDisplay / jsonSafe / display safety predicates
 *   color.js     --color / NO_COLOR precedence + 16-colour SGR whitelist
 *   policy.js    resolveOutputPolicy: TTY / plain / accessible / interactive
 *   render.js    renderStatus / renderResult / renderError / renderConfirm / renderSnapshot
 *   json.js      JSON purity helpers (stringifyJson / isJsonPure / assertJsonPure)
 *   text-file.js BOM-aware text/JSON reads + BOM-less atomic writes
 *
 * lib/text-safe.js holds the low-level console/log primitives (sanitizeConsoleText);
 * it is re-exported here for convenience. bin/advisers.js wiring lands in Wave 2; this
 * barrel adds no side effects and does not read process.argv/env.
 */
export * from './width.js'
export * from './sanitize.js'
export * from './color.js'
export * from './policy.js'
export * from './render.js'
export * from './json.js'
export * from './text-file.js'
export {
  sanitizeConsoleText,
  stripBom,
  stripTerminalSequences,
  stripBidiControls,
  stripControlChars,
  DEFAULT_CONSOLE_TEXT_MAX,
  TRUNCATION_MARK,
} from '../text-safe.js'

