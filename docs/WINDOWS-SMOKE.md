# Windows smoke test（发布后，首个目标平台）

> 目的：在 **Windows 原生**（PowerShell 7 + Node >= 22.13）验证 npm 包安装与首启/tos/pet-brief。
> 若要把测试交给 Windows 上的 DSH/agent 执行，直接复制
> [WINDOWS-SMOKE-PROMPT.md](WINDOWS-SMOKE-PROMPT.md) 的提示词正文。
> 无法实机执行时，E11 必须保留「Windows 未验证」的如实记录。

## 前置

- Windows 10/11；PowerShell 7（`pwsh`）；Node >= 22.13（需要 `node:sqlite`；推荐 24）；npm 10/11。
- 只从 `D:\Projects\dsh\plugins\发布令牌.md` 加载 token（`00-live/_key.ps1`），**不打印、不写文件**。
- 所有查询/安装显式 `--registry https://registry.npmjs.org/`。

## 步骤

~~~powershell
# 1) 临时目录（只用 $env:TEMP 派生；不要用 $home/$profile 当变量名）
$smoke = Join-Path $env:TEMP ('advisers-smoke-' + [guid]::NewGuid().ToString('n'))
$prefix = Join-Path $smoke 'prefix'
$advHome = Join-Path $smoke 'home'
New-Item -ItemType Directory -Force -Path $prefix, $advHome | Out-Null
Write-Host "smoke dir: $smoke"   # 删除前必须肉眼确认它落在 $env:TEMP 下

# 2) 安装（临时 prefix，不污染全局）
npm install -g --prefix $prefix --registry https://registry.npmjs.org/ advisers@0.2.0
& (Join-Path $prefix 'advisers.cmd') --version        # 期望 0.2.0

# 3) 首启 + 同意门 + Pet Brief（临时 ADVISERS_HOME）
$env:ADVISERS_HOME = $advHome
$env:ADVISERS_ACCEPT_TOS = '1'
$env:ADVISERS_NO_MODEL = '1'
& (Join-Path $prefix 'advisers.cmd') tos status --json
& (Join-Path $prefix 'advisers.cmd') pet-brief --json
& (Join-Path $prefix 'advisers.cmd') pet-brief --check; Write-Host "pet-brief exit=$LASTEXITCODE"
~~~

## 记录到 E11

- 系统版本（`[System.Environment]::OSVersion`）、PowerShell 版本、Node/npm 版本。
- `advisers --version` 输出、`tos status --json` 的 `accepted/version`、`pet-brief --check` exit code。
- 中文输出是否正常（`chcp 65001`；无乱码）；若有 BOM/编码问题记录原样输出。
- 清理：`Resolve-Path $smoke` 确认位于 `$env:TEMP` 下后，`Remove-Item -Recurse -Force $smoke`。

## 已知环境坑

- PowerShell ExecutionPolicy 可能拦截 `npm.ps1`：改用 `npm.cmd`。
- 全局 npm 前缀写入失败：`--prefix` 必须指向用户可写临时目录。
- Node 22 < 22.13 没有 `node:sqlite`：命令会直接失败，不是包的问题。
