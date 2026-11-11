# Advisers

**A staff of AI advisers — a cordis-native personal secretary runtime.**

Advisers is not another chat window. It is a small staff of specialist advisers
(memory, commitments, routines) that share one continuous conversation and keep
three ledgers:

- **user ledger** — who you are, preferences, boundaries, evidence;
- **commitment ledger** — who owes whom, due dates, external proof;
- **routine ledger** — how this kind of work is done here, reviewable as diffs.

The core is built on [cordis](https://github.com/cordiverse/cordis). Two
distributions share the same core:

| Package | Role |
|---|---|
| `advisers` | cordis-only runtime + CLI (no DSH dependency) |
| `dsh-advisers` | DeepSeek Harness distribution (mounts the same core) |

IM is a **Link SPI**, not a hard dependency. Email, Satori/Koishi, `dsh-im`,
OpenClaw, and Hermes gateways are optional link providers; the core never imports
them.

## Status

`0.2.0-preview.4` is staged on npm (`next` still points at the verified preview.2 until the staged packages are approved):

- `advisers` CLI: `soul`, `brief`, `chat`, `office`, `template`, `routine`, `link`, `ls`, `why`, `forget`, `export`;
- SQLite at `~/.advisers/state.db` (JSON fallback with `ADVISERS_STORE=json`);
- `IntentBrief` + clarification policy + readback;
- `advisers-office`: DOCX/XLSX/PPTX/Mermaid/draw.io/XMind + 5 templates;
- routine v0 (draft/approve/archive + patch/diff/apply);
- optional model call with `ADVISERS_API_KEY`;
- DSH bundle (`dsh-advisers`) with `advisers_brief`; email IMAP/draft; Feishu webhook; strict policy pack;
- real-account/WS/Office-L3 validation still pending.

```sh
npm i -g advisers@next advisers-office@next
advisers soul init
advisers brief "做一份 Q4 预算 Excel，周五前给老板"
advisers template weekly data.json weekly.docx
advisers office docx spec.json out.docx
```

The `latest` tag stays on the stable placeholder `0.0.4` until the preview is
promoted.

## License

MIT.
