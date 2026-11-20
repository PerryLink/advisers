# Releasing Advisers

This is the operational release checklist for the Advisers monorepo. It exists
because 0.3.0 was published before its final documentation commit, which shipped
release-candidate README text in the npm tarballs, recorded `refs/heads/main` in
the provenance and left the `v0.3.0` tag pointing at a tree that was not the
published tree. 0.3.1 corrected that by committing the docs first and publishing
from `refs/tags/v0.3.1`. Never repeat the 0.3.0 order.

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
  patch 0.3.1 is the only exception in history; the next feature release after
  0.3.1 is **0.3.2**.
- All eight workspace packages are lockstep; six are published
  (`advisers`, `advisers-core`, `advisers-office`, `advisers-policy-strict`,
  `advisers-bridge-hermes`, `dsh-advisers`), two link packages stay private but
  version-locked.
- Freeze code before touching versions. The release commit must contain the
  final docs, CHANGELOG and version constants.

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
`docs/CONTRACTS.md` and `docs/PRIVACY.md` when the data surface changes.
Historical sections keep their original version numbers.

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
pnpm eval:det
pnpm run sbom && pnpm run check:sbom
```

All must pass on the exact commit you are about to tag. Also confirm the working
tree is clean (`git status --short` prints nothing).

Note: the **publish workflow gate runs a subset** of this list (install, build,
typecheck, test, pack-smoke, check-js, check-docs, check-release, contracts,
SBOM, licenses, TOS, security, office, deps (warn)). It is not a substitute for
this local list; `eval:det` and `fault-injection` stay local/CI only unless
added there.

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
fails closed if `NPM_TOKEN` is present or the workflow ref is not the tag.
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
- `CONTRIBUTING.md` Releases section, `docs/SECURITY.md` §3–§4,
  `docs/SBOM.md`.
