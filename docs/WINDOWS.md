# Windows support

> Status: **0.4.0 draft, 2026-11-21.** Windows is the primary target platform
> (the product and its docs are Windows-first), but "supported" is a claim this
> page scopes precisely: Windows 11 25H2/26H2 x64 only, npm as the official
> channel, and the portable ZIP as the offline channel. The real-machine
> verification run is recorded in the release checklist; until that run and the
> full Windows test suite are green, the README keeps the partial-coverage
> wording from [SECURITY.md](SECURITY.md).
>
> This page is the operator/consumer reference for installing, upgrading and
> troubleshooting Advisers on Windows. It does not replace the
> [Terms of Service](TOS.md), [Privacy notice](PRIVACY.md),
> [Safety & content review](SAFETY.md) or [SECURITY.md](SECURITY.md).

## 1. Support matrix

| Platform | Status | Notes |
|---|---|---|
| Windows 11 25H2 x64 (build 26200+) | **Supported** | Primary target; the 2026-11-21 real-machine checks and the Windows full test suite run here. |
| Windows 11 26H2 x64 (build 26300+) | **Supported** | Same client API surface as 25H2; covered by the same release verification. |
| Windows 11 24H2 x64 | Not supported | End of support 2026-10-13 (outside the 0.4 support window). May work but is not tested. |
| Windows 11 23H2 x64 | Not supported | End of support 2026-11-10. |
| Windows 10 (any edition) | **Not supported** | End of support 2025-10-14. |
| Windows Server 2022/2025 | CI only | GitHub Actions "windows-latest" is currently a Windows Server 2025 image. It runs the CI gates; it is not a supported client target. |
| Windows 11 arm64 | Not supported | No arm64 build or verification in 0.4. |
| WSL2 | Not a support target | Useful for development, but run the Windows Node build from PowerShell. A WSL-mounted checkout (/mnt/...) produces symlink/permission false failures in the test suite. |

Hardware/OS requirements:

- x64 CPU, Windows 11 25H2 or 26H2 with current cumulative updates.
- Node.js **>= 22.16** (Node.js 24 LTS recommended). Node 22.13-22.15 ship
  node:sqlite without FTS5 and do not work.
- PowerShell 7 + Windows Terminal recommended. Windows PowerShell 5.1 works;
  see the BOM note in the troubleshooting table.
- Free disk: npm global install needs about 170 MB; the portable ZIP is about
  50 MB compressed / 165 MB extracted.
- No administrator rights are required for the portable ZIP. A global npm
  install may need a writable npm prefix (see section 7).

## 2. Channels: npm is official, the ZIP is offline

| Channel | What it is | Official | Offline | Notes |
|---|---|---|---|---|
| **npm global** | Six published tarballs installed into the npm prefix; SLSA provenance + registry attestations | **Yes - official channel** | No | Recommended for every normal installation. Pins an exact version. |
| npx | Runs the published npm tarball from the npx cache; no global install | Documented convenience | No | For trying a version; cold start downloads about 140 MB into the npx cache. |
| **Portable ZIP** | GitHub Release asset advisers-<version>-win-x64.zip: runtime dependencies + launcher + licenses, Node **not** included | **Offline channel** | **Yes** | For offline/restricted/air-gapped machines and for copying a known-good build between machines. Verified by SHA256SUMS and, when reachable, GitHub artifact attestation. |
| Scoop | Self-built bucket would wrap the ZIP with depends: nodejs-lts | Not provided in 0.4 | Yes | Re-evaluated for 0.4.5/0.5; no bucket ships with 0.4.0. |
| winget | Manifest would wrap the ZIP; Node dependency behaviour is unverified | Not provided in 0.4 | Yes | Re-evaluated for 0.5. |
| Homebrew | macOS/Linux package manager | Not provided | - | Out of scope: Windows-first product, and the PolyForm Noncommercial license is not DFSG-compatible for homebrew/core. |
| MSI/MSIX/Microsoft Store, signed EXE, single-file SEA, auto-updater | - | **Not provided** | - | The product has no automatic update check (see TOS section 9.1 and PRIVACY section 1); code signing is a 0.5+ consideration. |

Use npm unless you are offline or need a self-contained directory. The ZIP is
not a second "trust root": it is the same runtime as the npm tarballs, packaged
for offline delivery, and must be verified before use (section 3.4).

## 3. Install

### 3.1 Install Node.js

Pick one:

```powershell
winget install OpenJS.NodeJS.LTS          # Node.js 24 LTS
# or: scoop install nodejs-lts
# or: nvm-windows, or the MSI from https://nodejs.org/en/download
node -v                                   # must print v22.16.0 or newer
```

Node 22.16 is the exact minimum: node:sqlite exists from 22.13 but FTS5 is
missing in 22.13-22.15, and the ledger fails with
"No such built-in module: node:sqlite" or "no such module: fts5" on older
versions. Install Node.js 24 LTS unless you have a reason to pin 22.16.

### 3.2 Official: npm global install

```powershell
npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
# reproducible install: pin exact versions
# npm i -g --registry=https://registry.npmjs.org advisers@X.Y.Z advisers-office@X.Y.Z

advisers --version        # must print the installed version
advisers tos status       # first-run consent record
advisers doctor
```

- Install advisers-office explicitly; the CLI does not pull the optional office
  package automatically (formats, template verification).
- If "advisers" is not found afterwards, open a new terminal so PATH refreshes.
  Check the npm prefix with npm config get prefix.
- From a checkout, set ADVISERS_OFFICE_LOCAL=1 instead of installing the office
  package (development only).
- Verify the published build with
  node scripts/verify-release.mjs --version X.Y.Z --tag latest --sbom artifacts/sbom.cdx.json --require-sbom
  from a checkout; npm audit signatures also checks the registry signatures.
- Optional: set ADVISERS_API_KEY for model-backed commands
  (PowerShell: $env:ADVISERS_API_KEY = "sk-..."). Local-only commands
  (status, init, doctor, office, template, verify, commit) do not egress.

### 3.3 Try a version without installing: npx

```powershell
npx -y advisers@X.Y.Z --version
npx -y advisers@X.Y.Z status
```

The first run cold-starts and caches about 140 MB under the npm/npx cache.
npx is documented convenience only; it is not an official distribution channel
and it is not offline.

### 3.4 Offline channel: portable ZIP

The ZIP contains app/node_modules/advisers + advisers-office, advisers.cmd,
LICENSE, NOTICE, THIRD-PARTY-NOTICES.md, README.txt and a bundle package.json.
It does **not** contain Node.js.

1. Download advisers-<version>-win-x64.zip and SHA256SUMS-<version>-portable.txt
   from the GitHub Release.
2. Verify the hash before extracting:

```powershell
Get-FileHash -Algorithm SHA256 .\advisers-X.Y.Z-win-x64.zip
# compare with the SHA256SUMS-X.Y.Z-portable.txt line (or the Release page)
# if gh is available and the machine has network access:
gh attestation verify .\advisers-X.Y.Z-win-x64.zip --repo PerryLink/advisers
```

3. Remove the Mark-of-the-Web from the downloaded file, then extract:

```powershell
Unblock-File .\advisers-X.Y.Z-win-x64.zip
Expand-Archive .\advisers-X.Y.Z-win-x64.zip -DestinationPath .
cd .\advisers-X.Y.Z-win-x64
.\advisers.cmd --version
.\advisers.cmd status
```

4. The launcher prints a clear error if Node.js is missing or older than 22.16.
   It does not modify PATH or the registry. To get a global command, add the
   extracted folder to your user PATH yourself (or copy advisers.cmd to a folder
   already on PATH and keep the bundle next to it only if you also keep app/).

Notes:

- The ZIP is not covered by npm provenance; the release operator must publish
  it together with SHA256SUMS and a GitHub build attestation. Until that
  release-side integration ships, only trust a ZIP whose SHA-256 matches the
  hash published in the Release body/notes.
- No auto-update: to upgrade, download and extract the new version (section 4).
- The launcher uses node from PATH (or node\node.exe inside the bundle if a
  future full bundle provides one). Node is never installed by the launcher.

## 4. Upgrade and rollback

### npm global

```powershell
npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
advisers --version
advisers doctor --check-db
```

- Pin exact versions when reproducibility matters. Both advisers and
  advisers-office must be the same version.
- Keep the previous version number: downgrading is just installing that exact
  version again, but see the migration note below first.
- Back up before a feature upgrade: advisers backup .\advisers-before-X.Y.Z.db
  (and keep the .sha256/.anchor.json sidecars if you use managed backups).

**0.4.0 schema migration:** 0.4.0 migrates the local ledger to schema v22 (KB,
mail and receivables tables plus FTS indexes). The migration is one-way: after
0.4.0 has opened the database, do **not** point 0.3.x at it. To roll back, first
restore a backup created before the upgrade (advisers restore or
import --replace) on a fresh home, or keep using 0.4.x.

### Portable ZIP

Extract the new version into a new folder, verify its hash, run
advisers.cmd doctor --check-db with the same ADVISERS_HOME, then delete the old
folder. Your data stays in %USERPROFILE%\.advisers (or ADVISERS_HOME); replacing
the program folder does not touch the ledger.

## 5. Offline, mirrors and restricted networks

Three layers, in order of trust:

1. **Official npm registry** - the official install path and the only source of
   provenance/attestation metadata:
   npm i -g --registry=https://registry.npmjs.org advisers@X.Y.Z advisers-office@X.Y.Z
2. **Portable ZIP** - the real offline path. Copy Node.js (MSI or ZIP) and this
   ZIP to the machine; verify the SHA-256; no network is needed after that.
   Commands that call a model API or fetch a URL still need egress; everything
   local (status, init, office, template, verify, commit, backup) does not.
3. **Mirrors** - a registry mirror (for example registry.npmmirror.com) improves
   availability, not integrity: mirrors may lag and may not serve
   dist.attestations. Check the version on both sources
   (npm view advisers version --registry=...) and keep the official registry as
   the integrity reference. npm audit signatures only works against the official
   registry.
4. **Fully isolated machines** - only the portable ZIP (plus a Node.js
   installer) is supported. Advisers does not bundle Node and does not promise
   tarball-level offline installs.

Corporate proxies:

```powershell
npm config set proxy http://proxy.example:8080
npm config set https-proxy http://proxy.example:8080
$env:HTTPS_PROXY = "http://proxy.example:8080"   # per-process alternative
$env:NO_PROXY = "127.0.0.1,localhost"
npm ping
```

Data safety: the CLI has no telemetry and no automatic update check. Model
commands (chat, capture, review, brief --deep, learn review, research --web)
send context to the configured API endpoint only when you run them.

## 6. Data, security and Windows specifics

- Default data directory: %USERPROFILE%\.advisers unless ADVISERS_HOME is set.
  Prefer a short, non-synced path when in doubt (for example
  $env:ADVISERS_HOME = "C:\advisers-data").
- The ledger is **not encrypted at rest by default**. Backups, exports,
  migration/import/undo copies and vault staging files contain the full database
  and are plaintext; treat them like the ledger. Optional encrypted-at-rest
  mode: advisers vault seal (see [AT-REST-VAULT.md](AT-REST-VAULT.md)).
- Windows ACLs, not POSIX mode bits, protect the files. The test suite's
  0600/0700 assertions are POSIX-only (they are skipped/relaxed on Windows);
  this is a test-fixture difference, not a weaker product guarantee.
- OneDrive: syncing ADVISERS_HOME while the CLI writes can hold handles and
  race renames. The CLI has bounded EPERM/EBUSY retries, but a non-synced
  ADVISERS_HOME is the supported configuration for reliable backups.
- Defender real-time scanning can cause transient EPERM/EBUSY on rename/fsync.
  The durable-write helpers retry; if a command still fails, run
  advisers doctor --check-db and retry once.
- SmartScreen / Mark-of-the-Web: unblock the ZIP (Unblock-File) before
  extracting; a downloaded .cmd inside an unblocked parent is not blocked.
- PowerShell execution policy: npm's global shims include advisers.ps1. If your
  policy blocks scripts, use advisers.cmd, cmd /c advisers ..., or
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass for the current
  shell only. Do not weaken the machine-wide policy for this.
- Long paths (>260 characters): Windows supports them only with opt-in
  configuration; keep ADVISERS_HOME and backup paths short.
- Chinese/space user names and paths are supported; quote paths in PowerShell.
- Instance lock: two writers on the same ADVISERS_HOME fail closed with
  E_DB_LOCKED. A hard-killed process leaves %ADVISERS_HOME%\instance.lock; the
  next write command reclaims it after the pid/age staleness check (default
  1 hour, ADVISERS_LOCK_STALE_MS overrides). Never delete state.db-wal or
  state.db-shm by hand.
- Reminders: advisers remind install writes an opt-in script under
  %ADVISERS_HOME%\scheduler and prints the schtasks instructions; it does not
  silently register a scheduled task.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No such built-in module: node:sqlite | Node < 22.13. Install Node.js 24 LTS. |
| no such module: fts5 | Node 22.13-22.15. Install Node.js >= 22.16 (24 LTS recommended). |
| Command "advisers" not found after npm i -g | Open a new terminal (PATH refresh); check npm config get prefix; ensure the prefix bin directory is on PATH; or use npx for a one-off. |
| advisers.ps1 cannot be loaded because running scripts is disabled | Execution policy. Use advisers.cmd, or Set-ExecutionPolicy -Scope Process Bypass for that PowerShell session only. |
| Chinese output is garbled | Use Windows Terminal and chcp 65001; PowerShell 5.1 redirection writes UTF-16 (see next row). |
| SyntaxError: Unexpected token (BOM) | JSON input has a UTF-8 BOM. PowerShell 5.1 ">" writes UTF-16/BOM; write JSON with [IO.File]::WriteAllText(path, text, UTF8Encoding($false)). |
| advisers-office is not installed | npm i -g advisers-office@<same version>; from a checkout set ADVISERS_OFFICE_LOCAL=1. |
| model HTTP 401 | Key/base URL wrong. Check $env:ADVISERS_API_KEY and advisers status; no key is needed for local-only commands. |
| E_DB_LOCKED | Another Advisers writer holds %ADVISERS_HOME%\instance.lock. Close it, or wait for the stale timeout; do not delete state.db files. |
| EPERM/EBUSY on backup/rename/fsync | Transient antivirus/OneDrive handle. Retry the command; move ADVISERS_HOME out of OneDrive; run advisers doctor --check-db. |
| backup/export writes fail on an unwritable target | The target directory is read-only or ACL-protected. Choose a writable folder; the command fails closed rather than writing a partial file. |
| Long path / ENAMETOOLONG | Keep ADVISERS_HOME and output paths short; enable Windows long-path support if you control the machine. |
| Portable ZIP: launcher says Node.js is required | Install Node.js >= 22.16 (winget install OpenJS.NodeJS.LTS), open a new terminal, then run advisers.cmd again. |
| Portable ZIP: SmartScreen warns about advisers.cmd | File came from the internet: Unblock-File the ZIP before extraction; verify the SHA-256 against the Release page. |
| Get-FileHash does not match SHA256SUMS | Stop. The download is corrupt or tampered with; download again from the official Release, and prefer the attested artifact. |
| npm mirror installs a much older version | Mirrors lag. Compare npm view advisers version on the mirror and the official registry; use the official registry for the version you need. |
| advisories/CVE check prints WARN | node scripts/check-deps.mjs is WARN-only by policy; see [SECURITY.md](SECURITY.md) section 5 and the release notes. |

## 8. Verification and known limitations

CI runs two Windows jobs on GitHub's windows-latest image:

- **windows-smoke** (blocking): frozen install, build, packaging smoke,
  docs/release gates and a minimal CLI plus durable-write flow on a fresh
  temporary ADVISERS_HOME. It does not run the full test suite.
- **windows-full** (0.4.0: blocking): frozen install, build, typecheck, every
  package's test files on Node 22.16 and 24, pack-smoke and the portable-bundle
  self-tests. It was green on `main` for the 0.4.0 release after the POSIX
  fixture fixes; product-side argv/instance-lock limits are explicit, documented
  skips (see §8).

The CI image is a **Windows Server 2025** image: it has no IME, Windows
Terminal, OneDrive, Office/WPS or Defender client, so it cannot replace the
real-client checks. The supported-client evidence is the manual real-machine
run recorded in the release checklist:

- 2026-11-21, Windows 11 25H2 x64, Node 24.22.1: 1011 tests, 36 known
  Windows-only failures at first run (30 fixture/POSIX-assumption failures and
  6 product/local-semantics items). A clean re-run reproduced 34 (including all
  fixture classes); 2 eval-suite failures did not reproduce and are treated as
  environment-sensitive until CI confirms them. The full Windows suite must be
  green (or every skip justified) before the README claims full Windows
  verification.

Known limitations in 0.4.0:

- IME composition in the interactive raw-mode shell is not verified; use the
  one-shot commands (advisers chat ...) or a non-raw shell if input breaks.
- External adapter commands (ADVISERS_OCR_CMD, ADVISERS_TIMESTAMP_CMD,
  ADVISERS_NOTIFY_CMD, ADVISERS_VERIFY_RECALC_CMD) are currently a single
  executable path (plus a shell string only for the recalc check); a quoted
  command line with arguments is not parsed on Windows. Point them at an
  executable; a command with arguments is tracked for a follow-up release.
- Windows 10, Windows 11 23H2/24H2, arm64 and Server client use are not
  supported (section 1).
- No MSI/MSIX/Microsoft Store package, no signed EXE, no auto-update and no
  Scoop/winget manifest in 0.4.0.
- The portable ZIP is not part of npm metadata; its integrity comes from the
  Release SHA256SUMS plus GitHub artifact attestation, which the release
  operator must attach. Do not distribute an unverified ZIP.

## 9. Related documents

- [QUICKSTART.md](QUICKSTART.md) - first-run flow and a shorter Windows setup.
- [SECURITY.md](SECURITY.md) - release trust, credentials, gates and the current
  Windows-coverage statement.
- [RELEASING.md](RELEASING.md) - release operator checklist (including the ZIP/
  SHA256SUMS assets).
- [AT-REST-VAULT.md](AT-REST-VAULT.md) - optional encrypted database at rest.
- [PRIVACY.md](PRIVACY.md), [TOS.md](TOS.md), [DISCLAIMER.md](DISCLAIMER.md) -
  data flows, terms and no-warranty notices.
