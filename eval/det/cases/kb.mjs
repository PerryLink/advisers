/**
 * 0.4.0 KB deterministic gate: 'kb add' -> 'kb ls' / 'kb show' / 'kb search',
 * the 2-char degraded LIKE path, compiled-page rebuild idempotency and
 * 'fact as-of' time travel.
 *
 * Same rules as the 0.3.0 gates: a fresh temp ADVISERS_HOME per case, fixed
 * fixture rows (written through the same SqliteStore the CLI uses), no model
 * key, no network (every child runs behind the network-block preload). Read
 * commands are executed twice in the same home and compared byte for byte:
 * same rows + same home => same bytes. Document/chunk ids are random per home,
 * so cross-home checks compare the stable content fields only.
 *
 * Golden values stay in eval/det/baseline.json; these cases assert the 0.4
 * contract (shapes, codes, degraded markers, idempotency), not a snapshot.
 */
import { check, controlViolations, sha256Hex } from '../lib/harness.mjs'
import {
  KB_FIXTURE_CLIENT_ID,
  KB_FIXTURE_MATTER_ID,
  KB_FIXTURE_PROJECT_ID,
  checkNoNetwork,
  isSha256,
  jsonValue,
  runJsonCli,
  seedKbLedger,
  writeWorkFile,
  withFreshHome,
} from './_fixture.mjs'

const QUOTE_MD = ['# 报价说明', '', '本次官网改版报价 80000 元，含设计与开发。', ''].join('\n')
const REPORT_MD = ['# 项目周报', '', '本周完成首页视觉稿，等待客户确认。', ''].join('\n')

/** Content fields that must not depend on the random ids/timestamps of a home. */
function stableDocFields(doc) {
  return {
    title: doc.title,
    kind: doc.kind,
    sourceName: doc.sourceName,
    sourceSha256: doc.sourceSha256,
    sizeBytes: doc.sizeBytes,
    textBytes: doc.textBytes,
    chunkCount: doc.chunkCount,
  }
}

function sortedIds(items) {
  return items.map((item) => String(item.id)).sort()
}

export default [
  {
    id: 'det.kb.add-ls-show-deterministic',
    group: 'kb',
    title: 'kb add indexes markdown once, duplicates are skip-level, ls/show are byte-stable',
    async run() {
      return withFreshHome('kb-add', async (workdir) => {
        const checks = []
        const runs = []
        writeWorkFile(workdir, 'quote.md', QUOTE_MD)
        writeWorkFile(workdir, 'report.md', REPORT_MD)

        const add = runJsonCli(workdir, ['kb', 'add', 'quote.md', 'report.md', '--json'], { index: 'kb-add' })
        runs.push(add.run)
        check(checks, 'add.exit-0', () => {
          if (add.run.status !== 0) throw new Error('exit ' + add.run.status + ': ' + add.run.stderr.slice(0, 200))
        })
        check(checks, 'add.stdout-is-one-json-document', () => {
          jsonValue(add, 'kb add')
        })
        check(checks, 'add.stderr-empty', () => {
          if (add.run.stderr !== '') throw new Error(JSON.stringify(add.run.stderr.slice(0, 200)))
        })
        const added = jsonValue(add, 'kb add').added ?? []
        check(checks, 'add.batch-counts', () => {
          const counts = jsonValue(add, 'kb add').counts ?? {}
          if (counts.added !== 2 || counts.skipped !== 0 || counts.failed !== 0) throw new Error(JSON.stringify(counts))
          if (!(counts.chunks >= 2) || !(counts.textBytes > 0)) throw new Error(JSON.stringify(counts))
        })
        check(checks, 'add.documents-shape', () => {
          if (added.length !== 2) throw new Error('added.length=' + added.length)
          for (const item of added) {
            if (!/^kb_[0-9a-f]{16}$/.test(String(item.id))) throw new Error('id=' + item.id)
            if (!(item.chunks >= 1)) throw new Error('chunks=' + item.chunks)
            if (!(item.textBytes > 0)) throw new Error('textBytes=' + item.textBytes)
            if (item.truncated !== false || item.needsOcr !== false) throw new Error('truncated/needsOcr=' + item.truncated + '/' + item.needsOcr)
          }
          const titles = added.map((item) => item.title).sort()
          if (JSON.stringify(titles) !== JSON.stringify(['quote', 'report'])) throw new Error('titles=' + JSON.stringify(titles))
        })
        const quoteId = added.find((item) => item.title === 'quote')?.id

        const duplicate = runJsonCli(workdir, ['kb', 'add', 'quote.md', '--json'], { index: 'kb-add-duplicate' })
        runs.push(duplicate.run)
        check(checks, 'duplicate.exit-0', () => {
          if (duplicate.run.status !== 0) throw new Error('exit ' + duplicate.run.status + ': ' + duplicate.run.stderr.slice(0, 200))
        })
        check(checks, 'duplicate.is-skip-level', () => {
          const value = jsonValue(duplicate, 'kb add (duplicate)')
          if (value.counts?.added !== 0 || value.counts?.skipped !== 1 || value.counts?.failed !== 0) throw new Error(JSON.stringify(value.counts))
          const skipped = value.skipped?.[0] ?? {}
          if (skipped.code !== 'E_KB_DUPLICATE') throw new Error('skipped.code=' + skipped.code)
          if (skipped.existingId !== quoteId) throw new Error('existingId=' + skipped.existingId + ' expected ' + quoteId)
        })

        const ls1 = runJsonCli(workdir, ['kb', 'ls', '--json'], { index: 'kb-ls-1' })
        const ls2 = runJsonCli(workdir, ['kb', 'ls', '--json'], { index: 'kb-ls-2' })
        runs.push(ls1.run, ls2.run)
        check(checks, 'ls.exit-0', () => {
          if (ls1.run.status !== 0 || ls2.run.status !== 0) throw new Error('exit ' + ls1.run.status + '/' + ls2.run.status + ': ' + ls1.run.stderr.slice(0, 200))
        })
        check(checks, 'ls.bytes-identical', () => {
          if (ls1.run.stdout !== ls2.run.stdout) throw new Error('kb ls differs between two runs in the same home')
        })
        check(checks, 'ls.total-and-ids', () => {
          const value = jsonValue(ls1, 'kb ls')
          if (value.total !== 2) throw new Error('total=' + value.total)
          const actual = sortedIds(value.documents ?? [])
          const expected = sortedIds(added)
          if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify(actual))
          if (value.clearance !== 3) throw new Error('clearance=' + value.clearance)
          if (value.protectedExcluded !== 0) throw new Error('protectedExcluded=' + value.protectedExcluded)
        })
        check(checks, 'ls.document-contract', () => {
          const documents = jsonValue(ls1, 'kb ls').documents ?? []
          for (const doc of documents) {
            if (doc.sourceName !== 'quote.md' && doc.sourceName !== 'report.md') throw new Error('sourceName=' + doc.sourceName)
            if (!isSha256(doc.sourceSha256)) throw new Error('sourceSha256=' + doc.sourceSha256)
            if (!(doc.chunkCount >= 1)) throw new Error('chunkCount=' + doc.chunkCount)
          }
        })
        check(checks, 'ls.stdout-no-control-bytes', () => {
          const violations = controlViolations(ls1.run.stdout)
          if (violations.length) throw new Error(violations.join(','))
        })

        const show = runJsonCli(workdir, ['kb', 'show', quoteId, '--chunks', '5', '--json'], { index: 'kb-show' })
        runs.push(show.run)
        check(checks, 'show.exit-0', () => {
          if (show.run.status !== 0) throw new Error('exit ' + show.run.status + ': ' + show.run.stderr.slice(0, 200))
        })
        check(checks, 'show.document-and-chunk-preview', () => {
          const value = jsonValue(show, 'kb show')
          if (value.document?.id !== quoteId) throw new Error('id=' + value.document?.id)
          if (value.document?.sourceName !== 'quote.md') throw new Error('sourceName=' + value.document?.sourceName)
          if (!isSha256(value.document?.sourceSha256)) throw new Error('sourceSha256=' + value.document?.sourceSha256)
          if (!(value.chunksTotal >= 1)) throw new Error('chunksTotal=' + value.chunksTotal)
          if ((value.chunks ?? []).length !== Math.min(5, value.chunksTotal)) throw new Error('chunks=' + value.chunks?.length + ' chunksTotal=' + value.chunksTotal)
          const text = value.chunks?.[0]?.text
          if (typeof text !== 'string' || !text.includes('报价')) throw new Error('chunk text=' + JSON.stringify(text))
        })

        await withFreshHome('kb-add-second', async (second) => {
          writeWorkFile(second, 'quote.md', QUOTE_MD)
          writeWorkFile(second, 'report.md', REPORT_MD)
          const add2 = runJsonCli(second, ['kb', 'add', 'quote.md', 'report.md', '--json'], { index: 'kb-add-second' })
          const ls2nd = runJsonCli(second, ['kb', 'ls', '--json'], { index: 'kb-ls-second' })
          runs.push(add2.run, ls2nd.run)
          check(checks, 'cross-home.stable-content-fields', () => {
            const left = (jsonValue(ls1, 'kb ls').documents ?? []).map(stableDocFields).sort((a, b) => String(a.sourceName).localeCompare(String(b.sourceName)))
            const right = (jsonValue(ls2nd, 'kb ls (second home)').documents ?? []).map(stableDocFields).sort((a, b) => String(a.sourceName).localeCompare(String(b.sourceName)))
            const actual = JSON.stringify(left)
            const expected = JSON.stringify(right)
            if (actual !== expected) throw new Error('stable fields differ across fresh homes: ' + actual + ' != ' + expected)
          })
        })

        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  {
    id: 'det.kb.search-scope-degraded',
    group: 'kb',
    title: '2-char query degrades to LIKE, 3+ chars use FTS, scoped search is byte-stable',
    async run() {
      return withFreshHome('kb-search', async (workdir) => {
        const checks = []
        const runs = []
        writeWorkFile(workdir, 'quote.md', QUOTE_MD)
        const add = runJsonCli(workdir, ['kb', 'add', 'quote.md', '--json'], { index: 'kb-search-add' })
        runs.push(add.run)
        check(checks, 'add.exit-0', () => {
          if (add.run.status !== 0) throw new Error('exit ' + add.run.status + ': ' + add.run.stderr.slice(0, 200))
        })

        const short1 = runJsonCli(workdir, ['kb', 'search', '报价', '--json'], { index: 'kb-search-short-1' })
        const short2 = runJsonCli(workdir, ['kb', 'search', '报价', '--json'], { index: 'kb-search-short-2' })
        runs.push(short1.run, short2.run)
        check(checks, 'short.exit-0', () => {
          if (short1.run.status !== 0 || short2.run.status !== 0) throw new Error('exit ' + short1.run.status + '/' + short2.run.status + ': ' + short1.run.stderr.slice(0, 200))
        })
        check(checks, 'short.bytes-identical', () => {
          if (short1.run.stdout !== short2.run.stdout) throw new Error('2-char kb search differs between two runs')
        })
        check(checks, 'short.degraded-like-scan', () => {
          const value = jsonValue(short1, 'kb search 报价')
          if (value.command !== 'search' || value.scope !== 'kb') throw new Error('command/scope=' + value.command + '/' + value.scope)
          if (!Array.isArray(value.degraded) || !value.degraded.includes('short_query_like')) throw new Error('degraded=' + JSON.stringify(value.degraded))
          if (!(value.counts?.kbChunks >= 1)) throw new Error('counts=' + JSON.stringify(value.counts))
          if (!(value.total >= 1)) throw new Error('total=' + value.total)
        })
        check(checks, 'short.hit-contract', () => {
          const value = jsonValue(short1, 'kb search 报价')
          const hit = value.hits?.[0]
          if (!hit) throw new Error('no hits')
          if (hit.kind !== 'kb_chunk') throw new Error('kind=' + hit.kind)
          if (hit.matchPath !== 'like') throw new Error('matchPath=' + hit.matchPath)
          if (typeof hit.snippet !== 'string' || !hit.snippet.includes('报价')) throw new Error('snippet=' + JSON.stringify(hit.snippet))
          const highlight = hit.highlights?.[0]
          if (!highlight || !Number.isInteger(highlight.start) || !Number.isInteger(highlight.end)) throw new Error('highlights=' + JSON.stringify(hit.highlights))
          if (highlight.start < 0 || highlight.end <= highlight.start || highlight.end > hit.snippet.length) throw new Error('highlight out of snippet: ' + JSON.stringify(highlight))
          if (!/^chk_/.test(String(hit.ref?.id))) throw new Error('ref.id=' + hit.ref?.id)
        })

        const long1 = runJsonCli(workdir, ['kb', 'search', '官网改版', '--json'], { index: 'kb-search-long-1' })
        const long2 = runJsonCli(workdir, ['kb', 'search', '官网改版', '--json'], { index: 'kb-search-long-2' })
        runs.push(long1.run, long2.run)
        check(checks, 'long.exit-0', () => {
          if (long1.run.status !== 0 || long2.run.status !== 0) throw new Error('exit ' + long1.run.status + '/' + long2.run.status)
        })
        check(checks, 'long.bytes-identical', () => {
          if (long1.run.stdout !== long2.run.stdout) throw new Error('3+ char kb search differs between two runs')
        })
        check(checks, 'long.uses-fts-path', () => {
          const value = jsonValue(long1, 'kb search 官网改版')
          if ((value.degraded ?? []).includes('short_query_like')) throw new Error('degraded=' + JSON.stringify(value.degraded))
          if (!(value.total >= 1)) throw new Error('total=' + value.total)
          const hit = value.hits?.[0] ?? {}
          if (hit.kind !== 'kb_chunk') throw new Error('kind=' + hit.kind)
          if (hit.matchPath === 'like') throw new Error('3+ char query used the short-query LIKE path')
        })

        const scoped = runJsonCli(workdir, ['search', '报价', '--scope', 'kb', '--json'], { index: 'kb-search-scoped' })
        runs.push(scoped.run)
        check(checks, 'scoped.kb-alias-identical', () => {
          const alias = JSON.stringify(jsonValue(short1, 'kb search 报价'))
          const scopedValue = JSON.stringify(jsonValue(scoped, 'search --scope kb'))
          if (scopedValue !== alias) throw new Error('search --scope kb is not byte-identical to kb search')
        })
        check(checks, 'stdout-no-control-bytes', () => {
          const violations = [...controlViolations(short1.run.stdout), ...controlViolations(long1.run.stdout)]
          if (violations.length) throw new Error(violations.join(','))
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  {
    id: 'det.kb.page-rebuild-idempotent',
    group: 'kb',
    title: 'compiled pages rebuild deterministically and write only changed hashes',
    async run() {
      return withFreshHome('kb-pages', async (workdir) => {
        const checks = []
        const runs = []
        await seedKbLedger(workdir.home)
        const factsPageId = 'page_facts_' + sha256Hex('客户甲|' + KB_FIXTURE_MATTER_ID).slice(0, 12)
        const expectedIds = [
          'page_client_' + KB_FIXTURE_CLIENT_ID,
          factsPageId,
          'page_project_' + KB_FIXTURE_PROJECT_ID,
          'page_timeline_' + KB_FIXTURE_CLIENT_ID,
        ].sort()

        const dry1 = runJsonCli(workdir, ['kb', 'page', 'rebuild', '--dry-run', '--json'], { index: 'kb-page-dry-1' })
        const dry2 = runJsonCli(workdir, ['kb', 'page', 'rebuild', '--dry-run', '--json'], { index: 'kb-page-dry-2' })
        runs.push(dry1.run, dry2.run)
        check(checks, 'dry-run.exit-0', () => {
          if (dry1.run.status !== 0 || dry2.run.status !== 0) throw new Error('exit ' + dry1.run.status + '/' + dry2.run.status + ': ' + dry1.run.stderr.slice(0, 200))
        })
        check(checks, 'dry-run.plan-counts', () => {
          const value = jsonValue(dry1, 'kb page rebuild --dry-run')
          if (value.dryRun !== true) throw new Error('dryRun=' + value.dryRun)
          const counts = value.counts ?? {}
          if (counts.built !== 4 || counts.written !== 4 || counts.unchanged !== 0 || counts.skipped !== 0) throw new Error(JSON.stringify(counts))
          const actual = sortedIds(value.pages ?? [])
          if (JSON.stringify(actual) !== JSON.stringify(expectedIds)) throw new Error('page ids=' + JSON.stringify(actual))
        })
        check(checks, 'dry-run.bytes-identical', () => {
          if (dry1.run.stdout !== dry2.run.stdout) throw new Error('dry-run plan differs between two runs')
        })

        const write1 = runJsonCli(workdir, ['kb', 'page', 'rebuild', '--json'], { index: 'kb-page-rebuild-1' })
        runs.push(write1.run)
        check(checks, 'rebuild.first-writes-all', () => {
          if (write1.run.status !== 0) throw new Error('exit ' + write1.run.status + ': ' + write1.run.stderr.slice(0, 200))
          const value = jsonValue(write1, 'kb page rebuild')
          if (value.dryRun !== false) throw new Error('dryRun=' + value.dryRun)
          const counts = value.counts ?? {}
          if (counts.built !== 4 || counts.written !== 4 || counts.unchanged !== 0) throw new Error(JSON.stringify(counts))
          const actual = sortedIds(value.pages ?? [])
          if (JSON.stringify(actual) !== JSON.stringify(expectedIds)) throw new Error('page ids=' + JSON.stringify(actual))
        })
        const write2 = runJsonCli(workdir, ['kb', 'page', 'rebuild', '--json'], { index: 'kb-page-rebuild-2' })
        const write3 = runJsonCli(workdir, ['kb', 'page', 'rebuild', '--json'], { index: 'kb-page-rebuild-3' })
        runs.push(write2.run, write3.run)
        check(checks, 'rebuild.is-idempotent', () => {
          const value = jsonValue(write2, 'kb page rebuild (second)')
          const counts = value.counts ?? {}
          if (counts.built !== 4 || counts.written !== 0 || counts.unchanged !== 4) throw new Error(JSON.stringify(counts))
          if ((value.pages ?? []).length !== 0) throw new Error('pages=' + JSON.stringify(value.pages))
        })
        check(checks, 'rebuild.second-run-bytes-identical', () => {
          if (write2.run.stdout !== write3.run.stdout) throw new Error('unchanged rebuild output differs between two runs')
        })
        const dry3 = runJsonCli(workdir, ['kb', 'page', 'rebuild', '--dry-run', '--json'], { index: 'kb-page-dry-3' })
        const dry4 = runJsonCli(workdir, ['kb', 'page', 'rebuild', '--dry-run', '--json'], { index: 'kb-page-dry-4' })
        runs.push(dry3.run, dry4.run)
        check(checks, 'dry-run-after-write-empty-and-identical', () => {
          const value = jsonValue(dry3, 'kb page rebuild --dry-run (after write)')
          const counts = value.counts ?? {}
          if (counts.built !== 4 || counts.written !== 0 || counts.unchanged !== 4) throw new Error(JSON.stringify(counts))
          if (dry3.run.stdout !== dry4.run.stdout) throw new Error('post-write dry-run differs between two runs')
        })

        const ls1 = runJsonCli(workdir, ['kb', 'page', 'ls', '--check', '--json'], { index: 'kb-page-ls-1' })
        const ls2 = runJsonCli(workdir, ['kb', 'page', 'ls', '--check', '--json'], { index: 'kb-page-ls-2' })
        runs.push(ls1.run, ls2.run)
        check(checks, 'ls.exit-0', () => {
          if (ls1.run.status !== 0 || ls2.run.status !== 0) throw new Error('exit ' + ls1.run.status + '/' + ls2.run.status)
        })
        check(checks, 'ls.bytes-identical', () => {
          if (ls1.run.stdout !== ls2.run.stdout) throw new Error('kb page ls differs between two runs')
        })
        check(checks, 'ls.fresh-and-complete', () => {
          const value = jsonValue(ls1, 'kb page ls --check')
          if (value.staleCount !== 0) throw new Error('staleCount=' + value.staleCount)
          if (value.total !== 4) throw new Error('total=' + value.total)
          const actual = sortedIds(value.pages ?? [])
          if (JSON.stringify(actual) !== JSON.stringify(expectedIds)) throw new Error('page ids=' + JSON.stringify(actual))
          for (const page of value.pages ?? []) {
            if (page.stale !== false) throw new Error(page.id + ' stale=' + page.stale)
            if (!isSha256(page.inputsSha256)) throw new Error(page.id + ' inputsSha256=' + page.inputsSha256)
          }
        })

        const show = runJsonCli(workdir, ['kb', 'page', 'show', factsPageId, '--json'], { index: 'kb-page-show' })
        runs.push(show.run)
        check(checks, 'show.facts-page-live', () => {
          if (show.run.status !== 0) throw new Error('exit ' + show.run.status + ': ' + show.run.stderr.slice(0, 200))
          const value = jsonValue(show, 'kb page show')
          if (value.page?.id !== factsPageId) throw new Error('id=' + value.page?.id)
          if (value.page?.kind !== 'facts') throw new Error('kind=' + value.page?.kind)
          if (value.stale !== false) throw new Error('stale=' + value.stale)
          if (!isSha256(value.page?.inputsSha256)) throw new Error('inputsSha256=' + value.page?.inputsSha256)
          if (value.live?.inputsSha256 !== value.page?.inputsSha256) throw new Error('live hash differs from stored hash')
          if (typeof value.page?.markdown !== 'string' || !value.page.markdown.includes('90000')) throw new Error('facts page markdown does not render the selected fact')
        })

        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  {
    id: 'det.kb.fact-as-of-time-travel',
    group: 'kb',
    title: 'fact as-of selects the effective fact, honours validTo exclusivity and reports the fallback',
    async run() {
      return withFreshHome('kb-facts', async (workdir) => {
        const checks = []
        const runs = []
        await seedKbLedger(workdir.home)

        const early1 = runJsonCli(workdir, ['fact', 'as-of', '2026-03-01', '--json'], { index: 'kb-fact-early-1' })
        const early2 = runJsonCli(workdir, ['fact', 'as-of', '2026-03-01', '--json'], { index: 'kb-fact-early-2' })
        runs.push(early1.run, early2.run)
        check(checks, 'early.exit-0', () => {
          if (early1.run.status !== 0 || early2.run.status !== 0) throw new Error('exit ' + early1.run.status + '/' + early2.run.status + ': ' + early1.run.stderr.slice(0, 200))
        })
        check(checks, 'early.bytes-identical', () => {
          if (early1.run.stdout !== early2.run.stdout) throw new Error('fact as-of differs between two runs')
        })
        check(checks, 'early.window-and-counts', () => {
          const value = jsonValue(early1, 'fact as-of 2026-03-01')
          if (value.command !== 'fact as-of') throw new Error('command=' + value.command)
          if (value.at !== '2026-02-28T16:00:00.000Z') throw new Error('at=' + value.at)
          if (value.asOfLocalDay !== '2026-03-01') throw new Error('asOfLocalDay=' + value.asOfLocalDay)
          if (value.counts?.groups !== 2 || value.counts?.candidates !== 2 || value.counts?.overlappingGroups !== 0) throw new Error(JSON.stringify(value.counts))
          if (value.includeDeleted !== false || value.truncated !== false) throw new Error('includeDeleted/truncated=' + value.includeDeleted + '/' + value.truncated)
        })
        check(checks, 'early.selected-facts', () => {
          const items = jsonValue(early1, 'fact as-of 2026-03-01').items ?? []
          const quote = items.find((item) => item.predicate === 'quote.total')
          if (quote?.id !== 'fact_old' || quote?.object !== '80000' || quote?.status !== 'superseded') throw new Error('quote.total=' + JSON.stringify(quote))
          if (quote?.validTo !== '2026-06-01T00:00:00.000Z') throw new Error('validTo=' + quote?.validTo)
          const fallback = items.find((item) => item.predicate === 'contact.channel')
          if (fallback?.id !== 'fact_fallback' || fallback?.fallback?.validFromFromRecordedAt !== true) throw new Error('contact.channel=' + JSON.stringify(fallback))
        })
        check(checks, 'early.degraded-fallback-marker', () => {
          const degraded = jsonValue(early1, 'fact as-of 2026-03-01').degraded ?? []
          if (JSON.stringify(degraded) !== JSON.stringify(['valid_from_fallback_recorded_at'])) throw new Error('degraded=' + JSON.stringify(degraded))
        })

        const late = runJsonCli(workdir, ['fact', 'as-of', '2026-09-01', '--json'], { index: 'kb-fact-late' })
        runs.push(late.run)
        check(checks, 'late.selects-superseding-fact', () => {
          if (late.run.status !== 0) throw new Error('exit ' + late.run.status)
          const value = jsonValue(late, 'fact as-of 2026-09-01')
          if (value.at !== '2026-08-31T16:00:00.000Z') throw new Error('at=' + value.at)
          const quote = (value.items ?? []).find((item) => item.predicate === 'quote.total')
          if (quote?.id !== 'fact_new' || quote?.object !== '90000' || quote?.status !== 'confirmed') throw new Error('quote.total=' + JSON.stringify(quote))
        })
        const boundary = runJsonCli(workdir, ['fact', 'as-of', '2026-06-01T00:00:00Z', '--json'], { index: 'kb-fact-boundary' })
        runs.push(boundary.run)
        check(checks, 'boundary.valid-to-is-exclusive', () => {
          if (boundary.run.status !== 0) throw new Error('exit ' + boundary.run.status)
          const value = jsonValue(boundary, 'fact as-of 2026-06-01T00:00:00Z')
          if (value.at !== '2026-06-01T00:00:00.000Z') throw new Error('at=' + value.at)
          const quote = (value.items ?? []).find((item) => item.predicate === 'quote.total')
          if (quote?.id !== 'fact_new') throw new Error('at validTo the old fact must be excluded, got ' + JSON.stringify(quote))
        })

        const history = runJsonCli(workdir, ['fact', 'history', 'fact_new', '--json'], { index: 'kb-fact-history' })
        runs.push(history.run)
        check(checks, 'history.walks-the-chain', () => {
          if (history.run.status !== 0) throw new Error('exit ' + history.run.status)
          const value = jsonValue(history, 'fact history')
          const ids = (value.items ?? []).map((item) => item.id)
          if (JSON.stringify(ids) !== JSON.stringify(['fact_old', 'fact_new'])) throw new Error('ids=' + JSON.stringify(ids))
          if (value.counts?.items !== 2) throw new Error('counts=' + JSON.stringify(value.counts))
          if ((value.warnings ?? []).length !== 0) throw new Error('warnings=' + JSON.stringify(value.warnings))
        })
        const show = runJsonCli(workdir, ['fact', 'show', 'fact_fallback', '--json'], { index: 'kb-fact-show' })
        runs.push(show.run)
        check(checks, 'show.reports-recorded-at-fallback', () => {
          if (show.run.status !== 0) throw new Error('exit ' + show.run.status)
          const value = jsonValue(show, 'fact show')
          if (value.fact?.id !== 'fact_fallback') throw new Error('id=' + value.fact?.id)
          if (value.fact?.fallback?.validFromFromRecordedAt !== true) throw new Error('fallback=' + JSON.stringify(value.fact?.fallback))
          if (!(value.warnings ?? []).some((warning) => String(warning).includes('validFrom is missing'))) throw new Error('warnings=' + JSON.stringify(value.warnings))
          if ((value.kbSources ?? []).length !== 0) throw new Error('kbSources=' + JSON.stringify(value.kbSources))
        })

        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
]
