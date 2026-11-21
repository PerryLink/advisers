# Software Bill of Materials (SBOM)

> Status: **0.4.1** was published on 2026-11-21 as the current release (npm `latest`;
> `next` is also `0.4.1`); it is a same-day follow-up patch on the 0.4.0 feature
> release, and the release tree stays schema **v22** (one
> `kb-mail-payment-entities` migration). The workspace version is whatever
> `packages/advisers/package.json` records. This page documents a release-gate artifact,
> not a claim that the build is reproducible — it describes the dependency set and says
> nothing about the database schema. Provenance status lives in
> [SECURITY.md](SECURITY.md). The 0.4.1 GitHub Release carries the generated CycloneDX
> SBOM (`sbom.cdx.json`) and a `SHA256SUMS` file for the six tarballs; the post-publish
> `node scripts/verify-release.mjs --version 0.4.1 --tag latest --sbom artifacts/sbom.cdx.json --require-sbom`
> check verifies the SBOM. 0.4.1 adds no runtime dependency: the lockfile diff from
> 0.4.0 is the workspace version pins, so the component set has the same shape. Each
> release records its own `verify-release` check count instead of inheriting an older
> figure; the 0.3.0 run passed 222 checks (historical record:
> <https://github.com/PerryLink/advisers/releases/tag/v0.3.0>).

Advisers publishes a CycloneDX SBOM for its dependency set. The document is
generated from `pnpm-lock.yaml` by the package manager's built-in `pnpm sbom`
command — no SBOM tool is added to the workspace dependencies, and generation
does not need a network connection or an installed `node_modules` tree.

## Quick start

```sh
pnpm install                        # optional here: lockfile + manifests are enough
pnpm run sbom                       # writes artifacts/sbom.cdx.json (gitignored)
pnpm run check:sbom                 # validates the artifact; exit 0 = pass
```

Custom paths and options:

```sh
node scripts/sbom.mjs --out /tmp/advisers.cdx.json
node scripts/check-sbom.mjs --file /tmp/advisers.cdx.json
node scripts/sbom.mjs --help        # --out, --spec-version 1.5|1.6|1.7
node scripts/check-sbom.mjs --help  # --file, --version
```

Use `pnpm run sbom`, not `pnpm sbom`: pnpm resolves its built-in `sbom` command
before a script of the same name (checked with the pnpm version pinned in
`package.json#packageManager`). `pnpm run check:sbom` has no name collision
but is written the same way for symmetry.

## How the artifact is generated

`scripts/sbom.mjs` runs, from the repository root:

```sh
pnpm sbom --sbom-format cyclonedx --lockfile-only --offline --sbom-spec-version 1.7
```

- `--lockfile-only` resolves the component set from `pnpm-lock.yaml` alone: no
  `node_modules` walk and no package-store read.
- `--offline` forbids registry access. The generator was verified in a tree that
  contained only `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` and
  `packages/*/package.json` — no `node_modules`, no store, no network.
- CycloneDX `specVersion` defaults to `1.7`; `--spec-version` accepts `1.5`,
  `1.6` and `1.7`.
- `npm sbom` is deliberately not used: this workspace has no `package-lock.json`,
  and npm's SBOM command fails with `ESBOMPROBLEMS` against a pnpm-installed
  `node_modules` layout. The supported path is pnpm's built-in command
  (pnpm >= 10.9; the repository pins its version in `package.json#packageManager`).

Two post-processing steps are applied to pnpm's document:

1. **Workspace coverage.** pnpm's combined workspace SBOM only emits a workspace
   package as a component when another workspace project links to it, so leaf
   projects (the Hermes bridge, the DSH bundle and the two link packages) would
   be missing. The generator adds those projects as components from their
   `packages/<dir>/package.json` (name, version, purl, license, VCS reference).
   No synthetic dependency edges are invented for them; their third-party
   dependencies are already in the lockfile-derived component set.
2. **Stable ordering.** Components and dependency lists are sorted by `bom-ref`
   so repeated runs diff cleanly. `serialNumber` and `metadata.timestamp` are
   still produced per run, so file bytes and hashes are not reproducible across
   runs.

A `metadata.properties` entry (`advisers:sbom:generator`) records how the
artifact was produced.

## What the gate checks

`scripts/check-sbom.mjs` reuses `validateSbom()` from
[`scripts/check-provenance.mjs`](../scripts/check-provenance.mjs) — the same
validation the post-approval release gate runs through
`node scripts/verify-release.mjs --version <v> --sbom <file> --require-sbom` —
so CI and the release gate cannot disagree about a malformed SBOM.

Required CycloneDX checks (shared with the release gate):

| Check | Failure condition |
|---|---|
| format | not a JSON object, or `bomFormat` is not `CycloneDX`, or `specVersion` is not a CycloneDX `1.x` value |
| components | `components` is missing/empty |
| package coverage | the `advisers` package component is absent, or it (or the metadata root component) does not record the expected version |
| no absolute paths | any `file://` URL, `/mnt/`, `/home/`, `/Users/` or `/root/` path, or `C:\` drive path appears anywhere in the document |

Additional artifact-integrity checks:

| Check | Failure condition |
|---|---|
| file/json | the artifact is empty or not valid JSON (exit `1`); a missing file exits `2` — run `pnpm run sbom` first |
| metadata / bom-version / spec-version / serial-number / timestamp | `metadata.component` is missing, the document version is not an integer >= 1, `specVersion` is outside `1.5`–`1.7`, `serialNumber` is not a `urn:uuid:` value, or `timestamp` is not an ISO-8601 date |
| component-shape | a component has an unknown CycloneDX `type`, or no non-empty `name`/`version` |
| bom-refs / bom-ref-unique | a component lacks a `bom-ref`, or two components share one |
| purls / licenses | a `purl` is not `pkg:<type>/...`, or a license entry has neither a license `id`/`name` nor an expression |
| dependencies | `dependencies` is missing/empty, an entry has no `ref`, a `ref` is duplicated, or a `ref`/`dependsOn` target does not resolve to a component or the metadata root component |
| workspace-versions | a component named like a workspace package does not match that package's `packages/<dir>/package.json` version (catches an SBOM generated before a version bump) |
| published-packages | any of the six published packages (`advisers`, `advisers-core`, `advisers-office`, `advisers-policy-strict`, `advisers-bridge-hermes`, `dsh-advisers`) is missing |
| workspace-packages | any workspace package is missing (the workspace-coverage post-processing above) |
| advisers-version | the SBOM does not record the current `advisers` version |
| no-absolute-paths | stricter scan than the shared one: any string starting with `/`, a Windows drive path, a `file://` URL, or the current home directory/repository path |

The default artifact is `artifacts/sbom.cdx.json` (gitignored). Failures print
`FAIL` lines with the offending component/ref; exit code `1` means the artifact
is invalid, `2` means it is missing or the command line is wrong.

## CI wiring

`.github/workflows/ci.yml` (`test` job, on every matrix Node version) runs these
after `pnpm -r --if-present run build` and `typecheck`:

```sh
pnpm eval:det                          # deterministic eval contract (docs/EVAL.md)
node scripts/check-contracts.mjs       # interface contracts (docs/CONTRACTS.md)
pnpm run sbom && pnpm run check:sbom   # SBOM artifact + gate
```

CI generates and validates the SBOM as a gate only; it does not upload the
artifact or publish anything. Neither Windows job (`windows-smoke`, `windows-full`) runs
the SBOM step.

## Release use

The post-approval release gate consumes the same file explicitly:

```sh
pnpm run sbom
node scripts/verify-release.mjs --version <version> --tag latest \
  --sbom artifacts/sbom.cdx.json --require-sbom
```

`verify-release.mjs` also auto-discovers an SBOM placed at
`release/sbom-<version>.cdx.json`, `release/SBOM-<version>.cdx.json`,
`release/advisers-<version>.cdx.json`, `SBOM-<version>.cdx.json` or
`sbom.cdx.json` (repository root). For a GitHub Release, attach the artifact as
`release/sbom-<version>.cdx.json` alongside the tarballs/`SHA256SUMS`.
`--require-sbom` makes a missing or invalid SBOM fail the gate.

The SBOM gate is independent of the provenance gate: non-empty
`dist.attestations` on all six packages is checked separately by
`scripts/check-provenance.mjs`. An SBOM in hand does **not** justify a
"provenance-signed" or "reproducible build" claim — see
[SECURITY.md](SECURITY.md). The Windows portable ZIP is **not** an npm artifact: it is
not covered by npm provenance, and its integrity comes from the Release
`SHA256SUMS-<version>-portable.txt` (plus a GitHub artifact attestation when the
operator attaches one) — see [WINDOWS.md](WINDOWS.md) §3.4.

## Limits and non-claims

- **Lockfile-derived, not a build graph.** The component set and edges come from
  `pnpm-lock.yaml`; no compiler, container, OS package or build-time input is
  described. Lockfile-only resolution can also list optional/platform-specific
  entries that are not present in a given installed tree.
- **Not a vulnerability scan.** Presence of a component says nothing about known
  vulnerabilities or their reachability; dependency advisories are a separate
  WARN-only check (`node scripts/check-deps.mjs`).
- **Not byte-reproducible.** `serialNumber`/`timestamp` change per run by design.
- **CycloneDX only.** No SPDX document is produced.
- Do not use this page or the artifact to claim a complete SBOM of shipped
  binaries, a reproducible build, or provenance — those are separate release
  gates.
