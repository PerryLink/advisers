# File-based E2EE snapshot sync (P2 prototype)

Advisers does **not** run a sync server and has no cloud account. It can write
encrypted whole-database snapshots into a directory that your existing tool
(OneDrive, Dropbox, Syncthing, rsync, NAS) already replicates.

```sh
ADVISERS_SYNC_PASSPHRASE='at least 8 chars' \
  advisers sync push --dir ~/Sync/advisers --device laptop

ADVISERS_SYNC_PASSPHRASE='at least 8 chars' \
  advisers sync status --dir ~/Sync/advisers --json

ADVISERS_SYNC_PASSPHRASE='at least 8 chars' \
  advisers sync pull --dir ~/Sync/advisers
```

## Semantics

- Whole `state.db` snapshot; AES-256-GCM + scrypt (reuses the vault envelope).
- Filenames: `advisers-<device>-<UTC timestamp>.enc.json`; ciphertext only.
- `pull` chooses the newest snapshot by mtime, verifies SHA256, backs up the local
  DB as `state.db.before-sync-*`, then atomically replaces it.
- Last-snapshot-wins. There is **no merge/multi-writer conflict resolution** and
  no continuous sync; run push/pull explicitly.
- The passphrase comes from `ADVISERS_SYNC_PASSPHRASE`; it is not stored.

## Not provided

Team/multi-tenant sync, real-time merge, server accounts, background sync,
per-matter selective sync. Those require a separate product decision and
security design. Until then, do not describe this as "cloud sync".
