param(
  [switch]$KeepTemp
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeScript = Join-Path $scriptDir "scripts\run_v13_smoke.js"
$forward = @()
if ($KeepTemp) { $forward += "--keep-temp" }

node $nodeScript @forward
exit $LASTEXITCODE
