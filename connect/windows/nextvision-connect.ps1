# NextVision Connect - piloto Windows / PowerShell 5.1+
# Uso: .\nextvision-connect.ps1 activate | run
param([ValidateSet('activate','run')][string]$Mode='run')
$ErrorActionPreference='Stop'
$Base='https://nextvision-mgx6.onrender.com'
$HomePath=Join-Path $env:LOCALAPPDATA 'NextVisionConnect'
$KeyFile=Join-Path $HomePath 'device-token.dpapi'
$Videos=Join-Path $HomePath 'recordings'
New-Item -ItemType Directory -Force -Path $HomePath,$Videos | Out-Null
function Request([string]$Method,[string]$Path,$Payload=$null){
  $Headers=@{}
  if(Test-Path $KeyFile){
    $Secret=Get-Content $KeyFile | ConvertTo-SecureString
    $B=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
    try{$Headers.Authorization='Bearer '+[Runtime.InteropServices.Marshal]::PtrToStringBSTR($B)}
    finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($B)}
  }
  $Args=@{Uri=($Base+$Path);Method=$Method;Headers=$Headers;TimeoutSec=15}
  if($null -ne $Payload){$Args.ContentType='application/json';$Args.Body=($Payload|ConvertTo-Json -Compress)}
  Invoke-RestMethod @Args
}
function Event($Id,$Action,$ErrorText=''){
  try{
    $p=@{event=$Action}
    if($ErrorText){$p.error=$ErrorText.Substring(0,[Math]::Min(300,$ErrorText.Length))}
    Request 'POST' ('/api/connect/recording-jobs/'+$Id+'/event') $p | Out-Null
  }catch{Write-Warning "Falha ao enviar evento $Action para $Id : $_"}
}
if($Mode -eq 'activate'){
  $Name=Read-Host 'Nome deste computador'
  $Code=Read-Host 'Codigo de ativacao gerado pelo painel Master'
  $Data=Request 'POST' '/api/connect/activate' @{activation_code=$Code;device_name=$Name}
  $Sec=ConvertTo-SecureString $Data.device_token -AsPlainText -Force
  ConvertFrom-SecureString $Sec | Set-Content -Path $KeyFile -Encoding Ascii
  Write-Host "Vinculado a loja $($Data.tenant_id), dispositivo $($Data.id). Credencial protegida com Windows DPAPI."
  exit
}
if(!(Test-Path $KeyFile)){throw 'Execute primeiro: .\nextvision-connect.ps1 activate'}
if(!(Get-Command ffmpeg -ErrorAction SilentlyContinue)){throw 'FFmpeg nao encontrado no PATH.'}
$Active=@{}
function Finalize($Id){
  $item=$Active[$Id]
  if(!$item){return}
  try{
    if(!$item.Process.HasExited){Stop-Process -Id $item.Process.Id -Force -ErrorAction SilentlyContinue}
    $item.Process.WaitForExit(5000) | Out-Null
    $mp4=Join-Path $Videos ($Id+'.mp4')
    $args=@('-hide_banner','-loglevel','error','-y','-i',$item.Raw,'-c','copy','-movflags','+faststart',$mp4)
    $proc=Start-Process -FilePath 'ffmpeg' -ArgumentList $args -PassThru -Wait -NoNewWindow
    if($proc.ExitCode -ne 0 -or !(Test-Path $mp4) -or (Get-Item $mp4).Length -lt 1024){throw 'Falha ao converter gravacao para MP4'}
    Event $Id 'stopped'
    Write-Host "MP4 finalizado: $mp4 (aguardando integracao de upload)"
  }catch{Event $Id 'failed' $_.Exception.Message;Write-Warning "Arquivo $Id : $_"}
  finally{$Active.Remove($Id)}
}
Write-Host 'NextVision Connect: monitorando gravações desta loja. Ctrl+C para sair.'
try{
  while($true){
    try{
      $res=Request 'GET' '/api/connect/recording-jobs'
      $Jobs=@($res.jobs | Where-Object {$null -ne $_})
      foreach($job in $Jobs){
        $id=[string]$job.recording_id
        if($job.status -eq 'pending' -and $job.order_status -eq 'live' -and $job.current_step -eq $job.step_index -and !$Active.ContainsKey($id)){
          $raw=Join-Path $Videos ($id+'.ts')
          try{
            # Captura a retransmissao local H.264 que ja esta funcionando; evita segunda sessao na Yoosee.
            $args=@('-hide_banner','-loglevel','error','-y','-rtsp_transport','tcp','-i','rtsp://127.0.0.1:8554/camera','-map','0:v:0','-an','-c:v','copy','-f','mpegts',$raw)
            $proc=Start-Process -FilePath 'ffmpeg' -ArgumentList $args -PassThru -WindowStyle Hidden
            Start-Sleep -Seconds 2
            if($proc.HasExited){throw "FFmpeg encerrou imediatamente: $($proc.ExitCode)"}
            $Active[$id]=@{Process=$proc;Raw=$raw}
            Event $id 'started'
            Write-Host "Gravacao iniciada: $id"
          }catch{Event $id 'failed' $_.Exception.Message;Write-Warning $_}
        }
      }
      $byId=@{};foreach($job in $Jobs){$byId[[string]$job.recording_id]=$job}
      foreach($id in @($Active.Keys)){
        $job=$byId[$id]
        if(!$job -or $job.status -in @('paused','finalizing','failed') -or $job.order_status -ne 'live' -or $job.current_step -ne $job.step_index){Finalize $id}
        elseif($Active[$id].Process.HasExited){Event $id 'failed' 'FFmpeg encerrou inesperadamente';$Active.Remove($id)}
      }
    }catch{
      Write-Warning "Servidor indisponivel/sem autorizacao: $_"
      # Fail closed: interrompe gravacoes se o dispositivo perder autorizacao ou conexao.
      foreach($id in @($Active.Keys)){Finalize $id}
    }
    Start-Sleep -Seconds 5
  }
}finally{foreach($id in @($Active.Keys)){Finalize $id}}
