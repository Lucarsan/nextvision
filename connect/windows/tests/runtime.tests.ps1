$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot '../NextVision.Core.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../NextVision.Runtime.psm1') -Force
function Assert($Condition,[string]$Message='Assertion failed') { if (-not $Condition) { throw $Message } }
$script:passed=0
function Check([string]$Name,[scriptblock]$Body) { & $Body;$script:passed++;Write-Host "PASS $Name" }
function HttpStatus([int]$Port,[string]$Path,[string]$Credential='') {
  $request=[Net.HttpWebRequest]::Create(('http://127.0.0.1:'+$Port+$Path));$request.Proxy=$null;$request.Timeout=6000
  if ($Credential) { $request.Headers['Authorization']='Basic '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Credential)) }
  $response=$null
  try { $response=$request.GetResponse();return [int]$response.StatusCode }
  catch [Net.WebException] { if ($null -ne $_.Exception.Response) { $response=$_.Exception.Response;return [int]$response.StatusCode };throw }
  finally { if ($null -ne $response) { $response.Dispose() } }
}
$directory=Join-Path $env:NV_TEST_DIRECTORY 'managed services'
$state=New-NvRuntimeState;$publishers=New-NvSupervisor
$config=@{relay_binary=$env:MEDIAMTX_BINARY;tunnel_enabled=$false;tunnel_binary=$env:NV_FAKE_TUNNEL;tunnel_hostname='media.example.test';tunnel_token='synthetic-tunnel-token'}
$idA=[guid]::NewGuid().ToString();$idB=[guid]::NewGuid().ToString()
$pathA='camera_'+$idA;$pathB='camera_'+$idB
$script:paths=@($pathA)
function Tick([datetime]$Now=[datetime]::UtcNow) { Sync-NvRuntime $state $config $script:paths $directory 'reader' 'synthetic-reader-secret' $Now }
function AwaitRelay {
  for ($i=0;$i -lt 100;$i++) { $health=Tick;if ($health.RelayReady) { return $health };Start-Sleep -Milliseconds 100 }
  throw ('Managed relay did not become ready: '+$state.Status)
}
function AwaitFrames($Entry) {
  for ($i=0;$i -lt 200;$i++) { if ($Entry.Media.HasProgress -and -not $Entry.Media.HasExited) { return };Start-Sleep -Milliseconds 100 }
  throw 'Synthetic camera did not produce frames'
}
try {
  Check 'a named tunnel must have a fixed hostname' {
    Assert-NvTunnelHostname 'media.example.test'
    foreach ($bad in @('https://example.com','x.trycloudflare.com','localhost','example.com:8888','x.example.com/path')) {
      $rejected=$false;try { Assert-NvTunnelHostname $bad } catch { $rejected=$true };Assert $rejected
    }
  }
  Check 'a busy relay port is rejected without taking over the external listener' {
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,8554)
    $listener.Server.SetSocketOption([Net.Sockets.SocketOptionLevel]::Socket,[Net.Sockets.SocketOptionName]::ReuseAddress,$true)
    $listener.Start()
    try {
      $health=Tick;Assert (-not $health.RelayReady);Assert ($null -eq $state.Relay);Assert ($state.RelayFailures -eq 1)
      $probe=[Net.Sockets.TcpClient]::new();try { $probe.Connect('127.0.0.1',8554);Assert $probe.Connected } finally { $probe.Dispose() }
    } finally { $listener.Stop() }
    $state.RelayRetry=[datetime]::MinValue
  }
  Check 'real MediaMTX starts with authenticated API and HLS, no secrets on disk' {
    $health=AwaitRelay;Assert $health.RelayReady
    Assert ((HttpStatus 9997 '/v3/config/paths/list') -eq 401)
    Assert ((HttpStatus 9997 '/v3/config/paths/list' 'reader:synthetic-reader-secret') -ne 200)
    Assert ((HttpStatus 8888 ('/'+$pathA+'/index.m3u8?cookieCheck=1')) -eq 401)
    $text=Get-Content -LiteralPath (Join-Path $directory 'mediamtx.generated.json') -Raw
    Assert (-not $text.Contains('synthetic-reader-secret') -and -not $text.Contains($state.ControlPassword))
    $settings=$text|ConvertFrom-Json
    Assert ($settings.rtspAddress -eq '127.0.0.1:8554' -and $settings.apiAddress -eq '127.0.0.1:9997' -and $settings.hlsAddress -eq '127.0.0.1:8888')
    Assert (-not $state.Relay.Process.StartInfo.Arguments.Contains('synthetic-reader-secret'))
  }
  $desired=@(
    @{Id=$idA;Path=$pathA;Url=$env:NV_TEST_SOURCE_A;Transport='tcp';Revision='1'},
    @{Id=$idB;Path=$pathB;Url=$env:NV_TEST_SOURCE_B;Transport='tcp';Revision='1'}
  )
  Check 'adding an approved camera preserves the relay and the running camera' {
    Sync-NvPublishers $publishers @($desired[0]);AwaitFrames $publishers[$idA]
    $oldRelay=$state.Relay.Process.Id;$oldPublisher=$publishers[$idA].Media.Process.Id
    $script:paths=@($pathA,$pathB);$health=Tick;Assert $health.RelayReady
    Sync-NvPublishers $publishers $desired;AwaitFrames $publishers[$idB]
    Assert ($state.Relay.Process.Id -eq $oldRelay -and $publishers[$idA].Media.Process.Id -eq $oldPublisher)
    Assert (-not $publishers[$idA].Media.HasExited -and $publishers[$idA].Media.IdleSeconds -lt 5)
    Assert ((HttpStatus 8888 ('/'+$pathA+'/index.m3u8?cookieCheck=1') 'reader:synthetic-reader-secret') -eq 200)
  }
  Check 'removing one path leaves the other camera moving and denies the removed path' {
    $oldRelay=$state.Relay.Process.Id;$oldPublisher=$publishers[$idA].Media.Process.Id
    $script:paths=@($pathA);$health=Tick;Assert $health.RelayReady
    Sync-NvPublishers $publishers @($desired[0])
    Assert ($state.Relay.Process.Id -eq $oldRelay -and $publishers[$idA].Media.Process.Id -eq $oldPublisher) 'Removing B replaced relay or publisher A'
    Assert (-not $publishers[$idA].Media.HasExited) 'Removing B terminated publisher A'
    $removedStatus=HttpStatus 8888 ('/'+$pathB+'/index.m3u8?cookieCheck=1') 'reader:synthetic-reader-secret'
    # MediaMTX 1.21.3 can return 500 while its removed HLS muxer is closing.
    # Prove removal in the control API as well as denial of the video request.
    $auth='Basic '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(('nvctl:'+$state.ControlPassword)))
    $remaining=Invoke-NvLoopback 'GET' 9997 '/v3/config/paths/list' $auth
    Assert (@($remaining.items|Where-Object {$_.name -eq $pathB}).Count -eq 0) 'Removed path remains configured'
    Assert ($removedStatus -in @(404,500)) ('Removed HLS path unexpectedly returned HTTP '+$removedStatus)
  }
  Check 'an owned relay exit is detected and restarted with a fresh generation' {
    $old=$state.Relay.Process.Id;$generation=$state.RelayGeneration
    $state.Relay.Process.Kill();$state.Relay.Process.WaitForExit()
    $health=Tick;Assert (-not $health.RelayReady);Assert ($health.Generation -gt $generation)
    $state.RelayRetry=[datetime]::MinValue
    $health=AwaitRelay
    Assert ($health.RelayReady -and $state.Relay.Process.Id -ne $old)
    Stop-NvPublishers $publishers
  }
  Check 'named connector contract receives a token through its environment, not arguments or disk' {
    $config.tunnel_enabled=$true
    for ($i=0;$i -lt 40;$i++) { $health=Tick;if ($health.TunnelReady) { break };Start-Sleep -Milliseconds 100 }
    Assert $health.TunnelReady 'Fake connector readiness not detected'
    Assert (-not $state.Tunnel.Process.StartInfo.Arguments.Contains('synthetic-tunnel-token'))
    $text=Get-Content -LiteralPath (Join-Path $directory 'cloudflared.generated.json') -Raw
    Assert (-not $text.Contains('synthetic-tunnel-token'))
  }
  Check 'connector exit restarts only the connector' {
    $relayPid=$state.Relay.Process.Id;$old=$state.Tunnel.Process.Id
    $state.Tunnel.Process.Kill();$state.Tunnel.Process.WaitForExit()
    $health=Tick;Assert (-not $health.TunnelReady -and $health.RelayReady)
    $state.TunnelRetry=[datetime]::MinValue
    for ($i=0;$i -lt 40;$i++) { $health=Tick;if ($health.TunnelReady) { break };Start-Sleep -Milliseconds 100 }
    Assert ($health.TunnelReady -and $state.Tunnel.Process.Id -ne $old -and $state.Relay.Process.Id -eq $relayPid)
  }
  Check 'a living but disconnected connector is restarted without stopping the local relay' {
    $old=$state.Tunnel.Process.Id;$relayPid=$state.Relay.Process.Id
    $marker=Join-Path $env:NV_TEST_DIRECTORY 'connector-not-ready'
    [IO.File]::WriteAllText($marker,'offline')
    try {
      $health=Tick $state.TunnelStarted.AddSeconds(61)
      Assert (-not $health.TunnelReady -and $health.RelayReady -and $null -eq $state.Tunnel)
      Assert ($state.Relay.Process.Id -eq $relayPid)
    } finally { [IO.File]::Delete($marker) }
    $state.TunnelRetry=[datetime]::MinValue
    for ($i=0;$i -lt 40;$i++) { $health=Tick;if ($health.TunnelReady) { break };Start-Sleep -Milliseconds 100 }
    Assert ($health.TunnelReady -and $state.Tunnel.Process.Id -ne $old)
  }
  Check 'no authorized sources stops every owned runtime process' {
    $relayPid=$state.Relay.Process.Id;$tunnelPid=$state.Tunnel.Process.Id
    $script:paths=@();$health=Tick
    Assert (-not $health.RelayReady -and -not $health.TunnelReady)
    Assert ($null -eq (Get-Process -Id $relayPid -ErrorAction SilentlyContinue))
    Assert ($null -eq (Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue))
  }
  Check 'external mode preserves external lifecycle and authorization loss stops owned services' {
    $script:paths=@($pathA);$config.tunnel_enabled=$false;$health=AwaitRelay;Assert $health.RelayReady
    $pidOwned=$state.Relay.Process.Id
    Stop-NvRuntime $state
    Assert ($null -eq (Get-Process -Id $pidOwned -ErrorAction SilentlyContinue))
    $health=Sync-NvRuntime $state $null @() $directory '' ''
    Assert ($health.RelayReady -and $health.Status -eq 'externo')
  }
  Write-Host "$script:passed runtime checks passed."
} finally { Stop-NvPublishers $publishers;Stop-NvRuntime $state }
