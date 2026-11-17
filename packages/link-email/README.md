# advisers-link-email

Private, **unpublished** Link provider for Advisers: read-only IMAP ingestion and
draft-only email transport. It implements the LinkProvider surface used by the
`advisers` CLI (`capture --from-imap`, `link`) and by the repository test suite;
the package has no CLI of its own and is not published to npm.

- `ImapSource`: read-only IMAP client (EXAMINE + UID FETCH BODY.PEEK[]), restart-safe
  UID cursor, no write commands; never sends mail.
- `EmailDraftTransport`: creates draft messages only (used by the email/share link);
  no autonomous sending.
- Credentials come from environment variables; nothing is persisted by the package.

## License

Software: [PolyForm Noncommercial License 1.0.0](https://github.com/PerryLink/advisers/blob/main/LICENSE)
(SPDX `PolyForm-Noncommercial-1.0.0`); see the repository
[LICENSE](https://github.com/PerryLink/advisers/blob/main/LICENSE),
[NOTICE](https://github.com/PerryLink/advisers/blob/main/NOTICE) and
[THIRD-PARTY-NOTICES.md](https://github.com/PerryLink/advisers/blob/main/THIRD-PARTY-NOTICES.md).
Source-available, not open source and not an OSI-approved open source license.
This package is private and is not distributed on npm.
