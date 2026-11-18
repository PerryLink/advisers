# CLI JSON contract v1 (E6-T1 + 0.2.0 data plane)

Advisers is CLI-first. Scripts should be able to consume every read-only view without
parsing human text. JSON mode never mixes human prose into stdout; diagnostics go to
stderr and `--json` must not require a TTY. Shapes are additive: new optional keys may
appear, existing keys keep their meaning.

## Current JSON surfaces (2026-11; 0.2.3 additions marked)

| Command | Shape (top-level) | Stable? |
|---|---|---|
| `advisers status --json` | `{version,node,office,home,store{type,path},model,matters,prefs,routines,links,sessions,deliveries,soul,modelUsage?}` | v1 |
| `advisers tick --json` | `{now,localDay,due[]}` | v1 (existing) |
| `advisers today --json [--calendar] [--sources]` | `{now,localDay,counts{today,overdue,week,waiting,noDue},overdue[],today[],week[],waiting[],noDue[],next,calendar?[],sources?[]}` | v1 |
| `advisers remind --json` | `{now,reminders[]}` | v1 |
| `advisers commit ls --json` | `Commitment[]` | v1 |
| `advisers who --json` | `{mine[],waiting[]}` | v1 |
| `advisers deliveries --json` | `Delivery[]` | v1 |
| `advisers deliveries --receipt` | receipt pack summary (below) — always JSON, even without `--json` | v1 |
| `advisers deliveries --pack` | evidence-pack JSON `{out,files,receipt,verification}` | existing |
| `advisers evidence show <id> --json` | `{commitment\|fact\|preference,sources[],missing[],unverifiable[],summary{byKind{observed,manual},missing,unverifiable,operatorEntered}}` | v1 (+0.2.3 additive fields) |
| `advisers evidence verify <dir>` | `{ok,errors[],warnings[],dir,fileCount,checksumCount,files[],checksums{},manifest}` | v1 |
| `advisers capture --json` / `capture --from-mail\|--from-transcript\|--from-imap --json` | `{ok,command,count,candidates[]}` (+ `seen,skipped,failed` for imports, `alreadyImported` on transcript dedupe) | v1 |
| `advisers memory candidates --json [--all]` | `Candidate[]` | v1 |
| `advisers verify <file> --json [--content]` | office `VerifyResult`: `{ok,checks[],entries,bytes,layers,...}`; with `--content`: `{structure,content}` | existing/office |
| `advisers privacy --json` | data/egress facts | v1 |
| `advisers export [--all]` | ledger JSON / ledger+SQLite tables | existing |
| `advisers office-edit ...` | `{ok,out,changes}` | existing |
| `advisers matter add\|ls\|show\|rename\|archive\|use --json` | matter row / `{ok,command,matter,...}` (below) | v1 (0.2.3) |
| `advisers agenda --json [--days 1..31] [--from] [--matter] [--no-calendar] [--include-done]` | agenda window (below) | v1 (0.2.3) |
| `advisers morning --json` (alias `digest morning`) | deterministic brief payload (below) | v1 (0.2.3) |
| `advisers template quote\|proposal <data.json> <out> --json` | generation result + totals + verification (below) | v1 (0.2.3) |
| `advisers verify <file> --content --template quote\|proposal --data <json>` | `{structure,content{checks[],template{...}}}` (below) | v1 (0.2.3) |

### `today --json`

The same classification as the one-screen view (a third-party commitment is also
counted under `waiting`). Group arrays hold the full ledger `Commitment` rows.

- `now`: ISO-8601 UTC timestamp of the run; `localDay`: the Asia/Shanghai day.
- `counts`: `{today,overdue,week,waiting,noDue}` integers.
- `next`: the earliest due commitment as `{id,action,dueAt}` or `null`.
- `calendar` (only with `--calendar`): `[{uid,summary,startsAt,endsAt,allDay,recurring,location,rrule}]`
  for the occurrences that start today (RRULE expanded locally; `startsAt` is
  `YYYY-MM-DD` for all-day and `YYYY-MM-DDTHH:MM:SS+08:00` for timed).
- `sources` (only with `--sources`): `[{commitmentId,action,type,ref,quote}]` with the
  normalised v2 source type (`email` rows read back as `mail`; no DB rewrite).

### `matter --json` (0.2.3)

`matter` creates/inspects the client/project dimension; it does not move ledger rows.
All shapes are additive and keep `--json` stdout machine-only (errors go to stderr):

- `matter add <title> [--secrecy 0-3] [--domain d] [--summary s] --json` →
  `{ok:true, command:"matter add", matter}` where `matter` is the ledger `Matter`
  (`id,title,status,domain,secrecy,summary?,createdAt,updatedAt,...`).
- `matter ls [--all] --json` → `MatterRow[]`:
  `{id,title,status,domain,secrecy,clientId:null,projectId:null,openCommitments,nextDueAt}`.
  Default is active matters only; `--all` adds paused/archived.
- `matter show <id> --json` →
  `{ok:true, command:"matter show", matter, counts{commitments,open,done}, open[{id,action,dueAt|null,debtor,creditor}], nextDueAt}`.
- `matter rename <id> <title> --json` → `{ok:true, command:"matter rename", matter}`.
- `matter archive <id> [--dry-run] --json` → `{ok:true, command:"matter archive", matter}`;
  with `--dry-run` the payload also has `dryRun:true` and nothing is written.
- `matter use <id> --json` → `{ok:true, command:"matter use", matterId}` (sets the default
  matter for later `--matter`-less writes).
- Errors are `{error:{code,message,hint?}}` on stderr with exit 1:
  `E_USAGE`, `E_MATTER_NOT_FOUND`, `E_MATTER_ARCHIVED`. The same errors now gate
  `--matter` on write commands instead of silently writing a dangling `matter_id`.

### `agenda --json` (0.2.3)

`{ok:true, command:"agenda", now, window{from,to,days,timezone}, overdue[], days[],
waiting[], unscheduled[], conflicts[], counts{overdue,today,days,waiting,unscheduled,conflicts,perDayLoad{}}, degraded[]}`

- `window`: Asia/Shanghai days; `from` is today unless `--from YYYY-MM-DD` is given,
  `to` is the last day of the window (`--days 1..31`, default 7).
- Item shape (commitments and calendar events):
  `{id,kind:"commitment"|"calendar"|"done",title,allDay,at,localDate,localTime,matterId,
  ref{kind,id},meta{...}}`; calendar items add `endAt` when the event ends and
  `meta.rrule`/`meta.location` when present. `title` is clipped to 120 characters.
- `overdue[]` (≤50), `days[].items` (≤20/day), `waiting[]`/`unscheduled[]` (≤20 each) are
  deterministically sorted; `load` is the item count before the cap and `counts` carries
  the full totals.
- `conflicts[].items` is a sorted pair of ids (overlapping timed calendar events, or a
  timed commitment inside a calendar event), not a free-text warning.
- `degraded[]` lists data sources that could not be read (partial ledger/calendar) instead
  of silently showing an empty window.
- Errors: `{error:{code:"E_USAGE"|"E_MATTER_NOT_FOUND"|"E_MATTER_ARCHIVED",message,hint?}}`
  on stderr, exit 1.

### `morning --json` (0.2.3)

`digest morning` is the same command. Deterministic local brief (no model, no network):

`{ok:true, command:"morning", generatedAt, localDay, window, mustDo[], overdue[], meetings[],
waiting[], upcoming[], unscheduled[], conflicts[], counts{mustDo,overdue,meetings,waiting,
upcoming,unscheduled,conflicts}, dataSha256, degraded[], out?}`

- `dataSha256` is the SHA-256 of the stable-stringified source data, so two runs with the
  same ledger/calendar day produce the same brief (the markdown quotes its first 16 chars).
- `--out <file>` also writes the markdown (mode 600) and adds `out` to the payload.
- Item shapes are the agenda shapes; `upcoming[]` is days 2..N flattened.
- Without `--json` the command prints the markdown brief only.

### Manual / operator evidence (0.2.3)

`commit add --quote <text>` and `commit done --evidence <text>` store a typed manual
source instead of a fake conversation pointer:
`{kind:"manual",type:"manual",source:"operator",quote,quoteSha256,capturedAt,capturedBy,
command,cliVersion}`. Readers classify it as **unverifiable (operator_entered), not
missing**:

- `evidence show <id> --json` adds `unverifiable[]` and
  `summary{byKind{observed,manual},missing,unverifiable,operatorEntered}`; resolved
  conversation sources stay in `sources[]`, and `missing[]` only holds refs that were
  expected to resolve but did not.
- Evidence packs / receipt packs count operator-entered entries separately
  (`operatorEntered` vs `missingCount`) and label them as unverifiable. No schema
  migration: evidence is a JSON column and pre-0.2.3 rows are read through the same
  classification.

### `deliveries --receipt`

Two separate bundle commands exist; do not mix them:
`deliveries --pack` is the v1 evidence pack, `deliveries --receipt` is the v1.1
delivery receipt pack (delivered file copies + SHA256SUMS + receipt.docx).

```json
{
  "ok": true,
  "format": "advisers-delivery-receipt-pack",
  "version": 1,
  "out": "/home/me/.advisers/receipts/receipt-2026-11-17T...",
  "replaced": null,
  "deliveryCount": 1,
  "fileCount": 4,
  "verifyStatus": "passed",
  "anchored": false,
  "recipient": { "name": "王工", "email": "wang@example.com", "note": null },
  "manifestDigest": "<sha256>",
  "receiptSha256": "<sha256>",
  "evidence": { "entryCount": 1, "counts": {...}, "sourceCount": 0, "missingCount": 1 },
  "files": [{ "path": "deliveries/<id>/quote.docx", "size": 10013, "sha256": "<sha256>" }],
  "skippedFiles": [],
  "verification": { "ok": true, "errors": [], "warnings": ["..."], "checksumCount": 4 }
}
```

- `files` lists every file covered by `SHA256SUMS` (manifest/README/receipt + delivery copies).
- `verification` is a fresh offline `verifyReceiptPackDir(out)` run; `ok:false` sets exit 1.
- `skippedFiles` names delivery files that no longer exist (they are not in the pack).
- Exit 1 when there is no readable delivery file or the evidence pack exceeds the
  2000-entry default (`--ids` narrows, `--all` lifts the cap).
- `--recipient` accepts `"Name <mail>"`, a bare address or a bare name; it is an
  operator-entered record, not a signed/legal receipt.

### `evidence verify <dir>`

Offline verifier result, identical to the library's `verifyReceiptPackDir`:
`{ok,errors[],warnings[],dir,fileCount,checksumCount,files[],checksums{},manifest}`.
Exit `0` when `ok === true`, `1` otherwise. It reads only `<dir>` (no
`~/.advisers`, no network) and is exempt from the TOS gate, so it works on a
clean machine.

### `capture --json`

```json
{
  "ok": true,
  "command": "capture",
  "source": "wechat",
  "count": 1,
  "candidates": [
    {
      "id": "cand_...",
      "kind": "commitment",
      "payload": { "matterId": "matter_...", "debtor": "user", "creditor": "王工", "action": "发报价", "dueAt": "...", "capability": "none" },
      "evidence": [{ "quote": "...", "turnId": "turn_...", "sessionId": "...", "source": { "sourceVersion": 2, "type": "conversation", "ref": "...", "quote": "...", "capturedAt": "..." } }],
      "status": "pending",
      "createdAt": "..."
    }
  ]
}
```

- Import variants use `command: "capture --from-mail"` / `"capture --from-transcript"` /
  `"capture --from-imap"` and add `seen`, `skipped`, `failed`; a deduped transcript
  returns `{ok:true, alreadyImported:true, count:0, candidates:[]}`.
- `evidence[].source` is source schema **v2** (`sourceVersion: 2`), see
  [`SOURCE-SCHEMA.md`](SOURCE-SCHEMA.md).
- Errors (missing `ADVISERS_API_KEY`, rejected source, bad input) are written to
  stderr and exit 1; stdout stays empty so `... --json | jq` fails loudly instead of
  silently parsing human text.

### `memory candidates --json`

`Candidate[]` where Candidate =
`{id,kind,payload,evidence,status,createdAt,reviewedAt?,rejectReason?}`.
`--all` includes accepted/rejected rows (default: pending only).

### `verify --json`

The office `VerifyResult` object: `ok` is true only when no blocker check failed,
and `checks[]` is a stable machine-readable list of `{id,ok,severity,detail,skipped?}`.
With `--content` the output is `{structure,content}` (`structure` is the same
VerifyResult, `content` adds deterministic content checks); exit 1 when either view
reports failure.

### `template quote|proposal --json` (0.2.3)

Deterministic Office builders (no model, no network, no new dependency). Money is parsed
from **decimal strings** into integer cents (BigInt while multiplying), never floating
point:

```json
{
  "ok": true,
  "command": "template",
  "template": "quote",
  "format": "docx",
  "out": "/path/to/quote.docx",
  "bytes": 10123,
  "templateVersion": "1",
  "dataSha256": "<sha256 of the normalized data>",
  "quoteNo": "Q-20261118-001",
  "totals": {
    "subtotal": "2,469.12", "discount": "0.00", "tax": "0.00", "total": "2,469.12",
    "currency": "CNY",
    "formatted": { "subtotal": "¥2,469.12", "discount": "¥0.00", "tax": "¥0.00", "total": "¥2,469.12" }
  },
  "verify": { "structure": { "ok": true, "checks": [] }, "content": { "ok": true, "checks": [], "findings": [] } },
  "deliveryId": "del_...   (only with --record-delivery)"
}
```

- Data (quote): `issuedAt`, `validUntil` (`YYYY-MM-DD`), `currency` (CNY/USD/EUR/HKD),
  `issuer{name,contact?}`, `client{name,company?}`, `project{name,summary,deliverables[]}`,
  `items[{desc,qty,unit,unitPrice}]`, optional `discount{kind:"percent"|"amount",value}`,
  `tax{mode:"exclusive"|"inclusive",ratePct}`, `payment`, `timeline`,
  `changeProcess`, `disclaimer`, `signature`, `quoteNo` (defaults to
  `Q-YYYYMMDD-NNN`). Proposal adds `scope{included,excluded,assumptions}` and
  `timeline[{name,start,end}]`.
- Quantity/unit price/rate are **strings**; a JSON number is rejected. Unknown fields,
  bad dates, missing names, out-of-range amounts and over-limit lists fail with exit 1 and
  `{error:{code:"E_TEMPLATE_INVALID"|"E_AMOUNT"|"E_TEMPLATE_OUTPUT",message,details?}}` on
  stderr, before any output file is written.
- `quote` writes DOCX or XLSX; `proposal` writes DOCX only. `--record-delivery`
  records the file in `deliveries` (audited) and returns `deliveryId`.
- The normalized data and totals are embedded in the document for offline re-verification.

### `verify --content --template quote|proposal --data <json>` (0.2.3)

```json
{
  "structure": { "ok": true, "checks": [] },
  "content": {
    "ok": true,
    "checks": [
      { "id": "quote.required", "ok": true },
      { "id": "quote.totals", "ok": true },
      { "id": "quote.data_hash", "ok": true },
      { "id": "quote.no_placeholders", "ok": true }
    ],
    "template": { "name": "quote", "version": "1", "dataSha256": "<sha256>", "totals": { "...": "..." } }
  }
}
```

Re-checks the totals and the data SHA-256 against the supplied data file, offline (no
ledger, no network). Proposal uses `proposal.*` check ids. Exit 1 when any check fails
(for example the document was generated from tampered data), and the failing check id plus
`detail` says what mismatched.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | user/config/runtime error (bad args, missing key, unknown id, failed verification, receipt-pack evidence cap) |
| `3` | TOS consent required: a non-interactive command was blocked by the consent gate. Accept in a TTY with `advisers tos accept`, or pass `--accept-tos` / set `ADVISERS_ACCEPT_TOS=1`. `advisers evidence verify <dir>` is offline/read-only and exempt (never exits 3). |

Future codes must not reuse `1` for a different meaning; add new codes only with a
version bump.

## Examples

```sh
advisers status --json | jq .version
advisers today --json --calendar | jq '.calendar[] | select(.recurring)'
advisers remind --json | jq '.reminders[] | {action,bucket,level,reminderOffsets}'
advisers memory candidates --json | jq '.[].payload.action'
advisers deliveries --receipt --out ./receipt-pack | jq '{ok,verifyStatus,fileCount}'
advisers evidence verify ./receipt-pack | jq '.ok'
advisers matter ls --json | jq '.[] | select(.openCommitments > 0)'
advisers agenda --json | jq '{today: .counts.today, conflicts: .counts.conflicts}'
advisers morning --json | jq '{mustDo: .counts.mustDo, hash: .dataSha256[0:16]}'
advisers template quote quote.json out.docx --json | jq '{quoteNo, totals}'
advisers verify out.docx --content --template quote --data quote.json | jq '.content.checks'
```
