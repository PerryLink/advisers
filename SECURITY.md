# Security policy

Advisers handles private mail, calendars, commitments, and family/work context.
A single trust failure is enough to kill the product; these rules are therefore
part of the runtime, not a checklist for later.

## Reporting

Do not open a public issue for a vulnerability. Email the maintainers
(`security@` address to be added before the first public release) or use a
private GitHub security advisory. We will acknowledge within 72 hours.

## Non-negotiable rules

1. **No evidence, no ledger entry.** Persistent records require
   `source_ref + quote_hash + scope + expires_at`; any missing field is a write
   error.
2. **Memory does not authorize.** Permission comes only from a
   `PolicyGrant(scope, expiry, revocable)`. A memory that says "don't ask again"
   is rejected, not obeyed.
3. **External content never becomes an instruction.** A turn that reads an
   email/web page/file may not call a write or send tool in the same turn.
4. **Three powers, separate processes.** Link has no ledger write; ledger has no
   network; egress has no raw-text read; the model has no `send` tool.
5. **Egress needs a permit.** `SendPermit{draft_hash, recipients, expiry}`;
   editing the draft or the recipient list invalidates it.
6. **Credentials never enter context.** Tokens live in keychain/KMS; logs and
   exports may contain a `token_id`, never a token.
7. **Delete cascades.** Every new store implements `erase(id)` and registers a
   deletion handler; a matter delete removes memberships, not shared facts.
8. **Metadata is mandatory.** Every field declares `sensitivity`, `retention`,
   and `exportable`; a missing declaration fails CI.
9. **Fail closed.** Policy/classifier timeouts or errors escalate or deny; they
   never allow.
10. **Supply-chain gate.** Pin dependencies, keep a lockfile, require
    provenance, forbid `postinstall`, and forbid `!!js` in shipped config.

## CI tests that must stay green

- **T1 injection regression** — MINJA/SpAIware-style corpus: zero instruction
  writes, zero side-effect tools, zero egress.
- **T2 cross-matter / existence leak** — prompt, logs, drafts, and notifications
  contain zero hits, including titles and counts.
- **T3 deletion cascade + zombie probe** — write → delete → probe all stores;
  restore a backup and probe again; both zero.
- **T4 egress gate** — every exit (SMTP/IM/webhook/clipboard/remote image)
  rejects without a permit; replay/edit invalidates a permit.
- **T5 supply-chain gate** — unpinned, unsigned, script-bearing, or `!!js`
  dependencies fail.

## Scope

- **In scope:** the runtime core, link providers, storage, egress, CLI.
- **Out of scope:** platform-side vulnerabilities; personal WeChat automation
  is prohibited and will not be merged.
