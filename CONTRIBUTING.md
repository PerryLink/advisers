# Contributing

Advisers is a small, security-sensitive runtime. Read `docs/ARCHITECTURE.md`
and `SECURITY.md` before changing code.

## Legal notice for extensions

Advisers extensions must carry the legal-notice block from
[`templates/legal-notice-code-template.md`](templates/legal-notice-code-template.md) and
must not remove or bypass the content-safety review, the local audit chain, or
AI-generated-content labels. Third-party extensions/DLC must declare author, licence,
`tosVersion`, permissions, and a content-safety statement in their manifest; see the
[Terms of Service](docs/TOS.md) (v2026.11.2),
[Safety & content review](docs/SAFETY.md) and
[Privacy & data-flow notice](docs/PRIVACY.md).

- Do not use or ship extensions for unlawful, infringing, deceptive, harassing, or
  unlabeled synthetic content, or to evade consent/egress/permission checks.
- Do not remove, tamper with, forge, or hide AI-generated-content labels.
- Rendered/template outputs that leave the machine need the sender's own review and the
  applicable AI-content labels.

## Licensing of contributions

By submitting a contribution (pull request, patch, code, text, data or design) you confirm
that you own it or have the right to submit it, and you agree that:

1. your contribution is licensed to the project and its users under the project's current
   public licences (PolyForm Noncommercial 1.0.0 for software; CC BY-NC-SA 4.0 for
   documentation, data and design); and
2. you grant PerryLink and the Advisers project a perpetual, irrevocable, worldwide,
   royalty-free, sublicensable licence to use, reproduce, modify, distribute and
   **relicense** your contribution, including under commercial licence terms. This is
   what allows the project to offer commercial licences that cover contributions.

Sign off every commit with `git commit -s` (DCO 1.1, <https://developercertificate.org/>).
DCO alone does not grant the relicensing right in item 2. If you cannot accept these terms,
open an issue before sending a patch.

中文：你提交贡献即表示你拥有该贡献的著作权或已获授权，并授予 PerryLink 与 Advisers
项目一项永久、不可撤销、全球范围、免费、可再许可的许可，允许项目按现行许可（软件
PolyForm Noncommercial 1.0.0；文档/数据/设计 CC BY-NC-SA 4.0）**以及项目未来采用的任何
其他许可（含商业许可）**使用、复制、修改、分发与再许可你的贡献。请使用 `git commit -s`
签署 DCO 1.1；仅签署 DCO **不**包含上述换许可权利。若无法接受，请在提交补丁前开 issue。

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
