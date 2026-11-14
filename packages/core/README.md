# advisers-core

Core types and runtime for **Advisers**:

- `Matter` — a dimension on the three ledgers, not a fourth ledger;
- `Ledger` — user preferences, facts, commitments, evidence;
- `FocusFrame` — the whitelist injected for one matter;
- `assembleContext` — global user model + active matter, hints only for others;
- `LinkProvider` / `LinkHost` — the only integration surface for IM/email.

SQLite/FTS persistence lives in the `advisers` distribution; this package has no cordis or DSH dependency. The runtime is plain TypeScript and is used by the CLI and DSH adapter.

## Status

`0.2.0-preview.20`. API is stabilizing but may change before 0.3.

## License

MIT.
