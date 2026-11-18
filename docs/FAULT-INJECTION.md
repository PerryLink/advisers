# Fault injection

Status: 2026-11-18, covering the 0.2.3 development line. This page describes a
test suite that is in the repository and runs in CI; it does not claim that the
software is free of crash, corruption, or disk-full bugs.

## 1. What the suite is

`scripts/fault-injection.mjs` is a standalone fault-injection suite. It
spawns the real CLI (`packages/advisers/bin/advisers.js`) against
temporary `ADVISERS_HOME` directories, injects a realistic failure, and then
asserts end-to-end invariants on the surviving data:

- `PRAGMA quick_check` still reports `ok`;
- the audit hash chain still verifies and its entry count matches the queryable
  write count (no audit row without data, no data without audit row);
- row counts either keep the old value or contain the new value - never a
  partially-written state;
- no truncated or half-installed file is left behind (vault, backup, WAL);
- the next command after the failure can recover and commit again.

The 0.2.2 robustness audit found that existing tests covered library-level
atomicity but not "the process dies in the middle of a real write". This suite
closes that gap for the highest-risk paths. It does not replace
`pnpm -r test`; it is an additional layer.

## 2. How to run it

Requirements: Node >= 22.16 (it uses `node:sqlite` and FTS5 trigram),
and a completed build of the local workspace packages:

    pnpm install
    pnpm -r --if-present run build
    node scripts/fault-injection.mjs

Useful flags:

    node scripts/fault-injection.mjs --verbose   # print stack traces for FAILs
    node scripts/fault-injection.mjs --keep      # keep the temporary homes for inspection

Everything runs in a temporary directory under `os.tmpdir()` and is
deleted afterwards unless `--keep` is used. The suite needs no network
access and no root privileges (the one optional real-disk test uses unprivileged
user namespaces and is skipped when they are unavailable).

Output is one line per case - `PASS`, `SKIP`, or `FAIL` - followed by a
summary. Exit codes:

| Exit code | Meaning |
|---|---|
| 0 | every case passed (SKIPs are allowed and always printed with a reason) |
| 1 | at least one case failed |
| 2 | the suite could not run: missing build, missing FTS5 trigram support, or a broken CLI baseline |

## 3. What is covered

All cases use a fresh temporary home seeded through the normal CLI
(`init` + `commit add`), so they also exercise the real on-disk
schema and audit chain.

| Case id | Fault injected | Invariants asserted |
|---|---|---|
| `crash-before-commit` | `SIGKILL` after `BEGIN IMMEDIATE` of a `commit add` write transaction (before `COMMIT`) | uncommitted row is not visible, commitment and audit counts unchanged, `quick_check` ok, `doctor --check-db` passes, no corrupt-file residue, next write commits |
| `crash-after-commit` | `SIGKILL` after `COMMIT` but before checkpoint/clean close | committed row and its audit row survive WAL recovery, `quick_check` ok, `doctor --check-db` passes |
| `migration-interrupted` | `SIGKILL` inside a schema v19 -> v20 migration transaction | schema stays 19 (no partial migration), `quick_check` ok, verified `"state.db.before-migrate-v19-*"` backup (schema 19 + same row counts), retry migrates to 20 with rows intact |
| `migration-failure-rollback` | injected error in the v20 migration step | command fails with the error surfaced, transaction rolls back to v19, verified pre-migration backup, retry succeeds |
| `wal-invalid-header` | committed WAL with a zeroed header | `E_WAL_CORRUPT` warning, exact corrupt bytes preserved as `state.db-wal.corrupt-<ts>`, WAL quarantined, database and audit still verify |
| `wal-truncated` | committed WAL with a torn (partial) frame | `E_WAL_TRUNCATED` warning, WAL preserved as evidence, valid prefix recovered, database and audit still verify |
| `fts-desynchronised` | FTS sync trigger dropped + a row inserted directly | `doctor --check-db` reports `db-fts` FAIL with `state=inconsistent`; `search` still returns the row through the `LIKE` fallback with a warning instead of silently dropping hits |
| `enospc-fs-stub` | filesystem stub throws `ENOSPC` on temp-file writes and backup copies | `vault seal` and `backup` fail with an actionable `E_NO_SPACE` message, no truncated vault/backup or temp file is installed, database intact, clean retry succeeds |
| `enospc-tmpfs` | real 2 MiB tmpfs filled until only 8 KiB remain, then a `commit add` | commit is refused (clean non-zero exit), the refused row is absent, after freeing space `quick_check` is ok, retry commits, audit verifies |

The `enospc-tmpfs` case runs only on Linux where `unshare -rm` and
`mount -t tmpfs` are permitted; otherwise it reports `SKIP` with the
reason. A `SKIP` is not a pass: the summary always shows it.

### How the crash points are made deterministic

The suite does not race a timer against the CLI. It writes a small CommonJS
preload and starts the CLI with `NODE_OPTIONS=--require <preload>`. The
preload wraps `node:sqlite`'s `DatabaseSync.prototype.exec`, and when the
requested transaction (or the v20 migration SQL) is reached it writes a marker
file and blocks the process. The suite polls for the marker and only then sends
`SIGKILL`, so the kill lands at the intended point every time.

## 4. CI wiring

- The Ubuntu `test` job runs `node scripts/fault-injection.mjs` once, on
  the minimum supported Node (22.16). It is not repeated on Node 24 to keep the
  matrix fast.
- The `windows-smoke` job does not run this suite. That job is a smoke job:
  frozen install, build, packaging smoke, and a minimal CLI flow on a temporary
  home (version/init/status/commit add/commit ls/doctor). Windows-specific fault
  coverage is listed as a known gap below.
- Static checks run on both Ubuntu matrix entries through
  `node scripts/check-js.mjs`.

## 5. Limitations (honest scope)

- **No real power loss or hardware failure.** `SIGKILL` is a process-level
  crash. The suite cannot prove durability across an actual power cut.
- **`ENOSPC` injection is a syscall stub by default.** The
  `enospc-fs-stub` case replaces the filesystem call to reproduce the error
  path; the `enospc-tmpfs` case checks a genuinely full filesystem but only
  where user namespaces and tmpfs mounting work. If that case SKIPs, the suite
  has not exercised a real full disk.
- **Windows is not covered.** Crash and filesystem-stub cases are Linux-oriented
  and SKIP elsewhere; the Windows CI job is a smoke job only. Windows
  `EPERM`/`EBUSY` retry behaviour is covered by unit tests
  (`packages/advisers/test/fs-safe.test.js`, `bin-fs-safe.test.js`), not by
  this suite.
- **FTS case covers detection and fallback, not repair.** It asserts that
  `doctor --check-db` reports the inconsistency and that search falls back to
  `LIKE`. An automated index rebuild is not exercised by this suite.
- **Not covered yet:** vault seal/unseal crash windows, sync push/pull crash
  windows, import backup failures, long-lived ui/mcp process crashes,
  network/IMAP failures, Office parser faults, concurrency stress, and
  large-ledger timing. These are candidates for 0.3.
- The suite proves the sampled invariants hold; it does not prove the absence of
  bugs.
