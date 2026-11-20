// ---------------------------------------------------------------------------
// Read-only ledger facade (0.3.0 exported subpath `advisers/lib/ledger-read.js`).
//
// This is the single read-policy entry point for consumers that are NOT the
// CLI writer path (the DSH adapter today; MCP/pet-brief/other readers later).
// It opens the local ledger READ-ONLY and never becomes a writer:
//
//   - no top-level `node:sqlite` import; sqlite is loaded lazily so a host
//     without `node:sqlite` (e.g. an Electron renderer) can still import this
//     module and receive a stable E_LEDGER_UNAVAILABLE instead of a load crash;
//   - readOnly connection + assertSchemaCurrent only: no migrations, no DDL,
//     no journal-mode pragmas, no checkpoint/vacuum;
//   - no HOME instance lock, no HOME directory creation, no DB writes;
//   - TOS gate: an existing acceptance record for the packaged TOS version and
//     text hash is REQUIRED. This module never writes an acceptance record and
//     deliberately ignores the ADVISERS_TOS_VERSION env override when deciding
//     (an env var must not be able to fake consent);
//   - deterministic, consumer-facing error codes (E_LEDGER_ABSENT /
//     E_TOS_REQUIRED / E_VAULT_SEALED / E_SCHEMA_STALE / E_SCHEMA_NEWER /
//     E_LEDGER_UNAVAILABLE / E_LEDGER_CORRUPT / E_LEDGER_BUSY / E_USAGE) with
//     an actionable `hint` that never contains an absolute filesystem path;
//   - every call opens and closes its own short read transaction, so a vault
//     unseal / sync pull inode replacement and a concurrent writer are safe;
//   - per-item clearance (default 0, fail closed): rows whose matter.secrecy
//     is above the clearance are excluded and only counted, never partially
//     returned;
//   - customer reads (0.3.2 M3): the client list/status projection is derived by
//     lib/customer-read.js inside one read snapshot; customer entities are
//     SQLite-only, so a JSON backend reports customerEntities:false and an
//     empty list instead of inventing rows.
//
// The API is a versioned contract (docs/LEDGER-READ-API.md): 0.x versions only
// add fields/signatures; existing names, shapes and error codes stay stable.
// ---------------------------------------------------------------------------
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { listClientRows, readClientStatus } from './customer-read.js'
import { secrecyLevel } from './egress.js'
import { evidenceRecordSecrecy } from './evidence.js'

/** File name of the SQLite ledger inside an Advisers home. */
export const LEDGER_DB_FILE = 'state.db'
/** File name of the legacy JSON ledger inside an Advisers home. */
export const LEDGER_JSON_FILE = 'state.json'
/** Suffix of a sealed (encrypted) vault that replaced the plaintext database. */
export const LEDGER_VAULT_SUFFIX = '.vault'

/** Ledger table names understood by the wire snapshot (`Ledger.fromJSON`). */
const WIRE_TABLES = Object.freeze([
  'matters', 'facts', 'commitments', 'preferences', 'links', 'updates',
  'routines', 'routinePatches', 'routes',
])
const WIRE_TABLE_SET = new Set(WIRE_TABLES)

/** Entity kinds accepted by readEntityById(). */
const ENTITY_KINDS = Object.freeze({
  commitments: { singular: 'commitment', method: 'getCommitment' },
  facts: { singular: 'fact', method: 'getFact' },
  preferences: { singular: 'preference', method: 'getPreference' },
  matters: { singular: 'matter', method: 'getMatter' },
})

/**
 * Stable read-facade error. `code` is the contract; `hint` is an actionable
 * next step for the user with no absolute path in it.
 */
export class LedgerReadError extends Error {
  constructor(code, message, hint, extra = {}) {
    super(String(message))
    this.name = 'LedgerReadError'
    this.code = String(code)
    if (hint) this.hint = String(hint)
    if (extra && typeof extra === 'object') Object.assign(this, extra)
  }
}

/* -------------------------------------------------------------------------- */
/* home resolution                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the Advisers home directory.
 *
 * Order: `options.home` -> `ADVISERS_HOME` -> `~/.advisers` (the same rule as
 * the CLI / lib/tos defaultHome). An explicitly supplied `home` must be an
 * absolute path; a relative one is a configuration error (E_USAGE), not a data
 * error, so a caller cannot silently read a cwd-relative directory.
 *
 * @param {{ home?: string }} [options]
 * @returns {string}
 */
export function resolveAdvisersHome({ home } = {}) {
  if (home !== undefined && home !== null) {
    if (typeof home !== 'string' || home.trim() === '') {
      throw new LedgerReadError('E_USAGE', 'options.home must be a non-empty absolute path', 'Pass an absolute directory (or omit home to use ADVISERS_HOME / ~/.advisers).')
    }
    if (!isAbsolute(home)) {
      throw new LedgerReadError('E_USAGE', 'options.home must be an absolute path', 'Pass an absolute directory (or omit home to use ADVISERS_HOME / ~/.advisers).')
    }
    return home
  }
  const fromEnv = typeof process.env.ADVISERS_HOME === 'string' ? process.env.ADVISERS_HOME.trim() : ''
  if (fromEnv) return fromEnv
  return join(homedir(), '.advisers')
}

/* -------------------------------------------------------------------------- */
/* path-safe messages                                                         */
/* -------------------------------------------------------------------------- */

/** Replace known absolute paths in a message/warning with portable labels. */
function sanitizePathText(value, home) {
  let text = String(value ?? '')
  if (!home) return text
  const replacements = [
    [join(home, LEDGER_DB_FILE) + '-wal', LEDGER_DB_FILE + '-wal'],
    [join(home, LEDGER_DB_FILE) + '-shm', LEDGER_DB_FILE + '-shm'],
    [join(home, LEDGER_DB_FILE), LEDGER_DB_FILE],
    [join(home, LEDGER_JSON_FILE), LEDGER_JSON_FILE],
    [join(home, 'tos.json'), 'tos.json'],
    [join(home, 'instance.lock'), 'instance.lock'],
    [home, '~/.advisers'],
  ]
  for (const [from, to] of replacements) {
    if (from && from !== '/') text = text.split(from).join(to)
  }
  return text
}

function sanitizeMessage(value, home) {
  return sanitizePathText(value, home).replace(/\s+/g, ' ').trim().slice(0, 400)
}

/* -------------------------------------------------------------------------- */
/* error translation                                                          */
/* -------------------------------------------------------------------------- */

function isReadOnlyVolumeError(error) {
  const code = String(error?.code ?? '')
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'EISDIR' || code === 'ENOTDIR') return true
  return /readonly database|read-only database|unable to open database file|cannot open database|attempt to write a readonly database/i.test(String(error?.message ?? ''))
}

function isCorruptDatabaseError(error) {
  const code = String(error?.code ?? '')
  if (code === 'E_DB_CORRUPT') return true
  return /file is (?:not a database|encrypted)|database disk image is malformed|malformed database/i.test(String(error?.message ?? ''))
}

function isBusyDatabaseError(error) {
  const code = String(error?.code ?? '')
  if (code === 'E_DB_LOCKED') return true
  if (typeof error?.errcode === 'number' && (error.errcode === 5 || error.errcode === 6)) return true
  return /SQLITE_BUSY|SQLITE_LOCKED|database (?:table )?is locked/i.test(String(error?.message ?? ''))
}

/**
 * Translate an open/read failure into a stable LedgerReadError.
 * Messages are our own (short, path-free); the raw error stays as `cause`.
 */
function translateOpenError(error, home) {
  if (error instanceof LedgerReadError) return error
  if (isCorruptDatabaseError(error)) {
    return new LedgerReadError('E_LEDGER_CORRUPT', 'the ledger database is corrupt or not a SQLite database', 'Back up state.db (do not delete it), then run `advisers doctor`; do not rebuild or replace the file.', { cause: error })
  }
  if (isBusyDatabaseError(error)) {
    return new LedgerReadError('E_LEDGER_BUSY', 'the ledger is temporarily busy', 'Retry in a moment; a long-running writer may be checkpointing the ledger.', { cause: error })
  }
  if (isReadOnlyVolumeError(error)) {
    return new LedgerReadError('E_LEDGER_UNAVAILABLE', 'the ledger cannot be opened read-only in this environment', 'Use a local writable directory for ADVISERS_HOME and make sure this process may read state.db; network/synced volumes and read-only mounts are not supported.', { cause: error })
  }
  const code = String(error?.code ?? '')
  if (code === 'E_SCHEMA_STALE') {
    return new LedgerReadError('E_SCHEMA_STALE', 'the on-disk ledger schema is older than this Advisers version; a read-only open never migrates it', 'Run any writable CLI command (for example `advisers doctor`) to migrate the ledger, then retry.', { schemaVersion: error?.schemaVersion ?? null, expected: error?.expected ?? null, cause: error })
  }
  if (code === 'E_SCHEMA_NEWER') {
    return new LedgerReadError('E_SCHEMA_NEWER', 'the on-disk ledger schema is newer than this Advisers version; refusing to read it', 'Upgrade the `advisers` / `dsh-advisers` package so both sides use the same ledger schema.', { schemaVersion: error?.schemaVersion ?? null, expected: error?.expected ?? null, cause: error })
  }
  return new LedgerReadError('E_LEDGER_UNAVAILABLE', 'the ledger could not be opened read-only', 'Check that state.db exists on a local filesystem and the current process can read it; if the error persists run `advisers doctor`.', { cause: error })
}

function absentError() {
  return new LedgerReadError('E_LEDGER_ABSENT', 'no ledger was found in the Advisers home directory', 'Run `advisers init` to create the local ledger; the read-only facade never creates it.', { reason: 'missing' })
}

function vaultSealedError() {
  return new LedgerReadError('E_VAULT_SEALED', 'the ledger is sealed; no plaintext database exists', 'Run `advisers vault unseal` (or `advisers vault status`) first; this facade never creates an empty database.', { reason: 'sealed' })
}

/* -------------------------------------------------------------------------- */
/* TOS gate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Current packaged-TOS acceptance status for a home. Never writes.
 * The packaged manifest (not ADVISERS_TOS_VERSION) decides the version/hash, so
 * an environment variable cannot fake consent (0.3.0 S3).
 */
async function tosStatus(home) {
  let tos
  try { tos = await import('./tos/index.js') } catch { return { accepted: false, reason: 'unavailable' } }
  try {
    const manifest = tos.readManifest()
    const info = tos.currentTos({ version: manifest.version })
    const status = tos.acceptanceStatus({ home, version: info.version, sha256: info.sha256 })
    return { accepted: status.accepted === true, reason: String(status.reason ?? (status.accepted ? 'accepted' : 'missing')) }
  } catch {
    return { accepted: false, reason: 'unavailable' }
  }
}

async function requireTos(home) {
  const status = await tosStatus(home)
  if (status.accepted) return
  throw new LedgerReadError('E_TOS_REQUIRED', `the current Advisers Terms of Service are not accepted for this ledger (${status.reason})`, 'Run `advisers tos show` and accept the current terms with an interactive CLI command; the DSH/read-only surface must never record acceptance for the user.', { reason: status.reason })
}

/* -------------------------------------------------------------------------- */
/* backend selection + ledger handles                                         */
/* -------------------------------------------------------------------------- */

function storePreference() {
  return String(process.env.ADVISERS_STORE ?? '').trim().toLowerCase()
}

/**
 * Decide which backend this home uses. Mirrors the CLI's ADVISERS_STORE rule,
 * with one read-only affordance: when the env var is unset and only the
 * legacy state.json exists, the facade reads JSON instead of pretending the
 * ledger is absent (it never falls back from SQLite to JSON).
 */
function detectBackend(home) {
  const dbPath = join(home, LEDGER_DB_FILE)
  const jsonPath = join(home, LEDGER_JSON_FILE)
  const pref = storePreference()
  if (pref === 'json') return { backend: 'json', dbPath, jsonPath }
  if (existsSync(dbPath)) return { backend: 'sqlite', dbPath, jsonPath }
  if (pref === 'sqlite') return { backend: 'sqlite', dbPath, jsonPath }
  if (existsSync(jsonPath)) return { backend: 'json', dbPath, jsonPath }
  return { backend: 'sqlite', dbPath, jsonPath }
}

function readJsonLedger(jsonPath) {
  let text
  try {
    text = readFileSync(jsonPath, 'utf8')
  } catch (error) {
    throw translateOpenError(error, '')
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
    return parsed
  } catch (error) {
    throw new LedgerReadError('E_LEDGER_CORRUPT', 'the JSON ledger store cannot be parsed', 'Back up state.json (do not delete it), then run `advisers doctor`; the read-only facade never repairs the file.', { cause: error })
  }
}

function notFoundInHome(backend) {
  const dbPath = backend.dbPath
  if (existsSync(dbPath + LEDGER_VAULT_SUFFIX)) return vaultSealedError()
  return absentError()
}

function jsonArray(ledger, table) {
  const value = ledger?.[table]
  return Array.isArray(value) ? value : []
}

function jsonMatterSecrecy(ledger, matterId) {
  if (typeof matterId !== 'string' || !matterId) return 0
  const matter = jsonArray(ledger, 'matters').find((row) => row?.id === matterId)
  if (!matter) return Number.POSITIVE_INFINITY
  return secrecyLevel(matter)
}

function normalizeClearance(value) {
  const level = Number(value)
  return Number.isFinite(level) && level >= 0 ? Math.floor(level) : 0
}

function normalizeLimit(value) {
  if (value === undefined || value === null) return null
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1) {
    throw new LedgerReadError('E_USAGE', 'limit must be a positive integer when supplied', 'Omit limit to return every row that passes the clearance gate.')
  }
  return limit
}

/**
 * Validate one customer-page limit (clients or timeline rows). The read-only
 * facade caps a customer page at 200 rows even when a caller asks for more, so
 * a single read can never load an unbounded customer projection.
 */
function normalizeCustomerLimit(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1) {
    throw new LedgerReadError('E_USAGE', label + ' must be a positive integer when supplied', 'Omit ' + label + ' to use the default; the read-only facade caps customer pages at 200 rows.')
  }
  return Math.min(limit, 200)
}

function normalizeParts(parts) {
  if (parts === undefined || parts === null) return null
  if (!Array.isArray(parts)) throw new LedgerReadError('E_USAGE', 'parts must be an array of wire table names', `Accepted names: ${WIRE_TABLES.join(', ')}.`)
  const selected = []
  for (const part of parts) {
    if (!WIRE_TABLE_SET.has(part)) throw new LedgerReadError('E_USAGE', `unknown snapshot part: ${String(part)}`, `Accepted names: ${WIRE_TABLES.join(', ')}.`)
    if (!selected.includes(part)) selected.push(part)
  }
  return selected
}

function commitmentIndexRow(row) {
  const view = { id: String(row.id), debtor: String(row.debtor ?? ''), creditor: String(row.creditor ?? ''), action: String(row.action ?? ''), status: String(row.status ?? '') }
  if (typeof row.due_at === 'string' && row.due_at) view.dueAt = row.due_at
  else if (typeof row.dueAt === 'string' && row.dueAt) view.dueAt = row.dueAt
  const matterId = row.matter_id ?? row.matterId
  if (typeof matterId === 'string' && matterId) view.matterId = matterId
  return view
}

async function loadSqliteBinding() {
  try {
    return await import('./sqlite.js')
  } catch (error) {
    throw new LedgerReadError('E_LEDGER_UNAVAILABLE', 'the SQLite runtime (node:sqlite) is not available in this Node.js process', 'Use a Node.js >= 22.16 host (the ledger needs node:sqlite). The DSH adapter falls back to a marked preview when this code is returned.', { cause: error })
  }
}

/** Open the ledger read-only, gate TOS, and return a short-lived handle. */
async function openLedgerHandle(home) {
  const backend = detectBackend(home)
  if (backend.backend === 'json') {
    if (!existsSync(backend.jsonPath)) throw notFoundInHome({ dbPath: backend.dbPath })
    await requireTos(home)
    const ledger = readJsonLedger(backend.jsonPath)
    return {
      backend: 'json',
      schemaVersion: null,
      warnings: [],
      // Customer entities are SQLite-only (schema v21): the legacy JSON ledger has
      // no client/project/note tables. Report that honestly; never invent rows.
      customerEntities: false,
      close() {},
      getEntity: (kind, id, clearance) => jsonEntity(ledger, kind, id, clearance),
      index: (options) => jsonCommitmentIndex(ledger, options),
      snapshot: (parts) => jsonSnapshot(ledger, parts),
      clientList: () => ({ rows: [], total: 0, limit: null, clearance: 0, protectedExcluded: 0 }),
      clientStatus: () => null,
    }
  }
  if (!existsSync(backend.dbPath)) throw notFoundInHome(backend)
  await requireTos(home)
  const sqlite = await loadSqliteBinding()
  let store
  try {
    store = sqlite.openReadStore(backend.dbPath)
  } catch (error) {
    throw translateOpenError(error, home)
  }
  const warnings = []
  if (store.walStatus?.warning) warnings.push(sanitizeMessage(store.walStatus.warning, home))
  return {
    backend: 'sqlite',
    schemaVersion: store.schemaVersion(),
    warnings,
    // A read-only open asserts the current schema (v21), so the customer tables
    // exist whenever this handle is returned.
    customerEntities: true,
    close() { try { store.close() } catch {} },
    getEntity(kind, id, clearance) {
      const spec = ENTITY_KINDS[kind]
      return sqliteEntity(store, spec, kind, id, clearance)
    },
    index(options) {
      return sqliteCommitmentIndex(store, options)
    },
    snapshot(parts) {
      return store.read(() => store.loadSnapshot(parts))
    },
    clientList(options) {
      return listClientRows(store, options)
    },
    clientStatus(id, options) {
      return readClientStatus(store, id, options)
    },
  }
}

async function withLedger(home, fn) {
  const handle = await openLedgerHandle(home)
  try { return await fn(handle) } finally { handle.close() }
}

/* -------------------------------------------------------------------------- */
/* sqlite projections                                                         */
/* -------------------------------------------------------------------------- */

// Narrow, index-friendly projection: only the columns a read model shows. This
// deliberately does NOT call store.loadCommitments(), which maps every column
// (including the evidence JSON) for every open row. 20k open commitments cost
// ~17ms with this projection (docs/PERFORMANCE.md; 0.3.0 research report 10
// section 1.4 E8).
const COMMITMENT_INDEX_SQL = 'SELECT id, debtor, creditor, action, due_at, matter_id, status FROM commitments'
const OPEN_COMMITMENT_INDEX_SQL = COMMITMENT_INDEX_SQL + ' WHERE status = ?'
const MATTER_SECRECY_SQL = 'SELECT id, secrecy FROM matters'

function sqliteCommitmentIndex(store, { all, clearance }) {
  const { rawRows, matterRows } = store.read(() => ({
    rawRows: all
      ? store.db.prepare(COMMITMENT_INDEX_SQL).all()
      : store.db.prepare(OPEN_COMMITMENT_INDEX_SQL).all('open'),
    matterRows: store.db.prepare(MATTER_SECRECY_SQL).all(),
  }))
  const secrecyById = new Map()
  for (const matter of matterRows) secrecyById.set(matter.id, matter.secrecy)
  const rows = []
  let protectedExcluded = 0
  for (const raw of rawRows) {
    const matterId = raw.matter_id
    let secrecy = 0
    if (typeof matterId === 'string' && matterId) {
      secrecy = secrecyById.has(matterId) ? secrecyLevel({ secrecy: secrecyById.get(matterId) }) : Number.POSITIVE_INFINITY
    }
    if (secrecy > clearance) { protectedExcluded += 1; continue }
    rows.push(commitmentIndexRow(raw))
  }
  return { rows, total: rows.length, protectedExcluded }
}

function sqliteEntity(store, spec, kind, id, clearance) {
  return store.read(() => {
    const record = store[spec.method](id)
    if (!record) return { record: null, hidden: false }
    let secrecy
    if (kind === 'matters') secrecy = secrecyLevel(record)
    else secrecy = evidenceRecordSecrecy({ getMatter: (matterId) => store.getMatter(matterId) }, spec.singular, record)
    const hidden = secrecy > clearance
    return { record: hidden ? null : record, hidden }
  })
}

/* -------------------------------------------------------------------------- */
/* JSON store projections (legacy ADVISERS_STORE=json)                        */
/* -------------------------------------------------------------------------- */

function jsonEntity(ledger, kind, id, clearance) {
  const table = kind
  const record = jsonArray(ledger, table).find((row) => row?.id === id)
  if (!record) return { record: null, hidden: false }
  const spec = ENTITY_KINDS[kind]
  let secrecy
  if (kind === 'matters') secrecy = secrecyLevel(record)
  else secrecy = evidenceRecordSecrecy({ getMatter: (matterId) => jsonArray(ledger, 'matters').find((row) => row?.id === matterId) }, spec.singular, record)
  const hidden = secrecy > clearance
  return { record: hidden ? null : record, hidden }
}

function jsonCommitmentIndex(ledger, { all, clearance }) {
  const rows = []
  let protectedExcluded = 0
  for (const raw of jsonArray(ledger, 'commitments')) {
    if (!all && raw?.status !== 'open') continue
    const secrecy = jsonMatterSecrecy(ledger, raw?.matterId)
    if (secrecy > clearance) { protectedExcluded += 1; continue }
    rows.push(commitmentIndexRow(raw))
  }
  return { rows, total: rows.length, protectedExcluded }
}

function jsonSnapshot(ledger, parts) {
  const snapshot = { version: Number.isInteger(ledger?.version) ? ledger.version : 1 }
  for (const table of parts ?? WIRE_TABLES) {
    const value = ledger?.[table]
    if (table === 'routes') snapshot.routes = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    else snapshot[table] = Array.isArray(value) ? value : []
  }
  return snapshot
}

/* -------------------------------------------------------------------------- */
/* public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read-only diagnostic. Never returns ledger rows and never throws for a data
 * problem (it reports `readable`, `reason` and an optional `error` instead).
 *
 * @param {{ home?: string }} [options]
 * @returns {Promise<{backend:'sqlite'|'json', dbPresent:boolean, sealed:boolean,
 *   statePresent:boolean, schemaVersion:number|null,
 *   tos:{accepted:boolean, reason:string}, warnings:string[], readable:boolean,
 *   reason?:string, error?:{code:string, message:string, hint?:string}}>}
 */
export async function readLedgerStatus({ home } = {}) {
  const root = resolveAdvisersHome({ home })
  const tos = await tosStatus(root)
  const backend = detectBackend(root)
  if (backend.backend === 'json') {
    const statePresent = existsSync(backend.jsonPath)
    const status = { backend: 'json', dbPresent: false, sealed: false, statePresent, schemaVersion: null, tos, warnings: [], readable: false }
    if (!statePresent) { status.reason = 'absent'; return status }
    try {
      const ledger = readJsonLedger(backend.jsonPath)
      status.readable = true
      status.snapshotVersion = Number.isInteger(ledger.version) ? ledger.version : 1
    } catch (error) {
      const mapped = error instanceof LedgerReadError ? error : translateOpenError(error, root)
      status.error = { code: mapped.code, message: mapped.message }
      if (mapped.hint) status.error.hint = mapped.hint
    }
    return status
  }
  const dbPresent = existsSync(backend.dbPath)
  const sealed = !dbPresent && existsSync(backend.dbPath + LEDGER_VAULT_SUFFIX)
  const status = { backend: 'sqlite', dbPresent, sealed, statePresent: false, schemaVersion: null, tos, warnings: [], readable: false }
  if (!dbPresent) { status.reason = sealed ? 'sealed' : 'absent'; return status }
  try {
    const sqlite = await loadSqliteBinding()
    const store = sqlite.openReadStore(backend.dbPath)
    try {
      status.schemaVersion = store.schemaVersion()
      status.readable = true
      if (store.walStatus?.warning) status.warnings.push(sanitizeMessage(store.walStatus.warning, root))
    } finally { try { store.close() } catch {} }
  } catch (error) {
    const mapped = translateOpenError(error, root)
    status.error = { code: mapped.code, message: mapped.message }
    if (mapped.hint) status.error.hint = mapped.hint
    if (mapped.schemaVersion !== undefined) status.schemaVersion = mapped.schemaVersion
  }
  return status
}

/**
 * Targeted open-commitment index. This one projection powers the DSH today /
 * who views and the commit-ls list without loading a whole ledger snapshot:
 * one narrow SELECT over `commitments` (status index) plus the small matters
 * table for the per-item clearance gate.
 *
 * Protected rows (matter.secrecy > clearance) are excluded from `rows` and
 * only counted in `protectedExcluded`; they are never partially returned.
 *
 * @param {{ home?: string, clearance?: number, all?: boolean, limit?: number }} [options]
 * @returns {Promise<{rows:Array<{id:string,debtor:string,creditor:string,
 *   action:string,status:string,dueAt?:string,matterId?:string}>,
 *   total:number, protectedExcluded:number, clearance:number,
 *   schemaVersion:number|null, backend:'sqlite'|'json', readAt:string,
 *   warnings:string[]}>}
 */
export async function readOpenCommitmentIndex({ home, clearance = 0, all = false, limit = null } = {}) {
  const root = resolveAdvisersHome({ home })
  const level = normalizeClearance(clearance)
  const max = normalizeLimit(limit)
  return withLedger(root, (handle) => {
    const result = handle.index({ all: all === true, clearance: level })
    return {
      rows: max === null ? result.rows : result.rows.slice(0, max),
      total: result.total,
      protectedExcluded: result.protectedExcluded,
      clearance: level,
      schemaVersion: handle.schemaVersion,
      backend: handle.backend,
      readAt: new Date().toISOString(),
      warnings: handle.warnings.slice(),
    }
  })
}

/**
 * One entity by primary key: an O(1) point query, never a table scan (the DSH
 * evidence tool uses this). A record whose matter secrecy is above `clearance`
 * is NOT returned: `record` is null, `hidden` is true and `protectedExcluded`
 * is 1, so the caller can distinguish 'withheld' from 'missing'.
 *
 * @param {{ home?: string, kind:'commitments'|'facts'|'preferences'|'matters',
 *   id:string, clearance?:number }} [options]
 * @returns {Promise<{record:object|null, hidden:boolean, clearance:number,
 *   protectedExcluded:number, schemaVersion:number|null, backend:'sqlite'|'json',
 *   readAt:string, warnings:string[]}>}
 */
export async function readEntityById({ home, kind, id, clearance = 0 } = {}) {
  const root = resolveAdvisersHome({ home })
  if (!Object.prototype.hasOwnProperty.call(ENTITY_KINDS, kind)) {
    throw new LedgerReadError('E_USAGE', `unknown entity kind: ${String(kind)}`, 'kind must be commitments, facts, preferences, or matters.')
  }
  if (typeof id !== 'string' || id.trim() === '') {
    throw new LedgerReadError('E_USAGE', 'id must be a non-empty string', 'Pass the ledger row id, for example cm_… / fact_… / pref_… / matter id.')
  }
  const key = id.trim()
  const level = normalizeClearance(clearance)
  return withLedger(root, (handle) => {
    const result = handle.getEntity(kind, key, level)
    return {
      record: result.record,
      hidden: result.hidden === true,
      clearance: level,
      protectedExcluded: result.hidden ? 1 : 0,
      schemaVersion: handle.schemaVersion,
      backend: handle.backend,
      readAt: new Date().toISOString(),
      warnings: handle.warnings.slice(),
    }
  })
}

/**
 * Wire-v1 ledger snapshot (subset). This is the raw `Ledger.toJSON` shape for
 * trusted in-process consumers (e.g. building a core Ledger); it does NOT apply
 * the per-item clearance gate. Do not hand this snapshot to a model/egress
 * surface without a clearance projection.
 *
 * @param {{ home?: string, parts?: string[] }} [options]
 * @returns {Promise<{snapshot:object, schemaVersion:number|null,
 *   backend:'sqlite'|'json', readAt:string, warnings:string[]}>}
 */
export async function readLedgerSnapshot({ home, parts = null } = {}) {
  const root = resolveAdvisersHome({ home })
  const selected = normalizeParts(parts)
  return withLedger(root, (handle) => ({
    snapshot: handle.snapshot(selected),
    schemaVersion: handle.schemaVersion,
    backend: handle.backend,
    readAt: new Date().toISOString(),
    warnings: handle.warnings.slice(),
  }))
}

/**
 * Read-only customer list (0.3.2 M3). Customer entities are SQLite-only: on the
 * legacy JSON backend the result is an empty list with `customerEntities:false`
 * (never invented rows). The list is clearance-filtered per client (matters and
 * client-level note counts above the clearance are counted in
 * `protectedExcluded`, not shown). Note bodies are never returned.
 *
 * @param {{ home?: string, clearance?: number, limit?: number, all?: boolean }} [options]
 * @returns {Promise<{clients:Array<object>, total:number, truncated:boolean,
 *   limit:number, clearance:number, protectedExcluded:number,
 *   customerEntities:boolean, schemaVersion:number|null, backend:'sqlite'|'json',
 *   readAt:string, warnings:string[]}>}
 */
export async function readClientList({ home, clearance = 0, limit = 20, all = false } = {}) {
  const root = resolveAdvisersHome({ home })
  const level = normalizeClearance(clearance)
  const pageLimit = normalizeCustomerLimit(limit, 20, 'limit')
  return withLedger(root, (handle) => {
    const result = handle.customerEntities === true
      ? handle.clientList({ clearance: level, limit: pageLimit, includeArchived: all === true })
      : { rows: [], total: 0, protectedExcluded: 0 }
    return {
      clients: result.rows,
      total: result.total,
      truncated: result.total > result.rows.length,
      limit: pageLimit,
      clearance: level,
      protectedExcluded: result.protectedExcluded,
      customerEntities: handle.customerEntities === true,
      schemaVersion: handle.schemaVersion,
      backend: handle.backend,
      readAt: new Date().toISOString(),
      warnings: handle.warnings.slice(),
    }
  })
}

/**
 * Read-only customer status by id (0.3.2 M3): client identity, project
 * summaries, exact counts, open mine/waiting items and a derived
 * delivery/commitment timeline. `found:false` (with `view:null`) distinguishes
 * an unknown/archived-by-id client from a gate failure, without throwing.
 *
 * @param {{ home?: string, id: string, clearance?: number, timelineLimit?: number }} [options]
 * @returns {Promise<{found:boolean, view:object|null, clearance:number,
 *   customerEntities:boolean, schemaVersion:number|null, backend:'sqlite'|'json',
 *   readAt:string, warnings:string[]}>}
 */
export async function readClientById({ home, id, clearance = 0, timelineLimit = 20 } = {}) {
  const root = resolveAdvisersHome({ home })
  if (typeof id !== 'string' || id.trim() === '') {
    throw new LedgerReadError('E_USAGE', 'id must be a non-empty string', 'Pass the client id (cl_…); list ids with readClientList.')
  }
  const key = id.trim()
  const level = normalizeClearance(clearance)
  const timelinePage = normalizeCustomerLimit(timelineLimit, 20, 'timelineLimit')
  return withLedger(root, (handle) => {
    const view = handle.customerEntities === true
      ? handle.clientStatus(key, { clearance: level, timelineLimit: timelinePage, openLimit: 20 })
      : null
    return {
      found: view !== null && view !== undefined,
      view: view ?? null,
      clearance: level,
      customerEntities: handle.customerEntities === true,
      schemaVersion: handle.schemaVersion,
      backend: handle.backend,
      readAt: new Date().toISOString(),
      warnings: handle.warnings.slice(),
    }
  })
}

export default Object.freeze({
  LedgerReadError,
  resolveAdvisersHome,
  readLedgerStatus,
  readOpenCommitmentIndex,
  readEntityById,
  readLedgerSnapshot,
  readClientList,
  readClientById,
})
