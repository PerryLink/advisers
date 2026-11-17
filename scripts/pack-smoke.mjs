#!/usr/bin/env node
/**
 * Pack dry-run smoke: every publishable package must contain its runtime files.
 *
 * A package can pass `npm pack` and still ship a broken entry point when a file
 * that the entry point imports relative to itself is missing from the `files`
 * allowlist (that happened in preview.47–.56: `lib/capture.js`, `lib/doc-review.js`
 * and `lib/research.js` were imported by `bin/advisers.js` but not packed).
 *
 * This script therefore walks the local import graph from each entry point and
 * asserts every reachable local file is present in the dry-run tarball.
 *
 * It also validates cross-package relative imports instead of silently skipping
 * them (0.2.0 shipped `dsh-advisers/index.js` importing
 * `../advisers/lib/safety/index.js`, which is not part of the tarball, so a clean
 * install failed with ERR_MODULE_NOT_FOUND while this gate printed PASS):
 * - a STATIC cross-package relative import is never shippable (the tarball cannot
 *   contain files outside the package) -> FAIL, use a published bare specifier;
 * - a DYNAMIC cross-package relative import is accepted only as a development-only
 *   fallback: the target file must exist in the sibling package's tarball, and the
 *   same source file (or the manifest) must reference that package by name, so the
 *   published path can resolve it after install.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const workspaceDir = resolve(root, 'packages')

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

// Every workspace package (including private ones) so cross-package targets can be
// attributed to an owning package instead of being skipped.
const workspace = new Map()
for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'node_modules') continue
  const dirAbs = resolve(workspaceDir, entry.name)
  const manifest = join(dirAbs, 'package.json')
  if (!existsSync(manifest)) continue
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  workspace.set(pkg.name, { name: pkg.name, dirAbs, pkg })
}

// Relative imports only; bare package specifiers are resolved at install time and
// are covered by verify-release's import smoke.
const STATIC_IMPORT_RES = [
  /(?:import|export)[^'"\n]*?from\s*['"](\.[^'"]+)['"]/g,
  /\bimport\s*['"](\.[^'"]+)['"]/g,
  /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
]
const DYNAMIC_IMPORT_RES = [/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g]

function relativeImports(source) {
  const staticSpecs = new Set()
  const dynamicSpecs = new Set()
  for (const re of STATIC_IMPORT_RES) for (const match of source.matchAll(re)) staticSpecs.add(match[1])
  for (const re of DYNAMIC_IMPORT_RES) for (const match of source.matchAll(re)) dynamicSpecs.add(match[1])
  const both = new Set([...staticSpecs, ...dynamicSpecs])
  return { all: [...both].map((spec) => ({ spec, dynamic: dynamicSpecs.has(spec) })) }
}

function resolveSpecifier(file, spec) {
  const target = resolve(dirname(file), spec)
  try {
    if (statSync(target).isDirectory()) return join(target, 'index.js')
  } catch {}
  // Node ESM/CJS: extensionless relative specifiers are not valid, but be forgiving
  // for `.json` and `./dir` style imports in generated output.
  return /\.[cm]?jsx?$|\.json$/.test(target) ? target : `${target}.js`
}

function insideDir(dir, file) {
  const rel = relative(dir, file)
  return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep)
}

/** Tarball-style relative path (forward slashes). */
function tarPath(dir, file) {
  return relative(dir, file).split(sep).join('/')
}

/**
 * Files reachable from entries through relative imports (inside the package only),
 * plus the cross-package relative import edges found on the way.
 */
function reachableFiles(pkgDir, entries) {
  const seen = new Set()
  const crossImports = []
  const stack = entries.map((entry) => resolve(pkgDir, entry))
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (!insideDir(pkgDir, file)) continue // cross-package target: recorded below
    let stat
    try {
      stat = statSync(file)
    } catch {
      throw new Error(`imported file is missing on disk: ${relative(pkgDir, file)}`)
    }
    if (!stat.isFile() || !/\.[cm]?js$/.test(file)) continue
    const source = readFileSync(file, 'utf8')
    for (const { spec, dynamic } of relativeImports(source).all) {
      const target = resolveSpecifier(file, spec)
      if (insideDir(pkgDir, target)) {
        if (!seen.has(target)) stack.push(target)
      } else {
        crossImports.push({ file, spec, target, dynamic })
      }
    }
  }
  return { files: [...seen].filter((file) => insideDir(pkgDir, file)), crossImports }
}

function declaredPackages(pkg) {
  return new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ])
}

/** Does the source mention the sibling package as a bare specifier (fallback guard)? */
function mentionsBareSpecifier(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"]${escaped}(?:/[^'"]*)?['"]`)
  return re.test(source)
}

let failed = false
const records = new Map()

// Phase 1: pack each package, check license files, and walk its local import graph.
for (const { dir, name, entries } of packages) {
  try {
    const pkgDir = resolve(root, dir)
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const info = JSON.parse(raw)[0]
    const packed = new Set(info.files.map((f) => f.path))
    if (!packed.has('package.json')) throw new Error('missing package.json in tarball')

    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    if (pkg.license !== LICENSE_ID) throw new Error('package.json license is ' + String(pkg.license) + ', expected ' + LICENSE_ID)
    const missingRequired = REQUIRED_FILES.filter((file) => !packed.has(file))
    if (missingRequired.length) throw new Error('tarball is missing required license file(s): ' + missingRequired.join(', '))
    const licenseText = readFileSync(join(pkgDir, 'LICENSE'), 'utf8')
    if (!licenseText.includes(POLYFORM_MARKER)) throw new Error('LICENSE does not contain the PolyForm Noncommercial 1.0.0 text')
    if (licenseText.includes('Apache License')) throw new Error('LICENSE still contains the Apache License text')

    const { files, crossImports } = reachableFiles(pkgDir, entries)
    const missing = files.map((file) => tarPath(pkgDir, file)).filter((file) => !packed.has(file))
    if (missing.length) throw new Error(`tarball is missing imported runtime file(s): ${missing.join(', ')}`)

    records.set(name, { dir, name, pkgDir, pkg, packed, files, crossImports, version: info.version })
  } catch (error) {
    failed = true
    console.error(`FAIL ${name}: ${String(error.stderr || error.message).slice(0, 800)}`)
  }
}

// Phase 2: validate cross-package relative import edges against the sibling
// package's tarball. A static edge is never shippable; a dynamic edge is only
// accepted as a guarded development fallback.
let crossFallbacks = 0
for (const record of records.values()) {
  const declared = declaredPackages(record.pkg)
  for (const edge of record.crossImports) {
    const where = `${tarPath(record.pkgDir, edge.file)} -> ${edge.spec}`
    const owner = [...workspace.values()].find((entry) => insideDir(entry.dirAbs, edge.target))
    try {
      if (!owner) throw new Error(`cross-package relative import escapes every workspace package: ${where}`)
      const ownerRecord = records.get(owner.name)
      if (!ownerRecord) throw new Error(`cross-package relative import target package "${owner.name}" is not covered by pack-smoke: ${where}`)
      const targetTarPath = tarPath(owner.dirAbs, edge.target)
      if (!ownerRecord.packed.has(targetTarPath)) {
        throw new Error(`cross-package relative import target is not in the ${owner.name} tarball: ${where} (target ${targetTarPath})`)
      }
      if (!edge.dynamic) {
        throw new Error(
          `static cross-package relative import is not shippable (a tarball cannot contain files outside the package): ${where}; ` +
            `import "${owner.name}" (and expose a subpath export) instead`,
        )
      }
      const source = readFileSync(edge.file, 'utf8')
      const guarded = declared.has(owner.name) || mentionsBareSpecifier(source, owner.name)
      if (!guarded) {
        throw new Error(
          `unguarded cross-package relative import: ${where}; ` +
            `a published install can only resolve "${owner.name}" (declare it as a dependency or import it by name)`,
        )
      }
      crossFallbacks += 1
    } catch (error) {
      failed = true
      console.error(`FAIL ${record.name}: ${String(error.message).slice(0, 800)}`)
    }
  }
}

if (failed) process.exit(1)
for (const record of records.values()) {
  console.log(
    `PASS ${record.name}@${record.version} (${record.packed.size} files incl. LICENSE/NOTICE/THIRD-PARTY-NOTICES.md, ` +
      `license=${record.pkg.license}, ${record.files.length} local imports checked, ${record.crossImports.length} cross-package fallbacks verified)`,
  )
}
if (crossFallbacks) console.log(`PASS cross-package relative imports: ${crossFallbacks} guarded development fallback(s) verified against sibling tarballs`)
