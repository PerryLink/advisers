#!/usr/bin/env node
/**
 * scripts/bench.mjs - reproducible performance benchmark for the Advisers CLI.
 *
 * Developer/operator tool, not a CI gate: prints medians and peak RSS for the
 * hot paths pinned by the 2026-11-17 performance audit so a before/after
 * change can be measured on the same machine.
 *
 *   node scripts/bench.mjs                         # 1k synthetic ledger, 5 reps
 *   node scripts/bench.mjs --scale 50000 --reps 3  # the audit's n50k ledger
 *   node scripts/bench.mjs --home /tmp/my-advisers-home
 *   node scripts/bench.mjs --json > bench.json
 *   node scripts/bench.mjs --bin /tmp/base/packages/advisers/bin/advisers.js
 *
 * Measures: --version/--help/status startup, today, tick, deliver --format pdf,
 * deliveries --pack, and the in-process PDF wrap()/buildSimplePdf() path. Each
 * CLI rep runs in a fresh child process; mutating commands copy the data
 * directory first. Peak RSS comes from the child's
 * process.resourceUsage().maxRSS. Run from a local ext4/tmp checkout: a
 * network/9p mount inflates every file read.
 *
 * Consent fixture: the CLI gates non-exempt commands on a recorded TOS
 * acceptance (non-TTY runs exit 3 without one). The benchmark seeds the
 * acceptance record into the prepared data home once (equivalent to a user
 * accepting on first run) and also passes ADVISERS_ACCEPT_TOS=1, so today /
 * tick / deliveries --pack measure the real paths instead of the gate.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_BIN = join(ROOT, 'packages', 'advisers', 'bin', 'advisers.js')
const CORE = join(ROOT, 'packages', 'core', 'dist', 'index.js')
const STORE = join(ROOT, 'packages', 'advisers', 'lib', 'sqlite.js')
const PDF = join(ROOT, 'packages', 'advisers', 'lib', 'pdf.js')
const OFFICE = join(ROOT, 'packages', 'office', 'dist', 'index.js')

function usage() {
  console.log([
    'advisers benchmark',
    '',
    'Usage: node scripts/bench.mjs [options]',
    '',
    '  --scale N     synthetic ledger size (facts; commitments=N/2, turns=N), default 1000',
    '  --reps N      repetitions per CLI scenario, default 5',
    '  --home DIR    reuse an existing ADVISERS_HOME instead of generating one',
    '  --bin PATH    CLI entry to measure, default packages/advisers/bin/advisers.js',
    '  --json        print machine-readable JSON instead of a table',
    '  --keep        keep the generated data directory',
    '  --help        show this help',
    '',
    'Example:',
    '  pnpm -r build',
    '  node scripts/bench.mjs --scale 50000 --reps 3 --json',
  ].join('\n'))
}

function parseArgs(argv) {
  const options = { scale: 1000, reps: 5, home: undefined, bin: DEFAULT_BIN, json: false, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(arg + ' needs a value')
      return value
    }
    if (arg === '--help' || arg === '-h') return { help: true }
    else if (arg === '--scale') options.scale = Number(next())
    else if (arg === '--reps') options.reps = Number(next())
    else if (arg === '--home') options.home = next()
    else if (arg === '--bin') options.bin = next()
    else if (arg === '--json') options.json = true
    else if (arg === '--keep') options.keep = true
    else throw new Error('unknown option: ' + arg)
  }
  if (!Number.isFinite(options.scale) || options.scale < 10) throw new Error('--scale must be a number >= 10')
  if (!Number.isFinite(options.reps) || options.reps < 1) throw new Error('--reps must be a number >= 1')
  return options
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function mb(kilobytes) {
  return +(kilobytes / 1024).toFixed(1)
}

function removeTree(path) {
  try { rmSync(path, { recursive: true, force: true }) } catch {}
}

/** Copy a data directory (state.db + sidecars + keys) into a throwaway home. */
function copyHome(source, target) {
  mkdirSync(target, { recursive: true })
  cpSync(source, target, { recursive: true })
}

function childLoader() {
  // The child imports the CLI (which runs the command and resolves when the
  // command finishes), then reports its own peak RSS. bin/advisers.js only
  // calls process.exit() for office/template, which are not measured here.
  return [
    "import { pathToFileURL } from 'node:url'",
    'const [bin, ...args] = process.argv.slice(2)',
    'process.argv = [process.argv[0], bin, ...args]',
    'try {',
    '  await import(pathToFileURL(bin).href)',
    '} finally {',
    '  const usage = process.resourceUsage()',
    "  process.stderr.write('\\n__ADVISERS_BENCH__' + JSON.stringify({ rssKb: usage.maxRSS, exitCode: process.exitCode ?? 0 }) + '\\n')",
    '}',
  ].join('\n')
}

const MARKER = '__ADVISERS_BENCH__'

function baseEnv(home) {
  return {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: existsSync(OFFICE) ? '1' : '0',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_STORE: 'sqlite',
    // Fallback for homes the benchmark did not seed itself (e.g. a --home that
    // cannot be copied): an explicit environment acceptance is recorded by the
    // CLI exactly like typing it on first run, it is not a silent bypass.
    ADVISERS_ACCEPT_TOS: '1',
  }
}

/**
 * Record a TOS acceptance in a throwaway benchmark home so the gated scenarios
 * measure their own work. Uses the CLI's documented non-interactive path
 * (tos accept --accept-tos), so the record is the same one a real user would
 * have. Best-effort: on failure the ADVISERS_ACCEPT_TOS env fallback still lets
 * the benchmark run.
 */
function seedTosAcceptance(bin, home) {
  const result = spawnSync(process.execPath, [bin, 'tos', 'accept', '--accept-tos'], {
    cwd: ROOT,
    env: baseEnv(home),
    encoding: 'utf8',
    timeout: 60000,
  })
  return result.status === 0
}

/** Run the CLI once in a child process and measure wall time + peak RSS. */
function runCli({ bin, loaderPath, home, args, cwd }) {
  const startedAt = process.hrtime.bigint()
  const result = spawnSync(process.execPath, [loaderPath, bin, ...args], {
    cwd,
    env: baseEnv(home),
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  const stderrLines = String(result.stderr ?? '').split(/\r?\n/)
  const marker = stderrLines.find((line) => line.startsWith(MARKER))
  const metrics = marker ? JSON.parse(marker.slice(MARKER.length)) : { rssKb: 0, exitCode: result.status }
  const stderr = stderrLines.filter((line) => line && !line.startsWith(MARKER)).join('\n')
  return {
    wallMs,
    rssMb: mb(metrics.rssKb),
    exitCode: result.status ?? metrics.exitCode ?? 0,
    stdout: String(result.stdout ?? '').slice(0, 200),
    stderr: stderr.slice(0, 300),
  }
}

/** Synthetic ledger scaled like the performance audit n1k/n10k/n50k sets. */
async function generateData(home, scale) {
  const { Ledger } = await import(pathToFileURL(CORE).href)
  const { SqliteStore } = await import(pathToFileURL(STORE).href)
  const db = join(home, 'state.db')
  const ledger = new Ledger()
  const matters = []
  for (let i = 0; i < 20; i++) matters.push(ledger.addMatter({ title: '客户项目-' + i, domain: 'consulting' }))
  for (let i = 0; i < scale; i++) {
    ledger.remember({
      subject: '客户' + (i % 20) + '-议题' + i,
      predicate: 'stated',
      object: '第' + i + '条：甲方要求' + (i % 7 + 1) + '月' + (i % 28 + 1) + '日前提交' + ['报价单', '方案', '周报', '合同', '验收单'][i % 5] + '，联系人王工' + i,
      matterId: matters[i % 20].id,
      authority: 'user',
      evidence: [{ quote: '甲方要求第' + i + '条按期交付', turnId: 't' + i, sessionId: 's1' }],
    })
  }
  for (let i = 0; i < Math.max(10, Math.floor(scale / 10)); i++) {
    ledger.addPreference({ kind: 'style', statement: '偏好' + i + '：报价单先给总价再列明细' + i, evidence: [{ quote: '偏好' + i, turnId: 't' + i }] })
  }
  const due = Date.now()
  for (let i = 0; i < Math.max(10, Math.floor(scale / 2)); i++) {
    ledger.addCommitment({
      matterId: matters[i % 20].id,
      debtor: i % 3 === 0 ? 'user' : i % 3 === 1 ? 'third:王工' : 'agent',
      creditor: ['王工', '李总', '张经理'][i % 3],
      action: '发送第' + i + '版交付物',
      dueAt: new Date(due + ((i % 30) - 10) * 86400000).toISOString(),
      evidence: [{ quote: '承诺第' + i + '条', turnId: 't' + i, sessionId: 's1' }],
    })
  }
  const store = new SqliteStore(db)
  try {
    store.save(ledger.toJSON())
    store.db.exec('BEGIN')
    for (let i = 0; i < scale; i++) {
      store.addTurn({ conversationId: 'conv-' + (i % 20), role: i % 2 ? 'assistant' : 'user', content: '第' + i + '轮对话：客户王工要求本周五前提交报价单，包含人力单价与总价；已确认会后发送。' + (i % 5 === 0 ? '另需准备验收单模板。' : '') })
    }
    store.db.exec('COMMIT')
    for (let i = 0; i < 20; i++) store.upsertSession({ conversationId: 'conv-' + i, matterId: matters[i].id, title: '会话' + i })
    store.db.exec('BEGIN')
    for (let i = 0; i < Math.max(20, Math.floor(scale / 20)); i++) {
      store.addDelivery({ matterId: matters[i % 20].id, conversationId: 'conv-' + (i % 20), files: [join(home, 'out', 'deliv-' + i + '.docx')], tool: 'office', title: '交付' + i, validation: 'ok' })
      store.addModelCall({ conversationId: 'conv-' + (i % 20), matterId: matters[i % 20].id, task: 'chat', model: 'deepseek-chat', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, durationMs: 1200 })
    }
    store.db.exec('COMMIT')
  } finally {
    store.close()
  }
}

/** Resolve a dependency of packages/advisers from this root-level script. */
async function resolvePackage(specifier) {
  const { createRequire } = await import('node:module')
  const require = createRequire(join(ROOT, 'packages', 'advisers', 'package.json'))
  return pathToFileURL(require.resolve(specifier)).href
}

/** In-process PDF wrap() / buildSimplePdf() benchmark (no child process). */
async function benchPdf(reps) {
  const pdf = await import(pathToFileURL(PDF).href)
  const { buildSimplePdf, findCjkFont, wrapToWidth } = pdf
  const { PDFDocument } = await import(await resolvePackage('pdf-lib'))
  const fontkit = (await import(await resolvePackage('@pdf-lib/fontkit'))).default
  const fontPath = findCjkFont()
  const rows = []
  if (!fontPath) {
    rows.push({ name: 'pdf wrap (1000 lines)', skipped: 'no CJK font on this host (set ADVISERS_PDF_FONT)' })
    rows.push({ name: 'pdf build (1000 paragraphs)', skipped: 'no CJK font on this host' })
    return rows
  }
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(readFileSync(fontPath), { subset: true })
  const paragraphs = []
  for (let i = 0; i < 1000; i++) paragraphs.push('cm_' + i + '  王工 · 发送第' + i + '版交付物 · 截止 2026-11-2' + (i % 10) + ' · open · 附上人力单价与总价明细')
  const wrapTimes = []
  if (typeof wrapToWidth === 'function') {
    for (let rep = 0; rep < reps; rep++) {
      const startedAt = process.hrtime.bigint()
      for (const paragraph of paragraphs) wrapToWidth(paragraph, font, 10.5, 499)
      wrapTimes.push(Number(process.hrtime.bigint() - startedAt) / 1e6)
    }
  }
  const fixed = new Date('2026-11-17T00:00:00Z')
  const buildTimes = []
  let bytes = 0
  for (let rep = 0; rep < reps; rep++) {
    const startedAt = process.hrtime.bigint()
    const buffer = await buildSimplePdf({ title: '性能基准 · Advisers', paragraphs, createdAt: fixed })
    buildTimes.push(Number(process.hrtime.bigint() - startedAt) / 1e6)
    bytes = buffer.length
  }
  const pdfRssMb = mb(process.resourceUsage().maxRSS)
  if (wrapTimes.length) rows.push({ name: 'pdf wrap (1000 lines)', medianMs: +median(wrapTimes).toFixed(2), minMs: +Math.min(...wrapTimes).toFixed(2), maxMs: +Math.max(...wrapTimes).toFixed(2), maxRssMb: pdfRssMb, note: fontPath.split(/[\\/]/).pop() })
  else rows.push({ name: 'pdf wrap (1000 lines)', skipped: 'wrapToWidth export not in this build (pre-P1-5); see build row' })
  rows.push({ name: 'pdf build (1000 paragraphs)', medianMs: Math.round(median(buildTimes)), minMs: Math.round(Math.min(...buildTimes)), maxMs: Math.round(Math.max(...buildTimes)), maxRssMb: pdfRssMb, note: bytes + ' bytes' })
  return rows
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { usage(); return }
  for (const needed of [CORE, STORE, PDF, options.bin]) {
    if (!existsSync(needed)) throw new Error('missing ' + needed + '; run pnpm -r build first')
  }
  let dataHome = options.home
  let generated = false
  if (!dataHome) {
    dataHome = mkdtempSync(join(tmpdir(), 'advisers-bench-'))
    const startedAt = Date.now()
    await generateData(dataHome, options.scale)
    generated = true
    const message = 'generated synthetic ledger: scale=' + options.scale + ', home=' + dataHome + ', ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's'
    if (options.json) console.error(message)
    else console.log(message)
  } else if (!existsSync(join(dataHome, 'state.db')) && !existsSync(join(dataHome, 'state.json'))) {
    throw new Error('--home ' + dataHome + ' has no state.db; run advisers init there first')
  }
  const workRoot = mkdtempSync(join(tmpdir(), 'advisers-bench-work-'))
  // One prepared snapshot for all reps: the data directory plus a recorded TOS
  // acceptance, so every measured command runs its real path (without the gate
  // exit-3) and the consent write is not billed to each rep.
  const preparedHome = join(workRoot, 'data-home')
  copyHome(dataHome, preparedHome)
  if (!seedTosAcceptance(options.bin, preparedHome)) {
    console.error('warning: could not pre-record the TOS acceptance in the benchmark home; relying on ADVISERS_ACCEPT_TOS=1')
  }
  const loaderPath = join(workRoot, 'bench-child.mjs')
  writeFileSync(loaderPath, childLoader())
  const emptyHome = join(workRoot, 'empty-home')
  mkdirSync(emptyHome, { recursive: true })
  // The default evidence-pack cap is 2000 entries; on any ledger above that the
  // scenario would measure the documented cap error (~exit 1) instead of the
  // pack path, so exercise the documented --all escape hatch. For small ledgers
  // the code path is identical (the flag only lifts the cap).
  const packArgs = ['deliveries', '--pack', '--all', '--out', '{OUT}']
  const scenarios = [
    { name: '--version', args: ['--version'], home: 'empty', mutate: false },
    { name: '--help', args: ['--help'], home: 'empty', mutate: false },
    { name: 'status', args: ['status'], home: 'data', mutate: false },
    { name: 'today', args: ['today'], home: 'data', mutate: false },
    { name: 'tick', args: ['tick'], home: 'data', mutate: true },
    { name: 'deliveries --pack', args: packArgs, home: 'data', mutate: true },
  ]
  try {
    const pdfLib = await import(pathToFileURL(PDF).href)
    if (pdfLib.findCjkFont()) scenarios.push({ name: 'deliver --format pdf', args: ['deliver', '--format', 'pdf', '--out', '{OUT}/deliver.pdf'], home: 'data', mutate: true })
    else console.error('skipping deliver --format pdf: no CJK font on this host (set ADVISERS_PDF_FONT)')
  } catch {}

  const results = []
  for (const scenario of scenarios) {
    const samples = []
    for (let rep = 0; rep < options.reps; rep++) {
      const repRoot = join(workRoot, 'rep-' + scenario.name.replace(/[^a-z0-9]+/gi, '-') + '-' + rep)
      let home = emptyHome
      if (scenario.home === 'data') {
        home = join(repRoot, 'home')
        copyHome(preparedHome, home)
        mkdirSync(join(repRoot, 'cwd'), { recursive: true })
      }
      const cwd = scenario.mutate ? join(repRoot, 'cwd') : workRoot
      const outDir = join(repRoot, 'out')
      mkdirSync(outDir, { recursive: true })
      const args = scenario.args.map((arg) => arg.replace('{OUT}', outDir))
      samples.push(runCli({ bin: options.bin, loaderPath, home, args, cwd }))
      removeTree(repRoot)
    }
    results.push({
      name: scenario.name,
      medianMs: Math.round(median(samples.map((sample) => sample.wallMs))),
      minMs: Math.round(Math.min(...samples.map((sample) => sample.wallMs))),
      maxMs: Math.round(Math.max(...samples.map((sample) => sample.wallMs))),
      maxRssMb: median(samples.map((sample) => sample.rssMb)),
      exitCode: samples[0].exitCode,
      note: samples[0].stderr ? samples[0].stderr.split('\n')[0].slice(0, 120) : '',
    })
  }
  const pdf = await benchPdf(options.reps)
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform + ' ' + process.arch,
    bin: options.bin,
    home: dataHome,
    scale: options.home ? 'existing' : options.scale,
    reps: options.reps,
    cli: results,
    pdf,
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const width = Math.max(...results.map((row) => row.name.length), ...pdf.map((row) => row.name.length)) + 2
    console.log('')
    console.log('bin: ' + options.bin)
    console.log('data: ' + dataHome + ' (scale ' + report.scale + ')')
    console.log('node: ' + report.node + '  reps: ' + report.reps)
    console.log('')
    console.log('scenario'.padEnd(width) + 'median'.padStart(9) + 'min'.padStart(8) + 'max'.padStart(8) + 'RSS'.padStart(9) + '  note')
    for (const row of [...results, ...pdf]) {
      if (row.skipped) { console.log(row.name.padEnd(width) + 'skipped: ' + row.skipped); continue }
      console.log(row.name.padEnd(width) + String(row.medianMs + 'ms').padStart(9) + String(row.minMs + 'ms').padStart(8) + String(row.maxMs + 'ms').padStart(8) + String(row.maxRssMb + 'MB').padStart(9) + '  ' + (row.note ?? ''))
    }
    console.log('')
    console.log('note: medians of fresh child processes; run from a local ext4/tmp checkout for comparable numbers (a 9p/network mount inflates file reads). CLI rows include a small child-loader wrapper used to report peak RSS, so compare columns within one machine/run style rather than across hosts.')
  }
  if (generated && !options.keep) removeTree(dataHome)
  removeTree(workRoot)
}

main().catch((error) => {
  console.error('bench failed: ' + error.message)
  process.exitCode = 1
})
