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

启动阶段。npm 名字 `advisers` 与 `dsh-advisers` 已占位；runtime 骨架正在本仓实现。

## 许可

MIT。
