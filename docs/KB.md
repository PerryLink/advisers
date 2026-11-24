# Knowledge base (KB): deterministic compiled pages and local search

> Status: **0.5.1, schema v23** (`SCHEMA_VERSION = 23`). The KB is a local,
> deterministic knowledge layer: it indexes extracted text from your own files,
> builds compiled pages from the local ledger, and answers lexical searches. It is
> **not** RAG, not a chatbot, not a vector store, and it does not call a model or
> the network in 0.4.x/0.5.x. The modern-MCP/DSH surfaces do not expose KB content in
> 0.4.x/0.5.x (see [MCP.md](MCP.md)); 0.5.0 and 0.5.1 add no KB command/surface (v23
> adds the facts claim/evidence columns that the fact layer can populate later).

## 1. Product positioning: why this is not RAG and not a chat product

Advisers needs to *accumulate* project knowledge and still be able to *show its
source*. Plain retrieval-augmented generation (chunk -> embedding -> top-k -> model)
and a model-written wiki were both rejected for 0.4.0; the shipped design is a
hybrid with the model-dependent parts deferred:

| Layer | What it is | 0.4.0 |
|---|---|---|
| L0 raw | The file is **not copied**. Only `basename`, SHA-256, extracted text and bounded chunks are stored; the source path is never stored. | yes |
| L1 compiled pages | Deterministic pages (`client`, `project`, `timeline`, `facts`) derived from local ledger rows, with source refs and an `inputsSha256` staleness hash. Stored in `kb_pages`; markdown is an export format, not the source of truth. | yes |
| L2 search | SQLite FTS5 external-content indexes over chunks and pages; 3+ character terms use `MATCH`, shorter/CJK-2 queries fall back to `LIKE` and report `degraded`; snippets cap at 240 characters and never return a whole document. | yes |
| L3 model | Model-assisted page compilation / `kb ask` (opt-in, consent, untrusted envelope, citation checks). | **not in 0.4.0** (0.4.x) |
| Vectors | Embeddings / `sqlite-vec` / external vector DBs. | **not planned for 0.4** |

Three consequences you can rely on:

1. **No model, no network.** `kb add`, `kb ls`, `kb show`, `kb rm`, `kb purge`,
   `kb reindex`, the page commands, `search --scope ...` and the `fact` views are
   local-only. A dead `ADVISERS_API_KEY`/`ADVISERS_BASE_URL` changes nothing. The
   only external program ever involved is the existing, explicit `ADVISERS_OCR_CMD`
   adapter, and KB ingest does **not** call it automatically (see `needsOcr` in §7).
2. **Deterministic output.** The same rows and the same query produce the same
   bytes, ordering and page hashes (timestamps are stored on rows, not hashed into
   page content). `dataSha256` on `morning` is unaffected by KB.
3. **Auditable references, not similarity scores.** Search hits carry stable
   `kb_doc`/`kb_chunk`/`kb_page` refs; facts link to KB documents through
   `kb_fact_links` (manual `kb link` is wired in 0.4.1; the 0.4.0 tarball exposed the
   library only, and the table and `evidence show --json.kbSources` were prepared for
   it). A hit is a
   deterministic match against text you ingested, not a model's opinion.

Explicit non-goals for 0.4.0: no chat/`kb ask`, no model-generated pages, no
embeddings or vector index, no automatic fact extraction from documents, no
automatic OCR, no MCP/DSH exposure, no remote/cloud KB, no multi-user sharing.

**Independently audited (2026-11-22).** A cross-check of the "use it as a
secretary" critique confirmed this shape and the usual mis-reading of it: compiled
pages are a **deterministic derived layer** (ledger rows in, manual `kb page
rebuild`, no model), not a model-written wiki and not automatic capture; the
ledger rows and evidence stay authoritative. The same audit confirmed that KB
documents do not extract facts automatically, a `mail sync` message does not enter
the KB automatically (KB ingestion is only an explicit `kb add` of a file), the
KB is not exposed over MCP/DSH in 0.4.3/0.5.0, and 1–2 character CJK queries are a
**performance** fallback (`LIKE`, `degraded:["short_query_like"]`) with correct
results, not a correctness gap. `sync`/`backup`/`vault` are whole-database
operations and therefore include the KB; see
[AUDIT-2026-11-22.md](AUDIT-2026-11-22.md).

## 2. Data model (schema v23 since 0.5.1; v22 introduced the KB tables)

| Table / index | Contents | Exported by `export --all` |
|---|---|---|
| `kb_documents` | One row per indexed source: `id` (`kb_...`), `kind`, `title`, optional `client_id`/`project_id`/`matter_id`, `source_name` (**basename only**), `source_sha256`, `mime`, `size_bytes`, `encoding`, `extractor`, `status` (`active`/`deleted`), `secrecy`, `needs_ocr`, `truncated`, `text_bytes`, `chunk_count`, `safety` (classification metadata JSON, no text), `created_at`, `captured_at`, `deleted_at`. | yes |
| `kb_chunks` | The extracted text, split deterministically: `id` (`chk_...`), `doc_id`, `seq`, `text`, `char_count`. Chunks are the only place document text is stored. | yes |
| `kb_fact_links` | Explicit fact <-> document relation (`source`/`mentions`), no automatic inference. | yes |
| `kb_pages` | Compiled deterministic pages: `id`, `kind`, `subject_id`, `title`, `markdown`, `json`, `source_refs`, `inputs_sha256`, `generated_at`, `status`. Derived and rebuildable; `kb page rebuild` is the only writer. | yes |
| `kb_fts` | FTS5 external-content index over `kb_chunks` (`tokenize='trigram'`, sync triggers). Rebuildable; not exported. | no (derived) |
| `kb_pages_fts` | FTS5 external-content index over `kb_pages`. Rebuildable; not exported. | no (derived) |

The plain KB tables are part of the single v22 migration step
(`kb-mail-payment-entities`); the two FTS indexes are created by an idempotent
`_setupKbFts()` inside that step because the tokenizer must be probed at runtime
(trigram -> unicode61 -> LIKE-only degradation). A database older than v22 fails
KB commands with `E_SCHEMA_STALE`; the first writable command migrates it after
writing and verifying `state.db.before-migrate-v21-*`. A 0.3.2 CLI opening a v22
database fails closed with `E_SCHEMA_NEWER` (upgrade is one-way; back up first).

## 3. Supported formats and limits

### 3.1 Formats

| Group | Extensions | Notes |
|---|---|---|
| Plain text | `.txt`, `.md`, `.markdown`, `.csv`, `.json`, `.jsonl`, `.log`, `.yaml`, `.yml`, `.xml`, `.html`, `.htm` | Encoding is detected as BOM (UTF-8/UTF-16LE/BE) -> strict UTF-8 -> GB18030; undecodable bytes fail with `E_KB_ENCODING` instead of storing mojibake. |
| Office | `.docx`, `.xlsx`, `.pptx` | OOXML text extraction inside a bounded ZIP budget. |
| PDF | `.pdf` | Up to 500 pages; a page cap sets `truncated` instead of silently dropping pages. |
| OFD | `.ofd` | Local OFD text extraction. |
| Mail file | `.eml` | Parsed locally as a document (single message); also see `mail import` for mailbox-shaped `.eml`/`.mbox` ingestion in [CLI-JSON.md](CLI-JSON.md). |
| Images / scans | `.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.tif`, `.tiff` | Never OCR'd automatically: stored as `needs_ocr=1`, `chunk_count=0`, and reported as a warning. Configure `ADVISERS_OCR_CMD` and re-run `kb add --replace` to index them. |

Unsupported extensions fail with `E_KB_UNSUPPORTED`; empty extraction fails with
`E_KB_EMPTY`; symbolic links and non-regular files are rejected with `E_KB_INVALID`
(the source file is opened read-only and never modified or copied).

### 3.2 Hard limits

| Limit | Value | Error / behaviour |
|---|---|---|
| Source file size | 50 MiB per file (`KB_MAX_FILE_BYTES`) | `E_KB_TOO_LARGE` |
| Extracted text | 2 MiB per document (`KB_MAX_TEXT_BYTES`) | `truncated=true` (explicit) |
| PDF pages | 500 per document | `truncated=true` |
| Archive (OOXML) budget | 4,000 entries, 256 MiB total uncompressed, 64 MiB per entry, 16M chars per XML part | `E_KB_TOO_LARGE` / `E_KB_INVALID` |
| Chunks per document | 2,000 (`KB_MAX_CHUNKS`); target 800 chars, hard max 1,500; no overlap | `truncated=true` with `chunk_limit` |
| Batch | 200 files per `kb add` invocation | `E_KB_LIMIT` |
| Query length | 200 code points | `E_QUERY_TOO_LONG` |
| Search results | default 20, max 200 per scope | `limit`/`total`/`truncated` |
| `kb ls` | default 50, max 200 | `limit`/`total`/`truncated` |
| `kb show --chunks` | 0..20 chunks, 400 characters each | previews only, never the full document |
| Page list | default 50, max 500 pages | `limit`/`total`/`truncated` |
| `fact as-of` | default 200, max 500 groups | `truncated` |

`kb add` accepts files only (no directory recursion) so a typo cannot index a
whole disk; pass `--from <list.txt>` (one path per line) or a shell expansion for
batches. A batch returns per-file outcomes; partial success exits 0 with
`counts.failed > 0`, and an all-failed batch exits 1.

## 4. Privacy, clearance and what is really stored

- **The source file is not copied.** Only the basename (`source_name`), the
  SHA-256 of the source bytes, and the extracted text in `kb_chunks` are stored.
  Absolute paths are never stored and never appear in JSON, stderr, audit reasons,
  or human output. Moving or deleting the original file does not affect the index
  (the document stays searchable until you `kb rm`/`kb purge`).
- **The extracted text is stored in plaintext in `state.db`.** The default
  database is not encrypted; `vault seal` encrypts the database at rest but see
  [PRIVACY.md](PRIVACY.md) for the exact data list and the residual copies
  (WAL, pre-migration/import/sync backups, `export --all` files). Do not index
  material you would not keep in the local SQLite ledger.
- **Clearance.** The effective secrecy of a document is
  `max(kb_documents.secrecy, client.secrecyDefault, matter.secrecy)`. All read
  commands default to clearance 3 (the local operator); pass `--clearance 0..3`
  for a projection that will leave the machine. Rows above the requested clearance
  are filtered **before counting and paging** and only contribute to
  `protectedExcluded`; no id/title/snippet/source name is printed. Unresolvable
  ownership fails closed as protected.
- **No network, no model, no telemetry.** KB commands never call a model, fetch a
  URL, or dispatch an external adapter. `kb add` classification is the same local
  content-safety classifier used elsewhere; a hard CSAM block fails the ingest
  (`E_CONTENT_SAFETY_BLOCKED`) and no row is written.
- **Audit.** `kb add`, `kb rm`, `kb purge`, `kb page rebuild` write exactly one
  audit row in the same transaction as the business write. Audit reasons contain
  ids/counts/bytes only: never titles, file names, paths or extracted text.

## 5. Commands

```sh
advisers kb add <file>... [--title s] [--kind quote|contract|receipt|delivery|note|other]
    [--client <id>] [--project <id>] [--matter <id>] [--secrecy 0-3] [--replace] [--from <list.txt>] [--json]
advisers kb ls [--client <id>] [--matter <id>] [--kind k] [--all] [--limit n] [--clearance 0-3] [--json]
advisers kb show <doc-id> [--chunks 0..20] [--json]
advisers kb rm <doc-id> [--json]
advisers kb purge <doc-id> [--dry-run|--yes] [--json]
advisers kb reindex [--rebuild] [--json]

advisers search <query> [--scope turns|kb|pages|facts|all] [--client <id>]
    [--matter <id>] [--kind k] [--limit 1..200] [--clearance 0-3] [--json]
advisers kb search <query> [--scope kb|pages|all] [--client ...] [--matter ...] [--limit n] [--json]

advisers kb page ls [--kind client|project|timeline|facts] [--check] [--limit n]
    [--clearance 0-3] [--json]
advisers kb page show <page-id> [--stored] [--diff] [--clearance 0-3] [--json]
advisers kb page rebuild [--kind k] [--id <page-id>] [--only-stale] [--dry-run]
    [--clearance 0-3] [--json]
advisers kb page diff <page-id> [--clearance 0-3] [--json]

advisers fact show <fact-id> [--include-deleted] [--json]
advisers fact history <fact-id> [--json]    # chain history includes tombstones
advisers fact as-of <YYYY-MM-DD|ISO> [--matter <id>] [--client <id>] [--subject s]
    [--predicate p] [--limit n] [--include-deleted] [--json]
```

`kb link`/`kb unlink` (`kb_fact_links` maintenance) are wired in the **0.4.1 CLI**;
the 0.4.0 tarball exposed the library only. Both commands validate the ids, fail
closed and write an audit row (`kb.link`/`kb.unlink`).

### 5.1 `kb add`

- `--kind` defaults to `other`; `--title` defaults to the basename.
- Ownership (`--client`/`--project`/`--matter`) is validated; a project must
  belong to the client and the client/matter must exist. Ownership drives the
  clearance filter, it never rewrites the classified document.
- Duplicate content (same `source_sha256`) is a **skip-level** result, not a
  failure: `{file, code: "E_KB_DUPLICATE", existingId}`. `--replace` tombstones the
  old document, deletes its chunks in the same transaction, and indexes the new
  bytes.
- JSON (one file or a batch; the same envelope is always returned):

```json
{
  "ok": true, "command": "kb add",
  "counts": {"added": 1, "skipped": 0, "failed": 0, "chunks": 16, "textBytes": 12000},
  "added": [{"id": "kb_...", "title": "报价单", "kind": "contract", "sizeBytes": 10123,
             "textBytes": 12000, "chunks": 16, "truncated": false, "needsOcr": false,
             "encoding": "utf-8"}],
  "skipped": [], "failed": [], "truncated": 0, "needsOcr": 0
}
```

- `truncated`/`needsOcr` on the envelope are **counts** of added files that hit a
  limit or need OCR. The full document object (ownership, `sourceName`,
  `sourceSha256`, `chunkCount`, `createdAt`, ...) is returned by `kb show`/`kb ls`.
- `skipped` entries are `{file, code:"E_KB_DUPLICATE", existingId}` and `failed`
  entries are `{file, code, message}`; `file` is always a basename. A batch with at
  least one failure exits 1; duplicates are skip-level.
- `needsOcr > 0` means a file is registered but **not searchable** (no text);
  the warning tells you to configure `ADVISERS_OCR_CMD` and re-add with `--replace`.

### 5.2 `kb ls` / `kb show`

- `kb ls` returns active documents only; `--all` includes tombstones. JSON:
  `{ok, command:"kb ls", documents:[...], total, truncated, limit, clearance, protectedExcluded}`.
- `kb show` returns metadata only by default; `--chunks N` adds up to N chunk
  previews (400 chars each) and `chunksTotal`. A deleted/tombstoned document is
  `E_KB_NOT_FOUND`. JSON: `{ok, command:"kb show", document, chunks[], chunksTotal, clearance}`.

### 5.3 `search` and `kb search`

`search` keeps its 0.3.2 default: without `--scope` the command is the legacy turn
search with byte-compatible human output. The scoped path and `--json` are additive
0.4.0 features and require `--scope`. `--scope kb` searches document titles and
chunks, `--scope pages` searches compiled pages, `--scope all` merges KB + pages +
turns. `--scope facts` is accepted by the parser but currently **resolves to the KB
scope** (real fact/preference search is still `memory search`; a fact scope is a
0.4.x item), so `counts.facts`/`counts.preferences` stay 0.

Query rules: ≤200 code points; 3+ character tokens use trigram `MATCH` (each token
is quoted, FTS syntax is never passed through); shorter or untokenizable queries
use a `LIKE` scan and set `degraded: ["short_query_like"]`. A non-trigram tokenizer
reports `degraded: ["fts_unicode61"]` (or `fts_unavailable`); results stay correct,
only slower. Snippets are at most 240 characters with `highlights` as character
offsets (never HTML/Markdown), and control/bidi/terminal characters are stripped.

Unified JSON shape (`--scope ... --json`):

```json
{
  "ok": true, "command": "search", "query": "报价", "scope": "all",
  "limit": 20, "clearance": 3, "degraded": ["short_query_like"],
  "counts": {"turns": 0, "kbDocs": 1, "kbChunks": 3, "kbPages": 1, "facts": 0, "preferences": 0},
  "hits": [
    {"kind": "kb_doc", "ref": {"kind": "kb_doc", "id": "kb_..."}, "docId": "kb_...",
     "title": "报价单", "snippet": "", "highlights": [], "matchPath": "title", "at": "..."},
    {"kind": "kb_chunk", "ref": {"kind": "kb_chunk", "id": "chk_..."}, "docId": "kb_...",
     "title": "报价单", "snippet": "...报价...", "highlights": [{"start": 0, "end": 2}],
     "matchPath": "like"},
    {"kind": "kb_page", "ref": {"kind": "kb_page", "id": "page_client_cl_..."},
     "pageId": "page_client_cl_...", "title": "客户档案", "snippet": "...", "highlights": [],
     "generatedAt": "...", "matchPath": "page"}
  ],
  "total": 5, "truncated": false, "protectedExcluded": 0
}
```

Cross-engine scores are not comparable; ordering is `kindRank` (doc title ->
chunk -> page, merged with turns/facts by the CLI) then `score desc`, then `id asc`.
Narrow the scope when you need a stable ranking. `protectedExcluded` counts rows
hidden by clearance; a search never reveals their existence beyond the count.

### 5.4 Compiled pages (`kb page ...`)

Four deterministic page kinds:

| Kind | Id | Built from |
|---|---|---|
| `client` | `page_client_<client-id>` | client row, projects, counts, open commitments, recent delivery/commitment timeline, related facts |
| `project` | `page_project_<project-id>` | project row, its matters, deliveries, open commitments |
| `timeline` | `page_timeline_<client-id>` | the derived customer timeline (deliveries + commitments only; note bodies are never rendered) |
| `facts` | `page_facts_<sha256(subject|matter)[0:12]>` | one fact chain per (subject, matter) with `validFrom`/`validTo` and evidence quotes |

- Pages are **derived data, never a fourth ledger**. Every byte comes from ledger
  rows in the same database and the page can be rebuilt from scratch.
- `inputs_sha256` covers the canonical input data; `kb page ls --check` reports
  `stale`/`staleCount` without writing. `kb page show` recomputes live by default
  (pure read), returns `stale` vs the stored row and can print a bounded diff
  (`--diff`); `--stored` shows the stored copy.
- `kb page rebuild` is the only writer; it writes only rows whose hash changed and
  records one `kb.page.rebuild` audit row. `--dry-run` reports the plan without
  writing.
- Pages are not model-generated and contain no wall clock in their content
  (`generatedAt` is row metadata). A stale page must not be treated as a source of
  truth: the ledger rows and evidence remain authoritative.
- Searching pages (`search --scope pages`) returns `generatedAt` and
  `pageSnapshot`-style hints; run `kb page rebuild` to refresh them.

### 5.5 Fact time travel (`fact show|history|as-of`)

Read-only views over the existing facts table (no migration):

- three time concepts stay distinct: `validFrom`/`validTo` = when the fact was true
  in the world (the as-of axis), `recordedAt` = when the ledger learned it,
  `expiredAt` = when the system noticed it stopped being current (display only).
- `fact show <id>` returns the fact, its evidence, the supersede chain fields and
  additive `kbSources[]` when the fact is linked to KB documents.
- `fact history <id>` walks `supersedes` back to the oldest row and `supersededBy`
  forward to the newest; broken links/cycles become `warnings`, never a crash.
- `fact as-of <YYYY-MM-DD|ISO>` returns, per `(subject, predicate, matter)` group,
  the fact that was effective at that instant (`validFrom ?? recordedAt <= t <
  validTo`); superseded facts are included (they were true then); deleted facts
  need `--include-deleted` and are kept only when deleted after `t`. A date-only
  value means the start of that Asia/Shanghai day converted to UTC. Deterministic
  for the same rows and instant; `truncated` is reported.

## 6. Deletion semantics (what `rm`, `purge`, `purge <matter>` really do)

| Command | Effect |
|---|---|
| `kb rm <doc>` | Tombstones the document and **physically deletes its chunks** in one transaction, so it immediately stops being searchable (the FTS triggers follow the chunk delete). The document row, metadata and `source_sha256` remain for audit and duplicate detection. |
| `kb purge <doc>` | Dry-run by default; `--yes` physically deletes the document row, its chunks and its fact links. It is the only way to remove the extracted text row itself. |
| `purge <matter> --yes` | **Does not delete KB documents.** KB documents are keyed by their own ownership, and a matter purge is a partial delete (see [PRIVACY.md](PRIVACY.md) §7.3). Delete KB documents explicitly with `kb rm`/`kb purge`. |
| Deleting the original file | No effect on the index; Advisers never read it again. |
| `vault seal` | Encrypts `state.db`; KB pages/FTS/B-tree data follow the database. The encrypted vault and its backups are separate artifacts. |

Residual copies to consider when you need a real erasure: pre-migration backups
(`state.db.before-migrate-v21-*`), import/sync backups, `export --all` files,
`backup` copies, WAL/SHM frames until checkpoint, OS/AV/cloud-sync snapshots, and
any file you generated yourself with `--out`/`--json`. See [PRIVACY.md](PRIVACY.md)
for the authoritative list; the KB adds no new copy of the source bytes.

## 7. Failure modes and error codes

| Situation | Code (stderr, exit 1) | What to do |
|---|---|---|
| Unsupported extension | `E_KB_UNSUPPORTED` | Convert to a supported format or keep the file out of the KB. |
| File too large / archive expands too far | `E_KB_TOO_LARGE` | Split the file or raise the limit is not supported in 0.4.0. |
| Text cannot be decoded | `E_KB_ENCODING` | Convert the file to UTF-8 (or GB18030/UTF-16 with BOM) first. |
| No extractable text | `E_KB_EMPTY` | A blank/scanned file; use OCR (below) or skip it. |
| File unreadable / locked / permission | `E_KB_READ` | Check the path and permissions; OneDrive/AV locks surface here. |
| Invalid path/kind/ownership | `E_KB_INVALID` | Fix the flag or the referenced client/project/matter. |
| Duplicate content | `E_KB_DUPLICATE` (skip-level) | Reuse `existingId`, or pass `--replace`. |
| Unknown document/page/fact | `E_KB_NOT_FOUND`, `E_KB_PAGE_NOT_FOUND`, `E_FACT_NOT_FOUND` | Check the id with `kb ls`/`kb page ls`/`fact as-of`. |
| Batch too large | `E_KB_LIMIT` | Split into batches of ≤200 files. |
| Database older than v22 | `E_SCHEMA_STALE` | Run a writable command (or `advisers doctor`) to migrate; a v22 database needs a backup first. |
| Database newer than the CLI | `E_SCHEMA_NEWER` | Upgrade Advisers; do not downgrade in place. |

**`needsOcr` is not an error.** A scanned/image document is registered with
`needs_ocr=1` and zero chunks and the command prints a warning. Set
`ADVISERS_OCR_CMD` to your local OCR program, then `kb add --replace` the same
file to index the recognized text. Advisers never calls OCR or the network
implicitly; the OCR program itself is your responsibility (see [PRIVACY.md](PRIVACY.md)).

Tokenizer degradation is reported, not fatal: `fts_unicode61` (no trigram support)
and `short_query_like` (2-character CJK queries) mean correctness is preserved
through `LIKE` with a performance cost; `fts_unavailable` means FTS5 is missing and
all KB search is `LIKE`-only. `kb reindex` verifies both KB FTS indexes and rebuilds
them from the stored chunks/pages (`--rebuild` forces it); it never re-reads the
original files (their paths are not stored).

## 8. Export, import, backup and sync

- `export --all` includes `kb_documents`, `kb_chunks`, `kb_fact_links` and
  `kb_pages` (raw snake_case rows) because they are in the single `DATA_TABLES`
  list. The derived FTS indexes are not exported (`kb reindex`/`kb page rebuild`
  recreates them). Exports therefore contain the extracted text in plaintext; use
  `--encrypted` if that matters.
- `import --replace` restores every exported `DATA_TABLES` entry in one
  transaction, including `kb_documents`/`kb_chunks`/`kb_fact_links`/`kb_pages`.
  Derived FTS indexes are rebuilt (not imported), `kb_pages` is cleared because its
  inputs changed (run `kb page rebuild` afterwards), and a chunk that points at a
  missing document aborts the whole import. KB ownership ids that no longer exist
  are reconciled to `NULL` with a count instead of rejecting the import (KB is
  derived data). Re-adding from original files is still the safe fallback.
- `backup`, `restore`, `sync` and `vault seal` are whole-database operations and
  therefore include the KB automatically, exactly like the customer tables.
- The JSON wire format (`LedgerSnapshot.version`) is unchanged; KB rows are
  SQLite-only and never enter the ledger snapshot.

## 9. Security notes

- No source bytes are copied into the database or the home directory; the
  reference is `basename + sha256`. An attacker who steals `state.db` gets the
  extracted text, not the original files.
- Absolute paths, titles and snippets are not written to audit rows or stderr
  error messages (only basenames for per-file failures).
- JSON output sanitizes control characters/bidi/terminal escapes before display;
  snippets are plain text with offset highlights, never HTML/Markdown.
- Clearance filtering happens in SQL before counting/paging, so a hidden document
  cannot be inferred from `total` (only `protectedExcluded` is reported).
- This is a local single-user feature. It does **not** protect against a local
  user or a compromised process with access to your HOME; it is not a permission
  system. See [SECURITY.md](SECURITY.md) for the threat model.

## 10. Testing and acceptance (for contributors)

- `node --test packages/advisers/test/kb-*.test.js` covers extraction, add/batch,
  duplicate/replace, needsOcr, search (MATCH/LIKE/degraded/snippets), isolation,
  pages (determinism/stale/diff), fact time travel and v22 migration.
- No-network assertions run the commands with dead `ADVISERS_BASE_URL`/
  `ADVISERS_API_KEY`; KB must not fetch.
- `node scripts/check-contracts.mjs`, `check-docs`, `eval:det` and the Windows
  smoke suite cover the CLI JSON/KB surface; KB is not exposed over MCP/DSH in
  0.4.0 (see [MCP.md](MCP.md)).

## 11. Related documents

- [CLI-JSON.md](CLI-JSON.md) - the exact JSON shapes for the commands above.
- [ARCHITECTURE.md](ARCHITECTURE.md) - where the KB sits and the v22 schema.
- [PRIVACY.md](PRIVACY.md) - data inventory, retention and deletion boundaries.
- [CLIENTS.md](CLIENTS.md) - client/project ownership used by clearance and pages.
