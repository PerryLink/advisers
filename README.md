# Advisers

**A staff of AI advisers — a cordis-native personal secretary runtime.**

Advisers is not another chat window. It is a small staff of specialist advisers
(memory, commitments, routines) that share one continuous conversation and keep
three ledgers:

- **user ledger** — who you are, preferences, boundaries, evidence;
- **commitment ledger** — who owes whom, due dates, external proof;
- **routine ledger** — how this kind of work is done here, reviewable as diffs.

The core is built on [cordis](https://github.com/cordiverse/cordis). The CLI is
the primary product; the DSH bundle is a thin adapter (currently `advisers_brief`
+ `advisers_office`), not a feature-complete second product:

| Package | Role |
|---|---|
| `advisers` | primary runtime + CLI (no DSH dependency) |
| `dsh-advisers` | thin DSH adapter (brief/office only; ledger not yet exposed) |

IM is a **Link SPI**, not a hard dependency. Email, Satori/Koishi, `dsh-im`,
OpenClaw, and Hermes gateways are optional link providers; the core never imports
them.

## Status

`0.2.0-preview.14/37` is staged on npm (`next` still points at the verified preview.2 until the staged packages are approved):

- `advisers` CLI: local REPL, `chat`, `office`, `template`, `routine`, `link`, `bridge`, `soul`, `ls`, `why`, `forget`, `export`;
- SQLite at `~/.advisers/state.db` (JSON fallback with `ADVISERS_STORE=json`);
- `IntentBrief` + clarification policy + readback;
- `advisers-office`: DOCX/XLSX/PPTX/Mermaid/draw.io/XMind + 5 templates;
- routine v0 (draft/approve/archive + patch/diff/apply);
- local agent loop with tools (`office_build`, `office_template`, `file_read/write/list`, `commitment_add`, `routine_view`, `search_turns`); attachments (txt/md/docx/xlsx/pptx/pdf); optional model with `ADVISERS_API_KEY`;
- turns + summaries + FTS search, `/memory`, `/week`, `/digest`, `/tick`, `/undo`, `/diff`, `/learn review`;
- DSH bundle (`dsh-advisers`) with `advisers_brief`; email IMAP/draft; Feishu webhook; strict policy pack;
- Hermes bridge (`advisers-bridge-hermes`) for 20+ platforms through Hermes gateway;
- real-account/WS/Office-L3 validation still pending.

```sh
npm i -g advisers@next advisers-office@next
# optional: npm i -g advisers-bridge-hermes@latest
advisers
# or one-shot:
advisers chat "做一份 Q4 汇报 PPT，放到 out/q4.pptx"
advisers brief "做一份 Q4 预算 Excel，周五前给老板"
advisers template weekly data.json weekly.docx
advisers office docx spec.json out.docx
advisers bridge --dir "$BRIDGE_DIR"   # Hermes gateway bridge
```

Local interaction: `advisers` starts a REPL; `/help`, `/status`, `/new`, `/brief`, `/debug`, `/quit`. With an API key the model can call local Office/file tools and report the generated paths.

The `latest` tag stays on the stable placeholder `0.0.4` until the preview is
promoted.

## License

MIT.
