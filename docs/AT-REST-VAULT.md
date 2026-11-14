# At-rest database vault (E9-T3)

Advisers supports an explicit **vault mode** for the SQLite database:

```sh
ADVISERS_VAULT_PASSPHRASE='at least 8 chars' advisers vault seal --remove
ADVISERS_VAULT_PASSPHRASE='at least 8 chars' advisers vault unseal
ADVISERS_VAULT_PASSPHRASE='at least 8 chars' advisers vault status
```

## What it does

1. Checkpoints WAL, reads `~/.advisers/state.db`.
2. Encrypts the whole database with AES-256-GCM + scrypt into
   `~/.advisers/state.db.vault` and verifies the round-trip + SHA256 before
   removing plaintext (`--remove`).
3. `unseal` verifies SHA256, backs up any existing DB, and restores it 0600.

## What it does not do

- It is **not transparent**: while sealed, normal commands have no DB; run
  `vault unseal` first. There is no auto-seal-on-exit daemon.
- It does not protect a running process's memory or an already-open DB.
- It is not SQLCipher; encryption is at the file/backup level.
- Passphrase is read from `ADVISERS_VAULT_PASSPHRASE`; it is not stored or logged.

Use it for idle/laptop-at-rest storage, together with `export --encrypted` for
handoff. The product must not claim "encrypted at rest by default" — it is an
explicit opt-in vault.
