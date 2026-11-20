import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Ledger } from '../../core/dist/index.js'
import { isEvidenceRecordAboveClearance } from '../lib/evidence.js'
import { SqliteStore } from '../lib/sqlite.js'
import { createMcpServer } from '../lib/mcp-server.js'

// 0.3.2 P2-1: narrow commitment read model for the MCP list tools.
//
// The injected narrow path (SqliteStore.projectCommitmentReadModel -> today /
// commit_ls / who / remind) must be BYTE-IDENTICAL to the legacy path that loads
// the full ledger, across every status/clearance/secrecy case. The legacy path
// remains the default when the loaders are not injected (embedders/tests and the
// JSON store), so these tests act as the drift gate for the optimization.

const NOW = () => new Date('2026-11-20T03:00:00.000Z')
const AT = '2026-01-01T00:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000

function seed(store) {
  store.mutate(() => {
    const matter = (id, secrecy) => store.insertMatter({
      id, title: id, status: 'active', domain: 'work', secrecy,
      participants: [], deadlines: [], openQuestions: [], createdAt: AT, updatedAt: AT,
    })
    matter('m_public', 0)
    matter('m_secret', 2)
    matter('m_high', 3)
    const commitment = (id, matterId, debtor, action, extra = {}) => store.insertCommitment({
      id, matterId, debtor, creditor: 'creditor-' + id, action,
      timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none', createdAt: AT, ...extra,
    })
    // Deliberately scrambled ids: output order must stay rowid/insertion order.
    commitment('cm_20', 'm_public', 'user', 'public user')
    commitment('cm_03', 'm_public', 'third:alice', 'public waiting', { dueAt: new Date(Date.now() - DAY).toISOString() })
    commitment('cm_11', 'm_secret', 'user', 'secret user')
    commitment('cm_05', 'm_public', 'agent', 'public agent', { reminderOffsets: [1, 3] })
    commitment('cm_30', 'm_gone', 'user', 'dangling matter')
    commitment('cm_02', 'm_high', 'user', 'high secrecy')
    commitment('cm_19', 'm_public', 'user', 'done one', { status: 'done', doneAt: new Date().toISOString() })
    commitment('cm_07', 'm_public', 'third:bob', 'dropped one', { status: 'dropped' })
    commitment('cm_21', 'm_public', 'user', 'custom offsets malformed', { reminderOffsets: { custom: 1 } })
    commitment('cm_09', 'm_public', 'user', 'due today', { dueAt: new Date(Date.now()).toISOString() })
    commitment('cm_13', 'm_public', 'user', 'future row', { dueAt: new Date(Date.now() + 3 * DAY).toISOString() })
    commitment('cm_01', 'm_public', 'user', 'no due')
  })
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-mcp-read-model-'))
  const store = new SqliteStore(join(root, 'state.db'))
  seed(store)
  const matters = store.loadMatters()
  const legacy = Ledger.fromParts({ version: 1, matters, commitments: store.loadCommitments() })
  const view = (options) => store.read(() => store.projectCommitmentReadModel(options))
  const recordsMap = (ids) => store.read(() => {
    const byId = new Map()
    for (const id of ids) {
      const record = store.getCommitment(id)
      if (record) byId.set(id, record)
    }
    return byId
  })
  const recordsArray = (ids) => store.read(() => ids.map((id) => store.getCommitment(id)).filter(Boolean))
  const cleanup = () => {
    try { store.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
  return { root, store, matters, legacy, view, recordsMap, recordsArray, cleanup }
}

function serverPair(f, clearance, { records = 'map' } = {}) {
  const oldServer = createMcpServer({ ledger: f.legacy, version: '0.3.2-test', now: NOW, clearance })
  const newServer = createMcpServer({
    store: f.store,
    loadCommitmentView: f.view,
    loadCommitmentRecords: records === 'array' ? f.recordsArray : f.recordsMap,
    version: '0.3.2-test',
    now: NOW,
    clearance,
  })
  return { oldServer, newServer }
}

async function callText(server, method, params) {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) })
  if (response.error) throw new Error(JSON.stringify(response.error))
  if (response.result?.content) return response.result.content[0].text
  if (response.result?.contents) return response.result.contents[0].text
  return response.result
}

const TOOL_CALLS = [
  ['advisers_today', {}],
  ['advisers_commit_ls', {}],
  ['advisers_commit_ls', { all: true }],
  ['advisers_who', {}],
  ['advisers_remind', {}],
]

test('narrow view: rowid order, clearance matrix, total/protectedExcluded', () => {
  const f = fixture()
  try {
    const stored = f.store.loadCommitments()
    const all = f.view({ all: true, clearance: 0 })
    assert.equal(all.rows.length, stored.length)
    assert.equal(all.total, stored.length, 'total is the scanned row count')
    assert.deepEqual(all.rows.map((row) => row.id), stored.map((row) => row.id), 'NOT INDEXED keeps rowid order')

    const open = f.view({ all: false, clearance: 0 })
    assert.deepEqual(open.rows.map((row) => row.id), stored.filter((row) => row.status === 'open').map((row) => row.id))
    assert.equal(open.rows.length, stored.filter((row) => row.status === 'open').length)

    for (const clearance of [0, 1, 2, 3]) {
      const view = f.view({ all: true, clearance })
      let expectedHidden = 0
      for (const row of stored) {
        if (isEvidenceRecordAboveClearance(f.legacy, 'commitment', row, clearance)) expectedHidden += 1
      }
      assert.equal(view.protectedExcluded, expectedHidden, 'protectedExcluded at clearance ' + clearance)
      const hiddenById = new Map(view.rows.map((row) => [row.id, row.hidden]))
      for (const row of stored) {
        const expected = isEvidenceRecordAboveClearance(f.legacy, 'commitment', row, clearance)
        assert.equal(hiddenById.get(row.id), expected, 'hidden flag for ' + row.id + ' at clearance ' + clearance)
      }
      assert.equal(view.total - view.protectedExcluded, view.rows.filter((row) => !row.hidden).length)

      const openView = f.view({ all: false, clearance })
      const openLegacy = f.legacy.openCommitments()
      let expectedOpenHidden = 0
      for (const row of openLegacy) if (isEvidenceRecordAboveClearance(f.legacy, 'commitment', row, clearance)) expectedOpenHidden += 1
      assert.equal(openView.protectedExcluded, expectedOpenHidden)
      assert.equal(openView.rows.filter((row) => !row.hidden).length, openLegacy.length - expectedOpenHidden)
      for (const row of openLegacy) {
        assert.equal(openView.rows.find((narrow) => narrow.id === row.id).hidden, isEvidenceRecordAboveClearance(f.legacy, 'commitment', row, clearance))
      }
    }

    // Column/field parity for every visible narrow row.
    const viewAll = f.view({ all: true, clearance: 0 })
    for (const legacyRow of f.legacy.listCommitments()) {
      const narrow = viewAll.rows.find((row) => row.id === legacyRow.id)
      assert.ok(narrow, 'missing narrow row ' + legacyRow.id)
      assert.equal(narrow.debtor, legacyRow.debtor)
      assert.equal(narrow.creditor, legacyRow.creditor)
      assert.equal(narrow.action, legacyRow.action)
      assert.equal(narrow.dueAt, legacyRow.dueAt)
      assert.equal(narrow.status, legacyRow.status)
      assert.equal(narrow.matterId, legacyRow.matterId)
      assert.deepEqual(narrow.reminderOffsets, legacyRow.reminderOffsets)
    }
    // Custom offsets survive; non-array corridor JSON does not become offsets.
    assert.deepEqual(viewAll.rows.find((row) => row.id === 'cm_05').reminderOffsets, [1, 3])
    assert.equal('reminderOffsets' in viewAll.rows.find((row) => row.id === 'cm_21'), false)
    // A dangling matter id is protected (fail closed), a missing association is not.
    assert.equal(viewAll.rows.find((row) => row.id === 'cm_30').hidden, true)
  } finally { f.cleanup() }
})

test('narrow path is byte-identical to the legacy ledger path for all four tools', async () => {
  const f = fixture()
  try {
    for (const clearance of [0, 1, 2, 3]) {
      const { oldServer, newServer } = serverPair(f, clearance)
      for (const [name, args] of TOOL_CALLS) {
        const oldText = await callText(oldServer, 'tools/call', { name, arguments: args })
        const newText = await callText(newServer, 'tools/call', { name, arguments: args })
        assert.equal(newText, oldText, 'tools/call ' + name + ' ' + JSON.stringify(args) + ' at clearance ' + clearance)
      }
      for (const uri of ['advisers://today', 'advisers://commitments', 'advisers://who']) {
        const oldText = await callText(oldServer, 'resources/read', { uri })
        const newText = await callText(newServer, 'resources/read', { uri })
        assert.equal(newText, oldText, 'resources/read ' + uri + ' at clearance ' + clearance)
      }
    }

    // who really returns full legacy Commitment rows (not the narrow projection).
    const { newServer } = serverPair(f, 0)
    const whoText = await callText(newServer, 'tools/call', { name: 'advisers_who', arguments: {} })
    const who = JSON.parse(whoText)
    const first = who.mine[0] ?? who.waiting[0]
    assert.ok(first, 'who must return at least one row')
    for (const key of ['id', 'matterId', 'debtor', 'creditor', 'action', 'timezone', 'status', 'evidence', 'capability']) {
      assert.ok(key in first, 'who row is missing the legacy field ' + key)
    }
    assert.ok(Array.isArray(first.evidence))
  } finally { f.cleanup() }
})

test('narrow path: loaders are cached per (all, clearance) and array hydration is accepted', async () => {
  const f = fixture()
  try {
    let viewCalls = 0
    let recordCalls = 0
    const countedView = (options) => { viewCalls += 1; return f.view(options) }
    const countedRecords = (ids) => { recordCalls += 1; return f.recordsArray(ids) }
    const server = createMcpServer({
      store: f.store,
      loadCommitmentView: countedView,
      loadCommitmentRecords: countedRecords,
      version: '0.3.2-test',
      now: NOW,
    })
    for (const [name, args] of TOOL_CALLS) await callText(server, 'tools/call', { name, arguments: args })
    for (const [name, args] of TOOL_CALLS) await callText(server, 'tools/call', { name, arguments: args })
    // today/who (all:false) share one snapshot; commit_ls/remind (all:true) share
    // the other one. The loaders are process-level snapshots, like the legacy
    // ledger cache, so the second round must not re-read.
    assert.equal(viewCalls, 2)
    // who hydrates mine + waiting (<=20 each) on each call; the array return shape
    // is normalized to a Map internally. Two who rounds x two buckets.
    assert.equal(recordCalls, 4)

    const arrayPair = serverPair(f, 1, { records: 'array' })
    for (const [name, args] of TOOL_CALLS) {
      const oldText = await callText(arrayPair.oldServer, 'tools/call', { name, arguments: args })
      const newText = await callText(arrayPair.newServer, 'tools/call', { name, arguments: args })
      assert.equal(newText, oldText, 'array hydration parity for ' + name)
    }
  } finally { f.cleanup() }
})

test('narrow projection query plan: table scan in rowid order, no TEMP B-TREE', () => {
  const f = fixture()
  try {
    const planOf = (sql) => f.store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((row) => String(row.detail ?? '')).join('\n')
    const openSql = "SELECT id, debtor, creditor, action, due_at, status, matter_id, reminder_offsets FROM commitments NOT INDEXED WHERE status = 'open'"
    const allSql = 'SELECT id, debtor, creditor, action, due_at, status, matter_id, reminder_offsets FROM commitments NOT INDEXED'
    for (const sql of [openSql, allSql]) {
      const plan = planOf(sql)
      assert.match(plan, /SCAN commitments/, 'expected a plain table scan:\n' + plan)
      assert.doesNotMatch(plan, /TEMP B-TREE|USE TEMP B-TREE|TEMP B-TREE/i, 'no sort/spill is allowed:\n' + plan)
      assert.doesNotMatch(plan, /USING (COVERING )?INDEX/, 'NOT INDEXED must avoid index order drift:\n' + plan)
    }
    // The matters lookup is a tiny full scan as well (no index needed).
    assert.doesNotMatch(planOf('SELECT id, secrecy FROM matters'), /TEMP B-TREE/)
  } finally { f.cleanup() }
})

test('legacy fallback: without injected loaders (JSON store / old package / embedder) nothing changes', async () => {
  const f = fixture()
  try {
    // 1) Lazy loadLedger (the JSON-store wiring shape) with no narrow loaders.
    const legacyLazy = createMcpServer({ loadLedger: () => f.legacy, version: '0.3.2-test', now: NOW })
    const legacyEager = createMcpServer({ ledger: f.legacy, version: '0.3.2-test', now: NOW })
    for (const [name, args] of TOOL_CALLS) {
      const lazyText = await callText(legacyLazy, 'tools/call', { name, arguments: args })
      const eagerText = await callText(legacyEager, 'tools/call', { name, arguments: args })
      assert.equal(lazyText, eagerText, 'lazy legacy fallback for ' + name)
    }

    // 2) A loader that declines (returns null) must fall back to the ledger path.
    const declining = createMcpServer({
      store: f.store,
      ledger: f.legacy,
      loadCommitmentView: () => null,
      version: '0.3.2-test',
      now: NOW,
    })
    for (const [name, args] of TOOL_CALLS) {
      const declinedText = await callText(declining, 'tools/call', { name, arguments: args })
      const eagerText = await callText(legacyEager, 'tools/call', { name, arguments: args })
      assert.equal(declinedText, eagerText, 'null view fallback for ' + name)
    }

    // 3) The narrow path must never load the full ledger: a throwing loadLedger
    //    is a deterministic guard that the four tools stay on the projection.
    const guarded = createMcpServer({
      store: f.store,
      loadLedger: () => { throw new Error('full ledger must not be loaded by the narrow path') },
      loadCommitmentView: f.view,
      loadCommitmentRecords: f.recordsMap,
      version: '0.3.2-test',
      now: NOW,
    })
    for (const [name, args] of TOOL_CALLS) {
      const text = await callText(guarded, 'tools/call', { name, arguments: args })
      assert.equal(typeof text, 'string')
    }
  } finally { f.cleanup() }
})
