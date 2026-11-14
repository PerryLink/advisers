# Advisers 承诺抽取 · 中文金标脚手架（50 → 150）

> ⚠️ **状态声明（必须保留）**
> 本目录的 `commitments.zh.gold.seed.jsonl` 是 **AI 预标草稿（seed）**，每条都带
> `pending_human_review: true`，**不是人工金标**。它只用于跑通脚手架和早期回归，
> **不得**在 README、PR、发布说明或任何对外材料中把它称为“人工金标”“已达标”
> 或“通过了 150 条人工评测”。人工复核完成后应另存为
> `commitments.zh.gold.human.jsonl`（或带日期版本），不要原地改 seed 冒充人工金标。

目标：把中文承诺抽取（`capture`）从当前的 10 条 smoke seed 扩展到 150 条金标。
当前进度：**150 条已由 user-authorized agent 双评审（不是独立人工复核）**，文件为
`commitments.zh.gold.reviewed.jsonl`；原始 50 条 seed 与 100 条生成候选仍保留。

## 文件

| 文件 | 作用 |
|---|---|
| `commitments.zh.gold.schema.json` | 单条 JSONL 记录的 JSON Schema（draft 2020-12 子集） |
| `commitments.zh.gold.seed.jsonl` | **50 条 AI 预标 seed**，每行一个 JSON 对象；全部 `pending_human_review: true` |
| `commitments.zh.gold.seed.051-150.jsonl` | 100 条 AI 生成的候选（gold-051..150），全部待评审 |
| `commitments.zh.gold.reviewed.jsonl` | **150 条 user-authorized agent 双评审版**：`pending_human_review:false`、`review_mode:user_authorized_agent_double_review`，附 `reviewers`/`reviewed_at`/`review_note` |
| `reviews/reviewer-a.jsonl` / `reviewer-b.jsonl` | 两份独立评审结论（A 13 fix / B 2 fix），用于审计 |
| `eval/run-capture-gold.mjs` | 离线 schema 校验（`--dry-run`）与真实模型指标计算（默认读 seed，可 `--file` 指定 reviewed） |
| `eval/corpus/commitments.zh.jsonl` | 更早的 10 条 smoke corpus，保留向后兼容 |

## 字段规范

单条记录（JSONL 一行）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 全局唯一，`^[a-z][a-z0-9-]{2,63}$`，seed 用 `gold-001` 形式 |
| `source` | enum | `wechat` / `email` / `meeting` / `contract` / `im` / `other` |
| `date` | string (date-time) | 消息/会议/合同的时间，必须带时区（seed 统一 `+08:00`）；相对日期按此换算 |
| `text` | string | 消息原文（脱敏后）；≤ 2000 字；`quote` 必须逐字出现在这里 |
| `expect` | array | 期望抽取到的承诺，`0..5` 条；空数组是合法且重要的（用于 precision 负例） |
| `provenance` | enum | `synthetic`（合成）或 `anonymized`（真实消息脱敏） |
| `pending_human_review` | boolean | seed 必须为 `true`；只有完成双人复核后才能改为 `false` |
| `review_note` | string? | 可选，记录复核分歧与裁定（人工复核时填写） |

`expect[]` 内每个对象：

| 字段 | 类型 | 说明 |
|---|---|---|
| `action` | string | 12 字以内的动词短语，例如“发报价”“完成数据迁移” |
| `debtor` | enum | `user`（写消息的人）/ `third`（对方/第三方）/ `unknown` |
| `creditor` | string \| null | 承诺的接收方；未知为 `null`（可写“王工”“您”） |
| `due` | `YYYY-MM-DD` \| null | 截止日期；无明确截止为 `null` |
| `dueAlt` | `YYYY-MM-DD` \| null，可选 | 仅当日期存在合理歧义时给出第二可接受值（如周末/节假日顺延）；评测二选一 |
| `quote` | string | **必须逐字**来自 `text` 的原句；不改标点、不补字 |
| `modal` | enum | `firm`（会/一定/前）/ `tentative`（尽量/争取/应该/回头）/ `conditional`（如果/前提/确认后） |

## 标注流程（人工金标）

1. **收集**：真实微信聊天、邮件、会议纪要、合同条款。原始消息**只在本机处理**，
   不得提交到仓库、issue、PR 或任何云端目录。
2. **脱敏**：人名→化名，手机号→`138****0000`，邮箱→示例域，公司名→代号；
   金额可保留量级但去掉可识别合同的编号。转写时同步去掉可以定位到个人的上下文。
   脱敏后 `provenance` 才能写 `anonymized`；合成样本写 `synthetic`。
3. **AI 预标**：生成 `expect[]`，写入 `pending_human_review: true`。**这一步不是金标**，
   只是候选标注。
4. **双人独立复核**：标注人 A、B 各自逐条核对：`quote` 是否逐字、`due` 换算是否正确、
   `modal`/`debtor`/`creditor` 是否一致、是否漏标或多标。分歧由第三人裁定或 A/B 共同
   裁定，并把结论写进 `review_note`。
5. **置为已复核**：只有双人确认后，才把 `pending_human_review` 改为 `false`；
   未经复核的条目必须保持 `true`。
6. **盲审抽查**：≥10% 的已复核条目交给未参与标注的人盲审；发现系统性偏差（例如
   相对日期换算、tentative 判定）要回炉重标。
7. **发布**：只提交脱敏后的 JSONL；提交前跑 `node eval/run-capture-gold.mjs --dry-run`
   和隐私自查清单（见下）。

### 隐私红线

- 不提交原始消息、真实姓名、手机号、邮箱、真实客户全称、合同编号、可识别金额组合。
- 不在 git 历史、issue、PR、测试失败日志里出现原始隐私数据。
- 若误提交：按仓库 `SECURITY.md` 流程报告并清理历史，不要只删当前文件。

## 指标定义

`eval/run-capture-gold.mjs` 用 `packages/advisers/lib/capture.js` 的
`captureCandidates` 调用真实模型，对每条 `text` 抽候选，再与 `expect` 对照：

| 指标 | 定义 | 目标 |
|---|---|---|
| quote 合法率 | 候选 `quote` 逐字出现在原文的比例（`validateCaptureCandidates` 会丢弃不合法候选，评测端独立复算） | **100%** |
| firm recall | `modal: firm` 的 expect 被候选命中的比例 | **≥ 85%** |
| due 准确率 | 已命中且带 `due`/`dueAlt` 的 expect 中，候选日期与 `due` 或 `dueAlt` 一致的比例 | **≥ 95%** |
| precision | 候选中有多少命中任一 expect（命中候选 / 全部候选） | **≥ 75%** |
| auto-confirmed | 被自动确认的候选条数（候选必须经用户确认，不得自动入账） | **0** |

任一指标未达标脚本 exit 1（dry-run 只校验 schema/字段，不跑模型）。

**再次强调：以上是目标值；当前 seed 尚未人工复核，不代表任何一次运行已经达标。**

## 用法

```bash
# 只做 schema/字段校验（不需要 API key，不联网）
node eval/run-capture-gold.mjs --dry-run

# 真实模型评测（需要 DEEPSEEK_API_KEY 或 ADVISERS_API_KEY）
node eval/run-capture-gold.mjs

# 指定文件 / 只跑前 N 条 / 另存 JSON
node eval/run-capture-gold.mjs --file eval/corpus/gold/commitments.zh.gold.human.jsonl --limit 20
node eval/run-capture-gold.mjs --dry-run --json /tmp/gold-check.json
```

## 2026-11-14 user-authorized agent 双评审（不是人工金标）

用户明确授权主代理“可当作本人执行”。据此，150 条候选由两个独立 agent 评审
（A：分类/quote；B：日期/时区/quote），主代理裁定并写入
`review_mode: "user_authorized_agent_double_review"`。**这不是独立人工双人复核**，
共享同一模型家族，可能有同源偏差；不得对外称“人工金标”。

- 最终真实模型结果（`--file commitments.zh.gold.reviewed.jsonl`，deepseek-flash）：
  quote 100%、firm recall 95.31%（122/128）、due 97.84%（136/139）、
  precision 97.13%（169/174）、auto-confirmed 0；exit 0。
- 首跑 due 94.89% 未过线；7 条 due 差异中 6 条是模型算错、1 条（gold-108
  “这两天”）按模糊相对时间改为 null；gold-023 补 dueAlt。详见
  `eval/results/gold-reviewed-2026-11-14.md`。
- B 评审发现 `resolveRelativeDate` 把“当天”误当消息日；已修复并加回归测试。

## 人工金标完成清单

- [x] 150 条记录全部 `pending_human_review: false`（user-authorized agent 双评审）
- [x] 每条都有两名 agent 评审人（`reviewers`/`review_note`，非人工）
- [ ] **独立人工双人复核**（仍未完成；这是对外金标 claim 的硬门槛）
- [ ] 离线校验 `quote` 逐字、`due` 格式、schema 全绿
- [ ] 隐私审查通过：无真实姓名/手机号/邮箱/真实客户全称
- [ ] 指标运行结果带模型名、日期、脚本 commit；**不写成“已达标”**
- [ ] seed 与 human 文件分开存放，README 状态同步更新
