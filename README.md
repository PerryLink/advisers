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

`0.1.0-preview.2` is on the npm `next` tag:

- `advisers` CLI: `soul init`, `brief`, `chat`, `office`, `ls`, `why`, `forget`, `export`;
- soul at `~/.advisers/soul.md` (human-owned, slot #1);
- JSON ledger at `~/.advisers/state.json`;
- `advisers-office`: DOCX/XLSX/PPTX/Mermaid/draw.io builders;
- no LLM call, no SQLite, no real IM link, no DSH bundle yet.

```sh
npm i -g advisers@next
advisers soul init
advisers chat "周五前把报价发给王工"
```

The `latest` tag stays on the stable placeholder `0.0.3` until the preview is
promoted.

## License

MIT.
