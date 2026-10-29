$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
if ($env:OS -ne 'Windows_NT') { throw 'Scheduled Task tests require Windows.' }
Import-Module (Join-Path $PSScriptRoot '../NextVision.Startup.psm1') -Force
function Assert($Condition,[string]$Message='Assertion failed') { if (-not $Condition) { throw $Message } }
$root=Join-Path ([IO.Path]::GetTempPath()) ('nv-startup-'+[guid]::NewGuid().ToString('N'))
$task='NextVisionTest-'+[guid]::NewGuid().ToString('N')
$source=Join-Path $root 'source with spaces';$agent=Join-Path $root 'user data'
[IO.Directory]::CreateDirectory($source)|Out-Null
[IO.Directory]::CreateDirectory($agent)|Out-Null
try {
  foreach ($file in @('NextVision.Core.psm1','NextVision.Runtime.psm1','NextVision.Startup.psm1','NextVision.Network.psm1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../'+$file)) -Destination (Join-Path $source $file)
  }
  # Register the real task definition, but do not run an agent against production
  # or rely on an interactive login session being available on a CI runner.
  [IO.File]::WriteAllText((Join-Path $source 'nextvision-connect.ps1'),'param($Mode,[switch]$Background)')
  $video=Join-Path $agent 'preserved.mp4';[IO.File]::WriteAllText($video,'existing recording')
  $target=Install-NvStartup $source $agent $task
  Assert ([IO.File]::Exists((Join-Path $target 'nextvision-connect.ps1')))
  Assert ([IO.File]::Exists((Join-Path $target 'NextVision.Runtime.psm1')))
  $registered=Get-ScheduledTask -TaskName $task
  [xml]$definition=Export-ScheduledTask -TaskName $task
  Assert ($definition.Task.Principals.Principal.LogonType -eq 'InteractiveToken')
  Assert ($definition.Task.Principals.Principal.RunLevel -eq 'LeastPrivilege')
  Assert ($definition.Task.Triggers.LogonTrigger.UserId -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  Assert ($registered.Actions[0].Arguments.Contains('run -Background'))
  Assert ($registered.Actions[0].WorkingDirectory -eq $target)
  Assert ($definition.Task.Settings.MultipleInstancesPolicy -eq 'IgnoreNew')
  Assert (-not (Test-NvAgentRunning $agent))
  $handle=[IO.File]::Open((Join-Path $agent 'agent.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try { Assert (Test-NvAgentRunning $agent) } finally { $handle.Dispose() }
  [IO.File]::WriteAllText((Join-Path $source 'nextvision-pilot.ps1'),'param($Mode,[switch]$Background)')
  $target=Install-NvStartup $source $agent $task 'nextvision-pilot.ps1'
  $registered=Get-ScheduledTask -TaskName $task
  Assert ($registered.Actions[0].Arguments.Contains('nextvision-pilot.ps1'))
  Assert (-not [IO.File]::Exists((Join-Path $target 'NextVision.Network.psm1')))
  Stop-NvStartup $agent $task
  [xml]$definition=Export-ScheduledTask -TaskName $task
  Assert ($definition.Task.Settings.Enabled -eq 'false')
  Assert ([IO.File]::Exists((Join-Path $agent 'stop.request')))
  Uninstall-NvStartup $agent $task
  Assert ($null -eq (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue))
  Assert ([IO.File]::ReadAllText($video) -eq 'existing recording')
  Write-Host 'PASS isolated Windows task registration, stable copy, current-user principal, instance lock, stop intent and uninstall preserving recordings'
} finally {
  if ($null -ne (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)) {
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
  }
  Remove-Item -LiteralPath $root -Recurse -Force
}
