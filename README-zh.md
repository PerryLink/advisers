# Advisers（幕僚）

**一个本地优先、可审计、中文 Office 优先的单窗口工作秘书 runtime。**

> **AI 与合规提示** —— Advisers 是本地优先的工作助手，不是情感陪伴，也不提供法律、医疗、
> 金融等专业意见；AI 输出可能出错，使用前请自行核验。禁止用于违法、侵权、欺诈、骚扰、
> 伪造或未标识合成内容等用途；未成年人须经监护人同意。
> 使用前请阅读[服务条款](docs/TOS.md)（v2026.11.2）、[免责声明](docs/DISCLAIMER.md)、
> [安全与内容审核说明](docs/SAFETY.md) 与[隐私与数据流说明](docs/PRIVACY.md)；
> 许可拆分见 [LICENSING.md](LICENSING.md)。

> **非商业 source-available** —— Advisers **不是开源项目**。软件采用 PolyForm
> Noncommercial License 1.0.0（仅限非商业用途，且须“不预期产生商业应用”），文档/数据/设计
> 采用 CC BY-NC-SA 4.0。商业使用（包括为付费客户做交付）须另行取得书面商业授权（在
> <https://github.com/PerryLink/advisers/issues> 提出，标题前缀 `commercial-license`）。
> 本地数据库**默认不加密**；完整出网清单（默认模型服务商为 DeepSeek）与删除边界见
> [隐私与数据流说明](docs/PRIVACY.md)。

Advisers 不是聊天框，也不是情感陪伴。它维护三本账：

- **用户账**：你是谁、偏好、边界、证据；
- **承诺账**：谁欠谁、何时到期、外部完成证据；
- **流程账**：这类事怎么做，以 draft/patch 形式可审阅。

核心独立运行（不依赖 cordis）；DSH 是薄的 cordis 兼容宿主适配器，提供五个工具（`advisers_brief`、`advisers_office`、`advisers_today`、`advisers_who`、`advisers_evidence`），不是功能完整的第二产品。

## 状态

`0.2.0` 是 2026-11-17 的**当前稳定版**：8 个 workspace 包统一为 `0.2.0`。其中 6 个发布包为 `advisers`、`advisers-core`、`advisers-office`、`advisers-policy-strict`、`advisers-bridge-hermes`、`dsh-advisers`；两个私有 `advisers-link-*` 包保持同版本但不发布。六包均已发布到 npm **`latest` = `0.2.0`**（账号所有者本人于 2026-11-17 完成 OTP 批准）；registry tarball、许可文件与全新 prefix 安装已用 `scripts/verify-release.mjs` 验证（80/80，含安装 smoke）。

> 需要 **Node >= 22.16**；Windows/PowerShell/BOM 说明见 [docs/QUICKSTART.md](docs/QUICKSTART.md)。

- SQLite 账本 `~/.advisers/state.db`；
- turns + 会话摘要 + FTS 检索；开场协议；
- 承诺账 + `commit add/ls/done`、`tick`、`snooze`、nudge outcome；
- `/memory`、`/week`、`/digest`、`/diff`、`/undo`、`/learn review`；
- routine draft/approve/patch/curator + active routine index；
- DOCX/XLSX/PPTX/Mermaid/draw.io/XMind builder + 7 模板 + `office-read`/`office-edit`/`verify`；
- 附件 txt/md/docx/xlsx/pptx/pdf；图片/扫描件暂不支持；
- DSH bundle、Email IMAP/draft、Feishu webhook、Hermes bridge 为可选适配器（目前 CLI 尚未把 email/Feishu 接成端到端入口）；
- 真实 IM/Windows Office 打开验证仍未完成。
- `research --web/--url` 是唯一内置的**网页**出网路径；设置 key 后 `chat`/`capture`/`review`/`brief --deep`/`learn review` 会把输入发给配置的模型 API；`status`/`office`/`template`/`verify`/`commit` 等纯本地命令不联网。research 对 `secrecy > 0` 的 matter 拒绝（fail closed）。
- 提醒：`remind` + `.ics`/VALARM 导出 + 可选的本地调度脚本；`.ics` 日历只读导入；
- 只读入口：`capture --from-mail` / `--from-transcript`（去重、全部候选需人工 accept、secret matter 拒绝）；
- 证据/交付：`evidence show`、`deliveries --pack`（manifest + SHA256SUMS + DOCX 回执）、`deliver --type ...`（DOCX/XLSX）；
- **交付回执包 v1.1**：`deliveries --receipt [--out dir] [--ids ...] [--all] [--recipient ...]` 复制交付文件并记录每个文件的 SHA-256、生成环境、校验结果与收件人；`evidence verify <dir>` 离线校验（JSON，exit 0/1，不读 `~/.advisers`）。证据条目默认上限 2000（用 `--ids`/`--all` 控制）；旧 `deliveries --pack` 证据包保持兼容。见 `docs/DELIVERY-RECEIPT.md`。
- **提醒/日历接线（0.2.0）**：`commit add/edit --remind-offsets "-1d,-2h,+0d09:00"` 写入逐承诺 VALARM；`remind --deliver --notify` 增加可选 webhook 并把上次运行写入 `~/.advisers/scheduler/status.json`；`remind install|uninstall|status [--apply]` 默认只打印 dry-run 计划，加 `--apply` 才注册/移除 cron/schtasks；`today --calendar` 本地展开 RRULE（全天 / （循环）标注）。`today`、`capture`、`memory candidates`、`verify` 均有稳定 `--json`（`docs/CLI-JSON.md`）。
- 隐私/MCP/JSON：`privacy --prove`、`mcp --stdio`（7 工具 + 4 个只读 resources，单行 JSON-RPC 上限 1 MiB；候选写入仅 pending，审计行写失败即 fail-closed）、`ui`（本地只读视图）、`status/commit/who/deliveries/remind/evidence --json`。
- Pet Brief（只读脱敏投影，契约 v0.2：`schemaVersion: 2` + `displayPolicy`，默认 `private`；v0.1 brief 按 legacy 可读）：`pet-brief --json|--out|--check [--strict]|--print-schema|--display-policy public|private|none`；`secrecy >= 2` 全排除、confidence < 0.7 丢弃、5 分钟 TTL、每节 10 项上限；不调模型、不联网、不改账本；桌宠 UI/传输尚未接通。见 `docs/PET-BRIEF-PRODUCER.md`。

```sh
# 0.2.0 已发布到 npm @latest；也可从 checkout 运行：
# 从 checkout 跑：
#   corepack pnpm install && corepack pnpm -r build
#   ADVISERS_OFFICE_LOCAL=1 node packages/advisers/bin/advisers.js status
# 从 npm 安装（稳定渠道 = 默认 `latest`，现为 0.2.0）：
#   npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
# preview/RC 构建使用 `next` 渠道（发布后 `next` 也指向 0.2.0）：
#   npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers soul init
advisers commit add "周五前发报价给王工" --quote "周五前发报价给王工" --due 2026-11-13T18:00:00+08:00
advisers tick
advisers memory
advisers digest day
advisers office docx spec.json out.docx
advisers verify out.docx
```

npm 标签：**`latest`** 是稳定渠道（现为 `0.2.0`）；**`next`** 是预发布/候选渠道。需要可复现安装时请固定版本（`advisers@0.2.0`），并直接查询官方 registry（`npm view advisers dist-tags --registry=https://registry.npmjs.org/`）——镜像可能滞后。需要可复现安装时请固定版本（`advisers@0.2.0`），并直接查询官方 registry（`npm view advisers dist-tags --registry=https://registry.npmjs.org/`）——镜像可能滞后。

## 许可

Advisers 是**源码可见、非开源（source-available）**项目。自 `0.2.0` 起采用双许可模型（均不追溯）：

- **软件**（`packages/**`、`scripts/**`、`.github/**`、各包 manifest，以及 npm tarball 内的
  README/NOTICE/THIRD-PARTY-NOTICES）：
  [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)
  （SPDX：`PolyForm-Noncommercial-1.0.0`），仅限非商业用途；营利机构的使用需另行取得商业授权。
- **文档 / 数据 / 设计**（根文档、`docs/**`、`eval/**`、`examples/**`、`templates/**`）：
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)（SPDX：`CC-BY-NC-SA-4.0`），
  须署名、非商业使用、相同方式共享。

历史版本保留原许可：MIT 版本仍为 MIT，0.2.0 之前以 Apache-2.0 发布的版本（至 2026-11-17 的 preview）仍为 Apache-2.0。
完整策略、Required Notice 与商业授权渠道见 [LICENSE](LICENSE)、[LICENSE-DOCS](LICENSE-DOCS)、
[NOTICE](NOTICE) 与 [LICENSING.md](LICENSING.md)。
