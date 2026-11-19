# Advisers interface contracts (0.3.0 minimal set)

This directory is the machine-readable **interface constitution** for Advisers: the
CLI JSON envelope, the MCP tool/resource surface, the `status --json` discovery field,
the exit codes and the error-code registry. Consumers should read these artifacts
instead of guessing from prose. They are frozen from the 0.2.4 code base (git
`35a51c3`) and are **additive**: no 0.3.0 change may remove a field, rename a tool or
change the meaning of an existing error code without a major version + migration note.

Everything here is documentation/data (schemas, JSON descriptors, vectors), not
executable software: scripts and the CLI validate against it, and the checker
`scripts/check-contracts.mjs` keeps schema, docs and code in sync.

## Frozen baseline

| Item | Value |
|---|---|
| Freeze commit | `35a51c3` (published 0.2.4 code base; version is not bumped by this change) |
| Frozen at | 2026-11-20 |
| Contract tree version | v1 (`versions-v1.json`) |
| Compat mode | `backward` for CLI JSON; `additive` for MCP tools/resources; exit codes are frozen v1 (v2 is a draft) |
| License | Intended: CC BY-NC-SA 4.0 (see `LICENSE` and the status note below) |

## Artifact index

| Artifact | Version | What it freezes |
|---|---|---|
| `versions-v1.json` | 1 | Manifest: every contract version + the expected `status.contracts` discovery payload. |
| `cli/read-models-v1.schema.json` | 1 | JSON Schema `$defs` for the deterministic `--json` read payloads (status/today/commit/who/deliveries/agenda/morning/matter/evidence/privacy/tos/tick/remind). |
| `cli/commands-v1.json` | 1 | command -> argv -> schema `$ref` map with determinism/needsKey/needsTos metadata and the fixture used by the checker. |
| `cli/errors-v1.schema.json` | 1 | The stderr error envelope `{"error":{"code","message","hint?","details?"}}`. |
| `cli/status-v1.json` | 1 | `advisers status --json` contract + the additive `contracts` discovery field rules. |
| `cli/exit-codes-v1.json` | 1 | Exit codes 0/1/3 + probe commands that assert them. |
| `cli/exit-codes-v2.draft.json` | 2-draft | Reserved 4/5/6 for the policy engine. **NOT ACTIVE**; scripts must key on `error.code`. |
| `errors/codes.v1.json` | 1 | Generated error-code registry (source of truth: `packages/advisers/lib/error-codes.js`). |
| `mcp/tools-v1.json` | 1 | 7 MCP tools: name, description snapshot, inputSchema, annotations, side effect. |
| `mcp/resources-v1.json` | 1 | 4 MCP resources: URI, name, mimeType, payload schema ref. |
| `mcp/versions-v1.json` | 1 | Supported legacy protocol versions + negotiation status + methods. |
| `mcp/errors-v1.json` | 1 | JSON-RPC error codes `-32600/-32601/-32602/-32603/-32700/-32002` + tool `isError` envelope. |
| `mcp/responses-v1.schema.json` | 1 | JSON Schema for initialize/tools-list/resources-list/resources-read/tool-call/error responses and the JSON payloads inside them. |
| `vectors/cli/read-models.vectors.json` | 1 | Accept/reject conformance vectors for every top-level read-model payload. |
| `vectors/cli/errors.vectors.json` | 1 | Accept/reject vectors for the error envelope. |
| `vectors/mcp/responses.vectors.json` | 1 | Accept/reject vectors for MCP envelopes and payloads. |
| `CONSUMERS.json` | 1 | Who consumes which contract (and whether it runs in this repo's CI). |
| `README.md`, `LICENSE` | 1 | Rules and intended license. |

## Versioning rules

1. Every `*.schema.json` carries `$schema`, `$id`, `version`, `x-license`, `x-contract-status`,
   `x-frozen-at`, `x-source-commit` and `x-compat`.
2. **Minor (additive)**: a new optional field, a new command, a new tool/resource, a new
   error code. Old consumers keep working. This is the only kind of change allowed inside
   a frozen major version.
3. **Major**: removing/renaming a field, changing a required field, changing an enum
   meaning, changing an exit code's meaning. Requires a new `v2` artifact + migration
   notes + keeping the old artifact and its vectors.
4. **Closed contracts**: Pet Brief (`docs/pet-brief/schema-v0.2.json`,
   `additionalProperties:false`) treats additive changes as breaking; the consumer must
   upgrade first. It is not duplicated here on purpose (no drift).
5. A contract artifact and its vectors change in the same PR. Deleting or renaming a
   contract requires one minor deprecation window + CHANGELOG + `CONSUMERS.json` update.

## How to change / validate

```sh
node scripts/check-contracts.mjs            # all checks (8)
node scripts/check-contracts.mjs --schema   # schema metadata + keyword subset only
node scripts/check-contracts.mjs --update   # regenerate errors/codes.v1.json + docs/ERROR-CODES.md
```

The checker runs offline, with a temporary `ADVISERS_HOME` and no credentials:
`--schema`, `--vectors`, `--cli`, `--status`, `--exit`, `--mcp`, `--errors`, `--docs`.

## License status

Advisers software is PolyForm Noncommercial 1.0.0; documentation/data (including these
contract artifacts) is CC BY-NC-SA 4.0 (see `../LICENSING.md` and `../LICENSE-DOCS`).
`LICENSING.md`'s scope list does not yet enumerate `contracts/`; this directory is
intended to be documentation/data under CC BY-NC-SA 4.0 and every JSON artifact carries
`x-license`. Changing the legal scope text needs owner/legal confirmation and is out of
scope for the contracts-only implementation (tracked in `docs/CONTRACTS.md`).
