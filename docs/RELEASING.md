# Releasing Advisers

This is the operational release checklist for the Advisers monorepo. It exists
because 0.3.0 was published before its final documentation commit, which shipped
release-candidate README text in the npm tarballs, recorded `refs/heads/main` in
the provenance and left the `v0.3.0` tag pointing at a tree that was not the
published tree. 0.3.1 corrected that by committing the docs first and publishing
from `refs/tags/v0.3.1`. Never repeat the 0.3.0 order.

**0.4.0 (published 2026-11-21) followed the corrected order** — docs first, main
push, CI green, annotated `v0.4.0` tag, tag-ref dispatch, then the post-publish
`verify-release` check and the Windows portable ZIP — and is the reference release
for the 0.4 line (see §13). One runbook detail is easy to get wrong: the portable
ZIP is assembled **after** the npm publish from the published tarballs, because
`pack-portable.mjs` installs `advisers@<version>` and `advisers-office@<version>`
from the registry.

Audience: the repository owner / release operator. Agents may prepare a release
(version bump, docs, gates, commit, tag) but **must not publish, unpublish,
deprecate, move a tag or edit a GitHub Release without explicit owner approval**.

## 0. Non-negotiables

1. **Docs first, then tag.** The release tree must already contain the
   published-status README/CHANGELOG. `node scripts/check-docs.mjs` rejects a
   current version described as a release candidate or unpublished (EN/ZH,
   including the package READMEs and the CHANGELOG `Status:` line), and
   `check-release.mjs --require-tag` requires the tag commit to be HEAD.
2. **The tag ref is the publish ref, and the workflow enforces it.**
   `publish.yml` fails unless `GITHUB_REF == refs/tags/v<version>` and HEAD is
   that tag commit; `release.mjs --provenance --publish` fails closed outside
   `refs/tags/v<version>`. Publishing from `main` (even a main that points at
   the tag commit) records `refs/heads/main` in the SLSA provenance — the exact
   0.3.0 defect. `verify-release` requires the build ref to be
   `refs/tags/v<version>`.
3. **Tag is immutable.** Never move or re-create a published `v*` tag. A bad
   release is superseded by a new version, not repaired in place. Record both
   `git rev-parse vX.Y.Z` (tag object) and `vX.Y.Z^{commit}` before dispatch;
   `check-release --require-tag` prints them, and `verify-release` checks the
   registry `gitHead` against the tag commit.
4. **No long-lived npm token in CI.** Trusted Publishing uses OIDC; the publish
   job refuses `NPM_TOKEN`. Local release scripts may use a token only for
   read-only verification; `npm unpublish` always needs the owner's 2FA and is
   normally the wrong fix.
5. **Verify the registry, not the workflow log.** After publishing, check
   registry metadata, tarball hashes, attestations (including the build ref),
   SBOM and a clean-prefix install.
6. **Do not claim "no contract changes" when `contracts/` changed.** 0.3.1
   added the `dsh-famling` entry to `contracts/CONSUMERS.json`; the release
   notes must say which contract artifacts changed rather than reuse the phrase.

## 1. Choose the version

- Patch/minor per semver; never reuse a published number. The release-metadata
  patch 0.3.1 is the only exception in history. The 0.4 line shipped as one
  release, **0.4.0** (2026-11-21); later fixes are 0.4.x patch releases, and the
  next feature line is 0.5.
- All eight workspace packages are lockstep; six are published
  (`advisers`, `advisers-core`, `advisers-office`, `advisers-policy-strict`,
  `advisers-bridge-hermes`, `dsh-advisers`), two link packages stay private but
  version-locked.
- Freeze code before touching versions. The release commit must contain the
  final docs, CHANGELOG and version constants.
- **A release that adds a schema migration is a compatibility event**, not only a
  version bump: state the `SCHEMA_VERSION`, the one-way rule (older binaries fail
  with `E_SCHEMA_NEWER`), the pre-migration copy name (`state.db.before-migrate-v*`)
  and the restore/export→import rollback in CHANGELOG/README/QUICKSTART. 0.4.0
  added v22 (KB/mail/money) in one transactional step; a downgrade is a restore,
  never a reverse migration.

## 2. Version bump and contract artifacts

```sh
ADVISERS_VERSION_ALLOW_DIRTY=1 node scripts/set-version.mjs --version X.Y.Z
pnpm install --lockfile-only
pnpm install --frozen-lockfile
node scripts/check-licenses.mjs --write   # only the per-package notice version line
```

Then update every current-version reference: `CHANGELOG.md` (top section),
`README.md`, `README-zh.md`, the package READMEs, and the status headers in
`docs/ARCHITECTURE.md`, `docs/QUICKSTART.md`, `docs/PERFORMANCE.md`,
`docs/MCP.md`, `docs/SECURITY.md`, `docs/SBOM.md`, `docs/EVAL.md`,
`docs/CONTRACTS.md`, `docs/RELEASING.md` and `docs/PRIVACY.md` when the data
surface changes; the 0.4 line also added `docs/WINDOWS.md`, `docs/KB.md`,
`docs/TUI.md` and `docs/CLIENTS.md`. Historical sections keep their original
version numbers. The legal texts are versioned separately in
`packages/advisers/lib/tos/manifest.json`; `check-tos --release` compares them to
`docs/TOS.md`/`PRIVACY.md` and the packaged copies, so a legal revision is its
own release-gate step (0.4.0 shipped v2026.11.4, effective 2026-11-21).

If the release changes the machine contracts (MCP tools/resources, CLI JSON,
error registry, consumers):

- update `contracts/**` (`tools-v1.json`, `resources-v1.json`,
  `responses-v1.schema.json`, `versions-v1.json`, `CONSUMERS.json`,
  `cli/*`, vectors) and `docs/CONTRACTS.md`/`docs/MCP.md`/`docs/CLI-JSON.md`;
- regenerate the generated error artifacts with
  `node scripts/check-contracts.mjs --errors --update` when the registry
  changed;
- run `node scripts/check-contracts.mjs` (all checks, including the MCP probe)
  until green — CI and the publish gate both run it.

## 3. Full gate (local, on the exact release commit)

```sh
pnpm -r --if-present run build
pnpm -r --if-present run typecheck
pnpm -r test
node scripts/check-js.mjs
node scripts/fault-injection.mjs
node scripts/pack-smoke.mjs
node scripts/check-docs.mjs
node scripts/check-docs.mjs --self-test
node scripts/check-release.mjs --stable
node scripts/check-licenses.mjs
node scripts/check-tos.mjs --release
node scripts/check-deps.mjs
node scripts/security-suite.mjs
node scripts/check-contracts.mjs
node scripts/check-provenance.mjs --self-test
node scripts/portable-zip.mjs --self-test
node scripts/pack-portable.mjs --self-test
pnpm eval:det
pnpm run sbom && pnpm run check:sbom
```

All must pass on the exact commit you are about to tag. Also confirm the working
tree is clean (`git status --short` prints nothing).

Note: the **publish workflow gate runs a subset** of this list (install, build,
typecheck, test, pack-smoke, check-js, check-docs, check-release, contracts,
SBOM, licenses, TOS, security, office, deps (warn)). It is not a substitute for
this local list; `eval:det`, `fault-injection` and the portable-bundle self-tests
stay local/CI only unless added there. CI also has a **blocking** `windows-full`
job (Node 22.16 and 24) in 0.4.0, green on `main` after the POSIX-fixture fixes;
`windows-smoke` must stay green too. The real-machine Windows checklist is in
[docs/WINDOWS.md](WINDOWS.md) §8.

## 4. Commit, push main, wait for CI, tag

```sh
git add -A
git commit -m "release: Advisers X.Y.Z"
git push github-direct main        # origin/gitee/gitcode mirrors as configured
# wait until the ci workflow is green on this commit (Linux 22.16/24 + windows-smoke)
git tag -a vX.Y.Z -m "Advisers X.Y.Z"
git rev-parse vX.Y.Z               # tag object SHA: record it
git rev-parse vX.Y.Z^{commit}      # release commit SHA: record it
node scripts/check-release.mjs --stable --require-tag   # tag == HEAD, tag is annotated
git push github-direct vX.Y.Z      # then the gitee/gitcode mirrors
```

CI runs on pushes to `main` (and pull requests), **not on tag pushes**, so the
order above matters: main push → CI green → annotated tag → record both SHAs →
push tag. Do not create the tag before the release commit, and do not commit
release content after the tag.

Note: `actions/checkout` materialises a tag-ref workflow checkout as a
lightweight local ref, so `check-release --require-tag` skips the
annotated-tag assertion under `GITHUB_ACTIONS=true` (it still checks tag commit
== HEAD). The annotated-tag evidence is captured locally in step 4 and stays
verifiable through the remote tag object SHA recorded above.

## 5. Dispatch `publish.yml` from the tag ref

GitHub UI: Actions → `release-gate` → Run workflow, and choose the tag in
"Use workflow from". If the tag is not offered, use the CLI:

```sh
gh workflow run release-gate --ref vX.Y.Z \
  -f release_tag=latest -f confirm=yes -f stage=no -f publish=yes
```

Inputs (both jobs enforce `GITHUB_REF == refs/tags/v<version>`):

- `release_tag`: `latest` (or `next` for the pre-release channel)
- `confirm`: `yes`
- `stage`: `no` for the owner-authorized direct OIDC publish path; `yes` only
  when the owner wants staged packages for manual `npm stage approve`
- `publish`: `yes` for direct publish (validates a Pending-validation Trusted
  Publisher); leave `no` for the staged path

The `gate` job re-runs the release gates on the tag tree and never publishes.
The OIDC publish runs `node scripts/release.mjs --provenance --publish` and
fails closed if `NPM_TOKEN` is present or the workflow ref is not the tag. After
each `npm publish` the script now re-reads the registry and fails closed if the
version is not visible within the propagation window (npm can exit 0 without
publishing when a Trusted Publisher is misconfigured or stage-only).
Staged path: `confirm=yes, stage=yes, publish=no`; the owner then runs
`npm stage approve <stage-id>` with their own OTP. Never claim a staged release
is published until the registry shows it.

## 6. Post-publish verification

```sh
# 1) registry state for all six packages
for p in advisers advisers-core advisers-office advisers-policy-strict \
         advisers-bridge-hermes dsh-advisers; do
  curl -s "https://registry.npmjs.org/-/package/$p/dist-tags"
  curl -s "https://registry.npmjs.org/$p/X.Y.Z" | jq '{version, deprecated, dist}'
done

# 2) provenance, standalone (requires the build ref by default)
node scripts/check-provenance.mjs --version X.Y.Z \
  --expected-ref refs/tags/vX.Y.Z

# 3) tag / registry gitHead / tarball / attestations / build ref / SBOM / clean install
node scripts/verify-release.mjs --version X.Y.Z --tag latest \
  --sbom artifacts/sbom.cdx.json --require-sbom
```

Record the actual `verify-release` check count and the tag object SHA in the
release evidence / CHANGELOG note (0.3.1's 222-check claim came from the 0.3.0
tree; every release needs its own run). Verify the GitHub Release assets:

- `sbom-X.Y.Z.cdx.json` sha256 equals the local `artifacts/sbom.cdx.json`;
- `SHA256SUMS-X.Y.Z.txt` lists exactly the six tarballs and every sha256 matches
  a freshly downloaded registry tarball;
- the release body states the version, the provenance tag ref, the known limits,
  and which contract artifacts changed.

```sh
gh release create vX.Y.Z --verify-tag \
  --title "Advisers X.Y.Z" --notes-file release-notes.md \
  artifacts/sbom.cdx.json#sbom-X.Y.Z.cdx.json \
  artifacts/SHA256SUMS-X.Y.Z.txt#SHA256SUMS-X.Y.Z.txt
```

### 6.1 Windows portable ZIP (build after the npm publish succeeds)

The ZIP is the **offline channel**, not a second official channel, and it is
assembled from the **published** tarballs: `pack-portable.mjs` resolves
`advisers@<version>` and `advisers-office@<version>` from the registry, so it must
run after step 6's registry checks, never from an unpublished source tree.
Consumer/verification docs: [docs/WINDOWS.md](WINDOWS.md) §3.4 and §8.

Release path (Windows x64 machine with Node >= 22.16):

```powershell
# 1) install the two published packages into a fresh app tree
$app = Join-Path $env:TEMP "advisers-portable-X.Y.Z"
New-Item -ItemType Directory -Path $app -Force | Out-Null
npm install --omit=dev --no-audit --no-fund --prefix $app --registry=https://registry.npmjs.org advisers@X.Y.Z advisers-office@X.Y.Z

# 2) build and re-verify the deterministic ZIP + sidecar + portable SHA256SUMS
node scripts/pack-portable.mjs --payload $app --out-dir artifacts
node scripts/pack-portable.mjs --verify artifacts/advisers-X.Y.Z-win-x64.zip --smoke
```

- Output: `artifacts/advisers-X.Y.Z-win-x64.zip`, its `.sha256` sidecar and
  `artifacts/SHA256SUMS-X.Y.Z-portable.txt`. The verifier re-reads every ZIP
  entry (CRC-32), checks the required files/licenses/version and the native
  binaries' win32-x64 platform, then optionally runs the bundled CLI
  (`--smoke`).
- `--cross-install` on Linux resolves the win32-x64 optional dependencies for a
  **layout-only** check; a releasable artifact still requires the Windows smoke
  run.
- The ZIP contains no Node.js; the launcher fails with a clear message below
  Node 22.16. It is **not covered by npm provenance** and is not code-signed.
- Attach the ZIP and `SHA256SUMS-X.Y.Z-portable.txt` to the GitHub Release (and a
  GitHub artifact attestation when the operator can produce one):

```sh
gh release upload vX.Y.Z \
  artifacts/advisers-X.Y.Z-win-x64.zip \
  artifacts/SHA256SUMS-X.Y.Z-portable.txt
# when available: gh attestation verify artifacts/advisers-X.Y.Z-win-x64.zip --repo PerryLink/advisers
```

- `verify-release.mjs` does **not** check the ZIP (its scope is the npm
  tarballs/SBOM/provenance); the portable verifier above is the ZIP gate.
- Windows status at release time: `windows-smoke` and `windows-full` are both
  blocking and green on the release commit; the real-client record (docs/WINDOWS.md
  §8) must still be re-run manually, so do not describe the release as "fully
  Windows-verified" from CI alone.

## 7. dist-tags and deprecation (owner only)

```sh
npm dist-tag add advisers@X.Y.Z next --registry=https://registry.npmjs.org/
# repeat for the other five packages when a next channel is used
npm deprecate advisers@OLD "Superseded by X.Y.Z; use advisers@X.Y.Z." \
  --registry=https://registry.npmjs.org/
```

`dist-tag`/`deprecate` use the owner's npm credentials; `npm stage approve`
needs the owner's OTP; `npm unpublish` needs 2FA. Deprecation must point at the
replacement and must not claim the old version was removed.

## 8. Other remotes

Gitee and GitCode are mirrors: push `main` and the annotated tag, then verify
with anonymous `git ls-remote <url> refs/heads/main refs/tags/vX.Y.Z` when the
mirror allows anonymous reads. If it does not (Gitee currently returns 403
anonymously), the owner confirms the refs manually; token reads must never echo
or store the token.

## 9. Failure handling

- **Wrong tarball/docs:** ship the next version. A published npm tarball cannot be
  replaced; `npm unpublish` needs the owner's 2FA.
- **Wrong provenance ref:** the release is installable but cannot claim tag-ref
  provenance. Record it honestly in the release notes and supersede it in the
  next version.
- **Partial publish:** do not retry blindly. Check which packages landed, keep
  the version consistent, and either finish the same version through the same
  tag-ref workflow or treat it as an incident and publish a superseding version.
- **Tag moved by mistake:** restore the tag to the original commit if it never
  published; if it published, leave history alone and document it.
- **Release body error:** the GitHub Release body is editable (owner can PATCH);
  npm tarballs are not. Correct the body, not the tag.

## 10. Automation matrix

| Step | Who |
|---|---|
| version bump, docs, CHANGELOG, contract artifacts | agent (lead reviews) |
| full local gate + test suite | agent |
| commit, annotated tag, record tag object/commit | agent (owner approval before push/tag) |
| push main/tag to GitHub/Gitee/GitCode | owner or agent with explicit approval |
| Trusted Publisher configuration on npmjs.com | **owner** |
| dispatch `publish.yml` | owner (or agent on explicit instruction) |
| `npm stage approve` (OTP) | **owner** |
| `npm dist-tag` / `npm deprecate` | **owner** (owner credentials) |
| `npm unpublish` | **owner** (2FA) |
| GitHub Release create/edit + assets | owner (or agent on explicit instruction) |
| Windows portable ZIP build/verify + attach (after npm publish) | agent on a Windows release machine (owner reviews the assets) |
| registry/attestation/SBOM/hash verification | agent (read-only) |

## 11. Credentials

The only credential source is the owner's local, git-ignored token file. Read it
per process, never print or commit it, never paste it into a chat, an issue, a PR
body or a log. CI publishing uses GitHub OIDC only.

## 12. Related checks and docs

- `node scripts/check-docs.mjs [--self-test]` — current-version advertising,
  release-state wording (release-candidate/unpublished claims attributed to the
  current version; EN/ZH; package READMEs; CHANGELOG `Status:`), license/TOS.
- `node scripts/check-release.mjs --stable --require-tag` — package lockstep,
  pins, version constants, tag exists, tag is annotated, tag object → commit,
  tag == HEAD.
- `node scripts/check-provenance.mjs [--expected-ref ...]` — attestation
  subject/repository/commit and the SLSA build ref (defaults to
  `refs/tags/v<version>`; `--allow-non-tag-provenance` only for historical
  audits). `verify-release.mjs` supplies the checked-out tag automatically.
- `node scripts/verify-release.mjs` — the post-publish gate: registry,
  tarballs, dist-tags, gitHead, provenance, SBOM, clean-prefix install/import.
  It does not check the Windows portable ZIP.
- `node scripts/portable-zip.mjs --self-test` / `node scripts/pack-portable.mjs
  --self-test` — the dependency-free ZIP codec and portable-bundle builder
  (no publish; output is gitignored `artifacts/`).
- `CONTRIBUTING.md` Releases section, `docs/SECURITY.md` §3–§4,
  `docs/SBOM.md`, `docs/WINDOWS.md` §3.4/§8.

## 13. Release records

A short factual record per release; keep it terse and do not turn it into a
changelog copy.

### 0.4.0 (2026-11-21)

- **Published:** npm `latest` = 0.4.0, `next` = 0.4.0; all eight workspace
  packages lockstep at 0.4.0 (six published). Tag: `v0.4.0` (annotated,
  tag-ref publish; record the tag object and commit SHAs here when archiving the
  release evidence).
- **Release shape:** single 0.4 feature release — KB/schema v22, mail entry,
  interactive shell, proactive briefs, policy/evidence 2.0 subset (decision
  tokens, consent), receivables/payments + client status packs, MCP modern
  dual-era, Windows CI + portable ZIP, v2026.11.4 legal revision.
- **Schema:** v22, one `kb-mail-payment-entities` migration, one-way; a 0.3.2
  binary fails with `E_SCHEMA_NEWER`; rollback = restore
  `state.db.before-migrate-v21-*` or export → fresh import into a 0.3.x home.
- **Contracts:** additive — `contracts/mcp/versions-v2.json`,
  `responses-v2.schema.json`, `contracts/vectors/mcp/modern.vectors.json`, new
  CLI read models/commands and error codes; frozen v1 artifacts keep their
  meaning. Three new files, no renames.
- **Artifacts:** CycloneDX SBOM, `SHA256SUMS` for the six tarballs, and the
  Windows portable ZIP `advisers-0.4.0-win-x64.zip` +
  `SHA256SUMS-0.4.0-portable.txt` (offline channel; verify the hash/attestation,
  it is not npm-provenance-covered).
- **Verification:** record the 0.4.0 `verify-release` check count from the actual
  run (do not reuse 0.3.0's 222), the tag object/commit SHAs, the portable ZIP
  sha256 and the `windows-smoke` / `windows-full` results (both blocking).
- **Release notes / assets:**
  <https://github.com/PerryLink/advisers/releases/tag/v0.4.0>.

### 0.3.2 (2026-11-21, superseded)

- Customer loop + performance closeout; additive contracts, no schema migration;
  published from `refs/tags/v0.3.2`. Superseded by 0.4.0; its tarballs and
  Release assets stay in place.
