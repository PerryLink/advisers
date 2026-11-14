# Capture gold-runner smoke on the AI-prelabeled seed — 2026-11-14

⚠️ **This is NOT the human gold set.** The input is
`eval/corpus/gold/commitments.zh.gold.seed.jsonl`: 50 synthetic messages with
AI prelabels, every row `pending_human_review: true`. The run validates that the
gold runner works end-to-end; its numbers must not be quoted as a human-gold or
benchmark result.

Model: `deepseek-flash`, `eval/run-capture-gold.mjs` default seed.

| Metric | Result | Target (internal) |
|---|---|---|
| quote validity | 100% | 100% |
| firm recall | 39/40 = 97.5% | >=85% |
| due accuracy (`due`/`dueAlt`) | 41/43 = 95.4% | >=95% |
| precision | 53/54 = 98.1% | >=75% |
| auto-confirmed | 0 | 0 |

Exit 0. Caveat: AI prelabels may share the model's own biases; only human
double review can turn this into a gold set. The 50→150 human labeling remains
**not done** (external blocker: human annotators / user-provided desensitized
messages).
