# 新 DSH 会话启动提示词（复制给新会话）

你是一个新的 DSH 会话，接手 Advisers 项目。当前没有旧会话上下文。

**第一步只读，不要改任何文件、不要 commit/push、不要 npm stage/publish：**

1. 完整阅读 `/mnt/d/Projects/dsh/plugins/advisers/docs/HANDOFF-2026-11-15.md`。
2. 检查仓库真实状态：
   - `cd /mnt/d/Projects/dsh/plugins/advisers`
   - `git status`、`git log -5`、`git remote -v`
   - `node -e "console.log(require('./packages/advisers/package.json').version)"`
   - 跑 `pnpm -r test`（若耗时可控）并核对测试数
   - 用只读方式核对 npm `stage view`/`dist-tags`（不要 approve）
3. 用中文给我：
   - 10 行以内的现状摘要；
   - 与交接文档不一致的地方（如果有）；
   - 按优先级排序的下一步建议（最多 5 条，写清理由/风险）。
4. **等待我明确同意后再执行**。这是唯一一次“先建议后执行”；我同意后，后续按指令继续做，不需要每次重复请示。

硬性要求：

- 不要引用/索引任何旧会话、旧 transcript 或旧 INDEX；只以本文件、仓库、CI、npm 实测为准。
- 不要伪造完成；不能代做 OTP/真人金标/真实用户验收，需如实说需要我做什么。
- 没有我同意前不要发布、不要 approve、不要改版本号、不要 push。
- 重要背景：当前 HEAD 已包含另一个会话新增的 **Pet Brief producer**，但 npm staged `.70` 不包含它；下一次发布必须先 bump `.71` 并重新 stage。不要直接 approve `.70` 当成最新功能版本。

## 我同意后，建议的第一批工作

1. 核对三远端/CI，补 `.71` 版本、Pet Brief 的 README/CHANGELOG/docs；
2. 跑全量测试 + build/typecheck + pack-smoke/check-docs/security-suite；
3. commit、push GitHub/Gitee/GitCode；
4. `npm stage publish .` 记录 stage id/shasum；
5. 告诉我 approve 需要我本人 OTP，并带我完成；不要索要 OTP 明文。

## 如果我要你现在引导 npm approve

请按以下方式：

- 先只读确认 stage id/version/status 和 `dist-tags`；
- 给出**一步一步**的命令与浏览器操作说明；
- 提醒：OTP/浏览器确认由我本人完成，不要让我把 OTP 发给你；
- 认准 `advisers@0.2.0-preview.71`（或我指定的版本）的 stage id，不要批准旧 staged 版本；
- 我完成后，你再帮我验证 `dist-tags` 与全局安装 smoke。
