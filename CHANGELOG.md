# Changelog

## 0.2.0-preview.61 (staged, approval pending)

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
- **E7 (partial)**: `deliver --format pdf` builds a Chinese PDF report via a system CJK font (`ADVISERS_PDF_FONT`); no OFD/OCR yet.
- Docs: `docs/REMINDERS.md`, `docs/SOURCE-SCHEMA.md`, `docs/CLI-JSON.md`, `docs/POSITIONING.md`.

### Fixed
- `advisers audit` now calls `ensureHome()`/`ensureAuditKey()`, verifies fresh and
  recorded chains, and exits non-zero when the chain is broken.
- `capture` now records a real turn and stores `sessionId` + `turnId`; accepting
  dangling evidence fails closed; default matters are persisted; `capture --file`
  uses the attachment extractor (docx/xlsx/pptx/pdf) instead of raw UTF-8.
- `capture`/`chat` fail closed for `secrecy > 0` before model egress.

### Verified
- `pnpm -r test`: 221 tests, 0 fail (this preview adds E0/E1/E2/E3/JSON/MCP/UI tests).
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
