import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertPrivateMode } from './win-compat.mjs'
import {
  SYNC_STATE_FILE,
  SYNC_STATE_INVALID_CODE,
  SYNC_STATE_VERSION,
  clearSyncState,
  createSyncState,
  normalizeSyncState,
  readSyncState,
  syncStatePath,
  writeSyncState,
} from '../lib/sync-state.js'

// 0.5.0 050-S2 (plan 121 §3 S2.2): `<home>/sync.state.json` is the local sync
// baseline for stale push/pull detection. It must be 0600+atomic, tolerate a
// missing/corrupt/newer file without failing a sync command, never trust a
// partial entry, and be clearable after import/restore.

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const AT = '2026-11-01T00:00:00.000Z'

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'advisers-sync-state-'))
}

function makeHome(root) {
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return home
}

function sampleState() {
  return {
    version: SYNC_STATE_VERSION,
    device: 'laptop',
    localSchemaVersion: 22,
    lastPull: {
      file: 'advisers-desktop-20261101T000000Z.enc.json',
      sha256: SHA_A,
      createdAt: AT,
      sourceDevice: 'desktop',
      localDbSha256: SHA_A,
      at: AT,
    },
    lastPush: { file: 'advisers-laptop-20261102T000000Z.enc.json', sha256: SHA_B, dbSha256: SHA_B, at: '2026-11-02T00:00:00.000Z' },
  }
}

test('syncStatePath and createSyncState expose the documented shape', () => {
  const state = createSyncState({ device: 'laptop', localSchemaVersion: 22 })
  assert.equal(state.version, SYNC_STATE_VERSION)
  assert.equal(state.device, 'laptop')
  assert.equal(state.localSchemaVersion, 22)
  assert.equal(state.lastPull, null)
  assert.equal(state.lastPush, null)
  assert.equal(syncStatePath({ home: '/tmp/x' }), join('/tmp/x', SYNC_STATE_FILE))
  assert.throws(() => syncStatePath({}), /requires \{home\}/)
})

test('readSyncState: a missing baseline is a normal first sync', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root)
    const read = readSyncState({ home })
    assert.equal(read.ok, true)
    assert.equal(read.exists, false)
    assert.equal(read.state, null)
    assert.equal(read.path, join(home, SYNC_STATE_FILE))
    assert.deepEqual(read.warnings, [])
    assert.equal(existsSync(syncStatePath({ home })), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('writeSyncState writes 0600 atomically and readSyncState round-trips it', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root)
    const written = writeSyncState({ home, state: sampleState() })
    assert.equal(written.ok, true, JSON.stringify(written.errors))
    const file = join(home, SYNC_STATE_FILE)
    assert.ok(existsSync(file))
    assertPrivateMode(file, 0o600, 'sync.state.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.version, SYNC_STATE_VERSION)
    const read = readSyncState({ home })
    assert.equal(read.ok, true)
    assert.equal(read.exists, true)
    assert.equal(read.code, null)
    assert.equal(read.state.device, 'laptop')
    assert.equal(read.state.lastPull.sha256, SHA_A)
    assert.equal(read.state.lastPull.localDbSha256, SHA_A)
    assert.equal(read.state.lastPush.dbSha256, SHA_B)
    assert.deepEqual(read.state, sampleState())
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readSyncState tolerates corrupt JSON and a newer version without failing the command', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root)
    writeFileSync(syncStatePath({ home }), '{not json')
    const corrupt = readSyncState({ home })
    assert.equal(corrupt.ok, true, 'a corrupt baseline must not make a sync command fail')
    assert.equal(corrupt.exists, true)
    assert.equal(corrupt.state, null)
    assert.equal(corrupt.code, SYNC_STATE_INVALID_CODE)
    assert.ok(corrupt.warnings.some((warning) => /not valid JSON/.test(warning)))
    writeFileSync(syncStatePath({ home }), JSON.stringify({ version: 99, device: 'future' }))
    const newer = readSyncState({ home })
    assert.equal(newer.ok, true)
    assert.equal(newer.state, null)
    assert.equal(newer.code, SYNC_STATE_INVALID_CODE)
    assert.ok(newer.warnings.some((warning) => /version 99/.test(warning)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('normalizeSyncState keeps valid entries, drops a malformed one and unknown fields', () => {
  const normalized = normalizeSyncState({
    version: SYNC_STATE_VERSION,
    device: '  laptop  ',
    localSchemaVersion: '22',
    unknownField: 'ignored',
    lastPush: { file: 'a.enc.json', sha256: SHA_B, dbSha256: 'nope', at: 'not-a-date' },
    lastPull: { file: 'b.enc.json', sha256: 'too-short' },
  })
  assert.equal(normalized.ok, true)
  assert.equal(normalized.state.device, 'laptop')
  assert.equal(normalized.state.localSchemaVersion, 22)
  assert.equal('unknownField' in normalized.state, false)
  assert.equal(normalized.state.lastPull, null, 'a lastPull without a valid sha256 is dropped')
  assert.equal(normalized.state.lastPush.file, 'a.enc.json')
  assert.equal(normalized.state.lastPush.dbSha256, null, 'an invalid dbSha256 becomes null')
  assert.equal(normalized.state.lastPush.at, null, 'an invalid timestamp becomes null')
  assert.ok(normalized.warnings.length >= 2)
  assert.equal(normalizeSyncState(null).ok, false)
  assert.equal(normalizeSyncState([]).ok, false)
  assert.equal(normalizeSyncState({ version: 2 }).state, null)
})

test('writeSyncState refuses malformed state and leaves the existing file untouched', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root)
    assert.equal(writeSyncState({ home, state: sampleState() }).ok, true)
    const before = readFileSync(syncStatePath({ home }), 'utf8')
    const rejected = writeSyncState({ home, state: { version: 99, device: 'future' } })
    assert.equal(rejected.ok, false)
    assert.ok(rejected.errors.length >= 1)
    assert.equal(readFileSync(syncStatePath({ home }), 'utf8'), before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('clearSyncState removes the baseline and is idempotent', () => {
  const root = makeRoot()
  try {
    const home = makeHome(root)
    assert.equal(writeSyncState({ home, state: sampleState() }).ok, true)
    const cleared = clearSyncState({ home })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.removed, true)
    assert.equal(existsSync(syncStatePath({ home })), false)
    const again = clearSyncState({ home })
    assert.equal(again.ok, true)
    assert.equal(again.removed, false)
    assert.equal(clearSyncState({}).ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})