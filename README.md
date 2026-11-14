# Advisers

**A staff of AI advisers — a cordis-native personal secretary runtime.**

Advisers is not another chat window. It is a small staff of specialist advisers
(memory, commitments, routines) that share one continuous conversation and keep
three ledgers:

- **user ledger** — who you are, preferences, boundaries, evidence;
- **commitment ledger** — who owes whom, due dates, external proof;
- **routine ledger** — how this kind of work is done here; routine changes can be reviewed as diffs before approval.

The core is built on [cordis](https://github.com/cordiverse/cordis). The CLI is
the primary product; the DSH bundle is a thin adapter (currently `advisers_brief`
+ `advisers_office`), not a feature-complete second product:

| Package | Role |
|---|---|
| `advisers` | primary runtime + CLI (no DSH dependency) |
| `dsh-advisers` | thin DSH adapter (brief/office only; ledger not yet exposed) |

IM is a **Link SPI**, not a hard dependency. Email, Satori/Koishi, `dsh-im`,
OpenClaw, and Hermes gateways are optional link providers. The core package does
not depend on them; adapters load them only when configured.

## Status

`0.2.0-preview.22/56` is **staged** on npm, awaiting OTP approval. The public `next` tag still points at the old `0.1.0-preview.2`; do not evaluate this build through it until approval:

> Requires **Node >= 22.13**. See [docs/QUICKSTART.md](docs/QUICKSTART.md) for Windows/PowerShell and BOM notes.

- `advisers` CLI: local REPL, `chat`, `office`, `template`, `routine`, `link`, `bridge`, `soul`, `ls`, `why`, `forget`, `export`;
- SQLite at `~/.advisers/state.db` (JSON fallback with `ADVISERS_STORE=json`);
- `IntentBrief` + clarification policy + readback;
- `advisers-office`: DOCX/XLSX/PPTX/Mermaid/draw.io/XMind + 7 templates; read/edit/verify;
- routine v0 (draft/approve/archive + patch/diff/apply);
- local agent loop with tools (`office_build`, `office_template`, `file_read/write/list`, `commitment_add`, `routine_view`, `search_turns`); attachments (txt/md/docx/xlsx/pptx/pdf); optional model with `ADVISERS_API_KEY`;
- turns + summaries + FTS search, `/memory`, `/week`, `/digest`, `/tick`, `/today`, `/undo`, `/diff`, `/learn review`;
- `advisers capture` extracts candidate commitments from Chinese work text with verbatim quotes. Candidates stay pending until you explicitly accept one; no command auto-accepts.
- `advisers research --web` / `--url` does cited research through DeepSeek server web tools. This is an explicit egress path; web citations are provider output, not local file evidence.
- each turn sends a `latest_reminder` date/weekday/location/language marker so relative dates are grounded;
- thinking mode: `ADVISERS_THINKING=off|on|auto`, `ADVISERS_THINKING_EFFORT=low|high|max`; `reasoning_content` is kept in memory only for the current tool loop and is not written to turns/summaries/audit/export/backup. This does not control provider-side logs or OS crash dumps;
- DSH bundle (`dsh-advisers`) with `advisers_brief` + `advisers_office`; email/Feishu link packages are **libraries not wired into the CLI**; optional strict policy pack (see `packages/policy-strict/README.md`);
- Hermes bridge (`advisers-bridge-hermes`); npm `latest` is currently a placeholder until published;
- real-account/WS/Office-L3 validation still pending.

```sh
# Current staged preview is not public yet; run from checkout:
git clone https://github.com/PerryLink/advisers.git
cd advisers && corepack pnpm install && corepack pnpm -r build
ADVISERS_OFFICE_LOCAL=1 node packages/advisers/bin/advisers.js status
# After npm approval:
# npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers
# or one-shot:
advisers chat "做一份 Q4 汇报 PPT，放到 out/q4.pptx"
advisers brief "做一份 Q4 预算 Excel，周五前给老板"
advisers template weekly data.json weekly.docx
advisers office docx spec.json out.docx
advisers bridge --dir "$BRIDGE_DIR"   # Hermes gateway bridge
```

Local interaction: `advisers` starts a REPL; `/help`, `/status`, `/new`, `/brief`, `/debug`, `/quit`. With an API key the model can call local Office/file tools and report the generated paths. File writes are confined to the working directory, overwrites require confirmation unless `ADVISERS_FORCE=1`, and local tools do not send file contents to the model unless you attach/read them.

The `latest` tag stays on the stable placeholder `0.0.4` until the preview is
promoted.

## Security boundary

- Local-first by default: no telemetry; no network calls without an API key or a configured link provider.
- `research --web` / `--url` is the only built-in content-egress command; it requires an explicit flag and rejects secret matters.
- Audit is a local hash chain, not a third-party attestation; it detects edits to its own rows, not a compromised host.
- Office verification checks structure and deterministic content signals; it does not prove factual correctness.

## License

MIT.
