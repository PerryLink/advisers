#!/usr/bin/env node
/**
 * Local mail extraction quality gold eval - 'pnpm eval:mail-local'.
 *
 * Zero model, zero network, no database, no ADVISERS_HOME: every .eml fixture
 * is parsed with the parser used by 'mail import'
 * (packages/advisers/lib/mail-parse.js) and then scored with the default local
 * rule path (packages/advisers/lib/mail-extract.js extractLocalCandidates),
 * which is exactly the branch 'mail extract --local' runs for one stored
 * message.
 *
 * Hand-labeled gold lives in eval/mail-local-gold/ (fixtures + labels.json); see
 * eval/mail-local-gold/README.md for label semantics, metric definitions,
 * thresholds and the documented known limitations.
 *
 * Usage:
 *   node eval/run-mail-local-gold.mjs [--json] [--verbose] [--list]
 *     [--fixtures <dir>] [--help]
 *
 * Exit codes: 0 all gated metrics pass; 1 a metric or the gold set failed;
 * 2 usage error.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractLocalCandidates } from '../packages/advisers/lib/mail-extract.js'
import { parseMailMessage } from '../packages/advisers/lib/mail-parse.js'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const DEFAULT_FIXTURES = fileURLToPath(new URL('./mail-local-gold/', import.meta.url))
const GOLD_SCHEMA = 'advisers.mail-local-gold/v1'
const TIME_ZONE = 'Asia/Shanghai'
const MIN_GOLD_FIXTURES = 20
const MAX_GOLD_FIXTURES = 30

// Release gate for the deterministic local rules: regression thresholds, not
// claims of general-world accuracy. All gated metrics must be met.
const TARGETS = Object.freeze({
  precision: 0.9,
  recall: 0.85,
  f1: 0.85,
  dueAccuracy: 0.85,
  authorAccuracy: 0.9,
})
const GATED_METRICS = Object.freeze(['precision', 'recall', 'f1', 'dueAccuracy', 'authorAccuracy'])
const METRIC_LABELS = Object.freeze({
  precision: 'candidate precision',
  recall: 'candidate recall',
  f1: 'candidate F1',
  dueAccuracy: 'due accuracy',
  authorAccuracy: 'author accuracy',
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

function normalize(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

function stripLeadingVerb(value) {
  return normalize(value).replace(STRIP_VERB_RE, '')
}

/**
 * Candidate matching is action based: exact/normalized inclusion first, then
 * the same comparison after dropping one leading verb (so '发报价单' matches
 * '发出报价单' and 'send updated quote by' matches 'send updated quote').
 */
function actionMatches(predictedAction, expectedAction) {
  const predicted = normalize(predictedAction)
  const expected = normalize(expectedAction)
  if (!predicted || !expected) return false
  if (predicted === expected || predicted.includes(expected) || expected.includes(predicted)) return true
  const predictedStem = stripLeadingVerb(predictedAction)
  const expectedStem = stripLeadingVerb(expectedAction)
  return Boolean(predictedStem && expectedStem) &&
    (predictedStem === expectedStem || predictedStem.includes(expectedStem) || expectedStem.includes(predictedStem))
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

/** Validate labels.json and the fixture directory. Returns errors, never throws. */
function validateGold(labels, fixturesDir, options) {
  const errors = []
  const warnings = []
  if (labels == null || typeof labels !== 'object' || Array.isArray(labels)) {
    return { errors: ['labels.json must be a JSON object'], warnings, cases: [], emlFiles: [] }
  }
  if (labels.schema !== GOLD_SCHEMA) errors.push('labels.json schema must be "' + GOLD_SCHEMA + '"')
  if (labels.timeZone !== TIME_ZONE) errors.push('labels.json timeZone must be "' + TIME_ZONE + '"')
  let emlFiles = []
  try { emlFiles = listEmlFiles(fixturesDir) } catch (error) { errors.push('cannot list fixtures directory: ' + String(error && error.message || error)) }
  const cases = Array.isArray(labels.cases) ? labels.cases : []
  if (!Array.isArray(labels.cases)) errors.push('labels.json cases must be an array')
  if (!cases.length) errors.push('labels.json has no cases')
  else if (options.defaultGold && (cases.length < MIN_GOLD_FIXTURES || cases.length > MAX_GOLD_FIXTURES)) {
    errors.push('the default gold set must have ' + MIN_GOLD_FIXTURES + '-' + MAX_GOLD_FIXTURES + ' .eml fixtures (found ' + cases.length + ')')
  }
  const seen = new Set()
  let expectedTotal = 0
  for (let index = 0; index < cases.length; index += 1) {
    const entry = cases[index]
    const at = 'case #' + (index + 1)
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(at + ': must be an object'); continue }
    if (typeof entry.file !== 'string' || !/^[0-9]{2}-[a-z0-9-]+\.eml$/.test(entry.file)) errors.push(at + ': file must match NN-slug.eml')
    else if (seen.has(entry.file)) errors.push(at + ': duplicate fixture file ' + entry.file)
    else seen.add(entry.file)
    if (typeof entry.author !== 'string' || !entry.author.trim()) errors.push((entry.file || at) + ': author must be a non-empty string')
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
  return { errors, warnings, cases, emlFiles }
}

/** Parse one .eml and run the local extraction branch. Throws on unusable fixtures. */
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

function runGold({ fixturesDir, labels, defaultGold }) {
  const startedAt = Date.now()
  const validation = validateGold(labels, fixturesDir, { defaultGold })
  const errors = [...validation.errors]
  const warnings = [...validation.warnings]
  const rows = []
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

  if (validation.errors.length === 0) {
    for (const entry of validation.cases) {
      let extracted
      try {
        extracted = extractFixture(fixturesDir, entry)
      } catch (error) {
        errors.push(entry.file + ': ' + String(error && error.message || error))
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
        if (want.dueAt != null && localDueDate(candidate) !== want.dueAt) {
          dueMismatches.push({ action: want.action, expected: want.dueAt, got: localDueDate(candidate) })
        }
        if (normalize(candidate.creditor) !== normalize(entry.author)) {
          authorMismatches.push({ action: want.action, expected: entry.author, got: candidate.creditor == null ? null : candidate.creditor })
        }
        if (want.amountMinor != null && (candidate.amountMinor !== want.amountMinor || candidate.currency !== want.currency)) {
          amountMismatches.push({
            action: want.action,
            expected: { amountMinor: want.amountMinor, currency: want.currency },
            got: candidate.amountMinor == null ? null : { amountMinor: candidate.amountMinor, currency: candidate.currency },
          })
        }
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

      rows.push({
        file: entry.file,
        author: entry.author,
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
  const metrics = {
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1),
    dueAccuracy: round4(ratio(dueOk, dueChecked)),
    authorAccuracy: round4(ratio(authorOk, authorChecked)),
    amountAccuracy: round4(ratio(amountOk, amountChecked)),
    messagePrecision: round4(messagePrecision),
    messageRecall: round4(messageRecall),
    messageF1: round4(messageF1),
  }
  const thresholdFailures = []
  if (errors.length === 0) {
    for (const metric of GATED_METRICS) {
      if (metrics[metric] < TARGETS[metric]) {
        thresholdFailures.push({ metric, actual: metrics[metric], threshold: TARGETS[metric], operator: '>=' })
      }
    }
  }
  const passed = errors.length === 0 && thresholdFailures.length === 0

  return {
    suite: 'mail-local-gold',
    schema: labels && labels.schema ? labels.schema : null,
    mode: 'local-rules',
    deterministic: true,
    fixtureDir: relative(REPO_ROOT, fixturesDir) || '.',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    model: { enabled: false, calls: 0 },
    network: { guarded: true, attempts: 0 },
    gold: {
      fixtures: validation.cases.length,
      positiveMessages,
      negativeMessages,
      expectedCandidates: expectedTotal,
      dueLabeled,
      amountLabeled,
    },
    predicted: { candidates: candidatesTotal, positiveMessages: predictedPositiveMessages },
    counts: {
      matchedExpected,
      matchedCandidates,
      dueOk,
      dueChecked,
      authorOk,
      authorChecked,
      amountOk,
      amountChecked,
      messageTP,
      messageFP,
      messageFN,
    },
    metrics,
    thresholds: TARGETS,
    passed,
    thresholdFailures,
    errors,
    warnings,
    cases: rows,
  }
}

function formatPercent(value) {
  return Number.isFinite(value) ? (value * 100).toFixed(1) + '%' : 'n/a'
}

function countDetail(metric, result) {
  const counts = result.counts
  if (metric === 'precision') return counts.matchedCandidates + '/' + result.predicted.candidates
  if (metric === 'recall') return counts.matchedExpected + '/' + result.gold.expectedCandidates
  if (metric === 'f1') return ''
  if (metric === 'dueAccuracy') return counts.dueOk + '/' + counts.dueChecked
  if (metric === 'authorAccuracy') return counts.authorOk + '/' + counts.authorChecked
  return ''
}

function issueLines(result) {
  const lines = []
  for (const row of result.cases) {
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

function renderHuman(result) {
  const lines = []
  lines.push('advisers eval:mail-local - local mail extraction gold set')
  lines.push('')
  lines.push('fixtures : ' + result.gold.fixtures + ' .eml (' + result.gold.positiveMessages + ' with commitments, ' + result.gold.negativeMessages + ' negative) in ' + result.fixtureDir)
  lines.push('gold     : ' + result.gold.expectedCandidates + ' labeled commitments, ' + result.gold.dueLabeled + ' with a due date, ' + result.gold.amountLabeled + ' with an amount')
  lines.push('rules    : ' + result.predicted.candidates + ' local candidates; model calls ' + result.model.calls + '; network attempts ' + result.network.attempts)
  lines.push('')
  for (const metric of GATED_METRICS) {
    const threshold = result.thresholds[metric]
    const pass = result.metrics[metric] >= threshold
    lines.push('  ' + METRIC_LABELS[metric].padEnd(20) + formatPercent(result.metrics[metric]).padStart(7) +
      '  ' + countDetail(metric, result).padEnd(10) + (pass ? 'PASS' : 'FAIL') + '  (threshold >= ' + formatPercent(threshold) + ')')
  }
  lines.push('')
  lines.push('reported, not gated: message precision ' + formatPercent(result.metrics.messagePrecision) +
    ' (' + result.counts.messageTP + '/' + (result.counts.messageTP + result.counts.messageFP) + ')' +
    ', message recall ' + formatPercent(result.metrics.messageRecall) +
    ' (' + result.counts.messageTP + '/' + (result.counts.messageTP + result.counts.messageFN) + ')' +
    ', amount accuracy ' + formatPercent(result.metrics.amountAccuracy) +
    ' (' + result.counts.amountOk + '/' + result.counts.amountChecked + ')')
  if (result.errors.length) {
    lines.push('')
    lines.push('gold set errors (' + result.errors.length + '):')
    for (const error of result.errors) lines.push('  - ' + error)
  }
  if (result.warnings.length) {
    lines.push('')
    lines.push('warnings:')
    for (const warning of result.warnings) lines.push('  - ' + warning)
  }
  if (result.thresholdFailures.length) {
    lines.push('')
    lines.push('threshold failures (' + result.thresholdFailures.length + '):')
    for (const failure of result.thresholdFailures) {
      lines.push('  - ' + failure.metric + ' ' + formatPercent(failure.actual) + ' < ' + formatPercent(failure.threshold))
    }
  }
  const issues = issueLines(result)
  if (issues.length) {
    lines.push('')
    lines.push('fixture-level issues (' + issues.length + '):')
    for (const issue of issues) lines.push(issue)
  }
  lines.push('')
  lines.push(result.passed ? 'PASS - all gated metrics meet their thresholds.' : 'FAIL - see failures above.')
  return lines.join('\n')
}

function parseArgs(argv) {
  const options = { json: false, verbose: false, list: false, fixtures: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--list') options.list = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--fixtures') {
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
  return options
}

function printHelp() {
  console.log([
    'usage: node eval/run-mail-local-gold.mjs [--json] [--verbose] [--list] [--fixtures <dir>] [--help]',
    '',
    '  --json            print the machine-readable result JSON on stdout',
    '  --verbose         include per-fixture PASS/FAIL lines in the human report',
    '  --list            list the gold fixtures and their expected commitment counts',
    '  --fixtures <dir>  run another gold directory (labels.json + .eml files)',
    '  --help            show this help',
    '',
    'Zero model, zero network, zero ADVISERS_HOME writes. Exit 0 when every gated',
    'metric meets its threshold; exit 1 otherwise; exit 2 on usage errors.',
  ].join('\n'))
}

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) {
    console.error('advisers eval:mail-local: ' + String(error && error.message || error))
    return 2
  }
  if (options.help) { printHelp(); return 0 }

  const fixturesDir = options.fixtures ? resolve(options.fixtures) : DEFAULT_FIXTURES
  const defaultGold = !options.fixtures
  let labels
  try {
    labels = JSON.parse(readFileSync(join(fixturesDir, 'labels.json'), 'utf8'))
  } catch (error) {
    console.error('advisers eval:mail-local: cannot read gold labels from ' + join(fixturesDir, 'labels.json') + ': ' + String(error && error.message || error))
    return 1
  }

  if (options.list) {
    const validation = validateGold(labels, fixturesDir, { defaultGold })
    if (validation.errors.length) {
      for (const error of validation.errors) console.error('advisers eval:mail-local: ' + error)
      return 1
    }
    for (const entry of validation.cases) {
      const due = (entry.expect || []).filter((want) => want && want.dueAt != null).length
      console.log(entry.file.padEnd(32) + ' expected=' + String((entry.expect || []).length) + ' due=' + String(due) + (entry.expect && entry.expect.length === 0 ? '  (negative)' : ''))
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
    result = runGold({ fixturesDir, labels, defaultGold })
  } finally {
    globalThis.fetch = originalFetch
  }
  result.network.attempts = networkAttempts
  if (networkAttempts > 0) {
    result.errors.push('network attempts detected: ' + networkAttempts)
    result.passed = false
  }

  if (options.verbose && !options.json) {
    for (const row of result.cases) {
      const ok = row.missing.length === 0 && row.extra.length === 0 && row.dueMismatches.length === 0 && row.authorMismatches.length === 0 && row.amountMismatches.length === 0
      console.log((ok ? 'PASS ' : 'FAIL ') + row.file + ' expected=' + row.expected.length + ' predicted=' + row.predicted.length + ' matched=' + row.matched)
    }
    console.log('')
  }
  if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  else console.log(renderHuman(result))
  return result.passed ? 0 : 1
}

main().then((code) => {
  process.exit(code)
}).catch((error) => {
  console.error('advisers eval:mail-local: internal error: ' + String(error && error.stack || error))
  process.exit(2)
})
