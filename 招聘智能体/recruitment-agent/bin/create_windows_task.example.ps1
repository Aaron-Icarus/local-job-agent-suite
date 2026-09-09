param(
  [string]$TaskName = "Recruitment Agent Schedule",
  [string]$WatchdogTaskName = "Recruitment Agent Report Watchdog",
  [string]$ScheduleConfigPath = "config\schedule_policy.json",
  [switch]$GenerateOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$mainScript = Join-Path $root "run_daily_job_agent.ps1"
$watchdogScript = Join-Path $root "run_report_watchdog.ps1"
$legacyTaskNames = @("BOSS Job Agent Daily")
$policyPath = if ([System.IO.Path]::IsPathRooted($ScheduleConfigPath)) { $ScheduleConfigPath } else { Join-Path $root $ScheduleConfigPath }
if (-not (Test-Path -LiteralPath $policyPath)) { throw "Schedule policy not found: $policyPath" }
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json

if ($policy.windows_task.wake_computer -ne $false) { throw "Schedule policy requires wake_computer=false." }
if ($policy.windows_task.start_when_available -ne $false) { throw "Schedule policy requires start_when_available=false." }

function New-DailyTriggerXml {
  param([string]$Time, [string]$TriggerId)
  if ($Time -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw "Invalid trigger time: $Time" }
  $boundary = "$(Get-Date -Format yyyy-MM-dd)T$Time`:00"
  return @"
    <CalendarTrigger id="$TriggerId">
      <StartBoundary>$boundary</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
"@
}

$triggerXml = New-Object System.Collections.Generic.List[string]
$index = 0
foreach ($window in $policy.collection_windows) {
  foreach ($time in $window.trigger_times) {
    $index++
    $triggerXml.Add((New-DailyTriggerXml -Time ([string]$time) -TriggerId ("collection-{0}-{1}" -f $window.id, $index))) | Out-Null
  }
}
foreach ($time in $policy.report_window.trigger_times) {
  $index++
  $triggerXml.Add((New-DailyTriggerXml -Time ([string]$time) -TriggerId ("report-{0}" -f $index))) | Out-Null
}
if (-not $triggerXml.Count) { throw "Schedule policy has no main-task trigger time." }

function New-TaskXml {
  param([string]$Description, [string[]]$Triggers, [string]$ScriptPath, [string]$ScriptArguments = "")
  $escapedScript = [System.Security.SecurityElement]::Escape($ScriptPath)
  $escapedRoot = [System.Security.SecurityElement]::Escape($root)
  $escapedArguments = [System.Security.SecurityElement]::Escape($ScriptArguments)
  $actionArguments = "-NoProfile -ExecutionPolicy Bypass -File &quot;$escapedScript&quot;"
  if ($escapedArguments) { $actionArguments += " $escapedArguments" }
  $joinedTriggers = $Triggers -join "`r`n"
  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>$Description</Description></RegistrationInfo>
  <Triggers>
$joinedTriggers
  </Triggers>
  <Principals>
    <Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <WakeToRun>false</WakeToRun>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>$actionArguments</Arguments>
      <WorkingDirectory>$escapedRoot</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

$mainXml = New-TaskXml -Description "Recruitment agent independent triggers; no wake and no catch-up." -Triggers $triggerXml -ScriptPath $mainScript -ScriptArguments "-Scheduled"
if ($GenerateOnly) {
  [ordered]@{
    ok = $true
    triggerCount = $triggerXml.Count
    triggerTimes = @($policy.collection_windows.trigger_times) + @($policy.report_window.trigger_times)
    independentTriggers = ($mainXml -notmatch '<Repetition>')
    wakeComputer = $false
    startWhenAvailable = $false
    scheduledArgument = ($mainXml -match '\-Scheduled')
    watchdogEnabled = [bool]$policy.watchdog.enabled
    watchdogTime = [string]$policy.watchdog.time
    legacyTaskNames = $legacyTaskNames
  } | ConvertTo-Json -Depth 5 -Compress
  exit 0
}
Register-ScheduledTask -TaskName $TaskName -Xml $mainXml -Force | Out-Null

if ($policy.watchdog.enabled) {
  $watchdogTrigger = New-DailyTriggerXml -Time ([string]$policy.watchdog.time) -TriggerId "report-watchdog"
  $watchdogXml = New-TaskXml -Description "Independent daily-report and delivery receipt check." -Triggers @($watchdogTrigger) -ScriptPath $watchdogScript
  Register-ScheduledTask -TaskName $WatchdogTaskName -Xml $watchdogXml -Force | Out-Null
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "bin\verify_windows_tasks.ps1") -TaskName $TaskName -WatchdogTaskName $WatchdogTaskName -ScheduleConfigPath $policyPath
if ($LASTEXITCODE -ne 0) { throw "Scheduled-task verification failed." }

# Only remove the obsolete one-trigger task after the replacement tasks have
# registered and passed verification. This avoids leaving an invalid action path
# after the project folder is renamed.
$removedLegacyTasks = New-Object System.Collections.Generic.List[string]
foreach ($legacyTaskName in $legacyTaskNames) {
  if ($legacyTaskName -in @($TaskName, $WatchdogTaskName)) { continue }
  $legacyTask = Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
  if ($legacyTask) {
    Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false
    $removedLegacyTasks.Add($legacyTaskName) | Out-Null
  }
}

Write-Host "Scheduled tasks registered: independent triggers, no catch-up, no wake." -ForegroundColor Green
if ($removedLegacyTasks.Count -gt 0) {
  Write-Host ("Removed obsolete scheduled task(s): " + ($removedLegacyTasks -join ", ")) -ForegroundColor Yellow
}
