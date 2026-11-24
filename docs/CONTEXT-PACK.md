# Context pack v1 — offline-verifiable disclosure for another agent

Status: **shipped in 0.5.0; issuance audit + host verification added in 0.5.1**
(`context-pack create` / `context-pack verify`; plan 122/126 WF3 and 202 A4/A5).
0.5.1 adds one local `context_pack.create` audit row on create and lets MCP
`advisers_pack_verify` dispatch on `manifest.format`, so a host agent can verify a
received context pack offline; no new tool/resource is added (8/5, DSH 6).

A context pack is a small, bounded, **one-way disclosure directory**: an operator
selects a few current rows from one client/matter, labels who receives it and
why, and the recipient can verify the directory offline. It is not a ledger
export and it is **not importable**. Its job is to make a disclosure auditable
without granting read or execution authority.

```sh
# 1. Candidates only (read-only; writes nothing)
advisers context-pack create --subject client:cl_abc --json

# 2. Write the pack from explicitly selected rows
advisers context-pack create --subject client:cl_abc --ids cm_1,fact_2 \
  --recipient "Acme review" --purpose external-review --out /tmp/pack --json

# 3. Verify offline (no HOME, no database, no network; exit 0/1)
advisers context-pack verify /tmp/pack --json
```

## 1. Naming and surfaces

| Surface | Status in 0.5.1 |
|---|---|
| `advisers context-pack create\|verify` | the only name; there is no `pack context`/`pack verify` alias |
| `advisers evidence verify <dir>` | the single CLI format-dispatch entry: context pack -> client status pack -> delivery receipt |
| `advisers deliveries --pack` / `--receipt` | unchanged (separate frozen formats) |
| MCP `advisers_pack_verify` | 0.5.1 dispatches on `manifest.format`; a context pack (`advisers-context-pack`) is verified by the same offline verifier, the evidence-pack/receipt path keeps its exact previous output |
| MCP/DSH tools and resources | unchanged (8 tools / 5 resources; DSH 6 tools); context packs are CLI-only to create, host-verifiable read-only via `advisers_pack_verify` |

## 2. Pack layout (manifest v1)

Three files, directory `0700`, files `0600`:

| File | Role |
|---|---|
| `manifest.json` | subject, recipient, purpose, expiry, disclosure block, items with their payload + sha256 |
| `README.txt` | human-readable boundary and offline verification steps |
| `SHA256SUMS` | coreutils-format sha256 of `manifest.json` and `README.txt` (exactly two entries) |

`manifest.json` top-level keys (required; unknown extra keys are warned and ignored
for forward compatibility, missing/invalid required fields fail):

| Field | Meaning |
|---|---|
| `format` | `"advisers-context-pack"` (the value `evidence verify` dispatches on) |
| `version` | `1` |
| `generatedAt` | ISO date-time |
| `generator` | `{advisersVersion, nodeVersion, platform, command}` |
| `subject` | `{kind: "client"\|"matter", id, name}` — the ledger subject the pack was assembled from |
| `recipient` | `{name, email?}` — a **disclosure record**, max 200 chars per field |
| `purpose` | closed enum: `client-delivery` \| `external-review` \| `handoff` |
| `expiresAt` | ISO date-time; defaults to `generatedAt + 24h` |
| `verificationBasis` | `"local-checksums-only"` |
| `disclosure` | see §4 (required; invariants enforced by the verifier) |
| `items` | 1..16 item objects (see §3) |
| `fileCount` | `3` |

## 3. Items and the per-kind payload whitelist

Each item is `{id, kind, view, fields, verification, payload, sha256}`. `id` is the
ledger ref (`cm_*`, `fact_*`, `pref_*`, `del_*`), `kind` is one of `commitment`,
`fact`, `preference`, `delivery`; `view` is one of `verified`, `pending`,
`historical`; `fields` must be exactly the sorted payload field names; `sha256` is
the sha256 of the canonical payload bytes.

Only these payload fields may appear (any other key is an error, not a warning):

| Kind | Allowed payload fields |
|---|---|
| `commitment` | `action`, `debtor`, `creditor`, `dueAt`, `status`, `matterId`, `evidence[]` |
| `fact` | `subject`, `predicate`, `object`, `validFrom`, `validTo`, `recordedAt`, `matterId`, `quote?`, `quoteSha256?` |
| `preference` | `kind`, `statement`, `scope`, `priority`, `validFrom`, `expiresAt`, `quote?`, `quoteSha256?` |
| `delivery` | `title`, `tool`, `templateName`, `createdAt`, `matterId` |

`commitment.evidence[]` entries are pointer metadata only and are restricted to
`type`, `ref`, `sessionId`, `turnId`, `messageId`, `docId`, `pageId`, `chunkIndex`,
`url`, `tool`, `toolName`, `retained`, `kind` (at most 50 pointers).

`quote` is excluded by default. `--include-quotes` opts in, and then each quote is
bounded to 500 characters and covered by `quoteSha256`; longer quotes are omitted
with a warning.

## 4. Disclosure block

`manifest.disclosure` is metadata about what the pack reveals:

| Field | Meaning |
|---|---|
| `autoAssembled` | `true` — candidates were assembled from the subject, then explicitly selected/confirmed |
| `candidateCount` | how many candidates existed when the pack was built (>= `selectedCount`) |
| `selectedCount` / `itemCount` | number of packed items (equal to `items.length`) |
| `fields` | sorted union of every item's payload field names (names only, never values) |
| `includesQuotes` | whether any item has a `quote`; must match the items |
| `includesOriginalSources` | always `false` in v1 |
| `confersReadAuthority` | **always `false`** — a pack grants no read permission over the ledger |
| `confersExecutionAuthority` | **always `false`** — a pack cannot cause an action |
| `excluded` | `{total, byReason: {secrecy, stale, unsupportedKind, notFound}}`; `total` must equal the sum |

`recipient`/`purpose`/`expiresAt` are disclosure records, **not authentication,
not DRM and not access control**: once the recipient has the directory they can
copy and forward it. The two `confers*Authority` flags are always false and the
verifier rejects a pack where either is not false.

## 5. Automatic candidate assembly (read-only)

`context-pack create --subject client:<id>|matter:<id>` without `--ids`/`--yes`
only lists candidates; it never writes a pack and never writes the ledger.

- Scope is SQL-derived from the subject: a client sees only its own matters; a
  matter sees only itself. No full-table read followed by an in-memory filter of
  another client's rows.
- Packable kinds: open `commitment`s, current `fact`s (confirmed, non-expired,
  non-superseded), current `preference`s (confirmed, non-expired, matter/project
  scoped) and `delivery` **metadata**. Notes, mail and KB documents are counted as
  `unsupportedKind` and never returned.
- Effective secrecy is `max(client.secrecyDefault, matter.secrecy)`. The CLI runs
  at clearance 0 (fail closed); rows above the clearance are filtered **before**
  counting/paging and only appear in `excluded.byReason.secrecy` (no id/title
  leaks). Archived matters are `stale`.
- `excluded.byReason` precedence is `secrecy > stale > unsupportedKind > notFound`,
  so counts add up and never double-count. These are counts of *excluded* rows,
  not a summary of what was packed.
- Ordering reuses the frozen customer timeline order (instant DESC, then
  delivery < commitment < fact < preference, then id ASC); two runs over the same
  rows are byte-identical.
- `--since 180d` / `--since 2026-01-01T00:00:00Z` limits candidates by their
  relevant timestamp; no cutoff by default. `--candidate-limit` defaults to 50,
  hard-capped at 200 (totals stay exact).

Candidate JSON (`mode: "candidates"`) carries `subject`, `generatedAt`,
`candidates[] {ref, kind, title, at, view, verification, selectable}`, `counts`
(`candidates`, `candidateTotal`, `selectable`, `truncated`, `byKind`), `excluded`,
`limits` and a copy-pasteable `next` command. It is a read-only preview: no pack is
written until the operator passes `--ids ...` or `--yes`.

## 6. Writing a pack

`--ids` and `--yes` are mutually exclusive and one is required to write:

- `--ids <ref,...>` packs exactly the listed current rows (duplicates are
  collapsed; rows outside the subject scope, above clearance, stale or of an
  unsupported kind fail closed with the documented code).
- `--yes` confirms all selectable candidates (never more than the 16-item cap;
  more candidates than that is `E_CONTEXT_PACK_LIMIT`).
- `--recipient <name>` and `--purpose <enum>` are required; `--recipient-email` is
  optional; `--expires` accepts `24h`/`7d`/an ISO instant (default `+24h`).
- `--out <dir>` defaults to `$ADVISERS_HOME/exports/context-<subject-id>-<timestamp>`;
  a non-empty target is refused unless `--force`, which renames the old tree aside
  (never deletes it).
- `--include-quotes` opts quotes in (bounded, see §3).
- Writing a pack is a local write and is TOS-gated like other ledger commands.

`context-pack create` verifies the pack it just wrote before returning; JSON
includes `out`, `format`, `version`, `manifestDigest`, `verificationBasis`,
`subject`, `recipient`, `purpose`, `expiresAt`, `disclosure`, `fileCount`,
`checksumCount`, `bytes` and `verification`.

## 7. Offline verify

`context-pack verify <dir> [--expect-manifest-sha256 <64hex>] [--json]` is a
standalone verifier for an **untrusted directory**:

- reads no `~/.advisers` database, no HOME and no network; TOS-exempt; exit 0 on
  success, 1 on any failure;
- walks the directory with hard bounds before hashing anything (16 entries,
  depth 1, 256 KiB total, 64 KiB per sums/manifest — a hostile directory cannot
  exhaust memory or time);
- checks that exactly `manifest.json` + `README.txt` exist and are covered by
  `SHA256SUMS` (two entries), that every hash matches, that the manifest schema
  and item shapes are valid, that the payload whitelist and forbidden-key list
  hold, that per-item `sha256` matches the canonical payload, and that the
  disclosure invariants hold (flags false, counts equal, fields equal the union);
- `--expect-manifest-sha256` additionally pins the manifest bytes; a mismatch is
  `E_CONTEXT_PACK_DIGEST_MISMATCH`.

The report includes `format`, `version`, `fileCount`, `checksumCount`, `bytes`,
`files`, `manifestDigest`, `verificationBasis` and warnings; since 0.5.1 it also
reports `expiresAt`/`expired` additively — an expired pack only adds a warning and
does **not** change the 0/1 `ok` result (expiry is a disclosure hint, not a
checksum failure). The same check runs inside `evidence verify` after format
dispatch, and the MCP `advisers_pack_verify` context-pack path uses the same
verifier.

`README.txt` states the boundary in plain language (selected items only, no
amounts/bodies/full text, no read/execution authority, no import path, checksums
are not a signature) and gives both verification commands.

## 8. Limits (v1)

| Limit | Value |
|---|---|
| items per pack | 16 |
| single item JSON | 8 KiB |
| all items together | 32 KiB |
| manifest.json | 64 KiB |
| total pack | 256 KiB |
| SHA256SUMS | 64 KiB |
| directory entries | 16 |
| directory depth | 1 |
| candidate page | 50 default / 200 max |

Limits are stable error codes (`E_CONTEXT_PACK_LIMIT`) on both build and verify;
the verifier enforces the same numbers so a received pack cannot be accepted with
a different limit set.

## 9. No re-ingestion (one-way by construction)

There is deliberately **no import path** for a context pack. `import`,
`import --bundle` and the legacy file import explicitly refuse a directory whose
`manifest.format` is `advisers-context-pack`
(`E_CONTEXT_PACK_IMPORT_UNSUPPORTED` / a clear usage message). A pack can never
become ledger rows, read authority, claims or actions, and it is never exposed
through MCP/DSH. Deleting a pack does not modify the local ledger.

## 10. What never enters a pack

- money: amounts/currency/paid/outstanding/payments/receivables keys are forbidden
  anywhere in the manifest (case-insensitive, depth-capped);
- mail bodies, subjects and headers; KB full text; attachment bytes; file paths
  and file lists;
- client notes and conversation text;
- evidence originals: `includesOriginalSources` is always false — only pointer
  metadata and, with `--include-quotes`, a bounded quote travel;
- global/audience preferences and rows outside the subject scope;
- non-current rows (stale facts/commitments/preferences) and archived matters;
- rows above the clearance (counted only as `excluded.byReason.secrecy`).

## 10.1 Issuance audit (0.5.1)

`context-pack create` now appends one local audit row **after** the pack is written
and self-verified: action `context_pack.create`, actor `local`, allowed `true`,
reason `subject=<kind>:<id> purpose=<purpose> items=<n> manifestDigest=<64hex>
recipientHash=<64hex>` (a salted hash; no recipient name/email, no item text, no
values). `create --json` exposes it additively as
`audit: {ok, action, reason}`. The audit chain is local; this is a record of what
this home issued, not a recipient acknowledgement, signature or revocation.

## 11. Verification boundary

`verificationBasis: "local-checksums-only"` — SHA-256 proves pack internal
consistency and detects edits after generation, not authorship or generation time:
anyone able to rewrite the whole directory can recompute the sums.

Each item also carries `verification: {basis: "local-resolution", resolved,
missing, unverifiable, notChecked}` and a `view`. `view: "verified"` only means
the evidence pointer resolved against the **local** ledger at build time; it is not
a truth claim and not a promise that the recipient can resolve the same pointer.
Never describe a context pack as a signature, a trusted timestamp, proof of who
generated it, or access control.

## 12. Error codes

`E_CONTEXT_PACK_INVALID`, `E_CONTEXT_PACK_LIMIT`,
`E_CONTEXT_PACK_DIGEST_MISMATCH`, `E_CONTEXT_PACK_IMPORT_UNSUPPORTED`,
`E_CONTEXT_PACK_ENTRY_NOT_FOUND`, `E_CONTEXT_PACK_ENTRY_STALE`,
`E_CONTEXT_PACK_SECRECY_BLOCKED`, `E_CONTEXT_PACK_UNSUPPORTED_KIND`. All exit 1
(verification failures exit 1; `verify` never exits 3).

## Related

- [CLI-JSON.md](CLI-JSON.md) — JSON shapes for candidates, create and verify.
- [PORTABILITY.md](PORTABILITY.md) — the whole-home bundle (the importable export).
- [DELIVERY-RECEIPT.md](DELIVERY-RECEIPT.md) — the separate delivery receipt pack.
- [PRIVACY.md](PRIVACY.md) — the legal data-flow notice (unchanged by 0.5.0/0.5.1).
- [MAIL-FOLLOWUP.md](MAIL-FOLLOWUP.md) — the 0.5.1 read-only follow-up engine (not pack content).
