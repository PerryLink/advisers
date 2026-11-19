# MCP 接入（stdio；legacy 协议协商 2024-11-05 / 2025-06-18 / 2025-11-25）

状态（2026-11-20，0.3.0 **release candidate**；包版本为 `0.3.0`，更早的 `0.2.4` 是已被取代的未发布 candidate，npm `latest` 仍为 `0.2.3`，**0.3.0 尚未发布**）：

- **0.2.0 库**：MCP server 已从 `bin/advisers.js` 抽成可测试库 `packages/advisers/lib/mcp-server.js`（工厂 `createMcpServer({store, ledger | loadLedger, version, audit, clearance})`）。库提供 **5 个只读工具 + 2 个白名单工具 + 4 个只读 resources**。
- **CLI 入口（已接线，2026-11-17）**：`advisers mcp --stdio` 与库是同一实现——`bin/advisers.js` 只负责注入 home/store/ledger/version/audit，然后调用 `createMcpServer(...).serve()`；7 工具 + 4 resources 均从 CLI 可用，并自 `0.2.0` 起随 npm 包发布（2026-11-17 已上 `latest`）。仓库内的 `node scripts/mcp-dev.mjs` 保留为开发/双进程冒烟入口，不再是试用新接口的前提。
- **0.2.3 变化（性能/健壮性，协议面不变）**：`initialize` 只做协议初始化，不再预加载整个账本——可写 store 与逐工具的部分加载推迟到首次 `tools/call`（200k 行账本上 init 从 1.85s 降到 91ms）；只读调用走无锁只读快照，可在 `ui` 等长期写者持锁时工作；协议面仍是 7 工具 + 4 resources。
- **0.3.0 变化（新，见 §3.1/§5.1）**：
  1. **legacy 协议协商**：`initialize` 回显客户端请求的受支持版本（2024-11-05 / 2025-06-18 / 2025-11-25）；缺失或未知版本回退 **2024-11-05**。现代无状态修订 2026-07-28 **未实现**，也不广告 `server/discover`。
  2. **列表输出上限**：每个列表型工具**先做 per-item clearance 过滤、再截断、再计数**，返回 additive 的 `total`/`truncated`（`who` 用 `mineTotal`/`waitingTotal`）与 `clearance`/`protectedExcluded`；大账本上 today/commit_ls/remind 不再因内容分类器 100k 字符上限返回 `CONTENT_BLOCKED`，小账本行为逐字段不变。
- **性质**：stdio、本地、只读为主；不联网、不调模型、不读 API key，也不含 MCP client（不做通用 ingest/编排）。

## 0. 一句话

把承诺账、到期、证据与今日要事以 MCP 暴露给 Claude Code / Cursor / Copilot Studio 等主 agent；写入口只有“产生待确认候选/校验回执”两种，账本只由本地人工命令修改。

## 1. 入口

### 1.1 CLI（7 工具 + 4 resources，已接线）

```sh
advisers mcp --stdio
```

stdin 一行一个 JSON-RPC 请求，stdout 一行一个响应，stderr 只放进程诊断。使用 `ADVISERS_HOME`（默认 `~/.advisers`）下的 SQLite/审计链；每次 `tools/call` 会写一条审计行，写调用在审计失败时 fail-closed（候选回滚、返回 `isError`）。

### 1.2 仓库内库入口（开发/双进程冒烟）

```sh
# 在仓库 checkout 根目录运行；scripts/ 不在 npm 包内，所以这只是开发入口
ADVISERS_HOME=/tmp/advisers-mcp node scripts/mcp-dev.mjs
```

`scripts/mcp-dev.mjs` 和 CLI 接线到同一个 `createMcpServer` 工厂、协议面相同；它用于在不经过 bin 时验证库，或做真实双进程 stdio 冒烟。

首次运行会在 `ADVISERS_HOME` 下创建 `state.db` 与 `audit.key`；若已有旧版 `state.json`，会像 CLI 一样一次性迁移进 SQLite。

### 1.3 DSH 适配器：读真实账本（只读），不是 MCP 端

`packages/dsh-advisers` 是 **DSH 宿主内的工具适配器**（5 个工具），不是 MCP server，也不经过本文件的 JSON-RPC 协议。0.3.0 起它的三个账本读工具（`advisers_today`/`advisers_who`/`advisers_evidence`）通过受控只读门面 `advisers/lib/ledger-read.js` 读 **真实本地账本**（`docs/LEDGER-READ-API.md`）：只读连接、不取 HOME 写锁、不迁移、不建 HOME、不写库、TOS 已接受记录门禁、clearance=0；`advisers_today`/`advisers_who` 用窄承诺索引投影，`advisers_evidence` 用主键点查，不装载整账本。

**preview 只是回退标记**：无库（首次运行）、门面不可用（旧 `advisers` 包 / 宿主无 `node:sqlite`）或 `config.mode: "preview"` 时，才回退到 0.2.x 的 marked preview（`preview: true`、`source: "preview-no-ledger"`、`note`，渲染以 `[preview: no ledger]` 开头）；TOS/vault/schema/损坏/忙等其它门禁失败必须返回结构化 `LEDGER_*` 错误，**不得**用空数据冒充“没有”。

要读**逐字段同源视图**，仍可用 CLI（`advisers today --json` / `who --json` / `evidence show <id> --json`）或本文件的 `advisers mcp --stdio`（真实 SQLite 账本，只读视图）。DSH 的 `advisers_office` 仍只写 `config.workspace` 内的文件。

## 2. 客户端配置片段

以下三种客户端都用同一份 stdio 配置。仓库 checkout 里也可把命令换成 `node /path/to/advisers/scripts/mcp-dev.mjs`（开发入口，`scripts/` 不在 npm 包内）。

### 2.1 Claude Code

```sh
claude mcp add advisers -- advisers mcp --stdio
```

等价的项目级 `.mcp.json`：

```json
{
  "mcpServers": {
    "advisers": {
      "command": "advisers",
      "args": ["mcp", "--stdio"]
    }
  }
}
```

### 2.2 Cursor（`.cursor/mcp.json`）

```json
{
  "mcpServers": {
    "advisers": {
      "command": "advisers",
      "args": ["mcp", "--stdio"]
    }
  }
}
```

### 2.3 Copilot Studio（本地 MCP 工具）

在“工具 → 添加工具 → MCP”里填：

| 字段 | 值 |
|---|---|
| 名称 | `advisers` |
| 传输 | `stdio` |
| 命令 | `advisers` |
| 参数 | `mcp --stdio` |

> 三个客户端都只需要本机可执行的 `advisers`（或 `node` + 脚本路径）；不需要 URL、端口、token 或出网。Windows 下若 `advisers` 不在 `PATH`，在命令里写 `node`、参数里写 `C:\path\to\advisers\packages\advisers\bin\advisers.js mcp --stdio`。

## 3. 工具

| 工具 | 读写 | 说明 |
|---|---|---|
| `advisers_today` | 只读 | 未结承诺计数 + 未结承诺列表 |
| `advisers_commit_ls` | 只读 | 承诺列表；`{all:true}` 含已完成/已搁置 |
| `advisers_who` | 只读 | 谁欠谁：`mine`（我/agent）vs `waiting`（第三方） |
| `advisers_evidence` | 只读 | `cm_*`/`fact_*`/`pref_*` 的回溯来源（session#turn + 引文） |
| `advisers_remind` | 只读 | 当前到期提醒（不投递、不联网） |
| `advisers_capture_candidate` | 白名单写 | **只产生 pending 记忆候选**，绝不自动 accept、绝不写账本 |
| `advisers_pack_verify` | 只读校验 | 校验证据包/回执目录（`manifest.json`/`README.txt`/`SHA256SUMS`[+`receipt.docx`]） |

### 3.1 输出上限、截断与 clearance 字段（0.3.0）

列表型工具的返回都带显式上限，避免大账本把正常查询变成内容分类器的 fail-closed 错误：

| 工具 | 上限 | 附加字段（additive） |
|---|---|---|
| `advisers_today` | 最多 20 行承诺 | `open`/`total` = 过滤后真数；`truncated`；`clearance`、`protectedExcluded` |
| `advisers_commit_ls` | 默认 50 行；`limit` 可设 1..200 | `total`、`truncated`、`limit`、`clearance`、`protectedExcluded` |
| `advisers_who` | `mine`/`waiting` 各 20 行 | `mineTotal`、`waitingTotal`、`truncated`、`clearance`、`protectedExcluded` |
| `advisers_remind` | 20 条提醒 | `total`、`truncated`、`clearance`、`protectedExcluded` |
| `advisers_evidence` | `sources`/`missing` 各 20 条 | `sourcesTotal`、`missingTotal`、`truncated`、`clearance`；保护记录返回 `protectedExcluded: 1` 且内容全空 |

语义（0.3.0 契约，实现 `packages/advisers/lib/mcp-server.js` 的 `MCP_OUTPUT_LIMITS` 与 `boundPayload`）：

- **先过滤后计数**：`total` 是 per-item clearance 过滤后的真数；截断不改变它，`truncated: true` 只表示"还有行没发"，不要把截断结果当成全部账本。
- **clearance 默认 0（fail closed）**：是 server 进程的配置，不是工具参数（CLI `advisers mcp --stdio` 固定 0；嵌入方可传 `createMcpServer({clearance})`，非法/负值回落 0）。`secrecy` 高于 clearance 的记录只计入 `protectedExcluded`，不返回 id/标题/引文任何字段。
- **最后一道字节保护**：序列化后仍超过 64 KiB 时，最长的列表继续对半截断并置 `truncated: true`（仍先于内容分类器），避免单个超长证据数组把结果变成 `CONTENT_BLOCKED`。
- **小账本不变**：未超上限时，除上述 additive 字段外，旧工具的名字/参数/返回形状逐字段一致；旧客户端忽略新字段即可。

### 3.2 候选写入（必须人工 accept）

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "advisers_capture_candidate",
    "arguments": {
      "action": "把修订报价单发给王工",
      "quote": "周一前把修订报价单发给王工，抄送李总",
      "creditor": "王工",
      "dueAt": "2026-11-24T10:00:00+08:00"
    }
  }
}
```

- 必填 `action`、`quote`（引文是证据，不允许空）；可选 `debtor`（`user`/`agent`/`third`）、`creditor`、`dueAt`（ISO 8601）、`matterId`（必须是已有 matter）。
- 返回的 `candidate.status` 永远是 `pending`；账本不变。人工执行 `advisers memory candidates` 查看、`advisers memory accept <id>` 后才入账。
- 每次调用写审计行 `mcp.capture.candidate`（`allowed` 反映成功/拒绝）；审计链写失败时调用失败并回滚该候选。

### 3.3 回执目录校验

```json
{ "jsonrpc": "2.0", "id": 8, "method": "tools/call",
  "params": { "name": "advisers_pack_verify", "arguments": { "dir": "/path/to/evidence-pack" } } }
```

只读：不修改目录，只读 `SHA256SUMS`、`manifest.json`、`README.txt` 及 `SHA256SUMS` 列出的安全文件名；`receipt.docx` 只报告存在性，不解析。返回 `{ok, errors[], files[], fileCount, receiptPresent, extraFileCount, verifiedAt}`。目录/文件错误只返回通用文案，不回显绝对路径。审计行：`mcp.pack.verify`。

## 4. Resources（只读 JSON）

| URI | 内容 |
|---|---|
| `advisers://today` | 未结承诺计数 + 列表（与 `advisers_today` 同形） |
| `advisers://commitments` | 全部承诺的紧凑行（含状态） |
| `advisers://who` | `{mine[], waiting[]}` |
| `advisers://evidence` | 承诺/事实/偏好的证据回溯索引（只含计数，不含引文正文） |

```json
{ "jsonrpc": "2.0", "id": 9, "method": "resources/read",
  "params": { "uri": "advisers://today" } }
```

响应：`{contents:[{uri, mimeType:"application/json", text:"<JSON 字符串>"}]}`。未知 URI 返回 `-32002`。

resources 与对应工具读同一份**已做 clearance 过滤 + 上限截断**的读模型：`advisers://today`/`://commitments`/`://who` 与 today/commit_ls/who 同形（同样带 `total`/`truncated` 等字段），`advisers://evidence` 与 `advisers_evidence` 同源（`limits.perKind` + 计数）。因此 resources 与 tools 对同一账本给出一致的可见性与截断口径。

## 5. 协议与错误码

### 5.1 协议版本协商（0.3.0 legacy 协商）

`initialize` 的 `params.protocolVersion` 按以下规则协商（实现：`lib/mcp-server.js` 的 `SUPPORTED_PROTOCOL_VERSIONS` / `initializeResult`）：

| 客户端请求 | 服务端回显 | 说明 |
|---|---|---|
| `2024-11-05` | `2024-11-05` | 0.2.x 默认，行为不变 |
| `2025-06-18` | `2025-06-18` | 同一 initialize/tools/resources 生命周期 |
| `2025-11-25` | `2025-11-25` | 本 server 支持的最新 legacy 修订 |
| 缺失 / 未知 / `2026-07-28` | `2024-11-05` | active-fallback；旧客户端不受影响 |

- 支持的是 **legacy 生命周期**（initialize → tools/list → tools/call → resources/list → resources/read）；现代无状态修订 2026-07-28（`server/discover`、每请求 `_meta`、`resultType`）**没有实现**，也不广告。现代客户端探测 `server/discover` 会得到未知方法错误后回退 `initialize`——这是有意的兼容取舍，不是"支持 modern"。
- 三种 legacy 版本的可用方法、工具、resources 与错误码完全相同；协商结果只影响 `initialize` 回显（与审计口径），不改变读模型/上限。
- 契约工件：`contracts/mcp/versions-v1.json`（supported/default/negotiation）与 `contracts/versions-v1.json` 的 `discovery.expected.mcpProtocol`（默认值 `2024-11-05`）；`node scripts/check-contracts.mjs --mcp` 会验证回显与回退。

### 5.2 方法与错误码

支持方法：`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`、`resources/list`、`resources/read`。

| 码 | 含义 |
|---|---|
| `-32600` | 非法请求；stdio 单行超过 1 MiB 也用它 |
| `-32601` | 未知方法 |
| `-32602` | 参数类型/取值错误、未知工具（不回显原始参数） |
| `-32700` | 非法 JSON |
| `-32603` | 未预期内部错误（固定文案，不带堆栈） |
| `-32002` | 未知 resource URI |

工具执行失败（如证据 id 前缀未知、目录不存在）走 MCP 约定：`result.isError = true`，`content[0].text` 是固定/净化后的文案。实现强制“一行一个请求、UTF-8、≤1 MiB”，超限的行被丢弃并返回 `-32600`。

## 6. 安全与审计边界

- 无网络、无模型调用、无 token；与 `advisers research`/IMAP 等出网路径完全独立。
- 每个 `tools/call` 经注入的 `audit` 回调写 `{actor:"mcp", action, allowed, reason}`；只读为 `mcp.call`，写候选为 `mcp.capture.candidate`，校验为 `mcp.pack.verify`。
- 候选写入永不自动 accept；没有直接写账本的 MCP 路径。
- 错误信息不回显原始参数、引文或绝对路径。
- 回执校验拒绝符号链接、超大文件与 `SHA256SUMS` 中不安全的路径。

## 7. 未做（避免误解）

- 不做 MCP client / 上游会议或邮件 ingest / OAuth / 订阅（`resources/subscribe`）。
- 不提供 HTTP/SSE 传输，不做多租户或远程暴露。
- **不实现 MCP 现代（stateless 2026-07-28）修订**：没有 `server/discover`、每请求 `_meta`、`resultType` 或 modern 错误语义；0.3.0 只承诺 legacy 三版本协商。工具面也不做 `readonly` profile 切换或分页游标（cap + `total`/`truncated` 足够本版本）。

## 8. bin 接线（已完成 2026-11-17）

`packages/advisers/bin/advisers.js` 已切到本库：旧的 `mcpReply/mcpError/mcpTools/mcpServer`（5 只读工具、无 resources、无审计失败回滚）已删除，dispatch 的 `else if (command === 'mcp')` 仍只接受 `--stdio`。接线代码（`lib/mcp-server.js` 经 `lazyModule` 懒加载，`--version` 等命令不付 MCP 依赖的启动成本）：

```js
async function mcpServer() {
  ensureHome()
  // 0.2.3: initialize is protocol-only; the ledger loads lazily per tool call.
  const store = dbStore()
  const loadLedgerFor = (kind) => {
    /* json mode -> loadJson(); 'commitments' -> matters+commitments parts; else full */
  }
  const { createMcpServer } = await loadMcpServer()
  const server = createMcpServer({
    store,
    loadLedger: loadLedgerFor,      // lazy per table subset
    version: VERSION,
    audit: (entry) => store?.appendAudit(entry),
    // clearance is a process decision, never a tool argument; 0 is the default
  })
  process.stdout.on('error', (e) => { if (e?.code === 'EPIPE') process.exit(0) })
  await server.serve(process.stdin, process.stdout)
}
```

验收命令（`tools/list` = 7、`resources/list` = 4、legacy 版本回显/回退）：

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"resources/list"}' \
  | advisers mcp --stdio
# 期望：id=1 的 result.protocolVersion == "2025-11-25"；缺失/未知版本回显 "2024-11-05"
```

兼容性（旧 5 工具保持可用）：

- 5 个旧工具的**名字、参数与原字段一致**：`advisers_today` `{open, commitments[{id,debtor,creditor,action,dueAt}]}`；`advisers_commit_ls` `{commitments[{id,status,action,dueAt,creditor}]}`；`advisers_who` `{mine,waiting}`；`advisers_evidence` 直通 `lib/evidence.js`；`advisers_remind` 仍返回 `buildReminders` 结果；只读调用的审计 action 仍是 `mcp.call`。0.3.0 只**新增** §3.1 的 `total`/`truncated`/`limit`/`clearance`/`protectedExcluded` 等字段。
- `tools/list` 只增不减（5 → 7）；旧客户端按工具名调用不受影响。`serverInfo.name` 与默认 `protocolVersion`（2024-11-05）不变，`capabilities` 含 tools + resources。
- 有意的行为差异：未知方法/参数的错误文案不再回显原始值；未知工具仍为 `-32602`；单行上限 1 MiB；未知 resource 返回 `-32002`。
- 写调用审计失败即 fail-closed：`audit` 绑定 `store.appendAudit`；回调抛错时候选被回滚，调用返回 `isError`，账本不变。
- 自动化验收：`test/cli-mcp-json.test.js` 在真实 CLI 上覆盖 7 工具、4 resources、`-32601/-32602/-32002/-32700/-32600`、候选 pending-only、审计行与 1 MiB 行上限。

集成说明（2026-11-17）：本库 `advisers_pack_verify` 校验的是 evidence-pack v1 目录（`manifest.json`/`README.txt`/`SHA256SUMS` + `receipt.docx` 存在性）。另一路工作已加入 delivery receipt pack v1.1（`lib/evidence.js` `buildReceiptPack` + `lib/receipt-verify.js` `verifyReceiptPackDir`）；等 `deliveries --pack` 切到 v1.1 后，建议把 `verifyReceipt(args)` 改为优先调用 `verifyReceiptPackDir`，并先剥离其 errors 中的绝对路径（该函数目前会把 `dir` 写进错误文案），保持“错误不回显路径”的约定。

## 9. 测试与验收

```sh
cd packages/advisers
node --experimental-strip-types --test test/mcp-server.test.js       # 库协议面
node --experimental-strip-types --test test/mcp-clearance.test.js    # 0.2.5 per-item clearance（A-2）
node --experimental-strip-types --test test/mcp-output-caps.test.js  # 0.3.0 上限/截断/协商
node --experimental-strip-types --test test/cli-mcp-json.test.js     # 真实 CLI stdio 接线
cd ../..
node scripts/check-contracts.mjs --mcp   # 目录/响应与 contracts/mcp/* 对齐（真实 stdio）
node scripts/check-contracts.mjs --status  # status --json 的 contracts 发现字段（已接线并断言）
```

覆盖：initialize/tools/list（7）/resources/list（4）/resources/read、三个 legacy 协议版本回显与未知版本回退、capture 只产生 pending 候选且不动账本、审计回调与 fail-closed 回滚、参数错误码、回执目录校验与篡改检测、1 MiB 行上限、`scripts/mcp-dev.mjs` 的真实 stdio 双进程冒烟；`mcp-output-caps` 覆盖大账本（1,200 open）下三读工具不 `CONTENT_BLOCKED`、`total/truncated/limit` 语义、resources 与 tools 同口径、64 KiB 最后一道字节预算；`cli-mcp-json` 另在真实 `advisers mcp --stdio` 上覆盖同一协议面（7 工具/4 resources/错误码/审计行/行上限）。
