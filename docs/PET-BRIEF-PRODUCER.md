# Pet Brief producer (Advisers → Famling/Pearl)

状态：**已实现 producer（只读投影 + CLI + `--check` + 测试）；未发布 npm、未接桌宠 UI。**
契约版本：**v0.1（2026-11-14，status: design contract）**。
本机契约快照：`/mnt/d/Projects/dsh/desktop-games/docs/contracts/pet-brief/`
（2026-11-15 自私有仓 `PerryLink/famling` `docs/` 复制；sha：PET-BRIEF.md `8698dd0c`、schema `5ec912cc`、example `12c1ecf4`、testcases `bcec4c94`/`47e86a88`。canonical 仍以 famling 为准。）

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
  `E_MAX_ITEMS` / `E_COUNTS` / `E_DUP_ID` / `E_ENUM` / `E_CONFIDENCE`。

## 2. 实现位置

| 文件 | 内容 |
|---|---|
| `packages/advisers/lib/pet-brief.js` | `buildPetBrief()` 纯投影、`validatePetBrief()`、`writePetBriefAtomic()`（新文件） |
| `packages/advisers/lib/pet-brief-store.js` | `readLedgerSnapshotReadOnly()`：只读 SQLite/JSON 快照（新文件） |
| `packages/advisers/lib/sqlite.js` | `SqliteStore` 构造器新增 `{ readOnly: true }` 选项（默认行为不变，最小改动） |
| `packages/advisers/bin/advisers.js` | `pet-brief` 子命令 + help 行（最小改动） |
| `packages/advisers/test/pet-brief.test.js` | 18 个 producer 单元/CLI/隐私/只读测试（新文件） |

不新增依赖（手写 schema 校验，未引入 ajv）；不改存储表结构、core 类型、账本 schema、产品定位。

## 3. 数据映射（确定性投影）

| brief 字段 | 来源 | 规则 |
|---|---|---|
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

## 5. 验收（本机实测 2026-11-15）

```sh
cd /mnt/d/Projects/dsh/plugins/advisers/packages/advisers
npm test                      # 单包：165/165 pass（含本功能 18 个）
# 仓根全量：npm test = pnpm -r test → 250/250 pass, 0 fail（8 packages；新增 18 后 232→250）
```

- 覆盖：契约字段/上限/置信度/时区+TTL/禁止字段/重复 id/counts 一致性/空账本/确定性；姓名与证据 quote 不泄漏；secrecy≥2 全排除；`--json` 只读（DB SHA-256 不变）；`--out` 0600 原子且无临时残留；`--check` 通过/拒绝；缺库/用法错误机器可读。
- 消费者侧的 20 条契约向量在 desktop-games `tests/pet-brief-consumer.test.ts` 中执行（见该仓 `docs/contracts/pet-brief/README.md`）。

## 6. 已知限制 / 未做

- **未发布 npm**：`advisers` preview 线仍卡人工 OTP；本功能随下次发布才会到用户手里（不处理 OTP）。
- **未做真实数据集成**：测试用合成 fixture + 临时 store；没有在真实用户账本上跑过（隐私边界：不应提交真实数据）。
- **未接桌宠 UI/传输**：未改 famling/desktop-games 的 `pet.html`/主流程；没有 daemon、文件监听、stdio/MCP/IPC 选型落地。`--out` 文件路径缺省 `~/.advisers/pet-brief.json`，由消费端自行轮询。
- **脱敏是启发式**：只覆盖“已知人名值 + 常见 `<动词><姓><职务>` 文本”；不含 NER/全量姓名库，极限 case 可能漏掉 title/action 中的陌生姓名。若需默认全文本脱敏，应改契约（opt-in 策略）而不是本投影。
- **suggestedLines 可追溯性**：producer 侧用“2 字连续片段”约束；consumer 再独立校验（claims guard），仍属启发式而非语义证明。
- 未改 schema/check 逻辑本身；若 famling 冻结新版契约，需同步 `lib/pet-brief.js` 的常量与校验（`schemaVersion` 闸门会拒绝未知 major）。
