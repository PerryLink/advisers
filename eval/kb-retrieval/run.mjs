#!/usr/bin/env node
/**
 * KB lexical-retrieval gold eval - 'pnpm eval:kb-retrieval'.
 *
 * Synthetic zero-model / zero-network gate for 'advisers kb search --scope kb'.
 * The corpus is 25 small markdown documents (eval/kb-retrieval/corpus) and the
 * gold labels are 50 Chinese / mixed queries (eval/kb-retrieval/queries.json):
 * 12 two-character, 18 three-plus-character, 8 mixed CN/EN, 6 title hits and
 * 6 no-hit queries. Everything is imported into a temp ADVISERS_HOME through the
 * real CLI ('kb add'), then every query is scored through the real CLI
 * ('kb search <query> --scope kb --limit 20') so the measured ranking is the
 * shipped lexical path, not a re-implementation.
 *
 * Gated metrics: precisionAt5 >= 0.80, mrrAt10 >= 0.65, shortQueryHitAt5 >= 0.75
 * (the 12 two-character queries) and noHitFalsePositiveRate <= 0.10. These are
 * synthetic regression thresholds, not a general retrieval-quality claim.
 *
 * Usage:
 *   node eval/kb-retrieval/run.mjs [--json] [--verbose] [--no-write] [--help]
 *
 * Exit codes: 0 all gated metrics pass; 1 a metric or the corpus failed;
 * 2 usage error.
 */
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildQualityReport, corpusSha256, fileManifest, gate, sanitizeQualityReport, sha256Hex, standardUnknowns, validateQualityReport, writeQualityReport } from '../lib/quality-report.mjs'
import { BIN, buildEnv, cleanupWorkdir, createWorkdir, networkAttempts, parseJson, REPO_ROOT, runCli } from '../det/lib/harness.mjs'

const CORPUS_DIR = fileURLToPath(new URL('./corpus/', import.meta.url))
const QUERIES_PATH = fileURLToPath(new URL('./queries.json', import.meta.url))
const DOCUMENT_COUNT = 25
const QUERY_COUNT = 50
const SEARCH_LIMIT = 20
const SEARCH_CONCURRENCY = 8
const TARGETS = Object.freeze({ precisionAt5: 0.8, mrrAt10: 0.65, shortQueryHitAt5: 0.75, noHitFalsePositiveRate: 0.1 })
const GATED_METRICS = Object.freeze(['precisionAt5', 'mrrAt10', 'shortQueryHitAt5', 'noHitFalsePositiveRate'])
const METRIC_LABELS = Object.freeze({
  precisionAt5: 'precision@5',
  mrrAt10: 'MRR@10',
  shortQueryHitAt5: '2-char hit@5',
  noHitFalsePositiveRate: 'no-hit false-positive rate',
})
const SCHEMA = 'advisers.kb-retrieval/v1'

function round4(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null
}

/** Wilson score 95% interval for a binomial proportion; nulls when n = 0. */
function wilson(successes, total) {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || total <= 0) return { low: null, high: null, n: 0 }
  const z = 1.959963984540054
  const p = successes / total
  const denominator = 1 + (z * z) / total
  const centre = p + (z * z) / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)
  return { low: Math.max(0, round4((centre - margin) / denominator)), high: Math.min(1, round4((centre + margin) / denominator)), n: total }
}

function listCorpusFiles() {
  return readdirSync(CORPUS_DIR).filter((file) => file.endsWith('.md')).sort()
}

/** Normal-approximation 95% CI for a mean score in [0,1]; nulls when n < 2. */
function meanCi(values) {
  const n = Array.isArray(values) ? values.length : 0
  if (n < 2) return { low: null, high: null, n }
  const mean = values.reduce((sum, value) => sum + value, 0) / n
  const variance = values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / (n - 1)
  const margin = 1.959963984540054 * Math.sqrt(variance / n)
  return { low: Math.max(0, round4(mean - margin)), high: Math.min(1, round4(mean + margin)), n }
}

/** Validate queries.json + the corpus directory. Returns errors, never throws. */
function validateGold(queriesDoc, corpusFiles) {
  const errors = []
  const warnings = []
  if (queriesDoc == null || typeof queriesDoc !== 'object' || Array.isArray(queriesDoc)) {
    return { errors: ['queries.json must be a JSON object'], warnings, queries: [], documentFiles: corpusFiles }
  }
  if (queriesDoc.schema !== SCHEMA) errors.push('queries.json schema must be "' + SCHEMA + '"')
  if (corpusFiles.length !== DOCUMENT_COUNT) errors.push('the corpus must have exactly ' + DOCUMENT_COUNT + ' markdown documents (found ' + corpusFiles.length + ')')
  const documented = Array.isArray(queriesDoc.documents) ? queriesDoc.documents : []
  if (!Array.isArray(queriesDoc.documents)) errors.push('queries.json documents must be an array')
  for (const name of documented) if (!corpusFiles.includes(name)) errors.push('queries.json references a missing document: ' + String(name))
  for (const name of corpusFiles) if (!documented.includes(name)) errors.push('unlabeled corpus document: ' + name)
  const queries = Array.isArray(queriesDoc.queries) ? queriesDoc.queries : []
  if (!Array.isArray(queriesDoc.queries)) errors.push('queries.json queries must be an array')
  if (queries.length !== QUERY_COUNT) errors.push('the gold set must have exactly ' + QUERY_COUNT + ' queries (found ' + queries.length + ')')
  const expectedCategories = queriesDoc.categories && typeof queriesDoc.categories === 'object' ? queriesDoc.categories : {}
  const categoryCounts = {}
  const ids = new Set()
  let positive = 0
  let noHit = 0
  for (let index = 0; index < queries.length; index += 1) {
    const entry = queries[index]
    const at = 'query #' + (index + 1)
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(at + ': must be an object'); continue }
    if (typeof entry.id !== 'string' || !entry.id.trim()) errors.push(at + ': id must be a non-empty string')
    else if (ids.has(entry.id)) errors.push(at + ': duplicate id ' + entry.id)
    else ids.add(entry.id)
    if (typeof entry.query !== 'string' || !entry.query.trim()) errors.push((entry.id || at) + ': query must be a non-empty string')
    if (typeof entry.category !== 'string' || !entry.category.trim()) errors.push((entry.id || at) + ': category must be a non-empty string')
    else categoryCounts[entry.category] = (categoryCounts[entry.category] || 0) + 1
    if (!Array.isArray(entry.relevant)) { errors.push((entry.id || at) + ': relevant must be an array'); continue }
    for (const name of entry.relevant) if (!documented.includes(name)) errors.push((entry.id || at) + ': relevant document is not in documents: ' + String(name))
    if (entry.category === 'no-hit') {
      noHit += 1
      if (entry.relevant.length) errors.push((entry.id || at) + ': a no-hit query must have relevant: []')
    } else {
      positive += 1
      if (!entry.relevant.length) errors.push((entry.id || at) + ': a positive query needs at least one relevant document')
    }
  }
  for (const [category, expected] of Object.entries(expectedCategories)) {
    if ((categoryCounts[category] || 0) !== Number(expected)) errors.push('category ' + category + ' must have ' + expected + ' queries (found ' + (categoryCounts[category] || 0) + ')')
  }
  for (const category of Object.keys(categoryCounts)) {
    if (expectedCategories[category] === undefined) errors.push('category ' + category + ' is not declared in queries.json categories')
  }
  if (!positive) errors.push('the gold set has no positive queries')
  if (!noHit) warnings.push('the gold set has no no-hit queries')
  return { errors, warnings, queries, documentFiles: corpusFiles, positive, noHit, categoryCounts }
}

function hitSourceNames(hits, idMap) {
  const names = []
  const seen = new Set()
  for (const hit of Array.isArray(hits) ? hits : []) {
    const name = idMap.get(String(hit.docId ?? ''))
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * Async CLI runner for the per-query searches: 50 search processes run in a
 * bounded pool (8 at a time) so the gate stays inside the L0 time budget. Each
 * run keeps the harness environment (temp HOME, blocked network, per-run log),
 * so the zero-network assertion is unchanged.
 */
function runCliAsync(workdir, args, { index, timeoutMs = 30000 } = {}) {
  const logPath = join(workdir.net, 'attempt-' + index + '.log')
  const env = buildEnv(workdir, { networkLog: logPath })
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: workdir.work, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ args, status, stdout, stderr, network: networkAttempts(logPath) })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ args, status: null, stdout, stderr: String(error && error.message || error), network: networkAttempts(logPath) })
    })
  })
}

/** Run promise-returning tasks with a bounded concurrency (order preserved). */
async function runPool(tasks, limit) {
  const results = new Array(tasks.length)
  let next = 0
  async function worker() {
    for (;;) {
      const index = next
      next += 1
      if (index >= tasks.length) return
      results[index] = await tasks[index]()
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, () => worker())
  await Promise.all(workers)
  return results
}

/** Import the corpus and score every query through the shipped CLI. */
async function runGold(queriesDoc, documentFiles) {
  const startedAt = Date.now()
  const validation = validateGold(queriesDoc, documentFiles)
  const errors = [...validation.errors]
  const warnings = [...validation.warnings]
  const failures = []
  const rows = []
  const runLogs = []
  let degradedQueries = 0
  const workdir = createWorkdir('kb-retrieval')
  try {
    const documentPaths = documentFiles.map((name) => join(CORPUS_DIR, name))
    const addRun = runCli(workdir, ['kb', 'add', ...documentPaths, '--json'], { timeoutMs: 60000 })
    runLogs.push(addRun)
    const added = parseJson(addRun.stdout)
    if (addRun.status !== 0 || !added.ok || added.value?.ok !== true) errors.push('kb add failed (status ' + addRun.status + '): ' + String(added.error || addRun.stderr).slice(0, 300))
    else if (added.value?.counts?.added !== validation.documentFiles.length) errors.push('kb add imported ' + added.value?.counts?.added + ' documents, expected ' + validation.documentFiles.length)
    const listRun = runCli(workdir, ['kb', 'ls', '--all', '--limit', '200', '--json'], { timeoutMs: 30000 })
    runLogs.push(listRun)
    const listed = parseJson(listRun.stdout)
    if (listRun.status !== 0 || !listed.ok) errors.push('kb ls failed (status ' + listRun.status + ')')
    const idMap = new Map()
    const importedNames = new Set()
    for (const row of Array.isArray(listed.value?.documents) ? listed.value.documents : []) {
      const name = String(row.sourceName ?? '').trim()
      if (!name) continue
      idMap.set(String(row.id), name)
      importedNames.add(name)
    }
    for (const name of validation.documentFiles) {
      if (!importedNames.has(name)) errors.push('imported KB is missing document: ' + name)
    }
    if (validation.errors.length === 0) {
      const searchRuns = await runPool(validation.queries.map((entry, index) => () => runCliAsync(workdir, ['kb', 'search', entry.query, '--scope', 'kb', '--limit', String(SEARCH_LIMIT), '--json'], { index: 'search-' + index })), SEARCH_CONCURRENCY)
      for (let queryIndex = 0; queryIndex < validation.queries.length; queryIndex += 1) {
        const entry = validation.queries[queryIndex]
        const searchRun = searchRuns[queryIndex]
        runLogs.push(searchRun)
        const parsed = parseJson(searchRun.stdout)
        if (searchRun.status !== 0 || !parsed.ok) {
          const message = 'kb search failed for ' + entry.id + ' (status ' + searchRun.status + ')'
          errors.push(message)
          failures.push({ caseId: String(entry.id), code: 'SEARCH_ERROR', detailSha256: sha256Hex(message) })
          continue
        }
        const value = parsed.value
        const ranked = hitSourceNames(value?.hits, idMap)
        const top5 = ranked.slice(0, 5)
        const top10 = ranked.slice(0, 10)
        const firstRelevant = ranked.findIndex((name) => entry.relevant.includes(name)) + 1
        const relevantTop5 = entry.relevant.filter((name) => top5.includes(name)).length
        const degraded = Array.isArray(value?.degraded) ? value.degraded.map(String) : []
        if (degraded.length) degradedQueries += 1
        const matchPaths = {}
        for (const hit of Array.isArray(value?.hits) ? value.hits : []) {
          const matchPath = String(hit.matchPath ?? 'unknown')
          matchPaths[matchPath] = (matchPaths[matchPath] || 0) + 1
        }
        rows.push({
          id: entry.id,
          query: entry.query,
          category: entry.category,
          relevant: entry.relevant,
          rank: firstRelevant || null,
          relevantTop5,
          top5,
          top10,
          hits: ranked.length,
          total: Number(value?.total ?? 0),
          matchPaths,
          degraded,
          ...(entry.note ? { note: entry.note } : {}),
        })
      }
    }
  } finally {
    cleanupWorkdir(workdir)
  }
  // Failure text can carry the temp workdir path; the report must stay free of
  // absolute paths, so scrub the roots the harness handed out before reporting.
  const scrub = (value) => {
    let text = String(value == null ? '' : value)
    for (const [from, to] of [[workdir.root, '<TMP>'], [workdir.home, '<HOME>'], [workdir.work, '<WORK>'], [workdir.net, '<NET>'], [REPO_ROOT, '<REPO>']]) {
      if (!from) continue
      text = text.split(from).join(to).split(from.replaceAll('\\', '/')).join(to)
    }
    return text
  }
  const scrubbedErrors = errors.map(scrub)
  const scrubbedWarnings = warnings.map(scrub)
  const networkAttempts = runLogs.reduce((sum, run) => sum + (Array.isArray(run.network) ? run.network.length : 0), 0)

  const positiveRows = rows.filter((row) => row.relevant.length > 0)
  const noHitRows = rows.filter((row) => row.category === 'no-hit')
  const shortRows = rows.filter((row) => row.category === 'zh-2char')
  const precisionAt5Scores = positiveRows.map((row) => row.relevantTop5 / Math.min(5, row.relevant.length))
  const reciprocalRankScores = positiveRows.map((row) => (row.rank && row.rank <= 10 ? 1 / row.rank : 0))
  const precisionAt5 = positiveRows.length
    ? precisionAt5Scores.reduce((sum, value) => sum + value, 0) / positiveRows.length
    : 0
  const mrrAt10 = positiveRows.length
    ? reciprocalRankScores.reduce((sum, value) => sum + value, 0) / positiveRows.length
    : 0
  const shortHits = shortRows.filter((row) => row.rank && row.rank <= 5).length
  const shortQueryHitAt5 = shortRows.length ? shortHits / shortRows.length : 0
  const noHitFalsePositives = noHitRows.filter((row) => row.hits > 0).length
  const noHitFalsePositiveRate = noHitRows.length ? noHitFalsePositives / noHitRows.length : 0
  const metrics = {
    n: positiveRows.length,
    precisionAt5: round4(precisionAt5),
    mrrAt10: round4(mrrAt10),
    shortQueryHitAt5: round4(shortQueryHitAt5),
    noHitFalsePositiveRate: round4(noHitFalsePositiveRate),
  }
  const ci95 = {
    precisionAt5: meanCi(precisionAt5Scores),
    mrrAt10: meanCi(reciprocalRankScores),
    shortQueryHitAt5: wilson(shortHits, shortRows.length),
    noHitFalsePositiveRate: wilson(noHitFalsePositives, noHitRows.length),
  }
  const counts = {
    documents: documentFiles.length,
    queries: rows.length,
    positiveQueries: positiveRows.length,
    shortQueries: shortRows.length,
    shortQueriesHitAt5: shortHits,
    noHitQueries: noHitRows.length,
    noHitFalsePositives,
    degradedQueries,
    queriesWithRelevantInTop5: positiveRows.filter((row) => row.relevantTop5 > 0).length,
    queriesWithRelevantInTop10: positiveRows.filter((row) => row.top10.some((name) => row.relevant.includes(name))).length,
  }
  return { startedAt, durationMs: Date.now() - startedAt, validation, rows, metrics, ci95, counts, errors: scrubbedErrors, warnings: scrubbedWarnings, failures, networkAttempts }
}

function metricPass(metric, actual) {
  return metric === 'noHitFalsePositiveRate' ? actual <= TARGETS[metric] : actual >= TARGETS[metric]
}

function formatPercent(value) {
  return Number.isFinite(value) ? (value * 100).toFixed(1) + '%' : 'n/a'
}

function renderHuman(report) {
  const data = report.environment
  const result = { ...data.result, rows: Array.isArray(report.cases) ? report.cases : [] }
  const lines = []
  lines.push('advisers eval:kb-retrieval - KB lexical retrieval gold set')
  lines.push('')
  lines.push('corpus   : ' + result.counts.documents + ' synthetic markdown documents in ' + data.corpusDir)
  lines.push('queries  : ' + result.counts.queries + ' (' + result.counts.positiveQueries + ' positive, ' + result.counts.noHitQueries + ' no-hit; ' + result.counts.shortQueries + ' two-character)')
  lines.push('path     : shipped CLI (kb add + kb search --scope kb --limit 20); model calls 0; network attempts ' + report.network.attempts)
  lines.push('corpus   : sha256=' + data.corpusSha256.slice(0, 16) + '...; degraded queries=' + result.counts.degradedQueries)
  lines.push('')
  for (const metric of GATED_METRICS) {
    const actual = result.metrics[metric]
    const threshold = TARGETS[metric]
    const pass = metricPass(metric, actual)
    const op = metric === 'noHitFalsePositiveRate' ? '<=' : '>=' 
    const detail = metric === 'shortQueryHitAt5'
      ? result.counts.shortQueriesHitAt5 + '/' + result.counts.shortQueries
      : metric === 'noHitFalsePositiveRate'
        ? result.counts.noHitFalsePositives + '/' + result.counts.noHitQueries
        : ''
    lines.push('  ' + METRIC_LABELS[metric].padEnd(30) + formatPercent(actual).padStart(7) + '  ' + detail.padEnd(8) + (pass ? 'PASS' : 'FAIL') + '  (threshold ' + op + ' ' + formatPercent(threshold) + ')')
  }
  lines.push('')
  lines.push('reported, not gated: queries with a relevant doc in top-5 ' + result.counts.queriesWithRelevantInTop5 + '/' + result.counts.positiveQueries + ', in top-10 ' + result.counts.queriesWithRelevantInTop10 + '/' + result.counts.positiveQueries)
  if (result.warnings.length) {
    lines.push('')
    lines.push('warnings:')
    for (const warning of result.warnings) lines.push('  - ' + warning)
  }
  if (result.errors.length) {
    lines.push('')
    lines.push('gold set errors (' + result.errors.length + '):')
    for (const error of result.errors) lines.push('  - ' + error)
  }
  const failedGates = report.gates.filter((entry) => !entry.pass)
  if (failedGates.length) {
    lines.push('')
    lines.push('threshold failures (' + failedGates.length + '):')
    for (const failure of failedGates) lines.push('  - ' + failure.id + ' ' + formatPercent(failure.actual) + ' failed ' + failure.operator + ' ' + formatPercent(failure.threshold))
  }
  const missed = result.rows.filter((row) => row.relevant.length && (!row.rank || row.rank > 10))
  if (missed.length) {
    lines.push('')
    lines.push('positive queries without a relevant hit in top-10 (' + missed.length + '):')
    for (const row of missed) lines.push('  - ' + row.id + ' ' + JSON.stringify(row.query) + ' (' + row.category + ')')
  }
  lines.push('')
  lines.push(failedGates.length === 0 && result.errors.length === 0 ? 'PASS - all gated metrics meet their thresholds.' : 'FAIL - see failures above.')
  return lines.join('\n')
}

function parseArgs(argv) {
  const options = { json: false, verbose: false, noWrite: false, help: false }
  for (const arg of argv) {
    if (arg === '--json') options.json = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--no-write') options.noWrite = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error('unknown argument: ' + arg)
  }
  return options
}

function printHelp() {
  console.log([
    'usage: node eval/kb-retrieval/run.mjs [--json] [--verbose] [--no-write] [--help]',
    '',
    '  --json      print the schema-v2 quality report JSON on stdout',
    '  --verbose   include per-query PASS/FAIL lines in the human report',
    '  --no-write  do not write eval/results/kb-retrieval/<stamp>.json + latest.json',
    '  --help      show this help',
    '',
    'Imports the 25-document synthetic corpus into a temp ADVISERS_HOME with the',
    'real CLI, runs the 50 gold queries, and gates precision@5 / MRR@10 /',
    '2-char hit@5 / no-hit false-positive rate. Zero model, zero network.',
  ].join('\n'))
}

function validationQueryCount(queriesDoc) {
  return Array.isArray(queriesDoc?.queries) ? queriesDoc.queries.length : 0
}

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) {
    console.error('advisers eval:kb-retrieval: ' + String((error && error.message) || error))
    return 2
  }
  if (options.help) { printHelp(); return 0 }

  const documentFiles = listCorpusFiles()
  let queriesDoc
  try {
    queriesDoc = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'))
  } catch (error) {
    console.error('advisers eval:kb-retrieval: cannot read ' + QUERIES_PATH + ': ' + String((error && error.message) || error))
    return 1
  }

  const result = await runGold(queriesDoc, documentFiles)
  const gates = GATED_METRICS.map((metric) => gate('kb.' + metric, result.metrics[metric], TARGETS[metric], metric === 'noHitFalsePositiveRate' ? '<=' : '>='))
  gates.push(gate('kb.gold_valid', result.errors.length === 0 ? 1 : 0, 1, '='))
  const failedGates = gates.filter((entry) => !entry.pass)
  const queryManifest = [{ path: 'queries.json', sha256: sha256Hex(readFileSync(QUERIES_PATH, 'utf8')) }]
  const corpusManifest = fileManifest(CORPUS_DIR, documentFiles)
  const fullCorpusSha = corpusSha256([...corpusManifest.map((entry) => ({ path: 'corpus/' + entry.relpath, sha256: entry.sha256 })), ...queryManifest])
  const queryCount = validationQueryCount(queriesDoc)

  const report = buildQualityReport({
    suite: 'kb-retrieval',
    suiteVersion: 1,
    mode: 'local-gold',
    startedAt: new Date(result.startedAt).toISOString(),
    durationMs: result.durationMs,
    command: ['node', 'eval/kb-retrieval/run.mjs', '--json'],
    filters: ['scope:kb', 'limit:' + SEARCH_LIMIT],
    corpus: {
      id: 'kb-retrieval',
      sha256: fullCorpusSha,
      rows: documentFiles.length + queryCount,
      provenance: 'synthetic',
      reviewMode: String(queriesDoc.reviewMode || 'implementer-labeled-synthetic'),
      license: String(queriesDoc.license || 'CC-BY-NC-SA-4.0'),
      split: 'dev',
      note: documentFiles.length + ' synthetic markdown documents + ' + queryCount + ' gold queries; lexical regression gate, not a general retrieval-quality claim.',
    },
    fixtures: { sha256: corpusSha256(corpusManifest), count: documentFiles.length },
    model: null,
    metrics: { ...result.metrics, ci95: result.ci95, counts: result.counts, thresholds: TARGETS },
    gates,
    totals: {
      cases: 1,
      passed: result.errors.length === 0 && failedGates.length === 0 ? 1 : 0,
      failed: result.errors.length === 0 && failedGates.length === 0 ? 0 : 1,
      checks: gates.length,
      checksFailed: failedGates.length,
    },
    network: { guarded: true, attempts: result.networkAttempts },
    unknowns: standardUnknowns(),
    failures: result.failures,
    cases: result.rows,
    environment: {
      corpusDir: 'eval/kb-retrieval/corpus',
      queriesFile: 'eval/kb-retrieval/queries.json',
      corpusSha256: fullCorpusSha,
      gated: [...GATED_METRICS],
      targets: TARGETS,
      result: {
        metrics: result.metrics,
        ci95: result.ci95,
        counts: result.counts,
        warnings: result.warnings,
        errors: result.errors,
      },
    },
  })
  const sanitized = sanitizeQualityReport(report, { roots: [CORPUS_DIR, REPO_ROOT] })
  const verdict = validateQualityReport(sanitized)
  const path = writeQualityReport(sanitized, { noWrite: options.noWrite })

  if (options.verbose && !options.json) {
    for (const row of result.rows) {
      const ok = row.relevant.length === 0 ? row.hits === 0 : Boolean(row.rank && row.rank <= 10)
      console.log((ok ? 'PASS ' : 'FAIL ') + row.id.padEnd(5) + row.category.padEnd(11) + JSON.stringify(row.query).padEnd(22) + ' rank=' + String(row.rank ?? '-'))
    }
    console.log('')
  }
  if (options.json) process.stdout.write(JSON.stringify(sanitized, null, 2) + '\n')
  else {
    console.log(renderHuman(sanitized))
    if (path.path) console.log('\nreport: ' + path.path)
  }
  if (!verdict.ok) {
    for (const error of verdict.errors) console.error('advisers eval:kb-retrieval: report invalid: ' + error.code + ' at ' + error.path + ': ' + error.message)
    return 1
  }
  return result.errors.length === 0 && failedGates.length === 0 ? 0 : 1
}

main().then((code) => {
  process.exit(code)
}).catch((error) => {
  console.error('advisers eval:kb-retrieval: internal error: ' + String((error && error.stack) || error))
  process.exit(2)
})
