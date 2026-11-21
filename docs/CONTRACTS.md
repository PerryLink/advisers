# Interface contracts (0.3.0 minimal set; 0.4.0 adds the additive MCP modern era v2 and additive CLI read-model `$defs`; interface shapes frozen by 0.3.x stay unchanged)

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
| `contracts/mcp/responses-v1.schema.json` | 1 | additive | JSON Schema for legacy MCP responses and the JSON payloads inside them. |
| `contracts/mcp/versions-v2.json` | 2 | additive | MCP dual-era rulebook (0.4.0): the legacy matrix reference plus the stateless modern 2026-07-28 era (per-request `_meta`, `server/discover`, `resultType`/`ttlMs`/`cacheScope`, error mapping, `ADVISERS_MCP_MODERN` switch). |
| `contracts/mcp/responses-v2.schema.json` | 2 | additive | JSON Schema for the modern result/error envelopes only; the payload is byte-identical and validated against the frozen v1 `$defs`. |
| `contracts/vectors/mcp/modern.vectors.json` | 1 | — | Accept/reject conformance vectors for every top-level `$def` of the modern envelope schema. |
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

The 0.4.0 release adds **documented-additive** shapes for the new families
(`kb`, `kb page`, `fact`, `mail`, `receivable`, `payment`, `consent`,
`privacy --matrix`, `search --scope`, `client export --pack`): they are
registered with `status: "documented-additive"` in `commands-v1.json` and
declared in the schema's `x-documented-additive` block. The gate checks their
structure, schema refs and accept/reject vectors but does not execute them as
frozen v1 commands; when a shape stabilises it can be promoted to a frozen
entry in a future contract revision.

### Status and the discovery field (v1)

`contracts/cli/status-v1.json` freezes `advisers status --json` and the rule
for the additive `contracts` discovery object. The expected payload is in
`contracts/versions-v1.json` under `discovery.expected`.

```json
{ "cliJson": 1, "errors": 1, "exitCodes": 1, "mcpTools": 1, "mcpResources": 1,
  "mcpProtocol": "2024-11-05", "dshTools": 2, "petBrief": 2 }
```

**Wired in the 0.3.0 integration wave:** `advisers status --json` now carries the
`contracts` object (the published npm package does not ship `contracts/`, so
`bin/advisers.js` carries the frozen values and `check-contracts --status`
asserts they equal the artifact tree). Consumers should treat the object as
additive: older 0.2.x CLIs omit it, and the shims default to the v1 values above.
The checker fails if the field is present but inconsistent with the manifest.

> Resolved 2026-11-20: the free-text `discovery.status` label in
> `contracts/versions-v1.json` and `contracts/cli/status-v1.json` is now
> `wired-in-0.3.0`; the field is wired and gate-checked.

### Exit codes (v1 frozen; v2 not active)

`contracts/cli/exit-codes-v1.json`: **0** success, **1** user/config/runtime
error, **3** TOS consent required (`E_TOS_REQUIRED`). The offline `evidence
verify` command is TOS-exempt. Exit codes 4/5/6 are reserved by
`contracts/cli/exit-codes-v2.draft.json` and are **not active** in 0.3.0;
scripts must read `error.code`. Strict option parsing landed in 0.3.0 for the
operational commands (`status`, `export`, `audit`, `doctor`, `backup`, `backups`,
`restore`): an unknown flag fails with `E_USAGE` and exit 1 instead of being
ignored. Known gap: older commands such as `today` and `commit ls` still ignore
unknown flags, so v1 does not promise strict-flag exit 1 for every command.

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

`contracts/mcp/tools-v1.json` + `contracts/mcp/resources-v1.json` freeze the 8
tools and 5 resources; `contracts/mcp/responses-v1.schema.json` freezes the
JSON-RPC response envelopes and their payloads; `contracts/mcp/errors-v1.json`
freezes the error vocabulary. `contracts/mcp/versions-v1.json` declares the
supported legacy protocol versions (2024-11-05 / 2025-06-18 / 2025-11-25) and
the default 2024-11-05.

0.3.0 negotiation is implemented as **active-fallback**: `initialize` echoes a
supported requested version, while a missing or unknown version falls back to
2024-11-05 so pre-0.3 clients observe exactly the old behaviour. (The research
target was a readable rejection listing the supported matrix; the implementation
deliberately chose legacy compatibility. The checker asserts the echo and the
fallback; changing to strict rejection is a documented contract change.)
List-shaped MCP payloads gained the additive cap fields
`total`/`truncated`/`limit`/per-array totals (caps applied after clearance,
before the egress classifier).

**0.4.0 adds the MCP modern (2026-07-28) era as an additive v2 contract**
(`contracts/mcp/versions-v2.json` + `contracts/mcp/responses-v2.schema.json`
+ `contracts/vectors/mcp/modern.vectors.json`). The server is **dual-era**: a
request carrying the required per-request `_meta` keys
(`io.modelcontextprotocol/protocolVersion` + `clientCapabilities`) is served
statelessly (`server/discover`, `tools/list`, `tools/call`,
`resources/list`, `resources/read`), while `initialize` and every request
without that `_meta` keep the frozen legacy path. Modern results carry
`resultType` (+ `ttlMs`/`cacheScope` on cacheable methods and
`_meta.io.modelcontextprotocol/serverInfo`); `tools/call` content and
`resources/read` contents remain **byte-identical** to legacy. Modern error
mapping is part of the contract: unsupported version `-32022` (with
`data.supported`/`data.requested`), malformed/missing `_meta` `-32602`,
removed methods (`initialize`/`ping`) and unlisted methods `-32601`, invalid
cursor `-32602`, and unknown resources `-32602` (legacy stays `-32002` for
the same request). `ADVISERS_MCP_MODERN=off` makes every request take the
frozen legacy path. The v2 envelope is **not** part of
`status.contracts` discovery: modern clients discover it through
`server/discover`, and `discovery.expected` keeps `mcpProtocol: 2024-11-05`
so 0.3.2 status consumers stay byte-compatible.

## How to validate

```sh
node scripts/check-contracts.mjs            # all 8 checks; exit 0 = pass
node scripts/check-contracts.mjs --schema --vectors --docs
node scripts/check-contracts.mjs --cli --status --exit --mcp
node scripts/check-contracts.mjs --errors --update   # regenerate the 2 generated files
```

The gate runs **in CI on every PR** (the `test` job, after build/typecheck; see
`.github/workflows/ci.yml`), so a shape change that is not reflected in the frozen
artifacts fails the PR. It is offline (no credentials, no model, no network), uses a
temporary `ADVISERS_HOME` under the OS temp directory, and removes it afterwards.
Current tree: **90 checks PASS** (2026-11-21 0.4.0 + post-release main, including the wired
`status.contracts` field, the real stdio MCP **dual-era** catalogue and the
0.4.0 error-code layers). The eight checks:

| Check | Enforces |
|---|---|
| `--schema` | every `*.schema.json` parses, has the required metadata (`$schema/$id/version/x-license/x-*`), uses only the supported JSON-Schema subset (unknown keywords fail closed) and has resolvable local `$ref`s; the documented-additive `$defs` agree with the commands registry; all other contract JSON parses. |
| `--vectors` | each vectors file targets an existing schema, covers every top-level `$def` (including one accept + one reject for every documented-additive def), has at least 3 cases, and each case validates (or fails) as declared. |
| `--cli` | the real CLI, in a temp home, returns pure JSON for every frozen command in `cli/commands-v1.json` and every payload matches its frozen `$def`; documented-additive commands are structurally validated without execution. |
| `--status` | `status --json` works on a fresh home with no TOS/key, matches `StatusPayload`, and the (when present) discovery field equals the manifest. |
| `--exit` | the real CLI exit codes match `cli/exit-codes-v1.json` probes; the error envelope validates against `cli/errors-v1.schema.json`. |
| `--mcp` | a real `advisers mcp --stdio` session for **both eras**: legacy initialize/tools/list/resources/list/resources/read/tools/call/error probes validated against `mcp/*.json` and `mcp/responses-v1.schema.json` (catalogue deep-equals the contract), then modern probes (server/discover, tools/list, tools/call, resources/list, resources/read) validated against `mcp/responses-v2.schema.json` with the envelope stripped and the payload re-validated against the frozen v1 `$defs`, plus `-32022`/`-32602`/`-32601`, cursor rejection, notification silence, legacy-byte equality and the `ADVISERS_MCP_MODERN=off` fallback. |
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

- MCP legacy negotiation stays **active-fallback** (supported versions are
  echoed, unknown versions fall back to the default); strict rejection is not
  part of v1. The 0.4.0 modern era is the read-only dual-era surface only:
  `prompts/*`, `resources/templates/list`, `resources/subscribe`/`subscriptions/listen`,
  `logging/*`, pagination `nextCursor`, multi-round-trip `input_required`,
  HTTP/SSE transports and a `readonly` tool profile are explicit non-goals
  (`contracts/mcp/versions-v2.json` `modern.nonGoals`). `status.contracts` does
  not advertise the modern era; it is discovered through `server/discover`.
- **Evidence/receipt pack v2 compatibility**: the evidence pack manifest is v2
  (`verificationBasis`, `byKind`, `notCheckedCount`, typed source rows) and the
  offline verifier accepts both v1 and v2 packs; delivery receipt packs keep
  manifest v2 with verifier-side acceptance of v1. Offline verification proves
  pack self-consistency and SHA-256 only — it never claims that a source was
  re-resolved, and `verificationBasis` says which basis was used.
- Exit codes **4/5/6 are not active** (policy engine, later); v2 is a draft.
- Strict flags were added in the 0.3.0 integration wave for the operational
  commands (`status`, `export`, `audit`, `backup`, `backups`, `restore`, `doctor`,
  `tos`, …): unknown options now exit 1 with `E_USAGE`. Older legacy commands still use
  the historical lenient parser, so v1 does not yet guarantee strict-flag exit 1 for
  **every** command.
- The error-code registry freezes **committed** source. New codes in uncommitted
  work are reported as `INFO`; register them before/with the commit that adds
  them (the checker fails afterwards).
- `LICENSING.md`'s scope list does not enumerate `contracts/` yet. The
  artifacts carry `x-license: CC-BY-NC-SA-4.0` and `contracts/LICENSE` records
  the intended license; updating the legal scope text needs owner/legal
  confirmation and is outside this implementation.
- DSH bundle: in 0.3.0 the three ledger read tools read the
  **real local ledger read-only** through `advisers/lib/ledger-read.js` (TOS-gated,
  clearance 0, no HOME lock, no migration, no writes) with a marked preview fallback;
  the read payload keeps the 0.2.x field names and adds source/clearance/backend fields
  (see `packages/dsh-advisers/README.md`). The discovery value is `dshTools: 2`
  (tool names/count contract), and the 5 external DSH error codes are preserved. A
  larger "DSH payload v2" and any DSH write path remain future work. Pet Brief stays
  contract v0.2 (closed, unchanged).
- The contracts tree itself is documentation/data and is not edited by the 0.3.0
  integration wave; the integration consumes the frozen artifacts (and wires
  `status.contracts` in `bin/advisers.js`, asserted above). No package version bump or
  CHANGELOG entry is part of the contracts work.

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
