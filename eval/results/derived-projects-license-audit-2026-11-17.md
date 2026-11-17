# 衍生项目许可审计（2026-11-17）

> 范围：本机 `/mnt/d/Projects/dsh` 下与 Advisers / DSH 生态相关的自有项目；只读审计，未修改任何仓。
> 背景：Advisers 0.2.0 起软件为 PolyForm Noncommercial 1.0.0，文档/数据/设计为 CC BY-NC-SA 4.0；用户要求「由其引申出来的项目也要变」。

## 1. 方法与分类

- 扫描 `/mnt/d/Projects/dsh` 下 git 仓（checkers/、plugins/、desktop-games、dsh-sherlock 等），读取 package.json、LICENSE*/NOTICE、git HEAD/remote/status。
- 判定「Advisers 直接衍生」：package.json 依赖 `advisers`/`advisers-*`，或消费 Advisers 明确定义的外部契约（如 Pet Brief）。
- 判定「自有 DSH 项目组合」：`/mnt/d/Projects/dsh/checkers/*`（62 个 dsh-*-check 类）与 `/mnt/d/Projects/dsh/plugins/<dir>` 下的自有插件；排除 `plugins/_scratch`、`plugins/_archive`、`_eco-delivery` 等第三方/worktree 副本。

## 2. 关键结论

1. **唯一明确的 Advisers 直接衍生项目是 `desktop-games`**（Pet Brief v0.2 consumer）：
   - 已完成法律迁移：`LICENSE`（4563 B，PolyForm NC 全文）、`LICENSE-ART`、`LICENSE-COMMERCIAL.md`、`NOTICE`（2026-11-17 更新）；
   - 仓库 HEAD `16e868b` 含 “feat(legal): sync TOS … add ASR consent gate”；
   - 仍有 3 个无关 docs 修改未提交；**该仓没有配置 git remote**（无法 push）。
2. **没有任何仓库在 package.json 里依赖 `advisers`/`advisers-*`**（direct-derived deps = 0）。
3. **自有 DSH 项目组合绝大多数仍是 Apache-2.0**：
   - `checkers/`：62 个仓，**62/62 Apache-2.0**；
   - `plugins/` 一级目录：82 个含 manifest/许可的目录，**75 Apache-2.0、1 MIT（dsh-wechat）、1 CC0（awesome 列表）、1 PolyForm（advisers 工作区）、4 无 license 字段**；
   - `dsh-sherlock`：`Apache-2.0 AND MIT`；`desktop-games`：PolyForm Noncommercial 1.0.0。
4. 其余扫描到的 `cordis`、`dsh-root`、`awesome-*` 等属于上游/第三方/worktree，**不在自有迁移范围**。

## 3. 自有组合许可分布

| 范围 | 仓数 | 许可现状 |
|---|---|---|
| checkers/ | 62 | 全部 Apache-2.0 |
| plugins/（一级） | 82 | 75 Apache-2.0 / 1 MIT / 1 CC0 / 1 PolyForm / 4 无字段 |
| desktop-games | 1 | PolyForm-NC-1.0.0（已完成） |
| dsh-sherlock | 1 | Apache-2.0 AND MIT |

无 license 字段的 4 个：`dsh-infinite-gen-2`（audit-dsh-infinite-gen-2）、`@perrylink/dsh-plugin-certification`、`@root/schemastery`（第三方 fork/worktree）、`oh-my-dsh`（_eco-delivery 下的交付副本）。前两个需要补字段；后两个不属于自有发布面。

## 4. 迁移风险（为什么不能直接批量改）

- **已有发布版本不可追溯**：npm 上既有 Apache-2.0 版本不会因新版本换许可而失效，用户可继续按 Apache 使用旧版本；只能约束新版本。
- **生态影响**：DSH 插件组合目前靠 Apache-2.0 获得采用/贡献；切到 PolyForm NC 会阻止商业使用（含企业内部商业使用），可能减少外部采用。
- **成本**：每个仓需要改 LICENSE/NOTICE/package.json license 字段/README/CHANGELOG、检查第三方依赖许可见 `THIRD-PARTY-NOTICES`、跑门禁、发新版本；60+ 仓 × 发布流程成本高。
- **商业授权路径**：NC 需要配套商业授权入口/主体/合同；当前只有 GitHub Issues 占位。
- **衍生/上游 obligations**：若仓库基于 Apache-2.0 上游（cordis 等），NOTICE/署名义务仍需保留；不能简单替换 LICENSE。
- **npm staged 积压**：这些 `dsh-*` 项目在 npm 还有 52 条历史 staged 记录（未处理），与许可迁移无关但会叠加发布噪音。

## 5. 建议（按优先级）

- **方案 A（推荐）：只迁移 Advisers 衍生面**。保持通用 DSH 插件 Apache-2.0；只对直接消费 Advisers 契约/代码的仓（当前 `desktop-games`，未来新衍生）套 PolyForm NC + CC BY-NC-SA，并同步商业授权策略。
- **方案 B：选择性迁移旗舰/商业敏感项目**。挑 3–5 个准备商业化或含专有规则的项目切 NC；其余保持 Apache。
- **方案 C：全量迁移**（62 checkers + 75 plugins）。需要独立项目批次：每仓改许可/文档/依赖清单/门禁，逐仓发版；不建议与 Advisers 发布混在同一轮。

## 6. 若确认迁移的执行清单（每仓）

1. `LICENSE` 换 PolyForm NC 官方全文；`NOTICE` 加 Required Notice 与历史映射；文档/数据/设计补 `LICENSE-DOCS`（CC BY-NC-SA）；
2. `package.json` 的 `license` 改 `PolyForm-Noncommercial-1.0.0`，检查 `files` 白名单包含 LICENSE/NOTICE；
3. README 顶部加非商业/source-available 声明与商业授权入口；非代码文档标 CC BY-NC-SA；
4. 重新生成 `THIRD-PARTY-NOTICES`（依赖许可审计，特别关注 GPL/AGPL）；
5. 新版本发布（旧版本保留 Apache-2.0，不追溯；CHANGELOG 写明）；
6. 加 CI 门禁：license 字段、LICENSE 存在、README 声明、依赖 copyleft 扫描。

## 7. 待用户决策

- 选 A / B / C 哪个？若选 B，请给项目清单；
- 商业授权主体/邮箱/价格是否现在确定（影响每个仓 README/NOTICE 文案）；
- `desktop-games` 是否要配置 remote 并提交那 3 个 docs 改动；
- 是否要我先为 62 个 checkers 生成「许可迁移 diff 预览」（不动文件）？

## 附：数据口径

- 扫描时间 2026-11-17；仓数来自本机实际目录；许可字段来自各仓 package.json；未逐仓运行 `npm test`；
- 本审计未修改任何第三方或自有仓文件。
