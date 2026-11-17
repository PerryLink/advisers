# Pet Brief 契约快照 — v0.2

状态：**v0.2（2026-11-17，proposal + producer 参考实现；消费端同步中）**。
生产者实现：`packages/advisers/lib/pet-brief.js`（`schemaVersion: 2`，新增 `displayPolicy`）。
生产者文档：[`../PET-BRIEF-PRODUCER.md`](../PET-BRIEF-PRODUCER.md) · 消费者清单：[`../PET-BRIEF-CONSUMERS.md`](../PET-BRIEF-CONSUMERS.md)

> 本目录是 Advisers 仓内的**公开契约快照**，目的：第三方壳不必依赖私有仓即可实现 consumer。
> v0.1（`schemaVersion: 1`）的 canonical 仍是私有 `PerryLink/famling` 仓的 design contract
> （快照 sha 见 `../PET-BRIEF-PRODUCER.md` §契约版本）；**v0.2 的增量（`displayPolicy`）以本目录为准**，
> 待已接消费者（desktop-games，私有、pre-GA）同步校验后冻结。

## 文件

| 文件 | 作用 |
|---|---|
| `schema-v0.2.json` | JSON Schema（draft 2020-12，`additionalProperties: false`，`displayPolicy` 必填） |
| `example-v0.2.json` | 合法示例（全合成数据，`displayPolicy: private`） |
| `testcases-v0.2.json` | 26 条测试向量（20 条 v0.1 继承 + 6 条 v0.2 displayPolicy/兼容性） |
| `README.md` | 本文件 |

所有样例均为**脱敏合成数据**：人名统一为 `某客户`，承诺/事实/ID 为虚构；不得替换成真实客户数据。

## displayPolicy 语义（v0.2 新增）

| 值 | 生产者默认？ | consumer 必须做什么 |
|---|---|---|
| `public` | 否（必须显式选择） | 可在任何可见场景展示气泡/面板/语音；仍不得跳脱敏规则 |
| `private` | **是**（默认） | 仅在个人场景展示：面板/气泡 **30s 自动收起**、**一键隐藏**；检测到屏幕共享/录制/他人可见时应隐藏文本，只保留姿态 |
| `none` | 否 | **不得渲染或保留任何 brief 派生内容**（含文本、语音、mood/计数派生态），等价于禁用（idle） |

- 缺失 `displayPolicy`（v0.1 brief）按 **`private`** 处理；生产者 `buildPetBrief` 永远显式写出该字段。
- `mood`/风险计数属于工作压力侧信道：`private` 下也应随时可隐藏；`none` 下不得使用。
- 生产者**无法**感知旁观者，旁观者策略由 consumer 执行；本字段只是契约约束，不是技术强制。

## 版本兼容矩阵

| 输入 | schemaVersion | displayPolicy | `validatePetBrief` 结果 |
|---|---|---|---|
| v0.1 brief（`.71` 及更早） | 1 | 缺失 | **接受** + `W_LEGACY_SCHEMA_VERSION` + `W_MISSING_DISPLAY_POLICY`（按 `private`） |
| v0.2 brief | 2 | public/private/none | 严格校验；缺失 → warning（默认） |
| v0.2 brief，严格模式 | 2 | 缺失 | `requireDisplayPolicy: true` → `E_DISPLAY_POLICY` |
| 未知版本 | ≥3 | — | `E_SCHEMA_VERSION`（fail closed） |
| v0.1 brief，`acceptLegacy: false` | 1 | — | `E_SCHEMA_VERSION` |

**已接消费者（desktop-games）当前硬校验 `schemaVersion === 1`**：v0.2 生产者输出会被其拒为
`SCHEMA_VERSION`→idle。rollout 顺序：先让 consumer 接受 `1|2`（缺失 displayPolicy 按 private），
再发布输出 v0.2 的 producer；见 `../PET-BRIEF-CONSUMERS.md` §4。

## 如何验收

生产端单测（含本目录 schema/example/testcases 与实现一致性断言）：

```sh
cd packages/advisers
node --experimental-strip-types --test test/pet-brief.test.js
```

手工校验一个 brief 文件（CLI 的 `--check --in` 按**当前时间**判 TTL；`example-v0.2.json` 的时间戳固定为
2026-11-17 09:00–09:05 +08，直接跑会得到 `E_EXPIRED`，这是预期行为）：

```sh
# 已有账本的环境：生成 fresh brief 后立即校验（TTL 5 分钟）
advisers pet-brief --out ~/.advisers/pet-brief.json
advisers pet-brief --check --in ~/.advisers/pet-brief.json   # ok:true
```

在 Node 里用固定 `now` 直接校验 example/向量（无 ajv、无新依赖）：

```js
import { validatePetBrief } from './packages/advisers/lib/pet-brief.js'
const checked = validatePetBrief(rawJsonOrObject, { now: Date.parse('2026-11-17T09:02:00+08:00') })
// checked: { ok, errors, warnings, brief }
```

## 测试向量（26）

| # | ID | 期望 | 覆盖 |
|---|---|---|---|
| 1 | `valid` | accept | happy path（v0.2） |
| 2 | `empty` | accept | 空账本 → idle |
| 3 | `expired` | reject | TTL |
| 4 | `malformed_json` | reject | 解析失败 |
| 5 | `unknown_schema` | reject | 版本闸门（99） |
| 6 | `too_many_commitments` | reject | 每节 ≤10 |
| 7 | `low_confidence_omit` | accept_omit | confidence <0.7 由 consumer 忽略 |
| 8 | `forbidden_reasoning` | reject | 无 CoT |
| 9 | `forbidden_secret` | reject | 无密钥字段 |
| 10 | `high_risk_remind` | accept | 高风险 → remind |
| 11 | `no_risk` | accept | 无风险 → 不提醒 |
| 12 | `unknown_line_source` | fallback | consumer claims guard：不可追溯则安全句 |
| 13 | `redacted` | accept | redactions 是日志不是密钥 |
| 14 | `ttl_boundary` | reject | expiresAt 必须 > generatedAt |
| 15 | `missing_timezone` | reject | ISO 8601 必须带时区 |
| 16 | `invalid_mood` | reject | mood 枚举 |
| 17 | `duplicate_ids` | reject | id 唯一 |
| 18 | `counts_mismatch` | reject | counts 与数组一致 |
| 19 | `expires_before_generated` | reject | 时间顺序 |
| 20 | `user_opt_out` | skip | 用户关闭 → 不读（consumer 策略） |
| 21 | `legacy_v0_1` | accept_warn | v0.1 兼容：schemaVersion 1 + 无 displayPolicy |
| 22 | `missing_display_policy` | accept_warn | 缺字段按 private，不 fail |
| 23 | `invalid_display_policy` | reject | 未知枚举 → `E_ENUM` |
| 24 | `default_policy_private` | accept | 默认 private |
| 25 | `display_public` | accept | 显式 public 可被接受 |
| 26 | `display_none` | accept | 显式 none 可被接受 |

`accept_omit` / `fallback` / `skip` 是 consumer 侧语义；producer 校验器对它们的判断分别是
「schema 合法」「schema 合法」「不适用」。
