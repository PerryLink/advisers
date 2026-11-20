#!/usr/bin/env node
/**
 * Docs/version consistency gate.
 *
 * Docs drifted repeatedly (root README-zh stuck on preview.44, CHANGELOG on
 * preview.45 while packages moved to preview.56). This script fails CI when a
 * published version reference or a package internal version constant disagrees
 * with package.json.
 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file) => readFileSync(join(root, file), 'utf8')
const readIfExists = (file) => (existsSync(join(root, file)) ? read(file) : '')
const json = (file) => JSON.parse(read(file))
const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}

// License policy (0.2.0 migration, 2026-11-17): software is PolyForm Noncommercial
// 1.0.0 and docs/data/design is CC BY-NC-SA 4.0. This is source-available, NOT an
// OSI-approved open source project. Historical notes (CHANGELOG older sections,
// the internal eval/results/** (gitignored), docs/HANDOFF-*, NOTICE version mapping) are intentionally not
// scanned for the old license names.
const LICENSE_ID = 'PolyForm-Noncommercial-1.0.0'
const DOCS_LICENSE_ID = 'CC-BY-NC-SA-4.0'
const POLYFORM_URL = 'https://polyformproject.org/licenses/noncommercial/1.0.0'
const CC_URL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.en'
const COMMERCIAL_URL = 'https://github.com/PerryLink/advisers/issues'
const sha256 = (file) => createHash('sha256').update(readFileSync(join(root, file))).digest('hex')

const packages = {
  'advisers-core': { dir: 'packages/core', versionFile: 'package.json' },
  'advisers-office': { dir: 'packages/office', versionFile: 'package.json' },
  'advisers-policy-strict': { dir: 'packages/policy-strict', versionFile: 'package.json' },
  'advisers-bridge-hermes': { dir: 'packages/bridge-hermes', versionFile: 'package.json' },
  'advisers': { dir: 'packages/advisers', versionFile: 'package.json' },
  'dsh-advisers': { dir: 'packages/dsh-advisers', versionFile: 'package.json' },
  'advisers-link-email': { dir: 'packages/link-email', versionFile: 'package.json' },
  'advisers-link-feishu': { dir: 'packages/link-feishu', versionFile: 'package.json' },
}

const versions = {}
for (const [name, meta] of Object.entries(packages)) {
  const pkg = json(join(meta.dir, meta.versionFile))
  if (pkg.name !== name) failures.push(`${meta.dir}: package name ${pkg.name} != expected ${name}`)
  check(`${meta.dir} license field`, pkg.license === LICENSE_ID, `found ${pkg.license}`)
  versions[name] = pkg.version
}

// Internal `version` constants must match their package.json.
const versionConstants = [
  ['packages/advisers/index.js', versions['advisers'], /export const version = '([^']+)'/],
  ['packages/dsh-advisers/index.js', versions['dsh-advisers'], /export const version = '([^']+)'/],
  ['packages/bridge-hermes/src/index.ts', versions['advisers-bridge-hermes'], /version: '([^']+)'/],
]
for (const [file, expected, re] of versionConstants) {
  if (!existsSync(join(root, file))) { failures.push(`${file}: missing`); continue }
  const match = re.exec(read(file))
  check(`${file} version constant`, Boolean(match) && match[1] === expected, match ? `found ${match[1]}, expected ${expected}` : 'version constant not found')
}

// Workspace dependency pins must match the sibling package versions.
const pinChecks = [
  ['packages/advisers/package.json', 'dependencies', 'advisers-core', versions['advisers-core']],
  ['packages/advisers/package.json', 'dependencies', 'advisers-policy-strict', versions['advisers-policy-strict']],
  ['packages/advisers/package.json', 'peerDependencies', 'advisers-office', versions['advisers-office']],
  ['packages/dsh-advisers/package.json', 'dependencies', 'advisers-core', versions['advisers-core']],
  ['packages/dsh-advisers/package.json', 'dependencies', 'advisers-office', versions['advisers-office']],
]
for (const [file, field, dep, expected] of pinChecks) {
  const found = json(file)?.[field]?.[dep]
  check(`${file} ${field}.${dep}`, found === expected, `found ${found}, expected ${expected}`)
}

// License files: software PolyForm-Noncommercial-1.0.0 + docs CC-BY-NC-SA-4.0.
const licensePackages = [
  'packages/core',
  'packages/office',
  'packages/policy-strict',
  'packages/bridge-hermes',
  'packages/advisers',
  'packages/dsh-advisers',
]
const rootLicenseText = read('LICENSE')
check(
  'LICENSE is the PolyForm Noncommercial License 1.0.0 text',
  rootLicenseText.includes('PolyForm Noncommercial License 1.0.0') && rootLicenseText.includes(POLYFORM_URL),
)
check('LICENSE no longer contains the Apache License text', !rootLicenseText.includes('Apache License'))

const rootNoticeText = read('NOTICE')
check('NOTICE contains the Required Notice line', rootNoticeText.includes('Required Notice:'))
check('NOTICE names both licenses', rootNoticeText.includes('PolyForm') && rootNoticeText.includes('CC BY-NC-SA 4.0'))
check('NOTICE says the project is not open source', /not open source/i.test(rootNoticeText))
check(
  'NOTICE documents the non-retroactive history',
  /not retroactive/i.test(rootNoticeText) && rootNoticeText.includes('advisers@0.2.0-preview.71'),
)

const docsLicenseText = readIfExists('LICENSE-DOCS')
check(
  'LICENSE-DOCS is the CC BY-NC-SA 4.0 legal code',
  docsLicenseText.includes('Attribution-NonCommercial-ShareAlike 4.0 International') && docsLicenseText.includes(CC_URL),
)

const licensingText = readIfExists('LICENSING.md')
check('LICENSING.md contains both SPDX ids', licensingText.includes(LICENSE_ID) && licensingText.includes(DOCS_LICENSE_ID))
check('LICENSING.md says the project is not open source (EN+ZH)', /not open source/i.test(licensingText) && licensingText.includes('非开源'))
check('LICENSING.md records the current LICENSE/NOTICE sha256', licensingText.includes(sha256('LICENSE')) && licensingText.includes(sha256('NOTICE')))
check('LICENSING.md points at the commercial-license channel', licensingText.includes(COMMERCIAL_URL))

// Published packages ship byte-identical copies of the root LICENSE/NOTICE and list
// all three required tarball files in their files allowlist.
const rootHashes = { LICENSE: sha256('LICENSE'), NOTICE: sha256('NOTICE') }
for (const dir of licensePackages) {
  const pkg = json(dir + '/package.json')
  const licenseFile = dir + '/LICENSE'
  check(licenseFile + ' sha256 matches root LICENSE', existsSync(join(root, licenseFile)) && sha256(licenseFile) === rootHashes.LICENSE)
  const noticeFile = dir + '/NOTICE'
  check(noticeFile + ' sha256 matches root NOTICE', existsSync(join(root, noticeFile)) && sha256(noticeFile) === rootHashes.NOTICE)
  check(noticeFile + ' contains the Required Notice line', existsSync(join(root, noticeFile)) && read(noticeFile).includes('Required Notice:'))
  const required = ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']
  check(dir + ' files allowlist includes LICENSE, NOTICE and THIRD-PARTY-NOTICES.md', Array.isArray(pkg.files) && required.every((file) => pkg.files.includes(file)))
}

// Every current README license section must describe the PolyForm software license.
const readmeLicenseFiles = [
  'README.md',
  'README-zh.md',
  ...licensePackages.map((dir) => dir + '/README.md'),
  'packages/advisers/README-zh.md',
  'packages/link-feishu/README.md',
]
for (const file of readmeLicenseFiles) {
  check(file + ' license section mentions PolyForm', /PolyForm/.test(read(file)))
}

// Current-state docs must not present Apache-2.0/MIT as the current license. The
// patterns below deliberately do not match historical sentences such as
// "Apache-2.0 for advisers@0.2.0-preview.71" or competitor descriptions.
const staleLicenseClaims = [
  [/this and future versions are Apache-2\.0/i, 'claims future versions are Apache-2.0'],
  [/本版本及后续版本为\s*Apache-2\.0/, 'claims future versions are Apache-2.0 (zh)'],
  [/Licensed under the Apache License/i, 'presents Apache-2.0 as the license'],
  [/Apache License, Version 2\.0\./, 'presents Apache-2.0 as the license'],
  [/Apache-2\.0 core (?:free|stays free)/i, 'claims an Apache-2.0 core'],
]
const currentDocs = [
  'README.md',
  'README-zh.md',
  'docs/QUICKSTART.md',
  'docs/POSITIONING.md',
  'docs/PRICING-CHANNEL.md',
  ...licensePackages.map((dir) => dir + '/README.md'),
  'packages/advisers/README-zh.md',
]
const stale = []
for (const file of currentDocs) {
  const lines = read(file).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    for (const [re, label] of staleLicenseClaims) {
      if (re.test(lines[index])) stale.push(file + ':' + (index + 1) + ' ' + label)
    }
  }
}
check('current docs do not claim Apache-2.0/MIT as the current license', stale.length === 0, stale.join('; '))

// The current version must be the one the user-facing docs advertise.
const version = versions['advisers']
const advertised = [
  ['README.md', version],
  ['README-zh.md', version],
  ['packages/advisers/README.md', version],
  ['packages/advisers/README-zh.md', version],
]
for (const [file, needle] of advertised) {
  const text = read(file)
  check(`${file} advertises ${version}`, text.includes(needle))
  // Any other 0.2.0 preview version in the "Status" docs is stale unless it is
  // another workspace package's current version (e.g. advisers-core).
  const allowed = new Set(Object.values(versions))
  const stale = [...text.matchAll(/0\.2\.0-preview\.(\d+)/g)]
    .map((m) => `0.2.0-preview.${m[1]}`)
    .filter((v) => !allowed.has(v))
  check(`${file} has no stale 0.2.0 preview reference`, stale.length === 0, [...new Set(stale)].join(', '))
}

const changelog = read('CHANGELOG.md')
const rawFirstHeading = /^##\s+[^\n]+/m.exec(changelog)?.[0] ?? ''
const firstHeading = /^##\s+(\S+)/m.exec(changelog)?.[1] ?? ''
check('CHANGELOG.md top section is the current version', firstHeading === version, `found ${firstHeading}, expected ${version}`)

// ---------------------------------------------------------------------------
// Release-state wording (0.3.0 shipped a tarball whose README/CHANGELOG still
// said "release candidate"). The check is version-attributed: a negative phrase
// only fails when the CURRENT version is the version it describes, so historical
// sentences ("0.2.4 was an unpublished release candidate", "0.3.0's tarballs
// shipped release-candidate text") stay valid.
// ---------------------------------------------------------------------------
const RELEASE_STATE_PATTERNS = [
  /release[- ]candidate/gi,
  /not\s+published/gi,
  /unpublished/gi,
  /尚未发布/g,
  /未发布/g,
  /发布候选/g,
  /候选版本/g,
]

/** Version number written immediately before \`index\` (80 chars window). */
function precedingVersion(text, index) {
  const windowText = text.slice(Math.max(0, index - 80), index)
  let nearest = ''
  for (const match of windowText.matchAll(/\b(\d+\.\d+\.\d+)\b/g)) nearest = match[1]
  return nearest
}

/** Negative release-state phrases attributed to \`currentVersion\`. */
function releaseStateProblems(text, currentVersion) {
  const problems = []
  for (const pattern of RELEASE_STATE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0
      if (precedingVersion(text, index) === currentVersion) {
        problems.push(match[0] + ' (attributed to ' + currentVersion + ')')
      }
    }
  }
  return problems
}

/** CHANGELOG \`Status:\` lines are a strong form regardless of attribution. */
function changelogStatusProblems(text) {
  const problems = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (/^Status[:：]/.test(trimmed) && /release[- ]candidate|not\s+published|尚未发布|未发布|发布候选/i.test(trimmed)) {
      problems.push(trimmed.slice(0, 140))
    }
  }
  return problems
}

check(
  'CHANGELOG.md top heading is not a release-candidate heading',
  !/release[- ]candidate/i.test(rawFirstHeading),
  `found ${rawFirstHeading}`,
)
const topSectionEnd = changelog.slice(1).search(/^##\s+/m)
const topSection = topSectionEnd === -1 ? changelog.slice(1) : changelog.slice(1, topSectionEnd + 1)
check(
  'CHANGELOG.md top section has no stale "npm @latest is still" line',
  !/npm @latest is still/i.test(topSection),
)
check(
  'CHANGELOG.md top section has no release-candidate Status line',
  changelogStatusProblems(topSection).length === 0,
  changelogStatusProblems(topSection).join('; '),
)
const changelogProblems = releaseStateProblems(topSection, version)
check(
  'CHANGELOG.md top section does not describe ' + version + ' as a release candidate',
  changelogProblems.length === 0,
  [...new Set(changelogProblems)].join('; '),
)

// All package READMEs that ship in a tarball, not only the root/advisers ones:
// the 0.3.0 failure included packages/core and packages/office READMEs.
const releaseStateDocs = [
  'README.md',
  'README-zh.md',
  'packages/advisers/README.md',
  'packages/advisers/README-zh.md',
  'packages/core/README.md',
  'packages/office/README.md',
]
for (const file of releaseStateDocs) {
  const text = read(file)
  const problems = releaseStateProblems(text, version)
  check(
    file + ' does not describe ' + version + ' as a release candidate or unpublished',
    problems.length === 0,
    [...new Set(problems)].join('; '),
  )
  check(file + ' has no stale "npm @latest is still" line', !/npm @latest is still/i.test(text))
}

// Offline fixture self-test: proves the detector still catches the real 0.3.0
// defect (EN/ZH READMEs, CHANGELOG Status) and does not fire on the historical
// sentences the 0.3.1 tree legitimately contains.
if (process.argv.includes('--self-test')) {
  const fixtures = [
    ['v0.3.0 EN README', '`0.3.0` is a release candidate; npm @latest is still 0.2.3:', '0.3.0', true],
    ['v0.3.0 ZH README', '`0.3.0` 是 release candidate（2026-11-20）；npm `latest` 仍是 0.2.3', '0.3.0', true],
    ['v0.3.0 CHANGELOG status', '## 0.3.0 (release candidate, 2026-11-20)\n\nStatus: **release candidate, not published**.', '0.3.0', true],
    ['released README confirms publish', '`0.3.1` was published on 2026-11-20 and is the current latest; 0.2.4 was an unpublished release candidate.', '0.3.1', false],
    ['historical old-candidate sentence', 'it supersedes `0.3.0`, whose published tarballs shipped release-candidate READMEs', '0.3.1', false],
    ['private packages are not published', 'the two private `advisers-link-*` packages are held at the same version but are not published.', '0.3.1', false],
  ]
  let selfTestFailures = 0
  for (const [name, text, currentVersion, expected] of fixtures) {
    const statusProblems = name.includes('CHANGELOG') ? changelogStatusProblems(text) : []
    const detected = releaseStateProblems(text, currentVersion).length > 0 || statusProblems.length > 0
    const ok = detected === expected
    if (!ok) selfTestFailures += 1
    console.log((ok ? 'PASS' : 'FAIL') + ' self-test :: ' + name + (ok ? '' : ' (expected ' + (expected ? 'detection' : 'clean') + ')'))
  }
  console.log('')
  console.log(selfTestFailures === 0 ? 'PASS release-state self-test (' + fixtures.length + ' fixtures)' : 'FAIL release-state self-test')
  if (selfTestFailures > 0 || failures.length > 0) process.exit(1)
  process.exit(0)
}

if (failures.length) {
  console.error(`\n${failures.length} docs/version inconsistency(ies):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`\nPASS docs/version consistency (${version})`)
