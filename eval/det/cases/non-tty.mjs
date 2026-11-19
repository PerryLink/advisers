/**
 * Non-TTY output gate.
 *
 * CI runs everything behind pipes, so stdout/stderr must be byte-clean there:
 * no ANSI escapes, no carriage returns, no cursor/clear-screen controls and no
 * decoding damage (U+FFFD). Output goes to stdout; diagnostics to stderr.
 * `tui --once` is the documented non-interactive snapshot and must stay plain.
 */
import { check, controlViolations, runCli } from '../lib/harness.mjs'
import { GOLDEN_NOW } from '../fixtures/morning-ledger.mjs'
import { withSeededHome } from './_fixture.mjs'

/** [label, args, expectedStatus] for human-readable commands. */
const HUMAN_COMMANDS = [
  ['no-args', [], 0],
  ['help', ['--help'], 0],
  ['status', ['status'], 0],
  ['today', ['today'], 0],
  ['agenda', ['agenda', '--now', GOLDEN_NOW], 0],
  ['morning', ['morning', '--now', GOLDEN_NOW], 0],
  ['commit-ls', ['commit', 'ls'], 0],
  ['who', ['who'], 0],
  ['privacy', ['privacy'], 0],
  ['tui-once', ['tui', '--once'], 0],
]

function hasReplacementCharacter(text) {
  return text.includes('\uFFFD')
}

export default [
  {
    id: 'det.tty.plain-output-matrix',
    group: 'tty',
    title: 'human-readable commands write clean plain text when stdout is not a TTY',
    async run() {
      return withSeededHome('tty', async (workdir) => {
        const checks = []
        for (const [label, args, expectedStatus] of HUMAN_COMMANDS) {
          const run = runCli(workdir, args, { index: 'tty-' + label })
          check(checks, label + '.exit-' + expectedStatus, () => {
            if (run.timedOut) throw new Error('timed out waiting for input')
            if (run.status !== expectedStatus) throw new Error('exit ' + run.status + ': ' + run.stderr.slice(0, 200))
          })
          check(checks, label + '.no-control-bytes', () => {
            const violations = [...controlViolations(run.stdout), ...controlViolations(run.stderr)]
            if (violations.length) throw new Error('control characters: ' + violations.join(','))
          })
          check(checks, label + '.utf8-clean', () => {
            if (hasReplacementCharacter(run.stdout) || hasReplacementCharacter(run.stderr)) throw new Error('output contains U+FFFD')
          })
          check(checks, label + '.ends-with-newline', () => {
            if (run.stdout.length > 0 && !run.stdout.endsWith('\n')) throw new Error('stdout does not end with a newline')
          })
        }
        const help = runCli(workdir, ['--help'], { index: 'tty-help-shape' })
        check(checks, 'help-shape', () => {
          if (!/Usage:/i.test(help.stdout)) throw new Error('help output does not contain "Usage:"')
        })
        return { checks }
      })
    },
  },
  {
    id: 'det.tty.no-interactive-blocking',
    group: 'tty',
    title: 'non-TTY invocations never wait for stdin and never print a prompt',
    async run() {
      return withSeededHome('tty-blocking', async (workdir) => {
        const checks = []
        const noArgs = runCli(workdir, [], { index: 'tty-noargs' })
        check(checks, 'no-args-completes', () => {
          if (noArgs.timedOut) throw new Error('no-arg invocation waited for stdin')
          if (noArgs.status !== 0) throw new Error('exit ' + noArgs.status)
        })
        const once = runCli(workdir, ['tui', '--once'], { index: 'tty-tui-once' })
        check(checks, 'tui-once-completes', () => {
          if (once.timedOut) throw new Error('tui --once waited for stdin')
          if (once.status !== 0) throw new Error('exit ' + once.status)
        })
        check(checks, 'tui-once-is-read-only-snapshot', () => {
          if (!/Advisers TUI/.test(once.stdout)) throw new Error('snapshot header missing: ' + JSON.stringify(once.stdout.slice(0, 120)))
        })
        return { checks }
      })
    },
  },
]
