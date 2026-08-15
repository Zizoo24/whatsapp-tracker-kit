param(
  [string]$Root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [int]$WatchMinutes = 3,
  [int]$KeepaliveMinutes = 5,
  [switch]$Execute
)

# Installs the two scheduled tasks. DRY RUN by default; pass -Execute to register.
#
# Registration goes through schtasks.exe /create /xml rather than Register-ScheduledTask:
# the latter requires elevation once an explicit -Principal is supplied, and this is meant
# to be operated from a normal non-elevated shell.
#
# THE XML IS AUTHORED IN FULL rather than cloned from an existing task. Cloning is what
# once silently propagated DisallowStartIfOnBatteries into a task and cost 1,015 missed
# launches. Every setting below is deliberate.
#
# THE BATTERY PAIR MUST STAY false. It is the single most important thing in this file:
# a laptop tracker that refuses to run on battery is a tracker that does not run.

$ErrorActionPreference = 'Stop'

$vbs = Join-Path $PSScriptRoot 'silent-run.vbs'
$watchBat = Join-Path $PSScriptRoot 'run-watch.bat'
$keepaliveBat = Join-Path $PSScriptRoot 'run-keepalive.bat'

foreach ($f in @($vbs, $watchBat, $keepaliveBat)) {
  if (-not (Test-Path $f)) { throw "missing required file: $f" }
}
if (-not (Test-Path (Join-Path $Root 'scripts\tracker-watch.cjs'))) {
  throw "Root does not look like the kit: $Root"
}

$user = "$env:USERDOMAIN\$env:USERNAME"

function New-TaskXml {
  param($Description, $Interval, $Bat, $TimeLimit, $IncludeLogon)

  # LogonTrigger is not decoration: repetition alone never covers a boot. The bridge died,
  # the machine rebooted, and nothing brought it back -> 66h of zero ingestion.
  $logon = if ($IncludeLogon) { "    <LogonTrigger><Enabled>true</Enabled><UserId>$user</UserId></LogonTrigger>`n" } else { '' }

  # LogonType MUST be InteractiveToken: the model CLI needs the user's own auth, and the
  # watcher also spawns the bridge. Session 0 / S4U is not a safe swap without testing both.
  # An empty <Duration> means "repeat forever" — PT0S and TimeSpan::MaxValue are both
  # rejected by the schema on Windows PowerShell 5.1.
  @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>$Description</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT$($Interval)M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:01:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
$logon  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT$($TimeLimit)M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>//B "$vbs" "$Bat"</Arguments>
      <WorkingDirectory>$Root</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

$tasks = @(
  @{ Name = 'tracker-watch'; Xml = (New-TaskXml -Description 'Extraction lane: prep -> model -> apply. Only spends when a chat has new messages.' -Interval $WatchMinutes -Bat $watchBat -TimeLimit 20 -IncludeLogon $false) },
  @{ Name = 'tracker-keepalive'; Xml = (New-TaskXml -Description 'Transport only: keeps the WhatsApp bridge process alive. No extraction, no store writes.' -Interval $KeepaliveMinutes -Bat $keepaliveBat -TimeLimit 5 -IncludeLogon $true) }
)

if (-not $Execute) {
  Write-Output "DRY RUN. Would register:"
  foreach ($t in $tasks) {
    Write-Output "  $($t.Name)"
  }
  Write-Output "  root      : $Root"
  Write-Output "  principal : $user / InteractiveToken"
  Write-Output "  battery   : DisallowStartIfOnBatteries=false, StopIfGoingOnBatteries=false"
  Write-Output "Re-run with -Execute to install."
  exit 0
}

foreach ($t in $tasks) {
  $tmp = Join-Path $env:TEMP "$($t.Name).xml"
  # schtasks /create /xml requires UTF-16 to match the declared encoding.
  [System.IO.File]::WriteAllText($tmp, $t.Xml, [System.Text.Encoding]::Unicode)
  try {
    $out = & schtasks /create /tn $t.Name /xml $tmp /f 2>&1
    if ($LASTEXITCODE -ne 0) { throw "schtasks failed for $($t.Name): $out" }
    Write-Output $out
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }

  # Verify, then REFUSE to leave a battery-restricted task installed. A silent battery
  # restriction is indistinguishable from a working tracker until you check the data.
  $x = [xml](Export-ScheduledTask -TaskName $t.Name)
  if ($x.Task.Settings.DisallowStartIfOnBatteries -ne 'false' -or $x.Task.Settings.StopIfGoingOnBatteries -ne 'false') {
    throw "battery restriction present on $($t.Name) — refusing to leave it installed this way."
  }
  $state = (Get-ScheduledTask -TaskName $t.Name).State
  Write-Output "installed : $($t.Name) = $state (runs on battery)"
}

Write-Output ''
Write-Output 'Verify with:'
Write-Output "  Get-ScheduledTask -TaskName 'tracker-*' | % { `$i=Get-ScheduledTaskInfo -TaskName `$_.TaskName; `"`$(`$_.TaskName) `$(`$_.State) result=`$(`$i.LastTaskResult)`" }"
Write-Output 'LastTaskResult 267009 = SCHED_S_TASK_RUNNING (benign).'
