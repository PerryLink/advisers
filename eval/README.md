# Eval

`eval/` holds **manual, real-model evaluations** of Advisers behaviour. They are
not CI tests: CI has no model key and a meaningful run costs real model tokens.
Every script fails fast (exit 1, one line on stderr) when no key is configured.

## Requirements

- Node >= 22.13 (`node:sqlite`). Repo dependencies installed (`pnpm install`).
- A real key in `ADVISERS_API_KEY` (or `DEEPSEEK_API_KEY`). Never commit a key,
  and never copy one into results/notes.
- Every script creates a throw-away `ADVISERS_HOME` under the OS temp dir, runs
  the CLI with `ADVISERS_CORE_LOCAL=1` and `ADVISERS_OFFICE_LOCAL=1`, and removes
  the temp home/work tree in a `finally` block. The agent-task script also sets
  `ADVISERS_FORCE=1` so overwrite confirmations do not block non-interactive runs.
- Optional: `ADVISERS_MODEL` is forwarded to the CLI (default `deepseek-flash`).

## Scripts

### `run-continuity.mjs` — long-context fact recall

```
ADVISERS_API_KEY=... node eval/run-continuity.mjs            # FACTS=10 (default)
FACTS=50  ADVISERS_API_KEY=... node eval/run-continuity.mjs
FACTS=100 ADVISERS_API_KEY=... node eval/run-continuity.mjs
FACTS=200 ADVISERS_API_KEY=... node eval/run-continuity.mjs
```

- `FACTS` must be one of `10|50|100|200` (default `10`). The fact set is
  generated programmatically, deterministically, and is duplicate-free. It
  covers person names, client names, budgets/amounts, dates, preferences,
  commitments, owners, company names, email preferences, and deadlines; repeated
  types are distinguished by an index or client letter.
- Each fact is stored with a separate `advisers chat "<fact>"` call; then 8–12
  generated probes ask about specific facts. `FACTS=10` uses 10 facts and 8
  probes (similar shape to the original continuity probe).
- A probe passes when its answer contains an accepted token after whitespace
  removal (so `300 万`/`300万` and ISO/Chinese dates both match). The script
  records pass/fail per probe and a truncated answer summary for failures.
- JSON on stdout: `{facts, probes, passed, failures:[{probe, expect, answer}], elapsedMs}`.
  Progress goes to stderr. Exit code is 1 when fewer than 75% of probes pass.
- Cost/runtime: `FACTS + probes` real model calls, each with a 180 s timeout;
  `FACTS=200` is a long run.

### `run-agent-tasks.mjs` — 8 end-to-end agent tasks

```
ADVISERS_API_KEY=... node eval/run-agent-tasks.mjs
TASKS=docx,email ADVISERS_API_KEY=... node eval/run-agent-tasks.mjs
```

Each task runs its own setup (temp fixtures), one or two `advisers chat` calls,
and assertions. Every CLI call has a 300 s timeout. Task ids:

| id | what it checks |
| --- | --- |
| `docx` | build `out/week.docx`; parses as DOCX and contains the requested text |
| `xlsx` | build `out/budget.xlsx`; parses and contains 差旅/80/外包/40 |
| `pptx` | build `out/deck.pptx`; parses, has at least 3 slides, contains “Q4” |
| `summary` | read `notes/a.txt` + `notes/b.txt`, write `out/summary.docx`; DOCX parses and contains both key amounts (137 / 34) |
| `contract` | script pre-builds `in/contract.docx`; chat rewrites 120→150 and saves `out/contract-v2.docx`; DOCX parses and contains 150 |
| `escape` | chat first tries `../escape.docx` (must not escape the workspace), then writes `out/safe.docx`; asserts no parent `escape.docx` and a parseable safe DOCX |
| `pdf` | script builds a text-free PDF at `in/scan.pdf`; chat reads it with `--file`; asserts the call does not crash/time out and the output contains an understandable cannot-read/no-text message, with no Node stack |
| `email` | read two weekly notes, write `out/weekly-email.md`; contains both key amounts (137 / 34) |

- `TASKS` filters task ids (comma separated, case-insensitive). Unknown ids exit
  with a list of valid ids.
- JSON on stdout: `{model, cliTimeoutMs, elapsedMs, tasks, passed, failed,
  results:[...], failures:[{id, failedChecks, outputTail}]}`, where every result
  carries per-check PASS/FAIL detail and captured output tails. Progress goes to
  stderr. Exit code is 1 if any task fails.
- The escape/PDF cases are failure-path tests: a PASS means the CLI/agent failed
  safely and recovered, not that the underlying operation succeeded.

### `run-office-real.mjs` — 20 realistic-synthetic Office defects

```
node eval/run-office-real.mjs --dry-run                 # offline: generate 20 docs + manifest
DEEPSEEK_API_KEY=... node eval/run-office-real.mjs      # real review through the CLI
LIMIT=4 node eval/run-office-real.mjs --dry-run         # first N cases
```

- 20 documents (14 docx / 4 xlsx / 2 pptx), 10 defect types × 2, exactly one
  defect per document. They are **realistic synthetic**, not real customer
  documents and not redacted copies; internal regression only.
- Real mode calls `advisers review <file> --request ...` per document (temp
  `ADVISERS_HOME`, 180 s timeout, concurrency 3) and counts a case as PASS only
  when a `[blocker]` finding is returned (keyword match is reported separately).
- `--dry-run` works without a key and always cleans its temp directory unless
  `--keep` is passed. Results note: `eval/results/office-real-YYYY-MM-DD.md`.

### `run-capture-gold.mjs` — capture gold-set scaffolding

```
node eval/run-capture-gold.mjs --dry-run                # schema/field check, no key
DEEPSEEK_API_KEY=... node eval/run-capture-gold.mjs     # real-model metrics (default seed)
DEEPSEEK_API_KEY=... node eval/run-capture-gold.mjs --file <gold.jsonl> --limit 20
```

- Default input `corpus/gold/commitments.zh.gold.seed.jsonl` is a **50-case
  AI-prelabeled draft seed** (`pending_human_review: true` on every row) — **not
  human gold**. It exists to exercise the runner and the schema; do not present
  its metrics as "passed the human gold set".
- The real-model run reports quote validity, firm recall, due accuracy
  (`due`/`dueAlt` accepted), precision and auto-confirmed; exit 1 when a target
  is missed. Human review must first produce
  `commitments.zh.gold.human.jsonl` (see `corpus/gold/README.md`).

### Other evals

- `run-agent-5.mjs` — legacy 3-task real-model agent smoke (kept as-is).
- `run-office-40.mjs` — 40 generated DOCX defects (10 types × 4), compares
  `reviewDocument` blocker verdicts against the generated defect.
- `run-office-review.mjs` — small 5-case Office review smoke.
- `run-capture.mjs` — capture quality on `corpus/commitments.zh.jsonl`.
- `run-capture-150.mjs` — synthetic 150-case capture stress, with per-case
  failures, rule-date count and a >=95% due gate.
- `run-office-real.mjs` — 20 realistic-synthetic Office defect documents (see above).
- `run-capture-gold.mjs` — gold-set runner (see above).

`corpus/commitments.zh.jsonl` is a seed for the `capture` quality gate; it is
not a final gold set. Fields: id, source, date, text, expect[] (action, debtor,
creditor, due, quote, modal). The numeric targets in the corpus/scripts are
quality gates, **not** achieved claims.

## Recording results

Results are local artifacts, not pass/fail badges. Suggested practice:

1. Keep the raw JSON for the run (in `eval/results/`, e.g.
   `continuity-YYYY-MM-DD.json`, or pasted into the note).
2. Add a short markdown note at `eval/results/<eval>-YYYY-MM-DD.md` (existing
   files follow this name) recording: date, model (`ADVISERS_MODEL`), Node
   version, git commit, parameters (`FACTS` / `TASKS` / corpus size), pass/fail
   counts, failure list, and the caveats below.
3. Do not claim a quality target is met from a single run. One run on generated
   facts/defects is evidence about that run only; repeat before drawing
   conclusions, and state that the data is synthetic/anonymized when it is.
