import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { tosEnv } from './tos-fixture.js'
import { SqliteStore } from '../lib/sqlite.js'

/**
 * P1-2 (0.2.2): 50k-row partial loading.
 *
 * The round-2 performance audit measured every ledger command paying for the
 * full 9-table store.load(): 488ms at 50k rows, and status at 664ms / 352MB
 * because it only needed four counts. These tests build a 50k synthetic ledger
 * and pin the *behaviour* (no wall-clock thresholds in CI):
 *  - status/today/who/week/receipt only read the tables they need: a preloaded
 *    module replaces every loader they must not call with a throwing stub, so a
 *    regression back to store.load() fails deterministically instead of being a
 *    timing flake;
 *  - the SQL the new paths run is the indexed COUNT / filtered load (EXPLAIN);
 *  - the 50k partial rows match the full snapshot exactly.
 */

const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const sqliteModuleUrl = new URL('../lib/sqlite.js', import.meta.url).href
const CLI_ENV = (home) => tosEnv(home, {
  ...process.env,
  ADVISERS_CORE_LOCAL: '1',
  ADVISERS_OFFICE_LOCAL: '1',
  ADVISERS_NO_MODEL: '1',
  ADVISERS_STORE: 'sqlite',
})

function setup(name) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-perf-partial-' + name + '-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return { root, home, work, db: join(home, 'state.db') }
}

function cli(home, args, cwd) {
  return execFileSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: CLI_ENV(home) })
}

/** Asia/Shanghai noon for a day offset from today (stable "today" buckets). */
function localNoon(offsetDays = 0) {
  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
  return new Date(Date.parse(localDay + 'T12:00:00+08:00') + offsetDays * 86400_000).toISOString()
}

/**
 * 50k synthetic ledger matching the performance audit's n50k shape, written
 * with one prepared statement per table inside a single transaction (the
 * Ledger.remember() generator is O(N^2) and takes ~1 minute at 50k).
 */
function seed50k(db) {
  const store = new SqliteStore(db)
  const now = Date.now()
  const day = 86400_000
  const hour = 3600_000
  store.db.exec('BEGIN')
  try {
    const matter = store.db.prepare('INSERT INTO matters(id,title,status,domain,secrecy,summary,participants,deadlines,open_questions,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    const matterIds = []
    for (let i = 0; i < 20; i++) {
      const id = 'matter_50k_' + i
      matterIds.push(id)
      matter.run(id, '客户项目-' + i, 'active', 'consulting', 0, null, '[]', '[]', '[]', new Date(now).toISOString(), new Date(now).toISOString())
    }
    const fact = store.db.prepare('INSERT INTO facts(id,matter_id,subject,predicate,object,recorded_at,authority,confidence,source,evidence,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    for (let i = 0; i < 50000; i++) {
      fact.run('fact_50k_' + i, matterIds[i % 20], '客户' + (i % 20) + '-议题' + i, 'stated',
        '第' + i + '条：甲方要求' + (i % 7 + 1) + '月提交报价单', new Date(now - i * 1000).toISOString(),
        'user', 0.9, null, JSON.stringify([{ quote: '甲方要求第' + i + '条按期交付' }]), i % 2 ? 'confirmed' : 'candidate')
    }
    const commitment = store.db.prepare('INSERT INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    for (let i = 0; i < 25000; i++) {
      // 24,995 plain open commitments far from every bucket, then five
      // classified rows (overdue, today, this week, waiting, no due date),
      // then 100 done ones the partial loaders must not need.
      let due = i < 24995 ? new Date(now + 30 * day).toISOString() : null
      let action = '发送第' + i + '版交付物'
      let debtor = 'user'
      if (i === 24995) { due = localNoon(-2); action = '逾期两天' }
      else if (i === 24996) { due = localNoon(0); action = '今天到期' }
      else if (i === 24997) { due = localNoon(3); action = '三天后' }
      else if (i === 24998) { due = localNoon(30); action = '等王工回复'; debtor = 'third:王工' }
      else if (i === 24999) { due = null; action = '无截止' }
      const status = i >= 25000 ? 'done' : 'open'
      commitment.run('cm_50k_' + i, matterIds[i % 20], debtor, '王工', action, due, 'Asia/Shanghai', status,
        JSON.stringify([{ quote: '承诺第' + i + '条' }]), 'todo', status === 'done' ? new Date(now).toISOString() : null, null)
    }
    for (let i = 0; i < 100; i++) {
      commitment.run('cm_50k_done_' + i, matterIds[i % 20], 'user', '王工', '已完成' + i, new Date(now + 30 * day).toISOString(), 'Asia/Shanghai', 'done', '[]', 'todo', new Date(now).toISOString(), null)
    }
    const pref = store.db.prepare('INSERT INTO preferences(id,kind,statement,scope,source,evidence,confidence,status,valid_from,last_confirmed,expires_at,priority) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    for (let i = 0; i < 5000; i++) {
      pref.run('pref_50k_' + i, 'preference', '偏好' + i + '：报价单先给总价再列明细', '{"level":"global"}', '{"type":"user_explicit"}', '[]', 0.9, 'confirmed', new Date(now).toISOString(), null, null, 'soft')
    }
    const session = store.db.prepare('INSERT INTO sessions(conversation_id,matter_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
    for (let i = 0; i < 20; i++) session.run('conv-50k-' + i, matterIds[i], '会话' + i, new Date(now).toISOString(), new Date(now - i * 1000).toISOString())
    const delivery = store.db.prepare('INSERT INTO deliveries(id,matter_id,conversation_id,files,tool,title,validation,created_at) VALUES(?,?,?,?,?,?,?,?)')
    for (let i = 0; i < 2500; i++) delivery.run('del_50k_' + i, matterIds[i % 20], 'conv-50k-' + (i % 20), '["out/deliv.docx"]', 'office', '交付' + i, 'ok', new Date(now - i * 1000).toISOString())
    const modelCall = store.db.prepare('INSERT INTO model_calls(id,conversation_id,matter_id,task,model,status,thinking,attempts,prompt_tokens,completion_tokens,reasoning_tokens,cached_tokens,total_tokens,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    for (let i = 0; i < 2500; i++) modelCall.run('mc_50k_' + i, 'conv-50k-' + (i % 20), matterIds[i % 20], 'chat', 'deepseek-chat', 'ok', 0, 1, 100, 50, 0, 0, 150, 1200, new Date(now - i * 1000).toISOString())
    store.db.exec('COMMIT')
  } catch (error) {
    try { store.db.exec('ROLLBACK') } catch {}
    throw error
  } finally {
    store.close()
  }
}

/**
 * Run the CLI with a preloaded module that replaces forbidden SqliteStore
 * loaders with throwing stubs. Both modules resolve the same lib/sqlite.js URL,
 * so this is a deterministic "the command never calls store.load()" assertion.
 */
function runWithForbiddenLoaders({ root, home, work }, args, forbidden) {
  const patchPath = join(root, 'patch-' + Buffer.from(forbidden.join(',')).toString('hex').slice(0, 16) + '.mjs')
  writeFileSync(patchPath, [
    'const { SqliteStore } = await import(' + JSON.stringify(sqliteModuleUrl) + ')',
    'for (const name of ' + JSON.stringify(forbidden) + ') {',
    "  SqliteStore.prototype[name] = function () { throw new Error('ASSERT: forbidden loader called: ' + name) }",
    '}',
    '',
  ].join('\n'))
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(patchPath).href, bin, ...args], {
    cwd: work, encoding: 'utf8', timeout: 60000,
    // `who --json` on the 50k fixture is ~5MB of JSON; keep spawnSync's 1MiB
    // default maxBuffer from SIGTERM-ing the child (which would look like a
    // command failure and hide the real assertion).
    maxBuffer: 64 * 1024 * 1024,
    env: CLI_ENV(home),
  })
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

const ALL_TABLE_LOADERS = [
  'load', 'loadSnapshot', 'loadMatters', 'loadFacts', 'loadPreferences',
  'loadLinks', 'loadUpdates', 'loadRoutines', 'loadRoutinePatches', 'loadRoutes',
]
const exceptLoaders = (...allowed) => ALL_TABLE_LOADERS.filter((name) => !allowed.includes(name))

test('50k synthetic: status/today/who/week/receipt/deliveries never fall back to the full snapshot', () => {
  const { root, home, work, db } = setup('commands')
  try {
    seed50k(db)

    // status only needs COUNTs + the model_calls aggregate: no row loader at all.
    const status = runWithForbiddenLoaders({ root, home, work }, ['status', '--json'], ALL_TABLE_LOADERS)
    assert.equal(status.status, 0, status.stderr)
    const statusJson = JSON.parse(status.stdout)
    assert.equal(statusJson.matters, 20)
    assert.equal(statusJson.prefs, 5000)
    assert.equal(statusJson.routines, 0)
    assert.equal(statusJson.links, 0)
    assert.equal(statusJson.sessions, 20)
    assert.equal(statusJson.deliveries, 2500)
    assert.deepEqual(statusJson.modelUsage, { calls: 2500, prompt_tokens: 250000, completion_tokens: 125000, reasoning_tokens: 0, cached_tokens: 0, total_tokens: 375000 })

    // today only needs commitments.
    const today = runWithForbiddenLoaders({ root, home, work }, ['today', '--json'], exceptLoaders('loadCommitments'))
    assert.equal(today.status, 0, today.stderr)
    const todayJson = JSON.parse(today.stdout)
    assert.deepEqual(todayJson.counts, { today: 1, overdue: 1, week: 1, waiting: 1, noDue: 1 })
    assert.deepEqual(todayJson.overdue.map((c) => c.action), ['逾期两天'])
    assert.deepEqual(todayJson.today.map((c) => c.action), ['今天到期'])
    assert.deepEqual(todayJson.week.map((c) => c.action), ['三天后'])
    assert.deepEqual(todayJson.waiting.map((c) => c.action), ['等王工回复'])
    assert.deepEqual(todayJson.noDue.map((c) => c.action), ['无截止'])
    assert.deepEqual(todayJson.next, { id: 'cm_50k_24995', action: '逾期两天', dueAt: localNoon(-2) })

    // who / week / receipt are commitments-only reads.
    const who = runWithForbiddenLoaders({ root, home, work }, ['who', '--json'], exceptLoaders('loadCommitments'))
    assert.equal(who.status, 0, who.stderr)
    const whoJson = JSON.parse(who.stdout)
    assert.equal(whoJson.mine.length, 24999)
    assert.equal(whoJson.waiting.length, 1)

    const week = runWithForbiddenLoaders({ root, home, work }, ['week'], exceptLoaders('loadCommitments'))
    assert.equal(week.status, 0, week.stderr)
    assert.match(week.stdout, /^本周（/m)

    const receipt = runWithForbiddenLoaders({ root, home, work }, ['receipt'], exceptLoaders('loadCommitments'))
    assert.equal(receipt.status, 0, receipt.stderr)
    // Only the delivery's own matter is read (25,000 open commitments / 20 matters).
    assert.match(receipt.stdout, /未完成承诺：1250/)

    // deliveries reads only matter titles for its label fallback.
    const deliveries = runWithForbiddenLoaders({ root, home, work }, ['deliveries'], exceptLoaders('loadMatters'))
    assert.equal(deliveries.status, 0, deliveries.stderr)
    assert.match(deliveries.stdout, /交付0\s+\[office\] ok/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('50k synthetic: the preload assertion catches a regression to store.load()', () => {
  const { root, home, work, db } = setup('control')
  try {
    seed50k(db)
    // Negative control: `commit ls` still reads the full ledger, so the same
    // stubbing must fail it. This proves the assertion above is not vacuous.
    const control = runWithForbiddenLoaders({ root, home, work }, ['commit', 'ls'], ALL_TABLE_LOADERS)
    assert.notEqual(control.status, 0)
    assert.match(control.stderr, /ASSERT: forbidden loader called: load/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('50k synthetic: partial loads use the indexed queries and match the full snapshot', () => {
  const { root, db } = setup('sql')
  try {
    seed50k(db)
    const store = new SqliteStore(db)
    try {
      const plan = (sql) => store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((row) => row.detail).join(' | ')
      // status path: COUNTs are served by covering indexes (no facts row load).
      assert.match(plan("SELECT COUNT(*) AS n FROM commitments WHERE status = 'open'"), /idx_commitments_status_due/)
      assert.match(plan("SELECT COUNT(*) AS n FROM facts WHERE status = 'confirmed'"), /idx_facts_status_deleted/)
      assert.match(plan("SELECT COUNT(*) AS n FROM preferences WHERE status = 'confirmed'"), /idx_preferences_status_expires/)
      // today path: the open-commitment filter is an index search.
      assert.match(plan("SELECT * FROM commitments WHERE status = 'open' ORDER BY rowid"), /idx_commitments_status_due/)

      const full = store.load()
      const open = store.loadCommitments({ status: 'open' })
      assert.equal(open.length, 25000)
      assert.equal(full.commitments.length, 25100)
      // Exact parity on every open row, not just a sample (ORDER BY rowid keeps
      // the historical insertion order the full load returns).
      assert.deepEqual(open, full.commitments.filter((c) => c.status === 'open'))
      // The audit's "sampling" parity: first/middle/last rows of the big tables.
      const sample = (rows) => [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]]
      assert.deepEqual(sample(store.loadFacts()), sample(full.facts))
      assert.deepEqual(sample(store.loadPreferences()), sample(full.preferences))
      assert.deepEqual(store.loadFacts({ status: 'confirmed' }).length, 25000)
      assert.equal(store.countCommitments({ status: 'done' }), 100)
      assert.equal(store.countFacts({ status: 'confirmed' }), 25000)
      assert.equal(store.countPreferences(), 5000)
      assert.equal(store.countSessions(), 20)
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
