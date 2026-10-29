# NextVision Connect - Windows PowerShell 5.1+. Execute sempre com o mesmo usuario Windows.
param(
  [ValidateSet('activate','configure','configure-camera','remove-camera','set-storage','configure-network','configure-runtime','configure-tunnel','external-runtime','install-startup','uninstall-startup','start','stop','status','run')][string]$Mode='run',
  [string]$CameraId='',
  [string]$RecordingDirectory='',
  [string]$MediaMTXPath='',
  [string]$CloudflaredPath='',
  [string]$TunnelHostname='',
  [switch]$Background
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
if ($env:OS -ne 'Windows_NT') { throw 'Este agente usa DPAPI do Windows. Os testes portaveis ficam em tests/.' }
Import-Module (Join-Path $PSScriptRoot 'NextVision.Core.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'NextVision.Runtime.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'NextVision.Startup.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'NextVision.Network.psm1') -Force
$Base='https://nextvision-mgx6.onrender.com'
$AgentDirectory=Join-Path $env:LOCALAPPDATA 'NextVisionConnect'
$KeyFile=Join-Path $AgentDirectory 'device-token.dpapi'
$RtspFile=Join-Path $AgentDirectory 'rtsp-read.dpapi'
$SettingsFile=Join-Path $AgentDirectory 'settings.json'
$SourceDirectory=Join-Path $AgentDirectory 'sources'
$JournalDirectory=Join-Path $AgentDirectory 'recording-state'
$OutboxDirectory=Join-Path $AgentDirectory 'events'
$RuntimeFile=Join-Path $AgentDirectory 'runtime.json'
$RuntimeConfigFile=Join-Path $AgentDirectory 'runtime-config.dpapi'
$StopFile=Join-Path $AgentDirectory 'stop.request'
$NetworkFile=Join-Path $AgentDirectory 'network-policy.json'
New-Item -ItemType Directory -Force -Path $AgentDirectory,$SourceDirectory,$JournalDirectory,$OutboxDirectory | Out-Null
function ReadSecret([string]$Path) {
  $secure=(Get-Content -LiteralPath $Path -Raw).Trim() | ConvertTo-SecureString
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function SaveSecret([string]$Path,[string]$Value) {
  $secure=ConvertTo-SecureString $Value -AsPlainText -Force
  $temporary=$Path+'.tmp'
  try {
    ConvertFrom-SecureString $secure | Set-Content -LiteralPath $temporary -Encoding Ascii
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary,$Path,[NullString]::Value) }
    else { [IO.File]::Move($temporary,$Path) }
  } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}
function Request([string]$Method,[string]$Path,$Payload=$null,[string]$Token='') {
  $headers=@{}
  if ($Token) { $headers.Authorization='Bearer '+$Token }
  elseif (Test-Path -LiteralPath $KeyFile) { $headers.Authorization='Bearer '+(ReadSecret $KeyFile) }
  $parameters=@{Uri=($Base+$Path);Method=$Method;Headers=$headers;TimeoutSec=10}
  if ($null -ne $Payload) { $parameters.ContentType='application/json';$parameters.Body=($Payload|ConvertTo-Json -Depth 8 -Compress) }
  Invoke-RestMethod @parameters
}
function AssertTechnicalAccess([string]$Token='') {
  $status=Request 'GET' '/api/connect/status'
  if (-not $Token) {
    $credential=Get-Credential -Message 'Login da central ou tecnico autorizado para esta loja'
    if ($null -eq $credential) { throw 'Configuracao cancelada.' }
    $login=Request 'POST' '/api/auth/login' @{email=$credential.UserName;password=$credential.GetNetworkCredential().Password}
    $Token=$login.token
  }
  $user=Request 'GET' '/api/me' $null $Token
  if ($user.role -eq 'master') { return $Token }
  if ($user.role -ne 'technician') { throw 'Somente a central ou um tecnico autorizado pode configurar fontes.' }
  $assignments=@(Request 'GET' '/api/technician/assignments' $null $Token)
  if (-not @($assignments | Where-Object { $_.tenant_id -eq $status.tenant_id -and $_.status -in @('assigned','in_progress') }).Count) {
    throw 'A central precisa autorizar a manutencao desta loja.'
  }
  return $Token
}
function ReadRuntimeConfig {
  if (Test-Path -LiteralPath $RuntimeConfigFile) { return (ReadSecret $RuntimeConfigFile|ConvertFrom-Json) }
  return $null
}
function ResolveExecutable([string]$Path,[string]$Default) {
  if (-not $Path) { $Path=$Default }
  $command=Get-Command -Name $Path -CommandType Application -ErrorAction Stop
  return $command.Source
}
if ($Mode -in @('stop','uninstall-startup')) {
  if ($Mode -eq 'stop') { Stop-NvStartup $AgentDirectory;Write-Host 'Parada solicitada. Inicio automatico desabilitado ate executar start.' }
  else { Uninstall-NvStartup $AgentDirectory;Write-Host 'Inicio automatico removido. Gravacoes e configuracoes preservadas.' }
  return
}
if ($Mode -eq 'activate') {
  $name=Read-Host 'Nome deste computador'
  $code=Read-Host 'Codigo de ativacao gerado pela central'
  $data=Request 'POST' '/api/connect/activate' @{activation_code=$code;device_name=$name}
  SaveSecret $KeyFile $data.device_token
  Write-Host 'Computador ativado. A central deve vincular as cameras a este dispositivo.'
  return
}
if ($Mode -eq 'set-storage') {
  if (-not $RecordingDirectory) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog=New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description='Pasta para as gravacoes NextVision'
    try {
      if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return }
      $RecordingDirectory=$dialog.SelectedPath
    } finally { $dialog.Dispose() }
  }
  $selected=Set-NvStorageDirectory $RecordingDirectory
  Write-NvJson $SettingsFile @{recording_directory=$selected}
  Write-Host "Pasta salva: $selected. Novas gravacoes usarao essa pasta; arquivos anteriores permanecem onde estavam."
  return
}
if (-not (Test-Path -LiteralPath $KeyFile)) { throw 'Execute primeiro: .\nextvision-connect.ps1 activate' }
if ($Mode -eq 'configure-network') {
  # Network maintenance must also work while the cloud is unreachable. It changes
  # Windows connectivity only; camera source/plan authorization is unchanged.
  $urls=@(foreach ($file in @(Get-ChildItem -LiteralPath $SourceDirectory -Filter '*.dpapi')) {
    $disabled=Join-Path $SourceDirectory ($file.BaseName+'.disabled')
    if (-not (Test-Path -LiteralPath $disabled)) { (ReadSecret $file.FullName|ConvertFrom-Json).url }
  })
  Show-NvNetworkSettings $NetworkFile @(Get-NvNetworkEndpoints $urls) $AgentDirectory
  return
}
if ($Mode -in @('install-startup','start')) {
  if (-not (Test-Path -LiteralPath $RtspFile)) { throw 'Configure a leitura do MediaMTX antes de instalar o inicio automatico.' }
  Request 'GET' '/api/connect/status'|Out-Null
  if ($Mode -eq 'install-startup') {
    Install-NvStartup $PSScriptRoot $AgentDirectory|Out-Null
    Write-Host 'Agente copiado para pasta estavel e tarefa registrada para o login deste usuario Windows.'
  }
  Start-NvStartup $AgentDirectory
  Write-Host 'Agente habilitado em segundo plano. Use status para conferir a ultima observacao e stop para encerrar.'
  return
}
if ($Mode -in @('configure-runtime','configure-tunnel','external-runtime')) {
  $technicalToken=AssertTechnicalAccess
  if ($Mode -eq 'external-runtime') {
    if (Test-Path -LiteralPath $RuntimeConfigFile) { Remove-Item -LiteralPath $RuntimeConfigFile }
    Write-Host 'Gerenciamento local desativado. O agente encerrara seus servicos; configure/inicie o relay externo antes de usa-lo.'
    return
  }
  $options=ReadRuntimeConfig
  if ($Mode -eq 'configure-runtime') {
    if (-not $MediaMTXPath) { $MediaMTXPath=Read-Host 'Caminho do mediamtx.exe (vazio usa PATH)' }
    $relay=ResolveExecutable $MediaMTXPath 'mediamtx'
    $version=@(& $relay --version 2>$null)
    if ($LASTEXITCODE -ne 0 -or ($version -join '') -notmatch '^v?1\.21\.3$') { throw 'Esta versao foi validada com MediaMTX 1.21.3. Use esse binario antes de habilitar o gerenciamento.' }
    if ($null -eq $options) { $options=[pscustomobject]@{relay_binary=$relay;ffmpeg_binary=(ResolveExecutable '' 'ffmpeg');tunnel_enabled=$false;tunnel_binary='';tunnel_hostname='';tunnel_token=''} }
    else { $options.relay_binary=$relay;$options.ffmpeg_binary=ResolveExecutable '' 'ffmpeg' }
  } else {
    if ($null -eq $options) { throw 'Configure primeiro o relay: configure-runtime.' }
    if (-not $TunnelHostname) { $TunnelHostname=Read-Host 'Hostname fixo provisionado pela central no Cloudflare' }
    Assert-NvTunnelHostname $TunnelHostname
    $binary=ResolveExecutable $CloudflaredPath 'cloudflared'
    $secret=Read-Host 'Token do tunel nomeado (nao enviar pelo chat)' -AsSecureString
    $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try { $token=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    if (-not $token) { throw 'Token de tunel vazio.' }
    $options.tunnel_enabled=$true;$options.tunnel_binary=$binary;$options.tunnel_hostname=$TunnelHostname;$options.tunnel_token=$token
  }
  AssertTechnicalAccess $technicalToken|Out-Null
  SaveSecret $RuntimeConfigFile ($options|ConvertTo-Json -Compress)
  $options=$null;$token=$null
  Write-Host 'Configuracao protegida salva. O agente aplicara no proximo ciclo. Processos externos precisam ser encerrados pelo tecnico; nao serao assumidos ou mortos.'
  return
}
if ($Mode -eq 'configure') {
  $credential=Get-Credential -Message 'Usuario e senha de leitura do MediaMTX local'
  if ($null -eq $credential) { return }
  SaveSecret $RtspFile ($credential.UserName+':'+$credential.GetNetworkCredential().Password)
  Write-Host 'Credenciais locais protegidas com DPAPI para este usuario Windows.'
  return
}
if ($Mode -in @('configure-camera','remove-camera')) {
  $technicalToken=AssertTechnicalAccess
  Assert-NvId $CameraId
  $response=Request 'GET' '/api/connect/cameras'
  $camera=@($response.cameras | Where-Object { $_.id -eq $CameraId })
  if ($camera.Count -ne 1) { throw 'Camera nao vinculada a este computador. Faca o vinculo pela central.' }
  $sourceFile=Join-Path $SourceDirectory ($CameraId+'.dpapi')
  $disabledFile=Join-Path $SourceDirectory ($CameraId+'.disabled')
  if ($Mode -eq 'remove-camera') {
    [IO.File]::WriteAllText($disabledFile,'disabled')
    if (Test-Path -LiteralPath $sourceFile) { Remove-Item -LiteralPath $sourceFile }
    Write-Host 'Fonte local removida. O cadastro e o historico da camera permanecem na central.'
    return
  }
  $path=Get-NvCameraPath $response $camera[0]
  if (-not $path) { throw 'A central ainda nao habilitou o modo de midia desta camera.' }
  $address=Read-Host 'URL RTSP da camera, sem usuario/senha (ex: rtsp://192.168.1.13:554/onvif1)'
  $transport=Read-Host 'Transporte de entrada: tcp ou udp (Yoosee testada: udp)'
  if ($transport -notin @('tcp','udp')) { throw 'Transporte deve ser tcp ou udp.' }
  $credential=Get-Credential -Message 'Usuario e senha NVR/RTSP desta camera; ficam somente neste computador'
  if ($null -eq $credential) { return }
  $url=New-NvRtspUrl $address $credential.UserName $credential.GetNetworkCredential().Password
  # Recheck after the interactive prompts; a revoked assignment/device must not save a new source.
  AssertTechnicalAccess $technicalToken | Out-Null
  $latest=Request 'GET' '/api/connect/cameras'
  $approved=@($latest.cameras | Where-Object { $_.id -eq $CameraId -and $_.config_version -eq $camera[0].config_version })
  if ($approved.Count -ne 1) { throw 'Cadastro alterado durante a configuracao. Confira a camera na central e repita.' }
  SaveSecret $sourceFile (@{url=$url;transport=$transport;config_version=$camera[0].config_version;revision=[guid]::NewGuid().ToString()}|ConvertTo-Json -Compress)
  if (Test-Path -LiteralPath $disabledFile) { Remove-Item -LiteralPath $disabledFile }
  $url=$null;$credential=$null
  Write-Host "Fonte protegida e vinculada ao caminho aprovado $path. O agente a iniciara se a camera estiver habilitada."
  return
}
if ($Mode -eq 'status') {
  try {
    $status=Request 'GET' '/api/connect/status'
    $response=Request 'GET' '/api/connect/cameras'
    Write-Host "Dispositivo autorizado: $($status.enabled); modo: $($response.mode)"
    $response.cameras | Select-Object id,name,enabled,config_version
  } catch { Write-Warning 'Nao foi possivel confirmar a autorizacao na central. O estado abaixo e somente local.' }
  if (Test-Path -LiteralPath $RuntimeFile) {
    $runtime=Get-Content -LiteralPath $RuntimeFile -Raw -Encoding UTF8|ConvertFrom-Json
    Write-Host "Ultima observacao local: $($runtime.observed_at). Atualizacoes com mais de 30 segundos podem estar desatualizadas."
    $runtime.publishers | Format-Table id,status
    if ($null -ne $runtime.PSObject.Properties['services']) { Write-Host ('Servicos: '+$runtime.services) }
    if ($null -ne $runtime.PSObject.Properties['network']) { Write-Host ('Rede: '+$runtime.network) }
  }
  $task=Get-ScheduledTask -TaskName (Get-NvStartupTaskName) -ErrorAction SilentlyContinue
  if ($null -ne $task) { Write-Host ('Inicio automatico: '+$task.State) }
  Write-Host 'Confira tambem a imagem em movimento no link de um pedido em atendimento.'
  return
}
$initialRuntime=ReadRuntimeConfig
$ffmpeg=$(if ($null -ne $initialRuntime) { ResolveExecutable $initialRuntime.ffmpeg_binary 'ffmpeg' } else { ResolveExecutable '' 'ffmpeg' })
if (-not (Test-Path -LiteralPath $RtspFile)) { throw 'Execute antes: .\nextvision-connect.ps1 configure' }
# An exclusive file handle prevents two agents from publishing/recording the same camera.
try { $instanceLock=[IO.File]::Open((Join-Path $AgentDirectory 'agent.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
catch { throw 'Ja existe um agente em execucao para este usuario Windows.' }
$publishers=New-NvSupervisor
$services=New-NvRuntimeState
$network=New-NvNetworkState
$active=@{}
function GetVideos {
  $directory=Join-Path $AgentDirectory 'recordings'
  if (Test-Path -LiteralPath $SettingsFile) { $directory=(Get-Content -LiteralPath $SettingsFile -Raw -Encoding UTF8|ConvertFrom-Json).recording_directory }
  return Set-NvStorageDirectory $directory
}
function LocalReadUrl([string]$Path) {
  $raw=ReadSecret $RtspFile
  $separator=$raw.IndexOf(':')
  if ($separator -lt 1) { throw 'Credenciais de leitura invalidas.' }
  return New-NvRtspUrl ('rtsp://127.0.0.1:8554/'+$Path) $raw.Substring(0,$separator) $raw.Substring($separator+1)
}
function QueueEvent([string]$Id,[string]$Action) {
  Assert-NvId $Id
  # One outstanding terminal event supersedes a previously unacknowledged started event.
  Write-NvJson (Join-Path $OutboxDirectory ($Id+'.json')) @{id=$Id;event=$Action}
}
function FlushEvents {
  foreach ($file in @(Get-ChildItem -LiteralPath $OutboxDirectory -Filter '*.json')) {
    $event=Get-Content -LiteralPath $file.FullName -Raw|ConvertFrom-Json
    Assert-NvId ([string]$event.id)
    if ($event.event -notin @('started','stopped','failed')) { throw 'Evento local invalido.' }
    try {
      Request 'POST' ('/api/connect/recording-jobs/'+$event.id+'/event') @{event=$event.event} | Out-Null
      Remove-Item -LiteralPath $file.FullName
    } catch {
      $response=$_.Exception.Response
      if ($null -ne $response -and [int]$response.StatusCode -in @(404,409)) {
        # No longer applicable (already acknowledged, finalized or reassigned).
        Remove-Item -LiteralPath $file.FullName
      } else { throw }
    }
  }
}
function Finalize([string]$Id,[bool]$Failed=$false) {
  $item=$active[$Id]
  if ($null -eq $item) { return }
  try {
    Stop-NvMedia $item.Media
    $item.Media=$null
    # No overwrite, including after a crash. MPEG-TS is retained even after successful remux.
    $mp4=Complete-NvRecording $ffmpeg $item.Raw
    QueueEvent $Id $(if ($Failed) {'failed'} else {'stopped'})
    Write-Host "Arquivo local salvo: $mp4. Download pelo portal ainda nao integrado."
  } catch {
    QueueEvent $Id 'failed'
    Write-Warning "Gravacao $Id preservada em TS; MP4 nao confirmado. Confira o arquivo local."
  } finally {
    $active.Remove($Id)
    $journal=Join-Path $JournalDirectory ($Id+'.json')
    if (Test-Path -LiteralPath $journal) { Remove-Item -LiteralPath $journal }
  }
}
Write-Host 'NextVision Connect: fontes autorizadas e gravacoes. Ctrl+C encerra apenas os processos deste agente.'
try {
  if ($Background -and (Test-Path -LiteralPath $StopFile)) { return }
  if (-not $Background -and (Test-Path -LiteralPath $StopFile)) { Remove-Item -LiteralPath $StopFile }
  # Recover metadata after a crash without overwriting or silently claiming a complete recording.
  foreach ($file in @(Get-ChildItem -LiteralPath $JournalDirectory -Filter '*.json')) {
    $journal=Get-Content -LiteralPath $file.FullName -Raw|ConvertFrom-Json
    Assert-NvId $journal.id
    QueueEvent $journal.id 'failed'
    Write-Warning "Gravacao interrompida $($journal.id); arquivo preservado: $($journal.raw)"
    Remove-Item -LiteralPath $file.FullName
  }
  while ($true) {
    if (Test-Path -LiteralPath $StopFile) { break }
    # Reconnect before cloud requests: a broken network must not block its own repair.
    try {
      $policy=$null;if (Test-Path -LiteralPath $NetworkFile) { $policy=Get-Content -LiteralPath $NetworkFile -Raw -Encoding UTF8|ConvertFrom-Json }
      Sync-NvNetwork $network $policy -Maintenance:(Test-NvNetworkMaintenance $AgentDirectory)
      if ($network.Changed) { Stop-NvPublishers $publishers;foreach ($id in @($active.Keys)) { Finalize $id $true } }
    } catch { $network.Status='configuracao de rede invalida ou adaptador indisponivel; manutencao necessaria' }
    try {
      $config=Request 'GET' '/api/connect/cameras'
      FlushEvents
      $result=Request 'GET' '/api/connect/recording-jobs'
      $desired=@();$paths=@{};$revisions=@{}
      foreach ($camera in $config.cameras) {
        if (-not $camera.enabled) { continue }
        if (Test-Path -LiteralPath (Join-Path $SourceDirectory ($camera.id+'.disabled'))) { continue }
        $path=Get-NvCameraPath $config $camera
        if (-not $path) { continue }
        $paths[[string]$camera.id]=$path
        $sourceFile=Join-Path $SourceDirectory ($camera.id+'.dpapi')
        $revisions[[string]$camera.id]=[string]$camera.config_version
        if (Test-Path -LiteralPath $sourceFile) {
          $source=ReadSecret $sourceFile | ConvertFrom-Json
          if ($source.config_version -ne $camera.config_version) {
            # Never restart a replaced camera using the previous equipment's saved secret.
            $paths.Remove([string]$camera.id)
            continue
          }
          $revisions[[string]$camera.id]+=':'+$source.revision
          $desired+=@{Id=[string]$camera.id;Path=$path;Url=$source.url;Transport=$source.transport;Revision=$revisions[[string]$camera.id]}
        } elseif ($config.mode -ne 'legacy_single_camera') { $paths.Remove([string]$camera.id) }
      }
      $options=ReadRuntimeConfig
      $readerUser='';$readerPassword=''
      if ($null -ne $options) {
        if ($ffmpeg -ne $options.ffmpeg_binary) {
          Stop-NvPublishers $publishers
          foreach ($id in @($active.Keys)) { Finalize $id $true }
          $ffmpeg=ResolveExecutable $options.ffmpeg_binary 'ffmpeg'
        }
        $credential=ReadSecret $RtspFile;$separator=$credential.IndexOf(':')
        if ($separator -lt 1) { throw 'Credencial local invalida.' }
        $readerUser=$credential.Substring(0,$separator);$readerPassword=$credential.Substring($separator+1)
      }
      $generation=$services.RelayGeneration
      $health=Sync-NvRuntime $services $options @($desired|ForEach-Object { $_.Path }) (Join-Path $AgentDirectory 'services') $readerUser $readerPassword
      $readerPassword=$null;$credential=$null
      if ($generation -ne $health.Generation) {
        Stop-NvPublishers $publishers
        foreach ($id in @($active.Keys)) { Finalize $id $true }
      }
      if (-not $health.RelayReady) { $desired=@();$paths=@{} }
      Sync-NvPublishers $publishers $desired $ffmpeg
      $observed=@(foreach ($id in $publishers.Keys) { @{id=$id;status=$publishers[$id].Status} })
      Write-NvJson $RuntimeFile @{observed_at=[datetime]::UtcNow.ToString('o');publishers=$observed;services=$health.Status;network=$network.Status}
      $jobs=@($result.jobs | Where-Object { $null -ne $_ })
      $byId=@{};foreach ($job in $jobs) { $byId[[string]$job.recording_id]=$job }
      foreach ($id in @($active.Keys)) {
        $job=$byId[$id];$item=$active[$id]
        if ($null -eq $job -or $job.status -in @('paused','finalizing','failed') -or $job.order_status -ne 'live' -or $job.current_step -ne $job.step_index) {
          Finalize $id ($null -eq $job -or $job.status -eq 'failed')
        } elseif (-not $paths.ContainsKey([string]$job.camera_id) -or $item.Revision -ne $revisions[[string]$job.camera_id] -or $item.Media.HasExited -or $item.Media.IdleSeconds -gt 45) { Finalize $id $true }
        elseif (-not $item.Acknowledged -and $item.Media.HasProgress) { QueueEvent $id 'started';$item.Acknowledged=$true }
      }
      foreach ($job in $jobs) {
        $id=[string]$job.recording_id
        if ($job.status -ne 'pending' -or $job.order_status -ne 'live' -or $job.current_step -ne $job.step_index -or $active.ContainsKey($id) -or -not $paths.ContainsKey([string]$job.camera_id)) { continue }
        Assert-NvId $id
        # Pending terminal acknowledgements must be delivered before retrying a recording.
        if (Test-Path -LiteralPath (Join-Path $OutboxDirectory ($id+'.json'))) { continue }
        try {
          $raw=Join-Path (GetVideos) ($id+'-'+[guid]::NewGuid().ToString('N')+'.ts')
          Write-NvJson (Join-Path $JournalDirectory ($id+'.json')) @{id=$id;raw=$raw}
          $media=Start-NvMedia $ffmpeg (LocalReadUrl $paths[[string]$job.camera_id]) 'tcp' @('-n','-c:v','copy','-f','mpegts',$raw)
          $active[$id]=@{Media=$media;Raw=$raw;Revision=$revisions[[string]$job.camera_id];Acknowledged=$false}
          Write-Host "Gravacao solicitada: $id"
        } catch { QueueEvent $id 'failed';Write-Warning "Nao foi possivel iniciar a gravacao $id. Verifique a pasta e o relay local." }
      }
      FlushEvents
    } catch {
      Write-Warning 'Sem autorizacao/conexao ou configuracao invalida; fontes e gravacoes locais interrompidas. Nova tentativa em 5 segundos.'
      Stop-NvPublishers $publishers
      Stop-NvRuntime $services
      Write-NvJson $RuntimeFile @{observed_at=[datetime]::UtcNow.ToString('o');publishers=@();status='interrompido';network=$network.Status}
      foreach ($id in @($active.Keys)) { Finalize $id $true }
    }
    Start-Sleep -Seconds 5
  }
} finally {
  Stop-NvPublishers $publishers
  Stop-NvRuntime $services
  Write-NvJson $RuntimeFile @{observed_at=[datetime]::UtcNow.ToString('o');publishers=@();status='encerrado'}
  foreach ($id in @($active.Keys)) { Finalize $id $true }
  $instanceLock.Dispose()
}
