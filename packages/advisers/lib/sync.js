/**
 * P2: file-based end-to-end encrypted snapshot sync.
 *
 * The user chooses a directory that their existing sync tool (OneDrive, Dropbox,
 * Syncthing, rsync, a NAS) already replicates. Advisers only writes encrypted
 * snapshots there and never talks to a sync server itself.
 *
 * Scope: whole-database snapshots, manual push/pull, last-snapshot-wins.
 * Not provided: continuous merge, multi-writer conflict resolution, cloud accounts.
 * Pull always backs up the local DB before replacing it.
 */
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { decryptJson, encryptJson, isVaultEnvelope } from './vault.js'

/** fsync a directory entry so a rename survives a crash. */
function fsyncDir(dir) {
  try {
    const fd = openSync(dir, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  } catch {}
}

/** Write a same-directory temp file, flush it, then rename it into place. */
function writeAtomic(file, data, { mode = 0o600 } = {}) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    writeFileSync(tmp, data, { mode, flush: true })
    renameSync(tmp, file)
  } catch (error) {
    try { if (existsSync(tmp)) rmSync(tmp) } catch {}
    throw error
  }
  try { chmodSync(file, mode) } catch {}
  fsyncDir(join(file, '..'))
}

export const SYNC_PREFIX = 'advisers-'
export const SYNC_SUFFIX = '.enc.json'

export function sanitizeDevice(value) {
  return String(value || 'device').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'device'
}

export function snapshotName(device, date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `${SYNC_PREFIX}${sanitizeDevice(device)}-${stamp}${SYNC_SUFFIX}`
}

export function createSnapshot({ dbPath, passphrase, device = 'device', createdAt = new Date() }) {
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`)
  const bytes = readFileSync(dbPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const payload = { kind: 'advisers-sync-db', version: 1, device: sanitizeDevice(device), createdAt: createdAt.toISOString(), sha256, db: bytes.toString('base64') }
  return { name: snapshotName(device, createdAt), payload, envelope: encryptJson(payload, passphrase) }
}

export function listSnapshots(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.startsWith(SYNC_PREFIX) && n.endsWith(SYNC_SUFFIX))
    .map((name) => { const st = statSync(join(dir, name)); return { name, mtimeMs: st.mtimeMs, bytes: st.size } })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function pushSnapshot({ dir, dbPath, passphrase, device = 'device', createdAt = new Date() }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const snap = createSnapshot({ dbPath, passphrase, device, createdAt })
  const out = join(dir, snap.name)
  const body = JSON.stringify(snap.envelope) + '\n'
  writeAtomic(out, body, { mode: 0o600 })
  return { file: out, sha256: snap.payload.sha256, bytes: Buffer.byteLength(body) }
}

function latestDbMtime(dbPath) {
  let latest = 0
  for (const suffix of ['', '-wal']) {
    try { latest = Math.max(latest, statSync(dbPath + suffix).mtimeMs) } catch {}
  }
  return latest
}

/**
 * Replace the local database with the chosen snapshot.
 *
 * Safety (robustness audit P1-4): when the local database was written after
 * the snapshot was taken on *another* device, overwriting it would silently
 * drop those writes. Refuse unless force:true. A snapshot pushed from this
 * HOME (device marker matches payload.device) is treated as an intentional
 * restore, and no local database at all is always allowed.
 */
export function pullSnapshot({ dir, dbPath, passphrase, file, force = false, localMtimeMs, localDevice }) {
  const snapshots = listSnapshots(dir)
  if (!snapshots.length) throw new Error(`no Advisers snapshots in ${dir}`)
  const chosen = file ? snapshots.find((s) => s.name === basename(file)) : snapshots[0]
  if (!chosen) throw new Error(`snapshot not found: ${file}`)
  const envelope = JSON.parse(readFileSync(join(dir, chosen.name), 'utf8'))
  if (!isVaultEnvelope(envelope)) throw new Error('snapshot is not an Advisers encrypted envelope')
  const payload = decryptJson(envelope, passphrase)
  if (payload.kind !== 'advisers-sync-db' || typeof payload.db !== 'string') throw new Error('snapshot is not an Advisers database snapshot')
  const bytes = Buffer.from(payload.db, 'base64')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== payload.sha256) throw new Error('snapshot checksum mismatch')
  if (existsSync(dbPath) && !force) {
    if (readFileSync(dbPath).equals(bytes)) return { file: chosen.name, sha256, changed: false, backup: null }
    const snapshotAt = Date.parse(payload.createdAt ?? '')
    const localAt = Number.isFinite(localMtimeMs) && localMtimeMs > 0 ? localMtimeMs : latestDbMtime(dbPath)
    const sameDevice = Boolean(localDevice) && Boolean(payload.device) && sanitizeDevice(payload.device) === sanitizeDevice(localDevice)
    if (!sameDevice) {
      if (!Number.isFinite(snapshotAt)) throw new Error(`cannot tell whether the local database is newer than ${chosen.name} (snapshot has no valid createdAt); re-run with --force to overwrite and keep a backup`)
      if (localAt > snapshotAt) throw new Error(`local database was written after snapshot ${chosen.name} (local ${new Date(localAt).toISOString()} > snapshot ${new Date(snapshotAt).toISOString()}); refusing to overwrite. If those local writes matter, back them up/export them first; re-run with --force to overwrite anyway (a backup is kept).`)
    }
  }
  let backup = null
  if (existsSync(dbPath)) {
    backup = `${dbPath}.before-sync-${Date.now()}`
    copyFileSync(dbPath, backup)
    for (const suffix of ['-wal', '-shm']) {
      try { if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, backup + suffix) } catch {}
    }
    for (const suffix of ['-wal', '-shm']) { try { rmSync(dbPath + suffix) } catch {} }
  } else {
    mkdirSync(join(dbPath, '..'), { recursive: true, mode: 0o700 })
  }
  writeAtomic(dbPath, bytes, { mode: 0o600 })
  return { file: chosen.name, sha256, changed: true, backup, device: payload.device, createdAt: payload.createdAt }
}
