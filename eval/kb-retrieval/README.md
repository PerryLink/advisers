# kb-retrieval — KB lexical-retrieval gold set

Zero-model, zero-network gold evaluation of the shipped lexical KB search
(`advisers kb search <query> --scope kb`). It imports the corpus into a
temporary `ADVISERS_HOME` with the real CLI (`kb add`), then scores every query
through the real CLI (`kb search ... --limit 20`) so the measured ranking is the
shipped path, not a re-implementation.

```
pnpm eval:kb-retrieval              # human report; exit 0/1
pnpm eval:kb-retrieval --json       # schema-v2 quality report JSON
```

## What this is / is not

- It **is** a small synthetic lexical-retrieval regression gate: 25 realistic
  business documents (客户 / 项目 / 报价 / 会议 / 合同 / 技术 / 邮件 / 时间线)
  and 50 Chinese / mixed queries.
- It **is not** a general retrieval-quality benchmark. There is no vector /
  embedding / semantic retrieval here (0.6+), no LLM judge and no external
  leaderboard; the numbers are a synthetic gate, not an accuracy claim.
- The corpus is **synthetic** and licensed CC BY-NC-SA-4.0; it contains no real
  customer data. The repo code remains under its own license.

## Layout

| path | purpose |
| --- | --- |
| `corpus/*.md` | 25 synthetic markdown documents. Titles come from the file names (the CLI derives the document title from the basename). |
| `queries.json` | Gold labels: 50 queries with `{id, query, category, relevant[], note?}`, plus the 25 document names, provenance and license. |
| `run.mjs` | Runner: temp HOME, `kb add` (one batch), `kb ls` for the docId → source-name map, then the 50 searches in a bounded 8-way pool. Emits a schema-v2 report. |

## Query mix

| category | count | purpose |
| --- | --- | --- |
| `zh-2char` | 12 | two-character Chinese queries; the SQLite trigram FTS path falls back to `LIKE` for these (`degraded: ["short_query_like"]`) |
| `zh-3plus` | 18 | three-or-more-character Chinese queries (FTS trigram `MATCH`) |
| `mixed` | 8 | mixed Chinese/English queries (`sprint 复盘`, `API 限流`, …) |
| `title-hit` | 6 | terms that appear in a document title (title hits rank before chunk hits) |
| `no-hit` | 6 | terms absent from the corpus; any hit is a false positive |

Totals: 44 positive queries (43 single-relevant, 1 two-relevant) and 6 no-hit
queries.

## Metrics and thresholds

| metric | definition | threshold | baseline 2026-11-22 |
| --- | --- | --- | --- |
| `precisionAt5` | mean over positive queries of `top5 relevant / min(5, |relevant|)` | >= 0.80 | 0.9773 |
| `mrrAt10` | mean reciprocal rank of the first relevant document (0 when none in top 10) | >= 0.65 | 0.9682 |
| `shortQueryHitAt5` | share of the 12 two-character queries with a relevant document in top 5 | >= 0.75 | 0.9167 (11/12) |
| `noHitFalsePositiveRate` | share of the 6 no-hit queries that returned any hit | <= 0.10 | 0.0000 (0/6) |

The baseline is deliberately not perfect: the ambiguous two-character query
`评审` matches 12 documents, and its gold document lands outside top-5 on the
shipped `LIKE` ordering (rowid-desc). That is a documented ranking limitation of
the current lexical path, measured rather than tuned away.

Every metric also carries the denominators in `metrics.counts`, and the two
binomial rates (`shortQueryHitAt5`, `noHitFalsePositiveRate`) carry a Wilson 95%
interval in `metrics.ci95`. The report is `mode: "local-gold"` with explicit
`unknowns` (model quality / human gold / live model quality / … = null),
`network.attempts = 0` and a frozen corpus hash covering `corpus/**` +
`queries.json`; `scripts/check-eval-report.mjs` validates it.

## Commands

```
node eval/kb-retrieval/run.mjs                    # human report; exit 0/1
node eval/kb-retrieval/run.mjs --json             # schema-v2 report JSON
node eval/kb-retrieval/run.mjs --verbose          # per-query PASS/FAIL + rank
node eval/kb-retrieval/run.mjs --no-write         # do not write eval/results/
node --test packages/advisers/test/eval-kb-retrieval.test.js
```

Exit codes: 0 all gated metrics pass; 1 a metric or the corpus failed; 2 usage
error. The import and search runs happen in a `mktemp`-style temp directory and
are deleted afterwards; the real `~/.advisers` is never touched. Runtime on the
test machine is ~8–12 s (52 CLI spawns, searches pooled 8-way).

## Adding documents or queries

1. Add a markdown document under `corpus/` (keep it small: one chunk).
2. Add its file name to `queries.json.documents` and add/extend queries; keep
   the `categories` counts in sync (the runner fails closed on drift).
3. Use `relevant: []` for a no-hit query; positive queries need at least one
   relevant document name.
4. Run `node eval/kb-retrieval/run.mjs` and review the per-query rows plus the
   `degraded` reasons; only then decide whether a threshold should move (it
   should not: the gate exists to catch regressions).
