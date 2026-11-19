import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { tosEnv } from './tos-fixture.js'
import { downgradeToV19 } from './schema-fixtures.js'
import { SCHEMA_VERSION, SqliteStore, instanceLockPath } from '../lib/sqlite.js'

// 0.2.3 Wave 2b: the CLI read path through openReadStore().
//  - a stale (v19) database is migrated under a short writer lock, then read;
//  - a future schema fails closed with E_SCHEMA_NEWER (never downgrades);
//  - ADVISERS_READ_LOCKFREE=0 falls back to the historical writer-lock path.
const bin = fileURLToPath(new URL('../bin/advisers.js', import.meta.url))
const sqliteLib = fileURLToPath(new URL('../lib/sqlite.js', import.meta.url))
const NOW = '2026-11-01T00:00:00.000Z'
function env(home, extra = {}) {
  return tosEnv(home, {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_STORE: 'sqlite',
    ...extra,
  })
}
function setup(prefix) {
  const root = mkdtempSync(join(tmpdir(), 'advisers-bin-read-' + prefix + '-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home }
}
function cli(home, args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: 'utf8', timeout: 120000 })
}
function cliOk(home, args, extra = {}) {
  const result = cli(home, args, extra)
  assert.equal(result.status, 0, args.join(' ') + ' failed: ' + result.stderr)
  return result
}
function seed(dbPath) {
  const store = new SqliteStore(dbPath)
  try {
    store.mutate(() => {
      store.insertMatter({ id: 'm1', title: '客户', status: 'active', domain: 'general', secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: NOW, updatedAt: NOW })
      store.insertCommitment({ id: 'cm1', matterId: 'm1', debtor: 'user', creditor: '王工', action: '发报价', dueAt: null, timezone: 'Asia/Shanghai', status: 'open', evidence: [], capability: 'none' })
    }, { actor: 'local', action: 'seed', allowed: true, reason: 'seed' })
  } finally { store.close() }
}
function raw(dbPath) {
  const db = new DatabaseSync(dbPath)
  try { return db } catch (error) { db.close(); throw error }
}
function schemaVersion(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try { return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value } finally { db.close() }
}
function writeLockHolder(root) {
  const file = join(root, 'holder.mjs')
  writeFileSync(file, [
    'import { acquireInstanceLock } from ' + JSON.stringify(pathToFileURL(sqliteLib).href),
    "const lock = acquireInstanceLock({ home: process.env.ADVISERS_HOME, command: 'test-holder', timeoutMs: 5000 })",
    "process.stdout.write('held\\n')",
    'setInterval(() => {}, 60000)',
  ].join('\n'))
  return file
}

test('a stale v19 database is migrated under a short writer lock, then read successfully', () => {
  const { root, home } = setup('stale')
  try {
    const dbPath = join(home, 'state.db')
    seed(dbPath)
    downgradeToV19(dbPath)
    assert.equal(schemaVersion(dbPath), '19')
    const today = cliOk(home, ['today'])
    assert.match(today.stdout, /今天：/)
    assert.equal(schemaVersion(dbPath), String(SCHEMA_VERSION), 'the read path must finish the migration it found')
    assert.equal(existsSync(instanceLockPath(home)), false, 'the short maintenance lock must be released')
    assert.ok(readdirSync(home).some((name) => name.includes('before-migrate')), 'the migration keeps its verified backup')
    // Subsequent reads take the fast lock-free path.
    assert.match(cliOk(home, ['who', '--json']).stdout, /"mine"/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a newer schema fails closed with E_SCHEMA_NEWER and is never downgraded by a read command', () => {
  const { root, home } = setup('newer')
  try {
    const dbPath = join(home, 'state.db')
    seed(dbPath)
    const db = new DatabaseSync(dbPath)
    try { db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1)) } finally { db.close() }
    const result = cli(home, ['today'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /newer than this CLI/)
    assert.equal(schemaVersion(dbPath), String(SCHEMA_VERSION + 1), 'a read command must never touch a newer schema')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('ADVISERS_READ_LOCKFREE=0 falls back to the writer-lock read path', async () => {
  const { root, home } = setup('killswitch')
  const holderScript = writeLockHolder(root)
  try {
    cliOk(home, ['commit', 'add', 'seed', '--quote', 'q'])
    const holder = spawn(process.execPath, [holderScript], { env: env(home), stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('lock holder did not start')), 10000)
        holder.stdout.on('data', (chunk) => { if (String(chunk).includes('held')) { clearTimeout(timer); resolve() } })
      })
      // Default: lock-free read works while the lock is held.
      const lockfree = cli(home, ['today'])
      assert.equal(lockfree.status, 0, 'default read path must be lock-free: ' + lockfree.stderr)
      // Kill switch: the read falls back to the 0.2.2 writer path and fails closed.
      const legacy = cli(home, ['today'], { ADVISERS_READ_LOCKFREE: '0', ADVISERS_LOCK_TIMEOUT_MS: '150' })
      assert.equal(legacy.status, 1, 'the kill switch must restore the writer-lock behaviour')
      assert.match(legacy.stderr, /E_DB_LOCKED/)
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
      if (holder.exitCode === null && holder.signalCode === null) await new Promise((resolve) => holder.once('close', resolve))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})