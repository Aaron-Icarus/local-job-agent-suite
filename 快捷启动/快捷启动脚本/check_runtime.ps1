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

Write-Host "运行环境依赖清单：" -ForegroundColor Cyan
Write-Host "1. Node.js 20+：必需。可使用随包便携版，也可使用本机已安装版本。"
Write-Host "2. pnpm：消息平台飞书 SDK 依赖安装需要。随包模式会通过 corepack 准备。"
Write-Host "3. @larksuiteoapi/node-sdk：飞书长连接 SDK，安装在快捷启动依赖区。"
Write-Host "4. Chrome：招聘网站登录和采集需要，建议系统安装或在 .env 配置 CHROME_PATH。"
Write-Host "5. Codex CLI / OpenAI API：仅启用 AI 模式时可选；分享包默认关闭 AI。"
Write-Host ""

$bundledNodeVersion = Get-ToolVersion $bundledNode @("-p", "process.versions.node")
Print-Status "随包 Node.js" ([bool]$bundledNodeVersion) ($(if ($bundledNodeVersion) { "$bundledNode ($bundledNodeVersion)" } else { "未准备；可运行 准备运行环境.cmd 下载到快捷启动依赖区" }))

$bundledPnpmVersion = Get-PnpmProjectVersion $bundledPnpm $messageVendorRoot
if (-not $bundledPnpmVersion) { $bundledPnpmVersion = Get-ToolVersion $bundledPnpm @("--version") }
Print-Status "随包 pnpm（消息平台项目上下文）" ([bool]$bundledPnpmVersion) ($(if ($bundledPnpmVersion) { "$bundledPnpm ($bundledPnpmVersion)" } else { "未准备；随包 Node 准备后会自动生成" }))

$systemNode = Get-Command node -ErrorAction SilentlyContinue
$systemNodeVersion = ""
if ($systemNode) { $systemNodeVersion = Get-ToolVersion $systemNode.Source @("-p", "process.versions.node") }
Print-Status "本机 PATH Node.js" ([bool]$systemNodeVersion) ($(if ($systemNodeVersion) { "$($systemNode.Source) ($systemNodeVersion)" } else { "未在 PATH 中找到；不影响随包快捷脚本" }))

$systemPnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$systemPnpmVersion = ""
if ($systemPnpm) { $systemPnpmVersion = Get-ToolVersion $systemPnpm.Source @("--version") }
Print-Status "本机 PATH pnpm" ([bool]$systemPnpmVersion) ($(if ($systemPnpmVersion) { "$($systemPnpm.Source) ($systemPnpmVersion)" } else { "未在 PATH 中找到；随包模式可自动准备" }))

$hasSdk = (Test-Path -LiteralPath $messageVendorRuntime) -or (Test-Path -LiteralPath $messageVendorVirtual)
Print-Status "飞书 SDK 运行依赖" $hasSdk ($(if ($hasSdk) { Join-Path $packagesDir "message-platform-vendor" } else { "未安装；运行 准备运行环境.cmd 后生成" }))

$chrome = Find-Chrome
Print-Status "Chrome" ([bool]$chrome) ($(if ($chrome) { $chrome } else { "未发现常见安装路径；可安装 Chrome 或在招聘 Agent .env 配置 CHROME_PATH" }))

Write-Host ""
Write-Host "说明：常用快捷脚本会临时使用随包 Node，不要求注册 PATH。只有你想在任意终端直接输入 node/pnpm 时，才需要注册用户 PATH。" -ForegroundColor Cyan
