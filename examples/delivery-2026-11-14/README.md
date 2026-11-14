# Delivery sample — 2026-11-14

Five generated/edited files produced by the `advisers` CLI (no model key needed;
`ADVISERS_OFFICE_LOCAL=1`). They are committed as small format examples of what
the Office pipeline delivers. Verification is tool-agnostic: the acceptance bar
is that each file opens/parses in a real consumer (WPS Writer/Spreadsheet/
Presentation here; Microsoft Office is not required).

| file | how it was produced | checks |
|---|---|---|
| `weekly-report.docx` | `advisers template weekly examples/templates/weekly.json ...` | `verify --content` structure+content ok; WPS Writer opens |
| `q4-budget.xlsx` | `advisers office xlsx spec.json ...` | verify ok; WPS Spreadsheet reads 项目/差旅 |
| `q4-review.pptx` | `advisers office pptx spec.json ...` | verify ok; WPS Presentation opens (4 slides) |
| `contract-v1.docx` | `advisers office docx spec.json ...` | verify ok; WPS Writer opens |
| `contract-v2.docx` | `advisers office-edit contract-v1.docx ops.json ...` | `p6: 合同金额：120 万元 -> 150 万元`; verify ok; WPS Writer opens |

Hashes and full evidence: `eval/results/delivery-2026-11-14.md`.
