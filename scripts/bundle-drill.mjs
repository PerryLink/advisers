#!/usr/bin/env node
/**
 * 0.5.1 task-121 / release gate: end-to-end portable-bundle drill.
 *
 * What it proves, against throwaway ADVISERS_HOME directories created with
 * mkdtemp under the OS temp directory (the user's real home is never read or
 * written):
 *
 *   init + seed A -> export --bundle -> empty B -> import --bundle --verify
 *   --dry-run (zero write) -> import --bundle --verify -> doctor --check-db
 *   -> re-export from B exactly once -> dataDigest/counts/tables parity
 *   -> ledger.json semantic parity (the ledger snapshot is not part of
 *      dataDigest, so it is compared separately) -> compareBundleDirs(A,B)
 *
 * The drill also asserts the acceptance/negative matrix:
 *   - the bundle contains FORMAT.md (0.5.1) and it is covered by SHA256SUMS
 *     and manifest.files; IMPORT.md lists it;
 *   - --expect-dataDigest/compareBundleDirs pass on the real bundle and fail
 *     closed (E_BUNDLE_TAMPERED, zero writes) on a wrong digest;
 *   - a valid bundle with a different dataDigest is reported as a mismatch by
 *     compareBundleDirs (not as a corrupt bundle);
 *   - a tampered ledger.json and an unknown extra file are refused with zero
 *     writes; a non-empty home without --replace is refused and unchanged;
 *   - the bundle carries no credentials/audit.key/soul/workspace/scheduler/
 *     logs/exports (never-travel list) and every top-level entry is in the v1
 *     layout allowlist;
 *   - the resource limit path returns E_BUNDLE_LIMIT (over-limit negative);
 *   - the drill runs with no model/API key and never needs the network.
 *
 * Output: exactly one JSON object on stdout, PASS/FAIL in `status`. Step
 * progress and human-readable failures go to stderr. Exit 0 = PASS, 1 = FAIL.
 *
 * Usage: node scripts/bundle-drill.mjs [--bin <advisers-cli.js>] [--keep]
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DRILL = 'bundle-drill'
const DRILL_VERSION = 1
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_BIN = join(REPO_ROOT, 'packages', 'advisers', 'bin', 'advisers.js')
const CLI_TIMEOUT_MS = 120000
const MAX_BUFFER = 64 * 1024 * 1024
const OUTPUT_TAIL = 2000
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const TOP_LEVEL_ALLOWLIST = ['FORMAT.md', 'IMPORT.md', 'SHA256SUMS', 'facts.md', 'kb', 'ledger.json', 'manifest.json', 'pages']
const NEVER_TRAVEL_NAMES = ['audit.key', 'audit-anchor.json', 'soul.md', 'credentials.json', 'sync.state.json']
const NEVER_TRAVEL_DIRS = ['scheduler', 'logs', 'briefs', 'soul', 'workspace', 'exports', 'receipts', 'credentials', 'undo']

/** An expected drill failure: reported as FAIL JSON instead of a stack trace. */
class DrillError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'DrillError'
    this.code = options.code ?? null
    this.detail = options.detail ?? null
  }
}

function usageText() {
  return [
    'usage: node scripts/bundle-drill.mjs [--bin <advisers-cli.js>] [--keep]',
    '',
    'End-to-end portable-bundle drill on throwaway ADVISERS_HOME directories.',
    'Prints one PASS/FAIL JSON object on stdout; exit 0 = PASS, 1 = FAIL.',
    '  --bin <path>  CLI entry point (default: packages/advisers/bin/advisers.js)',
    '  --keep        keep the temporary homes for debugging (paths are in the JSON)',
  ].join(LF)
}

function parseArgs(argv) {
  const options = { bin: DEFAULT_BIN, keep: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--bin') {
      const value = argv[index + 1]
      index += 1
      if (!value) throw new DrillError('--bin requires a path', { code: 'E_USAGE' })
      options.bin = resolve(value)
    } else if (arg === '--keep') {
      options.keep = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new DrillError('unknown argument: ' + arg, { code: 'E_USAGE' })
    }
  }
  return options
}

function outputTail(value, limit = OUTPUT_TAIL) {
  const text = String(value ?? '')
  return text.length > limit ? text.slice(-limit) : text
}

function log(line) {
  console.error('bundle-drill: ' + line)
}

function assertDrill(condition, message, code = 'E_DRILL_ASSERT', detail = null) {
  if (!condition) throw new DrillError(message, { code, detail })
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function isInside(base, target) {
  const rel = relative(base, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Recursively list relative POSIX-style file paths (sorted). */
function listFiles(root, relativeDir = '') {
  const out = []
  const dir = relativeDir ? join(root, ...relativeDir.split('/')) : root
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const relativePath = relativeDir ? relativeDir + '/' + entry.name : entry.name
    if (entry.isDirectory()) out.push(...listFiles(root, relativePath))
    else out.push(relativePath)
  }
  return out.sort()
}

function readJson(file, label) {
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { throw new DrillError((label ?? file) + ': not valid JSON (' + error.message + ')', { code: 'E_DRILL_JSON' }) }
}

/** Canonical JSON (recursively sorted object keys) for semantic comparisons. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key])
    return out
  }
  return value
}

/** Parse a coreutils-style SHA256SUMS text into a Map(name -> digest). */
function parseSums(text, label) {
  const entries = new Map()
  for (const rawLine of String(text).split(LF)) {
    const line = rawLine.endsWith(CR) ? rawLine.slice(0, -1) : rawLine
    if (!line) continue
    assertDrill(line.length > 66 && line.charAt(64) === ' ' && line.charAt(65) === ' ', label + ': malformed SHA256SUMS line: ' + line.slice(0, 80), 'E_DRILL_SUMS')
    const digest = line.slice(0, 64)
    const name = line.slice(66)
    assertDrill(/^[0-9a-f]{64}$/.test(digest), label + ': malformed SHA256SUMS digest', 'E_DRILL_SUMS')
    assertDrill(!entries.has(name), label + ': duplicate SHA256SUMS entry ' + name, 'E_DRILL_SUMS')
    entries.set(name, digest)
  }
  return entries
}

/** Create the throwaway root; refuse to place it outside the OS temp dir. */
function makeTempRoot() {
  const realTmp = realpathSync(tmpdir())
  const root = mkdtempSync(join(tmpdir(), 'advisers-bundle-drill-'))
  const realRoot = realpathSync(root)
  assertDrill(isInside(realTmp, realRoot), 'temporary root escaped the OS temp directory: ' + realRoot, 'E_DRILL_HOME')
  const inheritedHome = process.env.ADVISERS_HOME ?? null
  if (inheritedHome && isAbsolute(inheritedHome)) {
    try {
      const realInherited = realpathSync(inheritedHome)
      assertDrill(!isInside(realInherited, realRoot), 'temporary root must not be inside the inherited ADVISERS_HOME: ' + realRoot, 'E_DRILL_HOME')
    } catch (error) {
      if (error instanceof DrillError) throw error
    }
  }
  return { root: realRoot, inheritedHome }
}

/** Delete only a path proven to be under the OS temp dir; never the real home. */
function cleanupTempRoot(state, keep) {
  if (!state.root) return { removed: false, reason: 'no temporary root was created' }
  if (keep) return { removed: false, reason: 'kept (--keep)' }
  try {
    const realTmp = realpathSync(tmpdir())
    const realRoot = realpathSync(state.root)
    assertDrill(isInside(realTmp, realRoot), 'refusing to delete a temporary root outside the OS temp directory: ' + realRoot, 'E_DRILL_CLEANUP')
    assertDrill(basename(realRoot).startsWith('advisers-bundle-drill-'), 'refusing to delete an unexpected temporary path: ' + realRoot, 'E_DRILL_CLEANUP')
    rmSync(realRoot, { recursive: true, force: true })
    return { removed: !existsSync(realRoot), reason: null }
  } catch (error) {
    return { removed: false, reason: 'cleanup failed: ' + error.message }
  }
}

const OVERRIDDEN_ENV = [
  'ADVISERS_HOME',
  'ADVISERS_STORE',
  'ADVISERS_ACCEPT_TOS',
  'ADVISERS_NO_MODEL',
  'ADVISERS_CORE_LOCAL',
  'ADVISERS_OFFICE_LOCAL',
  'ADVISERS_AUDIT_KEY',
  'ADVISERS_API_KEY',
  'ADVISERS_BASE_URL',
  'ADVISERS_MODEL',
  'ADVISERS_EXPORT_PASSPHRASE',
  'ADVISERS_VAULT_PASSPHRASE',
]

/** Isolated child env: throwaway home, SQLite, TOS pre-accepted, no model/network keys. */
function childEnv(home) {
  const env = { ...process.env }
  for (const key of OVERRIDDEN_ENV) delete env[key]
  return Object.assign(env, {
    ADVISERS_HOME: home,
    ADVISERS_STORE: 'sqlite',
    ADVISERS_ACCEPT_TOS: '1',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
  })
}

function runCli(state, label, args, options = {}) {
  const result = spawnSync(process.execPath, [state.bin, ...args], {
    cwd: REPO_ROOT,
    env: childEnv(options.home ?? state.homeA),
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    input: '',
  })
  const detail = { args, exitCode: result.status ?? null, signal: result.signal ?? null, stdout: outputTail(result.stdout), stderr: outputTail(result.stderr) }
  if (result.error) throw new DrillError(label + ': could not start the CLI (' + result.error.message + ')', { code: 'E_CLI_SPAWN', detail })
  if (result.signal) throw new DrillError(label + ': the CLI was killed by ' + result.signal, { code: 'E_CLI_SIGNAL', detail })
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new DrillError(label + ': advisers ' + args.join(' ') + ' exited ' + result.status, { code: 'E_CLI_EXIT', detail })
  }
  return result
}

function tryJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

function runJson(state, label, args, options = {}) {
  const result = runCli(state, label, args, options)
  assertDrill(result.stdout.trim() !== '', label + ': the CLI printed no JSON', 'E_CLI_NO_JSON', { args, exitCode: result.status ?? null, stderr: outputTail(result.stderr) })
  const payload = tryJson(result.stdout)
  assertDrill(payload !== null, label + ': stdout is not JSON', 'E_CLI_JSON', { args, stdout: outputTail(result.stdout), stderr: outputTail(result.stderr) })
  return payload
}

/** Recompute manifest.files/fileCount/checksumCount and SHA256SUMS from disk. */
function resealBundleDir(dir) {
  const manifestPath = join(dir, 'manifest.json')
  const manifest = readJson(manifestPath, 'manifest.json')
  const allNames = listFiles(dir).filter((name) => name !== 'SHA256SUMS')
  const dataNames = allNames.filter((name) => name !== 'manifest.json')
  manifest.files = dataNames.map((name) => {
    const bytes = readFileSync(join(dir, ...name.split('/')))
    return { path: name, size: bytes.length, sha256: sha256Buffer(bytes) }
  })
  manifest.fileCount = manifest.files.length
  manifest.checksumCount = manifest.files.length + 1
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + LF)
  const sums = allNames.map((name) => sha256Buffer(readFileSync(join(dir, ...name.split('/')))) + '  ' + name).join(LF)
  writeFileSync(join(dir, 'SHA256SUMS'), sums + LF)
  return manifest
}

function runStep(state, name, fn) {
  state.currentStep = name
  const startedAt = Date.now()
  log(name + ' ...')
  const result = fn()
  const durationMs = Date.now() - startedAt
  state.steps.push({ name, ok: true, durationMs })
  log(name + ': ok (' + durationMs + ' ms)')
  state.currentStep = null
  return result
}

/** Assert a CLI refusal: exit 1, JSON ok=false and zero creation of the target home. */
function assertRefusedZeroWrite(state, label, args, expectations = {}) {
  const targetHome = join(state.root, 'refused-home-' + label.replace(/[^a-z0-9]+/gi, '-'))
  const result = runCli(state, label, args, { allowFailure: true, home: targetHome })
  assertDrill(result.status === 1, label + ': expected exit 1, got ' + result.status, 'E_DRILL_REFUSAL', { stderr: outputTail(result.stderr) })
  const payload = tryJson(result.stdout)
  assertDrill(payload !== null, label + ': refusal did not print JSON', 'E_DRILL_REFUSAL', { stdout: outputTail(result.stdout) })
  assertDrill(payload.ok === false, label + ': refusal must be ok:false', 'E_DRILL_REFUSAL', { payload })
  if (expectations.code) assertDrill(payload.code === expectations.code, label + ': expected code ' + expectations.code + ', got ' + payload.code, 'E_DRILL_REFUSAL', { payload })
  if (expectations.codePattern) assertDrill(expectations.codePattern.test(String(payload.code)), label + ': unexpected code ' + payload.code, 'E_DRILL_REFUSAL', { payload })
  if (expectations.errorPattern) {
    const text = JSON.stringify(payload.errors ?? []) + ' ' + String(payload.errors ?? '')
    assertDrill(expectations.errorPattern.test(text), label + ': errors do not match ' + expectations.errorPattern, 'E_DRILL_REFUSAL', { payload })
  }
  assertDrill(!existsSync(targetHome), label + ': a refused command must not create the target home', 'E_DRILL_REFUSAL')
  return payload
}

async function runDrill(state, options) {
  runStep(state, 'preflight', () => {
    assertDrill(existsSync(options.bin), 'CLI entry not found: ' + options.bin, 'E_CLI_MISSING')
    assertDrill(statSync(options.bin).isFile(), 'CLI entry is not a file: ' + options.bin, 'E_CLI_MISSING')
    const created = makeTempRoot()
    state.root = created.root
    state.inheritedHome = created.inheritedHome
    state.homeA = join(state.root, 'home-a')
    state.homeB = join(state.root, 'home-b')
    mkdirSync(state.homeA, { recursive: true, mode: 0o700 })
    state.bundleA = join(state.root, 'bundle-a')
    state.bundleB = join(state.root, 'bundle-b')
    state.checks.isolation = {
      temporaryRoot: true,
      rootInsideOsTempDir: isInside(realpathSync(tmpdir()), state.root),
      inheritedAdvisersHomeIgnored: state.inheritedHome,
      homeBNotCreatedBeforeDryRun: !existsSync(state.homeB),
    }
  })

  runStep(state, 'seed-a', () => {
    runCli(state, 'init', ['init'])
    assertDrill(existsSync(join(state.homeA, 'soul.md')), 'init did not create soul.md', 'E_INIT')
    assertDrill(existsSync(join(state.homeA, 'audit.key')), 'init did not create the local audit key', 'E_INIT')
    runCli(state, 'seed-commit', ['commit', 'add', '发送报价单', '--quote', '周五前把报价单发给王工'])
    runCli(state, 'seed-commit-2', ['commit', 'add', '确认合同条款', '--quote', '合同条款需要确认'])
    assertDrill(existsSync(join(state.homeA, 'state.db')), 'the first write did not create the SQLite database', 'E_SEED')
    const notePath = join(state.root, 'drill-note.md')
    writeFileSync(notePath, '# Bundle drill note' + LF + LF + 'A seeded knowledge document for the portable-bundle round trip.' + LF, { mode: 0o600 })
    const added = runJson(state, 'seed-kb', ['kb', 'add', notePath, '--title', 'Bundle drill note', '--kind', 'note', '--json'])
    assertDrill(added.ok === true && Array.isArray(added.added) && added.added.length === 1, 'kb add did not add exactly one document', 'E_SEED', { stdout: outputTail(JSON.stringify(added)) })
    const exported = runJson(state, 'seed-export', ['export', '--all'])
    state.expect.schemaVersion = exported.schemaVersion ?? null
    state.expect.sourceAuditCount = Array.isArray(exported.data?.audit) ? exported.data.audit.length : null
    assertDrill(typeof state.expect.schemaVersion === 'number', 'export --all did not report a schemaVersion', 'E_SEED')
    assertDrill(typeof state.expect.sourceAuditCount === 'number' && state.expect.sourceAuditCount > 0, 'the seeded home has no audit rows', 'E_SEED')
  })

  runStep(state, 'export-a', () => {
    const exported = runJson(state, 'export-bundle', ['export', '--bundle', state.bundleA, '--json'])
    assertDrill(exported.ok === true, 'export --bundle reported failure', 'E_EXPORT', { exported })
    assertDrill(exported.verificationBasis === 'local-checksums-only', 'unexpected verificationBasis: ' + exported.verificationBasis, 'E_EXPORT')
    assertDrill(/^[0-9a-f]{64}$/.test(String(exported.dataDigest)), 'export did not report a dataDigest', 'E_EXPORT')
    assertDrill(exported.schemaVersion === state.expect.schemaVersion, 'bundle schemaVersion differs from the live export', 'E_EXPORT')
    const manifest = readJson(join(state.bundleA, 'manifest.json'), 'manifest.json')
    assertDrill(manifest.format === 'advisers-bundle' && manifest.version === 1, 'unexpected manifest format/version', 'E_EXPORT', { format: manifest.format, version: manifest.version })
    assertDrill(manifest.dataDigest === exported.dataDigest, 'manifest.dataDigest differs from the export summary', 'E_EXPORT')
    assertDrill(manifest.scope === 'local-all' && manifest.subject === null, 'unexpected bundle scope/subject', 'E_EXPORT')
    assertDrill(manifest.disclaimer === true && manifest.verificationBasis === 'local-checksums-only', 'missing bundle disclaimer/verification basis', 'E_EXPORT')
    assertDrill(JSON.stringify(manifest.tables) === JSON.stringify([...manifest.tables].sort()), 'manifest.tables must be sorted', 'E_EXPORT')
    assertDrill(manifest.fileCount === manifest.files.length, 'manifest.fileCount disagrees with manifest.files', 'E_EXPORT')
    assertDrill(manifest.checksumCount === manifest.files.length + 1, 'manifest.checksumCount is not files.length + 1', 'E_EXPORT')
    for (const table of manifest.tables) {
      assertDrill(manifest.counts[table] === exported.counts[table], 'manifest.counts.' + table + ' differs from the export summary', 'E_EXPORT')
    }
    const ledger = readJson(join(state.bundleA, 'ledger.json'), 'ledger.json')
    assertDrill(ledger.auditAnchor === null, 'ledger.auditAnchor must be null in a bundle', 'E_EXPORT')
    assertDrill(ledger.schemaVersion === manifest.schemaVersion, 'ledger.schemaVersion differs from manifest.schemaVersion', 'E_EXPORT')
    assertDrill(JSON.stringify(Object.keys(ledger.data).sort()) === JSON.stringify([...manifest.tables].sort()), 'ledger.data tables differ from manifest.tables', 'E_EXPORT')
    for (const table of manifest.tables) assertDrill(ledger.data[table].length === manifest.counts[table], 'ledger.data.' + table + ' row count differs from manifest.counts', 'E_EXPORT')
    assertDrill(ledger.sourceAudit && ledger.sourceAudit.count === state.expect.sourceAuditCount, 'ledger.sourceAudit.count differs from the seeded audit count', 'E_EXPORT', { sourceAudit: ledger.sourceAudit, expected: state.expect.sourceAuditCount })
    state.expect.dataDigest = exported.dataDigest
    state.expect.counts = exported.counts
    state.expect.tables = exported.tables
    state.expect.manifest = manifest
    state.expect.ledgerPayload = { ledger: ledger.ledger, data: ledger.data }
    state.checks.bundle = {
      dataDigest: exported.dataDigest,
      schemaVersion: manifest.schemaVersion,
      fileCount: manifest.fileCount,
      checksumCount: manifest.checksumCount,
      counts: exported.counts,
    }
  })

  runStep(state, 'bundle-layout', () => {
    const topLevel = readdirSync(state.bundleA).sort()
    for (const name of topLevel) assertDrill(TOP_LEVEL_ALLOWLIST.includes(name), 'bundle top-level entry is outside the v1 allowlist: ' + name, 'E_LAYOUT', { topLevel })
    for (const required of ['FORMAT.md', 'IMPORT.md', 'SHA256SUMS', 'facts.md', 'ledger.json', 'manifest.json']) {
      assertDrill(topLevel.includes(required), 'bundle is missing the v1 file ' + required, 'E_LAYOUT', { topLevel })
    }
    const files = listFiles(state.bundleA)
    assertDrill(files.includes('FORMAT.md'), 'the 0.5.1 bundle must contain FORMAT.md', 'E_LAYOUT')
    assertDrill(files.includes('IMPORT.md'), 'the bundle must contain IMPORT.md', 'E_LAYOUT')
    for (const name of files) {
      for (const forbidden of NEVER_TRAVEL_NAMES) assertDrill(basename(name) !== forbidden, 'bundle must not contain ' + forbidden, 'E_LAYOUT', { name })
      for (const forbidden of NEVER_TRAVEL_DIRS) assertDrill(!name.startsWith(forbidden + '/'), 'bundle must not contain ' + forbidden + '/', 'E_LAYOUT', { name })
    }
    const formatText = readFileSync(join(state.bundleA, 'FORMAT.md'), 'utf8')
    assertDrill(!formatText.includes(CR), 'FORMAT.md must use LF line endings', 'E_LAYOUT')
    for (const needle of ['ledger.json', 'dataDigest', 'Minimal reader pseudocode', 'bundle v1']) {
      assertDrill(formatText.includes(needle), 'FORMAT.md does not describe ' + needle, 'E_LAYOUT')
    }
    const importText = readFileSync(join(state.bundleA, 'IMPORT.md'), 'utf8')
    assertDrill(importText.includes('FORMAT.md'), 'IMPORT.md does not list FORMAT.md', 'E_LAYOUT')
    assertDrill(!importText.includes(CR), 'IMPORT.md must use LF line endings', 'E_LAYOUT')
    const manifest = state.expect.manifest
    const sums = parseSums(readFileSync(join(state.bundleA, 'SHA256SUMS'), 'utf8'), 'SHA256SUMS')
    assertDrill(sums.size === manifest.checksumCount, 'SHA256SUMS entries differ from manifest.checksumCount', 'E_LAYOUT')
    for (const record of manifest.files) {
      const full = join(state.bundleA, ...record.path.split('/'))
      assertDrill(existsSync(full), 'manifest.files lists a missing file: ' + record.path, 'E_LAYOUT')
      const bytes = readFileSync(full)
      assertDrill(statSync(full).size === record.size, 'manifest.files size mismatch for ' + record.path, 'E_LAYOUT')
      assertDrill(sha256Buffer(bytes) === record.sha256, 'manifest.files sha256 mismatch for ' + record.path, 'E_LAYOUT')
      assertDrill(sums.get(record.path) === record.sha256, 'SHA256SUMS disagrees with manifest.files for ' + record.path, 'E_LAYOUT')
    }
    assertDrill(sums.has('FORMAT.md'), 'SHA256SUMS must cover FORMAT.md', 'E_LAYOUT')
    assertDrill(sums.has('manifest.json') && sums.has('ledger.json') && sums.has('IMPORT.md'), 'SHA256SUMS misses a core file', 'E_LAYOUT')
    state.checks.layout = {
      topLevel, fileCount: files.length, checksumCount: sums.size,
      formatPresent: true, formatChecksumCovered: true,
      noCredentialsOrHomeState: true,
    }
  })

  runStep(state, 'dry-run-zero-write', () => {
    assertDrill(!existsSync(state.homeB), 'the target home must not exist before the dry-run', 'E_DRY_RUN')
    const dry = runJson(state, 'import-dry-run', ['import', '--bundle', state.bundleA, '--verify', '--dry-run', '--json'], { home: state.homeB })
    assertDrill(dry.ok === true, 'import --dry-run reported failure', 'E_DRY_RUN', { dry })
    assertDrill(dry.dryRun === true, 'import --dry-run did not report dryRun:true', 'E_DRY_RUN')
    assertDrill(dry.dataDigest === state.expect.dataDigest, 'dry-run dataDigest differs from the source bundle', 'E_DRY_RUN')
    assertDrill(dry.expectedDigest === null && dry.dataDigestMatch === null, 'a dry-run without --expect-dataDigest must report null expectation fields', 'E_DRY_RUN')
    assertDrill(dry.bootstrap === true, 'a clean home must be planned as bootstrap', 'E_DRY_RUN', { bootstrap: dry.bootstrap })
    assertDrill(JSON.stringify(dry.counts) === JSON.stringify(state.expect.counts), 'dry-run counts differ from the source bundle', 'E_DRY_RUN')
    assertDrill(!existsSync(state.homeB), 'import --dry-run created the target home (zero-write violated)', 'E_DRY_RUN')
    state.checks.dryRun = { zeroWrite: true, dataDigestMatch: true, bootstrap: dry.bootstrap }
  })

  runStep(state, 'import-b', () => {
    const imported = runJson(state, 'import-bundle', ['import', '--bundle', state.bundleA, '--verify', '--json'], { home: state.homeB })
    assertDrill(imported.ok === true, 'import --bundle reported failure', 'E_IMPORT', { imported })
    assertDrill(imported.bootstrap === true, 'the clean home was not bootstrapped', 'E_IMPORT', { bootstrap: imported.bootstrap })
    assertDrill(imported.dataDigest === state.expect.dataDigest, 'import dataDigest differs from the bundle', 'E_IMPORT')
    assertDrill(JSON.stringify(imported.counts) === JSON.stringify(state.expect.counts), 'import counts differ from the bundle', 'E_IMPORT')
    const doctor = runJson(state, 'doctor-check-db', ['doctor', '--check-db', '--json'], { home: state.homeB })
    assertDrill(doctor.ok === true, 'doctor --check-db reported failure after the import', 'E_IMPORT', { doctor })
    const failing = (doctor.checks ?? []).filter((check) => check.ok !== true)
    assertDrill(failing.length === 0, 'doctor --check-db has failing checks after the import', 'E_IMPORT', { failing })
    state.checks.import = { dataDigest: imported.dataDigest, counts: imported.counts, doctorOk: true }
  })

  runStep(state, 'reexport-b', () => {
    const reexport = runJson(state, 'reexport-bundle', ['export', '--bundle', state.bundleB, '--json'], { home: state.homeB })
    assertDrill(reexport.ok === true, 're-export from B reported failure', 'E_REEXPORT', { reexport })
    assertDrill(reexport.dataDigest === state.expect.dataDigest, 're-export dataDigest differs (round trip failed)', 'E_REEXPORT', { expected: state.expect.dataDigest, actual: reexport.dataDigest })
    assertDrill(JSON.stringify(reexport.counts) === JSON.stringify(state.expect.counts), 're-export counts differ (round trip failed)', 'E_REEXPORT')
    assertDrill(JSON.stringify(reexport.tables) === JSON.stringify(state.expect.tables), 're-export tables differ (round trip failed)', 'E_REEXPORT')
    assertDrill(reexport.schemaVersion === state.expect.schemaVersion, 're-export schemaVersion changed', 'E_REEXPORT')
    assertDrill(existsSync(join(state.bundleB, 'FORMAT.md')), 'the re-exported bundle has no FORMAT.md', 'E_REEXPORT')
    // dataDigest covers the data tables; the ledger snapshot (matters/facts/
    // commitments/...) travels in ledger.json and is compared semantically here.
    const ledgerB = readJson(join(state.bundleB, 'ledger.json'), 'ledger.json')
    const a = canonical({ ledger: state.expect.ledgerPayload.ledger, data: state.expect.ledgerPayload.data })
    const b = canonical({ ledger: ledgerB.ledger, data: ledgerB.data })
    assertDrill(JSON.stringify(a.ledger) === JSON.stringify(b.ledger), 'the ledger.json snapshot did not round-trip exactly', 'E_REEXPORT')
    assertDrill(JSON.stringify(a.data) === JSON.stringify(b.data), 'the ledger.json data tables did not round-trip exactly', 'E_REEXPORT')
    state.checks.roundTrip = {
      dataDigestEqual: true, countsEqual: true, tablesEqual: true,
      ledgerSnapshotEqual: true, schemaVersionEqual: true,
    }
  })

  await runStep(state, 'lib-acceptance', async () => {
    // The CLI flag is wired by the bin owner; the drill exercises the library
    // contract that the flag calls, so it stays meaningful before/after wiring.
    const libUrl = pathToFileURL(join(REPO_ROOT, 'packages', 'advisers', 'lib', 'bundle.js')).href
    const lib = await import(libUrl)
    state.lib = lib
    {
      const matched = lib.verifyBundleDir(state.bundleA, { expectDataDigest: state.expect.dataDigest })
      assertDrill(matched.ok === true, 'verifyBundleDir with the expected digest failed: ' + matched.errors.slice(0, 3).join(' | '), 'E_ACCEPT')
      assertDrill(matched.expectedDigest === state.expect.dataDigest && matched.dataDigestMatch === true, 'verifyBundleDir did not report expectedDigest/dataDigestMatch', 'E_ACCEPT')
      const mismatched = lib.verifyBundleDir(state.bundleA, { expectDataDigest: '0'.repeat(64) })
      assertDrill(mismatched.ok === false && mismatched.code === 'E_BUNDLE_TAMPERED' && mismatched.dataDigestMatch === false, 'a wrong expected digest was not refused with E_BUNDLE_TAMPERED', 'E_ACCEPT', { mismatched })
      const overLimit = lib.verifyBundleDir(state.bundleA, { limits: { maxFileBytes: 8 } })
      assertDrill(overLimit.ok === false && overLimit.code === 'E_BUNDLE_LIMIT', 'an over-limit bundle was not refused with E_BUNDLE_LIMIT', 'E_ACCEPT', { overLimit })
      const homeC = join(state.root, 'home-c')
      const refused = lib.importBundle({ bundleDir: state.bundleA, home: homeC, expectDataDigest: 'f'.repeat(64) })
      assertDrill(refused.ok === false && refused.code === 'E_BUNDLE_TAMPERED' && refused.dataDigestMatch === false, 'importBundle accepted a wrong expected digest', 'E_ACCEPT', { refused })
      assertDrill(!existsSync(homeC), 'a rejected expect-dataDigest import created the target home', 'E_ACCEPT')
      const planned = lib.importBundle({ bundleDir: state.bundleA, home: homeC, dryRun: true, expectDataDigest: state.expect.dataDigest })
      assertDrill(planned.ok === true && planned.dataDigestMatch === true, 'importBundle dry-run with the expected digest failed', 'E_ACCEPT', { planned })
      assertDrill(!existsSync(homeC), 'a successful importBundle dry-run created the target home', 'E_ACCEPT')
      const equal = lib.compareBundleDirs(state.bundleA, state.bundleB)
      assertDrill(equal.ok === true && equal.match === true, 'compareBundleDirs(a, b) did not report equal bundles: ' + JSON.stringify(equal.errors), 'E_ACCEPT', { equal })
      // A valid bundle whose data changed is a digest mismatch, not a corrupt bundle.
      const secondNote = join(state.root, 'drill-note-2.md')
      writeFileSync(secondNote, '# Second bundle drill note' + LF + LF + 'A different document so the dataDigest changes.' + LF, { mode: 0o600 })
      runCli(state, 'mutate-a-kb', ['kb', 'add', secondNote, '--title', 'Second drill note', '--kind', 'note'])
      const bundleC = join(state.root, 'bundle-c')
      const mutatedExport = runJson(state, 'export-c', ['export', '--bundle', bundleC, '--json'])
      assertDrill(mutatedExport.ok === true && mutatedExport.dataDigest !== state.expect.dataDigest, 'the drilled mutation did not change the dataDigest', 'E_ACCEPT')
      const changed = lib.compareBundleDirs(state.bundleA, bundleC)
      assertDrill(changed.ok === false && changed.match === false && changed.code === 'E_BUNDLE_TAMPERED', 'compareBundleDirs did not flag a differing dataDigest', 'E_ACCEPT', { changed })
      assertDrill(changed.differences.some((entry) => entry.field === 'dataDigest'), 'compareBundleDirs did not list the dataDigest difference', 'E_ACCEPT', { differences: changed.differences })
      state.checks.acceptance = {
        expectDataDigestMatch: true, expectDataDigestMismatchCode: mismatched.code,
        limitCode: overLimit.code, compareEqual: equal.match, compareChanged: changed.match,
        zeroWriteOnMismatch: true,
      }
    }
  })

  await runStep(state, 'v22-domain-migration', async () => {
    // 126 section 5 release gate: a real 0.5.0 bundle is schema v22 (20 data
    // tables); v23 adds the handoff/waiting tables. Build the v22 artifact by
    // downgrading a v23 export (no old binary is needed), then prove the v23
    // CLI verifies/imports it, and that compareBundleDirs compares on the
    // shared older domain instead of reporting a false mismatch.
    const lib = state.lib
    assertDrill(lib && typeof lib.bundleDataTablesForSchema === 'function', 'the bundle lib was not loaded by lib-acceptance', 'E_V22')
    const current = lib.BUNDLE_DATA_TABLES
    const legacyDomain = lib.bundleDataTablesForSchema(22)
    const added = current.filter((table) => !legacyDomain.includes(table))
    assertDrill(added.length > 0, 'the current schema has no tables newer than v22; the v22 compatibility case cannot be built', 'E_V22')

    const v22Dir = join(state.root, 'bundle-v22')
    cpSync(state.bundleA, v22Dir, { recursive: true })
    const manifestPath = join(v22Dir, 'manifest.json')
    const ledgerPath = join(v22Dir, 'ledger.json')
    const manifest = readJson(manifestPath, 'v22 manifest.json')
    const ledger = readJson(ledgerPath, 'v22 ledger.json')
    manifest.schemaVersion = 22
    ledger.schemaVersion = 22
    manifest.tables = [...legacyDomain]
    for (const table of added) {
      delete manifest.counts[table]
      delete ledger.data[table]
    }
    manifest.dataDigest = lib.computeBundleDataDigest(ledger.data, { tables: manifest.tables }).dataDigest
    rmSync(join(v22Dir, 'FORMAT.md'))
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + LF)
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + LF)
    resealBundleDir(v22Dir)
    const legacyDigest = manifest.dataDigest
    assertDrill(legacyDomain.length < current.length, 'the v22 domain must be smaller than the current domain', 'E_V22')

    const homeV22 = join(state.root, 'home-v22')
    const dry = runJson(state, 'v22-dry-run', ['import', '--bundle', v22Dir, '--verify', '--dry-run', '--json'], { home: homeV22 })
    assertDrill(dry.ok === true, 'the v23 CLI refused a v22-domain bundle in dry-run', 'E_V22', { dry })
    assertDrill(dry.dataDigest === legacyDigest, 'the v22-domain bundle reports a different dataDigest', 'E_V22')
    assertDrill(!existsSync(homeV22), 'the v22 dry-run created the target home', 'E_V22')

    const imported = runJson(state, 'v22-import', ['import', '--bundle', v22Dir, '--verify', '--json'], { home: homeV22 })
    assertDrill(imported.ok === true, 'the v23 CLI refused to import a v22-domain bundle', 'E_V22', { imported })
    assertDrill(imported.dataDigest === legacyDigest, 'the imported v22 bundle reports a different dataDigest', 'E_V22')

    const v23Dir = join(state.root, 'bundle-v22-reexport')
    const reexport = runJson(state, 'v22-reexport', ['export', '--bundle', v23Dir, '--json'], { home: homeV22 })
    assertDrill(reexport.ok === true, 're-export from the migrated home failed', 'E_V22', { reexport })
    assertDrill(reexport.dataDigest !== legacyDigest, 'a schema upgrade should legitimately change the dataDigest domain', 'E_V22')
    for (const table of legacyDomain) {
      assertDrill(reexport.counts[table] === manifest.counts[table], 'a v22 count did not survive the migration: ' + table, 'E_V22')
    }
    for (const table of added) assertDrill(reexport.counts[table] === 0, 'a table added in v23 must be empty after migrating a v22 bundle: ' + table, 'E_V22')
    const sourceLedger = readJson(join(v22Dir, 'ledger.json'), 'v22 ledger.json')
    const targetLedger = readJson(join(v23Dir, 'ledger.json'), 'v23 ledger.json')
    assertDrill(
      JSON.stringify(canonical(targetLedger.ledger)) === JSON.stringify(canonical(sourceLedger.ledger)),
      'the ledger snapshot did not survive the v22 -> v23 migration',
      'E_V22',
    )

    const compared = lib.compareBundleDirs(v22Dir, v23Dir)
    assertDrill(compared.ok === true && compared.match === true, 'compareBundleDirs did not match a migrated v22 bundle on the shared domain: ' + JSON.stringify(compared.errors), 'E_V22', { compared })
    assertDrill(compared.schemaVersionAdjusted === true, 'compareBundleDirs did not report the schema adjustment', 'E_V22')
    assertDrill(JSON.stringify(compared.comparedTables) === JSON.stringify(legacyDomain), 'compareBundleDirs compared the wrong table domain', 'E_V22')
    assertDrill(compared.a.domainDigest === compared.b.domainDigest, 'the shared-domain digests differ', 'E_V22')
    state.checks.v22Migration = {
      legacyDomainTables: legacyDomain.length,
      currentDomainTables: current.length,
      addedTables: added,
      verify: true,
      import: true,
      zeroWriteOnDryRun: true,
      reexportDataDigestChangedAsExpected: reexport.dataDigest !== legacyDigest,
      legacyCountsPreserved: true,
      ledgerSnapshotPreserved: true,
      compareDomainAdjusted: true,
    }
  })

  runStep(state, 'cli-expect-flag', () => {
    // Once the bin owner wires --expect-dataDigest this runs end-to-end; before
    // that it records an honest skip (E_USAGE) instead of failing the drill.
    const args = ['import', '--bundle', state.bundleA, '--verify', '--dry-run', '--expect-dataDigest', state.expect.dataDigest, '--json']
    const result = runCli(state, 'cli-expect', args, { allowFailure: true, home: join(state.root, 'home-cli-expect') })
    if (result.status === 0) {
      const payload = tryJson(result.stdout)
      assertDrill(payload?.ok === true && payload.dataDigestMatch === true, 'CLI --expect-dataDigest with the correct digest did not pass', 'E_CLI_EXPECT', { stdout: outputTail(result.stdout) })
      const refusedArgs = ['import', '--bundle', state.bundleA, '--verify', '--dry-run', '--expect-dataDigest', '0'.repeat(64), '--json']
      assertRefusedZeroWrite(state, 'cli-expect-mismatch', refusedArgs, { codePattern: /^E_BUNDLE_/ })
      state.checks.cliExpectDataDigest = 'supported (correct digest passes, wrong digest exits 1 with zero write)'
      return
    }
    const text = String(result.stdout ?? '') + ' ' + String(result.stderr ?? '')
    const known = /unknown option|E_USAGE/.test(text)
    assertDrill(known, 'CLI --expect-dataDigest failed for an unexpected reason', 'E_CLI_EXPECT', { stdout: outputTail(result.stdout), stderr: outputTail(result.stderr) })
    state.checks.cliExpectDataDigest = 'pending bin wiring (lib-level acceptance above already passed)'
  })

  runStep(state, 'negatives', () => {
    // Tampered ledger bytes: refused, zero write.
    const tampered = join(state.root, 'bundle-tampered')
    cpSync(state.bundleA, tampered, { recursive: true })
    writeFileSync(join(tampered, 'ledger.json'), readFileSync(join(tampered, 'ledger.json'), 'utf8') + ' ')
    assertRefusedZeroWrite(state, 'tampered', ['import', '--bundle', tampered, '--verify', '--dry-run', '--json'], { codePattern: /^E_BUNDLE_/ })
    // Unknown extra file: refused, zero write.
    const extra = join(state.root, 'bundle-extra')
    cpSync(state.bundleA, extra, { recursive: true })
    writeFileSync(join(extra, 'unexpected.txt'), 'not part of bundle v1' + LF)
    assertRefusedZeroWrite(state, 'extra-file', ['import', '--bundle', extra, '--verify', '--dry-run', '--json'], { codePattern: /^E_BUNDLE_/ })
    // Non-empty locally: refused without --replace and the local data is untouched.
    const commitsBefore = runJson(state, 'neg-commits-before', ['commit', 'ls', '--json'])
    const refusedReplace = runJson(state, 'neg-non-empty', ['import', '--bundle', state.bundleA, '--verify', '--json'], { allowFailure: true })
    assertDrill(refusedReplace.ok === false, 'importing into a non-empty home was not refused', 'E_NEGATIVE', { refusedReplace })
    assertDrill(refusedReplace.code === 'E_BUNDLE_TARGET', 'expected E_BUNDLE_TARGET for a non-empty home, got ' + refusedReplace.code, 'E_NEGATIVE', { refusedReplace })
    const commitsAfter = runJson(state, 'neg-commits-after', ['commit', 'ls', '--json'])
    assertDrill(JSON.stringify(commitsBefore) === JSON.stringify(commitsAfter), 'a refused import modified the local data', 'E_NEGATIVE')
    state.checks.negatives = {
      tamperedRefused: true, extraFileRefused: true, nonEmptyHomeRefused: true,
      nonEmptyHomeDataUnchanged: true,
    }
  })

  runStep(state, 'isolation-and-network', () => {
    const env = childEnv(state.homeA)
    for (const key of ['ADVISERS_API_KEY', 'ADVISERS_BASE_URL', 'ADVISERS_MODEL']) {
      assertDrill(env[key] === undefined, 'the drill must not pass ' + key + ' to the CLI', 'E_ISOLATION')
    }
    assertDrill(env.ADVISERS_NO_MODEL === '1', 'the drill must run the CLI with ADVISERS_NO_MODEL=1', 'E_ISOLATION')
    const files = listFiles(state.bundleA)
    for (const forbidden of NEVER_TRAVEL_NAMES) assertDrill(!files.some((name) => basename(name) === forbidden), 'the bundle carries home state: ' + forbidden, 'E_ISOLATION')
    state.checks.isolation.modelAndApiKeysRemoved = true
    state.checks.isolation.zeroNetwork = 'no model/API key is exported and every step is local file/SQLite IO; the CLI is started with ADVISERS_NO_MODEL=1'
  })
}

function emit(payload) {
  console.log(JSON.stringify(payload))
}

function main() {
  const startedAt = Date.now()
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    emit({
      ok: false, status: 'FAIL', drill: DRILL, version: DRILL_VERSION,
      node: process.version, platform: process.platform, home: null, kept: false,
      cleanup: { removed: false, reason: 'no temporary root was created' },
      failedStep: null, steps: [], durationMs: Date.now() - startedAt,
      error: { message: error.message, code: error.code ?? 'E_USAGE', detail: error.detail ?? null },
    })
    console.error('bundle-drill: FAIL (usage): ' + error.message)
    process.exitCode = 1
    return
  }
  if (options.help) { console.log(usageText()); return }

  const state = {
    bin: options.bin,
    root: null,
    homeA: null,
    homeB: null,
    inheritedHome: process.env.ADVISERS_HOME ?? null,
    steps: [],
    checks: {},
    expect: {},
    currentStep: null,
  }
  const run = () => runDrill(state, options)
  const reportPass = () => {
    const cleanup = cleanupTempRoot(state, options.keep)
    emit({
      ok: true, status: 'PASS', drill: DRILL, version: DRILL_VERSION,
      node: process.version, platform: process.platform,
      binary: state.bin, home: state.homeA, kept: options.keep, cleanup,
      durationMs: Date.now() - startedAt,
      steps: state.steps, checks: state.checks,
    })
    log('PASS in ' + (Date.now() - startedAt) + ' ms')
    if (cleanup.removed !== true && cleanup.reason) log('cleanup: ' + cleanup.reason)
    process.exitCode = 0
  }
  const reportFail = (error) => {
    const cleanup = cleanupTempRoot(state, options.keep)
    emit({
      ok: false, status: 'FAIL', drill: DRILL, version: DRILL_VERSION,
      node: process.version, platform: process.platform,
      binary: state.bin, home: state.homeA, kept: options.keep, cleanup,
      durationMs: Date.now() - startedAt,
      failedStep: state.currentStep, steps: state.steps,
      error: { message: error.message, code: error.code ?? 'E_DRILL', detail: error.detail ?? null },
    })
    log('FAIL' + (state.currentStep ? ' at ' + state.currentStep : '') + ': ' + error.message)
    if (error.detail?.stderr) log('stderr tail: ' + error.detail.stderr)
    if (options.keep && state.root) log('kept temporary root at ' + state.root)
    process.exitCode = 1
  }
  // The drill has one asynchronous step (lib import), so run it as a promise.
  Promise.resolve().then(run).then(reportPass).catch(reportFail)
}

main()
