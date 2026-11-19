/**
 * Opt-in 0.3.0 gate for the interactive TUI entry (`advisers tui`, no --once).
 *
 * 05-0.3.0-planning/26-0.3.0-ux-tui.md §6.1: in 0.3.0 the interactive entry
 * must add an isTTY guard — with stdin/stdout NOT a TTY it must not emit a
 * clear-screen/cursor sequence. This suite is opt-in (`--suite tui`) because
 * the bin wiring is owned by the TUI work line; the release gate runs it once
 * that wiring lands. Until then it is expected to be red and is reported as
 * such, not silently skipped.
 */
import { check, controlViolations, runCli } from '../lib/harness.mjs'
import { withSeededHome } from './_fixture.mjs'

export default [
  {
    id: 'det.tui.interactive-non-tty-plain',
    group: 'tui',
    title: 'interactive tui must not clear the screen when stdin is not a TTY',
    async run() {
      return withSeededHome('tui-interactive', async (workdir) => {
        const checks = []
        const run = runCli(workdir, ['tui'], { timeoutMs: 15000, index: 'tui-interactive' })
        check(checks, 'terminates-without-a-tty', () => {
          if (run.timedOut) throw new Error('tui waited for input on a closed stdin')
          if (run.status !== 0) throw new Error('exit ' + run.status)
        })
        check(checks, 'no-control-bytes', () => {
          const violations = controlViolations(run.stdout)
          if (violations.length) {
            throw new Error('non-TTY tui emitted ' + violations.join(',') + ' (clear-screen/cursor control must be TTY-only)')
          }
        })
        return { checks }
      })
    },
  },
]
