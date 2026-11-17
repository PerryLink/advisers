#!/usr/bin/env node
/**
 * Production dependency audit gate (official npm registry).
 *
 * Runs `pnpm audit --prod --json` against https://registry.npmjs.org/ instead of
 * whatever mirror the local pnpm config points at (several mirrors do not expose
 * the npm audit endpoint at all). High/critical findings are gated by severity:
 * every one must be covered by an explicit WHITELIST entry below that records a
 * reason and a review date.
 *
 * Policy: WARN-only for now. Findings, an unreachable audit endpoint, or an
 * overdue whitelist review print a clear WARN line but exit 0, so the gate can
 * be wired into CI without blocking releases while the known advisories are
 * still being worked through. Pass --strict (or set ADVISERS_DEPS_STRICT=1) to
 * make WARN exit 1.
 *
 * Usage:
 *   node scripts/check-deps.mjs                # production deps, WARN-only
 *   node scripts/check-deps.mjs --strict       # exit 1 on WARN
 *   node scripts/check-deps.mjs --include-dev  # include dev dependencies (local use)
 *   node scripts/check-deps.mjs --json         # machine-readable summary on stdout
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/'
const GATE_SEVERITIES = ['high', 'critical']
const DAY_MS = 24 * 60 * 60 * 1000

// Reviewed exceptions. Each entry needs a reason and a review date; when the
// review date passes, the entry stops covering findings and the gate warns.
// Remove an entry as soon as the upstream dependency allows the fixed version.
const WHITELIST = [
  {
    advisory: 'GHSA-5p2g-fcmc-qvqq',
    package: 'image-size',
    severity: 'high',
    reason:
      'Transitive via pptxgenjs (pptxgenjs pins image-size ^1.2.1, which resolves to 1.2.1; the fix is image-size >=2.0.3). advisers-office only uses the text/table APIs and exposes no image input, so the vulnerable JXL/HEIF parsers are not reachable today. Re-check when a pptxgenjs release allows image-size >=2.0.3; do not force an override without an office pptx regression run.',
    reviewBy: '2027-02-17',
  },
  {
    advisory: 'GHSA-w3rx-r6r6-pgpr',
    package: 'image-size',
    severity: 'high',
    reason:
      'Same transitive image-size@1.2.1 as GHSA-5p2g-fcmc-qvqq (ICNS parser infinite loop, fixed in >=2.0.3). Not reachable because advisers-office never passes image bytes to pptxgenjs; tracked together with the JXL/HEIF advisory and re-checked on the same date.',
    reviewBy: '2027-02-17',
  },
  {
    advisory: 'GHSA-w5hq-g745-h8pq',
    package: 'uuid',
    severity: 'moderate',
    reason:
      'Transitive via exceljs (uuid ^8.3.0, fix is uuid >=11.1.1). Below the high/critical gate and not reachable: Advisers callers use uuid v4 without the buf option. Tracked so the dependency tree stays explicit; re-evaluate on the review date.',
    reviewBy: '2027-02-17',
  },
]

const argv = process.argv.slice(2)
const knownFlags = new Set(['--strict', '--include-dev', '--json', '--help', '-h'])
for (const flag of argv) {
  if (!knownFlags.has(flag)) {
    console.error('unknown flag: ' + flag)
    console.error('usage: node scripts/check-deps.mjs [--strict] [--include-dev] [--json]')
    process.exit(2)
  }
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/check-deps.mjs [--strict] [--include-dev] [--json]')
  console.log('')
  console.log('Audits production dependencies against the official npm registry.')
  console.log('High/critical findings are WARN-only by default; --strict makes them exit 1.')
  console.log('Known unreachable/pending-upstream advisories are whitelisted in this script')
  console.log('with a reason and a review date.')
  process.exit(0)
}

const strict = argv.includes('--strict') || process.env.ADVISERS_DEPS_STRICT === '1'
const includeDev = argv.includes('--include-dev')
const jsonOutput = argv.includes('--json')
const todayIso = new Date().toISOString().slice(0, 10)

const isIsoDate = (value) =>
  typeof value === 'string' && value.length === 10 && !Number.isNaN(Date.parse(value + 'T00:00:00Z'))
const reviewExpired = (entry) => todayIso > entry.reviewBy
const reviewDaysLeft = (entry) => Math.ceil((Date.parse(entry.reviewBy + 'T23:59:59Z') - Date.now()) / DAY_MS)

function validateWhitelist() {
  const seen = new Set()
  for (const entry of WHITELIST) {
    for (const field of ['advisory', 'package', 'severity', 'reason', 'reviewBy']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) {
        throw new Error('WHITELIST entry is missing ' + field + ': ' + JSON.stringify(entry))
      }
    }
    if (entry.reason.length < 40) {
      throw new Error('WHITELIST reason is too short (record why the finding is acceptable): ' + entry.advisory)
    }
    if (!isIsoDate(entry.reviewBy)) {
      throw new Error('WHITELIST reviewBy must be YYYY-MM-DD: ' + entry.advisory + ' -> ' + entry.reviewBy)
    }
    const key = entry.advisory + '|' + entry.package
    if (seen.has(key)) throw new Error('duplicate WHITELIST entry: ' + key)
    seen.add(key)
  }
}

function runPnpmAudit() {
  if (!existsSync(join(root, 'pnpm-lock.yaml'))) {
    return { error: 'pnpm-lock.yaml not found; refusing to audit a floating dependency tree' }
  }
  const args = ['audit', '--json', '--registry=' + OFFICIAL_REGISTRY]
  if (!includeDev) args.splice(1, 0, '--prod')
  const candidates = []
  if (process.platform === 'win32') {
    candidates.push(['pnpm.cmd', args])
    candidates.push(['pnpm', args])
    candidates.push([process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm ' + args.join(' ')]])
  } else {
    candidates.push(['pnpm', args])
  }
  let lastError = ''
  for (const [bin, binArgs] of candidates) {
    const result = spawnSync(bin, binArgs, {
      cwd: root,
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NPM_CONFIG_REGISTRY: OFFICIAL_REGISTRY },
    })
    if (result.error && (result.error.code === 'ENOENT' || result.error.code === 'EINVAL')) {
      lastError = result.error.code + ' ' + bin
      continue
    }
    return { result, command: bin + ' ' + binArgs.join(' ') }
  }
  return {
    error:
      'pnpm is not available (' +
      (lastError || 'not found') +
      '). Install pnpm 12.16.1 (for example `corepack enable pnpm`) and run pnpm install --frozen-lockfile first.',
  }
}

function normalizeFindings(report) {
  const advisories = Array.isArray(report.advisories)
    ? report.advisories
    : Object.values(report.advisories || {})
  return advisories.map((advisory) => {
    const findings = Array.isArray(advisory.findings) ? advisory.findings : []
    return {
      id: String(advisory.id || ''),
      advisory: String(advisory.github_advisory_id || advisory.advisoryId || 'npm-' + String(advisory.id || '')),
      package: String(advisory.module_name || advisory.moduleName || ''),
      severity: String(advisory.severity || 'unknown').toLowerCase(),
      title: String(advisory.title || ''),
      url: String(advisory.url || ''),
      vulnerableVersions: String(advisory.vulnerable_versions || advisory.vulnerableVersions || ''),
      patchedVersions: String(advisory.patched_versions || advisory.patchedVersions || ''),
      versions: [...new Set(findings.map((finding) => finding.version).filter(Boolean))],
      paths: [...new Set(findings.flatMap((finding) => finding.paths || []))],
      dev: findings.length > 0 && findings.every((finding) => finding.dev === true),
      optional: findings.length > 0 && findings.every((finding) => finding.optional === true),
    }
  })
}

const matchesWhitelist = (finding, entry) =>
  entry.package === finding.package &&
  (entry.advisory === finding.advisory || entry.advisory === finding.id)

const warnings = []
const findings = []
const audit = {
  available: false,
  command: '',
  scope: includeDev ? 'all dependencies (dev included)' : 'production dependencies (dev excluded)',
  totalDependencies: null,
  prodDependencies: null,
  exitStatus: null,
}

try {
  validateWhitelist()
} catch (error) {
  console.error('ERROR ' + error.message)
  process.exit(2)
}

const run = runPnpmAudit()
if (run.error) {
  warnings.push(run.error)
} else {
  audit.command = run.command
  audit.exitStatus = run.result.status
  const stdout = String(run.result.stdout || '')
  const stderr = String(run.result.stderr || '').trim()
  let report = null
  try {
    report = JSON.parse(stdout)
  } catch {
    report = null
  }
  if (!report || typeof report !== 'object') {
    warnings.push(
      'pnpm audit did not return parsable JSON (exit ' +
        String(run.result.status) +
        '). The audit endpoint may be unreachable, or the configured registry is not the official one. ' +
        (stderr ? 'stderr: ' + stderr.slice(0, 600) : 'no stderr captured'),
    )
  } else {
    audit.available = true
    const metadata = report.metadata || {}
    audit.totalDependencies = Number(metadata.totalDependencies || 0) || null
    audit.prodDependencies = Number(metadata.dependencies || 0) || null
    findings.push(...normalizeFindings(report))
  }
}

const activeWhitelist = WHITELIST.filter((entry) => !reviewExpired(entry))
const covered = (finding) => activeWhitelist.some((entry) => matchesWhitelist(finding, entry))
const gateFindings = findings.filter((finding) => GATE_SEVERITIES.includes(finding.severity))
const uncovered = gateFindings.filter((finding) => !covered(finding))
if (uncovered.length > 0 && audit.available) {
  warnings.push(
    uncovered.length + ' high/critical finding(s) are not covered by an active WHITELIST entry',
  )
}

const whitelistReport = WHITELIST.map((entry) => {
  const matching = findings.filter((finding) => matchesWhitelist(finding, entry))
  const expired = reviewExpired(entry)
  if (matching.length === 0) {
    if (expired) {
      warnings.push('whitelist entry for ' + entry.advisory + ' is past its review date and no longer reported; remove it')
    }
  } else if (expired) {
    warnings.push(
      'whitelist entry for ' + entry.advisory + ' is past its review date (' + entry.reviewBy + '); re-review or remove it',
    )
  }
  return {
    advisory: entry.advisory,
    package: entry.package,
    severity: entry.severity,
    reason: entry.reason,
    reviewBy: entry.reviewBy,
    expired,
    daysLeft: reviewDaysLeft(entry),
    reported: matching.length > 0,
    versions: [...new Set(matching.flatMap((finding) => finding.versions))],
    paths: [...new Set(matching.flatMap((finding) => finding.paths))],
  }
})

const totals = { critical: 0, high: 0, moderate: 0, low: 0, info: 0, unknown: 0 }
for (const finding of findings) {
  if (finding.severity in totals) totals[finding.severity] += 1
  else totals.unknown += 1
}
const result = warnings.length > 0 || uncovered.length > 0 ? 'WARN' : 'PASS'

const severityOrder = ['critical', 'high', 'moderate', 'low', 'info', 'unknown']
const sortedFindings = [...findings].sort(
  (left, right) => severityOrder.indexOf(left.severity) - severityOrder.indexOf(right.severity),
)

if (jsonOutput) {
  console.log(
    JSON.stringify(
      {
        tool: 'check-deps',
        generatedAt: new Date().toISOString(),
        registry: OFFICIAL_REGISTRY,
        scope: audit.scope,
        gateSeverities: GATE_SEVERITIES,
        strict,
        result,
        warnings,
        audit,
        totals,
        findings,
        whitelist: whitelistReport,
      },
      null,
      2,
    ),
  )
} else {
  console.log('Advisers dependency audit gate')
  console.log('registry: ' + OFFICIAL_REGISTRY)
  console.log('scope: ' + audit.scope)
  if (audit.command) console.log('command: ' + audit.command)
  console.log('date: ' + todayIso)
  if (audit.totalDependencies) {
    console.log(
      'dependencies: ' +
        String(audit.prodDependencies || '?') +
        ' production / ' +
        String(audit.totalDependencies) +
        ' total in the lockfile',
    )
  }
  console.log('')
  console.log(
    'Findings: ' +
      totals.critical +
      ' critical, ' +
      totals.high +
      ' high, ' +
      totals.moderate +
      ' moderate, ' +
      totals.low +
      ' low' +
      (totals.unknown ? ', ' + totals.unknown + ' unknown' : ''),
  )
  if (!audit.available) {
    console.log('  (audit did not run: see WARN below)')
  } else if (sortedFindings.length === 0) {
    console.log('  none reported by the official registry')
  }
  for (const finding of sortedFindings) {
    const entry = WHITELIST.find((candidate) => matchesWhitelist(finding, candidate))
    let status = ''
    const gated = GATE_SEVERITIES.includes(finding.severity)
    if (gated && entry) {
      status = reviewExpired(entry)
        ? '  [WHITELIST EXPIRED ' + entry.reviewBy + ']'
        : '  [whitelisted, review by ' + entry.reviewBy + ']'
    } else if (!gated) {
      status = '  [below gate: ' + GATE_SEVERITIES.join('/') + (entry ? '; tracked, review by ' + entry.reviewBy : '') + ']'
    } else {
      status = '  [NOT WHITELISTED]'
    }
    console.log(
      '  ' +
        finding.severity.toUpperCase().padEnd(9) +
        ' ' +
        finding.advisory.padEnd(22) +
        ' ' +
        finding.package +
        '@' +
        (finding.versions.join(', ') || '?') +
        status,
    )
    if (finding.title) console.log('    ' + finding.title)
    if (finding.paths.length) console.log('    paths: ' + finding.paths.join('; '))
    if (finding.patchedVersions) console.log('    patched: ' + finding.patchedVersions)
    if (entry && !reviewExpired(entry)) console.log('    reason: ' + entry.reason)
  }
  console.log('')
  console.log('Whitelist (' + WHITELIST.length + ' reviewed exception(s)):')
  for (const item of whitelistReport) {
    if (!item.reported) {
      console.log(
        '  INFO ' + item.advisory + ' (' + item.package + '): no longer reported; remove this entry when convenient',
      )
      continue
    }
    console.log(
      '  ' +
        (item.expired ? 'EXPIRED' : 'active ') +
        ' ' +
        item.advisory.padEnd(22) +
        ' ' +
        item.package.padEnd(12) +
        ' review by ' +
        item.reviewBy +
        ' (' +
        item.daysLeft +
        ' day(s) left)',
    )
  }
  if (warnings.length > 0) {
    console.log('')
    for (const warning of warnings) console.log('WARN ' + warning)
  }
  console.log('')
  console.log(
    'Result: ' +
      result +
      (result === 'WARN' && !strict
        ? ' (non-blocking: pass --strict or set ADVISERS_DEPS_STRICT=1 to fail)'
        : ''),
  )
  console.log(
    'Gate: high/critical findings must be covered by an active WHITELIST entry; whitelist entries need a reason and a review date.',
  )
}

if (result === 'WARN' && strict) process.exitCode = 1
