#!/usr/bin/env node
/**
 * Release provenance / attestation checks for the six published Advisers packages.
 *
 * The 0.3.0 release gates on npm Trusted Publishing: every package must have a
 * non-empty `dist.attestations` record whose attestation bundle contains a SLSA
 * provenance statement for the registry tarball, produced from this repository
 * at the tagged release commit. This module is the single implementation of
 * those checks: scripts/verify-release.mjs imports it for the post-approval
 * release gate, and it also runs standalone:
 *
 *   node scripts/check-provenance.mjs --version 0.3.1   # requires refs/tags/v0.3.1 by default
 *   node scripts/check-provenance.mjs --version 0.3.0 --allow-non-tag-provenance  # historical audit (0.3.0 named refs/heads/main)
 *   node scripts/check-provenance.mjs --version 0.3.0 --allow-unpublished  # pre-release dry run
 *   node scripts/check-provenance.mjs --self-test                          # offline wiring gate
 *   node scripts/check-provenance.mjs --version 0.3.0 --fixture <dir>      # offline fixture (tests)
 *
 * What is checked, per package:
 *   - `dist.attestations` is present and non-empty (url + provenance.predicateType);
 *   - the attestation bundle URL is fetched and contains a SLSA provenance
 *     attestation (https://slsa.dev/provenance/v1);
 *   - every known attestation statement names a subject whose sha512 digest
 *     equals the registry tarball integrity (dist.integrity);
 *   - the SLSA statement's source repository matches --repo and, when known, its
 *     resolved git commit matches the release commit;
 *   - when `expectedRef` is supplied (the CLI derives `refs/tags/vX.Y.Z` by
 *     default and verify-release passes the checked-out tag), the SLSA build ref
 *     must equal it: a branch ref such as `refs/heads/main` fails, because
 *     provenance must name the release tag. Pass --allow-non-tag-provenance
 *     only to audit a historical release that predates this rule.
 *
 * The checks verify npm's metadata linkage. They do NOT cryptographically verify
 * the Sigstore bundle or the transparency log; `npm audit signatures` does that
 * on the consumer side. Release notes may claim provenance only after the
 * registry-side checks above pass for all six packages.
 *
 * Exit codes: 0 = passed or cleanly skipped (--allow-unpublished with no package
 * published yet), 1 = failed check, 2 = usage error.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PACKAGES = [
  'advisers',
  'advisers-core',
  'advisers-office',
  'advisers-policy-strict',
  'advisers-bridge-hermes',
  'dsh-advisers',
]
export const SLSA_PREDICATE = 'https://slsa.dev/provenance/v1'
export const NPM_PUBLISH_PREDICATE = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1'

const KNOWN_PREDICATES = new Set([SLSA_PREDICATE, NPM_PUBLISH_PREDICATE])
const root = fileURLToPath(new URL('..', import.meta.url))

/** Convert an npm `dist.integrity` sha512-<base64> value to the hex digest used in in-toto subjects. */
export function sha512HexFromIntegrity(integrity) {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(String(integrity || ''))
  return match ? Buffer.from(match[1], 'base64').toString('hex') : ''
}

function decodeStatement(attestation) {
  const envelope = attestation && attestation.bundle && attestation.bundle.dsseEnvelope
  if (!envelope || typeof envelope.payload !== 'string') return null
  if (envelope.payloadType && envelope.payloadType !== 'application/vnd.in-toto+json') return null
  try {
    return JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function normalizeRepo(value) {
  return String(value || '')
    .replace(/^git\+/, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function statementBuildRef(statement) {
  const workflow = statement && statement.predicate && statement.predicate.buildDefinition
    && statement.predicate.buildDefinition.externalParameters
    && statement.predicate.buildDefinition.externalParameters.workflow
  return workflow && typeof workflow.ref === 'string' ? workflow.ref : ''
}

function statementRepository(statement) {
  const workflow = statement && statement.predicate && statement.predicate.buildDefinition
    && statement.predicate.buildDefinition.externalParameters
    && statement.predicate.buildDefinition.externalParameters.workflow
  if (workflow && workflow.repository) return String(workflow.repository)
  const configSource = statement && statement.predicate && statement.predicate.invocation
    && statement.predicate.invocation.configSource
  return configSource && configSource.uri ? String(configSource.uri) : ''
}

function statementCommit(statement) {
  const dependencies = statement && statement.predicate && statement.predicate.buildDefinition
    && statement.predicate.buildDefinition.resolvedDependencies
  if (!Array.isArray(dependencies)) return ''
  for (const dependency of dependencies) {
    if (dependency && dependency.digest && dependency.digest.gitCommit) {
      return String(dependency.digest.gitCommit).toLowerCase()
    }
  }
  return ''
}

/**
 * Verify one package's npm provenance metadata. Returns { ok, skipped, checks, warnings, info }.
 * `checks` entries are { ok, detail, skipped? } so callers can print PASS/SKIP/FAIL lines.
 */
export async function checkPackageAttestations(options) {
  const {
    name,
    version,
    published,
    integrity = '',
    fetchJson,
    allowMissing = false,
    expectedRepo = 'PerryLink/advisers',
    expectedCommit = '',
    expectedRef = '',
  } = options || {}
  const checks = []
  const warnings = []
  const add = (ok, detail) => { checks.push({ ok, detail }); return ok }
  const attestations = published && published.dist ? published.dist.attestations : undefined
  const hasAttestations = Boolean(attestations && typeof attestations === 'object' && Object.keys(attestations).length)
  if (!hasAttestations) {
    if (allowMissing) {
      checks.push({
        ok: true,
        skipped: true,
        detail: 'dist.attestations absent (allowed by --allow-missing-attestations; only valid for pre-0.3.0 historical releases)',
      })
      return { ok: true, skipped: true, checks, warnings, info: null }
    }
    add(false, 'dist.attestations is non-empty (npm reports none, so this publish did not use OIDC/Trusted Publishing)')
    return { ok: false, skipped: false, checks, warnings, info: null }
  }
  add(true, 'dist.attestations is present')
  const predicateType = attestations.provenance && attestations.provenance.predicateType
  add(
    predicateType === SLSA_PREDICATE,
    'dist.attestations.provenance.predicateType is ' + SLSA_PREDICATE + ' (got ' + (predicateType || 'missing') + ')',
  )
  const url = attestations.url
  add(typeof url === 'string' && url.length > 0, 'dist.attestations.url is present')
  if (typeof url !== 'string' || !url) return { ok: false, skipped: false, checks, warnings, info: null }
  let bundle
  try {
    bundle = await fetchJson(url)
  } catch (error) {
    add(false, 'attestation bundle fetch failed: ' + (error && error.message ? error.message : String(error)))
    return { ok: false, skipped: false, checks, warnings, info: null }
  }
  add(true, 'attestation bundle fetched')
  const list = bundle && Array.isArray(bundle.attestations) ? bundle.attestations : []
  add(list.length > 0, 'attestation bundle contains at least one attestation')
  if (!list.length) return { ok: false, skipped: false, checks, warnings, info: null }
  const slsa = list.filter((item) => item && item.predicateType === SLSA_PREDICATE)
  add(slsa.length > 0, 'bundle contains an SLSA provenance attestation (' + SLSA_PREDICATE + ')')
  const expectedDigest = sha512HexFromIntegrity(integrity)
  add(Boolean(expectedDigest), 'registry dist.integrity is a sha512 value that attestation subjects can be compared against')
  if (!expectedDigest) return { ok: false, skipped: false, checks, warnings, info: null }
  const known = list.filter((item) => item && KNOWN_PREDICATES.has(item.predicateType))
  add(known.length > 0, 'bundle contains in-toto statements with known npm/SLSA predicate types')
  let repository = ''
  let commit = ''
  let buildRef = ''
  for (const attestation of known) {
    const label = String(attestation.predicateType).split('/').slice(-2).join('/')
    const statement = decodeStatement(attestation)
    if (!statement) {
      add(false, label + ': DSSE payload is a base64-encoded in-toto statement')
      continue
    }
    add(statement.predicateType === attestation.predicateType, label + ': statement predicateType matches the attestation type')
    const subjects = Array.isArray(statement.subject) ? statement.subject : []
    const subject = subjects.find((item) => String(item && item.name ? item.name : '').includes(name + '@' + version)) || subjects[0]
    add(Boolean(subject), label + ': statement has a subject for ' + name + '@' + version)
    const subjectDigest = subject && subject.digest ? subject.digest.sha512 : ''
    add(Boolean(subjectDigest), label + ': subject records a sha512 digest')
    if (subjectDigest) {
      add(
        String(subjectDigest).toLowerCase() === expectedDigest,
        label + ': subject sha512 equals the registry tarball integrity',
      )
    }
    if (attestation.predicateType === SLSA_PREDICATE) {
      repository = statementRepository(statement)
      add(
        normalizeRepo(repository) === normalizeRepo(expectedRepo),
        label + ': source repository is ' + expectedRepo + ' (got ' + (repository || 'missing') + ')',
      )
      commit = statementCommit(statement)
      if (expectedCommit) {
        add(
          commit === String(expectedCommit).toLowerCase(),
          label + ': source commit is ' + String(expectedCommit).toLowerCase() + ' (got ' + (commit || 'missing') + ')',
        )
      } else if (commit) {
        warnings.push('attestation source commit is ' + commit + ' (no expected commit was supplied)')
      } else {
        warnings.push('attestation has no resolved gitCommit to compare with the release tag')
      }
      buildRef = statementBuildRef(statement)
      if (expectedRef) {
        add(
          buildRef === String(expectedRef),
          label + ': SLSA build ref is ' + String(expectedRef) + ' (got ' + (buildRef || 'missing') + ')',
        )
      } else if (buildRef) {
        warnings.push('attestation build ref is ' + buildRef + ' (no expected tag ref was supplied)')
      }
    }
  }
  return {
    ok: checks.every((check) => check.ok),
    skipped: false,
    checks,
    warnings,
    info: { url, predicateType, repository, commit, buildRef },
  }
}

/**
 * Validate a CycloneDX SBOM for the release. Required checks follow the 0.3.0
 * gate: CycloneDX format/specVersion, components non-empty, the advisers
 * component at the release version, and no absolute build-machine paths.
 */
export function validateSbom(sbom, options = {}) {
  const { version = '', packages = PACKAGES } = options
  const checks = []
  const warnings = []
  const add = (ok, detail) => { checks.push({ ok, detail }); return ok }
  add(Boolean(sbom) && typeof sbom === 'object' && !Array.isArray(sbom), 'SBOM is a JSON object')
  const document = sbom && typeof sbom === 'object' ? sbom : {}
  add(document.bomFormat === 'CycloneDX', 'SBOM bomFormat is CycloneDX (got ' + (document.bomFormat || 'missing') + ')')
  add(
    typeof document.specVersion === 'string' && /^1\.[0-9]+$/.test(document.specVersion),
    'SBOM specVersion is a CycloneDX 1.x version (got ' + (document.specVersion || 'missing') + ')',
  )
  const components = Array.isArray(document.components) ? document.components : []
  add(components.length > 0, 'SBOM lists at least one component')
  const names = new Set(components.map((component) => component && component.name).filter(Boolean))
  add(names.has('advisers'), 'SBOM includes the advisers package component')
  const main = components.find((component) => component && component.name === 'advisers')
  const metadataComponent = document.metadata && document.metadata.component
  if (version) {
    add(
      Boolean((main && main.version === version) || (metadataComponent && metadataComponent.version === version)),
      'SBOM records version ' + version + ' for the advisers package',
    )
  }
  const missing = packages.filter((name) => !names.has(name))
  if (missing.length) warnings.push('SBOM is missing component(s): ' + missing.join(', '))
  const leaked = []
  const scan = (value, path) => {
    if (typeof value === 'string') {
      if (/file:\/\//i.test(value) || /(?:^|\s)(?:\/mnt\/|\/home\/|\/Users\/|\/root\/)/.test(value) || /[A-Za-z]:\\/.test(value)) {
        leaked.push(path + '=' + value.slice(0, 120))
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => scan(item, path + '[' + index + ']'))
    } else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) scan(value[key], path + '.' + key)
    }
  }
  scan(document, '$')
  add(
    leaked.length === 0,
    'SBOM contains no absolute build-machine paths' + (leaked.length ? ' (' + leaked.slice(0, 3).join('; ') + ')' : ''),
  )
  return { ok: checks.every((check) => check.ok), checks, warnings }
}

function blockAt(text, startTest, endTest) {
  const lines = String(text || '').split('\n')
  const start = lines.findIndex(startTest)
  if (start < 0) return ''
  const indent = lines[start].match(/^\s*/)[0].length
  const collected = [lines[start]]
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') { collected.push(line); continue }
    const lineIndent = line.match(/^\s*/)[0].length
    if (lineIndent < indent) break
    if (lineIndent === indent && endTest(line.trim())) break
    collected.push(line)
  }
  return collected.join('\n')
}

/**
 * Offline release-trust wiring self-test: the publish workflow, the release
 * script and the docs must agree on the OIDC/provenance path (this is the exact
 * contradiction that shipped in 0.2.4: a comment claimed the job never stages
 * while a later step did stage). Run with --self-test; no network, no publish.
 */
export function selfTest(options = {}) {
  const testRoot = options.root || root
  const checks = []
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail })
  const read = (file) => {
    try { return readFileSync(join(testRoot, file), 'utf8').replace(/\r\n/g, '\n') } catch { return '' }
  }

  const publish = read('.github/workflows/publish.yml')
  const job = blockAt(
    publish,
    (line) => /^  trusted-publish-draft:$/.test(line),
    (line) => /^[A-Za-z0-9_-]+:$/.test(line),
  )
  const stageStep = blockAt(
    job,
    (line) => /^\s+- name: Stage with Trusted Publishing \+ provenance/.test(line),
    (line) => /^- (?:name|uses|run):/.test(line),
  )
  add('publish.yml defines the opt-in trusted-publish-draft job', job.length > 0)
  add('trusted-publish-draft grants id-token: write', /\n\s+id-token:\s*write\s*$/m.test(job))
  add('trusted-publish-draft runs only when confirm=yes', /inputs\.confirm\s*==\s*'yes'/.test(job))
  add('stage step exists', stageStep.length > 0)
  add(
    'stage step requires confirm=yes and stage=yes',
    /inputs\.confirm\s*==\s*'yes'\s*&&\s*inputs\.stage\s*==\s*'yes'/.test(stageStep),
  )
  add('stage step runs release.mjs --provenance (OIDC)', /node scripts\/release\.mjs --provenance/.test(stageStep))
  add('stage step rejects NPM_TOKEN', /NPM_TOKEN/.test(stageStep) && /exit 1/.test(stageStep))
  add('stage step is not allowed to fail silently', !/continue-on-error:\s*true/.test(stageStep))
  add(
    'stage step captures the npm debug log on failure',
    /\.npm\/_logs\/\*-debug-0\.log/.test(stageStep) && /tail -250/.test(stageStep),
  )
  add('workflow never wires NPM_TOKEN from repository secrets', !/NPM_TOKEN\s*:\s*\$\{\{/.test(publish))
  add(
    'publish.yml requires the workflow ref to be the release tag',
    /GITHUB_REF/.test(publish) && /refs\/tags\/v\$\{?VERSION/.test(publish),
  )
  add(
    'workflow comments match the real stage step',
    !/never publishes and never stages/i.test(publish) && !/does not publish or stage anything/i.test(publish),
  )

  const release = read('scripts/release.mjs')
  add('release.mjs understands --provenance', /--provenance/.test(release))
  add(
    'release.mjs fails closed when provenance runs outside the version tag ref',
    /GITHUB_REF/.test(release) && /refs\/tags\/v/.test(release) && /must run from refs\/tags\/v/.test(release),
  )
  add('release.mjs fails closed when provenance is requested with NPM_TOKEN set', /NPM_TOKEN must not be set/.test(release))
  add('release.mjs enforces npm >= 11.15.0 for trusted staging', /11\.15\.0/.test(release))
  add('release.mjs requires the GitHub OIDC request environment', /ACTIONS_ID_TOKEN_REQUEST_URL/.test(release))

  const verify = read('scripts/verify-release.mjs')
  add('verify-release.mjs consumes the provenance checks', /checkPackageAttestations/.test(verify))
  add('verify-release.mjs has clear unpublished skip semantics', /--allow-unpublished/.test(verify))
  add('verify-release.mjs gates the SBOM artifact', /--require-sbom/.test(verify))
  add(
    'verify-release.mjs requires the provenance build ref to be the release tag',
    /expectedRef/.test(verify) && /refs\/tags\//.test(verify),
  )

  const checkRelease = read('scripts/check-release.mjs')
  add(
    'check-release.mjs --require-tag requires the tag commit to be HEAD',
    /is the HEAD commit/.test(checkRelease),
  )

  const checkDocs = read('scripts/check-docs.mjs')
  add(
    'check-docs.mjs rejects release-candidate wording for the current version',
    /release\[- \]candidate/.test(checkDocs),
  )

  const releasing = read('docs/RELEASING.md')
  add(
    'docs/RELEASING.md exists and documents tag-ref publishing',
    /refs\/tags\//.test(releasing) && /publish\.yml/.test(releasing),
  )

  const security = read('docs/SECURITY.md')
  add('docs/SECURITY.md covers the 0.3.0 provenance status', /0\.3\.0/.test(security))
  add('docs/SECURITY.md records the current published release', /0\.3\.2[^\n]{0,80}published/i.test(security) || /published on 2026-11-21/i.test(security))
  add(
    'docs/SECURITY.md does not claim 0.2.4 was staged via Trusted Publishing',
    !/0\.2\.4[^\n]{0,120}staged via Trusted Publishing/i.test(security),
  )
  add(
    'docs/SECURITY.md points at the post-approval attestation check',
    /dist\.attestations/.test(security) && /verify-release\.mjs/.test(security),
  )

  return { ok: checks.every((check) => check.ok), checks }
}

function currentVersion() {
  try {
    return JSON.parse(readFileSync(join(root, 'packages/advisers/package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

function parseArgs(argv) {
  const flag = (name, fallback) => {
    const index = argv.indexOf('--' + name)
    if (index < 0) return fallback
    const value = argv[index + 1]
    return value && !value.startsWith('--') ? value : fallback
  }
  const bool = (name) => argv.includes('--' + name)
  return { flag, bool }
}

async function main() {
  const argv = process.argv.slice(2)
  const { flag, bool } = parseArgs(argv)
  if (bool('self-test')) {
    const result = selfTest()
    for (const check of result.checks) {
      console.log((check.ok ? 'PASS' : 'FAIL') + ' self-test :: ' + check.name + (check.ok || !check.detail ? '' : ' - ' + check.detail))
    }
    console.log('')
    console.log(result.ok ? 'PASS release-trust wiring self-test (' + result.checks.length + ' checks)' : 'FAIL release-trust wiring self-test')
    process.exit(result.ok ? 0 : 1)
  }

  const version = flag('version', currentVersion())
  const registry = String(flag('registry', 'https://registry.npmjs.org/')).replace(/\/+$/, '')
  const fixture = flag('fixture', '')
  const allowUnpublished = bool('allow-unpublished')
  const allowMissing = bool('allow-missing-attestations')
  const expectedRepo = flag('repo', 'PerryLink/advisers')
  const expectedCommit = String(flag('expected-commit', '')).toLowerCase()
  // 0.3.2: provenance must name the release tag, not a branch (the 0.3.0
  // defect). Historical releases whose provenance named refs/heads/main can
  // still be audited with --allow-non-tag-provenance.
  const expectedRef = bool('allow-non-tag-provenance')
    ? ''
    : String(flag('expected-ref', 'refs/tags/v' + version))
  const sbomFile = flag('sbom', '')
  const requireSbom = bool('require-sbom')
  const jsonOut = bool('json')

  const realFetchJson = async (url) => {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'advisers-provenance-check' },
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url)
    return response.json()
  }
  const fixtureJson = async (url) => {
    const match = /attestations\/([^/]+?)(?:@[^/]+)?$/.exec(String(url))
    const name = match ? decodeURIComponent(match[1]) : ''
    const file = join(fixture, 'attestations', name + '.json')
    if (!name || !existsSync(file)) throw new Error('fixture attestation bundle not found: ' + file)
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  const fetchJson = fixture ? fixtureJson : realFetchJson
  const registryDocument = async (name) => {
    if (fixture) {
      const file = join(fixture, name + '.json')
      if (!existsSync(file)) throw new Error('fixture registry document not found: ' + file)
      return JSON.parse(readFileSync(file, 'utf8'))
    }
    return realFetchJson(registry + '/' + encodeURIComponent(name))
  }

  const checks = []
  const failures = []
  const warnings = []
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail })
    if (!ok) failures.push(name + ': ' + detail)
  }
  const skip = (name, detail) => checks.push({ name, ok: true, skipped: true, detail })

  let publishedCount = 0
  for (const name of PACKAGES) {
    let meta
    try {
      meta = await registryDocument(name)
    } catch (error) {
      add(name, false, 'registry metadata fetch failed: ' + (error && error.message ? error.message : String(error)))
      continue
    }
    const published = meta && meta.versions ? meta.versions[version] : undefined
    if (!published) {
      if (allowUnpublished) {
        skip(name, 'version ' + version + ' is not published yet')
        continue
      }
      add(name, false, 'version ' + version + ' exists on the registry (it is not published yet)')
      continue
    }
    publishedCount += 1
    add(name, true, 'version ' + version + ' exists on the registry')
    const result = await checkPackageAttestations({
      name,
      version,
      published,
      integrity: published.dist ? published.dist.integrity : '',
      fetchJson,
      allowMissing,
      expectedRepo,
      expectedCommit,
      expectedRef,
    })
    for (const check of result.checks) {
      if (check.skipped) skip(name, check.detail)
      else add(name, check.ok, check.detail)
    }
    for (const warning of result.warnings) warnings.push(name + ': ' + warning)
  }

  let sbomStatus = 'not-supplied'
  if (sbomFile) {
    let sbom = null
    if (!existsSync(sbomFile)) {
      add('sbom', false, 'SBOM file not found: ' + sbomFile)
    } else {
      try { sbom = JSON.parse(readFileSync(sbomFile, 'utf8')) } catch (error) {
        add('sbom', false, 'SBOM is not valid JSON: ' + (error && error.message ? error.message : String(error)))
      }
    }
    if (sbom) {
      const result = validateSbom(sbom, { version, packages: PACKAGES })
      for (const check of result.checks) add('sbom', check.ok, check.detail)
      for (const warning of result.warnings) warnings.push('sbom: ' + warning)
      sbomStatus = result.ok ? 'passed' : 'failed'
    } else {
      sbomStatus = 'failed'
    }
  } else if (requireSbom) {
    add('sbom', false, '--require-sbom was set but no --sbom <file> was supplied')
    sbomStatus = 'failed'
  } else {
    skip('sbom', 'no --sbom file supplied; provenance checks ran without an SBOM')
  }

  const missing = PACKAGES.length - publishedCount
  const cleanSkip = allowUnpublished && missing === PACKAGES.length && failures.length === 0
  const status = cleanSkip ? 'skipped-unpublished' : failures.length ? 'fail' : 'pass'
  const passed = checks.filter((check) => check.ok && !check.skipped).length
  const skipped = checks.filter((check) => check.skipped).length
  if (jsonOut) {
    console.log(JSON.stringify({
      version,
      expectedRef,
      registry: fixture ? 'fixture:' + fixture : registry,
      packages: PACKAGES,
      status,
      passed,
      skipped,
      failed: failures.length,
      failures,
      warnings,
      checks,
    }, null, 2))
  } else {
    for (const check of checks) {
      console.log((check.skipped ? 'SKIP' : check.ok ? 'PASS' : 'FAIL') + ' ' + check.name + ' :: ' + check.detail)
    }
    for (const warning of warnings) console.log('WARN ' + warning)
    console.log('')
    if (cleanSkip) {
      console.log('SKIP provenance verification for ' + version + ': none of the six packages is published on ' + (fixture ? 'the fixture registry' : registry) + ' yet.')
      console.log('This is the expected pre-release state; nothing was verified. Re-run without --allow-unpublished after approval.')
    } else if (failures.length) {
      console.log('FAIL provenance verification: ' + failures.length + ' failed / ' + checks.length + ' checks')
    } else {
      console.log('PASS provenance verification for ' + version + ' (' + passed + ' checks' + (skipped ? ', ' + skipped + ' skipped' : '') + ')')
    }
  }
  process.exit(cleanSkip ? 0 : failures.length ? 1 : 0)
}

const invokedHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedHref) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error))
    process.exit(1)
  })
}
