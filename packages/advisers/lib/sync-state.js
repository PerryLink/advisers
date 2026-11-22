/**
 * Local sync baseline for stale push/pull conflict detection (Advisers 0.5.0,
 * plan 121 §3 S2.2 / 126 050-S2).
 *
 * 0.4.3 stored only `$HOME/sync.device` (one line, 0600) and made every push/pull
 * decision from the current files. A device that had not pulled since another
 * device advanced could therefore push an outdated database, or silently replace
 * its own newer local writes with a remote snapshot (keeping only a backup).
 * This module persists a small local baseline at `<home>/sync.state.json`:
 *
 *   {
 *     "version": 1,
 *     "device": "laptop",
 *     "localSchemaVersion": 22,
 *     "lastPull": { file, sha256, createdAt, sourceDevice, localDbSha256, at } | null,
 *     "lastPush": { file, sha256, dbSha256, at } | null
 *   }
 *
 * Rules:
 * - reading is tolerant: a missing file is a normal first sync; a corrupt or
 *   newer-version file yields `state:null` + a warning, never an exception, so a
 *   sync command degrades to 0.4.3 behaviour instead of failing on bookkeeping;
 * - writing is 0600 + atomic (temp file + fsync + rename through lib/fs-safe);
 * - the file never enters backup/export/bundle (PRIVACY lists it separately);
 * - `clearSyncState()` runs after `import`/`restore` replaced the whole ledger.
 *
 * Library-only: no bin/ wiring, no network, no new dependency.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync, rmWithRetrySync } from './fs-safe.js'

/** File name inside $ADVISERS_HOME. */
export const SYNC_STATE_FILE = 'sync.state.json'
/** On-disk state schema version (additive fields only; bump on removing fields). */
export const SYNC_STATE_VERSION = 1
/** Error code returned when a state file exists but cannot be trusted. */
export const SYNC_STATE_INVALID_CODE = 'E_SYNC_STATE_INVALID'

function sha256OrNull(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null
}

function isoOrNull(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function deviceOrNull(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 64) : null
}

function schemaVersionOrNull(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : null
}

function fileNameOrNull(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 512) : null
}

/** Absolute path of the baseline file. */
export function syncStatePath({ home } = {}) {
  if (!home) throw new TypeError('syncStatePath requires {home}')
  return join(home, SYNC_STATE_FILE)
}

/** A fresh empty baseline. */
export function createSyncState({ device = null, localSchemaVersion = null } = {}) {
  return {
    version: SYNC_STATE_VERSION,
    device: deviceOrNull(device),
    localSchemaVersion: schemaVersionOrNull(localSchemaVersion),
    lastPull: null,
    lastPush: null,
  }
}

/**
 * Validate/normalize a parsed baseline. Pure (no filesystem access).
 * Unknown fields are dropped; malformed `lastPull`/`lastPush` entries are
 * dropped with a warning instead of failing the whole file, so one bad field
 * cannot make the baseline unusable.
 */
export function normalizeSyncState(value) {
  const result = { ok: false, code: null, state: null, warnings: [], errors: [] }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    result.code = SYNC_STATE_INVALID_CODE
    result.warnings.push('the sync baseline is not a JSON object; ignoring it')
    return result
  }
  const version = Number(value.version)
  if (version !== SYNC_STATE_VERSION) {
    result.code = SYNC_STATE_INVALID_CODE
    result.warnings.push('the sync baseline version ' + String(value.version) + ' is not ' + SYNC_STATE_VERSION + '; ignoring it')
    return result
  }
  const state = {
    version: SYNC_STATE_VERSION,
    device: deviceOrNull(value.device),
    localSchemaVersion: schemaVersionOrNull(value.localSchemaVersion),
    lastPull: null,
    lastPush: null,
  }
  if (value.lastPull !== undefined && value.lastPull !== null) {
    const entry = value.lastPull
    const file = typeof entry === 'object' && !Array.isArray(entry) ? fileNameOrNull(entry.file) : null
    const sha256 = typeof entry === 'object' && !Array.isArray(entry) ? sha256OrNull(entry.sha256) : null
    if (!file || !sha256) {
      result.warnings.push('the sync baseline lastPull entry is malformed; ignoring it')
    } else {
      state.lastPull = {
        file,
        sha256,
        createdAt: isoOrNull(entry.createdAt),
        sourceDevice: deviceOrNull(entry.sourceDevice),
        localDbSha256: sha256OrNull(entry.localDbSha256),
        at: isoOrNull(entry.at),
      }
      if (state.lastPull.at === null) result.warnings.push('the sync baseline lastPull entry has no valid timestamp; conflict ordering is degraded')
    }
  }
  if (value.lastPush !== undefined && value.lastPush !== null) {
    const entry = value.lastPush
    const file = typeof entry === 'object' && !Array.isArray(entry) ? fileNameOrNull(entry.file) : null
    const sha256 = typeof entry === 'object' && !Array.isArray(entry) ? sha256OrNull(entry.sha256) : null
    if (!file || !sha256) {
      result.warnings.push('the sync baseline lastPush entry is malformed; ignoring it')
    } else {
      state.lastPush = {
        file,
        sha256,
        dbSha256: sha256OrNull(entry.dbSha256),
        at: isoOrNull(entry.at),
      }
      if (state.lastPush.at === null) result.warnings.push('the sync baseline lastPush entry has no valid timestamp; conflict ordering is degraded')
    }
  }
  result.ok = true
  result.state = state
  return result
}

/**
 * Read the baseline. `{ok:true, exists:false, state:null}` when absent; a
 * corrupt/newer file returns `ok:true, state:null, code:E_SYNC_STATE_INVALID`
 * plus warnings (callers degrade, they do not fail).
 */
export function readSyncState({ home } = {}) {
  const result = { ok: false, exists: false, path: null, state: null, code: null, warnings: [], errors: [] }
  if (!home) { result.errors.push('readSyncState requires {home}'); return result }
  const path = syncStatePath({ home })
  result.path = path
  if (!existsSync(path)) { result.ok = true; return result }
  result.exists = true
  let text = null
  try { text = readFileSync(path, 'utf8') } catch (error) {
    result.ok = true
    result.code = SYNC_STATE_INVALID_CODE
    result.warnings.push('cannot read the sync baseline ' + path + ': ' + String(error?.code ?? error?.message ?? error) + '; conflict detection is degraded')
    return result
  }
  let parsed = null
  try { parsed = JSON.parse(text) } catch (error) {
    result.ok = true
    result.code = SYNC_STATE_INVALID_CODE
    result.warnings.push('the sync baseline ' + path + ' is not valid JSON; ignoring it')
    return result
  }
  const normalized = normalizeSyncState(parsed)
  result.warnings.push(...normalized.warnings)
  if (!normalized.ok) { result.ok = true; result.code = normalized.code ?? SYNC_STATE_INVALID_CODE; return result }
  result.ok = true
  result.state = normalized.state
  return result
}

/** Atomically write the baseline (0600). Refuses malformed state. */
export function writeSyncState({ home, state } = {}) {
  const result = { ok: false, path: null, state: null, code: null, warnings: [], errors: [] }
  if (!home) { result.errors.push('writeSyncState requires {home}'); return result }
  const normalized = normalizeSyncState(state)
  result.path = syncStatePath({ home })
  result.warnings.push(...normalized.warnings)
  if (!normalized.ok) {
    result.code = normalized.code ?? SYNC_STATE_INVALID_CODE
    result.errors.push('refusing to write an invalid sync baseline')
    return result
  }
  try {
    atomicWriteFileSync(result.path, JSON.stringify(normalized.state, null, 2) + '\n', { mode: 0o600 })
    result.ok = true
    result.state = normalized.state
  } catch (error) {
    result.errors.push('cannot write the sync baseline ' + result.path + ': ' + String(error?.message ?? error).slice(0, 200))
  }
  return result
}

/** Remove the baseline (after import/restore replaced the whole ledger). Idempotent. */
export function clearSyncState({ home } = {}) {
  const result = { ok: false, removed: false, path: null, warnings: [], errors: [] }
  if (!home) { result.errors.push('clearSyncState requires {home}'); return result }
  const path = syncStatePath({ home })
  result.path = path
  if (!existsSync(path)) { result.ok = true; return result }
  try {
    rmWithRetrySync(path)
    result.ok = true
    result.removed = true
  } catch (error) {
    result.errors.push('cannot remove the sync baseline ' + path + ': ' + String(error?.message ?? error).slice(0, 200))
  }
  return result
}