# Read-only ledger facade (`advisers/lib/ledger-read.js`)

Status: **0.3.0 contract**. The subpath is part of the `advisers` package's
published `exports` map and is a versioned contract: within 0.x it only grows
(new optional fields, new functions); existing names, shapes and error codes do
not change.

The facade is the single read-policy entry point for consumers that are not the
CLI writer path (today: the DSH adapter; later: MCP/pet-brief/other readers).
It never writes the ledger, never migrates it and never competes with the CLI
for the HOME write lock.

```js
import {
  LedgerReadError,
  resolveAdvisersHome,
  readLedgerStatus,
  readOpenCommitmentIndex,
  readEntityById,
  readLedgerSnapshot,
  readClientList,
  readClientById,
} from 'advisers/lib/ledger-read.js'
```

## Why a separate subpath

- `lib/sqlite.js` cannot be exported: it imports `node:sqlite` at module top
  level and exposes the write APIs (`save`/`migrate`/`mutate`/`purge`).
- The facade has **no top-level `node:sqlite` import**. A host without
  `node:sqlite` can still import the module; ledger calls then fail with the
  stable `E_LEDGER_UNAVAILABLE` code. The DSH adapter uses this to fall back to
  its marked preview instead of failing plugin load.
- Read policy (home resolution, TOS gate, vault/sealed detection, schema
  strictness, per-item clearance, error codes) is implemented once, here.

## Invariants (reviewed per release)

1. **Read-only**: opens the store with `readOnly: true` and only calls read
   methods. The facade imports neither `bin/advisers.js` nor `ensureHome` /
   `ensureInstanceLock` / `openStore` / `migrateUnderLock`.
2. **No HOME write lock**: a reader works while a writer holds
   `~/.advisers/instance.lock`. The facade never takes or removes that lock.
3. **No migrations**: `assertSchemaCurrent()` runs first; a stale schema is
   `E_SCHEMA_STALE` (a writable CLI command must migrate it), a newer schema is
   `E_SCHEMA_NEWER`. The facade makes no DDL/backup/checkpoint/vacuum calls.
4. **No HOME creation and no DB writes**: a missing home stays missing; a
   sealed vault is never replaced by an empty database; a corrupt database is
   never rebuilt.
5. **TOS gate**: an existing acceptance record for the *packaged* TOS version
   and text hash is required (`E_TOS_REQUIRED`, with a `reason`). The facade
   never records acceptance for the user and ignores the `ADVISERS_TOS_VERSION`
   environment override when deciding (an env var must not be able to fake
   consent). The packaged version on the 0.3.0 tree is **TOS v2026.11.3
   (2026-11-20)** (the legal-text version bump that adds the bridge/Hermes egress
   disclosure); an acceptance record for an older version/text triggers
   `E_TOS_REQUIRED` until the user re-accepts in the CLI, and the read-only
   consumers never accept on the user's behalf.
6. **Short-lived connection**: each call opens and closes its own connection so
   a `vault unseal` / `sync pull` inode replacement or a concurrent writer does
   not leave a stale long-lived reader.
7. **Per-item clearance, fail closed**: default `clearance = 0`; records whose
   matter secrecy is above the clearance are excluded and only counted
   (`protectedExcluded`), never partially returned. A record whose matter id
   cannot be resolved is treated as protected (Infinity).
8. **Path-free messages**: consumer-visible `message`/`hint`/`warnings` never
   contain an absolute filesystem path.
9. **Customer reads are SQLite-only projections (0.3.2)**: `readClientList` /
   `readClientById` derive list/status views inside one read snapshot with the
   same clearance rule (`max(client.secrecyDefault, matter.secrecy)`), return
   no note bodies and no conversation text, and never invent customer data: the
   legacy JSON backend reports `customerEntities:false` with an empty list.

Documented side effect: a read-only SQLite open may create the empty
`state.db-wal` / `state.db-shm` sidecars when they do not exist (SQLite WAL
requirement). The database bytes are not modified and no writer lock is created;
tests assert exactly this.

## Home resolution

`resolveAdvisersHome({ home })` resolves `options.home` -> `ADVISERS_HOME` ->
`~/.advisers` (the same rule as the CLI). An explicitly supplied `home` must be
an absolute path; a relative one throws `E_USAGE` (configuration error, not a
data error).

## Backends

- SQLite (`state.db`, default) — read-only connection.
- Legacy JSON (`state.json`) — when `ADVISERS_STORE=json`, or (only when
  `ADVISERS_STORE` is unset and no `state.db` exists) when only `state.json`
  is present. `backend` in the return values is `'sqlite'` or `'json'`.
  The SQLite path never falls back to JSON.

## API

### `readLedgerStatus({ home } = {}) -> Promise<Status>`

Diagnostic only; returns no ledger rows and does not throw for a data problem.

```js
{
  backend: 'sqlite' | 'json',
  dbPresent: boolean,
  sealed: boolean,
  statePresent: boolean,          // json backend
  schemaVersion: number | null,
  tos: { accepted: boolean, reason: string },
  warnings: string[],             // sanitized
  readable: boolean,
  reason?: 'absent' | 'sealed',
  error?: { code, message, hint? },
}
```

### `readOpenCommitmentIndex({ home, clearance = 0, all = false, limit = null })`

Targeted projection for the today / who / commit-ls views: one narrow
`SELECT id, debtor, creditor, action, due_at, matter_id, status FROM commitments`
(the open view uses `WHERE status = 'open'`, which hits
`idx_commitments_status_due`) plus the small matters table for the clearance
gate. It does **not** load a whole ledger snapshot or map evidence JSON.

```js
{
  rows: [{ id, debtor, creditor, action, status, dueAt?, matterId? }],
  total: number,                  // visible rows before `limit`
  protectedExcluded: number,
  clearance: number,
  schemaVersion: number | null,
  backend: 'sqlite' | 'json',
  readAt: string,                 // ISO-8601
  warnings: string[],
}
```

`all: true` includes non-open statuses (the commit-ls view); `limit` truncates
`rows` only, `total` stays the visible count.

### `readEntityById({ home, kind, id, clearance = 0 })`

O(1) primary-key point query (`getCommitment`/`getFact`/`getPreference`/
`getMatter`); the DSH evidence tool uses it. `kind` is one of `commitments`,
`facts`, `preferences`, `matters`.

```js
{
  record: object | null,          // null when missing OR withheld
  hidden: boolean,                // true => the record exists but is protected
  clearance: number,
  protectedExcluded: 0 | 1,
  schemaVersion: number | null,
  backend: 'sqlite' | 'json',
  readAt: string,
  warnings: string[],
}
```

`hidden` exists so a caller can distinguish 'withheld because protected' from
'does not exist' without leaking the record.

### `readLedgerSnapshot({ home, parts = null })`

Raw wire-v1 snapshot (`Ledger.toJSON` shape, optional table subset from
`matters/facts/commitments/preferences/links/updates/routines/routinePatches/
routes`). **No clearance projection**: it is intended for trusted in-process
consumers that build a core `Ledger`; do not hand it to a model/egress surface.

```js
{ snapshot, schemaVersion, backend, readAt, warnings }
```

### `readClientList({ home, clearance = 0, limit = 20, all = false })`

Read-only customer list (0.3.2 M3). Customer entities live only in the SQLite
store (schema v21), so on the legacy JSON backend this returns an empty list
with `customerEntities: false` instead of inventing rows. The list is
clearance-filtered per client BEFORE counting/paging: matters and client-level
notes above the clearance are counted in `protectedExcluded`, never returned.
No note body or conversation text is part of the payload.

```js
{
  clients: [{ id, name, status, aliases, secrecyDefault, tags,
              counts: { matters, mattersArchived, deliveries, notes,
                        commitments, openMine, openWaiting, overdue },
              nextDueAt, clearance, protectedExcluded }],
  total: number,                    // post-filter client count
  truncated: boolean,
  limit: number,                    // capped at 200
  clearance: number,
  protectedExcluded: number,        // protected matters/client notes on the page
  customerEntities: boolean,        // false => JSON store, empty list
  schemaVersion: number | null,
  backend: 'sqlite' | 'json',
  readAt: string,
  warnings: string[],
}
```

### `readClientById({ home, id, clearance = 0, timelineLimit = 20 })`

Read-only customer status view (0.3.2 M3): client identity (no notes body),
project summaries with counts, exact client counts, `open.mine/waiting`, the
next due date and a derived timeline. The timeline only contains
delivery/commitment rows (notes are counted, never displayed), ordered by
instant DESC, then delivery > commitment, then id ASC. A delivery whose matter
cannot be resolved inside the visible scope is treated as protected (counted,
never returned). An unknown id is `found: false, view: null` — not an error.

```js
{
  found: boolean,
  view: null | {
    client: { id, name, status, aliases, tags, secrecyDefault },
    projects: [{ id, name, status, counts, nextDueAt }],
    counts: { matters, mattersArchived, deliveries, notes, commitments,
              openMine, openWaiting, overdue },
    open: { mine: [], waiting: [], mineTotal, waitingTotal },
    nextDueAt,
    timeline: [{ at, kind: 'delivery'|'commitment', title,
                 ref: { kind, id }, matterId, secrecy }],
    timelineTotal, timelineTruncated, clearance, protectedExcluded,
  },
  clearance: number,
  customerEntities: boolean,
  schemaVersion: number | null,
  backend: 'sqlite' | 'json',
  readAt: string,
  warnings: string[],
}
```

Both functions use only the existing `LedgerReadError` codes: an invalid
`limit`/`timelineLimit` or `id` is `E_USAGE`; every gate failure is the same
code as the other read functions (`E_TOS_REQUIRED`, `E_VAULT_SEALED`,
`E_SCHEMA_STALE`, `E_SCHEMA_NEWER`, `E_LEDGER_CORRUPT`, `E_LEDGER_BUSY`,
`E_LEDGER_UNAVAILABLE`, `E_LEDGER_ABSENT`). No new error code is introduced.

## Error codes (frozen; only additive changes)

| code | meaning | user hint |
|---|---|---|
| `E_LEDGER_ABSENT` | no ledger in the home (first run / never initialised) | `advisers init` |
| `E_TOS_REQUIRED` | no acceptance record, or revoked / version-changed / text-changed; `reason` says which | `advisers tos show`, accept via CLI |
| `E_VAULT_SEALED` | `state.db.vault` exists but no plaintext database | `advisers vault unseal` |
| `E_SCHEMA_STALE` | on-disk schema older than this package | run a writable CLI command (`advisers doctor`) |
| `E_SCHEMA_NEWER` | on-disk schema newer than this package | upgrade `advisers`/`dsh-advisers` |
| `E_LEDGER_UNAVAILABLE` | `node:sqlite` unavailable, unreadable path, read-only volume, network filesystem, open failure | use a local readable home; Node >= 22.16 |
| `E_LEDGER_CORRUPT` | 0-byte / non-SQLite / unparseable JSON ledger | back up, never delete, run `advisers doctor` |
| `E_LEDGER_BUSY` | SQLite busy/locked on open | retry shortly |
| `E_USAGE` | caller/config error (relative `home`, unknown kind/part, bad limit/id) | fix the call |

Errors are `LedgerReadError` instances: `{ code, message, hint?, cause?, schemaVersion?, expected?, reason? }`.

## DSH usage (0.3.0)

`packages/dsh-advisers/lib/read.js` imports the facade lazily via a dynamic
`import('advisers/lib/ledger-read.js')`:

- `E_LEDGER_ABSENT` / `E_LEDGER_UNAVAILABLE` / a missing subpath -> the tool
  returns the marked preview (`preview: true`, `source: "preview-no-ledger"`,
  `note`), matching the 0.2.x first-run behaviour;
- other gates -> `{ ok: false, error: { code: LEDGER_*, message, hint? } }`
  (never empty data);
- a successful real read -> `preview: false`, `source: "ledger-readonly"`,
  optional `backend`/`warnings`, `clearance: 0`, `protectedExcluded`;
- `advisers_clients` (0.3.2) uses `readClientList`/`readClientById`:
  list -> `{ action:"list", clients, total, truncated, limit,
  customerEntities, ...marker }`; show -> the status view plus `action:"show"`
  and `customerEntities`; an unknown id is the structured
  `CLIENT_NOT_FOUND` error; a JSON store returns an empty list with
  `customerEntities: false` (and show -> `CLIENT_NOT_FOUND`); a missing ledger /
  unavailable facade falls back to the marked preview list (show -> structured
  `CLIENT_NOT_FOUND` with the preview explanation);
- `config.mode: "preview"` is the kill switch and restores the 0.2.x preview
  path exactly.

## Tests

- `packages/advisers/test/ledger-read.test.js` — facade matrix: absent / sealed /
  0-byte / corrupt / TOS missing-revoked-version-text / env-consent / stale /
  newer schema / targeted reads / clearance / snapshot / concurrency (writer
  lock, uncommitted transaction, WAL) / read-only directory / odd home paths /
  JSON backend / no absolute paths / no HOME creation / no writer lock.
- `packages/dsh-advisers/test/ledger-read.test.js` — DSH wiring matrix: preview
  fallback, real ledger today/who/evidence (CLI parity), TOS errors, sealed /
  stale / newer, preview kill switch, unavailable facade, WAL concurrency,
  JSON store, read-only side effects.
- `packages/dsh-advisers/test/clients.test.js` — `advisers_clients` matrix:
  real-ledger list/show (counts, clearance, timeline, no note bodies),
  preview fallback (empty marked list; show -> CLIENT_NOT_FOUND), JSON-store
  `customerEntities:false` + note, error mapping, schema/render, and the
  read-only side-effect check (no HOME lock, database bytes unchanged).

```sh
cd packages/advisers
node --experimental-strip-types --test test/ledger-read.test.js
cd ../dsh-advisers
node --test test/ledger-read.test.js test/preview.test.js test/schema.test.js
```

Consumer-side acceptance (DSH real read, no write path): point `home` at a real
TOS-accepted ledger and call `advisers_today`/`advisers_who`/`advisers_evidence`; every
payload carries `preview: false` + `source: "ledger-readonly"` + `clearance: 0` (with
`backend`/`warnings`/`protectedExcluded` where applicable), and no `~/.advisers` file or
lock is created or modified. A TOS-missing ledger returns `{ ok: false, error:
{ code: "LEDGER_TOS_REQUIRED", ... } }`, never empty data.
