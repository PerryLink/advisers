# Staged-publish backlog — Advisers 0.2.0 release (2026-11-17)

> 数据来源：`npm stage list --json --registry https://registry.npmjs.org/`（账号 perrylink），
> 快照时间 2026-11-17。**清理需要 npm 账号所有者本人 2FA；agent 不代批、不接触 OTP。**

## 六包 backlog（未清理）

| package | staged records | 最早 stagedAt | 最新 stagedAt |
|---|---|---|---|
| advisers | 69 | 2026-11-11 | 2026-11-14 |
| dsh-advisers | 25 | 2026-11-11 | 2026-11-14 |
| advisers-core | 20 | 2026-11-11 | 2026-11-14 |
| advisers-bridge-hermes | 17 | 2026-11-11 | 2026-11-14 |
| advisers-office | 12 | 2026-11-11 | 2026-11-12 |
| advisers-policy-strict | 11 | 2026-11-11 | 2026-11-14 |
| **合计** | **154** | | |

另有 **53** 条 staged 记录属于本仓之外的 `dsh-*` 项目（如 `dsh-mcp-panel`、
`dsh-warranty-calc` 等），本次未处理——不属于 Advisers 发布面，需 owner 明确授权。

这些是历史 preview 的 staged 记录（`0.2.0-preview.*`，tag=`next`）。它们**不影响**
`latest`/`next` 解析，也不影响安装；只有被 approve 才会进入 registry 版本。

## 清理方式

`npm stage reject <stage-id>` 是破坏性操作，官方 registry 要求账号所有者 2FA
（实测 token 直接调用返回 `EOTP`），因此 agent 无法代为执行。本仓提供交互式工具：

Windows PowerShell 用户用 `scripts/windows-clean-staged.ps1`（同样先列后清，支持 -Limit 试跑）。

~~~bash
# 1) 只列出（默认只看 Advisers 六包）
node scripts/staged-backlog.mjs

# 2) 交互式逐条 reject（npm 弹出浏览器 2FA 后，回终端按 Enter 重试同一条；
#    s=跳过，q=退出）；先小批量验证：
node scripts/staged-backlog.mjs --apply --limit 3

# 3) 小批量验证无误后清理全部 Advisers backlog
node scripts/staged-backlog.mjs --apply

# 4) 如确认要清理其他项目（dsh-*）的 backlog，显式加 --all
node scripts/staged-backlog.mjs --apply --all
~~~

建议：先确认没有仍需要的 staged 工件（例如尚未 approve 的候选发布），再清理；
`npm stage reject` 会永久删除 staged 记录与 tarball。

## dist-tag 收尾

六包 `next` 已对齐到 `0.2.0`（`npm dist-tag add <pkg>@0.2.0 next`，2026-11-17）：
`advisers`、`advisers-core`、`advisers-office`、`advisers-policy-strict`、
`advisers-bridge-hermes`、`dsh-advisers` 的 `latest` 与 `next` 均为 `0.2.0`。

