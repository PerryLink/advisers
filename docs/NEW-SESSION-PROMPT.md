# 新 DSH 会话启动提示词（复制给新会话）

你是一个新的 DSH 会话，接手 Advisers 项目。当前没有旧会话上下文。

**第一步只读，不要改任何文件、不要 commit/push、不要 npm stage/publish：**

1. 完整阅读 `/mnt/d/Projects/dsh/plugins/advisers/docs/HANDOFF-2026-11-15.md`。
2. 检查仓库真实状态（以实测为准，不要只信文档）：
   - `cd /mnt/d/Projects/dsh/plugins/advisers`
   - `git status`、`git log -5 --oneline`、`git remote -v`
   - `git ls-remote` 三端（GitHub/Gitee/GitCode；Gitee 可能需要 token）
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
- 重要背景（写交接时的实测）：HEAD 约 `c7e30a0`，代码 HEAD `64a7f82`；250 tests；版本仍是 `.70`；**staged `.70` 不包含另一个会话新增的 Pet Brief producer**。若你看到版本已是 `.71` 或更高，以 CHANGELOG/当前 stage 为准，不要把本文当现值。
- 不要直接 approve `.70` 当成包含 Pet Brief 的版本；要包含它，先 bump `.71` 并重新 stage。
- Gitee 公开 API 读回可能 404/受限；用 token 核实，不要假设三端已同步。
- **2026-11-17 更新**：`0.2.0-preview.71` 已由账号所有者 OTP 批准并发布到 npm（`next`，stage `3329a587-eb8b-467a-a184-7e1ce00e560b`）；依赖 `advisers-core@.22`/`advisers-policy-strict@.12`/`advisers-office@.14` 同步发布。详见 `eval/results/E10-release-2026-11-16.md`。

## 我同意后，建议的第一批工作

1. 核对三远端/CI，补 `.71` 版本、Pet Brief 的 README/CHANGELOG/docs；
2. 跑全量测试 + build/typecheck + pack-smoke/check-docs/security-suite；
3. commit、push GitHub/Gitee/GitCode；
4. `npm stage publish .` 记录 stage id/shasum；
5. 告诉我 approve 需要我本人 OTP，并带我完成；不要索要 OTP 明文。

## 如果我要你现在引导 npm approve（一步一步）

前提：**OTP/浏览器确认由我本人完成；你不要索要或记录 OTP 明文。**

1. 先只读确认目标（token 加载见交接文档 §8「token 安全加载」，不要打印/落盘）：
   ```sh
   cd /mnt/d/Projects/dsh/plugins/advisers/packages/advisers
   npm stage view <stage-id> --registry https://registry.npmjs.org/
   npm view advisers dist-tags --registry https://registry.npmjs.org/
   ```
   核对 `version`、`status: staged`、stage id；不要批准旧 staged 版本。

2. 让我在**我自己的终端**运行（token 从 `发布令牌.md` 读取，不打印）：
   ```sh
   npm stage approve <stage-id> --registry https://registry.npmjs.org/
   ```
   终端会给出 `https://www.npmjs.com/auth/cli/...`。

3. 让我复制该 URL 到浏览器：登录 `perrylink` → 完成 2FA/安全密钥 → 回终端看成功输出。

4. 若我收到 `EOTP`：让我重跑并加 `--otp <6位码>`；**不要让 OTP 进对话**。

5. 成功后你验证：
   ```sh
   npm view advisers dist-tags --registry https://registry.npmjs.org/
   npm view advisers@<version> version --registry https://registry.npmjs.org/
   ```
   再做全局安装 smoke：`npm i -g advisers@<version> --registry ...` → `advisers --version`。

6. 再次提醒：`.70` 不含 Pet Brief；如果要 Pet Brief，先发布 `.71` 再批准 `.71`。
