/**
 * Shared quality-result schema v2 builder / validator / writer (0.5.0 WF4 Q1).
 *
 * Every zero-model quality gate (det, local-gold, model-contract, live, human-gold)
 * writes the same JSON shape: explicit schemaVersion 2, corpus / fixture hashes,
 * CLI provenance (version + commit + dirty), structural totals, gates, an explicit
 * `unknowns` list for dimensions that were NOT measured (value null, never
 * 0/false/PASS), `detailSha256`-only failures, and a reproduce block.
 *
 * This module is the single source of truth for that contract:
 *   - `ev/schema/quality-result-v2.schema.json` is the committed JSON Schema twin;
 *   - `scripts/check-eval-report.mjs` validates written reports with
 *     `validateQualityReport()`;
 *   - the `eval:det` reporter and the local-gold / model-contract runners use
 *     `buildQualityReport()` + `writeQualityReport()` so their output cannot drift.
 *
 * No dependencies beyond Node builtins; no network, no model, no key.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative as relativePath, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const QUALITY_SCHEMA_VERSION = 2
export const QUALITY_BASELINE_PATH = join(REPO_ROOT, 'eval/quality/baselines-v1.json')
export const QUALITY_SCHEMA_PATH = join(REPO_ROOT, 'eval/schema/quality-result-v2.schema.json')

/** Dimensions the report must either measure (only the matching mode) or list as null. */
export const STANDARD_UNKNOWN_DIMENSIONS = Object.freeze([
  'modelQuality',
  'humanGold',
  'liveModelQuality',
  'semanticCorrectness',
  'cost',
  'realMailAccount',
  'win11RealMachine',
])

const UNKNOWN_REASONS = Object.freeze({
  modelQuality: 'not-measured-by-this-suite',
  humanGold: 'pending-independent-review',
  liveModelQuality: 'requires-live-model-run',
  semanticCorrectness: 'no-semantic-gold-set',
  cost: 'not-measured-by-this-suite',
  realMailAccount: 'no-real-mail-account-fixture',
  win11RealMachine: 'windows-ci-only-not-a-real-machine',
})

const MODES = Object.freeze(['det', 'local-gold', 'model-contract', 'live', 'human-gold', 'index'])
const MODE_MEASURED_DIMENSIONS = Object.freeze({
  det: [],
  'local-gold': [],
  'model-contract': [],
  live: ['modelQuality', 'liveModelQuality', 'cost'],
  'human-gold': ['humanGold'],
  index: [],
})
const QUALITY_METRIC_KEYS = Object.freeze([
  'precision', 'recall', 'f1', 'accuracy', 'kappa', 'dueAccuracy', 'authorAccuracy',
  'negativeFalsePositiveRate', 'precisionAt5', 'mrrAt10', 'shortQueryHitAt5', 'noHitFalsePositiveRate',
  'modelQuality', 'humanGold', 'liveModelQuality', 'semanticCorrectness', 'cost',
])
const STRUCTURAL_METRIC_KEYS = Object.freeze([
  'n', 'cases', 'passed', 'failed', 'checks', 'checksFailed', 'sockets', 'socketAttempts',
  'autoConfirmed', 'stubCalls', 'reproDataSha', 'requests', 'calls', 'durationMs',
])
const DENY_KEYS = Object.freeze([
  'prompt', 'answer', 'rawprompt', 'rawanswer', 'quote', 'body', 'bodytext', 'snippet',
  'customername', 'customertext', 'email', 'phone', 'messagebody', 'mailbody', 'rawtext',
])
const ABSOLUTE_PATH_PATTERN = /(?:^|[^A-Za-z0-9._-])(?:[A-Za-z]:[\\/]|\/(?:tmp|home|mnt|Users|var\/folders|private\/var)\b)/
const PLACEHOLDER_PATTERN = /<(?:TMP|HOME|WORK|REPO|NET)>/
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const CN_MOBILE_PATTERN = /(?:^|[^0-9])1[3-9][0-9]{9}(?:[^0-9]|$)/
const CN_ID_PATTERN = /(?:^|[^0-9])(?:[0-9]{17}[0-9Xx])(?:[^0-9]|$)/
const SHA256_RE = /^[0-9a-f]{64}$/
const DEFAULT_REDACTION_RULES = Object.freeze(['abs-path', 'temp-home', 'repo-root', 'pii', 'prompt-answer'])
const DEFAULT_REPRODUCE_ENV = Object.freeze({ TZ: 'Asia/Shanghai', noModel: true, network: 'blocked', acceptTos: true })

/* -------------------------------------------------------------------------- */
/* hashing / provenance                                                       */
/* -------------------------------------------------------------------------- */

/** Hex SHA-256 of a UTF-8 string. */
export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** Hex SHA-256 of a file's raw bytes (throws when the file is unreadable). */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Corpus / fixture manifest hash: sha256 over sorted `relpath\\0sha256\\n` lines.
 * @param {{path?: string, relpath?: string, sha256: string}[]} entries
 */
export function corpusSha256(entries) {
  const rows = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      path: String(entry.relpath ?? entry.path ?? '').replaceAll('\\', '/'),
      sha256: String(entry.sha256 ?? '').toLowerCase(),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return sha256Hex(rows.map((row) => row.path + '\u0000' + row.sha256).join('\n') + (rows.length ? '\n' : ''))
}

/** `{ relpath, sha256 }` manifest of a list of files under a root directory. */
export function fileManifest(root, files) {
  return (Array.isArray(files) ? files : []).map((file) => {
    const path = resolve(root, file)
    return { relpath: relativePath(root, path).replaceAll('\\', '/'), sha256: sha256File(path) }
  })
}

let cachedRepoRootVersion = null
/** Product version recorded in every report (packages/advisers/package.json). */
export function productVersion() {
  if (cachedRepoRootVersion) return cachedRepoRootVersion
  try {
    cachedRepoRootVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/advisers/package.json'), 'utf8')).version
  } catch {
    cachedRepoRootVersion = 'unknown'
  }
  return cachedRepoRootVersion
}

/**
 * CLI provenance block: version / commit / node / os / dirty.
 *
 * `dirty` is computed from tracked files only (`git status --porcelain -uno`) so
 * untracked internal notes do not flip a release-report to dirty, while any
 * tracked edit does. A missing git binary/repo yields `commit:null, dirty:true`
 * (fail closed: a report of unknown provenance must not pass a release gate).
 */
export function collectCliInfo() {
  let commit = null
  let dirty = true
  const rev = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (rev.status === 0) {
    commit = rev.stdout.trim() || null
    const status = spawnSync('git', ['status', '--porcelain', '-uno'], { cwd: REPO_ROOT, encoding: 'utf8' })
    dirty = status.status !== 0 || status.stdout.trim().length > 0
  }
  return { version: productVersion(), commit, node: process.version, os: process.platform, dirty }
}

/** Explicit-null entry list for the dimensions this suite did not measure. */
export function standardUnknowns(reasons = {}) {
  return STANDARD_UNKNOWN_DIMENSIONS.map((id) => ({ id, value: null, reason: String(reasons[id] ?? UNKNOWN_REASONS[id] ?? 'not-measured') }))
}

/** One gate assertion: actual vs threshold with an operator; pass is derived. */
export function gate(id, actual, threshold, operator = '>=') {
  const allowed = ['>=', '>', '<=', '<', '=', '==', '!=']
  const op = allowed.includes(operator) ? operator : '>='
  let pass = false
  if (op === '=' || op === '==') pass = actual === threshold
  else if (op === '!=') pass = actual !== threshold
  else if (typeof actual === 'number' && typeof threshold === 'number') {
    pass = op === '>=' ? actual >= threshold : op === '>' ? actual > threshold : op === '<=' ? actual <= threshold : actual < threshold
  }
  return { id: String(id), actual, threshold, operator: op, pass }
}

/** Default results directory for one suite: `eval/results/<suite>/` (gitignored). */
export function defaultResultsDir(suite) {
  return join(REPO_ROOT, 'eval/results', String(suite ?? 'unknown'))
}

/** `{file, sha256, recordedAt}` reference for eval/quality/baselines-v1.json. */
export function qualityBaselineReference() {
  if (!existsSync(QUALITY_BASELINE_PATH)) return { file: 'eval/quality/baselines-v1.json', sha256: null, recordedAt: null }
  let recordedAt = null
  try { recordedAt = JSON.parse(readFileSync(QUALITY_BASELINE_PATH, 'utf8')).recordedAt ?? null } catch { recordedAt = null }
  return { file: 'eval/quality/baselines-v1.json', sha256: sha256File(QUALITY_BASELINE_PATH), recordedAt }
}

/* -------------------------------------------------------------------------- */
/* build                                                                      */
/* -------------------------------------------------------------------------- */

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/**
 * Build a schema-v2 report. Only the fields the caller actually knows are
 * required; everything else gets the honest default (null / empty / standard
 * unknowns) instead of a made-up value.
 */
export function buildQualityReport(input = {}) {
  if (!input.suite) throw new TypeError('buildQualityReport: suite is required')
  const startedAt = input.startedAt ?? new Date().toISOString()
  const report = {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    suite: String(input.suite),
    suiteVersion: Number.isInteger(input.suiteVersion) ? input.suiteVersion : 1,
    mode: String(input.mode ?? 'det'),
    startedAt: String(startedAt),
    durationMs: Math.max(0, Math.round(Number(input.durationMs ?? 0))),
    command: Array.isArray(input.command) ? input.command.map(String) : [],
    filters: Array.isArray(input.filters) ? input.filters.map(String) : ['all'],
    corpus: input.corpus === undefined ? null : input.corpus,
    fixtures: input.fixtures ?? { sha256: sha256Hex(''), count: 0 },
    cli: input.cli ?? collectCliInfo(),
    model: input.model === undefined ? null : input.model,
    baseline: input.baseline ?? qualityBaselineReference(),
    metrics: input.metrics === undefined ? null : input.metrics,
    gates: Array.isArray(input.gates) ? input.gates : [],
    totals: input.totals ?? { cases: 0, passed: 0, failed: 0, checks: 0, checksFailed: 0 },
    network: input.network ?? { guarded: true, attempts: 0 },
    unknowns: Array.isArray(input.unknowns) ? input.unknowns : standardUnknowns(input.unknownReasons),
    failures: Array.isArray(input.failures) ? input.failures : [],
    redaction: input.redaction ?? { version: 2, rules: [...DEFAULT_REDACTION_RULES], piiScan: 'pass' },
    reproduce: input.reproduce ?? {
      command: Array.isArray(input.command) ? input.command.join(' ') : '',
      env: { ...DEFAULT_REPRODUCE_ENV },
      fixedNow: null,
      seed: null,
    },
  }
  if (input.cases !== undefined) report.cases = input.cases
  if (input.environment !== undefined) report.environment = input.environment
  if (input.references !== undefined) report.references = input.references
  return report
}

/* -------------------------------------------------------------------------- */
/* sanitize                                                                   */
/* -------------------------------------------------------------------------- */

function walk(value, fn) {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((item) => walk(item, fn))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, fn)]))
  return value
}

/**
 * Replace known absolute roots with placeholders and bound detail strings.
 * `roots` may be workdir objects (home/work/net/root) or plain path strings.
 */
export function sanitizeQualityReport(value, { roots = [], maxLength = 2000 } = {}) {
  const replacements = []
  for (const root of roots) {
    if (!root) continue
    if (typeof root === 'string') replacements.push([root, '<TMP>'])
    else {
      if (root.home) replacements.push([root.home, '<HOME>'])
      if (root.work) replacements.push([root.work, '<WORK>'])
      if (root.net) replacements.push([root.net, '<NET>'])
      if (root.root) replacements.push([root.root, '<TMP>'])
    }
  }
  replacements.push([REPO_ROOT, '<REPO>'])
  replacements.push([REPO_ROOT.replaceAll('\\', '/'), '<REPO>'])
  return walk(value, (text) => {
    let out = text
    for (const [from, to] of replacements) {
      if (!from) continue
      out = out.split(from).join(to)
      out = out.split(from.replaceAll('\\', '/')).join(to)
    }
    return out.length > maxLength ? out.slice(0, maxLength) + '…' : out
  })
}

/* -------------------------------------------------------------------------- */
/* validate                                                                   */
/* -------------------------------------------------------------------------- */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function isSha256(value) { return typeof value === 'string' && SHA256_RE.test(value) }
function isIsoInstant(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function isInteger(value) { return Number.isInteger(value) }

function scanForbidden(value, path, errors, { allowCasesChecks = true } = {}) {
  if (typeof value === 'string') {
    // Replace placeholders with a neutral character (not delete them): deleting
    // `<TMP>` from `<TMP>/home` would leave `/home`, a false absolute path.
    const stripped = value.replace(PLACEHOLDER_PATTERN, 'X')
    if (stripped && ABSOLUTE_PATH_PATTERN.test(stripped)) errors.push({ code: 'ABSOLUTE_PATH', path, message: 'absolute path in report string' })
    // Hashes and git SHAs are pure hex; an 11-digit run inside one must not be
    // mistaken for a phone number (that would make the gate flaky).
    if (!/^[0-9a-f]{7,64}$/i.test(value)) {
      if (EMAIL_PATTERN.test(value)) errors.push({ code: 'PII_EMAIL', path, message: 'email address in report string' })
      if (CN_MOBILE_PATTERN.test(value)) errors.push({ code: 'PII_PHONE', path, message: 'phone number in report string' })
      if (CN_ID_PATTERN.test(value)) errors.push({ code: 'PII_ID', path, message: 'ID number in report string' })
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbidden(item, path + '[' + index + ']', errors, { allowCasesChecks }))
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase()
    const inCasesCheckDetail = allowCasesChecks && path.startsWith('cases')
    if (DENY_KEYS.includes(lower) && !(inCasesCheckDetail && (lower === 'detail' || lower === 'id'))) {
      errors.push({ code: 'FORBIDDEN_FIELD', path: path + '.' + key, message: 'prompt/answer/quote/customer text must not be stored in a report' })
      continue
    }
    scanForbidden(item, path + '.' + key, errors, { allowCasesChecks })
  }
}

function checkModeMetrics(report, errors) {
  const mode = report.mode
  const metrics = report.metrics
  const measured = new Set(MODE_MEASURED_DIMENSIONS[mode] ?? [])
  if (mode === 'det') {
    if (metrics !== null) errors.push({ code: 'MODE_METRICS', path: 'metrics', message: 'mode "det" must not carry quality metrics (metrics must be null)' })
  } else if (mode === 'model-contract') {
    if (metrics === null) {
      errors.push({ code: 'MODE_METRICS', path: 'metrics', message: 'mode "model-contract" must record structural metrics (sockets/autoConfirmed)' })
    } else if (isPlainObject(metrics)) {
      for (const key of QUALITY_METRIC_KEYS) if (key in metrics) errors.push({ code: 'MODE_METRICS', path: 'metrics.' + key, message: 'quality metric ' + key + ' is not allowed in mode "model-contract"' })
      for (const key of ['sockets', 'socketAttempts', 'autoConfirmed']) if (!(key in metrics)) errors.push({ code: 'MODE_METRICS', path: 'metrics', message: 'mode "model-contract" must record metrics.' + key })
    }
  } else if (mode === 'local-gold') {
    if (!isPlainObject(metrics)) errors.push({ code: 'MODE_METRICS', path: 'metrics', message: 'mode "local-gold" requires a metrics object with n and synthetic metrics' })
    else {
      if (!isInteger(metrics.n) || metrics.n < 1) errors.push({ code: 'MODE_METRICS', path: 'metrics.n', message: 'metrics.n must be a positive integer' })
      const numeric = Object.entries(metrics).filter(([, value]) => typeof value === 'number')
      if (!numeric.length) errors.push({ code: 'MODE_METRICS', path: 'metrics', message: 'mode "local-gold" requires at least one numeric metric' })
      for (const key of ['kappa', 'modelQuality', 'liveModelQuality']) if (key in metrics) errors.push({ code: 'MODE_METRICS', path: 'metrics.' + key, message: key + ' is not a local-gold metric' })
      if (!isPlainObject(report.corpus)) errors.push({ code: 'CORPUS_REQUIRED', path: 'corpus', message: 'mode "local-gold" requires a corpus block' })
    }
  } else if (mode === 'live') {
    if (!isPlainObject(metrics) || !Object.keys(metrics).length) errors.push({ code: 'MODE_METRICS', path: 'metrics', message: 'mode "live" requires model-quality metrics' })
    if (!isPlainObject(report.model)) errors.push({ code: 'MODEL_REQUIRED', path: 'model', message: 'mode "live" requires a model block (provider/model/date)' })
  } else if (mode === 'human-gold') {
    if (!isPlainObject(metrics) || typeof metrics.kappa !== 'number') errors.push({ code: 'MODE_METRICS', path: 'metrics.kappa', message: 'mode "human-gold" requires a numeric metrics.kappa' })
    if (!isPlainObject(report.corpus)) errors.push({ code: 'CORPUS_REQUIRED', path: 'corpus', message: 'mode "human-gold" requires a corpus block' })
  } else if (mode === 'index') {
    if (!Array.isArray(report.references) || !report.references.length) errors.push({ code: 'REFERENCE_REQUIRED', path: 'references', message: 'mode "index" requires references to child reports' })
  }
  return measured
}

/**
 * Validate one schema-v2 report against the hard rules.
 *
 * `release:true` additionally requires release evidence to be reproducible:
 *   cli.commit must be present and cli.dirty must be false.
 * Every other check is mode-independent and strict: explicit nulls for
 * unmeasured dimensions, a zero network-attempt counter, no absolute paths /
 * PII / prompt-answer text, detailSha256-only failures and green gates.
 */
export function validateQualityReport(report, { release = false } = {}) {
  const errors = []
  const fail = (code, path, message) => errors.push({ code, path, message })
  if (!isPlainObject(report)) return { ok: false, errors: [{ code: 'INVALID_REPORT', path: '$', message: 'report must be a JSON object' }] }
  if (report.schemaVersion !== QUALITY_SCHEMA_VERSION) fail('SCHEMA_VERSION', 'schemaVersion', 'schemaVersion must be ' + QUALITY_SCHEMA_VERSION)
  if (typeof report.suite !== 'string' || !report.suite.trim()) fail('SUITE', 'suite', 'suite must be a non-empty string')
  if (!isInteger(report.suiteVersion) || report.suiteVersion < 1) fail('SUITE_VERSION', 'suiteVersion', 'suiteVersion must be a positive integer')
  if (!MODES.includes(report.mode)) fail('MODE', 'mode', 'mode must be one of ' + MODES.join(', '))
  if (!isIsoInstant(report.startedAt)) fail('STARTED_AT', 'startedAt', 'startedAt must be an ISO-8601 UTC instant')
  if (!isInteger(report.durationMs) || report.durationMs < 0) fail('DURATION', 'durationMs', 'durationMs must be a non-negative integer')
  if (!Array.isArray(report.command) || !report.command.length || report.command.some((part) => typeof part !== 'string')) fail('COMMAND', 'command', 'command must be a non-empty string array')
  if (!Array.isArray(report.filters) || report.filters.some((value) => typeof value !== 'string')) fail('FILTERS', 'filters', 'filters must be a string array')
  if (report.corpus !== null) {
    if (!isPlainObject(report.corpus)) fail('CORPUS', 'corpus', 'corpus must be an object or null')
    else {
      if (typeof report.corpus.id !== 'string' || !report.corpus.id) fail('CORPUS', 'corpus.id', 'corpus.id must be a non-empty string')
      if (!isSha256(report.corpus.sha256)) fail('CORPUS', 'corpus.sha256', 'corpus.sha256 must be a 64-hex sha256')
      if (!isInteger(report.corpus.rows) || report.corpus.rows < 0) fail('CORPUS', 'corpus.rows', 'corpus.rows must be a non-negative integer')
      if (typeof report.corpus.provenance !== 'string' || !report.corpus.provenance) fail('CORPUS', 'corpus.provenance', 'corpus.provenance must be a non-empty string')
      if (typeof report.corpus.reviewMode !== 'string' || !report.corpus.reviewMode) fail('CORPUS', 'corpus.reviewMode', 'corpus.reviewMode must be a non-empty string')
      if (typeof report.corpus.license !== 'string' || !report.corpus.license) fail('CORPUS', 'corpus.license', 'corpus.license must be a non-empty string')
      if (typeof report.corpus.split !== 'string' || !report.corpus.split) fail('CORPUS', 'corpus.split', 'corpus.split must be a non-empty string')
    }
  }
  if (!isPlainObject(report.fixtures) || !isSha256(report.fixtures.sha256) || !isInteger(report.fixtures.count) || report.fixtures.count < 0) {
    fail('FIXTURES', 'fixtures', 'fixtures must be {sha256:64hex, count:int>=0}')
  }
  if (!isPlainObject(report.cli)) fail('CLI', 'cli', 'cli block is required')
  else {
    if (typeof report.cli.version !== 'string' || !report.cli.version) fail('CLI', 'cli.version', 'cli.version must be a non-empty string')
    if (report.cli.commit !== null && typeof report.cli.commit !== 'string') fail('CLI', 'cli.commit', 'cli.commit must be a string or null')
    if (typeof report.cli.node !== 'string' || !report.cli.node) fail('CLI', 'cli.node', 'cli.node must be a non-empty string')
    if (typeof report.cli.os !== 'string' || !report.cli.os) fail('CLI', 'cli.os', 'cli.os must be a non-empty string')
    if (typeof report.cli.dirty !== 'boolean') fail('CLI', 'cli.dirty', 'cli.dirty must be a boolean')
  }
  if (report.model !== null && !isPlainObject(report.model)) fail('MODEL', 'model', 'model must be an object or null')
  if (!isPlainObject(report.baseline)) fail('BASELINE', 'baseline', 'baseline block is required')
  else {
    if (typeof report.baseline.file !== 'string' || !report.baseline.file) fail('BASELINE', 'baseline.file', 'baseline.file must be a non-empty string')
    if (report.baseline.sha256 !== null && !isSha256(report.baseline.sha256)) fail('BASELINE', 'baseline.sha256', 'baseline.sha256 must be 64hex or null')
    if (report.baseline.recordedAt !== null && !isIsoInstant(report.baseline.recordedAt)) fail('BASELINE', 'baseline.recordedAt', 'baseline.recordedAt must be an ISO instant or null')
    // A report that cites a baseline must cite the baseline bytes that exist on
    // disk (a stale hash means the report was recorded against a different tree).
    if (typeof report.baseline.file === 'string' && report.baseline.sha256 !== null) {
      const baselinePath = resolve(REPO_ROOT, report.baseline.file)
      if (!existsSync(baselinePath)) { if (release) fail('BASELINE_MISSING', 'baseline.file', 'baseline file does not exist: ' + report.baseline.file) }
      else {
        try { if (sha256File(baselinePath) !== report.baseline.sha256) fail('BASELINE_SHA', 'baseline.sha256', 'baseline.sha256 does not match the baseline file bytes') } catch { fail('BASELINE_SHA', 'baseline.sha256', 'baseline file is unreadable') }
      }
    } else if (release) fail('BASELINE_MISSING', 'baseline.sha256', 'release evidence requires a baseline sha256')
  }
  if (!Array.isArray(report.gates)) fail('GATES', 'gates', 'gates must be an array')
  else {
    for (const [index, entry] of report.gates.entries()) {
      const path = 'gates[' + index + ']'
      if (!isPlainObject(entry)) { fail('GATES', path, 'gate must be an object'); continue }
      if (typeof entry.id !== 'string' || !entry.id) fail('GATES', path + '.id', 'gate.id must be a non-empty string')
      if (!['>=', '>', '<=', '<', '=', '==', '!='].includes(entry.operator)) fail('GATES', path + '.operator', 'gate.operator is invalid')
      if (typeof entry.pass !== 'boolean') fail('GATES', path + '.pass', 'gate.pass must be a boolean')
      else if (!entry.pass) fail('GATE_FAILED', path, 'gate ' + entry.id + ' failed (actual ' + JSON.stringify(entry.actual) + ' ' + entry.operator + ' threshold ' + JSON.stringify(entry.threshold) + ')')
    }
  }
  if (!isPlainObject(report.totals)) fail('TOTALS', 'totals', 'totals block is required')
  else {
    for (const key of ['cases', 'passed', 'failed', 'checks', 'checksFailed']) {
      if (!isInteger(report.totals[key]) || report.totals[key] < 0) fail('TOTALS', 'totals.' + key, 'totals.' + key + ' must be a non-negative integer')
    }
    if (isInteger(report.totals.cases) && isInteger(report.totals.passed) && isInteger(report.totals.failed) && report.totals.passed + report.totals.failed !== report.totals.cases) {
      fail('TOTALS', 'totals', 'totals.passed + totals.failed must equal totals.cases')
    }
    if (isInteger(report.totals.checksFailed) && isInteger(report.totals.checks) && report.totals.checksFailed > report.totals.checks) fail('TOTALS', 'totals', 'totals.checksFailed cannot exceed totals.checks')
    if (isInteger(report.totals.failed) && report.totals.failed > 0) fail('CASE_FAILURES', 'totals.failed', 'a report with failed cases is not valid release evidence')
    if (isInteger(report.totals.checksFailed) && report.totals.checksFailed > 0) fail('CHECK_FAILURES', 'totals.checksFailed', 'a report with failed checks is not valid release evidence')
  }
  if (!isPlainObject(report.network)) fail('NETWORK', 'network', 'network block is required')
  else {
    if (typeof report.network.guarded !== 'boolean') fail('NETWORK', 'network.guarded', 'network.guarded must be a boolean')
    if (!isInteger(report.network.attempts) || report.network.attempts < 0) fail('NETWORK', 'network.attempts', 'network.attempts must be a non-negative integer')
    else if (report.network.attempts !== 0) fail('NETWORK_ATTEMPTS', 'network.attempts', 'the zero-model gates must record 0 network attempts, got ' + report.network.attempts)
  }
  if (!Array.isArray(report.unknowns)) fail('UNKNOWNS', 'unknowns', 'unknowns must be an array')
  else {
    const listed = new Map()
    for (const [index, entry] of report.unknowns.entries()) {
      const path = 'unknowns[' + index + ']'
      if (!isPlainObject(entry)) { fail('UNKNOWNS', path, 'unknown entry must be an object'); continue }
      if (typeof entry.id !== 'string' || !entry.id) fail('UNKNOWNS', path + '.id', 'unknown.id must be a non-empty string')
      if (entry.value !== null) fail('EXPLICIT_NULL', path + '.value', 'an unmeasured dimension must be explicit null, never 0/false/PASS')
      if (typeof entry.reason !== 'string' || !entry.reason) fail('UNKNOWNS', path + '.reason', 'unknown.reason must be a non-empty string')
      listed.set(entry.id, entry)
    }
    const measured = new Set(MODE_MEASURED_DIMENSIONS[report.mode] ?? [])
    for (const id of STANDARD_UNKNOWN_DIMENSIONS) {
      if (measured.has(id)) {
        if (listed.has(id)) fail('UNKNOWNS', 'unknowns', 'dimension ' + id + ' is measured by mode ' + report.mode + ' but also listed as unknown')
        continue
      }
      if (!listed.has(id)) fail('EXPLICIT_NULL', 'unknowns', 'unmeasured dimension ' + id + ' must be listed in unknowns with value null')
    }
  }
  if (!Array.isArray(report.failures)) fail('FAILURES', 'failures', 'failures must be an array')
  else {
    for (const [index, entry] of report.failures.entries()) {
      const path = 'failures[' + index + ']'
      if (!isPlainObject(entry)) { fail('FAILURES', path, 'failure must be an object'); continue }
      if (typeof entry.caseId !== 'string' || !entry.caseId) fail('FAILURES', path + '.caseId', 'failure.caseId must be a non-empty string')
      if (typeof entry.code !== 'string' || !entry.code) fail('FAILURES', path + '.code', 'failure.code must be a non-empty string')
      if (!isSha256(entry.detailSha256)) fail('FAILURES', path + '.detailSha256', 'failures may only carry detailSha256 (64hex), never detail text')
      if (entry.checkId !== undefined && typeof entry.checkId !== 'string') fail('FAILURES', path + '.checkId', 'failure.checkId must be a string when present')
      for (const key of Object.keys(entry)) if (!['caseId', 'checkId', 'code', 'detailSha256'].includes(key)) fail('FAILURES', path + '.' + key, 'unexpected failure field (detail text must not be stored)')
    }
  }
  if (!isPlainObject(report.redaction)) fail('REDACTION', 'redaction', 'redaction block is required')
  else {
    if (report.redaction.version !== 2) fail('REDACTION', 'redaction.version', 'redaction.version must be 2')
    if (!Array.isArray(report.redaction.rules) || report.redaction.rules.some((rule) => typeof rule !== 'string')) fail('REDACTION', 'redaction.rules', 'redaction.rules must be a string array')
    if (report.redaction.piiScan !== 'pass') fail('REDACTION', 'redaction.piiScan', 'redaction.piiScan must be "pass"')
  }
  if (!isPlainObject(report.reproduce)) fail('REPRODUCE', 'reproduce', 'reproduce block is required')
  else {
    if (typeof report.reproduce.command !== 'string' || !report.reproduce.command) fail('REPRODUCE', 'reproduce.command', 'reproduce.command must be a non-empty string')
    if (!isPlainObject(report.reproduce.env)) fail('REPRODUCE', 'reproduce.env', 'reproduce.env must be an object')
    if (report.reproduce.fixedNow !== null && !isIsoInstant(report.reproduce.fixedNow)) fail('REPRODUCE', 'reproduce.fixedNow', 'reproduce.fixedNow must be an ISO instant or null')
    if (report.reproduce.seed !== null && !isInteger(report.reproduce.seed)) fail('REPRODUCE', 'reproduce.seed', 'reproduce.seed must be an integer or null')
  }
  if (MODES.includes(report.mode)) checkModeMetrics(report, errors)
  if (release) {
    if (!isPlainObject(report.cli) || typeof report.cli.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(report.cli.commit)) fail('RELEASE_COMMIT', 'cli.commit', 'release evidence requires cli.commit (git SHA)')
    if (!isPlainObject(report.cli) || report.cli.dirty !== false) fail('RELEASE_DIRTY', 'cli.dirty', 'release evidence requires cli.dirty === false')
  }
  scanForbidden(report, '$', errors)
  return { ok: errors.length === 0, errors }
}

/* -------------------------------------------------------------------------- */
/* write                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Write `results/<suite>-<UTC-stamp>.json` plus `results/latest.json`.
 * `outFile` writes a single file instead; `noWrite` returns null paths.
 */
export function writeQualityReport(report, { outFile = null, outDir = null, noWrite = false, now = null } = {}) {
  if (noWrite) return { path: null, latestPath: null }
  const dir = outFile ? dirname(outFile) : (outDir ?? defaultResultsDir(report.suite))
  mkdirSync(dir, { recursive: true })
  const body = JSON.stringify(report, null, 2) + '\n'
  if (outFile) {
    writeFileSync(outFile, body)
    return { path: outFile, latestPath: null }
  }
  const stamp = utcStamp(now ? new Date(now) : new Date(report.startedAt))
  const path = join(dir, report.suite + '-' + stamp + '.json')
  const latestPath = join(dir, 'latest.json')
  writeFileSync(path, body)
  writeFileSync(latestPath, body)
  return { path, latestPath }
}

/** Read one report JSON file (throws on unreadable/invalid JSON). */
export function readQualityReport(path) {
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error('not a file: ' + path)
  return JSON.parse(readFileSync(path, 'utf8'))
}

export default Object.freeze({
  REPO_ROOT,
  QUALITY_SCHEMA_VERSION,
  QUALITY_BASELINE_PATH,
  QUALITY_SCHEMA_PATH,
  STANDARD_UNKNOWN_DIMENSIONS,
  sha256Hex,
  sha256File,
  corpusSha256,
  fileManifest,
  productVersion,
  collectCliInfo,
  standardUnknowns,
  gate,
  defaultResultsDir,
  qualityBaselineReference,
  buildQualityReport,
  sanitizeQualityReport,
  validateQualityReport,
  writeQualityReport,
  readQualityReport,
})
