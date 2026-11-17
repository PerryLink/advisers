# MCP 接入（stdio，protocol 2024-11-05）

状态（2026-11-17）：

- **0.2.0 库**：MCP server 已从 `bin/advisers.js` 抽成可测试库 `packages/advisers/lib/mcp-server.js`（工厂 `createMcpServer({store, ledger, version, audit})`）。库提供 **5 个只读工具 + 2 个白名单工具 + 4 个只读 resources**。
- **CLI 入口（已接线，2026-11-17）**：`advisers mcp --stdio` 与库是同一实现——`bin/advisers.js` 只负责注入 home/store/ledger/version/audit，然后调用 `createMcpServer(...).serve()`；7 工具 + 4 resources 均从 CLI 可用，并自 `0.2.0` 起随 npm 包发布（2026-11-17 已上 `latest`）。仓库内的 `node scripts/mcp-dev.mjs` 保留为开发/双进程冒烟入口，不再是试用新接口的前提。
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

### 3.1 候选写入（必须人工 accept）

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

### 3.2 回执目录校验

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

## 5. 协议与错误码

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

## 8. bin 接线（已完成 2026-11-17）

`packages/advisers/bin/advisers.js` 已切到本库：旧的 `mcpReply/mcpError/mcpTools/mcpServer`（5 只读工具、无 resources、无审计失败回滚）已删除，dispatch 的 `else if (command === 'mcp')` 仍只接受 `--stdio`。接线代码（`lib/mcp-server.js` 经 `lazyModule` 懒加载，`--version` 等命令不付 MCP 依赖的启动成本）：

```js
async function mcpServer() {
  ensureHome()
  const store = dbStore()
  const ledger = loadLedger()
  const { createMcpServer } = await loadMcpServer()
  const server = createMcpServer({
    store,
    ledger,
    version: VERSION,
    audit: (entry) => store?.appendAudit(entry),
  })
  await server.serve(process.stdin, process.stdout)
}
```

验收命令（`tools/list` = 7、`resources/list` = 4、`initialize` 协议不变）：

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"resources/list"}' \
  | advisers mcp --stdio
```

兼容性（旧 5 工具保持可用）：

- 5 个旧工具的**名字、参数、返回数据形状逐字段一致**：`advisers_today` `{open, commitments[{id,debtor,creditor,action,dueAt}]}`；`advisers_commit_ls` 数组 `{id,status,action,dueAt,creditor}`；`advisers_who` `{mine,waiting}`；`advisers_evidence` 直通 `lib/evidence.js`；`advisers_remind` 仍返回 `buildReminders` 结果；只读调用的审计 action 仍是 `mcp.call`。
- `tools/list` 只增不减（5 → 7）；旧客户端按工具名调用不受影响。`initialize` 的 `protocolVersion`/`serverInfo.name` 不变，`capabilities` 增加 resources。
- 有意的行为差异：未知方法/参数的错误文案不再回显原始值；未知工具仍为 `-32602`；单行上限 1 MiB；未知 resource 返回 `-32002`。
- 写调用审计失败即 fail-closed：`audit` 绑定 `store.appendAudit`；回调抛错时候选被回滚，调用返回 `isError`，账本不变。
- 自动化验收：`test/cli-mcp-json.test.js` 在真实 CLI 上覆盖 7 工具、4 resources、`-32601/-32602/-32002/-32700/-32600`、候选 pending-only、审计行与 1 MiB 行上限。

集成说明（2026-11-17）：本库 `advisers_pack_verify` 校验的是 evidence-pack v1 目录（`manifest.json`/`README.txt`/`SHA256SUMS` + `receipt.docx` 存在性）。另一路工作已加入 delivery receipt pack v1.1（`lib/evidence.js` `buildReceiptPack` + `lib/receipt-verify.js` `verifyReceiptPackDir`）；等 `deliveries --pack` 切到 v1.1 后，建议把 `verifyReceipt(args)` 改为优先调用 `verifyReceiptPackDir`，并先剥离其 errors 中的绝对路径（该函数目前会把 `dir` 写进错误文案），保持“错误不回显路径”的约定。

## 9. 测试

```sh
cd packages/advisers
node --experimental-strip-types --test test/mcp-server.test.js     # 库协议面
node --experimental-strip-types --test test/cli-mcp-json.test.js  # 真实 CLI stdio 接线
```

覆盖：initialize/tools/list（7）/resources/list（4）/resources/read、capture 只产生 pending 候选且不动账本、审计回调与 fail-closed 回滚、参数错误码、回执目录校验与篡改检测、1 MiB 行上限、`scripts/mcp-dev.mjs` 的真实 stdio 双进程冒烟；`cli-mcp-json` 另在真实 `advisers mcp --stdio` 上覆盖同一协议面（7 工具/4 resources/错误码/审计行/行上限）。
