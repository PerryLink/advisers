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

Bootstrapping. The npm names `advisers` and `dsh-advisers` are reserved; the
runtime skeleton is being implemented in this repository.

## License

MIT.
