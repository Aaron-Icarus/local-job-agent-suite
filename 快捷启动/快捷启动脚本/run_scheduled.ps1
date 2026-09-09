param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = $PSScriptRoot
$packageRoot = Resolve-Path -LiteralPath (Join-Path $scriptDir "..\..")
$projectRoot = Join-Path $packageRoot "AI消息群聊转发agent\recruitment-agent"
$entry = Join-Path $projectRoot "run_daily_job_agent.ps1"

if (-not (Test-Path -LiteralPath $entry)) {
  throw "未找到招聘 Agent 入口：$entry"
}

Set-Location -LiteralPath $projectRoot
powershell -NoProfile -ExecutionPolicy Bypass -File $entry -Scheduled
exit $LASTEXITCODE
