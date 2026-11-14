# Windows / WPS real-machine validation — 2026-11-14

Host: Windows NT 10.0.26200, Node `v24.22.1`, WPS Office `12.1.0.29680`.
Method: independent Windows copy of the CLI + Windows-side `npm install` for
runtime deps (the WSL/pnpm symlinked `node_modules` cannot be resolved by
Windows Node), then PowerShell 5.1 COM automation. Temp `ADVISERS_HOME`, no API
key, no model calls.

## Important scoping fact

Microsoft Office is **not installed** on this host. The `Word.Application`,
`Excel.Application` and `PowerPoint.Application` ProgIDs are registered by WPS
(`Path` points to `...\Kingsoft\WPS Office\12.1.0.29680\office6`; `Name` is the
Office-compatible string). So this run validates the **WPS compatibility
layer**, not Microsoft Office. Do not claim MS Office compatibility from it.

## CLI on Windows

| Check | Result |
|---|---|
| `advisers --version` | PASS (`0.2.0-preview.57`) |
| `advisers status` (SQLite store, temp home) | PASS |
| `advisers office docx spec.json out-win.docx` | PASS (9,713 bytes) |
| `advisers verify out-win.docx` | PASS (`"ok": true`, 17 entries) |
| `advisers template weekly weekly-data.json out-template.docx` | PASS |
| `advisers verify out-template.docx` | PASS (`"ok": true`) |

## WPS open/extract checks (COM automation)

| App | File | Result |
|---|---|---|
| WPS Writer (`KWPS`) | generated `weekly.docx` | PASS (text length 44, contains 报价/137) |
| WPS Writer | CLI `out-win.docx` | PASS (text contains 真机) |
| WPS Writer | template `out-template.docx` | PASS (text contains `2026-W46`) |
| WPS Spreadsheet (`KET`) | generated `budget.xlsx` | PASS (cells 项目/差旅/80) |
| WPS Presentation (`KWPP`) | generated `deck.pptx` | PASS, 3 slides (needs `Visible=true` on WPS 12; headless open returns E_FAIL) |

## Notes / caveats

- Chinese literals inside a PowerShell 5.1 `.ps1` are mis-decoded unless the
  script is saved as UTF-8 **with BOM**; that produced false failures on the
  first run and is a test-harness issue, not a CLI issue. The CLI itself read the
  UTF-8 JSON/spec and Chinese content correctly.
- One transient `RPC failed (0x800706BE)` opening the first Word document;
  retry passed. WPS COM is not as deterministic as a real Office install.
- WPS Presentation does not expose `Slides.Item(1).Shapes.Title` text in this
  automated open (titleLen=0), but slide count and successful open were
  verified.
- Not verified: Microsoft Office; WPS GUI visual fidelity; macros/forms; password
  protected files; scanned PDFs/OCR; printing/PDF export.

## Microsoft Office installation check (2026-11-14)

- `/Program Files/Microsoft Office` and `/Program Files (x86)/Microsoft Office`
  contain only an `Office` folder; no `WINWORD.EXE` / `EXCEL.EXE` /
  `POWERPNT.EXE` were found (searched to depth 6).
- The Windows uninstall registry has no Office/Word/Excel/PowerPoint product
  entries.
- `Word.Application` / `Excel.Application` / `PowerPoint.Application` ProgIDs all
  resolve to `...\Kingsoft\WPS Office\12.1.0.29680\office6`, i.e. WPS's
  Office-compatible automation layer.
- LibreOffice is not installed either.
- Conclusion: **Microsoft Office cannot be validated on this host** (not
  installed; installing it needs a license/admin action). The WPS evidence above
  is the maximum honest claim.
