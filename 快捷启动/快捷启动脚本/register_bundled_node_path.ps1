param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = $PSScriptRoot
$packageRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDir "..\..")).Path
$nodeDir = Join-Path $packageRoot "快捷启动\随项目必须的安装包\node"
$nodeExe = Join-Path $nodeDir "node.exe"

if (-not (Test-Path -LiteralPath $nodeExe)) {
  $safeRoot = ([string]$packageRoot).Replace("'", "''")
  $command = "powershell -NoProfile -ExecutionPolicy Bypass -Command `"Set-Location -LiteralPath '$safeRoot'; & '.\快捷启动\快捷启动脚本\prepare_runtime_menu.ps1'`""
  throw "未找到随包 Node.js：$nodeExe。请先运行完整命令：$command"
}

$version = (& $nodeExe -p "process.versions.node").Trim()
if ([version]$version -lt [version]"22.4.0") {
  throw "随包 Node.js 版本过低：$version。请重新运行准备脚本更新。"
}

$currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @()
if ($currentUserPath) {
  $parts = $currentUserPath -split ";" | Where-Object { $_ -and $_.Trim() }
}
$exists = $parts | Where-Object { $_.TrimEnd("\") -ieq $nodeDir.TrimEnd("\") }

if ($exists) {
  Write-Host ("OK  用户 PATH 已包含随包 Node：{0}" -f $nodeDir) -ForegroundColor Green
} else {
  $newPath = (($parts + $nodeDir) -join ";")
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host ("OK  已把随包 Node 注册到当前用户 PATH：{0}" -f $nodeDir) -ForegroundColor Green
  Write-Host "请重新打开 CMD/PowerShell 后再测试 node 或 pnpm 命令。" -ForegroundColor Yellow
}

$env:PATH = "$nodeDir;$env:PATH"
Write-Host ("Node.js：{0}" -f (& $nodeExe --version)) -ForegroundColor Cyan
$pnpm = Join-Path $nodeDir "pnpm.cmd"
if (Test-Path -LiteralPath $pnpm) {
  Write-Host ("pnpm：{0}" -f (& $pnpm --version)) -ForegroundColor Cyan
}
