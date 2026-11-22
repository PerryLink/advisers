#!/usr/bin/env node
import '../lib/node-warning-filter.js'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { delimiter as PATH_DELIMITER, basename, dirname, extname, isAbsolute, join } from 'node:path'
let SqliteStore
let acquireInstanceLock
let instanceLockPath
let inspectWalStatus
let readInstanceLock
let instanceLockIsStale
let openReadStoreLib
let WAL_CORRUPT_SUFFIX
// 0.3.0 customer entities (destructured from lib/sqlite.js below).
let DATA_TABLES
let SCHEMA_VERSION
try {
  ({
    SqliteStore,
    acquireInstanceLock,
    instanceLockPath,
    inspectWalStatus,
    readInstanceLock,
    instanceLockIsStale,
    openReadStore: openReadStoreLib,
    WAL_CORRUPT_SUFFIX,
    // 0.3.0 customer entities: DATA_TABLES is the single list export --all
    // reads (and import --replace restores) so a new table cannot be silently
    // dropped by a hard-coded bin list; SCHEMA_VERSION gates imports of a
    // database/export written by a newer CLI.
    DATA_TABLES,
    SCHEMA_VERSION,
  } = await import('../lib/sqlite.js'))
} catch (error) {
  if (String(error?.message || error).includes('node:sqlite')) {
    console.error(`Advisers needs Node >= 22.16 (node:sqlite). You have ${process.version}. Install Node 24 or use nvm-windows.`)
    process.exit(1)
  }
  throw error
}
import { egressDeniedReason, secrecyLevel } from '../lib/egress.js'
// 0.3.0 Wave 3 (TUI/console wiring, docs/TUI.md §4): the one-line console/log
// sanitiser is the chokepoint for text that came from outside the program before
// it reaches stderr, friendlyError()/reportFatalError() or reminders.log.
// lib/notify.js already sanitises webhook details and lib/imap.js sanitises
// server greeting/status lines; bin must not trust its own formatting either.
import { sanitizeConsoleText } from '../lib/text-safe.js'
// 0.2.3 Wave 1: every durable bin/ output goes through the crash-safe helpers
// (short-write loop, fsync, atomic rename, bounded Windows retry) instead of a
// one-shot writeFileSync that ENOSPC can truncate.
import {
  atomicWriteFileSync,
  commitTempFileSync,
  copyFileWithRetrySync,
  describeFsError,
  fsyncDirSync,
  fsyncFileSync,
  renameWithRetrySync,
  rmWithRetrySync,
  writeAllToTempSync,
} from '../lib/fs-safe.js'
// 0.4.3 (043-5, plan 93 §3): quote/proposal schema v2 payment.channels is a
// pure, tiny validator and normalizeQuoteData() is synchronous, so it is a
// static import (the lazy loaders stay for the fs/network-heavy modules).
import {
  findFullAccountNumbers,
  isAllowedPaymentUrl,
  normalizePaymentChannels,
  paymentChannelKindLabel,
  paymentChannelRequiredTexts,
  paymentChannelSummary,
} from '../lib/payment-channels.js'

/**
 * P1-1: lazy-load the heavy / rarely used libraries.
 *
 * Before this, every invocation (including `advisers --version`) paid for the
 * whole static import graph: pdf-lib + fontkit was ~106ms / +34MB RSS and
 * jszip (via attachments) ~22ms / +10MB, plus importers/evidence/sync/vault/
 * ocr/timestamp/notify/remind which only a subset of commands needs. Each
 * loader memoizes its module promise, so a command that needs a library pays
 * for it at most once, and it fails on first use instead of at startup.
 */
const lazyModule = (loader) => {
  let promise
  return () => (promise ??= loader())
}
const loadAttachments = lazyModule(() => import('../lib/attachments.js'))
const loadEvidence = lazyModule(() => import('../lib/evidence.js'))
const loadIcal = lazyModule(() => import('../lib/ical.js'))
const loadImporters = lazyModule(() => import('../lib/importers.js'))
const loadNotify = lazyModule(() => import('../lib/notify.js'))
const loadReceiptVerify = lazyModule(() => import('../lib/receipt-verify.js'))
// 0.3.0 Wave 2: operations libraries (audit tail anchor, backup rotation/restore).
const loadAuditAnchor = lazyModule(() => import('../lib/audit-anchor.js'))
const loadBackup = lazyModule(() => import('../lib/backup.js'))
const loadScheduler = lazyModule(() => import('../lib/scheduler.js'))
const loadSource = lazyModule(() => import('../lib/source.js'))
const loadOcr = lazyModule(() => import('../lib/ocr.js'))
const loadPdf = lazyModule(() => import('../lib/pdf.js'))
const loadRemind = lazyModule(() => import('../lib/remind.js'))
const loadSync = lazyModule(() => import('../lib/sync.js'))
const loadTimestamp = lazyModule(() => import('../lib/timestamp.js'))
const loadVault = lazyModule(() => import('../lib/vault.js'))
const loadTos = lazyModule(() => import('../lib/tos/index.js'))
const loadMcpServer = lazyModule(() => import('../lib/mcp-server.js'))
const loadSafety = lazyModule(() => import('../lib/safety/index.js'))
// 0.3.0 Wave 3: the output kernel (policy/width/render/json) is loaded only by
// the human-output paths that need it (tui, repl, rendered error blocks), so
// --version / --json-only commands do not pay for the width tables.
const loadTui = lazyModule(() => import('../lib/tui/index.js'))
// P2-4 (0.2.1): every command used to pay for the full static import graph,
// including the model/agent stack, safety classifier, Pet Brief, UI server,
// IMAP client and review helpers (~63-75ms of compiled JS). They are only
// needed by a subset of commands, so each one is a memoized dynamic import.
const loadAgent = lazyModule(() => import('../lib/agent.js'))
const loadUntrusted = lazyModule(() => import('../lib/untrusted.js'))
const loadModel = lazyModule(() => import('../lib/model.js'))
const loadLearning = lazyModule(() => import('../lib/learning.js'))
const loadRoutine = lazyModule(() => import('../lib/routine.js'))
const loadUndo = lazyModule(() => import('../lib/undo.js'))
const loadReview = lazyModule(() => import('../lib/review.js'))
const loadNudge = lazyModule(() => import('../lib/nudge.js'))
const loadDigest = lazyModule(() => import('../lib/digest.js'))
const loadCapture = lazyModule(() => import('../lib/capture.js'))
const loadResearch = lazyModule(() => import('../lib/research.js'))
const loadDocReview = lazyModule(() => import('../lib/doc-review.js'))
const loadContextWindow = lazyModule(() => import('../lib/context-window.js'))
const loadPetBrief = lazyModule(() => import('../lib/pet-brief.js'))
const loadImap = lazyModule(() => import('../lib/imap.js'))
const loadUi = lazyModule(() => import('../lib/ui.js'))
// 0.4.0 (task-29): interactive shell + KB/mail/money/consent command families.
// Each one is only imported by the commands that need it, so ordinary commands
// keep the 0.3.2 startup graph (and --version/help pay for nothing extra).
const loadShell = lazyModule(() => import('../lib/shell.js'))
const loadUrgency = lazyModule(() => import('../lib/urgency.js'))
const loadBriefArchive = lazyModule(() => import('../lib/brief-archive.js'))
const loadKb = lazyModule(() => import('../lib/kb.js'))
const loadKbPages = lazyModule(() => import('../lib/kb-pages.js'))
const loadKbFacts = lazyModule(() => import('../lib/kb-facts.js'))
const loadMail = lazyModule(() => import('../lib/mail.js'))
const loadMailProbe = lazyModule(() => import('../lib/mail-probe.js'))
const loadFactEntry = lazyModule(() => import('../lib/fact-entry.js'))
const loadMailWatch = lazyModule(() => import('../lib/mail-watch.js'))
const loadCredentials = lazyModule(() => import('../lib/credentials.js'))
const loadConsent = lazyModule(() => import('../lib/consent.js'))
const loadPolicy = lazyModule(() => import('../lib/policy/index.js'))
const loadMailStore = lazyModule(() => import('../lib/mail-store.js'))
const loadClientPack = lazyModule(() => import('../lib/client-pack.js'))
// 0.4.3 (043-1): CLI --due boundary resolution (Chinese relative dates).
const loadRelativeDate = lazyModule(() => import('../lib/relative-date.js'))
// 0.4.3 (043-2/043-5): local capture rules, inbox projection, payment channels.
const loadCaptureRules = lazyModule(() => import('../lib/capture-rules.js'))
const loadReceivableCsv = lazyModule(() => import('../lib/receivable-csv.js'))
// 0.4.3 (043-3): doctor --report / privacy --prove --brief / profile.
const loadTrustReport = lazyModule(() => import('../lib/trust-report.js'))
const loadProfileLib = lazyModule(() => import('../lib/profile.js'))
// Money sidecar: the library lands with the 0.4.0 receivables wave; the loader
// fails only when a money command is actually run, never at startup.
const loadReceivablesLib = lazyModule(() => import('../lib/receivables.js'))

let core
if (process.env.ADVISERS_CORE_LOCAL === '1') {
  core = await import('../../core/dist/index.js')
} else {
  try {
    core = await import('advisers-core')
  } catch {
    // Local development before the core package is published.
    core = await import('../../core/dist/index.js')
  }
}
const { createAdvisers, Ledger, systemPorts } = core
let StrictPolicyPack
let policyImportError
try { ({ StrictPolicyPack } = await import('advisers-policy-strict')) } catch { try { ({ StrictPolicyPack } = await import('../../policy-strict/dist/index.js')) } catch (error) { policyImportError = error } }

const HOME = process.env.ADVISERS_HOME || join(homedir(), '.advisers')
const STATE = join(HOME, 'state.json')
const SOUL = join(HOME, 'soul.md')
const SOUL_META = join(HOME, 'soul.meta.json')
const DB = join(HOME, 'state.db')
let mode = process.env.ADVISERS_STORE === 'json' ? 'json' : 'sqlite'
let activeStore

/**
 * 0.2.1 robustness audit P0-1: one SQLite writer per HOME.
 *
 * Every process that opens state.db first takes ~/.advisers/instance.lock
 * (O_EXCL create). A second ordinary command waits (ADVISERS_LOCK_TIMEOUT_MS,
 * default 10s) and then exits E_DB_LOCKED instead of saving from a stale
 * snapshot; long-lived holders (ui/mcp/bridge) keep the lock while they run.
 * The lock is released on exit and on SIGINT/SIGTERM. Read-only commands never
 * open the store, so --version/help create no home and no lock.
 */
let instanceLock = null
let storeExitHooksInstalled = false
const LOCK_PATH = instanceLockPath(HOME)

function lockCommandLabel() {
  return process.argv
    .slice(2)
    .filter((value) => !/^--accept-tos(?:=|$)/.test(value))
    .join(' ')
    .slice(0, 160)
}

function releaseInstanceLock() {
  const lock = instanceLock
  instanceLock = null
  try { lock?.release() } catch {}
}

function installStoreExitHooks() {
  if (storeExitHooksInstalled) return
  storeExitHooksInstalled = true
  process.on('exit', releaseInstanceLock)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      releaseInstanceLock()
      // With no other listener the signal should still terminate the process,
      // with the conventional exit code; otherwise the command's own handler
      // (ui/bridge) finishes its cleanup and exits normally.
      if (process.listenerCount(signal) <= 1) process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

/** Take the HOME instance lock once per process (SQLite store mode only). */
function ensureInstanceLock() {
  if (mode !== 'sqlite') return null
  if (instanceLock?.held) return instanceLock
  installStoreExitHooks()
  instanceLock = acquireInstanceLock({ home: HOME, command: lockCommandLabel() })
  return instanceLock
}

/** Human-readable hint for E_DB_LOCKED/E_DB_CORRUPT; null for other errors. */
function storeFailureHint(error) {
  if (error?.code === 'E_DB_LOCKED') {
    return `advisers: ${error.message}\n` +
      'No changes were made and the JSON store was not used as a fallback. ' +
      'Wait for the other process or stop the long-running server, then retry.'
  }
  if (error?.code === 'E_DB_CORRUPT') {
    return `advisers: ${error.message}\n` +
      `Back up ${DB} before touching it (do not delete it), then run \`advisers doctor\`; ` +
      'the database was not rebuilt and no fallback store was created.'
  }
  return null
}

/**
 * P0-1: one shared ICU formatter instead of `new Intl.DateTimeFormat` per
 * commitment. The old today()/tick() code built a fresh formatter for every
 * date comparison (~4 per commitment), so 25k open commitments instantiated
 * ~100k ICU objects: 3.5s and 1.6GB RSS. Intl.DateTimeFormat instances cost
 * ~49µs/~17KB and are not tracked in the V8 heap.
 */
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
/** Asia/Shanghai calendar day (YYYY-MM-DD) for a Date, timestamp or ISO string. */
const localDayOf = (value) => DAY_FORMAT.format(new Date(value))

/**
 * Calendar TZIDs the local reader accepts (0.3.0 Wave 3, 13-mail-calendar C5).
 *
 * lib/ical.js pins all wall-clock reasoning to Asia/Shanghai and ships no
 * time-zone database, so both `agenda` and `today --calendar` must treat every
 * other zone as degraded-and-skip instead of guessing. Before this, agenda
 * skipped a Berlin event while today --calendar sliced the UTC instant as if it
 * were +08:00 (Berlin 10:00 shown as 17:00) - one dataset, two semantics.
 */
const CALENDAR_TZID_WHITELIST = new Set(['', 'Asia/Shanghai', 'UTC', 'Etc/UTC', 'GMT', 'Z'])

function calendarTzidOf(row) {
  return row?.tzid === undefined || row?.tzid === null ? '' : String(row.tzid)
}

function calendarTzidSupported(row) {
  const tzid = calendarTzidOf(row)
  return !tzid || CALENDAR_TZID_WHITELIST.has(tzid)
}

/**
 * P1-6: default upper bound for `advisers deliver` (open commitments).
 * --all lifts it; the command always reports the untruncated total.
 */
const DELIVER_DEFAULT_LIMIT = 500

const AUDIT_KEY_FILE = join(HOME, 'audit.key')
function readAuditKey() {
  const key = readFileSync(AUDIT_KEY_FILE, 'utf8').trim()
  if (key.length < 16) throw new Error(`audit key file is too short (${key.length} chars, expected >= 16): ${AUDIT_KEY_FILE}`)
  return key
}
function ensureAuditKey() {
  if (process.env.ADVISERS_AUDIT_KEY) return
  // P0-4: O_EXCL so two first-run processes agree on exactly one key. The loser
  // must read the winner's key, not overwrite it (that would leave rows signed
  // with a key that no longer exists on disk). A loser can observe the winner's
  // file between open() and write(), so a short/empty read is retried briefly
  // instead of failing the whole command (0.2.3 read path makes first opens
  // faster and the window is easier to hit under concurrent first runs).
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
  const pause = (ms) => { try { Atomics.wait(waitBuffer, 0, 0, ms) } catch {} }
  let lastError = null
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      if (existsSync(AUDIT_KEY_FILE)) {
        const key = readFileSync(AUDIT_KEY_FILE, 'utf8').trim()
        if (key.length >= 16) { process.env.ADVISERS_AUDIT_KEY = key; return }
        lastError = new Error(`audit key file is too short (${key.length} chars, expected >= 16): ${AUDIT_KEY_FILE}`)
        pause(5)
        continue
      }
      const key = randomBytes(32).toString('hex')
      try { writeFileSync(AUDIT_KEY_FILE, key, { mode: 0o600, flag: 'wx' }) } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        pause(5)
        continue
      }
      process.env.ADVISERS_AUDIT_KEY = key
      return
    } catch (error) {
      lastError = error
      pause(5)
    }
  }
  try {
    process.env.ADVISERS_AUDIT_KEY = readAuditKey()
  } catch (error) {
    lastError = error
  }
  if (process.env.ADVISERS_AUDIT_KEY) return
  console.error(`advisers: audit key unavailable (${lastError?.message ?? 'unknown error'})`)
  console.error(`  expected a readable ${AUDIT_KEY_FILE} with at least 16 characters.`)
  console.error('  refusing to write an unkeyed audit chain. Restore the key file; if it is lost, move it aside and rerun (the existing chain will then verify as BROKEN).')
  process.exit(1)
}
function ensureHome() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  try { chmodSync(HOME, 0o700) } catch {}
  ensureAuditKey()
}

// ---------------------------------------------------------------------------
// 0.2.3 Wave 1: agent workspace boundary (security audit SEC3-02 / P1-B)
//
// Agent file tools used to default to process.cwd(), i.e. whatever directory
// the user happened to start the CLI in (often $HOME or a client project). They
// now default to a dedicated 0700 workspace under ADVISERS_HOME. Widening the
// boundary is explicit only: --allow-path <dir> (repeatable, chat/repl) or
// ADVISERS_ALLOW_PATHS (path-list). Sensitive/persistence paths stay denied by
// lib/agent.js regardless of the allow list.
// ---------------------------------------------------------------------------
const AGENT_WORKSPACE = join(HOME, 'workspace')

/** Create (0700) and return the default agent workspace root. */
function ensureAgentWorkspace() {
  mkdirSync(AGENT_WORKSPACE, { recursive: true, mode: 0o700 })
  try { chmodSync(AGENT_WORKSPACE, 0o700) } catch {}
  return AGENT_WORKSPACE
}

/** Merge explicit --allow-path values with ADVISERS_ALLOW_PATHS (explicit only). */
function resolveAllowPaths(cliAllowPaths = []) {
  const list = Array.isArray(cliAllowPaths) ? cliAllowPaths.slice() : []
  const envValue = process.env.ADVISERS_ALLOW_PATHS
  if (envValue) list.push(...String(envValue).split(PATH_DELIMITER))
  const seen = new Set()
  const result = []
  for (const entry of list) {
    const value = String(entry == null ? '' : entry).trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/** Short audit-safe hash used when a value must not be stored verbatim. */
function auditHash(value) {
  try { return createHash('sha256').update(String(value)).digest('hex').slice(0, 16) } catch { return 'unhashable' }
}

/**
 * Reason text for the tool audit chain: control characters removed and any
 * absolute path (POSIX or Windows) replaced with a short hash, so an audit row
 * never stores a home/workspace path or a model-supplied absolute path.
 */
function auditSafeReason(value) {
  let text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ')
  text = text.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s;,'")]+/g, (match) => 'sha256:' + auditHash(match))
  return text.replace(/\s+/g, ' ').trim().slice(0, 160)
}

/**
 * onToolAction sink for runAgent: one audit row per allowed/denied tool call.
 * action is tool.read / tool.write / tool.call; the row keeps the tool name,
 * decision, code and a workspace-relative path (or a hash of the raw input).
 * File contents and absolute paths are never written.
 */
function auditToolAction(entry) {
  try {
    const store = dbStore()
    if (!store) return
    const spec = entry && typeof entry === 'object' ? entry : {}
    const allowed = spec.allowed !== false
    const action = spec.action === 'write' ? 'tool.write' : spec.action === 'read' ? 'tool.read' : 'tool.call'
    const parts = ['tool=' + safeAuditToken(spec.tool, 'unknown'), 'allowed=' + (allowed ? 1 : 0), 'code=' + safeAuditToken(spec.code, allowed ? 'OK' : 'DENIED')]
    if (typeof spec.relativePath === 'string' && spec.relativePath) parts.push('path=' + safeAuditToken(spec.relativePath, '?'))
    else if (spec.input != null) parts.push('pathHash=' + auditHash(spec.input))
    if (spec.turnId != null) parts.push('turn=' + safeAuditToken(spec.turnId, '-'))
    if (!allowed) {
      const reason = auditSafeReason(spec.reason)
      if (reason) parts.push('reason=' + reason)
    }
    store.appendAudit({ actor: 'agent', action, allowed, reason: parts.join(';') })
  } catch {}
}

/** Sanitize one audit token (no separators/control characters); bounded length. */
function safeAuditToken(value, fallback) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f;=\s]+/g, '_').trim()
  return text ? text.slice(0, 80) : fallback
}

/**
 * P1-1: core ids are `${prefix}_${Date.now().toString(36)}_${seq}` with a
 * per-process counter, so two CLIs started in the same millisecond can mint the
 * same commitment id and one row would overwrite the other on save. Add a
 * process-unique segment so ids from concurrent commands never collide.
 */
const PROCESS_ID = process.pid.toString(36) + randomBytes(2).toString('hex')
let localIdSeq = 0
const LOCAL_PORTS = {
  clock: { now: () => new Date().toISOString() },
  ids: { next: (prefix) => `${prefix}_${Date.now().toString(36)}_${PROCESS_ID}_${++localIdSeq}` },
}

function loadJson() {
  if (!existsSync(STATE)) return new Ledger(LOCAL_PORTS)
  return Ledger.fromJSON(JSON.parse(readFileSync(STATE, 'utf8')), LOCAL_PORTS)
}

function saveJson(ledger) {
  ensureHome()
  writeFileSync(STATE, JSON.stringify(ledger.toJSON(), null, 2) + '\n')
}

/** Sealed vault detection: vault bytes exist but the plaintext database does not. */
function vaultSealedPath() {
  if (mode !== 'sqlite') return null
  const sealed = `${DB}.vault`
  return !existsSync(DB) && existsSync(sealed) ? sealed : null
}

/**
 * Robustness audit P1-1: after `vault seal --remove` every ordinary command used
 * to create a brand-new empty state.db (and doctor/backup reported on the empty
 * database). Fail fast with a stable code instead; the vault commands and
 * `evidence verify` never reach this path.
 */
function vaultSealedError(sealed) {
  const error = new Error(
    `E_VAULT_SEALED: the database is sealed at ${sealed}; no plaintext database exists. ` +
      'Run `ADVISERS_VAULT_PASSPHRASE=... advisers vault unseal` (or `advisers vault status`); no empty database was created.',
  )
  error.code = 'E_VAULT_SEALED'
  return error
}

/** Robustness audit P2-1: SQLite creates -wal/-shm with the process umask (often 0644). */
function secureDbSidecars() {
  for (const file of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { if (existsSync(file)) chmodSync(file, 0o600) } catch {}
  }
}

// ---------------------------------------------------------------------------
// 0.2.3 persistence v2 read path (03-design-persistence-v2.md §4).
//
// Pure-read commands open state.db with DatabaseSync({ readOnly: true }) and take
// NO HOME instance lock: the lock now protects only writers and whole-file
// maintenance (migrate/vault/sync/import/backup). A reader sees the last
// committed WAL snapshot, so it keeps working while a long-lived writer (mcp,
// bridge, older ui) holds the lock. Writes still go through openStore() and its
// E_DB_LOCKED behaviour.
//
// `ADVISERS_READ_LOCKFREE=0` is the kill switch: read commands fall back to the
// exact 0.2.2 path (writable store + HOME lock). A read-only volume / read-only
// directory can make SQLite fail to create the -shm sidecar; that case also
// degrades to the writable path (which reports the historical error messages).
// ---------------------------------------------------------------------------

function readLockfreeEnabled() {
  return process.env.ADVISERS_READ_LOCKFREE !== '0'
}

/** Sleep without busy-waiting; only used for the bounded schema-migration retry. */
const READ_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms) {
  try { Atomics.wait(READ_SLEEP_BUFFER, 0, 0, Math.max(0, Math.floor(Number(ms) || 0))) } catch {}
}

/** True for a read-only volume / sidecar-creation failure (documented fallback). */
function isReadOnlyFallbackError(error) {
  const code = String(error?.code ?? '')
  if (code === 'E_SCHEMA_STALE' || code === 'E_SCHEMA_NEWER' || code === 'E_DB_CORRUPT' || code === 'E_DB_LOCKED' || code === 'E_VAULT_SEALED' || code === 'E_READ_ONLY') return false
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return true
  const message = String(error?.message ?? '')
  return /readonly database|read-only database|unable to open database file|cannot open database/i.test(message)
}

/**
 * Briefly take the writer lock, open the database writable (which runs the
 * backup + per-version migration) and release it again, so a reader that found
 * a stale schema can retry the read-only open. A lock held by another process is
 * a bounded, retried failure; a failed migration backup/corrupt DB is re-thrown
 * fail-closed (the original database is untouched).
 */
function migrateUnderLock() {
  ensureHome()
  const previousLock = instanceLock?.held ? instanceLock : null
  const lock = ensureInstanceLock()
  try {
    const store = new SqliteStore(DB)
    store.close()
  } finally {
    if (lock?.held && lock !== previousLock) releaseInstanceLock()
  }
}

let activeReadStore = null

/**
 * Open (once per process) the lock-free read-only store.
 *
 * - JSON store legacy mode → null (loadJson()).
 * - missing database → initialize through the writable path once, then drop the
 *   writer lock so a long-lived reader (ui/tui) does not block writers forever.
 * - stale schema → bounded retry after a short write-lock migration (§4.4).
 * - newer schema / corrupt database / sealed vault → fail closed, never migrate.
 */
function openReadStore() {
  if (mode === 'json') return null
  ensureHome()
  const sealed = vaultSealedPath()
  if (sealed) throw vaultSealedError(sealed)
  if (activeReadStore) return activeReadStore
  if (!readLockfreeEnabled()) return openStore()
  if (!existsSync(DB)) {
    // First run keeps the historical behaviour: a command may create the store.
    // A pure reader must not keep the writer lock for its whole lifetime.
    const store = openStore()
    activeStore = undefined
    try { store.close() } catch {}
    releaseInstanceLock()
  }
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    let store
    try {
      store = openReadStoreLib(DB)
    } catch (error) {
      if (error?.code === 'E_SCHEMA_NEWER') throw error
      if (error?.code !== 'E_SCHEMA_STALE') {
        if (isReadOnlyFallbackError(error)) return openStore()
        throw error
      }
      lastError = error
      try {
        migrateUnderLock()
      } catch (migrationError) {
        // A failed migration is not a transient read-path problem: retrying it
        // would only create more backups (and can hide the real failure). Only
        // lock contention is retried; everything else is re-thrown fail-closed.
        const retryableLock = migrationError?.code === 'E_DB_LOCKED' || migrationError?.code === 'E_MIGRATE_BUSY'
        if (!retryableLock) throw migrationError
        lastError = migrationError
      }
      sleepSync(50 * (attempt + 1))
      continue
    }
    activeReadStore = store
    return store
  }
  const error = new Error(
    `E_SCHEMA_STALE: could not bring ${DB} to the current schema for a read-only open after 3 attempts` +
      (lastError?.message ? ` (${lastError.message})` : '') +
      '; if another advisers process is upgrading it, retry in a moment; otherwise run a writable command (for example `advisers doctor`) and retry.',
  )
  error.code = 'E_SCHEMA_STALE'
  throw error
}

/** The lock-free read store (null for the legacy JSON store). */
function readStore() {
  return mode === 'json' ? null : openReadStore()
}

/** Print the documented store error for a read command and exit 1. */
function exitReadStoreFailure(error) {
  if (error?.code === 'E_SCHEMA_STALE' || error?.code === 'E_SCHEMA_NEWER') { console.error(error.message); process.exit(1) }
  if (error?.code === 'E_VAULT_SEALED') { console.error(error.message); process.exit(1) }
  const hint = storeFailureHint(error)
  if (hint) { console.error(hint); process.exit(1) }
  console.error(`sqlite unavailable: ${error.message}`)
  console.error('Run `advisers doctor`; refusing to silently switch to JSON (would split the ledger).')
  process.exit(1)
}

/** Read store for commands that query the store directly (null in JSON mode). */
function readStoreOrExit() {
  ensureHome()
  if (mode !== 'sqlite') return null
  try { return openReadStore() } catch (error) { exitReadStoreFailure(error) }
}


function openStore({ checkIntegrity = false } = {}) {
  if (!activeStore) {
    const sealed = vaultSealedPath()
    if (sealed) throw vaultSealedError(sealed)
    ensureHome()
    // P0-1: take the single-writer lock before SQLite sees state.db. The sealed
    // check above runs first so a sealed HOME creates neither a database nor a
    // lock file. E_DB_LOCKED / E_DB_CORRUPT propagate to the caller.
    ensureInstanceLock()
    activeStore = new SqliteStore(DB, { checkIntegrity })
    secureDbSidecars()
  } else if (checkIntegrity) {
    activeStore.assertIntegrity()
  }
  return activeStore
}

/**
 * P1-2 (0.2.2): per-table partial snapshot loaders.
 *
 * Every ledger command used to pay for the full 9-table store.load() -- 488ms
 * at a 50k-row ledger and 1.2s at 100k in the 2026-11-17 performance audit
 * round 2 -- even when it read one table or no rows at all. A read command now
 * passes only the tables it uses (e.g. today/who load open commitments only)
 * and the store records which rows were read so a later save() (tick waking a
 * snoozed commitment) never deletes rows of tables that were not loaded.
 */
const LEDGER_PART_LOADERS = {
  matters: (store, options) => store.loadMatters(options),
  facts: (store, options) => store.loadFacts(options),
  commitments: (store, options) => store.loadCommitments(options),
  preferences: (store, options) => store.loadPreferences(options),
  links: (store, options) => store.loadLinks(options),
  updates: (store, options) => store.loadUpdates(options),
  routines: (store, options) => store.loadRoutines(options),
  routinePatches: (store, options) => store.loadRoutinePatches(options),
  routes: (store) => store.loadRoutes(),
}

/**
 * Open the SQLite store for a ledger read, after honouring the legacy
 * state.json -> SQLite migration and the sealed-vault/corrupt-DB fail-fast
 * paths. Exits the process (with the documented hints) instead of ever
 * silently falling back to the JSON store.
 */
function openLedgerStore() {
  ensureHome()
  const sealed = vaultSealedPath()
  if (sealed) throw vaultSealedError(sealed)
  try {
    if (!existsSync(DB) && existsSync(STATE)) {
      const ledger = loadJson()
      openStore().save(ledger.toJSON())
    }
    return openStore()
  } catch (error) {
    const hint = storeFailureHint(error)
    if (hint) {
      console.error(hint)
      process.exit(1)
    }
    console.error(`sqlite unavailable: ${error.message}`)
    console.error('Run `advisers doctor`; refusing to silently switch to JSON (would split the ledger).')
    process.exit(1)
  }
}

/**
 * Load the ledger. No arguments: the full snapshot (write commands and
 * anything that may save keep using this). With a table map such as
 * `{ commitments: { status: 'open' } }` only those tables are read, mapped by
 * the same row mappers, and the returned Ledger treats every omitted table as
 * empty (Ledger.fromParts).
 */
function loadLedger(parts = null) {
  ensureHome()
  if (mode === 'json') return loadJson()
  const store = openLedgerStore()
  try {
    if (!parts) return Ledger.fromJSON(store.load(), LOCAL_PORTS)
    const snapshot = { version: 1 }
    for (const [table, options] of Object.entries(parts)) {
      const loader = LEDGER_PART_LOADERS[table]
      if (!loader) throw new Error(`unknown ledger table for partial load: ${table}`)
      snapshot[table] = loader(store, options ?? {})
    }
    return Ledger.fromParts(snapshot, LOCAL_PORTS)
  } catch (error) {
    const hint = storeFailureHint(error)
    if (hint) {
      console.error(hint)
      process.exit(1)
    }
    console.error(`sqlite unavailable: ${error.message}`)
    console.error('Run `advisers doctor`; refusing to silently switch to JSON (would split the ledger).')
    process.exit(1)
  }
}

/**
 * Load the ledger for a PURE-READ command through the lock-free read-only store
 * (0.2.3 persistence v2 §4.6). Same partial-loading contract as loadLedger(),
 * but it never takes the HOME writer lock and never runs DDL/migration.
 * Write commands must keep using loadLedger()/dbStore().
 */
function loadReadLedger(parts = null) {
  ensureHome()
  if (mode === 'json') return loadJson()
  try {
    const store = openReadStore()
    if (!parts) return Ledger.fromJSON(store.read(() => store.load()), LOCAL_PORTS)
    const snapshot = store.read(() => {
      const partial = { version: 1 }
      for (const [table, options] of Object.entries(parts)) {
        const loader = LEDGER_PART_LOADERS[table]
        if (!loader) throw new Error(`unknown ledger table for partial load: ${table}`)
        partial[table] = loader(store, options ?? {})
      }
      return partial
    })
    return Ledger.fromParts(snapshot, LOCAL_PORTS)
  } catch (error) {
    exitReadStoreFailure(error)
  }
}

/**
 * Read a partial ledger for a pure-read command. Thin alias of loadReadLedger()
 * so the dispatch reads as "this command only reads", while write commands keep
 * calling loadLedger()/dbStore() (writer lock + WAL).
 */
function readLedgerForCommand(parts = null) {
  return loadReadLedger(parts)
}

/**
 * 0.3.0 P0-T2: run one or more narrow read projections on the lock-free read
 * store inside a single read transaction (one snapshot for a multi-part view).
 * Returns null in legacy JSON-store mode so the caller keeps that path.
 *
 * The projections return only the columns the view reads, in table-scan order.
 * Before this, `today` alone loaded 66k full commitment entities for five
 * displayed columns and every `ORDER BY rowid` after a status predicate spilled
 * a TEMP B-TREE (today 5.6 MB, pet-brief 29 MB of writes per run at 200k rows).
 */
function readProjection(project) {
  const store = readStoreOrExit()
  if (!store) return null
  return store.read(() => project(store))
}

/** Minimal open-commitment rows for the HUMAN `today` view. */
function loadOpenCommitmentRowsForToday() {
  return readProjection((store) => store.projectOpenCommitmentsForToday()) ?? []
}

/**
 * 0.3.2: parse `today --json --limit N` (additive cap; N full Commitment rows
 * per bucket, counts stay the true totals). Requires --json and is not
 * combinable with --sources, which needs the full evidence rows.
 */
function parseTodayLimit(args) {
  const index = args.indexOf('--limit')
  if (index === -1) return { limit: null }
  const raw = args[index + 1]
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) return { error: '--limit must be an integer 1..10000' }
  const value = Number(raw)
  if (value < 1 || value > 10000) return { error: '--limit must be an integer 1..10000' }
  if (!args.includes('--json')) return { error: '--limit requires --json (the human view has its own cap)' }
  if (args.includes('--sources')) return { error: '--limit cannot be combined with --sources (the source rows need full evidence)' }
  return { limit: value }
}

/** Full Commitment entities for the capped today --json rows, id order preserved. */
function hydrateCommitmentsForToday(ids) {
  if (!Array.isArray(ids) || !ids.length) return []
  const store = readStoreOrExit()
  if (!store) return []
  try {
    return store.read(() => ids.map((id) => store.getCommitment(id)).filter(Boolean))
  } catch {
    return []
  }
}

/** Narrow commitment rows for reminder planning (remind / tui). */
function loadReminderRows({ includeUndated = false } = {}) {
  return readProjection((store) => store.projectCommitmentsForReminders({ includeUndated }))
}

/** A ledger-shaped view over already-loaded narrow rows (no entity mapping). */
function reminderLedgerFromRows(rows) {
  return { listCommitments: () => rows }
}

function exitStoreWriteFailure(error) {
  // P0-2: never fall back to state.json. The SQLite database is the only ledger
  // once it exists, so a JSON fallback would silently split the book (and the
  // command would still exit 0). Fail loudly instead.
  const hint = storeFailureHint(error)
  if (hint) {
    console.error(hint)
    process.exit(1)
  }
  console.error(`advisers: could not write the ledger to ${DB}: ${error.message}`)
  console.error('Nothing was written to state.json; the SQLite database is the only ledger, so this command did not apply.')
  console.error('Retry the command; if it keeps failing run `advisers doctor` (or `advisers audit --check-db`).')
  process.exit(1)
}

function saveLedger(ledger) {
  ensureHome()
  if (mode === 'json') return saveJson(ledger)
  try {
    return openStore().save(ledger.toJSON())
  } catch (error) {
    exitStoreWriteFailure(error)
  }
}

function saveLedgerWithAudit(ledger, audit, inside) {
  ensureHome()
  if (mode === 'json') return saveJson(ledger)
  try {
    return openStore().saveWithAudit(ledger.toJSON(), audit, inside)
  } catch (error) {
    exitStoreWriteFailure(error)
  }
}

/**
 * 0.2.3 persistence v2 write helper: one BEGIN IMMEDIATE containing the directed
 * business writes and exactly one audit row (03-design-persistence-v2.md §3.2).
 * In JSON-store mode the caller keeps the legacy load/save path and this returns
 * { legacyJson: true } so the command can fall back without a second code path.
 */
function mutateWithAudit(fn, audit) {
  ensureHome()
  const store = dbStore()
  if (!store) return { legacyJson: true }
  try {
    return store.mutate(fn, audit)
  } catch (error) {
    // Only store-level failures get the "nothing was written" explanation; a
    // business error (unknown matter/commitment, validation) is rethrown so the
    // command can print its own stable message/code (E_MATTER_NOT_FOUND, ...).
    if (isStoreWriteFailure(error)) exitStoreWriteFailure(error)
    throw error
  }
}

/** Alias kept for the existing call sites (memory reject, ...): same channel. */
function updateStoreWithAudit(fn, audit) {
  return mutateWithAudit(fn, audit)
}

/**
 * Record a delivery row + its audit row in one transaction.
 *
 * P0-3 (performance audit): the old path called loadLedger() just to resolve the
 * active matter id, i.e. a hidden FULL load on every deliver/template/pack
 * command (two full loads per deliver at 200k rows). Resolve it from the latest
 * session or the first active matter instead: both are single indexed lookups.
 */
function activeMatterIdForWrite(store) {
  const routed = activeMatterIdFromStore(store)
  if (routed) return routed
  const sessionMatter = sessionMatterIdIfActive(store)
  if (sessionMatter) return sessionMatter
  try { return store?.firstActiveMatter?.()?.id ?? 'matter' } catch { return 'matter' }
}

/**
 * Delivery matter id resolved INSIDE the write transaction: latest session's
 * matter > first active matter > a newly inserted default matter (defaults
 * identical to Ledger.addMatter({title:'默认事项'})). This keeps the historical
 * "a delivery always points at a real matter" behaviour without the old hidden
 * full loadLedger() (P0-3); the default matter and the delivery row commit
 * together with the audit row.
 */
function resolveDeliveryMatterId(store) {
  const routed = activeMatterIdFromStore(store)
  if (routed) return routed
  const sessionMatter = sessionMatterIdIfActive(store)
  if (sessionMatter) return sessionMatter
  const active = store.firstActiveMatter?.()
  if (active) return active.id
  const timestamp = now()
  const matter = {
    id: LOCAL_PORTS.ids.next('matter'),
    title: '默认事项',
    status: 'active',
    domain: 'general',
    secrecy: 0,
    participants: [],
    deadlines: [],
    openQuestions: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  store.insertMatter(matter)
  return matter.id
}

function recordDeliveryWithAudit({ files, tool, title, validation, audit, matterId, clientId, projectId, templateName, templateVersion, quoteNo, dataSha256 }) {
  const store = dbStore()
  if (!store) return
  const conversationId = latestConversationId()
  updateStoreWithAudit((s) => s.addDelivery({
    // An explicit --matter is validated inside the transaction (no dangling id).
    matterId: matterId ? assertMatterForWrite(s, matterId) : resolveDeliveryMatterId(s),
    conversationId,
    files,
    tool,
    title,
    validation: typeof validation === 'string' ? validation : JSON.stringify(validation),
    // v21 lineage (0.3.0): snapshot WHO and WHICH template this delivery was
    // generated for, at generation time. When the caller omits client/project
    // the store derives them from the delivery's matter, so a later re-link
    // never rewrites an already-generated receipt/timeline entry.
    ...(clientId === undefined ? {} : { clientId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(templateName === undefined ? {} : { templateName }),
    ...(templateVersion === undefined ? {} : { templateVersion }),
    ...(quoteNo === undefined ? {} : { quoteNo }),
    ...(dataSha256 === undefined ? {} : { dataSha256 }),
  }), audit)
}

function loadSoul() {
  if (!existsSync(SOUL)) return undefined
  const meta = existsSync(SOUL_META) ? JSON.parse(readFileSync(SOUL_META, 'utf8')) : {}
  const content = readFileSync(SOUL, 'utf8')
  return {
    id: 'soul',
    version: meta.version ?? 1,
    content,
    updatedAt: meta.updatedAt ?? new Date().toISOString(),
    updatedBy: 'human',
  }
}

function saveSoul(doc) {
  ensureHome()
  writeFileSync(SOUL, doc.content, { mode: 0o600 })
  writeFileSync(SOUL_META, JSON.stringify({ version: doc.version, updatedAt: doc.updatedAt }, null, 2) + '\n', { mode: 0o600 })
}

const soulStore = { load: loadSoul, save: saveSoul }

function runtimeFor(ledger) {
  const ports = { ...systemPorts(), soul: soulStore }
  return createAdvisers({ ledger, ports: { ...ports, clock: LOCAL_PORTS.clock, ids: LOCAL_PORTS.ids }, seen: mode === 'sqlite' ? openStore().seenStore() : undefined, ownerIds: process.env.ADVISERS_OWNER?.split(',').map((x) => x.trim()).filter(Boolean), defaultMatterId: activeMatterId(ledger), policyResolver: StrictPolicyPack ? new StrictPolicyPack() : { resolve: () => ({ allowed: false, action: 'deny', code: 'FAIL_CLOSED', reason: 'policy pack missing' }) } })
}

async function backupCliFile(path) {
  try { const { backupBeforeWrite } = await loadUndo(); await backupBeforeWrite(path, { cwd: process.cwd(), backupDir: join(HOME, 'undo') }) } catch {}
}

function now() {
  return new Date().toISOString()
}

/**
 * 0.2.3 B3: honest manual evidence for operator-entered quotes.
 *
 * Before this the CLI wrote `{sessionId:'local', turnId:'cli'}`, a fake
 * conversation pointer that every reader resolved as MISSING (turn_not_found)
 * and every receipt counted as a missing source. A manual source is
 * unverifiable by construction, not missing: evidence.js maps this shape to
 * resolution=unverifiable/operator_entered and receipts count operatorEntered
 * separately from missingCount. No DB migration: evidence is a JSON column.
 */
function sha256HexText(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function manualEvidence(quote, command) {
  const text = String(quote ?? '')
  return {
    kind: 'manual',
    type: 'manual',
    source: 'operator',
    quote: text,
    quoteSha256: sha256HexText(text),
    capturedAt: now(),
    capturedBy: 'local',
    command,
    cliVersion: VERSION,
  }
}

function dbStore() {
  return mode === 'sqlite' ? openStore() : undefined
}

function latestConversationId() {
  try {
    const store = dbStore()
    return store?.listSessions(1)[0]?.conversationId ?? 'local'
  } catch {
    return 'local'
  }
}

function printHistory() {
  const store = readStoreOrExit()
  const rows = store?.listSessions(12) ?? []
  if (!rows.length) {
    console.log('no saved sessions yet')
    return
  }
  rows.forEach((row, index) => {
    console.log(`${index + 1}. ${row.title}  [${row.conversationId}]  ${row.updatedAt}`)
  })
}

function printReceipt() {
  const store = readStoreOrExit()
  if (!store) { console.log('receipt requires SQLite store'); return }
  // 0.2.3: one read snapshot for the delivery row, model usage and research row.
  const { delivery, usage, research } = store.read(() => ({
    delivery: store.listDeliveries(1)[0],
    usage: store.sumModelUsage(),
    research: store.listResearch?.(1)?.[0],
  }))
  if (!delivery) { console.log('还没有交付记录；先运行 `advisers office` / `advisers template`。'); return }
  // P1-2 (0.2.2): only this delivery's matter and its open commitments are read.
  const ledger = loadReadLedger({ commitments: { status: 'open', matterId: delivery.matterId } })
  const open = ledger.openCommitments(delivery.matterId)
  console.log(`回执 ${delivery.id}`)
  console.log(`时间：${delivery.createdAt}`)
  console.log(`事项：${delivery.title || '(untitled)'}`)
  console.log(`产物：${delivery.files.join(', ')}`)
  console.log(`工具：${delivery.tool || '-'}`)
  console.log(`校验：${delivery.validation || '未记录'}`)
  console.log(`未完成承诺：${open.length}`)
  for (const c of open.slice(0, 3)) console.log(`  ${c.id}  ${c.action}${c.dueAt ? ` · ${c.dueAt.slice(0, 10)}` : ''}`)
  if (usage.calls) console.log(`模型：${usage.calls} calls · ${usage.total_tokens} tokens`)
  if (research) {
    console.log(`研究：${research.query}`)
    for (const source of research.sources.slice(0, 3)) console.log(`  web: ${source.title || '(untitled)'} ${source.url}`)
  }
  console.log('提示：结构校验通过不等于内容正确；对外发送仍需 permit。')
}

function printDeliveries() {
  const store = readStoreOrExit()
  const rows = store?.listDeliveries(12) ?? []
  if (!rows.length) {
    console.log('no deliveries yet')
    return
  }
  // P1-2 (0.2.2): only matter titles are needed for the fallback label.
  let matters = []
  try { matters = loadReadLedger({ matters: {} }).listMatters() } catch {}
  const title = new Map(matters.map((m) => [m.id, m.title]))
  for (const row of rows) {
    console.log(`${row.createdAt.slice(0, 19)}  ${row.title ?? title.get(row.matterId) ?? row.matterId}  [${row.tool ?? 'tool'}] ${row.validation ?? ''}`)
    for (const file of row.files) {
      let size = 0
      try { size = statSync(file).size } catch {}
      console.log(`  ${file}  ${size} B`)
    }
  }
}


function shouldPlan(text, brief) {
  if (process.env.ADVISERS_YES === '1') return false
  if (brief.action === 'ask') return false
  return text.length > 80 || /(先|然后|接着|最后|同时|并且)/.test(text)
}

function planLines(brief) {
  return [
    `1. 确认交付：${brief.goal}`,
    `2. 生成 ${brief.deliverable}，保存到工作区（默认 out/）`,
    '3. 校验产物，回执文件路径',
  ]
}

async function askYesNo(rl, prompt, defaultYes = true) {
  try {
    const answer = (await rl.question(prompt)).trim()
    if (!answer) return defaultYes
    return /^y(es)?$/i.test(answer)
  } catch {
    return false
  }
}

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
/**
 * Additive `status --json` contracts discovery field (0.3.0 contract C6).
 *
 * Keep in sync with contracts/versions-v1.json `discovery.expected`: the
 * published npm package does not ship contracts/, so the CLI carries the frozen
 * values and `node scripts/check-contracts.mjs --status` asserts equality with
 * the artifact tree. mcpProtocol is the negotiated *default* legacy revision
 * (lib/mcp-server.js PROTOCOL_VERSION); a client may still negotiate 2025-06-18
 * or 2025-11-25 through initialize.
 */
const CONTRACTS_DISCOVERY = Object.freeze({
  cliJson: 1,
  errors: 1,
  exitCodes: 1,
  mcpTools: 1,
  mcpResources: 1,
  mcpProtocol: '2024-11-05',
  dshTools: 2,
  petBrief: 2,
})
function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/ENOENT/.test(message)) return 'file not found; check the path and run `advisers doctor`'
  if (/Unexpected token|JSON/.test(message)) return 'invalid JSON; use UTF-8 without BOM and see examples/'
  if (/model (HTTP|timeout)|fetch failed|ECONN/.test(message)) return 'model request failed; check ADVISERS_API_KEY / network and run `advisers doctor`'
  if (/database is locked/.test(message)) return 'database is busy; close other advisers processes and retry'
  // 0.3.0 Wave 3: the fallback is where a raw Error message reaches the terminal.
  // Model/provider/IMAP errors can carry ANSI/OSC/bidi and inject a second line
  // (docs/TUI.md §4), so it always goes through the console sanitiser.
  return sanitizeConsoleText(message, { max: 4000 })
}

/** Print one message with every line passed through the console sanitiser. */
function printSafeConsoleLines(text, { stream = 'error', max = 4000 } = {}) {
  const write = stream === 'error' ? console.error : console.log
  for (const line of String(text ?? '').split('\n')) write(sanitizeConsoleText(line, { max }))
}

function reportFatalError(error) {
  // E_DB_LOCKED / E_DB_CORRUPT get backup/doctor/concurrency guidance instead of
  // the generic one-line message (commands that touch the store without going
  // through loadLedger() end up here). The hint and the fallback are both
  // untrusted in the same sense as any other error text.
  const hint = storeFailureHint(error)
  if (hint) printSafeConsoleLines(hint, { max: 4000 })
  else console.error(sanitizeConsoleText(`advisers: ${friendlyError(error)}`, { max: 4000 }))
  process.exit(1)
}
process.on('uncaughtException', reportFatalError)
process.on('unhandledRejection', reportFatalError)
/**
 * TOS gate: `--accept-tos[=<version>]` is a global pre-dispatch flag, so it is
 * stripped from argv before the command is parsed (it may appear before or after
 * the command name). The value is resolved by lib/tos when the gate runs.
 */
const rawArgv = process.argv.slice(2)
let acceptTosFlag
for (let index = rawArgv.length - 1; index >= 0; index--) {
  const value = rawArgv[index]
  if (value === '--accept-tos') { acceptTosFlag = true; rawArgv.splice(index, 1) }
  else if (value.startsWith('--accept-tos=')) { acceptTosFlag = value.slice('--accept-tos='.length); rawArgv.splice(index, 1) }
}

// 0.3.0 Wave 3: global output flags (docs/TUI.md §5-§6, plan 26 §5.5).
//
// --plain / --accessible / --color[=]auto|always|never are accepted by every
// human-output command and stripped before the per-command flag parser runs, so
// an older command cannot mistake them for one of its own options. The resolved
// policy is computed lazily by getOutputPolicy() (tui + REPL consume it); the
// commands that keep their historical bytes are otherwise unaffected.
// NO_COLOR / ADVISERS_PLAIN / ADVISERS_ACCESSIBLE stay environment-only.
const outputArgv = rawArgv.slice()
const OUTPUT_MODE_FLAGS = new Set(['--plain', '--accessible'])
const COLOR_MODES = new Set(['auto', 'always', 'never'])
function invalidColorFlag(value) {
  console.error('advisers: E_USAGE: --color must be auto, always or never (got ' + JSON.stringify(String(value ?? '')) + ')')
  process.exit(1)
}
for (let index = rawArgv.length - 1; index >= 0; index--) {
  const value = rawArgv[index]
  if (OUTPUT_MODE_FLAGS.has(value)) { rawArgv.splice(index, 1); continue }
  if (value === '--color') {
    const mode = String(rawArgv[index + 1] ?? '').toLowerCase()
    if (!COLOR_MODES.has(mode)) invalidColorFlag(rawArgv[index + 1])
    rawArgv.splice(index, 2)
    continue
  }
  if (value.startsWith('--color=')) {
    const mode = value.slice('--color='.length).toLowerCase()
    if (!COLOR_MODES.has(mode)) invalidColorFlag(value.slice('--color='.length))
    rawArgv.splice(index, 1)
  }
}

const [command, ...args] = rawArgv

/**
 * Resolve the single output policy for this invocation (docs/TUI.md §5-§6).
 *
 * One decision object covers plain/accessible/colour/cursor control for the
 * whole process; renderers receive it spread into their options. Loaded lazily
 * because only tui and the REPL render through the kernel today.
 */
let outputPolicyCache = null
async function getOutputPolicy() {
  if (outputPolicyCache) return outputPolicyCache
  const { resolveOutputPolicy } = await loadTui()
  outputPolicyCache = resolveOutputPolicy({
    argv: outputArgv,
    env: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
  })
  return outputPolicyCache
}

function help() {
  console.log(`advisers — a staff of AI advisers

Usage:
  advisers                    start the local conversation (TTY shell)
                              (status line + result blocks; non-TTY prints help; ADVISERS_NO_SHELL=1 keeps the legacy REPL)
  advisers chat [--file <path>] [--allow-path <dir>]... [text]
                              one-shot task, or start the local conversation
  advisers init               initialize home + soul
  advisers doctor [--check-db] [--json]
                              check Node/SQLite/Office/policy/model; --check-db adds
                              quick_check + FTS integrity + WAL + backup + plaintext/temp checks
  advisers doctor --repair [--dry-run|--yes] [--only lock,temp,wal,fts] [--json]
                              recovery console: dry-run plan by default; --yes takes the
                              writer lock, writes a safety backup, repairs, re-verifies,
                              records doctor.repair and refreshes the audit anchor
  advisers doctor --report [--json]   machine report: unmeasured dimensions are explicit
                              null (never 0/false/PASS), each null has a reason in nulls[]
  advisers status [--json]    home/store/model/counts (+ contracts discovery in --json)
  advisers history            recent conversations
  advisers search <text>       full-text search old turns
  advisers compact ls|rollback summary versions
  advisers today [--calendar] [--sources] [--json [--limit n]]
                              one-screen today/week/waiting view (+ local events)
  advisers remind [--json] [--ics [path]] [--deliver [--notify]] [--quiet-hours HH:MM-HH:MM] [--force-notify]  due reminders + ICS/VALARM export
  advisers remind install|uninstall|status [--apply] [--schedule "0 9 * * *"]
                              scheduler scripts + OS plan (dry-run by default; --apply executes)
                              --morning adds the second morning block (--morning-time 08:30, --morning-days 1-5)
                              status v2 shows the remind + morning sections and both OS plans
  advisers remind --json [--now ISO]   reminders + per-row urgency (pure read)
  advisers calendar import --ics <file>  local .ics read-only import
  advisers risks              up to 3 deterministic obligation risks
  advisers pet-brief [--json] [--out [path]] [--check [--strict]] [--display-policy public|private|none]
                              read-only redacted Pet Brief (contract v0.2); --print-schema prints the JSON Schema
  advisers tick               due commitments in the next 7 days
  advisers week [--json]      last 7 local days (Asia/Shanghai); --json is one JSON document
  advisers agenda [--days 7] [--json]
                              7-day agenda: commitments + calendar_events, Asia/Shanghai days
  advisers morning [--json] [--out f] [--top 1..5] [--archive [--keep 1..365]]
                              deterministic local morning brief (no model, no network);
                              --archive writes ~/.advisers/briefs/<day>.md + latest.md
  advisers digest day|week|morning    short digest (morning = the deterministic brief)
  advisers diff                show the last changed file
  advisers undo [--list]      restore the last file write
  advisers learn ls           recent task trajectories
  advisers learn review <id>  LLM routine review (needs API key)
  advisers memory             what I remember
  advisers memory search <q>  search facts/preferences
  advisers memory candidates [--json] [--all]  pending memory candidates
  advisers memory accept|reject <id>
  advisers prefs [--all] | correct <text>
  advisers nudge list|done|ignore <id>  nudge outcomes
  advisers decay              apply 30-day preference decay
  advisers audit              verify the local audit hash chain + tail anchor (--json, --check-db)
  advisers audit --write-anchor  record the current head as the tail-deletion baseline
  advisers audit --expect-count <N> [--expect-head <64 hex>]  explicit head check
  advisers audit --rebuild-fts  rebuild the FTS5 indexes (the repair the reader warning names)
  advisers purge <matter> [--yes]  privacy delete a matter
  advisers commit add|edit|ls|done|snooze commitments
  advisers commit add "..." --quote "..." [--remind-offsets "-1d,-2h"]
  advisers commit edit <id> [--remind-offsets "<list>" | --no-remind]
                              per-commitment reminder offsets (Asia/Shanghai wall clock)
  advisers deliveries         recent generated files
  advisers receipt            one-screen delivery receipt
  advisers ls                 list matters (alias of matter ls)
  advisers matter add <title> [--secrecy 0-3] [--domain d] [--summary s]
                      [--client <id> [--project <id>]] [--json]
  advisers matter ls [--all] [--client <id>] [--project <id>] [--unclassified] [--json]
  advisers matter show|rename|archive|use <id> ...
                              create/inspect/rename/archive a matter; 'use' sets the write default
  advisers client add "<name>" [--aliases a,b] [--tags t1,t2] [--secrecy 0-3]
                      [--note text] [--link-matter <id>] [--json]
  advisers client list [--all] [--limit n] [--json]
  advisers client show <id> [--timeline-limit n] [--clearance 0-3] [--json]
  advisers client timeline <id> [--since 90d|ISO] [--kind delivery,note,commitment]
                      [--limit n] [--clearance 0-3] [--json]
  advisers client archive <id> [--dry-run] [--json]
  advisers client merge <from> <into> [--dry-run] [--json]
  advisers client export <id> [--format md|docx] [--out <file>] [--redact-names] [--json]
  advisers client export <id> --pack [--out <dir>] [--force] [--json]   client status pack v1 (no money fields)
  advisers client note add <id> "<summary>" [--kind k] [--at ISO] [--project id] [--matter id] [--json]
  advisers client note list <id> [--project id] [--limit n] [--json]
  advisers project add <client-id> "<name>" [--start YYYY-MM-DD] [--end YYYY-MM-DD]
                      [--default-matter <id>] [--note text] [--json]
  advisers project list [--client <id>] [--all] [--limit n] [--json]
  advisers project show <id> [--timeline-limit n] [--clearance 0-3] [--json]
  advisers project archive <id> [--dry-run] [--json]
                              customer/project entities + derived timeline (SQLite store;
                              see docs/CLIENTS.md)
  advisers kb add <file>... [--title s] [--kind k] [--client|--project|--matter id] [--secrecy 0-3]
                      [--replace] [--from list.txt] [--json]    index a local document (text extracted locally)
  advisers kb ls|show <id>|rm <id>|purge <id>|reindex [--rebuild] [--json]
                      list/inspect/tombstone/physically purge documents; reindex verifies/rebuilds KB FTS
  advisers kb page ls|show <id>|rebuild|diff ...   deterministic compiled pages (client/project/timeline/facts)
  advisers kb search <q> [--scope kb|pages|all] [--limit n] [--clearance 0-3] [--json]
                      local KB search (no model, no network; clearance filtered before counting)
  advisers search <q> --scope turns|kb|pages|facts|all [--json]
                      scoped local search; without --scope the 0.3.2 turn search output is unchanged
  advisers fact show <id>|history <id>|as-of <YYYY-MM-DD|ISO> [--json]
                      fact source/supersede chain/value as-of a moment (no model, no network)
  advisers mail account add --name n --host h [--port 993] [--tls tls|starttls] --user u [--pass-stdin]
                      store an IMAP account; password only from the TTY prompt or stdin, never argv
  advisers mail account ls|show <acct>|rm <acct> [--json]
  advisers mail sync [<acct>] [--full] [--dry-run] [--json]   the only IMAP network entry (read-only EXAMINE/FETCH)
  advisers mail sync --watch [--interval 300s] [--max-runs n] | --once [--json|--json-lines]
                      foreground polling; --json prints one summary, --json-lines one JSON per round
  advisers mail ls|show <id> [--body]|purge [--older-than 30d] [--dry-run|--yes]|import <file|dir> [--json]
                      local reads; purge clears bodies (metadata/hash stay); import reads .eml/.mbox offline
  advisers mail extract [<id>...] [--all-new] [--local|--model --yes] [--matter id] [--dry-run] [--json]
                      default local rules (offline); --model needs --yes + ADVISERS_API_KEY + consent + secrecy 0
  advisers receivable add <client-id> "<label>" --amount 8000.00 [--due DATE] [--currency CNY] [--json]
  advisers receivable ls|show <id>|edit <id>|void <id> [--aging] [--json]
                      money sidecars in integer minor units; amounts never enter MCP/receipt packs
  advisers payment add <client-id> --amount 4000.00 [--receivable rcv] [--method bank] [--json]
  advisers payment ls|void <id> [--json]   payments reopen/complete the follow-up commitment atomically
  advisers consent status|grant <surface>|revoke <surface> [--data-class mail|kb] [--yes] [--json]
                      separate model-egress consent (provider/base-URL bound; TTY typed confirmation)
  advisers privacy --matrix [--json]   policy surface/action/gate matrix from the registry
  advisers privacy [--json] [--prove [--brief]]  show/verify local data & egress facts
  advisers profile show [--now ISO] [--json]   read-only preference profile (no writes, no network)
  advisers profile export [--md|--json] [--out <file>]   export the same profile (--out writes 0600)
  advisers why <pref-id>      explain a preference
  advisers forget <pref-id>   forget a preference (tombstone)
  advisers export [--all] [--encrypted] [--out file]  export ledger (AES-256-GCM with passphrase)
  advisers import <file> [--replace]  import an export (encrypted or plain)
  advisers vault seal [--out f] [--remove] | unseal [f] | status  AES-256-GCM database vault
  advisers sync push|pull|status --dir <dir>  file-based E2EE snapshot sync (user-provided dir)
  advisers backup [<path.db>|--out f] [--tag name] [--keep daily=7,weekly=4,monthly=3] [--dry-run|--apply] [--json]
                              verify+checkpoint the database and copy it: an explicit path is a
                              plain copy; no path writes a managed backup + .sha256/.anchor.json
                              under <home>/backups. --keep plans GFS rotation (dry-run unless --apply)
  advisers backups ls|verify [--json] [--limit n]  list / re-verify managed backups
  advisers restore <backup> [--dry-run] [--yes] [--allow-anchor-behind] [--json]
                              plan by default; --yes writes a pre-restore backup, installs the
                              verified backup, rolls back on failure, audits db.restore, reopens
  advisers brief [--deep] <text>  print the IntentBrief; --deep adds model refinement
  advisers --version          print the CLI version
  advisers who                 who I owe / who owes me
  advisers review <file> --request "..."  model content review (no edits)
  advisers research --web|--url <url> [--deep] <query>
                              server-side web search/read URL with citations (explicit egress)
  advisers capture [--file <f|->] [--source s] [--date ISO] [--matter id] [--local|--rules|--model] [--json] [<text>]
                              从中文工作内容抽取候选承诺（不自动入账）；--file - 读 stdin，
                              无 ADVISERS_API_KEY 时用本地规则（零出网、只产 pending）
  advisers inbox ls [--source capture|mail|all] [--limit n] [--offset n] [--clearance 0-3] [--json]
  advisers inbox show <candidate-id> [--clearance 0-3] [--json]
                              只读查看待确认候选（不 accept/reject、不写库）
  advisers capture --from-mail <file|dir> [--limit n]  .eml/.mbox 只读导入→候选
  advisers capture --from-transcript <file>      转写稿导入→候选（不录音/不入会）
  advisers capture --from-imap                   只读 IMAP 导入（EXAMINE/FETCH；env 凭据）
  advisers ui [--port n]                        本地只读视图（127.0.0.1，GET only）
  advisers mcp --stdio                          MCP server（8 工具 + 5 resources；写入口仅 pending 候选/回执校验）
  advisers evidence show <id> [--json]          承诺/事实/偏好→原文来源
  advisers deliver [--commit id] [--type confirmation|weekly|statement|ledger] [--format docx|xlsx|pdf] [--out f]  交付物
  advisers deliveries --pack [--out dir] [--ids ...] [--all]  证据包（manifest/README/SHA256SUMS + DOCX 回执；默认上限 2000）
  advisers deliveries --receipt [--out dir] [--ids ...] [--all] [--recipient "Name <mail>"]
                              交付回执包 v1.1（交付文件副本 + 全文件 SHA-256 + 证据；默认上限 2000）
  advisers evidence verify <dir>                离线校验回执包（JSON，exit 0/1；不读账本、不联网）
  advisers policy check <text> policy/crisis check
  advisers office-read <file>  read DOCX/XLSX/PPTX/OFD text
  advisers ocr <image> [--out text]  local OCR adapter (ADVISERS_OCR_CMD; no cloud)
  advisers timestamp <file> [--out proof]  local timestamp/signing adapter
  advisers tui [--once] [--json] [--width n]
                              read-only terminal dashboard; non-TTY/--plain/--accessible
                              print one plain snapshot (never clear the screen); --json is pure JSON
  advisers office-edit <file> <ops.json> [out]  surgical Office edit
  advisers verify <file> [--json] [--content]  structural + deterministic content checks
  advisers office <kind> <spec.json> <out>
                              build docx/xlsx/pptx/xmind/mermaid/drawio
  advisers routine ls         list routines
  advisers routine add <spec.json>
                              add a draft routine
  advisers routine approve <id>
                              activate a routine (human action)
  advisers routine archive <id>
  advisers routine patches     list routine patches
  advisers routine patch <id> <changes.json>
  advisers routine diff <patch-id>
  advisers routine apply <patch-id>
  advisers routine reject <patch-id>
  advisers routine revert <patch-id>  restore the pre-apply values
  advisers routine check <id>         run file/manual verification
  advisers routine curate [--apply]   mark stale/deprecated routines
  advisers routine restore <id>       restore an archived routine to draft
  advisers template quote <data.json> <out.docx|out.xlsx> [--json] [--record-delivery] [--matter id]
  advisers template proposal <data.json> <out.docx> [--json] [--record-delivery]
                              deterministic quote / proposal (DOCX; quote also XLSX); amount strings
  advisers template <weekly|budget|presentation|flow|mindmap|minutes|notice> <data.json> <out>
                              build a template into docx/xlsx/pptx/mmd/drawio/xmind
  advisers link ls            list matter links
  advisers link add <from> <to> <type>
  advisers link confirm <id>
  advisers link suggest <id>  suggest similar matters
  advisers link updates       list cross-matter proposals
  advisers link propose-update <source> <target> <change>
  advisers link apply <id>    write to target only, then mark applied
  advisers link diff <id>     show the pending/applied change
  advisers link reject <id>
  advisers link rollback <id> delete the fact written by an applied update
  advisers bridge --dir <path> [--name advisers]
                              expose Advisers to the Hermes messaging gateway
  advisers soul show          print soul.md
  advisers soul set <file>    set soul.md from a file (human action)
  advisers soul init          write a minimal starter soul.md
  advisers tos show|status [--json]|accept|revoke  使用条款：全文/状态/接受/撤回
  advisers help

Environment:
  ADVISERS_HOME   default ~/.advisers
  ADVISERS_STORE  sqlite (default) or json
  ADVISERS_API_KEY / ADVISERS_BASE_URL / ADVISERS_MODEL
                  enable the model call in chat
  ADVISERS_YES=1  skip the plan confirmation
  ADVISERS_FORCE=1 overwrite existing files without asking
  ADVISERS_ALLOW_PATHS    explicit path-list (OS path separator) widening the
                  agent file-tool boundary, same as repeated --allow-path
  ADVISERS_PROGRESS=1  show internal [tool]/[attach]/[compact] process lines
                  (default hidden; /debug in the REPL also enables them)
  --plain / --accessible / --color auto|always|never
                  global output policy for every human-output command; NO_COLOR
                  and TERM=dumb are honoured (see docs/TUI.md)
  ADVISERS_ACCEPT_TOS=1  record TOS consent without a TTY (same as --accept-tos)
  ADVISERS_NOTIFY_WEBHOOK  optional outbound webhook for remind --deliver --notify
  ADVISERS_LOCK_TIMEOUT_MS  wait for another advisers process to release the
                  instance lock (milliseconds; default 10000, 0 = fail immediately)

Agent workspace:
  chat/repl file tools (file_read/file_write/office_*) are confined to
  ADVISERS_HOME/workspace (created 0700). They do not default to the current
  directory. Pass --allow-path <dir> (repeatable) or set ADVISERS_ALLOW_PATHS to
  widen the boundary explicitly; credential stores, persistence targets and
  other sensitive paths stay denied even then.

Concurrency:
  One advisers WRITER per ADVISERS_HOME uses the SQLite ledger at a time. The
  CLI takes ~/.advisers/instance.lock before opening state.db for a write; a
  second writer waits up to ADVISERS_LOCK_TIMEOUT_MS and then exits with
  E_DB_LOCKED instead of writing from a stale ledger snapshot. mcp / bridge keep
  the lock while they run (they write audit rows), so stop them before running
  other writes (or raise the timeout). Read-only commands (status/today/who/...,
  ui, tui, pet-brief) do NOT take the lock: they read a consistent WAL snapshot,
  so they keep working and never block a writer.
  A stale lock (dead pid, or not refreshed for 1h) is reclaimed; SIGINT/SIGTERM
  and normal exit release the lock. Concurrent commands therefore either run one
  after another or fail explicitly — they never silently overwrite each other.

Exit codes:
  0  success
  1  user/config/runtime error (bad args, missing key, unknown id, failed
     verification, E_DB_LOCKED when another process holds the instance lock,
     E_DB_CORRUPT when state.db is 0 bytes/corrupt: back it up and run
     \`advisers doctor\`; damaged databases are never silently rebuilt)
  3  TOS consent required: non-interactive command blocked by the consent gate.
     Run \`advisers tos accept\` in a TTY, or pass --accept-tos / ADVISERS_ACCEPT_TOS=1.
     \`advisers evidence verify <dir>\` is offline/read-only and exempt from the gate.
     Data-rights commands (audit/export/privacy/purge) and \`tos\` are exempt too.

Requirements:
  Node >= 22.16 (node:sqlite). Node 22 prints an ExperimentalWarning for SQLite; Node 24 does not.
`)
}

let cliSeq = 0
let lastRun

function modelLabel() {
  if (!process.env.ADVISERS_API_KEY) return 'not configured (local mode)'
  if (process.env.ADVISERS_NO_MODEL === '1') return 'disabled (ADVISERS_NO_MODEL=1)'
  return `${process.env.ADVISERS_MODEL || 'deepseek-flash'} @ ${process.env.ADVISERS_BASE_URL || 'https://api.deepseek.com'}`
}

function learnPreference(ledger, statement, quote, { explicit = false } = {}) {
  const existing = ledger.listPreferences({ includeCandidates: true }).find((p) => p.statement === statement)
  if (existing) {
    existing.confidence = Math.min(1, existing.confidence + 0.2)
    existing.lastConfirmed = now()
    if (existing.confidence >= 0.7) existing.status = 'confirmed'
    return { preference: existing, promoted: existing.status === 'confirmed' }
  }
  const pref = ledger.addPreference({
    kind: 'preference',
    statement,
    source: { type: explicit ? 'user_explicit' : 'inferred', quote },
    confidence: explicit ? 0.8 : 0.5,
    status: explicit ? 'confirmed' : 'candidate',
  })
  return { preference: pref, promoted: false }
}

/**
 * `advisers purge <matter> [--yes]` — privacy delete one matter.
 *
 * 0.2.3 §3.3.12: the dry-run is a pure read (lock-free, partial tables). With
 * --yes the ledger tombstones, the non-ledger row deletion and the audit row all
 * commit in ONE transaction; the business rules are the same as
 * core Ledger.purgeMatter (test/incremental-write.test.js pins the SQL half).
 * The historical raw UPDATEs for links/updates/routes are the documented P1
 * exception: SqliteStore has no targeted primitives for those tables yet.
 * VACUUM cannot run inside a transaction, so it runs after COMMIT.
 */
function purgeMatter(id, confirmed) {
  if (!id) { console.error('usage: advisers purge <matter-id> [--yes]'); process.exitCode = 1; return }
  if (mode === 'json') {
    const ledger = loadJson()
    const matter = ledger.getMatter(id)
    if (!matter) { console.error(`unknown matter: ${id}`); process.exitCode = 1; return }
    const facts = ledger.listFacts(id).length
    const links = ledger.listLinks(id).length
    const updates = ledger.listUpdates().filter((u) => u.sourceMatter === id || u.targetMatter === id).length
    const commitments = ledger.openCommitments(id).length
    console.log(`matter ${id}: ${matter.title}`)
    console.log(`facts=${facts} links=${links} updates=${updates} open_commitments=${commitments}`)
    if (!confirmed) { console.log('后果：加 --yes 后不可撤销；先运行 advisers backup 可保留可恢复副本。'); console.log('dry-run only; re-run with --yes to purge'); return }
    console.log('! 需要确认：删除事项 ' + sanitizeConsoleText(id, { max: 200 }) + ' 的本地数据（--yes，不可撤销）；已保留审计行，不会删除备份文件')
    const counts = ledger.purgeMatter(id)
    saveJson(ledger)
    console.log(`purged: ${JSON.stringify(counts)} sqlite={}`)
    return
  }
  if (!confirmed) {
    try {
      const store = readStoreOrExit()
      const { matter, facts, links, updates, commitments } = store.read(() => {
        const target = store.getMatter(id)
        if (!target) return { matter: undefined }
        return {
          matter: target,
          facts: store.loadFacts({ matterId: id }).filter((f) => f.status !== 'deleted').length,
          links: store.loadLinks({}).filter((l) => (l.fromMatter === id || l.toMatter === id) && l.status !== 'rejected').length,
          updates: store.loadUpdates().filter((u) => (u.sourceMatter === id || u.targetMatter === id) && u.status === 'pending').length,
          commitments: store.loadCommitments({ matterId: id, status: 'open' }).length,
        }
      })
      if (!matter) { console.error(`unknown matter: ${id}`); process.exitCode = 1; return }
      console.log(`matter ${id}: ${matter.title}`)
      console.log(`facts=${facts} links=${links} updates=${updates} open_commitments=${commitments}`)
      console.log('后果：--yes 后不可撤销；先运行 advisers backup 可保留可恢复副本。')
      console.log('dry-run only; re-run with --yes to purge')
    } catch (error) { reportCommandFailure(error) }
    return
  }
  // 0.3.0 Wave 3 (plan 26 §4.5): --yes is the confirmation; state the
  // irreversible consequence before the transaction (tombstones + VACUUM).
  console.log('! 需要确认：删除事项 ' + sanitizeConsoleText(id, { max: 200 }) + ' 的本地数据（--yes，不可撤销）')
  console.log('  删除：事实/承诺/偏好/路由/链接标记（状态改为 [purged]）')
  console.log('  已保留：本地审计行（记录本次 purge）；不会删除备份文件')
  console.log('  如需可恢复副本，请先运行：advisers backup')
  const audit = { actor: 'local', action: 'matter.purge', allowed: true, reason: '' }
  try {
    const { result } = mutateWithAudit((store) => {
      const timestamp = now()
      const counts = { facts: 0, links: 0, updates: 0, commitments: 0, preferences: 0, routes: 0 }
      for (const fact of store.loadFacts({ matterId: id })) {
        if (fact.status === 'deleted') continue
        store.updateFact(fact.id, { status: 'deleted', object: '[purged]', source: null, evidence: null, deletedAt: timestamp, deletedReason: 'matter_purged' })
        counts.facts++
      }
      for (const link of store.loadLinks({})) {
        if ((link.fromMatter === id || link.toMatter === id) && link.status !== 'rejected') {
          store.db.prepare('UPDATE links SET status = ?, evidence = ? WHERE id = ?').run('rejected', '[]', link.id)
          counts.links++
        }
      }
      for (const update of store.loadUpdates()) {
        if ((update.sourceMatter === id || update.targetMatter === id) && update.status === 'pending') {
          store.db.prepare('UPDATE updates SET status = ?, change = ?, rollback = NULL WHERE id = ?').run('rejected', '[purged]', update.id)
          counts.updates++
        }
      }
      for (const commitment of store.loadCommitments({ matterId: id })) {
        if (commitment.status !== 'open') continue
        store.updateCommitment(commitment.id, { status: 'dropped', action: '[purged]', creditor: '[purged]', evidence: [] })
        counts.commitments++
      }
      for (const preference of store.loadPreferences()) {
        if (preference.scope?.level === 'matter' && preference.scope?.value === id && preference.status !== 'deprecated') {
          store.updatePreference(preference.id, { status: 'deprecated', statement: '[purged]', evidence: [] })
          counts.preferences++
        }
      }
      for (const [key, matterId] of Object.entries(store.loadRoutes())) {
        if (matterId !== id) continue
        store.db.prepare('DELETE FROM routes WHERE key = ?').run(key)
        counts.routes++
      }
      store.updateMatter(id, { status: 'archived', title: '[purged]', summary: null, updatedAt: timestamp })
      const sqlite = store.purgeMatterData(id, { vacuum: false })
      audit.reason = `${id} ${JSON.stringify(counts)}`
      return { counts, sqlite }
    }, audit)
    try {
      const store = dbStore()
      store.checkpoint({ mode: 'TRUNCATE' })
      store.db.exec('VACUUM')
    } catch {}
    console.log(`purged: ${JSON.stringify(result.counts)} sqlite=${JSON.stringify(result.sqlite ?? {})}`)
  } catch (error) { reportCommandFailure(error) }
}

function parseFlags(args) {
  const flags = {}
  const positional = []
  const booleanFlags = new Set(['web', 'deep', 'all', 'yes', 'json', 'list', 'force', 'apply', 'quiet', 'help', 'content', 'ics', 'deliver', 'install', 'uninstall', 'status', 'calendar', 'sources', 'pack', 'receipt', 'from-imap', 'remove', 'force', 'notify', 'no-remind', 'dry-run', 'unclassified', 'no-calendar', 'include-done', 'record-delivery', 'include-global', 'archive', 'morning', 'include-deleted', 'all-new', 'local', 'rules', 'model', 'full', 'pass-stdin', 'force-notify'])
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      if (booleanFlags.has(key)) flags[key] = true
      else flags[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true
    } else positional.push(args[i])
  }
  return { flags, positional }
}

/* ---------------------------------------------------------------------------
 * 0.3.0 Wave 2: strict option parsing for the operational commands.
 *
 * Before this, unknown flags were silently ignored, so `doctor --repair` and
 * `audit --rebuild-fts` (both not implemented in 0.2.4) exited 0 without doing
 * anything, and a typo like `--yse` looked like success (P0-D1). The commands
 * extended below parse an explicit allowlist and fail closed with E_USAGE.
 * parseFlags() above keeps its historical lenient behaviour for the older
 * commands; do not use it for new options.
 * ------------------------------------------------------------------------- */

/**
 * Parse `--flag`, `--flag=value` and `--flag value` against an allowlist.
 * @returns {{ok: true, flags: object, positional: string[]} | {ok: false, error: string}}
 */
function parseStrictFlags(args, { booleans = [], values = [], positional = true } = {}) {
  const flags = {}
  const rest = []
  const booleanSet = new Set(booleans)
  const valueSet = new Set(values)
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') { rest.push(...args.slice(index + 1)); break }
    if (typeof arg !== 'string' || !arg.startsWith('--')) { rest.push(arg); continue }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    if (booleanSet.has(name)) {
      if (inline !== undefined) return { ok: false, error: `--${name} does not take a value` }
      flags[name] = true
      continue
    }
    if (valueSet.has(name)) {
      if (inline !== undefined) { flags[name] = inline; continue }
      const next = args[index + 1]
      if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
        return { ok: false, error: `--${name} requires a value` }
      }
      flags[name] = next
      index++
      continue
    }
    return { ok: false, error: `unknown option ${arg}` }
  }
  if (!positional && rest.length) return { ok: false, error: `unexpected argument ${rest[0]}` }
  return { ok: true, flags, positional: rest }
}

/** Print one usage error (E_USAGE) and mark the command failed; never throws. */
function usageFail(message, usage = '') {
  console.error(`advisers: E_USAGE: ${message}${usage ? '\n' + usage : ''}`)
  process.exitCode = 1
}

/** 12-hex audit/command hash prefix for human output (full hash in --json). */
function shortAuditHash(hash) {
  return typeof hash === 'string' && hash ? hash.slice(0, 12) : '(none)'
}

/** Human byte size for backup listings (1024-based, one decimal). */
function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '?'
  if (value < 1024) return value + ' B'
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return (Math.round(size * 10) / 10) + ' ' + units[unit]
}

/** Report a store maintenance failure (writable open / lock) consistently. */
function reportMaintenanceFailure(error, asJson, label) {
  const code = error?.code ?? null
  const hint = storeFailureHint(error)
  if (asJson) {
    console.log(JSON.stringify({ ok: false, label, code, error: String(error?.message ?? error), hint: hint ?? undefined }, null, 2))
  } else {
    console.error(`${label}: FAILED${code ? ' (' + code + ')' : ''}: ${error?.message ?? error}`)
    if (hint) console.error(hint)
  }
  process.exitCode = 1
}

const AUDIT_USAGE = 'usage: advisers audit [--check-db] [--json]\n       advisers audit --write-anchor [--json]\n       advisers audit --expect-count <N> [--expect-head <64 hex>] [--json]\n       advisers audit --rebuild-fts [--json]'
const DOCTOR_USAGE = 'usage: advisers doctor [--check-db] [--json]\n       advisers doctor --repair [--dry-run|--yes] [--only lock,temp,wal,fts] [--json]'
const BACKUP_USAGE = 'usage: advisers backup [--out <file> | <path.db>] [--tag <name>] [--keep daily=7,weekly=4,monthly=3] [--dry-run|--apply] [--json]\n       advisers backup <path.db>          explicit copy, never rotated'
const BACKUPS_USAGE = 'usage: advisers backups ls [--json] [--limit <n>]\n       advisers backups verify [--json] [--limit <n>]'
const RESTORE_USAGE = 'usage: advisers restore <backup-file> [--dry-run] [--yes] [--allow-anchor-behind] [--allow-broken-audit-chain] [--json]'

/**
 * Read --remind / --remind-offsets from parsed flags and strictly normalise.
 * `--remind -1d` is a one-offset alias of `--remind-offsets "-1d,-2h"`.
 * Returns undefined when neither flag was given; invalid input throws.
 */
async function parseReminderOffsetsFlag(flags) {
  const raw = flags['remind-offsets'] !== undefined ? flags['remind-offsets'] : flags.remind
  if (raw === undefined) return undefined
  if (raw === true) throw new Error('--remind-offsets requires a value, e.g. --remind-offsets "-1d,-2h" or --remind -1d')
  const list = String(raw).split(',').map((item) => item.trim()).filter(Boolean)
  const { normalizeReminderOffsets } = await loadRemind()
  return normalizeReminderOffsets(list)
}

/**
 * 0.4.3 (043-1, plan 92 §1): resolve a CLI `--due` value at the boundary.
 *
 * ISO input passes through byte-identically; `YYYY-MM-DD` becomes 18:00 in
 * Asia/Shanghai; Chinese relative expressions resolve against the command's
 * Asia/Shanghai calendar day. Nothing is ever stored unparsed: 0.4.2 silently
 * wrote the raw string into dueAt, so `commit ls` echoed it, `today` filed it
 * under noDue and `remind` never fired. Unknown/conflicting values fail closed.
 *
 * @returns {Promise<{ok:true, at:string, calendar:string, basis:string,
 *   matched:string, ambiguous:boolean} | {ok:false, code:string,
 *   message:string, hint:string}>}
 */
async function resolveDueFlag(raw) {
  const { resolveDueInput } = await loadRelativeDate()
  const resolved = resolveDueInput(raw)
  if (resolved.ok) return resolved
  if (resolved.reason === 'conflict') {
    return {
      ok: false,
      code: 'E_DUE_CONFLICT',
      message: '--due 命中多个不同日期：' + resolved.detail.found.join(', '),
      hint: '一次只给一个日期，例如 --due 下周三',
    }
  }
  return {
    ok: false,
    code: 'E_DUE_UNRESOLVED',
    message: '无法解析 --due：' + JSON.stringify(String(raw ?? '')),
    hint: '支持：今天/明天/后天/周X/下周X/月底/季度末/N天后/N周后/YYYY-MM-DD/ISO',
  }
}

/** Print a `--due` resolution refusal (human two-liner or one JSON error envelope). */
function reportDueFailure(failure, asJson = false) {
  if (asJson) {
    console.error(JSON.stringify({ error: { code: failure.code, message: failure.message, hint: failure.hint } }))
  } else {
    console.error('advisers: ' + failure.code + ': ' + failure.message)
    console.error('hint: ' + failure.hint)
  }
  process.exitCode = 1
}

/** Human echo when a relative expression resolved; plain ISO stays quiet. */
function dueResolutionLine(resolved) {
  if (!resolved || resolved.basis !== 'rule') return null
  return 'due 解析：' + resolved.matched + ' → ' + resolved.at + (resolved.ambiguous ? '（歧义：按规则解析）' : '')
}

function recordManualDelivery(files, tool, title, validation) {
  try {
    const store = dbStore()
    if (!store) return
    store.addDelivery({
      matterId: activeMatterIdForWrite(store),
      conversationId: latestConversationId(),
      files,
      tool,
      title,
      validation: typeof validation === 'string' ? validation : JSON.stringify(validation),
    })
  } catch {}
}

/** `advisers matter use <id>` marker: meta row in SQLite, route in the JSON store. */
function activeMatterIdFromStore(store) {
  try {
    const id = store?.getMeta?.('active_matter_id')
    if (!id) return undefined
    const matter = store.getMatter(id)
    return matter && matter.status === 'active' ? id : undefined
  } catch { return undefined }
}

function activeMatterIdFromLedgerRoute(ledger) {
  try {
    const id = ledger?.getRoute?.('active-matter')
    if (!id) return undefined
    const matter = ledger.getMatter(id)
    return matter && matter.status === 'active' ? id : undefined
  } catch { return undefined }
}

/**
 * Latest session's matter, but only when it still exists and is active.
 * Without this check a legacy/archived session reference could silently write
 * a dangling or archived matter_id (the exact class of bug --matter had).
 */
function sessionMatterIdIfActive(store) {
  try {
    const latest = store?.listSessions?.(1)?.[0]
    if (!latest?.matterId) return undefined
    const matter = store.getMatter?.(latest.matterId)
    return matter && matter.status === 'active' ? matter.id : undefined
  } catch { return undefined }
}

function activeMatterId(ledger, explicit) {
  if (explicit) return explicit
  // `matter use` wins over the latest session, so a CLI-only user can pick the
  // default matter for subsequent `commit add` without opening a chat session.
  const routed = (mode === 'json' ? undefined : activeMatterIdFromStore(dbStore())) ?? activeMatterIdFromLedgerRoute(ledger)
  if (routed) return routed
  try {
    const sessionMatter = sessionMatterIdIfActive(dbStore())
    if (sessionMatter) return sessionMatter
  } catch {}
  return ledger.listMatters()[0]?.id ?? ledger.addMatter({ title: '默认事项' }).id
}

// ---------------------------------------------------------------------------
// 0.2.3 incremental-write command helpers (03-design-persistence-v2.md §3.3).
//
// Every directed write resolves its matter/session/ids BEFORE entering the
// transaction and only calls targeted store.get*/insert*/update*/setMeta inside
// it: no loadLedger()/saveLedger() may run inside mutateWithAudit (a full load
// inside the transaction would both block writers and re-introduce the
// 107MB-WAL write amplification this path exists to remove).
// ---------------------------------------------------------------------------

/**
 * Matter id for a directed write: explicit --matter (trusted, matching the
 * historical semantics), else the latest session's matter, else the first active
 * matter, else a newly inserted default matter (defaults identical to
 * Ledger.addMatter({title:'默认事项'})).
 */
/** Business error with a stable code (message keeps the code for plain stderr). */
function matterCommandError(code, message, hint) {
  const error = new Error(code + ': ' + message + (hint ? ' (hint: ' + hint + ')' : ''))
  error.code = code
  if (hint) error.hint = hint
  return error
}

/** Validate an explicit matter id for a write: exists and active, else throw. */
function assertMatterForWrite(store, explicit) {
  const id = String(explicit)
  const matter = store.getMatter?.(id)
  if (!matter) throw matterCommandError('E_MATTER_NOT_FOUND', 'unknown matter: ' + id, 'advisers matter add "…"')
  if (matter.status !== 'active') throw matterCommandError('E_MATTER_ARCHIVED', 'matter is archived: ' + id, 'advisers matter ls')
  return matter.id
}

/** Resolve an explicit --matter on a ledger loaded in memory (JSON store / readers). */
function resolveMatterForCommand(ledger, explicit, command = 'write') {
  if (explicit === undefined || explicit === null) return activeMatterId(ledger)
  if (explicit === true) throw matterCommandError('E_USAGE', '--matter requires a matter id', 'advisers matter ls')
  const id = String(explicit)
  const matter = ledger?.getMatter?.(id)
  if (!matter) throw matterCommandError('E_MATTER_NOT_FOUND', 'unknown matter: ' + id + ' (' + command + ')', 'advisers matter add "…"')
  if (matter.status !== 'active') throw matterCommandError('E_MATTER_ARCHIVED', 'matter is archived: ' + id + ' (' + command + ')', 'advisers matter ls')
  return matter.id
}

function resolveWriteMatterId(store, explicit) {
  if (explicit) return assertMatterForWrite(store, explicit)
  const routed = activeMatterIdFromStore(store)
  if (routed) return routed
  const sessionMatter = sessionMatterIdIfActive(store)
  if (sessionMatter) return sessionMatter
  const active = store.firstActiveMatter?.()
  if (active) return active.id
  const timestamp = now()
  const matter = {
    id: LOCAL_PORTS.ids.next('matter'),
    title: '默认事项',
    status: 'active',
    domain: 'general',
    secrecy: 0,
    participants: [],
    deadlines: [],
    openQuestions: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  store.insertMatter(matter)
  return matter.id
}

/** Session id stamped on CLI-made evidence; falls back to 'local' like before. */
function latestConversationIdFor(store) {
  try { return store.listSessions(1)?.[0]?.conversationId ?? 'local' } catch { return 'local' }
}

/**
 * Report a command failure either as a store write failure (E_DB_LOCKED etc.,
 * with the documented hint) or as a plain business error (usage/unknown id) with
 * exit code 1. Keeps the 0.2.2 stderr text for business errors unchanged.
 */
function isStoreWriteFailure(error) {
  const code = error?.code
  return code === 'E_DB_LOCKED' || code === 'E_DB_CORRUPT' || code === 'E_MIGRATE_BUSY' ||
    code === 'E_MIGRATION_BACKUP' || code === 'E_READ_ONLY' || code === 'E_TX_REQUIRED' ||
    code === 'E_SCHEMA_STALE' || code === 'E_SCHEMA_NEWER' || code === 'E_VAULT_SEALED' ||
    error?.errcode !== undefined || /SQLITE_|database is locked|disk I\/O error|database or disk is full/i.test(String(error?.message ?? ''))
}

function reportCommandFailure(error) {
  if (isStoreWriteFailure(error)) { exitStoreWriteFailure(error); return }
  console.error(error?.message ?? String(error))
  process.exitCode = 1
}

/** Shared output lines of `commit add` (kept byte-identical to 0.2.2). */
function printCommitAdded(c, reminderOffsets) {
  console.log(`${c.id} open ${c.action}${c.dueAt ? ` due ${c.dueAt}` : ''}`)
  if (reminderOffsets !== undefined) console.log('reminder-offsets: ' + JSON.stringify(reminderOffsets))
}

/** Shared output lines of `commit edit` (kept byte-identical to 0.2.2). */
function printCommitUpdated(c, patch) {
  console.log(`updated: ${c.id}`)
  if ('reminderOffsets' in patch) console.log('reminder-offsets: ' + JSON.stringify(c.reminderOffsets ?? []))
  if (patch.dueAt !== undefined) console.log('due: ' + (c.dueAt ?? '未定'))
}

function printCommitments(ledger, asJson = false) {
  const rows = ledger.listCommitments()
  if (asJson) { console.log(JSON.stringify(rows, null, 2)); return }
  if (!rows.length) { console.log('没有承诺'); return }
  for (const c of rows) console.log(`${c.id}\t${c.status}\t${c.dueAt ?? '无截止'}\t${c.action}`)
}

function printMemory(ledger) {
  const prefs = ledger.listPreferences({ includeCandidates: true })
  const commitments = ledger.listCommitments()
  const routines = ledger.listRoutines()
  console.log('记忆 · 我这边存了什么')
  console.log(`关于你（${prefs.length}）`)
  for (const p of prefs.slice(0, 6)) console.log(`  ${p.id}  ${p.statement}  [${p.status}/${p.priority}]`)
  console.log(`承诺（${commitments.filter((c) => c.status === 'open').length} 未完成 / ${commitments.length} 总数）`)
  for (const c of commitments.slice(0, 6)) console.log(`  ${c.id}  ${c.status}  ${c.action}${c.dueAt ? `  ${c.dueAt}` : ''}`)
  console.log(`流程（${routines.filter((r) => r.status === 'active').length} 生效 / ${routines.length} 总数）`)
  for (const r of routines.slice(0, 6)) console.log(`  ${r.id}  ${r.status}  ${r.name}`)
  console.log('输入 /why <pref-id> 看依据；/forget <pref-id> 删除；/audit 看审计。')
}

/**
 * `week` window: the last 7 local days ending today (Asia/Shanghai), inclusive.
 * The old implementation used `due >= weekAgo || due < now`, so any overdue
 * commitment ever (e.g. a 2026-10-01 item) counted as "this week's due"; the
 * local-day window is the 0.3.0 fix (13-mail-calendar C8 / U2) and is the same
 * window the --json contract publishes.
 */
function weekWindow(nowMs) {
  const to = localDayOf(nowMs)
  const from = localDayOf(nowMs - 6 * 86400_000)
  return { from, to, days: 7, timezone: 'Asia/Shanghai' }
}

function weekReport(ledger, nowMs = Date.now()) {
  const window = weekWindow(nowMs)
  const commitments = ledger.listCommitments()
  const itemRows = []
  for (const c of commitments) {
    if (!c.dueAt) continue
    const ms = Date.parse(c.dueAt)
    if (Number.isNaN(ms)) continue
    const day = localDayOf(ms)
    if (day < window.from || day > window.to) continue
    itemRows.push({ commitment: c, ms })
  }
  itemRows.sort((a, b) => (a.ms === b.ms ? (String(a.commitment.id) < String(b.commitment.id) ? -1 : 1) : a.ms - b.ms))
  const dueRows = itemRows.map((row) => row.commitment)
  const done = dueRows.filter((c) => c.status === 'done')
  const open = commitments.filter((c) => c.status === 'open')
  const overdue = open.filter((c) => c.dueAt && !Number.isNaN(Date.parse(c.dueAt)) && Date.parse(c.dueAt) < nowMs)
  let deliveries = []
  try { deliveries = readStoreOrExit()?.listDeliveries(100) ?? [] } catch {}
  const weekDeliveries = deliveries.filter((d) => {
    const ms = Date.parse(d.createdAt)
    if (Number.isNaN(ms)) return false
    const day = localDayOf(ms)
    return day >= window.from && day <= window.to
  })
  const datedOpen = [...open].filter((c) => c.dueAt && !Number.isNaN(Date.parse(c.dueAt)))
  datedOpen.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
  const next = datedOpen.find((c) => localDayOf(Date.parse(c.dueAt)) > window.to) ?? datedOpen[0]
  return { window, dueRows, done, open, overdue, weekDeliveries, next }
}

function printWeek(ledger, asJson = false) {
  const report = weekReport(ledger)
  if (asJson) {
    // 0.3.0 JSON contract (03-design-product-0.3 §5.6.3): window + counts +
    // deterministic items. Previously `week --json` printed Chinese human text
    // because the dispatch keyed off the *store* mode instead of the --json flag.
    console.log(JSON.stringify({
      ok: true,
      command: 'week',
      window: report.window,
      due: report.dueRows.length,
      done: report.done.length,
      overdue: report.overdue.length,
      deliveries: report.weekDeliveries.length,
      items: report.dueRows.map((c) => ({ id: c.id, status: c.status, due: c.dueAt ?? null, action: c.action })),
      next: report.next ? { id: report.next.id, action: report.next.action, dueAt: report.next.dueAt ?? null } : null,
    }, null, 2))
    return
  }
  console.log('本周（' + report.window.from + ' – ' + report.window.to + '）')
  console.log('承诺：到期 ' + report.dueRows.length + ' 件，完成 ' + report.done.length + ' 件，未完成 ' + report.open.length + ' 件，逾期 ' + report.overdue.length + ' 件。')
  for (const c of report.dueRows.slice(0, 5)) console.log('  ' + (c.status === 'done' ? '✓' : '○') + ' ' + sanitizeConsoleText(c.action, { max: 2000 }) + (c.dueAt ? '（' + c.dueAt.slice(0, 10) + '）' : ''))
  console.log('交付：' + report.weekDeliveries.length + ' 个文件。')
  console.log('下周一件：' + sanitizeConsoleText(report.next?.action ?? report.open[0]?.action ?? '先定一个承诺或交付。', { max: 2000 }))
}

// ---------------------------------------------------------------------------
// 0.2.3 P1a: matter (客户/项目) minimal closed loop.
//
// Before this the CLI had exactly two creation paths (the automatic default
// matter and link ingest), and --matter was trusted blindly, so users could
// write matter_id='client-wang' while matters was empty. pet-brief then
// dropped that commitment silently. These commands create/list/show/rename/
// archive a matter and 'matter use' records the default for later writes.
// No schema change: the matters table already exists (schema v20).
// ---------------------------------------------------------------------------
function matterFail(code, message, hint) {
  console.error(JSON.stringify({ error: { code: code, message: message, ...(hint ? { hint: hint } : {}) } }))
  process.exitCode = 1
}

function matterNextDueAt(open) {
  const next = open
    .map((commitment) => dueInstantOfValue(commitment.dueAt))
    .filter((ms) => ms !== null)
    .sort((a, b) => a - b)[0]
  return next === undefined ? null : toShanghaiIso(next)
}

function matterJsonRow(matter, openByMatter) {
  const open = openByMatter.get(matter.id) ?? []
  return {
    id: matter.id,
    title: matter.title,
    status: matter.status,
    domain: matter.domain ?? 'general',
    secrecy: Number(matter.secrecy ?? 0),
    // v21 (0.3.0): real ownership. Pre-v21 matters stay null (unclassified) and
    // are visible through `matter ls` / `--unclassified` — the CLI never
    // invents a client for an unlinked matter.
    clientId: matter.clientId ?? null,
    projectId: matter.projectId ?? null,
    openCommitments: open.length,
    nextDueAt: matterNextDueAt(open),
  }
}

async function matterCommand(args) {
  const sub = args[0]
  const parsed = parseFlags(args.slice(1))
  const flags = parsed.flags
  const positional = parsed.positional
  const asJson = flags.json === true
  const fail = (code, message, hint) => { matterFail(code, message, hint) }
  if (sub === 'add') {
    const title = positional.join(' ').trim()
    if (!title) { fail('E_USAGE', 'matter add requires a title', 'advisers matter add "王工 · 官网改版"'); return }
    let secrecy = 0
    if (flags.secrecy !== undefined) {
      if (flags.secrecy === true || !/^[0-3]$/.test(String(flags.secrecy))) { fail('E_USAGE', '--secrecy must be an integer 0..3'); return }
      secrecy = Number(flags.secrecy)
    }
    const domain = typeof flags.domain === 'string' ? flags.domain : 'general'
    const summary = typeof flags.summary === 'string' ? flags.summary : undefined
    // 0.3.0 v21 ownership: --client [--project] links the new matter through the
    // store (the only writer of matters.client_id/project_id), so an unknown or
    // archived entity fails closed instead of writing a dangling owner.
    const clientId = typeof flags.client === 'string' ? flags.client.trim() : undefined
    const projectId = typeof flags.project === 'string' ? flags.project.trim() : undefined
    if ((clientId || projectId) && mode !== 'sqlite') {
      fail('E_STORE', '客户/项目归属需要 SQLite 账本（ADVISERS_STORE=sqlite）', 'advisers client add "<name>"')
      return
    }
    if (projectId && !clientId) {
      fail('E_USAGE', '--project requires --client (a project belongs to exactly one client)', 'advisers project list --client <id>')
      return
    }
    if (mode === 'json') {
      const ledger = loadJson()
      const matter = ledger.addMatter({ title: title, domain: domain, secrecy: secrecy, summary: summary })
      saveJson(ledger)
      if (asJson) { console.log(JSON.stringify({ ok: true, command: 'matter add', matter: matter }, null, 2)); return }
      console.log('created ' + matter.id + '  ' + matter.title)
      return
    }
    try {
      const audit = { actor: 'local', action: 'matter.add', allowed: true, reason: '' }
      const made = mutateWithAudit((store) => {
        const timestamp = now()
        const row = {
          id: LOCAL_PORTS.ids.next('matter'), title: title, status: 'active', domain: domain, secrecy: secrecy,
          ...(summary === undefined ? {} : { summary: summary }),
          participants: [], deadlines: [], openQuestions: [], createdAt: timestamp, updatedAt: timestamp,
        }
        store.insertMatter(row)
        if (!clientId) { audit.reason = row.id; return row }
        const linked = store.setMatterClient(row.id, { clientId: clientId, ...(projectId ? { projectId: projectId } : {}) })
        audit.reason = row.id + ';client=' + clientId + (projectId ? ';project=' + projectId : '')
        return linked
      }, audit)
      const matter = made.result
      if (asJson) { console.log(JSON.stringify({ ok: true, command: 'matter add', matter: matter }, null, 2)); return }
      console.log('created ' + matter.id + '  ' + matter.title)
    } catch (error) { reportCommandFailure(error) }
    return
  }
  if (sub === 'ls') {
    try {
      const ledger = mode === 'json' ? loadJson() : readLedgerForCommand({ matters: {}, commitments: { status: 'open' } })
      const statuses = flags.all === true ? ['active', 'paused', 'archived'] : ['active']
      const matters = statuses.flatMap((status) => ledger.listMatters(status))
      const openByMatter = new Map()
      for (const commitment of ledger.listCommitments()) {
        if (commitment.status !== 'open') continue
        const list = openByMatter.get(commitment.matterId) ?? []
        list.push(commitment)
        openByMatter.set(commitment.matterId, list)
      }
      // 0.3.0 v21 ownership filters. An unknown --client/--project fails closed
      // (an empty list would look like "no matters" and hide a typo). With no
      // filter the default list includes unclassified matters, so incompletely
      // linked work stays visible instead of disappearing behind the entity view.
      const clientFilter = typeof flags.client === 'string' ? flags.client.trim() : undefined
      const projectFilter = typeof flags.project === 'string' ? flags.project.trim() : undefined
      const onlyUnclassified = flags.unclassified === true
      if ((clientFilter || projectFilter) && mode === 'sqlite') {
        const store = readStoreOrExit()
        if (clientFilter && !store?.getClient(clientFilter)) { fail('E_CLIENT_NOT_FOUND', 'unknown client: ' + clientFilter, 'advisers client list'); return }
        if (projectFilter && !store?.getProject(projectFilter)) { fail('E_PROJECT_NOT_FOUND', 'unknown project: ' + projectFilter, 'advisers project list'); return }
      }
      const rows = matters
        .map((matter) => matterJsonRow(matter, openByMatter))
        .filter((row) => {
          if (clientFilter && row.clientId !== clientFilter) return false
          if (projectFilter && row.projectId !== projectFilter) return false
          if (onlyUnclassified && row.clientId !== null) return false
          return true
        })
      rows.sort((a, b) => (a.status === b.status ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a.status < b.status ? -1 : 1)))
      if (asJson) { console.log(JSON.stringify(rows, null, 2)); return }
      if (!rows.length) { console.log('（没有事项）'); return }
      for (const row of rows) console.log(row.id + '\t' + row.status + '\tsecrecy=' + row.secrecy + '\topen=' + row.openCommitments + '\t' + (row.nextDueAt ?? '无截止') + '\t' + row.title)
    } catch (error) { reportCommandFailure(error) }
    return
  }
  if (sub === 'show') {
    const id = positional[0]
    if (!id) { fail('E_USAGE', 'matter show requires a matter id', 'advisers matter ls'); return }
    try {
      const ledger = mode === 'json' ? loadJson() : readLedgerForCommand({ matters: {}, commitments: { matterId: id } })
      const matter = ledger.getMatter(id)
      if (!matter) { fail('E_MATTER_NOT_FOUND', 'unknown matter: ' + id, 'advisers matter ls'); return }
      const commitments = ledger.listCommitments().filter((commitment) => commitment.matterId === id)
      const open = commitments.filter((commitment) => commitment.status === 'open')
      // 0.3.0: the raw matter row already carries clientId/projectId (v21); the
      // resolved names are additive display fields, never a second source of truth.
      const entityStore = mode === 'sqlite' ? readStoreOrExit() : null
      const linkedClient = matter.clientId && entityStore ? entityStore.getClient(matter.clientId) : undefined
      const linkedProject = matter.projectId && entityStore ? entityStore.getProject(matter.projectId) : undefined
      const payload = {
        ok: true,
        command: 'matter show',
        matter: matter,
        client: linkedClient ? { id: linkedClient.id, name: linkedClient.name, status: linkedClient.status } : null,
        project: linkedProject ? { id: linkedProject.id, name: linkedProject.name, status: linkedProject.status, clientId: linkedProject.clientId } : null,
        counts: { commitments: commitments.length, open: open.length, done: commitments.filter((c) => c.status === 'done').length },
        open: open.map((c) => ({ id: c.id, action: c.action, dueAt: c.dueAt ?? null, debtor: c.debtor, creditor: c.creditor })),
        nextDueAt: matterNextDueAt(open),
      }
      if (asJson) { console.log(JSON.stringify(payload, null, 2)); return }
      console.log(matter.id + '  ' + matter.title)
      console.log('状态 ' + matter.status + ' · 保密 ' + Number(matter.secrecy ?? 0) + ' · 领域 ' + (matter.domain ?? 'general'))
      if (payload.client) console.log('客户 ' + payload.client.name + ' (' + payload.client.id + ')' + (payload.project ? ' · 项目 ' + payload.project.name + ' (' + payload.project.id + ')' : ''))
      if (matter.summary) console.log('摘要：' + matter.summary)
      console.log('未完成承诺 ' + open.length + ' · 总承诺 ' + commitments.length + ' · 下一截止 ' + (payload.nextDueAt ?? '无'))
      for (const c of open.slice(0, 20)) console.log('  ' + c.id + '  ' + c.action + (c.dueAt ? ' · ' + c.dueAt : ''))
    } catch (error) { reportCommandFailure(error) }
    return
  }
  if (sub === 'rename') {
    const id = positional[0]
    const title = positional.slice(1).join(' ').trim()
    if (!id || !title) { fail('E_USAGE', 'matter rename requires <id> <title>', 'advisers matter rename matter_x "新标题"'); return }
    if (mode === 'json') {
      const ledger = loadJson()
      const matter = ledger.getMatter(id)
      if (!matter) { fail('E_MATTER_NOT_FOUND', 'unknown matter: ' + id, 'advisers matter ls'); return }
      matter.title = title
      matter.updatedAt = now()
      saveJson(ledger)
      if (asJson) { console.log(JSON.stringify({ ok: true, command: 'matter rename', matter: matter }, null, 2)); return }
      console.log('renamed ' + id + '  ' + title)
      return
    }
    try {
      const audit = { actor: 'local', action: 'matter.rename', allowed: true, reason: id }
      const made = mutateWithAudit((store) => {
        const current = store.getMatter(id)
        if (!current) throw matterCommandError('E_MATTER_NOT_FOUND', 'unknown matter: ' + id, 'advisers matter ls')
        store.updateMatter(id, { title: title, updatedAt: now() })
        return store.getMatter(id)
      }, audit)
      if (asJson) { console.log(JSON.stringify({ ok: true, command: 'matter rename', matter: made.result }, null, 2)); return }
      console.log('renamed ' + id + '  ' + made.result.title)
    } catch (error) { reportCommandFailure(error) }
    return
  }
  if (sub === 'archive') {
    const id = positional[0]
    if (!id) { fail('E_USAGE', 'matter archive requires a matter id', 'advisers matter ls'); return }
    const dryRun = flags['dry-run'] === true
    try {
      if (mode === 'json') {
        const ledger = loadJson()
        const matter = ledger.getMatter(id)
        if (!matter) { fail('E_MATTER_NOT_FOUND', 'unknown matter: ' + id, 'advisers matter ls'); return }
        if (dryRun) {
          if (asJson) console.log(JSON.stringify({ ok: true, command: 'matter archive', dryRun: true, matter: matter }, null, 2))
          else console.log('would archive ' + id + '  ' + matter.title + '（dry-run，未写入）')
          return
        }
        matter.status = 'archived'
        matter.updatedAt = now()
        saveJson(ledger)
        if (asJson) { console.log(JSON.stringify({ ok: true, command: 'matter archive', matter: matter }, null, 2)); return }
        console.log('archived ' + id + '  ' + matter.title)
        return
      }
      if (dryRun) {
        const ledger = readLedgerForCommand({ matters: {} })
        const matter = ledger.getMatter(id)
        if (!matter) { fail('E_MATTER_NOT_FOUND', 'unknown matter: ' + id, 'advisers matter ls'); return }
        if (asJson) console.log(JSON.stringify({ ok: true, command: 'matter archive', dryRun: true, matter: matter }, null, 2))
        else console.log('would archive ' + id + '  ' + matter.title + '（dry-run，未写入）')
        return
      }
      const audit = { actor: 'local', action: 'matter.archive', allowed: true, reason: id }
      const made = mutateWithAudit((store) => {
        const current = store.getMatter(id)
        if (!current) throw matterCommandError('E_MATTER_NOT_FOUND', 'unknown matter: ' + id, 'advisers matter ls')
        store.updateMatter(id, { status: 'archived', updatedAt: now() })
        return store.getMatter(id)
      }, audit)
      if (asJson) { console.log(JSON.stringify({ ok: true, command: 'matter archive', matter: made.result }, null, 2)); return }
      console.log('archived ' + id + '  ' + made.result.title)
    } catch (error) { reportCommandFailure(error) }
    return
  }
  if (sub === 'use') {
    const id = positional[0]
    if (!id) { fail('E_USAGE', 'matter use requires a matter id', 'advisers matter ls'); return }
    try {
      if (mode === 'json') {
        const ledger = loadJson()
        const matter = ledger.getMatter(id)
        if (!matter) { fail('E_MATTER_NOT_FOUND', 'unknown matter: ' + id, 'advisers matter ls'); return }
        if (matter.status !== 'active') { fail('E_MATTER_ARCHIVED', 'matter is archived: ' + id, 'advisers matter ls'); return }
        ledger.setRoute('active-matter', id)
        saveJson(ledger)
        if (asJson) { console.log(JSON.stringify({ ok: true, command: 'matter use', matterId: id }, null, 2)); return }
        console.log('active matter: ' + id + '  ' + matter.title)
        return
      }
      const audit = { actor: 'local', action: 'matter.use', allowed: true, reason: id }
      const made = mutateWithAudit((store) => {
        const current = store.getMatter(id)
        if (!current) throw matterCommandError('E_MATTER_NOT_FOUND', 'unknown matter: ' + id, 'advisers matter ls')
        if (current.status !== 'active') throw matterCommandError('E_MATTER_ARCHIVED', 'matter is archived: ' + id, 'advisers matter ls')
        store.setMeta('active_matter_id', id)
        return current
      }, audit)
      if (asJson) { console.log(JSON.stringify({ ok: true, command: 'matter use', matterId: id }, null, 2)); return }
      console.log('active matter: ' + id + '  ' + made.result.title)
    } catch (error) { reportCommandFailure(error) }
    return
  }
  if (!sub || sub === 'help' || sub === '--help') {
    console.log('usage: advisers matter <add|ls|show|rename|archive|use> ...')
    console.log('  advisers matter add <title> [--secrecy 0-3] [--domain name] [--summary text] [--client id [--project id]] [--json]')
    console.log('  advisers matter ls [--all] [--client id] [--project id] [--unclassified] [--json]')
    console.log('  advisers matter show <id> [--json]')
    console.log('  advisers matter rename <id> <title> [--json]')
    console.log('  advisers matter archive <id> [--dry-run] [--json]')
    console.log('  advisers matter use <id> [--json]     set the default matter for later writes')
    return
  }
  fail('E_USAGE', 'unknown matter subcommand: ' + sub, 'advisers matter help')
}

/* ---------------------------------------------------------------------------
 * 0.3.0 customer entities: client / project commands + derived views.
 *
 * clients/projects/client_notes are SQLite-only rows (schema v21): they never
 * enter the wire LedgerSnapshot, so every command here is a thin adapter over
 * SqliteStore. Writes are one directed statement in a single mutate()
 * transaction with exactly one audit row (ids/counts only -- never names, notes,
 * titles or paths); reads run in one lock-free snapshot and every query is
 * scoped by the client/project's own matter ids (no full-table read followed by
 * an in-memory filter, so two clients can never see each other's rows).
 *
 * The customer timeline is DERIVED (packages/core/src/customer.ts); there is no
 * event table and no stored counter. --clearance N is an opt-in per-item
 * secrecy gate: a matter whose effective secrecy max(client.secrecyDefault,
 * matter.secrecy) is above N is withheld with its rows and only a COUNT is
 * reported (never an id/title/name). The local CLI default is 3 (the user's own
 * data is visible); pass --clearance 0 to build output safe to hand to someone
 * else. Unclassified (pre-v21) matters stay visible in matter ls: no ownership
 * is ever invented for them.
 * ------------------------------------------------------------------------- */
const CUSTOMER_SOURCE_LIMIT = 200
const CUSTOMER_TIMELINE_DEFAULT = 20
const CUSTOMER_TIMELINE_MAX = 200
const CUSTOMER_DEFAULT_CLEARANCE = 3
const CUSTOMER_DEFAULT_LIMIT = 100
const CUSTOMER_MAX_LIMIT = 1000

const CUSTOMER_USAGE = {
  add: 'usage: advisers client add "<name>" [--aliases a,b] [--tags t1,t2] [--secrecy 0-3] [--note text] [--link-matter <id>] [--json]',
  list: 'usage: advisers client list [--all] [--limit n] [--json]',
  show: 'usage: advisers client show <id> [--timeline-limit n] [--clearance 0-3] [--json]',
  timeline: 'usage: advisers client timeline <id> [--since 90d|ISO] [--kind delivery,note,commitment] [--limit n] [--clearance 0-3] [--json]',
  archive: 'usage: advisers client archive <id> [--dry-run] [--json]',
  merge: 'usage: advisers client merge <from-id> <into-id> [--dry-run] [--json]',
  note: 'usage: advisers client note add <id> "<summary>" [--kind note|call|meeting|decision|email-summary] [--at ISO] [--project <id>] [--matter <id>] [--json]',
  noteList: 'usage: advisers client note list <id> [--project <id>] [--limit n] [--json]',
  projectAdd: 'usage: advisers project add <client-id> "<name>" [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--default-matter <id>] [--note text] [--json]',
  projectList: 'usage: advisers project list [--client <id>] [--all] [--limit n] [--json]',
  projectShow: 'usage: advisers project show <id> [--timeline-limit n] [--clearance 0-3] [--json]',
  projectArchive: 'usage: advisers project archive <id> [--dry-run] [--json]',
  export: 'usage: advisers client export <id> [--format md|docx] [--out <file>] [--redact-names] [--json]\n       advisers client export <id> --pack [--out <dir>] [--force] [--json]'
}

/** An application error with a stable E_* code and optional actionable hint. */
function customerError(code, message, hint) {
  const error = new Error(code + ': ' + message)
  error.code = code
  if (hint) error.hint = hint
  return error
}

/** Machine-readable failure on stderr; stdout stays a clean JSON document. */
function customerFail(code, message, hint) {
  const payload = { error: { code: code, message: message } }
  if (hint) payload.error.hint = hint
  console.error(JSON.stringify(payload))
  process.exitCode = 1
}

/** Report a customer-command failure (store failures keep their documented hints). */
function reportCustomerFailure(error) {
  if (isStoreWriteFailure(error)) { exitStoreWriteFailure(error); return }
  const code = typeof error?.code === 'string' ? error.code : 'E_UNKNOWN'
  let message = String(error?.message ?? error)
  if (message.startsWith(code + ': ')) message = message.slice(code.length + 2)
  const hintMarker = message.lastIndexOf(' (hint: ')
  if (hintMarker !== -1 && message.endsWith(')')) message = message.slice(0, hintMarker)
  customerFail(code, message, typeof error?.hint === 'string' ? error.hint : undefined)
}

/** Customer entities are SQLite-only; the legacy JSON store has no tables. */
function customerStoreOrFail() {
  if (mode === 'sqlite') return true
  customerFail('E_STORE', '客户/项目实体只存在于 SQLite 账本（ADVISERS_STORE=sqlite）；JSON store 没有这些表。', 'advisers init')
  return false
}

/** Parse one --flag as an integer inside [min,max]; undefined -> fallback. */
function customerIntegerFlag(value, name, min, max, fallback, usage) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw customerError('E_USAGE', '--' + name + ' must be an integer ' + min + '..' + max, usage)
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) {
    throw customerError('E_USAGE', '--' + name + ' must be an integer ' + min + '..' + max, usage)
  }
  return number
}

/** Parse a comma-separated list flag (undefined stays undefined). */
function customerCommaList(value, name, usage) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw customerError('E_USAGE', '--' + name + ' requires a comma-separated value', usage)
  const list = value.split(',').map((item) => item.trim()).filter(Boolean)
  if (!list.length) throw customerError('E_USAGE', '--' + name + ' requires at least one value', usage)
  return list
}

/** Strict subcommand flag parsing: unknown options fail closed with E_USAGE. */
function customerFlags(args, spec, usage) {
  const parsed = parseStrictFlags(args, spec)
  if (!parsed.ok) throw customerError('E_USAGE', parsed.error, usage)
  return parsed
}

/** Required positional id (trimmed); E_USAGE when missing. */
function customerIdArg(parts, index, name, usage) {
  const value = parts[index]
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw customerError('E_USAGE', name + ' is required', usage)
  return id
}

/** Effective secrecy of a matter for one client: max(default, matter level). */
function effectiveMatterSecrecy(client, matter) {
  const clientLevel = Number(client?.secrecyDefault ?? 0)
  const matterLevel = matter?.secrecy === undefined || matter?.secrecy === null ? 0 : Number(matter.secrecy)
  if (!Number.isFinite(clientLevel) || !Number.isFinite(matterLevel)) return Number.POSITIVE_INFINITY
  return Math.max(clientLevel, matterLevel)
}

function customerSqlIn(ids) {
  return ids.map(() => '?').join(',')
}

function customerCountRows(store, table, matterIds) {
  if (!matterIds.length) return 0
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE matter_id IN (' + customerSqlIn(matterIds) + ')').get(...matterIds)
  return Number(row?.n ?? 0)
}

function customerNextDueAt(openRows) {
  let next = null
  for (const row of openRows) {
    const ms = dueInstantOfValue(row.due_at ?? row.dueAt)
    if (ms !== null && (next === null || ms < next)) next = ms
  }
  return next === null ? null : toShanghaiIso(next)
}

/** mine = we owe the client; waiting = the client owes us (debtor third:*). */
function customerSplitOpen(openRows, matterById) {
  const rows = openRows.map((row) => ({
    id: row.id,
    action: row.action,
    debtor: row.debtor,
    creditor: row.creditor,
    status: 'open',
    ...(row.matter_id === null || row.matter_id === undefined ? {} : { matterId: row.matter_id }),
    ...(row.due_at === null || row.due_at === undefined ? {} : { dueAt: row.due_at }),
  }))
  const matters = [...matterById.values()].map((matter) => ({
    id: matter.id,
    ...(matter.projectId === undefined ? {} : { projectId: matter.projectId }),
    ...(matter.status === undefined ? {} : { status: matter.status }),
    ...(matter.secrecy === undefined ? {} : { secrecy: matter.secrecy }),
  }))
  return core.splitOpenCommitments(rows, matters)
}

function customerOverdueCount(rows) {
  const nowMs = Date.now()
  return rows.filter((row) => {
    const ms = dueInstantOfValue(row.dueAt)
    return ms !== null && ms < nowMs
  }).length
}

/** Map raw rows to the core timeline input shapes (no unmapped column leaks). */
function customerCommitmentEvent(row) {
  return {
    id: row.id,
    matterId: row.matter_id,
    action: row.action,
    debtor: row.debtor,
    creditor: row.creditor,
    status: row.status,
    ...(row.due_at === null || row.due_at === undefined ? {} : { dueAt: row.due_at }),
    ...(row.done_at === null || row.done_at === undefined ? {} : { doneAt: row.done_at }),
    ...(row.created_at === null || row.created_at === undefined ? {} : { createdAt: row.created_at }),
  }
}

function customerDeliveryEvent(row) {
  return {
    id: row.id,
    matterId: row.matter_id,
    createdAt: row.created_at,
    ...(row.title === null || row.title === undefined ? {} : { title: row.title }),
    ...(row.tool === null || row.tool === undefined ? {} : { tool: row.tool }),
    ...(row.template_name === null || row.template_name === undefined ? {} : { templateName: row.template_name }),
  }
}

function customerNoteEvent(row) {
  return {
    id: row.id,
    at: row.at,
    summary: row.summary,
    ...(row.kind === undefined ? {} : { kind: row.kind }),
    ...(row.projectId === undefined ? {} : { projectId: row.projectId }),
    ...(row.matterId === undefined ? {} : { matterId: row.matterId }),
  }
}

function customerNoteRow(row) {
  let source
  if (row.source) {
    try { source = JSON.parse(row.source) } catch { source = undefined }
  }
  return {
    id: row.id,
    clientId: row.client_id,
    kind: row.kind,
    at: row.at,
    summary: row.summary,
    createdAt: row.created_at,
    ...(row.project_id === null || row.project_id === undefined ? {} : { projectId: row.project_id }),
    ...(row.matter_id === null || row.matter_id === undefined ? {} : { matterId: row.matter_id }),
    ...(source === undefined ? {} : { source: source }),
    ...(row.deleted_at === null || row.deleted_at === undefined ? {} : { deletedAt: row.deleted_at }),
  }
}

/** Load the matter-scoped rows a client/project view derives from (bounded). */
function customerMatterRows(store, matterIds, limit) {
  if (!matterIds.length) return { commitments: [], deliveries: [], open: [] }
  const marks = customerSqlIn(matterIds)
  return {
    commitments: store.db.prepare(
      'SELECT id, matter_id, action, debtor, creditor, status, due_at, done_at, created_at FROM commitments WHERE matter_id IN (' + marks + ') ORDER BY (created_at IS NULL), created_at DESC, rowid DESC LIMIT ?'
    ).all(...matterIds, limit),
    deliveries: store.db.prepare(
      'SELECT id, matter_id, client_id, project_id, title, tool, template_name, created_at FROM deliveries WHERE matter_id IN (' + marks + ') ORDER BY created_at DESC, rowid DESC LIMIT ?'
    ).all(...matterIds, limit),
    open: store.db.prepare(
      "SELECT id, matter_id, action, debtor, creditor, due_at FROM commitments WHERE matter_id IN (" + marks + ") AND status = 'open' ORDER BY rowid"
    ).all(...matterIds),
  }
}

/** One read snapshot of a client's rows (every query scoped by its own matters). */
function readClientView(store, clientId) {
  const client = store.getClient(String(clientId))
  if (!client) throw customerError('E_CLIENT_NOT_FOUND', 'unknown client: ' + String(clientId), 'advisers client list')
  const projects = store.listProjects({ clientId: client.id, status: 'all', includeDeleted: true, limit: 1000 })
  const matters = store.listMattersByClient(client.id)
  const rows = customerMatterRows(store, matters.map((matter) => matter.id), CUSTOMER_SOURCE_LIMIT)
  const notes = store.listClientNotes({ clientId: client.id, limit: CUSTOMER_SOURCE_LIMIT })
  return {
    client: client,
    projects: projects,
    matters: matters,
    matterById: new Map(matters.map((matter) => [matter.id, matter])),
    commitments: rows.commitments,
    deliveries: rows.deliveries,
    open: rows.open,
    notes: notes,
  }
}

/** Notes of one project: explicit project_id OR a matter belonging to the project. */
function customerProjectNotes(store, project, matterIds, limit) {
  let sql = 'SELECT id, client_id, project_id, matter_id, kind, at, summary, source, created_at, deleted_at FROM client_notes WHERE client_id = ? AND deleted_at IS NULL AND project_id = ?'
  const params = [project.clientId, project.id]
  if (matterIds.length) {
    sql = 'SELECT id, client_id, project_id, matter_id, kind, at, summary, source, created_at, deleted_at FROM client_notes WHERE client_id = ? AND deleted_at IS NULL AND (project_id = ? OR matter_id IN (' + customerSqlIn(matterIds) + '))'
    params.push(...matterIds)
  }
  return store.db.prepare(sql + ' ORDER BY at DESC, rowid DESC LIMIT ?').all(...params, limit).map(customerNoteRow)
}

/** One read snapshot of a project's rows (matter/project scoped). */
function readProjectView(store, projectId) {
  const project = store.getProject(String(projectId))
  if (!project) throw customerError('E_PROJECT_NOT_FOUND', 'unknown project: ' + String(projectId), 'advisers project list')
  const client = store.getClient(project.clientId)
  const matters = store.listMattersByProject(project.id)
  const matterIds = matters.map((matter) => matter.id)
  const rows = customerMatterRows(store, matterIds, CUSTOMER_SOURCE_LIMIT)
  return {
    project: project,
    client: client,
    matters: matters,
    matterById: new Map(matters.map((matter) => [matter.id, matter])),
    commitments: rows.commitments,
    deliveries: rows.deliveries,
    open: rows.open,
    notes: customerProjectNotes(store, project, matterIds, CUSTOMER_SOURCE_LIMIT),
  }
}

function customerCountClientNotes(store, client, allowedSet, clearance) {
  const groups = store.db.prepare('SELECT matter_id, COUNT(*) AS n FROM client_notes WHERE client_id = ? AND deleted_at IS NULL GROUP BY matter_id').all(client.id)
  const clientLevel = Number(client?.secrecyDefault ?? 0)
  let count = 0
  for (const group of groups) {
    if (group.matter_id === null || group.matter_id === undefined) {
      if (clientLevel <= clearance) count += Number(group.n)
    } else if (allowedSet.has(group.matter_id)) {
      count += Number(group.n)
    }
  }
  return count
}

function customerCountProjectNotes(store, project, allowedSet, clearance, client) {
  const ids = [...allowedSet]
  let sql = 'SELECT matter_id, COUNT(*) AS n FROM client_notes WHERE client_id = ? AND deleted_at IS NULL AND project_id = ? GROUP BY matter_id'
  let params = [project.clientId, project.id]
  if (ids.length) {
    sql = 'SELECT matter_id, COUNT(*) AS n FROM client_notes WHERE client_id = ? AND deleted_at IS NULL AND (project_id = ? OR matter_id IN (' + customerSqlIn(ids) + ')) GROUP BY matter_id'
    params = [project.clientId, project.id, ...ids]
  }
  const clientLevel = Number(client?.secrecyDefault ?? 0)
  let count = 0
  for (const group of store.db.prepare(sql).all(...params)) {
    if (group.matter_id === null || group.matter_id === undefined) {
      if (clientLevel <= clearance) count += Number(group.n)
    } else if (allowedSet.has(group.matter_id)) {
      count += Number(group.n)
    }
  }
  return count
}

/**
 * Apply the opt-in clearance gate to one client/project view BEFORE counting,
 * paging or limiting: a withheld matter takes its commitments/deliveries/notes
 * with it, and only the COUNT is reported (never an id/title/name/quote).
 */
function clearCustomerView(view, clearance) {
  const allowed = []
  const allowedIds = new Set()
  let protectedExcluded = 0
  for (const matter of view.matters) {
    if (effectiveMatterSecrecy(view.client, matter) <= clearance) {
      allowed.push(matter)
      allowedIds.add(matter.id)
    } else {
      protectedExcluded++
    }
  }
  const clientLevel = Number(view.client?.secrecyDefault ?? 0)
  const notes = view.notes.filter((note) => {
    if (note.matterId !== undefined && note.matterId !== null) return allowedIds.has(note.matterId)
    if (clientLevel <= clearance) return true
    protectedExcluded++
    return false
  })
  return {
    ...view,
    matters: allowed,
    matterById: new Map(allowed.map((matter) => [matter.id, matter])),
    allowedIds: allowedIds,
    commitments: view.commitments.filter((row) => allowedIds.has(row.matter_id)),
    deliveries: view.deliveries.filter((row) => allowedIds.has(row.matter_id)),
    open: view.open.filter((row) => allowedIds.has(row.matter_id)),
    notes: notes,
    protectedExcluded: protectedExcluded,
  }
}

/** Exact counts for one filtered client view (SQL counts, not the bounded page). */
function customerClientCounts(store, view, filtered, clearance) {
  const { mine, waiting } = customerSplitOpen(filtered.open, view.matterById)
  return {
    matters: filtered.matters.length,
    mattersArchived: filtered.matters.filter((matter) => matter.status === 'archived').length,
    deliveries: customerCountRows(store, 'deliveries', [...filtered.allowedIds]),
    notes: customerCountClientNotes(store, view.client, filtered.allowedIds, clearance),
    commitments: customerCountRows(store, 'commitments', [...filtered.allowedIds]),
    openMine: mine.length,
    openWaiting: waiting.length,
    overdue: customerOverdueCount([...mine, ...waiting]),
  }
}

/** Exact counts for one filtered project view. */
function customerProjectCounts(store, view, filtered, clearance) {
  const matters = filtered.matters
  const allowedIds = matters.map((matter) => matter.id)
  const allowedSet = new Set(allowedIds)
  const openRows = filtered.open.filter((row) => allowedSet.has(row.matter_id))
  const { mine, waiting } = customerSplitOpen(openRows, view.matterById)
  return {
    matters: matters.length,
    mattersArchived: matters.filter((matter) => matter.status === 'archived').length,
    deliveries: customerCountRows(store, 'deliveries', allowedIds),
    notes: customerCountProjectNotes(store, view.project, allowedSet, clearance, view.client),
    commitments: customerCountRows(store, 'commitments', allowedIds),
    openMine: mine.length,
    openWaiting: waiting.length,
    overdue: customerOverdueCount([...mine, ...waiting]),
  }
}

/** Derive the merged timeline from the filtered snapshot (pure core function). */
function customerTimeline(view, filtered, options = {}) {
  const clientLevel = Number(view.client?.secrecyDefault ?? 0)
  const derived = core.deriveClientTimeline({
    matters: filtered.matters.map((matter) => ({
      id: matter.id,
      status: matter.status,
      ...(matter.secrecy === undefined ? {} : { secrecy: matter.secrecy }),
      ...(matter.projectId === undefined ? {} : { projectId: matter.projectId }),
    })),
    commitments: filtered.commitments.map(customerCommitmentEvent),
    deliveries: filtered.deliveries.map(customerDeliveryEvent),
    notes: filtered.notes.map(customerNoteEvent),
  }, {
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    defaultLimit: options.defaultLimit === undefined ? CUSTOMER_TIMELINE_DEFAULT : options.defaultLimit,
    maxLimit: CUSTOMER_TIMELINE_MAX,
  })
  // Effective secrecy includes the client default; a withheld row never reaches
  // this point, so the label can never understate the real protection level.
  const items = derived.items.map((item) => {
    const matter = item.matterId === undefined ? undefined : view.matterById.get(item.matterId)
    const secrecy = matter ? effectiveMatterSecrecy(view.client, matter) : clientLevel
    return { ...item, secrecy: secrecy }
  })
  return { items: items, total: derived.total, truncated: derived.truncated, degraded: derived.degraded }
}

function customerOpenBuckets(view, filtered) {
  const { mine, waiting } = customerSplitOpen(filtered.open, view.matterById)
  const decorate = (row) => {
    const matter = row.matterId === undefined ? undefined : view.matterById.get(row.matterId)
    const secrecy = matter ? effectiveMatterSecrecy(view.client, matter) : Number(view.client?.secrecyDefault ?? 0)
    return { ...row, secrecy: secrecy }
  }
  return { mine: mine.map(decorate), waiting: waiting.map(decorate) }
}

/** Parse --since as a relative window (90d / 24h) or an ISO timestamp. */
function customerSince(value, usage) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw customerError('E_USAGE', '--since requires an ISO timestamp or a relative window like 90d', usage)
  const text = value.trim()
  const relative = /^([0-9]+)([dh])$/i.exec(text)
  if (relative) {
    const amount = Number(relative[1])
    const unitMs = relative[2].toLowerCase() === 'd' ? 86400000 : 3600000
    return Date.now() - amount * unitMs
  }
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) throw customerError('E_USAGE', '--since is not a valid timestamp or relative window (90d / 24h / ISO)', usage)
  return ms
}

/** Parse --kind against the kinds this build derives (facts are 0.3.x). */
function customerTimelineKinds(value, usage) {
  if (value === undefined) return undefined
  const allowed = ['delivery', 'note', 'commitment']
  const kinds = String(value).split(',').map((item) => item.trim()).filter(Boolean)
  if (!kinds.length) throw customerError('E_USAGE', '--kind requires at least one value (' + allowed.join(',') + ')', usage)
  for (const kind of kinds) {
    if (!allowed.includes(kind)) throw customerError('E_USAGE', 'unknown timeline kind: ' + kind, usage + ' (allowed: ' + allowed.join(',') + ')')
  }
  return kinds
}

function customerTimelineLines(items, emptyText) {
  if (!items.length) return ['（' + (emptyText || '时间线为空') + '）']
  return items.map((item) => {
    const at = String(item.at).replace('T', ' ').slice(0, 16)
    const status = item.kind === 'commitment' && item.status ? ' [' + item.status + ']' : ''
    return '  ' + at + '  ' + String(item.kind).padEnd(10) + ' ' + item.title + status
  })
}

function customerClearanceLines(payload) {
  const lines = []
  if (payload.protectedExcluded) lines.push('clearance=' + payload.clearance + ' · 已隐藏 ' + payload.protectedExcluded + ' 个受保护对象（只报计数，不展示内容）')
  if (payload.degraded && payload.degraded.length) lines.push('降级（无法放置到时间线的行）：' + payload.degraded.join(', '))
  return lines
}

function customerDescribeOpen(open, limit) {
  const lines = []
  if (open.mine.length) {
    lines.push('未完成 · 我方欠客户（' + open.mine.length + '）：')
    for (const row of open.mine.slice(0, limit)) lines.push('  ' + row.id + '  ' + row.action + (row.dueAt ? ' · 截止 ' + row.dueAt : '') + (row.projectId ? ' [' + row.projectId + ']' : ''))
  }
  if (open.waiting.length) {
    lines.push('未完成 · 等对方（' + open.waiting.length + '）：')
    for (const row of open.waiting.slice(0, limit)) lines.push('  ' + row.id + '  ' + row.action + (row.dueAt ? ' · 截止 ' + row.dueAt : '') + (row.projectId ? ' [' + row.projectId + ']' : ''))
  }
  return lines
}

function customerPrint(asJson, payload, lines) {
  if (asJson) { console.log(JSON.stringify(payload, null, 2)); return }
  for (const line of lines) console.log(line)
}

/* ---------------------------- client commands ---------------------------- */

function clientUsage() {
  console.log('usage: advisers client <add|list|show|timeline|archive|merge|note> ...')
  console.log('  ' + CUSTOMER_USAGE.add)
  console.log('  ' + CUSTOMER_USAGE.list)
  console.log('  ' + CUSTOMER_USAGE.show)
  console.log('  ' + CUSTOMER_USAGE.timeline)
  console.log('  ' + CUSTOMER_USAGE.archive)
  console.log('  ' + CUSTOMER_USAGE.merge)
  console.log('  ' + CUSTOMER_USAGE.note)
  console.log('  ' + CUSTOMER_USAGE.noteList)
  console.log('  ' + CUSTOMER_USAGE.export)
  console.log('客户是归属维度：matter 通过 --client/--project 挂到客户；commitments/facts 仍只挂 matter。')
}

function clientAdd(rest) {
  const usage = CUSTOMER_USAGE.add
  try {
    const parsed = customerFlags(rest, { booleans: ['json'], values: ['aliases', 'tags', 'secrecy', 'note', 'link-matter'] }, usage)
    const name = parsed.positional.join(' ').trim()
    if (!name) throw customerError('E_USAGE', 'a client name is required', usage)
    const aliases = customerCommaList(parsed.flags.aliases, 'aliases', usage)
    const tags = customerCommaList(parsed.flags.tags, 'tags', usage)
    const secrecyDefault = customerIntegerFlag(parsed.flags.secrecy, 'secrecy', 0, 3, 0, usage)
    const notes = typeof parsed.flags.note === 'string' ? parsed.flags.note : undefined
    const linkMatter = typeof parsed.flags['link-matter'] === 'string' ? parsed.flags['link-matter'].trim() : undefined
    if (!customerStoreOrFail()) return
    const audit = { actor: 'local', action: 'client.add', allowed: true, reason: '' }
    const made = mutateWithAudit((store) => {
      const client = store.addClient({ name: name, aliases: aliases, tags: tags, secrecyDefault: secrecyDefault, notes: notes })
      let matter = null
      if (linkMatter) {
        matter = store.setMatterClient(linkMatter, { clientId: client.id })
        audit.reason = client.id + ';matter=' + matter.id
      } else {
        audit.reason = client.id
      }
      return { client: client, matter: matter }
    }, audit)
    const result = made.result
    const payload = { ok: true, command: 'client add', client: result.client }
    if (result.matter) payload.matter = result.matter
    const lines = ['created ' + result.client.id + '  ' + result.client.name + (result.client.aliases.length ? '  (' + result.client.aliases.join('/') + ')' : '')]
    if (result.matter) lines.push('linked matter ' + result.matter.id + '  ' + result.matter.title)
    customerPrint(parsed.flags.json === true, payload, lines)
  } catch (error) { reportCustomerFailure(error) }
}

/* ---------------------------- client views ------------------------------- */

/** One derived list row: client row + exact counts + next due + clearance info. */
function clientListRow(store, client) {
  const clearance = CUSTOMER_DEFAULT_CLEARANCE
  const view = readClientView(store, client.id)
  const filtered = clearCustomerView(view, clearance)
  return {
    ...client,
    counts: customerClientCounts(store, view, filtered, clearance),
    nextDueAt: customerNextDueAt(filtered.open),
    clearance: clearance,
    protectedExcluded: filtered.protectedExcluded,
  }
}

/** One project row inside a cleared client view (counts scoped to that project). */
function customerProjectOfClientCounts(store, view, filtered, project, clearance) {
  const matters = filtered.matters.filter((matter) => matter.projectId === project.id)
  const allowedIds = matters.map((matter) => matter.id)
  const allowedSet = new Set(allowedIds)
  const openRows = filtered.open.filter((row) => allowedSet.has(row.matter_id))
  const { mine, waiting } = customerSplitOpen(openRows, filtered.matterById)
  return {
    counts: {
      matters: matters.length,
      mattersArchived: matters.filter((matter) => matter.status === 'archived').length,
      deliveries: customerCountRows(store, 'deliveries', allowedIds),
      notes: customerCountProjectNotes(store, project, allowedSet, clearance, view.client),
      commitments: customerCountRows(store, 'commitments', allowedIds),
      openMine: mine.length,
      openWaiting: waiting.length,
      overdue: customerOverdueCount([...mine, ...waiting]),
    },
    nextDueAt: customerNextDueAt(openRows),
  }
}

function clientList(rest) {
  const usage = CUSTOMER_USAGE.list
  try {
    const parsed = customerFlags(rest, { booleans: ['json', 'all'], values: ['limit'] }, usage)
    const limit = customerIntegerFlag(parsed.flags.limit, 'limit', 1, CUSTOMER_MAX_LIMIT, CUSTOMER_DEFAULT_LIMIT, usage)
    if (!customerStoreOrFail()) return
    const store = readStoreOrExit()
    const all = parsed.flags.all === true
    const rows = store.read(() => store.listClients({ status: all ? 'all' : 'active', includeDeleted: all, limit: limit }).map((client) => clientListRow(store, client)))
    const lines = rows.length
      ? rows.map((row) => row.id + '  ' + row.status + '  secrecy=' + row.secrecyDefault + '  matters=' + row.counts.matters + '  open=' + (row.counts.openMine + row.counts.openWaiting) + '  next=' + (row.nextDueAt || '-') + '  ' + row.name + (row.aliases.length ? ' (' + row.aliases.join('/') + ')' : ''))
      : ['（没有客户）']
    customerPrint(parsed.flags.json === true, rows, lines)
  } catch (error) { reportCustomerFailure(error) }
}

async function clientShow(rest) {
  const usage = CUSTOMER_USAGE.show
  try {
    const parsed = customerFlags(rest, { booleans: ['json'], values: ['timeline-limit', 'clearance'] }, usage)
    const id = customerIdArg(parsed.positional, 0, 'a client id', usage)
    const clearance = customerIntegerFlag(parsed.flags.clearance, 'clearance', 0, 3, CUSTOMER_DEFAULT_CLEARANCE, usage)
    const timelineLimit = customerIntegerFlag(parsed.flags['timeline-limit'], 'timeline-limit', 0, CUSTOMER_TIMELINE_MAX, CUSTOMER_TIMELINE_DEFAULT, usage)
    if (!customerStoreOrFail()) return
    const store = readStoreOrExit()
    // 0.4.0 additive: money summary (no amounts beyond per-currency totals; the
    // lib also fails closed above clearance and only counts hidden rows).
    const money = await loadReceivablesLib().catch(() => null)
    const payload = store.read(() => {
      const view = readClientView(store, id)
      const filtered = clearCustomerView(view, clearance)
      const counts = customerClientCounts(store, view, filtered, clearance)
      const timeline = customerTimeline(view, filtered, { limit: timelineLimit })
      const open = customerOpenBuckets(view, filtered)
      const projects = view.projects.map((project) => {
        const summary = customerProjectOfClientCounts(store, view, filtered, project, clearance)
        return { ...project, counts: summary.counts, nextDueAt: summary.nextDueAt }
      })
      const matters = filtered.matters.map((matter) => {
        const openRows = filtered.open.filter((row) => row.matter_id === matter.id)
        return {
          id: matter.id,
          title: matter.title,
          status: matter.status,
          secrecy: Number(matter.secrecy ?? 0),
          projectId: matter.projectId ?? null,
          openCommitments: openRows.length,
          nextDueAt: customerNextDueAt(openRows),
        }
      })
      return {
        ok: true,
        command: 'client show',
        client: view.client,
        projects: projects,
        matters: matters,
        counts: counts,
        open: open,
        nextDueAt: customerNextDueAt(filtered.open),
        timeline: timeline.items,
        timelineTotal: timeline.total,
        timelineTruncated: timeline.truncated,
        nextCursor: null,
        clearance: clearance,
        protectedExcluded: filtered.protectedExcluded,
        degraded: timeline.degraded,
        ...(money ? { receivables: money.clientReceivablesBlock(store, id, { clearance }) } : {}),
      }
    })
    const lines = []
    lines.push(payload.client.name + '  ' + payload.client.id + '  ' + payload.client.status)
    lines.push('保密默认 ' + payload.client.secrecyDefault + ' · 标签 ' + (payload.client.tags.length ? payload.client.tags.join(',') : '-') + (payload.client.notes ? ' · 备注 ' + payload.client.notes : ''))
    lines.push('事项 ' + payload.counts.matters + '（归档 ' + payload.counts.mattersArchived + '） · 未完成 我方 ' + payload.counts.openMine + ' / 对方 ' + payload.counts.openWaiting + ' · 逾期 ' + payload.counts.overdue + ' · 交付 ' + payload.counts.deliveries + ' · 备注 ' + payload.counts.notes + ' · 下一截止 ' + (payload.nextDueAt || '无'))
    if (payload.projects.length) {
      lines.push('项目（' + payload.projects.length + '）：')
      for (const project of payload.projects) {
        lines.push('  ' + project.id + '  ' + project.name + '  ' + project.status + '  matters=' + project.counts.matters + '  open=' + (project.counts.openMine + project.counts.openWaiting) + '  next=' + (project.nextDueAt || '-'))
      }
    }
    lines.push(...customerDescribeOpen(payload.open, 10))
    lines.push('时间线（显示 ' + payload.timeline.length + ' / 匹配 ' + payload.timelineTotal + '）：')
    lines.push(...customerTimelineLines(payload.timeline))
    lines.push(...customerClearanceLines(payload))
    customerPrint(parsed.flags.json === true, payload, lines)
  } catch (error) { reportCustomerFailure(error) }
}

function clientTimeline(rest) {
  const usage = CUSTOMER_USAGE.timeline
  try {
    const parsed = customerFlags(rest, { booleans: ['json'], values: ['since', 'kind', 'limit', 'clearance'] }, usage)
    const id = customerIdArg(parsed.positional, 0, 'a client id', usage)
    const clearance = customerIntegerFlag(parsed.flags.clearance, 'clearance', 0, 3, CUSTOMER_DEFAULT_CLEARANCE, usage)
    const limit = customerIntegerFlag(parsed.flags.limit, 'limit', 0, CUSTOMER_TIMELINE_MAX, CUSTOMER_TIMELINE_DEFAULT, usage)
    const since = customerSince(typeof parsed.flags.since === 'string' ? parsed.flags.since : undefined, usage)
    const kinds = customerTimelineKinds(typeof parsed.flags.kind === 'string' ? parsed.flags.kind : undefined, usage)
    if (!customerStoreOrFail()) return
    const store = readStoreOrExit()
    const payload = store.read(() => {
      const view = readClientView(store, id)
      const filtered = clearCustomerView(view, clearance)
      const timeline = customerTimeline(view, filtered, { since: since, kinds: kinds, limit: limit })
      return {
        ok: true,
        command: 'client timeline',
        clientId: view.client.id,
        client: { id: view.client.id, name: view.client.name },
        items: timeline.items,
        total: timeline.total,
        truncated: timeline.truncated,
        nextCursor: null,
        clearance: clearance,
        protectedExcluded: filtered.protectedExcluded,
        degraded: timeline.degraded,
      }
    })
    const lines = [payload.client.name + ' 时间线（显示 ' + payload.items.length + ' / 匹配 ' + payload.total + (payload.truncated ? '，已截断' : '') + '）：']
    lines.push(...customerTimelineLines(payload.items))
    lines.push(...customerClearanceLines(payload))
    customerPrint(parsed.flags.json === true, payload, lines)
  } catch (error) { reportCustomerFailure(error) }
}

/** Shared archive precondition: active projects block archiving (fail closed). */
function clientActiveProjects(store, clientId) {
  return store.listProjects({ clientId: clientId, status: 'active', limit: 1000 })
}

function clientArchive(rest) {
  const usage = CUSTOMER_USAGE.archive
  try {
    const parsed = customerFlags(rest, { booleans: ['json', 'dry-run'], values: [] }, usage)
    const id = customerIdArg(parsed.positional, 0, 'a client id', usage)
    if (!customerStoreOrFail()) return
    const dryRun = parsed.flags['dry-run'] === true
    if (dryRun) {
      const store = readStoreOrExit()
      const plan = store.read(() => {
        const client = store.getClient(id)
        if (!client) throw customerError('E_CLIENT_NOT_FOUND', 'unknown client: ' + id, 'advisers client list')
        return { client: client, activeProjects: clientActiveProjects(store, id) }
      })
      const payload = {
        ok: true,
        command: 'client archive',
        dryRun: true,
        client: plan.client,
        activeProjects: plan.activeProjects.length,
        wouldBlock: plan.activeProjects.length > 0,
      }
      const lines = ['would archive ' + plan.client.id + '  ' + plan.client.name + '（dry-run，未写入）']
      if (payload.wouldBlock) lines.push('注意：还有 ' + payload.activeProjects + ' 个 active 项目，正式执行会被拒绝（E_CLIENT_HAS_ACTIVE_PROJECTS）')
      customerPrint(parsed.flags.json === true, payload, lines)
      return
    }
    const audit = { actor: 'local', action: 'client.archive', allowed: true, reason: id }
    const made = mutateWithAudit((store) => {
      const client = store.getClient(id)
      if (!client) throw customerError('E_CLIENT_NOT_FOUND', 'unknown client: ' + id, 'advisers client list')
      const activeProjects = clientActiveProjects(store, id)
      if (activeProjects.length) {
        throw customerError('E_CLIENT_HAS_ACTIVE_PROJECTS', 'client has ' + activeProjects.length + ' active project(s); archive them first', 'advisers project list --client ' + id)
      }
      return store.archiveClient(id)
    }, audit)
    const payload = { ok: true, command: 'client archive', client: made.result }
    customerPrint(parsed.flags.json === true, payload, ['archived ' + made.result.id + '  ' + made.result.name])
  } catch (error) { reportCustomerFailure(error) }
}

function clientMerge(rest) {
  const usage = CUSTOMER_USAGE.merge
  try {
    const parsed = customerFlags(rest, { booleans: ['json', 'dry-run'], values: [] }, usage)
    const fromId = customerIdArg(parsed.positional, 0, 'a source client id', usage)
    const intoId = customerIdArg(parsed.positional, 1, 'a target client id', usage)
    if (fromId === intoId) throw customerError('E_CLIENT_MERGE_SELF', 'cannot merge a client into itself', usage)
    if (!customerStoreOrFail()) return
    const dryRun = parsed.flags['dry-run'] === true
    if (dryRun) {
      const store = readStoreOrExit()
      const plan = store.read(() => {
        const source = store.getClient(fromId)
        if (!source) throw customerError('E_CLIENT_NOT_FOUND', 'unknown client: ' + fromId, 'advisers client list')
        const target = store.getClient(intoId)
        if (!target) throw customerError('E_CLIENT_NOT_FOUND', 'unknown client: ' + intoId, 'advisers client list')
        if (target.status !== 'active' || target.deletedAt) throw customerError('E_CLIENT_ARCHIVED', 'target client is archived: ' + intoId, 'advisers client list')
        const sourceProjects = store.listProjects({ clientId: fromId, status: 'all', includeDeleted: true, limit: 1000 })
        const targetProjects = store.listProjects({ clientId: intoId, status: 'active', limit: 1000 })
        const targetNames = new Set(targetProjects.map((project) => project.nameNorm))
        let movedProjects = 0
        let mergedProjects = 0
        for (const project of sourceProjects) {
          if (targetNames.has(project.nameNorm)) mergedProjects++
          else movedProjects++
        }
        const countClientRows = (table) => Number(store.db.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE client_id = ?').get(fromId)?.n ?? 0)
        return {
          source: source,
          target: target,
          plan: {
            movedMatters: Number(store.db.prepare('SELECT COUNT(*) AS n FROM matters WHERE client_id = ?').get(fromId)?.n ?? 0),
            movedProjects: movedProjects,
            mergedProjects: mergedProjects,
            movedNotes: countClientRows('client_notes'),
            movedDeliveries: countClientRows('deliveries'),
          },
        }
      })
      const payload = { ok: true, command: 'client merge', dryRun: true, from: plan.source, into: plan.target, plan: plan.plan }
      const lines = [
        'would merge ' + plan.source.id + '  ' + plan.source.name + '  ->  ' + plan.target.id + '  ' + plan.target.name + '（dry-run，未写入）',
        '  matters=' + plan.plan.movedMatters + '  projects=' + plan.plan.movedProjects + ' (+' + plan.plan.mergedProjects + ' 同名合并)  notes=' + plan.plan.movedNotes + '  deliveries=' + plan.plan.movedDeliveries,
        '  源客户会归档（不删除），名称/别名在不冲突时并入目标客户；不自动合并同名事项。',
      ]
      customerPrint(parsed.flags.json === true, payload, lines)
      return
    }
    const audit = { actor: 'local', action: 'client.merge', allowed: true, reason: fromId + '->' + intoId }
    const made = mutateWithAudit((store) => {
      const result = store.mergeClients(fromId, intoId)
      audit.reason = fromId + '->' + intoId + ';matter=' + result.movedMatters + ';project=' + result.movedProjects + ';note=' + result.movedNotes
      return result
    }, audit)
    const payload = { ok: true, command: 'client merge', ...made.result }
    const lines = [
      'merged ' + made.result.mergedFrom + '  ->  ' + made.result.client.id + '  ' + made.result.client.name,
      '  matters=' + made.result.movedMatters + '  projects=' + made.result.movedProjects + ' (+' + made.result.mergedProjects + ' 同名合并)  notes=' + made.result.movedNotes + '  deliveries=' + made.result.movedDeliveries + '  aliases+' + made.result.carriedAliases,
    ]
    customerPrint(parsed.flags.json === true, payload, lines)
  } catch (error) { reportCustomerFailure(error) }
}

function clientNote(rest) {
  const sub = rest[0]
  if (sub === 'add') return clientNoteAdd(rest.slice(1))
  if (sub === 'list' || sub === 'ls') return clientNoteList(rest.slice(1))
  customerFail('E_USAGE', 'unknown client note subcommand: ' + String(sub), CUSTOMER_USAGE.note + ' / ' + CUSTOMER_USAGE.noteList)
}

function clientNoteAdd(rest) {
  const usage = CUSTOMER_USAGE.note
  try {
    const parsed = customerFlags(rest, { booleans: ['json'], values: ['kind', 'at', 'project', 'matter'] }, usage)
    const clientId = customerIdArg(parsed.positional, 0, 'a client id', usage)
    const summary = parsed.positional.slice(1).join(' ').trim()
    if (!summary) throw customerError('E_USAGE', 'a note summary is required', usage)
    const kind = typeof parsed.flags.kind === 'string' ? parsed.flags.kind : undefined
    const at = typeof parsed.flags.at === 'string' ? parsed.flags.at : undefined
    const projectId = typeof parsed.flags.project === 'string' ? parsed.flags.project.trim() : undefined
    const matterId = typeof parsed.flags.matter === 'string' ? parsed.flags.matter.trim() : undefined
    if (!customerStoreOrFail()) return
    const audit = { actor: 'local', action: 'client.note.add', allowed: true, reason: '' }
    const made = mutateWithAudit((store) => {
      const note = store.addClientNote({ clientId: clientId, summary: summary, kind: kind, at: at, projectId: projectId, matterId: matterId })
      audit.reason = note.id
      return note
    }, audit)
    const payload = { ok: true, command: 'client note add', note: made.result }
    const preview = made.result.summary.replace(/\s+/g, ' ').slice(0, 80)
    customerPrint(parsed.flags.json === true, payload, ['added ' + made.result.id + '  ' + made.result.at + '  [' + made.result.kind + ']  ' + preview])
  } catch (error) { reportCustomerFailure(error) }
}

function clientNoteList(rest) {
  const usage = CUSTOMER_USAGE.noteList
  try {
    const parsed = customerFlags(rest, { booleans: ['json'], values: ['project', 'limit'] }, usage)
    const clientId = customerIdArg(parsed.positional, 0, 'a client id', usage)
    const projectId = typeof parsed.flags.project === 'string' ? parsed.flags.project.trim() : undefined
    const limit = customerIntegerFlag(parsed.flags.limit, 'limit', 1, 500, 50, usage)
    if (!customerStoreOrFail()) return
    const store = readStoreOrExit()
    const rows = store.read(() => {
      const client = store.getClient(clientId)
      if (!client) throw customerError('E_CLIENT_NOT_FOUND', 'unknown client: ' + clientId, 'advisers client list')
      return store.listClientNotes({ clientId: clientId, projectId: projectId, limit: limit })
    })
    const lines = rows.length
      ? rows.map((note) => note.id + '  ' + note.at + '  [' + note.kind + ']  ' + String(note.summary).replace(/\s+/g, ' ').slice(0, 100) + (note.projectId ? '  [' + note.projectId + ']' : ''))
      : ['（没有备注）']
    customerPrint(parsed.flags.json === true, rows, lines)
  } catch (error) { reportCustomerFailure(error) }
}

/**
 * `advisers client export <id>`: deterministic, external-facing client status
 * sheet (markdown or DOCX). It is written at clearance 0, never contains
 * evidence quotes or note bodies, and states its own scope/limits: it is a
 * status summary, not a statement of account, contract or legal advice.
 *
 * The file is created 0600 (directory 0700) and its SHA-256 is reported in the
 * JSON summary so a recipient can verify the bytes out of band.
 */
async function clientExport(rest) {
  const usage = CUSTOMER_USAGE.export
  try {
    const parsed = customerFlags(rest, { booleans: ['json', 'redact-names', 'pack', 'force', 'include-receivables'], values: ['format', 'out'] }, usage)
    if (parsed.flags['include-receivables'] === true) throw customerError('E_CLIENT_PACK_RECEIVABLES_UNSUPPORTED', 'client status packs do not carry receivable/payment amounts in 0.4.0', 'amounts stay local; --include-receivables is reserved until legal review (0.4.1)')
    const id = customerIdArg(parsed.positional, 0, 'a client id', usage)
    const format = parsed.flags.format === undefined ? 'md' : String(parsed.flags.format).toLowerCase()
    if (format !== 'md' && format !== 'docx') throw customerError('E_USAGE', '--format must be md or docx', usage)
    if (parsed.flags.out !== undefined && (typeof parsed.flags.out !== 'string' || !parsed.flags.out.trim())) {
      throw customerError('E_USAGE', '--out requires a file path', usage)
    }
    if (!customerStoreOrFail()) return
    const store = readStoreOrExit()
    const clearance = 0
    const generatedAt = new Date().toISOString()
    const data = store.read(() => {
      const view = readClientView(store, id)
      const filtered = clearCustomerView(view, clearance)
      const counts = customerClientCounts(store, view, filtered, clearance)
      const timeline = customerTimeline(view, filtered, { kinds: ['delivery', 'commitment'], limit: 20 })
      const open = customerOpenBuckets(view, filtered)
      const redact = parsed.flags['redact-names'] === true
      const projectRows = view.projects
        .filter((project) => project.status !== 'archived')
        .map((project) => {
          const summary = customerProjectOfClientCounts(store, view, filtered, project, clearance)
          return {
            id: project.id,
            name: redact ? '（已隐去）' : project.name,
            status: project.status,
            counts: summary.counts,
            nextDueAt: summary.nextDueAt,
          }
        })
      return {
        client: view.client,
        displayName: redact ? '（已隐去）' : view.client.name,
        aliases: redact ? [] : view.client.aliases,
        projects: projectRows,
        counts: counts,
        open: {
          mine: open.mine.map((row) => ({ id: row.id, action: row.action, dueAt: row.dueAt ?? null, projectId: row.projectId ?? null })),
          waiting: open.waiting.map((row) => ({ id: row.id, action: row.action, dueAt: row.dueAt ?? null, projectId: row.projectId ?? null })),
        },
        nextDueAt: customerNextDueAt(filtered.open),
        timeline: timeline.items.map((item) => ({ at: item.at, kind: item.kind, title: item.title, status: item.status ?? null })),
        timelineTotal: timeline.total,
        timelineTruncated: timeline.truncated,
        protectedExcluded: filtered.protectedExcluded,
      }
    })
    const disclaimer = '本文件是状态说明，不是对账单、合同、法律意见或送达证明；本地生成、无签名、未锚定（仅本地自证）。SHA-256 仅用于检测生成后的改动。'
    const scopeLine = '范围：本文件只含客户 ' + data.client.id + '（' + data.displayName + '）的数据；其他客户数据、全局 facts/preferences、对话原文与备注正文不在本文件内。'
    const sections = []
    sections.push({ heading: '概况', paragraphs: [
      '客户：' + data.displayName + ' (' + data.client.id + ') · 状态 ' + data.client.status + (data.aliases.length ? ' · 别名 ' + data.aliases.join('/') : ''),
      '事项 ' + data.counts.matters + '（归档 ' + data.counts.mattersArchived + '） · 未完成 我方 ' + data.counts.openMine + ' / 等待对方 ' + data.counts.openWaiting + ' · 逾期 ' + data.counts.overdue + ' · 交付 ' + data.counts.deliveries + ' · 备注 ' + data.counts.notes + '（仅计数）',
      '下一截止：' + (data.nextDueAt || '无'),
      '受保护事项（clearance=0 不可见，仅计数）：' + data.protectedExcluded,
    ] })
    sections.push({ heading: '进行中的项目', paragraphs: data.projects.length
      ? data.projects.map((project) => project.id + '  ' + project.name + '  ' + project.status + ' · 事项 ' + project.counts.matters + ' · 未完成 ' + (project.counts.openMine + project.counts.openWaiting) + ' · 下一截止 ' + (project.nextDueAt || '无'))
      : ['（没有进行中的项目）'] })
    const openLines = (title, rows) => {
      const out = [title + '（' + rows.length + '）：']
      if (!rows.length) out.push('（无）')
      for (const row of rows.slice(0, 20)) out.push('- ' + (row.dueAt ? row.dueAt + ' ' : '') + row.action + (row.projectId ? ' [' + row.projectId + ']' : ''))
      return out
    }
    sections.push({ heading: '待办', paragraphs: [...openLines('我方欠客户', data.open.mine), ...openLines('等待对方', data.open.waiting)] })
    sections.push({ heading: '最近时间线', paragraphs: data.timeline.length
      ? data.timeline.map((item) => String(item.at).replace('T', ' ').slice(0, 16) + '  ' + item.kind + '  ' + item.title + (item.status ? ' [' + item.status + ']' : ''))
      : ['（没有可展示的时间线条目）'] })
    sections.push({ heading: '边界与校验', paragraphs: [scopeLine, disclaimer, '生成时间：' + generatedAt + ' · advisers ' + VERSION + ' · clearance=0'] })
    const markdown = ['# 客户状态包 · ' + data.displayName, '', '> ' + scopeLine, '> ' + disclaimer, '',
      ...sections.flatMap((section) => ['## ' + section.heading, '', ...section.paragraphs, ''])].join('\n')
    let buffer
    if (format === 'docx') {
      let buildDocx
      try {
        buildDocx = await loadOfficeOperation('docx', 'buildDocx')
      } catch {}
      if (typeof buildDocx !== 'function') {
        throw customerError('E_USAGE', '--format docx 需要可选的 advisers-office 包（当前不可用）', 'advisers client export ' + data.client.id + ' --format md')
      }
      buffer = await buildDocx({ title: '客户状态包 · ' + data.displayName, sections: sections })
    } else {
      buffer = Buffer.from(markdown, 'utf8')
    }
    // 0.4.0: client status pack v2 (directory pack). The pack contains no money
    // fields (amounts stay local in 0.4.0; --include-receivables would fail
    // closed in the library), is written 0700/0600 atomically and self-verified.
    if (parsed.flags.pack === true) {
      const packLib = await loadClientPack()
      const statusPayload = {
        ok: true,
        command: 'client export',
        format: 'json',
        scope: 'client',
        subject: { kind: 'client', id: data.client.id, name: data.displayName },
        generatedAt: generatedAt,
        clearance: clearance,
        protectedExcluded: data.protectedExcluded,
        counts: data.counts,
        projects: data.projects,
        open: data.open,
        nextDueAt: data.nextDueAt,
        timeline: data.timeline,
        timelineTotal: data.timelineTotal,
        timelineTruncated: data.timelineTruncated,
        disclaimer: true,
      }
      const outDir = typeof parsed.flags.out === 'string' && parsed.flags.out.trim()
        ? parsed.flags.out.trim()
        : join(HOME, 'exports', 'client-' + data.client.id + '-' + generatedAt.replace(/[:.]/g, '-'))
      const packResult = packLib.exportClientStatusPack({
        outDir,
        status: statusPayload,
        markdown: markdown,
        ...(format === 'docx' ? { docx: buffer } : {}),
        subject: { kind: 'client', id: data.client.id, name: data.displayName },
        generatedAt: generatedAt,
        overwrite: parsed.flags.force === true,
        env: { advisersVersion: VERSION, command: 'client export --pack' },
      })
      try {
        const writeStore = dbStore()
        if (writeStore) {
          writeStore.appendAudit({
            actor: 'local',
            action: 'client.export',
            allowed: true,
            reason: 'client ' + data.client.id + ' format=pack bytes=' + packResult.bytes + ' files=' + packResult.fileCount + ' protected=' + data.protectedExcluded,
          })
        }
      } catch {}
      const payload = {
        ok: true,
        command: 'client export --pack',
        format: packResult.format,
        version: packResult.version,
        scope: packResult.scope,
        subject: packResult.subject,
        out: packResult.out,
        replaced: packResult.replaced,
        generatedAt: packResult.generatedAt,
        counts: packResult.counts,
        bytes: packResult.bytes,
        fileCount: packResult.fileCount,
        checksumCount: packResult.checksumCount,
        manifestDigest: packResult.manifestDigest,
        verificationBasis: packResult.verificationBasis,
        verification: packResult.verification,
        clearance: clearance,
        protectedExcluded: data.protectedExcluded,
        disclaimer: true,
      }
      const human = [
        '已生成客户状态包目录（pack v1）：' + payload.out,
        '客户：' + data.displayName + ' (' + data.client.id + ') · files=' + payload.fileCount + ' · bytes=' + payload.bytes + ' · manifestDigest=' + String(payload.manifestDigest).slice(0, 16),
        '离线校验：' + (payload.verification.ok ? '通过（仅证明包内 SHA-256 自洽，不是签名/第三方存证）' : '失败：' + (payload.verification.errors ?? []).slice(0, 3).join(' | ')),
        '边界：状态说明，不是对账单/合同/法律意见；不含金额、对话原文与备注正文。',
      ]
      customerPrint(parsed.flags.json === true, payload, human)
      if (!payload.verification.ok) process.exitCode = 1
      return
    }
    const out = typeof parsed.flags.out === 'string'
      ? parsed.flags.out.trim()
      : join(HOME, 'exports', 'client-' + data.client.id + '-' + generatedAt.replace(/[:.]/g, '-') + '.' + format)
    const dir = dirname(out)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try { chmodSync(dir, 0o700) } catch {}
    writeFileSync(out, buffer, { mode: 0o600 })
    try { chmodSync(out, 0o600) } catch {}
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    // A client status sheet is an external-facing artifact: record the export
    // (ids/counts only, no names) even though it does not mutate the ledger.
    try {
      const writeStore = dbStore()
      if (writeStore) {
        writeStore.appendAudit({
          actor: 'local',
          action: 'client.export',
          allowed: true,
          reason: 'client ' + data.client.id + ' format=' + format + ' bytes=' + buffer.length + ' protected=' + data.protectedExcluded,
        })
      }
    } catch {}
    const payload = {
      ok: true,
      command: 'client export',
      format: format,
      scope: 'client',
      subject: { kind: 'client', id: data.client.id, name: data.displayName },
      out: out,
      bytes: buffer.length,
      sha256: sha256,
      generatedAt: generatedAt,
      clearance: clearance,
      protectedExcluded: data.protectedExcluded,
      counts: data.counts,
      nextDueAt: data.nextDueAt,
      timelineCount: data.timeline.length,
      timelineTotal: data.timelineTotal,
      timelineTruncated: data.timelineTruncated,
      disclaimer: true,
    }
    const human = [
      '已生成客户状态包（' + format + '）：' + out,
      '客户：' + data.displayName + ' (' + data.client.id + ') · 事项 ' + data.counts.matters + ' · 未完成 我方 ' + data.counts.openMine + ' / 等待对方 ' + data.counts.openWaiting,
      'clearance=0 · 受保护事项仅计数：' + data.protectedExcluded + ' · sha256=' + sha256,
      '边界：状态说明，不是对账单/合同/法律意见；不含对话原文与备注正文。',
    ]
    customerPrint(parsed.flags.json === true, payload, human)
  } catch (error) { reportCustomerFailure(error) }
}
async function clientCommand(rawArgs) {
  const sub = rawArgs[0]
  const rest = rawArgs.slice(1)
  if (!sub || sub === 'help' || sub === '--help') { clientUsage(); return }
  if (rest.includes('--help') || rest.includes('-h')) {
    const usage = CUSTOMER_USAGE[sub]
    if (usage) console.log(usage)
    else clientUsage()
    return
  }
  if (sub === 'add') return clientAdd(rest)
  if (sub === 'list' || sub === 'ls') return clientList(rest)
  if (sub === 'show') return clientShow(rest)
  if (sub === 'timeline') return clientTimeline(rest)
  if (sub === 'export') return clientExport(rest)
  if (sub === 'archive') return clientArchive(rest)
  if (sub === 'merge') return clientMerge(rest)
  if (sub === 'note') return clientNote(rest)
  customerFail('E_USAGE', 'unknown client subcommand: ' + String(sub), 'advisers client help')
}

/* ---------------------------- project commands --------------------------- */

function projectUsage() {
  console.log('usage: advisers project <add|list|show|archive> ...')
  console.log('  ' + CUSTOMER_USAGE.projectAdd)
  console.log('  ' + CUSTOMER_USAGE.projectList)
  console.log('  ' + CUSTOMER_USAGE.projectShow)
  console.log('  ' + CUSTOMER_USAGE.projectArchive)
  console.log('项目属于一个客户；跨客户工作拆成两个项目。事项用 matter add --client --project 挂到项目。')
}

function projectAdd(rest) {
  const usage = CUSTOMER_USAGE.projectAdd
  try {
    const parsed = customerFlags(rest, { booleans: ['json'], values: ['start', 'end', 'default-matter', 'note'] }, usage)
    const clientId = customerIdArg(parsed.positional, 0, 'a client id', usage)
    const name = parsed.positional.slice(1).join(' ').trim()
    if (!name) throw customerError('E_USAGE', 'a project name is required', usage)
    const startedAt = typeof parsed.flags.start === 'string' ? parsed.flags.start : undefined
    const dueAt = typeof parsed.flags.end === 'string' ? parsed.flags.end : undefined
    const defaultMatterId = typeof parsed.flags['default-matter'] === 'string' ? parsed.flags['default-matter'].trim() : undefined
    const notes = typeof parsed.flags.note === 'string' ? parsed.flags.note : undefined
    if (!customerStoreOrFail()) return
    const audit = { actor: 'local', action: 'project.add', allowed: true, reason: '' }
    const made = mutateWithAudit((store) => {
      const project = store.addProject({ clientId: clientId, name: name, startedAt: startedAt, dueAt: dueAt, defaultMatterId: defaultMatterId, notes: notes })
      audit.reason = project.id
      return project
    }, audit)
    const payload = { ok: true, command: 'project add', project: made.result }
    customerPrint(parsed.flags.json === true, payload, ['created ' + made.result.id + '  ' + made.result.name + '  (client ' + made.result.clientId + ')'])
  } catch (error) { reportCustomerFailure(error) }
}

function projectListRow(store, project, client) {
  const clearance = CUSTOMER_DEFAULT_CLEARANCE
  const view = readProjectView(store, project.id)
  const filtered = clearCustomerView(view, clearance)
  return {
    ...project,
    client: client ? { id: client.id, name: client.name, status: client.status } : null,
    counts: customerProjectCounts(store, view, filtered, clearance),
    nextDueAt: customerNextDueAt(filtered.open),
    clearance: clearance,
    protectedExcluded: filtered.protectedExcluded,
  }
}

function projectList(rest) {
  const usage = CUSTOMER_USAGE.projectList
  try {
    const parsed = customerFlags(rest, { booleans: ['json', 'all'], values: ['client', 'limit'] }, usage)
    const clientId = typeof parsed.flags.client === 'string' ? parsed.flags.client.trim() : undefined
    const limit = customerIntegerFlag(parsed.flags.limit, 'limit', 1, CUSTOMER_MAX_LIMIT, CUSTOMER_DEFAULT_LIMIT, usage)
    if (!customerStoreOrFail()) return
    const store = readStoreOrExit()
    const all = parsed.flags.all === true
    const rows = store.read(() => {
      if (clientId && !store.getClient(clientId)) throw customerError('E_CLIENT_NOT_FOUND', 'unknown client: ' + clientId, 'advisers client list')
      const projects = store.listProjects({ clientId: clientId, status: all ? 'all' : 'active', includeDeleted: all, limit: limit })
      const clientById = new Map(store.listClients({ status: 'all', includeDeleted: true, limit: 1000 }).map((client) => [client.id, client]))
      return projects.map((project) => projectListRow(store, project, clientById.get(project.clientId)))
    })
    const lines = rows.length
      ? rows.map((row) => row.id + '  ' + row.status + '  matters=' + row.counts.matters + '  open=' + (row.counts.openMine + row.counts.openWaiting) + '  next=' + (row.nextDueAt || '-') + '  ' + row.name + (row.client ? '  [' + row.client.name + ']' : ''))
      : ['（没有项目）']
    customerPrint(parsed.flags.json === true, rows, lines)
  } catch (error) { reportCustomerFailure(error) }
}

function projectShow(rest) {
  const usage = CUSTOMER_USAGE.projectShow
  try {
    const parsed = customerFlags(rest, { booleans: ['json'], values: ['timeline-limit', 'clearance'] }, usage)
    const id = customerIdArg(parsed.positional, 0, 'a project id', usage)
    const clearance = customerIntegerFlag(parsed.flags.clearance, 'clearance', 0, 3, CUSTOMER_DEFAULT_CLEARANCE, usage)
    const timelineLimit = customerIntegerFlag(parsed.flags['timeline-limit'], 'timeline-limit', 0, CUSTOMER_TIMELINE_MAX, CUSTOMER_TIMELINE_DEFAULT, usage)
    if (!customerStoreOrFail()) return
    const store = readStoreOrExit()
    const payload = store.read(() => {
      const view = readProjectView(store, id)
      const filtered = clearCustomerView(view, clearance)
      const counts = customerProjectCounts(store, view, filtered, clearance)
      const timeline = customerTimeline(view, filtered, { limit: timelineLimit })
      const open = customerOpenBuckets(view, filtered)
      const matters = filtered.matters.map((matter) => {
        const openRows = filtered.open.filter((row) => row.matter_id === matter.id)
        return {
          id: matter.id,
          title: matter.title,
          status: matter.status,
          secrecy: Number(matter.secrecy ?? 0),
          openCommitments: openRows.length,
          nextDueAt: customerNextDueAt(openRows),
        }
      })
      return {
        ok: true,
        command: 'project show',
        project: view.project,
        client: view.client,
        matters: matters,
        counts: counts,
        open: open,
        nextDueAt: customerNextDueAt(filtered.open),
        timeline: timeline.items,
        timelineTotal: timeline.total,
        timelineTruncated: timeline.truncated,
        nextCursor: null,
        clearance: clearance,
        protectedExcluded: filtered.protectedExcluded,
        degraded: timeline.degraded,
      }
    })
    const lines = []
    lines.push(payload.project.name + '  ' + payload.project.id + '  ' + payload.project.status + (payload.client ? '  [' + payload.client.name + ']' : ''))
    lines.push('事项 ' + payload.counts.matters + '（归档 ' + payload.counts.mattersArchived + '） · 未完成 我方 ' + payload.counts.openMine + ' / 对方 ' + payload.counts.openWaiting + ' · 逾期 ' + payload.counts.overdue + ' · 交付 ' + payload.counts.deliveries + ' · 备注 ' + payload.counts.notes + ' · 下一截止 ' + (payload.nextDueAt || '无'))
    if (payload.matters.length) {
      lines.push('事项：')
      for (const matter of payload.matters) lines.push('  ' + matter.id + '  ' + matter.title + '  ' + matter.status + '  open=' + matter.openCommitments + '  next=' + (matter.nextDueAt || '-'))
    }
    lines.push(...customerDescribeOpen(payload.open, 10))
    lines.push('时间线（显示 ' + payload.timeline.length + ' / 匹配 ' + payload.timelineTotal + '）：')
    lines.push(...customerTimelineLines(payload.timeline))
    lines.push(...customerClearanceLines(payload))
    customerPrint(parsed.flags.json === true, payload, lines)
  } catch (error) { reportCustomerFailure(error) }
}

function projectArchive(rest) {
  const usage = CUSTOMER_USAGE.projectArchive
  try {
    const parsed = customerFlags(rest, { booleans: ['json', 'dry-run'], values: [] }, usage)
    const id = customerIdArg(parsed.positional, 0, 'a project id', usage)
    if (!customerStoreOrFail()) return
    const dryRun = parsed.flags['dry-run'] === true
    if (dryRun) {
      const store = readStoreOrExit()
      const plan = store.read(() => {
        const project = store.getProject(id)
        if (!project) throw customerError('E_PROJECT_NOT_FOUND', 'unknown project: ' + id, 'advisers project list')
        return { project: project, activeMatters: store.listMattersByProject(id, { status: 'active' }).length }
      })
      const payload = { ok: true, command: 'project archive', dryRun: true, project: plan.project, activeMatters: plan.activeMatters }
      const lines = ['would archive ' + plan.project.id + '  ' + plan.project.name + '（dry-run，未写入）']
      if (plan.activeMatters) lines.push('注意：' + plan.activeMatters + ' 个 active 事项仍挂在该项目下（归档项目不会删除事项）')
      customerPrint(parsed.flags.json === true, payload, lines)
      return
    }
    const audit = { actor: 'local', action: 'project.archive', allowed: true, reason: id }
    const made = mutateWithAudit((store) => {
      const project = store.getProject(id)
      if (!project) throw customerError('E_PROJECT_NOT_FOUND', 'unknown project: ' + id, 'advisers project list')
      return store.archiveProject(id)
    }, audit)
    const payload = { ok: true, command: 'project archive', project: made.result }
    customerPrint(parsed.flags.json === true, payload, ['archived ' + made.result.id + '  ' + made.result.name])
  } catch (error) { reportCustomerFailure(error) }
}

function projectCommand(rawArgs) {
  const sub = rawArgs[0]
  const rest = rawArgs.slice(1)
  if (!sub || sub === 'help' || sub === '--help') { projectUsage(); return }
  if (rest.includes('--help') || rest.includes('-h')) {
    const usage = CUSTOMER_USAGE['project' + sub.charAt(0).toUpperCase() + sub.slice(1)]
    if (usage) console.log(usage)
    else projectUsage()
    return
  }
  if (sub === 'add') return projectAdd(rest)
  if (sub === 'list' || sub === 'ls') return projectList(rest)
  if (sub === 'show') return projectShow(rest)
  if (sub === 'archive') return projectArchive(rest)
  customerFail('E_USAGE', 'unknown project subcommand: ' + String(sub), 'advisers project help')
}

// ---------------------------------------------------------------------------
// 0.2.3 P3: 7-day agenda + deterministic morning brief.
//
// Time semantics (design §1.4/§5.4): the display/storage split is fixed to
// Asia/Shanghai. Storage keeps UTC instants; every window boundary, grouping
// decision and label below is computed on the Shanghai calendar day, never on
// new Date().toISOString().slice(0,10) (the 0.2.2 'week' bug). A date-only
// dueAt means "done before 23:59:59.999 local time". RRULE expansion reuses
// lib/ical.js expandRrule; unsupported rules/timezones are degraded, skipped
// and reported, never guessed. No model call, no network call, no writes.
// ---------------------------------------------------------------------------
const AGENDA_TIMEZONE = 'Asia/Shanghai'
const AGENDA_DAY_MS = 86400_000
const AGENDA_OFFSET_MS = 8 * 3600_000
const AGENDA_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const AGENDA_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const AGENDA_LOCAL_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/

function agendaDayNumber(day) {
  const text = String(day ?? '')
  if (!AGENDA_DATE_ONLY.test(text)) return null
  const parts = text.split('-').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return null
  return Math.round(Date.UTC(parts[0], parts[1] - 1, parts[2]) / AGENDA_DAY_MS)
}

function agendaDayFromNumber(number) {
  return new Date(number * AGENDA_DAY_MS).toISOString().slice(0, 10)
}

function agendaAddDays(day, delta) {
  const number = agendaDayNumber(day)
  return number === null ? null : agendaDayFromNumber(number + delta)
}

function agendaWeekday(day) {
  const number = agendaDayNumber(day)
  return number === null ? '' : AGENDA_WEEKDAYS[new Date(number * AGENDA_DAY_MS).getUTCDay()]
}

function agendaDayStartInstant(day) {
  return agendaDayNumber(day) * AGENDA_DAY_MS - AGENDA_OFFSET_MS
}

function agendaDayEndInstant(day) {
  return agendaDayNumber(day) * AGENDA_DAY_MS - AGENDA_OFFSET_MS + AGENDA_DAY_MS - 1
}

function agendaLocalDayOfInstant(ms) {
  return agendaDayFromNumber(Math.floor((ms + AGENDA_OFFSET_MS) / AGENDA_DAY_MS))
}

function agendaLocalTimeOfInstant(ms) {
  const wall = new Date(ms + AGENDA_OFFSET_MS)
  return String(wall.getUTCHours()).padStart(2, '0') + ':' + String(wall.getUTCMinutes()).padStart(2, '0')
}

/** UTC instant -> Shanghai wall-clock ISO string with an explicit +08:00 offset. */
function toShanghaiIso(ms) {
  return new Date(ms + AGENDA_OFFSET_MS).toISOString().replace('Z', '+08:00')
}

/**
 * Resolve a stored dueAt to an absolute instant.
 * - YYYY-MM-DD            -> end of that Shanghai day
 * - local ISO without zone -> Shanghai wall clock (+08:00)
 * - anything with Z/offset -> its absolute instant
 * Returns null for invalid/dirty data (callers degrade instead of guessing).
 */
function dueInstantOfValue(dueAt) {
  if (dueAt === undefined || dueAt === null) return null
  const text = String(dueAt).trim()
  if (!text) return null
  if (AGENDA_DATE_ONLY.test(text)) return agendaDayEndInstant(text)
  if (AGENDA_LOCAL_TIME.test(text)) {
    const ms = Date.parse(text.replace(' ', 'T') + '+08:00')
    return Number.isFinite(ms) ? ms : null
  }
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

function agendaClip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

function agendaIsDateOnlyDue(dueAt) {
  const text = String(dueAt ?? '')
  return AGENDA_DATE_ONLY.test(text) || !/[T ]\d{2}:\d{2}/.test(text)
}

function agendaCommitmentItem(commitment, dueMs) {
  const allDay = agendaIsDateOnlyDue(commitment.dueAt)
  return {
    id: commitment.id,
    kind: 'commitment',
    title: agendaClip(commitment.action, 120),
    allDay: allDay,
    at: new Date(dueMs).toISOString(),
    localDate: agendaLocalDayOfInstant(dueMs),
    localTime: allDay ? null : agendaLocalTimeOfInstant(dueMs),
    matterId: commitment.matterId ?? null,
    ref: { kind: 'commitment', id: commitment.id },
    meta: { creditor: commitment.creditor },
  }
}

function agendaCompareItems(a, b) {
  if (Boolean(a.allDay) !== Boolean(b.allDay)) return a.allDay ? 1 : -1
  const left = Date.parse(a.at)
  const right = Date.parse(b.at)
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function agendaCalendarMeta(instance) {
  const meta = {}
  if (instance.rrule) meta.rrule = String(instance.rrule)
  if (instance.location) meta.location = String(instance.location)
  return meta
}

/**
 * Build the deterministic agenda view shared by 'agenda' and 'digest morning'.
 * Pure projection: no writes, no model/network calls, no clock reads besides
 * the injected nowMs. All arrays are deterministically sorted.
 */
async function buildAgendaData(input) {
  const { expandRrule } = await loadIcal()
  const nowMs = input.nowMs
  const days = input.days
  const includeCalendar = input.includeCalendar !== false
  const includeDone = input.includeDone === true
  const matterId = input.matterId
  const startDay = input.fromDay ?? agendaLocalDayOfInstant(nowMs)
  const lastDay = agendaAddDays(startDay, days - 1)
  const degraded = []
  const overdue = []
  const waiting = []
  const unscheduled = []
  const dayItems = new Map()
  const pushDay = (day, item) => {
    const list = dayItems.get(day) ?? []
    list.push(item)
    dayItems.set(day, list)
  }
  for (const commitment of input.ledger.listCommitments()) {
    if (matterId && commitment.matterId !== matterId) continue
    const status = commitment.status
    if (status === 'done') {
      if (!includeDone) continue
    } else if (status !== 'open' && status !== 'snoozed') continue
    const isWaiting = typeof commitment.debtor === 'string' && (commitment.debtor === 'third' || commitment.debtor.startsWith('third:'))
    const dueMs = commitment.dueAt ? dueInstantOfValue(commitment.dueAt) : null
    if (commitment.dueAt && dueMs === null) {
      unscheduled.push({ id: commitment.id, kind: 'commitment', title: agendaClip(commitment.action, 120), allDay: true, at: null, localDate: null, ref: { kind: 'commitment', id: commitment.id }, meta: { debtor: commitment.debtor } })
      degraded.push({ source: 'commitments', code: 'E_TIME_INVALID', id: commitment.id, reason: 'invalid dueAt' })
      continue
    }
    if (isWaiting && status !== 'done') {
      waiting.push({ id: commitment.id, kind: 'commitment', title: agendaClip(commitment.action, 120), allDay: true, at: dueMs === null ? null : new Date(dueMs).toISOString(), localDate: null, debtor: commitment.debtor, ref: { kind: 'commitment', id: commitment.id } })
      continue
    }
    if (dueMs === null) {
      unscheduled.push({ id: commitment.id, kind: 'commitment', title: agendaClip(commitment.action, 120), allDay: true, at: null, localDate: null, ref: { kind: 'commitment', id: commitment.id } })
      continue
    }
    if (status !== 'done' && dueMs < nowMs) {
      overdue.push(agendaCommitmentItem(commitment, dueMs))
      continue
    }
    if (status === 'done') {
      const doneDay = agendaLocalDayOfInstant(dueMs)
      if (doneDay >= startDay && doneDay <= lastDay) pushDay(doneDay, Object.assign(agendaCommitmentItem(commitment, dueMs), { kind: 'done' }))
      continue
    }
    const dueDay = agendaLocalDayOfInstant(dueMs)
    if (dueDay >= startDay && dueDay <= lastDay) pushDay(dueDay, agendaCommitmentItem(commitment, dueMs))
  }
  if (includeCalendar) {
    for (const row of input.events ?? []) {
      if (!calendarTzidSupported(row)) {
        degraded.push({ source: 'calendar', code: 'E_CALENDAR_SKIP', id: row.uid ?? null, reason: 'unsupported tzid: ' + calendarTzidOf(row) })
        continue
      }
      let instances
      try {
        instances = expandRrule(row, { from: startDay, to: lastDay })
      } catch (error) {
        degraded.push({ source: 'calendar', code: 'E_CALENDAR_SKIP', id: row.uid ?? null, reason: String(error && error.message ? error.message : error) })
        continue
      }
      for (const instance of instances) {
        if (instance.allDay) {
          const day = String(instance.startsAt ?? '').slice(0, 10)
          if (agendaDayNumber(day) === null || day < startDay || day > lastDay) continue
          pushDay(day, {
            id: instance.uid ?? day, kind: 'calendar', title: agendaClip(instance.summary, 120), allDay: true,
            at: new Date(agendaDayStartInstant(day)).toISOString(), localDate: day, localTime: null,
            matterId: null, ref: { kind: 'calendar', id: instance.uid ?? day }, meta: agendaCalendarMeta(instance),
          })
          continue
        }
        const startMs = Date.parse(instance.startsAt)
        if (!Number.isFinite(startMs)) {
          degraded.push({ source: 'calendar', code: 'E_CALENDAR_SKIP', id: instance.uid ?? null, reason: 'invalid startsAt' })
          continue
        }
        const day = agendaLocalDayOfInstant(startMs)
        if (day < startDay || day > lastDay) continue
        const endMs = instance.endsAt ? Date.parse(instance.endsAt) : null
        const item = {
          id: instance.uid ?? String(instance.startsAt), kind: 'calendar', title: agendaClip(instance.summary, 120), allDay: false,
          at: new Date(startMs).toISOString(), localDate: day, localTime: agendaLocalTimeOfInstant(startMs),
          matterId: null, ref: { kind: 'calendar', id: instance.uid ?? String(instance.startsAt) }, meta: agendaCalendarMeta(instance),
        }
        if (Number.isFinite(endMs)) item.endAt = new Date(endMs).toISOString()
        pushDay(day, item)
      }
    }
  }
  overdue.sort(agendaCompareItems)
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  waiting.sort(byId)
  unscheduled.sort(byId)
  const daysOut = []
  for (let offset = 0; offset < days; offset++) {
    const date = agendaAddDays(startDay, offset)
    const items = (dayItems.get(date) ?? []).slice().sort(agendaCompareItems)
    daysOut.push({ date: date, weekday: agendaWeekday(date), load: items.length, items: items.slice(0, 20) })
  }
  const conflicts = []
  const seenConflicts = new Set()
  const addConflict = (date, leftId, rightId) => {
    const pair = [leftId, rightId].sort()
    const key = date + '|' + pair.join('|')
    if (seenConflicts.has(key)) return
    seenConflicts.add(key)
    conflicts.push({ date: date, items: pair })
  }
  for (const day of daysOut) {
    const calendars = day.items.filter((item) => item.kind === 'calendar' && !item.allDay && item.endAt)
    const timedCommitments = day.items.filter((item) => item.kind === 'commitment' && !item.allDay)
    for (let i = 0; i < calendars.length; i++) {
      const left = calendars[i]
      const leftStart = Date.parse(left.at)
      const leftEnd = Date.parse(left.endAt)
      for (let j = i + 1; j < calendars.length; j++) {
        const right = calendars[j]
        const rightStart = Date.parse(right.at)
        const rightEnd = Date.parse(right.endAt)
        if (Number.isFinite(leftStart) && Number.isFinite(leftEnd) && Number.isFinite(rightStart) && Number.isFinite(rightEnd) && leftStart < rightEnd && rightStart < leftEnd) addConflict(day.date, left.id, right.id)
      }
      for (const commitment of timedCommitments) {
        const at = Date.parse(commitment.at)
        if (Number.isFinite(at) && Number.isFinite(leftStart) && Number.isFinite(leftEnd) && at >= leftStart && at <= leftEnd) addConflict(day.date, commitment.id, left.id)
      }
    }
  }
  conflicts.sort((a, b) => (a.date === b.date ? (a.items.join(',') < b.items.join(',') ? -1 : 1) : (a.date < b.date ? -1 : 1)))
  const perDayLoad = {}
  for (const day of daysOut) if (day.load) perDayLoad[day.date] = day.load
  // 0.4.0 proactive (task-29): urgency is a derived, additive field attached
  // after the deterministic projection. It is never part of the morning hash
  // (buildMorningReport strips it before hashing) and calendar items are left
  // untouched. Secrecy is not an input (see lib/urgency.js).
  const { scoreUrgency } = await loadUrgency()
  const urgencyRecords = new Map()
  for (const commitment of input.ledger.listCommitments()) urgencyRecords.set(commitment.id, commitment)
  const urgencyOptions = { now: nowMs, timezone: AGENDA_TIMEZONE, records: urgencyRecords }
  const withUrgency = (items) => items.map((item) => (item.kind === 'commitment' ? { ...item, urgency: scoreUrgency(item, urgencyOptions) } : item))
  return {
    ok: true,
    command: 'agenda',
    now: new Date(nowMs).toISOString(),
    window: { from: startDay, to: lastDay, days: days, timezone: AGENDA_TIMEZONE },
    overdue: withUrgency(overdue.slice(0, 50)),
    days: daysOut.map((day) => ({ ...day, items: withUrgency(day.items) })),
    waiting: withUrgency(waiting.slice(0, 20)),
    unscheduled: withUrgency(unscheduled.slice(0, 20)),
    conflicts: conflicts,
    counts: { overdue: overdue.length, today: daysOut[0] ? daysOut[0].load : 0, days: days, waiting: waiting.length, unscheduled: unscheduled.length, conflicts: conflicts.length, perDayLoad: perDayLoad },
    degraded: degraded,
  }
}

function agendaUsageFail(message) {
  console.error(JSON.stringify({ error: { code: 'E_USAGE', message: message, hint: 'advisers agenda --help' } }))
  process.exitCode = 1
}

/** Shared --days/--from/--now parsing for agenda + morning. */
function parseAgendaWindowFlags(flags, timelineCommand) {
  let days = 7
  if (flags.days !== undefined) {
    if (flags.days === true || !/^\d+$/.test(String(flags.days))) { agendaUsageFail('--days must be an integer 1..31'); return null }
    days = Number(flags.days)
    if (!Number.isInteger(days) || days < 1 || days > 31) { agendaUsageFail('--days must be an integer 1..31'); return null }
  }
  let nowMs = Date.now()
  if (flags.now !== undefined) {
    const parsed = typeof flags.now === 'string' ? Date.parse(flags.now) : NaN
    if (!Number.isFinite(parsed)) { agendaUsageFail('--now must be an ISO-8601 timestamp'); return null }
    nowMs = parsed
  }
  let fromDay
  if (flags.from !== undefined) {
    if (typeof flags.from !== 'string' || !AGENDA_DATE_ONLY.test(flags.from)) { agendaUsageFail('--from must be YYYY-MM-DD'); return null }
    fromDay = flags.from
  }
  const matterId = typeof flags.matter === 'string' ? flags.matter : undefined
  return { days: days, nowMs: nowMs, fromDay: fromDay, matterId: matterId }
}

function loadAgendaInputs() {
  if (mode === 'json') return { ledger: loadJson(), events: [] }
  const store = readStoreOrExit()
  if (!store) return { ledger: loadJson(), events: [] }
  const snapshot = store.read(() => ({ version: 1, matters: store.loadMatters(), commitments: store.loadCommitments() }))
  const events = store.read(() => store.listCalendarEvents())
  return { ledger: Ledger.fromJSON(snapshot, LOCAL_PORTS), events: events }
}

function agendaMatterErrorLine(error) {
  console.error(JSON.stringify({ error: { code: typeof error.code === 'string' ? error.code : 'E_USAGE', message: error.message } }))
  process.exitCode = 1
}

function printAgenda(data) {
  console.log('议程 ' + data.window.from + '（' + agendaWeekday(data.window.from) + '） → ' + data.window.to + '（' + agendaWeekday(data.window.to) + '）')
  console.log('逾期（' + data.counts.overdue + '）')
  if (!data.overdue.length) console.log('  （无）')
  for (const item of data.overdue) console.log('  ' + item.id + '  ' + item.title + ' · ' + (item.localDate ?? '无日期'))
  for (const day of data.days) {
    console.log(day.date + ' ' + day.weekday + '（' + day.load + '）')
    if (!day.items.length) { console.log('  （无）'); continue }
    for (const item of day.items) {
      const when = item.kind === 'calendar' && item.localTime ? item.localTime + (item.endAt ? '–' + agendaLocalTimeOfInstant(Date.parse(item.endAt)) : '') + ' ' : ''
      const marker = item.kind === 'commitment' ? ' [承诺]' : item.kind === 'done' ? ' [已完成]' : ''
      console.log('  ' + when + item.title + marker)
    }
  }
  console.log('等待他人（' + data.counts.waiting + '）')
  if (!data.waiting.length) console.log('  （无）')
  for (const item of data.waiting) console.log('  ' + item.title + ' · ' + item.debtor)
  console.log('未排期（' + data.counts.unscheduled + '）')
  if (!data.unscheduled.length) console.log('  （无）')
  for (const item of data.unscheduled) console.log('  ' + item.title)
  if (data.conflicts.length) {
    console.log('冲突（' + data.counts.conflicts + '）')
    for (const conflict of data.conflicts) console.log('  ' + conflict.date + '  ' + conflict.items.join(' / '))
  }
  if (data.degraded.length) console.log('数据降级：' + data.degraded.length + ' 条（详见 --json）')
}

async function agendaCommand(args) {
  const parsed = parseFlags(args)
  const flags = parsed.flags
  if (flags.help === true) {
    console.log('usage: advisers agenda [--days 1..31] [--from YYYY-MM-DD] [--matter id] [--no-calendar] [--include-done] [--json] [--now ISO]')
    return
  }
  const window = parseAgendaWindowFlags(flags, 'agenda')
  if (!window) return
  try {
    const inputs = loadAgendaInputs()
    if (window.matterId) {
      try { resolveMatterForCommand(inputs.ledger, window.matterId, 'agenda') } catch (error) { agendaMatterErrorLine(error); return }
    }
    const data = await buildAgendaData({
      ledger: inputs.ledger,
      events: flags['no-calendar'] === true ? [] : inputs.events,
      nowMs: window.nowMs,
      days: window.days,
      fromDay: window.fromDay,
      includeCalendar: flags['no-calendar'] !== true,
      includeDone: flags['include-done'] === true,
      matterId: window.matterId,
    })
    if (flags.json === true) { console.log(JSON.stringify(data, null, 2)); return }
    printAgenda(data)
  } catch (error) { reportCommandFailure(error) }
}

function morningUpcoming(agenda) {
  const rows = []
  for (const day of agenda.days.slice(1)) {
    for (const item of day.items) {
      rows.push({ date: day.date, weekday: day.weekday, kind: item.kind, id: item.id, title: item.title, localTime: item.localTime ?? null, ref: item.ref })
    }
  }
  return rows
}

async function buildMorningReport(input) {
  const agenda = await buildAgendaData({
    ledger: input.ledger,
    events: input.events,
    nowMs: input.nowMs,
    days: input.days,
    fromDay: input.fromDay,
    includeCalendar: true,
    includeDone: false,
    matterId: input.matterId,
  })
  const today = agenda.days[0] ?? { date: agenda.window.from, weekday: agendaWeekday(agenda.window.from), load: 0, items: [] }
  const mustDo = today.items.filter((item) => item.kind === 'commitment')
  const meetings = today.items.filter((item) => item.kind === 'calendar')
  const upcoming = morningUpcoming(agenda)
  const risks = []
  if (agenda.overdue.length) risks.push('逾期 ' + agenda.overdue.length + ' 条：' + agenda.overdue.slice(0, 3).map((item) => item.title).join('；'))
  if (agenda.conflicts.length) risks.push('时间冲突 ' + agenda.conflicts.length + ' 处')
  if (today.load >= 3) risks.push('今日负载较高（' + today.load + ' 项）')
  if (agenda.unscheduled.length) risks.push('未排期 ' + agenda.unscheduled.length + ' 条')
  // 0.4.0 proactive: urgency now rides on the agenda commitment items, but the
  // frozen dataSha256 must cover exactly the 0.3.2 shape. Strip the derived field
  // before hashing (the same data still ships in payloadInput below).
  const stripUrgency = (value) => {
    if (Array.isArray(value)) return value.map(stripUrgency)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [key, entry] of Object.entries(value)) if (key !== 'urgency') out[key] = stripUrgency(entry)
      return out
    }
    return value
  }
  const counts = {
    mustDo: mustDo.length,
    overdue: agenda.overdue.length,
    meetings: meetings.length,
    waiting: agenda.waiting.length,
    upcoming: upcoming.length,
    unscheduled: agenda.unscheduled.length,
    conflicts: agenda.conflicts.length,
  }
  const hashInput = {
    localDay: agenda.window.from,
    window: agenda.window,
    mustDo: stripUrgency(mustDo),
    overdue: stripUrgency(agenda.overdue),
    meetings: meetings,
    waiting: stripUrgency(agenda.waiting),
    upcoming: upcoming,
    unscheduled: stripUrgency(agenda.unscheduled),
    conflicts: agenda.conflicts,
    counts: counts,
  }
  const evidence = await loadEvidence()
  const dataSha256 = evidence.sha256Hex(evidence.stableStringify(hashInput, { space: 0 }))
  const payloadInput = {
    localDay: hashInput.localDay,
    window: agenda.window,
    mustDo: mustDo,
    overdue: agenda.overdue,
    meetings: meetings,
    waiting: agenda.waiting,
    upcoming: upcoming,
    unscheduled: agenda.unscheduled,
    conflicts: agenda.conflicts,
    counts: counts,
  }
  // Deterministic human priority list (score desc -> dueAt asc -> id asc); it is
  // presentation only and never enters dataSha256.
  const { selectTopUrgent } = await loadUrgency()
  const topLimit = Number.isInteger(input.top) && input.top >= 1 && input.top <= 5 ? input.top : 3
  const topCandidates = [
    ...mustDo.map((item) => ({ ...item, source: 'today' })),
    ...agenda.overdue.map((item) => ({ ...item, source: 'overdue' })),
  ]
  const top = selectTopUrgent(topCandidates, { limit: topLimit }).map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    ...(item.localTime ? { localTime: item.localTime } : {}),
    urgency: item.urgency,
    whyNow: item.urgency?.whyNow ?? '',
    source: item.source,
  }))
  return { agenda: agenda, today: today, risks: risks, hashInput: hashInput, payloadInput: payloadInput, dataSha256: dataSha256, top: top, topLimit: topLimit }
}

function morningMarkdown(report) {
  const agenda = report.agenda
  const day = agenda.window.from
  const lines = []
  lines.push('# 晨报 ' + day + '（' + agendaWeekday(day) + '）')
  lines.push('> 本地确定性生成 · 不含模型推理 · 数据哈希 sha256:' + report.dataSha256.slice(0, 16))
  lines.push('')
  // 0.4.0 additive section: top-urgency view (<=3/--top). The full "今天必须做"
  // list below keeps its 0.3.2 meaning, so existing readers do not break.
  const urgencyLevelLabels = { low: '低', medium: '中', high: '高', critical: '急' }
  lines.push('## 今天优先（最多 ' + report.topLimit + '）')
  if (!report.top.length) lines.push('（无）')
  for (let index = 0; index < report.top.length; index++) {
    const item = report.top[index]
    const level = urgencyLevelLabels[item.urgency?.level] ?? String(item.urgency?.level ?? '低')
    lines.push((index + 1) + '. ' + item.title + (item.localTime ? '（今天 ' + item.localTime + ' 到期）' : '') + '，urgency ' + (item.urgency?.score ?? 0) + '/' + level + (item.whyNow ? '：' + item.whyNow : ''))
  }
  lines.push('')
  lines.push('## 今天必须做')
  if (!report.hashInput.mustDo.length) lines.push('（无）')
  for (let index = 0; index < report.hashInput.mustDo.length; index++) {
    const item = report.hashInput.mustDo[index]
    lines.push((index + 1) + '. ' + item.title + (item.localTime ? '（' + item.localTime + ' 截止）' : '（今天到期）'))
  }
  lines.push('')
  lines.push('## 逾期（' + agenda.overdue.length + '）')
  if (!agenda.overdue.length) lines.push('（无）')
  for (const item of agenda.overdue) lines.push('- ' + item.title + '（' + (item.localDate ?? '无日期') + '）')
  lines.push('')
  lines.push('## 今天会议（' + report.hashInput.meetings.length + '）')
  if (!report.hashInput.meetings.length) lines.push('（无）')
  for (const item of report.hashInput.meetings) {
    const when = item.localTime ? item.localTime + (item.endAt ? '–' + agendaLocalTimeOfInstant(Date.parse(item.endAt)) : '') + '  ' : ''
    lines.push('- ' + when + item.title)
  }
  lines.push('')
  lines.push('## 未来 7 天（' + report.hashInput.upcoming.length + '）')
  if (!report.hashInput.upcoming.length) lines.push('（无）')
  for (const item of report.hashInput.upcoming.slice(0, 20)) lines.push('- ' + item.date.slice(5) + ' ' + item.weekday + '  ' + item.title)
  lines.push('')
  lines.push('## 等待他人（' + agenda.waiting.length + '）')
  if (!agenda.waiting.length) lines.push('（无）')
  for (const item of agenda.waiting) lines.push('- ' + item.title + (item.debtor ? '（' + item.debtor + '）' : ''))
  lines.push('')
  lines.push('## 未排期（' + agenda.unscheduled.length + '）')
  if (!agenda.unscheduled.length) lines.push('（无）')
  for (const item of agenda.unscheduled) lines.push('- ' + item.title + '（无截止，建议设置日期）')
  lines.push('')
  lines.push('## 风险（' + report.risks.length + '）')
  if (!report.risks.length) lines.push('（无）')
  for (const risk of report.risks) lines.push('- ' + risk)
  lines.push('')
  lines.push('## 数据说明')
  lines.push('- 数据来源：本地账本 + 已导入日历；不含邮件正文或附件。')
  lines.push('- 本文件不构成对外承诺；金额/日期以原始交付物为准。')
  if (agenda.degraded.length) lines.push('- 数据降级 ' + agenda.degraded.length + ' 条（详见 morning --json 的 degraded 字段）。')
  return lines.join('\n') + '\n'
}

async function morningReportCommand(args) {
  const parsed = parseFlags(args)
  const flags = parsed.flags
  if (flags.help === true) {
    console.log('usage: advisers morning [digest morning] [--days 1..31] [--matter id] [--top 1..5] [--out file] [--archive [--keep 1..365]] [--json] [--now ISO]')
    return
  }
  const window = parseAgendaWindowFlags(flags, 'morning')
  if (!window) return
  // 0.4.0 flags: --top (human priority count) and --keep (archive retention).
  let top
  if (flags.top !== undefined) {
    if (flags.top === true || !/^\d+$/.test(String(flags.top)) || Number(flags.top) < 1 || Number(flags.top) > 5) { agendaUsageFail('--top must be an integer 1..5'); return }
    top = Number(flags.top)
  }
  let keep
  if (flags.keep !== undefined) {
    if (flags.keep === true || !/^\d+$/.test(String(flags.keep)) || Number(flags.keep) < 1 || Number(flags.keep) > 365) { agendaUsageFail('--keep must be an integer 1..365'); return }
    keep = Number(flags.keep)
  }
  try {
    const inputs = loadAgendaInputs()
    if (window.matterId) {
      try { resolveMatterForCommand(inputs.ledger, window.matterId, 'morning') } catch (error) { agendaMatterErrorLine(error); return }
    }
    const report = await buildMorningReport({ ledger: inputs.ledger, events: inputs.events, nowMs: window.nowMs, days: window.days, fromDay: window.fromDay, matterId: window.matterId, top: top })
    const markdown = morningMarkdown(report)
    const payload = Object.assign(
      { ok: true, command: 'morning', generatedAt: new Date(window.nowMs).toISOString() },
      report.payloadInput,
      { dataSha256: report.dataSha256, degraded: report.agenda.degraded, top: report.top, urgencyModelVersion: 1 },
    )
    let outPath
    if (flags.out !== undefined) {
      if (typeof flags.out !== 'string') { agendaUsageFail('--out requires a file path'); return }
      outPath = flags.out
      mkdirSync(dirname(outPath), { recursive: true })
      atomicWriteFileSync(outPath, markdown, { mode: 0o600 })
      payload.out = outPath
    }
    // 0.4.0 proactive: --archive is the only write path here. It takes the
    // writer lock (audit row brief.archive inside the same transaction), writes
    // briefs/<localDay>.md + latest.md atomically, and prunes old day files.
    let archiveInfo
    if (flags.archive === true) {
      const archive = await loadBriefArchive()
      const localDay = report.hashInput.localDay
      const writeBrief = () => archive.archiveBrief({ home: HOME, env: process.env, localDay, markdown, keep })
      try {
        if (dbStore()) {
          mutateWithAudit(() => { archiveInfo = writeBrief(); return null }, archive.briefAuditRow({ localDay }))
        } else {
          archiveInfo = writeBrief()
        }
      } catch (error) { reportCommandFailure(error); return }
      try {
        const scheduler = await loadScheduler()
        scheduler.recordSchedulerRunV2({ homeDir: HOME, at: new Date(window.nowMs), section: 'morning', result: 'ok', count: report.top.length, path: archiveInfo.path, dryRun: false })
      } catch (error) {
        console.error(sanitizeConsoleText('scheduler status not recorded: ' + (error?.message ?? error), { max: 2000 }))
      }
      payload.archive = {
        path: archiveInfo.path,
        latestPath: archiveInfo.latestPath,
        keep: archiveInfo.keep,
        bytes: archiveInfo.bytes,
        removed: archiveInfo.removed,
        failed: archiveInfo.failed,
      }
    }
    if (flags.json === true) { console.log(JSON.stringify(payload, null, 2)); return }
    process.stdout.write(markdown)
    if (outPath) console.log('wrote ' + outPath + ' (mode 600)')
    if (archiveInfo) {
      console.log('已归档：' + sanitizeConsoleText(archiveInfo.path, { max: 240 }) + '（' + formatBytes(archiveInfo.bytes) + '，keep=' + archiveInfo.keep + '）')
      console.log('最新：' + sanitizeConsoleText(archiveInfo.latestPath, { max: 240 }))
      for (const removed of archiveInfo.removed) console.log('已删除：' + sanitizeConsoleText(removed, { max: 240 }))
      for (const failed of archiveInfo.failed) console.error(sanitizeConsoleText('归档清理失败：' + failed.path + ' (' + failed.code + ')', { max: 2000 }))
    }
  } catch (error) { reportCommandFailure(error) }
}

function risks(ledger) {
  const open = ledger.openCommitments()
  const out = []
  const byDay = new Map()
  for (const c of open) {
    if (!c.dueAt) continue
    const day = c.dueAt.slice(0, 10)
    byDay.set(day, [...(byDay.get(day) ?? []), c])
  }
  for (const [day, list] of byDay) if (list.length >= 2) out.push(`${day} 有 ${list.length} 个截止：${list.map((c) => c.action).join('、')}`)
  for (const c of open.filter((c) => !c.dueAt)) out.push(`${c.action} 没有截止时间（${c.creditor}）`)
  for (const c of open.filter((c) => c.creditor === 'someone' || !c.creditor)) out.push(`${c.action} 没有明确对象`)
  for (const c of open.filter((c) => c.debtor === 'third' || c.debtor.startsWith('third:'))) out.push(`等 ${c.debtor} 回复：${c.action}`)
  if (!out.length) { console.log('目前没有明显的义务风险。'); return }
  for (const line of out.slice(0, 3)) console.log(`- ${line}`)
}

/**
 * Read-side provenance compatibility (source v2): stored v1 source rows are
 * normalised before display so mail/transcript/IMAP provenance renders the same
 * way regardless of when the row was written. Read-only: normalizeSource() is
 * pure and never touches the database.
 */
async function collectSourceRows(ledger) {
  const { normalizeSource } = await loadSource()
  const rows = []
  for (const c of ledger.listCommitments()) {
    for (const e of c.evidence ?? []) {
      if (e && (e.kind === 'manual' || e.type === 'manual' || (e.sessionId === 'local' && e.turnId === 'cli'))) {
        rows.push({
          commitmentId: c.id,
          action: c.action,
          type: 'manual',
          ref: null,
          label: 'manual:operator-entered',
          quote: e.quote ?? '',
          source: { sourceVersion: 2, type: 'manual', quote: e.quote ?? '', resolution: 'unverifiable', reason: 'operator_entered' },
          unverifiable: true,
        })
        continue
      }
      const source = normalizeSource(e.source)
      const type = source?.type ?? 'conversation'
      rows.push({
        commitmentId: c.id,
        action: c.action,
        type,
        ref: source?.ref ?? (e.sessionId ? `${e.sessionId}#${e.turnId}` : (e.turnId ?? null)),
        label: `${type}${source?.subject ? `:${source.subject}` : source?.messageId ? `:${source.messageId}` : source?.file ? `:${source.file}` : ''}`,
        quote: e.quote ?? '',
        source: source ?? null,
      })
    }
  }
  return rows
}

async function printSources(ledger) {
  const rows = await collectSourceRows(ledger)
  if (!rows.length) { console.log('来源：还没有可回溯的承诺来源；先 capture/导入并 accept。'); return }
  console.log('来源（承诺 → 本地入口）：')
  for (const r of rows.slice(0, 20)) console.log(`  ${r.commitmentId}  ${r.action}  ← ${r.label} (${r.ref ?? '-'})  「${r.quote.slice(0, 80)}」`)
}

async function today(openRows, { calendar = false, sources = false, json = false, ledger = null, limit = null, hydrate = null } = {}) {
  const nowMs = Date.now()
  const localDay = localDayOf(nowMs)
  const weekAhead = nowMs + 7 * 86400_000
  // P0-1/P1-2 (0.2.3): cache the parsed time + Asia/Shanghai calendar day of
  // every DISTINCT dueAt string. A 200k ledger has ~66k open commitments but
  // only a few hundred distinct due dates, so the old per-row Date.parse /
  // localDayOf calls (and the sort comparator that re-parsed every dueAt)
  // dominated today's hot path. Rows with an unparseable dueAt are counted as
  // no-due instead of crashing on Intl.format(Invalid Date).
  const dueCache = new Map()
  const dueInfo = (dueAt) => {
    let info = dueCache.get(dueAt)
    if (info === undefined) {
      const ms = Date.parse(dueAt)
      info = { ms, day: Number.isNaN(ms) ? null : localDayOf(ms) }
      dueCache.set(dueAt, info)
    }
    return info
  }
  // P0-1: classify in one pass, formatting each due date at most once.
  const overdue = []
  const todayDue = []
  const week = []
  const waiting = []
  const noDue = []
  let next = null
  let nextMs = Infinity
  for (const c of openRows) {
    if (c.debtor === 'third' || c.debtor.startsWith('third:')) waiting.push(c)
    if (!c.dueAt) { noDue.push(c); continue }
    const info = dueInfo(c.dueAt)
    if (info.day === null) { noDue.push(c); continue }
    if (info.ms < nowMs) {
      if (info.day !== localDay) overdue.push(c)
      else todayDue.push(c)
    } else if (info.day === localDay) {
      todayDue.push(c)
    } else if (info.ms <= weekAhead) {
      week.push(c)
    }
    // next = the earliest due row among the three buckets ; all of them have
    // ms <= weekAhead, so this single comparison replaces the old Date.parse
    // sort of the concatenated buckets.
    if (info.ms <= weekAhead && info.ms < nextMs) { nextMs = info.ms; next = c }
  }
  if (json) {
    // JSON contract v1 (docs/CLI-JSON.md): same classification as the human view.
    // 0.3.2 additive `--limit N`: each bucket keeps at most N full Commitment
    // entities (hydrated on demand); `counts`/`next` stay the true totals. The
    // flagless output is byte-identical to v1.
    const capped = (list) => (limit === null ? list : list.slice(0, limit))
    const materialize = (list) => {
      const kept = capped(list)
      if (limit === null || typeof hydrate !== 'function' || !kept.length) return kept
      const hydrated = hydrate(kept.map((row) => row.id))
      const byId = new Map((Array.isArray(hydrated) ? hydrated : []).map((row) => [row.id, row]))
      return kept.map((row) => byId.get(row.id) ?? row)
    }
    const payload = {
      now: new Date(nowMs).toISOString(),
      localDay,
      counts: { today: todayDue.length, overdue: overdue.length, week: week.length, waiting: waiting.length, noDue: noDue.length },
      overdue: materialize(overdue),
      today: materialize(todayDue),
      week: materialize(week),
      waiting: materialize(waiting),
      noDue: materialize(noDue),
      next: next ? { id: next.id, action: next.action, dueAt: next.dueAt } : null,
    }
    if (limit !== null) {
      payload.limit = limit
      payload.truncated = [overdue, todayDue, week, waiting, noDue].some((list) => list.length > limit)
    }
    if (calendar) {
      const calendarToday = await calendarOccurrencesToday()
      payload.calendar = calendarToday.occurrences
      // Additive key only: the same E_CALENDAR_SKIP shape `agenda --json`
      // publishes, so consumers can see which events were skipped (not guessed).
      payload.calendarDegraded = calendarToday.degraded
    }
    if (sources && ledger) {
      payload.sources = (await collectSourceRows(ledger)).map(({ commitmentId, action, type, ref, quote }) => ({ commitmentId, action, type, ref, quote }))
    }
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  console.log(`今天：${todayDue.length} · 逾期：${overdue.length} · 未来 7 天：${week.length} · 等别人：${waiting.length} · 无截止：${noDue.length}`)
  for (const [label, list] of [['逾期', overdue], ['今天', todayDue], ['未来 7 天', week], ['等别人', waiting]]) {
    if (!list.length) continue
    console.log(`${label}：`)
    for (const c of list.slice(0, 5)) console.log(`  ${c.id}  ${c.creditor} · ${c.action}${c.dueAt ? ` · ${c.dueAt.slice(0, 10)}` : ''}`)
  }
  console.log('下一件：' + (next?.action ?? '先定一个承诺或交付。'))
  if (calendar) await printCalendarToday()
  if (sources && ledger) await printSources(ledger)
}

function tick(ledger, asJson = false) {
  const now = Date.now()
  const store = dbStore()
  const localDay = localDayOf(now)
  const weekAhead = now + 7 * 86400_000
  const due = []
  const candidates = []
  const snoozeKeys = []
  const wakeIds = []
  // P0-2: one meta query for every snooze deadline instead of getMeta() per
  // snoozed commitment.
  const snoozeUntil = store ? store.listMetaByPrefix('snooze:') : new Map()
  for (const c of ledger.listCommitments()) {
    if (c.status === 'done' || c.status === 'dropped') continue
    if (c.status === 'snoozed') {
      const until = snoozeUntil.get(`snooze:${c.id}`)
      if (until && Date.parse(until) > now) continue
      c.status = 'open'
      wakeIds.push(c.id)
      snoozeKeys.push(`snooze:${c.id}`)
    }
    if (!c.dueAt || Date.parse(c.dueAt) > weekAhead) continue
    candidates.push(c)
  }
  // P2-2 (0.2.1): the recent-outcome read is bounded by the candidate set.
  // Only candidates whose pre-outcome level is L2/L3 can be downgraded by an
  // ignored run (the `level !== 'L1'` guard below), so those are the only ids
  // the query needs; the history table is never scanned as a whole.
  const baseLevelById = new Map()
  const outcomeIds = []
  for (const c of candidates) {
    const dueDay = localDayOf(c.dueAt)
    const msLeft = Date.parse(c.dueAt) - now
    let baseLevel = (msLeft < 0 || dueDay === localDay) ? 'L2' : 'L1'
    if (baseLevel === 'L2' && Date.parse(c.dueAt) < now - 86400_000 && process.env.ADVISERS_ALLOW_L3 === '1') baseLevel = 'L3'
    baseLevelById.set(c.id, baseLevel)
    if (baseLevel !== 'L1') outcomeIds.push(c.id)
  }
  // P0-2: replace the per-commitment N+1 queries (listCommitmentNudges +
  // countNudges) with three batch reads: recent outcomes per commitment,
  // today's level counts and today's existing (commitment, level) keys.
  const recentByCommitment = store && outcomeIds.length ? store.recentNudgeOutcomes(3, outcomeIds) : new Map()
  const levelCounts = store && candidates.length ? store.countNudgesByDay(localDay) : new Map()
  const existingKeys = store && candidates.length ? store.listNudgeLevelKeysByDay(localDay) : new Set()
  const pendingKeys = new Set()
  let l3Today = levelCounts.get('L3') ?? 0
  let l2Today = levelCounts.get('L2') ?? 0
  const nudgeRows = []
  for (const c of candidates) {
    let level = baseLevelById.get(c.id)
    const recent = recentByCommitment.get(c.id) ?? []
    if (recent.length === 3 && recent.every((outcome) => outcome === 'ignored') && level !== 'L1') level = level === 'L3' ? 'L2' : 'L1'
    // Budgets keep the historical in-run semantics: a nudge already written by
    // this tick counts toward the caps of the commitments that follow it, but a
    // deduped (already present) key does not.
    if (level === 'L3' && l3Today >= 1) level = 'L2'
    if (level === 'L2' && l2Today >= 3) level = 'L1'
    const key = `${c.id}\u0000${level}`
    if (!existingKeys.has(key) && !pendingKeys.has(key)) {
      if (level === 'L3') l3Today++
      else if (level === 'L2') l2Today++
      pendingKeys.add(key)
    }
    nudgeRows.push({ localDay, level, commitmentId: c.id, body: c.action })
    due.push({ ...c, level })
  }
  // 0.2.3 §3.3.5: nudge inserts, conditional snooze wake-ups and the snooze
  // meta cleanup commit in ONE applyTick transaction (no audit row, matching the
  // historical tick behaviour). A nudge can therefore never be recorded while
  // its wake-up is lost; the old path did a full saveLedger() on wake-up.
  if (store && (nudgeRows.length || wakeIds.length || snoozeKeys.length)) {
    store.applyTick({ nudgeRows, wakeIds, snoozeKeys })
  } else if (mode === 'json' && wakeIds.length) {
    // Legacy JSON store has no nudge/meta tables: only the in-memory wake-up can
    // be persisted (the historical behaviour).
    saveJson(ledger)
  }
  if (asJson) {
    console.log(JSON.stringify({ now: new Date(now).toISOString(), localDay, due }, null, 2))
    return
  }
  if (!due.length) { console.log('未来 7 天无到期。'); return }
  for (const c of due) {
    const dueDay = localDayOf(c.dueAt)
    const label = Date.parse(c.dueAt) < now ? '逾期' : dueDay === localDay ? '今天到期' : '即将到期'
    console.log(`[${c.level}] ${label}：${c.action}（${c.dueAt}）`)
  }
}

/**
 * Rebuild the two FTS5 indexes from their source tables — the repair action
 * pointed at by `verifyFtsIntegrity()` / reader warnings ("advisers audit
 * --rebuild-fts"). Runs in the single-writer lock inside one immediate
 * transaction so a failure leaves the previous index intact, then verifies the
 * rebuilt index and records an audit row. `rebuildAllFtsIndexes()` (0.4.0)
 * rebuilds the v19 turn pair AND the v22 KB pair with the same probed tokenizer,
 * so a KB FTS drift is repairable here instead of only detectable.
 */
async function rebuildFtsIndexes({ asJson = false } = {}) {
  let store
  try { store = openStore() } catch (error) { return reportMaintenanceFailure(error, asJson, 'fts') }
  const before = store.verifyFtsIntegrity()
  if (before.ok) {
    if (asJson) console.log(JSON.stringify({ ok: true, rebuilt: false, reason: 'already-consistent', state: before.state, tokenizer: before.tokenizer }, null, 2))
    else console.log(`fts: consistent (state=${before.state}); no rebuild needed`)
    return
  }
  let rebuildError = null
  try {
    store.db.exec('BEGIN IMMEDIATE')
    try {
      store.rebuildAllFtsIndexes()
      store.db.exec('COMMIT')
    } catch (error) {
      try { store.db.exec('ROLLBACK') } catch {}
      throw error
    }
  } catch (error) { rebuildError = error }
  const after = rebuildError ? null : store.verifyFtsIntegrity()
  if (!rebuildError && after.ok) {
    // The store caches the "FTS unusable, fall back to LIKE" flag; this process
    // just fixed it, so later reads in the same process may trust FTS again.
    store._ftsBroken = false
    store.ftsIntegrityWarning = null
    let auditRow = null
    try { auditRow = store.appendAudit({ actor: 'local', action: 'audit.rebuild_fts', allowed: true, reason: `state=${before.state};errors=${(before.errors ?? []).length};tokenizer=${after.tokenizer ?? 'none'}` }) } catch {}
    if (asJson) {
      console.log(JSON.stringify({ ok: true, rebuilt: true, before: { state: before.state, errors: before.errors }, after: { state: after.state, tokenizer: after.tokenizer }, audit: auditRow }, null, 2))
    } else {
      console.log(`fts: rebuilt (${before.state} -> ${after.state}, tokenizer=${after.tokenizer ?? 'none'})`)
      console.log(auditRow ? `audit: appended seq ${auditRow.seq}` : 'audit: could not append the rebuild row')
    }
    return
  }
  const detail = rebuildError ? String(rebuildError.message ?? rebuildError) : (after.errors ?? []).join('; ')
  if (asJson) console.log(JSON.stringify({ ok: false, rebuilt: false, code: rebuildError?.code ?? null, errors: [detail] }, null, 2))
  else {
    console.error(`fts: rebuild FAILED: ${detail}`)
    console.error('  hint: run `advisers backup` first and retry; search keeps using the LIKE fallback until the index is rebuilt (results stay complete).')
  }
  process.exitCode = 1
}

/** Human one-line anchor status for `advisers audit` / `doctor`. */
function describeAnchorCheck(check) {
  const anchor = check.anchor ?? null
  const head = check.head ?? null
  if (check.status === 'absent') {
    return 'absent (yellow — no baseline recorded yet; run `advisers audit --write-anchor` to make future tail deletions detectable)'
  }
  if (check.status === 'match') {
    return `match (count=${anchor?.count ?? head?.count ?? '?'} lastSeq=${anchor?.lastSeq ?? '?'} head=${shortAuditHash(anchor?.headHash)} keyed=${anchor?.keyed === true ? 'hmac' : 'unkeyed'})`
  }
  if (check.status === 'grown') {
    return `grown (anchor ${anchor?.count ?? '?'} -> current ${head?.count ?? '?'}; run \`advisers audit --write-anchor\` to refresh)`
  }
  return `FAIL (${check.code ?? 'anchor-error'})`
}

/**
 * `advisers audit` — verify the audit hash chain and, when recorded, its tail
 * anchor (0.3.0 P0-L2).
 *
 * A hash chain detects edits/deletions in the middle, but a *tail* deletion
 * leaves a still-valid shorter chain. The local anchor
 * ($ADVISERS_HOME/audit-anchor.json, HMAC with audit.key) records the last
 * count/lastSeq/headHash: a live database that is shorter than its anchor is
 * E_AUDIT_TAIL_TRUNCATED. It is a local self-checkpoint — the same user can
 * rewrite both files — so it is never third-party attestation.
 */
async function auditCommand(args = []) {
  const parsed = parseStrictFlags(args, {
    booleans: ['check-db', 'json', 'write-anchor', 'rebuild-fts'],
    values: ['expect-count', 'expect-head'],
    positional: false,
  })
  if (!parsed.ok) return usageFail(parsed.error, AUDIT_USAGE)
  const { flags } = parsed
  const asJson = flags.json === true
  const hasExpect = flags['expect-count'] !== undefined || flags['expect-head'] !== undefined
  if (flags['rebuild-fts'] && (flags['write-anchor'] || hasExpect || flags['check-db'])) {
    return usageFail('--rebuild-fts cannot be combined with --write-anchor/--expect-*/--check-db', AUDIT_USAGE)
  }
  if (flags['write-anchor'] && (hasExpect || flags['check-db'])) {
    return usageFail('--write-anchor cannot be combined with --expect-*/--check-db', AUDIT_USAGE)
  }
  if (hasExpect && flags['check-db']) return usageFail('--expect-* cannot be combined with --check-db', AUDIT_USAGE)
  if (mode === 'json') {
    if (asJson) console.log(JSON.stringify({ ok: false, code: 'E_USAGE', error: 'audit requires the SQLite store (ADVISERS_STORE=sqlite)' }, null, 2))
    else console.log('audit requires SQLite store')
    process.exitCode = 1
    return
  }
  ensureHome()
  if (flags['rebuild-fts']) return rebuildFtsIndexes({ asJson })
  const store = readStoreOrExit()
  if (!store) {
    if (asJson) console.log(JSON.stringify({ ok: false, code: 'E_USAGE', error: 'audit requires the SQLite store' }, null, 2))
    else console.log('audit requires SQLite store')
    process.exitCode = 1
    return
  }
  let integrity = null
  if (flags['check-db']) {
    try {
      store.assertIntegrity()
      integrity = 'ok'
      if (!asJson) console.log('integrity: ok')
    } catch (error) {
      integrity = 'FAIL'
      if (asJson) console.log(JSON.stringify({ ok: false, integrity, code: 'E_DB_CORRUPT', error: error.message }, null, 2))
      else console.error(`integrity: FAIL (${error.message})`)
      process.exitCode = 1
      return
    }
  }
  const lib = await loadAuditAnchor()
  const verify = store.verifyAudit()
  const head = lib.readAuditHead(store, { verifyChain: false })
  if (!head.ok) {
    if (asJson) console.log(JSON.stringify({ ok: false, integrity, code: head.code, errors: head.errors }, null, 2))
    else { console.error(`audit: cannot read the audit head (${head.code}): ${(head.errors ?? []).join('; ')}`); console.error(`  hint: ${lib.describeAuditAnchorCode(head.code)}`) }
    process.exitCode = 1
    return
  }
  if (flags['write-anchor']) {
    const written = lib.writeAuditAnchor({ home: HOME, store, generator: `advisers/${VERSION}` })
    if (!written.ok) {
      if (asJson) console.log(JSON.stringify({ ok: false, code: written.code, errors: written.errors, warnings: written.warnings }, null, 2))
      else {
        console.error(`anchor: write FAILED (${written.code})`)
        for (const line of written.errors ?? []) console.error(`  ${line}`)
        console.error(`  hint: ${lib.describeAuditAnchorCode(written.code)}`)
      }
      process.exitCode = 1
      return
    }
    if (asJson) {
      console.log(JSON.stringify({ ok: true, path: written.path, anchor: written.anchor, keyed: written.keyed, keySource: written.keySource, warnings: written.warnings }, null, 2))
      return
    }
    console.log(`anchor: written ${written.path}`)
    console.log(`anchor: entries=${written.anchor.count} lastSeq=${written.anchor.lastSeq} head=${shortAuditHash(written.anchor.headHash)} keyed=${written.anchor.keyed ? 'hmac' : 'no'} (${written.keySource ?? 'none'})`)
    for (const warning of written.warnings ?? []) console.log(`warning: ${warning}`)
    return
  }
  if (hasExpect) {
    const expectedCount = flags['expect-count'] !== undefined ? flags['expect-count'] : null
    const check = lib.verifyExpectedAudit(store, { expectedCount, expectedHead: flags['expect-head'] ?? null })
    const ok = verify.ok === true && check.ok === true
    if (asJson) {
      console.log(JSON.stringify({
        ok,
        chain: { ok: verify.ok, count: verify.count ?? head.count, brokenAt: verify.ok ? null : verify.seq },
        head: { count: head.count, lastSeq: head.lastSeq, headHash: head.headHash },
        expectation: { ok: check.ok, code: check.code, expectedCount: check.expectedCount, expectedHead: check.expectedHead, errors: check.errors },
      }, null, 2))
    } else {
      console.log(verify.ok ? `audit: verified (${verify.count ?? head.count} entries) head=${shortAuditHash(head.headHash)}` : `audit: BROKEN at seq ${verify.seq}`)
      if (!verify.ok) console.error('expect: not evaluated (the audit chain itself is broken)')
      else if (check.ok) console.log(`expect: match (count=${check.count} head=${shortAuditHash(check.headHash)})`)
      else {
        console.error(`expect: FAIL (${check.code})`)
        for (const line of check.errors ?? []) console.error(`  ${line}`)
      }
    }
    if (!ok) process.exitCode = 1
    return
  }
  // Default: chain status line + recorded-anchor comparison.
  const anchorCheck = lib.verifyAuditAgainstAnchor({ home: HOME, store, head, env: process.env })
  const anchorRed = anchorCheck.ok !== true && anchorCheck.status !== 'absent'
  const ok = verify.ok === true && !anchorRed
  const entries = store.listAudit(20).map((row) => ({ seq: row.seq, at: row.at, action: row.action, allowed: row.allowed, reason: row.reason }))
  if (asJson) {
    console.log(JSON.stringify({
      ok,
      integrity,
      chain: { ok: verify.ok, count: verify.count ?? head.count, brokenAt: verify.ok ? null : verify.seq },
      head: { count: head.count, lastSeq: head.lastSeq, headHash: head.headHash },
      anchor: {
        found: anchorCheck.found === true,
        status: anchorCheck.status,
        ok: anchorCheck.ok === true,
        code: anchorCheck.code ?? null,
        path: anchorCheck.path ?? null,
        count: anchorCheck.anchor?.count ?? null,
        lastSeq: anchorCheck.anchor?.lastSeq ?? null,
        headHash: anchorCheck.anchor?.headHash ?? null,
        keyed: anchorCheck.anchor?.keyed ?? null,
        hmacVerified: anchorCheck.hmacVerified === true,
        errors: anchorCheck.errors ?? [],
        warnings: anchorCheck.warnings ?? [],
      },
      entries,
    }, null, 2))
  } else {
    console.log(verify.ok
      ? `audit: verified (${verify.count ?? head.count} entries) head=${shortAuditHash(head.headHash)} lastSeq=${head.lastSeq}`
      : `audit: BROKEN at seq ${verify.seq} (${head.count} entries)`)
    console.log(`anchor: ${describeAnchorCheck(anchorCheck)}`)
    for (const warning of anchorCheck.warnings ?? []) console.log(`warning: ${warning}`)
    if (anchorRed) {
      for (const line of anchorCheck.errors ?? []) console.error(`  ${line}`)
      console.error(`  hint: ${lib.describeAuditAnchorCode(anchorCheck.code)}`)
    }
    if (verify.ok) {
      for (const row of entries) {
        console.log(`${row.seq}\t${row.at.slice(0, 19)}\t${row.action}\t${row.allowed ? 'allow' : 'deny'}\t${row.reason ?? ''}`)
      }
    }
  }
  if (!ok) process.exitCode = 1
}

async function printPrivacy(args = []) {
  ensureHome()
  const asJson = args.includes('--json')
  const prove = args.includes('--prove')
  // 0.4.3 (043-3, plan 91 §5.2): `privacy --prove --brief` is the four-line
  // data-handling card (one line per at-rest/sync/export/egress). The full
  // facts/self-check output below stays byte-identical without --brief; --json
  // returns the structured brief instead of the facts document.
  if (args.includes('--brief')) {
    const { buildPrivacyBrief, formatPrivacyBrief } = await loadTrustReport()
    const brief = buildPrivacyBrief({ vaultSealed: Boolean(vaultSealedPath()) })
    if (asJson) { console.log(JSON.stringify(brief, null, 2)); return }
    for (const line of formatPrivacyBrief(brief)) console.log(line)
    return
  }
  // 0.4.0: surface x action x gate matrix generated from the policy registry
  // (read-only; no ledger rows). Replaces the hand-maintained coverage narrative.
  if (args.includes('--matrix')) {
    const policy = await loadPolicy()
    const matrix = policy.surfaceMatrix()
    const payload = { ok: true, command: 'privacy --matrix', policyVersion: matrix.policyVersion, rulesetVersion: matrix.rulesetVersion, generatedAt: new Date().toISOString(), rows: matrix.rows }
    if (asJson) { console.log(JSON.stringify(payload, null, 2)); return }
    console.log('policy matrix · policy v' + payload.policyVersion + ' · ruleset ' + payload.rulesetVersion + ' · generatedAt ' + payload.generatedAt)
    for (const row of payload.rows) console.log(row.surface + '\t' + row.actions.join(',') + '\t' + row.dataClass + '\t' + row.gate + '\tdefault=' + row.default)
    return
  }
  const store = readStoreOrExit()
  let audit = null
  try { const v = store?.verifyAudit(); if (v) audit = { ok: v.ok, count: v.count ?? 0 } } catch {}
  // 0.3.0 P0-L2: report the audit tail anchor next to the chain. Absent is a
  // yellow state (no baseline was ever recorded), not a failure and not proof
  // of tampering; a mismatch is red because it means a tail deletion/rollback.
  let auditAnchor = null
  if (store) {
    try {
      const lib = await loadAuditAnchor()
      const head = lib.readAuditHead(store, { verifyChain: false })
      if (head.ok) {
        const check = lib.verifyAuditAgainstAnchor({ home: HOME, store, head, env: process.env })
        auditAnchor = {
          found: check.found === true,
          status: check.status,
          ok: check.ok === true,
          code: check.code ?? null,
          count: check.anchor?.count ?? null,
          lastSeq: check.anchor?.lastSeq ?? null,
          headHash: check.anchor?.headHash ?? null,
          keyed: check.anchor?.keyed ?? null,
          hmacVerified: check.hmacVerified === true,
          path: check.path ?? null,
          errors: check.errors ?? [],
          warnings: check.warnings ?? [],
        }
      } else {
        auditAnchor = { found: false, status: 'unavailable', ok: false, code: head.code ?? null, count: null, lastSeq: null, headHash: null, keyed: null, hmacVerified: false, path: null, errors: head.errors ?? [], warnings: [] }
      }
    } catch (error) {
      auditAnchor = { found: false, status: 'unavailable', ok: false, code: null, count: null, lastSeq: null, headHash: null, keyed: null, hmacVerified: false, path: null, errors: [String(error?.message ?? error)], warnings: [] }
    }
  }
  // Privacy audit P2-2: list every actual egress surface from the code base
  // instead of two hardcoded names, and never expose internal numbering.
  const egressSurfaces = [
    'model provider — chat / brief --deep / review / learn review (only when ADVISERS_API_KEY is set; ADVISERS_BASE_URL)',
    'research --web|--url — provider web search/read tool (explicit opt-in; no silent research egress)',
    'capture --from-imap — read-only IMAP fetch from the server you configure (TLS by default)',
    'mail sync — IMAP server you configure (TLS/STARTTLS, read-only EXAMINE/FETCH)',
    'mail extract --model — mail body excerpts sent to the model provider only after explicit opt-in + separate consent (ADVISERS_API_KEY)',
    'remind --deliver --notify — optional outbound webhook or local notifier you configure',
    'sync push|pull — the directory you provide; snapshots are AES-256-GCM encrypted before writing',
    'bridge — Hermes file gateway: inbox/outbox JSON files are handed to the Hermes process',
    'MCP --stdio / DSH host tools / pet-brief — local consumers; the host or reader may forward the data',
    'ocr / timestamp — local adapter subprocess you configure (this CLI does not call a cloud OCR/TSA)',
  ]
  const facts = {
    home: HOME,
    database: DB,
    telemetry: 'none',
    default_egress: 'none',
    explicit_egress: egressSurfaces,
    provider: { baseUrl: process.env.ADVISERS_BASE_URL ?? 'https://api.deepseek.com', model: process.env.ADVISERS_MODEL ?? 'deepseek-flash' },
    secret_matter: 'egress fail-closed for secrecy > 0 on the wired model paths (local rule layer)',
    at_rest_encryption: 'opt-in database vault (advisers vault seal); general data is not encrypted at rest',
    audit,
    auditAnchor,
    export: 'advisers export --all',
    delete: 'advisers purge <matter> --yes',
  }
  if (asJson) { console.log(JSON.stringify(facts, null, 2)); return }
  console.log('privacy · local data facts')
  console.log('self-attestation（本地自检口径：只读本机文件/环境与纯函数，不是第三方审计；本命令不联网）')
  console.log(`home:       ${facts.home}`)
  console.log(`database:   ${facts.database}`)
  console.log(`telemetry:  ${facts.telemetry} (build-time statement; this package contains no telemetry code)`)
  console.log(`egress:     ${facts.default_egress} by default — nothing leaves the machine until you configure/opt in to:`)
  for (const surface of egressSurfaces) console.log(`  - ${surface}`)
  console.log(`provider:   ${facts.provider.model} @ ${facts.provider.baseUrl}`)
  console.log(`secret:     ${facts.secret_matter}`)
  console.log(`encryption: ${facts.at_rest_encryption}`)
  console.log(`audit:      ${audit ? (audit.ok ? `verified (${audit.count} entries)` : 'BROKEN') : 'unavailable'}`)
  console.log(`anchor:     ${privacyAnchorLine(auditAnchor)}`)
  console.log(`export:     ${facts.export}`)
  console.log(`delete:     ${facts.delete}`)
  if (prove) {
    const checks = [
      ['home exists', existsSync(HOME), 'local self-check'],
      ['database exists', existsSync(DB), 'local self-check'],
      ['audit verified', Boolean(audit?.ok), 'local self-check: keyed hash chain'],
      ['telemetry disabled', facts.telemetry === 'none', 'local self-check: build-time statement, not network-verified'],
      ['no default network egress', facts.default_egress === 'none', 'local self-check: build-time statement, not network-verified'],
      ['secret matter fail-closed', (() => { try { return Boolean(egressDeniedReason({ secrecy: 1 }, 'prove')) && !egressDeniedReason({ secrecy: 0 }, 'prove') } catch { return false } })(), 'local self-check: egress-gate function; per-path wiring is covered by tests'],
    ]
    console.log('')
    console.log('self-checks（本地自检：结果只说明本机文件/配置与纯函数检查；不是第三方审计，也不证明运行时无出网）')
    let failed = 0
    for (const [name, ok, detail] of checks) { if (!ok) failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} (${detail})`) }
    if (auditAnchor) {
      if (auditAnchor.found !== true) {
        console.log(`[WARN] audit anchor absent (local self-check: yellow, not a PASS — record a baseline with \`advisers audit --write-anchor\` so a later tail deletion is detectable)`)
      } else if (auditAnchor.ok !== true && auditAnchor.status !== 'grown') {
        failed++
        console.log(`[FAIL] audit anchor ${auditAnchor.code ?? auditAnchor.status} (local self-check: the audit tail is shorter/rewritten vs the recorded anchor; see \`advisers audit\`)`)
      }
    }
    console.log('egress gate coverage: chat/model, review, research, brief --deep, learn review, bridge, capture, mail sync and mail extract --model are wired to the local secrecy gate (mail extract --model also requires a separate consent record); the other surfaces listed above are self-attested.')
    if (failed) process.exitCode = 1
  }
}

/** One-line audit-anchor status for `privacy` (yellow absent / red mismatch). */
function privacyAnchorLine(anchor) {
  if (!anchor) return 'unavailable (JSON store or no audit chain)'
  if (anchor.found !== true) {
    if (anchor.status === 'unavailable') return `unavailable (${anchor.code ?? 'no audit head'})`
    return 'absent (yellow — run `advisers audit --write-anchor` to make future tail deletions detectable)'
  }
  if (anchor.status === 'match') return `match (count=${anchor.count} keyed=${anchor.keyed === true ? 'hmac' : 'unkeyed'})`
  if (anchor.status === 'grown') return `grown (anchor ${anchor.count} -> current; run \`advisers audit --write-anchor\` to refresh)`
  return `FAIL (${anchor.code ?? anchor.status}) — see \`advisers audit\``
}

function printLinks() {
  const ledger = loadReadLedger({ links: {}, matters: {} })
  const rows = ledger.listLinks()
  if (!rows.length) { console.log('no links yet'); return }
  const title = new Map(ledger.listMatters().map((m) => [m.id, m.title]))
  for (const l of rows) {
    console.log(`${l.id}\t${l.status}\t${l.type}\t${title.get(l.fromMatter) ?? l.fromMatter} -> ${title.get(l.toMatter) ?? l.toMatter}\tconf=${l.confidence}`)
  }
}

/**
 * JSON Schema (draft 2020-12) for the Pet Brief contract v0.2, generated from
 * the exported lib constants so `--print-schema` also works from the published
 * package (docs/pet-brief/schema-v0.2.json is not in the npm `files`
 * allowlist). The test suite asserts the generated document is deep-equal to
 * the canonical snapshot in docs/pet-brief/schema-v0.2.json.
 */
async function petBriefJsonSchema() {
  const {
    PET_BRIEF_DEFAULT_DISPLAY_POLICY, PET_BRIEF_DISPLAY_POLICIES, PET_BRIEF_MAX_ITEMS,
    PET_BRIEF_MAX_LINE_LENGTH, PET_BRIEF_MAX_SUGGESTED_LINES, PET_BRIEF_MOODS,
    PET_BRIEF_SCHEMA_VERSION, PET_BRIEF_SOURCE,
  } = await loadPetBrief()
  const maxItems = PET_BRIEF_MAX_ITEMS
  const id = { type: 'string', minLength: 1, maxLength: 64 }
  const confidence = { type: 'number', minimum: 0, maximum: 1 }
  const arrayOf = (required, properties) => ({
    type: 'array',
    maxItems,
    items: { type: 'object', additionalProperties: false, required, properties },
  })
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/PerryLink/advisers/docs/pet-brief/schema-v0.2.json',
    title: 'Advisers Pet Brief (contract v0.2)',
    description: 'Read-only, redacted, expiring projection from Advisers to a desktop-pet consumer. No reasoning, secrets, documents, or emotional fields. v0.2 adds displayPolicy (public|private|none); v0.1 briefs had schemaVersion 1 and no displayPolicy.',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'generatedAt', 'expiresAt', 'source', 'displayPolicy', 'counts', 'today', 'commitments', 'risks', 'facts', 'mood', 'suggestedLines', 'redactions'],
    properties: {
      schemaVersion: { type: 'integer', const: PET_BRIEF_SCHEMA_VERSION, description: 'Contract v0.2. v0.1 = 1 is accepted by the producer validator as legacy with warnings; consumers are not required to accept it.' },
      generatedAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: 'string', format: 'date-time', description: 'generatedAt + 5 min by default; consumers discard the brief when now >= expiresAt.' },
      source: { type: 'string', const: PET_BRIEF_SOURCE },
      displayPolicy: {
        type: 'string',
        enum: [...PET_BRIEF_DISPLAY_POLICIES],
        default: PET_BRIEF_DEFAULT_DISPLAY_POLICY,
        description: 'Who may see brief-derived content. public: may be shown whenever the pet is visible (still redacted). private (default): only in a personal/no-bystander context; the consumer must auto-collapse, one-click hide and hide during screen sharing/recording. none: consumer must not render or retain any brief-derived content (treat as disabled). Missing (legacy v0.1) means private.',
      },
      counts: {
        type: 'object',
        additionalProperties: false,
        required: ['today', 'commitments', 'risks', 'facts'],
        properties: {
          today: { type: 'integer', minimum: 0, maximum: maxItems },
          commitments: { type: 'integer', minimum: 0, maximum: maxItems },
          risks: { type: 'integer', minimum: 0, maximum: maxItems },
          facts: { type: 'integer', minimum: 0, maximum: maxItems },
        },
      },
      today: arrayOf(['id', 'title', 'status'], {
        id,
        title: { type: 'string', minLength: 1, maxLength: 80 },
        status: { type: 'string', enum: ['open', 'doing', 'done'] },
      }),
      commitments: arrayOf(['id', 'matter', 'who', 'what', 'due', 'risk', 'confidence'], {
        id,
        matter: { type: 'string', minLength: 1, maxLength: 64 },
        who: { type: 'string', minLength: 1, maxLength: 40 },
        what: { type: 'string', minLength: 1, maxLength: 80 },
        due: { type: 'string', minLength: 1, maxLength: 32 },
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        confidence,
      }),
      risks: arrayOf(['id', 'level', 'summary', 'evidence', 'confidence'], {
        id,
        level: { type: 'string', enum: ['low', 'medium', 'high'] },
        summary: { type: 'string', minLength: 1, maxLength: 80 },
        evidence: { type: 'string', minLength: 1, maxLength: 64 },
        confidence,
      }),
      facts: arrayOf(['id', 'subject', 'predicate', 'value', 'confidence'], {
        id,
        subject: { type: 'string', minLength: 1, maxLength: 40 },
        predicate: { type: 'string', minLength: 1, maxLength: 40 },
        value: { type: 'string', minLength: 1, maxLength: 80 },
        confidence,
      }),
      mood: { type: 'string', enum: [...PET_BRIEF_MOODS], description: 'Workload-only rendering hint, never an emotional state about the user.' },
      suggestedLines: {
        type: 'array',
        maxItems: PET_BRIEF_MAX_SUGGESTED_LINES,
        items: { type: 'string', minLength: 1, maxLength: PET_BRIEF_MAX_LINE_LENGTH },
      },
      redactions: {
        type: 'array',
        maxItems,
        items: { type: 'string', minLength: 1, maxLength: 80 },
      },
    },
  }
}

/**
 * `advisers pet-brief` — read-only projection for the pet (contract v0.2).
 * Never opens the store read-write, never calls a model, never writes the
 * ledger. The only write is the optional `--out` file (0600, atomic rename).
 *
 * CLI surface: `--json`, `--out [path]`, `--check [--strict] [--in file]`,
 * `--display-policy public|private|none` and `--print-schema`. Warnings from
 * the validator are reported but never change the exit code (strict mode turns
 * legacy/missing-displayPolicy into errors instead).
 */
async function petBrief(args) {
  const {
    PET_BRIEF_DEFAULT_DISPLAY_POLICY, PET_BRIEF_DISPLAY_POLICIES, PET_BRIEF_MAX_ITEMS,
    PET_BRIEF_MAX_LINE_LENGTH, PET_BRIEF_MAX_SUGGESTED_LINES, PET_BRIEF_MIN_CONFIDENCE, PET_BRIEF_MOODS,
    PET_BRIEF_SCHEMA_VERSION, PET_BRIEF_SOURCE, buildPetBrief, validatePetBrief, writePetBriefAtomic,
  } = await loadPetBrief()
  const { flags } = parseFlags(args)
  const asJson = args.includes('--json')
  const check = args.includes('--check')
  const strict = args.includes('--strict')
  const printSchema = args.includes('--print-schema')
  const inFile = flags.in
  const outFlag = flags.out
  const displayPolicyFlag = flags['display-policy']
  const fail = (code, message) => {
    console.error(JSON.stringify({ error: { code, message } }))
    process.exitCode = 1
  }
  if (printSchema) {
    if (inFile !== undefined || outFlag !== undefined || displayPolicyFlag !== undefined || asJson || check) {
      return fail('E_USAGE', '--print-schema cannot be combined with other pet-brief options')
    }
    console.log(JSON.stringify(await petBriefJsonSchema(), null, 2))
    return
  }
  if (inFile !== undefined && !check) return fail('E_USAGE', '--in can only be used with --check')
  if (inFile !== undefined && typeof inFile !== 'string') return fail('E_USAGE', '--in needs a file path')
  if (outFlag !== undefined && typeof outFlag !== 'string' && outFlag !== true) return fail('E_USAGE', '--out takes an optional file path')
  if (strict && !check) return fail('E_USAGE', '--strict can only be used with --check')
  let displayPolicy
  if (displayPolicyFlag !== undefined) {
    if (typeof displayPolicyFlag !== 'string' || !PET_BRIEF_DISPLAY_POLICIES.includes(displayPolicyFlag)) {
      return fail('E_USAGE', `--display-policy must be one of ${PET_BRIEF_DISPLAY_POLICIES.join('|')}`)
    }
    if (inFile !== undefined) return fail('E_USAGE', '--display-policy can only be used when generating a brief')
    displayPolicy = displayPolicyFlag
  }
  const validateOptions = strict ? { now: Date.now(), acceptLegacy: false, requireDisplayPolicy: true } : { now: Date.now() }
  try {
    if (inFile) {
      let text
      try { text = readFileSync(inFile, 'utf8') } catch (error) { return fail('E_READ', `cannot read ${inFile}: ${error.message}`) }
      const result = validatePetBrief(text, validateOptions)
      console.log(JSON.stringify({ ok: result.ok, checked: inFile, expiresAt: result.brief?.expiresAt ?? null, counts: result.brief?.counts ?? null, errors: result.errors, warnings: result.warnings }, null, 2))
      if (!result.ok) process.exitCode = 1
      return
    }
    // P1-1/P0-1: pet-brief is a pure read. Report a sealed vault with the stable
    // code instead of "store not found"; 0.2.3's read path takes no HOME lock, so
    // a live writer cannot block it and it writes/chmods nothing. A missing
    // plaintext database stays the documented structured "store not found" error
    // (this command never initializes a database).
    if (mode === 'sqlite') {
      const sealed = vaultSealedPath()
      if (sealed) return fail('E_VAULT_SEALED', 'the database is sealed at ' + sealed + '; run "ADVISERS_VAULT_PASSPHRASE=... advisers vault unseal" first (no empty database was created)')
    }
    let ledger
    let nameCandidates
    if (mode === 'json' || !existsSync(DB)) {
      const { readLedgerSnapshotReadOnly } = await import('../lib/pet-brief-store.js')
      let snapshot
      try {
        snapshot = readLedgerSnapshotReadOnly({ store: mode, dbPath: DB, statePath: STATE })
      } catch (error) {
        return fail(error?.code ?? 'E_STORE', error?.message ?? String(error))
      }
      ledger = Ledger.fromJSON(snapshot)
    } else {
      // 0.3.0 P0-T2: buildPetBrief reads matters/commitments/facts only. The
      // narrow projections give it the same rows it used to get from whole
      // entities (top-N facts by the same comparator, open commitments with an
      // SQL-computed hasEvidence flag, the redactor name candidates) without
      // the full-entity mapping and without the status+rowid TEMP B-TREE spill.
      try {
        const store = openReadStore()
        const projected = store.read(() => {
          const matters = store.loadMatters()
          const secrecyOf = (matter) => {
            const level = Number(matter.secrecy ?? 0)
            return Number.isFinite(level) ? level : Number.POSITIVE_INFINITY
          }
          const publicMatterIds = matters.filter((matter) => matter.status === 'active' && secrecyOf(matter) < 2).map((matter) => matter.id)
          return {
            matters,
            commitments: store.projectCommitmentsForPetBrief(),
            facts: store.projectFactsForPetBrief({
              limit: PET_BRIEF_MAX_ITEMS,
              minConfidence: PET_BRIEF_MIN_CONFIDENCE,
              matterIds: publicMatterIds,
            }),
            names: [...new Set([
              ...store.projectCommitmentCreditorCandidates(),
              ...store.projectFactSubjectCandidates(),
            ])],
          }
        })
        ledger = {
          listMatters: (status) => status === undefined ? projected.matters : projected.matters.filter((matter) => matter.status === status),
          listCommitments: () => projected.commitments,
          listFacts: () => projected.facts,
        }
        nameCandidates = projected.names
      } catch (error) {
        const code = error?.code === 'E_SCHEMA_STALE' || error?.code === 'E_SCHEMA_NEWER' ? error.code : 'E_STORE'
        return fail(code, error?.message ?? String(error))
      }
    }
    const brief = buildPetBrief(ledger, {
      now: Date.now(),
      ...(nameCandidates ? { nameCandidates } : {}),
      ...(displayPolicy ? { displayPolicy } : {}),
    })
    if (check) {
      const result = validatePetBrief(brief, validateOptions)
      console.log(JSON.stringify({ ok: result.ok, checked: 'generated', expiresAt: brief.expiresAt, counts: brief.counts, errors: result.errors, warnings: result.warnings }, null, 2))
      if (!result.ok) process.exitCode = 1
      return
    }
    const outPath = outFlag === true ? join(HOME, 'pet-brief.json') : outFlag
    if (outPath) {
      try { writePetBriefAtomic(outPath, brief) } catch (error) { return fail('E_WRITE', `cannot write ${outPath}: ${error.message}`) }
    }
    if (asJson) { console.log(JSON.stringify(brief, null, 2)); return }
    console.log(`pet-brief · ${brief.counts.today} today · ${brief.counts.commitments} commitments · ${brief.counts.risks} risks · ${brief.counts.facts} facts`)
    console.log(`mood ${brief.mood} · expires ${brief.expiresAt} · displayPolicy ${brief.displayPolicy}`)
    if (outPath) console.log(`wrote ${outPath} (mode 600, atomic)`)
  } catch (error) {
    fail(error?.code ?? 'E_BRIEF', error?.message ?? String(error))
  }
}

function tokenize(text) {
  return new Set((String(text).toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fa5]{2}/g) ?? []))
}

function printLearnReceipt(result) {
  const p = result.preference
  console.log(`记下了：${p.statement}`)
  console.log(`范围：全局（默认）；要限定说「只对…」`)
  console.log(`有效期：30 天后复核${result.promoted ? '；已确认' : '；先按候选，重复一次才确认'}`)
  console.log(`下次：同类任务按这条执行；撤销用 /forget ${p.id}`)
}

function printPreferences() {
  const ledger = loadReadLedger({ preferences: {} })
  const rows = ledger.listPreferences({ includeCandidates: true })
  if (!rows.length) { console.log('no preferences yet'); return }
  for (const p of rows) {
    console.log(`${p.id}\t${p.status}\tconf=${p.confidence.toFixed(2)}\t${p.statement}`)
  }
}

/**
 * `advisers doctor [--check-db] [--json]` — local diagnostics.
 *
 * Default is intentionally lightweight (0.2.3 Wave 1 / robustness P1-4):
 * opening the store validates the file header, instance lock and WAL; the O(db)
 * PRAGMA quick_check and O(index) FTS verification only run with --check-db,
 * together with WAL/backup/plaintext/temp-file checks. Any FAIL exits non-zero.
 *
 * 0.3.0 P0-D1 adds the recovery console:
 *   doctor --repair [--dry-run|--yes] [--only lock,temp,wal,fts] [--json]
 * --dry-run (the default) only prints a plan; --yes takes the writer lock,
 * writes a safety backup, repairs the selected items, re-verifies, records one
 * `doctor.repair` audit row and a fresh audit anchor. Unsupported --only items
 * and unknown flags fail closed with E_USAGE instead of being ignored.
 */
async function doctor(args = []) {
  if (args.includes('--help') || args.includes('-h')) { console.log(DOCTOR_USAGE); return }
  const parsed = parseStrictFlags(args, {
    booleans: ['check-db', 'json', 'repair', 'dry-run', 'yes', 'report'],
    values: ['only'],
    positional: false,
  })
  if (!parsed.ok) return usageFail(parsed.error, DOCTOR_USAGE)
  const flags = parsed.flags
  // --report/--repair are mutually exclusive: the report is a read-only
  // statement of what was (not) measured, the repair console mutates files.
  if (flags.report === true && flags.repair === true) return usageFail('--report cannot be combined with --repair', DOCTOR_USAGE)
  if (flags.repair === true) return doctorRepair(flags)
  if (flags['dry-run'] || flags.yes) return usageFail('--dry-run/--yes are only valid with --repair', DOCTOR_USAGE)
  if (flags.only !== undefined) return usageFail('--only is only valid with --repair', DOCTOR_USAGE)
  const checkDb = flags['check-db'] === true
  const asJson = flags.json === true
  const rows = []
  const check = (name, ok, detail = '') => rows.push({ name, ok, detail })
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
  check('node', nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 16), process.version)
  try { ensureHome(); check('home', existsSync(HOME), HOME) } catch (error) { check('home', false, error.message) }
  // Sealed vault (robustness audit P1-1): report the real state instead of
  // silently creating an empty database and printing all-PASS diagnostics.
  const sealed = vaultSealedPath()
  if (sealed) {
    check('vault', true, `sealed (${sealed}); run ` + '`advisers vault unseal`')
    check('lock', true, 'not taken (vault sealed)')
    check('database', true, 'skipped (vault sealed)')
    check('sqlite', true, 'skipped (vault sealed)')
    check('audit', true, 'skipped (vault sealed)')
    check('schema', true, 'skipped (vault sealed)')
  } else if (mode === 'json') {
    // Legacy JSON store: there is no SQLite file/WAL/audit chain to inspect.
    check('database', true, existsSync(STATE) ? `${STATE} (JSON store)` : `${STATE} (JSON store, not initialized yet)`)
    check('sqlite', true, 'skipped (ADVISERS_STORE=json)')
    check('audit', true, 'unavailable (the JSON store has no audit chain)')
    check('schema', true, 'n/a (JSON store)')
    if (checkDb) check('db-integrity', true, 'skipped (JSON store mode)')
  } else {
    // 0.2.3 §4.7: doctor no longer takes the writer lock. The lock row reports
    // who holds it (informational, never a FAIL), and every read-only check runs
    // on the lock-free snapshot -- a live mcp/bridge therefore no longer makes
    // doctor red or blocks diagnosis.
    let lockDetail = `${LOCK_PATH} (not held)`
    try {
      const lockInfo = readInstanceLock(HOME)
      if (lockInfo?.record && !instanceLockIsStale(lockInfo)) {
        lockDetail = `${lockInfo.file} (held by pid ${lockInfo.record.pid}${lockInfo.record.command ? `: ${lockInfo.record.command}` : ''})`
      } else if (lockInfo) {
        lockDetail = `${lockInfo.file} (stale, reclaimable)`
      }
    } catch (error) { lockDetail = `${LOCK_PATH} (unreadable: ${error.message})` }
    check('lock', true, lockDetail)
    try {
      const store = openReadStore()
      let dbBytes = 0
      try { dbBytes = statSync(DB).size } catch {}
      check('database', dbBytes > 0, dbBytes > 0 ? `${DB} (${dbBytes} bytes)` : `E_DB_CORRUPT: ${DB} is 0 bytes; back it up and restore`)
      // The open inspected a broken WAL; surface it here (cheap) even without
      // --check-db. A read-only open never quarantines: --check-db tells the
      // user to run a writable command for that.
      const wal = store.walStatus ?? inspectWalStatus(DB)
      const walBad = ['invalid', 'truncated', 'unreadable'].includes(String(wal?.status))
      // The lightweight read-only open cannot quarantine a broken WAL. With
      // --check-db the writable maintenance section below handles it; only the
      // default (lightweight) doctor reports it as a standing failure.
      const walDeferred = checkDb && walBad
      check('wal', !walBad || walDeferred, `${wal?.status ?? 'unknown'}${wal?.bytes ? ` bytes=${wal.bytes}` : ''}${wal?.reason ? ` (${wal.reason})` : ''}${walDeferred ? '; deferred to --check-db maintenance' : checkDb ? '' : '; run --check-db for quick_check + FTS'}`)
      // 0.2.3 Wave 1: quick_check/FTS moved behind --check-db so the default
      // doctor stays sub-200ms on a large ledger.
      check('sqlite', true, `${DB} (opened read-only; run --check-db for quick_check + FTS integrity)`)
      const audit = store.verifyAudit()
      check('audit', audit.ok, audit.ok ? `${audit.count} entries` : `BROKEN at seq ${audit.seq}`)
      check('schema', true, String(store.schemaVersion() ?? '?'))
    } catch (error) {
      if (error?.code === 'E_DB_LOCKED') {
        // Only possible before the database exists (a first run needs the
        // writable path); nothing can be read, so this stays a real FAIL.
        check('sqlite', false, 'skipped (database does not exist yet and another instance holds the writer lock)')
      } else if (error?.code === 'E_DB_CORRUPT') {
        check('database', false, error.message)
        check('sqlite', false, 'refusing to open a 0-byte/corrupt database (no silent rebuild)')
        check('audit', false, 'skipped (database damaged)')
        check('schema', false, 'skipped (database damaged)')
      } else if (error?.code === 'E_SCHEMA_STALE' || error?.code === 'E_SCHEMA_NEWER') {
        check('sqlite', false, error.message)
        check('schema', false, 'skipped (schema needs a writable command)')
      } else {
        check('sqlite', false, error.message)
      }
    }
    if (checkDb && !sealed) {
      // 0.2.3 §4.7: --check-db is the explicit maintenance path. FTS5's
      // 'integrity-check' writes an internal row, so quick_check/FTS verification
      // needs a WRITABLE connection inside the instance lock; a read-only one
      // reports 'attempt to write a readonly database' and turned a healthy
      // fresh home into a FAIL. A live ui/mcp/bridge holder therefore fails this
      // explicit check with a clear E_DB_LOCKED hint instead; the default
      // lightweight doctor above stays read-only and works while locked.
      try {
        const maintenanceStore = openStore()
        // One aggregate report reuses the Wave 0 lib contracts:
        // store.integrityReport() (quick_check + walReport + verifyFtsIntegrity).
        const report = maintenanceStore.integrityReport({ quickCheck: true, fts: true })
        const quick = report.quickCheck
        check('db-quick-check', quick?.ok === true, quick ? (quick.ok ? 'ok' : String(quick.verdict ?? quick.error ?? 'failed')) : 'skipped')
        const fts = report.fts
        const ftsOk = Boolean(fts && fts.ok)
        check('db-fts', ftsOk, !fts
          ? 'skipped'
          : `state=${fts.state} tokenizer=${fts.tokenizer ?? '-'}${ftsOk ? '' : ` errors=${(fts.errors ?? []).slice(0, 2).join(' | ')}`}`)
        const walReport = report.wal ?? maintenanceStore.walReport()
        check('db-wal', walReport.ok === true, `journal=${walReport.journalMode ?? '?'} initial=${walReport.initial?.status ?? '?'} current=${walReport.current?.status ?? '?'}${walReport.ok ? '' : `; ${(report.errors ?? []).slice(0, 1).join('')}`}`)
        // 0.3.0 P0-L2: report the audit tail anchor next to the chain. No anchor
        // is yellow (no baseline was recorded), not a failure.
        try {
          const anchorLib = await loadAuditAnchor()
          const anchorHead = anchorLib.readAuditHead(maintenanceStore, { verifyChain: false })
          if (anchorHead.ok !== true) {
            check('db-anchor', false, `cannot read the audit head (${anchorHead.code ?? 'unknown'})`)
          } else {
            const anchorCheck = anchorLib.verifyAuditAgainstAnchor({ home: HOME, store: maintenanceStore, head: anchorHead, env: process.env })
            const yellow = anchorCheck.status === 'absent' || anchorCheck.status === 'grown'
            let detail
            if (anchorCheck.status === 'match') detail = `match (count=${anchorCheck.anchor?.count ?? '?'} keyed=${anchorCheck.anchor?.keyed === true ? 'hmac' : 'unkeyed'})`
            else if (anchorCheck.status === 'grown') detail = `grown (anchor ${anchorCheck.anchor?.count ?? '?'} -> current ${anchorCheck.head?.count ?? '?'}; run \`advisers audit --write-anchor\` to refresh)`
            else if (anchorCheck.status === 'absent') detail = 'absent (yellow: no baseline; run \`advisers audit --write-anchor\`)'
            else detail = `FAIL ${anchorCheck.code ?? anchorCheck.status}: ${(anchorCheck.errors ?? [])[0] ?? ''}`
            check('db-anchor', anchorCheck.ok === true || yellow, detail)
          }
        } catch (error) { check('db-anchor', false, String(error?.message ?? error)) }
        checkBackupReadable(check)
      } catch (error) {
        if (error?.code === 'E_DB_LOCKED') {
          check('db-integrity', false, `${error.message}; stop the long-running advisers process (ui/mcp/bridge) and retry, or run the lightweight \`advisers doctor\` without --check-db`)
        } else {
          check('db-integrity', false, `cannot open a writable connection for the database checks: ${error.message}`)
        }
      }
    }
  }
  if (checkDb) {
    // Crash residue from an interrupted sync pull: only stale temp files whose
    // pid is gone are removed (a concurrent pull is never disturbed).
    try {
      const { cleanupStalePullTemps } = await loadSync()
      const swept = cleanupStalePullTemps(HOME)
      check('pull-temps', swept.errors.length === 0, `${swept.removed.length} stale temp(s) removed, ${swept.kept.length} kept${swept.errors.length ? `; errors: ${swept.errors.slice(0, 2).join(' | ')}` : ''}`)
    } catch (error) {
      check('pull-temps', false, String(error?.message ?? error))
    }
    const copies = plaintextDbCopies()
    const detail = copies.length
      ? `${copies.length} plaintext cop(ies)${sealed ? ' after seal' : ' (documented DB copies; purge with \`advisers vault seal --remove\`)'}: ${copies.slice(0, 6).map((file) => basename(file)).join(', ')}`
      : 'none'
    // A sealed vault plus leftover plaintext copies is a leak (FAIL); with a
    // live plaintext DB these copies are documented backups (informational).
    check('plaintext', sealed ? copies.length === 0 : true, detail)
  }
  // P2-3 (0.2.1): probe resolvability instead of importing the office barrel
  // (222-573ms, and only needed to answer "is the peer installed?").
  let officeOk = false
  try { officeOk = Boolean(import.meta.resolve('advisers-office')) } catch {}
  if (!officeOk) officeOk = existsSync(new URL('../../office/dist/index.js', import.meta.url))
  check('office', officeOk, officeOk ? 'advisers-office resolvable' : 'npm i -g advisers-office@next, or ADVISERS_OFFICE_LOCAL=1 in checkout')
  check('policy', Boolean(StrictPolicyPack), StrictPolicyPack ? 'strict pack loaded' : 'policy pack missing')
  check('model', true, process.env.ADVISERS_API_KEY ? 'API key present (not tested)' : 'optional; ADVISERS_API_KEY not set')
  const ok = !rows.some((row) => !row.ok)
  // 0.4.3 (043-3, plan 91 §5.3): `doctor --report` is the machine report whose
  // unknowns are explicit null — never 0/false/PASS. `ok` reflects only this
  // check table; the measured dimensions were not measured by this build.
  if (flags.report === true) {
    const { buildDoctorReport } = await loadTrustReport()
    const report = buildDoctorReport({
      ok,
      schemaVersion: mode === 'json' || sealed ? null : SCHEMA_VERSION,
      notices: rows.filter((row) => !row.ok).map((row) => 'check failed: ' + row.name),
    })
    if (asJson) {
      console.log(JSON.stringify(report, null, 2))
      if (!ok) process.exitCode = 1
      return
    }
    console.log('report v' + report.reportVersion + '  ok=' + report.ok + '  advisers=' + (report.advisersVersion ?? '?') + '  schema=' + (report.schemaVersion === null ? 'null' : 'v' + report.schemaVersion))
    console.log('generatedAt: ' + report.generatedAt)
    console.log('measured（未测量一律 null，不用 0/false/PASS 冒充）:')
    for (const key of Object.keys(report.measured)) console.log('  ' + key + ': ' + String(report.measured[key]))
    console.log('nulls:')
    for (const entry of report.nulls) console.log('  ' + entry.key + ': ' + entry.reason)
    if (report.notices.length) { console.log('notices:'); for (const line of report.notices) console.log('  - ' + line) }
    if (report.limitations.length) { console.log('limitations:'); for (const line of report.limitations) console.log('  - ' + line) }
    if (!ok) process.exitCode = 1
    return
  }
  if (asJson) {
    console.log(JSON.stringify({ ok, mode: 'diagnose', checks: rows }, null, 2))
    if (!ok) process.exitCode = 1
    return
  }
  for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}  ${row.detail}`)
  if (!ok) process.exitCode = 1
}

/* ---------------------------------------------------------------------------
 * 0.3.0 P0-D1: `doctor --repair` (recovery console).
 *
 * Registry (MVP, matching 04-0.3-research §4.2): lock / temp / wal / fts.
 * Invariants: dry-run is the default; apply takes the single-writer lock; a
 * safety backup of the live database is written BEFORE any mutation and a
 * backup failure aborts the whole repair (fail-closed); each run appends one
 * `doctor.repair` audit row and refreshes the audit anchor; the final step
 * re-verifies with quick_check + FTS integrity and exits non-zero on any
 * remaining failure. Audit reasons carry basenames only (no absolute paths).
 * `plaintext`/`backup` are intentionally not auto-repaired here: --only rejects
 * them (E_USAGE) instead of pretending to fix them.
 * ------------------------------------------------------------------------- */

const DOCTOR_REPAIR_ITEMS = ['lock', 'temp', 'wal', 'fts']
const REPAIR_STALE_TEMP_MS = 60 * 60 * 1000

/** Parse/validate the --only list for doctor --repair. */
function repairItemSelection(only) {
  if (only === undefined) return { ok: true, items: DOCTOR_REPAIR_ITEMS.slice() }
  const items = String(only).split(',').map((value) => value.trim()).filter(Boolean)
  if (!items.length) return { ok: false, error: '--only requires at least one item' }
  const unique = [...new Set(items)]
  const unknown = unique.filter((item) => !DOCTOR_REPAIR_ITEMS.includes(item))
  if (unknown.length) return { ok: false, error: `unsupported repair item(s): ${unknown.join(', ')} (supported: ${DOCTOR_REPAIR_ITEMS.join(', ')}) ' }`.trim() }
  return { ok: true, items: unique }
}

function repairStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Stale crash-residue scan (read-only): fs-safe temp files (".<name>.tmp-<pid>-…")
 * and staged sync-pull copies (".advisers-pull-verify-<pid>-…"). A live pid is
 * never touched; pull stages additionally must be older than the 1h stale window.
 */
function scanRepairTempFiles() {
  const result = { candidates: [], errors: [] }
  for (const dir of [HOME, join(HOME, 'backups')]) {
    let names
    try { names = readdirSync(dir) } catch (error) { if (error?.code !== 'ENOENT') result.errors.push(`${basename(dir)}: ${error?.code ?? error?.message ?? error}`); continue }
    for (const name of names) {
      const file = join(dir, name)
      let info
      try { info = statSync(file) } catch { continue }
      if (!info.isFile()) continue
      let pid = null
      let stale = false
      if (name.startsWith('.advisers-pull-verify-')) {
        pid = Number.parseInt(name.slice('.advisers-pull-verify-'.length).split('-')[0], 10)
        stale = Date.now() - info.mtimeMs >= REPAIR_STALE_TEMP_MS
      } else {
        const match = /^\.(.+)\.tmp-(\d+)-/.exec(name)
        if (!match) continue
        pid = Number(match[2])
        stale = true
      }
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
      let alive = false
      try { process.kill(pid, 0); alive = true } catch (error) { alive = error?.code === 'EPERM' }
      if (alive || !stale) continue
      result.candidates.push({ path: file, name, pid, ageMs: Date.now() - info.mtimeMs })
    }
  }
  return result
}

/** Cheap read-only FTS consistency probe (integrity-check itself needs a write). */
function probeFtsReadOnly(store) {
  const probe = { ok: true, state: 'ok', issues: [] }
  try {
    const tables = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('turns_fts', 'summaries_fts')").all().map((row) => row.name))
    if (tables.size === 0) return { ok: true, state: 'degraded', issues: ['no FTS index table (search uses LIKE)'] }
    const triggers = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((row) => row.name))
    for (const [table, source, needed] of [
      ['turns_fts', 'turns', ['turns_ai', 'turns_ad', 'turns_au']],
      ['summaries_fts', 'session_summaries', ['summaries_ai', 'summaries_ad', 'summaries_au']],
    ]) {
      if (!tables.has(table)) { probe.ok = false; probe.state = 'inconsistent'; probe.issues.push(`${table}: index table missing`); continue }
      const missing = needed.filter((name) => !triggers.has(name))
      if (missing.length) { probe.ok = false; probe.state = 'inconsistent'; probe.issues.push(`${table}: sync trigger(s) missing: ${missing.join(', ')}`) }
      try {
        const sourceCount = Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${source}`).get()?.n ?? 0)
        const indexCount = Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}_docsize`).get()?.n ?? 0)
        if (sourceCount !== indexCount) { probe.ok = false; probe.state = 'inconsistent'; probe.issues.push(`${table}: index has ${indexCount} row(s) for ${sourceCount} source row(s)`) }
      } catch (error) { probe.issues.push(`${table}: count probe failed (${error?.message ?? error})`) }
    }
    if (probe.issues.length && probe.ok) { probe.ok = false; probe.state = 'unknown' }
  } catch (error) { return { ok: false, state: 'unknown', issues: [String(error?.message ?? error)] } }
  return probe
}

/** Read-only repair plan (never writes). */
async function buildRepairPlan(items) {
  const plan = { ok: true, issues: [], blockers: [], errors: [], warnings: [] }
  if (items.includes('lock')) {
    try {
      const info = readInstanceLock(HOME)
      if (info) {
        if (info.record && !instanceLockIsStale(info)) {
          plan.blockers.push(`the writer lock is held by a live process (pid ${info.record.pid}${info.record.command ? ': ' + info.record.command : ''}); stop it before repairing`)
        } else if (instanceLockIsStale(info)) {
          plan.issues.push({ item: 'lock', action: 'remove the stale instance lock', detail: 'instance.lock' })
        }
      }
    } catch (error) { plan.errors.push(`cannot inspect the instance lock: ${error?.message ?? error}`) }
  }
  if (items.includes('temp')) {
    const temp = scanRepairTempFiles()
    for (const candidate of temp.candidates) plan.issues.push({ item: 'temp', action: 'remove a stale temp file left by a crashed process', detail: candidate.name })
    for (const error of temp.errors) plan.errors.push(error)
  }
  let walBad = false
  if (items.includes('wal')) {
    try {
      const wal = inspectWalStatus(DB)
      walBad = ['invalid', 'truncated', 'unreadable'].includes(String(wal?.status))
      if (walBad) plan.issues.push({ item: 'wal', action: `preserve and move aside the unusable WAL (status=${wal.status}${wal.reason ? ', ' + wal.reason : ''})`, detail: basename(wal.path) })
    } catch (error) { plan.errors.push(`cannot inspect the WAL: ${error?.message ?? error}`) }
  }
  if (items.includes('fts')) {
    try {
      if (existsSync(DB) && !walBad) {
        const readStore = openReadStoreLib(DB)
        try {
          const probe = probeFtsReadOnly(readStore)
          if (!probe.ok) plan.issues.push({ item: 'fts', action: `rebuild the FTS indexes (${probe.state})`, detail: probe.issues.slice(0, 2).join(' | ') })
        } finally { try { readStore.close() } catch {} }
      } else if (walBad) {
        plan.warnings.push('fts: detection deferred until the WAL item is repaired (read-only probe skipped)')
      }
    } catch (error) { plan.warnings.push(`fts: read-only probe skipped (${error?.code ?? error?.message ?? error})`) }
  }
  plan.ok = plan.blockers.length === 0 && plan.errors.length === 0
  return plan
}

/** Safety backup before a repair mutation; a failure must abort the repair. */
async function makeRepairBackup(walBad) {
  const lib = await loadBackup()
  const target = lib.backupPathFor({ home: HOME, tag: 'pre-repair' })
  let store = null
  if (!walBad) { try { store = openStore() } catch { store = null } }
  return lib.createBackup({
    dbPath: DB,
    targetPath: target,
    store,
    checkpoint: Boolean(store),
    verify: true,
    verifyChain: false,
    writeSha256: true,
  })
}

/** Shared text/JSON reporting for a repair failure before any mutation. */
function reportRepairFailure(result, asJson) {
  if (asJson) console.log(JSON.stringify({ ...result, ok: false }, null, 2))
  else {
    console.error(`repair: FAILED ${result.errors?.[0] ? '(' + result.errors[0] + ')' : ''}`)
    for (const error of result.errors ?? []) if (error !== result.errors[0]) console.error(`  ${error}`)
    console.error('  nothing was changed; the live database is intact.')
  }
  process.exitCode = 1
}

/**
 * `advisers doctor --repair` — plan (default) or apply the recovery actions.
 */
async function doctorRepair(flags) {
  const asJson = flags.json === true
  if (flags['dry-run'] === true && flags.yes === true) return usageFail('--dry-run and --yes are mutually exclusive', DOCTOR_USAGE)
  const selection = repairItemSelection(flags.only)
  if (!selection.ok) return usageFail(selection.error, DOCTOR_USAGE)
  if (mode === 'json') return usageFail('doctor --repair requires the SQLite store (ADVISERS_STORE=sqlite)', DOCTOR_USAGE)
  const items = selection.items
  const apply = flags.yes === true && flags['dry-run'] !== true
  ensureHome()
  const plan = await buildRepairPlan(items)
  if (!apply) {
    const payload = { ok: plan.ok, mode: 'dry-run', only: items, issues: plan.issues, blockers: plan.blockers, errors: plan.errors, warnings: plan.warnings }
    if (asJson) console.log(JSON.stringify(payload, null, 2))
    else {
      console.log(`repair: dry-run (no changes) · only=${items.join(',')}`)
      if (!plan.issues.length && !plan.blockers.length) console.log('repair: nothing to do')
      for (const blocker of plan.blockers) console.error(`blocked: ${blocker}`)
      for (const issue of plan.issues) console.log(`plan: ${issue.item} — ${issue.action}${issue.detail ? ' [' + issue.detail + ']' : ''}`)
      for (const warning of plan.warnings) console.log(`warning: ${warning}`)
      for (const error of plan.errors) console.error(`error: ${error}`)
      if (plan.issues.length) console.log('next: advisers doctor --repair --yes   (writes a safety backup, repairs, re-verifies and audits)')
    }
    if (!plan.ok) process.exitCode = 1
    return
  }
  if (!plan.issues.length && !plan.blockers.length && !plan.errors.length) {
    if (asJson) console.log(JSON.stringify({ ok: true, mode: 'apply', only: items, fixed: [], issues: [], note: 'nothing to do' }, null, 2))
    else console.log('repair: nothing to do (no selected issue detected)')
    return
  }
  const result = { ok: false, mode: 'apply', only: items, fixed: [], backup: null, errors: [], verify: null, audit: null, anchor: null }
  // 1) Stale lock first: the writer lock below would otherwise wait/fail.
  if (items.includes('lock')) {
    try {
      const info = readInstanceLock(HOME)
      if (info) {
        if (info.record && !instanceLockIsStale(info)) {
          result.errors.push(`the writer lock is held by a live process (pid ${info.record.pid}${info.record.command ? ': ' + info.record.command : ''}); stop it and retry`)
          return reportRepairFailure(result, asJson)
        }
        rmWithRetrySync(info.file)
        result.fixed.push('lock')
      }
    } catch (error) { result.errors.push(`lock: ${error?.message ?? error}`); return reportRepairFailure(result, asJson) }
  }
  try { ensureInstanceLock() } catch (error) { return reportMaintenanceFailure(error, asJson, 'repair') }
  // 2) Safety backup before opening/mutating the database (every repair item per
  // 04-0.3-research §4.2). Abort on failure: fail-closed, nothing is changed.
  if (existsSync(DB)) {
    const backup = await makeRepairBackup(plan.issues.some((issue) => issue.item === 'wal'))
    if (!backup.ok) {
      result.errors.push(...(backup.errors ?? [`safety backup failed (${backup.code ?? 'unknown'})`]))
      return reportRepairFailure(result, asJson)
    }
    result.backup = backup.path
  }
  // 3) WAL: preserve the unusable sidecar, keep the main database, never touch it.
  if (items.includes('wal') && plan.issues.some((issue) => issue.item === 'wal')) {
    try {
      const wal = inspectWalStatus(DB)
      if (['invalid', 'truncated', 'unreadable'].includes(String(wal?.status))) {
        const quarantined = `${DB}${WAL_CORRUPT_SUFFIX}${repairStamp()}`
        renameWithRetrySync(wal.path, quarantined)
        try { if (existsSync(DB + '-shm')) rmWithRetrySync(DB + '-shm') } catch {}
        result.fixed.push('wal')
        result.walQuarantined = basename(quarantined)
      }
    } catch (error) { result.errors.push(`wal: ${error?.message ?? error}`) }
  }
  // 4) Stale crash residue.
  if (items.includes('temp')) {
    const temp = scanRepairTempFiles()
    for (const candidate of temp.candidates) {
      try { rmWithRetrySync(candidate.path); result.fixed.push('temp') } catch (error) { result.errors.push(`temp ${candidate.name}: ${error?.message ?? error}`) }
    }
  }
  // 5) FTS via a writable store (integrity-check/rebuild need writes).
  let store = null
  try { store = openStore() } catch (error) { result.errors.push(`sqlite: ${error?.message ?? error}`) }
  if (store && items.includes('fts')) {
    try {
      const before = store.verifyFtsIntegrity()
      if (!before.ok) {
        store.db.exec('BEGIN IMMEDIATE')
        try {
          store.rebuildAllFtsIndexes()
          store.db.exec('COMMIT')
        } catch (error) {
          try { store.db.exec('ROLLBACK') } catch {}
          throw error
        }
        const after = store.verifyFtsIntegrity()
        if (!after.ok) throw new Error(`FTS indexes still inconsistent after the rebuild: ${(after.errors ?? []).join('; ')}`)
        store._ftsBroken = false
        store.ftsIntegrityWarning = null
        result.fixed.push('fts')
      }
    } catch (error) { result.errors.push(`fts: ${error?.message ?? error}`) }
  }
  // 6) Re-verify, audit, refresh the anchor.
  try {
    const finalStore = store ?? openStore()
    const verifyReport = finalStore.integrityReport({ quickCheck: true, fts: true })
    const auditCheck = finalStore.verifyAudit()
    const fixedNow = [...new Set(result.fixed)]
    let auditRow = null
    if (fixedNow.length) {
      auditRow = finalStore.appendAudit({
        actor: 'local',
        action: 'doctor.repair',
        allowed: result.errors.length === 0,
        reason: `only=${items.join('+')};fixed=${fixedNow.join('+')};backup=${result.backup ? basename(result.backup) : 'none'}`,
      })
    }
    let anchorWrite = null
    if (auditRow) {
      const anchorLib = await loadAuditAnchor()
      anchorWrite = anchorLib.writeAuditAnchor({ home: HOME, store: finalStore, generator: `advisers/${VERSION}` })
    }
    result.audit = auditRow
    result.anchor = anchorWrite ? { ok: anchorWrite.ok === true, code: anchorWrite.code ?? null, path: anchorWrite.path ?? null, count: anchorWrite.anchor?.count ?? null } : null
    result.verify = {
      quickCheck: verifyReport.quickCheck?.verdict ?? null,
      fts: verifyReport.fts?.state ?? null,
      audit: { ok: auditCheck.ok === true, count: auditCheck.count ?? 0 },
    }
    result.ok = result.errors.length === 0 && verifyReport.ok === true && auditCheck.ok === true && (anchorWrite === null || anchorWrite.ok === true) && result.fixed.length > 0
  } catch (error) {
    result.errors.push(`verification: ${error?.message ?? error}`)
    result.ok = false
  }
  if (asJson) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`repair: ${result.ok ? 'done' : 'INCOMPLETE'} · fixed=${[...new Set(result.fixed)].join(',') || 'none'}${result.backup ? ' · backup=' + result.backup : ''}`)
    if (result.verify) {
      console.log(`verify: quick_check=${result.verify.quickCheck ?? '?'} fts=${result.verify.fts ?? '?'} audit=${result.verify.audit.ok ? 'verified(' + result.verify.audit.count + ')' : 'BROKEN'}${result.anchor ? ' anchor=' + (result.anchor.ok ? 'written' : 'FAIL ' + result.anchor.code) : ''}`)
    }
    for (const warning of plan.warnings) console.log(`warning: ${warning}`)
    for (const error of result.errors) console.error(`error: ${error}`)
    if (result.ok) console.log('next: advisers doctor --check-db')
  }
  if (!result.ok) process.exitCode = 1
}

function init() {
  ensureHome()
  if (!existsSync(SOUL)) {
    const doc = { id: 'soul', version: 1, content: '你是我的幕僚：直接、简洁、有用。\n你是我生活里的客人：私事保持私密。\n如果你要改这个文件，先告诉我。\n', updatedAt: now(), updatedBy: 'human' }
    saveSoul(doc)
  }
  console.log(`home   ${HOME}`)
  console.log(`soul   ${existsSync(SOUL) ? SOUL : 'failed'}`)
  console.log('next   advisers doctor')
  console.log('       advisers template weekly examples/templates/weekly.json out/weekly.docx')
  console.log('       advisers commit add "周五前发报价给王工" --quote "周五前发报价给王工" --due <ISO>')
}

function printStatus(asJson = false) {
  const data = {
    version: VERSION,
    node: process.version,
    office: process.env.ADVISERS_OFFICE_LOCAL === '1' || existsSync(new URL('../../office/dist/index.js', import.meta.url)) ? 'local build linked' : 'external package',
    home: HOME,
    store: mode === 'sqlite' ? { type: 'sqlite', path: DB } : { type: mode, path: STATE },
    model: modelLabel(),
    soul: existsSync(SOUL) ? 'present' : 'not initialized',
    // Additive 0.3.0 discovery field: one call tells a consumer which contract
    // versions this CLI implements (contracts/versions-v1.json discovery.expected).
    contracts: { ...CONTRACTS_DISCOVERY },
  }
  if (mode === 'json') {
    // Legacy JSON store: the snapshot is small, keep the historical behaviour.
    const ledger = loadLedger()
    data.matters = ledger.listMatters().length
    data.prefs = ledger.listPreferences().length
    data.routines = ledger.listRoutines().length
    data.links = ledger.listLinks().length
    data.sessions = 0
    data.deliveries = 0
    // 0.3.0 additive: the JSON store carries no customer tables.
    data.clients = 0
    data.projects = 0
  } else {
    // P1-2 (0.2.2): COUNT-only status. The old path loaded all 9 tables just to
    // count four of them (664ms / 352MB RSS at 50k rows in the round-2 audit).
    // listMatters()/listPreferences()/listRoutines()/listLinks() filter status,
    // so the counts replicate those filters exactly.
    // 0.2.3: read through the lock-free store; one read transaction keeps the
    // seven aggregates on the same committed snapshot (§4.5).
    const store = readStoreOrExit()
    const counts = store.read(() => ({
      matters: store.countMatters({ status: 'active' }),
      prefs: store.countPreferences({ status: 'confirmed' }),
      routines: store.countRoutines(),
      links: store.countLinks({ excludeRejected: true }),
      sessions: store.countSessions(),
      deliveries: store.countDeliveries(),
      // 0.3.0 additive: live customer/project counts. Additive keys only, so the
      // frozen status v1 shape keeps its meaning (contracts/cli/status-v1.json).
      // The store's customer CRUD has no count helper; these are COUNT-only
      // queries on the same read snapshot (no row materialisation).
      clients: Number(store.db.prepare("SELECT COUNT(*) AS n FROM clients WHERE status = 'active' AND deleted_at IS NULL").get()?.n ?? 0),
      projects: Number(store.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE status = 'active' AND deleted_at IS NULL").get()?.n ?? 0),
      // 0.4.0 additive status counts: money rows (never amounts).
      receivables: Number(store.db.prepare('SELECT COUNT(*) AS n FROM receivables WHERE deleted_at IS NULL').get()?.n ?? 0),
      payments: Number(store.db.prepare('SELECT COUNT(*) AS n FROM payments WHERE deleted_at IS NULL').get()?.n ?? 0),
      usage: store.sumModelUsage(),
    }))
    data.matters = counts.matters
    data.prefs = counts.prefs
    data.routines = counts.routines
    data.links = counts.links
    data.sessions = counts.sessions
    data.deliveries = counts.deliveries
    data.clients = counts.clients
    data.projects = counts.projects
    data.receivables = counts.receivables
    data.payments = counts.payments
    const usage = counts.usage
    if (usage.calls) data.modelUsage = usage
  }
  if (asJson) { console.log(JSON.stringify(data, null, 2)); return }
  console.log(`version   ${data.version}`)
  console.log(`node      ${data.node}`)
  console.log(`office    ${data.office}`)
  console.log(`home      ${data.home}`)
  console.log(`store     ${data.store.type}${data.store.path ? ` (${data.store.path})` : ''}`)
  console.log(`model     ${data.model}`)
  console.log(`matters   ${data.matters}`)
  console.log(`prefs     ${data.prefs}`)
  console.log(`routines  ${data.routines}`)
  console.log(`links     ${data.links}`)
  if (data.sessions != null) console.log(`sessions  ${data.sessions}`)
  if (data.deliveries != null) console.log(`deliveries ${data.deliveries}`)
  if (data.clients != null) console.log(`clients   ${data.clients}`)
  if (data.projects != null) console.log(`projects  ${data.projects}`)
  if (data.modelUsage) console.log(`model calls ${data.modelUsage.calls} · tokens ${data.modelUsage.total_tokens} · reasoning ${data.modelUsage.reasoning_tokens}`)
  console.log(`soul      ${data.soul}`)
}

async function loadHistory(conversationId) {
  try {
    const store = dbStore()
    if (!store) return { turns: [], summary: '' }
    const { buildHistory } = await loadContextWindow()
    const turns = store.listTurns(conversationId, 100)
    const summary = store.getSessionSummary(conversationId)
    return buildHistory({ turns, summary: summary?.summary, throughSeq: summary?.throughSeq ?? 0 })
  } catch {
    return { turns: [], summary: '' }
  }
}

function recordTurn(conversationId, role, content) {
  if (!content) return
  try { dbStore()?.addTurn({ conversationId, role, content }) } catch {}
}

async function maybeSummarize(conversationId, { apiKey, baseUrl, model, ledger } = {}) {
  try {
    const store = dbStore()
    if (!store) return
    const { shouldSummarize, buildPins, summarizeTurns, ensurePins, continuityProbes } = await loadContextWindow()
    const turns = store.listTurns(conversationId, 500)
    const old = store.getSessionSummary(conversationId)
    if (!shouldSummarize(turns, old?.throughSeq ?? 0, 10, 20)) return
    const latest = turns.at(-1).seq
    const cutoff = Math.max(0, latest - 20)
    const fresh = turns.filter((t) => t.seq > (old?.throughSeq ?? 0) && t.seq <= cutoff)
    if (!fresh.length) return
    const pins = buildPins({ preferences: ledger?.listPreferences({ includeCandidates: false }) ?? [], commitments: ledger?.openCommitments() ?? [] })
    let summary = summarizeTurns(fresh, old?.summary ?? '')
    if (apiKey && process.env.ADVISERS_LLM_SUMMARY !== '0') {
      try {
        const transcript = fresh.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.content}`).join('\n')
        const { chatCompletion } = await loadModel()
        const response = await chatCompletion({
          apiKey,
          baseUrl: baseUrl || 'https://api.deepseek.com',
          model: model || 'deepseek-flash',
          task: 'summarize',
          thinking: false,
          messages: [
            { role: 'system', content: '把会话压缩成给秘书续接用的摘要。必须保留：已完成什么、未决问题、承诺及截止时间、用户偏好/禁忌、下一步。不要寒暄，不超过 500 字。' },
            { role: 'user', content: `${old?.summary ? `旧摘要：\n${old.summary}\n\n` : ''}${transcript}` },
          ],
        })
        if (response.content?.trim()) summary = response.content.trim()
      } catch {}
    }
    summary = ensurePins(summary, pins)
    if (pins && !continuityProbes({ summary, pins, turns: fresh }).ok) return
    store.upsertSessionSummary({ conversationId, summary, throughSeq: cutoff, pins })
  } catch {}
}

async function printOpening(conversationId) {
  try {
    const store = dbStore()
    if (!store) return
    const { buildOpening } = await loadContextWindow()
    const turns = store.listTurns(conversationId, 20)
    const summary = store.getSessionSummary(conversationId)
    const commitments = loadLedger().openCommitments()
    console.log(buildOpening({ summary: summary?.summary, turns, commitments }))
  } catch {}
}

async function applyNudgeFeedback(text) {
  const { classifyNudgeOutcome } = await loadNudge()
  const outcome = classifyNudgeOutcome(text)
  if (!outcome) return
  try {
    const store = dbStore()
    const pending = store?.listNudges(20).filter((n) => n.outcome === 'pending') ?? []
    if (!pending.length) return
    for (const n of pending.slice(0, 3)) store.setNudgeOutcome(n.id, outcome)
    console.log(`[nudge] 记下：${outcome === 'accepted' ? '已处理' : '先不提醒'}`)
  } catch {}
}

let safetyModule
let lastTurnSafetyBlock = null

/** Build the structured audit reason for a safety decision (never the original text). */
function safetyReasonFor(result, fallbackSurface = 'model.output') {
  try {
    return safetyModule.buildAuditReason({
      rulesetVersion: result?.rulesetVersion,
      surface: result?.surface ?? fallbackSurface,
      action: result?.action ?? 'block',
      code: result?.code ?? 'CONTENT_SAFETY_BLOCKED',
      ruleIds: result?.ruleIds,
      evidenceHash: result?.evidenceHash,
    })
  } catch {
    return `code=${result?.code ?? 'CONTENT_SAFETY_BLOCKED'}`
  }
}

/**
 * Print runAgent safety warnings to stderr (0.2.3 Wave 1: bin must consume
 * result.safetyWarnings; design §3.10 / security audit SEC3-03) and record one
 * actor=safety audit row per warning. External text is never printed/persisted.
 */
async function reportAgentSafetyWarnings(warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return
  const { sanitizeLabel } = await loadUntrusted()
  for (const warning of warnings) {
    const ruleIds = Array.isArray(warning?.ruleIds) ? warning.ruleIds.join(',') : ''
    const source = sanitizeLabel(warning?.source ?? 'unknown')
    const direction = String(warning?.direction ?? '-')
    const action = String(warning?.action ?? 'warn')
    const code = String(warning?.code ?? 'SAFETY_WARNING')
    const redacted = Number(warning?.redactedCount) > 0 ? ` redacted=${warning.redactedCount}` : ''
    console.error(`[safety] ${direction}/${action} ${code}${ruleIds ? ` rules=${ruleIds}` : ''} source=${source}${redacted}`)
    try {
      dbStore()?.appendAudit({
        actor: 'safety',
        action: 'safety.warning',
        allowed: action !== 'block',
        reason: auditSafeReason(`direction=${direction};action=${action};code=${code};severity=${warning?.severity ?? '-'};rules=${ruleIds || '-'};source=${source}`),
      })
    } catch {}
  }
  console.error(`[safety] ${warnings.length} 条安全提醒：外部内容按数据处理，未作为指令执行。`)
}

/** Audit reason for a blocked agent turn (code/rules/source only, no content). */
function agentBlockAuditReason(blockReason) {
  const code = safeAuditToken(blockReason?.code, 'UNTRUSTED_INJECTION')
  const rules = Array.isArray(blockReason?.ruleIds) && blockReason.ruleIds.length ? blockReason.ruleIds.join(',') : '-'
  return `code=${code};rules=${rules};source=${safeAuditToken(blockReason?.source, '-')}`
}

/** Explain a blocked agent turn: it is never rendered as a successful reply. */
async function reportAgentBlock(blockReason) {
  const ruleIds = Array.isArray(blockReason?.ruleIds) && blockReason.ruleIds.length
    ? blockReason.ruleIds.join(',')
    : (blockReason?.code ?? 'UNTRUSTED_INJECTION')
  console.error(`[safety] 已阻止：外部内容包含高风险提示注入（${ruleIds}），该内容没有发送给模型。`)
  console.error('[safety] 这不是成功交付：没有写入回复、没有生成文件或回执。请先核实来源；如确需把该内容当数据分析，可显式设置 ADVISERS_INJECTION_POLICY=warn 后重试。')
}
/**
 * Report a local content-safety block without echoing or persisting the original
 * text (privacy audit P2 / security audit SEC2-04): user-facing rejection plus a
 * keyed `actor: 'safety'` audit row so the block is explainable later.
 */
function recordSafetyBlock(result, { action = 'safety.chat', surface = 'model.output' } = {}) {
  const code = result?.code || 'CONTENT_SAFETY_BLOCKED'
  const ruleIds = Array.isArray(result?.ruleIds) ? result.ruleIds : []
  console.error('advisers: 内容安全审核未通过（CONTENT_SAFETY_BLOCKED）')
  console.error('本次输入未发送到模型，也未写入账本或会话；被拒内容不会保存为标题或会话。')
  console.error(`本地自检（${surface}）：code=${code} rules=${ruleIds.join(',') || '-'}；这是本地规则层判定，不是人工审核。`)
  if (result?.crisis) console.error('如果你或他人正处于危险中，请立即联系当地紧急服务或可信任的人。')
  try {
    ensureHome()
    dbStore()?.appendAudit({ actor: 'safety', action, allowed: false, reason: safetyReasonFor(result, surface) })
  } catch {}
}

/**
 * Wrapper around runTurnInner: local content-safety pre-flight BEFORE
 * runtime.ingest()/upsertSession() (SEC2-04). A blocked input must not create a
 * matter, a session title or a ledger fact, and must not purge the active matter
 * pointer later (the old order persisted the raw text as sessions.title).
 */
async function runTurn(options) {
  lastTurnSafetyBlock = null
  ensureHome()
  safetyModule ??= await loadSafety()
  const text = String(options?.text ?? '')
  const decision = safetyModule.classify(text, { surface: 'model.output', hmacKey: process.env.ADVISERS_AUDIT_KEY })
  if (decision.action === 'block') {
    lastTurnSafetyBlock = decision
    recordSafetyBlock(decision, { surface: 'chat.input' })
    return undefined
  }
  try {
    return await runTurnInner(options)
  } catch (error) {
    // Context/history/attachments can still trip the model choke point; audit
    // it as safety rather than letting it look like an unexplained crash.
    if (error?.name === 'ContentSafetyError') {
      lastTurnSafetyBlock = error
      recordSafetyBlock(error, { surface: error.surface || 'model.output' })
      return undefined
    }
    throw error
  }
}

async function runTurnInner({ runtime, ledger, text, conversationId, debug = false, confirm, attachments = [], allowPaths = [], renderWidth = null, signal = null }) {
  // 0.3.0 Wave 3 (plan 26 §4.1): internal process lines ([tool]/[attach]/[compact])
  // are hidden by default; ADVISERS_PROGRESS=1 (or /debug) is the explicit
  // opt-in. Results, confirmations and failures are never gated.
  const showProgress = debug || process.env.ADVISERS_PROGRESS === '1'
  const result = await runtime.ingest({
    linkId: 'cli',
    accountId: 'local',
    conversationId,
    messageId: `cli_${Date.now()}_${++cliSeq}`,
    sender: { id: 'local' },
    text,
    trusted: true,
    timestamp: now(),
  })
  if (!result.accepted) {
    console.log(`[ignored: ${result.reason}]`)
    return
  }
  await applyNudgeFeedback(text)
  const context = runtime.lastContext
  if (!context) throw new Error('runtime did not produce a context')
  const egressDenied = egressDeniedReason(context.matter, 'chat')
  if (egressDenied) {
    console.log(`[blocked] ${egressDenied}`)
    dbStore()?.appendAudit({ actor: 'local', action: 'policy.egress_deny', allowed: false, reason: 'chat' })
    return
  }
  if (context.crisis && (context.crisis.tier === 'T1' || context.crisis.tier === 'T2' || (context.crisis.tier === 'T3' && context.crisis.thirdParty))) {
    console.log(context.crisis.script)
    dbStore()?.appendAudit({ actor: 'local', action: 'policy.crisis', allowed: false, reason: context.crisis.tier })
    return
  }
  if (context.policy && !context.policy.allowed) {
    console.log(`[policy] ${context.policy.reason}`)
    dbStore()?.appendAudit({ actor: 'local', action: 'policy.deny', allowed: false, reason: context.policy.code ?? 'DENY' })
    return
  }
  const intent = context.intent
  // 0.2.3 Wave 1 (security audit SEC3-02 / design §3.10): attachment text is
  // external data, never part of the typed user message. It is handed to
  // runAgent as untrusted[] so lib/agent.js classifies and wraps it in the
  // <untrusted-data> boundary; the old "<file>" concatenation is no longer
  // emitted by bin (lib keeps a compatibility parser only).
  const untrusted = []
  const extracted = []
  const attachmentLib = attachments.length ? await loadAttachments() : null
  for (const file of attachments) {
    try {
      const attachment = await attachmentLib.extractAttachment(file, { cwd: process.cwd() })
      extracted.push(attachment)
      if (attachment?.text) untrusted.push({ label: 'attachment:' + attachment.name, text: attachment.text })
      if (showProgress) console.log(`[attach] ${sanitizeConsoleText(attachment.name, { max: 200 })}`)
    } catch (error) {
      // An unreadable attachment is a failure, not process noise: keep it
      // visible even when internal progress is hidden; sanitise path/message.
      console.error(sanitizeConsoleText('附件无法读取：' + file + '：' + (error?.message ?? error), { max: 2000 }))
    }
  }
  const agentText = text
  try {
    dbStore()?.upsertSession({ conversationId, matterId: context.matter.id, title: text.slice(0, 80) })
  } catch {}
  if (debug) {
    console.log('[context]')
    console.log(context.prompt)
    console.log('[/context]')
  }
  const noisy = debug || process.env.ADVISERS_VERBOSE === '1'
  if (intent && (noisy || intent.action === 'ask')) {
    console.log(intent.readback)
    if (intent.questions?.length) console.log(`问：${intent.questions[0]}`)
  }
  if (intent?.action === 'ask' && intent.questions?.length) return intent.questions[0]
  const apiKey = process.env.ADVISERS_API_KEY
  if (!apiKey || process.env.ADVISERS_NO_MODEL === '1') {
    const local = intent?.questions?.[0] ?? ''
    recordTurn(conversationId, 'user', text)
    if (local) recordTurn(conversationId, 'assistant', local)
    await maybeSummarize(conversationId, { apiKey, baseUrl: process.env.ADVISERS_BASE_URL, model: process.env.ADVISERS_MODEL, ledger })
    if (!intent?.questions?.length) console.log('[local] 未配置模型；已记录到当前会话，但没有创建承诺或文件。设置 ADVISERS_API_KEY 后可用自然语言执行；也可用 `advisers office` / `advisers template` 直接生成文件。')
    return intent?.questions?.[0]
  }
  const { buildPins, fitHistory } = await loadContextWindow()
  const history = await loadHistory(conversationId)
  const pins = buildPins({
    preferences: ledger.listPreferences({ matterId: context.matter.id }),
    commitments: ledger.openCommitments(context.matter.id),
  })
  const prompt = pins ? `${context.prompt}\n<session-pins>\n${pins}\n</session-pins>` : context.prompt
  const fitted = fitHistory({ system: prompt, summary: history.summary, history: history.turns, current: agentText, maxTokens: Number(process.env.ADVISERS_CONTEXT_TOKENS || 12000) })
  if (fitted.trimmed && showProgress) console.log(`[compact] 裁剪 ${fitted.trimmed} 轮旧历史`)
  const { runAgent } = await loadAgent()
  // 0.2.3 Wave 1 default workspace: agent file tools are confined to a 0700
  // directory under ADVISERS_HOME, not to whatever directory the CLI was
  // started from. --allow-path / ADVISERS_ALLOW_PATHS are the explicit escape.
  const workspaceRoot = ensureAgentWorkspace()
  const effectiveAllowPaths = resolveAllowPaths(allowPaths)
  if (effectiveAllowPaths.length) console.error(`[workspace] explicit allow-path: ${effectiveAllowPaths.join(', ')}`)
  const turnId = `cli_${Date.now()}_${cliSeq}`
  const agentResult = await runAgent({
    runtime,
    text: agentText,
    context: { ...context, prompt },
    history: fitted.history,
    summary: history.summary,
    ledger,
    matterId: context.matter.id,
    turnId,
    backupDir: join(HOME, 'undo'),
    store: dbStore(),
    apiKey,
    baseUrl: process.env.ADVISERS_BASE_URL || 'https://api.deepseek.com',
    model: process.env.ADVISERS_MODEL || 'deepseek-flash',
    cwd: workspaceRoot,
    workspaceRoot,
    allowPaths: effectiveAllowPaths,
    untrusted,
    safetyKey: process.env.ADVISERS_AUDIT_KEY,
    force: process.env.ADVISERS_FORCE === '1',
    confirm,
    effort: process.env.ADVISERS_THINKING_EFFORT,
    onTool: (name) => { if (showProgress) console.log('[tool] ' + sanitizeConsoleText(name, { max: 120 })) },
    onToolAction: auditToolAction,
    // 0.4.0: the interactive shell passes an AbortSignal so Ctrl+C/Esc can
    // interrupt one turn; one-shot chat passes null and keeps the exact old
    // options object shape (no behavioural change).
    ...(signal ? { signal } : {}),
  })
  // 0.2.3 Wave 1: consume the structured warnings (they used to be discarded)
  // and treat a blocked turn as a failure, never as a successful reply.
  const { reply, artifacts, toolLog } = agentResult
  const safetyWarnings = Array.isArray(agentResult.safetyWarnings) ? agentResult.safetyWarnings : []
  if (safetyWarnings.length) await reportAgentSafetyWarnings(safetyWarnings)
  if (agentResult.blocked) {
    lastTurnSafetyBlock = agentResult.blockReason ?? { code: 'UNTRUSTED_INJECTION', ruleIds: [], source: null }
    await reportAgentBlock(agentResult.blockReason)
    recordTurn(conversationId, 'user', text)
    try { dbStore()?.appendAudit({ actor: 'safety', action: 'policy.agent.block', allowed: false, reason: agentBlockAuditReason(agentResult.blockReason) }) } catch {}
    return
  }
  lastRun = { artifacts: [...new Set(artifacts)], toolLog }
  recordTurn(conversationId, 'user', text)
  recordTurn(conversationId, 'assistant', reply || '')
  await maybeSummarize(conversationId, { apiKey, baseUrl: process.env.ADVISERS_BASE_URL, model: process.env.ADVISERS_MODEL, ledger })
  if (reply) {
    // 0.3.0 Wave 3: the REPL renders model output through the display kernel -
    // strip terminal control/bidi from the model, then fold at the display width
    // (CJK counts as two columns) so a long Chinese paragraph cannot mangle the
    // terminal. chat/one-shot keeps its historical bytes (renderWidth is null).
    if (Number.isInteger(renderWidth) && renderWidth > 0) {
      const tuiKernel = await loadTui()
      const display = tuiKernel.sanitizeDisplay(reply, { expandTabs: true })
      for (const line of tuiKernel.wrap(display, renderWidth)) console.log(line)
    } else console.log(reply)
  }
  const uniqueArtifacts = [...new Set(artifacts)]
  if (uniqueArtifacts.length) {
    for (const file of uniqueArtifacts) {
      let bytes = 0
      try { bytes = statSync(file).size } catch {}
      console.log(`[完成] ${sanitizeConsoleText(text.replace(/\s+/g, ' ').slice(0, 48), { max: 48 })} -> ${sanitizeConsoleText(file, { max: 240 })}（${bytes} B）`)
    }
    const structural = toolLog.filter((t) => t.name === 'office_build' || t.name === 'office_template')
    if (structural.length && structural.every((t) => t.ok && !(t.payload?.missing?.length))) console.log('校验：结构通过（内容未逐字核对）')
    else if (structural.length) console.log('校验：未通过，文件保留但未记成完成')
    else console.log('校验：文本已保存')
    console.log('下一步：打开确认；要改哪段直接说')
    for (const file of uniqueArtifacts) console.log('[file] ' + sanitizeConsoleText(file, { max: 240 }))
  }
  if (artifacts.length) {
    try {
      dbStore()?.addDelivery({
        matterId: context.matter.id,
        conversationId,
        files: artifacts,
        tool: toolLog.map((t) => t.name).join(','),
        title: text.slice(0, 80),
        validation: toolLog.every((t) => t.ok !== false) ? 'ok' : 'failed',
      })
      dbStore()?.appendAudit({ actor: 'local', action: 'delivery', allowed: true, reason: artifacts.join(',') })
    } catch {}
  }
  let runId
  try {
    runId = dbStore()?.addTaskRun({
      conversationId,
      matterId: context.matter.id,
      task: text.slice(0, 500),
      tools: toolLog.map((t) => ({ name: t.name, ok: t.ok })),
      artifacts,
      outcome: toolLog.some((t) => !t.ok) ? 'partial' : 'ok',
    })
  } catch {}
  if (runId && process.env.ADVISERS_LEARNING === 'auto' && apiKey) {
    try {
      const run = dbStore()?.listTaskRuns(50).find((r) => r.id === runId)
      const { reviewRun, lintReview, materializeReview } = await loadReview()
      const review = await reviewRun({ run, routines: ledger.listRoutines(), apiKey, baseUrl: process.env.ADVISERS_BASE_URL, model: process.env.ADVISERS_MODEL })
      const checked = lintReview(review, { run, routines: ledger.listRoutines() })
      if (checked.ok && checked.review.verdict !== 'NONE') {
        const made = materializeReview(checked.review, { run, ledger })
        saveLedger(ledger)
        console.log(`[learn] ${made.verdict}${made.routine ? ` draft ${made.routine.id}` : made.patch ? ` patch ${made.patch.id}` : ''}`)
      }
    } catch {}
  }
  const { buildRoutineCandidate } = await loadLearning()
  const candidate = buildRoutineCandidate({ text, toolLog, artifacts })
  if (candidate && !ledger.listRoutines().some((r) => r.name === candidate.name)) {
    try {
      const routine = ledger.addRoutine(candidate)
      console.log(`[routine] draft ${routine.id} (${routine.steps.length} steps); approve with \`advisers routine approve ${routine.id}\``)
      saveLedger(ledger)
    } catch {}
  }
  if (/我会|我来|稍后|明天|提醒你/.test(reply || '') && !toolLog.some((t) => t.name === 'commitment_add')) console.log('[warn] 空承诺：回复里答应跟进，但账本没有承诺。请用 /commit add 或让我重做。')
  const failed = toolLog.filter((t) => !t.ok)
  if (failed.length) console.log(`[没做成] ${failed.length} 个步骤失败；已完成 ${uniqueArtifacts.length} 个文件，原文件未丢。下一步：/retry 或告诉我换一种做法。`)
}

function parseChatArgs(args) {
  const files = []
  const allowPaths = []
  const words = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' || args[i] === '-f') {
      if (args[i + 1]) files.push(args[++i])
    } else if (args[i] === '--allow-path') {
      // Repeatable explicit workspace escape; ADVISERS_ALLOW_PATHS is the env
      // equivalent. Sensitive paths stay denied by the lib policy.
      if (args[i + 1]) allowPaths.push(args[++i])
    } else {
      words.push(args[i])
    }
  }
  return { text: words.join(' ').trim(), files, allowPaths }
}

async function chat(args) {
  const { text, files, allowPaths } = parseChatArgs(args)
  if (!text) {
    if (process.stdin.isTTY) { await repl({ allowPaths }); return }
    console.error('usage: advisers chat [--file <path>] [--allow-path <dir>]... <text>')
    process.exitCode = 1
    return
  }
  const ledger = loadLedger()
  const runtime = runtimeFor(ledger)
  await runTurn({ runtime, ledger, text, conversationId: latestConversationId(), attachments: files, allowPaths })
  if (lastTurnSafetyBlock) process.exitCode = 1
  saveLedger(ledger)
}

async function repl({ allowPaths = [] } = {}) {
  const tuiKernel = await loadTui()
  const policy = await getOutputPolicy()
  const width = tuiKernel.clampColumns(process.stdout.columns)
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 100 })
  const ledger = loadLedger()
  const runtime = runtimeFor(ledger)
  let conversationId = latestConversationId()
  let debug = process.env.ADVISERS_DEBUG === '1'
  let pendingFiles = []
  let lastTask
  // 0.3.0 Wave 3 (plan 26 §4.4/§6.1): one status line from the render kernel
  // replaces the "advisers · local" banner. Counts come from the already-loaded
  // ledger, so the status line costs no extra store read.
  const nowMs = Date.now()
  const today = localDayOf(nowMs)
  let dueToday = 0
  let overdueCount = 0
  for (const commitment of ledger.openCommitments()) {
    if (!commitment.dueAt) continue
    const ms = Date.parse(commitment.dueAt)
    if (Number.isNaN(ms)) continue
    const day = localDayOf(ms)
    if (ms < nowMs && day !== today) overdueCount += 1
    else if (day === today) dueToday += 1
  }
  const localMode = !process.env.ADVISERS_API_KEY || process.env.ADVISERS_NO_MODEL === '1'
  console.log(tuiKernel.renderStatus({
    kind: 'idle',
    today: { due: dueToday, overdue: overdueCount },
    local: localMode,
    model: localMode ? null : (process.env.ADVISERS_MODEL || 'deepseek-flash'),
    hint: '/help',
  }, { width, color: policy.color, accessible: policy.accessible }))
  if (debug) {
    console.log('model: ' + sanitizeConsoleText(modelLabel(), { max: 240 }))
    console.log('home:  ' + sanitizeConsoleText(HOME, { max: 240 }))
  }
  try {
    const latest = dbStore()?.listSessions(1)[0]
    await printOpening(latest?.conversationId ?? conversationId)
  } catch {}

  const runTask = async (taskText, files = [], { skipPlan = false } = {}) => {
    const brief = runtime.brief(taskText)
    if (!skipPlan && shouldPlan(taskText, brief)) {
      console.log('计划：')
      for (const step of planLines(brief)) console.log(`  ${step}`)
      if (!(await askYesNo(rl, '按这个计划执行？[Y/n] ', true))) { console.log('已取消'); return }
    }
    const confirm = async ({ path }) => {
      console.log(`${path} 已存在`)
      return askYesNo(rl, '覆盖？[y/N] ', false)
    }
    lastTask = { text: taskText, files: [...files] }
    try {
      const question = await runTurn({ runtime, ledger, text: taskText, conversationId, debug, confirm, attachments: files, allowPaths, renderWidth: width })
      saveLedger(ledger)
      pendingFiles = []
      if (question) {
        let answer
        try { answer = await rl.question('? ') } catch { return }
        if (answer.trim().startsWith('/')) {
          console.log('已取消补充，请重新输入命令')
          return
        }
        if (answer.trim()) {
          await runTurn({ runtime, ledger, text: `${taskText}\n补充：${answer.trim()}`, conversationId, debug, confirm, attachments: files, allowPaths, renderWidth: width })
          saveLedger(ledger)
        }
      }
    } catch (error) {
      // 0.3.0 Wave 3: the failure block goes through the render kernel so it has
      // the stable prefix/code shape, is sanitised and wraps at the display width.
      const lines = tuiKernel.renderError({
        title: '任务失败',
        reason: friendlyError(error),
        kept: '任务和会话；没有丢文件',
        next: '/retry 重试',
        code: typeof error?.code === 'string' ? error.code : undefined,
      }, { width, color: policy.color, accessible: policy.accessible })
      for (const line of lines) console.error(line)
    }
  }

  for (;;) {
    let line
    try { line = await rl.question('› ') } catch { break }
    const text = line.trim()
    if (!text) continue
    if (text === '/quit' || text === '/exit') break
    if (text === '/help') {
      console.log('  /help           this help')
      console.log('  /status         home/store/model/counts')
      console.log('  /history        recent conversations')
      console.log('  /resume <n|id>  resume a conversation')
      console.log('  /deliveries     recent generated files')
      console.log('  /new            start a new conversation')
      console.log('  /file <path>    attach a file to the next task')
      console.log('  /files          list pending attachments')
      console.log('  /clear          clear pending attachments')
      console.log('  /retry          rerun the last task')
      console.log('  /correct <text>  record a correction; 2nd time promotes it')
      console.log('  /who            who I owe / who owes me')
      console.log('  /matter use <id>  set the default matter for later writes')
      console.log('  /agenda         7-day agenda (commitments + calendar)')
      console.log('  /memory         what I remember')
      console.log('  /commit add <action> --quote <text> [--due ISO]')
      console.log('  /commit ls')
      console.log('  /done <id> --evidence <text>')
      console.log('  /search <text>  full-text search old turns')
      console.log('  /tick           due in the next 7 days')
      console.log('  /week           last 7 days')
      console.log('  /digest [day]   today/week digest')
      console.log('  /diff           show the last changed file')
      console.log('  /undo           restore the last overwritten/created file')
      console.log('  /links          list candidate/confirmed links')
      console.log('  /forget <id>    forget a preference')
      console.log('  /prefs          list preferences (incl. candidates)')
      console.log('  /audit          verify and show the audit hash chain')
      console.log('  /decay          apply 30-day preference decay')
      console.log('  /why <pref-id>  explain a preference')
      console.log('  /routine save   save the last task as a draft routine')
      console.log('  /brief <text>   print the IntentBrief without calling the model')
      console.log('  /debug          toggle full context')
      console.log('  /quit           leave')
      continue
    }
    if (text === '/status') { printStatus(); continue }
    if (text === '/who') {
      const open = ledger.openCommitments()
      const mine = open.filter((c) => c.debtor === 'user' || c.debtor === 'agent')
      const waiting = open.filter((c) => c.debtor === 'third' || c.debtor.startsWith('third:'))
      console.log(`我欠别人（${mine.length}）`)
      for (const c of mine) console.log(`  ${c.id}  ${c.creditor} · ${c.action}${c.dueAt ? ` · ${c.dueAt.slice(0, 10)}` : ''}`)
      console.log(`等别人/别人欠我（${waiting.length}）`)
      for (const c of waiting) console.log(`  ${c.id}  ${c.debtor} · ${c.action}${c.dueAt ? ` · ${c.dueAt.slice(0, 10)}` : ''}`)
      continue
    }
    if (text === '/history') { printHistory(); continue }
    if (text === '/deliveries') { printDeliveries(); continue }
    if (text === '/new') { conversationId = `local_${Date.now()}`; pendingFiles = []; console.log('new conversation'); continue }
    if (text === '/debug') { debug = !debug; console.log(`debug ${debug ? 'on' : 'off'}`); continue }
    if (text === '/files') { console.log(pendingFiles.length ? pendingFiles.join('\n') : 'no pending attachments'); continue }
    if (text === '/clear') { pendingFiles = []; console.log('attachments cleared'); continue }
    if (text.startsWith('/correct ')) {
      const statement = text.slice(9).trim()
      if (!statement) { console.log('usage: /correct <statement>'); continue }
      const result = learnPreference(ledger, statement, statement)
      saveLedger(ledger)
      printLearnReceipt(result)
      continue
    }
    if (text === '/decay') {
      const { applyPreferenceDecay } = await loadLearning()
      const changed = applyPreferenceDecay(ledger.listPreferences({ includeCandidates: true }))
      saveLedger(ledger)
      console.log(`[decay] ${changed.length} preference(s) updated`)
      continue
    }
    if (text === '/prefs') { printPreferences(); continue }
    if (text === '/links') { printLinks(); continue }
    if (text === '/memory') { printMemory(ledger); continue }
    if (text === '/tick') { tick(ledger); continue }
    if (text.startsWith('/search ')) {
      const q = text.slice(8).trim()
      const rows = dbStore()?.searchTurns(q, { limit: 10 }) ?? []
      if (!rows.length) console.log('没有匹配')
      for (const r of rows) console.log(`${r.seq}\t${r.role}\t${r.content.replace(/\s+/g, ' ').slice(0, 160)}`)
      continue
    }
    if (text === '/week') { printWeek(ledger); continue }
    if (text === '/agenda') {
      try {
        const inputs = loadAgendaInputs()
        const data = await buildAgendaData({ ledger: inputs.ledger, events: inputs.events, nowMs: Date.now(), days: 7, includeCalendar: true, includeDone: false })
        printAgenda(data)
      } catch (error) { console.log('agenda failed: ' + (error && error.message ? error.message : error)) }
      continue
    }
    if (text.startsWith('/matter use ')) {
      const requested = text.slice('/matter use '.length).trim()
      const matter = requested ? ledger.getMatter(requested) : undefined
      if (!matter) console.log('用法：/matter use <matter-id>（先用 advisers matter ls 查看）')
      else if (matter.status !== 'active') console.log('matter 已归档：' + requested)
      else { ledger.setRoute('active-matter', requested); saveLedger(ledger); console.log('active matter: ' + requested + '  ' + matter.title) }
      continue
    }
    if (text === '/digest' || text === '/digest day' || text === '/digest week') {
      const store = dbStore()
      const { buildDigest } = await loadDigest()
      console.log(buildDigest({
        period: text.endsWith('week') ? 'week' : 'day',
        turns: store?.listTurns(conversationId, 200) ?? [],
        commitments: ledger.listCommitments(),
        deliveries: store?.listDeliveries(100) ?? [],
      }))
      continue
    }
    if (text === '/diff') {
      const { diffLatest } = await loadUndo()
      const result = await diffLatest({ cwd: process.cwd(), backupDir: join(HOME, 'undo') })
      console.log(result.ok ? result.diff : `diff failed: ${result.error}`)
      continue
    }
    if (text === '/undo') {
      const { undoLatest } = await loadUndo()
      const result = await undoLatest({ cwd: process.cwd(), backupDir: join(HOME, 'undo'), force: args.includes('--force') })
      console.log(result.ok ? `已回滚：${result.path}` : `撤销失败：${result.error}`)
      continue
    }
    if (text.startsWith('/commit ')) {
      const { flags, positional } = parseFlags(text.slice(8).trim().split(/\s+/))
      if (positional[0] === 'ls') { printCommitments(ledger); continue }
      if (positional[0] === 'add') {
        const action = positional.slice(1).join(' ')
        if (!action || !flags.quote) { console.log('用法：/commit add <action> --quote <原话> [--due ISO]'); continue }
        try {
          const c = ledger.addCommitment({ matterId: resolveMatterForCommand(ledger, flags.matter, 'commit add'), debtor: flags.debtor ?? 'user', creditor: flags.creditor ?? 'me', action, dueAt: flags.due, capability: 'todo', evidence: [manualEvidence(String(flags.quote), 'repl commit add')] })
          saveLedger(ledger)
          console.log(`${c.id} open ${c.action}`)
        } catch (error) { console.log(error && error.message ? error.message : String(error)) }
        continue
      }
      console.log('用法：/commit add ... 或 /commit ls'); continue
    }
    if (text.startsWith('/done ')) {
      const { flags, positional } = parseFlags(text.slice(6).trim().split(/\s+/))
      const id = positional[0]
      if (!id || !flags.evidence) { console.log('用法：/done <id> --evidence <证据>'); continue }
      ledger.completeCommitment(id, [manualEvidence(String(flags.evidence), 'repl commit done')])
      saveLedger(ledger)
      console.log(`done: ${id}`)
      continue
    }
    if (text.startsWith('/forget ')) {
      const id = text.slice(8).trim()
      const ok = ledger.forget('preference', id)
      saveLedger(ledger)
      console.log(ok ? `forgotten: ${id}` : `unknown preference: ${id}`)
      continue
    }
    if (text === '/audit') { printAudit(); continue }
    if (text.startsWith('/why ')) { why(text.slice(5).trim()); continue }
    if (text === '/routine save') {
      if (!lastTask) { console.log('nothing to save'); continue }
      const tools = lastRun?.toolLog?.map((t) => t.name) ?? []
      const routine = ledger.addRoutine({
        name: lastTask.text.slice(0, 60),
        description: '从本地任务沉淀的流程草稿',
        trigger: [],
        steps: tools.length ? tools : ['执行任务'],
        preferences: [],
        pitfalls: [],
        verification: ['产物已生成并记录 delivery'],
        createdBy: 'agent',
      })
      saveLedger(ledger)
      console.log(`draft routine ${routine.id}: ${routine.name}`)
      console.log(`approve with \`advisers routine approve ${routine.id}\``)
      continue
    }
    if (text === '/retry') {
      if (!lastTask) { console.log('nothing to retry'); continue }
      await runTask(lastTask.text, lastTask.files, { skipPlan: true })
      continue
    }
    if (text.startsWith('/file ')) {
      const path = text.slice(6).trim()
      if (!path) { console.log('usage: /file <path>'); continue }
      pendingFiles.push(path)
      console.log(`attached: ${path} (${pendingFiles.length} pending)`)
      continue
    }
    if (text.startsWith('/resume ')) {
      const arg = text.slice(8).trim()
      try {
        const rows = dbStore()?.listSessions(50) ?? []
        const pick = /^\d+$/.test(arg) ? rows[Number(arg) - 1] : rows.find((r) => r.conversationId === arg)
        if (!pick) { console.log(`unknown session: ${arg}`); continue }
        conversationId = pick.conversationId
        pendingFiles = []
        console.log(`resumed: ${pick.title} [${pick.conversationId}]`)
      } catch { console.log('history is not available') }
      await printOpening(conversationId)
      continue
    }
    if (text.startsWith('/brief ')) {
      const brief = runtime.brief(text.slice(7).trim())
      console.log(core.renderIntentBrief(brief))
      console.log(core.renderReadback(brief))
      continue
    }
    if (text.startsWith('/')) { console.log(`unknown command: ${text}; /help`); continue }
    const { correctionStatement } = await loadLearning()
    const feedback = correctionStatement(text)
    if (feedback) {
      const result = learnPreference(ledger, feedback, text, { explicit: /^(以后|记住|每次)/.test(text) })
      saveLedgerWithAudit(ledger, { actor: 'local', action: 'correct', allowed: true, reason: result.preference.id })
      printLearnReceipt(result)
      continue
    }
    await runTask(text, pendingFiles)
  }
  rl.close()
  saveLedger(ledger)
}

/* ---------------------------------------------------------------------------
 * 0.4.0 Wave 1 (task-29): interactive shell entry.
 *
 * The state machine / rendering / paste guard live in lib/shell.js. This file
 * keeps the process-level concerns (the TOS gate already ran, the ledger and
 * model runtime, the writer lock) and injects read-only JSON views plus one
 * turn executor. The legacy REPL (repl) stays as the explicit fallback
 * (ADVISERS_NO_SHELL=1); a non-TTY stdin keeps the 0.3.x "print help, exit 0"
 * path byte for byte, and `advisers tui --once/--json` is untouched.
 * ------------------------------------------------------------------------- */

/** Today counts for the shell status line (same definition as repl()). */
function shellTodayCounts(ledger, nowMs = Date.now()) {
  const today = localDayOf(nowMs)
  let due = 0
  let overdue = 0
  try {
    for (const commitment of ledger.openCommitments()) {
      if (!commitment.dueAt) continue
      const ms = Date.parse(commitment.dueAt)
      if (Number.isNaN(ms)) continue
      if (ms < nowMs && localDayOf(ms) !== today) overdue += 1
      else if (localDayOf(ms) === today) due += 1
    }
  } catch {}
  return { due, overdue }
}

function shellModelState() {
  const local = !process.env.ADVISERS_API_KEY || process.env.ADVISERS_NO_MODEL === '1'
  return { local, model: local ? null : (process.env.ADVISERS_MODEL || 'deepseek-flash') }
}

/**
 * Run legacy printing code and collect its stdout as result-block lines.
 * Keeps the old /commands alive inside the shell without a second command
 * surface: the functions print like before, the shell renders the captured
 * lines through the sanitising kernel.
 */
async function captureConsole(fn) {
  const lines = []
  const original = console.log
  console.log = (...values) => { lines.push(values.map((value) => (typeof value === 'string' ? value : String(value))).join(' ')) }
  try { await fn() } finally { console.log = original }
  return lines
}

/** Read-only evidence view shared by /evidence (no exit-code side effects). */
async function shellEvidenceBlock(id) {
  const store = mode === 'sqlite' ? readStore() : null
  const ledger = readLedgerForCommand(id.startsWith('fact_') ? { facts: {} } : id.startsWith('pref_') ? { preferences: {} } : { commitments: {} })
  const { evidenceForCommitment, evidenceForFact, evidenceForPreference } = await loadEvidence()
  const lookups = await buildEvidenceLookups(store)
  let result
  if (id.startsWith('cm_')) result = await evidenceForCommitment(store, ledger, id, undefined, { lookup: lookups })
  else if (id.startsWith('fact_')) result = await evidenceForFact(store, ledger, id, undefined, { lookup: lookups })
  else if (id.startsWith('pref_')) result = await evidenceForPreference(store, ledger, id, undefined, { lookup: lookups })
  else throw Object.assign(new Error('unknown evidence id prefix (want cm_/fact_/pref_)'), { code: 'E_USAGE' })
  if (!result || (!result.commitment && !result.fact && !result.preference)) throw new Error('not found: ' + id)
  await normalizeEvidenceSources(result)
  const unverifiable = Array.isArray(result.unverifiable) ? result.unverifiable : []
  const label = result.commitment ? result.commitment.action : result.fact ? result.fact.subject + ' ' + result.fact.predicate : result.preference?.statement
  const lines = []
  if (!result.sources.length && !unverifiable.length) lines.push({ role: 'fact', text: '（没有可回溯来源）' })
  for (const source of result.sources) lines.push({ role: 'fact', text: source.sessionId + '#' + source.turnId + '  「' + String(source.quote ?? '').slice(0, 120) + '」' })
  for (const missing of result.missing) lines.push({ role: 'fact', text: 'MISSING ' + missing.reason + (missing.ref ? ' ' + missing.ref : '') })
  for (const item of unverifiable) lines.push({ role: 'fact', text: 'MANUAL 操作者录入（未外部核验）  「' + String(item.quote ?? '').slice(0, 120) + '」' })
  return { headline: String(id) + '  ' + String(label ?? ''), lines, next: 'advisers evidence show ' + id + ' --json' }
}

/** Read-only client view for /client [id|list]. */
function shellClientBlock(args, arg) {
  const store = readStore()
  if (!store) throw new Error('customer views need the SQLite store (ADVISERS_STORE=sqlite)')
  const words = Array.isArray(args) ? args : []
  const sub = words[0]
  if (!sub || sub === 'list' || sub === 'ls') {
    const rows = store.listClients({ status: 'active', limit: 50 })
    return {
      headline: '客户（' + rows.length + '）',
      lines: rows.length ? rows.map((client) => ({ role: 'item', text: client.id + '  ' + client.name })) : [{ role: 'fact', text: '（还没有客户）' }],
      next: 'advisers client show <id>',
    }
  }
  const id = sub === 'show' ? words[1] : sub
  if (!id) throw new Error('usage: /client [list|<id>]')
  const view = readClientView(store, id)
  const openRows = Array.isArray(view.open) ? view.open : []
  const lines = [
    { role: 'fact', text: '状态 ' + String(view.client.status ?? 'active') + ' · secrecy ' + String(view.client.secrecyDefault ?? 0) },
    { role: 'item', text: '项目 ' + view.projects.length + ' · 事项 ' + view.matters.length + ' · 未完成 ' + openRows.length + ' · 备注 ' + view.notes.length },
  ]
  for (const item of openRows.slice(0, 5)) lines.push({ role: 'item', text: item.id + '  ' + String(item.action ?? item.title ?? '') })
  return { headline: view.client.name + ' [' + view.client.id + ']', lines, next: 'advisers client show ' + view.client.id + ' --json' }
}

/** Open commitments grouped for /today and /who (no store reads). */
function shellOpenRows(ledger) {
  const rows = []
  try {
    for (const commitment of ledger.openCommitments()) rows.push(commitment)
  } catch {}
  return rows
}

/** Build the runShell() handler table for one interactive session. */
async function runShellEntry({ allowPaths = [] } = {}) {
  const shell = await loadShell()
  ensureHome()
  const ledger = loadLedger()
  const runtime = runtimeFor(ledger)
  const state = {
    ledger,
    runtime,
    conversationId: latestConversationId(),
    debug: process.env.ADVISERS_DEBUG === '1',
    allowPaths: [...allowPaths],
  }
  const handlers = {
    status: () => {
      const model = shellModelState()
      return { kind: 'idle', today: shellTodayCounts(state.ledger), local: model.local, model: model.model, hint: '/help' }
    },
    turn: async (payload) => {
      let question
      try {
        question = await runTurn({
          runtime: state.runtime,
          ledger: state.ledger,
          text: payload.text,
          conversationId: state.conversationId,
          debug: state.debug,
          confirm: payload.confirm,
          attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
          allowPaths: [...state.allowPaths, ...(Array.isArray(payload.allowPaths) ? payload.allowPaths : [])],
          renderWidth: null,
          signal: payload.signal ?? null,
        })
      } finally {
        try { saveLedger(state.ledger) } catch {}
      }
      if (lastTurnSafetyBlock) {
        return { kind: 'error', error: { title: '本轮被内容安全拦截', reason: '没有执行；未创建承诺或文件。', next: '/retry 或 /help', code: lastTurnSafetyBlock.code ?? undefined } }
      }
      if (question) return { question: String(question) }
      return undefined
    },
    history: async () => {
      const rows = dbStore()?.listSessions(50) ?? []
      return { sessions: rows.map((row, index) => ({ n: index + 1, id: row.conversationId, title: row.title, updatedAt: row.updatedAt })) }
    },
    resume: async ({ arg }) => {
      const rows = dbStore()?.listSessions(50) ?? []
      const pick = /^\d+$/.test(String(arg)) ? rows[Number(arg) - 1] : rows.find((row) => row.conversationId === arg)
      if (!pick) throw new Error('unknown session: ' + arg)
      state.conversationId = pick.conversationId
      return { kind: 'notice', headline: '已恢复会话', summary: String(pick.title ?? '') + ' [' + pick.conversationId + ']', next: '直接输入下一步' }
    },
    newSession: async () => {
      state.conversationId = 'local_' + Date.now()
      return { kind: 'notice', headline: '新会话', summary: '下一条消息写在新会话里' }
    },
    today: async () => {
      const nowMs = Date.now()
      const today = localDayOf(nowMs)
      const due = []
      const overdue = []
      for (const commitment of shellOpenRows(state.ledger)) {
        if (!commitment.dueAt) continue
        const ms = Date.parse(commitment.dueAt)
        if (Number.isNaN(ms)) continue
        if (ms < nowMs && localDayOf(ms) !== today) overdue.push(commitment)
        else if (localDayOf(ms) === today) due.push(commitment)
      }
      const lines = []
      for (const commitment of due.slice(0, 8)) lines.push({ role: 'item', text: '今天 · ' + commitment.id + '  ' + String(commitment.action) })
      for (const commitment of overdue.slice(0, 8)) lines.push({ role: 'item', text: '逾期 · ' + commitment.id + '  ' + String(commitment.action) + '（' + String(commitment.dueAt).slice(0, 10) + '）' })
      if (!lines.length) lines.push({ role: 'fact', text: '今天没有到期的承诺。' })
      return { headline: '今天 · 今天到期 ' + due.length + ' · 逾期 ' + overdue.length, lines, next: 'advisers today --json' }
    },
    remind: async () => {
      const { buildReminders } = await loadRemind()
      const snoozed = {}
      for (const [key, value] of readStore()?.listMetaByPrefix('snooze:') ?? []) snoozed[key.slice('snooze:'.length)] = value
      const reminders = buildReminders(state.ledger, { now: new Date(), snoozedUntil: snoozed })
      const lines = reminders.slice(0, 8).map((reminder) => ({ role: 'item', text: '[' + reminder.level + '/' + reminder.bucket + '] ' + String(reminder.action) + (reminder.dueAt ? ' · ' + String(reminder.dueAt).slice(0, 16) : '') }))
      return { headline: '提醒（' + reminders.length + '）', lines: lines.length ? lines : [{ role: 'fact', text: '现在没有到期的提醒。' }], next: 'advisers remind --json' }
    },
    who: async () => {
      const open = shellOpenRows(state.ledger)
      const mine = open.filter((commitment) => commitment.debtor === 'user' || commitment.debtor === 'agent')
      const waiting = open.filter((commitment) => commitment.debtor === 'third' || String(commitment.debtor).startsWith('third:'))
      const lines = []
      for (const commitment of mine) lines.push({ role: 'item', text: '我欠 ' + commitment.id + '  ' + commitment.creditor + ' · ' + String(commitment.action) })
      for (const commitment of waiting) lines.push({ role: 'item', text: '等人 ' + commitment.id + '  ' + String(commitment.action) })
      return { headline: '我欠别人 ' + mine.length + ' · 等别人 ' + waiting.length, lines: lines.length ? lines.slice(0, 12) : [{ role: 'fact', text: '（没有未完成的承诺）' }], next: 'advisers who' }
    },
    client: async ({ args, arg }) => shellClientBlock(args, arg),
    evidence: async ({ arg }) => {
      if (!arg) throw Object.assign(new Error('usage: /evidence <cm_|fact_|pref_ id>'), { code: 'E_USAGE' })
      return shellEvidenceBlock(String(arg).split(/\s+/)[0])
    },
    opening: async () => {
      const lines = await captureConsole(() => printOpening(state.conversationId))
      return lines.filter((line) => line.trim() !== '').slice(0, 2)
    },
    legacyCommand: async ({ name, args, arg }) => {
      const sub = Array.isArray(args) ? args[0] : undefined
      switch (name) {
        case '/deliveries': { const lines = await captureConsole(() => printDeliveries()); return { lines } }
        case '/tick': { const lines = await captureConsole(() => tick(state.ledger)); return { lines } }
        case '/week': { const lines = await captureConsole(() => printWeek(state.ledger)); return { lines } }
        case '/memory': { const lines = await captureConsole(() => printMemory(state.ledger)); return { lines } }
        case '/prefs': { const lines = await captureConsole(() => printPreferences()); return { lines } }
        case '/links': { const lines = await captureConsole(() => printLinks()); return { lines } }
        case '/audit': { const lines = await captureConsole(() => auditCommand([])); return { lines } }
        case '/agenda': {
          const lines = await captureConsole(async () => {
            const inputs = loadAgendaInputs()
            const data = await buildAgendaData({ ledger: inputs.ledger, events: inputs.events, nowMs: Date.now(), days: 7, includeCalendar: true, includeDone: false })
            printAgenda(data)
          })
          return { lines }
        }
        case '/search': {
          const query = String(arg ?? '').trim()
          if (!query) throw Object.assign(new Error('usage: /search <text>'), { code: 'E_USAGE' })
          const rows = dbStore()?.searchTurns(query, { limit: 10 }) ?? []
          return { headline: '搜索 · ' + query, lines: rows.length ? rows.map((row) => ({ role: 'item', text: row.seq + '\t' + row.role + '\t' + String(row.content).replace(/\s+/g, ' ').slice(0, 160) })) : [{ role: 'fact', text: '没有匹配' }] }
        }
        case '/digest': {
          const lines = await captureConsole(async () => {
            const store = dbStore()
            const { buildDigest } = await loadDigest()
            console.log(buildDigest({
              period: String(arg ?? '').endsWith('week') ? 'week' : 'day',
              turns: store?.listTurns(state.conversationId, 200) ?? [],
              commitments: state.ledger.listCommitments(),
              deliveries: store?.listDeliveries(100) ?? [],
            }))
          })
          return { lines }
        }
        case '/diff': { const lines = await captureConsole(async () => { const { diffLatest } = await loadUndo(); const result = await diffLatest({ cwd: process.cwd(), backupDir: join(HOME, 'undo') }); console.log(result.ok ? result.diff : 'diff failed: ' + result.error) }); return { lines } }
        case '/undo': { const lines = await captureConsole(async () => { const { undoLatest } = await loadUndo(); const result = await undoLatest({ cwd: process.cwd(), backupDir: join(HOME, 'undo'), force: args.includes('--force') }); console.log(result.ok ? '已回滚：' + result.path : '撤销失败：' + result.error) }); return { lines } }
        case '/why': { const id = String(arg ?? '').trim(); if (!id) throw Object.assign(new Error('usage: /why <pref-id>'), { code: 'E_USAGE' }); const lines = await captureConsole(() => why(id)); return { lines } }
        case '/debug': {
          state.debug = !state.debug
          return { kind: 'notice', headline: state.debug ? '明细已开启' : '明细已关闭', summary: state.debug ? '会打印上下文与内部行。' : undefined }
        }
        case '/forget': {
          const id = String(arg ?? '').trim()
          if (!id) throw Object.assign(new Error('usage: /forget <pref-id>'), { code: 'E_USAGE' })
          const ok = state.ledger.forget('preference', id)
          saveLedger(state.ledger)
          return { kind: 'notice', headline: ok ? '已忘记：' + id : '没有这条偏好：' + id }
        }
        case '/correct': {
          const statement = String(arg ?? '').trim()
          if (!statement) throw Object.assign(new Error('usage: /correct <text>'), { code: 'E_USAGE' })
          const lines = await captureConsole(() => { const result = learnPreference(state.ledger, statement, statement); saveLedger(state.ledger); printLearnReceipt(result) })
          return { lines }
        }
        case '/decay': {
          const lines = await captureConsole(async () => { const { applyPreferenceDecay } = await loadLearning(); const changed = applyPreferenceDecay(state.ledger.listPreferences({ includeCandidates: true })); saveLedger(state.ledger); console.log('[decay] ' + changed.length + ' preference(s) updated') })
          return { lines }
        }
        case '/matter': {
          const useId = sub === 'use' && Array.isArray(args) ? args[1] : undefined
          if (!useId) throw Object.assign(new Error('usage: /matter use <matter-id>'), { code: 'E_USAGE' })
          const matter = state.ledger.getMatter(useId)
          if (!matter) throw new Error('unknown matter: ' + useId)
          if (matter.status !== 'active') throw new Error('matter 已归档：' + useId)
          state.ledger.setRoute('active-matter', useId)
          saveLedger(state.ledger)
          return { kind: 'notice', headline: 'active matter: ' + useId, summary: String(matter.title ?? '') }
        }
        case '/commit': {
          const { flags, positional } = parseFlags(Array.isArray(args) ? args : [])
          if (positional[0] === 'ls') { const lines = await captureConsole(() => printCommitments(state.ledger)); return { lines } }
          if (positional[0] === 'add') {
            const action = positional.slice(1).join(' ')
            if (!action || !flags.quote) throw Object.assign(new Error('用法：/commit add <action> --quote <原话> [--due ISO]'), { code: 'E_USAGE' })
            const c = state.ledger.addCommitment({ matterId: resolveMatterForCommand(state.ledger, flags.matter, 'commit add'), debtor: flags.debtor ?? 'user', creditor: flags.creditor ?? 'me', action, dueAt: flags.due, capability: 'todo', evidence: [manualEvidence(String(flags.quote), 'repl commit add')] })
            saveLedger(state.ledger)
            return { kind: 'notice', headline: c.id + ' open ' + c.action }
          }
          throw Object.assign(new Error('用法：/commit add ... 或 /commit ls'), { code: 'E_USAGE' })
        }
        case '/done': {
          const { flags, positional } = parseFlags(Array.isArray(args) ? args : [])
          const id = positional[0]
          if (!id || !flags.evidence) throw Object.assign(new Error('用法：/done <id> --evidence <证据>'), { code: 'E_USAGE' })
          state.ledger.completeCommitment(id, [manualEvidence(String(flags.evidence), 'repl commit done')])
          saveLedger(state.ledger)
          return { kind: 'notice', headline: 'done: ' + id }
        }
        case '/routine': {
          if (sub !== 'save') throw Object.assign(new Error('usage: /routine save'), { code: 'E_USAGE' })
          const last = lastRun
          const routine = state.ledger.addRoutine({
            name: (last?.toolLog?.map((tool) => tool.name).join(' ') || '本地任务').slice(0, 60),
            description: '从本地任务沉淀的流程草稿',
            trigger: [],
            steps: last?.toolLog?.map((tool) => tool.name).length ? last.toolLog.map((tool) => tool.name) : ['执行任务'],
            preferences: [],
            pitfalls: [],
            verification: ['产物已生成并记录 delivery'],
            createdBy: 'agent',
          })
          saveLedger(state.ledger)
          return { kind: 'notice', headline: 'draft routine ' + routine.id, summary: String(routine.name), next: 'advisers routine approve ' + routine.id }
        }
        case '/brief': {
          const text = String(arg ?? '').trim()
          if (!text) throw Object.assign(new Error('usage: /brief <text>'), { code: 'E_USAGE' })
          const lines = await captureConsole(() => { const brief = state.runtime.brief(text); console.log(core.renderIntentBrief(brief)); console.log(core.renderReadback(brief)) })
          return { lines }
        }
        default:
          return undefined
      }
    },
  }
  const result = await shell.runShell({
    argv: outputArgv,
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    store: null,
    allowPaths: state.allowPaths,
    handlers,
  })
  try { saveLedger(state.ledger) } catch {}
  return result
}


/* ---------------------------------------------------------------------------
 * 0.4.0 Wave 2 (task-29): KB / fact / scoped-search commands.
 *
 * Design source: 04-0.4-research/45-kb-design.md sections 3.4-3.7. Human output
 * and machine output stay separate: --json prints one JSON document and nothing
 * else; failures go to stderr as {error:{code,message,hint?}} with exit code 1
 * (the TOS gate still uses 3).
 * ------------------------------------------------------------------------- */

/** One structured family error (new 0.4 command family style). */
function familyError(code, message, hint) {
  const error = new Error(message)
  error.code = code
  if (typeof hint === 'string' && hint) error.hint = hint
  return error
}

/** Print one family failure as stderr JSON and exit 1 (store failures keep the
 * documented E_DB_* hint path instead). */
function reportFamilyFailure(error) {
  if (isStoreWriteFailure(error)) { exitStoreWriteFailure(error); return }
  const code = typeof error?.code === 'string' && error.code ? error.code : 'E_INTERNAL'
  let message = String(error?.message ?? error)
  if (message.startsWith(code + ': ')) message = message.slice(code.length + 2)
  const hintTail = message.lastIndexOf(' (hint: ')
  if (hintTail !== -1 && message.endsWith(')')) message = message.slice(0, hintTail)
  const payload = { error: { code, message } }
  if (typeof error?.hint === 'string' && error.hint) payload.error.hint = error.hint
  console.error(JSON.stringify(payload))
  process.exitCode = 1
}

/** Resolve the SQLite store for a family command (null in JSON-store mode). */
function familyStore({ write = false } = {}) {
  if (mode !== 'sqlite') {
    throw familyError('E_STORE_REQUIRED', 'this command needs the SQLite store (ADVISERS_STORE=sqlite)', 'unset ADVISERS_STORE=json or run advisers doctor')
  }
  if (write) {
    const store = dbStore()
    if (!store) throw familyError('E_STORE_REQUIRED', 'the SQLite store is unavailable for writing', 'run advisers doctor')
    return store
  }
  return readStoreOrExit()
}

/** Shared strict flag parse that reports E_USAGE for the family commands. */
function familyFlags(args, spec, usage) {
  // Subcommand --help is a help request, not an unknown option. Before 0.4.2
  // `kb add --help`/`mail account add --help` failed with E_USAGE because the
  // strict flag parser only knew the documented values. Print the command's own
  // usage block (no store/TOS/key needed) and let the caller return.
  if (Array.isArray(args) && (args.includes('--help') || args.includes('-h'))) {
    console.log(usage)
    return null
  }
  const parsed = parseStrictFlags(args, spec)
  if (!parsed.ok) { usageFail(parsed.error, usage); return null }
  return parsed
}

function familyInteger(value, name, min, max) {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(String(value))) throw familyError('E_USAGE', name + ' must be an integer')
  const number = Number(value)
  if (number < min || number > max) throw familyError('E_USAGE', name + ' must be an integer ' + min + '..' + max)
  return number
}

const KB_USAGE = [
  'usage: advisers kb add <file>... [--title s] [--kind quote|contract|receipt|delivery|note|other]',
  '                            [--client id] [--project id] [--matter id] [--secrecy 0-3] [--replace] [--from list.txt] [--json]',
  '       advisers kb ls [--client|--matter|--kind] [--all] [--limit n] [--clearance 0-3] [--json]',
  '       advisers kb show <id> [--chunks 0..20] [--json]',
  '       advisers kb rm <id> [--json]',
  '       advisers kb purge <id> [--dry-run|--yes] [--json]',
  '       advisers kb reindex [--rebuild] [--json]',
  '       advisers kb search <query> [--scope kb|pages|all] [--limit n] [--clearance 0-3] [--json]',
  '       advisers kb page ls|show|rebuild|diff ... [--json]',
  '       advisers kb link <doc-id> --fact <fact-id> [--relation source|mentions] [--chunk id] [--json]',
  '       advisers kb unlink <doc-id> --fact <fact-id> [--relation source|mentions] [--json]',
].join('\n')

function kbDocRowText(doc) {
  return doc.id + '  ' + doc.kind + '  ' + (doc.status === 'active' ? '' : '[' + doc.status + '] ') + doc.title + '  (' + doc.chunkCount + ' chunks, ' + doc.sizeBytes + ' B)'
}

async function kbAddCommand(args) {
  const usage = 'usage: advisers kb add <file>... [--title s] [--kind k] [--client id] [--project id] [--matter id] [--secrecy 0-3] [--replace] [--from list.txt] [--json]'
  const parsed = familyFlags(args, { booleans: ['json', 'replace'], values: ['title', 'kind', 'client', 'project', 'matter', 'secrecy', 'from'] }, usage)
  if (!parsed) return
  const flags = parsed.flags
  let secrecy
  if (flags.secrecy !== undefined) secrecy = familyInteger(flags.secrecy, '--secrecy', 0, 3)
  const files = [...parsed.positional]
  if (typeof flags.from === 'string') {
    let list
    try { list = readFileSync(flags.from, 'utf8') } catch (error) { throw familyError('E_KB_READ', 'cannot read --from list: ' + (error?.message ?? error)) }
    for (const line of list.split(/\r?\n/)) {
      const value = line.trim()
      if (value && !value.startsWith('#')) files.push(value)
    }
  }
  if (!files.length) { usageFail('no input files', usage); return }
  const store = familyStore({ write: true })
  const kb = await loadKb()
  const added = []
  const skipped = []
  const failed = []
  let chunks = 0
  let textBytes = 0
  let truncated = 0
  let needsOcr = 0
  for (const file of files) {
    try {
      const result = await kb.kbAdd(store, { file, title: flags.title, kind: flags.kind, clientId: flags.client, projectId: flags.project, matterId: flags.matter, secrecy, replace: flags.replace === true, hmacKey: process.env.ADVISERS_AUDIT_KEY })
      const doc = result.document
      added.push({ id: doc.id, title: doc.title, kind: doc.kind, sizeBytes: doc.sizeBytes, textBytes: result.counts.textBytes, chunks: result.counts.chunks, truncated: result.truncated, needsOcr: doc.needsOcr, encoding: doc.encoding })
      chunks += result.counts.chunks
      textBytes += result.counts.textBytes
      if (result.truncated) truncated += 1
      if (doc.needsOcr) needsOcr += 1
    } catch (error) {
      if (error?.skip === true) skipped.push({ file, code: error.code ?? 'E_KB_DUPLICATE', existingId: error.existingId })
      else failed.push({ file, code: typeof error?.code === 'string' ? error.code : 'E_KB_INVALID', message: String(error?.message ?? error) })
    }
  }
  const payload = { ok: failed.length === 0, command: 'kb add', counts: { added: added.length, skipped: skipped.length, failed: failed.length, chunks, textBytes }, added, skipped, failed, truncated, needsOcr }
  if (failed.length) process.exitCode = 1
  if (flags.json) { console.log(JSON.stringify(payload, null, 2)); return }
  for (const item of added) console.log('added ' + item.id + '  ' + item.title + '  (' + item.chunks + ' chunks, ' + item.textBytes + ' B text)')
  for (const item of skipped) console.log('skipped ' + item.file + '  ' + item.code + (item.existingId ? ' existing ' + item.existingId : ''))
  for (const item of failed) console.error('failed ' + item.file + '  ' + item.code + ': ' + item.message)
  console.log('counts: added=' + added.length + ' skipped=' + skipped.length + ' failed=' + failed.length + ' chunks=' + chunks + ' textBytes=' + textBytes)
}

async function kbListCommand(args) {
  const usage = 'usage: advisers kb ls [--client id] [--matter id] [--kind k] [--all] [--limit n] [--clearance 0-3] [--json]'
  const parsed = familyFlags(args, { booleans: ['json', 'all'], values: ['client', 'matter', 'kind', 'limit', 'clearance'] }, usage)
  if (!parsed) return
  const flags = parsed.flags
  const store = familyStore()
  const kb = await loadKb()
  const result = kb.kbList(store, {
    clientId: flags.client,
    matterId: flags.matter,
    kind: flags.kind,
    all: flags.all === true,
    limit: familyInteger(flags.limit, '--limit', 1, 200),
    clearance: familyInteger(flags.clearance, '--clearance', 0, 3),
  })
  if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  if (!result.documents.length) console.log('（没有 KB 文档）')
  for (const doc of result.documents) console.log(kbDocRowText(doc))
  console.log('total=' + result.total + ' limit=' + result.limit + ' clearance=' + result.clearance + (result.truncated ? ' truncated' : '') + (result.protectedExcluded ? ' protectedExcluded=' + result.protectedExcluded : ''))
}

async function kbShowCommand(args) {
  const usage = 'usage: advisers kb show <id> [--chunks 0..20] [--clearance 0-3] [--json]'
  const parsed = familyFlags(args, { booleans: ['json'], values: ['chunks', 'clearance'] }, usage)
  if (!parsed) return
  const id = parsed.positional[0]
  if (!id) { usageFail('missing document id', usage); return }
  const kb = await loadKb()
  const result = kb.kbShow(familyStore(), id, { chunks: familyInteger(parsed.flags.chunks, '--chunks', 0, 20), clearance: familyInteger(parsed.flags.clearance, '--clearance', 0, 3) })
  if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  const doc = result.document
  console.log(doc.id + '  ' + doc.kind + '  ' + doc.title)
  console.log('size=' + doc.sizeBytes + ' textBytes=' + doc.textBytes + ' chunks=' + doc.chunkCount + ' secrecy=' + doc.secrecy + ' status=' + doc.status)
  console.log('source=' + doc.sourceName + ' sha256=' + String(doc.sourceSha256 ?? '').slice(0, 16) + ' capturedAt=' + doc.capturedAt)
  if (result.chunks.length) {
    console.log('chunks (showing ' + result.chunks.length + '/' + result.chunksTotal + '):')
    for (const chunk of result.chunks) console.log('  #' + chunk.seq + '  ' + chunk.text + (chunk.truncated ? '…' : ''))
  }
}

async function kbRmCommand(args) {
  const usage = 'usage: advisers kb rm <id> [--json]'
  const parsed = familyFlags(args, { booleans: ['json'], values: [] }, usage)
  if (!parsed) return
  const id = parsed.positional[0]
  if (!id) { usageFail('missing document id', usage); return }
  const kb = await loadKb()
  const result = kb.kbRm(familyStore({ write: true }), id)
  if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  console.log('removed ' + result.document.id + '  ' + result.document.title + '  (' + result.counts.chunks + ' chunks)')
}

async function kbPurgeCommand(args) {
  const usage = 'usage: advisers kb purge <id> [--dry-run|--yes] [--json]'
  const parsed = familyFlags(args, { booleans: ['json', 'dry-run', 'yes'], values: [] }, usage)
  if (!parsed) return
  const id = parsed.positional[0]
  if (!id) { usageFail('missing document id', usage); return }
  let yes = parsed.flags.yes === true
  if (!yes && parsed.flags['dry-run'] !== true && process.stdin.isTTY) yes = await askYesNo(null, '永久删除 KB 文档 ' + id + '？[y/N] ', false)
  const kb = await loadKb()
  const result = kb.kbPurge(familyStore({ write: yes }), id, { yes })
  if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  if (result.dryRun) console.log('dry-run: 会物理删除 ' + id + '（chunks=' + result.counts.chunks + ', factLinks=' + result.counts.factLinks + '）；加 --yes 执行')
  else console.log('purged ' + result.document.id + '  (' + result.counts.chunks + ' chunks, ' + result.counts.factLinks + ' fact links)')
}

async function kbReindexCommand(args) {
  const usage = 'usage: advisers kb reindex [--rebuild] [--json]'
  const parsed = familyFlags(args, { booleans: ['json', 'rebuild'], values: [] }, usage)
  if (!parsed) return
  const kb = await loadKb()
  // kbReindex() may rebuild (a write) when the integrity probe fails, so it
  // always runs on the writable store (one audit row when anything changed).
  const store = familyStore({ write: true })
  const result = kb.kbReindex(store, { rebuild: parsed.flags.rebuild === true })
  if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  console.log('integrity: ' + (result.integrity.ok ? 'ok' : 'BROKEN') + ' tokenizer=' + (result.integrity.tokenizer ?? 'LIKE-only'))
  if (result.rebuilt.length) console.log('rebuilt: ' + result.rebuilt.join(', '))
  else console.log('rebuilt: none (indexes already consistent; --rebuild forces)')
  console.log('counts: documents=' + result.counts.documents + ' chunks=' + result.counts.chunks + ' pages=' + result.counts.pages)
  if (result.degraded.length) console.log('degraded: ' + result.degraded.join(', '))
  if (!result.ok) process.exitCode = 1
}

async function kbPageCommand(args) {
  const usage = [
    'usage: advisers kb page ls [--kind client|project|timeline|facts] [--check] [--limit n] [--json]',
    '       advisers kb page show <id> [--stored] [--diff] [--json]',
    '       advisers kb page rebuild [--kind k] [--id page-id] [--only-stale] [--dry-run] [--json]',
    '       advisers kb page diff <id> [--json]',
  ].join('\n')
  const sub = args[0]
  const parsed = familyFlags(args.slice(1), { booleans: ['json', 'check', 'stored', 'diff', 'dry-run', 'only-stale'], values: ['kind', 'id', 'limit', 'clearance'] }, usage)
  if (!parsed) return
  const flags = parsed.flags
  const pages = await loadKbPages()
  const baseOptions = { kind: flags.kind, id: parsed.positional[0] ?? flags.id, limit: familyInteger(flags.limit, '--limit', 1, 500), clearance: familyInteger(flags.clearance, '--clearance', 0, 3) }
  if (sub === 'ls') {
    const result = pages.kbPageList(familyStore(), { ...baseOptions, check: flags.check === true })
    if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
    if (!result.pages.length) console.log('（没有页面；先运行 advisers kb page rebuild）')
    for (const page of result.pages) console.log(page.id + '  ' + page.kind + '  ' + page.title + (page.stale === true ? '  [STALE]' : page.stale === false ? '  [fresh]' : ''))
    console.log('total=' + result.total + ' limit=' + result.limit + (flags.check === true ? ' staleCount=' + result.staleCount : '') + (result.protectedExcluded ? ' protectedExcluded=' + result.protectedExcluded : ''))
    return
  }
  if (sub === 'show' || sub === 'diff') {
    const id = parsed.positional[0]
    if (!id) { usageFail('missing page id', usage); return }
    const result = sub === 'diff' ? pages.kbPageDiff(familyStore(), id, baseOptions) : pages.kbPageShow(familyStore(), id, { ...baseOptions, stored: flags.stored === true, diff: flags.diff === true })
    if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
    if (sub === 'diff') { console.log(result.diff || '（页面没有变化）'); return }
    const page = result.page
    console.log(page.id + '  ' + page.kind + '  ' + page.title + '  [' + (result.stale ? 'STALE' : 'fresh') + ']')
    if (page.markdown) process.stdout.write(page.markdown.endsWith('\n') ? page.markdown : page.markdown + '\n')
    if (result.diff) process.stdout.write(result.diff)
    return
  }
  if (sub === 'rebuild') {
    const result = pages.kbPageRebuild(familyStore({ write: flags['dry-run'] !== true }), { ...baseOptions, dryRun: flags['dry-run'] === true })
    if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
    console.log((result.dryRun ? 'dry-run: ' : '') + 'built=' + result.counts.built + ' written=' + result.counts.written + ' unchanged=' + result.counts.unchanged + ' skipped=' + result.counts.skipped)
    if (result.degraded.length) console.log('degraded: ' + result.degraded.join(', '))
    return
  }
  usageFail('unknown kb page subcommand: ' + (sub ?? '(none)'), usage)
}

async function kbSearchCommand(args, options = {}) {
  const usage = 'usage: advisers kb search <query> [--scope kb|pages|all] [--client id] [--matter id] [--kind k] [--limit n] [--clearance 0-3] [--json]'
  const parsed = familyFlags(args, { booleans: ['json'], values: ['scope', 'client', 'matter', 'kind', 'limit', 'clearance'] }, usage)
  if (!parsed) return
  const query = parsed.positional.join(' ').trim()
  if (!query) { usageFail('missing query', usage); return }
  const scope = options.scope ?? (parsed.flags.scope === undefined ? 'kb' : String(parsed.flags.scope))
  const kb = await loadKb()
  const store = familyStore()
  const result = kb.kbSearch(store, query, {
    scope,
    clientId: parsed.flags.client,
    matterId: parsed.flags.matter,
    kind: parsed.flags.kind,
    limit: familyInteger(parsed.flags.limit, '--limit', 1, 200),
    clearance: familyInteger(parsed.flags.clearance, '--clearance', 0, 3),
  })
  if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  if (!result.hits.length) console.log('没有匹配')
  for (const hit of result.hits) console.log(hit.kind + '\t' + String(hit.title ?? hit.snippet ?? '') + (hit.snippet ? '  「' + String(hit.snippet).replace(/\s+/g, ' ').slice(0, 120) + '」' : ''))
  console.log('counts: docs=' + result.counts.kbDocs + ' chunks=' + result.counts.kbChunks + ' pages=' + result.counts.kbPages + ' total=' + result.total + ' clearance=' + result.clearance + (result.degraded.length ? ' degraded=' + result.degraded.join(',') : ''))
}

async function kbCommand(rawArgs) {
  const sub = rawArgs[0]
  try {
    if (!sub || sub === 'help' || sub === '--help') { console.log(KB_USAGE); return }
    if (sub === 'add') return await kbAddCommand(rawArgs.slice(1))
    if (sub === 'ls' || sub === 'list') return await kbListCommand(rawArgs.slice(1))
    if (sub === 'show') return await kbShowCommand(rawArgs.slice(1))
    if (sub === 'rm' || sub === 'remove') return await kbRmCommand(rawArgs.slice(1))
    if (sub === 'purge') return await kbPurgeCommand(rawArgs.slice(1))
    if (sub === 'reindex') return await kbReindexCommand(rawArgs.slice(1))
    if (sub === 'page') return await kbPageCommand(rawArgs.slice(1))
    if (sub === 'search') return await kbSearchCommand(rawArgs.slice(1))
    if (sub === 'link') return await kbLinkCommand(rawArgs.slice(1), false)
    if (sub === 'unlink') return await kbLinkCommand(rawArgs.slice(1), true)
    usageFail('unknown kb subcommand: ' + sub, KB_USAGE)
  } catch (error) { reportFamilyFailure(error) }
}

/** kb link/unlink: explicit fact <-> document provenance (0.4.x follow-up). */
async function kbLinkCommand(rawArgs, unlink = false) {
  const usage = unlink
    ? 'usage: advisers kb unlink <doc-id> --fact <fact-id> [--relation source|mentions] [--json]'
    : 'usage: advisers kb link <doc-id> --fact <fact-id> [--relation source|mentions] [--chunk id] [--json]'
  const parsed = familyFlags(rawArgs, { booleans: ['json'], values: ['fact', 'relation', 'chunk'] }, usage)
  if (!parsed) return
  const docId = parsed.positional[0]
  const factId = parsed.flags.fact
  if (!docId) { usageFail('missing document id', usage); return }
  if (!factId) { usageFail('--fact is required', usage); return }
  const kb = await loadKb()
  const store = familyStore({ write: true })
  const result = unlink
    ? kb.kbUnlink(store, { docId, factId, relation: parsed.flags.relation })
    : kb.kbLink(store, { docId, factId, relation: parsed.flags.relation, chunkId: parsed.flags.chunk })
  if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  if (unlink) console.log('unlinked ' + result.removed + ' link(s): ' + docId + ' x ' + factId)
  else console.log('linked ' + docId + ' -> ' + factId + ' (' + result.link.relation + ')')
}

const FACT_USAGE = [
  'usage: advisers fact add <subject> <predicate> <object> --quote "evidence" [--matter id] [--valid-from ISO] [--source ref]',
  '                            [--doc <kb-doc-id>] [--relation source|mentions] [--supersedes <fact-id>] [--json]',
  '       advisers fact show <id> [--include-deleted] [--json]',
  '       advisers fact history <id> [--json]',
  '       advisers fact as-of <YYYY-MM-DD|ISO> [--matter id] [--client id] [--subject s] [--predicate s] [--limit n] [--include-deleted] [--json]',
].join('\n')

function factLine(fact) {
  return fact.id + '  ' + fact.subject + ' ' + fact.predicate + ' ' + String(fact.object ?? '') + (fact.matterId ? '  [' + fact.matterId + ']' : '') + '  status=' + fact.status + ' recordedAt=' + fact.recordedAt + (fact.validFrom ? ' validFrom=' + fact.validFrom : '') + (fact.validTo ? ' validTo=' + fact.validTo : '')
}

async function factCommand(rawArgs) {
  const sub = rawArgs[0]
  try {
    if (!sub || sub === 'help' || sub === '--help') { console.log(FACT_USAGE); return }
    const parsed = familyFlags(rawArgs.slice(1), { booleans: ['json', 'include-deleted'], values: ['matter', 'client', 'subject', 'predicate', 'limit', 'at', 'quote', 'valid-from', 'source', 'doc', 'relation', 'supersedes'] }, FACT_USAGE)
    if (!parsed) return
    const flags = parsed.flags
    const facts = await loadKbFacts()
    if (sub === 'add') {
      const usage = FACT_USAGE
      const parsedAdd = familyFlags(rawArgs.slice(1), { booleans: ['json'], values: ['quote', 'matter', 'valid-from', 'source', 'doc', 'relation', 'supersedes'] }, usage)
      if (!parsedAdd) return
      const [subject, predicate, object] = parsedAdd.positional
      if (!subject || !predicate || !object) { usageFail('fact add needs <subject> <predicate> <object>', usage); return }
      if (typeof parsedAdd.flags.quote !== 'string' || !parsedAdd.flags.quote.trim()) { usageFail('--quote is required (the evidence for a manually entered fact)', usage); return }
      if (parsedAdd.flags.doc !== undefined && parsedAdd.flags.relation === undefined) parsedAdd.flags.relation = 'source'
      if (parsedAdd.flags.relation !== undefined && parsedAdd.flags.doc === undefined) { usageFail('--relation requires --doc', usage); return }
      if (parsedAdd.flags.relation !== undefined && !['source', 'mentions'].includes(parsedAdd.flags.relation)) { usageFail('--relation must be source or mentions', usage); return }
      const entry = await loadFactEntry()
      const result = entry.factAdd(familyStore({ write: true }), {
        subject,
        predicate,
        object,
        quote: parsedAdd.flags.quote,
        matterId: parsedAdd.flags.matter,
        validFrom: parsedAdd.flags['valid-from'],
        source: parsedAdd.flags.source,
        docId: parsedAdd.flags.doc,
        relation: parsedAdd.flags.relation,
        supersedes: parsedAdd.flags.supersedes,
      })
      if (parsedAdd.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      console.log((result.deduped ? 'existing ' : 'added ') + factLine(result.fact))
      return
    }
    if (sub === 'show') {
      const id = parsed.positional[0]
      if (!id) { usageFail('missing fact id', FACT_USAGE); return }
      const result = facts.factShow(familyStore(), id, { includeDeleted: flags['include-deleted'] === true })
      if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      console.log(factLine(result.fact))
      for (const evidence of result.fact.evidence ?? []) console.log('  evidence  「' + String(evidence.quote ?? '').slice(0, 200) + '」')
      for (const source of result.kbSources ?? []) console.log('  kb  ' + source.docId + '  ' + String(source.title ?? ''))
      for (const warning of result.warnings ?? []) console.log('  warning: ' + warning)
      return
    }
    if (sub === 'history') {
      const id = parsed.positional[0]
      if (!id) { usageFail('missing fact id', FACT_USAGE); return }
      const result = facts.factHistory(familyStore(), id, { includeDeleted: flags['include-deleted'] !== false })
      if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      console.log('history of ' + result.rootId + ' (' + result.items.length + ')')
      result.items.forEach((fact, index) => console.log('  ' + (index + 1) + '. ' + factLine(fact)))
      for (const warning of result.warnings) console.log('  warning: ' + warning)
      return
    }
    if (sub === 'as-of' || sub === 'asof') {
      const at = parsed.positional[0] ?? flags.at
      if (!at) { usageFail('missing as-of instant (YYYY-MM-DD or ISO)', FACT_USAGE); return }
      const result = facts.factAsOf(familyStore(), {
        at,
        matterId: flags.matter,
        clientId: flags.client,
        subject: flags.subject,
        predicate: flags.predicate,
        limit: familyInteger(flags.limit, '--limit', 1, 500),
        includeDeleted: flags['include-deleted'] === true,
      })
      if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      console.log('as-of ' + result.at + '（本地日 ' + result.asOfLocalDay + '）· ' + result.items.length + ' 条')
      for (const fact of result.items) console.log('  ' + factLine(fact))
      for (const warning of result.warnings) console.log('  warning: ' + warning)
      if (result.degraded.length) console.log('  degraded: ' + result.degraded.join(', '))
      return
    }
    usageFail('unknown fact subcommand: ' + sub, FACT_USAGE)
  } catch (error) { reportFamilyFailure(error) }
}

/**
 * 'search <q> --scope turns|kb|pages|facts|all' (0.4.0 additive).
 *
 * The default (no --scope, or --scope turns) path is the frozen 0.3.2 output;
 * this helper only runs for the KB-inclusive scopes. KB hits come from
 * lib/kb.kbSearch; scope=all also merges local turn hits (never model calls).
 */
async function scopedSearch(args) {
  const usage = 'usage: advisers search <query> [--scope turns|kb|pages|facts|all] [--client id] [--matter id] [--kind k] [--limit n] [--clearance 0-3] [--json]'
  const parsed = familyFlags(args, { booleans: ['json', 'explain'], values: ['scope', 'client', 'matter', 'kind', 'limit', 'clearance'] }, usage)
  if (!parsed) return
  const query = parsed.positional.join(' ').trim()
  if (!query) { usageFail('missing query', usage); return }
  const scope = String(parsed.flags.scope ?? 'all')
  if (!['kb', 'pages', 'all', 'facts', 'turns'].includes(scope)) { usageFail('--scope must be turns, kb, pages, facts or all', usage); return }
  if (scope === 'turns') {
    const rows = readStoreOrExit()?.searchTurns(query, { limit: 10 }) ?? []
    if (parsed.flags.json) {
      console.log(JSON.stringify({ ok: true, command: 'search', query, scope: 'turns', counts: { turns: rows.length, kbDocs: 0, kbChunks: 0, kbPages: 0, facts: 0, preferences: 0 }, hits: rows.map((row) => ({ kind: 'turn', ref: { kind: 'turn', id: row.conversationId + '#' + row.seq }, snippet: String(row.content).slice(0, 240), at: row.createdAt })), total: rows.length, truncated: false, protectedExcluded: 0 }, null, 2))
      return
    }
    if (!rows.length) console.log('没有匹配')
    for (const row of rows) console.log(row.seq + '\t' + row.role + '\t' + row.content.replace(/\s+/g, ' ').slice(0, 160))
    return
  }
  const store = familyStore()
  const kb = await loadKb()
  const result = kb.kbSearch(store, query, {
    scope: scope === 'facts' ? 'kb' : scope,
    clientId: parsed.flags.client,
    matterId: parsed.flags.matter,
    kind: parsed.flags.kind,
    limit: familyInteger(parsed.flags.limit, '--limit', 1, 200),
    clearance: familyInteger(parsed.flags.clearance, '--clearance', 0, 3),
  })
  if (scope === 'all') {
    const turns = readStoreOrExit()?.searchTurns(query, { limit: 10 }) ?? []
    result.counts.turns = turns.length
    for (const row of turns) {
      if (result.hits.length >= result.limit) break
      result.hits.push({ kind: 'turn', ref: { kind: 'turn', id: row.conversationId + '#' + row.seq }, snippet: String(row.content).slice(0, 240), at: row.createdAt })
    }
    result.total = result.counts.kbDocs + result.counts.kbChunks + result.counts.kbPages + result.counts.turns
    result.truncated = result.total > result.hits.length
  }
  if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  if (!result.hits.length) console.log('没有匹配')
  for (const hit of result.hits) console.log(String(hit.kind) + '\t' + String(hit.title ?? hit.snippet ?? '').slice(0, 200))
  console.log('counts: turns=' + result.counts.turns + ' docs=' + result.counts.kbDocs + ' chunks=' + result.counts.kbChunks + ' pages=' + result.counts.kbPages + ' facts=' + result.counts.facts + ' total=' + result.total + ' clearance=' + result.clearance)
}


/* ---------------------------------------------------------------------------
 * 0.4.0 Wave 3 (task-29): mail / receivable / payment / consent commands.
 *
 * Design sources: 41-mail-entry.md section 3.7, 48-customer-v2.md section 3.3,
 * 46-policy-evidence.md section 3.5. All of them are additive CLI commands:
 * human output and --json output are separate, failures go to stderr as
 * {error:{code,message,hint?}} with exit 1, and credentials never appear on
 * argv, in the ledger or in logs.
 * ------------------------------------------------------------------------- */

function flagString(flags, name, label, usage) {
  const value = flags[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) { usageFail('--' + label + ' requires a value', usage); return undefined }
  return value.trim()
}

/** Prompt for a secret on the terminal without echo (TTY only). */
async function promptHidden(question) {
  if (!process.stdin.isTTY) throw familyError('E_TERM_REQUIRED', 'a terminal is required for the hidden password prompt', 'pipe one line with --pass-stdin instead')
  return await new Promise((resolve) => {
    const stdin = process.stdin
    const output = process.stderr
    let value = ''
    let done = false
    const wasRaw = Boolean(stdin.isRaw)
    const finish = (result) => {
      if (done) return
      done = true
      try { stdin.setRawMode(wasRaw) } catch {}
      try { stdin.off('data', onData) } catch {}
      try { stdin.pause() } catch {}
      output.write('\n')
      resolve(result)
    }
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n') { finish(value); return }
        if (char === '\u0003') { finish(undefined); return }
        if (char === '\u0004') { finish(value); return }
        if (char === '\u007f' || char === '\b') {
          if (value) { const chars = Array.from(value); chars.pop(); value = chars.join(''); output.write('\b \b') }
          continue
        }
        value += char
        output.write('*')
      }
    }
    output.write(question)
    try { stdin.setRawMode(true) } catch {}
    try { stdin.resume() } catch {}
    stdin.on('data', onData)
  })
}

/** Read one secret line from stdin (non-TTY --pass-stdin path). */
async function readSecretFromStdin() {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  const first = text.split(/\r?\n/)[0]
  return first === undefined ? '' : first
}

/* -------------------------------- mail ---------------------------------- */

const MAIL_USAGE = [
  'usage: advisers mail account add --name n --host h [--port 993] [--tls tls|starttls] --user u [--pass-stdin]',
  '                                [--mailbox INBOX] [--retention-days 30] [--client id] [--matter id] [--json]',
  '       advisers mail account ls|show <account>|rm <account> [--json]',
  '       advisers mail account test <account> [--mailbox INBOX] [--timeout 1..120] [--json]  (read-only IMAP probe)',
  '       advisers mail sync [<account>] [--full] [--dry-run] [--since-days 30] [--limit 50] [--mailbox INBOX] [--json] [--watch|--once [--json-lines]]',
  '       advisers mail ls [--account a] [--client id] [--status s] [--since 30d] [--limit n] [--json]',
  '       advisers mail show <id> [--body] [--json]',
  '       advisers mail extract [<id>...] [--all-new] [--local|--model] [--yes] [--matter id] [--limit n] [--dry-run] [--json]',
  '       advisers mail import <file|dir> [--limit n] [--dry-run] [--client id] [--project id] [--json]',
  '       advisers mail purge [--older-than 30d] [--dry-run|--yes] [--account a] [--json]',
  '       advisers mail link <message> [--client id] [--project id] [--json]',
  '       advisers mail dismiss <message> [--json]',
].join('\n')

function mailHumanRow(message) {
  const from = sanitizeConsoleText(String(message.from ?? ''), { max: 120 })
  const subject = sanitizeConsoleText(String(message.subject ?? ''), { max: 200 })
  return message.id + '  ' + String(message.receivedAt ?? '').slice(0, 16) + '  ' + from + '  ' + subject + '  [' + message.status + ']'
}

async function mailAccountCommand(args) {
  const sub = args[0]
  const rest = args.slice(1)
  const usage = 'usage: advisers mail account add|ls|show|test|rm ...'
  if (!sub || sub === 'help' || sub === '--help') { console.log(MAIL_USAGE); return }
  const mail = await loadMail()
  if (sub === 'add') {
    const parsed = familyFlags(rest, { booleans: ['json', 'pass-stdin'], values: ['name', 'host', 'port', 'tls', 'user', 'mailbox', 'client', 'matter', 'retention-days', 'pass'] }, usage)
    if (!parsed) return
    const flags = parsed.flags
    if (flags.pass !== undefined) throw familyError('E_MAIL_CONFIG', 'refusing a password on the command line (--pass)', 'use the interactive TTY prompt or --pass-stdin')
    const name = flagString(flags, 'name', 'name', usage)
    const host = flagString(flags, 'host', 'host', usage)
    const user = flagString(flags, 'user', 'user', usage)
    if (!name || !host || !user) { usageFail('--name, --host and --user are required', usage); return }
    let pass
    if (flags['pass-stdin'] === true) pass = await readSecretFromStdin()
    else pass = await promptHidden('IMAP 密码（输入不回显）：')
    if (typeof pass !== 'string' || pass === '') throw familyError('E_MAIL_CONFIG', 'no IMAP password was provided', 'run in a terminal for the hidden prompt, or pipe one line with --pass-stdin')
    const store = familyStore({ write: true })
    const result = mail.mailAccountAdd(store, {
      name,
      host,
      port: flags.port === undefined ? undefined : familyInteger(flags.port, '--port', 1, 65535),
      tls: flags.tls,
      username: user,
      mailbox: flags.mailbox,
      clientId: flags.client,
      defaultMatterId: flags.matter,
      retentionDays: flags['retention-days'] === undefined ? undefined : familyInteger(flags['retention-days'], '--retention-days', 0, 3650),
    }, { credential: { user, pass }, home: HOME })
    if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
    const account = result.account
    console.log('added ' + account.id + '  ' + account.name + '  ' + account.username + '@' + account.host + ':' + account.port + ' (' + account.tls + ')')
    console.log('credential: ' + (account.hasCredential ? 'stored (0600, outside the ledger)' : 'not stored'))
    return
  }
  if (sub === 'ls' || sub === 'list') {
    const parsed = familyFlags(rest, { booleans: ['json', 'all'], values: [] }, usage)
    if (!parsed) return
    const result = mail.mailAccountList(familyStore(), { includeRemoved: parsed.flags.all === true, home: HOME })
    if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
    if (!result.accounts.length) console.log('（没有邮件账号）')
    for (const account of result.accounts) console.log(account.id + '  ' + account.name + '  ' + account.username + '@' + account.host + ':' + account.port + '  ' + account.status + (account.hasCredential ? '  credential' : '  no-credential'))
    return
  }
  if (sub === 'show') {
    const parsed = familyFlags(rest, { booleans: ['json'], values: [] }, usage)
    if (!parsed) return
    const ref = parsed.positional[0]
    if (!ref) { usageFail('missing account id or name', usage); return }
    const result = mail.mailAccountShow(familyStore(), ref, { home: HOME })
    if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
    const account = result.account
    console.log(account.id + '  ' + account.name + '  ' + account.username + '@' + account.host + ':' + account.port + ' (' + account.tls + ')  ' + account.status)
    console.log('mailbox=' + account.mailbox + ' retentionDays=' + account.retentionDays + ' credential=' + (account.hasCredential ? 'stored' : 'missing') + (account.lastSyncAt ? ' lastSyncAt=' + account.lastSyncAt : ''))
    return
  }
  if (sub === 'test') {
    const parsed = familyFlags(rest, { booleans: ['json'], values: ['mailbox', 'timeout'] }, usage)
    if (!parsed) return
    const ref = parsed.positional[0]
    if (!ref) { usageFail('missing account id or name', usage); return }
    const timeoutMs = parsed.flags.timeout === undefined ? undefined : familyInteger(parsed.flags.timeout, '--timeout', 1, 120) * 1000
    const probe = await loadMailProbe()
    const result = await probe.mailAccountTest(familyStore(), ref, { home: HOME, mailbox: parsed.flags.mailbox, timeoutMs })
    if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
    console.log('IMAP ok  ' + result.accountId + '  ' + result.host + ':' + result.port + ' (' + result.tls + ')  mailbox=' + result.mailbox + '  latency=' + result.latencyMs + 'ms')
    console.log('uidValidity=' + String(result.uidValidity ?? '-') + ' messages=' + String(result.messages ?? '-') + ' capabilities=' + result.capabilities.count + (result.capabilities.flags.idle ? ' idle' : '') + (result.capabilities.flags.starttls ? ' starttls' : ''))
    return
  }
  if (sub === 'rm' || sub === 'remove') {
    const parsed = familyFlags(rest, { booleans: ['json', 'purge-messages'], values: [] }, usage)
    if (!parsed) return
    const ref = parsed.positional[0]
    if (!ref) { usageFail('missing account id or name', usage); return }
    const result = mail.mailAccountRemove(familyStore({ write: true }), ref, { home: HOME, purgeMessages: parsed.flags['purge-messages'] === true })
    if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
    console.log('removed ' + result.accountId + '  credentialRemoved=' + (result.credentialRemoved ? 'yes' : 'no') + ' messagesDeleted=' + result.messagesDeleted)
    return
  }
  usageFail('unknown mail account subcommand: ' + sub, MAIL_USAGE)
}

function mailWatchInterval(value) {
  if (value === undefined) return undefined
  const text = String(value).trim().toLowerCase()
  const match = /^(\d+)(ms|s|m|h)?$/.exec(text)
  if (!match) return null
  const amount = Number(match[1])
  const unit = match[2] ?? 's'
  const ms = unit === 'ms' ? amount : unit === 's' ? amount * 1000 : unit === 'm' ? amount * 60_000 : amount * 3_600_000
  if (ms < 1000 || ms > 24 * 3_600_000) return null
  return ms
}

async function mailSyncCommand(args) {
  const usage = 'usage: advisers mail sync [<account>] [--full] [--dry-run] [--since-days n] [--limit n] [--mailbox INBOX] [--json] [--watch [--interval 300s] [--max-runs n]] [--once] [--json-lines]'
  const parsed = familyFlags(args, { booleans: ['json', 'full', 'dry-run', 'watch', 'once', 'json-lines'], values: ['account', 'since-days', 'limit', 'mailbox', 'interval', 'max-runs'] }, usage)
  if (!parsed) return
  const flags = parsed.flags
  // 0.4.3 (043-1, plan 92 §5): --once is the scriptable alias of --max-runs 1 and
  // --json-lines streams one JSON document per round (summary last). Output modes
  // and loop modes are mutually exclusive; an invalid combination is E_USAGE here,
  // not a surprise after the first round.
  const asJson = flags.json === true
  const asJsonLines = flags['json-lines'] === true
  const watchMode = flags.watch === true || flags.once === true
  if (asJson && asJsonLines) { usageFail('--json and --json-lines are mutually exclusive', usage); return }
  if (flags.watch === true && flags.once === true) { usageFail('--watch and --once are mutually exclusive', usage); return }
  if (!watchMode && (flags.interval !== undefined || flags['max-runs'] !== undefined || asJsonLines)) { usageFail('--interval/--max-runs/--json-lines are only valid with --watch or --once', usage); return }
  if (flags.once === true && (flags.interval !== undefined || flags['max-runs'] !== undefined)) { usageFail('--once does not take --interval/--max-runs', usage); return }
  const intervalMs = mailWatchInterval(flags.interval)
  if (flags.interval !== undefined && intervalMs === null) { usageFail('--interval must be 1s..24h (for example 300s or 5m)', usage); return }
  const maxRuns = flags.once === true ? 1 : (flags['max-runs'] === undefined ? Infinity : familyInteger(flags['max-runs'], '--max-runs', 1, 100000))
  const mail = await loadMail()
  const requested = parsed.positional[0] ?? flags.account
  const sinceDays = flags['since-days'] === undefined ? undefined : familyInteger(flags['since-days'], '--since-days', 1, 3650)
  const limit = flags.limit === undefined ? undefined : familyInteger(flags.limit, '--limit', 1, 200)

  // 0.4.3 (043-1, plan 92 §5): a watching sync validates the account list once,
  // immediately. Before this the empty list only threw inside round(), so
  // --watch printed its startup line and spun one empty round before failing.
  // An explicit account id still reaches the round so the error names that id.
  if (watchMode && !requested) {
    try {
      const probe = familyStore({ write: true })
      try {
        const listed = mail.mailAccountList(probe, { home: HOME })
        const usable = listed.accounts.filter((account) => account.status === 'active' && (account.tls === 'tls' || account.tls === 'starttls'))
        if (!usable.length) throw familyError('E_MAIL_CONFIG', 'no IMAP account is configured', 'add one with advisers mail account add')
      } finally {
        try { probe.close?.() } catch {}
        // openStore() memoizes the singleton; close() without clearing it makes
        // the first watch round reuse a closed handle (latent 0.4.2 --watch bug).
        activeStore = undefined
      }
    } catch (error) {
      reportFamilyFailure(error)
      return
    }
  }

  // One round opens the ledger, syncs every selected account and (in watch mode)
  // closes it again before sleeping: a foreground watch must not hold the writer
  // lock for hours while the operator works in another terminal.
  const round = async ({ closeStore = false } = {}) => {
    const store = familyStore({ write: true })
    try {
      let accounts
      if (requested) accounts = [String(requested)]
      else {
        const listed = mail.mailAccountList(store, { home: HOME })
        accounts = listed.accounts.filter((account) => account.status === 'active' && (account.tls === 'tls' || account.tls === 'starttls')).map((account) => account.id)
        if (!accounts.length) throw familyError('E_MAIL_CONFIG', 'no IMAP account is configured', 'add one with advisers mail account add')
      }
      const results = []
      for (const account of accounts) {
        results.push(await mail.mailSync(store, account, {
          full: flags.full === true,
          dryRun: flags['dry-run'] === true,
          sinceDays,
          limit,
          mailbox: flags.mailbox,
          home: HOME,
        }))
      }
      return requested ? results[0] : { ok: true, command: 'mail sync', results }
    } finally {
      if (closeStore) { try { store.close?.() } catch {} ; activeStore = undefined }
    }
  }

  if (watchMode) {
    const { runMailWatch } = await loadMailWatch()
    const controller = new AbortController()
    let interruptedBy = null
    const onSignal = (name) => () => {
      // A second signal skips the graceful round and exits with the conventional
      // code; the first one lets the in-flight round finish before the summary.
      if (controller.signal.aborted) process.exit(name === 'SIGINT' ? 130 : 143)
      interruptedBy = name
      controller.abort()
    }
    const onSigint = onSignal('SIGINT')
    const onSigterm = onSignal('SIGTERM')
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)
    const perAccountOf = (result) => {
      const rows = Array.isArray(result?.results) ? result.results : (result ? [result] : [])
      return rows.map((row) => ({
        accountId: row?.accountId ?? null,
        mailbox: row?.mailbox ?? null,
        fetched: Number(row?.fetched ?? 0),
        inserted: Number(row?.inserted ?? 0),
        skipped: Number(row?.skipped ?? 0),
        failed: Number(row?.failed ?? 0),
      }))
    }
    const totalsOf = (perAccount) => perAccount.reduce((acc, row) => ({
      fetched: acc.fetched + row.fetched,
      inserted: acc.inserted + row.inserted,
      skipped: acc.skipped + row.skipped,
      failed: acc.failed + row.failed,
    }), { fetched: 0, inserted: 0, skipped: 0, failed: 0 })
    // Human mode gets one startup line (stdout); --json keeps stdout a single
    // JSON document and --json-lines keeps it one JSON document per round.
    if (!asJson && !asJsonLines) {
      console.log('watch: interval=' + Math.round((intervalMs ?? 300000) / 1000) + 's mailbox=' + String(flags.mailbox ?? 'INBOX') + (requested ? ' account=' + String(requested) : ' accounts=all-active') + '; Ctrl+C 在本轮结束后停止')
    }
    try {
      const summary = await runMailWatch({
        syncOnce: () => round({ closeStore: true }),
        intervalMs,
        maxRuns,
        signal: controller.signal,
        onResult: (record) => {
          const perAccount = record.ok ? perAccountOf(record.result) : []
          const totals = totalsOf(perAccount)
          if (asJsonLines) {
            // plan 92 §5: one JSON document per round, summary last. stdout stays
            // line-delimited JSON: no human prose, no ANSI.
            const line = {
              type: 'round',
              run: record.run,
              ok: record.ok,
              startedAt: record.startedAt,
              durationMs: record.durationMs,
              nextDelayMs: record.nextDelayMs,
              perAccount,
            }
            if (!record.ok) line.error = record.error?.message ?? 'unknown'
            console.log(JSON.stringify(line))
            return
          }
          if (asJson) {
            // stdout must stay JSON-parseable: round lines go to stderr.
            if (record.ok) console.error('round ' + record.run + ': fetched=' + totals.fetched + ' inserted=' + totals.inserted + ' skipped=' + totals.skipped + ' failed=' + totals.failed + ' next=' + Math.round(record.nextDelayMs / 1000) + 's')
            else console.error('round ' + record.run + ' failed: ' + (record.error?.message ?? 'unknown') + '; next=' + Math.round(record.nextDelayMs / 1000) + 's')
            return
          }
          if (record.ok) console.error('第 ' + record.run + ' 轮 ' + record.startedAt.slice(11, 19) + ' fetched=' + totals.fetched + ' inserted=' + totals.inserted + ' skipped=' + totals.skipped + ' failed=' + totals.failed + ' 下一轮 ' + Math.round(record.nextDelayMs / 1000) + 's')
          else console.error('第 ' + record.run + ' 轮失败：' + (record.error?.message ?? 'unknown') + '（' + Math.round(record.nextDelayMs / 1000) + 's 后重试）')
        },
      })
      // 0.4.3 exit-code contract (plan 92 §5): 0 = the loop ended after at least
      // one successful round; 1 = runtime error / every round failed; 130 =
      // SIGINT; 143 = SIGTERM. The summary carries interruptedBy additively and
      // keeps stopped compatible (aborted|max-runs).
      let exitCode = 0
      if (interruptedBy) exitCode = interruptedBy === 'SIGINT' ? 130 : 143
      else if (summary.runs === 0 || summary.success === 0) exitCode = 1
      const decorated = { ...summary, interruptedBy }
      if (asJson) console.log(JSON.stringify(decorated, null, 2))
      else if (asJsonLines) console.log(JSON.stringify({ type: 'summary', ...decorated }))
      else console.log('mail watch stopped: ' + summary.stopped + ' runs=' + summary.runs + ' success=' + summary.success + ' errors=' + summary.errors + (interruptedBy ? ' interruptedBy=' + interruptedBy : ''))
      process.exitCode = exitCode
    } finally {
      process.removeListener('SIGINT', onSigint)
      process.removeListener('SIGTERM', onSigterm)
    }
    return
  }

  const payload = await round()
  if (flags.json) { console.log(JSON.stringify(payload, null, 2)); return }
  const results = Array.isArray(payload.results) ? payload.results : [payload]
  for (const result of results) console.log('sync ' + result.accountId + ' ' + result.mailbox + ': fetched=' + result.fetched + ' inserted=' + result.inserted + ' skipped=' + result.skipped + ' failed=' + result.failed + ' duplicates=' + result.duplicates + (result.dryRun ? ' (dry-run)' : '') + (result.needsResync ? ' NEEDS-RESYNC(--full)' : ''))
}

function mailSinceDays(value) {
  if (value === undefined) return undefined
  const text = String(value).trim()
  const match = /^(\d+)d$/.exec(text)
  if (match) return familyInteger(match[1], '--since', 1, 3650)
  return familyInteger(text, '--since', 1, 3650)
}

async function mailLsCommand(args) {
  const usage = 'usage: advisers mail ls [--account a] [--client id] [--status s] [--since 30d] [--limit n] [--json]'
  const parsed = familyFlags(args, { booleans: ['json'], values: ['account', 'client', 'status', 'since', 'limit'] }, usage)
  if (!parsed) return
  const flags = parsed.flags
  const mail = await loadMail()
  const result = mail.mailList(familyStore(), {
    account: flags.account,
    clientId: flags.client,
    status: flags.status,
    sinceDays: mailSinceDays(flags.since),
    limit: flags.limit === undefined ? undefined : familyInteger(flags.limit, '--limit', 1, 500),
  })
  if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  if (!result.messages.length) console.log('（没有邮件）')
  for (const message of result.messages) console.log(mailHumanRow(message))
  console.log('total=' + result.total + ' limit=' + result.limit + (result.truncated ? ' truncated' : ''))
}

async function mailShowCommand(args) {
  const usage = 'usage: advisers mail show <id> [--body] [--json]'
  const parsed = familyFlags(args, { booleans: ['json', 'body'], values: [] }, usage)
  if (!parsed) return
  const ref = parsed.positional[0]
  if (!ref) { usageFail('missing mail message id', usage); return }
  const mail = await loadMail()
  const result = mail.mailShow(familyStore(), ref, { body: parsed.flags.body === true })
  if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  const message = result.message
  console.log(mailHumanRow(message))
  console.log('messageId=' + (message.messageId ?? '-') + ' uid=' + message.uid + ' size=' + (message.sizeBytes ?? '-') + ' retained=' + (message.retained === true ? 'yes' : 'no') + (message.clientId ? ' client=' + message.clientId : ''))
  if (parsed.flags.body === true) {
    console.log('---')
    process.stdout.write(String(message.bodyText ?? '') + '\n')
  }
}

/**
 * Authorization + consent gate for model egress of local content.
 * evaluate/authorize come from lib/policy; the consent record is bound to the
 * surface + data class + provider + base URL. An audit failure fails closed.
 */
async function authorizeModelEgress(surface, dataClass, options = {}) {
  const policy = await loadPolicy()
  const consent = await loadConsent()
  const provider = process.env.ADVISERS_PROVIDER || 'deepseek'
  const baseUrl = process.env.ADVISERS_BASE_URL || 'https://api.deepseek.com'
  const consentFact = consent.consentFacts(HOME, { surface, dataClass, provider, baseUrl })
  let tosFacts = { accepted: true, version: '', currentVersion: '', hashOk: true }
  try {
    const tos = await loadTos()
    const { info } = resolveTosFacts(tos)
    const status = tos.acceptanceStatus({ home: HOME, version: info.version, sha256: info.sha256 })
    tosFacts = { accepted: status.accepted === true, version: String(status.record?.version ?? info.version), currentVersion: info.version, hashOk: status.reason !== 'hash_mismatch' }
  } catch {}
  const audit = (event) => {
    const store = mode === 'sqlite' ? dbStore() : undefined
    if (!store) return { ok: false }
    try {
      store.appendAudit({
        actor: 'policy',
        action: 'policy.' + String(event.surface) + '.' + String(event.policyAction ?? event.action ?? 'unknown'),
        allowed: event.allowed === true,
        reason: [String(event.phase ?? ''), String(event.code ?? event.policyCode ?? '')].filter(Boolean).join(' ').slice(0, 300),
      })
      return { ok: true }
    } catch { return { ok: false } }
  }
  const facts = {
    v: 1,
    surface,
    action: 'model-egress',
    actor: 'cli',
    interactive: Boolean(process.stdin.isTTY),
    record: options && options.record && typeof options.record === 'object' ? options.record : null,
    safety: { action: 'allow' },
    tos: tosFacts,
    consent: consentFact,
    audit: { available: mode === 'sqlite' },
    trust: { tainted: true, sourceKinds: [dataClass] },
    now: new Date().toISOString(),
  }
  const decision = policy.authorize('model-egress', facts, { audit })
  if (decision.authorized !== true) {
    const code = typeof decision.code === 'string' ? decision.code : 'E_POLICY_DENIED'
    const hint = consentFact.granted === true
      ? 'model egress is not allowed for this surface/data class; see advisers privacy --matrix'
      : 'run advisers consent grant ' + surface + ' and read the prompt before sending content to the model provider'
    throw familyError(code, String(decision.reason ?? 'policy denied model egress'), hint)
  }
  // The effect digest authorize() bound is computed from the facts (surface /
  // action / dataClass; the facts carry record=null and no top-level provider),
  // so consumeDecision() must receive exactly that shape or it refuses.
  const effectRecord = options && options.record && typeof options.record === 'object' ? { kind: String(options.record.kind ?? 'record'), secrecy: Number(options.record.secrecy ?? 0) } : null
  return { policy, token: decision.token, effect: { surface, action: 'model-egress', dataClass, ...(effectRecord ? { record: effectRecord } : {}) }, audit }
}

/** Run one authorized model effect, then write its result audit row. */
async function runAuthorizedModelEffect(authorization, effectFn) {
  const { consumeDecision } = await loadPolicy()
  const consumed = consumeDecision(authorization.token, authorization.effect)
  let result
  try {
    result = await effectFn()
  } catch (error) {
    try { authorization.audit({ surface: authorization.effect.surface, policyAction: authorization.effect.action, phase: 'result', allowed: true, decisionId: consumed.decisionId, ok: false, code: typeof error?.code === 'string' ? error.code : 'E_POLICY_EFFECT_FAILED' }) } catch {}
    throw error
  }
  const wrote = authorization.audit({ surface: authorization.effect.surface, policyAction: authorization.effect.action, phase: 'result', allowed: true, decisionId: consumed.decisionId, ok: true })
  if (wrote?.ok !== true) throw familyError('E_POLICY_AUDIT_UNAVAILABLE', 'model extraction completed but its result audit could not be written', 'the effect already happened; run advisers audit and inspect the ledger before continuing')
  return result
}

async function mailExtractCommand(args) {
  const usage = 'usage: advisers mail extract [<id>...] [--all-new] [--local|--model] [--yes] [--matter id] [--limit n] [--dry-run] [--json]'
  const parsed = familyFlags(args, { booleans: ['json', 'local', 'model', 'all-new', 'dry-run', 'yes'], values: ['account', 'matter', 'limit'] }, usage)
  if (!parsed) return
  const flags = parsed.flags
  if (flags.local === true && flags.model === true) { usageFail('--local and --model are mutually exclusive', usage); return }
  const useModel = flags.model === true
  if (useModel && flags.yes !== true) throw familyError('E_MAIL_MODEL_OPT_IN', 'mail extract --model requires an explicit --yes opt-in', 'the default local path is offline; --model sends message text to your configured model provider and needs consent')
  const mail = await loadMail()
  const store = familyStore({ write: true })
  const extractOptions = {
    model: useModel,
    confirmModel: useModel && flags.yes === true,
    apiKey: process.env.ADVISERS_API_KEY,
    modelName: process.env.ADVISERS_MODEL,
    account: flags.account,
    ids: parsed.positional.length ? parsed.positional : undefined,
    all: flags['all-new'] === true,
    matterId: flags.matter,
    limit: flags.limit === undefined ? undefined : familyInteger(flags.limit, '--limit', 1, 500),
    dryRun: flags['dry-run'] === true,
    secrecy: 0,
  }
  let result
  if (useModel) {
    // Protection by matter: model egress is refused for secrecy > 0 (the lib
    // repeats the check; the policy facts also carry the record secrecy).
    let secrecy = 0
    if (flags.matter) {
      const matter = familyStore().getMatter(String(flags.matter))
      if (!matter) throw familyError('E_MATTER_NOT_FOUND', 'unknown matter: ' + flags.matter, 'advisers matter ls')
      secrecy = Number(matter.secrecy ?? 0)
    }
    if (Number.isFinite(secrecy) && secrecy > 0) throw familyError('E_MAIL_MODEL_DISABLED', 'model extraction is disabled for protected matters (secrecy > 0)', 'use the default local extraction or move the mail to an unprotected matter')
    extractOptions.secrecy = secrecy
    const authorization = await authorizeModelEgress('mail.extract', 'mail', { record: { kind: 'mail', secrecy } })
    result = await runAuthorizedModelEffect(authorization, () => mail.mailExtract(store, extractOptions))
  } else {
    result = await mail.mailExtract(store, extractOptions)
  }
  if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  console.log('mail extract (' + result.mode + '): scanned=' + result.scanned + ' candidates=' + result.candidates.length + ' skipped=' + result.skipped + ' failed=' + result.failed + (result.dryRun ? ' (dry-run)' : ''))
  for (const candidate of result.candidates.slice(0, 20)) console.log('  ' + String(candidate.id ?? '(preview)') + '  ' + String(candidate.action ?? candidate.statement ?? candidate.text ?? '').slice(0, 120))
  if (result.safetyWarnings?.length) console.log('  safety warnings: ' + result.safetyWarnings.length)
}

async function mailImportCommand(args) {
  const usage = 'usage: advisers mail import <file|dir> [--limit n] [--dry-run] [--client id] [--project id] [--json]'
  const parsed = familyFlags(args, { booleans: ['json', 'dry-run'], values: ['limit', 'client', 'project', 'account'] }, usage)
  if (!parsed) return
  const target = parsed.positional[0]
  if (!target) { usageFail('missing .eml/.mbox file or directory', usage); return }
  const mail = await loadMail()
  const result = await mail.mailImport(familyStore({ write: parsed.flags['dry-run'] !== true }), {
    path: target,
    accountId: parsed.flags.account,
    clientId: parsed.flags.client,
    projectId: parsed.flags.project,
    limit: parsed.flags.limit === undefined ? undefined : familyInteger(parsed.flags.limit, '--limit', 1, 500),
    dryRun: parsed.flags['dry-run'] === true,
  })
  if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  console.log('mail import: files=' + result.files + ' scanned=' + result.scanned + ' inserted=' + result.inserted + ' skipped=' + result.skipped + ' failed=' + result.failed + (result.dryRun ? ' (dry-run)' : ''))
}

async function mailPurgeCommand(args) {
  const usage = 'usage: advisers mail purge [--older-than 30d] [--dry-run|--yes] [--account a] [--json]'
  const parsed = familyFlags(args, { booleans: ['json', 'dry-run', 'yes'], values: ['older-than', 'account'] }, usage)
  if (!parsed) return
  let olderThanDays
  if (parsed.flags['older-than'] !== undefined) {
    const text = String(parsed.flags['older-than']).trim()
    const match = /^(\d+)d$/.exec(text)
    olderThanDays = familyInteger(match ? match[1] : text, '--older-than', 1, 3650)
  }
  let yes = parsed.flags.yes === true
  const dryRun = parsed.flags['dry-run'] === true || !yes
  if (!dryRun && process.stdin.isTTY && parsed.flags['dry-run'] !== true) {
    yes = await askYesNo(null, '永久清除保留期外的邮件正文（元数据保留）？[y/N] ', false)
    if (!yes) { console.log('已取消。'); return }
  }
  const mail = await loadMail()
  const result = mail.mailPurge(familyStore({ write: yes }), { olderThanDays, account: parsed.flags.account, dryRun: !yes })
  if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  if (result.dryRun) console.log('dry-run: 将清除 ' + result.wouldPurge + ' 封正文（' + formatBytes(result.bytesWouldFree) + '），跳过 ' + result.skippedPending + ' 封有待处理候选；加 --yes 执行')
  else console.log('purged bodies=' + result.messagesPurged + ' bytesFreed=' + formatBytes(result.bytesFreed) + ' skippedPending=' + result.skippedPending)
}

async function mailCommand(rawArgs) {
  const sub = rawArgs[0]
  try {
    if (!sub || sub === 'help' || sub === '--help') { console.log(MAIL_USAGE); return }
    if (sub === 'account') return await mailAccountCommand(rawArgs.slice(1))
    if (sub === 'sync') return await mailSyncCommand(rawArgs.slice(1))
    if (sub === 'ls' || sub === 'list') return await mailLsCommand(rawArgs.slice(1))
    if (sub === 'show') return await mailShowCommand(rawArgs.slice(1))
    if (sub === 'extract') return await mailExtractCommand(rawArgs.slice(1))
    if (sub === 'import') return await mailImportCommand(rawArgs.slice(1))
    if (sub === 'purge') return await mailPurgeCommand(rawArgs.slice(1))
    if (sub === 'link') return await mailLinkCommand(rawArgs.slice(1), false)
    if (sub === 'dismiss') return await mailLinkCommand(rawArgs.slice(1), true)
    usageFail('unknown mail subcommand: ' + sub, MAIL_USAGE)
  } catch (error) { reportFamilyFailure(error) }
}

/** mail link/dismiss: explicit review decisions on one imported message (0.4.x follow-up). */
async function mailLinkCommand(rawArgs, dismiss = false) {
  const usage = dismiss
    ? 'usage: advisers mail dismiss <message> [--json]'
    : 'usage: advisers mail link <message> [--client id] [--project id] [--json]'
  const parsed = familyFlags(rawArgs, { booleans: ['json'], values: ['client', 'project'] }, usage)
  if (!parsed) return
  const ref = parsed.positional[0]
  if (!ref) { usageFail('missing message id', usage); return }
  const mail = await loadMail()
  const store = familyStore({ write: true })
  const result = dismiss
    ? mail.mailDismiss(store, ref, {})
    : mail.mailLink(store, ref, { clientId: parsed.flags.client, projectId: parsed.flags.project })
  if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  const message = result.message
  console.log((dismiss ? 'dismissed ' : 'linked ') + message.id + '  [' + message.status + ']' + (message.clientId ? '  client=' + message.clientId : '') + (message.projectId ? '  project=' + message.projectId : ''))
}

/* ------------------------- receivable / payment ------------------------- */
/* ------------------------- receivable / payment ------------------------- */

const RECEIVABLE_USAGE = [
  'usage: advisers receivable add <client-id> "<label>" --amount 8000.00 [--currency CNY] [--due YYYY-MM-DD|相对日期]',
  '                             [--project id] [--matter id] [--kind quote|milestone|retainer|other] [--memo text]',
  '                             [--remind-offsets "-3d,-1d"] [--no-remind] [--json]',
  '       advisers receivable ls|list [--client id] [--project id] [--status open|partial|overdue|settled|all]',
  '                             [--currency CNY] [--aging] [--due-within 7d|30d] [--clearance 0-3] [--limit n] [--json]',
  '       advisers receivable show <id> [--json]',
  '       advisers receivable edit <id> [--amount 9000.00|--due DATE|相对日期|--memo text|--kind k|--label text] [--json]',
  '       advisers receivable export --out <file.csv|-> [--client id] [--project id] [--currency c]',
  '                             [--status active|unsettled|open|partial|overdue|settled|written_off|all]',
  '                             [--due-within 7d|30d] [--clearance 0-3] [--bom] [--json]',
  '       advisers receivable void <id> [--reason text] [--json]',
].join('\n')

const PAYMENT_USAGE = [
  'usage: advisers payment add <client-id> --amount 4000.00 [--currency CNY] [--paid-at ISO] [--method bank|wechat|alipay|cash|other]',
  '                          [--receivable rcv] [--memo text] [--no-complete] [--json]',
  '       advisers payment ls|list [--client id] [--receivable rcv] [--since 90d|ISO] [--limit n] [--json]',
  '       advisers payment void <id> [--reason text] [--json]',
].join('\n')

function receivableMoney(row) {
  return String(row.amount ?? '') + ' ' + String(row.currency ?? '') + (row.state ? '  ' + row.state : '') + (row.outstanding && row.outstanding !== row.amount ? '  outstanding ' + row.outstanding : '')
}

async function receivableCommand(rawArgs) {
  const sub = rawArgs[0]
  try {
    if (!sub || sub === 'help' || sub === '--help') { console.log(RECEIVABLE_USAGE); return }
    const receivable = await loadReceivablesLib()
    if (sub === 'add') {
      const usage = RECEIVABLE_USAGE
      const parsed = familyFlags(rawArgs.slice(1), { booleans: ['json', 'no-remind'], values: ['amount', 'currency', 'due', 'project', 'matter', 'kind', 'memo', 'remind-offsets'] }, usage)
      if (!parsed) return
      const clientId = parsed.positional[0]
      const label = parsed.positional.slice(1).join(' ').trim()
      if (!clientId || !label) { usageFail('usage: advisers receivable add <client-id> "<label>" --amount 8000.00', usage); return }
      if (parsed.flags.amount === undefined) { usageFail('--amount is required', usage); return }
      // 0.4.3 (043-1): resolve --due at the boundary. The library keeps its
      // date-only = end-of-that-day (+08:00) semantics, so a relative expression
      // passes the resolved calendar day and a date-time ISO passes through.
      let dueAt
      if (parsed.flags.due !== undefined) {
        const resolved = await resolveDueFlag(parsed.flags.due)
        if (!resolved.ok) { reportDueFailure(resolved, parsed.flags.json === true); return }
        dueAt = resolved.basis === 'iso' ? resolved.at : resolved.calendar
        const resolutionLine = dueResolutionLine(resolved)
        if (resolutionLine) console.error(sanitizeConsoleText(resolutionLine, { max: 500 }))
      }
      const result = receivable.receivableAdd(familyStore({ write: true }), {
        clientId,
        label,
        amount: parsed.flags.amount,
        currency: parsed.flags.currency,
        dueAt,
        projectId: parsed.flags.project,
        matterId: parsed.flags.matter,
        kind: parsed.flags.kind,
        memo: parsed.flags.memo,
        reminderOffsets: parsed.flags['remind-offsets'],
        noRemind: parsed.flags['no-remind'] === true,
      })
      if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      const row = result.receivable
      console.log('added ' + (row ? row.id : '(hidden)') + '  ' + label + '  ' + (row ? receivableMoney(row) : '') + (row && row.dueAt ? '  due ' + row.dueAt : ''))
      console.log('follow-up commitment: ' + result.commitment.id)
      return
    }
    if (sub === 'ls' || sub === 'list') {
      const usage = RECEIVABLE_USAGE
      const parsed = familyFlags(rawArgs.slice(1), { booleans: ['json', 'aging'], values: ['client', 'project', 'status', 'currency', 'due-within', 'clearance', 'limit'] }, usage)
      if (!parsed) return
      const flags = parsed.flags
      const store = familyStore()
      const options = {
        clientId: flags.client,
        projectId: flags.project,
        status: flags.status,
        currency: flags.currency,
        dueWithin: flags['due-within'],
        clearance: flags.clearance === undefined ? undefined : familyInteger(flags.clearance, '--clearance', 0, 3),
        limit: flags.limit === undefined ? undefined : familyInteger(flags.limit, '--limit', 1, 500),
      }
      const result = flags.aging === true ? receivable.receivablesSummary(store, options) : receivable.receivableList(store, options)
      if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      if (flags.aging === true) {
        console.log('unsettled=' + result.unsettled + ' overdue=' + result.overdue + ' settled=' + result.settled + ' writtenOff=' + result.writtenOff)
        for (const total of result.totals) console.log('  ' + total.currency + '  amount=' + receivable.formatMinorAmount(BigInt(total.amountMinor)) + ' paid=' + receivable.formatMinorAmount(BigInt(total.paidMinor)) + ' outstanding=' + receivable.formatMinorAmount(BigInt(total.outstandingMinor)) + ' overdueCount=' + total.overdueCount + ' aging=' + JSON.stringify(total.aging))
        return
      }
      if (!result.receivables.length) console.log('（没有回款记录）')
      for (const row of result.receivables) console.log(row.id + '  ' + String(row.clientName ?? row.clientId) + '  ' + row.label + '  ' + receivableMoney(row) + (row.dueAt ? '  due ' + row.dueAt : ''))
      for (const total of result.totals) console.log('total ' + total.currency + ' outstanding=' + receivable.formatMinorAmount(BigInt(total.outstandingMinor)) + ' overdueCount=' + total.overdueCount)
      console.log('total=' + result.total + ' limit=' + result.limit + (result.truncated ? ' truncated' : '') + (result.protectedExcluded ? ' protectedExcluded=' + result.protectedExcluded : ''))
      return
    }
    if (sub === 'show') {
      const parsed = familyFlags(rawArgs.slice(1), { booleans: ['json'], values: ['clearance'] }, RECEIVABLE_USAGE)
      if (!parsed) return
      const id = parsed.positional[0]
      if (!id) { usageFail('missing receivable id', RECEIVABLE_USAGE); return }
      const result = receivable.receivableShow(familyStore(), id, { clearance: parsed.flags.clearance === undefined ? undefined : familyInteger(parsed.flags.clearance, '--clearance', 0, 3) })
      if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      const row = result.receivable
      console.log(row.id + '  ' + row.label + '  ' + receivableMoney(row) + (row.dueAt ? '  due ' + row.dueAt : '') + (row.overdueDays ? '  overdueDays=' + row.overdueDays : ''))
      console.log('client=' + row.clientId + (row.projectId ? ' project=' + row.projectId : '') + (row.matterId ? ' matter=' + row.matterId : '') + ' commitment=' + row.commitmentId)
      for (const payment of result.payments) console.log('  payment ' + payment.id + '  ' + payment.amount + ' ' + payment.currency + '  ' + payment.paidAt + '  ' + payment.method + (payment.deletedAt ? '  [void]' : ''))
      return
    }
    if (sub === 'edit') {
      const parsed = familyFlags(rawArgs.slice(1), { booleans: ['json', 'no-remind'], values: ['amount', 'due', 'memo', 'kind', 'label', 'remind-offsets'] }, RECEIVABLE_USAGE)
      if (!parsed) return
      const id = parsed.positional[0]
      if (!id) { usageFail('missing receivable id', RECEIVABLE_USAGE); return }
      const patch = {}
      if (parsed.flags.amount !== undefined) patch.amount = parsed.flags.amount
      if (parsed.flags.due !== undefined) {
        const resolved = await resolveDueFlag(parsed.flags.due)
        if (!resolved.ok) { reportDueFailure(resolved, parsed.flags.json === true); return }
        patch.dueAt = resolved.basis === 'iso' ? resolved.at : resolved.calendar
        const resolutionLine = dueResolutionLine(resolved)
        if (resolutionLine) console.error(sanitizeConsoleText(resolutionLine, { max: 500 }))
      }
      if (parsed.flags.memo !== undefined) patch.memo = parsed.flags.memo
      if (parsed.flags.kind !== undefined) patch.kind = parsed.flags.kind
      if (parsed.flags.label !== undefined) patch.label = parsed.flags.label
      if (parsed.flags['no-remind'] === true) patch.noRemind = true
      else if (parsed.flags['remind-offsets'] !== undefined) patch.reminderOffsets = parsed.flags['remind-offsets']
      const result = receivable.receivableEdit(familyStore({ write: true }), id, patch)
      if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      console.log('updated ' + id + (result.receivable ? '  ' + receivableMoney(result.receivable) : ''))
      return
    }
    if (sub === 'export') {
      const parsed = familyFlags(rawArgs.slice(1), { booleans: ['json', 'csv', 'bom'], values: ['client', 'project', 'currency', 'status', 'due-within', 'clearance', 'out', 'profile'] }, RECEIVABLE_USAGE)
      if (!parsed) return
      const flags = parsed.flags
      // 0.4.3 (043-5, plan 93 §5 + 100 §2): the operator names the target file.
      // A default under HOME would turn a read-only query into a silent copy of
      // client names and amounts; --out - writes the CSV to stdout instead.
      if (typeof flags.out !== 'string' || flags.out === '') { usageFail('receivable export requires --out <file.csv|->', RECEIVABLE_USAGE); return }
      if (flags.out === '-' && flags.json === true) { usageFail('--out - and --json are mutually exclusive', RECEIVABLE_USAGE); return }
      const { exportReceivablesCsv } = await loadReceivableCsv()
      const result = exportReceivablesCsv(familyStore(), {
        clientId: flags.client,
        projectId: flags.project,
        currency: flags.currency,
        status: flags.status,
        dueWithin: flags['due-within'],
        clearance: flags.clearance === undefined ? undefined : familyInteger(flags.clearance, '--clearance', 0, 3),
        profile: flags.profile,
        bom: flags.bom === true,
      })
      if (flags.out === '-') { process.stdout.write(result.csv); return }
      const out = isAbsolute(flags.out) ? flags.out : join(process.cwd(), flags.out)
      try {
        mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
        atomicWriteFileSync(out, result.csv, { mode: 0o600 })
      } catch (error) {
        console.error('advisers: E_IO: cannot write ' + out + ': ' + (error?.message ?? error))
        process.exitCode = 1
        return
      }
      if (flags.json) {
        // Metadata only: no client names, no amounts, no CSV body (plan 93 §5).
        console.log(JSON.stringify({
          ok: true,
          command: 'receivable export',
          csvVersion: result.csvVersion,
          profile: result.profile,
          bom: result.bom,
          out,
          bytes: result.bytes,
          rowCount: result.rowCount,
          total: result.total,
          clearance: result.clearance,
          protectedExcluded: result.protectedExcluded,
        }, null, 2))
        return
      }
      if (result.protectedExcluded) console.error(sanitizeConsoleText('已按 clearance 过滤 ' + result.protectedExcluded + ' 条受保护记录', { max: 200 }))
      console.error(sanitizeConsoleText('含客户名与金额，按客户数据保管；本 CSV 不是发票/对账单', { max: 200 }))
      console.log('csv written: ' + out + ' (' + result.rowCount + ' rows)')
      return
    }
    if (sub === 'void') {
      const parsed = familyFlags(rawArgs.slice(1), { booleans: ['json'], values: ['reason'] }, RECEIVABLE_USAGE)
      if (!parsed) return
      const id = parsed.positional[0]
      if (!id) { usageFail('missing receivable id', RECEIVABLE_USAGE); return }
      const result = receivable.receivableVoid(familyStore({ write: true }), id, { reason: parsed.flags.reason })
      if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      console.log('void ' + id + (result.alreadyVoid ? ' (already void)' : '') + '  commitmentReopened=' + (result.reopenedCommitment ? 'yes' : 'no') + ' commitmentDropped=' + (result.droppedCommitment ? 'yes' : 'no'))
      return
    }
    usageFail('unknown receivable subcommand: ' + sub, RECEIVABLE_USAGE)
  } catch (error) { reportFamilyFailure(error) }
}

async function paymentCommand(rawArgs) {
  const sub = rawArgs[0]
  try {
    if (!sub || sub === 'help' || sub === '--help') { console.log(PAYMENT_USAGE); return }
    const money = await loadReceivablesLib()
    if (sub === 'add') {
      const parsed = familyFlags(rawArgs.slice(1), { booleans: ['json', 'no-complete'], values: ['amount', 'currency', 'paid-at', 'method', 'receivable', 'commitment', 'memo'] }, PAYMENT_USAGE)
      if (!parsed) return
      const clientId = parsed.positional[0]
      if (!clientId) { usageFail('usage: advisers payment add <client-id> --amount 4000.00', PAYMENT_USAGE); return }
      if (parsed.flags.amount === undefined) { usageFail('--amount is required', PAYMENT_USAGE); return }
      const result = money.paymentAdd(familyStore({ write: true }), {
        clientId,
        amount: parsed.flags.amount,
        currency: parsed.flags.currency,
        paidAt: parsed.flags['paid-at'],
        method: parsed.flags.method,
        receivableId: parsed.flags.receivable,
        commitmentId: parsed.flags.commitment,
        memo: parsed.flags.memo,
        noComplete: parsed.flags['no-complete'] === true,
      })
      if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      console.log('added ' + result.payment.id + '  ' + result.payment.amount + ' ' + result.payment.currency + '  ' + result.payment.paidAt + '  ' + result.payment.method + (result.receivable ? '  receivable=' + result.receivable.id : '') + (result.completedCommitment ? '  commitmentCompleted=yes' : ''))
      return
    }
    if (sub === 'ls' || sub === 'list') {
      const parsed = familyFlags(rawArgs.slice(1), { booleans: ['json'], values: ['client', 'receivable', 'since', 'limit', 'clearance'] }, PAYMENT_USAGE)
      if (!parsed) return
      const result = money.paymentList(familyStore(), {
        clientId: parsed.flags.client,
        receivableId: parsed.flags.receivable,
        since: parsed.flags.since,
        clearance: parsed.flags.clearance === undefined ? undefined : familyInteger(parsed.flags.clearance, '--clearance', 0, 3),
        limit: parsed.flags.limit === undefined ? undefined : familyInteger(parsed.flags.limit, '--limit', 1, 500),
      })
      if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      if (!result.payments.length) console.log('（没有收款记录）')
      for (const payment of result.payments) console.log(payment.id + '  ' + payment.amount + ' ' + payment.currency + '  ' + payment.paidAt + '  ' + payment.method + (payment.receivableId ? '  rcv=' + payment.receivableId : ''))
      console.log('total=' + result.total + ' limit=' + result.limit + (result.truncated ? ' truncated' : ''))
      return
    }
    if (sub === 'void') {
      const parsed = familyFlags(rawArgs.slice(1), { booleans: ['json'], values: ['reason'] }, PAYMENT_USAGE)
      if (!parsed) return
      const id = parsed.positional[0]
      if (!id) { usageFail('missing payment id', PAYMENT_USAGE); return }
      const result = money.paymentVoid(familyStore({ write: true }), id, { reason: parsed.flags.reason })
      if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      console.log('void ' + id + (result.alreadyVoid ? ' (already void)' : '') + '  commitmentReopened=' + (result.reopenedCommitment ? 'yes' : 'no'))
      return
    }
    usageFail('unknown payment subcommand: ' + sub, PAYMENT_USAGE)
  } catch (error) { reportFamilyFailure(error) }
}

/* ------------------------------- consent -------------------------------- */

const CONSENT_USAGE = [
  'usage: advisers consent status [--json]',
  '       advisers consent grant <surface> [--data-class mail|kb] [--provider deepseek] [--base-url URL] [--yes] [--json]',
  '       advisers consent revoke <surface> [--data-class mail|kb] [--provider p] [--base-url URL] [--yes] [--json]',
].join('\n')

function consentDataClassFor(surface, explicit) {
  if (explicit !== undefined) return String(explicit)
  const table = { 'mail.extract': 'mail', 'mail.sync': 'mail', 'kb.ask': 'kb', 'kb.ingest': 'kb', 'kb.search': 'kb' }
  return table[surface] ?? undefined
}

async function consentCommand(rawArgs) {
  const sub = rawArgs[0]
  try {
    if (!sub || sub === 'help' || sub === '--help') { console.log(CONSENT_USAGE); return }
    const consent = await loadConsent()
    if (sub === 'status') {
      const parsed = familyFlags(rawArgs.slice(1), { booleans: ['json'], values: [] }, CONSENT_USAGE)
      if (!parsed) return
      const entries = consent.listConsents(HOME)
      const payload = { ok: true, command: 'consent status', path: consent.consentPath(HOME), configured: entries.length > 0, entries }
      if (parsed.flags.json) { console.log(JSON.stringify(payload, null, 2)); return }
      console.log('consent file: ' + payload.path + (payload.configured ? '' : '（尚未记录任何同意）'))
      if (!entries.length) console.log('（没有同意的数据外发）')
      for (const entry of entries) console.log(entry.surface + '  ' + entry.dataClass + '  ' + entry.provider + (entry.baseUrl ? '  ' + entry.baseUrl : '') + '  ' + (entry.active ? 'granted ' + entry.grantedAt : 'revoked ' + entry.revokedAt))
      return
    }
    if (sub === 'grant' || sub === 'revoke') {
      const parsed = familyFlags(rawArgs.slice(1), { booleans: ['json', 'yes'], values: ['data-class', 'provider', 'base-url', 'consent'] }, CONSENT_USAGE)
      if (!parsed) return
      const surface = parsed.positional[0]
      if (!surface) { usageFail('missing surface (for example mail.extract)', CONSENT_USAGE); return }
      const dataClass = consentDataClassFor(surface, parsed.flags['data-class'])
      if (!dataClass) throw familyError('E_POLICY_INVALID_FACTS', 'unknown consent data class for ' + surface, 'pass --data-class mail or --data-class kb')
      const provider = typeof parsed.flags.provider === 'string' ? parsed.flags.provider : (process.env.ADVISERS_PROVIDER || 'deepseek')
      const baseUrl = typeof parsed.flags['base-url'] === 'string' ? parsed.flags['base-url'] : (process.env.ADVISERS_BASE_URL || 'https://api.deepseek.com')
      const isTTY = Boolean(process.stdin.isTTY)
      const envOverride = process.env['ADVISERS_CONSENT_' + surface.toUpperCase().replace(/[^A-Z0-9]/g, '_')] === '1'
      const explicit = parsed.flags.yes === true || parsed.flags.consent !== undefined || envOverride
      if (sub === 'grant') {
        if (!isTTY && !explicit) throw familyError('E_CONSENT_CONFIRMATION_UNAVAILABLE', 'non-interactive consent grant requires an explicit --yes (or ADVISERS_CONSENT_<SURFACE>=1)', 'read advisers tos show and docs/PRIVACY.md first; this is a separate model-egress consent')
        if (isTTY && !explicit) {
          const answer = await askYesNo(null, '同意把 ' + dataClass + ' 内容发送给模型服务 ' + provider + (baseUrl ? ' (' + baseUrl + ')' : '') + '（' + surface + '）？[y/N] ', false)
          if (!answer) { console.log('已取消，未写入同意记录。'); return }
        }
      } else {
        if (!isTTY && !explicit) throw familyError('E_CONSENT_CONFIRMATION_UNAVAILABLE', 'non-interactive consent revoke requires an explicit --yes', 'run in a terminal to confirm the revocation')
        if (isTTY && !explicit) {
          const answer = await askYesNo(null, '撤回 ' + surface + ' 的同意？[y/N] ', false)
          if (!answer) { console.log('已取消。'); return }
        }
      }
      const audit = (event) => {
        const store = mode === 'sqlite' ? dbStore() : undefined
        if (!store) return { ok: false }
        try { store.appendAudit({ actor: 'local', action: event.action, allowed: event.ok === true, reason: String(event.surface) + ' ' + String(event.dataClass ?? '') }); return { ok: true } } catch { return { ok: false } }
      }
      const channel = isTTY ? 'tty' : 'flag'
      const result = sub === 'grant'
        ? consent.grantConsent(HOME, { surface, dataClass, provider, baseUrl, channel, audit })
        : consent.revokeConsent(HOME, { surface, dataClass, provider, baseUrl, audit })
      const payload = { ok: true, command: 'consent ' + sub, ...result, auditWritten: result.auditWritten === true }
      if (parsed.flags.json) { console.log(JSON.stringify(payload, null, 2)); return }
      if (sub === 'grant') console.log('granted ' + surface + ' / ' + dataClass + ' / ' + provider + ' (channel=' + channel + ')')
      else console.log('revoked ' + result.revoked + ' consent entr' + (result.revoked === 1 ? 'y' : 'ies') + ' for ' + surface)
      return
    }
    usageFail('unknown consent subcommand: ' + sub, CONSENT_USAGE)
  } catch (error) { reportFamilyFailure(error) }
}

function ls() {
  const matters = loadReadLedger({ matters: {} }).listMatters()
  if (!matters.length) {
    console.log('no matters yet')
    return
  }
  for (const m of matters) {
    console.log(`${m.id}\t${m.status}\tsecrecy=${m.secrecy}\t${m.title}`)
  }
}

function why(id) {
  if (!id) {
    console.error('usage: advisers why <pref-id|fact-id>')
    process.exitCode = 1
    return
  }
  if (id.startsWith('fact_')) {
    const ledger = loadReadLedger({ facts: {} })
    const fact = ledger.listFacts(undefined, true).find((f) => f.id === id)
    if (!fact) { console.error(`unknown fact: ${id}`); process.exitCode = 1; return }
    console.log(`${fact.id} [${fact.authority}] ${fact.subject} ${fact.predicate} ${fact.object}`)
    console.log(`status: ${fact.status}; confidence: ${fact.confidence}`)
    for (const e of fact.evidence ?? []) console.log(`evidence: ${e.ref ?? '-'} 「${e.quote ?? ''}」`)
    return
  }
  const pref = loadReadLedger({ preferences: {} }).findPreference(id)
  if (!pref) {
    console.error(`unknown preference: ${id}`)
    process.exitCode = 1
    return
  }
  console.log(`${pref.id} [${pref.kind}/${pref.priority}] ${pref.statement}`)
  console.log(`scope: ${pref.scope.level}${pref.scope.value ? ':' + pref.scope.value : ''}`)
  console.log(`source: ${pref.source.type}${pref.source.quote ? ' — ' + pref.source.quote : ''}`)
  console.log(`confidence: ${pref.confidence}; status: ${pref.status}`)
}

/**
 * `advisers forget <id>` — soft delete (fact tombstone / preference deprecated).
 *
 * 0.2.3 §3.3.8: one targeted UPDATE, no full load/save and (as in 0.2.2) no audit
 * row. An unknown id writes nothing and keeps the "unknown <kind>: <id>" text.
 */
function forget(id) {
  if (!id) {
    console.error('usage: advisers forget <pref-id>')
    process.exitCode = 1
    return
  }
  const kind = id.startsWith('fact_') ? 'fact' : 'preference'
  if (mode === 'json') {
    const ledger = loadJson()
    const ok = ledger.forget(kind, id)
    saveJson(ledger)
    console.log(ok ? `forgotten: ${id}` : `unknown ${kind}: ${id}`)
    if (!ok) process.exitCode = 1
    return
  }
  try {
    const { result: ok } = mutateWithAudit((store) => {
      if (kind === 'fact') {
        if (!store.getFact(id)) return false
        store.updateFact(id, { status: 'deleted', deletedAt: now() })
        return true
      }
      if (!store.getPreference(id)) return false
      store.updatePreference(id, { status: 'deprecated' })
      return true
    }, null)
    console.log(ok ? `forgotten: ${id}` : `unknown ${kind}: ${id}`)
    if (!ok) process.exitCode = 1
  } catch (error) { reportCommandFailure(error) }
}

async function exportLedger(all = false, options = {}) {
  // 0.2.3 §4.3: exporting to stdout is a pure read (lock-free, one read
  // transaction). --out additionally appends an audit row, so that variant keeps
  // the writer lock; the legacy JSON store keeps the in-memory path.
  const writesAudit = Boolean(options.out)
  let ledger
  let store = null
  if (mode === 'json') {
    ledger = loadJson().toJSON()
  } else if (writesAudit) {
    store = dbStore()
    ledger = loadLedger().toJSON()
  } else {
    store = readStoreOrExit()
    ledger = store.read(() => store.load())
  }
  // 0.3.0 P0-L2: `export --all` carries a top-level audit anchor so an exported
  // snapshot can be compared against the live audit tail later. The anchor is a
  // local HMAC checkpoint (never third-party attestation) and is built from the
  // same read snapshot the export uses.
  let builtAnchor = null
  if (all && mode !== 'json' && store) {
    try {
      const anchorLib = await loadAuditAnchor()
      builtAnchor = anchorLib.buildAuditAnchorForStore({ store, home: HOME, generator: `advisers/${VERSION}` })
      if (!builtAnchor.ok) {
        const detail = (builtAnchor.errors ?? []).join('; ')
        if (options.out) console.error(`warning: audit anchor unavailable for this export (${builtAnchor.code ?? 'unknown'}): ${detail}`)
      }
    } catch (error) {
      if (options.out) console.error(`warning: audit anchor unavailable for this export: ${error?.message ?? error}`)
    }
  }
  const payload = all ? (() => {
    // 0.3.0: DATA_TABLES is the single, store-owned list (the v21 customer
    // tables included). Do not hand-maintain a second list here: a table that
    // was missing from this list used to be invisible until an import dropped
    // it, which is exactly the "export succeeds, import loses data" bug.
    const data = store && typeof store.exportDataTables === 'function'
      ? store.exportDataTables()
      : Object.fromEntries(DATA_TABLES.map((table) => [table, []]))
    return {
      version: VERSION,
      // Additive 0.3.0: physical schema of the source database. import --replace
      // refuses an export written by a newer CLI (fail closed) instead of
      // dropping columns it does not understand; legacy exports omit the key.
      ...(store ? { schemaVersion: store.schemaVersion() } : {}),
      exportedAt: now(),
      ledger,
      data,
      auditAnchor: builtAnchor?.ok ? builtAnchor.anchor : null,
    }
  })() : ledger
  let text = JSON.stringify(payload, null, 2)
  if (options.encrypted) {
    const passphrase = process.env.ADVISERS_EXPORT_PASSPHRASE
    if (!passphrase) { console.error('export --encrypted requires ADVISERS_EXPORT_PASSPHRASE (min 8 chars)'); process.exitCode = 1; return }
    const { encryptJson } = await loadVault()
    text = JSON.stringify(encryptJson(payload, passphrase), null, 2)
  }
  if (options.out) {
    ensureHome()
    // 0.2.3 Wave 1: staged durable write (short-write loop + fsync + atomic
    // rename) so an ENOSPC export can never leave a truncated ledger file.
    try {
      atomicWriteFileSync(options.out, text + '\n', { mode: 0o600 })
    } catch (error) {
      console.error(`export failed: ${describeFsError(error, { action: 'writing the export to', target: options.out })}`)
      process.exitCode = 1
      return
    }
    store?.appendAudit({ actor: 'local', action: options.encrypted ? 'export.encrypted' : 'export', allowed: true, reason: basename(options.out) })
    // Refresh $ADVISERS_HOME/audit-anchor.json after the extra audit row (P0-L2).
    if (all && mode !== 'json' && store) {
      try {
        const anchorLib = await loadAuditAnchor()
        const written = anchorLib.writeAuditAnchor({ home: HOME, store, generator: `advisers/${VERSION}` })
        if (!written.ok) console.error(`warning: could not refresh the audit anchor (${written.code ?? 'unknown'})`)
      } catch (error) { console.error(`warning: could not refresh the audit anchor: ${error?.message ?? error}`) }
    }
    console.log(`wrote ${options.out}${options.encrypted ? ' (AES-256-GCM)' : ''}${all && builtAnchor?.ok ? ' + audit anchor' : ''}`)
  } else {
    console.log(text)
    // `export --all` also refreshes the local anchor baseline (stdout stays pure
    // JSON); a failure is reported only for the file variant above.
    if (all && builtAnchor?.ok) {
      try {
        const anchorLib = await loadAuditAnchor()
        anchorLib.writeAuditAnchor({ home: HOME, head: builtAnchor.head, generator: `advisers/${VERSION}` })
      } catch {}
    }
  }
}

/* ---------------------------------------------------------------------------
 * 0.3.0 import --replace parity for the SQLite-only customer tables.
 *
 * export --all carries clients/projects/client_notes; import restores them in
 * the SAME transaction as the ledger, so a failed import changes nothing. The
 * matter ownership (which already travels in the wire snapshot) and the restored
 * entities are validated against each other, and any delivery lineage snapshot
 * that would dangle is re-pointed or cleared and counted. The audit table is
 * deliberately NOT replaced: the local hash chain is signed with this HOME's
 * audit key, so importing another HOME's rows would fail verification.
 * ------------------------------------------------------------------------- */
const CUSTOMER_IMPORT_TABLES = ['clients', 'projects', 'client_notes']
const CUSTOMER_IMPORT_MAX_ROWS = 20000

function importDataError(message) {
  return customerError('E_JSON_INVALID', message)
}

/** Validate the shape of payload.data before any write happens. */
function prepareCustomerImport(payloadData) {
  if (!payloadData || typeof payloadData !== 'object' || Array.isArray(payloadData)) return null
  const present = CUSTOMER_IMPORT_TABLES.filter((table) => Object.prototype.hasOwnProperty.call(payloadData, table))
  if (!present.length) return null
  const tables = {}
  for (const table of CUSTOMER_IMPORT_TABLES) {
    const rows = Object.prototype.hasOwnProperty.call(payloadData, table) ? payloadData[table] : []
    if (!Array.isArray(rows)) throw importDataError('import data.' + table + ' must be an array')
    if (rows.length > CUSTOMER_IMPORT_MAX_ROWS) throw importDataError('import data.' + table + ' has too many rows (max ' + CUSTOMER_IMPORT_MAX_ROWS + ')')
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw importDataError('import data.' + table + '[' + index + '] must be an object')
    }
    tables[table] = rows
  }
  return tables
}

/** Column metadata of one table (the table name comes from a fixed list). */
function customerTableColumns(store, table) {
  return store.db.prepare('PRAGMA table_info(' + table + ')').all().map((row) => ({
    name: row.name,
    notnull: Number(row.notnull) === 1,
    hasDefault: row.dflt_value !== null,
    pk: Number(row.pk) > 0,
  }))
}

/** Wholesale replace one customer table: strict container, no unknown columns. */
function replaceCustomerTable(store, table, rows) {
  const columns = customerTableColumns(store, table)
  const allowed = new Map(columns.map((column) => [column.name, column]))
  const required = columns.filter((column) => column.notnull && !column.hasDefault && !column.pk).map((column) => column.name)
  store.db.prepare('DELETE FROM ' + table).run()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const names = []
    for (const name of Object.keys(row)) {
      if (!allowed.has(name)) throw importDataError('import data.' + table + '[' + index + '] has unknown column ' + name)
      names.push(name)
    }
    for (const name of required) {
      if (!Object.prototype.hasOwnProperty.call(row, name)) throw importDataError('import data.' + table + '[' + index + '] is missing column ' + name)
    }
    if (!names.length) throw importDataError('import data.' + table + '[' + index + '] has no columns')
    store.db.prepare('INSERT INTO ' + table + ' (' + names.join(',') + ') VALUES (' + names.map(() => '?').join(',') + ')')
      .run(...names.map((name) => row[name] === undefined ? null : row[name]))
  }
  return rows.length
}

/**
 * Restore the customer tables and keep the database referentially coherent.
 * Runs INSIDE the import transaction: any throw rolls the ledger + tables back.
 */
function applyCustomerImport(store, tables) {
  const clientCount = replaceCustomerTable(store, 'clients', tables.clients)
  const projectCount = replaceCustomerTable(store, 'projects', tables.projects)
  const noteCount = replaceCustomerTable(store, 'client_notes', tables.client_notes)
  const clientRows = new Map(store.db.prepare('SELECT id FROM clients').all().map((row) => [row.id, true]))
  const projectRows = new Map(store.db.prepare('SELECT id, client_id FROM projects').all().map((row) => [row.id, row]))
  const matterRows = new Map(store.db.prepare('SELECT id, client_id, project_id FROM matters').all().map((row) => [row.id, row]))
  for (const project of projectRows.values()) {
    if (!clientRows.has(project.client_id)) throw importDataError('import data.projects references a missing client: ' + String(project.client_id))
  }
  for (const matter of matterRows.values()) {
    if (matter.client_id !== null && matter.client_id !== undefined && !clientRows.has(matter.client_id)) {
      throw importDataError('import ledger matter ' + matter.id + ' references a missing client')
    }
    if (matter.project_id !== null && matter.project_id !== undefined) {
      const project = projectRows.get(matter.project_id)
      if (!project) throw importDataError('import ledger matter ' + matter.id + ' references a missing project')
      if (matter.client_id === null || matter.client_id === undefined || project.client_id !== matter.client_id) {
        throw importDataError('import ledger matter ' + matter.id + ' belongs to a project of another client')
      }
    }
  }
  for (const note of store.db.prepare('SELECT id, client_id, project_id, matter_id FROM client_notes').all()) {
    if (!clientRows.has(note.client_id)) throw importDataError('import data.client_notes references a missing client')
    if (note.project_id !== null && note.project_id !== undefined) {
      const project = projectRows.get(note.project_id)
      if (!project || project.client_id !== note.client_id) throw importDataError('import data.client_notes references a project of another client')
    }
    if (note.matter_id !== null && note.matter_id !== undefined) {
      const matter = matterRows.get(note.matter_id)
      if (!matter) throw importDataError('import data.client_notes references a missing matter')
      if (matter.client_id !== null && matter.client_id !== undefined && matter.client_id !== note.client_id) {
        throw importDataError('import data.client_notes references a matter of another client')
      }
    }
  }
  // Delivery lineage snapshots may point at entities this HOME never had:
  // re-point when a project/matter still resolves, otherwise clear the snapshot
  // (never keep a dangling id) and report the reconciled row count.
  let reconciledDeliveries = 0
  for (const delivery of store.db.prepare('SELECT id, client_id, project_id, matter_id FROM deliveries').all()) {
    let clientId = delivery.client_id ?? null
    let projectId = delivery.project_id ?? null
    const before = String(clientId) + ':' + String(projectId)
    if (projectId !== null) {
      const project = projectRows.get(projectId)
      if (!project) { clientId = null; projectId = null }
      else clientId = project.client_id
    } else if (clientId !== null && !clientRows.has(clientId)) {
      clientId = null
    }
    if (projectId === null && clientId === null && delivery.matter_id !== null && delivery.matter_id !== undefined) {
      const matter = matterRows.get(delivery.matter_id)
      if (matter && matter.client_id !== null && matter.client_id !== undefined && clientRows.has(matter.client_id)) {
        clientId = matter.client_id
        const project = matter.project_id === null || matter.project_id === undefined ? undefined : projectRows.get(matter.project_id)
        if (project && project.client_id === clientId) projectId = project.id
      }
    }
    if (before !== String(clientId) + ':' + String(projectId)) {
      store.db.prepare('UPDATE deliveries SET client_id = ?, project_id = ? WHERE id = ?').run(clientId, projectId, delivery.id)
      reconciledDeliveries += 1
    }
  }
  return { clients: clientCount, projects: projectCount, clientNotes: noteCount, reconciledDeliveries: reconciledDeliveries }
}


/* ---------------------------------------------------------------------------
 * 0.4.0 (task-29): export --all / import --replace symmetry.
 *
 * export --all writes DATA_TABLES (KB, mail, money included). import --replace
 * validates and restores the same table list in ONE transaction: the ledger via
 * saveWithAudit, the customer tables through the 0.3.2 reference checks, and the
 * derived/auxiliary tables (sessions/turns/deliveries/audit/KB/mail/money).
 * Derived FTS tables and mail_cursors are never imported; kb_pages is dropped
 * because its inputs changed.
 * ------------------------------------------------------------------------- */
const MONEY_IMPORT_TABLES = ['receivables', 'payments']
// mail_cursors: server-side IMAP cursors are meaningless on another machine.
// audit: the hash chain is keyed by THIS home's audit.key, so importing another
// home's rows would report a broken chain; the local chain is preserved and the
// import keeps appending to it.
const IMPORT_TABLE_DENYLIST = new Set(['mail_cursors', 'audit'])
const IMPORT_TABLES = DATA_TABLES.filter((table) => !IMPORT_TABLE_DENYLIST.has(table))

/** Validate the shape of payload.data before any write happens (all DATA_TABLES). */
function prepareDataImport(payloadData) {
  if (!payloadData || typeof payloadData !== 'object' || Array.isArray(payloadData)) return null
  const present = IMPORT_TABLES.filter((table) => Object.prototype.hasOwnProperty.call(payloadData, table))
  if (!present.length) return null
  const tables = {}
  for (const table of IMPORT_TABLES) {
    if (!Object.prototype.hasOwnProperty.call(payloadData, table)) {
      // A pre-0.4 export has no money tables: clear them so old commitments are
      // never left with dangling money rows. Other absent tables are left as-is.
      tables[table] = MONEY_IMPORT_TABLES.includes(table) ? [] : null
      continue
    }
    const rows = payloadData[table]
    if (!Array.isArray(rows)) throw importDataError('import data.' + table + ' must be an array')
    if (rows.length > CUSTOMER_IMPORT_MAX_ROWS) throw importDataError('import data.' + table + ' has too many rows (max ' + CUSTOMER_IMPORT_MAX_ROWS + ')')
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw importDataError('import data.' + table + '[' + index + '] must be an object')
    }
    tables[table] = rows
  }
  return tables
}

/**
 * Restore every exported DATA_TABLES entry inside the import transaction.
 * Throws importDataError on a dangling reference; the caller's transaction rolls
 * back and the pre-import backup stays as the recovery copy.
 */
function applyDataImport(store, tables) {
  const report = { tables: {}, customer: null, cleared: [], kbReconciled: 0, kbPagesCleared: 0 }
  const customerPresent = CUSTOMER_IMPORT_TABLES.some((table) => Array.isArray(tables[table]))
  if (customerPresent) {
    report.customer = applyCustomerImport(store, {
      clients: Array.isArray(tables.clients) ? tables.clients : [],
      projects: Array.isArray(tables.projects) ? tables.projects : [],
      client_notes: Array.isArray(tables.client_notes) ? tables.client_notes : [],
    })
    report.tables.clients = report.customer.clients
    report.tables.projects = report.customer.projects
    report.tables.client_notes = report.customer.clientNotes
  }
  const restored = (table) => !CUSTOMER_IMPORT_TABLES.includes(table)
  for (const table of IMPORT_TABLES) {
    if (!restored(table)) continue
    const rows = tables[table]
    if (rows === null || rows === undefined) continue
    report.tables[table] = replaceCustomerTable(store, table, rows)
  }
  // KB: chunks must point at a restored document; entity ids are reconciled to
  // NULL (KB is derived data, never a reason to reject the whole import).
  if (tables.kb_documents !== null || tables.kb_chunks !== null || tables.kb_fact_links !== null) {
    const docIds = new Set(store.db.prepare('SELECT id FROM kb_documents').all().map((row) => row.id))
    for (const chunk of store.db.prepare('SELECT id, doc_id FROM kb_chunks').all()) {
      if (!docIds.has(chunk.doc_id)) throw importDataError('import data.kb_chunks references a missing document: ' + String(chunk.doc_id))
    }
    const clientIds = new Set(store.db.prepare('SELECT id FROM clients').all().map((row) => row.id))
    const projectIds = new Set(store.db.prepare('SELECT id FROM projects').all().map((row) => row.id))
    const matterIds = new Set(store.db.prepare('SELECT id FROM matters').all().map((row) => row.id))
    for (const doc of store.db.prepare('SELECT id, client_id, project_id, matter_id FROM kb_documents').all()) {
      const nextClient = doc.client_id !== null && clientIds.has(doc.client_id) ? doc.client_id : null
      const nextProject = doc.project_id !== null && projectIds.has(doc.project_id) ? doc.project_id : null
      const nextMatter = doc.matter_id !== null && matterIds.has(doc.matter_id) ? doc.matter_id : null
      if (nextClient !== doc.client_id || nextProject !== doc.project_id || nextMatter !== doc.matter_id) {
        store.db.prepare('UPDATE kb_documents SET client_id = ?, project_id = ?, matter_id = ? WHERE id = ?').run(nextClient, nextProject, nextMatter, doc.id)
        report.kbReconciled += 1
      }
    }
    for (const link of store.db.prepare('SELECT fact_id, doc_id FROM kb_fact_links').all()) {
      if (!docIds.has(link.doc_id)) { store.db.prepare('DELETE FROM kb_fact_links WHERE fact_id = ? AND doc_id = ?').run(link.fact_id, link.doc_id); report.kbReconciled += 1 }
    }
    report.kbPagesCleared = Number(store.db.prepare('DELETE FROM kb_pages').run().changes ?? 0)
    try { store.rebuildAllFtsIndexes() } catch {}
  }
  // Money: an import must not leave money rows pointing at missing entities.
  if (tables.receivables !== null || tables.payments !== null) {
    const commitmentIds = new Set(store.db.prepare('SELECT id FROM commitments').all().map((row) => row.id))
    const clientIds = new Set(store.db.prepare('SELECT id FROM clients').all().map((row) => row.id))
    const receivableById = new Map(store.db.prepare('SELECT id, commitment_id, client_id, currency FROM receivables').all().map((row) => [row.id, row]))
    for (const row of receivableById.values()) {
      if (!commitmentIds.has(row.commitment_id)) throw importDataError('import data.receivables references a missing commitment: ' + String(row.commitment_id))
      if (!clientIds.has(row.client_id)) throw importDataError('import data.receivables references a missing client: ' + String(row.client_id))
    }
    for (const payment of store.db.prepare('SELECT id, client_id, commitment_id, currency FROM payments').all()) {
      if (!clientIds.has(payment.client_id)) throw importDataError('import data.payments references a missing client: ' + String(payment.client_id))
      if (payment.commitment_id !== null && !commitmentIds.has(payment.commitment_id)) throw importDataError('import data.payments references a missing commitment: ' + String(payment.commitment_id))
      if (payment.commitment_id !== null) {
        const receivable = [...receivableById.values()].find((row) => row.commitment_id === payment.commitment_id)
        if (receivable && receivable.currency !== payment.currency) throw importDataError('import data.payments currency does not match its receivable: ' + String(payment.id))
      }
    }
  }
  return report
}

async function importLedger(file, { replace = false } = {}) {
  if (!file) { console.error('usage: advisers import <file> [--replace]'); process.exitCode = 1; return }
  if (!replace) { console.error('import replaces the local ledger; pass --replace to confirm'); process.exitCode = 1; return }
  let payload
  try {
    const { isVaultEnvelope, decryptJson } = await loadVault()
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (isVaultEnvelope(raw)) {
      const passphrase = process.env.ADVISERS_EXPORT_PASSPHRASE
      if (!passphrase) { console.error('encrypted import requires ADVISERS_EXPORT_PASSPHRASE'); process.exitCode = 1; return }
      payload = decryptJson(raw, passphrase)
    } else payload = raw
  } catch (error) { console.error(`import failed: ${error.message}`); process.exitCode = 1; return }
  const data = payload?.ledger ?? payload
  if (!data || !Array.isArray(data.matters)) { console.error('import file does not contain an Advisers ledger'); process.exitCode = 1; return }
  // 0.3.0: an export --all records its physical schema version. A newer database
  // must be imported by a newer CLI (same fail-closed rule as E_SCHEMA_NEWER on
  // open); a legacy export without the key is accepted exactly as before.
  if (payload && typeof payload === 'object' && payload.schemaVersion !== undefined) {
    const incomingSchema = payload.schemaVersion
    if (!Number.isInteger(incomingSchema) || incomingSchema < 0) {
      console.error('import failed: E_JSON_INVALID: export schemaVersion must be a non-negative integer')
      process.exitCode = 1
      return
    }
    if (incomingSchema > SCHEMA_VERSION) {
      console.error('import failed: E_SCHEMA_NEWER: the export uses database schema v' + incomingSchema + ' but this CLI expects v' + SCHEMA_VERSION + '; upgrade advisers first. The ledger was NOT replaced.')
      process.exitCode = 1
      return
    }
  }
  // Validate the customer-table payload shape BEFORE any write; the restore
  // itself runs inside the import transaction and rolls back on a bad reference.
  let dataImport = null
  try { dataImport = prepareDataImport(payload?.data) } catch (error) {
    console.error('import failed: ' + error.message)
    process.exitCode = 1
    return
  }
  await requireTosReaccept({ scope: 'import', subject: basename(file), action: 'import --replace' })
  ensureHome()
  // 0.3.0 Wave 3 (plan 26 §4.5/§10.5): --replace is the confirmation, so state
  // the irreversible consequence and the recovery copy BEFORE any write happens.
  const incoming = {
    matters: data.matters.length,
    commitments: Array.isArray(data.commitments) ? data.commitments.length : 0,
    facts: Array.isArray(data.facts) ? data.facts.length : 0,
    preferences: Array.isArray(data.preferences) ? data.preferences.length : 0,
  }
  if (dataImport) {
    // Additive per-table line: the old clients/projects/clientNotes keys stay.
    for (const table of Object.keys(dataImport)) {
      const rows = dataImport[table]
      if (!Array.isArray(rows)) continue
      incoming[table] = rows.length
    }
    incoming.clients = (dataImport.clients ?? []).length
    incoming.projects = (dataImport.projects ?? []).length
    incoming.clientNotes = (dataImport.client_notes ?? []).length
  }
  const importBackupFile = mode === 'sqlite' ? join(HOME, 'import-backup-' + Date.now() + '.db') : null
  console.log('! 需要确认：整库替换本地账本（不是合并）')
  console.log('  写入：' + incoming.matters + ' 个事项 / ' + incoming.commitments + ' 条承诺 / ' + incoming.facts + ' 条事实 / ' + incoming.preferences + ' 条偏好' + (dataImport ? ' / ' + incoming.clients + ' 个客户 / ' + incoming.projects + ' 个项目 / ' + incoming.clientNotes + ' 条客户备注' : ''))
  if (dataImport) {
    const summary = Object.keys(dataImport).filter((table) => Array.isArray(dataImport[table])).map((table) => table + '=' + dataImport[table].length).join(', ')
    console.log('  导出表：' + summary)
  }
  console.log('  备份：' + (importBackupFile ?? '（JSON store：无数据库备份，旧 state.json 会被覆盖）'))
  console.log('  不可撤销：替换后只能用上面的备份恢复；' + (dataImport ? '导出的 DATA_TABLES 按同一事务恢复（派生 FTS 与 mail_cursors 除外），kb_pages 需重新生成。' : '未导入的 SQLite-only 表不会被保留。'))
  // import replaces the ledger wholesale; serialize it with every other store
  // user (P0-1) before copying the pre-import backup and writing.
  ensureInstanceLock()
  try {
    const store = dbStore()
    if (store) {
      // 0.2.3 §3.3.11: fold the WAL into the main database before copying, so the
      // pre-import backup cannot silently miss committed transactions (the old
      // copyFileSync could). A busy checkpoint refuses the import: the ledger is
      // not replaced and the current database stays authoritative.
      const checkpoint = store.checkpoint({ mode: 'TRUNCATE' })
      if (checkpoint.busy) {
        console.error('import failed: database is busy (another advisers process is writing); close it and retry. The ledger was NOT replaced.')
        process.exitCode = 1
        return
      }
      // 0.2.3 Wave 1: the pre-import backup is plaintext data. Copy with retry
      // and fsync it; if the backup cannot be made, refuse to replace the ledger
      // (never proceed without a recovery copy).
      const backupFile = importBackupFile ?? join(HOME, 'import-backup-' + Date.now() + '.db')
      copyFileWithRetrySync(DB, backupFile)
      fsyncFileSync(backupFile)
      try { chmodSync(backupFile, 0o600) } catch {}
    }
  } catch (error) {
    console.error(`import failed: cannot back up the current database before replacing it (${describeFsError(error, { action: 'copying', target: DB })})`)
    process.exitCode = 1
    return
  }
  try {
    const ledger = Ledger.fromJSON(data, LOCAL_PORTS)
    const audit = { actor: 'local', action: 'import.ledger', allowed: true, reason: basename(file) }
    let dataReport = null
    if (dataImport && mode === 'sqlite') {
      // One transaction: the ledger tables (saveWithAudit) and every exported
      // DATA_TABLES entry (applyDataImport), including their cross-reference
      // validation. A bad reference throws and rolls the whole replace back; the
      // pre-import backup remains as a second net.
      openStore().saveWithAudit(ledger.toJSON(), audit, (innerStore) => {
        dataReport = applyDataImport(innerStore, dataImport)
      })
    } else {
      saveLedgerWithAudit(ledger, audit)
    }
    console.log(`imported ${data.matters.length} matters, ${data.commitments?.length ?? 0} commitments`)
    if (dataReport?.customer) {
      const customerReport = dataReport.customer
      console.log('restored clients=' + customerReport.clients + ' projects=' + customerReport.projects + ' client_notes=' + customerReport.clientNotes + (customerReport.reconciledDeliveries ? ' · delivery lineage reconciled=' + customerReport.reconciledDeliveries : ''))
    }
    if (dataReport) {
      const restoredTables = Object.entries(dataReport.tables)
        .filter(([table]) => !CUSTOMER_IMPORT_TABLES.includes(table))
        .map(([table, count]) => table + '=' + count)
        .join(', ')
      if (restoredTables) console.log('restored tables: ' + restoredTables)
      if (dataReport.kbReconciled) console.log('kb reconciled rows=' + dataReport.kbReconciled)
      if (dataReport.kbPagesCleared) console.log('kb_pages cleared=' + dataReport.kbPagesCleared + ' (run advisers kb page rebuild)')
      console.error('note: ledger + exported DATA_TABLES were replaced (derived FTS tables, mail_cursors and the machine-local audit chain excluded); the local audit chain stays valid.')
    } else if (payload?.data) {
      console.error('note: SQLite-only tables in the import were not merged; ledger was replaced.')
    }
  } catch (error) { console.error(`import failed: ${error.message}`); process.exitCode = 1 }
}

/* ---------------------------------------------------------------------------
 * 0.3.0 P0-D2: backup rotation, backup listing/verification and restore.
 *
 * `backup <path>` keeps the 0.2.x explicit-copy behaviour (that path is never
 * rotated), while `backup` with no path writes a managed
 * $ADVISERS_HOME/backups/state-<UTC>-<tag>.db with .sha256 + .anchor.json
 * sidecars. Every copy is verified (quick_check/schema/audit head/sampled row
 * counts) before it is installed. `backup --keep` plans a GFS rotation and
 * deletes nothing unless --apply is passed; managed rotation only ever touches
 * <HOME>/backups. `backups verify` re-checks every managed backup read-only.
 * `restore` plans first (default) and only applies with --yes: safety
 * pre-restore backup, atomic install of a verified copy, post-install
 * verification with rollback, audit row `db.restore` and a fresh anchor.
 * ------------------------------------------------------------------------- */

/** Report a lib operation failure (backup/restore) with code + actionable hint. */
async function reportBackupFailure(result, asJson, label) {
  const lib = await loadBackup()
  const code = result?.code ?? null
  const hint = code ? lib.describeBackupCode(code) : null
  if (asJson) {
    console.log(JSON.stringify({ ok: false, label, code, errors: result?.errors ?? [], warnings: result?.warnings ?? [], hint: hint ?? undefined, originalIntact: result?.originalIntact, rolledBack: result?.rolledBack, preRestoreBackup: result?.preRestoreBackup ?? undefined }, null, 2))
  } else {
    console.error(`${label}: FAILED${code ? ' (' + code + ')' : ''}`)
    for (const error of result?.errors ?? []) console.error(`  ${error}`)
    if (hint) console.error(`  hint: ${hint}`)
    if (result?.originalIntact === true) console.error('  the live database was not replaced.')
    if (result?.rolledBack === true) console.error('  the pre-restore backup was rolled back.')
    if (result?.preRestoreBackup) console.error(`  pre-restore backup kept at ${result.preRestoreBackup}`)
  }
  process.exitCode = 1
}

/**
 * Refresh $ADVISERS_HOME/audit-anchor.json after a backup (P0-L2). The backup
 * command deliberately writes no audit row of its own: the anchor then equals
 * the just-created backup's audit head, so restoring that backup immediately is
 * an anchor "match" (not a suspicious rollback). Audit rows are appended by
 * commands that change the ledger (restore/doctor.repair/audit --rebuild-fts).
 */
async function refreshAuditAnchor(store) {
  if (!store) return { ok: false, code: null, errors: ['no writable store'] }
  try {
    const anchorLib = await loadAuditAnchor()
    return anchorLib.writeAuditAnchor({ home: HOME, store, generator: `advisers/${VERSION}` })
  } catch (error) {
    return { ok: false, code: error?.code ?? null, errors: [String(error?.message ?? error)] }
  }
}

function printBackupCreated(created, asJson) {
  const rotation = created.rotation
  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      path: created.path,
      bytes: created.bytes,
      sha256: created.sha256,
      audit: created.audit ? { count: created.audit.count, lastSeq: created.audit.lastSeq, headHash: created.audit.headHash } : null,
      sidecars: created.sidecars,
      rotation: rotation ? { dryRun: rotation.dryRun, kept: rotation.kept, wouldDelete: rotation.wouldDelete, deleted: rotation.deleted, errors: rotation.errors } : null,
      warnings: created.warnings ?? [],
    }, null, 2))
    return
  }
  console.log(`backup: ${created.path} (${formatBytes(created.bytes)}, sha256=${String(created.sha256 ?? '').slice(0, 12)}…)`)
  if (created.audit) console.log(`backup: audit entries=${created.audit.count} head=${shortAuditHash(created.audit.headHash)}`)
  console.log(`backup: sidecars sha256=${created.sidecars?.sha256 ? 'yes' : 'no'} anchor=${created.sidecars?.anchor ? 'yes' : 'no'}`)
  for (const warning of created.warnings ?? []) console.log(`warning: ${warning}`)
  if (rotation) {
    if (rotation.dryRun) console.log(`rotation: dry-run would delete ${rotation.wouldDelete.length} backup(s)${rotation.wouldDelete.length ? ': ' + rotation.wouldDelete.map((file) => basename(file)).join(', ') : ''}`)
    else console.log(`rotation: deleted ${rotation.deleted?.length ?? 0} backup(s)`)
  }
}

/**
 * `advisers backup` — explicit copy, managed backup, or a managed backup +
 * GFS/keep-N rotation plan (dry-run unless --apply).
 */
async function backupCommand(args = []) {
  const parsed = parseStrictFlags(args, {
    booleans: ['dry-run', 'apply', 'json'],
    values: ['out', 'tag', 'keep'],
    positional: true,
  })
  if (!parsed.ok) return usageFail(parsed.error, BACKUP_USAGE)
  const { flags, positional } = parsed
  if (positional.length > 1) return usageFail('backup accepts at most one explicit path', BACKUP_USAGE)
  if (positional.length === 1 && flags.out !== undefined) return usageFail('pass either an explicit path or --out, not both', BACKUP_USAGE)
  if (flags.apply === true && flags['dry-run'] === true) return usageFail('--apply and --dry-run are mutually exclusive', BACKUP_USAGE)
  if (flags.apply === true && flags.keep === undefined) return usageFail('--apply requires --keep (it only applies the rotation plan)', BACKUP_USAGE)
  const asJson = flags.json === true
  const sealed = vaultSealedPath()
  if (sealed) {
    if (asJson) console.log(JSON.stringify({ ok: false, code: 'E_VAULT_SEALED', errors: [`cannot back up a sealed database (${sealed}); run advisers vault unseal first`] }, null, 2))
    else {
      console.error(`advisers: E_VAULT_SEALED — cannot back up a sealed database (${sealed}).`)
      console.error('Run `advisers vault unseal` first; the sealed file itself is already an encrypted backup.')
    }
    process.exitCode = 1
    return
  }
  if (mode === 'json') return usageFail('backup requires the SQLite store (ADVISERS_STORE=sqlite)', BACKUP_USAGE)
  const lib = await loadBackup()
  if (flags.keep !== undefined) {
    const normalized = lib.normalizeKeepPolicy(flags.keep)
    if (!normalized.ok) return usageFail(`invalid --keep: ${normalized.error}`, BACKUP_USAGE)
  }
  if (flags.tag !== undefined) {
    const tagCheck = lib.normalizeBackupTag(flags.tag)
    if (!tagCheck.ok) return usageFail(`invalid --tag: ${tagCheck.error}`, BACKUP_USAGE)
  }
  const explicitPath = flags.out !== undefined ? String(flags.out) : positional[0]
  if (explicitPath !== undefined && (flags.keep !== undefined || flags.apply === true)) {
    return usageFail('an explicit backup path never participates in rotation; drop --keep/--apply or use a managed backup', BACKUP_USAGE)
  }
  ensureHome()
  let store
  try { store = openStore() } catch (error) { return reportMaintenanceFailure(error, asJson, 'backup') }
  if (explicitPath !== undefined) {
    const created = lib.createBackup({
      dbPath: DB,
      targetPath: explicitPath,
      store,
      checkpoint: true,
      verify: true,
      verifyChain: true,
      writeSha256: true,
      overwrite: true,
    })
    if (!created.ok) return reportBackupFailure(created, asJson, 'backup')
    if (created.audit) {
      const anchored = lib.writeBackupAnchorSidecar({ backupPath: created.path, head: created.audit, home: HOME })
      if (anchored.ok) created.sidecars.anchor = anchored.anchorPath
      else (created.warnings ??= []).push(anchored.errors?.[0] ?? 'could not write the audit anchor sidecar')
    }
    const anchor = await refreshAuditAnchor(store)
    if (!anchor.ok) (created.warnings ??= []).push(`could not refresh the audit anchor (${anchor.code ?? 'unknown'})`)
    printBackupCreated(created, asJson)
    if (!asJson && created.warnings?.length) {
      for (const warning of created.warnings.slice(-1)) console.log(`warning: ${warning}`)
    }
    if (!asJson) console.log(anchor.ok ? `anchor: refreshed (count=${anchor.anchor?.count ?? '?'})` : `warning: audit anchor not refreshed (${anchor.code ?? 'unknown'})`)
    return
  }
  // Managed backup. Plain --dry-run (no --keep) is a read-only plan.
  if (flags['dry-run'] === true && flags.keep === undefined) {
    const target = lib.backupPathFor({ home: HOME, tag: flags.tag ?? null })
    const listed = lib.listBackups({ home: HOME })
    const rotation = lib.planBackupRotation({ entries: listed.entries ?? [], keep: undefined })
    if (asJson) console.log(JSON.stringify({ ok: true, mode: 'dry-run', wouldCreate: target, rotation: { kept: rotation.kept?.map((entry) => entry.path), wouldDelete: rotation.wouldDelete } }, null, 2))
    else {
      console.log(`backup: dry-run would create ${target}`)
      console.log(`rotation: dry-run would keep ${rotation.kept?.length ?? 0} backup(s), delete ${rotation.wouldDelete?.length ?? 0}`)
    }
    return
  }
  const created = lib.createManagedBackup({
    home: HOME,
    dbPath: DB,
    store,
    tag: flags.tag ?? null,
    keep: flags.keep !== undefined ? flags.keep : null,
    rotate: flags.keep !== undefined,
    rotateDryRun: flags.apply !== true,
    verifyChain: true,
  })
  if (!created.ok) return reportBackupFailure(created, asJson, 'backup')
  const anchor = await refreshAuditAnchor(store)
  if (!anchor.ok) (created.warnings ??= []).push(`could not refresh the audit anchor (${anchor.code ?? 'unknown'})`)
  if (asJson) {
    const payload = {
      ok: true,
      path: created.path,
      bytes: created.bytes,
      sha256: created.sha256,
      audit: created.audit ? { count: created.audit.count, lastSeq: created.audit.lastSeq, headHash: created.audit.headHash } : null,
      sidecars: created.sidecars,
      rotation: created.rotation ? { dryRun: created.rotation.dryRun, wouldDelete: created.rotation.wouldDelete, deleted: created.rotation.deleted, errors: created.rotation.errors } : null,
      warnings: created.warnings ?? [],
      anchor: anchor.ok ? { ok: true, count: anchor.anchor?.count ?? null } : { ok: false, code: anchor.code ?? null },
    }
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  console.log(`backup: ${created.path} (${formatBytes(created.bytes)}, sha256=${String(created.sha256 ?? '').slice(0, 12)}…)`)
  if (created.audit) console.log(`backup: audit entries=${created.audit.count} head=${shortAuditHash(created.audit.headHash)}`)
  console.log(`backup: sidecars sha256=${created.sidecars?.sha256 ? 'yes' : 'no'} anchor=${created.sidecars?.anchor ? 'yes' : 'no'}`)
  for (const warning of created.warnings ?? []) console.log(`warning: ${warning}`)
  const rotation = created.rotation
  if (rotation) {
    if (rotation.dryRun) console.log(`rotation: dry-run would delete ${rotation.wouldDelete?.length ?? 0} backup(s)${rotation.wouldDelete?.length ? ': ' + rotation.wouldDelete.map((file) => basename(file)).join(', ') : ''} (pass --apply to delete)`)
    else console.log(`rotation: deleted ${rotation.deleted?.length ?? 0} backup(s)`)
    for (const error of rotation.errors ?? []) console.error(`rotation error: ${error}`)
  }
  console.log(anchor.ok ? `anchor: refreshed (count=${anchor.anchor?.count ?? '?'})` : `warning: audit anchor not refreshed (${anchor.code ?? 'unknown'})`)
}

/** `advisers backups ls|verify` — read-only inspection of <HOME>/backups. */
async function backupsCommand(args = []) {
  const sub = args[0]
  const rest = args.slice(1)
  if (!sub || sub === 'help' || sub === '--help') { console.log(BACKUPS_USAGE); if (!sub) process.exitCode = 1; return }
  if (sub !== 'ls' && sub !== 'verify') return usageFail(`unknown backups subcommand: ${sub}`, BACKUPS_USAGE)
  const parsed = parseStrictFlags(rest, { booleans: ['json'], values: ['limit'], positional: false })
  if (!parsed.ok) return usageFail(parsed.error, BACKUPS_USAGE)
  const { flags } = parsed
  const asJson = flags.json === true
  let limit = 100
  if (flags.limit !== undefined) {
    limit = Number(flags.limit)
    if (!Number.isInteger(limit) || limit < 1) return usageFail('--limit requires a positive integer', BACKUPS_USAGE)
  }
  const lib = await loadBackup()
  if (mode === 'json') return usageFail('backups requires the SQLite store (ADVISERS_STORE=sqlite)', BACKUPS_USAGE)
  ensureHome()
  if (sub === 'ls') {
    const listed = lib.listBackups({ home: HOME })
    if (!listed.ok) { console.error(`backups ls: FAILED (${listed.errors?.[0] ?? 'unknown'})`); process.exitCode = 1; return }
    const entries = listed.entries.slice(0, limit)
    if (asJson) {
      console.log(JSON.stringify({ ok: true, dir: listed.dir, count: entries.length, total: listed.entries.length, entries: entries.map((entry) => ({ name: entry.name, path: entry.path, tag: entry.tag, createdAt: entry.createdAt, bytes: entry.size, sidecars: entry.sidecars })) }, null, 2))
      return
    }
    if (!entries.length) { console.log(`backups: none in ${listed.dir}`); return }
    console.log(`backups: ${listed.entries.length} in ${listed.dir} (newest first)`)
    for (const entry of entries) {
      console.log(`${entry.name}\t${formatBytes(entry.size)}\t${entry.createdAt}\tsha256=${entry.sidecars.sha256 ? 'yes' : 'no'}\tanchor=${entry.sidecars.anchor ? 'yes' : 'no'}`)
    }
    return
  }
  const verified = lib.verifyBackups({ home: HOME, limit })
  if (asJson) {
    console.log(JSON.stringify({
      ok: verified.ok,
      dir: verified.dir,
      count: verified.count,
      results: verified.results.map((row) => ({
        name: row.name,
        path: row.path,
        ok: row.ok,
        schemaVersion: row.inspection?.schemaVersion ?? null,
        auditCount: row.inspection?.audit?.count ?? null,
        errors: [...(row.inspection?.errors ?? []), ...(row.sidecars?.errors ?? [])],
      })),
      errors: verified.errors,
      warnings: verified.warnings,
    }, null, 2))
  } else if (!verified.results.length) {
    console.log(`backups: none in ${verified.dir}`)
  } else {
    for (const row of verified.results) {
      const detail = row.ok
        ? `schema=v${row.inspection?.schemaVersion ?? '?'} audit=${row.inspection?.audit?.count ?? '?'}`
        : `${[...(row.inspection?.errors ?? []), ...(row.sidecars?.errors ?? [])][0] ?? 'failed'}`
      console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}  ${detail}`)
    }
    console.log(`backups: ${verified.results.length} checked, ${verified.results.filter((row) => !row.ok).length} failed`)
  }
  if (!verified.ok) process.exitCode = 1
}

/**
 * `advisers restore <backup-file>` — plan by default, apply only with --yes.
 * The whole flow is fail-safe: planRestore validates the backup + anchors
 * before anything is touched; restoreBackup writes a pre-restore safety copy,
 * installs the verified backup atomically, re-verifies and rolls back on
 * failure. On success the store is reopened, `db.restore` is audited and a
 * fresh anchor is written.
 */
async function restoreCommand(args = []) {
  const parsed = parseStrictFlags(args, {
    booleans: ['dry-run', 'yes', 'allow-anchor-behind', 'allow-broken-audit-chain', 'json'],
    positional: true,
  })
  if (!parsed.ok) return usageFail(parsed.error, RESTORE_USAGE)
  const { flags, positional } = parsed
  if (positional.length !== 1) return usageFail('restore requires exactly one backup file', RESTORE_USAGE)
  if (flags.yes === true && flags['dry-run'] === true) return usageFail('--yes and --dry-run are mutually exclusive', RESTORE_USAGE)
  const asJson = flags.json === true
  const sealed = vaultSealedPath()
  if (sealed) {
    if (asJson) console.log(JSON.stringify({ ok: false, code: 'E_VAULT_SEALED', errors: [`the ledger is sealed (${sealed}); run advisers vault unseal first`] }, null, 2))
    else {
      console.error(`advisers: E_VAULT_SEALED — cannot restore into a sealed home (${sealed}).`)
      console.error('Run `advisers vault unseal` first, then retry the restore.')
    }
    process.exitCode = 1
    return
  }
  if (mode === 'json') return usageFail('restore requires the SQLite store (ADVISERS_STORE=sqlite)', RESTORE_USAGE)
  ensureHome()
  let backupPath = positional[0]
  if (!existsSync(backupPath) && !isAbsolute(backupPath)) {
    const candidate = join(HOME, 'backups', backupPath)
    if (existsSync(candidate)) backupPath = candidate
  }
  const lib = await loadBackup()
  const options = {
    allowAnchorBehind: flags['allow-anchor-behind'] === true,
    allowBrokenAuditChain: flags['allow-broken-audit-chain'] === true,
  }
  const plan = lib.planRestore({ backupPath, dbPath: DB, home: HOME, key: undefined, ...options })
  if (!plan.ok) {
    if (asJson) {
      const hint = plan.code ? lib.describeBackupCode(plan.code) : null
      console.log(JSON.stringify({ ok: false, mode: 'dry-run', code: plan.code ?? null, codes: plan.codes ?? [], errors: plan.errors ?? [], warnings: plan.warnings ?? [], hint: hint ?? undefined }, null, 2))
    } else {
      console.error(`restore: plan FAILED${plan.code ? ' (' + plan.code + ')' : ''}`)
      for (const error of plan.errors ?? []) console.error(`  ${error}`)
      if (plan.code) console.error(`  hint: ${lib.describeBackupCode(plan.code)}`)
      console.error('  nothing was changed.')
    }
    process.exitCode = 1
    return
  }
  const backupInfo = plan.inspection
  const anchor = plan.anchorVerification
  const anchorLine = !plan.anchor
    ? 'absent (yellow: no audit anchor found — the backup cannot be checked against a baseline)'
    : anchor?.ok === false
      ? `FAIL (${anchor.code})`
      : anchor
        ? `${anchor.status} (anchor count=${anchor.anchorCount ?? '?'} backup count=${anchor.count ?? '?'}${options.allowAnchorBehind ? ', anchor-behind allowed' : ''})`
        : 'present (not comparable: the backup has no readable audit head)'
  const apply = flags.yes === true
  if (!apply) {
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        mode: 'dry-run',
        backup: { path: plan.path, bytes: backupInfo.size, schemaVersion: backupInfo.schemaVersion, schemaStatus: backupInfo.schemaStatus, audit: backupInfo.audit ? { count: backupInfo.audit.count, lastSeq: backupInfo.audit.lastSeq, headHash: backupInfo.audit.headHash } : null, chainVerified: backupInfo.chainVerified === true },
        target: DB,
        anchor: plan.anchor ? { present: true, status: anchor?.status ?? null, ok: anchor?.ok ?? null, code: anchor?.code ?? null } : { present: false, status: 'absent' },
        sidecarAnchor: plan.sidecarAnchor ? { present: true, ok: plan.sidecarAnchor.verification?.ok === true } : { present: false },
        steps: plan.steps,
        warnings: plan.warnings,
      }, null, 2))
      return
    }
    console.log(`restore: dry-run (no changes) — ${basename(plan.path)}`)
    console.log(`backup: ${formatBytes(backupInfo.size)} schema=v${backupInfo.schemaVersion ?? '?'} (${backupInfo.schemaStatus}) audit=${backupInfo.audit ? backupInfo.audit.count + ' entries, chain=' + (backupInfo.chainVerified ? 'verified' : 'not verified') : 'no audit table'}`)
    console.log(`anchor: ${anchorLine}`)
    if (plan.sidecarAnchor) console.log(`sidecar: ${basename(lib.backupAnchorPath(plan.path))} ${plan.sidecarAnchor.verification?.ok === true ? 'match' : 'mismatch'}`)
    for (const step of plan.steps) console.log(`step: ${step}`)
    for (const warning of plan.warnings) console.log(`warning: ${warning}`)
    console.log('next: advisers restore ' + basename(plan.path) + ' --yes')
    return
  }
  let lock
  try { lock = ensureInstanceLock() } catch (error) { return reportMaintenanceFailure(error, asJson, 'restore') }
  let store = null
  if (existsSync(DB)) {
    try { store = openStore() } catch (error) { return reportMaintenanceFailure(error, asJson, 'restore') }
  }
  const restored = lib.restoreBackup({ plan, dbPath: DB, store, home: HOME, key: undefined, ...options })
  if (!restored.ok) {
    activeStore = undefined
    try { releaseInstanceLock() } catch {}
    return reportBackupFailure(restored, asJson, 'restore')
  }
  // Reopen the restored database and record the restore (the library never
  // writes audit rows itself; the caller owns the post-restore audit/anchor).
  activeStore = undefined
  let auditRow = null
  let anchorWrite = null
  let reopened = null
  try {
    reopened = openStore()
    auditRow = reopened.appendAudit({
      actor: 'local',
      action: 'db.restore',
      allowed: true,
      reason: `from=${basename(restored.restoredFrom)};preRestore=${restored.preRestoreBackup ? basename(restored.preRestoreBackup) : 'none'};allowAnchorBehind=${options.allowAnchorBehind ? 1 : 0};schema=v${restored.schemaVersion ?? '?'};auditCount=${restored.audit?.count ?? '?'}`,
    })
    const anchorLib = await loadAuditAnchor()
    anchorWrite = anchorLib.writeAuditAnchor({ home: HOME, store: reopened, generator: `advisers/${VERSION}` })
  } catch (error) {
    if (asJson) console.log(JSON.stringify({ ok: false, mode: 'apply', restored: true, code: error?.code ?? null, errors: [`the backup was installed but reopening/recording it failed: ${error?.message ?? error}`], preRestoreBackup: restored.preRestoreBackup ?? null }, null, 2))
    else {
      console.error(`advisers: the backup was installed but reopening/recording it failed: ${error?.message ?? error}`)
      console.error(`  Next: run 'advisers doctor --check-db'; the pre-restore backup is at ${restored.preRestoreBackup ?? '(none)'}.`)
    }
    process.exitCode = 1
    return
  }
  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'apply',
      restoredFrom: restored.restoredFrom,
      preRestoreBackup: restored.preRestoreBackup,
      schemaVersion: restored.schemaVersion,
      audit: restored.audit ? { count: restored.audit.count, lastSeq: restored.audit.lastSeq, headHash: restored.audit.headHash } : null,
      auditRow: auditRow ? { seq: auditRow.seq, action: auditRow.action } : null,
      anchor: anchorWrite ? { ok: anchorWrite.ok === true, code: anchorWrite.code ?? null, count: anchorWrite.anchor?.count ?? null } : null,
      steps: restored.steps,
      warnings: restored.warnings,
    }, null, 2))
    return
  }
  console.log(`restore: done — ${basename(restored.restoredFrom)} -> ${DB}`)
  console.log(`restore: pre-restore backup ${restored.preRestoreBackup ? basename(restored.preRestoreBackup) : '(none: fresh install)'}`)
  console.log(`restore: schema=v${restored.schemaVersion ?? '?'} audit=${restored.audit?.count ?? '?'} entries`)
  if (auditRow) console.log(`audit: db.restore seq ${auditRow.seq}`)
  if (anchorWrite?.ok) console.log(`audit: anchor refreshed (count=${anchorWrite.anchor?.count ?? '?'})`)
  else if (anchorWrite) console.error(`warning: the restore succeeded but the audit anchor failed (${anchorWrite.code ?? 'unknown'})`)
  for (const warning of restored.warnings ?? []) console.log(`warning: ${warning}`)
  console.log('next: advisers doctor --check-db')
}

async function brief(text, deep = false) {
  if (!text) {
    console.error('usage: advisers brief <text>')
    process.exitCode = 1
    return
  }
  const stage = process.env.ADVISERS_STAGE === 'trusted' ? 'trusted' : 'probation'
  const brief = core.buildIntentBrief(text, { stage })
  console.log(core.renderIntentBrief(brief))
  console.log('\n' + core.renderReadback(brief))
  if (deep && process.env.ADVISERS_API_KEY) {
    // 0.2.3: --deep only reads the active matter for the egress gate (the model
    // call itself is explicit egress); it takes no writer lock.
    const briefStore = mode === 'sqlite' ? readStoreOrExit() : null
    const briefLedger = readLedgerForCommand({ matters: {} })
    const briefMatterId = briefStore?.listSessions(1)?.[0]?.matterId ?? briefLedger.listMatters()[0]?.id
    const briefDenied = egressDeniedReason(briefLedger.getMatter(briefMatterId), 'brief --deep')
    if (briefDenied) { console.error(briefDenied); process.exitCode = 1; return }
    try {
      const { chatCompletion } = await loadModel()
      const response = await chatCompletion({
        apiKey: process.env.ADVISERS_API_KEY,
        baseUrl: process.env.ADVISERS_BASE_URL,
        model: process.env.ADVISERS_MODEL,
        task: 'intent', thinking: true, effort: 'high', maxTokens: 2048,
        messages: [
          { role: 'system', content: 'Return ONLY JSON: {"goal":"","deliverable":"","audience":"","constraints":[],"assumptions":[],"unknowns":[],"question":"one question that changes the plan or empty","risk":"low|medium|high"}. Do not invent facts; ask at most one question.' },
          { role: 'user', content: text },
        ],
      })
      const parsed = JSON.parse(String(response.content).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
      console.log('\n深层 brief：')
      console.log(JSON.stringify(parsed, null, 2))
    } catch (error) { console.error(`deep brief failed: ${error.message}`) }
  }
}

async function routine(sub, arg, arg2) {
  const ledger = loadLedger()
  if (typeof ledger.addRoutine !== 'function') {
    console.error('routine requires advisers-core@0.1.0-preview.3 or newer')
    process.exitCode = 1
    return
  }
  if (sub === 'ls' || !sub) {
    const rows = ledger.listRoutines()
    if (!rows.length) {
      console.log('no routines yet')
      return
    }
    for (const r of rows) console.log(`${r.id}\t${r.status}\tv${r.version}\t${r.name}`)
    return
  }
  if (sub === 'add') {
    if (!arg) {
      console.error('usage: advisers routine add <spec.json>')
      process.exitCode = 1
      return
    }
    await requireTosReaccept({ scope: 'routine', subject: 'routine:add', action: 'routine add' })
    const spec = JSON.parse(readFileSync(arg, 'utf8'))
    const routine = ledger.addRoutine({
      name: spec.name,
      description: spec.description ?? '',
      trigger: spec.trigger ?? [],
      steps: spec.steps ?? [],
      preferences: spec.preferences ?? [],
      pitfalls: spec.pitfalls ?? [],
      verification: spec.verification ?? [],
      scope: spec.scope,
      createdBy: spec.createdBy ?? 'user',
    })
    saveLedger(ledger)
    console.log(`draft routine ${routine.id}: ${routine.name}; approve with \`advisers routine approve ${routine.id}\``)
    return
  }
  if (sub === 'patches') {
    const rows = ledger.listRoutinePatches()
    if (!rows.length) {
      console.log('no routine patches')
      return
    }
    for (const p of rows) console.log(`${p.id}\t${p.status}\troutine=${p.routineId}\tbase=v${p.baseVersion}`)
    return
  }
  if (sub === 'patch') {
    if (!arg || !arg2) {
      console.error('usage: advisers routine patch <routine-id> <changes.json>')
      process.exitCode = 1
      return
    }
    await requireTosReaccept({ scope: 'routine', subject: `routine:${arg}`, action: 'routine patch' })
    const changes = JSON.parse(readFileSync(arg2, 'utf8'))
    const patch = ledger.proposeRoutinePatch(arg, changes)
    saveLedger(ledger)
    console.log(`patch ${patch.id} (base v${patch.baseVersion}):\n${patch.diff}`)
    console.log(`approve with \`advisers routine apply ${patch.id}\``)
    return
  }
  if (sub === 'check') {
    if (!arg) { console.error('usage: advisers routine check <id>'); process.exitCode = 1; return }
    const routine = ledger.listRoutines().find((r) => r.id === arg)
    if (!routine) { console.error(`unknown routine: ${arg}`); process.exitCode = 1; return }
    const { checkRoutine } = await loadRoutine()
    const result = checkRoutine(routine)
    for (const item of result.results) console.log(`${item.ok ? 'ok' : 'FAIL'}\t${item.kind}\t${item.entry}`)
    if (!result.ok) process.exitCode = 1
    return
  }
  if (sub === 'diff') {
    if (!arg) {
      console.error('usage: advisers routine diff <patch-id>')
      process.exitCode = 1
      return
    }
    const patch = ledger.listRoutinePatches().find((p) => p.id === arg)
    console.log(patch ? patch.diff : `unknown patch: ${arg}`)
    if (!patch) process.exitCode = 1
    return
  }
  if (sub === 'curate') {
    const apply = arg === '--apply'
    if (apply) await requireTosReaccept({ scope: 'routine', subject: 'routine:curate', action: 'routine curate --apply' })
    const now = Date.now()
    let changed = 0
    for (const r of ledger.listRoutines().filter((x) => x.status === 'active')) {
      const idleDays = (now - Date.parse(r.updatedAt)) / 86_400_000
      if (idleDays >= 90) {
        console.log(`${r.id}\tarchive candidate\t${Math.floor(idleDays)}d\t${r.name}`)
        if (apply) { ledger.deprecateRoutine(r.id); changed++ }
      } else if (idleDays >= 30) {
        console.log(`${r.id}\tstale\t${Math.floor(idleDays)}d\t${r.name}`)
        if (apply) { ledger.staleRoutine(r.id); changed++ }
      }
    }
    if (!changed && !apply) console.log('no stale routines (dry-run; use --apply)')
    if (apply) { saveLedger(ledger); console.log(`curated: ${changed}`) }
    return
  }
  if (sub === 'restore') {
    if (!arg) { console.error('usage: advisers routine restore <id>'); process.exitCode = 1; return }
    await requireTosReaccept({ scope: 'routine', subject: `routine:${arg}`, action: 'routine restore' })
    const r = ledger.restoreRoutine(arg)
    saveLedger(ledger)
    console.log(`restored to draft: ${r.id}`)
    return
  }
  if (sub === 'revert') {
    if (!arg) { console.error('usage: advisers routine revert <patch-id>'); process.exitCode = 1; return }
    await requireTosReaccept({ scope: 'routine', subject: `routine:${arg}`, action: 'routine revert' })
    const patch = ledger.revertRoutinePatch(arg)
    saveLedger(ledger)
    console.log(`rolled_back: ${patch.id}`)
    return
  }
  if (sub === 'apply' || sub === 'reject') {
    if (!arg) {
      console.error(`usage: advisers routine ${sub} <patch-id>`)
      process.exitCode = 1
      return
    }
    if (sub === 'apply') {
      await requireTosReaccept({ scope: 'routine', subject: `routine:${arg}`, action: 'routine apply' })
      const pending = ledger.listRoutinePatches('pending').find((p) => p.id === arg)
      if (!pending) { console.error(`unknown or closed routine patch: ${arg}`); process.exitCode = 1; return }
      const routine = ledger.listRoutines().find((r) => r.id === pending.routineId)
      if (!routine) { console.error(`unknown routine: ${pending.routineId}`); process.exitCode = 1; return }
      const candidate = { ...routine, ...pending.changes }
      const { checkRoutine } = await loadRoutine()
      const check = checkRoutine(candidate)
      if (!check.ok) {
        console.error('routine checks failed; patch not applied')
        for (const item of check.results.filter((r) => !r.ok)) console.error(`FAIL ${item.entry}`)
        process.exitCode = 1
        return
      }
    }
    const patch = sub === 'apply' ? ledger.applyRoutinePatch(arg) : ledger.rejectRoutinePatch(arg)
    saveLedger(ledger)
    console.log(`${patch.status}: ${patch.id}`)
    return
  }
  if (sub === 'approve' || sub === 'archive') {
    if (!arg) {
      console.error(`usage: advisers routine ${sub} <id>`)
      process.exitCode = 1
      return
    }
    await requireTosReaccept({ scope: 'routine', subject: `routine:${arg}`, action: `routine ${sub}` })
    const routine = sub === 'approve' ? ledger.approveRoutine(arg) : ledger.archiveRoutine(arg)
    saveLedger(ledger)
    console.log(`${routine.status}: ${routine.id}`)
    return
  }
  console.error(`unknown routine subcommand: ${sub}`)
  process.exitCode = 1
}

// ---------------------------------------------------------------------------
// 0.2.3 P2: quote / proposal templates.
//
// Two deterministic Office builders on top of the existing office package
// (buildDocx/buildXlsx/validateOffice), so no new dependency and no model call.
// Money is parsed as integer cents (BigInt while multiplying, then a safe
// Number) — never floating point. The same normalized data + totals are embedded
// in the document so 'advisers verify --content' can re-check them.
// ---------------------------------------------------------------------------
const QUOTE_TEMPLATE_VERSION = '1'
const QUOTE_CURRENCIES = { CNY: '¥', USD: '$', EUR: '€', HKD: 'HK$' }
const QUOTE_MAX_ITEMS = 200
const QUOTE_DEFAULT_DISCLAIMER = '本文件由本地模板确定性生成，仅供商务沟通参考；不构成任何法律或税务意见。金额、日期与条款以双方最终书面约定为准。'
const QUOTE_DEFAULT_CHANGE_PROCESS = '范围或交付物发生变化时，双方先书面确认变更内容、费用与时间影响，再执行变更。'

function templateDataError(message, path) {
  const error = new Error(message)
  error.code = 'E_TEMPLATE_INVALID'
  if (path) error.details = { path: path }
  return error
}

function templateAmountError(message, path) {
  const error = new Error(message)
  error.code = 'E_AMOUNT'
  if (path) error.details = { path: path }
  return error
}

function templateFail(error) {
  console.error(JSON.stringify({
    error: {
      code: typeof error?.code === 'string' ? error.code : 'E_TEMPLATE_INVALID',
      message: error?.message ?? String(error),
      ...(error?.hint ? { hint: error.hint } : {}),
      ...(error?.details ? { details: error.details } : {}),
    },
  }))
  process.exitCode = 1
}

function templateRejectUnknown(object, allowed, path) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw templateDataError('unknown field: ' + path + '.' + key, path + '.' + key)
  }
}

function templateText(value, path, options = {}) {
  if (value === undefined || value === null) {
    if (options.optional) return undefined
    throw templateDataError(path + ' is required', path)
  }
  if (typeof value !== 'string') throw templateDataError(path + ' must be a string', path)
  const text = value.trim()
  const length = Array.from(text).length
  const min = options.min ?? 1
  const max = options.max ?? 200
  if (length < min) throw templateDataError(path + ' is empty or too short', path)
  if (length > max) throw templateDataError(path + ' is longer than ' + max + ' characters', path)
  return text
}

function templateOptionalText(value, path, options = {}) {
  if (value === undefined || value === null) return undefined
  return templateText(value, path, options)
}

function templateList(value, path, options = {}) {
  if (value === undefined || value === null) {
    if (options.optional) return []
    throw templateDataError(path + ' is required', path)
  }
  if (!Array.isArray(value)) throw templateDataError(path + ' must be an array', path)
  const maxItems = options.maxItems ?? 20
  if (value.length > maxItems) throw templateDataError(path + ' has more than ' + maxItems + ' items', path)
  if (options.minItems && value.length < options.minItems) throw templateDataError(path + ' needs at least ' + options.minItems + ' item(s)', path)
  const maxLen = options.maxLen ?? 200
  return value.map((item, index) => templateText(item, path + '[' + index + ']', { max: maxLen }))
}

function templateDate(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw templateDataError(path + ' must be YYYY-MM-DD', path)
  const ms = Date.parse(value + 'T00:00:00.000Z')
  if (!Number.isFinite(ms)) throw templateDataError(path + ' is not a valid date', path)
  return value
}

/** Parse a decimal string into integer units (BigInt) at a fixed scale. */
function templateDecimalBig(value, path, scale, options = {}) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    throw templateAmountError(path + ' must be a decimal string like "8000.00"', path)
  }
  const text = value.trim()
  const split = text.split('.')
  const whole = split[0]
  const frac = split[1] ?? ''
  if (frac.length > scale) throw templateAmountError(path + ' has more than ' + scale + ' decimal place(s)', path)
  if (whole.length > 15) throw templateAmountError(path + ' is too large', path)
  let units = BigInt(whole + frac.padEnd(scale, '0'))
  if (options.positive && units <= 0n) throw templateAmountError(path + ' must be greater than 0', path)
  if (options.max !== undefined && units > options.max) throw templateAmountError(path + ' is out of range', path)
  if (options.min !== undefined && units < options.min) throw templateAmountError(path + ' is out of range', path)
  return units
}

function roundHalfUpBig(numerator, denominator) {
  const divisor = BigInt(denominator)
  return (BigInt(numerator) + divisor / 2n) / divisor
}

function formatCentsNumber(cents) {
  const value = Number(cents)
  const sign = value < 0 ? '-' : ''
  const absolute = Math.abs(value)
  const whole = Math.floor(absolute / 100)
  const fraction = String(absolute % 100).padStart(2, '0')
  return sign + String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + fraction
}

function formatMoney(cents, currency) {
  const symbol = QUOTE_CURRENCIES[currency] ?? ''
  return symbol + formatCentsNumber(cents)
}

function formatDiscountMoney(cents, currency) {
  return Number(cents) > 0 ? '-' + formatMoney(cents, currency) : formatMoney(0, currency)
}

function normalizeQuoteParty(value, path, extraFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw templateDataError(path + ' must be an object', path)
  const allowed = ['name', ...extraFields]
  templateRejectUnknown(value, allowed, path)
  const out = { name: templateText(value.name, path + '.name', { max: 100 }) }
  for (const field of extraFields) {
    const text = templateOptionalText(value[field], path + '.' + field, { max: 200 })
    if (text !== undefined) out[field] = text
  }
  return out
}

function normalizeQuoteScope(value, path) {
  if (value === undefined || value === null) return { included: [], excluded: [], assumptions: [] }
  if (typeof value !== 'object' || Array.isArray(value)) throw templateDataError(path + ' must be an object', path)
  templateRejectUnknown(value, ['included', 'excluded', 'assumptions'], path)
  return {
    included: templateList(value.included, path + '.included', { optional: true }),
    excluded: templateList(value.excluded, path + '.excluded', { optional: true }),
    assumptions: templateList(value.assumptions, path + '.assumptions', { optional: true }),
  }
}

function normalizeQuoteItems(value, path, required) {
  if (value === undefined || value === null) {
    if (required) throw templateDataError(path + ' is required (1..' + QUOTE_MAX_ITEMS + ' rows)', path)
    return { items: [], lines: [] }
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > QUOTE_MAX_ITEMS) {
    throw templateDataError(path + ' must be an array of 1..' + QUOTE_MAX_ITEMS + ' rows', path)
  }
  const items = []
  const lines = []
  const prices = []
  for (let index = 0; index < value.length; index++) {
    const row = value[index]
    const rowPath = path + '[' + index + ']'
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw templateDataError(rowPath + ' must be an object', rowPath)
    templateRejectUnknown(row, ['desc', 'qty', 'unit', 'unitPrice'], rowPath)
    const qtyUnits = templateDecimalBig(row.qty, rowPath + '.qty', 3, { positive: true, max: 1000000000n })
    const priceCents = templateDecimalBig(row.unitPrice, rowPath + '.unitPrice', 2, { max: 1000000000n })
    const lineCents = roundHalfUpBig(qtyUnits * priceCents, 1000)
    if (lineCents > 100000000000n) throw templateAmountError(rowPath + ' line amount exceeds 1e9', rowPath)
    items.push({
      desc: templateText(row.desc, rowPath + '.desc', { max: 200 }),
      qty: String(row.qty).trim(),
      unit: templateText(row.unit === undefined ? '项' : row.unit, rowPath + '.unit', { max: 10 }),
      unitPrice: String(row.unitPrice).trim(),
    })
    lines.push(Number(lineCents))
    prices.push(Number(priceCents))
  }
  return { items: items, lines: lines, prices: prices }
}

function normalizeQuoteDiscount(value, path) {
  if (value === undefined || value === null) return { data: { kind: 'none', value: '0' }, units: 0n }
  if (typeof value !== 'object' || Array.isArray(value)) throw templateDataError(path + ' must be an object', path)
  templateRejectUnknown(value, ['kind', 'value'], path)
  const kind = value.kind ?? 'none'
  if (!['none', 'percent', 'amount'].includes(kind)) throw templateDataError(path + '.kind must be none|percent|amount', path + '.kind')
  if (kind === 'none') return { data: { kind: 'none', value: '0' }, units: 0n }
  const raw = value.value === undefined ? '0' : String(value.value).trim()
  const units = kind === 'percent'
    ? templateDecimalBig(raw, path + '.value', 2, { max: 10000n })
    : templateDecimalBig(raw, path + '.value', 2, { max: 100000000000n })
  return { data: { kind: kind, value: raw }, units: units }
}

function normalizeQuoteTax(value, path) {
  if (value === undefined || value === null) return { data: { mode: 'none', ratePct: '0' }, units: 0n }
  if (typeof value !== 'object' || Array.isArray(value)) throw templateDataError(path + ' must be an object', path)
  templateRejectUnknown(value, ['mode', 'ratePct'], path)
  const mode = value.mode ?? 'none'
  if (!['none', 'inclusive', 'exclusive'].includes(mode)) throw templateDataError(path + '.mode must be none|inclusive|exclusive', path + '.mode')
  const raw = value.ratePct === undefined ? '0' : String(value.ratePct).trim()
  if (mode === 'none') return { data: { mode: 'none', ratePct: '0' }, units: 0n }
  const units = templateDecimalBig(raw, path + '.ratePct', 2, { max: 3000n })
  return { data: { mode: mode, ratePct: raw }, units: units }
}

function normalizeQuotePayment(value, path, schemaVersion = 1) {
  if (value === undefined || value === null) return { milestones: [], terms: undefined, channels: [] }
  if (typeof value !== 'object' || Array.isArray(value)) throw templateDataError(path + ' must be an object', path)
  templateRejectUnknown(value, schemaVersion === 2 ? ['milestones', 'terms', 'channels'] : ['milestones', 'terms'], path)
  const milestones = []
  if (value.milestones !== undefined) {
    if (!Array.isArray(value.milestones) || value.milestones.length > 20) throw templateDataError(path + '.milestones must be an array (max 20)', path + '.milestones')
    for (let index = 0; index < value.milestones.length; index++) {
      const row = value.milestones[index]
      const rowPath = path + '.milestones[' + index + ']'
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw templateDataError(rowPath + ' must be an object', rowPath)
      templateRejectUnknown(row, ['name', 'pct', 'due'], rowPath)
      const pctUnits = templateDecimalBig(row.pct, rowPath + '.pct', 2, { max: 10000n })
      milestones.push({ name: templateText(row.name, rowPath + '.name', { max: 100 }), pct: String(row.pct).trim(), due: row.due === undefined ? undefined : templateDate(row.due, rowPath + '.due'), pctUnits: pctUnits })
    }
    if (milestones.reduce((sum, row) => sum + row.pctUnits, 0n) > 10000n) throw templateDataError(path + '.milestones percentages exceed 100', path + '.milestones')
  }
  const terms = templateOptionalText(value.terms, path + '.terms', { max: 2000 })
  // 0.4.3 (043-5): schemaVersion 2 opt-in only; v1 inputs keep rejecting
  // `channels` as an unknown field (byte-identical v1 behaviour).
  const channels = schemaVersion === 2 ? normalizePaymentChannels(value.channels, { path: path + '.channels' }) : []
  return { milestones: milestones, terms: terms, channels: channels }
}

function normalizeQuoteTimeline(value, path) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 50) throw templateDataError(path + ' must be an array (max 50)', path)
  const rows = []
  for (let index = 0; index < value.length; index++) {
    const row = value[index]
    const rowPath = path + '[' + index + ']'
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw templateDataError(rowPath + ' must be an object', rowPath)
    templateRejectUnknown(row, ['name', 'start', 'end'], rowPath)
    const start = templateDate(row.start, rowPath + '.start')
    const end = templateDate(row.end, rowPath + '.end')
    if (Date.parse(end) < Date.parse(start)) throw templateDataError(rowPath + '.end must be >= start', rowPath + '.end')
    rows.push({ name: templateText(row.name, rowPath + '.name', { max: 100 }), start: start, end: end })
  }
  return rows
}

function normalizeQuoteSignature(value, path) {
  if (value === undefined || value === null) return { issuerName: '', clientName: '' }
  if (typeof value !== 'object' || Array.isArray(value)) throw templateDataError(path + ' must be an object', path)
  templateRejectUnknown(value, ['issuerName', 'clientName'], path)
  return {
    issuerName: templateOptionalText(value.issuerName, path + '.issuerName', { max: 100 }) ?? '',
    clientName: templateOptionalText(value.clientName, path + '.clientName', { max: 100 }) ?? '',
  }
}

/**
 * Validate + normalize quote/proposal input. All validation happens before any
 * output file is created; unknown fields are rejected so a typo cannot silently
 * produce a document that ignores user data.
 */
function normalizeQuoteData(raw, kind) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw templateDataError('data must be a JSON object', '$')
  templateRejectUnknown(raw, ['schemaVersion', 'quoteNo', 'issuedAt', 'validUntil', 'currency', 'issuer', 'client', 'project', 'scope', 'items', 'discount', 'tax', 'payment', 'timeline', 'changeProcess', 'disclaimer', 'signature'], '$')
  // 0.4.3 (043-5, plan 93 §3): v2 is explicit opt-in. Missing/1 keeps the 0.4.2
  // normalisation, template version "1" and normalised data bytes; only v2 adds
  // payment.channels to the data (and therefore to dataSha256).
  const schemaVersion = raw.schemaVersion === undefined ? 1 : raw.schemaVersion
  if (schemaVersion !== 1 && schemaVersion !== 2) throw templateDataError('schemaVersion must be 1 or 2', 'schemaVersion')
  const templateVersion = schemaVersion === 2 ? '2' : '1'
  const issuedAt = templateDate(raw.issuedAt, 'issuedAt')
  const validUntil = templateDate(raw.validUntil, 'validUntil')
  const issuedMs = Date.parse(issuedAt + 'T00:00:00.000Z')
  const validMs = Date.parse(validUntil + 'T00:00:00.000Z')
  if (validMs < issuedMs) throw templateDataError('validUntil must be >= issuedAt', 'validUntil')
  if (validMs - issuedMs > 180 * 86400000) throw templateDataError('validUntil is more than 180 days after issuedAt', 'validUntil')
  if (typeof raw.currency !== 'string' || !Object.prototype.hasOwnProperty.call(QUOTE_CURRENCIES, raw.currency)) {
    throw templateDataError('currency must be one of ' + Object.keys(QUOTE_CURRENCIES).join('|'), 'currency')
  }
  const quoteNo = raw.quoteNo === undefined || raw.quoteNo === null
    ? 'Q-' + issuedAt.split('-').join('') + '-001'
    : templateText(raw.quoteNo, 'quoteNo', { max: 40 })
  const issuer = normalizeQuoteParty(raw.issuer, 'issuer', ['contact', 'address'])
  const client = normalizeQuoteParty(raw.client, 'client', ['company', 'contact', 'address'])
  if (!raw.project || typeof raw.project !== 'object' || Array.isArray(raw.project)) throw templateDataError('project must be an object', 'project')
  templateRejectUnknown(raw.project, ['name', 'summary', 'deliverables'], 'project')
  const project = {
    name: templateText(raw.project.name, 'project.name', { max: 100 }),
    summary: templateOptionalText(raw.project.summary, 'project.summary', { max: 2000 }),
    deliverables: templateList(raw.project.deliverables, 'project.deliverables', { optional: kind !== 'proposal', minItems: kind === 'proposal' ? 1 : 0 }),
  }
  const scope = normalizeQuoteScope(raw.scope, 'scope')
  if (kind === 'proposal' && scope.included.length === 0) throw templateDataError('scope.included is required for a proposal', 'scope.included')
  const itemResult = normalizeQuoteItems(raw.items, 'items', kind === 'quote')
  if (kind === 'proposal' && itemResult.items.length > 0 && raw.tax !== undefined) {
    // allowed: a proposal may carry a fee summary, so no rejection here
  }
  const discount = normalizeQuoteDiscount(raw.discount, 'discount')
  const tax = normalizeQuoteTax(raw.tax, 'tax')
  const payment = normalizeQuotePayment(raw.payment, 'payment', schemaVersion)
  const timeline = normalizeQuoteTimeline(raw.timeline, 'timeline')
  const changeProcess = templateOptionalText(raw.changeProcess, 'changeProcess', { max: 2000 }) ?? QUOTE_DEFAULT_CHANGE_PROCESS
  const disclaimerRaw = templateOptionalText(raw.disclaimer, 'disclaimer', { max: 2000 })
  const disclaimer = disclaimerRaw && disclaimerRaw.length ? disclaimerRaw : QUOTE_DEFAULT_DISCLAIMER
  const signature = normalizeQuoteSignature(raw.signature, 'signature')
  const data = {
    schemaVersion: schemaVersion,
    quoteNo: quoteNo,
    issuedAt: issuedAt,
    validUntil: validUntil,
    currency: raw.currency,
    issuer: issuer,
    client: client,
    project: project,
    scope: scope,
    items: itemResult.items,
    discount: discount.data,
    tax: tax.data,
    payment: { milestones: payment.milestones.map((row) => ({ name: row.name, pct: row.pct, ...(row.due ? { due: row.due } : {}) })), ...(payment.terms ? { terms: payment.terms } : {}), ...(payment.channels.length ? { channels: payment.channels } : {}) },
    timeline: timeline,
    changeProcess: changeProcess,
    disclaimer: disclaimer,
    signature: signature,
  }
  const subtotalCents = itemResult.lines.reduce((sum, cents) => sum + cents, 0)
  let discountCents = 0
  if (discount.data.kind === 'percent') discountCents = Number(roundHalfUpBig(BigInt(subtotalCents) * discount.units, 10000))
  else if (discount.data.kind === 'amount') discountCents = Number(discount.units)
  if (discountCents > subtotalCents) throw templateDataError('discount exceeds subtotal', 'discount')
  const netCents = subtotalCents - discountCents
  let taxCents = 0
  let totalCents = netCents
  if (tax.data.mode === 'exclusive') {
    taxCents = Number(roundHalfUpBig(BigInt(netCents) * tax.units, 10000))
    totalCents = netCents + taxCents
  } else if (tax.data.mode === 'inclusive') {
    const netOfTax = Number(roundHalfUpBig(BigInt(netCents) * 10000n, 10000n + tax.units))
    taxCents = netCents - netOfTax
    totalCents = netCents
  }
  const totals = { subtotalCents: subtotalCents, discountCents: discountCents, taxCents: taxCents, totalCents: totalCents }
  return { kind: kind, data: data, lines: itemResult.lines, prices: itemResult.prices, totals: totals, templateVersion: templateVersion }
}

function quoteTotalsJson(normalized) {
  const currency = normalized.data.currency
  return {
    subtotal: formatCentsNumber(normalized.totals.subtotalCents),
    discount: formatCentsNumber(normalized.totals.discountCents),
    tax: formatCentsNumber(normalized.totals.taxCents),
    total: formatCentsNumber(normalized.totals.totalCents),
    currency: currency,
    formatted: {
      subtotal: formatMoney(normalized.totals.subtotalCents, currency),
      discount: formatDiscountMoney(normalized.totals.discountCents, currency),
      tax: formatMoney(normalized.totals.taxCents, currency),
      total: formatMoney(normalized.totals.totalCents, currency),
    },
  }
}

function quoteDocxSpec(normalized, dataSha256) {
  const data = normalized.data
  const currency = data.currency
  const totals = normalized.totals
  const itemRows = normalized.lines.map((lineCents, index) => {
    const item = data.items[index]
    return [
      String(index + 1),
      item.desc,
      item.qty,
      item.unit,
      formatCentsNumber(normalized.prices[index]),
      formatCentsNumber(lineCents),
    ]
  })
  const scopeBullets = []
  for (const line of data.scope.included) scopeBullets.push('包含：' + line)
  for (const line of data.scope.excluded) scopeBullets.push('不包含：' + line)
  for (const line of data.scope.assumptions) scopeBullets.push('假设：' + line)
  const milestoneRows = data.timeline.map((row) => [row.name, row.start, row.end])
  const paymentBullets = data.payment.milestones.map((row) => row.name + ' ' + row.pct + '%' + (row.due ? '，' + row.due : ''))
  if (data.payment.terms) paymentBullets.push('付款条件：' + data.payment.terms)
  // 0.4.3 (043-5): v2 `payment.channels` renders as plain-text 付款方式 rows (a
  // copied mask / https URL, never a hyperlink and never fetched); v1 has none.
  const paymentChannels = Array.isArray(data.payment.channels) ? data.payment.channels : []
  const taxLabel = data.tax.mode === 'inclusive' ? '税额（含税价内）' : data.tax.mode === 'exclusive' ? '税额（未税价外加）' : '税额（未计）'
  const totalsRows = [
    ['小计', formatMoney(totals.subtotalCents, currency)],
    ['折扣', formatDiscountMoney(totals.discountCents, currency)],
    [taxLabel, formatMoney(totals.taxCents, currency)],
    ['合计', formatMoney(totals.totalCents, currency)],
  ]
  const sections = [
    {
      heading: '双方信息',
      table: {
        headers: ['角色', '名称', '联系人', '地址'],
        rows: [
          ['报价方', data.issuer.name, data.issuer.contact ?? '', data.issuer.address ?? ''],
          ['客户', data.client.name + (data.client.company ? '（' + data.client.company + '）' : ''), data.client.contact ?? '', data.client.address ?? ''],
        ],
      },
    },
    { heading: '需求理解', paragraphs: [data.project.name + (data.project.summary && data.project.summary.length ? ' — ' + data.project.summary : '（详见范围与交付物）')] },
    { heading: '范围与假设', bullets: scopeBullets.length ? scopeBullets : ['待双方书面确认'] },
    { heading: '交付物与里程碑', bullets: data.project.deliverables.length ? data.project.deliverables : ['以双方书面确认的交付物为准'], ...(milestoneRows.length ? { table: { headers: ['阶段', '开始', '结束'], rows: milestoneRows } } : {}) },
    { heading: '报价明细', table: { headers: ['序号', '项目', '数量', '单位', '单价', '小计'], rows: itemRows.length ? itemRows : [['1', '（见范围）', '1', '项', formatMoney(0, currency), formatMoney(0, currency)]] } },
    { heading: '金额汇总', table: { headers: ['项目', '金额'], rows: totalsRows } },
    { heading: '付款条件', bullets: paymentBullets.length ? paymentBullets : ['以双方书面确认的付款条件为准'] },
    ...(paymentChannels.length ? [{ heading: '付款方式', table: { headers: ['方式', '收款信息', '备注'], rows: paymentChannels.map((channel) => [paymentChannelKindLabel(channel.kind), paymentChannelSummary(channel), channel.note ?? '']) } }] : []),
    { heading: '变更流程', paragraphs: [data.changeProcess] },
    { heading: '签章', paragraphs: ['报价方（签章）：' + (data.signature.issuerName ? ' ' + data.signature.issuerName : ''), '客户（签章）：' + (data.signature.clientName ? ' ' + data.signature.clientName : '')] },
    { heading: '免责声明', paragraphs: [data.disclaimer] },
    { heading: '校验', paragraphs: ['模板版本：' + (normalized.templateVersion ?? QUOTE_TEMPLATE_VERSION), '数据哈希（SHA-256）：' + dataSha256] },
  ]
  return { title: '报价单', subtitle: data.quoteNo + ' · 日期 ' + data.issuedAt + ' · 有效期至 ' + data.validUntil, sections: sections }
}

function proposalDocxSpec(normalized, dataSha256) {
  const data = normalized.data
  const currency = data.currency
  const paymentChannels = Array.isArray(data.payment.channels) ? data.payment.channels : []
  const sections = [
    { heading: '背景与目标', paragraphs: [data.project.summary && data.project.summary.length ? data.project.summary : data.project.name] },
    { heading: '范围（包含）', bullets: data.scope.included.length ? data.scope.included : ['以双方书面确认的范围为准'] },
    { heading: '范围（不包含）', bullets: data.scope.excluded.length ? data.scope.excluded : ['（未特别列出的工作不包含在本提案内）'] },
    { heading: '交付物', bullets: data.project.deliverables },
    {
      heading: '里程碑与验收标准',
      ...(data.timeline.length ? { table: { headers: ['阶段', '开始', '结束'], rows: data.timeline.map((row) => [row.name, row.start, row.end]) } } : { paragraphs: ['里程碑以双方书面确认的时间表为准。'] }),
      bullets: ['验收标准：各阶段以书面确认的交付物为验收依据。'],
    },
    { heading: '假设与依赖', bullets: data.scope.assumptions.length ? data.scope.assumptions : ['（无特别假设）'] },
    { heading: '双方职责', bullets: ['报价方：按约定完成交付物，并主动同步进度与风险。', '客户：按约定提供资料、反馈与验收确认。'] },
    {
      heading: '费用概要',
      ...(data.items.length
        ? { table: { headers: ['项目', '金额'], rows: [['小计', formatMoney(normalized.totals.subtotalCents, currency)], ['折扣', formatDiscountMoney(normalized.totals.discountCents, currency)], ['税额', formatMoney(normalized.totals.taxCents, currency)], ['合计', formatMoney(normalized.totals.totalCents, currency)]] } }
        : { paragraphs: ['费用另行书面确认（本提案不构成报价）。'] }),
    },
    ...(paymentChannels.length ? [{ heading: '付款方式', table: { headers: ['方式', '收款信息', '备注'], rows: paymentChannels.map((channel) => [paymentChannelKindLabel(channel.kind), paymentChannelSummary(channel), channel.note ?? '']) } }] : []),
    { heading: '风险与变更', paragraphs: [data.changeProcess] },
    { heading: '有效期与免责声明', paragraphs: ['有效期至 ' + data.validUntil + '。', data.disclaimer] },
    { heading: '签章', paragraphs: ['报价方（签章）：' + (data.signature.issuerName ? ' ' + data.signature.issuerName : ''), '客户（签章）：' + (data.signature.clientName ? ' ' + data.signature.clientName : '')] },
    { heading: '校验', paragraphs: ['模板版本：' + (normalized.templateVersion ?? QUOTE_TEMPLATE_VERSION), '数据哈希（SHA-256）：' + dataSha256] },
  ]
  return { title: '项目提案', subtitle: data.client.name + ' · ' + data.project.name + ' · ' + data.quoteNo + ' · 日期 ' + data.issuedAt + ' · 有效期至 ' + data.validUntil, sections: sections }
}

function quoteXlsxSpec(normalized, dataSha256) {
  const data = normalized.data
  const currency = data.currency
  const rows = normalized.lines.map((lineCents, index) => {
    const item = data.items[index]
    return {
      index: String(index + 1),
      desc: item.desc,
      qty: item.qty,
      unit: item.unit,
      unitPrice: formatCentsNumber(normalized.prices[index]),
      subtotal: formatCentsNumber(lineCents),
    }
  })
  const summary = [
    { index: '', desc: '小计', qty: '', unit: '', unitPrice: '', subtotal: formatMoney(normalized.totals.subtotalCents, currency) },
    { index: '', desc: '折扣', qty: '', unit: '', unitPrice: '', subtotal: formatDiscountMoney(normalized.totals.discountCents, currency) },
    { index: '', desc: '税额', qty: '', unit: '', unitPrice: '', subtotal: formatMoney(normalized.totals.taxCents, currency) },
    { index: '', desc: '合计', qty: '', unit: '', unitPrice: '', subtotal: formatMoney(normalized.totals.totalCents, currency) },
  ]
  // Header metadata + verification block travel inside the sheet so
  // `verify --content --template quote --data <json>` can re-check identity,
  // totals and data hash on XLSX exactly like on DOCX.
  const metaRow = (label) => ({ index: '', desc: label, qty: '', unit: '', unitPrice: '', subtotal: '' })
  const paymentChannels = Array.isArray(data.payment.channels) ? data.payment.channels : []
  const meta = [
    metaRow('报价单：' + data.quoteNo),
    metaRow('客户：' + data.client.name + (data.client.company ? '（' + data.client.company + '）' : '')),
    metaRow('项目：' + data.project.name),
    metaRow('日期：' + data.issuedAt),
    metaRow('有效期至：' + data.validUntil),
    metaRow('数据哈希（SHA-256）：' + dataSha256),
    // 0.4.3 (043-5): v2 metadata only, so v1 XLSX bytes stay unchanged.
    ...(data.schemaVersion === 2 ? [metaRow('模板版本：' + (normalized.templateVersion ?? QUOTE_TEMPLATE_VERSION))] : []),
    ...paymentChannels.map((channel) => metaRow('付款方式：' + paymentChannelKindLabel(channel.kind) + ' ' + paymentChannelSummary(channel))),
    metaRow('本文件由本地模板确定性生成，仅供商务沟通参考'),
    metaRow(''),
  ]
  return {
    sheet: '报价明细',
    columns: [
      { header: '序号', key: 'index', width: 8 },
      { header: '项目', key: 'desc', width: 32 },
      { header: '数量', key: 'qty', width: 10 },
      { header: '单位', key: 'unit', width: 10 },
      { header: '单价', key: 'unitPrice', width: 16 },
      { header: '小计', key: 'subtotal', width: 16 },
    ],
    rows: meta.concat(rows).concat(summary),
    formulas: [],
  }
}

async function loadOfficeBarrel() {
  if (process.env.ADVISERS_OFFICE_LOCAL === '1') return import('../../office/dist/index.js')
  try {
    return await import('advisers-office')
  } catch {
    try { return await import('../../office/dist/index.js') } catch { return null }
  }
}

async function readOfficeText(file, ext) {
  const readModule = await importOfficeSubmodule('read')
  const readOffice = readModule?.readOffice
  const officeToText = readModule?.officeToText
  if (typeof readOffice !== 'function' || typeof officeToText !== 'function') return null
  try {
    const doc = await readOffice(readFileSync(file), ext)
    return officeToText(doc, 200000)
  } catch { return null }
}

function quoteTemplateChecks(kind, normalized, dataSha256, text) {
  const data = normalized.data
  const currency = data.currency
  const totals = normalized.totals
  const checks = []
  const check = (id, ok, detail) => checks.push({ id: id, ok: Boolean(ok), ...(detail ? { detail: detail } : {}) })
  const expected = [
    data.client.name,
    data.project.name,
    data.quoteNo,
    data.issuedAt,
    data.validUntil,
  ]
  const prefix = kind === 'proposal' ? 'proposal' : 'quote'
  const hasFeeItems = normalized.data.items.length > 0
  if (hasFeeItems) expected.push(formatMoney(totals.totalCents, currency))
  if (kind === 'proposal') expected.push(data.project.deliverables[0] ?? '', data.scope.included[0] ?? '', '项目提案')
  check(prefix + '.required', expected.every((value) => !value || text.includes(value)), 'missing required document text')
  if (hasFeeItems) check(prefix + '.totals', [formatMoney(totals.subtotalCents, currency), formatDiscountMoney(totals.discountCents, currency), formatMoney(totals.taxCents, currency), formatMoney(totals.totalCents, currency)].every((value) => text.includes(value)), 'totals in the document do not match the input data')
  else check(prefix + '.totals', true, 'no fee items in this input; totals not applicable')
  check(prefix + '.data_hash', text.includes(dataSha256), 'dataSha256 not found in the document')
  // 0.4.3 (043-5, plan 93 §3): schemaVersion 2 adds payment.channels blockers.
  // v1 inputs get no extra checks and therefore keep the 0.4.2 verdicts.
  if (data.schemaVersion === 2) {
    const channels = Array.isArray(data.payment.channels) ? data.payment.channels : []
    const requiredTexts = channels.flatMap((channel) => paymentChannelRequiredTexts(channel))
    check(prefix + '.payment_channels', requiredTexts.every((value) => text.includes(value)), 'payment channel mask/url missing from the document')
    const links = channels.filter((channel) => channel.kind === 'stripe_link' || channel.kind === 'wise_link')
    check(prefix + '.payment_url', links.every((channel) => isAllowedPaymentUrl(channel.kind, channel.url) && text.includes(channel.url)), 'payment link missing or not an allowed https host')
    // Only the 付款方式 section is scanned; when the section cannot be located
    // the check degrades honestly to ok+skipped instead of pretending to pass.
    const anchor = text.indexOf('付款方式')
    if (anchor === -1) check(prefix + '.no_full_account', true, 'skipped: 付款方式 section not locatable')
    else {
      const tail = text.slice(anchor + '付款方式'.length)
      const nextHeading = tail.search(/变更流程|签章|免责声明|校验|风险与变更|有效期/)
      const sectionText = nextHeading === -1 ? tail : tail.slice(0, nextHeading)
      check(prefix + '.no_full_account', findFullAccountNumbers(sectionText).length === 0, 'a full 13-19 digit account number appears in the payment section')
    }
  }
  const placeholder = /\{\{|T[O]DO|TBD|F[I]XME|占位|待填写|undefined|NaN/.test(text)
  check(prefix + '.no_placeholders', !placeholder, 'placeholder text found')
  return checks
}

/** 'advisers template quote|proposal <data.json> <out>' — new deterministic templates. */
async function templateQuoteOrProposal(name, dataFile, outFile, flags) {
  try {
    if (!dataFile || !outFile) throw templateDataError('usage: advisers template ' + name + ' <data.json> <out.docx|out.xlsx>', '$')
    const ext = outFile.split('.').pop()?.toLowerCase()
    const expected = name === 'quote' ? ['docx', 'xlsx'] : ['docx']
    if (!expected.includes(ext)) {
      const error = new Error('template ' + name + ' writes ' + expected.join('/') + '; got .' + ext)
      error.code = 'E_TEMPLATE_OUTPUT'
      throw error
    }
    let raw
    try {
      raw = JSON.parse(readFileSync(dataFile, 'utf8'))
    } catch (error) {
      const wrapped = new Error('cannot read template data JSON: ' + error.message)
      wrapped.code = 'E_TEMPLATE_INVALID'
      throw wrapped
    }
    const normalized = normalizeQuoteData(raw, name)
    const evidence = await loadEvidence()
    const dataSha256 = evidence.sha256Hex(evidence.stableStringify(normalized.data, { space: 0 }))
    // Import only the dist submodules the chosen format needs (build +
    // validate + deterministic content checks), never the office barrel: the
    // barrel also pulls exceljs/pptxgenjs and costs seconds per CLI start.
    const builderModule = ext === 'docx' ? await importOfficeSubmodule('docx') : await importOfficeSubmodule('xlsx')
    const validateModule = await importOfficeSubmodule('validate')
    const checkModule = await importOfficeSubmodule('check')
    let buffer
    let structure
    let content
    if (ext === 'docx') {
      const spec = name === 'quote' ? quoteDocxSpec(normalized, dataSha256) : proposalDocxSpec(normalized, dataSha256)
      if (typeof builderModule?.buildDocx === 'function') buffer = await builderModule.buildDocx(spec)
      else {
        const mod = await loadOfficeBarrel()
        if (!mod || typeof mod.buildDocx !== 'function') throw Object.assign(new Error('advisers-office is not installed; run: npm i -g advisers-office@next'), { code: 'E_TEMPLATE_INVALID' })
        buffer = await mod.buildDocx(spec)
      }
    } else {
      if (typeof builderModule?.buildXlsx === 'function') buffer = await builderModule.buildXlsx(quoteXlsxSpec(normalized, dataSha256))
      else {
        const mod = await loadOfficeBarrel()
        if (!mod || typeof mod.buildXlsx !== 'function') throw Object.assign(new Error('advisers-office is not installed; run: npm i -g advisers-office@next'), { code: 'E_TEMPLATE_INVALID' })
        buffer = await mod.buildXlsx(quoteXlsxSpec(normalized, dataSha256))
      }
    }
    if (typeof validateModule?.validateOffice === 'function') structure = await validateModule.validateOffice(buffer, ext)
    else {
      const mod = await loadOfficeBarrel()
      if (!mod || typeof mod.validateOffice !== 'function') throw Object.assign(new Error('advisers-office is not installed; run: npm i -g advisers-office@next'), { code: 'E_TEMPLATE_INVALID' })
      structure = await mod.validateOffice(buffer, ext)
    }
    if (typeof checkModule?.checkOffice === 'function') content = await checkModule.checkOffice(buffer, ext)
    if (!structure || structure.ok !== true) {
      const error = new Error('generated ' + ext + ' failed structural validation' + (structure && structure.missing && structure.missing.length ? ': ' + structure.missing.join('; ') : ''))
      error.code = 'E_VERIFY_FAILED'
      throw error
    }
    mkdirSync(dirname(outFile), { recursive: true })
    await backupCliFile(outFile)
    writeFileSync(outFile, buffer)
    dbStore()?.appendAudit({ actor: 'local', action: 'office.template', allowed: true, reason: name })
    let deliveryId
    if (flags['record-delivery'] === true) {
      recordDeliveryWithAudit({
        files: [outFile],
        tool: 'template:' + name,
        title: typeof flags.title === 'string' ? flags.title : (name === 'quote' ? '报价单' : '项目提案'),
        validation: ext + ((content && content.ok === false) ? ':content-warn' : ':ok'),
        audit: { actor: 'local', action: 'template.record', allowed: true, reason: name },
        matterId: typeof flags.matter === 'string' ? flags.matter : undefined,
        // 0.3.0 delivery lineage: the template version/quote number/data hash are
        // known at generation time; the store snapshots client/project from the
        // delivery's matter. A receipt generated later reads this row instead of
        // recomputing (or worse, guessing) the lineage.
        templateName: name,
        templateVersion: normalized.templateVersion ?? QUOTE_TEMPLATE_VERSION,
        quoteNo: normalized.data.quoteNo,
        dataSha256: dataSha256,
      })
      try { deliveryId = dbStore()?.listDeliveries(1)?.[0]?.id } catch {}
    }
    if (flags.json === true) {
      console.log(JSON.stringify({
        ok: true,
        command: 'template',
        template: name,
        format: ext,
        out: outFile,
        bytes: buffer.length,
        templateVersion: normalized.templateVersion ?? QUOTE_TEMPLATE_VERSION,
        dataSha256: dataSha256,
        quoteNo: normalized.data.quoteNo,
        totals: quoteTotalsJson(normalized),
        verify: { structure: structure, content: content ?? null },
        ...(deliveryId ? { deliveryId: deliveryId } : {}),
      }, null, 2))
      return
    }
    console.log('wrote ' + outFile + ' (' + buffer.length + ' bytes)')
    console.log('合计：' + formatMoney(normalized.totals.totalCents, normalized.data.currency))
  } catch (error) {
    templateFail(error)
  }
}

/**
 * 'advisers template ...' dispatcher.
 * quote/proposal are the 0.2.3 product templates (deterministic Office builders,
 * no model); every pre-0.2.3 template name keeps the exact legacy behaviour.
 */
async function template(rawArgs) {
  const parsed = parseFlags(rawArgs)
  const positional = parsed.positional
  const name = positional[0]
  if (name === 'quote' || name === 'proposal') return templateQuoteOrProposal(name, positional[1], positional[2], parsed.flags)
  return legacyTemplate(name, positional[1], positional[2])
}

async function legacyTemplate(name, dataFile, outFile) {
  const names = ['weekly', 'budget', 'presentation', 'flow', 'mindmap', 'minutes', 'notice']
  if (!names.includes(name) || !dataFile || !outFile) {
    console.error('usage: advisers template quote|proposal <data.json> <out.docx>   or   advisers template <weekly|budget|presentation|flow|mindmap|minutes|notice> <data.json> <out>')
    process.exitCode = 1
    return
  }
  let mod
  if (process.env.ADVISERS_OFFICE_LOCAL === '1') {
    mod = await import('../../office/dist/index.js')
  } else {
    try {
      mod = await import('advisers-office')
    } catch {
      console.error('advisers-office is not installed; run `npm i -g advisers-office@next`')
      process.exitCode = 1
      return
    }
  }
  const data = JSON.parse(readFileSync(dataFile, 'utf8'))
  const spec = name === 'weekly' ? mod.weeklyReport(data)
    : name === 'budget' ? mod.budget(data)
    : name === 'presentation' ? mod.presentation(data)
    : name === 'flow' ? mod.flow(data)
    : name === 'minutes' ? mod.meetingMinutes(data)
    : name === 'notice' ? mod.notice(data)
    : mod.mindmap(data)
  mkdirSync(dirname(outFile), { recursive: true })
  const ext = outFile.split('.').pop()?.toLowerCase()
  const expected = name === 'budget' ? ['xlsx'] : name === 'presentation' ? ['pptx'] : (name === 'flow' || name === 'mindmap') ? ['mmd', 'mermaid', 'drawio'] : ['docx']
  if (!expected.includes(ext)) { console.error(`template ${name} writes ${expected.join('/')}; got .${ext}`); process.exitCode = 1; return }
  let buffer
  let result
  if (ext === 'docx') {
    buffer = await mod.buildDocx(spec); result = await mod.validateOffice(buffer, 'docx')
  } else if (ext === 'xlsx') {
    buffer = await mod.buildXlsx(spec); result = await mod.validateOffice(buffer, 'xlsx')
  } else if (ext === 'pptx') {
    buffer = await mod.buildPptx(spec); result = await mod.validateOffice(buffer, 'pptx')
  } else if (ext === 'xmind') {
    buffer = await mod.buildXmind(spec); result = await mod.validateXmind(buffer)
  } else if (ext === 'drawio') {
    await backupCliFile(outFile)
    writeFileSync(outFile, mod.buildDrawio(spec)); console.log(`wrote ${outFile}`); return
  } else {
    await backupCliFile(outFile)
    writeFileSync(outFile, mod.buildMermaid(spec)); console.log(`wrote ${outFile}`); return
  }
  await backupCliFile(outFile)
  writeFileSync(outFile, buffer)
  dbStore()?.appendAudit({ actor: 'local', action: 'office.template', allowed: true, reason: outFile })
  recordManualDelivery([outFile], 'template', name, result)
  console.log(result.ok ? `wrote ${outFile} (${buffer.length} bytes)` : `wrote ${outFile}, missing: ${result.missing.join(', ')}`)
  if (!result.ok) process.exitCode = 1
}

async function documentReview(args) {
  const { flags, positional } = parseFlags(args)
  const file = positional[0]
  if (!file) { console.error('usage: advisers review <file> --request "..."'); process.exitCode = 1; return }
  const apiKey = process.env.ADVISERS_API_KEY
  if (!apiKey) { console.error('document review requires ADVISERS_API_KEY'); process.exitCode = 1; return }
  const reviewLedger = loadLedger()
  const reviewDenied = egressDeniedReason(reviewLedger.getMatter(activeMatterId(reviewLedger)), 'review')
  if (reviewDenied) { console.error(reviewDenied); process.exitCode = 1; return }
  let mod
  if (process.env.ADVISERS_OFFICE_LOCAL === '1') mod = await import('../../office/dist/index.js')
  else { try { mod = await import('advisers-office') } catch { mod = await import('../../office/dist/index.js') } }
  const doc = await mod.readOffice(readFileSync(file))
  const { reviewDocument } = await loadDocReview()
  const result = await reviewDocument({ text: mod.officeToText(doc, 20_000), request: flags.request, apiKey, baseUrl: process.env.ADVISERS_BASE_URL, model: process.env.ADVISERS_MODEL })
  dbStore()?.appendAudit({ actor: 'local', action: 'doc.review', allowed: !result.findings.some((f) => f.severity === 'blocker'), reason: file })
  console.log(result.summary || '(no summary)')
  for (const f of result.findings) console.log(`[${f.severity}] ${f.message}${f.evidence ? `（原文：${f.evidence}）` : ''}`)
  if (result.invalid) { console.error('review output was not valid JSON'); process.exitCode = 1 }
  if (result.findings.some((f) => f.severity === 'blocker')) process.exitCode = 1
}

async function research(args) {
  const { flags, positional } = parseFlags(args)
  if (!flags.web && !flags.url) { console.error('research requires explicit --web or --url (egress)'); process.exitCode = 1; return }
  const apiKey = process.env.ADVISERS_API_KEY
  if (!apiKey) { console.error('research requires ADVISERS_API_KEY'); process.exitCode = 1; return }
  const query = positional.join(' ').trim()
  const urls = flags.url ? [String(flags.url)] : []
  if (!query && !urls.length) { console.error('usage: advisers research --web|--url <url> [--deep] <query>'); process.exitCode = 1; return }
  const ledger = loadLedger()
  const matterId = activeMatterId(ledger)
  const denied = egressDeniedReason(ledger.getMatter(matterId), 'research')
  if (denied) { console.error(denied); process.exitCode = 1; return }
  // Privacy audit P1-2: the library already redacts upstream bodies, but the CLI
  // must not print stacks/upstream text either. Print only stable status + code.
  let result
  try {
    const { research: runResearch } = await loadResearch()
    result = await runResearch({ query, urls, apiKey, baseUrl: process.env.ADVISERS_BASE_URL, deep: Boolean(flags.deep) })
  } catch (error) {
    const status = Number.isFinite(Number(error?.status)) ? `HTTP ${Number(error.status)} ` : ''
    const rawCode = String(error?.code ?? error?.name ?? 'RESEARCH_FAILED').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40)
    console.error(`research failed: ${status}(${rawCode || 'RESEARCH_FAILED'})`)
    console.error('Upstream response bodies and stack traces are not printed. Check ADVISERS_API_KEY, ADVISERS_BASE_URL and the network, then run `advisers doctor`.')
    process.exitCode = 1
    return
  }
  const store = dbStore()
  store?.addResearchRun({ matterId, query: query || urls[0], answer: result.answer, sources: result.sources, usage: result.usage, stopReason: result.stopReason })
  store?.appendAudit({ actor: 'local', action: 'egress.research', allowed: true, reason: `${urls.length ? 'url' : 'search'}:${result.sources.length}` })
  console.log(result.answer.trim())
  if (result.sources.length) {
    console.log('\n来源：')
    for (const source of result.sources) console.log(`- ${source.title || '(untitled)'} ${source.url}${source.pageAge ? ` (${source.pageAge.slice(0, 10)})` : ''}`)
    console.log('提示：网页引用是服务商返回，不等于本地文件证据。')
  }
}

/**
 * Source v2 write path (docs/SOURCE-SCHEMA.md).
 *
 * normalizeSource() maps v1/ad-hoc provenance (email -> mail, sessionId/turnId ->
 * ref, speakers -> speaker, file path -> basename) and preserves unknown fields
 * as extensions; validateSource() rejects a source with no real pointer and no
 * quote, so an invented provenance row is never written. A plain capture without
 * import metadata uses type "conversation" plus the local turn reference.
 */
async function buildCaptureSource({ meta, quote, ref, capturedAt }) {
  const { normalizeSource, validateSource } = await loadSource()
  const raw = { ...(meta && typeof meta === 'object' ? meta : {}) }
  raw.type = raw.type ?? 'conversation'
  if (quote) raw.quote = quote
  if (ref) raw.ref = ref
  if (!raw.capturedAt) raw.capturedAt = capturedAt
  const checked = validateSource(raw)
  if (!checked.ok) throw new Error(`invalid source: ${checked.errors.join('; ')}`)
  return normalizeSource(raw)
}

/**
 * Run the capture model and persist pending candidates (never auto-accept).
 * @returns {Promise<{count: number, candidates: object[]}>}
 */
async function proposeCaptureText({ text, source = 'wechat', date, matterId, meta = {}, store, json = false }) {
  const { captureCandidates } = await loadCapture()
  const result = await captureCandidates({ text, apiKey: process.env.ADVISERS_API_KEY, baseUrl: process.env.ADVISERS_BASE_URL, model: process.env.ADVISERS_MODEL, date, source })
  if (!result.candidates.length) return { count: 0, candidates: [] }
  const conversationId = latestConversationId()
  const turn = store.addTurn({ conversationId, role: 'user', content: text })
  const capturedAt = new Date().toISOString()
  const created = []
  for (const c of result.candidates) {
    const evidenceSource = await buildCaptureSource({ meta, quote: c.quote, ref: `${conversationId}#${turn.id}`, capturedAt })
    const candidate = store.proposeCandidate({
      kind: 'commitment',
      payload: { matterId, debtor: c.debtor === 'third' ? 'third' : 'user', creditor: c.creditor || 'someone', action: c.action, dueAt: c.dueAt, capability: 'none' },
      evidence: [{ quote: c.quote, turnId: turn.id, sessionId: conversationId, source: evidenceSource }],
    })
    created.push(candidate)
    if (!json) console.log(`${candidate.id}\t${c.modal}\t${c.action}${c.dueAt ? ` · ${c.dueAt.slice(0, 10)}` : ''}\t「${c.quote.slice(0, 60)}」`)
  }
  store.appendAudit({ actor: 'local', action: 'capture.propose', allowed: true, reason: `${created.length} candidates` })
  return { count: created.length, candidates: created }
}

/** Read all of stdin for `capture --file -` (bounded before normalisation). */
async function readCaptureStdin({ maxChars = 1_000_000 } = {}) {
  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk
    if (text.length > maxChars) break
  }
  return text
}

/** Report a capture input refusal (E_CAPTURE_EMPTY / E_CAPTURE_TOO_LONG). */
function reportCaptureInputFailure(failure, asJson = false) {
  if (asJson) console.error(JSON.stringify({ error: { code: failure.code, message: failure.message } }))
  else console.error('advisers: ' + failure.code + ': ' + failure.message)
  process.exitCode = 1
}

/** Best-effort row array for the optional capture hints (never throws). */
function captureHintRows(value) {
  if (Array.isArray(value)) return value
  for (const key of ['rows', 'clients', 'projects', 'items']) {
    if (Array.isArray(value?.[key])) return value[key]
  }
  return []
}

/**
 * 0.4.3 (043-2, plan 92 §2): capture without an API key.
 *
 * `--file -` / positional `-` read stdin; `--local`/`--rules` force the
 * deterministic local rules even when a key exists; with neither flag the old
 * behaviour wins when ADVISERS_API_KEY is set (model path unchanged), while a
 * keyless machine now succeeds through the local rules instead of erroring.
 * The local path is zero-network: the only network entry is the model branch.
 */
async function capture(args) {
  const { flags, positional } = parseFlags(args)
  if (flags['from-mail']) return captureFromMail(flags)
  if (flags['from-transcript']) return captureFromTranscript(flags)
  if (flags['from-imap']) return captureFromImap(flags)
  const asJson = flags.json === true
  const stdinRequested = flags.file === '-' || positional[0] === '-'
  const localRequested = flags.local === true || flags.rules === true
  const modelRequested = flags.model === true
  if (localRequested && modelRequested) {
    console.error('advisers: E_USAGE: --local/--rules and --model are mutually exclusive')
    process.exitCode = 1
    return
  }
  let text = positional[0] === '-' ? positional.slice(1).join(' ').trim() : positional.join(' ').trim()
  if (stdinRequested) {
    text = await readCaptureStdin()
  } else if (flags.file) {
    try {
      const { extractAttachment } = await loadAttachments()
      const extracted = await extractAttachment(flags.file, { cwd: process.cwd() })
      if (!extracted.text) throw new Error('no extractable text')
      text = extracted.text
    } catch (error) { console.error(`capture --file failed: ${error.message}`); process.exitCode = 1; return }
  }
  const normalized = await (async () => {
    const { normalizeCaptureText } = await loadCaptureRules()
    return normalizeCaptureText(text)
  })()
  if (!normalized.ok) { reportCaptureInputFailure(normalized, asJson); return }
  text = normalized.text
  const apiKey = process.env.ADVISERS_API_KEY
  // Mode selection: explicit --model keeps the 0.4.2 path (and its key error);
  // explicit --local/--rules always stays offline; no flag keeps model when a
  // key is configured and otherwise falls back to the local rules.
  const useLocal = localRequested || (!modelRequested && !apiKey)
  if (!useLocal && !apiKey) { console.error('capture requires ADVISERS_API_KEY'); process.exitCode = 1; return }
  const source = typeof flags.source === 'string' ? flags.source : (stdinRequested ? 'stdin' : 'wechat')
  ensureHome()
  const store = dbStore()
  if (!store) { console.error('capture requires SQLite store'); process.exitCode = 1; return }
  const ledger = loadLedger()
  let matterId
  try { matterId = resolveMatterForCommand(ledger, flags.matter, 'capture') } catch (error) { console.error(error.message); process.exitCode = 1; return }
  if (useLocal) {
    if (!apiKey && !localRequested) console.error('[local] 未配置模型：本地规则生成候选，未出网')
    // Local capture never egresses, so the model-egress gate does not apply; the
    // content safety gate still runs before any candidate is stored.
    const { inspectCaptureText } = await loadCapture()
    try { inspectCaptureText(text) } catch (error) {
      if (asJson) console.error(JSON.stringify({ error: { code: error.code ?? 'E_CONTENT_BLOCKED', message: error.message } }))
      else console.error(error.message)
      process.exitCode = 1
      return
    }
    saveLedger(ledger)
    const { localCaptureCandidates, toCaptureMemoryCandidate } = await loadCaptureRules()
    const local = localCaptureCandidates({
      text,
      source,
      date: typeof flags.date === 'string' ? flags.date : undefined,
      matterId,
      clients: captureHintRows(store.listClients({ limit: 100 })),
      projects: captureHintRows(store.listProjects({ limit: 100 })),
    })
    if (!local.ok) { reportCaptureInputFailure(local, asJson); return }
    if (!local.candidates.length) {
      if (asJson) console.log(JSON.stringify({ ok: true, command: 'capture', source, count: 0, candidates: [] }, null, 2))
      else console.log('没有找到可确认的承诺候选。')
      return
    }
    const conversationId = latestConversationId()
    const turn = store.addTurn({ conversationId, role: 'user', content: text })
    const created = []
    for (const candidate of local.candidates) {
      const mapped = toCaptureMemoryCandidate(candidate, { text, turnId: turn.id, conversationId, matterId })
      if (!mapped) continue
      const stored = store.proposeCandidate(mapped)
      created.push(stored)
      if (!asJson) console.log(`${stored.id}\t${candidate.modal ?? ''}\t${candidate.action}${candidate.dueAt ? ` · ${candidate.dueAt.slice(0, 10)}` : ''}\t「${candidate.quote.slice(0, 60)}」`)
    }
    store.appendAudit({ actor: 'local', action: 'capture.propose.local', allowed: true, reason: created.length + ' candidates' })
    if (asJson) {
      console.log(JSON.stringify({ ok: true, command: 'capture', source, count: created.length, candidates: created }, null, 2))
      return
    }
    if (!created.length) console.log('没有找到可确认的承诺候选。')
    else console.log('确认：advisers memory accept <id>；拒绝：advisers memory reject <id>')
    return
  }
  const denied = egressDeniedReason(ledger.getMatter(matterId), 'capture')
  if (denied) { console.error(denied); process.exitCode = 1; return }
  saveLedger(ledger)
  const result = await proposeCaptureText({ text, source, date: flags.date, matterId, store, json: asJson })
  if (asJson) {
    console.log(JSON.stringify({ ok: true, command: 'capture', source, count: result.count, candidates: result.candidates }, null, 2))
    return
  }
  if (!result.count) console.log('没有找到可确认的承诺候选。')
  else console.log('确认：advisers memory accept <id>；拒绝：advisers memory reject <id>')
}

const PROFILE_USAGE = [
  'usage: advisers profile show [--now ISO] [--json]',
  '       advisers profile export [--md|--json] [--out <file>] [--now ISO]',
].join('\n')

/**
 * 0.4.3 (043-3, plan 90: profile show/export): a read-only view over the
 * preferences table (no writes, no model, no network).
 *
 * The payload is deterministic for the same rows + --now (dataSha256), and
 * unknown/decayed values are shown with their real status, never guessed.
 * `export --out` writes 0600; `--md` uses the library renderer, `--json` the
 * payload itself, and no --out prints to stdout.
 */
async function profileCommand(args) {
  const sub = args[0]
  const usage = PROFILE_USAGE
  try {
    if (!sub || sub === 'help' || sub === '--help') { console.log(PROFILE_USAGE); return }
    if (sub !== 'show' && sub !== 'export') { usageFail('unknown profile subcommand: ' + sub, usage); return }
    const parsed = familyFlags(args.slice(1), { booleans: ['json', 'md'], values: ['out', 'now'] }, usage)
    if (!parsed) return
    const { buildProfile, renderProfileMarkdown } = await loadProfileLib()
    const preferences = mode === 'json'
      ? loadJson().listPreferences({ includeCandidates: true })
      : familyStore().loadPreferences()
    const profile = buildProfile(preferences, parsed.flags.now === undefined ? {} : { now: parsed.flags.now })
    const asJson = parsed.flags.json === true
    if (sub === 'show') {
      if (asJson) { console.log(JSON.stringify(profile, null, 2)); return }
      console.log('profile v' + profile.profileVersion + ' · source=' + profile.source + ' · count=' + profile.count + ' · dataSha256=' + profile.dataSha256)
      if (!profile.count) console.log('（空：还没有偏好记录）')
      for (const group of profile.groups) {
        console.log('[' + group.scope.level + (group.scope.value ? '/' + group.scope.value : '') + '] ' + group.kind + ' (' + group.count + ')')
        for (const entry of group.preferences) {
          const status = entry.status === 'active' ? '' : ' [' + entry.status + ']'
          console.log('  ' + entry.id + '  ' + sanitizeConsoleText(String(entry.statement ?? ''), { max: 200 }) + status)
        }
      }
      return
    }
    const out = typeof parsed.flags.out === 'string' ? parsed.flags.out : undefined
    const body = asJson ? JSON.stringify(profile, null, 2) + '\n' : renderProfileMarkdown(profile)
    if (out === undefined) { process.stdout.write(body); return }
    const resolved = isAbsolute(out) ? out : join(process.cwd(), out)
    try {
      mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 })
      atomicWriteFileSync(resolved, body, { mode: 0o600 })
    } catch (error) {
      console.error('advisers: E_IO: cannot write ' + resolved + ': ' + (error?.message ?? error))
      process.exitCode = 1
      return
    }
    console.log('profile exported: ' + resolved + ' (' + profile.count + ' preferences)')
  } catch (error) { reportFamilyFailure(error) }
}

const INBOX_USAGE = [
  'usage: advisers inbox ls [--source capture|mail|all] [--limit n] [--offset n] [--clearance 0-3] [--json]',
  '       advisers inbox show <candidate-id> [--clearance 0-3] [--json]',
].join('\n')

/**
 * 0.4.3 (043-2, plan 92 §2): read-only inbox over pending memory candidates.
 *
 * The projection is owned by lib/capture-rules.js (clearance filtered before
 * counting); this command only parses flags and renders. It never accepts,
 * rejects or otherwise writes: `memory accept/reject` stays the write surface.
 */
async function inboxCommand(args) {
  const sub = args[0]
  const usage = INBOX_USAGE
  try {
    if (!sub || sub === 'help' || sub === '--help') { console.log(INBOX_USAGE); return }
    const rules = await loadCaptureRules()
    if (sub === 'ls' || sub === 'list') {
      const parsed = familyFlags(args.slice(1), { booleans: ['json'], values: ['source', 'limit', 'offset', 'clearance'] }, usage)
      if (!parsed) return
      const flags = parsed.flags
      const result = rules.inboxList(familyStore(), {
        source: flags.source,
        limit: flags.limit === undefined ? undefined : familyInteger(flags.limit, '--limit', 1, 200),
        offset: flags.offset === undefined ? undefined : familyInteger(flags.offset, '--offset', 0, 1000000),
        clearance: flags.clearance === undefined ? undefined : familyInteger(flags.clearance, '--clearance', 0, 3),
      })
      if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      if (!result.items.length) console.log('（没有待处理的候选）')
      for (const item of result.items) {
        const due = item.dueAt ? '  due ' + String(item.dueAt).slice(0, 10) : ''
        const hints = [item.clientHint ? 'client=' + item.clientHint : null, item.projectHint ? 'project=' + item.projectHint : null].filter(Boolean).join(' ')
        console.log(item.id + '  [' + item.source + '/' + (item.extractor ?? '-') + ']  ' + sanitizeConsoleText(String(item.action ?? '(未命名)'), { max: 200 }) + due + (hints ? '  ' + hints : ''))
        console.log('   「' + sanitizeConsoleText(String(item.quote ?? ''), { max: 120 }) + '」')
        console.log('   → advisers memory accept ' + item.id + ' | reject ' + item.id + ' --reason <not-commitment|request-only|reschedule|marketing|vague|date-wrong|other>')
      }
      console.log('total=' + result.total + ' limit=' + result.limit + ' offset=' + result.offset + ' clearance=' + result.clearance + (result.protectedExcluded ? ' protectedExcluded=' + result.protectedExcluded : '') + (result.skipped ? ' skipped=' + result.skipped : ''))
      return
    }
    if (sub === 'show') {
      const parsed = familyFlags(args.slice(1), { booleans: ['json'], values: ['clearance'] }, usage)
      if (!parsed) return
      const id = parsed.positional[0]
      if (!id) { usageFail('missing candidate id', usage); return }
      const result = rules.inboxShow(familyStore(), id, { clearance: parsed.flags.clearance === undefined ? undefined : familyInteger(parsed.flags.clearance, '--clearance', 0, 3) })
      if (!result.ok) {
        const message = result.code === 'E_POLICY_DENIED' ? 'candidate is above the requested clearance' : 'candidate not found: ' + id
        if (parsed.flags.json) console.error(JSON.stringify({ error: { code: result.code, message, hint: result.hint } }))
        else { console.error('advisers: ' + result.code + ': ' + message); console.error('hint: ' + result.hint) }
        process.exitCode = 1
        return
      }
      if (parsed.flags.json) { console.log(JSON.stringify(result, null, 2)); return }
      const candidate = result.candidate
      console.log(candidate.id + '  ' + candidate.kind + '  ' + candidate.status + '  [' + candidate.source + '/' + (candidate.extractor ?? '-') + ']')
      if (candidate.action) console.log('action: ' + sanitizeConsoleText(candidate.action, { max: 2000 }))
      if (candidate.dueAt) console.log('due: ' + candidate.dueAt + (candidate.dueBasis ? '  (' + candidate.dueBasis + ')' : ''))
      if (candidate.matterId) console.log('matter: ' + candidate.matterId)
      if (candidate.quote) console.log('quote: 「' + sanitizeConsoleText(candidate.quote, { max: 500 }) + '」')
      console.log('payload: ' + JSON.stringify(candidate.payload))
      console.log('evidence: ' + (Array.isArray(candidate.evidence) ? candidate.evidence.length : 0))
      console.log('next: advisers memory accept ' + candidate.id + ' | reject ' + candidate.id + ' --reason <code>')
      return
    }
    usageFail('unknown inbox subcommand: ' + sub, usage)
  } catch (error) { reportFamilyFailure(error) }
}

function parseEmailDate(value) {
  if (!value) return undefined
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

async function captureFromMail(flags) {
  const target = flags['from-mail']
  if (typeof target !== 'string') { console.error('usage: advisers capture --from-mail <file|dir> [--limit n]'); process.exitCode = 1; return }
  const apiKey = process.env.ADVISERS_API_KEY
  if (!apiKey) { console.error('capture --from-mail requires ADVISERS_API_KEY'); process.exitCode = 1; return }
  ensureHome()
  const store = dbStore()
  const ledger = loadLedger()
  let matterId
  try { matterId = resolveMatterForCommand(ledger, flags.matter, 'capture') } catch (error) { console.error(error.message); process.exitCode = 1; return }
  const denied = egressDeniedReason(ledger.getMatter(matterId), 'mail')
  if (denied) { console.error(denied); process.exitCode = 1; return }
  saveLedger(ledger)
  const { parseMbox, parseEml, dedupeKey, toCaptureInput } = await loadImporters()
  let files = []
  try {
    const info = statSync(target)
    files = info.isDirectory() ? readdirSync(target).filter((f) => /\.(eml|mbox)$/i.test(f)).map((f) => join(target, f)) : [target]
  } catch (error) { console.error(`cannot read mail path: ${error.message}`); process.exitCode = 1; return }
  const limit = Math.max(1, Math.min(200, Number(flags.limit) || 20))
  let seen = 0, skipped = 0, failed = 0
  const created = []
  for (const file of files.slice(0, limit)) {
    let messages = []
    try {
      const raw = readFileSync(file, 'utf8')
      messages = extname(file).toLowerCase() === '.mbox' ? parseMbox(raw) : [parseEml(raw)]
    } catch (error) { failed++; console.error(`${file}: ${error.message}`); continue }
    for (const msg of messages) {
      seen++
      const key = dedupeKey('email', msg)
      if (store.hasSeen('import', 'mail', key, 30)) { skipped++; continue }
      const input = toCaptureInput(msg, { source: 'email' })
      if (!input.text.trim()) { skipped++; continue }
      try {
        const result = await proposeCaptureText({
          text: input.text, source: 'email', date: parseEmailDate(msg.date), matterId, store, json: flags.json === true,
          meta: { type: 'mail', messageId: msg.messageId, subject: msg.subject, from: msg.from },
        })
        created.push(...result.candidates)
        store.markSeen('import', 'mail', key)
      } catch (error) { failed++; console.error(`${msg.messageId || file}: ${error.message}`) }
    }
  }
  store.appendAudit({ actor: 'local', action: 'import.mail', allowed: true, reason: `${seen} seen, ${created.length} candidates, ${failed} failed` })
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, command: 'capture --from-mail', seen, skipped, failed, count: created.length, candidates: created }, null, 2))
    return
  }
  console.log(`mail import: ${seen} messages, ${created.length} candidates, ${skipped} skipped, ${failed} failed`)
}

async function captureFromTranscript(flags) {
  const file = flags['from-transcript']
  if (typeof file !== 'string') { console.error('usage: advisers capture --from-transcript <file>'); process.exitCode = 1; return }
  const apiKey = process.env.ADVISERS_API_KEY
  if (!apiKey) { console.error('capture --from-transcript requires ADVISERS_API_KEY'); process.exitCode = 1; return }
  ensureHome()
  const store = dbStore()
  const ledger = loadLedger()
  let matterId
  try { matterId = resolveMatterForCommand(ledger, flags.matter, 'capture') } catch (error) { console.error(error.message); process.exitCode = 1; return }
  const denied = egressDeniedReason(ledger.getMatter(matterId), 'transcript')
  if (denied) { console.error(denied); process.exitCode = 1; return }
  saveLedger(ledger)
  const { parseTranscript, dedupeKey, toCaptureInput } = await loadImporters()
  let parsed
  try { parsed = parseTranscript(readFileSync(file, 'utf8')) } catch (error) { console.error(`cannot parse transcript: ${error.message}`); process.exitCode = 1; return }
  const key = dedupeKey('transcript', parsed)
  if (store.hasSeen('import', 'transcript', key, 30)) {
    if (flags.json) { console.log(JSON.stringify({ ok: true, command: 'capture --from-transcript', alreadyImported: true, count: 0, candidates: [] }, null, 2)); return }
    console.log('transcript already imported')
    return
  }
  const input = toCaptureInput(parsed, { source: 'meeting' })
  if (!input.text.trim()) { console.error('transcript has no text'); process.exitCode = 1; return }
  const result = await proposeCaptureText({
    text: input.text, source: 'meeting', matterId, store, json: flags.json === true,
    meta: { type: 'transcript', file: basename(file), speakers: input.meta?.speakers ?? [] },
  })
  store.markSeen('import', 'transcript', key)
  store.appendAudit({ actor: 'local', action: 'import.transcript', allowed: true, reason: `${result.count} candidates` })
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, command: 'capture --from-transcript', count: result.count, candidates: result.candidates }, null, 2))
    return
  }
  console.log(`transcript import: ${result.count} candidates`)
}

async function captureFromImap(flags) {
  const host = process.env.ADVISERS_IMAP_HOST
  const user = process.env.ADVISERS_IMAP_USER
  const pass = process.env.ADVISERS_IMAP_PASS
  if (!host || !user || !pass) { console.error('capture --from-imap requires ADVISERS_IMAP_HOST / ADVISERS_IMAP_USER / ADVISERS_IMAP_PASS'); process.exitCode = 1; return }
  if (!process.env.ADVISERS_API_KEY) { console.error('capture --from-imap requires ADVISERS_API_KEY'); process.exitCode = 1; return }
  ensureHome()
  const store = dbStore()
  const ledger = loadLedger()
  let matterId
  try { matterId = resolveMatterForCommand(ledger, flags.matter, 'capture') } catch (error) { console.error(error.message); process.exitCode = 1; return }
  const denied = egressDeniedReason(ledger.getMatter(matterId), 'imap')
  if (denied) { console.error(denied); process.exitCode = 1; return }
  saveLedger(ledger)
  const { parseEml, dedupeKey, toCaptureInput } = await loadImporters()
  let messages
  try {
    const { fetchImapMessages } = await loadImap()
    messages = await fetchImapMessages({
      host,
      port: Number(process.env.ADVISERS_IMAP_PORT) || (String(process.env.ADVISERS_IMAP_SECURE) === '0' ? 143 : 993),
      secure: String(process.env.ADVISERS_IMAP_SECURE) !== '0',
      user, pass,
      mailbox: process.env.ADVISERS_IMAP_MAILBOX || 'INBOX',
      sinceDays: Math.max(1, Number(flags['since-days']) || 30),
      limit: Math.max(1, Math.min(100, Number(flags.limit) || 20)),
    })
  } catch (error) { console.error(sanitizeConsoleText('imap failed: ' + (error?.message ?? error), { max: 2000 })); process.exitCode = 1; return }
  let seen = 0, skipped = 0, failed = 0
  const created = []
  for (const msg of messages) {
    seen++
    let parsed
    try { parsed = parseEml(msg.raw.toString('utf8')) } catch (error) { failed++; console.error(sanitizeConsoleText('imap message ' + msg.uid + ': ' + (error?.message ?? error), { max: 2000 })); continue }
    const key = dedupeKey('email', parsed)
    if (store.hasSeen('import', 'imap', key, 30)) { skipped++; continue }
    const input = toCaptureInput(parsed, { source: 'email' })
    if (!input.text.trim()) { skipped++; continue }
    try {
      const result = await proposeCaptureText({ text: input.text, source: 'email', date: parseEmailDate(parsed.date), matterId, store, json: flags.json === true, meta: { type: 'mail', channel: 'imap', uid: msg.uid, messageId: parsed.messageId, subject: parsed.subject, from: parsed.from } })
      created.push(...result.candidates)
      store.markSeen('import', 'imap', key)
    } catch (error) { failed++; console.error(sanitizeConsoleText('imap message ' + msg.uid + ': ' + (error?.message ?? error), { max: 2000 })) }
  }
  store.appendAudit({ actor: 'local', action: 'import.imap', allowed: true, reason: `${seen} seen, ${created.length} candidates, ${failed} failed` })
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, command: 'capture --from-imap', seen, skipped, failed, count: created.length, candidates: created }, null, 2))
    return
  }
  console.log(`imap import: ${seen} messages, ${created.length} candidates, ${skipped} skipped, ${failed} failed (EXAMINE/read-only)`)
}

async function calendarImport(args) {
  const { flags, positional } = parseFlags(args)
  const file = typeof flags.ics === 'string' ? flags.ics : positional[0]
  if (!file) { console.error('usage: advisers calendar import --ics <file>'); process.exitCode = 1; return }
  ensureHome()
  const store = dbStore()
  const ledger = loadLedger()
  const matterId = activeMatterId(ledger)
  const denied = egressDeniedReason(ledger.getMatter(matterId), 'calendar')
  if (denied) { console.error(denied); process.exitCode = 1; return }
  let events
  try {
    const { parseIcs } = await loadImporters()
    events = parseIcs(readFileSync(file, 'utf8'))
  } catch (error) { console.error(`cannot parse ics: ${error.message}`); process.exitCode = 1; return }
  let imported = 0
  for (const e of events) {
    if (!e.uid) continue
    store.upsertCalendarEvent({ uid: e.uid, summary: e.summary, startsAt: e.start, endsAt: e.end, allDay: e.allDay, tzid: e.tzid, location: e.location, rrule: e.rrule, source: basename(file) })
    imported++
  }
  store.appendAudit({ actor: 'local', action: 'calendar.import', allowed: true, reason: `${imported} events` })
  console.log(`calendar import: ${imported} events (read-only)`)
}

/**
 * Read-only expansion of the stored calendar rows into the occurrences that
 * start today (Asia/Shanghai). expandRrule() is pure and bounded; an
 * unsupported/malformed RRULE falls back to the stored DTSTART occurrence, so a
 * bad rule never hides a real meeting.
 */
async function calendarOccurrencesToday() {
  const store = dbStore()
  const localDay = localDayOf(Date.now())
  if (!store) return { localDay, occurrences: [], degraded: [] }
  const { expandRrule } = await loadIcal()
  const occurrences = []
  const degraded = []
  for (const row of store.listCalendarEvents()) {
    // Same TZID rule as agenda: lib/ical.js has no time-zone database, so a
    // non-Shanghai row is skipped and reported, never shown at a guessed +08:00
    // time (13-mail-calendar C5).
    if (!calendarTzidSupported(row)) {
      degraded.push({ source: 'calendar', code: 'E_CALENDAR_SKIP', id: row.uid ?? null, reason: 'unsupported tzid: ' + calendarTzidOf(row) })
      continue
    }
    let instances
    try { instances = expandRrule(row, { from: localDay, to: localDay }) } catch (error) {
      degraded.push({ source: 'calendar', code: 'E_CALENDAR_SKIP', id: row.uid ?? null, reason: String(error?.message ?? error) })
      continue
    }
    for (const instance of instances) {
      occurrences.push({
        uid: instance.uid,
        summary: instance.summary ?? '',
        startsAt: instance.startsAt,
        endsAt: instance.endsAt ?? null,
        allDay: Boolean(instance.allDay),
        recurring: Boolean(instance.recurring),
        location: instance.location ?? null,
        rrule: instance.rrule ?? null,
      })
    }
  }
  occurrences.sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : String(a.summary).localeCompare(String(b.summary))))
  return { localDay, occurrences, degraded }
}

async function printCalendarToday() {
  const { localDay, occurrences, degraded } = await calendarOccurrencesToday()
  if (!occurrences.length) console.log('日历：今天没有本地导入的会议。')
  else {
    console.log('日历（本地只读，' + localDay + '）：')
    for (const e of occurrences) {
      const time = e.allDay ? '全天' : e.startsAt.slice(11, 16)
      console.log('  ' + time + '  ' + sanitizeConsoleText(e.summary, { max: 200 }) + (e.recurring ? '（循环）' : '') + (e.location ? ' · ' + sanitizeConsoleText(e.location, { max: 120 }) : ''))
    }
  }
  if (degraded.length) console.log('日历降级：' + degraded.length + ' 条（非 Asia/Shanghai 时区或无法展开，已跳过）')
}

/** Host header allowlist for the local read-only UI (DNS-rebinding hardening, SEC2-07). */
function isLoopbackHostHeader(host) {
  if (!host) return false
  const value = String(host).trim().toLowerCase()
  const bare = value.startsWith('[')
    ? value.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1')
    : value.replace(/:\d+$/, '')
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1'
}

async function ui(args) {
  const flags = parseFlags(args).flags
  // --port 0 requests an ephemeral port (used by tests and scripts).
  const port = typeof flags.port === 'string' && flags.port.trim() !== '' ? Number(flags.port) : 17860
  // 0.2.3 §4.8: ui only serves a read snapshot. It loads the tables it needs
  // (commitments) through the lock-free read store and holds NO writer lock, so
  // ordinary CLI writes keep working while it runs.
  const ledger = loadReadLedger({ commitments: {} })
  const { buildReminders } = await loadRemind()
  const snapshot = {
    today: () => {
      const open = ledger.openCommitments()
      return { open: open.length, commitments: open.map((c) => ({ id: c.id, action: c.action, dueAt: c.dueAt, creditor: c.creditor })) }
    },
    commitments: () => ledger.listCommitments().map((c) => ({ id: c.id, status: c.status, action: c.action, dueAt: c.dueAt, creditor: c.creditor })),
    who: () => ({ mine: ledger.openCommitments().filter((c) => c.debtor === 'user' || c.debtor === 'agent'), waiting: ledger.openCommitments().filter((c) => c.debtor === 'third' || c.debtor.startsWith('third:')) }),
    reminders: () => buildReminders(ledger, { now: new Date() }),
  }
  const { createReadOnlyServer } = await loadUi()
  const app = createReadOnlyServer({ snapshot, port })
  // SEC2-07: DNS rebinding can point an attacker origin at 127.0.0.1; the
  // library only checks method=GET, so validate Host before its handler runs.
  const handlers = app.server.listeners('request').slice()
  app.server.removeAllListeners('request')
  app.server.on('request', (req, res) => {
    if (!isLoopbackHostHeader(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(JSON.stringify({ error: 'forbidden host header' }))
      return
    }
    for (const handler of handlers) handler.call(app.server, req, res)
  })
  const url = await app.listen()
  console.log(`advisers ui (read-only): ${url}`)
  console.log('Ctrl-C to stop; no writes, no telemetry, 127.0.0.1 only.')
  await new Promise((resolve) => process.once('SIGINT', resolve))
  await app.close()
}

let webhookSecretWarned = false

/** Parse remind --now into a Date (fixed instant for reproducible JSON + planning). */
function parseRemindNow(flags) {
  if (flags.now === undefined) return { date: new Date() }
  if (typeof flags.now !== 'string' || Number.isNaN(Date.parse(flags.now))) return { error: '--now must be an ISO timestamp' }
  return { date: new Date(Date.parse(flags.now)) }
}

const QUIET_HOURS_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/
/** Validate --quiet-hours HH:MM-HH:MM; the value is baked into the scheduler script only. */
function parseQuietHours(value) {
  if (value === undefined) return { value: null }
  if (typeof value !== 'string' || !QUIET_HOURS_RE.test(value)) return { error: '--quiet-hours must be HH:MM-HH:MM (for example 22:00-08:00)' }
  return { value: value }
}

const QUIET_HOURS_PARTS_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/

/** Local minute-of-day in the agenda timezone (deterministic for --now tests). */
function localMinuteOfDay(date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: AGENDA_TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0) % 24
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

/** True when `date` falls inside a validated HH:MM-HH:MM quiet window (cross-midnight supported). */
function isInsideQuietHours(spec, date) {
  const match = QUIET_HOURS_PARTS_RE.exec(String(spec ?? ''))
  if (!match) return false
  const start = Number(match[1]) * 60 + Number(match[2])
  const end = Number(match[3]) * 60 + Number(match[4])
  if (start === end) return false
  const minute = localMinuteOfDay(date)
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

/** Dedupe key for one reminder notification scoped to a local day. */
function reminderNotifyDedupeKey(reminder, localDay) {
  return 'notify:dedupe:' + [reminder.commitmentId, reminder.bucket, reminder.ruleId, localDay].join('|')
}

function localDayOfInstant(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: AGENDA_TIMEZONE }).format(date)
}

/** 0.4.3 (043-4, plan 90 NOW-9): notification cooldown window per commitment. */
const NOTIFY_COOLDOWN_MS = 24 * 3600_000

/** One cooldown key per commitment; no user text in the key. */
function reminderNotifyCooldownKey(commitmentId) {
  return 'notify:cooldown:' + String(commitmentId ?? '').replace(/[\r\n|]/g, '')
}

/**
 * Apply the per-commitment 24h notification cooldown to one delivery batch.
 * A commitment notified in the last 24h is skipped, and the batch itself is
 * deduped by commitment id, so three reminders for the same commitment deliver
 * once (plan 90 NOW-9 acceptance). --force-notify bypasses the cooldown.
 */
function applyNotifyCooldown(store, notifyList, nowDate, { forceNotify = false } = {}) {
  if (forceNotify || !store || typeof store.listMetaByPrefix !== 'function') return { list: notifyList, suppressed: 0 }
  const cutoff = nowDate.getTime() - NOTIFY_COOLDOWN_MS
  const recent = new Map()
  for (const [key, value] of store.listMetaByPrefix('notify:cooldown:')) {
    const at = Date.parse(String(value ?? ''))
    if (Number.isFinite(at)) recent.set(key.slice('notify:cooldown:'.length), at)
  }
  const seen = new Set()
  const list = []
  let suppressed = 0
  for (const reminder of notifyList) {
    const id = String(reminder.commitmentId ?? '')
    const at = recent.get(id)
    if ((Number.isFinite(at) && at > cutoff) || seen.has(id)) { suppressed += 1; continue }
    seen.add(id)
    list.push(reminder)
  }
  return { list, suppressed }
}

/** Start the cooldown for delivered commitments and drop keys older than 7 days. */
function recordNotifyCooldown(store, notifyList, nowDate) {
  if (!store || typeof store.setMeta !== 'function') return
  for (const reminder of notifyList) store.setMeta(reminderNotifyCooldownKey(reminder.commitmentId), nowDate.toISOString())
  if (typeof store.listMetaByPrefix !== 'function' || typeof store.deleteMeta !== 'function') return
  const cutoff = nowDate.getTime() - 7 * 86400_000
  for (const [key, value] of store.listMetaByPrefix('notify:cooldown:')) {
    const at = Date.parse(String(value ?? ''))
    if (Number.isFinite(at) && at < cutoff) store.deleteMeta(key)
  }
}

/** Drop dedupe keys older than 30 local days (bounded metadata growth). */
function pruneNotifyDedupe(store, nowDate) {
  if (!store || typeof store.listMetaByPrefix !== 'function' || typeof store.deleteMeta !== 'function') return
  const cutoff = nowDate.getTime() - 30 * 86400_000
  for (const [key, value] of store.listMetaByPrefix('notify:dedupe:')) {
    const at = Date.parse(String(value ?? ''))
    if (Number.isFinite(at) && at < cutoff) store.deleteMeta(key)
  }
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
function parseHhmm(value, flag) {
  if (typeof value !== 'string' || !HHMM_RE.test(value)) return { error: flag + ' must be HH:MM' }
  const parts = value.split(':').map(Number)
  return { time: value, hour: parts[0], minute: parts[1] }
}

const MORNING_WINDOWS_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
/** Accept a cron day list (1-5, 1,3,5) and derive both cron and schtasks forms. */
function parseMorningDays(value) {
  const text = value === undefined ? '1-5' : String(value).trim()
  if (!/^[0-7](?:[-,][0-7])*$/.test(text)) return { error: '--morning-days must be a cron day list like 1-5 or 1,3,5' }
  const numeric = []
  for (const part of text.split(',')) {
    if (part.includes('-')) {
      const bounds = part.split('-').map(Number)
      const from = Math.min(bounds[0], bounds[1])
      const to = Math.max(bounds[0], bounds[1])
      for (let day = from; day <= to; day++) numeric.push(day % 7)
    } else numeric.push(Number(part) % 7)
  }
  const unique = [...new Set(numeric)]
  if (!unique.length) return { error: '--morning-days must name at least one day' }
  return { cron: text, windows: unique.map((day) => MORNING_WINDOWS_DAYS[day]) }
}

/** m h * * <days> cron schedule from an HH:MM time. */
function cronScheduleFor(timeText, daysCron) {
  const parts = timeText.split(':').map(Number)
  return parts[1] + ' ' + parts[0] + ' * * ' + (daysCron ?? '*')
}

async function remind(args) {
  const { flags, positional } = parseFlags(args)
  ensureHome()
  const sub = positional[0]
  const apply = flags.apply === true
  // 0.2.3 §4.3: only the branches that write (audit rows for install/uninstall/
  // ICS export/delivered reminders) take the writer lock; the plain
  // `remind`/`--json`/`status` reads use the lock-free store and load only
  // commitments. These branches are mutually exclusive with a plain read.
  const mutating = sub === 'install' || sub === 'uninstall' || flags.install === true ||
    flags.uninstall === true || flags.ics !== undefined || flags.deliver === true || flags.notify === true
  const store = mutating ? dbStore() : readStoreOrExit()
  // 0.3.0 P0-T2: reminder planning only reads id/status/action/dueAt/offsets,
  // so a narrow projection replaces the whole-entity commitment load (which
  // cost ~480ms and mapped every row at a 200k-row ledger). Legacy JSON-store
  // mode keeps loadJson().
  let planLedger = null
  const plannerLedger = () => {
    if (planLedger) return planLedger
    if (mode === 'json' || !store) { planLedger = loadJson(); return planLedger }
    planLedger = reminderLedgerFromRows(store.read(() => store.projectCommitmentsForReminders()))
    return planLedger
  }
  const scheduler = await loadScheduler()
  if (sub === 'install' || flags.install) {
    const dir = join(HOME, 'scheduler')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const nodeBin = process.execPath
    const cli = process.argv[1]
    const quiet = parseQuietHours(flags['quiet-hours'])
    if (quiet.error) { usageFail(quiet.error, 'usage: advisers remind install [--apply] [--schedule "0 9 * * *"] [--morning [--morning-time 08:30] [--morning-days 1-5]] [--quiet-hours 22:00-08:00]'); return }
    const withMorning = flags.morning === true
    const remindArgs = [...scheduler.DEFAULT_REMIND_ARGS, ...(quiet.value ? ['--quiet-hours', quiet.value] : [])]
    const remindCommand = scheduler.buildCronCommand({ nodeBin, cliPath: cli, args: remindArgs })
    writeFileSync(join(dir, 'remind.sh'), '#!/bin/sh\n"' + nodeBin + '" "' + cli + '" ' + remindArgs.join(' ') + ' >> "' + join(HOME, 'reminders.log') + '" 2>&1\n', { mode: 0o700 })
    writeFileSync(join(dir, 'remind.ps1'), '& "' + nodeBin + '" "' + cli + '" ' + remindArgs.join(' ') + ' *>> "' + join(HOME, 'reminders.log') + '"\n', { mode: 0o700 })
    let morningCommand
    let morningPlan = null
    if (withMorning) {
      const morningTime = parseHhmm(flags['morning-time'] === undefined ? scheduler.DEFAULT_MORNING_TASK_TIME : flags['morning-time'], '--morning-time')
      if (morningTime.error) { usageFail(morningTime.error, 'usage: advisers remind install --morning [--morning-time 08:30] [--morning-days 1-5]'); return }
      const morningDays = parseMorningDays(flags['morning-days'])
      if (morningDays.error) { usageFail(morningDays.error, 'usage: advisers remind install --morning [--morning-time 08:30] [--morning-days 1-5]'); return }
      morningCommand = scheduler.buildCronCommand({ nodeBin, cliPath: cli, args: scheduler.DEFAULT_MORNING_ARGS })
      writeFileSync(join(dir, 'morning.sh'), '#!/bin/sh\n"' + nodeBin + '" "' + cli + '" ' + scheduler.DEFAULT_MORNING_ARGS.join(' ') + ' >> "' + join(HOME, 'morning.log') + '" 2>&1\n', { mode: 0o700 })
      writeFileSync(join(dir, 'morning.ps1'), '& "' + nodeBin + '" "' + cli + '" ' + scheduler.DEFAULT_MORNING_ARGS.join(' ') + ' *>> "' + join(HOME, 'morning.log') + '"\n', { mode: 0o700 })
      // The second block is opt-in: without --morning the 0.3.2 single-block
      // install (and its exact dry-run output) is unchanged.
      const blocks = process.platform === 'win32'
        ? [
          { marker: scheduler.CRON_MARKER, taskName: scheduler.DEFAULT_TASK_NAME, time: typeof flags.time === 'string' ? flags.time : scheduler.DEFAULT_TASK_TIME, schedule: 'daily', command: remindCommand },
          { marker: scheduler.MORNING_CRON_MARKER, taskName: scheduler.DEFAULT_MORNING_TASK_NAME, time: morningTime.time, schedule: 'weekly', days: morningDays.windows, command: morningCommand },
        ]
        : [
          { marker: scheduler.CRON_MARKER, schedule: typeof flags.schedule === 'string' ? flags.schedule : scheduler.DEFAULT_CRON_SCHEDULE, command: remindCommand },
          { marker: scheduler.MORNING_CRON_MARKER, schedule: cronScheduleFor(morningTime.time, morningDays.cron), command: morningCommand },
        ]
      morningPlan = { blocks, schedule: cronScheduleFor(morningTime.time, morningDays.cron), days: morningDays }
    }
    writeFileSync(join(dir, 'README.txt'), 'Install one of these user-level schedules (opt-in):\nLinux:  systemd --user timer or cron: 0 9 * * * sh ' + join(dir, 'remind.sh') + '\nWindows: Task Scheduler -> run remind.ps1 daily\n' + (withMorning ? 'Morning brief: register morning.sh/.ps1 for ' + morningPlan.schedule + ' (or point Task Scheduler at morning.ps1).\n' : '') + 'Or import ~/.advisers/reminders.ics into your calendar.\n')
    store?.appendAudit({ actor: 'local', action: 'notify.install', allowed: true, reason: dir })
    console.log('scheduler scripts written: ' + dir)
    console.log('opt-in: import ~/.advisers/reminders.ics, or register remind.sh/.ps1 with your OS scheduler.')
    if (withMorning) console.log('morning scripts written: ' + join(dir, 'morning.sh') + ' / morning.ps1')
    const existing = apply ? await readCrontabText() : { ok: false }
    if (withMorning) {
      const plan = scheduler.planSchedulerBlocks({
        platform: process.platform,
        action: 'install',
        dryRun: !apply,
        blocks: morningPlan.blocks,
        ...(existing.ok ? { existingText: existing.text } : {}),
      })
      console.log('schedule: ' + (plan.platform === 'win32' ? scheduler.DEFAULT_TASK_NAME + ' daily ' + scheduler.DEFAULT_TASK_TIME : morningPlan.blocks[0].schedule))
      console.log('morning schedule: ' + (plan.platform === 'win32' ? scheduler.DEFAULT_MORNING_TASK_NAME + ' weekly ' + morningPlan.blocks[1].time + ' ' + morningPlan.blocks[1].days.join(',') : morningPlan.schedule))
      console.log('command: ' + remindCommand)
      console.log('morning command: ' + morningCommand)
      await applySchedulerPlan(plan, { apply })
      return
    }
    const schedule = typeof flags.schedule === 'string' ? flags.schedule : scheduler.DEFAULT_CRON_SCHEDULE
    const time = typeof flags.time === 'string' ? flags.time : scheduler.DEFAULT_TASK_TIME
    // Windows Task Scheduler has no cron expression: a user cron schedule is
    // accepted for compatibility but the task is registered daily at `time`.
    const winSchedule = process.platform === 'win32' ? 'daily' : schedule
    const plan = scheduler.planScheduler({
      platform: process.platform,
      action: 'install',
      dryRun: !apply,
      command: remindCommand,
      schedule: winSchedule,
      time,
      ...(existing.ok ? { existingText: existing.text } : {}),
    })
    console.log('schedule: ' + (plan.platform === 'win32' ? plan.taskName + ' daily ' + plan.time : plan.schedule))
    console.log('command: ' + remindCommand)
    await applySchedulerPlan(plan, { apply })
    return
  }
  if (sub === 'uninstall' || flags.uninstall) {
    const dir = join(HOME, 'scheduler')
    const existing = await readCrontabText()
    // 0.4.0: remove BOTH owned blocks precisely (remind + morning) and leave
    // every unmanaged crontab line byte-identical.
    const plan = process.platform === 'win32'
      ? scheduler.planSchedulerBlocks({
        platform: 'win32',
        action: 'uninstall',
        dryRun: !apply,
        blocks: [{ taskName: scheduler.DEFAULT_TASK_NAME }, { taskName: scheduler.DEFAULT_MORNING_TASK_NAME }],
      })
      : scheduler.planSchedulerBlocks({
        platform: process.platform,
        action: 'uninstall',
        dryRun: !apply,
        markers: [scheduler.CRON_MARKER, scheduler.MORNING_CRON_MARKER],
        ...(existing.ok ? { existingText: existing.text } : {}),
      })
    await applySchedulerPlan(plan, { apply })
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    store?.appendAudit({ actor: 'local', action: 'notify.uninstall', allowed: true, reason: dir })
    console.log('scheduler scripts removed (calendar events remain in your calendar app).')
    return
  }
  if (sub === 'status' || flags.status) {
    const dir = join(HOME, 'scheduler')
    console.log('scheduler scripts: ' + (existsSync(dir) ? dir : 'not installed (optional)'))
    console.log('reminder log: ' + join(HOME, 'reminders.log'))
    // 0.4.0 status v2: two sections (remind + morning). A 0.3.2 flat file is
    // mapped into the remind section by the library, so old runs still show.
    const status = scheduler.readSchedulerStatusV2({ homeDir: HOME })
    const remindStatus = status.remind ?? {}
    if (!remindStatus.lastRun) console.log('last run: none recorded' + (status.corrupt ? ' (status.json corrupt)' : ''))
    else console.log('last run: ' + remindStatus.lastRun + ' · result=' + (remindStatus.lastResult ?? '-') + ' · count=' + (remindStatus.lastCount ?? '-') + ' · channel=' + (remindStatus.lastChannel ?? '-'))
    const morningStatus = status.morning ?? {}
    if (!morningStatus.lastRun) console.log('morning: none recorded')
    else console.log('morning: ' + morningStatus.lastRun + ' · result=' + (morningStatus.lastResult ?? '-') + ' · count=' + (morningStatus.lastCount ?? '-') + ' · path=' + (morningStatus.lastPath ?? '-'))
    if (process.platform === 'win32') {
      const plan = scheduler.planWindowsStatus({})
      console.log('os plan: ' + plan.commands.map((entry) => entry.command + ' ' + entry.args.join(' ')).join('; ') + '（运行该命令；exit 0 表示已注册）')
      const morningPlan = scheduler.planWindowsStatus({ taskName: scheduler.DEFAULT_MORNING_TASK_NAME })
      console.log('os plan (morning): ' + morningPlan.commands.map((entry) => entry.command + ' ' + entry.args.join(' ')).join('; ') + '（运行该命令；exit 0 表示已注册）')
    } else if (scheduler.CRON_PLATFORMS.includes(process.platform)) {
      const existing = await readCrontabText()
      if (existing.ok) {
        const plan = scheduler.planCronStatus({ existingText: existing.text })
        console.log(plan.installed ? 'os plan: installed (' + plan.schedule + ')' : 'os plan: not installed')
        const blocks = scheduler.planCronStatusBlocks({ existingText: existing.text, markers: [scheduler.CRON_MARKER, scheduler.MORNING_CRON_MARKER] })
        const morningEntry = blocks.entries.find((entry) => entry.marker === scheduler.MORNING_CRON_MARKER)
        console.log(morningEntry && morningEntry.installed ? 'os plan (morning): installed (' + morningEntry.schedule + ')' : 'os plan (morning): not installed')
      } else {
        console.log('os plan: unknown (' + (existing.error ?? 'crontab unavailable') + ')')
        console.log('os plan (morning): unknown (' + (existing.error ?? 'crontab unavailable') + ')')
      }
    } else {
      console.log('os plan: unsupported platform ' + process.platform)
      console.log('os plan (morning): unsupported platform ' + process.platform)
    }
    return
  }
  const { buildReminders, toIcs } = await loadRemind()
  // 0.4.0: --now pins planning and the echoed instant, so a fixed run is
  // byte-reproducible (the same value is used by reminders/ICS/JSON/webhook).
  const nowInfo = parseRemindNow(flags)
  if (nowInfo.error) { usageFail(nowInfo.error, 'usage: advisers remind [--json] [--now ISO] [--ics [path]] [--deliver [--notify]] [--quiet-hours HH:MM-HH:MM] [--force-notify]'); return }
  if (flags['quiet-hours'] !== undefined) {
    const quiet = parseQuietHours(flags['quiet-hours'])
    if (quiet.error) { usageFail(quiet.error, 'usage: advisers remind [--json] [--now ISO] [--ics [path]] [--deliver [--notify]] [--quiet-hours HH:MM-HH:MM] [--force-notify]'); return }
  }
  const nowDate = nowInfo.date
  // One prefix query instead of getMeta() per commitment (read-only store safe).
  const snoozed = {}
  for (const [key, value] of store?.listMetaByPrefix('snooze:') ?? []) snoozed[key.slice('snooze:'.length)] = value
  const reminders = buildReminders(plannerLedger(), { now: nowDate, snoozedUntil: snoozed })
  if (flags.ics) {
    const path = typeof flags.ics === 'string' ? flags.ics : (positional[0] || join(HOME, 'reminders.ics'))
    // 0.4.3 (043-4, plan 90 NOW-8): explicit TZID + VALARM DESCRIPTION carrying
    // the opaque commitment id, so TickTick/Feishu/Outlook can import the file and
    // still match each alarm to the local row. Default `remind` human/JSON output
    // and lib toIcs() callers keep their 0.4.2 bytes.
    writeFileSync(path, toIcs(reminders, { now: nowDate, tzid: 'Asia/Shanghai', alarmCommitmentId: true }), { mode: 0o600 })
    store?.appendAudit({ actor: 'local', action: 'notify.ics', allowed: true, reason: basename(path) })
    console.log('ics written: ' + path + ' (' + reminders.length + ' events)')
    return
  }
  if (flags.json) {
    // 0.4.0 additive read model: ok/command/timezone + per-row urgency. The old
    // now/reminders keys are unchanged and --json stays a pure read (it wins over
    // --deliver/--notify exactly as in 0.3.2).
    const { buildRemindPayload } = await loadUrgency()
    const records = new Map()
    for (const commitment of plannerLedger().listCommitments()) records.set(commitment.id, commitment)
    const payload = buildRemindPayload(reminders, { now: nowDate, timezone: AGENDA_TIMEZONE, records })
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  if (!reminders.length) {
    console.log('现在没有到期的提醒。')
    if (flags.deliver) recordReminderRun(scheduler, { count: 0, channel: 'log' })
    return
  }
  for (const r of reminders) console.log('[' + r.level + '/' + r.bucket + '] ' + sanitizeConsoleText(r.action, { max: 2000 }) + (r.dueAt ? ' · ' + String(r.dueAt).slice(0, 16) : ''))
  if (flags.deliver) {
    // 0.3.0 Wave 3: reminders.log is one line per run. The action text is ledger
    // data (it can arrive through import or a model turn), so strip CR/LF and
    // control characters before appending; otherwise one entry could forge log
    // lines in the user's reminder history.
    const actions = reminders.map((r) => sanitizeConsoleText(r.action, { max: 2000 }))
    const line = nowDate.toISOString() + '\t' + reminders.length + '\t' + actions.join('；') + '\n'
    writeFileSync(join(HOME, 'reminders.log'), line, { flag: 'a', mode: 0o600 })
    let channel = 'log'
    if (flags.notify) {
      const notify = await loadNotify()
      const forceNotify = flags['force-notify'] === true
      const quietSpec = typeof flags['quiet-hours'] === 'string' ? flags['quiet-hours'] : (typeof process.env.ADVISERS_QUIET_HOURS === 'string' ? process.env.ADVISERS_QUIET_HOURS : null)
      if (!forceNotify && quietSpec && isInsideQuietHours(quietSpec, nowDate)) {
        // Quiet hours are a delivery policy, not an error: the log line above is
        // still written, the channel is recorded as suppressed and the audit row
        // records why. --force-notify bypasses (for an explicit one-off).
        channel = 'quiet-suppressed'
        console.log('通知已静默：当前处于安静时段 ' + quietSpec + '（本地日志已记录；--force-notify 可强制发送）')
      } else {
        const localDay = localDayOfInstant(nowDate)
        let notifyList = reminders
        if (!forceNotify && store && typeof store.listMetaByPrefix === 'function') {
          const seen = new Set(store.listMetaByPrefix('notify:dedupe:').keys())
          notifyList = reminders.filter((reminder) => !seen.has(reminderNotifyDedupeKey(reminder, localDay)))
          if (!notifyList.length) {
            channel = 'deduped'
            console.log('通知已去重：本批提醒今天已经通知过（本地日志仍记录；--force-notify 可重发）')
          }
        }
        // 0.4.3 (043-4, plan 90 NOW-9): per-commitment 24h cooldown. The local
        // reminders.log line above already lists every reminder; the cooldown only
        // narrows the *notification* batch (webhook/local notifier).
        if (channel !== 'deduped') {
          const cooled = applyNotifyCooldown(store, notifyList, nowDate, { forceNotify })
          notifyList = cooled.list
          if (!notifyList.length) {
            channel = 'cooldown-suppressed'
            console.log('通知已冷却：同一承诺 24 小时内已经通知过（本地日志仍记录；--force-notify 可重发）')
          } else if (cooled.suppressed > 0) {
            console.error(sanitizeConsoleText('通知冷却：跳过 ' + cooled.suppressed + ' 条 24 小时内已通知的提醒', { max: 500 }))
          }
        }
        if (channel !== 'deduped' && channel !== 'cooldown-suppressed') {
          const local = await notify.sendNotification({ title: 'Advisers · 到期提醒', body: notifyList.length + ' 条承诺到期或即将到期' })
          channel = local.sent ? local.channel : 'log-only'
          const webhook = await notify.sendWebhookNotification(notifyList, { now: nowDate })
          if (webhook.sent) {
            channel = channel === 'log-only' ? 'webhook' : channel + '+webhook'
            // 0.4.0: remember whether the delivery was signed, without changing the
            // payload bytes. A configured webhook with no secret still sends but says
            // so exactly once per process (sanitised, no secret material).
            if (typeof webhook.signing === 'string' && webhook.signing !== '') channel += '+signing:' + webhook.signing
            if (webhook.warning === 'missing-secret' && !webhookSecretWarned) {
              webhookSecretWarned = true
              console.error(sanitizeConsoleText('webhook 已配置但未设置 ADVISERS_NOTIFY_WEBHOOK_SECRET：本次按未签名发送（signing=none）；建议设置 secret，否则接收端无法验证请求来源。', { max: 2000 }))
            }
          } else if (webhook.configured) { console.error(sanitizeConsoleText('webhook 未发送：' + (webhook.error ?? 'unknown') + (webhook.detail ? '（' + webhook.detail + '）' : ''), { max: 2000 })) }
          if (store && typeof store.setMeta === 'function') {
            for (const reminder of notifyList) store.setMeta(reminderNotifyDedupeKey(reminder, localDay), nowDate.toISOString())
            pruneNotifyDedupe(store, nowDate)
            // 0.4.3 (043-4): start the 24h per-commitment cooldown after the
            // delivery attempt (whether or not a local notifier exists).
            recordNotifyCooldown(store, notifyList, nowDate)
          }
        }
      }
    }
    store?.appendAudit({ actor: 'local', action: 'notify.delivered', allowed: true, reason: reminders.length + ' reminders channel=' + channel })
    recordReminderRun(scheduler, { count: reminders.length, channel })
    if (flags.notify) console.log('通知通道：' + channel)
  }
  return
}

/** Execute one system scheduler command; missing binaries become structured failures. */
function runSchedulerCommand(commandPlan, { timeout = 20000 } = {}) {
  if (!commandPlan || typeof commandPlan.command !== 'string') return { ok: false, error: 'no-command' }
  const result = spawnSync(commandPlan.command, commandPlan.args ?? [], { input: commandPlan.stdin, encoding: 'utf8', timeout, windowsHide: true })
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? (result.error.code ?? result.error.message) : undefined,
  }
}

/** Read the current crontab text; read-only and best-effort (never fails a command). */
async function readCrontabText() {
  const scheduler = await loadScheduler()
  if (!scheduler.CRON_PLATFORMS.includes(process.platform)) return { ok: false, unsupported: true }
  const result = runSchedulerCommand(scheduler.crontabReadCommand())
  if (result.error) return { ok: false, error: result.error }
  return { ok: true, text: result.ok ? result.stdout : '' }
}

/** Record a successful delivery run in ~/.advisers/scheduler/status.json. */
function recordReminderRun(scheduler, { count, channel }) {
  try {
    // 0.4.0: once a v2 status document exists (a morning --archive run writes
    // the morning section), keep writing v2 so the other section survives. A
    // fresh home keeps the 0.3.2 flat v1 layout for byte-compatible readers.
    const current = scheduler.readSchedulerStatusV2({ homeDir: HOME })
    if (current.exists && current.legacy !== true && current.corrupt !== true) {
      scheduler.recordSchedulerRunV2({ homeDir: HOME, at: new Date(), section: 'remind', result: 'ok', count, channel, dryRun: false })
    } else {
      scheduler.recordSchedulerRun({ homeDir: HOME, at: new Date(), result: 'ok', count, channel, dryRun: false })
    }
  } catch (error) {
    console.error('scheduler status not recorded: ' + error.message)
  }
}

/**
 * Apply (or print) a scheduler plan. The library never runs a system command, so
 * the CLI is the only place that can: dry-run prints the exact argv/stdin and
 * only `--apply` executes it.
 */
async function applySchedulerPlan(plan, { apply = false } = {}) {
  const commands = Array.isArray(plan.commands) ? plan.commands : []
  if (!commands.length) {
    console.log(plan.action === 'uninstall' ? '未发现需要移除的系统调度项。' : '系统调度未变更。')
    return { applied: false, results: [] }
  }
  if (!apply) {
    console.log('dry-run（默认不执行；加 --apply 才注册/移除系统任务）：')
    for (const command of commands) {
      if (command.stdin !== undefined) {
        console.log('  ' + command.command + ' ' + command.args.join(' ') + ' <<EOF')
        for (const line of String(command.stdin).split('\n')) console.log('  ' + line)
        console.log('  EOF')
      } else {
        console.log('  ' + command.command + ' ' + command.args.join(' '))
      }
    }
    return { applied: false, results: [] }
  }
  const results = []
  for (const command of commands) {
    const result = runSchedulerCommand(command)
    results.push({ command: command.command, args: command.args, ...result })
    if (!result.ok) {
      console.error('系统调度命令失败：' + command.command + ' ' + command.args.join(' ') + (result.stderr ? '\n' + result.stderr.trim() : '') + (result.error ? ' (' + result.error + ')' : ''))
      process.exitCode = 1
      return { applied: false, results }
    }
  }
  console.log('已执行 ' + commands.length + ' 个系统调度命令。')
  return { applied: true, results }
}

async function deliver(args) {
  const { flags, positional } = parseFlags(args)
  const type = String(flags.type ?? 'confirmation')
  const format = String(flags.format ?? (type === 'ledger' ? 'xlsx' : 'docx'))
  const out = flags.out ? String(flags.out) : join(process.cwd(), `${type}-${new Date().toISOString().slice(0, 10)}.${format}`)
  ensureHome()
  const store = dbStore()
  const ledger = loadLedger()
  const denied = egressDeniedReason(ledger.getMatter(activeMatterId(ledger)), 'deliver')
  if (denied) { console.error(denied); process.exitCode = 1; return }
  let commitments
  if (flags.commit) {
    const c = ledger.getCommitment?.(String(flags.commit)) ?? ledger.listCommitments().find((x) => x.id === String(flags.commit))
    if (!c) { console.error(`unknown commitment: ${flags.commit}`); process.exitCode = 1; return }
    commitments = [c]
  } else commitments = ledger.openCommitments()
  if (!commitments.length) { console.error('no commitments to deliver'); process.exitCode = 1; return }
  // P1-6: a confirmation should not dump an unbounded list of open commitments
  // into one file (5000 open commitments used to make a 7.8s / 1.57GB PDF).
  // The default covers the latest/default view; --all is the explicit opt-in
  // for a full export, and the total is always printed so nothing disappears
  // silently.
  const totalOpen = commitments.length
  const truncated = totalOpen > DELIVER_DEFAULT_LIMIT && flags.all !== true && !flags.commit
  if (truncated) commitments = commitments.slice(0, DELIVER_DEFAULT_LIMIT)
  const { sha256Hex } = await loadEvidence()
  const label = type === 'weekly' ? '周报' : type === 'statement' ? '对账单' : '确认单'
  const scopeLine = truncated
    ? `承诺数：${totalOpen}（本文件只列前 ${commitments.length} 条；用 --all 生成全部）`
    : `承诺数：${commitments.length}`
  const sections = [{ heading: label, paragraphs: [`生成时间：${new Date().toISOString()}`, scopeLine] }]
  for (const c of commitments) {
    sections.push({ heading: c.action, paragraphs: [`对象：${c.creditor}`, `截止：${c.dueAt ?? '未定'}`, `状态：${c.status}`, `证据：${(c.evidence ?? []).length} 条`] })
  }
  sections.push({ heading: '校验', paragraphs: [`内容哈希：${sha256Hex(JSON.stringify(commitments.map((c) => ({ id: c.id, action: c.action, dueAt: c.dueAt, evidence: c.evidence }))))}`, '本文件由本地账本生成；哈希用于事后比对，不是第三方存证。'] })
  try {
    let buffer
    if (format === 'pdf') {
      const { buildSimplePdf } = await loadPdf()
      const lines = commitments.map((c) => `${c.id}  ${c.creditor} · ${c.action}${c.dueAt ? ` · 截止 ${c.dueAt}` : ''} · ${c.status}`)
      buffer = await buildSimplePdf({ title: `${label} · Advisers`, paragraphs: [`承诺数：${commitments.length}`, ...lines, 'SHA256SUMS/回执说明：本 PDF 为本地账本生成，不是第三方存证。'] })
      if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('pdf builder returned a non-PDF buffer')
      await backupCliFile(out)
      writeFileSync(out, buffer)
    } else if (format === 'xlsx') {
      // P2-3: the office barrel (exceljs + pptxgenjs + read/check) is only paid
      // on the formats that actually need it; PDF used to import it too.
      const mod = process.env.ADVISERS_OFFICE_LOCAL === '1' ? await import('../../office/dist/index.js') : await import('advisers-office')
      const rows = commitments.map((c) => ({
        id: c.id, creditor: c.creditor, action: c.action, due: c.dueAt ?? '',
        status: c.status, evidence: (c.evidence ?? []).length,
        source: (c.evidence ?? []).map((e) => e.source?.type ? `${e.source.type}:${e.source.messageId ?? e.source.file ?? e.source.uid ?? ''}` : (e.sessionId ? `${e.sessionId}#${e.turnId}` : 'legacy')).join('; '),
      }))
      buffer = await mod.buildXlsx({ sheet: label, columns: [
        { header: 'ID', key: 'id', width: 22 }, { header: '对象', key: 'creditor', width: 16 },
        { header: '事项', key: 'action', width: 32 }, { header: '截止', key: 'due', width: 26 },
        { header: '状态', key: 'status', width: 10 }, { header: '证据数', key: 'evidence', width: 8 },
        { header: '来源', key: 'source', width: 40 },
      ], rows })
      await mod.validateOffice(buffer, 'xlsx')
      await backupCliFile(out)
      writeFileSync(out, buffer)
    } else {
      const mod = process.env.ADVISERS_OFFICE_LOCAL === '1' ? await import('../../office/dist/index.js') : await import('advisers-office')
      buffer = await mod.buildDocx({ title: `${label} · Advisers`, sections })
      await mod.validateOffice(buffer, 'docx')
      await backupCliFile(out)
      writeFileSync(out, buffer)
    }
    // Delivery row + audit row commit together (robustness audit P0-3).
    recordDeliveryWithAudit({
      files: [out],
      tool: `deliver:${type}`,
      title: label,
      validation: format,
      audit: { actor: 'local', action: 'deliver', allowed: true, reason: `${label} ${commitments.length}` },
    })
    if (flags.json) console.log(JSON.stringify({ ok: true, out, type, format, commitments: commitments.length, total: totalOpen, truncated }, null, 2))
    else {
      console.log(`wrote ${out}`)
      if (truncated) console.log(`提示：共 ${totalOpen} 条未完成承诺，本文件只生成前 ${commitments.length} 条；用 --all 生成全部。`)
    }
  } catch (error) { console.error(`deliver failed: ${error.message}`); process.exitCode = 1 }
}

/**
 * `advisers mcp --stdio`: the shipped stdio entry for the MCP server.
 *
 * The protocol surface lives in lib/mcp-server.js (8 tools incl. the pending-only
 * candidate write + read-only pack verification, 4 read-only resources, 1 MiB
 * line cap, -32601/-32602/-32002/-32700). This wiring only supplies process
 * state: the home, the store/ledger, the version and the audit sink. Every
 * tools/call is audited through store.appendAudit; a write whose audit row
 * cannot be appended fails closed (a created candidate is rolled back).
 */
async function mcpServer() {
  ensureHome()
  // 0.2.3 P0-2 / §4.8: `initialize` is protocol-only. The writable store (writer
  // lock + audit sink) opens now, but the LEDGER is loaded lazily on the first
  // tool that needs it, and only the tables that tool reads — so a 200k-row
  // ledger no longer costs ~2s before the first response. mcp still writes audit
  // rows, so it keeps the writer lock (0.3 makes it a shared writer).
  const store = dbStore()
  const loadLedgerFor = (kind) => {
    if (mode === 'json') return loadJson()
    if (!store) return new Ledger(LOCAL_PORTS)
    if (kind === 'matters') return Ledger.fromParts({ version: 1, matters: store.loadMatters() }, LOCAL_PORTS)
    // 0.2.5 A-2: the read models' clearance gate needs each commitment's matter
    // secrecy, so the commitments view also loads the small matters table.
    if (kind === 'commitments') {
      return Ledger.fromParts({ version: 1, matters: store.loadMatters(), commitments: store.loadCommitments() }, LOCAL_PORTS)
    }
    return Ledger.fromJSON(store.load(), LOCAL_PORTS)
  }
  const { createMcpServer } = await loadMcpServer()
  // 0.3.2 P2-1: give the MCP read models the narrow commitment projection so the
  // first tools/call does not map the whole ledger. Without a SQLite store (JSON
  // mode) the options stay undefined and the server keeps the legacy path.
  const narrowCommitments = typeof store?.projectCommitmentReadModel === 'function'
    ? {
        loadCommitmentView: (options) => store.read(() => store.projectCommitmentReadModel(options)),
        loadCommitmentRecords: (ids) => store.read(() => {
          const byId = new Map()
          for (const id of ids) {
            const record = store.getCommitment(id)
            if (record) byId.set(id, record)
          }
          return byId
        }),
      }
    : {}
  const server = createMcpServer({
    store,
    loadLedger: loadLedgerFor,
    ...narrowCommitments,
    version: VERSION,
    audit: (entry) => store?.appendAudit(entry),
  })
  // Robustness audit P2-3: a closed client stdout surfaces as an asynchronous
  // 'error' event (EPIPE) and used to reach the global uncaughtException handler
  // as "write EPIPE"/exit 1. The MCP host went away, so exit cleanly (0).
  const onStdoutError = (error) => {
    if (error?.code === 'EPIPE') {
      try { process.stdin.pause() } catch {}
      process.exit(0)
    }
    console.error(`advisers: ${friendlyError(error)}`)
    process.exit(1)
  }
  process.stdout.on('error', onStdoutError)
  try {
    await server.serve(process.stdin, process.stdout)
  } finally {
    process.stdout.removeListener('error', onStdoutError)
  }
}

async function ocrCommand(args) {
  const file = args.find((a) => !a.startsWith('--'))
  if (!file) { console.error('usage: advisers ocr <image> [--out text]'); process.exitCode = 1; return }
  try {
    const { runLocalOcr } = await loadOcr()
    const text = await runLocalOcr(file)
    const outIdx = args.indexOf('--out')
    if (outIdx >= 0 && args[outIdx + 1]) {
      writeFileSync(args[outIdx + 1], text + '\n', { mode: 0o600 })
      dbStore()?.appendAudit({ actor: 'local', action: 'ocr.local', allowed: true, reason: basename(args[outIdx + 1]) })
      console.log(`wrote ${args[outIdx + 1]} (${text.length} chars)`)
    } else {
      dbStore()?.appendAudit({ actor: 'local', action: 'ocr.local', allowed: true, reason: basename(file) })
      console.log(text)
    }
  } catch (error) { console.error(`ocr failed: ${error.message}`); process.exitCode = 1 }
}

function vaultPass() {
  const pass = process.env.ADVISERS_VAULT_PASSPHRASE
  if (!pass || pass.length < 8) { console.error('vault requires ADVISERS_VAULT_PASSPHRASE (min 8 chars)'); process.exitCode = 1; return null }
  return pass
}

/**
 * Plaintext database copies and crash residue left in HOME (robustness audit
 * P1-2/P1-3). `vault seal --remove`, `vault status` and `doctor --check-db`
 * must see all of these, otherwise the CLI says "plaintext removed" while a
 * readable SQLite image is still on disk:
 *   - before-unseal/migrate/sync backups and import backups (0.2.2);
 *   - interrupted sync-pull staging files `.advisers-pull-verify-*` (0.2.3);
 *   - quarantined WAL files `state.db-wal.corrupt-*` (WAL frames are plaintext);
 *   - crash-safe temp files from lib/fs-safe (`.<name>.tmp-*`) and the legacy
 *     pet-brief writer (`.<name>.<pid>.<ts>.tmp`).
 */
const PLAINTEXT_DB_COPY_RE = /^(?:state\.db\.before-(?:unseal|migrate|sync)-|\.state\.db\.unseal-|import-backup-|\.advisers-pull-verify-|state\.db-wal\.corrupt-|\..*\.tmp-|\..*\.tmp$)/
function plaintextDbCopies() {
  try {
    return readdirSync(HOME).filter((name) => PLAINTEXT_DB_COPY_RE.test(name)).map((name) => join(HOME, name))
  } catch {
    return []
  }
}

/** DB-shaped backup files that doctor --check-db verifies are readable. */
const BACKUP_FILE_RE = /^(?:state\.db\.before-(?:unseal|migrate|sync)-|import-backup-.*\.db$)/
function newestPlaintextBackup() {
  try {
    let newest = null
    let newestMs = -1
    for (const name of readdirSync(HOME)) {
      if (!BACKUP_FILE_RE.test(name)) continue
      const file = join(HOME, name)
      try {
        const info = statSync(file)
        if (!info.isFile() || info.size === 0) continue
        if (info.mtimeMs > newestMs) { newest = file; newestMs = info.mtimeMs }
      } catch {}
    }
    return newest
  } catch {
    return null
  }
}

/** `doctor --check-db`: the newest pre-migrate/sync/unseal/import backup must open. */
function checkBackupReadable(check) {
  const backup = newestPlaintextBackup()
  if (!backup) {
    check('db-backup', true, 'none found (create one with `advisers backup <path.db>`)')
    return
  }
  let store = null
  try {
    store = new SqliteStore(backup, { readOnly: true, checkIntegrity: true })
    // Age is informational: a readable old backup is still a PASS, but the
    // operator should know that the newest managed copy is stale.
    let age = ''
    try {
      const days = (Date.now() - statSync(backup).mtimeMs) / 86_400_000
      age = `; age ${days.toFixed(1)}d${days > 7 ? ' (older than 7 days; run `advisers backup`)' : ''}`
    } catch {}
    check('db-backup', true, `${basename(backup)} (readable, quick_check ok)${age}`)
  } catch (error) {
    check('db-backup', false, `${basename(backup)}: ${String(error?.message ?? error).slice(0, 200)}`)
  } finally {
    try { store?.close() } catch {}
  }
}

/**
 * Remove the live plaintext database and every plaintext copy. Failures are
 * collected (never swallowed) so the caller can report them and exit non-zero.
 * Removal uses the bounded retry helper (Windows AV/OneDrive can hold a file).
 */
function removePlaintextDatabase() {
  const removed = []
  const failures = []
  for (const file of [DB, `${DB}-wal`, `${DB}-shm`, ...plaintextDbCopies()]) {
    try {
      if (!existsSync(file)) continue
      rmWithRetrySync(file)
      removed.push(file)
    } catch (error) {
      failures.push(`${file}: ${error.message}`)
    }
  }
  fsyncDirSync(HOME)
  return { removed, failures }
}

/** Print the result of a --remove cleanup; returns true only when nothing failed. */
function reportPlaintextCleanup(cleanup, out) {
  if (cleanup.failures.length) {
    console.error(`vault seal failed: the sealed file ${out} is in place, but ${cleanup.failures.length} plaintext file(s) could not be removed:`)
    for (const failure of cleanup.failures) console.error(`  ${failure}`)
    console.error('Close other advisers processes / check file permissions, then rerun `advisers vault seal --remove`.')
    process.exitCode = 1
    return false
  }
  console.log(`sealed ${DB} -> ${out} (plaintext removed: ${cleanup.removed.length} file(s))`)
  return true
}

async function vaultSeal(args) {
  const { flags } = parseFlags(args)
  ensureHome()
  // P1-3: seal mutates/removes state.db, so it takes the same single-writer lock
  // as ordinary commands; a ui/mcp/bridge server holding the store now makes seal
  // fail with E_DB_LOCKED instead of silently discarding that process's writes.
  ensureInstanceLock()
  const removePlaintext = Boolean(flags.remove) || args.includes('--remove')
  if (!existsSync(DB)) {
    const sealed = vaultSealedPath()
    // Already sealed: --remove still means "purge the leftover plaintext copies".
    if (sealed && removePlaintext) return reportPlaintextCleanup(removePlaintextDatabase(), sealed)
    console.error(sealed
      ? `advisers: E_VAULT_SEALED — no plaintext database at ${DB}; the sealed file ${sealed} is intact.`
      : `no database at ${DB}`)
    process.exitCode = 1
    return
  }
  const pass = vaultPass(); if (!pass) return
  const { encryptJson, decryptJson } = await loadVault()
  try {
    const store = new SqliteStore(DB)
    try {
      // The copied bytes must contain every committed write, so fold the WAL
      // first and never ignore a busy checkpoint.
      const before = store.checkpoint()
      if (before.busy) throw new Error('database is busy (another advisers process is writing); close it and retry vault seal')
      store.appendAudit({ actor: 'local', action: 'vault.seal', allowed: true, reason: 'database encrypted at rest' })
      const after = store.checkpoint()
      if (after.busy) throw new Error('database is busy (another advisers process is writing); close it and retry vault seal')
    } finally {
      try { store.close() } catch {}
    }
  } catch (error) { console.error(`vault seal failed: ${error.message}`); process.exitCode = 1; return }
  try {
    const bytes = readFileSync(DB)
    const sha = createHash('sha256').update(bytes).digest('hex')
    const envelope = encryptJson({ kind: 'advisers-db', version: VERSION, sha256: sha, db: bytes.toString('base64') }, pass)
    const out = typeof flags.out === 'string' ? flags.out : `${DB}.vault`
    // 0.2.3 Wave 1 (robustness audit P1-2): stage the envelope in a temp file
    // (short-write loop + fsync + size verification), verify it decrypts back to
    // the same bytes, and only then commit it with an atomic rename. A short
    // write/ENOSPC can no longer install a truncated .vault, and any failure
    // after staging removes the temp file instead of leaving plaintext behind.
    let tmp = null
    try {
      tmp = writeAllToTempSync(out, JSON.stringify(envelope) + '\n', { mode: 0o600 })
      const check = decryptJson(JSON.parse(readFileSync(tmp, 'utf8')), pass)
      if (check.sha256 !== sha) throw new Error('sealed file verification failed (the staged copy does not decrypt to the database)')
      commitTempFileSync(tmp, out, { mode: 0o600 })
      tmp = null
    } catch (error) {
      if (tmp) { try { rmWithRetrySync(tmp) } catch {} }
      throw error
    }
    if (removePlaintext) {
      if (!reportPlaintextCleanup(removePlaintextDatabase(), out)) return
      return
    }
    console.log(`sealed ${DB} -> ${out} (plaintext kept; pass --remove)`)
  } catch (error) {
    console.error(`vault seal failed: ${describeFsError(error, { action: 'sealing the database to', target: typeof flags.out === 'string' ? flags.out : DB + '.vault' })}`)
    process.exitCode = 1
  }
}

async function vaultUnseal(args) {
  const file = args.find((a) => !a.startsWith('--')) || `${DB}.vault`
  if (!existsSync(file)) { console.error(`no sealed database at ${file}`); process.exitCode = 1; return }
  const pass = vaultPass(); if (!pass) return
  let bytes
  try {
    const { decryptJson } = await loadVault()
    const payload = decryptJson(JSON.parse(readFileSync(file, 'utf8')), pass)
    if (payload.kind !== 'advisers-db' || typeof payload.db !== 'string') throw new Error('not an Advisers database vault')
    bytes = Buffer.from(payload.db, 'base64')
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (sha !== payload.sha256) throw new Error('vault checksum mismatch')
  } catch (error) {
    console.error(`vault unseal failed: ${error.message}`)
    console.error(`The sealed file ${file} was not touched; retry with the correct passphrase.`)
    process.exitCode = 1
    return
  }
  ensureHome()
  // P1-3: unseal replaces state.db; hold the single-writer lock for the whole
  // verify + backup + rename sequence (E_DB_LOCKED while another process runs).
  ensureInstanceLock()
  // P1-3: never write the payload straight over the live database. Write a
  // same-directory temp file, fsync it, verify the SQLite image, keep the old
  // database (and its WAL) as a backup, then rename atomically.
  const tmp = join(HOME, `.state.db.unseal-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    // 0.2.3 Wave 1: durable staged write (short-write loop + fsync + size check)
    // instead of a one-shot writeSync that ENOSPC can truncate.
    writeAllToTempSync(DB, bytes, { mode: 0o600, tempPath: tmp })
    let check
    try {
      check = new SqliteStore(tmp, { readOnly: true, checkIntegrity: true })
    } catch (error) {
      throw new Error(`the unsealed database failed its integrity check (${error.message})`)
    } finally {
      try { check?.close() } catch {}
    }
    let backup
    if (existsSync(DB)) {
      backup = `${DB}.before-unseal-${Date.now()}`
      // The pre-unseal copy is plaintext data: copy with retry, then fsync it so
      // a crash right after the rename cannot leave a zero-length backup.
      copyFileWithRetrySync(DB, backup)
      fsyncFileSync(backup)
      for (const suffix of ['-wal', '-shm']) {
        try {
          if (existsSync(DB + suffix)) {
            copyFileWithRetrySync(DB + suffix, backup + suffix)
            fsyncFileSync(backup + suffix)
          }
        } catch {}
      }
    }
    // A WAL from the old database must never be replayed onto the new file.
    for (const suffix of ['-wal', '-shm']) { try { if (existsSync(DB + suffix)) rmWithRetrySync(DB + suffix) } catch {} }
    commitTempFileSync(tmp, DB, { mode: 0o600 })
    console.log(`unsealed ${file} -> ${DB} (${bytes.length} bytes, integrity ok${backup ? `; previous database kept at ${backup}` : ''})`)
  } catch (error) {
    try { rmWithRetrySync(tmp) } catch {}
    console.error(`vault unseal failed: ${describeFsError(error, { action: 'installing the unsealed database', target: DB })}`)
    console.error(`The sealed file ${file} is intact (${bytes.length} bytes of plaintext); the existing database was not replaced.`)
    console.error('Fix the disk/permissions problem and retry `advisers vault unseal`.')
    process.exitCode = 1
  }
}

function vaultStatus() {
  ensureHome()
  const sealed = `${DB}.vault`
  console.log(`database: ${existsSync(DB) ? DB : 'absent'}`)
  console.log(`sealed:   ${existsSync(sealed) ? sealed : 'none'}`)
  console.log(`state:    ${existsSync(DB) ? 'plaintext at rest' : existsSync(sealed) ? 'encrypted at rest (run vault unseal)' : 'empty'}`)
  const copies = plaintextDbCopies()
  if (copies.length) {
    console.log(`plaintext copies: ${copies.length} (run \`advisers vault seal --remove\` to purge them)`)
    for (const copy of copies) console.log(`  ${copy}`)
  }
}

async function timestampCommand(args) {
  const file = args.find((a) => !a.startsWith('--'))
  if (!file) { console.error('usage: advisers timestamp <file> [--out proof]'); process.exitCode = 1; return }
  try {
    const { runLocalTimestamp } = await loadTimestamp()
    const proof = await runLocalTimestamp(file)
    const outIdx = args.indexOf('--out')
    if (outIdx >= 0 && args[outIdx + 1]) {
      writeFileSync(args[outIdx + 1], proof + '\n', { mode: 0o600 })
      dbStore()?.appendAudit({ actor: 'local', action: 'timestamp.local', allowed: true, reason: basename(args[outIdx + 1]) })
      console.log(`wrote ${args[outIdx + 1]}`)
    } else { console.log(proof) }
  } catch (error) { console.error(`timestamp failed: ${error.message}`); process.exitCode = 1 }
}

const TUI_USAGE = [
  'usage: advisers tui [--once] [--json] [--width <40..200>] [--plain|--accessible] [--color auto|always|never]',
  '  --once      print the read-only snapshot once (default when stdin/stdout is a pipe)',
  '  --json      print the same snapshot as one JSON document (pure stdout, no ANSI)',
  '  --width n   wrap/truncate at n columns (default: terminal width or 80; 40..200)',
  '  --plain / --accessible / --color: global output policy (docs/TUI.md §6)',
].join(String.fromCharCode(10))

/**
 * Read-only TUI snapshot data.
 *
 * 0.2.3 §4.8: no writer lock; each refresh reads the current committed snapshot.
 * 0.3.0 P0-T2: one narrow projection feeds both the open list and the reminder
 * planner (all non-done rows incl. undated open commitments). The same data
 * object feeds the human snapshot, the --json projection and the dashboard so
 * the three can never disagree (plan 26 §6.4).
 */
async function tuiSnapshotData() {
  const { buildReminders } = await loadRemind()
  const store = readStoreOrExit()
  const rows = mode === 'json' || !store
    ? loadJson().listCommitments()
    : store.read(() => store.projectCommitmentsForReminders({ includeUndated: true }))
  const open = rows.filter((c) => c.status === 'open')
  const localDay = localDayOf(Date.now())
  const due = open.filter((c) => c.dueAt && c.dueAt.slice(0, 10) <= localDay)
  const reminders = buildReminders(reminderLedgerFromRows(rows), { now: new Date() })
  const deliveries = store?.listDeliveries(3) ?? []
  return { localDay, open, due, reminders, deliveries }
}

/** Column budget for the snapshot: --width, then ADVISERS_SHELL_WIDTH, then stdout. */
function tuiOutputWidth(tuiKernel, explicitWidth) {
  const override = explicitWidth !== undefined ? Number(explicitWidth) : Number(process.env.ADVISERS_SHELL_WIDTH)
  return Number.isFinite(override) && override > 0
    ? tuiKernel.clampColumns(override)
    : tuiKernel.clampColumns(process.stdout.columns)
}

/**
 * Human snapshot lines through the render kernel. Every line is sanitised
 * (ledger/model text is untrusted display data), CJK-width wrapped and kept
 * within the column budget; the section headings stay compatible with the
 * 0.2.x dashboard (`Advisers TUI`, `open commitments`).
 */
function tuiSnapshotLines(tuiKernel, data, width) {
  const reminders = data.reminders.length
    ? data.reminders.slice(0, 8).map((r) => '[' + r.level + '/' + r.bucket + '] ' + r.action + (r.dueAt ? ' · ' + r.dueAt.slice(0, 16) : ''))
    : ['(none)']
  const commitments = data.open.length
    ? data.open.slice(0, 8).map((c) => c.id + '  ' + c.creditor + ' · ' + c.action + (c.dueAt ? ' · ' + c.dueAt.slice(0, 10) : ''))
    : ['(none)']
  const deliveries = data.deliveries.length
    ? data.deliveries.map((d) => String(d.createdAt ?? '').slice(0, 16) + '  ' + (d.title ?? d.tool ?? d.id))
    : ['(none)']
  return tuiKernel.renderSnapshot({
    title: 'Advisers TUI (read-only)',
    sections: [
      { lines: [data.localDay + ' · open ' + data.open.length + ' · due ' + data.due.length + ' · reminders ' + data.reminders.length] },
      { heading: 'reminders:', lines: reminders },
      { heading: 'open commitments:', lines: commitments },
      { heading: 'recent deliveries:', lines: deliveries },
    ],
  }, { width, color: false })
}

/**
 * Pure --json projection of the snapshot (plan 26 §5.2/§6.5). Display strings go
 * through jsonSafe() so the stream can never carry ANSI/C1/bidi into a terminal;
 * ids, timestamps and counts stay structured values.
 */
function tuiSnapshotPayload(tuiKernel, data) {
  return tuiKernel.jsonSafe({
    ok: true,
    command: 'tui',
    mode: 'snapshot',
    generatedAt: new Date().toISOString(),
    localDay: data.localDay,
    counts: {
      open: data.open.length,
      due: data.due.length,
      reminders: data.reminders.length,
      deliveries: data.deliveries.length,
    },
    reminders: data.reminders.slice(0, 50).map((r) => ({
      commitmentId: r.commitmentId ?? null,
      level: r.level ?? null,
      bucket: r.bucket ?? null,
      action: r.action ?? '',
      dueAt: r.dueAt ?? null,
    })),
    commitments: data.open.slice(0, 50).map((c) => ({
      id: c.id ?? null,
      creditor: c.creditor ?? null,
      action: c.action ?? '',
      dueAt: c.dueAt ?? null,
      status: c.status ?? null,
    })),
    deliveries: data.deliveries.map((d) => ({
      id: d.id ?? null,
      createdAt: d.createdAt ?? null,
      title: d.title ?? null,
      tool: d.tool ?? null,
    })),
  })
}

async function tui(args) {
  const parsed = parseStrictFlags(args, { booleans: ['once', 'json', 'help'], values: ['width'] })
  if (!parsed.ok) { usageFail(parsed.error, TUI_USAGE); return }
  if (parsed.positional.length) { usageFail('unexpected argument ' + parsed.positional[0], TUI_USAGE); return }
  if (parsed.flags.help === true) { console.log(TUI_USAGE); return }
  if (parsed.flags.width !== undefined && !/^[0-9]+$/.test(String(parsed.flags.width))) { usageFail('--width must be an integer 40..200', TUI_USAGE); return }
  const tuiKernel = await loadTui()
  const policy = await getOutputPolicy()
  const width = tuiOutputWidth(tuiKernel, parsed.flags.width)
  const data = await tuiSnapshotData()
  if (parsed.flags.json === true) {
    // --json is a pure single document on stdout; nothing human is printed first.
    console.log(tuiKernel.stringifyJson(tuiSnapshotPayload(tuiKernel, data)))
    return
  }
  const lines = tuiSnapshotLines(tuiKernel, data, width)
  // 0.3.0 M10 gate (plan 26 §6.1/§10.3): the interactive dashboard only runs
  // when stdin is a terminal AND the output policy allows cursor control. Pipes,
  // CI, --plain and --accessible get one plain snapshot and exit instead of
  // issuing a clear-screen or entering a readline loop that could wait forever.
  if (parsed.flags.once === true || !policy.interactive || !policy.cursorControl) {
    console.log(lines.join(String.fromCharCode(10)))
    return
  }
  const readline = await import('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const clear = String.fromCharCode(27) + '[2J' + String.fromCharCode(27) + '[H'
  let current = data
  const draw = () => { process.stdout.write(clear + tuiSnapshotLines(tuiKernel, current, width).join(String.fromCharCode(10)) + String.fromCharCode(10, 10) + '[r] refresh  [q] quit' + String.fromCharCode(10)) }
  draw()
  let finish = () => {}
  await new Promise((resolve) => {
    const onKey = async (str, key) => {
      if (key?.name === 'q' || str === 'q') { finish(); return }
      if (key?.name === 'r' || str === 'r') {
        try { current = await tuiSnapshotData() } catch {}
        draw()
      }
    }
    finish = () => { process.stdin.off('keypress', onKey); rl.close(); resolve() }
    process.stdin.on('keypress', onKey)
    rl.on('close', () => { process.stdin.off('keypress', onKey); resolve() })
  })
  finish()
}

function syncPass() {
  const pass = process.env.ADVISERS_SYNC_PASSPHRASE
  if (!pass || pass.length < 8) { console.error('sync requires ADVISERS_SYNC_PASSPHRASE (min 8 chars)'); process.exitCode = 1; return null }
  return pass
}

async function readSyncDevice() {
  try {
    const { sanitizeDevice } = await loadSync()
    const device = readFileSync(join(HOME, 'sync.device'), 'utf8').trim()
    return device ? sanitizeDevice(device) : undefined
  } catch {
    return undefined
  }
}

async function rememberSyncDevice(device) {
  try {
    const { sanitizeDevice } = await loadSync()
    writeFileSync(join(HOME, 'sync.device'), sanitizeDevice(device) + '\n', { mode: 0o600 })
  } catch {}
}

/** Latest mtime of the database + its WAL (captured before any checkpoint). */
function latestLocalDbMtime() {
  let latest = 0
  for (const file of [DB, `${DB}-wal`]) {
    try { latest = Math.max(latest, statSync(file).mtimeMs) } catch {}
  }
  return latest
}

/** Fold the WAL into the main file before a copy/replace; never ignore busy. */
function checkpointLocalDatabase() {
  if (!existsSync(DB)) return { ok: true, skipped: true }
  let store
  try {
    store = new SqliteStore(DB)
    const result = store.checkpoint()
    return { ok: !result.busy, ...result }
  } catch (error) {
    // A locked database can make even the open/migrate fail; treat that as
    // busy so pull refuses instead of replacing a live database (see below).
    return { ok: false, busy: /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String(error?.message ?? error)), error }
  } finally {
    try { store?.close() } catch {}
  }
}

/**
 * 0.2.3 Wave 1 (robustness audit P1-1): explain exactly which sync-pull decision
 * the library made. The old output only said "pulled", so a new-device bootstrap
 * and a --force overwrite of a newer local ledger looked identical.
 */
function reportSyncPullResult(result) {
  const snapshotLabel = `${result.file}${result.createdAt ? ` (created ${result.createdAt}${result.device ? `, device ${result.device}` : ''})` : ''}`
  const backupNote = result.backup ? `; previous database backed up to ${result.backup}` : ''
  if (!result.changed || result.status === 'unchanged') {
    console.log(`unchanged: the local database already matches the selected snapshot ${result.file}`)
    return
  }
  if (result.status === 'bootstrapped') {
    console.log(`pulled (bootstrapped): this device had no local ledger data; installed snapshot ${snapshotLabel}${result.replacedLocalEmpty ? ' over an empty schema-only database (no user rows were lost)' : ''}${result.sameDevice ? '; the snapshot was pushed from this device' : ''}${backupNote}`)
    return
  }
  if (result.status === 'forced') {
    console.log(`pulled (forced): --force replaced the local database with snapshot ${snapshotLabel}${backupNote}`)
    if (result.snapshotOlder) {
      console.error('warning: the installed snapshot is OLDER than the local database; local writes after the snapshot exist only in the backup (export them before continuing if they matter)')
    }
    return
  }
  console.log(`pulled: installed snapshot ${snapshotLabel}${result.sameDevice ? '; pushed from this device' : ''}${backupNote}`)
  if (result.snapshotOlder) console.error('warning: the installed snapshot is older than the local database; the previous database is in the backup')
}

async function syncCommand(args) {
  if (args.includes('--help') || args.includes('-h')) { console.log('usage: advisers sync push|pull|status --dir <sync-dir> [--force] [--file name] [--device name] [--dry-run] [--json]'); return }
  const { flags, positional } = parseFlags(args)
  const sub = positional[0]
  const dir = typeof flags.dir === 'string' ? flags.dir : undefined
  if (!dir) { console.error('usage: advisers sync push|pull|status --dir <sync-dir> [--dry-run]'); process.exitCode = 1; return }
  if (sub === 'status') {
    const { listSnapshots } = await loadSync()
    const snaps = listSnapshots(dir)
    if (flags.json) { console.log(JSON.stringify(snaps, null, 2)); return }
    console.log(`sync dir: ${dir}`)
    if (!snaps.length) { console.log('no snapshots'); return }
    for (const s of snaps.slice(0, 10)) console.log(`  ${s.name}  ${(s.bytes / 1024).toFixed(1)} KB  ${new Date(s.mtimeMs).toISOString()}`)
    return
  }
  const pass = syncPass(); if (!pass) return
  ensureHome()
  // P1-3: push checkpoints/copies the live database and pull replaces it, so both
  // must not run while another process holds the store (or be run by two sync
  // commands at once). The lock is held for the whole operation.
  if (sub === 'push' || sub === 'pull') ensureInstanceLock()
  if (sub === 'push') {
    if (!existsSync(DB)) { console.error(`no database at ${DB}`); process.exitCode = 1; return }
    const device = typeof flags.device === 'string' ? flags.device : hostname()
    try {
      const store = new SqliteStore(DB)
      try {
        const checkpoint = store.checkpoint()
        if (checkpoint.busy) throw new Error('database is busy (another advisers process is writing); close it and retry sync push')
        store.appendAudit({ actor: 'local', action: 'sync.push', allowed: true, reason: basename(dir) })
        const afterAudit = store.checkpoint()
        if (afterAudit.busy) throw new Error('database is busy (another advisers process is writing); close it and retry sync push')
      } finally {
        try { store.close() } catch {}
      }
      const { pushSnapshot } = await loadSync()
      const result = pushSnapshot({ dir, dbPath: DB, passphrase: pass, device })
      await rememberSyncDevice(device)
      console.log(`pushed ${result.file}`)
      console.log(`sha256 ${result.sha256}`)
    } catch (error) { console.error(`sync push failed: ${error.message}`); process.exitCode = 1 }
  } else if (sub === 'pull') {
    const force = Boolean(flags.force)
    const dryRun = flags['dry-run'] === true
    const { pullSnapshot, cleanupStalePullTemps } = await loadSync()
    try {
      // Capture the local write time before checkpointing (checkpoint touches mtime).
      const localMtimeMs = latestLocalDbMtime()
      if (existsSync(DB)) {
        const checkpoint = checkpointLocalDatabase()
        if (checkpoint.busy && !force) throw new Error('local database is busy (another advisers process is writing); close it and retry sync pull, or re-run with --force (a backup is kept)')
        if (!checkpoint.busy && checkpoint.error) console.error(`note: local database could not be checkpointed (${checkpoint.error.message}); the snapshot replaces it and a backup is kept.`)
      }
      const result = pullSnapshot({
        dir,
        dbPath: DB,
        passphrase: pass,
        file: typeof flags.file === 'string' ? flags.file : undefined,
        force,
        localMtimeMs,
        localDevice: await readSyncDevice(),
        dryRun,
      })
      if (dryRun) {
        if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
        const snapshotLabel = `${result.file} (${result.device ?? 'unknown device'}, ${result.createdAt ?? 'unknown time'})`
        for (const warning of result.warnings ?? []) console.error('warning: ' + warning)
        if (!result.wouldChange) console.log(`dry-run: no change; the local database already matches ${snapshotLabel}`)
        else console.log(`dry-run: would ${result.wouldStatus === 'bootstrapped' ? 'bootstrap from' : result.wouldStatus === 'forced' ? 'force-replace with' : 'pull'} ${snapshotLabel}${result.wouldBackup ? '; a backup of the current database would be written first' : ''}; local database unchanged`)
        return
      }
      // 0.2.3 Wave 1: distinguish bootstrapped / forced / plain pull / unchanged.
      reportSyncPullResult(result)
      if (result.changed) {
        try { dbStore()?.appendAudit({ actor: 'local', action: 'sync.pull', allowed: true, reason: result.file }) }
        catch (error) { console.error(`warning: database replaced but the sync.pull audit row failed: ${error.message}`); process.exitCode = 1 }
      }
    } catch (error) {
      // Failure cleanup: the library removes its own staged temp file, but a
      // previously crashed pull may have left stale plaintext staging files.
      // Only stale files whose pid is gone are removed (never a live pull).
      try {
        const swept = cleanupStalePullTemps(HOME)
        if (swept.removed.length) console.error(`note: removed ${swept.removed.length} stale sync-pull temp file(s)`)
        if (swept.errors.length) console.error(`warning: could not clean sync-pull temp file(s): ${swept.errors.slice(0, 2).join(' | ')}`)
      } catch {}
      console.error(`sync pull failed: ${error.message}`)
      process.exitCode = 1
    }
  } else { console.error('usage: advisers sync push|pull|status --dir <sync-dir>'); process.exitCode = 1 }
}

/** Read-side source v2 compatibility for the JSON evidence view. */
async function normalizeEvidenceSources(result) {
  const { normalizeSource } = await loadSource()
  const record = result?.commitment ?? result?.fact ?? result?.preference
  if (!record || typeof record !== 'object') return result
  if (Array.isArray(record.evidence)) {
    record.evidence = record.evidence.map((item) => (item && typeof item === 'object' && item.source ? { ...item, source: normalizeSource(item.source) ?? item.source } : item))
  }
  if (record.source && typeof record.source === 'object') record.source = normalizeSource(record.source) ?? record.source
  return result
}

/**
 * Typed evidence lookups injected into lib/evidence.js: the mail body table and
 * the KB chunk/page tables. The library treats a missing lookup as honest
 * not_checked/unverifiable (never missing), so a read-only command still works.
 */
async function buildEvidenceLookups(store) {
  if (!store || typeof store.db?.prepare !== 'function') return undefined
  const lookups = {}
  try {
    const mailStore = await loadMailStore()
    lookups.mail = (selector) => {
      const ref = selector?.messageId ?? selector?.ref
      if (typeof ref !== 'string' || !ref) return null
      try { return mailStore.getMailMessage(store, ref, { includeBody: true }) } catch { return null }
    }
  } catch {}
  lookups.kbChunk = (selector) => {
    try {
      if (typeof selector?.chunkId === 'string' && selector.chunkId) return store.db.prepare('SELECT * FROM kb_chunks WHERE id = ?').get(selector.chunkId) ?? null
      if (typeof selector?.docId === 'string' && selector.docId && Number.isInteger(selector.chunkIndex)) {
        return store.db.prepare('SELECT * FROM kb_chunks WHERE doc_id = ? AND seq = ?').get(selector.docId, selector.chunkIndex) ?? null
      }
      return null
    } catch { return null }
  }
  lookups.kbPage = (selector) => {
    try {
      const id = typeof selector?.pageId === 'string' && selector.pageId
        ? selector.pageId
        : typeof selector?.docId === 'string' && selector.docId
          ? selector.docId
          : typeof selector?.ref === 'string' ? selector.ref.replace(/^kb_page:/i, '') : ''
      if (!id) return null
      return store.db.prepare('SELECT * FROM kb_pages WHERE id = ? AND deleted_at IS NULL').get(id) ?? null
    } catch { return null }
  }
  return lookups
}

/** One human line for a verified evidence entry, rendered by its source type. */
function verifiedEvidenceLine(entry) {
  const quote = String(entry?.quote ?? '').slice(0, 120)
  const type = String(entry?.type ?? 'unknown')
  if (type === 'conversation') return '  ' + String(entry.sessionId ?? '') + '#' + String(entry.turnId ?? '') + '  「' + quote + '」'
  if (type === 'mail') return '  mail  ' + String(entry.messageId ?? entry.ref ?? '') + '  「' + quote + '」' + (entry.subject ? '  ' + String(entry.subject).slice(0, 80) : '')
  if (type === 'kb_chunk') return '  kb_chunk  ' + String(entry.docId ?? '') + (entry.chunkIndex !== undefined ? '#' + entry.chunkIndex : '') + '  「' + quote + '」'
  if (type === 'kb_page') return '  kb_page  ' + String(entry.pageId ?? '') + '  「' + quote + '」'
  if (type === 'ledger') return '  ledger  ' + String(entry.ref ?? '') + '  「' + quote + '」'
  return '  ' + type + (entry.ref ? ' ' + String(entry.ref) : '') + '  「' + quote + '」'
}

async function printEvidence(args) {
  const { flags, positional } = parseFlags(args)
  // Offline receipt-pack verification: reads only the given directory. It runs
  // before ensureHome() so a clean machine needs no ~/.advisers state.
  if (positional[0] === 'verify') {
    const dir = positional[1] ?? (typeof flags.dir === 'string' ? flags.dir : undefined)
    if (!dir) { console.error('usage: advisers evidence verify <dir>'); process.exitCode = 1; return }
    // 0.4.0: dispatch by manifest.format. A client status pack is verified by
    // the client-pack verifier (its own limits/semantics); everything else stays
    // on the frozen receipt verifier.
    try {
      const clientPack = await loadClientPack()
      const header = clientPack.readClientPackManifestHeader(dir)
      if (header.ok && header.format === clientPack.CLIENT_PACK_MANIFEST_FORMAT) {
        const result = clientPack.verifyClientStatusPackDir(dir)
        console.log(JSON.stringify(result, null, 2))
        if (result.code === clientPack.CLIENT_PACK_LIMIT_CODE) {
          const violation = result.limitViolation ?? {}
          console.error(sanitizeConsoleText(clientPack.CLIENT_PACK_LIMIT_CODE + ': client status pack ' + (violation.limit ?? 'limit') + ' exceeded ' + (violation.max ?? '?') + ' (actual ' + (violation.actual ?? '?') + '); refusing to verify a pack that could exhaust memory or time.', { max: 2000 }))
        }
        process.exitCode = result.ok ? 0 : 1
        return
      }
    } catch {}
    const { verifyReceiptPackDir, RECEIPT_LIMIT_CODE } = await loadReceiptVerify()
    // The verifier caps entries/depth/file size/total size/SHA256SUMS/manifest
    // for an untrusted pack (lib/receipt-verify.js). A pack that trips a cap is
    // reported with the stable code and exits 1; stdout stays one pure JSON
    // document (the code is also in the JSON), the human hint goes to stderr.
    const result = verifyReceiptPackDir(dir)
    console.log(JSON.stringify(result, null, 2))
    if (result.code === RECEIPT_LIMIT_CODE) {
      const violation = result.limitViolation ?? {}
      console.error(sanitizeConsoleText(RECEIPT_LIMIT_CODE + ': receipt pack ' + (violation.limit ?? 'limit') + ' exceeded ' + (violation.max ?? '?') + ' (actual ' + (violation.actual ?? '?') + '); refusing to verify a pack that could exhaust memory or time.', { max: 2000 }))
      console.error('hint: inspect the directory before retrying; a legitimate pack is far below these limits.')
    }
    process.exitCode = result.ok ? 0 : 1
    return
  }
  ensureHome()
  // 0.2.3 §4.3: evidence show is a pure read. The lock-free store supplies the
  // turn lookup and only the one ledger table the id prefix needs is loaded.
  const store = mode === 'sqlite' ? readStoreOrExit() : null
  const id = positional[1] || positional[0]
  if (!id) { console.error('usage: advisers evidence show <id> [--json]'); process.exitCode = 1; return }
  const ledger = readLedgerForCommand(id.startsWith('fact_') ? { facts: {} } : id.startsWith('pref_') ? { preferences: {} } : { commitments: {} })
  let result
  const lookups = await buildEvidenceLookups(store)
  try {
    const { evidenceForCommitment, evidenceForFact, evidenceForPreference } = await loadEvidence()
    if (id.startsWith('cm_')) result = evidenceForCommitment(store, ledger, id, undefined, { lookup: lookups })
    else if (id.startsWith('fact_')) result = evidenceForFact(store, ledger, id, undefined, { lookup: lookups })
    else if (id.startsWith('pref_')) result = evidenceForPreference(store, ledger, id, undefined, { lookup: lookups })
    else { console.error('unknown evidence id prefix (want cm_/fact_/pref_)'); process.exitCode = 1; return }
  } catch (error) { console.error(error.message); process.exitCode = 1; return }
  if (!result || (!result.commitment && !result.fact && !result.preference)) { console.error(`not found: ${id}`); process.exitCode = 1; return }
  await normalizeEvidenceSources(result)
  const unverifiable = Array.isArray(result.unverifiable) ? result.unverifiable : []
  const notChecked = Array.isArray(result.notChecked) ? result.notChecked : []
  const manualSources = unverifiable.filter((item) => item && (item.kind === 'manual' || item.type === 'manual'))
  // 0.4.0: prefer the resolver summary (four-state byKind, notCheckedCount,
  // verificationBasis); fall back to the 0.3.2 tally for legacy result objects.
  const summary = {
    byKind: result.byKind && typeof result.byKind === 'object' ? result.byKind : { observed: result.sources.length, manual: manualSources.length },
    missing: result.missing.length,
    unverifiable: unverifiable.length,
    operatorEntered: manualSources.length,
    notCheckedCount: Number.isInteger(result.notCheckedCount) ? result.notCheckedCount : notChecked.length,
    verificationBasis: typeof result.verificationBasis === 'string' ? result.verificationBasis : 'build-time',
  }
  if (flags.json) { console.log(JSON.stringify(Object.assign({}, result, { summary: summary }), null, 2)); return }
  const label = result.commitment ? `${result.commitment.action}` : result.fact ? `${result.fact.subject} ${result.fact.predicate}` : result.preference?.statement
  console.log(`${id}  ${label ?? ''}`)
  if (!result.sources.length && !unverifiable.length && !notChecked.length) console.log('  （没有可回溯来源）')
  for (const s of result.sources) console.log(verifiedEvidenceLine(s))
  for (const m of result.missing) console.log(`  MISSING ${m.reason}${m.ref ? ` ${m.ref}` : ''}`)
  for (const item of notChecked) console.log(`  NOT CHECKED ${String(item.type ?? 'unknown')} ${String(item.reason ?? 'not_checked')}${item.ref ? ' ' + String(item.ref) : ''}`)
  for (const item of unverifiable) console.log(`  MANUAL 操作者录入（未外部核验，不是缺失）  「${(item.quote ?? '').slice(0, 120)}」  sha256:${String(item.quoteSha256 ?? '').slice(0, 16)}`)
  if (unverifiable.length) console.log('  说明：manual/operator-entered 证据由用户手工录入；本地无法外部核验，不计入 missing。')
  if (notChecked.length) console.log('  说明：not-checked 指本地没有对应的类型化查找能力/记录（如邮件正文未留存）；它既不是 resolved，也不是 missing。')
  console.log('  校验口径：' + summary.verificationBasis + '——本地解析只证明构建时状态，不代表第三方审计或不可伪造。')
}

/**
 * A-1 (0.2.5): secrecy level of the matter an item/delivery row belongs to.
 * No matter id -> 0 (a global row). A named matter the loaded ledger cannot
 * resolve -> Infinity, i.e. treated as protected: a clearance gate never
 * guesses a level for a row it cannot see.
 */
function itemMatterSecrecy(ledger, matterId) {
  if (typeof matterId !== 'string' || !matterId) return 0
  let matter
  try { matter = typeof ledger?.getMatter === 'function' ? ledger.getMatter(matterId) : undefined } catch { matter = undefined }
  if (!matter && typeof ledger?.listMatters === 'function') {
    try { matter = ledger.listMatters().find((row) => row?.id === matterId) } catch { matter = undefined }
  }
  return matter ? secrecyLevel(matter) : Number.POSITIVE_INFINITY
}

/**
 * Map a ProtectedEvidenceError from buildEvidencePack to a fail-closed CLI
 * exit. Only the count/clearance and a fixed hint are printed: no id, title,
 * creditor, action or quote.
 */
function reportProtectedPackError(error) {
  if (error?.code !== 'E_SECRECY_BLOCKED') return false
  console.error('error: ' + error.message)
  if (error.hint) console.error('hint: ' + error.hint)
  process.exitCode = 1
  return true
}

async function evidencePack(args) {
  const { flags, positional } = parseFlags(args)
  ensureHome()
  const store = dbStore()
  const ledger = loadLedger()
  const denied = egressDeniedReason(ledger.getMatter(activeMatterId(ledger)), 'evidence')
  if (denied) { console.error(denied); process.exitCode = 1; return }
  const ids = flags.ids ? String(flags.ids).split(',').map((s) => s.trim()).filter(Boolean) : undefined
  if (ids?.length === 0) { console.error('--ids is empty'); process.exitCode = 1; return }
  const targetIds = ids ?? {
    commitments: ledger.listCommitments().map((c) => c.id),
    facts: ledger.listFacts().map((f) => f.id),
    preferences: ledger.listPreferences({ includeCandidates: false }).map((p) => p.id),
  }
  const { buildEvidencePack, toDocxRows, verifyPack, EvidencePackLimitError } = await loadEvidence()
  const lookups = await buildEvidenceLookups(store)
  let pack
  try {
    // Performance audit P1-1: --all was parsed but never forwarded, so the
    // documented escape hatch was a no-op and large ledgers always failed.
    // A-1 (0.2.5): every included row is judged by its own matter's secrecy.
    // Explicit --ids must fail closed (never a silently partial answer); the
    // bulk path excludes protected rows and reports the count.
    pack = buildEvidencePack({
      store,
      ledger,
      ids: targetIds,
      all: flags.all === true,
      clearance: 0,
      protectedPolicy: ids ? 'error' : 'exclude',
      lookups,
    })
  } catch (error) {
    if (error instanceof EvidencePackLimitError || error?.code === 'EVIDENCE_PACK_TOO_LARGE') {
      console.error('error: ' + error.message)
      if (error.hint) console.error('hint: ' + error.hint)
      process.exitCode = 1
      return
    }
    if (reportProtectedPackError(error)) return
    throw error
  }
  const out = flags.out ? String(flags.out) : join(HOME, 'evidence', `evidence-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(out, { recursive: true, mode: 0o700 })
  for (const [name, content] of Object.entries(pack.files)) writeFileSync(join(out, name), content, { mode: 0o600 })
  let receipt
  try {
    // P2-3: import the docx/validate submodules, not the office barrel.
    const docxModule = await importOfficeSubmodule('docx')
    if (typeof docxModule?.buildDocx !== 'function') throw new Error('advisers-office docx builder is not available')
    const validateOffice = await loadOfficeOperation('validate', 'validateOffice')
    const rows = toDocxRows(pack, { maxRows: 80 })
    const buffer = await docxModule.buildDocx({ title: '证据包回执', sections: [{ heading: '证据清单', paragraphs: rows.length ? rows : ['（没有可导出条目）'] }, { heading: '校验', paragraphs: [`manifest.json / README.txt 的 SHA256 见 SHA256SUMS`, `生成时间：${new Date().toISOString()}`, 'SHA256SUMS 只证明包生成后未被修改；不是签名或第三方存证。'] }] })
    await validateOffice(buffer, 'docx')
    writeFileSync(join(out, 'receipt.docx'), buffer)
    receipt = join(out, 'receipt.docx')
  } catch (error) { console.error(`docx receipt skipped: ${error.message}`) }
  const verification = verifyPack(pack.files)
  const protectedExcluded = Number.isInteger(pack.summary?.protectedExcluded) ? pack.summary.protectedExcluded : 0
  // Delivery row + audit row commit together (robustness audit P0-3). The audit
  // reason records the withheld count (a number, never protected content).
  recordDeliveryWithAudit({
    files: [join(out, 'manifest.json'), join(out, 'README.txt'), join(out, 'SHA256SUMS'), ...(receipt ? [receipt] : [])],
    tool: 'evidence-pack',
    title: 'evidence pack',
    validation: verification,
    audit: {
      actor: 'local',
      action: 'evidence.pack',
      allowed: true,
      reason: `${pack.summary?.entryCount ?? 0} entries${protectedExcluded ? ', ' + protectedExcluded + ' protected excluded' : ''}`,
    },
  })
  console.log(JSON.stringify({ out, files: Object.keys(pack.files), receipt, verification, clearance: 0, protectedExcluded }, null, 2))
  if (!verification.ok) process.exitCode = 1
}

/** "Name <mail>" / "mail" / "Name" -> buildReceiptPack recipient input. */
function parseReceiptRecipient(value) {
  if (value === undefined || value === null || value === true) return undefined
  const text = String(value).trim()
  if (!text) return undefined
  const bracketed = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(text)
  if (bracketed) return { name: bracketed[1].trim() || null, email: bracketed[2] }
  if (/^[^@\s]+@[^@\s]+$/.test(text)) return { email: text }
  return { name: text }
}

/**
 * Resolve ONE dist submodule of the optional advisers-office peer without
 * importing its barrel file. Importing the barrel pulls exceljs/pptxgenjs and
 * cost ~17s on the test host; verify.js/docx.js only need jszip/docx (~100ms).
 * Tries the workspace build first (repo/dev/tests), then the installed peer via
 * its resolved entry URL, then the bare package (portable fallback).
 */
async function importOfficeSubmodule(name) {
  try { return await import('../../office/dist/' + name + '.js') } catch {}
  try {
    const entry = import.meta.resolve('advisers-office')
    if (entry.startsWith('file:')) return await import(new URL('./' + name + '.js', entry).href)
  } catch {}
  return null
}

/** Load one operation from a specific office submodule, falling back to the barrel. */
async function loadOfficeOperation(moduleName, exportName) {
  const submodule = await importOfficeSubmodule(moduleName)
  if (typeof submodule?.[exportName] === 'function') return submodule[exportName]
  const mod = await import('advisers-office')
  return mod[exportName]
}

/**
 * Best-effort structural verification of delivered Office artifacts for the
 * receipt manifest. The optional advisers-office peer may be absent (portable
 * install): an empty result means "not recorded", which the pack discloses.
 */
async function verifyDeliveryArtifacts(files) {
  const supported = []
  for (const file of files) {
    const ext = extname(file).slice(1).toLowerCase()
    if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') supported.push({ file, ext })
  }
  if (!supported.length) return []
  const verifyModule = await importOfficeSubmodule('verify')
  const verifyOffice = verifyModule?.verifyOffice
  if (typeof verifyOffice !== 'function') return []
  const results = []
  for (const { file, ext } of supported) {
    const source = 'advisers verify ' + basename(file)
    try {
      const result = await verifyOffice(readFileSync(file), ext)
      results.push({ source, ...result })
    } catch (error) {
      results.push({ source, ok: false, errors: [String(error?.message ?? error)] })
    }
  }
  return results
}

/**
 * `advisers deliveries --receipt`: build a v1.1 delivery receipt pack.
 *
 * The pack copies the delivered artifacts, records their SHA-256 plus the
 * generator environment / verify results / recipient, and includes the
 * evidence-pack entries (capped at DEFAULT_MAX_EVIDENCE_ENTRIES unless --all or
 * --ids narrows/extends it). The old evidence-only path stays on
 * `deliveries --pack`.
 */
/**
 * Resolve the optional client/project scope of `deliveries --receipt`.
 * Returns null when the pack is unscoped (historical local-all behaviour).
 * Every lookup fails closed: an unknown id is E_CLIENT_NOT_FOUND /
 * E_PROJECT_NOT_FOUND, and a project that belongs to another client is
 * E_PROJECT_CLIENT_MISMATCH (the same codes as the client commands).
 */
function receiptSubjectOf(store, flags) {
  if (flags.client === true || flags.project === true) {
    throw customerError('E_USAGE', '--client/--project require an id', 'advisers deliveries --receipt --client <client-id>')
  }
  const clientId = typeof flags.client === 'string' ? flags.client.trim() : ''
  const projectId = typeof flags.project === 'string' ? flags.project.trim() : ''
  if (!clientId && !projectId) return null
  let project = null
  if (projectId) {
    project = store.getProject(projectId)
    if (!project) throw customerError('E_PROJECT_NOT_FOUND', 'unknown project: ' + projectId, 'advisers project list')
  }
  const resolvedClientId = clientId || project.clientId
  const client = store.getClient(resolvedClientId)
  if (!client) throw customerError('E_CLIENT_NOT_FOUND', 'unknown client: ' + resolvedClientId, 'advisers client list')
  if (project && project.clientId !== client.id) {
    throw customerError('E_PROJECT_CLIENT_MISMATCH', 'project ' + project.id + ' belongs to client ' + project.clientId, 'advisers project list --client ' + client.id)
  }
  const matters = project ? store.listMattersByProject(project.id) : store.listMattersByClient(client.id)
  return {
    kind: project ? 'project' : 'client',
    id: project ? project.id : client.id,
    name: project ? project.name : client.name,
    client: client,
    project: project,
    matterIds: matters.map((matter) => matter.id),
    matterIdSet: new Set(matters.map((matter) => matter.id)),
  }
}

/**
 * Effective secrecy of one delivery row: max(client.secrecyDefault, matter
 * secrecy). A row with an unresolvable matter is treated as protected
 * (Infinity), never guessed. This is the 0.3.2 receipt rule for local-all
 * packs too: a client marked secret cannot leak through a receipt.
 */
function receiptRowSecrecy(store, ledger, row, clientById) {
  let level = itemMatterSecrecy(ledger, row.matterId)
  let clientId = row.clientId || null
  if (!clientId && row.matterId) {
    try { clientId = ledger.getMatter(row.matterId)?.clientId ?? null } catch { clientId = null }
  }
  if (clientId) {
    let client = clientById.get(clientId)
    if (client === undefined) {
      try { client = store.getClient(clientId) ?? null } catch { client = null }
      clientById.set(clientId, client)
    }
    if (client) level = Math.max(level, Number(client.secrecyDefault) || 0)
  }
  return level
}

/**
 * Evidence ids for one receipt subject: only the subject's matters.
 * Global facts/preferences (no matter association) are excluded unless
 * --include-global is explicit; the count of excluded global rows is reported
 * without their content.
 */
function receiptEvidenceIds(ledger, subject, includeGlobal) {
  const ids = { commitments: [], facts: [], preferences: [] }
  let excludedGlobal = 0
  for (const row of ledger.listCommitments()) {
    if (!subject.matterIdSet.has(row.matterId)) continue
    if (itemMatterSecrecy(ledger, row.matterId) > 0) continue
    ids.commitments.push(row.id)
  }
  for (const row of ledger.listFacts()) {
    const matterId = typeof row.matterId === 'string' ? row.matterId : ''
    if (matterId) {
      if (!subject.matterIdSet.has(matterId)) continue
      if (itemMatterSecrecy(ledger, matterId) > 0) continue
    } else if (!includeGlobal) {
      excludedGlobal += 1
      continue
    }
    ids.facts.push(row.id)
  }
  for (const row of ledger.listPreferences({ includeCandidates: false })) {
    const scope = row && row.scope
    const matterId = scope && scope.level === 'matter' && typeof scope.value === 'string' ? scope.value : ''
    if (matterId) {
      if (!subject.matterIdSet.has(matterId)) continue
      if (itemMatterSecrecy(ledger, matterId) > 0) continue
    } else if (!includeGlobal) {
      excludedGlobal += 1
      continue
    }
    ids.preferences.push(row.id)
  }
  return { ids: ids, excludedGlobal: excludedGlobal }
}

/** Matter id of one evidence record ('' for a global record). */
function receiptEvidenceMatterId(record, kind) {
  if (!record || typeof record !== 'object') return ''
  if (kind === 'preference') {
    const scope = record.scope
    return scope && scope.level === 'matter' && typeof scope.value === 'string' ? scope.value : ''
  }
  return typeof record.matterId === 'string' ? record.matterId : ''
}

/** Effective secrecy of one evidence record: max(client default, matter secrecy). */
function receiptEvidenceRecordSecrecy(store, ledger, record, kind, clientById) {
  const matterId = receiptEvidenceMatterId(record, kind)
  if (!matterId) return 0
  let level = itemMatterSecrecy(ledger, matterId)
  let clientId = null
  try { clientId = ledger.getMatter(matterId)?.clientId ?? null } catch { clientId = null }
  if (clientId) {
    let client = clientById.get(clientId)
    if (client === undefined) {
      try { client = store.getClient(clientId) ?? null } catch { client = null }
      clientById.set(clientId, client)
    }
    if (client) level = Math.max(level, Number(client.secrecyDefault) || 0)
  }
  return level
}

/**
 * Local-all receipt evidence: the same client-level secrecy rule as the
 * delivery rows, so a client marked secret cannot leak through the evidence
 * section while its deliveries are correctly excluded.
 */
function receiptGlobalEvidenceIds(store, ledger, clientById) {
  const ids = { commitments: [], facts: [], preferences: [] }
  // Matter-level secrecy stays with buildEvidencePack (it counts those rows as
  // evidence.protectedExcluded, the historical A-1 behaviour). Only a
  // client-level default above 0 is pre-filtered here, because the evidence
  // builder cannot see client rows; those are reported separately so the two
  // counts never double-count.
  const keep = (row, kind, into) => {
    const matterId = receiptEvidenceMatterId(row, kind)
    const matterLevel = matterId ? itemMatterSecrecy(ledger, matterId) : 0
    if (matterLevel > 0) { into.push(row.id); return }
    if (matterId && receiptEvidenceRecordSecrecy(store, ledger, row, kind, clientById) > 0) {
      protectedExcluded += 1
      return
    }
    into.push(row.id)
  }
  let protectedExcluded = 0
  for (const row of ledger.listCommitments()) keep(row, 'commitment', ids.commitments)
  for (const row of ledger.listFacts()) keep(row, 'fact', ids.facts)
  for (const row of ledger.listPreferences({ includeCandidates: false })) keep(row, 'preference', ids.preferences)
  return { ids: ids, protectedExcluded: protectedExcluded }
}

/** Explicit --ids on a local-all receipt: fail closed when any id is protected. */
function receiptExplicitEvidenceProtected(store, ledger, ids, clientById) {
  const records = new Map()
  for (const row of ledger.listCommitments()) records.set(row.id, { kind: 'commitment', record: row })
  for (const row of ledger.listFacts()) records.set(row.id, { kind: 'fact', record: row })
  for (const row of ledger.listPreferences({ includeCandidates: false })) records.set(row.id, { kind: 'preference', record: row })
  let protectedCount = 0
  for (const id of ids) {
    const found = records.get(id)
    if (!found) continue
    if (receiptEvidenceRecordSecrecy(store, ledger, found.record, found.kind, clientById) > 0) protectedCount += 1
  }
  return protectedCount
}

/**
 * `advisers deliveries --receipt`: build a delivery receipt pack.
 *
 * 0.3.2: the pack can be scoped to one client or project. A subject pack only
 * copies that subject's delivered artifacts and evidence (global facts and
 * preferences need --include-global), records `subject`/`scope` in the v2
 * manifest, and states in README.txt/receipt.docx that it contains one
 * subject's data. The unscoped historical form remains, but is now labelled
 * scope=local-all: it contains every local customer's data and must not be
 * forwarded to a third party.
 */
async function receiptPack(args) {
  const { flags } = parseFlags(args)
  ensureHome()
  const store = dbStore()
  if (!store) { console.error('deliveries --receipt requires SQLite store'); process.exitCode = 1; return }
  const ledger = loadLedger()
  const denied = egressDeniedReason(ledger.getMatter(activeMatterId(ledger)), 'evidence')
  if (denied) { console.error(denied); process.exitCode = 1; return }
  if ((flags.client !== undefined || flags.project !== undefined) && flags.ids !== undefined) {
    console.error('E_USAGE: --ids cannot be combined with --client/--project (a subject pack derives its evidence scope from the subject)')
    process.exitCode = 1
    return
  }
  const ids = typeof flags.ids === 'string' ? flags.ids.split(',').map((item) => item.trim()).filter(Boolean) : undefined
  if (ids && !ids.length) { console.error('--ids is empty'); process.exitCode = 1; return }
  const deliveryLimit = Math.max(1, Math.min(2000, Number(flags.limit) || 100))
  let subject = null
  try {
    subject = receiptSubjectOf(store, flags)
  } catch (error) {
    console.error('error: ' + String(error?.message ?? error))
    if (error?.hint) console.error('hint: ' + error.hint)
    process.exitCode = 1
    return
  }
  // A receipt pack is generated at clearance 0 and is meant to leave the
  // machine; a client whose default secrecy is above 0 fails closed instead of
  // producing an empty pack that looks successful.
  if (subject && Number(subject.client?.secrecyDefault) > 0) {
    console.error('E_SECRECY_BLOCKED: client ' + subject.client.id + ' has secrecyDefault ' + subject.client.secrecyDefault + ', but a receipt pack is generated at clearance 0')
    console.error('hint: lower the client secrecy (advisers client ...), or use a local export instead of a shareable receipt')
    process.exitCode = 1
    return
  }
  // 0.3.2: how many scoped deliveries exist before the readable/limit filters,
  // so a bounded pack is never mistaken for the whole set (the default limit is
  // 100, max 2000, and older receipt packs are excluded).
  let deliveriesTotal = null
  try {
    deliveriesTotal = subject
      ? store.countDeliveriesForScope({
          clientId: subject.kind === 'client' ? subject.client.id : null,
          projectId: subject.kind === 'project' ? subject.project.id : null,
          matterIds: subject.matterIds,
        })
      : store.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE COALESCE(tool, '') != 'receipt-pack'").get().n
  } catch { deliveriesTotal = null }
  const rows = subject
    ? store.listDeliveriesForScope({
        clientId: subject.kind === 'client' ? subject.client.id : null,
        projectId: subject.kind === 'project' ? subject.project.id : null,
        matterIds: subject.matterIds,
        limit: deliveryLimit,
      })
    : store.listDeliveries(deliveryLimit)
  // A receipt pack records itself as a delivery for discoverability, but a new
  // receipt must not recursively copy older receipt packs (unbounded growth).
  const scopedRows = rows.filter((row) => row.tool !== 'receipt-pack')
  const deliveriesTruncated = Number.isInteger(deliveriesTotal) ? deliveriesTotal > scopedRows.length : false
  if (!scopedRows.length) {
    console.error(subject
      ? '没有该' + (subject.kind === 'client' ? '客户' : '项目') + '的交付记录可生成回执包；先运行 `advisers deliver` / `advisers office` / `advisers template`。'
      : '没有交付记录可生成回执包；先运行 `advisers deliver` / `advisers office` / `advisers template`。')
    process.exitCode = 1
    return
  }
  // A receipt may span many matters. A row from a protected matter (or from a
  // client with a protected default) is never copied/read; only a count is
  // reported. Receipts have no per-delivery explicit selection (--ids names
  // evidence ids), so this path is exclude-only.
  const clientSecrecyCache = new Map()
  const visibleRows = []
  let protectedDeliveries = 0
  for (const row of scopedRows) {
    if (receiptRowSecrecy(store, ledger, row, clientSecrecyCache) > 0) {
      protectedDeliveries += 1
      continue
    }
    visibleRows.push(row)
  }
  const skippedFiles = []
  const deliveries = []
  for (const row of visibleRows) {
    const files = []
    for (const file of Array.isArray(row.files) ? row.files : []) {
      try {
        if (typeof file === 'string' && existsSync(file) && statSync(file).isFile()) files.push(file)
        else skippedFiles.push(row.id + ': ' + String(file))
      } catch { skippedFiles.push(row.id + ': ' + String(file)) }
    }
    if (!files.length) continue
    deliveries.push({
      id: row.id,
      title: row.title ?? null,
      tool: row.tool ?? null,
      createdAt: row.createdAt ?? null,
      validation: row.validation ?? null,
      files: files,
      matterId: row.matterId ?? undefined,
      clientId: row.clientId ?? undefined,
      projectId: row.projectId ?? undefined,
      templateName: row.templateName ?? undefined,
      templateVersion: row.templateVersion ?? undefined,
      quoteNo: row.quoteNo ?? undefined,
      dataSha256: row.dataSha256 ?? undefined,
    })
  }
  if (!deliveries.length) {
    if (skippedFiles.length) console.error('没有仍存在的交付文件，无法生成回执包（文件可能已被移动或删除）。')
    if (protectedDeliveries) console.error('另有 ' + protectedDeliveries + ' 条交付记录属于受保护事项或受保护客户（secrecy>0），已排除。')
    else if (!skippedFiles.length) console.error('没有仍存在的交付文件，无法生成回执包（文件可能已被移动或删除）。')
    if (skippedFiles.length) console.error('缺失：' + skippedFiles.slice(0, 5).join('; '))
    process.exitCode = 1
    return
  }
  if (skippedFiles.length) console.error('注意：' + skippedFiles.length + ' 个交付文件缺失，已跳过（回执只覆盖仍存在的文件）。')
  const verifyResults = await verifyDeliveryArtifacts(deliveries.flatMap((delivery) => delivery.files))
  const { buildEvidencePack, buildReceiptPack, EvidencePackLimitError } = await loadEvidence()
  const lookups = await buildEvidenceLookups(store)
  let evidence
  let evidenceGlobalExcluded = 0
  let evidenceClientDefaultExcluded = 0
  try {
    if (subject) {
      const scoped = receiptEvidenceIds(ledger, subject, flags['include-global'] === true)
      evidenceGlobalExcluded = scoped.excludedGlobal
      evidence = buildEvidencePack({
        store: store,
        ledger: ledger,
        ids: scoped.ids,
        all: flags.all === true,
        clearance: 0,
        protectedPolicy: 'error',
        lookups,
      })
    } else {
      // A-1 (0.2.5) + 0.3.2: per-item clearance is max(client default, matter
      // secrecy) for the evidence section too, so the local-all pack cannot
      // leak a client-protected record while its deliveries are excluded.
      let targetIds
      if (ids) {
        const protectedCount = receiptExplicitEvidenceProtected(store, ledger, ids, clientSecrecyCache)
        if (protectedCount > 0) {
          console.error('E_SECRECY_BLOCKED: refusing to export ' + protectedCount + ' evidence item(s) selected by --ids: their matter or client secrecy is above the receipt clearance 0')
          console.error('hint: remove those ids from --ids; protected records are never partially exported')
          process.exitCode = 1
          return
        }
        targetIds = ids
      } else {
        const scoped = receiptGlobalEvidenceIds(store, ledger, clientSecrecyCache)
        targetIds = scoped.ids
        evidenceClientDefaultExcluded = scoped.protectedExcluded
      }
      evidence = buildEvidencePack({
        store: store,
        ledger: ledger,
        ids: targetIds,
        all: flags.all === true,
        clearance: 0,
        // Explicit --ids fail closed (A-1); the bulk path excludes protected
        // rows and reports them through evidence.protectedExcluded.
        protectedPolicy: ids ? 'error' : 'exclude',
        lookups,
      })
    }
  } catch (error) {
    if (error instanceof EvidencePackLimitError || error?.code === 'EVIDENCE_PACK_TOO_LARGE') {
      console.error('error: ' + error.message)
      if (error.hint) console.error('hint: ' + error.hint)
      process.exitCode = 1
      return
    }
    if (reportProtectedPackError(error)) return
    throw error
  }
  const out = typeof flags.out === 'string'
    ? flags.out
    : join(HOME, 'receipts', 'receipt-' + new Date().toISOString().replace(/[:.]/g, '-'))
  const docxModule = await importOfficeSubmodule('docx')
  const docxBuilder = typeof docxModule?.buildDocx === 'function'
    ? async (spec) => docxModule.buildDocx(spec)
    : false
  const scope = subject ? 'subject' : 'local-all'
  const command = 'advisers deliveries --receipt' + (subject ? ' --' + subject.kind + ' ' + subject.id : '')
  let pack
  try {
    pack = await buildReceiptPack({
      deliveries: deliveries,
      subject: subject ? { kind: subject.kind, id: subject.id, name: subject.name } : undefined,
      scope: scope,
      evidence: evidence,
      verifyResults: verifyResults,
      docxBuilder: docxBuilder,
      env: {
        advisersVersion: VERSION,
        nodeVersion: process.version,
        platform: process.platform,
        command: command,
      },
      recipient: parseReceiptRecipient(flags.recipient),
      anchors: [],
      outDir: out,
      overwrite: flags.force === true,
    })
  } catch (error) {
    console.error('receipt pack failed: ' + String(error?.message ?? error))
    process.exitCode = 1
    return
  }
  const summary = pack.summary
  const evidenceProtectedExcluded = Number.isInteger(evidence?.summary?.protectedExcluded) ? evidence.summary.protectedExcluded : 0
  const protectedExcluded = protectedDeliveries + evidenceProtectedExcluded + evidenceClientDefaultExcluded
  try {
    recordDeliveryWithAudit({
      files: [join(summary.outDir, 'manifest.json'), join(summary.outDir, 'README.txt'), join(summary.outDir, 'SHA256SUMS'), join(summary.outDir, 'receipt.docx')],
      tool: 'receipt-pack',
      title: subject ? 'delivery receipt pack (' + subject.kind + ' ' + subject.id + ')' : 'delivery receipt pack',
      validation: 'receipt-pack-v2: ' + summary.verifyStatus,
      audit: {
        actor: 'local',
        action: 'receipt.pack',
        allowed: true,
        reason:
          deliveries.length +
          ' deliveries/' +
          summary.fileCount +
          ' files' +
          (subject ? ', scope=' + subject.kind + ':' + subject.id : ', scope=local-all') +
          (protectedDeliveries ? ', ' + protectedDeliveries + ' protected deliveries excluded' : '') +
          (evidenceProtectedExcluded ? ', ' + evidenceProtectedExcluded + ' protected evidence excluded' : ''),
      },
    })
  } catch {}
  const { verifyReceiptPackDir, RECEIPT_LIMIT_CODE } = await loadReceiptVerify()
  const verification = verifyReceiptPackDir(summary.outDir)
  if (verification.code === RECEIPT_LIMIT_CODE) console.error(sanitizeConsoleText(RECEIPT_LIMIT_CODE + ': the receipt pack just written exceeds a resource limit; do not trust it until inspected.', { max: 2000 }))
  const payload = {
    ok: verification.ok,
    format: summary.format,
    version: summary.version,
    scope: scope,
    subject: subject ? { kind: subject.kind, id: subject.id, name: subject.name } : null,
    out: summary.outDir,
    replaced: summary.replaced ?? null,
    deliveryCount: summary.deliveryCount,
    deliveriesTotal: deliveriesTotal,
    deliveriesTruncated: deliveriesTruncated,
    fileCount: summary.fileCount,
    verifyStatus: summary.verifyStatus,
    anchored: summary.anchored,
    recipient: summary.recipient,
    manifestDigest: summary.manifestDigest,
    receiptSha256: summary.receiptSha256,
    evidence: summary.evidence,
    clearance: 0,
    protectedExcluded: protectedExcluded,
    deliveriesProtectedExcluded: protectedDeliveries,
    evidenceProtectedExcluded: evidenceProtectedExcluded,
  }
  if (subject) payload.evidenceGlobalExcluded = evidenceGlobalExcluded
  if (evidenceClientDefaultExcluded > 0) payload.evidenceClientDefaultExcluded = evidenceClientDefaultExcluded
  payload.files = summary.files
  payload.skippedFiles = skippedFiles
  payload.verification = {
    ok: verification.ok,
    errors: verification.errors,
    warnings: verification.warnings,
    checksumCount: verification.checksumCount,
  }
  console.log(JSON.stringify(payload, null, 2))
  if (!verification.ok) process.exitCode = 1
}
function link(sub, from, to, type) {
  const ledger = loadLedger()
  if (sub === 'ls' || !sub) {
    const rows = ledger.listLinks()
    if (!rows.length) {
      console.log('no links yet')
      return
    }
    for (const l of rows) console.log(`${l.id}\t${l.status}\t${l.fromMatter} -[${l.type}]-> ${l.toMatter}`)
    return
  }
  if (sub === 'add') {
    if (!from || !to || !type) {
      console.error('usage: advisers link add <from-matter> <to-matter> <type>')
      process.exitCode = 1
      return
    }
    const l = ledger.proposeLink({ fromMatter: from, toMatter: to, type })
    saveLedger(ledger)
    console.log(`link ${l.id} (${l.status}); confirm with \`advisers link confirm ${l.id}\``)
    return
  }
  if (sub === 'confirm') {
    if (!from) {
      console.error('usage: advisers link confirm <id>')
      process.exitCode = 1
      return
    }
    const l = ledger.confirmLink(from)
    saveLedger(ledger)
    console.log(`confirmed: ${l.id}`)
    return
  }
  if (sub === 'suggest') {
    if (!from) { console.error('usage: advisers link suggest <matter-id>'); process.exitCode = 1; return }
    const source = ledger.getMatter(from)
    if (!source) { console.error(`unknown matter: ${from}`); process.exitCode = 1; return }
    const base = tokenize(`${source.title} ${source.summary ?? ''}`)
    let count = 0
    for (const other of ledger.listMatters()) {
      if (other.id === source.id) continue
      if (ledger.listLinks(source.id, false).some((l) => (l.fromMatter === other.id || l.toMatter === other.id))) continue
      const tokens = tokenize(`${other.title} ${other.summary ?? ''}`)
      let shared = 0
      for (const t of base) if (tokens.has(t)) shared++
      const score = shared / Math.max(1, base.size + tokens.size - shared)
      if (score < 0.18) continue
      const link = ledger.proposeLink({ fromMatter: source.id, toMatter: other.id, type: 'similar', confidence: Math.min(0.7, score), evidence: [`shared terms: ${shared}`] })
      console.log(`${link.id}\t${link.confidence.toFixed(2)}\t${other.title}`)
      count++
    }
    saveLedger(ledger)
    if (!count) console.log('no suggestions')
    return
  }
  if (sub === 'diff') {
    if (!from) { console.error('usage: advisers link diff <update-id>'); process.exitCode = 1; return }
    const u = ledger.listUpdates().find((x) => x.id === from)
    if (!u) { console.error(`unknown update: ${from}`); process.exitCode = 1; return }
    console.log(`${u.id}\t${u.status}`)
    console.log(`${u.sourceMatter} -> ${u.targetMatter}`)
    console.log(`change: ${u.change}`)
    if (u.rollback) console.log(`rollback: ${u.rollback}`)
    return
  }
  if (sub === 'updates') {
    const rows = ledger.listUpdates()
    if (!rows.length) { console.log('no update proposals'); return }
    for (const u of rows) console.log(`${u.id}\t${u.status}\t${u.sourceMatter} -> ${u.targetMatter}\t${u.change}${u.rollback?.startsWith('rolledback:') ? ' (rolled back)' : ''}`)
    return
  }
  if (sub === 'propose-update') {
    if (!from || !to || !type) {
      console.error('usage: advisers link propose-update <source> <target> <change>')
      process.exitCode = 1
      return
    }
    const linked = ledger.listLinks(from, false).some((l) => (l.fromMatter === from && l.toMatter === to) || (l.fromMatter === to && l.toMatter === from))
    if (!linked) {
      console.error('confirm the matter link first: advisers link add <from> <to> <type>; advisers link confirm <id>')
      process.exitCode = 1
      return
    }
    const u = ledger.proposeUpdate({ sourceMatter: from, targetMatter: to, change: type })
    saveLedger(ledger)
    console.log(`${u.id} pending; apply with \`advisers link apply ${u.id}\``)
    return
  }
  if (sub === 'rollback') {
    if (!from) { console.error('usage: advisers link rollback <id>'); process.exitCode = 1; return }
    const proposal = ledger.listUpdates().find((u) => u.id === from)
    if (!proposal || proposal.status !== 'applied' || !proposal.rollback?.startsWith('fact:')) {
      console.error(`no applied update with a rollback fact: ${from}`)
      process.exitCode = 1
      return
    }
    const factId = proposal.rollback.slice(5)
    const ok = ledger.forget('fact', factId)
    proposal.rollback = `rolledback:${factId}`
    saveLedgerWithAudit(ledger, { actor: 'local', action: 'link.rollback', allowed: true, reason: factId })
    console.log(ok ? `rolled back: ${factId}` : `fact not found: ${factId}`)
    if (!ok) process.exitCode = 1
    return
  }
  if (sub === 'curate') {
    const apply = from === '--apply'
    const now = Date.now()
    let changed = 0
    for (const r of ledger.listRoutines().filter((x) => x.status === 'active')) {
      const idleDays = (now - Date.parse(r.updatedAt)) / 86_400_000
      if (idleDays >= 90) {
        console.log(`${r.id}\tarchive candidate\t${Math.floor(idleDays)}d\t${r.name}`)
        if (apply) { ledger.deprecateRoutine(r.id); changed++ }
      } else if (idleDays >= 30) {
        console.log(`${r.id}\tstale\t${Math.floor(idleDays)}d\t${r.name}`)
        if (apply) { ledger.staleRoutine(r.id); changed++ }
      }
    }
    if (!changed && !apply) console.log('no stale routines (dry-run; use --apply)')
    if (apply) { saveLedger(ledger); console.log(`curated: ${changed}`) }
    return
  }
  if (sub === 'restore') {
    if (!from) { console.error('usage: advisers routine restore <id>'); process.exitCode = 1; return }
    const r = ledger.restoreRoutine(from)
    saveLedger(ledger)
    console.log(`restored to draft: ${r.id}`)
    return
  }
  if (sub === 'revert') {
    if (!from) { console.error('usage: advisers routine revert <patch-id>'); process.exitCode = 1; return }
    const patch = ledger.revertRoutinePatch(from)
    saveLedger(ledger)
    console.log(`rolled_back: ${patch.id}`)
    return
  }
  if (sub === 'apply' || sub === 'reject') {
    if (!from) {
      console.error(`usage: advisers link ${sub} <id>`)
      process.exitCode = 1
      return
    }
    const proposal = ledger.listUpdates().find((u) => u.id === from)
    if (!proposal || proposal.status !== 'pending') {
      console.error(`unknown or closed update: ${from}`)
      process.exitCode = 1
      return
    }
    if (sub === 'reject') {
      ledger.resolveUpdate(from, 'rejected')
      saveLedgerWithAudit(ledger, { actor: 'local', action: 'link.reject', allowed: true, reason: from })
      console.log(`rejected: ${from}`)
      return
    }
    const fact = ledger.remember({
      matterId: proposal.targetMatter,
      subject: 'update',
      predicate: 'from',
      object: proposal.change,
      authority: 'user',
      source: { type: 'import', ref: proposal.id },
    })
    ledger.resolveUpdate(from, 'applied', `fact:${fact.id}`)
    saveLedgerWithAudit(ledger, { actor: 'local', action: 'link.apply', allowed: true, reason: `${from} -> ${fact.id}` })
    console.log(`applied: ${from} -> target fact ${fact.id}`)
    return
  }
  console.error(`unknown link subcommand: ${sub}`)
  process.exitCode = 1
}

/**
 * Bridge (Hermes file gateway) hardening — security audit P1-1 / SEC2-09.
 *
 * The bridge library owns the wire format; the CLI tightens what it can before
 * the library sees it: 0700 directories / 0600 files (the library used mkdir and
 * writeFile defaults), a 1 MiB inbox cap enforced before its unbounded readFile,
 * and no absolute local attachment paths in the outbox JSON. The library polls
 * through the instance method, so wrapping pollOnce() covers both the immediate
 * poll in start() and the interval.
 */
const BRIDGE_INBOX_MAX_BYTES = 1024 * 1024

function bridgeDirs(bridgeDir, name) {
  return {
    inbox: join(bridgeDir, 'inbox', name),
    outbox: join(bridgeDir, 'outbox', name),
    status: join(bridgeDir, 'status', name),
    registry: join(bridgeDir, 'registry'),
    quarantine: join(bridgeDir, 'quarantine', name),
  }
}

function secureBridgeTree(bridgeDir, name) {
  const dirs = bridgeDirs(bridgeDir, name)
  for (const dir of Object.values(dirs)) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700) } catch {}
  }
  for (const dir of [dirs.outbox, dirs.registry, dirs.inbox]) {
    let files
    try { files = readdirSync(dir) } catch { continue }
    for (const file of files) {
      try { chmodSync(join(dir, file), 0o600) } catch {}
    }
  }
}

/** Move oversized inbox files out of the library's readFile path (DoS guard). */
function guardBridgeInbox(bridgeDir, name) {
  const dirs = bridgeDirs(bridgeDir, name)
  let files
  try { files = readdirSync(dirs.inbox) } catch { return }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const source = join(dirs.inbox, file)
    let size
    try { size = statSync(source).size } catch { continue }
    try { chmodSync(source, 0o600) } catch {}
    if (size <= BRIDGE_INBOX_MAX_BYTES) continue
    try {
      mkdirSync(dirs.quarantine, { recursive: true, mode: 0o700 })
      chmodSync(dirs.quarantine, 0o700)
      renameSync(source, join(dirs.quarantine, file))
      dbStore()?.appendAudit({ actor: 'bridge', action: 'bridge.inbox_quarantine', allowed: false, reason: `${size} bytes > ${BRIDGE_INBOX_MAX_BYTES}` })
      console.log(`[bridge] quarantined oversized inbox file ${file} (${size} bytes)`)
    } catch {}
  }
}

/** Never hand an absolute local attachment path to the third-party Hermes side. */
function sanitizeBridgeOutbound(message) {
  if (!message || !Array.isArray(message.attachments) || !message.attachments.length) return message
  const attachments = message.attachments.map((attachment) => {
    const next = { ...(attachment ?? {}) }
    delete next.localPath
    if (typeof next.url === 'string' && isAbsolute(next.url)) delete next.url
    return next
  })
  return { ...message, attachments }
}

async function bridge(args) {
  let dir
  let name = 'advisers'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') dir = args[++i]
    else if (args[i] === '--name') name = args[++i]
  }
  dir = dir || process.env.HERMES_BRIDGE_DIR
  if (!dir) {
    console.error('usage: advisers bridge --dir <BRIDGE_DIR> [--name advisers]')
    process.exitCode = 1
    return
  }
  // Files/directories below are private conversation data; tighten the umask for
  // every file this process creates in the bridge tree (SEC2-09: outbox 0644).
  process.umask(0o077)
  let mod
  if (process.env.ADVISERS_BRIDGE_LOCAL === '1') {
    mod = await import('../../bridge-hermes/dist/index.js')
  } else {
    try {
      mod = await import('advisers-bridge-hermes')
    } catch {
      console.error('advisers-bridge-hermes is not installed; run `npm i -g advisers-bridge-hermes@next`')
      process.exitCode = 1
      return
    }
  }
  const ledger = loadLedger()
  const runtime = runtimeFor(ledger)
  const link = new mod.HermesBridgeLink({ bridgeDir: dir, name })
  const libraryPollOnce = link.pollOnce.bind(link)
  link.pollOnce = async () => {
    guardBridgeInbox(dir, name)
    const polled = await libraryPollOnce()
    secureBridgeTree(dir, name)
    return polled
  }
  const librarySend = link.send.bind(link)
  link.send = async (message) => {
    const sent = await librarySend(sanitizeBridgeOutbound(message))
    secureBridgeTree(dir, name)
    return sent
  }
  secureBridgeTree(dir, name)
  const permitSecret = process.env.ADVISERS_PERMIT_SECRET || randomUUID()
  const permitGate = new core.PermitGate(permitSecret, { replay: dbStore()?.permitReplayStore() })
  const host = {
    async ingest(event) {
      const result = await runtime.ingest(event)
      if (result.accepted && runtime.lastContext) {
        const context = runtime.lastContext
        let reply
        if (context.crisis && (context.crisis.tier === 'T1' || context.crisis.tier === 'T2' || (context.crisis.tier === 'T3' && context.crisis.thirdParty))) {
          dbStore()?.appendAudit({ actor: 'bridge', action: 'policy.crisis', allowed: false, reason: context.crisis.tier })
          reply = context.crisis.script
        } else if (context.policy && !context.policy.allowed) {
          dbStore()?.appendAudit({ actor: 'bridge', action: 'policy.deny', allowed: false, reason: context.policy.code ?? 'DENY' })
          reply = context.policy.reason
        }
        // Security audit P1-1: bridge is a model egress path; apply the same
        // matter-secrecy gate as chat/review/research BEFORE any network call.
        const bridgeEgressDenied = reply ? null : egressDeniedReason(context.matter, 'bridge')
        if (bridgeEgressDenied) {
          dbStore()?.appendAudit({ actor: 'bridge', action: 'policy.egress_deny', allowed: false, reason: 'bridge' })
          console.log(`[bridge] blocked: ${bridgeEgressDenied}`)
          reply = '[advisers] received (protected matter: model call denied)'
        }
        const key = process.env.ADVISERS_API_KEY
        if (!reply && key && process.env.ADVISERS_NO_MODEL !== '1') {
          try {
            const { complete } = await import('../lib/model.js')
            reply = await complete({
              prompt: `${context.prompt}\n\n[user]\n${event.text ?? ''}`,
              apiKey: key,
              baseUrl: process.env.ADVISERS_BASE_URL || 'https://api.deepseek.com',
              model: process.env.ADVISERS_MODEL || 'deepseek-flash',
            })
          } catch (error) {
            reply = `模型调用失败：${error.message}`
          }
        } else if (!reply) {
          reply = context.intent?.readback ?? '[advisers] received'
        }
        const message = {
          conversationId: event.conversationId,
          threadId: event.threadId,
          replyTo: event.messageId,
          text: reply,
          idempotencyKey: event.dedupeKey ?? event.messageId,
        }
        if (permitGate) {
          const draft = { text: reply, replyTo: event.messageId }
          const request = { linkId: link.id, accountId: event.accountId, conversationId: event.conversationId, threadId: event.threadId, purpose: 'reply', draft }
          const permit = permitGate.issue(request)
          const auth = permitGate.authorize(permit, request)
          if (!auth.ok) {
            dbStore()?.appendAudit({ actor: 'bridge', action: 'egress.deny', allowed: false, reason: auth.reason })
            console.log(`[bridge] blocked: ${auth.reason}`)
            return result
          }
          message.permit = permit
        }
        const sent = await link.send(message)
        dbStore()?.appendAudit({ actor: 'bridge', action: sent.ok ? 'egress.sent' : 'egress.failed', allowed: sent.ok, reason: sent.error ?? undefined })
        saveLedger(ledger)
      }
      return result
    },
    async resolvePrincipal(account) {
      return `${account.linkId}:${account.accountId}`
    },
  }
  await link.start(host)
  console.log(`[bridge] ${name} listening at ${dir}`)
  const keepalive = setInterval(() => {}, 60_000)
  const shutdown = async () => { clearInterval(keepalive); await link.stop(); process.exit(0) }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await new Promise(() => {})
}

async function office(kind, specFile, outFile) {
  const kinds = ['docx', 'xlsx', 'pptx', 'xmind', 'mermaid', 'drawio']
  if (!kinds.includes(kind) || !specFile || !outFile) {
    console.error('usage: advisers office <docx|xlsx|pptx|xmind|mermaid|drawio> <spec.json> <out>')
    process.exitCode = 1
    return
  }
  let mod
  if (process.env.ADVISERS_OFFICE_LOCAL === '1') {
    mod = await import('../../office/dist/index.js')
  } else {
    try {
      mod = await import('advisers-office')
    } catch {
      console.error('advisers-office is not installed; run `npm i -g advisers-office@next`')
      process.exitCode = 1
      return
    }
  }
  const spec = JSON.parse(readFileSync(specFile, 'utf8'))
  mkdirSync(dirname(outFile), { recursive: true })
  if (kind === 'mermaid') {
    await backupCliFile(outFile)
    writeFileSync(outFile, mod.buildMermaid(spec))
    console.log(`wrote ${outFile}`)
    return
  }
  if (kind === 'drawio') {
    await backupCliFile(outFile)
    writeFileSync(outFile, mod.buildDrawio(spec))
    console.log(`wrote ${outFile}`)
    return
  }
  const ext = outFile.split('.').pop()?.toLowerCase()
  const expected = kind === 'docx' ? ['docx'] : kind === 'xlsx' ? ['xlsx'] : kind === 'pptx' ? ['pptx'] : kind === 'xmind' ? ['xmind'] : kind === 'drawio' ? ['drawio'] : ['mmd', 'mermaid']
  if (!expected.includes(ext)) { console.error(`office ${kind} writes ${expected.join('/')}; got .${ext}`); process.exitCode = 1; return }
  const builder = kind === 'docx' ? mod.buildDocx : kind === 'xlsx' ? mod.buildXlsx : kind === 'xmind' ? mod.buildXmind : mod.buildPptx
  const buffer = await builder(spec)
  await backupCliFile(outFile)
  writeFileSync(outFile, buffer)
  const result = kind === 'xmind' ? await mod.validateXmind(buffer) : await mod.validateOffice(buffer, kind)
  dbStore()?.appendAudit({ actor: 'local', action: 'office.build', allowed: true, reason: outFile })
  recordManualDelivery([outFile], 'office', kind, result)
  console.log(result.ok ? `wrote ${outFile} (${buffer.length} bytes)` : `wrote ${outFile}, missing: ${result.missing.join(', ')}`)
  if (!result.ok) process.exitCode = 1
}

async function soul(sub, file) {
  if (sub === 'show') {
    const doc = loadSoul()
    if (!doc) {
      console.log('no soul.md; run `advisers soul init` or `advisers soul set <file>`')
      return
    }
    console.log(`# soul v${doc.version} (${doc.updatedAt})`)
    console.log(doc.content)
    return
  }
  if (sub === 'set') {
    if (!file) {
      console.error('usage: advisers soul set <file>')
      process.exitCode = 1
      return
    }
    if (!existsSync(file)) {
      console.error(`file not found: ${file}`)
      process.exitCode = 1
      return
    }
    await requireTosReaccept({ scope: 'config', subject: 'soul', action: 'soul set' })
    const previous = loadSoul()
    const content = readFileSync(file, 'utf8')
    const doc = {
      id: 'soul',
      version: (previous?.version ?? 0) + 1,
      content,
      updatedAt: now(),
      updatedBy: 'human',
    }
    saveSoul(doc)
    console.log(`soul updated to v${doc.version}; tell the user what changed`)
    return
  }
  if (sub === 'init') {
    if (existsSync(SOUL)) {
      console.log('soul.md already exists; use `advisers soul set <file>` to replace it')
      return
    }
    await requireTosReaccept({ scope: 'config', subject: 'soul', action: 'soul init' })
    const doc = {
      id: 'soul',
      version: 1,
      content:
        '你是我的幕僚：直接、简洁、有用。\n' +
        '你是我生活里的客人：私事保持私密。\n' +
        '如果你要改这个文件，先告诉我。\n',
      updatedAt: now(),
      updatedBy: 'human',
    }
    saveSoul(doc)
    console.log(`wrote ${SOUL}`)
    return
  }
  help()
  process.exitCode = 1
}

// ---------------------------------------------------------------------------
// TOS consent gate (docs/TOS.md §2)
//
// L1: every non-exempt command requires an accepted TOS for the CURRENT version
//     + text hash. Missing acceptance: TTY shows a 12-line summary and requires
//     typing 同意; non-TTY exits 3 with a single E_TOS_REQUIRED stderr line
//     (`--accept-tos` / `ADVISERS_ACCEPT_TOS=1` records channel=flag|env and
//     nonInteractive=1, then continues). A version/text change re-requires.
// L2: modification surfaces (soul set/init, routine writes, import --replace)
//     each need a fresh confirmation and write audit action=tos.reaccept.
//
// The acceptance record is ~/.advisers/tos.json (0600, atomic); the audit chain
// gets action=tos.accept|tos.block|tos.reaccept|tos.revoke with a reason that
// names version/sha256/channel and NEVER the terms text.
// ---------------------------------------------------------------------------

/**
 * Commands usable without accepting the TOS (TOS §2.1: local functions stay usable).
 * TOS §2.1 / §9.8: reviewing, exporting and deleting your own local data is not
 * a gated feature. After a revoke the data-rights commands (privacy/export/
 * audit/purge), tos itself, and the other local-only commands below must stay
 * usable, otherwise the user must re-consent before exporting or deleting data.
 */
const TOS_EXEMPT_COMMANDS = new Set([
  'help', '--help', '-h', 'version', '--version', '-v', 'status', 'doctor', 'init', 'tos',
  'privacy', 'export', 'audit', 'purge', 'backups', 'profile',
])
/** Known commands. Unknown commands keep the plain "unknown command" error, not the gate. */
const KNOWN_COMMANDS = new Set([
  'version', '--version', '-v', 'help', '--help', 'chat', 'status', 'doctor', 'init', 'history', 'mcp',
  'deliver', 'timestamp', 'tui', 'ocr', 'evidence', 'receipt', 'deliveries', 'learn', 'commit', 'diff',
  'undo', 'compact', 'search', 'nudge', 'risks', 'pet-brief', 'today', 'tick', 'ui', 'remind', 'calendar',
  'who', 'memory', 'digest', 'week', 'prefs', 'privacy', 'audit', 'purge', 'decay', 'correct', 'ls', 'why',
  'forget', 'sync', 'vault', 'export', 'import', 'backup', 'backups', 'restore', 'brief', 'review', 'research', 'capture', 'policy',
  'office-edit', 'office-read', 'verify', 'office', 'routine', 'template', 'link', 'bridge', 'soul', 'tos',
  'matter', 'agenda', 'morning',
  // 0.4.0: KB / mail / money / consent commands are gated like every other
  // command (unknown names keep the plain error instead of the gate).
  'kb', 'fact', 'mail', 'receivable', 'payment', 'consent', 'inbox', 'profile',
  // 0.3.0 customer entities: reads and writes both go through the L1/TOS gate
  // (they touch the local ledger); there is no exempt customer command.
  'client', 'project',
])

/** Append a TOS audit row; audit is best-effort (JSON store has no audit chain). */
function tosAudit(action, allowed, reason) {
  try {
    ensureHome()
    dbStore()?.appendAudit({ actor: 'local', action, allowed, reason })
  } catch {}
}

/** Audit reason material: names version/sha256/channel, never the terms text. */
function tosAuditReason({ version, sha256, channel, nonInteractive, extra = '' }) {
  return `version=${version};sha256=${sha256};channel=${channel};nonInteractive=${nonInteractive ? 1 : 0}${extra}`
}

async function recordTosAcceptance(tos, info, { channel, nonInteractive }) {
  const record = tos.writeAcceptance(HOME, {
    version: info.version,
    sha256: info.sha256,
    acceptedAt: new Date().toISOString(),
    channel,
    nonInteractive,
  })
  tosAudit('tos.accept', true, tosAuditReason({ version: info.version, sha256: info.sha256, channel, nonInteractive, extra: ';scope=app' }))
  return record
}

function tosRequiredLine(version) {
  return `advisers: 需要先同意使用条款 ${version}（E_TOS_REQUIRED）。运行 advisers tos show 查看全文；非交互环境加 --accept-tos 或 ADVISERS_ACCEPT_TOS=1。`
}

function tosReacceptRequiredLine(version) {
  return `advisers: 此修改需要再次确认使用条款 ${version}（E_TOS_REQUIRED）。--yes 不能代替 TOS 确认；非交互环境加 --accept-tos 或 ADVISERS_ACCEPT_TOS=1（运行 advisers tos show 查看全文）。`
}

/** TOS §2.3 "源码修改版" notice: TTY-only, non-blocking, once per fingerprint change. */
async function maybeSourceModifiedNotice(tos) {
  try {
    if (!process.stdin.isTTY) return
    const fingerprint = tos.sourceCheckoutFingerprint()
    if (!fingerprint || !tos.shouldNoticeSourceModified({ home: HOME, fingerprint })) return
    for (const line of tos.sourceModifiedNotice({ fingerprint })) console.error(line)
    tos.writeSourceFingerprint(HOME, fingerprint)
  } catch {}
}

let tosEnvOverrideAudited = false

/**
 * Resolve TOS facts from the packaged manifest (0.3.0 P0-S3).
 *
 * lib/tos keeps an ADVISERS_TOS_VERSION override for debugging, but the consent
 * gate and the acceptance record must never follow it: an env variable could
 * otherwise write a fake version into tos.json and the audit chain. bin/
 * therefore always passes the manifest version explicitly (the DSH read facade
 * does the same in lib/ledger-read.js), records one
 * `tos.env_override_ignored` audit row per process when the env is set, and
 * surfaces it as a warning in `tos status`. `tos show --as-version <v>` stays
 * available as an explicit, display-only debug switch.
 */
function resolveTosFacts(tos) {
  const manifest = tos.readManifest()
  const info = tos.currentTos({ version: manifest.version })
  const raw = typeof process.env.ADVISERS_TOS_VERSION === 'string' ? process.env.ADVISERS_TOS_VERSION.trim() : ''
  const envOverride = raw
    ? { set: true, ignored: true, requestedVersion: raw, manifestVersion: manifest.version }
    : { set: false, ignored: false, requestedVersion: null, manifestVersion: manifest.version }
  if (raw && !tosEnvOverrideAudited) {
    tosEnvOverrideAudited = true
    // Audit once per process, and only when an audit chain already exists so a
    // read-only `tos status` never creates a database just to record this.
    if (mode === 'sqlite' && existsSync(DB)) {
      tosAudit('tos.env_override_ignored', false, `event=TOS_ENV_OVERRIDE_IGNORED;envVersion=${safeAuditToken(raw, 'redacted')};manifestVersion=${manifest.version};scope=app`)
    }
  }
  return { info, envOverride }
}

/** L1 gate: run before dispatch; exits the process on block/reject (exit 3 / exit 1). */
async function tosGate() {
  const isTTY = Boolean(process.stdin.isTTY)
  if (!command) { if (!isTTY) return }
  // Offline receipt verification must work on a clean machine without a
  // ~/.advisers consent record (docs/DELIVERY-RECEIPT.md); it reads only <dir>.
  else if (command === 'evidence' && args[0] === 'verify') return
  // `--help`/`-h` anywhere is a pure help request: it must work before TOS
  // acceptance (and before HOME/database setup), like the top-level help.
  else if (args.includes('--help') || args.includes('-h')) return
  else if (TOS_EXEMPT_COMMANDS.has(command) || !KNOWN_COMMANDS.has(command)) return
  const tos = await loadTos()
  const { info } = resolveTosFacts(tos)
  const status = tos.acceptanceStatus({ home: HOME, version: info.version, sha256: info.sha256 })
  if (status.accepted) { await maybeSourceModifiedNotice(tos); return }
  const explicit = tos.resolveConsent({ flag: acceptTosFlag, env: process.env.ADVISERS_ACCEPT_TOS, version: info.version, isTTY })
  if (explicit?.error) { console.error(`advisers: ${explicit.error}`); process.exit(1) }
  if (explicit?.ok) {
    await recordTosAcceptance(tos, info, { channel: explicit.channel, nonInteractive: true })
    await maybeSourceModifiedNotice(tos)
    return
  }
  if (!isTTY) {
    tosAudit('tos.block', false, tosAuditReason({ version: info.version, sha256: info.sha256, channel: 'none', nonInteractive: true, extra: `;scope=app;reason=${status.reason}` }))
    console.error(tosRequiredLine(info.version))
    process.exit(3)
  }
  const answer = await tos.promptForConsent({ version: info.version, url: info.url })
  if (answer.accepted) {
    await recordTosAcceptance(tos, info, { channel: 'interactive', nonInteractive: false })
    console.log(`已接受使用条款 v${info.version}（channel=interactive）；撤回：advisers tos revoke。`)
    await maybeSourceModifiedNotice(tos)
    return
  }
  tosAudit('tos.block', false, tosAuditReason({ version: info.version, sha256: info.sha256, channel: 'interactive', nonInteractive: false, extra: `;scope=app;reason=${answer.reason}` }))
  console.error(`未接受使用条款 v${info.version}；受门控的命令已停止（运行 advisers tos show 查看全文）。`)
  process.exit(1)
}

/** L2 gate: per-modification re-confirmation (TOS §2.3). Returns true when allowed. */
async function requireTosReaccept({ scope, subject = '', action }) {
  const tos = await loadTos()
  const { info } = resolveTosFacts(tos)
  const isTTY = Boolean(process.stdin.isTTY)
  const extra = `;scope=${scope}${subject ? `;subject=${subject}` : ''};action=${action ?? '-'}`
  const explicit = tos.resolveConsent({ flag: acceptTosFlag, env: process.env.ADVISERS_ACCEPT_TOS, version: info.version, isTTY })
  if (explicit?.error) { console.error(`advisers: ${explicit.error}`); process.exit(1) }
  if (explicit?.ok) {
    tosAudit('tos.reaccept', true, tosAuditReason({ version: info.version, sha256: info.sha256, channel: explicit.channel, nonInteractive: true, extra }))
    return true
  }
  if (!isTTY) {
    tosAudit('tos.block', false, tosAuditReason({ version: info.version, sha256: info.sha256, channel: 'none', nonInteractive: true, extra: `;reason=reaccept-required${extra}` }))
    console.error(tosReacceptRequiredLine(info.version))
    process.exit(3)
  }
  const answer = await tos.promptForConsent({
    version: info.version,
    lines: tos.modificationNotice({ scope, action }),
    question: '继续？输入“同意”或 y 确认（n 或直接 Enter 取消）：',
  })
  if (answer.accepted) {
    tosAudit('tos.reaccept', true, tosAuditReason({ version: info.version, sha256: info.sha256, channel: 'interactive', nonInteractive: false, extra }))
    console.log(`已再次确认使用条款（scope=${scope}）；本次确认已写入本地审计链。`)
    return true
  }
  tosAudit('tos.block', false, tosAuditReason({ version: info.version, sha256: info.sha256, channel: 'interactive', nonInteractive: false, extra: `;reason=rejected${extra}` }))
  console.error(`未确认修改（scope=${scope}）；操作已取消。`)
  process.exit(1)
}

function tosAuditState() {
  if (mode !== 'sqlite') return { available: false, note: 'unavailable (json store)' }
  if (!existsSync(DB)) return { available: false, note: 'no audit chain yet' }
  try {
    const store = openStore()
    const verify = store.verifyAudit()
    const counts = { accept: 0, block: 0, reaccept: 0, revoke: 0 }
    for (const row of store.listAudit(10000)) {
      if (row.action === 'tos.accept') counts.accept++
      else if (row.action === 'tos.block') counts.block++
      else if (row.action === 'tos.reaccept') counts.reaccept++
      else if (row.action === 'tos.revoke') counts.revoke++
    }
    return { available: true, verified: verify.ok, brokenAt: verify.ok ? null : verify.seq, count: verify.count ?? 0, counts }
  } catch (error) {
    return { available: false, note: `unavailable (${error.message})` }
  }
}

function tosStatusFacts(tos, info, status, envOverride = null) {
  const record = status.record
  return {
    version: info.version,
    manifestVersion: info.manifestVersion,
    envOverride: envOverride ?? { set: false, ignored: false, requestedVersion: null, manifestVersion: info.manifestVersion },
    effectiveFrom: info.effectiveFrom,
    textSha256: info.sha256,
    canonical: info.canonical,
    termsPath: info.termsPath,
    url: info.url,
    accepted: status.accepted,
    reason: status.reason,
    acceptance: record ? {
      version: record.version,
      sha256: record.sha256,
      acceptedAt: record.acceptedAt,
      channel: record.channel,
      nonInteractive: record.nonInteractive,
      ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
    } : null,
    store: { type: mode, path: mode === 'sqlite' ? DB : STATE },
    audit: tosAuditState(),
    futureSeparateConsent: ['content packs / DLC (not shipped in 0.2.0)', 'text-to-speech / TTS (not shipped in 0.2.0)'],
  }
}

function printTosStatus(tos, info, status, asJson, envOverride = null) {
  const facts = tosStatusFacts(tos, info, status, envOverride)
  if (asJson) { console.log(JSON.stringify(facts, null, 2)); return }
  const record = facts.acceptance
  console.log(`version   ${facts.version}（生效 ${facts.effectiveFrom}；manifest ${facts.manifestVersion}）`)
  console.log(`sha256    ${facts.textSha256}`)
  if (facts.accepted) {
    console.log(`accepted  yes · channel=${record.channel} · nonInteractive=${record.nonInteractive ? 1 : 0} · ${record.acceptedAt}`)
  } else {
    console.log(`accepted  no · reason=${facts.reason}${record ? ` · last channel=${record.channel} · ${record.acceptedAt}` : ''}${record?.revokedAt ? ` · revokedAt=${record.revokedAt}` : ''}`)
    console.log('next      advisers tos accept（交互输入“同意”）或非交互加 --accept-tos / ADVISERS_ACCEPT_TOS=1')
  }
  console.log(`terms     ${facts.termsPath}`)
  console.log(`url       ${facts.url}`)
  console.log(`store     ${facts.store.type}${facts.store.path ? ` (${facts.store.path})` : ''}`)
  if (facts.envOverride?.set) {
    console.log(`warning   ADVISERS_TOS_VERSION=${facts.envOverride.requestedVersion} 已被忽略：同意记录与门禁只认 manifest v${facts.envOverride.manifestVersion}（调试用 'advisers tos show --as-version <v>'）`)
  }
  if (facts.audit.available) {
    const c = facts.audit.counts
    console.log(`audit     ${facts.audit.verified ? 'verified' : `BROKEN at seq ${facts.audit.brokenAt}`} · ${facts.audit.count} entries · tos.accept=${c.accept} tos.block=${c.block} tos.reaccept=${c.reaccept} tos.revoke=${c.revoke}`)
  } else {
    console.log(`audit     ${facts.audit.note}`)
  }
  console.log('future    DLC / TTS are not available in 0.2.0; if they ship they will require a separate, explicit consent')
}

function tosUsage(version = '') {
  console.log(`usage: advisers tos <show|status|accept|revoke>${version ? `   （当前版本 v${version}）` : ''}
  advisers tos show                 打印完整使用条款
  advisers tos status [--json]      版本、接受记录、审计状态（含 DLC/TTS 未来单独同意说明）
  advisers tos accept               接受当前使用条款（非交互需 --accept-tos 或 ADVISERS_ACCEPT_TOS=1）
  advisers tos revoke [--yes]       撤回同意（受门控命令随后会重新要求确认）`)
}

async function tosCommand(argv) {
  const tos = await loadTos()
  const sub = argv[0]
  const { info, envOverride } = resolveTosFacts(tos)
  if (!sub || sub === 'help' || sub === '--help') { tosUsage(info.version); return }
  const status = tos.acceptanceStatus({ home: HOME, version: info.version, sha256: info.sha256 })
  if (sub === 'show') {
    let showInfo = info
    const asVersionIndex = argv.indexOf('--as-version')
    if (asVersionIndex !== -1) {
      const requested = argv[asVersionIndex + 1]
      if (!requested) { console.error('usage: advisers tos show [--as-version <version>]'); process.exitCode = 1; return }
      showInfo = tos.currentTos({ version: requested })
      console.error(`advisers: debug view only — showing v${requested} (manifest v${info.version}); the consent gate and record are not affected.`)
    }
    console.log(`Advisers 使用条款 v${showInfo.version}（生效 ${showInfo.effectiveFrom}）`)
    console.log(`文本 SHA-256：${showInfo.sha256}`)
    console.log(`规范文本：${showInfo.canonical}；随包副本：${showInfo.termsPath}；在线：${showInfo.url}`)
    console.log('---')
    process.stdout.write(readFileSync(showInfo.termsPath, 'utf8'))
    return
  }
  if (sub === 'status') { printTosStatus(tos, info, status, argv.includes('--json'), envOverride); return }
  if (sub === 'accept') {
    if (status.accepted) {
      console.log(`已接受使用条款 v${info.version}（channel=${status.record.channel}，${status.record.acceptedAt}）；撤回：advisers tos revoke。`)
      return
    }
    const isTTY = Boolean(process.stdin.isTTY)
    const explicit = tos.resolveConsent({ flag: acceptTosFlag, env: process.env.ADVISERS_ACCEPT_TOS, version: info.version, isTTY })
    if (explicit?.error) { console.error(`advisers: ${explicit.error}`); process.exitCode = 1; return }
    if (explicit?.ok) {
      await recordTosAcceptance(tos, info, { channel: explicit.channel, nonInteractive: true })
      console.log(`已接受使用条款 v${info.version}（channel=${explicit.channel}，nonInteractive=1）；已写入本地审计链。${envOverride?.set ? ` ADVISERS_TOS_VERSION=${envOverride.requestedVersion} 已忽略。` : ''}`)
      return
    }
    if (!isTTY) {
      tosAudit('tos.block', false, tosAuditReason({ version: info.version, sha256: info.sha256, channel: 'none', nonInteractive: true, extra: ';scope=app;reason=command-accept-requires-flag' }))
      console.error(tosRequiredLine(info.version))
      process.exitCode = 3
      return
    }
    const answer = await tos.promptForConsent({ version: info.version, url: info.url })
    if (answer.accepted) {
      await recordTosAcceptance(tos, info, { channel: 'interactive', nonInteractive: false })
      console.log(`已接受使用条款 v${info.version}（channel=interactive）；已写入本地审计链。撤回：advisers tos revoke。`)
      return
    }
    tosAudit('tos.block', false, tosAuditReason({ version: info.version, sha256: info.sha256, channel: 'interactive', nonInteractive: false, extra: ';scope=app;reason=rejected' }))
    console.error(`未接受使用条款 v${info.version}。`)
    process.exitCode = 1
    return
  }
  if (sub === 'revoke') {
    const record = tos.readAcceptance(HOME)
    if (!record || record.revokedAt) { console.log('当前没有有效的同意记录（无需撤回）。'); return }
    const isTTY = Boolean(process.stdin.isTTY)
    const confirmedByFlag = argv.includes('--yes')
    if (!isTTY && !confirmedByFlag) {
      console.error('advisers: 撤回同意会停止受门控命令；非交互环境请加 --yes 确认（advisers tos revoke --yes）。')
      process.exitCode = 1
      return
    }
    if (isTTY && !confirmedByFlag) {
      const answer = await tos.promptForConsent({
        version: info.version,
        lines: ['撤回同意 · ' + `v${info.version}`, '撤回后受门控的命令会停止（help/status/doctor/tos 等本地功能仍可用）。', '撤回不影响撤回前已发生行为的效力，也不影响仓库许可证已授予的权利。'],
        question: '确认撤回？输入“同意”或 y 确认（n 或直接 Enter 取消）：',
      })
      if (!answer.accepted) { console.log('已取消撤回。'); return }
    }
    const revoked = tos.revokeAcceptance(HOME, { revokedAt: new Date().toISOString() })
    if (!revoked) { console.log('当前没有有效的同意记录（无需撤回）。'); return }
    tosAudit('tos.revoke', true, tosAuditReason({ version: revoked.version, sha256: revoked.sha256, channel: isTTY ? 'interactive' : 'command', nonInteractive: isTTY ? false : true, extra: ';scope=app' }))
    console.log(`已撤回使用条款 v${info.version} 的同意；受门控的命令将重新要求确认（advisers tos accept 可重新接受）。`)
    return
  }
  tosUsage(info.version)
  process.exitCode = 1
}

// ---------------------------------------------------------------------------
// 0.4.3 (043-7, plan 96 §3.1 M0a): `-h`/`--help` anywhere is a pure help
// request. Before this, `init --help` ran init and wrote soul.md, `ui --help`
// bound a port, `purge --help` read the flag as a matter id and `office-read
// --help` blocked for 5s. The short-circuit resolves the request before the TOS
// gate and before dispatch, so no command can run a side effect and a fresh
// home stays byte-empty. `advisers help` / `advisers --help` keep the 249-line
// general help (human-only, no frozen contract).
// ---------------------------------------------------------------------------

/** Canonical usage line(s) per command path. Human-only; no frozen contract. */
const HELP_USAGE_LINES = new Map(Object.entries({
  version: 'usage: advisers version',
  status: 'usage: advisers status [--json]',
  doctor: 'usage: advisers doctor [--check-db] [--json] [--report]\n       advisers doctor --repair [--dry-run|--yes] [--only lock,temp,wal,fts] [--json]',
  init: 'usage: advisers init',
  chat: 'usage: advisers chat [--file <path>] [--allow-path <dir>]... <text>',
  history: 'usage: advisers history',
  mcp: 'usage: advisers mcp --stdio',
  deliver: 'usage: advisers deliver [--commit id] [--type confirmation|weekly|statement|ledger] [--format docx|xlsx|pdf] [--out f]',
  timestamp: 'usage: advisers timestamp <file> [--out proof]',
  tui: 'usage: advisers tui [--once] [--json] [--width <40..200>] [--plain|--accessible] [--color auto|always|never]',
  ocr: 'usage: advisers ocr <image> [--out text]',
  evidence: 'usage: advisers evidence show <id> [--json]\n       advisers evidence verify <dir>',
  'evidence show': 'usage: advisers evidence show <id> [--json]',
  'evidence verify': 'usage: advisers evidence verify <dir>',
  receipt: 'usage: advisers receipt',
  deliveries: 'usage: advisers deliveries [--pack|--receipt] [--out dir] [--ids ...] [--all] [--json]',
  commit: 'usage: advisers commit add|edit|ls|done|snooze ...',
  'commit add': 'usage: advisers commit add "<action>" --quote "<原话>" [--due ISO|相对日期] [--debtor user|agent] [--creditor name] [--matter id] [--remind-offsets "-1d,-2h"]',
  'commit edit': 'usage: advisers commit edit <id> [--action text] [--due ISO|相对日期] [--matter id] [--remind-offsets "<list>" | --no-remind]',
  'commit ls': 'usage: advisers commit ls [--json]',
  'commit done': 'usage: advisers commit done <id> --evidence "<证据/原话>"',
  'commit snooze': 'usage: advisers commit snooze <id> <hours>',
  help: 'usage: advisers help [<topic>] [--list]',
  'learn ls': 'usage: advisers learn ls',
  'learn review': 'usage: advisers learn review <run-id>',
  diff: 'usage: advisers diff',
  undo: 'usage: advisers undo [--list] [--force]',
  compact: 'usage: advisers compact ls|rollback <version>',
  search: 'usage: advisers search <text> [--scope turns|kb|pages|facts|all] [--json]',
  nudge: 'usage: advisers nudge list|done|ignore <nudge-id>',
  risks: 'usage: advisers risks',
  'pet-brief': 'usage: advisers pet-brief [--json] [--out [path]] [--check [--strict]] [--display-policy public|private|none]',
  today: 'usage: advisers today [--calendar] [--sources] [--json] [--limit n]',
  tick: 'usage: advisers tick',
  week: 'usage: advisers week [--json]',
  ui: 'usage: advisers ui [--port n]',
  remind: 'usage: advisers remind [--json] [--now ISO] [--ics [path]] [--deliver [--notify]] [--quiet-hours HH:MM-HH:MM] [--force-notify]\n       advisers remind install|uninstall|status [--apply] [--schedule "0 9 * * *"]',
  'remind install': 'usage: advisers remind install [--apply] [--schedule "0 9 * * *"] [--morning [--morning-time 08:30] [--morning-days 1-5]]',
  'remind uninstall': 'usage: advisers remind uninstall [--apply]',
  'remind status': 'usage: advisers remind status',
  calendar: 'usage: advisers calendar import --ics <file>',
  'calendar import': 'usage: advisers calendar import --ics <file>',
  who: 'usage: advisers who [--json]',
  memory: 'usage: advisers memory [--all]\n       advisers memory search <q> | candidates [--json] [--all] | accept <id> | reject <id> [--reason <r>]',
  digest: 'usage: advisers digest day|week|morning',
  prefs: 'usage: advisers prefs [--all]',
  privacy: 'usage: advisers privacy [--json] [--prove [--brief]]\n       advisers privacy --matrix [--json]',
  audit: 'usage: advisers audit [--check-db] [--json]\n       advisers audit --write-anchor [--json] | --expect-count <N> [--expect-head <64 hex>] | --rebuild-fts',
  purge: 'usage: advisers purge <matter-id> [--yes]',
  decay: 'usage: advisers decay',
  correct: 'usage: advisers correct <statement>',
  ls: 'usage: advisers ls',
  why: 'usage: advisers why <pref-id|fact-id>',
  forget: 'usage: advisers forget <pref-id>',
  sync: 'usage: advisers sync push|pull|status --dir <sync-dir> [--force] [--file name] [--device name] [--dry-run] [--json]',
  'sync push': 'usage: advisers sync push --dir <sync-dir> [--force] [--file name] [--device name] [--dry-run] [--json]',
  'sync pull': 'usage: advisers sync pull --dir <sync-dir> [--force] [--file name] [--dry-run] [--json]',
  'sync status': 'usage: advisers sync status [--dir <sync-dir>] [--json]',
  vault: 'usage: advisers vault seal [--out file] [--remove] | unseal [file] | status',
  export: 'usage: advisers export [--all] [--out <file>] [--encrypted]',
  import: 'usage: advisers import <file> [--replace]',
  backup: 'usage: advisers backup [--out <file> | <path.db>] [--tag <name>] [--keep daily=7,weekly=4,monthly=3] [--dry-run|--apply] [--json]',
  backups: 'usage: advisers backups ls|verify [--json] [--limit <n>]',
  'backups ls': 'usage: advisers backups ls [--json] [--limit <n>]',
  'backups verify': 'usage: advisers backups verify [--json] [--limit <n>]',
  restore: 'usage: advisers restore <backup-file> [--dry-run] [--yes] [--allow-anchor-behind] [--allow-broken-audit-chain] [--json]',
  brief: 'usage: advisers brief [--deep] <text>',
  review: 'usage: advisers review <file> --request "..."',
  research: 'usage: advisers research --web|--url <url> [--deep] <query>',
  capture: 'usage: advisers capture [--file <path|->] [--source wechat|meeting|email|note|stdin] [--date ISO] [--matter id] [--rules|--local|--model] [--json] [<text>]\n       advisers capture --from-mail <file|dir> [--limit n]\n       advisers capture --from-transcript <file>\n       advisers capture --from-imap',
  policy: 'usage: advisers policy check <text>',
  'office-read': 'usage: advisers office-read <file>',
  verify: 'usage: advisers verify <file> [--json] [--content] [--template quote|proposal --data <file>]',
  'office-edit': 'usage: advisers office-edit <file> <ops.json> [out]',
  office: 'usage: advisers office <docx|xlsx|pptx|xmind|mermaid|drawio> <spec.json> <out>',
  routine: 'usage: advisers routine ls|add|approve|archive|patches|patch|diff|apply|reject|revert|check|curate|restore ...',
  template: 'usage: advisers template quote|proposal <data.json> <out.docx|out.xlsx> [--json] [--record-delivery] [--matter id]\n       advisers template <weekly|budget|presentation|flow|mindmap|minutes|notice> <data.json> <out>',
  link: 'usage: advisers link ls|add|confirm|suggest|updates|propose-update|apply|diff|reject|rollback ...',
  bridge: 'usage: advisers bridge --dir <BRIDGE_DIR> [--name advisers]',
  soul: 'usage: advisers soul show | set <file> | init',
  'soul show': 'usage: advisers soul show',
  'soul set': 'usage: advisers soul set <file>',
  'soul init': 'usage: advisers soul init',
  tos: 'usage: advisers tos <show|status|accept|revoke>',
  'tos show': 'usage: advisers tos show [--as-version <version>]',
  'tos status': 'usage: advisers tos status [--json]',
  'tos accept': 'usage: advisers tos accept',
  'tos revoke': 'usage: advisers tos revoke [--yes]',
  matter: 'usage: advisers matter <add|ls|show|rename|archive|use> ...',
  agenda: 'usage: advisers agenda [--days 1..31] [--from YYYY-MM-DD] [--matter id] [--no-calendar] [--include-done] [--json] [--now ISO]',
  morning: 'usage: advisers morning [--days 1..31] [--matter id] [--top 1..5] [--out file] [--archive [--keep 1..365]] [--json] [--now ISO]',
  fact: 'usage: advisers fact add <subject> <predicate> <object> --quote "..." [--json]\n       advisers fact show <id> | history <id> | as-of <YYYY-MM-DD|ISO> [--json]',
  consent: 'usage: advisers consent status|grant <surface>|revoke <surface> [--data-class mail|kb] [--yes] [--json]',
  agent: 'usage: advisers agent ...',
  // 0.4.0 command families
  kb: 'usage: advisers kb add <file>... [--title s] [--kind k] [--client id] [--project id] [--matter id] [--secrecy 0-3] [--replace] [--from list.txt] [--json]\n       advisers kb ls|show <id>|rm <id>|purge <id>|reindex [--json] | kb search <q> | kb page ls|show|rebuild|diff',
  'kb add': 'usage: advisers kb add <file>... [--title s] [--kind quote|contract|receipt|delivery|note|other] [--client id] [--project id] [--matter id] [--secrecy 0-3] [--replace] [--from list.txt] [--json]',
  'kb ls': 'usage: advisers kb ls [--client id] [--matter id] [--kind k] [--all] [--limit n] [--clearance 0-3] [--json]',
  'kb show': 'usage: advisers kb show <id> [--chunks 0..20] [--clearance 0-3] [--json]',
  'kb rm': 'usage: advisers kb rm <id> [--json]',
  'kb purge': 'usage: advisers kb purge <id> [--dry-run|--yes] [--json]',
  'kb reindex': 'usage: advisers kb reindex [--rebuild] [--json]',
  'kb search': 'usage: advisers kb search <query> [--scope kb|pages|all] [--limit n] [--clearance 0-3] [--json]',
  'kb page': 'usage: advisers kb page ls|show|rebuild|diff ... [--json]',
  'kb page ls': 'usage: advisers kb page ls [--kind client|project|timeline|facts] [--check] [--limit n] [--json]',
  'kb link': 'usage: advisers kb link <doc-id> --fact <fact-id> [--relation source|mentions] [--chunk id] [--json]',
  'kb unlink': 'usage: advisers kb unlink <doc-id> --fact <fact-id> [--relation source|mentions] [--json]',
  mail: 'usage: advisers mail account add|ls|show|test|rm ...\n       advisers mail sync [<acct>] [--full] [--dry-run] [--json] [--watch [--interval 300s] [--max-runs n]]\n       advisers mail ls|show <id> [--body]|purge|import|extract|link|dismiss ... [--json]',
  'mail account': 'usage: advisers mail account add|ls|show|test|rm ...',
  'mail account add': 'usage: advisers mail account add|ls|show|test|rm ...\n  advisers mail account add --name n --host h [--port 993] [--tls tls|starttls] --user u [--pass-stdin]',
  'mail account ls': 'usage: advisers mail account ls [--json]',
  'mail account show': 'usage: advisers mail account show <acct> [--json]',
  'mail account test': 'usage: advisers mail account test <acct> [--json]',
  'mail account rm': 'usage: advisers mail account rm <acct> [--json]',
  'mail sync': 'usage: advisers mail sync [<account>] [--full] [--dry-run] [--since-days n] [--limit n] [--mailbox INBOX] [--json] [--watch [--interval 300s] [--max-runs n]]',
  'mail ls': 'usage: advisers mail ls [--account a] [--client id] [--status s] [--since 30d] [--limit n] [--json]',
  'mail show': 'usage: advisers mail show <id> [--body] [--json]',
  'mail purge': 'usage: advisers mail purge [--older-than 30d] [--dry-run|--yes] [--account a] [--json]',
  'mail import': 'usage: advisers mail import <file|dir> [--limit n] [--dry-run] [--client id] [--project id] [--json]',
  'mail extract': 'usage: advisers mail extract [<id>...] [--all-new] [--local|--model] [--yes] [--matter id] [--limit n] [--dry-run] [--json]',
  'mail link': 'usage: advisers mail link <message> [--client id] [--project id] [--json]',
  'mail dismiss': 'usage: advisers mail dismiss <message> [--json]',
  receivable: 'usage: advisers receivable add <client-id> "<label>" --amount 8000.00 [--due DATE] [--currency CNY] [--json]\n       advisers receivable ls|show <id>|edit <id>|void <id> [--aging] [--json]\n       advisers receivable export [--out f.csv] [--json]',
  'receivable add': 'usage: advisers receivable add <client-id> "<label>" --amount 8000.00 [--due DATE|相对日期] [--currency CNY] [--client-matter id] [--json]',
  'receivable ls': 'usage: advisers receivable ls [--client id] [--status s] [--aging] [--clearance 0-3] [--json]',
  'receivable show': 'usage: advisers receivable show <id> [--json]',
  'receivable edit': 'usage: advisers receivable edit <id> [--label s] [--amount n] [--due DATE|相对日期] [--json]',
  'receivable void': 'usage: advisers receivable void <id> [--reason s] [--json]',
  'receivable export': 'usage: advisers receivable export [--client id] [--project id] [--currency c] [--status active|all] [--due-within 7d|30d] [--clearance 0-3] [--out f.csv|-] [--bom] [--json]',
  payment: 'usage: advisers payment add <client-id> --amount 4000.00 [--receivable rcv] [--method bank] [--json]\n       advisers payment ls|void <id> [--json]',
  'payment add': 'usage: advisers payment add <client-id> --amount 4000.00 [--receivable rcv] [--currency CNY] [--paid-at ISO] [--method bank|wechat|alipay|cash|other] [--json]',
  'payment ls': 'usage: advisers payment ls [--receivable id] [--json]',
  'payment void': 'usage: advisers payment void <id> [--json]',
  client: 'usage: advisers client <add|list|show|timeline|archive|merge|export|note> ...',
  'client add': 'usage: advisers client add "<name>" [--aliases a,b] [--tags t1,t2] [--secrecy 0-3] [--note text] [--link-matter <id>] [--json]',
  'client list': 'usage: advisers client list [--all] [--limit n] [--json]',
  'client show': 'usage: advisers client show <id> [--timeline-limit n] [--clearance 0-3] [--json]',
  'client timeline': 'usage: advisers client timeline <id> [--since 90d|ISO] [--kind delivery,note,commitment] [--limit n] [--clearance 0-3] [--json]',
  'client archive': 'usage: advisers client archive <id> [--dry-run] [--json]',
  'client merge': 'usage: advisers client merge <from-id> <into-id> [--dry-run] [--json]',
  'client export': 'usage: advisers client export <id> [--format md|docx] [--out <file>] [--redact-names] [--pack] [--json]',
  'client note': 'usage: advisers client note add|list <id> ...',
  'client note add': 'usage: advisers client note add <id> "<summary>" [--kind k] [--at ISO] [--project id] [--matter id] [--json]',
  'client note list': 'usage: advisers client note list <id> [--project <id>] [--limit n] [--json]',
  project: 'usage: advisers project <add|list|show|archive> ...',
  'project add': 'usage: advisers project add <client-id> "<name>" [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--default-matter <id>] [--note text] [--json]',
  'project list': 'usage: advisers project list [--client <id>] [--all] [--limit n] [--json]',
  'project show': 'usage: advisers project show <id> [--timeline-limit n] [--clearance 0-3] [--json]',
  'project archive': 'usage: advisers project archive <id> [--dry-run] [--json]',
  // 0.4.3 additions
  inbox: 'usage: advisers inbox ls [--source capture|mail|all] [--limit n] [--offset n] [--clearance 0-3] [--json]\n       advisers inbox show <candidate-id> [--clearance 0-3] [--json]',
  profile: 'usage: advisers profile show [--json]\n       advisers profile export [--out <file>] [--json]',
}))

/** Leading non-flag tokens before the first `-h/--help`, capped at 4. */
function helpRequestTokens(argv) {
  const tokens = []
  for (const token of argv) {
    if (token === '--help' || token === '-h') continue
    if (typeof token !== 'string' || token.startsWith('-')) break
    tokens.push(token)
    if (tokens.length >= 4) break
  }
  return tokens
}

/** Longest known command path in argv; null for the top-level help request. */
function helpRequestUsage(argv) {
  const tokens = helpRequestTokens(argv)
  if (!tokens.length) return null
  if (tokens[0] === 'help') return HELP_USAGE_LINES.get('help') ?? null
  for (let length = tokens.length; length >= 1; length--) {
    const line = HELP_USAGE_LINES.get(tokens.slice(0, length).join(' '))
    if (line) return line
  }
  // Unknown path: a generic usage keeps `advisers <cmd> --help` a pure read.
  return 'usage: advisers ' + tokens.join(' ') + ' [options]'
}

/** Flush already-queued stdout writes, then exit (process.exit can truncate pipes). */
async function flushStdoutAndExit(code) {
  try { await new Promise((resolve) => process.stdout.write('', resolve)) } catch {}
  process.exit(code)
}

if (rawArgv.includes('--help') || rawArgv.includes('-h')) {
  const usage = helpRequestUsage(rawArgv)
  if (usage === null) { help(); await flushStdoutAndExit(0) }
  writeSync(1, usage.endsWith('\n') ? usage : usage + '\n')
  process.exit(0)
}

// L1 consent gate: runs once before dispatch (exempt commands return immediately).
await tosGate()

if (!command) {
  // 0.4.0: a TTY with no command enters the readline shell (lib/shell.js);
  // stdin not a TTY keeps the frozen 0.3.x "print help, exit 0" path.
  if (process.stdin.isTTY) {
    const shellResult = await runShellEntry()
    if (shellResult.entered) {
      process.exitCode = shellResult.exitCode
    } else if (shellResult.reason === 'json-unsupported') {
      console.error('advisers: E_USAGE: --json is not supported by the interactive shell; use `advisers tui --once --json` or a CLI command with --json.')
      process.exitCode = 1
    } else {
      // ADVISERS_NO_SHELL=1 (or an unusable stream pair) keeps the old REPL.
      await repl()
    }
  } else {
    help()
  }
} else if (command === 'version' || command === '--version' || command === '-v') {
  console.log(VERSION)
} else if (command === 'help' || command === '--help') {
  help()
} else if (command === 'chat') {
  await chat(args)
} else if (command === 'status') {
  const parsed = parseStrictFlags(args, { booleans: ['json'], positional: false })
  if (!parsed.ok) usageFail(parsed.error, 'usage: advisers status [--json]')
  else printStatus(parsed.flags.json === true)
} else if (command === 'doctor') {
  await doctor(args)
} else if (command === 'init') {
  init()
} else if (command === 'history') {
  printHistory()
} else if (command === 'mcp') {
  if (args.includes('--stdio')) await mcpServer()
  else { console.error('usage: advisers mcp --stdio'); process.exitCode = 1 }
} else if (command === 'deliver') {
  await deliver(args)
} else if (command === 'timestamp') {
  await timestampCommand(args)
} else if (command === 'tui') {
  await tui(args)
} else if (command === 'ocr') {
  await ocrCommand(args)
} else if (command === 'evidence') {
  await printEvidence(args)
} else if (command === 'receipt') {
  printReceipt()
} else if (command === 'deliveries') {
  if (args.includes('--receipt')) await receiptPack(args)
  else if (args.includes('--pack')) await evidencePack(args)
  else if (args.includes('--json')) console.log(JSON.stringify(readStoreOrExit()?.listDeliveries(100) ?? [], null, 2))
  else printDeliveries()
} else if (command === 'learn') {
  const sub = args[0]
  if (sub === 'ls') {
    // 0.2.3: read-only task-run list, lock-free.
    for (const r of readStoreOrExit()?.listTaskRuns(20) ?? []) console.log(`${r.id}\t${r.outcome}\t${r.tools.map((t) => t.name).join(',')}\t${r.task.slice(0, 60)}`)
  } else if (sub === 'review') {
    const learnLedger = loadLedger()
    const learnDenied = egressDeniedReason(learnLedger.getMatter(activeMatterId(learnLedger)), 'learn review')
    if (learnDenied) { console.error(learnDenied); process.exitCode = 1 }
    else {
      const store = dbStore()
      const run = store?.listTaskRuns(100).find((r) => r.id === args[1])
      const apiKey = process.env.ADVISERS_API_KEY
      if (!run || !apiKey) { console.error('usage: ADVISERS_API_KEY=... advisers learn review <run-id>'); process.exitCode = 1 }
      else {
        const ledger = loadLedger()
        const { reviewRun, lintReview, materializeReview } = await loadReview()
        const review = await reviewRun({ run, routines: ledger.listRoutines(), apiKey, baseUrl: process.env.ADVISERS_BASE_URL, model: process.env.ADVISERS_MODEL })
        const checked = lintReview(review, { run, routines: ledger.listRoutines() })
        if (!checked.ok) { console.error(`review rejected: ${checked.error}`); process.exitCode = 1 }
        else {
          const made = materializeReview(checked.review, { run, ledger })
          saveLedger(ledger)
          console.log(`verdict: ${made.verdict}${made.routine ? ` draft ${made.routine.id}` : made.patch ? ` patch ${made.patch.id}` : ''}`)
        }
      }
    }
  } else { console.error('usage: advisers learn ls|review <run-id>'); process.exitCode = 1 }
} else if (command === 'commit') {
  // 0.2.3 persistence v2 §3.3.1-§3.3.4: every commit write is one directed
  // INSERT/UPDATE + meta upsert + exactly one audit row inside a single
  // BEGIN IMMEDIATE (mutateWithAudit). Validation and file checks stay outside
  // the transaction; JSON-store mode keeps the legacy in-memory path.
  const sub = args[0]
  const { flags, positional } = parseFlags(args.slice(1))
  if (sub === 'add') {
    const usage = 'usage: advisers commit add "<action>" --quote "<原话>" [--due ISO|相对日期] [--debtor user|agent] [--creditor name] [--matter id] [--remind-offsets "-1d,-2h"]'
    const action = positional.join(' ').trim()
    if (!action || !flags.quote) { console.error(usage); process.exitCode = 1 }
    else {
      let reminderOffsets
      let offsetsError
      try { reminderOffsets = await parseReminderOffsetsFlag(flags) } catch (error) { offsetsError = error }
      // 0.4.3 (043-1): resolve --due before anything is written. A refusal never
      // creates a commitment and never stores the raw expression.
      const dueInfo = typeof flags.due === 'string' ? await resolveDueFlag(flags.due) : undefined
      if (dueInfo && !dueInfo.ok) reportDueFailure(dueInfo, flags.json === true)
      if (dueInfo && !dueInfo.ok) { /* refusal already reported; nothing to write */ }
      else if (offsetsError) { console.error(offsetsError.message); process.exitCode = 1 }
      else if (mode === 'json') {
        try {
          const ledger = loadJson()
          const c = ledger.addCommitment({
            matterId: resolveMatterForCommand(ledger, flags.matter, 'commit add'),
            debtor: flags.debtor ?? 'user',
            creditor: flags.creditor ?? /(?:发给|给|向|对)([\u4e00-\u9fa5A-Za-z0-9_]{1,12})/.exec(action)?.[1] ?? 'someone',
            action,
            dueAt: dueInfo?.ok ? dueInfo.at : undefined,
            timezone: flags.tz ?? 'Asia/Shanghai',
            capability: flags.capability ?? 'todo',
            evidence: [manualEvidence(String(flags.quote), 'commit add')],
            ...(reminderOffsets !== undefined ? { reminderOffsets } : {}),
          })
          saveJson(ledger)
          printCommitAdded(c, reminderOffsets)
        } catch (error) { reportCommandFailure(error) }
      } else {
        const audit = { actor: 'local', action: 'commit.add', allowed: true, reason: '' }
        try {
          const { result: c } = mutateWithAudit((store) => {
            const commitment = core.createCommitment({ clock: LOCAL_PORTS.clock, ids: LOCAL_PORTS.ids }, {
              matterId: resolveWriteMatterId(store, flags.matter),
              debtor: flags.debtor ?? 'user',
              creditor: flags.creditor ?? /(?:发给|给|向|对)([\u4e00-\u9fa5A-Za-z0-9_]{1,12})/.exec(action)?.[1] ?? 'someone',
              action,
              dueAt: dueInfo?.ok ? dueInfo.at : undefined,
              timezone: flags.tz ?? 'Asia/Shanghai',
              capability: flags.capability ?? 'todo',
              evidence: [manualEvidence(String(flags.quote), 'commit add')],
              ...(reminderOffsets !== undefined ? { reminderOffsets } : {}),
            })
            store.insertCommitment(commitment)
            audit.reason = commitment.id
            return commitment
          }, audit)
          printCommitAdded(c, reminderOffsets)
        } catch (error) { reportCommandFailure(error) }
      }
      const resolutionLine = dueInfo?.ok ? dueResolutionLine(dueInfo) : null
      if (resolutionLine) console.error(sanitizeConsoleText(resolutionLine, { max: 500 }))
    }
  } else if (sub === 'edit' || sub === 'update') {
    const id = positional[0]
    const usage = 'usage: advisers commit edit <id> [--action text] [--due ISO|相对日期] [--matter id] [--remind-offsets "<list>" | --no-remind]'
    if (!id) { console.error(usage); process.exitCode = 1 }
    else {
      const patch = {}
      // 0.4.3 (043-1): same boundary resolution as commit add; a refusal leaves
      // the commitment untouched.
      const dueInfo = typeof flags.due === 'string' ? await resolveDueFlag(flags.due) : undefined
      if (dueInfo && !dueInfo.ok) reportDueFailure(dueInfo, flags.json === true)
      if (dueInfo?.ok) patch.dueAt = dueInfo.at
      if (typeof flags.action === 'string') patch.action = flags.action
      if (typeof flags.tz === 'string') patch.timezone = flags.tz
      if (typeof flags.capability === 'string') patch.capability = flags.capability
      if (typeof flags.matter === 'string') patch.matterId = flags.matter
      let offsetsError
      try {
        if (flags['no-remind'] === true) patch.reminderOffsets = null
        else {
          const offsets = await parseReminderOffsetsFlag(flags)
          if (offsets !== undefined) patch.reminderOffsets = offsets
        }
      } catch (error) { offsetsError = error }
      if (dueInfo && !dueInfo.ok) { /* refusal already reported; nothing to update */ }
      else if (offsetsError) { console.error(offsetsError.message); process.exitCode = 1 }
      else if (!Object.keys(patch).length) { console.error(usage); process.exitCode = 1 }
      else {
        try {
          if (mode === 'json') {
            try {
              const ledger = loadJson()
              if (typeof patch.matterId === 'string') {
                const matter = ledger.getMatter(patch.matterId)
                if (!matter) throw matterCommandError('E_MATTER_NOT_FOUND', 'unknown matter: ' + patch.matterId, 'advisers matter ls')
                if (matter.status !== 'active') throw matterCommandError('E_MATTER_ARCHIVED', 'matter is archived: ' + patch.matterId, 'advisers matter ls')
                const current = ledger.listCommitments().find((row) => row.id === id)
                if (!current) throw new Error('unknown commitment: ' + id)
                current.matterId = patch.matterId
              }
              const c = ledger.updateCommitment(id, patch)
              saveJson(ledger)
              printCommitUpdated(c, patch)
            } catch (error) { reportCommandFailure(error) }
          } else {
            const audit = { actor: 'local', action: 'commit.update', allowed: true, reason: id }
            const { result: c } = mutateWithAudit((store) => {
              const current = store.getCommitment(id)
              if (!current) throw new Error(`unknown commitment: ${id}`)
              const effectivePatch = { ...patch }
              if (typeof effectivePatch.matterId === 'string') effectivePatch.matterId = resolveWriteMatterId(store, effectivePatch.matterId)
              const next = core.updateCommitmentFields(current, effectivePatch)
              if (effectivePatch.matterId) next.matterId = effectivePatch.matterId
              store.updateCommitment(id, effectivePatch)
              return next
            }, audit)
            printCommitUpdated(c, patch)
          }
        } catch (error) { reportCommandFailure(error) }
      }
      const resolutionLine = dueInfo?.ok ? dueResolutionLine(dueInfo) : null
      if (resolutionLine) console.error(sanitizeConsoleText(resolutionLine, { max: 500 }))
    }
  } else if (sub === 'ls') {
    if (mode === 'json') printCommitments(loadJson(), flags.json)
    else printCommitments(loadReadLedger({ commitments: {} }), flags.json)
  } else if (sub === 'snooze') {
    const id = positional[0]
    const hours = Number(positional[1] ?? 24)
    const usage = 'usage: advisers commit snooze <id> <hours>'
    if (!id || !Number.isFinite(hours) || hours <= 0) { console.error(usage); process.exitCode = 1 }
    else if (mode === 'json') {
      const ledger = loadJson()
      const c = ledger.listCommitments().find((x) => x.id === id)
      if (!c) { console.error(usage); process.exitCode = 1 }
      else { c.status = 'snoozed'; saveJson(ledger); console.log(`snoozed: ${id} for ${hours}h`) }
    } else {
      try {
        if (!dbStore().getCommitment(id)) { console.error(usage); process.exitCode = 1 }
        else {
          const audit = { actor: 'local', action: 'commit.snooze', allowed: true, reason: id }
          mutateWithAudit((store) => {
            store.updateCommitment(id, { status: 'snoozed' })
            store.setMeta(`snooze:${id}`, new Date(Date.now() + hours * 3600_000).toISOString())
          }, audit)
          console.log(`snoozed: ${id} for ${hours}h`)
        }
      } catch (error) { reportCommandFailure(error) }
    }
  }
  else if (sub === 'done') {
    const id = positional[0]
    const evidence = flags.evidence
    if (!id || !evidence) { console.error('usage: advisers commit done <id> --evidence "<证据/原话>"'); process.exitCode = 1 }
    else if (String(evidence).startsWith('file:') && !existsSync(String(evidence).slice(5))) {
      console.error(`evidence file not found: ${String(evidence).slice(5)}`); process.exitCode = 1
    } else if (mode === 'json') {
      const ledger = loadJson()
      try {
        ledger.completeCommitment(id, [manualEvidence(String(evidence), 'commit done')])
        saveJson(ledger)
        console.log(`done: ${id}`)
      } catch (error) { console.error(error.message); process.exitCode = 1 }
    } else {
      const audit = { actor: 'local', action: 'commit.done', allowed: true, reason: id }
      try {
        mutateWithAudit((store) => {
          const current = store.getCommitment(id)
          if (!current) throw new Error(`unknown commitment: ${id}`)
          const next = core.completeCommitment(current, [manualEvidence(String(evidence), 'commit done')], now())
          store.updateCommitment(id, { status: next.status, doneAt: next.doneAt, evidence: next.evidence })
        }, audit)
        console.log(`done: ${id}`)
      } catch (error) { reportCommandFailure(error) }
    }
  } else if (flags.json === true) {
    // 0.3.0 JSON contract (plan 26 §5.4): a failed --json invocation must not
    // print human prose on stdout. Unknown subcommands (e.g. `commit show`) get
    // the error envelope on stderr, an empty stdout and exit 1.
    console.error(JSON.stringify({ error: { code: 'E_USAGE', message: 'unknown commit subcommand: ' + String(sub ?? ''), hint: 'usage: advisers commit add|edit|ls|done|snooze [--json]' } }))
    process.exitCode = 1
  } else { console.error('usage: advisers commit add|edit|ls|done|snooze'); process.exitCode = 1 }
} else if (command === 'diff') {
  const { diffLatest } = await loadUndo()
  const result = await diffLatest({ cwd: process.cwd(), backupDir: join(HOME, 'undo') })
  console.log(result.ok ? result.diff : `diff failed: ${result.error}`)
  if (!result.ok) process.exitCode = 1
} else if (command === 'undo') {
  const { listBackups, undoLatest } = await loadUndo()
  if (args.includes('--list')) {
    for (const row of await listBackups(join(HOME, 'undo'), { workspace: process.cwd() })) console.log(`${row.id}\t${row.path}\t${row.existed ? 'overwrite' : 'create'}`)
  } else {
    const result = await undoLatest({ cwd: process.cwd(), backupDir: join(HOME, 'undo'), force: args.includes('--force') })
    console.log(result.ok ? `已回滚：${result.path}` : `撤销失败：${result.error}`)
    if (!result.ok) process.exitCode = 1
  }
} else if (command === 'compact') {
  if (args[0] === 'ls') {
    // 0.2.3: version listing is a pure read (lock-free).
    const store = readStoreOrExit()
    const conversationId = store?.listSessions(1)?.[0]?.conversationId ?? 'local'
    for (const v of store?.listSummaryVersions(conversationId) ?? []) console.log(`${v.version}\t${v.throughSeq}\t${v.summary.slice(0, 100)}`)
  } else if (args[0] === 'rollback') {
    const store = dbStore()
    const conversationId = latestConversationId()
    const version = Number(args[1])
    const old = store?.listSummaryVersions(conversationId).find((v) => v.version === version)
    if (!old) { console.error('usage: advisers compact rollback <version>'); process.exitCode = 1 }
    else { store.upsertSessionSummary({ conversationId, summary: old.summary, throughSeq: old.throughSeq, pins: old.pins }); console.log(`restored summary v${version}`) }
  } else { console.error('usage: advisers compact ls|rollback <version>'); process.exitCode = 1 }
} else if (command === 'search') {
  // 0.4.0 additive routing: --scope turns|kb|pages|facts|all. Without --scope
  // the 0.3.2 bytes are unchanged (turn search, human lines).
  if (args.includes('--scope')) await scopedSearch(args)
  else {
    const q = args.join(' ').trim()
    if (!q) { console.error('usage: advisers search <text>'); process.exitCode = 1 }
    else {
      // 0.2.3: turn search is a pure read (lock-free; reads the WAL snapshot).
      const rows = readStoreOrExit()?.searchTurns(q, { limit: 10 }) ?? []
      if (!rows.length) console.log('没有匹配')
      for (const r of rows) console.log(`${r.seq}\t${r.role}\t${r.content.replace(/\s+/g, ' ').slice(0, 160)}`)
    }
  }
} else if (command === 'nudge') {
  const sub = args[0]
  if (sub === 'list') {
    for (const n of readStoreOrExit()?.listNudges(50) ?? []) console.log(`${n.id}\t${n.local_day}\t${n.level}\t${n.outcome}\t${n.body}`)
  } else if (sub === 'done' || sub === 'ignore') {
    const id = args[1]
    const store = dbStore()
    if (!id || !store?.setNudgeOutcome(id, sub === 'done' ? 'accepted' : 'ignored')) { console.error('usage: advisers nudge done|ignore <nudge-id>'); process.exitCode = 1 }
    else console.log(`${sub}: ${id}`)
  } else { console.error('usage: advisers nudge list|done|ignore'); process.exitCode = 1 }
} else if (command === 'risks') {
  risks(readLedgerForCommand({ commitments: { status: 'open' } }))
} else if (command === 'pet-brief') {
  await petBrief(args)
} else if (command === 'today') {
  // P1-2 (0.2.2): today only reads open commitments; --sources reports source
  // rows for every commitment, so that flag keeps the wider load. 0.2.3 reads
  // it through the lock-free store.
  const sources = args.includes('--sources')
  const asJson = args.includes('--json')
  const limitInfo = parseTodayLimit(args)
  if (limitInfo.error) {
    usageFail(limitInfo.error, 'usage: advisers today [--calendar] [--sources] [--json] [--limit n]')
  } else if (asJson && limitInfo.limit !== null && !sources && mode === 'sqlite') {
    // 0.3.2 fast path: classify the narrow projection, then hydrate only the
    // capped bucket rows (full Commitment entities, same order).
    await today(loadOpenCommitmentRowsForToday(), {
      calendar: args.includes('--calendar'),
      json: true,
      limit: limitInfo.limit,
      hydrate: hydrateCommitmentsForToday,
    })
  } else if (asJson || sources) {
    // The JSON contract and --sources need full commitment entities (evidence).
    // 0.3.0 P0-T1: 'table' reads the table without the status index, so the
    // historical rowid order is kept with no ORDER BY rowid TEMP B-TREE spill
    // (today --json used to write 10 MB per run at a 200k-row ledger).
    const ledger = readLedgerForCommand({ commitments: sources ? {} : { status: 'open', order: 'table' } })
    await today(ledger.openCommitments(), { calendar: args.includes('--calendar'), sources, json: asJson, ledger, limit: limitInfo.limit })
  } else {
    // Human view: six columns + the cached classification (0.2.3 hot path).
    await today(loadOpenCommitmentRowsForToday(), { calendar: args.includes('--calendar') })
  }
} else if (command === 'tick') {
  // tick is a WRITER (nudges + snooze wake-ups) but only needs commitments.
  tick(loadLedger({ commitments: {} }), args.includes('--json'))
} else if (command === 'ui') {
  await ui(args)
} else if (command === 'remind') {
  await remind(args)
} else if (command === 'calendar') {
  await calendarImport(args.slice(1))
} else if (command === 'who') {
  const open = readLedgerForCommand({ commitments: { status: 'open' } }).openCommitments()
  const mine = open.filter((c) => c.debtor === 'user' || c.debtor === 'agent')
  const waiting = open.filter((c) => c.debtor === 'third' || c.debtor.startsWith('third:'))
  if (args.includes('--json')) { console.log(JSON.stringify({ mine, waiting }, null, 2)); }
  else {
    console.log(`我欠别人（${mine.length}）`)
    for (const c of mine) console.log(`  ${c.id}  ${c.creditor} · ${c.action}${c.dueAt ? ` · ${c.dueAt.slice(0, 10)}` : ''}`)
    console.log(`等别人/别人欠我（${waiting.length}）`)
    for (const c of waiting) console.log(`  ${c.id}  ${c.debtor} · ${c.action}${c.dueAt ? ` · ${c.dueAt.slice(0, 10)}` : ''}`)
  }
} else if (command === 'memory') {
  // 0.2.3: candidates/search printMemory are pure reads (lock-free, partial);
  // accept is the most involved directed write (§3.3.9) — candidate status,
  // entity row and audit all commit or roll back together.
  const sub = args[0]
  const sourceRef = (e) => ({ ...(e.sessionId ? { quote: e.quote, ref: `${e.sessionId}#${e.turnId}` } : { quote: e.quote, ref: e.turnId ? `legacy#${e.turnId}` : undefined }), ...(e.source ? { source: e.source } : {}) })
  if (sub === 'candidates') {
    const store = readStoreOrExit()
    const rows = store?.listCandidates(args.includes('--all') ? 'all' : 'pending') ?? []
    if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2))
    else {
      if (!rows.length) console.log('（没有待确认记忆）')
      for (const c of rows) console.log(`${c.id}\t${c.kind}\t${JSON.stringify(c.payload)}\t${c.status}`)
    }
  } else if (sub === 'accept') {
    if (mode === 'json') {
      // The legacy JSON store has no candidate table (same as 0.2.2).
      console.error('candidate not found'); process.exitCode = 1
    } else {
      const store = dbStore()
      const candidate = store?.getCandidate(args[1])
      if (!candidate) { console.error('candidate not found'); process.exitCode = 1 }
      else {
        try {
          const commitmentEvidence = (e) => {
            if (!e.sessionId) return { quote: e.quote, turnId: e.turnId, sessionId: 'legacy', ...(e.source ? { source: e.source } : {}) }
            const turn = store.getTurn(e.turnId)
            if (!turn || turn.conversationId !== e.sessionId) throw new Error(`evidence turn not found: ${e.turnId}`)
            return { quote: e.quote, turnId: e.turnId, sessionId: e.sessionId, ...(e.source ? { source: e.source } : {}) }
          }
          const audit = { actor: 'local', action: 'memory.accept', allowed: true, reason: candidate.id }
          mutateWithAudit((s) => {
            const opsPorts = { clock: LOCAL_PORTS.clock, ids: LOCAL_PORTS.ids }
            if (candidate.kind === 'fact') {
              const input = { ...candidate.payload, authority: 'user', evidence: candidate.evidence.map(sourceRef) }
              const current = s.findFactCurrent({ subject: input.subject, predicate: input.predicate, matterId: input.matterId ?? null })
              const outcome = core.applyRemember(current, input, opsPorts)
              if (outcome.op === 'update') {
                s.updateFact(outcome.row.id, { evidence: outcome.row.evidence, source: outcome.row.source, authority: outcome.row.authority, lastSeenAt: outcome.row.lastSeenAt })
              } else if (outcome.op === 'insert') {
                s.insertFact(outcome.row)
              } else {
                s.updateFact(outcome.old.id, { status: outcome.old.status, validTo: outcome.old.validTo, expiredAt: outcome.old.expiredAt, supersededBy: outcome.old.supersededBy })
                s.insertFact(outcome.row)
              }
            } else if (candidate.kind === 'preference') {
              s.insertPreference(core.createPreference(opsPorts, { ...candidate.payload, evidence: candidate.evidence.map(sourceRef) }))
            } else if (candidate.kind === 'commitment') {
              const input = {
                ...candidate.payload,
                // Mail/KB candidates may arrive before any matter exists; a
                // commitment must always point at a real matter (SQLite binds
                // undefined as an error, and the ledger tolerates no dangling).
                matterId: candidate.payload.matterId ?? s.firstActiveMatter?.()?.id ?? resolveDeliveryMatterId(s),
                evidence: candidate.evidence.map(commitmentEvidence),
              }
              s.insertCommitment(core.createCommitment(opsPorts, input))
            }
            s.reviewCandidate(candidate.id, 'accepted')
          }, audit)
          console.log(`accepted ${candidate.id}`)
        } catch (error) { console.error(error.message); process.exitCode = 1 }
      }
    }
  } else if (sub === 'reject') {
    const store = dbStore()
    const candidate = store?.getCandidate(args[1])
    if (!candidate) { console.error('candidate not found'); process.exitCode = 1 }
    else {
      try {
        updateStoreWithAudit((s) => s.reviewCandidate(candidate.id, 'rejected', args.slice(2).join(' ') || undefined), { actor: 'local', action: 'memory.reject', allowed: true, reason: candidate.id })
        console.log(`rejected ${candidate.id}`)
      } catch (error) { reportCommandFailure(error) }
    }
  } else if (sub === 'search') {
    const q = args.slice(1).join(' ').trim()
    if (!q) { console.error('usage: advisers memory search <query>'); process.exitCode = 1 }
    else {
      const store = readStoreOrExit()
      const rows = store ? store.searchMemory(q) : loadJson().searchMemory(q)
      if (!rows.length) console.log('（没有记忆匹配）')
      for (const r of rows) console.log(`${r.kind}\t${r.id}\t${r.text}${r.matterId ? `\t[${r.matterId}]` : ''}`)
      const turns = store?.searchTurns(q) ?? []
      for (const t of turns) console.log(`turn\t${t.conversationId}#${t.seq}\t${String(t.text).replace(/\s+/g, ' ').slice(0, 120)}`)
    }
  } else if (mode === 'json') printMemory(loadJson())
  else printMemory(loadReadLedger({ preferences: {}, commitments: {}, routines: {} }))
} else if (command === 'matter') {
  await matterCommand(args)
} else if (command === 'client') {
  await clientCommand(args)
} else if (command === 'project') {
  projectCommand(args)
} else if (command === 'agenda') {
  await agendaCommand(args)
} else if (command === 'morning') {
  await morningReportCommand(args)
} else if (command === 'kb') {
  await kbCommand(args)
} else if (command === 'fact') {
  await factCommand(args)
} else if (command === 'mail') {
  await mailCommand(args)
} else if (command === 'receivable') {
  await receivableCommand(args)
} else if (command === 'payment') {
  await paymentCommand(args)
} else if (command === 'consent') {
  await consentCommand(args)
} else if (command === 'digest') {
  if (args[0] === 'morning') await morningReportCommand(args.slice(1))
  else {
  const period = args[0] === 'week' ? 'week' : 'day'
  const store = readStoreOrExit()
  const { buildDigest } = await loadDigest()
  // 0.3.0 P0-T2: digest reads status/action/dueAt/doneAt only; the narrow
  // projection keeps rowid order without mapping 100k full entities.
  const commitments = mode === 'json' || !store
    ? loadJson().listCommitments()
    : store.read(() => store.projectCommitmentsForDigest())
  const conversationId = store?.listSessions(1)?.[0]?.conversationId ?? 'local'
  const { turns, deliveries } = store
    ? store.read(() => ({ turns: store.listTurns(conversationId, 200), deliveries: store.listDeliveries(100) }))
    : { turns: [], deliveries: [] }
  console.log(buildDigest({ period, turns, commitments, deliveries }))
  }
} else if (command === 'week') {
  // --json is the output flag; `mode` is the store (sqlite|json) and must not
  // decide the output format (0.2.4 bug: `advisers week --json` printed Chinese
  // human text even in SQLite mode).
  const weekJson = args.includes('--json')
  const weekLedger = mode === 'json' ? loadJson() : loadReadLedger({ commitments: {} })
  printWeek(weekLedger, weekJson)
} else if (command === 'prefs') {
  printPreferences()
} else if (command === 'privacy') {
  await printPrivacy(args)
} else if (command === 'audit') {
  await auditCommand(args)
} else if (command === 'purge') {
  purgeMatter(args[0], args.includes('--yes'))
} else if (command === 'decay') {
  // 0.2.3 §3.3.7: read one table, update only the changed preferences (no audit,
  // historical behaviour). WAL grows with changed rows, not ledger size.
  const { applyPreferenceDecay } = await loadLearning()
  if (mode === 'json') {
    const ledger = loadJson()
    const changed = applyPreferenceDecay(ledger.listPreferences({ includeCandidates: true }))
    saveJson(ledger)
    console.log(`[decay] ${changed.length} preference(s) updated`)
  } else {
    try {
      const store = dbStore()
      const changed = applyPreferenceDecay(store.loadPreferences())
      if (changed.length) {
        mutateWithAudit((s) => {
          for (const pref of changed) s.updatePreference(pref.id, { confidence: pref.confidence, status: pref.status })
        }, null)
      }
      console.log(`[decay] ${changed.length} preference(s) updated`)
    } catch (error) { reportCommandFailure(error) }
  }
} else if (command === 'correct') {
  // 0.2.3 §3.3.6: same confirmation rule as learnPreference, applied as one
  // targeted UPDATE/INSERT + audit (no full ledger load/save).
  const statement = args.join(' ').trim()
  if (!statement) { console.error('usage: advisers correct <statement>'); process.exitCode = 1 }
  else if (mode === 'json') {
    const ledger = loadJson()
    const result = learnPreference(ledger, statement, statement, { explicit: true })
    saveJson(ledger)
    printLearnReceipt(result)
  } else {
    try {
      const timestamp = now()
      const audit = { actor: 'local', action: 'correct', allowed: true, reason: '' }
      const { result } = mutateWithAudit((store) => {
        const opsPorts = { clock: LOCAL_PORTS.clock, ids: LOCAL_PORTS.ids }
        const existing = store.findPreferenceByStatement(statement)
        let next
        if (existing) {
          next = core.confirmPreference(existing, timestamp)
          store.updatePreference(existing.id, {
            confidence: next.preference.confidence,
            lastConfirmed: next.preference.lastConfirmed,
            status: next.preference.status,
          })
        } else {
          const pref = core.createPreference(opsPorts, {
            kind: 'preference',
            statement,
            source: { type: 'user_explicit', quote: statement },
            confidence: 0.8,
            status: 'confirmed',
          })
          store.insertPreference(pref)
          next = { preference: pref, promoted: false }
        }
        audit.reason = next.preference.id
        return next
      }, audit)
      printLearnReceipt(result)
    } catch (error) { reportCommandFailure(error) }
  }
} else if (command === 'ls') {
  ls()
} else if (command === 'why') {
  why(args[0])
} else if (command === 'forget') {
  forget(args[0])
} else if (command === 'sync') {
  await syncCommand(args)
} else if (command === 'vault') {
  const sub = args[0]
  if (sub === 'seal') await vaultSeal(args.slice(1))
  else if (sub === 'unseal') await vaultUnseal(args.slice(1))
  else if (sub === 'status' || !sub) vaultStatus()
  else { console.error('usage: advisers vault seal [--out file] [--remove] | unseal [file] | status'); process.exitCode = 1 }
} else if (command === 'export') {
  const parsed = parseStrictFlags(args, { booleans: ['all', 'encrypted'], values: ['out'], positional: false })
  if (!parsed.ok) usageFail(parsed.error, 'usage: advisers export [--all] [--out <file>] [--encrypted]')
  else await exportLedger(parsed.flags.all === true, { encrypted: parsed.flags.encrypted === true, out: typeof parsed.flags.out === 'string' ? parsed.flags.out : undefined })
} else if (command === 'import') {
  await importLedger(args.find((a) => !a.startsWith('--')), { replace: args.includes('--replace') })
} else if (command === 'backup') {
  await backupCommand(args)
} else if (command === 'backups') {
  await backupsCommand(args)
} else if (command === 'restore') {
  await restoreCommand(args)
} else if (command === 'brief') {
  await brief(args.filter((a) => a !== '--deep').join(' ').trim(), args.includes('--deep'))
} else if (command === 'review') {
  await documentReview(args)
} else if (command === 'research') {
  await research(args)
} else if (command === 'capture') {
  await capture(args)
} else if (command === 'inbox') {
  await inboxCommand(args)
} else if (command === 'profile') {
  await profileCommand(args)
} else if (command === 'policy') {
  const sub = args[0]
  if (sub === 'check') {
    const text = args.slice(1).join(' ').trim()
    if (!text) { console.error('usage: advisers policy check "<text>"'); process.exitCode = 1 }
    else {
      const crisis = new core.KeywordCrisisPolicy().scan(text)
      const pack = StrictPolicyPack ? new StrictPolicyPack() : undefined
      const decision = pack?.resolve({ use: 'understanding', crisis: crisis.tier === 'T1' || crisis.tier === 'T2' || (crisis.tier === 'T3' && crisis.thirdParty) }) ?? { allowed: false, action: 'deny', code: 'FAIL_CLOSED', reason: 'policy pack missing' }
      console.log(JSON.stringify({ tier: crisis.tier, crisis: crisis.crisis, decision }, null, 2))
    }
  } else { console.error('usage: advisers policy check "<text>"'); process.exitCode = 1 }
} else if (command === 'office-edit') {
  const source = args[0]
  const opsFile = args[1]
  const out = args[2] || source
  if (!source || !opsFile) { console.error('usage: advisers office-edit <file> <ops.json> [out]'); process.exitCode = 1 }
  else {
    let mod
    if (process.env.ADVISERS_OFFICE_LOCAL === '1') mod = await import('../../office/dist/index.js')
    else { try { mod = await import('advisers-office') } catch { mod = await import('../../office/dist/index.js') } }
    const ext = source.split('.').pop()?.toLowerCase()
    const result = await mod.editOffice(readFileSync(source), ext, JSON.parse(readFileSync(opsFile, 'utf8')))
    if (!result.ok) { console.error(result.error); process.exitCode = 1 }
    else { await backupCliFile(out); writeFileSync(out, result.buffer); recordManualDelivery([out], 'office-edit', source, 'edited'); console.log(JSON.stringify({ ok: true, out, changes: result.changes }, null, 2)) }
  }
} else if (command === 'office-read') {
  const file = args[0]
  if (!file) { console.error('usage: advisers office-read <file>'); process.exitCode = 1 }
  else {
    if (file.toLowerCase().endsWith('.ofd')) {
      try {
        const { ofdText } = await loadAttachments()
        console.log(await ofdText(readFileSync(file)))
      } catch (error) { console.error(`ofd read failed: ${error.message}`); process.exitCode = 1 }
    } else {
      let mod
      if (process.env.ADVISERS_OFFICE_LOCAL === '1') mod = await import('../../office/dist/index.js')
      else { try { mod = await import('advisers-office') } catch { mod = await import('../../office/dist/index.js') } }
      const doc = await mod.readOffice(readFileSync(file))
      console.log(mod.officeToText(doc, Number(args[1]) || 20_000))
    }
  }
} else if (command === 'verify') {
  const { flags, positional } = parseFlags(args)
  const file = positional[0]
  if (!file) { console.error('usage: advisers verify <file> [--json] [--content]'); process.exitCode = 1 }
  else {
    const ext = file.split('.').pop()?.toLowerCase()
    if (!['docx', 'xlsx', 'pptx'].includes(ext)) { console.error('verify supports docx/xlsx/pptx'); process.exitCode = 1 }
    else {
      try {
        const verifyOffice = await loadOfficeOperation('verify', 'verifyOffice')
        const result = await verifyOffice(readFileSync(file), ext)
        if (flags.content === true) {
          const checkOffice = await loadOfficeOperation('check', 'checkOffice')
          const content = await checkOffice(readFileSync(file), ext)
          if (typeof flags.template === 'string') {
            const templateName = flags.template
            if (templateName !== 'quote' && templateName !== 'proposal') throw new Error('E_TEMPLATE_UNKNOWN: unknown template ' + templateName)
            if (typeof flags.data !== 'string') throw new Error('E_TEMPLATE_INVALID: --template requires --data <data.json>')
            const raw = JSON.parse(readFileSync(flags.data, 'utf8'))
            const normalized = normalizeQuoteData(raw, templateName)
            const evidence = await loadEvidence()
            const dataSha256 = evidence.sha256Hex(evidence.stableStringify(normalized.data, { space: 0 }))
            const text = (await readOfficeText(file, ext)) ?? ''
            const extraChecks = quoteTemplateChecks(templateName, normalized, dataSha256, text)
            content.checks = Array.isArray(content.checks) ? content.checks.concat(extraChecks) : extraChecks
            content.template = { name: templateName, version: normalized.templateVersion ?? QUOTE_TEMPLATE_VERSION, dataSha256: dataSha256, totals: quoteTotalsJson(normalized) }
            if (!extraChecks.every((check) => check.ok)) content.ok = false
          }
          console.log(JSON.stringify({ structure: result, content }, null, 2))
          if (!content.ok) process.exitCode = 1
        } else console.log(JSON.stringify(result, null, 2))
        if (!result.ok) process.exitCode = 1
      } catch (error) {
        console.error(`verify failed: ${error.message}`)
        process.exitCode = 1
      }
    }
  }
} else if (command === 'office') {
  await office(args[0], args[1], args[2])
  process.exit(process.exitCode || 0)
} else if (command === 'routine') {
  await routine(args[0], args[1], args[2])
} else if (command === 'template') {
  await template(args)
  process.exit(process.exitCode || 0)
} else if (command === 'link') {
  link(args[0], args[1], args[2], args[3])
} else if (command === 'bridge') {
  await bridge(args)
} else if (command === 'soul') {
  await soul(args[0], args[1])
} else if (command === 'tos') {
  await tosCommand(args)
} else {
  console.error(`unknown command: ${command}`)
  help()
  process.exitCode = 1
}
