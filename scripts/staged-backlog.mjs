#!/usr/bin/env node
/**
 * Staged-publish backlog inspector / cleaner.
 *
 * npm keeps every staged version as a separate record. This script lists the
 * backlog for the Advisers packages and, with --apply, rejects records one by
 * one through the npm CLI. Rejection is a destructive registry operation that
 * requires the npm account owner's 2FA (EOTP); this script never asks for or
 * stores an OTP — it pauses and lets the owner authenticate in their browser.
 *
 * Usage:
 *   node scripts/staged-backlog.mjs                 # list Advisers backlog
 *   node scripts/staged-backlog.mjs --json          # machine-readable
 *   node scripts/staged-backlog.mjs --apply         # reject one by one
 *   node scripts/staged-backlog.mjs --apply --limit 5
 *   node scripts/staged-backlog.mjs --all           # include other packages
 */
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'

const OWN_PACKAGES = ['advisers', 'advisers-core', 'advisers-office', 'advisers-policy-strict', 'advisers-bridge-hermes', 'dsh-advisers']
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}
const registry = flag('registry', 'https://registry.npmjs.org/');
const apply = args.includes('--apply');
const all = args.includes('--all');
const jsonOut = args.includes('--json');
const limit = Number(flag('limit', '0')) || 0;

function listStaged() {
  const res = spawnSync('npm', ['stage', 'list', '--json', '--registry', registry], { encoding: 'utf8', timeout: 180000 });
  if (res.status !== 0) {
    console.error('npm stage list failed (auth?):');
    console.error(String(res.stderr || '').trim().slice(0, 800));
    process.exit(1);
  }
  return JSON.parse(res.stdout);
}

function fmt(rows) {
  return rows.map((r) => [r.createdAt.slice(0, 10), r.packageName, r.version, r.tag, r.id].join('  ')).join('\n');
}

const records = listStaged().filter((r) => all || OWN_PACKAGES.includes(r.packageName));
const totals = {};
for (const r of records) totals[r.packageName] = (totals[r.packageName] || 0) + 1;

if (jsonOut) {
  console.log(JSON.stringify({ registry, packages: all ? 'all' : OWN_PACKAGES, totals, records }, null, 2));
} else {
  console.log('registry: ' + registry);
  console.log('staged records: ' + records.length + (all ? ' (all packages)' : ' (Advisers packages)'));
  for (const [name, count] of Object.entries(totals)) console.log('  ' + name + ': ' + count);
  if (records.length) {
    console.log('');
    console.log(fmt(records));
  }
}

if (!apply) {
  if (records.length) console.log('\nPlan only. Rejection needs the npm account owner 2FA; run with --apply to reject interactively.');
  process.exit(0);
}

if (!process.stdin.isTTY) {
  console.error('--apply needs an interactive terminal (npm 2FA prompt).');
  process.exit(2);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

let rejected = 0;
let skipped = 0;
let failed = 0;
const pending = limit > 0 ? records.slice(0, limit) : records;
for (const rec of pending) {
  console.log('\n[' + (rejected + skipped + failed + 1) + '/' + pending.length + '] ' + rec.packageName + '@' + rec.version + ' (' + rec.id + ')');
  let done = false;
  while (!done) {
    const res = spawnSync('npm', ['stage', 'reject', rec.id, '--registry', registry], { stdio: 'inherit' });
    if (res.status === 0) { rejected += 1; done = true; break; }
    const answer = (await ask('reject needs owner auth (EOTP shown above). After authenticating in the browser, press Enter to retry this id, s to skip, q to quit: ')).trim().toLowerCase();
    if (answer === 'q') { console.log('\nstopped by user'); rl.close(); printSummary(); process.exit(130); }
    if (answer === 's') { skipped += 1; done = true; break; }
  }
}
rl.close();
printSummary();

function printSummary() {
  console.log('\nrejected: ' + rejected + ', skipped: ' + skipped + ', failed: ' + failed + ', remaining in plan: ' + (pending.length - rejected - skipped - failed));
  if (rejected + skipped + failed < records.length) console.log('Re-run the script to continue the remaining backlog.');
}
