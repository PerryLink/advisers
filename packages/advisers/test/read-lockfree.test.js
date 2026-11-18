import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { openReadStore, SqliteStore } from '../lib/sqlite.js'

// 0.2.3 read path (03-design-persistence-v2.md §4): a read-only store runs no
// DDL/migration, takes no HOME instance lock, reads a committed WAL snapshot
// while a writer holds an uncommitted transaction, and survives a SIGKILLed
// writer's WAL. Writes on a read-only connection fail with E_READ_ONLY; stale/
// newer schemas fail with E_SCHEMA_STALE / E_SCHEMA_NEWER.

const NOW = '2026-11-01T00:00:00.000Z'
const sqliteLib = fileURLToPath(new URL('../lib/sqlite.js', import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(prefix = 'advisers-read-lockfree-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, db: join(root, 'state.db') };
}

function seed(dbPath) {
  const store = new SqliteStore(dbPath);
  try {
    store.mutate(() => {
      store.insertMatter({ id: 'm1', title: '客户', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW });
      store.insertCommitment({ id: 'cm1', matterId: 'm1', debtor: 'user', creditor: 'u', action: '发报价', timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none' });
    }, { actor: 'local', action: 'seed', allowed: true, reason: 'seed' });
  } finally { store.close() }
}

function downgradeToV19(dbPath) {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('DROP INDEX IF EXISTS idx_turns_seq');
    raw.exec('DROP INDEX IF EXISTS idx_facts_identity');
    raw.exec('DROP INDEX IF EXISTS idx_memory_candidates_status');
    raw.exec('DROP TABLE IF EXISTS schema_migrations');
    for (const key of ['schema_migrated_from', 'schema_migrated_at', 'schema_migrated_app', 'schema_migration_backup']) {
      raw.prepare('DELETE FROM meta WHERE key = ?').run(key);
    }
    raw.prepare("UPDATE meta SET value = '19' WHERE key = 'schema_version'").run();
  } finally { raw.close() }
}

function rawHasTable(dbPath, table) {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try { return Number(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(table).n) > 0 } finally { raw.close() }
}

test('a read-only store runs no DDL/migration and refuses every write with E_READ_ONLY', () => {
  const { root, db } = setup();
  try {
    seed(db);
    const beforeVersion = (() => { const s = new SqliteStore(db); try { return s.getMeta('schema_version') } finally { s.close() } })();
    const beforeFiles = readdirSync(root).sort();
    const store = new SqliteStore(db, { readOnly: true });
    try {
      assert.equal(store.readOnly, true);
      assert.equal(store.schemaVersion(), 20);
      assert.equal(store.assertSchemaCurrent(), 20);
      assert.equal(store.countCommitments(), 1);
      assert.equal(store.read(() => store.countMatters() + store.countCommitments()), 2);
      assert.equal(store.load().commitments.length, 1);
    } finally { store.close() }
    // A read-only connection may create SQLite's WAL/-shm sidecars, but it must
    // never create a backup/migration artifact nor change the database itself.
    const created = readdirSync(root).filter((name) => !beforeFiles.includes(name) && !name.endsWith('-wal') && !name.endsWith('-shm'));
    assert.deepEqual(created, [], 'a read-only open creates no migration/backup artifact');
    assert.equal(readdirSync(root).filter((name) => name.includes('before-migrate')).length, 0);
    assert.equal(rawHasTable(db, 'schema_migrations'), true, 'the seed database is already v20');
    const writable = new SqliteStore(db);
    try { assert.equal(writable.getMeta('schema_version'), beforeVersion) } finally { writable.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('write methods on a read-only store all throw E_READ_ONLY and write nothing', () => {
  const { root, db } = setup('advisers-readonly-writes-');
  try {
    seed(db);
    const store = new SqliteStore(db, { readOnly: true });
    const before = (() => { const s = new SqliteStore(db); try { return JSON.stringify(s.load()) } finally { s.close() } })();
    try {
      const row = { id: 'm1', title: 't', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW };
      const commitment = { id: 'cm1', matterId: 'm1', debtor: 'user', creditor: 'u', action: 'a', timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none' };
      const cases = [
        ['save', () => store.save({ version: 1, matters: [], facts: [], commitments: [], preferences: [], links: [], updates: [], routines: [], routinePatches: [], routes: {} })],
        ['saveWithAudit', () => store.saveWithAudit({ version: 1 }, { actor: 'local', action: 'x', allowed: true })],
        ['mutate', () => store.mutate(() => 1)],
        ['transaction', () => store.transaction(() => 1)],
        ['appendAudit', () => store.appendAudit({ actor: 'local', action: 'x', allowed: true })],
        ['setMeta', () => store.setMeta('k', 'v')],
        ['deleteMeta', () => store.deleteMeta('k')],
        ['checkpoint', () => store.checkpoint()],
        ['insertMatter', () => store.mutate(() => store.insertMatter(row))],
        ['updateMatter', () => store.mutate(() => store.updateMatter('m1', { title: 'x' }))],
        ['insertCommitment', () => store.mutate(() => store.insertCommitment(commitment))],
        ['setNudgeOutcome', () => store.setNudgeOutcome('n1', 'ignored')],
        ['addNudges', () => store.addNudges([])],
        ['deleteMetaKeys', () => store.deleteMetaKeys([])],
        ['applyTick', () => store.applyTick({})],
        ['purgeMatterData', () => store.purgeMatterData('m1')],
        ['addTurn', () => store.addTurn({ conversationId: 'c', role: 'user', content: 'x' })],
        ['markSeen', () => store.markSeen('l', 'a', 'k')],
        ['upsertSession', () => store.upsertSession({ conversationId: 'c', matterId: 'm1', title: 't' })],
        ['reviewCandidate', () => store.reviewCandidate('cand_1', 'accepted')],
        ['permitReplayStore', () => store.permitReplayStore()],
      ];
      for (const [name, fn] of cases) {
        assert.throws(fn, (error) => error.code === 'E_READ_ONLY', `${name} must throw E_READ_ONLY`);
      }
    } finally { store.close() }
    const after = (() => { const s = new SqliteStore(db); try { return JSON.stringify(s.load()) } finally { s.close() } })();
    assert.equal(after, before, 'no write may pass through a read-only store');
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('a stale v19 database opened read-only is not migrated and fails E_SCHEMA_STALE', () => {
  const { root, db } = setup('advisers-readonly-stale-');
  try {
    seed(db);
    downgradeToV19(db);
    const filesBefore = readdirSync(root).sort();
    const store = new SqliteStore(db, { readOnly: true });
    try {
      assert.equal(store.schemaVersion(), 19);
      assert.throws(() => store.assertSchemaCurrent(), (error) => error.code === 'E_SCHEMA_STALE' && /advisers doctor/.test(error.message));
      assert.equal(store.load().commitments.length, 1, 'the stale fixture is still readable, only the write path may migrate');
    } finally { store.close() }
    const created = readdirSync(root).filter((name) => !filesBefore.includes(name) && !name.endsWith('-wal') && !name.endsWith('-shm'));
    assert.deepEqual(created, [], 'a read-only open must not migrate/create a backup');
    assert.equal(readdirSync(root).filter((name) => name.includes('before-migrate')).length, 0);
    assert.equal(rawHasTable(db, 'schema_migrations'), false);
    assert.throws(() => openReadStore(db), (error) => error.code === 'E_SCHEMA_STALE');
    // A writable command migrates it, after which the read path works.
    const migrated = new SqliteStore(db);
    try { assert.equal(migrated.getMeta('schema_version'), '20') } finally { migrated.close() }
    const reader = openReadStore(db);
    try { assert.equal(reader.schemaVersion(), 20) } finally { reader.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('a newer schema opened read-only fails E_SCHEMA_NEWER', () => {
  const { root, db } = setup('advisers-readonly-newer-');
  try {
    seed(db);
    const raw = new DatabaseSync(db);
    raw.prepare("UPDATE meta SET value = '21' WHERE key = 'schema_version'").run();
    raw.close();
    assert.throws(() => openReadStore(db), (error) => {
      assert.equal(error.code, 'E_SCHEMA_NEWER');
      assert.match(error.message, /newer than this CLI/);
      return true;
    });
    const store = new SqliteStore(db, { readOnly: true });
    try { assert.throws(() => store.assertSchemaCurrent(), (error) => error.code === 'E_SCHEMA_NEWER') } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('read() holds one WAL snapshot even when a writer commits in between queries', () => {
  const { root, db } = setup('advisers-readonly-snapshot-');
  try {
    seed(db);
    const reader = openReadStore(db);
    const writer = new SqliteStore(db);
    try {
      const seen = reader.read(() => {
        const before = reader.countCommitments();
        writer.mutate(() => writer.insertCommitment({ id: 'cm2', matterId: 'm1', debtor: 'user', creditor: 'u', action: 'second', timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none' }));
        const after = reader.countCommitments();
        return { before, after };
      });
      assert.equal(seen.before, 1);
      assert.equal(seen.after, 1, 'a commit made inside the read transaction is invisible to it');
      assert.equal(reader.countCommitments(), 2, 'the next read sees the committed row');
      assert.equal(reader.read(() => reader.countCommitments()), 2);
    } finally { writer.close(); reader.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('a reader is not blocked by a writer holding an uncommitted transaction', () => {
  const { root, db } = setup('advisers-readonly-uncommitted-');
  try {
    seed(db);
    const writer = new SqliteStore(db);
    const reader = openReadStore(db);
    try {
      writer.db.exec('BEGIN IMMEDIATE');
      writer.db.prepare('INSERT INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('cm_uncommitted', 'm1', 'user', 'u', 'uncommitted', null, 'Asia/Shanghai', 'open', '[]', 'none', null, null);
      const startedAt = Date.now();
      const counts = reader.read(() => ({ matters: reader.countMatters(), commitments: reader.countCommitments() }));
      const elapsed = Date.now() - startedAt;
      assert.deepEqual(counts, { matters: 1, commitments: 1 }, 'only committed rows are visible');
      assert.ok(elapsed < 1000, `reader must not wait for the writer (took ${elapsed}ms)`);
      assert.equal(reader.getCommitment('cm_uncommitted'), undefined);
      writer.db.exec('ROLLBACK');
      assert.equal(reader.countCommitments(), 1);
      writer.mutate(() => writer.insertCommitment({ id: 'cm_committed', matterId: 'm1', debtor: 'user', creditor: 'u', action: 'committed', timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none' }));
      assert.equal(reader.countCommitments(), 2, 'the reader sees the row once it commits');
    } finally { writer.close(); reader.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

function writeKilledWriter(root) {
  const file = join(root, 'killed-writer.mjs');
  writeFileSync(file, [
    `import { SqliteStore } from ${JSON.stringify(pathToFileURL(sqliteLib).href)}`,
    'const store = new SqliteStore(process.env.ADVISERS_TEST_DB);',
    "store.db.exec('PRAGMA wal_autocheckpoint = 0')",
    "store.addTurn({ conversationId: 'c1', role: 'user', content: 'kill -9 survives this row' })",
    "store.setMeta('writer', 'killed')",
    "process.stdout.write('written\\n')",
    'setInterval(() => {}, 60000)',
  ].join('\n'));
  return file;
}

function startKilledWriter(script, db) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, ADVISERS_TEST_DB: db }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk });
  child.stderr.on('data', (chunk) => { stderr += chunk });
  return {
    child,
    ready: async () => { for (let i = 0; i < 200; i++) { if (stdout.includes('written')) return true; await sleep(25) } return false },
    stderr: () => stderr,
    wait: () => new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
  };
}

test('a read-only open recovers a WAL left by a SIGKILLed writer', async () => {
  const { root, db } = setup('advisers-readonly-kill-');
  try {
    seed(db);
    const script = writeKilledWriter(root);
    const writer = startKilledWriter(script, db);
    assert.equal(await writer.ready(), true, `writer did not start: ${writer.stderr()}`);
    assert.ok(existsSync(`${db}-wal`), 'fixture: the committed rows live in the WAL');
    writer.child.kill('SIGKILL');
    await writer.wait();
    assert.ok(existsSync(`${db}-wal`), 'SIGKILL leaves the WAL behind');
    const reader = openReadStore(db, { checkIntegrity: true });
    try {
      assert.equal(reader.schemaVersion(), 20);
      assert.equal(reader.listTurns('c1').length, 1);
      assert.equal(reader.listTurns('c1')[0].content, 'kill -9 survives this row');
      assert.equal(reader.getMeta('writer'), 'killed');
      assert.equal(reader.assertIntegrity(), 'ok');
    } finally { reader.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('a read-only directory (read-only volume) needs existing WAL sidecars and degrades clearly otherwise', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores permissions
  const { root, db } = setup('advisers-readonly-dir-');
  try {
    seed(db);
    // Degradation 1: a cleanly closed database has no -wal/-shm; on a directory
    // that cannot be written the read-only connection cannot create the shm
    // index and SQLite reports 'attempt to write a readonly database'. The bin
    // layer maps this to its documented fallback (ADVISERS_READ_LOCKFREE=0).
    chmodSync(root, 0o555);
    try {
      assert.throws(() => new SqliteStore(db, { readOnly: true }), /readonly database|unable to open database/i);
    } finally { chmodSync(root, 0o755) }
    // Degradation 2: with a live writer the WAL/-shm sidecars already exist, so
    // the same read-only directory serves reads (verified by design §11.1).
    const writer = new SqliteStore(db);
    try {
      writer.mutate(() => writer.insertCommitment({ id: 'cm2', matterId: 'm1', debtor: 'user', creditor: 'u', action: 'second', timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none' }));
      assert.ok(existsSync(`${db}-wal`) || existsSync(`${db}-shm`), 'fixture: the sidecars exist');
      chmodSync(root, 0o555);
      try {
        const reader = openReadStore(db);
        try {
          assert.equal(reader.countMatters(), 1);
          assert.equal(reader.read(() => reader.countCommitments()), 2);
        } finally { reader.close() }
      } finally { chmodSync(root, 0o755) }
    } finally {
      try { writer.close() } finally { try { chmodSync(root, 0o755) } catch {} }
    }
    // Degradation 3: an unreadable database file gives a clear error (the bin
    // layer turns this into its documented fallback/refusal).
    chmodSync(db, 0o000);
    try {
      assert.throws(() => new SqliteStore(db, { readOnly: true }), /unable to open database|readonly|permission/i);
    } finally { chmodSync(db, 0o600) }
  } finally {
    try { chmodSync(root, 0o755) } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

function writeLockHolder(root) {
  const file = join(root, 'lock-holder.mjs');
  writeFileSync(file, [
    `import { acquireInstanceLock } from ${JSON.stringify(pathToFileURL(sqliteLib).href)}`,
    "const lock = acquireInstanceLock({ home: process.env.ADVISERS_TEST_HOME, command: 'test-holder', timeoutMs: 5000 })",
    "process.stdout.write('held\\n')",
    'setTimeout(() => { lock.release(); process.exit(0) }, 1500)',
  ].join('\n'));
  return file;
}

test('the read path works while another process holds the HOME write lock', async () => {
  const { root, db } = setup('advisers-readonly-lock-');
  try {
    seed(db);
    const script = writeLockHolder(root);
    const child = spawn(process.execPath, [script], { env: { ...process.env, ADVISERS_TEST_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk });
    child.stderr.on('data', (chunk) => { stderr += chunk });
    try {
      for (let i = 0; i < 200 && !stdout.includes('held'); i++) await sleep(25);
      assert.ok(stdout.includes('held'), `lock holder did not start: ${stderr}`);
      assert.ok(existsSync(join(root, 'instance.lock')), 'fixture: the writer lock exists');
      const reader = openReadStore(db);
      try { assert.equal(reader.countCommitments(), 1) } finally { reader.close() }
      assert.ok(existsSync(join(root, 'instance.lock')), 'the reader must not remove the writer lock');
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    // No instance.lock is created by a read-only open on its own.
    rmSync(join(root, 'instance.lock'), { force: true });
    const reader = openReadStore(db);
    try { assert.equal(reader.countMatters(), 1) } finally { reader.close() }
    assert.equal(existsSync(join(root, 'instance.lock')), false, 'the library read path takes no HOME lock');
  } finally { rmSync(root, { recursive: true, force: true }) }
});
