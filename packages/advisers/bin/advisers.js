#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SqliteStore } from '../lib/sqlite.js'
import { runAgent } from '../lib/agent.js'

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

const [command, ...args] = process.argv.slice(2)

function help() {
  console.log(`advisers — a staff of AI advisers

Usage:
  advisers                    start the local conversation (TTY)
  advisers chat [text]        one-shot task, or start the local conversation
  advisers status             home/store/model/counts
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
  advisers template <weekly|budget|presentation|flow|mindmap> <data.json> <out>
                              build a template into docx/xlsx/pptx/mmd/drawio/xmind
  advisers link ls            list matter links
  advisers link add <from> <to> <type>
  advisers link confirm <id>
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
`)
}

let cliSeq = 0

function modelLabel() {
  if (!process.env.ADVISERS_API_KEY) return 'not configured (local mode)'
  if (process.env.ADVISERS_NO_MODEL === '1') return 'disabled (ADVISERS_NO_MODEL=1)'
  return `${process.env.ADVISERS_MODEL || 'deepseek-chat'} @ ${process.env.ADVISERS_BASE_URL || 'https://api.deepseek.com'}`
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
  console.log(`soul      ${existsSync(SOUL) ? 'present' : 'not initialized'}`)
}

async function runTurn({ runtime, ledger, text, conversationId, debug = false }) {
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
    if (!intent?.questions?.length) console.log('[local] 未配置模型；已记录到事项账本。用 /office 或 advisors office 直接生成文件。')
    return intent?.questions?.[0]
  }
  const { reply, artifacts, toolLog } = await runAgent({
    runtime,
    text,
    context,
    apiKey,
    baseUrl: process.env.ADVISERS_BASE_URL || 'https://api.deepseek.com',
    model: process.env.ADVISERS_MODEL || 'deepseek-chat',
    cwd: process.cwd(),
    onTool: (name) => { if (debug) console.log(`[tool] ${name}`) },
  })
  if (reply) console.log(reply)
  for (const file of [...new Set(artifacts)]) console.log(`[file] ${file}`)
  const failed = toolLog.filter((t) => !t.ok)
  if (failed.length && (debug || artifacts.length === 0)) console.log(`[warn] ${failed.length} 个工具调用失败，详见上一步输出`)
}

async function chat(text) {
  if (!text) {
    if (process.stdin.isTTY) { await repl(); return }
    console.error('usage: advisers chat <text>')
    process.exitCode = 1
    return
  }
  const ledger = loadLedger()
  const runtime = runtimeFor(ledger)
  await runTurn({ runtime, ledger, text, conversationId: 'local' })
  saveLedger(ledger)
}

async function repl() {
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 100 })
  const ledger = loadLedger()
  const runtime = runtimeFor(ledger)
  let conversationId = 'local'
  let debug = process.env.ADVISERS_DEBUG === '1'
  console.log('advisers · local')
  console.log(`model: ${modelLabel()}`)
  console.log(`home:  ${HOME}`)
  console.log('/help for commands, /quit to leave')
  for (;;) {
    let line
    try { line = await rl.question('› ') } catch { break }
    const text = line.trim()
    if (!text) continue
    if (text === '/quit' || text === '/exit') break
    if (text === '/help') {
      console.log('  /help           this help')
      console.log('  /status         home/store/model/counts')
      console.log('  /new            start a new conversation')
      console.log('  /brief <text>   print the IntentBrief without calling the model')
      console.log('  /debug          toggle full context')
      console.log('  /quit           leave')
      continue
    }
    if (text === '/status') { printStatus(); continue }
    if (text === '/new') { conversationId = `local_${Date.now()}`; console.log('new conversation'); continue }
    if (text === '/debug') { debug = !debug; console.log(`debug ${debug ? 'on' : 'off'}`); continue }
    if (text.startsWith('/brief ')) {
      const brief = runtime.brief(text.slice(7).trim())
      console.log(core.renderIntentBrief(brief))
      console.log(core.renderReadback(brief))
      continue
    }
    if (text.startsWith('/')) { console.log(`unknown command: ${text}; /help`); continue }
    try {
      const question = await runTurn({ runtime, ledger, text, conversationId, debug })
      saveLedger(ledger)
      if (question) {
        let answer
        try { answer = await rl.question('? ') } catch { break }
        if (answer.trim()) {
          await runTurn({ runtime, ledger, text: `${text}\n补充：${answer.trim()}`, conversationId, debug })
          saveLedger(ledger)
        }
      }
    } catch (error) {
      console.error(`error: ${error.message}`)
    }
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
  if (sub === 'apply' || sub === 'reject') {
    if (!arg) {
      console.error(`usage: advisers routine ${sub} <patch-id>`)
      process.exitCode = 1
      return
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
  await chat(args.join(' ').trim())
} else if (command === 'status') {
  printStatus()
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
