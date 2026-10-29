$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot '../NextVision.Network.psm1') -Force
function Assert($Condition,[string]$Message='Assertion failed') { if (-not $Condition) { throw $Message } }
function Throws([scriptblock]$Body) { $caught=$false;try { & $Body|Out-Null } catch {$caught=$true};Assert $caught }
$script:passed=0
function Check([string]$Name,[scriptblock]$Body) { & $Body;$script:passed++;Write-Host "PASS $Name" }
$adapter=[guid]::NewGuid().ToString();$now=[datetime]::UtcNow
function Policy { return @{enabled=$true;adapter_id=$adapter;primary='Main 2.4';backups=@('Backup 5G','Other AP');tested=@('Main 2.4','Backup 5G','Other AP');endpoints=@(@{host='192.168.1.13';port=554})} }
$script:observed=@{State=4;Profile=''};$script:reachable=$false;$script:connections=[Collections.Generic.List[string]]::new()
$observe={param($id) $script:observed};$connect={param($id,$profile) $script:connections.Add($profile)};$probe={param($endpoint) $script:reachable}
function Tick($State,$Config,[datetime]$Time=$now,[switch]$Maintenance) { Sync-NvNetwork $State $Config $observe $connect $probe $Time -Maintenance:$Maintenance }
Check 'invalid adapter, duplicates and untested automatic profiles are rejected' {
 $p=Policy;$p.adapter_id='invalid';Throws {Assert-NvNetworkPolicy $p}
 $p=Policy;$p.backups=@($p.primary);Throws {Assert-NvNetworkPolicy $p}
 $p=Policy;$p.tested=@($p.primary);Throws {Assert-NvNetworkPolicy $p}
 Assert-NvNetworkPolicy (Policy)
}
Check 'endpoint extraction removes RTSP credentials and preserves ports' {
 $targets=@(Get-NvNetworkEndpoints @('rtsp://admin:synthetic@192.168.1.13:554/onvif1','rtsp://admin:another@192.168.1.13:554/other','rtsps://user:secret@camera.example:322/live'))
 Assert ($targets.Count -eq 2);Assert ($targets[0].host -eq '192.168.1.13' -and $targets[1].port -eq 322)
 Assert (-not ($targets|ConvertTo-Json).Contains('synthetic'))
}
Check 'disabled policy and manual maintenance perform no connection changes' {
 $s=New-NvNetworkState;$p=Policy;$p.enabled=$false;$script:connections.Clear();Tick $s $p
 $p.enabled=$true;for ($i=0;$i -lt 5;$i++) {Tick $s $p -Maintenance}
 Assert ($script:connections.Count -eq 0)
}
Check 'a disconnected adapter requires three observations before primary retry' {
 $s=New-NvNetworkState;$script:connections.Clear();$script:observed=@{State=4;Profile=''};$script:reachable=$false
 Tick $s (Policy);Tick $s (Policy);Assert ($script:connections.Count -eq 0)
 Tick $s (Policy);Assert ($script:connections.Count -eq 1 -and $script:connections[0] -eq 'Main 2.4')
}
Check 'failed primary proceeds to backups in configured order with cooldown' {
 $s=New-NvNetworkState;$p=Policy;$script:connections.Clear()
 1..3|ForEach-Object {Tick $s $p};Assert ($s.Pending -eq $p.primary)
 Tick $s $p $now.AddSeconds(21);Tick $s $p $now.AddSeconds(22);Assert ($script:connections.Count -eq 1)
 Tick $s $p $now.AddSeconds(37);Assert ($s.Pending -eq 'Backup 5G')
 Tick $s $p $now.AddSeconds(58);Tick $s $p $now.AddSeconds(59);Tick $s $p $now.AddSeconds(75)
 Assert ($s.Pending -eq 'Other AP' -and $script:connections.Count -eq 3)
}
Check 'a connected selected network with an offline camera does not trigger Wi-Fi cycling' {
 $s=New-NvNetworkState;$script:connections.Clear();$script:observed=@{State=1;Profile='Main 2.4'};$script:reachable=$false
 1..8|ForEach-Object {Tick $s (Policy)}
 Assert ($script:connections.Count -eq 0 -and $s.Status -like '*camera sem acesso*')
}
Check 'unknown current profile suspends automatic changes' {
 $s=New-NvNetworkState;$script:connections.Clear();$script:observed=@{State=1;Profile=''}
 1..5|ForEach-Object {Tick $s (Policy)}
 Assert ($script:connections.Count -eq 0 -and $s.Status -like '*suspensa*')
}
Check 'successful backup with a reachable camera is retained without disruptive failback' {
 $s=New-NvNetworkState;$s.Pending='Backup 5G';$s.Searching=$true;$s.Cursor=2
 $script:observed=@{State=1;Profile='Backup 5G'};$script:reachable=$true;$script:connections.Clear()
 1..5|ForEach-Object {Tick $s (Policy)}
 Assert ($s.Pending -eq '' -and -not $s.Searching -and $script:connections.Count -eq 0)
}
Check 'moving to an unrelated network with no camera access restores selected profiles' {
 $s=New-NvNetworkState;$script:observed=@{State=1;Profile='Unselected hotspot'};$script:reachable=$false;$script:connections.Clear()
 1..3|ForEach-Object {Tick $s (Policy)}
 Assert ($script:connections.Count -eq 1 -and $script:connections[0] -eq 'Main 2.4')
}
Check 'connection failures are contained and respect retry delay' {
 $s=New-NvNetworkState;$script:observed=@{State=4;Profile=''}
 $failing={param($id,$profile) throw 'Simulated adapter refusal'}
 1..3|ForEach-Object {Sync-NvNetwork $s (Policy) $observe $failing $probe $now}
 Assert ($s.Status -like '*nao foi possivel*' -and $s.NextAttempt -gt $now)
}
Check 'maintenance lock prevents the worker from competing with the configuration screen' {
 $directory=Join-Path ([IO.Path]::GetTempPath()) ('nv-network-lock-'+[guid]::NewGuid().ToString('N'))
 [IO.Directory]::CreateDirectory($directory)|Out-Null
 try {
  $handle=[IO.File]::Open((Join-Path $directory 'network-maintenance.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try { Assert (Test-NvNetworkMaintenance $directory) } finally { $handle.Dispose() }
  Assert (-not (Test-NvNetworkMaintenance $directory))
 } finally { Remove-Item -LiteralPath $directory -Recurse -Force }
}
Check 'disabling automatic mode clears previous connection attempts' {
 $s=New-NvNetworkState;$s.Pending='Old';$s.Searching=$true;$s.Failures=4;$s.Cursor=2
 Tick $s $null
 Assert (-not $s.Searching -and $s.Pending -eq '' -and $s.Failures -eq 0 -and $s.Cursor -eq 0)
}
Write-Host "$script:passed network checks passed."
