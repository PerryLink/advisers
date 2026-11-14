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
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const read = (file) => readFileSync(join(root, file), 'utf8')
const json = (file) => JSON.parse(read(file))
const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}

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
