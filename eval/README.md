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

### `run-dogfood-5.mjs` — 5-persona dogfood（离线可检查，真实模式由主代理执行）

```
DRY_RUN=1 node eval/run-dogfood-5.mjs                    # 离线：列出 15 个任务与命令，不调用 CLI
PERSONAS=1,3,5 DRY_RUN=1 node eval/run-dogfood-5.mjs    # 只列指定 persona（每个仍有 3 个任务）
ADVISERS_API_KEY=... node eval/run-dogfood-5.mjs        # 真实模式；由有 key 的主代理执行，不在 CI 跑
ADVISERS_NO_MODEL=1 node eval/run-dogfood-5.mjs         # 真实模式无模型：立即 exit 1，打印“需要真实 key”
```

- 5 个合成 persona（独立咨询顾问 / 自由设计师 / 小团队负责人 / 技术顾问 /
  独立律师助理；姓名与客户均为化名/合成），每人 3 个**连续**任务，共 15 个。
  同一 persona 的任务共享一个临时 `ADVISERS_HOME` 和 work 目录（模拟连续使用），
  5 个 persona 的 home/work 彼此独立。每个 CLI 调用都是新进程，必须从同一个
  home 重新加载账本；显式的“跨会话”任务（p1-t2 / p3-t2 / p5-t2）先在新进程里
  `commit ls` 重新读出上一个任务写入的承诺，再用 `today` / `tick --json` 检查。
- 任务矩阵：

  | persona | task | 覆盖 |
  | --- | --- | --- |
  | P1 独立咨询顾问 | p1-t1 | `commit add` ×2 + `correct` 偏好 + `commit ls` / `prefs` / `export` |
  | P1 | p1-t2 | 跨会话 `today` / `tick`；带证据 `commit done` 后 today/tick 同步隐藏 |
  | P1 | p1-t3 | 真实模型 `capture`：候选 pending、不入账；`memory accept` 后才进承诺账 |
  | P2 自由设计师 | p2-t1 | `commit add` ×2 + 偏好 + 账本断言 |
  | P2 | p2-t2 | `office docx` + `verify --content` + `office-read` + `deliveries` / `receipt` |
  | P2 | p2-t3 | 真实模型 `review`：只读（文件不变）、exit code 与 blocker 输出自洽 |
  | P3 小团队负责人 | p3-t1 | `commit add` ×2 + 偏好 + 账本断言 |
  | P3 | p3-t2 | 跨会话 `today` / `tick`；`commit snooze` 后 tick/today 同步隐藏 |
  | P3 | p3-t3 | `office pptx` + `verify --content` + 幻灯片页数 |
  | P4 技术顾问 | p4-t1 | `commit add` ×2 + 偏好 + 账本断言 |
  | P4 | p4-t2 | `office docx` + `verify --content` + 交付回执 |
  | P4 | p4-t3 | 真实模型 `review`：只读与输出自洽 |
  | P5 独立律师助理 | p5-t1 | `commit add` ×2（其中一条逾期）+ 偏好 + 账本断言 |
  | P5 | p5-t2 | 跨会话 `today` / `tick`：逾期计数与 L2/L1 等级 |
  | P5 | p5-t3 | 真实模型 `capture` + `memory accept` 的候选/入账流 |

- 断言不只看退出码，还检查：文件存在/非空、`verify --content` 的
  `structure.ok`/`content.ok`、文本包含客户与交付物关键词、承诺在
  `commit ls` 中为 open、`tick --json` 能解析且带提醒等级、capture 候选为
  pending 且 accept 前不在 `commit ls`/`today` 中出现、偏好不被 capture 污染、
  `receipt` 的“未完成承诺”数与账本一致、`export` 中 matter 唯一且无
  confirmed 状态承诺。
- 15 个任务跑完后还有一轮**跨 persona/home 隔离检查**（计入
  `globalChecks`，不计入 15 个任务）：在每个 home 里分别执行
  `today` / `prefs` / `export` / `deliveries`，断言本 persona 的客户/偏好/
  交付物可见，而其他 persona 的客户/偏好/交付物完全不出现；任一隔离检查
  失败同样 exit 1。
- stdout 只有一个 JSON：`{mode, personas, tasks, passed, failed, results,
  issues, globalChecks, coverage, ...}`；`results` 每个任务记录 persona、task、
  command、exitCode、durationMs、stdoutSummary 与逐条检查结果。进度写
  stderr。临时目录在 `finally` 清理；key 只从环境读、不打印、不落盘，捕获的
  输出会 redact。`DRY_RUN=1` 不读 key、不建临时目录，`passed/failed` 均为 0，
  `results` 里是 15 个任务的命令清单与断言语义。
- 无 key（或 `ADVISERS_NO_MODEL=1`）走进真实模式时在创建临时目录之前
  **快速失败**（exit 1，stderr 打印“需要真实 key”），不会先跑一半再崩溃。
- 离线验证：
  ```
  node --check eval/run-dogfood-5.mjs
  DRY_RUN=1 node eval/run-dogfood-5.mjs          # 15 个任务
  env -u ADVISERS_API_KEY -u DEEPSEEK_API_KEY ADVISERS_NO_MODEL=1 \
    node eval/run-dogfood-5.mjs                  # exit 1 + “需要真实 key”
  ```

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

### `run-dogfood-5.mjs` — 5-persona simulated dogfood

```
DRY_RUN=1 node eval/run-dogfood-5.mjs                 # list 15 tasks, no key
PERSONAS=1,5 ADVISERS_API_KEY=... node eval/run-dogfood-5.mjs
ADVISERS_API_KEY=... node eval/run-dogfood-5.mjs      # full 5×3 tasks
```

5 synthetic personas × 3 consecutive tasks in separate homes: commitment
ledger + explicit preferences, cross-session `today`/`tick`, office
build/verify/receipt, read-only review, and capture→pending→manual accept.
Global checks assert no cross-persona/home leakage. These are simulated
personas, not real dogfood users. Latest result:
`eval/results/dogfood-5-2026-11-14.md` (15/15 tasks, 74/74 global checks).

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
- `run-dogfood-5.mjs` — 5-persona simulated dogfood (see above).

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
