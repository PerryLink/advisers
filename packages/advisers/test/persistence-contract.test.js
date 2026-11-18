import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyRemember,
  createCommitment,
  createFact,
  createPreference,
  Ledger,
  LEDGER_SNAPSHOT_TABLES,
  updateCommitmentFields,
} from '../../core/dist/index.js'
import { SCHEMA_VERSION, SqliteStore } from '../lib/sqlite.js'

// 0.2.3 core/sqlite contract (03-design-persistence-v2.md §2.2, §6.5): the
// SQLite adapter and the in-memory Ledger are two implementations of the same
// wire-v1 LedgerSnapshot. These tests pin that they produce identical entity
// data for the same operation sequence, that every core entity field survives
// the SQLite round-trip, and that the wire format itself did not change.

const NOW = '2026-11-18T00:00:00.000Z'
const EVIDENCE = [{ sessionId: 'c1', turnId: 't1', quote: '周五前发' }]

function ports(now = NOW) {
  let seq = 0
  return { clock: { now: () => now }, ids: { next: (prefix) => `${prefix}_${++seq}` } };
}

/** Wire normalization: undefined fields are not part of the JSON wire format. */
function wire(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Sort the entity arrays so two ledgers can be compared without row order. */
function normalizeSnapshot(snapshot) {
  const normalized = wire(snapshot);
  for (const table of LEDGER_SNAPSHOT_TABLES) {
    if (table === 'routes') continue;
    normalized[table].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  normalized.routes = Object.fromEntries(Object.entries(normalized.routes).sort(([a], [b]) => a.localeCompare(b)));
  return normalized;
}

function setup(prefix = 'advisers-persistence-contract-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, db: join(root, 'state.db') };
}

test('sqlite directed writes equal the in-memory Ledger for the same operation sequence', () => {
  const { root, db } = setup();
  try {
    // In-memory core ledger (the reference implementation).
    const memory = new Ledger(ports());
    const matter = memory.addMatter({ title: '客户A', domain: 'consulting', secrecy: 1, participants: ['a'], deadlines: ['2026-12-01'], openQuestions: ['报价?'] });
    const currentFact = memory.remember({ matterId: matter.id, subject: 'client', predicate: 'budget', object: '300万' });
    memory.remember({ matterId: matter.id, subject: 'client', predicate: 'budget', object: '350万', evidence: [{ quote: '改为350万' }] });
    memory.remember({ matterId: matter.id, subject: 'client', predicate: 'budget', object: '200万', authority: 'inferred' });
    memory.addPreference({ kind: 'preference', statement: '邮件先结论', confidence: 0.8 });
    const commitment = memory.addCommitment({ matterId: matter.id, debtor: 'agent', creditor: 'user', action: '发报价', dueAt: '2026-11-20T18:00:00+08:00', evidence: EVIDENCE, reminderOffsets: ['-1d'] });
    memory.updateCommitment(commitment.id, { action: '发合同', dueAt: '2026-11-21T10:00:00+08:00' });
    memory.completeCommitment(commitment.id, [{ sessionId: 'c1', turnId: 't9', quote: '已发送' }]);

    // SQLite adapter: same operations through the directed write path.
    const store = new SqliteStore(db);
    // Use one deterministic id sequence so the SQLite rows carry exactly the ids
    // the in-memory Ledger assigned (same prefixes and call order).
    const p = ports();
    try {
      store.mutate(() => {
        const m = { id: p.ids.next('matter'), title: '客户A', status: 'active', domain: 'consulting', secrecy: 1, participants: ['a'], deadlines: ['2026-12-01'], openQuestions: ['报价?'], createdAt: NOW, updatedAt: NOW };
        store.insertMatter(m);
        const factInput = (object, extra = {}) => ({ matterId: 'matter_1', subject: 'client', predicate: 'budget', object, ...extra });
        const first = applyRemember(undefined, factInput('300万'), p);
        assert.equal(first.op, 'insert');
        store.insertFact(first.row);
        const second = applyRemember(first.row, factInput('350万', { evidence: [{ quote: '改为350万' }] }), p);
        assert.equal(second.op, 'supersede');
        store.updateFact(second.old.id, { status: second.old.status, validTo: second.old.validTo, expiredAt: second.old.expiredAt, supersededBy: second.old.supersededBy });
        store.insertFact(second.row);
        const shadow = applyRemember(second.row, factInput('200万', { authority: 'inferred' }), p);
        assert.equal(shadow.op, 'insert');
        assert.ok(shadow.row.shadowedBy);
        store.insertFact(shadow.row);
        store.insertPreference(createPreference(p, { kind: 'preference', statement: '邮件先结论', confidence: 0.8 }));
        const c = createCommitment(p, { matterId: 'matter_1', debtor: 'agent', creditor: 'user', action: '发报价', dueAt: '2026-11-20T18:00:00+08:00', evidence: EVIDENCE, reminderOffsets: ['-1d'] });
        store.insertCommitment(c);
        const edited = updateCommitmentFields(c, { action: '发合同', dueAt: '2026-11-21T10:00:00+08:00' });
        store.updateCommitment(c.id, { action: edited.action, dueAt: edited.dueAt });
        store.updateCommitment(c.id, { status: 'done', doneAt: NOW, evidence: [...edited.evidence, { sessionId: 'c1', turnId: 't9', quote: '已发送' }] });
      });
      const sqliteSnapshot = normalizeSnapshot(store.load());
      const memorySnapshot = normalizeSnapshot(memory.toJSON());
      assert.deepEqual(sqliteSnapshot, memorySnapshot, 'sqlite and in-memory ledgers must be indistinguishable on the wire');
      // The directed writes really did produce supersede/shadow chains.
      assert.equal(sqliteSnapshot.facts.filter((f) => f.status === 'confirmed').length, 1);
      assert.equal(sqliteSnapshot.facts.filter((f) => f.status === 'superseded').length, 1);
      assert.equal(sqliteSnapshot.facts.filter((f) => f.shadowedBy).length, 1);
      assert.equal(sqliteSnapshot.commitments[0].status, 'done');
      assert.equal(sqliteSnapshot.commitments[0].evidence.length, 2);
      assert.ok(currentFact.id);
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('save()/load() still round-trip every entity field (wire v1 unchanged)', () => {
  const { root, db } = setup('advisers-contract-roundtrip-');
  try {
    const ledger = new Ledger(ports());
    const matter = ledger.addMatter({ title: '客户', domain: 'consulting', secrecy: 2, summary: '摘要', participants: ['a', 'b'], deadlines: ['2026-12-01'], openQuestions: ['q'] });
    ledger.remember({ matterId: matter.id, subject: 'u', predicate: 'city', object: '上海', source: { quote: 'q', ref: 'r' }, evidence: [{ quote: 'e' }] });
    ledger.remember({ matterId: matter.id, subject: 'u', predicate: 'city', object: '北京', authority: 'import' });
    ledger.addPreference({ kind: 'goal', statement: '先结论', scope: { level: 'matter', value: matter.id }, source: { type: 'imported', quote: 'q' }, confidence: 0.7, status: 'candidate', expiresAt: '2026-12-31T00:00:00.000Z', priority: 'hard', evidence: [{ quote: 'e' }] });
    const commitment = ledger.addCommitment({ matterId: matter.id, debtor: 'third:client', creditor: 'user', action: '发报价', dueAt: NOW, timezone: 'Asia/Shanghai', capability: 'calendar', evidence: EVIDENCE, reminderOffsets: ['-1d', '+0d09:00'] });
    ledger.updateCommitment(commitment.id, { reminderOffsets: [] });
    ledger.completeCommitment(commitment.id, [{ sessionId: 'c1', turnId: 't9', quote: '已发送' }]);
    ledger.forget('fact', [...ledger.toJSON().facts].find((f) => f.authority === 'user').id);
    ledger.proposeLink({ fromMatter: matter.id, toMatter: 'matter_other', type: 'depends_on', confidence: 0.6, evidence: ['e'], createdBy: 'user' });
    ledger.proposeUpdate({ sourceMatter: matter.id, targetMatter: 'matter_other', change: 'rename' });
    ledger.setRoute('cli:cli', matter.id);
    const routine = ledger.addRoutine({ name: '周报', description: '每周五', trigger: ['周五'], steps: ['汇总'], preferences: [], pitfalls: [], verification: [], createdBy: 'user' });
    ledger.proposeRoutinePatch(routine.id, { description: 'updated' });
    const original = wire(ledger.toJSON());
    const store = new SqliteStore(db);
    try {
      store.save(ledger.toJSON());
      const restored = Ledger.fromJSON(store.load());
      assert.deepEqual(wire(restored.toJSON()), original, 'every core entity field must survive save()+load()');
      assert.deepEqual(Object.keys(store.loadSnapshot()).sort(), ['version', ...LEDGER_SNAPSHOT_TABLES].sort());
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('the physical schema version (20) is independent from the wire version (1)', () => {
  const { root, db } = setup('advisers-contract-versions-');
  try {
    const store = new SqliteStore(db);
    try {
      assert.equal(SCHEMA_VERSION, 20, 'physical schema');
      assert.equal(store.getMeta('schema_version'), '20');
      const snapshot = store.load();
      assert.equal(snapshot.version, 1, 'LedgerSnapshot wire version stays 1');
      assert.deepEqual(Object.keys(snapshot).sort(), ['version', ...LEDGER_SNAPSHOT_TABLES].sort());
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});

test('save(snapshot) keeps full-replace semantics for import/seed paths', () => {
  const { root, db } = setup('advisers-contract-replace-');
  try {
    const store = new SqliteStore(db);
    try {
      const seed = new Ledger(ports());
      const oldMatter = seed.addMatter({ title: '旧客户' });
      seed.addCommitment({ matterId: oldMatter.id, debtor: 'user', creditor: 'u', action: 'old', evidence: EVIDENCE });
      store.save(seed.toJSON());
      assert.equal(store.countMatters(), 1);
      // No prior load(): the historical full-replace contract (import --replace).
      const replacement = new Ledger(ports());
      const newMatter = replacement.addMatter({ title: '新客户' });
      replacement.addCommitment({ matterId: newMatter.id, debtor: 'user', creditor: 'u', action: 'new', evidence: EVIDENCE });
      store.save(replacement.toJSON());
      const loaded = Ledger.fromJSON(store.load());
      assert.deepEqual(loaded.listMatters().map((m) => m.title), ['新客户']);
      assert.deepEqual(loaded.listCommitments().map((c) => c.action), ['new']);
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
});
