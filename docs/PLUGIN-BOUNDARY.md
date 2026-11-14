# Plugin boundary (P2 design)

Advisers is CLI-first and local-first. The only extension surface is the
cordis/DSH host boundary, not an arbitrary plugin marketplace.

## Allowed extension points

1. **tool** — a model-callable tool with a declared schema; must be local,
   auditable, and off by default until enabled.
2. **link** — an inbound/outbound transport (email/Feishu shape); the core does
   not depend on any link; permits gate egress.
3. **office-template** — a template function, no network.

## Rules

- Manifest must declare permissions (`fs.read`, `fs.write`, `net`, `exec`);
  undeclared use is a load error.
- Plugins are disabled by default; enabling is a user action with an audit event.
- No plugin may read outside the workspace or `~/.advisers` without an explicit
  permission grant.
- Plugin calls are audited; failures must not crash the main CLI.
- No plugin marketplace/auto-update in 0.2; third-party plugins are not shipped.

## Not part of the boundary

Team/SSO, cloud sync, arbitrary shell, remote code execution, auto-publish, or
model-side tool installation. See `docs/POSITIONING.md`.
