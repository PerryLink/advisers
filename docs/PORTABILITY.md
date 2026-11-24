# Portability: portable home bundle v1

Status: **the bundle format shipped in 0.5.0; 0.5.1 adds the self-describing contract
and one-command acceptance** (`FORMAT.md`, `import --bundle --verify
--expect-dataDigest`, `scripts/bundle-drill.mjs`; plan 121/126 WF1 and 201 A2/A4/A5).
This page documents the format, the clean-home acceptance test and the privacy
boundary of a bundle. A bundle is an export format, not a migration; the local
ledger is schema **v23** in 0.5.1.

A bundle is a **plaintext directory that carries one whole local Advisers home** so
it can be moved to another machine, opened after a lost device, or kept if the
product is discontinued. It needs no account, no network and no original
installation to be verified. It is deliberately *not* a sync format and not a
selective export: one bundle = one whole home (`scope: "local-all"`).

```sh
# Export the current home (export is TOS-exempt: it only reads the ledger)
advisers export --bundle /tmp/advisers-bundle --json

# Verify first on the target machine (offline; TOS-exempt; writes nothing)
advisers import --bundle /tmp/advisers-bundle --verify --dry-run --json

# One-command acceptance: the dataDigest from the source export must match
advisers import --bundle /tmp/advisers-bundle --verify --dry-run \
  --expect-dataDigest <64-hex digest from the source manifest> --json

# Import into a clean home (bootstrap); a populated target needs --replace
ADVISERS_ACCEPT_TOS=1 advisers import --bundle /tmp/advisers-bundle --verify --json

# Prove the round trip: dataDigest and counts must equal the source manifest
advisers export --bundle /tmp/advisers-bundle-2 --json
```

`export --bundle` and `import --bundle` require the SQLite store
(`ADVISERS_STORE=sqlite`, which is the default). The legacy JSON store has no
bundle path (`E_BUNDLE_SQLITE_REQUIRED`). `import --bundle --verify --dry-run` is
exempt from the TOS gate and creates no `~/.advisers` (it only reads an untrusted
directory; see `docs/CLI-JSON.md`). A real import is gated like any write: without
consent it exits 3 and records a `tos.block` audit row, which does create the local
home/audit chain on first use. `--replace` is a TOS L2 surface and re-confirms the
terms.

## 1. Directory layout (bundle v1)

| Path | Role | Imported? |
|---|---|---|
| `manifest.json` | format/version/scope/schemaVersion/counts/tables/dataDigest/files/excluded | read to verify |
| `ledger.json` | **authoritative data**: the ledger snapshot (`matters`, `facts`, `commitments`, `preferences`, `links`, `updates`, `routines`, `routinePatches`, `routes`) plus the raw `data` tables | yes, and it is the only file imported |
| `facts.md` | human-readable fact projection | never |
| `kb/<id>.md` | human-readable projection of `kb_documents` + `kb_chunks` | never |
| `pages/<id>.md` | human-readable projection of the derived `kb_pages` table | never (pages are rebuilt) |
| `IMPORT.md` | fixed instructions (contents, clean-machine steps, rules, boundary) | never |
| `FORMAT.md` | in-bundle format contract (layout, table/column dictionary, `dataDigest` algorithm, minimal-reader pseudocode); added in 0.5.1, covered by `SHA256SUMS` | never (a 0.5.0 bundle has none and stays readable) |
| `SHA256SUMS` | coreutils-format sha256 of every other file in the directory (including `manifest.json`) | used to verify |

Directory mode `0700`, file mode `0600`. All paths are POSIX-style relative paths,
forward slashes only, at most 4 segments and 120 characters, no `..`, no symlinks,
no Windows reserved names. Projections are cross-checked structurally: the number
of `kb/*.md` files must match the `kb_documents` rows, `facts.md` must exist and be
non-empty. Do not hand-edit or hand-delete projection files; re-export instead.

## 2. Manifest v1

`manifest.json` is canonical JSON (sorted keys, two-space indent, trailing LF).
The fields below are required; the v1 verifier ignores unknown extra top-level keys
(forward compatibility) but fails on any missing/changed required field.

| Field | Value / meaning |
|---|---|
| `format` | `"advisers-bundle"` |
| `version` | `1` |
| `verificationBasis` | `"local-checksums-only"` |
| `scope` | `"local-all"` (one whole home; there is no per-subject bundle) |
| `subject` | always `null` in v1 |
| `generatedAt` | ISO date-time; a time field only (never part of `dataDigest`) |
| `generator` | `{advisersVersion, nodeVersion, command: "export --bundle"}` |
| `schemaVersion` | source database schema (currently 22) |
| `counts` | rows per bundle data table (see §3) |
| `tables` | the 20 bundle data table names, sorted |
| `dataDigest` | sha256 of the canonical data digest (see §3) |
| `files` | `[{path, size, sha256}]` for every file except `manifest.json`/`SHA256SUMS`, sorted |
| `fileCount` | number of those data files (manifest and sums excluded) |
| `checksumCount` | `fileCount + 1`: `SHA256SUMS` covers every other file, including `manifest.json` |
| `excluded` | advisory list of what deliberately never travels (see §7) |
| `disclaimer` | `true` |

`ledger.json` is `{version, schemaVersion, exportedAt, ledger, data, auditAnchor: null,
sourceAudit: {count, headHash}}`. The source audit hash chain is HMAC-keyed by the
source home, so it never travels; only its count and head hash are recorded. On
import the target home keeps its own audit chain and its own `audit.key`.

## 3. `dataDigest` v1 — the portability acceptance metric

```
domain = DATA_TABLES − audit − kb_pages        (20 tables, sorted)
digest = sha256(JSON.stringify(canonicalize({
           version: 1,
           tables: [{name, rows, data} ... sorted by name],
         })))
```

- Each `data` array keeps the store row order (`ORDER BY rowid`), and object keys
  are canonicalized (sorted), so column order is not part of the metric.
- `generatedAt`/`exportedAt` are **not** inputs: two exports of the same home
  report the same `dataDigest` and `counts`.
- The data domain is the 20 tables `client_notes, clients, deliveries, kb_chunks,
  kb_documents, kb_fact_links, mail_accounts, mail_messages, mail_sync_runs,
  memory_candidates, nudges, payments, permit_consumed, projects, receivables,
  session_summaries, sessions, summary_versions, task_runs, turns`.
- `audit` and `kb_pages` are excluded because they are machine-local or derived:
  the audit chain is keyed by this home's `audit.key`, and `kb_pages` is a
  deterministic projection rebuilt on import.
- The ledger snapshot (matters/commitments/facts/preferences/...) travels in the
  same `ledger.json`; it is covered by `SHA256SUMS` and by structural +
  referential validation, but `dataDigest` itself only covers the `data` tables.
- On import, Advisers recomputes `dataDigest` from `ledger.json` and refuses a
  mismatch (`E_BUNDLE_TAMPERED`). `import --bundle --verify --dry-run` prints the
  manifest and the recomputed values.

Acceptance is therefore: **two exports of the same home report the same
`dataDigest`/`counts`, and a clean-home import followed by a re-export reports the
same `dataDigest`/`counts` again.** The `manifestDigest` is *not* an equality
metric: it changes with `generatedAt`.

## 4. Clean-home acceptance (copy-paste)

```sh
# H1 = the old machine/home; H2 = a fresh, empty ADVISERS_HOME
advisers export --bundle "$H1_BUNDLE" --json            # record dataDigest + counts

export ADVISERS_HOME="$H2"
advisers import --bundle "$H1_BUNDLE" --verify --dry-run --json   # exit 0; no write
ADVISERS_ACCEPT_TOS=1 advisers import --bundle "$H1_BUNDLE" --verify --json
advisers doctor --check-db --json                       # ok:true (no managed backup is expected in a new home)
advisers export --bundle "$H2_BUNDLE" --json            # dataDigest + counts == H1
(cd "$H1_BUNDLE" && sha256sum -c SHA256SUMS)             # every file: OK
```

Expected: the dry run reports `bootstrap:true` for a clean home and changes
nothing; the real import bootstraps the ledger, rebuilds compiled KB pages
(and clears the derived `kb_pages` first), rebuilds the FTS indexes, and clears a
stale `sync.state.json` if one existed. No network call, no model call, no new
runtime dependency.

On a target home whose database already holds user data the import refuses
without `--replace` (`E_BUNDLE_TARGET`); `--replace` writes a managed
`pre-import` backup first and replaces the whole ledger in one transaction.

## 5. Safety rules and negative cases

The verifier treats the directory as **untrusted input**; the builder verifies
the bytes that reached disk before renaming the staging directory into place.
A failed export leaves the output directory as it was (staging is swept); a failed
import rolls the database transaction back, and the pre-import backup remains as
the safety net (it is a deliberate artifact, not a partial import).

| Attack / mistake | Result |
|---|---|
| edited `SHA256SUMS` / `manifest.json` / `ledger.json` bytes (without a full re-export) | `E_BUNDLE_TAMPERED` (hash mismatch) |
| edited `ledger.json` data without recomputing `dataDigest` | `E_BUNDLE_TAMPERED` |
| symlinked bundle directory or file inside it | `E_BUNDLE_INVALID`/`E_BUNDLE_TARGET` |
| extra unknown file or path outside the v1 layout | `E_BUNDLE_INVALID` |
| `..`/absolute/backslash path or Windows reserved name | `E_BUNDLE_INVALID` |
| over any size/entry/depth cap | `E_BUNDLE_LIMIT` (bounded reads, refuses before hashing everything) |
| bundle schema newer than the CLI | `E_BUNDLE_INVALID` (upgrade first) |
| non-empty local database without `--replace` | `E_BUNDLE_TARGET` |
| bundle target = `ADVISERS_HOME` or inside `backups/credentials/scheduler` | `E_BUNDLE_TARGET` |
| `--force` over a non-empty output directory | old tree renamed to `<dir>.replaced-<UTC>`, **never deleted** |
| `--encrypted` | refused in 0.5.0: bundle v1 is plaintext-only |

Limits (enforced by both builder and verifier): `maxEntries 4096`, `maxDepth 4`,
`maxFileBytes 512 MiB`, `maxTotalBytes 2 GiB`, `maxSumsBytes 2 MiB`,
`maxManifestBytes 1 MiB`, `maxLedgerBytes 512 MiB`, `maxImportBytes 1 MiB`,
`maxFactsBytes 8 MiB`.

`--force` on export never deletes user data; on import it only authorises the
whole-home replace (a `pre-import` managed backup is still taken).

## 6. What a bundle deliberately never contains

`excluded` in the manifest and `IMPORT.md` state the same list:

`audit`, `kb_pages`, `mail_cursors`, `kb_fts`, `kb_pages_fts`, `credentials`,
`audit.key`, `audit-anchor.json`, `scheduler`, `logs`, `briefs`, `soul`,
`workspace`, `sync.state.json`, `undo`, `exports`, `receipts`.

Consequences worth knowing: mail-account credentials and the audit HMAC key never
leave the home; IMAP cursors are local (a lost cursor costs one rescan, message
dedupe is the correctness guard); the derived page/FTS projections are rebuilt;
`soul.md` and the workspace are not part of the ledger export.

## 7. Privacy: a bundle v1 is PLAINTEXT

**Bundle v1 is not encrypted.** It is a plaintext export by design in 0.5.0;
`--encrypted` is refused and is a later-version opt-in (not a shipped claim).

A bundle contains personal data from the source home, including:

- customer records and notes (`clients`, `projects`, `client_notes`);
- mail accounts (`mail_accounts`: display name, host, port, username/mailbox) and
  mail messages (`mail_messages`: `from_addr`, `subject`, `sent_at`, `body_text`,
  attachment metadata);
- knowledge-base text (`kb_documents`, `kb_chunks`);
- money amounts as integer minor units (`receivables`, `payments`, memos);
- conversation data (`sessions`, `turns`, summaries) and memory candidates;
- the ledger snapshot itself (matters, commitments, facts, preferences — including
  verbatim quotes and evidence pointers).

Handle it like a database dump: keep it on an encrypted disk, do not put it in a
shared or synced folder that other people can read, restrict the file mode
(`0600`), and delete copies you no longer need. The `IMPORT.md` inside the bundle
repeats this warning so a recipient who never reads these docs still sees it.

## 8. Boundary of the checksums

`verificationBasis: "local-checksums-only"`. SHA-256 proves that the files of the
bundle are internally consistent and detect edits made after generation. It is
**not** a signature, **not** a trusted timestamp and **not** notarization: whoever
can rewrite the whole directory can recompute every checksum. Do not present
`import --bundle --verify` as proof of who generated the bundle or when.

`sourceAudit{count, headHash}` records how many audit rows the source home had and
its chain head, but the chain itself is not verifiable outside that home. That is
why the manifest carries the field but does not claim a verified history.

## 9. If Advisers is discontinued (exit drill)

1. `advisers export --bundle <dir> --json` and record `dataDigest`/`counts`.
2. `cd <dir> && sha256sum -c SHA256SUMS` (Windows: compare `Get-FileHash` values).
3. Keep at least one copy off the machine, on an encrypted disk (the bundle is
   plaintext; there is no v1 encryption).
4. On a clean machine, install Advisers 0.5.1 or newer while it is still
   available and run `import --bundle <dir> --verify`; pass
   `--expect-dataDigest <hex>` to get a one-command pass/fail, and compare
   `dataDigest`/`counts` yourself. The same round trip is automated by
   `node scripts/bundle-drill.mjs` in CI and in the release evidence, including a
   v22 bundle -> v23 home case and a separate `ledger.json` semantic-parity
   assertion. `dataDigest` covers `DATA_TABLES` (not the ledger-snapshot tables) —
   the snapshot is protected by `SHA256SUMS`, so never quote `dataDigest` alone as
   "every ledger row is identical".
5. Last resort: `ledger.json` is documented JSON (ledger snapshot v1 + raw data
   tables) with no executable content, and `FORMAT.md` inside a 0.5.1+ bundle
   carries the layout/table dictionary and minimal-reader pseudocode, so a future
   reader needs only a JSON parser and the field names. 0.5.0 bundles have no
   `FORMAT.md`; use the repository docs and source tree for those.

## 10. Windows notes

- Run the commands from PowerShell; use a normal absolute path for `--bundle`
  (`C:\Users\you\advisers-bundle`). Entry paths stay <= 120 characters and <= 4
  segments, so the default 260-character path limit is not a concern.
- `sha256sum` is usually absent; use
  `Get-FileHash -Algorithm SHA256 <file>` and compare with `SHA256SUMS`,
  or simply re-run `import --bundle --verify --dry-run`.
- The POSIX directory/file modes are advisory on Windows; NTFS ACLs still apply.
- Requires Node >= 22.16 (the `node:sqlite` floor).

## 11. Known limits / not in 0.5.1

- **No encryption** (`--encrypted` is a 0.6 item; bundle v1 remains plaintext).
- **No signature / trusted timestamp / notarization**; checksums are local only.
- **No selective or redacted bundle**: scope is the whole home (`local-all`).
- **No merge**: import is a whole-home bootstrap or replace, not a multi-writer merge.
- **No automatic deletion**: exports are never deleted automatically; `--force`
  moves an old tree aside.
- **No JSON-store bundle**: SQLite only.
- **Schema gate**: export requires a database already migrated to the current CLI
  schema; import of an older bundle is accepted with a warning (missing columns
  take defaults), a newer bundle is refused. 0.5.1 verifies/imports a 0.5.0 bundle
  (no `FORMAT.md`, warning) but a 0.5.1 bundle is **not** readable by the 0.5.0 CLI
  (the strict v1 layout does not know `FORMAT.md`).
- **Expect-digest is offline and additive**: `--expect-dataDigest` compares the
  recomputed `dataDigest` with the value you were given; it is not a signature.
- **No bundle exchange over MCP/DSH/receipts**: bundles stay on the local
  filesystem; the CLI is the only entry point.

## Related

- [CLI-JSON.md](CLI-JSON.md) — `export --bundle` / `import --bundle` JSON shapes.
- [SYNC.md](SYNC.md) — the separate encrypted snapshot sync (not a bundle).
- [PRIVACY.md](PRIVACY.md) — the full data-flow notice (legal text, unchanged).
- [QUALITY.md](QUALITY.md) — where the release-time bundle drill result is recorded.
- [REACH.md](REACH.md) — what can reach the local home (MCP/DSH/bridge).
- [CONTEXT-PACK.md](CONTEXT-PACK.md) — the bounded disclosure counterpart.
