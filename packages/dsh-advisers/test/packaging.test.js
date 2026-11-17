import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Packaging regression guard for dsh-advisers.
//
// 0.2.0 imported the content-safety layer with a monorepo-relative specifier
// (../advisers/lib/safety/index.js). The tarball cannot contain a sibling
// package's files, so `import('dsh-advisers')` failed with ERR_MODULE_NOT_FOUND
// after a clean install even though scripts/pack-smoke.mjs printed PASS.
// The bundle must import the published `advisers` package through a declared
// dependency + export subpath, and its package.json must pin the Node floor that
// makes the default SQLite ledger (FTS5) work.

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(pkgDir, '..', '..')
const manifest = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8'))
const entry = readFileSync(resolve(pkgDir, 'index.js'), 'utf8')
const advisersManifest = JSON.parse(readFileSync(resolve(repoRoot, 'packages/advisers/package.json'), 'utf8'))

const SAFETY_SPECIFIER = 'advisers/lib/safety/index.js'

test('bundle resolves the safety layer from the published advisers package', () => {
  assert.ok(
    entry.includes("from '" + SAFETY_SPECIFIER + "'"),
    'index.js must import the safety layer via the bare package subpath',
  )
  assert.doesNotMatch(entry, /from\s*['"]\.\.\//, 'index.js must not import files outside the package')
  assert.equal(
    manifest.dependencies && manifest.dependencies.advisers,
    manifest.version,
    'the advisers dependency must be pinned to the lockstep release version',
  )
  assert.equal(
    advisersManifest.exports && advisersManifest.exports['./lib/safety/index.js'],
    './lib/safety/index.js',
    'the advisers package must export the ./lib/safety/index.js subpath',
  )
})

test('safety subpath resolves at runtime and exposes classify()', async () => {
  const resolved = import.meta.resolve(SAFETY_SPECIFIER)
  assert.ok(
    resolved.endsWith('/advisers/lib/safety/index.js') || resolved.endsWith('\\advisers\\lib\\safety\\index.js'),
    'resolved URL should point at the advisers safety module: ' + resolved,
  )
  const safety = await import(SAFETY_SPECIFIER)
  assert.equal(typeof safety.classify, 'function', 'classify must be exported')
  const result = safety.classify('周五前把 Q4 报价发给王工', { surface: 'dsh.tool' })
  assert.equal(typeof result, 'object')
  assert.equal(typeof result.action, 'string')
})

test('manifest publishes the bundle files and the Node 22.16 floor', () => {
  assert.equal(manifest.main, './index.js')
  assert.ok(Array.isArray(manifest.files) && manifest.files.includes('index.js'), 'files must ship index.js')
  assert.equal(manifest.engines && manifest.engines.node, '>=22.16', 'needs engines.node >=22.16 (SQLite FTS5)')
  assert.equal(manifest.engines && manifest.engines.dsh, '>=0.2.1-rc.5 <0.3.0')
})

test('npm pack dry-run ships the entry point and depends on advisers', () => {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: pkgDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const files = new Set(JSON.parse(raw)[0].files.map((file) => file.path))
  assert.ok(files.has('index.js'), 'tarball must contain index.js')
  assert.ok(files.has('package.json'), 'tarball must contain package.json')
  assert.ok(files.has('README.md'), 'tarball must contain README.md')
  assert.ok(![...files].some((file) => file.startsWith('../')), 'tarball must not reference files outside the package')
})
