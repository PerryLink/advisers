# Quickstart (Windows + PowerShell)

> Current status: **`0.5.1` was published on 2026-11-24** and is the npm `latest`
> (`next` is also `0.5.1`). The repository is lockstep at package version `0.5.1`.
> `0.5.1` is a follow-up patch on the 0.5.0 tree: **one** database schema jump
> (**v22 -> v23**: facts claim/evidence columns, mail thread columns, `waiting_replies`
> and the handoff tables), read-only **mail follow-up** (`mail followup
> add|ls|check|show|dismiss|mark-replied`, header-only, no send/network/MCP), a
> **verifiable exit drill** (`scripts/bundle-drill.mjs`) with one-command acceptance
> (`import --bundle --verify --expect-dataDigest <hex>`) and an in-bundle `FORMAT.md`,
> **context-pack issuance audit** (`context_pack.create`) plus host-side MCP
> `advisers_pack_verify` format dispatch, and **release-level quality evidence**
> ([docs/QUALITY.md](QUALITY.md), `check-release --eval-evidence`). No new network
> path and no new runtime dependency; MCP stays 8 tools / 5 resources and DSH 6 tools.
> `0.5.0` was the "portable, disclosable, verifiable" release: portable home
> **bundle v1**, the offline-verifiable **context pack v1**, additive **MCP/DSH
> disclosure**, **sync snapshot v2** with `sync.state.json` and conflict precheck,
> `setup`/`demo`/`help <topic>` onboarding, fail-closed managed backups and the
> report-v2 quality gate.
> The 0.4.0 feature surface is unchanged: the local knowledge base (KB), TLS-only
> read-only IMAP mail entry (`mail ...`), the interactive shell, proactive
> urgent-first briefs, the policy/evidence 2.0 subset (separate model-egress
> consent), receivables/payments plus client status packs, MCP modern dual-era,
> Windows CI plus an offline portable ZIP, and the **v2026.11.4 (2026-11-21)** legal
> revision (v2026.11.5 is a separate legal decision and not part of 0.5.1). Defaults
> stay local: no new command requires a model call, there is no background daemon,
> and `mail sync` is the one explicit network path (TLS-only, read-only, user-invoked).
> **Schema v23 is a one-way migration**: the first command that opens a v22 ledger
> writes a `state.db.before-migrate-v22-*` backup and upgrades; a 0.5.0 binary opening
> a v23 database fails with `E_SCHEMA_NEWER`, so going back means restoring that
> backup (or `export --bundle` before upgrading). Old mail rows are not retrofitted
> and are reported `unknown` by `mail followup`. `0.5.0`, `0.4.3`, `0.4.2`, `0.4.1`,
> `0.4.0`, `0.3.2`, `0.3.1` and `0.3.0` remain installable by pinning but are
> superseded. The earlier `0.2.4` was an **unpublished release candidate** superseded
> by the 0.3.0 line (its `v0.2.4` tag points at an older commit, there is no 0.2.4
> tarball on npm, so do not try to install it). Stable-channel install:
> `npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest`.
> Release notes: <https://github.com/PerryLink/advisers/releases/tag/v0.5.1> (the
> release carries the CycloneDX SBOM, `SHA256SUMS` and the release-quality report;
> the Windows portable ZIP and its `SHA256SUMS-0.5.1-portable.txt` are the offline
> channel and are attached by the release operator — verify the ZIP hash/attestation
> before use, see [docs/WINDOWS.md](WINDOWS.md) §3.4). The `0.5.1` tarballs are
> published from GitHub Actions OIDC/Trusted Publishing with SLSA provenance; from a
> checkout (after `corepack pnpm run sbom`),
> `node scripts/verify-release.mjs --version 0.5.1 --tag latest --sbom artifacts/sbom.cdx.json --require-sbom`
> verifies the registry release (that gate covers the npm tarballs, not the portable
> ZIP). The checkout sections below remain the development path.

> **Before you start** — read the [Terms of Service](TOS.md) (v2026.11.4,
> effective 2026-11-21), [Disclaimer](DISCLAIMER.md), [Safety & content review](SAFETY.md),
> and [Privacy & data-flow notice](PRIVACY.md). AI output can be wrong; illegal,
> infringing, deceptive, or unlabeled synthetic content is prohibited.
>
> The first time you use a gated command (anything except the local-only exempt surface:
> `help`, `--help`/`-h` (a global no-side-effect short-circuit), `--version`, `status`,
> `doctor`, `init`, `tos ...`, `privacy`, `export`,
> `audit`, `purge`, `backups` and the offline `evidence verify <dir>`), Advisers shows a
> short Terms summary and asks
> you to accept by typing 同意 (`y`/`yes` is a shortcut; Enter or `n` rejects). Non-interactive
> environments must pass `--accept-tos` or set `ADVISERS_ACCEPT_TOS=1`; without them a gated
> command exits with code 3 and a single `E_TOS_REQUIRED` line on stderr while stdout stays
> machine-readable. Continuing to run, pressing Enter, or keeping the default is not
> acceptance. The acceptance record (version, text SHA-256, time, channel) is written to
> `%ADVISERS_HOME%\tos.json` (0600) and the local audit chain: check it with
> `advisers tos status`, read the full text with `advisers tos show`, and withdraw with
> `advisers tos revoke`. Changing the persona (`soul set`/`soul init`), routines or the
> ledger (`import --replace`) asks for a fresh confirmation each time.
>
> **Model egress is a separate consent.** Accepting the terms does not authorise sending
> content to a model provider. The opt-in model surfaces new in 0.4.0 — today
> `mail extract --model` (model-backed `kb ask` is not wired in 0.4.0) — also need a
> data-class consent record in `%ADVISERS_HOME%\consent.json` (0600): check it with
> `advisers consent status`, grant it with
> `advisers consent grant mail.extract --data-class mail`, and withdraw it with
> `advisers consent revoke mail.extract --data-class mail`. The record is bound to the
> configured provider/base URL, so changing `ADVISERS_PROVIDER`/`ADVISERS_BASE_URL`
> invalidates it; a TTY prompts for a typed confirmation and non-interactive runs need
> `--yes`. TOS consent alone is never treated as model-egress consent. See
> [docs/PRIVACY.md](PRIVACY.md) §4 and [docs/SECURITY.md](SECURITY.md) §8.

## Requirements

- Node **>= 22.16** (Node 24 recommended). `node:sqlite` is unavailable before 22.13 and lacks FTS5 on 22.13–22.15; the default SQLite ledger needs 22.16+.
- `pnpm` 12.x (`corepack enable`)
- Windows Terminal + PowerShell 7 recommended (PowerShell 5.1 works with the BOM note below)
- Optional: DeepSeek-compatible API key for natural-language tasks and model-generated commitments

```powershell
node -v      # must be >= 22.16
npm -v
```

## A. Run from checkout (works today)

```powershell
git clone https://github.com/PerryLink/advisers.git
cd advisers
corepack pnpm install
corepack pnpm -r build

$env:ADVISERS_HOME = Join-Path $env:TEMP ("advisers-" + (Get-Date -Format yyyyMMdd-HHmmss))
$env:ADVISERS_OFFICE_LOCAL = "1"   # checkout-only wiring for the office package
$A = Join-Path $PWD "packages\advisers\bin\advisers.js"

node $A status
node $A tos status --json   # first-run consent record + audit state
node $A init
node $A doctor
node $A soul init
node $A brief "做一份 Q4 预算 Excel，周五前给老板"
```

### Build one artifact

JSON must be UTF-8 **without BOM**. PowerShell 5.1 `>` writes UTF-16/BOM and will crash the CLI.

```powershell
$weekly = '{"period":"2026-W46","done":["完成 A 客户报价"],"risks":["B 项目排期紧"],"next":["交付 Q4 预算表"]}'
[IO.File]::WriteAllText((Join-Path $PWD "weekly.json"), $weekly, (New-Object System.Text.UTF8Encoding($false)))

node $A template weekly examples/templates/weekly.json out\weekly.docx
node $A verify out\weekly.docx
Start-Process .\out\weekly.docx
```

### Commitment loop

```powershell
$due = (Get-Date).AddHours(4).ToString("yyyy-MM-ddTHH:mm:sszzz")
node $A commit add "周五前发报价给王工" --quote "周五前发报价给王工" --due $due
node $A commit ls
node $A today
node $A tick
node $A who
```

`today` gives the one-screen buckets; `tick` covers the next 7 days; "今天到期" is only shown when the due date is today in Asia/Shanghai.

### Model key (optional)

```powershell
$env:ADVISERS_API_KEY = "sk-..."       # PowerShell syntax; not VAR=value
# $env:ADVISERS_BASE_URL = "https://api.deepseek.com"
node $A research --web "2026 年独立顾问市场要点"   # explicit egress
node $A capture --source meeting "周五前把报价发给王工，我周五前发"
node $A memory candidates
node $A chat "做一份 Q4 汇报 PPT，放到 out\q4.pptx"
```

## B. Installed CLI (stable channel = 0.5.1, published 2026-11-24)

```powershell
# Stable channel: npm @latest resolves to 0.5.1 (published 2026-11-24).
npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
# Pre-release channel: `next` also resolves to 0.5.1.
# npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers --version    # expect 0.5.1
advisers status
advisers soul init
advisers template weekly weekly.json out\weekly.docx
advisers verify out\weekly.docx
```

### Upgrade (schema v22 -> v23 from 0.5.0; v21 -> v22 from the 0.4 line)

```powershell
npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
advisers --version            # expect 0.5.1
advisers doctor               # first ledger open migrates after a verified pre-migration backup
advisers doctor --check-db    # full DB / FTS / WAL checks on the migrated database
```

0.5.1 upgrades a 0.5.0/v22 ledger to **v23** in one transaction on the first command
that opens it (you do not run a migration command). It adds the facts claim/evidence
columns, mail thread columns, `waiting_replies`, the handoff tables and five nullable
reserved 0.6 acceptance/payment-proof columns, and writes a
pre-migration copy (`%ADVISERS_HOME%\state.db.before-migrate-v22-<ms>`) that is verified
before upgrading. The 0.4-line v21 -> v22 step is applied first when needed, one step at
a time. **Downgrade is not supported**: a 0.5.0 binary opening a v23 database fails with
`E_SCHEMA_NEWER`. Going back means restoring that pre-migration copy
(`advisers restore <backup> --dry-run` then `--yes`), or `advisers export --bundle <dir>`
before upgrading and `import --bundle --verify` into a fresh home on the old version.
Mail rows synced before the upgrade keep no thread headers and `mail followup` reports
them `unknown`; they are not back-filled.

> `0.2.4` never reached npm and must not be presented as installable. `0.5.0`/`0.4.3`/
> `0.3.2`/`0.3.1`/`0.3.0` are superseded by `0.5.1` and remain installable by pinning.
> The 0.5.1 release notes (<https://github.com/PerryLink/advisers/releases/tag/v0.5.1>)
> and `scripts/verify-release.mjs` are the provenance record.

If `advisers-office` is missing, install it explicitly (`advisers-office@latest`, or
`@next` before promotion); the CLI does not pull it automatically.

## C. Troubleshooting

| Symptom | Fix |
|---|---|
| `No such built-in module: node:sqlite` / `no such module: fts5` | Node < 22.16; install Node 24 LTS |
| `advisers-office is not installed` | `npm i -g advisers-office@latest` (`@next` before promotion), or set `ADVISERS_OFFICE_LOCAL=1` from checkout |
| `SyntaxError: Unexpected token '﻿'` | JSON has BOM; write UTF-8 without BOM |
| Chinese output is garbled | `chcp 65001`; use Windows Terminal |
| `model HTTP 401` | Key/base URL wrong; set `ADVISERS_API_KEY`, check `advisers status` |
| Command not found after `npm i -g` | Open a new terminal so PATH refreshes |

## Data & privacy

- Data: `%USERPROFILE%\.advisers\` unless `ADVISERS_HOME` is set. No telemetry, no account,
  no operator cloud service; the local database is **not encrypted by default**.
- `advisers export` contains raw conversations/preferences — do not share it. Migration,
  sync and import backups (`state.db.before-*`, `import-backup-*.db`) and `undo` copies are
  not cleaned up automatically and contain the full database.
- 0.4.0 adds local data planes, all **plaintext by default** unless `vault seal` is on:
  KB extracted text and compiled pages (the source file is not copied), mail metadata and
  bodies (default 30-day retention), receivables/payments rows, the morning-brief archive
  (`%ADVISERS_HOME%\briefs\`, 14-day default), and the shell's in-memory history (never
  written to disk). IMAP passwords and model-egress consent are separate 0600 files under
  `%ADVISERS_HOME%\credentials\imap\` and `%ADVISERS_HOME%\consent.json` — never in the
  database, exports, backups, argv or logs.
- Egress: model commands (`chat`, `capture`, `review`, `brief --deep`, `learn review`,
  `mail extract --model` after its separate consent) send context to the configured API —
  **DeepSeek (`https://api.deepseek.com`) by default**; `mail sync` (the new `mail`
  entry point) and the legacy `capture --from-imap` connect to your configured IMAP server
  (TLS-only, read-only); `research --web|--url`, `ADVISERS_NOTIFY_WEBHOOK`, `sync`,
  MCP/DSH/desktop-pet consumers and your own external commands can also leave the machine.
  Local-only commands (`status`, `office`, `template`, `verify`, `commit`, `kb ...`,
  `mail ls/show/import/extract --local`, `receivable`/`payment`, `fact`) do not egress.
- Read [docs/PRIVACY.md](PRIVACY.md) for the full data-flow, deletion limits (`purge` is a
  partial delete; `forget` keeps a tombstone) and your own obligations when processing
  other people's personal information.

## E. Reminders (local, opt-in)

```powershell
node $A remind                     # due now/next 7 days
node $A remind --json              # scripts
node $A remind --ics out.ics       # import into Google/Outlook/system calendar
node $A remind --deliver --notify  # local log + best-effort notification
node $A remind install             # write opt-in scheduler scripts, print instructions
```

`remind install` does **not** silently register a daemon or OS task; it writes
`~/.advisers/scheduler/remind.sh` / `remind.ps1` and a README. Calendar import is
the most portable notification path. See `docs/REMINDERS.md`.

## F. Read-only imports (no write-back)

```powershell
node $A capture --from-mail .\mail.eml
node $A capture --from-mail .\maildir\ --limit 20
node $A capture --from-transcript .\meeting.vtt
node $A calendar import --ics .\calendar.ics
node $A today --calendar
```

All commitments stay **pending** until `advisers memory accept <id>`. Secret
matters (`secrecy > 0`) fail closed before any model/network call. Re-importing
the same mail/transcript is deduplicated for 30 days. See `docs/SOURCE-SCHEMA.md`.

## G. Evidence and delivery

```powershell
node $A evidence show <cm_...> --json
node $A deliveries --pack --out .\evidence
node $A deliver --commit <cm_...> --type confirmation --out .\confirm.docx
node $A deliver --type ledger --out .\commitments.xlsx
```

`deliveries --pack` writes `manifest.json`, `README.txt`, `SHA256SUMS` and a
`receipt.docx`. SHA256SUMS is tamper-evidence, not a signature. See
`docs/CLI-JSON.md` for machine-readable output and `docs/SOURCE-SCHEMA.md` for
source references.

## H. Privacy and MCP

```powershell
node $A privacy --prove
node $A mcp --stdio        # JSON-RPC over stdio: initialize/tools/list/tools/call
```

## I. Read-only IMAP (opt-in)

```powershell
$env:ADVISERS_IMAP_HOST = "imap.example.com"
$env:ADVISERS_IMAP_USER = "me@example.com"
$env:ADVISERS_IMAP_PASS = "app-password"   # never written to disk by Advisers
node $A capture --from-imap --limit 20
```

The client only sends `LOGIN`, `EXAMINE`, `UID SEARCH`, `UID FETCH
(BODY.PEEK[])` and `LOGOUT`; it never sends STORE/APPEND/EXPUNGE/COPY/MOVE.
Use an app password, not your primary password. Environment variables are
read per process and are not logged.

## J. Encrypted handoff

```powershell
$env:ADVISERS_EXPORT_PASSPHRASE = "at least 8 chars"
node $A export --all --encrypted --out handoff.enc.json
node $A import handoff.enc.json --replace
```

AES-256-GCM + scrypt; passphrase is not stored. See `docs/ENCRYPTED-HANDOFF.md`.
This is an encrypted handoff/backup, **not** automatic at-rest database encryption.


## K. Local OCR (optional, no cloud)

```powershell
$env:ADVISERS_OCR_CMD = "C:\tools\tesseract.exe"   # local executable
node $A ocr .\scan.png --out scan.txt
node $A capture --file .\scan.png                    # image attachment uses the same adapter
```

Without `ADVISERS_OCR_CMD`, image OCR fails closed. No cloud OCR is called.

## L. Vault mode (encrypted database at rest)

```powershell
$env:ADVISERS_VAULT_PASSPHRASE = "at least 8 chars"
node $A vault seal --remove        # ciphertext in state.db.vault, plaintext removed
node $A vault status
node $A vault unseal               # restores state.db (SHA256 verified)
```

Explicit opt-in; not transparent/automatic. See `docs/AT-REST-VAULT.md`.

## M. Timestamp / TUI

```powershell
$env:ADVISERS_TIMESTAMP_CMD = "C:\\tools\\tsa-client.exe"
node $A timestamp .\\evidence\\manifest.json --out proof.txt
node $A tui --once        # read-only dashboard snapshot
```

Both are local/no-cloud; the timestamp adapter is opt-in and fails closed when
unset. The TUI is read-only; all writes stay in CLI commands.

## N. File-based encrypted sync (optional)

```powershell
$env:ADVISERS_SYNC_PASSPHRASE = "at least 8 chars"
node $A sync push --dir .\Sync\advisers --device laptop
node $A sync status --dir .\Sync\advisers
node $A sync pull --dir .\Sync\advisers
```

Encrypted whole-DB snapshots in a **user-provided** folder; no Advisers server,
no merge, last-snapshot-wins. See `docs/SYNC.md`.

## O. 0.3.0 additions (carried unchanged by 0.3.1 and 0.3.2)

These landed on the 0.3.0 release tree (0.3.1/0.3.2 carry them unchanged) and are also
exercised from a checkout. They are documented as 0.3.0 surfaces:

```powershell
# MCP: legacy protocol negotiation (2024-11-05 / 2025-06-18 / 2025-11-25) + capped list output
# (today/commit_ls/remind now return total/truncated instead of CONTENT_BLOCKED on a big ledger)
@(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
) | node $A mcp --stdio

# interface contracts (CLI read models/errors/exit codes/MCP); offline, temp home
corepack pnpm check:contracts

# deterministic eval suite (no API key, no network)
corepack pnpm eval:det

# 200k read benchmark: write-byte budget, not wall-clock gates (Linux for writeBytes)
node scripts/bench-read-200k.mjs --home (Join-Path $env:TEMP "advisers-bench") --seed
node scripts/bench-read-200k.mjs --home (Join-Path $env:TEMP "advisers-bench") --reps 3
```

Recovery and audit-anchor commands (0.3.0/0.3.1 tree; **not in 0.2.3**):

```powershell
node $A backup --dry-run                     # managed backup plan (no backup file written)
node $A backup --keep daily=7,weekly=4,monthly=3 --apply   # rotate managed backups only
node $A backups ls
node $A backups verify                       # FAIL -> exit 1
node $A restore <backup-name> --dry-run      # plan by default; add --yes to apply
node $A audit                                # chain status + anchor: match|absent|grown|FAIL
node $A audit --write-anchor                 # record/refresh the local tail anchor
node $A doctor --repair --dry-run            # --only lock,temp,wal,fts
```

These are local-only (no network). The anchor is a local file (not a third-party
timestamp); `restore` refuses an anchor-behind backup unless you pass
`--allow-anchor-behind`, and `doctor --repair` takes a safe backup before applying.

DSH users: `packages/dsh-advisers` reads the real local ledger read-only (TOS-gated,
clearance 0, no HOME lock/migration/writes) and falls back to the marked preview only when
no ledger exists or the facade is unavailable. See `docs/LEDGER-READ-API.md` and
`docs/MCP.md` §1.3. The console-safe bin wiring (`--plain`/`--accessible`/`--color`
policy, plain output on a pipe, sanitized webhook/IMAP text) and the 0.4.0 interactive
shell are delivered; `advisers tui --once` remains the read-only dashboard snapshot
rendered through the output kernel. The 0.4.0 shell contract is in [docs/TUI.md](TUI.md) §13–§14.

## P. 0.4.0 additions: KB, mail, shell, receivables, consent

### Knowledge base (local, no model, no network)

```powershell
node $A kb add .\docs\客户A周报.md --title "客户A周报" --client cl_123 --json
node $A kb add --from list.txt --json                 # batch from a newline-separated path list
node $A kb ls
node $A kb show kb_... --chunks 5                      # metadata by default; chunks on demand
node $A kb search 官网改版 --scope kb                  # 3+ chars: FTS5 MATCH
node $A search 官网改版 --scope all                    # turns+facts+pages+KB compatibility view
node $A kb page rebuild && node $A kb page ls          # deterministic client/project/timeline/facts pages
node $A kb rm kb_...                                   # tombstone (no longer searchable)
node $A kb purge kb_... --yes                          # physical delete
node $A kb reindex --rebuild                           # verify/rebuild the KB FTS indexes
node $A fact show <fact-id>
node $A fact history <fact-id>
node $A fact as-of 2026-11-01
```

`kb add` stores the **extracted text** in the local ledger (schema v23 since 0.5.1) and does not copy
the source file. Nothing here calls a model or the network; a 1–2 character CJK query takes
the degraded `LIKE` path and reports it, and image-only files are marked `needsOcr` instead
of being silently indexed. See [docs/KB.md](KB.md).

### Mail (local import offline; IMAP is the one explicit network path)

```powershell
# 1) Offline first: .eml / .mbox, no account and no network
node $A mail import .\mail\ --json
node $A mail ls --json
node $A mail extract <msg-id> --local --json          # deterministic local rules -> pending candidates
node $A mail show <msg-id> --body --json

# 2) IMAP: one explicit, read-only, TLS-only network entry
node $A mail account add --name work --host imap.example.com --port 993 --tls tls --user me@example.com
#    TTY: hidden password prompt; CI/pipe: ... --pass-stdin  (password never in argv)
node $A mail account ls
node $A mail sync --limit 50 --json                   # EXAMINE + FETCH BODY.PEEK[] only
node $A mail sync --dry-run --json
node $A mail purge --older-than 30d --dry-run          # then --yes; bodies go, metadata/hash stay
```

`mail sync` is the only new network path in 0.4.0: TLS-only (993 implicit or STARTTLS),
read-only, user-invoked, restart-safe via UIDVALIDITY/UID; it never deletes server mail and
fails closed when UIDVALIDITY changes. The password goes to
`%ADVISERS_HOME%\credentials\imap\<account>.json` (0600, directory 0700, atomic write) and
never enters the database, exports, backups, argv or logs. Local extraction creates
**pending** candidates only; `mail extract --model` is opt-in and needs `--yes` plus an
API key plus the separate `mail.extract` consent. Data flows are listed in
[docs/PRIVACY.md](PRIVACY.md) §4.

### Interactive shell (TTY only)

```powershell
node $A                 # TTY: status line + readline shell; Ctrl+C twice quits, Esc cancels a pending line
node $A --plain         # plain/accessible output policy (also --accessible, NO_COLOR, TERM=dumb)
```

Inside the shell: `/help`, `/status`, `/history`, `/resume <n|id>`, `/new`, `/clear`,
`/retry`, `/verbose`, `/more` and the read-only `/today`, `/remind`, `/who`, `/client`,
`/evidence <id>`. Business writes stay in the CLI (the shell prints the exact command);
piped/non-TTY stdin keeps the old one-shot/plain behaviour, and `ADVISERS_NO_SHELL=1` falls
back to the pre-0.4 REPL. Input history is process memory only.

### Receivables and payments (local money sidecar, no payment rails)

```powershell
node $A receivable add cl_123 "官网改版尾款" --amount 8000.00 --currency CNY --due 2026-12-15 --remind-offsets "-3d,-1d" --json
node $A receivable ls --aging --json
node $A receivable show rcv_... --json
node $A payment add cl_123 --amount 4000.00 --method bank --receivable rcv_... --json
node $A payment ls --json
node $A receivable void rcv_... --reason "客户取消" --json
```

Amounts are decimal strings stored as **integer minor units** in the four quote currencies
(CNY/USD/EUR/HKD); partial/multiple payments, overpayment and void are supported, and a
settled receivable auto-completes its linked commitment in the same transaction. `receivable
ls` reports per-currency totals and aging buckets. These are **not** invoices, statements,
receipts, tax records or a payment rail; no FX and no cross-currency totals. See
[docs/CLIENTS.md](CLIENTS.md) §11.

### Consent (model egress is separate from TOS)

```powershell
node $A consent status --json
node $A consent grant mail.extract --data-class mail --json     # TTY asks for a typed confirmation
node $A consent revoke mail.extract --data-class mail --json
node $A privacy --matrix --json                                  # surface/action/gate matrix
```

`consent.json` (0600, atomic) records one row per surface + data class + provider (+ base
URL). A changed provider/base URL invalidates the row; revocation keeps the audit row and
never re-grants implicitly. TOS acceptance is not model-egress consent, and not accepting
the TOS never substitutes for the separate consent. See [docs/SECURITY.md](SECURITY.md) §8.

### MCP modern dual-era and the Windows portable ZIP

`advisers mcp --stdio` still speaks the legacy protocol (`initialize` echo) and now also
implements the modern `2026-07-28` era behind per-request `_meta`:
`server/discover`, `resultType`/`ttlMs`/`cacheScope` envelopes and mapped error codes;
`ADVISERS_MCP_MODERN=off` is a one-restart rollback. The tool/resource catalogue is
unchanged (8 tools / 5 resources). For offline Windows installs, see
[docs/WINDOWS.md](WINDOWS.md) §3.4 (portable ZIP + its own SHA-256/attestation).
## Q. 0.5.0/0.5.1 additions: bundle, context pack, sync v2, mail follow-up, releases

### Portable home bundle (plaintext, importable)

```powershell
# Export the whole home (TOS-exempt read; choose an encrypted disk)
node $A export --bundle C:\temp\home-bundle --json
# Verify on the target machine without writing anything
node $A import --bundle C:\temp\home-bundle --verify --dry-run `
  --expect-dataDigest <64-hex dataDigest from the source export> --json
# Import into a clean home (a populated target needs --replace)
$env:ADVISERS_ACCEPT_TOS = "1"
node $A import --bundle C:\temp\home-bundle --verify --json
```

A bundle is a **plaintext** directory (`manifest.json`, `ledger.json`, human-readable
projections, `IMPORT.md`, `FORMAT.md` in 0.5.1+, `SHA256SUMS`); it contains no
credentials/`audit.key`/soul/workspace. `--expect-dataDigest` turns the acceptance check
into one pass/fail (mismatch = `E_BUNDLE_TAMPERED`, zero writes). A 0.5.1 bundle is not
readable by the 0.5.0 CLI; 0.5.0 bundles are readable by 0.5.1. Store it on an encrypted
disk and do not share it. See [docs/PORTABILITY.md](PORTABILITY.md).

### Context pack (bounded, one-way disclosure)

```powershell
node $A context-pack create --subject client:cl_123 --json        # candidates only (read-only)
node $A context-pack create --subject client:cl_123 --ids cm_1,fact_2 `
  --recipient "Acme review" --purpose external-review --out C:\temp\pack --json
node $A context-pack verify C:\temp\pack --json                   # offline, exit 0/1
```

0.5.1 records one local `context_pack.create` audit row per written pack (ids and a
salted recipient hash only) and lets MCP `advisers_pack_verify` verify a received pack
offline. Packs are not importable, never contain amounts/mail bodies/KB full text, and
`confersReadAuthority`/`confersExecutionAuthority` are always false. See
[docs/CONTEXT-PACK.md](CONTEXT-PACK.md).

### Sync snapshot v2 (encrypted, optional)

```powershell
$env:ADVISERS_SYNC_PASSPHRASE = "at least 8 chars"
node $A sync push --dir C:\Sync\advisers --device laptop --json
node $A sync pull --dir C:\Sync\advisers --json
node $A sync status --dir C:\Sync\advisers --check --json
```

Whole-database snapshots, AES-256-GCM, last-writer-wins with a refusal guard
(`E_SYNC_CONFLICT` unless `--force`, which keeps a `.before-sync-*` backup); `--dry-run`
writes nothing. See [docs/SYNC.md](SYNC.md).

### Read-only mail follow-up (0.5.1)

```powershell
node $A mail followup add --mail <msg-id> --action "ask for the signed quote" --json
node $A mail followup ls --json
node $A mail followup check --dry-run --json
node $A mail followup mark-replied <wr_id> --note "answered by phone" --json
```

Header-only, local, and never sends: a follow-up is an ordinary commitment plus a
`waiting_replies` row; replies are only `replied` when stored `In-Reply-To`/`References`/
`thread_root` prove it. Automatic replies, foreign senders and fuzzy subjects are
ignored or put in `possibleReplies[]`. "No reply found" is local evidence, not an
external fact, and an unsynced Sent mailbox is reported as a warning. See
[docs/MAIL-FOLLOWUP.md](MAIL-FOLLOWUP.md).

### Release-quality evidence (0.5.1)

The deterministic gates run on a clean checkout into a frozen release-evidence
directory; `node scripts/check-eval-report.mjs --release` and
`node scripts/check-release.mjs --eval-evidence` are part of the pre-tag checklist, and
the report ships as a release asset/CI artifact. Human gold is still `null`; see
[docs/QUALITY.md](QUALITY.md) for commands, metrics, `n` and unknowns.

