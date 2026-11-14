# advisers

The cordis-only distribution of **Advisers** — a staff of AI advisers with one
continuous conversation, a user ledger, a commitment ledger, and reviewable
routines.

## Install

```sh
# Current preview is staged, awaiting OTP; public @next is an old 0.1 stub.
# From checkout:
#   corepack pnpm install && corepack pnpm -r build
#   ADVISERS_OFFICE_LOCAL=1 node packages/advisers/bin/advisers.js status
# After approval:
npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers soul init
advisers brief "做一份 Q4 预算 Excel，周五前给老板"
advisers chat "周五前把报价发给王工"
advisers office xlsx spec.json out.xlsx
advisers ls
advisers export
```

The CLI is a **local secretary runtime**: one REPL, a user ledger, a commitment
ledger, a routine ledger, Office artifacts, and an optional model loop. Without
an API key it records the session and can build/search files, but it does not
turn natural language into commitments or artifacts.

## Status

`0.2.0-preview.56` is staged (approval pending):

- SQLite ledger at `~/.advisers/state.db` (JSON fallback with `ADVISERS_STORE=json`);
- soul at `~/.advisers/soul.md`, human-owned;
- local REPL, `chat`, `office`, `template`, `routine`, `link`, `bridge`, `soul`, `ls`, `why`, `forget`, `export`;
- IntentBrief + clarification policy + readback;
- DOCX/XLSX/PPTX/Mermaid/draw.io/XMind builders, 7 templates, read/edit/verify in `advisers-office`;
- turns + session summaries + FTS search; opening protocol; `/resume`;
- commitment ledger + `commit add/ls/done`, `tick`, `snooze`, nudge outcomes;
- `/memory`, `/week`, `/digest`, `/diff`, `/undo`, `/learn review`;
- routine draft/approve/patch/curator + active routine index + `routine_view`;
- local agent loop with Office/file tools, `commitment_add`, `search_turns`; attachments (txt/md/docx/xlsx/pptx/pdf); optional model via `ADVISERS_API_KEY` / `ADVISERS_BASE_URL` / `ADVISERS_MODEL`;
- DSH bundle, email IMAP/draft, Feishu webhook, Hermes bridge; strict policy pack;
- real-account/WS/Office-L3 validation still pending.

Shared core and architecture:

https://github.com/PerryLink/advisers

## License

MIT.
