#!/usr/bin/env node
/**
 * SBOM gate — `pnpm run check:sbom`.
 *
 * Validates the CycloneDX artifact produced by scripts/sbom.mjs (default
 * artifacts/sbom.cdx.json). CI runs `pnpm run sbom && pnpm run check:sbom`
 * after the workspace build; the release gate re-checks the same file through
 * `node scripts/verify-release.mjs --version <v> --sbom <file> --require-sbom`.
 *
 * The required CycloneDX checks (bomFormat, specVersion, components > 0, the
 * advisers component at the workspace version, no absolute build-machine paths)
 * are imported from scripts/check-provenance.mjs#validateSbom — one implementation
 * for CI and the release gate. On top of those this gate checks the artifact's
 * integrity as data:
 *   - document version/serialNumber/timestamp shapes;
 *   - every component has a valid type, name, version, unique bom-ref and, when
 *     present, a well-formed npm purl and license entries;
 *   - dependency entries are non-empty, unique, and every ref/dependsOn target
 *     resolves to a component (or the metadata root component);
 *   - all six published packages and every workspace package are present at
 *     their packages/<dir>/package.json versions (a stale SBOM after a version
 *     bump fails);
 *   - no absolute path, file:// URL, home directory or repository path leaks
 *     anywhere in the document (stricter than the shared release-gate scan).
 *
 *   node scripts/check-sbom.mjs
 *   node scripts/check-sbom.mjs --file /tmp/advs.cdx.json
 *   node scripts/check-sbom.mjs --version 0.2.4
 *
 * Exit codes: 0 = passed; 1 = at least one check failed; 2 = usage error or the
 * artifact is missing/unreadable (run `pnpm run sbom` first).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PACKAGES, validateSbom } from './check-provenance.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_FILE = join(root, 'artifacts', 'sbom.cdx.json')
const SUPPORTED_SPEC_VERSIONS = new Set(['1.5', '1.6', '1.7'])
const COMPONENT_TYPES = new Set([
  'application', 'framework', 'library', 'container', 'platform', 'operating-system',
  'device', 'device-driver', 'firmware', 'file', 'machine-learning-model', 'data',
  'cryptographic-asset',
])

function fail(message, code = 1) {
  console.error('advisers check-sbom: ' + message)
  process.exit(code)
}

function usage() {
  console.log([
    'usage: node scripts/check-sbom.mjs [--file <path>] [--version <version>]',
    '',
    '  --file <path>      SBOM to validate (default: artifacts/sbom.cdx.json)',
    '  --version <v>      expected advisers version (default: packages/advisers/package.json)',
    '  --help             show this help',
    '',
    'Generate the artifact first with `pnpm run sbom`; see docs/SBOM.md.',
  ].join('\n'))
}

function parseArgs(argv) {
  const options = { file: DEFAULT_FILE, version: '', help: false }
  const readValue = (index, flag) => {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(flag + ' needs a value', 2)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--file') { options.file = readValue(index, '--file'); index += 1 }
    else if (arg.startsWith('--file=')) options.file = arg.slice('--file='.length)
    else if (arg === '--version') { options.version = readValue(index, '--version'); index += 1 }
    else if (arg.startsWith('--version=')) options.version = arg.slice('--version='.length)
    else fail('unknown argument: ' + arg + ' (try --help)', 2)
  }
  return options
}

function displayPath(file) {
  const shown = relative(root, file)
  return shown.startsWith('..') ? file : shown.split(sep).join('/')
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB'
}

/** Workspace projects from packages/<dir>/package.json (pnpm-workspace.yaml matches packages/*). */
function readWorkspacePackages() {
  const packagesDir = join(root, 'packages')
  const manifests = []
  const entries = readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestFile = join(packagesDir, entry.name, 'package.json')
    if (!existsSync(manifestFile)) continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    } catch (error) {
      fail('cannot read packages/' + entry.name + '/package.json: ' + (error && error.message ? error.message : String(error)), 2)
    }
    if (!manifest || typeof manifest.name !== 'string' || !manifest.name
      || typeof manifest.version !== 'string' || !manifest.version) {
      fail('packages/' + entry.name + '/package.json must declare a non-empty name and version', 2)
    }
    manifests.push(manifest)
  }
  if (!manifests.length) fail('no workspace package manifests found under packages/*/package.json', 2)
  return manifests
}

/** Absolute-path / build-machine leakage scan over every string in the document. */
function findAbsolutePaths(document) {
  const leaks = []
  const home = homedir()
  const rootVariants = [root, root.split(sep).join('/')].filter(Boolean)
  const visit = (value, path) => {
    if (typeof value === 'string') {
      const reasons = []
      if (/^[A-Za-z]:[\\/]/.test(value)) reasons.push('windows drive path')
      if (value.startsWith('/') || value.startsWith('\\\\')) reasons.push('posix/UNC path')
      if (/(^|[^A-Za-z0-9])file:\/\//i.test(value)) reasons.push('file:// URL')
      if (home && value.includes(home)) reasons.push('home directory')
      for (const variant of rootVariants) {
        if (variant.length > 1 && value.includes(variant)) reasons.push('repository path')
      }
      if (reasons.length) leaks.push(path + ' (' + [...new Set(reasons)].join(', ') + ') = ' + value.slice(0, 120))
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, path + '[' + index + ']'))
    } else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) visit(value[key], path + '.' + key)
    }
  }
  visit(document, '$')
  return leaks
}

function licenseProblem(component) {
  if (component.licenses === undefined) return ''
  if (!Array.isArray(component.licenses) || component.licenses.length === 0) return 'licenses must be a non-empty array'
  for (const entry of component.licenses) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'license entry must be an object'
    if (typeof entry.expression === 'string' && entry.expression) continue
    const license = entry.license
    if (!license || typeof license !== 'object' || Array.isArray(license)) return 'license entry needs a license object or an expression'
    if (!(typeof license.id === 'string' && license.id) && !(typeof license.name === 'string' && license.name)) {
      return 'license needs a non-empty id or name'
    }
  }
  return ''
}

function dependencyProblems(document, knownRefs) {
  const problems = []
  if (!Array.isArray(document.dependencies) || document.dependencies.length === 0) {
    return ['document.dependencies must be a non-empty array']
  }
  const seen = new Set()
  for (const dependency of document.dependencies) {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
      problems.push('dependency entries must be objects')
      continue
    }
    if (typeof dependency.ref !== 'string' || !dependency.ref) {
      problems.push('dependency entry without a non-empty ref')
      continue
    }
    if (seen.has(dependency.ref)) problems.push('duplicate dependency ref ' + dependency.ref)
    seen.add(dependency.ref)
    if (!knownRefs.has(dependency.ref)) problems.push('dangling dependency ref ' + dependency.ref)
    if (dependency.dependsOn === undefined) continue
    if (!Array.isArray(dependency.dependsOn)) {
      problems.push(dependency.ref + '.dependsOn must be an array')
      continue
    }
    for (const target of dependency.dependsOn) {
      if (typeof target !== 'string' || !target) {
        problems.push(dependency.ref + '.dependsOn entries must be non-empty strings')
        continue
      }
      if (!knownRefs.has(target)) problems.push(dependency.ref + ' -> ' + target + ' does not resolve to a component')
    }
  }
  return problems
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    usage()
    return 0
  }
  const file = resolve(options.file)
  const shown = displayPath(file)
  if (!existsSync(file)) {
    console.error('check-sbom: SBOM artifact not found: ' + shown)
    console.error('  generate it first: pnpm run sbom   (see docs/SBOM.md)')
    process.exit(2)
  }
  let stat
  try {
    stat = statSync(file)
  } catch (error) {
    fail('cannot stat ' + shown + ': ' + (error && error.message ? error.message : String(error)), 2)
  }
  const checks = []
  const add = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail }) }
  add('file', stat.isFile() && stat.size > 0, shown + ' (' + formatBytes(stat.size) + ')')

  let document = null
  let parseError = ''
  try {
    document = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    parseError = error && error.message ? error.message : String(error)
  }
  add('json', !parseError, parseError ? 'SBOM is not valid JSON: ' + parseError : 'parsed as JSON')

  const workspace = readWorkspacePackages()
  const workspaceByName = new Map(workspace.map((manifest) => [manifest.name, manifest]))
  const advisersManifest = workspaceByName.get('advisers')
  const version = options.version || (advisersManifest ? advisersManifest.version : '')

  if (!parseError) {
    // Required release-gate checks: shared with verify-release.mjs --require-sbom.
    const shared = validateSbom(document, { version, packages: PACKAGES })
    for (const check of shared.checks) add('release-gate', check.ok, check.detail)
    for (const warning of shared.warnings) console.log('WARN  ' + warning)

    const metadata = document && document.metadata && typeof document.metadata === 'object' ? document.metadata : null
    const metadataComponent = metadata && metadata.component && typeof metadata.component === 'object' ? metadata.component : null
    add('metadata', Boolean(metadata) && Boolean(metadataComponent), metadataComponent
      ? 'metadata.component = ' + String(metadataComponent.name) + '@' + String(metadataComponent.version)
      : 'document.metadata.component is missing')
    add('bom-version', Number.isInteger(document.version) && document.version >= 1, 'document version ' + String(document.version))
    add('spec-version', SUPPORTED_SPEC_VERSIONS.has(document.specVersion),
      'specVersion ' + String(document.specVersion) + ' (supported: ' + [...SUPPORTED_SPEC_VERSIONS].join(', ') + ')')
    add('serial-number', typeof document.serialNumber === 'string' && /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(document.serialNumber),
      'serialNumber ' + String(document.serialNumber))
    add('timestamp', Boolean(metadata) && typeof metadata.timestamp === 'string' && !Number.isNaN(Date.parse(metadata.timestamp)),
      'metadata.timestamp ' + String(metadata && metadata.timestamp))

    const components = Array.isArray(document.components) ? document.components : []
    add('components', Array.isArray(document.components) && components.length > 0, Array.isArray(document.components) ? components.length + ' component(s)' : 'components is not an array')
    const badShape = []
    for (const component of components) {
      if (!component || typeof component !== 'object' || Array.isArray(component)) { badShape.push('component is not an object'); continue }
      if (typeof component.type !== 'string' || !COMPONENT_TYPES.has(component.type)) badShape.push(String(component.name) + ': invalid type ' + String(component.type))
      if (typeof component.name !== 'string' || !component.name) badShape.push('component without a non-empty name')
      if (typeof component.version !== 'string' || !component.version) badShape.push(String(component.name) + ': component without a non-empty version')
    }
    add('component-shape', badShape.length === 0, badShape.length ? badShape.slice(0, 5).join('; ') : components.length + ' component(s) with type/name/version')

    const refs = new Map()
    const missingRefs = []
    const duplicateRefs = []
    for (const component of components) {
      const ref = component && component['bom-ref']
      if (typeof ref !== 'string' || !ref) { missingRefs.push(String(component && component.name)); continue }
      if (refs.has(ref)) duplicateRefs.push(ref)
      refs.set(ref, component)
    }
    add('bom-refs', missingRefs.length === 0, missingRefs.length ? 'component(s) without bom-ref: ' + missingRefs.slice(0, 5).join(', ') : refs.size + ' component bom-ref(s)')
    add('bom-ref-unique', duplicateRefs.length === 0, duplicateRefs.length ? 'duplicate bom-ref(s): ' + duplicateRefs.slice(0, 5).join(', ') : 'no duplicate component bom-refs')

    const badPurls = []
    for (const component of components) {
      if (component && component.purl === undefined) continue
      if (typeof component.purl !== 'string' || !/^pkg:[a-z][a-z0-9.+-]*\/.+/i.test(component.purl)) badPurls.push(String(component.name) + '=' + String(component.purl))
    }
    add('purls', badPurls.length === 0, badPurls.length ? badPurls.slice(0, 5).join('; ') : 'all component purls are well formed')

    const badLicenses = []
    for (const component of components) {
      const problem = licenseProblem(component || {})
      if (problem) badLicenses.push(String(component && component.name) + ': ' + problem)
    }
    add('licenses', badLicenses.length === 0, badLicenses.length ? badLicenses.slice(0, 5).join('; ') : 'license entries are well formed')

    const knownRefs = new Set(refs.keys())
    const rootRef = metadataComponent && metadataComponent['bom-ref']
    if (typeof rootRef === 'string' && rootRef) knownRefs.add(rootRef)
    const dependencyIssues = dependencyProblems(document, knownRefs)
    add('dependencies', dependencyIssues.length === 0, dependencyIssues.length
      ? dependencyIssues.slice(0, 5).join('; ')
      : Array.isArray(document.dependencies) ? document.dependencies.length + ' dependency entr(ies), all refs resolve' : 'no dependencies')

    const stale = []
    for (const component of components) {
      const known = component && workspaceByName.get(component.name)
      if (known && component.version !== known.version) stale.push(component.name + '@' + component.version + ' != ' + known.version)
    }
    add('workspace-versions', stale.length === 0, stale.length
      ? stale.slice(0, 5).join('; ')
      : workspace.length + ' workspace package version(s) match packages/*/package.json')

    const names = new Set(components.map((component) => component && component.name).filter(Boolean))
    const missingPublished = PACKAGES.filter((name) => !names.has(name))
    add('published-packages', missingPublished.length === 0, missingPublished.length
      ? 'missing published package component(s): ' + missingPublished.join(', ')
      : PACKAGES.length + '/' + PACKAGES.length + ' published packages present (' + PACKAGES.join(', ') + ')')
    const missingWorkspace = workspace.filter((manifest) => !names.has(manifest.name)).map((manifest) => manifest.name)
    add('workspace-packages', missingWorkspace.length === 0, missingWorkspace.length
      ? 'missing workspace package component(s): ' + missingWorkspace.join(', ')
      : workspace.length + '/' + workspace.length + ' workspace packages present')

    const advisersComponent = components.find((component) => component && component.name === 'advisers')
    const recordsVersion = Boolean(
      (advisersComponent && advisersComponent.version === version)
      || (metadataComponent && metadataComponent.version === version),
    )
    add('advisers-version', recordsVersion, 'expected ' + String(version) + ', component record '
      + (advisersComponent ? String(advisersComponent.name) + '@' + String(advisersComponent.version) : 'missing'))

    const leaks = findAbsolutePaths(document)
    add('no-absolute-paths', leaks.length === 0, leaks.length
      ? leaks.slice(0, 3).join('; ')
      : 'no absolute path, file:// URL, home directory or repository path in ' + String(stat.size) + ' bytes')
  }

  const failed = checks.filter((check) => !check.ok)
  for (const check of checks) {
    console.log((check.ok ? 'PASS' : 'FAIL') + '  ' + check.name + (check.detail ? ' :: ' + check.detail : ''))
  }
  console.log('')
  if (failed.length) {
    console.error('check-sbom: FAIL (' + failed.length + ' failed / ' + checks.length + ' checks)')
    console.error('  artifact: ' + shown)
    console.error('  regenerate: pnpm run sbom   (see docs/SBOM.md)')
    return 1
  }
  console.log('check-sbom: PASS (' + checks.length + ' checks, ' + formatBytes(stat.size) + ')')
  return 0
}

process.exit(main())
