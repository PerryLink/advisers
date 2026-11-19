# 内容安全：本地规则层

> 状态：0.2.3 仍为 npm latest/next；0.3.0（2026-11-20）是当前 release candidate，吸收未发布的 0.2.4 并新增 per-item clearance、TOS 可接受性加固与输出净化；本文件所述规则层与接入面同步更新，0.3.0 未发布前不得称为已发布。模块位置 `packages/advisers/lib/safety/`，纯 ESM、零第三方依赖、无网络。
> 规则层已完成 **lib 级 7 条路径的接入**：model / research / capture / pet-brief / attachments / MCP server / DSH 工具（见 §8）；0.2.3 起 `bin/` 级 CLI 消费结构化 `safetyWarnings` 并写 `actor=safety` 审计行、block 写 `allowed=false` 审计行（见 §8.2）；首启 TOS 与 `advisers safety` 子命令仍由后续任务接线。
>
> 规则集版本：`advisers-content-1`。测试：`packages/advisers/test/safety.test.js`（21 个规则/语料测试）+ `packages/advisers/test/safety-integration.test.js`（13 个接入路径测试）+ `packages/dsh-advisers/test/safety.test.js`（5 个 DSH 结构化错误测试）。

## 1. 定位与诚实口径

本模块是**辅助性本地内容安全规则层**：在文本进入模型、写入日志、进入桌面宠物 Brief 或对外交付之前，给出可解释的判定（allow / warn / confirm / redact / block），并把判定压成结构化审计字段。

它**不是**：

- 不是合规认证，也不是「官方审核」——Advisers 与模型服务商之间不存在审核背书关系；
- 不是算法备案、大模型登记或安全评估的代理，这些是**部署者/服务提供者**的法定义务；
- 不是漏判/误判的免责依据：规则是启发式，存在绕过与上下文误判（见 §10）；
- 不做年龄核验（未成年人保护只能做到「声明即收紧」）；
- 不做模型二次判定（`ADVISERS_SAFETY_MODEL` 为后续可选项）；
- 不覆盖宿主 MCP/DSH 自身的工具与内容管线，覆盖范围仅限接入本模块的 Advisers 自有边界。

设计依据（仅作设计指针，不构成法律意见）：《网络信息内容生态治理规定》第 6/7 条、《生成式人工智能服务管理暂行办法》第 4/14/17 条、《互联网信息服务深度合成管理规定》、《人工智能生成合成内容标识办法》、GB 45438-2025《网络安全技术 人工智能生成合成内容标识方法》、TC260-003《生成式人工智能服务安全基本要求》、《个人信息保护法》、《数据安全法》、《网络安全法》、《未成年人网络保护条例》、《网络暴力信息治理规定》。规则分类表见 §3。

## 2. 设计原则

1. **block 窄口径**：只有 5 类内容允许 block——儿童性剥削（CSAM）、恐怖主义操作指引、直接违法教唆、恶意代码武器化、批量个人信息外泄。其余最多到 `confirm`/`warn`。代码层用「block 类别白名单 + 规则 `blockable` 标记」双重限制，JSON 覆盖无法新增 block 规则。
2. **自伤不 block**：自伤/自杀内容返回 `action=warn` + `crisis=true` + `code=SELFHARM_CRISIS`，交给调用方的危机响应（12356 / 120 / 110）处理；内容不被拦截、原文不入审计。
3. **正常内容零打扰**：普通办公文本必须是 `allow`，`categories/ruleIds` 为空、`confidence=0`（测试硬断言）。
4. **不存原文**：`classify()` 返回结构里没有原文；`evidenceHash` 是调用方传入 HMAC key 后的不可逆摘要；`redact()` 返回的公开命中不含原始值。
5. **可配置但不可放宽**：规则可由 JSON 覆盖（禁用非硬拦规则、追加 warn/confirm/redact 规则、降级类别动作），但不能新增 block、不能关闭 CSAM 硬拦（见 §6）。
6. **纯本地**：无网络、无第三方依赖（仅 `node:crypto` 做摘要），deterministic、可复现。

## 3. 14 类违规矩阵

| # | category id | 中文类别 | 法律依据指针 | 默认动作 | block 口径 |
|---|---|---|---|---|---|
| 1 | `political` | 危害国家安全类 | 生态治理 6(一)(二)(三)；暂行办法 4(一) | confirm | 不 block |
| 2 | `terrorism` | 恐怖主义与极端主义 | 生态治理 6(五)；暂行办法 4(一) | block | 仅操作指引/袭击实施 |
| 3 | `hate` | 仇恨与歧视 | 生态治理 6(六)(七)；暂行办法 4(二) | confirm | 不 block |
| 4 | `sexual` | 淫秽色情（含儿童性剥削） | 生态治理 6(九)；未保条例 | warn | 仅 CSAM 硬拦 |
| 5 | `violence` | 暴力与凶杀 | 生态治理 6(五)(九) | warn | 不 block（教唆归 illegal） |
| 6 | `selfharm` | 自伤与自杀（危机响应） | 危机干预政策（非违法类别）；参照《人工智能拟人化互动服务管理暂行办法》第 13 条精神 | warn + crisis | 永不 block |
| 7 | `minors` | 未成年人保护 | 未成年人网络保护条例 | confirm | 不 block |
| 8 | `pii` | 个人信息与隐私 | 个保法；生态治理 6(十) | redact | 仅批量外泄 |
| 9 | `deepfake` | 深度合成与冒充 | 深度合成规定；标识办法 | confirm | 不 block |
| 10 | `fraud` | 欺诈与商业违法 | 生态治理 6(九)；广告法 | warn | 不 block |
| 11 | `malware` | 恶意代码与网络攻击 | 网络安全法；刑法 285/286 | confirm | 仅武器化载荷 |
| 12 | `illegal` | 违法犯罪教唆 | 生态治理 6(九)；刑法 | confirm | 仅直接教唆/操作指引 |
| 13 | `harassment` | 侮辱诽谤与网络暴力 | 生态治理 6(十)；网暴治理规定 | warn | 不 block |
| 14 | `injection` | 提示注入与越权指令 | 工程安全风险（非法规类别） | warn | 不 block |

动作定义（`classify()` 只会返回前 5 个）：

- `allow`：正常内容，零打扰；
- `warn`：提示风险，内容保留；
- `confirm`：需要用户显式确认（比 block 温和的一步）；
- `redact`：脱敏后继续（只对个人信息/密钥）；
- `block`：拒绝处理（仅白名单类别）；
- `audit`：不是分类结果；由调用方把结构化字段写入自己的审计链（见 §9）。

## 4. block 白名单（23 条 block 规则，占规则总数 < 30%）

| 类别 | rule ids | 说明 |
|---|---|---|
| CSAM | `R-SEX-CSAM-01` ~ `R-SEX-CSAM-04` | 硬拦（`hardBlock`），本地文件 surface 也不降级，JSON 不可关闭 |
| 恐怖主义操作 | `R-TERROR-OPS-01` ~ `R-TERROR-OPS-03`、`R-TERROR-02` | 制爆/袭击操作指引、袭击意图 |
| 直接违法教唆 | `R-ILLEGAL-DRUG-01/02`、`R-ILLEGAL-WEAPON-01/02`、`R-ILLEGAL-CRIME-01`、`R-ILLEGAL-VIOLENCE-01` | 制毒、制枪、洗钱/偷渡等操作指引、暴力犯罪教唆 |
| 恶意代码武器化 | `R-MALWARE-01` ~ `R-MALWARE-06` | 勒索/木马编写、免杀、窃密、漏洞武器化、钓鱼套件、DDoS |
| 批量个人信息外泄 | `R-PII-BULK-01` ~ `R-PII-BULK-03` | 含「导出/爬取 + 批量 + 身份证/手机号」组合与 ≥6 条 PII + 外泄动词的启发式 |

成人色情、仇恨煽动、政治敏感、深度合成、诈骗话术等一律不 block：它们分别落到 `warn`/`confirm`/`redact`，由用户或调用方决定下一步。这是「不影响正常办公体验」的工程化定义。

## 5. 模块与 API

| 文件 | 内容 |
|---|---|
| `lib/safety/rules.js` | 14 类矩阵、92 条内置规则、规则集编译、`RULESET_VERSION` / `RULESET_DIGEST`、JSON 覆盖 |
| `lib/safety/classifier.js` | 归一化、匹配、surface/context 降级、`classify()`、`createClassifier()`、evidenceHash |
| `lib/safety/redact.js` | PII/密钥检测与脱敏、`redact()`、`detectPii()` |
| `lib/safety/explain.js` | `advisers safety explain` 文案、block/warn/confirm/crisis 提示模板 |
| `lib/safety/index.js` | 统一导出、审计 reason 生成/解析、`ContentSafetyError`、上游拒答形状归一化、`inspectMessages()` |

### 5.1 classify()

```js
import { classify } from './lib/safety/index.js'

const result = classify(text, {
  surface: 'chat.input',   // 见 §7；默认 chat.input
  hmacKey: auditKey,       // 由调用方持有；不传则 evidenceHash = null
  ruleset,                 // 可选：resolveRuleset() 后的自定义规则集
  maxChars: 100000,        // 可选：超长文本截断扫描
})
```

返回（不含原文）：

```js
{
  action: 'allow' | 'warn' | 'confirm' | 'redact' | 'block',
  categories: ['malware'],          // 类别 id，按动作优先级排序
  ruleIds: ['R-MALWARE-01'],        // 稳定规则 id，按动作优先级排序
  confidence: 0.96,                 // 0..1；allow 为 0
  evidenceHash: '9f2c1ab7e3d4c5b6', // HMAC-SHA256(key, 命中片段)[0..16]；无 key 为 null
  code: 'MALWARE_WEAPONIZED',       // 稳定审计码；allow 为 'NONE'
  rulesetVersion: 'advisers-content-1',
  rulesetDigest: 'e506d88f33f1c600',
  surface: 'chat.input',
  severity: 'critical',
  crisis: false,                    // 自伤命中时为 true，永不 block
  downgraded: false,                // 是否被 context/surface 降级
  truncated: false,
  hits: [{ ruleId, category, subtype, code, severity, action, confidence, hardBlock, crisis, downgraded }],
}
```

`classify()` 对异常输入（null/数字/超长）不抛异常；内部异常按保守策略返回 `confirm`（fail-closed）。同文本同 key 的 `evidenceHash` 稳定。

### 5.2 其他导出

- `createClassifier({ ruleset, surface, hmacKey })`：绑定规则集与默认审计 key，返回同签名函数，适合在接入点做单例。
- `resolveRuleset(override)` / `loadRuleset(source)`：纯函数编译 JSON 覆盖；不读文件、不联网。
- `redact(text, { kinds, token })`：返回 `{ text, redacted, count, kinds, categories, hits }`；幂等；公开 `hits` 不含原始值；替换形如 `[REDACTED:PHONE]`。
- `detectPii(text)`：只返回 `{ ruleId, kind, start, end, confidence, severity }`，不含值。
- `inspectMessages(messages, options)`：按 OpenAI messages 形状逐条分类（含 `content` 文本段、`refusal`、`tool_calls.arguments`），聚合最严重动作。
- `normalizeProviderRefusal(payload, { status })`：把 DeepSeek 三种协议拒答、`Content Exists Risk` 400、图片拦截、`safety_tokens` 计费映射为统一形状（不含上游原文）。
- `ContentSafetyError` / `safetyErrorFrom(result)`：类型化错误，字段含 `code/action/provider/surface/categories/ruleIds/crisis/evidenceHash/rulesetVersion/auditReason`，`message` 不含原文。

## 6. 规则配置（JSON 覆盖，默认内置）

```js
import { resolveRuleset, createClassifier } from './lib/safety/index.js'

const ruleset = resolveRuleset({
  version: 'advisers-content-site',            // 可选，需匹配 ^[a-z0-9][a-z0-9._-]{2,39}$
  disabledRules: ['R-SEX-01'],                 // 禁用非硬拦规则
  rules: [{                                    // 追加 warn/confirm/redact 规则
    id: 'R-SITE-01', category: 'fraud', patterns: ['内部员工转账口令'],
    action: 'warn', severity: 'medium', confidence: 0.7,
  }],
  categoryActions: { fraud: 'warn' },          // 只能降级，不能改成 block
})
const classifySite = createClassifier({ ruleset, hmacKey: auditKey })
```

硬性约束（测试已覆盖）：

- JSON 覆盖**不能新增 block 规则**（`action:'block'` 直接抛错）；
- **不能禁用/改写 CSAM 硬拦规则**（`disabledRules` 或 `rules` 命中有 `hardBlock` 的 id 直接抛错）；
- `categoryActions` 不允许 `block`，只能降级；
- 非法正则、未知类别、非法版本号、非法 JSON 均抛 `TypeError`；
- 覆盖不修改内置规则集（默认单例不可变）。

## 7. surface 与降级策略

同一条文本在不同 surface 下动作不同：**用户自己文件里的内容更宽，要发出去/给模型/给桌宠更严**。

| surface | 说明 | 本地文件降级 |
|---|---|---|
| `chat.input` / `chat.output` / `agent.input` / `agent.output` / `model.output` | 对话与模型输入输出 | 否 |
| `research.query` / `research.output` | 联网研究 | 否 |
| `deliverable` / `office.output` / `pet-brief` / `mcp.tool` / `dsh.tool` | 对外交付或宿主工具 | 否 |
| `attachments.text` / `capture.input` / `doc-review.text` / `office.spec` | 用户自有文件/邮件/转写/Office spec | 是：非 CSAM 的 block→confirm、confirm→warn |
| `safety.check` | 手动检查 | 否 |
| 未知 surface | 失败关闭到通用 surface | 否 |

另有**引用/新闻/法律/学术语境降级**：命中非硬拦 block 规则时，若上下文含「新闻/报道/判决/刑法/普法/案例/论文/教材/……」，且不含第一人称求取（「教我/告诉我/帮我/我要/我想/……」，则 block→confirm（`downgraded=true`）。这是误报闸，也是清楚的绕过面：把「教我制作炸药」包装成新闻可以降级为 confirm，因此高危词表与硬拦不公开、CSAM 永不降级。

## 8. 接入点清单与已接入路径（0.2.0–0.2.3）

下表是完整接入面；状态列描述 0.2.0–0.2.3 各轮实际落地的内容，**未接线项不假装已实现**（0.2.3 只在 `bin/` 侧补齐审计/告警消费，不改变下述 lib 路径的判定行为）。

| 接入点 | 位置 | 检查对象 | 默认动作 | 接入状态（0.2.0–0.2.3） |
|---|---|---|---|---|
| chat/agent 输入输出 | `lib/model.js` 的 `chatCompletion()`（`lib/agent.js` 等所有模型调用都经过它） | messages 全文（含 `tool_calls.arguments`）、模型返回文本 | block/warn | **已接入**：发请求前 `inspectMessages`（surface `model.output`）；block 抛 `ContentSafetyError` 且**不建网络请求**；warn/confirm 继续并在返回中新增可选 `safetyWarnings`；模型输出同样后置分类；DeepSeek 通道默认附 `safety_check:{level:'high'}`，`ADVISERS_SAFETY_CLOUD=0` 关闭 |
| capture（邮件/转写/文件） | `lib/capture.js` `captureCandidates()`；`lib/mcp-server.js` 的写候选路径复用同一门 | 输入文本 surface `capture.input`、候选 payload | warn + 不落候选；block 仅高危 | **已接入**：输入 block 抛错且**不调用模型**；候选 payload 的 `action/creditor/uncertainty` 做 PII 脱敏（`quote` 保持逐字原文用于校验）；不自动 accept |
| research | `lib/research.js` `research()` | query/URL surface `research.query`、回答 surface `research.output` | block query；回答 warn | **已接入**：query/URL block 抛错且**不发起 fetch**；受保护 matter 的 egress 门仍在 CLI（`lib/egress.js`，本轮未改）；回答命中以可选 `safetyWarnings` 返回（不重写回答） |
| attachments | `lib/attachments.js` `extractAttachment()` | 抽取文本 surface `attachment`（归一为 `attachments.text`） | 自有文件 warn；CSAM 例外 block | **已接入**：返回新增可选 `safety` 元数据；CSAM 硬拦抛错；非 CSAM 的 block 按 surface 策略降为 confirm |
| Office/交付物 | `bin/advisers.js` office/deliver 命令、`packages/office/src/*` | spec 文本、最终文件正文 | warn；对外交付加标识 | **未接线**（`bin/` 与 office 包不在本轮改动范围；DSH 的 `advisers_office` 已接入 spec 检查） |
| Pet Brief | `lib/pet-brief.js` `buildPetBrief()` / `validatePetBrief()` | suggestedLines、risks.summary | block 则丢弃该行（fail-closed） | **已接入**：block 级建议行/摘要丢弃，`counts` 由数组派生自动一致，redactions 只写通用说明、不写原文；契约 v0.2 schema 不变 |
| MCP | `lib/mcp-server.js` 的 `tools/call`（`bin/` 的 `mcpServer()` 复用该库） | 调用参数 JSON、返回数据 JSON（surface `mcp.tool`） | warn/redact + 审计 | **已接入**：block 返回 `isError:true` 的结构化 `CONTENT_BLOCKED`（不崩 server）、写候选复用 capture 门；若注入 `audit` 回调则记录 `allowed:false` 事件；stdio server 不变量不变 |
| DSH 工具 | `packages/dsh-advisers/index.js` 的 `advisers_brief` / `advisers_office` | `text`、`{kind,out,spec}`（surface `dsh.tool`） | block → 结构化错误码 | **已接入**：block 返回 `{ok:false,error:{code:'CONTENT_BLOCKED',surface,ruleIds,rulesetVersion}}`；两个工具输出 schema 扩为 success/block 的 `oneOf`，成功分支保持原结构 |
| TTS（未来） | 新增 `lib/tts.js`（当前不存在） | 待合成文本 | block + 音频显式标识 | 规划 |
| DLC/插件（未来） | 新增 `lib/plugin/loader.js`（当前不存在） | manifest 声明文本、工具输入输出 | 加载即审；默认禁用 | 规划 |

接入约定（与实现一致）：入口先 `classify(...)`/`inspectMessages(...)`；`block` 用 `ContentSafetyError`（MCP/DSH 用结构化错误码）中断，错误对象与返回值**不含原文**；`confirm` 由调用方确认（lib 层只透出判定）；`redact` 只作用于日志/审计/Pet Brief/候选 payload 等派生副本，不篡改用户原文；`warn` 仅提示不打断；自伤 `crisis=true` 走已有危机响应（永不 block）。

### 8.1 已接入路径与事件（可审计字段）

| 路径 | 入口函数 | surface | block 行为 | warn/confirm 行为 |
|---|---|---|---|---|
| model | `chatCompletion()` | `model.output` | 抛 `ContentSafetyError`（无网络请求） | 返回新增可选 `safetyWarnings` |
| research | `research()` | `research.query` / `research.output` | query/URL 抛错、不 fetch | 回答以 `safetyWarnings` 返回 |
| capture | `captureCandidates()` | `capture.input` | 抛错、不调模型、不产候选 | 候选 payload PII 脱敏 |
| pet-brief | `buildPetBrief()` | `pet-brief` | 丢弃该建议行/摘要 | 不打断 |
| attachments | `extractAttachment()` | `attachment`（`attachments.text`） | 抛错 | 返回新增可选 `safety` 元数据 |
| MCP | `tools/call` | `mcp.tool` | `isError:true` + `CONTENT_BLOCKED` | 透传结果；写候选走 capture 门 |
| DSH | `advisers_brief` / `advisers_office` | `dsh.tool` | `{ok:false,error:{code:'CONTENT_BLOCKED',...}}` | 成功分支保持原结构 |

每次 block 判定可携带的结构化字段（由 `ContentSafetyError.toJSON()` / `safetyWarnings[*]` 提供）：`code`、`action`、`ruleIds`、`categories`、`rulesetVersion`、`evidenceHash`（有审计 key 时）、`auditReason`（`rulesetVersion|surface|action|code|ruleIds|evidenceHash`，≤300 字符）。**不含原文**；接入测试逐条断言序列化结果不含触发文本。

### 8.2 审计边界（本轮到哪、后续做什么）

- **lib 层只产出判定字段，不直接写审计链**：`buildAuditReason()` / `ContentSafetyError.auditReason` 已可直接交给 `store.appendAudit()`（`actor='safety'`、`action='safety.<surface>'`、block 时 `allowed=0`）。
- **MCP 已通过注入的 `audit` 回调记录安全事件**：block 的调用会发 `{actor:'mcp', action, allowed:false, reason:auditReason}`；未注入回调时不写（与既有 MCP 审计约定一致）。
- **DSH 只返回结构化错误**：宿主审计与 `runtime.audit` 的安全事件扩展由后续接线完成。
- **`bin/advisers.js` 的审计写入（0.2.3 起已接线）**：`chat`/`repl` 的 agent 路径把 `result.safetyWarnings` 打印到 stderr（只含 code/ruleIds/action/source，不含原文或外部文本）并逐条写 `actor="safety"`、`action="safety.warning"` 审计行；被拦截的轮次与 policy block 写 `allowed=false` 审计行（`safety.chat` / `policy.agent.block`），`reason` 由 `buildAuditReason()` 生成、≤300 字符、不含原文。`ADVISERS_AUDIT_KEY` 存在时附带 `evidenceHash`。**未改审计表结构、未改 hash-chain material 顺序**；`capture`/`mcpServer()` 的 CLI 入口仍以各自的既有审计为准。
- 原文边界：`classify()` 结果、错误对象、MCP/DSH 结构化错误、新增 `safetyWarnings`/`safety` 字段都不含原文；`redact()` 只返回替换后的文本与不含值的命中。接入测试对 7 条路径逐条断言「不泄漏原文」。

### 8.3 接入后的误报处理（用户可见路径）

- 默认只对 block 打断；`warn`/`confirm` 不阻塞（model/research 以 `safetyWarnings` 透出、capture 只脱敏候选字段、attachments 返回 `safety` 元数据、pet-brief 只在 block 时丢弃行）。
- 语境降级与 surface 降级仍然生效：用户自有文件（capture/attachments/office.spec/doc-review）非 CSAM 的 block 会降为 confirm；引用/新闻/法律/学术语境可把非硬拦 block 降为 confirm（这是误报闸，也是已知绕过面）。
- DSH 的 block 是结构化返回值而非抛异常，宿主/模型可据此提示用户改写需求；MCP 同理（`isError` 文本是 JSON，不含原文）。
- `ADVISERS_SAFETY_CLOUD=0` 只关闭 DeepSeek 的 `safety_check` 网络侧参数，**不关闭本地规则**；CSAM 硬拦不可通过配置关闭。
- 误报规则可通过 `resolveRuleset()` 的 JSON 覆盖禁用（CSAM/block 白名单不可放宽）；`advisers safety report`（误报反馈 CLI）仍为 0.2.1 计划。
- **上游 `safety_check` 兼容性 TODO**：参数按 DeepSeek 官方文档（2026-11-17）添加，仅用于 DeepSeek 通道；尚未做活体灰度验证（研究报告 §10-R1）。若上游发现不兼容，用 `ADVISERS_SAFETY_CLOUD=0` 关闭即可，本地规则不受影响；不要删除或改写请求其余字段。
- **dsh-advisers 打包（0.2.1 已修）**：`packages/dsh-advisers/index.js` 改为从发布包 `advisers` 的公开子路径 `advisers/lib/safety/index.js` 引用本模块；`dsh-advisers/package.json` 显式声明 `"advisers": "0.2.3"` 依赖，`advisers/package.json` 增加 `"./lib/safety/index.js"` export 子路径（0.2.0 的 `../advisers/lib/safety/index.js` 相对引用在干净安装后 `ERR_MODULE_NOT_FOUND`）。`pack-smoke` 不再放行跨包相对 import，`verify-release` 对每包做 `import()` 冒烟（含 `dsh-advisers`）。

## 9. 审计与可解释

### 9.1 reason 格式（≤300 字符，单行，不改审计表结构）

```
rulesetVersion|surface|action|code|ruleIds|evidenceHash
advisers-content-1|chat.output|block|CSAM|R-SEX-CSAM-01|9f2c1ab7e3d4c5b6
```

`buildAuditReason(result)` 生成、`parseAuditReason(reason)` 解析；`auditReasonForResult(result)` 为别名。调用方把该字符串作为 `store.appendAudit()` 的 `reason`，`actor='safety'`、`action='safety.<surface>'`、block 时 `allowed=0`；**不要新增列、不要改 hash chain 的 material 顺序**，否则既有审计链验证会断。

### 9.2 evidenceHash

`evidenceHash = HMAC-SHA256(调用方传入的 audit key, 命中片段集合)[0..16]`。key 由调用方（`ensureAuditKey()` 生成、0600 存储）持有；本模块不读 key、不落盘。换 key 后旧哈希无法关联；同一文本同一 key 可复核「是否为同一段」，但无法还原原文。未传 key 时 `evidenceHash=null`，审计 reason 用 `-`。

### 9.3 用户可解释入口

`advisers safety explain <seq>` 文案由 `explain.js` 提供：只公开「类别 + 规则版本 + 证据哈希前缀 + 动作 + 说明 + 申诉命令」，**不单独发布、也不承诺维护公开的规则词表/正则**（源码可见不等于词表公开；公开词表会帮助规避，防绕过优先于完全透明）。`advisers safety report <seq>` 为 0.2.1 计划中的 CLI 兜底（写误报记录，只存哈希+ruleId+surface+时间）。

## 10. 误报处理、用户控制与已知限制

误报闸：

1. 语境降级（引用/新闻/法律/学术 → 一档降级，见 §7）；
2. `confirm` 替代 block（block 白名单外的高危 → 用户显式确认）；
3. surface 区分（用户自有文件 → 更宽）；
4. JSON 覆盖可禁用误报规则（但 CSAM/block 白名单不可放宽）；
5. 误报反馈走 `advisers safety report`（后续 CLI）；
6. 接入层默认只对 block 打断：`warn`/`confirm` 以可选 `safetyWarnings`/`safety` 元数据透出（§8.1、§8.3），用户自有文件 surface 的 block 会降级为 confirm。

已知限制（不得对外承诺拦截率）：

- 中文谐音、黑话、缩写、跨轮上下文、图片/音频/视频内容均不在本层覆盖；
- 启发式组合规则可被精心构造的文本绕过（这是概率问题，不是保证）；
- 不做年龄核验，未成年人保护只能「声明即收紧」；
- 没有模型二次判定（`ADVISERS_SAFETY_MODEL` 未实现）；
- 上游服务商 `safety_check` 与本层独立：本层不替代上游审核，上游拒答映射见 §5.2；DeepSeek 通道默认附 `safety_check:{level:'high'}`（`ADVISERS_SAFETY_CLOUD=0` 关闭，§8.3 TODO）；
- 规则词表属于软件（PolyForm Noncommercial 1.0.0）；测试语料属于文档/数据（CC BY-NC-SA 4.0），见 `LICENSING.md` 的边界规则。

## 11. 测试与性能

命令：

```bash
cd packages/advisers
node --experimental-strip-types --test test/safety.test.js test/safety-integration.test.js
cd ../dsh-advisers && node --test test/safety.test.js
cd ../.. && pnpm -r test
```

当前结果（2026-11-17）：

- 规则/语料层 21 个测试全部通过（`test/safety.test.js`）；5 类语料：违规 16 条（覆盖 14 类，其中窄白名单 10 条必须 block）、边界 14 条、误报/正常 22 条、注入 12 条、上游拒答形状 12 条；
- 违规语料 block 精确率 100%（无「不该拦却拦」）；边界语料 block 误伤 0；正常办公语料 100% `allow`、误报 0；注入命中率 ≥90%（实际 12/12）；拒答形状 12/12 映射；
- 接入层 13 个测试全部通过（`test/safety-integration.test.js`）：model block 不发网络 / warn 透出 `safetyWarnings` / 输出与上游 400 映射、research block 不 fetch、capture block 不调模型 + PII 脱敏且 quote 逐字保留、pet-brief 丢弃行且 counts/schema 一致、attachments CSAM 抛错、MCP 结构化 `CONTENT_BLOCKED` 且 server 存活、全路径「序列化结果不含原文」断言；
- DSH 层 5 个测试全部通过（`packages/dsh-advisers/test/safety.test.js`）：brief/office block 返回结构化 `CONTENT_BLOCKED`、输出 schema 两个分支均通过宿主校验、office block 不落盘、benign 仍成功；
- 本地微基准：1085 个中文字符，`hmacKey` 开启，`p95≈0.24ms`（预算 20ms/千字；测试通过 `t.diagnostic` 写入测试输出）；
- 微基准是开发机数据，不代表真实分布下的吞吐；生产接入后需在宿主机器复测。

## 12. 不能宣称的口径（对外文案红线）

对外（README、发布说明、官网、销售材料、Issue/PR 回复）**不得**出现：

- 「完整合规」「已通过官方审核」「官方安全认证」「算法备案/大模型登记已完成」；
- 任何拦截率/召回率/准确率数字（本层未做真实分布评测，测试语料是自建简化集）；
- 「未成年人保护达标」；本层无年龄核验；
- 「替代服务商审核」「内容安全由 Advisers 保证」；内容安全第一责任人是服务提供者/使用者；
- 对 TTS/DLC/插件加载能力的任何已实现表述（0.2.0 不存在这些能力）；
- 「开源」「可商用」「已备案」「已通过安全评估」「官方审核」等与本项目许可和监管状态不符的表述（0.2.0+ 为 source-available 非商业许可；对外提供服务的备案/评估义务在部署者）。

可以宣称的准确表述：**Advisers 内建本地内容安全规则与可解释审计，用于降低违法与有害内容风险；它是辅助机制，存在漏判与误判，不构成合规认证或官方审核。**

## 13. 版本与后续

- 规则集：`advisers-content-1`；改动规则须同步升级 `RULESET_VERSION` 并补正例/反例；
- API：`SAFETY_API_VERSION='advisers-safety-api-1'`；
- 本轮交付：`lib/safety/{rules,classifier,redact,explain,index}.js`、`test/safety.test.js`、`test/safety-integration.test.js`、`packages/dsh-advisers/test/safety.test.js`、本文档；lib 级 7 条路径（model/research/capture/pet-brief/attachments/MCP/DSH）已接入。
- 后续（0.2.1 计划）：`bin/advisers.js` 的审计写入与 `chat`/`repl`/`mcpServer()` 接线、Office/deliver 路径、TTS/DLC 未来接入、`advisers safety {check,explain,report,status}` CLI、`bin/advisers.js` 首启 TOS/同意门联动、扩大语料到研究报告设计的 45/50/50/15/12 并做离线评测、模型二次判定（可选）、规则的持续复核与文案更新。
