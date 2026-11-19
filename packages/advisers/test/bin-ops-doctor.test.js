/**
 * 0.3.0 Wave 2 (P0-D1): `doctor --repair` — the recovery console.
 *
 * Covers: healthy dry-run has no side effects; stale lock + stale temp residue
 * are planned then repaired with an audit row; an inconsistent FTS index is
 * rebuilt; an unusable WAL is preserved and moved aside after a safety backup;
 * a live writer lock blocks the repair; unsupported --only items and unknown
 * flags fail closed; the legacy JSON store is refused honestly.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SqliteStore } from '../lib/sqlite.js'
import { cleanup, makeHome, runCli, runOk, seedCommitment } from './bin-ops-fixture.js'

function auditRowsFor(home, action) {
  const db = new DatabaseSync(join(home, 'state.db'), { readOnly: true })
  try {
    return db.prepare('SELECT seq, action, allowed, reason FROM audit ORDER BY seq').all()
      .filter((row) => row.action === action)
  } finally { db.close() }
}

test('doctor --repair: a healthy database plans nothing and a dry-run has no side effects', () => {
  const { root, home } = makeHome('repair-healthy')
  try {
    seedCommitment(home)
    const dbPath = join(home, 'state.db')
    const beforeStat = statSync(dbPath)
    const plan = JSON.parse(runOk(home, ['doctor', '--repair', '--json']).stdout)
    assert.equal(plan.ok, true)
    assert.equal(plan.mode, 'dry-run')
    assert.deepEqual(plan.issues, [])
    assert.deepEqual(plan.blockers, [])
    assert.equal(statSync(dbPath).mtimeMs, beforeStat.mtimeMs)
    assert.equal(auditRowsFor(home, 'doctor.repair').length, 0, 'a dry-run must not write audit rows')
    const applied = JSON.parse(runOk(home, ['doctor', '--repair', '--yes', '--json']).stdout)
    assert.equal(applied.ok, true)
    assert.equal(applied.note, 'nothing to do')
    assert.deepEqual(applied.fixed, [])
    assert.equal(auditRowsFor(home, 'doctor.repair').length, 0)
  } finally { cleanup(root) }
})

test('doctor --repair: stale lock + stale temp residue are repaired with a safety backup and an audit row', () => {
  const { root, home } = makeHome('repair-lock-temp')
  try {
    seedCommitment(home)
    const lockFile = join(home, 'instance.lock')
    writeFileSync(lockFile, JSON.stringify({ pid: 999999, startedAt: '2020-01-01T00:00:00.000Z', command: 'crashed' }) + '\n')
    const staleTemp = join(home, '.state.db.tmp-999999-abc-def')
    writeFileSync(staleTemp, 'leftover\n')
    const liveTemp = join(home, '.state.db.tmp-' + process.pid + '-live-live')
    writeFileSync(liveTemp, 'do not touch\n')

    const plan = JSON.parse(runOk(home, ['doctor', '--repair', '--json']).stdout)
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.issues.map((issue) => issue.item).sort(), ['lock', 'temp'])

    const applied = JSON.parse(runOk(home, ['doctor', '--repair', '--only', 'lock,temp', '--yes', '--json']).stdout)
    assert.equal(applied.ok, true, JSON.stringify(applied.errors))
    assert.ok(applied.fixed.includes('lock'))
    assert.ok(applied.fixed.includes('temp'))
    assert.ok(applied.backup, 'an applied repair writes a safety backup before touching the store')
    assert.equal(existsSync(lockFile), false)
    assert.equal(existsSync(staleTemp), false)
    assert.equal(existsSync(liveTemp), true, 'a live pid temp file must never be removed')
    const repairs = auditRowsFor(home, 'doctor.repair')
    assert.equal(repairs.length, 1)
    assert.match(repairs[0].reason, /^only=lock\+temp;fixed=/,
      repairs[0].reason)
    assert.match(repairs[0].reason, /backup=state-/)
    assert.doesNotMatch(repairs[0].reason, /\//, 'audit reasons must not carry absolute paths')
    const check = runCli(home, ['doctor', '--check-db'])
    assert.equal(check.status, 0, check.stdout + check.stderr)
  } finally { cleanup(root) }
})

test('doctor --repair: an inconsistent FTS index is rebuilt and re-verified', () => {
  const { root, home } = makeHome('repair-fts')
  try {
    seedCommitment(home)
    const store = new SqliteStore(join(home, 'state.db'))
    try { store.db.exec('DROP TRIGGER IF EXISTS turns_ai') } finally { store.close() }
    const broken = runCli(home, ['doctor', '--check-db'])
    assert.equal(broken.status, 1)
    assert.match(broken.stdout, /FAIL  db-fts/)
    const repaired = JSON.parse(runOk(home, ['doctor', '--repair', '--only', 'fts', '--yes', '--json']).stdout)
    assert.equal(repaired.ok, true, JSON.stringify(repaired.errors))
    assert.ok(repaired.fixed.includes('fts'))
    assert.equal(repaired.verify.fts, 'ok')
    assert.ok(repaired.anchor && repaired.anchor.ok === true, 'a successful repair refreshes the audit anchor')
    const healthy = runCli(home, ['doctor', '--check-db'])
    assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr)
    assert.match(healthy.stdout, /PASS  db-fts  state=ok/)
  } finally { cleanup(root) }
})

test('doctor --repair: an unusable WAL is preserved beside the database after a safety backup', () => {
  const { root, home } = makeHome('repair-wal')
  try {
    seedCommitment(home)
    const walPath = join(home, 'state.db-wal')
    writeFileSync(walPath, 'not a wal file at all\n')
    const plan = JSON.parse(runOk(home, ['doctor', '--repair', '--json']).stdout)
    assert.ok(plan.issues.some((issue) => issue.item === 'wal'), JSON.stringify(plan))
    const repaired = JSON.parse(runOk(home, ['doctor', '--repair', '--only', 'wal', '--yes', '--json']).stdout)
    assert.equal(repaired.ok, true, JSON.stringify(repaired.errors))
    assert.ok(repaired.fixed.includes('wal'))
    assert.equal(existsSync(walPath), false)
    const quarantined = readdirSync(home).filter((name) => /^state\.db-wal\.corrupt-/.test(name))
    assert.equal(quarantined.length, 1, 'the unusable WAL must be preserved for forensics')
    assert.ok(repaired.backup, 'the main database is backed up before the WAL is moved')
    const healthy = runCli(home, ['doctor', '--check-db'])
    assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr)
  } finally { cleanup(root) }
})

test('doctor --repair: a live writer lock is a blocker and is never stolen or removed', () => {
  const { root, home } = makeHome('repair-live-lock')
  try {
    seedCommitment(home)
    const lockFile = join(home, 'instance.lock')
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), command: 'test-runner' }) + '\n')
    const dry = runCli(home, ['doctor', '--repair', '--json'])
    assert.equal(dry.status, 1)
    const plan = JSON.parse(dry.stdout)
    assert.equal(plan.ok, false)
    assert.equal(plan.blockers.length, 1)
    assert.match(plan.blockers[0], /live process/)
    const apply = runCli(home, ['doctor', '--repair', '--yes', '--only', 'lock'])
    assert.equal(apply.status, 1)
    assert.match(apply.stderr, /live process/)
    assert.ok(existsSync(lockFile), 'a live lock must never be removed')
    const db = new DatabaseSync(join(home, 'state.db'), { readOnly: true })
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'doctor.repair'").get().n, 0)
    } finally { db.close() }
  } finally { cleanup(root) }
})

test('doctor --repair: unsupported --only items, unknown flags and the JSON store fail closed', () => {
  const { root, home } = makeHome('repair-flags')
  try {
    seedCommitment(home)
    const cases = [
      [['doctor', '--bogus'], /E_USAGE/],
      [['doctor', '--repair', '--only', 'plaintext'], /E_USAGE/],
      [['doctor', '--repair', '--only', 'lock,bogus'], /unsupported repair item/],
      [['doctor', '--repair', '--only', ''], /E_USAGE/],
      [['doctor', '--dry-run'], /only valid with --repair/],
      [['doctor', '--repair', '--dry-run', '--yes'], /mutually exclusive/],
    ]
    for (const [args, pattern] of cases) {
      const result = runCli(home, args)
      assert.equal(result.status, 1, args.join(' ') + ' must exit 1')
      assert.match(result.stderr, pattern, args.join(' '))
    }
    const jsonStore = runCli(home, ['doctor', '--repair', '--json'], { ADVISERS_STORE: 'json' })
    assert.equal(jsonStore.status, 1)
    assert.match(jsonStore.stderr, /SQLite store/)
  } finally { cleanup(root) }
})
