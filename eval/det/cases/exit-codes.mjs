/**
 * Exit-code contract (docs/CLI-JSON.md §Exit codes):
 *   0 = success, 1 = user/config/runtime error, 3 = TOS consent required.
 *
 * Every case runs non-interactively (stdin is a closed pipe, not a TTY), which
 * is also the only correct shape for a CI gate: a command that tries to prompt
 * must fail instead of hanging.
 */
import { check, parseJson, runCli } from '../lib/harness.mjs'
import { GOLDEN_NOW } from '../fixtures/morning-ledger.mjs'
import { readBaseline } from '../lib/baseline.mjs'
import { withFreshHome, withSeededHome } from './_fixture.mjs'

export default [
  {
    id: 'det.exit.success-zero',
    group: 'exit',
    title: 'successful read/write commands exit 0 without a model key',
    async run() {
      const baseline = readBaseline()
      return withSeededHome('exit-ok', async (workdir) => {
        const checks = []
        const status = runCli(workdir, ['status', '--json'], { index: 'exit-status' })
        check(checks, 'status-exit-0', () => {
          if (status.status !== baseline.contract.exitCodes.success) throw new Error('exit ' + status.status)
        })
        const morning = runCli(workdir, ['morning', '--now', GOLDEN_NOW, '--json'], { index: 'exit-morning' })
        check(checks, 'morning-exit-0', () => {
          if (morning.status !== 0) throw new Error('exit ' + morning.status + ': ' + morning.stderr.slice(0, 200))
        })
        const add = runCli(workdir, ['commit', 'add', '退出码契约', '--quote', 'eval', '--due', '2026-11-25'], { index: 'exit-add' })
        check(checks, 'commit-add-exit-0', () => {
          if (add.status !== 0) throw new Error('exit ' + add.status + ': ' + add.stderr.slice(0, 200))
        })
        check(checks, 'no-network', () => {
          const attempts = [...status.network, ...morning.network, ...add.network]
          if (attempts.length) throw new Error(JSON.stringify(attempts))
        })
        return { checks }
      })
    },
  },
  {
    id: 'det.exit.user-error-one',
    group: 'exit',
    title: 'usage errors and missing provider keys exit 1 with a message on stderr',
    async run() {
      const baseline = readBaseline()
      return withSeededHome('exit-1', async (workdir) => {
        const checks = []
        const usage = runCli(workdir, ['agenda', '--days', '0'], { index: 'exit-usage' })
        check(checks, 'usage-exit-1', () => {
          if (usage.status !== baseline.contract.exitCodes.userError) throw new Error('exit ' + usage.status)
        })
        check(checks, 'usage-stderr-non-empty', () => {
          if (!usage.stderr.trim()) throw new Error('stderr is empty')
        })
        // 0.4.3: default capture is local (no key needed); the model path
        // (`--model`) still requires the provider key and is the missing-key
        // exit-1 case now.
        const capture = runCli(workdir, ['capture', '--model', '没有 key 的模型模式'], { index: 'exit-capture' })
        check(checks, 'missing-key-exit-1', () => {
          if (capture.status !== 1) throw new Error('exit ' + capture.status + ': ' + capture.stderr.slice(0, 200))
        })
        check(checks, 'missing-key-names-the-key', () => {
          if (!/ADVISERS_API_KEY/.test(capture.stderr)) throw new Error('stderr=' + JSON.stringify(capture.stderr.slice(0, 200)))
        })
        const verify = runCli(workdir, ['evidence', 'verify', workdir.work], { acceptTos: false, index: 'exit-evidence' })
        check(checks, 'offline-verify-error-exit-1', () => {
          if (verify.status !== 1) throw new Error('exit ' + verify.status)
        })
        check(checks, 'no-network', () => {
          const attempts = [...usage.network, ...capture.network, ...verify.network]
          if (attempts.length) throw new Error(JSON.stringify(attempts))
        })
        return { checks }
      })
    },
  },
  {
    id: 'det.exit.tos-three',
    group: 'exit',
    title: 'non-interactive commands without consent exit 3 (not a prompt, not 1)',
    async run() {
      const baseline = readBaseline()
      return withFreshHome('exit-3', async (workdir) => {
        const checks = []
        const blocked = runCli(workdir, ['commit', 'add', '未同意条款', '--quote', 'eval'], { acceptTos: false, index: 'exit-tos-blocked' })
        check(checks, 'gated-command-exit-3', () => {
          if (blocked.status !== baseline.contract.exitCodes.tosRequired) throw new Error('exit ' + blocked.status)
        })
        check(checks, 'gated-command-stdout-empty', () => {
          if (blocked.stdout !== '') throw new Error('stdout=' + JSON.stringify(blocked.stdout.slice(0, 120)))
        })
        check(checks, 'gated-command-names-violation', () => {
          if (!/E_TOS_REQUIRED/.test(blocked.stderr)) throw new Error('stderr=' + JSON.stringify(blocked.stderr.slice(0, 200)))
        })
        check(checks, 'gated-command-does-not-hang', () => {
          if (blocked.timedOut) throw new Error('timed out')
        })
        const today = runCli(workdir, ['today'], { acceptTos: false, index: 'exit-tos-today' })
        check(checks, 'today-exit-3', () => {
          if (today.status !== 3) throw new Error('exit ' + today.status)
        })
        const exempt = runCli(workdir, ['status', '--json'], { acceptTos: false, index: 'exit-tos-exempt' })
        check(checks, 'status-is-tos-exempt', () => {
          if (exempt.status !== 0) throw new Error('exit ' + exempt.status)
          if (!parseJson(exempt.stdout).ok) throw new Error('status stdout is not JSON')
        })
        return { checks }
      })
    },
  },
]
