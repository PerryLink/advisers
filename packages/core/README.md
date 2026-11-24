# advisers-core

Core types and runtime for **Advisers**:

- `Matter` — a dimension on the three ledgers, not a fourth ledger;
- `Ledger` — user preferences, facts, commitments, evidence;
- `FocusFrame` — the whitelist injected for one matter;
- `assembleContext` — global user model + active matter, hints only for others;
- `LinkProvider` / `LinkHost` — the only integration surface for IM/email.

SQLite/FTS persistence lives in the `advisers` distribution; this package has no cordis or DSH dependency. The runtime is plain TypeScript and is used by the CLI and DSH adapter.

## Status

`0.5.1` was published on 2026-11-24 (npm `latest` = `0.5.1`; `next` is also `0.5.1`).
0.5.1 is the current release (lockstep version): a follow-up patch on the 0.5.0 tree —
one schema jump (v22 -> v23: facts claim/evidence columns, mail thread columns,
`waiting_replies` and the handoff tables), read-only `mail followup`, bundle
drill/`--expect-dataDigest`/`FORMAT.md`, `context_pack.create` audit + MCP
`advisers_pack_verify` format dispatch, and the release-level quality evidence — all of
which live in `advisers` and `dsh-advisers`. This package's public surface
is unchanged from 0.3.2 — the 0.4/0.5 work (knowledge base, mail entry, interactive shell,
receivables, policy/evidence subset, portable/disclosure formats) lives in `advisers` and `dsh-advisers`. 0.3.1 was a
release-metadata patch for 0.3.0, and the 0.2.4 candidate superseded by the 0.3.0 line was
never published. The 0.2.3 baseline added pure ledger operations (`ops.ts`: commit
add/edit/done/snooze, correct, decay, forget, memory accept/reject) and a partial-snapshot
contract so the CLI can write incrementally and read only the tables it needs; 0.3.0+ keeps
those contracts additive and shares the read-model, error-code-registry and contract
artifacts documented in the `advisers` package. `0.2.2`/`0.2.1`/`0.2.0` remain installable
by pinning. The API is stabilizing but may still change within 0.x.

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
