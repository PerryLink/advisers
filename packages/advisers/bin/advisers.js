#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { SqliteStore } from '../lib/sqlite.js'
import { runAgent } from '../lib/agent.js'
import { chatCompletion } from '../lib/model.js'
import { extractAttachment } from '../lib/attachments.js'
import { applyPreferenceDecay, buildRoutineCandidate, correctionStatement } from '../lib/learning.js'
import { checkRoutine } from '../lib/routine.js'
import { diffLatest, listBackups, undoLatest } from '../lib/undo.js'
import { lintReview, materializeReview, reviewRun } from '../lib/review.js'
import { classifyNudgeOutcome } from '../lib/nudge.js'
import { buildDigest } from '../lib/digest.js'
import { buildHistory, buildOpening, buildPins, continuityProbes, ensurePins, fitHistory, shouldSummarize, summarizeTurns } from '../lib/context-window.js'

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

function ensureHome() {
  mkdirSync(HOME, { recursive: true })
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
  if (!activeStore) activeStore = new SqliteStore(DB)
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
    console.error(`sqlite unavailable (${error.message}); falling back to JSON`)
    mode = 'json'
    return loadJson()
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
  writeFileSync(SOUL, doc.content)
  writeFileSync(SOUL_META, JSON.stringify({ version: doc.version, updatedAt: doc.updatedAt }, null, 2) + '\n')
}

const soulStore = { load: loadSoul, save: saveSoul }

function runtimeFor(ledger) {
  const ports = { ...systemPorts(), soul: soulStore }
  return createAdvisers({ ledger, ports, seen: mode === 'sqlite' ? openStore().seenStore() : undefined, ownerIds: process.env.ADVISERS_OWNER?.split(',').map((x) => x.trim()).filter(Boolean), policyResolver: StrictPolicyPack ? new StrictPolicyPack() : undefined })
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

const [command, ...args] = process.argv.slice(2)

function help() {
  console.log(`advisers — a staff of AI advisers

Usage:
  advisers                    start the local conversation (TTY)
  advisers chat [--file <path>] [text]
                              one-shot task, or start the local conversation
  advisers status             home/store/model/counts
  advisers history            recent conversations
  advisers search <text>       full-text search old turns
  advisers compact ls|rollback summary versions
  advisers tick               due commitments within 24h
  advisers week               last 7 days
  advisers digest day|week    short digest
  advisers diff                show the last changed file
  advisers undo [--list]      restore the last file write
  advisers learn ls           recent task trajectories
  advisers learn review <id>  LLM routine review (needs API key)
  advisers memory             what I remember
  advisers commit add|ls|done|snooze commitments
  advisers deliveries         recent generated files
  advisers ls                 list matters
  advisers why <pref-id>      explain a preference
  advisers forget <pref-id>   forget a preference (tombstone)
  advisers export             export the ledger as JSON
  advisers brief <text>       print the IntentBrief for a request
  advisers policy check <text> policy/crisis check
  advisers office-read <file>  read DOCX/XLSX/PPTX structural text
  advisers office-edit <file> <ops.json> [out]  surgical Office edit
  advisers verify <file>       structural Office verification
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
  advisers template <weekly|budget|presentation|flow|mindmap> <data.json> <out>
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
  return `${process.env.ADVISERS_MODEL || 'deepseek-chat'} @ ${process.env.ADVISERS_BASE_URL || 'https://api.deepseek.com'}`
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
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      flags[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true
    } else positional.push(args[i])
  }
  return { flags, positional }
}

function activeMatterId(ledger, explicit) {
  if (explicit) return explicit
  try {
    const latest = dbStore()?.listSessions(1)[0]
    if (latest) return latest.matterId
  } catch {}
  return ledger.listMatters()[0]?.id ?? ledger.addMatter({ title: '默认事项' }).id
}

function printCommitments(ledger) {
  const rows = ledger.listCommitments()
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
    if (!c.dueAt || Date.parse(c.dueAt) > now + 86400_000) continue
    const dueDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(c.dueAt))
    let level = (Date.parse(c.dueAt) < now || dueDay === localDay) ? 'L2' : 'L1'
    if (level === 'L2' && Date.parse(c.dueAt) < now - 86400_000 && process.env.ADVISERS_ALLOW_L3 === '1') level = 'L3'
    const recent = store?.listCommitmentNudges(c.id, 3) ?? []
    if (recent.length === 3 && recent.every((n) => n.outcome === 'ignored') && level !== 'L1') level = level === 'L3' ? 'L2' : 'L1'
    if (level === 'L3' && store && store.countNudges(localDay, 'L3') >= 1) level = 'L2'
    if (level === 'L2' && store && store.countNudges(localDay, 'L2') >= 3) level = 'L1'
    const nudge = store?.addNudge({ localDay, level, commitmentId: c.id, body: c.action })
    if (store && !nudge) continue
    due.push({ ...c, level })
  }
  saveLedger(ledger)
  if (asJson) {
    console.log(JSON.stringify({ now: new Date(now).toISOString(), localDay, due }, null, 2))
    return
  }
  if (!due.length) { console.log('今天到期：无'); return }
  for (const c of due) console.log(`[${c.level}] ${Date.parse(c.dueAt) < now ? '逾期' : '今天到期'}：${c.action}（${c.dueAt}）`)
}

function printAudit() {
  const store = dbStore()
  if (!store) { console.log('audit requires SQLite store'); return }
  const verify = store.verifyAudit()
  console.log(`audit: ${verify.ok ? 'verified' : `BROKEN at seq ${verify.seq}`} (${verify.count ?? 0} entries)`)
  for (const row of store.listAudit(20)) {
    console.log(`${row.seq}\t${row.at.slice(0, 19)}\t${row.action}\t${row.allowed ? 'allow' : 'deny'}\t${row.reason ?? ''}`)
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

function printStatus() {
  const ledger = loadLedger()
  console.log(`home      ${HOME}`)
  console.log(`store     ${mode}${mode === 'sqlite' ? ` (${DB})` : ` (${STATE})`}`)
  console.log(`model     ${modelLabel()}`)
  console.log(`matters   ${ledger.listMatters().length}`)
  console.log(`prefs     ${ledger.listPreferences().length}`)
  console.log(`routines  ${ledger.listRoutines().length}`)
  console.log(`links     ${ledger.listLinks().length}`)
  try {
    const store = dbStore()
    console.log(`sessions  ${store?.listSessions(100).length ?? 0}`)
    console.log(`deliveries ${store?.countDeliveries() ?? 0}`)
  } catch {}
  console.log(`soul      ${existsSync(SOUL) ? 'present' : 'not initialized'}`)
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
          model: model || 'deepseek-chat',
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
  if (context.crisis && (context.crisis.tier === 'T1' || context.crisis.tier === 'T2')) {
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
    if (!intent?.questions?.length) console.log('[local] 未配置模型；已记录到事项账本。用 /office 或 advisors office 直接生成文件。')
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
    model: process.env.ADVISERS_MODEL || 'deepseek-chat',
    cwd: process.cwd(),
    force: process.env.ADVISERS_FORCE === '1',
    confirm,
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
    if (latest) printOpening(latest.conversationId)
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
      console.log('  /memory         what I remember')
      console.log('  /commit add <action> --quote <text> [--due ISO]')
      console.log('  /commit ls')
      console.log('  /done <id> --evidence <text>')
      console.log('  /search <text>  full-text search old turns')
      console.log('  /tick           due within 24h')
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
      const result = await undoLatest({ cwd: process.cwd(), backupDir: join(HOME, 'undo') })
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
      dbStore()?.appendAudit({ actor: 'local', action: 'correct', allowed: true, reason: feedback })
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
    console.error('usage: advisers why <pref-id>')
    process.exitCode = 1
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
  const ok = ledger.forget('preference', id)
  saveLedger(ledger)
  console.log(ok ? `forgotten: ${id}` : `unknown preference: ${id}`)
  if (!ok) process.exitCode = 1
}

function exportLedger() {
  console.log(JSON.stringify(loadLedger().toJSON(), null, 2))
}

function brief(text) {
  if (!text) {
    console.error('usage: advisers brief <text>')
    process.exitCode = 1
    return
  }
  const stage = process.env.ADVISERS_STAGE === 'trusted' ? 'trusted' : 'probation'
  const brief = core.buildIntentBrief(text, { stage })
  console.log(core.renderIntentBrief(brief))
  console.log('\n' + core.renderReadback(brief))
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
  const ext = outFile.split('.').pop()
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
    writeFileSync(outFile, mod.buildDrawio(spec)); console.log(`wrote ${outFile}`); return
  } else {
    writeFileSync(outFile, mod.buildMermaid(spec)); console.log(`wrote ${outFile}`); return
  }
  writeFileSync(outFile, buffer)
  console.log(result.ok ? `wrote ${outFile} (${buffer.length} bytes)` : `wrote ${outFile}, missing: ${result.missing.join(', ')}`)
  if (!result.ok) process.exitCode = 1
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
  const permitSecret = process.env.ADVISERS_PERMIT_SECRET
  const permitGate = permitSecret ? new core.PermitGate(permitSecret) : undefined
  const host = {
    async ingest(event) {
      const result = await runtime.ingest(event)
      if (result.accepted && runtime.lastContext) {
        const context = runtime.lastContext
        let reply
        const key = process.env.ADVISERS_API_KEY
        if (key && process.env.ADVISERS_NO_MODEL !== '1') {
          try {
            const { complete } = await import('../lib/model.js')
            reply = await complete({
              prompt: `${context.prompt}\n\n[user]\n${event.text ?? ''}`,
              apiKey: key,
              baseUrl: process.env.ADVISERS_BASE_URL || 'https://api.deepseek.com',
              model: process.env.ADVISERS_MODEL || 'deepseek-chat',
            })
          } catch (error) {
            reply = `模型调用失败：${error.message}`
          }
        } else {
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
        await link.send(message)
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
    writeFileSync(outFile, mod.buildMermaid(spec))
    console.log(`wrote ${outFile}`)
    return
  }
  if (kind === 'drawio') {
    writeFileSync(outFile, mod.buildDrawio(spec))
    console.log(`wrote ${outFile}`)
    return
  }
  const builder = kind === 'docx' ? mod.buildDocx : kind === 'xlsx' ? mod.buildXlsx : kind === 'xmind' ? mod.buildXmind : mod.buildPptx
  const buffer = await builder(spec)
  writeFileSync(outFile, buffer)
  const result = kind === 'xmind' ? await mod.validateXmind(buffer) : await mod.validateOffice(buffer, kind)
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
        'You are my adviser. Be direct, concise, and useful.\n' +
        'You are a guest in my life: private things stay private.\n' +
        'If you change this file, tell me.\n',
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
} else if (command === 'help' || command === '--help') {
  help()
} else if (command === 'chat') {
  await chat(args)
} else if (command === 'status') {
  printStatus()
} else if (command === 'history') {
  printHistory()
} else if (command === 'deliveries') {
  printDeliveries()
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
        creditor: flags.creditor ?? 'me',
        action,
        dueAt: flags.due,
        timezone: flags.tz ?? 'Asia/Shanghai',
        capability: flags.capability ?? 'todo',
        evidence: [{ sessionId: latestConversationId(), turnId: 'cli', quote: String(flags.quote) }],
      })
      saveLedger(ledger)
      console.log(`${c.id} open ${c.action}${c.dueAt ? ` due ${c.dueAt}` : ''}`)
    }
  } else if (sub === 'ls') printCommitments(ledger)
  else if (sub === 'snooze') {
    const id = positional[0]
    const hours = Number(positional[1] ?? 24)
    const c = ledger.listCommitments().find((x) => x.id === id)
    if (!c || !Number.isFinite(hours) || hours <= 0) { console.error('usage: advisers commit snooze <id> <hours>'); process.exitCode = 1 }
    else {
      c.status = 'snoozed'
      dbStore()?.setMeta(`snooze:${id}`, new Date(Date.now() + hours * 3600_000).toISOString())
      saveLedger(ledger)
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
    for (const row of await listBackups(join(HOME, 'undo'))) console.log(`${row.id}\t${row.path}\t${row.existed ? 'overwrite' : 'create'}`)
  } else {
    const result = await undoLatest({ cwd: process.cwd(), backupDir: join(HOME, 'undo') })
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
} else if (command === 'tick') {
  tick(loadLedger(), args.includes('--json'))
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
        if (candidate.kind === 'fact') ledger.remember({ ...candidate.payload, authority: 'user', evidence: candidate.evidence.map((e) => ({ quote: e.quote, turnId: e.turnId })) })
        else if (candidate.kind === 'preference') ledger.addPreference({ ...candidate.payload, evidence: candidate.evidence })
        else if (candidate.kind === 'commitment') ledger.addCommitment({ ...candidate.payload, matterId: candidate.payload.matterId ?? ledger.listMatters()[0]?.id, evidence: candidate.evidence.map((e) => ({ quote: e.quote, turnId: e.turnId })) })
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
      const rows = dbStore()?.searchMemory(q) ?? ledger.searchMemory(q)
      if (!rows.length) console.log('（没有匹配）')
      for (const r of rows) console.log(`${r.kind}\t${r.id}\t${r.text}${r.matterId ? `\t[${r.matterId}]` : ''}`)
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
    dbStore()?.appendAudit({ actor: 'local', action: 'correct', allowed: true, reason: statement })
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
  exportLedger()
} else if (command === 'brief') {
  brief(args.join(' ').trim())
} else if (command === 'policy') {
  const sub = args[0]
  if (sub === 'check') {
    const text = args.slice(1).join(' ').trim()
    if (!text) { console.error('usage: advisers policy check "<text>"'); process.exitCode = 1 }
    else {
      const crisis = new core.KeywordCrisisPolicy().scan(text)
      const pack = StrictPolicyPack ? new StrictPolicyPack() : undefined
      const decision = pack?.resolve({ use: 'understanding', crisis: crisis.tier === 'T1' || crisis.tier === 'T2' }) ?? { allowed: true, action: 'allow', code: 'ALLOW', reason: 'no pack' }
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
    else { writeFileSync(out, result.buffer); console.log(JSON.stringify({ ok: true, out, changes: result.changes }, null, 2)) }
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
      console.log(JSON.stringify(result, null, 2))
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
