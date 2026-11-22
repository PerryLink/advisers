# advisers（顾问团）

**Advisers** 的 cordis-only 发行：一个连续对话 + 用户账 + 承诺账 + 可审阅的流程账。

## 安装

```sh
# 0.5.0 已于 2026-11-22 发布；npm @latest 现为 0.5.0（稳定渠道 = 默认 `latest`）：
#   npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
# 从 checkout 运行：
#   corepack pnpm install && corepack pnpm -r build
#   ADVISERS_OFFICE_LOCAL=1 node packages/advisers/bin/advisers.js status
# `next` 渠道也指向 0.5.0：
#   npm i -g --registry=https://registry.npmjs.org advisers@next advisers-office@next
advisers soul init
advisers brief "做一份 Q4 预算 Excel，周五前给老板"
advisers chat "周五前把报价发给王工"
advisers office xlsx spec.json out.xlsx
advisers ls
advisers export
```

> **AI 与法律提示** —— Advisers 是本地优先的工作助手，不是情感陪伴，也不提供法律、医疗、
> 金融等专业意见；AI 输出可能出错，使用前请自行核验。禁止用于违法、侵权、欺诈、骚扰、
> 伪造或未标识合成内容等用途；未成年人须经监护人同意。
> 软件许可：PolyForm Noncommercial 1.0.0（源码可见、非 OSI 开源；商业使用须另行取得许可）。
> 使用前请阅读[服务条款](https://github.com/PerryLink/advisers/blob/main/docs/TOS.md)（v2026.11.4）、
> [免责声明](https://github.com/PerryLink/advisers/blob/main/docs/DISCLAIMER.md)、
> [安全与内容审核说明](https://github.com/PerryLink/advisers/blob/main/docs/SAFETY.md) 与
> [隐私与数据流说明](https://github.com/PerryLink/advisers/blob/main/docs/PRIVACY.md)。
> 本地数据库默认不加密；设置 API Key 后默认模型服务商为 DeepSeek（api.deepseek.com）。
> 离线副本随包分发于 `lib/tos/`（`terms.zh-CN.md`、`summary.zh-CN.md`、
> `privacy.zh-CN.md`、`safety.zh-CN.md`）。

CLI 是**本地秘书运行时**：一个 REPL、用户账/承诺账/流程账、Office 产物，以及可选的模型回路。没有 API key 也能记录、检索、计划、生成文件，并运行承诺/摘要命令。

## 状态

`0.5.0` 已于 2026-11-22 发布（npm `latest` = `0.5.0`；`next` 也为 `0.5.0`）。0.5.0 是「可携带、可披露、可验收」发布：可携带 home **bundle v1**（`export --bundle` / `import --bundle --verify`，明文 + 校验清单）、离线可验的 **context pack v1**（`context-pack create|verify`，人工选定、无回灌路径、不授读取/执行权）、additive 的 **MCP/DSH 披露**（`disclosure` + 逐行 `view`，工具数量不变）、**sync 快照 v2** 与 `sync.state.json`、真正只读的 `sync push --dry-run`、冲突预检（`sync status --check`、`E_SYNC_CONFLICT`，传输语义仍是整库 last-writer-wins）、`setup`/`demo`/`help <topic>` 上手、破坏性命令前的托管备份 fail-closed，以及报告 v2 质量门；零 schema 变更（仍 v22）、零新增出网、零新增运行时依赖。0.4.0 的功能面不变：本地知识库（schema v22）、TLS-only IMAP 邮件入口、交互式壳、可解释的主动式晨报、Policy/Evidence 2.0 子集、回款/对账与客户状态包 v2、MCP modern dual-era、Windows CI 与便携 ZIP，以及 v2026.11.4 法务修订。所有新命令都不需要模型调用，也没有后台常驻进程，`mail sync` 仍是唯一显式网络路径（TLS-only、只读、用户主动触发）。**schema v22 是单向迁移**：升级前 CLI 会写 `state.db.before-migrate-v*` 备份，0.3.2 打开 v22 数据库会报 `E_SCHEMA_NEWER`，降级需要恢复该备份。`0.4.3`/`0.4.2`/`0.4.1`/`0.4.0`/`0.3.2`/`0.3.1`/`0.3.0` 仍可按版本号安装但已被取代。运行时基线仍是「可信交付」feature line：所有出网面逐 item secrecy clearance、本地审计尾锚、备份轮换/可验证恢复与 `doctor --repair`、200k 读路径、MCP 输出上限 + legacy 协议协商、DSH 只读账本门面、机器可读契约、无 key 的确定性评测套件与 SBOM 门禁。`0.5.0` tarball 由 GitHub Actions OIDC/Trusted Publishing 发布，带 SLSA provenance；可用 `scripts/verify-release.mjs --version 0.5.0 --tag latest --sbom artifacts/sbom.cdx.json --require-sbom` 校验（SBOM 由 `pnpm run sbom` 生成）。Release notes：<https://github.com/PerryLink/advisers/releases/tag/v0.5.0>。模型化 `kb compile`/`kb ask`、embedding、完整 PolicyGrant/exit 4–6 与 DSH 写账本仍属后续版本；未交付清单见仓库 CHANGELOG。

- SQLite 账本 `~/.advisers/state.db`（JSON fallback；schema v22 —— 0.4.0 一次迁移加入 KB/邮件/回款对象、无锁只读快照、增量写）；
- soul 位于 `~/.advisers/soul.md`，人类独占；
- turns + 摘要 + FTS 检索；开场协议；`/resume`；
- 承诺账 + `commit add/ls/done`、`tick`、`snooze`、nudge outcome；
- `/memory`、`/week`、`/digest`、`/diff`、`/undo`；CLI：`learn ls`、`learn review <id>`；
- routine draft/approve/patch/curator + active routine index + `routine_view`；
- `advisers-office` 提供 DOCX/XLSX/PPTX/Mermaid/draw.io/XMind builder 与 7 个模板；
- `advisers pet-brief`：只读脱敏 Pet Brief 投影（契约 v0.2：`schemaVersion: 2` + `displayPolicy`，默认 `private`；`--json`/`--out`/`--check [--strict]`/`--print-schema`/`--display-policy`；`secrecy >= 2` 全排除；5 分钟 TTL；v0.1 brief 按 legacy 可读；未接桌宠 UI）；
- `matter add|ls|show|rename|archive|use`（客户/项目最小闭环，`--matter` 校验）；`agenda --days 1..31 --json` + 确定性 `morning` 晨报；确定性 `template quote|proposal`（DOCX/XLSX，`verify --content --template` 可复核）；操作者手工证据标记为不可外部核验而非缺失；
- 真实 IM/Office 打开验证仍未完成。
- **0.4.0 知识库**：`kb add|ls|show|rm|purge|reindex|link`、`search --scope turns|kb|pages|facts|all`（默认仍为 turns）、确定性编译页（`kb page ls|show|rebuild|diff`，带 stale 检测）与 `fact show|history|as-of`；无模型、无 embedding、无网络；
- **0.4.0 邮件入口**：`mail account add|ls|show|test|remove`、TLS-only 只读 `mail sync`（`UIDVALIDITY`/UID 游标）、`mail ls|show|extract|link|dismiss|purge`、`.eml` 导入、`0600` 凭据文件、正文默认保留 30 天；
- **0.4.0 交互壳**：补全、确认、有限队列、粘贴保护、Ctrl+C/Esc 处理与整行净化；非 TTY 仍是 plain/一次性行为，`tui --once/--json` 逐字节不变；
- **0.4.0 主动式**：确定性 `urgency` v1（`terms`/`whyNow`/`modelVersion`）、`morning` 晨报归档、v2 scheduler plan/status、可选提醒 webhook 的 Standard Webhooks HMAC 签名（payload 字节不变）；
- **0.4.0 Policy/Evidence**：决策引擎、一次性 decision token、egress 注册表、独立 TOS/模型同意存储（`consent.json`，0600 原子写）、四态 evidence resolver + `mail`/`kb_chunk`/`kb_page` 来源与回执包 v2 `verificationBasis`；
- **0.4.0 回款**：`receivable add|ls|show|edit|void` + `payment add|ls|void`（整数分、四币种、部分/多笔/超额/void、同事务自动完成承诺）、逐币种合计与账龄、`client export --pack`（manifest + `SHA256SUMS` + 离线校验器）；金额不进回执、MCP、DSH 与 Pet Brief；
- **0.4.0 MCP modern dual-era**：`server/discover`、modern 方法 allowlist 与 `resultType`/`ttlMs`/`cacheScope` envelope；legacy 响应逐字节不变，`ADVISERS_MCP_MODERN=off` 可回退；8 tools / 5 resources，DSH 6 tools；
- **0.4.0 Windows/法务**：`windows-full` CI 与便携 ZIP 构建/校验（npm 仍是正式渠道，`docs/WINDOWS.md` 限定支持范围）；TOS/PRIVACY/SAFETY/DISCLAIMER 升级到 v2026.11.4。

核心与架构：

https://github.com/PerryLink/advisers

## 许可

软件采用 [PolyForm Noncommercial License 1.0.0](LICENSE)（SPDX
`PolyForm-Noncommercial-1.0.0`），见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。这是
**源码可见、非开源**的许可，不是 OSI 认证的开源许可；商业使用需另行取得商业授权
（在 <https://github.com/PerryLink/advisers/issues> 提出申请）。

仓库的文档、评测数据与设计材料采用
[CC BY-NC-SA 4.0](https://github.com/PerryLink/advisers/blob/main/LICENSE-DOCS)；
本包 README 随软件分发，适用 PolyForm NC。第三方组件保留各自许可，见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

0.2.0 之前发布的版本保留原许可（MIT；至 2026-11-17 的 preview 版本为
Apache-2.0），不追溯。详见仓库 LICENSING.md、LICENSE-DOCS 与 NOTICE。
