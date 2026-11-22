# Agent interop — calling Advisers from another agent host

Status: **0.5.0, published 2026-11-22.** Distribution stance (plan 125 §C8):
Advisers is **called by hosts** — it is a local ledger/verification backend, not an
agent, not a connector platform and not a plugin marketplace. This page lists the
supported channels, one config per host, and the read-only boundary every host gets.

Two channels exist:

1. **MCP over stdio** (`advisers mcp --stdio`): the same 8-tool / 5-resource server
   for MCP hosts. Local process, one JSON-RPC request per line, <= 1 MiB per line.
2. **CLI** (`advisers ... --json`): the full product. Any host that can run a shell
   command can use every read model; a host does not need MCP.

There is one more first-party adapter: the **DSH bundle** (`dsh-advisers`), which is
not an MCP server — it registers six tools inside the DSH host and reads the real
ledger through the read-only facade.

## 0. The boundary every host gets

- **Read-mostly.** Seven of the eight MCP tools are read-only. The only write-ish
  call creates a **pending** memory candidate; it never accepts it and never writes
  the ledger. `advisers_pack_verify` only reads a directory.
- **No business actions are exposed.** No send mail/IM, no calendar write, no
  rescheduling, no payment, no e-sign, no CRM write, no OAuth, no file-system
  export/import over MCP.
- **Clearance 0 (fail closed).** Protected rows are filtered per item before
  counting/paging and only counted in `protectedExcluded`; no id/title/quote leaks.
- **Not exposed:** KB text, mail bodies/subjects/attachments, money amounts,
  context packs, bundles, raw export. Those stay in the CLI/ledger.
- **No network / no model.** The MCP process makes no outbound connection and never
  calls a model; `research`/`mail sync`/model paths are separate explicit CLI commands.
- **TOS-gated.** The server reads a ledger only after consent; there is no MCP path
  that accepts or resets the terms.
- **Audit is explicit.** MCP read calls write one `mcp.call` row when an audit sink
  is wired (`disclosure.audited:true`); if the host wires no sink the payload says
  `audited:false` plus one fixed warning. The DSH adapter never writes the local
  audit chain, so DSH disclosures are **always `audited:false`**.
- **Additive disclosure.** Successful reads carry an additive
  `disclosure{surface,tool,basis,callId,fields,view,clearance,protectedExcluded,
  truncated,audited,digest}` and per-row `view`
  (`verified|pending|historical|derived`). The legacy 8-tool/5-resource and DSH
  6-tool payloads are otherwise unchanged: stripping the new fields reproduces the
  0.4.3 bytes.

`view` is a local label, not truth: `verified` means a local evidence pointer
resolved at read time; `pending` means no local pointer resolved; `historical`
means the row is closed/superseded/expired; `derived` is a projection (clients).

## 1. Host matrix

| Host | Channel | Local stdio? | 0.5.0 status |
|---|---|---|---|
| Claude Code | MCP stdio; modern 2026-07-28 or legacy auto-negotiated | yes | config documented and exercised by the CLI tests |
| Claude Cowork (Claude desktop) | plugin / local connector inside Claude | connector must run on the user's machine | **not shipped**: no Claude plugin bundle in 0.5.0; use Claude Code or the CLI on the same machine |
| OpenAI Codex | MCP stdio (Codex CLI/desktop MCP config) | yes | config guidance only; **not verified in 0.5.0** |
| Cursor | MCP stdio (`.cursor/mcp.json`) | yes | config documented; Cursor uses legacy negotiation (falls back from modern) |
| Goose | MCP stdio extension (`config.yaml` `extensions`) | yes | config guidance only; **not verified in 0.5.0** |
| OpenClaw | MCP client (`mcp.servers`, stdio) | yes | config guidance only; **not verified in 0.5.0**, no ClawHub skill shipped |
| DSH (DeepSeek Harness) | first-party bundle `dsh-advisers` (six tools, not MCP) | n/a | ships with the 0.5.0 packages; `audited:false` |

Not supported (do not claim): ChatGPT/Claude.ai **cloud** MCP directories require a
remote URL/service; Advisers is local stdio and makes no service. Copilot Studio,
Dify, n8n and similar can only be reached through their own local bridge; none of
those bridges ship here. No plugin marketplaces, cloud relay, OAuth connector or
paid MCP listing.

The Claude Code and Cursor snippets are the ones also documented in
[MCP.md](MCP.md) and covered by the repo's stdio tests. Codex/Goose/OpenClaw
entries describe the same stdio server; their config file/UI names change between
host versions — re-check the host docs on install (facts re-checked 2026-11-22).

## 2. Claude Code

```sh
claude mcp add advisers -- advisers mcp --stdio
```

Project-level `.mcp.json` (same bytes as any stdio client):

```json
{
  "mcpServers": {
    "advisers": { "command": "advisers", "args": ["mcp", "--stdio"] }
  }
}
```

Claude Code negotiates modern MCP (`server/discover`); if it probes before you
upgrade, reconnect or set `MCP_PROTOCOL_NEGOTIATION=auto` (Claude Code caches a
failed probe for up to 7 days). `ADVISERS_MCP_MODERN=off` reverts the server to
legacy only. Windows: if `advisers` is not on `PATH`, use
`node C:\path\to\advisers\packages\advisers\bin\advisers.js mcp --stdio`.

## 3. Claude Cowork (planned, not shipped)

Cowork runs the assistant in a cloud environment and supports plugins whose
connectors run on the user's machine ("runs in each session"). A local stdio MCP
connector is therefore the only compatible shape. **0.5.0 does not ship a Claude
plugin bundle**, so do not advertise Cowork support: run Claude Code or the CLI on
the machine that holds the ledger. A future plugin package would wrap the same
`advisers mcp --stdio` command plus a skill; it would not add new tools or
privileges.

## 4. OpenAI Codex

Codex CLI/desktop has an MCP section (`mcp_servers`) in its config. Register the
same stdio command; the exact file path and field names follow the Codex version
in use:

```toml
[mcp_servers.advisers]
command = "advisers"
args = ["mcp", "--stdio"]
```

0.5.0 has **not** been exercised on a real Codex install; the command is the same
verified stdio server. `codex mcp add` (where available) is equivalent to the
snippet.

## 5. Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "advisers": { "command": "advisers", "args": ["mcp", "--stdio"] }
  }
}
```

Cursor still uses legacy negotiation; the server answers `initialize` exactly like
0.3.2 and the modern path stays unused. No Cursor plugin is shipped.

## 6. Goose

Goose reads stdio extensions from its `config.yaml` (`~/.config/goose/config.yaml`
on Linux/macOS; see the host docs on Windows):

```yaml
extensions:
  advisers:
    name: advisers
    type: stdio
    cmd: advisers
    args: ["mcp", "--stdio"]
    enabled: true
    timeout: 300
```

0.5.0 has **not** been exercised on a real Goose install. Goose is also a natural
host for the CLI channel if its MCP config changes.

## 7. OpenClaw

OpenClaw is an MCP client: register the same stdio server in its `mcp.servers`
config and point command/args at `advisers mcp --stdio`. Advisers is the
ledger/evidence backend, not a channel: OpenClaw keeps its own agent loop and
channels. 0.5.0 ships no ClawHub skill and has **not** been exercised on a real
OpenClaw install; do not claim a verified integration.

## 8. DSH (DeepSeek Harness)

`packages/dsh-advisers` is a first-party bundle, not an MCP server. Enable it in
the DSH profile; it registers:

| Tool | Kind |
|---|---|
| `advisers_brief` | in-memory intent brief, no ledger |
| `advisers_office` | writes DOCX/XLSX/PPTX/XMind/Mermaid/draw.io inside `config.workspace` |
| `advisers_today` | read-only real ledger |
| `advisers_who` | read-only real ledger |
| `advisers_evidence` | read-only real ledger |
| `advisers_clients` | read-only real ledger |

Configuration (`apply(ctx, config)`): `home` (absolute path; default
`ADVISERS_HOME` or `~/.advisers`), `mode` (`auto|preview`; `preview` is the exact
0.2.x kill switch), `workspace` (confines `advisers_office` writes). Reads are
TOS-gated, at clearance 0, over a read-only connection (no HOME write lock, no
migration, no HOME creation, no ledger writes). If no ledger/facade is available
the adapter returns the marked `preview` with `source:"preview-no-ledger"` instead
of fake data; gate failures are structured errors, never empty data. DSH
disclosures are `surface:"dsh"` and `audited:false`.

## 9. Tool catalogue (MCP, unchanged from 0.4.3)

| Tool | Read/write | Note |
|---|---|---|
| `advisers_today` | read | open-commitment counts + capped list |
| `advisers_commit_ls` | read | commitments; `{all:true}` includes done/dropped |
| `advisers_who` | read | `mine` vs `waiting` |
| `advisers_evidence` | read | evidence traceback for `cm_*`/`fact_*`/`pref_*` |
| `advisers_remind` | read | current due reminders; no delivery, no network |
| `advisers_clients` | read | client projection (`list`/`show`); no note bodies |
| `advisers_capture_candidate` | whitelisted write | creates a **pending** candidate only |
| `advisers_pack_verify` | read-only verify | evidence-pack/receipt directory checks (not context packs) |

Resources: `advisers://today`, `advisers://commitments`, `advisers://who`,
`advisers://evidence`, `advisers://clients`. Always 8 tools / 5 resources; DSH
always 6 tools. A host must not be told the catalogue changed in 0.5.0 — the
additive `view`/`disclosure` fields are not new tools.

## 10. CLI channel (smallest integration)

Any host that can run a local command gets the same read models as JSON, and the
commands a host must never auto-run are exactly the destructive/egress ones:

```sh
advisers status --json
advisers today --json
advisers who --json
advisers evidence show cm_123 --json
advisers deliveries --receipt --client cl_123 --json
advisers evidence verify <dir> --json       # offline, exit 0/1
advisers context-pack verify <dir> --json   # offline, exit 0/1 (read-only)
```

Do not wire a host to `import --replace`, `purge`, `restore`, `mail sync`,
`research --web`, `context-pack create`, or model commands. Those are operator
decisions with their own consent/backup surfaces.

## 11. Compatibility and verification

- MCP legacy names/parameters/payloads are frozen; 0.5.0 only adds fields. Strip
  `disclosure` and row `view` and the 0.4.3 bytes are reproduced (tests assert it).
- `ADVISERS_MCP_MODERN=off` returns the server to legacy-only in one restart.
- Repo verification: `test/mcp-server.test.js`, `test/mcp-clients.test.js`,
  `test/cli-mcp-json.test.js`, `test/mcp-modern*.test.js` for the MCP surface;
  `packages/dsh-advisers/test/` for the DSH adapter; `scripts/mcp-dev.mjs` for a
  two-process stdio smoke. No real third-party host integration test ships in
  0.5.0; host-specific claims above are configuration guidance, not CI evidence.

## Related

- [MCP.md](MCP.md) — protocol, tools, resources, error codes, audit rules.
- [LEDGER-READ-API.md](LEDGER-READ-API.md) — the DSH read-only facade.
- [POSITIONING.md](POSITIONING.md) — why distribution is "called by hosts".
- [CONTEXT-PACK.md](CONTEXT-PACK.md) — the hand-off artifact for a human/agent recipient.
