# Ficou Pronto - ponte local do navegador (roda como SYSTEM, aberta e vigiada pelo agente).
# Escuta so em http://127.0.0.1:47833 (nao aparece na rede). Atende so paginas do Ficou Pronto
# (*.ficoupronto.com) e do endereco proprio da rede desta unidade, que a central informa.
#   GET  /ping  -> { ok, app, version }            (o navegador sabe que o agente esta ligado)
#   POST /proof -> { proof }                        (prova de uso unico para o login neste PC)
# A prova vem da central, pedida com a credencial do PC (que nunca sai daqui). Sozinha ela nao abre
# nada: o login ainda exige a senha. Serve para a rede com "acesso so no computador da unidade".
# Sai sozinha quando o agente que a abriu termina (atualizacao, parada do servico).
param([int]$Port = 47833, [int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'FicouPronto.psm1') -Force
$paths = Get-FpPaths

$lock = $null
try { $lock = [IO.File]::Open((Join-Path $paths.Data 'bridge.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { exit 0 }

function Log([string]$Text) {
  try { [IO.File]::AppendAllText((Join-Path $paths.Logs 'ponte-local.log'), ([datetime]::Now.ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $Text + "`r`n")) } catch { }
}

$script:origins = @(); $script:originsAt = [datetime]::MinValue
function Update-FpOrigins($Config, [string]$Token) {
  if (([datetime]::UtcNow - $script:originsAt).TotalMinutes -lt 10) { return }
  $script:originsAt = [datetime]::UtcNow
  $r = Invoke-FpApi -Base $Config.api_base -Method GET -Path '/api/connect/login-origins' -Token $Token -TimeoutSec 10
  if ($r.Ok -and $null -ne $r.Data -and $r.Data.PSObject.Properties['origins']) {
    $script:origins = @(@($r.Data.origins) | Where-Object { [string]$_ -match '^https://[a-z0-9.-]{3,253}$' } | ForEach-Object { ([string]$_).ToLowerInvariant() })
  } else { $script:originsAt = [datetime]::UtcNow.AddMinutes(-9) }
}
function Test-FpOrigin([string]$Origin) {
  if (-not $Origin) { return $false }
  $o = $Origin.ToLowerInvariant()
  if ($o -match '^https://([a-z0-9-]+\.)*ficoupronto\.com$') { return $true }
  return ($script:origins -contains $o)
}
function Send-FpJson($Ctx, [int]$Status, $Body, [string]$Origin) {
  $res = $Ctx.Response
  $res.StatusCode = $Status
  $res.Headers['Cache-Control'] = 'no-store'
  $res.Headers['Vary'] = 'Origin'
  if ($Origin) {
    $res.Headers['Access-Control-Allow-Origin'] = $Origin
    $res.Headers['Access-Control-Allow-Methods'] = 'GET, POST'
    $res.Headers['Access-Control-Allow-Headers'] = 'Content-Type'
    # Chrome: pagina publica pedindo a este computador (Private Network / Local Network Access).
    $res.Headers['Access-Control-Allow-Private-Network'] = 'true'
    $res.Headers['Access-Control-Max-Age'] = '600'
  }
  if ($null -ne $Body) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress))
    $res.ContentType = 'application/json; charset=utf-8'
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  }
  $res.Close()
}

$listener = $null
try {
  $config = Read-FpConfig; $secrets = Read-FpSecrets
  if ($null -eq $config -or $null -eq $secrets) { Log 'Sem configuracao.'; exit 1 }
  $token = [string]$secrets.device_token
  $listener = New-Object Net.HttpListener
  $listener.Prefixes.Add('http://127.0.0.1:' + $Port + '/')
  $listener.Start()
  Log ('Ponte local ligada na porta ' + $Port + '.')
  Update-FpOrigins $config $token
  $parentAlive = { if ($ParentPid -le 0) { return $true }; try { return -not (Get-Process -Id $ParentPid -ErrorAction Stop).HasExited } catch { return $false } }
  while ($listener.IsListening) {
    $async = $listener.BeginGetContext($null, $null)
    while (-not $async.AsyncWaitHandle.WaitOne(5000)) { if (-not (& $parentAlive)) { Log 'Agente encerrado; ponte local desligada.'; return } }
    $ctx = $listener.EndGetContext($async)
    try {
      $req = $ctx.Request
      $origin = [string]$req.Headers['Origin']
      $path = $req.Url.AbsolutePath
      if (-not $req.IsLocal) { Send-FpJson $ctx 403 @{ error = 'somente local' } ''; continue }
      Update-FpOrigins $config $token
      if (-not (Test-FpOrigin $origin)) { Send-FpJson $ctx 403 @{ error = 'origem nao permitida' } ''; continue }
      if ($req.HttpMethod -eq 'OPTIONS') { Send-FpJson $ctx 204 $null $origin; continue }
      if ($req.HttpMethod -eq 'GET' -and $path -eq '/ping') { Send-FpJson $ctx 200 @{ ok = $true; app = 'ficoupronto'; version = $paths.Version } $origin; continue }
      if ($req.HttpMethod -eq 'POST' -and $path -eq '/proof') {
        $r = Invoke-FpApi -Base $config.api_base -Method POST -Path '/api/connect/login-proof' -Token $token -TimeoutSec 15
        if ($r.Ok -and $null -ne $r.Data -and ([string]$r.Data.proof -match '^nvlp_[a-f0-9]{64}$')) { Send-FpJson $ctx 200 @{ proof = [string]$r.Data.proof } $origin }
        else { Log ('Prova recusada pela central: ' + $r.Error); Send-FpJson $ctx 502 @{ error = 'central recusou este computador' } $origin }
        continue
      }
      Send-FpJson $ctx 404 @{ error = 'nao encontrado' } $origin
    } catch {
      Log ('Pedido: ' + $_.Exception.Message)
      try { $ctx.Response.Abort() } catch { }
    }
  }
} catch { Log ('Erro: ' + $_.Exception.Message) }
finally {
  if ($listener) { try { $listener.Stop(); $listener.Close() } catch { } }
  if ($lock) { $lock.Dispose() }
}
