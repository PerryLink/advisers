# File-based E2EE snapshot sync (snapshot v2, conflict precheck)

Status: **0.5.1, published 2026-11-24** (snapshot payload v2 + `sync.state.json` +
conflict precheck introduced in 0.5.0; plan 121 §3 / 126 WF2 050-S2). This is still
the same P2 prototype: no sync server, no cloud account, no daemon. Advisers writes
encrypted whole-database snapshots into a directory that your existing tool (OneDrive,
Dropbox, Syncthing, rsync, a NAS) already replicates. 0.5.1 changes no sync code
path or payload byte; the local database it snapshots is schema v23 instead of v22
and the new `waiting_replies`/handoff tables travel with the whole database.

**The transfer semantics are still last-writer-wins on the whole database.** 0.5.0
added a *refusal guard* (a proven stale overwrite is rejected unless `--force`),
not a merge and not multi-writer conflict resolution.

```sh
ADVISERS_SYNC_PASSPHRASE='at least 8 chars' \
  advisers sync push --dir ~/Sync/advisers --device laptop --json

ADVISERS_SYNC_PASSPHRASE='at least 8 chars' \
  advisers sync pull --dir ~/Sync/advisers --json

ADVISERS_SYNC_PASSPHRASE='at least 8 chars' \
  advisers sync status --dir ~/Sync/advisers --check --json
```

## 1. Commands

| Command | Writes? | Meaning |
|---|---|---|
| `sync push --dir <d> [--device <name>] [--dry-run] [--force] [--json]` | real push writes one snapshot + one audit row + updates `sync.state.json` | encrypt + write the whole DB |
| `sync pull --dir <d> [--file <name>] [--dry-run] [--force] [--json]` | real pull may replace the DB (keeps a `.before-sync-*` backup), appends `sync.pull`, updates the baseline | install the newest readable snapshot |
| `sync status --dir <d> [--json]` | no | list snapshot files (name/mtime/bytes/envelope createdAt) |
| `sync status [--dir <d>] --check [--json]` | no | read-only conflict/baseline report (see §4); needs the passphrase to decrypt snapshots |

`--force` never changes *which* snapshot is selected; it only allows a proven
stale overwrite (and keeps/prints the backup). `--file` selects an explicit
snapshot and is required when selection is ambiguous.

The passphrase comes from `ADVISERS_SYNC_PASSPHRASE` (>= 8 chars); it is not
stored. The `sync` command is TOS-gated like other ledger commands.

`--json` shapes the `sync push` result, both dry runs, `sync status --check` and
the `E_SYNC_CONFLICT` payload. In the 0.5.0 tree a successful **real** `sync pull`
still prints the human one-line summary even with `--json` (0.4.x behaviour); use
`sync pull --dry-run --json` when a script needs a machine-readable pull plan.

## 2. Snapshot format (payload v2; v1 remains readable)

- File name: `advisers-<device>-<UTC timestamp>.enc.json`; ciphertext only.
- Envelope: AES-256-GCM + scrypt (reuses the vault envelope).
- Envelope metadata `sync: {v, createdAt, device}` is unencrypted so `status` and
  selection are cheap, but it is **not trusted**: the pull re-decrypts the payload
  and refuses a createdAt mismatch between envelope and payload.
- Payload v2:

  | Field | Meaning |
  |---|---|
  | `kind` | `"advisers-sync-db"` |
  | `version` | `2` for new snapshots (`1` stays readable) |
  | `device` | sanitized device name |
  | `createdAt` | ISO date-time (authenticated) |
  | `sha256` | sha256 of the raw database bytes (the checked value) |
  | `dbMtimeMs` | database mtime recorded **before** the bytes were read (provenance hint, not a security value) |
  | `dbSha256` | repeats the database hash; a disagreement with `sha256` is a warning, `sha256` stays authoritative |
  | `sourceSchemaVersion` | schema version of the source database |
  | `db` | base64 database bytes |

New pushes always write v2. A v1 snapshot (no `dbMtimeMs`/`dbSha256`/
`sourceSchemaVersion`, no `version`) is still readable and selectable.

## 3. `sync.state.json` — the local baseline

Lives at `$ADVISERS_HOME/sync.state.json` (0600, atomic temp+fsync+rename):

```json
{
  "version": 1,
  "device": "laptop",
  "localSchemaVersion": 22,
  "lastPull": { "file": "advisers-desktop-2026-11-22T....enc.json", "sha256": "…",
                "createdAt": "…", "sourceDevice": "desktop", "localDbSha256": "…", "at": "…" },
  "lastPush": { "file": "advisers-laptop-2026-11-22T....enc.json", "sha256": "…",
                "dbSha256": "…", "at": "…" }
}
```

- Missing file = first sync on this HOME (normal).
- Corrupt/newer-version file = `state:null` + a warning; sync degrades to 0.4.3
  behaviour instead of failing on bookkeeping (`E_SYNC_STATE_INVALID` is reported
  by the status/precheck JSON, not thrown).
- Written only **after** a real push/pull succeeds; a state write failure is a
  warning (the transfer already happened).
- Cleared by a successful `import --bundle` (the whole ledger was replaced) and by
  `import`/`restore`; it never enters backup/export/bundle. PRIVACY lists it as a
  separate local file.
- After a successful pull, bin appends its `sync.pull` audit row and then refreshes
  the baseline's local sha256, so the next precheck does not report a fake local
  change caused by that audit row.

## 4. Conflict precheck (`sync status --check`)

`precheckSync()` is a pure read: baseline + local database fingerprint + snapshot
directory. It never writes.

- `localChanged` = current local DB sha256 vs the newest baseline event's
  `localDbSha256`. `null` (unknown) when there is no baseline, no local sha, or the
  WAL still holds bytes (not checkpointed).
- `remoteAdvanced` = newest readable remote snapshot sha256 vs the baseline's
  remote sha. `null` when unreadable/absent/undecryptable.
- `sameDevice` = newest snapshot device == this device (unknown -> `null`).
- **Conflict = both changed AND the newest snapshot came from another device.**
  The same snapshot on the same device is an intentional restore and is allowed.
- Status is `clear`, `conflict` or `degraded`. **Unknown is never reported as
  clear**: `degraded` means a guard could not be proven and the warnings say why.

`sync push` / `sync pull` run the precheck first and refuse a proven stale
overwrite with `E_SYNC_CONFLICT` (exit 1, database bytes unchanged). `--force`
proceeds, keeping a `.before-sync-<epoch>` copy of the local database (push) or the
usual verified pre-pull backup (pull), and prints the path. `sync status --check`
prints the report and exits 0 even when the status is `conflict`; only an actual
error exits 1.

`sync --check --json` fields: `ok, direction, status, conflict, localChanged,
remoteAdvanced, sameDevice, wouldRefuse, reason, baseline,
newest{file,sha256,device,createdAt,payloadVersion,readable},
local{exists,sha256,dbMtimeMs,walBytes,sourceSchemaVersion}, force, warnings,
errors`.

## 5. Dry runs are truly read-only

- `sync push --dry-run`: no snapshot file, no directory creation, no audit row, no
  checkpoint, no state write. It plans `file`/`name`/`sha256`/`bytes`. A non-empty
  WAL means a real push checkpoints first, so the sha256/size cannot be predicted
  without writing — it reports `dbSha256:null` and a warning instead of guessing.
- `sync pull --dry-run`: performs the same selection, decryption, SHA-256 and
  refusal decisions a real pull makes, but writes nothing (no database replace, no
  backup, no staging temp, no stale-temp sweep, no audit row). It reports
  `wouldChange`, `wouldStatus` (`pulled|bootstrapped|forced|unchanged`) and
  `wouldBackup`. It intentionally does not run the snapshot's PRAGMA quick_check
  (that needs staging bytes next to the database); a self-consistent but corrupt
  snapshot is predicted as a change and then refused by the real pull, leaving the
  live database intact.

## 6. Pull safety (unchanged guarantees)

1. Select the newest snapshot by authenticated `createdAt` (not file mtime), unless
   `--file`. Unreadable candidates or a >5-minute mtime/createdAt skew require an
   explicit `--file` instead of guessing.
2. Decrypt and verify SHA-256; a mismatch aborts.
3. Stage the database next to the live file, run `PRAGMA quick_check` (a 0-byte or
   corrupt database is refused), then atomically rename into place.
4. A local database that held user data is never replaced without (a) the snapshot
   coming from this same HOME, (b) it not being older than the local write, or
   (c) `--force`. A verified `.before-sync-*` backup is kept on this path and any
   failure restores the previous database.
5. A new/empty device bootstraps without `--force` (a backup is still kept if a
   local file existed).
6. Stale plaintext staging files from a crashed pull are swept; a live pull is
   never disturbed.

## 7. Last-writer-wins remains the semantics

There is still **no merge** and no multi-writer resolution: a pull replaces the
whole database with one snapshot, and two devices that write independently will
still make one side lose unless the conflict precheck catches the proven case and
the operator resolves it by hand (`--force`, `--file`, export/restore). Snapshot
ordering is by authenticated creation time, so a sync tool that rewrites mtimes
cannot make an older snapshot silently win. Run push/pull explicitly; there is no
continuous sync and no daemon.

## 8. Not provided

Team/multi-tenant sync, real-time merge, server accounts, background sync,
per-matter selective sync, cloud relay, encryption-key management. Those require a
separate product decision and security design. Until then, do not describe this as
"cloud sync".

## 9. Verification (three temp HOMEs)

```sh
export ADVISERS_SYNC_PASSPHRASE='test-passphrase'
H=$(mktemp -d); H2=$(mktemp -d); mkdir -p "$H/sync" "$H2"

ADVISERS_HOME="$H"   advisers init --json
ADVISERS_HOME="$H"   advisers sync push --dir "$H/sync" --device a --json
ADVISERS_HOME="$H2"  advisers sync pull --dir "$H/sync" --json   # bootstraps

# conflict: advance both sides, then a plain push/pull is refused
#   -> E_SYNC_CONFLICT, exit 1, local database bytes unchanged
#   -> sync status --check reports conflict/localChanged/remoteAdvanced
# --force succeeds and prints the .before-sync-* backup path
# --dry-run plans and leaves the database bytes, audit chain and sync.state.json untouched
# a v1 snapshot in the directory is still selected/readable
```

Automated coverage: `test/sync-state.test.js`, `test/sync-conflict.test.js`,
`test/sync-precheck.test.js`, `test/bin-050-sync.test.js` and the existing
`test/sync-*.test.js` pull/push suite.

## Related

- [PORTABILITY.md](PORTABILITY.md) — the plaintext whole-home bundle (different
  artifact: importable, no passphrase, disclosure-heavy).
- [CLI-JSON.md](CLI-JSON.md) — JSON shapes for push/pull/status/--check.
- [PRIVACY.md](PRIVACY.md) — the legal data-flow notice (unchanged by 0.5.0).
