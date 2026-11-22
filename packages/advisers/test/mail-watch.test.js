/**
 * 0.4.x: deterministic unit tests for lib/mail-watch.js.
 *
 * The loop is exercised with an immediate-resolve fake sleep (`sleep` hook) so
 * no test waits on a real timer except the one abort-during-wait test, which
 * uses a 10ms abort against the real 1s minimum interval. Nothing here touches
 * the network, credentials, the ledger or ~/.advisers: mail-watch.js is pure
 * loop logic.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAIL_WATCH_DEFAULT_INTERVAL_MS,
  MAIL_WATCH_HISTORY_LIMIT,
  MAIL_WATCH_MAX_INTERVAL_MS,
  MAIL_WATCH_MIN_INTERVAL_MS,
  MAIL_WATCH_RETRY_BASE_MS,
  MAIL_WATCH_RETRY_MAX_MS,
  MAIL_WATCH_STOPPED,
  runMailWatch,
} from '../lib/mail-watch.js'

/** Stepped fake clock: every read advances by `step` ms (deterministic durations). */
function steppedClock(start = Date.UTC(2026, 10, 22, 0, 0, 0), step = 25) {
  let current = start
  return () => {
    const value = current
    current += step
    return value
  }
}

/** Immediate-resolve fake sleep that records the requested delays instead of waiting. */
function fakeSleep() {
  const calls = []
  const sleep = (ms, signal) => {
    calls.push({ ms, signal })
    return Promise.resolve()
  }
  return { sleep, calls }
}

test('mail watch: runs syncOnce maxRuns times and stops with max-runs without an extra wait', async () => {
  const { sleep, calls } = fakeSleep()
  const seenArgs = []
  const observed = []
  const summary = await runMailWatch({
    syncOnce: async (...args) => {
      seenArgs.push(args)
      return { fetched: seenArgs.length }
    },
    intervalMs: 5000,
    maxRuns: 2,
    sleep,
    now: steppedClock(),
    onResult: (record, counts) => { observed.push({ record, counts }) },
  })
  assert.equal(summary.runs, 2)
  assert.equal(summary.success, 2)
  assert.equal(summary.errors, 0)
  assert.equal(summary.consecutiveErrors, 0)
  assert.equal(summary.stopped, 'max-runs')
  assert.equal(summary.stopped, MAIL_WATCH_STOPPED.MAX_RUNS)
  assert.equal(calls.length, 1, 'only the wait between the two rounds; the last allowed round is not followed by one')
  assert.equal(calls[0].ms, 5000)
  assert.deepEqual(seenArgs, [[], []], 'syncOnce is called with no arguments')
  assert.deepEqual(summary.history.map((entry) => entry.run), [1, 2])
  assert.equal(summary.history.length, 2)
  assert.equal(summary.last.run, 2)
  assert.equal(summary.last.ok, true)
  assert.deepEqual(summary.last.result, { fetched: 2 })
  assert.equal(summary.maxRuns, 2)
  assert.equal(summary.intervalMs, 5000)
  assert.equal(summary.callbackErrors, 0)
  assert.equal(observed.length, 2)
  assert.deepEqual(observed[0].counts, { runs: 1, success: 1, errors: 0, consecutiveErrors: 0 })
  assert.equal(observed[1].record.run, 2)
  assert.equal(summary.history[0].nextDelayMs, 5000)
})

test('mail watch: waits intervalMs between successful rounds and defaults to five minutes', async () => {
  const { sleep, calls } = fakeSleep()
  const controller = new AbortController()
  const summary = await runMailWatch({
    syncOnce: async () => ({ ok: true }),
    maxRuns: 3,
    signal: controller.signal,
    sleep,
    now: steppedClock(),
  })
  assert.equal(summary.runs, 3)
  assert.deepEqual(calls.map((call) => call.ms), [MAIL_WATCH_DEFAULT_INTERVAL_MS, MAIL_WATCH_DEFAULT_INTERVAL_MS])
  assert.equal(MAIL_WATCH_DEFAULT_INTERVAL_MS, 300_000)
  assert.equal(calls[0].signal, controller.signal, 'the signal is handed to the wait')
  assert.equal(summary.stopped, 'max-runs')
})

test('mail watch: records a failed round, keeps polling and backs off exponentially', async () => {
  const { sleep, calls } = fakeSleep()
  let attempt = 0
  const summary = await runMailWatch({
    syncOnce: async () => {
      attempt += 1
      if (attempt <= 3) {
        const error = new Error('E_IMAP_TIMEOUT: connect timed out')
        error.code = 'E_IMAP_TIMEOUT'
        throw error
      }
      return { inserted: attempt }
    },
    intervalMs: 60_000,
    maxRuns: 4,
    sleep,
    now: steppedClock(),
  })
  assert.equal(summary.runs, 4)
  assert.equal(summary.success, 1)
  assert.equal(summary.errors, 3)
  assert.equal(summary.consecutiveErrors, 0, 'a success resets the failure streak')
  assert.equal(summary.stopped, 'max-runs')
  assert.deepEqual(calls.map((call) => call.ms), [5000, 10000, 20000])
  assert.equal(calls[0].ms, MAIL_WATCH_RETRY_BASE_MS)
  assert.deepEqual(summary.history[0].error, {
    name: 'Error',
    message: 'E_IMAP_TIMEOUT: connect timed out',
    code: 'E_IMAP_TIMEOUT',
  })
  assert.equal(summary.history[0].ok, false)
  assert.equal(summary.history[0].backoffMs, 5000)
  assert.equal(summary.history[0].nextDelayMs, 5000)
  assert.equal('result' in summary.history[0], false, 'a failed round has no result field')
  assert.equal(summary.history[3].ok, true)
  assert.equal(summary.history[3].backoffMs, 0)
  assert.equal(summary.history[3].nextDelayMs, 60_000)
  assert.equal(summary.last.ok, true)
  assert.deepEqual(summary.last.result, { inserted: 4 })
})

test('mail watch: caps the retry backoff and reports the failure streak', async () => {
  const { sleep, calls } = fakeSleep()
  const summary = await runMailWatch({
    syncOnce: async () => { throw new Error('boom') },
    maxRuns: 9,
    sleep,
    now: steppedClock(),
  })
  const delays = calls.map((call) => call.ms)
  assert.deepEqual(delays.slice(0, 6), [5000, 10000, 20000, 40000, 80000, 160000])
  assert.deepEqual(delays.slice(6), [MAIL_WATCH_RETRY_MAX_MS, MAIL_WATCH_RETRY_MAX_MS])
  assert.equal(MAIL_WATCH_RETRY_MAX_MS, 300_000)
  assert.equal(summary.errors, 9)
  assert.equal(summary.consecutiveErrors, 9)
  assert.equal(summary.success, 0)
  assert.equal(summary.last.error.message, 'boom')
  assert.equal(summary.last.backoffMs, MAIL_WATCH_RETRY_MAX_MS)
})

test('mail watch: an already-aborted signal stops before the first round', async () => {
  const controller = new AbortController()
  controller.abort()
  const { sleep, calls } = fakeSleep()
  let invoked = 0
  const summary = await runMailWatch({
    syncOnce: async () => { invoked += 1; return {} },
    signal: controller.signal,
    sleep,
    now: steppedClock(),
  })
  assert.equal(invoked, 0)
  assert.equal(summary.runs, 0)
  assert.equal(summary.last, null)
  assert.equal(summary.stopped, 'aborted')
  assert.equal(summary.stopped, MAIL_WATCH_STOPPED.ABORTED)
  assert.equal(calls.length, 0)
  assert.equal(summary.nextDelayMs, null)
  assert.equal(summary.maxRuns, null, 'unlimited maxRuns is JSON-safe null')
})

test('mail watch: an abort from onResult stops after the current round without waiting', async () => {
  const controller = new AbortController()
  const { sleep, calls } = fakeSleep()
  let invoked = 0
  const summary = await runMailWatch({
    syncOnce: async () => { invoked += 1; return { invoked } },
    intervalMs: 1000,
    signal: controller.signal,
    sleep,
    now: steppedClock(),
    onResult: (record) => { if (record.run === 1) controller.abort() },
  })
  assert.equal(invoked, 1)
  assert.equal(summary.runs, 1)
  assert.equal(summary.stopped, 'aborted')
  assert.equal(summary.last.ok, true)
  assert.equal(calls.length, 0)
})

test('mail watch: an abort during the wait wakes the loop promptly (real timer)', async () => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10)
  const started = Date.now()
  let summary
  try {
    summary = await runMailWatch({
      syncOnce: async () => ({ ok: true }),
      intervalMs: MAIL_WATCH_MIN_INTERVAL_MS,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  const elapsed = Date.now() - started
  assert.equal(summary.runs, 1)
  assert.equal(summary.stopped, 'aborted')
  assert.ok(elapsed < MAIL_WATCH_MIN_INTERVAL_MS, 'abort resolved the pending wait (' + elapsed + 'ms)')
})

test('mail watch: keeps a bounded history while counting every run', async () => {
  const { sleep } = fakeSleep()
  const runs = MAIL_WATCH_HISTORY_LIMIT + 5
  const summary = await runMailWatch({
    syncOnce: async () => ({}),
    maxRuns: runs,
    intervalMs: 1000,
    sleep,
    now: steppedClock(),
  })
  assert.equal(summary.runs, runs)
  assert.equal(summary.history.length, MAIL_WATCH_HISTORY_LIMIT)
  assert.equal(summary.historyDropped, 5)
  assert.equal(summary.history[0].run, 6)
  assert.equal(summary.history.at(-1).run, runs)
})

test('mail watch: a throwing onResult is counted and does not stop the watch', async () => {
  const { sleep } = fakeSleep()
  const summary = await runMailWatch({
    syncOnce: async () => ({ ok: true }),
    maxRuns: 3,
    intervalMs: 1000,
    sleep,
    now: steppedClock(),
    onResult: () => { throw new Error('stdout closed') },
  })
  assert.equal(summary.runs, 3)
  assert.equal(summary.callbackErrors, 3)
  assert.equal(summary.stopped, 'max-runs')
})

test('mail watch: error summaries are single-line printable text', async () => {
  const { sleep } = fakeSleep()
  const summary = await runMailWatch({
    syncOnce: async () => { throw new Error('bad \u001b[31mred\u001b[0m' + String.fromCharCode(10) + 'line2') },
    maxRuns: 1,
    sleep,
    now: steppedClock(),
  })
  assert.equal(summary.last.error.message, 'bad red line2')
  assert.equal(summary.last.error.message.includes('\u001b'), false)
  assert.equal(summary.last.error.message.includes(String.fromCharCode(10)), false)
})

test('mail watch: a non-Error rejection is still recorded', async () => {
  const { sleep } = fakeSleep()
  const summary = await runMailWatch({
    syncOnce: async () => { throw 'quota exceeded' },
    maxRuns: 1,
    sleep,
    now: steppedClock(),
  })
  assert.deepEqual(summary.last.error, { name: 'Error', message: 'quota exceeded' })
})

test('mail watch: validates intervalMs', async () => {
  const invalid = [0, -1, 999, 1000.5, Number.NaN, Infinity, '5000', null]
  for (const intervalMs of invalid) {
    await assert.rejects(
      runMailWatch({ syncOnce: async () => ({}), intervalMs, maxRuns: 1, sleep: fakeSleep().sleep }),
      (error) => {
        assert.ok(error instanceof RangeError, 'RangeError for intervalMs=' + String(intervalMs))
        assert.equal(error.code, 'E_USAGE')
        assert.match(error.message, /intervalMs/)
        return true
      },
    )
  }
  const { sleep, calls } = fakeSleep()
  for (const intervalMs of [MAIL_WATCH_MIN_INTERVAL_MS, MAIL_WATCH_MAX_INTERVAL_MS]) {
    const summary = await runMailWatch({
      syncOnce: async () => ({}),
      maxRuns: 2,
      intervalMs,
      sleep,
      now: steppedClock(),
    })
    assert.equal(summary.intervalMs, intervalMs)
  }
  assert.deepEqual(calls.map((call) => call.ms), [MAIL_WATCH_MIN_INTERVAL_MS, MAIL_WATCH_MAX_INTERVAL_MS])
})

test('mail watch: validates maxRuns and accepts Infinity with an abort', async () => {
  const invalid = [0, -1, 1.5, Number.NaN, '2', null]
  for (const maxRuns of invalid) {
    await assert.rejects(
      runMailWatch({ syncOnce: async () => ({}), maxRuns, sleep: fakeSleep().sleep }),
      (error) => {
        assert.ok(error instanceof RangeError, 'RangeError for maxRuns=' + String(maxRuns))
        assert.equal(error.code, 'E_USAGE')
        assert.match(error.message, /maxRuns/)
        return true
      },
    )
  }
  const controller = new AbortController()
  const { sleep } = fakeSleep()
  const summary = await runMailWatch({
    syncOnce: async () => ({}),
    maxRuns: Infinity,
    signal: controller.signal,
    sleep,
    now: steppedClock(),
    onResult: () => { controller.abort() },
  })
  assert.equal(summary.runs, 1)
  assert.equal(summary.stopped, 'aborted')
  assert.equal(summary.maxRuns, null)
})

test('mail watch: rejects a missing syncOnce, non-callable hooks and a non-AbortSignal signal', async () => {
  await assert.rejects(runMailWatch(), (error) => {
    assert.ok(error instanceof TypeError)
    assert.match(error.message, /syncOnce/)
    return true
  })
  await assert.rejects(runMailWatch(null), (error) => {
    assert.ok(error instanceof TypeError)
    return true
  })
  await assert.rejects(runMailWatch({ syncOnce: async () => ({}), signal: {} }), (error) => {
    assert.ok(error instanceof TypeError)
    assert.match(error.message, /signal/)
    return true
  })
  await assert.rejects(runMailWatch({ syncOnce: async () => ({}), onResult: 'nope' }), (error) => {
    assert.ok(error instanceof TypeError)
    assert.match(error.message, /onResult/)
    return true
  })
  await assert.rejects(runMailWatch({ syncOnce: async () => ({}), sleep: 'nope' }), (error) => {
    assert.ok(error instanceof TypeError)
    assert.match(error.message, /sleep/)
    return true
  })
  await assert.rejects(runMailWatch({ syncOnce: async () => ({}), now: 42 }), (error) => {
    assert.ok(error instanceof TypeError)
    assert.match(error.message, /now/)
    return true
  })
})

test('mail watch: the summary serialises to JSON for --json callers', async () => {
  const { sleep } = fakeSleep()
  const summary = await runMailWatch({
    syncOnce: async () => ({ inserted: 1 }),
    maxRuns: 2,
    intervalMs: 1000,
    sleep,
    now: steppedClock(),
  })
  const parsed = JSON.parse(JSON.stringify(summary))
  assert.equal(parsed.runs, 2)
  assert.equal(parsed.maxRuns, 2)
  assert.equal(parsed.stopped, 'max-runs')
  assert.equal(parsed.history.length, 2)
  assert.equal(typeof parsed.startedAt, 'string')
  assert.equal(typeof parsed.finishedAt, 'string')
  assert.equal(typeof parsed.durationMs, 'number')
})
