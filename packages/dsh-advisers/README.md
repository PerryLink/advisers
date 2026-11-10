# dsh-advisers

**Placeholder package.** The DSH distribution of **Advisers** will ship a
`cordis.patch.yml` bundle that mounts the shared `advisers-core` on DSH's
session/agent/LLM/tool services and binds `dsh-im` links.

`0.0.x` only re-exports `advisers-core`; it is **not yet a mountable DSH
bundle** (no `dsh.bundle`, no `apply`). The first real DSH preview is planned
for `0.1.0-dsh.1` on the `next` tag, after the cordis-only 0.1.0 release.

Shared core and architecture:

https://github.com/PerryLink/advisers

## License

MIT.
