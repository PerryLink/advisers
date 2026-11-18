import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  applyRemember,
  completeCommitment,
  confirmPreference,
  createCommitment,
  createPreference,
  Ledger,
  LEDGER_SNAPSHOT_TABLES,
  updateCommitmentFields,
} from '../../core/dist/index.js'
import { applyPreferenceDecay } from '../lib/learning.js'
import { SqliteStore } from '../lib/sqlite.js'

// 0.2.3 persistence v2 (03-design-persistence-v2.md §3): the directed write
// path. Every insert*/update* runs inside one mutate() transaction that also
// appends the audit row, and must produce exactly the rows the historical
// full-snapshot path (load + core Ledger + saveWithAudit) produced. The
// parity tests below run BOTH paths on a copy of the same seed database and
// compare every persisted ledger row, the audit sequence and the nudge/meta
// tables, so the two implementations cannot drift while Wave 2b moves the bin
// commands over.

const NOW = '2026-11-18T00:00:00.000Z'
const EVIDENCE = [{ sessionId: 'c1', turnId: 't1', quote: '周五前发' }]
const sqliteLib = fileURLToPath(new URL('../lib/sqlite.js', import.meta.url))

/** Deterministic host ports: fixed clock + prefixed sequence ids. */
function ports(now = NOW) {
  let seq = 0
  return { clock: { now: () => now }, ids: { next: (prefix) => `${prefix}_${++seq}` } }
}

/** Seed one ledger: matter, fact, preferences, commitment + a memory candidate. */
function seedDatabase(root) {
  const db = join(root, 'seed.db')
  const store = new SqliteStore(db)
  const ledger = new Ledger(ports())
  const matter = ledger.addMatter({ title: '客户A', summary: '报价' })
  const fact = ledger.remember({ matterId: matter.id, subject: 'client', predicate: 'budget', object: '300万' })
  const pref = ledger.addPreference({ kind: 'preference', statement: '邮件先结论', confidence: 0.9 })
  const candidatePref = ledger.addPreference({ kind: 'preference', statement: '周报先给结论', confidence: 0.4, status: 'candidate' })
  // Backdate so decay actually changes this preference (109 days -> 3 periods).
  candidatePref.validFrom = '2026-08-01T00:00:00.000Z'
  const commitment = ledger.addCommitment({
    matterId: matter.id, debtor: 'agent', creditor: 'user', action: '发报价',
    dueAt: '2026-11-20T18:00:00+08:00', evidence: EVIDENCE, reminderOffsets: ['-1d'],
  })
  store.save(ledger.toJSON())
  const candidate = store.proposeCandidate({ kind: 'fact', payload: { subject: 'client', predicate: 'budget', object: '350万', matterId: matter.id }, evidence: [{ quote: '预算改为350万' }] })
  store.setMeta('seed:key', 'seed')
  store.appendAudit({ actor: 'local', action: 'seed', allowed: true, reason: 'seed' })
  store.close()
  return {
    db, matterId: matter.id, factId: fact.id, prefId: pref.id,
    candidatePrefId: candidatePref.id, commitmentId: commitment.id, candidateId: candidate.id,
  }
}

function prepare(root) {
  const seed = seedDatabase(root)
  const oldDb = join(root, 'old.db')
  const newDb = join(root, 'new.db')
  copyFileSync(seed.db, oldDb)
  copyFileSync(seed.db, newDb)
  return { ...seed, oldDb, newDb }
}

function withStore(dbPath, fn) {
  const store = new SqliteStore(dbPath)
  try { return fn(store) } finally { store.close() }
}

function mutateCopy(dbPath, fn) {
  withStore(dbPath, (store) => store.mutate(() => fn(store)));
}

/** Sort/dump the nine ledger tables exactly as a store reads them back. */
function dumpSnapshot(dbPath) {
  return withStore(dbPath, (store) => {
    const snapshot = store.load()
    for (const table of LEDGER_SNAPSHOT_TABLES) {
      if (table === 'routes') continue
      snapshot[table].sort((a, b) => String(a.id).localeCompare(String(b.id)))
    }
    snapshot.routes = Object.fromEntries(Object.entries(snapshot.routes).sort(([a], [b]) => a.localeCompare(b)))
    return structuredClone(snapshot)
  });
}

function auditSignature(dbPath) {
  return withStore(dbPath, (store) => store.listAudit(1000).reverse().map(({ action, allowed, reason }) => ({ action, allowed, reason })));
}

function metaDump(dbPath) {
  return withStore(dbPath, (store) => [...store.listMetaByPrefix('').entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value })));
}

function nudgeDump(dbPath) {
  return withStore(dbPath, (store) => store.listNudges(1000).map((row) => ({
    localDay: row.local_day, level: row.level, commitmentId: row.commitment_id,
    dedupeKey: row.dedupe_key, body: row.body, outcome: row.outcome,
  })).sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey)));
}

function candidateView(dbPath, id) {
  return withStore(dbPath, (store) => {
    const row = store.getCandidate(id)
    return row ? { status: row.status, rejectReason: row.rejectReason ?? null } : null
  });
}

function totalChanges(store) {
  return Number(store.db.prepare('SELECT total_changes() AS n').get().n)
}

function walSize(dbPath) {
  return existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0
}

function assertAuditVerified(dbPath) {
  withStore(dbPath, (store) => assert.equal(store.verifyAudit().ok, true, 'audit chain must verify after the write'));
}

const AUDIT = (action, reason) => ({ actor: 'local', action, allowed: true, reason });

/**
 * Run the historical path (full load -> in-memory core op -> full save) on
 * `oldDb` and the directed path on `newDb`, then compare every persisted row.
 * `oldFn` mutates the loaded ledger and may return { inside } to run inside
 * the old save transaction; pass oldNoSave when it performs its own writes
 * (tick/decay keep their historical multi-step persistence).
 */
function assertParity({ dbs, expectedChanges, audit, oldFn, newFn, oldNoSave = false, compare }) {
  const { oldDb, newDb } = dbs;
  const oldStore = new SqliteStore(oldDb);
  try {
    const ledger = Ledger.fromJSON(oldStore.load(), ports());
    const result = oldFn({ store: oldStore, ledger, ports: ports() });
    if (!oldNoSave) {
      const snapshot = ledger.toJSON();
      if (audit === null || audit === undefined) oldStore.save(snapshot);
      else oldStore.saveWithAudit(snapshot, audit, result?.inside);
    }
  } finally {
    oldStore.close();
  }
  const newStore = new SqliteStore(newDb);
  const beforeChanges = totalChanges(newStore);
  const beforeWal = walSize(newDb);
  let outcome;
  let changeCount;
  try {
    outcome = newStore.mutate(() => newFn({ store: newStore, ports: ports() }), audit);
    changeCount = totalChanges(newStore) - beforeChanges;
  } finally {
    newStore.close();
  }
  assert.deepEqual(dumpSnapshot(newDb), dumpSnapshot(oldDb), 'every ledger row must match the full-save path');
  assert.deepEqual(auditSignature(newDb), auditSignature(oldDb), 'audit action/allowed/reason sequence must match');
  assert.equal(changeCount, expectedChanges, 'directed write must change exactly the expected number of rows');
  assert.ok(walSize(newDb) - beforeWal < 1024 * 1024, 'a single directed write must stay under 1MB of WAL growth');
  assertAuditVerified(newDb);
  if (compare) compare({ oldDb, newDb, outcome });
  return outcome;
}

test('mutate() runs the write and its audit row in one transaction and returns both', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-inc-tx-'));
  try {
    const store = new SqliteStore(join(root, 'state.db'));
    const row = { id: 'cm_1', matterId: 'm1', debtor: 'user', creditor: 'u', action: 'a', timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none' };
    const outcome = store.mutate(() => { store.insertCommitment(row); return 'result' }, AUDIT('commit.add', 'cm_1'));
    assert.equal(outcome.result, 'result');
    assert.equal(outcome.audit.action, 'commit.add');
    assert.equal(outcome.audit.reason, 'cm_1');
    assert.equal(store.getCommitment('cm_1').action, 'a');
    assert.deepEqual(store.verifyAudit(), { ok: true, count: 1 });
    assert.equal(store.mutate(() => 'no audit').audit, null, 'audit is optional and defaults to null');
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('directed inserts/updates require an explicit write transaction', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-inc-txreq-'));
  try {
    const store = new SqliteStore(join(root, 'state.db'));
    const row = { id: 'm1', title: 't', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW };
    assert.throws(() => store.insertMatter(row), (error) => error.code === 'E_TX_REQUIRED');
    assert.throws(() => store.updateMatter('m1', { title: 'x' }), (error) => error.code === 'E_TX_REQUIRED');
    store.mutate(() => store.insertMatter(row));
    assert.equal(store.getMatter('m1').title, 't');
    assert.throws(() => store.mutate(() => store.updateMatter('m1', { nope: 1 })), /unknown matters field: nope/);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('directed writes round-trip every entity field exactly like save()', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-inc-fields-'));
  try {
    const store = new SqliteStore(join(root, 'state.db'));
    const matter = { id: 'matter_1', title: '客户', status: 'active', domain: 'consulting', secrecy: 1, summary: '摘要', participants: ['a', 'b'], deadlines: ['2026-12-01'], openQuestions: ['q'], createdAt: NOW, updatedAt: NOW };
    const fact = { id: 'fact_1', matterId: 'matter_1', subject: 'user', predicate: 'city', object: '上海', recordedAt: NOW, expiredAt: NOW, authority: 'tool', confidence: 0.42, source: { quote: 'q', ref: 'r' }, evidence: [{ quote: 'e' }], status: 'candidate', validFrom: NOW, validTo: NOW, supersedes: 'fact_0', supersededBy: 'fact_2', shadowedBy: 'fact_3', lastSeenAt: NOW, deletedAt: NOW, deletedReason: 'why' };
    const commitment = { id: 'cm_1', matterId: 'matter_1', debtor: 'third:client', creditor: 'user', action: '发报价', dueAt: NOW, timezone: 'Asia/Shanghai', status: 'snoozed', evidence: EVIDENCE, capability: 'calendar', doneAt: NOW, reminderOffsets: [] };
    const preference = { id: 'pref_1', kind: 'goal', statement: '先结论', scope: { level: 'project', value: 'p' }, source: { type: 'imported', quote: 'q' }, evidence: [{ quote: 'e' }], confidence: 0.7, status: 'candidate', validFrom: NOW, lastConfirmed: NOW, expiresAt: NOW, priority: 'hard' };
    store.mutate(() => {
      store.insertMatter(matter);
      store.insertFact(fact);
      store.insertCommitment(commitment);
      store.insertPreference(preference);
    });
    assert.deepEqual(store.getMatter('matter_1'), matter);
    assert.deepEqual(store.getFact('fact_1'), fact);
    assert.deepEqual(store.getCommitment('cm_1'), commitment);
    assert.deepEqual(store.getPreference('pref_1'), preference);
    // update* writes only the patched columns and maps the row back identically.
    store.mutate(() => {
      store.updateCommitment('cm_1', { status: 'done', doneAt: NOW, reminderOffsets: null });
      store.updateFact('fact_1', { status: 'deleted', deletedAt: NOW, deletedReason: 'r' });
      store.updatePreference('pref_1', { status: 'confirmed', confidence: 0.8 });
      store.updateMatter('matter_1', { status: 'archived', updatedAt: NOW });
    });
    assert.equal(store.getCommitment('cm_1').status, 'done');
    assert.ok(!('reminderOffsets' in store.getCommitment('cm_1')), 'null clears reminder_offsets');
    assert.equal(store.getFact('fact_1').status, 'deleted');
    assert.equal(store.getPreference('pref_1').confidence, 0.8);
    assert.equal(store.getMatter('matter_1').status, 'archived');
    assert.equal(store.getCommitment('missing'), undefined);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('findFactCurrent/findPreferenceByStatement/firstActiveMatter use the indexed lookups', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-inc-find-'));
  try {
    const store = new SqliteStore(join(root, 'state.db'));
    store.mutate(() => {
      store.insertMatter({ id: 'm1', title: 'a', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW });
      store.insertMatter({ id: 'm2', title: 'b', status: 'archived', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW });
      store.insertFact({ id: 'f1', subject: 'u', predicate: 'city', object: '上海', matterId: null, recordedAt: NOW, authority: 'user', confidence: 0.9, status: 'confirmed', validFrom: NOW });
      store.insertFact({ id: 'f2', subject: 'u', predicate: 'city', object: '北京', matterId: 'm1', recordedAt: NOW, authority: 'user', confidence: 0.9, status: 'confirmed', validFrom: NOW });
      store.insertFact({ id: 'f3', subject: 'u', predicate: 'city', object: '深圳', matterId: 'm1', recordedAt: NOW, authority: 'user', confidence: 0.9, status: 'superseded', expiredAt: NOW, validFrom: NOW });
      store.insertPreference({ id: 'p1', kind: 'preference', statement: '邮件先结论', scope: { level: 'global' }, source: { type: 'user_explicit' }, evidence: [], confidence: 0.9, status: 'deprecated', validFrom: NOW, priority: 'soft' });
      store.insertPreference({ id: 'p2', kind: 'preference', statement: '邮件先结论', scope: { level: 'global' }, source: { type: 'user_explicit' }, evidence: [], confidence: 0.9, status: 'confirmed', validFrom: NOW, priority: 'soft' });
    });
    assert.equal(store.findFactCurrent({ subject: 'u', predicate: 'city', matterId: null }).object, '上海');
    assert.equal(store.findFactCurrent({ subject: 'u', predicate: 'city', matterId: 'm1' }).object, '北京');
    assert.equal(store.findFactCurrent({ subject: 'u', predicate: 'city', matterId: 'm2' }), undefined);
    assert.equal(store.findFactCurrent({ subject: 'u', predicate: 'said' }), undefined);
    assert.equal(store.findPreferenceByStatement('邮件先结论').id, 'p2', 'deprecated preferences are skipped');
    assert.equal(store.findPreferenceByStatement('missing'), undefined);
    assert.equal(store.firstActiveMatter().id, 'm1');
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('applyTick writes nudges + wake-ups + snooze cleanup atomically', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-inc-tick-'));
  try {
    const store = new SqliteStore(join(root, 'state.db'));
    const seed = { id: 'cm_1', matterId: 'm1', debtor: 'user', creditor: 'u', action: 'a', timezone: 'Asia/Shanghai', status: 'snoozed', evidence: [], capability: 'none' };
    store.mutate(() => store.insertCommitment(seed));
    store.setMeta('snooze:cm_1', '2026-11-17T00:00:00.000Z');
    const row = { localDay: '2026-11-18', level: 'L2', commitmentId: 'cm_1', body: '发报价' };
    assert.deepEqual(store.applyTick({ nudgeRows: [row], wakeIds: ['cm_1'], snoozeKeys: ['snooze:cm_1'] }), { nudges: 1, woke: 1, metaDeleted: 1 });
    assert.equal(store.getCommitment('cm_1').status, 'open');
    assert.equal(store.getMeta('snooze:cm_1'), undefined);
    // Second tick: the nudge dedupe key and the already-open commitment are no-ops.
    assert.deepEqual(store.applyTick({ nudgeRows: [row], wakeIds: ['cm_1'], snoozeKeys: ['snooze:cm_1'] }), { nudges: 0, woke: 0, metaDeleted: 0 });
    assert.equal(store.listNudges(10).length, 1);
    // A failure in any part of the batch rolls the whole tick back. Put the
    // commitment back to snoozed and make the final meta cleanup fail after the
    // nudge insert and the wake-up UPDATE already ran.
    store.mutate(() => {
      store.updateCommitment('cm_1', { status: 'snoozed' });
      store.setMeta('snooze:cm_1', '2026-11-17T00:00:00.000Z');
    });
    assert.throws(() => store.applyTick({
      nudgeRows: [{ localDay: '2026-11-18', level: 'L3', commitmentId: 'cm_1', body: 'second' }],
      wakeIds: ['cm_1'],
      snoozeKeys: [{ not: 'a string' }],
    }));
    assert.equal(store.getCommitment('cm_1').status, 'snoozed', 'the wake-up must roll back with the rest');
    assert.ok(store.getMeta('snooze:cm_1'));
    assert.equal(store.listNudges(10).length, 1, 'the inserted nudge must roll back too');
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }) }
});

// ---------------------------------------------------------------------------
// Per-command parity: historical full load+save vs directed write.
// ---------------------------------------------------------------------------

test('parity: commit add', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-parity-add-'));
  try {
    const dbs = prepare(root);
    const outcome = assertParity({
      dbs,
      expectedChanges: 2,
      audit: AUDIT('commit.add', 'cm_1'),
      oldFn: ({ ledger }) => {
        ledger.addCommitment({ matterId: 'matter_1', debtor: 'agent', creditor: 'user', action: '发合同', dueAt: '2026-11-21T10:00:00+08:00', evidence: EVIDENCE });
      },
      newFn: ({ store }) => {
        const row = createCommitment(ports(), { matterId: 'matter_1', debtor: 'agent', creditor: 'user', action: '发合同', dueAt: '2026-11-21T10:00:00+08:00', evidence: EVIDENCE });
        store.insertCommitment(row);
      },
    });
    assert.equal(outcome.audit.action, 'commit.add');
    assert.equal(outcome.audit.reason, 'cm_1');
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('parity: commit edit (action/due/reminderOffsets)', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-parity-edit-'));
  try {
    const dbs = prepare(root);
    const patch = { action: '发合同', dueAt: '2026-11-25T10:00:00+08:00', reminderOffsets: ['-2h'] };
    assertParity({
      dbs,
      expectedChanges: 2,
      audit: AUDIT('commit.update', dbs.commitmentId),
      oldFn: ({ ledger }) => { ledger.updateCommitment(dbs.commitmentId, patch) },
      newFn: ({ store }) => {
        const current = store.getCommitment(dbs.commitmentId);
        updateCommitmentFields(current, patch); // pure function: result is what the row must become
        store.updateCommitment(dbs.commitmentId, patch);
      },
    });
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('parity: commit done', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-parity-done-'));
  try {
    const dbs = prepare(root);
    const doneEvidence = [{ sessionId: 'c1', turnId: 't9', quote: '已发送' }];
    assertParity({
      dbs,
      expectedChanges: 2,
      audit: AUDIT('commit.done', dbs.commitmentId),
      oldFn: ({ ledger }) => { ledger.completeCommitment(dbs.commitmentId, doneEvidence) },
      newFn: ({ store }) => {
        const current = store.getCommitment(dbs.commitmentId);
        const next = completeCommitment(current, doneEvidence, NOW);
        store.updateCommitment(dbs.commitmentId, { status: next.status, doneAt: next.doneAt, evidence: next.evidence });
      },
    });
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('parity: commit snooze (row + snooze meta in one transaction)', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-parity-snooze-'));
  try {
    const dbs = prepare(root);
    const until = '2026-11-19T00:00:00.000Z';
    assertParity({
      dbs,
      expectedChanges: 3,
      audit: AUDIT('commit.snooze', dbs.commitmentId),
      oldFn: ({ ledger }) => {
        ledger.listCommitments().find((c) => c.id === dbs.commitmentId).status = 'snoozed';
        return { inside: (store) => store.setMeta(`snooze:${dbs.commitmentId}`, until) };
      },
      newFn: ({ store }) => {
        store.updateCommitment(dbs.commitmentId, { status: 'snoozed' });
        store.setMeta(`snooze:${dbs.commitmentId}`, until);
      },
      compare: ({ oldDb, newDb }) => assert.deepEqual(metaDump(newDb), metaDump(oldDb)),
    });
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('parity: correct (new preference)', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-parity-correct-new-'));
  try {
    const dbs = prepare(root);
    const input = { kind: 'preference', statement: '以后邮件先给总价', source: { type: 'user_explicit', quote: '以后邮件先给总价' }, confidence: 0.8, status: 'confirmed' };
    assertParity({
      dbs,
      expectedChanges: 2,
      audit: AUDIT('correct', 'pref_1'),
      oldFn: ({ ledger }) => { ledger.addPreference(input) },
      newFn: ({ store }) => {
        assert.equal(store.findPreferenceByStatement(input.statement), undefined);
        store.insertPreference(createPreference(ports(), input));
      },
    });
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('parity: correct (existing preference confirmation)', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-parity-correct-hit-'));
  try {
    const dbs = prepare(root);
    assertParity({
      dbs,
      expectedChanges: 2,
      audit: AUDIT('correct', dbs.prefId),
      oldFn: ({ ledger }) => {
        const existing = ledger.listPreferences({ includeCandidates: true }).find((p) => p.statement === '邮件先结论');
        Object.assign(existing, confirmPreference(existing, NOW).preference);
      },
      newFn: ({ store }) => {
        const current = store.findPreferenceByStatement('邮件先结论');
        const { preference, promoted } = confirmPreference(current, NOW);
        assert.equal(promoted, true);
        store.updatePreference(current.id, { confidence: preference.confidence, lastConfirmed: preference.lastConfirmed, status: preference.status });
      },
    });
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('parity: decay (batch update, no audit)', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-parity-decay-'));
  try {
    const dbs = prepare(root);
    assertParity({
      dbs,
      expectedChanges: 1,
      audit: null,
      oldNoSave: true,
      oldFn: ({ store, ledger }) => {
        const changed = applyPreferenceDecay(ledger.listPreferences({ includeCandidates: true }), new Date(NOW));
        assert.equal(changed.length, 1, 'the backdated candidate preference decays');
        store.save(ledger.toJSON());
      },
      newFn: ({ store }) => {
        const changed = applyPreferenceDecay(store.loadPreferences(), new Date(NOW));
        assert.equal(changed.length, 1);
        for (const pref of changed) store.updatePreference(pref.id, { confidence: pref.confidence, status: pref.status });
      },
    });
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('parity: forget (soft-delete tombstone, no audit)', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-parity-forget-'));
  try {
    const dbs = prepare(root);
    assertParity({
      dbs,
      expectedChanges: 1,
      audit: null,
      oldNoSave: true,
      oldFn: ({ store, ledger }) => {
        assert.equal(ledger.forget('fact', dbs.factId), true);
        store.save(ledger.toJSON());
      },
      newFn: ({ store }) => {
        store.updateFact(dbs.factId, { status: 'deleted', deletedAt: NOW });
      },
    });
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('parity: tick snooze wake-up (nudge + row + meta in one transaction)', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-parity-tick-'));
  try {
    const dbs = prepare(root);
    const snoozeKey = `snooze:${dbs.commitmentId}`;
    for (const dbPath of [dbs.oldDb, dbs.newDb]) {
      mutateCopy(dbPath, (store) => {
        store.updateCommitment(dbs.commitmentId, { status: 'snoozed' });
        store.setMeta(snoozeKey, '2026-11-17T00:00:00.000Z');
      });
    }
    const nudgeRow = { localDay: '2026-11-18', level: 'L2', commitmentId: dbs.commitmentId, body: '发报价' };
    assertParity({
      dbs,
      expectedChanges: 3,
      audit: null,
      oldNoSave: true,
      oldFn: ({ store, ledger }) => {
        ledger.listCommitments().find((c) => c.id === dbs.commitmentId).status = 'open';
        store.addNudges([nudgeRow]);
        store.deleteMetaKeys([snoozeKey]);
        store.save(ledger.toJSON());
      },
      newFn: ({ store }) => {
        store.applyTick({ nudgeRows: [nudgeRow], wakeIds: [dbs.commitmentId], snoozeKeys: [snoozeKey] });
      },
      compare: ({ oldDb, newDb }) => {
        assert.deepEqual(nudgeDump(newDb), nudgeDump(oldDb));
        assert.deepEqual(metaDump(newDb), metaDump(oldDb));
      },
    });
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('parity: memory accept (fact supersede + candidate review + audit)', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-parity-accept-'));
  try {
    const dbs = prepare(root);
    const accept = ({ store, ledger, ids }) => {
      const candidate = store.getCandidate(dbs.candidateId);
      const input = { ...candidate.payload, evidence: candidate.evidence };
      if (ledger) {
        ledger.remember(input);
        return { inside: (s) => s.reviewCandidate(dbs.candidateId, 'accepted') };
      }
      const current = store.findFactCurrent({ subject: candidate.payload.subject, predicate: candidate.payload.predicate, matterId: candidate.payload.matterId });
      const outcome = applyRemember(current, input, ids);
      if (outcome.op === 'update') {
        const patch = {};
        for (const key of Object.keys(outcome.row)) {
          if (JSON.stringify(outcome.row[key]) !== JSON.stringify(current?.[key])) patch[key] = outcome.row[key];
        }
        store.updateFact(outcome.row.id, patch);
      } else if (outcome.op === 'insert') {
        store.insertFact(outcome.row);
      } else {
        store.updateFact(outcome.old.id, { status: outcome.old.status, validTo: outcome.old.validTo, expiredAt: outcome.old.expiredAt, supersededBy: outcome.old.supersededBy });
        store.insertFact(outcome.row);
      }
      store.reviewCandidate(dbs.candidateId, 'accepted');
      return null;
    };
    assertParity({
      dbs,
      expectedChanges: 4,
      audit: AUDIT('memory.accept', dbs.candidateId),
      oldFn: ({ store, ledger }) => accept({ store, ledger, ids: ports() }),
      newFn: ({ store, ports: p }) => accept({ store, ids: p }),
      compare: ({ oldDb, newDb }) => {
        assert.deepEqual(candidateView(newDb, dbs.candidateId), candidateView(oldDb, dbs.candidateId));
        assert.equal(candidateView(newDb, dbs.candidateId).status, 'accepted');
      },
    });
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('directed write avoids the full load/save path entirely', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-inc-noload-'));
  try {
    const dbs = prepare(root);
    const calls = { load: 0, save: 0, saveWithAudit: 0, _saveRows: 0 };
    const original = {};
    for (const name of Object.keys(calls)) original[name] = SqliteStore.prototype[name];
    const forbidden = (name) => { calls[name] += 1; throw new Error(`${name} must not be used by the directed write path`) };
    for (const name of Object.keys(calls)) SqliteStore.prototype[name] = function () { return forbidden(name) };
    try {
      const store = new SqliteStore(dbs.newDb);
      store.mutate(() => {
        store.insertCommitment(createCommitment(ports(), { matterId: 'matter_1', debtor: 'agent', creditor: 'user', action: '新承诺', evidence: EVIDENCE }));
      }, AUDIT('commit.add', 'cm_1'));
      store.close();
    } finally {
      for (const name of Object.keys(calls)) SqliteStore.prototype[name] = original[name];
    }
    assert.deepEqual(calls, { load: 0, save: 0, saveWithAudit: 0, _saveRows: 0 });
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('a directed write changes only its own rows (write-amplification bound)', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-inc-amplification-'));
  try {
    const dbs = prepare(root);
    // Grow the ledger so the write amplification is visible: both copies get the
    // same 20 extra commitments (the old full save then rewrites every row).
    for (const dbPath of [dbs.oldDb, dbs.newDb]) {
      mutateCopy(dbPath, (store) => {
        for (let i = 0; i < 20; i++) {
          store.insertCommitment({ id: `cm_bulk_${i}`, matterId: 'matter_1', debtor: 'user', creditor: 'u', action: `bulk ${i}`, timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none' });
        }
      });
    }
    // Full-save path: re-writing the unchanged snapshot still touches every row
    // plus its audit row; the directed path writes one row plus its audit row.
    const fullSaveChanges = withStore(dbs.oldDb, (store) => {
      const before = totalChanges(store);
      store.saveWithAudit(store.load(), AUDIT('commit.add', 'cm_1'));
      return totalChanges(store) - before;
    });
    const directedChanges = withStore(dbs.newDb, (store) => {
      const before = totalChanges(store);
      store.mutate(() => {
        store.insertCommitment(createCommitment(ports(), { matterId: 'matter_1', debtor: 'agent', creditor: 'user', action: '新承诺', evidence: EVIDENCE }));
      }, AUDIT('commit.add', 'cm_1'));
      return totalChanges(store) - before;
    });
    assert.equal(directedChanges, 2, 'one commitment row + one audit row');
    assert.ok(fullSaveChanges > 20, `full save changed ${fullSaveChanges} rows`);
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('purge can run its ledger updates and data deletion in one transaction', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-inc-purge-'));
  try {
    const dbs = prepare(root);
    // Give the matter some non-ledger rows to purge (session/turn/candidate).
    mutateCopy(dbs.newDb, (store) => {
      store.upsertSession({ conversationId: 'c1', matterId: dbs.matterId, title: '客户会话' });
      store.addTurn({ conversationId: 'c1', role: 'user', content: '敏感原文' });
    });
    const store = new SqliteStore(dbs.newDb);
    const outcome = store.mutate(() => {
      // The ledger half is byte-for-byte what core Ledger.purgeMatter does; the
      // SQL half is purgeMatterData, which must not try to VACUUM inside the tx.
      store.updateFact(dbs.factId, { status: 'deleted', object: '[purged]', source: null, evidence: null, deletedAt: NOW, deletedReason: 'matter_purged' });
      return store.purgeMatterData(dbs.matterId);
    }, AUDIT('matter.purge', dbs.matterId));
    try {
      assert.equal(outcome.result.sessions, 1);
      assert.equal(outcome.result.turns, 1);
      assert.equal(store.countTurns({ conversationId: 'c1' }), 0);
      assert.equal(store.getSession('c1'), undefined);
      assert.equal(store.getFact(dbs.factId).status, 'deleted');
      assert.equal(store.getFact(dbs.factId).object, '[purged]');
      assert.equal(store.verifyAudit().ok, true);
      assert.equal(outcome.audit.action, 'matter.purge');
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});
// ---------------------------------------------------------------------------
// Failure/rollback semantics (§2.3 I1: data + audit live and die together).
// ---------------------------------------------------------------------------

test('rollback: a business error leaves no row and no audit row behind', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-inc-rb-biz-'));
  try {
    const dbs = prepare(root);
    const beforeData = dumpSnapshot(dbs.newDb);
    const beforeAudit = auditSignature(dbs.newDb);
    const store = new SqliteStore(dbs.newDb);
    assert.throws(() => store.mutate(() => {
      store.insertMatter({ id: 'matter_x', title: 'x', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW });
      throw new Error('business failure');
    }, AUDIT('matter.add', 'matter_x')), /business failure/);
    store.close();
    assert.deepEqual(dumpSnapshot(dbs.newDb), beforeData);
    assert.deepEqual(auditSignature(dbs.newDb), beforeAudit);
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('rollback: when the audit row fails the data row is rolled back too', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-inc-rb-audit-'));
  try {
    const dbs = prepare(root);
    const beforeData = dumpSnapshot(dbs.newDb);
    const beforeAudit = auditSignature(dbs.newDb);
    const store = new SqliteStore(dbs.newDb);
    assert.throws(() => store.mutate(() => {
      store.insertMatter({ id: 'matter_x', title: 'x', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW });
    }, { actor: null, action: 'matter.add', allowed: true }), /audit\.actor|NOT NULL/);
    assert.equal(store.getMatter('matter_x'), undefined, 'the data row must not survive a failed audit');
    store.close();
    assert.deepEqual(dumpSnapshot(dbs.newDb), beforeData);
    assert.deepEqual(auditSignature(dbs.newDb), beforeAudit);
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('rollback: saveWithAudit restores the old rows when the audit insert fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-inc-rb-save-'));
  try {
    const dbs = prepare(root);
    const beforeData = dumpSnapshot(dbs.newDb);
    const beforeAudit = auditSignature(dbs.newDb);
    const store = new SqliteStore(dbs.newDb);
    const snapshot = store.load();
    snapshot.commitments[0].action = 'changed by a failed save';
    assert.throws(() => store.saveWithAudit(snapshot, { actor: null, action: 'save', allowed: true }), /audit\.actor|NOT NULL/);
    store.close();
    assert.deepEqual(dumpSnapshot(dbs.newDb), beforeData);
    assert.deepEqual(auditSignature(dbs.newDb), beforeAudit);
  } finally { rmSync(root, { recursive: true, force: true }) }
});

// ---------------------------------------------------------------------------
// Multi-process writes: SQLite BEGIN IMMEDIATE + busy_timeout must serialise
// two writers without losing either update (0.2.3 keeps the HOME write lock in
// bin, this proves the library transactions are individually safe too).
// ---------------------------------------------------------------------------

function writeWriterScript(root) {
  const file = join(root, 'writer.mjs');
  writeFileSync(file, [
    `import { SqliteStore } from ${JSON.stringify(pathToFileURL(sqliteLib).href)}`,
    "const store = new SqliteStore(process.env.ADVISERS_TEST_DB, { busyTimeoutMs: 5000 })",
    "const tag = process.env.ADVISERS_TEST_TAG",
    "const count = Number(process.env.ADVISERS_TEST_COUNT || '15')",
    'for (let i = 0; i < count; i++) {',
    '  const id = `cm_${tag}_${i}`',
    '  store.mutate(() => store.insertCommitment({ id, matterId: \'m1\', debtor: \'user\', creditor: \'u\', action: `action ${i}`, timezone: \'Asia/Shanghai\', status: \'open\', evidence: [], capability: \'none\' }), { actor: \'local\', action: \'commit.add\', allowed: true, reason: id })',
    '}',
    'store.close()',
    "process.stdout.write('done\\n')",
  ].join('\n'));
  return file;
}

function runWriter(script, dbPath, tag, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ADVISERS_TEST_DB: dbPath, ADVISERS_TEST_TAG: tag, ADVISERS_TEST_COUNT: String(count) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk });
    child.stderr.on('data', (chunk) => { stderr += chunk });
    child.on('close', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`writer exited ${code}: ${stderr || stdout}`))));
  });
}

test('two concurrent writers lose no rows and keep the audit chain intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'advisers-inc-concurrent-'));
  try {
    const db = join(root, 'state.db');
    const store = new SqliteStore(db);
    store.mutate(() => store.insertMatter({ id: 'm1', title: 'm', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW }));
    store.close();
    const script = writeWriterScript(root);
    await Promise.all([runWriter(script, db, 'a', 15), runWriter(script, db, 'b', 15)]);
    const check = new SqliteStore(db);
    try {
      assert.equal(check.countCommitments(), 30, 'both writers committed every row');
      assert.equal(check.countMatters(), 1);
      assert.equal(check.verifyAudit().count, 30, 'one audit row per committed writer row');
      assert.deepEqual(check.verifyAudit(), { ok: true, count: 30 });
      assert.equal(check.listAudit(100).length, 30);
    } finally { check.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});
