# Advisers

**A verifiable delivery & commitment layer for independent consultants — local ledgers, offline-verifiable receipts, portable by design.**

> **AI & compliance notice** — Advisers is a local-first work assistant, not a companion,
> lawyer, doctor, or financial adviser. AI output can be wrong; verify before use.
> Illegal, infringing, fraudulent, harassing, or forged use is prohibited; distribute
> AI-generated content only with the required labels. Minors need guardian consent.
> Read the [Terms of Service](docs/TOS.md) (v2026.11.4), [Disclaimer](docs/DISCLAIMER.md),
> [Safety & content review](docs/SAFETY.md) and [Privacy & data-flow notice](docs/PRIVACY.md)
> before use; licence split: [LICENSING.md](LICENSING.md).

> **Noncommercial source-available** — Advisers is **not open source**. The software is
> PolyForm Noncommercial License 1.0.0 (noncommercial use only; no anticipated commercial
> application) and docs/data/design are CC BY-NC-SA 4.0. Commercial use — including paid
> client work — requires a separate written commercial licence (open an issue at
> <https://github.com/PerryLink/advisers/issues>, label `commercial-license`). The local
> database is **not encrypted by default**; see the [Privacy notice](docs/PRIVACY.md) for the
> full egress list (DeepSeek is the default model provider) and deletion limits.

Advisers is not another chat window. It is a local-first ledger for independent
consultants: deterministic Office deliverables, evidence traceback and
offline-verifiable receipts over three ledgers:

- **user ledger** — who you are, preferences, boundaries, evidence;
- **commitment ledger** — who owes whom, due dates, external proof;
- **routine ledger** — how this kind of work is done here; routine changes can be reviewed as diffs before approval.

The core is standalone (no cordis dependency). The DSH bundle is a thin,
cordis-compatible host adapter (six tools: `advisers_brief`, `advisers_office`,
`advisers_today`, `advisers_who`, `advisers_evidence`, `advisers_clients`), not a
feature-complete second product:

| Package | Role |
|---|---|
| `advisers` | primary runtime + CLI (no DSH dependency) |
| `dsh-advisers` | thin DSH adapter (brief/office + read-only today/who/evidence) |

IM is a **Link SPI**, not a hard dependency. The repository currently ships
`link-email` (draft-only email provider/transport) and `link-feishu` (Feishu
message provider/source), plus `bridge-hermes`; the CLI does not wire these link
packages into an end-to-end inbox yet (0.4.0's `mail sync` is a separate built-in
read-only IMAP entry). Other gateways are not bundled. The core does not depend
on any link package; adapters load one only when configured.

**Scope: a local ledger and verification layer, not an always-on assistant.**
"Secretary" in older text means the local ledger/Office/reminder loop, not
always-on recording or meeting transcription, not a companion mobile app, and not
automatic sending or rescheduling — those are explicit product non-goals, not
missing buttons (see [docs/POSITIONING.md](docs/POSITIONING.md)). In the 0.4.3/0.5.0
line there is no background daemon and no inbox IDLE watch; `mail sync --watch` is an
explicit foreground poll you start and stop, mail is read-only IMAP, and IM is
reachable only through the optional, externally installed Hermes bridge. 0.5.0 adds
**no new network path**, no new runtime dependency and no schema migration; its new
artifacts are local files (bundle, context pack, sync baseline).

## Status

**`0.5.0` was published on 2026-11-22** and is the current npm **`latest`**; npm
**`next`** is also `0.5.0` after this release advanced it. The repository is lockstep at
package version `0.5.0`. `0.5.0` is a "portable, disclosable, verifiable" release, not a
new AI capability line: it adds portable home **bundle v1** (`export --bundle` /
`import --bundle --verify`, plaintext and checksum-only), offline-verifiable **context
pack v1** (`context-pack create|verify`, human-selected, no import path, no
read/execution authority), additive **MCP/DSH disclosure** (`disclosure` + per-row
`view`; tool counts unchanged), **sync snapshot v2** with `sync.state.json`, real
`sync push --dry-run`, conflict precheck and `sync status --check` (last-writer-wins
is still the transfer semantics), `setup`/`demo`/`help <topic>` onboarding,
fail-closed managed backups before destructive commands, and a report-v2 quality gate.
The `0.4.0` feature surface is unchanged: local knowledge base (schema v22), TLS-only
IMAP mail entry, the interactive shell, proactive urgent-first briefs, the
policy/evidence 2.0 subset, receivables/payments with client pack v2, MCP modern
dual-era, Windows CI plus a portable ZIP, and the v2026.11.4 legal revision. Defaults
stay local: no new command requires a model call, there is no background daemon, and
`mail sync` remains the one explicit network path (TLS-only, read-only, user-invoked).
Zero schema change (still v22), zero new network path, zero new runtime dependency. Read
[PORTABILITY.md](docs/PORTABILITY.md), [CONTEXT-PACK.md](docs/CONTEXT-PACK.md),
[AGENT-INTEROP.md](docs/AGENT-INTEROP.md), [SYNC.md](docs/SYNC.md) and
[POSITIONING.md](docs/POSITIONING.md).
**Schema v22 is a one-way migration**: the CLI writes
`state.db.before-migrate-v*` before upgrading, a 0.3.2 binary opening a v22 database
fails with `E_SCHEMA_NEWER`, and downgrading means restoring that backup. `0.4.3`,
`0.4.2`, `0.4.1`, `0.4.0`, `0.3.2`, `0.3.1` and `0.3.0` remain installable by pinning
but are superseded — use `0.5.0`. The earlier `0.2.4` was an **unpublished release candidate** superseded by
the 0.3.0 line (its `v0.2.4` tag points at an older commit and there is no 0.2.4 tarball
on npm; do not try to install it). The six published packages are `advisers`,
`advisers-core`, `advisers-office`, `advisers-policy-strict`, `advisers-bridge-hermes`
and `dsh-advisers`; the two private `advisers-link-*` packages are held at the same
version but are not published. The `0.5.0` tarballs are published from GitHub Actions
OIDC/Trusted Publishing (no long-lived npm token) with SLSA provenance
(`https://slsa.dev/provenance/v1`), and the attestation names the release tag ref rather
than a branch. Release notes (with the CycloneDX SBOM and `SHA256SUMS` attached):
<https://github.com/PerryLink/advisers/releases/tag/v0.5.0>. Verify the published release
yourself:

```sh
npm view advisers@0.5.0 dist.attestations --json --registry=https://registry.npmjs.org/
corepack pnpm install && corepack pnpm run sbom   # writes artifacts/sbom.cdx.json (gitignored)
node scripts/verify-release.mjs --version 0.5.0 --tag latest \
  --sbom artifacts/sbom.cdx.json --require-sbom
```

0.5.0 builds on the **"trustworthy delivery"** line (0.3.0: evidence that resolves or is
honestly marked missing/unverifiable, recoverable data, 200k-row ledgers, verifiable
provenance) and the 0.3.2 customer/performance closeout. The 0.4/0.5 additions are
documented per topic: [Windows support matrix](docs/WINDOWS.md), [MCP output caps + protocol
negotiation](docs/MCP.md), [200k read A/B and the write-amplification
fix](docs/PERFORMANCE.md), [read-only ledger facade](docs/LEDGER-READ-API.md),
[interface contracts](docs/CONTRACTS.md), [TUI output kernel](docs/TUI.md) and the
[release checklist](docs/RELEASING.md). Each release records its own `verify-release`
check count rather than inheriting an older figure.

> Requires **Node >= 22.16**. See [docs/QUICKSTART.md](docs/QUICKSTART.md) for Windows/PowerShell and BOM notes.

- `advisers` CLI: local REPL, `chat`, `office`, `template`, `routine`, `link`, `bridge`, `soul`, `ls`, `why`, `forget`, `export`;
- SQLite at `~/.advisers/state.db` (JSON fallback with `ADVISERS_STORE=json`);
- `IntentBrief` + clarification policy + readback;
- `advisers-office`: DOCX/XLSX/PPTX/Mermaid/draw.io/XMind builders + 7 generic templates + deterministic `template quote|proposal`; read/edit/verify;
- routine v0 (draft/approve/archive + patch/diff/apply);
- local agent loop with tools (`office_build`, `office_template`, `file_read/write/list`, `commitment_add`, `routine_view`, `search_turns`); attachments (txt/md/docx/xlsx/pptx/pdf); optional model with `ADVISERS_API_KEY`;
- turns + summaries + CJK-capable FTS search (FTS5 trigram index, schema v22; <3-character queries keep the LIKE fallback), `/memory`, `/week`, `/digest`, `/tick`, `/today`, `/undo`, `/diff`, `/learn review`;
- `advisers capture` extracts candidate commitments from Chinese work text with verbatim quotes. Candidates stay pending until you explicitly accept one; no command auto-accepts.
- `advisers research --web` / `--url` does cited research through DeepSeek server web tools. This is an explicit **web** egress path; web citations are provider output, not local file evidence.
- `advisers remind` + `.ics`/VALARM export + opt-in scheduler scripts; `calendar import --ics`; `capture --from-mail`/`--from-transcript` (read-only, deduped, pending candidates only);
- `advisers evidence show` / `deliveries --pack` (manifest + SHA256SUMS + DOCX receipt) / `deliver --type ...` (DOCX/XLSX); operator-entered manual evidence (`--quote`/`--evidence`) is typed as **unverifiable, not missing** — packs and receipts count it separately;
- **delivery receipt pack v1.1**: `advisers deliveries --receipt [--out dir] [--ids ...] [--all] [--recipient ...]` copies the delivered files and records every SHA-256, the generator, verify results and recipient; `advisers evidence verify <dir>` verifies a pack offline (JSON, exit 0/1, no `~/.advisers`). Evidence entries default to a 2000 cap (`--ids`/`--all` control it); the old `deliveries --pack` evidence pack is unchanged. See `docs/DELIVERY-RECEIPT.md`.
- **reminder/calendar wiring (0.2.0)**: `commit add/edit --remind-offsets "-1d,-2h,+0d09:00"` stores per-commitment VALARMs; `remind --deliver --notify` adds the opt-in webhook and records the last run in `~/.advisers/scheduler/status.json`; `remind install|uninstall|status [--apply]` prints a dry-run OS plan first and only registers a cron/schtasks entry with `--apply`; `today --calendar` expands RRULEs locally (all-day `全天`, recurring `（循环）`). `today`, `capture`, `memory candidates` and `verify` now have stable `--json` shapes (`docs/CLI-JSON.md`).
- `advisers privacy --prove`, `advisers mcp --stdio` (8 tools + 5 read-only resources, 1 MiB JSON-RPC line cap; candidate writes are pending-only and fail closed when the audit row cannot be written), `advisers ui`（本地只读视图）, and JSON output for status/commit/who/deliveries/remind/evidence.
- **0.2.3 product additions**: `matter add|ls|show|rename|archive|use` (client/project loop; `--matter` is validated on writes); `agenda --days 1..31 --json` (7-day Asia/Shanghai agenda with conflicts) and deterministic `morning` brief; `template quote|proposal` (DOCX/XLSX, integer-cent money, no model) with offline `verify --content --template quote|proposal --data`; `doctor --check-db` (FTS/WAL/backup/plaintext maintenance checks).
- `advisers pet-brief --json|--out [path]|--check [--strict]|--print-schema|--display-policy public|private|none` projects a **read-only, redacted** Pet Brief (contract v0.2: `schemaVersion: 2` + `displayPolicy`, default `private`; v0.1 briefs stay readable as legacy) for the desktop-pet consumer: `secrecy >= 2` matters excluded, facts below confidence 0.7 dropped, 5-minute TTL, 10-item caps; no model call, no network, no ledger writes. UI/transport is not wired yet. See `docs/PET-BRIEF-PRODUCER.md`.
- each turn sends a `latest_reminder` date/weekday/location/language marker so relative dates are grounded;
- thinking mode: `ADVISERS_THINKING=off|on|auto`, `ADVISERS_THINKING_EFFORT=low|high|max`; `reasoning_content` is kept in memory only for the current tool loop and is not written to turns/summaries/audit/export/backup. This does not control provider-side logs or OS crash dumps;
- DSH bundle (`dsh-advisers`) with six tools (`advisers_brief`, `advisers_office`, `advisers_today`, `advisers_who`, `advisers_evidence`, `advisers_clients`). Since 0.3.0 the three ledger read tools read the **real local ledger read-only** (TOS-gated, clearance 0, no HOME lock, no migration, no writes) and fall back to a marked preview only when no ledger exists or the facade is unavailable — see [docs/LEDGER-READ-API.md](docs/LEDGER-READ-API.md). Email/Feishu link packages are **libraries not wired into the CLI**; optional strict policy pack (see `packages/policy-strict/README.md`);
- Hermes bridge (`advisers-bridge-hermes`); published with the other five packages at the lockstep version;
- real-account/WS/Office-L3 validation still pending.
- **0.4.0 knowledge base**: `advisers kb add|ls|show|rm|purge|reindex|link` ingests local files as text + chunks (no copy of the originals) into schema v22; `search --scope turns|kb|pages|facts|all` keeps the legacy default, deterministic compiled pages (`kb page ls|show|rebuild|diff`: client/project dossiers, matter timelines, fact pages) carry source refs and staleness checks, and `fact show|history|as-of` is read-only time travel. No model, no embedding, no network; 1–2 character CJK queries use a degraded LIKE fallback instead of silently missing;
- **0.4.0 mail entry**: `mail account add|ls|show|test|remove`, `mail sync` (TLS-only, read-only IMAP with `UIDVALIDITY`/UID cursor), `mail ls|show`, `mail extract` (deterministic local rules, pending candidates only), `mail link|dismiss|purge`, and `.eml` import. Credentials live in a `0600` file (never in the DB/argv/logs), body retention defaults to 30 days, and `mail sync` is the only new network path;
- **0.4.0 interactive shell**: the `advisers` REPL gains completion, confirmation prompts, a bounded queue, in-memory history, bracketed-paste protection, Ctrl+C/Esc handling and whole-line sanitization; non-TTY input keeps the plain/one-shot behaviour and `tui --once/--json` stays byte-identical;
- **0.4.0 proactive briefs**: deterministic `urgency` v1 (`terms`/`whyNow`/`modelVersion`), archived `morning` briefs, a v2 scheduler plan/status readable across versions, and Standard Webhooks HMAC signing for the opt-in reminder webhook (payload bytes unchanged; quiet hours off by default and overridable);
- **0.4.0 policy/evidence subset**: pure policy decision engine, one-shot decision tokens with digest-checked execution, an egress registry, a separate TOS/model consent store (`consent.json`, 0600 atomic), and an evidence resolver with four honest states plus `mail`/`kb_chunk`/`kb_page` sources, so mail/KB references are no longer `missing`; receipt pack v2 records `verificationBasis`;
- **0.4.0 receivables**: `receivable add|ls|show|edit|void` + `payment add|ls|void` (integer minor units; CNY/USD/EUR/HKD; partial/multiple/over/void; auto-completes the linked commitment in the same transaction), per-currency totals (open/overdue/paid) and aging buckets; `client export --pack` writes a manifest + `SHA256SUMS` status pack with an offline verifier. Amounts stay out of receipt packs, the client status pack, MCP, DSH and Pet Brief;
- **0.4.0 MCP modern dual-era**: `server/discover`, an explicit modern-method allowlist and `resultType`/`ttlMs`/`cacheScope` envelopes for 2026-07-28 clients, while legacy responses stay byte-identical and `ADVISERS_MCP_MODERN=off` is a one-restart rollback; the tool surface remains 8 tools / 5 resources and DSH 6 tools;
- **0.4.0 Windows**: blocking `windows-full` CI (Node 24/22.16 matrix) and a portable-ZIP builder/verifier; npm remains the official channel, `docs/WINDOWS.md` scopes support to Windows 11 25H2/26H2 x64, and the real-machine record (36 known failures/skips at first run; CI runs on Windows Server 2025, not a Windows 11 client) stays a release-checklist item;
- **0.4.0 legal**: TOS/PRIVACY/SAFETY/DISCLAIMER are **v2026.11.4**; the new data planes (mail bodies/credentials, KB text and pages, receivables/payments, shell and brief archive) and the separate model-egress consent are disclosed, and gated commands re-confirm the revised terms;
- **0.4.1 follow-ups**: `kb link/unlink` and `mail link/dismiss` turn KB/mail references into explicit, audited review decisions (fail-closed on unknown ids); `remind --deliver --notify` gains runtime `--quiet-hours HH:MM-HH:MM` (cross-midnight; notification channel only — the local log line is always written), per-local-day notification dedupe (30-day local metadata retention) and `--force-notify`; the deterministic eval suite adds the `kb`/`mail`/`policy` groups (30 cases / 277 checks) and the CLI contracts add 38 documented-additive commands / 76 vectors behind a 90-check gate;
- **0.4.2 follow-ups**: `fact add <subject> <predicate> <object> --quote "evidence"` records manual facts (`authority=user`, `status=confirmed`, `confidence=1`) with optional `--matter`/`--valid-from`/`--source`/`--doc`/`--relation`/`--supersedes`, dedupes a repeated active identity and commits the fact + supersede chain + KB link + one `fact.add` audit row atomically (no quote => `E_USAGE`); `mail account test` is a read-only TLS/STARTTLS + LOGIN + CAPABILITY + EXAMINE probe (30s bound, no body fetch, no mail rows); `mail sync --watch` is an explicit foreground poll (rounds open/close the ledger, 5s-5min backoff, Ctrl+C stops after the in-flight round — no daemon, no IDLE); `sync pull --dry-run` predicts bootstrap/forced/plain/unchanged without writing the database, a backup, a temp file or an audit row; `doctor --check-db` appends the newest managed backup's age and hints at `advisers backup` past 7 days; subcommand `--help` prints its own usage and works before TOS acceptance. Additive only: no schema migration, no new runtime dependency, no frozen-contract change.
- **0.4.3 follow-ups**: `commit`/`receivable --due` accept Chinese relative dates
  (今天/明天/后天/周X/下周X/月底/季度末/N 天后, plus `YYYY-MM-DD` at 18:00 Asia/Shanghai)
  and fail with `E_DUE_UNRESOLVED`/`E_DUE_CONFLICT` instead of storing raw text; keyless
  `capture` now runs the local rules by default (`--file -` reads stdin,
  `--rules`/`--local` force offline, `[local]` note, pending only) and `inbox ls|show` is
  a read-only, clearance-filtered review view; `doctor --report` emits explicit `null`
  quality dimensions with reasons, `privacy --prove --brief` a four-line data-flow card and
  `profile show|export` a deterministic read-only preferences projection (0600 export,
  `dataSha256`); `remind --ics` emits `VTIMEZONE` + `TZID` + commitment ids and
  `remind --deliver --notify` adds a per-commitment 24h cooldown (`--force-notify` bypasses;
  the local log is always written); quote/proposal `schemaVersion: 2` adds validated
  `payment.channels[]` (bank/wechat/alipay/stripe_link/wise_link, masked accounts, https
  provider links) and `receivable export --csv` writes a 16-column RFC 4180 file (explicit
  `--out`, 0600, `--bom`, `--json` metadata only); `--help` is a global no-side-effect
  short-circuit; `mail sync --watch` has `--json`/`--json-lines` and the 0/1/130/143 exit
  set. Additive: no schema migration, no new runtime dependency, no frozen-shape change
  (five new codes in the additive error registry).
- **0.5.0** — portable, disclosable, verifiable:
  - **portable bundle v1**: `export --bundle <dir>` writes a plaintext directory
    (`manifest.json` + `ledger.json` + `facts.md` + `kb/` + `pages/` + `IMPORT.md` +
    `SHA256SUMS`); `import --bundle <dir> --verify` bootstraps a clean home or
    replaces a populated one with a pre-import managed backup; the acceptance metric
    is `dataDigest`/counts parity. No credentials, `audit.key`, scheduler, logs,
    soul or workspace travel; **bundle v1 is plaintext** (encryption is a later
    opt-in). See [docs/PORTABILITY.md](docs/PORTABILITY.md).
  - **context pack v1**: `context-pack create --subject client:<id>|matter:<id>`
    lists read-only candidates (secrecy filtered before counting, exclusion counts
    by reason); the write path needs explicit `--ids` or `--yes` plus
    recipient/purpose/expiry. `context-pack verify` is offline (exit 0/1), there is
    no import path, and `confersReadAuthority/confersExecutionAuthority` are always
    false. Amounts, mail bodies, KB full text and file paths never enter a pack.
    See [docs/CONTEXT-PACK.md](docs/CONTEXT-PACK.md).
  - **disclosure**: the five MCP read tools and five resources gain an additive
    `disclosure` block and per-row `view`; tool/resource counts stay 8/5 (DSH
    6) and stripping the new fields reproduces the 0.4.3 payload. DSH is always
    `audited:false` because it does not write the local audit chain.
  - **sync v2**: snapshots record `dbMtimeMs/dbSha256/sourceSchemaVersion` (v1 still
    readable); `sync.state.json` records the last push/pull; `sync push --dry-run`
    is now genuinely write-free; push/pull refuse a proven stale overwrite
    (`E_SYNC_CONFLICT`) unless `--force`; `sync status --check` reports
    conflict/localChanged/remoteAdvanced. Last-writer-wins on the whole database is
    **still** the transfer semantics (no merge).
  - **onboarding and safety**: `setup` (7-step, idempotent, non-TTY matrix, TOS gate
    leaves HOME byte-empty on refusal), `demo` (isolated synthetic "one consulting
    delivery", zero model/network; demo steps use an isolated temp home, while
    the CLI's TOS gate still applies), `help <topic>` (10
    topics + Chinese aliases, byte-identical alias pages), fail-closed managed
    backups before purge/merge/import, and `doctor --check-db --json` backup
    freshness. No background daemon, no new network path.

```sh
# 0.5.0 was published on 2026-11-22 (npm `latest` = 0.5.0; `next` also points at 0.5.0).
# Run from the checkout (development; the same 0.5.0 version):
git clone https://github.com/PerryLink/advisers.git
cd advisers && corepack pnpm install && corepack pnpm -r build
ADVISERS_OFFICE_LOCAL=1 node packages/advisers/bin/advisers.js status
# From npm (stable channel = default `latest`, now 0.5.0):
#   npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
# The `next` channel also points at 0.5.0:
#   npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers
# or one-shot:
advisers chat "做一份 Q4 汇报 PPT，放到 out/q4.pptx"
advisers brief "做一份 Q4 预算 Excel，周五前给老板"
advisers template weekly data.json weekly.docx
advisers office docx spec.json out.docx
advisers bridge --dir "$BRIDGE_DIR"   # Hermes gateway bridge
# 0.5.0 evidence chains (run from the checkout with a temp HOME):
#   ADVISERS_HOME=$(mktemp -d) ADVISERS_ACCEPT_TOS=1 \
#     node packages/advisers/bin/advisers.js export --bundle /tmp/bundle --json
#   node packages/advisers/bin/advisers.js import --bundle /tmp/bundle --verify --dry-run --json
#   node packages/advisers/bin/advisers.js context-pack create --subject client:<id> --json
```

Local interaction: `advisers` starts an interactive shell (REPL); `/help` lists the commands, and the shell keeps confirmations, a bounded queue and paste protection. With an API key the model can call local Office/file tools and report the generated paths. File writes are confined to the working directory, overwrites require confirmation unless `ADVISERS_FORCE=1`, and local tools do not send file contents to the model unless you attach/read them.

npm tags: **`latest`** is the stable channel (**`0.5.0`**, published 2026-11-22),
**`next`** is the pre-release channel (also `0.5.0`). `0.2.4` was a
never-published candidate superseded by the 0.3.0 line — it is not installable from npm.
`0.5.0` supersedes `0.4.3`/`0.4.2`/`0.4.1`/`0.4.0`/`0.3.2`/`0.3.1`/`0.3.0`: earlier tarballs stay
installable by pinning but ship stale docs and cannot be repaired in place (npm unpublish
needs the owner's 2FA). `0.5.0` is the current feature release.
Pin an exact version (`advisers@0.5.0` today) when you need a reproducible install, and
query the official registry directly
(`npm view advisers dist-tags --registry=https://registry.npmjs.org/`) — mirrors can lag
behind.

## Security boundary

- Local-first by default: no telemetry; no network calls without an API key or a configured link provider.
- `research --web` / `--url` is the only built-in **web** egress command; it requires an explicit flag and refuses matters with `secrecy > 0` (fail closed until the 0–3 secrecy levels are productized).
- When `ADVISERS_API_KEY` is set, model-backed commands (`chat`, `capture`, `review`, `brief --deep`, `learn review`) send their inputs to the configured model API; local-only commands (`status`, `office`, `template`, `verify`, `commit add`, `tick`) do not.
- Audit is a **local hash chain plus, since 0.3.0, an optional local tail anchor** (`audit-anchor.json` + `audit --expect-head`), not a third-party attestation or timestamp: it detects edits to its own rows and (with an anchor) tail deletion, not a compromised host.
- Office verification checks structure and deterministic content signals; it does not prove factual correctness.
- Portable bundles are **plaintext** (checksum-only, `verificationBasis: local-checksums-only`)
  and contain customer/mail/money PII from the source home; store them on an encrypted
  disk and do not share them. Encryption is not part of bundle v1 in 0.5.0.
- Snapshot sync is different: snapshots are AES-256-GCM encrypted with a passphrase you
  supply (`ADVISERS_SYNC_PASSPHRASE`); the sync directory itself is whatever storage you
  already replicate, and the whole database transfers (last-writer-wins).
- Bundle/context-pack checksums prove internal consistency only — not a signature, a
  trusted timestamp, proof of authorship or compliance certification. Treat
  `verified` as "the local evidence pointer resolved", never as "the record is true".

## License

Advisers is **source-available, not open source**. From `0.2.0` the licenses are split
(neither is retroactive):

- **Software** — `packages/**`, `scripts/**`, `.github/**`, package manifests, and the
  README/NOTICE/THIRD-PARTY-NOTICES shipped in npm tarballs:
  [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)
  (SPDX: `PolyForm-Noncommercial-1.0.0`). Noncommercial use only; use by or for a
  for-profit organization requires a separate commercial license.
- **Documentation, data and design** — root docs, `docs/**`, `eval/**`, `examples/**`,
  `templates/**`: [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
  (SPDX: `CC-BY-NC-SA-4.0`). Attribution, noncommercial use and ShareAlike apply.

Prior releases keep the licenses they were published under: MIT releases stay MIT and
releases published under Apache-2.0 before `0.2.0` (up to the 2026-11-17 preview) stay
Apache-2.0. See [LICENSE](LICENSE),
[LICENSE-DOCS](LICENSE-DOCS), [NOTICE](NOTICE) and [LICENSING.md](LICENSING.md) for the
definitive policy, required notices and the commercial-licensing channel.

Advisers is an independent core, not coupled to the famling desktop pet.
