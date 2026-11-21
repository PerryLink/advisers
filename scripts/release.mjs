#!/usr/bin/env node
/**
 * Stage the six publishable packages on the official npm registry.
 *
 *   node scripts/release.mjs                  # stage with RELEASE_TAG (default next)
 *   RELEASE_TAG=latest node scripts/release.mjs
 *   node scripts/release.mjs --dry-run        # npm stage publish --dry-run only
 *   node scripts/release.mjs --provenance     # require npm provenance (OIDC CI only)
 *   node scripts/release.mjs --provenance --publish  # direct OIDC publish (validates a pending Trusted Publisher)
 *
 * Provenance / Trusted Publishing:
 *   --provenance (or ADVISERS_PROVENANCE=1) asks npm to attach build provenance
 *   attestations. That only works from an OIDC-capable CI runner (GitHub Actions
 *   with `permissions: id-token: write` and a Trusted Publisher configured for
 *   every package on npmjs.com). A local terminal has no OIDC identity, so the
 *   default remains the existing local staged flow; requesting provenance there
 *   fails early with instructions instead of silently publishing unsigned. When
 *   the OIDC request environment is present, provenance is attempted by default.
 *   ADVISERS_PROVENANCE=0 or --no-provenance force it off.
 *
 * When --provenance is active, NPM_TOKEN must be unset: a long-lived npm token
 * cannot be combined with OIDC provenance, so the script fails closed instead of
 * publishing without the OIDC identity. A failed `npm stage publish` prints the
 * npm output and the npm debug-log directory before exiting non-zero.
 *
 * This script NEVER approves a stage. Approval needs the account owner's OTP
 * (or the owner's approval of a CI-staged build) and must be done by that
 * person in their own terminal:
 *   npm stage approve <stage-id> --registry https://registry.npmjs.org/
 *
 * Preconditions: clean tree, HEAD tagged v<version>, official registry, and
 * the six packages on the same version. Override only deliberately:
 *   ADVISERS_RELEASE_ALLOW_DIRTY=1 ADVISERS_RELEASE_ALLOW_NO_TAG=1
 *   ADVISERS_ALLOW_ALREADY_STAGED=1 ADVISERS_ALLOW_ALREADY_PUBLISHED=1
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const registry = process.env.ADVISERS_REGISTRY || 'https://registry.npmjs.org/'
const dryRun = process.argv.includes('--dry-run')
const direct = process.argv.includes('--publish')
const packages = [
  ['packages/core', 'advisers-core'],
  ['packages/office', 'advisers-office'],
  ['packages/policy-strict', 'advisers-policy-strict'],
  ['packages/bridge-hermes', 'advisers-bridge-hermes'],
  ['packages/advisers', 'advisers'],
  ['packages/dsh-advisers', 'dsh-advisers'],
]
const tag = process.env.RELEASE_TAG || 'next'

if (registry !== 'https://registry.npmjs.org/') {
  console.error('refusing to release to unexpected registry: ' + registry)
  process.exit(2)
}
if (!['next', 'latest'].includes(tag)) {
  console.error('RELEASE_TAG must be next or latest (got ' + tag + ')')
  process.exit(2)
}
if (process.env.NPM_OTP) {
  console.error('NPM_OTP is not accepted here: approval must be done by the account owner in their own terminal.')
  process.exit(2)
}

// Provenance / Trusted Publishing. npm can only attach build provenance when the
// publisher authenticates through a supported CI provider (GitHub Actions with
// `permissions: id-token: write` + a Trusted Publisher on npmjs.com; npm CLI >=
// 11.15.0 for staged publishing with OIDC). The default therefore stays the
// existing local staged flow: provenance is used only when an OIDC request
// environment is actually present, or when it is explicitly requested.
const flagProvenance = process.argv.includes('--provenance')
const flagNoProvenance = process.argv.includes('--no-provenance')
if (flagProvenance && flagNoProvenance) {
  console.error('--provenance and --no-provenance are mutually exclusive')
  process.exit(2)
}
const provenanceEnv = (process.env.ADVISERS_PROVENANCE || '').toLowerCase()
if (provenanceEnv && !['0', '1', 'true', 'false'].includes(provenanceEnv)) {
  console.error('ADVISERS_PROVENANCE must be 0/1/true/false (got ' + process.env.ADVISERS_PROVENANCE + ')')
  process.exit(2)
}
const oidcRequestable = Boolean(
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
)
let provenance = oidcRequestable
if (flagNoProvenance || provenanceEnv === '0' || provenanceEnv === 'false') provenance = false
if (flagProvenance || provenanceEnv === '1' || provenanceEnv === 'true') provenance = true

const npmAtLeast = (found, minimum) => {
  const parse = (value) => String(value).replace(/^v/, '').split('-')[0].split('.').map((part) => Number(part) || 0)
  const left = parse(found)
  const right = parse(minimum)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] || 0
    const b = right[index] || 0
    if (a !== b) return a > b
  }
  return true
}
const npmCliVersion = () => {
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

if (provenance && !oidcRequestable) {
  console.error(
    [
      'provenance was requested, but this environment cannot provide an npm OIDC identity.',
      '',
      'npm attaches provenance attestations only when the publisher authenticates through a',
      'supported CI provider. For GitHub Actions that means:',
      '  - the publishing job has permissions: { contents: read, id-token: write }',
      '  - every package has a Trusted Publisher configured on npmjs.com (owner decision;',
      '    see the trusted-publishing draft job in .github/workflows/publish.yml)',
      '  - npm CLI >= 11.15.0 (staged publishing with OIDC)',
      '',
      'The local staged flow cannot produce provenance. Nothing was staged.',
      'Drop --provenance / unset ADVISERS_PROVENANCE to stage locally as before.',
    ].join('\n'),
  )
  process.exit(2)
}
if (provenance) {
  if (process.env.NPM_TOKEN) {
    console.error(
      [
        'NPM_TOKEN must not be set when provenance is requested.',
        'Trusted Publishing authenticates through the CI OIDC identity; a long-lived npm',
        'token cannot be combined with --provenance. Unset NPM_TOKEN in the publishing job',
        'and do not add the secret there. Nothing was staged.',
      ].join('\n'),
    )
    process.exit(2)
  }
  const cliVersion = npmCliVersion()
  if (!npmAtLeast(cliVersion, '11.15.0')) {
    console.error(
      'provenance requires npm CLI >= 11.15.0 for trusted/staged publishing; found ' +
        (cliVersion || 'unknown') +
        '. Upgrade npm in the runner, then retry.',
    )
    process.exit(2)
  }
  console.log('provenance: on (npm --provenance via OIDC / Trusted Publishing; npm ' + cliVersion + ')')
} else {
  console.log(
    'provenance: off (local staged publish path unchanged; use --provenance only in an OIDC-capable CI job with a configured npm Trusted Publisher)',
  )
}

const readJson = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'))
const versions = packages.map(([dir]) => [dir, readJson(dir + '/package.json').version])
const version = versions[0][1]
for (const [dir, ver] of versions) {
  if (ver !== version) {
    console.error('lockstep violation: ' + dir + ' is ' + ver + ' but packages/core is ' + version + '; run node scripts/set-version.mjs first')
    process.exit(1)
  }
}

if (!dryRun && process.env.ADVISERS_RELEASE_ALLOW_DIRTY !== '1') {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
  if (dirty) {
    console.error('working tree is dirty; commit first (or set ADVISERS_RELEASE_ALLOW_DIRTY=1)')
    process.exit(1)
  }
}

if (!dryRun) {
  let headTag = ''
  try {
    headTag = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {}
  const expected = 'v' + version
  if (headTag !== expected) {
    if (process.env.ADVISERS_RELEASE_ALLOW_NO_TAG !== '1') {
      console.error('HEAD is not tagged ' + expected + ' (found: ' + (headTag || 'no tag') + '); create the tag or set ADVISERS_RELEASE_ALLOW_NO_TAG=1')
      process.exit(1)
    }
    console.warn('WARNING: releasing without tag ' + expected)
  }
}

// 0.3.2: npm provenance records the workflow ref. Publishing from a branch that
// merely POINTS at the tag commit still records refs/heads/main (the 0.3.0
// defect), so a provenance publish outside the version tag ref fails closed.
if (!dryRun && provenance && process.env.GITHUB_REF && process.env.GITHUB_REF !== 'refs/tags/v' + version) {
  console.error('provenance publish must run from refs/tags/v' + version + ' (got ' + process.env.GITHUB_REF + '); the SLSA attestation records this ref')
  process.exit(2)
}

/**
 * Fail-closed registry read after a direct publish. npm has been observed
 * exiting 0 when the OIDC publish did not actually land (misconfigured or
 * stage-only Trusted Publisher, silent fallback), so the release script must
 * verify the registry instead of trusting npm's exit code. Polls for a short
 * propagation window; returns true only when the version is visible.
 */
async function waitForPublishedVersion(name, ver, { attempts = 180, intervalMs = 5000 } = {}) {
  // npm's registry can take several minutes to make a fresh publish visible
  // (observed ~9 minutes during the 0.3.2 release). Poll for up to 15 minutes
  // instead of treating normal propagation as a failed publish; a genuinely
  // misconfigured publisher still fails after the window, before the next
  // package is attempted.
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt === 13) {
      console.log('  waiting for registry propagation of ' + name + '@' + ver + ' (npm can take several minutes; up to 15 minutes)') 
    }
    try {
      const res = await fetch(registry + name + '/' + ver, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) })
      if (res.status === 200) {
        const doc = await res.json()
        if (doc && doc.version === ver) return true
      }
    } catch {}
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

async function tarballExists(name, ver) {
  try {
    const res = await fetch(registry + name + '/-/' + name + '-' + ver + '.tgz', { method: 'HEAD', signal: AbortSignal.timeout(15000) })
    return res.status === 200
  } catch {
    return false
  }
}

if (!dryRun && process.env.ADVISERS_ALLOW_ALREADY_PUBLISHED !== '1') {
  for (const [dir, name] of packages) {
    const ver = readJson(dir + '/package.json').version
    if (await tarballExists(name, ver)) {
      console.error('already published: ' + name + '@' + ver + '; bump the version (set-version) instead of reusing it')
      process.exit(1)
    }
  }
}

let rcDir
let env = { ...process.env, NPM_CONFIG_REGISTRY: registry }
if (process.env.NPM_TOKEN) {
  rcDir = mkdtempSync(join(tmpdir(), 'advisers-release-'))
  const rc = join(rcDir, '.npmrc')
  writeFileSync(rc, 'registry=' + registry + '\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n')
  env = { ...env, NPM_CONFIG_USERCONFIG: rc }
}

const staged = []
const published = []
let failed = null
try {
  execFileSync('pnpm', ['-r', '--if-present', 'run', 'build'], { cwd: root, stdio: 'inherit' })
  for (const [dir, name] of packages) {
    const cwd = join(root, dir)
    const ver = readJson(dir + '/package.json').version
    console.log('\n== ' + name + '@' + ver + ' (' + tag + ')' + (dryRun ? ' [dry-run]' : ''))
    const args = direct
      ? ['publish', '--tag', tag, '--registry', registry, '--access', 'public']
      : ['stage', 'publish', '--tag', tag, '--registry', registry]
    if (provenance) args.push('--provenance')
    if (dryRun) args.push('--dry-run')
    let out
    try {
      out = execFileSync('npm', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const text = String(error.stdout || '') + '\n' + String(error.stderr || '')
      if (/E409|previously published|already staged/.test(text)) {
        if (process.env.ADVISERS_ALLOW_ALREADY_STAGED !== '1') {
          console.error('E409 for ' + name + '@' + ver + ': this version/tag already exists. Bump the version; do not reuse a staged version.')
          process.exitCode = 1
          continue
        }
        console.warn('already staged/published (allowed by ADVISERS_ALLOW_ALREADY_STAGED=1)')
        continue
      }
      console.error('')
      console.error('npm ' + (direct ? 'publish' : 'stage publish') + ' failed for ' + name + '@' + ver + (provenance ? ' (provenance/OIDC requested)' : '') + '; ' + (direct ? 'publishing' : 'staging') + ' stopped.')
      console.error('--- npm output (tail) ---')
      const output = text.trim()
      console.error(output ? output.split('\n').slice(-80).join('\n') : String(error.message || error))
      console.error('npm debug logs (full cause): ' + join(homedir(), '.npm', '_logs'))
      failed = { name, ver }
      process.exitCode = 1
      break
    }
    if (dryRun) {
      console.log('  dry-run ok (npm validated the package; nothing ' + (direct ? 'published' : 'staged') + ')')
      continue
    }
    if (direct) {
      // Surface npm's own notice output (it names the registry and tag); on
      // success release.mjs used to swallow it, which hid silent no-ops.
      if (out && out.trim()) console.log(out.trim().split('\n').slice(-20).join('\n'))
      console.log('  published: ' + name + '@' + ver)
      const visible = await waitForPublishedVersion(name, ver)
      if (!visible) {
        console.error('')
        console.error('PUBLISH NOT VISIBLE: npm exited 0 for ' + name + '@' + ver + ' but ' + registry + name + '/' + ver + ' is not returning it after the propagation window.')
        console.error('Do not retry blindly: check the Trusted Publisher binding (direct vs stage-only), npm 2FA/staged-publish settings, and whether this publish silently became a stage.')
        failed = { name, ver }
        process.exitCode = 1
        break
      }
      published.push({ name, ver })
      continue
    }
    const id = /staged with id ([0-9a-f-]{36})/i.exec(out)?.[1]
    if (!id) {
      console.error('could not parse stage id from npm output for ' + name)
      console.error(out.trim().slice(-800))
      process.exitCode = 1
      continue
    }
    staged.push({ name, ver, id })
    console.log('  staged: ' + id)
  }
} finally {
  if (rcDir) rmSync(rcDir, { recursive: true, force: true })
}

if (failed) {
  console.error('')
  if (dryRun) {
    console.error('DRY-RUN FAILED: ' + failed.name + '@' + failed.ver + ' did not pass npm validation; nothing was staged.')
  } else {
    console.error((direct ? 'PUBLISHING FAILED: ' : 'STAGING FAILED: ') + failed.name + '@' + failed.ver + (direct ? ' did not publish.' : ' did not stage.'))
    if (staged.length) {
      console.error(staged.length + ' package(s) staged before the failure (review before approving anything):')
      for (const item of staged) console.error('  ' + item.name + '@' + item.ver + '  ' + item.id)
    }
    if (published.length) {
      console.error(published.length + ' package(s) published before the failure:')
      for (const item of published) console.error('  ' + item.name + '@' + item.ver)
    }
    console.error(direct ? 'Review the npm error and debug log before retrying; already published packages cannot be reused.' : 'Nothing was published; approval is a separate human step. Read the npm error and debug log before retrying.')
  }
  process.exit(1)
}
if (dryRun) {
  console.log('\ndry-run finished; nothing was ' + (direct ? 'published' : 'staged') + '.')
  process.exit(process.exitCode || 0)
}
if (direct) {
  if (!published.length) {
    console.error('\nno packages were published')
    process.exit(process.exitCode || 1)
  }
  console.log('\nPublished packages:')
  for (const item of published) console.log('  ' + item.name + '@' + item.ver)
  if (provenance) {
    console.log('\nProvenance was requested. Confirm attestations:')
    for (const item of published) console.log('  npm view ' + item.name + '@' + item.ver + ' dist.attestations --json --registry ' + registry)
    console.log('Empty dist.attestations means the publish did not use OIDC/Trusted Publishing: do not describe the release as provenance-signed.')
  }
  process.exit(process.exitCode || 0)
}
if (!staged.length) {
  console.error('\nno packages were staged')
  process.exit(process.exitCode || 1)
}
console.log('\nStaged packages (approval is a human step; do not send OTP to any agent):')
for (const item of staged) {
  console.log('  npm stage approve ' + item.id + ' --registry ' + registry + '   # ' + item.name + '@' + item.ver)
}
console.log('\nApprove in your own terminal, then verify with:')
console.log('  npm view advisers dist-tags --registry ' + registry)
if (provenance) {
  console.log('\nProvenance was requested. After the owner approves each stage, confirm attestations:')
  for (const item of staged) {
    console.log('  npm view ' + item.name + '@' + item.ver + ' dist.attestations --json --registry ' + registry)
  }
  console.log('Empty dist.attestations after approval means the publish did not use OIDC/Trusted Publishing: do not describe the release as provenance-signed.')
}
process.exit(process.exitCode || 0)
