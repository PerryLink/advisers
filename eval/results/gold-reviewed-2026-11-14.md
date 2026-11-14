# 150-case reviewed capture corpus — 2026-11-14

⚠️ **This is NOT independent human gold.** The user explicitly authorized the
agent to act on their behalf; the corpus was reviewed by two independent agent
passes (A: classification/quote; B: date/timezone/quote) and adjudicated by the
lead agent. The provenance is recorded in every row:
`review_mode: "user_authorized_agent_double_review"`,
`pending_human_review: false`, `reviewers: ["reviewer-a","reviewer-b","lead-adjudicator"]`.
It must not be described as "human double review" or used as an external
benchmark.

## Corpus

- `eval/corpus/gold/commitments.zh.gold.reviewed.jsonl` — 150 rows, 175 expects
  (13 negative rows; 146 expect rows have due/dueAlt; 7 dueAlt).
- `eval/corpus/gold/commitments.zh.gold.seed.jsonl` — original 50 AI seed.
- `eval/corpus/gold/commitments.zh.gold.seed.051-150.jsonl` — 100 generated
  candidates.
- `eval/corpus/gold/reviews/reviewer-a.jsonl` / `reviewer-b.jsonl` — independent
  review verdicts (A: 137 ok / 13 fix; B: 148 ok / 2 fix).

## Final metrics (deepseek-flash, `--file ...reviewed.jsonl`, exit 0)

| Metric | Result | Target |
|---|---|---|
| quote validity | **100%** | 100% |
| firm recall | **122/128 = 95.31%** | >=85% |
| due accuracy (`due`/`dueAlt`) | **136/139 = 97.84%** | >=95% |
| precision | **169/174 = 97.13%** | >=75% |
| auto-confirmed | **0** | 0 |
| model-call errors | 0 (after one retry was added for transient provider timeouts) | 0 |

First run before the last adjudication: quote 100%, firm 93.75%, due
**130/137 = 94.89%** (below the 95% gate), precision 96.47%. The 7 due misses
were inspected:

- 6 were genuine model arithmetic errors with correct labels: gold-003 (expected
  11-18, got 11-17), gold-023 (expected 11-27, got 11-20), gold-052 (expected
  11-11, got null), gold-062 (expected 11-25/11-26, got 11-24), gold-067
  (expected 11-24, got 11-25).
- 1 was a label issue: gold-108 "这两天跟进审批" has no unique calendar date, so
  the lead adjudicator changed `due` to null (consistent with the event-anchored
  rule used for gold-038/133). gold-023 also gained `dueAlt: 2026-11-29` for the
  "下周" ambiguity. These changes are recorded in `review_note`.

That first run also had one transient 60s model timeout (gold-010); the runner now
retries a failed capture once. The final run above is the clean one.

## Review findings accepted

- A fixes (13): speaker-prefix role reversals (gold-066/071), missing second
  commitments (023/060/097/105/108), a completion report mislabelled as a promise
  (065), non-verb actions (039/120), creditor corrections (075/077/081).
- B fixes (2): event-anchored "合同签订后 10 个工作日内" cannot be resolved from
  the message date (gold-038/133 → due null), consistent with the other
  event-anchored cases.
- B also found that `resolveRelativeDate` treated "当天" as the message day; the
  resolver was fixed (当天 no longer resolved) with a regression test.

## Honest limits

- Two agent passes are not independent human review; they share the same model
  family and may share biases.
- 150 synthetic messages, not real anonymized client messages.
- Single final run; thresholds are internal regression gates, not a public
  benchmark claim.
