/**
 * CLI JSON purity: when a command is asked for JSON it writes exactly one JSON
 * document to stdout and nothing to stderr; failures with `--json` keep stdout
 * empty and put a machine-readable error envelope on stderr.
 *
 * This is the machine gate for docs/CLI-JSON.md's "stdout only JSON" promise.
 */
import { check, controlViolations, parseJson, runCli } from '../lib/harness.mjs'
import { GOLDEN_NOW } from '../fixtures/morning-ledger.mjs'
import { withSeededHome } from './_fixture.mjs'

/** Commands whose --json output is a JSON document on stdout. */
const JSON_COMMANDS = [
  ['status', ['status', '--json']],
  ['today', ['today', '--json']],
  ['agenda', ['agenda', '--json', '--now', GOLDEN_NOW]],
  ['morning', ['morning', '--json', '--now', GOLDEN_NOW]],
  ['commit-ls', ['commit', 'ls', '--json']],
  ['who', ['who', '--json']],
  ['deliveries', ['deliveries', '--json']],
  ['privacy', ['privacy', '--json']],
  ['remind', ['remind', '--json']],
  ['pet-brief', ['pet-brief', '--json']],
]

export default [
  {
    id: 'det.json.command-purity',
    group: 'json',
    title: 'every --json command emits one parseable JSON document and an empty stderr',
    async run() {
      return withSeededHome('json', async (workdir) => {
        const checks = []
        for (const [label, args] of JSON_COMMANDS) {
          const run = runCli(workdir, args, { index: 'json-' + label })
          check(checks, label + '.exit-0', () => {
            if (run.status !== 0) throw new Error('exit ' + run.status + ': ' + run.stderr.slice(0, 300))
          })
          check(checks, label + '.stdout-parses-as-json', () => {
            const parsed = parseJson(run.stdout)
            if (!parsed.ok) throw new Error('stdout is not JSON: ' + parsed.error + '; first bytes: ' + JSON.stringify(run.stdout.slice(0, 120)))
          })
          check(checks, label + '.stderr-empty-on-success', () => {
            if (run.stderr !== '') throw new Error(JSON.stringify(run.stderr.slice(0, 200)))
          })
          check(checks, label + '.no-ansi-in-stdout', () => {
            const violations = controlViolations(run.stdout)
            if (violations.length) throw new Error('control characters in stdout: ' + violations.join(','))
          })
        }
        return { checks }
      })
    },
  },
  {
    id: 'det.json.errors-are-envelopes',
    group: 'json',
    title: 'usage failures keep stdout empty and write a JSON error envelope to stderr',
    async run() {
      return withSeededHome('json-errors', async (workdir) => {
        const checks = []
        const usage = runCli(workdir, ['agenda', '--days', '0'], { index: 'json-usage' })
        check(checks, 'usage.exit-1', () => {
          if (usage.status !== 1) throw new Error('exit ' + usage.status)
        })
        check(checks, 'usage.stdout-empty', () => {
          if (usage.stdout !== '') throw new Error('stdout=' + JSON.stringify(usage.stdout.slice(0, 160)))
        })
        check(checks, 'usage.stderr-json-envelope', () => {
          const parsed = parseJson(usage.stderr)
          if (!parsed.ok) throw new Error('stderr is not JSON: ' + usage.stderr.slice(0, 200))
          if (parsed.value?.error?.code !== 'E_USAGE') throw new Error('error.code=' + JSON.stringify(parsed.value?.error?.code))
          if (typeof parsed.value?.error?.message !== 'string' || !parsed.value.error.message) throw new Error('error.message missing')
        })
        const badNow = runCli(workdir, ['morning', '--json', '--now', 'not-a-date'], { index: 'json-bad-now' })
        check(checks, 'bad-now.exit-1', () => {
          if (badNow.status !== 1) throw new Error('exit ' + badNow.status)
        })
        check(checks, 'bad-now.stdout-empty', () => {
          if (badNow.stdout !== '') throw new Error('stdout=' + JSON.stringify(badNow.stdout.slice(0, 160)))
        })
        check(checks, 'bad-now.stderr-json-envelope', () => {
          const parsed = parseJson(badNow.stderr)
          if (!parsed.ok) throw new Error('stderr is not JSON: ' + badNow.stderr.slice(0, 200))
          if (parsed.value?.error?.code !== 'E_USAGE') throw new Error('error.code=' + JSON.stringify(parsed.value?.error?.code))
        })
        return { checks }
      })
    },
  },
  {
    id: 'det.json.offline-receipt-verifier',
    group: 'json',
    title: 'evidence verify keeps its machine-readable JSON without a ledger or TOS record',
    async run() {
      return withSeededHome('json-evidence', async (workdir) => {
        const checks = []
        const run = runCli(workdir, ['evidence', 'verify', workdir.work], { index: 'json-evidence' })
        check(checks, 'exit-1-for-a-non-receipt-dir', () => {
          if (run.status !== 1) throw new Error('exit ' + run.status)
        })
        check(checks, 'stdout-is-json', () => {
          const parsed = parseJson(run.stdout)
          if (!parsed.ok) throw new Error('stdout is not JSON: ' + run.stdout.slice(0, 200))
          if (parsed.value?.ok !== false) throw new Error('ok=' + JSON.stringify(parsed.value?.ok))
          if (!Array.isArray(parsed.value?.errors) || parsed.value.errors.length === 0) throw new Error('errors[] is empty')
        })
        check(checks, 'stderr-empty', () => {
          if (run.stderr !== '') throw new Error(JSON.stringify(run.stderr.slice(0, 200)))
        })
        check(checks, 'no-network', () => {
          if (run.network.length) throw new Error(JSON.stringify(run.network))
        })
        return { checks }
      })
    },
  },
  {
    id: 'det.json.tos-exempt-surface',
    group: 'json',
    title: 'status/privacy stay available (exit 0) on a fresh home without consent',
    async run() {
      return withSeededHome('json-tos', async (workdir) => {
        const checks = []
        for (const [label, args] of [['status', ['status', '--json']], ['privacy', ['privacy', '--json']]]) {
          const run = runCli(workdir, args, { acceptTos: false, index: 'tos-exempt-' + label })
          check(checks, label + '.exit-0', () => {
            if (run.status !== 0) throw new Error('exit ' + run.status + ': ' + run.stderr.slice(0, 200))
          })
          check(checks, label + '.json', () => {
            if (!parseJson(run.stdout).ok) throw new Error('stdout is not JSON')
          })
        }
        return { checks }
      })
    },
  },
]
