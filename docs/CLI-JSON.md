# CLI JSON contract v1 (E6-T1 + 0.2.0 data plane)

Advisers is CLI-first. Scripts should be able to consume every read-only view without
parsing human text. JSON mode never mixes human prose into stdout; diagnostics go to
stderr and `--json` must not require a TTY. Shapes are additive: new optional keys may
appear, existing keys keep their meaning.

## Current JSON surfaces (2026-11)

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
| `advisers evidence show <id> --json` | `{commitment\|fact\|preference,sources[],missing[]}` | v1 |
| `advisers evidence verify <dir>` | `{ok,errors[],warnings[],dir,fileCount,checksumCount,files[],checksums{},manifest}` | v1 |
| `advisers capture --json` / `capture --from-mail\|--from-transcript\|--from-imap --json` | `{ok,command,count,candidates[]}` (+ `seen,skipped,failed` for imports, `alreadyImported` on transcript dedupe) | v1 |
| `advisers memory candidates --json [--all]` | `Candidate[]` | v1 |
| `advisers verify <file> --json [--content]` | office `VerifyResult`: `{ok,checks[],entries,bytes,layers,...}`; with `--content`: `{structure,content}` | existing/office |
| `advisers privacy --json` | data/egress facts | v1 |
| `advisers export [--all]` | ledger JSON / ledger+SQLite tables | existing |
| `advisers office-edit ...` | `{ok,out,changes}` | existing |

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
```
