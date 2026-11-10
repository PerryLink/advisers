# advisers-core

Core types and the in-memory runtime skeleton for **Advisers**:

- `Matter` — a dimension on the three ledgers, not a fourth ledger;
- `Ledger` — user preferences, facts, commitments, evidence;
- `FocusFrame` — the whitelist injected for one matter;
- `assembleContext` — global user model + active matter, hints only for others;
- `LinkProvider` / `LinkHost` — the only integration surface for IM/email.

The production storage (SQLite + FTS5) and the cordis/DSH adapters live in the
distribution packages. This package has no cordis or DSH dependency.

## Status

Bootstrapping. The API is allowed to change before `0.1.0`.

## License

MIT.
