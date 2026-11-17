# Performance

> Status: measured for the `0.2.1` release (2026-11-17). The `0.2.0` tree is the "before"
> baseline in the comparison below.

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

## What changed and why

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
- The full-loaded store paths (`status`, `today`, `receipt`, `deliver`) still
  read the whole ledger; that is a separate, larger redesign and is not covered
  by this release's optimisations.
