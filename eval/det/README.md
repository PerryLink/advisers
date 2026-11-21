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
| `lib/report.mjs` | result schema v1, path scrubbing, result writer, console report |
| `lib/runner.mjs` | sequential case runner + harness-wide checks |
| `lib/baseline.mjs` | reads and re-records `baseline.json` |
| `cases/*.mjs` | the gates, grouped `determinism` / `mcp` / `json` / `exit` / `tty` / `kb` / `mail` / `policy` (+ opt-in `tui`); 30 cases / 277 checks in the default run (0.4.1) |
| `fixtures/morning-ledger.mjs` | deterministic ledger fixture (injected clock + ids) |
| `baseline.json` | committed golden values and contract expectations |
| `results/` | gitignored run output (`det-<stamp>.json`, `latest.json`) |

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
