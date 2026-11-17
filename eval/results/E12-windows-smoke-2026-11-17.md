# E12 Windows 原生 smoke — Advisers 0.2.0 (2026-11-17)

> 状态：**PASS-with-notes**。Windows 11 原生 PowerShell 5.1 + Node v24.22.1 环境下的
> 临时前缀安装 / 首启 / TOS 同意门 / Pet Brief / Office 生成与校验 / 中文编码 / 清理
> **23/23 项 PASS，0 FAIL**（主矩阵 20 + 补充 3）。无功能缺陷；遗留项均为**范围说明与依赖告警**，见 §6。
> 全程未使用任何账号凭据或访问密钥（安装的是公开包，registry 匿名可读）。

## 0. 执行摘要

| 判定 | 数量 |
|---|---|
| PASS | 23（主矩阵 20 + 补充 3） |
| FAIL | 0 |
| 未执行（超范围） | — |
| 非 0 退出 | 1 次，**且为预期**（TOS 同意门 `exit 3`） |

关键结论：

1. `npm install -g --prefix <TEMP>\prefix` 在 Windows 原生环境 exit 0（230 包 / 39s），
   生成的 `advisers.cmd` shim 可直接调用，`--version` = **0.2.0**。
2. 包内许可与元数据一致：`version=0.2.0`、`license=PolyForm-Noncommercial-1.0.0`，
   `LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md` 三件齐全。
3. **同意门按契约工作**：未同意时非交互调用返回 **exit 3 / `E_TOS_REQUIRED`**，
   **stdout 零行**（干净），stderr 一行中文提示；同意后同一条命令 exit 0 并落库。
4. Office 链路可用：weekly 模板 → 10166 字节 docx → `verify` 9/9 checks ok；
   中文标题/正文/表格在 `word/document.xml` 内**逐字节完好**，东亚洲字体已写入。

---

## 1. 环境

| 项 | 值 |
|---|---|
| OS（`[System.Environment]::OSVersion`） | `Microsoft Windows NT 10.0.26200.0` |
| OS 名称 | Microsoft Windows 11 家庭版 中文版 |
| PowerShell（`$PSVersionTable.PSVersion`） | `5.1.26100.9818`（Windows PowerShell，非 pwsh 7） |
| node -v | `v24.22.1` ✅ ≥ 22.13，且为推荐线 24 |
| npm.cmd -v | `11.16.0` |
| 默认 registry（`npm.cmd config get registry`） | `https://registry.npmjs.org/` |
| 显式 registry | 每条 npm 命令均带 `--registry https://registry.npmjs.org/` |
| `%TEMP%` | `C:\Users\zzhdz\AppData\Local\Temp` |
| 管理员权限 | `False`（`IsInRole(Administrator)`）—— 全程无提权 |
| `chcp` 前 | `Active code page: 936` |
| `chcp` 后 | `Active code page: 65001` |
| `[Console]::OutputEncoding`（chcp 65001 后） | `utf-8` |

### 1.1 chcp 65001 前后的中文显示

同一句中文字面量在切换前后各输出一次，**两次均正确、无乱码**：

```text
== chinese-before ==        # chcp 936
中文测试 报价 2026-11-20 王工
== chinese-after ==         # chcp 65001
中文测试 报价 2026-11-20 王工
```

> 说明：脚本化测试把输出重定向到管道，宿主按 UTF-8 解码，因此 936 代码页下也未见乱码；
> 但这**不能**推广为「936 交互式控制台必然正常」——本次未做交互式手敲验证（见 §6-R7）。

---

## 2. 安装结果

安装根目录（`%TEMP%` 下，GUID 命名，无复用）：

```text
SMOKE_DIR = C:\Users\zzhdz\AppData\Local\Temp\advisers-win-smoke-017c8442290b42d9a642acefcbbd445d
PREFIX    = ...\advisers-win-smoke-017c8442290b42d9a642acefcbbd445d\prefix
ADVHOME   = ...\advisers-win-smoke-017c8442290b42d9a642acefcbbd445d\home
```

### 2.1 安装命令与退出码

```powershell
npm.cmd install -g --prefix $prefix --registry https://registry.npmjs.org/ `
  advisers@0.2.0 advisers-office@0.2.0
```

| 项 | 值 |
|---|---|
| `INSTALL_EXIT` | **0** |
| 结果行 | `added 230 packages in 39s` |
| funding | `82 packages are looking for funding` |
| 告警 | 7 条 `npm warn deprecated`（见 §6-R1） |
| 包数量 | 8962 个文件 / 170,989,741 字节（含 node_modules） |

### 2.2 shim 与版本

```text
Prefix bin:
  advisers        417
  advisers.cmd    339
  advisers.ps1    861

ADV_EXISTS   = True
VERSION_EXIT = 0
VERSION_OUT  = 0.2.0
```

### 2.3 包元数据与许可文件

| 包 | version | license | LICENSE | NOTICE | THIRD-PARTY-NOTICES.md |
|---|---|---|---|---|---|
| `advisers` | 0.2.0 | PolyForm-Noncommercial-1.0.0 | ✅ | ✅ | ✅ |
| `advisers-office` | 0.2.0 | PolyForm-Noncommercial-1.0.0 | ✅ | ✅ | ✅ |

`advisers/package.json` 关键字段：

```text
bin      : advisers=./bin/advisers.js
engines  : {"node":">=22.13"}
dependencies: @pdf-lib/fontkit@^1.1.1, advisers-core@0.2.0, advisers-policy-strict@0.2.0,
              jszip@^3.10.2, pdf-lib@^1.17.1, pdfjs-dist@^6.5.438
```

`advisers` 包体文件：`bin lib node_modules index.js LICENSE NOTICE package.json
README-zh.md README.md THIRD-PARTY-NOTICES.md`。

> ⚠️ `advisers-core` 与 `advisers-policy-strict` 被 npm **嵌套**安装到
> `advisers/node_modules/` 下，而不是提升到 `prefix/node_modules/` 顶层（见 §6-R2）。

---

## 3. 测试矩阵

环境变量（每条命令所在进程内设置）：`ADVISERS_HOME=%TEMP%\...\home`、
`ADVISERS_NO_MODEL=1`、同意后 `ADVISERS_ACCEPT_TOS=1`。

| # | 命令 | 期望 | 实际 | exit | 判定 |
|---|---|---|---|---|---|
| 1 | `node -v` | ≥ 22.13 | `v24.22.1` | 0 | **PASS** |
| 2 | `npm.cmd -v` | 可执行 | `11.16.0` | 0 | **PASS** |
| 3 | `npm.cmd config get registry` | npmjs | `https://registry.npmjs.org/` | 0 | **PASS** |
| 4 | `npm.cmd install -g --prefix … advisers@0.2.0 advisers-office@0.2.0` | exit 0 | added 230 packages in 39s | **0** | **PASS** |
| 5 | `& $adv --version` | `0.2.0` | `0.2.0` | 0 | **PASS** |
| 6 | `package.json` version / license | 0.2.0 / PolyForm-NC-1.0.0 | 0.2.0 / PolyForm-Noncommercial-1.0.0 | — | **PASS** |
| 7 | 包内 `LICENSE`/`NOTICE`/`THIRD-PARTY-NOTICES.md` | 均存在 | 两包三件齐全 | — | **PASS** |
| 8 | `'' \| & $adv commit add '周五前发报价给王工' --quote …`（**未同意**） | exit 3 + `E_TOS_REQUIRED`，stdout 干净 | exit 3，stderr 1 行含 `E_TOS_REQUIRED`，**stdout 0 行** | **3**（预期） | **PASS** |
| 9 | `& $adv tos status --json`（同意前） | `accepted=false` | `accepted=false`，`reason=missing` | 0 | **PASS** |
| 10 | `& $adv init` | exit 0 | 写出 home / soul.md，打印 next | 0 | **PASS** |
| 11 | `& $adv status` | exit 0 | version 0.2.0 / node v24.22.1 / local mode | 0 | **PASS** |
| 12 | `& $adv doctor` | 全 PASS | **8/8 PASS** | 0 | **PASS** |
| 13 | `& $adv audit` | verified | `audit: verified (2 entries)` | 0 | **PASS** |
| 14 | `& $adv tos status --json`（同意后） | `accepted=true` / channel=env | `accepted=true`，`channel=env`，`nonInteractive=true` | 0 | **PASS** |
| 15 | `& $adv pet-brief --json` | `schemaVersion=2` + `displayPolicy=private` | `2` / `private` | 0 | **PASS** |
| 16 | `& $adv pet-brief --check` | exit 0，`ok=true` | `ok=true`，`errors=[]`，`warnings=[]` | 0 | **PASS** |
| 17 | `& $adv template weekly $jsonPath $docx` | exit 0，生成 docx | `wrote …\out\weekly.docx (10166 bytes)` | 0 | **PASS** |
| 18 | `& $adv verify $docx` | exit 0，`ok=true` | `ok=true`，**9/9 checks ok** | 0 | **PASS** |
| 19 | 中文 / BOM / docx 文本完整性 | 无乱码、无 BOM | 见 §5，全部完好 | — | **PASS** |
| 20 | 清理（Resolve-Path → Remove-Item → Test-Path） | `Test-Path=False` | `False`，无残留 | — | **PASS** |

**主矩阵合计：20 PASS / 0 FAIL**；计入 §3.1 补充 3 项后为 **23 PASS / 0 FAIL**。
唯一的非 0 退出是第 8 行的 `exit 3`，属**预期行为**。

### 3.1 补充项（超出题目要求，用于闭合「同意门放开」这一环）

| 命令 | 期望 | 实际 | exit | 判定 |
|---|---|---|---|---|
| `commit add … --due 2026-11-20T18:00:00+08:00`（**已同意**） | exit 0 | `cm_mwkd5fln_g6s9ed7_2 open 周五前发报价给王工 due 2026-11-20T18:00:00+08:00` | 0 | **PASS** |
| `status`（commit 后） | matters/deliveries 递增 | `matters 1` / `deliveries 1` | 0 | **PASS** |
| `pet-brief --json`（commit 后） | 脱敏生效 | `commitments 1`，`王工` → `某客户`（redactions 记 4 处） | 0 | **PASS** |

> 这一步是为了避免「门关了但没证明门会开」的断点式结论：同一条命令在同意后确实 exit 0。

---

## 4. 关键原始输出（截断，无任何凭据/真实客户数据）

### 4.1 TOS 同意门（未同意，非交互）

```text
GATE_EXIT=3
---- stdout ----
STDOUT_LINE_COUNT=0
---- stderr ----
advisers: 需要先同意使用条款 2026.11.2（E_TOS_REQUIRED）。运行 advisers tos show 查看全文；
非交互环境加 --accept-tos 或 ADVISERS_ACCEPT_TOS=1。
STDERR_LINE_COUNT=1
STDERR_HAS_E_TOS_REQUIRED=True
STDOUT_HAS_E_TOS_REQUIRED=False
```

### 4.2 `tos status --json`（同意后）

```json
{
  "version": "2026.11.2",
  "manifestVersion": "2026.11.2",
  "effectiveFrom": "2026-11-17",
  "textSha256": "c40f869ad806e74a2e3870e7041d4d4602f6d1a4c2619b80b3e453333b9713dd",
  "canonical": "docs/TOS.md",
  "url": "https://github.com/PerryLink/advisers/blob/main/docs/TOS.md",
  "accepted": true,
  "reason": "accepted",
  "acceptance": {
    "version": "2026.11.2",
    "sha256": "c40f869ad806e74a2e3870e7041d4d4602f6d1a4c2619b80b3e453333b9713dd",
    "acceptedAt": "2026-11-17T07:20:29.613Z",
    "channel": "env",
    "nonInteractive": true
  },
  "store": { "type": "sqlite", "path": "…\\home\\state.db" },
  "audit": { "available": true, "verified": true, "brokenAt": null, "count": 2,
             "counts": { "accept": 1, "block": 1, "reaccept": 0, "revoke": 0 } }
}
```

同意前同一命令为 `"accepted": false`、`"reason": "missing"`、`audit.count: 1`（仅 block）。

### 4.3 `doctor`（8/8 PASS）

```text
PASS  node  v24.22.1
PASS  home  C:\Users\zzhdz\AppData\Local\Temp\advisers-win-smoke-017c84…\home
PASS  sqlite  C:\Users\…\home\state.db (ok)
PASS  audit  1 entries
PASS  schema  18
PASS  office  advisers-office resolvable
PASS  policy  strict pack loaded
PASS  model  optional; ADVISERS_API_KEY not set
```

### 4.4 `audit`（哈希链 verified）

```text
audit: verified (2 entries)
2  2026-11-17T07:20:29  tos.accept  allow  version=2026.11.2;sha256=c40f86…;channel=env;nonInteractive=1;scope=app
1  2026-11-17T07:20:24  tos.block   deny   version=2026.11.2;sha256=c40f86…;channel=none;nonInteractive=1;scope=app;reason=missing
```

> 时间戳为 **UTC**；本地时区 Asia/Shanghai（+08:00）对应 15:20，与本次执行时刻一致。

### 4.5 `init` / `status`

```text
INIT_EXIT=0
home   …\advisers-win-smoke-017c84…\home
soul   …\home\soul.md
next   advisers doctor
       advisers template weekly examples/templates/weekly.json out/weekly.docx
       advisers commit add "周五前发报价给王工" --quote "周五前发报价给王工" --due <ISO>

STATUS_EXIT=0
version   0.2.0
node      v24.22.1
office    external package
home      …\advisers-win-smoke-017c84…\home
store     sqlite (…\home\state.db)
model     not configured (local mode)
matters   0
prefs     0
routines  0
links     0
sessions  0
deliveries 0
soul      present
```

### 4.6 Pet Brief（`--json` 未建账时）

```json
{
  "schemaVersion": 2,
  "source": "advisers",
  "displayPolicy": "private",
  "counts": { "today": 0, "commitments": 0, "risks": 0, "facts": 0 },
  "today": [], "commitments": [], "risks": [], "facts": [],
  "mood": "calm",
  "suggestedLines": [],
  "redactions": [
    "不含文档正文、邮件正文、聊天记录",
    "不含模型推理、系统提示或原始提示词",
    "联系人/客户名默认不进入 brief"
  ]
}
```

`--check`（exit 0）：

```json
{ "ok": true, "checked": "generated", "expiresAt": "2026-11-17T07:25:35.842Z",
  "counts": { "today": 0, "commitments": 0, "risks": 0, "facts": 0 },
  "errors": [], "warnings": [] }
```

建账后（模拟数据「王工 / 报价 / 2026-11-20」）脱敏生效：

```json
"commitments": [
  { "who": "某客户", "what": "周五前发报价给某客户", "due": "2026-11-20",
    "risk": "low", "confidence": 0.95 }
],
"suggestedLines": ["某客户的周五前发报价给某客户，2026-11-20到期。"],
"redactions": ["联系人/客户名已脱敏为“某客户”（4 处）", …]
```

### 4.7 `template weekly` / `verify`

```text
TEMPLATE_EXIT=0
wrote C:\Users\…\out\weekly.docx (10166 bytes)
DOCX_BYTES=10166

VERIFY_EXIT=0
ok: true, missing: [], entries: 17, bytes: 37481
layers: [opc, xml, content-types, rels, revisions]
```

`verify` 的 9 项检查全部 `ok: true`：

| check | severity | detail |
|---|---|---|
| `zip.entries` | blocker | 17 entries (17 files, limit 2000) |
| `zip.entry-paths` | blocker | all entry names are relative and safe |
| `zip.uncompressed-budget` | blocker | 36.6 KiB across 17 files (limits 64.0 MiB / 16.0 MiB) |
| `zip.text-budget` | blocker | largest decoded text entry: 8082 chars (limit 8388608) |
| `xml.wellformed` | blocker | all XML/rels entries are well-formed |
| `opc.required-parts` | blocker | required docx parts are present |
| `opc.content-types` | blocker | content types declared for main part and every part |
| `opc.relationships` | blocker | all relationship targets resolve |
| `docx.revisions` | warn | no tracked changes (w:ins/w:del) found |

---

## 5. 中文 / 编码 / BOM 观察

| 检查点 | 方法 | 结果 |
|---|---|---|
| 控制台中文 | `chcp` 936 → 65001 各输出一次 | 两次均正确，**无乱码** |
| 输入 JSON 无 BOM | 前 3 字节比对 `EF BB BF` | `JSON_BOM=False`，115 字节 |
| 输入 JSON 编码 | `[IO.File]::WriteAllText` + `UTF8Encoding($false)` | UTF-8 无 BOM |
| docx 中文正文 | 解压 `word/document.xml`，按 UTF-8 读 | 7190 字符，**逐串命中** |
| 乱码哨兵 | 查 U+FFFD | `HAS_REPLACEMENT_CHAR=False` |
| 文本 run 结构 | `<w:t(?:\\s[^>]*)?>([^<]*)</w:t>` | 17 个 run，**无 XML 标签泄漏进正文** |
| 东亚洲字体 | 查 `word:rFonts/@w:eastAsia` | `eastAsia="Microsoft YaHei"` 已写入 |

`<w:t>` 提取出的全部文本（原样）：

```text
2026-W46 周报
BLUF：先说结论，再列事实
本周完成
完成 A 客户报价
风险与阻塞
B 项目排期紧
下周计划
交付 Q4 预算表
一页摘要
项 / 内容 / 周期 / 2026-W46 / 完成 / 1 项 / 风险 / 1 项
```

docx 内 17 个 OOXML 部件：`word/document.xml`、`word/styles.xml`、`word/settings.xml`、
`word/numbering.xml`、`word/fontTable.xml`、`word/theme/theme1.xml`、`word/footnotes.xml`、
`word/endnotes.xml`、`docProps/{core,custom,app}.xml`、`[Content_Types].xml` 及各 `_rels`。

> 无 BOM、无 CRLF 变异、无乱码。中文字体名 `Microsoft YaHei` 在 Windows 上必然可解析
> （本机自带），因此本机打开不会回退字体。

---

## 6. 偏差与风险

> 口径：本节只记**实测到的事实**；未能复现的推断一律标「未核实」。

| ID | 类型 | 描述 | 影响 | 处置建议 |
|---|---|---|---|---|
| **R1** | 告警 | 安装期 7 条 `npm warn deprecated`：`inflight@1.0.6`、`lodash.isequal@4.5.0`、`rimraf@2.7.1`、`glob@7.2.3`、`fstream@1.0.12`、`uuid@8.3.2` | 无功能影响；来自**传递依赖** | **未溯源**（安装树已按约束清理）。`advisers` 直接依赖清单中不含这些包，故可判定非直接依赖；建议在 CI 用 `npm ls <pkg>` 定位上游后择机升级 |
| **R2** | 观察 | `advisers-core`、`advisers-policy-strict` 被安装在 `advisers/node_modules/` 嵌套层，而非顶层提升 | 功能正常（`doctor` 的 `office`/`policy` 均 PASS）；但 `npm ls -g --prefix … advisrs-core` 显示 `(empty)`，易被误判为「缺包」 | 属 npm 去重策略结果，**非缺陷**；盘点时应查 `advisers/node_modules/`（本条即 §结论纪律要求的「避免转引误判」） |
| **R3** | 时序 | 首启被同意门拦截时，`ADVISERS_HOME` 下**已**创建 `audit.key`/`state.db`(`-shm`/`-wal`) | 无 PII、无凭据；审计只记一条 `tos.block` | 设计上可接受（要为「拒绝」留证），仅提示：门禁**不保证**零写入 |
| **R4** | 时序 | 首次 `tos status --json` 返回 `accepted=false`，因为**同意是在其后第一条受门禁命令（`init`）时记录的** | 非缺陷，但输出顺序易被误读为「同意失败」 | 复跑一次即得 `accepted=true`（§4.2 已复跑取证） |
| **R5** | 范围 | 只安装 `advisers` + `advisers-office`；`advisers-bridge-hermes`、`dsh-advisers` **本次未装**（题目未要求） | 未覆盖这两个包在 Windows 的安装/首启 | 如需完整六包覆盖，另开一轮加装这两包 |
| **R6** | 范围 | `ADVISERS_NO_MODEL=1`，全程 local 模式，**未接任何模型** | 未覆盖需要模型的功能面（本任务也不需要） | 按硬性约束「不索取任何凭据」，本项**有意不测** |
| **R7** | 范围 | 未做交互式 TTY 人工验证（`chcp 936` 下的交互式控制台中文、`tos show` 分页、交互式同意提示） | 交互路径的终端渲染未取证 | 脚本化重定向已覆盖契约层；交互层建议人工补测 |
| **R8** | 范围 | `verify` 是**结构层**校验（OPC/XML/rels/预算/修订）；未用 Word/WPS 应用层打开渲染 | 视觉渲染（分页、字体替换）未取证 | 另测 WPS/Word 打开（参考既有 `windows-wps-2026-11-14.md`） |
| **R9** | 环境 | 仅在 Node **v24.22.1** 上验证，未覆盖 `engines` 下限 **22.13** | 最低版本线未取证 | CI 已有 Node 22 矩阵（见 E11），本机 smoke 不重复 |
| **R10** | 测量 | `npm ls -g --prefix $prefix advisrs-core advisrs-office` 打印 `(empty)` | 是**该子命令与 `--prefix` 组合的测量假象**，不是包缺失——同一目录下两个包确实存在且可用 | 引用该输出时须同时引用 `Test-Path` 与 `doctor` 结果 |

**未出现的偏差**：无失败项、无崩溃、无乱码、无残留、无非预期非 0 退出、无凭据泄漏。

---

## 7. 清理确认

删除前先 `Resolve-Path` 打印绝对路径，并用三重校验确认位于 `%TEMP%` 下：

```text
---- Resolve-Path ----
C:\Users\zzhdz\AppData\Local\Temp\advisers-win-smoke-017c8442290b42d9a642acefcbbd445d
---- guards ----
TEMP=C:\Users\zzhdz\AppData\Local\Temp
PARENT=C:\Users\zzhdz\AppData\Local\Temp
LEAF=advisers-win-smoke-017c8442290b42d9a642acefcbbd445d
PARENT_EQ_TEMP=True           # 父目录严格等于 %TEMP%
LEAF_PREFIX_OK=True           # 目录名以 advisers-win-smoke- 开头
UNDER_TEMP=True
GUARD=PASS -> deleting
REMOVE_EXIT=True
TESTPATH_AFTER=False
STATE_FILE_GONE=True          # 辅助状态文件 %TEMP%\advisers-win-smoke-state.txt 一并删除
LEFTOVER_COUNT=0              # %TEMP% 下无任何 advisers-win-smoke-* 残留
```

| 项 | 结果 |
|---|---|
| Resolve-Path 输出 | `C:\Users\zzhdz\AppData\Local\Temp\advisers-win-smoke-017c8442290b42d9a642acefcbbd445d` ✅ 在 `%TEMP%` 下 |
| 删除范围 | **仅**该 GUID 目录（8962 文件 / 170,989,741 字节）+ 1 个自建状态文件 |
| 未触及 | 仓库文件、`%TEMP%\dsh-*`（宿主运行目录）、用户 home、全局 npm 前缀、其它任何目录 |
| `Test-Path $smoke` | **False** |
| 残留扫描 | `LEFTOVER_COUNT=0` |

---

## 8. 结论

**PASS-with-notes。**

Windows 11 原生环境（PowerShell 5.1 + Node v24.22.1，非管理员、无登录、公开包）下：

- **安装**：`--prefix` 临时前缀安装 exit 0，shim 可用，`--version` = 0.2.0；
  许可三件套齐全，版本与许可字段与发布口径一致。
- **首启 / 同意门**：未同意 → `exit 3` + `E_TOS_REQUIRED` + **stdout 零输出**；
  同意后 → `accepted=true`（`channel=env`、`nonInteractive=true`、TOS v2026.11.2），
  审计链 `verified`，同一条 `commit add` 顺利落库。
- **Pet Brief**：`schemaVersion=2`、`displayPolicy=private`、`--check ok=true`，
  且 `王工` 在 brief 中被脱敏为 `某客户` —— 隐私默认值在 Windows 路径上同样生效。
- **Office**：docx 生成与 9/9 结构校验全绿，中文标题/正文/表格字节级完好，
  东亚洲字体已显式写入。
- **编码**：全链路 UTF-8，无 BOM、无乱码、无替换字符。
- **清理**：`Resolve-Path` 取证在 `%TEMP%` 下，删除后 `Test-Path=False`，零残留。

**判定为 PASS 而非 FAIL 的理由**：23/23 项 PASS，唯一的非 0 退出（exit 3）是同意门的
**设计预期**。之所以加 `-with-notes`，是因为 §6 中 R1（传递依赖告警）与 R5/R7/R8
（范围未覆盖：bridge-hermes、dsh-advisers、交互式 TTY、应用层渲染）属于**未取证的空白**，
不应被表述为「全部已验证」。

### 复现要点（照跑应得同一结论）

```powershell
$smoke = Join-Path $env:TEMP ('advisers-win-smoke-' + [guid]::NewGuid().ToString('n'))
$prefix = Join-Path $smoke 'prefix'; $advHome = Join-Path $smoke 'home'
New-Item -ItemType Directory -Force -Path $prefix, $advHome | Out-Null
npm.cmd install -g --prefix $prefix --registry https://registry.npmjs.org/ advisers@0.2.0 advisers-office@0.2.0
$adv = Join-Path $prefix 'advisers.cmd'
$env:ADVISERS_HOME = $advHome; $env:ADVISERS_NO_MODEL = '1'
Remove-Item Env:ADVISERS_ACCEPT_TOS -ErrorAction SilentlyContinue
'' | & $adv commit add '周五前发报价给王工' --quote '周五前发报价给王工'   # 期望 exit 3
$env:ADVISERS_ACCEPT_TOS = '1'
& $adv init; & $adv doctor                                              # 期望全 PASS
& $adv pet-brief --json                                                 # schemaVersion=2
Resolve-Path $smoke; Remove-Item -Recurse -Force $smoke; Test-Path $smoke  # False
```

---

*报告生成：2026-11-17 15:22（Asia/Shanghai）。执行者：DSH lead agent。*
*本报告仅记录测试，未修改/提交仓库代码，未发布任何包，未使用任何凭据。*
