/**
 * Deterministic ledger fixture for the 0.3.0 determinism gate (`eval:det`).
 *
 * The CLI generates ids and timestamps from the wall clock, so a fixture seeded
 * through `advisers commit add` can never produce a stable `morning.dataSha256`.
 * We therefore write the ledger directly through the same store the CLI uses,
 * with an injected clock and id source (packages/core/src/ports.ts). The
 * resulting snapshot is byte-stable, so the morning hash can be a golden value.
 *
 * The data is synthetic and deliberately boring: two matters, three overdue
 * commitments, one due today, one waiting on a client, one unscheduled, one
 * upcoming, a weekly RRULE meeting and a same-day conflict. It exercises the
 * morning sections without timers, network or model calls.
 *
 * Bump FIXTURE_ID and re-run `node scripts/eval-det.mjs --update-baseline`
 * whenever the fixture changes. Do not re-record the baseline to make a real
 * regression green — review the diff first.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_ID = 'morning-ledger-v1'
export const FIXTURE_CLOCK = '2026-11-18T00:00:00.000Z'

const coreDist = new URL('../../../packages/core/dist/index.js', import.meta.url)

/** Load the built core; the monorepo must be built before `eval:det` runs. */
async function loadCore() {
  try {
    return await import(coreDist.href)
  } catch (error) {
    throw new Error('eval:det needs the built workspace (run `pnpm -r build` first): ' + String(error?.message ?? error))
  }
}

/**
 * Seed `home/state.db` with the deterministic fixture.
 * @param {string} home absolute path of an existing temp ADVISERS_HOME
 */
export async function seedMorningLedger(home) {
  const { Ledger } = await loadCore()
  const sqlite = await import(new URL('../../../packages/advisers/lib/sqlite.js', import.meta.url).href)
  const SqliteStore = sqlite.SqliteStore
  mkdirSync(home, { recursive: true })
  const store = new SqliteStore(join(home, 'state.db'))
  try {
    let seq = 0
    const clock = { now: () => FIXTURE_CLOCK }
    const ids = { next: (prefix) => prefix + '_' + (++seq) }
    const ledger = new Ledger({ clock, ids })
    const evidence = [{ sessionId: 'eval-fixture', turnId: 'turn-1', quote: 'deterministic eval fixture' }]
    const add = (input) => ledger.addCommitment({ evidence, ...input })

    const matterA = ledger.addMatter({ title: '客户甲 · 官网改版' })
    const matterB = ledger.addMatter({ title: '客户乙 · 年度续约' })

    add({ matterId: matterA.id, debtor: 'user', creditor: '客户甲', action: '发出首页视觉稿', dueAt: '2026-11-18T10:00:00+08:00' })
    add({ matterId: matterA.id, debtor: 'user', creditor: '客户甲', action: '补充移动端说明', dueAt: '2026-11-17' })
    add({ matterId: matterA.id, debtor: 'user', creditor: '客户甲', action: '整理需求清单' })
    add({ matterId: matterA.id, debtor: 'third:客户甲', creditor: '客户甲', action: '等待确认报价', dueAt: '2026-11-19' })
    add({ matterId: matterA.id, debtor: 'user', creditor: '客户甲', action: '交付周报', dueAt: '2026-11-20T18:00:00+08:00' })
    add({ matterId: matterB.id, debtor: 'user', creditor: '客户乙', action: '准备续约方案', dueAt: '2026-11-23' })
    add({ matterId: matterB.id, debtor: 'user', creditor: '客户乙', action: '明天项目例会', dueAt: '2026-11-19T10:00:00+08:00' })
    store.save(ledger.toJSON())

    const calendar = (uid, summary, startsAt, endsAt, rrule) => store.upsertCalendarEvent({
      uid, summary, startsAt, endsAt, allDay: false, tzid: 'Asia/Shanghai', rrule, source: 'eval-fixture.ics',
    })
    calendar('evt-weekly', '客户周会', '2026-11-10T10:00:00+08:00', '2026-11-10T11:00:00+08:00', 'FREQ=WEEKLY;BYDAY=TU;COUNT=10')
    calendar('evt-conflict-a', '评审会 A', '2026-11-20T10:00:00+08:00', '2026-11-20T11:00:00+08:00', null)
    calendar('evt-conflict-b', '评审会 B', '2026-11-20T10:30:00+08:00', '2026-11-20T11:30:00+08:00', null)
  } finally {
    store.close()
  }
}

/** `--now` for every golden/stable run: 2026-11-20 09:00 Asia/Shanghai. */
export const GOLDEN_NOW = '2026-11-20T01:00:00.000Z'
/** A later time on the same Shanghai day (11:00) — the hash must not move. */
export const SAME_DAY_NOW = '2026-11-20T03:00:00.000Z'
/** The next Shanghai day — the hash must move. */
export const NEXT_DAY_NOW = '2026-11-21T01:00:00.000Z'
/** A commitment added after the golden run (data change -> hash must move). */
export const EXTRA_COMMITMENT = ['commit', 'add', '新增一条评测承诺', '--quote', 'eval', '--due', '2026-11-25']

/** Resolve the repo bin for cases that need the path (harness exports it too). */
export const BIN_PATH = fileURLToPath(new URL('../../../packages/advisers/bin/advisers.js', import.meta.url))
