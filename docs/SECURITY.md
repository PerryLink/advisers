# Security and supply chain

Advisers handles private mail, calendars, commitments, and family/work context.
A single trust failure is enough to kill the product, so release integrity and
dependency hygiene are part of the runtime, not a checklist for later.

This page is the public **supply-chain and release-integrity** companion to the
repository's root [security policy](../SECURITY.md): reporting, supported
versions, how a release is built and published, what provenance exists today,
and how to verify what you install. It describes the current state; "not yet
implemented" is written as such.

Status: 2026-11-18, covering the 0.2.x stable line (npm `latest`: 0.2.2; `0.2.3` is
the staged release candidate awaiting the account owner's OTP approval).

## 1. Reporting a vulnerability

Do **not** open a public issue for a vulnerability. Use GitHub's **private
vulnerability reporting** on this repository:

https://github.com/PerryLink/advisers/security/advisories/new

Please include the affected version, platform, reproduction steps, and impact.
Never include credentials, tokens, or other people's personal data in a report.

We acknowledge reports within 72 hours and work on a coordinated disclosure: we
confirm scope, prepare and test a fix, publish an advisory, and credit the
reporter unless anonymity is requested. There is no bug bounty program.

## 2. Supported versions

| Version line | Support |
|---|---|
| 0.2.x (latest stable) | supported; security fixes ship in a new patch or minor release |
| 0.2.0-preview.* and older preview lines | not supported |
| 0.1.x and earlier | not supported |

Track the npm dist-tag "latest" for supported releases. A pre-release tag does
not imply support.

## 3. How releases are produced

The six published packages are:
advisers, advisers-core, advisers-office, advisers-policy-strict,
advisers-bridge-hermes, and dsh-advisers.

- Releases are built from a tagged commit of the public repository and staged on
  the official registry, https://registry.npmjs.org/ only. The release tooling
  refuses any other registry.
- Tarball contents are restricted by an explicit files allowlist. Every package
  ships its LICENSE, NOTICE, and THIRD-PARTY-NOTICES.md, and those license files
  are kept byte-identical to the repository copies.
- The current publishing path is **staged publishing with human approval**:
  the maintainer uploads a staged build, and the npm account owner approves it
  with their own OTP in their own terminal. A version does not become
  installable until that approval happens.
- No npm token is committed to the repository. CI workflows default to
  read-only repository permissions, and no workflow publishes automatically:
  publishing is always a manual, owner-approved action.
- A release is expected to be cut only from a commit that passed the full
  gate: the test suite on Node 22.16 and 24, the production-JS static checks,
  the Windows smoke job, packaging smoke, docs/version consistency, license and
  terms-of-service checks, Office verification, the security suite, the
  fault-injection suite, release lockstep, and the dependency audit described
  below.

## 4. Provenance and trusted publishing (current status)

**Today, published tarballs do not carry npm provenance attestations.** They
have registry integrity and signature metadata (dist.integrity, dist.signatures)
but no build-provenance statement (dist.attestations is absent). The staged
human-approval flow proves that a maintainer approved the upload; it does not
prove which commit or CI run produced the tarball.

A **draft, not enabled** trusted-publishing job exists in the publish workflow:

- It uses GitHub Actions OIDC with the id-token: write permission, and is
  available only through an explicit manual dispatch with confirm=yes.
- In its current draft form it exercises the OIDC/provenance path but does not
  publish or stage anything. It exists so the plumbing can be validated without
  a release decision.
- Real CI publishing requires all of the following, and remains an explicit
  owner decision:
  1. an npm **Trusted Publisher** configured for each package on npmjs.com
     (GitHub repository, workflow filename publish.yml, optional protected
     environment; a stage-only permission is recommended);
  2. an owner-approved workflow change that turns the commented staging step
     into a real one;
  3. npm CLI 11.15.0 or newer on the runner for staged publishing with OIDC.
- Planned after that: stage from CI with provenance, verify that every published
  version has non-empty dist.attestations, and say so in the release notes.
  Until that verification exists, releases must not be described as
  provenance-signed.

## 5. Automated gates in CI

This is what actually runs on every push and pull request. It is a description
of the current gates, not a security certification: the 0.3 target test matrix
(evidence discipline, egress permits, TOS surfaces) is not implemented yet.

| Job | Runner | What runs |
|---|---|---|
| `test` | ubuntu-latest, Node 22.16 and 24 | frozen install, build, typecheck, `scripts/check-js.mjs`, the full `pnpm -r test` suite, `scripts/pack-smoke.mjs`, docs/version consistency, license, TOS and release-lockstep checks, Office verification, `scripts/security-suite.mjs`, and a WARN-only dependency audit. On Node 22.16 only: `scripts/fault-injection.mjs`. |
| `windows-smoke` | windows-latest, Node 22.16 | frozen install, build, `scripts/pack-smoke.mjs`, and a minimal CLI smoke on a fresh temporary `ADVISERS_HOME`: `advisers --version`, `init`, `status`, `commit add`, `commit ls`, `doctor`, `doctor --check-db`. It does not require Office/Word and does not run the full suite. |

### 5.1 Static checks (`scripts/check-js.mjs`)

Every production JavaScript file under `packages/*` (excluding `dist/`,
`node_modules/`, and test code/fixtures) is checked on every CI run:

- syntax: `node --check` on every file;
- no `eval()`, `new Function()`, or bare `Function()` dynamic code;
- no `child_process.exec`/`execSync` and no `shell: true` (argument-array
  APIs only), so a shell string cannot be built from untrusted data;
- no obvious hardcoded credential material (AWS/GitHub/npm/OpenAI/Slack/Google
  token formats, JWT-shaped strings, PEM private-key headers);
- TODO/FIXME/XXX/HACK markers are counted and printed (informational, not a
  failure).

Reviewed exceptions live in an explicit allowlist in the script, with a reason
per entry; there are none today. The gate checks syntax and specific API
patterns, not full static typing - `tsc --checkJs` for the JS packages remains
an open 0.3 item.

### 5.2 Fault injection (`scripts/fault-injection.mjs`)

A standalone suite runs the real CLI against temporary homes and injects
SIGKILL mid-transaction (before and after commit), an interrupted or failed
schema migration, corrupt and truncated WAL files, a desynchronised FTS index,
and ENOSPC on vault/backup writes; where unprivileged user namespaces are
available it also fills a real 2 MiB tmpfs. Each case asserts quick_check,
audit-chain verification, row/audit consistency, absence of half-installed
files, and recovery. Full coverage, flags, exit codes and limitations are in
[FAULT-INJECTION.md](FAULT-INJECTION.md).

### 5.3 Security suite names vs. 0.3 targets

`scripts/security-suite.mjs` prints five lines labelled T1-T5. Those labels
are the historical suite names and are narrower than the T1-T7 target matrix in
the 0.3 design. The table below shows what each line actually executes today;
none of the 0.3 target definitions should be read into it.

| Suite line | Test file executed today | 0.3 target direction (not implemented) |
|---|---|---|
| T1 association hints never inject other matter bodies | `packages/core/test/security.test.ts` | injection regression corpus (attachments/mail/web/tool output) |
| T2 permit replay/expiry | `packages/core/test/permit.test.ts` | cross-matter / existence leaks in prompt, logs, notifications, Pet Brief, MCP, DSH |
| T3 companion/roleplay denial | `packages/policy-strict/test/policy.test.ts` | deletion cascade + zombie probe across all stores |
| T4 audit hash chain tamper | `packages/advisers/test/sqlite.test.js` | egress permit matrix for every outbound surface |
| T5 purge cascade tombstones | `packages/core/test/security.test.ts` | supply-chain gate (allowed build scripts, provenance, audit) |

The 0.3 target matrix adds T6 (evidence integrity) and T7 (TOS/consent across
surfaces), neither of which the current suite covers. The root
[SECURITY.md](../SECURITY.md) section "CI tests that must stay green" is
written against the target and must not be read as a description of the current
suite.

Dependency audit remains WARN-only (see the next section); the fault-injection
and check-js gates are blocking.

## 6. Dependency and supply-chain controls

- The workspace lockfile is committed and CI installs with
  --frozen-lockfile; the production dependency audit queries the official npm
  registry rather than a mirror.
- **Dependency audit gate:** CI audits production dependencies for high and
  critical advisories. It is **WARN-only today** (it reports but does not block
  merges) while the tracked findings below are worked through. Every reviewed
  exception must record a reason and a review date in the gate; an expired
  exception raises a warning instead of silently passing. The gate is a triage
  aid, not a security certification.
- Known tracked advisories as of 2026-11-17, from public npm audit / advisory
  data:
  - **image-size 1.2.1**, transitive through pptxgenjs: two high-severity
    denial-of-service advisories (fixed upstream in image-size 2.0.3 or newer).
    The Office writers only use text and table APIs and expose no image parsing
    input, so the affected parsers are not reachable today. The fix waits for a
    pptxgenjs release that accepts image-size 2.x; review date 2027-02-17.
  - **uuid 8.3.2**, transitive through exceljs: one moderate buffer-bounds
    advisory (fixed in 11.1.1 or newer). It is below the high/critical gate and
    not reachable from current Advisers call sites (v4 without the buf option);
    review date 2027-02-17.
  - We do not claim a clean npm audit result today, and the project must not be
    described as vulnerability-free.
- Install/build lifecycle scripts are only run for workspace dependencies that
  are explicitly allowed; new script-bearing dependencies are reviewed when the
  lockfile changes.
- GitHub Actions used by the workflows are pinned to full commit SHAs, with the
  upstream release tag recorded in a comment. Workflow permissions default to
  read-only; the only job with id-token: write is the manual trusted-publishing
  draft described above.

## 7. Verifying an installation

1. Check that the version you installed exists as a tag/release on the public
   GitHub repository and matches the package version.
2. Inspect registry integrity and provenance metadata:

       npm view advisers dist.integrity dist.signatures dist.attestations --json

   dist.integrity should match the lockfile entry. dist.attestations being empty
   means the version has no provenance attestation (see section 4).
3. Verify registry signatures for the installed dependency tree:

       npm audit signatures

4. Treat any mismatch between the registry tarball, the repository tag, and the
   documented license files as a security issue and report it per section 1.

## 8. Scope and limitations

- **In scope:** the six published packages, their release pipeline, and the
  repository workflows.
- **Out of scope:** vulnerabilities in third-party services or providers you
  choose to connect to, and platform-side vulnerabilities outside this project.
- No external security certification or independent audit is claimed. Internal
  reviews, tests, and gates reduce risk but are not a guarantee.
- The project is source-available, not OSI-approved open source, and commercial
  use requires a separate license: see [LICENSING.md](../LICENSING.md). The
  software is provided without warranty under the [LICENSE](../LICENSE); the
  [Terms of Service](TOS.md) govern use.

## 9. Change log

- 2026-11-17: first public supply-chain annex. Records the no-provenance status
  of 0.2.x, the opt-in OIDC trusted-publishing draft, SHA-pinned GitHub Actions,
  and the WARN-only production dependency audit gate with dated exceptions.
- 2026-11-18: added the Windows smoke job, production-JS static checks
  (`scripts/check-js.mjs`), and the standalone fault-injection suite
  (`scripts/fault-injection.mjs`, see [FAULT-INJECTION.md](FAULT-INJECTION.md));
  aligned the T1-T5 labels with the test files the security suite actually runs
  and recorded the 0.3 target matrix explicitly as not implemented.
- 2026-11-18 (0.2.3 release candidate): 743/743 tests, `check-js`, the Windows
  smoke job definition and the fault-injection suite (9/9) are part of the
  candidate gate. Provenance status is unchanged (no attestations; draft OIDC
  job only), the audit tail anchor is still unimplemented, and the legal texts
  are unchanged from 0.2.0 (TOS v2026.11.2).
