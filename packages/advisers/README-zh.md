# advisers（顾问团）

**Advisers** 的 cordis-only 发行：一个连续对话 + 用户账 + 承诺账 + 可审阅的流程账。

## 安装

```sh
# 当前 preview 只 staged，等 OTP；批准后：
npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers soul init
advisers brief "做一份 Q4 预算 Excel，周五前给老板"
advisers chat "周五前把报价发给王工"
advisers office xlsx spec.json out.xlsx
advisers ls
advisers export
```

CLI 是**本地秘书运行时**：一个 REPL、用户账/承诺账/流程账、Office 产物，以及可选的模型回路。没有 API key 也能记录、检索、计划、生成文件，并运行承诺/摘要命令。

## 状态

`0.2.0-preview.64` 是预览版：

- SQLite 账本 `~/.advisers/state.db`（JSON fallback）；
- soul 位于 `~/.advisers/soul.md`，人类独占；
- turns + 摘要 + FTS 检索；开场协议；`/resume`；
- 承诺账 + `commit add/ls/done`、`tick`、`snooze`、nudge outcome；
- `/memory`、`/week`、`/digest`、`/diff`、`/undo`、`/learn review`；
- routine draft/approve/patch/curator + active routine index + `routine_view`；
- `advisers-office` 提供 DOCX/XLSX/PPTX/Mermaid/draw.io/XMind builder 与 5 个模板；
- 真实 IM/Office 打开验证仍未完成。

核心与架构：

https://github.com/PerryLink/advisers

## 许可

MIT。
