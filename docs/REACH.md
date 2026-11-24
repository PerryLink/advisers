# Reachability: how Advisers is reached

Status: **docs backfill in 0.5.1.** The 0.5.0 plan listed a reachability page
but it was not in the 0.5.0 tag tree while `advisers help reach` already pointed
at `docs/REACH.md`; 0.5.1 ships this page so the pointer resolves. It describes
the shipped surfaces only — see [ERRATA-0.5.0.md](ERRATA-0.5.0.md).

Advisers is not a cloud service. Everything is reached either by running the
CLI on the machine that owns `~/.advisers`, or by a local, read-mostly adapter
that a host starts on that same machine. There is no hosted API, no bot, no
mobile app and no background daemon.

## 1. Surfaces that exist

| Surface | How it is reached | Reads/writes | Notes |
|---|---|---|---|
| CLI (`advisers`) | terminal / scripts | the write path | one REPL; every local command; TOS-gated |
| MCP server | `advisers mcp --stdio` (or an embedding host) | 7 read-only tools + 1 pending-candidate write + 5 read-only resources | stdio only; clearance 0; `audited:true` only when the audit chain is writable |
| DSH bundle (`dsh-advisers`) | DSH plugin profile | 4 read-only ledger tools + `advisers_brief` (no ledger) + `advisers_office` (writes inside `config.workspace`) | DSH never writes the local audit chain, so read disclosure is `audited:false` |
| Hermes bridge | `advisers bridge --dir <BRIDGE_DIR>` | file gateway (JSON inbox/outbox) | Hermes owns the chat-platform adapters and delivery ledger; Advisers only exchanges files |
| Link packages | libraries loaded by the CLI | draft-only email transport, Feishu message provider | shipped as libraries; not wired into an end-to-end inbox |
| Local files | `~/.advisers`, `--out` paths, bundles/exports | user-owned | the ledger is a local SQLite file; backups/exports/bundles are local directories |

## 2. What "read-only" means on each surface

- **MCP**: `advisers_today`, `advisers_commit_ls`, `advisers_who`,
  `advisers_evidence`, `advisers_remind`, `advisers_clients` and
  `advisers_pack_verify` read; `advisers_capture_candidate` only creates a
  **pending** memory candidate (never accepts, never writes the ledger).
  Lists are capped and clearance-filtered before counting; protected rows are
  counted, never returned.
- **DSH**: the four ledger tools open the database read-only at clearance 0 and
  write nothing; `advisers_office` is the only writer and stays inside the
  configured workspace. There are no hooks and no ledger writes from reads.
- **Bridge**: the file contract is at-least-once with a persisted dedupe id;
  Advisers does not start a network listener for it.
- **CLI**: the only surface that records TOS acceptance, runs migrations and
  writes the audit chain.

## 3. What is deliberately not reachable

This is not a bug — these are product non-goals, not missing buttons:

- no cloud account, hosted service or remote API; no telemetry;
- no built-in daemon or inbox IDLE watch; the only scheduled job is the OS
  reminder task **you** explicitly install with `remind install --apply`;
- no mail send/draft-from-imap, no calendar write-back, no IMAP write;
- no mobile app, companion chat bot or meeting recorder;
- no customer portal, CRM sync, invoicing/paid marketplace or auto-payment;
- no automatic commitment acceptance: every write is a CLI command, and
  agent/host output stays pending until a human accepts it.

## 4. Trust posture

- Reads are local: no read surface needs an API key, sends file contents or
  opens a network connection.
- Model calls are opt-in (`ADVISERS_API_KEY`) and only the CLI commands that
  call a model use them; `research --web` is the only built-in web egress.
- A host receives read models, never credentials; bundles/backups never carry
  `audit.key`, credentials, soul or workspace.
- The reachability matrix, permissions and configuration per host are in
  [AGENT-INTEROP.md](AGENT-INTEROP.md); protocol details are in
  [MCP.md](MCP.md).

## 5. Setup pointers

- [QUICKSTART.md](QUICKSTART.md) — install, first commands, TOS acceptance.
- [MCP.md](MCP.md) — stdio client configuration, tools, resources, caps.
- [AGENT-INTEROP.md](AGENT-INTEROP.md) — Claude Code / Codex / Goose / OpenClaw
  / DSH configuration guidance and the permission table.
- [WINDOWS.md](WINDOWS.md) — Windows support scope.
- [PLUGIN-BOUNDARY.md](PLUGIN-BOUNDARY.md) — the DSH adapter boundary.

## Related

- `advisers help reach` prints the short version of this page.
- [ERRATA-0.5.0.md](ERRATA-0.5.0.md) — why this page did not ship in 0.5.0.
