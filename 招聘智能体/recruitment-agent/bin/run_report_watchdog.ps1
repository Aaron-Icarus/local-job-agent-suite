param([string]$EnvPath = ".env")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
if (Test-Path -LiteralPath $EnvPath) {
  foreach ($rawLine in Get-Content -LiteralPath $EnvPath) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
    $index = $line.IndexOf("=")
    $name = $line.Substring(0, $index).Trim()
    $value = $line.Substring($index + 1).Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { "" }
if (-not $node) {
  $packageRoot = Resolve-Path -LiteralPath (Join-Path $root "..\..")
  $candidate = Join-Path $packageRoot "快捷启动\随项目必须的安装包\node\node.exe"
  if (Test-Path -LiteralPath $candidate) { $node = $candidate }
}
if (-not $node) { throw "Watchdog cannot find Node.js 22.4.0 or later." }
$nodeVersion = (& $node -p "process.versions.node").Trim()
if ([version]$nodeVersion -lt [version]"22.4.0") { throw "Watchdog found Node.js $nodeVersion; version 22.4.0 or later is required." }
& $node .\src\main\report_watchdog.js
exit $LASTEXITCODE
