param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = $PSScriptRoot
$prepareScript = Join-Path $scriptDir "prepare_runtime.ps1"
$checkScript = Join-Path $scriptDir "check_runtime.ps1"
$registerScript = Join-Path $scriptDir "register_bundled_node_path.ps1"

Write-Host "本地招聘 Agent 套件：运行环境准备" -ForegroundColor Cyan
Write-Host "下面会先展示依赖状态，然后由你选择安装/使用方式。" -ForegroundColor Cyan
Write-Host ""
& $checkScript

Write-Host ""
Write-Host "请选择：" -ForegroundColor Cyan
Write-Host "1. 推荐：准备随包 Node.js + pnpm + 飞书 SDK 依赖，不修改系统 PATH"
Write-Host "2. 使用本机已有 Node.js/pnpm，只把飞书 SDK 依赖安装到快捷启动依赖区"
Write-Host "3. 准备随包 Node.js + pnpm + 飞书 SDK，并注册随包 Node 到当前用户 PATH"
Write-Host "4. 只查看状态，不安装"
Write-Host "0. 退出"

$choice = Read-Host "请输入数字"
switch ($choice) {
  "1" {
    & $prepareScript
    exit $LASTEXITCODE
  }
  "2" {
    & $prepareScript -UseSystemNode
    exit $LASTEXITCODE
  }
  "3" {
    & $prepareScript
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $registerScript
    exit $LASTEXITCODE
  }
  "4" {
    exit 0
  }
  "0" {
    Write-Host "已退出，没有修改任何内容。" -ForegroundColor Yellow
    exit 0
  }
  default {
    Write-Host "未识别选项，已退出，没有修改任何内容。" -ForegroundColor Yellow
    exit 2
  }
}
