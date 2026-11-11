# Advisers（顾问团）

**一组 AI 顾问 —— 基于 cordis 的个人秘书 runtime。**

Advisers 不是又一个聊天框。它是一组专科顾问（记忆、承诺、流程），共享同一个连续对话，并维护三本账：

- **用户账**：你是谁、偏好、边界、证据；
- **承诺账**：谁欠谁、何时到期、外部完成证据；
- **流程账**：这类事在这里怎么做，以 diff 形式可审阅。

核心基于 [cordis](https://github.com/cordiverse/cordis)。两个发行共享同一套核心：

| 包 | 角色 |
|---|---|
| `advisers` | 仅 cordis 的 runtime + CLI（不依赖 DSH） |
| `dsh-advisers` | DeepSeek Harness 发行（挂载同一套核心） |

IM 是 **Link SPI**，不是硬依赖。Email、Satori/Koishi、`dsh-im`、OpenClaw、Hermes gateway 都是可选的 link provider；核心永远不 import 它们。

## 状态

`0.1.0-preview.3` 在 npm `next` tag：

- `advisers` CLI：`soul init`、`brief`、`chat`、`office`、`ls`、`why`、`forget`、`export`；
- soul 位于 `~/.advisers/soul.md`（人类独占，slot #1）；
- JSON 账本位于 `~/.advisers/state.json`；
- `advisers-office` 提供 DOCX/XLSX/PPTX/Mermaid/draw.io builder；
- 不调模型、不用 SQLite、不接真实 IM、不含 DSH bundle。

```sh
npm i -g advisers@next advisers-office@next
advisers soul init
advisers brief "做一份 Q4 预算 Excel，周五前给老板"
advisers chat "周五前把报价发给王工"
```

在预览版转正前，`latest` 仍是占位版 `0.0.3`。

## 许可

MIT。
