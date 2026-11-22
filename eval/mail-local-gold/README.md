# mail-local-gold — local mail extraction quality gold set

Zero-model, zero-network gold evaluation of the deterministic local commitment
extractor in [`packages/advisers/lib/mail-extract.js`](../../packages/advisers/lib/mail-extract.js)
(the default `mail extract --local` path). Run it with:

```
pnpm eval:mail-local --split dev      # L0 / PR gate (90 fixtures)
pnpm eval:mail-local --split heldout  # release gate only (30 fixtures)
```

Each `.eml` fixture is parsed with the same parser as `mail import`
([mail-parse.js](../../packages/advisers/lib/mail-parse.js)), then
`extractLocalCandidates` is called with the message `Date` header as the
time anchor (exactly what the local branch of `mailExtract` does for one stored
message). The returned candidates are compared with the hand labels in
[`labels.json`](labels.json). The runner never calls a model, never opens a
network socket, never creates an `ADVISERS_HOME` / SQLite database and never
reads credentials. It writes a schema-v2 quality report
(`eval/results/mail-local-gold/`) that `scripts/check-eval-report.mjs` validates.

## What this is / is not

- It **is** a synthetic, hand-labeled regression gate for the local rules.
  Fixtures are realistic (Chinese/English, promises vs requests vs reschedules
  vs noise, absolute and relative dates, third-party promises, HTML-only mail)
  but they are **not real client mail**.
- It **is not** a human-reviewed external gold set and its numbers are **not a
  general accuracy claim**. Independent human review is pending (D2); every
  case carries `reviewStatus` saying so.
- It deliberately includes **known-limitation cases as labels** instead of
  hiding them, so the gate measures misses it knows about (see
[Known limitations](#known-limitations-measured-not-hidden)).

## Files

| path | purpose |
| --- | --- |
| `NN-slug.eml` | 120 synthetic RFC 822 fixtures (`01`–`90` dev, `91`–`120` held-out) with fixed `From` / `Subject` / `Date` / `Message-ID` and UTF-8 bodies. The fixed `Date` makes every relative date deterministic. |
| `labels.json` | Schema `advisers.mail-local-gold/v2`: per case `{file, author, split, provenance, reviewStatus, topic, expect[], note?}` plus the top-level `corpusSha256` that freezes all fixture bytes. |
| `README.md` | This file. |

## Splits (dev vs held-out)

| split | fixtures | positive messages | labeled commitments | runner | used by |
| --- | --- | --- | --- | --- | --- |
| `dev` | 90 | 68 | 73 | `--split dev` (default) | L0 / PR CI |
| `heldout` | 30 | 24 | 26 | `--split heldout` | release gate only |

- **Held-out is frozen by `corpusSha256`.** Changing, adding or removing any
  `.eml` byte (or the labels) makes the runner fail closed with
  `corpusSha256 mismatch` until the hash is regenerated in the same reviewed
  change. Never tune the extractor against held-out results: L0 runs dev only,
  and the held-out split is executed only in the release gate.
- `--fixtures <dir>` scores one custom gold directory instead (legacy v1
  labels are still accepted there for local experiments; the default set must
  be v2).

### Label semantics

```json
{
  "file": "31-zh-tuesday-schedule.eml",
  "author": "王工",
  "split": "dev",
  "provenance": "synthetic",
  "reviewStatus": "implementer-labeled; independent human review pending (D2)",
  "topic": "zh-relative",
  "expect": [{ "action": "发排期表", "dueAt": "2026-11-17" }],
  "note": "why this case exists (optional; known limitations start with 'Known')"
}
```

- `author` — the `From` display name. Used to check that the local extractor
  attaches the sender (it fills `candidate.creditor` from the parsed `From`
  display name). It is **not** a claim about who owes the action.
- `action` — the normalized action phrase a human would track. Matching ignores
  whitespace/case and compares verb/object inclusion after stripping one
  leading verb, so `发报价单` matches `发出报价单`.
- `dueAt` — a **calendar date** `YYYY-MM-DD` in `Asia/Shanghai`, or `null`.
  The rules resolve relative dates to 18:00 Asia/Shanghai by default; this eval
  compares only the local calendar date, never the instant. `null` labels are
  excluded from due accuracy.
- `split` / `provenance` / `reviewStatus` — required by the v2 schema; describe
  which gate uses the case and that the corpus is synthetic and implementer
  labeled.
- `amountMinor` / `currency` (optional) — only set where the fixture carries a
  money amount; checked as an informational (non-gated) accuracy.

## Metrics

Labels and candidates are matched per message, one-to-one, by action. Then:

| metric | definition | gated |
| --- | --- | --- |
| `precision` | `matchedCandidates / predictedCandidates` (candidate level) | dev + held-out |
| `recall` | `matchedExpected / expectedCandidates` (candidate level) | dev + held-out |
| `f1` | harmonic mean of precision and recall | dev + held-out |
| `dueAccuracy` | among matched commitments labeled with a `dueAt`: share whose extracted local date equals the label | dev + held-out |
| `authorAccuracy` | among matched commitments: share whose `candidate.creditor` equals the labeled `From` author | dev only |
| `negativeFalsePositiveRate` | `messageFP / negativeMessages` (share of negative fixtures that produced any candidate) | dev + held-out |
| `amountAccuracy` | reported only (amount + currency where labeled) | — |
| `messagePrecision` / `messageRecall` / `messageF1` | message-level detection | — |

### Gated thresholds (release gate)

| metric | dev threshold | held-out threshold | dev baseline 2026-11-22 |
| --- | --- | --- | --- |
| `precision` | >= 0.90 | >= 0.85 | 0.9863 (72/73) |
| `recall` | >= 0.85 | >= 0.80 | 0.9863 (72/73) |
| `f1` | >= 0.85 | >= 0.82 | 0.9863 |
| `dueAccuracy` | >= 0.85 | >= 0.85 | 0.9701 (65/67) |
| `authorAccuracy` | >= 0.90 | not gated | 1.0 (72/72) |
| `negativeFalsePositiveRate` | <= 0.10 | <= 0.10 | 0.0455 (1/22) |

`node eval/run-mail-local-gold.mjs --split dev` exits **0** only when every
gated metric meets its threshold and the gold set validates; otherwise it exits
**1** (and **2** for usage errors). Thresholds live in `eval/run-mail-local-gold.mjs`
(`SPLITS`) and should only move with a recorded reason. The runner emits a
schema-v2 quality report (`mode: "local-gold"`, explicit `unknowns`, frozen
`corpus.sha256`, `network.attempts = 0`) instead of a bespoke JSON shape.

## Known limitations (measured, not hidden)

The four documented limitation fixtures are all in dev and are expected to
produce a fixture-level issue; they are labeled on purpose so the gate measures
the miss instead of hiding it:

| fixture | issue | why it is labeled this way |
| --- | --- | --- |
| `09-en-relative-friday.eml` | due `2026-11-20`, extracted `null` | local rules do not resolve English relative dates (`by Friday`) |
| `20-en-month-date.eml` | due `2026-11-30`, extracted `null` | local rules do not resolve English month names (`Nov 30`) |
| `19-zh-implied-subject.eml` | missing commitment `答复` | implied-subject reply has no first-person marker |
| `30-neg-marketing-we.eml` | unexpected candidate `发送确认邮件到你的邮箱` | first-person boilerplate in a marketing blast is read as a user commitment |

Also out of scope for this gate (by design): the opt-in model path, IMAP sync,
attachment handling, real/anonymized customer corpora, debtor-direction
semantics for incoming first-person promises, and any claim of general-world
accuracy.

## Commands

```
node eval/run-mail-local-gold.mjs                       # dev human report; exit 0/1
node eval/run-mail-local-gold.mjs --split heldout       # release gate only
node eval/run-mail-local-gold.mjs --json                # schema-v2 report JSON
node eval/run-mail-local-gold.mjs --verbose             # per-fixture PASS/FAIL
node eval/run-mail-local-gold.mjs --list                # all 120 fixtures + counts
node eval/run-mail-local-gold.mjs --fixtures <dir>      # score another gold directory
node eval/run-mail-local-gold.mjs --no-write            # do not write eval/results/
node --test packages/advisers/test/eval-mail-local.test.js
```

The runner derives `fixtureDir` relative to its own location, so it works from
any working directory. It is deterministic: two runs produce identical metrics,
gates and per-case rows (only `startedAt` / `durationMs` differ).

## Adding or changing a fixture

1. Add `NN-slug.eml` with fixed `From`, `Subject`, `Date` (with an explicit
   offset such as `+0800`) and `Message-ID` headers. Keep the body readable
   text (or HTML when testing the HTML fallback). Dev fixtures use `01`–`90`,
   held-out fixtures `91`–`120`.
2. Add one `cases` entry to `labels.json` with the human label: `author`,
   `split`, `provenance`, `reviewStatus`, `topic`, `expect[]` and a short
   `note`. Use `expect: []` for a negative case.
3. Regenerate the top-level `corpusSha256` over the sorted fixture manifest
   (`relpath\0sha256\n` lines, see `eval/lib/quality-report.mjs`).
4. Run `node eval/run-mail-local-gold.mjs --split dev` (and, only when
   releasing, `--split heldout`) and review the fixture-level issues. Only then
   decide whether a threshold needs changing (usually it should not: the point
   of a gold set is to catch regressions, not to absorb them).
5. Run `node --test packages/advisers/test/eval-mail-local.test.js`.
