# Ficou Pronto - funcoes comuns do instalador e do servico (Windows PowerShell 5.1+).
# Regras: nenhuma senha/token em linha de comando, log ou relatorio; segredos ficam
# protegidos por DPAPI da maquina e em pasta acessivel so a SYSTEM e Administradores.
Set-StrictMode -Version 2.0

$script:InstallDir = Split-Path -Parent $PSScriptRoot
$script:BinDir = Join-Path $script:InstallDir 'bin'
$script:DataDir = Join-Path $env:ProgramData 'FicouPronto'
$script:SecretDir = Join-Path $script:DataDir 'secrets'
$script:ServiceDir = Join-Path $script:DataDir 'services'
$script:LogDir = Join-Path $script:DataDir 'logs'
$script:ConfigFile = Join-Path $script:DataDir 'config.json'
$script:SecretFile = Join-Path $script:SecretDir 'agent.dat'
$script:TunnelTokenFile = Join-Path $script:SecretDir 'tunnel.token'
$script:MediaMtxConfig = Join-Path $script:SecretDir 'mediamtx.yml'
$script:StatusFile = Join-Path $script:DataDir 'status.json'
$script:PilotStateFile = Join-Path $script:DataDir 'piloto-desativado.json'
$script:ReportFile = Join-Path $script:DataDir 'relatorio-instalacao.txt'
$script:Entropy = [Text.Encoding]::UTF8.GetBytes('ficoupronto-agent-v1')
$script:AgentVersion = '0.3.0'
$script:DefaultApi = 'https://app.ficoupronto.com'
$script:Services = @(
  @{ Id = 'FicouPronto.MediaMTX'; Name = 'Ficou Pronto - Video local (MediaMTX)' },
  @{ Id = 'FicouPronto.Tunel'; Name = 'Ficou Pronto - Tunel de video' },
  @{ Id = 'FicouPronto.Agente'; Name = 'Ficou Pronto - Agente das cameras' }
)

function Get-FpPaths {
  return [pscustomobject]@{ Install = $script:InstallDir; Bin = $script:BinDir; Data = $script:DataDir; Secrets = $script:SecretDir
    Services = $script:ServiceDir; Logs = $script:LogDir; Config = $script:ConfigFile; Status = $script:StatusFile; Report = $script:ReportFile
    PilotState = $script:PilotStateFile; Ffmpeg = (Join-Path $script:BinDir 'ffmpeg.exe'); MediaMtx = (Join-Path $script:BinDir 'mediamtx.exe')
    Cloudflared = (Join-Path $script:BinDir 'cloudflared.exe'); WinSW = (Join-Path $script:BinDir 'WinSW-x64.exe'); Version = $script:AgentVersion }
}

function Test-FpAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------- Pastas e segredos ----------
function Set-FpPrivateAcl([string]$Path) {
  # Somente SYSTEM e Administradores (SIDs, independe do idioma do Windows).
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $account = New-Object System.Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($account, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Initialize-FpDirectories {
  foreach ($d in @($script:DataDir, $script:SecretDir, $script:ServiceDir, $script:LogDir)) { [IO.Directory]::CreateDirectory($d) | Out-Null }
  Set-FpPrivateAcl $script:SecretDir
}

function Protect-FpBytes([byte[]]$Bytes) {
  Add-Type -AssemblyName System.Security
  return [Security.Cryptography.ProtectedData]::Protect($Bytes, $script:Entropy, [Security.Cryptography.DataProtectionScope]::LocalMachine)
}
function Unprotect-FpBytes([byte[]]$Bytes) {
  Add-Type -AssemblyName System.Security
  return [Security.Cryptography.ProtectedData]::Unprotect($Bytes, $script:Entropy, [Security.Cryptography.DataProtectionScope]::LocalMachine)
}

function Write-FpFileAtomic([string]$Path, [byte[]]$Bytes) {
  $tmp = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  try {
    [IO.File]::WriteAllBytes($tmp, $Bytes)
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [IO.File]::Move($tmp, $Path) }
  } finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
}

# Segredos: token do computador, senha de leitura do video e credenciais das cameras.
function Save-FpSecrets($Secrets) {
  $json = $Secrets | ConvertTo-Json -Depth 6 -Compress
  Write-FpFileAtomic $script:SecretFile (Protect-FpBytes ([Text.Encoding]::UTF8.GetBytes($json)))
}
function Read-FpSecrets {
  if (-not [IO.File]::Exists($script:SecretFile)) { return $null }
  $bytes = Unprotect-FpBytes ([IO.File]::ReadAllBytes($script:SecretFile))
  return ([Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json)
}

function Save-FpConfig($Config) {
  $json = $Config | ConvertTo-Json -Depth 8
  Write-FpFileAtomic $script:ConfigFile ([Text.UTF8Encoding]::new($false).GetBytes($json))
}
function Read-FpConfig {
  if (-not [IO.File]::Exists($script:ConfigFile)) { return $null }
  return ([IO.File]::ReadAllText($script:ConfigFile) | ConvertFrom-Json)
}

# ---------- API da central ----------
function Invoke-FpApi {
  param([string]$Base, [string]$Method = 'GET', [string]$Path, $Body, [string]$Token, [int]$TimeoutSec = 30)
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $headers = @{ 'User-Agent' = 'FicouPronto-Agent/' + $script:AgentVersion }
  if ($Token) { $headers['Authorization'] = 'Bearer ' + $Token }
  $params = @{ Uri = ($Base.TrimEnd('/') + $Path); Method = $Method; Headers = $headers; TimeoutSec = $TimeoutSec; UseBasicParsing = $true }
  if ($null -ne $Body) { $params['Body'] = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 8 -Compress)); $params['ContentType'] = 'application/json; charset=utf-8' }
  try {
    $r = Invoke-WebRequest @params
    $text = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
    return [pscustomobject]@{ Ok = $true; Status = [int]$r.StatusCode; Data = $(if ($text) { $text | ConvertFrom-Json } else { $null }); Error = '' }
  } catch {
    $status = 0; $message = 'Sem conexao com a central'
    $resp = $_.Exception.Response
    if ($null -ne $resp) {
      $status = [int]$resp.StatusCode
      try { $reader = New-Object IO.StreamReader($resp.GetResponseStream()); $e = $reader.ReadToEnd() | ConvertFrom-Json; if ($e.error) { $message = [string]$e.error } } catch { $message = 'Erro ' + $status }
    }
    return [pscustomobject]@{ Ok = $false; Status = $status; Data = $null; Error = $message }
  }
}

# ---------- Rede e cameras ----------
function Get-FpLocalNetwork {
  $cfg = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
  if (-not $cfg) { return $null }
  $ip = @($cfg.IPv4Address)[0].IPAddress
  return [pscustomobject]@{ Interface = $cfg.InterfaceAlias; IP = $ip; Gateway = @($cfg.IPv4DefaultGateway)[0].NextHop; Prefix = ($ip -replace '\.\d+$', '') }
}

function Format-FpMac([string]$Mac) { return (($Mac -replace '[^0-9A-Fa-f]', '').ToUpper() -replace '(..)(?!$)', '$1-') }

# Procura quem responde RTSP (porta 554) na faixa /24 do PC. Pode achar outros
# aparelhos (no piloto, o roteador ZTE tinha RTSP): o tecnico confirma pela imagem.
function Find-FpRtspHosts([int]$Port = 554, [int]$WaitMs = 3000) {
  $net = Get-FpLocalNetwork
  if (-not $net) { return @() }
  $probes = foreach ($i in 1..254) {
    $addr = $net.Prefix + '.' + $i
    if ($addr -eq $net.IP) { continue }
    $c = New-Object Net.Sockets.TcpClient
    [pscustomobject]@{ IP = $addr; Client = $c; Task = $c.ConnectAsync($addr, $Port) }
  }
  Start-Sleep -Milliseconds $WaitMs
  $found = @()
  foreach ($p in $probes) {
    if ($p.Task.Status -eq 'RanToCompletion') {
      $mac = ''
      $n = Get-NetNeighbor -IPAddress $p.IP -ErrorAction SilentlyContinue | Where-Object { $_.LinkLayerAddress -and $_.LinkLayerAddress -ne '00-00-00-00-00-00' } | Select-Object -First 1
      if ($n) { $mac = Format-FpMac $n.LinkLayerAddress }
      $found += [pscustomobject]@{ IP = $p.IP; MAC = $mac; Gateway = ($p.IP -eq $net.Gateway) }
    }
    try { $p.Client.Dispose() } catch { }
  }
  return $found
}

# Reencontra a camera pelo MAC quando o IP muda (sem depender de reserva no roteador).
function Find-FpHostByMac([string]$Mac) {
  $target = Format-FpMac $Mac
  if (-not $target) { return $null }
  $known = Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { (Format-FpMac $_.LinkLayerAddress) -eq $target -and $_.State -ne 'Unreachable' } | Select-Object -First 1
  if ($known) { return $known.IPAddress }
  foreach ($h in (Find-FpRtspHosts)) { if ($h.MAC -eq $target) { return $h.IP } }
  return $null
}

function Test-FpTcpPort([string]$HostName, [int]$Port, [int]$TimeoutMs = 1500) {
  $c = New-Object Net.Sockets.TcpClient
  try { $t = $c.ConnectAsync($HostName, $Port); return ($t.Wait($TimeoutMs) -and $c.Connected) } catch { return $false } finally { $c.Dispose() }
}

function New-FpRtspUrl([string]$HostName, [int]$Port, [string]$Path, [string]$User, [string]$Password) {
  if ($Path -notmatch '^/[A-Za-z0-9_./-]{0,120}$') { throw 'Caminho RTSP invalido.' }
  return (New-NvRtspUrl ('rtsp://' + $HostName + ':' + $Port + $Path) $User $Password)
}

# Captura uma foto da camera para o tecnico confirmar que e a camera certa.
function Get-FpSnapshot([string]$Url, [string]$Transport, [string]$OutFile, [int]$TimeoutSec = 12) {
  $p = Get-FpPaths
  if ([IO.File]::Exists($OutFile)) { [IO.File]::Delete($OutFile) }
  $ffArgs = @('-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'pipe,rtsp,rtsps,tcp,tls,udp,rtp,crypto',
    '-i', 'pipe:0', '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=640:-2', '-y', $OutFile)
  $m = [NextVision.MediaProcess]::new($p.Ffmpeg, $ffArgs, (New-NvConcatInput $Url $Transport))
  try {
    $ok = $m.Process.WaitForExit($TimeoutSec * 1000) -and $m.ExitCode -eq 0 -and [IO.File]::Exists($OutFile)
    return [pscustomobject]@{ Ok = [bool]$ok; Error = $(if ($ok) { '' } elseif ($m.ErrorCategory) { $m.ErrorCategory } else { 'sem imagem' }) }
  } finally { $m.Dispose() }
}

# ---------- Firewall ----------
function Set-FpFirewall {
  $ffmpeg = (Get-FpPaths).Ffmpeg
  Get-NetFirewallRule -DisplayName 'Ficou Pronto FFmpeg (camera UDP)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName 'Ficou Pronto FFmpeg (camera UDP)' -Direction Inbound -Program $ffmpeg -Protocol UDP -Action Allow -Profile Any | Out-Null
}
function Remove-FpFirewall { Get-NetFirewallRule -DisplayName 'Ficou Pronto FFmpeg (camera UDP)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule }

# ---------- MediaMTX e tunel ----------
function Write-FpMediaMtxConfig([string]$User, [string]$Password) {
  if ($User -notmatch '^[a-z0-9_-]{3,40}$' -or $Password -match '[\r\n''"]' -or $Password.Length -lt 12) { throw 'Credencial de video invalida recebida da central.' }
  $yml = @"
logLevel: warn
rtspAddress: 127.0.0.1:8554
rtmp: no
webrtc: no
srt: no
hlsAddress: 127.0.0.1:8888
authInternalUsers:
- user: any
  ips: ['127.0.0.1', '::1']
  permissions:
  - action: publish
- user: $User
  pass: '$Password'
  permissions:
  - action: read
paths:
  all_others:
    source: publisher
"@
  Write-FpFileAtomic $script:MediaMtxConfig ([Text.UTF8Encoding]::new($false).GetBytes($yml))
}
function Write-FpTunnelToken([string]$Token) {
  if ($Token -notmatch '^[A-Za-z0-9_\-+/=]{40,4000}$') { throw 'Token do tunel invalido recebido da central.' }
  Write-FpFileAtomic $script:TunnelTokenFile ([Text.Encoding]::ASCII.GetBytes($Token))
}

# ---------- Servicos do Windows (WinSW, conta SYSTEM, antes do login) ----------
function Get-FpServiceDefinition([string]$Id) {
  $p = Get-FpPaths
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  switch ($Id) {
    'FicouPronto.MediaMTX' { return @{ Exe = $p.MediaMtx; Args = ('"' + $script:MediaMtxConfig + '"') } }
    'FicouPronto.Tunel' { return @{ Exe = $p.Cloudflared; Args = ('tunnel --no-autoupdate --loglevel warn run --token-file "' + $script:TunnelTokenFile + '"') } }
    'FicouPronto.Agente' { return @{ Exe = $ps; Args = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $script:InstallDir 'agent\ficoupronto-agent.ps1') + '"') } }
  }
  throw 'Servico desconhecido.'
}

function Install-FpService([string]$Id, [string]$DisplayName) {
  $p = Get-FpPaths
  $def = Get-FpServiceDefinition $Id
  $exe = Join-Path $script:ServiceDir ($Id + '.exe')
  $xmlPath = Join-Path $script:ServiceDir ($Id + '.xml')
  $existing = Get-Service -Name $Id -ErrorAction SilentlyContinue
  if ($existing) { if ($existing.Status -ne 'Stopped') { Stop-Service -Name $Id -Force -ErrorAction SilentlyContinue }; & $exe uninstall | Out-Null; Start-Sleep -Seconds 1 }
  Copy-Item -LiteralPath $p.WinSW -Destination $exe -Force
  $esc = { param($s) [Security.SecurityElement]::Escape($s) }
  $xml = @"
<service>
  <id>$Id</id>
  <name>$(& $esc $DisplayName)</name>
  <description>Ficou Pronto: transmissao das cameras da loja. Inicia antes do login.</description>
  <executable>$(& $esc $def.Exe)</executable>
  <arguments>$(& $esc $def.Args)</arguments>
  <workingdirectory>$(& $esc $script:DataDir)</workingdirectory>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>$(& $esc $script:LogDir)</logpath>
  <log mode="roll-by-size"><sizeThreshold>2048</sizeThreshold><keepFiles>3</keepFiles></log>
</service>
"@
  [IO.File]::WriteAllText($xmlPath, $xml, [Text.UTF8Encoding]::new($false))
  $out = & $exe install 2>&1
  if (-not (Get-Service -Name $Id -ErrorAction SilentlyContinue)) { throw ('Nao foi possivel instalar o servico ' + $Id + ': ' + ($out | Out-String).Trim()) }
  # Reinicio tambem se o processo sair com sucesso (WinSW cuida de falhas).
  & sc.exe failureflag $Id 1 | Out-Null
}

function Start-FpServices { foreach ($s in $script:Services) { Start-Service -Name $s.Id -ErrorAction Stop } }
function Stop-FpServices { foreach ($s in [array]$script:Services | Sort-Object { $_.Id } -Descending) { Stop-Service -Name $s.Id -Force -ErrorAction SilentlyContinue } }
function Install-FpServices { foreach ($s in $script:Services) { Install-FpService $s.Id $s.Name } }
function Uninstall-FpServices {
  foreach ($s in $script:Services) {
    $exe = Join-Path $script:ServiceDir ($s.Id + '.exe')
    if (Get-Service -Name $s.Id -ErrorAction SilentlyContinue) { Stop-Service -Name $s.Id -Force -ErrorAction SilentlyContinue; if ([IO.File]::Exists($exe)) { & $exe uninstall | Out-Null } else { & sc.exe delete $s.Id | Out-Null } }
  }
}
function Get-FpServiceStates {
  return @($script:Services | ForEach-Object { $svc = Get-Service -Name $_.Id -ErrorAction SilentlyContinue
    [pscustomobject]@{ Id = $_.Id; Name = $_.Name; Status = $(if ($svc) { [string]$svc.Status } else { 'Ausente' }) } })
}

# ---------- Instalacao anterior (piloto em PowerShell) ----------
# Detecta o que o roteiro manual deixou: tarefa do supervisor (por usuario),
# tarefa "NextVision MediaMTX" (SYSTEM) e o servico "Cloudflared" do instalador MSI.
function Get-FpPilotInstall {
  $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'NextVisionPilotPublisher-*' -or $_.TaskName -eq 'NextVision MediaMTX' -or $_.TaskName -like 'NextVisionConnect*' })
  $cf = Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue
  $source = Join-Path $env:LOCALAPPDATA 'NextVisionPilotRecovery\source.dpapi'
  return [pscustomobject]@{ Found = ($tasks.Count -gt 0 -or $null -ne $cf); Tasks = @($tasks | ForEach-Object { $_.TaskName }); CloudflaredService = ($null -ne $cf)
    SourceFile = $(if (Test-Path -LiteralPath $source) { $source } else { '' }) }
}

# Le a camera ja configurada no piloto (protegida para este usuario Windows).
function Read-FpPilotCamera([string]$SourceFile) {
  $secure = (Get-Content -LiteralPath $SourceFile -Raw).Trim() | ConvertTo-SecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $cfg = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) | ConvertFrom-Json } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  $u = [uri]$cfg.url
  $user = ''; $pass = ''
  if ($u.UserInfo) { $parts = $u.UserInfo.Split(':', 2); $user = [uri]::UnescapeDataString($parts[0]); if ($parts.Count -gt 1) { $pass = [uri]::UnescapeDataString($parts[1]) } }
  return [pscustomobject]@{ Host = $u.Host; Port = $(if ($u.Port -gt 0) { $u.Port } else { 554 }); Path = $u.AbsolutePath; User = $user; Password = $pass; Transport = [string]$cfg.transport }
}

# Desativa (sem apagar) o piloto e guarda o que foi feito para "Voltar ao piloto".
function Disable-FpPilot($Pilot) {
  $state = @{ disabled_at = [datetime]::UtcNow.ToString('o'); tasks = @(); cloudflared_service = $false; user_dirs = @() }
  foreach ($dir in @(Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'AppData\Local\NextVisionPilotRecovery' } | Where-Object { Test-Path $_ })) {
    [IO.File]::WriteAllText((Join-Path $dir 'stop.request'), 'ficoupronto'); $state.user_dirs += $dir
  }
  foreach ($t in $Pilot.Tasks) {
    $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if ($task) { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue; Disable-ScheduledTask -TaskName $t | Out-Null; $state.tasks += $t }
  }
  if ($Pilot.CloudflaredService) { Stop-Service -Name 'Cloudflared' -Force -ErrorAction SilentlyContinue; Set-Service -Name 'Cloudflared' -StartupType Disabled; $state.cloudflared_service = $true }
  # Encerra processos antigos que ainda seguram as portas ou a camera (fora da pasta do produto).
  $mine = (Get-FpPaths).Bin
  Start-Sleep -Seconds 3
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*nextvision-pilot.ps1*' -or $_.CommandLine -like '*nextvision-connect.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($name in @('ffmpeg.exe', 'mediamtx.exe', 'cloudflared.exe')) {
    Get-CimInstance Win32_Process -Filter ("Name='" + $name + "'") -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and -not $_.ExecutablePath.StartsWith($mine, [StringComparison]::OrdinalIgnoreCase) -and ($_.ExecutablePath -match '\\WinGet\\|\\cloudflared\\|\\mediamtx') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  [IO.File]::WriteAllText($script:PilotStateFile, ($state | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
  return $state
}

function Restore-FpPilot {
  if (-not (Test-Path -LiteralPath $script:PilotStateFile)) { throw 'Nao ha piloto desativado por este instalador.' }
  $state = Get-Content -LiteralPath $script:PilotStateFile -Raw | ConvertFrom-Json
  Stop-FpServices
  foreach ($dir in @($state.user_dirs)) { $f = Join-Path $dir 'stop.request'; if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }
  if ($state.cloudflared_service) { Set-Service -Name 'Cloudflared' -StartupType Automatic; Start-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue }
  foreach ($t in @($state.tasks)) { Enable-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue | Out-Null; Start-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
  foreach ($s in $script:Services) { Set-Service -Name $s.Id -StartupType Disabled -ErrorAction SilentlyContinue }
}

# ---------- Testes do caminho do video ----------
# HttpClient sem redirecionamento automatico: o MediaMTX responde 302 e o
# Invoke-WebRequest do PowerShell 5.1 perde a senha no redirecionamento.
function Test-FpHls([string]$Url, [string]$User, [string]$Password, [int]$TimeoutSec = 10) {
  Add-Type -AssemblyName System.Net.Http
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $handler = New-Object Net.Http.HttpClientHandler; $handler.AllowAutoRedirect = $false
  $client = New-Object Net.Http.HttpClient($handler); $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
  $auth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($User + ':' + $Password))
  try {
    $target = [uri]$Url
    for ($i = 0; $i -lt 4; $i++) {
      $req = New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Get, $target)
      $req.Headers.TryAddWithoutValidation('Authorization', $auth) | Out-Null
      $res = $client.SendAsync($req).GetAwaiter().GetResult()
      $code = [int]$res.StatusCode
      if ($code -ge 300 -and $code -lt 400 -and $res.Headers.Location) { $target = New-Object Uri($target, $res.Headers.Location); continue }
      $body = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      return [pscustomobject]@{ Status = $code; Ok = ($code -eq 200 -and $body.StartsWith('#EXTM3U')) }
    }
    return [pscustomobject]@{ Status = 310; Ok = $false }
  } catch { return [pscustomobject]@{ Status = 0; Ok = $false } }
  finally { $client.Dispose() }
}

Export-ModuleMember -Function *-Fp*
