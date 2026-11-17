# dsh-advisers

DSH bundle for **Advisers**. It registers:

- a cordis service `advisers` (an `AdvisersRuntime`);
- `advisers_brief` — turns a request into an `IntentBrief` (goal, deliverable, risk, at most one question, two-line readback);
- `advisers_office` — builds a DOCX/XLSX/PPTX/XMind/Mermaid/draw.io artifact **inside** the configured workspace;
- `advisers_today` — read-only today/week/waiting view of the commitment ledger (counts, capped lists, earliest due item);
- `advisers_who` — read-only who-owes-whom view (what I owe vs what I am waiting on);
- `advisers_evidence` — read-only evidence lookup (quotes/refs/sources) for a `cm_…`, `fact_…`, or `pref_…` id.

It does **not** send messages or write the ledger. The three read-only tools only read
`runtime.ledger`; `advisers_office` writes files only under `config.workspace`
(path-confined). The DSH adapter is a thin channel, not the full product.

## Tools

| Tool | Kind | Arguments | Returns |
|---|---|---|---|
| `advisers_brief` | read-only (no ledger) | `text` (string, required) | IntentBrief fields, or `{ ok: false, error }` when content safety blocks |
| `advisers_office` | write (workspace-confined) | `kind`, `out`, `spec` (required) | `{ ok, path, bytes }`, or `{ ok: false, error }` when content safety blocks |
| `advisers_today` | read-only | none | `{ ok, data }` with `now`, `timezone`, `localDay`, `counts`, `overdue`, `today`, `week`, `waiting`, `noDue`, optional `next`, `truncated` |
| `advisers_who` | read-only | none | `{ ok, data }` with `counts` (`mine`/`waiting`/`open`), `mine`, `waiting`, `truncated` |
| `advisers_evidence` | read-only | `id` (string, required) | `{ ok, data }` with `id`, `kind`, `record`, `sources`, `missing`, `counts`, `verified: false`, `truncated` |

The read-only tools take no write path: they call `ledger.openCommitments()`,
`ledger.listCommitments()`, `ledger.listFacts()`, and `ledger.findPreference()`
only. Lists are capped (`today`: 10 per bucket, `who`: 50 per side, `evidence`:
20 sources/missing entries); the `counts` fields carry the full totals and
`truncated` is true when a list was cut.

### Result envelope and error codes

Every read-only tool returns a discriminated JSON envelope instead of throwing a
domain exception:

```json
{ "ok": true, "data": { "...": "..." } }
```

```json
{ "ok": false, "error": { "code": "EVIDENCE_NOT_FOUND", "message": "no commitment with id cm_abc" } }
```

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENT` | A supplied argument is unusable (e.g. an empty evidence id). |
| `UNKNOWN_ID_PREFIX` | Evidence id is not `cm_…`, `fact_…`, or `pref_…`. |
| `EVIDENCE_NOT_FOUND` | No commitment/fact/preference with that id exists in the ledger. |
| `INTERNAL_ERROR` | Unexpected ledger/read failure; the tool stays up and reports it. |
| `CONTENT_BLOCKED` | `advisers_brief`/`advisers_office` input was blocked by the local content-safety layer. The error carries `surface`, `ruleIds`, and `rulesetVersion`; the original text is never echoed. |

Schema-invalid arguments (for example a missing required `id`) are rejected by
the host tool runtime as `INVALID_ARGS` before the body runs. Neither path throws
a bare exception at the model.

The content-safety layer is the same local rule set the CLI uses
(`docs/CONTENT-SAFETY.md`). `advisers_brief` classifies `text`; `advisers_office`
classifies `{ kind, out, spec }` with the `dsh.tool` surface. A blocked call
returns `{ ok: false, error: { code: "CONTENT_BLOCKED", surface, ruleIds,
rulesetVersion } }` and does not write a file; benign input is unchanged.

### Data source and audit

The views read the `AdvisersRuntime` instance that this bundle creates; the DSH
adapter does not open `~/.advisers/state.db`. Seed the in-memory ledger through
the `advisers` service (a persistence port is future work). `advisers_evidence`
reports the refs stored on the ledger row (`verified: false`) because there is no
turn store in this adapter; it never fabricates a turn body.

If the runtime exposes an audit sink (`runtime.audit(event)`), each read call
reports `{ actor: 'dsh', action: 'tool.read', allowed, reason }`. A missing or
failing sink is a no-op and never turns a read into an error. The in-memory
runtime in `advisers-core@0.2.1` ships no audit sink, so by default
these tools are strictly read-only.

## Examples

```json
{"name": "advisers_today", "arguments": {}}
```

```json
{
  "ok": true,
  "data": {
    "now": "2026-11-17T03:34:03.415Z",
    "timezone": "Asia/Shanghai",
    "localDay": "2026-11-17",
    "counts": { "open": 2, "overdue": 0, "today": 1, "week": 1, "waiting": 0, "noDue": 0 },
    "overdue": [],
    "today": [{ "id": "cm_…", "debtor": "user", "creditor": "boss", "action": "send the Q4 deck", "status": "open", "dueAt": "2026-11-17T10:00:00.000Z" }],
    "week": [],
    "waiting": [],
    "noDue": [],
    "next": { "id": "cm_…", "debtor": "user", "creditor": "boss", "action": "send the Q4 deck", "status": "open", "dueAt": "2026-11-17T10:00:00.000Z" },
    "truncated": false
  }
}
```

```json
{"name": "advisers_who", "arguments": {}}
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
    "truncated": false
  }
}
```

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
- runtime dependencies: `advisers` (content-safety rule layer), `advisers-core`, `advisers-office`
- peer deps: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`

## Content-safety dependency (0.2.1 packaging)

The bundle imports `classify` from `advisers/lib/safety/index.js`. That specifier
is a **published export subpath** of the `advisers` package, declared as an
explicit dependency (`"advisers": "0.2.1"` in `package.json` and
`"./lib/safety/index.js": "./lib/safety/index.js"` in `advisers`' `exports`).
A clean `npm install`/`pnpm add` of the `dsh-advisers` tarball therefore resolves
the rule layer from the nested `advisers` dependency instead of relying on a
monorepo-relative path (0.2.0 shipped `../advisers/lib/safety/index.js` and failed
with `ERR_MODULE_NOT_FOUND` after a clean install). `scripts/verify-release.mjs`
now imports every published package, including this one, from a temp prefix and
fails the release on error.

## Smoke

```sh
TMP=$(mktemp -d)
DSH_HOME="$TMP" dsh plugin --profile smoke add \
  ./packages/core ./packages/dsh-advisers
DSH_HOME="$TMP" dsh --profile smoke --dump-config | grep -A4 dsh-advisers
```

The bundle installs and composes. A full boot starts the Web UI and needs a
model key; it is not part of CI.

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
