# Ficou Pronto - servico das cameras (roda como SYSTEM, antes do login).
# Mantem um FFmpeg por camera publicando no MediaMTX local, recupera quedas,
# reencontra a camera pelo MAC se o IP mudar e envia sinal de vida a central.
# Falha da internet ou da central NAO derruba o video local.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'NextVision.Core.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'FicouPronto.psm1') -Force
$paths = Get-FpPaths

$lock = $null
try { $lock = [IO.File]::Open((Join-Path $paths.Data 'agent.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { Write-Output 'Outro agente ja esta ativo.'; exit 0 }

function Log([string]$Text) {
  try { [IO.File]::AppendAllText((Join-Path $paths.Logs 'agente.log'), ([datetime]::Now.ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $Text + "`r`n")) } catch { }
}

function Get-OutputArgs([string]$StreamPath) {
  return @('-vf', 'scale=1280:720,fps=15', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-b:v', '1200k', '-pix_fmt', 'yuv420p', '-g', '30', '-f', 'rtsp', '-rtsp_transport', 'tcp', ('rtsp://127.0.0.1:8554/' + $StreamPath))
}

function Start-Publisher($Camera, $Secrets) {
  if ($Camera.stream_path -notmatch '^[A-Za-z0-9_-]{1,100}$') { throw 'Caminho de camera invalido.' }
  if ($Camera.source -eq 'test') {
    $a = @('-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15') + (Get-OutputArgs $Camera.stream_path)
    return [NextVision.MediaProcess]::new($paths.Ffmpeg, $a, '')
  }
  $cred = $Secrets.cameras.($Camera.id)
  $url = New-FpRtspUrl $Camera.host ([int]$Camera.port) $Camera.path $cred.user $cred.password
  return (Start-NvMedia $paths.Ffmpeg $url $Camera.transport (Get-OutputArgs $Camera.stream_path))
}

$config = Read-FpConfig
$secrets = Read-FpSecrets
if ($null -eq $config -or $null -eq $secrets) { Log 'Sem configuracao; rode o instalador.'; Start-Sleep -Seconds 60; exit 1 }
$configStamp = (Get-Item -LiteralPath $paths.Config).LastWriteTimeUtc
$state = @{}
$blocked = $false
$nextHeartbeat = [datetime]::UtcNow
$heartbeatEvery = 30
$nextStatus = [datetime]::UtcNow
$central = 'aguardando'
$recording = @{}
$recordingStatus = @{ state = 'unknown'; detail = 'aguardando' }
$nextRecordingSync = [datetime]::UtcNow
# Backup: primeira conferencia 2 min depois de ligar; depois a cada 30 min (baixa so se o ultimo tem mais de 24 h).
$backupStatus = Get-FpBackupStatus
$nextBackup = [datetime]::UtcNow.AddMinutes(2)
Log ('Agente ' + $paths.Version + ' iniciado com ' + @($config.cameras).Count + ' camera(s).')

try {
  while ($true) {
    $now = [datetime]::UtcNow

    # Configuracao alterada pela manutencao: recarrega e reinicia os publicadores.
    $stamp = (Get-Item -LiteralPath $paths.Config).LastWriteTimeUtc
    if ($stamp -ne $configStamp) {
      foreach ($k in @($state.Keys)) { Stop-NvMedia $state[$k].Media }
      $state = @{}; $config = Read-FpConfig; $secrets = Read-FpSecrets; $configStamp = $stamp
      Log 'Configuracao recarregada.'
    }

    foreach ($cam in @($config.cameras)) {
      if (-not $state.ContainsKey($cam.id)) {
        $state[$cam.id] = @{ Media = $null; Failures = 0; NextAttempt = $now; StartedAt = $now; Status = 'aguardando'; State = 'starting'; DownSince = $null; LastMacScan = [datetime]::MinValue }
      }
      $e = $state[$cam.id]
      if ($blocked) { if ($e.Media) { Stop-NvMedia $e.Media; $e.Media = $null }; $e.Status = 'bloqueado pela central'; $e.State = 'down'; continue }

      if ($null -ne $e.Media) {
        if ($e.Media.HasExited -or $e.Media.IdleSeconds -gt 12) {
          $reason = $(if (-not $e.Media.HasExited) { 'sem progresso de video' } elseif ($e.Media.ErrorCategory) { $e.Media.ErrorCategory } else { 'processo encerrou' })
          Stop-NvMedia $e.Media; $e.Media = $null
          $e.Failures = [Math]::Min(6, $e.Failures + 1)
          # Senha errada: espera mais para nao bloquear a camera por tentativas.
          $delay = $(if ($reason -eq 'falha de autenticacao') { 30 } else { [Math]::Min(5, [Math]::Pow(2, $e.Failures)) })
          $e.NextAttempt = $now.AddSeconds($delay); $e.Status = 'reconectando: ' + $reason
          $e.State = $(if ($reason -eq 'falha de autenticacao') { 'down' } else { 'degraded' })
          if ($e.Failures -le 2) { Log ($cam.name + ': ' + $reason) }
        } elseif ($e.Media.HasProgress -and $e.Media.IdleSeconds -lt 5) {
          if ($e.State -ne 'ok') { Log ($cam.name + ': imagem recebida') }
          $e.Status = 'imagem recebida'; $e.State = 'ok'; $e.DownSince = $null
          if (($now - $e.StartedAt).TotalSeconds -gt 60) { $e.Failures = 0 }
        }
      }

      if ($null -eq $e.Media -and $now -ge $e.NextAttempt) {
        if ($cam.source -ne 'test' -and -not (Test-FpTcpPort $cam.host ([int]$cam.port) 800)) {
          # Camera fora da rede: sonda a cada 2 s e abre o FFmpeg assim que responder.
          if ($null -eq $e.DownSince) { $e.DownSince = $now }
          $e.Status = 'camera sem resposta em ' + $cam.host; $e.State = 'down'; $e.NextAttempt = $now.AddSeconds(2)
          if ($cam.mac -and ($now - $e.DownSince).TotalSeconds -gt 60 -and ($now - $e.LastMacScan).TotalMinutes -ge 5) {
            $e.LastMacScan = $now
            $found = Find-FpHostByMac $cam.mac
            if ($found -and $found -ne $cam.host) {
              Log ($cam.name + ': camera encontrada pelo MAC em ' + $found + ' (antes ' + $cam.host + ')')
              $cam.host = $found
              Save-FpConfig $config; $configStamp = (Get-Item -LiteralPath $paths.Config).LastWriteTimeUtc
              $e.NextAttempt = $now
            }
          }
        } else {
          try { $e.Media = Start-Publisher $cam $secrets; $e.StartedAt = $now; $e.Status = 'iniciando'; if ($e.State -eq 'down') { $e.State = 'starting' } }
          catch { $e.Failures = [Math]::Min(6, $e.Failures + 1); $e.NextAttempt = $now.AddSeconds(5); $e.Status = 'falha ao iniciar'; $e.State = 'down' }
        }
      }
    }

    # Gravacao: a cada 5 s confere com a central quais cameras gravam agora.
    if (-not $blocked -and $now -ge $nextRecordingSync) {
      $nextRecordingSync = $now.AddSeconds(5)
      try { $recordingStatus = Sync-FpRecordings $config $secrets.device_token $recording }
      catch { $recordingStatus = @{ state = 'degraded'; detail = 'erro na gravacao' }; Log ('Gravacao: ' + $_.Exception.Message) }
    }

    if (-not $blocked -and $now -ge $nextBackup) {
      $nextBackup = $now.AddMinutes(30)
      try { $backupStatus = Sync-FpBackup $config $secrets.device_token; if ($backupStatus.state -ne 'ok') { Log ('Backup: ' + $backupStatus.detail) } }
      catch { $backupStatus = @{ state = 'degraded'; detail = 'erro no backup' }; Log ('Backup: ' + $_.Exception.Message) }
    }

    if ($now -ge $nextHeartbeat) {
      $camStates = @(@($config.cameras) | ForEach-Object { $s = $state[$_.id]; @{ id = $_.id; state = $s.State; detail = [string]$s.Status } })
      $okCount = @($camStates | Where-Object { $_.state -eq 'ok' }).Count
      $tunnel = Get-Service -Name 'FicouPronto.Tunel' -ErrorAction SilentlyContinue
      $free = [math]::Round(((Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':'))).Free / 1GB), 1)
      $body = @{ agent_version = $paths.Version; clock = [datetime]::UtcNow.ToString('o'); recording = $recordingStatus; cameras = $camStates; components = @{
          service = @{ state = 'ok' }
          relay = @{ state = $(if (Test-FpTcpPort '127.0.0.1' 8554 500) { 'ok' } else { 'down' }) }
          tunnel = @{ state = $(if ($tunnel -and $tunnel.Status -eq 'Running') { 'ok' } else { 'down' }) }
          publisher = @{ state = $(if ($camStates.Count -eq 0) { 'unknown' } elseif ($okCount -eq $camStates.Count) { 'ok' } elseif ($okCount -gt 0) { 'degraded' } else { 'down' }) }
          disk = @{ state = $(if ($free -ge 5) { 'ok' } else { 'degraded' }); detail = ([string]$free + ' GB livres') }
          backup = @{ state = [string]$backupStatus.state; detail = [string]$backupStatus.detail }
        } }
      $r = Invoke-FpApi -Base $config.api_base -Method POST -Path '/api/connect/heartbeat' -Body $body -Token $secrets.device_token -TimeoutSec 15
      if ($r.Status -in @(401, 403)) { if (-not $blocked) { Log ('Central recusou o computador: ' + $r.Error) }; $blocked = $true; $nextHeartbeat = $now.AddSeconds(60) }
      else { if ($blocked -and $r.Ok) { Log 'Computador liberado pela central.' }; if ($r.Ok) { $blocked = $false }; $nextHeartbeat = $now.AddSeconds($heartbeatEvery) }
      $central = $(if ($r.Ok) { 'ok' } elseif ($blocked) { 'bloqueado' } else { 'sem conexao: ' + $r.Error })
    }
    # Estado local para a tela de manutencao (sem segredos).
    if ($now -ge $nextStatus) {
      $nextStatus = $now.AddSeconds(2)
      Write-NvJson $paths.Status @{ observed_at = $now.ToString('o'); version = $paths.Version; central = $central; recording = [string]$recordingStatus.detail; backup = [string]$backupStatus.detail
        recordings_free = $(try { [string][math]::Round(((Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':'))).Free / 1GB), 1) + ' GB livres no disco' } catch { '' })
        cameras = @(@($config.cameras) | ForEach-Object { $s = $state[$_.id]; @{ id = $_.id; name = $_.name; host = $_.host; state = $s.State; detail = [string]$s.Status } }) }
    }
    Start-Sleep -Milliseconds 1000
  }
} finally {
  foreach ($k in @($state.Keys)) { Stop-NvMedia $state[$k].Media }
  Log 'Agente encerrado.'
  if ($lock) { $lock.Dispose() }
}
