# Quality baselines changelog

Every threshold or corpus change must be recorded here in the same review as the
`eval/quality/baselines-v1.json` change. Re-recording a red gate to green is a
regression, not a fix (same discipline as `eval/det/baseline.json --update-baseline`).

## v1 — 2026-11-22 (0.5.0 WF4 Q1)

- Created `eval/quality/baselines-v1.json` for the shared schema-v2 quality reports.
- `det`: threshold `cases.failed = checks.failed = network.attempts = 0`; golden
  values stay in the reviewed `eval/det/baseline.json` (sha recorded here).
- `model-contract`: 12 cases, 0 sockets, autoConfirmed 0; fake transport only.
- `kb-retrieval` (local-gold, dev split): corpus frozen — 25 documents + 50
  labelled queries, `corpus.sha256=fd27ab63…5998` (fixture-list hash), rows 75;
  fixture manifest sha `1e2b5f94…6191`. Thresholds: P@5 ≥ .80, MRR@10 ≥ .65,
  2-char hit@5 ≥ .75, no-hit FPR ≤ .10.
- `mail-local-gold` (local-gold, v2): corpus frozen — 120 synthetic fixtures
  (90 dev + 30 held-out), `corpusSha256=4acae148…23e4`; dev fixture manifest sha
  `fae5db2a…9079`, dev count 90, held-out 30. dev thresholds: P ≥ .90 / R ≥ .85 /
  F1 ≥ .85 / due ≥ .85 / author ≥ .90 / negative FP ≤ .10; held-out thresholds:
  P ≥ .85 / R ≥ .80 / F1 ≥ .82 / due ≥ .85 / negative FP ≤ .10 (release gate only).
- No model-quality / human-gold baseline exists yet: reports must keep
  `unknowns.modelQuality`/`humanGold`/`liveModelQuality` as explicit null until an
  independent human gold set (owner decision D2) is frozen.
