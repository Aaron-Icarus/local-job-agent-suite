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
}
if ($Scheduled) {
  $scheduledSendMode = [Environment]::GetEnvironmentVariable("SCHEDULE_SEND_MODE", "Process")
  if (-not $scheduledSendMode) { $scheduledSendMode = "draft" }
  [Environment]::SetEnvironmentVariable("PREFLIGHT_SEND_MODE", $scheduledSendMode, "Process")
}

node .\src\main\preflight.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Scheduled) {
  $autoStartCdp = [Environment]::GetEnvironmentVariable("AUTO_START_CDP", "Process")
  if (-not $autoStartCdp -or $autoStartCdp.ToLower() -ne "false") {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\ensure_chrome_cdp.ps1
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  node .\src\main\scheduled_entry.js
} elseif ($SendLatestDraft) {
  node .\src\push\send_existing_draft.js
} else {
  node .\src\main\daily_workflow.js
}

exit $LASTEXITCODE
