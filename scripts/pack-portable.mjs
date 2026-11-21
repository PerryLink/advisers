#!/usr/bin/env node
/**
 * Build (or verify) the Windows x64 portable/offline bundle (0.4.0).
 *
 * npm global remains the official channel; this bundle is the offline channel:
 * a self-contained advisers-<version>-win-x64.zip containing the installed
 * runtime dependencies, the launcher and the license files. Node.js is NOT
 * bundled (the user must have Node >= 22.16); the generated README.txt explains
 * the Node requirement and the verification steps.
 *
 * Production modes:
 *   --payload <dir>   package an already-installed app tree. This is the release
 *                     path: run "npm install --omit=dev" on Windows, then package.
 *   --cross-install   run that npm install here and ask npm to resolve the
 *                     win32-x64 optional dependencies (--os=win32 --cpu=x64), so
 *                     a Linux CI machine can produce the same layout. The
 *                     artifact is only releasable after the Windows smoke passes.
 *   --verify <zip>    verify an existing artifact (structure, licenses, payload
 *                     version, native-binary platform, sidecar SHA-256, smoke).
 *
 * The ZIP container is written by scripts/portable-zip.mjs (deterministic,
 * dependency-free) and is re-read and CRC-checked before the command prints
 * PASS. Nothing is published: output goes to --out-dir (default artifacts/,
 * gitignored).
 *
 * CLI:
 *   node scripts/pack-portable.mjs                              self-test (no args)
 *   node scripts/pack-portable.mjs --self-test
 *   node scripts/pack-portable.mjs --payload <dir> --out-dir artifacts
 *   node scripts/pack-portable.mjs --cross-install --out-dir artifacts
 *   node scripts/pack-portable.mjs --verify artifacts/advisers-0.4.0-win-x64.zip --smoke
 *
 * Library: pure builders (launcher/README/package.json) and JSON-ready
 * assemble/verify helpers; the CLI prints PASS/FAIL lines at the end.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  LICENSE_ID,
  NODE_FLOOR,
  extractZip,
  formatBytes,
  formatSha256Line,
  readZip,
  sha256,
  writeSha256Sidecar,
  zipDirectory,
} from './portable-zip.mjs'
import { symlinkSync } from 'node:fs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const PLATFORM = 'win-x64'
export const BUNDLE_FILES = ['advisers.cmd', 'README.txt', 'package.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']
export const ADVISERS_ENTRY = 'app/node_modules/advisers/bin/advisers.js'
export const REGISTRY = 'https://registry.npmjs.org'
const PORTABLE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

const EOL = String.fromCharCode(10)
const CRLF = String.fromCharCode(13) + String.fromCharCode(10)

/** Bundle base name, e.g. advisers-0.4.0-win-x64. */
export function portableBundleName(version, platform = PLATFORM) {
  if (!PORTABLE_VERSION.test(String(version))) throw new Error('invalid bundle version: ' + version)
  return 'advisers-' + version + '-' + platform
}

/** Deterministic CRLF .cmd launcher (no PATH/registry writes, %* passthrough). */
export function buildLauncher({ version, nodeFloor = NODE_FLOOR }) {
  const floor = nodeFloor.split('.').map(Number)
  const lines = [
    '@echo off',
    'rem Advisers ' + version + ' portable launcher (Windows x64).',
    'rem This is the offline portable bundle. The official channel is npm:',
    'rem   npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest',
    'rem Node.js >=' + nodeFloor + ' must be installed. This file does not modify PATH or the registry.',
    'setlocal EnableExtensions',
    'set "ADVISERS_BUNDLE=%~dp0"',
    'set "ADVISERS_ENTRY=%ADVISERS_BUNDLE%app\\node_modules\\advisers\\bin\\advisers.js"',
    'set "ADVISERS_NODE=node"',
    'if exist "%ADVISERS_BUNDLE%node\\node.exe" set "ADVISERS_NODE=%ADVISERS_BUNDLE%node\\node.exe"',
    '',
    'if not exist "%ADVISERS_ENTRY%" (',
    '  echo [advisers] incomplete portable bundle: app\\node_modules\\advisers\\bin\\advisers.js is missing 1>&2',
    '  echo [advisers] re-download and extract advisers-' + version + '-win-x64.zip 1>&2',
    '  exit /b 1',
    ')',
    '"%ADVISERS_NODE%" --version >nul 2>nul',
    'if errorlevel 1 (',
    '  echo [advisers] Node.js >=' + nodeFloor + ' is required but "node" was not found on PATH. 1>&2',
    '  echo [advisers] Install Node.js 24 LTS: winget install OpenJS.NodeJS.LTS 1>&2',
    '  echo [advisers] Or download it from https://nodejs.org/en/download 1>&2',
    '  exit /b 9',
    ')',
    '"%ADVISERS_NODE%" -e "const v=process.versions.node.split(String.fromCharCode(46)).map(Number); if(v[0]<' + floor[0] + '||(v[0]===' + floor[0] + '&&v[1]<' + floor[1] + ')) process.exit(9)"',
    'if errorlevel 9 (',
    '  echo [advisers] Node.js ' + nodeFloor + ' or newer is required but a different version was found. 1>&2',
    '  echo [advisers] Install Node.js 24 LTS: winget install OpenJS.NodeJS.LTS 1>&2',
    '  exit /b 9',
    ')',
    '"%ADVISERS_NODE%" "%ADVISERS_ENTRY%" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ]
  return lines.join(CRLF)
}

/** Deterministic README.txt shipped inside the bundle (no timestamps). */
export function buildReadme({ version, nodeFloor = NODE_FLOOR }) {
  return [
    'Advisers ' + version + ' - Windows x64 portable bundle (offline channel)',
    '=========================================================================',
    '',
    'This ZIP is the OFFLINE distribution channel. The official channel is npm:',
    '',
    '    npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest',
    '',
    'Use npm unless you are offline, behind a restricted network, or need a',
    'self-contained directory you can copy to another machine.',
    '',
    'Requirements',
    '------------',
    '- Windows 11 25H2 or 26H2, x64. Windows 10 is not supported (end of life).',
    '- Node.js >= ' + nodeFloor + ' (Node.js 24 LTS recommended). Node is NOT bundled:',
    '    winget install OpenJS.NodeJS.LTS',
    '    or download the MSI from https://nodejs.org/en/download',
    '    (scoop install nodejs-lts and nvm-windows also work)',
    '- No administrator rights are required. No data is sent anywhere by this',
    '  launcher; Advisers has no telemetry and no automatic update check.',
    '',
    'Quick start',
    '-----------',
    '1. Verify the download (optional but recommended):',
    '',
    '    Get-FileHash -Algorithm SHA256 .\\advisers-' + version + '-win-x64.zip',
    '    # compare with the SHA256SUMS-' + version + '-portable.txt line on the Release page',
    '',
    '   If the file came from the internet, remove the Mark-of-the-Web first:',
    '',
    '    Unblock-File .\\advisers-' + version + '-win-x64.zip',
    '',
    '2. Extract the ZIP (right click -> Extract All, or):',
    '',
    '    Expand-Archive .\\advisers-' + version + '-win-x64.zip -DestinationPath .',
    '    cd .\\advisers-' + version + '-win-x64',
    '',
    '3. Run:',
    '',
    '    .\\advisers.cmd --version',
    '    .\\advisers.cmd status',
    '    .\\advisers.cmd init',
    '',
    '   The launcher prints a clear error if Node.js is missing or older than',
    '   ' + nodeFloor + '. You can add this folder to PATH yourself if you want a',
    '   global "advisers" command (the launcher never modifies PATH).',
    '',
    'Data and uninstall',
    '------------------',
    '- Data lives in %USERPROFILE%\\.advisers unless ADVISERS_HOME is set.',
    '- To uninstall: delete this folder. Delete %USERPROFILE%\\.advisers only if',
    '  you also want to delete the local ledger and consent records.',
    '- Backups created by the CLI are plaintext copies of the database; treat',
    '  them like the database itself.',
    '',
    'License',
    '-------',
    'Software: ' + LICENSE_ID + ' (see LICENSE). Required notice: see NOTICE.',
    'Third-party components: see THIRD-PARTY-NOTICES.md. This is source-available',
    'software, not an OSI-approved open-source project. The Terms of Service and',
    'Privacy notice are shown by the CLI on first use (advisers tos show).',
    '',
    '中文摘要',
    '--------',
    '本 ZIP 是离线分发渠道；正式渠道仍是 npm 全局安装。需要 Windows 11 25H2/26H2',
    'x64 与 Node.js >= ' + nodeFloor + '（未内置 Node）。下载后可用 Unblock-File 解除',
    '锁定，解压后运行 advisers.cmd --version。数据默认在 %USERPROFILE%\\.advisers。',
    '',
  ].join(CRLF)
}

/** Deterministic bundle metadata package.json (machine-readable engines floor). */
export function buildBundlePackageJson({ version, platform = PLATFORM }) {
  return (
    JSON.stringify(
      {
        name: 'advisers-portable',
        version,
        private: true,
        description: 'Offline portable layout of Advisers for Windows x64; Node.js ' + NODE_FLOOR + '+ required. The official channel is npm.',
        license: LICENSE_ID,
        type: 'module',
        os: ['win32'],
        cpu: ['x64'],
        engines: { node: '>=' + NODE_FLOOR },
        distribution: { channel: 'portable-zip', platform, layout: 1, officialChannel: 'npm' },
      },
      null,
      2,
    ) + EOL
  )
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * Resolve --payload to { source, asNodeModules, input }:
 * - a directory that IS a node_modules tree (contains advisers/bin/advisers.js)
 *   is copied to app/node_modules;
 * - an app directory (contains node_modules/advisers/bin/advisers.js) is
 *   copied to app.
 */
export function resolvePayload(payloadDir) {
  const input = resolve(payloadDir)
  if (!existsSync(input)) throw new Error('--payload does not exist: ' + input)
  if (existsSync(join(input, 'node_modules', 'advisers', 'bin', 'advisers.js'))) return { source: input, asNodeModules: false, input }
  if (existsSync(join(input, 'advisers', 'bin', 'advisers.js'))) return { source: input, asNodeModules: true, input }
  throw new Error('--payload must contain node_modules/advisers/bin/advisers.js (app dir) or advisers/bin/advisers.js (node_modules dir): ' + input)
}

/**
 * Copy a tree, dereferencing symlinks to regular files. npm creates
 * node_modules/.bin/* symlinks on POSIX hosts (possibly with absolute targets);
 * the portable bundle must contain regular files only, otherwise the launcher
 * and the ZIP verifier would either follow a link outside the bundle or fail.
 */
function copyTreeDereferenced(source, target) {
  const from = resolve(source)
  const to = resolve(target)
  rmSync(to, { recursive: true, force: true })
  const copy = (srcPath, dstPath) => {
    const info = lstatSync(srcPath)
    if (info.isDirectory()) {
      mkdirSync(dstPath, { recursive: true })
      for (const entry of readdirSync(srcPath).sort()) copy(join(srcPath, entry), join(dstPath, entry))
      return
    }
    if (info.isSymbolicLink()) {
      const real = realpathSync(srcPath)
      if (!statSync(real).isFile()) throw new Error('refusing a symlinked directory in the portable payload: ' + srcPath)
      writeFileSync(dstPath, readFileSync(real))
      return
    }
    if (!info.isFile()) throw new Error('refusing a special file in the portable payload: ' + srcPath)
    copyFileSync(srcPath, dstPath)
  }
  copy(from, to)
}

function listFilesRecursive(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listFilesRecursive(absolute))
    else if (entry.isFile()) files.push(absolute)
  }
  return files
}

function countFiles(dir) {
  return listFilesRecursive(dir).length
}

function directoryBytes(dir) {
  return listFilesRecursive(dir).reduce((sum, file) => sum + statSync(file).size, 0)
}

/**
 * Assemble the portable directory (no ZIP yet). Returns JSON-ready metadata.
 * Deterministic input -> deterministic file tree; no timestamps are embedded.
 */
export function assemblePortableBundle({ appSource, asNodeModules = false, bundleRoot, version, platform = PLATFORM, repoRoot = root }) {
  if (!PORTABLE_VERSION.test(String(version))) throw new Error('invalid bundle version: ' + version)
  const bundle = resolve(bundleRoot)
  rmSync(bundle, { recursive: true, force: true })
  mkdirSync(bundle, { recursive: true })
  const appTarget = join(bundle, 'app')
  if (asNodeModules) {
    copyTreeDereferenced(appSource, join(appTarget, 'node_modules'))
  } else {
    copyTreeDereferenced(appSource, appTarget)
  }

  const entry = join(bundle, 'app', 'node_modules', 'advisers', 'bin', 'advisers.js')
  if (!existsSync(entry)) throw new Error('assembled bundle is missing ' + ADVISERS_ENTRY)
  const advisersPkg = readJson(join(bundle, 'app', 'node_modules', 'advisers', 'package.json'))
  if (advisersPkg.version !== version) throw new Error('payload advisers version ' + advisersPkg.version + ' does not match requested ' + version)
  if (advisersPkg.license !== LICENSE_ID) throw new Error('payload advisers license is ' + advisersPkg.license + ', expected ' + LICENSE_ID)
  const officePkg = join(bundle, 'app', 'node_modules', 'advisers-office', 'package.json')

  for (const file of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
    const source = join(repoRoot, file)
    if (!existsSync(source)) throw new Error('repository is missing the required license file: ' + file)
    cpSync(source, join(bundle, file))
  }
  const licenseText = readFileSync(join(bundle, 'LICENSE'), 'utf8')
  if (!licenseText.includes('PolyForm Noncommercial License 1.0.0')) throw new Error('LICENSE does not contain the PolyForm Noncommercial 1.0.0 text')
  if (licenseText.includes('Apache License')) throw new Error('LICENSE still contains the Apache License text')
  if (!readFileSync(join(bundle, 'NOTICE'), 'utf8').includes('Required Notice:')) throw new Error('NOTICE is missing the Required Notice line')

  writeFileSync(join(bundle, 'advisers.cmd'), buildLauncher({ version }))
  writeFileSync(join(bundle, 'README.txt'), buildReadme({ version }))
  writeFileSync(join(bundle, 'package.json'), buildBundlePackageJson({ version, platform }))

  for (const file of BUNDLE_FILES) {
    if (!existsSync(join(bundle, file))) throw new Error('portable bundle is missing ' + file)
  }
  return {
    bundleRoot: bundle,
    bundleName: portableBundleName(version, platform),
    version,
    platform,
    resolvesPackage: { name: advisersPkg.name, version: advisersPkg.version, license: advisersPkg.license },
    officeIncluded: existsSync(officePkg),
    fileCount: countFiles(bundle),
    bytes: directoryBytes(bundle),
  }
}

/** Install the two published packages into a fresh app tree (release payload path). */
export function installPayload({ version, appDir, registry = REGISTRY, crossInstall = false }) {
  mkdirSync(appDir, { recursive: true })
  const args = [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--prefix',
    appDir,
    '--registry',
    registry,
    'advisers@' + version,
    'advisers-office@' + version,
  ]
  // npm >= 10.2 can resolve optional dependencies for another OS/CPU. The flag
  // is experimental; when it fails, use the Windows build path (--payload).
  const cross = crossInstall && process.platform !== 'win32'
  if (cross) args.push('--os=win32', '--cpu=x64')
  // Keep the npm cache outside app/ (and therefore outside the bundle), or it
  // would be packaged into the ZIP and inflate it by ~70 MB.
  const env = { ...process.env, npm_config_cache: join(appDir, '..', 'npm-cache') }
  execFileSync('npm', args, { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000 })
  return { appDir, cross, args }
}

/** Classify native .node entries in a win-x64 artifact (release guard). */
export function nativePlatforms(entryNames) {
  const found = new Map()
  for (const name of entryNames) {
    if (!name.endsWith('.node')) continue
    const lower = name.toLowerCase()
    let platform = 'unknown'
    if (/win32[-_]x64/.test(lower)) platform = 'win32-x64'
    else if (/linux-x64/.test(lower)) platform = 'linux-x64'
    else if (/darwin|apple/.test(lower)) platform = 'darwin'
    else if (/win32/.test(lower)) platform = 'win32-other'
    found.set(name, platform)
  }
  return found
}

/**
 * Verify a built portable zip: structure, required entries, license files, the
 * payload version/license, native-binary platform and (optionally) the sidecar
 * SHA-256. Returns JSON-ready { ok, errors, checks, sha256, ... }.
 */
export function verifyPortableZip(zipPath, options = {}) {
  const version = options.version
  const errors = []
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok })
    if (!ok) errors.push(name + (detail ? ': ' + detail : ''))
    return ok
  }
  const file = resolve(zipPath)
  if (!existsSync(file)) {
    check('artifact exists', false, file)
    return { ok: false, errors, checks, sha256: '', entryCount: 0, totalBytes: 0, entries: [] }
  }
  const buffer = readFileSync(file)
  const archive = readZip(buffer, { withData: true })
  const names = archive.entries.map((entry) => entry.name)
  const basename = file.split(/[\\/]/).pop()
  // The archive contains one top-level folder so extraction yields a single
  // directory; verification paths are relative to that folder.
  const bundlePrefix = portableBundleName(version) + '/'
  check('archive wraps everything in ' + bundlePrefix, names.every((name) => name.startsWith(bundlePrefix)))
  check('artifact is a readable ZIP', true)
  check('artifact filename matches advisers-<version>-win-x64.zip', basename === 'advisers-' + version + '-win-x64.zip', basename)
  for (const required of options.requiredEntries || BUNDLE_FILES) {
    check('bundle contains ' + required, names.includes(bundlePrefix + required))
  }
  check('bundle contains ' + ADVISERS_ENTRY, names.includes(bundlePrefix + ADVISERS_ENTRY))
  const entryData = (name) => {
    const found = archive.entries.find((entry) => entry.name === bundlePrefix + name)
    return found ? found.data.toString('utf8') : ''
  }
  const advisersPkgEntry = 'app/node_modules/advisers/package.json'
  if (names.includes(advisersPkgEntry)) {
    try {
      const parsed = JSON.parse(entryData(advisersPkgEntry))
      check('payload advisers version matches ' + version, parsed.version === version, parsed.version)
      check('payload advisers license is ' + LICENSE_ID, parsed.license === LICENSE_ID, parsed.license)
    } catch (error) {
      check('payload advisers/package.json parses', false, String(error.message || error))
    }
  }
  const natives = nativePlatforms(names)
  const wrongNative = [...natives].filter(([, platform]) => platform !== 'win32-x64')
  check('native modules target win32-x64', wrongNative.length === 0, wrongNative.map(([name, platform]) => name + ' (' + platform + ')').join(', '))
  const launcher = entryData('advisers.cmd')
  check('launcher references the advisers entry point', launcher.includes('app\\node_modules\\advisers\\bin\\advisers.js'))
  check('launcher enforces Node >=' + NODE_FLOOR, launcher.includes(NODE_FLOOR))
  check('launcher passes arguments through', launcher.includes('%*'))
  const readme = entryData('README.txt')
  check('README states npm is the official channel', /official channel is npm/i.test(readme))
  check('README states the ZIP is the offline channel', /offline channel/i.test(readme))
  check('README states Node >=' + NODE_FLOOR, readme.includes('Node.js >= ' + NODE_FLOOR))
  let metaParsed = null
  try {
    metaParsed = JSON.parse(entryData('package.json'))
  } catch (error) {
    check('bundle package.json parses', false, String(error.message || error))
  }
  if (metaParsed) {
    check('bundle package.json engines.node', Boolean(metaParsed.engines) && metaParsed.engines.node === '>=' + NODE_FLOOR, JSON.stringify(metaParsed.engines))
    check('bundle package.json license', metaParsed.license === LICENSE_ID, metaParsed.license)
  }
  const digest = sha256(buffer)
  const sidecarFile = file + '.sha256'
  if (existsSync(sidecarFile)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(readFileSync(sidecarFile, 'utf8').trim())
    check('sidecar digest matches the artifact', Boolean(match) && match[1] === digest, String(match && match[1]).slice(0, 160))
  } else if (options.requireSidecar) {
    check('artifact sidecar .sha256 exists', false)
  }
  if (options.expectedSha256) {
    check('SHA-256 matches the expected value', String(options.expectedSha256).toLowerCase() === digest, digest)
  }
  if (version) {
    const sumsFile = join(resolve(file, '..'), 'SHA256SUMS-' + version + '-portable.txt')
    if (existsSync(sumsFile)) {
      const lines = readFileSync(sumsFile, 'utf8').split(/\r?\n/).filter(Boolean)
      check('portable SHA256SUMS lists this artifact', lines.some((line) => line.startsWith(digest + '  ' + basename) || line.startsWith(digest + ' *' + basename)))
    }
  }
  if (options.smoke) {
    const temp = mkdtempSync(join(tmpdir(), 'advisers-portable-smoke-'))
    try {
      extractZip(buffer, temp)
      const bundleDir = join(temp, portableBundleName(version))
      const entry = join(bundleDir, 'app', 'node_modules', 'advisers', 'bin', 'advisers.js')
      const env = { ...process.env, ADVISERS_HOME: join(temp, 'home'), ADVISERS_ACCEPT_TOS: '1', ADVISERS_NO_MODEL: '1' }
      delete env.NODE_TEST_CONTEXT
      const result = execFileSync(process.execPath, [entry, '--version'], { cwd: bundleDir, env, encoding: 'utf8', timeout: 120000 })
      check('extracted payload runs and prints ' + version, String(result).trim() === version, String(result).trim())
      if (process.platform === 'win32') {
        const cmd = execFileSync('cmd', ['/c', 'advisers.cmd', '--version'], { cwd: bundleDir, env, encoding: 'utf8', timeout: 120000 })
        check('advisers.cmd --version prints ' + version, String(cmd).trim() === version, String(cmd).trim())
      }
    } catch (error) {
      check('extracted payload smoke run', false, String(error.stderr || error.message || error).slice(0, 400))
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    checks,
    file,
    sha256: digest,
    entryCount: archive.entryCount,
    totalBytes: archive.totalBytes,
    nativeModules: [...natives].map(([name, platform]) => ({ name, platform })),
    outputBytes: buffer.length,
  }
}

function writeBundleZip({ bundleRoot, outDir, version, platform = PLATFORM }) {
  const bundleName = portableBundleName(version, platform)
  mkdirSync(outDir, { recursive: true })
  // Prefix every entry with the bundle folder name so extraction yields one
  // top-level directory, and so staging siblings (npm cache, app/) never leak
  // into the archive.
  const buffer = zipDirectory(bundleRoot, { prefix: bundleName, followSymlinks: true })
  const zipPath = join(outDir, bundleName + '.zip')
  writeFileSync(zipPath, buffer)
  const digest = sha256(buffer)
  const sidecar = writeSha256Sidecar(zipPath, digest)
  const sumsPath = join(outDir, 'SHA256SUMS-' + version + '-portable.txt')
  writeFileSync(sumsPath, formatSha256Line(digest, bundleName + '.zip'))
  return { zipPath, digest, sidecar, sumsPath, bytes: buffer.length }
}

function fail(message) {
  process.stderr.write('FAIL ' + message + EOL)
  return 1
}
function pass(message) {
  process.stdout.write('PASS ' + message + EOL)
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag)
  if (index === -1) return ''
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(flag + ' requires a value')
  return value
}

/** Self-test: assembles a synthetic bundle, zips it, verifies it and runs it. */
export function runSelfTest() {
  const temp = mkdtempSync(join(tmpdir(), 'advisers-pack-portable-'))
  let failures = 0
  const check = (name, ok, detail = '') => {
    if (ok) pass(name)
    else {
      failures += 1
      process.stderr.write('FAIL ' + name + (detail ? ': ' + detail : '') + EOL)
    }
  }
  const version = '0.4.0-selftest'
  try {
    const appSource = join(temp, 'app-source')
    const nodeModules = join(appSource, 'node_modules')
    mkdirSync(join(nodeModules, 'advisers', 'bin'), { recursive: true })
    mkdirSync(join(nodeModules, 'advisers-office'), { recursive: true })
    writeFileSync(
      join(nodeModules, 'advisers', 'bin', 'advisers.js'),
      '#!/usr/bin/env node' + EOL + 'console.log(' + JSON.stringify(version) + ')' + EOL,
    )
    writeFileSync(
      join(nodeModules, 'advisers', 'package.json'),
      JSON.stringify({ name: 'advisers', version, license: LICENSE_ID, engines: { node: '>=' + NODE_FLOOR } }) + EOL,
    )
    writeFileSync(join(nodeModules, 'advisers-office', 'package.json'), JSON.stringify({ name: 'advisers-office', version, license: LICENSE_ID }) + EOL)
    const payload = resolvePayload(appSource)
    check('resolvePayload accepts an app directory', payload.asNodeModules === false)
    const bundleRoot = join(temp, 'stage', portableBundleName(version))
    const assembled = assemblePortableBundle({ appSource: payload.source, asNodeModules: payload.asNodeModules, bundleRoot, version })
    check('bundle contains the advisers entry point', existsSync(join(bundleRoot, ADVISERS_ENTRY)))
    check('bundle contains all required files', BUNDLE_FILES.every((file) => existsSync(join(bundleRoot, file))))
    check('bundle carries the repository LICENSE', readFileSync(join(bundleRoot, 'LICENSE'), 'utf8').includes('PolyForm Noncommercial License 1.0.0'))
    check('launcher enforces the Node floor', readFileSync(join(bundleRoot, 'advisers.cmd'), 'utf8').includes(NODE_FLOOR))
    const readme = readFileSync(join(bundleRoot, 'README.txt'), 'utf8')
    check('README names npm as the official channel and the ZIP as the offline channel', /official channel is npm/i.test(readme) && /offline channel/i.test(readme))
    check('assembled file count matches the tree', assembled.fileCount === countFiles(bundleRoot))

    const outDir = join(temp, 'out')
    const built = writeBundleZip({ bundleRoot, outDir, version })
    check('zip is named advisers-' + version + '-win-x64.zip', built.zipPath.endsWith('advisers-' + version + '-win-x64.zip'))
    check('zip sidecar is written', existsSync(built.sidecar))
    check('portable SHA256SUMS file is written', existsSync(built.sumsPath))
    const verified = verifyPortableZip(built.zipPath, { version, smoke: true })
    for (const item of verified.checks) check('verify :: ' + item.name, item.ok)
    check('verify reports no errors', verified.ok, JSON.stringify(verified.errors))

    const secondStage = join(temp, 'stage-2', portableBundleName(version))
    assemblePortableBundle({ appSource: payload.source, asNodeModules: payload.asNodeModules, bundleRoot: secondStage, version })
    const second = writeBundleZip({ bundleRoot: secondStage, outDir: join(temp, 'out-2'), version })
    check('two builds of the same inputs are byte-identical', second.digest === built.digest, built.digest + ' != ' + second.digest)

    const tampered = join(temp, 'tampered.zip')
    const buffer = Buffer.from(readFileSync(built.zipPath))
    for (let index = 0; index < buffer.length - 4; index += 1) {
      if (buffer[index] === 0x50 && buffer[index + 1] === 0x4b && buffer[index + 2] === 0x03 && buffer[index + 3] === 0x04) {
        buffer[index + 20] ^= 0xff
        break
      }
    }
    writeFileSync(tampered, buffer)
    const tamperedResult = verifyPortableZip(tampered, { version })
    check('verify rejects a corrupted artifact', !tamperedResult.ok)

    if (process.platform !== 'win32') {
      // npm creates .bin symlinks on POSIX; the bundle must store regular files.
      const linkSource = join(temp, 'link-app')
      cpSync(appSource, linkSource, { recursive: true })
      writeFileSync(join(linkSource, 'real.txt'), 'payload\n')
      writeFileSync(join(linkSource, 'shared.txt'), 'shared content')
      symlinkSync(join(linkSource, 'shared.txt'), join(linkSource, 'node_modules', 'bin-link'))
      const linkBundle = join(temp, 'stage-link', portableBundleName(version))
      assemblePortableBundle({ appSource: linkSource, bundleRoot: linkBundle, version: '0.4.0-selftest' })
      check('payload symlinks are dereferenced to regular files', lstatSync(join(linkBundle, 'app', 'node_modules', 'bin-link')).isFile())
    }

    const rawNodeModules = join(temp, 'node_modules-payload')
    cpSync(nodeModules, rawNodeModules, { recursive: true, dereference: true })
    const rawResolved = resolvePayload(rawNodeModules)
    check('resolvePayload accepts a node_modules directory', rawResolved.asNodeModules === true)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
  if (failures > 0) {
    process.stderr.write(EOL + 'FAIL pack-portable self-test (' + failures + ' failure(s))' + EOL)
    return 1
  }
  process.stdout.write(EOL + 'PASS pack-portable self-test' + EOL)
  return 0
}

function printHelp() {
  process.stdout.write(
    [
      'pack-portable — build/verify the Advisers Windows x64 portable (offline) bundle',
      '',
      'Usage:',
      '  node scripts/pack-portable.mjs                                  self-test (no args)',
      '  node scripts/pack-portable.mjs --self-test',
      '  node scripts/pack-portable.mjs --payload <dir> [--out-dir artifacts]',
      '  node scripts/pack-portable.mjs --cross-install [--out-dir artifacts]',
      '  node scripts/pack-portable.mjs --verify <zip> [--smoke]',
      '',
      '--payload <dir>      package an already installed app tree (contains',
      '                     node_modules/advisers/bin/advisers.js) or a node_modules tree.',
      '--cross-install      install advisers + advisers-office here (npm --os=win32 --cpu=x64',
      '                     on Linux); requires registry access and is slower.',
      '--version <v>        bundle version (default: packages/advisers/package.json).',
      '--out-dir <dir>      output directory (default: artifacts/, gitignored).',
      '--verify <zip>       verify an existing artifact: ZIP CRC, required files,',
      '                     licenses, payload version/license, native platform, sha256.',
      '--smoke              with --verify: extract and run the bundled CLI (and .cmd on Windows).',
      '--keep               keep the staging directory (sibling of the output).',
      '',
      'Nothing is published. npm remains the official channel; the zip is the offline',
      'channel and must still be attached to a GitHub Release with SHA256SUMS/attestation',
      'by the release operator (docs/RELEASING.md).',
      '',
    ].join(EOL),
  )
}

function main(argv) {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      printHelp()
      return 0
    }
    if (argv.length === 0 || argv.includes('--self-test')) return runSelfTest()

    const version = argValue(argv, '--version') || readJson(join(root, 'packages', 'advisers', 'package.json')).version
    const outDir = resolve(argValue(argv, '--out-dir') || join(root, 'artifacts'))
    const keep = argv.includes('--keep')

    if (argv.includes('--verify')) {
      const zip = argValue(argv, '--verify')
      const result = verifyPortableZip(zip, {
        version,
        expectedSha256: argValue(argv, '--sha256'),
        requireSidecar: true,
        smoke: argv.includes('--smoke'),
      })
      if (!result.ok) {
        for (const error of result.errors) process.stderr.write('FAIL ' + error + EOL)
        return 1
      }
      for (const item of result.checks) pass(item.name)
      pass('verified ' + result.file + ' (' + formatBytes(result.outputBytes) + ', ' + result.entryCount + ' entries, sha256 ' + result.sha256 + ')')
      return 0
    }

    let appSource
    let asNodeModules = false
    let payloadInfo = null
    const tempRoot = mkdtempSync(join(tmpdir(), 'advisers-pack-portable-build-'))
    const bundleRoot = keep ? join(outDir, portableBundleName(version)) : join(tempRoot, portableBundleName(version))
    try {
      if (argv.includes('--payload')) {
        payloadInfo = resolvePayload(argValue(argv, '--payload'))
        appSource = payloadInfo.source
        asNodeModules = payloadInfo.asNodeModules
      } else {
        const appDir = join(tempRoot, 'app')
        installPayload({ version, appDir, registry: argValue(argv, '--registry') || REGISTRY, crossInstall: argv.includes('--cross-install') || process.platform !== 'win32' })
        appSource = appDir
        pass('installed advisers@' + version + ' + advisers-office@' + version + ' into the staging app tree')
      }
      const assembled = assemblePortableBundle({ appSource, asNodeModules, bundleRoot, version })
      pass('assembled ' + assembled.bundleRoot + ' (' + assembled.fileCount + ' files, ' + formatBytes(assembled.bytes) + ', advisers@' + assembled.resolvesPackage.version + ', office=' + (assembled.officeIncluded ? 'yes' : 'no') + ')')
      const built = writeBundleZip({ bundleRoot, outDir, version })
      pass('wrote ' + built.zipPath + ' (' + formatBytes(built.bytes) + ', sha256 ' + built.digest + ')')
      pass('wrote ' + built.sidecar)
      pass('wrote ' + built.sumsPath + ' (add it to the GitHub Release assets; docs/RELEASING.md)')
      const verified = verifyPortableZip(built.zipPath, { version, requireSidecar: true, expectedSha256: built.digest })
      if (!verified.ok) {
        for (const error of verified.errors) process.stderr.write('FAIL ' + error + EOL)
        return 1
      }
      pass('re-read and verified the finished archive (' + verified.entryCount + ' entries, ' + formatBytes(verified.totalBytes) + ' uncompressed)')
      return 0
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
      if (keep) process.stdout.write('INFO bundle directory kept under ' + bundleRoot + EOL)
    }
  } catch (error) {
    return fail(String(error && error.stderr ? String(error.stderr).slice(-600) : error && error.message ? error.message : error))
  }
}

const directInvocation = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false
if (directInvocation) process.exit(main(process.argv.slice(2)))
