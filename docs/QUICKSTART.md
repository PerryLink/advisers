# Quickstart (Windows + PowerShell)

> Current status: `0.2.0` is the **current stable release**, published on npm `@latest`.
> All six published packages are lockstep at `0.2.0`; install with
> `npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest`.
> The checkout instructions below remain valid for development builds.

> **Before you start** — read the [Terms of Service](TOS.md) (v2026.11.2),
> [Disclaimer](DISCLAIMER.md), [Safety & content review](SAFETY.md), and
> [Privacy & data-flow notice](PRIVACY.md). AI output can be wrong; illegal, infringing,
> deceptive, or unlabeled synthetic content is prohibited.
>
> The first time you use a gated command (anything except `help`, `--version`, `status`,
> `doctor`, `init` and `advisers tos ...`), Advisers shows a short Terms summary and asks
> you to accept by typing 同意 (`y`/`yes` is a shortcut; Enter or `n` rejects). Non-interactive
> environments must pass `--accept-tos` or set `ADVISERS_ACCEPT_TOS=1`; without them a gated
> command exits with code 3 and a single `E_TOS_REQUIRED` line on stderr while stdout stays
> machine-readable. Continuing to run, pressing Enter, or keeping the default is not
> acceptance. The acceptance record (version, text SHA-256, time, channel) is written to
> `%ADVISERS_HOME%\tos.json` (0600) and the local audit chain: check it with
> `advisers tos status`, read the full text with `advisers tos show`, and withdraw with
> `advisers tos revoke`. Changing the persona (`soul set`/`soul init`), routines or the
> ledger (`import --replace`) asks for a fresh confirmation each time.

## Requirements

- Node **>= 22.13** (Node 24 recommended). `node:sqlite` is not available on 22.5–22.12.
- `pnpm` 12.x (`corepack enable`)
- Windows Terminal + PowerShell 7 recommended (PowerShell 5.1 works with the BOM note below)
- Optional: DeepSeek-compatible API key for natural-language tasks and model-generated commitments

```powershell
node -v      # must be >= 22.13
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

## B. Installed CLI (after npm approval)

```powershell
# Stable channel after the owner approves 0.2.0 (default `latest` tag):
npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
# Pre-release channel (preview/RC builds land on `next` before promotion):
# npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers --version    # expect 0.2.0 after approval
advisers status
advisers soul init
advisers template weekly weekly.json out\weekly.docx
advisers verify out\weekly.docx
```

If `advisers-office` is missing, install it explicitly (`advisers-office@latest`, or
`@next` before promotion); the CLI does not pull it automatically.

## C. Troubleshooting

| Symptom | Fix |
|---|---|
| `No such built-in module: node:sqlite` | Node < 22.13; install Node 24 LTS |
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
- Egress: model commands (`chat`, `capture`, `review`, `brief --deep`, `learn review`) send
  context to the configured API — **DeepSeek (`https://api.deepseek.com`) by default**;
  `research --web|--url`, `capture --from-imap`, `ADVISERS_NOTIFY_WEBHOOK`, `sync`, MCP/DSH/
  desktop-pet consumers and your own external commands can also leave the machine. Local-only
  commands (`status`, `office`, `template`, `verify`, `commit`) do not.
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
