param(
  [string]$TaskName = "BOSS Job Agent Daily",
  [string]$StartTime = "09:00",
  [int]$IntervalMinutes = 30,
  [int]$DurationHours = 12
)

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script = Join-Path $root "run_daily_job_agent.ps1"
$startBoundary = "$(Get-Date -Format yyyy-MM-dd)T$StartTime`:00"
$escapedScript = [System.Security.SecurityElement]::Escape($script)
$escapedTaskName = [System.Security.SecurityElement]::Escape($TaskName)
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Collect, evaluate, draft, and push multi-platform job-search reports. The script decides whether the current time window is due.</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$startBoundary</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
      <Repetition>
        <Interval>PT$($IntervalMinutes)M</Interval>
        <Duration>PT$($DurationHours)H</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -File "$escapedScript" -Scheduled</Arguments>
      <WorkingDirectory>$([System.Security.SecurityElement]::Escape($root))</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

Register-ScheduledTask -TaskName $escapedTaskName -Xml $xml -Force
