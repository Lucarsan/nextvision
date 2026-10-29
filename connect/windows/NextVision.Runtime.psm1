Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'NextVision.Core.psm1')
function New-NvRuntimeState {
  return @{Relay=$null;Tunnel=$null;RelayGeneration=0;RelaySignature='';TunnelSignature='';
    RelayFailures=0;TunnelFailures=0;RelayRetry=[datetime]::MinValue;TunnelRetry=[datetime]::MinValue;
    RelayStarted=[datetime]::MinValue;TunnelHealthySince=[datetime]::MinValue;ControlPassword='';RelayError='';Status='externo'}
}
function New-NvControlSecret {
  $bytes=New-Object byte[] 32
  $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes)
}
function Assert-NvLocalPortAvailable([int]$Port) {
  # A bind probe incorrectly treats sockets in TIME_WAIT as active listeners.
  # Check for a listening service; MediaMTX still validates its own actual bind.
  $client=[Net.Sockets.TcpClient]::new()
  try {
    $pending=$client.BeginConnect([Net.IPAddress]::Loopback,$Port,$null,$null)
    if (-not $pending.AsyncWaitHandle.WaitOne(300)) { throw 'Nao foi possivel confirmar o estado da porta local.' }
    try { $client.EndConnect($pending) }
    catch [Net.Sockets.SocketException] {
      if ($_.Exception.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return }
      throw 'Nao foi possivel confirmar o estado da porta local.'
    }
    throw 'Porta local em uso. Encerre o servico externo correspondente antes de ativar o gerenciamento.'
  } finally { $client.Dispose() }
}
function Get-NvSignature([string]$Value) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try { return [Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))) }
  finally { $sha.Dispose() }
}
function Assert-NvTunnelHostname([string]$Hostname) {
  if ($Hostname.Length -gt 253 -or $Hostname -notmatch '^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$' -or
      $Hostname -match '(^|\.)trycloudflare\.com$') { throw 'Use o hostname fixo do tunel nomeado, sem https, porta ou caminho. Quick Tunnel nao e aceito neste modo.' }
}
function Invoke-NvLoopback {
  param([ValidateSet('GET','POST','DELETE')][string]$Method,[int]$Port,[string]$Path,[string]$Authorization='', $Payload=$null,[switch]$IgnoreBody)
  if ($Port -lt 1024 -or $Port -gt 65535 -or -not $Path.StartsWith('/')) { throw 'Endpoint local invalido.' }
  $request=[Net.HttpWebRequest]::Create(('http://127.0.0.1:'+$Port+$Path))
  $request.Proxy=$null # Loopback only; never bypass the network proxy for external destinations.
  $request.AllowAutoRedirect=$false;$request.Method=$Method;$request.Timeout=2000;$request.ReadWriteTimeout=2000
  if ($Authorization) { $request.Headers['Authorization']=$Authorization }
  if ($null -ne $Payload) {
    $bytes=[Text.Encoding]::UTF8.GetBytes(($Payload|ConvertTo-Json -Depth 10 -Compress))
    $request.ContentType='application/json';$request.ContentLength=$bytes.Length
    $stream=$request.GetRequestStream();try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
  }
  $response=$null
  try {
    $response=$request.GetResponse()
    if ([int]$response.StatusCode -ne 200) { throw 'Servico local nao esta pronto.' }
    $reader=New-Object IO.StreamReader($response.GetResponseStream())
    try { $body=$reader.ReadToEnd() } finally { $reader.Dispose() }
    if ($body -and -not $IgnoreBody) { return $body|ConvertFrom-Json }
  } finally { if ($null -ne $response) { $response.Dispose() } }
}
function Stop-NvRuntimeTunnel($State) {
  if ($null -ne $State.Tunnel) { Stop-NvMedia $State.Tunnel;$State.Tunnel=$null }
  $State.TunnelHealthySince=[datetime]::MinValue
}
function Stop-NvRuntimeRelay($State) {
  Stop-NvRuntimeTunnel $State
  if ($null -ne $State.Relay) { Stop-NvMedia $State.Relay;$State.Relay=$null;$State.RelayGeneration++ }
  $State.ControlPassword=''
}
function Stop-NvRuntime($State) { Stop-NvRuntimeRelay $State;$State.Status='interrompido' }
function Set-NvRuntimeBackoff($State,[ValidateSet('Relay','Tunnel')][string]$Service,[datetime]$Now) {
  $State[$Service+'Failures']=[Math]::Min(6,$State[$Service+'Failures']+1)
  $State[$Service+'Retry']=$Now.AddSeconds([Math]::Min(60,[Math]::Pow(2,$State[$Service+'Failures'])))
}
function Sync-NvRuntime {
  param($State,$Config,[array]$Paths,[string]$Directory,[string]$ReaderUsername,[string]$ReaderPassword,[datetime]$Now=[datetime]::UtcNow)
  if ($null -eq $Config) {
    Stop-NvRuntime $State;$State.Status='externo'
    return @{RelayReady=$true;TunnelReady=$null;Generation=$State.RelayGeneration;Status='externo'}
  }
  $approved=@($Paths|Sort-Object -Unique)
  foreach ($path in $approved) { if ($path -notmatch '^(camera|camera_[a-fA-F0-9-]{36})$') { throw 'Caminho local nao autorizado.' } }
  if (-not $ReaderUsername -or -not $ReaderPassword -or $ReaderUsername -in @('any','nvctl')) { throw 'Configure uma credencial de leitura nao vazia e exclusiva.' }
  if (-not [IO.Path]::IsPathRooted($Config.relay_binary) -or -not [IO.File]::Exists($Config.relay_binary)) { throw 'MediaMTX local nao encontrado.' }
  if ($Config.tunnel_enabled) {
    Assert-NvTunnelHostname $Config.tunnel_hostname
    if (-not $Config.tunnel_token -or -not [IO.Path]::IsPathRooted($Config.tunnel_binary) -or -not [IO.File]::Exists($Config.tunnel_binary)) { throw 'Tunel nomeado incompleto.' }
  }
  if ($approved.Count -eq 0) {
    Stop-NvRuntime $State;$State.Status='sem fontes autorizadas'
    return @{RelayReady=$false;TunnelReady=$false;Generation=$State.RelayGeneration;Status=$State.Status}
  }
  $relaySignature=Get-NvSignature ($Config.relay_binary+'|'+$ReaderUsername+'|'+$ReaderPassword)
  if ($State.RelaySignature -ne $relaySignature) {
    Stop-NvRuntimeRelay $State;$State.RelaySignature=$relaySignature;$State.RelayRetry=$Now;$State.RelayFailures=0
  }
  if ($null -ne $State.Relay -and $State.Relay.HasExited) { Stop-NvRuntimeRelay $State;$State.RelayError='processo encerrou';Set-NvRuntimeBackoff $State 'Relay' $Now }
  if ($null -eq $State.Relay -and $Now -ge $State.RelayRetry) {
    try {
      foreach ($port in @(8554,8888,9997)) { Assert-NvLocalPortAvailable $port }
      [IO.Directory]::CreateDirectory($Directory)|Out-Null
      $file=Join-Path $Directory 'mediamtx.generated.json'
      # No wildcard paths and no credentials on disk. All listeners are loopback.
      Write-NvJson $file @{logLevel='error';rtspAddress='127.0.0.1:8554';rtspTransports=@('tcp');
        rtmp=$false;webrtc=$false;srt=$false;moq=$false;api=$true;apiAddress='127.0.0.1:9997';
        hlsAddress='127.0.0.1:8888';hlsAlwaysRemux=$true;hlsVariant='mpegts';authMethod='internal';authInternalUsers=@();paths=@{}}
      $State.ControlPassword=New-NvControlSecret
      # MediaMTX 1.21.3 expects indexed environment keys for slices of structs;
      # an AUTHINTERNALUSERS JSON string is silently ignored by its loader.
      $environment=@{
        MTX_AUTHINTERNALUSERS_0_USER='any';MTX_AUTHINTERNALUSERS_0_IPS='127.0.0.1';MTX_AUTHINTERNALUSERS_0_PERMISSIONS_0_ACTION='publish';
        MTX_AUTHINTERNALUSERS_1_USER=$ReaderUsername;MTX_AUTHINTERNALUSERS_1_PASS=$ReaderPassword;MTX_AUTHINTERNALUSERS_1_PERMISSIONS_0_ACTION='read';
        MTX_AUTHINTERNALUSERS_2_USER='nvctl';MTX_AUTHINTERNALUSERS_2_PASS=$State.ControlPassword;MTX_AUTHINTERNALUSERS_2_IPS='127.0.0.1';MTX_AUTHINTERNALUSERS_2_PERMISSIONS_0_ACTION='api'
      }
      $State.Relay=[NextVision.MediaProcess]::new($Config.relay_binary,@($file),'',$environment)
      $State.RelayStarted=$Now;$State.RelayGeneration++
    } catch {
      $State.RelayError=$(if ($_.Exception.Message -like 'Porta local em uso*') {'porta em uso'} else {'falha ao iniciar'})
      Stop-NvRuntimeRelay $State;Set-NvRuntimeBackoff $State 'Relay' $Now
    }
  }
  $relayReady=$false
  if ($null -ne $State.Relay -and -not $State.Relay.HasExited) {
    try {
      $auth='Basic '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(('nvctl:'+$State.ControlPassword)))
      $current=Invoke-NvLoopback 'GET' 9997 '/v3/config/paths/list?itemsPerPage=200' $auth
      $currentPaths=@($current.items|ForEach-Object { $_.name })
      foreach ($path in $currentPaths) { if ($path -notin $approved) { Invoke-NvLoopback 'DELETE' 9997 ('/v3/config/paths/delete/'+[uri]::EscapeDataString($path)) $auth|Out-Null } }
      foreach ($path in $approved) { if ($path -notin $currentPaths) { Invoke-NvLoopback 'POST' 9997 ('/v3/config/paths/add/'+$path) $auth @{source='publisher'}|Out-Null } }
      $relayReady=$true
      $State.RelayError=''
      if (($Now-$State.RelayStarted).TotalSeconds -gt 60) { $State.RelayFailures=0 }
    } catch {
      $State.RelayError='controle local indisponivel'
      # Allow a short startup period. After that stop the owned process only;
      # a different service already on these ports must never be adopted/killed.
      if (($Now-$State.RelayStarted).TotalSeconds -gt 10) { Stop-NvRuntimeRelay $State;Set-NvRuntimeBackoff $State 'Relay' $Now }
    }
  }
  if (-not $relayReady) {
    Stop-NvRuntimeTunnel $State;$State.Status=('relay iniciando/reconectando: '+$State.RelayError)
    return @{RelayReady=$false;TunnelReady=$false;Generation=$State.RelayGeneration;Status=$State.Status}
  }
  if (-not $Config.tunnel_enabled) {
    Stop-NvRuntimeTunnel $State;$State.Status='relay pronto; tunel externo'
    return @{RelayReady=$true;TunnelReady=$null;Generation=$State.RelayGeneration;Status=$State.Status}
  }
  $tunnelSignature=Get-NvSignature ($Config.tunnel_binary+'|'+$Config.tunnel_hostname+'|'+$Config.tunnel_token)
  if ($State.TunnelSignature -ne $tunnelSignature) {
    Stop-NvRuntimeTunnel $State;$State.TunnelSignature=$tunnelSignature;$State.TunnelRetry=$Now;$State.TunnelFailures=0
  }
  if ($null -ne $State.Tunnel -and $State.Tunnel.HasExited) { Stop-NvRuntimeTunnel $State;Set-NvRuntimeBackoff $State 'Tunnel' $Now }
  if ($null -eq $State.Tunnel -and $Now -ge $State.TunnelRetry) {
    try {
      Assert-NvLocalPortAvailable 49312
      $tunnelFile=Join-Path $Directory 'cloudflared.generated.json'
      Write-NvJson $tunnelFile @{loglevel='error'}
      $arguments=@('tunnel','--config',$tunnelFile,'--no-autoupdate','--metrics','127.0.0.1:49312','run')
      $State.Tunnel=[NextVision.MediaProcess]::new($Config.tunnel_binary,$arguments,'',@{TUNNEL_TOKEN=$Config.tunnel_token})
      $State.TunnelStarted=$Now
    } catch { Stop-NvRuntimeTunnel $State;Set-NvRuntimeBackoff $State 'Tunnel' $Now }
  }
  $tunnelReady=$false
  if ($null -ne $State.Tunnel -and -not $State.Tunnel.HasExited) {
    try {
      Invoke-NvLoopback 'GET' 49312 '/ready' -IgnoreBody|Out-Null
      $tunnelReady=$true
      if ($State.TunnelHealthySince -eq [datetime]::MinValue) { $State.TunnelHealthySince=$Now }
      if (($Now-$State.TunnelHealthySince).TotalSeconds -gt 60) { $State.TunnelFailures=0 }
    } catch {
      $State.TunnelHealthySince=[datetime]::MinValue
      if (($Now-$State.TunnelStarted).TotalSeconds -gt 60) { Stop-NvRuntimeTunnel $State;Set-NvRuntimeBackoff $State 'Tunnel' $Now }
    }
  }
  $State.Status=$(if ($tunnelReady) {'relay pronto; conector conectado'} else {'relay pronto; tunel iniciando/reconectando'})
  return @{RelayReady=$true;TunnelReady=$tunnelReady;Generation=$State.RelayGeneration;Status=$State.Status}
}
Export-ModuleMember -Function *-Nv*
