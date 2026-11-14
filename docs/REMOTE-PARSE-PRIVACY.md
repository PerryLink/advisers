# Remote file parse：隐私与安全设计

> **状态：设计提案，未实现（DESIGN ONLY）。** 仓库当前没有 remote parse 的命令、网络路径、表或测试；文中“提议/应/必须”均指未来实现要求，不是现状，也不构成上线承诺。
> 适用对象：`advisers` CLI（撰写时 checkout 为 `0.2.0-preview.56`）。实现前必须先完成 §8 验收与 §9 决策。

## 1. 背景与问题

### 1.1 现有本地解析能力与边界

`packages/advisers/lib/attachments.js` 在本地读取 txt/md/docx/xlsx/pptx/pdf（`README.md:37`；`README-zh.md:25`），硬限制如下：

| 限制 | 值 | 出处 |
|---|---|---|
| 单文件 / 解压后 | 10 MiB / 20 MiB | `attachments.js:6-7,42,104` |
| 提取字符数 | 20,000（超出 `truncated:true`） | `attachments.js:8,32-33` |
| PDF 页数 | 最多解析前 50 页 | `attachments.js:75` |
| 支持类型 | txt/md/docx/xlsx/pptx/pdf；**图片/扫描件不支持（无 OCR）** | `attachments.js:9-10,126,129` |

这些是**产品边界**，不是服务商能力上限；remote parse 不得把“本地限制”包装成“本地解析失败”。

### 1.2 会触发 fallback 的真实失败类

| 失败类 | 触发 | 现值行为 |
|---|---|---|
| `scanned_pdf` | PDF 无文本层 | 抛 `no extractable text (scanned PDF?)`（`attachments.js:126`） |
| `unsupported_type` | png/jpg/bmp/tiff、legacy doc/xls/ppt、epub | 抛 `unsupported attachment type`（`attachments.js:129`） |
| `parse_error` | PDF/Office 加密、损坏、非预期 zip | JSZip / pdfjs 抛错 |
| `too_large_local` | > 10 MiB | 抛错（`attachments.js:104`） |
| `no_extractable_text` | docx/xlsx/pptx 无文本 | 抛错（`attachments.js:120`） |
| 截断（**不算失败**） | > 20k 字 / > 50 页 PDF | 成功但 `truncated:true`；remote parse 默认不接手，除非显式 `--allow-truncated` |

### 1.3 服务商侧约束（外部事实，设计输入）

以 DeepSeek 官方文档为准（2026-11-14 查阅；不复制价格/承诺）：文档型文件上限 **100 MiB / 1000 页**，上传 120s、解析 120s，账户并发文档上传 15 个；`expires_after` 1 小时–30 天，**省略即永久**；上传时解析，**原始文件与解析结果均不可下载**；解析成功按页计费、失败不存不收费，但**客户端断开后服务端仍可能解析成功并计费**；文件属于账户，同账户所有 key 共享；文档需用 `deepseek-flash` + `file_id` 引用；经 Anthropic 兼容 `/messages` 引用还需 `anthropic-beta: files-api-2025-04-14` 头（[Files API](https://api-docs.deepseek.com/guides/files_api)、[File Parsing](https://api-docs.deepseek.com/guides/document_parsing)）。

服务端工具（web 搜索/读链接、文件解析）在服务商一侧执行，**不能与本地工具同请求**；本仓库 `research.js:1-6` 已按此约束实现 web 工具。

### 1.4 为什么现在不做

1. **改变产品承诺**：README 说本地优先，`research --web/--url` 是“唯一内置内容出网命令”（显式 flag、secret 拒绝、审计 `egress.research`、无 key 不联网；`README.md:70-71`、`bin/advisers.js:1490-1507`）。remote parse 是**原始文件字节**出网，属于新类别，不能混入普通 chat/附件流程。
2. **现有证据/审计边界未完全强制**：`SECURITY.md:57-76` 多为 partial；`Permit/GatedLink` 尚未成为所有 send 路径的强制边界（`ARCHITECTURE.md:132`）；审计只是本地哈希链（`README.md:72`）。
3. **secret 判定当前不可依赖**：`Matter.secrecy` 是 `0|1|2|3`（`core/src/types.ts:6`），而 research 把它与字符串 `'secret'` 比较（`bin/advisers.js:1500`），按现有数据形态不会命中；本功能必须先有可测试的 secret 判定。
4. **缺少计费/留存/删除 UX**：用户看不到“这次花多少、留多久、删没删”；且服务商不提供解析结果下载，返回文本只能来自模型输出，可能截断/漏页/改写，现有证据模型没有 `cloud_parsed` 来源类型。

## 2. 威胁模型与数据流

### 2.1 信任边界与数据流

```
本机（信任域 A）                     TLS 网络                    服务商账户（信任域 B）
ADVISERS_HOME / state.db / 审计      ~ 不可信链路 ~             Files API + 模型 + 服务商日志
```

```
本机                                          服务商
[1] 本地解析失败；[2] 预检 + 显式命令 + 二次确认 + 审计 start（只写元数据）
        ├─(a) POST /files  purpose=text_recognition, expires_after=3600 ─▶ 上传即解析、按页计费
        │                                                                 原始/解析结果不可下载
        │◀──────────────── file_id（仅内存）─────────────────────────────
        ├─(b) 一次模型请求：document block(file_id) + “输出全文/结构文本”
        │     不与本地工具同请求；结果可能截断
        │◀──────────────── cloud_parsed 文本 ─────────────────────────────
        └─(c) 立即 DELETE /files/{id}；失败则记录并靠 expires_at 兜底
            (d) 审计 result + 可选 artifact（cloud_parsed）
```

本机新增落盘：**审计元数据行**与**用户可见的 cloud_parsed artifact**；原始上传文件不复制、不落盘。

### 2.2 数据清单与留存

| 数据 | 离开设备？ | 服务商留存 | 本机留存 | 谁可访问 |
|---|---|---|---|---|
| 原始文件 bytes | 是（一次） | 删除/过期前；不可下载 | 原文件本就在磁盘，不复制 | 服务商账户（其内部访问受服务商政策约束） |
| 解析文本 | 返回本机 | 随 file_id 留存至删除/过期；不可下载 | 默认存 artifact；`--ephemeral` 时为空 | 本机用户、备份/导出持有者 |
| `file_id` | 是 | 随文件 | **只存后 4 位**；完整值仅内存 | 服务商账户（同账户 key 共享） |
| reasoning/signature/encrypted | 可能随响应 | 由服务商决定 | **从不落盘**（`README.md:42`；`model.js:1-6`） | 服务商 |
| 审计元数据 | 否 | — | 哈希链 append-only；purge 不删 audit | 本机用户、备份/导出持有者 |
| API key / 日志 | key 认证出网；日志不出网 | 服务商见 key | key 仅环境变量；日志不含内容 | 本机 / 服务商 |

服务商侧日志、备份与跨境传输**不受本机控制**（同 `README.md:42` 对 thinking 的免责声明）；本文不承诺服务商侧行为。

### 2.3 威胁与对策

| # | 威胁 | 主要对策 |
|---|---|---|
| T1 | 服务商留存/泄露/召回 | 极短过期（建议 3600s，硬上限 86400s）+ 响应后立即 DELETE；禁止永久 |
| T2 | 同账户其他 key 访问 | 承认账户级共享；建议专用账户（§9）；生命周期内不存原文 |
| T3 | 本机文本残留 | 默认 persist，可 `--ephemeral`；tombstone/purge + VACUUM；HOME 0700 |
| T4 | 文档内提示注入 | 解析文本永远是不可信数据；同轮不得写/发（`SECURITY.md:21-22`）；只能成为候选 |
| T5 | 计费失控 | 确认文案展示页数与“按页计费”；本地限额；中断不重试 |
| T6 | 崩溃/超时留下孤儿 | 短过期兜底；`unknown` 状态；`remote-parse cleanup` |
| T7 | 跨 matter 泄露 | artifact 绑定 matter；跨 matter 需重新确认；检索带 matter 过滤 |
| T8 | 用户误以为“本地读取” | 新动词 + 输出首行标记 + 回执/导出/记忆全链路 `cloud_parsed` |

## 3. 硬性红线

- **R1 默认关闭**：未设置 `ADVISERS_REMOTE_PARSE` 即 `off`；off 时命令必须拒绝且 fetch 数为 0。
- **R2 显式命令 + 二次确认**：只有 §4 命令能触发；TTY 需输入 `yes`；非 TTY 需 `ADVISERS_REMOTE_PARSE=on` **且** `--yes`。`ADVISERS_YES=1` 只跳过计划确认（`bin/advisers.js:225-226`），**不得**当 egress 确认。
- **R3 secret 一律拒绝**：显式 secret 恒拒绝；secret 阈值未定义前 `secrecy > 0` 也一律拒绝（fail closed）；不得复用 `bin/advisers.js:1500` 的字符串比较。
- **R4 不得自动触发**：普通 chat、REPL、agent 工具循环、routine、tick、定时任务、link ingest 均不得调用；模型工具清单里**没有** remote parse 工具。
- **R5 普通 chat 不偷偷上传**：`chat --file`/REPL 附件保持现状（本地解析；配置 key 后提取文本随模型请求发送，`README.md:63`、`QUICKSTART.md:103`）；该路径不因本提案改变。
- **R6 返回内容不是本地证据**：一律 `cloud_parsed`；不得作为承诺完成证据（`core/src/ledger.ts:267-268` 要求外部证据）；不得替代原始文件哈希。
- **R7 最小落盘**：不持久化原始上传文件；不持久化完整 `file_id`（只存后 4 位）；除哈希/大小/页数/时间等元数据外不落盘敏感数据。
- **R8 推理字段不落盘**：`reasoning_content`/`signature`/`encrypted_content` 只在内存，不写 turns/summaries/audit/export/backup（`README.md:42`）。
- **R9 日志/审计无内容**：不写全文、文件名/路径、完整 file_id、API key；服务商错误只留状态码，不回显 body。
- **R10 fail closed**：审计 start 写失败、策略异常、无 SQLite、无 key、base URL 非 https/不在 allowlist、并发锁冲突 ⇒ 拒绝且不出网；禁止“先传后补审计”。
- **R11 文件必须会消失**：每次上传都带 `expires_after`（≤86400s，建议 3600s），永不省略；响应后立即 DELETE；删除失败记录并靠过期兜底。
- **R12 不重试有歧义的上传**：网络中断/超时/取消后不得自动再传（服务端可能已解析并计费）；只能由用户再次显式执行并生成新审计行。
- **R13 全局与跨域**：企业/全局禁网优先一切；artifact 不得跨 matter 读取或复用。

## 4. CLI / 配置接口（提议）

### 4.1 命令

```sh
# 推荐入口：新动词，网络语义显式
advisers remote-parse <file> --yes [--purpose text_recognition|rich_layout_recognition] \
  [--matter <id>] [--ephemeral] [--out <path>] [--timeout 300] [--max-pages 200]
advisers remote-parse <file> --dry-run        # 预检+确认文案，0 fetch
advisers remote-parse ls                     # 本机记录（不含完整 file_id）
advisers remote-parse forget <id>            # tombstone
advisers remote-parse cleanup                # 尽力删除已知服务商文件
# 兼容入口：仅显式 --remote-parse 才可能出网，且仅 docx/xlsx/pptx
advisers office-read <file> --remote-parse --yes
```

`office-read` 本身是纯本地读取（`bin/advisers.js:2178-2187`）；flag 是它**唯一**允许触网的路径，不加 flag 行为必须与现状完全一致。

### 4.2 配置与优先级

| 变量 | 默认 | 作用 |
|---|---|---|
| `ADVISERS_REMOTE_PARSE` | `off` | `off`/`0` 硬拒绝；`on`/`1` 只是允许显式命令，**不**绕过 `--yes`；`ask` 仅交互提示 |
| `ADVISERS_REMOTE_PARSE_BASE_URL` | `https://api.deepseek.com` | 仅 https 且必须在 allowlist；禁止跳转到其他 host |
| `ADVISERS_REMOTE_PARSE_EXPIRY_SECONDS` | `3600` | 3600–86400；实现不得省略该字段 |
| `ADVISERS_REMOTE_PARSE_MAX_PAGES` | 暂定 200 | 本地页数上限；同时受服务商 1000 页硬限约束 |
| `ADVISERS_EGRESS` | 未设置 | 提议的企业/全局禁网：`deny` 时连同 research 一起拒绝（**新增提案**） |

拒绝优先级：`ADVISERS_EGRESS=deny` > matter `deny`/secret > 无 key/无 SQLite/审计不可写 > 未确认 > 预检超限。matter 新增 `remote_parse: off|ask`（默认 `off`），只能经显式管理命令修改并审计 `policy.remote_parse`；**matter allow 不能覆盖 secret 与全局 deny。**

### 4.3 确认文案（必须逐字展示，交互输入 `yes` 才继续）

```
将把以下文件上传到 DeepSeek 解析（原始文件会离开本机）：
  文件：<name>  <size>  SHA-256 前 12 位：<hash12>
  类型/页数：<ext> / <pages_est 或“服务端判定”>
  解析方式：仅文本（text_recognition）| 文本+图表（rich_layout_recognition）
  服务商：api.deepseek.com（文件属于账户，同账户 API key 可共享）
  留存：服务端 <N> 小时（默认 1 小时，最长 24 小时，到期自动删除）；返回后本机立即请求删除
  计费：解析成功按页计费，单价见服务商价目；网络中断可能仍被计费
  本机不保存原始文件副本和完整 file_id；解析文本默认保存在本机并标记 cloud_parsed（--ephemeral 不保存）
返回文本将标记为 cloud_parsed：它不是本地文件证据，不能直接作为完成证据。
输入 yes 继续；其他任意输入取消：
```

`--dry-run` 输出同一段，审计 `allowed=false, reason=deny.dry_run`，不发任何请求。

### 4.4 审计字段（action=`egress.remote_parse`）

每次 attempt 两行：上传前 `phase=start`、结束时 `phase=result`；deny 只有一行。`reason` 为单行 JSON：`v`、`phase`、`file_sha256`、`bytes`、`ext`、`pages_est`、`purpose`、`provider`、`base_host`、`file_id_last4`、`matter_id`、`confirm`（`tty:typed_yes`/`flag+env`）、`expiry_s`、`outcome`、`error_code`、`text_sha256`、`chars`、`delete_state`；时间由 `audit.at` 列记录。**不含文件名/路径/全文/完整 file_id/key**。reason 进哈希链（`sqlite.js:486-511`），因此键序稳定、无自由文本；拒绝原因用固定码（如 `deny.secret_matter`、`deny.confirm_missing`、`deny.preflight_size`）。

## 5. 来源标记：`cloud_parsed`

- **所有可见面必须带标记**：CLI 首行 `[cloud_parsed provider=deepseek file_id_last4=xxxx pages=… text_sha256=…]`；prompt 包装 `<file origin="cloud_parsed" source="remote_parse:<id>">…</file>`（本地附件为 `origin="local"`，不得拼成无来源块）；回执加 `来源：cloud_parsed（服务商解析，非本地证据）`；网页引用另标 `web`（`README.md:40` 已说明网页引用不是本地文件证据）；`--out` 文件首行写 `> source: cloud_parsed (...)`。
- **记忆**：由 cloud 文本派生的 fact/preference 必须带 `source: {ref:"cloud_parse:<artifact-id>", quote, quote_hash}`，初始 `status=candidate`，用户显式接受后才确认（参照现有 candidate 流程）。
- **导出/备份**：`export --all` 默认只含 metadata 与 `origin=cloud_parsed` 标记，不含全文；`--include-cloud-text` 才导出文本，并在 JSON 顶层写 `"contains_cloud_parsed_text": true`。
- **数据模型（提议表 `remote_parse_artifacts`）**：`id`、`matter_id`、`origin='cloud_parsed'`、`file_sha256`/`bytes`/`ext`、`pages_est`/`purpose`/`provider`/`base_host`、`file_id_last4`/`server_expires_at`、`text`/`text_sha256`/`chars`/`truncated`（ephemeral 时为空）、`created_at`/`deleted_at`/`deleted_reason`。
- **不混淆**：本地证据仍以本地原始文件为锚，`local` 与 `cloud_parsed` artifact 分开存、分开显示，不得把 cloud 文本回填为 `local_file`。
- **可删除**：`remote-parse forget <id>` 置 `text=NULL` + `deleted_at/deleted_reason`（不物理删行，`ARCHITECTURE.md:42-43`）；`purge <matter> --yes` 级联清空 text 并 VACUUM（参照 `sqlite.js:314-337` 与 `test/sqlite.test.js:295-311`）；审计行不删、不含文本，metadata 留存策略须在 §9 决定。

## 6. 生命周期、失败与计费

### 6.1 状态机（提议）

```
preflight ──deny──▶ 拒绝（allowed=false；0 fetch）
   │ok + 确认
audit(start) ──写失败──▶ 拒绝（0 fetch）
   │
upload(file_id) ──400/408/413/429/503/504──▶ 结束（不自动重试）
   │ok
model(document) ──错误/超时/取消──▶ 立即 DELETE；outcome=error/unknown
   │ok
persist? ──ephemeral──▶ 仅 stdout + metadata
   │persist
artifact(cloud_parsed) + receipt + audit(result)
```

### 6.2 留存、删除与取消

- **过期与删除**：每次 `POST /files` 必带 `expires_after[seconds]`（默认 3600，硬上限 86400），禁止 permanent；响应无 `expires_at` 视为异常，立即 DELETE 并中止。模型返回后无论成功与否都 `DELETE /files/{file_id}`；`GET /files/{id}` 验证 404；DELETE 失败重试 3 次（1s/2s/4s），仍失败记 `delete_state=failed` 并提示用户；过期是兜底不是主策略。
- **取消/超时/恢复**：SIGINT 时若 file_id 已知则尽力 DELETE，并提示“可能仍解析完成并计费”；客户端总超时默认 300s，超时后 `unknown` 不重试；**不保存完整 file_id，故不支持断点续传/复用旧 id**，每次重跑都是新 attempt。

### 6.3 失败处理矩阵

| 场景 | 行为 | 自动重试？ | 计费/残留 |
|---|---|---|---|
| 预检/secret/全局 deny | 拒绝；审计 deny | 否 | 0 fetch |
| 400/408/504（无法解析/加密/上传慢/解析超时） | 报错 | 否 | 官方称失败不存不收费 |
| 413（>100 MiB / >1000 页） | 报错并提示本地限制 | 否 | 无成功文件 |
| 429/503（忙） | 提示稍后手动重跑 | 否 | 无成功文件 |
| 网络中断/客户端超时 | `unknown`；DELETE（若知 id） | **否** | 可能已解析并计费 |
| 模型输出截断 | `truncated=true`，不作完整文本 | 否 | 解析费已产生 |
| 审计 append 失败 | 上传前拒绝 | — | 0 fetch |

### 6.4 计费与限额预检

扩展名 allowlist；文档 ≤100 MiB、图片 ≤64 MiB、纯文本/表格 ≤32 MiB；PDF 本地数页 ≤ min(1000, `--max-pages`)，非 PDF 无可靠页数则文案写“服务端判定”；单请求只传 1 个文档；账户 15 并发由本地单飞锁保证不撞。计费只在确认文案提示“按页计费”，**不硬编码价格**，不承诺“失败一定免费”。每 matter 每日页数上限暂定 200 页并可 `off`（§9）。

## 7. 配置与隔离

- **按 matter 与 secret**：新 matter 默认 `remote_parse=off`；显式开启审计 `policy.remote_parse`，`ls` 可见。显式 secret 恒 deny；`secrecy` 语义（0–3）未产品化前 `secrecy > 0` 也 deny，判定必须在 preflight 之前基于 matter 记录完成，不依赖文件名或用户自述。跨 matter 使用需重新确认。
- **全局禁网与企业模式**：`ADVISERS_EGRESS=deny`（提议）为最终开关，remote parse/research/未来 egress 一律拒绝且优先级最高；企业/涉密模式由 policy pack 或环境变量强制（`packages/policy-strict` 目前只覆盖 affect/companion，故这是新增能力）。`ADVISERS_STORE=json` 拒绝（JSON 模式丢 turns/search/audit，`ARCHITECTURE.md:128`）；`ADVISERS_NO_MODEL=1` 或无 key 拒绝，不引入第二套凭据。
- **与 `ADVISERS_HOME`/审计链**：HOME 默认 `~/.advisers`、0700，`audit.key` 0600（`bin/advisers.js:46,54-70`）；artifact 存 `state.db`，备份为整库复制、0600（`bin/advisers.js:1225-1232`）——备份/导出持有者能看到 cloud 文本，必须警告。审计复用现有链（`sqlite.js:486-511`），reason 为哈希材料，必须是稳定、无内容的 JSON；start/result 各一行，append 失败则拒绝上传；验证走 `/audit`、`advisers prefs audit`、`doctor`。audit 行不随 purge 删除，故绝不写文件名/路径/文本；`doc.review` 现有 reason 写文件路径（`bin/advisers.js:1483`）的做法不适用于本功能。
- **密钥与日志**：API key 只从环境读取、不落盘；日志/错误只允许 HTTP 状态与错误码；实现不得复制 `research.js:60` 的 `raw.slice(0, 300)`（服务商 body 可能含用户内容）。`--json`/debug/verbose 必须走同一 redaction：不输出全文、完整 file_id、文件名（stdout 用户可见输出可显示文件名，日志文件不可）。
- **服务商隔离**：一次 remote parse 只发一个服务端请求，不与本地工具循环、`research` web 工具、chat tool calls 混合；结果回本机后按不可信数据进入下一轮，同轮不得写账本或发送（`SECURITY.md:21-22`）。v1 只支持 DeepSeek；base URL allowlist + https，不跟随重定向到非 allowlist host；自建代理/区域端点见 §9。

## 8. 验收标准与不做什么

### 8.1 实现前必须通过的检查（建议入 `scripts/security-suite.mjs` 或 `test/remote-parse.test.js`）

- **门禁与确认**：默认 0 fetch；`--yes` 无 env 拒绝；非 TTY 无 `--yes` 拒绝；`ADVISERS_YES=1` 不能放行；chat/repl/agent/routine 无调用路径；模型工具清单无该工具；secret/`secrecy>0`/JSON store/全局 deny/无 key 全拒绝；审计 start 写失败时 0 fetch；TTY 非 `yes` 取消；文案含 size/hash/pages/retention/billing/marker；`--dry-run` 0 fetch。
- **审计与日志**：start 在上传前；reason 可解析、字段齐全；reason/日志无文件名、全文、完整 file_id、key；链可验证；provider 错误 body 不回显。
- **生命周期**：`expires_after` 始终存在且 ≤86400；成功/失败都 DELETE；DELETE 失败重试并记录；超时/中断不重传；并发锁；400/408/413/429/503/504 分支。
- **标记与删除**：所有输出面含 `cloud_parsed`；prompt 标签；回执/导出；tombstone 后 `text=NULL`；purge 后 DB 文件不含文本字节（仿 `test/sqlite.test.js:295-311`）；跨 matter 拒绝；cloud 文本不能单独作为 done evidence。
- **回归**：`office-read` 无 flag 字节级行为不变；`research`/`chat`/`export`/`backup`/`purge` 默认输出不变；schema 迁移幂等；`pnpm -r test` 与 `node scripts/security-suite.mjs` 绿。

### 8.2 不做什么

不做本地 OCR/自动 fallback/后台批量扫描/chat 自动上传/服务端与本地工具混请求；不做永久文件、不持久化完整 file_id、不在 audit/log/export 默认放全文；不把 cloud 文本当本地或完成证据、不跨 matter 复用、不承诺“原文精确转写”；v1 不做多 provider/自建代理/断点续传/自动重试，不改 `research` 行为。

## 9. 开放问题（需用户/产品决策）

1. 是否允许 remote parse？哪些客户/合同/地区明确禁止“原始文件上传”？
2. 默认策略：默认 `off` 是否足够，还是企业版默认硬禁用？是否需要管理员集中锁定？
3. 解析文本默认留存：`--ephemeral` 优先，还是默认持久化以便回执/记忆可追溯？保留多少天？
4. 本地脱敏预处理：不做 / 正则 DLP / 上传前人工预览 diff？谁承担误脱敏风险？
5. secret 阈值：`secrecy 0–3` 各代表什么？0 是否也算涉密？谁来标记、如何审计？
6. 计费治理：每 matter/每日页数上限、是否需要审批、是否显示报价与预算告警？网络中断计费争议如何处理？
7. 是否必须支持自建代理/区域端点/专用服务商账户（用于 DLP 与隔离同账户 key 共享）？
8. cloud_parsed 文本能否派生承诺/记忆？仅候选还是可确认？`quote_hash + source_ref` 的字段与过期规则？

## 10. 回滚/禁用与对现有命令的影响

- **默认零变化**：未设置新变量、未执行新命令时，不新增网络请求、表、日志或导出字段；这是发布门槛（§8.1 回归项）。`office-read`、`chat --file`、`research`、`export`、`purge` 的默认输出保持现状。
- **一键禁用与回滚**：`ADVISERS_REMOTE_PARSE=off`（或企业 `ADVISERS_EGRESS=deny`）即关闭；已上传文件最多 1 小时后由服务商过期删除；本机可 `remote-parse forget/cleanup`；审计 metadata 保留但不含内容。新模块/表/命令均为增量，回滚删除命令或模块即可，无需破坏性 schema 迁移；若必须删表，按“tombstone → 用户确认 → 备份 → 删表”的现有删除纪律处理，不静默迁移。
- **对现有命令**：`research` 仍是唯一既有“显式内容出网命令”，不受影响；`doc.review` 行为不变（但其 secret 缺口建议单独评估）；`export --all` 仅在存在 artifact 时新增表；`backup` 会包含 cloud 文本，需在用户文档标注。

> 再次声明：**本文是设计提案，未实现，也不承诺实现时间。** 实现须先满足 §8 并回答 §9。

## 11. 用户授权后的决策记录（2026-11-14，仍为 DESIGN ONLY）

> 用户在本轮明确授权“外部阻塞能做的都做、可当作本人执行”。以下把 §9 的开放
> 问题按保守默认落成决策，作为未来实现的输入；**本轮没有实现任何代码**，
> 仓库里仍没有 remote-parse 命令/网络路径/表。

| # | 问题 | 决策（用户授权下的保守默认） |
|---|---|---|
| 1 | 是否允许 remote parse | 允许作为**显式可选**能力，仅限非 secret matter；默认关闭。 |
| 2 | 默认策略 | 默认 `off`；`ADVISERS_EGRESS=deny` 优先级最高；企业/涉密模式全局拒绝。 |
| 3 | 解析文本留存 | 默认 ephemeral（只在本次命令内存+可选 artifact）；不默认写库。 |
| 4 | 本地脱敏预处理 | v1 不做自动 DLP；上传前展示文件名/大小/哈希/页数并要求逐字确认；失败即拒绝。 |
| 5 | secret 阈值 | 与 research 一致：`secrecy > 0` 一律 deny（fail closed，当前已用于 research）。 |
| 6 | 计费治理 | 每 matter/每日页数上限 + 预检显示“预计页数/费用”；断连不自动重试。 |
| 7 | 自建代理/区域端点 | v1 只支持 DeepSeek 官方 https；不支持自建代理，base URL allowlist。 |
| 8 | cloud_parsed 派生承诺/记忆 | 只能生成 memory candidate，**不得自动入账/自动 confirmed**；必须带 `cloud_parsed` 来源标记与 quote_hash；可 tombstone/purge。 |

实现门槛不变：必须先满足 §8.1 验收清单并提升 `secrecy` 语义；在此之前
README/回执不得宣称支持 remote parse。
