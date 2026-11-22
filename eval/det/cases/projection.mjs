/**
 * 0.5.0 WF4 G3: CLI / MCP / DSH projection parity (group `projection`, 5 cases).
 *
 * The three read surfaces must project the same ledger identically for the rows
 * a reader is allowed to see:
 *   - CLI `today|who|client list --json` runs as the local owner (clearance 3);
 *   - MCP `advisers_today|who|clients` and DSH `todayView|whoView|clientsView`
 *     read at clearance 0 and only count protected rows (`protectedExcluded`),
 *     never echoing their ids/actions;
 *   - MCP keeps the true post-clearance count in `total`/`open` even when the
 *     row list is capped, and DSH caps each today bucket while keeping counts;
 *   - with no real ledger (JSON store / missing home) MCP returns a structured
 *     tool error and DSH returns the marked preview without creating a HOME.
 *
 * Same rules as the rest of the suite: temp ADVISERS_HOME, fixed TZ, no model,
 * no network. DSH is read in-process through createLedgerReader({home}); MCP is
 * the shipped `advisers mcp --stdio` child behind the network-block preload.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MCP_OUTPUT_LIMITS } from '../../../packages/advisers/lib/mcp-server.js'
import { createLedgerReader } from '../../../packages/dsh-advisers/lib/read.js'
import { check, cleanupWorkdir, createWorkdir, runMcp } from '../lib/harness.mjs'
import {
  checkNoNetwork,
  jsonValue,
  openStateStore,
  runJsonCli,
  seedAcceptedTos,
} from './_fixture.mjs'

const PUBLIC_MATTER = 'm_public'
const SECRET_MATTER = 'm_secret'
const PUBLIC_CLIENT = 'cl_public'
const SECRET_CLIENT = 'cl_secret'
const SECRET_ACTION = 'secret acquisition target'
const SECRET_COMMITMENT = 'cm_secret'

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000

/** Local-day string (Asia/Shanghai) for the wall clock of this run. */
function shanghaiDay(ms) {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

/** Add `days` calendar days to a YYYY-MM-DD day string. */
function addDays(day, days) {
  return new Date(Date.parse(day + 'T00:00:00.000Z') + days * 86400_000).toISOString().slice(0, 10)
}

/** Shanghai-noon ISO instant for a YYYY-MM-DD day string. */
function noonOf(day) {
  return day + 'T12:00:00+08:00'
}

/**
 * Seed the projection fixture: one public matter/client and one secrecy=2
 * matter/client, five public open commitments (overdue/today/week/waiting/no-due)
 * and one protected commitment. `extra` adds more public commitments.
 */
async function seedProjectionLedger(home, { extraNoDue = 0 } = {}) {
  seedAcceptedTos(home)
  const today = shanghaiDay(Date.now())
  const store = await openStateStore(home)
  try {
    const createdAt = '2026-01-01T00:00:00.000Z'
    store.mutate(() => {
      store.insertMatter({ id: PUBLIC_MATTER, title: 'Q4', status: 'active', domain: 'work', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt, updatedAt: createdAt })
      store.insertMatter({ id: SECRET_MATTER, title: 'M&A', status: 'active', domain: 'work', secrecy: 2, participants: [], deadlines: [], openQuestions: [], createdAt, updatedAt: createdAt })
      const commitment = (id, matterId, debtor, creditor, action, dueAt) => store.insertCommitment({
        id, matterId, debtor, creditor, action, timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none',
        ...(dueAt ? { dueAt } : {}),
      })
      commitment('cm_today', PUBLIC_MATTER, 'user', 'boss', 'send the Q4 deck', noonOf(today))
      commitment('cm_overdue', PUBLIC_MATTER, 'user', 'boss', 'file the overdue report', noonOf(addDays(today, -2)))
      commitment('cm_week', PUBLIC_MATTER, 'user', 'boss', 'book the review meeting', noonOf(addDays(today, 2)))
      commitment('cm_third', PUBLIC_MATTER, 'third:alice', 'me', 'alice sends the signed contract', noonOf(addDays(today, 3)))
      commitment('cm_nodue', PUBLIC_MATTER, 'agent', 'me', 'untimed follow-up')
      commitment(SECRET_COMMITMENT, SECRET_MATTER, 'user', 'boss', SECRET_ACTION, noonOf(today))
      for (let index = 0; index < extraNoDue; index += 1) {
        const suffix = String(index).padStart(2, '0')
        commitment('cm_filler_' + suffix, PUBLIC_MATTER, 'agent', 'me', 'untimed follow-up ' + suffix)
      }
    })
    store.addClient({ name: '客户甲', id: PUBLIC_CLIENT })
    store.addClient({ name: '客户乙', id: SECRET_CLIENT })
    store.setMatterClient(PUBLIC_MATTER, { clientId: PUBLIC_CLIENT })
    store.setMatterClient(SECRET_MATTER, { clientId: SECRET_CLIENT })
  } finally {
    store.close()
  }
}

/** Run `fn(workdir)` on a seeded projection home, always clean up. */
async function withProjectionHome(label, fn, { extraNoDue = 0 } = {}) {
  const workdir = createWorkdir('projection-' + label)
  try {
    await seedProjectionLedger(workdir.home, { extraNoDue })
    return await fn(workdir)
  } finally {
    cleanupWorkdir(workdir)
  }
}

function flattenToday(cli) {
  const buckets = ['overdue', 'today', 'week', 'waiting', 'noDue']
  const rows = []
  for (const bucket of buckets) for (const row of cli[bucket] ?? []) rows.push(row)
  return { rows, buckets }
}

/** CLI today rows minus records of protected matters (owner view -> clearance 0). */
function visibleTodayCli(cli) {
  const { rows } = flattenToday(cli)
  const visible = rows.filter((row) => row.matterId !== SECRET_MATTER)
  // A third-party row can appear in both the `week` and `waiting` buckets of the
  // CLI view (the waiting marker overlaps the due-date buckets), so the open
  // total is the number of unique commitment ids, not the sum of the buckets.
  const uniqueIds = new Set(visible.map((row) => row.id))
  const counts = { overdue: 0, today: 0, week: 0, waiting: 0, noDue: 0 }
  for (const bucket of Object.keys(counts)) counts[bucket] = (cli[bucket] ?? []).filter((row) => row.matterId !== SECRET_MATTER).length
  return { visible, counts, open: uniqueIds.size }
}

function toolPayload(run, id, label) {
  const response = run.response(id)
  if (!response) throw new Error(label + ': no JSON-RPC response ' + JSON.stringify(run.unparsable))
  if (response.error) throw new Error(label + ': rpc error ' + JSON.stringify(response.error))
  const result = response.result
  if (!result || !Array.isArray(result.content)) throw new Error(label + ': no content array')
  const text = result.content[0]?.text
  if (typeof text !== 'string') throw new Error(label + ': not a text payload')
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error(label + ': payload is not JSON: ' + text.slice(0, 160)) }
  if (result.isError === true) throw new Error(label + ' isError: ' + JSON.stringify(payload).slice(0, 300))
  return payload
}

function sortedIds(rows, key = 'id') {
  return (rows ?? []).map((row) => String(row[key])).sort()
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function assertEqual(actual, expected, label) {
  const left = JSON.stringify(canonicalize(actual))
  const right = JSON.stringify(canonicalize(expected))
  if (left !== right) throw new Error(label + ': ' + left + ' != ' + right)
}

/** Unique rows by id (a CLI row can appear in two overlapping buckets). */
function uniqueRows(rows) {
  return [...new Map((rows ?? []).map((row) => [String(row.id), row])).values()]
}

const TODAY_TOOL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'advisers_today', arguments: {} } }
const WHO_TOOL = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'advisers_who', arguments: {} } }
const CLIENTS_TOOL = (id = 3, action = 'list', args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'advisers_clients', arguments: { action, ...args } } })

function assertNoProtectedLeak(value, label) {
  const text = JSON.stringify(value)
  // Client identity is intentionally visible at clearance 0 (with zeroed counts
  // and protectedExcluded); commitment ids, their actions and matter ids are not.
  for (const needle of [SECRET_COMMITMENT, SECRET_MATTER, SECRET_ACTION]) {
    if (text.includes(needle)) throw new Error(label + ' leaked ' + needle)
  }
}

export default [
  {
    id: 'det.projection.today-parity',
    group: 'projection',
    title: 'today: CLI/owner rows minus protected matters equal MCP and DSH counts and ids',
    async run() {
      return withProjectionHome('today', async (workdir) => {
        const checks = []
        const runs = []
        const cli = runJsonCli(workdir, ['today', '--json'], { index: 'projection-today-cli' })
        runs.push(cli.run)
        const mcp = runMcp(workdir, [TODAY_TOOL])
        runs.push(mcp)
        const reader = createLedgerReader({ home: workdir.home })
        const dsh = await reader.todayView()
        check(checks, 'cli-exits-0', () => {
          if (cli.run.status !== 0) throw new Error('exit ' + cli.run.status + ': ' + cli.run.stderr.slice(0, 200))
          jsonValue(cli, 'today --json')
        })
        check(checks, 'cli-owner-sees-protected-row', () => {
          const value = jsonValue(cli, 'today --json')
          const { rows } = flattenToday(value)
          if (!rows.some((row) => row.id === SECRET_COMMITMENT)) throw new Error('fixture: CLI owner view does not contain the protected row')
        })
        check(checks, 'dsh-reads-the-real-ledger', () => {
          if (dsh.data.preview !== false || dsh.data.source !== 'ledger-readonly') throw new Error('DSH did not read the ledger: preview=' + dsh.data.preview + ' source=' + dsh.data.source)
          if (dsh.data.clearance !== 0) throw new Error('DSH clearance=' + dsh.data.clearance)
        })
        check(checks, 'counts-parity', () => {
          const visible = visibleTodayCli(jsonValue(cli, 'today --json'))
          const expected = { ...visible.counts, open: visible.open }
          assertEqual(dsh.data.counts, expected, 'DSH counts')
        })
        check(checks, 'bucket-order-parity-cli-vs-dsh', () => {
          const value = jsonValue(cli, 'today --json')
          for (const bucket of ['overdue', 'today', 'week', 'waiting', 'noDue']) {
            const expected = (value[bucket] ?? []).filter((row) => row.matterId !== SECRET_MATTER).map((row) => row.id)
            const actual = (dsh.data[bucket] ?? []).map((row) => row.id)
            assertEqual(actual, expected, 'DSH ' + bucket + ' order')
          }
        })
        check(checks, 'mcp-counts-and-ids', () => {
          const payload = toolPayload(mcp, 1, 'advisers_today')
          const visible = visibleTodayCli(jsonValue(cli, 'today --json'))
          if (payload.open !== visible.open || payload.total !== visible.open) throw new Error('open/total=' + payload.open + '/' + payload.total)
          if (payload.clearance !== 0) throw new Error('clearance=' + payload.clearance)
          if (payload.protectedExcluded !== 1) throw new Error('protectedExcluded=' + payload.protectedExcluded)
          if (payload.truncated !== false) throw new Error('truncated=' + payload.truncated)
          assertEqual(sortedIds(payload.commitments), sortedIds(uniqueRows(visible.visible)), 'MCP today ids')
        })
        check(checks, 'protected-not-leaked-through-mcp-or-dsh', () => {
          assertNoProtectedLeak(toolPayload(mcp, 1, 'advisers_today'), 'MCP today')
          assertNoProtectedLeak(dsh.data, 'DSH today')
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  {
    id: 'det.projection.who-parity',
    group: 'projection',
    title: 'who: mine/waiting sets and totals match across the three surfaces',
    async run() {
      return withProjectionHome('who', async (workdir) => {
        const checks = []
        const runs = []
        const cli = runJsonCli(workdir, ['who', '--json'], { index: 'projection-who-cli' })
        runs.push(cli.run)
        const mcp = runMcp(workdir, [WHO_TOOL])
        runs.push(mcp)
        const dsh = await createLedgerReader({ home: workdir.home }).whoView()
        check(checks, 'cli-exits-0', () => {
          if (cli.run.status !== 0) throw new Error('exit ' + cli.run.status + ': ' + cli.run.stderr.slice(0, 200))
        })
        check(checks, 'cli-owner-view-has-protected-row', () => {
          const value = jsonValue(cli, 'who --json')
          const rows = [...(value.mine ?? []), ...(value.waiting ?? [])]
          if (!rows.some((row) => row.id === SECRET_COMMITMENT)) throw new Error('fixture: CLI who does not contain the protected row')
        })
        check(checks, 'dsh-counts-and-sets', () => {
          const value = jsonValue(cli, 'who --json')
          const visible = [...(value.mine ?? []), ...(value.waiting ?? [])].filter((row) => row.matterId !== SECRET_MATTER)
          const mine = visible.filter((row) => row.debtor === 'user' || row.debtor === 'agent')
          const waiting = visible.filter((row) => row.debtor === 'third' || String(row.debtor).startsWith('third:'))
          assertEqual(dsh.data.counts, { mine: mine.length, waiting: waiting.length, open: visible.length }, 'DSH who counts')
          assertEqual(sortedIds(dsh.data.mine), sortedIds(mine), 'DSH who mine')
          assertEqual(sortedIds(dsh.data.waiting), sortedIds(waiting), 'DSH who waiting')
          if (dsh.data.protectedExcluded !== 1) throw new Error('DSH protectedExcluded=' + dsh.data.protectedExcluded)
        })
        check(checks, 'mcp-counts-and-sets', () => {
          const value = jsonValue(cli, 'who --json')
          const visible = [...(value.mine ?? []), ...(value.waiting ?? [])].filter((row) => row.matterId !== SECRET_MATTER)
          const mine = visible.filter((row) => row.debtor === 'user' || row.debtor === 'agent')
          const waiting = visible.filter((row) => row.debtor === 'third' || String(row.debtor).startsWith('third:'))
          const payload = toolPayload(mcp, 2, 'advisers_who')
          if (payload.mineTotal !== mine.length || payload.waitingTotal !== waiting.length) throw new Error('mineTotal/waitingTotal=' + payload.mineTotal + '/' + payload.waitingTotal)
          if (payload.protectedExcluded !== 1) throw new Error('protectedExcluded=' + payload.protectedExcluded)
          if (payload.truncated !== false) throw new Error('truncated=' + payload.truncated)
          assertEqual(sortedIds(payload.mine), sortedIds(mine), 'MCP who mine')
          assertEqual(sortedIds(payload.waiting), sortedIds(waiting), 'MCP who waiting')
        })
        check(checks, 'protected-not-leaked', () => {
          assertNoProtectedLeak(toolPayload(mcp, 2, 'advisers_who'), 'MCP who')
          assertNoProtectedLeak(dsh.data, 'DSH who')
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  {
    id: 'det.projection.clients-parity',
    group: 'projection',
    title: 'clients: list/show rows match for unprotected clients and hide protected ones',
    async run() {
      return withProjectionHome('clients', async (workdir) => {
        const checks = []
        const runs = []
        const cliList = runJsonCli(workdir, ['client', 'list', '--json'], { index: 'projection-clients-cli' })
        runs.push(cliList.run)
        const mcpRun = runMcp(workdir, [CLIENTS_TOOL(3, 'list'), CLIENTS_TOOL(4, 'show', { id: PUBLIC_CLIENT })])
        runs.push(mcpRun)
        const reader = createLedgerReader({ home: workdir.home })
        const dshList = await reader.clientsView({ action: 'list' })
        const dshShow = await reader.clientsView({ action: 'show', id: PUBLIC_CLIENT })
        check(checks, 'cli-exits-0', () => {
          if (cliList.run.status !== 0) throw new Error('exit ' + cliList.run.status + ': ' + cliList.run.stderr.slice(0, 200))
        })
        check(checks, 'list-order-and-unprotected-parity', () => {
          const cliRows = jsonValue(cliList, 'client list --json')
          const mcpPayload = toolPayload(mcpRun, 3, 'advisers_clients list')
          const cliIds = cliRows.map((row) => row.id)
          assertEqual(cliIds, mcpPayload.clients.map((row) => row.id), 'list order cli/mcp')
          assertEqual(dshList.data.clients.map((row) => row.id), cliIds, 'list order dsh')
          const publicRow = (rows) => rows.find((row) => row.id === PUBLIC_CLIENT)
          assertEqual(publicRow(mcpPayload.clients).counts, publicRow(cliRows).counts, 'public client counts cli/mcp')
          assertEqual(publicRow(dshList.data.clients).counts, publicRow(cliRows).counts, 'public client counts cli/dsh')
          assertEqual(publicRow(mcpPayload.clients).nextDueAt, publicRow(cliRows).nextDueAt, 'public nextDueAt')
        })
        check(checks, 'protected-client-is-counted-not-shown', () => {
          const cliRows = jsonValue(cliList, 'client list --json')
          const mcpPayload = toolPayload(mcpRun, 3, 'advisers_clients list')
          const cliSecret = cliRows.find((row) => row.id === SECRET_CLIENT)
          const mcpSecret = mcpPayload.clients.find((row) => row.id === SECRET_CLIENT)
          const dshSecret = dshList.data.clients.find((row) => row.id === SECRET_CLIENT)
          if (!cliSecret) throw new Error('fixture: CLI owner view has no protected client row')
          if (!mcpSecret || !dshSecret) throw new Error('readers hid the client row entirely instead of zeroing it')
          if (cliSecret.counts.matters !== 1) throw new Error('fixture: CLI protected client matters=' + cliSecret.counts.matters)
          if (mcpSecret.counts.matters !== 0 || mcpSecret.counts.commitments !== 0) throw new Error('MCP protected client counts=' + JSON.stringify(mcpSecret.counts))
          if (mcpSecret.protectedExcluded !== 1) throw new Error('MCP protectedExcluded=' + mcpSecret.protectedExcluded)
          if (dshSecret.counts.matters !== 0 || dshSecret.protectedExcluded !== 1) throw new Error('DSH protected client=' + JSON.stringify(dshSecret))
        })
        check(checks, 'show-parity', () => {
          const cliShow = jsonValue(runJsonCli(workdir, ['client', 'show', PUBLIC_CLIENT, '--json'], { index: 'projection-client-show-cli' }), 'client show')
          const mcpShow = toolPayload(mcpRun, 4, 'advisers_clients show')
          assertEqual(mcpShow.counts, cliShow.counts, 'show counts cli/mcp')
          assertEqual(dshShow.data.counts, cliShow.counts, 'show counts cli/dsh')
          assertEqual(sortedIds(mcpShow.open.mine), sortedIds(cliShow.open.mine), 'show open mine cli/mcp')
          assertEqual(sortedIds(dshShow.data.open.mine), sortedIds(cliShow.open.mine), 'show open mine cli/dsh')
          if (mcpShow.projects.length !== 0 || dshShow.data.projects.length !== 0) throw new Error('fixture: unexpected projects in the client show view')
        })
        check(checks, 'protected-not-leaked', () => {
          assertNoProtectedLeak(toolPayload(mcpRun, 3, 'advisers_clients list'), 'MCP clients')
          assertNoProtectedLeak(toolPayload(mcpRun, 4, 'advisers_clients show'), 'MCP client show')
          assertNoProtectedLeak(dshList.data, 'DSH clients')
          assertNoProtectedLeak(dshShow.data, 'DSH client show')
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      })
    },
  },
  {
    id: 'det.projection.caps-and-truncation',
    group: 'projection',
    title: 'caps never hide the true post-clearance count (MCP total, DSH counts)',
    async run() {
      return withProjectionHome('caps', async (workdir) => {
        const checks = []
        const runs = []
        const cli = runJsonCli(workdir, ['today', '--json'], { index: 'projection-caps-cli' })
        runs.push(cli.run)
        const mcp = runMcp(workdir, [TODAY_TOOL])
        runs.push(mcp)
        const dsh = await createLedgerReader({ home: workdir.home }).todayView()
        check(checks, 'cli-truth-counts', () => {
          if (cli.run.status !== 0) throw new Error('exit ' + cli.run.status + ': ' + cli.run.stderr.slice(0, 200))
          const value = jsonValue(cli, 'today --json')
          if (value.counts?.noDue !== 23) throw new Error('fixture: CLI noDue=' + value.counts?.noDue)
        })
        check(checks, 'mcp-caps-rows-but-keeps-total', () => {
          const payload = toolPayload(mcp, 1, 'advisers_today (caps)')
          const value = jsonValue(cli, 'today --json')
          const visible = visibleTodayCli(value)
          if (payload.open !== visible.open || payload.total !== visible.open) throw new Error('MCP open/total=' + payload.open + '/' + payload.total + ' expected ' + visible.open)
          if (payload.commitments.length !== MCP_OUTPUT_LIMITS.todayCommitments) throw new Error('MCP rows=' + payload.commitments.length)
          if (payload.truncated !== true) throw new Error('MCP truncated=' + payload.truncated)
          const known = new Set(visible.visible.map((row) => row.id))
          for (const id of payload.commitments.map((row) => row.id)) if (!known.has(id)) throw new Error('MCP returned an unknown/protected id ' + id)
        })
        check(checks, 'dsh-caps-buckets-but-keeps-counts', () => {
          const value = jsonValue(cli, 'today --json')
          const visible = visibleTodayCli(value)
          if (dsh.data.counts.open !== visible.open) throw new Error('DSH open=' + dsh.data.counts.open + ' expected ' + visible.open)
          if (dsh.data.counts.noDue !== visible.counts.noDue) throw new Error('DSH noDue=' + dsh.data.counts.noDue)
          if (dsh.data.truncated !== true) throw new Error('DSH truncated=' + dsh.data.truncated)
          if (!(dsh.data.noDue.length < dsh.data.counts.noDue)) throw new Error('DSH noDue rows=' + dsh.data.noDue.length + ' count=' + dsh.data.counts.noDue)
        })
        check(checks, 'all-unprotected-rows-accounted-for', () => {
          const value = jsonValue(cli, 'today --json')
          const visible = visibleTodayCli(value)
          const payload = toolPayload(mcp, 1, 'advisers_today (caps)')
          if (payload.protectedExcluded !== 1) throw new Error('MCP protectedExcluded=' + payload.protectedExcluded)
          if (dsh.data.protectedExcluded !== 1) throw new Error('DSH protectedExcluded=' + dsh.data.protectedExcluded)
          if (payload.total + payload.protectedExcluded !== 28) throw new Error('MCP total+protected=' + (payload.total + payload.protectedExcluded))
          if (visible.open + 1 !== 28) throw new Error('CLI visible+protected=' + (visible.open + 1))
        })
        checkNoNetwork(checks, 'no-network', runs)
        return { checks }
      }, { extraNoDue: 22 })
    },
  },
  {
    id: 'det.projection.protected-and-fallback',
    group: 'projection',
    title: 'protected records stay counted-only and a missing ledger yields structured fallbacks',
    async run() {
      const checks = []
      const runs = []
      await withProjectionHome('protected', async (workdir) => {
        const mcp = runMcp(workdir, [TODAY_TOOL, WHO_TOOL, CLIENTS_TOOL(3, 'list')])
        runs.push(mcp)
        const reader = createLedgerReader({ home: workdir.home })
        const today = await reader.todayView()
        const who = await reader.whoView()
        const clients = await reader.clientsView({ action: 'list' })
        check(checks, 'protected-excluded-counts', () => {
          const payloads = { today: toolPayload(mcp, 1, 'advisers_today'), who: toolPayload(mcp, 2, 'advisers_who'), clients: toolPayload(mcp, 3, 'advisers_clients') }
          if (payloads.today.protectedExcluded !== 1) throw new Error('MCP today protectedExcluded=' + payloads.today.protectedExcluded)
          if (payloads.who.protectedExcluded !== 1) throw new Error('MCP who protectedExcluded=' + payloads.who.protectedExcluded)
          if (payloads.clients.protectedExcluded !== 1) throw new Error('MCP clients protectedExcluded=' + payloads.clients.protectedExcluded)
          if (today.data.protectedExcluded !== 1 || who.data.protectedExcluded !== 1 || clients.data.protectedExcluded !== 1) throw new Error('DSH protectedExcluded=' + today.data.protectedExcluded + '/' + who.data.protectedExcluded + '/' + clients.data.protectedExcluded)
        })
        check(checks, 'protected-ids-never-leak', () => {
          for (const payload of [toolPayload(mcp, 1, 'today'), toolPayload(mcp, 2, 'who'), toolPayload(mcp, 3, 'clients')]) assertNoProtectedLeak(payload, 'MCP protected')
          assertNoProtectedLeak(today.data, 'DSH today')
          assertNoProtectedLeak(who.data, 'DSH who')
          assertNoProtectedLeak(clients.data, 'DSH clients')
        })
      })
      // Fallback: JSON store / missing ledger. MCP returns a structured tool
      // error; DSH returns the marked preview and never creates the HOME.
      const fallbackRoot = mkdtempSync(join(tmpdir(), 'advisers-eval-projection-fallback-'))
      const fallbackHome = join(fallbackRoot, 'home')
      try {
        mkdirSync(fallbackHome, { recursive: true })
        const jsonMcp = runMcp({ ...createWorkdirStub(fallbackHome) }, [CLIENTS_TOOL(9, 'list')], { extra: { ADVISERS_STORE: 'json' } })
        runs.push(jsonMcp)
        check(checks, 'mcp-json-store-structured-error', () => {
          const response = jsonMcp.response(9)
          if (!response) throw new Error('no JSON-RPC response')
          const result = response.result ?? {}
          if (result.isError !== true) throw new Error('MCP clients on a JSON store was not an error result: ' + JSON.stringify(result).slice(0, 200))
          const text = String(result.content?.[0]?.text ?? '')
          if (!/SQLite ledger/.test(text)) throw new Error('MCP error text=' + text.slice(0, 200))
        })
        const emptyHome = join(fallbackRoot, 'empty-home')
        if (existsSync(emptyHome)) rmSync(emptyHome, { recursive: true, force: true })
        const before = existsSync(emptyHome)
        // The DSH bundle always supplies the in-memory service; a preview read
        // with no ledger must render from it (empty) instead of throwing.
        const previewRuntime = { ledger: { openCommitments: () => [] } }
        const emptyReader = createLedgerReader({ home: emptyHome }, { runtime: previewRuntime })
        const previewToday = await emptyReader.todayView()
        const previewWho = await emptyReader.whoView()
        const previewClients = await emptyReader.clientsView({ action: 'list' })
        check(checks, 'dsh-preview-without-home', () => {
          if (before) throw new Error('fixture: the empty home exists before the read')
          if (previewToday.data.preview !== true || previewToday.data.source !== 'preview-no-ledger') throw new Error('DSH today preview=' + previewToday.data.preview + '/' + previewToday.data.source)
          if (previewWho.data.preview !== true) throw new Error('DSH who preview=' + previewWho.data.preview)
          if (previewClients.data.preview !== true) throw new Error('DSH clients preview=' + previewClients.data.preview)
          if (previewClients.data.customerEntities !== false) throw new Error('DSH clients customerEntities=' + previewClients.data.customerEntities)
          if (JSON.stringify(previewClients.data.clients) !== '[]') throw new Error('DSH preview invented clients')
          if (existsSync(emptyHome)) throw new Error('a DSH preview read created the HOME')
        })
      } finally {
        rmSync(fallbackRoot, { recursive: true, force: true })
      }
      checkNoNetwork(checks, 'no-network', runs)
      return { checks }
    },
  },
]

/** Minimal workdir shape for runMcp on an already-created HOME. */
function createWorkdirStub(home) {
  return { root: home, home, work: home, net: join(home, '.net') }
}

