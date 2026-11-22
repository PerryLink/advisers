# eval/det — deterministic eval suite

Machine gate for the deterministic 0.3.0/0.4.0 contract. No API key, no network, no
real `~/.advisers`, fixed timezone, temp HOME per case. Run it from the repo
root:

```sh
pnpm eval:det
```

Full documentation (what is gated, the baseline rules, the result schema, how to
add a case): [docs/EVAL.md](../../docs/EVAL.md).

## Layout

| Path | Purpose |
|---|---|
| `../../scripts/eval-det.mjs` | entry point / CLI flags / exit codes |
| `lib/harness.mjs` | temp HOME, sanitized env, CLI + MCP runners, normalization |
| `lib/network-block.mjs` | `--import` preload: records and rejects every egress attempt |
| `lib/report.mjs` | shared quality-result **schema v2** reporter (writer, path/PII scrubbing, gates, console report); the schema lives in `../../eval/schema/quality-result-v2.schema.json` and the builder/validator in `../../eval/lib/quality-report.mjs` |
| `lib/runner.mjs` | sequential case runner + harness-wide checks |
| `lib/baseline.mjs` | reads and re-records `baseline.json` |
| `cases/*.mjs` | the gates, grouped `determinism` / `mcp` / `json` / `exit` / `tty` / `kb` / `mail` / `policy` / `memory` / `projection` (+ opt-in `tui`). 0.5.0 WF4 adds `memory` (12 `fact as-of` cases) and `projection` (5 CLI/MCP/DSH parity cases) and two fail-closed `policy` cases; the current default run is 49 cases / 367 checks (`pnpm eval:det --json` prints the live count; the local mail gold set is a separate `eval:mail-local` gate) |
| `fixtures/morning-ledger.mjs` | deterministic ledger fixture (injected clock + ids) |
| `baseline.json` | committed golden values and contract expectations |
| `../../eval/results/det/` | gitignored run output (`det-<stamp>.json`, `latest.json`) — the shared `eval/results/<suite>/` tree; historical `eval/det/results/` is not migrated |
| `../../eval/quality/baselines-v1.json` | suite-level thresholds/corpus baselines cited by every schema-v2 report |
| `../../scripts/check-eval-report.mjs` | validates the written report(s); `--release` requires a clean tree + commit |

## Golden values

`baseline.json` freezes the morning `dataSha256`, the deterministic markdown
hash, the exit-code map and the MCP tool/resource surface. Re-record only after
an intended contract change:

```sh
node scripts/eval-det.mjs --update-baseline
git diff eval/det/baseline.json
```

If `dataSha256` moves without a reviewed change to the hash scope, treat it as a
regression (see docs/EVAL.md "Baseline").
