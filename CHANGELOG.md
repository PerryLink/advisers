# Changelog

## 0.2.0 (release candidate, 2026-11-17)

First stable release of the 0.2.0 line: the six published packages are lockstep at `0.2.0`
and the two private `advisers-link-*` packages share the same version. Not yet on `latest`:
npm staging and the account owner's OTP approval happen at release time (runbook:
`docs/RELEASING.md`; evidence draft: `eval/results/E11-release-2026-11-17.md`).

### Added

- **Terms / privacy / consent**: TOS v2026.11.2 (`docs/TOS.md`), new `docs/PRIVACY.md`,
  `docs/DISCLAIMER.md`, `docs/SAFETY.md`, `docs/legal-citations.json` and offline packaged
  copies under `packages/advisers/lib/tos/`; first-run and version-change consent gate
  (`advisers tos show|status|accept|revoke`, local `~/.advisers/tos.json`, audited
  `tos.accept|tos.block|tos.reaccept|tos.revoke` events, non-TTY exit 3 `E_TOS_REQUIRED`,
  `--accept-tos` / `ADVISERS_ACCEPT_TOS=1`, re-confirmation for `soul set/init`, routine
  writes and `import --replace`).
- **Local content safety**: offline rule layer (`lib/safety`: 14 categories / 92 rules, zero
  network) wired into the model/research/capture/pet-brief/attachments/MCP/DSH paths.
- **Pet Brief contract v0.2**: `schemaVersion: 2` + `displayPolicy` (default `private`;
  `public` must be explicit), atomic writes, v0.1 briefs readable as legacy; public schema
  and test-case snapshots under `docs/pet-brief/`; consumer guidance updated. The CLI
  exposes `--display-policy public|private|none`, `--check --strict` and `--print-schema`;
  `--check` reports warnings without changing the exit code (strict mode turns legacy v0.1
  briefs / missing `displayPolicy` into errors).
- **Delivery receipt pack v1.1**: `advisers deliveries --receipt` copies the delivered files
  and records every SHA-256, the generator, verify results and recipient; `advisers evidence
  verify <dir>` verifies a pack offline (JSON, exit 0/1, no `~/.advisers`). Evidence entries
  are capped at 2000 by default (`--ids` / `--all` override).
- **Reminders / calendar**: per-commitment reminder offsets
  (`commit add/edit --remind-offsets`), absolute multi-VALARM `.ics` export, opt-in
  `--notify` webhook, `remind install|uninstall|status [--apply]` scheduler with a recorded
  last run (`~/.advisers/scheduler/status.json`), and local RRULE expansion in
  `today --calendar` (all-day `全天` / recurring `（循环）` markers).
- **Calendar / source schema v2**: local RRULE expansion helper and source schema v2
  (`normalizeSource`/`validateSource`, bare capture = `conversation`) with read-side v1
  compatibility.
- **MCP**: server extracted to `lib/mcp-server.js` with 7 tools (5 read:
  today/commitments/who/evidence/remind; 2 write-path: pending-only capture candidate and
  read-only pack verification) plus 4 read-only resources, error codes
  (`-32601/-32602/-32002/-32700`) and a 1 MiB JSON-RPC line cap. `advisers mcp --stdio`
  now serves this library; every `tools/call` is audited and a write whose audit row cannot
  be appended fails closed (created candidate rolled back).
- **DSH bundle**: expanded from 2 to 5 tools (`advisers_brief`, `advisers_office`,
  `advisers_today`, `advisers_who`, `advisers_evidence`); the three ledger views are
  read-only.
- **Performance**: shared `Intl.DateTimeFormat` (no per-commitment ICU churn), batched
  `tick` plus SQLite indexes (schema v18 adds 12 indexes), lazy loading of pdf-lib/jszip
  modules, PDF wrap character-width cache, and an evidence-pack entry cap. The 2026-11-17
  benchmark (before/after, ext4 copy) measured: startup `--version` 185ms/105MB →
  70ms/71MB; `today` at 50k commitments 3.48s/1.57GB → 0.65s/331MB; `tick` 26.2s/1.13GB →
  0.66s first run; PDF `wrap()` 1000 lines 425ms → 3ms; `deliver --format pdf` at 10k data
  7.84s → 1.56s.
- **Robustness / security**: keyed audit transactions, no silent JSON fallback, atomic
  vault/sync writes, IMAP/research input limits, Office zip-bomb budgets shared across
  read/edit/validate/attachments, deeper Office verification, and safety/egress regressions
  covered by new tests.

### Changed

- **Licensing**: from `0.2.0` the source tree is **PolyForm Noncommercial License 1.0.0**
  (software) + **CC BY-NC-SA 4.0** (docs/data/design) — source-available, **not** OSI open
  source; commercial use needs a separate written licence. Every package carries identical
  `LICENSE`/`NOTICE` and ships `THIRD-PARTY-NOTICES.md`; `LICENSING.md`, `NOTICE` and the
  README licence sections document the split and the required notice.
- **Lockstep 0.2.0**: all eight workspace packages (`advisers`, `advisers-core`,
  `advisers-office`, `advisers-policy-strict`, `advisers-bridge-hermes`, `dsh-advisers`,
  private `advisers-link-email`, `advisers-link-feishu`) are `0.2.0`; internal pins,
  version constants and `pnpm-lock.yaml` follow.
- **Docs version cleanup**: user-facing READMEs/QUICKSTART describe `0.2.0` as the stable
  release candidate and explain the `latest` (stable) vs `next` (pre-release) channels.

### Verified (release-preparation tree, 2026-11-17)

- `pnpm -r build` and `pnpm -r typecheck`: exit 0.
- `node scripts/pack-smoke.mjs`: PASS for all six packages (`advisers@0.2.0`: 53 files /
  41 local imports).
- `node scripts/check-docs.mjs`: PASS (`0.2.0`).
- `node scripts/check-tos.mjs --release`: PASS (TOS v2026.11.2, effective 2026-11-17).
- `node scripts/check-licenses.mjs`: PASS (PolyForm-NC + CC-BY-NC-SA, 203 third-party
  packages).
- `node scripts/check-release.mjs`: PASS (lockstep `0.2.0`).
- `node scripts/security-suite.mjs`: 5/5 PASS; `node scripts/verify-office.mjs`: PASS.
- Test suite: 450+ tests across 8 packages (static `test()`/`it()` declaration count 456 on
  this tree, including Pet Brief v0.2 and MCP CLI coverage); the full run is recorded on the
  final release commit in `eval/results/E11-release-2026-11-17.md`.

### Known issues

- The legal texts (TOS v2026.11.2 / PRIVACY / DISCLAIMER / SAFETY) were finalized by the
  release lead acting as legal owner; an external-lawyer review is still recommended before
  commercial rollout. They are not a compliance certification.
- No independent human gold standard for extraction/review quality and no real 5–10
  consultant dogfood yet: the published evaluation is synthetic plus author-run.
  Real-account/WS/Office-L3 validation is still pending.
- Promoting `latest` requires the npm account owner's OTP approval in a browser flow; no
  agent can perform it. The release is not on `latest` until then.
- `dsh-advisers` depends on the DSH preview line (`@deepseek-ai/dsh-tools` rc) rather than a
  stable upstream; disclosed here as a known constraint.
- Historic preview state that should not be read as current: the last Apache-2.0 preview
  (`.71`) is published only on `next`, and older staged builds are not part of 0.2.0.

### Prior-version licence mapping

- Releases published before `0.2.0` keep the licence they shipped under (MIT for early
  releases; Apache-2.0 for the previews published up to 2026-11-17). The change is **not
  retroactive**; `NOTICE` records the mapping.

## 0.2.0-preview.71 (published 2026-11-17)

### Added
- **Pet Brief producer (contract v0.1)**: `advisers pet-brief --json|--out [path]|--check [--in file]`
  projects a read-only, redacted brief (today/commitments/risks/facts/mood/counts) for the
  desktop-pet consumer. SQLite is opened read-only; no model call, no network, no ledger
  writes. `secrecy >= 2` matters are excluded entirely, facts with `confidence < 0.7` are
  dropped, TTL is 5 minutes, each section is capped at 10 items. 18 new tests.
  Contract and known limits: `docs/PET-BRIEF-PRODUCER.md`; consumer UI/transport is not wired yet.
- **Apache-2.0 switch finished in the source tree**: every package now carries the Apache-2.0
  `LICENSE` and `NOTICE`, sets `license: Apache-2.0`, and ships `NOTICE` in its npm `files`
  allowlist; package READMEs (EN/ZH), root README-zh, `docs/PRICING-CHANNEL.md` and
  `scripts/check-docs.mjs` were updated to match. Builds from this preview onward are
  Apache-2.0. The already-staged dependency builds `advisers-core@0.2.0-preview.22`,
  `advisers-policy-strict@0.2.0-preview.12` and `advisers-office@0.2.0-preview.14` were built
  before the switch and remain MIT; they are the pinned versions of this release.

### Changed
- `scripts/check-docs.mjs` now fails CI when a publishable package's `license` field,
  `LICENSE`, `NOTICE`, `files` allowlist or README license section drifts from Apache-2.0.
- Docs: Pet Brief added to root/package READMEs, CHANGELOG and `docs/PET-BRIEF-PRODUCER.md`.

### Verified
- `pnpm -r test`: 250 tests / 250 pass / 0 fail (8 packages).
- `pnpm -r build` and `pnpm -r typecheck` pass; `pack-smoke` reports 36 files for `advisers` (incl. `NOTICE`).
- `node scripts/check-docs.mjs`, `node scripts/security-suite.mjs` (5/5) and
  `node scripts/verify-office.mjs` pass.

## 0.2.0-preview.70 (staged, approval pending)

### Added
- **E1 reminders**: `advisers remind` (buckets/dedupe/snooze, 5 rule families),
  `.ics` VEVENT+VALARM export, `--deliver` local log, and opt-in
  `remind install|uninstall|status` scheduler scripts (`~/.advisers/scheduler`).
- **E2 read-only ingress**: `capture --from-mail` (`.eml`/`.mbox`), `capture
  --from-transcript` (VTT/SRT/text), `calendar import --ics`; all candidates
  require `memory accept`, imports are deduped for 30 days, and secret matters
  fail closed before any model/network call.
- **E3 evidence/交付**: `evidence show <id>`, `deliveries --pack` (manifest,
  README, SHA256SUMS, DOCX receipt), `deliver --type ...` (confirmation/weekly/
  statement/ledger; docx/xlsx), and `today --sources`.
- **E6**: read-only JSON for status/commit/who/deliveries; `advisers mcp --stdio`
  (today/commit/who/evidence/remind); OpenAI-compatible/Ollama provider support
  via `ADVISERS_PROVIDER` (DeepSeek remains default).
- **E9**: `advisers privacy [--json] [--prove]`; evidence exports honor secret
  matters.
- **E5 partial**: `memory search` also searches turns; `why`/`forget` accept fact ids.
- **E8**: `advisers ui [--port n]` local-only read-only view (127.0.0.1, GET only; no telemetry/writes).
- **E1-T3 local notifications**: `remind --deliver --notify` with `ADVISERS_NOTIFY_CMD` / macOS osascript / Windows-WSL Toast / Linux notify-send; no channel => explicit `log-only` (no fake push), body only count-style.
- **P2 file-based sync**: `sync push|pull|status --dir` encrypted whole-DB snapshots in a user-provided sync folder (AES-256-GCM; last-snapshot-wins; pull backs up local DB; no server/merge).
- **P2 timestamp/TUI**: local timestamp/signing adapter (`ADVISERS_TIMESTAMP_CMD`) and read-only `advisers tui --once`; plugin boundary and optional-sync contracts documented (no marketplace/sync implemented).
- **E9-T3 vault mode**: `vault seal --remove` / `unseal` / `status` encrypts the whole SQLite DB with AES-256-GCM+scrypt at rest (explicit opt-in, SHA256 verified; not transparent).
- **E7-T3 OCR adapter**: `advisers ocr <image>` + image attachments run a local executable from `ADVISERS_OCR_CMD` (no cloud OCR, 30s/200k limits); unset => fail closed; scanned PDF conversion not included.
- **P2 encrypted handoff**: `export --all --encrypted --out file` / `import file --replace` (AES-256-GCM + scrypt; passphrase via `ADVISERS_EXPORT_PASSPHRASE`, never stored); automatic at-rest DB encryption is still not implemented.
- **E2-T2**: `capture --from-imap` read-only IMAP client (EXAMINE + UID FETCH BODY.PEEK[]; no write commands), env credentials, app-password guidance.
- **E7 (partial)**: `deliver --format pdf` builds a Chinese PDF report via a system CJK font (`ADVISERS_PDF_FONT`); `office-read`/attachments read OFD text; OCR remains explicitly unsupported/fail-closed.
- Docs: `docs/REMINDERS.md`, `docs/SOURCE-SCHEMA.md`, `docs/CLI-JSON.md`, `docs/POSITIONING.md`, `docs/OFD-OCR.md`, `docs/PRICING-CHANNEL.md`.

### Fixed
- Agent no longer tries to backfill facts from earlier turns via `memory_propose` (whose quote must come from the current message); this fixes the continuity-50 8/9 regression. Re-run: 9/9. See `eval/results/continuity-50-round12-*.md`.
- `advisers audit` now calls `ensureHome()`/`ensureAuditKey()`, verifies fresh and
  recorded chains, and exits non-zero when the chain is broken.
- `capture` now records a real turn and stores `sessionId` + `turnId`; accepting
  dangling evidence fails closed; default matters are persisted; `capture --file`
  uses the attachment extractor (docx/xlsx/pptx/pdf) instead of raw UTF-8.
- `capture`/`chat` fail closed for `secrecy > 0` before model egress.

### Verified
- `pnpm -r test`: 232 tests, 0 fail (this preview adds E0/E1/E2/E3/JSON/MCP/UI tests).
- `pnpm -r build` and `pnpm -r typecheck` pass.
- Real-model smoke (2026-11-14): `.eml` import produced a pending candidate with
  verbatim quote; `capture --file note.docx` produced a pending candidate and
  persisted the default matter.

## 0.2.0-preview.58 (staged, approval pending)

### Fixed
- Relative-date resolver: `"当天"` is no longer interpreted as the message day.
  It usually refers to a previously mentioned event day; the deterministic pass
  now leaves a valid model dueAt untouched (gold review finding, gold-029) and a
  regression test was added.
- Gold runner retries one transient capture/model error before recording a case
  error, so a single provider timeout does not fail the corpus run.

### Added
- 150-case **user-authorized agent-reviewed** Chinese commitment corpus
  (`eval/corpus/gold/commitments.zh.gold.reviewed.jsonl`) with two independent
  agent review passes, adjudication, per-row `review_mode`/`reviewers`/
  `reviewed_at`/`review_note`, and the two review files under
  `eval/corpus/gold/reviews/`. This is explicitly **not** independent human gold.
- `eval/run-dogfood-5.mjs`: 5 synthetic personas × 3 tasks with cross-session
  continuity and cross-home isolation checks.
- Delivery sample pack `examples/delivery-2026-11-14/` (docx/xlsx/pptx + an
  edited contract) with `verify --content` and WPS real-consumer checks; the
  acceptance bar is tool-agnostic (the user clarified Microsoft Office is not
  required). See `eval/results/delivery-2026-11-14.md`.

### Verified (2026-11-14, deepseek-flash, single runs)
- Reviewed gold: quote 100%, firm recall 95.31% (122/128), due accuracy 97.84%
  (136/139), precision 97.13% (169/174), 0 auto-confirmed, exit 0.
- Dogfood: 15/15 tasks, 74/74 global isolation checks, exit 0.
- npm publish still blocked on human OTP (`npm stage approve` returns EOTP);
  `advisers@0.2.0-preview.58` is the staged artifact.
- Upstream DSH PR: not possible under current upstream policy (Issues/PRs
  disabled; CONTRIBUTING rejects external PRs) — see
  `eval/results/upstream-pr-2026-11-14.md`.

## 0.2.0-preview.57 (staged, approval pending)

### Fixed
- npm tarball was missing runtime files: `bin/advisers.js` statically imports
  `lib/capture.js`, `lib/doc-review.js` and `lib/research.js`, but the `files`
  allowlist did not include them, so a published CLI would have failed with
  `ERR_MODULE_NOT_FOUND`. `files` now ships the whole `lib/` directory, and
  `scripts/pack-smoke.mjs` walks the local import graph and fails when a packed
  tarball misses a reachable file (the old smoke only checked `bin/advisers.js`
  existed, which is why CI stayed green).
- `capture` gave the model a UTC timestamp while claiming `Asia/Shanghai`;
  messages sent 00:00–07:59 Beijing time showed the previous UTC date. The
  prompt now uses the Asia/Shanghai wall clock with weekday, and
  `lib/relative-date.js` resolves/corrects relative dates against the message
  time (今天/明天/周X/下周X/月底/季度末/年底/N天后/绝对日期), keeping the model's
  time-of-day when only the date was wrong.
- `research` compared numeric `Matter.secrecy` (`0|1|2|3`) to the string
  `'secret'`, so a protected matter was never blocked. Egress now fails closed
  for `secrecy > 0` until the levels are productized (`lib/egress.js` + test).

### Added
- `packages/advisers/lib/relative-date.js` and regression tests for the UTC
  boundary, same-day ambiguity, conflicting expressions and explicit dates.
- `scripts/check-docs.mjs` (version/docs consistency, wired into CI).
- `eval/run-capture-150.mjs`: per-case failures, rule-resolved date count, a
  >=95% due gate, and dual labels for the 9 same-weekday ambiguous cases so the
  old strict reading is still reported.
- `eval/run-continuity.mjs`: `FACTS=10|50|100|200`, deterministic fact/probe
  generation; `eval/run-agent-tasks.mjs`: 8 end-to-end agent tasks.
- `eval/run-office-real.mjs`: 20 realistic-synthetic Office documents
  (10 defect types × 2; docx/xlsx/pptx) with blocker review.
- `eval/run-capture-gold.mjs` + `eval/corpus/gold/`: 50→150 human-gold
  scaffolding, schema, and a 50-case **AI-prelabeled draft seed** (every row
  `pending_human_review: true`; **not** human gold).
- `docs/REMOTE-PARSE-PRIVACY.md`: design proposal for optional remote file
  parsing (not implemented).

### Verified (single runs, 2026-11-14)
- capture synthetic 150: recall 150/150, due 150/150 natural, 141/150 under the
  legacy ambiguous labels, 120 dates resolved by the rule pass, 0 auto-confirmed.
- continuity: `FACTS=50` 9/9, `FACTS=100` 10/10, `FACTS=200` 12/12 (see `eval/results/continuity-*.md`).
- agent tasks: 8/8 PASS (`eval/results/agent-tasks-2026-11-14.md`).
- Office realistic-synthetic review: v2 20/20 blocker; v1 (before two
  severity-ambiguous defects were strengthened) was 18/20. See
  `eval/results/office-real-2026-11-14.md`.
- Windows/WPS: CLI version/status/office/verify/template PASS; WPS Writer,
  Spreadsheet and Presentation opened/extracted the generated files. Microsoft
  Office is not installed on the test host, so this is WPS-only evidence. See
  `eval/results/windows-wps-2026-11-14.md`.

### Known limitations / not done
- The 150-case **human** gold set is not done; only a 50-case AI draft seed
  exists and it still needs human double review.
- The Office defect set is realistic synthetic, not real desensitized customer
  documents.
- Continuity has been run at 10/50/100/200 facts (see `eval/results/continuity-*.md`); each real-model soak is long and is recorded as a single run, not a nightly gate.
- No Microsoft Office validation; WPS only. No 5-user dogfood.
- npm is staged only, not published (OTP approval is a human step).
- remote file parse is a design document only.
- When `ADVISERS_API_KEY` is set, `chat`, `capture`, `review`, `brief --deep` and
  `learn review` send their inputs to the configured model API (documented in
  README); `research --web/--url` remains the only built-in **web** egress path.

## 0.2.0-preview.45 (unreleased)

### Added
- `advisers init` and `advisers doctor` (Node/SQLite/Office/policy/model checks).
- `advisers export --all`, `advisers backup <path>`, `advisers --version`.
- Example specs/templates under `examples/`.
- `docs/QUICKSTART.md` for Windows/PowerShell/BOM.
- Office read/edit/verify, Chinese minutes/notice templates, `office-read`/`office-edit`.
- Memory search, memory candidates, `advisers who`.

### Fixed
- Clean install: policy-strict core pin, frozen lockfile, CI build-before-typecheck.
- DSH bundle schema and dsh-tools/cordis compatibility.
- Office edit block alignment with tables; table grid preservation; refuse lossy xlsx/pptx edits.
- Memory search matter scope; purge redaction/VACUUM; undo workspace isolation.
- Case-insensitive path deny list; DSH workspace guard.
- Model timeout/retry/max_tokens; agent context budget; SQLite busy timeout.
- permit replay persisted; policy fail-closed; bridge crisis/permit audit.
- Docs claims aligned with current preview.

### Known issues
- npm preview is staged only; public `@next` is the old 0.1 stub until OTP approval.
- Windows/WPS open validation and 5-user dogfood pending.
- Office fidelity on real Word/WPS files still partial.
- Facts/preferences FTS not implemented (LIKE search).
