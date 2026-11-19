# Advisers

**A staff of AI advisers — a local-first, auditable personal secretary runtime.**

> **AI & compliance notice** — Advisers is a local-first work assistant, not a companion,
> lawyer, doctor, or financial adviser. AI output can be wrong; verify before use.
> Illegal, infringing, fraudulent, harassing, or forged use is prohibited; distribute
> AI-generated content only with the required labels. Minors need guardian consent.
> Read the [Terms of Service](docs/TOS.md) (v2026.11.3), [Disclaimer](docs/DISCLAIMER.md),
> [Safety & content review](docs/SAFETY.md) and [Privacy & data-flow notice](docs/PRIVACY.md)
> before use; licence split: [LICENSING.md](LICENSING.md).

> **Noncommercial source-available** — Advisers is **not open source**. The software is
> PolyForm Noncommercial License 1.0.0 (noncommercial use only; no anticipated commercial
> application) and docs/data/design are CC BY-NC-SA 4.0. Commercial use — including paid
> client work — requires a separate written commercial licence (open an issue at
> <https://github.com/PerryLink/advisers/issues>, label `commercial-license`). The local
> database is **not encrypted by default**; see the [Privacy notice](docs/PRIVACY.md) for the
> full egress list (DeepSeek is the default model provider) and deletion limits.

Advisers is not another chat window. It is a small staff of specialist advisers
(memory, commitments, routines) that share one continuous conversation and keep
three ledgers:

- **user ledger** — who you are, preferences, boundaries, evidence;
- **commitment ledger** — who owes whom, due dates, external proof;
- **routine ledger** — how this kind of work is done here; routine changes can be reviewed as diffs before approval.

The core is standalone (no cordis dependency). The DSH bundle is a thin,
cordis-compatible host adapter (five tools: `advisers_brief`, `advisers_office`,
`advisers_today`, `advisers_who`, `advisers_evidence`), not a feature-complete second product:

| Package | Role |
|---|---|
| `advisers` | primary runtime + CLI (no DSH dependency) |
| `dsh-advisers` | thin DSH adapter (brief/office + read-only today/who/evidence) |

IM is a **Link SPI**, not a hard dependency. The repository currently ships
`link-email` (draft-only email provider/transport) and `link-feishu` (Feishu
message provider/source), plus `bridge-hermes`; the CLI does not wire them into
an end-to-end inbox yet. Other gateways are not bundled. The core does not depend
on any link package; adapters load one only when configured.

## Status

**`0.3.0` is a release candidate (2026-11-20) and is NOT published.** The repository
is lockstep at package version `0.3.0`. The earlier `0.2.4` was an **unpublished release
candidate** superseded by `0.3.0` (its `v0.2.4` tag points at an older commit and there is
no 0.2.4 tarball on npm; do not try to install it). npm **`latest` = `next` = `0.2.3`**
(published 2026-11-18), and `0.2.2`/`0.2.1`/`0.2.0` remain installable by pinning. The six published packages are
`advisers`, `advisers-core`, `advisers-office`, `advisers-policy-strict`,
`advisers-bridge-hermes` and `dsh-advisers`; the two private `advisers-link-*` packages
are held at the same version but are not published.

0.3.0 is the **"trustworthy delivery"** line: evidence that resolves or is honestly
marked missing/unverifiable, data that can be recovered (backup/restore/anchor), a ledger
that stays usable at 200k rows, and a release whose provenance can be verified. It also
carries the 0.2.4 tree (Windows durable-fsync and per-item secrecy/evidence clearance
fixes) as its base. Release-candidate additions are documented per topic and are **not**
published claims: [MCP output caps + protocol negotiation](docs/MCP.md),
[200k read A/B and the write-amplification fix](docs/PERFORMANCE.md),
[read-only ledger facade](docs/LEDGER-READ-API.md),
[interface contracts](docs/CONTRACTS.md), [TUI output kernel](docs/TUI.md).
The 0.2.3 release passed 743/743 tests, build/typecheck, packaging smoke,
docs/licence/TOS/release-lockstep checks, the security suite and the fault-injection suite
(9/9); its published tarballs were verified with `scripts/verify-release.mjs`
(86/86 checks). The 0.3.0 release candidate must repeat those gates plus the new CI gates
(`check-contracts`, `eval:det`, `sbom`+`check:sbom`) and the release-time
`check-provenance` / `verify-release --require-sbom` checks — none of which is a published
fact until the registry shows the six 0.3.0 packages with non-empty `dist.attestations`.

> Requires **Node >= 22.16**. See [docs/QUICKSTART.md](docs/QUICKSTART.md) for Windows/PowerShell and BOM notes.

- `advisers` CLI: local REPL, `chat`, `office`, `template`, `routine`, `link`, `bridge`, `soul`, `ls`, `why`, `forget`, `export`;
- SQLite at `~/.advisers/state.db` (JSON fallback with `ADVISERS_STORE=json`);
- `IntentBrief` + clarification policy + readback;
- `advisers-office`: DOCX/XLSX/PPTX/Mermaid/draw.io/XMind + 7 templates; read/edit/verify;
- routine v0 (draft/approve/archive + patch/diff/apply);
- local agent loop with tools (`office_build`, `office_template`, `file_read/write/list`, `commitment_add`, `routine_view`, `search_turns`); attachments (txt/md/docx/xlsx/pptx/pdf); optional model with `ADVISERS_API_KEY`;
- turns + summaries + CJK-capable FTS search (FTS5 trigram index, schema v21; <3-character queries keep the LIKE fallback), `/memory`, `/week`, `/digest`, `/tick`, `/today`, `/undo`, `/diff`, `/learn review`;
- `advisers capture` extracts candidate commitments from Chinese work text with verbatim quotes. Candidates stay pending until you explicitly accept one; no command auto-accepts.
- `advisers research --web` / `--url` does cited research through DeepSeek server web tools. This is an explicit **web** egress path; web citations are provider output, not local file evidence.
- `advisers remind` + `.ics`/VALARM export + opt-in scheduler scripts; `calendar import --ics`; `capture --from-mail`/`--from-transcript` (read-only, deduped, pending candidates only);
- `advisers evidence show` / `deliveries --pack` (manifest + SHA256SUMS + DOCX receipt) / `deliver --type ...` (DOCX/XLSX); operator-entered manual evidence (`--quote`/`--evidence`) is typed as **unverifiable, not missing** — packs and receipts count it separately;
- **delivery receipt pack v1.1**: `advisers deliveries --receipt [--out dir] [--ids ...] [--all] [--recipient ...]` copies the delivered files and records every SHA-256, the generator, verify results and recipient; `advisers evidence verify <dir>` verifies a pack offline (JSON, exit 0/1, no `~/.advisers`). Evidence entries default to a 2000 cap (`--ids`/`--all` control it); the old `deliveries --pack` evidence pack is unchanged. See `docs/DELIVERY-RECEIPT.md`.
- **reminder/calendar wiring (0.2.0)**: `commit add/edit --remind-offsets "-1d,-2h,+0d09:00"` stores per-commitment VALARMs; `remind --deliver --notify` adds the opt-in webhook and records the last run in `~/.advisers/scheduler/status.json`; `remind install|uninstall|status [--apply]` prints a dry-run OS plan first and only registers a cron/schtasks entry with `--apply`; `today --calendar` expands RRULEs locally (all-day `全天`, recurring `（循环）`). `today`, `capture`, `memory candidates` and `verify` now have stable `--json` shapes (`docs/CLI-JSON.md`).
- `advisers privacy --prove`, `advisers mcp --stdio` (7 tools + 4 read-only resources, 1 MiB JSON-RPC line cap; candidate writes are pending-only and fail closed when the audit row cannot be written), `advisers ui`（本地只读视图）, and JSON output for status/commit/who/deliveries/remind/evidence.
- **0.2.3 product additions**: `matter add|ls|show|rename|archive|use` (client/project loop; `--matter` is validated on writes); `agenda --days 1..31 --json` (7-day Asia/Shanghai agenda with conflicts) and deterministic `morning` brief; `template quote|proposal` (DOCX/XLSX, integer-cent money, no model) with offline `verify --content --template quote|proposal --data`; `doctor --check-db` (FTS/WAL/backup/plaintext maintenance checks).
- `advisers pet-brief --json|--out [path]|--check [--strict]|--print-schema|--display-policy public|private|none` projects a **read-only, redacted** Pet Brief (contract v0.2: `schemaVersion: 2` + `displayPolicy`, default `private`; v0.1 briefs stay readable as legacy) for the desktop-pet consumer: `secrecy >= 2` matters excluded, facts below confidence 0.7 dropped, 5-minute TTL, 10-item caps; no model call, no network, no ledger writes. UI/transport is not wired yet. See `docs/PET-BRIEF-PRODUCER.md`.
- each turn sends a `latest_reminder` date/weekday/location/language marker so relative dates are grounded;
- thinking mode: `ADVISERS_THINKING=off|on|auto`, `ADVISERS_THINKING_EFFORT=low|high|max`; `reasoning_content` is kept in memory only for the current tool loop and is not written to turns/summaries/audit/export/backup. This does not control provider-side logs or OS crash dumps;
- DSH bundle (`dsh-advisers`) with five tools (`advisers_brief`, `advisers_office`, `advisers_today`, `advisers_who`, `advisers_evidence`). On the 0.3.0 release candidate the three ledger read tools read the **real local ledger read-only** (TOS-gated, clearance 0, no HOME lock, no migration, no writes) and fall back to a marked preview only when no ledger exists or the facade is unavailable — see [docs/LEDGER-READ-API.md](docs/LEDGER-READ-API.md); this is not yet a published release. Email/Feishu link packages are **libraries not wired into the CLI**; optional strict policy pack (see `packages/policy-strict/README.md`);
- Hermes bridge (`advisers-bridge-hermes`); published with the other five packages for `0.2.0`;
- real-account/WS/Office-L3 validation still pending.

```sh
# 0.3.0 is a release candidate and not published; the repo is at 0.3.0.
# Run from the checkout (the supported way to try the 0.3.0 release candidate):
git clone https://github.com/PerryLink/advisers.git
cd advisers && corepack pnpm install && corepack pnpm -r build
ADVISERS_OFFICE_LOCAL=1 node packages/advisers/bin/advisers.js status
# From npm (stable channel = default `latest`, currently 0.2.3; 0.3.0 is not published):
#   npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
# The `next` channel currently also points at 0.2.3:
#   npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers
# or one-shot:
advisers chat "做一份 Q4 汇报 PPT，放到 out/q4.pptx"
advisers brief "做一份 Q4 预算 Excel，周五前给老板"
advisers template weekly data.json weekly.docx
advisers office docx spec.json out.docx
advisers bridge --dir "$BRIDGE_DIR"   # Hermes gateway bridge
```

Local interaction: `advisers` starts a REPL; `/help`, `/status`, `/new`, `/brief`, `/debug`, `/quit`. With an API key the model can call local Office/file tools and report the generated paths. File writes are confined to the working directory, overwrites require confirmation unless `ADVISERS_FORCE=1`, and local tools do not send file contents to the model unless you attach/read them.

npm tags: **`latest`** is the stable channel (currently `0.2.3`, published 2026-11-18),
**`next`** is the pre-release channel (currently also `0.2.3`). `0.3.0` is a **release
candidate** and `0.2.4` was a never-published candidate it supersedes — neither is
installable from npm, and 0.3.0 can only claim Trusted-Publishing provenance after its six
packages show non-empty `dist.attestations` in the registry. Pin an exact version
(`advisers@0.2.3` today) when you need a reproducible install, and query the official
registry directly (`npm view advisers dist-tags --registry=https://registry.npmjs.org/`) —
mirrors can lag behind.

## Security boundary

- Local-first by default: no telemetry; no network calls without an API key or a configured link provider.
- `research --web` / `--url` is the only built-in **web** egress command; it requires an explicit flag and refuses matters with `secrecy > 0` (fail closed until the 0–3 secrecy levels are productized).
- When `ADVISERS_API_KEY` is set, model-backed commands (`chat`, `capture`, `review`, `brief --deep`, `learn review`) send their inputs to the configured model API; local-only commands (`status`, `office`, `template`, `verify`, `commit add`, `tick`) do not.
- Audit is a **local hash chain plus, on the 0.3.0 release candidate, an optional local tail anchor** (`audit-anchor.json` + `audit --expect-head`), not a third-party attestation or timestamp: it detects edits to its own rows and (with an anchor) tail deletion, not a compromised host.
- Office verification checks structure and deterministic content signals; it does not prove factual correctness.

## License

Advisers is **source-available, not open source**. From `0.2.0` the licenses are split
(neither is retroactive):

- **Software** — `packages/**`, `scripts/**`, `.github/**`, package manifests, and the
  README/NOTICE/THIRD-PARTY-NOTICES shipped in npm tarballs:
  [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)
  (SPDX: `PolyForm-Noncommercial-1.0.0`). Noncommercial use only; use by or for a
  for-profit organization requires a separate commercial license.
- **Documentation, data and design** — root docs, `docs/**`, `eval/**`, `examples/**`,
  `templates/**`: [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
  (SPDX: `CC-BY-NC-SA-4.0`). Attribution, noncommercial use and ShareAlike apply.

Prior releases keep the licenses they were published under: MIT releases stay MIT and
releases published under Apache-2.0 before `0.2.0` (up to the 2026-11-17 preview) stay
Apache-2.0. See [LICENSE](LICENSE),
[LICENSE-DOCS](LICENSE-DOCS), [NOTICE](NOTICE) and [LICENSING.md](LICENSING.md) for the
definitive policy, required notices and the commercial-licensing channel.

Advisers is an independent core, not coupled to the famling desktop pet.
