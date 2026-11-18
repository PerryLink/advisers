import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectWalStatus, SqliteStore, WAL_CORRUPT_SUFFIX } from '../lib/sqlite.js'

// 0.2.3 robustness Phase 0 (robustness audit 2026-11-17 P1-6): SQLite treats an
// invalid or torn WAL as empty and opens successfully, silently dropping
// committed transactions that only lived in the WAL. The pre-open check must
// classify the sidecar, preserve the bytes and warn -- never stay silent.

function frameSizeOf(walBytes) {
  return 24 + walBytes.readUInt32BE(8)
}

/**
 * Build a database whose second committed turn only lives in a non-checkpointed
 * WAL: the main file is copied after the first (checkpointed) commit, the WAL
 * after the second commit, before the writer closes (closing would checkpoint).
 */
function createWalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'advisers-wal-recovery-'))
  const source = join(root, 'source.db')
  const first = new SqliteStore(source)
  try {
    first.addTurn({ conversationId: 'c1', role: 'user', content: 'committed before the crash' })
  } finally { first.close() }
  const writer = new SqliteStore(source)
  let mainBytes
  let walBytes
  try {
    writer.db.exec('PRAGMA wal_autocheckpoint = 0')
    writer.addTurn({ conversationId: 'c1', role: 'user', content: 'committed only in the WAL' })
    mainBytes = readFileSync(source)
    walBytes = readFileSync(`${source}-wal`)
  } finally { writer.close() }
  const fixture = (name) => {
    const file = join(root, name)
    writeFileSync(file, mainBytes)
    writeFileSync(`${file}-wal`, walBytes)
    return file
  }
  return { root, fixture, wallBytes: walBytes, frameSize: frameSizeOf(walBytes) }
}

function corruptBackupsIn(root) {
  return readdirSync(root).filter((name) => name.includes(WAL_CORRUPT_SUFFIX))
}

test('inspectWalStatus classifies absent/empty/valid/truncated-header WAL files', () => {
  const { root, fixture } = createWalFixture()
  try {
    assert.equal(inspectWalStatus(join(root, 'no-such.db')).status, 'absent')
    const empty = join(root, 'empty.db')
    writeFileSync(empty, 'x')
    writeFileSync(`${empty}-wal`, Buffer.alloc(0))
    assert.equal(inspectWalStatus(empty).status, 'empty')
    const valid = fixture('valid.db')
    const report = inspectWalStatus(valid)
    assert.equal(report.status, 'ok')
    assert.equal(report.present, true)
    assert.ok(report.frames > 0, 'the fixture WAL must contain at least one frame')
    assert.equal(report.pageSize, 4096)
    assert.equal(report.warning, null)
    const shortHeader = join(root, 'short-header.db')
    writeFileSync(shortHeader, 'x')
    writeFileSync(`${shortHeader}-wal`, Buffer.alloc(10, 0xab))
    const shortReport = inspectWalStatus(shortHeader)
    assert.equal(shortReport.status, 'invalid')
    assert.match(shortReport.reason, /truncated header/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a valid WAL recovers its committed row without warnings or quarantine', () => {
  const { root, fixture } = createWalFixture()
  try {
    const file = fixture('control.db')
    const store = new SqliteStore(file)
    try {
      assert.equal(store.walStatus.status, 'ok')
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 2, 'the WAL-only commit is recovered')
      assert.deepEqual(corruptBackupsIn(root), [], 'a valid WAL is never touched or copied')
      const report = store.integrityReport({ quickCheck: true, fts: false })
      assert.equal(report.ok, true)
      assert.equal(report.wal.ok, true)
      assert.equal(report.quickCheck.verdict, 'ok')
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a WAL with a zeroed header is preserved, quarantined and loudly reported (no silent loss)', () => {
  const { root, fixture } = createWalFixture()
  try {
    const file = fixture('corrupt-header.db')
    const walPath = `${file}-wal`
    const corrupted = Buffer.from(readFileSync(walPath))
    corrupted.fill(0, 0, 32)
    writeFileSync(walPath, corrupted)
    assert.equal(inspectWalStatus(file).status, 'invalid')

    const store = new SqliteStore(file)
    try {
      assert.equal(store.walStatus.status, 'invalid')
      assert.equal(store.walStatus.quarantined, true)
      assert.match(store.walStatus.warning, /E_WAL_CORRUPT/)
      assert.match(store.walStatus.warning, /may be lost/)
      assert.ok(store.walStatus.backup, 'the corrupt WAL must be preserved')
      assert.deepEqual(readFileSync(store.walStatus.backup), corrupted, 'the preserved bytes are the evidence')
      assert.equal(store.walStatus.recovery.quickCheck, 'ok', 'the surviving main database is still structurally valid')
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 1, 'the WAL-only row is lost because SQLite ignores an invalid WAL...')
      assert.equal(store.integrityReport({ quickCheck: true }).ok, false, '...and doctor must see that something happened')
    } finally { store.close() }
    assert.equal(readdirSync(root).some((name) => name === 'corrupt-header.db-wal'), false, 'the unusable WAL was moved aside, not left to confuse the next open')
    assert.equal(corruptBackupsIn(root).length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a WAL with a torn final frame is copied as evidence and reported as truncated', () => {
  const { root, fixture, wallBytes } = createWalFixture()
  try {
    const file = fixture('torn-tail.db')
    const walPath = `${file}-wal`
    const torn = wallBytes.subarray(0, wallBytes.length - 100)
    writeFileSync(walPath, torn)
    const inspection = inspectWalStatus(file)
    assert.equal(inspection.status, 'truncated')
    assert.match(inspection.warning, /E_WAL_TRUNCATED/)

    const store = new SqliteStore(file)
    try {
      assert.equal(store.walStatus.status, 'truncated')
      assert.match(store.walStatus.warning, /E_WAL_TRUNCATED/)
      assert.ok(store.walStatus.backup, 'the torn WAL must be preserved as evidence')
      assert.deepEqual(readFileSync(store.walStatus.backup), torn)
      const rows = store.db.prepare('SELECT COUNT(*) AS n FROM turns').get().n
      assert.ok(rows >= 1 && rows <= 2, `unexpected recovered row count ${rows}`)
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a header shorter than 32 bytes is quarantined like an invalid WAL', () => {
  const { root, fixture } = createWalFixture()
  try {
    const file = fixture('tiny-header.db')
    writeFileSync(`${file}-wal`, Buffer.alloc(10, 0x7f))
    assert.equal(inspectWalStatus(file).status, 'invalid')
    const store = new SqliteStore(file)
    try {
      assert.equal(store.walStatus.quarantined, true)
      assert.equal(store.walStatus.backup !== null, true)
    } finally { store.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
