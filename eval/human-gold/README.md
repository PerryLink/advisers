# Independent human-gold workflow

This directory makes the remaining unmeasured quality dimension executable: two
independent humans label the same Chinese commitment cases without seeing the
reference labels, compute agreement (Cohen's kappa), adjudicate disagreements and
freeze a human-gold set. Nothing here is a human-gold claim until real people
complete the workflow: every generated quality report keeps
`unknowns.humanGold = null` with reason `pending-independent-review`.

The existing 150-case corpus (`eval/corpus/gold/commitments.zh.gold.reviewed.jsonl`)
is `user_authorized_agent_double_review`, **not** independent human gold. Do not
rename it or cite it as human gold.

## Files

| file | purpose |
|---|---|
| `make-review-packet.mjs` | build a blind packet: `cases.tsv`, blank `labels-<reviewer>.tsv`, blank `adjudication.tsv`, hidden `adjudicator-only/reference-labels.jsonl`, annotation guide, manifest (corpus sha256, row count) |
| `agreement-lib.mjs` | shared TSV parsing, commitment alignment and Cohen's kappa (no IO beyond explicit readers) |
| `compute-agreement.mjs` | per-field + overall (micro) kappa, row-level exact agreement; writes `agreement.json` |
| `adjudicate.mjs` | apply `adjudication.tsv`, enforce the kappa gate, freeze `commitments.zh.gold.human.v1.jsonl` + `manifest.json` |
| `annotation-guide.zh.md` | reviewer instructions (Chinese) |
| `consent-dogfood.zh.md` | consent template for real anonymized material |

## Workflow

```sh
# 1. Build a packet outside the repository (default: OS temp dir).
node eval/human-gold/make-review-packet.mjs \
  --corpus eval/corpus/gold/commitments.zh.gold.reviewed.jsonl \
  --out /tmp/advisers-human-gold-<date>

# 2. Two non-implementers label independently. Give each reviewer only
#    cases.tsv + their own labels-<reviewer>.tsv + annotation-guide.zh.md.
#    Neither may open adjudicator-only/ or the other sheet.

# 3. Agreement:
node eval/human-gold/compute-agreement.mjs \
  --a /tmp/advisers-human-gold-<date>/labels-reviewer-a.tsv \
  --b /tmp/advisers-human-gold-<date>/labels-reviewer-b.tsv \
  --out /tmp/advisers-human-gold-<date>/agreement.json

# 4. A third person fills adjudication.tsv for every disagreement, then freezes.
node eval/human-gold/adjudicate.mjs \
  --a /tmp/advisers-human-gold-<date>/labels-reviewer-a.tsv \
  --b /tmp/advisers-human-gold-<date>/labels-reviewer-b.tsv \
  --adjudication /tmp/advisers-human-gold-<date>/adjudication.tsv \
  --corpus eval/corpus/gold/commitments.zh.gold.reviewed.jsonl \
  --reference /tmp/advisers-human-gold-<date>/adjudicator-only/reference-labels.jsonl \
  --reviewer-a-id reviewer-a --reviewer-b-id reviewer-b \
  --reviewed-at <ISO-8601> \
  --out /tmp/advisers-human-gold-<date>/frozen

# 5. Only after a PASS freeze may an evaluation report be labelled human-gold:
#    mode:"human-gold", metrics.kappa from manifest.json, corpus.sha256 the frozen file.
```

## The gate

Plan 123/97 freezes the rule: **overall Cohen's kappa >= 0.70** before a
human-gold set may exist. The overall kappa is the mean of the per-field kappas
that are mathematically defined (single-category fields are reported as
undefined instead of being pooled into one misleading contingency table; the
micro/observed-agreement numbers remain in the JSON for diagnosis).
`adjudicate.mjs` refuses to write the gold file when
kappa is below the threshold or undefined (single-category labels), and records
`frozen:false` + the failed gate in `manifest.json` so a failed pilot is evidence,
not something to hide. Do not re-record labels to make red green; re-label or
report the pilot as failed.

Agreement details:

- one TSV row per commitment; a case with multiple commitments repeats its id in
  text order (both reviewers must keep that order);
- a no-commitment case has no rows, and both reviewers must still have it absent;
- fields: `action`, `debtor`, `creditor`, `due`, `quote`, `modal`; empty = unknown;
- a missing/extra commitment counts as a disagreement in every field of that slot;
- output contains counts and kappa only (no case text, no raw label values);
- the per-field kappa sits next to the overall gate for diagnosis, not as a
  replacement (rare labels can give low per-field kappa even with high agreement).

## Privacy and not-doing list

- Packets, label sheets and frozen gold files for **real** anonymized material stay
  outside this repository; only synthetic cases with explicit consent may be
  committed, and even then the packet default is outside the tree.
- Never commit reviewer names; the manifest records the anonymous ids passed to
  `adjudicate.mjs` (`reviewer-a`/`reviewer-b` by default).
- Do not use reference labels to fill final values: `adjudicate.mjs` reads them
  only for a count-only comparison recorded in the manifest.
- Do not publish kappa or accuracy from a failed gate; the honest statement is
  "pilot not passed".
- Do not claim model quality from this set: it measures the deterministic local
  extractor (`capture`) until a separate live-model evaluation exists.

## Current state (2026-11-24)

No real human reviewers have labelled a packet yet, so `humanGold` stays `null`
and no `commitments.zh.gold.human.*` file exists in the tree. The scripts are
ready and tested with synthetic fixtures only (see
`packages/advisers/test/eval-human-gold.test.js`).
