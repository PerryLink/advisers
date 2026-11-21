import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertPrivateMode } from './win-compat.mjs'
import { SqliteStore } from '../lib/sqlite.js'
import {
  AUDIT_ANCHOR_FILE,
  AUDIT_ANCHOR_FORMAT,
  AUDIT_ANCHOR_VERSION,
  buildAuditAnchor,
  buildAuditAnchorForStore,
  computeAuditDbId,
  describeAuditAnchorCode,
  readAuditAnchor,
  readAuditHead,
  validateAuditAnchor,
  verifyAuditAgainstAnchor,
  verifyAuditAnchor,
  verifyExpectedAudit,
  verifyRestoreAnchor,
  writeAuditAnchor,
} from '../lib/audit-anchor.js'

// 0.3.0 L2 (04-0.3-research §4.7 / 25-0.3.0-security-perf-robustness P0-L2):
// the audit chain detects middle-row rewrites but not a tail deletion. The
// audit-anchor.json sidecar records count/lastSeq/headHash (+ optional HMAC) so
// `audit --expect-head` / `privacy --prove` / restore can detect a truncated or
// rolled-back tail. These tests pin the format, the detection semantics and the
// honest 'unkeyed anchor' warning.

const savedAuditKey = process.env.ADVISERS_AUDIT_KEY
function clearAuditKey() { delete process.env.ADVISERS_AUDIT_KEY }
test.after(() => {
  if (savedAuditKey === undefined) delete process.env.ADVISERS_AUDIT_KEY
  else process.env.ADVISERS_AUDIT_KEY = savedAuditKey
})

const KEY = 'test-audit-anchor-key-0123456789'

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-audit-anchor-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function seedStore(home, count = 3, { actor = 'local', prefix = 'test.action.' } = {}) {
  const store = new SqliteStore(join(home, 'state.db'))
  for (let index = 1; index <= count; index++) {
    store.appendAudit({
      actor,
      action: prefix + index,
      allowed: index % 2 === 0,
      reason: index === 2 ? 'second-reason' : null,
    })
  }
  return store
}

test('readAuditHead reports count/lastSeq/head/genesis and refuses a broken chain', () => {
  clearAuditKey()
  const { root, home } = makeHome()
  const store = seedStore(home, 3)
  try {
    const head = readAuditHead(store)
    assert.equal(head.ok, true)
    assert.equal(head.count, 3)
    assert.equal(head.lastSeq, 3)
    assert.match(head.headHash, /^[0-9a-f]{64}$/)
    assert.match(head.genesisHash, /^[0-9a-f]{64}$/)
    assert.match(head.dbId, /^sha256:[0-9a-f]{64}$/)
    assert.equal(head.dbId, computeAuditDbId(head.genesisHash))
    assert.equal(head.chainVerified, true)

    // Middle-row rewrite keeps the shape but breaks the chain: refuse to anchor.
    store.db.prepare("UPDATE audit SET reason = 'tampered' WHERE seq = 2").run()
    const broken = readAuditHead(store)
    assert.equal(broken.ok, false)
    assert.equal(broken.code, 'E_AUDIT_CHAIN_BROKEN')
    assert.equal(broken.brokenAt, 2)
    assert.match(describeAuditAnchorCode('E_AUDIT_TAIL_TRUNCATED'), /tail/)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('writeAuditAnchor writes a 0600 atomic anchor that verifies as match', () => {
  clearAuditKey()
  const { root, home } = makeHome()
  const store = seedStore(home, 3)
  try {
    assert.equal(writeAuditAnchor({ home, store, key: KEY, generator: 'advisers/0.3.0-test' }).ok, true)
    const path = join(home, AUDIT_ANCHOR_FILE)
    const anchor = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(anchor.format, AUDIT_ANCHOR_FORMAT)
    assert.equal(anchor.version, AUDIT_ANCHOR_VERSION)
    assert.equal(anchor.count, 3)
    assert.equal(anchor.lastSeq, 3)
    assert.match(anchor.headHash, /^[0-9a-f]{64}$/)
    assert.match(anchor.dbId, /^sha256:[0-9a-f]{64}$/)
    assert.equal(anchor.generator, 'advisers/0.3.0-test')
    assert.equal(anchor.keyed, true)
    assert.match(anchor.hmac, /^[0-9a-f]{64}$/)
    assert.equal(validateAuditAnchor(anchor).ok, true)
    assertPrivateMode(path, 0o600, 'audit anchor')
    assert.equal(readdirSync(home).some((name) => name.includes('.tmp-')), false, 'atomic write leaves no temp files')

    const verified = verifyAuditAgainstAnchor({ home, store, key: KEY })
    assert.equal(verified.ok, true)
    assert.equal(verified.status, 'match')
    assert.equal(verified.hmacVerified, true)
    assert.equal(verified.keyed, true)
    assert.equal(verified.found, true)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('deleting the last audit row is detected by the anchor (A8 tail deletion)', () => {
  clearAuditKey()
  const { root, home } = makeHome()
  const store = seedStore(home, 3)
  try {
    const before = readAuditHead(store)
    assert.equal(writeAuditAnchor({ home, store, key: KEY }).ok, true)
    // Tail deletion leaves the remaining chain valid (that is the whole point).
    store.db.prepare('DELETE FROM audit WHERE seq = 3').run()
    assert.equal(store.verifyAudit().ok, true, 'fixture: the chain of the remaining rows still verifies')

    const verified = verifyAuditAgainstAnchor({ home, store, key: KEY })
    assert.equal(verified.ok, false)
    assert.equal(verified.code, 'E_AUDIT_TAIL_TRUNCATED')
    assert.match(verified.errors.join(' '), /tail was deleted|rolled back/)

    const expected = verifyExpectedAudit(store, { expectedHead: before.headHash })
    assert.equal(expected.ok, false)
    assert.equal(expected.code, 'E_AUDIT_EXPECT_MISMATCH')
    const expectedCount = verifyExpectedAudit(store, { expectedCount: before.count })
    assert.equal(expectedCount.ok, false)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('rewriting the last row at the same count is HEAD_MISMATCH; growth is grown+re-anchor', () => {
  clearAuditKey()
  const { root, home } = makeHome()
  const store = seedStore(home, 3)
  try {
    assert.equal(writeAuditAnchor({ home, store, key: KEY }).ok, true)
    store.db.prepare('DELETE FROM audit WHERE seq = 3').run()
    store.appendAudit({ actor: 'local', action: 'replacement.3', allowed: true, reason: null })
    assert.equal(store.verifyAudit().ok, true, 'fixture: delete+append keeps the chain valid at the same count')
    const mismatch = verifyAuditAgainstAnchor({ home, store, key: KEY })
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.code, 'E_AUDIT_HEAD_MISMATCH')

    // Re-anchor at the new head, then grow: normal growth must not be a failure.
    assert.equal(writeAuditAnchor({ home, store, key: KEY }).ok, true)
    store.appendAudit({ actor: 'local', action: 'growth.one', allowed: true, reason: null })
    store.appendAudit({ actor: 'local', action: 'growth.two', allowed: true, reason: null })
    const grown = verifyAuditAgainstAnchor({ home, store, key: KEY })
    assert.equal(grown.ok, true)
    assert.equal(grown.status, 'grown')
    assert.equal(grown.needsReanchor, true)
    assert.match(grown.warnings.join(' '), /write a fresh anchor/)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('keyed anchors: HMAC tamper and missing-key cases are rejected', () => {
  clearAuditKey()
  const { root, home } = makeHome()
  const store = seedStore(home, 2)
  try {
    assert.equal(writeAuditAnchor({ home, store, key: KEY }).ok, true)
    const path = join(home, AUDIT_ANCHOR_FILE)
    const anchor = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(verifyAuditAnchor({ anchor, head: readAuditHead(store), key: 'wrong-key-wrong-key' }).code, 'E_AUDIT_ANCHOR_HMAC_MISMATCH')
    assert.equal(verifyAuditAgainstAnchor({ home, store }).code, 'E_AUDIT_ANCHOR_KEY_MISSING')

    // Editing a covered field without recomputing the HMAC is detected.
    writeFileSync(path, JSON.stringify({ ...anchor, count: anchor.count + 1 }))
    const tampered = verifyAuditAgainstAnchor({ home, store, key: KEY })
    assert.equal(tampered.ok, false)
    assert.equal(tampered.code, 'E_AUDIT_ANCHOR_HMAC_MISMATCH')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('an unkeyed anchor verifies but is reported as such (honest limitation)', () => {
  clearAuditKey()
  const { root, home } = makeHome()
  const store = seedStore(home, 2)
  try {
    const written = writeAuditAnchor({ home, store, key: null })
    assert.equal(written.ok, true)
    assert.equal(written.keyed, false)
    assert.equal(written.anchor.hmac, null)
    assert.match(written.warnings.join(' '), /unkeyed/)
    const read = readAuditAnchor({ home })
    assert.match(read.warnings.join(' '), /not keyed/)
    const verified = verifyAuditAnchor({ anchor: read.anchor, head: readAuditHead(store), key: null })
    assert.equal(verified.ok, true)
    assert.equal(verified.hmacVerified, false)
    assert.match(verified.warnings.join(' '), /unkeyed/)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('dbId mismatch rejects an anchor copied from a different database', () => {
  clearAuditKey()
  const first = makeHome()
  const second = makeHome()
  const storeA = seedStore(first.home, 2, { actor: 'alice' })
  const storeB = seedStore(second.home, 2, { actor: 'bob' })
  try {
    const written = writeAuditAnchor({ home: first.home, store: storeA, key: KEY })
    assert.equal(written.ok, true)
    const headB = readAuditHead(storeB)
    assert.notEqual(written.anchor.dbId, headB.dbId)
    const result = verifyAuditAnchor({ anchor: written.anchor, head: headB, key: KEY })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'E_AUDIT_ANCHOR_DB_MISMATCH')
  } finally {
    storeA.close(); storeB.close()
    first.cleanup(); second.cleanup()
  }
})

test('absent or malformed anchor is reported without touching the audit chain', () => {
  clearAuditKey()
  const { root, home } = makeHome()
  const store = seedStore(home, 1)
  try {
    const absent = verifyAuditAgainstAnchor({ home, store })
    assert.equal(absent.ok, false)
    assert.equal(absent.found, false)
    assert.equal(absent.code, 'E_AUDIT_ANCHOR_ABSENT')
    assert.equal(store.verifyAudit().ok, true)

    writeFileSync(join(home, AUDIT_ANCHOR_FILE), '{not json')
    const invalid = readAuditAnchor({ home })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.code, 'E_AUDIT_ANCHOR_INVALID')

    writeFileSync(join(home, AUDIT_ANCHOR_FILE), 'x'.repeat(70 * 1024))
    assert.equal(readAuditAnchor({ home }).code, 'E_AUDIT_ANCHOR_TOO_LARGE')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('empty audit anchors at count 0 and later growth is accepted', () => {
  clearAuditKey()
  const { root, home } = makeHome()
  const store = new SqliteStore(join(home, 'state.db'))
  try {
    const empty = readAuditHead(store)
    assert.equal(empty.ok, true)
    assert.equal(empty.count, 0)
    assert.equal(empty.headHash, '')
    const written = writeAuditAnchor({ home, store, key: KEY })
    assert.equal(written.ok, true)
    assert.equal(written.anchor.count, 0)
    assert.equal(written.anchor.headHash, '')
    assert.equal(verifyAuditAgainstAnchor({ home, store, key: KEY }).status, 'match')
    store.appendAudit({ actor: 'local', action: 'first.ever', allowed: true, reason: null })
    const grown = verifyAuditAgainstAnchor({ home, store, key: KEY })
    assert.equal(grown.ok, true)
    assert.equal(grown.status, 'grown')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('restore direction: backups older than the anchor need allowAnchorBehind', () => {
  clearAuditKey()
  const { root, home } = makeHome()
  const store = seedStore(home, 2)
  try {
    const earlyHead = readAuditHead(store)
    store.appendAudit({ actor: 'local', action: 'later.one', allowed: true, reason: null })
    store.appendAudit({ actor: 'local', action: 'later.two', allowed: true, reason: null })
    const lateHead = readAuditHead(store)
    const lateAnchor = buildAuditAnchor({ head: lateHead, key: KEY })
    const earlyAnchor = buildAuditAnchor({ head: earlyHead, key: KEY })

    const behind = verifyRestoreAnchor({ anchor: lateAnchor, head: earlyHead, key: KEY })
    assert.equal(behind.ok, false)
    assert.equal(behind.code, 'E_AUDIT_ANCHOR_BEHIND')
    const allowed = verifyRestoreAnchor({ anchor: lateAnchor, head: earlyHead, key: KEY, allowAnchorBehind: true })
    assert.equal(allowed.ok, true)
    assert.equal(allowed.status, 'behind')
    assert.match(allowed.warnings.join(' '), /older than the audit anchor/)
    assert.equal(verifyRestoreAnchor({ anchor: lateAnchor, head: lateHead, key: KEY }).status, 'match')
    assert.equal(verifyRestoreAnchor({ anchor: earlyAnchor, head: lateHead, key: KEY }).status, 'ahead')
    const forged = { ...lateHead, headHash: '0'.repeat(64) }
    assert.equal(verifyRestoreAnchor({ anchor: lateAnchor, head: forged, key: KEY }).code, 'E_AUDIT_HEAD_MISMATCH')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('writeAuditAnchor refuses to anchor a broken chain', () => {
  clearAuditKey()
  const { root, home } = makeHome()
  const store = seedStore(home, 3)
  try {
    store.db.prepare('DELETE FROM audit WHERE seq = 1').run()
    const result = writeAuditAnchor({ home, store, key: KEY })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'E_AUDIT_CHAIN_BROKEN')
    assert.equal(readAuditAnchor({ home }).found, false)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
test('buildAuditAnchorForStore returns an embeddable anchor without writing a file', () => {
  clearAuditKey()
  const { root, home } = makeHome()
  const store = seedStore(home, 2)
  try {
    const built = buildAuditAnchorForStore({ store, key: KEY, generator: 'advisers/0.3.0-export' })
    assert.equal(built.ok, true)
    assert.equal(built.anchor.count, 2)
    assert.equal(built.keyed, true)
    assert.equal(readAuditAnchor({ home }).found, false, 'export/sync helper does not write the HOME anchor')
    const verified = verifyAuditAnchor({ anchor: built.anchor, head: readAuditHead(store), key: KEY })
    assert.equal(verified.ok, true)
    store.db.prepare("UPDATE audit SET reason = 'tampered' WHERE seq = 1").run()
    const broken = buildAuditAnchorForStore({ store, key: KEY })
    assert.equal(broken.ok, false)
    assert.equal(broken.code, 'E_AUDIT_CHAIN_BROKEN')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
