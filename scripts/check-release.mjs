#!/usr/bin/env node
/**
 * Release consistency gate for the six publishable packages.
 *
 *   node scripts/check-release.mjs                 # lockstep + pins + constants
 *   node scripts/check-release.mjs --require-tag   # also require git tag v<version>
 *   node scripts/check-release.mjs --registry      # also query registry.npmjs.org
 *
 * CI runs the default mode. check-docs.mjs covers README/CHANGELOG advertising;
 * this script covers the package graph that check-docs used to miss.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const read = (file) => readFileSync(join(root, file), 'utf8')
const json = (file) => JSON.parse(read(file))
const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''))
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !detail ? '' : ' — ' + detail))
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

if (failures.length) {
  console.error('\n' + failures.length + ' release inconsistency(ies):')
  for (const failure of failures) console.error('- ' + failure)
  process.exit(1)
}
console.log('\nPASS release consistency (' + version + ')')
