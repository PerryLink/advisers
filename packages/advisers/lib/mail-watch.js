/**
 * 0.4.x: `mail sync --watch` — interruptible polling loop (library layer).
 *
 * `advisers mail sync --watch` is a foreground, Ctrl+C-interruptible poller:
 * run one sync pass, record the outcome, wait, repeat until the operator stops
 * it. The CLI wiring (arg parsing, SIGINT, human/JSON lines, lock handling) is
 * a separate integration task; this module owns only the loop so it can be
 * tested with a fake clock, no network and no console.
 *
 * Contract:
 * - `syncOnce()` is called with no arguments once per round; the caller closes
 *   over the account list, the store and the credentials. A thrown error or a
 *   rejected promise is recorded and the loop continues: one failing mailbox
 *   must never stop the watch;
 * - `signal` (AbortSignal) stops the loop promptly. The default wait resolves
 *   on abort, and an in-flight round is allowed to finish before the summary is
 *   returned;
 * - `onResult(record, counts)` is a pure observer called after every round. If
 *   it throws, the watch keeps going and counts `callbackErrors`;
 * - `stopped` is `'aborted'` after an abort and `'max-runs'` once `maxRuns`
 *   rounds have been attempted; with the default `Infinity` only an abort
 *   stops the loop;
 * - failures back off exponentially (5s, 10s, 20s ... capped at 5 min) and a
 *   successful round resets the streak; the normal wait is `intervalMs`
 *   (default 5 min);
 * - no I/O: this module never reads credentials, never opens the ledger and
 *   never prints. Callers own stdout/stderr, the summary rendering and the
 *   operator-facing lines.
 *
 * The returned summary is JSON-ready: error text is collapsed to one printable
 * line (no ANSI/control characters) and `maxRuns` is `null` when unlimited, so
 * a `--json` caller can serialise it as-is.
 */
import { sanitizeConsoleText } from './text-safe.js'

/** Default poll interval: 5 minutes. */
export const MAIL_WATCH_DEFAULT_INTERVAL_MS = 300_000
/** Smallest accepted poll interval: 1 second (protects servers from busy loops). */
export const MAIL_WATCH_MIN_INTERVAL_MS = 1_000
/** Largest accepted poll interval: 24 hours. */
export const MAIL_WATCH_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000
/** First retry delay after a failed round; doubles per consecutive failure. */
export const MAIL_WATCH_RETRY_BASE_MS = 5_000
/** Cap for the exponential retry backoff. */
export const MAIL_WATCH_RETRY_MAX_MS = 5 * 60 * 1000
/** Attempt records kept in `history`; older ones are counted, not stored. */
export const MAIL_WATCH_HISTORY_LIMIT = 20
/** Maximum characters of an error message kept in the summary. */
export const MAIL_WATCH_ERROR_MAX = 500
/** Why the loop stopped (`summary.stopped`). */
export const MAIL_WATCH_STOPPED = Object.freeze({ ABORTED: 'aborted', MAX_RUNS: 'max-runs' })

/** Usage error carrying the registered CLI code; never a bare E_* literal. */
function usageError(message) {
  const error = new RangeError('mail watch: ' + message)
  error.code = 'E_USAGE'
  return error
}

function typeError(message) {
  return new TypeError('mail watch: ' + message)
}

function normalizeInterval(value) {
  if (value === undefined) return MAIL_WATCH_DEFAULT_INTERVAL_MS
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw usageError('intervalMs must be an integer number of milliseconds')
  }
  if (value < MAIL_WATCH_MIN_INTERVAL_MS || value > MAIL_WATCH_MAX_INTERVAL_MS) {
    throw usageError('intervalMs must be within ' + MAIL_WATCH_MIN_INTERVAL_MS + '..' + MAIL_WATCH_MAX_INTERVAL_MS + ' ms (1s..24h)')
  }
  return value
}

function normalizeMaxRuns(value) {
  if (value === undefined) return Infinity
  if (value === Infinity) return Infinity
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isInteger(value)) {
    throw usageError('maxRuns must be Infinity or a positive integer')
  }
  if (value < 1) throw usageError('maxRuns must be at least 1')
  return value
}

function normalizeSignal(value) {
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'object' ||
    typeof value.aborted !== 'boolean' ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw typeError('signal must be an AbortSignal')
  }
  return value
}

function normalizeOptionalFunction(value, name, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'function') throw typeError(name + ' must be a function')
  return value
}

function normalizeClock(value) {
  if (value === undefined || value === null) return Date.now
  if (typeof value !== 'function') throw typeError('now must be a function returning epoch milliseconds')
  return function readNow() {
    const ms = value()
    if (typeof ms !== 'number' || !Number.isFinite(ms)) throw typeError('now() must return finite epoch milliseconds')
    return ms
  }
}

/**
 * Abort-aware wait used by the loop. The timer is deliberately ref'd: a
 * foreground `--watch` must keep the process alive while it sleeps. The abort
 * listener is removed on both the timer and the abort path so a long watch
 * cannot accumulate listeners on the signal.
 */
function defaultSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let timer = null
    function finish() {
      if (timer !== null) { clearTimeout(timer); timer = null }
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, ms)
    if (signal) signal.addEventListener('abort', finish, { once: true })
  })
}

/** Exponential retry delay for `consecutiveErrors` consecutive failures. */
function retryDelay(consecutiveErrors) {
  if (consecutiveErrors <= 0) return 0
  const exponent = Math.min(consecutiveErrors - 1, 30)
  return Math.min(MAIL_WATCH_RETRY_MAX_MS, MAIL_WATCH_RETRY_BASE_MS * 2 ** exponent)
}

/**
 * One printable, JSON-safe description of a failed round. The message is
 * sanitised because a sync implementation may surface remote IMAP/server text;
 * no stdout/stderr write happens here, this is only what the summary carries.
 */
function summarizeError(error) {
  const value = error === null || error === undefined ? new Error('syncOnce failed without an error value') : error
  const isObject = typeof value === 'object'
  const rawMessage = isObject ? value.message : String(value)
  const summary = {
    name: isObject && typeof value.name === 'string' && value.name ? value.name : 'Error',
    message: sanitizeConsoleText(rawMessage === undefined || rawMessage === null ? String(value) : rawMessage, { max: MAIL_WATCH_ERROR_MAX }),
  }
  if (isObject && typeof value.code === 'string' && value.code) summary.code = value.code
  return summary
}

function pushHistory(state, record) {
  state.history.push(record)
  while (state.history.length > MAIL_WATCH_HISTORY_LIMIT) {
    state.history.shift()
    state.historyDropped += 1
  }
}

function buildSummary(state, stopped, finishedAtMs) {
  return {
    runs: state.runs,
    success: state.success,
    errors: state.errors,
    consecutiveErrors: state.consecutiveErrors,
    stopped,
    last: state.last,
    history: state.history.slice(),
    historyDropped: state.historyDropped,
    callbackErrors: state.callbackErrors,
    intervalMs: state.intervalMs,
    maxRuns: Number.isFinite(state.maxRuns) ? state.maxRuns : null,
    nextDelayMs: state.nextDelayMs,
    backoffMs: state.backoffMs,
    startedAt: new Date(state.startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - state.startedAtMs),
  }
}

/**
 * Run the interruptible mail-watch loop until it is aborted or reaches
 * `maxRuns`. See the module header for the full contract.
 *
 * @param {object} options
 * @param {() => Promise<unknown>} options.syncOnce called with no arguments once
 *   per round; the caller closes over accounts/store/credentials.
 * @param {number} [options.intervalMs=300000] wait between successful rounds (1s..24h).
 * @param {number|Infinity} [options.maxRuns=Infinity] attempt cap (tests / one-shot).
 * @param {AbortSignal|null} [options.signal] stops the loop promptly on abort.
 * @param {(record: object, counts: object) => (void|Promise<void>)} [options.onResult]
 *   per-round observer; a throw is counted in `callbackErrors` and does not stop the loop.
 * @param {(ms: number, signal: AbortSignal|null) => Promise<void>} [options.sleep]
 *   test/embedding hook; defaults to an abort-aware setTimeout.
 * @param {() => number} [options.now] test/embedding clock (epoch milliseconds).
 * @returns {Promise<object>} JSON-ready summary: `runs`, `success`, `errors`,
 *   `consecutiveErrors`, `stopped` ('aborted'|'max-runs'), `last`, `history`,
 *   `historyDropped`, `callbackErrors`, `intervalMs`, `maxRuns`, `nextDelayMs`,
 *   `backoffMs`, `startedAt`, `finishedAt`, `durationMs`.
 */
export async function runMailWatch(options = {}) {
  if (options === null || typeof options !== 'object') throw typeError('options must be an object')
  const syncOnce = options.syncOnce
  if (typeof syncOnce !== 'function') throw typeError('syncOnce must be a function returning a promise')
  const intervalMs = normalizeInterval(options.intervalMs)
  const maxRuns = normalizeMaxRuns(options.maxRuns)
  const signal = normalizeSignal(options.signal)
  const onResult = normalizeOptionalFunction(options.onResult, 'onResult', null)
  const sleep = normalizeOptionalFunction(options.sleep, 'sleep', defaultSleep)
  const now = normalizeClock(options.now)
  const state = {
    runs: 0,
    success: 0,
    errors: 0,
    consecutiveErrors: 0,
    callbackErrors: 0,
    last: null,
    history: [],
    historyDropped: 0,
    intervalMs,
    maxRuns,
    nextDelayMs: null,
    backoffMs: 0,
    startedAtMs: now(),
  }
  let stopped = null
  while (stopped === null) {
    if (signal?.aborted) { stopped = MAIL_WATCH_STOPPED.ABORTED; break }
    if (state.runs >= maxRuns) { stopped = MAIL_WATCH_STOPPED.MAX_RUNS; break }
    const startedAtMs = now()
    let result
    let error = null
    try {
      result = await syncOnce()
    } catch (caught) {
      error = caught
    }
    const durationMs = Math.max(0, now() - startedAtMs)
    const ok = error === null
    state.runs += 1
    if (ok) {
      state.success += 1
      state.consecutiveErrors = 0
      state.backoffMs = 0
    } else {
      state.errors += 1
      state.consecutiveErrors += 1
      state.backoffMs = retryDelay(state.consecutiveErrors)
    }
    state.nextDelayMs = ok ? intervalMs : state.backoffMs
    const record = {
      run: state.runs,
      ok,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs,
      nextDelayMs: state.nextDelayMs,
      backoffMs: state.backoffMs,
    }
    if (ok) record.result = result
    else record.error = summarizeError(error)
    state.last = record
    pushHistory(state, record)
    if (onResult) {
      const counts = {
        runs: state.runs,
        success: state.success,
        errors: state.errors,
        consecutiveErrors: state.consecutiveErrors,
      }
      try {
        await onResult(record, counts)
      } catch {
        state.callbackErrors += 1
      }
    }
    if (signal?.aborted) { stopped = MAIL_WATCH_STOPPED.ABORTED; break }
    if (state.runs >= maxRuns) { stopped = MAIL_WATCH_STOPPED.MAX_RUNS; break }
    await sleep(state.nextDelayMs, signal)
  }
  return buildSummary(state, stopped, now())
}
