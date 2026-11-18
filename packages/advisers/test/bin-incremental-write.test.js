import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { tosEnv } from './tos-fixture.js'
import { SqliteStore } from '../lib/sqlite.js'
import { Ledger } from '../../core/dist/index.js'

// 0.2.3 Wave 2b (03-design-persistence-v2.md §3): the CLI write commands use one
// directed INSERT/UPDATE + exactly one audit row inside a single transaction and
// never pay for the full load+save path. These tests pin the CLI contract:
//  - the incremental commands never call load/loadSnapshot/save/saveWithAudit;
//  - each command writes exactly one audit row (none where 0.2.2 wrote none);
//  - missing-id / business errors keep the historical text and write nothing;
//  - tick and import/purge keep their atomicity/data-safety semantics.
const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const sqliteLib = fileURLToPath(new URL('../lib/sqlite.js', import.meta.url))

function env(home, extra = {}) {
  return tosEnv(home, {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_STORE: 'sqlite',
    ...extra,
  })
}
function cli(home, args, { extra = {}, preload } = {}) {
  const argv = preload ? ['--import', pathToFileURL(preload).href, bin, ...args] : [bin, ...args]
  return spawnSync(process.execPath, argv, { env: env(home, extra), encoding: 'utf8', timeout: 120000 })
}
function cliOk(home, args, options) {
  const result = cli(home, args, options)
  assert.equal(result.status, 0, 'advisers ' + args.join(' ') + ' failed: ' + result.stderr)
  return result
}
/** Await a spawned child's exit without hanging when it already exited. */
function waitClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('close', resolve))
}
function setup(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-inc-bin-' + prefix + '-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return { root, home, work, db: join(home, 'state.db') }
}
function readDb(home) { return new DatabaseSync(join(home, 'state.db'), { readOnly: true }) }
function rows(home, sql, ...params) {
  const db = readDb(home)
  try { return db.prepare(sql).all(...params) } finally { db.close() }
}
function one(home, sql, ...params) {
  const db = readDb(home)
  try { return db.prepare(sql).get(...params) } finally { db.close() }
}
function auditRows(home, action) {
  return one(home, 'SELECT COUNT(*) AS n FROM audit WHERE action = ?', action).n
}
function writePreload(root) {
  const file = join(root, 'forbid-full-snapshot.mjs')
  writeFileSync(file, [
    'const { SqliteStore } = await import(' + JSON.stringify(pathToFileURL(sqliteLib).href) + ')',
    "for (const name of ['load', 'loadSnapshot', 'save', 'saveWithAudit']) {",
    "  SqliteStore.prototype[name] = function () { throw new Error('ASSERT: full snapshot method called: ' + name) }",
    '}',
    '',
  ].join('\n'))
  return file
}
/** Seed a small ledger directly through the library (not the CLI under test). */
function seed(home) {
  const store = new SqliteStore(join(home, 'state.db'))
  try {
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: '增量写测试' })
    const other = ledger.addMatter({ title: '另一个事项' })
    const fact = ledger.remember({
      matterId: matter.id, subject: '客户', predicate: '预算', object: '300 万',
      authority: 'user', evidence: [{ quote: '预算 300 万' }],
    })
    const stale = ledger.addPreference({ kind: 'preference', statement: '很久以前的偏好', confidence: 0.5, status: 'confirmed' })
    stale.validFrom = new Date(Date.now() - 150 * 86400_000).toISOString()
    const open = ledger.addCommitment({
      matterId: other.id, debtor: 'user', creditor: '王工', action: '待办事项',
      dueAt: new Date(Date.now() + 86400_000).toISOString(),
      evidence: [{ sessionId: 's', turnId: 't', quote: '待办' }],
    })
    ledger.proposeLink({ fromMatter: matter.id, toMatter: other.id, type: 'related', evidence: ['同一客户'] })
    ledger.proposeUpdate({ sourceMatter: matter.id, targetMatter: other.id, change: '同步报价口径' })
    ledger.setRoute('cli:cli', matter.id)
    store.save(ledger.toJSON())
    const candidate = store.proposeCandidate({
      kind: 'fact',
      payload: { subject: '客户B', predicate: '偏好', object: '邮件先结论' },
      evidence: [{ quote: '邮件先结论' }],
    })
    return { matterId: matter.id, otherId: other.id, factId: fact.id, openId: open.id, candidateId: candidate.id }
  } finally { store.close() }
}

test('incremental writes never call the full-snapshot methods (commit add/edit/snooze/done, correct, decay, tick)', () => {
  const { root, home, work } = setup('no-full-snapshot')
  try {
    const preload = writePreload(root)
    const add = cliOk(home, ['commit', 'add', '基准承诺', '--quote', 'q'], { preload })
    const id = /^(\S+) open /.exec(add.stdout)?.[1]
    assert.ok(id, 'commit add must print the created id: ' + add.stdout)
    const commands = [
      ['commit', 'edit', id, '--action', '改后的承诺'],
      ['commit', 'snooze', id, '24'],
      ['commit', 'done', id, '--evidence', '交付验收'],
      ['correct', '邮件先结论'],
      ['correct', '邮件先结论'],
      ['decay'],
      ['tick', '--json'],
    ]
    for (const args of commands) {
      const result = cli(home, args, { preload })
      assert.equal(result.status, 0, 'advisers ' + args.join(' ') + ' failed with the full-snapshot guard: ' + result.stderr)
      assert.doesNotMatch(result.stderr, /ASSERT: full snapshot method called/)
    }
    assert.equal(one(home, 'SELECT status, done_at FROM commitments WHERE id = ?', id).status, 'done')
    const prefs = rows(home, 'SELECT statement, status, confidence FROM preferences ORDER BY rowid')
    assert.equal(prefs.length, 1)
    assert.equal(prefs[0].status, 'confirmed')
    assert.equal(prefs[0].confidence, 1)
    assert.equal(existsSync(join(work, 'state.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('incremental writes (forget / memory accept / purge) never call the full-snapshot methods', () => {
  const { root, home } = setup('no-full-snapshot-2')
  try {
    const preload = writePreload(root)
    const seeded = seed(home)
    for (const args of [
      ['forget', seeded.factId],
      ['memory', 'accept', seeded.candidateId],
      ['purge', seeded.matterId, '--yes'],
    ]) {
      const result = cli(home, args, { preload })
      assert.equal(result.status, 0, 'advisers ' + args.join(' ') + ' failed with the full-snapshot guard: ' + result.stderr)
      assert.doesNotMatch(result.stderr, /ASSERT: full snapshot method called/)
    }
    assert.equal(one(home, 'SELECT status FROM facts WHERE id = ?', seeded.factId).status, 'deleted')
    assert.equal(one(home, 'SELECT status FROM memory_candidates WHERE id = ?', seeded.candidateId).status, 'accepted')
    assert.equal(one(home, 'SELECT status, title FROM matters WHERE id = ?', seeded.matterId).status, 'archived')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('each incremental write command appends exactly one audit row; decay/forget/tick add none', () => {
  const { root, home } = setup('audit-rows')
  try {
    const seeded = seed(home)
    const auditTotal = () => one(home, 'SELECT COUNT(*) AS n FROM audit').n
    assert.equal(auditTotal(), 0, 'library seeding writes no audit rows')

    const add = cliOk(home, ['commit', 'add', '一行审计', '--quote', 'q'])
    const id = /^(\S+) open /.exec(add.stdout)?.[1]
    assert.ok(id)
    assert.equal(auditTotal(), 1)
    const expected = [
      [['commit', 'edit', id, '--action', '改后的动作'], 'commit.update'],
      [['commit', 'snooze', id, '2'], 'commit.snooze'],
      [['commit', 'done', id, '--evidence', '验收'], 'commit.done'],
      [['correct', '审计偏好'], 'correct'],
      [['memory', 'accept', seeded.candidateId], 'memory.accept'],
    ]
    for (const [args, action] of expected) {
      const before = auditTotal()
      cliOk(home, args)
      assert.equal(auditTotal(), before + 1, args.join(' ') + ' must append exactly one audit row')
      assert.equal(auditRows(home, action), 1, args.join(' ') + ' must record action ' + action)
    }
    // Historical commands that never wrote an audit row keep doing so.
    const silent = [['decay'], ['tick', '--json'], ['forget', seeded.factId]]
    const beforeSilent = auditTotal()
    for (const args of silent) cliOk(home, args)
    assert.equal(auditTotal(), beforeSilent, 'decay/tick/forget must not add audit rows')
    assert.equal(auditRows(home, 'matter.purge'), 0)
    assert.match(cliOk(home, ['audit']).stdout, /audit: verified/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing commitment ids keep the historical text and write nothing', () => {
  const { root, home } = setup('missing-ids')
  try {
    cliOk(home, ['commit', 'add', 'seed', '--quote', 'q'])
    const auditBefore = one(home, 'SELECT COUNT(*) AS n FROM audit').n
    for (const [args, text] of [
      [['commit', 'edit', 'cm_missing', '--action', 'x'], /unknown commitment: cm_missing/],
      [['commit', 'done', 'cm_missing', '--evidence', 'e'], /unknown commitment: cm_missing/],
      [['commit', 'snooze', 'cm_missing', '24'], /usage: advisers commit snooze <id> <hours>/],
    ]) {
      const result = cli(home, args)
      assert.equal(result.status, 1, args.join(' ') + ' must exit 1')
      assert.match(result.stderr, text)
      assert.equal(one(home, 'SELECT COUNT(*) AS n FROM audit').n, auditBefore, args.join(' ') + ' must write no audit row')
    }
    assert.equal(one(home, "SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'snooze:%'").n, 0)
    assert.equal(one(home, 'SELECT COUNT(*) AS n FROM commitments').n, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('memory accept is atomic: a failed evidence lookup leaves the candidate pending and writes no entity/audit', () => {
  const { root, home } = setup('accept-atomic')
  try {
    cliOk(home, ['commit', 'add', 'seed', '--quote', 'q'])
    const store = new SqliteStore(join(home, 'state.db'))
    let bad
    let good
    try {
      bad = store.proposeCandidate({
        kind: 'commitment',
        payload: { debtor: 'user', creditor: '王工', action: '缺证据的候选' },
        evidence: [{ sessionId: 'conv-missing', turnId: 'turn_missing', quote: 'q' }],
      })
      good = store.proposeCandidate({
        kind: 'commitment',
        payload: { debtor: 'user', creditor: '王工', action: '合法候选' },
        evidence: [{ quote: '无会话来源' }],
      })
    } finally { store.close() }
    const commitmentsBefore = one(home, 'SELECT COUNT(*) AS n FROM commitments').n
    const failed = cli(home, ['memory', 'accept', bad.id])
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /evidence turn not found/)
    assert.equal(one(home, 'SELECT status FROM memory_candidates WHERE id = ?', bad.id).status, 'pending', 'the candidate status must roll back')
    assert.equal(one(home, 'SELECT COUNT(*) AS n FROM commitments').n, commitmentsBefore, 'no commitment row may be inserted')
    assert.equal(auditRows(home, 'memory.accept'), 0, 'no audit row may survive the rollback')
    const accepted = cliOk(home, ['memory', 'accept', good.id])
    assert.match(accepted.stdout, /^accepted /m)
    assert.equal(one(home, 'SELECT status FROM memory_candidates WHERE id = ?', good.id).status, 'accepted')
    assert.equal(one(home, 'SELECT COUNT(*) AS n FROM commitments').n, commitmentsBefore + 1)
    assert.equal(auditRows(home, 'memory.accept'), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tick commits nudge inserts + snooze wake-up + meta cleanup atomically and writes no audit row', () => {
  const { root, home } = setup('tick-atomic')
  try {
    const store = new SqliteStore(join(home, 'state.db'))
    let woken
    let sleeping
    try {
      const ledger = new Ledger()
      const matter = ledger.addMatter({ title: 'tick 事务' })
      const due = new Date(Date.now() + 2 * 86400_000).toISOString()
      woken = ledger.addCommitment({ matterId: matter.id, debtor: 'user', creditor: '王工', action: '该醒了', dueAt: due, evidence: [{ sessionId: 's', turnId: 't', quote: 'q' }] })
      sleeping = ledger.addCommitment({ matterId: matter.id, debtor: 'user', creditor: '王工', action: '继续睡', dueAt: due, evidence: [{ sessionId: 's', turnId: 't', quote: 'q' }] })
      woken.status = 'snoozed'
      sleeping.status = 'snoozed'
      store.save(ledger.toJSON())
      store.setMeta('snooze:' + woken.id, new Date(Date.now() - 3600_000).toISOString())
      store.setMeta('snooze:' + sleeping.id, new Date(Date.now() + 3600_000).toISOString())
    } finally { store.close() }
    const tick = JSON.parse(cliOk(home, ['tick', '--json']).stdout)
    assert.ok(tick.due.some((c) => c.id === woken.id), 'the expired snooze must be in the due list')
    assert.ok(!tick.due.some((c) => c.id === sleeping.id), 'the still-snoozed row must stay hidden')
    const db = readDb(home)
    try {
      assert.equal(db.prepare('SELECT status FROM commitments WHERE id = ?').get(woken.id).status, 'open')
      assert.equal(db.prepare('SELECT status FROM commitments WHERE id = ?').get(sleeping.id).status, 'snoozed')
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta WHERE key = ?').get('snooze:' + woken.id).n, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta WHERE key = ?').get('snooze:' + sleeping.id).n, 1)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nudges').get().n > 0, true)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 0, 'tick never writes audit rows')
    } finally { db.close() }
    // A second tick does not duplicate the nudge rows.
    const nudgesBefore = one(home, 'SELECT COUNT(*) AS n FROM nudges').n
    cliOk(home, ['tick', '--json'])
    assert.equal(one(home, 'SELECT COUNT(*) AS n FROM nudges').n, nudgesBefore)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('import --replace folds a committed WAL-only row into its pre-import backup', async () => {
  const { root, home } = setup('import-wal')
  try {
    cliOk(home, ['commit', 'add', '导入前的种子', '--quote', 'q'])
    // A writer that commits one row and is SIGKILLed leaves that row only in the
    // WAL. The pre-import backup must not silently miss it (0.2.3 §3.3.11).
    const writerScript = join(root, 'wal-writer.mjs')
    writeFileSync(writerScript, [
      'const { SqliteStore } = await import(' + JSON.stringify(pathToFileURL(sqliteLib).href) + ')',
      'const store = new SqliteStore(process.env.ADVISERS_TEST_DB)',
      "store.db.exec('PRAGMA wal_autocheckpoint = 0')",
      "store.mutate(() => store.insertCommitment({ id: 'cm_wal_only', matterId: 'matter_wal', debtor: 'user', creditor: '王工', action: 'WAL 里的一行', timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none' }))",
      "process.stdout.write('written\\n')",
      'setInterval(() => {}, 60000)',
    ].join('\n'))
    const writer = spawn(process.execPath, [writerScript], { env: { ...process.env, ADVISERS_TEST_DB: join(home, 'state.db') }, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WAL writer did not start')), 10000)
        writer.stdout.on('data', (chunk) => { if (String(chunk).includes('written')) { clearTimeout(timer); resolve() } })
      })
      assert.ok(existsSync(join(home, 'state.db-wal')), 'fixture: the committed row must live in the WAL')
      writer.kill('SIGKILL')
      await waitClose(writer)
    } finally {
      if (writer.exitCode === null) writer.kill('SIGKILL')
      await waitClose(writer)
    }

    const imported = new Ledger()
    imported.addMatter({ title: '导入后的账本' })
    writeFileSync(join(root, 'import.json'), JSON.stringify(imported.toJSON()))
    const result = cliOk(home, ['import', join(root, 'import.json'), '--replace'])
    assert.match(result.stdout, /imported 1 matters, 0 commitments/)
    const backups = readdirSync(home).filter((name) => name.startsWith('import-backup-'))
    assert.equal(backups.length, 1, 'import must keep exactly one pre-import backup')
    const backupDb = new DatabaseSync(join(home, backups[0]), { readOnly: true })
    try {
      assert.equal(backupDb.prepare('SELECT COUNT(*) AS n FROM commitments WHERE id = ?').get('cm_wal_only').n, 1,
        'the backup must include WAL-only committed rows (checkpoint before copy)')
    } finally { backupDb.close() }
    assert.equal(one(home, 'SELECT COUNT(*) AS n FROM commitments').n, 0, 'import replaced the ledger')
    assert.equal(auditRows(home, 'import.ledger'), 1, 'import writes one audit row')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('purge --yes tombstones the ledger and deletes matter data in one transaction; the dry-run is lock-free', async () => {
  const { root, home } = setup('purge')
  try {
    const seeded = seed(home)
    const dry = cliOk(home, ['purge', seeded.matterId])
    assert.match(dry.stdout, /dry-run only; re-run with --yes to purge/)
    assert.equal(one(home, 'SELECT status FROM facts WHERE id = ?', seeded.factId).status, 'confirmed')
    assert.equal(one(home, 'SELECT status FROM links').status, 'candidate')

    // A live writer holding the HOME lock must not block the read-only dry-run,
    // while the deleting form still fails closed with E_DB_LOCKED.
    const holderScript = join(root, 'holder.mjs')
    writeFileSync(holderScript, [
      'import { acquireInstanceLock } from ' + JSON.stringify(pathToFileURL(sqliteLib).href),
      "const lock = acquireInstanceLock({ home: process.env.ADVISERS_HOME, command: 'test-holder', timeoutMs: 5000 })",
      "process.stdout.write('held\\n')",
      'setInterval(() => {}, 60000)',
    ].join('\n'))
    const holder = spawn(process.execPath, [holderScript], { env: env(home), stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('lock holder did not start')), 10000)
        holder.stdout.on('data', (chunk) => { if (String(chunk).includes('held')) { clearTimeout(timer); resolve() } })
      })
      const dryLocked = cli(home, ['purge', seeded.matterId])
      assert.equal(dryLocked.status, 0, 'the purge dry-run must be lock-free: ' + dryLocked.stderr)
      const blocked = cli(home, ['purge', seeded.matterId, '--yes'], { extra: { ADVISERS_LOCK_TIMEOUT_MS: '150' } })
      assert.equal(blocked.status, 1, 'the deleting purge must fail closed while the lock is held')
      assert.match(blocked.stderr, /E_DB_LOCKED/)
    } finally {
      if (holder.exitCode === null) holder.kill('SIGKILL')
      await waitClose(holder)
    }

    const purged = cliOk(home, ['purge', seeded.matterId, '--yes'])
    assert.match(purged.stdout, /purged: \{"facts":1,"links":1,"updates":1,"commitments":0,"preferences":0,"routes":1\} sqlite=\{/)
    const fact = one(home, 'SELECT status, object, source, evidence, deleted_at, deleted_reason FROM facts WHERE id = ?', seeded.factId)
    assert.equal(fact.status, 'deleted')
    assert.equal(fact.object, '[purged]')
    assert.equal(fact.source, null)
    assert.equal(fact.evidence, null)
    assert.equal(fact.deleted_reason, 'matter_purged')
    assert.ok(fact.deleted_at)
    assert.equal(one(home, 'SELECT status FROM links').status, 'rejected')
    assert.equal(one(home, 'SELECT status, change FROM updates').status, 'rejected')
    assert.equal(one(home, 'SELECT change FROM updates').change, '[purged]')
    const matter = one(home, 'SELECT status, title, summary FROM matters WHERE id = ?', seeded.matterId)
    assert.equal(matter.status, 'archived')
    assert.equal(matter.title, '[purged]')
    assert.equal(matter.summary, null)
    assert.equal(one(home, "SELECT COUNT(*) AS n FROM routes WHERE matter_id = ?", seeded.matterId).n, 0)
    assert.equal(auditRows(home, 'matter.purge'), 1)
    assert.match(one(home, "SELECT reason FROM audit WHERE action = 'matter.purge'").reason, new RegExp('^' + seeded.matterId))
    assert.equal(one(home, 'SELECT status FROM commitments WHERE id = ?', seeded.openId).status, 'open', 'commitments of other matters are untouched')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function writeWalProbe(root) {
  const file = join(root, 'wal-probe.mjs')
  writeFileSync(file, [
    "import { appendFileSync, statSync } from 'node:fs'",
    "process.on('exit', () => {",
    '  let size = -1',
    "  try { size = statSync(process.env.ADVISERS_HOME + '/state.db-wal').size } catch {}",
    "  appendFileSync(process.env.ADVISERS_WAL_PROBE, size + '\\n')",
    '})',
  ].join('\n'))
  return file
}

test('single-row writes keep the WAL increment far below 1MB on a large ledger (no full save)', () => {
  const { root, home } = setup('wal-size')
  try {
    // ~20k facts + 10k commitments, i.e. a ledger whose full save() used to
    // rewrite tens of MB of WAL for one row. Small enough to stay CI-friendly.
    const store = new SqliteStore(join(home, 'state.db'))
    try {
      const now = new Date().toISOString()
      store.db.exec('BEGIN')
      try {
        const matter = store.db.prepare('INSERT INTO matters(id,title,status,domain,secrecy,summary,participants,deadlines,open_questions,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        const ids = []
        for (let i = 0; i < 20; i++) {
          const id = 'matter_wal_' + i
          ids.push(id)
          matter.run(id, '客户-' + i, 'active', 'consulting', 0, null, '[]', '[]', '[]', now, now)
        }
        const fact = store.db.prepare('INSERT INTO facts(id,matter_id,subject,predicate,object,recorded_at,authority,confidence,source,evidence,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        for (let i = 0; i < 20000; i++) {
          fact.run('fact_wal_' + i, ids[i % 20], '客户' + (i % 20), 'stated', '第' + i + '条要求', now, 'user', 0.9, null, '[]', i % 2 ? 'confirmed' : 'candidate')
        }
        const commitment = store.db.prepare('INSERT INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        for (let i = 0; i < 10000; i++) {
          commitment.run('cm_wal_' + i, ids[i % 20], 'user', '王工', '发送第' + i + '版交付物', null, 'Asia/Shanghai', i % 3 === 0 ? 'done' : 'open', '[]', 'todo', null, null)
        }
        const pref = store.db.prepare('INSERT INTO preferences(id,kind,statement,scope,source,evidence,confidence,status,valid_from,last_confirmed,expires_at,priority) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        for (let i = 0; i < 1000; i++) {
          pref.run('pref_wal_' + i, 'preference', '偏好' + i, '{"level":"global"}', '{"type":"user_explicit"}', '[]', 0.9, 'confirmed', now, null, null, 'soft')
        }
        store.db.exec('COMMIT')
      } catch (error) {
        try { store.db.exec('ROLLBACK') } catch {}
        throw error
      }
    } finally { store.close() }

    const probe = writeWalProbe(root)
    const probeFile = join(root, 'wal-sizes.txt')
    const add = cli(home, ['commit', 'add', '一行 WAL', '--quote', 'q'], { preload: probe, extra: { ADVISERS_WAL_PROBE: probeFile } })
    assert.equal(add.status, 0, add.stderr)
    const correct = cli(home, ['correct', 'WAL 偏好'], { preload: probe, extra: { ADVISERS_WAL_PROBE: probeFile } })
    assert.equal(correct.status, 0, correct.stderr)
    const decay = cli(home, ['decay'], { preload: probe, extra: { ADVISERS_WAL_PROBE: probeFile } })
    assert.equal(decay.status, 0, decay.stderr)
    // -1 means "no -wal file at exit" (a read-only/no-op transaction): count it as 0.
    const sizes = readFileSync(probeFile, 'utf8').trim().split('\n').map(Number).map((n) => (n < 0 ? 0 : n))
    assert.equal(sizes.length, 3, 'fixture: one WAL sample per write command')
    const [addSize, correctSize, decaySize] = sizes
    assert.ok(addSize > 0, 'commit add must actually write (sample ' + addSize + ')')
    assert.ok(addSize < 1024 * 1024, 'commit add WAL increment must stay below 1MB, got ' + addSize + ' bytes')
    assert.ok(correctSize < 1024 * 1024, 'correct WAL increment must stay below 1MB, got ' + correctSize + ' bytes')
    assert.ok(decaySize < 1024 * 1024, 'decay (0 changed preferences here) WAL increment must stay below 1MB, got ' + decaySize + ' bytes')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})