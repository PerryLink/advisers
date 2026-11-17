#!/usr/bin/env node
/**
 * Scripts-only stdio entry for the Advisers MCP server library.
 *
 * This is the standalone wiring for packages/advisers/lib/mcp-server.js while
 * the shipped CLI entry (bin/advisers.js: advisers mcp --stdio) is wired to the
 * same library by a separate change. It is NOT shipped in the npm tarball
 * (package files allowlist excludes scripts/); it exists so the library can be
 * exercised end-to-end over real stdio, e.g.
 *
 *   ADVISERS_HOME=/tmp/advisers-mcp node scripts/mcp-dev.mjs
 *
 * Behaviour: one JSON-RPC request per line on stdin, one response per line on
 * stdout. No network, no model calls, no writes other than the audited MCP path
 * (a capture creates a PENDING candidate; pack verification is read-only).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createMcpServer } from '../packages/advisers/lib/mcp-server.js'
import { SqliteStore } from '../packages/advisers/lib/sqlite.js'

const HOME = process.env.ADVISERS_HOME || join(homedir(), '.advisers')
const STATE = join(HOME, 'state.json')
const DB = join(HOME, 'state.db')
const AUDIT_KEY_FILE = join(HOME, 'audit.key')

function fail(message) {
  console.error('advisers mcp-dev: ' + message)
  process.exit(1)
}

async function loadCore() {
  try {
    return await import('../packages/core/dist/index.js')
  } catch {
    return await import('advisers-core')
  }
}

function ensureAuditKey() {
  if (process.env.ADVISERS_AUDIT_KEY) return
  function readKey() {
    const key = readFileSync(AUDIT_KEY_FILE, 'utf8').trim()
    if (key.length < 16) fail('audit key file is too short; refusing to write an unkeyed audit chain')
    return key
  }
  try {
    if (existsSync(AUDIT_KEY_FILE)) {
      process.env.ADVISERS_AUDIT_KEY = readKey()
      return
    }
    const key = randomBytes(32).toString('hex')
    try {
      writeFileSync(AUDIT_KEY_FILE, key, { mode: 0o600, flag: 'wx' })
      process.env.ADVISERS_AUDIT_KEY = key
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      process.env.ADVISERS_AUDIT_KEY = readKey()
    }
  } catch (error) {
    fail('audit key unavailable (' + error.message + '); restore the key file and rerun')
  }
}

mkdirSync(HOME, { recursive: true, mode: 0o700 })
try { chmodSync(HOME, 0o700) } catch {}
ensureAuditKey()

const dbExisted = existsSync(DB)
const store = new SqliteStore(DB)
try { chmodSync(DB, 0o600) } catch {}

const core = await loadCore()
const { Ledger } = core

let ledger
if (dbExisted) {
  ledger = Ledger.fromJSON(store.load())
} else if (existsSync(STATE)) {
  // Same one-way migration as the CLI: state.json is imported once, then the
  // SQLite database is the only ledger.
  ledger = Ledger.fromJSON(JSON.parse(readFileSync(STATE, 'utf8')))
  store.save(ledger.toJSON())
} else {
  ledger = new Ledger()
}

const version = JSON.parse(readFileSync(new URL('../packages/advisers/package.json', import.meta.url), 'utf8')).version
const server = createMcpServer({
  store,
  ledger,
  version,
  audit: (entry) => store.appendAudit(entry),
})

await server.serve(process.stdin, process.stdout)
