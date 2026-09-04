$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\ensure_chrome_cdp.ps1 -Visible -Restart
node .\src\platforms\boss\check_boss_login_status.js --new
