# Encrypted handoff package (P2)

> Status: **not shipped as a command in 0.5.1.** Schema v23 adds the `handoffs`/
> `handoff_claims` tables, but 0.5.1 ships no handoff CLI/read surface (the handoff
> work is a 0.6 item). This page documents the older encrypted whole-home export
> (`export --all --encrypted`), which is unrelated to that future feature and is
> still the shipped encrypted file export.

```sh
ADVISERS_EXPORT_PASSPHRASE='at least 8 chars' \
  advisers export --all --encrypted --out handoff.enc.json

ADVISERS_EXPORT_PASSPHRASE='at least 8 chars' \
  advisers import handoff.enc.json --replace
```

- AES-256-GCM, scrypt key derivation (N=16384, r=8, p=1), random salt/IV per export.
- Envelope is self-describing JSON; plaintext never appears in the file.
- The passphrase is read from `ADVISERS_EXPORT_PASSPHRASE` and is not written to
  disk or logs by Advisers.
- `import` replaces the local ledger and writes a timestamped `import-backup-*.db`
  before doing so; SQLite-only tables in a `--all` export are not merged (warning).
- This is an **encrypted handoff/backup**, not automatic at-rest database
  encryption. Full secret-matter at-rest encryption would require a SQLCipher-like
  store and is not claimed by this build.
