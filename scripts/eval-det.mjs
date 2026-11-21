#!/usr/bin/env node
/**
 * Deterministic eval suite entry point — `pnpm eval:det`.
 *
 * A release gate, not a quality benchmark: no model key, no network, no real
 * ~/.advisers, fixed timezone, temp HOME per case. It gates the deterministic
 * 0.3.0 contract:
 *   - morning `dataSha256` stability (same ledger + same day -> same hash) and
 *     golden values from eval/det/baseline.json;
 *   - the MCP stdio surface (legacy protocol echo, 8 tools, 5 resources, codes);
 *   - CLI JSON purity (one JSON document on stdout, errors as envelopes);
 *   - exit codes 0 / 1 / 3;
 *   - non-TTY output: no ANSI/clear-screen, no prompt/hang;
 *   - the 0.4.0 local surfaces: KB (add/ls/show/search/pages/fact as-of),
 *     offline mail import + local extract, and the privacy/consent/evidence
 *     policy surface (all offline, temp HOME, fixed fixture rows).
 *
 * Usage:
 *   node scripts/eval-det.mjs [--suite all|determinism,mcp,json,exit,tty|tui]
 *     [--out <file>] [--no-write] [--json] [--verbose] [--list]
 *     [--update-baseline]
 *
 * Exit codes: 0 all gates pass; 1 at least one gate failed; 2 usage/config error.
 */
import { relative } from 'node:path'

import { BASELINE_PATH, REPO_ROOT, RESULTS_DIR, knownRoots, networkSummary, preflight } from '../eval/det/lib/harness.mjs'
import { readBaseline, recordBaseline } from '../eval/det/lib/baseline.mjs'
import { printReport, writeResult } from '../eval/det/lib/report.mjs'
import { finalize, harnessCases, runCases } from '../eval/det/lib/runner.mjs'
import determinismCases from '../eval/det/cases/determinism.mjs'
import mcpCases from '../eval/det/cases/mcp.mjs'
import jsonCases from '../eval/det/cases/json-purity.mjs'
import exitCases from '../eval/det/cases/exit-codes.mjs'
import ttyCases from '../eval/det/cases/non-tty.mjs'
import tuiCases from '../eval/det/cases/tui.mjs'
import kbCases from '../eval/det/cases/kb.mjs'
import mailCases from '../eval/det/cases/mail.mjs'
import policyCases from '../eval/det/cases/policy.mjs'

const DEFAULT_SUITES = ['determinism', 'mcp', 'json', 'exit', 'tty', 'kb', 'mail', 'policy']
const OPT_IN_SUITES = ['tui']
const ALL_CASES = [...determinismCases, ...mcpCases, ...jsonCases, ...exitCases, ...ttyCases, ...tuiCases, ...kbCases, ...mailCases, ...policyCases]

function fail(message) {
  console.error('advisers eval:det: ' + message)
  process.exit(2)
}

function parseArgs(argv) {
  const options = { suites: [...DEFAULT_SUITES], out: null, noWrite: false, json: false, verbose: false, list: false, updateBaseline: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log([
        'usage: node scripts/eval-det.mjs [--suite all|determinism,mcp,json,exit,tty|kb,mail,policy|tui]',
        '       [--out <file>] [--no-write] [--json] [--verbose] [--list] [--update-baseline]',
        '',
        '  --suite <list>      comma-separated groups; "all" = ' + DEFAULT_SUITES.join(',') + '; "tui" is opt-in',
        '  --out <file>        write the result JSON to <file> instead of eval/det/results/',
        '  --no-write          print the report but do not write a result file',
        '  --json              print the result JSON on stdout (instead of the human report)',
        '  --verbose           print passing cases too',
        '  --list              list case ids and exit',
        '  --update-baseline   re-record eval/det/baseline.json golden values (review the diff!)',
      ].join('\n'))
      process.exit(0)
    } else if (arg === '--suite') {
      const value = argv[++index]
      if (!value) fail('--suite needs a value')
      options.suites = value === 'all' ? [...DEFAULT_SUITES] : value.split(',').map((name) => name.trim()).filter(Boolean)
    } else if (arg.startsWith('--suite=')) {
      const value = arg.slice('--suite='.length)
      options.suites = value === 'all' ? [...DEFAULT_SUITES] : value.split(',').map((name) => name.trim()).filter(Boolean)
    } else if (arg === '--out') {
      const value = argv[++index]
      if (!value) fail('--out needs a file path')
      options.out = value
    } else if (arg === '--no-write') {
      options.noWrite = true
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--verbose') {
      options.verbose = true
    } else if (arg === '--list') {
      options.list = true
    } else if (arg === '--update-baseline') {
      options.updateBaseline = true
    } else {
      fail('unknown argument: ' + arg)
    }
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const known = new Set([...DEFAULT_SUITES, ...OPT_IN_SUITES])
  for (const suite of options.suites) {
    if (!known.has(suite)) fail('unknown suite "' + suite + '"; known: ' + [...known].join(', '))
  }

  if (options.updateBaseline) {
    const problems = preflight().filter((problem) => !problem.startsWith('missing eval/det/baseline.json'))
    if (problems.length) fail(problems.join('; '))
    const { baseline } = await recordBaseline()
    console.log('recorded ' + relative(REPO_ROOT, BASELINE_PATH) + ': dataSha256=' + baseline.golden.morning.dataSha256 + ' markdown=' + baseline.golden.morning.digestMarkdownSha256.slice(0, 16) + '…')
    console.log('review the diff before committing; re-record only for intended contract changes.')
    return 0
  }

  const problems = preflight()
  if (problems.length) fail(problems.join('; '))
  const baseline = readBaseline()
  const cases = ALL_CASES.filter((testCase) => options.suites.includes(testCase.group))

  if (options.list) {
    for (const testCase of cases) console.log(testCase.group.padEnd(12) + ' ' + testCase.id + (testCase.title ? ' — ' + testCase.title : ''))
    return 0
  }
  if (!cases.length) fail('no cases matched suites: ' + options.suites.join(','))

  const startedAt = new Date().toISOString()
  const results = await runCases(cases, {
    onCase: (testCase) => {
      if (!options.json) {
        const failed = testCase.checks.filter((check) => !check.pass)
        if (failed.length) console.log('FAIL ' + testCase.id + ' (' + testCase.durationMs + 'ms)')
        else if (options.verbose) console.log('PASS ' + testCase.id + ' (' + testCase.durationMs + 'ms)')
      }
    },
  })
  const network = networkSummary()
  const withHarness = [...results, ...harnessCases({ network })]
  const result = finalize({ cases: withHarness, startedAt, filters: options.suites, baseline, network, workdirs: knownRoots() })
  const written = writeResult(result, { outFile: options.out, outDir: RESULTS_DIR, noWrite: options.noWrite })

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    console.log('')
    console.log(printReport(result, { verbose: options.verbose }))
    if (written.path) console.log('result: ' + (options.out ?? relative(REPO_ROOT, written.path)))
  }
  return result.totals.failed === 0 && result.network.attempts === 0 ? 0 : 1
}

main().then((code) => {
  process.exit(code)
}).catch((error) => {
  console.error('advisers eval:det: internal error: ' + String(error?.stack ?? error))
  process.exit(2)
})
