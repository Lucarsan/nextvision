# Ficou Pronto - arquivos a distancia (roda como SYSTEM, aberto pelo agente quando a central tem pedido).
# Busca os pedidos da central um a um (listar pasta, receber arquivo, enviar arquivo) e sai depois de
# 2 minutos sem pedido. Processo separado: transferencia grande nao trava o video nem o sinal de vida.
param([int]$IdleSeconds = 120, [int]$PollSeconds = 3)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'FicouPronto.psm1') -Force
$paths = Get-FpPaths

$lock = $null
try { $lock = [IO.File]::Open((Join-Path $paths.Data 'remote.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { exit 0 }

function Log([string]$Text) {
  try { [IO.File]::AppendAllText((Join-Path $paths.Logs 'arquivos-remotos.log'), ([datetime]::Now.ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $Text + "`r`n")) } catch { }
}

try {
  $config = Read-FpConfig; $secrets = Read-FpSecrets
  if ($null -eq $config -or $null -eq $secrets) { Log 'Sem configuracao.'; exit 1 }
  $idleSince = [datetime]::UtcNow
  while (([datetime]::UtcNow - $idleSince).TotalSeconds -lt $IdleSeconds) {
    $r = Invoke-FpApi -Base $config.api_base -Method GET -Path '/api/connect/remote/next' -Token $secrets.device_token -TimeoutSec 30
    if (-not $r.Ok) { Log ('Central: ' + $r.Error); if ($r.Status -in @(401, 403)) { break }; Start-Sleep -Seconds 15; continue }
    if ($null -eq $r.Data -or -not $r.Data.PSObject.Properties['id']) { Start-Sleep -Seconds $PollSeconds; continue }
    $job = $r.Data
    Log ('Pedido ' + $job.kind + ' ' + $job.path)
    Log ('  ' + (Invoke-FpRemoteJob -Base $config.api_base -Token $secrets.device_token -Job $job))
    $idleSince = [datetime]::UtcNow
  }
} catch { Log ('Erro: ' + $_.Exception.Message) }
finally { if ($lock) { $lock.Dispose() } }
