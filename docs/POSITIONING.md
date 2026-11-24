# Positioning (2026-11-24, post-competitive round 2; 0.5.1 boundary)

> Facts re-checked 2026-11-22 from the internal competitor round-2 notes. This page
> states positioning and boundaries, not pricing or legal terms. Do not reuse
> competitor marketing copy or screenshots.

## 一句话

**中文：Advisers 是给技术型独立顾问的「可验证交付与承诺层」——承诺、交付、回执
都在本机，能离线校验，能带着走。**

**English: Advisers is a verifiable delivery & commitment layer for independent
consultants — local ledgers, offline-verifiable receipts, portable by design.**

对比页副题（只在有对比语境时用）：别人让 AI 替你干活；Advisers 证明你干了什么、
交付了什么、谁还欠你、客户能否离线核验。

## 三段式（README 首屏 / Release Note 共用）

- **问题**：云端 agent 能读邮件、能生成 Office、能自动聚合，但不证明交付物没被改、
  不证明上下文给了谁、关停就带走数据（平台关停潮 2026 年仍在发生）。
- **机制**：本地 SQLite 账本 + 逐字证据 + 交付回执 + 披露包 + 可退出 bundle；默认不出网、
  无遥测、无账号。
- **证据**：只讲三条可复制命令链（见下），每条都能在干净机器复核 0/1。
- **边界**：不承诺 SLA/合规认证/第三方时间戳/准确率；`verified` 只表示本地解析成功。

## 2026 市场已经商品化的层（复核 2026-11-22；不要当卖点）

- 入口与连接器：Claude/ChatGPT 的 Google Workspace 等 connector 已能读信、查日历；
  平台把 OAuth 入口与目录收口。
- 按客户聚合与原文回链：Fyxer Spaces 已按客户/交易聚合邮件、会议、文档并能问答；
  顾问 OS（Bonsai/ConsultBase 等）已有客户门户与 MCP。
- Office/PDF 生成：Claude 内置文档 skills、Codex 角色插件、千问办公/WPS 等已免费或低价。
- 个人记忆：Claude/ChatGPT/Gemini/Copilot 默认开启并可导入；平台正在做迁移入口。
- 提醒/任务：Todoist/滴答/Motion/飞书等已覆盖。
- 开源/本地入口：OpenClaw、Goose、Cline、Cursor、Codex CLI 都是本地 agent 宿主；
  “本地/开源”本身不是差异。

结论：**入口、连接器、聚合、生成、记忆都只是及格线**。聚合能力要做（候选装配），
但卖点必须是聚合之后的东西：可披露、可离线验、不可回灌、不授执行权、可退出。

## 可防守的（0.5.0 起必须能演示；0.5.1 增加只读邮件跟进）

1. **可退出**：`export --bundle` -> `IMPORT.md`/`SHA256SUMS` -> 干净 home
   `import --bundle --verify` -> `dataDigest`/counts 相等；明文边界与排除项写在
   manifest/IMPORT.md；篡改零写入。参见 [PORTABILITY.md](PORTABILITY.md)。
2. **可披露**：`context-pack create --subject client:|matter:` 候选（只读）-> 人工
   `--ids`/`--yes` -> recipient/purpose/expiry + 排除计数 -> `context-pack verify`
   离线 0/1；`confersReadAuthority/confersExecutionAuthority=false`；不可回灌。参见
   [CONTEXT-PACK.md](CONTEXT-PACK.md)。
3. **可验收**：`template quote`/`office ...` -> `verify --content` ->
   `deliveries --receipt` -> `evidence verify` 离线 0/1。
4. **承诺账语义**：who owes whom + due + 逐字 evidence + 人工 accept + 回执；
   不是 TODO 清单，也不是聊天记录。
5. **本地可自证**：`privacy --prove` + hash-chain audit + secret matter fail-closed；
   云端 agent 不是本地账本。
6. **中文承诺质量**：中文抽取与 Asia/Shanghai 相对日期是真实工程；但**必须用独立
   人工金标证明**，不把“界面中文”当护城河；D2 之前 `unknowns.humanGold=null`。

## 三条证据链（对外只讲这三条）

```sh
# 1) 可退出
advisers export --bundle <dir> --json
advisers import --bundle <dir> --verify --dry-run --json   # 干净机，零写入

# 2) 可披露
advisers context-pack create --subject client:<id> --json  # 候选，只读
advisers context-pack verify <pack-dir> --json             # 离线 0/1

# 3) 可验收
advisers deliveries --receipt --client <id> --out <dir> --json
advisers evidence verify <dir> --json                      # 离线 0/1
```

## Say / Don't say

| Say | Don't say |
|---|---|
| 可验证交付与承诺层；本地账本 + 离线可验回执 | AI 秘书 / 记忆层 / 第二大脑 / 工作台 / 通用助理 |
| 可退出：明文 bundle + `IMPORT.md` + 校验清单（加密是后续 opt-in） | “完全离线/数据绝对不出机”（模型调用在云；bundle 是明文） |
| 可披露：人工选定 + recipient/purpose/expiry + 排除计数 + 离线 verify | “自动聚合/自动外发/上下文引擎” |
| 不授执行权、不可回灌；包外可复制，所以不称访问控制 | “安全分享/权限控制/DRM” |
| 承诺账 + 逐字证据 + 人工 accept + 交付回执 | “全自动秘书/能替你把事办了” |
| 中文承诺语义（待独立金标） | “中文护城河/中文界面唯一” |
| source-available、PolyForm-NC + 商业许可 | “开源”（应写 source-available） |
| 回归门通过（回归门不是准确率） | 准确率、优于竞品、人工金标已达标、合规认证、SLA 99.9% |
| `verified` = 本地证据指针解析成功 | `verified` = 记录为真 / 已核验事实 / 可信时间戳 |
| 定价与销售主体：待 owner 决定（本页不构成要约） | “可购买/可开票/有免费试用” |

## 对比页纪律

- 只写 2026-11-22 时点可得的事实 + 日期 + 证据级别；不写竞品弱点推断，不复制竞品
  文案/截图/代码。
- 每家竞品最多一句“他们做 X；我们做 Y”，不做优劣判断：
  - Fyxer Spaces：按客户自动聚合邮件/会议/文档并能问答；Advisers 由你选定条目打包，
    包外可离线校验，给谁看/用途/过期写进 manifest，且不授予读取/执行权。
  - Claude Cowork / Copilot：云端执行、关电脑继续；Advisers 在本地账本上生成与校验，
    数据在用户机器、可导出。
  - ChatGPT/Claude 记忆：默认开启、可导入；Advisers 只投影自己的账本，不读宿主记忆、
    不导入第三方记忆。
  - OpenClaw/Goose：本地 agent 入口与渠道；Advisers 作为其 MCP/CLI 工具提供账本与
    验收，不与其争入口（见 [AGENT-INTEROP.md](AGENT-INTEROP.md)）。
  - 通义法睿/法律 AI：低价或专业审查；Advisers 只做检查清单/引用/草稿/免责，不输出
    法律意见。
- 不在对比页比价格，不写“免费替代”。价格/许可口径只在 owner 决定后由单一文档承载。

## Watchlist（6–12 个月会被平台做成 0 元的能力，一律不投资深）

读邮件/摘要/未回复列表、会前 brief、客户 Space 聚合、Office 生成、个人记忆、提醒、
MCP 目录、浏览器/常驻 agent、CRM 同步。规则：只做“证据 + 回执 + 可退出”的最后一公里；
命中 watchlist 的功能请求必须写“为什么不投”并走 owner 决策。

## 明确不做（产品非目标清单；0.5.1 口径）

产品非目标（不是待办，不 roadmap）：

- 不称常驻助手/录音/会议转写；不做移动 App/伴侣端；不做自动代发/自动改期。
- 不做 OAuth/内置收件箱连接器；不做邮件/IM 发送（只读 IMAP + 草稿/回执边界）。
- 不做 CRM/客户门户/工单/工时/PSA。
- 不做全功能 GUI/移动端/常驻 daemon。
- 不做通用聊天/情感陪伴。
- 不做插件市场军备、云 MCP 目录、付费 MCP、插件/渠道全家桶。
- 不做平台/托管 SaaS/多租户/SSO/私有化。
- 不做支付托管/e-sign/CA 牌照；不做自动催收。
- 不做准确率/合规认证/SLA 营销；`verified` 不表示真实。
- 不做默认加密的宣称；bundle 明文，加密是后续 opt-in。
- 不做向量检索/记忆导入/第三方“第二大脑”式迁移。

0.5.1 版本内不做（版本边界）：handoff CLI、flow、draft-eml/notice/月报、OAuth/IMAP
写、发送/日历写回、CRM/门户、支付托管/e-sign、云目录/付费 MCP、插件市场、
移动/daemon、AIGC、默认加密、向量检索。**0.5.1 已交付 v23 单次迁移与只读 mail
followup**（见 [CHANGELOG](../CHANGELOG.md) 与 [MAIL-FOLLOWUP.md](MAIL-FOLLOWUP.md)），
不属于未做项。越界项必须有 owner 决策记录，发布说明对未做项写“未做/未验证”。

## 0.5.1 能力边界（满足“主题不砍”）

- **一次** DB schema 跳变（v22 -> v23，单次迁移）；零新出网、零新 runtime 依赖。
- MCP 仍 8 工具 / 5 resources，DSH 仍 6 工具；0.5.0 只加披露元数据，0.5.1 只加
  `advisers_pack_verify` 的 context-pack 目录校验分派（additive、无新数据面）。
- 只读邮件跟进是“本地 header 证据”：不发信、不自动催收；未同步 Sent 邮箱时不得
  当作“已发信”证据（见 [MAIL-FOLLOWUP.md](MAIL-FOLLOWUP.md)）。
- 质量只报“回归门 + 显式 null”，并从 0.5.1 起把发布级报告作为 release asset；
  人类金标仍由 owner 决定（D2，`unknowns.humanGold=null`）；不写“准确率/优于竞品”。
- 分发只做“被宿主调用”（见 [AGENT-INTEROP.md](AGENT-INTEROP.md)）：DSH bundle、
  Claude Code/Cowork 本地插件、Cursor/Codex/Goose/OpenClaw 的 MCP 配置；不做自有平台。
  **DSH 没有官方市场**（只有实验性 custom index）：catalog 是社区条目，0.5.1 只准备
  提交素材，不宣称“已上架/已验证”。

## Pricing / channel（研究建议，不是承诺；owner D1 前只写“待开放”）

PolyForm-NC core free for noncommercial use; commercial use requires a separate
written commercial license; an optional local pro/support subscription at a personal
price point is a research recommendation, not an offer. **The single pricing source of
truth is [PRICING.md](PRICING.md)**; [COMMERCIAL.md](COMMERCIAL.md) and [FAQ.md](FAQ.md)
hold the process/boundary text. In 0.5.1 pricing, evaluation terms and ordering are
**not open yet** (owner D1/D8 pending): no price number, purchase, invoice or free-trial
promise is made. Channel: independent-consultant communities and the local agent hosts
above; make receipts, context packs and an exported bundle the customer-visible artifacts.

## 复核方式与边界

- 竞品事实检索日 2026-11-22（内部二轮研究 09/110–116、125）；链接与数字会漂移，
  对外使用前按同样方法复核日期。
- 本页只描述产品定位与边界，不改 TOS/PRIVACY/SAFETY/DISCLAIMER 文本，也不构成
  法律意见或要约。
- “可验证”的固定口径：`verificationBasis: local-checksums-only`，只证包内自洽，
  不是签名/可信时间戳/来源真实性；法务 D10 前不写“合规”。
