#!/usr/bin/env node
/**
 * Pack dry-run smoke: every publishable package must contain its runtime files.
 *
 * A package can pass `npm pack` and still ship a broken CLI when a file that the
 * entry point imports relative to itself is missing from the `files` allowlist
 * (that happened in preview.47–.56: `lib/capture.js`, `lib/doc-review.js` and
 * `lib/research.js` were imported by `bin/advisers.js` but not packed).
 *
 * This script therefore walks the local import graph from each entry point and
 * asserts every reachable local file is present in the dry-run tarball.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

// License migration (0.2.0): every tarball must carry the software license, the
// required notice and the generated third-party notices, and must not ship the old
// Apache-2.0 text.
const LICENSE_ID = 'PolyForm-Noncommercial-1.0.0'
const REQUIRED_FILES = ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']
const POLYFORM_MARKER = 'PolyForm Noncommercial License 1.0.0'

const packages = [
  { dir: 'packages/core', name: 'advisers-core', entries: ['dist/index.js'] },
  { dir: 'packages/office', name: 'advisers-office', entries: ['dist/index.js'] },
  { dir: 'packages/policy-strict', name: 'advisers-policy-strict', entries: ['dist/index.js'] },
  { dir: 'packages/bridge-hermes', name: 'advisers-bridge-hermes', entries: ['dist/index.js'] },
  { dir: 'packages/advisers', name: 'advisers', entries: ['bin/advisers.js', 'index.js'] },
  { dir: 'packages/dsh-advisers', name: 'dsh-advisers', entries: ['index.js'] },
]

// Relative local imports only; bare package specifiers are resolved at install time.
const LOCAL_IMPORT_RE = [
  /(?:import|export)[^'"\n]*?from\s*['"](\.[^'"]+)['"]/g,
  /\bimport\s*['"](\.[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
]

function localImports(file) {
  const source = readFileSync(file, 'utf8')
  const specs = new Set()
  for (const re of LOCAL_IMPORT_RE) {
    for (const match of source.matchAll(re)) specs.add(match[1])
  }
  return [...specs].map((spec) => {
    const target = resolve(dirname(file), spec)
    try {
      if (statSync(target).isDirectory()) return join(target, 'index.js')
    } catch {}
    // Node ESM/CJS: extensionless relative specifiers are not valid, but be
    // forgiving for `.json` and `./dir` style imports in generated output.
    return /\.[cm]?jsx?$|\.json$/.test(target) ? target : `${target}.js`
  })
}

function insidePackage(pkgDir, file) {
  const rel = relative(pkgDir, file)
  return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep)
}

/** Files reachable from entries through relative imports (inside the package only). */
function reachableFiles(pkgDir, entries) {
  const seen = new Set()
  const stack = entries.map((entry) => resolve(pkgDir, entry))
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (!insidePackage(pkgDir, file)) continue // checkout-only fallback, not shipped
    let stat
    try {
      stat = statSync(file)
    } catch {
      throw new Error(`imported file is missing on disk: ${relative(pkgDir, file)}`)
    }
    if (!stat.isFile() || !/\.[cm]?js$/.test(file)) continue
    for (const dep of localImports(file)) if (!seen.has(dep)) stack.push(dep)
  }
  return [...seen].filter((file) => insidePackage(pkgDir, file))
}

let failed = false
for (const { dir, name, entries } of packages) {
  try {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const info = JSON.parse(raw)[0]
    const packed = new Set(info.files.map((f) => f.path))
    if (!packed.has('package.json')) throw new Error('missing package.json in tarball')

    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
    if (pkg.license !== LICENSE_ID) throw new Error('package.json license is ' + String(pkg.license) + ', expected ' + LICENSE_ID)
    const missingRequired = REQUIRED_FILES.filter((file) => !packed.has(file))
    if (missingRequired.length) throw new Error('tarball is missing required license file(s): ' + missingRequired.join(', '))
    const licenseText = readFileSync(resolve(dir, 'LICENSE'), 'utf8')
    if (!licenseText.includes(POLYFORM_MARKER)) throw new Error('LICENSE does not contain the PolyForm Noncommercial 1.0.0 text')
    if (licenseText.includes('Apache License')) throw new Error('LICENSE still contains the Apache License text')

    const reachable = reachableFiles(resolve(dir), entries)
    const missing = reachable
      .map((file) => relative(resolve(dir), file).split(sep).join('/'))
      .filter((file) => !packed.has(file))
    if (missing.length) throw new Error(`tarball is missing imported runtime file(s): ${missing.join(', ')}`)

    console.log(`PASS ${name}@${info.version} (${packed.size} files incl. LICENSE/NOTICE/THIRD-PARTY-NOTICES.md, license=${pkg.license}, ${reachable.length} local imports checked)`)
  } catch (error) {
    failed = true
    console.error(`FAIL ${name}: ${String(error.stderr || error.message).slice(0, 800)}`)
  }
}
if (failed) process.exit(1)
