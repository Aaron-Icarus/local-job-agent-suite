$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\ensure_chrome_cdp.ps1 -Visible -Restart -StartUrl "https://www.liepin.com/?loginBackUrl=https%3A%2F%2Fc.liepin.com%2F"
node .\tools\open_liepin_page.js
node .\src\platforms\liepin\check_liepin_login_status.js
