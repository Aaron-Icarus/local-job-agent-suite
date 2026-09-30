# 打开各渠道平台页面快捷方式：启动（或复用）项目专用 CDP Chrome，并打开 BOSS、猎聘 平台页面。
# 只触发浏览器实例与平台页面，不执行登录校验、采集、筛选、评分、发送等任何后续动作。
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = $PSScriptRoot
$packageRoot = Resolve-Path -LiteralPath (Join-Path $scriptDir "..\..")
$projectRoot = Join-Path $packageRoot "招聘智能体\recruitment-agent"
$ensureChrome = Join-Path $projectRoot "tools\ensure_chrome_cdp.ps1"
$openPagesJs = Join-Path $projectRoot "tools\open_platform_pages.js"

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

if (-not (Test-Path -LiteralPath $openPagesJs)) {
  throw "未找到平台页面脚本：$openPagesJs"
}

# 1) 确保可见的项目专用 CDP Chrome 已启动（未启动则启动，已启动则复用）
Set-Location -LiteralPath $projectRoot
powershell -NoProfile -ExecutionPolicy Bypass -File $ensureChrome -Visible
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 2) 打开 BOSS / 猎聘 平台页面（仅打开页面，不执行其它动作）
$node = Find-Node
if (-not $node) {
  Write-Host "未找到 Node.js 22.4+。请先运行 准备运行环境.cmd。" -ForegroundColor Yellow
  exit 127
}
& $node $openPagesJs 2>&1 | ForEach-Object { Write-Output $_ }
exit $LASTEXITCODE
