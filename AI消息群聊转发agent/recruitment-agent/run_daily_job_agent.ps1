param(
  [switch]$Send,
  [switch]$SendLatestDraft,
  [switch]$Scheduled,
  [switch]$DraftOnly,
  [string]$EnvPath = ".env"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $root "bin\run_daily_job_agent.ps1"

$forward = @()
if ($Send) { $forward += "-Send" }
if ($SendLatestDraft) { $forward += "-SendLatestDraft" }
if ($Scheduled) { $forward += "-Scheduled" }
if ($DraftOnly) { $forward += "-DraftOnly" }
if ($EnvPath) { $forward += @("-EnvPath", $EnvPath) }

powershell -NoProfile -ExecutionPolicy Bypass -File $script @forward
exit $LASTEXITCODE
