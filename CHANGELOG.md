# Changelog

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
