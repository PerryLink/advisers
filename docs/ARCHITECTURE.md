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

The same `packages/core` source is built twice (build-time alias for
`cordis` → `@deepseek-ai/cordis` in the DSH build). The core must not use
fork-specific APIs such as `FiberState` runtime exports.

## 6. What is deliberately not here

- Multi-user/team sync, a plugin marketplace, voice, and autonomous outbound
  sending are out of scope until the three-ledger loop is proven.
- A vector database is not required at the start: FTS5 plus scope/entity
  filters is enough for the first few hundred facts.
