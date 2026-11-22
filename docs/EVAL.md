# Deterministic eval suite (`pnpm eval:det`)

> Status: introduced in the 0.3.0 line (published 2026-11-20); this tree is
> `advisers@0.4.2` (the 0.4.0 feature release plus the 0.4.1/0.4.2 follow-up patches).
> The published 0.4.0 adds one deterministic case — `det.mcp.modern-dual-era` (MCP
> `2026-07-28` modern envelopes behind the legacy surface); 0.4.1 adds the `kb`, `mail`
> and `policy` groups (10 cases / 95 checks), for 30 cases / 277 checks in the default
> run; 0.4.2 adds the separate local mail-extraction gold gate (30 synthetic fixtures,
> not counted in the eval:det cases). The suite is a release gate for the deterministic contract, not a claim about
> model quality; the remaining KB/mail/policy/consent/receivable behaviour is also
> covered by deterministic package tests.

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
pnpm eval:det --suite tui                 # opt-in non-TTY/interactive guard (see below)
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
| `mcp` | `initialize` echoes the legacy protocol version `2024-11-05`; `tools/list` contains the **8** documented tools in a stable order with `inputSchema`; `resources/list` contains the **5** `advisers://` resources; a read tool returns JSON text; JSON-RPC rejection codes stay `-32601` (method), `-32602` (tool/args), `-32002` (resource), `-32700` (parse). The 0.4.0 case `det.mcp.modern-dual-era` additionally asserts `server/discover`, per-request `_meta` validation, `resultType`/`ttlMs`/`cacheScope` envelopes, the modern error-code mapping and **byte-identical legacy payloads** | removing/renaming a tool or resource, dropping the legacy echo, changing rejection codes, a modern envelope that differs from the legacy payload, or a modern path that answers notifications |
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

## 0.4.0/0.4.1/0.4.2 coverage

The published 0.4.0 adds `det.mcp.modern-dual-era` in the `mcp` group (MCP
`2026-07-28` dual-era: `server/discover`, per-request `_meta`, result envelopes,
mapped errors, byte-identical legacy responses). 0.4.1 adds three fully
deterministic groups:

- **kb** (4 cases): batch add/ls/show byte-stability, duplicate skip, 2-character
  `degraded:["short_query_like"]` vs 3+ character FTS, page rebuild idempotence and
  staleness, fact `show/history/as-of` time travel and boundaries.
- **mail** (2 cases): fixed `.eml` import/ls/show byte-stability with dedupe and
  `sha256`/id cross-home stability, local-rule extraction dry-run and persisted
  pending candidate (no model, no IMAP).
- **policy** (4 cases): `privacy --matrix` row stability, consent grant/status/revoke
  lifecycle and mode, `mail extract --model` fail-closed gates, and evidence
  resolution routing (`verified`/`missing`/`unverifiable`; the fourth vocabulary value
  is pinned but not reachable through the current CLI).

These cases run with a fresh temp `ADVISERS_HOME`, `TZ=Asia/Shanghai`, no model key and
the network-block preload (0 network attempts).

Run the 0.4.0 deterministic package tests explicitly (no key, no network, temp
`ADVISERS_HOME`):

```sh
cd packages/advisers
node --experimental-strip-types --test test/kb-*.test.js
node --experimental-strip-types --test test/mail-*.test.js
node --experimental-strip-types --test test/policy-*.test.js test/consent.test.js
node --experimental-strip-types --test test/evidence-*.test.js
node --experimental-strip-types --test test/receivable*.test.js test/client-pack*.test.js
node --experimental-strip-types --test test/migration-v22.test.js test/schema-migrations.test.js
node --experimental-strip-types --test test/mcp-modern*.test.js
```

`pnpm -r test` runs the same files in the CI `test` job (and the blocking
`windows-full` job runs them on Windows). They are deterministic tests: the local mail
extraction path is the only mail path covered — `mail sync` and `mail extract --model`
need a server/key and are deliberately outside the gate. No case reads the real
`~/.advisers` or the network.

**Why these groups are still contract gates, not model quality:** every case asserts
deterministic invariants (byte-identical repeat runs, frozen vocabulary/exit codes,
fail-closed policy gates, no network) rather than a golden model answer. They do not
need a provider key and never read the real `~/.advisers`. Do not present them as a
model-quality evaluation.

## Local mail extraction gold set (`pnpm eval:mail-local`)

A second, zero-model gate measures the deterministic local commitment extractor
(`mail extract --local`): 30 fixed synthetic `.eml` fixtures (Chinese/English,
absolute and relative dates, third-party promises, requests/reschedules/noise,
HTML-only) with hand labels under `eval/mail-local-gold/`. The runner parses each
message with the same parser as `mail import`, calls the same local extraction
branch, and reports candidate precision/recall/F1, due-date accuracy and author
accuracy; it exits non-zero when a threshold regresses (currently precision 90%,
recall/F1 85%, due 85%, author 90%). It never calls a model, never opens a
network socket, never creates an `ADVISERS_HOME` and never reads credentials, so
it runs in the Linux CI job right after `eval:det`.

This is a **synthetic regression gate, not a general accuracy claim**: the
labels are hand-written by the implementer, not independently reviewed, and the
set deliberately includes known-limitation cases (English relative due dates,
an implicit subject, one marketing false positive) so the gate measures them
instead of hiding them. The four known misses and the extension process are
documented in `eval/mail-local-gold/README.md`; an independent human gold set
remains future work.

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

`eval/det/results/latest.json` (and each per-run file) is the machine evidence. The
example below is illustrative; the `cli` block records the build that actually ran it
(the commit hash changes per run and is not a release claim):

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
  "cli": { "version": "0.4.0", "commit": "<commit-of-the-run>", "node": "v24.22.1", "os": "linux" },
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
- **Interactive shell behaviour** (PTY snapshots, readline state machine, paste
  merge, confirmation semantics): owned by `packages/advisers/test/shell-*.test.js`
  and the shell contract in [TUI.md](TUI.md) §13–§14. This det suite only owns
  the **non-TTY guard**, which lives in the **opt-in** `tui` group
  (`pnpm eval:det --suite tui`); it is reported as red, not silently skipped.
- **The 0.4 local surfaces** (KB, mail parsing/import, policy engine/consent,
  receivables arithmetic, evidence pack v2, v22 migration): deterministic
  package tests, not det groups — see "0.4.0 coverage" above. A failure there is
  caught by `pnpm -r test`, not by `eval:det`.
- **Fault injection / security suites**: `pnpm test:security`, `pnpm test:fault`.
- **Windows-specific filesystem behaviour**: `eval:det` itself is platform-neutral
  (temp HOME, TZ, no shell) and CI runs it on Linux. The Windows test surface is
  covered by two **blocking** jobs: `windows-smoke` (minimal CLI + durable-write
  commands) and `windows-full` (the full workspace suite plus the portable-bundle
  self-tests). Both run on GitHub's `windows-latest` image, which is currently a
  **Windows Server 2025** image: they are not a Windows 11 client certification,
  and they are not the release gate — the release gate (`publish.yml` /
  `verify-release`) runs on ubuntu-latest. The 2026-11-21 real-client record still
  lists 36 known Windows-only failures/skips at first run (30 fixture/POSIX
  assumptions + 6 product/local-semantics items; 34 reproduced on a clean re-run —
  see [WINDOWS.md](WINDOWS.md) §8), and the portable ZIP is verified by
  `scripts/pack-portable.mjs --verify`, not by this suite — do not describe 0.4.0
  as fully Windows-verified.

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
- [docs/MCP.md](MCP.md) — MCP stdio surface (8 tools, 5 resources).
- [docs/PERFORMANCE.md](PERFORMANCE.md) — performance baselines (separate from
  this determinism gate).
- [docs/SECURITY.md](SECURITY.md) — security suites and supply-chain gates.
- [docs/KB.md](KB.md) — the 0.4 knowledge-base surface whose deterministic tests are
  listed under "0.4.0 coverage".
- [docs/WINDOWS.md](WINDOWS.md) — Windows support and the portable ZIP the
  platform-neutral det suite does not cover.
- [eval/README.md](../eval/README.md) — manual, real-model eval runners.
