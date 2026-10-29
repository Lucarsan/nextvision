# Recovery for the existing, centrally operated single-camera pilot.
# Does not require the unreleased /api/connect/cameras endpoint.
param(
  [ValidateSet('repair','run','start','stop','status','restart-publisher','uninstall')][string]$Mode='status',
  [Security.SecureString]$CameraPassword,
  [Diagnostics.Process]$PublisherToReplace,
  [string]$CameraAddress='rtsp://192.168.1.13:554/onvif1',
  [string]$CameraUsername='admin',
  [ValidateSet('udp','tcp')][string]$Transport='udp',
  [string]$MediaMTXPath='',
  [string]$MediaMTXConfig='',
  [switch]$Background
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
if ($env:OS -ne 'Windows_NT') { throw 'O piloto usa a identidade e o DPAPI do Windows.' }
Import-Module (Join-Path $PSScriptRoot 'NextVision.Core.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'NextVision.Startup.psm1') -Force
$directory=Join-Path $env:LOCALAPPDATA 'NextVisionPilotRecovery'
[IO.Directory]::CreateDirectory($directory)|Out-Null
$keyFile=Join-Path $directory 'source.dpapi'
$statusFile=Join-Path $directory 'status.json'
$stopFile=Join-Path $directory 'stop.request'
$restartFile=Join-Path $directory 'restart.request'
$task='NextVisionPilotPublisher-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function ReadSource {
  $secure=(Get-Content -LiteralPath $keyFile -Raw).Trim()|ConvertTo-SecureString
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)|ConvertFrom-Json }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
if ($Mode -eq 'status') {
  Write-Host ('Supervisor ativo: '+(Test-NvAgentRunning $directory))
  if (Test-Path -LiteralPath $statusFile) {
    Get-Content -LiteralPath $statusFile -Raw|ConvertFrom-Json|Select-Object observed_at,status,publisher_pid
  }
  Write-Host 'Uma lista de processos nao comprova video. Confira o link do pedido em atendimento.'
  return
}
if ($Mode -in @('stop','uninstall')) {
  if ($Mode -eq 'stop') { Stop-NvStartup $directory $task }
  else { Uninstall-NvStartup $directory $task }
  Write-Host 'Supervisor interrompido; configuracao e videos preservados. Processos externos permanecem sob controle do tecnico.'
  return
}
if ($Mode -eq 'repair') {
  if (Test-NvAgentRunning (Join-Path $env:LOCALAPPDATA 'NextVisionConnect')) { throw 'O agente completo ja esta ativo. Nao instalar dois publicadores para a mesma camera.' }
  if ($null -ne $PublisherToReplace -and -not $PublisherToReplace.HasExited -and $PublisherToReplace.ProcessName -ne 'ffmpeg') { throw 'A substituicao exige o objeto do FFmpeg iniciado nesta sessao, sem procurar por nome ou PID antigo.' }
  if ($null -ne $CameraPassword -or -not (Test-Path -LiteralPath $keyFile)) {
    if ($null -eq $CameraPassword) {
      $credential=Get-Credential -UserName $CameraUsername -Message 'Credencial NVR/RTSP do piloto; sera protegida neste computador'
      if ($null -eq $credential) { return }
      $CameraPassword=$credential.Password;$CameraUsername=$credential.UserName
    }
    $credential=New-Object Management.Automation.PSCredential($CameraUsername,$CameraPassword)
    $url=New-NvRtspUrl $CameraAddress $CameraUsername $credential.GetNetworkCredential().Password
    $ffmpeg=(Get-Command ffmpeg -CommandType Application -ErrorAction Stop).Source
    if (-not $MediaMTXPath) {
      $command=Get-Command mediamtx -CommandType Application -ErrorAction SilentlyContinue
      if ($null -ne $command) { $MediaMTXPath=$command.Source }
      else { $MediaMTXPath=Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\bluenviron.mediamtx_Microsoft.Winget.Source_8wekyb3d8bbwe\mediamtx.exe' }
    }
    if (-not $MediaMTXConfig) { $MediaMTXConfig=Join-Path $env:USERPROFILE 'mediamtx.yml' }
    if (-not [IO.File]::Exists($MediaMTXPath) -or -not [IO.File]::Exists($MediaMTXConfig)) { throw 'MediaMTX/configuracao original nao encontrados. Informe MediaMTXPath e MediaMTXConfig; a configuracao original sera preservada.' }
    $source=@{id=[guid]::NewGuid().ToString();url=$url;transport=$Transport;revision=[guid]::NewGuid().ToString();ffmpeg=$ffmpeg;relay_binary=$MediaMTXPath;relay_config=$MediaMTXConfig}
    $protected=ConvertTo-SecureString ($source|ConvertTo-Json -Compress) -AsPlainText -Force
    $temporary=$keyFile+'.tmp'
    try {
      ConvertFrom-SecureString $protected|Set-Content -LiteralPath $temporary -Encoding Ascii
      if ([IO.File]::Exists($keyFile)) { [IO.File]::Replace($temporary,$keyFile,[NullString]::Value) }
      else { [IO.File]::Move($temporary,$keyFile) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
    $url=$null;$source=$null;$credential=$null;$CameraPassword=$null
  }
  # A registration failure must leave the manually restored stream running.
  Install-NvStartup $PSScriptRoot $directory $task 'nextvision-pilot.ps1'|Out-Null
  if ($null -ne $PublisherToReplace -and -not $PublisherToReplace.HasExited) { $PublisherToReplace.Kill();$PublisherToReplace.WaitForExit(5000)|Out-Null }
  Start-NvStartup $directory $task
  Write-Host 'Supervisor instalado e iniciado em segundo plano. Credencial NVR protegida para este usuario Windows; confirme status e video.'
  return
}
if (-not (Test-Path -LiteralPath $keyFile)) { throw 'Configure primeiro com repair.' }
if ($Mode -eq 'start') { Start-NvStartup $directory $task;return }
if ($Mode -eq 'restart-publisher') {
  if (-not (Test-NvAgentRunning $directory)) { throw 'Supervisor nao esta ativo.' }
  [IO.File]::WriteAllText($restartFile,'restart')
  Write-Host 'Teste solicitado: somente o publicador pertencente ao supervisor sera interrompido e recuperado.'
  return
}
try { $instance=[IO.File]::Open((Join-Path $directory 'agent.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
catch { throw 'O supervisor deste piloto ja esta ativo.' }
$state=New-NvSupervisor;$relay=$null;$relayRetry=[datetime]::MinValue;$relayFailures=0
try {
  if ($Background -and (Test-Path -LiteralPath $stopFile)) { return }
  if (-not $Background -and (Test-Path -LiteralPath $stopFile)) { Remove-Item -LiteralPath $stopFile }
  $source=ReadSource
  $desired=@(@{Id=[string]$source.id;Path='camera';Url=$source.url;Transport=$source.transport;Revision=$source.revision})
  while (-not (Test-Path -LiteralPath $stopFile)) {
    if (Test-NvAgentRunning (Join-Path $env:LOCALAPPDATA 'NextVisionConnect')) { throw 'Agente completo detectado; piloto encerrado para evitar publicacao duplicada.' }
    $latest=ReadSource
    if ($latest.revision -ne $source.revision) {
      Stop-NvPublishers $state;Stop-NvMedia $relay;$relay=$null;$relayFailures=0;$relayRetry=[datetime]::MinValue
      $source=$latest
      $desired=@(@{Id=[string]$source.id;Path='camera';Url=$source.url;Transport=$source.transport;Revision=$source.revision})
    }
    if ($null -ne $relay -and $relay.HasExited) {
      Stop-NvMedia $relay;$relay=$null;$relayFailures=[Math]::Min(6,$relayFailures+1)
      $relayRetry=[datetime]::UtcNow.AddSeconds([Math]::Min(60,[Math]::Pow(2,$relayFailures)))
    }
    if ($null -eq $relay -and [datetime]::UtcNow -ge $relayRetry) {
      $portAvailable=$true
      try { Assert-NvLocalPortAvailable 8554 } catch { $portAvailable=$false }
      if ($portAvailable) {
        # Reuse the technician's existing authenticated config, never generate an anonymous replacement.
        try { $relay=[NextVision.MediaProcess]::new($source.relay_binary,@($source.relay_config),'') }
        catch { $relayRetry=[datetime]::UtcNow.AddSeconds(5) }
      }
    }
    if (Test-Path -LiteralPath $restartFile) {
      Remove-Item -LiteralPath $restartFile
      if ($state.ContainsKey([string]$source.id) -and $null -ne $state[[string]$source.id].Media) {
        $media=$state[[string]$source.id].Media
        if (-not $media.HasExited) { $media.Process.Kill();$media.Process.WaitForExit(5000)|Out-Null }
      }
    }
    Sync-NvPublishers $state $desired $source.ffmpeg
    $entry=$state[[string]$source.id]
    $ownedId=$(if ($null -ne $entry.Media -and -not $entry.Media.HasExited) {$entry.Media.Process.Id} else {$null})
    Write-NvJson $statusFile @{observed_at=[datetime]::UtcNow.ToString('o');status=$entry.Status;publisher_pid=$ownedId}
    Start-Sleep -Seconds 2
  }
} finally {
  Stop-NvPublishers $state
  Stop-NvMedia $relay
  try { Write-NvJson $statusFile @{observed_at=[datetime]::UtcNow.ToString('o');status='encerrado';publisher_pid=$null} }
  finally { $instance.Dispose() }
}
