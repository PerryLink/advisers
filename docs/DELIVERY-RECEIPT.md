# Delivery receipt pack (v1.1)

> Status: format + library implementation for Advisers 0.2.0. This document
> defines the on-disk format, the offline verifier contract, and the legal
> wording boundary. It supersedes the v1 "evidence pack" for delivery receipts;
> the v1 evidence pack remains supported unchanged.

Advisers ships two different bundles. Do not mix their names:

| Bundle | Chinese name | Producer | Covers | Purpose |
| --- | --- | --- | --- | --- |
| Evidence pack (v1) | 证据包 | `buildEvidencePack` | `manifest.json`, `README.txt`, `SHA256SUMS` (manifest + README only) | Show which conversation turns back a commitment/fact/preference |
| Delivery receipt pack (v1.1) | 交付回执包 | `buildReceiptPack` | All of the above plus **copies of the delivered files**, `receipt.docx`, generator environment, verify results, optional recipient/anchors — **every file covered by SHA256SUMS** | Show what was delivered, with a portable tamper-evident receipt |

The evidence pack is **not** a delivery receipt: it carries references and capped
quotes only. Use the receipt pack when an artifact leaves the machine.

## On-disk layout

```text
<receipt-pack-dir>/                 0700
  manifest.json                     0600   deliveries + generator + verify + evidence
  README.txt                        0600   human-readable summary and verify steps
  receipt.docx                      0600   generated delivery receipt (DOCX)
  SHA256SUMS                        0600   sha256 of every other file (two spaces)
  deliveries/<delivery-id>/<file>   0600   byte-for-byte copies of delivered artifacts
```

- `SHA256SUMS` never lists itself; every other file must be listed exactly once.
- Paths inside the pack are always relative POSIX paths; absolute paths are never
  written to any pack file (generator command is path-redacted).
- Line format is coreutils-compatible: `<64 lowercase hex><two spaces><relative path>`.
- `buildReceiptPack({outDir})` writes the directory itself so the 0600/0700 mode
  contract cannot be lost in a caller. It stages files, re-reads them from disk,
  recomputes every hash and only then renames the directory into place. An
  existing non-empty `outDir` is refused unless `overwrite: true`, in which case
  the old directory is moved aside (`.replaced-<timestamp>`), never deleted.

## manifest.json

Schema version 1 (`advisers-delivery-receipt-pack`). All keys are sorted; the
document is written with `stableStringify` so the same inputs + clock produce
identical bytes.

```json
{
  "format": "advisers-delivery-receipt-pack",
  "version": 1,
  "createdAt": "2026-11-17T04:00:00.000Z",
  "generator": {
    "advisersVersion": "0.2.0-preview.71",
    "nodeVersion": "v24.22.1",
    "platform": "linux",
    "templateName": "weekly",
    "templateVersion": "1",
    "command": "advisers deliver --out <path>"
  },
  "recipient": { "name": "王工", "email": "wang@example.com", "note": null },
  "deliveries": [
    {
      "id": "del_alpha",
      "title": "报价确认单",
      "tool": "deliver:confirmation",
      "createdAt": "2026-11-17T03:00:00.000Z",
      "validation": "docx",
      "files": [
        {
          "path": "deliveries/del_alpha/quote.docx",
          "name": "quote.docx",
          "size": 34,
          "sha256": "9f2c...64 lowercase hex..."
        }
      ]
    }
  ],
  "receipt": { "path": "receipt.docx", "size": 4522, "sha256": "..." },
  "verify": [
    { "source": "advisers verify", "ok": true, "checkedAt": null, "errors": [], "checks": [], "summary": null }
  ],
  "verifyStatus": "passed",
  "anchors": [],
  "evidence": {
    "format": "advisers-evidence-pack",
    "version": 1,
    "entryCount": 1,
    "counts": { "commitment": 1, "fact": 0, "preference": 0, "unknown": 0 },
    "sourceCount": 1,
    "missingCount": 0,
    "entries": [
      {
        "kind": "commitment",
        "id": "cm_1",
        "found": true,
        "sources": [
          {
            "sessionId": "conv-1",
            "turnId": "turn_1",
            "quote": "周五前把报价发给王工",
            "quoteChars": 10,
            "truncated": false,
            "quoteSha256": "..."
          }
        ],
        "missing": []
      }
    ]
  },
  "fileCount": 5
}
```

Field rules enforced by the verifier:

- `format`/`version` exact; `createdAt` an ISO-8601 UTC timestamp.
- `generator`: `nodeVersion`/`platform` non-empty strings; `advisersVersion`,
  `templateName`, `templateVersion`, `command` strings or null.
- `deliveries`: non-empty; each id unique; each file path under
  `deliveries/`, safe/relative, size a non-negative integer, sha256 lowercase hex.
- `receipt.path` is exactly `receipt.docx`; size/sha256 must agree with SHA256SUMS.
- `verify` is an array; every entry has a boolean `ok`; `verifyStatus` is
  `passed` | `failed` | `not-recorded` and must agree with the array.
- `anchors`: optional external timestamp proofs; `fileSha256` must equal the
  SHA256SUMS digest of the referenced pack file.
- `evidence`: each quote is at most 500 characters, `quoteSha256` is recomputed
  by the verifier, and `entryCount`/`counts`/`sourceCount`/`missingCount` must
  agree with the entries. Full turn bodies are never embedded.
- `fileCount` must equal `SHA256SUMS` entries and the number of files the
  manifest lists (delivery files + manifest + README + receipt).

## Verify offline

Preferred entry point (0.2.0 CLI):

```sh
advisers evidence verify ./receipt-pack
```

The CLI subcommand is offline: it reads only the given directory, never
`~/.advisers` and never the network. It prints a machine-readable JSON result
and exits 0 when `ok` is true, 1 otherwise.

Library equivalent (same code path):

```js
import { verifyReceiptPackDir } from './lib/receipt-verify.js'

const result = verifyReceiptPackDir('/path/to/receipt-pack')
// { ok, errors, warnings, dir, fileCount, checksumCount, files, checksums, manifest }
```

Coreutils fallback (also works on a clean machine with no Advisers installed):

```sh
cd receipt-pack && sha256sum -c SHA256SUMS
```

What the verifier checks: SHA256SUMS syntax/paths (rejects absolute paths,
`..`, duplicates, self-listing), every listed file present and hash-matching,
no unlisted file inside the directory, no symlinks, valid JSON + full manifest
schema, `quoteSha256` consistency, anchors cross-checked against SHA256SUMS, and
that `receipt.docx` is a real ZIP/DOCX (`word/document.xml` present).

What it cannot do: detect someone who rewrites the whole pack and recomputes
every checksum. README.txt therefore prints `anchors: NONE - this pack is not
externally anchored (local self-attestation only)` when `anchors` is empty.
The verifier also emits a warning in that case.

## Building one (library)

```js
import { buildEvidencePack, buildReceiptPack } from './lib/evidence.js'

const evidence = buildEvidencePack({ store, ledger, ids, all: false })
const pack = await buildReceiptPack({
  deliveries: store.listDeliveries(10),        // rows: {id,title,tool,createdAt,validation,files}
  evidence,                                    // or evidence entry array / manifest JSON
  verifyResults: [await verifyOffice(buffer, 'docx')],
  env: { advisersVersion: VERSION, nodeVersion: process.version, templateName, templateVersion },
  recipient: { name: '王工', email: 'wang@example.com' },
  anchors: [],                                 // empty = not anchored, disclosed in README
  outDir: './receipt-pack',                    // optional; used to guarantee 0600 modes
})
```

- `deliveries[].files` accepts a path string, `{sourcePath}`, or
  `{content, name}`. Missing source files fail the build instead of being
  silently recorded.
- `receipt.docx` is generated from a spec; the optional `advisers-office` peer is
  used when installed, with a deterministic built-in DOCX writer as fallback.
  `docxBuilder` injects a custom builder; `false` forces the built-in writer.
- `SHA256SUMS` covers manifest.json, README.txt, receipt.docx and every delivery
  file. `manifest.receipt.sha256` is the receipt's own digest; a document cannot
  contain its own digest, so the receipt does not print it (it points at
  SHA256SUMS instead).
- Optional `anchors` attach an external timestamp proof to a **delivery file or
  receipt.docx** (manifest/README are generated later, so anchoring them here
  would be circular and is rejected). With `receiptDocx` injected, receipt.docx
  can be anchored too.
- `env.command` and recipient free text are path-redacted (`<path>`); evidence
  quotes are never altered (their `quoteSha256` must stay verbatim).

### Evidence pack performance cap

The old all-rows evidence pack was O(N²) (every id re-scanned `listFacts()`;
80k entries took ~114s). `buildEvidencePack` now builds one id index per pack
(linear) and caps the **default** path at `DEFAULT_MAX_EVIDENCE_ENTRIES = 2000`
entries:

- over the cap → throws `EvidencePackLimitError` (`code:
  'EVIDENCE_PACK_TOO_LARGE'`, plus `count`/`limit`/`hint`), whose message says to
  narrow with `--ids` or opt in with `--all`;
- API opt-in: `buildEvidencePack({ ..., all: true })` or `limit: Infinity`;
- CLI: map `--all` to `all: true`, keep `--ids` as the narrowing path, catch the
  error and print `error.hint` with a non-zero exit code.
- regression: `test/receipt-pack.test.js` builds an 80k-entry synthetic pack and
  asserts it stays linear and under 2 seconds.

## CLI (0.2.0)

The CLI now builds and verifies receipt packs; the library is not called by hand.

```sh
# Build a receipt pack for recent deliveries (default: latest 100 delivery rows,
# evidence entries capped at DEFAULT_MAX_EVIDENCE_ENTRIES = 2000)
advisers deliveries --receipt [--out <dir>] [--recipient "王工 <wang@example.com>"]
advisers deliveries --receipt --ids cm_...,fact_...,pref_...   # narrow the evidence
advisers deliveries --receipt --all                            # lift the 2000 cap
advisers deliveries --receipt --force                          # replace a non-empty --out

# Verify offline: reads only <dir>, prints JSON, exits 0 (ok) / 1 (not ok).
# It needs no ~/.advisers database, no TOS acceptance record and no network.
advisers evidence verify <dir>

# The v1 evidence-only pack is unchanged (manifest/README/SHA256SUMS/DOCX receipt).
advisers deliveries --pack [--out <dir>]
```

Behaviour of `deliveries --receipt`:

- Default output directory: `~/.advisers/receipts/receipt-<timestamp>`; `--out`
  chooses another path. A non-empty target is refused unless `--force`, which
  moves the old directory aside (never deletes it) — see `replaced` in the
  output.
- Delivery files that no longer exist are skipped and reported on stderr; the
  receipt only covers files that are still readable. If no readable delivery
  file remains the command fails with exit 1 instead of writing a receipt that
  claims files it cannot hash.
- Evidence: every commitment/fact/preference is included through
  `buildEvidencePack`, which is capped at 2000 entries. Over the cap the command
  prints the `EvidencePackLimitError` message plus its hint (`--ids` to narrow,
  `--all` to opt in) and exits 1 without writing a pack.
- `verifyResults`: delivered DOCX/XLSX/PPTX artifacts are run through
  `verifyOffice` when `advisers-office` is available (the CLI imports the office
  `verify` submodule directly so a receipt does not pay for the xlsx/pptx
  barrel); without that optional peer the pack records
  `verifyStatus: "not-recorded"`.
- `receipt.docx` uses the office DOCX builder when present (again via the `docx`
  submodule) and the deterministic built-in writer otherwise.
- `recipient`: `--recipient "Name <mail>"`, a bare e-mail address or a bare name;
  it is an operator-entered record, not a delivery/acceptance proof.
- `anchors` are `[]` from the CLI, so README.txt states
  `anchors: NONE - this pack is not externally anchored (local self-attestation only)`.
- The command re-runs `verifyReceiptPackDir` on the finished directory and puts
  the result in the JSON output; a verification failure sets exit code 1.
- A successful pack also records a local delivery row (`tool: receipt-pack`) and
  an audit event `receipt.pack` (JSON store has no audit chain). Rows whose tool
  is `receipt-pack` are excluded when assembling a new receipt, so receipts do
  not recursively copy older receipt packs.

Output is machine-readable JSON (one object, see
[`CLI-JSON.md`](CLI-JSON.md)) with `ok`, `format`, `version`, `out`,
`replaced`, `deliveryCount`, `fileCount`, `verifyStatus`, `anchored`,
`recipient`, `manifestDigest`, `receiptSha256`, `evidence`, `files`,
`skippedFiles` and `verification{ok,errors,warnings,checksumCount}`.

## Library entry points

`packages/advisers/lib/evidence.js`

- `buildReceiptPack(options)` (async) — receipt pack builder; see above.
- `createEvidenceIndex(ledger)`, `evidenceFor*(store, ledger, id, index?)` —
  indexed traceback used by `buildEvidencePack`.
- `EvidencePackLimitError`, `DEFAULT_MAX_EVIDENCE_ENTRIES`.
- old exports kept: `buildEvidencePack`, `verifyPack`, `manifestFor`,
  `toDocxRows`, `sha256Hex`, `stableStringify`, `MAX_QUOTE_CHARS`.

`packages/advisers/lib/receipt-verify.js`

- `verifyReceiptPackDir(dir)` — sync, offline directory verifier.
- `parseReceiptSums(text)` — strict SHA256SUMS parser.

## Legal wording: what this pack is and is not

This is **not** an e-signature, not a CA-issued certificate, not notarization and
not a trusted timestamp. It is a local, tamper-evident, carry-anywhere receipt
whose checksums can be recomputed by anyone holding the directory.

| Say this (English) | Say this (中文) | Do not say |
| --- | --- | --- |
| Local delivery receipt pack / offline-verifiable receipt | 本地交付回执包 / 离线可校验回执 | Electronic signature, e-sign, signed document（电子签名/签章/已签署） |
| SHA-256 checksums detect edits made after generation | SHA-256 校验和可检测生成后的改动（防篡改可检测） | Tamper-proof, cannot be forged, 绝对防篡改 |
| Optional external timestamp anchor (RFC3161/OTS/custom adapter), verified separately | 可选外部时间锚（RFC3161/OTS/自定义适配器），需另行验证 | Trusted timestamp / TSA-certified time（可信时间戳/时间戳认证） |
| SHA-256 proves input + output bytes match what was recorded at generation time | SHA-256 证明生成时的文件字节与记录一致 | Proves authorship, proves the recipient received/agreed | 
| Recipient is an operator-entered record | 收件人是操作者填写的记录 | Signed receipt, proof of delivery, 送达回执（法律意义） |
| Evidence entries reference the local ledger/session turns | 证据条目引用本地账本/会话来源 | 司法存证 / 出证 / 公证 / 区块链存证 / 司法认可 |
| User-held files, local processing, no network | 用户自持、本地生成、不联网 | E2EE, zero-knowledge, cloud sync |

When there is no anchor, say plainly: **未锚定 = 仅本地自证** (not externally
anchored = local self-attestation only). README.txt and the receipt's 声明 section
already state this.

## Privacy / scope

- Generation and verification are local and network-free; verification does not
  open `~/.advisers/state.db`.
- The pack copies the delivered artifacts (that is the point) but not full
  transcripts: evidence quotes are capped at 500 characters and carry
  `session#turn` references plus `quoteSha256` only.
- All paths are relative; `env.command` and recipient free text are path-redacted.
- Recipient/accept fields do not record consent, only operator input.
- Deleting the pack does not modify the local ledger.
