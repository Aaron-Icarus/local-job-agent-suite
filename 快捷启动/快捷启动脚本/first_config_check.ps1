param()

$ErrorActionPreference = "Continue"
Set-StrictMode -Version Latest

$scriptDir = $PSScriptRoot
$packageRoot = Resolve-Path -LiteralPath (Join-Path $scriptDir "..\..")
$recruitmentRoot = Join-Path $packageRoot "AI消息群聊转发agent\recruitment-agent"
$messageRoot = Join-Path $packageRoot "定时执行agent程序\message-platform"

function Test-ItemReadable {
  param([string]$Label, [string]$Path)
  if (Test-Path -LiteralPath $Path) {
    Write-Host ("OK  {0}：{1}" -f $Label, $Path) -ForegroundColor Green
    return $true
  }
  Write-Host ("缺失 {0}：{1}" -f $Label, $Path) -ForegroundColor Yellow
  return $false
}

function Find-Chrome {
  $roots = @(
    [Environment]::GetEnvironmentVariable("ProgramFiles"),
    [Environment]::GetEnvironmentVariable("ProgramFiles(x86)"),
    [Environment]::GetEnvironmentVariable("LOCALAPPDATA")
  ) | Where-Object { $_ }
  foreach ($root in $roots) {
    $candidate = Join-Path $root "Google\Chrome\Application\chrome.exe"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return ""
}

function Find-Node {
  $candidate = Join-Path $packageRoot "快捷启动\随项目必须的安装包\node\node.exe"
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ""
}

Write-Host ("分享包根目录：{0}" -f $packageRoot) -ForegroundColor Cyan
Test-ItemReadable "招聘 Agent" $recruitmentRoot | Out-Null
Test-ItemReadable "消息平台" $messageRoot | Out-Null
Test-ItemReadable "PRD 目录" (Join-Path $packageRoot "docs\prd") | Out-Null
Test-ItemReadable "候选人画像目录" (Join-Path $recruitmentRoot "config\candidate_profiles") | Out-Null
Test-ItemReadable "招聘 Agent 示例配置" (Join-Path $recruitmentRoot ".env.example") | Out-Null
Test-ItemReadable "消息平台示例配置" (Join-Path $messageRoot ".env.example") | Out-Null

$node = Find-Node
if ($node) {
  $nodeVersion = ""
  try { $nodeVersion = (& $node -p "process.versions.node" 2>$null).Trim() } catch { $nodeVersion = "" }
  $nodeMajor = 0
  if ($nodeVersion) { $nodeMajor = [int](($nodeVersion -split "\.")[0]) }
  if ($nodeMajor -ge 20) {
    Write-Host ("OK  Node.js：{0} ({1})" -f $node, $nodeVersion) -ForegroundColor Green
  } else {
    Write-Host ("版本过低 Node.js：{0} ({1})。请运行 快捷启动\快捷启动脚本\准备运行环境.cmd，或安装 Node.js 20+。" -f $node, $nodeVersion) -ForegroundColor Yellow
    $node = ""
  }
} else {
  Write-Host "缺失 Node.js。请运行 快捷启动\快捷启动脚本\准备运行环境.cmd，或安装 Node.js 20+。" -ForegroundColor Yellow
}

$chrome = Find-Chrome
if ($chrome) { Write-Host ("OK  Chrome：{0}" -f $chrome) -ForegroundColor Green } else { Write-Host "缺失 Chrome。请安装 Google Chrome 或在 .env 配置 CHROME_PATH。" -ForegroundColor Yellow }

if (-not (Test-Path -LiteralPath (Join-Path $recruitmentRoot ".env"))) {
  Write-Host "待配置 招聘 Agent .env：请复制 .env.example 为 .env 并填写自己的配置。" -ForegroundColor Yellow
}
if (-not (Test-Path -LiteralPath (Join-Path $messageRoot ".env"))) {
  Write-Host "待配置 消息平台 .env：请复制 .env.example 为 .env 并填写自己的飞书配置。" -ForegroundColor Yellow
}

if ($node -and (Test-Path -LiteralPath (Join-Path $recruitmentRoot "src\main\preflight.js"))) {
  Write-Host ""
  Write-Host "开始运行招聘 Agent preflight（只检查配置，不启动 Chrome、不采集）：" -ForegroundColor Cyan
  Push-Location $recruitmentRoot
  & $node ".\src\main\preflight.js"
  $code = $LASTEXITCODE
  Pop-Location
  exit $code
}

exit 1
