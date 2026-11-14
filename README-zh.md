# Advisers（幕僚）

**一个本地优先、可审计、中文 Office 优先的单窗口工作秘书 runtime。**

Advisers 不是聊天框，也不是情感陪伴。它维护三本账：

- **用户账**：你是谁、偏好、边界、证据；
- **承诺账**：谁欠谁、何时到期、外部完成证据；
- **流程账**：这类事怎么做，以 draft/patch 形式可审阅。

核心基于 [cordis](https://github.com/cordiverse/cordis)。CLI 是主产品；DSH 是薄适配器，目前只提供 `advisers_brief` + `advisers_office`，不是功能完整的第二产品。

## 状态

`advisers@0.2.0-preview.57`（core `advisers-core@0.2.0-preview.22`）已 staged（待 OTP 批准；npm `next` 仍是旧的 0.1 preview，批准前不要用它评估）：

> 需要 **Node >= 22.13**；Windows/PowerShell/BOM 说明见 [docs/QUICKSTART.md](docs/QUICKSTART.md)。

- SQLite 账本 `~/.advisers/state.db`；
- turns + 会话摘要 + FTS 检索；开场协议；
- 承诺账 + `commit add/ls/done`、`tick`、`snooze`、nudge outcome；
- `/memory`、`/week`、`/digest`、`/diff`、`/undo`、`/learn review`；
- routine draft/approve/patch/curator + active routine index；
- DOCX/XLSX/PPTX/Mermaid/draw.io/XMind builder + 7 模板 + `office-read`/`office-edit`/`verify`；
- 附件 txt/md/docx/xlsx/pptx/pdf；图片/扫描件暂不支持；
- DSH bundle、Email IMAP/draft、Feishu webhook、Hermes bridge 为可选适配器；
- 真实 IM/Windows Office 打开验证仍未完成。
- `research --web/--url` 是唯一内置的**网页**出网路径；设置 key 后 `chat`/`capture`/`review`/`brief --deep`/`learn review` 会把输入发给配置的模型 API；`status`/`office`/`template`/`verify`/`commit` 等纯本地命令不联网。research 对 `secrecy > 0` 的 matter 拒绝（fail closed）。

```sh
# 当前 preview 只 staged，等 OTP；公开 @next 还是旧 0.1 stub。
# 从 checkout 跑：
#   corepack pnpm install && corepack pnpm -r build
#   ADVISERS_OFFICE_LOCAL=1 node packages/advisers/bin/advisers.js status
# 批准后：
npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers soul init
advisers commit add "周五前发报价给王工" --quote "周五前发报价给王工" --due 2026-11-13T18:00:00+08:00
advisers tick
advisers memory
advisers digest day
advisers office docx spec.json out.docx
advisers verify out.docx
```

在预览版转正前，`latest` 仍是占位版 `0.0.4`。

## 许可

MIT。
