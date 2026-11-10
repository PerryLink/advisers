# advisers

The cordis-only distribution of **Advisers** — a staff of AI advisers with one
continuous conversation, a user ledger, a commitment ledger, and reviewable
routines.

## Install

```sh
npm i -g advisers@next
advisers soul init
advisers chat "周五前把报价发给王工"
advisers ls
advisers export
```

The CLI is a **context preview**, not a chat UI: it records the message, builds
the FocusFrame, and prints what would be sent to a model. The model call is the
next milestone.

## Status

`0.1.0-preview.1` is a preview:

- in-memory/JSON ledger at `~/.advisers/state.json`;
- soul at `~/.advisers/soul.md`, human-owned;
- `soul`, `chat`, `ls`, `why`, `forget`, `export` commands;
- no LLM call, no SQLite, no real IM Link, no DSH bundle.

Shared core and architecture:

https://github.com/PerryLink/advisers

## License

MIT.
