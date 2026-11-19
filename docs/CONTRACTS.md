# Interface contracts (0.3.0 minimal set)

Advisers is CLI-first and its consumers (scripts, CI, MCP clients, the DSH host,
Famling) need a machine-readable, versioned interface instead of prose. This
document is the human entry point for the `contracts/` tree; the artifacts
themselves are the single source of truth for shapes and are enforced by
`scripts/check-contracts.mjs`.

- Frozen baseline: git `35a51c3` (the 0.2.4 code base), frozen 2026-11-20.
- Package version is **not** bumped by this change; contract versions are the
  numbers in `contracts/versions-v1.json`.
- Contract artifacts are documentation/data intended to be licensed
  CC BY-NC-SA 4.0 (see `contracts/LICENSE` and the licensing status note below).

## Artifact index

| Artifact | Version | Compat | What it freezes |
|---|---|---|---|
| `contracts/versions-v1.json` | 1 | — | Manifest: contract versions + the expected `status.contracts` discovery payload. |
| `contracts/README.md` | 1 | — | Versioning rules, artifact index, license status. |
| `contracts/CONSUMERS.json` | 1 | — | Who consumes which contract and whether that consumer runs in this repo's CI. |
| `contracts/LICENSE` | 1 | — | License pointer for the contract artifacts (documentation/data). |
| `contracts/cli/read-models-v1.schema.json` | 1 | backward | JSON Schema `$defs` for the deterministic `--json` read payloads. |
| `contracts/cli/commands-v1.json` | 1 | backward | command -> argv -> schema `$ref` map with determinism/key/TOS metadata. |
| `contracts/cli/errors-v1.schema.json` | 1 | backward | The stderr error envelope `{"error":{"code","message","hint?","details?"}}`. |
| `contracts/cli/status-v1.json` | 1 | backward | `advisers status --json` contract + discovery-field rules. |
| `contracts/cli/exit-codes-v1.json` | 1 | backward | Exit codes 0/1/3 and the probes that assert them against the real CLI. |
| `contracts/cli/exit-codes-v2.draft.json` | 2-draft | — | Reserved 4/5/6 for the policy engine. **Not active.** |
| `contracts/errors/codes.v1.json` | 1 | additive | Generated error-code registry (source of truth: `packages/advisers/lib/error-codes.js`). |
| `contracts/mcp/tools-v1.json` | 1 | additive | 7 MCP tools: name/inputSchema/annotations/side effect + response schema ref. |
| `contracts/mcp/resources-v1.json` | 1 | additive | 4 MCP resources: URI/name/mimeType/payload schema ref. |
| `contracts/mcp/versions-v1.json` | 1 | protocol negotiation | Supported legacy MCP protocol versions + negotiation status + methods. |
| `contracts/mcp/errors-v1.json` | 1 | additive | JSON-RPC `-32600/-32601/-32602/-32603/-32700/-32002` + tool `isError` envelope. |
| `contracts/mcp/responses-v1.schema.json` | 1 | additive | JSON Schema for MCP responses and the JSON payloads inside them. |
| `contracts/vectors/cli/read-models.vectors.json` | 1 | — | Accept/reject conformance vectors for every top-level read payload. |
| `contracts/vectors/cli/errors.vectors.json` | 1 | — | Accept/reject vectors for the error envelope. |
| `contracts/vectors/mcp/responses.vectors.json` | 1 | — | Accept/reject vectors for MCP envelopes and payloads. |

## Frozen surfaces

### CLI JSON (v1, backward compatible)

The deterministic read-only `--json` surfaces are frozen in
`contracts/cli/read-models-v1.schema.json` and mapped to their commands in
`contracts/cli/commands-v1.json`: `status`, `tos status`, `tick`, `today`,
`remind`, `commit ls`, `who`, `deliveries`, `memory candidates`,
`matter ls`, `matter show`, `agenda`, `morning`, `privacy` and
`evidence show`. Shapes are additive: a new optional key is a minor change;
removing a key or changing its type is a major change. Failures write the
error envelope to stderr (stdout stays machine-free) and exit 1, or exit 3 for
`E_TOS_REQUIRED`.

### Status and the discovery field (v1)

`contracts/cli/status-v1.json` freezes `advisers status --json` and the rule
for the additive `contracts` discovery object. The expected payload is in
`contracts/versions-v1.json` under `discovery.expected`. When the field is
absent (current state), consumers must assume the v1 defaults below; when it is
present it must equal the manifest.

```json
{ "cliJson": 1, "errors": 1, "exitCodes": 1, "mcpTools": 1, "mcpResources": 1,
  "mcpProtocol": "2024-11-05", "dshTools": 1, "petBrief": 2 }
```

Wiring `status.contracts` needs a `bin/advisers.js` change; that is part of
the 0.3.0 integration wave (this contracts-only change does not edit `bin/`).
The checker prints `INFO` while the field is absent and fails if it is present
but inconsistent.

### Exit codes (v1 frozen; v2 not active)

`contracts/cli/exit-codes-v1.json`: **0** success, **1** user/config/runtime
error, **3** TOS consent required (`E_TOS_REQUIRED`). The offline `evidence
verify` command is TOS-exempt. Exit codes 4/5/6 are reserved by
`contracts/cli/exit-codes-v2.draft.json` and are **not active** in 0.2.4 or
this change; scripts must read `error.code`. Known gap: unknown flags are
currently ignored by some commands (the M7 hardening item will tighten this
additively); v1 does not promise strict-flag exit 1 yet.

### Error codes (v1, additive)

`packages/advisers/lib/error-codes.js` is the single source of truth.
`contracts/errors/codes.v1.json` and `docs/ERROR-CODES.md` are generated from
it (never edit them by hand; run `node scripts/check-contracts.mjs --update`).
The registry has two layers:

- **baseline**: the 50 CLI codes present in committed 0.2.4 source at
  `35a51c3` (`since: "0.2.x"`);
- **0.3.0 additive**: the codes extracted from the 0.3.0 modules landing in
  the same release (audit anchor, backup/restore, read-only ledger facade, TUI
  JSON guards, receipt limits; `since: "0.3.0"`). The generated
  `docs/ERROR-CODES.md` carries the exact counts. These are provisional until
  their module is committed: the gate accepts a registered 0.3.0 code that
  exists in the working tree but not yet in git HEAD, and fails only if a
  registered code exists nowhere (stale).

It also freezes the 5 DSH adapter external codes (`INVALID_ARGUMENT`,
`UNKNOWN_ID_PREFIX`, `EVIDENCE_NOT_FOUND`, `INTERNAL_ERROR`,
`CONTENT_BLOCKED`), which keep their names.

The source scan is a **committed baseline**: codes in uncommitted parallel work
are reported as `INFO` (not failures) until committed; once committed, a new
`E_*` literal fails `--errors` until it is registered. New codes are
additive; never rename an existing code or change its meaning.

### MCP (v1, additive)

`contracts/mcp/tools-v1.json` + `contracts/mcp/resources-v1.json` freeze the 7
tools and 4 resources; `contracts/mcp/responses-v1.schema.json` freezes the
JSON-RPC response envelopes and their payloads; `contracts/mcp/errors-v1.json`
freezes the error vocabulary. `contracts/mcp/versions-v1.json` declares the
supported legacy protocol versions (2024-11-05 / 2025-06-18 / 2025-11-25) and
the default 2024-11-05.

0.3.0 negotiation is implemented as **active-fallback**: `initialize` echoes a
supported requested version, while a missing or unknown version (including the
modern stateless 2026-07-28 revision) falls back to 2024-11-05 so pre-0.3
clients observe exactly the old behaviour. (The research target was a readable
rejection listing the supported matrix; the implementation deliberately chose
legacy compatibility. The checker asserts the echo and the fallback; changing
to strict rejection is a documented contract change.) List-shaped MCP payloads
gained the additive cap fields `total`/`truncated`/`limit`/per-array totals
(caps applied after clearance, before the egress classifier); the modern
2026-07-28 era remains 0.3.1+.

## How to validate

```sh
node scripts/check-contracts.mjs            # all 8 checks; exit 0 = pass
node scripts/check-contracts.mjs --schema --vectors --docs
node scripts/check-contracts.mjs --cli --status --exit --mcp
node scripts/check-contracts.mjs --errors --update   # regenerate the 2 generated files
```

The gate is offline (no credentials, no model, no network), uses a temporary
`ADVISERS_HOME` under the OS temp directory, and removes it afterwards. The
eight checks:

| Check | Enforces |
|---|---|
| `--schema` | every `*.schema.json` parses, has the required metadata (`$schema/$id/version/x-license/x-*`), uses only the supported JSON-Schema subset (unknown keywords fail closed) and has resolvable local `$ref`s; all other contract JSON parses. |
| `--vectors` | each vectors file targets an existing schema, covers every top-level `$def`, has at least 3 accept/reject cases, and each case validates (or fails) as declared. |
| `--cli` | the real CLI, in a temp home, returns pure JSON for every command in `cli/commands-v1.json` and every payload matches its frozen `$def`. |
| `--status` | `status --json` works on a fresh home with no TOS/key, matches `StatusPayload`, and the (when present) discovery field equals the manifest. |
| `--exit` | the real CLI exit codes match `cli/exit-codes-v1.json` probes; the error envelope validates against `cli/errors-v1.schema.json`. |
| `--mcp` | a real `advisers mcp --stdio` session: initialize/tools/list/resources/list/resources/read/tools/call/error probes validated against `mcp/*.json` and `mcp/responses-v1.schema.json`; catalogue deep-equals the contract. |
| `--errors` | committed source literals are registered; registry codes still exist; generated registry/docs are in sync; exit mapping and DSH external codes intact. |
| `--docs` | this document mentions every artifact in `versions-v1.json` and the discovery manifest agrees with the artifact versions and the DSH/Pet Brief sources. |

## Versioning rules

1. **Minor (additive)**: new optional field, new command, new tool/resource, new
   error code. Only this kind of change is allowed inside a frozen major.
2. **Major**: remove/rename a field, change a required field or an enum meaning,
   change an exit code's meaning. Requires a new `v2` artifact, migration notes,
   and keeping the old artifact + vectors.
3. Closed contracts (Pet Brief, `docs/pet-brief/schema-v0.2.json`) treat
   additive changes as breaking: consumers upgrade first. Pet Brief stays in
   `docs/pet-brief/` and is not duplicated here (no drift).
4. A contract and its vectors change in the same PR; artifacts are never edited
   by hand when they are generated.

## Known gaps and out of scope (honesty list)

- `status.contracts` discovery field is **not wired yet** (needs `bin/`; Wave 2
  integration). The checker reports `INFO` until then.
- MCP legacy negotiation is **active-fallback** (supported versions are
  echoed, unknown versions fall back to the default); strict rejection of
  unknown versions, `server/discover` and the modern 2026-07-28 surface are
  out of 0.3.0 scope.
- Exit codes **4/5/6 are not active** (policy engine, later); v2 is a draft.
- Unknown flags are currently ignored by some commands (M7); v1 does not yet
  guarantee strict-flag exit 1.
- The error-code registry freezes **committed** source. New codes in uncommitted
  work are reported as `INFO`; register them before/with the commit that adds
  them (the checker fails afterwards).
- `LICENSING.md`'s scope list does not enumerate `contracts/` yet. The
  artifacts carry `x-license: CC-BY-NC-SA-4.0` and `contracts/LICENSE` records
  the intended license; updating the legal scope text needs owner/legal
  confirmation and is outside this implementation.
- DSH tools stay the 0.2.4 **preview** surface (`dshTools: 1`); full DSH
  payload v2 (real read-only ledger) belongs to the DSH wave. Pet Brief stays
  contract v0.2 (closed, unchanged).
- This change does not edit `bin/`, `lib/mcp-server.js`, `package.json`
  versions or the CHANGELOG; those integrations consume the frozen artifacts.

## Acceptance evidence

```sh
cd packages/advisers && node --experimental-strip-types --test test/contracts.test.js
cd ../.. && node scripts/check-contracts.mjs
# negative controls (must exit 1):
#   1) delete a required key from a vector -> --vectors fails
#   2) add a fake E_* literal to tracked source and commit -> --errors fails
#   3) change a tool inputSchema in mcp/tools-v1.json -> --mcp fails
```

The contract registry test also covers the validator itself (missing required,
wrong type, bad enum/const/pattern, additionalProperties, unresolved `$ref`,
unknown keyword fail-closed) so the gate cannot silently pass by being broken.
