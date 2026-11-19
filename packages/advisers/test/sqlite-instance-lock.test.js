import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { tosEnv } from "./tos-fixture.js"
import { encryptJson } from "../lib/vault.js"
import { SqliteStore, instanceLockPath, readInstanceLock } from "../lib/sqlite.js"

// 0.2.1 robustness audit P0-1 / P2-2: single-writer instance lock (wait/timeout/
// stale takeover/SIGTERM release), explicit E_DB_LOCKED instead of a silent stale
// save, 0-byte database refusal (E_DB_CORRUPT) across open/backup/unseal/sync,
// and repeated concurrent CLI write pairs that must never lose an update.

const bin = fileURLToPath(new URL("../bin/advisers.js", import.meta.url))
const sqliteLib = fileURLToPath(new URL("../lib/sqlite.js", import.meta.url))
const binSource = readFileSync(bin, "utf8")
const PASSPHRASE = "correct horse battery"
const baseEnv = {
  ...process.env,
  ADVISERS_CORE_LOCAL: "1",
  ADVISERS_OFFICE_LOCAL: "1",
  ADVISERS_NO_MODEL: "1",
  ADVISERS_STORE: "sqlite",
}
function env(home, extra) { return tosEnv(home, { ...baseEnv, ...(extra || {}) }) }
function cli(home, args, extra) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: "utf8" })
}
function cliOk(home, args, extra) {
  const result = cli(home, args, extra)
  assert.equal(result.status, 0, "advisers " + args.join(" ") + " failed: " + result.stderr)
  return result
}
function runAsync(home, args, extra) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { env: env(home, extra) })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(25)
  }
  return false
}
function db(home) { return new DatabaseSync(join(home, "state.db"), { readOnly: true }) }
function query(home, sql) {
  const database = db(home)
  try { return database.prepare(sql).all() } finally { database.close() }
}
function count(home, sql) {
  const database = db(home)
  try { return Number(database.prepare(sql).get().n) } finally { database.close() }
}
function lockFile(home) { return instanceLockPath(home) }
function stderrOf(result) { return String(result.stderr || "") + String(result.stdout || "") }

/** Write a one-shot Node script that takes the instance lock for holdMs. */
function writeLockHolder(root) {
  const file = join(root, "lock-holder.mjs")
  writeFileSync(file, [
    "import { acquireInstanceLock } from " + JSON.stringify(pathToFileURL(sqliteLib).href),
    "const lock = acquireInstanceLock({ home: process.env.ADVISERS_HOME, command: 'test-holder', timeoutMs: 5000 })",
    "process.stdout.write('held\\n')",
    "const holdMs = Number(process.env.ADVISERS_HOLD_MS || '1200')",
    "if (holdMs > 0) setTimeout(() => { lock.release(); process.exit(0) }, holdMs)",
    "else setInterval(() => {}, 60000)",
    "",
  ].join("\n"))
  return file
}

function startHolder(holderScript, home, holdMs = 1200) {
  const child = spawn(process.execPath, [holderScript], {
    env: { ...process.env, ADVISERS_HOME: home, ADVISERS_HOLD_MS: String(holdMs) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  return {
    child,
    ready: () => waitFor(() => stdout.includes("held")),
    stderr: () => stderr,
    wait: () => new Promise((resolve) => child.once("exit", resolve)),
  }
}

function startUi(home) {
  const child = spawn(process.execPath, [bin, "ui", "--port", "0"], { env: env(home), stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  return {
    child,
    ready: () => waitFor(() => /127\.0\.0\.1:\d+/.test(stdout), 10000),
    stderr: () => stderr,
    wait: () => new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
  }
}

/** Start a real MCP stdio server: a long-lived WRITER that keeps the HOME lock. */
function startMcp(home) {
  const child = spawn(process.execPath, [bin, "mcp", "--stdio"], { env: env(home), stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  return {
    child,
    // Ready only once the server answered initialize: the lock alone appears
    // before state.db is fully created, and a SIGKILL in that window leaves a
    // 0-byte database (a real crash, but not what these lock tests mean to probe).
    ready: async () => {
      try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n") } catch {}
      const initialized = await waitFor(() => stdout.includes('"jsonrpc"'), 15000)
      return initialized && existsSync(lockFile(home))
    },
    stderr: () => stderr,
    stop: async () => {
      child.kill("SIGTERM")
      await Promise.race([new Promise((resolve) => child.once("close", resolve)), sleep(8000)])
      if (child.exitCode === null) child.kill("SIGKILL")
    },
  }
}

test("instance lock: a running writer CLI holds ~/.advisers/instance.lock with pid/startedAt/command and releases it", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-lock-content-"))
  const home = join(root, "home")
  try {
    // mcp is a writer (audit rows for every tools/call) and is the 0.2.3
    // long-lived holder; ui/tui are read-only and take no writer lock any more.
    const mcp = startMcp(home)
    try {
      assert.ok(await mcp.ready(), "mcp did not start: " + mcp.stderr())
      const lockPath = lockFile(home)
      const info = readInstanceLock(home)
      assert.ok(info?.record, "instance lock has no pid record")
      assert.equal(info.record.pid, mcp.child.pid, "instance lock must name the running CLI pid")
      assert.ok(info.record.startedAt, "instance lock must record startedAt")
      assert.match(info.record.command, /mcp --stdio/, "instance lock must record the command")
      assert.equal(statSync(lockPath).mode & 0o777, 0o600, "instance lock must be 0600")
      // Lock-free read path: pure reads work while the writer holds the lock.
      const read = cliOk(home, ["status"])
      assert.match(read.stdout, /store\s+sqlite/)
    } finally { await mcp.stop() }
    assert.equal(existsSync(lockFile(home)), false, "instance lock must be released when the process exits")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("instance lock: a second command waits for a live holder and then succeeds (bounded retry, no lock loss)", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-lock-wait-"))
  const home = join(root, "home")
  const holderScript = writeLockHolder(root)
  mkdirSync(home, { recursive: true })
  const holder = startHolder(holderScript, home, 1200)
  try {
    assert.ok(await holder.ready(), "lock holder did not start: " + holder.stderr())
    const started = Date.now()
    const result = cli(home, ["commit", "add", "waited for lock", "--quote", "q"])
    const elapsed = Date.now() - started
    assert.equal(result.status, 0, "command should succeed after waiting: " + result.stderr)
    assert.match(result.stdout, /open waited for lock/)
    assert.ok(elapsed >= 500, "command returned after " + elapsed + "ms; it should have waited for the holder")
    assert.ok(elapsed < 10000, "wait exceeded the default lock timeout: " + elapsed + "ms")
  } finally {
    holder.child.kill("SIGKILL")
    await Promise.race([holder.wait(), sleep(5000)])
    rmSync(root, { recursive: true, force: true })
  }
})

test("instance lock: timeout fails closed with E_DB_LOCKED for writes; the lightweight doctor stays green (read-only) and --check-db reports E_DB_LOCKED", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-lock-timeout-"))
  const home = join(root, "home")
  const holderScript = writeLockHolder(root)
  mkdirSync(home, { recursive: true })
  // Seed a real database first, then hold the writer lock: 0.2.3's read path
  // works while the lock is held, so doctor can inspect this committed snapshot.
  cliOk(home, ["commit", "add", "seed before lock", "--quote", "q"])
  // Hold until the test kills us: the doctor invocation below pays the
  // (office-import warming) cold start, so a fixed hold duration would be flaky.
  const holder = startHolder(holderScript, home, 0)
  try {
    assert.ok(await holder.ready(), "lock holder did not start: " + holder.stderr())
    const busy = cli(home, ["commit", "add", "must not write", "--quote", "q"], { ADVISERS_LOCK_TIMEOUT_MS: "150" })
    assert.equal(busy.status, 1, "timed-out lock must exit non-zero")
    assert.match(stderrOf(busy), /E_DB_LOCKED/, "stderr must name E_DB_LOCKED")
    assert.match(stderrOf(busy), /instance\.lock/, "stderr must name the lock file")
    assert.match(stderrOf(busy), /test-holder|pid \d+/, "stderr should name the holder")
    assert.equal(existsSync(join(home, "state.json")), false, "a timed-out command must not create state.json")
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM commitments"), 1, "the blocked write must not have landed")
    assert.equal(existsSync(join(home, "instance.lock")), true, "the waiter must not remove the holder's lock file")
    assert.doesNotMatch(binSource, /falling back to JSON/)

    // The default doctor is lightweight/read-only: it must PASS while a writer
    // holds the lock and report the holder instead of failing the lock row.
    const doctor = cli(home, ["doctor"], { ADVISERS_LOCK_TIMEOUT_MS: "150" })
    assert.equal(doctor.status, 0, "default doctor must work on the lock-free snapshot: " + doctor.stdout + doctor.stderr)
    assert.match(doctor.stdout, /PASS  lock/)
    assert.match(doctor.stdout, /held by pid \d+/)
    assert.doesNotMatch(stderrOf(doctor), /E_DB_LOCKED/)
    // --check-db is the explicit writable maintenance pass (FTS integrity-check
    // needs a write): with the lock held it must say E_DB_LOCKED, never a
    // confusing 'attempt to write a readonly database'.
    const checked = cli(home, ["doctor", "--check-db"], { ADVISERS_LOCK_TIMEOUT_MS: "150" })
    assert.equal(checked.status, 1, "doctor --check-db must fail closed while the writer lock is held")
    assert.match(stderrOf(checked) + checked.stdout, /E_DB_LOCKED/)
    assert.match(checked.stdout, /FAIL  db-integrity/)
    assert.doesNotMatch(stderrOf(checked) + checked.stdout, /readonly database|read-only database/)
    assert.equal(existsSync(join(home, "instance.lock")), true, "doctor must not remove the holder's lock file")
  } finally {
    holder.child.kill("SIGKILL")
    await Promise.race([holder.wait(), sleep(5000)])
    rmSync(root, { recursive: true, force: true })
  }
})

test("instance lock: a lock whose pid no longer exists is reclaimed", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-lock-dead-"))
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  try {
    writeFileSync(lockFile(home), JSON.stringify({ pid: 999999, startedAt: "2026-11-17T00:00:00.000Z", command: "crashed-command" }) + "\n", { mode: 0o600 })
    const result = cli(home, ["commit", "add", "after stale lock", "--quote", "q"], { ADVISERS_LOCK_TIMEOUT_MS: "2000" })
    assert.equal(result.status, 0, "a dead-pid lock must be reclaimed: " + result.stderr)
    assert.match(result.stdout, /open after stale lock/)
    assert.equal(existsSync(lockFile(home)), false, "reclaimed lock must be released on exit")
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM commitments"), 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("instance lock: an unrefreshed lock older than the stale threshold is reclaimed", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-lock-age-"))
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  try {
    // The pid is this test process (alive), but the lock is far older than the
    // (test-lowered) stale threshold, so it must be taken over.
    writeFileSync(lockFile(home), JSON.stringify({ pid: process.pid, startedAt: "2026-11-17T00:00:00.000Z", command: "stale-live-pid" }) + "\n", { mode: 0o600 })
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockFile(home), old, old)
    const result = cli(home, ["commit", "add", "after age reclaim", "--quote", "q"], { ADVISERS_LOCK_TIMEOUT_MS: "2000", ADVISERS_LOCK_STALE_MS: "500" })
    assert.equal(result.status, 0, "an age-stale lock must be reclaimed: " + result.stderr)
    assert.equal(existsSync(lockFile(home)), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("instance lock: SIGTERM/SIGINT release the lock; a SIGKILLed writer is reclaimed by the next command", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-lock-signal-"))
  const homeTerm = join(root, "home-term")
  const homeKill = join(root, "home-kill")
  const homeInt = join(root, "home-int")
  try {
    const term = startMcp(homeTerm)
    assert.ok(await term.ready(), "mcp did not take the lock: " + term.stderr())
    term.child.kill("SIGTERM")
    const termResult = await Promise.race([new Promise((resolve) => term.child.once("close", resolve)), sleep(8000).then(() => "timeout")])
    assert.notEqual(termResult, "timeout", "mcp did not exit on SIGTERM")
    assert.equal(existsSync(lockFile(homeTerm)), false, "SIGTERM must release the instance lock")
    cliOk(homeTerm, ["commit", "add", "after sigterm", "--quote", "q"])

    const interrupted = startMcp(homeInt)
    assert.ok(await interrupted.ready(), "mcp did not take the lock: " + interrupted.stderr())
    interrupted.child.kill("SIGINT")
    await Promise.race([new Promise((resolve) => interrupted.child.once("close", resolve)), sleep(8000)])
    if (interrupted.child.exitCode === null) interrupted.child.kill("SIGKILL")
    assert.equal(existsSync(lockFile(homeInt)), false, "SIGINT must release the instance lock")

    const killed = startMcp(homeKill)
    assert.ok(await killed.ready(), "mcp did not take the lock: " + killed.stderr())
    killed.child.kill("SIGKILL")
    await Promise.race([new Promise((resolve) => killed.child.once("close", resolve)), sleep(8000)])
    assert.equal(existsSync(lockFile(homeKill)), true, "SIGKILL leaves the lock file behind (stale)")
    const reclaim = cli(homeKill, ["commit", "add", "after sigkill", "--quote", "q"], { ADVISERS_LOCK_TIMEOUT_MS: "3000" })
    assert.equal(reclaim.status, 0, "the next command must reclaim a SIGKILLed holder's lock: " + reclaim.stderr)
    assert.equal(existsSync(lockFile(homeKill)), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("instance lock: --version/help create neither the home directory nor a lock file", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-lock-nohome-"))
  try {
    const home = join(root, "never-created")
    const version = spawnSync(process.execPath, [bin, "--version"], { env: { ...baseEnv, ADVISERS_HOME: home }, encoding: "utf8" })
    assert.equal(version.status, 0, version.stderr)
    assert.match(version.stdout, /^0\.3\./)
    assert.equal(existsSync(home), false, "--version must not create ADVISERS_HOME")
    const help = spawnSync(process.execPath, [bin, "help"], { env: { ...baseEnv, ADVISERS_HOME: home }, encoding: "utf8" })
    assert.equal(help.status, 0, help.stderr)
    assert.equal(existsSync(home), false, "help must not create ADVISERS_HOME")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("corrupt database: a 0-byte state.db is refused (E_DB_CORRUPT), never silently rebuilt, and doctor FAILs", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-zero-db-"))
  const home = join(root, "home")
  try {
    cliOk(home, ["commit", "add", "seed data", "--quote", "q"])
    writeFileSync(join(home, "state.db"), "")
    assert.equal(statSync(join(home, "state.db")).size, 0)

    for (const args of [["commit", "ls"], ["commit", "add", "rebuilt?", "--quote", "q"], ["status"]]) {
      const result = cli(home, args)
      assert.equal(result.status, 1, "advisers " + args.join(" ") + " must fail on a 0-byte database")
      assert.match(stderrOf(result), /E_DB_CORRUPT/, "stderr must name E_DB_CORRUPT")
      assert.equal(statSync(join(home, "state.db")).size, 0, "the 0-byte database must not be rebuilt")
      assert.equal(existsSync(join(home, "state.json")), false)
      assert.equal(existsSync(join(home, "instance.lock")), false, "the lock must be released on failure")
    }

    assert.equal(readdirSync(home).filter((name) => name.includes("before-migrate")).length, 0, "no migration may run on a 0-byte database")
    const doctor = cli(home, ["doctor"])
    assert.equal(doctor.status, 1, "doctor must FAIL on a 0-byte database")
    assert.match(doctor.stdout, /FAIL  database/, "doctor must report the database failure")
    assert.match(doctor.stdout, /E_DB_CORRUPT/)
    assert.equal(statSync(join(home, "state.db")).size, 0)
    const backup = cli(home, ["backup", join(root, "out.db")])
    assert.equal(backup.status, 1, "backup must refuse a 0-byte database")
    assert.match(stderrOf(backup), /E_DB_CORRUPT/)
    assert.equal(existsSync(join(root, "out.db")), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("corrupt database: unseal and sync pull refuse a 0-byte database payload and keep the live database", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-zero-payload-"))
  const home = join(root, "home")
  const syncDir = join(root, "sync")
  try {
    cliOk(home, ["commit", "add", "第一份承诺", "--quote", "q"])
    const dbPath = join(home, "state.db")
    const before = readFileSync(dbPath)
    const empty = Buffer.alloc(0)
    const emptySha = createHash("sha256").update(empty).digest("hex")

    // vault unseal: a 0-byte "database" would pass quick_check as an empty DB.
    const payload = { kind: "advisers-db", version: "test", sha256: emptySha, db: empty.toString("base64") }
    writeFileSync(join(home, "state.db.vault"), JSON.stringify(encryptJson(payload, PASSPHRASE)) + "\n")
    const unseal = cli(home, ["vault", "unseal"], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    assert.equal(unseal.status, 1, "unseal must refuse a 0-byte database payload")
    assert.match(stderrOf(unseal), /E_DB_CORRUPT|integrity check/)
    assert.deepEqual(readFileSync(dbPath), before, "unseal must not replace the live database")
    assert.equal(readdirSync(home).filter((name) => name.includes(".unseal-")).length, 0, "no unseal temp files may remain")

    // sync pull: a self-consistent envelope carrying 0 bytes must be refused.
    mkdirSync(syncDir, { recursive: true })
    const snapshot = { kind: "advisers-sync-db", version: 1, device: "test-device", createdAt: new Date().toISOString(), sha256: emptySha, db: "" }
    const name = "advisers-test-" + new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") + ".enc.json"
    writeFileSync(join(syncDir, name), JSON.stringify(encryptJson(snapshot, PASSPHRASE)) + "\n")
    const pull = cli(home, ["sync", "pull", "--dir", syncDir, "--force"], { ADVISERS_SYNC_PASSPHRASE: PASSPHRASE })
    assert.equal(pull.status, 1, "sync pull must refuse a 0-byte snapshot")
    assert.match(stderrOf(pull), /refusing to replace the local database|E_DB_CORRUPT|integrity check/)
    assert.deepEqual(readFileSync(dbPath), before, "sync pull must keep the local database")
    assert.match(cliOk(home, ["commit", "ls"]).stdout, /第一份承诺/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("sealed vault: ordinary commands fail with E_VAULT_SEALED and leave no state.db or instance.lock behind", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-sealed-lock-"))
  const home = join(root, "home")
  try {
    cliOk(home, ["commit", "add", "秘密承诺", "--quote", "q"])
    cliOk(home, ["vault", "seal", "--remove"], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE })
    assert.equal(existsSync(join(home, "state.db")), false)
    assert.equal(existsSync(lockFile(home)), false, "seal must release the lock")
    for (const args of [["today"], ["commit", "ls"], ["audit"], ["backup", join(root, "b.db")]]) {
      const result = cli(home, args)
      assert.equal(result.status, 1, "advisers " + args.join(" ") + " must fail while sealed")
      assert.match(stderrOf(result), /E_VAULT_SEALED/, args.join(" "))
      assert.equal(existsSync(join(home, "state.db")), false, "a sealed vault must never be replaced by an empty DB")
      assert.equal(existsSync(lockFile(home)), false, "a sealed command must not leave a lock file behind")
    }
    const doctor = cli(home, ["doctor"])
    assert.equal(doctor.status, 0)
    assert.match(doctor.stdout, /vault\s+sealed/)
    assert.match(doctor.stdout, /not taken \(vault sealed\)/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("instance lock: seal/unseal/sync/backup refuse with E_DB_LOCKED while another instance holds the store (P1-3)", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-lock-ops-"))
  const home = join(root, "home")
  const syncDir = join(root, "sync")
  try {
    cliOk(home, ["commit", "add", "held by server", "--quote", "q"])
    // A valid sealed copy exists so `vault unseal` reaches the lock instead of
    // failing earlier on the missing file.
    const dbBytes = readFileSync(join(home, "state.db"))
    const sealedPayload = {
      kind: "advisers-db",
      version: "test",
      sha256: createHash("sha256").update(dbBytes).digest("hex"),
      db: dbBytes.toString("base64"),
    }
    writeFileSync(join(home, "state.db.vault"), JSON.stringify(encryptJson(sealedPayload, PASSPHRASE)) + "\n")

    // A dedicated lock holder (the same primitive a long-lived writer uses) is
    // enough: these maintenance commands only inspect the HOME instance lock.
    const holderScript = writeLockHolder(root)
    const holder = startHolder(holderScript, home, 0)
    try {
      assert.ok(await holder.ready(), "lock holder did not start: " + holder.stderr())
      const busyEnv = { ADVISERS_LOCK_TIMEOUT_MS: "200" }
      const operations = [
        [["vault", "seal", "--remove"], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE }],
        [["vault", "unseal"], { ADVISERS_VAULT_PASSPHRASE: PASSPHRASE }],
        [["sync", "push", "--dir", syncDir], { ADVISERS_SYNC_PASSPHRASE: PASSPHRASE }],
        [["sync", "pull", "--dir", syncDir], { ADVISERS_SYNC_PASSPHRASE: PASSPHRASE }],
        [["backup", join(root, "out.db")], {}],
      ]
      for (const [args, extra] of operations) {
        const result = cli(home, args, { ...busyEnv, ...extra })
        assert.equal(result.status, 1, "advisers " + args.join(" ") + " must be blocked by the live instance")
        assert.match(stderrOf(result), /E_DB_LOCKED/, "advisers " + args.join(" ") + " must report E_DB_LOCKED")
        assert.equal(existsSync(join(home, "state.db")), true, "advisers " + args.join(" ") + " must not remove state.db")
      }
      assert.equal(existsSync(join(root, "out.db")), false, "backup must not write a file when blocked")
      assert.equal(existsSync(syncDir), false, "sync must not write while blocked")
    } finally {
      holder.child.kill("SIGKILL")
      await Promise.race([holder.wait(), sleep(5000)])
    }
    assert.match(cliOk(home, ["commit", "ls"]).stdout, /held by server/, "data must survive the blocked operations")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("concurrency: simultaneous commit done + commit snooze never lose an update (repeated rounds)", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-conc-done-snooze-"))
  try {
    for (let round = 0; round < 3; round++) {
      const home = join(root, "home-" + round)
      const one = cliOk(home, ["commit", "add", "round " + round + " one", "--quote", "q"]).stdout
      const two = cliOk(home, ["commit", "add", "round " + round + " two", "--quote", "q"]).stdout
      const id1 = /^(\S+) open/.exec(one)?.[1]
      const id2 = /^(\S+) open/.exec(two)?.[1]
      assert.ok(id1 && id2, "could not read commitment ids")
      const [done, snoozed] = await Promise.all([
        runAsync(home, ["commit", "done", id1, "--evidence", "证据 " + round]),
        runAsync(home, ["commit", "snooze", id2, "24"]),
      ])
      assert.equal(done.status, 0, "done failed: " + done.stderr)
      assert.equal(snoozed.status, 0, "snooze failed: " + snoozed.stderr)
      const statuses = new Map(query(home, "SELECT id, status FROM commitments").map((row) => [row.id, row.status]))
      assert.equal(statuses.size, 2)
      assert.equal(statuses.get(id1), "done", "round " + round + ": done update was lost")
      assert.equal(statuses.get(id2), "snoozed", "round " + round + ": snooze update was lost")
      assert.equal(count(home, "SELECT COUNT(*) AS n FROM audit WHERE action IN ('commit.done','commit.snooze')"), 2)
      const audit = cli(home, ["audit"])
      assert.equal(audit.status, 0)
      assert.match(audit.stdout, /audit: verified/)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("concurrency: memory accept + commit add both persist and the audit chain stays verified", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-conc-memory-"))
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  try {
    const store = new SqliteStore(join(home, "state.db"))
    let candidate
    try {
      candidate = store.proposeCandidate({ kind: "fact", payload: { subject: "client", predicate: "budget", object: "预算 300 万" }, evidence: [{ quote: "原话" }] })
    } finally { store.close() }
    const [accepted, added] = await Promise.all([
      runAsync(home, ["memory", "accept", candidate.id]),
      runAsync(home, ["commit", "add", "并发新增承诺", "--quote", "q"]),
    ])
    assert.equal(accepted.status, 0, "memory accept failed: " + accepted.stderr)
    assert.equal(added.status, 0, "commit add failed: " + added.stderr)
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM memory_candidates WHERE status = 'accepted'"), 1, "candidate acceptance was lost")
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM facts"), 1)
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM commitments"), 1, "concurrent commitment was lost")
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM audit WHERE action IN ('memory.accept','commit.add')"), 2)
    const audit = cli(home, ["audit"])
    assert.equal(audit.status, 0)
    assert.match(audit.stdout, /audit: verified/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// The fact helper needs the same ledger shape the CLI writes; import lazily so
// this test file does not slow down every other suite.
async function seedFactLedger(home) {
  const { Ledger } = await import("../../core/dist/index.js")
  const store = new SqliteStore(join(home, "state.db"))
  try {
    const ledger = new Ledger()
    const matter = ledger.addMatter({ title: "并发删除" })
    const fact = ledger.remember({ matterId: matter.id, subject: "client", predicate: "secret", object: "将被遗忘", authority: "user", evidence: [{ quote: "q" }] })
    store.save(ledger.toJSON())
    return fact.id
  } finally { store.close() }
}

test("concurrency: forget + commit add never resurrect the deleted fact", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-conc-forget-"))
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  try {
    const factId = await seedFactLedger(home)
    const [forgotten, added] = await Promise.all([
      runAsync(home, ["forget", factId]),
      runAsync(home, ["commit", "add", "并发生成的承诺", "--quote", "q"]),
    ])
    assert.equal(forgotten.status, 0, "forget failed: " + forgotten.stderr)
    assert.equal(added.status, 0, "commit add failed: " + added.stderr)
    const fact = query(home, "SELECT status, deleted_at FROM facts WHERE id = '" + factId + "'")[0]
    assert.ok(fact, "deleted fact row disappeared")
    assert.equal(fact.status, "deleted", "the deleted fact was resurrected by a stale snapshot")
    assert.ok(fact.deleted_at, "the fact tombstone must keep deleted_at")
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM commitments"), 1, "the concurrent commitment was lost")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("concurrency: two import --replace processes serialize without corrupting the ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-conc-import-"))
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  try {
    const { Ledger } = await import("../../core/dist/index.js")
    const makeLedger = (tag, commitActions) => {
      const ledger = new Ledger()
      const matter = ledger.addMatter({ title: "import " + tag })
      for (const action of commitActions) {
        ledger.addCommitment({ matterId: matter.id, debtor: "user", creditor: "someone", action, timezone: "Asia/Shanghai", capability: "todo", evidence: [{ sessionId: "cli", turnId: "cli", quote: "q" }] })
      }
      return ledger.toJSON()
    }
    const fileA = join(root, "import-a.json")
    const fileB = join(root, "import-b.json")
    writeFileSync(fileA, JSON.stringify(makeLedger("A", ["A1"]), null, 2))
    writeFileSync(fileB, JSON.stringify(makeLedger("B", ["B1", "B2"]), null, 2))
    const [a, b] = await Promise.all([
      runAsync(home, ["import", fileA, "--replace"]),
      runAsync(home, ["import", fileB, "--replace"]),
    ])
    assert.equal(a.status, 0, "import A failed: " + a.stderr)
    assert.equal(b.status, 0, "import B failed: " + b.stderr)
    const actions = query(home, "SELECT action FROM commitments ORDER BY action").map((row) => row.action)
    const isA = actions.length === 1 && actions[0] === "A1"
    const isB = actions.length === 2 && actions[0] === "B1" && actions[1] === "B2"
    assert.ok(isA || isB, "the final ledger must be exactly one import, got " + JSON.stringify(actions))
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM audit WHERE action = 'import.ledger'"), 2)
    assert.ok(readdirSync(home).some((name) => name.startsWith("import-backup-")), "import must keep its pre-import backup")
    const audit = cli(home, ["audit"])
    assert.equal(audit.status, 0)
    assert.match(audit.stdout, /audit: verified/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// 0.2.3 persistence v2 §4: the HOME lock protects WRITERS only. Pure reads open a
// read-only WAL snapshot and must keep working while a long-lived writer (mcp,
// bridge, older ui) holds it; writes still fail closed with E_DB_LOCKED.
const READ_ONLY_COMMANDS = [
  ["status"], ["today"], ["today", "--json"], ["who"], ["week"], ["risks"],
  ["receipt"], ["deliveries"], ["deliveries", "--json"], ["ls"], ["history"],
  ["memory"], ["memory", "search", "报价"], ["remind", "--json"], ["digest", "day"],
  ["tui", "--once"], ["pet-brief", "--json"], ["audit"], ["privacy"], ["doctor"],
  ["commit", "ls"], ["commit", "ls", "--json"], ["search", "报价"], ["prefs"],
  ["learn", "ls"], ["nudge", "list"],
]

function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex") }

test("read commands work while a live writer holds the lock; writes still fail E_DB_LOCKED", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-lock-readers-"))
  const home = join(root, "home")
  try {
    cliOk(home, ["commit", "add", "被锁期间仍可读", "--quote", "q"])
    const mcp = startMcp(home)
    try {
      assert.ok(await mcp.ready(), "mcp did not start: " + mcp.stderr())
      for (const args of READ_ONLY_COMMANDS) {
        const result = cli(home, args)
        assert.equal(result.status, 0, "advisers " + args.join(" ") + " must work while a writer holds the lock: " + result.stderr)
      }
      const write = cli(home, ["commit", "add", "blocked write", "--quote", "q"], { ADVISERS_LOCK_TIMEOUT_MS: "150" })
      assert.equal(write.status, 1, "a write must still fail closed while the writer lock is held")
      assert.match(stderrOf(write), /E_DB_LOCKED/)
      assert.equal(count(home, "SELECT COUNT(*) AS n FROM commitments"), 1, "the blocked write must not have landed")
      assert.equal(existsSync(lockFile(home)), true, "read commands must not remove the writer's lock")
    } finally { await mcp.stop() }
    assert.equal(existsSync(lockFile(home)), false, "mcp must release the lock on exit")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("pure read commands take no HOME lock and do not modify state.db", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-lock-readonly-"))
  const home = join(root, "home")
  try {
    cliOk(home, ["commit", "add", "只读不应改库", "--quote", "q"])
    const dbPath = join(home, "state.db")
    const before = sha256(dbPath)
    const beforeFiles = readdirSync(home).sort()
    for (const args of READ_ONLY_COMMANDS) {
      cliOk(home, args)
      assert.equal(existsSync(lockFile(home)), false, "advisers " + args.join(" ") + " must not create instance.lock")
    }
    assert.equal(sha256(dbPath), before, "pure reads must not modify state.db")
    const created = readdirSync(home).filter((name) => !beforeFiles.includes(name))
    assert.deepEqual(created.filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm")), [], "reads create no database/migration artifact")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("ui/tui are lock-free readers: no writer lock, no blocked writes, no DB mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-lock-ui-reader-"))
  const home = join(root, "home")
  try {
    cliOk(home, ["commit", "add", "ui 期间可写", "--quote", "q"])
    const dbPath = join(home, "state.db")
    const before = sha256(dbPath)
    const ui = startUi(home)
    try {
      assert.ok(await ui.ready(), "ui did not start: " + ui.stderr())
      assert.equal(existsSync(lockFile(home)), false, "ui must not hold the HOME writer lock")
      const tui = cliOk(home, ["tui", "--once"])
      assert.match(tui.stdout, /Advisers TUI/)
      assert.equal(sha256(dbPath), before, "ui/tui reads must not modify state.db")
      // A normal write lands while ui is serving its read-only snapshot.
      cliOk(home, ["commit", "add", "ui 运行期间的写", "--quote", "q"])
    } finally {
      ui.child.kill("SIGTERM")
      await Promise.race([ui.wait(), sleep(8000)])
      if (ui.child.exitCode === null) ui.child.kill("SIGKILL")
    }
    assert.equal(existsSync(lockFile(home)), false, "ui must not leave a lock behind")
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM commitments"), 2, "the concurrent write must have landed")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
