# Security policy

Advisers handles private mail, calendars, commitments, and family/work context.
A single trust failure is enough to kill the product; these rules are therefore
part of the runtime, not a checklist for later.

## Reporting

Do not open a public issue for a vulnerability. Use GitHub's **private vulnerability
reporting** on this repository. We will acknowledge within 72 hours. No security
email is published yet.

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

The current suite is smaller than the target matrix below. These are the gates
that run today and must stay green:

| Suite line | What actually runs today |
|---|---|
| T1 association hints never inject other matter bodies | `packages/core/test/security.test.ts` |
| T2 permit replay/expiry | `packages/core/test/permit.test.ts` |
| T3 companion/roleplay denial | `packages/policy-strict/test/policy.test.ts` |
| T4 audit hash chain tamper | `packages/advisers/test/sqlite.test.js` |
| T5 purge cascade tombstones | `packages/core/test/security.test.ts` |

Also blocking in CI: `scripts/check-js.mjs` (production-JS syntax, forbidden
dynamic/shell execution, hardcoded secret material), `scripts/fault-injection.mjs`
(process-crash, WAL, FTS, migration-rollback and ENOSPC invariants; see
`docs/FAULT-INJECTION.md`), and the `windows-smoke` job (frozen install,
build, packaging smoke, minimal CLI flow on a temporary home).

### Target definitions (0.3, not implemented)

The T1-T7 definitions below are the target: they require dynamic attack-corpus,
permit, deletion-cascade, evidence and TOS suites that do not all exist yet.
The T1-T5 labels in the current suite must not be read as this matrix.

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
- **T6 evidence integrity** — source resolution, quote verification, receipt
  three-state semantics, no fabricated evidence.
- **T7 TOS/consent across surfaces** — no silent acceptance in non-interactive
  contexts; version changes and revocation are enforced on every surface.

## Scope

- **In scope:** the runtime core, link providers, storage, egress, CLI.
- **Out of scope:** platform-side vulnerabilities; personal WeChat automation
  is prohibited and will not be merged.

## Enforcement status (0.2 preview)

This policy is the target; status below is code-level, not an external audit.

| Rule | Status |
|---|---|
| 1 no evidence, no entry | **enforced** for commitments; facts accept optional source |
| 2 memory does not authorize | **not implemented** |
| 3 external content never becomes instruction | **partial**: untrusted ingress becomes candidate; no full taint tracking |
| 4 three powers separate | **interface only**; single process today |
| 5 egress permit | **partial**: `PermitGate`/`GatedLink` exist; bridge issues/consumes; Feishu/Email not fully wired; no human approval UI |
| 6 credentials never enter context | **not implemented** |
| 7 delete cascades | **partial**: sessions/turns/summaries/runs/nudges/deliveries, facts/title, candidate payloads; commitment/link/update/audit text redaction partial |
| 8 metadata mandatory | **partial** |
| 9 fail closed | **partial**: policy resolver failure is fail-closed in runtime; package-missing fallback is fail-open |
| 10 supply-chain gate | **partial**: CI and `scripts/security-suite.mjs` are green (5/5); full T1–T5 corpus/permit/supply-chain gates are not all implemented |

`scripts/security-suite.mjs` executes the five test files in the table above
and prints their historical T1-T5 labels. It is not the T1-T7 dynamic target
matrix (permit, deletion-cascade, evidence-integrity and TOS-surface suites are
not all implemented). CI also runs the static checks and the fault-injection
suite listed above. Do not describe the project as "secure" until the target
gates exist and are green.
