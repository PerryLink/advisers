#!/usr/bin/env node
/**
 * Post-approval release verifier for Advisers.
 *
 * Checks the official registry for the expected dist-tag, verifies each tarball
 * against its dist.shasum / dist.integrity, checks license files and the SPDX
 * license field, and optionally installs the published packages into a temp
 * prefix: the CLI gets a version/consent smoke test, and every requested package
 * is dynamically imported from that clean prefix (regression guard for
 * dsh-advisers@0.2.0, whose bundle could not be imported after a clean install).
 *
 * 0.3.0 release-trust additions:
 *   - every package must have non-empty `dist.attestations`; each attestation
 *     bundle is fetched and its SLSA provenance source repository/commit is
 *     checked against the `v<version>` tag, and each known statement subject is
 *     checked against the tarball's dist.integrity;
 *   - the local `v<version>` tag must exist and every package's registry
 *     `gitHead` must equal that tag commit (tag / commit / registry agreement);
 *   - an SBOM, when supplied (`--sbom`) or auto-discovered, must be CycloneDX
 *     with components and no absolute build-machine paths (`--require-sbom`
 *     makes a missing SBOM a failure);
 *   - an unpublished version is a hard failure (post-approval gate), except with
 *     `--allow-unpublished`, which turns a completely unpublished version into an
 *     explicit SKIP (exit 0) and still fails a partial publication.
 *
 * Usage:
 *   node scripts/verify-release.mjs [--version 0.3.0] [--tag latest]
 *        [--registry https://registry.npmjs.org/] [--packages a,b]
 *        [--expected-license PolyForm-Noncommercial-1.0.0]
 *        [--repo PerryLink/advisers] [--expected-commit <sha>]
 *        [--sbom <file>] [--require-sbom]
 *        [--skip-install] [--metadata-only] [--skip-git] [--json]
 *        [--allow-unpublished] [--allow-missing-attestations]
 *        [--allow-version-drift]
 *
 * --skip-install skips both network install phases (CLI smoke + per-package
 * import smoke) and keeps the registry metadata/tarball verification.
 * --metadata-only additionally skips the tarball download/extraction checks
 * (dry runs and fixture tests); it implies --skip-install and is NOT a release
 * gate on its own.
 * --allow-missing-attestations is only for verifying pre-0.3.0 historical
 * releases; a 0.3.0+ release must be checked without it.
 *
 * Exit 0 only when every requested package passes every check, or when
 * --allow-unpublished turns a completely unpublished version into a SKIP.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPackageAttestations, validateSbom } from './check-provenance.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}
const bool = (name) => args.includes('--' + name)

const PUBLISHABLE = [
  ['packages/core', 'advisers-core'],
  ['packages/office', 'advisers-office'],
  ['packages/policy-strict', 'advisers-policy-strict'],
  ['packages/bridge-hermes', 'advisers-bridge-hermes'],
  ['packages/advisers', 'advisers'],
  ['packages/dsh-advisers', 'dsh-advisers'],
]
const packageNames = PUBLISHABLE.map(([, name]) => name)

function currentVersion() {
  try {
    return JSON.parse(readFileSync(join(root, 'packages/advisers/package.json'), 'utf8')).version
  } catch {
    return '0.2.0'
  }
}

const version = flag('version', currentVersion())
const tag = flag('tag', 'latest')
const registry = flag('registry', 'https://registry.npmjs.org/').replace(/\/+$/, '')
const expectedLicense = flag('expected-license', 'PolyForm-Noncommercial-1.0.0')
const expectedRepo = flag('repo', 'PerryLink/advisers')
const expectedCommitArg = flag('expected-commit', '')
const sbomPath = flag('sbom', '')
const packagesArg = flag('packages', packageNames.join(','))
const requestedPackages = packagesArg.split(',').map((item) => item.trim()).filter(Boolean)
const skipInstall = bool('skip-install')
const metadataOnly = bool('metadata-only')
const skipGit = bool('skip-git')
const jsonOut = bool('json')
const allowUnpublished = bool('allow-unpublished')
const allowMissingAttestations = bool('allow-missing-attestations')
const allowVersionDrift = bool('allow-version-drift')
const requireSbom = bool('require-sbom')
const resolvePath = (file) => (isAbsolute(file) ? file : join(root, file))

const checks = []
const failures = []
const warnings = []
function check(pkg, ok, detail) {
  checks.push({ pkg, ok, detail })
  if (!ok) failures.push(pkg + ': ' + detail)
}
function skipCheck(pkg, detail) {
  checks.push({ pkg, ok: true, skipped: true, detail })
}
function warn(detail) {
  warnings.push(detail)
}

function sha1(buf) { return createHash('sha1').update(buf).digest('hex') }
function sha512(buf) { return createHash('sha512').update(buf).digest('base64') }
function licenseSha() { return createHash('sha256').update(readFileSync(join(root, 'LICENSE'))).digest('hex') }

function runGit(argv) {
  try {
    return spawnSync('git', argv, { cwd: root, encoding: 'utf8' }).stdout.trim()
  } catch {
    return ''
  }
}

function verifyCheckout() {
  const versions = []
  for (const [dir, name] of PUBLISHABLE) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
      versions.push([name, pkg.version])
    } catch (error) {
      check('checkout', false, dir + '/package.json could not be read: ' + (error && error.message ? error.message : String(error)))
    }
  }
  const unique = [...new Set(versions.map(([, value]) => value))]
  check('checkout', unique.length === 1, 'six publishable packages are lockstep' + (unique.length === 1 ? ' (' + unique[0] + ')' : ' (found ' + unique.join(', ') + ')'))
  const checkoutVersion = unique[0] || ''
  if (checkoutVersion && checkoutVersion !== version) {
    if (allowVersionDrift) {
      warn('requested version ' + version + ' differs from the checkout version ' + checkoutVersion + ' (--allow-version-drift)')
    } else {
      check('checkout', false, 'requested version ' + version + ' differs from the checkout version ' + checkoutVersion + ' (use --allow-version-drift to verify an older release)')
    }
  } else if (checkoutVersion) {
    check('checkout', true, 'checkout version matches the requested version ' + version)
  }
}

function verifyTagAndCommit() {
  const info = { ref: 'v' + version, tagCommit: '', head: runGit(['rev-parse', 'HEAD']).toLowerCase(), expectedCommit: '' }
  if (skipGit) {
    skipCheck('git', 'tag/commit checks skipped (--skip-git)')
    info.expectedCommit = String(expectedCommitArg || '').toLowerCase()
    return info
  }
  const tagOutput = runGit(['rev-parse', '--verify', '--quiet', info.ref + '^{commit}'])
  info.tagCommit = tagOutput.toLowerCase()
  check('git', Boolean(info.tagCommit), 'tag ' + info.ref + ' exists and resolves to a commit' + (info.tagCommit ? ' (' + info.tagCommit + ')' : ' (create and push the release tag before publishing)'))
  if (info.tagCommit && info.head && info.tagCommit !== info.head) {
    warn('HEAD ' + info.head + ' is not the release tag commit ' + info.tagCommit + '; post-release commits are allowed, but no runtime fix may follow the release tag')
  }
  const requested = String(expectedCommitArg || '').toLowerCase()
  if (requested && info.tagCommit) {
    check('git', requested === info.tagCommit, '--expected-commit ' + requested + ' equals the ' + info.ref + ' tag commit')
  }
  info.expectedCommit = info.tagCommit || requested
  return info
}

async function registryJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'advisers-release-verifier' },
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error('registry HTTP ' + response.status + ' for ' + url)
  return response.json()
}

async function verifyTarball(name, published, workRoot) {
  const dist = published.dist || {}
  const tarballUrl = dist.tarball
  check(name, Boolean(tarballUrl), 'tarball URL present')
  if (!tarballUrl) return null
  const response = await fetch(tarballUrl, { headers: { 'user-agent': 'advisers-release-verifier' }, signal: AbortSignal.timeout(120000) })
  if (!response.ok) { check(name, false, 'tarball HTTP ' + response.status); return null }
  const buf = Buffer.from(await response.arrayBuffer())
  check(name, sha1(buf) === dist.shasum, 'sha1 matches dist.shasum (' + dist.shasum + ')')
  if (dist.integrity && dist.integrity.startsWith('sha512-')) {
    check(name, dist.integrity === 'sha512-' + sha512(buf), 'sha512 matches dist.integrity')
  }
  const dest = join(workRoot, name.replace(/[^a-z0-9-]/gi, '_'))
  mkdirSync(dest, { recursive: true })
  const tar = spawnSync('tar', ['-xzf', '-', '-C', dest], { input: buf, timeout: 120000 })
  if (tar.status !== 0) { check(name, false, 'tarball extract failed: ' + String(tar.stderr || '').slice(0, 200)); return null }
  for (const file of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
    check(name, existsSync(join(dest, 'package', file)), 'tarball contains ' + file)
  }
  const pkgJson = JSON.parse(readFileSync(join(dest, 'package', 'package.json'), 'utf8'))
  check(name, pkgJson.version === version, 'tarball package.json version === ' + version)
  check(name, pkgJson.license === expectedLicense, 'tarball package.json license === ' + expectedLicense)
  if (name === 'advisers') {
    for (const file of ['lib/tos/terms.zh-CN.md', 'lib/tos/summary.zh-CN.md', 'lib/tos/privacy.zh-CN.md', 'lib/tos/safety.zh-CN.md', 'lib/tos/manifest.json']) {
      check(name, existsSync(join(dest, 'package', file)), 'tarball contains ' + file)
    }
  }
  const sha = createHash('sha256').update(readFileSync(join(dest, 'package', 'LICENSE'))).digest('hex')
  check(name, sha === licenseSha(), 'tarball LICENSE matches repo LICENSE')
  return { tarball: tarballUrl, shasum: dist.shasum, integrity: dist.integrity, size: statSync(join(dest, 'package')).size }
}

async function installSmoke(workRoot) {
  const prefix = join(workRoot, 'install')
  const home = join(workRoot, 'home')
  const inst = spawnSync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--registry', registry, 'advisers@' + version], { encoding: 'utf8', timeout: 300000 })
  if (inst.status !== 0) { check('install-smoke', false, 'npm install failed: ' + ((inst.stderr || '') + (inst.stdout || '')).slice(-500)); return }
  const bin = join(prefix, 'node_modules', 'advisers', 'bin', 'advisers.js')
  const env = { ...process.env, ADVISERS_HOME: home, ADVISERS_ACCEPT_TOS: '1', ADVISERS_NO_MODEL: '1' }
  delete env.NODE_TEST_CONTEXT
  const run = (argv) => spawnSync(process.execPath, [bin, ...argv], { env, encoding: 'utf8', timeout: 120000 })
  const v = run(['--version'])
  check('install-smoke', v.status === 0 && String(v.stdout).includes(version), 'installed advisers --version === ' + version)
  const tos = run(['tos', 'status', '--json'])
  check('install-smoke', tos.status === 0 && String(tos.stdout).includes('accepted'), 'installed tos status --json works')
  const help = spawnSync(process.execPath, [bin, '--help'], { env, encoding: 'utf8', timeout: 120000 })
  check('install-smoke', help.status === 0 && String(help.stdout).includes('tos'), 'installed help lists the tos command')
}

/**
 * Import every requested package from a clean temp prefix. This is the release
 * guard for bundles that pass metadata/shasum checks but cannot load after a
 * clean install (dsh-advisers@0.2.0 imported a monorepo-relative safety file).
 */
async function importSmoke(workRoot) {
  const prefix = join(workRoot, 'import-smoke')
  mkdirSync(prefix, { recursive: true })
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const specifiers = requestedPackages.map((name) => name + '@' + version)
  const inst = spawnSync(
    'npm',
    ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--registry', registry, ...specifiers],
    { encoding: 'utf8', timeout: 600000 },
  )
  if (inst.status !== 0) {
    check('import-smoke', false, 'npm install failed: ' + ((inst.stderr || '') + (inst.stdout || '')).slice(-500))
    return
  }
  for (const name of requestedPackages) {
    const probe = [
      'const m = await import(' + JSON.stringify(name) + ');',
      'const keys = Object.keys(m);',
      "if (!keys.length) throw new Error('no named exports');",
      name === 'dsh-advisers'
        ? "if (typeof m.apply !== 'function' || typeof m.version !== 'string') throw new Error('missing apply()/version export');"
        : '',
      'console.log(JSON.stringify({ exports: keys.length }));',
    ].filter(Boolean).join(' ')
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: prefix,
      env,
      encoding: 'utf8',
      timeout: 120000,
    })
    if (run.status === 0) {
      check(name, true, 'import(' + name + ') from a clean temp prefix succeeds ' + String(run.stdout).trim().slice(0, 120))
    } else {
      const detail = String(run.stderr || '').trim().split('\n').slice(-3).join(' | ')
      check(name, false, 'import(' + name + ') failed: ' + detail.slice(0, 500))
    }
  }
}

function verifySbomArtifact() {
  const candidates = [
    join(root, 'release', 'sbom-' + version + '.cdx.json'),
    join(root, 'release', 'SBOM-' + version + '.cdx.json'),
    join(root, 'release', 'advisers-' + version + '.cdx.json'),
    join(root, 'SBOM-' + version + '.cdx.json'),
    join(root, 'sbom.cdx.json'),
  ]
  let file = sbomPath ? resolvePath(sbomPath) : ''
  if (!file) file = candidates.find((candidate) => existsSync(candidate)) || ''
  if (!file) {
    if (requireSbom) {
      check('sbom', false, '--require-sbom was set, but no SBOM was supplied (--sbom <file>) or found under release/')
      return { path: '', status: 'missing' }
    }
    skipCheck('sbom', 'no SBOM supplied or found; pass --sbom <file> (the 0.3.0 GA gate uses --require-sbom)')
    return { path: '', status: 'not-supplied' }
  }
  if (!existsSync(file)) {
    check('sbom', false, 'SBOM file not found: ' + file)
    return { path: file, status: 'missing' }
  }
  let sbom
  try {
    sbom = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    check('sbom', false, 'SBOM is not valid JSON: ' + (error && error.message ? error.message : String(error)))
    return { path: file, status: 'invalid' }
  }
  const result = validateSbom(sbom, { version, packages: packageNames })
  for (const item of result.checks) check('sbom', item.ok, item.detail)
  for (const warning of result.warnings) warn('sbom: ' + warning)
  return { path: file, status: result.ok ? 'passed' : 'failed' }
}

const packageResults = {}
const workRoot = mkdtempSync(join(tmpdir(), 'advisers-verify-release-'))
let unpublishedCount = 0
let publishedCount = 0
let releaseTag = null
let sbom = { path: '', status: 'not-checked' }
try {
  verifyCheckout()
  releaseTag = verifyTagAndCommit()
  for (const name of requestedPackages) {
    let meta
    try {
      meta = await registryJson(registry + '/' + encodeURIComponent(name))
    } catch (error) {
      check(name, false, 'metadata fetch failed: ' + (error && error.message ? error.message : String(error)))
      continue
    }
    const published = meta.versions ? meta.versions[version] : undefined
    if (!published) {
      unpublishedCount += 1
      if (allowUnpublished) {
        skipCheck(name, 'version ' + version + ' is not published on ' + registry + ' yet')
      } else {
        check(name, false, 'version ' + version + ' exists on ' + registry + ' (registry reports it is not published)')
      }
      continue
    }
    publishedCount += 1
    check(name, true, 'version ' + version + ' exists on ' + registry)
    check(name, published.version === version, 'registry version field is ' + version + ' (got ' + published.version + ')')
    check(name, meta['dist-tags'] && meta['dist-tags'][tag] === version, 'dist-tags.' + tag + ' === ' + version + ' (got ' + ((meta['dist-tags'] && meta['dist-tags'][tag]) || 'missing') + ')')
    const dist = published.dist || {}
    const gitHead = String(published.gitHead || '').toLowerCase()
    check(name, Boolean(gitHead), 'registry gitHead is present (ties the tarball to a commit)')
    if (gitHead && releaseTag.expectedCommit) {
      check(name, gitHead === releaseTag.expectedCommit.toLowerCase(), 'registry gitHead === release commit ' + releaseTag.expectedCommit + ' (got ' + gitHead + ')')
    }
    check(name, published.license === expectedLicense, 'license field === ' + expectedLicense + ' (got ' + published.license + ')')
    if (metadataOnly) {
      skipCheck(name, 'tarball checks skipped (--metadata-only)')
    } else {
      const tarball = await verifyTarball(name, published, workRoot)
      if (tarball) packageResults[name] = { ...tarball, gitHead }
    }
    const attestations = await checkPackageAttestations({
      name,
      version,
      published,
      integrity: dist.integrity || '',
      fetchJson: registryJson,
      allowMissing: allowMissingAttestations,
      expectedRepo,
      expectedCommit: releaseTag.expectedCommit,
    })
    for (const item of attestations.checks) {
      if (item.skipped) skipCheck(name, item.detail)
      else check(name, item.ok, item.detail)
    }
    for (const warning of attestations.warnings) warn(name + ': ' + warning)
    if (packageResults[name]) packageResults[name].attestations = attestations.info
  }
  if (!releaseTag.expectedCommit && publishedCount > 0) {
    check('git', false, 'cannot determine the release commit for registry gitHead verification (create tag ' + releaseTag.ref + ' or pass --expected-commit <sha>)')
  }
  const cleanSkip = allowUnpublished && unpublishedCount === requestedPackages.length && failures.length === 0
  if (cleanSkip) {
    skipCheck('sbom', 'SBOM check skipped: the version is not published yet')
    skipCheck('install-smoke', 'install/import smoke skipped: the version is not published yet')
  } else {
    if (unpublishedCount > 0 && publishedCount > 0) {
      check('release', false, 'partial publication: ' + publishedCount + ' of ' + requestedPackages.length + ' requested packages have ' + version + ' on ' + registry + '; expected all-or-none')
    }
    sbom = verifySbomArtifact()
    if (skipInstall || metadataOnly) {
      skipCheck('install-smoke', 'install/import smoke skipped (' + (metadataOnly ? '--metadata-only' : '--skip-install') + ')')
    } else if (unpublishedCount === 0) {
      await installSmoke(workRoot)
      await importSmoke(workRoot)
    } else {
      skipCheck('install-smoke', 'install/import smoke skipped: not every requested package is published')
    }
  }
  const cleanSkipFinal = cleanSkip
  const passed = checks.filter((item) => item.ok && !item.skipped).length
  const skipped = checks.filter((item) => item.skipped).length
  const failed = failures.length
  const status = cleanSkipFinal ? 'skipped-unpublished' : failed ? 'fail' : 'pass'
  if (jsonOut) {
    console.log(JSON.stringify({
      version,
      tag,
      registry,
      packages: requestedPackages,
      status,
      passed,
      skipped,
      failed,
      failures,
      warnings,
      checks,
      releaseTag,
      sbom,
      packageResults,
    }, null, 2))
  } else {
    for (const item of checks) {
      console.log((item.skipped ? 'SKIP' : item.ok ? 'PASS' : 'FAIL') + ' ' + item.pkg + ' :: ' + item.detail)
    }
    for (const warning of warnings) console.log('WARN ' + warning)
    console.log('')
    for (const [name, info] of Object.entries(packageResults)) {
      if (info) console.log(name, '| shasum', info.shasum, '|', info.tarball)
    }
    if (Object.keys(packageResults).length) console.log('')
    if (cleanSkipFinal) {
      console.log('SKIP release verification for ' + version + ': none of the requested packages is published on ' + registry + ' yet.')
      console.log('This is the expected pre-release state; nothing was verified. Re-run without --allow-unpublished after the owner approves the stages.')
    } else if (failed) {
      console.log('FAIL release verification: ' + failed + ' failed / ' + checks.length + ' checks' + (skipped ? ' (' + skipped + ' skipped)' : ''))
    } else {
      console.log('PASS release verification: ' + passed + ' checks' + (skipped ? ' (' + skipped + ' skipped)' : ''))
    }
  }
  process.exitCode = cleanSkipFinal ? 0 : failed ? 1 : 0
} finally {
  rmSync(workRoot, { recursive: true, force: true })
}

