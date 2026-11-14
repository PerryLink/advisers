# Independent human-gold packet

This directory makes the remaining E4 blocker executable: two independent
humans can review the same Chinese commitment cases without seeing the current
reference labels.

## Generate a packet

```sh
node eval/human-gold/make-review-packet.mjs \
  --corpus eval/corpus/gold/commitments.zh.gold.reviewed.jsonl \
  --out /tmp/advisers-human-gold-<date>
```

Output:
- `cases.tsv` — id/source/date/text only (no expected labels);
- `labels-reviewer-a.tsv`, `labels-reviewer-b.tsv` — blank label sheets;
- `adjudication.tsv` — blank adjudication sheet;
- `adjudicator-only/reference-labels.jsonl` — hidden from reviewers;
- `manifest.json` — corpus SHA256 and row count.

Reviewers must not open `adjudicator-only/`; give them only `cases.tsv` +
their own label sheet + `annotation-guide.zh.md`.

## Workflow

1. Two reviewers label independently (same cases, separate sheets).
2. Compare: compute agreement / Cohen's κ on action+direction+due+quote.
3. Adjudicator resolves disagreements with `adjudication.tsv`; record reason.
4. Freeze the final gold file, run `eval/run-capture-gold.mjs` against it.
5. Publish an anonymized report with corpus hash, reviewer count, κ, and errors.

Current state: the 150-case corpus is **user-authorized agent double review**,
not independent human gold. Do not call it human gold until this workflow is
completed by real people.
