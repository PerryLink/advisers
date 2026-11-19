/**
 * E5 determinism: the same ledger + the same Shanghai day must yield the same
 * `morning.dataSha256` and the same deterministic markdown, across processes.
 *
 * The golden values live in eval/det/baseline.json and are re-recorded only via
 * `node scripts/eval-det.mjs --update-baseline` (reviewed diff).
 */
import { check, parseJson, runCli, sha256Hex } from '../lib/harness.mjs'
import { readBaseline } from '../lib/baseline.mjs'
import {
  EXTRA_COMMITMENT,
  FIXTURE_ID,
  GOLDEN_NOW,
  NEXT_DAY_NOW,
  SAME_DAY_NOW,
} from '../fixtures/morning-ledger.mjs'
import { isSha256, sleep, withSeededHome } from './_fixture.mjs'

const GOLDEN_LOCAL_DAY = '2026-11-20'

function runMorningJson(workdir, now, index) {
  const run = runCli(workdir, ['morning', '--now', now, '--json'], { index })
  const parsed = parseJson(run.stdout)
  return { run, parsed }
}

export default [
  {
    id: 'det.morning.hash-stable-two-runs',
    group: 'determinism',
    title: 'same ledger, same day: two processes 1s apart agree on dataSha256',
    async run() {
      return withSeededHome('two-runs', async (workdir) => {
        const checks = []
        const first = runMorningJson(workdir, GOLDEN_NOW, 'two-runs-1')
        await sleep(1100)
        const second = runMorningJson(workdir, GOLDEN_NOW, 'two-runs-2')
        check(checks, 'first-exit-0', () => {
          if (first.run.status !== 0) throw new Error('exit ' + first.run.status + ': ' + first.run.stderr.slice(0, 300))
        })
        check(checks, 'first-stdout-pure-json', () => {
          if (!first.parsed.ok) throw new Error(first.parsed.error)
        })
        check(checks, 'dataSha256-is-sha256', () => {
          if (!isSha256(first.parsed.value?.dataSha256)) throw new Error('dataSha256=' + JSON.stringify(first.parsed.value?.dataSha256))
        })
        check(checks, 'fixed-now-echoed', () => {
          if (first.parsed.value?.generatedAt !== GOLDEN_NOW) throw new Error('generatedAt=' + first.parsed.value?.generatedAt)
          if (first.parsed.value?.localDay !== GOLDEN_LOCAL_DAY) throw new Error('localDay=' + first.parsed.value?.localDay)
        })
        check(checks, 'second-exit-0', () => {
          if (second.run.status !== 0) throw new Error('exit ' + second.run.status + ': ' + second.run.stderr.slice(0, 300))
        })
        check(checks, 'hashes-identical', () => {
          if (first.parsed.value?.dataSha256 !== second.parsed.value?.dataSha256) {
            throw new Error(first.parsed.value?.dataSha256 + ' != ' + second.parsed.value?.dataSha256)
          }
        })
        check(checks, 'no-network', () => {
          const attempts = [...first.run.network, ...second.run.network]
          if (attempts.length) throw new Error(JSON.stringify(attempts))
        })
        return { checks }
      })
    },
  },
  {
    id: 'det.morning.hash-same-day',
    group: 'determinism',
    title: '09:00 and 11:00 Asia/Shanghai on the same day produce the same hash',
    async run() {
      return withSeededHome('same-day', async (workdir) => {
        const checks = []
        const morning = runMorningJson(workdir, GOLDEN_NOW, 'same-day-am')
        const later = runMorningJson(workdir, SAME_DAY_NOW, 'same-day-pm')
        check(checks, 'both-exit-0', () => {
          if (morning.run.status !== 0 || later.run.status !== 0) throw new Error('exit ' + morning.run.status + '/' + later.run.status)
        })
        check(checks, 'same-local-day', () => {
          if (morning.parsed.value?.localDay !== GOLDEN_LOCAL_DAY || later.parsed.value?.localDay !== GOLDEN_LOCAL_DAY) {
            throw new Error('localDay ' + morning.parsed.value?.localDay + '/' + later.parsed.value?.localDay)
          }
        })
        check(checks, 'hash-independent-of-time-of-day', () => {
          if (morning.parsed.value?.dataSha256 !== later.parsed.value?.dataSha256) {
            throw new Error('hash moved within the same day: ' + morning.parsed.value?.dataSha256 + ' != ' + later.parsed.value?.dataSha256)
          }
        })
        check(checks, 'counts-identical', () => {
          const left = JSON.stringify(morning.parsed.value?.counts ?? null)
          const right = JSON.stringify(later.parsed.value?.counts ?? null)
          if (left !== right) throw new Error(left + ' != ' + right)
        })
        return { checks }
      })
    },
  },
  {
    id: 'det.morning.hash-changes-next-day',
    group: 'determinism',
    title: 'the next local day moves the hash (the window is part of the data)',
    async run() {
      return withSeededHome('next-day', async (workdir) => {
        const checks = []
        const day = runMorningJson(workdir, GOLDEN_NOW, 'next-day-day')
        const next = runMorningJson(workdir, NEXT_DAY_NOW, 'next-day-next')
        check(checks, 'both-exit-0', () => {
          if (day.run.status !== 0 || next.run.status !== 0) throw new Error('exit ' + day.run.status + '/' + next.run.status)
        })
        check(checks, 'local-day-advanced', () => {
          if (next.parsed.value?.localDay !== '2026-11-21') throw new Error('localDay=' + next.parsed.value?.localDay)
        })
        check(checks, 'hash-differs', () => {
          if (day.parsed.value?.dataSha256 === next.parsed.value?.dataSha256) throw new Error('hash did not change across days')
        })
        return { checks }
      })
    },
  },
  {
    id: 'det.morning.hash-changes-on-data-change',
    group: 'determinism',
    title: 'adding a commitment on the same day moves the hash',
    async run() {
      return withSeededHome('data-change', async (workdir) => {
        const checks = []
        const before = runMorningJson(workdir, GOLDEN_NOW, 'data-change-before')
        check(checks, 'before-exit-0', () => {
          if (before.run.status !== 0) throw new Error('exit ' + before.run.status)
        })
        const add = runCli(workdir, EXTRA_COMMITMENT, { index: 'data-change-add' })
        check(checks, 'commit-add-exit-0', () => {
          if (add.status !== 0) throw new Error('exit ' + add.status + ': ' + add.stderr.slice(0, 300))
        })
        const after = runMorningJson(workdir, GOLDEN_NOW, 'data-change-after')
        check(checks, 'after-exit-0', () => {
          if (after.run.status !== 0) throw new Error('exit ' + after.run.status)
        })
        check(checks, 'same-local-day', () => {
          if (before.parsed.value?.localDay !== after.parsed.value?.localDay) throw new Error('localDay changed')
        })
        check(checks, 'hash-moved', () => {
          if (before.parsed.value?.dataSha256 === after.parsed.value?.dataSha256) throw new Error('hash did not move after the ledger changed')
        })
        check(checks, 'upcoming-count-moved', () => {
          if (before.parsed.value?.counts?.upcoming === after.parsed.value?.counts?.upcoming) throw new Error('upcoming count unchanged')
        })
        return { checks }
      })
    },
  },
  {
    id: 'det.morning.golden-hash',
    group: 'determinism',
    title: 'golden dataSha256 matches eval/det/baseline.json',
    async run() {
      const baseline = readBaseline()
      return withSeededHome('golden', async (workdir) => {
        const checks = []
        const { run, parsed } = runMorningJson(workdir, baseline.golden.morning.now, 'golden')
        check(checks, 'exit-0', () => {
          if (run.status !== 0) throw new Error('exit ' + run.status + ': ' + run.stderr.slice(0, 300))
        })
        check(checks, 'fixture-version-matches-baseline', () => {
          if (baseline.fixture !== FIXTURE_ID) throw new Error('baseline fixture ' + baseline.fixture + ' != ' + FIXTURE_ID)
        })
        check(checks, 'dataSha256-matches-baseline', () => {
          if (parsed.value?.dataSha256 !== baseline.golden.morning.dataSha256) {
            throw new Error('expected ' + baseline.golden.morning.dataSha256 + ', got ' + parsed.value?.dataSha256)
          }
        })
        check(checks, 'localDay-matches-baseline', () => {
          if (parsed.value?.localDay !== baseline.golden.morning.localDay) throw new Error('localDay=' + parsed.value?.localDay)
        })
        return { checks }
      })
    },
  },
  {
    id: 'det.morning.markdown-stable',
    group: 'determinism',
    title: 'deterministic morning markdown: same bytes, same hash prefix',
    async run() {
      const baseline = readBaseline()
      return withSeededHome('markdown', async (workdir) => {
        const checks = []
        const first = runCli(workdir, ['morning', '--now', GOLDEN_NOW], { index: 'markdown-1' })
        const second = runCli(workdir, ['morning', '--now', GOLDEN_NOW], { index: 'markdown-2' })
        check(checks, 'both-exit-0', () => {
          if (first.status !== 0 || second.status !== 0) throw new Error('exit ' + first.status + '/' + second.status)
        })
        check(checks, 'markdown-byte-identical', () => {
          if (first.stdout !== second.stdout) throw new Error('markdown differs between runs')
        })
        check(checks, 'hash-prefix-present', () => {
          const prefix = baseline.golden.morning.dataSha256.slice(0, 16)
          if (!first.stdout.includes('sha256:' + prefix)) throw new Error('expected sha256:' + prefix + ' in markdown')
        })
        check(checks, 'markdown-sha256-matches-baseline', () => {
          const actual = sha256Hex(first.stdout)
          if (actual !== baseline.golden.morning.digestMarkdownSha256) {
            throw new Error('expected ' + baseline.golden.morning.digestMarkdownSha256 + ', got ' + actual)
          }
        })
        check(checks, 'no-ansi', () => {
          if (/[\u001B\u009B]/.test(first.stdout)) throw new Error('markdown contains an ANSI escape')
        })
        return { checks }
      })
    },
  },
  {
    id: 'det.agenda.json-byte-stable',
    group: 'determinism',
    title: 'agenda --json with a fixed clock is byte-identical across processes',
    async run() {
      return withSeededHome('agenda', async (workdir) => {
        const checks = []
        const first = runCli(workdir, ['agenda', '--now', GOLDEN_NOW, '--json'], { index: 'agenda-1' })
        const second = runCli(workdir, ['agenda', '--now', GOLDEN_NOW, '--json'], { index: 'agenda-2' })
        check(checks, 'both-exit-0', () => {
          if (first.status !== 0 || second.status !== 0) throw new Error('exit ' + first.status + '/' + second.status)
        })
        check(checks, 'bytes-identical', () => {
          if (first.stdout !== second.stdout) throw new Error('agenda --json differs between runs')
        })
        check(checks, 'window-is-fixed', () => {
          const parsed = parseJson(first.stdout)
          if (!parsed.ok) throw new Error(parsed.error)
          const window = parsed.value?.window
          if (window?.from !== GOLDEN_LOCAL_DAY) throw new Error('window.from=' + JSON.stringify(window?.from))
          if (window?.timezone !== 'Asia/Shanghai') throw new Error('window.timezone=' + JSON.stringify(window?.timezone))
        })
        return { checks }
      })
    },
  },
]
