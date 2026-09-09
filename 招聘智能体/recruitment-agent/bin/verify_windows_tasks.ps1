param(
  [string]$TaskName = "Recruitment Agent Schedule",
  [string]$WatchdogTaskName = "Recruitment Agent Report Watchdog",
  [string]$ScheduleConfigPath = "config\schedule_policy.json",
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$policyPath = if ([System.IO.Path]::IsPathRooted($ScheduleConfigPath)) { $ScheduleConfigPath } else { Join-Path $root $ScheduleConfigPath }
$issues = New-Object System.Collections.Generic.List[string]

function Time-Part([string]$Boundary) {
  if ($Boundary -match 'T(\d{2}:\d{2})') { return $Matches[1] }
  return ""
}

try { $policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json } catch { $issues.Add("Cannot read schedule policy: $($_.Exception.Message)") | Out-Null }
$expectedTimes = @()
if ($policy) {
  foreach ($window in $policy.collection_windows) { $expectedTimes += @($window.trigger_times | ForEach-Object { [string]$_ }) }
  $expectedTimes += @($policy.report_window.trigger_times | ForEach-Object { [string]$_ })
}

$actualTimes = @()
try {
  $mainTask = Get-ScheduledTask -TaskName $TaskName
  [xml]$mainXml = Export-ScheduledTask -TaskName $TaskName
  $actualTimes = @($mainXml.Task.Triggers.CalendarTrigger | ForEach-Object { Time-Part ([string]$_.StartBoundary) } | Sort-Object)
  $expectedSorted = @($expectedTimes | Sort-Object)
  if (($actualTimes -join ',') -ne ($expectedSorted -join ',')) { $issues.Add("Main task trigger times differ. Expected: $($expectedSorted -join ','); actual: $($actualTimes -join ',')") | Out-Null }
  if (@($mainXml.Task.Triggers.CalendarTrigger | Where-Object { $_.Repetition }).Count) { $issues.Add("Main task still contains Repetition; every time must be an independent trigger.") | Out-Null }
  if ([bool]$mainTask.Settings.WakeToRun) { $issues.Add("Main task WakeToRun must be false.") | Out-Null }
  if ([bool]$mainTask.Settings.StartWhenAvailable) { $issues.Add("Main task StartWhenAvailable must be false.") | Out-Null }
  if ([string]$mainTask.Settings.MultipleInstances -ne 'IgnoreNew') { $issues.Add("Main task MultipleInstances must be IgnoreNew.") | Out-Null }
  if ([string]$mainTask.Actions.Arguments -notmatch '(?:^|\s)-Scheduled(?:\s|$)') { $issues.Add("Main task action must pass -Scheduled to the workflow wrapper.") | Out-Null }
} catch { $issues.Add("Cannot read main scheduled task ${TaskName}: $($_.Exception.Message)") | Out-Null }

$watchdogTime = ""
if ($policy -and $policy.watchdog.enabled) {
  try {
    $watchdogTask = Get-ScheduledTask -TaskName $WatchdogTaskName
    [xml]$watchdogXml = Export-ScheduledTask -TaskName $WatchdogTaskName
    $watchdogTime = Time-Part ([string]$watchdogXml.Task.Triggers.CalendarTrigger.StartBoundary)
    if ($watchdogTime -ne [string]$policy.watchdog.time) { $issues.Add("Watchdog time differs. Expected: $($policy.watchdog.time); actual: $watchdogTime") | Out-Null }
    if ([bool]$watchdogTask.Settings.WakeToRun) { $issues.Add("Watchdog WakeToRun must be false.") | Out-Null }
    if ([bool]$watchdogTask.Settings.StartWhenAvailable) { $issues.Add("Watchdog StartWhenAvailable must be false.") | Out-Null }
    if ([string]$watchdogTask.Settings.MultipleInstances -ne 'IgnoreNew') { $issues.Add("Watchdog MultipleInstances must be IgnoreNew.") | Out-Null }
    if ([string]$watchdogTask.Actions.Arguments -notmatch 'run_report_watchdog\.ps1') { $issues.Add("Watchdog action does not point to run_report_watchdog.ps1.") | Out-Null }
  } catch { $issues.Add("Cannot read watchdog task ${WatchdogTaskName}: $($_.Exception.Message)") | Out-Null }
}

$result = [ordered]@{ ok = ($issues.Count -eq 0); taskName = $TaskName; triggerTimes = $actualTimes; watchdogTaskName = $WatchdogTaskName; watchdogTime = $watchdogTime; issues = @($issues) }
if ($Json) { $result | ConvertTo-Json -Depth 5 -Compress } else { $result | ConvertTo-Json -Depth 5 }
if ($issues.Count) { exit 1 }
