# Windows 原生 smoke（第二轮：剩余空白项）— 给 Windows DSH 的提示词

> 用法：把下面「提示词正文」整段复制给 Windows 上的 DSH/agent。它会把报告写到
> `D:/Projects/dsh/plugins/advisers/eval/results/E13-windows-smoke-round2-2026-11-17.md`。
> 第一轮（23/23 PASS）见 [E12](../../eval/results/E12-windows-smoke-2026-11-17.md) 与 [WINDOWS-SMOKE.md](WINDOWS-SMOKE.md)。

---

## 提示词正文（复制从这里开始）

你在 Windows 上为 Advisers 0.2.0 执行**第二轮原生 smoke**，专门补第一轮未覆盖的空白项，并生成 Markdown 报告。只测试与记录，不修改/提交仓库代码，不发布任何包。

### 目标（第一轮未覆盖）

1. PowerShell 7（pwsh）下的安装/首启/交互式 TTY 行为（第一轮只用了 Windows PowerShell 5.1）。
2. Node 22.13 下限（第一轮只测 Node 24.22.1）：确认 node:sqlite 可用、CLI 可运行。
3. `advisers-bridge-hermes@0.2.0` 与 `dsh-advisers@0.2.0` 的安装/加载（第一轮只装 advisers+office）。
4. 交互式 TOS 同意提示与 `tos show` 中文/分页（第一轮只测非交互）。
5. Word/WPS 应用层打开生成的 docx（第一轮只做 OOXML 结构校验）。

### 硬性约束

1. 不索取/打印/记录 token、OTP、API key、密码；公开 npm 包安装不需要登录。
2. 所有安装/数据目录必须在 %TEMP% 下；不要用 $home/$profile 当变量名；不写全局 npm 前缀；不需要管理员权限。
3. npm 命令显式加 `--registry https://registry.npmjs.org/`。
4. 不修改仓库文件；只写报告文件。测试数据只用假数据（王工/报价/2026-11-20）。
5. 清理前用 Resolve-Path 打印绝对路径，确认位于 $env:TEMP 下再删；不要动其他目录。
6. 如果某软件（PowerShell 7 / Node 22.13 / Word / WPS）未安装：不要安装系统软件；把该项标记为 SKIP 并写明原因。只有 Node 22.13 允许用官方 zip 解压到 %TEMP% 使用。

### 步骤

#### 0) 环境记录
记录：Windows 版本、是否安装 PowerShell 7（`pwsh -v`）、当前 `node -v`/`npm.cmd -v`、默认 registry、`[Console]::OutputEncoding`、是否安装 Word/WPS（Get-Command 或注册表探测）。

#### 1) 安装四个包（用当前 Node 24 + PowerShell 7，若 pwsh 存在）

    $smoke = Join-Path $env:TEMP ('advisers-win2-' + [guid]::NewGuid().ToString('n'))
    $prefix = Join-Path $smoke 'prefix'
    $home1 = Join-Path $smoke 'home1'
    New-Item -ItemType Directory -Force -Path $prefix, $home1 | Out-Null
    npm.cmd install -g --prefix $prefix --registry https://registry.npmjs.org/ advisers@0.2.0 advisers-office@0.2.0 advisers-bridge-hermes@0.2.0 dsh-advisers@0.2.0
    $adv = Join-Path $prefix 'advisers.cmd'
    & $adv --version

记录四个包的 version/license 字段、LICENSE/NOTICE/THIRD-PARTY-NOTICES.md 是否存在。
加载检查：

    node -e "import('advisers-bridge-hermes').then(m => console.log('bridge exports', Object.keys(m).join(','))).catch(e => { console.error('BRIDGE_FAIL', e.message); process.exit(1) })"
    node -e "import('dsh-advisers').then(m => console.log('dsh exports', Object.keys(m).join(','))).catch(e => { console.error('DSH_FAIL', e.message); process.exit(1) })"

若本机有 `dsh` CLI：使用临时 DSH_HOME/配置（不要碰真实 profile），尝试把 `dsh-advisers@0.2.0` 加入临时 profile 并 `--dump-config`，记录是否出现 dsh-advisers 层；失败则标记 SKIP 并记录原因。

#### 2) Node 22.13 下限（可选，用官方 zip 到 %TEMP%）

    $node22zip = Join-Path $env:TEMP 'node-v22.13.0-win-x64.zip'
    Invoke-WebRequest -Uri https://nodejs.org/dist/v22.13.0/node-v22.13.0-win-x64.zip -OutFile $node22zip
    Expand-Archive $node22zip -DestinationPath $smoke -Force
    $node22 = Join-Path $smoke 'node-v22.13.0-win-x64/node.exe'
    & $node22 -v
    $env:ADVISERS_HOME = $home1
    & $node22 (Join-Path $prefix 'node_modules/advisers/bin/advisers.js') --version
    & $node22 (Join-Path $prefix 'node_modules/advisers/bin/advisers.js') status

记录 node:sqlite 是否可用、--version/status exit code；若下载失败标记 SKIP。

#### 3) 交互式 TTY（PowerShell 7 / 5.1 各做一次）

新开一个交互式终端（不要重定向输出），在全新 `ADVISERS_HOME` 下运行：

    $env:ADVISERS_HOME = (Join-Path $smoke 'home-tty')
    Remove-Item Env:ADVISERS_ACCEPT_TOS -ErrorAction SilentlyContinue
    & $adv commit add '周五前发报价给王工' --quote '周五前发报价给王工'

观察并记录：是否出现 8–12 行摘要；输入“同意”后是否接受并继续；输入 Enter 是否拒绝（exit 1）。随后记录：

    & $adv tos status --json
    & $adv tos show
    & $adv audit

另测：在 TTY 下设置 `$env:ADVISERS_ACCEPT_TOS='1'` 是否能绕过提示（TOS §2.5 规定 TTY 下不生效，应仍需提示）；`--accept-tos` 应生效。
再在 `chcp 936` 的交互式控制台重复一次中文提示，记录是否乱码。

#### 4) Word/WPS 应用层（有则做，无则 SKIP）

先生成 docx：

    $weekly = '{"period":"2026-W46","done":["完成 A 客户报价"],"risks":["B 项目排期紧"],"next":["交付 Q4 预算表"]}'
    $jp = Join-Path $smoke 'weekly.json'
    [IO.File]::WriteAllText($jp, $weekly, (New-Object System.Text.UTF8Encoding($false)))
    $docx = Join-Path $smoke 'out/weekly.docx'
    New-Item -ItemType Directory -Force -Path (Split-Path $docx) | Out-Null
    & $adv template weekly $jp $docx
    & $adv verify $docx

若安装 Word：用 PowerShell COM 打开并导出 PDF，记录 Pages/大小：

    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $doc = $word.Documents.Open($docx)
    Write-Host "WORD_PAGES=$($doc.ComputeStatistics(2))"
    $doc.SaveAs([ref]($docx + '.pdf'), [ref]17)
    $doc.Close(); $word.Quit()

若只有 WPS：手动/COM 打开 docx，检查中文、布局、分页是否正常并记录（无法自动化就 SKIP 并说明）。

#### 5) 清理

    Resolve-Path $smoke
    Remove-Item -Recurse -Force $smoke
    Test-Path $smoke

### 报告要求（Markdown，UTF-8 无 BOM）

写入 `D:/Projects/dsh/plugins/advisers/eval/results/E13-windows-smoke-round2-2026-11-17.md`，结构：
1. 环境（OS/PowerShell 5.1+7/Node 24/Node 22.13/npm/registry/Word/WPS）
2. 安装与加载结果（四包 version/license/许可文件、bridge-hermes/dsh-advisers 加载输出、DSH 临时 profile 结果）
3. 测试矩阵表：项 | 期望 | 实际 | exit | PASS/SKIP/FAIL
4. 关键原始输出（截断，无 token/OTP/真实数据）
5. 交互式 TTY 与中文/编码观察（提示原文、同意/拒绝结果）
6. Word/WPS 渲染结果（页数/字体/布局；未安装则 SKIP）
7. 偏差与风险
8. 清理确认
9. 结论：PASS / PASS-with-notes / FAIL

完成后回复报告路径 + 10 行摘要。不要 commit/push。

## 提示词正文（复制到这里结束）

---

## 收到报告后 lead 的处理

- 写入 E11 的 Windows 项/E13 链接；
- PowerShell 7 / Node 22.13 / bridge-hermes / dsh-advisers / TTY / Word-WPS 的结论按实记录；
- 发现的问题进入 0.2.1 待办。
