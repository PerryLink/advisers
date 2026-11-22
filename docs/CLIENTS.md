# Customer and project entities (0.3.0; 0.4.0 money sidecar, offline status packs and mail hints)

Advisers 0.3.0 adds a **customer/project dimension** on top of the existing matter
dimension. It is deliberately small: a client is who the work is for, a project is
one job for that client, and a note is a manual timeline entry. There is no CRM
pipeline, no lead scoring, no automatic customer detection and no fuzzy merge.

0.4.0 keeps every 0.3.x invariant and adds three additive surfaces on the same
dimension: a **receivables/payments money sidecar** (§11), an offline-verifiable
**client status pack v2** (§9.2) and **mail-to-client hints** that are shown but
never bound automatically (§12).

- Status: **0.4.1, schema v22** (`SCHEMA_VERSION = 22`). The customer tables are
  still the three v21 tables (`clients`/`projects`/`client_notes`); v22 adds the
  money sidecar (`receivables`/`payments`) plus the KB/mail tables.
- Store: SQLite only. The legacy `ADVISERS_STORE=json` store has no customer
  tables, so every `client`/`project` command fails with `E_STORE` there.
- Wire format: `LedgerSnapshot.version` stays **1**. Customer rows are
  SQLite-only and never enter the ledger snapshot; only `matters.clientId/projectId`
  and the delivery lineage columns are additive row fields.

## 1. Concepts and invariants

| Concept | Table | Notes |
|---|---|---|
| Client | `clients` | `cl_…` id; display name + aliases; tags; default secrecy; archived rows are tombstones. |
| Project | `projects` | `prj_…` id; belongs to **exactly one** client; optional start/due dates. |
| Client note | `client_notes` | `note_…` id; `note|call|meeting|decision|email-summary`; the manual timeline source. |
| Matter ownership | `matters.client_id/project_id` | Nullable. A matter may belong to a client, a client project, or to neither (unclassified). |

1. **Matter is the ownership unit; clients/projects are not a fourth ledger.**
   Commitments and facts keep pointing at a matter only; a client/project inherits
   its work through `matters.client_id/project_id`. Re-linking never rewrites
   commitments, so the same fact can never exist twice.
2. **Unclassified work stays visible.** Rows written before v21 keep `NULL` ownership;
   `matter ls` shows them by default and `matter ls --unclassified` lists only them.
   The CLI never invents a customer for an unlinked matter.
3. **The timeline is derived, never stored.** `client show`/`client timeline`/`project show`
   merge `commitments` (by matter ownership), `deliveries` (by matter ownership) and
   `client_notes` in one read snapshot. There is no event table and no stored
   counter, so the view cannot disagree with its sources.
4. **A commitment is placed at its creation instant (`createdAt`), never at its due
   date.** A future due date is a field on the timeline row, not history. Rows that
   cannot be dated (pre-v21 commitments without `created_at`) are skipped and
   reported in `degraded[]` — the CLI never invents an instant.
5. **Nothing is hard-deleted.** `client archive`/`project archive` set
   `status='archived'` and a `deleted_at` tombstone. A name may be reused after
   archiving; the partial unique index only covers live rows.
6. **Every write is one audited transaction.** Each write command appends exactly
   one `audit` row inside the same `BEGIN IMMEDIATE` as the business row. Audit
   reasons contain ids/counts only — never names, notes, titles or paths.
7. **Every read is one lock-free snapshot, scoped by the entity's own matter ids.**
   No full-table read followed by an in-memory filter: client A's SQL can never
   return client B's rows.

> **Audited boundary (2026-11-22).** An independent cross-check confirmed the
> timeline is **derived, never captured automatically**: mail, IM and calendar do
> not create a timeline row; only commitments, deliveries and manual notes do. It
> also confirmed the delivery surface is wider than "a few templates": 6 builders
> (DOCX/XLSX/PPTX/XMind/Mermaid/draw.io), 7 generic templates plus deterministic
> `template quote|proposal`, `office-read`/`office-edit`/`verify` and delivery
> receipt packs. The real limitation is no Office/WPS application-layer rendering
> fidelity and no automatic sending — not the generation surface. See
> [AUDIT-2026-11-22.md](AUDIT-2026-11-22.md).

## 2. Commands

```sh
advisers client add "<name>" [--aliases a,b] [--tags t1,t2] [--secrecy 0-3] [--note text] [--link-matter <id>] [--json]
advisers client list [--all] [--limit n] [--json]
advisers client show <id> [--timeline-limit n] [--clearance 0-3] [--json]
advisers client timeline <id> [--since 90d|ISO] [--kind delivery,note,commitment] [--limit n] [--clearance 0-3] [--json]
advisers client archive <id> [--dry-run] [--json]
advisers client merge <from-id> <into-id> [--dry-run] [--json]
advisers client note add <id> "<summary>" [--kind note|call|meeting|decision|email-summary] [--at ISO] [--project <id>] [--matter <id>] [--json]
advisers client note list <id> [--project <id>] [--limit n] [--json]
advisers client export <id> [--format md|docx] [--out <file>] [--redact-names] [--json]
advisers client export <id> --pack [--out <dir>] [--force] [--json]   # offline-verifiable pack (0.4.0)

advisers project add <client-id> "<name>" [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--default-matter <id>] [--note text] [--json]
advisers project list [--client <id>] [--all] [--limit n] [--json]
advisers project show <id> [--timeline-limit n] [--clearance 0-3] [--json]
advisers project archive <id> [--dry-run] [--json]

advisers matter add <title> [--secrecy 0-3] [--domain d] [--summary s] [--client <id> [--project <id>]] [--json]
advisers matter ls [--all] [--client <id>] [--project <id>] [--unclassified] [--json]

advisers receivable add <client-id> "<label>" --amount 8000.00 [--currency CNY|USD|EUR|HKD] [--due YYYY-MM-DD]
    [--project <id>] [--matter <id>] [--kind quote|milestone|retainer|other] [--memo text]
    [--remind-offsets "-3d,-1d"] [--no-remind] [--json]
advisers receivable ls [--client <id>] [--project <id>] [--status open|partial|overdue|settled|all]
    [--currency c] [--due-within 7d|30d] [--clearance 0-3] [--limit n] [--json]
advisers receivable show <rcv-id> [--json]
advisers receivable edit <rcv-id> [--amount 9000.00|--due ...|--memo ...|--kind ...] [--json]
advisers receivable void <rcv-id> [--reason text] [--json]
advisers payment add <client-id> --amount 4000.00 [--currency c] [--paid-at ISO]
    [--method bank|wechat|alipay|cash|other] [--receivable <rcv-id>] [--memo text] [--no-complete] [--json]
advisers payment ls [--client <id>] [--receivable <rcv-id>] [--since 90d|ISO] [--limit n] [--json]
advisers payment void <pay-id> [--reason text] [--json]
```

`client ls`/`project ls` are accepted aliases of `list`. `client note ls` is an alias
of `client note list`.

Semantics:

- `client add` rejects a duplicate live name (NFKC-folded, whitespace-collapsed,
  Latin case-insensitive) with `E_CLIENT_DUPLICATE`; an alias owned by another live
  client is `E_CLIENT_ALIAS_CONFLICT`. `--link-matter` links an existing matter in the
  same transaction.
- `project add` requires a live client; project names are unique per client
  while active (`E_PROJECT_DUPLICATE`).
- `matter add --client`/`--project` goes through the store's ownership writer, so an
  unknown/archived entity fails closed instead of writing a dangling id. `--project`
  requires `--client`.
- `client archive` refuses while the client has active projects
  (`E_CLIENT_HAS_ACTIVE_PROJECTS`); `--dry-run` reports `wouldBlock` without writing.
- `client merge` is explicit user intent (no fuzzy matching). In one transaction it
  re-points matters, notes and delivery lineage snapshots to the target client, moves
  projects (same-name active projects are merged onto the target project and the
  duplicate is archived), carries the source name/aliases as target aliases when no
  third client owns them, and archives the source client. It never merges matters.
- `--since` accepts a relative window (`90d`, `24h`) or an ISO timestamp;
  `--kind` accepts a comma list of `delivery,note,commitment`.
- Timeline ordering is frozen: `at` DESC, then kind order
  `delivery > note > commitment`, then id ASC. `--limit` defaults to 20 and is
  clamped to 200; `total`/`truncated` describe the page.

## 3. JSON contract (additive)

Every command keeps `--json` stdout pure JSON; errors are
`{error:{code,message,hint?}}` on stderr with exit 1 (exit 3 when the TOS gate blocks).

- `client list --json` → `ClientRow[]`:
  `{id,name,nameNorm,aliases,status,tags,secrecyDefault,notes?,createdAt,updatedAt,deletedAt?,counts,nextDueAt,clearance,protectedExcluded}`.
- `client show --json` →
  `{ok,command,client,projects[],matters[],counts,open{mine[],waiting[]},nextDueAt,timeline[],timelineTotal,timelineTruncated,nextCursor,clearance,protectedExcluded,degraded[]}`.
- `client timeline --json` →
  `{ok,command,clientId,client:{id,name},items[],total,truncated,nextCursor,clearance,protectedExcluded,degraded[]}`.
- `client export --json` (0.3.2) → `{ok:true, command:"client export", format, scope:"client", subject{kind,id,name}, out, bytes, sha256, generatedAt, clearance:0, protectedExcluded, counts, nextDueAt, timelineCount, timelineTotal, timelineTruncated, disclaimer:true}`; the written file itself is one deterministic markdown/DOCX status sheet (mode 0600, fixed disclaimer, no evidence quotes or note bodies).
- `client add|archive|merge --json` → `{ok,command,...}` with the affected client
  (merge adds `mergedFrom,movedMatters,movedProjects,mergedProjects,movedNotes,movedDeliveries,carriedAliases`).
  merge also re-points `receivables`/`payments` in the same transaction (0.4.0).
- `client show --json` adds `receivables:{count,overdueCount,totals[],nextDueAt,protectedExcluded}`
  (0.4.0 additive; per-currency totals, no cross-currency sum).
- `client export --pack --json` → the client status pack summary
  (`{ok,format,version,scope,subject,out,replaced,generatedAt,counts,verificationBasis,fileCount,checksumCount,bytes,manifestDigest,includeReceivables:false,files[],verification}`).
- `client note add|list --json` → the note row / `NoteRow[]`.
- `project list --json` → `ProjectRow[]`; `project show --json` →
  `{ok,command,project,client,matters[],counts,open,nextDueAt,timeline,...}`.
- `matter ls --json` rows now carry the real `clientId`/`projectId` (they were
  hard-coded `null` before v21); `matter show --json` adds resolved
  `client`/`project` objects (the raw ids stay on `matter`).
- `status --json` adds `clients` and `projects` (active counts, additive keys).
- `deliveries --json` rows add `clientId/projectId/templateName/templateVersion/quoteNo/dataSha256`
  when the delivery has that lineage (old rows keep their old shape).

`counts` (same shape everywhere) is
`{matters,mattersArchived,deliveries,notes,commitments,openMine,openWaiting,overdue}`
with exact SQL counts for the rows the caller may see. `openMine` = we owe the
client (`debtor` not `third:*`); `openWaiting` = the client owes us.

Timeline item shape: `{at,kind,title,ref:{kind,id},matterId?,projectId?,secrecy,status?,dueAt?,doneAt?,debtor?,creditor?,templateName?}`.

## 4. Clearance and secrecy

The local CLI shows the user's own data; `--clearance N` is the **opt-in** gate for
output that will leave the local context (`N` is 0..3, default 3):

- effective secrecy of a matter = `max(client.secrecyDefault, matter.secrecy)`;
- a matter (and every commitment/delivery belonging to it) above `N` is withheld;
  a client-level note is withheld when the client default is above `N`;
- withheld rows are **counted only** (`protectedExcluded`) — no id, title, name,
  note text or quote is printed;
- the filter runs **before** counting, paging and limiting, so `counts`/`total` cannot
  leak the existence of a hidden row;
- every visible timeline item carries its `secrecy` label, so a consumer never has to
  guess.

This is a local projection gate, not a permission system: it does not provide
security against the local user or a compromised local process. The external
surfaces built on the same rule (0.3.2) are `deliveries --receipt --client`, the
`client export` status sheet and the MCP/DSH customer read tools; they all run at
clearance 0 and report only a `protectedExcluded` count for hidden rows.

## 5. Export / import parity

- `advisers export --all` carries every table in the store's single
  `DATA_TABLES` list, including `clients`, `projects` and `client_notes` (raw
  snake_case rows), plus an additive `schemaVersion`. In 0.4.0 the list also carries
  `receivables`/`payments` and the KB/mail tables; the export therefore contains
  customer names, **money amounts** and KB/mail text in plaintext (use
  `--encrypted` when that matters).
- `advisers import <file> --replace` restores the nine ledger tables **and** the
  three customer tables in one transaction. A dangling reference (project → missing
  client, matter → missing client/project, note → missing matter, a matter attached
  to another client's project) aborts the import and rolls everything back; the
  pre-import backup remains as a second safety net.
- **Money/KB/mail import parity (0.4.0)**: `import --replace` restores the same
  `DATA_TABLES` list in one transaction, including `receivables`/`payments`, the KB
  tables and the mail tables. `mail_cursors` is never imported (a lost cursor only
  costs one rescan; messageId dedupe prevents duplicates), derived FTS indexes are
  rebuilt rather than imported, and `kb_pages` is dropped because its inputs changed
  (run `kb page rebuild` afterwards). A 0.3.2-era export without money tables clears
  `receivables`/`payments` so old commitments are never left with dangling money
  rows; any dangling reference inside the imported set aborts the whole transaction.
- An export whose `schemaVersion` is newer than this CLI is refused
  (`E_SCHEMA_NEWER`) before any write. Legacy exports without `data.clients`
  keep the old behaviour (ledger only) and say so.
- The `audit` table is **not** imported: the local hash chain is signed with this
  HOME's audit key, so another HOME's rows would not verify. Other SQLite-only
  tables (sessions/turns/deliveries/nudges/...) are not merged either; the command
  says so explicitly.
- Delivery lineage snapshots that point at a customer/project absent from the
  imported set are re-pointed when a project/matter still resolves, otherwise the
  snapshot is cleared; the count of reconciled rows is printed. This keeps
  `deliveries.client_id/project_id` referentially honest without rewriting history.

## 6. Delivery lineage

`template quote|proposal … --record-delivery --matter <id>` snapshots
`template_name/template_version/quote_no/data_sha256` on the delivery row and lets
the store snapshot `client_id/project_id` from the matter's ownership. The snapshot is
taken at generation time; re-linking the matter afterwards never rewrites an
already-generated delivery/receipt. A later receipt/verifier reads the row instead
of recomputing or guessing the lineage.

## 7. Limits (0.3.0, updated 0.4.0)

- `client list`/`project list` default limit 100 (max 1000); timeline sources are
  bounded at 200 recent rows per type (the page contract says `total`/`truncated`).
- `receivable ls`/`payment ls` default limit 50 (max 500); `receivable` totals are
  per currency and never summed across currencies.
- 0.3.2 adds the external customer surfaces: `deliveries --receipt --client/--project`
  (manifest v2 subject pack), `client export` (status sheet, md/docx), and the
  read-only MCP tool `advisers_clients` (plus `advisers://clients`) and DSH tool
  `advisers_clients`. 0.4.0 adds `client export --pack` (offline-verifiable
  directory) but keeps the MCP/DSH tools unchanged: **they still expose no money
  and no KB/mail content**.
- Pet Brief v3 still stays out (cross-repo consumer contract). Money is never
  written into a Pet Brief, delivery receipt, MCP/DSH payload or reminder body.
- No automatic customer inference from mail/transcripts; no fuzzy matching; no
  multi-client projects (a cross-client job is two projects); no hard delete.
- Customer rows are local-only in this version: `sync`/`vault`/`backup` operate on the
  whole database, so they include the customer tables (and the money sidecar) like
  any other local row.

## 8. Examples

```sh
advisers client add "王工" --aliases "王总" --tags 报价 --secrecy 1 --json
advisers project add cl_123 "官网改版" --start 2026-11-20 --json
advisers matter add "官网改版 · 报价确认" --client cl_123 --project prj_456 --json
advisers client note add cl_123 "电话确认预算 8 万" --project prj_456 --kind call
advisers client show cl_123 --json | jq '{counts, nextDueAt, timeline: .timeline[0:3]}'
advisers client timeline cl_123 --since 90d --kind delivery,note --json
advisers client show cl_123 --clearance 0 --json   # shareable: protected rows counted only
advisers matter ls --unclassified --json          # pre-v21 / not-yet-linked work
advisers export --all --out /secure/all.json && advisers import /secure/all.json --replace
advisers receivable add cl_123 "官网改版尾款" --amount 8000.00 --due 2026-12-15 --remind-offsets "-3d,-1d" --json
advisers payment add cl_123 --amount 4000.00 --method bank --receivable rcv_123 --json
advisers receivable ls --status overdue --currency CNY --clearance 0 --json
advisers client export cl_123 --pack ./share/cl_123 --json
advisers evidence verify ./share/cl_123
```

## 9. Receipt subjects, status sheet, status pack and read projections (0.3.2, extended 0.4.0)

- `deliveries --receipt --client <id> [--project <id>]`: a subject pack contains
  only that subject's delivered files and evidence. Delivery rows are matched by
  current matter ownership OR the generation-time `client_id`/`project_id`
  snapshot; evidence is scoped to the subject's matters (global facts/preferences
  need `--include-global`). The v2 manifest records `subject`/`scope`; README.txt
  and receipt.docx say the pack contains one subject's data. Row-level secrecy is
  `max(client.secrecyDefault, matter.secrecy)` at clearance 0; a subject client
  with a protected default fails closed (`E_SECRECY_BLOCKED`). A pack without a
  subject keeps the historical behavior but is labelled `scope: "local-all"` and
  warns that it contains all local customer data.
- `client export <id> --format md|docx`: deterministic, external-facing status
  sheet at clearance 0 (0600 file): profile, active projects, counts, open
  buckets, recent delivery/commitment timeline and a fixed disclaimer. It
  excludes evidence quotes and note bodies and is **not** a statement of account,
  contract or legal advice. `--redact-names` only replaces client/project display
  names. The export is audited (`client.export`, ids/counts only).
- MCP `advisers_clients` (`list`/`show`) and DSH `advisers_clients` read the same
  derived views at clearance 0: no note bodies, no evidence quotes, counts are
  post-clearance and capped payloads carry `total`/`truncated`. 0.4.0 does not add
  money or KB/mail content to these payloads.

### 9.2 Offline client status pack v2 (0.4.0)

`advisers client export <id> --pack [--out <dir>] [--force]` writes the same status
sheet as a **directory** instead of one file (default
`$ADVISERS_HOME/exports/client-<id>-<timestamp>/`; a non-empty target needs
`--force` and is moved aside, never silently deleted):

```text
client-status-pack/
  manifest.json    format "advisers-client-status-pack" v1, scope "client",
                   subject {kind,id,name}, generatedAt, counts, verificationBasis
                   "local-checksums-only", fileCount, files[{path,size,sha256}]
  status.md        the human status sheet (deterministic, same content as --format md)
  status.json      the machine payload (client export --json minus out/bytes/sha256)
  README.txt       scope, fixed disclaimer, verification steps
  SHA256SUMS       coreutils format, every pack file except itself
```

- The directory is 0700 and every file 0600 (best effort on Windows); the pack is
  built in a staging directory and renamed into place. A non-empty target is
  refused unless it is replaced atomically (the old tree is moved aside, never
  silently deleted).
- **No receivable/payment amounts** are included in 0.4.0. `--include-receivables`
  is reserved for 0.4.1 after legal sign-off and fails closed
  (`E_CLIENT_PACK_RECEIVABLES_UNSUPPORTED`) instead of leaking money.
- `advisers evidence verify <dir>` dispatches on `manifest.format` and runs the
  independent client-pack verifier (offline, no `~/.advisers`, no network). It
  detects edits, missing/extra files, unsafe or duplicate SHA256SUMS entries,
  malformed JSON/schema drift and manifest/checksum disagreement. Like every
  checksum-based verifier it cannot detect a forger who rewrites the whole pack and
  recomputes every hash; `verificationBasis: "local-checksums-only"` states exactly
  that, and the pack is a status statement, not a statement of account, contract,
  invoice, receipt, dunning letter or legal advice.
- `E_CLIENT_PACK_LIMIT` (structured `limitViolation`) caps the untrusted pack walk
  (entries, depth, single-file and total bytes, SHA256SUMS/manifest body sizes) so
  a hostile directory cannot exhaust memory before a verdict.

## 10. Errors

| Code | Meaning |
|---|---|
| `E_CLIENT_NOT_FOUND` / `E_CLIENT_ARCHIVED` | Unknown / archived client id. |
| `E_CLIENT_DUPLICATE` | A live client already owns that name. |
| `E_CLIENT_ALIAS_CONFLICT` / `E_CLIENT_ALIAS_NOT_FOUND` | The alias is owned by another live client / no such alias. |
| `E_CLIENT_HAS_ACTIVE_PROJECTS` | `client archive` blocked; archive/move the projects first. |
| `E_CLIENT_MERGE_SELF` | `merge from into` with the same id. |
| `E_PROJECT_NOT_FOUND` / `E_PROJECT_INVALID` / `E_PROJECT_ARCHIVED` | Unknown / invalid / archived project. |
| `E_PROJECT_DUPLICATE` | The client already has a live project with that name. |
| `E_PROJECT_CLIENT_MISMATCH` | A project does not belong to the given client. |
| `E_MATTER_CLIENT_MISMATCH` | A matter does not belong to the given client. |
| `E_CLIENT_INVALID` / `E_CLIENT_NOTE_INVALID` / `E_CLIENT_NOTE_NOT_FOUND` | Entity/note validation. |
| `E_DELIVERY_INVALID` | Invalid delivery lineage (client/project/template metadata). |
| `E_CLIENT_HAS_OPEN_RECEIVABLES` | `client archive` blocked by unsettled money rows (0.4.0; `--dry-run` reports `openReceivables`/`wouldBlock`). |
| `E_RECEIVABLE_NOT_FOUND` / `E_RECEIVABLE_INVALID` | Unknown / invalid receivable (including a row above the caller's clearance: fail closed, no id leak). |
| `E_PAYMENT_NOT_FOUND` / `E_PAYMENT_INVALID` | Unknown / invalid payment (amount, currency, date, deletion). |
| `E_CLIENT_PACK_LIMIT` / `E_CLIENT_PACK_RECEIVABLES_UNSUPPORTED` | Status-pack resource limit exceeded / money requested but not allowed in 0.4.0. |
| `E_STORE` | Customer entities need the SQLite store (`ADVISERS_STORE=sqlite`). |
| `E_SCHEMA_STALE` / `E_SCHEMA_NEWER` | Database older than v22 (run a writable command to migrate) / newer than this CLI (upgrade; do not downgrade in place). |
| `E_USAGE` | Bad arguments / unknown flag / missing id. |
| `E_TOS_REQUIRED` | Exit 3: the consent gate blocked the command (non-interactive). |

## 11. Receivables and payments (money sidecar, 0.4.0)

The customer domain can record **who owes how much and which cash events arrived**.
It is a sidecar on the commitment ledger, not a fourth ledger and not an accounting
system:

```text
commitments (the ledger's single "who owes whom" record)
  - receivables 1:1   money sidecar row (amount/currency/memo/tombstone)
      - payments 1:N  cash events (payment.commitmentId NULL = unmatched prepay)
```

Invariants:

1. **A receivable always has a follow-up commitment.** Creating one creates the
   commitment ("回款跟进") in the same transaction; that commitment is the only due
   date and reminder source, so `remind`/`today`/`who`/ICS/webhook work with zero new
   tables. The **amount never enters** the commitment action or evidence quote.
2. **Integer minor units only.** `--amount` is a decimal string ("8000.00"), parsed
   with BigInt into integer cents (max 1e12 minor units = 10,000,000,000.00); never
   floating point, no locale formatting. Four currencies: CNY, USD, EUR, HKD. No FX,
   no cross-currency totals, no automatic rounding (a remainder is an unmatched
   payment with a memo).
3. **Partial/multiple/over-payment are valid.** A payment's currency must equal its
   receivable's currency. A payment without a receivable is an unmatched prepayment
   and never reduces a balance.
4. **State is derived, never stored:** tombstone -> `void`; `written_off_at` ->
   `written_off`; paid >= amount -> `settled` (overpayment reported separately);
   overdue -> `overdue`; partial -> `partial`; otherwise `open`.
5. **Full payment completes the follow-up commitment in the same transaction**
   (manual evidence "payment <id>", `closed_by_payment_id` recorded) unless
   `--no-complete`. `payment void` reopens it only when that payment is the one that
   closed it and the outstanding balance is positive again; evidence history is never
   rewritten. A receivable with active payments cannot be voided and its amount
   cannot be edited while payments exist (void the payments first).
6. **One audited transaction per write.** Audit reasons contain ids/counts only —
   never an amount, a name, a memo or a free-form reason.
7. **Clearance runs before counting/paging** with
   `max(client.secrecyDefault, matter.secrecy)`; hidden rows only contribute to
   `protectedExcluded`, and a hidden id fails closed as `E_RECEIVABLE_NOT_FOUND`.
8. **Matter resolution for the follow-up commitment:** explicit `--matter` (must
   belong to the client), else the project's default matter, else the client's only
   active matter, else a "回款" matter is found or created for that client (the JSON
   reports `createdMatter: true`). Never silently attached to another client's matter.
9. **Lifecycle:** no hard deletes (`void` = tombstone). `client merge` re-points
   money rows in the same transaction; `client archive` fails closed while unsettled
   receivables exist; `purge <matter>` does **not** delete customer/money rows (see
   [PRIVACY.md](PRIVACY.md) §7.3).

Out of scope by design: invoices, receipts, statements of account, dunning letters,
bank/payment-channel reconciliation, FX, tax/accounting/legal advice, and any
movement of money. The rows are operator-entered local bookkeeping that the software
never verifies against a bank; `receivable show` may state that explicitly.

## 12. Mail-to-customer hints (0.4.0): show, never bind

`mail extract` can attach a **hint** to a candidate payload when the sender
address/domain, display name or message text matches a live client or project:

```json
{"clientHint":{"id":"cl_...","name":"王工","basis":"address-domain|from-name|message","confidence":0.75}}
{"projectHint":{"id":"prj_...","name":"官网改版","clientId":"cl_...","basis":"message","confidence":0.6}}
```

- Hints are **display metadata only**. Nothing is written to `mail_messages.client_id`,
  no commitment/fact is bound to a client, and no timeline row appears because of a
  hint. This preserves the 0.3.0 invariant "no automatic customer detection".
- `basis`/`confidence` are the honest match reasons: address-domain (0.75), exact
  From display name (0.8), message text (0.6). They are heuristics, not identifiers.
- Manual `mail link <id> --client/--project` / `mail dismiss <id>` are wired in
  **0.4.1** (the 0.4.0 tarball left them unwired; design 41 §3.5). They validate the
  ids, fail closed and write audit rows (`mail.link`/`mail.dismiss`); hints stay
  display-only and nothing is bound automatically.
- Mail content is never exposed to MCP/DSH, receipts, client packs, Pet Brief or
  KB in 0.4.0. See [KB.md](KB.md) and [MCP.md](MCP.md).

See [CLI-JSON.md](CLI-JSON.md) for the machine contracts and [ARCHITECTURE.md](ARCHITECTURE.md) for where the entities sit in the system.
