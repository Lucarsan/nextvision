# Ficou Pronto - assistente de instalacao e manutencao (Windows PowerShell 5.1).
# O tecnico so digita: codigo de ativacao (gerado na central) e usuario/senha da camera.
# Tunel, endereco de video e senha do MediaMTX vem da central.
param(
  [ValidateSet('auto', 'install', 'maintenance', 'uninstall')][string]$Mode = 'auto',
  [string]$ApiBase = '',
  [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $a = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Mode ' + $Mode
  Start-Process -FilePath 'powershell.exe' -ArgumentList $a -Verb RunAs
  exit 0
}

Import-Module (Join-Path $PSScriptRoot 'NextVision.Core.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'FicouPronto.psm1') -Force
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$paths = Get-FpPaths
if (-not $ApiBase) {
  $override = Join-Path $PSScriptRoot 'api-base.txt'
  $ApiBase = $(if (Test-Path -LiteralPath $override) { (Get-Content -LiteralPath $override -Raw).Trim() } else { 'https://app.ficoupronto.com' })
}

$Orange = [Drawing.Color]::FromArgb(242, 92, 31)
$Font = New-Object Drawing.Font('Segoe UI', 10)
$FontBold = New-Object Drawing.Font('Segoe UI', 10, [Drawing.FontStyle]::Bold)
$FontTitle = New-Object Drawing.Font('Segoe UI', 15, [Drawing.FontStyle]::Bold)

function Msg([string]$Text, [string]$Icon = 'Information') { [void][Windows.Forms.MessageBox]::Show($Text, 'Ficou Pronto', 'OK', $Icon) }
function Ask([string]$Text) { return ([Windows.Forms.MessageBox]::Show($Text, 'Ficou Pronto', 'YesNo', 'Question') -eq 'Yes') }
function Pump { [Windows.Forms.Application]::DoEvents() }

# ---------------- Desinstalacao (chamada pelo desinstalador) ----------------
if ($Mode -eq 'uninstall') {
  Uninstall-FpServices
  Remove-FpFirewall
  $restore = $false
  if ((Test-Path -LiteralPath $paths.PilotState) -and -not $Quiet) { $restore = Ask 'Reativar a instalacao anterior (piloto) que este instalador desativou?' }
  if ($restore) { try { Restore-FpPilot } catch { } }
  foreach ($item in @('secrets', 'services', 'config.json', 'status.json', 'agent.lock')) {
    $p = Join-Path $paths.Data $item; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
  exit 0
}

# ---------------- Janela ----------------
$form = New-Object Windows.Forms.Form
$form.Text = 'Ficou Pronto - instalacao da loja'
$form.Size = New-Object Drawing.Size(820, 640); $form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false
$form.BackColor = [Drawing.Color]::FromArgb(242, 243, 245); $form.Font = $Font
$title = New-Object Windows.Forms.Label; $title.Font = $FontTitle; $title.ForeColor = $Orange; $title.Location = '24,16'; $title.Size = '760,32'
$subtitle = New-Object Windows.Forms.Label; $subtitle.Location = '24,50'; $subtitle.Size = '760,40'
$panel = New-Object Windows.Forms.Panel; $panel.Location = '24,92'; $panel.Size = '760,440'; $panel.BackColor = [Drawing.Color]::White
$back = New-Object Windows.Forms.Button; $back.Text = 'Voltar'; $back.Location = '560,548'; $back.Size = '100,34'
$next = New-Object Windows.Forms.Button; $next.Text = 'Avancar'; $next.Location = '672,548'; $next.Size = '112,34'; $next.BackColor = $Orange; $next.ForeColor = [Drawing.Color]::White; $next.FlatStyle = 'Flat'
$form.Controls.AddRange(@($title, $subtitle, $panel, $back, $next))

function Add-Label($Text, $X, $Y, $W = 700, $H = 22, $Bold = $false) {
  $l = New-Object Windows.Forms.Label; $l.Text = $Text; $l.Location = New-Object Drawing.Point($X, $Y); $l.Size = New-Object Drawing.Size($W, $H)
  if ($Bold) { $l.Font = $FontBold }; $panel.Controls.Add($l); return $l
}
function Add-Text($X, $Y, $W = 300, $Text = '', $Secret = $false) {
  $t = New-Object Windows.Forms.TextBox; $t.Location = New-Object Drawing.Point($X, $Y); $t.Width = $W; $t.Text = $Text
  if ($Secret) { $t.UseSystemPasswordChar = $true }; $panel.Controls.Add($t); return $t
}
function Add-Button($Text, $X, $Y, $W = 160) {
  $b = New-Object Windows.Forms.Button; $b.Text = $Text; $b.Location = New-Object Drawing.Point($X, $Y); $b.Size = New-Object Drawing.Size($W, 30); $panel.Controls.Add($b); return $b
}
function Clear-Panel { $panel.Controls.Clear(); $back.Visible = $true; $next.Enabled = $true; $next.Text = 'Avancar' }

# Estado da instalacao em andamento (segredos so em memoria ate serem gravados protegidos).
$S = @{ Token = $null; DeviceName = $env:COMPUTERNAME; Provision = $null; Cameras = @{}; Found = @(); Pilot = (Get-FpPilotInstall); PilotCamera = $null; Step = '' }
if ($S.Pilot.SourceFile) { try { $S.PilotCamera = Read-FpPilotCamera $S.Pilot.SourceFile } catch { $S.PilotCamera = $null } }
$existingConfig = Read-FpConfig
$existingSecrets = $null
if ($existingConfig) { try { $existingSecrets = Read-FpSecrets } catch { $existingSecrets = $null } }

function Invoke-Provision {
  $r = Invoke-FpApi -Base $ApiBase -Method POST -Path '/api/connect/provision' -Token $S.Token -TimeoutSec 60
  if (-not $r.Ok) { throw ('A central nao entregou a configuracao: ' + $r.Error) }
  $S.Provision = $r.Data
  if (@($S.Provision.cameras).Count -eq 0) { throw ('A loja "' + $S.Provision.store.name + '" ainda nao tem camera cadastrada. Cadastre a camera na central e clique em Avancar de novo.') }
}

# ---------------- Passo 1: ativacao ----------------
function Show-Activation {
  Clear-Panel; $S.Step = 'activation'; $back.Visible = $false
  $title.Text = 'Ativar este computador'
  $subtitle.Text = 'Na central: Dispositivos > escolha a loja > "Gerar codigo de ativacao". O codigo vale 30 minutos e e de uso unico.'
  Add-Label 'Codigo de ativacao' 24 24 300 22 $true | Out-Null
  $script:codeBox = Add-Text 24 50 420 ''
  $script:codeBox.CharacterCasing = 'Upper'
  Add-Label 'Nome deste computador (aparece na central)' 24 92 400 22 $true | Out-Null
  $script:nameBox = Add-Text 24 118 420 $S.DeviceName
  $y = 170
  if ($S.Pilot.Found) {
    Add-Label 'Instalacao anterior encontrada (piloto manual):' 24 $y 700 22 $true | Out-Null
    $items = @($S.Pilot.Tasks) + $(if ($S.Pilot.CloudflaredService) { @('servico Cloudflared') } else { @() })
    Add-Label ('- ' + ($items -join ', ')) 24 ($y + 24) 700 40 | Out-Null
    Add-Label 'Ela sera desativada (nao apagada) para nao haver dois transmissores na mesma camera. Pode ser reativada em Manutencao > Voltar ao piloto.' 24 ($y + 64) 700 44 | Out-Null
    $y += 116
  }
  if ($S.Token) { Add-Label 'Este computador ja foi ativado nesta sessao; Avancar busca a configuracao de novo.' 24 $y 700 22 | Out-Null }
  $script:statusLabel = Add-Label '' 24 380 700 44
  $script:statusLabel.ForeColor = [Drawing.Color]::DarkRed
}

function Next-Activation {
  $script:statusLabel.Text = 'Conectando a central...'; $form.Cursor = 'WaitCursor'; Pump
  try {
    if (-not $S.Token) {
      $code = $script:codeBox.Text.Trim()
      if ($code -notmatch '^NV-[A-F0-9]{32}$') { throw 'Codigo invalido. Ele comeca com NV- seguido de 32 letras e numeros.' }
      $S.DeviceName = $script:nameBox.Text.Trim()
      $r = Invoke-FpApi -Base $ApiBase -Method POST -Path '/api/connect/activate' -Body @{ activation_code = $code; device_name = $S.DeviceName }
      if (-not $r.Ok) { throw ('Ativacao recusada: ' + $r.Error) }
      $S.Token = [string]$r.Data.device_token
    }
    Invoke-Provision
    Show-Cameras
  } catch { $script:statusLabel.Text = $_.Exception.Message } finally { $form.Cursor = 'Default' }
}

# ---------------- Passo 2: cameras ----------------
function Get-CameraForm([string]$Id) {
  if (-not $S.Cameras.ContainsKey($Id)) {
    $prev = $null
    if ($existingConfig) { $prev = @($existingConfig.cameras) | Where-Object { $_.id -eq $Id } | Select-Object -First 1 }
    $c = @{ Source = 'rtsp'; Host = ''; Port = 554; Path = '/onvif1'; User = 'admin'; Password = ''; Transport = 'auto'; Mac = ''; Confirmed = $false; Skip = $false }
    if ($prev) {
      $c.Source = $prev.source; $c.Host = $prev.host; $c.Port = [int]$prev.port; $c.Path = $prev.path; $c.Transport = $prev.transport; $c.Mac = $prev.mac
      if ($existingSecrets -and $existingSecrets.cameras.PSObject.Properties[$Id]) { $sc = $existingSecrets.cameras.PSObject.Properties[$Id].Value; $c.User = $sc.user; $c.Password = $sc.password }
    } elseif ($S.PilotCamera -and $S.Cameras.Count -eq 0) {
      $c.Host = $S.PilotCamera.Host; $c.Port = $S.PilotCamera.Port; $c.Path = $S.PilotCamera.Path; $c.User = $S.PilotCamera.User; $c.Password = $S.PilotCamera.Password
      if ($S.PilotCamera.Transport) { $c.Transport = $S.PilotCamera.Transport }
    }
    $S.Cameras[$Id] = $c
  }
  return $S.Cameras[$Id]
}

function Show-Cameras {
  Clear-Panel; $S.Step = 'cameras'
  $title.Text = 'Cameras da loja ' + $S.Provision.store.name
  $subtitle.Text = 'Para cada camera cadastrada na central, escolha o aparelho na rede, informe usuario e senha e confira a imagem.'
  Add-Label 'Camera da central' 16 12 200 22 $true | Out-Null
  $script:camPick = New-Object Windows.Forms.ComboBox; $script:camPick.DropDownStyle = 'DropDownList'; $script:camPick.Location = '16,36'; $script:camPick.Width = 300
  foreach ($cam in @($S.Provision.cameras)) { [void]$script:camPick.Items.Add($cam.name + $(if ($cam.bound) { '' } else { ' (de outro computador?)' })) }
  $panel.Controls.Add($script:camPick)
  $scan = Add-Button 'Procurar cameras na rede' 340 34 220
  Add-Label 'Endereco (IP) da camera' 16 76 220 22 $true | Out-Null
  $script:hostPick = New-Object Windows.Forms.ComboBox; $script:hostPick.Location = '16,100'; $script:hostPick.Width = 300; $panel.Controls.Add($script:hostPick)
  $script:testBox = New-Object Windows.Forms.CheckBox; $script:testBox.Text = 'Usar camera de teste (imagem sintetica)'; $script:testBox.Location = '16,132'; $script:testBox.Width = 320; $panel.Controls.Add($script:testBox)
  Add-Label 'Porta' 16 164 60 | Out-Null; $script:portBox = Add-Text 16 188 60
  Add-Label 'Caminho RTSP' 90 164 140 | Out-Null; $script:pathBox = Add-Text 90 188 226
  Add-Label 'Usuario' 16 222 140 | Out-Null; $script:userBox = Add-Text 16 246 140
  Add-Label 'Senha da camera' 166 222 150 | Out-Null; $script:passBox = Add-Text 166 246 150 '' $true
  Add-Label 'Transporte' 16 280 140 | Out-Null
  $script:transPick = New-Object Windows.Forms.ComboBox; $script:transPick.DropDownStyle = 'DropDownList'; $script:transPick.Location = '16,304'; $script:transPick.Width = 140
  @('auto', 'udp', 'tcp') | ForEach-Object { [void]$script:transPick.Items.Add($_) }; $panel.Controls.Add($script:transPick)
  $view = Add-Button 'Ver imagem' 166 302 150
  $script:skipBox = New-Object Windows.Forms.CheckBox; $script:skipBox.Text = 'Nao configurar esta camera agora'; $script:skipBox.Location = '16,344'; $script:skipBox.Width = 300; $panel.Controls.Add($script:skipBox)
  $script:pic = New-Object Windows.Forms.PictureBox; $script:pic.Location = '340,76'; $script:pic.Size = '400,250'; $script:pic.SizeMode = 'Zoom'; $script:pic.BackColor = [Drawing.Color]::FromArgb(230, 232, 236); $panel.Controls.Add($script:pic)
  $script:confirmBox = New-Object Windows.Forms.CheckBox; $script:confirmBox.Text = 'Esta e a camera certa'; $script:confirmBox.Location = '340,334'; $script:confirmBox.Width = 300; $script:confirmBox.Enabled = $false; $panel.Controls.Add($script:confirmBox)
  $script:camStatus = Add-Label '' 16 376 724 56

  $script:loading = $false
  $script:save = {
    if ($script:loading -or $script:camPick.SelectedIndex -lt 0) { return }
    $cam = @($S.Provision.cameras)[$script:camPick.SelectedIndex]; $c = Get-CameraForm $cam.id
    $hostText = [string]$script:hostPick.Text; $c.Host = ($hostText -split ' ')[0].Trim()
    $m = [regex]::Match($hostText, '([0-9A-F]{2}-){5}[0-9A-F]{2}'); if ($m.Success) { $c.Mac = $m.Value }
    $c.Source = $(if ($script:testBox.Checked) { 'test' } else { 'rtsp' })
    $port = 0; if ([int]::TryParse($script:portBox.Text, [ref]$port)) { $c.Port = $port }
    $c.Path = $script:pathBox.Text.Trim(); $c.User = $script:userBox.Text.Trim(); $c.Password = $script:passBox.Text
    $c.Transport = [string]$script:transPick.SelectedItem; $c.Skip = $script:skipBox.Checked; $c.Confirmed = $script:confirmBox.Checked
  }
  $script:load = {
    $script:loading = $true
    $cam = @($S.Provision.cameras)[$script:camPick.SelectedIndex]; $c = Get-CameraForm $cam.id
    $script:hostPick.Items.Clear()
    foreach ($h in $S.Found) { [void]$script:hostPick.Items.Add($h.IP + $(if ($h.MAC) { ' (' + $h.MAC + ')' } else { '' }) + $(if ($h.Gateway) { ' - roteador' } else { '' })) }
    $script:hostPick.Text = $c.Host + $(if ($c.Mac) { ' (' + $c.Mac + ')' } else { '' })
    $script:testBox.Checked = ($c.Source -eq 'test'); $script:portBox.Text = [string]$c.Port; $script:pathBox.Text = $c.Path
    $script:userBox.Text = $c.User; $script:passBox.Text = $c.Password; $script:transPick.SelectedItem = $c.Transport
    $script:skipBox.Checked = $c.Skip; $script:confirmBox.Checked = $c.Confirmed; $script:confirmBox.Enabled = ($c.Confirmed -or $c.Source -eq 'test')
    $script:pic.Image = $null; $script:camStatus.Text = ''
    $script:loading = $false
  }
  foreach ($ctl in @($script:hostPick, $script:portBox, $script:pathBox, $script:userBox, $script:passBox)) { $ctl.Add_TextChanged({ & $script:save; if (-not $script:loading) { $script:confirmBox.Checked = $false; $script:confirmBox.Enabled = $script:testBox.Checked } }) }
  $script:transPick.Add_SelectedIndexChanged($script:save); $script:skipBox.Add_CheckedChanged($script:save); $script:confirmBox.Add_CheckedChanged($script:save)
  $script:testBox.Add_CheckedChanged({ & $script:save; $script:confirmBox.Enabled = $script:testBox.Checked; if ($script:testBox.Checked) { $script:confirmBox.Checked = $true } })
  $script:camPick.Add_SelectedIndexChanged($script:load)

  $scan.Add_Click({
    $script:camStatus.Text = 'Procurando aparelhos com RTSP (porta 554) na rede deste computador...'; $form.Cursor = 'WaitCursor'; Pump
    try {
      $net = Get-FpLocalNetwork
      $S.Found = @(Find-FpRtspHosts)
      & $script:load
      $script:camStatus.Text = $(if ($S.Found.Count) { [string]$S.Found.Count + ' aparelho(s) encontrado(s) na rede ' + $net.Prefix + '.x. Escolha um e clique em Ver imagem: outros aparelhos tambem podem ter RTSP.' }
        else { 'Nada respondeu na porta 554. Confira se a camera esta ligada, no Wi-Fi principal da loja (nao o de convidados) e no mesmo roteador deste computador.' })
    } finally { $form.Cursor = 'Default' }
  })
  $view.Add_Click({
    & $script:save
    $cam = @($S.Provision.cameras)[$script:camPick.SelectedIndex]; $c = Get-CameraForm $cam.id
    if ($c.Source -eq 'test') { $script:camStatus.Text = 'Camera de teste: sem foto, o video sintetico aparece no acompanhamento.'; return }
    if (-not $c.Host -or -not $c.Password) { $script:camStatus.Text = 'Informe o endereco e a senha da camera.'; return }
    $form.Cursor = 'WaitCursor'; $script:camStatus.Text = 'Buscando uma imagem da camera...'; Pump
    try {
      if (-not (Test-FpTcpPort $c.Host $c.Port 2000)) { $script:camStatus.Text = 'O endereco ' + $c.Host + ' nao respondeu na porta ' + $c.Port + '.'; return }
      $url = New-FpRtspUrl $c.Host $c.Port $c.Path $c.User $c.Password
      $out = Join-Path $env:TEMP ('fp-snap-' + [guid]::NewGuid().ToString('N') + '.jpg')
      $tries = $(if ($c.Transport -eq 'auto') { @('udp', 'tcp') } else { @($c.Transport) })
      $result = $null
      foreach ($t in $tries) { $script:camStatus.Text = 'Tentando ' + $t.ToUpper() + '...'; Pump; $result = Get-FpSnapshot $url $t $out; if ($result.Ok) { $c.Transport = $t; break } }
      if ($result.Ok) {
        $bytes = [IO.File]::ReadAllBytes($out); [IO.File]::Delete($out)
        $script:pic.Image = [Drawing.Image]::FromStream((New-Object IO.MemoryStream(, $bytes)))
        $script:loading = $true; $script:transPick.SelectedItem = $c.Transport; $script:loading = $false
        if (-not $c.Mac) { $n = Get-NetNeighbor -IPAddress $c.Host -ErrorAction SilentlyContinue | Select-Object -First 1; if ($n) { $c.Mac = Format-FpMac $n.LinkLayerAddress } }
        $script:confirmBox.Enabled = $true
        $script:camStatus.Text = 'Imagem recebida por ' + $c.Transport.ToUpper() + '. Confira se e a camera "' + $cam.name + '" e marque "Esta e a camera certa".' + $(if ($c.Mac) { ' MAC ' + $c.Mac + ' guardado para reencontrar a camera se o IP mudar.' } else { '' })
      } else { $script:camStatus.Text = 'Sem imagem: ' + $result.Error + '. Confira usuario, senha e caminho (Yoosee: /onvif1).' }
    } catch { $script:camStatus.Text = $_.Exception.Message } finally { $form.Cursor = 'Default' }
  })
  if ($S.PilotCamera) { $script:camStatus.Text = 'Camera do piloto carregada (' + $S.PilotCamera.Host + '). Clique em Ver imagem para confirmar.' }
  $script:camPick.SelectedIndex = 0
}

function Next-Cameras {
  $ready = @(); $missing = @()
  foreach ($cam in @($S.Provision.cameras)) {
    $c = Get-CameraForm $cam.id
    if ($c.Skip) { continue }
    if ($c.Source -eq 'test' -or ($c.Confirmed -and $c.Host -and $c.Password)) { $ready += $cam } else { $missing += $cam.name }
  }
  if ($missing.Count) { Msg ('Confirme a imagem ou marque "Nao configurar agora" em: ' + ($missing -join ', ')) 'Warning'; return }
  if ($ready.Count -eq 0) { Msg 'Configure pelo menos uma camera.' 'Warning'; return }
  Show-Install
}

# ---------------- Passo 3: instalar e testar ----------------
function Show-Install {
  Clear-Panel; $S.Step = 'install'; $back.Visible = $false; $next.Enabled = $false
  $title.Text = 'Instalando e testando'
  $subtitle.Text = 'Leva de 1 a 3 minutos. Nao feche esta janela.'
  $list = New-Object Windows.Forms.ListBox; $list.Location = '16,16'; $list.Size = '724,400'; $list.Font = $Font; $panel.Controls.Add($list)
  $form.Cursor = 'WaitCursor'
  $log = { param($t) [void]$list.Items.Add($t); $list.TopIndex = [Math]::Max(0, $list.Items.Count - 1); Pump }
  $report = New-Object Collections.Generic.List[string]
  $ok = $true
  $P = $S.Provision
  $step = {
    param($Name, [scriptblock]$Action)
    & $log ('...  ' + $Name)
    try { $detail = & $Action; $list.Items[$list.Items.Count - 1] = 'OK   ' + $Name + $(if ($detail) { ' - ' + $detail } else { '' }); $report.Add('[OK] ' + $Name + $(if ($detail) { ' - ' + $detail } else { '' })); Pump; return $true }
    catch { $list.Items[$list.Items.Count - 1] = 'FALHA ' + $Name + ' - ' + $_.Exception.Message; $report.Add('[FALHA] ' + $Name + ' - ' + $_.Exception.Message); Pump; return $false }
  }
  $configured = @(@($P.cameras) | Where-Object { -not (Get-CameraForm $_.id).Skip })

  $ok = (& $step 'Gravar configuracao protegida' {
      Initialize-FpDirectories
      $camSecrets = @{}; $camList = @()
      foreach ($cam in $configured) {
        $c = Get-CameraForm $cam.id
        $camList += [ordered]@{ id = $cam.id; name = $cam.name; stream_path = $cam.stream_path; source = $c.Source; host = $c.Host; port = $c.Port; path = $c.Path; transport = $(if ($c.Transport -eq 'auto') { 'udp' } else { $c.Transport }); mac = $c.Mac }
        if ($c.Source -ne 'test') { $camSecrets[$cam.id] = @{ user = $c.User; password = $c.Password } }
      }
      Save-FpSecrets @{ device_token = $S.Token; media_password = $P.media.password; cameras = $camSecrets }
      Save-FpConfig ([ordered]@{ api_base = $ApiBase; device = @{ id = $P.device.id; name = $P.device.name }; store = @{ id = $P.store.id; name = $P.store.name }
          media = @{ hostname = $P.media.hostname; username = $P.media.username }; tunnel = @{ id = $P.tunnel.id; name = $P.tunnel.name }
          cameras = $camList; installed_at = [datetime]::UtcNow.ToString('o'); version = $paths.Version })
      Write-FpMediaMtxConfig $P.media.username $P.media.password
      Write-FpTunnelToken $P.tunnel.token
      [string]$camList.Count + ' camera(s)'
    }) -and $ok
  $ok = (& $step 'Liberar a camera no Firewall do Windows (UDP)' { Set-FpFirewall }) -and $ok
  if ($S.Pilot.Found) { $ok = (& $step 'Desativar a instalacao anterior (sem apagar)' { $st = Disable-FpPilot $S.Pilot; ([string]@($st.tasks).Count + ' tarefa(s)' + $(if ($st.cloudflared_service) { ', servico Cloudflared' } else { '' })) }) -and $ok }
  $ok = (& $step 'Instalar os servicos (iniciam antes do login)' { Install-FpServices; Start-FpServices; ((Get-FpServiceStates | ForEach-Object { $_.Status }) -join ', ') }) -and $ok

  $localOk = $true
  foreach ($cam in $configured) {
    $localOk = (& $step ('Video local da camera ' + $cam.name) {
        $deadline = [datetime]::UtcNow.AddSeconds(90)
        while ([datetime]::UtcNow -lt $deadline) {
          $h = Test-FpHls ('http://127.0.0.1:8888/' + $cam.stream_path + '/index.m3u8') $P.media.username $P.media.password 5
          if ($h.Ok) { return 'imagem chegando no MediaMTX' }
          for ($i = 0; $i -lt 6; $i++) { Start-Sleep -Milliseconds 500; Pump }
        }
        $st = $null; try { $st = Get-Content -LiteralPath $paths.Status -Raw | ConvertFrom-Json } catch { }
        $d = $(if ($st) { (@($st.cameras) | Where-Object { $_.id -eq $cam.id } | Select-Object -First 1).detail } else { 'agente sem status' })
        throw ('sem video em 90 s (' + $d + ')')
      }) -and $localOk
  }
  $netOk = $true
  foreach ($cam in $configured) {
    $netOk = (& $step ('Video pela internet (' + $P.media.hostname + ')') {
        $deadline = [datetime]::UtcNow.AddSeconds(120)
        $last = 0
        while ([datetime]::UtcNow -lt $deadline) {
          $h = Test-FpHls ('https://' + $P.media.hostname + '/' + $cam.stream_path + '/index.m3u8') $P.media.username $P.media.password 10
          if ($h.Ok) { return 'pronto para o acompanhamento do cliente' }
          $last = $h.Status
          for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Milliseconds 500; Pump }
        }
        throw ('o endereco nao entregou video (ultimo codigo ' + $last + '). Endereco novo pode levar alguns minutos para propagar.')
      }) -and $netOk
  }
  $centralOk = (& $step 'Sinal de vida na central' {
      $deadline = [datetime]::UtcNow.AddSeconds(45)
      while ([datetime]::UtcNow -lt $deadline) {
        try { $st = Get-Content -LiteralPath $paths.Status -Raw | ConvertFrom-Json; if ($st.central -eq 'ok') { return 'central recebendo' } } catch { }
        for ($i = 0; $i -lt 4; $i++) { Start-Sleep -Milliseconds 500; Pump }
      }
      throw 'o agente ainda nao falou com a central'
    })
  $form.Cursor = 'Default'

  $net = Get-FpLocalNetwork
  $header = @('Ficou Pronto - relatorio de instalacao', ('Data: ' + [datetime]::Now.ToString('dd/MM/yyyy HH:mm')), ('Loja: ' + $P.store.name), ('Computador: ' + $env:COMPUTERNAME + ' (' + $P.device.name + ')'),
    ('Windows: ' + (Get-CimInstance Win32_OperatingSystem).Caption + ' ' + [Environment]::OSVersion.Version), ('Rede: ' + $(if ($net) { $net.Interface + ' ' + $net.IP + ' gateway ' + $net.Gateway } else { '?' })),
    ('Agente: ' + $paths.Version), ('Endereco de video: ' + $P.media.hostname + ' (tunel ' + $P.tunnel.name + ')'), '')
  foreach ($cam in $configured) { $c = Get-CameraForm $cam.id; $header += ('Camera ' + $cam.name + ': ' + $(if ($c.Source -eq 'test') { 'teste (sintetica)' } else { $c.Host + ':' + $c.Port + $c.Path + ' ' + $c.Transport.ToUpper() + ' MAC ' + $c.Mac }) + ' -> /' + $cam.stream_path) }
  $text = ($header + '' + $report) -join "`r`n"
  [IO.File]::WriteAllText($paths.Report, $text, [Text.UTF8Encoding]::new($true))
  $S.Result = @{ Ok = ($ok -and $localOk -and $netOk -and $centralOk); Text = $text }
  Show-Done
}

function Show-Done {
  Clear-Panel; $S.Step = 'done'; $back.Visible = $false; $next.Text = 'Concluir'
  $title.Text = $(if ($S.Result.Ok) { 'Instalacao concluida' } else { 'Instalacao concluida com pendencias' })
  $subtitle.Text = $(if ($S.Result.Ok) { 'Crie um pedido de teste na loja e confira o video no celular (4G). O video volta sozinho se o PC reiniciar, mesmo sem login.' }
    else { 'Veja os itens com FALHA abaixo. Os servicos continuam tentando sozinhos; use "Ficou Pronto - Manutencao" para conferir depois.' })
  $box = New-Object Windows.Forms.TextBox; $box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Vertical'; $box.Location = '16,16'; $box.Size = '724,370'; $box.Font = New-Object Drawing.Font('Consolas', 9); $box.Text = $S.Result.Text
  $panel.Controls.Add($box)
  Add-Label ('Relatorio salvo em ' + $paths.Report) 16 396 724 22 | Out-Null
}

# ---------------- Manutencao ----------------
function Show-Maintenance {
  Clear-Panel; $S.Step = 'maintenance'; $back.Visible = $false; $next.Text = 'Fechar'
  $title.Text = 'Manutencao - ' + $existingConfig.store.name
  $subtitle.Text = 'Endereco de video: ' + $existingConfig.media.hostname + ' | agente ' + $paths.Version
  $script:grid = New-Object Windows.Forms.ListView; $script:grid.View = 'Details'; $script:grid.FullRowSelect = $true; $script:grid.Location = '16,16'; $script:grid.Size = '724,250'
  [void]$script:grid.Columns.Add('Item', 230); [void]$script:grid.Columns.Add('Estado', 470); $panel.Controls.Add($script:grid)
  $script:refresh = {
    $script:grid.Items.Clear()
    foreach ($s in Get-FpServiceStates) { $it = New-Object Windows.Forms.ListViewItem($s.Name); [void]$it.SubItems.Add($(if ($s.Status -eq 'Running') { 'Rodando' } else { $s.Status })); [void]$script:grid.Items.Add($it) }
    try {
      $st = Get-Content -LiteralPath $paths.Status -Raw | ConvertFrom-Json
      $age = [int]([datetime]::UtcNow - [datetime]::Parse($st.observed_at).ToUniversalTime()).TotalSeconds
      $it = New-Object Windows.Forms.ListViewItem('Central'); [void]$it.SubItems.Add([string]$st.central + ' (atualizado ha ' + $age + ' s)'); [void]$script:grid.Items.Add($it)
      foreach ($c in @($st.cameras)) { $it = New-Object Windows.Forms.ListViewItem('Camera ' + $c.name); [void]$it.SubItems.Add([string]$c.detail + ' - ' + [string]$c.host); [void]$script:grid.Items.Add($it) }
    } catch { $it = New-Object Windows.Forms.ListViewItem('Agente'); [void]$it.SubItems.Add('sem status recente'); [void]$script:grid.Items.Add($it) }
  }
  & $script:refresh
  $script:timer = New-Object Windows.Forms.Timer; $script:timer.Interval = 3000; $script:timer.Add_Tick($script:refresh); $script:timer.Start(); $form.Add_FormClosed({ $script:timer.Stop() })
  $b1 = Add-Button 'Reconfigurar cameras' 16 284 220
  $b2 = Add-Button 'Reparar (reinstalar servicos)' 252 284 230
  $b3 = Add-Button 'Abrir relatorio e registros' 498 284 242
  $b4 = Add-Button 'Voltar ao piloto antigo' 16 324 220; $b4.Enabled = (Test-Path -LiteralPath $paths.PilotState)
  $b5 = Add-Button 'Testar video pela internet' 252 324 230
  $note = Add-Label 'Para desinstalar: Configuracoes do Windows > Aplicativos > Ficou Pronto. Os videos sao preservados.' 16 372 724 44

  $b1.Add_Click({
    $script:timer.Stop()
    try {
      if (-not $existingSecrets) { throw 'Segredos locais ilegiveis; reinstale com um novo codigo de ativacao.' }
      $S.Token = [string]$existingSecrets.device_token; $form.Cursor = 'WaitCursor'; Invoke-Provision; $S.Pilot = Get-FpPilotInstall; Show-Cameras
    } catch { Msg $_.Exception.Message 'Warning'; $script:timer.Start() } finally { $form.Cursor = 'Default' }
  })
  $b2.Add_Click({
    $form.Cursor = 'WaitCursor'
    try {
      $S.Token = [string]$existingSecrets.device_token; Invoke-Provision
      Write-FpMediaMtxConfig $S.Provision.media.username $S.Provision.media.password
      Write-FpTunnelToken $S.Provision.tunnel.token
      Set-FpFirewall; Install-FpServices; Start-FpServices; Msg 'Servicos reinstalados e iniciados.'
    } catch { Msg $_.Exception.Message 'Warning' } finally { $form.Cursor = 'Default'; & $script:refresh }
  })
  $b3.Add_Click({ Start-Process explorer.exe $paths.Data })
  $b4.Add_Click({ if (Ask 'Desligar os servicos Ficou Pronto e reativar o piloto antigo?') { try { Restore-FpPilot; Msg 'Piloto reativado. Os servicos Ficou Pronto ficaram desativados.' } catch { Msg $_.Exception.Message 'Warning' }; & $script:refresh } })
  $b5.Add_Click({
    $form.Cursor = 'WaitCursor'
    try {
      $lines = foreach ($c in @($existingConfig.cameras)) { $h = Test-FpHls ('https://' + $existingConfig.media.hostname + '/' + $c.stream_path + '/index.m3u8') $existingConfig.media.username $existingSecrets.media_password 10; $c.name + ': ' + $(if ($h.Ok) { 'OK' } else { 'sem video (codigo ' + $h.Status + ')' }) }
      Msg ($lines -join "`n")
    } finally { $form.Cursor = 'Default' }
  })
}

$next.Add_Click({
  switch ($S.Step) {
    'activation' { Next-Activation }
    'cameras' { Next-Cameras }
    'done' { $form.Close() }
    'maintenance' { $form.Close() }
  }
})
$back.Add_Click({ if ($S.Step -eq 'cameras') { Show-Activation } })

if ($Mode -eq 'maintenance' -or ($Mode -eq 'auto' -and $existingConfig)) { Show-Maintenance } else { Show-Activation }
[void]$form.ShowDialog()
