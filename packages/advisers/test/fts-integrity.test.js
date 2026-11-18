import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteStore } from '../lib/sqlite.js'

// 0.2.3 robustness Phase 0 (robustness audit 2026-11-17 P1-5): an FTS5 index
// that is out of sync with its source table used to make `search` silently
// return fewer hits than a LIKE scan (MATCH=3 / LIKE=4 in the audit). These
// tests pin verifyFtsIntegrity() and the searchTurns/searchSummaries fallback.

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-fts-integrity-'))
  return { root, db: join(root, 'state.db') }
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

function addMatchingTurns(store, count) {
  const ids = []
  for (let index = 1; index <= count; index++) {
    ids.push(store.addTurn({ conversationId: 'c1', role: 'user', content: `季度报价单方案${index}` }))
  }
  return ids
}

function dropTriggerAndInsertUnindexedTurn(store) {
  store.db.exec('DROP TRIGGER turns_ai')
  store.db.prepare('INSERT INTO turns(id,conversation_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)')
    .run('turn_unindexed', 'c1', 99, 'user', '季度报价单方案四（漏索引）', '2026-11-18T00:00:00.000Z')
}

test('verifyFtsIntegrity: a healthy store reports ok with both indexes and all six triggers', () => {
  const { root, db } = setup()
  const store = new SqliteStore(db)
  try {
    addMatchingTurns(store, 3)
    store.upsertSessionSummary({ conversationId: 'c1', summary: '讨论了报价单与预算总额', throughSeq: 3 })
    const report = store.verifyFtsIntegrity()
    assert.equal(report.ok, true)
    assert.equal(report.state, 'ok')
    assert.equal(report.tokenizer, 'trigram')
    assert.deepEqual(report.triggers.missing, [])
    assert.equal(report.tables.turns_fts.exists, true)
    assert.equal(report.tables.summaries_fts.exists, true)
    assert.equal(report.tables.turns_fts.sourceCount, 3)
    assert.equal(report.tables.turns_fts.indexCount, 3)
    assert.equal(report.tables.turns_fts.countMismatch, false)
    assert.equal(report.tables.turns_fts.integrityCheck, 'ok')
    assert.deepEqual(report.tables.turns_fts.sample.missingFromIndex, [])
    assert.equal(store._ftsBroken, false, 'a healthy report must not disable the FTS path')
  } finally {
    store.close()
    cleanup(root)
  }
})

test('searchTurns falls back to LIKE when the index is incomplete (MATCH=3, LIKE=4) and warns once', () => {
  const { root, db } = setup()
  const store = new SqliteStore(db)
  try {
    addMatchingTurns(store, 3)
    dropTriggerAndInsertUnindexedTurn(store)
    const matchCount = store.db.prepare('SELECT COUNT(*) AS n FROM turns_fts WHERE turns_fts MATCH ?').get('报价单').n
    const likeCount = store.db.prepare('SELECT COUNT(*) AS n FROM turns WHERE content LIKE ?').get('%报价单%').n
    assert.equal(matchCount, 3, 'fixture: the FTS index is missing the unindexed row')
    assert.equal(likeCount, 4, 'fixture: LIKE sees all four rows')
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      const rows = store.searchTurns('报价单', { limit: 10 })
      assert.equal(rows.length, 4, 'search must not silently return only the indexed 3 rows')
      assert.deepEqual(new Set(rows.map((row) => row.id)).has('turn_unindexed'), true)
    } finally {
      console.warn = originalWarn
    }
    assert.equal(store._ftsBroken, true, 'a detected mismatch disables the FTS path for this store')
    assert.match(store.ftsIntegrityWarning, /inconsistent/)
    assert.match(store.ftsIntegrityWarning, /rebuild-fts/)
    assert.equal(warnings.filter((line) => /inconsistent/.test(line)).length, 1, 'one warning per store, not one per search')
    // A second search must return the same complete rows without another warning.
    assert.equal(store.searchTurns('报价单', { limit: 10 }).length, 4)
    const report = store.verifyFtsIntegrity()
    assert.equal(report.ok, false)
    assert.equal(report.state, 'inconsistent')
    assert.deepEqual(report.tables.turns_fts.triggers.missing, ['turns_ai'])
    assert.equal(report.tables.turns_fts.sourceCount, 4)
    assert.equal(report.tables.turns_fts.indexCount, 3)
    assert.equal(report.tables.turns_fts.countMismatch, true)
    assert.deepEqual(report.tables.turns_fts.sample.missingFromIndex, [4], 'the sampled source rowid is missing from the index')
    assert.ok(report.errors.some((line) => /missing FTS sync trigger/.test(line)))
    assert.match(report.repair, /audit --rebuild-fts/)
  } finally {
    store.close()
    cleanup(root)
  }
})

test('a rebuilt index makes MATCH == LIKE again and search trusts FTS on reopen', () => {
  const { root, db } = setup()
  const store = new SqliteStore(db)
  try {
    addMatchingTurns(store, 3)
    dropTriggerAndInsertUnindexedTurn(store)
    assert.equal(store.verifyFtsIntegrity().ok, false)
    // What `advisers audit --rebuild-fts` must do: recreate tables/triggers and
    // backfill from the source tables. _setupFts is the migration helper for it.
    store._setupFts()
  } finally {
    store.close()
  }
  const reopened = new SqliteStore(db)
  try {
    const report = reopened.verifyFtsIntegrity()
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.equal(report.state, 'ok')
    const matchCount = reopened.db.prepare('SELECT COUNT(*) AS n FROM turns_fts WHERE turns_fts MATCH ?').get('报价单').n
    const likeCount = reopened.db.prepare('SELECT COUNT(*) AS n FROM turns WHERE content LIKE ?').get('%报价单%').n
    assert.equal(matchCount, 4)
    assert.equal(likeCount, 4)
    assert.equal(reopened.searchTurns('报价单', { limit: 10 }).length, 4)
  } finally {
    reopened.close()
    cleanup(root)
  }
})

test('verifyFtsIntegrity reports a missing index table even when the other index is healthy', () => {
  const { root, db } = setup()
  const store = new SqliteStore(db)
  try {
    addMatchingTurns(store, 1)
    store.upsertSessionSummary({ conversationId: 'c1', summary: '讨论报价单', throughSeq: 1 })
    store.db.exec('DROP TABLE summaries_fts')
    const report = store.verifyFtsIntegrity()
    assert.equal(report.ok, false, 'a missing index must not be reported as ok')
    assert.equal(report.state, 'inconsistent')
    assert.equal(report.tables.summaries_fts.exists, false)
    assert.equal(report.tables.turns_fts.exists, true)
    assert.ok(report.errors.some((line) => /summaries_fts.*missing/.test(line)))
    assert.match(report.warning, /inconsistent/)
    assert.equal(store._ftsBroken, true)
  } finally {
    store.close()
    cleanup(root)
  }
})

test('searchSummaries also detects a desynced summaries index and falls back to LIKE', () => {
  const { root, db } = setup()
  const store = new SqliteStore(db)
  try {
    store.upsertSessionSummary({ conversationId: 'c1', summary: '客户要求补充报价单与验收清单', throughSeq: 1 })
    store.db.exec('DROP TRIGGER summaries_ai')
    store.db.prepare('INSERT INTO session_summaries(conversation_id,summary,through_seq,updated_at) VALUES(?,?,?,?)')
      .run('c2', '客户再次要求报价单', 1, '2026-11-18T00:00:00.000Z')
    const matchCount = store.db.prepare('SELECT COUNT(*) AS n FROM summaries_fts WHERE summaries_fts MATCH ?').get('报价单').n
    const likeCount = store.db.prepare('SELECT COUNT(*) AS n FROM session_summaries WHERE summary LIKE ?').get('%报价单%').n
    assert.equal(matchCount, 1)
    assert.equal(likeCount, 2)
    const rows = store.searchSummaries('报价单', { limit: 10 })
    assert.equal(rows.length, 2)
    assert.equal(rows.some((row) => row.conversationId === 'c2'), true)
    assert.equal(store._ftsBroken, true)
    const report = store.verifyFtsIntegrity()
    assert.equal(report.ok, false)
    assert.deepEqual(report.tables.summaries_fts.triggers.missing, ['summaries_ai'])
  } finally {
    store.close()
    cleanup(root)
  }
})
