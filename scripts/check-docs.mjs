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
const firstHeading = /^##\s+(\S+)/m.exec(changelog)?.[1] ?? ''
check('CHANGELOG.md top section is the current version', firstHeading === version, `found ${firstHeading}, expected ${version}`)

if (failures.length) {
  console.error(`\n${failures.length} docs/version inconsistency(ies):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`\nPASS docs/version consistency (${version})`)
