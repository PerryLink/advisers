/**
 * 0.5.0 WF4 G1: deterministic memory gate — `fact as-of` time travel, conflict
 * visibility, abstention and correction semantics (12 cases, group `memory`).
 *
 * These cases pin the read contract of lib/kb-facts.js (no product change):
 *   - as-of selects the fact that was true at one instant and never invents one;
 *   - valid intervals are half-open [validFrom, validTo); a missing validFrom
 *     falls back to recordedAt with an explicit degraded marker;
 *   - status is not filtered (a superseded fact was true in the past), deleted
 *     tombstones are excluded by default and only visible with --include-deleted
 *     while the deletion instant is still in the future of the as-of point;
 *   - overlapping valid intervals are surfaced as a fixed warning and resolved
 *     deterministically (latest effective start), never silently;
 *   - invalid timestamps and broken supersede links are reported as warnings and
 *     never crash the command or hide the other facts;
 *   - matter/client/subject/predicate filters never leak another client's rows;
 *   - two runs on the same fixture are byte-identical.
 *
 * Same rules as the rest of the suite: fresh temp HOME, fixed fixture rows
 * written through the same SqliteStore the CLI uses, fixed TZ, no model, no
 * network (the per-invocation network-block preload is asserted at the end of
 * every case).
 */
import { CONTROL_CHARS, check, cleanupWorkdir, createWorkdir } from '../lib/harness.mjs'
import {
  MEMORY_FIXTURE_BETA_CLIENT_ID,
  MEMORY_FIXTURE_BETA_MATTER_ID,
  MEMORY_FIXTURE_CLIENT_ID,
  MEMORY_FIXTURE_MATTER_ID,
  checkNoNetwork,
  jsonValue,
  runJsonCli,
  seedMemoryFacts,
  withFreshHome,
} from './_fixture.mjs'

const AS_OF_EARLY = '2025-06-01'
const AS_OF_Q1 = '2026-03-01'
const AS_OF_OVERLAP = '2026-04-01'
const AS_OF_AFTER_CHAIN = '2026-09-01'

const OVERLAP_WARNING = '1 group(s) have overlapping valid intervals; the latest effective start was selected'

/** Create a memory fixture home, run `fn(workdir)`, always clean up. */
async function withMemoryHome(label, fn, { extras = [] } = {}) {
  const workdir = createWorkdir('memory-' + label)
  try {
    await seedMemoryFacts(workdir.home, { extras })
    return await fn(workdir)
  } finally {
    cleanupWorkdir(workdir)
  }
}

function asOf(workdir, args, index) {
  return runJsonCli(workdir, ['fact', 'as-of', ...args, '--json'], { index })
}

function itemsByPredicate(value, predicate) {
  return (value.items ?? []).filter((item) => item.predicate === predicate)
}

function assertNoControlBytes(text, label) {
  const compact = text.replace(/\\n/g, '')
  if (CONTROL_CHARS.test(compact)) throw new Error(label + ' contains control bytes')
}

const TOMBSTONE = {
  id: 'fact_tombstone',
  predicate: 'old.note',
  object: 'tombstoned value',
  recordedAt: '2026-01-01T00:00:00.000Z',
  validFrom: '2026-01-01T00:00:00.000Z',
  deletedAt: '2026-07-01T00:00:00.000Z',
  deletedReason: 'superseded by a correction',
}

export default [
  {
    id: 'det.memory.as-of-before-first-fact-is-empty',
    group: 'memory',
    title: 'as-of before the first fact abstains with a structured empty result (not an error)',
    async run() {
      return withMemoryHome('early', async (workdir) => {
        const checks = []
        const result = asOf(workdir, [AS_OF_EARLY], 'memory-early')
        check(checks, 'exit-0', () => {
          if (result.run.status !== 0) throw new Error('exit ' + result.run.status + ': ' + result.run.stderr.slice(0, 200))
        })
        check(checks, 'empty-items-and-zero-groups', () => {
          const value = jsonValue(result, 'fact as-of before first fact')
          if (value.command !== 'fact as-of') throw new Error('command=' + value.command)
          if (value.asOfLocalDay !== AS_OF_EARLY) throw new Error('asOfLocalDay=' + value.asOfLocalDay)
          if (JSON.stringify(value.items) !== '[]') throw new Error('items=' + JSON.stringify(value.items))
          if (JSON.stringify(value.counts) !== JSON.stringify({ groups: 0, candidates: 0, overlappingGroups: 0 })) throw new Error('counts=' + JSON.stringify(value.counts))
          if (value.includeDeleted !== false || value.truncated !== false) throw new Error('includeDeleted/truncated=' + value.includeDeleted + '/' + value.truncated)
          if ((value.warnings ?? []).length !== 0) throw new Error('warnings=' + JSON.stringify(value.warnings))
        })
        checkNoNetwork(checks, 'no-network', [result.run])
        return { checks }
      })
    },
  },
  {
    id: 'det.memory.valid-from-to-boundaries',
    group: 'memory',
    title: 'validFrom is inclusive and validTo is exclusive at the selected node',
    async run() {
      return withMemoryHome('boundary', async (workdir) => {
        const checks = []
        const runs = []
        const atFrom = asOf(workdir, ['2026-01-01T00:00:00Z'], 'memory-boundary-from')
        const atBeforeTo = asOf(workdir, ['2026-05-31T23:59:59Z'], 'memory-boundary-before-to')
        const atTo = asOf(workdir, ['2026-06-01T00:00:00Z'], 'memory-boundary-to')
        runs.push(atFrom.run, atBeforeTo.run, atTo.run)
        check(checks, 'valid-from-is-inclusive', () => {
          const quote = itemsByPredicate(jsonValue(atFrom, 'fact as-of validFrom'), 'quote.total')
          if (quote.length !== 1) throw new Error('quote.total groups=' + quote.length)
          if (quote[0].id !== 'fact_mid' || quote[0].object !== '80000') throw new Error('selected=' + JSON.stringify(quote[0]))
          if (quote[0].validFrom !== '2026-01-01T00:00:00.000Z') throw new Error('validFrom=' + quote[0].validFrom)
        })
        check(checks, 'valid-to-is-exclusive-before-instant', () => {
          const quote = itemsByPredicate(jsonValue(atBeforeTo, 'fact as-of validTo-1s'), 'quote.total')
          if (quote.length !== 1 || quote[0].id !== 'fact_mid') throw new Error('selected=' + JSON.stringify(quote))
        })
        check(checks, 'valid-to-is-exclusive-at-instant', () => {
          const value = jsonValue(atTo, 'fact as-of validTo')
          const quote = itemsByPredicate(value, 'quote.total')
          if (quote.length !== 1 || quote[0].id !== 'fact_new' || quote[0].object !== '90000') throw new Error('selected=' + JSON.stringify(quote))
          if (quote[0].status !== 'confirmed') throw new Error('status=' + quote[0].status)
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  {
    id: 'det.memory.supersede-chain-history-and-quote',
    group: 'memory',
    title: 'the superseded node is selected and visible, with a sanitized evidence quote',
    async run() {
      const extras = [{
        id: 'fact_quote', predicate: 'evidence.quote', object: 'quoted',
        recordedAt: '2026-01-02T00:00:00.000Z', validFrom: '2026-01-02T00:00:00.000Z',
        evidence: [{ quote: ('逐字证据' + 'x'.repeat(250)) + '\u0007', ref: 'conv_q#turn_1' }],
      }]
      return withMemoryHome('chain', async (workdir) => {
        const checks = []
        const result = asOf(workdir, [AS_OF_Q1], 'memory-chain')
        check(checks, 'exit-0', () => {
          if (result.run.status !== 0) throw new Error('exit ' + result.run.status + ': ' + result.run.stderr.slice(0, 200))
        })
        check(checks, 'selects-the-middle-node', () => {
          const quote = itemsByPredicate(jsonValue(result, 'fact as-of chain'), 'quote.total')
          if (quote.length !== 1) throw new Error('groups=' + quote.length)
          if (quote[0].id !== 'fact_mid') throw new Error('id=' + quote[0].id)
          if (quote[0].status !== 'superseded') throw new Error('a past fact keeps status=superseded, got ' + quote[0].status)
          if (quote[0].supersedes !== 'fact_early' || quote[0].supersededBy !== 'fact_new') throw new Error('chain pointers=' + JSON.stringify({ supersedes: quote[0].supersedes, supersededBy: quote[0].supersededBy }))
        })
        check(checks, 'evidence-quote-is-bounded-and-sanitized', () => {
          const item = itemsByPredicate(jsonValue(result, 'fact as-of quote'), 'evidence.quote')[0]
          if (!item) throw new Error('evidence.quote fact missing')
          const quote = item.evidence?.[0]?.quote
          if (typeof quote !== 'string') throw new Error('quote=' + JSON.stringify(item.evidence))
          if (Array.from(quote).length > 200) throw new Error('quote length=' + Array.from(quote).length)
          if (CONTROL_CHARS.test(quote)) throw new Error('quote still contains control bytes')
          if (!quote.startsWith('逐字证据')) throw new Error('quote=' + JSON.stringify(quote))
        })
        check(checks, 'no-control-bytes-in-json', () => {
          assertNoControlBytes(result.run.stdout, 'fact as-of output')
        })
        checkNoNetwork(checks, 'no-network', [result.run])
        return { checks }
      }, { extras })
    },
  },
  {
    id: 'det.memory.overlapping-intervals-warn-and-resolve',
    group: 'memory',
    title: 'overlapping valid intervals surface a fixed warning and select deterministically',
    async run() {
      return withMemoryHome('overlap', async (workdir) => {
        const checks = []
        const first = asOf(workdir, [AS_OF_OVERLAP], 'memory-overlap-1')
        const second = asOf(workdir, [AS_OF_OVERLAP], 'memory-overlap-2')
        check(checks, 'exit-0', () => {
          if (first.run.status !== 0 || second.run.status !== 0) throw new Error('exit ' + first.run.status + '/' + second.run.status + ': ' + first.run.stderr.slice(0, 200))
        })
        check(checks, 'counts-overlapping-groups', () => {
          const value = jsonValue(first, 'fact as-of overlap')
          if (value.counts?.overlappingGroups !== 1) throw new Error('overlappingGroups=' + value.counts?.overlappingGroups)
          if (!(value.warnings ?? []).includes(OVERLAP_WARNING)) throw new Error('warnings=' + JSON.stringify(value.warnings))
        })
        check(checks, 'latest-effective-start-wins', () => {
          const selected = itemsByPredicate(jsonValue(first, 'fact as-of overlap'), 'scope.deliverable')
          if (selected.length !== 1) throw new Error('groups=' + selected.length)
          if (selected[0].id !== 'fact_overlap_b' || selected[0].object !== 'B') throw new Error('selected=' + JSON.stringify(selected[0]))
          if (selected[0].effectiveFrom !== '2026-03-01T00:00:00.000Z') throw new Error('effectiveFrom=' + selected[0].effectiveFrom)
        })
        check(checks, 'two-runs-byte-identical', () => {
          if (first.run.stdout !== second.run.stdout) throw new Error('fact as-of output differs between two runs')
        })
        checkNoNetwork(checks, 'no-network', [first.run, second.run])
        return { checks }
      })
    },
  },
  {
    id: 'det.memory.deleted-excluded-by-default',
    group: 'memory',
    title: 'a tombstone is excluded by default without hiding the live facts',
    async run() {
      const extras = [TOMBSTONE]
      return withMemoryHome('deleted-default', async (workdir) => {
        const checks = []
        const result = asOf(workdir, [AS_OF_Q1], 'memory-deleted-default')
        check(checks, 'exit-0', () => {
          if (result.run.status !== 0) throw new Error('exit ' + result.run.status + ': ' + result.run.stderr.slice(0, 200))
        })
        check(checks, 'tombstone-absent-and-not-counted', () => {
          const value = jsonValue(result, 'fact as-of deleted default')
          if (itemsByPredicate(value, 'old.note').length !== 0) throw new Error('tombstone leaked into the default as-of view')
          if (value.includeDeleted !== false) throw new Error('includeDeleted=' + value.includeDeleted)
          if ((value.warnings ?? []).length !== 0) throw new Error('warnings=' + JSON.stringify(value.warnings))
          if (value.counts?.groups !== 5) throw new Error('groups=' + value.counts?.groups)
        })
        check(checks, 'live-facts-still-visible', () => {
          const value = jsonValue(result, 'fact as-of deleted default')
          if (itemsByPredicate(value, 'quote.total')[0]?.id !== 'fact_mid') throw new Error('quote.total moved')
          // At 2026-03-01 only overlap A has started; B starts later that day (UTC+8).
          if (itemsByPredicate(value, 'scope.deliverable')[0]?.id !== 'fact_overlap_a') throw new Error('scope.deliverable moved')
        })
        checkNoNetwork(checks, 'no-network', [result.run])
        return { checks }
      }, { extras })
    },
  },
  {
    id: 'det.memory.include-deleted-tombstone-window',
    group: 'memory',
    title: '--include-deleted shows a tombstone only while its deletion is after the as-of point',
    async run() {
      const extras = [TOMBSTONE]
      return withMemoryHome('deleted-flag', async (workdir) => {
        const checks = []
        const runs = []
        const visible = asOf(workdir, [AS_OF_Q1, '--include-deleted'], 'memory-deleted-visible')
        const filtered = asOf(workdir, [AS_OF_AFTER_CHAIN, '--include-deleted'], 'memory-deleted-filtered')
        runs.push(visible.run, filtered.run)
        check(checks, 'visible-before-deletion', () => {
          if (visible.run.status !== 0) throw new Error('exit ' + visible.run.status + ': ' + visible.run.stderr.slice(0, 200))
          const value = jsonValue(visible, 'fact as-of --include-deleted (before deletion)')
          if (value.includeDeleted !== true) throw new Error('includeDeleted=' + value.includeDeleted)
          const tombstone = itemsByPredicate(value, 'old.note')
          if (tombstone.length !== 1) throw new Error('tombstone rows=' + tombstone.length)
          if (tombstone[0].id !== 'fact_tombstone') throw new Error('id=' + tombstone[0].id)
          if (tombstone[0].deletedAt !== '2026-07-01T00:00:00.000Z') throw new Error('deletedAt=' + tombstone[0].deletedAt)
          if (tombstone[0].deletedReason !== 'superseded by a correction') throw new Error('deletedReason=' + tombstone[0].deletedReason)
        })
        check(checks, 'filtered-after-deletion-with-warning', () => {
          if (filtered.run.status !== 0) throw new Error('exit ' + filtered.run.status)
          const value = jsonValue(filtered, 'fact as-of --include-deleted (after deletion)')
          if (itemsByPredicate(value, 'old.note').length !== 0) throw new Error('tombstone visible after its deletion instant')
          if (!(value.warnings ?? []).some((warning) => String(warning).includes('1 deleted fact(s) excluded'))) throw new Error('warnings=' + JSON.stringify(value.warnings))
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      }, { extras })
    },
  },
  {
    id: 'det.memory.valid-from-fallback',
    group: 'memory',
    title: 'a missing validFrom falls back to recordedAt with explicit markers',
    async run() {
      return withMemoryHome('fallback', async (workdir) => {
        const checks = []
        const result = asOf(workdir, [AS_OF_Q1], 'memory-fallback')
        check(checks, 'exit-0', () => {
          if (result.run.status !== 0) throw new Error('exit ' + result.run.status + ': ' + result.run.stderr.slice(0, 200))
        })
        check(checks, 'fallback-flags-and-effective-from', () => {
          const value = jsonValue(result, 'fact as-of fallback')
          const item = itemsByPredicate(value, 'contact.channel')[0]
          if (!item) throw new Error('contact.channel missing')
          if (item.id !== 'fact_fallback') throw new Error('id=' + item.id)
          if (item.fallback?.validFromFromRecordedAt !== true) throw new Error('fallback=' + JSON.stringify(item.fallback))
          if (item.effectiveFrom !== '2026-01-15T00:00:00.000Z') throw new Error('effectiveFrom=' + item.effectiveFrom)
          if (item.recordedAt !== '2026-01-15T00:00:00.000Z') throw new Error('recordedAt=' + item.recordedAt)
          if (item.validFrom !== undefined) throw new Error('validFrom should stay absent, got ' + item.validFrom)
        })
        check(checks, 'degraded-marker', () => {
          const degraded = jsonValue(result, 'fact as-of fallback').degraded ?? []
          if (JSON.stringify(degraded) !== JSON.stringify(['valid_from_fallback_recorded_at'])) throw new Error('degraded=' + JSON.stringify(degraded))
        })
        checkNoNetwork(checks, 'no-network', [result.run])
        return { checks }
      })
    },
  },
  {
    id: 'det.memory.bad-timestamp-skips-and-warns',
    group: 'memory',
    title: 'an unparseable timestamp skips that fact with a warning and exit 0',
    async run() {
      const extras = [{ id: 'fact_bad_ts', predicate: 'bad.timestamp', object: 'nope', recordedAt: '2026-01-01T00:00:00.000Z', validFrom: 'not-a-timestamp' }]
      return withMemoryHome('bad-ts', async (workdir) => {
        const checks = []
        const result = asOf(workdir, [AS_OF_Q1], 'memory-bad-ts')
        check(checks, 'exit-0', () => {
          if (result.run.status !== 0) throw new Error('exit ' + result.run.status + ': ' + result.run.stderr.slice(0, 200))
        })
        check(checks, 'bad-row-skipped-with-warning', () => {
          const value = jsonValue(result, 'fact as-of bad timestamp')
          if (itemsByPredicate(value, 'bad.timestamp').length !== 0) throw new Error('bad timestamp fact was selected')
          if (!(value.warnings ?? []).some((warning) => String(warning).includes('1 fact(s) skipped because a timestamp could not be parsed'))) throw new Error('warnings=' + JSON.stringify(value.warnings))
        })
        check(checks, 'other-facts-normal', () => {
          const value = jsonValue(result, 'fact as-of bad timestamp')
          if (itemsByPredicate(value, 'quote.total')[0]?.id !== 'fact_mid') throw new Error('quote.total moved')
          if (value.counts?.groups !== 5) throw new Error('groups=' + value.counts?.groups)
        })
        checkNoNetwork(checks, 'no-network', [result.run])
        return { checks }
      }, { extras })
    },
  },
  {
    id: 'det.memory.broken-supersede-chain-warns',
    group: 'memory',
    title: 'broken supersedes/supersededBy links warn instead of crashing, and as-of stays intact',
    async run() {
      const extras = [{
        id: 'fact_broken', predicate: 'broken.chain', object: 'X',
        recordedAt: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z',
        supersedes: 'fact_missing', supersededBy: 'fact_also_missing',
      }]
      return withMemoryHome('bad-chain', async (workdir) => {
        const checks = []
        const runs = []
        const asOfRun = asOf(workdir, [AS_OF_Q1], 'memory-bad-chain-asof')
        const history = runJsonCli(workdir, ['fact', 'history', 'fact_broken', '--json'], { index: 'memory-bad-chain-history' })
        runs.push(asOfRun.run, history.run)
        check(checks, 'as-of-does-not-crash', () => {
          if (asOfRun.run.status !== 0) throw new Error('exit ' + asOfRun.run.status + ': ' + asOfRun.run.stderr.slice(0, 200))
          const value = jsonValue(asOfRun, 'fact as-of broken chain')
          if (itemsByPredicate(value, 'broken.chain')[0]?.id !== 'fact_broken') throw new Error('fact_broken missing from as-of')
          if (itemsByPredicate(value, 'quote.total')[0]?.id !== 'fact_mid') throw new Error('quote.total moved')
        })
        check(checks, 'history-warns-about-broken-links', () => {
          if (history.run.status !== 0) throw new Error('exit ' + history.run.status + ': ' + history.run.stderr.slice(0, 200))
          const value = jsonValue(history, 'fact history broken chain')
          const warnings = value.warnings ?? []
          if (!warnings.some((warning) => String(warning).includes('broken supersedes link: fact_missing is missing'))) throw new Error('warnings=' + JSON.stringify(warnings))
          if (!warnings.some((warning) => String(warning).includes('broken supersededBy link: fact_also_missing is missing'))) throw new Error('warnings=' + JSON.stringify(warnings))
          if (JSON.stringify((value.items ?? []).map((item) => item.id)) !== JSON.stringify(['fact_broken'])) throw new Error('items=' + JSON.stringify((value.items ?? []).map((item) => item.id)))
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      }, { extras })
    },
  },
  {
    id: 'det.memory.filters-do-not-cross-clients',
    group: 'memory',
    title: 'matter/client/subject/predicate filters return only the matching groups',
    async run() {
      return withMemoryHome('filters', async (workdir) => {
        const checks = []
        const runs = []
        const matter = asOf(workdir, [AS_OF_Q1, '--matter', MEMORY_FIXTURE_MATTER_ID], 'memory-filter-matter')
        const client = asOf(workdir, [AS_OF_Q1, '--client', MEMORY_FIXTURE_BETA_CLIENT_ID], 'memory-filter-client')
        const predicate = asOf(workdir, [AS_OF_Q1, '--predicate', 'project.stage'], 'memory-filter-predicate')
        const combined = asOf(workdir, [AS_OF_Q1, '--matter', MEMORY_FIXTURE_MATTER_ID, '--predicate', 'project.stage'], 'memory-filter-combined')
        const subject = asOf(workdir, [AS_OF_Q1, '--subject', '客户乙'], 'memory-filter-subject')
        runs.push(matter.run, client.run, predicate.run, combined.run, subject.run)
        check(checks, 'matter-filter', () => {
          const value = jsonValue(matter, 'fact as-of --matter')
          if (!value.items.length || value.items.some((item) => item.matterId !== MEMORY_FIXTURE_MATTER_ID)) throw new Error('matter filter leaked: ' + JSON.stringify(value.items.map((item) => item.matterId)))
          if (itemsByPredicate(value, 'project.stage').some((item) => item.id === 'fact_beta_stage')) throw new Error('beta stage leaked into alpha matter')
        })
        check(checks, 'client-filter', () => {
          const value = jsonValue(client, 'fact as-of --client')
          const ids = (value.items ?? []).map((item) => item.id)
          if (JSON.stringify(ids) !== JSON.stringify(['fact_beta_stage'])) throw new Error('ids=' + JSON.stringify(ids))
          if (value.counts?.groups !== 1) throw new Error('groups=' + value.counts?.groups)
          if (value.items[0]?.matterId !== MEMORY_FIXTURE_BETA_MATTER_ID || value.items[0]?.clientId !== MEMORY_FIXTURE_BETA_CLIENT_ID) throw new Error('row=' + JSON.stringify(value.items[0]))
        })
        check(checks, 'predicate-filter', () => {
          const ids = (jsonValue(predicate, 'fact as-of --predicate').items ?? []).map((item) => item.id).sort()
          if (JSON.stringify(ids) !== JSON.stringify(['fact_alpha_stage', 'fact_beta_stage'])) throw new Error('ids=' + JSON.stringify(ids))
        })
        check(checks, 'combined-filter', () => {
          const ids = (jsonValue(combined, 'fact as-of --matter+--predicate').items ?? []).map((item) => item.id)
          if (JSON.stringify(ids) !== JSON.stringify(['fact_alpha_stage'])) throw new Error('ids=' + JSON.stringify(ids))
        })
        check(checks, 'subject-filter', () => {
          const ids = (jsonValue(subject, 'fact as-of --subject').items ?? []).map((item) => item.id)
          if (JSON.stringify(ids) !== JSON.stringify(['fact_beta_stage'])) throw new Error('ids=' + JSON.stringify(ids))
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  {
    id: 'det.memory.two-runs-byte-identical',
    group: 'memory',
    title: 'the same fixture rows produce byte-identical as-of output in two fresh homes',
    async run() {
      const first = await withMemoryHome('determinism-a', async (workdir) => asOf(workdir, [AS_OF_Q1], 'memory-determinism-a'))
      const second = await withMemoryHome('determinism-b', async (workdir) => asOf(workdir, [AS_OF_Q1], 'memory-determinism-b'))
      const checks = []
      check(checks, 'both-runs-exit-0', () => {
        if (first.run.status !== 0 || second.run.status !== 0) throw new Error('exit ' + first.run.status + '/' + second.run.status + ': ' + first.run.stderr.slice(0, 200))
      })
      check(checks, 'byte-identical-across-homes', () => {
        if (first.run.stdout !== second.run.stdout) throw new Error('as-of output differs across fresh homes with identical fixture rows')
      })
      checkNoNetwork(checks, 'no-network', [first.run, second.run])
      return { checks }
    },
  },
  {
    id: 'det.memory.empty-and-no-match-stay-structured',
    group: 'memory',
    title: 'an empty ledger and a no-match filter return structured empty results without false warnings',
    async run() {
      const checks = []
      const empty = await withFreshHome('memory-empty', async (workdir) => asOf(workdir, ['2026-01-01'], 'memory-empty'))
      const noMatch = await withMemoryHome('no-match', async (workdir) => asOf(workdir, [AS_OF_Q1, '--predicate', 'does.not.exist'], 'memory-no-match'))
      check(checks, 'empty-ledger', () => {
        if (empty.run.status !== 0) throw new Error('exit ' + empty.run.status + ': ' + empty.run.stderr.slice(0, 200))
        const value = jsonValue(empty, 'fact as-of empty ledger')
        if (JSON.stringify(value.items) !== '[]') throw new Error('items=' + JSON.stringify(value.items))
        if (JSON.stringify(value.counts) !== JSON.stringify({ groups: 0, candidates: 0, overlappingGroups: 0 })) throw new Error('counts=' + JSON.stringify(value.counts))
        if ((value.warnings ?? []).length !== 0 || (value.degraded ?? []).length !== 0) throw new Error('warnings/degraded=' + JSON.stringify(value.warnings) + '/' + JSON.stringify(value.degraded))
      })
      check(checks, 'no-match-filter', () => {
        if (noMatch.run.status !== 0) throw new Error('exit ' + noMatch.run.status + ': ' + noMatch.run.stderr.slice(0, 200))
        const value = jsonValue(noMatch, 'fact as-of no match')
        if (JSON.stringify(value.items) !== '[]') throw new Error('items=' + JSON.stringify(value.items))
        if (value.counts?.groups !== 0 || value.counts?.candidates !== 0) throw new Error('counts=' + JSON.stringify(value.counts))
        if ((value.warnings ?? []).length !== 0) throw new Error('warnings=' + JSON.stringify(value.warnings))
      })
      checkNoNetwork(checks, 'no-network', [empty.run, noMatch.run])
      return { checks }
    },
  },
]
