# windows-clean-staged.ps1 - list / reject npm staged-publish backlog on Windows.
# Rejecting requires the npm account owner's 2FA (EOTP); this script pauses and
# retries the same stage id after you authenticate in the browser. It never
# asks for or prints a token/OTP.
#
# Prerequisite (fresh PowerShell):
#   . D:/Projects/dsh/deepseek-community-hub/00-live/_key.ps1   # sets $env:NPM_TOKEN
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows-clean-staged.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows-clean-staged.ps1 -Apply -Limit 3
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows-clean-staged.ps1 -Apply
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows-clean-staged.ps1 -Apply -All -Force
#
# Fast path: create a temporary npm *automation* token (bypasses 2FA for this run),
# paste it hidden, clean everything, then revoke the token on npmjs.com:
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows-clean-staged.ps1 -PromptToken -Apply

[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$All,
  [switch]$Force,
  [int]$Limit = 0,
  [string]$Registry = 'https://registry.npmjs.org/',
  [switch]$PromptToken
)

$ErrorActionPreference = 'Stop'
$OwnPackages = @('advisers','advisers-core','advisers-office','advisers-policy-strict','advisers-bridge-hermes','dsh-advisers')

$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npmCmd) { throw 'npm/npm.cmd not found in PATH' }
$npm = $npmCmd.Source

if ($All -and -not $Force) { throw '-All touches other projects; pass -Force to confirm' }

$oldRc = $env:NPM_CONFIG_USERCONFIG
$tmpRc = $null
$promptedToken = $false
try {
  if ($PromptToken) {
    $secure = Read-Host -AsSecureString -Prompt 'Paste npm automation token (input hidden)'
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $env:NPM_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $promptedToken = $true
    Write-Host 'Using the prompted token for this run only.'
  }
  if ($env:NPM_TOKEN) {
    $tmpRc = Join-Path $env:TEMP ('advisers-npmrc-' + [guid]::NewGuid().ToString('n') + '.npmrc')
    $nl = [Environment]::NewLine
    $content = 'registry=' + $Registry + $nl + '//registry.npmjs.org/:_authToken=' + $env:NPM_TOKEN + $nl
    [IO.File]::WriteAllText($tmpRc, $content)
    $env:NPM_CONFIG_USERCONFIG = $tmpRc
    Write-Host ('temp npmrc: ' + $tmpRc + ' (deleted on exit)')
  } else {
    Write-Host 'NPM_TOKEN not set; using the current npm login (E401 means: load the token first).'
  }

  $raw = & $npm stage list --json --registry $Registry 2>$null
  if ($LASTEXITCODE -ne 0) { throw ('npm stage list failed (exit ' + $LASTEXITCODE + '); check npm auth with: npm.cmd stage list') }
  $jsonText = ($raw -join [Environment]::NewLine)
  $records = $jsonText | ConvertFrom-Json
  if ($All) { $targets = @($records) } else { $targets = @($records | Where-Object { $OwnPackages -contains $_.packageName }) }

  $scope = 'Advisers six packages'
  if ($All) { $scope = 'ALL packages' }
  Write-Host ''
  Write-Host ('staged records: ' + $targets.Count + ' (' + $scope + ')')
  $targets | Sort-Object packageName, createdAt | Format-Table createdAt, packageName, version, tag, id -AutoSize | Out-String | Write-Host

  if (-not $Apply) {
    Write-Host 'List only. Add -Apply to reject (try -Apply -Limit 3 first).'
    return
  }
  if ($targets.Count -eq 0) { Write-Host 'Nothing to clean.'; return }

  $queue = @($targets)
  if ($Limit -gt 0) { $queue = @($queue | Select-Object -First $Limit) }
  $total = $queue.Count
  $rejected = 0
  $skipped = 0
  $aborted = $false

  :loop foreach ($rec in $queue) {
    $done = $false
    while (-not $done) {
      Write-Host ''
      Write-Host ('[' + ($rejected + $skipped + 1) + '/' + $total + '] ' + $rec.packageName + '@' + $rec.version + '  ' + $rec.id)
      & $npm stage reject $rec.id --registry $Registry
      $code = $LASTEXITCODE
      if ($code -eq 0) {
        $rejected = $rejected + 1
        $done = $true
      } else {
        Write-Host ('reject not completed (exit ' + $code + '). If a browser 2FA page appeared: finish it, then press Enter to retry the SAME id.') -ForegroundColor Yellow
        $answer = Read-Host 'Enter=retry / s=skip / q=quit'
        if ($answer -eq 'q') { $aborted = $true; break loop }
        if ($answer -eq 's') { $skipped = $skipped + 1; $done = $true }
      }
    }
  }

  Write-Host ''
  Write-Host ('done: rejected=' + $rejected + ' skipped=' + $skipped + ' remaining=' + ($total - $rejected - $skipped))
  if ($aborted) { Write-Host 'stopped by q; re-run the script to continue.' }
} finally {
  if ($tmpRc -and (Test-Path $tmpRc)) { Remove-Item -Force $tmpRc }
  if ($null -ne $oldRc) { $env:NPM_CONFIG_USERCONFIG = $oldRc } else { Remove-Item Env:NPM_CONFIG_USERCONFIG -ErrorAction SilentlyContinue }
  if ($promptedToken) { Remove-Item Env:NPM_TOKEN -ErrorAction SilentlyContinue }
}
