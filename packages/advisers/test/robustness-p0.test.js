import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { tosEnv } from "./tos-fixture.js"
import { DatabaseSync } from "node:sqlite"
import { encryptJson } from "../lib/vault.js"
import { research } from "../lib/research.js"
import { fetchImapMessages } from "../lib/imap.js"
import { SqliteStore } from "../lib/sqlite.js"

const bin = fileURLToPath(new URL("../bin/advisers.js", import.meta.url))
const binSource = readFileSync(bin, "utf8")
const baseEnv = {
  ...process.env,
  ADVISERS_CORE_LOCAL: "1",
  ADVISERS_OFFICE_LOCAL: "1",
  ADVISERS_NO_MODEL: "1",
  ADVISERS_STORE: "sqlite",
}
function env(home, extra) { return tosEnv(home, { ...baseEnv, ...(extra || {}) }) }
function cli(home, args, extra) {
  return execFileSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: "utf8" })
}
function cliFail(home, args, extra) {
  return spawnSync(process.execPath, [bin, ...args], { env: env(home, extra), encoding: "utf8" })
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
function db(home) { return new DatabaseSync(join(home, "state.db"), { readOnly: true }) }
function count(home, sql) { const database = db(home); try { return Number(database.prepare(sql).get().n) } finally { database.close() } }

test("robustness: fresh HOME history/deliveries/digest exit 0 (no empty-store crash)", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-robust-fresh-"))
  const home = join(root, "home")
  try {
    for (const command of [["history"], ["deliveries"], ["digest", "day"], ["digest", "week"]]) {
      const result = cliFail(home, command)
      assert.equal(result.status, 0, command.join(" ") + " exited " + result.status + ": " + result.stderr)
    }
    const checkDb = cliFail(home, ["audit", "--check-db"])
    assert.equal(checkDb.status, 0)
    assert.match(checkDb.stdout, /integrity: ok/)
    assert.match(checkDb.stdout, /audit: verified \(0 entries\)/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("robustness: concurrent first open never surfaces database is locked", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-robust-open-"))
  try {
    for (let round = 1; round <= 3; round++) {
      const home = join(root, "home-" + round)
      const results = await Promise.all([
        runAsync(home, ["commit", "add", "round " + round + " a", "--quote", "q"]),
        runAsync(home, ["commit", "add", "round " + round + " b", "--quote", "q"]),
      ])
      for (const result of results) {
        assert.equal(result.status, 0, "round " + round + ": " + result.stderr)
        assert.doesNotMatch(result.stderr + result.stdout, /database is locked/)
      }
      assert.match(cli(home, ["audit"]), /audit: verified \(2 entries\)/)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("robustness: concurrent commit add keeps every row and one linear audit chain", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-robust-conc-"))
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      runAsync(home, ["commit", "add", "并发 " + index, "--quote", "q"])))
    for (const result of results) assert.equal(result.status, 0, result.stderr)
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM commitments"), 8)
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM audit WHERE action = 'commit.add'"), 8)
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM (SELECT prev_hash FROM audit GROUP BY prev_hash HAVING COUNT(*) > 1)"), 0)
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM audit a LEFT JOIN commitments c ON c.id = a.reason WHERE a.action = 'commit.add' AND c.id IS NULL"), 0)
    const audit = cliFail(home, ["audit"])
    assert.equal(audit.status, 0)
    assert.match(audit.stdout, /audit: verified \(8 entries\)/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("robustness: concurrent first run creates exactly one O_EXCL audit key", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-robust-key-"))
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  try {
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      runAsync(home, ["commit", "add", "key " + index, "--quote", "q"])))
    for (const result of results) assert.equal(result.status, 0, result.stderr)
    assert.equal(readdirSync(home).filter((name) => name === "audit.key").length, 1)
    const key = readFileSync(join(home, "audit.key"), "utf8").trim()
    assert.ok(key.length >= 16)
    assert.match(cli(home, ["audit"]), /audit: verified \(5 entries\)/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("robustness: busy database fails the command closed (no JSON fallback, no orphan state.json)", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-robust-busy-"))
  const home = join(root, "home")
  try {
    cli(home, ["commit", "add", "seed", "--quote", "q"])
    const before = count(home, "SELECT COUNT(*) AS n FROM commitments")
    const lock = new DatabaseSync(join(home, "state.db"))
    lock.exec("PRAGMA busy_timeout = 0")
    lock.exec("BEGIN IMMEDIATE")
    let result
    try {
      result = cliFail(home, ["commit", "add", "locked", "--quote", "q"], { ADVISERS_SQLITE_BUSY_TIMEOUT_MS: "100" })
    } finally {
      lock.exec("ROLLBACK")
      lock.close()
    }
    assert.notEqual(result.status, 0)
    assert.match(result.stderr + result.stdout, /database is locked|could not write the ledger/)
    assert.equal(existsSync(join(home, "state.json")), false)
    assert.doesNotMatch(result.stderr + result.stdout, /falling back to JSON/)
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM commitments"), before)
    assert.doesNotMatch(binSource, /falling back to JSON/)
    const retry = cliFail(home, ["commit", "add", "after unlock", "--quote", "q"])
    assert.equal(retry.status, 0)
    assert.equal(count(home, "SELECT COUNT(*) AS n FROM commitments"), before + 1)
    assert.match(cli(home, ["audit"]), /audit: verified/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("robustness: migration backs up an old database and refuses a future schema", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-robust-migrate-"))
  const dbPath = join(root, "state.db")
  try {
    const seed = new SqliteStore(dbPath)
    seed.close()
    const raw = new DatabaseSync(dbPath)
    raw.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run("schema_version", "1")
    raw.close()
    const migrated = new SqliteStore(dbPath)
    migrated.close()
    assert.ok(readdirSync(root).some((name) => name.includes("before-migrate-v1")), "migration backup missing")
    const future = new DatabaseSync(dbPath)
    future.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run("schema_version", "999")
    future.close()
    assert.throws(() => new SqliteStore(dbPath), /newer than this CLI/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("robustness: research times out and retries 429 like the model client", async () => {
  const started = Date.now()
  await assert.rejects(
    () => research({ query: "q", apiKey: "k", timeoutMs: 200, retries: 0, fetchImpl: () => new Promise(() => {}) }),
    (error) => error.code === "TIMEOUT",
  )
  assert.ok(Date.now() - started < 5000, "timeout took too long")
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls === 1) return new Response("rate limited", { status: 429 })
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }), { status: 200 })
  }
  const result = await research({ query: "q", apiKey: "k", fetchImpl, retries: 1 })
  assert.equal(result.answer, "ok")
  assert.equal(calls, 2)
})

test("robustness: IMAP reports the server UID and rejects oversized literals", async () => {
  function mockServer(options) {
    const server = net.createServer((socket) => {
      let buffer = ""
      socket.write("* OK mock ready\r\n")
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        for (;;) {
          const index = buffer.indexOf("\r\n")
          if (index < 0) break
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const tag = line.split(" ")[0]
          if (/ LOGIN /i.test(line)) socket.write(tag + " OK LOGIN completed\r\n")
          else if (/ EXAMINE /i.test(line)) socket.write("* 1 EXISTS\r\n" + tag + " OK [READ-ONLY] EXAMINE completed\r\n")
          else if (/ UID SEARCH /i.test(line)) socket.write("* SEARCH 777\r\n" + tag + " OK SEARCH completed\r\n")
          else if (/ UID FETCH /i.test(line)) {
            if (options.oversize) {
              socket.write("* 1 FETCH (UID 777 BODY[] {999999999}\r\n")
              continue
            }
            const bytes = Buffer.from(options.raw, "utf8")
            socket.write("* 1 FETCH (UID 777 BODY[] {" + bytes.length + "}\r\n")
            socket.write(bytes)
            socket.write(")\r\n" + tag + " OK FETCH completed\r\n")
          } else if (/ LOGOUT/i.test(line)) socket.write("* BYE\r\n" + tag + " OK LOGOUT completed\r\n")
          else socket.write(tag + " BAD unknown\r\n")
        }
      })
    })
    return server
  }
  const raw = "From: wang@example.com\r\nMessage-ID: <uid-1@example.com>\r\n\r\nbody\r\n"
  const server = mockServer({ raw })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const messages = await fetchImapMessages({ host: "127.0.0.1", port: server.address().port, secure: false, user: "me", pass: "secret", limit: 5 })
    assert.equal(messages.length, 1)
    assert.equal(messages[0].uid, 777)
    assert.match(messages[0].raw.toString("utf8"), /body/)
  } finally { await new Promise((resolve) => server.close(resolve)) }
  const oversize = mockServer({ oversize: true })
  await new Promise((resolve) => oversize.listen(0, "127.0.0.1", resolve))
  try {
    await assert.rejects(
      () => fetchImapMessages({ host: "127.0.0.1", port: oversize.address().port, secure: false, user: "me", pass: "secret", limit: 5, maxLiteralBytes: 1024 }),
      /larger than the 1024-byte limit/,
    )
  } finally { await new Promise((resolve) => oversize.close(resolve)) }
})

test("robustness: sync pull refuses to overwrite a locally newer database", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-robust-sync-"))
  const homeA = join(root, "home-a")
  const homeB = join(root, "home-b")
  const dir = join(root, "sync")
  const pass = { ADVISERS_SYNC_PASSPHRASE: "correct horse battery" }
  try {
    cli(homeA, ["commit", "add", "snapshot 内容", "--quote", "q"])
    assert.match(cli(homeA, ["sync", "push", "--dir", dir, "--device", "device-a"], pass), /pushed/)
    cli(homeB, ["commit", "add", "本机更新", "--quote", "q"])
    const refused = cliFail(homeB, ["sync", "pull", "--dir", dir], pass)
    assert.equal(refused.status, 1)
    assert.match(refused.stderr + refused.stdout, /refusing to overwrite/)
    assert.match(cli(homeB, ["sync", "pull", "--dir", dir, "--force"], pass), /pulled/)
    assert.ok(readdirSync(homeB).some((name) => name.startsWith("state.db.before-sync-")), "pull backup missing")
    assert.match(cli(homeB, ["commit", "ls"]), /snapshot 内容/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("robustness: vault unseal validates the image before replacing the live database", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-robust-vault-"))
  const home = join(root, "home")
  const pass = "correct horse battery"
  try {
    cli(home, ["commit", "add", "秘密承诺", "--quote", "q"])
    const before = readFileSync(join(home, "state.db"))
    const garbage = Buffer.from("this is not a sqlite database")
    const payload = { kind: "advisers-db", version: "x", sha256: createHash("sha256").update(garbage).digest("hex"), db: garbage.toString("base64") }
    writeFileSync(join(home, "state.db.vault"), JSON.stringify(encryptJson(payload, pass)) + "\n")
    const failed = cliFail(home, ["vault", "unseal"], { ADVISERS_VAULT_PASSPHRASE: pass })
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr + failed.stdout, /integrity check/)
    assert.deepEqual(readFileSync(join(home, "state.db")), before)
    assert.equal(readdirSync(home).filter((name) => name.includes(".unseal-")).length, 0)
    assert.match(cli(home, ["commit", "ls"]), /秘密承诺/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("robustness: saveWithAudit writes ledger and audit atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-robust-pair-"))
  const dbPath = join(root, "state.db")
  try {
    const store = new SqliteStore(dbPath)
    store.save({ version: 1, matters: [], facts: [], commitments: [], preferences: [], links: [], updates: [], routines: [], routinePatches: [], routes: {} })
    store.saveWithAudit(
      { version: 1, matters: [], facts: [], commitments: [], preferences: [], links: [], updates: [], routines: [], routinePatches: [], routes: {} },
      { actor: "local", action: "commit.add", allowed: true, reason: "cm_atomic" },
    )
    assert.deepEqual(store.verifyAudit(), { ok: true, count: 1 })
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM audit").get().n, 1)
    store.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test("robustness: save merges concurrent additions and only deletes rows it loaded", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-robust-merge-"))
  const dbPath = join(root, "state.db")
  const empty = { version: 1, matters: [], facts: [], commitments: [], preferences: [], links: [], updates: [], routines: [], routinePatches: [], routes: {} }
  const commitment = (id, action) => ({ id, matterId: "m1", debtor: "user", creditor: "someone", action, dueAt: null, timezone: "Asia/Shanghai", status: "open", evidence: [], capability: "todo", doneAt: null })
  try {
    const seed = new SqliteStore(dbPath)
    seed.save({ ...empty, commitments: [commitment("cm_seed", "seed")] })
    seed.close()
    const owner = new SqliteStore(dbPath)
    assert.equal(owner.load().commitments.length, 1)
    const other = new SqliteStore(dbPath)
    other.load()
    other.save({ ...empty, commitments: [commitment("cm_seed", "seed"), commitment("cm_other", "other")] })
    other.close()
    // The owner loaded before cm_other existed: its save drops cm_seed, must keep cm_other.
    owner.save({ ...empty, commitments: [commitment("cm_owner", "owner")] })
    owner.close()
    const check = new SqliteStore(dbPath)
    const ids = check.load().commitments.map((row) => row.id).sort()
    check.close()
    assert.deepEqual(ids, ["cm_other", "cm_owner"])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("robustness: saveWithAudit rolls ledger and audit back together on failure", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-robust-atomic-"))
  const dbPath = join(root, "state.db")
  const empty = { version: 1, matters: [], facts: [], commitments: [], preferences: [], links: [], updates: [], routines: [], routinePatches: [], routes: {} }
  const matter = { id: "matter_1", title: "m", status: "active", domain: "general", secrecy: 0, participants: [], deadlines: [], openQuestions: [], createdAt: "2026-11-17T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z" }
  try {
    const store = new SqliteStore(dbPath)
    store.save(empty)
    assert.throws(
      () => store.saveWithAudit({ ...empty, matters: [matter] }, { actor: "local", action: "commit.add", allowed: true, reason: "cm_boom" }, () => { throw new Error("boom") }),
      /boom/,
    )
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM matters").get().n, 0)
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM audit").get().n, 0)
    assert.deepEqual(store.verifyAudit(), { ok: true, count: 0 })
    store.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("robustness: an invalid audit key fails closed instead of writing an unkeyed chain", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-robust-keyfile-"))
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  try {
    writeFileSync(join(home, "audit.key"), "short\n", { mode: 0o600 })
    const failed = cliFail(home, ["status"])
    assert.equal(failed.status, 1)
    assert.match(failed.stderr + failed.stdout, /audit key unavailable/)
    assert.equal(existsSync(join(home, "state.db")), false)
    writeFileSync(join(home, "audit.key"), "a".repeat(64) + "\n", { mode: 0o600 })
    assert.equal(cliFail(home, ["status"]).status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("robustness: sync pull refuses while another process holds the local database", () => {
  const root = mkdtempSync(join(tmpdir(), "advisers-robust-sync-busy-"))
  const homeA = join(root, "home-a")
  const homeB = join(root, "home-b")
  const dir = join(root, "sync")
  const pass = { ADVISERS_SYNC_PASSPHRASE: "correct horse battery" }
  try {
    cli(homeA, ["commit", "add", "snapshot 内容", "--quote", "q"])
    cli(homeA, ["sync", "push", "--dir", dir, "--device", "device-a"], pass)
    cli(homeB, ["commit", "add", "本机更新", "--quote", "q"])
    const lock = new DatabaseSync(join(homeB, "state.db"))
    lock.exec("PRAGMA busy_timeout = 0")
    lock.exec("BEGIN IMMEDIATE")
    let refused
    try {
      refused = cliFail(homeB, ["sync", "pull", "--dir", dir], { ...pass, ADVISERS_SQLITE_BUSY_TIMEOUT_MS: "100" })
    } finally {
      lock.exec("ROLLBACK")
      lock.close()
    }
    assert.equal(refused.status, 1)
    assert.match(refused.stderr + refused.stdout, /busy|locked/)
    assert.match(cli(homeB, ["sync", "pull", "--dir", dir, "--force"], pass), /pulled/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
