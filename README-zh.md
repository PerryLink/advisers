# Advisers（幕僚）

**一个本地优先、可审计、中文 Office 优先的单窗口工作秘书 runtime。**

> **AI 与合规提示** —— Advisers 是本地优先的工作助手，不是情感陪伴，也不提供法律、医疗、
> 金融等专业意见；AI 输出可能出错，使用前请自行核验。禁止用于违法、侵权、欺诈、骚扰、
> 伪造或未标识合成内容等用途；未成年人须经监护人同意。
> 使用前请阅读[服务条款](docs/TOS.md)（v2026.11.3）、[免责声明](docs/DISCLAIMER.md)、
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

**`0.3.0` 是 release candidate（2026-11-20），尚未发布。** 仓库版本锁步在 `0.3.0`；更早的 `0.2.4` 是**未发布的 release candidate**，已被 `0.3.0` 取代（`v0.2.4` tag 指向更早的 commit，npm 上没有 0.2.4 tarball，不要尝试安装它）。npm **`latest` = `next` = `0.2.3`**（2026-11-18 发布），`0.2.2`/`0.2.1`/`0.2.0` 仍可按版本号安装。6 个发布包为 `advisers`、`advisers-core`、`advisers-office`、`advisers-policy-strict`、`advisers-bridge-hermes`、`dsh-advisers`；两个私有 `advisers-link-*` 包保持同版本但不发布。

0.3.0 的主题是**可信交付**：证据可核（可解析或诚实标 missing/unverifiable）、数据能救（备份/恢复/审计锚点）、大账本可用（200k 行读路径）、发布可验（provenance）。它同时吸收 0.2.4 的 Windows durable-fsync 与逐 item secrecy/证据校验修复作为基线。发布候选树上的新增内容按主题记录在文档中，**不构成已发布声明**：[MCP 输出上限与协议协商](docs/MCP.md)、[200k 读 A/B 与写放大修复](docs/PERFORMANCE.md)、[只读账本门面](docs/LEDGER-READ-API.md)、[接口契约](docs/CONTRACTS.md)、[TUI 输出内核](docs/TUI.md)。0.2.3 已通过 743/743 测试、build/typecheck、打包冒烟、文档/许可/TOS/版本锁步检查、安全套件与故障注入套件（9/9）；其 registry tarball 由 `scripts/verify-release.mjs` 验证（86/86）。0.3.0 发布候选必须重跑这些门禁，并新增 `check-contracts`/`eval:det`/`check-sbom`——在 registry 显示 6 个 0.3.0 包 `dist.attestations` 非空之前，这些都还不是已发布事实。

> 需要 **Node >= 22.16**；Windows/PowerShell/BOM 说明见 [docs/QUICKSTART.md](docs/QUICKSTART.md)。

- matter（客户/项目）最小闭环：`matter add|ls|show|rename|archive|use`；7 天议程 `agenda` 与确定性晨报 `morning`（本地、不调模型）；确定性 `template quote|proposal`；
- SQLite 账本 `~/.advisers/state.db`（schema v21；0.3.0 增量加入客户/项目实体；只读命令走无锁只读快照，热点写命令走增量写）；
- turns + 会话摘要 + 中文可用 FTS 检索（FTS5 trigram 索引，schema v21；不足 3 字仍走 LIKE 回退）；开场协议；
- 承诺账 + `commit add/ls/done`、`tick`、`snooze`、nudge outcome；
- `/memory`、`/week`、`/digest`、`/diff`、`/undo`、`/learn review`；
- routine draft/approve/patch/curator + active routine index；
- DOCX/XLSX/PPTX/Mermaid/draw.io/XMind builder + 7 模板 + `office-read`/`office-edit`/`verify`；
- 附件 txt/md/docx/xlsx/pptx/pdf；图片/扫描件暂不支持；
- DSH bundle（5 工具）在 0.3.0 发布候选树上让三个账本读工具读取**真实本地账本（只读、TOS 门禁、clearance 0、不取 HOME 锁、不迁移、不写库）**，仅在无账本或门面不可用时回退到带标记的 preview（见 [docs/LEDGER-READ-API.md](docs/LEDGER-READ-API.md)）；该状态尚未发布。Email IMAP/draft、Feishu webhook、Hermes bridge 为可选适配器（目前 CLI 尚未把 email/Feishu 接成端到端入口）；
- 真实 IM/Windows Office 打开验证仍未完成。
- `research --web/--url` 是唯一内置的**网页**出网路径；设置 key 后 `chat`/`capture`/`review`/`brief --deep`/`learn review` 会把输入发给配置的模型 API；`status`/`office`/`template`/`verify`/`commit` 等纯本地命令不联网。research 对 `secrecy > 0` 的 matter 拒绝（fail closed）。
- 提醒：`remind` + `.ics`/VALARM 导出 + 可选的本地调度脚本；`.ics` 日历只读导入；
- 只读入口：`capture --from-mail` / `--from-transcript`（去重、全部候选需人工 accept、secret matter 拒绝）；
- 证据/交付：`evidence show`、`deliveries --pack`（manifest + SHA256SUMS + DOCX 回执）、`deliver --type ...`（DOCX/XLSX）；操作者手工录入的证据（`--quote`/`--evidence`）标记为**不可外部核验（unverifiable）而不是缺失**，回执包单独统计；
- **交付回执包 v1.1**：`deliveries --receipt [--out dir] [--ids ...] [--all] [--recipient ...]` 复制交付文件并记录每个文件的 SHA-256、生成环境、校验结果与收件人；`evidence verify <dir>` 离线校验（JSON，exit 0/1，不读 `~/.advisers`）。证据条目默认上限 2000（用 `--ids`/`--all` 控制）；旧 `deliveries --pack` 证据包保持兼容。见 `docs/DELIVERY-RECEIPT.md`。
- **提醒/日历接线（0.2.0）**：`commit add/edit --remind-offsets "-1d,-2h,+0d09:00"` 写入逐承诺 VALARM；`remind --deliver --notify` 增加可选 webhook 并把上次运行写入 `~/.advisers/scheduler/status.json`；`remind install|uninstall|status [--apply]` 默认只打印 dry-run 计划，加 `--apply` 才注册/移除 cron/schtasks；`today --calendar` 本地展开 RRULE（全天 / （循环）标注）。`today`、`capture`、`memory candidates`、`verify` 均有稳定 `--json`（`docs/CLI-JSON.md`）。
- 隐私/MCP/JSON：`privacy --prove`、`mcp --stdio`（7 工具 + 4 个只读 resources，单行 JSON-RPC 上限 1 MiB；候选写入仅 pending，审计行写失败即 fail-closed）、`ui`（本地只读视图）、`status/commit/who/deliveries/remind/evidence --json`。
- Pet Brief（只读脱敏投影，契约 v0.2：`schemaVersion: 2` + `displayPolicy`，默认 `private`；v0.1 brief 按 legacy 可读）：`pet-brief --json|--out|--check [--strict]|--print-schema|--display-policy public|private|none`；`secrecy >= 2` 全排除、confidence < 0.7 丢弃、5 分钟 TTL、每节 10 项上限；不调模型、不联网、不改账本；桌宠 UI/传输尚未接通。见 `docs/PET-BRIEF-PRODUCER.md`。

```sh
# 0.3.0 是 release candidate、尚未发布；仓库版本为 0.3.0。
# 从 checkout 运行（试用 0.3.0 发布候选的受支持方式）：
#   corepack pnpm install && corepack pnpm -r build
#   ADVISERS_OFFICE_LOCAL=1 node packages/advisers/bin/advisers.js status
# 从 npm 安装（稳定渠道 = 默认 `latest`，当前为 0.2.3；0.3.0 尚未发布）：
#   npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
# `next` 渠道当前也指向 0.2.3：
#   npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers soul init
advisers commit add "周五前发报价给王工" --quote "周五前发报价给王工" --due 2026-11-13T18:00:00+08:00
advisers tick
advisers memory
advisers digest day
advisers office docx spec.json out.docx
advisers verify out.docx
```

npm 标签：**`latest`** 是稳定渠道（当前为 `0.2.3`，2026-11-18 已发布）；**`next`** 是预发布/候选渠道（当前也指向 `0.2.3`）。`0.3.0` 是 **release candidate**，`0.2.4` 是它取代的**从未发布的 candidate**——两者都不能从 npm 安装；0.3.0 只有在 6 个包 `dist.attestations` 非空时才能声称 Trusted-Publishing provenance。需要可复现安装时请固定版本（当前 `advisers@0.2.3`），并直接查询官方 registry（`npm view advisers dist-tags --registry=https://registry.npmjs.org/`）——镜像可能滞后。

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
