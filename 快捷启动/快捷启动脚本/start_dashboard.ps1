param(
  [int]$Port = 17321
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = $PSScriptRoot
$packageRoot = Resolve-Path -LiteralPath (Join-Path $scriptDir "..\..")
$dashboardPath = Join-Path $packageRoot "快捷启动\页面UI\index.html"
$serverScript = Join-Path $scriptDir "local_dashboard_server.js"

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

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and (Test-Node224Plus $cmd.Source)) { return $cmd.Source }

  $candidates = @(
    (Join-Path $packageRoot "快捷启动\随项目必须的安装包\node\node.exe"),
    (Join-Path $packageRoot "快捷启动\随项目必须的安装包\nodejs\node.exe"),
    (Join-Path $packageRoot "runtime\node\node.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Node224Plus $candidate) { return $candidate }
  }
  return ""
}

function Get-CopyPasteCommand {
  param([string]$RelativeScript)
  $safeRoot = ([string]$packageRoot).Replace("'", "''")
  $safeRelative = $RelativeScript.Replace("'", "''")
  return "powershell -NoProfile -ExecutionPolicy Bypass -Command `"Set-Location -LiteralPath '$safeRoot'; & '$safeRelative'`""
}

if (-not (Test-Path -LiteralPath $dashboardPath)) {
  throw "未找到控制台页面：$dashboardPath"
}

$node = Find-Node
if (-not $node) {
  Write-Host "未找到 Node.js。将打开静态控制台页面；文件管理器按钮不可用。" -ForegroundColor Yellow
  Write-Host "请先运行下面的完整命令，或手动安装 Node.js 22.4+：" -ForegroundColor Yellow
  Write-Host (Get-CopyPasteCommand ".\快捷启动\快捷启动脚本\prepare_runtime_menu.ps1") -ForegroundColor Cyan
  Invoke-Item -LiteralPath $dashboardPath
  exit 2
}

$env:LOCAL_DASHBOARD_PORT = [string]$Port
Set-Location -LiteralPath $packageRoot

Write-Host "正在打开本地控制台页面：" -ForegroundColor Green
Write-Host $dashboardPath
Write-Host "本地 helper 将监听：127.0.0.1:$Port。按 Ctrl+C 停止。" -ForegroundColor Cyan
Invoke-Item -LiteralPath $dashboardPath

& $node $serverScript
exit $LASTEXITCODE
