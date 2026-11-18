# advisers-core

Core types and runtime for **Advisers**:

- `Matter` — a dimension on the three ledgers, not a fourth ledger;
- `Ledger` — user preferences, facts, commitments, evidence;
- `FocusFrame` — the whitelist injected for one matter;
- `assembleContext` — global user model + active matter, hints only for others;
- `LinkProvider` / `LinkHost` — the only integration surface for IM/email.

SQLite/FTS persistence lives in the `advisers` distribution; this package has no cordis or DSH dependency. The runtime is plain TypeScript and is used by the CLI and DSH adapter.

## Status

`0.2.3` is the release candidate (2026-11-18), staged for npm `latest` awaiting the
account owner's OTP approval; `0.2.2` remains the current published `latest` until then
and `0.2.1`/`0.2.0` are installable by pinning. This release adds pure ledger operations
(`ops.ts`: commit add/edit/done/snooze, correct, decay, forget, memory accept/reject) and a
partial-snapshot contract so the CLI can write incrementally and read only the tables it
needs. The API is stabilizing but may change before 0.3.

## License

Software: [PolyForm Noncommercial License 1.0.0](LICENSE) (SPDX
`PolyForm-Noncommercial-1.0.0`); see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Source-available, not open source and not an OSI-approved open source license;
commercial use requires a separate commercial license (open an issue at
<https://github.com/PerryLink/advisers/issues>).

Documentation, evaluation data and design materials of the repository are licensed under
[CC BY-NC-SA 4.0](https://github.com/PerryLink/advisers/blob/main/LICENSE-DOCS); this
package README ships with the software and is covered by PolyForm NC. Third-party
components keep their own licenses: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Versions published before 0.2.0 keep their original licenses (MIT; Apache-2.0 for
`advisers@0.2.0-preview.71`); the change is not retroactive. See the repository
LICENSING.md, LICENSE-DOCS and NOTICE.
