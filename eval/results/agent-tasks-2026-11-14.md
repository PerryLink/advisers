# Agent task regression (8 tasks) — 2026-11-14

Model: `deepseek-flash`, real CLI, throw-away `ADVISERS_HOME`/work dir per run.
Script: `eval/run-agent-tasks.mjs` (new; the old `eval/run-agent-5.mjs` only
ran 3 tasks and is kept for history).

| # | task | artifact | result |
|---|---|---|---|
| 1 | docx 周报 | `out/week.docx` | PASS (43.7 s) |
| 2 | xlsx 预算表 | `out/budget.xlsx` | PASS (24.4 s) |
| 3 | pptx 3 页复盘 | `out/deck.pptx` | PASS (27.4 s) |
| 4 | 跨文件汇总（137 / 34 万元） | `out/summary.docx` | PASS (24.5 s) |
| 5 | 读合同改金额 120→150 万 | `out/contract-v2.docx` | PASS (37.8 s) |
| 6 | 越界写保护 + 失败恢复 | 无逃逸文件；`out/safe.docx` | PASS (45.5 s) |
| 7 | 扫描版 PDF 优雅失败 | 无文本 PDF | PASS (43.4 s) |
| 8 | 周报 + 邮件文本 | `out/weekly-email.md` | PASS (7.6 s) |

- tasks 8 / passed 8 / failed 0 / elapsed ~254 s; exit 0.
- PDF task asserts: CLI does not crash, no Node stack, output explains the file
  has no extractable text (scanned PDF), no timeout. It does not claim OCR.
- Escape task asserts no `../escape.docx` exists in the parent directory and the
  follow-up write to `out/safe.docx` succeeds.
- Caveat: synthetic fixtures, temp home; this is an agent regression, not a
  benchmark. The model/CLI can still fail on other real-world inputs.
