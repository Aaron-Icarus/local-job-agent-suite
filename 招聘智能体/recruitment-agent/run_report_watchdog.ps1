param([string]$EnvPath = ".env")

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "bin\run_report_watchdog.ps1") -EnvPath $EnvPath
exit $LASTEXITCODE
