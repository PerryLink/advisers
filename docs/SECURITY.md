# Security and supply chain

Advisers handles private mail, calendars, commitments, and family/work context.
A single trust failure is enough to kill the product, so release integrity and
dependency hygiene are part of the runtime, not a checklist for later.

This page is the public **supply-chain and release-integrity** companion to the
repository's root [security policy](../SECURITY.md): reporting, supported
versions, how a release is built and published, what provenance exists today,
and how to verify what you install. It describes the current state; "not yet
implemented" is written as such.

Status: 2026-11-21, covering the **0.4.x line** (the repository is lockstep at package
version `0.4.0`). **0.4.0 was published on 2026-11-21**: npm `latest` = `0.4.0` and
`next` is also `0.4.0`. 0.4.0 is the single 0.4 feature release (local knowledge base
with **schema v22**, IMAP mail entry, interactive shell, policy/evidence 2.0 subset,
receivables/payments, MCP modern dual-era, Windows CI + portable ZIP) published from
`refs/tags/v0.4.0` through CI Trusted Publishing with SLSA provenance. **Schema v22 is a
one-way migration**: a 0.3.2 binary opening a v22 database fails with `E_SCHEMA_NEWER`
and going back means restoring the pre-migration copy. `0.3.2`/`0.3.1`/`0.3.0` are
superseded and remain installable by pinning; 0.3.0's published tarballs shipped
release-candidate READMEs and its release surface could not be repaired in place (an npm
tarball cannot be replaced, and `npm unpublish` requires the account owner's 2FA).
0.2.4 was tagged but never published and the 0.3.0 line supersedes it (see sections 3–4).
The legal texts are **TOS/PRIVACY/DISCLAIMER/SAFETY v2026.11.4 (2026-11-21)**, which
cover the new 0.4 data planes (mail bodies/credentials, KB text, receivables, shell,
model-egress consent) — v2026.11.3 consent is not valid for v2026.11.4.

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
| 0.4.x (latest stable) | supported; security fixes ship in a new patch or minor release |
| 0.3.x | superseded on 2026-11-21; not supported for new fixes. A 0.3.x binary cannot open a v22 database (`E_SCHEMA_NEWER`); upgrade to 0.4.0. |
| 0.2.x and earlier (including 0.2.0-preview.*) | not supported |

Track the npm dist-tag "latest" for supported releases. A pre-release tag does
not imply support. 0.3.x/0.3.1/0.3.0 remain installable by pinning for a
rollback, but they are not a supported security line and their databases cannot
be downgraded from v22 without restoring the pre-migration backup.

## 3. How releases are produced

The six published packages are:
advisers, advisers-core, advisers-office, advisers-policy-strict,
advisers-bridge-hermes, and dsh-advisers.

- Releases are built from a tagged commit of the public repository and published
  to the official registry, https://registry.npmjs.org/ only. The release tooling
  refuses any other registry.
- Tarball contents are restricted by an explicit files allowlist. Every package
  ships its LICENSE, NOTICE, and THIRD-PARTY-NOTICES.md, and those license files
  are kept byte-identical to the repository copies.
- Publishing is **owner-authorized**: releases up to 0.2.3 were staged from a
  maintainer's local terminal and approved with the account owner's own OTP.
  0.2.4 was tagged but never published; it remains an unpublished release candidate
  that the 0.3.0 line supersedes. **0.3.0 was published on 2026-11-20 through CI npm
  Trusted Publishing** (GitHub Actions OIDC) with provenance attestations; **0.3.1
  (release-metadata patch, 2026-11-20) supersedes it** and was published the same way,
  from the release tag. The 0.3.0 final publish used the owner-authorized direct OIDC
  path (no long-lived token, no npm stage/OTP step); the 0.3.1 and **0.4.0** publishes
  reuse that path from `refs/tags/v0.3.1` and `refs/tags/v0.4.0` respectively. The
  release tooling fails closed outside `refs/tags/v<version>` and never publishes
  automatically.
- No npm token is committed to the repository. CI workflows default to
  read-only repository permissions, and no workflow publishes automatically:
  staging and publishing are separate, manual, owner-authorized actions.
- A release is expected to be cut only from a commit that passed the full
  gate: the test suite on Node 22.16 and 24, the production-JS static checks,
  the **blocking** Windows smoke job (the `windows-full` full suite is
  report-only in 0.4.0, see §5), packaging smoke, the portable-bundle
  self-tests, docs/version consistency, license and terms-of-service checks,
  Office verification, the security suite, the fault-injection suite, release
  lockstep, and the dependency audit described below.

## 4. Provenance and trusted publishing (0.4.0 published)

Status as of 2026-11-21: **0.4.0 is published**; npm `latest` = `0.4.0` and `next` =
`0.4.0`; `advisers@0.2.4` is not on the registry. 0.4.0 is the single 0.4 feature
release published from `refs/tags/v0.4.0` through CI Trusted Publishing with SLSA
provenance (no long-lived npm token). The release gate rejects a provenance build ref
that is not `refs/tags/vX.Y.Z`; the GitHub Release carries the CycloneDX SBOM and a
`SHA256SUMS` file for the six tarballs. The Windows portable ZIP is the separate
offline channel and is published by the release operator with its own
`SHA256SUMS-0.4.0-portable.txt` (not covered by npm provenance) — see §4.1 and
[docs/WINDOWS.md](WINDOWS.md) §3.4. Verify the registry release with the post-publish
check below. Release notes:
<https://github.com/PerryLink/advisers/releases/tag/v0.4.0>.

0.3.2 (customer loop + performance closeout) was published on 2026-11-21 from
`refs/tags/v0.3.2` and is now superseded by 0.4.0; its tarballs and release assets
remain in place. `advisers@0.2.4` is not on the registry.

0.3.1 corrected 0.3.0's release surface with the same runtime: 0.3.1 changed no runtime,
CLI/MCP/DSH payload or contract version. The only `contracts/` change was the additive
consumer-registry entry `dsh-famling -> pet-brief@0.2` in `contracts/CONSUMERS.json`;
no frozen artifact or JSON Schema changed. It was published from `refs/tags/v0.3.1`
with tag-ref provenance.

**0.3.0 was the first CI Trusted Publishing release and its runtime evidence remains
valid, but its release surface was incomplete**: the package READMEs in its tarballs
still described a release candidate (the published-state docs were committed after the
tag), the provenance recorded the build ref as `refs/heads/main`, the GitHub Release had
no SBOM/checksum assets, and npm `next` still pointed at 0.2.3 (it has since been
advanced to 0.3.0). A published tarball cannot be replaced and `npm unpublish` requires
the account owner's 2FA, so those defects cannot be repaired in place; 0.3.1 supersedes 0.3.0, which remains installable
by pinning. All six 0.3.0 packages had non-empty `dist.attestations` (SLSA provenance
`https://slsa.dev/provenance/v1`), and the post-publish 0.3.0 check reported **222
checks PASS**.

**Releases up to and including 0.2.3 carry no npm provenance attestations.**
They have registry integrity and signature metadata (dist.integrity,
dist.signatures) but no build-provenance statement (dist.attestations is
absent). They were staged from a maintainer's local terminal; the staged
human-approval flow proves that the account owner approved the upload, but it
does not prove which commit or CI run produced the tarball. Provenance cannot be
added retroactively to those versions; the tagged 0.2.4 adds nothing because it
was never published.

**The 0.3.0 release is the first use of CI Trusted Publishing with
provenance.** It was published on 2026-11-20; the earlier staging attempts failed
with `404 OIDC token exchange error - package not found` because the npm Trusted
Publisher "Repository" field named each package instead of `advisers`. After the
owner corrected that field, the owner-authorized direct OIDC publish succeeded
from commit `1199fbf`. The configuration checklist:

- Trusted Publishing requires the npm account owner to configure a **Trusted
  Publisher** for each of the six packages on npmjs.com (GitHub repository
  `PerryLink/advisers`, workflow file `publish.yml`, publish permission). The
  Repository field must name the repository (`advisers`), not the package. That
  configuration is an owner decision on npmjs.com and is not stored in this
  repository.
- `.github/workflows/publish.yml` has an owner-authorized dispatch path in a job
  with `permissions: id-token: write`. With `confirm=yes` and `stage=yes` it
  runs `node scripts/release.mjs --provenance`, which uploads a stage with
  provenance attestations (approval is still the owner's OTP step). With
  `confirm=yes` and `publish=yes` it runs
  `node scripts/release.mjs --provenance --publish` for a **direct** OIDC
  publish; this is the path used for 0.3.0 on 2026-11-20. The job refuses to run
  if `NPM_TOKEN` is set, so a long-lived token cannot silently replace OIDC
  authentication; a failed step prints the tail of the npm debug log. With
  `confirm=yes` but `stage=no`/`publish=no` it only runs a
  `release.mjs --dry-run --provenance` diagnostic, which uploads nothing.
- Staging is **not publishing**. Every staged build still needs the account
  owner's explicit OTP approval before it becomes installable.
- **Post-approval gate (0.3.x and later).** Do not announce provenance from the
  workflow output; verify the registry:
  `node scripts/verify-release.mjs --version 0.4.0 --tag latest --sbom <file> --require-sbom`
  (plus the existing tarball/install/import checks). It requires non-empty
  `dist.attestations` on all six packages, fetches each attestation bundle,
  checks the SLSA provenance source repository and commit against the `v0.4.0`
  tag, checks that each attestation subject sha512 equals the registry tarball
  integrity, and requires the SLSA build ref to be `refs/tags/vX.Y.Z` rather
  than a branch. `node scripts/check-provenance.mjs --version 0.4.0
  --expected-ref refs/tags/v0.4.0` runs the same provenance checks standalone
  (pass `--allow-non-tag-provenance` only to audit a known historical release
  such as 0.3.0, whose provenance named `refs/heads/main`); `--allow-unpublished`
  prints a clear SKIP instead of a failure while the version is still unpublished.
  Each release records its own `verify-release` count and must not reuse an
  older figure (the 0.3.0 run passed **222 checks** with
  `--sbom artifacts/sbom.cdx.json`; that is a 0.3.0 record, not a 0.4.0 claim).
- These checks verify npm's metadata linkage (attestation subject to tarball
  digest, source repository/commit to release tag). They do **not**
  cryptographically verify the Sigstore bundle or transparency log; consumers
  who need that can run `npm audit signatures`.
- An empty `dist.attestations` after approval means the publish did not use
  OIDC/Trusted Publishing and must not be described as provenance-signed.
- SBOM: every release since 0.3.0 produces a CycloneDX 1.7 SBOM
  (`artifacts/sbom.cdx.json`, generated from the lockfile) as a release-gate
  artifact; `verify-release --sbom <file> --require-sbom` fails if it is
  missing, malformed, has no components, or contains absolute build-machine
  paths. The 0.4.0 GitHub Release attaches the generated SBOM and `SHA256SUMS`
  (0.4.0 adds no runtime dependency, so the component set has the same shape as
  0.3.2); the SBOM is not a build graph, vulnerability scan or
  reproducible-build proof.
- The release-trust tooling does not change the legal texts; the packaged and public legal
  texts are **v2026.11.4 (2026-11-21)** for the mail/KB/receivables/shell/model-egress
  consent revision — see [TOS.md](TOS.md) §9.3 and [PRIVACY.md](PRIVACY.md) §4. A
  v2026.11.3 consent record is not valid for v2026.11.4 and triggers re-acceptance.

### 4.1 Honest boundaries of the 0.4.0 security surfaces

These are mitigations, not sandboxes, signatures or certifications. Do not describe any
of them as unbypassable, unforgeable, "certified" or "zero-knowledge".

- **Policy decision tokens (0.4 subset).** `lib/policy` provides a pure
  `evaluate(facts)`, one-shot decision tokens bound to an effect digest
  (surface/action/path/recipient/subject/provider/data class), a 60-second TTL and a
  consume-once rule, plus an egress registry and intent/result audit rows on the new
  policy surfaces. The threat model is *"a code path forgot to call the gate"* and
  *"a decision for A was reused to execute B"*; it does **not** defend against a
  same-user process that can read process memory or rewrite the source. Tokens are
  in-process only (a `Map`), are not secrets, are not persisted and are not HMAC-signed
  in 0.4.0. The full PolicyGrant and exit codes 4/5/6 are not shipped (0.5 work); exit
  codes stay 0/1/3 and policy detail travels in `error.details`.
- **Consent records.** `consent.json` (0600, atomic) records per surface + data class +
  provider (+ base URL) consent for model egress, separately from TOS acceptance. It is
  a product record, not a legal agreement or proof of understanding, and it is not
  tamper-proof: the same user can edit the file. A changed provider/base URL invalidates
  the entry; revocation keeps an audit row and never re-grants implicitly. TOS
  acceptance alone is never treated as model-egress consent.
- **Mail credentials.** The IMAP password is stored per account in
  `<ADVISERS_HOME>/credentials/imap/<account>.json` (file 0600, directory 0700, atomic
  same-directory write) and is never written to SQLite, exports, backups, sync payloads,
  JSON output, argv or logs. A POSIX file whose mode grants group/other access is refused
  on read (`E_CREDENTIALS_INSECURE`). **On Windows there is no meaningful POSIX mode**:
  the user-profile/NTFS ACL is the boundary and the mode check is skipped — do not claim
  0600 protects the file on Windows. `--pass-stdin` exists for non-interactive use, but
  the invoking shell/process can capture stdin; the TTY hidden prompt is the default.
- **Evidence pack v2.** The receipt/evidence verifier accepts v1 and v2 packs and
  re-checks the v2 declared counts (`byKind`/`notCheckedCount`/`unverifiableCount`/
  `operatorEnteredCount`) against the entries. `verificationBasis` is
  `build-time` (local resolution when the pack was built) or
  `offline-consistency-only`; offline verification proves the pack is internally
  consistent and unmodified after generation, and **cannot replay turns, re-check
  web/tool sources or prove authorship/recipient receipt**. A pack with no external
  anchor is local self-attestation only; anyone able to rewrite the whole pack can
  recompute the checksums.
- **Interactive shell.** The 0.4.0 shell sanitises every human line (ANSI/OSC/C0/C1/bidi
  stripped by the output kernel), never auto-executes a multi-line paste, and keeps
  business writes in the CLI behind the same TOS/policy gates. It is not a separate
  privilege boundary: it runs as the same local user, and terminal scrollback, screen
  sharing or a compromised terminal can still expose content. History is process memory
  only and is never persisted.
- **Windows portable ZIP.** The ZIP is the offline channel, not a second trust root: it is
  the same runtime as the npm tarballs, contains no Node.js, is not covered by npm
  provenance, and has no code signing. Verify its SHA-256 against the Release
  `SHA256SUMS-<version>-portable.txt` (and a GitHub artifact attestation when the
  operator attached one) before use. No MSI/MSIX/Microsoft Store/signed EXE/auto-update
  ships in 0.4.0. The blocking Windows gate is the smoke job; the full Windows suite is
  report-only in 0.4.0 and the real-machine record still contains known Windows-only
  failures, so "Windows support" remains scoped (docs/WINDOWS.md).

## 5. Automated gates in CI

This is what actually runs on every push and pull request. It is a description
of the current gates, not a security certification: the wider 0.3/0.4 target test matrix
(evidence discipline, egress permits, TOS surfaces, full Windows coverage) is still
partial — see section 5.3.

| Job | Runner | What runs |
|---|---|---|
| `test` | ubuntu-latest, Node 22.16 and 24 | frozen install, build, typecheck; the **deterministic gates introduced in 0.3.0**: `pnpm eval:det` (no key, no network), `node scripts/check-contracts.mjs` (now including the MCP modern-era contract vectors) and `pnpm run sbom && pnpm run check:sbom`; `scripts/check-js.mjs`; the full `pnpm -r test` suite (which includes the 0.4 KB/mail/policy/consent/receivable suites); `scripts/pack-smoke.mjs`; docs/version consistency, license, TOS and release-lockstep checks; Office verification; `scripts/security-suite.mjs`; and a WARN-only dependency audit. On Node 22.16 only: `scripts/fault-injection.mjs`. |
| `windows-smoke` | windows-latest, Node 22.16 | frozen install, build, `scripts/pack-smoke.mjs`, the docs/version and release-lockstep gates (`check-docs`, `check-release`, which exercises the `fileURLToPath` Windows fix), and a CLI smoke on a fresh temporary `ADVISERS_HOME`: `--version`, `init`, `status`, `commit add`, `commit ls`, `doctor`, `doctor --check-db`, plus the **durable-write paths** that fsync a plaintext copy — `backup`, `export --out`, `import --replace`, `vault seal`/`vault unseal` — asserting non-empty outputs, the import/unseal recovery backups and no staged temp-file residue. This is the 0.2.4/0.3.0 Windows P0 regression gate and remains **blocking**. |
| `windows-full` | windows-latest, Node 22.16 and 24 | 0.4.0 adds this job: build, typecheck, `check-js`, every package's test files (enumerated in PowerShell because cmd does not expand the test glob), `pack-smoke`, and the portable-bundle self-tests (`portable-zip.mjs --self-test`, `pack-portable.mjs --self-test`). It is **report-only in 0.4.0** (`continue-on-error: true`): the 2026-11-21 real-machine run still had known Windows-only fixture/POSIX failures, so a red `windows-full` is tracked, not a release blocker, until the fixtures are fixed and it is green on `main`. |

The deterministic gates introduced in 0.3.0 remain release-gate inputs: `eval:det` is
the deterministic eval contract ([EVAL.md](EVAL.md)); `check-contracts` validates the
frozen `contracts/**` artifacts against the real CLI and stdio MCP server
([CONTRACTS.md](CONTRACTS.md)); `sbom`+`check:sbom` regenerates and validates the
lockfile-derived CycloneDX SBOM ([SBOM.md](SBOM.md)). The 0.4.0 release additionally
runs the Windows smoke job (blocking) and the portable-bundle self-tests. "Windows
support" is still not fully verified: `windows-full` is report-only and the
real-machine E13/full-suite record has known failures until the triage lands.

Release-trust tooling is exercised by the regular test suite too: `packages/advisers/test/release-trust.test.js` runs `scripts/check-provenance.mjs --self-test` (offline checks that the publish workflow, release script and this page agree on the OIDC/provenance path), validates attestation and SBOM parsing against local fixtures, and covers the unpublished-version skip/fail semantics of `scripts/verify-release.mjs`. Those tests never publish, stage, or need npm credentials; fixture registries are loopback HTTP servers.

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

### 5.3 Security suite names vs. the 0.3/0.4 targets

`scripts/security-suite.mjs` prints five lines labelled T1-T5. Those labels
are the historical suite names and are narrower than the T1-T7 target matrix in
the 0.3 design. The table below shows what each line actually executes today;
none of the 0.3 target definitions should be read into it, and 0.4.0 does not
add new T-lines.

| Suite line | Test file executed today | 0.3 target direction (not implemented) |
|---|---|---|
| T1 association hints never inject other matter bodies | `packages/core/test/security.test.ts` | injection regression corpus (attachments/mail/web/tool output) |
| T2 permit replay/expiry | `packages/core/test/permit.test.ts` | cross-matter / existence leaks in prompt, logs, notifications, Pet Brief, MCP, DSH |
| T3 companion/roleplay denial | `packages/policy-strict/test/policy.test.ts` | deletion cascade + zombie probe across all stores |
| T4 audit hash chain tamper | `packages/advisers/test/sqlite.test.js` | egress permit matrix for every outbound surface |
| T5 purge cascade tombstones | `packages/core/test/security.test.ts` | supply-chain gate (allowed build scripts, provenance, audit) |

The 0.3 target matrix adds T6 (evidence integrity) and T7 (TOS/consent across
surfaces). 0.4.0 ships focused tests for parts of both areas — the four-state
evidence resolver and evidence pack v2 (`test/evidence-*.test.js`), the policy
engine/egress registry/decision tokens (`test/policy-*.test.js`) and the consent
store (`test/consent.test.js`) — but they are **not** folded into the T1–T5 labels
and do not implement the full T6/T7 target definitions. The root
[SECURITY.md](../SECURITY.md) section "CI tests that must stay green" is written
against the target and must not be read as a description of the current suite.

Dependency audit remains WARN-only (see the next section); the fault-injection
and check-js gates are blocking.

## 6. Dependency and supply-chain controls

- The workspace lockfile is committed and CI installs with
  --frozen-lockfile; the production dependency audit queries the official npm
  registry rather than a mirror.
- **0.4.0 adds no runtime dependency.** The lockfile diff from 0.3.2 is the
  workspace version pins (and the package version fields); the mail/IMAP, KB,
  consent and portable-ZIP code paths use Node builtins and existing
  dependencies. The portable ZIP is assembled by a dependency-free in-repo ZIP
  writer (`scripts/portable-zip.mjs`), so packaging adds no supply-chain
  surface.
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
  read-only; the only job with id-token: write is the manual, owner-authorized
  Trusted Publishing job described in section 4.

## 7. Verifying an installation

1. Check that the version you installed exists as a tag/release on the public
   GitHub repository and matches the package version.
2. Inspect registry integrity and provenance metadata:

       npm view advisers dist.integrity dist.signatures dist.attestations --json

   dist.integrity should match the lockfile entry. **0.4.0 (published
   2026-11-21) has non-empty `dist.attestations` on all six packages**; 0.3.0
   also does (historical), while 0.2.3 and earlier have none and cannot be
   retro-signed. 0.2.4 was never published and has nothing to verify (see
   section 4).
3. Verify registry signatures for the installed dependency tree:

       npm audit signatures

4. Treat any mismatch between the registry tarball, the repository tag, and the
   documented license files as a security issue and report it per section 1.
5. The Windows portable ZIP (offline channel) is **not** covered by npm
   provenance. Verify its SHA-256 against the Release
   `SHA256SUMS-<version>-portable.txt` and, when present, a GitHub artifact
   attestation before extraction — see [WINDOWS.md](WINDOWS.md) §3.4. Do not
   trust a ZIP whose hash was not published by the release operator.

## 8. Scope and limitations

- **In scope:** the six published packages, their release pipeline, and the
  repository workflows.
- **Out of scope:** vulnerabilities in third-party services or providers you
  choose to connect to, and platform-side vulnerabilities outside this project.
  This includes the IMAP server you configure for `mail sync` (the content goes
  to that server under its operator's terms and TLS configuration) and the model
  provider you configure.
- **Same-user threat model.** The 0.4.0 policy tokens, consent file, shell
  confirmations and credential mode check are mitigations against accidental or
  buggy paths, not a sandbox. A process running as the same OS user can read the
  home directory (the database, KB text, mail bodies and `consent.json` are
  plaintext by default), modify the source, or drive the CLI directly. Use
  `vault seal`, OS account separation and full-disk encryption if you need to
  defend against that adversary; `vault seal` does not encrypt every derived
  plaintext (for example the morning-brief archive).
- **Windows credentials.** The mail credential mode check is POSIX-only; on
  Windows the profile/NTFS ACL is the boundary and the "0600" wording must not be
  read as a Windows guarantee.
- **No certification.** No external security certification, independent audit,
  "unforgeable" evidence, or "zero-knowledge" claim is made. Internal reviews,
  tests and gates reduce risk but are not a guarantee; the dependency audit is
  WARN-only and the project is not claimed to be vulnerability-free.
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
- 2026-11-18 (0.2.3 published): 743/743 tests, `check-js`, the Windows
  smoke job definition and the fault-injection suite (9/9) are part of the
  candidate gate. Provenance status is unchanged (no attestations; draft OIDC
  job only), the audit tail anchor is still unimplemented, and the legal texts
  are unchanged from 0.2.0 (TOS v2026.11.2).
- 2026-11-19 (0.2.4 release candidate): `release.mjs`, `set-version.mjs`,
  `check-docs.mjs` and `check-release.mjs` now use `fileURLToPath` instead of
  `new URL(...).pathname` (Windows portability); the publish workflow gained the
  owner-authorized `stage=yes` path that stages the six packages through
  GitHub OIDC Trusted Publishing with `--provenance` and rejects `NPM_TOKEN`;
  the owner configured the six Trusted Publishers on npmjs.com. 0.2.4 is not
  published yet: it becomes installable only after the owner approves the staged
  builds, and then `npm view <pkg>@0.2.4 dist.attestations` must be non-empty
  before the release is described as provenance-signed. No runtime or legal-text
  change.
- 2026-11-20 (0.3.0 release-trust tooling): corrected the 0.2.4 status recorded
  on 2026-11-19. Registry checks on 2026-11-20 show that 0.2.4 was never
  published (the registry has no 0.2.4 tarball); the earlier note that 0.2.4 was
  staged and pending approval cannot be confirmed from the registry, and no
  attestations exist for it. Treat 0.2.4 as an unpublished release candidate
  superseded by 0.3.0.
  Updated the provenance/Trusted Publishing wording for 0.3.0 (at that point
  0.3.0 was not published yet, so no provenance was claimed), aligned the `publish.yml`
  comments with its `confirm=yes&stage=yes` staging step, added
  `dist.attestations` / tag-commit-registry / SBOM checks to
  `scripts/verify-release.mjs`, and added `scripts/check-provenance.mjs` with
  an offline self-test. No runtime or legal-text change.
- 2026-11-20 (0.3.0 release gates): the CI gate set gained the deterministic
  eval suite (`pnpm eval:det`), the interface contracts gate
  (`node scripts/check-contracts.mjs`) and the SBOM generate/check pair
  (`pnpm run sbom && pnpm run check:sbom`); the Windows smoke job now covers the
  durable-write commands (backup, export `--out`, import `--replace`, vault
  seal/unseal) as the 0.2.4/0.3.0 Windows P0 regression gate. The legal texts are
  **TOS/PRIVACY/DISCLAIMER/SAFETY v2026.11.3 (2026-11-20)**, a substantive
  revision adding the bridge/Hermes ongoing-egress disclosure; consent records for
  v2026.11.2 are not valid for v2026.11.3 and trigger re-acceptance.
  `ADVISERS_TOS_VERSION` no longer affects the record or the gate (it is debug
  display only and audited as ignored), and `check-tos --release` now asserts the
  bridge/Hermes rows. At the time of this note 0.3.0 was still a release
  candidate; it was published the same day — see the 2026-11-20 published entry
  below.

- 2026-11-20 (0.3.0 published): 0.3.0 was published to registry.npmjs.org at
  `latest` on 2026-11-20 by GitHub Actions run
  [44706254171](https://github.com/PerryLink/advisers/actions/runs/44706254171)
  through npm Trusted Publishing (OIDC) with SLSA provenance attestations; no
  long-lived npm token was used. All six packages carry non-empty
  `dist.attestations`, and
  `node scripts/verify-release.mjs --version 0.3.0 --tag latest --sbom artifacts/sbom.cdx.json --require-sbom`
  passed **222 checks** (tag `v0.3.0` = commit `1199fbf`, registry `gitHead`
  agreement, attestation subjects vs tarball integrity, SBOM, clean-prefix
  install/import). The earlier staging failures were an npm Trusted Publisher
  configuration error (Repository field set to each package name instead of
  `advisers`); after the owner corrected it, the direct OIDC publish succeeded.
  Release notes: <https://github.com/PerryLink/advisers/releases/tag/v0.3.0>.

- 2026-11-20 (0.3.1 release-metadata patch): 0.3.1 supersedes 0.3.0 without
  runtime, CLI or interface changes. It fixes the published release surface that
  cannot be repaired in place: the six 0.3.0 tarballs shipped release-candidate
  README wording (the published-state docs were committed after the tag), the
  0.3.0 provenance named the branch build ref `refs/heads/main`, the GitHub
  Release had no SBOM/checksum assets, and `next` still pointed at 0.2.3 (since
  advanced to 0.3.0). The 0.3.1 publish runs from `refs/tags/v0.3.1`, attaches the CycloneDX SBOM and
  `SHA256SUMS`, and advances `next` to 0.3.1. The `v0.3.0` tag was restored to
  its publish commit `1199fbf`; 0.3.0 remains installable by pinning. The legal
  texts are unchanged (v2026.11.3).
- 2026-11-21 (0.3.2 published): customer-loop + performance closeout release
  published from `refs/tags/v0.3.2` through CI Trusted Publishing with SLSA
  provenance; additive contracts, no schema migration. Superseded by 0.4.0. The
  legal texts were unchanged (v2026.11.3).
- 2026-11-21 (0.4.0 published): the single 0.4 feature release (KB with schema
  v22, mail entry, interactive shell, policy/evidence 2.0 subset,
  receivables/payments, MCP modern dual-era, Windows CI + portable ZIP) was
  published from `refs/tags/v0.4.0` with tag-ref SLSA provenance. This page
  records the 0.4.0 security surface: the one-way v22 migration, the
  policy/consent boundaries in §4.1, the mail credential handling (0600
  POSIX-only; NTFS ACL on Windows), evidence pack v2's honest
  `verificationBasis`, the report-only `windows-full` job, and the portable
  ZIP as an offline channel that is not covered by npm provenance. Legal texts
  are **v2026.11.4 (2026-11-21)** (mail/KB/receivables/shell/model-consent
  revision); a v2026.11.3 consent record is not valid for v2026.11.4.
