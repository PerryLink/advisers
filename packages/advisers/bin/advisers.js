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
import { buildHistory, buildOpening, shouldSummarize, summarizeTurns } from '../lib/context-window.js'

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
  return createAdvisers({ ledger, ports, seen: mode === 'sqlite' ? openStore().seenStore() : undefined })
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
  advisers deliveries         recent generated files
  advisers ls                 list matters
  advisers why <pref-id>      explain a preference
  advisers forget <pref-id>   forget a preference (tombstone)
  advisers export             export the ledger as JSON
  advisers brief <text>       print the IntentBrief for a request
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

function learnPreference(ledger, statement, quote) {
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
    source: { type: 'inferred', quote },
    confidence: 0.5,
    status: 'candidate',
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

async function maybeSummarize(conversationId, { apiKey, baseUrl, model } = {}) {
  try {
    const store = dbStore()
    if (!store) return
    const turns = store.listTurns(conversationId, 200)
    const old = store.getSessionSummary(conversationId)
    if (!shouldSummarize(turns, old?.throughSeq ?? 0, 10)) return
    const fresh = turns.filter((t) => t.seq > (old?.throughSeq ?? 0))
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
    store.upsertSessionSummary({ conversationId, summary, throughSeq: turns.at(-1).seq })
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

async function runTurn({ runtime, ledger, text, conversationId, debug = false, confirm, attachments = [] }) {
  const result = await runtime.ingest({
    linkId: 'cli',
    accountId: 'local',
    conversationId,
    messageId: `cli_${Date.now()}_${++cliSeq}`,
    sender: { id: 'local' },
    text,
    timestamp: now(),
  })
  if (!result.accepted) {
    console.log(`[ignored: ${result.reason}]`)
    return
  }
  const context = runtime.lastContext
  if (!context) throw new Error('runtime did not produce a context')
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
    await maybeSummarize(conversationId, { apiKey, baseUrl: process.env.ADVISERS_BASE_URL, model: process.env.ADVISERS_MODEL })
    if (!intent?.questions?.length) console.log('[local] 未配置模型；已记录到事项账本。用 /office 或 advisors office 直接生成文件。')
    return intent?.questions?.[0]
  }
  const history = loadHistory(conversationId)
  const { reply, artifacts, toolLog } = await runAgent({
    runtime,
    text: agentText,
    history: history.turns,
    summary: history.summary,
    ledger,
    context,
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
  await maybeSummarize(conversationId, { apiKey, baseUrl: process.env.ADVISERS_BASE_URL, model: process.env.ADVISERS_MODEL })
  if (reply) console.log(reply)
  for (const file of [...new Set(artifacts)]) console.log(`[file] ${file}`)
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
  const candidate = buildRoutineCandidate({ text, toolLog })
  if (candidate && !ledger.listRoutines().some((r) => r.name === candidate.name)) {
    try {
      const routine = ledger.addRoutine(candidate)
      console.log(`[routine] draft ${routine.id} (${routine.steps.length} steps); approve with \`advisers routine approve ${routine.id}\``)
      saveLedger(ledger)
    } catch {}
  }
  const failed = toolLog.filter((t) => !t.ok)
  if (failed.length && (debug || artifacts.length === 0)) console.log(`[warn] ${failed.length} 个工具调用失败，详见上一步输出`)
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
  console.log(`model: ${modelLabel()}`)
  console.log(`home:  ${HOME}`)
  try {
    const latest = dbStore()?.listSessions(1)[0]
    if (latest) {
      console.log(`resume: ${latest.title} [${latest.conversationId}]`)
      printOpening(latest.conversationId)
    }
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
    try {
      const question = await runTurn({ runtime, ledger, text: taskText, conversationId, debug, confirm, attachments: files })
      saveLedger(ledger)
      lastTask = { text: taskText, files: [...files] }
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
      console.error(`error: ${error.message}`)
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
      console.log(`[learn] ${result.preference.id} conf=${result.preference.confidence.toFixed(2)} ${result.promoted ? '(promoted to confirmed)' : '(candidate; repeat to promote)'}`)
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
      const result = learnPreference(ledger, feedback, text)
      dbStore()?.appendAudit({ actor: 'local', action: 'correct', allowed: true, reason: feedback })
      saveLedger(ledger)
      console.log(`[learn] ${result.preference.id} conf=${result.preference.confidence.toFixed(2)} ${result.promoted ? '(confirmed)' : '(candidate; repeat to promote)'}`)
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
      const check = checkRoutine(routine)
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
  const names = ['weekly', 'budget', 'presentation', 'flow', 'mindmap']
  if (!names.includes(name) || !dataFile || !outFile) {
    console.error('usage: advisers template <weekly|budget|presentation|flow|mindmap> <data.json> <out>')
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
        await link.send({
          conversationId: event.conversationId,
          threadId: event.threadId,
          replyTo: event.messageId,
          text: reply,
          idempotencyKey: event.dedupeKey ?? event.messageId,
        })
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
    const result = learnPreference(ledger, statement, statement)
    dbStore()?.appendAudit({ actor: 'local', action: 'correct', allowed: true, reason: statement })
    saveLedger(ledger)
    console.log(`[learn] ${result.preference.id} conf=${result.preference.confidence.toFixed(2)}${result.promoted ? ' confirmed' : ' candidate'}`)
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
