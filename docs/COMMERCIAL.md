# Commercial licensing: process, inquiry and sales-pack inventory

> **Status: process and inventory only — D1/G6 not decided.** Owner decision D1
> (due 2026-11-29) and D8 (evaluation, due 2026-12-06) have not fixed the selling
> entity, prices, invoicing, evaluation terms or refund policy. Nothing here is an
> offer, a price, a licence grant or legal advice, and the research numbers in the
> internal notes are not commitments. This page records who decides, what is
> blocked, and what can be prepared without promising anything.
>
> Facts re-checked 2026-11-24 (Asia/Shanghai). Legal text: [TOS.md](TOS.md)
> sections 3.1.1/3.1.2 and 15.3, [LICENSING.md](../LICENSING.md). Price page:
> [PRICING.md](PRICING.md) (skeleton; the only future price source).
> Commercial-licensing questions: [FAQ.md](FAQ.md).

## 1. What already exists (facts, not offers)

- Commercial use needs a separate written licence: [TOS.md](TOS.md) sections
  3.1.1/3.1.2 and [LICENSING.md](../LICENSING.md) (“Commercial use in client
  work”). Until that agreement is signed, commercial use is not licensed.
- The only public inquiry channel today is GitHub Issues with the title prefix
  `[commercial-license]` ([TOS.md](TOS.md) section 15.3). The README uses a GitHub
  label named `commercial-license` and `LICENSING.md` asks for the title prefix;
  all three mean the same triage. Unifying the wording is a D1 documentation item
  (this page uses the title prefix).
- Before this skeleton the repository had no price page (only a historical
  research note, `docs/PRICING-CHANNEL.md`). [PRICING.md](PRICING.md) is the single
  future price source and currently says “pending” in every row.
- There is no public trial, no purchasable build, no invoice promise, and no
  customer case study. The sales-pack inventory in section 6 is prepared from
  synthetic demo data only.
- Contributor rights: contributions are inbound under the project licences with a
  relicensing grant and DCO sign-off ([CONTRIBUTING.md](../CONTRIBUTING.md));
  whether that chain is sufficient for commercial licensing is owner/lawyer item 4
  below.

## 2. What D1 must decide (the decision package)

All five items are due **2026-11-29** (D1); the evaluation text also blocks D8
(2026-12-06). “Default if undecided” is the honest fallback wording, not a
decision.

| # | Decision | Options (research; not commitments) | Default if undecided | Owner |
|---|---|---|---|---|
| 1 | Selling entity and invoicing capability | individual with receipts/commissioned invoicing vs sole proprietorship/company able to issue ordinary or special VAT invoices | keep every page at “pending”; no purchase or invoice claim | owner |
| 2 | 30-day evaluation licence text and scope | a lawyer-drafted written evaluation licence (proposed: 1 legal entity, 1 named user, 1 pilot client project, 30 days, no auto-renew, no support promise) | “expression of interest only”; no evaluation can open | owner + lawyer |
| 3 | Private inquiry channel and sales PII | dedicated private channel plus an off-repo 0600 ledger with minimal fields, vs staying in public issues | public issue is triage only; no PII collected in-repo | owner |
| 4 | Contributor rights and trademark | confirm DCO + relicensing grant is sufficient, or upgrade to a signed CLA; decide what the licence says about trademarks | no commercial licence is issued until confirmed | owner + lawyer |
| 5 | Refund, discount and renewal policy | one public flat policy before the first sale; no hidden discounts (no promotion-style pricing) | no refund/renewal promise; do not accept payment | owner + lawyer |

Price numbers are deliberately **not reproduced here**: the internal research
notes carry candidate anchors, but a public document must not anchor expectations
before D1. When D1 decides, the numbers appear only in [PRICING.md](PRICING.md).

## 3. Private inquiry channel (current SOP, target SOP after D1)

**Current (public triage only):**

1. The requester opens a GitHub issue titled `[commercial-license] …`. Do not
   ask for or post a legal entity name, contact details, tax ID, client names,
   contract text, credentials or ledger data in a public issue. GitHub stores
   public issues, possibly outside the requester jurisdiction ([TOS.md](TOS.md)
   section 15.3).
2. The maintainer replies in the issue only to acknowledge and to say that details
   will be requested through a private channel once D1 item 3 exists. No price,
   evaluation or availability promise is made in the issue.
3. Nothing from the issue is copied into the repository, logs or sales material.

**Target after D1 item 3 (not active yet):**

- Move the conversation to the private channel chosen by the owner; collect only
  the minimum fields (requestId, openedAt, legal entity, region, request type,
  requested tier, status, termsVersion, next action) in an off-repo 0600 ledger.
- No product telemetry is added; conversion tracking is a manual weekly note.
- Delete or archive the ledger entry on request; never mirror it into the repo.

## 4. Sales-pack inventory (demo synthetic data only)

**Hard rule: only `advisers demo` synthetic data.** A real bundle/home is
plaintext and can contain customer notes and mail-account metadata
([PORTABILITY.md](PORTABILITY.md) sections 7/11); real bundles, real customer
names, screenshots of a real ledger and real client files must never go into the
pack. The demo client/company in `lib/demo-data.js` are fictional and marked
“示例/合成”.

**External-use gate:** the pack may be prepared now, but it must not be sent to a
candidate customer until (a) `node scripts/check-eval-report.mjs --release`
reports 0 FAIL for the release evidence, (b) D1/D8 have decided the evaluation and
channel, and (c) the legal text gate for any claim has cleared. Do not write
“verified”, “accuracy”, “compliant” or any service-level claim in any pack material;
`verificationBasis: local-checksums-only` means the package is internally
consistent, not that it is signed or true.

| # | Pack item | Source / command | Boundary notes |
|---|---|---|---|
| 1 | One-page mechanism sheet | [POSITIONING.md](POSITIONING.md) three evidence chains; [AGENT-INTEROP.md](AGENT-INTEROP.md) read-only boundary | no screenshots, no claims beyond the three commands |
| 2 | Demo artifact set | `advisers demo --json` (isolated OS-temp home; 0 model, 0 network; ~8 child steps) | record `demoHome`, `out`, the demo client id (`receipt.subject.id`), each artifact sha256; the demo runtime is not a contract and the demo home is not deleted automatically |
| 3 | Portable bundle of the demo home | `ADVISERS_HOME=<demoHome> advisers export --bundle <out>/bundle --json` | plaintext; demo synthetic data only; record `manifestDigest`/`dataDigest`/counts |
| 4 | Clean-machine verify record | `ADVISERS_HOME=$(mktemp -d) advisers import --bundle <out>/bundle --verify --dry-run --json` | must show zero writes to the clean home; `verificationBasis: local-checksums-only`; run on the release tag |
| 5 | Context-pack sample | `ADVISERS_HOME=<demoHome> advisers context-pack create --subject client:<demoClientId> --yes --recipient "Synthetic review" --purpose external-review --out <out>/pack --json`, then `advisers context-pack verify <out>/pack --json` | offline 0/1; the manifest records `confersReadAuthority`/`confersExecutionAuthority` as false; no import path; demo data only |
| 6 | Delivery-receipt sample | `ADVISERS_HOME=<demoHome> advisers deliveries --receipt --client <demoClientId> --out <out>/receipt --json`, then `advisers evidence verify <out>/receipt --json` | offline 0/1; record `manifestDigest`; the verifier warns that the pack is not externally anchored (internal consistency only); demo data only |
| 7 | Seven-minute walkthrough | script/recording of the demo steps (client → quote → proposal → notice → receipt → receivable → reminder → verify) | label “synthetic data; runtime varies”; do not present it as a customer result |
| 8 | Clean-machine verify record template | the field list below | one record per machine/attempt; keep usernames/paths out of the repo |
| 9 | Listing assets | one-line description, bilingual description, icon, licence statement, install command | see [AGENT-INTEROP.md](AGENT-INTEROP.md) section 13; the licence statement must say source-available + commercial licence required, not “free” |

**Clean-machine verify record template** (copy per attempt; not a claim until
filled on a named machine):

| Field | Value |
|---|---|
| date / time zone | e.g. 2026-11-24 Asia/Shanghai |
| machine | OS + version + architecture, Node version |
| repository state | git tag or commit + package version |
| artifacts | bundle dir name, `manifestDigest`, `dataDigest`, table counts |
| commands and exit codes | export / import --verify --dry-run / context-pack verify / evidence verify |
| zero-write check | clean home left empty (list what was checked) |
| verificationBasis | `local-checksums-only` (what it does and does not prove) |
| operator and evidence boundary | who ran it; what was shared, where |

**Example record (internal reference run; not a customer claim).** Prepared
2026-11-24 on the `v0.5.0` tag (commit `a73c380`), Node 24.22.3, every home under
an OS temp directory; synthetic demo data only. Digests are truncated here for
readability; keep full transcripts with the pack, not in the repository.

| Field | Value |
|---|---|
| demo | `ok:true`, 8 steps applied, 11 artifacts |
| demo client | `cl_9cc985b539814b7e` (“王工(示例)”) |
| bundle | `format: advisers-bundle`, `version: 1`, `verificationBasis: local-checksums-only`, `manifestDigest: 1831314…`, `dataDigest: 9d9abe5…`, 13,051 bytes |
| clean import | `import --bundle --verify --dry-run`: `ok:true`, `dryRun:true`, same `dataDigest`, clean home left empty |
| context pack | `context-pack create --yes`: `manifestDigest: e873cee…`, `fileCount: 3`; `context-pack verify`: `ok:true` |
| delivery receipt | `format: advisers-delivery-receipt-pack`, `version: 2`, `scope: subject`, `deliveryCount: 3`, `verifyStatus: passed`, `anchored: false`; `evidence verify`: `ok:true`, warning “not externally anchored” |

That run shows the commands work on the release tag with synthetic data; it is
not release evidence and not a quality claim. Re-run on the actual release tag
before sending anything out.

## 5. 30-day evaluation summary (outline only, no terms)

Status: **not open**. This outline is for the one-page summary that can be
published only after the lawyer-approved evaluation licence exists (D1 item 2);
it must link to that text and must not restate its terms.

- Who it is for: one legal entity evaluating a commercial licence before buying.
- Proposed scope, pending lawyer: 1 named user, 1 pilot client project, 30
  calendar days from issuance, no auto-renew, no redistribution, no support
  promise; stop commercial use or convert when it ends.
- Flow: public issue triage → private channel → eligibility check → signed
  evaluation licence (`evalId`, `termsVersion`, expiry kept off-repo) → day 23/29
  reminders → convert to a commercial licence or close the file.
- Not included: prices, purchase, invoicing, refunds, service-level support targets, case studies.
- No product telemetry and no activation/phone-home are added for evaluation.

## 6. Timeline and gates

| Date | Item | Status on 2026-11-24 |
|---|---|---|
| 2026-11-29 | D1: entity/invoicing, evaluation text, private channel, contributor rights, refund policy | **not decided** |
| 2026-12-06 | D8: 30-day evaluation decision | **not decided** |
| release evidence | `check-eval-report --release` 0 FAIL on the release tag | **not yet green**; any external pack use waits for this |
| after D1/D8 | price numbers may appear in [PRICING.md](PRICING.md) only; purchase/invoice claims may appear only then | blocked |

## 7. Do not say

- purchase, invoicing/receipts, trials or 30-day evaluation offers — none of these
  is available before D1/D8 and the lawyer text.
- “official marketplace listing”, “verified on DSH/Claude Code/Goose”,
  “compatible with every host” — host support is configuration-level only
  ([AGENT-INTEROP.md](AGENT-INTEROP.md) section 12).
- “verified”, “accurate”, “compliant”, service-level guarantees, “enterprise-grade”,
  “fully offline” — see the Say/Don’t say table in [POSITIONING.md](POSITIONING.md).
- “replaces a human assistant/EA”, “second brain”, “AI secretary” — not the
  product-positioning language.
- Any price or discount amount outside [PRICING.md](PRICING.md).

## 8. Related documents

- [PRICING.md](PRICING.md) — price page skeleton; the only future price source.
- [FAQ.md](FAQ.md) — 12 commercial-licensing answers.
- [TOS.md](TOS.md), [LICENSING.md](../LICENSING.md), [CONTRIBUTING.md](../CONTRIBUTING.md).
- [PORTABILITY.md](PORTABILITY.md), [CONTEXT-PACK.md](CONTEXT-PACK.md) — bundle/pack
  boundaries used by the sales pack.
- [AGENT-INTEROP.md](AGENT-INTEROP.md) — host configuration and DSH catalog submission.
- [POSITIONING.md](POSITIONING.md) — positioning and the Say/Don’t say table.

> This page is process documentation, not legal advice or an offer. The written
> evaluation licence and commercial licence come from the owner and the lawyer;
> when they conflict with this page, those documents govern.
