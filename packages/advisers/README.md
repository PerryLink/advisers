# advisers

The cordis-only distribution of **Advisers** — a staff of AI advisers with one
continuous conversation, a user ledger, a commitment ledger, and reviewable
routines.

## Install

```sh
npm i -g advisers@next advisers-office@next advisers-bridge-hermes@next
advisers soul init
advisers brief "做一份 Q4 预算 Excel，周五前给老板"
advisers chat "周五前把报价发给王工"
advisers office xlsx spec.json out.xlsx
advisers ls
advisers export
```

The CLI is a **context preview**, not a chat UI: it records the message, builds
the FocusFrame, and prints what would be sent to a model. The model call is the
next milestone.

## Status

`0.2.0-preview.14` is staged (approval pending):

- SQLite ledger at `~/.advisers/state.db` (JSON fallback with `ADVISERS_STORE=json`);
- soul at `~/.advisers/soul.md`, human-owned;
- local REPL, `chat`, `office`, `template`, `routine`, `link`, `bridge`, `soul`, `ls`, `why`, `forget`, `export`;
- IntentBrief + clarification policy + readback;
- DOCX/XLSX/PPTX/Mermaid/draw.io/XMind builders and 5 templates in `advisers-office`;
- routine v0 (draft/approve/archive + patch/diff/apply) and confirmed link hints;
- local agent loop with Office/file tools; optional model via `ADVISERS_API_KEY` / `ADVISERS_BASE_URL` / `ADVISERS_MODEL`;
- DSH bundle, email IMAP/draft, Feishu webhook, Hermes bridge; strict policy pack;
- real-account/WS/Office-L3 validation still pending.

Shared core and architecture:

https://github.com/PerryLink/advisers

## License

MIT.
