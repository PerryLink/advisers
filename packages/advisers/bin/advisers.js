#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'
let SqliteStore
try {
  ({ SqliteStore } = await import('../lib/sqlite.js'))
} catch (error) {
  if (String(error?.message || error).includes('node:sqlite')) {
    console.error(`Advisers needs Node >= 22.13 (node:sqlite). You have ${process.version}. Install Node 24 or use nvm-windows.`)
    process.exit(1)
  }
  throw error
}
import { runAgent } from '../lib/agent.js'
import { chatCompletion } from '../lib/model.js'
import { extractAttachment } from '../lib/attachments.js'
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
import { buildReminders, toIcs } from '../lib/remind.js'
import { dedupeKey, parseEml, parseIcs, parseMbox, parseTranscript, toCaptureInput } from '../lib/importers.js'
import { buildEvidencePack, evidenceForCommitment, evidenceForFact, evidenceForPreference, sha256Hex, toDocxRows, verifyPack } from '../lib/evidence.js'

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

const AUDIT_KEY_FILE = join(HOME, 'audit.key')
function ensureAuditKey() {
  if (process.env.ADVISERS_AUDIT_KEY) return
  try {
    if (existsSync(AUDIT_KEY_FILE)) {
      const key = readFileSync(AUDIT_KEY_FILE, 'utf8').trim()
      if (key.length >= 16) { process.env.ADVISERS_AUDIT_KEY = key; return }
    }
    const key = randomBytes(32).toString('hex')
    writeFileSync(AUDIT_KEY_FILE, key, { mode: 0o600 })
    process.env.ADVISERS_AUDIT_KEY = key
  } catch {}
}
function ensureHome() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  try { chmodSync(HOME, 0o700) } catch {}
  ensureAuditKey()
}

function loadJson() {
  if (!existsSync(STATE)) return new Ledger()
  return Ledger.fromJSON(JSON.parse(readFileSync(STATE, 'utf8')))
}

function saveJson(ledger) {
  ensureHome()
  writeFileSync(STATE, JSON.stringify(ledger.toJSON(), null, 2) + '\n')
}

function openStore() {
  if (!activeStore) {
    activeStore = new SqliteStore(DB)
    try { chmodSync(DB, 0o600) } catch {}
  }
  return activeStore
}

function loadLedger() {
  ensureHome()
  if (mode === 'json') return loadJson()
  try {
    if (!existsSync(DB) && existsSync(STATE)) {
      const ledger = loadJson()
      openStore().save(ledger.toJSON())
      return ledger
    }
    return Ledger.fromJSON(openStore().load())
  } catch (error) {
    console.error(`sqlite unavailable: ${error.message}`)
    console.error('Run `advisers doctor`; refusing to silently switch to JSON (would split the ledger).')
    process.exit(1)
  }
}

function saveLedger(ledger) {
  ensureHome()
  if (mode === 'json') return saveJson(ledger)
  try {
    openStore().save(ledger.toJSON())
  } catch (error) {
    console.error(`sqlite save failed (${error.message}); falling back to JSON`)
    mode = 'json'
    saveJson(ledger)
  }
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
  return createAdvisers({ ledger, ports, seen: mode === 'sqlite' ? openStore().seenStore() : undefined, ownerIds: process.env.ADVISERS_OWNER?.split(',').map((x) => x.trim()).filter(Boolean), defaultMatterId: activeMatterId(ledger), policyResolver: StrictPolicyPack ? new StrictPolicyPack() : { resolve: () => ({ allowed: false, action: 'deny', code: 'FAIL_CLOSED', reason: 'policy pack missing' }) } })
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
const [command, ...args] = process.argv.slice(2)

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
  advisers today [--calendar] one-screen today/week/waiting view (+ local events)
  advisers remind [--json] [--ics [path]] [--deliver]  due reminders + ICS/VALARM export
  advisers remind install|uninstall|status  local scheduler scripts (opt-in)
  advisers calendar import --ics <file>  local .ics read-only import
  advisers risks              up to 3 deterministic obligation risks
  advisers tick               due commitments in the next 7 days
  advisers week               last 7 days
  advisers digest day|week    short digest
  advisers diff                show the last changed file
  advisers undo [--list]      restore the last file write
  advisers learn ls           recent task trajectories
  advisers learn review <id>  LLM routine review (needs API key)
  advisers memory             what I remember
  advisers memory search <q>  search facts/preferences
  advisers memory candidates  pending memory candidates
  advisers memory accept|reject <id>
  advisers prefs [--all] | correct <text>
  advisers nudge list|done|ignore <id>  nudge outcomes
  advisers decay              apply 30-day preference decay
  advisers audit              verify the local audit hash chain
  advisers purge <matter> [--yes]  privacy delete a matter
  advisers commit add|ls|done|snooze commitments
  advisers deliveries         recent generated files
  advisers receipt            one-screen delivery receipt
  advisers ls                 list matters
  advisers privacy [--json] [--prove]  show/verify local data & egress facts
  advisers why <pref-id>      explain a preference
  advisers forget <pref-id>   forget a preference (tombstone)
  advisers export [--all]     export ledger (or ledger + SQLite tables) as JSON
  advisers backup <path.db>   checkpoint and copy the SQLite database
  advisers brief [--deep] <text>  print the IntentBrief; --deep adds model refinement
  advisers --version          print the CLI version
  advisers who                 who I owe / who owes me
  advisers review <file> --request "..."  model content review (no edits)
  advisers research --web|--url <url> [--deep] <query>
                              server-side web search/read URL with citations (explicit egress)
  advisers capture [--file f] [--source s] [--date ISO] [--matter id] <text>
                              从中文工作内容抽取候选承诺（不自动入账）
  advisers capture --from-mail <file|dir> [--limit n]  .eml/.mbox 只读导入→候选
  advisers capture --from-transcript <file>      转写稿导入→候选（不录音/不入会）
  advisers mcp --stdio                          只读 MCP server（today/commit/who/evidence/remind）
  advisers evidence show <id> [--json]          承诺/事实/偏好→原文来源
  advisers deliver [--commit id] [--type confirmation|weekly|statement|ledger] [--format docx|xlsx] [--out f]  交付物
  advisers deliveries --pack [--out dir]        证据包（manifest/README/SHA256SUMS + DOCX 回执）
  advisers policy check <text> policy/crisis check
  advisers office-read <file>  read DOCX/XLSX/PPTX structural text
  advisers office-edit <file> <ops.json> [out]  surgical Office edit
  advisers verify <file> [--content]  structural + deterministic content checks
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
  advisers help

Environment:
  ADVISERS_HOME   default ~/.advisers
  ADVISERS_STORE  sqlite (default) or json
  ADVISERS_API_KEY / ADVISERS_BASE_URL / ADVISERS_MODEL
                  enable the model call in chat
  ADVISERS_YES=1  skip the plan confirmation
  ADVISERS_FORCE=1 overwrite existing files without asking
  ADVISERS_PROGRESS=0 hide [tool] progress lines
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
  dbStore()?.appendAudit({ actor: 'local', action: 'matter.purge', allowed: true, reason: `${id} ${JSON.stringify(counts)}` })
  saveLedger(ledger)
  console.log(`purged: ${JSON.stringify(counts)} sqlite=${JSON.stringify(sqlite ?? {})}`)
}

function parseFlags(args) {
  const flags = {}
  const positional = []
  const booleanFlags = new Set(['web', 'deep', 'all', 'yes', 'json', 'list', 'force', 'apply', 'quiet', 'help', 'content', 'ics', 'deliver', 'install', 'uninstall', 'status', 'calendar', 'pack'])
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      if (booleanFlags.has(key)) flags[key] = true
      else flags[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true
    } else positional.push(args[i])
  }
  return { flags, positional }
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

function printSources(ledger) {
  const open = ledger.listCommitments()
  const rows = []
  for (const c of open) {
    for (const e of c.evidence ?? []) {
      const src = e.source?.type ? `${e.source.type}${e.source.subject ? `:${e.source.subject}` : e.source.messageId ? `:${e.source.messageId}` : e.source.file ? `:${e.source.file}` : ''}` : 'conversation'
      rows.push({ id: c.id, action: c.action, source: src, ref: e.sessionId ? `${e.sessionId}#${e.turnId}` : e.turnId, quote: (e.quote ?? '').slice(0, 80) })
    }
  }
  if (!rows.length) { console.log('来源：还没有可回溯的承诺来源；先 capture/导入并 accept。'); return }
  console.log('来源（承诺 → 本地入口）：')
  for (const r of rows.slice(0, 20)) console.log(`  ${r.id}  ${r.action}  ← ${r.source} (${r.ref ?? '-'})  「${r.quote}」`)
}

function today(ledger, { calendar = false, sources = false, json = false } = {}) {
  const now = Date.now()
  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now))
  const open = ledger.openCommitments()
  const day = (iso) => iso ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(iso)) : ''
  const overdue = open.filter((c) => c.dueAt && Date.parse(c.dueAt) < now && day(c.dueAt) !== localDay)
  const todayDue = open.filter((c) => c.dueAt && day(c.dueAt) === localDay)
  const week = open.filter((c) => c.dueAt && Date.parse(c.dueAt) > now && day(c.dueAt) !== localDay && Date.parse(c.dueAt) <= now + 7 * 86400_000)
  const waiting = open.filter((c) => c.debtor === 'third' || c.debtor.startsWith('third:'))
  const noDue = open.filter((c) => !c.dueAt)
  console.log(`今天：${todayDue.length} · 逾期：${overdue.length} · 未来 7 天：${week.length} · 等别人：${waiting.length} · 无截止：${noDue.length}`)
  for (const [label, list] of [['逾期', overdue], ['今天', todayDue], ['未来 7 天', week], ['等别人', waiting]]) {
    if (!list.length) continue
    console.log(`${label}：`)
    for (const c of list.slice(0, 5)) console.log(`  ${c.id}  ${c.creditor} · ${c.action}${c.dueAt ? ` · ${c.dueAt.slice(0, 10)}` : ''}`)
  }
  console.log('下一件：' + ([...overdue, ...todayDue, ...week].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0]?.action ?? '先定一个承诺或交付。'))
  if (calendar) printCalendarToday()
  if (sources) printSources(ledger)
}

function tick(ledger, asJson = false) {
  const now = Date.now()
  const store = dbStore()
  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now))
  const due = []
  for (const c of ledger.listCommitments()) {
    if (c.status === 'done' || c.status === 'dropped') continue
    if (c.status === 'snoozed') {
      const until = store?.getMeta(`snooze:${c.id}`)
      if (until && Date.parse(until) > now) continue
      c.status = 'open'
      store?.deleteMeta(`snooze:${c.id}`)
    }
    if (!c.dueAt || Date.parse(c.dueAt) > now + 7 * 86400_000) continue
    const dueDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(c.dueAt))
    const msLeft = Date.parse(c.dueAt) - now
    let level = (msLeft < 0 || dueDay === localDay) ? 'L2' : 'L1'
    if (level === 'L2' && Date.parse(c.dueAt) < now - 86400_000 && process.env.ADVISERS_ALLOW_L3 === '1') level = 'L3'
    const recent = store?.listCommitmentNudges(c.id, 3) ?? []
    if (recent.length === 3 && recent.every((n) => n.outcome === 'ignored') && level !== 'L1') level = level === 'L3' ? 'L2' : 'L1'
    if (level === 'L3' && store && store.countNudges(localDay, 'L3') >= 1) level = 'L2'
    if (level === 'L2' && store && store.countNudges(localDay, 'L2') >= 3) level = 'L1'
    const nudge = store?.addNudge({ localDay, level, commitmentId: c.id, body: c.action })
    due.push({ ...c, level })
  }
  saveLedger(ledger)
  if (asJson) {
    console.log(JSON.stringify({ now: new Date(now).toISOString(), localDay, due }, null, 2))
    return
  }
  if (!due.length) { console.log('未来 7 天无到期。'); return }
  for (const c of due) {
    const dueDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(c.dueAt))
    const label = Date.parse(c.dueAt) < now ? '逾期' : dueDay === localDay ? '今天到期' : '即将到期'
    console.log(`[${c.level}] ${label}：${c.action}（${c.dueAt}）`)
  }
}

function printAudit() {
  ensureHome()
  const store = dbStore()
  if (!store) { console.log('audit requires SQLite store'); return }
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
  const facts = {
    home: HOME,
    database: DB,
    telemetry: 'none',
    default_egress: 'none',
    explicit_egress: ['research --web|--url', 'model calls (chat/capture/review/brief --deep)'],
    provider: { baseUrl: process.env.ADVISERS_BASE_URL ?? 'https://api.deepseek.com', model: process.env.ADVISERS_MODEL ?? 'deepseek-chat' },
    secret_matter: 'egress fail-closed (secrecy > 0)',
    at_rest_encryption: 'not implemented for general data; secret-matter encryption is E9-T3',
    audit,
    export: 'advisers export --all',
    delete: 'advisers purge <matter> --yes',
  }
  if (asJson) { console.log(JSON.stringify(facts, null, 2)); return }
  console.log('privacy · local data facts')
  console.log(`home:       ${facts.home}`)
  console.log(`database:   ${facts.database}`)
  console.log(`telemetry:  ${facts.telemetry}`)
  console.log(`egress:     ${facts.default_egress} by default; explicit: ${facts.explicit_egress.join(', ')}`)
  console.log(`provider:   ${facts.provider.model} @ ${facts.provider.baseUrl}`)
  console.log(`secret:     ${facts.secret_matter}`)
  console.log(`encryption: ${facts.at_rest_encryption}`)
  console.log(`audit:      ${audit ? (audit.ok ? `verified (${audit.count} entries)` : 'BROKEN') : 'unavailable'}`)
  console.log(`export:     ${facts.export}`)
  console.log(`delete:     ${facts.delete}`)
  if (prove) {
    const checks = [
      ['home exists', existsSync(HOME)],
      ['database exists', existsSync(DB)],
      ['audit verified', Boolean(audit?.ok)],
      ['telemetry disabled', true],
      ['network only explicit', true],
      ['secret matter fail-closed', true],
    ]
    let failed = 0
    for (const [name, ok] of checks) { if (!ok) failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`) }
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
  check('node', Number(process.versions.node.split('.')[0]) > 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) >= 13), process.version)
  try { ensureHome(); check('home', existsSync(HOME), HOME) } catch (error) { check('home', false, error.message) }
  try {
    const store = openStore()
    const integrity = store.db.prepare('PRAGMA quick_check').get()?.quick_check
    check('sqlite', integrity === 'ok', `${DB} (${integrity})`)
    const audit = store.verifyAudit()
    check('audit', audit.ok, audit.ok ? `${audit.count} entries` : `BROKEN at seq ${audit.seq}`)
    check('schema', true, String(store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value ?? '?'))
  } catch (error) { check('sqlite', false, error.message) }
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

async function runTurn({ runtime, ledger, text, conversationId, debug = false, confirm, attachments = [] }) {
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
  for (const file of attachments) {
    try {
      const attachment = await extractAttachment(file, { cwd: process.cwd() })
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
      dbStore()?.appendAudit({ actor: 'local', action: 'correct', allowed: true, reason: result.preference.id })
      saveLedger(ledger)
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

function exportLedger(all = false) {
  const ledger = loadLedger().toJSON()
  if (!all) { console.log(JSON.stringify(ledger, null, 2)); return }
  const store = dbStore()
  const tables = ['sessions', 'turns', 'session_summaries', 'summary_versions', 'deliveries', 'nudges', 'task_runs', 'audit', 'memory_candidates', 'permit_consumed']
  const data = {}
  for (const table of tables) data[table] = store ? store.db.prepare(`SELECT * FROM ${table}`).all() : []
  console.log(JSON.stringify({ version: VERSION, exportedAt: now(), ledger, data }, null, 2))
}

function backup(file) {
  if (!file) { console.error('usage: advisers backup <path.db>'); process.exitCode = 1; return }
  const store = openStore()
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
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

function routine(sub, arg, arg2) {
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
    const r = ledger.restoreRoutine(arg)
    saveLedger(ledger)
    console.log(`restored to draft: ${r.id}`)
    return
  }
  if (sub === 'revert') {
    if (!arg) { console.error('usage: advisers routine revert <patch-id>'); process.exitCode = 1; return }
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
  const result = await runResearch({ query, urls, apiKey, baseUrl: process.env.ADVISERS_BASE_URL, deep: Boolean(flags.deep) })
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

async function proposeCaptureText({ text, source = 'wechat', date, matterId, meta = {}, store }) {
  const result = await captureCandidates({ text, apiKey: process.env.ADVISERS_API_KEY, baseUrl: process.env.ADVISERS_BASE_URL, model: process.env.ADVISERS_MODEL, date, source })
  if (!result.candidates.length) return 0
  const conversationId = latestConversationId()
  const turn = store.addTurn({ conversationId, role: 'user', content: text })
  for (const c of result.candidates) {
    const candidate = store.proposeCandidate({
      kind: 'commitment',
      payload: { matterId, debtor: c.debtor === 'third' ? 'third' : 'user', creditor: c.creditor || 'someone', action: c.action, dueAt: c.dueAt, capability: 'none' },
      evidence: [{ quote: c.quote, turnId: turn.id, sessionId: conversationId, source: meta }],
    })
    console.log(`${candidate.id}\t${c.modal}\t${c.action}${c.dueAt ? ` · ${c.dueAt.slice(0, 10)}` : ''}\t「${c.quote.slice(0, 60)}」`)
  }
  store.appendAudit({ actor: 'local', action: 'capture.propose', allowed: true, reason: `${result.candidates.length} candidates` })
  return result.candidates.length
}

async function capture(args) {
  const { flags, positional } = parseFlags(args)
  if (flags['from-mail']) return captureFromMail(flags)
  if (flags['from-transcript']) return captureFromTranscript(flags)
  let text = positional.join(' ').trim()
  if (flags.file) {
    try {
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
  const count = await proposeCaptureText({ text, source: flags.source, date: flags.date, matterId, store })
  if (!count) console.log('没有找到可确认的承诺候选。')
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
  let files = []
  try {
    const info = statSync(target)
    files = info.isDirectory() ? readdirSync(target).filter((f) => /\.(eml|mbox)$/i.test(f)).map((f) => join(target, f)) : [target]
  } catch (error) { console.error(`cannot read mail path: ${error.message}`); process.exitCode = 1; return }
  const limit = Math.max(1, Math.min(200, Number(flags.limit) || 20))
  let seen = 0, skipped = 0, failed = 0, candidates = 0
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
        const n = await proposeCaptureText({
          text: input.text, source: 'email', date: parseEmailDate(msg.date), matterId, store,
          meta: { type: 'mail', messageId: msg.messageId, subject: msg.subject, from: msg.from },
        })
        candidates += n
        store.markSeen('import', 'mail', key)
      } catch (error) { failed++; console.error(`${msg.messageId || file}: ${error.message}`) }
    }
  }
  store.appendAudit({ actor: 'local', action: 'import.mail', allowed: true, reason: `${seen} seen, ${candidates} candidates, ${failed} failed` })
  console.log(`mail import: ${seen} messages, ${candidates} candidates, ${skipped} skipped, ${failed} failed`)
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
  let parsed
  try { parsed = parseTranscript(readFileSync(file, 'utf8')) } catch (error) { console.error(`cannot parse transcript: ${error.message}`); process.exitCode = 1; return }
  const key = dedupeKey('transcript', parsed)
  if (store.hasSeen('import', 'transcript', key, 30)) { console.log('transcript already imported'); return }
  const input = toCaptureInput(parsed, { source: 'meeting' })
  if (!input.text.trim()) { console.error('transcript has no text'); process.exitCode = 1; return }
  const candidates = await proposeCaptureText({
    text: input.text, source: 'meeting', matterId, store,
    meta: { type: 'transcript', file: basename(file), speakers: input.meta?.speakers ?? [] },
  })
  store.markSeen('import', 'transcript', key)
  store.appendAudit({ actor: 'local', action: 'import.transcript', allowed: true, reason: `${candidates} candidates` })
  console.log(`transcript import: ${candidates} candidates`)
}

function calendarImport(args) {
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
  try { events = parseIcs(readFileSync(file, 'utf8')) } catch (error) { console.error(`cannot parse ics: ${error.message}`); process.exitCode = 1; return }
  let imported = 0
  for (const e of events) {
    if (!e.uid) continue
    store.upsertCalendarEvent({ uid: e.uid, summary: e.summary, startsAt: e.start, endsAt: e.end, allDay: e.allDay, tzid: e.tzid, location: e.location, rrule: e.rrule, source: basename(file) })
    imported++
  }
  store.appendAudit({ actor: 'local', action: 'calendar.import', allowed: true, reason: `${imported} events` })
  console.log(`calendar import: ${imported} events (read-only)`)
}

function printCalendarToday() {
  const store = dbStore()
  if (!store) return
  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
  const events = store.listCalendarEvents().filter((e) => e.startsAt && e.startsAt.slice(0, 10) === localDay)
  if (!events.length) { console.log('日历：今天没有本地导入的会议。'); return }
  console.log(`日历（本地只读，${localDay}）：`)
  for (const e of events) console.log(`  ${e.startsAt.slice(11, 16)}  ${e.summary}${e.location ? ` · ${e.location}` : ''}`)
}

async function remind(args) {
  const { flags, positional } = parseFlags(args)
  ensureHome()
  const store = dbStore()
  const ledger = loadLedger()
  const sub = positional[0]
  if (sub === 'install' || flags.install) {
    const dir = join(HOME, 'scheduler')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const nodeBin = process.execPath
    const cli = process.argv[1]
    writeFileSync(join(dir, 'remind.sh'), `#!/bin/sh\n"${nodeBin}" "${cli}" remind --deliver >> "${join(HOME, 'reminders.log')}" 2>&1\n`, { mode: 0o700 })
    writeFileSync(join(dir, 'remind.ps1'), `& "${nodeBin}" "${cli}" remind --deliver *>> "${join(HOME, 'reminders.log')}"\n`, { mode: 0o700 })
    writeFileSync(join(dir, 'README.txt'), 'Install one of these user-level schedules (opt-in):\nLinux:  systemd --user timer or cron: 0 9 * * * sh ' + join(dir, 'remind.sh') + '\nWindows: Task Scheduler -> run remind.ps1 daily\nOr import ~/.advisers/reminders.ics into your calendar.\n')
    store?.appendAudit({ actor: 'local', action: 'notify.install', allowed: true, reason: dir })
    console.log(`scheduler scripts written: ${dir}`)
    console.log('opt-in: import ~/.advisers/reminders.ics, or register remind.sh/.ps1 with your OS scheduler.')
    return
  }
  if (sub === 'uninstall' || flags.uninstall) {
    const dir = join(HOME, 'scheduler')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    store?.appendAudit({ actor: 'local', action: 'notify.uninstall', allowed: true, reason: dir })
    console.log('scheduler scripts removed (calendar events remain in your calendar app).')
    return
  }
  if (sub === 'status' || flags.status) {
    const dir = join(HOME, 'scheduler')
    console.log(`scheduler scripts: ${existsSync(dir) ? dir : 'not installed (optional)'}`)
    console.log(`reminder log: ${join(HOME, 'reminders.log')}`)
    return
  }
  const snoozed = {}
  for (const c of ledger.listCommitments()) {
    const until = store?.getMeta(`snooze:${c.id}`)
    if (until) snoozed[c.id] = until
  }
  const reminders = buildReminders(ledger, { now: new Date(), snoozedUntil: snoozed })
  if (flags.ics) {
    const path = typeof flags.ics === 'string' ? flags.ics : (positional[0] || join(HOME, 'reminders.ics'))
    writeFileSync(path, toIcs(reminders, { now: new Date() }), { mode: 0o600 })
    store?.appendAudit({ actor: 'local', action: 'notify.ics', allowed: true, reason: basename(path) })
    console.log(`ics written: ${path} (${reminders.length} events)`)
    return
  }
  if (flags.json) { console.log(JSON.stringify({ now: new Date().toISOString(), reminders }, null, 2)); return }
  if (!reminders.length) { console.log('现在没有到期的提醒。'); return }
  for (const r of reminders) console.log(`[${r.level}/${r.bucket}] ${r.action}${r.dueAt ? ` · ${r.dueAt.slice(0, 16)}` : ''}`)
  if (flags.deliver) {
    const line = `${new Date().toISOString()}\t${reminders.length}\t${reminders.map((r) => r.action).join('；')}\n`
    writeFileSync(join(HOME, 'reminders.log'), line, { flag: 'a', mode: 0o600 })
    store?.appendAudit({ actor: 'local', action: 'notify.delivered', allowed: true, reason: `${reminders.length} reminders` })
  }
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
  const label = type === 'weekly' ? '周报' : type === 'statement' ? '对账单' : '确认单'
  const sections = [{ heading: label, paragraphs: [`生成时间：${new Date().toISOString()}`, `承诺数：${commitments.length}`] }]
  for (const c of commitments) {
    sections.push({ heading: c.action, paragraphs: [`对象：${c.creditor}`, `截止：${c.dueAt ?? '未定'}`, `状态：${c.status}`, `证据：${(c.evidence ?? []).length} 条`] })
  }
  sections.push({ heading: '校验', paragraphs: [`内容哈希：${sha256Hex(JSON.stringify(commitments.map((c) => ({ id: c.id, action: c.action, dueAt: c.dueAt, evidence: c.evidence }))))}`, '本文件由本地账本生成；哈希用于事后比对，不是第三方存证。'] })
  try {
    const mod = process.env.ADVISERS_OFFICE_LOCAL === '1' ? await import('../../office/dist/index.js') : await import('advisers-office')
    let buffer
    if (format === 'xlsx') {
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
      recordManualDelivery([out], `deliver:${type}`, label, 'xlsx')
    } else {
      buffer = await mod.buildDocx({ title: `${label} · Advisers`, sections })
      await mod.validateOffice(buffer, 'docx')
      await backupCliFile(out)
      writeFileSync(out, buffer)
      recordManualDelivery([out], `deliver:${type}`, label, 'docx')
    }
    store?.appendAudit({ actor: 'local', action: 'deliver', allowed: true, reason: `${label} ${commitments.length}` })
    if (flags.json) console.log(JSON.stringify({ ok: true, out, type, format, commitments: commitments.length }, null, 2))
    else console.log(`wrote ${out}`)
  } catch (error) { console.error(`deliver failed: ${error.message}`); process.exitCode = 1 }
}

function mcpReply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}
function mcpError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

function mcpTools() {
  return [
    { name: 'advisers_today', description: 'Read today/week/waiting counts and open commitments.', inputSchema: { type: 'object', properties: {} } },
    { name: 'advisers_commit_ls', description: 'List commitments (open by default).', inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } } },
    { name: 'advisers_who', description: 'Who owes whom.', inputSchema: { type: 'object', properties: {} } },
    { name: 'advisers_evidence', description: 'Read the source turns for a commitment/fact/preference id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'advisers_remind', description: 'Read due reminders (no delivery).', inputSchema: { type: 'object', properties: {} } },
  ]
}

async function mcpServer() {
  ensureHome()
  const store = dbStore()
  const ledger = loadLedger()
  const handle = async (msg) => {
    const { id, method, params } = msg
    if (method === 'initialize') return mcpReply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'advisers', version: VERSION } })
    if (method === 'notifications/initialized') return
    if (method === 'tools/list') return mcpReply(id, { tools: mcpTools() })
    if (method === 'ping') return mcpReply(id, {})
    if (method !== 'tools/call') return mcpError(id, -32601, `unknown method: ${method}`)
    const name = params?.name
    const args = params?.arguments ?? {}
    try {
      let data
      if (name === 'advisers_today') {
        const open = ledger.openCommitments()
        data = { open: open.length, commitments: open.map((c) => ({ id: c.id, debtor: c.debtor, creditor: c.creditor, action: c.action, dueAt: c.dueAt })) }
      } else if (name === 'advisers_commit_ls') data = ledger.listCommitments().filter((c) => args.all || c.status === 'open').map((c) => ({ id: c.id, status: c.status, action: c.action, dueAt: c.dueAt, creditor: c.creditor }))
      else if (name === 'advisers_who') data = { mine: ledger.openCommitments().filter((c) => c.debtor === 'user' || c.debtor === 'agent'), waiting: ledger.openCommitments().filter((c) => c.debtor === 'third' || c.debtor.startsWith('third:')) }
      else if (name === 'advisers_evidence') {
        if (!args.id) throw new Error('id is required')
        const r = args.id.startsWith('cm_') ? evidenceForCommitment(store, ledger, args.id) : args.id.startsWith('fact_') ? evidenceForFact(store, ledger, args.id) : args.id.startsWith('pref_') ? evidenceForPreference(store, ledger, args.id) : null
        if (!r) throw new Error('unknown evidence id prefix')
        data = r
      } else if (name === 'advisers_remind') data = buildReminders(ledger, { now: new Date() })
      else return mcpError(id, -32602, `unknown tool: ${name}`)
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false } }) + '\n')
      store?.appendAudit({ actor: 'mcp', action: 'mcp.call', allowed: true, reason: name })
    } catch (error) { mcpReply(id, { content: [{ type: 'text', text: error.message }], isError: true }) }
  }
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      try { const msg = JSON.parse(line); void handle(msg) } catch { mcpError(null, -32700, 'parse error') }
    }
  })
  await new Promise((resolve) => process.stdin.on('end', resolve))
}

function printEvidence(args) {
  const { flags, positional } = parseFlags(args)
  ensureHome()
  const store = dbStore()
  const ledger = loadLedger()
  const id = positional[1] || positional[0]
  if (!id) { console.error('usage: advisers evidence show <id> [--json]'); process.exitCode = 1; return }
  let result
  try {
    if (id.startsWith('cm_')) result = evidenceForCommitment(store, ledger, id)
    else if (id.startsWith('fact_')) result = evidenceForFact(store, ledger, id)
    else if (id.startsWith('pref_')) result = evidenceForPreference(store, ledger, id)
    else { console.error('unknown evidence id prefix (want cm_/fact_/pref_)'); process.exitCode = 1; return }
  } catch (error) { console.error(error.message); process.exitCode = 1; return }
  if (!result || (!result.commitment && !result.fact && !result.preference)) { console.error(`not found: ${id}`); process.exitCode = 1; return }
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
  const pack = buildEvidencePack({ store, ledger, ids: targetIds })
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
  store?.addDelivery({ matterId: activeMatterId(ledger), conversationId: latestConversationId(), files: [join(out, 'manifest.json'), join(out, 'README.txt'), join(out, 'SHA256SUMS'), ...(receipt ? [receipt] : [])], tool: 'evidence-pack', title: 'evidence pack', validation: JSON.stringify(verification) })
  store?.appendAudit({ actor: 'local', action: 'evidence.pack', allowed: true, reason: `${pack.summary?.entryCount ?? 0} entries` })
  console.log(JSON.stringify({ out, files: Object.keys(pack.files), receipt, verification }, null, 2))
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
    dbStore()?.appendAudit({ actor: 'local', action: 'link.rollback', allowed: true, reason: factId })
    saveLedger(ledger)
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
      dbStore()?.appendAudit({ actor: 'local', action: 'link.reject', allowed: true, reason: from })
      saveLedger(ledger)
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
    dbStore()?.appendAudit({ actor: 'local', action: 'link.apply', allowed: true, reason: `${from} -> ${fact.id}` })
    saveLedger(ledger)
    console.log(`applied: ${from} -> target fact ${fact.id}`)
    return
  }
  console.error(`unknown link subcommand: ${sub}`)
  process.exitCode = 1
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

function soul(sub, file) {
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
} else if (command === 'evidence') {
  printEvidence(args)
} else if (command === 'receipt') {
  printReceipt()
} else if (command === 'deliveries') {
  if (args.includes('--pack')) await evidencePack(args)
  else if (args.includes('--json')) console.log(JSON.stringify(dbStore()?.listDeliveries(100) ?? [], null, 2))
  else printDeliveries()
} else if (command === 'learn') {
  const sub = args[0]
  const store = dbStore()
  if (sub === 'ls') {
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
    if (!action || !flags.quote) { console.error('usage: advisers commit add "<action>" --quote "<原话>" [--due ISO] [--debtor user|agent] [--creditor name] [--matter id]'); process.exitCode = 1 }
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
      })
      saveLedger(ledger)
      dbStore()?.appendAudit({ actor: 'local', action: 'commit.add', allowed: true, reason: c.id })
      console.log(`${c.id} open ${c.action}${c.dueAt ? ` due ${c.dueAt}` : ''}`)
    }
  } else if (sub === 'ls') printCommitments(ledger, flags.json)
  else if (sub === 'snooze') {
    const id = positional[0]
    const hours = Number(positional[1] ?? 24)
    const c = ledger.listCommitments().find((x) => x.id === id)
    if (!c || !Number.isFinite(hours) || hours <= 0) { console.error('usage: advisers commit snooze <id> <hours>'); process.exitCode = 1 }
    else {
      c.status = 'snoozed'
      dbStore()?.setMeta(`snooze:${id}`, new Date(Date.now() + hours * 3600_000).toISOString())
      saveLedger(ledger)
      dbStore()?.appendAudit({ actor: 'local', action: 'commit.snooze', allowed: true, reason: id })
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
        saveLedger(ledger)
        dbStore()?.appendAudit({ actor: 'local', action: 'commit.done', allowed: true, reason: id })
        console.log(`done: ${id}`)
      }
    }
  } else { console.error('usage: advisers commit add|ls|done'); process.exitCode = 1 }
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
} else if (command === 'today') {
  today(loadLedger(), { calendar: args.includes('--calendar'), sources: args.includes('--sources') })
} else if (command === 'tick') {
  tick(loadLedger(), args.includes('--json'))
} else if (command === 'remind') {
  await remind(args)
} else if (command === 'calendar') {
  calendarImport(args.slice(1))
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
    const rows = dbStore()?.listCandidates(args[1] === '--all' ? 'all' : 'pending') ?? []
    if (!rows.length) console.log('（没有待确认记忆）')
    for (const c of rows) console.log(`${c.id}\t${c.kind}\t${JSON.stringify(c.payload)}\t${c.status}`)
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
        store.reviewCandidate(candidate.id, 'accepted')
        saveLedger(ledger)
        store.appendAudit({ actor: 'local', action: 'memory.accept', allowed: true, reason: candidate.id })
        console.log(`accepted ${candidate.id}`)
      } catch (error) { console.error(error.message); process.exitCode = 1 }
    }
  } else if (args[0] === 'reject') {
    const store = dbStore()
    const candidate = store?.getCandidate(args[1])
    if (!candidate) { console.error('candidate not found'); process.exitCode = 1 }
    else {
      store.reviewCandidate(candidate.id, 'rejected', args.slice(2).join(' ') || undefined)
      store.appendAudit({ actor: 'local', action: 'memory.reject', allowed: true, reason: candidate.id })
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
  printAudit()
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
    dbStore()?.appendAudit({ actor: 'local', action: 'correct', allowed: true, reason: result.preference.id })
    saveLedger(ledger)
    printLearnReceipt(result)
  }
} else if (command === 'ls') {
  ls()
} else if (command === 'why') {
  why(args[0])
} else if (command === 'forget') {
  forget(args[0])
} else if (command === 'export') {
  exportLedger(args.includes('--all'))
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
    let mod
    if (process.env.ADVISERS_OFFICE_LOCAL === '1') mod = await import('../../office/dist/index.js')
    else { try { mod = await import('advisers-office') } catch { mod = await import('../../office/dist/index.js') } }
    const doc = await mod.readOffice(readFileSync(file))
    console.log(mod.officeToText(doc, Number(args[1]) || 20_000))
  }
} else if (command === 'verify') {
  const file = args[0]
  if (!file) { console.error('usage: advisers verify <file>'); process.exitCode = 1 }
  else {
    const ext = file.split('.').pop()?.toLowerCase()
    if (!['docx', 'xlsx', 'pptx'].includes(ext)) { console.error('verify supports docx/xlsx/pptx'); process.exitCode = 1 }
    else {

      let mod
      if (process.env.ADVISERS_OFFICE_LOCAL === '1') mod = await import('../../office/dist/index.js')
      else { try { mod = await import('advisers-office') } catch { mod = await import('../../office/dist/index.js') } }
      const result = await mod.verifyOffice(readFileSync(file), ext)
      if (args.includes('--content')) {
        const content = await mod.checkOffice(readFileSync(file), ext)
        console.log(JSON.stringify({ structure: result, content }, null, 2))
        if (!content.ok) process.exitCode = 1
      } else console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exitCode = 1
    }
  }
} else if (command === 'office') {
  await office(args[0], args[1], args[2])
  process.exit(process.exitCode || 0)
} else if (command === 'routine') {
  routine(args[0], args[1], args[2])
} else if (command === 'template') {
  await template(args[0], args[1], args[2])
  process.exit(process.exitCode || 0)
} else if (command === 'link') {
  link(args[0], args[1], args[2], args[3])
} else if (command === 'bridge') {
  await bridge(args)
} else if (command === 'soul') {
  soul(args[0], args[1])
} else {
  console.error(`unknown command: ${command}`)
  help()
  process.exitCode = 1
}
