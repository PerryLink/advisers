# Pet Brief producer (Advisers → 桌宠 consumer)

状态：**producer 已实现并发布**——`advisers@0.2.0-preview.71`（npm `next`，2026-11-17）随包发布契约 v0.1 producer；
**本仓源码树已升级契约 v0.2**（`schemaVersion: 2` + `displayPolicy`，待下一次发布）。
消费者：**Advisers 仓内无消费端**；私有仓 `PerryLink/desktop-games`（Pearl）已于 **2026-11-16** 接线（pre-GA、未公开、不随 Advisers 发布物分发）。详见 [`PET-BRIEF-CONSUMERS.md`](PET-BRIEF-CONSUMERS.md)。

契约版本：**v0.2（2026-11-17，proposal + producer 参考实现）**；v0.1（2026-11-14，design contract）保持可读兼容。
契约快照（公开、合成样例）：[`docs/pet-brief/`](pet-brief/README.md)（`schema-v0.2.json` / `example-v0.2.json` / `testcases-v0.2.json`）。
v0.1 canonical 仍以私有 `PerryLink/famling` `docs/` 为准，本机快照 sha：PET-BRIEF.md `8698dd0c`、schema `5ec912cc`、example `12c1ecf4`、testcases `bcec4c94`/`47e86a88`（2026-11-15 复制）。

> `advisers brief` 是 **IntentBrief**（可 `--deep` 调模型），与 Pet Brief 无关，不要混用。

## 1. 命令

```sh
advisers pet-brief --json              # stdout JSON（调试/集成/测试）
advisers pet-brief --out [path]        # 原子写 0600；缺省 ~/.advisers/pet-brief.json
advisers pet-brief --check             # 生成后校验 schema/TTL/禁止字段；失败退出码 1
advisers pet-brief --check --in FILE   # 校验已有 brief 文件（CI/跨仓验收）
advisers pet-brief                     # 人类可读摘要（不输出完整 brief）
```

- 只读：SQLite 以 `readOnly: true` 打开，只 `SELECT`；JSON 模式直接读 `state.json`。不创建/迁移/写入账本，不调用模型，不联网。
  SQLite 在 WAL 库上可能由引擎自行创建空的 `-wal`/`-shm` 辅助文件，但数据库内容不变（测试用 SHA-256 断言）。
- 出错：退出码 1 + stderr 机器可读 `{"error":{"code":"E_STORE|E_WRITE|E_USAGE|E_BRIEF","message":"…"}}`；
  `--check` 的报告走 stdout：`{"ok":false,"errors":[{code,path,message}…]}`。常见 code：
  `E_SCHEMA_VERSION` / `E_TIME_FORMAT` / `E_TIME_ORDER` / `E_EXPIRED` / `E_FORBIDDEN_FIELD` / `E_UNKNOWN_FIELD` /
  `E_MAX_ITEMS` / `E_COUNTS` / `E_DUP_ID` / `E_ENUM` / `E_CONFIDENCE` / `E_DISPLAY_POLICY`。
- v0.2 起输出带 `displayPolicy`（默认 `private`），`schemaVersion: 2`。

### 1.1 CLI 表面待接线（建议，本任务只改 lib）

`bin/advisers.js` 的 `petBrief()` 尚未跟随 v0.2 暴露下列能力（本仓 `lib/` 已支持，接线改动留给 CLI 任务）：

| 建议改动 | 说明 |
|---|---|
| `--print-schema` | 输出 `docs/pet-brief/schema-v0.2.json`（draft 2020-12）或等价的生成 JSON；因 `packages/advisers/package.json` `files` 不含 `docs/`，需把 schema 复制进 `lib/`（如 `lib/pet-brief-schema.json`）并加入 files allowlist，或由常量生成后打印 |
| `--check` 报告加 `warnings` | `validatePetBrief()` 现在返回 `{ok,errors,warnings,brief}`；CLI 目前只打印 `errors`。建议输出 `warnings: result.warnings`（**不改变退出码**：warning 不 fail） |
| `--check --strict` | 映射 `requireDisplayPolicy: true`（缺 displayPolicy → `E_DISPLAY_POLICY`）与 `acceptLegacy: false`（v0.1 → `E_SCHEMA_VERSION`），供 CI 收紧 |
| `--display-policy public\|private\|none` | 透传 `buildPetBrief(..., { displayPolicy })`；默认 `private`，`public` 必须显式选择 |
| 帮助行 / 注释 | 把 `contract v0.1` 文案改为 v0.2（`bin/advisers.js:294,681` 附近） |

## 2. 实现位置

| 文件 | 内容 |
|---|---|
| `packages/advisers/lib/pet-brief.js` | `buildPetBrief()` 纯投影、`validatePetBrief()`（v0.2 校验 + legacy warning）、`writePetBriefAtomic()` |
| `packages/advisers/lib/pet-brief-store.js` | `readLedgerSnapshotReadOnly()`：只读 SQLite/JSON 快照 |
| `packages/advisers/lib/sqlite.js` | `SqliteStore` 构造器新增 `{ readOnly: true }` 选项（默认行为不变，最小改动） |
| `packages/advisers/bin/advisers.js` | `pet-brief` 子命令 + help 行（最小改动；v0.2 CLI 面见 §1.1） |
| `packages/advisers/test/pet-brief.test.js` | 25 个 producer 单元/CLI/隐私/只读/契约快照测试 |
| `docs/pet-brief/` | 公开契约快照：schema v0.2、合成 example、26 条测试向量（脱敏） |

不新增依赖（手写 schema 校验，未引入 ajv）；不改存储表结构、core 类型、账本 schema、产品定位。

## 3. 数据映射（确定性投影）

| brief 字段 | 来源 | 规则 |
|---|---|---|
| `schemaVersion` | 常量 | v0.2 = `2` |
| `displayPolicy` | 调用参数 | `public` / `private`（默认）/ `none`；语义见 §4.1 |
| `today[]` | `Matter`（active） | `title`；`status`：有今日/逾期公开承诺 → `doing`，否则 `open`；按紧急度/updatedAt/id 排序 |
| `commitments[]` | `Commitment`（open，有 `dueAt`，matter 公开） | `id`/`matter`；`who`=creditor、`what`=action、`due`=Asia/Shanghai 日期；`risk`：逾期或今天=high，≤3 天=medium，否则 low；`confidence`：有证据 0.95，否则 0.75 |
| `risks[]` | 同一批公开承诺推导 | 逾期/今天=high（0.95/0.9）、≤3 天=medium 0.72、无截止=medium 0.75、同日 ≥2 截止=medium 0.72；`evidence`=承诺 id（不是正文） |
| `facts[]` | `Fact`（confirmed，未过期） | `confidence >= 0.7`；只含公开 matter 的事实与全局事实；subject/value 截断 + 脱敏 |
| `mood` | 工作量推导 | 有 high risk → `concerned`；有承诺/风险/进行中事项 → `focused`；否则 `calm`（`pleased` 预留，不表示情感） |
| `suggestedLines` | 复用 brief 内既有字段拼接 | ≤3 条、每条 ≤40 码点；每条必须能在 brief 字段中找到 ≥2 字连续片段（可追溯），不虚构事实 |
| `counts` | 与四个数组长度严格一致 | consumer 会交叉校验，不一致即整份丢弃 |
| `redactions` | 人类可读脱敏记录 | 不含密钥，仅说明脱敏/排除策略 |

时间：`expiresAt = generatedAt + 5min`（ISO 8601 带时区，默认 UTC `Z`）；每个 section ≤10 项，超出按风险/到期/id 取前 10。

## 4. 隐私与失败模式

- **secrecy**：matter `secrecy >= 2` 的事项整体排除（today/commitments/risks/facts 均不出，也不出标题），并在 `redactions` 记录排除数量；不做聚合计数泄漏。
- **confidence**：`< 0.7` 的事实直接丢弃；承诺/风险用上表的确定性置信度（均 ≥0.72）。
- **脱敏**：creditor / fact subject / matter participants 中被判定为“人名”的值替换为 `某客户`，并在 title/action/summary/value 中替换同名文本；常见“给王工/向李总”式文本再做兜底替换。**这是启发式脱敏，不是 NER**（见 §6）。
- **排除内容**：承诺证据 quote、文档/邮件/聊天正文、matter summary/openQuestions、模型推理/提示词、密钥、情感字段一概不进 brief。
- **失败模式**：存储不可用 → 非零+`E_STORE`（consumer 侧 idle）；空账本合法（数组全空+合法头，`mood: calm`）；`--out` 为 opt-in 且 0600 + 同目录临时文件 → fsync → rename 原子替换。

### 4.1 displayPolicy（v0.2 新增）

| 值 | 何时使用 | consumer 必须做什么 |
|---|---|---|
| `public` | 用户显式选择；不默认 | 可在任何可见场景展示气泡/面板/语音；仍不得跳过脱敏 |
| `private`（默认） | 所有未显式选择的输出 | 仅在个人场景展示：面板/气泡 **30s 自动收起**、**一键隐藏**；检测到屏幕共享/录制/他人可见时隐藏文本，只保留姿态 |
| `none` | 用户要求完全隐藏 | **不得渲染/保留任何 brief 派生内容**（文本、语音、mood/计数派生态），等价于禁用 |

- 缺失 `displayPolicy`（v0.1 brief）按 `private` 处理；`buildPetBrief` 永远显式写出该字段。
- `public` 只能显式选择：`buildPetBrief(ledger, { displayPolicy: 'public' })`（未来 CLI `--display-policy`）。

### 4.2 旁观者可见性风险（新维度）

现有隐私覆盖的是“**数据是否出账本**”（secrecy/脱敏/0600），不覆盖“**屏幕被谁看见**”：

- 详情面板会直接渲染 `today[].title`、`commitments[].who/what/due/risk`、`risks[].summary`；即便姓名已换成 `某客户`，“某客户 · 发报价 · 今天到期 · high”仍是可被旁观者读到的工作信息。
- `mood`/风险计数本身是**工作压力侧信道**；`private`/`none` 下应可隐藏或不使用。
- **producer 无法感知旁观者/屏幕共享**，因此 `displayPolicy` 是**契约约束**而非技术强制；执行责任在 consumer（自动收起、一键隐藏、屏幕共享检测）。当前已接消费端还没有这些行为（见 `PET-BRIEF-CONSUMERS.md` §4 风险 R1）。

## 5. 验收（本机实测 2026-11-17）

```sh
cd /mnt/d/Projects/dsh/plugins/advisers/packages/advisers
node --experimental-strip-types --test test/pet-brief.test.js   # 25/25 pass
# 仓根全量：pnpm -r test → 260 tests / 260 pass / 0 fail（8 packages；其中 packages/advisers 175/175）
```

- 覆盖：契约字段/上限/置信度/时区+TTL/禁止字段/重复 id/counts 一致性/空账本/确定性；姓名与证据 quote 不泄漏；secrecy≥2 全排除；`--json` 只读（DB SHA-256 不变）；`--out` 0600 原子且无临时残留；`--check` 通过/拒绝；缺库/用法错误机器可读。
- v0.2 新增覆盖：`displayPolicy` 默认 `private` / 显式三态 / 非法枚举拒绝；v0.1 brief 接受且返回 `W_LEGACY_SCHEMA_VERSION`+`W_MISSING_DISPLAY_POLICY`（不 fail）；`acceptLegacy:false` 与 `requireDisplayPolicy:true` 严格模式 fail closed；公开 schema 快照与实现常量一致；example 被 `validatePetBrief` 接受；26 条契约向量逐条对照。
- 消费者侧的 20 条 v0.1 契约向量在 desktop-games `tests/pet-brief-consumer.test.ts` 中执行（见该仓 `docs/contracts/pet-brief/README.md`）；v0.2 的 `displayPolicy` 向量见本仓 `docs/pet-brief/testcases-v0.2.json`（consumer 待同步，见 `PET-BRIEF-CONSUMERS.md`）。

## 6. 已知限制 / 未做

- **npm 发布**：v0.1 producer 已随 `advisers@0.2.0-preview.71` 发布（npm `next`，2026-11-17）；本仓 v0.2 改动尚未发布（下一次 preview 携带）。
- **未做真实数据集成**：测试用合成 fixture + 临时 store；没有在真实用户账本上跑过（隐私边界：不应提交真实数据）。
- **消费端不在本仓**：Advisers 仓无桌宠 UI/传输实现；私有消费端 desktop-games 已接线但 **pre-GA、未公开**，其 README/合同文档部分滞后于代码（见 `PET-BRIEF-CONSUMERS.md`）。
- **消费者版本兼容风险**：desktop-games 当前硬校验 `schemaVersion === 1`，会拒绝 v0.2 输出（SCHEMA_VERSION→idle）；发布 v0.2 producer 前须先升级 consumer 接受 `1|2`（见 `PET-BRIEF-CONSUMERS.md` §4 R2）。
- **脱敏是启发式**：只覆盖“已知人名值 + 常见 `<动词><姓><职务>` 文本”；不含 NER/全量姓名库，极限 case 可能漏掉 title/action 中的陌生姓名。若需默认全文本脱敏，应改契约（opt-in 策略）而不是本投影。
- **suggestedLines 可追溯性**：producer 侧用“2 字连续片段”约束；consumer 再独立校验（claims guard），仍属启发式而非语义证明。
- **displayPolicy 只是契约**：producer 无法强制 consumer 行为；v0.2 已接消费者尚未实现自动收起/一键隐藏/屏幕共享检测。
- 若 famling/desktop-games 冻结新版契约，需同步 `lib/pet-brief.js` 的常量与校验（`schemaVersion` 闸门会拒绝未知 major）。

## 7. 版本兼容策略（v0.1 → v0.2 迁移）

| 输入 | `schemaVersion` | `displayPolicy` | `validatePetBrief` 默认行为 |
|---|---|---|---|
| v0.1（`.71` 及更早 producer 输出） | 1 | 缺失 | **接受**；`W_LEGACY_SCHEMA_VERSION` + `W_MISSING_DISPLAY_POLICY`；按 `private` 处理 |
| v0.2 | 2 | public/private/none | 严格校验；缺失 `displayPolicy` → warning（`requireDisplayPolicy:true` 时 `E_DISPLAY_POLICY`） |
| 未知 major | ≥3 | — | `E_SCHEMA_VERSION`（fail closed） |

- **warning 不改变 `ok`/退出码**：`--check` 对旧 brief 报 warning 而非 fail。
- 迁移顺序（建议）：`consumer 接受 v1|v2` → 发布 v0.2 producer → 一段时间后 `consumer 只接受 v2` / producer 可选只发行 v2。
- 契约版本与包版本解耦：`schemaVersion` 是契约 major；`advisers` 包版本是发布渠道版本（当前 `0.2.0-preview.71`）。

## 8. 链接

- 公开契约快照：[`docs/pet-brief/`](pet-brief/README.md)（schema v0.2 / example / testcases / 版本矩阵）
- 消费者清单与验收向量：[`docs/PET-BRIEF-CONSUMERS.md`](PET-BRIEF-CONSUMERS.md)
- 私有消费仓（只读参考）：`/mnt/d/Projects/dsh/desktop-games` `src/presence/pet-brief.ts`、`src/pet/advisers/face.ts`、`docs/contracts/pet-brief/`
