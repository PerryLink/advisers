#!/usr/bin/env node
/**
 * Fault-injection suite for Advisers 0.2.3 (Wave 4a).
 *
 * Runs the real CLI (bin/advisers.js) against temporary ADVISERS_HOME
 * directories and injects realistic failures, then asserts the ledger is never
 * left corrupt or misleading:
 *
 *   - crash     : SIGKILL a commit add while its write transaction is open
 *                 (before COMMIT) and right after COMMIT (before checkpoint);
 *   - migration : SIGKILL a schema v19 -> v21 migration mid-transaction, and
 *                 inject a migration-step error; both must roll back, leave a
 *                 verifiable pre-migration backup, and retry cleanly;
 *   - WAL       : corrupt (zeroed header) and truncated (torn frame) WAL files
 *                 must be detected, preserved as evidence, and must not take the
 *                 database or audit chain down with them;
 *   - FTS       : a desynchronised FTS index must be detected by
 *                 doctor --check-db and search must fall back to LIKE instead of
 *                 silently dropping hits;
 *   - ENOSPC    : a filesystem stub that fails temp-file writes and backup
 *                 copies with ENOSPC must fail cleanly (no truncated artifact,
 *                 no partial backup, database intact). Where unprivileged user
 *                 namespaces are available, a real 2 MiB tmpfs is filled and
 *                 the same invariants are checked against a full disk.
 *
 * Determinism: crash points are not sleep-based. A small preload
 * (--require, generated in the temp dir) wraps node:sqlite's
 * DatabaseSync.exec: at the requested transaction it writes a marker file and
 * blocks. The suite polls the marker (no racing) and only then sends SIGKILL,
 * so the fault point is hit deterministically. Migration points are injected
 * the same way by matching the v20 index SQL.
 *
 * No root, no network, no dependency on the test framework.
 *
 * Usage
 *   pnpm -r --if-present run build      # once: the CLI needs local dist/ fallbacks
 *   node scripts/fault-injection.mjs    # [--keep] [--verbose]
 *
 * Exit codes
 *   0 = every case PASSed (SKIPs are allowed and always reported)
 *   1 = at least one case FAILed
 *   2 = the suite could not run (missing build, CLI baseline broken, no node:sqlite)
 *
 * Platform: crash, ENOSPC-stub and tmpfs cases are Linux-oriented (SIGKILL
 * semantics, /proc/self/fd, unshare user namespaces); elsewhere they SKIP.
 * docs/FAULT-INJECTION.md lists every case and limitation.
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const VERBOSE = argv.includes('--verbose')
const root = fileURLToPath(new URL('..', import.meta.url))
const bin = join(root, 'packages/advisers/bin/advisers.js')
const IS_LINUX = process.platform === 'linux'
const HAS_PROCFD = IS_LINUX && existsSync('/proc/self/fd')
const startedAt = Date.now()

const tempRoot = mkdtempSync(join(tmpdir(), 'advisers-fault-injection-'))
const PRELOAD_SQLITE = join(tempRoot, 'fi-sqlite.cjs')
const PRELOAD_FS = join(tempRoot, 'fi-fs.cjs')
const WAL_WRITER = join(tempRoot, 'wal-writer.mjs')
const TMPFS_INNER = join(tempRoot, 'tmpfs-inner.sh')
const TMPFS_SCRIPT = Buffer.from('IyEvYmluL2Jhc2gKc2V0IC11Cndvcms9JChta3RlbXAgLWQgL3RtcC9hZHYtZmktdG1wZnMtWFhYWFhYKSB8fCB7IGVjaG8gU0VUVVBfRkFJTDsgZXhpdCAxMDsgfQppZiAhIG1vdW50IC10IHRtcGZzIC1vIHNpemU9Mm0gdG1wZnMgIiR3b3JrIjsgdGhlbiBlY2hvIFNFVFVQX0ZBSUw7IGV4aXQgMTA7IGZpCmNsZWFudXAoKSB7IHVtb3VudCAiJHdvcmsiIDI+L2Rldi9udWxsIHx8IHRydWU7IHJtZGlyICIkd29yayIgMj4vZGV2L251bGwgfHwgdHJ1ZTsgfQp0cmFwIGNsZWFudXAgRVhJVApleHBvcnQgQURWSVNFUlNfSE9NRT0iJHdvcmsvaG9tZSIgQURWSVNFUlNfU1RPUkU9c3FsaXRlIEFEVklTRVJTX0NPUkVfTE9DQUw9MSBBRFZJU0VSU19PRkZJQ0VfTE9DQUw9MSBBRFZJU0VSU19OT19NT0RFTD0xIEFEVklTRVJTX0FDQ0VQVF9UT1M9MQoiJEZJX05PREUiICIkRklfQklOIiBpbml0ID4vZGV2L251bGwgMj4mMSB8fCB7IGVjaG8gSU5JVF9GQUlMOyBleGl0IDE7IH0KIiRGSV9OT0RFIiAiJEZJX0JJTiIgY29tbWl0IGFkZCAidG1wZnMgc2VlZCIgLS1xdW90ZSBzZWVkID4vZGV2L251bGwgMj4mMSB8fCB7IGVjaG8gU0VFRF9GQUlMOyBleGl0IDE7IH0KZGQgaWY9L2Rldi96ZXJvIG9mPSIkd29yay9maWxsZXIiIGJzPTQwOTYgY291bnQ9MTAwMDAgMj4vZGV2L251bGwKWyAtcyAiJHdvcmsvZmlsbGVyIiBdIHx8IHsgZWNobyBGSUxMX0ZBSUw7IGV4aXQgMTsgfQp0cnVuY2F0ZSAtcyAtODE5MiAiJHdvcmsvZmlsbGVyIiB8fCB7IGVjaG8gRlJFRV84S19GQUlMOyBleGl0IDE7IH0Kb3V0PSQoIiRGSV9OT0RFIiAiJEZJX0JJTiIgY29tbWl0IGFkZCAidG1wZnMgZW5vc3BjIGF0dGVtcHQiIC0tcXVvdGUgcSAyPiYxKQpyYz0kPwppZiBbICIkcmMiIC1lcSAwIF07IHRoZW4KICBlY2hvICJVTkVYUEVDVEVEX1NVQ0NFU1MgKGEgY29tbWl0IHN1Y2NlZWRlZCB3aXRoIDggS2lCIGZyZWUpIgogIGV4aXQgMQpmaQplY2hvICJSRUZVU0VEIHJjPSRyYzogJChwcmludGYgJyVzJyAiJG91dCIgfCBoZWFkIC0xKSIKZnVsbD0kKHN0YXQgLWMgJXMgIiR3b3JrL2ZpbGxlciIpCmZyZWVfdGFyZ2V0PSQoKCBmdWxsID4gMjYyMTQ0ID8gZnVsbCAtIDI2MjE0NCA6IDAgKSkKdHJ1bmNhdGUgLXMgIiRmcmVlX3RhcmdldCIgIiR3b3JrL2ZpbGxlciIgfHwgeyBlY2hvIEZSRUVfMjU2S19GQUlMOyBleGl0IDE7IH0KIiRGSV9OT0RFIiAtZSAnY29uc3Qge0RhdGFiYXNlU3luY309cmVxdWlyZSgibm9kZTpzcWxpdGUiKTsgY29uc3QgZGI9bmV3IERhdGFiYXNlU3luYyhwcm9jZXNzLmVudi5BRFZJU0VSU19IT01FKyIvc3RhdGUuZGIiLHtyZWFkT25seTp0cnVlfSk7IGNvbnN0IHE9ZGIucHJlcGFyZSgiUFJBR01BIHF1aWNrX2NoZWNrIikuZ2V0KCkucXVpY2tfY2hlY2s7IGNvbnN0IG49ZGIucHJlcGFyZSgiU0VMRUNUIENPVU5UKCopIEFTIG4gRlJPTSBjb21taXRtZW50cyIpLmdldCgpLm47IGNvbnN0IGJhZD1kYi5wcmVwYXJlKCJTRUxFQ1QgQ09VTlQoKikgQVMgbiBGUk9NIGNvbW1pdG1lbnRzIFdIRVJFIGFjdGlvbj0/IikuZ2V0KCJ0bXBmcyBlbm9zcGMgYXR0ZW1wdCIpLm47IGRiLmNsb3NlKCk7IGlmKHEhPT0ib2siKXtjb25zb2xlLmVycm9yKCJxdWlja19jaGVjaz0iK3EpO3Byb2Nlc3MuZXhpdCgxKX0gaWYobiE9PTEpe2NvbnNvbGUuZXJyb3IoImNvbW1pdG1lbnRzPSIrbik7cHJvY2Vzcy5leGl0KDEpfSBpZihiYWQhPT0wKXtjb25zb2xlLmVycm9yKCJyZWZ1c2VkIGNvbW1pdCBsZWZ0IGEgcm93Iik7cHJvY2Vzcy5leGl0KDEpfSBjb25zb2xlLmxvZygiYWZ0ZXItZmFpbHVyZSBxdWlja19jaGVjaz1vayBjb21taXRtZW50cz0xIHJlZnVzZWQtcm93PWFic2VudCIpJyB8fCB7IGVjaG8gVkVSSUZZX0ZBSUxFRF9TVEFURV9GQUlMOyBleGl0IDE7IH0KIiRGSV9OT0RFIiAiJEZJX0JJTiIgY29tbWl0IGFkZCAidG1wZnMgcmV0cnkiIC0tcXVvdGUgcSA+L2Rldi9udWxsIDI+JjEgfHwgeyBlY2hvIFJFVFJZX0ZBSUw7IGV4aXQgMTsgfQoiJEZJX05PREUiIC1lICdjb25zdCB7RGF0YWJhc2VTeW5jfT1yZXF1aXJlKCJub2RlOnNxbGl0ZSIpOyBjb25zdCBkYj1uZXcgRGF0YWJhc2VTeW5jKHByb2Nlc3MuZW52LkFEVklTRVJTX0hPTUUrIi9zdGF0ZS5kYiIse3JlYWRPbmx5OnRydWV9KTsgY29uc3QgcT1kYi5wcmVwYXJlKCJQUkFHTUEgcXVpY2tfY2hlY2siKS5nZXQoKS5xdWlja19jaGVjazsgY29uc3Qgbj1kYi5wcmVwYXJlKCJTRUxFQ1QgQ09VTlQoKikgQVMgbiBGUk9NIGNvbW1pdG1lbnRzIikuZ2V0KCkubjsgZGIuY2xvc2UoKTsgaWYocSE9PSJvayIpe2NvbnNvbGUuZXJyb3IoInF1aWNrX2NoZWNrPSIrcSk7cHJvY2Vzcy5leGl0KDEpfSBpZihuIT09Mil7Y29uc29sZS5lcnJvcigiY29tbWl0bWVudHM9IituKTtwcm9jZXNzLmV4aXQoMSl9IGNvbnNvbGUubG9nKCJyZXRyeSBxdWlja19jaGVjaz1vayBjb21taXRtZW50cz0yIiknIHx8IHsgZWNobyBWRVJJRllfUkVUUllfRkFJTDsgZXhpdCAxOyB9CiIkRklfTk9ERSIgIiRGSV9CSU4iIGF1ZGl0ID4iJHdvcmsvYXVkaXQudHh0IiAyPiYxIHx8IHsgZWNobyBBVURJVF9GQUlMOyBleGl0IDE7IH0KZ3JlcCAtcSAiYXVkaXQ6IHZlcmlmaWVkIiAiJHdvcmsvYXVkaXQudHh0IiB8fCB7IGVjaG8gQVVESVRfTk9UX1ZFUklGSUVEOyBleGl0IDE7IH0KZWNobyBUTVBGU19FTk9TUENfT0sK', 'base64').toString('utf8')
const results = []

class Skip extends Error {}

function record(status, id, detail = '') {
  results.push({ status, id, detail })
  console.log(status.padEnd(5) + ' ' + id + (detail ? '  ' + detail : ''))
}

function check(condition, message) {
  if (!condition) throw new Error(message)
}

function skip(reason) {
  throw new Skip(reason)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function runCase(id, fn) {
  try {
    const detail = await fn()
    record('PASS', id, detail ?? '')
  } catch (error) {
    if (error instanceof Skip) record('SKIP', id, error.message)
    else {
      record('FAIL', id, String(error.message ?? error))
      if (VERBOSE && error.stack) console.error(error.stack)
    }
  }
}

// ---------------------------------------------------------------------------
// Preloads and helper scripts (generated into the temp root; not committed).
// ---------------------------------------------------------------------------

const SQLITE_PRELOAD = [
  "const { writeFileSync } = require('node:fs')",
  'const marker = process.env.ADVISERS_FI_MARKER',
  "const mode = process.env.ADVISERS_FI_SQLITE || ''",
  'function block() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000) }',
  'if (mode) {',
  "  const DatabaseSync = require('node:sqlite').DatabaseSync",
  '  const origExec = DatabaseSync.prototype.exec',
  '  let tx = 0',
  '  DatabaseSync.prototype.exec = function (sql, ...rest) {',
  '    const text = String(sql)',
  "    const targetTx = Number(process.env.ADVISERS_FI_TX || '0')",
  "    if (/^\\s*BEGIN\\s+IMMEDIATE/i.test(text)) {",
  '      tx += 1',
  "      if (mode === 'after-begin' && tx === targetTx) {",
  '        origExec.call(this, sql, ...rest)',
  "        writeFileSync(marker, 'after-begin-tx' + tx)",
  '        block()',
  '        return',
  '      }',
  '      return origExec.call(this, sql, ...rest)',
  '    }',
  "    if (mode === 'after-commit' && /^\\s*COMMIT\\s*$/i.test(text)) {",
  '      const isTarget = tx === targetTx',
  '      const result = origExec.call(this, sql, ...rest)',
  "      if (isTarget) { writeFileSync(marker, 'after-commit-tx' + tx); block() }",
  '      return result',
  '    }',
  "    if (mode === 'kill-at-migration' && /idx_turns_seq/.test(text)) {",
  "      writeFileSync(marker, 'kill-at-migration')",
  '      block()',
  '      return',
  '    }',
  "    if (mode === 'migration-fail' && /idx_turns_seq/.test(text)) {",
  "      writeFileSync(marker, 'migration-fail')",
  "      throw new Error('injected migration step failure (fault-injection suite)')",
  '    }',
  '    return origExec.call(this, sql, ...rest)',
  '  }',
  '}',
  '',
].join('\n')

const FS_PRELOAD = [
  "const fs = require('node:fs')",
  "const mode = process.env.ADVISERS_FI_FS || ''",
  'function enospc(what) {',
  "  const error = new Error('ENOSPC: no space left on device, ' + what)",
  "  error.code = 'ENOSPC'",
  '  error.errno = -28',
  '  return error',
  '}',
  "if (mode === 'temp-enospc') {",
  '  const orig = fs.writeSync',
  '  fs.writeSync = function (fd, buffer, offset, length) {',
  "    let target = ''",
  "    try { target = fs.readlinkSync('/proc/self/fd/' + fd) } catch {}",
  "    if (String(target).includes('.tmp-') || String(target).includes('.unseal-')) throw enospc('write')",
  '    return orig.apply(fs, arguments)',
  '  }',
  "  require('module').syncBuiltinESMExports()",
  "} else if (mode === 'copy-enospc') {",
  '  const orig = fs.copyFileSync',
  "  const marker = process.env.ADVISERS_FI_COPY_MARK || 'fi-enospc-target'",
  '  fs.copyFileSync = function (src, dest) {',
  "    if (String(dest).includes(marker)) throw enospc('copyfile')",
  '    return orig.apply(fs, arguments)',
  '  }',
  "  require('module').syncBuiltinESMExports()",
  '}',
  '',
].join('\n')

const WAL_WRITER_SOURCE = [
  "import { DatabaseSync } from 'node:sqlite'",
  'const db = new DatabaseSync(process.env.FI_DB)',
  "db.exec('PRAGMA journal_mode = WAL')",
  "db.exec('BEGIN IMMEDIATE')",
  'db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(\'fi_wal\',\'committed\')").run()',
  "db.exec('COMMIT')",
  "if (process.platform === 'win32') process.abort()",
  "else process.kill(process.pid, 'SIGKILL')",
  '',
].join('\n')

// ---------------------------------------------------------------------------
// CLI helpers.
// ---------------------------------------------------------------------------

function cliEnv(home, extra = {}) {
  return {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_STORE: 'sqlite',
    ADVISERS_CORE_LOCAL: '1',
    ADVISERS_OFFICE_LOCAL: '1',
    ADVISERS_NO_MODEL: '1',
    ADVISERS_ACCEPT_TOS: '1',
    ...extra,
  }
}

function cli(home, cliArgs, extra = {}) {
  return spawnSync(process.execPath, [bin, ...cliArgs], {
    cwd: tempRoot,
    env: cliEnv(home, extra),
    encoding: 'utf8',
    timeout: 120000,
  })
}

function mustCli(home, cliArgs, extra = {}) {
  const result = cli(home, cliArgs, extra)
  const output = String((result.stderr || '') + (result.stdout || '')).trim().slice(0, 500)
  check(result.status === 0, 'advisers ' + cliArgs.join(' ') + ' exited ' + result.status + (output ? ': ' + output : ''))
  return result
}

function makeHome(label) {
  const home = join(tempRoot, label)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mustCli(home, ['init'])
  return home
}

function seededHome(label, text) {
  const home = makeHome(label)
  mustCli(home, ['commit', 'add', text, '--quote', text])
  return home
}

function commitmentRows(home) {
  const result = mustCli(home, ['commit', 'ls', '--json'])
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error('commit ls --json did not print JSON: ' + String(result.stdout).slice(0, 200))
  }
}

function auditCount(home) {
  const result = mustCli(home, ['audit'])
  const match = /audit: verified \((\d+) entries\)/.exec(result.stdout)
  check(Boolean(match), 'audit chain is not verified: ' + String(result.stdout).replace(/\n/g, ' | ').slice(0, 300))
  return Number(match[1])
}

function doctorCheckDb(home) {
  return cli(home, ['doctor', '--check-db'])
}

function files(home) {
  return readdirSync(home)
}

function inspectDb(home, fn) {
  const db = new DatabaseSync(join(home, 'state.db'))
  try {
    return fn(db)
  } finally {
    try { db.close() } catch {}
  }
}

function quickCheck(home) {
  return inspectDb(home, (db) => String(db.prepare('PRAGMA quick_check').get()?.quick_check ?? 'unknown'))
}

function schemaVersion(home) {
  return inspectDb(home, (db) => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    return row ? Number(row.value) : null
  })
}

function hasTable(home, name) {
  return inspectDb(home, (db) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)))
}

function commitmentCountRaw(home) {
  return inspectDb(home, (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM commitments').get()?.n ?? 0))
}

function checkDoctorOk(home, context) {
  const doctor = doctorCheckDb(home)
  check(doctor.status === 0, context + ': doctor --check-db exited ' + doctor.status + ': ' + String(doctor.stdout + doctor.stderr).replace(/\n/g, ' | ').slice(0, 600))
  check(!/^FAIL /m.test(String(doctor.stdout)), context + ': doctor reported FAIL checks: ' + String(doctor.stdout).replace(/\n/g, ' | ').slice(0, 400))
}

function checkNoCorruptFiles(home, context) {
  const corrupt = files(home).filter((name) => name.includes('.corrupt-'))
  check(corrupt.length === 0, context + ': unexpected corrupt-file quarantine: ' + corrupt.join(', '))
}

async function killAtMarker(home, cliArgs, options = {}) {
  const mode = options.mode
  const tx = options.tx ?? 0
  const timeoutMs = options.timeoutMs ?? 30000
  const marker = join(tempRoot, 'marker-' + Math.random().toString(36).slice(2))
  const env = cliEnv(home, {
    ADVISERS_FI_SQLITE: mode,
    ADVISERS_FI_MARKER: marker,
    ...(tx ? { ADVISERS_FI_TX: String(tx) } : {}),
    NODE_OPTIONS: '--require ' + PRELOAD_SQLITE,
  })
  const child = spawn(process.execPath, [bin, ...cliArgs], { cwd: tempRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const closed = new Promise((resolve) => child.on('close', () => resolve()))
  const deadline = Date.now() + timeoutMs
  let fired = false
  while (Date.now() < deadline) {
    if (existsSync(marker)) { fired = true; break }
    if (child.exitCode !== null || child.signalCode !== null) break
    await sleep(20)
  }
  const wasRunning = child.exitCode === null && child.signalCode === null
  if (wasRunning) child.kill('SIGKILL')
  await closed
  return {
    fired,
    killed: wasRunning,
    exitCode: child.exitCode,
    signal: child.signalCode,
    marker: existsSync(marker) ? readFileSync(marker, 'utf8') : null,
    stdout,
    stderr,
  }
}

/** Turn the current v20 fixture into the pre-migration v19 shape. */
function downgradeToV19(home) {
  inspectDb(home, (db) => {
    db.exec('DROP TABLE IF EXISTS schema_migrations')
    db.exec('DROP INDEX IF EXISTS idx_turns_seq')
    db.exec('DROP INDEX IF EXISTS idx_facts_identity')
    db.exec('DROP INDEX IF EXISTS idx_memory_candidates_status')
    db.prepare("UPDATE meta SET value = '19' WHERE key = 'schema_version'").run()
  })
  check(schemaVersion(home) === 19, 'fixture downgrade to v19 failed')
}

function migrationBackups(home) {
  return files(home).filter((name) => /^state\.db\.before-migrate-v19-\d+$/.test(name)).sort()
}

function verifyMigrationBackup(home, backupName, expectedRows) {
  const db = new DatabaseSync(join(home, backupName), { readOnly: true })
  try {
    const quick = String(db.prepare('PRAGMA quick_check').get()?.quick_check ?? 'unknown')
    const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? -1)
    const rows = Number(db.prepare('SELECT COUNT(*) AS n FROM commitments').get()?.n ?? -1)
    check(quick === 'ok', 'migration backup quick_check is ' + quick)
    check(version === 19, 'migration backup schema_version is ' + version + ', expected 19')
    check(rows === expectedRows, 'migration backup has ' + rows + ' commitment(s), expected ' + expectedRows)
  } finally {
    try { db.close() } catch {}
  }
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

async function crashBeforeCommit() {
  const home = seededHome('crash-uncommitted', '基准承诺')
  const beforeRows = commitmentRows(home)
  const beforeAudit = auditCount(home)
  const killed = await killAtMarker(home, ['commit', 'add', '事务中崩溃的承诺', '--quote', 'q'], { mode: 'after-begin', tx: 2 })
  check(killed.fired, 'fault point after BEGIN (transaction #2) was never reached; the commit write path may have changed')
  check(killed.killed && killed.signal === 'SIGKILL', 'the process was not killed at the fault point: ' + JSON.stringify({ code: killed.exitCode, signal: killed.signal }))
  check(killed.marker === 'after-begin-tx2', 'unexpected fault marker: ' + String(killed.marker))

  const quick = quickCheck(home)
  check(quick === 'ok', 'quick_check after an uncommitted crash is ' + quick)
  const rows = commitmentRows(home)
  check(rows.length === beforeRows.length, 'uncommitted transaction left ' + (rows.length - beforeRows.length) + ' row(s) behind')
  check(!rows.some((row) => row.action === '事务中崩溃的承诺'), 'the uncommitted commitment became visible')
  const afterAudit = auditCount(home)
  check(afterAudit === beforeAudit, 'audit chain changed by an uncommitted transaction: ' + beforeAudit + ' -> ' + afterAudit)
  checkDoctorOk(home, 'after uncommitted crash')
  checkNoCorruptFiles(home, 'after uncommitted crash')

  mustCli(home, ['commit', 'add', '崩溃后恢复写入', '--quote', 'q'])
  check(commitmentRows(home).length === beforeRows.length + 1, 'a write after the crashed transaction did not commit')
  return 'SIGKILL after BEGIN (tx #2) before COMMIT: ' + rows.length + ' rows, audit ' + afterAudit + ', doctor --check-db ok, next write commits'
}

async function crashAfterCommit() {
  const home = seededHome('crash-committed', '基准承诺')
  const beforeRows = commitmentRows(home)
  const beforeAudit = auditCount(home)
  const killed = await killAtMarker(home, ['commit', 'add', '提交后崩溃的承诺', '--quote', 'q'], { mode: 'after-commit', tx: 2 })
  check(killed.fired, 'fault point after COMMIT (transaction #2) was never reached; the commit write path may have changed')
  check(killed.killed && killed.signal === 'SIGKILL', 'the process was not killed at the fault point: ' + JSON.stringify({ code: killed.exitCode, signal: killed.signal }))
  check(killed.marker === 'after-commit-tx2', 'unexpected fault marker: ' + String(killed.marker))

  const quick = quickCheck(home)
  check(quick === 'ok', 'quick_check after a post-COMMIT crash is ' + quick)
  const rows = commitmentRows(home)
  check(rows.length === beforeRows.length + 1, 'committed write was lost: ' + beforeRows.length + ' -> ' + rows.length + ' row(s)')
  check(rows.some((row) => row.action === '提交后崩溃的承诺'), 'the committed commitment is missing after WAL recovery')
  const afterAudit = auditCount(home)
  check(afterAudit === beforeAudit + 1, 'audit row for the committed write is missing: ' + beforeAudit + ' -> ' + afterAudit)
  checkDoctorOk(home, 'after post-COMMIT crash')
  checkNoCorruptFiles(home, 'after post-COMMIT crash')
  return 'SIGKILL after COMMIT before checkpoint: ' + rows.length + ' rows, audit ' + afterAudit + ', doctor --check-db ok'
}

async function migrationInterrupted() {
  const home = seededHome('migration-interrupted', '迁移前承诺')
  const beforeRows = commitmentRows(home)
  downgradeToV19(home)
  const killed = await killAtMarker(home, ['status'], { mode: 'kill-at-migration' })
  check(killed.fired, 'migration fault point was never reached (v20 step did not run)')
  check(killed.killed && killed.signal === 'SIGKILL', 'the process was not killed at the migration fault point: ' + JSON.stringify({ code: killed.exitCode, signal: killed.signal }))

  // inspectDb opens the database read-write, which lets SQLite roll back the
  // killed transaction without running the CLI migration logic.
  check(schemaVersion(home) === 19, 'interrupted migration changed schema_version (expected rollback to 19)')
  check(quickCheck(home) === 'ok', 'quick_check after an interrupted migration is not ok')
  check(!hasTable(home, 'schema_migrations'), 'interrupted migration left its migration ledger table behind (no rollback)')
  check(commitmentCountRaw(home) === beforeRows.length, 'interrupted migration changed the commitment rows')
  const backups = migrationBackups(home)
  check(backups.length === 1, 'expected exactly one pre-migration backup, found ' + backups.length + ': ' + backups.join(', '))
  verifyMigrationBackup(home, backups[0], beforeRows.length)

  mustCli(home, ['status'])
  check(schemaVersion(home) === 21, 'retry did not migrate to schema 21')
  check(hasTable(home, 'schema_migrations'), 'retry did not create the migration ledger')
  check(commitmentRows(home).length === beforeRows.length, 'retry lost commitment rows')
  return 'SIGKILL inside the v19->v20 migration transaction: schema stayed 19, rollback clean, verified backup, retry migrated to 20'
}

async function migrationFailureRollback() {
  const home = seededHome('migration-failure', '迁移前承诺')
  const beforeRows = commitmentRows(home)
  downgradeToV19(home)
  const marker = join(tempRoot, 'migration-fail-marker')
  const result = cli(home, ['status'], {
    ADVISERS_FI_SQLITE: 'migration-fail',
    ADVISERS_FI_MARKER: marker,
    NODE_OPTIONS: '--require ' + PRELOAD_SQLITE,
  })
  check(existsSync(marker), 'migration failure injection point was never reached')
  check(result.status !== 0, 'a failed migration step did not fail the command')
  check(/injected migration step failure/.test(String(result.stderr)), 'the injected migration error was not surfaced: ' + String(result.stderr).slice(0, 300))

  check(schemaVersion(home) === 19, 'failed migration changed schema_version (expected rollback to 19)')
  check(quickCheck(home) === 'ok', 'quick_check after a failed migration is not ok')
  check(commitmentCountRaw(home) === beforeRows.length, 'failed migration changed the commitment rows')
  const backups = migrationBackups(home)
  check(backups.length === 1, 'expected exactly one pre-migration backup, found ' + backups.length)
  verifyMigrationBackup(home, backups[0], beforeRows.length)

  mustCli(home, ['status'])
  check(schemaVersion(home) === 21, 'retry after a failed migration did not reach schema 21')
  check(commitmentRows(home).length === beforeRows.length, 'retry after a failed migration lost commitment rows')
  return 'injected v20 step error rolled back (schema 19, verified backup); retry migrated to 20 with rows intact'
}

async function makeCommittedWalHome(label) {
  const home = seededHome(label, 'WAL 前承诺')
  const writer = spawnSync(process.execPath, [WAL_WRITER], {
    env: { ...process.env, FI_DB: join(home, 'state.db') },
    encoding: 'utf8',
    timeout: 60000,
  })
  check(writer.signal === 'SIGKILL' || writer.status !== 0, 'WAL writer exited cleanly instead of crashing')
  const wal = join(home, 'state.db-wal')
  check(existsSync(wal) && statSync(wal).size > 32, 'no non-empty WAL was left by the crashed writer')
  return home
}

function cloneHome(source, label) {
  const target = join(tempRoot, label)
  cpSync(source, target, { recursive: true })
  return target
}

async function walInvalidHeader() {
  const base = await makeCommittedWalHome('wal-base-invalid')
  const home = cloneHome(base, 'wal-invalid')
  const walPath = join(home, 'state.db-wal')
  const original = readFileSync(walPath)
  const corrupt = Buffer.alloc(original.length, 0)
  writeFileSync(walPath, corrupt)

  const result = cli(home, ['commit', 'ls', '--json'])
  check(result.status === 0, 'a corrupted WAL made a read command fail: ' + String(result.stderr + result.stdout).slice(0, 400))
  check(/E_WAL_CORRUPT/.test(String(result.stderr)), 'expected an E_WAL_CORRUPT warning, got: ' + String(result.stderr).slice(0, 400))
  // 0.2.3 read path is lock-free/read-only: it must warn but must not modify the WAL.
  check(files(home).filter((name) => name.includes('-wal.corrupt-')).length === 0, 'read-only command modified the WAL evidence')
  check(existsSync(walPath), 'read-only command moved the WAL aside')
  // A writable maintenance command performs the preservation/quarantine.
  const doctor = doctorCheckDb(home)
  check(doctor.status !== 0, 'the maintenance pass did not report the data-loss risk of a corrupt WAL')
  check(/FAIL\s+db-wal/.test(String(doctor.stdout)), 'doctor did not report FAIL db-wal: ' + String(doctor.stdout).slice(0, 500))
  const backups = files(home).filter((name) => name.includes('-wal.corrupt-'))
  check(backups.length === 1, 'expected exactly one preserved WAL copy, found ' + backups.length)
  check(readFileSync(join(home, backups[0])).equals(corrupt), 'the preserved WAL copy differs from the corrupt input bytes')
  // Depending on the bundled SQLite version, opening the recovered database can
  // immediately create a fresh empty WAL. Accept absent OR a new small valid
  // sidecar, but never the original invalid bytes.
  if (existsSync(walPath)) {
    check(statSync(walPath).size < corrupt.length, 'the unusable WAL was left in place by the writable maintenance command')
    check(!readFileSync(walPath).equals(corrupt), 'the invalid WAL bytes were left in place')
  }
  check(commitmentRows(home).length === 1, 'the main database lost its commitment row')
  checkDoctorOk(home, 'after quarantining an invalid WAL')
  auditCount(home)
  return 'zeroed WAL header: read-only path warned E_WAL_CORRUPT without touching it; doctor --check-db preserved the bytes as ' + backups[0] + ' and quarantined the WAL; DB/audit verified'
}

async function walTruncated() {
  const base = await makeCommittedWalHome('wal-base-truncated')
  const home = cloneHome(base, 'wal-truncated')
  const walPath = join(home, 'state.db-wal')
  const wal = readFileSync(walPath)
  const pageSize = wal.readUInt32BE(8)
  const frameSize = 24 + pageSize
  const truncatedSize = 32 + frameSize + 100
  check(truncatedSize < wal.length, 'WAL fixture is too small to truncate meaningfully (' + wal.length + ' bytes)')
  truncateSync(walPath, truncatedSize)

  const result = cli(home, ['commit', 'ls', '--json'])
  check(result.status === 0, 'a truncated WAL made a read command fail: ' + String(result.stderr + result.stdout).slice(0, 400))
  check(/E_WAL_TRUNCATED/.test(String(result.stderr)), 'expected an E_WAL_TRUNCATED warning, got: ' + String(result.stderr).slice(0, 400))
  check(files(home).filter((name) => name.includes('-wal.corrupt-')).length === 0, 'read-only command modified the torn WAL')
  const doctor = doctorCheckDb(home)
  check(doctor.status !== 0, 'the maintenance pass did not report the data-loss risk of a torn WAL')
  check(/FAIL\s+db-wal/.test(String(doctor.stdout)), 'doctor did not report FAIL db-wal: ' + String(doctor.stdout).slice(0, 500))
  const backups = files(home).filter((name) => name.includes('-wal.corrupt-'))
  check(backups.length === 1, 'expected exactly one preserved WAL copy, found ' + backups.length)
  check(statSync(join(home, backups[0])).size === truncatedSize, 'preserved WAL copy has the wrong size')
  check(commitmentRows(home).length === 1, 'the main database lost its commitment row')
  checkDoctorOk(home, 'after recovering a truncated WAL')
  auditCount(home)
  return 'torn WAL frame: read-only path warned E_WAL_TRUNCATED without touching it; doctor --check-db preserved the ' + truncatedSize + '-byte WAL, valid prefix recovered, DB/audit verified'
}

async function ftsDesynchronised() {
  const home = makeHome('fts-desync')
  const { SqliteStore } = await import(pathToFileURL(join(root, 'packages/advisers/lib/sqlite.js')).href)
  const store = new SqliteStore(join(home, 'state.db'))
  try {
    store.addTurn({ conversationId: 'fi-conversation', role: 'user', content: '正常写入 FTS 索引的第一轮记录' })
    store.db.exec('DROP TRIGGER turns_ai')
    store.db
      .prepare('INSERT INTO turns(id,conversation_id,seq,role,content,created_at) VALUES(?,?,?,?,?,?)')
      .run('turn_fi_desync', 'fi-conversation', 2, 'user', 'ZQXHIDDEN 漏网检索记录', new Date().toISOString())
  } finally {
    store.close()
  }

  const search = cli(home, ['search', 'ZQXHIDDEN'])
  check(search.status === 0, 'search failed on a desynchronised FTS index: ' + String(search.stderr).slice(0, 300))
  check(String(search.stdout).includes('ZQXHIDDEN'), 'search silently dropped the unindexed row (no LIKE fallback)')
  check(/inconsistent/i.test(String(search.stderr)) && /LIKE/i.test(String(search.stderr)), 'expected an FTS/LIKE inconsistency warning on stderr: ' + String(search.stderr).slice(0, 400))

  const doctor = doctorCheckDb(home)
  check(doctor.status !== 0, 'doctor --check-db did not fail on the desynchronised FTS index')
  check(/FAIL\s+db-fts/.test(String(doctor.stdout)), 'doctor did not report db-fts FAIL: ' + String(doctor.stdout).replace(/\n/g, ' | ').slice(0, 400))
  check(/state=inconsistent/.test(String(doctor.stdout)), 'doctor did not classify the FTS index as inconsistent')
  check(quickCheck(home) === 'ok', 'quick_check failed after the FTS fixture')
  auditCount(home)
  return 'dropped turns_ai trigger + direct insert: search returned the row via LIKE with a warning, doctor --check-db reported db-fts inconsistent'
}

async function enospcStub() {
  if (!HAS_PROCFD) skip('Linux-only: the filesystem stub identifies temp files through /proc/self/fd')
  const home = seededHome('enospc-stub', 'ENOSPC 前承诺')
  const passphrase = { ADVISERS_VAULT_PASSPHRASE: 'correct horse battery' }

  const seal = cli(home, ['vault', 'seal'], {
    ...passphrase,
    ADVISERS_FI_FS: 'temp-enospc',
    NODE_OPTIONS: '--require ' + PRELOAD_FS,
  })
  check(seal.status === 1, 'vault seal did not fail cleanly under an injected ENOSPC (exit ' + seal.status + ')')
  check(/E_NO_SPACE|ENOSPC|no space/i.test(String(seal.stderr)), 'the ENOSPC failure was not reported actionably: ' + String(seal.stderr).slice(0, 400))
  check(!existsSync(join(home, 'state.db.vault')), 'a truncated vault file was installed despite ENOSPC')
  check(!files(home).some((name) => name.includes('.tmp-')), 'a temp file survived the failed seal')
  check(commitmentRows(home).length === 1, 'the plaintext database was damaged by the failed seal')

  const backupTarget = join(tempRoot, 'enospc-backup', 'fi-enospc-target.db')
  mkdirSync(dirname(backupTarget), { recursive: true })
  const backup = cli(home, ['backup', backupTarget], {
    ADVISERS_FI_FS: 'copy-enospc',
    ADVISERS_FI_COPY_MARK: 'fi-enospc-target',
    NODE_OPTIONS: '--require ' + PRELOAD_FS,
  })
  check(backup.status === 1, 'backup did not fail cleanly under an injected ENOSPC (exit ' + backup.status + ')')
  check(/E_NO_SPACE|ENOSPC|no space/i.test(String(backup.stderr)), 'the backup ENOSPC failure was not reported actionably: ' + String(backup.stderr).slice(0, 400))
  check(!existsSync(backupTarget), 'a failed backup left a target file behind')
  check(commitmentRows(home).length === 1, 'the database was damaged by the failed backup')

  mustCli(home, ['vault', 'seal'], passphrase)
  check(existsSync(join(home, 'state.db.vault')), 'a clean seal did not succeed after the injected ENOSPC')
  return 'stub ENOSPC on seal + backup: E_NO_SPACE, no truncated artifact/partial backup, DB intact, clean retry succeeds'
}

async function enospcTmpfs() {
  if (!IS_LINUX) skip('Linux-only: needs unshare -rm and a tmpfs mount')
  const probe = spawnSync('unshare', ['-rm', 'true'], { encoding: 'utf8', timeout: 20000 })
  if (probe.error || probe.status !== 0) skip('unprivileged user namespaces are unavailable: ' + String(probe.error?.message || probe.stderr || '').trim().slice(0, 200))
  writeFileSync(TMPFS_INNER, TMPFS_SCRIPT, { mode: 0o755 })
  const result = spawnSync('unshare', ['-rm', 'bash', TMPFS_INNER], {
    env: { ...process.env, FI_BIN: bin, FI_NODE: process.execPath },
    encoding: 'utf8',
    timeout: 180000,
  })
  const output = String(result.stdout || '') + String(result.stderr || '')
  if (output.includes('SETUP_FAIL')) skip('user namespaces work but mounting a tmpfs is not permitted here')
  check(result.status === 0, 'tmpfs ENOSPC probe failed (exit ' + result.status + '): ' + output.trim().slice(0, 800))
  check(output.includes('TMPFS_ENOSPC_OK'), 'tmpfs probe did not reach its success marker: ' + output.trim().slice(0, 500))
  return 'real 2 MiB tmpfs: commit under a full disk refused cleanly, refused row absent, quick_check ok after freeing space, retry commits'
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function fatal(message) {
  console.error('fault-injection: cannot run: ' + message)
  if (!KEEP) rmSync(tempRoot, { recursive: true, force: true })
  else console.error('fault-injection: artifacts kept at ' + tempRoot)
  process.exitCode = 2
}

function preflight() {
  if (!existsSync(bin)) return 'missing CLI entry point ' + bin
  if (!existsSync(join(root, 'packages/core/dist/index.js'))) return 'packages/core/dist is missing; run: pnpm -r --if-present run build'
  if (!existsSync(join(root, 'packages/policy-strict/dist/index.js'))) return 'packages/policy-strict/dist is missing; run: pnpm -r --if-present run build'
  if (!existsSync(join(root, 'packages/office/dist/index.js'))) return 'packages/office/dist is missing; run: pnpm -r --if-present run build'
  try {
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE VIRTUAL TABLE fts_probe USING fts5(x, tokenize = 'trigram')")
    db.close()
  } catch (error) {
    return 'node:sqlite with FTS5 trigram is unavailable on this Node (' + process.version + '): ' + String(error.message).slice(0, 200)
  }
  const home = join(tempRoot, 'preflight')
  mkdirSync(home, { recursive: true })
  const init = cli(home, ['init'])
  if (init.status !== 0) return 'CLI baseline init failed: ' + String(init.stderr || init.stdout).slice(0, 400)
  const seed = cli(home, ['commit', 'add', 'preflight commitment', '--quote', 'preflight'])
  if (seed.status !== 0) return 'CLI baseline commit add failed: ' + String(seed.stderr || seed.stdout).slice(0, 400)
  const doctor = doctorCheckDb(home)
  if (doctor.status !== 0) return 'CLI baseline doctor --check-db failed: ' + String(doctor.stdout + doctor.stderr).replace(/\n/g, ' | ').slice(0, 600)
  return null
}

async function main() {
  writeFileSync(PRELOAD_SQLITE, SQLITE_PRELOAD)
  writeFileSync(PRELOAD_FS, FS_PRELOAD)
  writeFileSync(WAL_WRITER, WAL_WRITER_SOURCE)

  console.log('fault-injection: node ' + process.version + ' on ' + process.platform + '; temp root ' + tempRoot)
  const problem = preflight()
  if (problem) {
    fatal(problem)
    return
  }

  await runCase('crash-before-commit', crashBeforeCommit)
  await runCase('crash-after-commit', crashAfterCommit)
  await runCase('migration-interrupted', migrationInterrupted)
  await runCase('migration-failure-rollback', migrationFailureRollback)
  await runCase('wal-invalid-header', walInvalidHeader)
  await runCase('wal-truncated', walTruncated)
  await runCase('fts-desynchronised', ftsDesynchronised)
  await runCase('enospc-fs-stub', enospcStub)
  await runCase('enospc-tmpfs', enospcTmpfs)

  const passed = results.filter((item) => item.status === 'PASS').length
  const skipped = results.filter((item) => item.status === 'SKIP').length
  const failed = results.filter((item) => item.status === 'FAIL').length
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log('')
  console.log('fault-injection: ' + passed + ' PASS, ' + skipped + ' SKIP, ' + failed + ' FAIL (' + elapsed + 's)')
  if (failed) {
    console.log('fault-injection: a FAIL means the runtime left an inconsistent state after an injected fault; inspect the case detail above (use --keep to preserve the temporary home).')
  }
  if (KEEP) console.log('fault-injection: artifacts kept at ' + tempRoot)
  else rmSync(tempRoot, { recursive: true, force: true })
  process.exitCode = failed ? 1 : 0
}

await main()
