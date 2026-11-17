#!/usr/bin/env node
/**
 * Lockstep version bump for the Advisers workspace.
 *
 * Usage:
 *   node scripts/set-version.mjs --version 0.2.0 [--dry-run] [--no-lockfile]
 *
 * Updates every workspace package version, the internal version constants and
 * every workspace dependency pin, then regenerates pnpm-lock.yaml and runs
 * scripts/check-docs.mjs. Refuses to run when the working tree is dirty unless
 * ADVISERS_VERSION_ALLOW_DIRTY=1.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const version = flag('--version')
const dryRun = argv.includes('--dry-run')
const noLockfile = argv.includes('--no-lockfile')
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/set-version.mjs --version X.Y.Z [--dry-run] [--no-lockfile]')
  process.exit(2)
}

const packageDirs = [
  'packages/core',
  'packages/office',
  'packages/policy-strict',
  'packages/bridge-hermes',
  'packages/advisers',
  'packages/dsh-advisers',
  'packages/link-email',
  'packages/link-feishu',
]

const read = (file) => readFileSync(join(root, file), 'utf8')
const readJson = (file) => JSON.parse(read(file))

const workspace = new Map()
for (const dir of packageDirs) {
  const pkg = readJson(dir + '/package.json')
  workspace.set(pkg.name, dir)
}

if (!dryRun && process.env.ADVISERS_VERSION_ALLOW_DIRTY !== '1') {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
  if (dirty) {
    console.error('working tree is dirty; commit first or set ADVISERS_VERSION_ALLOW_DIRTY=1')
    process.exit(1)
  }
}

const changes = []
for (const dir of packageDirs) {
  const file = dir + '/package.json'
  const pkg = readJson(file)
  if (pkg.version !== version) changes.push([file, 'version', pkg.version, version])
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const dep of Object.keys(pkg[field] || {})) {
      if (!workspace.has(dep)) continue
      if (pkg[field][dep] !== version) changes.push([file, field + '.' + dep, pkg[field][dep], version])
    }
  }
}

const constants = [
  ['packages/advisers/index.js', /(export const version = ')([^']+)(')/],
  ['packages/dsh-advisers/index.js', /(export const version = ')([^']+)(')/],
  ['packages/bridge-hermes/src/index.ts', /(version: ')([^']+)(')/],
]

if (dryRun) {
  console.log('would write version ' + version + ':')
  for (const [file, field, from, to] of changes) console.log('  ' + file + '  ' + field + ': ' + from + ' -> ' + to)
  for (const [file, re] of constants) {
    const match = re.exec(read(file))
    if (match && match[2] !== version) console.log('  ' + file + '  version constant: ' + match[2] + ' -> ' + version)
  }
  process.exit(0)
}

for (const dir of packageDirs) {
  const file = dir + '/package.json'
  const pkg = readJson(file)
  pkg.version = version
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    if (!pkg[field]) continue
    for (const dep of Object.keys(pkg[field])) {
      if (workspace.has(dep)) pkg[field][dep] = version
    }
  }
  writeFileSync(join(root, file), JSON.stringify(pkg, null, 2) + '\n')
}

for (const [file, re] of constants) {
  const text = read(file)
  const next = text.replace(re, (_m, a, _old, c) => a + version + c)
  if (next !== text) writeFileSync(join(root, file), next)
}

console.log('bumped ' + packageDirs.length + ' packages to ' + version)

if (!noLockfile) {
  execFileSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'inherit' })
}
execFileSync('node', ['scripts/check-docs.mjs'], { cwd: root, stdio: 'inherit' })
