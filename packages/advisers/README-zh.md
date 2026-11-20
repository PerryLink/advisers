# advisers（顾问团）

**Advisers** 的 cordis-only 发行：一个连续对话 + 用户账 + 承诺账 + 可审阅的流程账。

## 安装

```sh
# 0.3.1 已于 2026-11-20 发布；npm @latest 现为 0.3.1（稳定渠道 = 默认 `latest`）：
#   npm i -g --registry=https://registry.npmjs.org advisers@latest advisers-office@latest
# 从 checkout 运行：
#   corepack pnpm install && corepack pnpm -r build
#   ADVISERS_OFFICE_LOCAL=1 node packages/advisers/bin/advisers.js status
# `next` 渠道也指向 0.3.1：
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
> 使用前请阅读[服务条款](https://github.com/PerryLink/advisers/blob/main/docs/TOS.md)（v2026.11.3）、
> [免责声明](https://github.com/PerryLink/advisers/blob/main/docs/DISCLAIMER.md)、
> [安全与内容审核说明](https://github.com/PerryLink/advisers/blob/main/docs/SAFETY.md) 与
> [隐私与数据流说明](https://github.com/PerryLink/advisers/blob/main/docs/PRIVACY.md)。
> 本地数据库默认不加密；设置 API Key 后默认模型服务商为 DeepSeek（api.deepseek.com）。
> 离线副本随包分发于 `lib/tos/`（`terms.zh-CN.md`、`summary.zh-CN.md`、
> `privacy.zh-CN.md`、`safety.zh-CN.md`）。

CLI 是**本地秘书运行时**：一个 REPL、用户账/承诺账/流程账、Office 产物，以及可选的模型回路。没有 API key 也能记录、检索、计划、生成文件，并运行承诺/摘要命令。

## 状态

`0.3.1` 已于 2026-11-20 发布（npm `latest` = `0.3.1`；`next` 也为 `0.3.1`）。
0.3.1 是**仅修复发布面的 patch（无运行时/CLI/契约变化）**：它取代 `0.3.0`——0.3.0 的 tarball README 仍是
release candidate 文案，且发布面无法原地修复（npm 同版本 tarball 不可替换，`npm unpublish` 需要 owner 的 2FA）。
运行时是「可信交付」feature line：所有出网面逐 item secrecy clearance、本地审计尾锚、备份轮换/可验证恢复与
`doctor --repair`、200k 读路径消除 TEMP B-TREE 写放大、MCP 输出上限 + legacy 协议协商、DSH 只读账本门面、
机器可读契约、无 key 的确定性评测套件与 SBOM 门禁；被该 line 取代的 0.2.4 candidate 从未发布，`0.3.0` 仍可
按版本号安装但已被取代。0.3.1 tarball 由 GitHub Actions OIDC/Trusted Publishing 发布，带 SLSA provenance；
可用 `scripts/verify-release.mjs --version 0.3.1 --tag latest --sbom artifacts/sbom.cdx.json --require-sbom`
校验（SBOM 由 `pnpm run sbom` 生成）。Release notes：
<https://github.com/PerryLink/advisers/releases/tag/v0.3.1>。完整 TUI 壳、邮件入口、PolicyGrant 与 MCP
modern 不在 0.3.1；未交付清单见仓库 CHANGELOG。

- SQLite 账本 `~/.advisers/state.db`（JSON fallback；schema v21 —— v21 增量加入客户/项目实体、无锁只读快照、增量写）；
- soul 位于 `~/.advisers/soul.md`，人类独占；
- turns + 摘要 + FTS 检索；开场协议；`/resume`；
- 承诺账 + `commit add/ls/done`、`tick`、`snooze`、nudge outcome；
- `/memory`、`/week`、`/digest`、`/diff`、`/undo`；CLI：`learn ls`、`learn review <id>`；
- routine draft/approve/patch/curator + active routine index + `routine_view`；
- `advisers-office` 提供 DOCX/XLSX/PPTX/Mermaid/draw.io/XMind builder 与 7 个模板；
- `advisers pet-brief`：只读脱敏 Pet Brief 投影（契约 v0.2：`schemaVersion: 2` + `displayPolicy`，默认 `private`；`--json`/`--out`/`--check [--strict]`/`--print-schema`/`--display-policy`；`secrecy >= 2` 全排除；5 分钟 TTL；v0.1 brief 按 legacy 可读；未接桌宠 UI）；
- `matter add|ls|show|rename|archive|use`（客户/项目最小闭环，`--matter` 校验）；`agenda --days 1..31 --json` + 确定性 `morning` 晨报；确定性 `template quote|proposal`（DOCX/XLSX，`verify --content --template` 可复核）；操作者手工证据标记为不可外部核验而非缺失；
- 真实 IM/Office 打开验证仍未完成。

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
