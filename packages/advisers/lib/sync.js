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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { decryptJson, encryptJson, isVaultEnvelope } from './vault.js'

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
  const tmp = `${out}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(snap.envelope) + '\n', { mode: 0o600 })
  renameSync(tmp, out)
  try { chmodSync(out, 0o600) } catch {}
  return { file: out, sha256: snap.payload.sha256, bytes: Buffer.byteLength(JSON.stringify(snap.envelope)) }
}

export function pullSnapshot({ dir, dbPath, passphrase, file, force = false }) {
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
  if (existsSync(dbPath) && !force && readFileSync(dbPath).equals(bytes)) {
    return { file: chosen.name, sha256, changed: false, backup: null }
  }
  let backup = null
  if (existsSync(dbPath)) {
    backup = `${dbPath}.before-sync-${Date.now()}`
    copyFileSync(dbPath, backup)
    for (const suffix of ['-wal', '-shm']) { try { rmSync(dbPath + suffix) } catch {} }
  } else {
    mkdirSync(join(dbPath, '..'), { recursive: true, mode: 0o700 })
  }
  const tmp = `${dbPath}.sync-tmp-${process.pid}`
  writeFileSync(tmp, bytes, { mode: 0o600 })
  renameSync(tmp, dbPath)
  try { chmodSync(dbPath, 0o600) } catch {}
  return { file: chosen.name, sha256, changed: true, backup, device: payload.device, createdAt: payload.createdAt }
}
