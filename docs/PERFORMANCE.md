# Performance

> Status: measured for the published `0.2.3` release (2026-11-18), which is still npm
> `latest`. `0.2.4` is a release candidate with no runtime or behavioural change, so
> these numbers describe it too. The `0.2.2`, `0.2.1` and `0.2.0` trees are the "before"
> baselines where a comparison says so below.

How Advisers performs on the hot paths, how to reproduce the numbers, and which
behaviour the regression tests pin. This is a developer/operator reference, not
a service-level guarantee: the numbers below are one machine's measurements and
move with CPU, disk and background load.

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

## Known limits

- Synthetic data: the generator mirrors the audit ledger shape (facts,
  commitments, preferences, turns, deliveries, model calls) but not a real
  user's attachment layout, FTS content or matter distribution.
- Peak RSS is the child's `maxRSS`, sampled once per process; it includes the
  loader/Node baseline and is not a heap profile.
- Timing medians move with host load (the recorded runs varied by roughly
  ±10–20% on a shared machine). Compare two builds on the same host, in the same
  session, one at a time.
- Partial loading covers the read commands (`status`, `today`, `who`, `week`,
  `receipt`, `deliveries`, and since 0.2.3 also `ls`, `memory search`, `evidence show`,
  `tui`, `remind`, `digest`, `pet-brief`, the MCP first call and the read-only `ui`
  snapshot); `tick`, `export`/`import` and delivery packs still need the whole ledger.
- The 0.2.3 targets that are still missed at 200k rows are `today` (317 ms vs ≤150 ms) and
  the remaining full-ledger read commands `remind` (972 ms), `digest` (641 ms), `tui`
  (814 ms) and `pet-brief` (1,809 ms) against the ≤400 ms target. They are 0.3 work;
  do not advertise the 0.2.3 read targets as fully met.
- `memory search` and `pet-brief` write several MB during a run at 200k rows (`pet-brief`
  ~21 MB); large-ledger IO for these paths is part of the 0.3 performance backlog.
