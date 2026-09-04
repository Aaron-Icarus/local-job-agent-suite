param(
  [string]$HostName = $env:CDP_HOST,
  [int]$Port = $(if ($env:CDP_PORT) { [int]$env:CDP_PORT } else { 9222 }),
  [string]$ChromePath = $env:CHROME_PATH,
  [string]$ProfileDir = $env:CHROME_CDP_PROFILE_DIR,
  [string]$StartUrl = "https://www.zhipin.com/web/geek/jobs",
  [switch]$Visible,
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $HostName) { $HostName = "127.0.0.1" }
if (-not $ProfileDir) { $ProfileDir = Join-Path $root "chrome-cdp-profile" }

function Find-ChromeExecutable {
  $installRoots = @(
    [Environment]::GetEnvironmentVariable("ProgramFiles"),
    [Environment]::GetEnvironmentVariable("ProgramFiles(x86)"),
    [Environment]::GetEnvironmentVariable("LOCALAPPDATA")
  ) | Where-Object { $_ }
  foreach ($installRoot in $installRoots) {
    $candidate = Join-Path $installRoot "Google\Chrome\Application\chrome.exe"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return ""
}

if (-not $ChromePath) { $ChromePath = Find-ChromeExecutable }

function Test-CdpPort {
  param([string]$HostName, [int]$Port)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(1000, $false)) {
      $client.Close()
      return $false
    }
    $client.EndConnect($async)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

if ($Restart) {
  $escapedProfile = $ProfileDir.Replace("\", "\\")
  Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object {
    $_.CommandLine -like "*--remote-debugging-port=$Port*" -and
    ($_.CommandLine -like "*$ProfileDir*" -or $_.CommandLine -like "*$escapedProfile*")
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
  }
  Start-Sleep -Seconds 2
}

if (Test-CdpPort -HostName $HostName -Port $Port) {
  Write-Output "CDP already listening on $HostName`:$Port"
  exit 0
}

if (-not (Test-Path -LiteralPath $ChromePath)) {
  throw "未找到 Chrome。请安装 Google Chrome，或在 .env 中设置 CHROME_PATH 为 chrome.exe 的完整路径。"
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$arguments = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$ProfileDir",
  "--no-first-run",
  "--disable-first-run-ui",
  "--no-default-browser-check",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble"
)
if (-not $Visible) {
  $arguments += "--start-minimized"
}
$arguments += $StartUrl

$windowStyle = if ($Visible) { "Normal" } else { "Hidden" }
Start-Process -FilePath $ChromePath -ArgumentList $arguments -WindowStyle $windowStyle

$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if (Test-CdpPort -HostName $HostName -Port $Port) {
    Write-Output "Started Chrome CDP on $HostName`:$Port"
    Write-Output "Profile: $ProfileDir"
    exit 0
  }
}

throw "Chrome CDP did not start on $HostName`:$Port within 25 seconds"
