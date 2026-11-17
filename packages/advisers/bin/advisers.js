#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
let SqliteStore
try {
  ({ SqliteStore } = await import('../lib/sqlite.js'))
} catch (error) {
  if (String(error?.message || error).includes('node:sqlite')) {
    console.error(`Advisers needs Node >= 22.16 (node:sqlite). You have ${process.version}. Install Node 24 or use nvm-windows.`)
    process.exit(1)
  }
  throw error
}
import { runAgent } from '../lib/agent.js'
import { chatCompletion } from '../lib/model.js'
import { applyPreferenceDecay, buildRoutineCandidate, correctionStatement } from '../lib/learning.js'
import { checkRoutine } from '../lib/routine.js'
import { backupBeforeWrite, diffLatest, listBackups, undoLatest } from '../lib/undo.js'
import { lintReview, materializeReview, reviewRun } from '../lib/review.js'
import { classifyNudgeOutcome } from '../lib/nudge.js'
import { buildDigest } from '../lib/digest.js'
import { captureCandidates } from '../lib/capture.js'
import { egressDeniedReason } from '../lib/egress.js'
import { research as runResearch } from '../lib/research.js'
import { reviewDocument } from '../lib/doc-review.js'
import { buildHistory, buildOpening, buildPins, continuityProbes, ensurePins, fitHistory, shouldSummarize, summarizeTurns } from '../lib/context-window.js'
import {
  PET_BRIEF_DEFAULT_DISPLAY_POLICY,
  PET_BRIEF_DISPLAY_POLICIES,
  PET_BRIEF_MAX_ITEMS,
  PET_BRIEF_MAX_LINE_LENGTH,
  PET_BRIEF_MAX_SUGGESTED_LINES,
  PET_BRIEF_MOODS,
  PET_BRIEF_SCHEMA_VERSION,
  PET_BRIEF_SOURCE,
  buildPetBrief,
  validatePetBrief,
  writePetBriefAtomic,
} from '../lib/pet-brief.js'
import { fetchImapMessages } from '../lib/imap.js'
import { createReadOnlyServer } from '../lib/ui.js'

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
  try {
    if (existsSync(AUDIT_KEY_FILE)) {
      process.env.ADVISERS_AUDIT_KEY = readAuditKey()
      return
    }
    const key = randomBytes(32).toString('hex')
    try {
      // P0-4: O_EXCL so two first-run processes agree on exactly one key. The
      // loser must read the winner's key, not overwrite it (that would leave
      // rows signed with a key that no longer exists on disk).
      writeFileSync(AUDIT_KEY_FILE, key, { mode: 0o600, flag: 'wx' })
      process.env.ADVISERS_AUDIT_KEY = key
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      process.env.ADVISERS_AUDIT_KEY = readAuditKey()
    }
  } catch (error) {
    console.error(`advisers: audit key unavailable (${error.message})`)
    console.error(`  expected a readable ${AUDIT_KEY_FILE} with at least 16 characters.`)
    console.error('  refusing to write an unkeyed audit chain. Restore the key file; if it is lost, move it aside and rerun (the existing chain will then verify as BROKEN).')
    process.exit(1)
  }
}
function ensureHome() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  try { chmodSync(HOME, 0o700) } catch {}
  ensureAuditKey()
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

function openStore({ checkIntegrity = false } = {}) {
  if (!activeStore) {
    const sealed = vaultSealedPath()
    if (sealed) throw vaultSealedError(sealed)
    ensureHome()
    activeStore = new SqliteStore(DB, { checkIntegrity })
    secureDbSidecars()
  } else if (checkIntegrity) {
    activeStore.assertIntegrity()
  }
  return activeStore
}

function loadLedger() {
  ensureHome()
  if (mode === 'json') return loadJson()
  const sealed = vaultSealedPath()
  if (sealed) throw vaultSealedError(sealed)
  try {
    if (!existsSync(DB) && existsSync(STATE)) {
      const ledger = loadJson()
      openStore().save(ledger.toJSON())
      return ledger
    }
    return Ledger.fromJSON(openStore().load(), LOCAL_PORTS)
  } catch (error) {
    console.error(`sqlite unavailable: ${error.message}`)
    console.error('Run `advisers doctor`; refusing to silently switch to JSON (would split the ledger).')
    process.exit(1)
  }
}

function exitStoreWriteFailure(error) {
  // P0-2: never fall back to state.json. The SQLite database is the only ledger
  // once it exists, so a JSON fallback would silently split the book (and the
  // command would still exit 0). Fail loudly instead.
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

function updateStoreWithAudit(fn, audit) {
  ensureHome()
  const store = dbStore()
  if (!store) return
  try {
    return store.transaction(() => {
      fn(store)
      return store.appendAudit(audit)
    })
  } catch (error) {
    exitStoreWriteFailure(error)
  }
}

function recordDeliveryWithAudit({ files, tool, title, validation, audit }) {
  const store = dbStore()
  if (!store) return
  let matterId = 'matter'
  try { matterId = activeMatterId(loadLedger()) } catch {}
  updateStoreWithAudit((s) => s.addDelivery({
    matterId,
    conversationId: latestConversationId(),
    files,
    tool,
    title,
    validation: typeof validation === 'string' ? validation : JSON.stringify(validation),
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

/** Write bytes to an already-created same-directory temp file and fsync it. */
function writeDurableTemp(target, bytes, { mode = 0o600 } = {}) {
  const fd = openSync(target, 'wx', mode)
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return target
}

/** fsync a directory entry so a rename survives a crash. */
function fsyncDir(path) {
  try {
    const fd = openSync(path, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  } catch {}
}

/** Atomic write: same-directory temp + fsync + rename + directory fsync. */
function atomicWriteFileSync(path, bytes, { mode = 0o600 } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    writeDurableTemp(tmp, bytes, { mode })
    renameSync(tmp, path)
  } catch (error) {
    try { if (existsSync(tmp)) rmSync(tmp) } catch {}
    throw error
  }
  try { chmodSync(path, mode) } catch {}
  fsyncDir(dirname(path))
  return path
}

const soulStore = { load: loadSoul, save: saveSoul }

function runtimeFor(ledger) {
  const ports = { ...systemPorts(), soul: soulStore }
  return createAdvisers({ ledger, ports: { ...ports, clock: LOCAL_PORTS.clock, ids: LOCAL_PORTS.ids }, seen: mode === 'sqlite' ? openStore().seenStore() : undefined, ownerIds: process.env.ADVISERS_OWNER?.split(',').map((x) => x.trim()).filter(Boolean), defaultMatterId: activeMatterId(ledger), policyResolver: StrictPolicyPack ? new StrictPolicyPack() : { resolve: () => ({ allowed: false, action: 'deny', code: 'FAIL_CLOSED', reason: 'policy pack missing' }) } })
}

async function backupCliFile(path) {
  try { await backupBeforeWrite(path, { cwd: process.cwd(), backupDir: join(HOME, 'undo') }) } catch {}
}

function now() {
  return new Date().toISOString()
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
  const store = dbStore()
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
  const store = dbStore()
  if (!store) { console.log('receipt requires SQLite store'); return }
  const delivery = store.listDeliveries(1)[0]
  if (!delivery) { console.log('还没有交付记录；先运行 `advisers office` / `advisers template`。'); return }
  const ledger = loadLedger()
  const open = ledger.openCommitments(delivery.matterId)
  console.log(`回执 ${delivery.id}`)
  console.log(`时间：${delivery.createdAt}`)
  console.log(`事项：${delivery.title || '(untitled)'}`)
  console.log(`产物：${delivery.files.join(', ')}`)
  console.log(`工具：${delivery.tool || '-'}`)
  console.log(`校验：${delivery.validation || '未记录'}`)
  console.log(`未完成承诺：${open.length}`)
  for (const c of open.slice(0, 3)) console.log(`  ${c.id}  ${c.action}${c.dueAt ? ` · ${c.dueAt.slice(0, 10)}` : ''}`)
  const usage = store.sumModelUsage()
  if (usage.calls) console.log(`模型：${usage.calls} calls · ${usage.total_tokens} tokens`)
  const research = store.listResearch?.(1)?.[0]
  if (research) {
    console.log(`研究：${research.query}`)
    for (const source of research.sources.slice(0, 3)) console.log(`  web: ${source.title || '(untitled)'} ${source.url}`)
  }
  console.log('提示：结构校验通过不等于内容正确；对外发送仍需 permit。')
}

function printDeliveries() {
  const store = dbStore()
  const rows = store?.listDeliveries(12) ?? []
  if (!rows.length) {
    console.log('no deliveries yet')
    return
  }
  let matters = []
  try { matters = loadLedger().listMatters() } catch {}
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
function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/ENOENT/.test(message)) return 'file not found; check the path and run `advisers doctor`'
  if (/Unexpected token|JSON/.test(message)) return 'invalid JSON; use UTF-8 without BOM and see examples/'
  if (/model (HTTP|timeout)|fetch failed|ECONN/.test(message)) return 'model request failed; check ADVISERS_API_KEY / network and run `advisers doctor`'
  if (/database is locked/.test(message)) return 'database is busy; close other advisers processes and retry'
  return message
}
process.on('uncaughtException', (error) => { console.error(`advisers: ${friendlyError(error)}`); process.exit(1) })
process.on('unhandledRejection', (error) => { console.error(`advisers: ${friendlyError(error)}`); process.exit(1) })
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
const [command, ...args] = rawArgv

function help() {
  console.log(`advisers — a staff of AI advisers

Usage:
  advisers                    start the local conversation (TTY)
  advisers chat [--file <path>] [text]
                              one-shot task, or start the local conversation
  advisers init               initialize home + soul
  advisers doctor             check Node/SQLite/Office/policy/model
  advisers status             home/store/model/counts
  advisers history            recent conversations
  advisers search <text>       full-text search old turns
  advisers compact ls|rollback summary versions
  advisers today [--calendar] [--sources] [--json]
                              one-screen today/week/waiting view (+ local events)
  advisers remind [--json] [--ics [path]] [--deliver [--notify]]  due reminders + ICS/VALARM export
  advisers remind install|uninstall|status [--apply] [--schedule "0 9 * * *"]
                              scheduler scripts + OS plan (dry-run by default; --apply executes)
                              status also shows the last recorded run (scheduler/status.json)
  advisers calendar import --ics <file>  local .ics read-only import
  advisers risks              up to 3 deterministic obligation risks
  advisers pet-brief [--json] [--out [path]] [--check [--strict]] [--display-policy public|private|none]
                              read-only redacted Pet Brief (contract v0.2); --print-schema prints the JSON Schema
  advisers tick               due commitments in the next 7 days
  advisers week               last 7 days
  advisers digest day|week    short digest
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
  advisers audit              verify the local audit hash chain
  advisers purge <matter> [--yes]  privacy delete a matter
  advisers commit add|edit|ls|done|snooze commitments
  advisers commit add "..." --quote "..." [--remind-offsets "-1d,-2h"]
  advisers commit edit <id> [--remind-offsets "<list>" | --no-remind]
                              per-commitment reminder offsets (Asia/Shanghai wall clock)
  advisers deliveries         recent generated files
  advisers receipt            one-screen delivery receipt
  advisers ls                 list matters
  advisers privacy [--json] [--prove]  show/verify local data & egress facts
  advisers why <pref-id>      explain a preference
  advisers forget <pref-id>   forget a preference (tombstone)
  advisers export [--all] [--encrypted] [--out file]  export ledger (AES-256-GCM with passphrase)
  advisers import <file> [--replace]  import an export (encrypted or plain)
  advisers vault seal [--out f] [--remove] | unseal [f] | status  AES-256-GCM database vault
  advisers sync push|pull|status --dir <dir>  file-based E2EE snapshot sync (user-provided dir)
  advisers backup <path.db>   checkpoint and copy the SQLite database
  advisers brief [--deep] <text>  print the IntentBrief; --deep adds model refinement
  advisers --version          print the CLI version
  advisers who                 who I owe / who owes me
  advisers review <file> --request "..."  model content review (no edits)
  advisers research --web|--url <url> [--deep] <query>
                              server-side web search/read URL with citations (explicit egress)
  advisers capture [--file f] [--source s] [--date ISO] [--matter id] [--json] <text>
                              从中文工作内容抽取候选承诺（不自动入账）
  advisers capture --from-mail <file|dir> [--limit n]  .eml/.mbox 只读导入→候选
  advisers capture --from-transcript <file>      转写稿导入→候选（不录音/不入会）
  advisers capture --from-imap                   只读 IMAP 导入（EXAMINE/FETCH；env 凭据）
  advisers ui [--port n]                        本地只读视图（127.0.0.1，GET only）
  advisers mcp --stdio                          MCP server（7 工具 + 4 resources；写入口仅 pending 候选/回执校验）
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
  advisers tui [--once]          read-only terminal dashboard
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
  ADVISERS_PROGRESS=0 hide [tool] progress lines
  ADVISERS_ACCEPT_TOS=1  record TOS consent without a TTY (same as --accept-tos)
  ADVISERS_NOTIFY_WEBHOOK  optional outbound webhook for remind --deliver --notify

Exit codes:
  0  success
  1  user/config/runtime error (bad args, missing key, unknown id, failed verification)
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

function purgeMatter(id, confirmed) {
  if (!id) { console.error('usage: advisers purge <matter-id> [--yes]'); process.exitCode = 1; return }
  const ledger = loadLedger()
  const matter = ledger.getMatter(id)
  if (!matter) { console.error(`unknown matter: ${id}`); process.exitCode = 1; return }
  const facts = ledger.listFacts(id).length
  const links = ledger.listLinks(id).length
  const updates = ledger.listUpdates().filter((u) => u.sourceMatter === id || u.targetMatter === id).length
  const commitments = ledger.openCommitments(id).length
  console.log(`matter ${id}: ${matter.title}`)
  console.log(`facts=${facts} links=${links} updates=${updates} open_commitments=${commitments}`)
  if (!confirmed) {
    console.log('dry-run only; re-run with --yes to purge')
    return
  }
  const counts = ledger.purgeMatter(id)
  const sqlite = dbStore()?.purgeMatterData(id)
  saveLedgerWithAudit(ledger, { actor: 'local', action: 'matter.purge', allowed: true, reason: `${id} ${JSON.stringify(counts)}` })
  console.log(`purged: ${JSON.stringify(counts)} sqlite=${JSON.stringify(sqlite ?? {})}`)
}

function parseFlags(args) {
  const flags = {}
  const positional = []
  const booleanFlags = new Set(['web', 'deep', 'all', 'yes', 'json', 'list', 'force', 'apply', 'quiet', 'help', 'content', 'ics', 'deliver', 'install', 'uninstall', 'status', 'calendar', 'sources', 'pack', 'receipt', 'from-imap', 'remove', 'force', 'notify', 'no-remind'])
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      if (booleanFlags.has(key)) flags[key] = true
      else flags[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true
    } else positional.push(args[i])
  }
  return { flags, positional }
}

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

function recordManualDelivery(files, tool, title, validation) {
  try {
    const store = dbStore()
    if (!store) return
    const ledger = loadLedger()
    store.addDelivery({
      matterId: activeMatterId(ledger),
      conversationId: latestConversationId(),
      files,
      tool,
      title,
      validation: typeof validation === 'string' ? validation : JSON.stringify(validation),
    })
  } catch {}
}

function activeMatterId(ledger, explicit) {
  if (explicit) return explicit
  try {
    const latest = dbStore()?.listSessions(1)[0]
    if (latest) return latest.matterId
  } catch {}
  return ledger.listMatters()[0]?.id ?? ledger.addMatter({ title: '默认事项' }).id
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

function printWeek(ledger) {
  const now = Date.now()
  const weekAgo = now - 7 * 86400_000
  const commitments = ledger.listCommitments()
  const due = commitments.filter((c) => c.dueAt && (Date.parse(c.dueAt) >= weekAgo || Date.parse(c.dueAt) < now))
  const done = due.filter((c) => c.status === 'done')
  const open = commitments.filter((c) => c.status === 'open')
  const overdue = open.filter((c) => c.dueAt && Date.parse(c.dueAt) < now)
  let deliveries = []
  try { deliveries = dbStore()?.listDeliveries(100) ?? [] } catch {}
  const weekDeliveries = deliveries.filter((d) => Date.parse(d.createdAt) >= weekAgo)
  console.log(`本周（${new Date(weekAgo).toISOString().slice(0, 10)} – ${new Date(now).toISOString().slice(0, 10)}）`)
  console.log(`承诺：到期 ${due.length} 件，完成 ${done.length} 件，未完成 ${open.length} 件，逾期 ${overdue.length} 件。`)
  for (const c of due.slice(0, 5)) console.log(`  ${c.status === 'done' ? '✓' : '○'} ${c.action}${c.dueAt ? `（${c.dueAt.slice(0, 10)}）` : ''}`)
  console.log(`交付：${weekDeliveries.length} 个文件。`)
  const next = [...open].filter((c) => c.dueAt).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0]
  console.log('下周一件：' + (next?.action ?? open[0]?.action ?? '先定一个承诺或交付。'))
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

async function today(ledger, { calendar = false, sources = false, json = false } = {}) {
  const nowMs = Date.now()
  const localDay = localDayOf(nowMs)
  const weekAhead = nowMs + 7 * 86400_000
  // P0-1: classify in one pass, formatting each due date at most once (the old
  // four filters called day() up to four times per commitment).
  const overdue = []
  const todayDue = []
  const week = []
  const waiting = []
  const noDue = []
  for (const c of ledger.openCommitments()) {
    if (c.debtor === 'third' || c.debtor.startsWith('third:')) waiting.push(c)
    if (!c.dueAt) { noDue.push(c); continue }
    const due = Date.parse(c.dueAt)
    if (due < nowMs) {
      if (localDayOf(c.dueAt) !== localDay) overdue.push(c)
      else todayDue.push(c)
    } else if (localDayOf(c.dueAt) === localDay) {
      todayDue.push(c)
    } else if (due <= weekAhead) {
      week.push(c)
    }
  }
  const next = [...overdue, ...todayDue, ...week].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0]
  if (json) {
    // JSON contract v1 (docs/CLI-JSON.md): same classification as the human view.
    const payload = {
      now: new Date(nowMs).toISOString(),
      localDay,
      counts: { today: todayDue.length, overdue: overdue.length, week: week.length, waiting: waiting.length, noDue: noDue.length },
      overdue,
      today: todayDue,
      week,
      waiting,
      noDue,
      next: next ? { id: next.id, action: next.action, dueAt: next.dueAt } : null,
    }
    if (calendar) payload.calendar = (await calendarOccurrencesToday()).occurrences
    if (sources) {
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
  if (sources) await printSources(ledger)
}

function tick(ledger, asJson = false) {
  const now = Date.now()
  const store = dbStore()
  const localDay = localDayOf(now)
  const weekAhead = now + 7 * 86400_000
  const due = []
  const candidates = []
  const snoozeKeys = []
  let statusChanged = false
  // P0-2: one meta query for every snooze deadline instead of getMeta() per
  // snoozed commitment.
  const snoozeUntil = store ? store.listMetaByPrefix('snooze:') : new Map()
  for (const c of ledger.listCommitments()) {
    if (c.status === 'done' || c.status === 'dropped') continue
    if (c.status === 'snoozed') {
      const until = snoozeUntil.get(`snooze:${c.id}`)
      if (until && Date.parse(until) > now) continue
      c.status = 'open'
      statusChanged = true
      snoozeKeys.push(`snooze:${c.id}`)
    }
    if (!c.dueAt || Date.parse(c.dueAt) > weekAhead) continue
    candidates.push(c)
  }
  // P0-2: replace the per-commitment N+1 queries (listCommitmentNudges +
  // countNudges) with three batch reads: recent outcomes per commitment,
  // today's level counts and today's existing (commitment, level) keys.
  const recentByCommitment = store && candidates.length ? store.recentNudgeOutcomes(3) : new Map()
  const levelCounts = store && candidates.length ? store.countNudgesByDay(localDay) : new Map()
  const existingKeys = store && candidates.length ? store.listNudgeLevelKeysByDay(localDay) : new Set()
  const pendingKeys = new Set()
  let l3Today = levelCounts.get('L3') ?? 0
  let l2Today = levelCounts.get('L2') ?? 0
  const nudgeRows = []
  for (const c of candidates) {
    const dueDay = localDayOf(c.dueAt)
    const msLeft = Date.parse(c.dueAt) - now
    let level = (msLeft < 0 || dueDay === localDay) ? 'L2' : 'L1'
    if (level === 'L2' && Date.parse(c.dueAt) < now - 86400_000 && process.env.ADVISERS_ALLOW_L3 === '1') level = 'L3'
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
  // P0-2: one transaction for all nudge inserts and one for snooze cleanup;
  // the ledger snapshot is only rewritten when a snooze actually woke up.
  if (store && nudgeRows.length) store.addNudges(nudgeRows)
  if (store && snoozeKeys.length) store.deleteMetaKeys(snoozeKeys)
  if (statusChanged) saveLedger(ledger)
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

function printAudit(args = []) {
  ensureHome()
  const store = dbStore()
  if (!store) { console.log('audit requires SQLite store'); return }
  if (args.includes('--check-db')) {
    try {
      store.assertIntegrity()
      console.log('integrity: ok')
    } catch (error) {
      console.error(`integrity: FAIL (${error.message})`)
      process.exitCode = 1
      return
    }
  }
  const verify = store.verifyAudit()
  console.log(`audit: ${verify.ok ? 'verified' : `BROKEN at seq ${verify.seq}`} (${verify.count ?? 0} entries)`)
  if (!verify.ok) process.exitCode = 1
  for (const row of store.listAudit(20)) {
    console.log(`${row.seq}\t${row.at.slice(0, 19)}\t${row.action}\t${row.allowed ? 'allow' : 'deny'}\t${row.reason ?? ''}`)
  }
}

function printPrivacy(args = []) {
  ensureHome()
  const asJson = args.includes('--json')
  const prove = args.includes('--prove')
  const store = dbStore()
  let audit = null
  try { const v = store?.verifyAudit(); if (v) audit = { ok: v.ok, count: v.count ?? 0 } } catch {}
  // Privacy audit P2-2: list every actual egress surface from the code base
  // instead of two hardcoded names, and never expose internal numbering.
  const egressSurfaces = [
    'model provider — chat / brief --deep / review / learn review (only when ADVISERS_API_KEY is set; ADVISERS_BASE_URL)',
    'research --web|--url — provider web search/read tool (explicit opt-in; no silent research egress)',
    'capture --from-imap — read-only IMAP fetch from the server you configure (TLS by default)',
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
    console.log('egress gate coverage: chat/model, review, research, brief --deep, learn review, bridge and capture are wired to the local secrecy gate; the other surfaces listed above are self-attested.')
    if (failed) process.exitCode = 1
  }
}

function printLinks() {
  const ledger = loadLedger()
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
function petBriefJsonSchema() {
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
    console.log(JSON.stringify(petBriefJsonSchema(), null, 2))
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
    const { readLedgerSnapshotReadOnly } = await import('../lib/pet-brief-store.js')
    let snapshot
    try {
      snapshot = readLedgerSnapshotReadOnly({ store: mode, dbPath: DB, statePath: STATE })
    } catch (error) {
      return fail(error?.code ?? 'E_STORE', error?.message ?? String(error))
    }
    const ledger = Ledger.fromJSON(snapshot)
    const brief = buildPetBrief(ledger, displayPolicy ? { now: Date.now(), displayPolicy } : { now: Date.now() })
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
  const ledger = loadLedger()
  const rows = ledger.listPreferences({ includeCandidates: true })
  if (!rows.length) { console.log('no preferences yet'); return }
  for (const p of rows) {
    console.log(`${p.id}\t${p.status}\tconf=${p.confidence.toFixed(2)}\t${p.statement}`)
  }
}

async function doctor() {
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
    check('sqlite', true, 'skipped (vault sealed)')
    check('audit', true, 'skipped (vault sealed)')
    check('schema', true, 'skipped (vault sealed)')
  } else {
    try {
      const store = openStore()
      const integrity = store.assertIntegrity()
      check('sqlite', integrity === 'ok', `${DB} (${integrity})`)
      const audit = store.verifyAudit()
      check('audit', audit.ok, audit.ok ? `${audit.count} entries` : `BROKEN at seq ${audit.seq}`)
      check('schema', true, String(store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value ?? '?'))
    } catch (error) { check('sqlite', false, error.message) }
  }
  let officeOk = false
  try { await import('advisers-office'); officeOk = true } catch { try { await import('../../office/dist/index.js'); officeOk = true } catch {} }
  check('office', officeOk, officeOk ? 'advisers-office resolvable' : 'npm i -g advisers-office@next, or ADVISERS_OFFICE_LOCAL=1 in checkout')
  check('policy', Boolean(StrictPolicyPack), StrictPolicyPack ? 'strict pack loaded' : 'policy pack missing')
  check('model', true, process.env.ADVISERS_API_KEY ? 'API key present (not tested)' : 'optional; ADVISERS_API_KEY not set')
  for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}  ${row.detail}`)
  if (rows.some((r) => !r.ok)) process.exitCode = 1
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
  const ledger = loadLedger()
  const data = {
    version: VERSION,
    node: process.version,
    office: process.env.ADVISERS_OFFICE_LOCAL === '1' || existsSync(new URL('../../office/dist/index.js', import.meta.url)) ? 'local build linked' : 'external package',
    home: HOME,
    store: mode === 'sqlite' ? { type: 'sqlite', path: DB } : { type: mode, path: STATE },
    model: modelLabel(),
    matters: ledger.listMatters().length,
    prefs: ledger.listPreferences().length,
    routines: ledger.listRoutines().length,
    links: ledger.listLinks().length,
    soul: existsSync(SOUL) ? 'present' : 'not initialized',
  }
  try {
    const store = dbStore()
    data.sessions = store?.listSessions(100).length ?? 0
    data.deliveries = store?.countDeliveries() ?? 0
    const usage = store?.sumModelUsage?.()
    if (usage?.calls) data.modelUsage = usage
  } catch {}
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
  if (data.modelUsage) console.log(`model calls ${data.modelUsage.calls} · tokens ${data.modelUsage.total_tokens} · reasoning ${data.modelUsage.reasoning_tokens}`)
  console.log(`soul      ${data.soul}`)
}

function loadHistory(conversationId) {
  try {
    const store = dbStore()
    if (!store) return { turns: [], summary: '' }
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

function printOpening(conversationId) {
  try {
    const store = dbStore()
    if (!store) return
    const turns = store.listTurns(conversationId, 20)
    const summary = store.getSessionSummary(conversationId)
    const commitments = loadLedger().openCommitments()
    console.log(buildOpening({ summary: summary?.summary, turns, commitments }))
  } catch {}
}

function applyNudgeFeedback(text) {
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

async function runTurnInner({ runtime, ledger, text, conversationId, debug = false, confirm, attachments = [] }) {
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
  applyNudgeFeedback(text)
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
  let agentText = text
  const extracted = []
  const attachmentLib = attachments.length ? await loadAttachments() : null
  for (const file of attachments) {
    try {
      const attachment = await attachmentLib.extractAttachment(file, { cwd: process.cwd() })
      extracted.push(attachment)
      console.log(`[attach] ${attachment.name} (${attachment.text.length} chars${attachment.truncated ? ', truncated' : ''})`)
    } catch (error) {
      console.log(`[attach] ${file}: ${error.message}`)
    }
  }
  if (extracted.length) {
    agentText = `${text}\n\n[attachments]\n` + extracted.map((a) => `<file name="${a.name}">\n${a.text}\n</file>`).join('\n\n')
  }
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
  const history = loadHistory(conversationId)
  const pins = buildPins({
    preferences: ledger.listPreferences({ matterId: context.matter.id }),
    commitments: ledger.openCommitments(context.matter.id),
  })
  const prompt = pins ? `${context.prompt}\n<session-pins>\n${pins}\n</session-pins>` : context.prompt
  const fitted = fitHistory({ system: prompt, summary: history.summary, history: history.turns, current: agentText, maxTokens: Number(process.env.ADVISERS_CONTEXT_TOKENS || 12000) })
  if (fitted.trimmed) console.log(`[compact] 裁剪 ${fitted.trimmed} 轮旧历史`)
  const { reply, artifacts, toolLog } = await runAgent({
    runtime,
    text: agentText,
    context: { ...context, prompt },
    history: fitted.history,
    summary: history.summary,
    ledger,
    matterId: context.matter.id,
    turnId: `cli_${Date.now()}_${cliSeq}`,
    backupDir: join(HOME, 'undo'),
    store: dbStore(),
    apiKey,
    baseUrl: process.env.ADVISERS_BASE_URL || 'https://api.deepseek.com',
    model: process.env.ADVISERS_MODEL || 'deepseek-flash',
    cwd: process.cwd(),
    force: process.env.ADVISERS_FORCE === '1',
    confirm,
    effort: process.env.ADVISERS_THINKING_EFFORT,
    onTool: (name) => { if (debug || process.env.ADVISERS_PROGRESS !== '0') console.log(`[tool] ${name}`) },
  })
  lastRun = { artifacts: [...new Set(artifacts)], toolLog }
  recordTurn(conversationId, 'user', text)
  recordTurn(conversationId, 'assistant', reply || '')
  await maybeSummarize(conversationId, { apiKey, baseUrl: process.env.ADVISERS_BASE_URL, model: process.env.ADVISERS_MODEL, ledger })
  if (reply) console.log(reply)
  const uniqueArtifacts = [...new Set(artifacts)]
  if (uniqueArtifacts.length) {
    for (const file of uniqueArtifacts) {
      let bytes = 0
      try { bytes = statSync(file).size } catch {}
      console.log(`[完成] ${text.replace(/\s+/g, ' ').slice(0, 48)} -> ${file}（${bytes} B）`)
    }
    const structural = toolLog.filter((t) => t.name === 'office_build' || t.name === 'office_template')
    if (structural.length && structural.every((t) => t.ok && !(t.payload?.missing?.length))) console.log('校验：结构通过（内容未逐字核对）')
    else if (structural.length) console.log('校验：未通过，文件保留但未记成完成')
    else console.log('校验：文本已保存')
    console.log('下一步：打开确认；要改哪段直接说')
    for (const file of uniqueArtifacts) console.log(`[file] ${file}`)
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
      const review = await reviewRun({ run, routines: ledger.listRoutines(), apiKey, baseUrl: process.env.ADVISERS_BASE_URL, model: process.env.ADVISERS_MODEL })
      const checked = lintReview(review, { run, routines: ledger.listRoutines() })
      if (checked.ok && checked.review.verdict !== 'NONE') {
        const made = materializeReview(checked.review, { run, ledger })
        saveLedger(ledger)
        console.log(`[learn] ${made.verdict}${made.routine ? ` draft ${made.routine.id}` : made.patch ? ` patch ${made.patch.id}` : ''}`)
      }
    } catch {}
  }
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
  const words = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' || args[i] === '-f') {
      if (args[i + 1]) files.push(args[++i])
    } else {
      words.push(args[i])
    }
  }
  return { text: words.join(' ').trim(), files }
}

async function chat(args) {
  const { text, files } = parseChatArgs(args)
  if (!text) {
    if (process.stdin.isTTY) { await repl(); return }
    console.error('usage: advisers chat [--file <path>] <text>')
    process.exitCode = 1
    return
  }
  const ledger = loadLedger()
  const runtime = runtimeFor(ledger)
  await runTurn({ runtime, ledger, text, conversationId: latestConversationId(), attachments: files })
  if (lastTurnSafetyBlock) process.exitCode = 1
  saveLedger(ledger)
}

async function repl() {
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 100 })
  const ledger = loadLedger()
  const runtime = runtimeFor(ledger)
  let conversationId = latestConversationId()
  let debug = process.env.ADVISERS_DEBUG === '1'
  let pendingFiles = []
  let lastTask
  console.log('advisers · local')
  if (process.env.ADVISERS_DEBUG === '1') {
    console.log(`model: ${modelLabel()}`)
    console.log(`home:  ${HOME}`)
  }
  try {
    const latest = dbStore()?.listSessions(1)[0]
    printOpening(latest?.conversationId ?? conversationId)
  } catch {}
  console.log('/help for commands, /quit to leave')

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
      const question = await runTurn({ runtime, ledger, text: taskText, conversationId, debug, confirm, attachments: files })
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
          await runTurn({ runtime, ledger, text: `${taskText}\n补充：${answer.trim()}`, conversationId, debug, confirm, attachments: files })
          saveLedger(ledger)
        }
      }
    } catch (error) {
      console.error(`[没做成] ${error.message}`)
      console.error('已保留：任务和会话；没有丢文件。下一步：/retry 重试。')
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
    if (text === '/digest' || text === '/digest day' || text === '/digest week') {
      const store = dbStore()
      console.log(buildDigest({
        period: text.endsWith('week') ? 'week' : 'day',
        turns: store?.listTurns(conversationId, 200) ?? [],
        commitments: ledger.listCommitments(),
        deliveries: store?.listDeliveries(100) ?? [],
      }))
      continue
    }
    if (text === '/diff') {
      const result = await diffLatest({ cwd: process.cwd(), backupDir: join(HOME, 'undo') })
      console.log(result.ok ? result.diff : `diff failed: ${result.error}`)
      continue
    }
    if (text === '/undo') {
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
        const c = ledger.addCommitment({ matterId: activeMatterId(ledger), debtor: flags.debtor ?? 'user', creditor: flags.creditor ?? 'me', action, dueAt: flags.due, capability: 'todo', evidence: [{ sessionId: conversationId, turnId: 'cli', quote: String(flags.quote) }] })
        saveLedger(ledger)
        console.log(`${c.id} open ${c.action}`)
        continue
      }
      console.log('用法：/commit add ... 或 /commit ls'); continue
    }
    if (text.startsWith('/done ')) {
      const { flags, positional } = parseFlags(text.slice(6).trim().split(/\s+/))
      const id = positional[0]
      if (!id || !flags.evidence) { console.log('用法：/done <id> --evidence <证据>'); continue }
      ledger.completeCommitment(id, [{ sessionId: conversationId, turnId: 'cli', quote: String(flags.evidence) }])
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
      printOpening(conversationId)
      continue
    }
    if (text.startsWith('/brief ')) {
      const brief = runtime.brief(text.slice(7).trim())
      console.log(core.renderIntentBrief(brief))
      console.log(core.renderReadback(brief))
      continue
    }
    if (text.startsWith('/')) { console.log(`unknown command: ${text}; /help`); continue }
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

function ls() {
  const matters = loadLedger().listMatters()
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
    const ledger = loadLedger()
    const fact = ledger.listFacts(undefined, true).find((f) => f.id === id)
    if (!fact) { console.error(`unknown fact: ${id}`); process.exitCode = 1; return }
    console.log(`${fact.id} [${fact.authority}] ${fact.subject} ${fact.predicate} ${fact.object}`)
    console.log(`status: ${fact.status}; confidence: ${fact.confidence}`)
    for (const e of fact.evidence ?? []) console.log(`evidence: ${e.ref ?? '-'} 「${e.quote ?? ''}」`)
    return
  }
  const pref = loadLedger().findPreference(id)
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

function forget(id) {
  if (!id) {
    console.error('usage: advisers forget <pref-id>')
    process.exitCode = 1
    return
  }
  const ledger = loadLedger()
  const kind = id.startsWith('fact_') ? 'fact' : 'preference'
  const ok = ledger.forget(kind, id)
  saveLedger(ledger)
  console.log(ok ? `forgotten: ${id}` : `unknown ${kind}: ${id}`)
  if (!ok) process.exitCode = 1
}

async function exportLedger(all = false, options = {}) {
  const ledger = loadLedger().toJSON()
  const payload = all ? (() => {
    const store = dbStore()
    const tables = ['sessions', 'turns', 'session_summaries', 'summary_versions', 'deliveries', 'nudges', 'task_runs', 'audit', 'memory_candidates', 'permit_consumed']
    const data = {}
    for (const table of tables) data[table] = store ? store.db.prepare(`SELECT * FROM ${table}`).all() : []
    return { version: VERSION, exportedAt: now(), ledger, data }
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
    writeFileSync(options.out, text + '\n', { mode: 0o600 })
    dbStore()?.appendAudit({ actor: 'local', action: options.encrypted ? 'export.encrypted' : 'export', allowed: true, reason: basename(options.out) })
    console.log(`wrote ${options.out}${options.encrypted ? ' (AES-256-GCM)' : ''}`)
  } else console.log(text)
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
  await requireTosReaccept({ scope: 'import', subject: basename(file), action: 'import --replace' })
  ensureHome()
  try {
    const store = dbStore()
    if (store) copyFileSync(DB, join(HOME, `import-backup-${Date.now()}.db`))
  } catch {}
  try {
    const ledger = Ledger.fromJSON(data, LOCAL_PORTS)
    saveLedgerWithAudit(ledger, { actor: 'local', action: 'import.ledger', allowed: true, reason: basename(file) })
    console.log(`imported ${data.matters.length} matters, ${data.commitments?.length ?? 0} commitments`)
    if (payload?.data) console.error('note: SQLite-only tables in the import were not merged; ledger was replaced.')
  } catch (error) { console.error(`import failed: ${error.message}`); process.exitCode = 1 }
}

function backup(file) {
  if (!file) { console.error('usage: advisers backup <path.db>'); process.exitCode = 1; return }
  const sealed = vaultSealedPath()
  if (sealed) {
    console.error(`advisers: E_VAULT_SEALED — cannot back up a sealed database (${sealed}).`)
    console.error('Run `advisers vault unseal` first; the sealed file itself is already an encrypted backup.')
    process.exitCode = 1
    return
  }
  const store = openStore()
  const checkpoint = store.checkpoint()
  if (checkpoint.busy) { console.error('backup failed: database is busy (another advisers process is writing); close it and retry'); process.exitCode = 1; return }
  mkdirSync(dirname(file), { recursive: true })
  copyFileSync(DB, file)
  chmodSync(file, 0o600)
  console.log(`backup: ${file}`)
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
    const briefLedger = loadLedger()
    const briefDenied = egressDeniedReason(briefLedger.getMatter(activeMatterId(briefLedger)), 'brief --deep')
    if (briefDenied) { console.error(briefDenied); process.exitCode = 1; return }
    try {
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

async function template(name, dataFile, outFile) {
  const names = ['weekly', 'budget', 'presentation', 'flow', 'mindmap', 'minutes', 'notice']
  if (!names.includes(name) || !dataFile || !outFile) {
    console.error('usage: advisers template <weekly|budget|presentation|flow|mindmap|minutes|notice> <data.json> <out>')
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

async function capture(args) {
  const { flags, positional } = parseFlags(args)
  if (flags['from-mail']) return captureFromMail(flags)
  if (flags['from-transcript']) return captureFromTranscript(flags)
  if (flags['from-imap']) return captureFromImap(flags)
  let text = positional.join(' ').trim()
  if (flags.file) {
    try {
      const { extractAttachment } = await loadAttachments()
      const extracted = await extractAttachment(flags.file, { cwd: process.cwd() })
      if (!extracted.text) throw new Error('no extractable text')
      text = extracted.text
    } catch (error) { console.error(`capture --file failed: ${error.message}`); process.exitCode = 1; return }
  }
  if (!text) { console.error('usage: advisers capture [--file path] [--source wechat|meeting|email|contract] [--date ISO] [--matter id] <text>'); process.exitCode = 1; return }
  const apiKey = process.env.ADVISERS_API_KEY
  if (!apiKey) { console.error('capture requires ADVISERS_API_KEY'); process.exitCode = 1; return }
  ensureHome()
  const store = dbStore()
  if (!store) { console.error('capture requires SQLite store'); process.exitCode = 1; return }
  const ledger = loadLedger()
  const matterId = activeMatterId(ledger, flags.matter)
  const denied = egressDeniedReason(ledger.getMatter(matterId), 'capture')
  if (denied) { console.error(denied); process.exitCode = 1; return }
  saveLedger(ledger)
  const result = await proposeCaptureText({ text, source: flags.source, date: flags.date, matterId, store, json: flags.json === true })
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, command: 'capture', source: typeof flags.source === 'string' ? flags.source : 'wechat', count: result.count, candidates: result.candidates }, null, 2))
    return
  }
  if (!result.count) console.log('没有找到可确认的承诺候选。')
  else console.log('确认：advisers memory accept <id>；拒绝：advisers memory reject <id>')
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
  const matterId = activeMatterId(ledger, flags.matter)
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
  const matterId = activeMatterId(ledger, flags.matter)
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
  const matterId = activeMatterId(ledger, flags.matter)
  const denied = egressDeniedReason(ledger.getMatter(matterId), 'imap')
  if (denied) { console.error(denied); process.exitCode = 1; return }
  saveLedger(ledger)
  const { parseEml, dedupeKey, toCaptureInput } = await loadImporters()
  let messages
  try {
    messages = await fetchImapMessages({
      host,
      port: Number(process.env.ADVISERS_IMAP_PORT) || (String(process.env.ADVISERS_IMAP_SECURE) === '0' ? 143 : 993),
      secure: String(process.env.ADVISERS_IMAP_SECURE) !== '0',
      user, pass,
      mailbox: process.env.ADVISERS_IMAP_MAILBOX || 'INBOX',
      sinceDays: Math.max(1, Number(flags['since-days']) || 30),
      limit: Math.max(1, Math.min(100, Number(flags.limit) || 20)),
    })
  } catch (error) { console.error(`imap failed: ${error.message}`); process.exitCode = 1; return }
  let seen = 0, skipped = 0, failed = 0
  const created = []
  for (const msg of messages) {
    seen++
    let parsed
    try { parsed = parseEml(msg.raw.toString('utf8')) } catch (error) { failed++; console.error(`imap message ${msg.uid}: ${error.message}`); continue }
    const key = dedupeKey('email', parsed)
    if (store.hasSeen('import', 'imap', key, 30)) { skipped++; continue }
    const input = toCaptureInput(parsed, { source: 'email' })
    if (!input.text.trim()) { skipped++; continue }
    try {
      const result = await proposeCaptureText({ text: input.text, source: 'email', date: parseEmailDate(parsed.date), matterId, store, json: flags.json === true, meta: { type: 'mail', channel: 'imap', uid: msg.uid, messageId: parsed.messageId, subject: parsed.subject, from: parsed.from } })
      created.push(...result.candidates)
      store.markSeen('import', 'imap', key)
    } catch (error) { failed++; console.error(`imap message ${msg.uid}: ${error.message}`) }
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
  if (!store) return { localDay, occurrences: [] }
  const { expandRrule } = await loadIcal()
  const occurrences = []
  for (const row of store.listCalendarEvents()) {
    let instances
    try { instances = expandRrule(row, { from: localDay, to: localDay }) } catch { instances = [] }
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
  return { localDay, occurrences }
}

async function printCalendarToday() {
  const { localDay, occurrences } = await calendarOccurrencesToday()
  if (!occurrences.length) { console.log('日历：今天没有本地导入的会议。'); return }
  console.log(`日历（本地只读，${localDay}）：`)
  for (const e of occurrences) {
    const time = e.allDay ? '全天' : e.startsAt.slice(11, 16)
    console.log(`  ${time}  ${e.summary}${e.recurring ? '（循环）' : ''}${e.location ? ` · ${e.location}` : ''}`)
  }
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
  const ledger = loadLedger()
  const store = dbStore()
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

async function remind(args) {
  const { flags, positional } = parseFlags(args)
  ensureHome()
  const store = dbStore()
  const ledger = loadLedger()
  const scheduler = await loadScheduler()
  const sub = positional[0]
  const apply = flags.apply === true
  if (sub === 'install' || flags.install) {
    const dir = join(HOME, 'scheduler')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const nodeBin = process.execPath
    const cli = process.argv[1]
    writeFileSync(join(dir, 'remind.sh'), '#!/bin/sh\n"' + nodeBin + '" "' + cli + '" remind --deliver --notify >> "' + join(HOME, 'reminders.log') + '" 2>&1\n', { mode: 0o700 })
    writeFileSync(join(dir, 'remind.ps1'), '& "' + nodeBin + '" "' + cli + '" remind --deliver --notify *>> "' + join(HOME, 'reminders.log') + '"\n', { mode: 0o700 })
    writeFileSync(join(dir, 'README.txt'), 'Install one of these user-level schedules (opt-in):\nLinux:  systemd --user timer or cron: 0 9 * * * sh ' + join(dir, 'remind.sh') + '\nWindows: Task Scheduler -> run remind.ps1 daily\nOr import ~/.advisers/reminders.ics into your calendar.\n')
    store?.appendAudit({ actor: 'local', action: 'notify.install', allowed: true, reason: dir })
    console.log('scheduler scripts written: ' + dir)
    console.log('opt-in: import ~/.advisers/reminders.ics, or register remind.sh/.ps1 with your OS scheduler.')
    const command = scheduler.buildCronCommand({ nodeBin, cliPath: cli })
    const schedule = typeof flags.schedule === 'string' ? flags.schedule : scheduler.DEFAULT_CRON_SCHEDULE
    const time = typeof flags.time === 'string' ? flags.time : scheduler.DEFAULT_TASK_TIME
    const existing = apply ? await readCrontabText() : { ok: false }
    const plan = scheduler.planScheduler({
      platform: process.platform,
      action: 'install',
      dryRun: !apply,
      command,
      schedule,
      time,
      ...(existing.ok ? { existingText: existing.text } : {}),
    })
    console.log('schedule: ' + (plan.platform === 'win32' ? plan.taskName + ' daily ' + plan.time : plan.schedule))
    console.log('command: ' + command)
    await applySchedulerPlan(plan, { apply })
    return
  }
  if (sub === 'uninstall' || flags.uninstall) {
    const dir = join(HOME, 'scheduler')
    const existing = await readCrontabText()
    const plan = scheduler.planScheduler({
      platform: process.platform,
      action: 'uninstall',
      dryRun: !apply,
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
    const status = scheduler.readSchedulerStatus({ homeDir: HOME })
    if (!status.lastRun) console.log('last run: none recorded' + (status.corrupt ? ' (status.json corrupt)' : ''))
    else console.log('last run: ' + status.lastRun + ' · result=' + (status.lastResult ?? '-') + ' · count=' + (status.lastCount ?? '-') + ' · channel=' + (status.lastChannel ?? '-'))
    if (process.platform === 'win32') {
      const plan = scheduler.planWindowsStatus({})
      console.log('os plan: ' + plan.commands.map((entry) => entry.command + ' ' + entry.args.join(' ')).join('; ') + '（运行该命令；exit 0 表示已注册）')
    } else if (scheduler.CRON_PLATFORMS.includes(process.platform)) {
      const existing = await readCrontabText()
      if (existing.ok) {
        const plan = scheduler.planCronStatus({ existingText: existing.text })
        console.log(plan.installed ? 'os plan: installed (' + plan.schedule + ')' : 'os plan: not installed')
      } else {
        console.log('os plan: unknown (' + (existing.error ?? 'crontab unavailable') + ')')
      }
    } else {
      console.log('os plan: unsupported platform ' + process.platform)
    }
    return
  }
  const { buildReminders, toIcs } = await loadRemind()
  const snoozed = {}
  for (const c of ledger.listCommitments()) {
    const until = store?.getMeta('snooze:' + c.id)
    if (until) snoozed[c.id] = until
  }
  const reminders = buildReminders(ledger, { now: new Date(), snoozedUntil: snoozed })
  if (flags.ics) {
    const path = typeof flags.ics === 'string' ? flags.ics : (positional[0] || join(HOME, 'reminders.ics'))
    writeFileSync(path, toIcs(reminders, { now: new Date() }), { mode: 0o600 })
    store?.appendAudit({ actor: 'local', action: 'notify.ics', allowed: true, reason: basename(path) })
    console.log('ics written: ' + path + ' (' + reminders.length + ' events)')
    return
  }
  if (flags.json) { console.log(JSON.stringify({ now: new Date().toISOString(), reminders }, null, 2)); return }
  if (!reminders.length) {
    console.log('现在没有到期的提醒。')
    if (flags.deliver) recordReminderRun(scheduler, { count: 0, channel: 'log' })
    return
  }
  for (const r of reminders) console.log('[' + r.level + '/' + r.bucket + '] ' + r.action + (r.dueAt ? ' · ' + r.dueAt.slice(0, 16) : ''))
  if (flags.deliver) {
    const line = new Date().toISOString() + '\t' + reminders.length + '\t' + reminders.map((r) => r.action).join('；') + '\n'
    writeFileSync(join(HOME, 'reminders.log'), line, { flag: 'a', mode: 0o600 })
    let channel = 'log'
    if (flags.notify) {
      const notify = await loadNotify()
      const local = await notify.sendNotification({ title: 'Advisers · 到期提醒', body: reminders.length + ' 条承诺到期或即将到期' })
      channel = local.sent ? local.channel : 'log-only'
      const webhook = await notify.sendWebhookNotification(reminders)
      if (webhook.sent) channel = channel === 'log-only' ? 'webhook' : channel + '+webhook'
      else if (webhook.configured) console.error('webhook 未发送：' + (webhook.error ?? 'unknown') + (webhook.detail ? '（' + webhook.detail + '）' : ''))
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
    scheduler.recordSchedulerRun({ homeDir: HOME, at: new Date(), result: 'ok', count, channel, dryRun: false })
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
    const mod = process.env.ADVISERS_OFFICE_LOCAL === '1' ? await import('../../office/dist/index.js') : await import('advisers-office')
    let buffer
    if (format === 'pdf') {
      const { buildSimplePdf } = await loadPdf()
      const lines = commitments.map((c) => `${c.id}  ${c.creditor} · ${c.action}${c.dueAt ? ` · 截止 ${c.dueAt}` : ''} · ${c.status}`)
      buffer = await buildSimplePdf({ title: `${label} · Advisers`, paragraphs: [`承诺数：${commitments.length}`, ...lines, 'SHA256SUMS/回执说明：本 PDF 为本地账本生成，不是第三方存证。'] })
      if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('pdf builder returned a non-PDF buffer')
      await backupCliFile(out)
      writeFileSync(out, buffer)
    } else if (format === 'xlsx') {
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
 * The protocol surface lives in lib/mcp-server.js (7 tools incl. the pending-only
 * candidate write + read-only pack verification, 4 read-only resources, 1 MiB
 * line cap, -32601/-32602/-32002/-32700). This wiring only supplies process
 * state: the home, the store/ledger, the version and the audit sink. Every
 * tools/call is audited through store.appendAudit; a write whose audit row
 * cannot be appended fails closed (a created candidate is rolled back).
 */
async function mcpServer() {
  ensureHome()
  const store = dbStore()
  const ledger = loadLedger()
  const { createMcpServer } = await loadMcpServer()
  const server = createMcpServer({
    store,
    ledger,
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
 * Plaintext database copies left behind by unseal/migrate/import/sync and by an
 * interrupted unseal (robustness audit P1-2). `vault seal --remove` must delete
 * these too, otherwise the CLI says "plaintext removed" while a readable SQLite
 * copy (including the before-unseal backup) is still in HOME.
 */
const PLAINTEXT_DB_COPY_RE = /^(?:state\.db\.before-(?:unseal|migrate|sync)-|\.state\.db\.unseal-|import-backup-)/
function plaintextDbCopies() {
  try {
    return readdirSync(HOME).filter((name) => PLAINTEXT_DB_COPY_RE.test(name)).map((name) => join(HOME, name))
  } catch {
    return []
  }
}

/**
 * Remove the live plaintext database and every plaintext copy. Failures are
 * collected (never swallowed) so the caller can report them and exit non-zero.
 */
function removePlaintextDatabase() {
  const removed = []
  const failures = []
  for (const file of [DB, `${DB}-wal`, `${DB}-shm`, ...plaintextDbCopies()]) {
    try {
      if (!existsSync(file)) continue
      rmSync(file)
      removed.push(file)
    } catch (error) {
      failures.push(`${file}: ${error.message}`)
    }
  }
  fsyncDir(HOME)
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
    atomicWriteFileSync(out, JSON.stringify(envelope) + '\n', { mode: 0o600 })
    const check = decryptJson(JSON.parse(readFileSync(out, 'utf8')), pass)
    if (check.sha256 !== sha) throw new Error('sealed file verification failed')
    if (removePlaintext) {
      if (!reportPlaintextCleanup(removePlaintextDatabase(), out)) return
      return
    }
    console.log(`sealed ${DB} -> ${out} (plaintext kept; pass --remove)`)
  } catch (error) { console.error(`vault seal failed: ${error.message}`); process.exitCode = 1 }
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
  // P1-3: never write the payload straight over the live database. Write a
  // same-directory temp file, fsync it, verify the SQLite image, keep the old
  // database (and its WAL) as a backup, then rename atomically.
  const tmp = join(HOME, `.state.db.unseal-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    writeDurableTemp(tmp, bytes)
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
      copyFileSync(DB, backup)
      for (const suffix of ['-wal', '-shm']) {
        try { if (existsSync(DB + suffix)) copyFileSync(DB + suffix, backup + suffix) } catch {}
      }
    }
    // A WAL from the old database must never be replayed onto the new file.
    for (const suffix of ['-wal', '-shm']) { try { if (existsSync(DB + suffix)) rmSync(DB + suffix) } catch {} }
    renameSync(tmp, DB)
    try { chmodSync(DB, 0o600) } catch {}
    fsyncDir(HOME)
    console.log(`unsealed ${file} -> ${DB} (${bytes.length} bytes, integrity ok${backup ? `; previous database kept at ${backup}` : ''})`)
  } catch (error) {
    try { if (existsSync(tmp)) rmSync(tmp) } catch {}
    console.error(`vault unseal failed: ${error.message}`)
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
  if (copies.length) console.log(`plaintext copies: ${copies.length} (run \`advisers vault seal --remove\` to purge them)`)
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

async function tui(args) {
  const once = args.includes('--once')
  const { buildReminders } = await loadRemind()
  const render = () => {
    const ledger = loadLedger()
    const store = dbStore()
    const open = ledger.openCommitments()
    const localDay = localDayOf(Date.now())
    const due = open.filter((c) => c.dueAt && c.dueAt.slice(0, 10) <= localDay)
    const reminders = buildReminders(ledger, { now: new Date() })
    const deliveries = store?.listDeliveries(3) ?? []
    const lines = [
      'Advisers TUI (read-only)',
      `today ${localDay} · open ${open.length} · due ${due.length} · reminders ${reminders.length}`,
      '',
      'reminders:',
      ...(reminders.length ? reminders.slice(0, 8).map((r) => `  [${r.level}/${r.bucket}] ${r.action}${r.dueAt ? ` · ${r.dueAt.slice(0, 16)}` : ''}`) : ['  (none)']),
      '',
      'open commitments:',
      ...(open.length ? open.slice(0, 8).map((c) => `  ${c.id}  ${c.creditor} · ${c.action}${c.dueAt ? ` · ${c.dueAt.slice(0, 10)}` : ''}`) : ['  (none)']),
      '',
      'recent deliveries:',
      ...(deliveries.length ? deliveries.map((d) => `  ${d.createdAt.slice(0, 16)}  ${d.title ?? d.tool ?? d.id}`) : ['  (none)']),
    ]
    return lines.join(String.fromCharCode(10))
  }
  if (once) { console.log(render()); return }
  const readline = await import('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const draw = () => { process.stdout.write('\x1b[2J\x1b[H' + render() + '\n\n[r] refresh  [q] quit\n') }
  draw()
  await new Promise((resolve) => {
    const onKey = (str, key) => {
      if (key?.name === 'q' || str === 'q') { rl.close(); resolve() }
      else if (key?.name === 'r' || str === 'r') draw()
    }
    process.stdin.on('keypress', onKey)
    rl.on('close', resolve)
  })
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

async function syncCommand(args) {
  const { flags, positional } = parseFlags(args)
  const sub = positional[0]
  const dir = typeof flags.dir === 'string' ? flags.dir : undefined
  if (!dir) { console.error('usage: advisers sync push|pull|status --dir <sync-dir>'); process.exitCode = 1; return }
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
    try {
      // Capture the local write time before checkpointing (checkpoint touches mtime).
      const localMtimeMs = latestLocalDbMtime()
      if (existsSync(DB)) {
        const checkpoint = checkpointLocalDatabase()
        if (checkpoint.busy && !force) throw new Error('local database is busy (another advisers process is writing); close it and retry sync pull, or re-run with --force (a backup is kept)')
        if (!checkpoint.busy && checkpoint.error) console.error(`note: local database could not be checkpointed (${checkpoint.error.message}); the snapshot replaces it and a backup is kept.`)
      }
      const { pullSnapshot } = await loadSync()
      const result = pullSnapshot({
        dir,
        dbPath: DB,
        passphrase: pass,
        file: typeof flags.file === 'string' ? flags.file : undefined,
        force,
        localMtimeMs,
        localDevice: await readSyncDevice(),
      })
      if (!result.changed) console.log('local database already matches the latest snapshot')
      else console.log(`pulled ${result.file} (${result.sha256})${result.backup ? `; backup ${result.backup}` : ''}`)
      if (result.changed) {
        try { dbStore()?.appendAudit({ actor: 'local', action: 'sync.pull', allowed: true, reason: result.file }) }
        catch (error) { console.error(`warning: database replaced but the sync.pull audit row failed: ${error.message}`); process.exitCode = 1 }
      }
    } catch (error) { console.error(`sync pull failed: ${error.message}`); process.exitCode = 1 }
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

async function printEvidence(args) {
  const { flags, positional } = parseFlags(args)
  // Offline receipt-pack verification: reads only the given directory. It runs
  // before ensureHome() so a clean machine needs no ~/.advisers state.
  if (positional[0] === 'verify') {
    const dir = positional[1] ?? (typeof flags.dir === 'string' ? flags.dir : undefined)
    if (!dir) { console.error('usage: advisers evidence verify <dir>'); process.exitCode = 1; return }
    const { verifyReceiptPackDir } = await loadReceiptVerify()
    const result = verifyReceiptPackDir(dir)
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.ok ? 0 : 1
    return
  }
  ensureHome()
  const store = dbStore()
  const ledger = loadLedger()
  const id = positional[1] || positional[0]
  if (!id) { console.error('usage: advisers evidence show <id> [--json]'); process.exitCode = 1; return }
  let result
  try {
    const { evidenceForCommitment, evidenceForFact, evidenceForPreference } = await loadEvidence()
    if (id.startsWith('cm_')) result = evidenceForCommitment(store, ledger, id)
    else if (id.startsWith('fact_')) result = evidenceForFact(store, ledger, id)
    else if (id.startsWith('pref_')) result = evidenceForPreference(store, ledger, id)
    else { console.error('unknown evidence id prefix (want cm_/fact_/pref_)'); process.exitCode = 1; return }
  } catch (error) { console.error(error.message); process.exitCode = 1; return }
  if (!result || (!result.commitment && !result.fact && !result.preference)) { console.error(`not found: ${id}`); process.exitCode = 1; return }
  await normalizeEvidenceSources(result)
  if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  const label = result.commitment ? `${result.commitment.action}` : result.fact ? `${result.fact.subject} ${result.fact.predicate}` : result.preference?.statement
  console.log(`${id}  ${label ?? ''}`)
  if (!result.sources.length) console.log('  （没有可回溯来源）')
  for (const s of result.sources) console.log(`  ${s.sessionId}#${s.turnId}  「${(s.quote ?? '').slice(0, 120)}」`)
  for (const m of result.missing) console.log(`  MISSING ${m.reason}${m.ref ? ` ${m.ref}` : ''}`)
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
  let pack
  try {
    // Performance audit P1-1: --all was parsed but never forwarded, so the
    // documented escape hatch was a no-op and large ledgers always failed.
    pack = buildEvidencePack({ store, ledger, ids: targetIds, all: flags.all === true })
  } catch (error) {
    if (error instanceof EvidencePackLimitError || error?.code === 'EVIDENCE_PACK_TOO_LARGE') {
      console.error('error: ' + error.message)
      if (error.hint) console.error('hint: ' + error.hint)
      process.exitCode = 1
      return
    }
    throw error
  }
  const out = flags.out ? String(flags.out) : join(HOME, 'evidence', `evidence-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(out, { recursive: true, mode: 0o700 })
  for (const [name, content] of Object.entries(pack.files)) writeFileSync(join(out, name), content, { mode: 0o600 })
  let receipt
  try {
    const mod = process.env.ADVISERS_OFFICE_LOCAL === '1' ? await import('../../office/dist/index.js') : await import('advisers-office')
    const rows = toDocxRows(pack, { maxRows: 80 })
    const buffer = await mod.buildDocx({ title: '证据包回执', sections: [{ heading: '证据清单', paragraphs: rows.length ? rows : ['（没有可导出条目）'] }, { heading: '校验', paragraphs: [`manifest.json / README.txt 的 SHA256 见 SHA256SUMS`, `生成时间：${new Date().toISOString()}`, 'SHA256SUMS 只证明包生成后未被修改；不是签名或第三方存证。'] }] })
    await mod.validateOffice(buffer, 'docx')
    writeFileSync(join(out, 'receipt.docx'), buffer)
    receipt = join(out, 'receipt.docx')
  } catch (error) { console.error(`docx receipt skipped: ${error.message}`) }
  const verification = verifyPack(pack.files)
  // Delivery row + audit row commit together (robustness audit P0-3).
  recordDeliveryWithAudit({
    files: [join(out, 'manifest.json'), join(out, 'README.txt'), join(out, 'SHA256SUMS'), ...(receipt ? [receipt] : [])],
    tool: 'evidence-pack',
    title: 'evidence pack',
    validation: verification,
    audit: { actor: 'local', action: 'evidence.pack', allowed: true, reason: `${pack.summary?.entryCount ?? 0} entries` },
  })
  console.log(JSON.stringify({ out, files: Object.keys(pack.files), receipt, verification }, null, 2))
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
async function receiptPack(args) {
  const { flags } = parseFlags(args)
  ensureHome()
  const store = dbStore()
  if (!store) { console.error('deliveries --receipt requires SQLite store'); process.exitCode = 1; return }
  const ledger = loadLedger()
  const denied = egressDeniedReason(ledger.getMatter(activeMatterId(ledger)), 'evidence')
  if (denied) { console.error(denied); process.exitCode = 1; return }
  const ids = typeof flags.ids === 'string' ? flags.ids.split(',').map((item) => item.trim()).filter(Boolean) : undefined
  if (ids && !ids.length) { console.error('--ids is empty'); process.exitCode = 1; return }
  const deliveryLimit = Math.max(1, Math.min(2000, Number(flags.limit) || 100))
  // A receipt pack records itself as a delivery for discoverability, but a new
  // receipt must not recursively copy older receipt packs (unbounded growth).
  const rows = store.listDeliveries(deliveryLimit).filter((row) => row.tool !== 'receipt-pack')
  if (!rows.length) {
    console.error('没有交付记录可生成回执包；先运行 `advisers deliver` / `advisers office` / `advisers template`。')
    process.exitCode = 1
    return
  }
  const skippedFiles = []
  const deliveries = []
  for (const row of rows) {
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
      files,
    })
  }
  if (!deliveries.length) {
    console.error('没有仍存在的交付文件，无法生成回执包（文件可能已被移动或删除）。')
    if (skippedFiles.length) console.error('缺失：' + skippedFiles.slice(0, 5).join('; '))
    process.exitCode = 1
    return
  }
  if (skippedFiles.length) console.error('注意：' + skippedFiles.length + ' 个交付文件缺失，已跳过（回执只覆盖仍存在的文件）。')

  const verifyResults = await verifyDeliveryArtifacts(deliveries.flatMap((delivery) => delivery.files))
  const { buildEvidencePack, buildReceiptPack, EvidencePackLimitError } = await loadEvidence()
  let evidence
  try {
    const targetIds = ids ?? {
      commitments: ledger.listCommitments().map((row) => row.id),
      facts: ledger.listFacts().map((row) => row.id),
      preferences: ledger.listPreferences({ includeCandidates: false }).map((row) => row.id),
    }
    evidence = buildEvidencePack({ store, ledger, ids: targetIds, all: flags.all === true })
  } catch (error) {
    if (error instanceof EvidencePackLimitError || error?.code === 'EVIDENCE_PACK_TOO_LARGE') {
      console.error('error: ' + error.message)
      if (error.hint) console.error('hint: ' + error.hint)
      process.exitCode = 1
      return
    }
    throw error
  }
  const out = typeof flags.out === 'string'
    ? flags.out
    : join(HOME, 'receipts', 'receipt-' + new Date().toISOString().replace(/[:.]/g, '-'))
  // Generate receipt.docx with the office DOCX submodule when available (fast,
  // nicer table) or the built-in deterministic writer otherwise.
  const docxModule = await importOfficeSubmodule('docx')
  const docxBuilder = typeof docxModule?.buildDocx === 'function'
    ? async (spec) => docxModule.buildDocx(spec)
    : false
  let pack
  try {
    pack = await buildReceiptPack({
      deliveries,
      evidence,
      verifyResults,
      docxBuilder,
      env: {
        advisersVersion: VERSION,
        nodeVersion: process.version,
        platform: process.platform,
        command: 'advisers deliveries --receipt',
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
  try {
    recordDeliveryWithAudit({
      files: [join(summary.outDir, 'manifest.json'), join(summary.outDir, 'README.txt'), join(summary.outDir, 'SHA256SUMS'), join(summary.outDir, 'receipt.docx')],
      tool: 'receipt-pack',
      title: 'delivery receipt pack',
      validation: 'receipt-pack-v1.1: ' + summary.verifyStatus,
      audit: { actor: 'local', action: 'receipt.pack', allowed: true, reason: deliveries.length + ' deliveries/' + summary.fileCount + ' files' },
    })
  } catch {}
  const { verifyReceiptPackDir } = await loadReceiptVerify()
  const verification = verifyReceiptPackDir(summary.outDir)
  console.log(JSON.stringify({
    ok: verification.ok,
    format: summary.format,
    version: summary.version,
    out: summary.outDir,
    replaced: summary.replaced ?? null,
    deliveryCount: summary.deliveryCount,
    fileCount: summary.fileCount,
    verifyStatus: summary.verifyStatus,
    anchored: summary.anchored,
    recipient: summary.recipient,
    manifestDigest: summary.manifestDigest,
    receiptSha256: summary.receiptSha256,
    evidence: summary.evidence,
    files: summary.files,
    skippedFiles,
    verification: {
      ok: verification.ok,
      errors: verification.errors,
      warnings: verification.warnings,
      checksumCount: verification.checksumCount,
    },
  }, null, 2))
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
  'privacy', 'export', 'audit', 'purge',
])
/** Known commands. Unknown commands keep the plain "unknown command" error, not the gate. */
const KNOWN_COMMANDS = new Set([
  'version', '--version', '-v', 'help', '--help', 'chat', 'status', 'doctor', 'init', 'history', 'mcp',
  'deliver', 'timestamp', 'tui', 'ocr', 'evidence', 'receipt', 'deliveries', 'learn', 'commit', 'diff',
  'undo', 'compact', 'search', 'nudge', 'risks', 'pet-brief', 'today', 'tick', 'ui', 'remind', 'calendar',
  'who', 'memory', 'digest', 'week', 'prefs', 'privacy', 'audit', 'purge', 'decay', 'correct', 'ls', 'why',
  'forget', 'sync', 'vault', 'export', 'import', 'backup', 'brief', 'review', 'research', 'capture', 'policy',
  'office-edit', 'office-read', 'verify', 'office', 'routine', 'template', 'link', 'bridge', 'soul', 'tos',
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

/** L1 gate: run before dispatch; exits the process on block/reject (exit 3 / exit 1). */
async function tosGate() {
  const isTTY = Boolean(process.stdin.isTTY)
  if (!command) { if (!isTTY) return }
  // Offline receipt verification must work on a clean machine without a
  // ~/.advisers consent record (docs/DELIVERY-RECEIPT.md); it reads only <dir>.
  else if (command === 'evidence' && args[0] === 'verify') return
  else if (TOS_EXEMPT_COMMANDS.has(command) || !KNOWN_COMMANDS.has(command)) return
  const tos = await loadTos()
  const info = tos.currentTos()
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
  const info = tos.currentTos()
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

function tosStatusFacts(tos, info, status) {
  const record = status.record
  return {
    version: info.version,
    manifestVersion: info.manifestVersion,
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

function printTosStatus(tos, info, status, asJson) {
  const facts = tosStatusFacts(tos, info, status)
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
  const info = tos.currentTos()
  if (!sub || sub === 'help' || sub === '--help') { tosUsage(info.version); return }
  const status = tos.acceptanceStatus({ home: HOME, version: info.version, sha256: info.sha256 })
  if (sub === 'show') {
    console.log(`Advisers 使用条款 v${info.version}（生效 ${info.effectiveFrom}）`)
    console.log(`文本 SHA-256：${info.sha256}`)
    console.log(`规范文本：${info.canonical}；随包副本：${info.termsPath}；在线：${info.url}`)
    console.log('---')
    process.stdout.write(readFileSync(info.termsPath, 'utf8'))
    return
  }
  if (sub === 'status') { printTosStatus(tos, info, status, argv.includes('--json')); return }
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
      console.log(`已接受使用条款 v${info.version}（channel=${explicit.channel}，nonInteractive=1）；已写入本地审计链。`)
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

// L1 consent gate: runs once before dispatch (exempt commands return immediately).
await tosGate()

if (!command) {
  if (process.stdin.isTTY) await repl()
  else help()
} else if (command === 'version' || command === '--version' || command === '-v') {
  console.log(VERSION)
} else if (command === 'help' || command === '--help') {
  help()
} else if (command === 'chat') {
  await chat(args)
} else if (command === 'status') {
  printStatus(args.includes('--json'))
} else if (command === 'doctor') {
  await doctor()
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
  else if (args.includes('--json')) console.log(JSON.stringify(dbStore()?.listDeliveries(100) ?? [], null, 2))
  else printDeliveries()
} else if (command === 'learn') {
  const sub = args[0]
  const store = dbStore()
  let learnDenied = null
  if (sub === 'review') {
    const learnLedger = loadLedger()
    learnDenied = egressDeniedReason(learnLedger.getMatter(activeMatterId(learnLedger)), 'learn review')
  }
  if (sub === 'review' && learnDenied) { console.error(learnDenied); process.exitCode = 1 }
  else if (sub === 'ls') {
    for (const r of store?.listTaskRuns(20) ?? []) console.log(`${r.id}\t${r.outcome}\t${r.tools.map((t) => t.name).join(',')}\t${r.task.slice(0, 60)}`)
  } else if (sub === 'review') {
    const run = store?.listTaskRuns(100).find((r) => r.id === args[1])
    const apiKey = process.env.ADVISERS_API_KEY
    if (!run || !apiKey) { console.error('usage: ADVISERS_API_KEY=... advisers learn review <run-id>'); process.exitCode = 1 }
    else {
      const ledger = loadLedger()
      const review = await reviewRun({ run, routines: ledger.listRoutines(), apiKey, baseUrl: process.env.ADVISERS_BASE_URL, model: process.env.ADVISERS_MODEL })
      const checked = lintReview(review, { run, routines: ledger.listRoutines() })
      if (!checked.ok) { console.error(`review rejected: ${checked.error}`); process.exitCode = 1 }
      else {
        const made = materializeReview(checked.review, { run, ledger })
        saveLedger(ledger)
        console.log(`verdict: ${made.verdict}${made.routine ? ` draft ${made.routine.id}` : made.patch ? ` patch ${made.patch.id}` : ''}`)
      }
    }
  } else { console.error('usage: advisers learn ls|review <run-id>'); process.exitCode = 1 }
} else if (command === 'commit') {
  const sub = args[0]
  const ledger = loadLedger()
  const { flags, positional } = parseFlags(args.slice(1))
  if (sub === 'add') {
    const action = positional.join(' ').trim()
    if (!action || !flags.quote) { console.error('usage: advisers commit add "<action>" --quote "<原话>" [--due ISO] [--debtor user|agent] [--creditor name] [--matter id] [--remind-offsets "-1d,-2h"]'); process.exitCode = 1 }
    else {
      let reminderOffsets
      let offsetsError
      try { reminderOffsets = await parseReminderOffsetsFlag(flags) } catch (error) { offsetsError = error }
      if (offsetsError) { console.error(offsetsError.message); process.exitCode = 1 }
      else {
        const c = ledger.addCommitment({
          matterId: activeMatterId(ledger, flags.matter),
          debtor: flags.debtor ?? 'user',
          creditor: flags.creditor ?? /(?:发给|给|向|对)([\u4e00-\u9fa5A-Za-z0-9_]{1,12})/.exec(action)?.[1] ?? 'someone',
          action,
          dueAt: flags.due,
          timezone: flags.tz ?? 'Asia/Shanghai',
          capability: flags.capability ?? 'todo',
          evidence: [{ sessionId: latestConversationId(), turnId: 'cli', quote: String(flags.quote) }],
          ...(reminderOffsets !== undefined ? { reminderOffsets } : {}),
        })
        saveLedgerWithAudit(ledger, { actor: 'local', action: 'commit.add', allowed: true, reason: c.id })
        console.log(`${c.id} open ${c.action}${c.dueAt ? ` due ${c.dueAt}` : ''}`)
        if (reminderOffsets !== undefined) console.log('reminder-offsets: ' + JSON.stringify(reminderOffsets))
      }
    }
  } else if (sub === 'edit' || sub === 'update') {
    const id = positional[0]
    const usage = 'usage: advisers commit edit <id> [--action text] [--due ISO] [--remind-offsets "<list>" | --no-remind]'
    if (!id) { console.error(usage); process.exitCode = 1 }
    else {
      const patch = {}
      if (typeof flags.action === 'string') patch.action = flags.action
      if (typeof flags.due === 'string') patch.dueAt = flags.due
      if (typeof flags.tz === 'string') patch.timezone = flags.tz
      if (typeof flags.capability === 'string') patch.capability = flags.capability
      let offsetsError
      try {
        if (flags['no-remind'] === true) patch.reminderOffsets = null
        else {
          const offsets = await parseReminderOffsetsFlag(flags)
          if (offsets !== undefined) patch.reminderOffsets = offsets
        }
      } catch (error) { offsetsError = error }
      if (offsetsError) { console.error(offsetsError.message); process.exitCode = 1 }
      else if (!Object.keys(patch).length) { console.error(usage); process.exitCode = 1 }
      else {
        try {
          const c = ledger.updateCommitment(id, patch)
          saveLedgerWithAudit(ledger, { actor: 'local', action: 'commit.update', allowed: true, reason: id })
          console.log(`updated: ${c.id}`)
          if ('reminderOffsets' in patch) console.log('reminder-offsets: ' + JSON.stringify(c.reminderOffsets ?? []))
          if (patch.dueAt !== undefined) console.log('due: ' + (c.dueAt ?? '未定'))
        } catch (error) { console.error(error.message); process.exitCode = 1 }
      }
    }
  } else if (sub === 'ls') printCommitments(ledger, flags.json)
  else if (sub === 'snooze') {
    const id = positional[0]
    const hours = Number(positional[1] ?? 24)
    const c = ledger.listCommitments().find((x) => x.id === id)
    if (!c || !Number.isFinite(hours) || hours <= 0) { console.error('usage: advisers commit snooze <id> <hours>'); process.exitCode = 1 }
    else {
      c.status = 'snoozed'
      saveLedgerWithAudit(ledger, { actor: 'local', action: 'commit.snooze', allowed: true, reason: id }, (store) => store.setMeta(`snooze:${id}`, new Date(Date.now() + hours * 3600_000).toISOString()))
      console.log(`snoozed: ${id} for ${hours}h`)
    }
  }
  else if (sub === 'done') {
    const id = positional[0]
    const evidence = flags.evidence
    if (!id || !evidence) { console.error('usage: advisers commit done <id> --evidence "<证据/原话>"'); process.exitCode = 1 }
    else {
      if (String(evidence).startsWith('file:') && !existsSync(String(evidence).slice(5))) {
        console.error(`evidence file not found: ${String(evidence).slice(5)}`); process.exitCode = 1
      } else {
        ledger.completeCommitment(id, [{ sessionId: latestConversationId(), turnId: 'cli', quote: String(evidence) }])
        saveLedgerWithAudit(ledger, { actor: 'local', action: 'commit.done', allowed: true, reason: id })
        console.log(`done: ${id}`)
      }
    }
  } else { console.error('usage: advisers commit add|edit|ls|done|snooze'); process.exitCode = 1 }
} else if (command === 'diff') {
  const result = await diffLatest({ cwd: process.cwd(), backupDir: join(HOME, 'undo') })
  console.log(result.ok ? result.diff : `diff failed: ${result.error}`)
  if (!result.ok) process.exitCode = 1
} else if (command === 'undo') {
  if (args.includes('--list')) {
    for (const row of await listBackups(join(HOME, 'undo'), { workspace: process.cwd() })) console.log(`${row.id}\t${row.path}\t${row.existed ? 'overwrite' : 'create'}`)
  } else {
    const result = await undoLatest({ cwd: process.cwd(), backupDir: join(HOME, 'undo'), force: args.includes('--force') })
    console.log(result.ok ? `已回滚：${result.path}` : `撤销失败：${result.error}`)
    if (!result.ok) process.exitCode = 1
  }
} else if (command === 'compact') {
  const store = dbStore()
  const conversationId = latestConversationId()
  if (args[0] === 'ls') {
    for (const v of store?.listSummaryVersions(conversationId) ?? []) console.log(`${v.version}\t${v.throughSeq}\t${v.summary.slice(0, 100)}`)
  } else if (args[0] === 'rollback') {
    const version = Number(args[1])
    const old = store?.listSummaryVersions(conversationId).find((v) => v.version === version)
    if (!old) { console.error('usage: advisers compact rollback <version>'); process.exitCode = 1 }
    else { store.upsertSessionSummary({ conversationId, summary: old.summary, throughSeq: old.throughSeq, pins: old.pins }); console.log(`restored summary v${version}`) }
  } else { console.error('usage: advisers compact ls|rollback <version>'); process.exitCode = 1 }
} else if (command === 'search') {
  const q = args.join(' ').trim()
  if (!q) { console.error('usage: advisers search <text>'); process.exitCode = 1 }
  else {
    const rows = dbStore()?.searchTurns(q, { limit: 10 }) ?? []
    if (!rows.length) console.log('没有匹配')
    for (const r of rows) console.log(`${r.seq}\t${r.role}\t${r.content.replace(/\s+/g, ' ').slice(0, 160)}`)
  }
} else if (command === 'nudge') {
  const sub = args[0]
  const store = dbStore()
  if (sub === 'list') {
    for (const n of store?.listNudges(50) ?? []) console.log(`${n.id}\t${n.local_day}\t${n.level}\t${n.outcome}\t${n.body}`)
  } else if (sub === 'done' || sub === 'ignore') {
    const id = args[1]
    if (!id || !store?.setNudgeOutcome(id, sub === 'done' ? 'accepted' : 'ignored')) { console.error('usage: advisers nudge done|ignore <nudge-id>'); process.exitCode = 1 }
    else console.log(`${sub}: ${id}`)
  } else { console.error('usage: advisers nudge list|done|ignore'); process.exitCode = 1 }
} else if (command === 'risks') {
  risks(loadLedger())
} else if (command === 'pet-brief') {
  await petBrief(args)
} else if (command === 'today') {
  await today(loadLedger(), { calendar: args.includes('--calendar'), sources: args.includes('--sources'), json: args.includes('--json') })
} else if (command === 'tick') {
  tick(loadLedger(), args.includes('--json'))
} else if (command === 'ui') {
  await ui(args)
} else if (command === 'remind') {
  await remind(args)
} else if (command === 'calendar') {
  await calendarImport(args.slice(1))
} else if (command === 'who') {
  const open = loadLedger().openCommitments()
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
  const ledger = loadLedger()
  if (args[0] === 'candidates') {
    const rows = dbStore()?.listCandidates(args.includes('--all') ? 'all' : 'pending') ?? []
    if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2))
    else {
      if (!rows.length) console.log('（没有待确认记忆）')
      for (const c of rows) console.log(`${c.id}\t${c.kind}\t${JSON.stringify(c.payload)}\t${c.status}`)
    }
  } else if (args[0] === 'accept') {
    const store = dbStore()
    const candidate = store?.getCandidate(args[1])
    if (!candidate) { console.error('candidate not found'); process.exitCode = 1 }
    else {
      try {
        const sourceRef = (e) => ({ ...(e.sessionId ? { quote: e.quote, ref: `${e.sessionId}#${e.turnId}` } : { quote: e.quote, ref: e.turnId ? `legacy#${e.turnId}` : undefined }), ...(e.source ? { source: e.source } : {}) })
        const commitmentEvidence = (e) => {
          if (!e.sessionId) return { quote: e.quote, turnId: e.turnId, sessionId: 'legacy', ...(e.source ? { source: e.source } : {}) }
          const turn = store.getTurn(e.turnId)
          if (!turn || turn.conversationId !== e.sessionId) throw new Error(`evidence turn not found: ${e.turnId}`)
          return { quote: e.quote, turnId: e.turnId, sessionId: e.sessionId, ...(e.source ? { source: e.source } : {}) }
        }
        if (candidate.kind === 'fact') ledger.remember({ ...candidate.payload, authority: 'user', evidence: candidate.evidence.map(sourceRef) })
        else if (candidate.kind === 'preference') ledger.addPreference({ ...candidate.payload, evidence: candidate.evidence.map(sourceRef) })
        else if (candidate.kind === 'commitment') ledger.addCommitment({ ...candidate.payload, matterId: candidate.payload.matterId ?? ledger.listMatters()[0]?.id, evidence: candidate.evidence.map(commitmentEvidence) })
        saveLedgerWithAudit(ledger, { actor: 'local', action: 'memory.accept', allowed: true, reason: candidate.id }, (s) => s.reviewCandidate(candidate.id, 'accepted'))
        console.log(`accepted ${candidate.id}`)
      } catch (error) { console.error(error.message); process.exitCode = 1 }
    }
  } else if (args[0] === 'reject') {
    const store = dbStore()
    const candidate = store?.getCandidate(args[1])
    if (!candidate) { console.error('candidate not found'); process.exitCode = 1 }
    else {
      updateStoreWithAudit((s) => s.reviewCandidate(candidate.id, 'rejected', args.slice(2).join(' ') || undefined), { actor: 'local', action: 'memory.reject', allowed: true, reason: candidate.id })
      console.log(`rejected ${candidate.id}`)
    }
  } else if (args[0] === 'search') {
    const q = args.slice(1).join(' ').trim()
    if (!q) { console.error('usage: advisers memory search <query>'); process.exitCode = 1 }
    else {
      const store = dbStore()
      const rows = store?.searchMemory(q) ?? ledger.searchMemory(q)
      if (!rows.length) console.log('（没有记忆匹配）')
      for (const r of rows) console.log(`${r.kind}\t${r.id}\t${r.text}${r.matterId ? `\t[${r.matterId}]` : ''}`)
      const turns = store?.searchTurns(q) ?? []
      for (const t of turns) console.log(`turn\t${t.conversationId}#${t.seq}\t${String(t.text).replace(/\s+/g, ' ').slice(0, 120)}`)
    }
  } else printMemory(ledger)
} else if (command === 'digest') {
  const period = args[0] === 'week' ? 'week' : 'day'
  const store = dbStore()
  console.log(buildDigest({
    period,
    turns: store?.listTurns(latestConversationId(), 200) ?? [],
    commitments: loadLedger().listCommitments(),
    deliveries: store?.listDeliveries(100) ?? [],
  }))
} else if (command === 'week') {
  printWeek(loadLedger())
} else if (command === 'prefs') {
  printPreferences()
} else if (command === 'privacy') {
  printPrivacy(args)
} else if (command === 'audit') {
  printAudit(args)
} else if (command === 'purge') {
  purgeMatter(args[0], args.includes('--yes'))
} else if (command === 'decay') {
  const ledger = loadLedger()
  const changed = applyPreferenceDecay(ledger.listPreferences({ includeCandidates: true }))
  saveLedger(ledger)
  console.log(`[decay] ${changed.length} preference(s) updated`)
} else if (command === 'correct') {
  const statement = args.join(' ').trim()
  if (!statement) { console.error('usage: advisers correct <statement>'); process.exitCode = 1 }
  else {
    const ledger = loadLedger()
    const result = learnPreference(ledger, statement, statement, { explicit: true })
    saveLedgerWithAudit(ledger, { actor: 'local', action: 'correct', allowed: true, reason: result.preference.id })
    printLearnReceipt(result)
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
  const { flags } = parseFlags(args)
  await exportLedger(flags.all === true || args.includes('--all'), { encrypted: args.includes('--encrypted'), out: typeof flags.out === 'string' ? flags.out : undefined })
} else if (command === 'import') {
  await importLedger(args.find((a) => !a.startsWith('--')), { replace: args.includes('--replace') })
} else if (command === 'backup') {
  backup(args[0])
} else if (command === 'brief') {
  await brief(args.filter((a) => a !== '--deep').join(' ').trim(), args.includes('--deep'))
} else if (command === 'review') {
  await documentReview(args)
} else if (command === 'research') {
  await research(args)
} else if (command === 'capture') {
  await capture(args)
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
  await template(args[0], args[1], args[2])
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
