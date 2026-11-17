# 发布 runbook（Advisers 0.2.0 stable）

> 适用对象：发布负责人（账号所有者 / lead）。来源：01-research/advisers-hardening-2026-11-17/14-release-readiness.md
> §4 的发布就绪审计结论（2026-11-17），并按当日实际落地脚本（set-version.mjs、
> check-release.mjs、release.mjs 及 TOS/许可证门禁）修订。
>
> **纪律**：OTP 与浏览器 2FA 只能由账号所有者本人在自己的终端完成；agent 不得索要、读取、
> 记录或转述 OTP。发布动作（stage/approve/publish/dist-tag）不在 CI 里自动执行，由发布
> 负责人按本 runbook 手动执行并留证据。

版本语义：单仓六包 lockstep，v0.2.0 是**唯一的发布 tag**（六包共用；npm 包版本均为
0.2.0）。发布前 latest 仍指旧占位版；发布后六包 latest 均指向 0.2.0。

---

## R0. 环境与前置条件

~~~sh
cd /mnt/d/Projects/dsh/plugins/advisers
git status --porcelain            # 必须为空；并发 agent 的改动必须先 commit 或撤回
node -v                            # >= 22.13（建议 24）
pnpm -v                            # 与 packageManager 一致（pnpm 12.16.1）
npm config get registry            # 记录；若为 npmmirror，下方所有发布命令仍显式指定官方 registry
git remote -v                      # github / gitee / gitcode 三端
~~~

- token 只从 D:\Projects\dsh\plugins\发布令牌.md 按 00-live/_key.ps1 / _key.mjs 加载；
  **不打印、不写入任何文件、不进提交/issue/报告**。
- 本机默认 registry 可能是 npmmirror；所有 npm view/stage 查询与发布命令显式带
  --registry https://registry.npmjs.org/，或直接 curl https://registry.npmjs.org/<pkg>。
- 发布期间不要清理旧的 staged 记录（P2，另行授权处理）。

## R1. 版本与文档（bump）

~~~sh
ADVISERS_VERSION_ALLOW_DIRTY=1 node scripts/set-version.mjs --version 0.2.0
~~~

脚本会：把 8 个 workspace 包 version 改成 0.2.0（六发布包 + 两个私有 link-*）、把内部
workspace pin 改成 0.2.0、改 3 个内部 version 常量（packages/advisers/index.js、
packages/dsh-advisers/index.js、packages/bridge-hermes/src/index.ts）、跑
pnpm install --lockfile-only 重生成 pnpm-lock.yaml、最后跑 check-docs（docs 未同步时
会失败，属预期，按 R1.1 完成后重跑）。

若脚本因并发改动失败，可改为手工改上述文件，再执行：

~~~sh
pnpm install --lockfile-only
~~~

### R1.1 文档/CHANGELOG 必须同步

- CHANGELOG.md 顶部首个 ## 标题必须是当前版本（## 0.2.0 ...）。
- 根 README.md / README-zh.md 与 packages/advisers/README*.md 必须 advertise 0.2.0
  且**不得残留旧的 0.2.0-preview.N 字样**（check-docs 会逐条扫描）。
- README 状态段写“stable release candidate / staged pending OTP”，**不要提前写“已发布”**；
  发布成功后再由发布负责人改为 published。
- 安装命令同时说明两个渠道：latest = 稳定渠道（默认），next = 预发布/RC 渠道。
- 其他包 README 的 Status 行（core/office/dsh-advisers 等）同步到 0.2.0；历史许可证映射
  段落保留“历史叙述”措辞（不要改成现行版本）。
- docs/QUICKSTART.md 状态块、docs/HANDOFF-2026-11-15.md 顶部横幅、
  docs/NEW-SESSION-PROMPT.md 现行状态同步；历史快照段落保留并标明历史。
- TOS/PRIVACY/DISCLAIMER/SAFETY、LICENSE/NOTICE/LICENSE-DOCS/LICENSING.md 的文本
  **不是本步骤的改动面**；若必须改，先跑 node scripts/check-tos.mjs --release 与
  node scripts/check-licenses.mjs。

验收：

~~~sh
node scripts/check-docs.mjs        # PASS (<version>)
node scripts/check-release.mjs     # PASS release consistency (<version>)
~~~

## R2. 全量验证（static + test + build）

~~~sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r test
node scripts/pack-smoke.mjs
node scripts/check-docs.mjs
node scripts/check-tos.mjs --release
node scripts/check-licenses.mjs
node scripts/check-release.mjs
node scripts/security-suite.mjs
node scripts/verify-office.mjs
~~~

验收：全部 exit 0。发布 commit 上的测试数与门禁输出写入
eval/results/E11-release-2026-11-17.md。

> verify-office 只做结构校验（无 Word/WPS/LibreOffice 应用层）；check-tos --release 要求
> 法律文本无复核标记、生效日期已定稿。CI 见 .github/workflows/ci.yml（Node 22/24）。

## R3. 打包证据（tag 前）

在 POSIX 临时副本或 git archive 出的目标 commit 上，对六包执行 npm pack --json，记录
filename / sha1 / sha512 / integrity / 文件数 / 文件 mode：

~~~sh
for p in core office policy-strict bridge-hermes advisers dsh-advisers; do
  (cd packages/$p && npm pack --json --pack-destination /tmp/adv-pack > /tmp/adv-pack/$p.json)
done
~~~

注意：从 /mnt/d（WSL drvfs 0777）打包出的 tarball 文件权限是 -rwxr-xr-x，与 POSIX
checkout 的 shasum **不同**属正常；证据中必须写清“可复现”的前提（同一 checkout/mode）。
registry 的 dist.shasum 以实际 stage/发布产物为准。tarball 内必须包含
LICENSE（PolyForm NC）、NOTICE、THIRD-PARTY-NOTICES.md，且不得含 Apache License 文本
（pack-smoke 会校验）。

## R4. commit

~~~sh
git add -A
git commit -m "release: 0.2.0"
~~~

确认 commit 包含：8×packages/*/package.json、3 个常量、pnpm-lock.yaml、
README/CHANGELOG/docs 更新、docs/RELEASING.md、eval/results/E11-*.md。
提交前 git status --porcelain 必须只剩预期文件。

## R5. tag v0.2.0 并同步三端

~~~sh
git tag -a v0.2.0 -m "Advisers 0.2.0"
git push origin main
git push origin v0.2.0
git push gitee main && git push gitee v0.2.0
git push gitcode main && git push gitcode v0.2.0
~~~

验收：git ls-remote --tags <remote> | grep v0.2.0 三端一致；
git describe --tags --exact-match HEAD 输出 v0.2.0。
可选：给已发布的最后一个 preview 补历史 tag（v0.2.0-preview.71 → 内容等于线上 tarball 的
release commit），用于历史工件溯源；stable 本身不依赖它。

> 已知风险：本机全局 commit.gpgsign 可能因缺 signing key 失败，用
> git -c commit.gpgsign=false commit ...；git push 若因全局代理失败，用
> git -c http.proxy= push ...（见工作区 AGENTS.md §0.6）。

## R6. CI

等待 main + tag 的 CI 全绿（build/typecheck/test/pack-smoke/check-docs/security-suite/
verify-office，如已接入 release-check / Windows job 则一并要求）。CI 红 → **停止**，不 stage；
修复后重新 commit + 重新打 tag（tag 不可复用：删本地/远端 tag 后重打，或 bump 版本）。
CI run 的 id/URL 写入 E11。

## R7. npm staging（六包，tag = latest）

~~~sh
RELEASE_TAG=latest node scripts/release.mjs
~~~

脚本前置检查（失败即 abort，不要绕过）：

- 只允许官方 registry（ADVISERS_REGISTRY 默认 https://registry.npmjs.org/）；
- 六包必须 lockstep 同版本；
- 工作树 clean（ADVISERS_RELEASE_ALLOW_DIRTY=1 仅用于演练）；
- HEAD 必须正好是 v<version> tag（ADVISERS_RELEASE_ALLOW_NO_TAG=1 仅演练）；
- 版本不得已发布；E409 视为失败，不复用已 staged 版本；
- 拒绝 NPM_OTP 环境变量（approve 必须本人逐包完成）；
- 输出每个包的 stage id + npm stage approve 命令；末尾汇总，不自动 approve。

先演练可加 --dry-run（只 npm stage publish --dry-run，不产生 stage）。

**TAG 一旦 stage 不可改**（npm help stage：tag 是 staged package 的不可变属性）；若把
stable 误 stage 成 next，只能 approve 后 npm dist-tag add 纠正或 reject + restage（都要 OTP）。

## R8. 记录并核对 stage id

对六包逐个只读核对（不要 approve）：

~~~sh
npm stage view <stage-id> --registry https://registry.npmjs.org/
npm view <pkg> dist-tags --registry https://registry.npmjs.org/
~~~

把 6 个 stage id、version（必须 0.2.0）、tag（必须 latest）、status（staged）、shasum
写入 E11 的 “npm staging” 表。任一不符：停止，不 approve。

## R9. owner OTP approve（依赖顺序，逐包）

**由账号所有者本人在自己的终端执行**（token 从 发布令牌.md 读取，不打印）：

1. advisers-core
2. advisers-office
3. advisers-policy-strict
4. advisers-bridge-hermes
5. advisers
6. dsh-advisers

~~~sh
npm stage approve <stage-id> --registry https://registry.npmjs.org/
~~~

- 浏览器会给出 https://www.npmjs.com/auth/cli/...：登录 perrylink → 2FA/安全密钥 → 回终端确认成功。
- EOTP：在本人终端重跑并加 --otp <6位码>；**OTP 不得进入对话/文件/日志**。
- 不要尝试用一个 OTP 批量 approve 六包（30s 过期/限流）。每包 approve 后立刻核对
  curl -s https://registry.npmjs.org/<pkg> | jq '.["dist-tags"]'。

## R10. 发布后验证与收尾

1. **dist-tags**：六包 latest 均为 0.2.0；
~~~sh
for p in advisers advisers-core advisers-office advisers-policy-strict advisers-bridge-hermes dsh-advisers; do
  curl -s https://registry.npmjs.org/$p | jq -r '.["dist-tags"].latest'
done
~~~
2. **tarball 200 + LICENSE/shasum**：
~~~sh
curl -sI https://registry.npmjs.org/advisers/-/advisers-0.2.0.tgz | head -1   # 200
curl -s https://registry.npmjs.org/advisers/0.2.0 | jq -r '.dist.shasum, .dist.integrity, .license'
~~~
   .license 应为 PolyForm-Noncommercial-1.0.0；tarball 内 LICENSE 是 PolyForm 文本、
   NOTICE/THIRD-PARTY-NOTICES.md 存在；与 R3/本地 pack 的 sha1/integrity 对照并解释差异。
3. **安装 smoke（临时 prefix，不污染全局）**：
~~~sh
npm i -g --prefix /tmp/adv-0.2.0 --registry https://registry.npmjs.org/ advisers@0.2.0 advisers-office@0.2.0
/tmp/adv-0.2.0/bin/advisers --version        # 0.2.0
export ADVISERS_HOME=/tmp/adv-home-0.2.0
/tmp/adv-0.2.0/bin/advisers status           # 先建 DB（init 不建 DB）
/tmp/adv-0.2.0/bin/advisers pet-brief --json
/tmp/adv-0.2.0/bin/advisers pet-brief --check   # exit 0
~~~
   可选：advisers office docx + advisers verify。
4. **Windows smoke**（首个目标平台）：PowerShell 7 + Node ≥22.13 重复第 3 步，记录
   chcp 65001 与 BOM 用例；PowerShell 5.1 抽查一次。无法实机时在 E11 明确写“未验证”。
5. **tags 收尾（可选，按发布决策）**：npm dist-tag add <pkg>@0.2.0 next --registry ... 六包，
   避免 @next 仍停在旧 preview；旧 preview 版本不再改动。
6. **证据落盘**：按 eval/results/E11-release-2026-11-17.md 模板填 commit/tag、CI、六包 stage
   id/shasum、install smoke、偏差与未完成项；commit docs(release): record 0.2.0 并 push 三端。
7. **README 状态**：把状态段从 “release candidate / staged pending OTP” 改为 published，安装
   命令切到 @latest；CHANGELOG 顶部日期/状态同步。

## R11. 回滚决策树

| 场景 | 动作 | 验证 |
|---|---|---|
| 已 stage、未 approve，发现内容错 | owner 逐包 npm stage reject <id>（需 OTP）；修 0.2.1 再来；latest 未动 | npm stage view 无此 id；六包 latest 仍旧值 |
| 误 stage 成 next（tag 错） | approve 后 npm dist-tag add <pkg>@0.2.0 latest；或 reject + restage（更慢） | dist-tags.latest == 0.2.0 |
| 已 approve 后发现严重 bug | ① npm dist-tag add <pkg>@<上一版> latest（回退旧 latest）② npm deprecate <pkg>@0.2.0 "broken: install <旧版> or wait 0.2.1" ③ 发 0.2.1 | 新装 <pkg>@latest 得到旧版；deprecated 有值 |
| 想彻底删 0.2.0 | **不推荐**：仅发布后 72h 内可 npm unpublish <pkg>@0.2.0 --force，且版本号永久不可复用（必须 0.2.1） | 仅 72h 窗口内执行并记录 |
| 依赖顺序错（advisers 先于 core） | 立即把对应包 dist-tag add 回上一版，依赖 approve 后再重指 0.2.0 | 六包 latest 同版本 |
| 镜像/缓存滞后 | 所有查询显式官方 registry 或 curl；用户安装加 --registry | 官方 registry 返回 0.2.0 |

> 旧 staged 积压（本仓六包历史版本）不要批量 reject：与 stable 无关，且逐条 reject 需 OTP；
> 由 owner 另行书面授权后处理，E11 记录“未清理 + 原因 + 后续计划”。

## 附：验收清单（复制到发布日志）

- [ ] R1 bump：8 包 + 7 pin + 3 常量 + lockfile + docs 一致，check-docs/check-release PASS
- [ ] R2 全量门禁 exit 0（build/typecheck/test/pack-smoke/check-docs/check-tos --release/check-licenses/security-suite/verify-office）
- [ ] R3 六包 pack sha1/sha512 + tarball LICENSE(PolyForm)/NOTICE/THIRD-PARTY-NOTICES
- [ ] R4 release commit 干净且含 lockfile/docs/E11/RELEASING
- [ ] R5 tag v0.2.0 三端可见
- [ ] R6 CI 绿（含 tag run）
- [ ] R7 RELEASE_TAG=latest node scripts/release.mjs 六包 staged，6 个 stage id 记录
- [ ] R8 六包 stage：version=0.2.0 / tag=latest / status=staged
- [ ] R9 owner 本人 OTP approve（依赖顺序；agent 未接触 OTP）
- [ ] R10 六包 latest=0.2.0；tarball 200；LICENSE=PolyForm；temp-prefix install smoke --version=0.2.0；pet-brief OK
- [ ] E11 证据 commit + push 三端；README/CHANGELOG 改为 published
