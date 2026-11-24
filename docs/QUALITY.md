# Quality and release evidence

> Status: 0.5.1, published 2026-11-24. The quality gates described here exist in the
> 0.5.0 tag; the release-evidence workflow (`eval/evidence.mjs`,
> `check-release --eval-evidence`) and this page are 0.5.1 additions. Nothing on
> this page is an accuracy, benchmark or compliance claim.

This page is the public, versioned record of what the Advisers quality gates
measure, what they deliberately do not measure, how a release proves the
numbers, and how to reproduce them. It exists because 0.5.0 published quality
numbers that could not be verified from the release tree: the reports behind
them were local worktree runs (`cli.dirty:true`) and were never archived with
the release. 0.5.1 closes that gap; see [Errata for 0.5.0](#errata-for-050).

## 1. Rules

1. **Regression gate, not a model-quality result.** det, kb-retrieval,
   mail-local and model-contract are deterministic, offline checks that the
   behaviour did not regress. They are not an accuracy claim and must not be
   quoted as one.
2. **Unmeasured means `null`.** The report schema v2 carries an explicit
   `unknowns[]` list: an unmeasured dimension is `null` with a reason, never
   `0`, `false` or `PASS`.
3. **Release evidence must be reproducible from a recorded commit.**
   `cli.commit` is required and `cli.dirty` must be `false`; a dirty-worktree run
   remains a valid local regression result but is not release evidence.
4. **No re-recording to green.** Thresholds, corpora and the det golden hashes
   are frozen in `eval/quality/baselines-v1.json` and `eval/det/baseline.json`.
   Changing either is a reviewed contract change (baseline +
   `eval/quality/CHANGELOG.md` in the same diff), not a fix. The baseline was
   recorded from the 0.4.3 tree (`recordedFrom.cliVersion=0.4.3`,
   `commit=f29d268`); 0.5.x reports cite the same frozen bytes on purpose, so a
   threshold change cannot be smuggled in with a version bump.
5. **Synthetic data only in the repository.** Every gold set here is synthetic
   (`provenance: "synthetic"`, hand-written labels). Real anonymized corpora and
   independent human labels stay outside the tree; only aggregate metrics and
   hashes may be published.

## 2. Report schema v2

`eval/lib/quality-report.mjs` is the single builder/validator/writer;
`eval/schema/quality-result-v2.schema.json` is the committed JSON Schema twin;
`scripts/check-eval-report.mjs` is the gate. Every report records:

- `schemaVersion: 2`, `suite`/`suiteVersion`/`mode`, timestamps, `command`, `filters`;
- `corpus {id, sha256, rows, provenance, reviewMode, license, split} | null` and
  `fixtures {sha256, count}` — exactly which data the numbers came from;
- `cli {version, commit, node, os, dirty}` and the cited baseline
  `{file, sha256, recordedAt}`;
- `metrics` (mode-specific; `null` for `det`), `gates[]`, `totals`,
  `network {guarded, attempts}`;
- `unknowns[]` — every dimension the run did not measure, as explicit `null`;
- `failures[]` — only `detailSha256`, never raw detail text;
- `redaction {version: 2, rules, piiScan}` and `reproduce {command, env, fixedNow, seed}`.

`node scripts/check-eval-report.mjs` validates one file, a glob, a suite
directory (its `latest.json`) or a frozen evidence directory (all `*.json` in
it). `--release` additionally requires a recorded `cli.commit` and
`cli.dirty === false`. `--self-test` exercises the validator's positive and
negative fixtures.

## 3. The gates

All five are offline: no API key, no network socket, no real `~/.advisers`;
each case gets a temporary `ADVISERS_HOME` where a HOME is needed. Timings below
are from the 0.5.0 tag re-run (2026-11-24, Node 24.22.3, Linux) and are
indicative, not a contract.

| gate | command | scope | gated thresholds | 0.5.0 tag re-run |
|---|---|---|---|---|
| det | `pnpm eval:det` | 49 deterministic cases / 367 checks: golden morning hash, JSON/exit/tty/MCP contracts, KB, mail, policy, memory `fact as-of`, CLI/MCP/DSH projection | cases.failed = 0, checksFailed = 0, network.attempts = 0 | 49/49 cases, 367/367 checks, 0 network |
| kb-retrieval | `pnpm eval:kb-retrieval` | 25 synthetic Markdown documents + 50 hand-labelled queries (44 positive, 6 no-hit) through the shipped CLI | P@5 >= .80, MRR@10 >= .65, 2-char hit@5 >= .75, no-hit FPR <= .10 | P@5 .9773, MRR@10 .9682, 2-char hit@5 .9167 (11/12), no-hit FPR 0 |
| mail-local (dev) | `pnpm eval:mail-local --split dev` | 90 synthetic `.eml` fixtures through the local rule extractor (`mail extract --local`) | P >= .90, R >= .85, F1 >= .85, due >= .85, author >= .90, negative FP <= .10 | P/R/F1 .9863, due .9701, author 1.0, negative FP .0455 |
| mail-local (held-out) | `pnpm eval:mail-local --split heldout` | 30 frozen held-out synthetic `.eml` fixtures; release gate only, never used to tune the extractor | P >= .85, R >= .80, F1 >= .82, due >= .85, negative FP <= .10 | P/R/F1 1.0, due 1.0, negative FP 0 |
| model-contract | `pnpm eval:model-contract` | 12 in-process fake-transport cases through `lib/model.js`, `lib/capture.js`, `lib/mail-extract.js` | 12/12 cases, 0 sockets, `autoConfirmed = 0` | 12/12, 15/15 checks, 0 sockets, `autoConfirmed` 0 |

What the gates do **not** prove: model quality, live-model behaviour, semantic
retrieval, general accuracy, human agreement, or real account/mailbox handling.
Those dimensions stay `null` in every report (see §5).

The mail dev split runs in CI; the held-out split is a release gate only
(never in L0/PR, never used for tuning). KB retrieval is lexical (FTS5 trigram +
2-char LIKE fallback), not semantic. The det suite asserts deterministic
contracts, not golden model answers.

## 4. Release evidence protocol

The evidence directory is generated on a **clean checkout of the release
commit**, never on a working tree. For a retrospective (already tagged)
release, check out the tag in a temporary worktree:

```sh
git worktree add --detach /tmp/advisers-release-evidence vX.Y.Z
cd /tmp/advisers-release-evidence
pnpm install --frozen-lockfile
pnpm -r --if-present run build
node eval/evidence.mjs --tag vX.Y.Z   # drop --tag for a pre-tag evidence run
```

`eval/evidence.mjs` refuses a dirty tree, runs the five gates, copies each
fresh schema-v2 report into `eval/results/release-evidence/` as `det.json`,
`kb-retrieval.json`, `mail-local-gold-dev.json`,
`mail-local-gold-heldout.json`, `model-contract.json`, and writes `EVIDENCE.md`
+ `SHA256SUMS`. It fails if a gate is not green, a report is not release-grade,
or a report's recorded commit does not match HEAD.

Then run the two gates:

```sh
node scripts/check-eval-report.mjs --release eval/results/release-evidence
# on the exact release commit before the tag exists (--stable/--require-tag need the tag):
node scripts/check-release.mjs --eval-evidence eval/results/release-evidence
# after the annotated tag exists, verify the tagged tree:
node scripts/check-release.mjs --stable --require-tag --eval-evidence eval/results/release-evidence
```

`--eval-evidence` is the release gate and consumes the reports, it does not just
trust their presence. It requires exactly one release-grade report for each of
the five slots (det, kb-retrieval, mail-local dev, mail-local held-out,
model-contract); all reports must share one `cli.commit` equal to HEAD (or the
explicit `--eval-commit <sha>` when replaying evidence on a post-tag commit)
and record the release version (`--eval-version <version>` is the replay
override). The corpus/baseline hashes must still match
`eval/quality/baselines-v1.json` / `eval/det/baseline.json` on disk (kb corpus
sha, both mail corpus shas plus split sizes, det baseline sha, model-contract
`sockets=0` / `autoConfirmed=0`). Any missing slot, duplicate slot, extra
non-report JSON, failed gate, dirty report or commit drift fails the release
gate with exit 1.

Archive the evidence: `eval/results/` is gitignored, so the frozen evidence
directory (`*.json` + `EVIDENCE.md` + `SHA256SUMS`) is attached to the GitHub
Release (and CI uploads its own run as the `quality-reports-node-<node-version>`
artifact, retained 30 days). Reproducing the run creates new bytes (timestamps),
but the stable facts — tag/commit, `dirty:false`, corpus shas, thresholds and
pass/fail — are what the release claims.

## 5. Unmeasured dimensions (explicit `null`)

Every report lists the following as `unknowns[] {value: null, reason}`:

| id | reason | what would change it |
|---|---|---|
| `modelQuality` | not measured by this suite | a model-quality evaluation with a fixed model/date and human or benchmark scoring |
| `humanGold` | `pending-independent-review` | two independent non-implementer reviewers, kappa >= 0.70, frozen via `eval/human-gold/` (owner decision D2) |
| `liveModelQuality` | requires a live model run | a `mode:"live"` report, release/nightly only, never in PR |
| `semanticCorrectness` | no semantic gold set | a hand-labelled semantic retrieval set (0.6+ eval prerequisite) |
| `cost` | not measured by this suite | a token/cost run with a fixed budget |
| `realMailAccount` | no real mail account fixture | an owner-provided real account, aggregates only, never in the repo/CI |
| `win11RealMachine` | Windows CI only, not a real client machine | the manual real-Windows client record (docs/WINDOWS.md) |

Consequence for wording: do not write "accurate", "verified", "better than", "SLA" or
"compliant" about these suites; the honest claim is "synthetic deterministic
regression gates pass, and the unmeasured dimensions are explicit nulls".

## 6. 0.5.0 evidence snapshot

0.5.0 (tag `v0.5.0` -> `a73c380`) was released before this workflow existed;
its published quality numbers came from dirty local reports and no report was
attached to the release. On 2026-11-24 the five gates were re-run on a clean
detached worktree of `a73c380` (Node 24.22.3, Linux) and frozen as release-grade
evidence (`cli.commit=a73c380`, `cli.dirty=false`):

- det: 49/49 cases, 367/367 checks, 0 network;
- kb-retrieval: P@5 .9773, MRR@10 .9682, 2-char hit@5 .9167 (11/12), no-hit FPR 0;
- mail-local dev: P/R/F1 .9863, due .9701, author 1.0, negative FP .0455;
- mail-local held-out: P/R/F1 1.0, due 1.0, negative FP 0;
- model-contract: 12/12, 0 sockets, `autoConfirmed=0`.

`check-eval-report --release` returned 0 invalid and
`check-release --stable --require-tag --eval-evidence` passed on the tag
worktree; replaying the same reports from the post-tag tree needs
`--eval-commit a73c380` (and `--eval-version 0.5.0` once that tree's versions
have moved past 0.5.0). The frozen copies are not committed (the results tree
is gitignored); the report hashes are in the evidence bundle's `SHA256SUMS`.

## 7. Errata for 0.5.0

Verified discrepancies between the 0.5.0 release text and the tag tree
(2026-11-24, read-only check of `v0.5.0`); the detailed errata live in
[docs/ERRATA-0.5.0.md](ERRATA-0.5.0.md):

1. `docs/REACH.md` and `docs/UX-TESTING.md` are not in the `v0.5.0` tree even
   though the 0.5.0 evidence note lists them as delivered (and the shipped
   `help-topics.js` points at `docs/REACH.md`).
2. The CHANGELOG's "unified Chinese error-hint surface" has no implementation in
   the tree (`lib/error-hints.zh-CN.js` does not exist; no hint data in bin/lib).
3. The GitHub release text lists a memory "decay" case; the 12 memory cases in
   `eval/det/cases/memory.mjs` do not include one.
4. The release text says held-out/model/live checks are "release/nightly only";
   the repository has only `ci.yml` and `publish.yml`, no nightly/live workflow,
   and CI runs the mail dev split only.
5. The published quality numbers were dirty local runs and no quality report
   was attached to the release. From 0.5.1 the release gate above prevents a
   release from citing them.

## 8. Reproduce

```sh
pnpm eval:det                                            # 49 cases / 367 checks, 0 network
pnpm eval:kb-retrieval                                   # 25 docs / 50 queries
pnpm eval:mail-local --split dev                        # 90 dev fixtures (CI gate)
pnpm eval:mail-local --split heldout                    # 30 held-out fixtures (release only)
pnpm eval:model-contract                                 # 12 fake-transport cases, 0 sockets
node scripts/check-eval-report.mjs --self-test           # validator positive/negative fixtures
node scripts/check-eval-report.mjs --release             # all latest results must be release-grade

# full release evidence (clean checkout of the release commit):
node eval/evidence.mjs --tag vX.Y.Z   # retrospective/tagged tree; drop --tag pre-tag
node scripts/check-eval-report.mjs --release eval/results/release-evidence
node scripts/check-release.mjs --eval-evidence eval/results/release-evidence   # pre-tag release commit
node scripts/check-release.mjs --stable --require-tag --eval-evidence eval/results/release-evidence   # tagged tree
```

CI (`.github/workflows/ci.yml`, Linux test job) runs the same gates, validates
the reports in `--release` mode from its clean checkout, and uploads
`eval/results/` as the `quality-reports-node-<node-version>` artifact.

## 9. Does not cover

- **Independent human gold**: the workflow and scripts exist
  (`eval/human-gold/`, `compute-agreement.mjs`, `adjudicate.mjs`), but no real
  reviewers have labelled a packet, so `humanGold` stays `null`. Until owner
  decision D2 funds and completes it, no human-gold or accuracy wording is
  allowed.
- **Real anonymized corpora**: no private corpus is committed or used; the gates
  are synthetic. Real-corpus pilots are an owner-machine activity that publishes
  only hashes/aggregates and is not part of CI.
- **Live model quality**: no `mode:"live"` report exists; the model-contract
  suite uses a fake transport and cannot claim model behaviour.
- **Third-party audit/compliance**: none. The local hash-chain and offline
  verification are mechanisms, not certifications; do not call them "audited"
  in a compliance sense.
- **Windows client certification**: CI runs Windows Server 2025; a real Windows
  11 client record is tracked in [WINDOWS.md](WINDOWS.md).

## 10. Change control

- Thresholds/corpora: update `eval/quality/baselines-v1.json` **and**
  `eval/quality/CHANGELOG.md` in the same reviewed change, then re-run the
  evidence protocol. Editing a report, a threshold or a corpus to turn red into
  green invalidates the chain and must be rejected in review.
- det golden hashes: `node scripts/eval-det.mjs --update-baseline` only for an
  intended contract change; review the baseline diff.
- New gates: add a suite through `eval/lib/quality-report.mjs`, a runner that
  writes `eval/results/<suite>/latest.json`, a slot in `eval/evidence.mjs` and
  `REQUIRED_EVIDENCE_SLOTS` in `scripts/check-release.mjs`; update this page.
- Report schema v3 (if ever needed): bump `QUALITY_SCHEMA_VERSION`, keep the
  validator able to reject old releases for release evidence, and update
  `docs/EVAL.md`.

## 11. Related documents

- [docs/EVAL.md](EVAL.md) — the deterministic eval suite and report v2 details.
- [eval/README.md](../eval/README.md) — manual real-model runners (not gates).
- [eval/quality/baselines-v1.json](../eval/quality/baselines-v1.json) and
  [eval/quality/CHANGELOG.md](../eval/quality/CHANGELOG.md) — frozen thresholds/corpora.
- [eval/human-gold/README.md](../eval/human-gold/README.md) — independent human-gold workflow.
- [docs/RELEASING.md](RELEASING.md) — the full release checklist.
- [docs/ERRATA-0.5.0.md](ERRATA-0.5.0.md) — 0.5.0 release-text corrections.
