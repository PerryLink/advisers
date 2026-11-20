# Deterministic eval suite (`pnpm eval:det`)

> Status: introduced in the 0.3.0 line (published 2026-11-20). This tree is
> `advisers@0.3.1`; 0.3.1 is a release-metadata patch with no runtime changes, so the
> suite is the same release gate for the deterministic contract, not a claim about
> model quality.

`eval/` also contains the older **manual, real-model** runners
(`eval/run-*.mjs`, see [eval/README.md](../eval/README.md)). Those need a
provider key, cost tokens, and are not CI gates. This page documents the other
half: `eval:det`, a no-key / no-network suite that is intended to be green in
CI and in the release evidence. It is **wired as a required CI step** (the `test`
job runs `pnpm eval:det` after the workspace build) and remains a release-gate
input; also run it explicitly when cutting a release.

## Quick start

```sh
pnpm install
pnpm -r build          # eval:det imports the built workspace (core dist + bin)
pnpm eval:det          # ~20s, no API key, no network
```

Optional flags (the same script is `node scripts/eval-det.mjs`):

```sh
pnpm eval:det --suite determinism,mcp     # run a subset
pnpm eval:det --suite tui                 # opt-in 0.3.0 TUI gate (see below)
pnpm eval:det --list                      # list case ids
pnpm eval:det --json --no-write           # machine output, keep results/ clean
pnpm eval:det --out /tmp/det.json         # write one result file elsewhere
pnpm eval:det --update-baseline           # re-record golden values (review diff!)
```

Runner exit codes: `0` every gate passed, `1` at least one gate failed,
`2` bad flags / missing build / unreadable baseline.

Every run writes `eval/det/results/det-<UTC-stamp>.json` plus
`eval/det/results/latest.json`. The directory is gitignored: results are
evidence for a specific run, not source. A failed run still writes its result
(that is the point).

## What it gates

| Group | Gate | What breaks it |
|---|---|---|
| `determinism` | Same ledger + same Shanghai day => same `morning.dataSha256` across processes (1s apart, 09:00 vs 11:00); the hash changes on the next day and after a ledger change; `morning` markdown is byte-stable; `agenda --json` is byte-stable with a fixed clock; golden values from `eval/det/baseline.json` | wall-clock leakage into the morning report, unstable ordering, a changed hash scope, non-deterministic markdown |
| `mcp` | `initialize` echoes the legacy protocol version `2024-11-05`; `tools/list` contains the 7 documented tools in a stable order with `inputSchema`; `resources/list` contains the 4 `advisers://` resources; a read tool returns JSON text; JSON-RPC rejection codes stay `-32601` (method), `-32602` (tool/args), `-32002` (resource), `-32700` (parse) | removing/renaming a tool or resource, dropping the legacy echo, changing rejection codes |
| `json` | Each `--json` command writes exactly one JSON document to stdout and nothing to stderr; usage failures keep stdout empty and put a JSON error envelope (`E_USAGE`) on stderr; `evidence verify` keeps its JSON shape offline; `status`/`privacy` stay TOS-exempt | human text mixed into `--json` stdout, missing/renamed envelope, JSON written to stderr |
| `exit` | `0` success, `1` user/config error (bad flag, missing key), `3` TOS consent required on a fresh non-TTY home; `status`/`privacy` remain exempt (0); gated commands fail fast instead of prompting | exit-code drift, a command that prompts in CI, a key-less command that hangs |
| `tty` | Non-TTY output for human commands and `tui --once` contains no ANSI/CSI, no `\r`, no C0 controls, no U+FFFD; help output is plain; no command waits for stdin | clear-screen/cursor sequences in piped logs, encoding damage, interactive prompts on a pipe |

A run also asserts, once per suite, that **every child process saw zero network
attempts**. The check is enforced by a preload
(`eval/det/lib/network-block.mjs`) that patches `net`/`tls`/`http`/`https`/`dns`/
`fetch`; blocked attempts are recorded per invocation and aggregated into the
result's `network` block. "No key needed" is likewise mechanical: the harness
removes `ADVISERS_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
`ADVISERS_MODEL` and `ADVISERS_BASE_URL` from every child environment and sets
`ADVISERS_NO_MODEL=1`.

## Environment (why the numbers are stable)

Each case gets a fresh `ADVISERS_HOME` under the OS temp dir and a fixed
environment: `TZ=Asia/Shanghai`, `LANG=C.UTF-8`, `TERM=xterm-256color`,
`ADVISERS_STORE=sqlite`, `ADVISERS_CORE_LOCAL=1`, `ADVISERS_OFFICE_LOCAL=1`.
Time-dependent commands are invoked with an explicit `--now`; the ledger fixture
is written through the same `SqliteStore`/`Ledger` pair the CLI uses, with an
injected clock and id source (`packages/core/src/ports.ts`), so ids and
timestamps are reproducible. No case reads the real `~/.advisers` and no case
uses the network or a model.

The deterministic fixture lives in `eval/det/fixtures/morning-ledger.mjs`
(`morning-ledger-v1`: two matters, overdue/today/waiting/unscheduled/upcoming
commitments, a weekly RRULE meeting and a same-day conflict). Golden runs pin
`--now=2026-11-20T01:00:00.000Z` (09:00 Asia/Shanghai).

## Baseline (`eval/det/baseline.json`)

The baseline is committed and reviewed. It freezes:

- `golden.morning.dataSha256` — deterministic `morning --json` hash for the fixture;
- `golden.morning.digestMarkdownSha256` — SHA-256 of the deterministic morning markdown;
- `contract.exitCodes` — 0 / 1 / 3;
- `contract.mcp` — required tools, required resources, allowed legacy protocol echo;
- `fixture`, `recordedAt`, `recordedFrom` — provenance of the recording.

A change to any of these is a contract change and must be a reviewed diff. To
re-record after an intended change:

```sh
node scripts/eval-det.mjs --update-baseline
git diff eval/det/baseline.json
```

Re-recording to make a red gate green is the failure mode this file exists to
prevent. If the morning hash moves without a conscious decision to change the
hash scope, treat it as a regression: `dataSha256` covers
`{localDay, window, mustDo, overdue, meetings, waiting, upcoming, unscheduled,
conflicts, counts}` (new fields must be added **outside** that hash input or the
scope must be re-frozen deliberately).

Bump `FIXTURE_ID` and re-record when the fixture data changes; the fixture id in
the baseline and in `eval/det/fixtures/morning-ledger.mjs` must agree (a case
checks this).

## Result file (schema v1)

`eval/det/results/latest.json` (and each per-run file) is the machine evidence:

```json
{
  "schemaVersion": 1,
  "suite": "det",
  "suiteVersion": 1,
  "mode": "det",
  "startedAt": "2026-11-20T01:00:00.000Z",
  "durationMs": 20123,
  "filters": ["determinism", "mcp", "json", "exit", "tty"],
  "baseline": { "file": "eval/det/baseline.json", "fixture": "morning-ledger-v1", "recordedAt": "2026-11-19T15:58:00.000Z" },
  "cli": { "version": "0.3.0", "commit": "e1af67a", "node": "v24.22.1", "os": "linux" },
  "environment": { "timezone": "Asia/Shanghai", "home": "<TMP>/home", "noModel": true, "apiKeys": "stripped", "networkBlock": "preload" },
  "totals": { "cases": 19, "passed": 19, "failed": 0, "checks": 166, "checksFailed": 0 },
  "network": { "attempts": 0, "kinds": {} },
  "cases": [ { "id": "det.morning.golden-hash", "group": "determinism", "pass": true, "durationMs": 610, "checks": [ { "id": "dataSha256-matches-baseline", "pass": true } ] } ],
  "failures": [],
  "redaction": { "version": 1, "rules": ["abs-path", "temp-home", "repo-root"] }
}
```

Hard rules for the result file:

- **No quality metrics.** `mode:"det"` may only contain structural results.
  Model-quality numbers belong to the manual `eval/` runners and must never be
  mixed into a det result or quoted as accuracy.
- **No absolute paths / no temp dirs.** Output is normalized to
  `<TMP>`, `<HOME>`, `<WORK>`, `<REPO>`; the writer re-scans the serialized
  result and adds a `RESULT_LEAK` failure if a path survives.
- **No prompt/answer text.** Only case ids, check ids and bounded diagnostic
  strings are recorded (500 chars per check, 50 failures max).
- `network.attempts` must be `0`. A non-zero value fails the run and lists the
  attempted entry points.

## What this suite does not cover

- **Model quality** (capture gold, continuity, office review, agent tasks,
  dogfood): manual suites under `eval/`; they need `ADVISERS_API_KEY` and are
  documented in [eval/README.md](../eval/README.md). Nothing here may be cited as
  a model-quality result.
- **Interactive TUI behaviour** (PTY snapshots, state machine): owned by the TUI
  work line and its `test/*` suites. The one 0.3.0 must-have that touches this
  repo's det suite is the non-TTY/interactive guard — it lives in the **opt-in**
  `tui` suite (`pnpm eval:det --suite tui`), which the release gate runs after the
  TUI/output-kernel bin wiring. It is reported as red, not silently skipped.
- **Fault injection / security suites**: `pnpm test:security`, `pnpm test:fault`.
- **Windows-specific filesystem behaviour**: covered by the Windows smoke job,
  which now exercises the durable-write commands (`backup`, `export --out`,
  `import --replace`, `vault seal/unseal`) in addition to the minimal CLI flow;
  `eval:det` itself is platform-neutral (temp HOME, TZ, no shell) and CI runs it
  on Linux. The full Windows test suite and the real-machine E13 run are still
  pending.

## Adding or changing a case

1. Add the case to `eval/det/cases/<group>.mjs` with a `det.<group>.<what>` id.
   Reuse `withSeededHome`/`withFreshHome` from `cases/_fixture.mjs` and the
   helpers in `eval/det/lib/harness.mjs`; return `{ checks }` built with
   `check(checks, id, fn)`.
2. Assert the contract, not a snapshot of one implementation: check shapes,
   codes, stability and invariants (a one-off `JSON.stringify` comparison is a
   golden and belongs in the baseline instead).
3. Keep it under `<120s` total and offline. If it needs new fixture data, extend
   the deterministic fixture, bump `FIXTURE_ID`, and re-record the baseline.
4. Run `pnpm eval:det` (and `pnpm eval:det --suite tui` if relevant), then
   include the result path and totals in the evidence note.

## Related documents

- [docs/CLI-JSON.md](CLI-JSON.md) — CLI JSON contract and the 0/1/3 exit-code map.
- [docs/MCP.md](MCP.md) — MCP stdio surface (7 tools, 4 resources).
- [docs/PERFORMANCE.md](PERFORMANCE.md) — performance baselines (separate from
  this determinism gate).
- [docs/SECURITY.md](SECURITY.md) — security suites and supply-chain gates.
- [eval/README.md](../eval/README.md) — manual, real-model eval runners.
