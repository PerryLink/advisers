#!/usr/bin/env node
/**
 * soak-concurrency.mjs - release gate for the 2026-11-17 robustness audit P0s.
 *
 * Exercises, against throwaway ADVISERS_HOME directories:
 *   1. N rounds of two CLI processes opening a brand-new database at the same
 *      time (P0-1: no "database is locked", no non-zero exit, audit verified).
 *   2. ADVISERS_SOAK_N (default 10) processes adding commitments concurrently
 *      (P0-2/P0-3/P1-1: no JSON fallback, every write has its audit row, no
 *      lost updates, the hash chain stays linear and verifies).
 *   3. the same number of processes accepting distinct memory candidates
 *      concurrently (candidate review + ledger + audit commit together).
 *
 * Exits non-zero on the first invariant violation. No network, no model, no
 * real HOME: everything happens inside a mkdtemp directory.
 */
import { spawn } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(ROOT, "packages", "advisers", "bin", "advisers.js")
const CORE = pathToFileURL(join(ROOT, "packages", "core", "dist", "index.js")).href
const STORE = pathToFileURL(join(ROOT, "packages", "advisers", "lib", "sqlite.js")).href
const PROCS = Number(process.env.ADVISERS_SOAK_N) || 10
const ROUNDS = Number(process.env.ADVISERS_SOAK_FIRST_OPEN_ROUNDS) || 10
const failures = []
const startedAt = Date.now()

function fail(message) {
  failures.push(message)
  console.error("FAIL  " + message)
}
function ok(message) { console.log("ok    " + message) }

function envFor(home) {
  return {
    ...process.env,
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: "1",
    ADVISERS_OFFICE_LOCAL: "1",
    ADVISERS_NO_MODEL: "1",
    ADVISERS_STORE: "sqlite",
  }
}

function run(args, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN].concat(args), { env: envFor(home), cwd: ROOT })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (status) => resolve({ status, stdout, stderr, args }))
  })
}

function verifyChain(home) {
  const db = new DatabaseSync(join(home, "state.db"), { readOnly: true })
  try {
    const rows = db.prepare("SELECT * FROM audit ORDER BY seq ASC").all()
    let key
    try { key = readFileSync(join(home, "audit.key"), "utf8").trim() } catch { key = undefined }
    let prev = ""
    for (const row of rows) {
      const material = [prev, row.at, row.actor, row.action, row.allowed, row.reason ?? ""].join("\n")
      const expected = key ? createHmac("sha256", key).update(material).digest("hex") : createHash("sha256").update(material).digest("hex")
      if (row.prev_hash !== prev || row.hash !== expected) return { ok: false, seq: row.seq, count: rows.length, keyed: Boolean(key) }
      prev = row.hash
    }
    return { ok: true, count: rows.length, keyed: Boolean(key) }
  } finally { db.close() }
}

function count(home, sql) {
  const db = new DatabaseSync(join(home, "state.db"), { readOnly: true })
  try { return Number(db.prepare(sql).get().n) } finally { db.close() }
}

function checkNoise(results, label) {
  for (const result of results) {
    if (result.status !== 0) fail(label + ": exit " + result.status + " for " + result.args.join(" ") + " :: " + result.stderr.trim())
    if (/database is locked/i.test(result.stderr + result.stdout)) fail(label + ": database is locked surfaced")
    if (/falling back to JSON/i.test(result.stderr + result.stdout)) fail(label + ": silent JSON fallback resurfaced")
  }
}

const root = mkdtempSync(join(tmpdir(), "advisers-soak-concurrency-"))
try {
  // --------------------------------------------------------------- phase 1
  console.log("[1/3] " + ROUNDS + " rounds x 2 processes: concurrent first open on a fresh HOME")
  for (let round = 1; round <= ROUNDS; round++) {
    const home = join(root, "first-open-" + round)
    const results = await Promise.all([
      run(["commit", "add", "round " + round + " a", "--quote", "q"], home),
      run(["commit", "add", "round " + round + " b", "--quote", "q"], home),
    ])
    checkNoise(results, "first-open round " + round)
    if (results.some((result) => result.status !== 0)) continue
    const chain = verifyChain(home)
    if (!chain.ok || chain.count !== 2) fail("first-open round " + round + ": audit ok=" + chain.ok + " count=" + chain.count)
  }
  if (!failures.length) ok(ROUNDS + "/" + ROUNDS + " rounds: both processes exit 0, audit verified (2 entries each)")

  // --------------------------------------------------------------- phase 2
  console.log("[2/3] " + PROCS + " concurrent processes: commit add (first write + audit pairing + merge)")
  const home2 = join(root, "concurrent-commits")
  mkdirSync(home2, { recursive: true })
  const addResults = await Promise.all(Array.from({ length: PROCS }, (_, index) =>
    run(["commit", "add", "并发承诺 " + (index + 1), "--quote", "concurrency"], home2)))
  checkNoise(addResults, "concurrent commit add")
  const addFailures = addResults.filter((result) => result.status !== 0).length
  if (addFailures) fail("concurrent commit add: " + addFailures + "/" + PROCS + " processes failed")
  const commitments = count(home2, "SELECT COUNT(*) AS n FROM commitments")
  const addAudit = count(home2, "SELECT COUNT(*) AS n FROM audit WHERE action = 'commit.add'")
  const orphans = count(home2, "SELECT COUNT(*) AS n FROM audit a LEFT JOIN commitments c ON c.id = a.reason WHERE a.action = 'commit.add' AND c.id IS NULL")
  const chain2 = verifyChain(home2)
  if (commitments !== PROCS) fail("concurrent commit add: expected " + PROCS + " commitments, found " + commitments + " (lost update)")
  if (addAudit !== PROCS) fail("concurrent commit add: expected " + PROCS + " commit.add audit rows, found " + addAudit)
  if (orphans !== 0) fail("concurrent commit add: " + orphans + " audit rows reference missing commitments")
  if (!chain2.ok) fail("concurrent commit add: audit chain BROKEN at seq " + chain2.seq)
  if (!chain2.keyed) fail("concurrent commit add: audit chain is unkeyed (audit.key missing)")
  if (commitments === PROCS && addAudit === PROCS && orphans === 0 && chain2.ok) ok(PROCS + "/" + PROCS + " exits 0; commitments=" + commitments + "; audit commit.add=" + addAudit + "; chain verified; 0 orphan rows")

  // --------------------------------------------------------------- phase 3
  console.log("[3/3] " + PROCS + " concurrent processes: memory accept (candidate review + ledger + audit in one transaction)")
  const { Ledger } = await import(CORE)
  const { SqliteStore } = await import(STORE)
  const seedStore = new SqliteStore(join(home2, "state.db"))
  let candidateIds = []
  try {
    const seedLedger = Ledger.fromJSON(seedStore.load())
    const matter = seedLedger.listMatters()[0]
    if (!matter) throw new Error("no matter to seed candidates for")
    for (let index = 0; index < PROCS; index++) {
      const turn = seedStore.addTurn({ conversationId: "soak", role: "user", content: "并发候选 " + index })
      const candidate = seedStore.proposeCandidate({
        kind: "commitment",
        payload: { matterId: matter.id, debtor: "user", creditor: "someone", action: "候选承诺 " + index, capability: "none" },
        evidence: [{ quote: "并发候选 " + index, sessionId: "soak", turnId: turn.id }],
      })
      candidateIds.push(candidate.id)
    }
  } finally { seedStore.close() }
  const acceptResults = await Promise.all(candidateIds.map((id) => run(["memory", "accept", id], home2)))
  checkNoise(acceptResults, "concurrent memory accept")
  const acceptFailures = acceptResults.filter((result) => result.status !== 0).length
  if (acceptFailures) fail("concurrent memory accept: " + acceptFailures + "/" + PROCS + " processes failed")
  const totalCommitments = count(home2, "SELECT COUNT(*) AS n FROM commitments")
  const acceptAudit = count(home2, "SELECT COUNT(*) AS n FROM audit WHERE action = 'memory.accept'")
  const pending = count(home2, "SELECT COUNT(*) AS n FROM memory_candidates WHERE status = 'pending'")
  const chain3 = verifyChain(home2)
  if (totalCommitments !== PROCS * 2) fail("memory accept: expected " + PROCS * 2 + " commitments, found " + totalCommitments)
  if (acceptAudit !== PROCS) fail("memory accept: expected " + PROCS + " memory.accept audit rows, found " + acceptAudit)
  if (pending !== 0) fail("memory accept: " + pending + " candidates still pending")
  if (!chain3.ok) fail("memory accept: audit chain BROKEN at seq " + chain3.seq)
  if (totalCommitments === PROCS * 2 && acceptAudit === PROCS && pending === 0 && chain3.ok) ok(PROCS + "/" + PROCS + " exits 0; commitments=" + totalCommitments + "; audit memory.accept=" + acceptAudit + "; chain verified (" + chain3.count + " entries); 0 pending candidates")

  const cliAudit = await run(["audit"], home2)
  if (cliAudit.status !== 0 || !/audit: verified/.test(cliAudit.stdout)) fail("advisers audit failed: exit " + cliAudit.status + " :: " + cliAudit.stdout + cliAudit.stderr)
  else ok("advisers audit: " + cliAudit.stdout.split("\n")[0])
} finally {
  rmSync(root, { recursive: true, force: true })
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
if (failures.length) {
  console.error("\nSOAK-CONCURRENCY FAILED: " + failures.length + " invariant violation(s) in " + seconds + "s")
  process.exit(1)
}
console.log("\nSOAK-CONCURRENCY PASS (" + seconds + "s): " + (ROUNDS * 2 + PROCS * 2) + " processes, no lost writes, no audit fork, no silent JSON fallback")
