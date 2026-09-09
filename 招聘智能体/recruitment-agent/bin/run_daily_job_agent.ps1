param(
  [switch]$Send,
  [switch]$SendLatestDraft,
  [switch]$Scheduled,
  [switch]$DraftOnly,
  [string]$EnvPath = ".env"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Find-NodeForSharePackage {
  $packageRoot = Resolve-Path -LiteralPath (Join-Path $root "..\..")
  $bundledNodeDir = Join-Path $packageRoot "快捷启动\随项目必须的安装包\node"
  $bundledNode = Join-Path $bundledNodeDir "node.exe"

  function Get-NodeVersion {
    param([string]$NodeExe)
    if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe)) { return "" }
    try {
      return ((& $NodeExe -p "process.versions.node" 2>$null) | Select-Object -First 1).Trim()
    } catch {
      return ""
    }
  }

  function Test-Node224Plus {
    param([string]$NodeExe)
    $version = Get-NodeVersion $NodeExe
    if (-not $version) { return $false }
    try {
      return ([version]$version -ge [version]"22.4.0")
    } catch {
      return $false
    }
  }

  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and (Test-Node224Plus $cmd.Source)) { return $cmd.Source }

  if (Test-Node224Plus $bundledNode) {
    $env:PATH = "$bundledNodeDir;$env:PATH"
    return $bundledNode
  }
  return ""
}

$node = Find-NodeForSharePackage
if (-not $node) {
  $packageRoot = Resolve-Path -LiteralPath (Join-Path $root "..\..")
  $safeRoot = ([string]$packageRoot).Replace("'", "''")
  Write-Host "未找到 Node.js 22.4+。请先复制运行下面的完整命令，或安装 Node.js 22.4+：" -ForegroundColor Yellow
  Write-Host "powershell -NoProfile -ExecutionPolicy Bypass -Command `"Set-Location -LiteralPath '$safeRoot'; & '.\快捷启动\快捷启动脚本\prepare_runtime_menu.ps1'`"" -ForegroundColor Cyan
  exit 127
}

if (Test-Path -LiteralPath $EnvPath) {
  Get-Content -LiteralPath $EnvPath | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
    $idx = $line.IndexOf("=")
    $name = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}
if ([System.IO.Path]::IsPathRooted($EnvPath)) {
  $preflightEnvPath = $EnvPath
} else {
  $preflightEnvPath = Join-Path $root $EnvPath
}
[Environment]::SetEnvironmentVariable("RECRUITMENT_ENV_PATH", $preflightEnvPath, "Process")

if ($Send) {
  [Environment]::SetEnvironmentVariable("SEND_MODE", "send", "Process")
}
if ($DraftOnly) {
  [Environment]::SetEnvironmentVariable("SEND_MODE", "draft", "Process")
  [Environment]::SetEnvironmentVariable("SUPPRESS_ALERTS", "true", "Process")
}
if ($Scheduled) {
  $scheduledSendMode = [Environment]::GetEnvironmentVariable("SCHEDULE_SEND_MODE", "Process")
  if (-not $scheduledSendMode) { $scheduledSendMode = "draft" }
  [Environment]::SetEnvironmentVariable("PREFLIGHT_SEND_MODE", $scheduledSendMode, "Process")
}

& $node .\src\main\preflight.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Scheduled) {
  $autoStartCdp = [Environment]::GetEnvironmentVariable("AUTO_START_CDP", "Process")
  if (-not $autoStartCdp -or $autoStartCdp.ToLower() -ne "false") {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\ensure_chrome_cdp.ps1
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  & $node .\src\main\scheduled_entry.js
} elseif ($SendLatestDraft) {
  & $node .\src\push\send_existing_draft.js
} else {
  & $node .\src\main\daily_workflow.js
}

exit $LASTEXITCODE


