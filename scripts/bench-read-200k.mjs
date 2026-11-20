#!/usr/bin/env node
/**
 * scripts/bench-read-200k.mjs - reproducible 200k-ledger read benchmark (0.3.0 P0-T1/T2).
 *
 * Developer/operator tool, not a CI gate. It seeds the same synthetic 200k ledger
 * shape the 0.3 performance research used (facts 200k / commitments 100k /
 * preferences 20k / deliveries 10k / model_calls 10k / sessions 20; no turns), then
 * measures the read commands that the 0.3.0 targets name plus the MCP read surface:
 *
 *   status / today / today --json / today --json --limit 100/50 / remind / remind --json / tui --once /
 *   digest / digest week / pet-brief / pet-brief --json
 *   mcp: initialize + first advisers_today / advisers_commit_ls / advisers_remind
 *
 * Two numbers per scenario:
 *  - wall: fresh CLI child process, median of --reps (includes Node startup; this is
 *    the docs/PERFORMANCE.md measurement method);
 *  - writeBytes: the child's storage-write count from /proc/<pid>/io (Linux, max
 *    sample), i.e. SQLite temp spill + WAL, not stdout. The T1 acceptance metric.
 *
 * Usage:
 *   node scripts/bench-read-200k.mjs --home /tmp/advisers-bench          # seed + run
 *   node scripts/bench-read-200k.mjs --home /tmp/advisers-bench --seed   # seed only
 *   node scripts/bench-read-200k.mjs --home /tmp/advisers-bench --bin /tmp/base/packages/advisers/bin/advisers.js
 *   node scripts/bench-read-200k.mjs --home /tmp/advisers-bench --json > bench.json
 *
 * Seeding uses direct prepared INSERTs (the Ledger.remember() generator is O(N^2) at
 * this size and takes minutes). Run it from a local ext4/tmp checkout: a 9p/network
 * mount inflates every read and makes the numbers incomparable.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_BIN = join(ROOT, 'packages', 'advisers', 'bin', 'advisers.js')
const SQLITE = join(ROOT, 'packages', 'advisers', 'lib', 'sqlite.js')

const READ_SCENARIOS = [
  ['status', ['status', '--json']],
  ['today', ['today']],
  ['today --json', ['today', '--json']],
  ['today --json --limit 100', ['today', '--json', '--limit', '100']],
  ['today --json --limit 50', ['today', '--json', '--limit', '50']],
  ['remind', ['remind']],
  ['remind --json', ['remind', '--json']],
  ['tui --once', ['tui', '--once']],
  ['digest day', ['digest', 'day']],
  ['digest week', ['digest', 'week']],
  ['pet-brief', ['pet-brief']],
  ['pet-brief --json', ['pet-brief', '--json']],
]

function usage() {
  console.log([
    'advisers 200k read benchmark',
    '',
    'Usage: node scripts/bench-read-200k.mjs --home DIR [options]',
    '',
    '  --home DIR    data home to seed / reuse (default: a fresh /tmp dir)',
    '  --bin PATH    CLI entry to measure (default: this checkout)',
    '  --reps N      child-process repetitions per scenario (default 3)',
    '  --only LIST   comma-separated scenario names to run (default all)',
    '  --seed        (re)generate the 200k ledger and exit',
    '  --json        print machine-readable JSON',
    '  --no-mcp      skip the MCP section',
    '  --help        show this help',
  ].join('\n'))
}

function parseArgs(argv) {
  const options = { home: undefined, bin: DEFAULT_BIN, reps: 3, seedOnly: false, json: false, mcp: true, only: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(arg + ' needs a value')
      return value
    }
    if (arg === '--help' || arg === '-h') return { help: true }
    else if (arg === '--home') options.home = next()
    else if (arg === '--bin') options.bin = resolve(next())
    else if (arg === '--reps') options.reps = Number(next())
    else if (arg === '--only') options.only = next().split(',').map((name) => name.trim()).filter(Boolean)
    else if (arg === '--seed') options.seedOnly = true
    else if (arg === '--json') options.json = true
    else if (arg === '--no-mcp') options.mcp = false
    else throw new Error('unknown option: ' + arg)
  }
  if (!Number.isFinite(options.reps) || options.reps < 1) throw new Error('--reps must be >= 1')
  return options
}

const NAMES = (() => {
  const surnames = '王李张刘陈杨黄赵周吴徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'
  const roles = ['工', '总', '经理', '老师', '主任', '律师']
  return [...surnames].map((surname, i) => surname + roles[i % roles.length])
})()
const GENERIC = ['客户', '团队', '甲方', '乙方', '供应商', '财务', '法务']
const who = (i) => NAMES[i % NAMES.length]
const creditorOf = (i) => (i % 7 === 0 ? GENERIC[i % GENERIC.length] : who(i))

const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString()

/** Seed the 200k ledger shape into home/state.db and seed TOS acceptance. */
async function seedHome(home) {
  mkdirSync(home, { recursive: true })
  const db = join(home, 'state.db')
  for (const suffix of ['', '-wal', '-shm']) rmSync(db + suffix, { force: true })
  const { SqliteStore } = await import(pathToFileURL(SQLITE).href)
  const store = new SqliteStore(db)
  const now = Date.now()
  const startedAt = Date.now()
  let inserted = 0
  try {
    const matter = store.db.prepare('INSERT INTO matters(id,title,status,domain,secrecy,summary,participants,deadlines,open_questions,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    const fact = store.db.prepare('INSERT INTO facts(id,matter_id,subject,predicate,object,recorded_at,authority,confidence,source,status,evidence) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    const commitment = store.db.prepare('INSERT INTO commitments(id,matter_id,debtor,creditor,action,due_at,timezone,status,evidence,capability,done_at,reminder_offsets) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    const preference = store.db.prepare('INSERT INTO preferences(id,kind,statement,scope,source,evidence,confidence,status,valid_from,last_confirmed,expires_at,priority) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    const session = store.db.prepare('INSERT INTO sessions(conversation_id,matter_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
    const delivery = store.db.prepare('INSERT INTO deliveries(id,matter_id,conversation_id,files,tool,title,validation,created_at) VALUES(?,?,?,?,?,?,?,?)')
    const modelCall = store.db.prepare('INSERT INTO model_calls(id,conversation_id,matter_id,task,model,status,thinking,attempts,prompt_tokens,completion_tokens,reasoning_tokens,cached_tokens,total_tokens,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    store.db.exec('BEGIN')
    try {
      for (let i = 0; i < 20; i++) {
        matter.run('matter_bench_' + i, '客户项目-' + i, 'active', 'consulting', 0, 'benchmark matter ' + i,
          JSON.stringify([who(i), who(i + 1), who(i + 2)]), '[]', '[]', iso(now - i * DAY), iso(now - i * 1000))
      }
      // facts: 200k rows, 133,333 confirmed (the rest candidates).
      for (let i = 0; i < 200_000; i++) {
        const status = i % 3 === 0 ? 'candidate' : 'confirmed'
        fact.run('fact_bench_' + i, 'matter_bench_' + (i % 20), who(i) + '的议题' + (i % 500),
          ['stated', 'prefers', 'deadline'][i % 3], '第' + i + '条：' + creditorOf(i) + '希望' + (i % 7 + 1) + '月前给出报价单',
          iso(now - i * 1000), 'user', 0.6 + (i % 40) / 100, null, status,
          JSON.stringify([{ quote: '甲方要求第' + i + '条按期交付' }]))
        inserted++
      }
      // commitments: 100k rows, 66,667 open. Open due distribution mirrors a real
      // ledger: 10% no due, 20% overdue (0-30d), 40% due within 7 days, 30% later.
      for (let i = 0; i < 100_000; i++) {
        const done = i >= 66_667
        let due = null
        if (!done) {
          const bucket = i % 100
          if (bucket < 10) due = null
          else if (bucket < 30) due = iso(now - ((i % 30) + 1) * DAY + (i % 24) * 3_600_000)
          else if (bucket < 70) due = iso(now + (i % 7) * DAY + (i % 24) * 3_600_000)
          else due = iso(now + 8 * DAY + (i % 52) * DAY + (i % 24) * 3_600_000)
        } else due = iso(now + (i % 60) * DAY)
        commitment.run('cm_bench_' + i, 'matter_bench_' + (i % 20), i % 3 === 0 ? 'third:' + who(i) : 'user',
          creditorOf(i), '发送第' + i + '版报价单', due, 'Asia/Shanghai', done ? 'done' : 'open',
          JSON.stringify([{ quote: '承诺第' + i + '条' }]), 'todo',
          done ? iso(now - (i % 30) * DAY - (i % 24) * 3_600_000) : null,
          i % 50 === 0 ? JSON.stringify(['-1d', '-1h']) : null)
        inserted++
      }
      for (let i = 0; i < 20_000; i++) {
        preference.run('pref_bench_' + i, 'preference', '偏好' + i + '：报价单先给总价再列明细',
          '{"level":"global"}', '{"type":"user_explicit"}', '[]', 0.9, 'confirmed',
          iso(now - i * 1000), null, null, 'soft')
        inserted++
      }
      for (let i = 0; i < 20; i++) {
        session.run('conv-bench-' + i, 'matter_bench_' + i, '会话' + i, iso(now - i * DAY), iso(now - i * 1000))
      }
      for (let i = 0; i < 10_000; i++) {
        delivery.run('del_bench_' + i, 'matter_bench_' + (i % 20), 'conv-bench-' + (i % 20),
          '["out/deliv.docx"]', 'deliver:docx', '交付' + i, 'ok', iso(now - (i % 30) * DAY - (i % 24) * 3_600_000))
        inserted++
      }
      for (let i = 0; i < 10_000; i++) {
        modelCall.run('mc_bench_' + i, 'conv-bench-' + (i % 20), 'matter_bench_' + (i % 20), 'chat',
          'deepseek-chat', 'ok', 0, 1, 100, 50, 0, 0, 150, 1200, iso(now - i * 1000))
        inserted++
      }
      store.db.exec('COMMIT')
    } catch (error) {
      try { store.db.exec('ROLLBACK') } catch {}
      throw error
    }
    store.close()
  } finally {
    try { store.close() } catch {}
  }
  seedTos(home)
  return { db, inserted, seconds: (Date.now() - startedAt) / 1000 }
}

/** Seed HOME/tos.json from the packaged manifest (the gate stays inert). */
function seedTos(home) {
  const manifestPath = join(ROOT, 'packages', 'advisers', 'lib', 'tos', 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entry = (manifest.files ?? []).find((file) => file.source === manifest.canonical) ?? (manifest.files ?? [])[0]
  if (!entry?.sha256) throw new Error('packaged TOS manifest is missing the canonical file hash')
  writeFileSync(join(home, 'tos.json'), JSON.stringify({
    version: manifest.version, sha256: entry.sha256, acceptedAt: '2026-11-20T00:00:00.000Z',
    channel: 'interactive', nonInteractive: false,
  }) + '\n', { mode: 0o600 })
}

function benchEnv(home) {
  return { ...process.env, ADVISERS_HOME: home, ADVISERS_ACCEPT_TOS: '1', ADVISERS_CORE_LOCAL: '1', ADVISERS_STORE: 'sqlite', ADVISERS_NO_MODEL: '1' }
}

/** Max sample of /proc/<pid>/io write_bytes while the child runs (Linux only). */
function ioPoller(pid) {
  if (process.platform !== 'linux') return { stop: () => null }
  let max = null
  const read = () => {
    try {
      const text = readFileSync('/proc/' + pid + '/io', 'utf8')
      const match = /write_bytes:\s*(\d+)/.exec(text)
      if (match) { const value = Number(match[1]); if (max === null || value > max) max = value }
    } catch {}
  }
  read()
  const timer = setInterval(read, 2)
  return { stop: () => { clearInterval(timer); read(); return max } }
}

/** Run one CLI invocation in a fresh child process; median wall over reps. */
function runCli(bin, home, args, reps) {
  const walls = []
  let writeBytes = null
  let stdoutBytes = 0
  let exitCode = null
  let stderr = ''
  for (let rep = 0; rep < reps; rep++) {
    const startedAt = process.hrtime.bigint()
    const child = spawnSync(process.execPath, [bin, ...args], {
      env: benchEnv(home), encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    })
    walls.push(Number(process.hrtime.bigint() - startedAt) / 1e6)
    stdoutBytes = Buffer.byteLength(child.stdout ?? '')
    exitCode = child.status
    stderr = String(child.stderr ?? '').slice(0, 500)
  }
  walls.sort((a, b) => a - b)
  const wallMinMs = walls[0]
  if (process.platform === 'linux') {
    // One more run just for the write-byte sample: poll /proc/<pid>/io.
    const child = spawn(process.execPath, [bin, ...args], { env: benchEnv(home), stdio: ['ignore', 'ignore', 'ignore'] })
    const poller = ioPoller(child.pid)
    const wait = new Promise((resolveWait) => child.once('exit', resolveWait))
    // eslint-disable-next-line no-unused-expressions
    const done = poller.stop
    return wait.then(() => ({ wallMs: median(walls), wallMinMs, writeBytes: done(), stdoutBytes, exitCode, stderr }))
  }
  return Promise.resolve({ wallMs: median(walls), wallMinMs, writeBytes, stdoutBytes, exitCode, stderr })
}

/** Measure the MCP stdio surface: init + first read-tool calls. */
function runMcp(bin, home) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [bin, 'mcp', '--stdio'], { env: benchEnv(home), stdio: ['pipe', 'pipe', 'pipe'] })
    const pending = []
    let buffer = ''
    let startedAt = process.hrtime.bigint()
    const requests = [
      { key: 'initialize', message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'bench', version: '0' } } } },
      { key: 'tools/call today', message: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'advisers_today', arguments: {} } } },
      { key: 'tools/call commit_ls', message: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'advisers_commit_ls', arguments: {} } } },
      { key: 'tools/call remind', message: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'advisers_remind', arguments: {} } } },
    ]
    const results = []
    let current = null
    const send = () => {
      current = requests.shift()
      if (!current) { try { child.kill('SIGTERM') } catch {} ; return }
      startedAt = process.hrtime.bigint()
      child.stdin.write(JSON.stringify(current.message) + '\n')
    }
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
        let parsed = null
        try { parsed = JSON.parse(line) } catch {}
        const text = parsed?.result?.content?.[0]?.text ?? ''
        results.push({ call: current?.key, ms: Math.round(elapsedMs * 10) / 10, textBytes: Buffer.byteLength(text), isError: parsed?.result?.isError === true, protocolVersion: parsed?.result?.protocolVersion, code: parsed?.error?.code })
        send()
      }
    })
    const finish = () => resolvePromise(results)
    const timeout = setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; finish() }, 60_000)
    child.once('exit', () => { clearTimeout(timeout); setTimeout(finish, 20) })
    child.once('error', () => { clearTimeout(timeout); finish() })
    send()
  })
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { usage(); return }
  const home = options.home ? resolve(options.home) : mkdtempSync(join(tmpdir(), 'advisers-bench-200k-'))
  const db = join(home, 'state.db')
  const report = { home, bin: options.bin, reps: options.reps, seededAt: null, seedSeconds: null, scenarios: [], mcp: [] }
  if (!existsSync(db) || options.seedOnly) {
    const seeded = await seedHome(home)
    report.seededAt = new Date().toISOString()
    report.seedSeconds = Math.round(seeded.seconds * 10) / 10
    if (!options.json) console.error('seeded ' + seeded.inserted + ' rows into ' + home + ' (' + report.seedSeconds + 's)')
  }
  if (options.seedOnly) { if (options.json) console.log(JSON.stringify(report, null, 2)); return }
  const scenarios = options.only ? READ_SCENARIOS.filter(([name]) => options.only.includes(name)) : READ_SCENARIOS
  if (options.only && scenarios.length === 0) throw new Error('--only matched no scenario; names: ' + READ_SCENARIOS.map(([name]) => name).join(', '))
  for (const [name, args] of scenarios) {
    const result = await runCli(options.bin, home, args, options.reps)
    report.scenarios.push({ scenario: name, args, ...result })
    if (!options.json) console.log(name.padEnd(18) + String(result.wallMs.toFixed(1)).padStart(8) + ' ms med' + String(result.wallMinMs.toFixed(1)).padStart(8) + ' ms min' + String(result.writeBytes ?? '-').padStart(12) + ' B write' + String(result.stdoutBytes).padStart(10) + ' B out' + (result.exitCode === 0 ? '' : '  EXIT ' + result.exitCode + ' ' + result.stderr))
  }
  if (options.mcp) {
    report.mcp = await runMcp(options.bin, home)
    if (!options.json) for (const call of report.mcp) console.log(('mcp ' + call.call).padEnd(28) + String(call.ms).padStart(8) + ' ms' + String(call.textBytes).padStart(8) + ' B text' + (call.isError ? '  isError' : '') + (call.protocolVersion ? '  protocol ' + call.protocolVersion : ''))
  }
  if (options.json) console.log(JSON.stringify(report, null, 2))
  else console.log('\nnote: medians of ' + options.reps + ' fresh CLI children; wall includes Node startup; writeBytes is the max /proc/<pid>/io sample (SQLite temp spill + WAL, not stdout).')
}

main().catch((error) => { console.error(error?.stack ?? String(error)); process.exit(1) })

