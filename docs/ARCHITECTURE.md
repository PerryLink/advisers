# Advisers architecture

> Status: **0.3.1 published 2026-11-20** (npm `latest` = `0.3.1`; `next` is also
> `0.3.1`). The repository package version is `0.3.1`. 0.3.1 is a **release-metadata
> patch with no runtime, CLI or contract changes** over 0.3.0: it fixes the published
> release surface (tarball README, tag tree, tag-ref provenance, Release assets, `next`
> tag) and supersedes 0.3.0. The earlier `0.2.4` was an **unpublished** release
> candidate that the 0.3.0 line supersedes. 0.3.0 is the "trustworthy delivery" line: it
> adds the read-only ledger facade, read-model projections, MCP output
> caps/legacy protocol negotiation, interface contracts, the TUI output kernel and the
> audit-anchor/backup surface on top of the 0.2.x runtime. Anything marked *target* below
> is not shipped.
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
recorded here with an honest status on the 0.3.0 tree; "target" means the
design is accepted but the code does **not** enforce it yet, and no release note may claim
it.

| # | Invariant | Status on the 0.3.0 tree |
|---|---|---|
| 1 | **One real ledger**: `~/.advisers/state.db` is authoritative; exports/receipts/projections are derivatives. | In place. JSON store is a degraded fallback, not a second truth. |
| 2 | **Reads take no write lock; writes do not depend on the HOME lock** (0.3.2: the HOME lock becomes a maintenance lock). | Read side in place (lock-free read-only connection; `lib/ledger-read.js` never takes the HOME lock). Write commands still take the HOME instance lock in 0.3.0; downgrade is a 0.3.2 target. |
| 3 | **DSH zero-write**: the host adapter opens no write connection, writes no ledger audit, runs no migration, creates no HOME. | In place: the three read tools use the facade (`readOnly: true`, no DDL/migration, no HOME creation); per-tool audit goes to the host's audit sink, never to the ledger. |
| 4 | **Decisions are pure functions**: `evaluate(facts)` deterministic, fail-closed; adapters only provide facts. | Partial/target: 0.3.0 ships the error-code registry and table-driven per-item clearance filters, but no unified policy engine. **Do not claim a unified/inescapable policy.** |
| 5 | **One side effect = one decision = one audit row** for ledger writes; fs/network two-phase intent/result is 0.3.2. | In place for ledger writes (incremental write + one audit row per command, 0.2.3). Filesystem/network atomicity is **not** claimed. |
| 6 | **Evidence is resolvable**: every source is resolved / missing / unverifiable / not_checked; missing evidence is honest, never forged. | Partial: forged/mismatched quotes become `missing(quote_mismatch)` (0.2.5). The full four-state resolver + `not_checked` coverage model is not in 0.3.0. |
| 7 | **Read models never silently drop data**: list results carry `total`/`truncated`. | Partial: MCP list tools and DSH read payloads carry explicit caps + totals; CLI read models have per-command caps but not one universal envelope. |
| 8 | **Contracts are additive**: CLI JSON / MCP / DSH only add optional fields inside 0.x. | In place for the shipped surfaces: `contracts/` v1 is frozen from `35a51c3`; MCP adds tools/resources/caps without renames; the DSH read payload keeps the 0.2.x field names and adds fields. |
| 9 | **One migration per version, one registry**: no silent `SCHEMA_VERSION + 1`. | In place: 0.3.0 adds exactly one migration, **v21 (additive customer entities: clients/projects/client_notes, matters ownership, commitments.created_at, delivery lineage)**. No `due_ms`/`rev` migration is part of 0.3.0. |
| 10 | **Failures are honest**: preview is marked, missing data is a structured `E_*`/`LEDGER_*` error, never empty data pretending "none". | In place for MCP, DSH, the ledger facade and the CLI read paths. |

## 3. Core services (target)

| Service | Responsibility |
|---|---|
| `ctx.advisers.matter` | matter lifecycle, routing, merge/split |
| `ctx.advisers.user` | preference ledger, scope, confidence, forgetting |
| `ctx.advisers.commitments` | open/done/snoozed/dropped, evidence, nudges |
| `ctx.advisers.routines` | routine proposals, diffs, versions, rollback |
| `ctx.advisers.recall` | FTS5 first (trigram + seq indexes introduced in v19/v20, current schema v21; §11), vector optional, 1–2 hop graph expansion |
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
| 0.4 | Interactive TUI shell (0.3.2 first) + Feishu/cross-matter proposals + policy engine/Evidence 2.0 + full DSH write (0.5+) |
| 1.0 | SPI frozen + 20 users × 30 days metrics + two external links |

The earlier plan put routines at 1.0; that makes the product a commitment
tracker for a year. Routines must appear by 0.2 to keep the "intern" promise.

## 9. Current limits (0.3.1, published 2026-11-20; runtime unchanged from 0.3.0, additive over 0.2.4)

- Ledger is persisted in SQLite (`advisers/lib/sqlite.js`); JSON mode is a fallback but loses turns/search/audit. Physical schema is **v21** on the 0.3.1 tree: v21 is the additive customer-entity step (`clients`/`projects`/`client_notes`, nullable `matters.client_id`/`project_id`, `commitments.created_at` and delivery lineage columns). No `due_ms`/`rev` migration is part of 0.3.0, so date windows still run in JS.
- CLI calls the model only when `ADVISERS_API_KEY` is set; without a key it records/search/builds but does not create promises or artifacts from natural language.
- `dsh-advisers` implements five tools (`advisers_brief`, `advisers_office`, `advisers_today`, `advisers_who`, `advisers_evidence`); it is a thin adapter, not a second product. In 0.3.0 the three ledger read tools read the **real local ledger** through the controlled `advisers/lib/ledger-read.js` facade (`docs/LEDGER-READ-API.md`): read-only, no HOME write lock, no migration, no HOME creation, no writes, TOS-gated and at clearance 0. A missing ledger, an unavailable facade (old `advisers` package / no `node:sqlite`) or `config.mode: "preview"` falls back to the marked preview (`preview: true`, `source: "preview-no-ledger"`, `note`, `[preview: no ledger]` prefix); every other gate failure (TOS/vault/schema/corruption/busy) is a structured `LEDGER_*` error, never empty data. The 0.2.0 npm packaging defect was fixed in 0.2.1 (explicit export + dependency). See CHANGELOG and `packages/dsh-advisers/README.md`.
- `secrecy` is stored; hard retrieval gating is partial. Audience scoping is enforced for preferences.
- Permit/GatedLink exist but are **not yet a mandatory boundary on every send path**.
- Deletion cascade covers sessions/turns/summaries/runs/nudges/deliveries + facts/title and candidate payloads; commitment/link/update/audit content redaction is partial.
- Office verification is structural (OPC/XML/rels/content types). Open validation is manual: WPS Writer, Spreadsheet and Presentation opened and extracted the generated files (2026-11-14). Microsoft Office is not installed on the test host and Office application-layer validation is still pending.
- No real IM account and no 5-user dogfood validation yet.
- **Audit tail anchoring (0.3.0)**: the local hash chain detects edits to its own rows; 0.3.0 adds `lib/audit-anchor.js` and the `audit --write-anchor`/`audit --expect-head`/`audit --expect-count` CLI surface, so deleting the tail becomes detectable **when an anchor exists**. This is a local anchor file (0600), not a third-party timestamp/TSA; see `docs/SECURITY.md` (`audit`/`privacy --prove`/`export` report the anchor state) and the CLI help.
- **Recovery (0.3.0)**: `backup` keeps managed, checksummed backups in `$ADVISERS_HOME/backups` with `--keep` rotation (only managed backups are rotated), `backups ls|verify` inspects/verifies them, `restore <file>` is a plan unless `--yes` and refuses an anchor-behind backup unless explicitly allowed, `doctor --repair` defaults to dry-run with `--only lock,temp,wal,fts`, and `audit --rebuild-fts` rebuilds the FTS indexes. `restore`/`doctor --repair` success paths write `db.restore`/`doctor.repair` audit rows and refresh the anchor; `backup` instead writes `.sha256`/`.anchor.json` sidecars aligned with the new backup's head (no audit row), so an immediate restore is anchor-match and only older backups need `--allow-anchor-behind`. Failures report whether the original database stayed intact. See `docs/SECURITY.md` and the CLI help.
- **TUI / console-safe wiring is done in 0.3.0**: the output kernel (`lib/tui/**`, `lib/text-safe.js`) is wired into `bin/advisers.js` — one `resolveOutputPolicy` per process for the global `--plain`/`--accessible`/`--color` flags, `tui`/`tui --once`/`tui --json` rendered through the kernel, REPL reply wrapping + status/failure blocks through the renderers, and `lib/notify.js`/`lib/imap.js` routing remote text through `sanitizeConsoleText`. On a pipe `advisers tui </dev/null` now prints one plain snapshot without a clear-screen ESC; the `tty`/`tui` eval groups and `test/bin-tui-*` / `test/console-safe-wiring` cover it. Remaining: the 0.3.2 interactive shell and routing BOM-prone file reads through `lib/tui/text-file.js`. See [docs/TUI.md](TUI.md).
- **Performance (0.3.0)**: the T1 write-amplification fix removed the ordered status-predicate TEMP B-TREE spill (`pet-brief` now writes ~32 KB/run instead of 31.8 MB; `today` 32 KB instead of 5.8 MB at 200k rows) and the read-model projections moved `remind`/`tui`/`digest` inside target; `today` (151–158 ms median, target ≤150) and `pet-brief` (399/588 ms, target ≤400) are at the boundary, and `today --json` remains output-bound. Full A/B, method and caveats: [docs/PERFORMANCE.md](PERFORMANCE.md). Do not advertise the 0.3.0 performance table as fully met.
- **MCP (0.3.0)**: 7 tools + 4 read-only resources; list results are capped after clearance and before the classifier and carry `total/truncated` (see [docs/MCP.md](MCP.md)). Legacy protocol negotiation covers 2024-11-05 / 2025-06-18 / 2025-11-25 with a 2024-11-05 default; the modern stateless 2026-07-28 revision is **not implemented** and is not advertised.
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

## 11. Full-text search (schema v20; trigram since 0.2.2)

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

## 12. Persistence v2 (0.2.3, schema v20)

0.2.3 changes how the SQLite ledger is migrated, read and written. The physical
schema version is `meta.schema_version = 20`; the wire snapshot format is
unchanged (`LedgerSnapshot.version` stays 1), so JSON-mode stores and old
exports keep working.

### 12.1 Migration ledger

Schema v20 adds the `schema_migrations` table
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
| Narrow read-model projections | `lib/sqlite.js` (`project*` methods) + `bin` read paths | The projections add no migration (the tree is schema v21 from the customer-entity step); view builders consume projected rows; `test/read-model-projections.test.js` pins row/column/order equivalence. |
| Customer entities (additive schema v21) | `lib/sqlite.js` (migration v20→v21), `packages/core/src/customer.ts`, `bin` `client`/`project` commands ([docs/CLIENTS.md](CLIENTS.md)) | 0.3.0 ships the minimal customer loop: clients/projects/client_notes tables, matter ownership, `commitments.created_at`, delivery lineage, `client add/list/show/timeline/archive/merge`, `project add/list/show/archive`, `matter add --client/--project`, the derived timeline and the opt-in `--clearance` gate. Receipt `--client` filtering, customer status packages and MCP/DSH customer tools remain out of 0.3.0. **Export/import parity**: `export --all` carries the new tables through the single store-owned `DATA_TABLES` list, and `import --replace` restores the ledger + customer tables in one transaction (dangling references abort atomically; the local audit chain is never replaced by an import). The JSON wire format (`LedgerSnapshot.version`) stays 1. |
| MCP output caps + legacy negotiation | `lib/mcp-server.js` | Additive fields `total/truncated/limit/clearance/protectedExcluded`; supported legacy versions 2024-11-05 / 2025-06-18 / 2025-11-25, default 2024-11-05 ([docs/MCP.md](MCP.md)). |
| CLI/MCP contracts + discovery field | `contracts/**`, `scripts/check-contracts.mjs`, `status --json` `contracts` field | Frozen v1 artifacts, additive-only inside 0.x ([docs/CONTRACTS.md](CONTRACTS.md)); the discovery field is wired in the 0.3.0 integration wave and asserted by `check-contracts --status`. |
| TUI/output kernel | `lib/tui/**`, `lib/text-safe.js` | Pure library (width/CJK, sanitization, colour policy, JSON purity, BOM helpers); **the interactive shell is 0.3.2** — see [docs/TUI.md](TUI.md) for the kernel/shell boundary. |
| Audit tail anchor | `lib/audit-anchor.js`; `audit --write-anchor`, `audit --expect-count N [--expect-head HEX]`; `privacy --prove` + `export --all` report the anchor | Local anchor + CLI verification (not a third-party timestamp). `audit` default prints `anchor: match/absent/grown/FAIL`; tail deletion becomes detectable only when an anchor exists. |
| Backup/restore + doctor repair | `lib/backup.js`; `backup [path] / [--out F] [--tag] [--keep daily=7,...] [--dry-run] / [--apply]`, `backups ls` / `backups verify`, `restore <file> [--dry-run] [--yes] [--allow-anchor-behind] [--allow-broken-audit-chain]`, `doctor --repair [--dry-run] / [--yes] [--only lock,temp,wal,fts]`, `audit --rebuild-fts` | Rotation applies only to managed `$ADVISERS_HOME/backups` and only with `--apply` (otherwise it is a dry-run); `restore` is a plan unless `--yes`; repair defaults to dry-run and takes a safe backup before applying; `db.restore`/`doctor.repair` audit rows + anchor refresh on success; `backup` writes `.sha256`/`.anchor.json` sidecars aligned with the backup head (no audit row). Unknown flags fail with `E_USAGE`; `--dry-run`/`--apply` are mutually exclusive and `--apply` requires `--keep`. |
| Deterministic eval + supply-chain gates | `scripts/eval-det.mjs`, `scripts/check-contracts.mjs`, `scripts/sbom.mjs`, `scripts/check-sbom.mjs`, `scripts/check-provenance.mjs` | CI gates; SBOM is a lockfile-derived gate artifact, not a build graph/vulnerability scan ([docs/SBOM.md](SBOM.md)). |
