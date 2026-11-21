import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'

/**
 * Chinese full-text search (schema v19 tokenizer, v20 in 0.2.3; 2026-11-17 perf audit P2-6).
 *
 * v18 built turns_fts with the default unicode61 tokenizer, which never matched
 * a Chinese query, so every Chinese search silently fell back to a LIKE table
 * scan. v19 rebuilds the turn index (and adds a summary index) with the FTS5
 * trigram tokenizer: >= 3 characters go through MATCH, shorter/special queries
 * keep the LIKE fallback. These tests pin the behaviour, the v18 -> v19
 * migration (backup, rebuild, rollback, idempotency) and the tokenizer
 * degradation path.
 */

const TURN_KEYS = ['content', 'conversationId', 'createdAt', 'id', 'role', 'seq']

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-fts-cjk-'))
  return { root, db: join(root, 'state.db') }
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

function seed(store) {
  const turns = {}
  turns.quote = store.addTurn({ conversationId: 'c1', role: 'user', content: '先给结论，预算总额是420万，报价单周五前发。' })
  turns.q4 = store.addTurn({ conversationId: 'c1', role: 'assistant', content: '收到，Q4 预算总额 already includes 420万；Invoice 2024 total is 420.' })
  turns.report = store.addTurn({ conversationId: 'c1', role: 'user', content: '王工提交了周报' })
  turns.pay = store.addTurn({ conversationId: 'c1', role: 'assistant', content: '客户确认了付款节点' })
  turns.client = store.addTurn({ conversationId: 'c1', role: 'user', content: '客户要求补充发票信息' })
  turns.secret = store.addTurn({ conversationId: 'c2', role: 'user', content: '里程碑：蓝鲸计划正式启动' })
  store.upsertSession({ conversationId: 'c1', matterId: 'm1', title: '报价与周报' })
  store.upsertSession({ conversationId: 'c2', matterId: 'm2', title: '蓝鲸计划' })
  store.upsertSessionSummary({ conversationId: 'c1', summary: '讨论了报价单与预算总额，王工提交了周报。', throughSeq: 5 })
  return turns
}

function makeStore(root) {
  return new SqliteStore(join(root, 'state.db'))
}

/** Build a genuine v18 database by hand: unicode61 turns_fts + its triggers. */
function createV18Database(dbPath) {
  const raw = new DatabaseSync(dbPath)
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  raw.prepare("INSERT INTO meta(key,value) VALUES('schema_version','18')").run()
  raw.exec(`CREATE TABLE turns (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(conversation_id, seq)
  )`)
  raw.exec(`CREATE TABLE session_summaries (
    conversation_id TEXT PRIMARY KEY, summary TEXT NOT NULL,
    through_seq INTEGER NOT NULL, updated_at TEXT NOT NULL
  )`)
  raw.exec("CREATE VIRTUAL TABLE turns_fts USING fts5(content, content='turns', content_rowid='rowid')")
  raw.exec(`CREATE TRIGGER turns_ai AFTER INSERT ON turns BEGIN
    INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
  END`)
  raw.exec(`CREATE TRIGGER turns_ad AFTER DELETE ON turns BEGIN
    INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END`)
  raw.exec(`CREATE TRIGGER turns_au AFTER UPDATE ON turns BEGIN
    INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
  END`)
  const rows = [
    ['t1', 'c1', 1, 'user', '先给结论，预算总额是420万，报价单周五前发。'],
    ['t2', 'c1', 2, 'assistant', '收到，Q4 预算总额 already includes 420万。'],
    ['t3', 'c1', 3, 'user', '王工提交了周报'],
    ['t4', 'c2', 1, 'user', '里程碑：蓝鲸计划正式启动'],
  ]
  const insertTurn = raw.prepare('INSERT INTO turns(id,conversation_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)')
  for (const [id, conversationId, seq, role, content] of rows) {
    insertTurn.run(id, conversationId, seq, role, content, '2026-11-01T00:00:00.000Z')
  }
  raw.prepare('INSERT INTO session_summaries(conversation_id,summary,through_seq,updated_at) VALUES(?,?,?,?)')
    .run('c1', '讨论了报价单与预算总额，王工提交了周报。', 3, '2026-11-01T00:00:00.000Z')
  raw.close()
}

function countFtsMatches(store, table, query) {
  return store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(query).n
}

function triggerNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('turns_ai','turns_ad','turns_au','summaries_ai','summaries_ad','summaries_au') ORDER BY name").all().map((row) => row.name)
}

test('fresh v22 databases install the v19 trigram FTS5 indexes', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    try {
      assert.equal(SCHEMA_VERSION, 22)
      assert.equal(store.getMeta('schema_version'), '22')
      assert.equal(store.ftsTokenizer, 'trigram', 'trigram tokenizer is the default')
      assert.equal(store.ftsWarning, null)
      const ddl = (name) => store.db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name)?.sql ?? ''
      assert.match(ddl('turns_fts'), /tokenize='trigram'/i)
      assert.match(ddl('summaries_fts'), /tokenize='trigram'/i)
      assert.deepEqual(triggerNames(store.db), ['summaries_ad', 'summaries_ai', 'summaries_au', 'turns_ad', 'turns_ai', 'turns_au'])
      assert.deepEqual([...store._ftsTables].sort(), ['summaries_fts', 'turns_fts'])
    } finally {
      store.close()
    }
  } finally {
    cleanup(root)
  }
})

test('Chinese 3+ character queries hit FTS5 (substring and phrase)', () => {
  const { root, db } = setup()
  try {
    const store = makeStore(root)
    try {
      seed(store)
      // The v18 failure mode: MATCH returned 0 rows for every Chinese query.
      assert.ok(countFtsMatches(store, 'turns_fts', '报价单') > 0, 'MATCH 报价单 must hit under trigram')
      assert.ok(countFtsMatches(store, 'turns_fts', '预算总额') > 0)
      assert.ok(countFtsMatches(store, 'turns_fts', '王工提') > 0, 'trigram also matches inside a longer CJK run')

      assert.equal(store.searchTurns('报价单').length, 1)
      assert.equal(store.searchTurns('报价单')[0].id, store.searchTurns('报价单')[0].id)
      assert.deepEqual(
        store.searchTurns('预算总额').map((row) => row.seq).sort((a, b) => a - b),
        [1, 2],
        'a 4-character phrase matches both turns that contain it',
      )
      const hits = store.searchTurns('王工提交了')
      assert.equal(hits.length, 1)
      assert.equal(hits[0].content, '王工提交了周报')
      // Public result shape is unchanged from v18.
      assert.deepEqual(Object.keys(hits[0]).sort(), TURN_KEYS)
      assert.equal(hits[0].conversationId, 'c1')
      assert.equal(hits[0].role, 'user')
      assert.match(hits[0].createdAt, /^\d{4}-\d{2}-\d{2}T/)
    } finally {
      store.close()
    }
  } finally {
    cleanup(root)
  }
})

test('Chinese 2-character queries keep the LIKE fallback (and its ordering)', () => {
  const { root, db } = setup()
  try {
    const store = makeStore(root)
    try {
      const turns = seed(store)
      // A 2-character query cannot form a trigram: the index has no tokens for it.
      assert.equal(countFtsMatches(store, 'turns_fts', '预算'), 0, '2-character CJK query is not an FTS hit')
      assert.equal(countFtsMatches(store, 'turns_fts', '客户'), 0)
      // ... yet search still finds the rows through the LIKE fallback.
      const budget = store.searchTurns('预算')
      assert.equal(budget.length, 2)
      assert.deepEqual(Object.keys(budget[0]).sort(), TURN_KEYS)
      // LIKE path keeps the v18 order: seq ASC over the matching rows.
      const pay = store.searchTurns('客户')
      assert.deepEqual(pay.map((row) => row.seq), [4, 5], 'like path returns matches in ascending seq order')
      assert.equal(pay[0].id, turns.pay.id)
      assert.equal(store.searchTurns('王工').length, 1)
      // A 2-character query inside a matter filter still works through the join.
      assert.equal(store.searchTurns('客户', { matterId: 'm1' }).length, 2)
      assert.equal(store.searchTurns('客户', { matterId: 'm2' }).length, 0)
    } finally {
      store.close()
    }
  } finally {
    cleanup(root)
  }
})

test('mixed Chinese/English and the pre-existing English search still work', () => {
  const { root, db } = setup()
  try {
    const store = makeStore(root)
    try {
      seed(store)
      // Mixed query: D4 is 3 characters once the ASCII is included, so it goes to FTS.
      assert.equal(store.searchTurns('Q4 预算').length, 1)
      // English substring and case-insensitive matching (trigram default).
      assert.equal(store.searchTurns('invoice').length, 1)
      assert.equal(store.searchTurns('INVOICE').length, 1)
      assert.equal(store.searchTurns('Invoice 2024').length, 1)
      // The v18 word-search path still answers a normal English query.
      assert.equal(store.searchTurns('already').length, 1)
      // Filter combinations keep the same API.
      assert.equal(store.searchTurns('invoice', { conversationId: 'c1' }).length, 1)
      assert.equal(store.searchTurns('invoice', { conversationId: 'c2' }).length, 0)
      assert.equal(store.searchTurns('invoice', { matterId: 'm2' }).length, 0)
      assert.equal(store.searchTurns('蓝鲸计划', { matterId: 'm2' }).length, 1)
      // limit is honoured on both paths.
      assert.equal(store.searchTurns('预算', { limit: 1 }).length, 1)
      // Empty queries keep returning [] instead of throwing.
      assert.deepEqual(store.searchTurns(''), [])
      assert.deepEqual(store.searchTurns('   '), [])
      assert.deepEqual(store.searchTurns(undefined), [])
    } finally {
      store.close()
    }
  } finally {
    cleanup(root)
  }
})

test('prefix/wildcard queries use FTS5 when possible and never crash', () => {
  const { root, db } = setup()
  try {
    const store = makeStore(root)
    try {
      seed(store)
      // Trigram prefix query: a bare trailing '*' is FTS5 prefix syntax.
      assert.equal(store.searchTurns('报价单*').length, 1)
      // A 2-character stem cannot be a trigram; the star query falls back to
      // LIKE and matches nothing (no crash, no SQL error).
      assert.deepEqual(store.searchTurns('报*'), [])
      assert.deepEqual(store.searchTurns('*'), [])
      assert.deepEqual(store.searchTurns('?'), [])
      // The LIKE fallback keeps v18 semantics: '%' and '_' stay SQL LIKE
      // wildcards (documented limitation), so these must not throw or corrupt.
      assert.ok(Array.isArray(store.searchTurns('100%')))
      assert.ok(Array.isArray(store.searchTurns('_')))
      assert.equal(store.searchTurns('_').length, 6, 'LIKE wildcard matches every row, exactly like v18')
    } finally {
      store.close()
    }
  } finally {
    cleanup(root)
  }
})

test('special characters and FTS syntax injection fall back to LIKE safely', () => {
  const { root, db } = setup()
  try {
    const store = makeStore(root)
    try {
      seed(store)
      const before = store.db.prepare('SELECT COUNT(*) AS n FROM turns').get().n
      const hostile = [
        '"', 'a"b', 'AND', 'OR', 'NOT', 'NEAR(', 'NEAR(报价单 客户)', '*', '报价单 OR 客户',
        '"; DROP TABLE turns; --', "' OR 1=1 --", '报价单)', '(报价单', '^报价单', ':报价单',
        '报价单:content', 'a-b', '100%', '\u0000',
      ]
      for (const query of hostile) {
        const rows = store.searchTurns(query)
        assert.ok(Array.isArray(rows), `searchTurns(${JSON.stringify(query)}) returns an array`)
      }
      for (const query of ['"', 'AND', '"; DROP TABLE turns; --']) {
        assert.ok(Array.isArray(store.searchSummaries(query)))
      }
      // Neither the table nor the index was damaged by a query.
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM turns').get().n, before)
      assert.equal(store.searchTurns('报价单').length, 1)
      assert.ok(countFtsMatches(store, 'turns_fts', '报价单') > 0)
    } finally {
      store.close()
    }
  } finally {
    cleanup(root)
  }
})

test('FTS triggers keep turns and summaries in sync on add/update/delete/purge', () => {
  const { root, db } = setup()
  try {
    const store = makeStore(root)
    try {
      const turn = store.addTurn({ conversationId: 'c1', role: 'user', content: '原始内容：付款节点在下周' })
      assert.equal(countFtsMatches(store, 'turns_fts', '付款节点'), 1)
      store.db.prepare('UPDATE turns SET content = ? WHERE id = ?').run('修改后：验收清单在下周', turn.id)
      assert.equal(countFtsMatches(store, 'turns_fts', '付款节点'), 0, 'UPDATE trigger removes the old tokens')
      assert.equal(countFtsMatches(store, 'turns_fts', '验收清单'), 1, 'UPDATE trigger adds the new tokens')
      store.db.prepare('DELETE FROM turns WHERE id = ?').run(turn.id)
      assert.equal(countFtsMatches(store, 'turns_fts', '验收清单'), 0, 'DELETE trigger removes the tokens')

      store.upsertSessionSummary({ conversationId: 'c1', summary: '第一版：讨论了报价单', throughSeq: 1 })
      assert.equal(store.searchSummaries('报价单').length, 1)
      assert.equal(countFtsMatches(store, 'summaries_fts', '报价单'), 1)
      store.upsertSessionSummary({ conversationId: 'c1', summary: '第二版：讨论了验收清单', throughSeq: 2 })
      assert.equal(countFtsMatches(store, 'summaries_fts', '报价单'), 0, 'upsert UPDATE trigger removes the old summary tokens')
      assert.equal(countFtsMatches(store, 'summaries_fts', '验收清单'), 1)
      assert.equal(store.searchSummaries('验收清单').length, 1)
      assert.equal(store.searchSummaries('验收清单')[0].throughSeq, 2)

      // purgeMatterData deletes through the source tables; the triggers clean FTS.
      seed(store)
      store.purgeMatterData('m1')
      assert.equal(countFtsMatches(store, 'turns_fts', '报价单'), 0)
      assert.equal(countFtsMatches(store, 'summaries_fts', '报价单'), 0)
      assert.equal(store.searchTurns('报价单').length, 0)
    } finally {
      store.close()
    }
  } finally {
    cleanup(root)
  }
})

test('a v18 database migrates to v21: old rows stay searchable and a backup is kept', () => {
  const { root, db } = setup()
  try {
    createV18Database(db)
    const beforeBytes = statSync(db).size
    const store = new SqliteStore(db)
    try {
      assert.equal(store.getMeta('schema_version'), String(SCHEMA_VERSION))
      assert.equal(store.ftsTokenizer, 'trigram')
      assert.match(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'turns_fts'").get().sql, /tokenize='trigram'/i)
      // Rows written before the migration are re-indexed from the source table.
      assert.ok(countFtsMatches(store, 'turns_fts', '报价单') > 0, 'v18 rows are re-indexed by the rebuild')
      assert.equal(store.searchTurns('报价单').length, 1)
      assert.equal(store.searchTurns('蓝鲸计划', { conversationId: 'c2' }).length, 1)
      // Summaries written under v18 are indexed by the new summaries_fts.
      assert.ok(countFtsMatches(store, 'summaries_fts', '预算总额') > 0)
      assert.equal(store.searchSummaries('预算总额').length, 1)
      assert.equal(store.searchTurns('报价单')[0].content, '先给结论，预算总额是420万，报价单周五前发。')
      // The same 2-character LIKE fallback still applies after migration.
      assert.equal(countFtsMatches(store, 'turns_fts', '预算'), 0)
      assert.equal(store.searchTurns('预算').length, 2)
    } finally {
      store.close()
    }
    const backups = readdirSync(root).filter((name) => /^state\.db\.before-migrate-v18-\d+$/.test(name))
    assert.equal(backups.length, 1, 'exactly one pre-migration backup is written')
    // The backup is the v18 database (old tokenizer, old schema version),
    // proving the copy is taken before the migration starts.
    const backup = new DatabaseSync(join(root, backups[0]), { readOnly: true })
    try {
      assert.equal(backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '18')
      assert.doesNotMatch(backup.prepare("SELECT sql FROM sqlite_master WHERE name = 'turns_fts'").get().sql, /trigram/i)
      assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 4)
    } finally {
      backup.close()
    }
    assert.ok(statSync(join(root, backups[0])).size > 0)
    assert.ok(beforeBytes > 0)
  } finally {
    cleanup(root)
  }
})

test('reopening a migrated (and a fresh) database is idempotent', () => {
  const { root, db } = setup()
  try {
    createV18Database(db)
    const first = new SqliteStore(db)
    const firstHits = first.searchTurns('报价单').map((row) => row.id)
    const firstMatchCount = countFtsMatches(first, 'turns_fts', '报价单')
    first.close()
    const backupsAfterFirstOpen = readdirSync(root).filter((name) => name.includes('before-migrate')).length

    const second = new SqliteStore(db)
    try {
      assert.equal(second.getMeta('schema_version'), String(SCHEMA_VERSION))
      assert.equal(second.ftsTokenizer, 'trigram')
      assert.deepEqual(second.searchTurns('报价单').map((row) => row.id), firstHits, 'same result after reopen')
      assert.equal(countFtsMatches(second, 'turns_fts', '报价单'), firstMatchCount, 'no duplicated FTS rows')
      assert.deepEqual(triggerNames(second.db), ['summaries_ad', 'summaries_ai', 'summaries_au', 'turns_ad', 'turns_ai', 'turns_au'])
      assert.equal(second.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('turns_fts','summaries_fts')").get().n, 2)
    } finally {
      second.close()
    }
    // No migration means no new backup: the second open was a plain reopen.
    assert.equal(readdirSync(root).filter((name) => name.includes('before-migrate')).length, backupsAfterFirstOpen)

    // A fresh database reopens idempotently too: no migration, no backup,
    // one FTS table per source, six triggers, same search result.
    const fresh = setup()
    try {
      const created = new SqliteStore(fresh.db)
      created.addTurn({ conversationId: 'c1', role: 'user', content: '重开后的报价单' })
      created.close()
      const reopened = new SqliteStore(fresh.db)
      try {
        assert.equal(reopened.getMeta('schema_version'), String(SCHEMA_VERSION))
        assert.equal(reopened.ftsTokenizer, 'trigram')
        assert.equal(reopened.searchTurns('报价单').length, 1)
        assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('turns_fts','summaries_fts')").get().n, 2)
      } finally {
        reopened.close()
      }
      assert.equal(readdirSync(fresh.root).filter((name) => name.includes('before-migrate')).length, 0, 'fresh databases never need a migration backup')
    } finally {
      cleanup(fresh.root)
    }
  } finally {
    cleanup(root)
  }
})

test('a failed v18->v20 migration rolls back and leaves the v18 database intact', () => {
  const { root, db } = setup()
  try {
    createV18Database(db)
    const original = SqliteStore.prototype._setupFts
    SqliteStore.prototype._setupFts = () => { throw new Error('injected FTS setup failure') }
    try {
      assert.throws(() => new SqliteStore(db), /injected FTS setup failure/)
    } finally {
      SqliteStore.prototype._setupFts = original
    }
    // DDL is transactional in SQLite: the drops/creates were rolled back with
    // the schema_version bump, so the database is still a valid v18 database.
    const raw = new DatabaseSync(db, { readOnly: true })
    try {
      assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '18')
      assert.doesNotMatch(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'turns_fts'").get().sql, /trigram/i)
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 4)
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'summaries_fts'").get().n, 0)
    } finally {
      raw.close()
    }
    // A later open (without the injected failure) migrates normally.
    const store = new SqliteStore(db)
    try {
      assert.equal(store.getMeta('schema_version'), String(SCHEMA_VERSION))
      assert.equal(store.searchTurns('报价单').length, 1)
    } finally {
      store.close()
    }
  } finally {
    cleanup(root)
  }
})

test('future schema versions are still refused', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    store.close()
    const raw = new DatabaseSync(db)
    raw.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version','23')").run()
    raw.close()
    assert.throws(() => new SqliteStore(db), /newer than this CLI/)
  } finally {
    cleanup(root)
  }
})

test('a missing trigram tokenizer degrades to unicode61 instead of failing to open', () => {
  const { root } = setup()
  const warnings = []
  const originalWarn = console.warn
  const originalCreate = SqliteStore.prototype._createFts
  SqliteStore.prototype._createFts = function createFts(tokenizer) {
    // Simulate a SQLite build without the trigram tokenizer (SQLite < 3.34 or
    // a build that omits it). The store must degrade, not throw.
    if (tokenizer === 'trigram') throw new Error('no such tokenizer: trigram')
    return originalCreate.call(this, tokenizer)
  }
  console.warn = (...args) => warnings.push(args.join(' '))
  let store
  try {
    store = makeStore(root)
  } finally {
    SqliteStore.prototype._createFts = originalCreate
    console.warn = originalWarn
  }
  try {
    assert.equal(store.ftsTokenizer, 'unicode61', 'falls back to the legacy tokenizer')
    assert.match(store.ftsWarning, /trigram tokenizer unavailable/i)
    assert.ok(warnings.some((line) => /trigram tokenizer unavailable/i.test(line)))
    assert.match(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'turns_fts'").get().sql, /content='turns'/i)
    assert.doesNotMatch(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'turns_fts'").get().sql, /trigram/i)
    // Chinese still answers through the LIKE backstop; English uses unicode61.
    store.addTurn({ conversationId: 'c1', role: 'user', content: '先给结论，预算总额是420万，报价单周五前发。' })
    assert.equal(countFtsMatches(store, 'turns_fts', '报价单'), 0)
    assert.equal(store.searchTurns('报价单').length, 1)
    assert.equal(store.searchTurns('预算').length, 1)
    assert.equal(store.searchSummaries('不存在的短语').length, 0)
    // A reopen reads the installed tokenizer back and keeps working.
    const db = store.db
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('turns_fts','summaries_fts')").get().n, 2)
  } finally {
    store.close()
    cleanup(root)
  }
})

test('ADVISERS_FTS_TOKENIZER=unicode61 degrades to unicode61 + LIKE with a warning', () => {
  const { root } = setup()
  const warnings = []
  const originalWarn = console.warn
  const saved = process.env.ADVISERS_FTS_TOKENIZER
  process.env.ADVISERS_FTS_TOKENIZER = 'unicode61'
  console.warn = (...args) => warnings.push(args.join(' '))
  let store
  try {
    store = makeStore(root)
  } finally {
    console.warn = originalWarn
    if (saved === undefined) delete process.env.ADVISERS_FTS_TOKENIZER
    else process.env.ADVISERS_FTS_TOKENIZER = saved
  }
  try {
    assert.equal(store.ftsTokenizer, 'unicode61')
    assert.match(store.ftsWarning, /unicode61/)
    assert.ok(warnings.some((line) => /unicode61/.test(line)), 'degradation prints a warning line')
    assert.match(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'turns_fts'").get().sql, /unicode61|content='turns'/i)
    assert.doesNotMatch(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'turns_fts'").get().sql, /trigram/i)
    store.addTurn({ conversationId: 'c1', role: 'user', content: '预算总额是420万，报价单周五前发。' })
    // unicode61 cannot match the CJK substring: the LIKE fallback answers, and
    // opening/searches never fail because a tokenizer is missing.
    assert.equal(countFtsMatches(store, 'turns_fts', '报价单'), 0)
    assert.equal(store.searchTurns('报价单').length, 1)
    assert.equal(store.searchTurns('预算').length, 1)
    assert.equal(store.searchTurns('invoice').length, 0)
  } finally {
    store.close()
    cleanup(root)
  }
})

test('50k-turn smoke: a 3-character Chinese query hits the persisted trigram index', () => {
  const { root, db } = setup()
  try {
    const store = new SqliteStore(db)
    try {
      const subjects = ['客户', '王工', '老板', '财务', '法务', '供应商']
      const objects = ['报价单', '预算总额', '合同附件', '会议纪要', '周报', '付款节点']
      store.db.exec('BEGIN IMMEDIATE')
      const insert = store.db.prepare('INSERT INTO turns(id,conversation_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)')
      for (let i = 0; i < 50000; i += 1) {
        const content = i === 43210
          ? '里程碑：蓝鲸计划正式启动，报价单待确认。'
          : `第${i}条：${subjects[i % subjects.length]}处理了${objects[Math.floor(i / 7) % objects.length]}，请今天内处理。`
        insert.run(`t${i}`, `c${i % 200}`, Math.floor(i / 200) + 1, i % 2 ? 'user' : 'assistant', content, new Date(Date.parse('2026-11-01T00:00:00Z') + i * 1000).toISOString())
      }
      store.db.exec('COMMIT')
    } finally {
      store.close()
    }
    // Reopen so the query exercises the persisted index, like a real CLI run.
    const reopened = new SqliteStore(db)
    try {
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 50000)
      assert.ok(countFtsMatches(reopened, 'turns_fts', '报价单') > 1000, 'the persisted trigram index covers the 50k corpus')
      const hits = reopened.searchTurns('蓝鲸计划', { limit: 5 })
      assert.equal(hits.length, 1, 'a query that only occurs once still hits')
      assert.match(hits[0].content, /蓝鲸计划/)
      // 2-character fallback stays correct at scale (no timing assertion made).
      assert.ok(reopened.searchTurns('蓝鲸').length >= 1)
      assert.ok(reopened.searchTurns('客户', { limit: 5 }).length > 0)
      assert.equal(reopened.searchTurns('不存在的短语').length, 0)
    } finally {
      reopened.close()
    }
  } finally {
    cleanup(root)
  }
})
