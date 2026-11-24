#!/usr/bin/env node
/**
 * Release consistency gate for the six publishable packages.
 *
 *   node scripts/check-release.mjs                 # lockstep + pins + constants
 *   node scripts/check-release.mjs --require-tag   # also require git tag v<version>
 *                                                  # and that the tag commit is HEAD
 *   node scripts/check-release.mjs --registry      # also query registry.npmjs.org
 *   node scripts/check-release.mjs --eval-evidence <dir> [--eval-commit <sha>]
 *                                                  [--eval-version <version>]
 *                                                  # release gate: consume a frozen
 *                                                  # eval/results/release-evidence
 *                                                  # directory (see eval/evidence.mjs)
 *
 * The evidence check requires exactly one release-grade schema-v2 report (produced
 * on a clean tree: cli.commit recorded, cli.dirty false) for each zero-model gate:
 * det, kb-retrieval, mail-local-gold dev + held-out, and model-contract. All reports
 * must share one commit equal to HEAD (override with --eval-commit when replaying
 * evidence recorded on an already-tagged commit), and their corpus/baseline hashes
 * must still match the frozen baselines on disk.
 *
 * CI runs the default mode. check-docs.mjs covers README/CHANGELOG advertising;
 * this script covers the package graph that check-docs used to miss.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative as relativePath, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateQualityReport } from '../eval/lib/quality-report.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
function flagValue(name) {
  const index = argv.indexOf(name)
  if (index < 0) return null
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) return ''
  return value
}
const evalEvidenceArg = flagValue('--eval-evidence')
const evalCommitArg = flagValue('--eval-commit')
const evalVersionArg = flagValue('--eval-version')
const read = (file) => readFileSync(join(root, file), 'utf8')
const json = (file) => JSON.parse(read(file))
const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''))
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !detail ? '' : ' — ' + detail))
}

/* -------------------------------------------------------------------------- */
/* release evidence: consume the frozen quality reports                       */
/* -------------------------------------------------------------------------- */

const REQUIRED_EVIDENCE_SLOTS = Object.freeze([
  'det',
  'kb-retrieval',
  'mail-local-gold:dev',
  'mail-local-gold:heldout',
  'model-contract',
])

function collectEvidenceReports(dir) {
  const found = []
  const visit = (path) => {
    let entries
    try { entries = readdirSync(path, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')) found.push(full)
    }
  }
  visit(dir)
  return found.sort()
}

/** Evidence slot key: suite, with the mail gold split kept apart. */
function evidenceSlot(report) {
  if (report?.suite === 'mail-local-gold') {
    const split = report?.corpus?.split
    return 'mail-local-gold:' + (split === 'dev' || split === 'heldout' ? split : String(split ?? 'unknown'))
  }
  return String(report?.suite ?? 'unknown')
}

function gitHead() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch { return '' }
}

function checkEvalEvidence(evidenceDir, { expectedCommit, expectedVersion }) {
  const absolute = resolve(root, evidenceDir)
  check('eval evidence directory exists', existsSync(absolute), evidenceDir)
  if (!existsSync(absolute)) return
  const files = collectEvidenceReports(absolute)
  check('eval evidence contains schema-v2 quality reports', files.length > 0, String(files.length) + ' *.json file(s)')
  if (!files.length) return

  const bySlot = new Map()
  const commits = new Set()
  const versions = new Set()
  for (const file of files) {
    const rel = relativePath(root, file).replaceAll('\\', '/')
    let report
    try { report = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
      failures.push('eval evidence ' + rel + ': invalid JSON (' + String(error?.message ?? error) + ')')
      continue
    }
    if (!report || report.schemaVersion !== 2) {
      failures.push('eval evidence ' + rel + ': not a schema-v2 quality report')
      continue
    }
    const verdict = validateQualityReport(report, { release: true })
    check(
      'eval evidence ' + rel + ' is release-grade (' + evidenceSlot(report) + ')',
      verdict.ok,
      verdict.errors.map((error) => error.code + ' ' + error.path).join(', '),
    )
    if (typeof report.cli?.commit === 'string' && report.cli.commit) commits.add(report.cli.commit)
    if (typeof report.cli?.version === 'string' && report.cli.version) versions.add(report.cli.version)
    const slot = evidenceSlot(report)
    if (!bySlot.has(slot)) bySlot.set(slot, [])
    bySlot.get(slot).push({ file, rel, report })
  }

  for (const slot of REQUIRED_EVIDENCE_SLOTS) {
    const entries = bySlot.get(slot) ?? []
    check(
      'eval evidence has exactly one ' + slot + ' report',
      entries.length === 1,
      entries.length ? entries.map((entry) => entry.rel).join(', ') + ' (freeze one run per slot)' : 'missing',
    )
  }
  for (const [slot, entries] of bySlot) {
    if (!REQUIRED_EVIDENCE_SLOTS.includes(slot)) {
      failures.push('eval evidence has unexpected suite/split ' + slot + ': ' + entries.map((entry) => entry.rel).join(', '))
    }
  }

  check('eval evidence reports share one cli.commit', commits.size === 1, commits.size ? [...commits].join(', ') : 'no commit recorded')
  const expected = String(expectedCommit ?? '').trim()
  if (commits.size === 1) {
    const commit = [...commits][0]
    check(
      'eval evidence commit ' + commit + ' matches ' + (expected ? 'expected ' + expected.slice(0, 12) : 'HEAD ' + gitHead().slice(0, 12)),
      Boolean(expected) && (expected === commit || expected.startsWith(commit) || commit.startsWith(expected)),
      'expected ' + (expected || 'a git SHA; pass --eval-commit when replaying a tag checkout'),
    )
  }

  check(
    'eval evidence reports record the expected release version ' + expectedVersion,
    versions.size === 1 && versions.has(expectedVersion),
    versions.size ? [...versions].join(', ') : 'no version recorded',
  )

  let baseline = null
  try { baseline = json('eval/quality/baselines-v1.json') } catch { baseline = null }
  if (!baseline?.suites) {
    failures.push('eval evidence cross-check needs eval/quality/baselines-v1.json')
    return
  }
  const kb = bySlot.get('kb-retrieval')?.[0]?.report
  const kbCorpus = baseline.suites['kb-retrieval']?.corpus?.sha256
  check(
    'eval evidence kb-retrieval corpus.sha256 matches the frozen baseline',
    Boolean(kb) && kbCorpus === kb?.corpus?.sha256,
    'report ' + (kb?.corpus?.sha256 ?? 'missing') + ', baseline ' + (kbCorpus ?? 'missing'),
  )

  const mailBaseline = baseline.suites['mail-local-gold']
  for (const split of ['dev', 'heldout']) {
    const report = bySlot.get('mail-local-gold:' + split)?.[0]?.report
    const expectedFixtures = split === 'dev' ? mailBaseline?.corpus?.splitSizes?.dev : mailBaseline?.corpus?.splitSizes?.heldout
    check(
      'eval evidence mail-local-gold ' + split + ' corpus.sha256 matches the frozen baseline',
      Boolean(report) && mailBaseline?.corpus?.sha256 === report?.corpus?.sha256,
      'report ' + (report?.corpus?.sha256 ?? 'missing') + ', baseline ' + (mailBaseline?.corpus?.sha256 ?? 'missing'),
    )
    check(
      'eval evidence mail-local-gold ' + split + ' split and fixtures.count are frozen',
      Boolean(report) && report?.corpus?.split === split && report?.fixtures?.count === expectedFixtures,
      'split ' + (report?.corpus?.split ?? 'missing') + ', fixtures ' + (report?.fixtures?.count ?? 'missing') + ', expected ' + (expectedFixtures ?? 'missing'),
    )
  }

  const det = bySlot.get('det')?.[0]?.report
  const detBaseline = baseline.suites.det?.baselineSha256
  check(
    'eval evidence det report cites the frozen eval/det/baseline.json',
    Boolean(det) && det?.baseline?.file === 'eval/det/baseline.json' && det?.baseline?.sha256 === detBaseline,
    'file ' + (det?.baseline?.file ?? 'missing') + ', sha ' + (det?.baseline?.sha256 ?? 'missing'),
  )

  const modelContract = bySlot.get('model-contract')?.[0]?.report
  check(
    'eval evidence model-contract records sockets=0 and autoConfirmed=0',
    modelContract?.metrics?.sockets === 0 && modelContract?.metrics?.autoConfirmed === 0,
    'sockets ' + (modelContract?.metrics?.sockets ?? 'missing') + ', autoConfirmed ' + (modelContract?.metrics?.autoConfirmed ?? 'missing'),
  )

  const totals = []
  for (const slot of REQUIRED_EVIDENCE_SLOTS) {
    const report = bySlot.get(slot)?.[0]?.report
    if (!report) continue
    totals.push(slot + ' n=' + (report.metrics?.n ?? report.totals?.cases ?? '?') +
      ' cases=' + report.totals?.cases + '/' + report.totals?.passed +
      ' gates=' + report.gates.length + '/' + report.gates.filter((gate) => gate.pass).length +
      ' corpus=' + (report.corpus?.split ?? '-'))
  }
  for (const line of totals) console.log('INFO eval evidence ' + line)
}

const publishable = [
  ['packages/advisers', 'advisers'],
  ['packages/core', 'advisers-core'],
  ['packages/office', 'advisers-office'],
  ['packages/policy-strict', 'advisers-policy-strict'],
  ['packages/bridge-hermes', 'advisers-bridge-hermes'],
  ['packages/dsh-advisers', 'dsh-advisers'],
]
const all = [
  ['packages/core', 'advisers-core'],
  ['packages/office', 'advisers-office'],
  ['packages/policy-strict', 'advisers-policy-strict'],
  ['packages/bridge-hermes', 'advisers-bridge-hermes'],
  ['packages/advisers', 'advisers'],
  ['packages/dsh-advisers', 'dsh-advisers'],
  ['packages/link-email', 'advisers-link-email'],
  ['packages/link-feishu', 'advisers-link-feishu'],
]
const pkgs = new Map()
for (const [dir, name] of all) {
  const pkg = json(dir + '/package.json')
  pkgs.set(name, { dir, pkg })
  check(dir + ' package name', pkg.name === name, 'found ' + pkg.name)
}

const version = pkgs.get('advisers').pkg.version
if (argv.includes('--stable')) {
  check('version is a release version (no -preview/-rc)', /^\d+\.\d+\.\d+$/.test(version), 'found ' + version)
  for (const [dir, name] of publishable) {
    check(dir + ' version is lockstep ' + version, pkgs.get(name).pkg.version === version, 'found ' + pkgs.get(name).pkg.version)
  }
}

const pins = [
  ['advisers', 'dependencies', 'advisers-core'],
  ['advisers', 'dependencies', 'advisers-policy-strict'],
  ['advisers', 'peerDependencies', 'advisers-office'],
  ['dsh-advisers', 'dependencies', 'advisers-core'],
  ['dsh-advisers', 'dependencies', 'advisers-office'],
  ['advisers-bridge-hermes', 'dependencies', 'advisers-core'],
  ['advisers-policy-strict', 'dependencies', 'advisers-core'],
]
for (const [name, field, dep] of pins) {
  const found = pkgs.get(name).pkg[field]?.[dep]
  const expected = pkgs.get(dep).pkg.version
  check(name + ' ' + field + '.' + dep + ' pin', found === expected, 'found ' + found + ', expected ' + expected)
}

const constants = [
  ['packages/advisers/index.js', /export const version = '([^']+)'/],
  ['packages/dsh-advisers/index.js', /export const version = '([^']+)'/],
  ['packages/bridge-hermes/src/index.ts', /version: '([^']+)'/],
]
for (const [file, re] of constants) {
  if (!existsSync(join(root, file))) { failures.push(file + ': missing'); continue }
  const found = re.exec(read(file))?.[1]
  const pkgName = file.includes('bridge-hermes') ? 'advisers-bridge-hermes' : file.includes('dsh-advisers') ? 'dsh-advisers' : 'advisers'
  const expected = pkgs.get(pkgName).pkg.version
  check(file + ' version constant', found === expected, 'found ' + found + ', expected ' + expected)
}

for (const [dir] of publishable) {
  check(dir + '/NOTICE exists', existsSync(join(root, dir, 'NOTICE')))
  check(dir + '/LICENSE exists', existsSync(join(root, dir, 'LICENSE')))
}

if (argv.includes('--require-tag') || argv.includes('--stable')) {
  let tags = ''
  try { tags = execFileSync('git', ['tag', '-l', 'v' + version], { cwd: root, encoding: 'utf8' }).trim() } catch {}
  check('git tag v' + version + ' exists', tags === 'v' + version, 'found ' + (tags || 'none'))
  // 0.3.0 was published from a working tree that was not the tagged tree (the
  // final docs commit came after the tag). Requiring the tag commit to be HEAD
  // makes "publish from main after tagging" fail before dispatch.
  if (tags === 'v' + version) {
    let head = ''
    let tagCommit = ''
    try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch {}
    try { tagCommit = execFileSync('git', ['rev-parse', 'v' + version + '^{commit}'], { cwd: root, encoding: 'utf8' }).trim() } catch {}
    check(
      'git tag v' + version + ' is the HEAD commit',
      Boolean(head) && tagCommit === head,
      'tag ' + (tagCommit || 'missing') + ', HEAD ' + (head || 'unknown') + ' (commit the release docs, then tag that same commit)',
    )
    // An annotated tag carries the tag object (message/date) and is harder to
    // mutate silently than a lightweight tag. Record object -> commit so the
    // release evidence can pin both SHAs before the workflow is dispatched.
    let tagType = ''
    let tagObject = ''
    try { tagType = execFileSync('git', ['cat-file', '-t', 'v' + version], { cwd: root, encoding: 'utf8' }).trim() } catch {}
    try { tagObject = execFileSync('git', ['rev-parse', 'v' + version], { cwd: root, encoding: 'utf8' }).trim() } catch {}
    // actions/checkout materialises a tag-ref checkout as a lightweight local
    // ref (the annotated tag object is not kept), so the annotation cannot be
    // asserted from a CI checkout. Enforce it on a developer machine, and keep
    // the tag-object evidence out of CI where it would be the commit SHA.
    if (process.env.GITHUB_ACTIONS === 'true' && tagType !== 'tag') {
      console.log('INFO CI checkout materialised v' + version + ' as a lightweight ref; annotated-tag evidence is checked locally before the tag is pushed')
    } else {
      check('git tag v' + version + ' is an annotated tag', tagType === 'tag', 'found ' + (tagType || 'none'))
      if (tagType === 'tag' && tagObject && tagCommit) {
        console.log('INFO tag object ' + tagObject + ' -> commit ' + tagCommit + ' (record both in the release evidence before dispatch)')
      }
    }
  }
}

if (argv.includes('--registry')) {
  const fetchJson = async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      return res.ok ? await res.json() : null
    } catch { return null }
  }
  for (const [dir, name] of publishable) {
    const ver = pkgs.get(name).pkg.version
    const doc = await fetchJson('https://registry.npmjs.org/' + name + '/' + ver)
    check(name + '@' + ver + ' is published on registry.npmjs.org', Boolean(doc), 'not found')
  }
}

if (evalEvidenceArg !== null) {
  if (!evalEvidenceArg) failures.push('--eval-evidence needs a directory (e.g. eval/results/release-evidence)')
  else checkEvalEvidence(evalEvidenceArg, { expectedCommit: evalCommitArg || gitHead(), expectedVersion: evalVersionArg || version })
}
if ((evalCommitArg !== null || evalVersionArg !== null) && evalEvidenceArg === null) console.log('INFO --eval-commit/--eval-version are only used together with --eval-evidence')

if (failures.length) {
  console.error('\n' + failures.length + ' release inconsistency(ies):')
  for (const failure of failures) console.error('- ' + failure)
  process.exit(1)
}
console.log('\nPASS release consistency (' + version + ')')
