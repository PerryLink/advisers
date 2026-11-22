#!/usr/bin/env node
/**
 * Local mail extraction quality gold eval - 'pnpm eval:mail-local'.
 *
 * Zero model, zero network, no ADVISERS_HOME: every .eml fixture is parsed with
 * the parser used by 'mail import' (packages/advisers/lib/mail-parse.js) and then
 * scored with the default local rule path (packages/advisers/lib/mail-extract.js
 * extractLocalCandidates), which is exactly the branch 'mail extract --local' runs.
 *
 * Gold set layout (eval/mail-local-gold/README.md): labels.json schema v2 with
 * 90 dev + 30 held-out fixtures. Each case carries split/provenance/reviewStatus;
 * the top-level corpusSha256 freezes all fixture bytes. L0 (PR) runs only
 * '--split dev'; the held-out split is release-gate only and must not be used to
 * tune the extractor. The output is a schema-v2 quality report
 * (eval/lib/quality-report.mjs) so 'scripts/check-eval-report.mjs' can validate it.
 *
 * Usage:
 *   node eval/run-mail-local-gold.mjs [--json] [--verbose] [--list]
 *     [--split dev|heldout] [--fixtures <dir>] [--no-write] [--help]
 *
 * Exit codes: 0 all gated metrics pass; 1 a metric or the gold set failed;
 * 2 usage error.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractLocalCandidates } from '../packages/advisers/lib/mail-extract.js'
import { parseMailMessage } from '../packages/advisers/lib/mail-parse.js'
import {
  buildQualityReport,
  corpusSha256,
  fileManifest,
  gate,
  sanitizeQualityReport,
  sha256Hex,
  standardUnknowns,
  validateQualityReport,
  writeQualityReport,
} from './lib/quality-report.mjs'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const DEFAULT_FIXTURES = fileURLToPath(new URL('./mail-local-gold/', import.meta.url))
const GOLD_SCHEMA = 'advisers.mail-local-gold/v2'
const LEGACY_GOLD_SCHEMA = 'advisers.mail-local-gold/v1'
const TIME_ZONE = 'Asia/Shanghai'

// Release-gate thresholds for the deterministic local rules: synthetic regression
// gates, not claims of general-world accuracy. Dev runs in L0; held-out runs only
// in the release gate with the looser thresholds from plan 123 section 5.
const SPLITS = Object.freeze({
  dev: Object.freeze({
    fixtures: 90,
    gated: Object.freeze(['precision', 'recall', 'f1', 'dueAccuracy', 'authorAccuracy', 'negativeFalsePositiveRate']),
    targets: Object.freeze({ precision: 0.9, recall: 0.85, f1: 0.85, dueAccuracy: 0.85, authorAccuracy: 0.9, negativeFalsePositiveRate: 0.1 }),
  }),
  heldout: Object.freeze({
    fixtures: 30,
    gated: Object.freeze(['precision', 'recall', 'f1', 'dueAccuracy', 'negativeFalsePositiveRate']),
    targets: Object.freeze({ precision: 0.85, recall: 0.8, f1: 0.82, dueAccuracy: 0.85, negativeFalsePositiveRate: 0.1 }),
  }),
})
const CUSTOM_SPLIT = Object.freeze({
  fixtures: null,
  gated: SPLITS.dev.gated,
  targets: SPLITS.dev.targets,
})
const METRIC_LABELS = Object.freeze({
  precision: 'candidate precision',
  recall: 'candidate recall',
  f1: 'candidate F1',
  dueAccuracy: 'due accuracy',
  authorAccuracy: 'author accuracy',
  negativeFalsePositiveRate: 'negative false-positive rate',
  amountAccuracy: 'amount accuracy',
  messagePrecision: 'message precision',
  messageRecall: 'message recall',
  messageF1: 'message F1',
})
const STRIP_VERB_RE = /^(?:发送|发给|发出|发|提交|交付|回复|答复|确认|提供|完成|准备|整理|支付|打款|付款|寄|送|对接|处理|反馈|跟进|汇报|报价|回访|续约|安排|上线|签署|签|send|submit|deliver|reply|confirm|provide|finish|complete|pay|share|prepare|upload|review|fix|quote)/i

function round4(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 1
}

/** A rate whose denominator can legitimately be zero (e.g. no negative messages). */
function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0
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

function normalize(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

function stripLeadingVerb(value) {
  return normalize(value).replace(STRIP_VERB_RE, '')
}

function actionMatches(predictedAction, expectedAction) {
  const predicted = normalize(predictedAction)
  const expected = normalize(expectedAction)
  if (!predicted || !expected) return false
  if (predicted === expected || predicted.includes(expected) || expected.includes(predicted)) return true
  const predictedStem = stripLeadingVerb(predictedAction)
  const expectedStem = stripLeadingVerb(expectedAction)
  return Boolean(predictedStem && expectedStem) && (predictedStem === expectedStem || predictedStem.includes(expectedStem) || expectedStem.includes(predictedStem))
}

function localDueDate(candidate) {
  if (!candidate || !candidate.dueAt) return null
  const time = Date.parse(candidate.dueAt)
  if (!Number.isFinite(time)) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(time))
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parts = value.split('-').map(Number)
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
  return date.getUTCFullYear() === parts[0] && date.getUTCMonth() === parts[1] - 1 && date.getUTCDate() === parts[2]
}

function listEmlFiles(dir) {
  return readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.eml')).sort()
}

/** Validate labels.json + the fixture directory. Returns errors, never throws. */
function validateGold(labels, fixturesDir, { defaultGold, split }) {
  const errors = []
  const warnings = []
  if (labels == null || typeof labels !== 'object' || Array.isArray(labels)) {
    return { errors: ['labels.json must be a JSON object'], warnings, cases: [], emlFiles: [], splitFiles: [], manifest: [], legacy: false }
  }
  const legacy = labels.schema === LEGACY_GOLD_SCHEMA
  if (!legacy && labels.schema !== GOLD_SCHEMA) errors.push('labels.json schema must be "' + GOLD_SCHEMA + '"')
  if (legacy && defaultGold) errors.push('the default gold set must use schema "' + GOLD_SCHEMA + '" (legacy v1 is accepted only with --fixtures)')
  if (labels.timeZone !== TIME_ZONE) errors.push('labels.json timeZone must be "' + TIME_ZONE + '"')
  let emlFiles = []
  try { emlFiles = listEmlFiles(fixturesDir) } catch (error) { errors.push('cannot list fixtures directory: ' + String((error && error.message) || error)) }
  const cases = Array.isArray(labels.cases) ? labels.cases : []
  if (!Array.isArray(labels.cases)) errors.push('labels.json cases must be an array')
  if (!cases.length) errors.push('labels.json has no cases')
  const seen = new Set()
  const splitFiles = { dev: [], heldout: [] }
  let expectedTotal = 0
  for (let index = 0; index < cases.length; index += 1) {
    const entry = cases[index]
    const at = 'case #' + (index + 1)
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(at + ': must be an object'); continue }
    if (typeof entry.file !== 'string' || !/^[0-9]{2,3}-[a-z0-9-]+\.eml$/.test(entry.file)) errors.push(at + ': file must match NN-slug.eml')
    else if (seen.has(entry.file)) errors.push(at + ': duplicate fixture file ' + entry.file)
    else seen.add(entry.file)
    if (typeof entry.author !== 'string' || !entry.author.trim()) errors.push((entry.file || at) + ': author must be a non-empty string')
    if (!legacy) {
      if (!Object.prototype.hasOwnProperty.call(SPLITS, entry.split)) errors.push((entry.file || at) + ': split must be "dev" or "heldout"')
      else splitFiles[entry.split].push(entry.file)
      if (typeof entry.provenance !== 'string' || !entry.provenance.trim()) errors.push((entry.file || at) + ': provenance must be a non-empty string')
      if (typeof entry.reviewStatus !== 'string' || !entry.reviewStatus.trim()) errors.push((entry.file || at) + ': reviewStatus must be a non-empty string')
    } else {
      splitFiles.dev.push(entry.file)
    }
    if (!Array.isArray(entry.expect)) { errors.push((entry.file || at) + ': expect must be an array (use [] for a negative case)'); continue }
    expectedTotal += entry.expect.length
    for (let wantIndex = 0; wantIndex < entry.expect.length; wantIndex += 1) {
      const want = entry.expect[wantIndex]
      const wantAt = (entry.file || at) + ' expect[' + wantIndex + ']'
      if (want == null || typeof want !== 'object' || Array.isArray(want)) { errors.push(wantAt + ': must be an object'); continue }
      if (typeof want.action !== 'string' || !normalize(want.action)) errors.push(wantAt + ': action must be a non-empty string')
      if (!(want.dueAt === null || isCalendarDate(want.dueAt))) errors.push(wantAt + ': dueAt must be null or a YYYY-MM-DD calendar date')
      if (want.amountMinor !== undefined) {
        if (!Number.isInteger(want.amountMinor) || want.amountMinor <= 0) errors.push(wantAt + ': amountMinor must be a positive integer')
        if (typeof want.currency !== 'string' || !/^[A-Z]{3}$/.test(want.currency)) errors.push(wantAt + ': currency must be a 3-letter code when amountMinor is set')
      }
    }
  }
  if (expectedTotal === 0) errors.push('the gold set has no labeled commitments')
  if (cases.length && !cases.some((entry) => Array.isArray(entry.expect) && entry.expect.length === 0)) warnings.push('the gold set has no negative cases')
  for (const file of emlFiles) if (!seen.has(file)) errors.push('unlabeled fixture: ' + file)
  for (const file of seen) if (!emlFiles.includes(file)) errors.push('labels.json references a missing fixture: ' + file)
  const manifest = fileManifest(fixturesDir, emlFiles)
  let actualCorpusSha = null
  try { actualCorpusSha = corpusSha256(manifest) } catch (error) { errors.push('cannot hash the fixture corpus: ' + String((error && error.message) || error)) }
  if (!legacy) {
    if (typeof labels.corpusSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(labels.corpusSha256)) errors.push('labels.json corpusSha256 must be a 64-hex sha256')
    else if (actualCorpusSha && labels.corpusSha256.toLowerCase() !== actualCorpusSha) errors.push('corpusSha256 mismatch: the fixture bytes / labels are frozen (mutated fixture or stale hash)')
  }
  if (defaultGold && !legacy) {
    const expectedSplit = SPLITS[split] ? SPLITS[split].fixtures : null
    if (expectedSplit !== null && splitFiles[split].length !== expectedSplit) errors.push('the ' + split + ' split must have exactly ' + expectedSplit + ' .eml fixtures (found ' + splitFiles[split].length + ')')
    for (const other of Object.keys(SPLITS)) {
      if (splitFiles[other].length !== SPLITS[other].fixtures) errors.push('the ' + other + ' split must have exactly ' + SPLITS[other].fixtures + ' .eml fixtures (found ' + splitFiles[other].length + ')')
    }
  }
  return { errors, warnings, cases, emlFiles, splitFiles, manifest, actualCorpusSha, legacy }
}

function extractFixture(fixturesDir, entry) {
  const raw = readFileSync(join(fixturesDir, entry.file), 'utf8')
  const parsed = parseMailMessage(raw)
  const sentMs = Date.parse(parsed.date)
  if (!parsed.date || !Number.isFinite(sentMs)) throw new Error('missing or unparsable Date header')
  if (!parsed.text || !parsed.text.trim()) throw new Error('no readable text body')
  const receivedAt = new Date(sentMs).toISOString()
  const result = extractLocalCandidates({ text: parsed.text, subject: parsed.subject, from: parsed.from, receivedAt })
  return { parsed, receivedAt, candidates: Array.isArray(result.candidates) ? result.candidates : [] }
}

function expectedSummary(expect) {
  return expect.map((want) => ({ action: want && want.action, dueAt: want && want.dueAt == null ? null : want.dueAt }))
}

function predictedSummary(candidates) {
  return candidates.map((candidate) => ({
    action: candidate.action,
    dueAt: localDueDate(candidate),
    debtor: candidate.debtor || null,
    creditor: candidate.creditor == null ? null : candidate.creditor,
    modal: candidate.modal || null,
  }))
}

function runGold({ fixturesDir, labels, split, defaultGold }) {
  const startedAt = Date.now()
  const validation = validateGold(labels, fixturesDir, { defaultGold, split })
  const errors = [...validation.errors]
  const warnings = [...validation.warnings]
  const failures = []
  const rows = []
  const selected = validation.legacy
    ? validation.cases
    : validation.cases.filter((entry) => entry && entry.split === split)
  let expectedTotal = 0
  let matchedExpected = 0
  let candidatesTotal = 0
  let matchedCandidates = 0
  let dueLabeled = 0
  let dueChecked = 0
  let dueOk = 0
  let authorChecked = 0
  let authorOk = 0
  let amountLabeled = 0
  let amountChecked = 0
  let amountOk = 0
  let positiveMessages = 0
  let negativeMessages = 0
  let predictedPositiveMessages = 0
  let messageTP = 0
  let messageFP = 0
  let messageFN = 0
  let fixtureIssues = 0

  if (validation.errors.length === 0) {
    for (const entry of selected) {
      let extracted
      try {
        extracted = extractFixture(fixturesDir, entry)
      } catch (error) {
        const message = String((error && error.message) || error)
        errors.push(entry.file + ': ' + message)
        failures.push({ caseId: String(entry.file), code: 'FIXTURE_ERROR', detailSha256: sha256Hex(message) })
        continue
      }
      const candidates = extracted.candidates
      const expect = Array.isArray(entry.expect) ? entry.expect : []
      const used = new Set()
      const matchedPairs = []
      for (const want of expect) {
        if (!want) continue
        if (want.dueAt != null) dueLabeled += 1
        if (want.amountMinor != null) amountLabeled += 1
        const found = candidates.findIndex((candidate, candidateIndex) => !used.has(candidateIndex) && actionMatches(candidate.action, want.action))
        if (found === -1) continue
        used.add(found)
        matchedPairs.push({ want, candidate: candidates[found] })
      }
      const missing = expect.filter((want) => !matchedPairs.some((pair) => pair.want === want))
      const extra = candidates.filter((candidate, candidateIndex) => !used.has(candidateIndex))
      const dueMismatches = []
      const authorMismatches = []
      const amountMismatches = []
      for (const pair of matchedPairs) {
        const want = pair.want
        const candidate = pair.candidate
        if (want.dueAt != null && localDueDate(candidate) !== want.dueAt) dueMismatches.push({ action: want.action, expected: want.dueAt, got: localDueDate(candidate) })
        if (normalize(candidate.creditor) !== normalize(entry.author)) authorMismatches.push({ action: want.action, expected: entry.author, got: candidate.creditor == null ? null : candidate.creditor })
        if (want.amountMinor != null && (candidate.amountMinor !== want.amountMinor || candidate.currency !== want.currency)) amountMismatches.push({ action: want.action, expected: { amountMinor: want.amountMinor, currency: want.currency }, got: candidate.amountMinor == null ? null : { amountMinor: candidate.amountMinor, currency: candidate.currency } })
      }
      expectedTotal += expect.length
      matchedExpected += matchedPairs.length
      candidatesTotal += candidates.length
      matchedCandidates += used.size
      for (const pair of matchedPairs) {
        if (pair.want.dueAt != null) {
          dueChecked += 1
          if (localDueDate(pair.candidate) === pair.want.dueAt) dueOk += 1
        }
        authorChecked += 1
        if (normalize(pair.candidate.creditor) === normalize(entry.author)) authorOk += 1
        if (pair.want.amountMinor != null) {
          amountChecked += 1
          if (pair.candidate.amountMinor === pair.want.amountMinor && pair.candidate.currency === pair.want.currency) amountOk += 1
        }
      }
      if (expect.length > 0) positiveMessages += 1
      else negativeMessages += 1
      if (candidates.length > 0) predictedPositiveMessages += 1
      if (expect.length > 0 && candidates.length > 0) messageTP += 1
      else if (expect.length > 0) messageFN += 1
      else if (candidates.length > 0) messageFP += 1
      const hasIssues = missing.length || extra.length || dueMismatches.length || authorMismatches.length || amountMismatches.length
      if (hasIssues) fixtureIssues += 1
      rows.push({
        file: entry.file,
        ...(entry.split ? { split: entry.split } : {}),
        author: entry.author,
        ...(entry.topic ? { topic: entry.topic } : {}),
        sentAt: extracted.receivedAt,
        expected: expectedSummary(expect),
        predicted: predictedSummary(candidates),
        matched: matchedPairs.length,
        missing: missing.map((want) => ({ action: want && want.action, dueAt: want && want.dueAt == null ? null : want.dueAt })),
        extra: extra.map((candidate) => ({ action: candidate.action, dueAt: localDueDate(candidate) })),
        dueMismatches,
        authorMismatches,
        amountMismatches,
        ...(entry.note ? { note: entry.note } : {}),
      })
    }
  }

  const precision = ratio(matchedCandidates, candidatesTotal)
  const recall = ratio(matchedExpected, expectedTotal)
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  const messagePrecision = ratio(messageTP, messageTP + messageFP)
  const messageRecall = ratio(messageTP, messageTP + messageFN)
  const messageF1 = messagePrecision + messageRecall > 0 ? (2 * messagePrecision * messageRecall) / (messagePrecision + messageRecall) : 0
  const negativeFalsePositiveRate = rate(messageFP, negativeMessages)
  const metrics = {
    n: selected.length,
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1),
    dueAccuracy: round4(ratio(dueOk, dueChecked)),
    authorAccuracy: round4(ratio(authorOk, authorChecked)),
    amountAccuracy: round4(ratio(amountOk, amountChecked)),
    messagePrecision: round4(messagePrecision),
    messageRecall: round4(messageRecall),
    messageF1: round4(messageF1),
    negativeFalsePositiveRate: round4(negativeFalsePositiveRate),
  }
  const ci95 = {
    precision: wilson(matchedCandidates, candidatesTotal),
    recall: wilson(matchedExpected, expectedTotal),
    dueAccuracy: wilson(dueOk, dueChecked),
    authorAccuracy: wilson(authorOk, authorChecked),
    negativeFalsePositiveRate: wilson(messageFP, negativeMessages),
  }
  const counts = {
    matchedExpected, matchedCandidates, dueLabeled, dueOk, dueChecked, authorOk, authorChecked,
    amountLabeled, amountOk, amountChecked, messageTP, messageFP, messageFN,
  }
  const gold = {
    fixtures: selected.length,
    positiveMessages,
    negativeMessages,
    expectedCandidates: expectedTotal,
    predictedCandidates: candidatesTotal,
    dueLabeled,
    amountLabeled,
    fixtureIssues,
  }
  return { startedAt, durationMs: Date.now() - startedAt, validation, selected, rows, metrics, ci95, counts, gold, errors, warnings, failures }
}

function metricPass(result, metric, targets) {
  const threshold = targets[metric]
  if (threshold === undefined) return true
  const actual = result.metrics[metric]
  return metric === 'negativeFalsePositiveRate' ? actual <= threshold : actual >= threshold
}

function formatPercent(value) {
  return Number.isFinite(value) ? (value * 100).toFixed(1) + '%' : 'n/a'
}

function countDetail(metric, result) {
  const c = result.counts
  if (metric === 'precision') return c.matchedCandidates + '/' + result.gold.predictedCandidates
  if (metric === 'recall') return c.matchedExpected + '/' + result.gold.expectedCandidates
  if (metric === 'f1') return ''
  if (metric === 'dueAccuracy') return c.dueOk + '/' + c.dueChecked
  if (metric === 'authorAccuracy') return c.authorOk + '/' + c.authorChecked
  if (metric === 'negativeFalsePositiveRate') return c.messageFP + '/' + result.gold.negativeMessages
  return ''
}

function issueLines(result) {
  const lines = []
  for (const row of result.rows) {
    const issues = []
    for (const missing of row.missing) issues.push('missing commitment: ' + JSON.stringify(missing.action))
    for (const extra of row.extra) issues.push('unexpected candidate: ' + JSON.stringify(extra.action))
    for (const mismatch of row.dueMismatches) issues.push('due mismatch for ' + JSON.stringify(mismatch.action) + ': expected ' + String(mismatch.expected) + ', got ' + String(mismatch.got))
    for (const mismatch of row.authorMismatches) issues.push('author mismatch for ' + JSON.stringify(mismatch.action) + ': expected ' + String(mismatch.expected) + ', got ' + String(mismatch.got))
    for (const mismatch of row.amountMismatches) issues.push('amount mismatch for ' + JSON.stringify(mismatch.action) + ': expected ' + JSON.stringify(mismatch.expected) + ', got ' + JSON.stringify(mismatch.got))
    if (!issues.length) continue
    const known = row.note && /^Known/i.test(row.note) ? ' [documented known limitation]' : ''
    for (const issue of issues) lines.push('  - ' + row.file + known + ': ' + issue)
  }
  return lines
}

function renderHuman(report) {
  const data = report.environment
  const result = { ...data.result, rows: Array.isArray(report.cases) ? report.cases : [] }
  const lines = []
  lines.push('advisers eval:mail-local - local mail extraction gold set (' + data.split + ' split)')
  lines.push('')
  lines.push('fixtures : ' + result.gold.fixtures + ' .eml (' + result.gold.positiveMessages + ' with commitments, ' + result.gold.negativeMessages + ' negative) in ' + data.fixtureDir)
  lines.push('gold     : ' + result.gold.expectedCandidates + ' labeled commitments, ' + result.gold.dueLabeled + ' with a due date, ' + result.gold.amountLabeled + ' with an amount')
  lines.push('rules    : ' + result.gold.predictedCandidates + ' local candidates; model calls 0; network attempts ' + report.network.attempts)
  lines.push('corpus   : sha256=' + data.corpusSha256.slice(0, 16) + '... (' + report.corpus.rows + ' fixtures total, frozen)')
  lines.push('')
  for (const metric of data.gated) {
    const threshold = data.targets[metric]
    const actual = result.metrics[metric]
    const pass = metricPass(result, metric, data.targets)
    const op = metric === 'negativeFalsePositiveRate' ? '<=' : '>=' 
    lines.push('  ' + METRIC_LABELS[metric].padEnd(28) + formatPercent(actual).padStart(7) + '  ' + countDetail(metric, result).padEnd(10) + (pass ? 'PASS' : 'FAIL') + '  (threshold ' + op + ' ' + formatPercent(threshold) + ')')
  }
  lines.push('')
  lines.push('reported, not gated: message precision ' + formatPercent(result.metrics.messagePrecision) + ', message recall ' + formatPercent(result.metrics.messageRecall) + ', amount accuracy ' + formatPercent(result.metrics.amountAccuracy))
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
  const failedGates = report.gates.filter((g) => !g.pass)
  if (failedGates.length) {
    lines.push('')
    lines.push('threshold failures (' + failedGates.length + '):')
    for (const failure of failedGates) lines.push('  - ' + failure.id + ' ' + formatPercent(failure.actual) + ' failed ' + failure.operator + ' ' + formatPercent(failure.threshold))
  }
  const issues = issueLines(result)
  if (issues.length) {
    lines.push('')
    lines.push('fixture-level issues (' + issues.length + '):')
    for (const issue of issues) lines.push(issue)
  }
  lines.push('')
  lines.push(report.totals.failed === 0 && failedGates.length === 0 && result.errors.length === 0
    ? 'PASS - all gated metrics meet their thresholds.'
    : 'FAIL - see failures above.')
  return lines.join('\n')
}

function parseArgs(argv) {
  const options = { json: false, verbose: false, list: false, fixtures: null, split: 'dev', noWrite: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--list') options.list = true
    else if (arg === '--no-write') options.noWrite = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--split') {
      const value = argv[++index]
      if (!value) throw new Error('--split needs dev or heldout')
      options.split = value
    } else if (arg.startsWith('--split=')) {
      const value = arg.slice('--split='.length)
      if (!value) throw new Error('--split needs dev or heldout')
      options.split = value
    } else if (arg === '--fixtures') {
      const value = argv[++index]
      if (!value) throw new Error('--fixtures needs a directory path')
      options.fixtures = value
    } else if (arg.startsWith('--fixtures=')) {
      const value = arg.slice('--fixtures='.length)
      if (!value) throw new Error('--fixtures needs a directory path')
      options.fixtures = value
    } else {
      throw new Error('unknown argument: ' + arg)
    }
  }
  if (!options.fixtures && !Object.prototype.hasOwnProperty.call(SPLITS, options.split)) throw new Error('unknown split: ' + options.split + ' (use dev or heldout)')
  if (options.fixtures && options.split !== 'dev') throw new Error('--split only applies to the default gold set; --fixtures scores one custom directory')
  return options
}

function printHelp() {
  console.log([
    'usage: node eval/run-mail-local-gold.mjs [--json] [--verbose] [--list] [--split dev|heldout] [--fixtures <dir>] [--no-write] [--help]',
    '',
    '  --json             print the schema-v2 quality report JSON on stdout',
    '  --verbose          include per-fixture PASS/FAIL lines in the human report',
    '  --list             list the gold fixtures and their expected commitment counts',
    '  --split dev        score the 90 dev fixtures (default; the L0 PR gate)',
    '  --split heldout    score the 30 held-out fixtures (release gate only; never tune on it)',
    '  --fixtures <dir>   score another gold directory (labels.json + .eml files; v1 labels accepted)',
    '  --no-write         do not write eval/results/mail-local-gold/<stamp>.json + latest.json',
    '  --help             show this help',
    '',
    'Zero model, zero network, zero ADVISERS_HOME writes. Exit 0 when every gated',
    'metric meets its threshold; exit 1 otherwise; exit 2 on usage errors.',
  ].join('\n'))
}

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) {
    console.error('advisers eval:mail-local: ' + String((error && error.message) || error))
    return 2
  }
  if (options.help) { printHelp(); return 0 }

  const fixturesDir = options.fixtures ? resolve(options.fixtures) : DEFAULT_FIXTURES
  const defaultGold = !options.fixtures
  let labels
  try {
    labels = JSON.parse(readFileSync(join(fixturesDir, 'labels.json'), 'utf8'))
  } catch (error) {
    console.error('advisers eval:mail-local: cannot read gold labels from ' + join(fixturesDir, 'labels.json') + ': ' + String((error && error.message) || error))
    return 1
  }

  if (options.list) {
    const validation = validateGold(labels, fixturesDir, { defaultGold, split: options.split })
    if (validation.errors.length) {
      for (const error of validation.errors) console.error('advisers eval:mail-local: ' + error)
      return 1
    }
    for (const entry of validation.cases) {
      const split = entry.split || 'dev'
      const due = (entry.expect || []).filter((want) => want && want.dueAt != null).length
      console.log(split.padEnd(8) + entry.file.padEnd(36) + ' expected=' + String((entry.expect || []).length) + ' due=' + String(due) + (entry.expect && entry.expect.length === 0 ? '  (negative)' : ''))
    }
    return 0
  }

  // The local path is pure and synchronous, but guard network access anyway so
  // an accidental future import that reaches for the network fails loudly.
  let networkAttempts = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = function guardedFetch() {
    networkAttempts += 1
    throw new Error('network is forbidden in the mail local gold eval')
  }
  let result
  try {
    result = runGold({ fixturesDir, labels, split: options.split, defaultGold })
  } finally {
    globalThis.fetch = originalFetch
  }
  if (networkAttempts > 0) result.errors.push('network attempts detected: ' + networkAttempts)

  const splitName = defaultGold ? options.split : 'custom'
  const profile = defaultGold ? SPLITS[options.split] : CUSTOM_SPLIT
  const gates = profile.gated.map((metric) => gate('mail.' + metric, result.metrics[metric], profile.targets[metric], metric === 'negativeFalsePositiveRate' ? '<=' : '>='))
  gates.push(gate('mail.gold_valid', result.errors.length === 0 ? 1 : 0, 1, '='))
  const failedGates = gates.filter((entry) => !entry.pass)
  const fixtureRelative = relative(REPO_ROOT, fixturesDir).replaceAll('\\', '/') || '.'
  const splitManifest = result.validation.manifest.filter((entry) => result.selected.some((row) => row.file === entry.relpath))
  const corpusSha = result.validation.actualCorpusSha ?? corpusSha256(result.validation.manifest)
  const command = ['node', 'eval/run-mail-local-gold.mjs', '--json']
  if (defaultGold) command.push('--split', options.split)
  else command.push('--fixtures', '<FIXTURES>')

  const report = buildQualityReport({
    suite: 'mail-local-gold',
    suiteVersion: 2,
    mode: 'local-gold',
    startedAt: new Date(result.startedAt).toISOString(),
    durationMs: result.durationMs,
    command,
    filters: ['split:' + splitName],
    corpus: {
      id: 'mail-local-gold',
      sha256: corpusSha,
      rows: result.validation.cases.length,
      provenance: 'synthetic',
      reviewMode: defaultGold ? (labels.reviewMode || 'implementer-labeled-synthetic') : 'custom-fixtures',
      license: defaultGold ? (labels.license || 'CC-BY-NC-SA-4.0') : 'unspecified',
      split: splitName,
      ...(defaultGold ? { note: '90 dev + 30 held-out synthetic fixtures; held-out is frozen by corpusSha256 and runs only in the release gate.' } : {}),
    },
    fixtures: { sha256: corpusSha256(splitManifest), count: result.selected.length },
    model: null,
    metrics: { ...result.metrics, ci95: result.ci95, counts: result.counts, gold: result.gold, thresholds: profile.targets },
    gates,
    totals: {
      cases: 1,
      passed: result.errors.length === 0 && failedGates.length === 0 ? 1 : 0,
      failed: result.errors.length === 0 && failedGates.length === 0 ? 0 : 1,
      checks: gates.length,
      checksFailed: failedGates.length,
    },
    network: { guarded: true, attempts: networkAttempts },
    unknowns: standardUnknowns(),
    failures: result.failures,
    cases: result.rows,
    environment: {
      split: splitName,
      gated: [...profile.gated],
      targets: profile.targets,
      fixtureDir: fixtureRelative,
      corpusSha256: corpusSha,
      goldSchema: labels.schema || null,
      gold: result.gold,
      result: { metrics: result.metrics, counts: result.counts, gold: result.gold, warnings: result.warnings, errors: result.errors },
    },
  })
  const sanitized = sanitizeQualityReport(report, { roots: [fixturesDir, REPO_ROOT] })
  const verdict = validateQualityReport(sanitized)
  const path = writeQualityReport(sanitized, { noWrite: options.noWrite })

  if (options.verbose && !options.json) {
    for (const row of result.rows) {
      const ok = !row.missing.length && !row.extra.length && !row.dueMismatches.length && !row.authorMismatches.length && !row.amountMismatches.length
      console.log((ok ? 'PASS ' : 'FAIL ') + row.file + ' expected=' + row.expected.length + ' predicted=' + row.predicted.length + ' matched=' + row.matched)
    }
    console.log('')
  }
  if (options.json) process.stdout.write(JSON.stringify(sanitized, null, 2) + '\n')
  else {
    console.log(renderHuman(sanitized))
    if (path.path) console.log('\nreport: ' + path.path)
  }
  if (!verdict.ok) {
    for (const error of verdict.errors) console.error('advisers eval:mail-local: report invalid: ' + error.code + ' at ' + error.path + ': ' + error.message)
    return 1
  }
  return result.errors.length === 0 && failedGates.length === 0 ? 0 : 1
}

main().then((code) => {
  process.exit(code)
}).catch((error) => {
  console.error('advisers eval:mail-local: internal error: ' + String((error && error.stack) || error))
  process.exit(2)
})
