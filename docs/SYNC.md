# Optional sync (P2, not implemented)

Advisers is local-first by design; there is no cloud sync in 0.2.

If sync is ever added, the minimum contract is:

- end-to-end encrypted, user-held key; server cannot read ledger/evidence;
- opt-in, per-matter; no default upload;
- conflict resolution at the ledger-operation level (not last-write-wins on files);
- every sync event audited; `privacy --prove` must show sync state;
- no team/multi-tenant semantics without a separate product decision.

Until implemented, use `export --encrypted` / `import` for handoff and
`vault seal` for idle-at-rest encryption. Do not claim cloud sync exists.
