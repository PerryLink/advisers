# advisers

The cordis-only distribution of **Advisers** — a staff of AI advisers with one
continuous conversation, a user ledger, a commitment ledger, and reviewable
routines.

## Install

```sh
npm i -g advisers@next advisers-office@next
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

`0.1.0-preview.3` is a preview:

- in-memory/JSON ledger at `~/.advisers/state.json`;
- soul at `~/.advisers/soul.md`, human-owned;
- `soul`, `brief`, `chat`, `office`, `ls`, `why`, `forget`, `export` commands;
- IntentBrief + clarification policy + readback;
- DOCX/XLSX/PPTX/Mermaid/draw.io builders in `advisers-office`;
- no LLM call, no SQLite, no real IM Link, no DSH bundle.

Shared core and architecture:

https://github.com/PerryLink/advisers

## License

MIT.
