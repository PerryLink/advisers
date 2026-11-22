# dsh-advisers

DSH bundle for **Advisers**. It registers:

- a cordis service `advisers` (an `AdvisersRuntime`);
- `advisers_brief` — turns a request into an `IntentBrief` (goal, deliverable, risk, at most one question, two-line readback); it does not touch the ledger;
- `advisers_office` — builds a DOCX/XLSX/PPTX/XMind/Mermaid/draw.io artifact **inside** the configured workspace;
- `advisers_today` — read-only **real-ledger** view of the today/week/waiting ledger (counts, capped lists, earliest due item);
- `advisers_who` — read-only **real-ledger** view of who owes whom (what I owe vs what I am waiting on);
- `advisers_evidence` — read-only **real-ledger** evidence lookup (stored quotes/refs/sources) for a `cm_…`, `fact_…`, or `pref_…` id;
- `advisers_clients` — read-only **real-ledger** customer projection: `{action:"list"}` client rows or `{action:"show", id}` one client (projects, exact counts, open buckets, a delivery/commitment timeline). No note bodies, no conversation text.

`0.5.0` is the current lockstep release (published 2026-11-22; a feature release on the
0.4.3 tree). This adapter's six-tool surface and its read-only scope are unchanged from
0.3.2; 0.5.0 adds only the additive read-disclosure metadata (`disclosure{surface:"dsh",
…,audited:false}` plus per-row `view`) to the read results, because the adapter never
writes the `advisers` audit chain. The new capability of the 0.4/0.5 lines (knowledge
base, mail entry, interactive shell, receivables, policy/evidence subset, KB/mail review
links, manual fact entry, Chinese relative dates, local capture/inbox, trust outputs,
payment channels, receivable CSV, restore drill, portable bundle v1, context pack v1,
sync snapshot v2, setup/demo/help) lives in the `advisers`
package, and this adapter keeps its read-only scope.

0.3.0 wires the three ledger read tools to the real local ledger through the
controlled `advisers/lib/ledger-read.js` facade (see
`docs/LEDGER-READ-API.md`): **read-only**, no HOME write lock, no migration, no
HOME creation, no ledger writes, TOS-gated and at clearance 0. The ledger import
is dynamic and defensive: an older `advisers` package without the subpath, a
host without `node:sqlite`, or a first-run machine without a ledger falls back to
the marked 0.2.x **preview** instead of failing plugin load. TOS/vault/schema/
corruption/unavailability gate failures are structured errors, never empty data.
The DSH adapter is a thin channel, not the full product.

## Tools

| Tool | Kind | Arguments | Returns |
|---|---|---|---|
| `advisers_brief` | read-only (no ledger) | `text` (string, required) | IntentBrief fields, or `{ ok: false, error }` when content safety blocks |
| `advisers_office` | write (workspace-confined) | `kind`, `out`, `spec` (required) | `{ ok, path, bytes }`, or `{ ok: false, error }` when content safety blocks |
| `advisers_today` | read-only (real ledger) | none | `{ ok, data }` with `now`, `timezone`, `localDay`, `counts`, `overdue`, `today`, `week`, `waiting`, `noDue`, optional `next`, `truncated`, plus the source marker (`preview`, `source`, `note`) and, for real reads, `backend`, `clearance`, `protectedExcluded`, optional `warnings` |
| `advisers_who` | read-only (real ledger) | none | `{ ok, data }` with `counts` (`mine`/`waiting`/`open`), `mine`, `waiting`, `truncated`, plus the same source marker/clearance fields |
| `advisers_evidence` | read-only (real ledger) | `id` (string, required) | `{ ok, data }` with `id`, `kind`, `record`, `sources`, `missing`, `counts`, `verified: false`, `truncated`, plus the same source marker/clearance fields |
| `advisers_clients` | read-only (real ledger) | `action` (`"list"`\|"show"`), optional `id`, `limit`, `timelineLimit` | list: `{ ok, data }` with `clients`, `total`, `truncated`, `limit`, `clearance`, `protectedExcluded`; show: client/projects/counts/open/timeline with `timelineTotal`, `timelineTruncated`. 0.3.2 reads the facade's `readClientList`/`readClientById` (SQLite customer tables; JSON store returns an empty list with `customerEntities:false`, never fake data). |

Lists are capped (`today`: 10 per bucket, `who`: 50 per side, `evidence`: 20
sources/missing entries, `clients`: 20 rows and 20 timeline entries by default);
the `counts` fields carry the visible totals and `truncated` is true when a list
was cut.

## Configuration

`apply(ctx, config)` accepts:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `home` | absolute path | `ADVISERS_HOME` or `~/.advisers` | Which Advisers home to read. A relative path is a configuration error at apply time. |
| `mode` | `"auto"` \| `"preview"` | `"auto"` | `auto` reads the real ledger when one is readable and TOS-accepted; `preview` is the kill switch and restores the 0.2.x in-memory preview exactly. |
| `stage` | `"probation"` \| `"trusted"` | `"probation"` | Unchanged; affects the in-memory service (`advisers_brief`), not ledger reads. |
| `workspace` | path | `process.cwd()` | Unchanged; confines `advisers_office` writes. |

There is no per-call clearance argument and no environment switch: DSH reads at
**clearance 0** (fail closed) and the only kill switch is `config.mode`.

## Read payload contract (0.3.0)

Every successful read result carries the source marker (the field names are the
0.2.3 ones; 0.3.0 widens their values):

| Field | Preview fallback | Real ledger |
|---|---|---|
| `data.preview` | `true` | `false` |
| `data.source` | `"preview-no-ledger"` | `"ledger-readonly"` |
| `data.note` | one English sentence explaining the fallback | one English sentence explaining the read-only snapshot |
| `data.backend` | absent | `"sqlite"` or `"json"` |
| `data.clearance` | absent | `0` |
| `data.protectedExcluded` | absent | count of records withheld because their matter secrecy is above clearance 0 |
| `data.warnings` | absent | optional sanitized ledger warnings (e.g. an unusable WAL); never absolute paths |

Preview payloads keep the exact 0.2.3 key set (0.2.x fields plus the three
marker fields). Real payloads add the additive fields above; the 0.2.x `counts`,
lists, `sources`, `missing`, `verified` and `truncated` keep their shape and
meaning. Rendered text is prefixed `[preview: no ledger]` only for the preview
fallback; a real read that withheld protected records appends
`; N protected item(s) withheld (clearance 0)`.

### When the preview fallback is used

1. No readable ledger in the configured home (`E_LEDGER_ABSENT`) — first run;
   the note tells the user to run `advisers init`.
2. The read-only facade cannot be loaded or used (`node:sqlite` unavailable, an
   older `advisers` package without the subpath, `E_LEDGER_UNAVAILABLE`).
3. `config.mode: "preview"` (kill switch).

Every other gate failure returns `{ ok: false, error: { code, message, hint? } }`
and **no data** — a TOS problem must not look like an empty ledger.

### Real-ledger guarantees

- Opens `~/.advisers/state.db` with `readOnly: true`; takes no HOME write lock,
  runs no migration/DDL/checkpoint/vacuum, creates no HOME, writes nothing.
- Works while a CLI writer holds the HOME lock; reads the last committed WAL
  snapshot and never sees uncommitted rows.
- Requires an existing TOS acceptance record for the packaged TOS version and
  text hash. The adapter never records acceptance for the user.
- Old schema -> `LEDGER_SCHEMA_STALE` (run a writable CLI command to migrate);
  newer schema -> `LEDGER_SCHEMA_NEWER` (upgrade the package); sealed vault ->
  `LEDGER_VAULT_SEALED`; corrupt database -> `LEDGER_CORRUPT` (never rebuilt).
- Targeted reads only: today/who use a narrow commitment-index projection plus
  the small matters table; evidence is an O(1) primary-key point query. The
  adapter never loads a whole ledger snapshot into the host.

### Result envelope and error codes

Every read-only tool returns a discriminated JSON envelope instead of throwing a
domain exception:

```json
{ "ok": true, "data": { "...": "..." } }
```

```json
{ "ok": false, "error": { "code": "LEDGER_TOS_REQUIRED", "message": "the current Advisers Terms of Service are not accepted for this ledger (missing)", "hint": "Run `advisers tos show` and accept the current terms with an interactive CLI command; the DSH/read-only surface must never record acceptance for the user." } }
```

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENT` | A supplied argument is unusable (e.g. an empty evidence id) or the configured home is invalid. |
| `UNKNOWN_ID_PREFIX` | Evidence id is not `cm_…`, `fact_…`, or `pref_…`. |
| `EVIDENCE_NOT_FOUND` | No commitment/fact/preference with that id exists in the real ledger (or in the preview fallback). |
| `EVIDENCE_PROTECTED` | The record exists but its matter secrecy is above clearance 0; content is withheld. |
| `LEDGER_TOS_REQUIRED` | No TOS acceptance record, or it was revoked / the version or text changed. |
| `LEDGER_VAULT_SEALED` | The ledger is sealed; run `advisers vault unseal` first. |
| `LEDGER_SCHEMA_STALE` | The on-disk schema is older; a writable CLI command must migrate it. |
| `LEDGER_SCHEMA_NEWER` | The on-disk schema is newer; upgrade `advisers`/`dsh-advisers`. |
| `LEDGER_CORRUPT` | 0-byte / non-SQLite ledger: back up, do not delete, run `advisers doctor`. |
| `LEDGER_UNAVAILABLE` | `node:sqlite` unavailable, unreadable path, read-only volume, or another open failure. |
| `LEDGER_BUSY` | The ledger is temporarily busy; retry shortly. |
| `INTERNAL_ERROR` | Unexpected read failure; the tool stays up and reports it. |
| `CONTENT_BLOCKED` | `advisers_brief`/`advisers_office` input was blocked by the local content-safety layer. The error carries `surface`, `ruleIds`, and `rulesetVersion`; the original text is never echoed. |

Consumer-visible `message`/`hint`/`note`/`warnings` never contain absolute
filesystem paths. Schema-invalid arguments (for example a missing required `id`)
are rejected by the host tool runtime as `INVALID_ARGS` before the body runs.
Neither path throws a bare exception at the model.

The content-safety layer is the same local rule set the CLI uses
(`docs/CONTENT-SAFETY.md`). `advisers_brief` classifies `text`; `advisers_office`
classifies `{ kind, out, spec }` with the `dsh.tool` surface. A blocked call
returns `{ ok: false, error: { code: "CONTENT_BLOCKED", surface, ruleIds,
rulesetVersion } }` and does not write a file; benign input is unchanged.

### Audit

If the runtime exposes an audit sink (`runtime.audit(event)`), each read call
reports `{ actor: 'dsh', action: 'tool.read', allowed, reason }`. A missing or
failing sink is a no-op and never turns a read into an error. The in-memory
runtime in `advisers-core` ships no audit sink, so by default these tools are
strictly read-only; DSH 0.3.0 does not write a ledger audit row for a read.

`advisers_evidence` reports the refs stored on the ledger row (`verified: false`)
because there is no turn store in this adapter; it never fabricates a turn body.

## Examples

Real ledger (0.3.0):

```json
{"name": "advisers_today", "arguments": {}}
```

```json
{
  "ok": true,
  "data": {
    "now": "2026-11-20T03:34:03.415Z",
    "timezone": "Asia/Shanghai",
    "localDay": "2026-11-20",
    "counts": { "open": 7, "overdue": 1, "today": 2, "week": 3, "waiting": 1, "noDue": 1 },
    "overdue": [{ "id": "cm_…", "debtor": "user", "creditor": "boss", "action": "send the Q4 deck", "status": "open", "dueAt": "2026-11-18T09:00:00+08:00" }],
    "today": [], "week": [], "waiting": [], "noDue": [],
    "next": { "id": "cm_…", "action": "send the Q4 deck", "status": "open", "dueAt": "2026-11-18T09:00:00+08:00" },
    "truncated": false,
    "preview": false,
    "source": "ledger-readonly",
    "note": "Read-only snapshot of the local ledger; call again to refresh.",
    "backend": "sqlite",
    "clearance": 0,
    "protectedExcluded": 0
  }
}
```

```json
{"name": "advisers_evidence", "arguments": {"id": "cm_…"}}
```

```json
{
  "ok": true,
  "data": {
    "id": "cm_…",
    "kind": "commitment",
    "record": { "type": "commitment", "id": "cm_…", "action": "send the Q4 deck", "debtor": "user", "creditor": "boss", "status": "open" },
    "sources": [{ "ref": "session_1#turn_2", "sessionId": "session_1", "turnId": "turn_2", "quote": "ship it" }],
    "missing": [],
    "counts": { "sources": 1, "missing": 0 },
    "verified": false,
    "truncated": false,
    "preview": false,
    "source": "ledger-readonly",
    "note": "Read-only snapshot of the local ledger; call again to refresh.",
    "backend": "sqlite",
    "clearance": 0,
    "protectedExcluded": 0
  }
}
```

Preview fallback (no ledger): the same shapes with `preview: true`,
`source: "preview-no-ledger"`, the preview note, empty in-memory data and
`[preview: no ledger] ` prepended to the rendered text.

## Install

```sh
dsh plugin --profile main add dsh-advisers advisers-core
dsh --profile main --dump-config   # should show a "# == dsh-advisers" layer
```

`advisers`, `advisers-core` and `advisers-office` are regular dependencies of this
package, so a normal npm/pnpm install of `dsh-advisers` brings them along. For a
local checkout (run `pnpm install` once so the workspace links exist):

```sh
dsh plugin --profile smoke add /path/to/advisers/packages/core /path/to/advisers/packages/dsh-advisers
```

## Manifest

- `dsh.bundle.patch = ./cordis.patch.yml`
- `engines.node = >=22.16` (the default SQLite ledger needs FTS5, available from Node 22.16)
- `engines.dsh = >=0.2.1-rc.5 <0.3.0`
- runtime dependencies: `advisers` (ledger-read facade + content-safety rule layer), `advisers-core`, `advisers-office`
- peer deps: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`

## Packaging dependencies

The bundle imports `classify` from the **published** `advisers/lib/safety/index.js`
subpath and loads the real ledger through the **published**
`advisers/lib/ledger-read.js` subpath (dynamic `import()`). Both are declared in
`advisers`' `exports` map and are covered by `packages/dsh-advisers/test/packaging.test.js`
(`npm pack --dry-run` must ship `lib/read.js`; the subpath must resolve from a
clean install; the facade must not import `node:sqlite` at module top level).
The 0.2.0 monorepo-relative import bug cannot come back unnoticed.

## Smoke

```sh
TMP=$(mktemp -d)
DSH_HOME="$TMP" dsh plugin --profile smoke add \
  ./packages/core ./packages/dsh-advisers
DSH_HOME="$TMP" dsh --profile smoke --dump-config | grep -A4 dsh-advisers
```

The bundle installs and composes. A full boot starts the Web UI and needs a
model key; it is not part of CI. For a real-ledger smoke with a temporary
`ADVISERS_HOME`: seed a ledger with the CLI (`advisers init`, `commit add`), keep
the TOS accepted record, then call `advisers_today` and expect
`preview: false` / `source: "ledger-readonly"`.

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

Versions published before 0.2.0 keep their original licenses (MIT; Apache-2.0 for
`advisers@0.2.0-preview.71`); the change is not retroactive. See the repository
LICENSING.md, LICENSE-DOCS and NOTICE.
