# Errata for the 0.5.0 release notes

Status: **corrections of record for 0.5.0** (facts verified 2026-11-24 by
impl-051-evidence against the `v0.5.0` tag tree, the published GitHub Release and
the CI/config files, independently of the release-authoring task). The `v0.5.0` tag, its npm tarballs and the GitHub
Release are immutable; this page corrects the release-note/CHANGELOG text where
it described more than the tag tree (`a73c380`) actually contains. Nothing that
shipped in 0.5.0 changes behaviour because of this page.

## 1. `REACH.md` / `UX-TESTING.md` were never shipped

**Claimed/planned:** the 0.5.0 execution plan (`126` §2 050-U3) listed new
`docs/REACH.md` and `docs/UX-TESTING.md` onboarding docs, and the 0.5.0 release
evidence wrote `QUICKSTART/REACH` in its onboarding section.

**Actual 0.5.0 tree:** `git ls-tree v0.5.0 docs/` contains neither file. One
shipped user-visible pointer was already broken: `advisers help reach` printed
"文档：仓库 docs/MCP.md、docs/WINDOWS.md、docs/REACH.md"
(`packages/advisers/lib/help-topics.js`), but `docs/REACH.md` did not exist. No
other shipped documentation or test depends on them.

**Correction / backfill:** 0.5.1 ships a minimal
[REACH.md](REACH.md) so the help pointer resolves (the surfaces, the read-only
boundaries and the explicit non-reachable list). The fuller reachability and
usability material (`UX-TESTING.md`, a 5-person onboarding test) is **still not
delivered** and stays a 0.6 item; do not cite it as a 0.5.0/0.5.1 deliverable.

## 2. "Unified Chinese error-hint surface" — narrowed

**Claimed in CHANGELOG 0.5.0:** `help <topic>` / `help --list` and "a unified
Chinese error-hint surface".

**Actual 0.5.0 tree:** `help <topic>` did ship (10 task topics with Chinese
aliases whose pages are byte-identical). The 193-code Chinese hint module
(`lib/error-hints.zh-CN.js`, `test/error-hints.test.js`) planned by `126`
§2 050-U1 is **not in the tree** — `E_USAGE` in a fresh install prints its
English message and no Chinese hint. Help pages are not an error-hint layer.

**Correction:** the CHANGELOG 0.5.0 sentence is narrowed to the Chinese
help-topic surface it actually shipped. The 193-code Chinese hint layer remains
an open 0.6 item; it is not a 0.5.0 claim.

## 3. The "decay" memory example is not in the deterministic suite

**Claimed in the 0.5.0 GitHub Release notes:** the memory quality gate was
illustrated with a `decay` example; the same body described held-out/model/live
checks as "release/nightly only".

**Actual 0.5.0 tree:** `eval/det/cases/memory.mjs` has 12 cases and none of
them exercises the `decay` path; the deterministic suite therefore does not
gate decay behaviour. (`decay` itself exists as a 0.2.x ledger command — the
correction is only about what the quality gate covers.) There is also no
nightly/live workflow in the repository: `.github/workflows/` contains
`ci.yml` and `publish.yml` only, and CI runs the mail-local dev split, not the
held-out/live runs. Quality evidence is therefore **manual and release-time**,
not nightly.

**Correction:** do not cite the 0.5.0 memory gate as decay coverage, and read
"nightly/live" as release-time manual runs. [QUALITY.md](QUALITY.md) now states
the actual cadence and what the gates do and do not cover; if decay coverage is
needed it must be added as an explicit case in a later release.

## 4. 0.5.0 release evidence as published

**Claimed by the 0.5.0 status text:** the release was "verifiable"/"可验收"
with the quality gates behind it.

**Actual at/after the 0.5.0 publish:** `eval/results/` is gitignored and the
published v0.5.0 GitHub Release carried no quality report (assets: portable ZIP,
SBOM and two `SHA256SUMS`). The four `latest.json` reports in the main tree
were `dirty:true` at commit `f29d268`, so `node scripts/check-eval-report.mjs
--release` failed 4/4 on that tree: the published release note's quality numbers
came from a dirty (uncommitted) tree, and the release did not attach the
release-grade report it implied.

**Correction / repair:** 0.5.1 repairs the process rather than the 0.5.0 tag.
[QUALITY.md](QUALITY.md) §6 records a release-grade rerun of the five gates on a
clean worktree of `a73c380` (2026-11-24) — use those numbers for 0.5.0, not the
release-note ones. For 0.5.1 onward the report is built from the clean tag tree,
uploaded as a CI artifact (`quality-reports-node-*`) and attached to the release
by the operator, `check-release --eval-evidence` consumes the frozen five-slot
directory at pre-tag time, and [QUALITY.md](QUALITY.md) documents the commands,
`n`, metrics and unknowns.

## 5. Release-notes wording: how to read this page

These corrections do not rewrite the 0.5.0 tarballs. The CHANGELOG 0.5.0
section carries the narrowed error-hint sentence and links here; [QUALITY.md]
(QUALITY.md) summarises §3–§4 and links here. A further erratum can be reported
at <https://github.com/PerryLink/advisers/issues> with the release-note quote
and the tag-tree evidence (`git ls-tree`/`git show`).

## Related

- [CHANGELOG.md](../CHANGELOG.md) — the 0.5.0 section (narrowed error-hint
  sentence) and the 0.5.1 section.
- [QUALITY.md](QUALITY.md) — what the quality gates actually cover and what
  remains unknown.
- [REACH.md](REACH.md) — the 0.5.1 backfill for the missing reachability page.
- [RELEASING.md](RELEASING.md) §13 — release records and their placeholders.
