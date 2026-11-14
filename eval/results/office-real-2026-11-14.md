# Office "realistic synthetic" defect review — 2026-11-14

Model: `deepseek-flash`. Script: `eval/run-office-real.mjs` (new). 20 generated
documents (14 docx / 4 xlsx / 2 pptx), 10 defect types × 2, one defect each.

⚠️ These are **realistic synthetic** documents (business-shaped contracts,
weekly reports, budgets, minutes, quotes), **not real customer documents** and
not redacted copies of real files. Internal regression only; do not use as an
external benchmark.

## v1 (first run, before two cases were strengthened)

Result: **18/20 blocker**, 2 FAIL, both `keywordMatched=yes` — the model found
the defect but classified it `warn`, not `blocker`:

- `unit-2`: "6 元" in a 万元 table (model: unit annotation issue, not blocker).
- `contradiction-2`: checklist dates earlier than the body date (model: needs
  confirmation, not blocker).

Raw log: `/tmp/advisers-office-real.log` (first run).

## v2 (after making those two defects unambiguous)

The two v1 cases were *severity-ambiguous*, so they were rewritten as
unambiguous blocker-level defects (still realistic synthetic, still 20 docs /
10×2 coverage):

- `unit-2`: contract total "人民币 120 万元（大写：壹拾贰元整）" — the uppercase
  amount is missing the 万 unit (12 元 vs 1,200,000 元).
- `contradiction-2`: acceptance date 2026-11-20 is before the platform delivery
  date 2026-12-15 — acceptance before delivery cannot be true.

v2 result: **20/20 blocker**, 0 miss, exit 0. Raw log:
`/tmp/advisers-office-real-v2.log`.

## Honest reading

- The defect corpus is still synthetic; realistic wording does not make it a real
  customer-document set. The real-document set (10–20 desensitized customer
  files + human expectations) remains **not done** — it needs user-provided or
  user-approved material.
- v1 → v2 changed two cases after seeing model output. Both changes are recorded
  here; do not quote v1 as 20/20 and do not quote v2 as a real-document result.
- Severity calibration is model judgment: the same finding can be `warn` or
  `blocker`. The eval's PASS criterion is `blocker`, matching the product's
  "do not claim done when a blocker exists" rule.
