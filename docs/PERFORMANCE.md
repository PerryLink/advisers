# Performance

> Status: `0.5.0` (published 2026-11-22) is the current npm `latest` (`next` is also
> `0.5.0`) and the repository is at package version `0.5.0`. `0.5.0` is a feature release
> on the 0.4.3 tree with **no hot-path change** for the default read/write commands: its
> new commands are explicit one-shot filesystem operations (bundle export/import,
> context-pack create/verify, `sync status --check`, setup/demo/help), and the additive
> MCP/DSH `disclosure`/`view` metadata only adds bounded work to the read payloads. `0.4.3`
> was a patch on the
> 0.4.2 tree with **no hot-path change** (Chinese relative dates, local capture/inbox,
> the trust outputs and profile, the ICS/cooldown reminder work, payment channels and the
> receivable CSV export, the restore drill, the help short-circuit and the mail-watch
> contract only); 0.4.2 added manual fact entry, the read-only mail probe, foreground
> mail watch, the dry-run sync preview, the backup-age hint, subcommand help and the mail
> gold gate, and 0.4.1 added review-link wiring, the reminder delivery policy and
> contract/eval growth — also without a hot-path change. So
> the `0.4.0` measurements and limits below still apply. `0.4.0` is the single 0.4 feature release: KB (schema **v22**), mail entry, interactive shell, proactive briefs,
> policy/evidence 2.0 subset, receivables/payments, MCP modern dual-era and the Windows
> portable ZIP. It ships **one schema migration** (v21 → v22) and **no hot-path
> read-model rewrite**; the 0.3.0/0.3.2 numbers below were not re-measured on the 0.4.0
> tree, so they stay labelled as history rather than reused as 0.4.0 claims. The new 0.4
> surfaces are either off the default path (`mail sync` is an explicit, user-invoked
> network command) or bounded local queries; see "0.4.0" below for budgets and known
> limits. Every number here is marked with the tree it was measured on, is one shared
> host's measurement, and is not a service-level guarantee. `0.3.2`/`0.3.1`/`0.3.0` are
> historical baselines in this page; `0.2.4` was an unpublished candidate superseded by
> the 0.3.0 line.

How Advisers performs on the hot paths, how to reproduce the numbers, and which
behaviour the regression tests pin. This is a developer/operator reference, not
a service-level guarantee: **the numbers below are one shared host's measurements**
and move with CPU, disk, WSL/9p mounts and background load (±10–20% run-to-run is
normal). Treat medians as a rough instrument; only same-host, same-ledger,
one-process-at-a-time A/B comparisons are meaningful. CI pins behaviour and budgets,
never wall-clock thresholds.

## Measuring

```bash
pnpm -r build
node scripts/bench.mjs                         # 1k synthetic ledger, 5 reps
node scripts/bench.mjs --scale 5000 --reps 5   # ~8k-row evidence ledger
node scripts/bench.mjs --json > bench.json
node scripts/bench.mjs --home /tmp/my-advisers-home --bin /path/to/other/advisers.js
```

`scripts/bench.mjs` runs every CLI scenario in a fresh child process (peak RSS
comes from that child's `process.resourceUsage().maxRSS`) and reports medians
plus min/max. It is a developer tool, not a CI gate. Notes:

- Run it from a local ext4/tmp checkout. A network/9p mount inflates every file
  read and makes the numbers incomparable.
- The CLI gates non-exempt commands on a recorded terms acceptance. The
  benchmark seeds the acceptance record into its throwaway data home once via
  the documented non-interactive path (`advisers tos accept --accept-tos`) and
  also sets `ADVISERS_ACCEPT_TOS=1`, so gated scenarios measure the real command
  path instead of the exit-3 gate.
- The evidence-pack scenario passes `--all`: above 2000 entries the default cap
  is an intentional error, and the benchmark is meant to measure the pack build.
- PDF scenarios need a CJK font (`ADVISERS_PDF_FONT` or a common system font);
  they are skipped with a message when none is found.

To compare two builds on identical data, generate the data once with
`--keep`, then run the benchmark twice against that directory with `--home`
and a different `--bin` (one process at a time; concurrent runs distort each
other).

### The 200k read benchmark (0.3.0)

`scripts/bench-read-200k.mjs` is the reproducible 200k-ledger read benchmark used for
the 0.3.0 T1/T2 targets. It seeds the same synthetic shape the 0.3 planning research
used (200k facts, 100k commitments, 20k preferences, 10k deliveries, 10k model calls,
20 sessions; **no turns**; `state.db` ≈124 MB in the recorded runs), then measures
`status/today/today --json/remind/remind --json/tui --once/digest day/digest week/
pet-brief/pet-brief --json` plus the MCP first-call surface.

Two numbers per scenario:

- `wallMs` — fresh CLI child process, median of `--reps` runs (includes Node startup;
  the method `scripts/bench.mjs` uses);
- `writeBytes` — the child's `write_bytes` from `/proc/<pid>/io` (max sample across
  reps): SQLite WAL + temp spill + DB writes, not stdout. **This is the T1 acceptance
  metric** (target <1 MiB per read command). Windows has no `/proc`; there the check
  is functional only.

```sh
# 一次性播种（约 200k facts / 100k commitments；写 /tmp 或本地 ext4，别用 9p/网络盘）
node scripts/bench-read-200k.mjs --home /tmp/advisers-bench --seed
# 同一 home、一次一个进程；3 次中位
node scripts/bench-read-200k.mjs --home /tmp/advisers-bench --reps 3
node scripts/bench-read-200k.mjs --home /tmp/advisers-bench --reps 3 --json > bench.json
# A/B：--bin 指向另一棵树（同一 home、同一 session、交替跑）
node scripts/bench-read-200k.mjs --home /tmp/advisers-bench --reps 3 \
  --bin /tmp/advisers-baseline/packages/advisers/bin/advisers.js --no-mcp
```

Caveats that matter for every number in the 0.3.0 section: the bench ran on a **shared
host** (other jobs on the same machine), the recorded A/B is **interleaved baseline /
current rounds of 3 fresh children per scenario** (so it is a small-sample median, not a
distribution), and the synthetic ledger has **no FTS/turns content** — this section
measures read-model/SQL cost, not search.

## 0.3.0 (published 2026-11-20; historical measurement): 200k read A/B and the T1 write-amplification fix

Two changes on the 0.3.0 tree are measured here. 0.3.0 was published on 2026-11-20;
these are release-time measurements, subject to the shared-host caveats above.

### T1: remove the TEMP B-TREE spill behind read-command write amplification

The 0.2.x partial loaders appended `ORDER BY rowid` after a status predicate. The v20
status-leading indexes (`idx_facts_status_deleted`, `idx_commitments_status_due`) cannot
satisfy that order, so SQLite sorted every matching row into a TEMP B-TREE and spilled it
to disk: at 200k rows `pet-brief` wrote ~29 MB and `today` ~5.6 MB **per run** (reads
that were supposed to be read-only were writing tens of MB). 0.3.0 changes:

- `lib/sqlite.js` `loadFacts({validOnly})` — `expired_at IS NULL AND deleted_at IS NULL`
  as an index-key prefix so rowid order comes from the index (no sort/spill);
- `lib/sqlite.js` `loadCommitments({order})` — `'rowid'` (default, historical) /
  `'natural'` (index order, no sort) / `'table'` (`NOT INDEXED`, sequential scan in
  insertion order; cheapest when a predicate matches a large fraction of the table);
- the hot call sites (`today`, `today --json`, `remind`, `tui`, `digest`, `pet-brief`)
  moved to these loaders or to the projections below. The default `order` is unchanged,
  so load/export order is preserved;
- two **layout-only** indexes for the pet-brief projection
  (`idx_facts_status_confidence`, `idx_facts_valid_subject`, created `IF NOT EXISTS` on
  open). The read-path change itself adds **no migration**: the 0.3.0 tree is on schema
  **v21** (the additive customer-entity step), and the measured queries/indexes are
  unchanged.

The acceptance metric is process writes, not wall time: every read command must stay
<1 MiB of `write_bytes` (Linux). `test/perf-no-spill.test.js` seeds 60k facts / 20k open
commitments and asserts every measured read command stays under that budget (it skips on
Windows, which has no `/proc`); wall-clock thresholds are deliberately not asserted in CI.

### T2: narrow read-model projections

The view builders used to load whole entities (mapping evidence/reminder JSON,
defaults, sortable objects) for a handful of displayed columns. 0.3.0 adds narrow,
read-only SQL projections in `lib/sqlite.js` (`_project` uses
`setReturnArrays(true)` where available) and makes the view builders consume them:

| Projection | Used by |
|---|---|
| `projectOpenCommitmentsForToday` | `today` (human view) |
| `projectCommitmentsForReminders` | `remind`, `tui --once` |
| `projectCommitmentsForDigest` | `digest` |
| `projectCommitmentsForPetBrief` / `projectFactsForPetBrief` / `projectFactSubjectCandidates` / `projectCommitmentCreditorCandidates` | `pet-brief` |

Only status predicates move into SQL; **due-date comparisons stay in JS** because
`due_at` is text with mixed formats and SQL `julianday()` semantics differ from the
existing `Date.parse` behaviour. The projections return the same rows/columns in the
same historical (rowid) order, and `test/read-model-projections.test.js` pins
byte-identical view output plus plans without a TEMP B-TREE.

`today --json` keeps the full entities its JSON contract requires; it only avoids the
status-index + `ORDER BY rowid` sort (`order: 'table'`), so its **writes** collapse while
its wall time stays dominated by serializing ~27 MB of JSON to stdout.

### Measured A/B (200k synthetic ledger)

Baseline = the 0.2.4 tree (`35a51c3`). Current = the 0.3.0 tree
(`e1af67a`, 2026-11-20). Same `/tmp/advisers-bench-home` synthetic ledger (≈124 MB,
shape above), one process at a time, **medians of 3 fresh CLI children per scenario per
round, two interleaved rounds**, shared host. "Writes" = child `/proc/<pid>/io`
`write_bytes`, max sample.

| Scenario | 0.2.4 median | 0.3.0 dev median | Writes 0.2.4 → 0.3.0 |
|---|---:|---:|---:|
| `status --json` | 62 ms | 61 ms | 28 KB → 28 KB |
| `today` | 230 ms | 151 ms | 5.8 MB → 32 KB |
| `today --json` | 737 ms | 751 ms | 10.8 MB → 28 KB |
| `remind` | 1,041 ms | 335 ms | 28 KB → 32 KB |
| `remind --json` | 1,107 ms | 296 ms | 32 KB → 28 KB |
| `tui --once` | 972 ms | 216 ms | 32 KB → 28 KB |
| `digest day` | 551 ms | 226 ms | 32 KB → 28 KB |
| `pet-brief` | 2,171 ms | 399 ms † | 31.8 MB → 32 KB |
| `pet-brief --json` | 2,504 ms | 506 ms | 31.8 MB → 28 KB |

† `pet-brief` was re-measured in a second dedicated series: 3 interleaved baseline
rounds and 3 current rounds of 3 fresh children each (same host/ledger). Baseline median
2,171 ms → current median 399 ms; the other interleaved round measured 588 ms. The spread
(377–588 ms across rounds) is why 399 ms must not be read as "met".

MCP first-call surface (same ledger, `initialize` + first call per tool):

| Probe | 0.2.4 (35a51c3) | 0.3.0 dev |
|---|---:|---:|
| `initialize` | 81 ms, `protocolVersion: 2024-11-05` | 72 ms, `protocolVersion: 2025-11-25` (negotiated) |
| first `advisers_today` | 550 ms, **isError: true** (CONTENT_BLOCKED) | 573 ms, `isError: false`, 3.3 KB payload |
| first `advisers_commit_ls` | 56 ms, **isError: true** | 29 ms, `isError: false`, 8.6 KB |
| first `advisers_remind` | 485 ms, **isError: true** | 156 ms, `isError: false`, 4.5 KB |

The usability failure (`CONTENT_BLOCKED` on a 200k ledger) is fixed by the output caps
(docs/MCP.md §3.1); the MCP **first-call latency target (≤300 ms)** is still missed for
`advisers_today` because the first call still resolves the commitment+matters ledger
before the read model runs.

### 0.3.0 target status (engineering targets, not an SLA)

Targets are the 0.3.0 exit table (planning report 25 §5.3): same-host A/B at 200k,
median of 3, `write_bytes` for the write budget.

| Metric | Target | 0.3.0 dev measured | Status |
|---|---:|---:|---|
| `today` | ≤150 ms, <1 MB write | 151–158 ms median (min 131–138 ms), 32 KB | **borderline** (at target; not a clean pass) |
| `today --json` | ≤400 ms, <1 MB write | 751 ms, 28 KB | write met, **latency not met** (output-bound) |
| `remind --json` | ≤400 ms, <1 MB write | 296 ms, 28 KB | met |
| `digest day` | ≤200 ms | 226 ms (min 145–184 ms) | **borderline** |
| `tui --once` | ≤400 ms | 216 ms | met |
| `pet-brief` | ≤400 ms, <1 MB write | 399 ms (one round 588 ms), 32 KB | write met, **latency borderline** |
| MCP first call | ≤300 ms + usable | today 573 ms but usable (`isError:false`) | usability fixed, **latency not met** |
| write commands | ≤200 ms, WAL ≤1 MB (no regression) | 0.2.3 levels (not re-measured in this round) | not re-measured |
| `--version` | ≤100 ms (no regression) | not re-measured | not re-measured |

Read the table as: **T1 is delivered** (every measured read command writes ≤32 KB instead
of 5.8–31.8 MB), and the read-model work moved `remind`/`tui`/`digest` inside/near
target, but `today`/`pet-brief` are at the boundary and `today --json` remains
output-bound. Do not advertise the 0.3.0 performance table as fully met. No v21
(`due_ms`) migration was part of this change; the read-model work adds no migration
(the 0.3.0 tree's v21 adds customer entities, not `due_ms`).

## 0.2.3 vs the 0.2.2 baseline

The 0.2.3 change is **incremental writes + a lock-free read path**: the hot write commands
stop rewriting the whole ledger, and read commands stop needing the writer lock (see the
next section). Representative A/B on one host with a **200,000-row synthetic ledger**
(200k facts, 100k commitments, 200k turns, 20k preferences; 224.6 MB database), medians of
3 fresh CLI child processes per scenario, same data, one process at a time. "Bytes
written" is the child process's storage-write count (`write_bytes` in `/proc/<pid>/io`,
max sample; it includes WAL/DB writes and SQLite temp spill, not stdout). The 0.2.2 tree
is a clean copy of the published code; the 0.2.3 tree is the published release.

| Scenario | 0.2.2 | 0.2.3 | Bytes written 0.2.2 → 0.2.3 |
|---|---:|---:|---:|
| `status` | 78 ms | 102 ms | 8 KB → 37 KB |
| `today` | 571 ms | 317 ms | 9.8 MB → 5.3 MB |
| `today --json` | 641 ms | 598 ms | 9.8 MB → 9.8 MB |
| `who` | 743 ms | 779 ms | 9.8 MB → 9.8 MB |
| `receipt` | 167 ms | 147 ms | 41 KB → 37 KB |
| `deliveries` | 81 ms | 67 ms | 41 KB → 37 KB |
| `ls` | 1,948 ms | 74 ms | 41 KB → 0 |
| `memory search` | 2,125 ms | 163 ms | 3.4 MB → 3.3 MB |
| `remind --json` | 2,931 ms | 972 ms | 41 KB → 37 KB |
| `pet-brief` | 2,824 ms | 1,809 ms | 37 KB → 21.2 MB |
| `digest` | 1,866 ms | 641 ms | 41 KB → 37 KB |
| `tui --once` | 2,291 ms | 814 ms | 41 KB → 37 KB |
| `commit add` | 3,709 ms | 108 ms | 185 MB → 90 KB |
| `commit snooze` | 3,518 ms | 126 ms | 185 MB → 78 KB |
| `commit done` | 3,564 ms | 96 ms | 185 MB → 70 KB |
| `commit edit` | 3,442 ms | 96 ms | 185 MB → 61 KB |
| `correct` | 3,296 ms | 105 ms | 185 MB → 90 KB |
| `decay` | 3,325 ms | 175 ms | 185 MB → 41 KB |
| `forget` | 3,252 ms | 97 ms | 185 MB → 74 KB |
| `memory accept` | 3,334 ms | 105 ms | 185 MB → 86 KB |
| `tick` | 1,053 ms | 735 ms | 49 MB → 5.4 MB |
| `mcp --stdio` init | 1,850 ms | 91 ms | 41 KB → 41 KB |

Reading the table:

- **Writes are fixed**: all measured write commands now land at ~100–175 ms and write
  41–123 KB at process level instead of rewriting every table. The 0.2.2 single save
  wrote ~185 MB in total and grew the WAL by ~93 MB per command; 0.2.3 writes ~90 KB in
  total and grows the WAL by ~21 KB. This is the release's headline result.
- **`ls`, `memory search`, `mcp` init** are now partial/lazy reads: the full-table
  `load()` is gone from their path.
- **`today`** improved (571 → 317 ms) but still misses its ≤150 ms target; `today --json`
  (598 ms) is at its ≤600 ms target.
- **`remind`, `digest`, `tui`, `pet-brief`** improved but still miss the ≤400 ms read
  target (see "Known limits"): they are the remaining full-ledger read paths.
- `who` and `status` are within run-to-run noise of their 0.2.2 values (the read path
  changed but those commands were already partial-load).
- `pet-brief`'s measured process writes grow from ~37 KB to ~21 MB at 200k rows in this
  A/B (output and wall time stay correct). The write amplification is logged as a 0.3
  performance item rather than explained away here.

Targets from the 0.2.3 implementation plan at 200k rows: writes ≤200 ms and WAL ≤1 MB per
command (met), read commands ≤400 ms (met by `ls` and `memory search`; missed by
`remind`/`digest`/`tui`/`pet-brief`), `today` ≤150 ms (missed), `mcp` init ≤300 ms
(met), `status` ≤100 ms (102 ms, noise). Regression tests pin the read shapes
(`EXPLAIN`/throwing loaders) rather than wall-clock thresholds.

## 0.2.1 vs the 0.2.0 baseline

Representative run: synthetic ledger at `--scale 5000` (5,000 facts, 2,500
commitments, 5,000 turns, 8,000 evidence entries), 5 fresh child processes per
scenario, medians, local ext4 checkout, Node 24. "Before" is the 0.2.0 tree.

| Scenario | Before | After | Peak RSS before → after |
|---|---:|---:|---:|
| `--version` | 128 ms | 81 ms | 72.5 → 61.4 MB |
| `--help` | 126 ms | 82 ms | 72.5 → 61.4 MB |
| `status` | 210 ms | 164 ms | 99.7 → 85.3 MB |
| `today` | 226 ms | 193 ms | 99.8 → 86.1 MB |
| `tick` | 258 ms | 219 ms | 110.6 → 99.1 MB |
| `deliveries --pack --all` | 824 ms | 808 ms | 213.9 → 203.3 MB |
| `deliver --format pdf` | 917 ms | 685 ms | 217.3 → 162.4 MB |
| PDF text wrap (1,000 lines, in-process) | ~3.6 ms | ~3.9 ms | unchanged |

The benchmark rows include a small child-loader wrapper used to report peak
RSS, so the absolute numbers are slightly above a bare `advisers ...`
invocation. The wall-clock improvement is what the columns compare. A direct
`--version` A/B (25 interleaved spawns per build, no loader) measured a
130.2 ms → 85.3 ms median with the same RSS drop.

## 0.2.2 vs the 0.2.1 baseline

The performance change in this release is **partial ledger loading**: read-only commands
that only need part of the ledger no longer call the full 9-table `store.load()`. The
round-2 audit measured the old path at 488 ms for a 50k-row `load()`; `status` paid
664 ms with a 352 MB peak even though it needed only four counts.

Recorded medians on synthetic ledgers (one machine, ±10–20% run-to-run, same caveats as
above):

| Scenario | 50k rows before (0.2.1) | 50k rows after (0.2.2) | 100k rows after (0.2.2) |
|---|---:|---:|---:|
| `status` | 664 ms | 75 ms | 91 ms |
| `today` | 729 ms | 353 ms | 495 ms |

`status` reads indexed counts instead of materialising rows; `today` still loads the
commitment-related tables but skips the larger turn/summary/model-call tables. The
regression tests (`test/partial-load.test.js`, `test/perf-partial-load.test.js`) pin the
*behaviour* — loaders that must not run are replaced with throwing stubs and the SQL is
checked with `EXPLAIN` — rather than wall-clock thresholds, so CI stays stable.

Full-text search was rebuilt on FTS5 trigram indexes in 0.2.2; the v19→v20 migration in
0.2.3 keeps them and adds the `idx_turns_seq` early-stop index for the 2-character `LIKE`
fallback. Measured index sizes, migration cost and query medians are recorded in
[docs/ARCHITECTURE.md](ARCHITECTURE.md) §11. The 0.2.2 note that "the database grows
~2.8 MB at 50k turns" was measured on a tiny 9.7 MB database and understates the real
cost: at 50k–200k turns the trigram index is ≈0.8–0.9× the indexed content and **≈19–20%
of the database** (10.6 / 21.1 / 42.5 MB at 50k / 100k / 200k turns).

## What changed in 0.2.3 and why

### Incremental writes: stop rewriting the whole ledger

Through 0.2.2 every write command ran a full 9-table `load()`, mutated the in-memory
ledger, and saved the complete snapshot in one transaction: at 200k rows that rewrote
~185 MB of WAL and took 3.3–3.7 s per `commit add`/`correct`/`memory accept`. 0.2.3 adds
directed entity INSERT/UPDATE paths (`lib/sqlite.js`) driven by pure operations in
`packages/core/src/ops.ts`: each command changes only its rows plus one audit row inside
one `BEGIN IMMEDIATE` transaction. Validation and file checks stay outside the
transaction; the JSON-store fallback keeps the legacy in-memory path. Rollback leaves the
ledger and the audit chain unchanged together.

### Lock-free read path

Reads no longer take the cross-process writer lock or open a writable store. They use a
`readOnly` SQLite connection that performs no DDL, migrations or journal-mode pragmas, so
they keep working while a long-lived `ui`/`mcp` process holds the writable store, and
they read the last committed WAL snapshot. Stale or future schemas fail with explicit
`E_SCHEMA_STALE`/`E_SCHEMA_NEWER` instead of accidentally writing. The read path also
loads only the tables a command needs (0.2.2 introduced partial loading for six commands;
0.2.3 extends it to `ls`, `memory search`, `evidence show`, `tui`, `remind`, `digest`,
`pet-brief`, `today` and the MCP first call).

### `mcp` initialization is lazy

`mcp --stdio` no longer loads the whole ledger at startup. `initialize` is protocol-only;
the writable store and per-tool partial loads happen on demand, so a client's startup cost
dropped from 1,850 ms to 91 ms at 200k rows.

### `doctor` split

The default `doctor` path is lightweight: it no longer takes the writer lock and no longer
runs the O(database) `quick_check`, FTS integrity, WAL sidecar, backup and plaintext/temp
scans. Those moved behind `doctor --check-db` (and `audit --check-db`), which is the
explicit maintenance path.

### FTS space measured properly

The 0.2.2 trigram-index cost note was measured on a 9.7 MB database and reported "+2.8 MB
(+28.7%) at 50k turns". At realistic ledger sizes the trigram index is much larger in
absolute terms (42.5 MB at 200k turns) but a stable share of the database (≈19–20%). The
corrected measurement, migration cost and query medians are in
[ARCHITECTURE.md](ARCHITECTURE.md) §11.

## What changed in 0.2.1 and why

### CLI startup: lazy imports for command-specific modules

`bin/advisers.js` used to statically import the model/agent stack, the safety
classifier (through Pet Brief / capture / research), the Pet Brief builder, the
read-only UI server, IMAP, review helpers, undo/diff and context-window helpers.
Every command, including `--version` and `--help`, paid for that compiled graph
(~60–75 ms and a larger heap). They are now memoized dynamic imports that load
on first use (`--version`/help no longer create a home directory or touch the
store). No command semantics changed: each command awaits only the modules its
path actually uses.

### `tick`: bounded nudge-outcome reads

`tick` reads the newest nudge outcomes for commitments it is about to nudge.
The 0.2.0 batching query windowed over the whole `nudges` table
(`ROW_NUMBER() OVER (PARTITION BY commitment_id ...)` with no predicate), so it
scanned and sorted the entire nudge history on every tick. Tick now passes the
candidate commitment ids it actually needs (`recentNudgeOutcomes(limit, ids)`);
the read becomes one index seek per candidate on
`idx_nudges_commitment_at`, bounded by the candidate set rather than by how long
the user has been running Advisers. The whole-table form is still available for
callers that need it. On a 200k-row nudge history, the bounded read for 500
candidates takes single-digit milliseconds (the bounded cost is asserted at
< 50 ms in `test/perf-regression.test.js`), and a full `tick` over a 200k-nudge
database dropped by ~280 ms in an A/B run with byte-identical output.

### PDF: byte-deterministic output

`buildSimplePdf()` embeds the caller's generation time as visible text, but
pdf-lib's `PDFDocument.create()` also stamps the wall clock into the PDF
`/CreationDate` and `/ModDate` info entries. Identical input therefore produced
different bytes whenever two builds crossed a wall-clock second, which made the
PDF regression test flaky and made byte-level comparisons of generated PDFs
unreliable. Both dates are now pinned to the `createdAt` input, so the same
input always serializes to the same bytes. There is no output change for a
given generation time beyond those two info entries.

### Office: load only what a command needs

- `deliver --format pdf` no longer imports the office barrel (exceljs,
  pptxgenjs and the read/check helpers); PDF output does not need
  `advisers-office` at all. This is the largest single win in `deliver` and also
  means PDF delivery works even when the optional office peer is not installed.
- `deliveries --pack` builds its receipt with the `docx` and `validate`
  submodules instead of the barrel.
- `doctor` answers "is `advisers-office` installed?" with a module-resolution
  probe instead of importing (and evaluating) the barrel.

## Regression tests

`packages/advisers/test/perf-regression.test.js` pins:

- PDF byte determinism for identical input, including that `/CreationDate` and
  `/ModDate` carry the supplied generation time (not the wall clock);
- the wrap algorithm equivalence and the format/limit behaviour of `today`,
  `tick` and `deliver`;
- batch nudge helpers (`addNudges`/`countNudges`/`recentNudgeOutcomes`) keep
  the per-row semantics, and the bounded outcome read stays index-bounded with a
  200k-row nudge history (< 50 ms for 500 candidates).

0.3.0 adds two Linux-focused read-path suites (no wall-clock assertions; CI stays
stable on shared runners):

- `packages/advisers/test/perf-no-spill.test.js` — seeds 60k facts / 20k open
  commitments and asserts every measured read command's `/proc/<pid>/io`
  `write_bytes` stays <1 MiB (the T1 acceptance). Skips on Windows (no `/proc`).
- `packages/advisers/test/read-model-projections.test.js` — the narrow projections
  return the rows/columns the views used to see, in historical rowid order, with no
  `USE TEMP B-TREE FOR ORDER BY`, and `buildReminders`/`buildPetBrief`/`buildDigest`
  produce byte-identical output from projected rows (including the pet-brief v0.2
  vectors).

0.4.0 adds **no wall-clock regression test**. The new suites are behavioural and
deterministic rather than timing-based: KB FTS integrity/degraded fallback, the v22
migration + rollback, mail cursor/credential handling, policy/consent and receivables
arithmetic. If a future change makes a 0.4 surface a hot path, add a write-byte/no-spill
case as above instead of a timing threshold.

```sh
cd packages/advisers
node --experimental-strip-types --test test/perf-no-spill.test.js
node --experimental-strip-types --test test/read-model-projections.test.js
node --experimental-strip-types --test test/perf-regression.test.js
```

Note for future changes: the **write-byte budget is the regression signal**, not wall
time. If a new read path reintroduces `ORDER BY rowid` after a status predicate, the
no-spill suite fails even when a fast machine hides the cost.

## 0.3.2 (historical measurement; superseded by 0.4.0)

0.3.2 adds two opt-in bounded paths; the flagless CLI output stays v1-compatible.
Measured 2026-11-20 on an ext4 copy of the tree (Node 24.22.1, shared host) against
the 200k synthetic ledger seeded by `scripts/bench-read-200k.mjs --seed` (100k
commitments / 66,667 open). The A/B base is the `v0.3.1` tree (`9fd2e35`), the fix
is the 0.3.2 tree, one process at a time (the ±10–20% host caveat above applies):

| Scenario | 0.3.1 | 0.3.2 | output |
|---|---:|---:|---:|
| MCP first call `advisers_today` | 461 ms | **97 ms** | 3,313 B (identical) |
| MCP first call `advisers_who` | 439 ms | **108 ms** | 15,427 B (identical) |
| MCP first call `advisers_commit_ls` | 416 ms | **158 ms** | 8,607 B (identical) |
| MCP first call `advisers_remind` | 476 ms | **223 ms** | 4,542 B (identical) |
| `today --json` (flagless) | 786–795 ms | 795 ms | 27,374,336 B (unchanged) |
| `today --json --limit 100` | — | **152 ms** | 194,776 B |
| `today --json --limit 50` | — | **148 ms** | 97,273 B |
| `today --json --limit 1000` | — | **249 ms** | 1,750,638 B |

- MCP: the four list tools read a narrow commitment projection
  (`SqliteStore.projectCommitmentReadModel()`) on first use instead of mapping the
  whole ledger into `Ledger` entities; `who` hydrates only its capped rows. Tool
  payloads are byte-identical to 0.3.1 in the A/B run (same byte counts and
  sha256). The first-call target (≤300 ms for today/who/commit_ls, ≤400 ms for
  remind) is met on the measured host — an instrument, not an SLA.
- `today --json --limit N`: classifies the narrow projection and hydrates only the
  capped rows, the same way the human view already worked. `counts`/`next` stay
  the full totals and the flagless bytes are unchanged. **A default cap is
  intentionally not part of 0.3.2**: it would change the v1 meaning of the group
  arrays (“arrays are complete”); that is a later (0.4) decision.
- Both paths are read-only; `today --json` still writes only the ~28–32 KB
  snapshot bytes (T1 fix unchanged). No schema/index/migration change.

## 0.4.0 (published 2026-11-21): new surfaces, budgets and known limits

0.4.0 does **not** rewrite a hot read path. It adds one schema migration and several
opt-in/local surfaces; this section records what was measured, what is a design budget, and
what is explicitly not on the default path. The 0.4.0 release did **not** re-run the 200k
read benchmark, so the budgets below are engineering targets and the 0.3.0/0.3.2 A/B tables
remain the latest release-time evidence. No CI job asserts wall-clock thresholds for any
0.4.0 surface.

### Schema v22 migration (one-time cost)

- One transactional migration (`kb-mail-payment-entities`) adds the KB, mail and money
  tables plus the two KB FTS indexes. It is **DDL only** and does not rewrite existing
  tables. Design budget for the DDL step: **≤200 ms on a 200k-row ledger** (derived, not
  release-measured).
- The dominant one-time cost is the pre-migration full-database copy
  (`state.db.before-migrate-v21-*`), which scales with database size (the 200k-read
  fixture DB was ≈124 MB). The copy is verified before the migration proceeds and is disk
  I/O, not CPU. It runs once per home, not once per command.
- New/empty FTS indexes are created inside the step; existing rows are not re-indexed.
  `kb reindex --rebuild` is the explicit verify/repair path.
- One-way upgrade: a 0.3.2 binary refuses a v22 database with `E_SCHEMA_NEWER`; the
  rollback is restoring the pre-migration copy (or export → fresh import into a 0.3.x
  home), not a reverse migration.

### KB search: FTS5 trigram plus an honest degraded fallback

0.4 design-research measurements (20k-chunk / 46.4 MB-text corpus; **not** a release gate):

| What | Measured |
|---|---|
| `kb_fts` size | ≈30.5 MB (≈0.66× of the indexed text) |
| whole database | ≈109.6 MB (≈2.4× the text) |
| 2-character CJK `MATCH` | 0 rows (trigram needs 3+ characters) → `LIKE` fallback |
| full-corpus 2-character `LIKE` | 16.8 ms / 20k chunks (≈0.8 ms per 1k chunks) |
| `ORDER BY rank`, popular term (20k hits) / rare term | 8.34 ms / 0.04 ms |
| insert 50k chunks / `kb reindex --rebuild` | ≈2.4 s / ≈666 ms |
| FTS `integrity-check` | 473 ms / 20k chunks |

Design budgets at 10k docs / 50k chunks (no wall-clock test pins these; CI asserts the
behaviour and the indexes, not the timings):

- `search --scope kb` p95 ≤50 ms for `MATCH` (3+ characters), ≤150 ms for the 2-character
  `LIKE` path; the JSON reports `degraded` instead of silently returning zero rows;
- `kb add` 100 md/txt files ≤3 s; `kb ls`/`kb show` p95 ≤50 ms;
- `kb reindex --rebuild` 50k chunks ≤2 s; `doctor --check-db` with both KB indexes ≤3 s.

Known KB limits: the trigram index is large (chunks are raw extracted text; in the
measurement above `kb_fts` is ≈0.66× the indexed text and ≈28% of the whole database —
comparable to, and in that corpus a little larger than, the ≈19–20% share of the turn FTS);
a 2-character `LIKE` is a linear scan (extrapolated ≈170 ms at 200k chunks); extraction is
I/O/PDF-complexity bound
(`maxFileBytes=50MB`, `maxTextBytes=2MB`, `maxPdfPages=500`), a truncated document sets
`truncated`, and image-only files are marked `needsOcr` rather than silently indexed. There
is no model or vector path in 0.4.0.

### Mail sync is not on the default path

`mail sync` is the only new network command and the only mail path that contacts a server.
It is user-invoked, TLS-only, read-only (`EXAMINE`/`FETCH BODY.PEEK[]`), restart-safe via a
UIDVALIDITY/UID cursor, and has no daemon, timer or retry loop. Every other mail command
(`import`, `ls`, `show`, `extract --local`, `purge`) is local-only. No wall-clock number is
recorded for sync: transfer time is dominated by the remote IMAP server and the network;
the local cost is per-message parsing plus bounded row inserts in one transaction. Body
retention defaults to 30 days; purge runs only when invoked.

### Shell, MCP modern and the new local commands

- The interactive shell is one process (`node` + `readline`) and pays normal CLI startup
  plus the initial read-only ledger load; it has no preloading, background refresh or
  persisted history, and it is not on any `--json`/non-TTY path (piped stdin keeps the old
  one-shot/help behaviour).
- MCP modern dual-era adds per-request `_meta` validation and a result envelope
  (`resultType`, optional `ttlMs`/`cacheScope`) but no new tool catalogue and no additional
  ledger load; legacy responses stay byte-identical in tests. No A/B latency measurement
  was recorded for the modern path.
- Receivables/payments, consent and client status packs are indexed reads and bounded file
  hashing; money amounts never enter MCP or receipt packs. Receipt pack v2 evidence counts
  are linear in the packed entries, and the existing 2000-entry evidence cap and receipt
  resource caps are unchanged (`docs/DELIVERY-RECEIPT.md`).
- The Windows portable ZIP is a packaging step (`scripts/pack-portable.mjs` /
  `scripts/portable-zip.mjs`), not a runtime path.

## Known limits

- Synthetic data: the generators mirror the audit ledger shape (facts,
  commitments, preferences, turns, deliveries, model calls) but not a real
  user's attachment layout, FTS content or matter distribution. The 200k read
  benchmark deliberately seeds **no turns**, so it does not measure FTS/search.
- Peak RSS is the child's `maxRSS`, sampled once per process; it includes the
  loader/Node baseline and is not a heap profile.
- Timing medians move with host load (the recorded runs varied by roughly
  ±10–20% on a shared machine), and the 0.3.0 A/B is a small-sample median of
  interleaved rounds. Compare two builds on the same host, in the same session,
  one at a time; the margins around `today`/`pet-brief` are inside that noise band.
- Partial loading covers the read commands (`status`, `today`, `who`, `week`,
  `receipt`, `deliveries`, and since 0.2.3 also `ls`, `memory search`, `evidence show`,
  `tui`, `remind`, `digest`, `pet-brief`, the MCP first call and the read-only `ui`
  snapshot); `tick`, `export`/`import` and delivery packs still need the whole ledger.
- 0.3.0 read-model work is **not a schema change** on that tree: the 0.3.0 tree is schema
  v21 from the additive customer-entity migration, and the measured queries/indexes are
  unchanged. The planned `commitments.due_ms` time-window migration is still not part of
  any release, so date filtering still runs in JS for `today`/`remind`/`agenda` on the
  **0.4.0 tree (schema v22)** too.
- 0.4.0 has **no fresh 200k A/B**: the v22 migration, KB FTS growth and shell startup were
  not re-measured on the release tree, and no 0.4.0 number in this page is a release-time
  measurement. The T1 write-byte budget (`test/perf-no-spill.test.js`) and the narrow
  projection suites are unchanged and still pin behaviour, not wall time.
- After 0.3.2, the remaining 200k item is the **flagless** `today --json` wall time
  (output-bound: ~27 MB stdout, write side fixed); use `--limit` for the bounded
  path. The 0.3.2 MCP first-call target is met on the measured host (today 97 ms,
  who 108 ms, commit_ls 158 ms, remind 223 ms vs 461/439/416/476 ms on 0.3.1),
  and `today`/`pet-brief` medians remain near their targets. Do not advertise any
  of these as a service-level guarantee.
- `pet-brief`'s 29–32 MB write amplification is fixed (now ~32 KB/run). `memory search`
  still writes several MB during a run at 200k rows; that path was not part of T1 and
  large-ledger FTS IO remains backlog.
- The write-command numbers in the 0.2.3 section were not re-measured on the 0.3.0 or
  0.4.0 trees; the incremental-write design is unchanged, so they are expected to hold,
  but a release re-measurement is required before any release claim.
- On Windows there is no `/proc/<pid>/io`, so the write-byte budget suite skips and the
  T1 metric is Linux-only (see `test/perf-no-spill.test.js`).
