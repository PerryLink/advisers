# Changelog

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
- continuity `FACTS=50`: see `eval/results/continuity-50-2026-11-14.md`.
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
- Continuity has been run at 10/50/100 facts; `FACTS=200` is scripted but not run (one real-model soak is ~1+ hour).
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
