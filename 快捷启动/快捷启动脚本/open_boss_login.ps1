param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = $PSScriptRoot
$packageRoot = Resolve-Path -LiteralPath (Join-Path $scriptDir "..\..")
$projectRoot = Join-Path $packageRoot "AI消息群聊转发agent\recruitment-agent"
$loginScript = Join-Path $projectRoot "tools\open_chrome_cdp_for_login.ps1"

if (-not (Test-Path -LiteralPath $loginScript)) {
  throw "未找到 BOSS 登录脚本：$loginScript"
}

Set-Location -LiteralPath $projectRoot
powershell -NoProfile -ExecutionPolicy Bypass -File $loginScript
exit $LASTEXITCODE
