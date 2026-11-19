import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Ledger } from '../../core/dist/index.js'
import { SqliteStore } from '../lib/sqlite.js'
import { buildReminders } from '../lib/remind.js'
import { buildPetBrief } from '../lib/pet-brief.js'
import { buildDigest } from '../lib/digest.js'

/**
 * 0.3.0 P0-T1/T2 read-model contract (2026-11-20).
 *
 * The read commands moved from whole-entity loads to narrow SQL projections.
 * These tests pin the part that is easy to get wrong: the projections must
 * return exactly the rows and columns the view used to see, in the historical
 * rowid order, with no TEMP B-TREE in the plan; and the pure view builders must
 * produce byte-identical output from projected rows.
 */

const FIXED_NOW = new Date('2026-11-20T03:00:00.000Z')

function setup(name) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-read-model-' + name + '-'))
  return { root, db: join(root, 'state.db') }
}

function seedFixture(db) {
  const store = new SqliteStore(db)
  const ledger = new Ledger()
  const publicMatter = ledger.addMatter({ title: '客户 A 报价', secrecy: 0, participants: ['王工', '李总'] })
  const secretMatter = ledger.addMatter({ title: '保密事项', secrecy: 2 })
  const archivedMatter = ledger.addMatter({ title: '旧项目', secrecy: 0 })

  const addCommitment = (action, dueAt, extra = {}) => ledger.addCommitment({
    matterId: publicMatter.id,
    debtor: 'user',
    creditor: '王工',
    action,
    capability: 'todo',
    evidence: [{ sessionId: 's', turnId: 't', quote: action }],
    ...(dueAt === undefined ? {} : { dueAt }),
    ...extra,
  })
  const commitments = {
    overdue: addCommitment('逾期两天', '2026-11-18T10:00:00+08:00'),
    today: addCommitment('今天到期', '2026-11-20T09:00:00Z'),
    dateOnly: addCommitment('三天后', '2026-11-23'),
    local: addCommitment('本地无时区', '2026-11-25 10:00'),
    noDue: addCommitment('无截止', undefined),
    invalid: addCommitment('无效日期', 'not-a-date'),
    done: addCommitment('已完成', '2026-11-19T10:00:00+08:00'),
    snoozed: addCommitment('已搁置', '2026-11-21T10:00:00+08:00'),
    dropped: addCommitment('已放弃', '2026-11-21T10:00:00+08:00'),
    secret: addCommitment('保密事项下的承诺', '2026-11-21T10:00:00+08:00', { matterId: secretMatter.id }),
    archived: addCommitment('归档事项下的承诺', '2026-11-22T10:00:00+08:00', { matterId: archivedMatter.id }),
    offsets: addCommitment('自定义提醒偏移', '2026-11-22T10:00:00+08:00', { reminderOffsets: ['-1d', '+0d09:00'] }),
    corruptEvidence: addCommitment('损坏证据的承诺', '2026-11-24T10:00:00+08:00'),
    emptyEvidence: addCommitment('空证据的承诺', '2026-11-26T10:00:00+08:00'),
  }
  ledger.completeCommitment(commitments.done.id, [{ sessionId: 's', turnId: 't', quote: '完成' }])

  const addFact = (subject, predicate, object, extra = {}) => ledger.remember({
    subject,
    predicate,
    object,
    matterId: publicMatter.id,
    authority: 'user',
    confidence: 0.9,
    evidence: [{ sessionId: 's', turnId: 't', quote: object }],
    ...extra,
  })
  const facts = {
    top: addFact('王工', 'prefers', '先给总价', { confidence: 0.99 }),
    second: addFact('李总', 'stated', '下周确认', { confidence: 0.95 }),
    low: addFact('客户', 'prefers', '低置信', { confidence: 0.5 }),
    noMatter: addFact('赵工', 'prefers', '无事项事实', { confidence: 0.9, matterId: undefined }),
    secret: addFact('秘密联系人', 'stated', '保密内容', { matterId: secretMatter.id, confidence: 0.99 }),
    expired: addFact('过期人', 'stated', '过期事实', { confidence: 1 }),
    deleted: addFact('删除人', 'stated', '删除事实', { confidence: 1 }),
    candidate: addFact('候选人', 'stated', '候选事实', { confidence: 0.99 }),
  }

  store.save(ledger.toJSON())
  // Rows that only exist through status/validity columns (the entity API has
  // no direct setters for them). The projections must agree with listFacts()/
  // listCommitments() after this, not with the in-memory objects.
  store.db.prepare("UPDATE matters SET status = 'archived' WHERE id = ?").run(archivedMatter.id)
  store.db.prepare("UPDATE commitments SET status = 'snoozed' WHERE id = ?").run(commitments.snoozed.id)
  store.db.prepare("UPDATE commitments SET status = 'dropped' WHERE id = ?").run(commitments.dropped.id)
  store.db.prepare("UPDATE commitments SET evidence = '{not json' WHERE id = ?").run(commitments.corruptEvidence.id)
  store.db.prepare("UPDATE commitments SET evidence = '[]' WHERE id = ?").run(commitments.emptyEvidence.id)
  store.db.prepare("UPDATE facts SET expired_at = '2026-11-01T00:00:00Z' WHERE id = ?").run(facts.expired.id)
  store.db.prepare("UPDATE facts SET deleted_at = '2026-11-01T00:00:00Z' WHERE id = ?").run(facts.deleted.id)
  store.db.prepare("UPDATE facts SET status = 'candidate' WHERE id = ?").run(facts.candidate.id)
  return { store, ledger, commitments, facts, matters: { publicMatter, secretMatter, archivedMatter } }
}

const reload = (store) => Ledger.fromJSON(store.load())

/** The exact assembly the pet-brief command uses (bin/advisers.js). */
function petBriefProjection(store) {
  return store.read(() => {
    const matters = store.loadMatters()
    const secrecyOf = (matter) => {
      const level = Number(matter.secrecy ?? 0)
      return Number.isFinite(level) ? level : Number.POSITIVE_INFINITY
    }
    const publicMatterIds = matters.filter((matter) => matter.status === 'active' && secrecyOf(matter) < 2).map((matter) => matter.id)
    return {
      matters,
      commitments: store.projectCommitmentsForPetBrief(),
      facts: store.projectFactsForPetBrief({ limit: 10, minConfidence: 0.7, matterIds: publicMatterIds }),
      names: [...new Set([...store.projectCommitmentCreditorCandidates(), ...store.projectFactSubjectCandidates()])],
    }
  })
}

function petBriefLedger(projected) {
  return {
    listMatters: (status) => status === undefined ? projected.matters : projected.matters.filter((matter) => matter.status === status),
    listCommitments: () => projected.commitments,
    listFacts: () => projected.facts,
  }
}

test('projections keep rowid order and exactly the columns each view reads', () => {
  const { root, db } = setup('rows')
  const { store, commitments } = seedFixture(db)
  try {
    const full = reload(store)

    const today = store.read(() => store.projectOpenCommitmentsForToday())
    assert.deepEqual(today, full.openCommitments().map((c) => ({ id: c.id, debtor: c.debtor, creditor: c.creditor, action: c.action, dueAt: c.dueAt })))

    const reminders = store.read(() => store.projectCommitmentsForReminders())
    assert.deepEqual(reminders, full.listCommitments()
      .filter((c) => c.status !== 'done' && c.status !== 'dropped' && c.dueAt != null)
      .map((c) => ({
        id: c.id, status: c.status, creditor: c.creditor, action: c.action, dueAt: c.dueAt,
        ...(Array.isArray(c.reminderOffsets) ? { reminderOffsets: c.reminderOffsets } : {}),
      })))
    assert.ok(reminders.every((row) => !['done', 'dropped'].includes(row.status)))

    const undated = store.read(() => store.projectCommitmentsForReminders({ includeUndated: true }))
    const expectedUndated = full.listCommitments().filter((c) => c.status !== 'done' && c.status !== 'dropped')
    assert.deepEqual(undated.map((row) => row.id), expectedUndated.map((c) => c.id))

    const petBriefRows = store.read(() => store.projectCommitmentsForPetBrief())
    assert.deepEqual(petBriefRows, full.openCommitments().map((c) => ({
      id: c.id, matterId: c.matterId, creditor: c.creditor, action: c.action, dueAt: c.dueAt, status: c.status,
      hasEvidence: Array.isArray(c.evidence) && c.evidence.length > 0,
    })))
    assert.equal(petBriefRows.find((row) => row.id === commitments.corruptEvidence.id)?.hasEvidence, false)
    assert.equal(petBriefRows.find((row) => row.id === commitments.emptyEvidence.id)?.hasEvidence, false)

    const digest = store.read(() => store.projectCommitmentsForDigest())
    assert.deepEqual(digest, full.listCommitments()
      .filter((c) => c.status === 'open' || c.status === 'done')
      .map((c) => ({ status: c.status, action: c.action, dueAt: c.dueAt, doneAt: c.doneAt })))
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('hot read SQL scans or uses an index prefix, never a TEMP B-TREE sort', () => {
  const { root, db } = setup('plan')
  const { store } = seedFixture(db)
  try {
    const plan = (sql, ...params) => store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map((row) => row.detail).join(' | ')
    // today/tui/remind projections: sequential table scan keeps rowid order.
    assert.doesNotMatch(plan("SELECT id, debtor, creditor, action, due_at FROM commitments NOT INDEXED WHERE status = 'open'"), /TEMP B-TREE/)
    assert.doesNotMatch(plan("SELECT id, status, creditor, action, due_at, reminder_offsets FROM commitments NOT INDEXED WHERE status NOT IN ('done','dropped')"), /TEMP B-TREE/)
    // T1: validOnly makes the status+deleted_at index key a rowid-ordered prefix.
    assert.doesNotMatch(plan("SELECT * FROM facts WHERE status = 'confirmed' AND expired_at IS NULL AND deleted_at IS NULL ORDER BY rowid"), /TEMP B-TREE FOR ORDER BY/)
    // today --json keeps rowid order with a table scan instead of a sort.
    assert.doesNotMatch(plan('SELECT * FROM commitments NOT INDEXED WHERE status = ?', 'open'), /TEMP B-TREE/)
    // The two layout-only indexes the projections depend on exist.
    const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all().map((row) => row.name)
    assert.ok(indexes.includes('idx_facts_status_confidence'), indexes.join(','))
    assert.ok(indexes.includes('idx_facts_valid_subject'), indexes.join(','))
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadFacts validOnly is exactly listFacts() semantics and stays opt-in', () => {
  const { root, db } = setup('validonly')
  const { store, facts } = seedFixture(db)
  try {
    const full = reload(store)
    const expected = full.listFacts().map((f) => ({ id: f.id, subject: f.subject, status: f.status }))
    const active = store.read(() => store.loadFacts({ status: 'confirmed', validOnly: true })).map((f) => ({ id: f.id, subject: f.subject, status: f.status }))
    assert.deepEqual(active, expected)
    assert.ok(!active.some((f) => f.id === facts.expired.id || f.id === facts.deleted.id))

    // Default behaviour is unchanged: confirmed rows include expired/deleted
    // history, which load()/loadSnapshot()/export still rely on.
    const confirmed = store.loadFacts({ status: 'confirmed' })
    assert.ok(confirmed.some((f) => f.id === facts.expired.id))
    assert.ok(confirmed.some((f) => f.id === facts.deleted.id))
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildReminders: projected rows and full entities produce identical reminders', () => {
  const { root, db } = setup('remind')
  const { store } = seedFixture(db)
  try {
    const full = reload(store)
    const rows = store.read(() => store.projectCommitmentsForReminders())
    const projected = { listCommitments: () => rows }
    const someId = rows.find((row) => row.status === 'open').id
    const scenarios = [
      { now: FIXED_NOW },
      { now: FIXED_NOW, horizonDays: 0 },
      { now: FIXED_NOW, horizonDays: 30, allowL3: true },
      { now: FIXED_NOW, snoozedUntil: { [someId]: '2026-11-21T00:00:00+08:00' } },
      { now: FIXED_NOW, defaultReminderOffsets: ['-2h'] },
      { now: FIXED_NOW, rules: ['due-1d', 'overdue-daily'] },
      { now: FIXED_NOW, reminderOffsets: new Map([[someId, ['-3d']]]) },
    ]
    for (const options of scenarios) {
      assert.deepEqual(buildReminders(projected, options), buildReminders(full, options), JSON.stringify(Object.keys(options)))
    }
    assert.ok(buildReminders(projected, { now: FIXED_NOW }).length > 0)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildPetBrief: projected rows plus name candidates equal the full-ledger brief', () => {
  const { root, db } = setup('petbrief')
  const { store, facts, matters, commitments } = seedFixture(db)
  try {
    const full = reload(store)
    const projected = petBriefProjection(store)
    const fullBrief = buildPetBrief(full, { now: FIXED_NOW })
    const projectedBrief = buildPetBrief(petBriefLedger(projected), { now: FIXED_NOW, nameCandidates: projected.names })
    assert.deepEqual(projectedBrief, fullBrief)

    // Validity filtering happens before the top-N: an expired/deleted/candidate
    // fact with 0.99-1.0 confidence must not displace a live fact.
    const invalidIds = [facts.expired.id, facts.deleted.id, facts.candidate.id]
    assert.ok(!projected.facts.some((fact) => invalidIds.includes(fact.id)))
    // The projection keeps every open commitment (buildPetBrief derives its
    // excludedOpen counts from them); the protected one must not reach output.
    assert.ok(projected.commitments.some((row) => row.matterId === matters.secretMatter.id))
    assert.ok(!projectedBrief.commitments.some((item) => item.id === commitments.secret.id))
    assert.ok(!projectedBrief.risks.some((risk) => risk.evidence === commitments.secret.id))

    const publicIds = new Set(projected.matters.filter((matter) => matter.status === 'active' && Number(matter.secrecy ?? 0) < 2).map((matter) => matter.id))
    const expected = full.listFacts()
      .filter((fact) => Number(fact.confidence) >= 0.7)
      .filter((fact) => !fact.matterId || publicIds.has(fact.matterId))
      .sort((a, b) => Number(b.confidence) - Number(a.confidence) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 10)
      .map((fact) => fact.id)
    assert.deepEqual(projected.facts.map((fact) => fact.id), expected)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildDigest: projected rows match the full ledger for day and week', () => {
  const { root, db } = setup('digest')
  const { store } = seedFixture(db)
  try {
    const full = reload(store)
    const rows = store.read(() => store.projectCommitmentsForDigest())
    for (const period of ['day', 'week']) {
      assert.equal(
        buildDigest({ period, now: FIXED_NOW, commitments: rows, turns: [], deliveries: [] }),
        buildDigest({ period, now: FIXED_NOW, commitments: full.listCommitments(), turns: [], deliveries: [] }),
      )
    }
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
