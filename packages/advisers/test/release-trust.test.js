// Release-trust tooling tests (0.3.0).
//
// These tests never publish, stage, tag, or need npm credentials: provenance
// and SBOM checks are exercised against synthetic fixtures, and a loopback HTTP
// server stands in for the npm registry. The publish workflow invariant checks
// run offline through `scripts/check-provenance.mjs --self-test`.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const scriptPath = (name) => join(repoRoot, 'scripts', name)
const checkProvenanceScript = scriptPath('check-provenance.mjs')
const verifyReleaseScript = scriptPath('verify-release.mjs')
const releaseScript = scriptPath('release.mjs')
const { PACKAGES, checkPackageAttestations, validateSbom } = await import(
  new URL('../../../scripts/check-provenance.mjs', import.meta.url).href,
)

const SLSA = 'https://slsa.dev/provenance/v1'
const NPM_PUBLISH = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1'
const REPO = 'PerryLink/advisers'
const FAKE_COMMIT = 'a'.repeat(40)

function cleanEnv(extra = {}) {
  const env = { ...process.env }
  for (const key of ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ADVISERS_PROVENANCE', 'NPM_TOKEN']) delete env[key]
  return { ...env, ...extra }
}

function run(script, args, env = cleanEnv()) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, env, encoding: 'utf8', timeout: 60000 })
}

// The loopback registry fixture lives in this test process, so the child process
// must be awaited asynchronously; spawnSync would block the event loop and the
// fixture server could never answer the child's requests.
function runAsync(script, args, env = cleanEnv()) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
  })
}

function digestFixture(text) {
  const hex = createHash('sha512').update(Buffer.from(text)).digest('hex')
  return { hex, integrity: 'sha512-' + Buffer.from(hex, 'hex').toString('base64') }
}

function statement(predicateType, options) {
  const { name, version, digestHex, repo = REPO, commit = '' } = options
  const subject = [{ name: 'pkg:npm/' + name + '@' + version, digest: { sha512: digestHex } }]
  const predicate = predicateType === SLSA
    ? {
        buildDefinition: {
          buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
          externalParameters: {
            workflow: { repository: 'https://github.com/' + repo, path: '.github/workflows/publish.yml', ref: 'refs/tags/v' + version },
          },
          resolvedDependencies: [{ uri: 'git+https://github.com/' + repo, digest: { gitCommit: commit } }],
        },
        runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' } },
      }
    : { name, version, registry: 'https://registry.npmjs.org' }
  return { _type: 'https://in-toto.io/Statement/v1', predicateType, subject, predicate }
}

function attestationBundle(predicateTypes, options) {
  return {
    attestations: predicateTypes.map((predicateType) => ({
      predicateType,
      bundle: {
        mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.2',
        dsseEnvelope: {
          payloadType: 'application/vnd.in-toto+json',
          payload: Buffer.from(JSON.stringify(statement(predicateType, options))).toString('base64'),
          signatures: [],
        },
      },
    })),
  }
}

function metadataFixture(name, version, options = {}) {
  const { tag = 'next', gitHead = '', integrity = '', attestationUrl = '', attestations, license = 'PolyForm-Noncommercial-1.0.0' } = options
  const dist = {
    tarball: 'http://127.0.0.1:1/' + name + '/-/' + name + '-' + version + '.tgz',
    shasum: '0'.repeat(40),
    integrity,
  }
  if (attestations !== undefined) dist.attestations = attestations
  else if (attestationUrl) dist.attestations = { url: attestationUrl, provenance: { predicateType: SLSA } }
  return {
    name,
    'dist-tags': { [tag]: version, latest: version },
    versions: { [version]: { name, version, license, gitHead, dist } },
  }
}

function startRegistry(handler) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        const url = new URL(request.url, 'http://127.0.0.1')
        const body = handler(url)
        if (body === null || body === undefined) {
          response.statusCode = 404
          response.end('{}')
          return
        }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(body))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function stopRegistry(server) {
  return new Promise((resolve) => server.close(resolve))
}

function sbomFixture(version, overrides = {}) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    version: 1,
    metadata: { timestamp: '2026-11-20T00:00:00Z', component: { type: 'application', name: 'advisers', version } },
    components: PACKAGES.map((name) => ({ type: 'library', name, version })),
    ...overrides,
  }
}

test('release-trust wiring self-test passes offline', () => {
  const result = run(checkProvenanceScript, ['--self-test'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /PASS release-trust wiring self-test/)
  assert.match(result.stdout, /stage step requires confirm=yes and stage=yes/)
  assert.match(result.stdout, /docs\/SECURITY\.md records the current published release/)
  assert.match(result.stdout, /provenance build ref to be the release tag/)
  assert.match(result.stdout, /publish\.yml requires the workflow ref to be the release tag/)
})

test('docs release-state gate self-test catches the 0.3.0 defect offline', () => {
  const result = run(scriptPath('check-docs.mjs'), ['--self-test'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /PASS release-state self-test/)
})

test('provenance checks accept a linked SLSA bundle and reject empty/mismatched/foreign ones', async () => {
  const digest = digestFixture('advisers@0.3.0 tarball bytes')
  const expectedCommit = FAKE_COMMIT
  const goodBundle = attestationBundle([NPM_PUBLISH, SLSA], { name: 'advisers', version: '0.3.0', digestHex: digest.hex, commit: expectedCommit })
  const published = {
    dist: {
      integrity: digest.integrity,
      attestations: {
        url: 'https://registry.npmjs.org/-/npm/v1/attestations/advisers@0.3.0',
        provenance: { predicateType: SLSA },
      },
    },
  }
  const base = { name: 'advisers', version: '0.3.0', published, integrity: digest.integrity, expectedRepo: REPO, expectedCommit }

  const good = await checkPackageAttestations({ ...base, fetchJson: async () => goodBundle })
  assert.equal(good.ok, true, JSON.stringify(good.checks))
  assert.equal(good.checks.filter((check) => !check.ok).length, 0)
  assert.match(JSON.stringify(good.checks), /subject sha512 equals the registry tarball integrity/)
  assert.match(JSON.stringify(good.checks), /source repository is PerryLink\/advisers/)

  // 0.3.0 defect: provenance named refs/heads/main. The build ref must be the
  // release tag when verify-release is asked to enforce it.
  const rightRef = await checkPackageAttestations({
    ...base,
    expectedRef: 'refs/tags/v0.3.0',
    fetchJson: async () => goodBundle,
  })
  assert.equal(rightRef.ok, true, JSON.stringify(rightRef.checks))
  const wrongRef = await checkPackageAttestations({
    ...base,
    expectedRef: 'refs/tags/v0.3.1',
    fetchJson: async () => goodBundle,
  })
  assert.equal(wrongRef.ok, false)
  assert.match(JSON.stringify(wrongRef.checks), /SLSA build ref is refs\/tags\/v0\.3\.1/)

  const empty = await checkPackageAttestations({
    ...base,
    published: { dist: { integrity: digest.integrity, attestations: {} } },
    fetchJson: async () => goodBundle,
  })
  assert.equal(empty.ok, false)
  assert.match(JSON.stringify(empty.checks), /dist\.attestations is non-empty/)

  const wrongDigest = await checkPackageAttestations({
    ...base,
    fetchJson: async () => attestationBundle([NPM_PUBLISH, SLSA], { name: 'advisers', version: '0.3.0', digestHex: 'b'.repeat(128), commit: expectedCommit }),
  })
  assert.equal(wrongDigest.ok, false)
  assert.match(JSON.stringify(wrongDigest.checks), /subject sha512 equals the registry tarball integrity/)

  const foreignRepo = await checkPackageAttestations({
    ...base,
    fetchJson: async () => attestationBundle([NPM_PUBLISH, SLSA], { name: 'advisers', version: '0.3.0', digestHex: digest.hex, repo: 'someone/else', commit: expectedCommit }),
  })
  assert.equal(foreignRepo.ok, false)
  assert.match(JSON.stringify(foreignRepo.checks), /source repository is PerryLink\/advisers/)

  const noSlsa = await checkPackageAttestations({
    ...base,
    fetchJson: async () => attestationBundle([NPM_PUBLISH], { name: 'advisers', version: '0.3.0', digestHex: digest.hex }),
  })
  assert.equal(noSlsa.ok, false)
  assert.match(JSON.stringify(noSlsa.checks), /SLSA provenance attestation/)

  const missing = await checkPackageAttestations({
    ...base,
    published: { dist: { integrity: digest.integrity } },
    allowMissing: true,
  })
  assert.equal(missing.ok, true)
  assert.equal(missing.skipped, true)
})

test('SBOM validation requires CycloneDX components without absolute build paths', () => {
  const good = validateSbom(sbomFixture('0.3.0'), { version: '0.3.0' })
  assert.equal(good.ok, true, JSON.stringify(good.checks))

  const empty = validateSbom({ bomFormat: 'CycloneDX', specVersion: '1.6', components: [] }, { version: '0.3.0' })
  assert.equal(empty.ok, false)
  assert.match(JSON.stringify(empty.checks), /at least one component/)

  const wrongFormat = validateSbom({ bomFormat: 'SPDX', specVersion: '2.3', components: [{ name: 'advisers' }] })
  assert.equal(wrongFormat.ok, false)

  const leaky = validateSbom(sbomFixture('0.3.0', {
    properties: [{ name: 'build:path', value: '/mnt/d/Projects/dsh/plugins/advisers/packages' }],
  }), { version: '0.3.0' })
  assert.equal(leaky.ok, false)
  assert.match(JSON.stringify(leaky.checks), /absolute build-machine paths/)

  const missingVersion = validateSbom(sbomFixture('0.3.0'), { version: '0.3.1' })
  assert.equal(missingVersion.ok, false)
})

test('check-provenance CLI skips a wholly unpublished version and fails the strict mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-prov-unpublished-'))
  try {
    for (const name of PACKAGES) writeFileSync(join(dir, name + '.json'), JSON.stringify({ name, versions: {}, 'dist-tags': {} }))
    const skipped = run(checkProvenanceScript, ['--version', '0.3.0', '--fixture', dir, '--allow-unpublished', '--json'])
    assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr)
    const payload = JSON.parse(skipped.stdout)
    assert.equal(payload.status, 'skipped-unpublished')
    assert.equal(payload.failed, 0)
    assert.equal(payload.checks.filter((item) => item.name !== 'sbom' && item.skipped).length, 6)

    const strict = run(checkProvenanceScript, ['--version', '0.3.0', '--fixture', dir])
    assert.equal(strict.status, 1)
    assert.match(strict.stdout, /not published yet/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check-provenance CLI verifies fixture attestations and flags empty ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisers-prov-published-'))
  try {
    const attestationsDir = join(dir, 'attestations')
    mkdirSync(attestationsDir)
    const digest = digestFixture('fixture tarball')
    for (const name of PACKAGES) {
      const url = 'https://registry.npmjs.org/-/npm/v1/attestations/' + name + '@0.3.0'
      writeFileSync(join(dir, name + '.json'), JSON.stringify(metadataFixture(name, '0.3.0', {
        gitHead: FAKE_COMMIT,
        integrity: digest.integrity,
        attestationUrl: url,
      })))
      writeFileSync(join(attestationsDir, name + '.json'), JSON.stringify(
        attestationBundle([NPM_PUBLISH, SLSA], { name, version: '0.3.0', digestHex: digest.hex, commit: FAKE_COMMIT }),
      ))
    }
    const good = run(checkProvenanceScript, ['--version', '0.3.0', '--fixture', dir, '--expected-commit', FAKE_COMMIT, '--json'])
    assert.equal(good.status, 0, good.stdout + good.stderr)
    assert.equal(JSON.parse(good.stdout).status, 'pass')

    writeFileSync(join(dir, 'advisers.json'), JSON.stringify(metadataFixture('advisers', '0.3.0', {
      gitHead: FAKE_COMMIT,
      integrity: digest.integrity,
      attestations: {},
    })))
    const broken = run(checkProvenanceScript, ['--version', '0.3.0', '--fixture', dir, '--expected-commit', FAKE_COMMIT])
    assert.equal(broken.status, 1)
    assert.match(broken.stdout, /dist\.attestations is non-empty/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verify-release skips an unpublished version only with --allow-unpublished', async () => {
  const { server, port } = await startRegistry(() => ({ name: 'advisers', versions: {}, 'dist-tags': {} }))
  try {
    const registry = 'http://127.0.0.1:' + port
    // The fixtures below verify the older published-version semantics, so version
    // drift against the current checkout is expected and explicit.
    const skipped = await runAsync(verifyReleaseScript, ['--version', '0.2.4', '--registry', registry, '--skip-git', '--allow-version-drift', '--allow-unpublished', '--skip-install'])
    assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr)
    assert.match(skipped.stdout, /SKIP release verification for 0\.2\.4/)
    assert.match(skipped.stdout, /none of the requested packages is published/)

    const strict = await runAsync(verifyReleaseScript, ['--version', '0.2.4', '--registry', registry, '--skip-git', '--allow-version-drift', '--skip-install'])
    assert.equal(strict.status, 1)
    assert.match(strict.stdout, /FAIL release verification/)
    assert.match(strict.stdout, /registry reports it is not published/)
  } finally {
    await stopRegistry(server)
  }
})

test('verify-release checks attestations, gitHead, tag commit, and SBOM metadata', async () => {
  const version = '0.2.4'
  const tag = 'next'
  const commit = 'd'.repeat(40)
  const digest = digestFixture('fake tarball bytes')
  let breakAttestations = false
  let registryBase = ''
  const { server, port } = await startRegistry((url) => {
    const path = decodeURIComponent(url.pathname)
    const attestationMatch = /attestations\/([^/]+)@[^/]+$/.exec(path)
    if (attestationMatch) {
      return attestationBundle([NPM_PUBLISH, SLSA], {
        name: attestationMatch[1],
        version,
        digestHex: digest.hex,
        commit,
      })
    }
    const name = path.replace(/^\//, '').split('/')[0]
    if (!PACKAGES.includes(name)) return null
    const attestationUrl = registryBase + '/-/npm/v1/attestations/' + name + '@' + version
    const options = { tag, gitHead: commit, integrity: digest.integrity, attestationUrl }
    if (breakAttestations && name === 'advisers') options.attestations = {}
    return metadataFixture(name, version, options)
  })
  registryBase = 'http://127.0.0.1:' + port
  const work = mkdtempSync(join(tmpdir(), 'advisers-verify-fixture-'))
  try {
    const sbomFile = join(work, 'sbom.cdx.json')
    writeFileSync(sbomFile, JSON.stringify(sbomFixture(version)))
    const baseArgs = [
      '--version', version,
      '--tag', tag,
      '--registry', registryBase,
      '--expected-commit', commit,
      '--skip-git',
      '--skip-install',
      '--metadata-only',
      '--allow-version-drift',
    ]
    const args = [...baseArgs, '--sbom', sbomFile, '--json']
    const passed = await runAsync(verifyReleaseScript, args)
    assert.equal(passed.status, 0, passed.stdout + passed.stderr)
    const payload = JSON.parse(passed.stdout)
    assert.equal(payload.status, 'pass')
    assert.equal(payload.failed, 0)
    const gitHeadCheck = payload.checks.find((item) => String(item.detail).startsWith('registry gitHead === release commit'))
    assert.ok(gitHeadCheck && gitHeadCheck.ok)
    const subjectCheck = payload.checks.find((item) => String(item.detail).includes('subject sha512 equals the registry tarball integrity'))
    assert.ok(subjectCheck && subjectCheck.ok)
    assert.equal(payload.sbom.status, 'passed')

    const leakedSbomFile = join(work, 'leaky.cdx.json')
    writeFileSync(leakedSbomFile, JSON.stringify(sbomFixture(version, {
      properties: [{ name: 'build:path', value: '/mnt/d/Projects/dsh/plugins/advisers' }],
    })))
    const leaked = await runAsync(verifyReleaseScript, [...baseArgs, '--sbom', leakedSbomFile, '--json'])
    assert.equal(leaked.status, 1)
    assert.match(leaked.stdout, /absolute build-machine paths/)

    breakAttestations = true
    const broken = await runAsync(verifyReleaseScript, args)
    assert.equal(broken.status, 1)
    assert.match(broken.stdout, /dist\.attestations is non-empty/)
  } finally {
    rmSync(work, { recursive: true, force: true })
    await stopRegistry(server)
  }
})

test('verify-release requires the tag/commit agreement when the local tag exists', async (t) => {
  const tagCommit = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'v0.2.4^{commit}'], { cwd: repoRoot, encoding: 'utf8' })
  if (tagCommit.status !== 0) {
    t.skip('v0.2.4 tag is not available in this checkout (CI uses fetch-depth: 1)')
    return
  }
  const { server, port } = await startRegistry(() => ({ name: 'advisers', versions: {}, 'dist-tags': {} }))
  try {
    const result = await runAsync(verifyReleaseScript, ['--version', '0.2.4', '--registry', 'http://127.0.0.1:' + port, '--allow-version-drift', '--allow-unpublished', '--skip-install'])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /PASS git :: tag v0\.2\.4 exists and resolves to a commit/)
  } finally {
    await stopRegistry(server)
  }
})

test('release.mjs fails closed on --provenance without OIDC or with NPM_TOKEN (nothing staged)', () => {
  const noOidc = run(releaseScript, ['--dry-run', '--provenance'])
  assert.equal(noOidc.status, 2)
  assert.match(noOidc.stderr, /cannot provide an npm OIDC identity/)
  assert.match(noOidc.stderr, /Nothing was staged\./)

  const secret = 'npm_SECRET_MUST_NOT_BE_PRINTED_123'
  const withToken = run(releaseScript, ['--dry-run', '--provenance'], cleanEnv({
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-oidc-token-value',
    NPM_TOKEN: secret,
  }))
  assert.equal(withToken.status, 2)
  assert.match(withToken.stderr, /NPM_TOKEN must not be set/)
  assert.match(withToken.stderr, /Nothing was staged\./)
  const output = String(withToken.stdout) + String(withToken.stderr)
  assert.ok(!output.includes(secret), 'the npm token value must never be printed')
  assert.ok(!output.includes('fake-oidc-token-value'), 'the OIDC token value must never be printed')
})

