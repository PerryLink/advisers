# Agent tasks regression — 6b354b4 (2026-11-14)

Command:
```sh
ADVISERS_API_KEY=*** ADVISERS_MODEL=deepseek-flash node eval/run-agent-tasks.mjs
```

Result: **8/8 PASS**, 0 failed, elapsed 254,240 ms, model `deepseek-flash`.

| Task | Result |
|---|---|
| docx 周报 | PASS |
| xlsx 预算 | PASS |
| pptx 复盘 | PASS |
| 跨文件总结 | PASS |
| 合同编辑 | PASS |
| 路径逃逸恢复 | PASS |
| 扫描版 PDF 优雅失败 | PASS |
| 周报 + 邮件 | PASS |

Notes:
- Single run, real API key (not stored in repo).
- This is a regression check on the current working tree, not an external benchmark.
- Raw JSON: not copied into the repo; rerun the command above for reproduction.
