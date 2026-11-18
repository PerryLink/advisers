# Advisers architecture

> Status: 0.2.2 release candidate (staged for npm `latest`, pending the account owner OTP; 0.2.1 is what `latest` serves until approval). This document fixes the
> vocabulary and the invariants; the implementation is allowed to be smaller than the
> document.

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
  only. 0.2.2 has **no daemon**; the only scheduled thing is the opt-in
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

## 3. Core services (target)

| Service | Responsibility |
|---|---|
| `ctx.advisers.matter` | matter lifecycle, routing, merge/split |
| `ctx.advisers.user` | preference ledger, scope, confidence, forgetting |
| `ctx.advisers.commitments` | open/done/snoozed/dropped, evidence, nudges |
| `ctx.advisers.routines` | routine proposals, diffs, versions, rollback |
| `ctx.advisers.recall` | FTS5 first (schema v19 trigram; §11), vector optional, 1–2 hop graph expansion |
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
| 0.3 | Association hints (`same_entity`/`depends_on`/`conflicts`) + DSH preview (`next`) |
| 0.4 | DSH full + Feishu + cross-matter proposals |
| 1.0 | SPI frozen + 20 users × 30 days metrics + two external links |

The earlier plan put routines at 1.0; that makes the product a commitment
tracker for a year. Routines must appear by 0.2 to keep the "intern" promise.

## 9. Current limits (0.2.2)

- Ledger is persisted in SQLite (`advisers/lib/sqlite.js`); JSON mode is a fallback but loses turns/search/audit.
- CLI calls the model only when `ADVISERS_API_KEY` is set; without a key it records/search/builds but does not create promises or artifacts from natural language.
- `dsh-advisers` implements five tools (`advisers_brief`, `advisers_office`, `advisers_today`, `advisers_who`, `advisers_evidence`); it is a thin adapter, not a second product. The 0.2.0 npm bundle has a known packaging defect; it is fixed in 0.2.1 (the bundle now resolves `advisers/lib/safety/index.js` through an explicit export and dependency). See CHANGELOG.
- `secrecy` is stored; hard retrieval gating is partial. Audience scoping is enforced for preferences.
- Permit/GatedLink exist but are **not yet a mandatory boundary on every send path**.
- Deletion cascade covers sessions/turns/summaries/runs/nudges/deliveries + facts/title and candidate payloads; commitment/link/update/audit content redaction is partial.
- Office verification is structural (OPC/XML/rels/content types). Open validation is manual: WPS Writer, Spreadsheet and Presentation opened and extracted the generated files (2026-11-14). Microsoft Office is not installed on the test host and Office application-layer validation is still pending.
- No real IM account and no 5-user dogfood validation yet.

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

## 11. Full-text search (0.2.2, schema v19)

The 0.2.2 working tree rebuilds local full-text search on FTS5 indexes instead
of scanning `turns.content`:

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
  from the source tables — all inside the same write transaction that bumps
  `schema_version`. A `state.db.before-migrate-v18-*` copy is written first by
  the existing backup-before-migrate mechanism; a failed migration rolls the
  DDL back and leaves the v18 database usable. A database with a schema newer
  than this CLI is still refused.
- **Degradation**: if the SQLite build has no trigram tokenizer, the store
  rebuilds the legacy unicode61 index, sets `ftsWarning` and prints one stderr
  warning; Chinese search then answers through `LIKE`. If FTS5 itself is
  missing, search is LIKE-only. Opening never fails because of a missing
  tokenizer. `ADVISERS_FTS_TOKENIZER=unicode61` forces the legacy tokenizer
  (operator escape hatch; the tests use it to pin the degraded path). A database
  forced to unicode61 keeps it: the schema is already v19, so there is no
  automatic retry.
- **Cost** (synthetic 50,000 turns / 500 summaries, /tmp ext4, 2026-11-18):
  the trigram `turns_fts` is 4.0 MB vs 1.5 MB for unicode61, so the database
  grows 2.8 MB (+28.7% on 9.7 MB, including the new 72 KB `summaries_fts`).
  Migrating that database (including the 9.7 MB backup copy) takes ~0.22 s.
  A 3-character Chinese query that used to run `LIKE` in 12.8 ms now hits FTS
  in ~5.5 ms; rare phrases drop to ~0.1 ms. `ORDER BY rank` still scores every
  matching turn, so a very common term (thousands of matches) is the slow end.
- **Limits**: 2-character CJK queries still take the LIKE scan (there is no
  2-gram index); trigram ranking is substring-frequency, not semantic; the LIKE
  fallback treats `%`/`_` as wildcards; the index is larger than unicode61.
