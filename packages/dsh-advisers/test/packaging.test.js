import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
const LEDGER_READ_SPECIFIER = 'advisers/lib/ledger-read.js'

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

test('the read-only ledger facade is a controlled advisers subpath and loads lazily', async () => {
  // 0.3.0: the DSH read tools consume the real ledger through this narrow
  // read-only subpath. It must exist in the published exports map, must not
  // export lib/sqlite.js, and must not import node:sqlite at module top level
  // (a host without node:sqlite must still be able to import it and get a stable
  // E_LEDGER_UNAVAILABLE instead of a load crash).
  assert.equal(
    advisersManifest.exports && advisersManifest.exports['./lib/ledger-read.js'],
    './lib/ledger-read.js',
    'the advisers package must export the ./lib/ledger-read.js subpath',
  )
  assert.equal(
    advisersManifest.exports && advisersManifest.exports['./lib/sqlite.js'],
    undefined,
    'the write-capable lib/sqlite.js must never be exported',
  )
  const facadePath = resolve(repoRoot, 'packages/advisers/lib/ledger-read.js')
  const facade = readFileSync(facadePath, 'utf8')
  assert.doesNotMatch(facade, /^\s*import[^\n]*node:sqlite/m, 'the facade must not import node:sqlite at top level')
  assert.doesNotMatch(facade, /^\s*import[^\n]*['"]\.\/sqlite\.js['"]/m, 'the facade must import lib/sqlite.js lazily')
  assert.match(facade, /await import\(['"]\.\/sqlite\.js['"]\)/, 'the facade must lazy-load lib/sqlite.js')

  const resolved = import.meta.resolve(LEDGER_READ_SPECIFIER)
  assert.ok(
    resolved.endsWith('/advisers/lib/ledger-read.js') || resolved.endsWith('\\advisers\\lib\\ledger-read.js'),
    'resolved URL should point at the advisers ledger-read module: ' + resolved,
  )
  const facadeModule = await import(LEDGER_READ_SPECIFIER)
  for (const name of ['readLedgerStatus', 'readOpenCommitmentIndex', 'readEntityById', 'readLedgerSnapshot', 'resolveAdvisersHome', 'LedgerReadError']) {
    assert.equal(typeof facadeModule[name], 'function', 'ledger-read must export ' + name)
  }
  // A relative home is a config error even though no database is touched.
  assert.throws(() => facadeModule.resolveAdvisersHome({ home: 'relative/path' }), (error) => error.code === 'E_USAGE')
  // An unavailable ledger is a stable code, not a raw SQLite error.
  await assert.rejects(
    facadeModule.readOpenCommitmentIndex({ home: join(pkgDir, 'definitely-not-a-ledger-home') }),
    (error) => error instanceof facadeModule.LedgerReadError && error.code === 'E_LEDGER_ABSENT',
  )
})

test('manifest publishes the bundle files and the Node 22.16 floor', () => {
  assert.equal(manifest.main, './index.js')
  assert.ok(Array.isArray(manifest.files) && manifest.files.includes('index.js'), 'files must ship index.js')
  assert.ok(manifest.files.includes('lib'), 'files must ship the lib/ helper directory')
  assert.equal(manifest.engines && manifest.engines.node, '>=22.16', 'needs engines.node >=22.16 (SQLite FTS5)')
  assert.equal(manifest.engines && manifest.engines.dsh, '>=0.2.1-rc.5 <0.3.0')
})

test('npm pack dry-run ships the entry point and depends on advisers', () => {
  // Windows has no "npm" executable on PATH, only npm.cmd: execFileSync needs a
  // shell there (same pattern as scripts/pack-smoke.mjs; windows triage F).
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: pkgDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  const files = new Set(JSON.parse(raw)[0].files.map((file) => file.path))
  assert.ok(files.has('index.js'), 'tarball must contain index.js')
  assert.ok(files.has('lib/read.js'), 'tarball must contain the read helper used by index.js')
  assert.ok(files.has('package.json'), 'tarball must contain package.json')
  assert.ok(files.has('README.md'), 'tarball must contain README.md')
  assert.ok(![...files].some((file) => file.startsWith('../')), 'tarball must not reference files outside the package')
})
