# Contributing

Advisers is a small, security-sensitive runtime. Read `docs/ARCHITECTURE.md`
and `SECURITY.md` before changing code.

## Legal notice for extensions

Advisers extensions must carry the legal-notice block from
[`templates/legal-notice-code-template.md`](templates/legal-notice-code-template.md) and
must not remove or bypass the content-safety review, the local audit chain, or
AI-generated-content labels. Third-party extensions/DLC must declare author, licence,
`tosVersion`, permissions, and a content-safety statement in their manifest; see the
[Terms of Service](docs/TOS.md) (v2026.11.1) and
[Safety & content review](docs/SAFETY.md).

- Do not use or ship extensions for unlawful, infringing, deceptive, harassing, or
  unlabeled synthetic content, or to evade consent/egress/permission checks.
- Do not remove, tamper with, forge, or hide AI-generated-content labels.
- Rendered/template outputs that leave the machine need the sender's own review and the
  applicable AI-content labels.

## Architecture rules (enforced by tests)

1. `packages/core/src/**` may import only relative paths or `node:*`. It must
   not import `cordis`, `@deepseek-ai/*`, `dsh-*`, or a platform SDK.
2. Core must not use fork-only cordis symbols: `FiberState`, `LoggerLevel`,
   `symbols.root`, `Service.metadata`. Use `HostPorts` instead.
3. The model proposes; the ledger commits. Any new write path must go through
   `Ledger` and require evidence.
4. A link provider never imports the core implementation; it implements the
   `LinkProvider` interface from `advisers-core`.
5. No hard delete. Add a tombstone and register the deletion handler.

## Local workflow

```sh
pnpm install
pnpm -r run typecheck
pnpm -r run test
pnpm -r run build
node --experimental-strip-types examples/demo.ts
node scripts/check-tos.mjs   # TOS manifest / packaged copies / legal-doc links
```

Node **>= 22.13** is required (`node:sqlite`); Node 24 LTS recommended. The DSH
distribution additionally requires Node 24.9+ and a compatible DSH 0.2.2-rc.x.

## Commits

- Keep changes scoped: core, one link, or one distribution per PR.
- Add a test for every behavior change; security fixes need a regression test.
- Do not commit `dist/`, `node_modules/`, or credentials.

## Releases

Release order is `advisers-core` → `advisers-office` → `advisers-policy-strict`
→ `advisers-bridge-hermes` → `advisers` → `dsh-advisers`. Versions are per-package,
not lockstep; see `docs/RELEASE-EVIDENCE.md`.

Current flow is local `npm stage publish --tag next` + human OTP approval; the
GitHub `publish` workflow is manual and cannot approve stages. Trusted Publishing
(OIDC) is a target, not current behavior. Before publishing, build from a clean
checkout, `npm pack` every package, and install the exact tarballs in an empty
directory on Node 22 and 24.

## Security issues

Do not open a public issue. See `SECURITY.md`.
