param()

$ErrorActionPreference = "Continue"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = $PSScriptRoot
$packageRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDir "..\..")).Path
$packagesDir = Join-Path $packageRoot "快捷启动\随项目必须的安装包"
$bundledNode = Join-Path $packagesDir "node\node.exe"
$bundledPnpm = Join-Path $packagesDir "node\pnpm.cmd"
$messageVendorRoot = Join-Path $packagesDir "message-platform-vendor"
$messageVendorRuntime = Join-Path $packagesDir "message-platform-vendor\node_modules\@larksuiteoapi\node-sdk"
$messageVendorVirtual = Join-Path $packagesDir "message-platform-vendor\node_modules\.pnpm"

function Get-ToolVersion {
  param([string]$Command, [string[]]$ToolArgs)
  if (-not $Command -or -not (Test-Path -LiteralPath $Command)) { return "" }
  try {
    return ((& $Command @ToolArgs 2>$null) | Select-Object -First 1).Trim()
  } catch {
    return ""
  }
}

function Test-Node224PlusVersion {
  param([string]$Version)
  if (-not $Version) { return $false }
  try {
    return ([version]$Version -ge [version]"22.4.0")
  } catch {
    return $false
  }
}

function Get-DirectorySizeMB {
  param([string]$Dir)
  if (-not (Test-Path -LiteralPath $Dir)) { return 0 }
  $sum = (Get-ChildItem -LiteralPath $Dir -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  if (-not $sum) { return 0 }
  return [math]::Round($sum / 1MB, 2)
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

function Print-Status {
  param([string]$Label, [bool]$Ok, [string]$Detail)
  if ($Ok) {
    Write-Host ("OK  {0}：{1}" -f $Label, $Detail) -ForegroundColor Green
  } else {
    Write-Host ("缺失/待处理 {0}：{1}" -f $Label, $Detail) -ForegroundColor Yellow
  }
}

function Get-PnpmProjectVersion {
  param([string]$PnpmCommand, [string]$ProjectDir)
  if (-not (Test-Path -LiteralPath $PnpmCommand) -or -not (Test-Path -LiteralPath $ProjectDir)) { return "" }
  try {
    Push-Location $ProjectDir
    $version = ((& $PnpmCommand --version 2>$null) | Select-Object -First 1).Trim()
    Pop-Location
    return $version
  } catch {
    try { Pop-Location } catch {}
    return ""
  }
}

Write-Host "运行环境依赖清单（先检测本机，再检测可选随包依赖）：" -ForegroundColor Cyan
Write-Host "1. Node.js 22.4+：运行项目必需，并提供稳定的全局 WebSocket。优先使用本机已安装版本；没有或版本过低时再用随包便携版。"
Write-Host "2. pnpm：安装/修复消息平台飞书 SDK 依赖时需要。本机可用则优先使用本机 pnpm。"
Write-Host "3. @larksuiteoapi/node-sdk：飞书长连接 SDK，默认安装在快捷启动依赖区。"
Write-Host "4. Chrome：招聘网站登录和采集需要，建议系统安装或在 .env 配置 CHROME_PATH。"
Write-Host "5. Codex CLI / OpenAI API：仅启用 AI 模式时可选；分享包默认关闭 AI。"
Write-Host ""

$systemNode = Get-Command node -ErrorAction SilentlyContinue
$systemNodeVersion = ""
if ($systemNode) { $systemNodeVersion = Get-ToolVersion $systemNode.Source @("-p", "process.versions.node") }
$systemNodeOk = Test-Node224PlusVersion $systemNodeVersion
Print-Status "本机 PATH Node.js 22.4+" $systemNodeOk ($(if ($systemNodeVersion) { "$($systemNode.Source) ($systemNodeVersion)" } else { "未在 PATH 中找到" }))

$systemPnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$systemPnpmVersion = ""
if ($systemPnpm) { $systemPnpmVersion = Get-ToolVersion $systemPnpm.Source @("--version") }
Print-Status "本机 PATH pnpm" ([bool]$systemPnpmVersion) ($(if ($systemPnpmVersion) { "$($systemPnpm.Source) ($systemPnpmVersion)" } else { "未在 PATH 中找到；可用随包模式自动准备" }))

$bundledNodeVersion = Get-ToolVersion $bundledNode @("-p", "process.versions.node")
$bundledNodeOk = Test-Node224PlusVersion $bundledNodeVersion
Print-Status "可选随包 Node.js 22.4+" $bundledNodeOk ($(if ($bundledNodeVersion) { "$bundledNode ($bundledNodeVersion)" } else { "未准备；仅当本机没有 Node.js 22.4+ 时需要下载" }))

$bundledPnpmVersion = Get-PnpmProjectVersion $bundledPnpm $messageVendorRoot
if (-not $bundledPnpmVersion) { $bundledPnpmVersion = Get-ToolVersion $bundledPnpm @("--version") }
Print-Status "可选随包 pnpm（消息平台项目上下文）" ([bool]$bundledPnpmVersion) ($(if ($bundledPnpmVersion) { "$bundledPnpm ($bundledPnpmVersion)" } else { "未准备；仅随包模式需要" }))

$hasSdk = (Test-Path -LiteralPath $messageVendorRuntime) -or (Test-Path -LiteralPath $messageVendorVirtual)
Print-Status "飞书 SDK 运行依赖" $hasSdk ($(if ($hasSdk) { Join-Path $packagesDir "message-platform-vendor" } else { "未安装；运行 准备运行环境.cmd 后生成" }))

$chrome = Find-Chrome
Print-Status "Chrome" ([bool]$chrome) ($(if ($chrome) { $chrome } else { "未发现常见安装路径；可安装 Chrome 或在招聘 Agent .env 配置 CHROME_PATH" }))

Write-Host ""
$packagesSize = Get-DirectorySizeMB $packagesDir
Write-Host ("可选随包依赖目录当前体积：{0} MB" -f $packagesSize) -ForegroundColor Cyan
if ($systemNodeOk -and $systemPnpmVersion) {
  Write-Host "建议：本机 Node.js/pnpm 已可用。通常不需要下载随包 Node；如已生成 node/corepack/pnpm-store 且不做离线拷贝，可删除这些大目录，只保留 README.md。" -ForegroundColor Green
} elseif ($bundledNodeOk) {
  Write-Host "建议：本机 Node.js/pnpm 不完整，当前可使用随包 Node/pnpm 兜底。常用快捷脚本不要求注册 PATH。" -ForegroundColor Yellow
} else {
  Write-Host "建议：未发现可用 Node.js 22.4+。请选择准备运行环境菜单中的随包准备，或自行安装 Node.js 22.4+ 后重试。" -ForegroundColor Yellow
}
Write-Host "说明：PATH 注册只是可选项。只有你想在任意终端直接输入 node/pnpm 时，才需要注册用户 PATH。" -ForegroundColor Cyan
