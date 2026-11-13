# Ficou Pronto - atualizador do agente (roda como SYSTEM numa tarefa agendada separada).
# Recebe uma versao ja baixada e conferida pelo agente em ProgramData\FicouPronto\atualizacoes\<versao>\arquivos.
# Passos: guarda copia dos scripts atuais -> para o servico do agente -> troca os scripts ->
# religa -> espera a versao nova dar sinal (e as cameras que estavam com imagem voltarem) ->
# se nao der, devolve os scripts anteriores e religa. MediaMTX e tunel nao sao tocados.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$RequestId = '',
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [int]$VerifySeconds = 120,
  [string]$ServiceName = 'FicouPronto.Agente'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$data = Join-Path $env:ProgramData 'FicouPronto'
$updates = Join-Path $data 'atualizacoes'
$stateFile = Join-Path $updates 'estado.json'
$statusFile = Join-Path $data 'status.json'
$logFile = Join-Path (Join-Path $data 'logs') 'atualizacao.log'
$agentDir = Join-Path $InstallDir 'agent'
$staged = Join-Path (Join-Path $updates $Version) 'arquivos'
$backup = Join-Path $updates 'anterior'

function Log([string]$Text) {
  try { [void][IO.Directory]::CreateDirectory((Split-Path -Parent $logFile)); [IO.File]::AppendAllText($logFile, ([datetime]::Now.ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $Text + "`r`n")) } catch { }
}
function Set-State([string]$State, [string]$Detail, [string]$From) {
  $o = [ordered]@{ version = $Version; request_id = $RequestId; state = $State; detail = $Detail; from = $From; at = [datetime]::UtcNow.ToString('o') }
  $tmp = $stateFile + '.tmp'
  [IO.File]::WriteAllText($tmp, ($o | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tmp -Destination $stateFile -Force
  Log ($State + ': ' + $Detail)
}
function Read-Status { try { return ([IO.File]::ReadAllText($statusFile) | ConvertFrom-Json) } catch { return $null } }
function Get-OkCameras($St) { if ($null -eq $St -or -not ($St.PSObject.Properties['cameras'])) { return 0 }; return @(@($St.cameras) | Where-Object { $_.state -eq 'ok' }).Count }
function Stop-Agent {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 30; $i++) { $s = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue; if ($null -eq $s -or $s.Status -eq 'Stopped') { return }; Start-Sleep -Seconds 1 }
  throw 'o servico do agente nao parou'
}
function Start-Agent { Start-Service -Name $ServiceName -ErrorAction Stop }
function Copy-Files([string]$From, [string]$To) {
  foreach ($f in [IO.Directory]::GetFiles($From)) { Copy-Item -LiteralPath $f -Destination (Join-Path $To ([IO.Path]::GetFileName($f))) -Force }
  try { Get-ChildItem -LiteralPath $To -File | Unblock-File -ErrorAction SilentlyContinue } catch { }
}
# Espera a versao certa dar sinal recente; e as cameras que estavam ok voltarem.
function Wait-Healthy([string]$Expected, [int]$OkBefore, [int]$Seconds) {
  $deadline = [datetime]::UtcNow.AddSeconds($Seconds); $last = 'sem sinal do agente'
  while ([datetime]::UtcNow -lt $deadline) {
    Start-Sleep -Seconds 2
    $st = Read-Status
    if ($null -eq $st) { continue }
    $age = $(try { ([datetime]::UtcNow - ([datetimeoffset]::Parse([string]$st.observed_at)).UtcDateTime).TotalSeconds } catch { 999 })
    if ([string]$st.version -ne $Expected) { $last = 'agente ainda na versao ' + $st.version; continue }
    if ($age -gt 15) { $last = 'agente parado'; continue }
    $ok = Get-OkCameras $st
    if ($ok -ge $OkBefore) { return @{ Ok = $true; Detail = ('agente ' + $Expected + ' rodando; ' + $ok + ' camera(s) com imagem') } }
    $last = 'cameras com imagem: ' + $ok + ' de ' + $OkBefore
  }
  return @{ Ok = $false; Detail = $last }
}

$lock = $null
try { [void][IO.Directory]::CreateDirectory($updates); $lock = [IO.File]::Open((Join-Path $updates 'atualizador.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { Log 'Outro atualizador ja esta rodando.'; exit 0 }

$before = Read-Status
$from = $(if ($before) { [string]$before.version } else { '' })
$okBefore = Get-OkCameras $before
$changed = $false
try {
  if (-not [IO.Directory]::Exists($staged)) { throw ('pacote ' + $Version + ' nao preparado') }
  Set-State 'installing' ('instalando ' + $Version + ' (antes ' + $from + ')') $from
  if ([IO.Directory]::Exists($backup)) { Remove-Item -LiteralPath $backup -Recurse -Force }
  [void][IO.Directory]::CreateDirectory($backup)
  Copy-Files $agentDir $backup
  Stop-Agent
  $changed = $true
  Copy-Files $staged $agentDir
  Start-Agent
  $h = Wait-Healthy $Version $okBefore $VerifySeconds
  if (-not $h.Ok) { throw ('versao nova nao confirmou: ' + $h.Detail) }
  Set-State 'done' $h.Detail $from
  exit 0
} catch {
  $why = $_.Exception.Message
  if (-not $changed) { Set-State 'failed' $why $from; exit 1 }
  try {
    Log ('Desfazendo: ' + $why)
    Stop-Agent
    foreach ($f in [IO.Directory]::GetFiles($agentDir)) { Remove-Item -LiteralPath $f -Force }
    Copy-Files $backup $agentDir
    Start-Agent
    $h = Wait-Healthy $from 0 $VerifySeconds
    Set-State 'rolled_back' ($why + ' | voltou para ' + $from + $(if ($h.Ok) { '' } else { ' (' + $h.Detail + ')' })) $from
  } catch {
    try { Start-Agent } catch { }
    Set-State 'failed' ($why + ' | erro ao desfazer: ' + $_.Exception.Message) $from
  }
  exit 1
} finally {
  try { Unregister-ScheduledTask -TaskName 'FicouPronto.Atualizacao' -Confirm:$false -ErrorAction SilentlyContinue } catch { }
  if ($lock) { $lock.Dispose() }
}
