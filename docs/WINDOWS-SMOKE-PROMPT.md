# Windows 原生 smoke — 给 Windows DSH 的提示词

> 用法：把下面「提示词正文」整段复制给 Windows 上的 DSH/agent；它执行完会把报告写到
> `D:/Projects/dsh/plugins/advisers/eval/results/E12-windows-smoke-2026-11-17.md`，
> 把报告发回即可。人工步骤与注意事项见 [WINDOWS-SMOKE.md](WINDOWS-SMOKE.md)。

---

## 提示词正文（复制从这里开始）

你在 Windows 上为 Advisers 0.2.0 执行「Windows 原生安装/首启 smoke 测试」，并生成一份 Markdown 报告。只做测试与记录，不修改/提交仓库代码，不发布任何包。

### 背景

- Advisers 0.2.0 已发布到 npm 官方 registry（latest=0.2.0，六包：advisers、advisers-core、advisers-office、advisers-policy-strict、advisers-bridge-hermes、dsh-advisers）。
- 目标：验证 Windows 原生（PowerShell + Node）安装、首启、TOS 同意门、Pet Brief、Office 生成/校验、编码与清理；报告用于发布证据。

### 硬性约束

1. 不索取、不打印、不记录任何 token、OTP、API key、密码；本测试不需要登录 npm（安装公开包）。
2. 所有安装/数据目录必须在 %TEMP% 下；不要用 $home/$profile 当变量名；不要写全局 npm 前缀；不需要管理员权限。
3. npm 命令显式 `--registry https://registry.npmjs.org/`。
4. 不修改仓库文件；报告写入 `D:/Projects/dsh/plugins/advisers/eval/results/E12-windows-smoke-2026-11-17.md`（若目录不存在，写桌面并注明实际路径）。
5. 测试数据只用假数据（如“王工/报价/2026-11-20”），不用真实客户信息。
6. 清理前先 Resolve-Path 打印临时目录绝对路径，确认在 $env:TEMP 下再删除；不要删其他目录。

### 步骤

#### 0) 环境记录
记录 Windows 版本（[System.Environment]::OSVersion）、PowerShell 版本（$PSVersionTable.PSVersion）、node -v（必须 >= 22.13，推荐 24）、npm.cmd -v、默认 registry（npm.cmd config get registry）、chcp 65001 前后中文显示。

#### 1) 临时安装（PowerShell）

    $smoke = Join-Path $env:TEMP ('advisers-win-smoke-' + [guid]::NewGuid().ToString('n'))
    $prefix = Join-Path $smoke 'prefix'
    $advHome = Join-Path $smoke 'home'
    New-Item -ItemType Directory -Force -Path $prefix, $advHome | Out-Null
    Write-Host "SMOKE_DIR=$smoke"
    npm.cmd install -g --prefix $prefix --registry https://registry.npmjs.org/ advisers@0.2.0 advisers-office@0.2.0
    $adv = Join-Path $prefix 'advisers.cmd'
    & $adv --version

记录：安装 exit code、--version 输出、node_modules/advisers/package.json 的 version/license（应为 0.2.0 / PolyForm-Noncommercial-1.0.0）、包内是否存在 LICENSE、NOTICE、THIRD-PARTY-NOTICES.md。

#### 2) 首启 / TOS 同意门

    $env:ADVISERS_HOME = $advHome
    Remove-Item Env:ADVISERS_ACCEPT_TOS -ErrorAction SilentlyContinue
    $env:ADVISERS_NO_MODEL = '1'
    '' | & $adv commit add '周五前发报价给王工' --quote '周五前发报价给王工'
    Write-Host "GATE_EXIT=$LASTEXITCODE"
    $env:ADVISERS_ACCEPT_TOS = '1'
    & $adv tos status --json
    & $adv init
    & $adv status
    & $adv doctor
    & $adv audit

记录：非交互阻断的 exit code（期望 3）与 stderr 是否含 E_TOS_REQUIRED、stdout 是否干净；tos status 的 accepted/version/channel；init/status/doctor 的 exit code；audit 是否 verified。

#### 3) Pet Brief 与 Office

    & $adv pet-brief --json
    & $adv pet-brief --check
    $weekly = '{"period":"2026-W46","done":["完成 A 客户报价"],"risks":["B 项目排期紧"],"next":["交付 Q4 预算表"]}'
    $jsonPath = Join-Path $smoke 'weekly.json'
    [IO.File]::WriteAllText($jsonPath, $weekly, (New-Object System.Text.UTF8Encoding($false)))
    $docx = Join-Path $smoke 'out/weekly.docx'
    New-Item -ItemType Directory -Force -Path (Split-Path $docx) | Out-Null
    & $adv template weekly $jsonPath $docx
    Write-Host "TEMPLATE_EXIT=$LASTEXITCODE"
    & $adv verify $docx
    Write-Host "VERIFY_EXIT=$LASTEXITCODE"

记录：pet-brief JSON 的 schemaVersion=2、displayPolicy 默认 private；--check exit code；docx 大小；verify exit code 与输出；中文标题/正文是否乱码。

#### 4) 清理

    Resolve-Path $smoke
    Remove-Item -Recurse -Force $smoke
    Test-Path $smoke

记录 Resolve-Path 输出（必须在 $env:TEMP 下）与 Test-Path 结果（期望 False）。

### 报告要求（Markdown，UTF-8 无 BOM）

写入约定路径，结构：
1. 环境（OS/PowerShell/Node/npm/registry/chcp）
2. 安装结果（exit code、version/license、包内许可文件）
3. 测试矩阵表：命令 | 期望 | 实际 | exit code | PASS/FAIL
4. 关键原始输出（截断；不得含 token/OTP/真实客户数据）
5. 中文/编码/BOM 观察
6. 偏差与风险（任何非 0 退出、警告、未执行项如实写）
7. 清理确认（Resolve-Path 证据、Test-Path 结果）
8. 结论：Windows smoke PASS / PASS-with-notes / FAIL

完成后回复：报告路径 + 10 行以内摘要（PASS/FAIL 项数、异常、是否清理干净）。不要 commit/push。

## 提示词正文（复制到这里结束）

---

## 收到报告后 lead 的处理

- 把结果写入 `eval/results/E11-release-2026-11-17.md` 的 Windows 平台项；
- 若有 Windows 特有问题（编码/BOM/路径/权限），修文档或代码并在 0.2.1 跟进；
- 报告本身保留在 `eval/results/E12-windows-smoke-2026-11-17.md`。
