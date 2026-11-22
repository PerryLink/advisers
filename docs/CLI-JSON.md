# CLI JSON contract v1 (E6-T1 + 0.2.0 data plane; 0.4.0 additive surfaces)

Advisers is CLI-first. Scripts should be able to consume every read-only view without
parsing human text. JSON mode never mixes human prose into stdout; diagnostics go to
stderr and `--json` must not require a TTY. Shapes are additive: new optional keys may
appear, existing keys keep their meaning.

> Status: **0.4.3 (schema v22)**. Every 0.4.x change in this document is additive
> inside the v1 contract: new commands, new optional fields and new `--scope` values.
> Existing commands, keys, ordering and exit codes are unchanged, so a 0.3.2 consumer
> keeps working without modification — with two deliberate 0.4.3 exceptions that scripts
> must handle: keyless `capture` now succeeds as a local-rule run instead of exiting 1
> (`capture --model` keeps the missing-key exit 1), and `--help`/`-h` is a global exit-0
> short-circuit. The 0.4.0-only additions are marked **(0.4.0)**; the 0.4.1 follow-ups
> (KB/mail review links, reminder delivery policy) and the 0.4.2 follow-ups (manual fact
> entry, mail probe/watch, `sync pull --dry-run`, the backup-age hint and subcommand
> `--help`) are called out inline; the 0.4.3 additions are collected in §0.4.3 additive
> surfaces; anything not marked is 0.3.2/earlier behaviour.

## Current JSON surfaces (2026-11; 0.2.3 additions marked)

| Command | Shape (top-level) | Stable? |
|---|---|---|
| `advisers status --json` | `{version,node,office,home,store{type,path},model,matters,prefs,routines,links,sessions,deliveries,clients,projects,soul,modelUsage?}` (clients/projects are 0.3.0 additive) | v1 |
| `advisers tick --json` | `{now,localDay,due[]}` | v1 (existing) |
| `advisers today --json [--calendar] [--sources] [--limit n]` | `{now,localDay,counts{today,overdue,week,waiting,noDue},overdue[],today[],week[],waiting[],noDue[],next,calendar?[],sources?[],limit?,truncated?}` (0.3.2 additive `limit`/`truncated` only with `--limit`) | v1 |
| `advisers remind --json` | `{now,reminders[]}` | v1 |
| `advisers commit ls --json` | `Commitment[]` | v1 |
| `advisers who --json` | `{mine[],waiting[]}` | v1 |
| `advisers deliveries --json` | `Delivery[]` (+0.3.0 lineage keys `clientId/projectId/templateName/templateVersion/quoteNo/dataSha256` when present) | v1 |
| `advisers deliveries --receipt [--client <id> [--project <id>]]` | receipt pack summary (below) — always JSON, even without `--json`; 0.3.2 adds `scope`/`subject`/`deliveriesTotal`/`deliveriesTruncated` | v1 (additive) |
| `advisers deliveries --pack` | evidence-pack JSON `{out,files,receipt,verification}` | existing |
| `advisers evidence show <id> --json` | `{commitment\|fact\|preference,sources[],missing[],unverifiable[],summary{byKind{observed,manual},missing,unverifiable,operatorEntered}}` | v1 (+0.2.3 additive fields) |
| `advisers evidence verify <dir>` | `{ok,errors[],warnings[],dir,fileCount,checksumCount,files[],checksums{},manifest}` | v1 |
| `advisers capture --json` / `capture --from-mail\|--from-transcript\|--from-imap --json` | `{ok,command,count,candidates[]}` (+ `seen,skipped,failed` for imports, `alreadyImported` on transcript dedupe) | v1 |
| `advisers memory candidates --json [--all]` | `Candidate[]` | v1 |
| `advisers verify <file> --json [--content]` | office `VerifyResult`: `{ok,checks[],entries,bytes,layers,...}`; with `--content`: `{structure,content}` | existing/office |
| `advisers privacy --json` | data/egress facts | v1 |
| `advisers export [--all]` | ledger JSON / `{version,schemaVersion?,exportedAt,ledger,data,auditAnchor}` with `data` = every `DATA_TABLES` table (clients/projects/client_notes included in 0.3.0) | existing (additive) |
| `advisers client/project ... --json` | customer/project rows + derived timeline/counts (0.3.0, see below and [CLIENTS.md](CLIENTS.md)) | v1 (0.3.0 additive) |
| `advisers office-edit ...` | `{ok,out,changes}` | existing |
| `advisers matter add\|ls\|show\|rename\|archive\|use --json` | matter row / `{ok,command,matter,...}` (below; 0.3.0 adds real `clientId/projectId` + `--client/--project/--unclassified` filters) | v1 (0.2.3) |
| `advisers agenda --json [--days 1..31] [--from] [--matter] [--no-calendar] [--include-done]` | agenda window (below) | v1 (0.2.3) |
| `advisers morning --json` (alias `digest morning`) | deterministic brief payload (below) | v1 (0.2.3) |
| `advisers template quote\|proposal <data.json> <out> --json` | generation result + totals + verification (below) | v1 (0.2.3) |
| `advisers verify <file> --content --template quote\|proposal --data <json>` | `{structure,content{checks[],template{...}}}` (below) | v1 (0.2.3) |
| `advisers search <q> --json [--scope turns\|kb\|pages\|facts\|all]` | unified search payload (below) | v1 (0.4.0 additive) |
| `advisers kb add\|ls\|show\|rm\|purge\|reindex --json` | KB document payloads (below, [KB.md](KB.md)) | v1 (0.4.0 additive) |
| `advisers kb page ls\|show\|rebuild\|diff --json` | compiled-page payloads (below) | v1 (0.4.0 additive) |
| `advisers fact show\|history\|as-of --json` | fact time-travel payloads (below) | v1 (0.4.0 additive) |
| `advisers mail account add\|ls\|show\|rm --json` | account payloads (below) | v1 (0.4.0 additive) |
| `advisers mail sync\|ls\|show\|extract\|import\|purge --json` | mail payloads (below) | v1 (0.4.0 additive) |
| `advisers receivable add\|ls\|show\|edit\|void --json` / `payment add\|ls\|void --json` | money sidecar payloads (below, [CLIENTS.md](CLIENTS.md)) | v1 (0.4.0 additive) |
| `advisers consent status\|grant\|revoke --json` | consent file status/entry (below) | v1 (0.4.0 additive) |
| `advisers privacy --matrix --json` | policy surface matrix (below) | v1 (0.4.0 additive) |
| `advisers client export --pack --json` | client status pack v2 summary (below, [CLIENTS.md](CLIENTS.md)) | v1 (0.4.0 additive) |

### `today --json`

The same classification as the one-screen view (a third-party commitment is also
counted under `waiting`). Group arrays hold the full ledger `Commitment` rows.

- `now`: ISO-8601 UTC timestamp of the run; `localDay`: the Asia/Shanghai day.
- `counts`: `{today,overdue,week,waiting,noDue}` integers.
- `next`: the earliest due commitment as `{id,action,dueAt}` or `null`.
- `--limit N` (0.3.2, `--json` only; N=1..10000, cannot combine with
  `--sources`): each group array keeps at most N **full Commitment entities**
  (hydrated on demand), while `counts` and `next` stay the true totals. The
  output gains `limit: N` and `truncated: boolean`; without the flag the output
  is byte-identical to v1 (`today --json` remains output-bound on a 200k ledger —
  use `--limit` for the bounded read path).
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
- `matter ls [--all] [--client <id>] [--project <id>] [--unclassified] --json` → `MatterRow[]`:
  `{id,title,status,domain,secrecy,clientId|null,projectId|null,openCommitments,nextDueAt}`.
  Default is active matters only; `--all` adds paused/archived. 0.3.0 (schema v21) fills the
  real ownership ids (they were hard-coded `null` before) and the filters are scoped by
  that ownership; an unknown `--client`/`--project` fails with `E_CLIENT_NOT_FOUND` /
  `E_PROJECT_NOT_FOUND` instead of returning an empty list. Unclassified (pre-v21 or
  not-yet-linked) matters stay in the default list and `--unclassified` shows only them.
- `matter show <id> --json` →
  `{ok:true, command:"matter show", matter, client:{id,name,status}|null, project:{id,name,status,clientId}|null, counts{commitments,open,done}, open[{id,action,dueAt|null,debtor,creditor}], nextDueAt}`
  (`client`/`project` are 0.3.0 additive resolved names; the raw ids stay on `matter`).
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
`deliveries --pack` is the v1 evidence pack, `deliveries --receipt` is the
delivery receipt pack. 0.3.2 generates **manifest v2** (subject/scope/lineage);
the verifier accepts v1 and v2 packs, so receipts written by 0.3.0/0.3.1 still
verify.

```json
{
  "ok": true,
  "format": "advisers-delivery-receipt-pack",
  "version": 2,
  "scope": "subject",
  "subject": { "kind": "client", "id": "cl_wang", "name": "王工" },
  "out": "/home/me/.advisers/receipts/receipt-2026-11-17T...",
  "replaced": null,
  "deliveryCount": 1,
  "deliveriesTotal": 1,
  "deliveriesTruncated": false,
  "fileCount": 5,
  "verifyStatus": "passed",
  "anchored": false,
  "recipient": { "name": "王工", "email": "wang@example.com", "note": null },
  "manifestDigest": "<sha256>",
  "receiptSha256": "<sha256>",
  "evidence": { "entryCount": 1, "counts": {...}, "sourceCount": 0, "missingCount": 1 },
  "files": [{ "path": "deliveries/<id>/quote.docx", "size": 10013, "sha256": "<sha256>" }],
  "skippedFiles": [],
  "verification": { "ok": true, "errors": [], "warnings": ["..."], "checksumCount": 5 }
}
```

- `--client <id> [--project <id>]` (0.3.2) scopes the pack to one subject: only
  that client's/project's deliveries (current matter ownership **or** the
  generation-time lineage snapshot) and the evidence under those matters are
  copied. Global facts/preferences are excluded unless `--include-global`;
  `--ids` cannot be combined with a subject. `scope` becomes `"subject"` and
  the pack states it contains only that subject's data.
- Without a subject the historical local-all pack is kept, but it is labelled
  `scope: "local-all"` and README.txt/receipt.docx state that it contains every
  local customer's data and must not be forwarded to a third party.
- `deliveriesTotal`/`deliveriesTruncated` report the scoped delivery count
  before the readable-file and `--limit` filters, so a bounded pack is never
  mistaken for the whole set.
- Secrecy: every delivery row is gated by `max(client.secrecyDefault,
  matter.secrecy)` at clearance 0; protected rows are counted
  (`deliveriesProtectedExcluded`) and never copied. A subject client whose
  default secrecy is above 0 fails closed with `E_SECRECY_BLOCKED` instead of
  producing an empty pack. The evidence section uses the same rule
  (`evidenceClientDefaultExcluded`).
- `files` lists every file covered by `SHA256SUMS` (manifest/README/receipt + delivery copies).
- `verification` is a fresh offline `verifyReceiptPackDir(out)` run; `ok:false` sets exit 1.
- `skippedFiles` names delivery files that no longer exist (they are not in the pack).
- Exit 1 when there is no readable delivery file or the evidence pack exceeds the
  2000-entry default (`--ids` narrows, `--all` lifts the cap).
- `--recipient` accepts `"Name <mail>"`, a bare address or a bare name; it is an
  operator-entered record, not a signed/legal receipt.
- Compatibility: a pre-0.3.2 verifier rejects a v2 pack, but
  `sha256sum -c SHA256SUMS` always works; use 0.3.2+ for full receipt
  verification.

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

### `client` / `project --json` (0.3.0)

Contract v1 additive commands for the customer/project dimension (schema v21; v22
adds the money sidecar, mail and KB tables without changing these shapes); the
full product contract is [CLIENTS.md](CLIENTS.md). Rows are SQLite-only (the legacy
JSON store answers `E_STORE`), and every `--json` stdout is one pure JSON document.

- `client list [--all] [--limit n] --json` → `ClientRow[]`:
  `{id,name,nameNorm,aliases,status,tags,secrecyDefault,notes?,createdAt,updatedAt,deletedAt?,counts,nextDueAt,clearance,protectedExcluded}`.
- `client show <id> [--timeline-limit n] [--clearance 0-3] --json` →
  `{ok:true, command:"client show", client, projects[{…project,counts,nextDueAt}], matters[{id,title,status,secrecy,projectId,openCommitments,nextDueAt}], counts, open{mine[],waiting[]}, nextDueAt, timeline[], timelineTotal, timelineTruncated, nextCursor:null, clearance, protectedExcluded, degraded[]}`.
- `client timeline <id> [--since 90d|ISO] [--kind delivery,note,commitment] [--limit n] [--clearance 0-3] --json` →
  `{ok:true, command:"client timeline", clientId, client:{id,name}, items[], total, truncated, nextCursor:null, clearance, protectedExcluded, degraded[]}`.
- `client add|archive|merge --json` → `{ok:true, command, …}`; merge adds
  `mergedFrom, movedMatters, movedProjects, mergedProjects, movedNotes, movedDeliveries, carriedAliases`.
  `--dry-run` adds `dryRun:true` and a `plan` (archive adds `activeProjects/wouldBlock`).
- `client note add|list --json` → the note row / `NoteRow[]`.
- `project list [--client <id>] [--all] [--limit n] --json` → `ProjectRow[]`;
  `project show|add|archive --json` mirror the client shapes.
- `counts` is `{matters,mattersArchived,deliveries,notes,commitments,openMine,openWaiting,overdue}`.
- Timeline item: `{at,kind,title,ref:{kind,id},matterId?,projectId?,secrecy,status?,dueAt?,doneAt?,debtor?,creditor?,templateName?}`
  ordered `at` DESC, then `delivery > note > commitment`, then id ASC (frozen; a commitment is
  placed at its `createdAt`, never at its due date).
- `--clearance N` is an opt-in per-item secrecy gate (default 3 = the local user sees
  their own data). A matter whose effective secrecy `max(client.secrecyDefault, matter.secrecy)`
  exceeds `N` is withheld together with its rows, and only `protectedExcluded` (a count) is
  reported — no id/title/name/note/quote. The filter runs before counting/paging, so
  `counts`/`total` never leak hidden rows. Visible items always carry their `secrecy` label.
- Isolation: every read is scoped by the entity's own matter ids; client A's output must
  never contain client B's id/name/title/quote (covered by `test/bin-clients.test.js`).
- Errors (stderr `{error:{code,message,hint?}}`, exit 1; exit 3 when the TOS gate blocks):
  `E_CLIENT_NOT_FOUND`/`E_CLIENT_ARCHIVED`/`E_CLIENT_DUPLICATE`/`E_CLIENT_ALIAS_CONFLICT`/`E_CLIENT_HAS_ACTIVE_PROJECTS`/`E_CLIENT_MERGE_SELF`/`E_CLIENT_INVALID`/`E_CLIENT_NOTE_INVALID`/`E_CLIENT_NOTE_NOT_FOUND`,
  `E_PROJECT_NOT_FOUND`/`E_PROJECT_INVALID`/`E_PROJECT_DUPLICATE`/`E_PROJECT_CLIENT_MISMATCH`/`E_MATTER_CLIENT_MISMATCH`,
  `E_STORE` (JSON store), `E_USAGE`, `E_TOS_REQUIRED` (exit 3), `E_SCHEMA_NEWER` (newer import).
- `client export <id> [--format md|docx] [--out <file>] [--redact-names] --json` (0.3.2) →
  `{ok:true, command:"client export", format, scope:"client", subject{kind,id,name}, out, bytes, sha256, generatedAt, clearance:0, protectedExcluded, counts, nextDueAt, timelineCount, timelineTotal, timelineTruncated, disclaimer:true}`.
  Writes a deterministic, external-facing status sheet (markdown or DOCX, mode 0600):
  client profile/counts, active projects, open buckets, recent delivery/commitment
  timeline, fixed disclaimer. It never contains evidence quotes or note bodies;
  protected matters are counted only; `--redact-names` replaces the client/project
  display names (it is not an anonymizer for titles/notes). An audit row
  `client.export` records the client id/format/size only.
- `export --all` carries every `DATA_TABLES` table (including the three customer tables) plus an
  additive `schemaVersion`; `import --replace` restores the ledger **and** the customer tables in one
  transaction, refuses a newer `schemaVersion` before writing, and aborts atomically on a dangling
  reference. See [CLIENTS.md §5](CLIENTS.md#5-export--import-parity).

## 0.4.0 additive read models

Every shape in this section is new in 0.4.0 and additive to contract v1: old keys
keep their meaning and old consumers can ignore the new objects. Commands marked
**not wired in 0.4.0** are accepted by the library/design but are not reachable from
the 0.4.0 CLI yet; do not script against them before they appear in
`advisers --help`.

### `search --json` (0.4.0)

`advisers search <q> [--scope turns|kb|pages|facts|all] [--client/--matter/--kind]
[--limit 1..200] [--clearance 0-3] [--json]`

- **Without `--scope`** the command keeps 0.3.2 behaviour byte for byte: plain turn
  search with the same human lines; `--json` does not change that legacy path.
- `--json` and the scoped path are additive and require `--scope`.
  `search --scope turns --json` returns the unified envelope for turns only.
- `kb search <q>` is the KB alias (`--scope kb|pages|all`).
- Scope behaviour in 0.4.0: `kb` searches document titles + chunks; `pages` searches
  compiled pages; `all` merges KB + pages + turns. The value `facts` is accepted by
  the parser but **currently resolves to the KB scope** — fact/preference search is
  still `memory search` / the legacy `search` path; a real fact scope is a 0.4.x
  item, so `counts.facts`/`counts.preferences` stay 0 in the scoped payload.
- `--client`/`--matter`/`--kind` filter KB/pages hits; turns are not filtered.
- Query length is capped at 200 code points (`E_QUERY_TOO_LONG`). A 3+ character
  query uses FTS `MATCH`; a 2-character CJK query or an untokenizable token uses a
  `LIKE` scan and adds `degraded` values. FTS syntax is never passed through.

```json
{
  "ok": true, "command": "search", "query": "报价", "scope": "kb",
  "limit": 20, "clearance": 3, "degraded": ["short_query_like"],
  "counts": {"turns": 0, "kbDocs": 1, "kbChunks": 3, "kbPages": 0, "facts": 0, "preferences": 0},
  "hits": [
    {"kind": "kb_doc", "ref": {"kind": "kb_doc", "id": "kb_..."}, "docId": "kb_...",
     "title": "报价单", "snippet": "", "highlights": [], "matchPath": "title", "at": "..."},
    {"kind": "kb_chunk", "ref": {"kind": "kb_chunk", "id": "chk_..."}, "docId": "kb_...",
     "title": "报价单", "snippet": "...报价...", "highlights": [{"start": 0, "end": 2}],
     "matchPath": "like"}
  ],
  "total": 4, "truncated": false, "protectedExcluded": 0
}
```

Hit kinds: `turn`, `kb_doc`, `kb_chunk`, `kb_page`, `fact`, `preference`. `ref` is a
stable reference (`{kind,id}`); KB ids are never reused. `highlights` are character
offsets into `snippet` (never HTML/Markdown), and `protectedExcluded` counts rows
hidden by clearance (only the count is emitted).

### `kb add|ls|show|rm|purge|reindex --json` (0.4.0)

Full semantics, formats and limits: [KB.md](KB.md).

- `kb add <file>...` always returns the **batch envelope** (one file is a batch of one):

```json
{
  "ok": true, "command": "kb add",
  "counts": {"added": 1, "skipped": 0, "failed": 0, "chunks": 16, "textBytes": 12000},
  "added": [{"id": "kb_...", "title": "报价单", "kind": "contract", "sizeBytes": 10123,
             "textBytes": 12000, "chunks": 16, "truncated": false, "needsOcr": false,
             "encoding": "utf-8"}],
  "skipped": [], "failed": [],
  "truncated": 0, "needsOcr": 0
}
```

  `truncated`/`needsOcr` are **counts** of the added files that hit a limit or need OCR,
  not booleans. `skipped` is `[{file,code:"E_KB_DUPLICATE",existingId}]` where `file`
  is a basename; `failed` is `[{file,code,message}]` (also basename-only). A batch with
  failures exits 1; per-file duplicates are skip-level. `--from <list.txt>` appends
  one path per line (`#` comments allowed).
- `kb ls`: `{ok, command:"kb ls", documents:[document], total, truncated, limit, clearance, protectedExcluded}`.
  Filters: `--client`, `--matter`, `--kind`; `--all` includes tombstones (they carry
  `status:"deleted"`/`deletedAt`).
- `kb show`: `{ok, command:"kb show", document, chunks[], chunksTotal, clearance}`;
  `chunks` is empty unless `--chunks N` (0..20) is given; each chunk preview is ≤400 chars.
  `document.sourceName` is a basename; `sourceSha256` identifies the source bytes.
- `kb rm`: `{ok, command:"kb rm", removed:true, document, counts:{chunks}}`.
- `kb purge` (dry-run default): `{ok, command:"kb purge", dryRun:true, purged:false, document, counts:{chunks,factLinks}, hint}`;
  with `--yes`: `{ok, command:"kb purge", dryRun:false, purged:true, document, counts:{chunks,factLinks}}`.
- `kb reindex`: `{ok, command:"kb reindex", ...}` reports both KB FTS indexes and
  rebuilds only when inconsistent (`--rebuild` forces). It never re-reads source files.

### `kb page ls|show|rebuild|diff --json` (0.4.0)

Pages are deterministic, rebuildable projections of the local ledger; the four kinds
are `client`, `project`, `timeline`, `facts`. Full semantics: [KB.md](KB.md) §5.4.

- `kb page ls` → `{ok, command:"kb page ls", pages:[{id,kind,subjectId,title,generatedAt,status,inputsSha256,stale?}], total, truncated, limit, clearance, protectedExcluded, staleCount?}`.
  `--check` recomputes every page and reports `stale`/`staleCount` without writing;
  `--kind`, `--limit` and `--clearance` filter the list.
- `kb page show <id>` → `{ok, command:"kb page show", page:{id,kind,subjectId,title,markdown,data,sourceRefs,inputsSha256,generatedAt,status}, live:{inputsSha256,markdown,data,sourceRefs}, stale, stored:{exists,inputsSha256,generatedAt,status}, clearance, diff?}`.
  Live content is recomputed by default (pure read); `--stored` shows the stored copy;
  `--diff` adds a bounded unified diff when the page is stale.
- `kb page rebuild` → `{ok, command:"kb page rebuild", dryRun, counts:{built,written,unchanged,skipped}, pages:[{id,kind}], degraded[], clearance}`.
  Only changed hashes are written; `--only-stale` narrows the rebuild to stale pages;
  one `kb.page.rebuild` audit row. `--dry-run` reports the plan without writing.
- `kb page diff <id>` → `{ok, command:"kb page diff", pageId, stale, diff}`.

### `fact add|show|history|as-of --json` (0.4.0; add = 0.4.x follow-up)

Read-only fact views over the existing facts table (no migration). A fact row is
`{id,subject,predicate,object,matterId?,clientId?,authority,confidence,status,recordedAt,`
`validFrom?,validTo?,expiredAt?,supersedes?,supersededBy?,shadowedBy?,lastSeenAt?,`
`deletedAt?,deletedReason?,evidence[],fallback:{validFromFromRecordedAt}}`.

- `fact add <subject> <predicate> <object> --quote "evidence"` (0.4.2) →
  `{ok, command:"fact add", fact, deduped, audit}`. This is the manual write side of
  the facts table: `authority="user"`, `status="confirmed"`, `confidence=1`,
  `evidence:[{quote, source?}]`; repeat entry of the same active identity returns
  the existing row with `deduped:true` and writes nothing. `--matter`, `--valid-from`,
  `--supersedes <fact-id>`, `--doc <kb-doc-id>` and `--relation source|mentions` are
  optional; a supersede marks the old row `superseded` in the same transaction, and
  the audit row contains ids only (never the quote/subject/object).
- `fact show <id>` → `{ok, command:"fact show", fact, kbSources[], warnings[], includeDeleted}`.
  `kbSources` is additive and lists explicit KB links (`kb_fact_links`); manual
  `kb link` / `kb unlink` are wired in 0.4.1 (the 0.4.0 tarball exposed the library
  only, so the array is normally empty there).
- `fact history <id>` → `{ok, command:"fact history", rootId, items[], warnings[], counts:{items}, includeDeleted}`;
  walks `supersedes` back and `supersededBy` forward, tolerating broken links/cycles;
  tombstones are included by default (the chain is the audit history).
- `fact as-of <YYYY-MM-DD|ISO>` → `{ok, command:"fact as-of", at, asOfLocalDay, items[], counts:{groups,candidates,overlappingGroups}, warnings[], degraded[], includeDeleted, truncated}`.
  Date-only values mean the start of that Asia/Shanghai day; superseded facts stay
  visible for the past; deleted facts require `--include-deleted`.

### `mail account ... --json` (0.4.0)

Credentials never appear in JSON, argv, the database, logs or audit rows; the
password is read from a TTY prompt or `--pass-stdin` (`--pass` is refused).

- `mail account add` → `{ok, command:"mail account add", account:{...,hasCredential}}`.
- `mail account ls` → `{ok, command:"mail account ls", accounts:[{...,hasCredential}], total}`.
- `mail account show <ref>` → `{ok, command:"mail account show", account:{...,hasCredential}}`.
- `mail account rm <ref>` → `{ok, command:"mail account rm", accountId, removed:true, credentialRemoved, messagesDeleted}`.
- `mail account test <ref>` (0.4.2) → `{ok, command:"mail account test", accountId, host, port, tls, mailbox, latencyMs, uidValidity, messages, capabilities:{count,list,flags:{starttls,uidplus,idle,move},auth}}`.
  Read-only probe: TLS/STARTTLS + LOGIN + CAPABILITY + EXAMINE, then LOGOUT; it never
  fetches bodies, writes no mail rows and uses the existing 30s bound. The built-in
  local `.eml` account has no server and fails with `E_MAIL_CONFIG` without network.

`mail link` and `mail dismiss` are wired in **0.4.1**; they were **not wired in the 0.4.0 tarball**.

### `mail sync|ls|show|extract|import|purge --json` (0.4.0)

- `mail sync [account]` → `{ok, command:"mail sync", accountId, mailbox, uidValidity?, fetched, inserted, skipped, failed, duplicates, needsResync, dryRun, full, durationMs}`; multiple accounts return `{ok, command:"mail sync", results:[...]}`.
  `--watch [--interval 300s] [--max-runs n]` (0.4.2) keeps the foreground
  command alive: each round opens the ledger, syncs and closes it again (so an idle
  watch does not hold the writer lock), a failed round backs off from 5s up to 5min,
  Ctrl+C stops after the in-flight round. `--json` prints the final
  `{runs, success, errors, consecutiveErrors, stopped, last, history, intervalMs,
  maxRuns, startedAt, finishedAt, durationMs}` summary. This is still an explicitly
  started foreground process, not an installed daemon.
  The only IMAP network path: read-only `EXAMINE`/`UID FETCH`, TLS only (implicit 993
  or opt-in STARTTLS; never a cleartext fallback). Messages + cursor + run row commit
  in one transaction after the network fetch. A UIDVALIDITY change is
  `E_IMAP_UIDVALIDITY` and requires `--full`; nothing is deleted.
- `mail ls` → `{ok, command:"mail ls", messages:[message], total, limit, offset, truncated}` where
  `message = {id,accountId,mailbox,uid,uidvalidity?,messageId?,dedupeKey,from,subject,sentAt?,receivedAt,sizeBytes?,retained,purgedAt?,bodySha256?,attachments[],clientId?,projectId?,status,candidateIds[],createdAt,updatedAt}`.
  `attachments` is metadata only (`{name,size,mime}`); attachment bytes are never stored.
- `mail show <id>` → `{ok, command:"mail show", message}`; `--body` adds `bodyText`
  (only while the body is retained, otherwise `E_MAIL_NOT_RETAINED`).
- `mail extract [ids|--all-new] [--local|--model]` → `{ok, command:"mail extract", mode:"local"|"model", dryRun, scanned, candidates:[Candidate], skipped, failed, failures?, safetyWarnings?}`.
  `--local` is the default (zero network, no key). `--model` requires explicit
  `--yes` + `ADVISERS_API_KEY` + consent + `secrecy == 0`; candidates are always
  `pending` and are never auto-accepted. `Candidate` reuses the
  `memory candidates --json` shape with mail evidence (`{quote, source}`; no turn).
- `mail import <file|dir>` (`.eml`/`.mbox`) → `{ok, command:"mail import", accountId, dryRun, files, scanned, inserted, skipped, failed}`.
  Offline fallback for providers without password IMAP (Gmail Workspace/M365).
- `mail purge [--older-than 30d]` → `{ok, command:"mail purge", dryRun, messagesPurged|wouldPurge, bytesFreed|bytesWouldFree, skippedPending}`.
  Default retention is 30 days per account; metadata/`bodySha256` stay and messages
  with pending candidates are skipped.

### `sync pull --dry-run` (0.4.2)

`advisers sync pull --dir <dir> --dry-run [--file name] [--force] [--json]` runs the
same snapshot selection/decryption/SHA-256/local-state checks as a real pull and
returns `{...pullBase, changed:false, dryRun:true, wouldChange, wouldStatus,
wouldBackup}`; it writes no database, backup, staging temp or audit row. The
passphrase is still required (the snapshot must be decrypted to decide), and the
snapshot's `quick_check` is intentionally deferred to the real pull. Human output
starts with `dry-run:`. This is the safe preview for the manual file-based E2EE
sync; it is not a discovery mechanism for snapshots.

### `receivable|payment --json` (0.4.0)

The money sidecar records operator-entered local bookkeeping; it never moves money
and never prints amounts into reminders, receipts, MCP/DSH or Pet Brief. Amounts are
accepted as decimal strings ("8000.00"), stored as integer minor units (BigInt),
capped at 1e12 minor units, and limited to CNY/USD/EUR/HKD (no FX, no cross-currency
totals). Full semantics: [CLIENTS.md](CLIENTS.md) §11.

- `receivable add` → `{receivable, commitment, createdMatter}` (write commands return
  the library payload directly, without an `ok`/`command` envelope). `commitment` is
  the follow-up "回款跟进" commitment that drives reminders; `createdMatter` says a
  "回款" matter was created for the client.
- `receivable edit` → `{receivable, commitment}`; `receivable void` →
  `{receivable, alreadyVoid, reopenedCommitment, droppedCommitment, reason?}`.
- `receivable show` → `{ok, command:"receivable show", receivable, payments:[payment], clearance, protectedExcluded}`.
- `receivable ls` → `{ok, command:"receivable ls", receivables:[row], totals:[currencyTotal], total, truncated, limit, clearance, protectedExcluded}`.
  Row: `{id,commitmentId,label,kind,memo?,clientId,clientName,projectId?,matterId?,deliveryId?,amountMinor,amount,currency,paidMinor,paid,outstandingMinor,outstanding,overpaidMinor?,overpaid?,state,dueAt,overdueDays,payments:{count,lastPaidAt?},reminderOffsets?,createdAt,updatedAt?,writtenOffAt?,deletedAt?,closedByPaymentId?}`.
  `state` is derived (`open|partial|overdue|settled|written_off|void`) and never stored.
- `payment add` → `{payment, receivable, commitment, completedCommitment}`; a full
  payment completes the follow-up commitment in the same transaction unless
  `--no-complete`. `payment void` → `{payment, receivable, alreadyVoid, reopenedCommitment, reason?}`
  and reopens that commitment only when the payment is the one that closed it.
- `payment ls` → `{ok, command:"payment ls", payments:[row], total, truncated, limit}`;
  row: `{id,clientId,commitmentId?,amountMinor,amount,currency,paidAt,method,memo?,deletedAt?,createdAt,updatedAt?}`.
- `receivable ls --aging` returns the summary payload
  `{ok, command:"receivable summary", total, unsettled, settled, overdue, writtenOff, void, totals[], unmatchedPayments[], nextDueAt, clearance, protectedExcluded}`.
- `client show --json` adds `receivables:{count,overdueCount,totals[],nextDueAt,protectedExcluded}`
  (additive; amounts are per-currency and never sum across currencies).

### `consent status|grant|revoke --json` (0.4.0)

Consent is a separate, revocable record for model egress (`$ADVISERS_HOME/consent.json`,
0600); accepting the TOS is **not** model-egress consent.

- `consent status` → `{ok, command:"consent status", path, configured, entries:[entry]}` where
  `entry = {surface,dataClass,provider,baseUrl?,grantedAt,channel,revokedAt,active}`.
- `consent grant <surface> [--data-class mail|kb] [--provider] [--base-url]` →
  `{ok, command:"consent grant", version, entry, record, auditWritten}`.
  TTY requires an explicit confirmation; non-interactive requires `--yes`;
  grant/revoke/use are audited (no message bodies or quotes).
- `consent revoke <surface>` → `{ok, command:"consent revoke", revoked, entries, record, auditWritten}`
  (`revoked` is the count of revoked entries; rows are kept with `revokedAt`).

Provider/base-url changes invalidate a prior grant; `mail extract --model` refuses
without a matching active grant (`E_POLICY_CONSENT_REQUIRED`).

### `privacy --matrix --json` (0.4.0)

```json
{
  "ok": true, "command": "privacy --matrix",
  "policyVersion": 1, "rulesetVersion": "2026.11.4", "generatedAt": "...",
  "rows": [{"surface": "mail.extract", "description": "...", "actions": ["read", "model-egress"],
    "dataClass": "mail", "sink": "model", "default": "off",
    "gate": "enforced-policy", "tosRef": "docs/TOS.md#9.3", "doc": "docs/ARCHITECTURE.md"}]
}
```

`privacy` keeps its existing `--json` facts; `--matrix` is additive. The matrix is
generated from the policy surface registry, and each row's `gate` is honest:
`enforced-policy`, `legacy-gate`, `self-attested` or `not-wired`. Do not read it as a
claim that every surface is fully policy-enforced (see [ARCHITECTURE.md](ARCHITECTURE.md) §9).

### `client export --pack --json` and the client status pack v2 (0.4.0)

`advisers client export <id> --pack [--out <dir>] [--force] [--json]` writes a directory pack
(`manifest.json`, `status.md`, `status.json`, `README.txt`, `SHA256SUMS`; 0700 dir /
0600 files, all files covered by coreutils-format sums). Without `dir` it defaults
under `$ADVISERS_HOME/exports/client-<id>-<timestamp>/`; a non-empty target is
refused unless `--force` is used (the old tree is moved aside, never deleted
silently). The pack contains **no receivable/payment amounts** in 0.4.0
(`--include-receivables` is reserved for 0.4.1 after legal sign-off and fails closed).

```json
{
  "ok": true, "command": "client export --pack",
  "format": "advisers-client-status-pack", "version": 1, "scope": "client",
  "subject": {"kind": "client", "id": "cl_...", "name": "王工"},
  "out": "/path/to/pack", "replaced": null, "generatedAt": "...",
  "counts": {"...": 0}, "bytes": 12000, "fileCount": 4, "checksumCount": 5,
  "manifestDigest": "<sha256>", "verificationBasis": "local-checksums-only",
  "verification": {"ok": true, "errors": [], "warnings": [], "fileCount": 4, "checksumCount": 5},
  "clearance": 0, "protectedExcluded": 0, "disclaimer": true
}
```

`advisers evidence verify <dir>` dispatches on `manifest.format`: a client status pack
uses the independent client-pack verifier (same envelope, plus `format`, `version`,
`verificationBasis`, `totalBytes`, `limitViolation`), a delivery-receipt pack uses the
receipt verifier, and an evidence pack keeps the existing evidence verifier. Offline
verification proves internal consistency + SHA-256 only; it is not a signature or a
third-party attestation (`verificationBasis: "local-checksums-only"`).

### 0.4.0 additive fields on existing read models

- `agenda --json`: commitment items (including `overdue[]`, `days[].items`,
  `waiting[]`, `unscheduled[]`) gain an optional `urgency`; calendar items never do.
  `urgency = {id,modelVersion:1,score,level,terms:[{id,contribution,explain}],topFactors[],whyNow,dueAt,excluded,degraded}`.
  It is derived at read time and is **not** part of `dataSha256`.
- `morning --json`: adds `top:[{id,kind,title,localTime?,urgency,whyNow,source:"today"|"overdue"}]`
  (≤3 by default, `--top 1..5`), `urgencyModelVersion:1`, and `archive:{path,latestPath,keep,bytes,removed[],failed[]}`
  when `--archive` was used. `counts` and `dataSha256` are unchanged, and the full
  `mustDo` list keeps its 0.3.2 meaning.
- `remind --json`: keeps `now`/`reminders` and adds `ok:true`, `command:"remind"`,
  `timezone:"Asia/Shanghai"` and an optional per-reminder `urgency`. `--now ISO`
  fixes both the planning instant and the echoed `now`. `--json` is a pure read and
  never delivers notifications.
- `remind --deliver --notify` (0.4.1): `--quiet-hours
  HH:MM-HH:MM` suppresses notification channels inside the window (the local
  `reminders.log` line is still written and the recorded channel is
  `quiet-suppressed`); a second delivery for the same commitment/bucket/rule/local
  day is recorded as `deduped`; `--force-notify` bypasses both policies for one
  explicit run. These are delivery side effects only; `--json` output is unchanged.
- `evidence show --json`: additive `resolution`, `quoteVerified`, `notChecked[]`,
  `summary.notCheckedCount` and (for facts) `kbSources[]`. The four resolutions are
  `verified|missing|unverifiable|not_checked`; manual operator evidence stays
  `unverifiable(operator_entered)`, and purged mail bodies are
  `unverifiable(source_not_retained)`, never `missing`.
- `deliveries --pack`: the evidence-pack manifest moves to **v2** (additive
  `byKind{observed,derived,inferred,manual}`, `notCheckedCount`,
  `verificationBasis:"build-time"`, typed source rows with `kind/type/resolution`).
  The verifier accepts v1 and v2 packs; `deliveries --receipt` keeps its separate
  delivery-receipt manifest v2 (subject/scope/lineage) from 0.3.2.
- `status --json`: additive 0.4.0 counts `receivables` and `payments` (row counts,
  never amounts); existing v1 keys keep their meaning. Treat any further new key as
  additive.

## 0.4.3 additive surfaces (2026-11-22)

All new shapes are additive; the 0.4.2 shapes above are unchanged. New commands
are documented-additive (no frozen v1 entry removed).

- `commit add/edit --due` and `receivable add/edit --due` accept Chinese relative
  dates (今天/明天/后天/周X/下周X/月底/季度末/N 天后/YYYY-MM-DD/ISO). Human output
  adds a `due 解析：…` line; JSON adds a `due:{raw,at,calendar,basis,ambiguous}`
  object. Failures are `E_DUE_UNRESOLVED` (unparseable) and `E_DUE_CONFLICT`
  (multiple different dates); the raw string is never written to the ledger.
- `capture --file -` / positional `-` reads stdin; `capture --rules` (or
  `--local`) forces the zero-model local rules even when a model key is set.
  With no key, capture now defaults to local rules (pending candidates),
  prints a `[local]` note on stderr and performs zero network calls;
  `capture --model` keeps the 0.4.2 key requirement. Empty/oversized input are
  `E_CAPTURE_EMPTY`/`E_CAPTURE_TOO_LONG`.
- `inbox ls|show [--json]`: read-only view over pending memory candidates with
  clearance filtering before counting (`protectedExcluded`), no accept and no
  writes. Unknown/not-pending ids are `E_CANDIDATE_NOT_FOUND`; above-clearance
  rows are `E_POLICY_DENIED`.
- `doctor --report --json`: `{ok,mode:"report",reportVersion:1,generatedAt,
  advisersVersion,schemaVersion,measured,nulls,notices,limitations}`.
  `measured` keys (modelQuality, semanticCorrectness, captureQuality,
  independentGoldStandard, realMailAccount, win11RealMachine, windowsClientIme,
  officeAppFidelity, externalTimestamp) are explicitly `null` with one reason
  per `nulls[]` entry; they must never be reported as 0/false/PASS.
- `privacy --prove --brief [--json]`: a fixed four-line brief
  (at-rest/sync/export/egress) sourced from PRIVACY/SYNC/AT-REST-VAULT; without
  `--brief` the 0.4.2 output is unchanged.
- `profile show|export` (JSON/Markdown): read-only grouping of preferences by
  scope/kind with authority/lastConfirmed/decay/priority and a deterministic
  `dataSha256`; `export` requires an explicit `--out` (0600). No writes/model/
  network.
- `mail sync --watch`: `--once`, `--json-lines`, `--json`; JSON stdout is a
  single final summary (round lines go to stderr). Exit codes: 0 = at least one
  successful round, 1 = all rounds/config failed, 130 = SIGINT, 143 = SIGTERM.
  An empty account list fails immediately with `E_MAIL_CONFIG` (no empty round).
- `remind --ics`: emits `VTIMEZONE` (`TZID=Asia/Shanghai`), local-wall
  `DTSTART;TZID=…` and a VALARM description carrying the commitment id; the
  default human/JSON reminder output is unchanged. `remind --deliver --notify`
  adds a per-commitment 24h notification cooldown; the local reminders log is
  still written on every delivery and `--force-notify` bypasses the cooldown.
- `template quote`/`template proposal` schema v2 (explicit `schemaVersion:2`)
  adds `payment.channels[]` (bank/wechat/alipay/stripe_link/wise_link, masked
  accounts/URLs); v1 documents still reject the field and their output is
  unchanged. `verify --content --template quote` adds
  `quote.payment_channels`, `quote.payment_url` and `quote.no_full_account`.
- `receivable export --csv --out <file>`: RFC 4180 CRLF, 16 fixed columns,
  deterministic order, no totals, formula-injection prefix, 0600 file; `--out -`
  writes only the CSV to stdout. `--json` returns metadata only (no customer
  names/amounts). Requires an explicit `--out` (no HOME default path).
- `--help` / `-h` is a global short-circuit: no command or subcommand executes
  side effects, including `init`, `ui`, `purge` and nested subcommands; it does
  not require TOS acceptance or a HOME.

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
