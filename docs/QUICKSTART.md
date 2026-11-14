# Quickstart (Windows + PowerShell)

> Current status: the `0.2.0-preview.*` packages are staged and awaiting npm OTP approval.
> The public `@next` tag currently points at an old 0.1 preview; do not judge this build by it.
> Until approval, run from the checkout as shown below.

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
npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers --version
advisers status
advisers soul init
advisers template weekly weekly.json out\weekly.docx
advisers verify out\weekly.docx
```

If `advisers-office` is missing, install it explicitly; the CLI does not pull it automatically.

## C. Troubleshooting

| Symptom | Fix |
|---|---|
| `No such built-in module: node:sqlite` | Node < 22.13; install Node 24 LTS |
| `advisers-office is not installed` | `npm i -g advisers-office@next`, or set `ADVISERS_OFFICE_LOCAL=1` from checkout |
| `SyntaxError: Unexpected token '﻿'` | JSON has BOM; write UTF-8 without BOM |
| Chinese output is garbled | `chcp 65001`; use Windows Terminal |
| `model HTTP 401` | Key/base URL wrong; set `ADVISERS_API_KEY`, check `advisers status` |
| Command not found after `npm i -g` | Open a new terminal so PATH refreshes |

## Data & privacy

- Data: `%USERPROFILE%\.advisers\` unless `ADVISERS_HOME` is set.
- `advisers export` contains raw conversations/preferences — do not share it.
- Model calls send context to the configured API; local-only commands (`status`, `office`, `template`, `verify`, `commit`) do not.

## E. Reminders (local, opt-in)

```powershell
node $A remind                     # due now/next 7 days
node $A remind --json              # scripts
node $A remind --ics out.ics       # import into Google/Outlook/system calendar
node $A remind --deliver           # append to ~/.advisers/reminders.log
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
