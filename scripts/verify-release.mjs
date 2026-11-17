#!/usr/bin/env node
/**
 * Post-approval release verifier for Advisers.
 *
 * Checks the official registry for the expected dist-tag, verifies each
 * tarball against its dist.shasum / dist.integrity, checks license files and
 * the SPDX license field, and optionally installs the published packages into a
 * temp prefix: the CLI gets a version/consent smoke test, and every requested
 * package is dynamically imported from that clean prefix (regression guard for
 * dsh-advisers@0.2.0, whose bundle could not be imported after a clean install).
 *
 * Usage:
 *   node scripts/verify-release.mjs [--version 0.2.0] [--tag latest]
 *        [--registry https://registry.npmjs.org/] [--packages a,b]
 *        [--expected-license PolyForm-Noncommercial-1.0.0]
 *        [--skip-install] [--json]
 *
 * --skip-install skips both network install phases (CLI smoke + per-package
 * import smoke) and keeps the registry metadata/tarball verification.
 *

 * Exit 0 only when every requested package passes every check.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const bool = (name) => args.includes('--' + name)
const version = flag('version', '0.2.0')
const tag = flag('tag', 'latest')
const registry = (flag('registry', 'https://registry.npmjs.org/')).replace(/\/$/, '')
const expectedLicense = flag('expected-license', 'PolyForm-Noncommercial-1.0.0')
const packagesArg = flag('packages', 'advisers,advisers-core,advisers-office,advisers-policy-strict,advisers-bridge-hermes,dsh-advisers')
const packages = packagesArg.split(',').map((s) => s.trim()).filter(Boolean)
const skipInstall = bool('skip-install')
const jsonOut = bool('json')

const checks = [];
const failures = [];
function check(pkg, ok, detail) {
  checks.push({ pkg, ok, detail });
  if (!ok) failures.push(pkg + ': ' + detail);
}
function sha1(buf) { return createHash('sha1').update(buf).digest('hex') }
function sha512(buf) { return createHash('sha512').update(buf).digest('base64') }
function licenseSha() { return createHash('sha256').update(readFileSync(join(root, 'LICENSE'))).digest('hex') }

async function registryJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'advisers-release-verifier' } });
  if (!res.ok) throw new Error('registry HTTP ' + res.status + ' for ' + url);
  return res.json();
}

async function verifyPackage(name, workRoot) {
  let meta;
  try { meta = await registryJson(registry + '/' + encodeURIComponent(name)); }
  catch (error) { check(name, false, 'metadata fetch failed: ' + error.message); return; }
  const published = meta.versions?.[version];
  check(name, Boolean(published), 'version ' + version + ' exists on registry');
  if (!published) return;
  check(name, meta['dist-tags']?.[tag] === version, 'dist-tags.' + tag + ' === ' + version + ' (got ' + (meta['dist-tags']?.[tag] || 'missing') + ')');
  check(name, published.license === expectedLicense, 'license field === ' + expectedLicense + ' (got ' + published.license + ')');
  const dist = published.dist || {};
  const tarballUrl = dist.tarball;
  check(name, Boolean(tarballUrl), 'tarball URL present');
  if (!tarballUrl) return;
  const res = await fetch(tarballUrl, { headers: { 'user-agent': 'advisers-release-verifier' } });
  if (!res.ok) { check(name, false, 'tarball HTTP ' + res.status); return; }
  const buf = Buffer.from(await res.arrayBuffer());
  check(name, sha1(buf) === dist.shasum, 'sha1 matches dist.shasum (' + dist.shasum + ')');
  if (dist.integrity && dist.integrity.startsWith('sha512-')) {
    check(name, dist.integrity === 'sha512-' + sha512(buf), 'sha512 matches dist.integrity');
  }
  const dest = join(workRoot, name.replace(/[^a-z0-9-]/gi, '_'));
  mkdirSync(dest, { recursive: true });
  const tar = spawnSync('tar', ['-xzf', '-', '-C', dest], { input: buf, timeout: 120000 });
  if (tar.status !== 0) { check(name, false, 'tarball extract failed: ' + (tar.stderr || '').slice(0, 200)); return; }
  for (const file of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
    check(name, existsSync(join(dest, 'package', file)), 'tarball contains ' + file);
  }
  const pkgJson = JSON.parse(readFileSync(join(dest, 'package', 'package.json'), 'utf8'));
  check(name, pkgJson.version === version, 'tarball package.json version === ' + version);
  check(name, pkgJson.license === expectedLicense, 'tarball package.json license === ' + expectedLicense);
  if (name === 'advisers') {
    for (const file of ['lib/tos/terms.zh-CN.md', 'lib/tos/summary.zh-CN.md', 'lib/tos/privacy.zh-CN.md', 'lib/tos/safety.zh-CN.md', 'lib/tos/manifest.json']) {
      const p = join(dest, 'package', file);
      check(name, existsSync(p), 'tarball contains ' + file);
    }
  }
  const sha = createHash('sha256').update(readFileSync(join(dest, 'package', 'LICENSE'))).digest('hex');
  check(name, sha === licenseSha(), 'tarball LICENSE matches repo LICENSE');
  return { tarball: tarballUrl, shasum: dist.shasum, integrity: dist.integrity, size: statSync(join(dest, 'package')).size };
}

async function installSmoke(workRoot) {
  const prefix = join(workRoot, 'install');
  const home = join(workRoot, 'home');
  const inst = spawnSync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--registry', registry, 'advisers@' + version], { encoding: 'utf8', timeout: 300000 });
  if (inst.status !== 0) { check('install-smoke', false, 'npm install failed: ' + ((inst.stderr || '') + (inst.stdout || '')).slice(-500)); return; }
  const bin = join(prefix, 'node_modules', 'advisers', 'bin', 'advisers.js');
  const env = { ...process.env, ADVISERS_HOME: home, ADVISERS_ACCEPT_TOS: '1', ADVISERS_NO_MODEL: '1' };
  delete env.NODE_TEST_CONTEXT;
  const run = (argv) => spawnSync(process.execPath, [bin, ...argv], { env, encoding: 'utf8', timeout: 120000 });
  const v = run(['--version']);
  check('install-smoke', v.status === 0 && String(v.stdout).includes(version), 'installed advisers --version === ' + version);
  const tos = run(['tos', 'status', '--json']);
  check('install-smoke', tos.status === 0 && String(tos.stdout).includes('accepted'), 'installed tos status --json works');
  const help = spawnSync(process.execPath, [bin, '--help'], { env, encoding: 'utf8', timeout: 120000 });
  check('install-smoke', help.status === 0 && String(help.stdout).includes('tos'), 'installed help lists the tos command');
}

/**
 * Import every requested package from a clean temp prefix. This is the release
 * guard for bundles that pass metadata/shasum checks but cannot load after a
 * clean install (dsh-advisers@0.2.0 imported a monorepo-relative safety file).
 */
async function importSmoke(workRoot) {
  const prefix = join(workRoot, 'import-smoke');
  mkdirSync(prefix, { recursive: true });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const specifiers = packages.map((name) => name + '@' + version);
  const inst = spawnSync(
    'npm',
    ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--registry', registry, ...specifiers],
    { encoding: 'utf8', timeout: 600000 },
  );
  if (inst.status !== 0) {
    check('import-smoke', false, 'npm install failed: ' + ((inst.stderr || '') + (inst.stdout || '')).slice(-500));
    return;
  }
  for (const name of packages) {
    const probe = [
      'const m = await import(' + JSON.stringify(name) + ');',
      'const keys = Object.keys(m);',
      "if (!keys.length) throw new Error('no named exports');",
      name === 'dsh-advisers'
        ? "if (typeof m.apply !== 'function' || typeof m.version !== 'string') throw new Error('missing apply()/version export');"
        : '',
      'console.log(JSON.stringify({ exports: keys.length }));',
    ].filter(Boolean).join(' ');
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: prefix,
      env,
      encoding: 'utf8',
      timeout: 120000,
    });
    if (run.status === 0) {
      check(name, true, 'import(' + name + ') from a clean temp prefix succeeds ' + String(run.stdout).trim().slice(0, 120));
    } else {
      const detail = String(run.stderr || '').trim().split('\n').slice(-3).join(' | ');
      check(name, false, 'import(' + name + ') failed: ' + detail.slice(0, 500));
    }
  }
}

const workRoot = mkdtempSync(join(tmpdir(), 'advisers-verify-release-'));
let result = {};
try {
  for (const name of packages) result[name] = await verifyPackage(name, workRoot);
  if (!skipInstall) {
    await installSmoke(workRoot);
    await importSmoke(workRoot);
  }
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}

const passed = checks.filter((c) => c.ok).length;
const failed = checks.filter((c) => !c.ok).length;
if (jsonOut) {
  console.log(JSON.stringify({ version, tag, registry, packages, passed, failed, failures, checks }, null, 2));
} else {
  for (const c of checks) console.log((c.ok ? 'PASS' : 'FAIL') + ' ' + c.pkg + ' :: ' + c.detail);
  console.log('');
  for (const [name, info] of Object.entries(result)) if (info) console.log(name, '| shasum', info.shasum, '|', info.tarball);
  console.log('');
  console.log(failed === 0 ? 'PASS release verification: ' + passed + ' checks' : 'FAIL release verification: ' + failed + ' failed / ' + checks.length + ' checks');
}
process.exitCode = failures.length ? 1 : 0;
