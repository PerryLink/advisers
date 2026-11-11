# advisers（顾问团）

**Advisers** 的 cordis-only 发行：一个连续对话 + 用户账 + 承诺账 + 可审阅的流程账。

## 安装

```sh
npm i -g advisers@next advisers-office@next
advisers soul init
advisers brief "做一份 Q4 预算 Excel，周五前给老板"
advisers chat "周五前把报价发给王工"
advisers office xlsx spec.json out.xlsx
advisers ls
advisers export
```

CLI 目前是**context 预览**，不是聊天 UI：它记录消息、生成 FocusFrame，并打印将要发给模型的上下文。模型调用是下一个里程碑。

## 状态

`0.1.0-preview.3` 是预览版：

- 内存/JSON 账本，位于 `~/.advisers/state.json`；
- soul 位于 `~/.advisers/soul.md`，人类独占；
- 命令：`soul`、`brief`、`chat`、`office`、`ls`、`why`、`forget`、`export`；
- IntentBrief + 澄清策略 + readback；
- `advisers-office` 提供 DOCX/XLSX/PPTX/Mermaid/draw.io builder；
- 不调模型、不用 SQLite、不接真实 IM、不含 DSH bundle。

核心与架构：

https://github.com/PerryLink/advisers

## 许可

MIT。
