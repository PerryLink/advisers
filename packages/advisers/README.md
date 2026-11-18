# advisers

The cordis-only distribution of **Advisers** — a staff of AI advisers with one
continuous conversation, a user ledger, a commitment ledger, and reviewable
routines.

## Install

```sh
# 0.2.2 is the release candidate staged to npm @latest (owner OTP pending);
# 0.2.1 is the published @latest (stable channel = default `latest`):
#   npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
# From checkout:
#   corepack pnpm install && corepack pnpm -r build
#   ADVISERS_OFFICE_LOCAL=1 node packages/advisers/bin/advisers.js status
# Pre-release/RC builds land on the `next` channel (currently also 0.2.1):
#   npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers soul init
advisers brief "做一份 Q4 预算 Excel，周五前给老板"
advisers chat "周五前把报价发给王工"
advisers office xlsx spec.json out.xlsx
advisers ls
advisers export
```

> **AI & legal notice** — Advisers is a local-first work assistant, not a companion or a
> professional adviser. AI output can be wrong; verify before use. Illegal, infringing,
> fraudulent, harassing, or unlabeled synthetic content is prohibited; distribute
> AI-generated content only with the required labels. Minors need guardian consent.
> Software licence: PolyForm Noncommercial 1.0.0 (source-available, not OSI open source;
> commercial use requires a separate licence). Terms:
> <https://github.com/PerryLink/advisers/blob/main/docs/TOS.md> (v2026.11.2) · Disclaimer:
> <https://github.com/PerryLink/advisers/blob/main/docs/DISCLAIMER.md> · Safety:
> <https://github.com/PerryLink/advisers/blob/main/docs/SAFETY.md> · Privacy & data-flow:
> <https://github.com/PerryLink/advisers/blob/main/docs/PRIVACY.md>. The local database is
> not encrypted by default; the default model provider is DeepSeek (api.deepseek.com) when
> you set an API key. Offline copies ship in `lib/tos/` (`terms.zh-CN.md`,
> `summary.zh-CN.md`, `privacy.zh-CN.md`, `safety.zh-CN.md`).

The CLI is a **local secretary runtime**: one REPL, a user ledger, a commitment
ledger, a routine ledger, Office artifacts, and an optional model loop. Without
an API key it records the session and can build/search files, but it does not
turn natural language into commitments or artifacts.

## Status

`0.2.2` is the release candidate (2026-11-18), staged to npm `latest` and awaiting
the account owner's OTP approval; npm `latest` still resolves to `0.2.1` (published
2026-11-17):

- SQLite ledger at `~/.advisers/state.db` (JSON fallback with `ADVISERS_STORE=json`);
- soul at `~/.advisers/soul.md`, human-owned;
- local REPL, `chat`, `office`, `template`, `routine`, `link`, `bridge`, `soul`, `ls`, `why`, `forget`, `export`;
- IntentBrief + clarification policy + readback;
- DOCX/XLSX/PPTX/Mermaid/draw.io/XMind builders, 7 templates, read/edit/verify in `advisers-office`;
- turns + session summaries + FTS search; opening protocol; `/resume`;
- commitment ledger + `commit add/ls/done`, `tick`, `snooze`, nudge outcomes;
- `/memory`, `/week`, `/digest`, `/diff`, `/undo`; CLI: `learn ls`, `learn review <id>`;
- routine draft/approve/patch/curator + active routine index + `routine_view`;
- local agent loop with Office/file tools, `commitment_add`, `search_turns`; attachments (txt/md/docx/xlsx/pptx/pdf); optional model via `ADVISERS_API_KEY` / `ADVISERS_BASE_URL` / `ADVISERS_MODEL`;
- `advisers pet-brief` read-only redacted projection for the desktop-pet consumer (contract v0.2: `schemaVersion: 2` + `displayPolicy`, default `private`; `--json`/`--out`/`--check [--strict]`/`--print-schema`/`--display-policy`; `secrecy >= 2` excluded; 5-minute TTL; v0.1 briefs readable as legacy); no UI wiring yet;
- DSH bundle, email IMAP/draft, Feishu webhook, Hermes bridge; strict policy pack;
- real-account/WS/Office-L3 validation still pending.

Shared core and architecture:

https://github.com/PerryLink/advisers

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

Versions published before 0.2.0 keep their original licenses (MIT; Apache-2.0 for the
preview releases published up to 2026-11-17); the change is not retroactive. See the
repository LICENSING.md, LICENSE-DOCS and NOTICE.
