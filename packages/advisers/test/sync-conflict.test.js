import assert from 'node:assert/strict'
import test from 'node:test'
import { computeSyncConflict, summarizeSyncBaseline } from '../lib/sync.js'

// 0.5.0 050-S2 (plan 121 §3 S2.3): the conflict decision is a pure function so
// every unknown input is reported as null/degraded instead of pretending the
// sync was checked. A conflict exists only when BOTH the local database and the
// remote snapshot moved since the last sync AND the newest snapshot came from a
// different device; same-device snapshots stay allowed (0.4.3 restore semantics).

const LOCAL_1 = '1'.repeat(64)
const LOCAL_2 = '2'.repeat(64)
const REMOTE_1 = '3'.repeat(64)
const REMOTE_2 = '4'.repeat(64)
const AT = '2026-11-01T00:00:00.000Z'

function baseline({ lastPush = null, lastPull = null } = {}) {
  return { version: 1, device: 'laptop', localSchemaVersion: 22, lastPush, lastPull }
}

function pushEvent({ localSha = LOCAL_1, remoteSha = REMOTE_1, at = AT } = {}) {
  return { file: 'advisers-laptop.enc.json', sha256: remoteSha, dbSha256: localSha, at }
}

function pullEvent({ localSha = LOCAL_1, remoteSha = REMOTE_1, at = AT } = {}) {
  return { file: 'advisers-desktop.enc.json', sha256: remoteSha, createdAt: AT, sourceDevice: 'desktop', localDbSha256: localSha, at }
}

function newest(sha = REMOTE_1, device = 'desktop') {
  return { file: 'advisers-desktop.enc.json', sha256: sha, device, createdAt: AT }
}

test('computeSyncConflict: no baseline is degraded, never "clear"', () => {
  const result = computeSyncConflict({ localDbSha256: LOCAL_2, localWalBytes: 0, baseline: null, newest: newest(REMOTE_2), sameDevice: false })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'degraded')
  assert.equal(result.conflict, null)
  assert.equal(result.localChanged, null)
  assert.equal(result.remoteAdvanced, null)
  assert.ok(result.warnings.some((warning) => /no sync baseline/.test(warning)))
})

test('computeSyncConflict: unchanged local + unchanged remote is clear', () => {
  const result = computeSyncConflict({ localDbSha256: LOCAL_1, localWalBytes: 0, baseline: baseline({ lastPush: pushEvent() }), newest: newest(REMOTE_1), sameDevice: true })
  assert.equal(result.status, 'clear')
  assert.equal(result.conflict, false)
  assert.equal(result.localChanged, false)
  assert.equal(result.remoteAdvanced, false)
})

test('computeSyncConflict: only the local database changed is clear (a normal push)', () => {
  const result = computeSyncConflict({ localDbSha256: LOCAL_2, localWalBytes: 0, baseline: baseline({ lastPush: pushEvent() }), newest: newest(REMOTE_1), sameDevice: true })
  assert.equal(result.status, 'clear')
  assert.equal(result.conflict, false)
  assert.equal(result.localChanged, true)
  assert.equal(result.remoteAdvanced, false)
})

test('computeSyncConflict: only the remote advanced is clear for the comparison', () => {
  const result = computeSyncConflict({ localDbSha256: LOCAL_1, localWalBytes: 0, baseline: baseline({ lastPull: pullEvent() }), newest: newest(REMOTE_2, 'desktop'), sameDevice: false })
  assert.equal(result.status, 'clear')
  assert.equal(result.conflict, false)
  assert.equal(result.localChanged, false)
  assert.equal(result.remoteAdvanced, true)
})

test('computeSyncConflict: both sides changed AND another device pushed is a conflict', () => {
  const result = computeSyncConflict({ localDbSha256: LOCAL_2, localWalBytes: 0, baseline: baseline({ lastPull: pullEvent() }), newest: newest(REMOTE_2, 'desktop'), sameDevice: false })
  assert.equal(result.status, 'conflict')
  assert.equal(result.conflict, true)
  assert.equal(result.localChanged, true)
  assert.equal(result.remoteAdvanced, true)
  assert.equal(result.sameDevice, false)
  assert.match(result.reason, /silently discard one side/)
})

test('computeSyncConflict: both sides changed but the newest snapshot is ours is not a conflict', () => {
  const result = computeSyncConflict({ localDbSha256: LOCAL_2, localWalBytes: 0, baseline: baseline({ lastPush: pushEvent() }), newest: newest(REMOTE_2, 'laptop'), sameDevice: true })
  assert.equal(result.status, 'clear')
  assert.equal(result.conflict, false)
  assert.ok(result.warnings.some((warning) => /pushed by this device/.test(warning)))
})

test('computeSyncConflict: both sides changed with an unknown device is degraded, not a conflict', () => {
  const result = computeSyncConflict({ localDbSha256: LOCAL_2, localWalBytes: 0, baseline: baseline({ lastPull: pullEvent() }), newest: newest(REMOTE_2, null), sameDevice: null })
  assert.equal(result.status, 'degraded')
  assert.equal(result.conflict, null)
  assert.ok(result.warnings.some((warning) => /device name is unknown/.test(warning)))
})

test('computeSyncConflict: a non-empty WAL makes the local side unknown', () => {
  const result = computeSyncConflict({ localDbSha256: null, localWalBytes: 4096, baseline: baseline({ lastPull: pullEvent() }), newest: newest(REMOTE_2, 'desktop'), sameDevice: false })
  assert.equal(result.status, 'degraded')
  assert.equal(result.conflict, null)
  assert.equal(result.localChanged, null)
  assert.equal(result.remoteAdvanced, true)
  assert.ok(result.warnings.some((warning) => /WAL still holds/.test(warning)))
})

test('computeSyncConflict: missing baseline hashes / remote snapshot degrade instead of guessing', () => {
  const noLocalHash = computeSyncConflict({
    localDbSha256: LOCAL_2,
    localWalBytes: 0,
    baseline: baseline({ lastPush: { file: 'a.enc.json', sha256: REMOTE_1, at: AT } }),
    newest: newest(REMOTE_1, 'laptop'),
    sameDevice: true,
  })
  assert.equal(noLocalHash.localChanged, null)
  assert.equal(noLocalHash.status, 'degraded')
  const noRemote = computeSyncConflict({ localDbSha256: LOCAL_1, localWalBytes: 0, baseline: baseline({}), newest: null, sameDevice: null })
  assert.equal(noRemote.remoteAdvanced, null)
  assert.equal(noRemote.status, 'degraded')
  const badRemoteSha = computeSyncConflict({ localDbSha256: LOCAL_1, localWalBytes: 0, baseline: baseline({ lastPush: pushEvent() }), newest: { file: 'x.enc.json', sha256: 'nope' }, sameDevice: true })
  assert.equal(badRemoteSha.remoteAdvanced, null)
})

test('summarizeSyncBaseline picks the newest event and exposes both timestamps', () => {
  const summary = summarizeSyncBaseline(baseline({
    lastPull: pullEvent({ at: '2026-11-01T00:00:00.000Z', remoteSha: REMOTE_1 }),
    lastPush: pushEvent({ at: '2026-11-02T00:00:00.000Z', remoteSha: REMOTE_2 }),
  }))
  assert.equal(summary.kind, 'push')
  assert.equal(summary.remoteSha256, REMOTE_2)
  assert.equal(summary.lastPushAt, '2026-11-02T00:00:00.000Z')
  assert.equal(summary.lastPullAt, '2026-11-01T00:00:00.000Z')
  assert.equal(summarizeSyncBaseline(null), null)
  assert.equal(summarizeSyncBaseline({ version: 1 }), null)
})