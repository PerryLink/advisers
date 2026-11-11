# Advisers architecture

> Status: bootstrapping. This document fixes the vocabulary and the invariants;
> the implementation is allowed to be smaller than the document.

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
  background (nightly reconcile → diff → next-day confirmation).
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
| `ctx.advisers.recall` | FTS5 first, vector optional, 1–2 hop graph expansion |
| `ctx.advisers.curator` | nightly reconcile, dedupe, expiry, brief draft |
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
| **Routine** | Proposed from a successful task; needs a diff, regression case, and human approval; never auto-activated. | Type exists in the roadmap; not implemented |
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

## 9. Current limits (0.0.x)

- The ledger is in-memory; SQLite is 0.1.
- `advisers` has a CLI that prints the focus frame; it does not call a model.
- `dsh-advisers` is a placeholder: no `apply`, no `cordis.patch.yml`, no
  `dsh.bundle`.
- `secrecy` is stored but not yet a hard retrieval gate; audience scoping is
  enforced for preferences only.
- Egress permits, deletion cascade, and the five CI security tests are
  specified in `SECURITY.md` but not implemented.

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
`IntentBrief` half and leaves the full state machine for 0.2.
