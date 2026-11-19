/**
 * 0.3.0 Wave 2 (P0-L2 / P0-D1): the real CLI integration of the audit tail
 * anchor and `audit --rebuild-fts`.
 *
 * Covers: absent anchor is yellow; --write-anchor records an HMAC baseline;
 * a deleted TAIL row is detected by --expect-head and by the recorded anchor
 * (the hash chain alone cannot see it); a mid-chain deletion still trips the
 * chain; --write-anchor refuses a broken chain; strict unknown-flag handling;
 * JSON purity; and the FTS rebuild behind the reader warning.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SqliteStore } from '../lib/sqlite.js'
import { auditJson, cleanup, makeHome, runCli, runOk, seedCommitment } from './bin-ops-fixture.js'

function deleteAuditRow(home, where) {
  const db = new DatabaseSync(join(home, 'state.db'))
  try { db.prepare('DELETE FROM audit WHERE ' + where).run() } finally { db.close() }
}

function auditRowsFor(home, action) {
  const db = new DatabaseSync(join(home, 'state.db'), { readOnly: true })
  try {
    return db.prepare('SELECT seq, action, allowed, reason FROM audit ORDER BY seq').all()
      .filter((row) => row.action === action)
  } finally { db.close() }
}

test('audit: no anchor is yellow; --write-anchor records an HMAC baseline and the next check matches', () => {
  const { root, home } = makeHome('audit-anchor')
  try {
    seedCommitment(home)
    const before = auditJson(home)
    assert.equal(before.ok, true)
    assert.equal(before.anchor.found, false)
    assert.equal(before.anchor.status, 'absent')
    assert.match(before.head.headHash, /^[0-9a-f]{64}$/)
    const write = JSON.parse(runOk(home, ['audit', '--write-anchor', '--json']).stdout)
    assert.equal(write.ok, true)
    assert.equal(write.keyed, true)
    assert.equal(write.anchor.count, before.head.count)
    assert.equal(write.anchor.headHash, before.head.headHash)
    assert.match(write.anchor.hmac, /^[0-9a-f]{64}$/)
    assert.ok(existsSync(join(home, 'audit-anchor.json')))
    const after = auditJson(home)
    assert.equal(after.anchor.status, 'match')
    assert.equal(after.anchor.hmacVerified, true)
    assert.equal(after.ok, true)
    const text = runOk(home, ['audit']).stdout
    assert.match(text, /audit: verified \([0-9]+ entries\) head=[0-9a-f]{12}/)
    assert.match(text, /anchor: match/)
  } finally { cleanup(root) }
})

test('audit: a deleted TAIL row fails --expect-head and the recorded anchor even though the chain still verifies', () => {
  const { root, home } = makeHome('audit-tail')
  try {
    seedCommitment(home)
    runOk(home, ['audit', '--write-anchor'])
    const before = auditJson(home)
    deleteAuditRow(home, 'seq = (SELECT MAX(seq) FROM audit)')

    const expect = runCli(home, ['audit', '--expect-head', before.head.headHash])
    assert.equal(expect.status, 1)
    assert.match(expect.stdout + expect.stderr, /expect: FAIL \(E_AUDIT_EXPECT_MISMATCH\)/)

    const anchored = runCli(home, ['audit', '--json'])
    assert.equal(anchored.status, 1)
    const payload = JSON.parse(anchored.stdout)
    assert.equal(payload.chain.ok, true, 'the remaining rows still form a valid shorter chain')
    assert.equal(payload.ok, false)
    assert.equal(payload.anchor.code, 'E_AUDIT_TAIL_TRUNCATED')

    const text = runCli(home, ['audit'])
    assert.equal(text.status, 1)
    assert.match(text.stdout, /audit: verified /)
    assert.match(text.stdout, /anchor: FAIL \(E_AUDIT_TAIL_TRUNCATED\)/)
  } finally { cleanup(root) }
})

test('audit: a mid-chain deletion still trips the hash chain and --write-anchor refuses to anchor it', () => {
  const { root, home } = makeHome('audit-mid')
  try {
    seedCommitment(home)
    seedCommitment(home, '第二件事')
    deleteAuditRow(home, 'seq = (SELECT MIN(seq) FROM audit)')
    const broken = runCli(home, ['audit'])
    assert.equal(broken.status, 1)
    assert.match(broken.stdout + broken.stderr, /BROKEN at seq [0-9]+/)
    const write = runCli(home, ['audit', '--write-anchor'])
    assert.equal(write.status, 1)
    assert.match(write.stderr, /E_AUDIT_CHAIN_BROKEN/)
    assert.equal(existsSync(join(home, 'audit-anchor.json')), false, 'a broken chain must never become the baseline')
  } finally { cleanup(root) }
})

test('audit: an edited anchor HMAC fails closed with a stable code', () => {
  const { root, home } = makeHome('audit-hmac')
  try {
    seedCommitment(home)
    runOk(home, ['audit', '--write-anchor'])
    const file = join(home, 'audit-anchor.json')
    const anchor = JSON.parse(readFileSync(file, 'utf8'))
    anchor.hmac = 'a'.repeat(64)
    writeFileSync(file, JSON.stringify(anchor, null, 2) + '\n')
    const result = runCli(home, ['audit'])
    assert.equal(result.status, 1)
    assert.match(result.stdout + result.stderr, /E_AUDIT_ANCHOR_HMAC_MISMATCH/)
    const payload = JSON.parse(runCli(home, ['audit', '--json']).stdout)
    assert.equal(payload.anchor.code, 'E_AUDIT_ANCHOR_HMAC_MISMATCH')
    assert.equal(payload.anchor.hmacVerified, false)
  } finally { cleanup(root) }
})

test('audit: strict flags and expect validation fail closed with E_USAGE', () => {
  const { root, home } = makeHome('audit-flags')
  try {
    seedCommitment(home)
    const head = auditJson(home)
    runOk(home, ['audit', '--expect-count', String(head.head.count)])
    runOk(home, ['audit', '--expect-count', String(head.head.count), '--expect-head', head.head.headHash])
    const cases = [
      [['audit', '--bogus'], /E_USAGE/],
      [['audit', '--expect-count'], /E_USAGE/],
      [['audit', '--write-anchor', '--rebuild-fts'], /E_USAGE/],
      [['audit', '--check-db', '--write-anchor'], /E_USAGE/],
    ]
    for (const [args, pattern] of cases) {
      const result = runCli(home, args)
      assert.equal(result.status, 1, args.join(' ') + ' must exit 1')
      assert.match(result.stderr, pattern, args.join(' '))
    }
    const badCount = runCli(home, ['audit', '--expect-count', 'not-a-number'])
    assert.equal(badCount.status, 1)
    assert.match(badCount.stdout + badCount.stderr, /E_AUDIT_EXPECT_MISMATCH/)
    const badHead = runCli(home, ['audit', '--expect-head', 'zzzz'])
    assert.equal(badHead.status, 1)
    assert.match(badHead.stdout + badHead.stderr, /E_AUDIT_EXPECT_MISMATCH/)
    const json = runOk(home, ['audit', '--json'])
    assert.doesNotThrow(() => JSON.parse(json.stdout), 'audit --json must be one pure JSON document')
  } finally { cleanup(root) }
})

test('audit --rebuild-fts rebuilds an inconsistent FTS index, audits the rebuild and reports consistent afterwards', () => {
  const { root, home } = makeHome('audit-fts')
  try {
    seedCommitment(home)
    const store = new SqliteStore(join(home, 'state.db'))
    try { store.db.exec('DROP TRIGGER IF EXISTS turns_ai') } finally { store.close() }
    const rebuilt = runOk(home, ['audit', '--rebuild-fts'])
    assert.match(rebuilt.stdout, /fts: rebuilt \(inconsistent -> ok/)
    assert.match(rebuilt.stdout, /audit: appended seq [0-9]+/)
    const reopened = new SqliteStore(join(home, 'state.db'))
    let report
    try { report = reopened.verifyFtsIntegrity() } finally { reopened.close() }
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.equal(auditRowsFor(home, 'audit.rebuild_fts').length, 1)
    const again = runOk(home, ['audit', '--rebuild-fts'])
    assert.match(again.stdout, /fts: consistent /)
  } finally { cleanup(root) }
})

test('audit: the legacy JSON store refuses the SQLite-only modes instead of pretending', () => {
  const { root, home } = makeHome('audit-json')
  try {
    const result = runCli(home, ['audit', '--rebuild-fts'], { ADVISERS_STORE: 'json' })
    assert.equal(result.status, 1)
    assert.match(result.stdout + result.stderr, /SQLite store/)
  } finally { cleanup(root) }
})
