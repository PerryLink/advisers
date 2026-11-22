# mail-local-gold — local mail extraction quality gold set

Zero-model, zero-network gold evaluation of the deterministic local commitment
extractor in [`packages/advisers/lib/mail-extract.js`](../../packages/advisers/lib/mail-extract.js)
(the default `mail extract --local` path). Run it with:

```
pnpm eval:mail-local
```

Each `.eml` fixture is parsed with the same parser as `mail import`
([mail-parse.js](../../packages/advisers/lib/mail-parse.js)), then
`extractLocalCandidates` is called with the message `Date` header as the
time anchor (exactly what the local branch of `mailExtract` does for one stored
message). The returned candidates are compared with the hand labels in
[`labels.json`](labels.json). The runner never calls a model, never opens a
network socket, never creates an `ADVISERS_HOME` / SQLite database and never
reads credentials.

## What this is / is not

- It **is** a small, synthetic, hand-labeled regression gate for the local
  rules. Fixtures are realistic (Chinese/English, promises vs requests vs
  reschedules vs noise, absolute and relative dates, third-party promises,
  HTML-only mail) but they are **not real client mail**.
- It **is not** a human-reviewed external gold set and its numbers are **not a
  general accuracy claim**. Independent human review is recommended before any
  public quality statement (see `reviewStatus` in `labels.json`).
- It deliberately includes **known-limitation cases as labels** instead of
  hiding them, so the gate measures misses it knows about (see
  [Known limitations](#known-limitations-measured-not-hidden)). The thresholds
  leave room for those cases; they do not get special-cased.

## Files

| path | purpose |
| --- | --- |
| `NN-slug.eml` | 30 RFC 822 fixtures with fixed `From` / `Subject` / `Date` / `Message-ID` and UTF-8 bodies. The fixed `Date` makes every relative date deterministic. |
| `labels.json` | Hand labels. Per case: `{file, author, expect[], note?}`. |
| `README.md` | This file. |

### Label semantics

```json
{
  "file": "01-zh-absolute-quote.eml",
  "author": "王工",
  "expect": [{ "action": "发出报价单", "dueAt": "2026-11-25" }],
  "note": "why this case exists (optional; known limitations start with 'Known')"
}
```

- `author` — the `From` display name. Used to check that the local extractor
  attaches the sender (it fills `candidate.creditor` from the parsed `From`
  display name). It is **not** a claim about who owes the action: the local
  rules use the ledger-owner heuristic for first-person sentences, and debtor
  direction is out of scope for this gate.
- `action` — the normalized action phrase a human would track, e.g.
  `发出报价单`, `deliver final report`. Matching ignores whitespace/case and
  compares verb/object inclusion after stripping one leading verb, so
  `发报价单` matches `发出报价单` and `send updated quote by` matches
  `send updated quote`.
- `dueAt` — a **calendar date** `YYYY-MM-DD` in `Asia/Shanghai`, or `null`
  when the mail gives no usable date. The rules resolve relative dates to
  18:00 Asia/Shanghai by default (`下班前`, `中午前`, …); this eval compares
  only the local calendar date, never the instant. `null` labels are excluded
  from due accuracy.
- `amountMinor` / `currency` (optional) — only set where the fixture carries a
  money amount; checked as an informational (non-gated) accuracy.

## Metrics

Labels and candidates are matched per message, one-to-one, by action. Then:

| metric | definition |
| --- | --- |
| `precision` | `matchedCandidates / predictedCandidates` (candidate level) |
| `recall` | `matchedExpected / expectedCandidates` (candidate level) |
| `f1` | harmonic mean of precision and recall |
| `dueAccuracy` | among matched commitments labeled with a `dueAt`: share whose extracted local date equals the label |
| `authorAccuracy` | among matched commitments: share whose `candidate.creditor` equals the labeled `From` author |
| `amountAccuracy` | reported only (amount + currency for the one labeled money case) |
| `messagePrecision` / `messageRecall` / `messageF1` | message-level detection (does the message produce any candidate?), reported only |

### Gated thresholds (release gate)

| metric | threshold | baseline 2026-11-22 (0.4.2) |
| --- | --- | --- |
| `precision` | >= 0.90 | 0.9524 (20/21) |
| `recall` | >= 0.85 | 0.9524 (20/21) |
| `f1` | >= 0.85 | 0.9524 |
| `dueAccuracy` | >= 0.85 | 0.8947 (17/19) |
| `authorAccuracy` | >= 0.90 | 1.0 (20/20) |

`node eval/run-mail-local-gold.mjs` exits **0** only when every gated metric
meets its threshold and the gold set validates; otherwise it exits **1** (and
`2` for usage errors). Thresholds live in `eval/run-mail-local-gold.mjs`
(`TARGETS`) and should only move with a recorded reason.

## Known limitations (measured, not hidden)

Baseline 2026-11-22 (30 fixtures) has four expected fixture-level issues; each
is part of the gold set on purpose and is documented in its `note`:

| fixture | issue | why it is labeled this way |
| --- | --- | --- |
| `09-en-relative-friday.eml` | due `2026-11-20`, extracted `null` | local rules do not resolve English relative dates (`by Friday`) |
| `20-en-month-date.eml` | due `2026-11-30`, extracted `null` | local rules do not resolve English month names (`Nov 30`) |
| `19-zh-implied-subject.eml` | missing commitment `答复` | implied-subject reply (`本周五前给你答复`) has no first-person marker |
| `30-neg-marketing-we.eml` | unexpected candidate `发送确认邮件到你的邮箱` | first-person boilerplate in a marketing blast is read as a user commitment |

Also out of scope for this gate (by design): the opt-in model path, IMAP sync,
attachment handling, real/anonymized customer corpora, debtor-direction
semantics for incoming first-person promises, and any claim of general-world
accuracy.

## Commands

```
node eval/run-mail-local-gold.mjs              # human report; exit 0/1
node eval/run-mail-local-gold.mjs --json       # one JSON document on stdout
node eval/run-mail-local-gold.mjs --verbose    # include per-fixture PASS/FAIL
node eval/run-mail-local-gold.mjs --list       # list fixtures + expected counts
node eval/run-mail-local-gold.mjs --fixtures <dir>   # run another gold directory
node --test packages/advisers/test/eval-mail-local.test.js
```

The runner derives `fixtureDir` relative to its own location, so it works from
any working directory. It is deterministic: two runs produce identical metrics
and identical per-case rows (only `generatedAt` / `durationMs` differ).

## Adding or changing a fixture

1. Add `NN-slug.eml` with fixed `From`, `Subject`, `Date` (with an explicit
   offset such as `+0800`) and `Message-ID` headers. Keep the body readable
   text (or HTML when testing the HTML fallback).
2. Add one `cases` entry to `labels.json` with the human label: `author`,
   `expect[]` (`action`, `dueAt`), and a short `note`. Use `expect: []` for a
   negative case.
3. Run `node eval/run-mail-local-gold.mjs` and review the fixture-level issues.
   Only then decide whether a threshold needs changing (usually it should not:
   the point of a gold set is to catch regressions, not to absorb them).
4. Run `node --test packages/advisers/test/eval-mail-local.test.js`.
