#!/usr/bin/env node
/**
 * CycloneDX SBOM generator for the Advisers workspace — `pnpm run sbom`.
 *
 * The 0.3.0 release gate needs a machine-readable SBOM next to the published
 * packages (23-0.3.0-scope R2: components > 0, no absolute build-machine paths).
 * This script adds no SBOM dependency to the workspace: it uses the package
 * manager's built-in `pnpm sbom` command (pnpm >= 10.9; this repo pins pnpm
 * 12.16.1 through package.json#packageManager), which renders pnpm-lock.yaml as
 * CycloneDX from the lockfile alone — `--lockfile-only --offline` means no
 * registry request and no node_modules/store read.
 *
 *   pnpm run sbom                              # -> artifacts/sbom.cdx.json
 *   node scripts/sbom.mjs --out /tmp/advs.cdx.json
 *   node scripts/sbom.mjs --spec-version 1.6
 *
 * (`pnpm sbom` without `run` invokes pnpm's own built-in sbom command, not this
 * script — pnpm resolves a built-in command before a script of the same name.)
 *
 * What is generated: the CycloneDX document from
 *   pnpm sbom --sbom-format cyclonedx --lockfile-only --offline
 *            --sbom-spec-version <v>
 * followed by two deterministic post-processing steps:
 *   1. workspace projects that pnpm's combined workspace SBOM does not list are
 *      added as components from their packages/<dir>/package.json. pnpm only
 *      emits workspace packages that are `link:` dependency *targets* of another
 *      workspace project, so leaf projects (advisers-bridge-hermes,
 *      dsh-advisers, advisers-link-email, advisers-link-feishu) would otherwise
 *      be missing. No synthetic dependency edges are added for them.
 *   2. components and dependency lists are sorted by bom-ref so repeated runs
 *      diff cleanly. serialNumber/timestamp are still produced per run, so the
 *      file bytes and hash are not reproducible across runs.
 * A metadata property records how the artifact was produced.
 *
 * The artifact is a lockfile-derived dependency SBOM, NOT a full build-graph
 * SBOM and NOT a vulnerability scan. See docs/SBOM.md and `pnpm run check:sbom`.
 *
 * Exit codes: 0 = written; 1 = pnpm sbom failed or its output is not CycloneDX;
 * 2 = usage error or the pnpm >= 10.9 sbom command is unavailable.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_OUT = join(root, 'artifacts', 'sbom.cdx.json')
const DEFAULT_OUT_LABEL = 'artifacts/sbom.cdx.json'
const SPEC_VERSIONS = ['1.5', '1.6', '1.7']
const DEFAULT_SPEC_VERSION = '1.7'
const SPAWN_TIMEOUT_MS = 300000
const MAX_STDOUT_BYTES = 64 * 1024 * 1024

function fail(message, code = 1) {
  console.error('advisers sbom: ' + message)
  process.exit(code)
}

function usage() {
  console.log([
    'usage: node scripts/sbom.mjs [--out <file>] [--spec-version <1.5|1.6|1.7>]',
    '',
    '  --out <file>          output path (default: ' + DEFAULT_OUT_LABEL + ', relative to the repository root)',
    '  --spec-version <v>    CycloneDX spec version (default: ' + DEFAULT_SPEC_VERSION + ')',
    '  --help                show this help',
    '',
    'The SBOM is generated offline from pnpm-lock.yaml with the pnpm >= 10.9 built-in',
    '`sbom` command; no SBOM dependency or network access is added. Validate the result',
    'with `pnpm run check:sbom`. See docs/SBOM.md.',
  ].join('\n'))
}

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, specVersion: DEFAULT_SPEC_VERSION, help: false }
  const readValue = (index, flag) => {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(flag + ' needs a value', 2)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--out') { options.out = readValue(index, '--out'); index += 1 }
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else if (arg === '--spec-version') { options.specVersion = readValue(index, '--spec-version'); index += 1 }
    else if (arg.startsWith('--spec-version=')) options.specVersion = arg.slice('--spec-version='.length)
    else fail('unknown argument: ' + arg + ' (try --help)', 2)
  }
  if (!options.out) fail('--out must not be empty', 2)
  if (!SPEC_VERSIONS.includes(options.specVersion)) {
    fail('unsupported --spec-version "' + options.specVersion + '"; supported: ' + SPEC_VERSIONS.join(', '), 2)
  }
  return options
}

/**
 * Run `pnpm sbom` and return its stdout. pnpm's sbom command writes the
 * CycloneDX document to stdout and nothing to stderr in --lockfile-only mode.
 * On Windows the `pnpm` shim is a .cmd file, which cannot be spawned directly
 * without a shell, so go through cmd.exe with a constant, quoted-free command
 * string (the only variable is the validated spec version).
 */
function generateCycloneDx(specVersion) {
  const sbomArgs = ['sbom', '--sbom-format', 'cyclonedx', '--lockfile-only', '--offline', '--sbom-spec-version', specVersion]
  const run = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm ' + sbomArgs.join(' ')], {
      cwd: root, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, maxBuffer: MAX_STDOUT_BYTES, windowsHide: true,
    })
    : spawnSync('pnpm', sbomArgs, {
      cwd: root, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, maxBuffer: MAX_STDOUT_BYTES,
    })
  if (run.error) {
    if (run.error.code === 'ENOENT') {
      fail('pnpm was not found on PATH. This generator needs the pnpm >= 10.9 built-in "pnpm sbom"', 2)
    }
    fail('could not run pnpm sbom: ' + (run.error.message || String(run.error)))
  }
  if (run.status !== 0) {
    const detail = String(run.stderr || run.stdout || '').trim().split('\n').slice(-8).join('\n')
    fail('pnpm sbom failed (exit ' + (run.status === null ? 'signal ' + run.signal : run.status) + '):\n' + detail)
  }
  return String(run.stdout || '')
}

/** Workspace projects from packages/<dir>/package.json (pnpm-workspace.yaml matches packages/*). */
function readWorkspacePackages() {
  const packagesDir = join(root, 'packages')
  const packages = []
  const entries = readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestFile = join(packagesDir, entry.name, 'package.json')
    if (!existsSync(manifestFile)) continue
    const manifestPath = 'packages/' + entry.name + '/package.json'
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    } catch (error) {
      fail('cannot read ' + manifestPath + ': ' + (error && error.message ? error.message : String(error)))
    }
    if (!manifest || typeof manifest.name !== 'string' || !manifest.name
      || typeof manifest.version !== 'string' || !manifest.version) {
      fail(manifestPath + ' must declare a non-empty name and version')
    }
    packages.push(manifest)
  }
  if (!packages.length) fail('no workspace package manifests found under packages/*/package.json')
  return packages
}

/** npm purl for a workspace package, following the package-url npm encoding. */
function npmPurl(name, version) {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/')
    if (slash > 1) {
      return 'pkg:npm/%40' + encodeURIComponent(name.slice(1, slash)) + '/'
        + encodeURIComponent(name.slice(slash + 1)) + '@' + encodeURIComponent(version)
    }
  }
  return 'pkg:npm/' + encodeURIComponent(name) + '@' + encodeURIComponent(version)
}

function componentForWorkspacePackage(manifest) {
  const ref = npmPurl(manifest.name, manifest.version)
  const component = { type: 'library', name: manifest.name, version: manifest.version, purl: ref, 'bom-ref': ref }
  if (typeof manifest.description === 'string' && manifest.description) component.description = manifest.description
  if (typeof manifest.license === 'string' && manifest.license) component.licenses = [{ license: { id: manifest.license } }]
  const repository = manifest.repository
  if (repository && typeof repository === 'object' && typeof repository.url === 'string' && repository.url) {
    component.externalReferences = [{ type: 'vcs', url: repository.url }]
  }
  return component
}

/**
 * Add workspace projects that pnpm's combined workspace SBOM omits. pnpm only
 * makes a workspace package a component when another workspace project links to
 * it, so projects nobody links to (the bridge, the DSH bundle, the link
 * packages) are missing from the combined document. Add them from their
 * package.json; an existing pnpm component always wins.
 */
function augmentWorkspacePackages(document) {
  const alreadyListed = new Set()
  for (const component of document.components) {
    if (component && typeof component.name === 'string') alreadyListed.add(component.name)
  }
  const added = []
  for (const manifest of readWorkspacePackages()) {
    if (alreadyListed.has(manifest.name)) continue
    document.components.push(componentForWorkspacePackage(manifest))
    added.push(manifest.name + '@' + manifest.version)
  }
  return added
}

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function componentKey(component) {
  if (component && typeof component['bom-ref'] === 'string' && component['bom-ref']) return component['bom-ref']
  return String((component && component.name) || '') + '@' + String((component && component.version) || '')
}

/** Sort components / dependency entries so two runs with the same lockfile diff cleanly. */
function normalizeOrder(document) {
  document.components.sort((a, b) => compareStrings(componentKey(a), componentKey(b)))
  if (!Array.isArray(document.dependencies)) return
  for (const dependency of document.dependencies) {
    if (dependency && Array.isArray(dependency.dependsOn)) dependency.dependsOn.sort(compareStrings)
  }
  document.dependencies.sort((a, b) => compareStrings(String((a && a.ref) || ''), String((b && b.ref) || '')))
}

function assertUniqueBomRefs(document) {
  const seen = new Set()
  const duplicates = []
  for (const component of document.components) {
    const ref = component && component['bom-ref']
    if (typeof ref !== 'string' || !ref) continue
    if (seen.has(ref)) duplicates.push(ref)
    seen.add(ref)
  }
  if (duplicates.length) fail('generated SBOM has duplicate bom-ref(s): ' + [...new Set(duplicates)].slice(0, 3).join(', '))
}

function annotateGenerator(document) {
  if (!document.metadata || typeof document.metadata !== 'object' || Array.isArray(document.metadata)) document.metadata = {}
  const properties = Array.isArray(document.metadata.properties) ? document.metadata.properties : []
  properties.push({
    name: 'advisers:sbom:generator',
    value: 'scripts/sbom.mjs (CycloneDX via pnpm sbom --lockfile-only --offline, plus workspace package manifests)',
  })
  document.metadata.properties = properties
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB'
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    usage()
    return 0
  }
  const outFile = resolve(options.out)
  let document
  try {
    document = JSON.parse(generateCycloneDx(options.specVersion))
  } catch (error) {
    fail('pnpm sbom output is not valid JSON: ' + (error && error.message ? error.message : String(error)))
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || document.bomFormat !== 'CycloneDX' || !Array.isArray(document.components)) {
    fail('pnpm sbom output is not a CycloneDX document with a components array'
      + (document && document.bomFormat ? ' (bomFormat=' + document.bomFormat + ')' : ''))
  }
  const added = augmentWorkspacePackages(document)
  normalizeOrder(document)
  assertUniqueBomRefs(document)
  annotateGenerator(document)
  mkdirSync(dirname(outFile), { recursive: true })
  const temporaryOut = outFile + '.tmp-' + process.pid
  try {
    writeFileSync(temporaryOut, JSON.stringify(document, null, 2) + '\n')
    renameSync(temporaryOut, outFile)
  } catch (error) {
    rmSync(temporaryOut, { force: true })
    fail('cannot write ' + outFile + ': ' + (error && error.message ? error.message : String(error)))
  }
  const shown = relative(root, outFile)
  const display = shown.startsWith('..') ? outFile : shown.split(sep).join('/')
  console.log('sbom: wrote ' + display + ' (CycloneDX ' + document.specVersion + ', '
    + document.components.length + ' components, ' + formatBytes(statSync(outFile).size) + ')')
  if (added.length) {
    console.log('sbom: added ' + added.length + ' workspace component(s) pnpm omits as link targets: ' + added.join(', '))
  }
  return 0
}

const invokedHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedHref) {
  process.exit(main())
}
