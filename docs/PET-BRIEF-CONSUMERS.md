# Pet Brief 消费者清单与消费契约（v0.2）

状态：**已接消费者 2 个（1 个私有 pre-GA、1 个公开 DSH 插件）；Advisers 发布物不含消费端**。两个消费端均已接受契约 v0.2（`schemaVersion: 1|2`，缺失 `displayPolicy` 按 `private`），并实现了 `private` / `none` 的展示约束。
产出：2026-11-17（只读核对；该消费端不在本仓 CI 中运行）。
配套文档：生产者/`displayPolicy` 语义见 [`PET-BRIEF-PRODUCER.md`](PET-BRIEF-PRODUCER.md) §4.1；契约快照与测试向量见 [`docs/pet-brief/`](pet-brief/README.md)。

## 0. 一句话

**Advisers 拥有账本与投影；消费者只轮询一个 5 分钟过期的脱敏 JSON，不回写、不联网、不直连数据库。**
已接消费者是 PerryLink 的私有桌面宠物仓（Pearl/Famling 方向，2026-11-17 接受 v0.2）与公开的 `dsh-famling` DSH 插件（2026-11-20 通过 0.3.0 兼容核对）
（`schemaVersion: 1|2`，缺失 `displayPolicy` 按 `private`），并实现了 v0.2 的展示约束。

## 1. 已接消费者

| 消费者 | 仓库/可见性 | 契约版本 | 传输 | 状态 | 证据 |
|---|---|---|---|---|---|
| Pearl（私有桌面宠物） | 私有仓，**pre-GA、未公开** | **v0.1 + v0.2**（`schemaVersion 1/2`；`displayPolicy` 缺失按 `private`） | 固定本地文件 `~/.advisers/pet-brief.json` + Tauri command | 已接线（2026-11-16）；默认关闭，用户手动开启；v0.2 展示约束已实现 | 见 §1.1 |
| `dsh-famling`（DSH 客户端插件） | 公开仓 `PerryLink/dsh-famling`；插件独立发布 | **v0.2**（`schemaVersion 2`） | DSH Host bridge `op:"brief"` 只读 `~/.advisers/pet-brief.json`（≤128 KiB，5 分钟 TTL） | 已接线并完成 0.3.0 兼容核对（2026-11-20） | `plugins/dsh-famling/docs/PET-BRIEF-0.3.0-COMPAT-2026-11-20.md` |
| Advisers 仓自身 | 公开仓 | — | — | **无消费端**（只有 producer） | 本仓 `packages/` 无桌宠 UI |

> 上表之外没有已接消费者。候选壳（Famling/Pearl 上游、Familiar、fishpet、VPet/Live2D 系）均为**未接**候选，
> 本仓不为其背书；接入方式见本文件 §3（文件轮询 + TTL + 校验）。

### 1.1 私有消费端核对要点（只读核对 2026-11-17）

私有消费端的实现与契约文件不随本仓库发布；以下为与互操作相关、不含内部路径的实现事实：

- **校验**：schema/TTL/枚举/上限/counts/重复 id/禁止字段/未知字段；未知 major fail closed。
- **版本兼容**：接受 `schemaVersion 1|2`；v0.1 brief 归一化为 `private` 并给 warning；缺 `displayPolicy` 按 `private`；非法枚举拒绝。
- **展示约束（v0.2）**：`private` 面板 30 秒自动收起，窗口失焦/页面不可见时隐藏内容；`none` 不读取/不渲染/不保留任何 brief 派生内容（等价禁用）。
- **传输**：Tauri command 只读固定路径，128 KiB 上限、8s 读超时、60s 轮询（失败指数退避）；开关默认关闭，关闭时完全不读文件。
- **测试**：该仓 consumer 测试 16/16 通过（2026-11-17 跨仓核对；不在本仓 CI 中运行）。

消费端行为要点：

- 纯函数模块无 I/O、无网络、无模型；读文件由调用方/Tauri 负责。
- `validatePetBrief` 返回 `accept | reject | skip`；`accept` 时 `confidence < 0.7` 的项不参与投影（`omitted`）。
- 过期/非法/空 brief → `null` directive（idle），不编造记忆；`secrecy >= 2` 由 producer 排除（schema 无 secrecy 字段）。
- `suggestedLines` **刻意不进渲染层**，只经 claims guard 校验后供未来的 voice/字幕层使用。
- 开关默认关闭（`localStorage` flag），关闭时完全不读文件。
- 显式屏幕共享/录制检测**尚未实现**；`private` 约束依赖失焦/页面可见性/定时器（见 §4 R1）。

## 2. 契约版本与兼容

| 维度 | 已接消费者 | 本仓 producer |
|---|---|---|
| 契约 | **v0.1 + v0.2**（接受 `1/2`；v0.2 展示语义已实现） | **v0.2**（`schemaVersion: 2`，新增 `displayPolicy`） |
| 版本校验 | 接受 `1/2`；未知 major fail closed | 接受 `1`（warning）与 `2`（严格）；未知 major fail closed |
| displayPolicy | 识别并实现 `public/private/none`；缺失按 `private` | 默认 `private`；`public/private/none` 枚举 |
| 契约来源 | 私有契约快照（不随本仓发布） | 本仓 [`docs/pet-brief/`](pet-brief/README.md) 公开快照 + `lib/pet-brief.js` 参考实现 |

**迁移现状（2026-11-17）**：

1. ✅ consumer 已把版本闸门改为接受 `1 | 2`；缺失 `displayPolicy` 按 `private` 处理；
2. ✅ producer 已随 `0.2.0` 发布 v0.2（`displayPolicy` 默认 `private`）；
3. ⏳ consumer 已实现 `displayPolicy` 展示约束；显式屏幕共享/录制检测与“只接受 v2”尚未开始。

反序的后果（历史风险，记录备查）：v0.2 producer 若先于消费端发布，已接消费者会把每份 brief 判为 `SCHEMA_VERSION` → 永远 idle（不是崩溃，但功能静默消失）。该风险在 2026-11-17 消费端升级后已解除。

消费端最小 patch 形态（示意，非本仓代码）：

```ts
const SUPPORTED_SCHEMA_VERSIONS = [1, 2] as const
if (typeof value.schemaVersion !== 'number' || !SUPPORTED_SCHEMA_VERSIONS.includes(value.schemaVersion as 1 | 2)) { /* reject */ }
const displayPolicy = value.displayPolicy ?? 'private' // v0.1 默认 private
if (!['public', 'private', 'none'].includes(displayPolicy)) { /* reject E_ENUM */ }
```

## 3. 传输与运行时（已接消费者）

| 项 | 实现 |
|---|---|
| 生产 | `advisers pet-brief --out ~/.advisers/pet-brief.json`（0600，同目录临时文件 + fsync + rename 原子替换） |
| 消费 | Tauri command 读固定路径 → 前端 `validatePetBrief` → `AdvisersFaceController` → projector/渲染 |
| 默认关闭 | 用户点开关才读；关闭时不读文件、不报错 |
| 轮询 | 60s（`ADVISERS_SYNC_INTERVAL_MS`），失败指数退避到 300s；手动重试绕过退避 |
| 超时/上限 | 单次读 8s（超时后停止等待并忽略迟到结果）；brief ≤128 KiB（前后端各校验一次） |
| 过期 | `expiresAt` 5 分钟；过期 → idle/stale 状态，不把旧承诺当当前事项 |
| 网络 | **无**：本地文件，无 socket/stdio/MCP/HTTP；不联网、不调模型 |
| 回写 | **无**：consumer 不写 Advisers 存储；pat/drag/talk 不回传 |
| 浏览器 | 无 Tauri 时状态 `NO_TRANSPORT`（unavailable），不伪造数据 |

## 4. 限制与风险

| # | 风险 | 影响 | 缓解/负责人 |
|---|---|---|---|
| R1 | **旁观者可见性**：详情面板直接显示 `today[].title` 与 `commitments[].who/what/due/risk`；`private` 已实现 30s 自动收起与失焦/页面不可见隐藏，但**显式屏幕共享/录制检测未实现**；`mood`/风险计数是工作压力侧信道 | 客户/同事/直播观众可读到“某客户 · 发报价 · 今天到期”；隐私叙事出现缺口 | `displayPolicy`（默认 private）+ consumer 展示约束；producer 无法强制 |
| R2 | **版本错配（已解决 2026-11-17）**：consumer 曾硬校验 `schemaVersion === 1`，v0.2 producer 输出会被拒（静默 idle） | 发布 v0.2 后桌宠“失联” | 消费端已接受 `1/2`，按 §2 顺序迁移；建议在临时 `ADVISERS_HOME` 做往返验收（§5.3） |
| R3 | **单点依赖**：唯一消费者是私有、pre-GA 仓；契约 canonical 仍在私有 famling 方向 | 第三方壳无法稳定实现；消费者停更则端到端叙事断电 | 本仓公开契约快照 + 多壳候选；接入方式以文件轮询为准 |
| R4 | **跨仓文档/代码滞后**：私有消费仓内部文档可能滞后于代码；Tauri command 是同步读，前端超时只是忽略迟到结果（Rust 侧不可取消） | 审计口径冲突；坏网络下线程占用 | 以代码/本文件为准；消费仓自行更新文档（本仓不改其文件） |
| R5 | **建议台词未进渲染层**：`suggestedLines` 被 claims guard 挡在投影外，voice/字幕层未接 | “会说话的简报”未交付 | 后续 voice 层接入；保持 claims guard |
| R6 | **无真实数据验收**：producer/consumer 只用合成 fixture；消费端 16 test 未纳入本仓 CI | 真实账本上可能暴露字段/脱敏问题 | 真实数据不得入库/入测试；用脱敏合成 + 人工 review |
| R7 | **脱敏是启发式**（非 NER）：陌生姓名可能漏进 title/action/面板 | 隐私泄漏 | 契约层面的 opt-in 全文本脱敏；用户可关 |
| R8 | **displayPolicy 只是契约**：producer 无法感知屏幕共享/旁观者 | 消费者不实现就等于没有 | consumer 验收向量（§5.2）强制行为项 |

## 5. 验收向量

### 5.1 本仓 producer 侧（可执行，已纳入 CI）

- 文件：[`docs/pet-brief/testcases-v0.2.json`](pet-brief/testcases-v0.2.json) —— 26 条（20 条 v0.1 继承 + 6 条 displayPolicy/兼容性），由
  `packages/advisers/test/pet-brief.test.js` 逐条执行（`validatePetBrief` 对照 `expect`）。
- 关键断言：`valid/empty/high_risk_remind/no_risk/redacted/display_public/display_none` → accept；
  `low_confidence_omit`/未知台词来源 → accept/fallback；`expired/ttl_boundary/counts_mismatch/duplicate_ids/...` → reject；
  `legacy_v0_1`/`missing_display_policy` → accept + warning（**不 fail**）。
- example：`docs/pet-brief/example-v0.2.json` 必须被 `validatePetBrief` 接受（测试已断言）。

命令：

```sh
cd packages/advisers
node --experimental-strip-types --test test/pet-brief.test.js   # 28/28 pass
```

### 5.2 私有消费端侧（另仓验收，本仓 CI 不运行）

现状：该仓 consumer 测试 **16/16 通过**（2026-11-17 跨仓核对；其中含 v0.2 schema/displayPolicy 校验向量）。展示层行为项已在实现中落地，以下向量作为后续回归验收目标：

| 向量 | 期望 |
|---|---|
| `legacy_v0_1_no_policy`（schemaVersion 1，无 displayPolicy） | accept，按 `private` 处理 |
| `v2_private` | accept |
| `v2_public` | accept，按 public 语义渲染 |
| `v2_none` | accept，但**不读取/不渲染/不保留**任何 brief 派生内容（等价 disabled） |
| `invalid_display_policy`（`audience`） | reject（整份丢弃 → idle） |
| `unknown_schema_3` | reject |
| `private_autohide`（行为测试） | 面板 30s 自动收起、一键隐藏；失焦/页面不可见时隐藏文本；显式屏幕共享检测为后续目标 |
| `none_no_side_channel`（行为测试） | `mood`/counts 也不驱动姿态/气泡 |

### 5.3 跨仓往返（手工）

```sh
# 1) 生产：在已初始化账本的机器上只读生成（--out 写到 /tmp，不碰账本）
advisers status >/dev/null   # 先确认账本可用（缺失时 pet-brief 会 E_STORE 退出 1）
advisers pet-brief --out /tmp/pet-brief.json
# 2) 消费端校验（私有消费端 checkout；已接受 schemaVersion 1|2）
cd <private-consumer-checkout>
BRIEF=/tmp/pet-brief.json node --import tsx --input-type=module -e \
  "import { readFileSync } from 'node:fs'; import { validatePetBrief } from './src/presence/pet-brief.ts'; const r = validatePetBrief(readFileSync(process.env.BRIEF, 'utf8'), { now: Date.now() }); console.log(r.status, r.errors ?? [])"
```

> 消费端已接受 v0.2；`advisers@0.2.0` 的 producer 输出 `schemaVersion: 2`，可直接用于上述往返验收；
> v0.1 brief 仍按 legacy 可读。

## 6. 契约变更检查清单（改 producer / 加 consumer 时）

1. 改 `lib/pet-brief.js` 常量/校验 → 同步 `docs/pet-brief/schema-vN.json` + example + testcases（本仓测试会断言 schema 与实现一致）。
2. 版本策略：新增字段优先作为 vN 的可选字段 + warning，**不要**直接收紧 consumer 已发出的旧版本。
3. 更新本文件 §1/§2/§4/§5 与 `PET-BRIEF-PRODUCER.md` §7 兼容矩阵。
4. consumer 侧先改校验、再改行为、最后改 CI；跨仓 PR 需带往返验收（§5.3）。
5. 不把真实客户数据写进任何样例/测试/文档。

## 7. 链接

- 生产者文档：[PET-BRIEF-PRODUCER.md](PET-BRIEF-PRODUCER.md)（§4.1 displayPolicy 语义、§7 兼容矩阵）
- 公开契约快照：[docs/pet-brief/README.md](pet-brief/README.md)（schema v0.2 / example / 26 条向量）
- 私有消费端：不在本仓库，其实现与契约文件不随本仓发布，因此这里不引用内部路径。
- v0.1 契约正文（canonical）：私有消费端契约目录（不随本仓发布）；公开的 v0.2 快照见 `docs/pet-brief/`。
