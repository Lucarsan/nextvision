Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'NextVision.Core.psm1')
function Get-NvStartupTaskName {
  if ($env:OS -ne 'Windows_NT') { throw 'Inicio automatico requer Windows.' }
  return 'NextVisionConnect-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}
function Test-NvAgentRunning([string]$Directory) {
  $file=Join-Path $Directory 'agent.lock'
  if (-not [IO.File]::Exists($file)) { return $false }
  try { $handle=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$handle.Dispose();return $false }
  catch [IO.IOException] { return $true }
}
function Install-NvStartup {
  param([string]$SourceDirectory,[string]$AgentDirectory,[string]$TaskName=(Get-NvStartupTaskName),[ValidatePattern('^[A-Za-z0-9-]+\.ps1$')][string]$EntryPoint='nextvision-connect.ps1')
  if ($env:OS -ne 'Windows_NT') { throw 'Inicio automatico requer Windows.' }
  $files=@($EntryPoint,'NextVision.Core.psm1','NextVision.Startup.psm1')
  if ($EntryPoint -eq 'nextvision-connect.ps1') { $files+=@('NextVision.Runtime.psm1','NextVision.Network.psm1') }
  $hashes=@(foreach ($file in $files) { (Get-FileHash -LiteralPath (Join-Path $SourceDirectory $file) -Algorithm SHA256).Hash })
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $version=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($hashes -join ':'))))).Replace('-','').Substring(0,20) }
  finally { $sha.Dispose() }
  $target=Join-Path (Join-Path $AgentDirectory 'app') $version
  [IO.Directory]::CreateDirectory($target)|Out-Null
  foreach ($file in $files) {
    $source=Join-Path $SourceDirectory $file;$destination=Join-Path $target $file
    if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($destination)) { Copy-Item -LiteralPath $source -Destination $destination -Force }
    if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) { throw 'Falha ao verificar a copia do agente.' }
  }
  $executable=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments='-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File '+[NextVision.MediaProcess]::Quote((Join-Path $target $EntryPoint))+' run -Background'
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $action=New-ScheduledTaskAction -Execute $executable -Argument $arguments -WorkingDirectory $target
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $sid
  $principal=New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([timespan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'NextVision Connect: fontes autorizadas e gravacoes deste usuario Windows.' -Force | Out-Null
  return $target
}
function Start-NvStartup([string]$AgentDirectory,[string]$TaskName=(Get-NvStartupTaskName)) {
  $stop=Join-Path $AgentDirectory 'stop.request'
  if ([IO.File]::Exists($stop)) { [IO.File]::Delete($stop) }
  Enable-ScheduledTask -TaskName $TaskName | Out-Null
  if (-not (Test-NvAgentRunning $AgentDirectory)) { Start-ScheduledTask -TaskName $TaskName }
}
function Stop-NvStartup([string]$AgentDirectory,[string]$TaskName=(Get-NvStartupTaskName),[int]$GraceSeconds=30) {
  # Persist operator intent: a deliberate stop must not be undone by a task retry.
  [IO.Directory]::CreateDirectory($AgentDirectory)|Out-Null
  [IO.File]::WriteAllText((Join-Path $AgentDirectory 'stop.request'),'stop')
  $task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $task) { Disable-ScheduledTask -TaskName $TaskName | Out-Null }
  $deadline=[datetime]::UtcNow.AddSeconds($GraceSeconds)
  while ((Test-NvAgentRunning $AgentDirectory) -and [datetime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if ($null -ne $task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
}
function Uninstall-NvStartup([string]$AgentDirectory,[string]$TaskName=(Get-NvStartupTaskName)) {
  Stop-NvStartup $AgentDirectory $TaskName
  if ($null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
}
Export-ModuleMember -Function *-Nv*
