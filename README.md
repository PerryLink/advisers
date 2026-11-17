# Advisers

**A staff of AI advisers — a local-first, auditable personal secretary runtime.**

> **AI & compliance notice** — Advisers is a local-first work assistant, not a companion,
> lawyer, doctor, or financial adviser. AI output can be wrong; verify before use.
> Illegal, infringing, fraudulent, harassing, or forged use is prohibited; distribute
> AI-generated content only with the required labels. Minors need guardian consent.
> Read the [Terms of Service](docs/TOS.md) (v2026.11.2), [Disclaimer](docs/DISCLAIMER.md),
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

`0.2.0` is the **current stable release** for the 2026-11-17 release: the eight workspace
packages are lockstep at `0.2.0`. The six published packages are `advisers`,
`advisers-core`, `advisers-office`, `advisers-policy-strict`, `advisers-bridge-hermes` and
`dsh-advisers`; the two private `advisers-link-*` packages are held at the same version but
are not published. All six published packages are live on npm **`latest` = `0.2.0`**
(the account owner completed the npm OTP approval on 2026-11-17). Registry tarballs,
license files and a fresh-prefix install were verified with
`scripts/verify-release.mjs` (80/80 checks, including an install smoke test).

> Requires **Node >= 22.16**. See [docs/QUICKSTART.md](docs/QUICKSTART.md) for Windows/PowerShell and BOM notes.

- `advisers` CLI: local REPL, `chat`, `office`, `template`, `routine`, `link`, `bridge`, `soul`, `ls`, `why`, `forget`, `export`;
- SQLite at `~/.advisers/state.db` (JSON fallback with `ADVISERS_STORE=json`);
- `IntentBrief` + clarification policy + readback;
- `advisers-office`: DOCX/XLSX/PPTX/Mermaid/draw.io/XMind + 7 templates; read/edit/verify;
- routine v0 (draft/approve/archive + patch/diff/apply);
- local agent loop with tools (`office_build`, `office_template`, `file_read/write/list`, `commitment_add`, `routine_view`, `search_turns`); attachments (txt/md/docx/xlsx/pptx/pdf); optional model with `ADVISERS_API_KEY`;
- turns + summaries + FTS search, `/memory`, `/week`, `/digest`, `/tick`, `/today`, `/undo`, `/diff`, `/learn review`;
- `advisers capture` extracts candidate commitments from Chinese work text with verbatim quotes. Candidates stay pending until you explicitly accept one; no command auto-accepts.
- `advisers research --web` / `--url` does cited research through DeepSeek server web tools. This is an explicit **web** egress path; web citations are provider output, not local file evidence.
- `advisers remind` + `.ics`/VALARM export + opt-in scheduler scripts; `calendar import --ics`; `capture --from-mail`/`--from-transcript` (read-only, deduped, pending candidates only);
- `advisers evidence show` / `deliveries --pack` (manifest + SHA256SUMS + DOCX receipt) / `deliver --type ...` (DOCX/XLSX);
- **delivery receipt pack v1.1**: `advisers deliveries --receipt [--out dir] [--ids ...] [--all] [--recipient ...]` copies the delivered files and records every SHA-256, the generator, verify results and recipient; `advisers evidence verify <dir>` verifies a pack offline (JSON, exit 0/1, no `~/.advisers`). Evidence entries default to a 2000 cap (`--ids`/`--all` control it); the old `deliveries --pack` evidence pack is unchanged. See `docs/DELIVERY-RECEIPT.md`.
- **reminder/calendar wiring (0.2.0)**: `commit add/edit --remind-offsets "-1d,-2h,+0d09:00"` stores per-commitment VALARMs; `remind --deliver --notify` adds the opt-in webhook and records the last run in `~/.advisers/scheduler/status.json`; `remind install|uninstall|status [--apply]` prints a dry-run OS plan first and only registers a cron/schtasks entry with `--apply`; `today --calendar` expands RRULEs locally (all-day `全天`, recurring `（循环）`). `today`, `capture`, `memory candidates` and `verify` now have stable `--json` shapes (`docs/CLI-JSON.md`).
- `advisers privacy --prove`, `advisers mcp --stdio` (7 tools + 4 read-only resources, 1 MiB JSON-RPC line cap; candidate writes are pending-only and fail closed when the audit row cannot be written), `advisers ui`（本地只读视图）, and JSON output for status/commit/who/deliveries/remind/evidence.
- `advisers pet-brief --json|--out [path]|--check [--strict]|--print-schema|--display-policy public|private|none` projects a **read-only, redacted** Pet Brief (contract v0.2: `schemaVersion: 2` + `displayPolicy`, default `private`; v0.1 briefs stay readable as legacy) for the desktop-pet consumer: `secrecy >= 2` matters excluded, facts below confidence 0.7 dropped, 5-minute TTL, 10-item caps; no model call, no network, no ledger writes. UI/transport is not wired yet. See `docs/PET-BRIEF-PRODUCER.md`.
- each turn sends a `latest_reminder` date/weekday/location/language marker so relative dates are grounded;
- thinking mode: `ADVISERS_THINKING=off|on|auto`, `ADVISERS_THINKING_EFFORT=low|high|max`; `reasoning_content` is kept in memory only for the current tool loop and is not written to turns/summaries/audit/export/backup. This does not control provider-side logs or OS crash dumps;
- DSH bundle (`dsh-advisers`) with five tools (`advisers_brief`, `advisers_office`, `advisers_today`, `advisers_who`, `advisers_evidence`); email/Feishu link packages are **libraries not wired into the CLI**; optional strict policy pack (see `packages/policy-strict/README.md`);
- Hermes bridge (`advisers-bridge-hermes`); published with the other five packages for `0.2.0`;
- real-account/WS/Office-L3 validation still pending.

```sh
# 0.2.0 is published on npm @latest; or run from checkout:
git clone https://github.com/PerryLink/advisers.git
cd advisers && corepack pnpm install && corepack pnpm -r build
ADVISERS_OFFICE_LOCAL=1 node packages/advisers/bin/advisers.js status
# From npm (stable channel = default `latest`, now 0.2.0):
#   npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
# Pre-release/RC builds used the `next` channel (after release it also points at 0.2.0):
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

npm tags: **`latest`** is the stable channel (still the old `0.0.4` placeholder until the
owner approves 0.2.0), **`next`** is the pre-release channel where preview/RC builds land.
Pin an exact version (`advisers@0.2.0`) when you need a reproducible install, and query
the official registry directly
(`npm view advisers dist-tags --registry=https://registry.npmjs.org/`) — mirrors can lag behind.

## Security boundary

- Local-first by default: no telemetry; no network calls without an API key or a configured link provider.
- `research --web` / `--url` is the only built-in **web** egress command; it requires an explicit flag and refuses matters with `secrecy > 0` (fail closed until the 0–3 secrecy levels are productized).
- When `ADVISERS_API_KEY` is set, model-backed commands (`chat`, `capture`, `review`, `brief --deep`, `learn review`) send their inputs to the configured model API; local-only commands (`status`, `office`, `template`, `verify`, `commit add`, `tick`) do not.
- Audit is a local hash chain, not a third-party attestation; it detects edits to its own rows, not a compromised host.
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
