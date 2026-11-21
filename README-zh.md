# Advisers（幕僚）

**一个本地优先、可审计、中文 Office 优先的单窗口工作秘书 runtime。**

> **AI 与合规提示** —— Advisers 是本地优先的工作助手，不是情感陪伴，也不提供法律、医疗、
> 金融等专业意见；AI 输出可能出错，使用前请自行核验。禁止用于违法、侵权、欺诈、骚扰、
> 伪造或未标识合成内容等用途；未成年人须经监护人同意。
> 使用前请阅读[服务条款](docs/TOS.md)（v2026.11.4）、[免责声明](docs/DISCLAIMER.md)、
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

核心独立运行（不依赖 cordis）；DSH 是薄的 cordis 兼容宿主适配器，提供六个工具（`advisers_brief`、`advisers_office`、`advisers_today`、`advisers_who`、`advisers_evidence`、`advisers_clients`），不是功能完整的第二产品。

## 状态

**`0.4.1` 已于 2026-11-21 发布**，当前 npm **`latest`** 为 `0.4.1`，**`next`** 也随本次发布推进到 `0.4.1`。仓库版本锁步在 `0.4.1`。`0.4.1` 是紧随 0.4.0 的当日补丁（不是新的功能线）：新增 KB/邮件审查链接（`kb link/unlink`、`mail link/dismiss`）、`remind --deliver --notify` 的运行时安静时段 + 按本地日去重 + `--force-notify`、`kb`/`mail`/`policy` 三组确定性评测（30 cases / 277 checks）、38 个 documented-additive CLI 命令（90 checks 契约门禁），以及真实 Windows 11 25H2 手工 smoke（29/29 断言）。0.4.0 的功能面不变：本地知识库（schema v22）、TLS-only IMAP 邮件入口、交互式壳、可解释的主动式晨报、Policy/Evidence 2.0 子集、回款/对账与客户状态包 v2、MCP modern dual-era、Windows CI 与便携 ZIP，以及 v2026.11.4 法务修订。默认仍然本地：所有新命令都不需要模型调用，也没有后台常驻进程，`mail sync` 是唯一新增的显式网络路径（TLS-only、只读、用户主动触发）。**schema v22 是单向迁移**：升级前 CLI 会写 `state.db.before-migrate-v*` 备份，0.3.2 打开 v22 数据库会报 `E_SCHEMA_NEWER`，降级需要恢复该备份。`0.4.0`/`0.3.2`/`0.3.1`/`0.3.0` 仍可按版本号安装但已被取代，请使用 `0.4.1`。更早的 `0.2.4` 是**未发布的 release candidate**，已被 0.3.0 线取代（`v0.2.4` tag 指向更早的 commit，npm 上没有 0.2.4 tarball，不要尝试安装它）。6 个发布包为 `advisers`、`advisers-core`、`advisers-office`、`advisers-policy-strict`、`advisers-bridge-hermes`、`dsh-advisers`；两个私有 `advisers-link-*` 包保持同版本但不发布。`0.4.1` tarball 由 GitHub Actions OIDC/Trusted Publishing 发布（不依赖长期 npm token），带 SLSA provenance（`https://slsa.dev/provenance/v1`），且 provenance 记录的是发布 tag ref 而不是分支。Release notes：<https://github.com/PerryLink/advisers/releases/tag/v0.4.1>（该 Release 同时附 CycloneDX SBOM 与 6 个 tarball 的 `SHA256SUMS`）。可自行验证：

```sh
npm view advisers@0.4.1 dist.attestations --json --registry=https://registry.npmjs.org/
corepack pnpm install && corepack pnpm run sbom   # 生成 artifacts/sbom.cdx.json（gitignored）
node scripts/verify-release.mjs --version 0.4.1 --tag latest \
  --sbom artifacts/sbom.cdx.json --require-sbom
```

0.4.1 建立在「可信交付」线（0.3.0：证据可核或诚实标注 missing/unverifiable、数据能救、200k 行账本可用、provenance 可验）与 0.3.2 客户/性能收尾之上。0.4 的新增内容按主题记录在文档中：[Windows 支持矩阵](docs/WINDOWS.md)、[MCP 输出上限与协议协商](docs/MCP.md)、[200k 读 A/B 与写放大修复](docs/PERFORMANCE.md)、[只读账本门面](docs/LEDGER-READ-API.md)、[接口契约](docs/CONTRACTS.md)、[TUI 输出内核](docs/TUI.md) 与 [发布清单](docs/RELEASING.md)。每个版本记录自己的 `verify-release` check 数，不沿用旧版本数字。

> 需要 **Node >= 22.16**；Windows/PowerShell/BOM 说明见 [docs/QUICKSTART.md](docs/QUICKSTART.md)。

- matter（客户/项目）最小闭环：`matter add|ls|show|rename|archive|use`；7 天议程 `agenda` 与确定性晨报 `morning`（本地、不调模型）；确定性 `template quote|proposal`；
- SQLite 账本 `~/.advisers/state.db`（schema v22 —— 0.4.0 一次迁移加入 KB/邮件/回款对象；只读命令走无锁只读快照，热点写命令走增量写）；
- turns + 会话摘要 + 中文可用 FTS 检索（FTS5 trigram 索引，schema v22；不足 3 字仍走 LIKE 回退）；开场协议；
- 承诺账 + `commit add/ls/done`、`tick`、`snooze`、nudge outcome；
- `/memory`、`/week`、`/digest`、`/diff`、`/undo`、`/learn review`；
- routine draft/approve/patch/curator + active routine index；
- DOCX/XLSX/PPTX/Mermaid/draw.io/XMind builder + 7 模板 + `office-read`/`office-edit`/`verify`；
- 附件 txt/md/docx/xlsx/pptx/pdf；图片/扫描件暂不支持；
- DSH bundle（6 工具，含 `advisers_clients`）在 0.3.0 中让三个账本读工具读取**真实本地账本（只读、TOS 门禁、clearance 0、不取 HOME 锁、不迁移、不写库）**，仅在无账本或门面不可用时回退到带标记的 preview（见 [docs/LEDGER-READ-API.md](docs/LEDGER-READ-API.md)）。Email IMAP/draft、Feishu webhook、Hermes bridge 为可选适配器（目前 CLI 尚未把 email/Feishu 接成端到端入口；0.4.0 的内置 `mail sync` 是独立的只读邮件入口，不依赖该 link 包）；
- 真实 IM/Windows Office 打开验证仍未完成。
- **0.4.0 知识库**：`kb add|ls|show|rm|purge|reindex|link` 把本地文件抽成文本 + chunks（不复制原文件）写入 schema v22；`search --scope turns|kb|pages|facts|all` 默认仍为 turns；确定性编译页（`kb page ls|show|rebuild|diff`：客户/项目 dossier、matter 时间线、事实页）带 source refs 与 stale 检测；`fact show|history|as-of` 只读时间旅行。无模型、无 embedding、无网络；1–2 字中文查询走降级 LIKE 兜底而不是静默 0 命中；
- **0.4.0 邮件入口**：`mail account add|ls|show|test|remove`、`mail sync`（TLS-only、只读 IMAP、UIDVALIDITY/UID 游标）、`mail ls|show`、`mail extract`（本地规则、仅 pending 候选）、`mail link|dismiss|purge` 与 `.eml` 导入；凭据存 `0600` 文件（不进 DB/argv/日志），正文默认保留 30 天，`mail sync` 是唯一新增网络路径；
- **0.4.0 交互壳**：`advisers` REPL 增加补全、确认、有限队列、内存历史、粘贴保护、Ctrl+C/Esc 处理与整行净化；非 TTY 仍是 plain/一次性行为，`tui --once/--json` 逐字节不变；
- **0.4.0 主动式**：确定性 `urgency` v1（`terms`/`whyNow`/`modelVersion`）、`morning` 晨报归档、跨版本可读的 v2 scheduler plan/status、可选提醒 webhook 的 Standard Webhooks HMAC 签名（payload 字节不变；quiet hours 默认关、可覆盖）；
- **0.4.0 Policy/Evidence 子集**：纯策略决策引擎、一次性 decision token（digest 校验执行）、egress 注册表、独立的 TOS/模型出网同意存储（`consent.json`，0600 原子写），以及四态 evidence resolver + `mail`/`kb_chunk`/`kb_page` 来源（邮件/KB 引用不再误报 missing）；回执包 v2 记录 `verificationBasis`；
- **0.4.0 回款**：`receivable add|ls|show|edit|void` + `payment add|ls|void`（整数分、CNY/USD/EUR/HKD、部分/多笔/超额/void、同事务自动完成承诺）、逐币种合计（open/overdue/paid）与账龄桶；`client export --pack` 输出 manifest + `SHA256SUMS` 客户状态包并附离线校验器。金额不进回执包、客户状态包、MCP、DSH 与 Pet Brief；
- **0.4.0 MCP modern dual-era**：`server/discover`、显式 modern 方法 allowlist、`resultType`/`ttlMs`/`cacheScope` envelope；legacy 响应逐字节不变，`ADVISERS_MCP_MODERN=off` 可一键回退；工具面仍 8 tools / 5 resources，DSH 仍 6 tools；
- **0.4.0 Windows**：`windows-full` CI（Node 24/22.16 矩阵）与便携 ZIP 构建/校验脚本；npm 仍是正式渠道，`docs/WINDOWS.md` 把支持范围限定为 Win11 25H2/26H2 x64，真机全量记录仍属发布清单项；
- **0.4.0 法务**：TOS/PRIVACY/SAFETY/DISCLAIMER 升级到 **v2026.11.4**，新增数据面（邮件正文/凭据、KB 文本与页、回款记录、壳与晨报归档）与独立的模型出网同意均已披露，门控命令会重新确认修订后的条款；
- **0.4.1 收尾**：`kb link/unlink` 与 `mail link/dismiss` 把 KB/邮件引用变成显式、可审计的审查决定（未知 id 失败关闭）；`remind --deliver --notify` 增加运行时 `--quiet-hours HH:MM-HH:MM`（跨午夜；只抑制通知通道，本地日志行始终写入）、按本地日去重（通知去重元数据本地保留 30 天）与 `--force-notify`；确定性评测新增 `kb`/`mail`/`policy` 三组（30 cases / 277 checks），CLI 契约新增 38 个 documented-additive 命令 / 76 个向量（90 checks 门禁）。
- `research --web/--url` 是唯一内置的**网页**出网路径；设置 key 后 `chat`/`capture`/`review`/`brief --deep`/`learn review` 会把输入发给配置的模型 API；`status`/`office`/`template`/`verify`/`commit` 等纯本地命令不联网。research 对 `secrecy > 0` 的 matter 拒绝（fail closed）。
- 提醒：`remind` + `.ics`/VALARM 导出 + 可选的本地调度脚本；`.ics` 日历只读导入；
- 只读入口：`capture --from-mail` / `--from-transcript`（去重、全部候选需人工 accept、secret matter 拒绝）；
- 证据/交付：`evidence show`、`deliveries --pack`（manifest + SHA256SUMS + DOCX 回执）、`deliver --type ...`（DOCX/XLSX）；操作者手工录入的证据（`--quote`/`--evidence`）标记为**不可外部核验（unverifiable）而不是缺失**，回执包单独统计；
- **交付回执包 v2（0.3.2：可 --client/--project 限定单个客户/项目）**：`deliveries --receipt [--out dir] [--ids ...] [--all] [--recipient ...]` 复制交付文件并记录每个文件的 SHA-256、生成环境、校验结果与收件人；`evidence verify <dir>` 离线校验（JSON，exit 0/1，不读 `~/.advisers`）。证据条目默认上限 2000（用 `--ids`/`--all` 控制）；旧 `deliveries --pack` 证据包保持兼容。见 `docs/DELIVERY-RECEIPT.md`。
- **提醒/日历接线（0.2.0）**：`commit add/edit --remind-offsets "-1d,-2h,+0d09:00"` 写入逐承诺 VALARM；`remind --deliver --notify` 增加可选 webhook 并把上次运行写入 `~/.advisers/scheduler/status.json`；`remind install|uninstall|status [--apply]` 默认只打印 dry-run 计划，加 `--apply` 才注册/移除 cron/schtasks；`today --calendar` 本地展开 RRULE（全天 / （循环）标注）。`today`、`capture`、`memory candidates`、`verify` 均有稳定 `--json`（`docs/CLI-JSON.md`）。
- 隐私/MCP/JSON：`privacy --prove`、`mcp --stdio`（8 工具 + 5 个只读 resources，单行 JSON-RPC 上限 1 MiB；候选写入仅 pending，审计行写失败即 fail-closed）、`ui`（本地只读视图）、`status/commit/who/deliveries/remind/evidence --json`。
- Pet Brief（只读脱敏投影，契约 v0.2：`schemaVersion: 2` + `displayPolicy`，默认 `private`；v0.1 brief 按 legacy 可读）：`pet-brief --json|--out|--check [--strict]|--print-schema|--display-policy public|private|none`；`secrecy >= 2` 全排除、confidence < 0.7 丢弃、5 分钟 TTL、每节 10 项上限；不调模型、不联网、不改账本；桌宠 UI/传输尚未接通。见 `docs/PET-BRIEF-PRODUCER.md`。

```sh
# 0.4.1 已于 2026-11-21 发布（npm `latest` = 0.4.1；`next` 也指向 0.4.1）。
# 从 checkout 运行（开发用途；同为 0.4.1 版本）：
#   corepack pnpm install && corepack pnpm -r build
#   ADVISERS_OFFICE_LOCAL=1 node packages/advisers/bin/advisers.js status
# 从 npm 安装（稳定渠道 = 默认 `latest`，当前为 0.4.1）：
#   npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
# `next` 渠道也指向 0.4.1：
#   npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers soul init
advisers commit add "周五前发报价给王工" --quote "周五前发报价给王工" --due 2026-11-13T18:00:00+08:00
advisers tick
advisers memory
advisers digest day
advisers office docx spec.json out.docx
advisers verify out.docx
```

npm 标签：**`latest`** 是稳定渠道（当前为 **`0.4.1`**，2026-11-21 已发布）；**`next`** 是预发布渠道（同样为 `0.4.1`）。`0.2.4` 是已被 0.3.0 线取代的**从未发布的 candidate**，不能从 npm 安装。`0.4.1` 取代 `0.4.0`/`0.3.2`/`0.3.1`/`0.3.0`：旧 tarball 仍可按版本号安装，但其文档是旧版本且无法原地修复（npm unpublish 需要 owner 2FA）。`0.4.1` 是 0.4.0 功能发布之上的当日补丁。需要可复现安装时请固定版本（当前 `advisers@0.4.1`），并直接查询官方 registry（`npm view advisers dist-tags --registry=https://registry.npmjs.org/`）——镜像可能滞后。

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
