#!/usr/bin/env node
/**
 * soak-audit.mjs - release gate for the 2026-11-17 robustness audit P0-2/P0-3.
 *
 * Checks, against a throwaway ADVISERS_HOME:
 *   - the audit hash chain verifies and is strictly linear (no repeated
 *     prev_hash, so no fork under concurrent writers);
 *   - every ledger write that has an audit action has a matching audit row,
 *     and commit.add / memory.accept audit rows reference real rows;
 *   - ledger writes and audit rows are atomic together: when the database is
 *     locked the command exits non-zero, writes no state.json orphan and
 *     leaves both the ledger and the audit chain unchanged;
 *   - the removed JSON fallback string is gone from the CLI binary;
 *   - no half-written temp files are left behind.
 *
 * Exits non-zero on the first invariant violation. No network, no model, no
 * real HOME: everything happens inside a mkdtemp directory.
 */
import { spawn } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(ROOT, "packages", "advisers", "bin", "advisers.js")
const CORE = pathToFileURL(join(ROOT, "packages", "core", "dist", "index.js")).href
const STORE = pathToFileURL(join(ROOT, "packages", "advisers", "lib", "sqlite.js")).href
const CONCURRENT = Number(process.env.ADVISERS_SOAK_N) || 10
const failures = []
const startedAt = Date.now()

function fail(message) {
  failures.push(message)
  console.error("FAIL  " + message)
}
function ok(message) { console.log("ok    " + message) }

function envFor(home, extra) {
  return Object.assign({}, process.env, {
    ADVISERS_HOME: home,
    ADVISERS_CORE_LOCAL: "1",
    ADVISERS_OFFICE_LOCAL: "1",
    ADVISERS_NO_MODEL: "1",
    ADVISERS_STORE: "sqlite",
  }, extra || {})
}

function run(args, home, extra) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN].concat(args), { env: envFor(home, extra), cwd: ROOT })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (status) => resolve({ status, stdout, stderr, args }))
  })
}

function openDb(home) {
  const db = new DatabaseSync(join(home, "state.db"))
  db.exec("PRAGMA busy_timeout = 0")
  return db
}
function count(home, sql) {
  const db = new DatabaseSync(join(home, "state.db"), { readOnly: true })
  try { return Number(db.prepare(sql).get().n) } finally { db.close() }
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
      if (row.prev_hash !== prev || row.hash !== expected) return { ok: false, seq: row.seq, count: rows.length }
      prev = row.hash
    }
    return { ok: true, count: rows.length }
  } finally { db.close() }
}
function chainState(home) {
  return {
    audit: count(home, "SELECT COUNT(*) AS n FROM audit"),
    commitments: count(home, "SELECT COUNT(*) AS n FROM commitments"),
  }
}

const root = mkdtempSync(join(tmpdir(), "advisers-soak-audit-"))
const home = join(root, "home")
mkdirSync(home, { recursive: true })
try {
  // ------------------------------------------------------------- baseline
  console.log("[1/5] baseline writes: commit add / correct / memory accept / deliver")
  for (const action of ["发报价给王工", "整理会议纪要", "确认预算表"]) {
    const result = await run(["commit", "add", action, "--quote", action], home)
    if (result.status !== 0) fail("baseline commit add failed: " + result.stderr.trim())
  }
  if ((await run(["correct", "以后周报先给结论"], home)).status !== 0) fail("baseline correct failed")
  const { Ledger } = await import(CORE)
  const { SqliteStore } = await import(STORE)
  const seedStore = new SqliteStore(join(home, "state.db"))
  let candidateId
  try {
    const ledger = Ledger.fromJSON(seedStore.load())
    const matter = ledger.listMatters()[0]
    const turn = seedStore.addTurn({ conversationId: "soak-audit", role: "user", content: "周五前给王工发报价" })
    const candidate = seedStore.proposeCandidate({
      kind: "commitment",
      payload: { matterId: matter.id, debtor: "user", creditor: "王工", action: "发报价（候选）", capability: "none" },
      evidence: [{ quote: "周五前给王工发报价", sessionId: "soak-audit", turnId: turn.id }],
    })
    candidateId = candidate.id
  } finally { seedStore.close() }
  const accepted = await run(["memory", "accept", candidateId], home)
  if (accepted.status !== 0) fail("baseline memory accept failed: " + accepted.stderr.trim())
  mkdirSync(join(root, "deliveries"), { recursive: true })
  const delivered = await run(["deliver", "--type", "confirmation", "--format", "docx", "--out", join(root, "deliveries", "confirmation.docx")], home)
  if (delivered.status !== 0) fail("baseline deliver failed: " + delivered.stderr.trim())
  const deliveryCount = count(home, "SELECT COUNT(*) AS n FROM deliveries")
  if (deliveryCount !== 1) fail("expected 1 delivery row, found " + deliveryCount)
  ok("baseline: 3 commitments + 1 accepted candidate + 1 delivery recorded")

  // ------------------------------------------------------------- chain shape
  console.log("[2/5] audit chain + orphan checks")
  const chain1 = verifyChain(home)
  if (!chain1.ok) fail("audit chain BROKEN at seq " + chain1.seq)
  else ok("audit chain verified (" + chain1.count + " entries)")
  const forks = count(home, "SELECT COUNT(*) AS n FROM (SELECT prev_hash FROM audit GROUP BY prev_hash HAVING COUNT(*) > 1)")
  if (forks !== 0) fail(forks + " audit fork point(s): prev_hash reused")
  else ok("no audit fork: every prev_hash appears at most once")
  const orphanCommitAudit = count(home, "SELECT COUNT(*) AS n FROM audit a LEFT JOIN commitments c ON c.id = a.reason WHERE a.action = 'commit.add' AND c.id IS NULL")
  if (orphanCommitAudit !== 0) fail(orphanCommitAudit + " commit.add audit rows reference missing commitments")
  else ok("commit.add audit rows all reference real commitments")
  const acceptedAudit = count(home, "SELECT COUNT(*) AS n FROM audit WHERE action = 'memory.accept'")
  if (acceptedAudit !== 1) fail("expected 1 memory.accept audit row, found " + acceptedAudit)
  const cloned = readdirSync(home).filter((name) => name === "state.json")
  if (cloned.length) fail("orphan state.json exists next to state.db (split ledger)")
  else ok("no orphan state.json next to the SQLite ledger")
  const added = count(home, "SELECT COUNT(*) AS n FROM audit WHERE action = 'commit.add'")
  const commitments = count(home, "SELECT COUNT(*) AS n FROM commitments")
  if (added !== 3 || commitments !== 4) fail("baseline counts mismatch: commit.add=" + added + " commitments=" + commitments)
  ok("baseline counts: commit.add=" + added + ", commitments=" + commitments + " (3 + accepted candidate)")

  // ------------------------------------------------------------- concurrency
  console.log("[3/5] " + CONCURRENT + " concurrent commit add: chain stays linear")
  const before = chainState(home)
  const results = await Promise.all(Array.from({ length: CONCURRENT }, (_, index) =>
    run(["commit", "add", "并发审计 " + (index + 1), "--quote", "q"], home)))
  const failed = results.filter((result) => result.status !== 0)
  if (failed.length) fail("concurrent commit add: " + failed.length + "/" + CONCURRENT + " failed :: " + failed[0].stderr.trim())
  const after = chainState(home)
  if (after.commitments - before.commitments !== CONCURRENT) fail("concurrent commit add lost writes: +" + (after.commitments - before.commitments) + "/" + CONCURRENT)
  if (after.audit - before.audit !== CONCURRENT) fail("concurrent commit add audit rows: +" + (after.audit - before.audit) + "/" + CONCURRENT)
  const forks2 = count(home, "SELECT COUNT(*) AS n FROM (SELECT prev_hash FROM audit GROUP BY prev_hash HAVING COUNT(*) > 1)")
  if (forks2 !== 0) fail(forks2 + " audit fork point(s) after concurrency")
  const chain2 = verifyChain(home)
  if (!chain2.ok) fail("audit chain BROKEN after concurrency at seq " + chain2.seq)
  else ok("+ " + CONCURRENT + " commitments, +" + CONCURRENT + " audit rows, chain verified (" + chain2.count + " entries), no fork")

  // ------------------------------------------------------------- locked write
  console.log("[4/5] locked database: write fails closed, no orphan ledger/audit")
  const lock = openDb(home)
  lock.exec("BEGIN IMMEDIATE")
  const lockedCli = await run(["commit", "add", "锁住时写入", "--quote", "q"], home, { ADVISERS_SQLITE_BUSY_TIMEOUT_MS: "100" })
  if (lockedCli.status === 0) fail("locked database: CLI unexpectedly exited 0")
  else ok("locked database: CLI exits non-zero (" + (lockedCli.stderr.trim().split("\n")[0] || "no stderr") + ")")
  const stateJson = readdirSync(home).filter((name) => name === "state.json")
  if (stateJson.length) fail("locked database: CLI wrote an orphan state.json despite failure")
  else ok("locked database: no orphan state.json written")
  const helperFile = join(root, "save-under-lock.mjs")
  writeFileSync(helperFile, [
    "import { pathToFileURL } from \"node:url\"",
    "const { Ledger } = await import(process.env.SOAK_CORE)",
    "const { SqliteStore } = await import(process.env.SOAK_STORE)",
    "const store = new SqliteStore(process.env.ADVISERS_HOME + \"/state.db\")",
    "const ledger = Ledger.fromJSON(store.load())",
    "ledger.addCommitment({ matterId: ledger.listMatters()[0].id, debtor: \"user\", creditor: \"someone\", action: \"锁内保存\", timezone: \"Asia/Shanghai\", capability: \"todo\", evidence: [{ quote: \"q\" }] })",
    "process.stdout.write(\"READY\\n\")",
    "process.stdin.once(\"data\", () => {",
    "  try { store.save(ledger.toJSON()); process.stdout.write(\"SAVED\\n\") }",
    "  catch (error) { console.error(\"SAVE_FAILED: \" + error.message); process.exit(1) }",
    "})",
  ].join("\n") + "\n")
  const helper = spawn(process.execPath, [helperFile], { env: envFor(home, { SOAK_CORE: CORE, SOAK_STORE: STORE, ADVISERS_SQLITE_BUSY_TIMEOUT_MS: "100" }), cwd: ROOT })
  let helperStdout = ""
  let helperStderr = ""
  helper.stdout.on("data", (chunk) => { helperStdout += chunk })
  helper.stderr.on("data", (chunk) => { helperStderr += chunk })
  const helperExit = await new Promise((resolve) => {
    helper.stdout.on("data", () => { if (helperStdout.includes("READY")) helper.stdin.write("go\\n") })
    helper.on("close", (status) => resolve(status))
  })
  if (helperExit === 0) fail("locked database: store.save() unexpectedly succeeded")
  else ok("locked database: store.save() fails closed (" + (helperStderr.trim().split("\n").pop() || "no stderr") + ")")
  lock.exec("ROLLBACK")
  lock.close()
  const afterLock = chainState(home)
  if (afterLock.audit !== after.audit || afterLock.commitments !== after.commitments) fail("locked write mutated the database: audit " + after.audit + "->" + afterLock.audit + ", commitments " + after.commitments + "->" + afterLock.commitments)
  else ok("locked write left ledger and audit untouched (audit=" + afterLock.audit + ", commitments=" + afterLock.commitments + ")")

  // ------------------------------------------------------------- recovery + static
  console.log("[5/5] retry after unlock, static checks, temp-file hygiene")
  const retry = await run(["commit", "add", "解锁后重试", "--quote", "q"], home)
  if (retry.status !== 0) fail("retry after unlock failed: " + retry.stderr.trim())
  const chain3 = verifyChain(home)
  if (!chain3.ok) fail("audit chain BROKEN after retry at seq " + chain3.seq)
  else ok("retry after unlock succeeds; chain verified (" + chain3.count + " entries)")
  const binSource = readFileSync(BIN, "utf8")
  if (/falling back to JSON/.test(binSource)) fail("CLI still contains the silent JSON fallback string")
  else ok("CLI has no silent JSON fallback")
  const extras = count(home, "SELECT COUNT(*) AS n FROM audit WHERE action = 'sync.pull' OR action = 'import.ledger'")
  if (extras !== 0) fail("unexpected audit actions present: " + extras)
  const leftovers = readdirSync(home).filter((name) => /\.tmp-|sync-tmp|\.unseal-|before-migrate/.test(name))
  const cliLeftovers = readdirSync(root).filter((name) => /\.tmp-|sync-tmp|\.unseal-/.test(name))
  if (leftovers.length || cliLeftovers.length) fail("temp files left behind: " + leftovers.concat(cliLeftovers).join(", "))
  else ok("no half-written temp files left behind")
  const auditCli = await run(["audit"], home)
  if (auditCli.status !== 0 || !/audit: verified/.test(auditCli.stdout)) fail("advisers audit failed: " + auditCli.stdout + auditCli.stderr)
  else ok("advisers audit: " + auditCli.stdout.split("\n")[0])
  const auditCheck = await run(["audit", "--check-db"], home)
  if (auditCheck.status !== 0 || !/integrity: ok/.test(auditCheck.stdout)) fail("advisers audit --check-db failed: " + auditCheck.stdout + auditCheck.stderr)
  else ok("advisers audit --check-db: integrity ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
if (failures.length) {
  console.error("\nSOAK-AUDIT FAILED: " + failures.length + " invariant violation(s) in " + seconds + "s")
  process.exit(1)
}
console.log("\nSOAK-AUDIT PASS (" + seconds + "s): chain linear + verified, no orphan ledger rows, fail-closed under lock, no temp files")
