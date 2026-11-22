# Advisers architecture

> Status: **0.4.2 release tree (schema v22)**. The repository package version is
> `0.4.2`; `0.4.1` is the previous same-day follow-up patch, `0.4.0` the published
> feature release and `0.3.2` the baseline before it. 0.4.2 is a patch on 0.4.1
> (manual fact entry, the read-only IMAP probe, foreground mail watch, the `sync pull
> --dry-run` preview, the backup-age hint in `doctor --check-db`, subcommand `--help`
> consistency and the local mail-extraction gold gate) with **no schema change and no
> frozen-contract change**. 0.4.1 added the KB/mail review links, the reminder delivery
> policy, the kb/mail/policy deterministic eval groups and the documented-additive CLI
> contracts. 0.4.0 is the "local knowledge + interaction shell" feature release: it adds
> the deterministic knowledge base (schema v22, compiled pages, fact time travel), the interactive readline shell,
> proactive urgency/whyNow + morning archive + scheduler v2, the local mail entry
> (IMAP read-only + `.eml` import, local extraction by default), the receivables
> money sidecar, the policy/evidence 0.4 subset (egress registry + consent + four-state
> resolver + evidence pack v2), MCP dual-era (legacy + modern `2026-07-28`), and the
> Windows support matrix. **Default remains zero model / zero network**: model egress
> (chat/research/capture/mail `--model`) is explicit opt-in and mail/KB expose no model
> or network path by default; mail sync is the only new network entry point and is
> user-initiated. Anything marked *target* below is not shipped; `0.4.1`, `0.4.0`,
> `0.3.2` and earlier remain installable by pinning but are superseded.
> This document fixes the vocabulary and the invariants; the implementation is allowed to
> be smaller than the document.

## 1. The shape

```
                 ┌──────────── Core (pure cordis) ────────────┐
                 │ Matter / FocusFrame / user ledger /        │
                 │ commitment ledger / routine ledger /       │
                 │ recall / curator / redaction               │
                 └───────────────┬────────────────────────────┘
                                 │ Link SPI
        ┌────────────┬───────────┼────────────┬─────────────┐
   link-email   link-satori   link-dsh-im   link-openclaw  link-hermes
                                 │
        ┌────────────────────────┴────────────────────────┐
   advisers (cordis-only)                     dsh-advisers (DSH)
   own minimal host + CLI                     DSH session/agent/llm/tools
```

- **One thread**: the user faces one continuous conversation.
- **Three ledgers**: user (who you are), commitments (who owes whom), routines
  (how this kind of work is done here).
- **Two loops**: foreground (listen → answer/act → receipt → ledger) and
  background (nightly reconcile → diff → next-day confirmation) as a **design target**
  only. 0.2.3 has **no daemon**; the only scheduled thing is the opt-in
  `remind install --apply` user-level scheduler entry (cron on Linux, Task Scheduler on
  Windows) that emits reminders.
- **Matter is a dimension, not a fourth ledger.** Commitments, facts, and
  decisions carry `matterId`; the global user model does not.

## 2. Invariants

1. **The model proposes; the ledger commits.** A chat model never writes a
   ledger directly. `remember`, `commit`, `complete`, and `forget` are ledger
   operations with evidence.
2. **Done needs external evidence.** Model self-report is not evidence.
3. **The global user model always crosses matters; the matter body never does.**
   Preferences about the person are global; the contents of another matter are
   not injected.
4. **Other matters are hints, not context.** A hint is a title plus one line of
   "why"; opening it is a separate, authorized fetch.
5. **No hard delete.** Facts and preferences get tombstones; a matter delete
   keeps shared facts and removes only its membership.
6. **The core never imports a link, a platform SDK, or DSH.** Links are optional
   plugins behind the SPI; the two distributions only differ in the host.
7. **A turn is a transaction.** Routines and focus frames use a generation
   number; changes apply on the next turn, never mid-turn.

### 2.1 0.3.0 architecture invariants (reviewed per release)

The 0.3.0 planning froze ten invariants for the read/model/contract surfaces. They are
recorded here with an honest status on the 0.4.2 tree; "target" means the
design is accepted but the code does **not** enforce it yet, and no release note may claim
it.

| # | Invariant | Status on the 0.3.0 tree |
|---|---|---|
| 1 | **One real ledger**: `~/.advisers/state.db` is authoritative; exports/receipts/projections are derivatives. | In place. JSON store is a degraded fallback, not a second truth (and has no v22 KB/mail/money tables). KB pages and evidence packs are explicitly derived. |
| 2 | **Reads take no write lock; writes do not depend on the HOME lock** (post-0.3.2 target, still open in 0.4.0: the HOME lock becomes a maintenance lock). | Read side in place (lock-free read-only connection; `lib/ledger-read.js` never takes the HOME lock). Write commands still take the HOME instance lock in 0.4.0; downgrade remains a later target. |
| 3 | **DSH zero-write**: the host adapter opens no write connection, writes no ledger audit, runs no migration, creates no HOME. | In place: the three read tools use the facade (`readOnly: true`, no DDL/migration, no HOME creation); per-tool audit goes to the host's audit sink, never to the ledger. |
| 4 | **Decisions are pure functions**: `evaluate(facts)` deterministic, fail-closed; adapters only provide facts. | Partial (0.4.0 subset): `lib/policy/` ships a pure `evaluate(facts)` + rule table + one-shot decision token + egress registry + consent file for the **new 0.4 data surfaces**; pre-0.4 paths keep their legacy gates (active-matter egress/TOS/clearance). **Do not claim a unified/inescapable policy** — see §9 and `docs/SECURITY.md`. |
| 5 | **One side effect = one decision = one audit row** for ledger writes; fs/network two-phase intent/result is a later target (not in 0.4.0). | In place for ledger writes (incremental write + one audit row per command, 0.2.3); 0.4.0 adds an intent/result audit pair for the new policy surfaces only. Filesystem/network atomicity is **not** claimed. |
| 6 | **Evidence is resolvable**: every source is resolved / missing / unverifiable / not_checked; missing evidence is honest, never forged. | In place for the 0.4.0 subset: typed resolver (`verified|missing|unverifiable|not_checked`), source v2 read path (conversation/mail/calendar/transcript/KB/web/tool/manual), purged-retention honesty, evidence pack v2 with `byKind`/`notCheckedCount`/`verificationBasis`; `coverage/limitations/unknowns` remain post-0.4. |
| 7 | **Read models never silently drop data**: list results carry `total`/`truncated`. | Partial: MCP list tools and DSH read payloads carry explicit caps + totals; CLI read models have per-command caps but not one universal envelope. |
| 8 | **Contracts are additive**: CLI JSON / MCP / DSH only add optional fields inside 0.x. | In place for the shipped surfaces: `contracts/` v1 is frozen from `35a51c3`; MCP adds tools/resources/caps without renames; the DSH read payload keeps the 0.2.x field names and adds fields. |
| 9 | **One migration per version, one registry**: no silent `SCHEMA_VERSION + 1`. | In place: 0.4.0 adds exactly one migration, **v22 (`kb-mail-payment-entities`: KB document/chunk/fact-link/page tables + KB FTS, mail accounts/messages/cursors/runs, receivables/payments)**. v21 (customer entities) was the 0.3.0 step. One-way upgrade: a 0.3.2 CLI opening v22 fails closed with `E_SCHEMA_NEWER`. |
| 10 | **Failures are honest**: preview is marked, missing data is a structured `E_*`/`LEDGER_*` error, never empty data pretending "none". | In place for MCP, DSH, the ledger facade and the CLI read paths. |

## 3. Core services (target)

| Service | Responsibility |
|---|---|
| `ctx.advisers.matter` | matter lifecycle, routing, merge/split |
| `ctx.advisers.user` | preference ledger, scope, confidence, forgetting |
| `ctx.advisers.commitments` | open/done/snoozed/dropped, evidence, nudges |
| `ctx.advisers.routines` | routine proposals, diffs, versions, rollback |
| `ctx.advisers.recall` | FTS5 first (trigram + seq indexes since v19/v20; v22 adds the independent KB FTS indexes; current schema v22, §11), vector optional (not in 0.4), 1–2 hop graph expansion |
| `ctx.advisers.curator` | design target: nightly reconcile, dedupe, expiry, brief draft (not scheduled in 0.2) |
| `ctx.advisers.redaction` | forget, pause, private session, export |

## 4. Link SPI

```ts
interface LinkProvider {
  id: string
  capabilities: { threads: boolean; cards: boolean; media: boolean; approvals: boolean }
  start(host: LinkHost): Promise<void>
  send(message: OutboundMessage): Promise<DeliveryResult>
  stop(): Promise<void>
}
```

`LinkHost.ingest` is idempotent by `messageId`; `resolvePrincipal` maps a
platform account to the runtime principal. The core owns identity, permission,
idempotency, and approval semantics; a link owns platform API calls, retries,
pagination, and media download.

## 5. Dual distribution

| Distribution | Host | Links | First release |
|---|---|---|---|
| `advisers` | upstream `cordis` | email/share, Satori | 0.1 |
| `dsh-advisers` | `@deepseek-ai/cordis` + DSH | `dsh-im-union` or `@xmanrui/dsh-im` | 0.3 |

The same `packages/core` source is used by two thin adapters. **Do not alias
`cordis` to `@deepseek-ai/cordis`**: the two packages are symbol-level breaking
(`ctx.root`, `Service.config`, `FiberState` erasure), and a runtime alias leaves
`import 'cordis'` in the published artifact. The core imports neither host; each
distribution owns its adapter and its peer dependency.

## 6. What is deliberately not here

- Multi-user/team sync, a plugin marketplace, voice, and autonomous outbound
  sending are out of scope until the three-ledger loop is proven.
- A vector database is not required at the start: FTS5 plus scope/entity
  filters is enough for the first few hundred facts.

## 7. Soul, thread, routines, association

These four are part of the original product thesis; they are **not** 1.0
afterthoughts.

| Concept | Rule | Status |
|---|---|---|
| **Soul** | Human-owned, versioned, slot #1; the agent may propose a diff, never write it. | Type `SoulDocument`; store port in `HostPorts.soul` |
| **Thread** | One continuous relationship per principal; a thread contains many matters/episodes. `conversation` is a link concept, not the relationship. | Types `Thread`/`Episode`; runtime still routes by conversation |
| **Routine** | Proposed from a successful task; needs a diff, regression case, and human approval; never auto-activated. | Implemented as draft/approve/patch/curator; verification is still basic |
| **Association** | `MatterLink` (8 closed types) + `UpdateProposal`; cross-matter writes are proposals, never direct writes. | Types + in-memory ledger methods |

The association schema exists from day one even though the UI/logic ships later:
adding a `MatterLink` table after the fact is a migration, adding it now is free.

## 8. Revised sequence (after the self-audit)

| Version | Must prove |
|---|---|
| 0.1 | Soul slot + user ledger + commitment ledger + teaching receipt + **30 probes** + SQLite + CLI |
| 0.2 | Routine capture + diff + approval (manual first) + email/share link + eval harness |
| 0.3 | **Trustworthy delivery (0.3.0, published 2026-11-20):** read-only ledger facade + read-model projections + MCP output caps/legacy protocol negotiation + interface contracts + TUI output kernel; DSH reads the real ledger read-only. Association hints and the interactive TUI shell move later. |
| 0.4.0 | **Local knowledge + interaction shell:** interactive readline shell, deterministic KB (schema v22), proactive urgency/morning archive/scheduler v2, local mail entry, money sidecar, policy/evidence 0.4 subset, MCP dual-era, Windows support matrix |
| post-0.4 | Feishu/cross-matter proposals + full policy engine/Evidence 2.0 + model-assisted KB compile/ask + full DSH write (0.5+) |
| 1.0 | SPI frozen + 20 users × 30 days metrics + two external links |

The earlier plan put routines at 1.0; that makes the product a commitment
tracker for a year. Routines must appear by 0.2 to keep the "intern" promise.

## 9. Current limits (0.4.2 release tree; schema v22; 0.4.1 was the previous same-day follow-up and 0.4.0 the published feature release)

- Ledger persisted in SQLite (`advisers/lib/sqlite.js`); JSON mode is a fallback but loses turns/search/audit (and has no KB/mail/money tables: those commands answer `E_STORE`/`E_SCHEMA_STALE`). Physical schema is **v22** (`SCHEMA_VERSION = 22`): v21 was the customer-entity step, v22 adds the KB, mail and money tables plus the two KB FTS indexes in one `kb-mail-payment-entities` migration (backup -> migrate -> verify; one-way, 0.3.2 fails with `E_SCHEMA_NEWER`). Date windows still run in JS (no `due_ms` migration).
- **Default zero model / zero network.** CLI calls a model only for the pre-existing chat/capture/research/capture-imap paths when `ADVISERS_API_KEY` is set, and mail extraction uses local rules unless `mail extract --model` is explicit + consented. KB, the shell, urgency/morning, receivables, MCP/DSH reads and KB page rebuild are local-only; `mail sync` and `mail import` are the only new mail network/local-import entry points and always user-initiated. Without a key, record/search/build still work; natural-language replies that need a model fail honestly.
- `dsh-advisers` implements six tools (`advisers_brief`, `advisers_office`, `advisers_today`, `advisers_who`, `advisers_evidence`, `advisers_clients`); it is a thin adapter, not a second product. In 0.3.0 the three ledger read tools read the **real local ledger** through the controlled `advisers/lib/ledger-read.js` facade (`docs/LEDGER-READ-API.md`): read-only, no HOME write lock, no migration, no HOME creation, no writes, TOS-gated and at clearance 0. A missing ledger, an unavailable facade (old `advisers` package / no `node:sqlite`) or `config.mode: "preview"` falls back to the marked preview (`preview: true`, `source: "preview-no-ledger"`, `note`, `[preview: no ledger]` prefix); every other gate failure (TOS/vault/schema/corruption/busy) is a structured `LEDGER_*` error, never empty data. The 0.2.0 npm packaging defect was fixed in 0.2.1 (explicit export + dependency). See CHANGELOG and `packages/dsh-advisers/README.md`.
- `secrecy` is stored; hard retrieval gating is partial. Audience scoping is enforced for preferences.
- Permit/GatedLink exist but are **not yet a mandatory boundary on every send path**.
- Deletion cascade covers sessions/turns/summaries/runs/nudges/deliveries + facts/title and candidate payloads; commitment/link/update/audit content redaction is partial.
- Office verification is structural (OPC/XML/rels/content types). Open validation is manual: WPS Writer, Spreadsheet and Presentation opened and extracted the generated files (2026-11-14). Microsoft Office is not installed on the test host and Office application-layer validation is still pending.
- No real IM account and no 5-user dogfood validation yet. Mail is a local v1: IMAP read-only (EXAMINE/FETCH), implicit TLS 993 or opt-in STARTTLS, no OAuth (Gmail Workspace/M365 password IMAP is disabled upstream; `.eml`/`.mbox` import is the fallback), no attachment download, no SMTP/send/write-back, no IDLE daemon. Credentials live in `$ADVISERS_HOME/credentials/imap/<account>.json` (0600 best effort; Windows relies on the user-profile ACL) and never enter the DB, export, backup, argv or logs.
- **KB (0.4.0)**: deterministic local ingest/search/pages only; no embeddings/vector store, no model compilation or `kb ask` (0.4.x), no automatic OCR (`needs_ocr` is reported), no MCP/DSH exposure. Extracted text is stored plaintext in `state.db` (see PRIVACY); source files are never copied and only basenames are stored. `kb link`/`kb unlink` are wired in the 0.4.1 CLI (the 0.4.0 tarball exposed the library only) and manual `fact add` (required `--quote`, one `fact.add` audit row) in 0.4.2; KB/mail/money export-import parity **is** wired since 0.4.0 (mail cursors and derived FTS excluded; `kb_pages` is cleared and rebuilt on import).
- **Money sidecar (0.4.0)**: `receivables`/`payments` are operator-entered local bookkeeping; no invoices/receipts/statements/dunning, no bank/payment-channel reconciliation, no FX and no money movement. Amounts never enter reminders, ICS/webhook, MCP/DSH, receipts, client status packs (0.4.0 pack has no amounts) or Pet Brief.
- **Policy/Evidence 0.4 subset**: `lib/policy/` pure engine + decision token + egress registry + `consent.json` cover the new data surfaces; pre-0.4 paths keep legacy gates and **a unified/inescapable policy is not claimed**. Evidence is four-state for the 0.4 resolver and evidence pack v2 (`byKind`/`notCheckedCount`/`verificationBasis`), verifier accepts v1/v2; exit 4/5/6 and errors/exit v2 stay 0.5 (0.4 keeps exit 0/1/3).
- **Windows (0.4.0)**: the supported matrix is Windows 11 25H2/26H2 x64 (npm is the only official channel; no installer/Homebrew/winget); CI runs the non-TTY smoke suite and `check-js`/docs gates. Interactive IME/old-conhost TTY behaviour remains manual, and file mode bits are best-effort (ACL). See `docs/WINDOWS.md`.
- **Audit tail anchoring (0.3.0)**: the local hash chain detects edits to its own rows; 0.3.0 adds `lib/audit-anchor.js` and the `audit --write-anchor`/`audit --expect-head`/`audit --expect-count` CLI surface, so deleting the tail becomes detectable **when an anchor exists**. This is a local anchor file (0600), not a third-party timestamp/TSA; see `docs/SECURITY.md` (`audit`/`privacy --prove`/`export` report the anchor state) and the CLI help.
- **Recovery (0.3.0)**: `backup` keeps managed, checksummed backups in `$ADVISERS_HOME/backups` with `--keep` rotation (only managed backups are rotated), `backups ls|verify` inspects/verifies them, `restore <file>` is a plan unless `--yes` and refuses an anchor-behind backup unless explicitly allowed, `doctor --repair` defaults to dry-run with `--only lock,temp,wal,fts`, and `audit --rebuild-fts` rebuilds the FTS indexes. `restore`/`doctor --repair` success paths write `db.restore`/`doctor.repair` audit rows and refresh the anchor; `backup` instead writes `.sha256`/`.anchor.json` sidecars aligned with the new backup's head (no audit row), so an immediate restore is anchor-match and only older backups need `--allow-anchor-behind`. Failures report whether the original database stayed intact. See `docs/SECURITY.md` and the CLI help.
- **TUI / shell (0.4.0)**: the 0.3.0 output kernel (`lib/tui/**`, `lib/text-safe.js`) remains the renderer for every human line (one `resolveOutputPolicy` per process for `--plain`/`--accessible`/`--color`, width/clamp, sanitisation, result/status/confirm/error blocks). 0.4.0 adds the interactive shell `lib/shell.js` (readline state machine, in-process history only, bracketed-paste merge, Ctrl+C/Esc abort, `ADVISERS_NO_SHELL=1` fallback to the old REPL); a non-TTY stdin keeps the 0.3.x help/exit-0 bytes and `tui --once/--json` stays frozen. Persisted shell history and PTY/Windows real-TTY snapshot tooling remain follow-ups. See [docs/TUI.md](TUI.md) §10/§13.
- **Performance (0.3.0)**: the T1 write-amplification fix removed the ordered status-predicate TEMP B-TREE spill (`pet-brief` now writes ~32 KB/run instead of 31.8 MB; `today` 32 KB instead of 5.8 MB at 200k rows) and the read-model projections moved `remind`/`tui`/`digest` inside target; `today` (151–158 ms median, target ≤150) and `pet-brief` (399/588 ms, target ≤400) are at the boundary, and `today --json` remains output-bound. Full A/B, method and caveats: [docs/PERFORMANCE.md](PERFORMANCE.md). Do not advertise the 0.3.0 performance table as fully met.
- **MCP (0.4.0, dual-era)**: still 8 tools + 5 read-only resources, capped after clearance and before the classifier with `total/truncated` (see [docs/MCP.md](MCP.md)). Legacy negotiation covers 2024-11-05 / 2025-06-18 / 2025-11-25 (default 2024-11-05) and is byte-compatible with 0.3.2; the stateless modern `2026-07-28` era is implemented in the same process (`server/discover`, per-request `_meta`, `resultType`/`ttlMs`/`cacheScope`, `-32022`), with `ADVISERS_MCP_MODERN=off` as a one-restart rollback. **KB and mail are not exposed over MCP/DSH in 0.4.0.**
- **Provenance (0.3.1 published)**: 0.2.3 and earlier were staged locally with owner OTP and have no npm provenance; `0.2.4` was **never published**; `0.3.1` supersedes `0.3.0`. 0.3.0 was the first CI OIDC/Trusted-Publishing release: on 2026-11-20 all six 0.3.0 packages showed non-empty `dist.attestations` (SLSA `https://slsa.dev/provenance/v1`) from commit `1199fbf`, and its post-publish `verify-release --version 0.3.0 --tag latest --sbom artifacts/sbom.cdx.json --require-sbom` run passed 222 checks (release notes: <https://github.com/PerryLink/advisers/releases/tag/v0.3.0>). Its release surface was incomplete — the tarball README was candidate text, the attestations named the build ref `refs/heads/main`, the GitHub Release had no SBOM/checksum assets and `next` was still at 0.2.3 (since advanced to 0.3.0) — so `0.3.1` re-runs the publish from `refs/tags/v0.3.1` and attaches the CycloneDX SBOM plus `SHA256SUMS` to the release; the runtime is unchanged. Supply-chain artifacts: `scripts/check-provenance.mjs`, `scripts/sbom.mjs` + `scripts/check-sbom.mjs` and [docs/SBOM.md](SBOM.md) (lockfile-derived gate artifact, not a build graph, vulnerability scan or reproducible-build proof).

## 10. Intent, Office, and Affect policy

These are first-class layers, not prompt tricks.

- **Intent** (`core/intent.ts`): a `IntentBrief` with `verbatim`, `goal`,
  `deliverable`, `audience`, `due`, `constraints`, `assumptions`, `unknowns`,
  `risk`, `confidence`, `action`, at most one question, and a two-line
  `readback`. It is injected as a compact `<intent>` block between `<soul>` and
  `<advisers-context>`; the full brief is not re-injected every turn.
- **Office** (`advisers-office`): an independent package with `buildDocx`,
  `buildXlsx`, `buildPptx`, `buildMermaid`, `buildDrawio`, `buildXmind`, and
  `validateOffice` (OPC required parts + relationship targets). The core never
  imports it; the CLI loads it dynamically.
- **Affect policy** (`core/policy.ts`): `understanding` is always allowed;
  `companion` and `roleplay` are off by default and require an explicit
  `AffectPolicy`. Policy packs, crisis scripts, and dependency guards live
  outside the core, so enabling a future policy does not change core code.

The chief-of-staff protocol (receive → clarify → plan → execute → report →
review) is the interaction contract; the current runtime implements the
`IntentBrief` half and leaves the full state machine for a later release.

## 11. Full-text search (schema v20; trigram since 0.2.2; KB FTS in v22)

Local full-text search runs on FTS5 indexes instead of scanning
`turns.content`. 0.2.2 introduced the trigram indexes at schema v19; 0.2.3 bumps
the schema to v20, keeps the same FTS indexes and adds the `idx_turns_seq`
early-stop index used by the 2-character `LIKE` fallback (plus the v20 migration
ledger — see §12):

- **Indexes**: `turns_fts` over `turns(content)` and `summaries_fts` over
  `session_summaries(summary)`. Both are FTS5 external-content tables
  (`content='<table>'`, `content_rowid='rowid'`) kept in sync by insert /
  update / delete triggers, so the index follows each row transaction and never
  needs a manual rebuild after normal writes.
- **Tokenizer**: `tokenize='trigram'` for both (needs SQLite >= 3.34; Node
  22.16+/24 ships it). A trigram index stores every 3-character substring,
  which is what makes Chinese substring and phrase search work. v18 used the
  default unicode61 tokenizer, which treats a run of CJK characters as a single
  token: in the 2026-11-17 round-2 audit `MATCH '报价单'` returned 0 rows, so
  every Chinese search fell back to `LIKE '%q%'` (full table scan, 15.4 ms at
  50k turns).
- **Query strategy** (`SqliteStore.searchTurns` / `searchSummaries`): 3+
  characters go through `MATCH` (substring/phrase; trigram matching is
  case-insensitive for ASCII by default); shorter queries, malformed FTS
  syntax (`"`, bare `AND`/`NEAR(`, a lone `*`, `;`, ...) and text the
  index cannot tokenize fall back to the v18 `LIKE` path, which remains the
  correctness backstop. The fallback keeps SQL LIKE semantics, so `%` and `_`
  in a query are wildcards (unchanged from v18). The public result shape,
  filters (`conversationId`/`matterId`) and `limit` are unchanged; ordering
  keeps the two v18 conventions — FTS hits are ranked (`ORDER BY rank`), LIKE
  hits come back in `seq` order. One visible consequence: Chinese queries now
  reach the FTS path, so they are relevance-ranked instead of returned in the
  old `LIKE` seq order.
- **Migration**: schema v19 drops the v18 unicode61 index, recreates both
  trigram indexes and their triggers, and backfills with FTS5's `'rebuild'`
  from the source tables — all inside the same write transaction. The v19→v20
  step only creates the migration ledger and the new indexes (no FTS rebuild).
  Both run through the per-version step table described in §12.1: a
  `state.db.before-migrate-v19-*` copy is written and verified first, a failed
  step rolls the DDL back and leaves the previous schema usable, and a database
  with a schema newer than this CLI is still refused.
- **Degradation**: if the SQLite build has no trigram tokenizer, the store
  rebuilds the legacy unicode61 index, sets `ftsWarning` and prints one stderr
  warning; Chinese search then answers through `LIKE`. If FTS5 itself is
  missing, search is LIKE-only. Opening never fails because of a missing
  tokenizer. `ADVISERS_FTS_TOKENIZER=unicode61` forces the legacy tokenizer
  (operator escape hatch; the tests use it to pin the degraded path). A database
  forced to unicode61 keeps it: the schema is already v19, so there is no
  automatic retry.
- **Cost, corrected for realistic ledgers** (synthetic DBs with ~75-character
  Chinese turns, `/tmp` ext4, 2026-11-18): the trigram index is **≈0.8–0.9× the
  indexed content and ≈19–20% of the database**, not the +2.8 MB figure that a
  0.2.2 note derived from a 9.7 MB toy database. Measured `turns_fts` index data:
  10.6 MB at 50k turns (DB 56.4 MB), 21.1 MB at 100k (DB 112.0 MB), 42.5 MB at
  200k (DB 224.6 MB), plus a 2.0 MB FTS `docsize` table at 200k; `summaries_fts`
  is ~60 KB–209 KB. `ORDER BY rank` still scores every matching turn, so a very
  common term (thousands of matches) is the slow end.
- **2-character CJK fallback** (schema v20 `idx_turns_seq`): the LIKE scan still
  runs, but `ORDER BY seq DESC LIMIT n` can now early-stop on the index. Measured
  in-process `searchTurns("报价")`: 11.6 / 25.3 / 46.4 ms at 50k/100k/200k turns
  for the unfiltered scan; with the seq index a common 2-character term's top-10
  drops to 0.07–0.14 ms, while a rare term's worst case grows ~30–40% (15.1 →
  63.4 ms at 200k; the scan must still visit candidates). The SQL semantics are
  unchanged. 3-character Chinese queries go through `MATCH` and stay in the
  ~0.1–5.5 ms range; `summaries_fts` queries are ~0.1 ms.
- **Limits**: 2-character CJK queries still need the LIKE scan (the early-stop
  index only reduces the common-term cost); trigram ranking is
  substring-frequency, not semantic; the LIKE fallback treats `%`/`_` as
  wildcards; the index is larger than unicode61 and retention/eviction is not
  implemented (FTS5 tombstones make deletion grow the index until an
  `optimize`/`rebuild`). 0.3.0 adds `advisers audit --rebuild-fts` as the explicit
  rebuild maintenance command; automatic retention/compaction is still backlog.
- **KB FTS (0.4.0, schema v22)**: the knowledge base adds two independent
  external-content trigram indexes, `kb_fts` over `kb_chunks(text)` and
  `kb_pages_fts` over `kb_pages(title, markdown)`, each with insert/delete/update
  triggers. They are created by `_setupKbFts()` inside the v22 migration (the
  tokenizer is probed at runtime, trigram -> unicode61 -> LIKE-only) and are **not**
  part of `FTS_TABLE_NAMES` (the turn/summary `_setupFts` DDL stays untouched), so
  `doctor --repair --only fts` maintains both pairs and `kb reindex --rebuild`
  rebuilds the KB pair from the stored chunks/pages without re-reading source
  files. Same query strategy as §11: 3+ character terms use `MATCH`, 2-character
  CJK/short queries use `LIKE` and report `degraded`; snippets cap at 240
  characters and return offset highlights, never HTML.

## 12. Persistence v2 (0.2.3; schema v22 in 0.4.0)

0.2.3 changed how the SQLite ledger is migrated, read and written; 0.4.0 keeps the
same machinery and bumps the physical schema to `meta.schema_version = 22` with one
step (`kb-mail-payment-entities`). The wire snapshot format is unchanged
(`LedgerSnapshot.version` stays 1), so JSON-mode stores and old exports keep
working; the new v22 tables (KB, mail, money) are SQLite-only and never enter the
ledger snapshot.

### 12.1 Migration ledger

Schema v20 added the `schema_migrations` table
(`version, name, applied_at, duration_ms, backup_path`) and `migrate()` becomes a
per-version step table instead of one monolithic block:

1. a pre-migration backup is taken **before** the migration transaction (if
   another connection prevents the required WAL checkpoint the migration is
   refused), then opened and verified (schema version plus row-count samples of
   the main tables);
2. every step runs inside one `BEGIN IMMEDIATE` transaction; steps are
   idempotent so a crash-retry is safe;
3. a step is recorded in `schema_migrations` only after it succeeds, and only
   then is `meta.schema_version` bumped (the backup path is recorded on the
   ledger row and in meta);
4. a failed or killed migration rolls the whole step back and leaves the old
   database usable and retryable. A database with a schema newer than the CLI is
   refused (`E_SCHEMA_NEWER`).

0.4.0 keeps the same rules for v22: the step is idempotent, creates the four KB
plain tables, the two external-content KB FTS indexes (runtime tokenizer probe), the
mail four tables and the two money tables inside the migration transaction, and
records one `schema_migrations` row. `state.db.before-migrate-v21-*` remains the
supported manual rollback (restore it; there is no downgrade migration).

### 12.2 Lock-free read snapshot

Read commands no longer take the cross-process writer instance lock or open a
writable store. They open a `readOnly` SQLite connection that performs no DDL,
no migration, no journal-mode pragmas and no lock row, so reads keep working
while a long-lived `ui`/`mcp` process holds the writable store, and they see the
last committed WAL snapshot. Opening asserts the schema up front: a stale
database fails with `E_SCHEMA_STALE` (a writable command must migrate it first)
and a future one with `E_SCHEMA_NEWER`; the CLI decides whether to fall back to
the writable path. Reads go through the same partial-loading contract as
before: per-table loaders/counts return byte-identical row objects to a full
`load()`, missing tables are treated as empty by `Ledger.fromParts`, and tests
pin the tables a command must not touch with throwing stubs plus `EXPLAIN`.

### 12.3 Incremental writes

Hot write commands no longer do full-ledger load + full-snapshot save. The
pure ledger operations live in `packages/core/src/ops.ts` (commit
add/edit/done/snooze, correct, decay, forget, memory accept/reject); the CLI
executes each one as a directed INSERT/UPDATE of the changed rows plus exactly
one audit row in a single `BEGIN IMMEDIATE` transaction
(`store.mutateWithAudit`). Validation and file checks stay outside the
transaction; the JSON store keeps the legacy in-memory path. A rollback leaves
the ledger rows and the audit chain unchanged together, and each write keeps
the audit chain rule “one audit row per write command”. Incremental row codecs
cover the four entities the write commands touch (matters, commitments, facts,
preferences); paths that genuinely need the whole ledger (`tick`, import/export,
delivery packs) still load it.

### 12.4 Measured effect (200k rows)

| Path | 0.2.2 | 0.2.3 |
|---|---:|---:|
| `commit add` | 3,709 ms, ~185 MB process writes (~93 MB WAL growth) | 108 ms, ~90 KB process writes (~21 KB WAL growth) |
| `correct` | 3,296 ms, ~185 MB | 105 ms, ~90 KB |
| `memory accept` | 3,334 ms, ~185 MB | 105 ms, ~86 KB |
| `ls` | 1,948 ms | 74 ms |
| `memory search` | 2,125 ms | 163 ms |
| `mcp --stdio` init | 1,850 ms | 91 ms |
| `today` | 571 ms | 317 ms |

Full A/B table, method and the targets that are still missed are in
[docs/PERFORMANCE.md](PERFORMANCE.md). The 0.2.3 read targets were not fully
met: `today` (317 ms vs ≤150 ms) and `remind`/`digest`/`tui`/`pet-brief`
(972/641/814/1,809 ms vs ≤400 ms).

**0.3.0 development (200k synthetic read ledger, shared host, medians):** the T1
write-amplification fix removed the `ORDER BY rowid`-after-status-predicate TEMP B-TREE
spill (`pet-brief` 31.8 MB → 32 KB process writes; `today` 5.8 MB → 32 KB; `today --json`
10.8 MB → 28 KB), and T2 narrow SQL projections moved `remind` (1,041 → 335 ms), `tui`
(972 → 216 ms) and `digest day` (551 → 226 ms) inside/near target. `today` (230 → 151 ms)
and `pet-brief` (2,171 → 399/588 ms) sit at the target boundary, and `today --json`
(737 → 751 ms) is output-bound by ~27 MB of stdout. Method, caveats (shared host,
small-sample medians, no-turns synthetic ledger) and the still-open MCP first-call
latency are in [docs/PERFORMANCE.md](PERFORMANCE.md).

### 12.5 WAL sidecar recovery

Before SQLite can silently ignore an unusable WAL, the store classifies the
sidecar: an invalid header/last frame preserves the exact bytes as
`state.db-wal.corrupt-<ts>`, quarantines the unusable WAL (and the rebuildable
`-shm`) and warns (`E_WAL_CORRUPT`); a truncated WAL keeps the valid prefix,
copies it aside as evidence and warns (`E_WAL_TRUNCATED`). No database bytes are
ever deleted. `doctor --check-db` reports the sidecar status and the FTS/backup/
plaintext checks without opening the store, while the default `doctor` stays
lightweight (no writer lock, no O(database) `quick_check`). Durable file writes
(vault, backup, import, sync staging, pet-brief output and other opted-in CLI
writes) go through `lib/fs-safe.js`: short-write loop, fsync file+directory, same-directory temp
file with length verification, atomic rename, and bounded retries for transient
Windows/AV/OneDrive errors.

## 13. 0.3.0 additions and their contracts

The 0.3.0 tree adds these surfaces. Each has its own document; this section is
the map, not a second source of truth.

| Surface | Where | Contract / status |
|---|---|---|
| Read-only ledger facade | `packages/advisers/lib/ledger-read.js`, subpath `advisers/lib/ledger-read.js` | Versioned contract ([docs/LEDGER-READ-API.md](LEDGER-READ-API.md)): read-only, TOS-gated, no HOME lock, no migration, clearance 0, frozen `E_LEDGER_*` codes. |
| Narrow read-model projections | `lib/sqlite.js` (`project*` methods) + `bin` read paths | The projections add no migration of their own (the 0.4.0 tree is schema v22 after the KB/mail/money step); view builders consume projected rows; `test/read-model-projections.test.js` pins row/column/order equivalence. |
| Customer entities (additive schema v21) | `lib/sqlite.js` (migration v20→v21), `packages/core/src/customer.ts`, `bin` `client`/`project` commands ([docs/CLIENTS.md](CLIENTS.md)) | 0.3.0 ships the minimal customer loop: clients/projects/client_notes tables, matter ownership, `commitments.created_at`, delivery lineage, `client add/list/show/timeline/archive/merge`, `project add/list/show/archive`, `matter add --client/--project`, the derived timeline and the opt-in `--clearance` gate. Receipt `--client` filtering, customer status packages and MCP/DSH customer tools remain out of 0.3.0. **Export/import parity**: `export --all` carries the new tables through the single store-owned `DATA_TABLES` list, and `import --replace` restores the ledger + customer tables in one transaction (dangling references abort atomically; the local audit chain is never replaced by an import). The JSON wire format (`LedgerSnapshot.version`) stays 1. |
| MCP output caps + legacy negotiation | `lib/mcp-server.js` | Additive fields `total/truncated/limit/clearance/protectedExcluded`; supported legacy versions 2024-11-05 / 2025-06-18 / 2025-11-25, default 2024-11-05 ([docs/MCP.md](MCP.md)). |
| CLI/MCP contracts + discovery field | `contracts/**`, `scripts/check-contracts.mjs`, `status --json` `contracts` field | Frozen v1 artifacts, additive-only inside 0.x ([docs/CONTRACTS.md](CONTRACTS.md)); the discovery field is wired in the 0.3.0 integration wave and asserted by `check-contracts --status`. |
| TUI/output kernel + shell | `lib/tui/**`, `lib/text-safe.js`, `lib/shell.js` | Pure kernel (width/CJK, sanitization, colour policy, JSON purity, BOM helpers) plus the 0.4.0 readline shell (state machine, in-process history, paste guard, Ctrl+C/Esc abort, plain/canonical modes) — see [docs/TUI.md](TUI.md) §10/§13. |
| Audit tail anchor | `lib/audit-anchor.js`; `audit --write-anchor`, `audit --expect-count N [--expect-head HEX]`; `privacy --prove` + `export --all` report the anchor | Local anchor + CLI verification (not a third-party timestamp). `audit` default prints `anchor: match/absent/grown/FAIL`; tail deletion becomes detectable only when an anchor exists. |
| Backup/restore + doctor repair | `lib/backup.js`; `backup [path] / [--out F] [--tag] [--keep daily=7,...] [--dry-run] / [--apply]`, `backups ls` / `backups verify`, `restore <file> [--dry-run] [--yes] [--allow-anchor-behind] [--allow-broken-audit-chain]`, `doctor --repair [--dry-run] / [--yes] [--only lock,temp,wal,fts]`, `audit --rebuild-fts` | Rotation applies only to managed `$ADVISERS_HOME/backups` and only with `--apply` (otherwise it is a dry-run); `restore` is a plan unless `--yes`; repair defaults to dry-run and takes a safe backup before applying; `db.restore`/`doctor.repair` audit rows + anchor refresh on success; `backup` writes `.sha256`/`.anchor.json` sidecars aligned with the backup head (no audit row). Unknown flags fail with `E_USAGE`; `--dry-run`/`--apply` are mutually exclusive and `--apply` requires `--keep`. |
| Deterministic eval + supply-chain gates | `scripts/eval-det.mjs`, `scripts/check-contracts.mjs`, `scripts/sbom.mjs`, `scripts/check-sbom.mjs`, `scripts/check-provenance.mjs` | CI gates; SBOM is a lockfile-derived gate artifact, not a build graph/vulnerability scan ([docs/SBOM.md](SBOM.md)). |

The 0.4.0 tree adds these surfaces (all additive on the 0.3.x tree):

| Surface | Where | Contract / status |
|---|---|---|
| Knowledge base (schema v22) | `lib/kb.js`, `lib/kb-extract.js`, `lib/kb-pages.js`, `lib/kb-facts.js`; `kb ...`/`search --scope`/`fact ...` commands | Deterministic ingest/search/pages + fact time travel; no model/network/vectors in 0.4.0; MCP/DSH exposure is 0.4.x. See [docs/KB.md](KB.md). `kb link/unlink` are wired since 0.4.1 (the 0.4.0 tarball exposed the library only; export/import parity is). |
| Mail entry (v22) | `lib/mail.js`, `lib/mail-store.js`, `lib/mail-imap.js`, `lib/mail-import.js`, `lib/mail-extract.js`, `lib/credentials.js`; `mail ...` commands | IMAP read-only sync (TLS only), local-rule extraction by default, model only with explicit `--model` + consent; `.eml`/`.mbox` import fallback; body retention 30 days. Credentials outside the DB (0600 best effort). `mail link`/`dismiss` are wired since 0.4.1 and `mail account test`/`mail sync --watch` since 0.4.2; OAuth is not provided. |
| Receivables/payments (v22) | `lib/receivables.js`; `receivable ...`/`payment ...` commands | Commitment sidecar, integer minor units, 4 currencies, derived state, audited writes; amounts never enter reminders/MCP/DSH/receipts/packs; exported/imported with the rest of `DATA_TABLES`. See [docs/CLIENTS.md](CLIENTS.md) §11. |
| Client status pack v2 | `lib/client-pack.js`; `client export --pack`, `evidence verify` dispatch | Directory pack + manifest + SHA256SUMS + independent offline verifier; `evidence verify` dispatches on `manifest.format`; no receivable amounts in 0.4.0. See [docs/CLIENTS.md](CLIENTS.md) §9.2. |
| Proactive v1 | `lib/urgency.js`, `lib/brief-archive.js`, `lib/scheduler.js`, `lib/notify.js`; `morning --top/--archive`, `remind --now`, `remind install --morning`, scheduler status v2 | Deterministic urgency v1 (`terms`/`whyNow`, model version 1), morning archive under `~/.advisers/briefs/` (14-day default), second cron/Task Scheduler block, Standard Webhooks HMAC headers. Quiet-hours **runtime** suppression and notify dedupe/`--force-notify` are wired since 0.4.1. See [docs/REMINDERS.md](REMINDERS.md). |
| Policy/Evidence 0.4 subset | `lib/policy/**`, `lib/consent.js`, `lib/evidence.js` (resolver + pack v2), `lib/source.js` (kb/mail/web/tool types); `consent status|grant|revoke`, `privacy --matrix` | Pure `evaluate()` + rules + one-shot decision token + egress registry + `consent.json` for the new surfaces; `privacy --matrix` is generated from the registry; four-state evidence resolver; evidence pack v2 (verifier accepts v1/v2). Exit 4/5/6, errors/exit v2, unified legacy-path migration are 0.5. |
| MCP dual-era | `lib/mcp-server.js`, `lib/mcp-era.js` (era helpers), `contracts/mcp/versions-v2.json`, `responses-v2.schema.json`, `vectors/mcp/modern.vectors.json` | Legacy bytes unchanged; modern `2026-07-28` stateless path in the same process; `ADVISERS_MCP_MODERN=off` rollback. KB/mail not exposed. See [docs/MCP.md](MCP.md). |
| Windows support matrix | `.github/workflows/ci.yml`, `docs/WINDOWS.md`, `scripts/` | Win11 25H2/26H2 x64, npm channel only; CI non-TTY smoke; interactive TTY/IME remains manual. |

The 0.4.2 tree adds these follow-ups (all additive; no schema or frozen-contract change):

- `lib/fact-entry.js` + `advisers fact add ...` — manual facts with a required evidence
  quote, idempotent dedupe, optional `--doc`/`--relation` KB link, and one `fact.add`
  audit row in the same transaction (any failure rolls the whole entry back).
- `lib/mail-probe.js` + `advisers mail account test ...` — read-only IMAP probe
  (TLS/STARTTLS + LOGIN + CAPABILITY + EXAMINE, 30s bound, no body fetch, no mail rows).
- `lib/mail-watch.js` + `advisers mail sync --watch` — explicit foreground polling loop
  (ledger opened/closed per round, 5s-5min backoff, abort after the in-flight round);
  not a daemon and not IDLE.
- `lib/sync.js` `pullSnapshot({ dryRun })` + `advisers sync pull --dry-run` — predicts
  bootstrap/forced/plain/unchanged without swapping the database, writing a backup/temp
  file or an audit row.
- `doctor --check-db` appends the newest managed backup age (hint only; readability still
  decides PASS/FAIL), and subcommand `--help` prints its own usage before TOS acceptance.
- `eval/mail-local-gold/` + `pnpm eval:mail-local` — 30 synthetic fixtures, threshold-gated
  precision/recall/F1/due/author, wired into the Linux CI job; a local-rule regression
  gate, not an independent human gold set.

## 14. 0.4.0 module map and default posture

| Module | Responsibility | Model/network by default |
|---|---|---|
| `lib/shell.js` | interactive readline shell (state machine, paste guard, canonical/plain, exit codes) | none |
| `lib/kb.js`, `lib/kb-extract.js`, `lib/kb-pages.js`, `lib/kb-facts.js` | KB ingest/search/pages/fact time travel | none (no model, no network) |
| `lib/mail.js`, `lib/mail-store.js`, `lib/mail-imap.js`, `lib/mail-import.js`, `lib/mail-extract.js`, `lib/mail-parse.js`, `lib/mail-errors.js`, `lib/credentials.js` | mail accounts/sync/import/extract/retention/credentials | `mail sync` = user-initiated TLS network; extraction = local rules; model only explicit + consent |
| `lib/receivables.js` | receivables/payments sidecar + aggregation | none |
| `lib/client-pack.js` | client status pack build/write/verify (library) | none |
| `lib/urgency.js`, `lib/brief-archive.js` | urgency v1, morning archive | none |
| `lib/scheduler.js`, `lib/notify.js` | scheduler plans/status, local notifications, opt-in signed webhook | webhook only when configured (outbound, counts-only) |
| `lib/policy/**`, `lib/consent.js` | policy engine/registry/matrix, consent file | none |
| `lib/evidence.js`, `lib/source.js` | evidence resolver four states, pack v2, source v2 types | none |
| `lib/mcp-server.js`, `lib/mcp-era.js` | MCP legacy + modern envelope layer | none (stdio, local) |
| `lib/fact-entry.js` | manual fact entry (`fact add`) with required quote + `fact.add` audit | none |
| `lib/mail-probe.js` | read-only IMAP account probe (`mail account test`) | TLS network only when the operator runs the command |
| `lib/mail-watch.js` | foreground polling loop for `mail sync --watch` (backoff/abort) | same as `mail sync`: user-initiated TLS, foreground only |

**Default posture (repeated because it is a release claim):** zero model, zero
network unless the operator configures and invokes an egress path; every model
or network path is documented in [PRIVACY.md](PRIVACY.md) and registered in the
policy egress registry when it is part of the 0.4 subset. TOS acceptance and
model-egress consent are separate records. The KB, shell, urgency/morning,
receivables and MCP/DSH reads are local-only; `mail sync`/`mail import` are the
only new mail entry points and are user-initiated.
