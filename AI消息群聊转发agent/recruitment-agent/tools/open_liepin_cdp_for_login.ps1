$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Import-ProjectEnv {
  param([string]$EnvPath)
  if (-not (Test-Path -LiteralPath $EnvPath)) { return }
  foreach ($line in Get-Content -LiteralPath $EnvPath) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) { continue }
    $index = $trimmed.IndexOf("=")
    $key = $trimmed.Substring(0, $index).Trim()
    $value = $trimmed.Substring($index + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($key, $value, "Process")
  }
}

Import-ProjectEnv (Join-Path $root ".env")
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\ensure_chrome_cdp.ps1 -Visible -Restart -StartUrl "https://www.liepin.com/?loginBackUrl=https%3A%2F%2Fc.liepin.com%2F"
node .\tools\open_liepin_page.js
node .\src\platforms\liepin\check_liepin_login_status.js


