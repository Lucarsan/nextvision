Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'NextVision.Core.psm1')
if (-not ('NextVision.Wifi' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace NextVision {
  public sealed class WifiAdapter { public Guid Id {get;set;} public string Name {get;set;} public uint State {get;set;} public string Profile {get;set;} public uint QueryError {get;set;} }
  public static class Wifi {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct InterfaceInfo {
      public Guid Id; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string Description; public uint State;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProfileInfo {
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string Name; public uint Flags;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Connection {
      public uint Mode; [MarshalAs(UnmanagedType.LPWStr)] public string Profile; public IntPtr Ssid, BssidList; public uint BssType, Flags;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode, Pack=4)] struct AvailableNetwork {
      [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string Profile;
      public uint SsidLength; [MarshalAs(UnmanagedType.ByValArray,SizeConst=32)] public byte[] Ssid;
      public uint BssType, BssidCount, Connectable, Reason, PhyCount;
      [MarshalAs(UnmanagedType.ByValArray,SizeConst=8)] public uint[] PhyTypes;
      public uint MorePhyTypes, Signal, SecurityEnabled, Auth, Cipher, Flags, Reserved;
    }
    [DllImport("wlanapi.dll")] static extern uint WlanOpenHandle(uint version, IntPtr reserved, out uint negotiated, out IntPtr handle);
    [DllImport("wlanapi.dll")] static extern uint WlanCloseHandle(IntPtr handle, IntPtr reserved);
    [DllImport("wlanapi.dll")] static extern uint WlanEnumInterfaces(IntPtr handle, IntPtr reserved, out IntPtr list);
    [DllImport("wlanapi.dll")] static extern uint WlanGetProfileList(IntPtr handle, ref Guid adapter, IntPtr reserved, out IntPtr list);
    [DllImport("wlanapi.dll")] static extern uint WlanGetAvailableNetworkList(IntPtr handle, ref Guid adapter, uint flags, IntPtr reserved, out IntPtr list);
    [DllImport("wlanapi.dll")] static extern uint WlanQueryInterface(IntPtr handle, ref Guid adapter, uint opcode, IntPtr reserved, out uint size, out IntPtr data, out uint type);
    [DllImport("wlanapi.dll")] static extern uint WlanConnect(IntPtr handle, ref Guid adapter, ref Connection connection, IntPtr reserved);
    [DllImport("wlanapi.dll")] static extern void WlanFreeMemory(IntPtr memory);
    static IntPtr Open() {
      if (Environment.OSVersion.Platform != PlatformID.Win32NT) throw new InvalidOperationException("Wi-Fi requer Windows.");
      IntPtr handle; uint version; var result=WlanOpenHandle(2,IntPtr.Zero,out version,out handle);
      if(result!=0) throw new InvalidOperationException("Servico Wi-Fi indisponivel ("+result+").");return handle;
    }
    public static WifiAdapter[] Adapters() {
      var handle=Open();IntPtr list=IntPtr.Zero;var result=new List<WifiAdapter>();
      try {
        var error=WlanEnumInterfaces(handle,IntPtr.Zero,out list);if(error!=0)throw new InvalidOperationException("Nao foi possivel consultar adaptadores ("+error+").");
        int count=Marshal.ReadInt32(list),size=Marshal.SizeOf(typeof(InterfaceInfo));
        for(int i=0;i<count;i++) {
          var info=(InterfaceInfo)Marshal.PtrToStructure(IntPtr.Add(list,8+i*size),typeof(InterfaceInfo));string profile="";uint queryError=0;
          if(info.State==1) {
            uint length,type;IntPtr data=IntPtr.Zero;var id=info.Id;
            try { queryError=WlanQueryInterface(handle,ref id,7,IntPtr.Zero,out length,out data,out type);if(queryError==0 && length>=520) profile=Marshal.PtrToStringUni(IntPtr.Add(data,8),256).TrimEnd('\0'); }
            finally { if(data!=IntPtr.Zero)WlanFreeMemory(data); }
          }
          result.Add(new WifiAdapter{Id=info.Id,Name=info.Description,State=info.State,Profile=profile,QueryError=queryError});
        }return result.ToArray();
      }finally{if(list!=IntPtr.Zero)WlanFreeMemory(list);WlanCloseHandle(handle,IntPtr.Zero);}
    }
    public static string[] Profiles(Guid adapter) {
      var handle=Open();IntPtr list=IntPtr.Zero;var result=new List<string>();
      try {
        var error=WlanGetProfileList(handle,ref adapter,IntPtr.Zero,out list);if(error!=0)throw new InvalidOperationException("Nao foi possivel consultar perfis ("+error+").");
        int count=Marshal.ReadInt32(list),size=Marshal.SizeOf(typeof(ProfileInfo));
        for(int i=0;i<count;i++)result.Add(((ProfileInfo)Marshal.PtrToStructure(IntPtr.Add(list,8+i*size),typeof(ProfileInfo))).Name);
        return result.ToArray();
      }finally{if(list!=IntPtr.Zero)WlanFreeMemory(list);WlanCloseHandle(handle,IntPtr.Zero);}
    }
    public static void Connect(Guid adapter,string profile) {
      if(String.IsNullOrEmpty(profile)||profile.Length>256)throw new ArgumentException("Perfil Wi-Fi invalido.");
      var handle=Open();
      try { var request=new Connection{Mode=0,Profile=profile,BssType=3};var result=WlanConnect(handle,ref adapter,ref request,IntPtr.Zero);
        if(result!=0)throw new InvalidOperationException("Conexao Wi-Fi recusada ("+result+").");
      }finally{WlanCloseHandle(handle,IntPtr.Zero);}
    }
    public static bool IsAvailable(Guid adapter,string profile) {
      var handle=Open();IntPtr list=IntPtr.Zero;
      try {
        var error=WlanGetAvailableNetworkList(handle,ref adapter,0,IntPtr.Zero,out list);
        if(error!=0)throw new InvalidOperationException("Consulta de redes disponiveis recusada ("+error+"). Confira permissoes Wi-Fi/localizacao.");
        int count=Marshal.ReadInt32(list),size=Marshal.SizeOf(typeof(AvailableNetwork));
        for(int i=0;i<count;i++) {
          var item=(AvailableNetwork)Marshal.PtrToStructure(IntPtr.Add(list,8+i*size),typeof(AvailableNetwork));
          if(item.Connectable!=0 && String.Equals(item.Profile,profile,StringComparison.Ordinal))return true;
        }return false;
      }finally{if(list!=IntPtr.Zero)WlanFreeMemory(list);WlanCloseHandle(handle,IntPtr.Zero);}
    }
  }
}
'@
}
function Test-NvCameraEndpoint($Endpoint,[int]$TimeoutMilliseconds=700) {
  $client=[Net.Sockets.TcpClient]::new()
  try {
    $pending=$client.BeginConnect([string]$Endpoint.host,[int]$Endpoint.port,$null,$null)
    if (-not $pending.AsyncWaitHandle.WaitOne($TimeoutMilliseconds)) { return $false }
    $client.EndConnect($pending);return $true
  } catch { return $false } finally { $client.Dispose() }
}
function Assert-NvNetworkPolicy($Policy) {
  $id=[guid]::Empty
  if (-not [guid]::TryParse([string]$Policy.adapter_id,[ref]$id)) { throw 'Selecione o adaptador Wi-Fi.' }
  $profiles=@($Policy.primary)+@($Policy.backups)
  $unique=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($profile in $profiles) { if (-not $unique.Add([string]$profile)) { throw 'Nao repita perfis Wi-Fi.' } }
  if (-not $Policy.primary -or $profiles.Count -gt 9) { throw 'Informe uma rede principal e ate oito reservas diferentes, em ordem.' }
  foreach ($profile in $profiles) { if (-not ($profile -is [string]) -or $profile.Length -gt 256 -or $profile -match '[\x00-\x1f]') { throw 'Perfil Wi-Fi invalido.' } }
  $endpoints=@($Policy.endpoints)
  if ($endpoints.Count -lt 1 -or $endpoints.Count -gt 128) { throw 'Configure ao menos uma camera antes da manutencao de rede.' }
  foreach ($endpoint in $endpoints) {
    if (-not $endpoint.host -or $endpoint.host -match '[\s/@?#]' -or [int]$endpoint.port -lt 1 -or [int]$endpoint.port -gt 65535) { throw 'Endereco de teste da camera invalido.' }
  }
  if ($Policy.enabled) {
    foreach ($profile in $profiles) { if ($profile -cnotin @($Policy.tested)) { throw 'Teste e aprove cada perfil antes de ativar a troca automatica.' } }
  }
}
function Get-NvNetworkEndpointKey([array]$Endpoints) {
  return (@($Endpoints|ForEach-Object { ([string]$_.host).ToLowerInvariant()+':'+[string]$_.port }|Sort-Object -Unique) -join '|')
}
function New-NvNetworkState {
  return @{Failures=0;Pending='';PendingSince=[datetime]::MinValue;NextAttempt=[datetime]::MinValue;Cursor=0;EndpointCursor=0;Searching=$false;Status='desativado';Changed=$false}
}
function Sync-NvNetwork {
  param($State,$Policy,[scriptblock]$Observe={param($id) @([NextVision.Wifi]::Adapters()|Where-Object {$_.Id -eq [guid]$id})|Select-Object -First 1},
    [scriptblock]$Connect={param($id,$profile)
      if (-not [NextVision.Wifi]::IsAvailable([guid]$id,$profile)) { throw 'Rede selecionada fora de alcance.' }
      [NextVision.Wifi]::Connect([guid]$id,$profile)
    },
    [scriptblock]$Probe={param($endpoint) Test-NvCameraEndpoint $endpoint},[datetime]$Now=[datetime]::UtcNow,[switch]$Maintenance)
  $State.Changed=$false
  if ($Maintenance) { $State.Status='manutencao manual de rede em andamento';return }
  if ($null -eq $Policy -or -not $Policy.enabled) {
    $State.Status='troca automatica desativada';$State.Pending='';$State.Failures=0;$State.Cursor=0;$State.Searching=$false;return
  }
  Assert-NvNetworkPolicy $Policy
  $current=& $Observe $Policy.adapter_id
  $profiles=@($Policy.primary)+@($Policy.backups)
  if ($null -ne $current -and [int]$current.State -eq 1 -and -not $current.Profile) {
    $State.Status='perfil atual nao identificado; troca automatica suspensa';return
  }
  $reachable=$false
  if ($null -ne $current -and [int]$current.State -eq 1) {
    $endpoints=@($Policy.endpoints)
    for ($i=0;$i -lt [Math]::Min(3,$endpoints.Count);$i++) {
      $endpoint=$endpoints[$State.EndpointCursor%$endpoints.Count];$State.EndpointCursor++
      if (& $Probe $endpoint) { $reachable=$true;break }
    }
  }
  if ($reachable) {
    $State.Status='rede com acesso a camera';$State.Failures=0;$State.Pending='';$State.Cursor=0;$State.Searching=$false;return
  }
  if ($null -ne $current -and [int]$current.State -eq 1 -and $current.Profile -cin $profiles -and -not $State.Pending -and -not $State.Searching) {
    # A camera being off must not cause Wi-Fi cycling on a selected connected network.
    $State.Status='Wi-Fi conectado; camera sem acesso local';$State.Failures=0;return
  }
  if ($State.Pending) {
    if (($Now-$State.PendingSince).TotalSeconds -lt 20) { $State.Status='conectando rede selecionada; aguardando camera';return }
    $State.Pending='';$State.NextAttempt=$Now.AddSeconds(15)
    if ($State.Cursor -ge $profiles.Count) {
      $State.Cursor=0;$State.Searching=$false;$State.NextAttempt=$Now.AddSeconds(120)
      $State.Status='reservas tentadas; camera ainda sem acesso local';return
    }
  }
  $State.Failures++
  if ($State.Failures -lt 3 -or $Now -lt $State.NextAttempt) { $State.Status='sem acesso local; aguardando reconexao';return }
  $candidate=$profiles[$State.Cursor%$profiles.Count];$State.Cursor++;$State.Failures=0
  try {
    & $Connect $Policy.adapter_id $candidate
    $State.Pending=$candidate;$State.PendingSince=$Now;$State.Searching=$true;$State.Changed=$true;$State.Status='troca solicitada; verificando acesso a camera'
  } catch { $State.NextAttempt=$Now.AddSeconds(30);$State.Status='nao foi possivel conectar a rede selecionada' }
}
function Get-NvNetworkEndpoints([array]$Urls) {
  $seen=@{};$endpoints=@()
  foreach ($url in $Urls) {
    $uri=[uri]$url
    if ($uri.Scheme -notin @('rtsp','rtsps') -or -not $uri.Host) { throw 'Fonte de camera invalida.' }
    $port=$(if ($uri.Port -gt 0) {$uri.Port} else {554})
    $key=$uri.Host+':'+$port
    if (-not $seen.ContainsKey($key)) { $endpoints+=@{host=$uri.Host;port=$port};$seen[$key]=$true }
  }
  return $endpoints
}
Export-ModuleMember -Function *-Nv*

function Test-NvNetworkMaintenance([string]$Directory) {
  $file=Join-Path $Directory 'network-maintenance.lock'
  if (-not [IO.File]::Exists($file)) { return $false }
  try { $handle=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$handle.Dispose();return $false }
  catch [IO.IOException] { return $true }
}
function Show-NvNetworkSettings([string]$PolicyFile,[array]$Endpoints,[string]$Directory) {
  if ($env:OS -ne 'Windows_NT') { throw 'A manutencao de Wi-Fi requer Windows.' }
  if (-not $Endpoints.Count) { throw 'Configure primeiro a fonte de ao menos uma camera.' }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [IO.Directory]::CreateDirectory($Directory)|Out-Null
  $saved=$null;if (Test-Path -LiteralPath $PolicyFile) { $saved=Get-Content -LiteralPath $PolicyFile -Raw -Encoding UTF8|ConvertFrom-Json }
  $form=New-Object Windows.Forms.Form;$form.Text='NextVision - Manutencao de rede';$form.Size=[Drawing.Size]::new(720,640);$form.StartPosition='CenterScreen'
  $form.Font=[Drawing.Font]::new('Segoe UI',10);$form.MinimumSize=[Drawing.Size]::new(600,460)
  $form.AutoScroll=$true;$form.AutoScrollMinSize=[Drawing.Size]::new(690,610)
  $area=[Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  if ($form.Height -gt $area.Height) { $form.Height=$area.Height }
  function LabelAt([string]$Text,[int]$Y,[int]$Height=25) {
    $label=New-Object Windows.Forms.Label;$label.Text=$Text;$label.SetBounds(20,$Y,655,$Height);$form.Controls.Add($label);return $label
  }
  LabelAt 'Redes de 2,4 e 5 GHz podem funcionar. O teste verifica acesso local as cameras.' 15 45|Out-Null
  LabelAt 'Adaptador Wi-Fi' 65|Out-Null
  $adapters=New-Object Windows.Forms.ComboBox;$adapters.DropDownStyle='DropDownList';$adapters.SetBounds(20,93,655,30);$adapters.DisplayMember='Name';$form.Controls.Add($adapters)
  LabelAt 'Rede principal' 130|Out-Null
  $primary=New-Object Windows.Forms.ComboBox;$primary.DropDownStyle='DropDownList';$primary.SetBounds(20,158,420,30);$form.Controls.Add($primary)
  $addWindows=New-Object Windows.Forms.Button;$addWindows.Text='Adicionar / editar no Windows';$addWindows.SetBounds(450,155,225,35);$form.Controls.Add($addWindows)
  LabelAt 'Reservas em ordem de prioridade (perfis salvos neste usuario Windows)' 200|Out-Null
  $backups=New-Object Windows.Forms.ListBox;$backups.SetBounds(20,230,420,130);$form.Controls.Add($backups)
  $available=New-Object Windows.Forms.ComboBox;$available.DropDownStyle='DropDownList';$available.SetBounds(20,370,320,30);$form.Controls.Add($available)
  $add=New-Object Windows.Forms.Button;$add.Text='Incluir reserva';$add.SetBounds(350,367,120,35);$form.Controls.Add($add)
  $up=New-Object Windows.Forms.Button;$up.Text='Subir';$up.SetBounds(450,230,100,35);$form.Controls.Add($up)
  $down=New-Object Windows.Forms.Button;$down.Text='Descer';$down.SetBounds(450,270,100,35);$form.Controls.Add($down)
  $remove=New-Object Windows.Forms.Button;$remove.Text='Remover';$remove.SetBounds(450,310,100,35);$form.Controls.Add($remove)
  $test=New-Object Windows.Forms.Button;$test.Text='Conectar e testar perfil selecionado';$test.SetBounds(20,415,310,35);$form.Controls.Add($test)
  $reload=New-Object Windows.Forms.Button;$reload.Text='Atualizar perfis';$reload.SetBounds(340,415,150,35);$form.Controls.Add($reload)
  $automatic=New-Object Windows.Forms.CheckBox;$automatic.Text='Trocar automaticamente quando perder a rede';$automatic.SetBounds(20,462,630,30);$form.Controls.Add($automatic)
  $status=LabelAt 'Selecione o perfil na lista inferior para testar. O teste pode interromper brevemente o video.' 500 55
  $save=New-Object Windows.Forms.Button;$save.Text='Salvar configuracao';$save.SetBounds(450,555,225,35);$form.Controls.Add($save)
  $context=@{Tested=[Collections.Generic.Dictionary[string,bool]]::new([StringComparer]::Ordinal);Busy=$false;Adapter=''}
  $loadProfiles={
    if ($null -eq $adapters.SelectedItem) { return }
    $id=[string]$adapters.SelectedItem.Id
    if ($context.Adapter -ne $id) { $context.Tested=[Collections.Generic.Dictionary[string,bool]]::new([StringComparer]::Ordinal);$context.Adapter=$id;$backups.Items.Clear() }
    $selected=[string]$primary.SelectedItem
    $primary.Items.Clear();$available.Items.Clear()
    try { foreach ($profile in [NextVision.Wifi]::Profiles([guid]$id)) { $primary.Items.Add($profile)|Out-Null;$available.Items.Add($profile)|Out-Null } }
    catch { $status.Text='Nao foi possivel consultar os perfis. Confira o adaptador e o servico Wi-Fi do Windows.';return }
    if ($primary.Items.Count) { $primary.SelectedIndex=0;$available.SelectedIndex=0 }
    if ($primary.Items.Contains($selected)) { $primary.SelectedItem=$selected }
  }
  $adapters.add_SelectedIndexChanged($loadProfiles)
  $primary.add_SelectedIndexChanged({ if ($available.Items.Contains([string]$primary.SelectedItem)) { $available.SelectedItem=$primary.SelectedItem } })
  $backups.add_SelectedIndexChanged({ if ($available.Items.Contains([string]$backups.SelectedItem)) { $available.SelectedItem=$backups.SelectedItem } })
  foreach ($adapter in [NextVision.Wifi]::Adapters()) { $adapters.Items.Add($adapter)|Out-Null }
  if ($adapters.Items.Count) { $adapters.SelectedIndex=0 } else { $status.Text='Nenhum adaptador Wi-Fi disponivel.' }
  if ($null -ne $saved) {
    for ($i=0;$i -lt $adapters.Items.Count;$i++) { if ([string]$adapters.Items[$i].Id -eq $saved.adapter_id) { $adapters.SelectedIndex=$i } }
    if ($primary.Items.Contains([string]$saved.primary)) { $primary.SelectedItem=[string]$saved.primary }
    foreach ($profile in $saved.backups) { if ($available.Items.Contains([string]$profile)) { $backups.Items.Add([string]$profile)|Out-Null } }
    $automatic.Checked=[bool]$saved.enabled
    if ($null -ne $adapters.SelectedItem -and [string]$adapters.SelectedItem.Id -eq [string]$saved.adapter_id -and (Get-NvNetworkEndpointKey $saved.endpoints) -eq (Get-NvNetworkEndpointKey $Endpoints) -and $null -ne $saved.PSObject.Properties['tested']) {
      foreach ($profile in $saved.tested) { $context.Tested[[string]$profile]=$true }
    }
  }
  $addWindows.add_Click({ Start-Process 'ms-settings:network-wifi';$status.Text='Cadastre ou atualize a rede no Windows e clique Atualizar perfis. Senhas ficam sob controle do Windows.' })
  $reload.add_Click({ try { & $loadProfiles } catch { $status.Text='Nao foi possivel atualizar perfis. Confira o servico Wi-Fi do Windows.' } })
  $add.add_Click({
    if ($null -eq $available.SelectedItem) { return };$profile=[string]$available.SelectedItem
    if ($profile -ceq [string]$primary.SelectedItem -or $backups.Items.Contains($profile)) { $status.Text='Esse perfil ja foi selecionado.';return }
    if ($backups.Items.Count -ge 8) { $status.Text='Limite de oito reservas.';return }
    $backups.Items.Add($profile)|Out-Null
  })
  $remove.add_Click({ if ($backups.SelectedIndex -ge 0) { $backups.Items.RemoveAt($backups.SelectedIndex) } })
  $up.add_Click({ $i=$backups.SelectedIndex;if ($i -gt 0) { $item=$backups.Items[$i];$backups.Items.RemoveAt($i);$backups.Items.Insert($i-1,$item);$backups.SelectedIndex=$i-1 } })
  $down.add_Click({ $i=$backups.SelectedIndex;if ($i -ge 0 -and $i -lt $backups.Items.Count-1) { $item=$backups.Items[$i];$backups.Items.RemoveAt($i);$backups.Items.Insert($i+1,$item);$backups.SelectedIndex=$i+1 } })
  $test.add_Click({
    if ($context.Busy -or $null -eq $available.SelectedItem -or $null -eq $adapters.SelectedItem) { return }
    $context.Busy=$true;$save.Enabled=$false;$test.Enabled=$false;$form.UseWaitCursor=$true;$lock=$null
    $id=[guid]$adapters.SelectedItem.Id;$profile=[string]$available.SelectedItem
    $before=$null
    try {
      $lock=[IO.File]::Open((Join-Path $Directory 'network-maintenance.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
      $before=@([NextVision.Wifi]::Adapters()|Where-Object {$_.Id -eq $id})|Select-Object -First 1
      $status.Text='Conectando e testando acesso local. Aguarde ate 20 segundos.';[Windows.Forms.Application]::DoEvents()
      if (-not [NextVision.Wifi]::IsAvailable($id,$profile)) { throw 'Perfil selecionado indisponivel no alcance atual.' }
      [NextVision.Wifi]::Connect($id,$profile)
      $ok=$false;$deadline=[datetime]::UtcNow.AddSeconds(20)
      while ([datetime]::UtcNow -lt $deadline) {
        $current=@([NextVision.Wifi]::Adapters()|Where-Object {$_.Id -eq $id})|Select-Object -First 1
        if ($null -ne $current -and $current.State -eq 1 -and -not $current.Profile -and $current.QueryError -ne 0) {
          $status.Text='Windows nao permitiu identificar o Wi-Fi ativo. Confira permissoes de Wi-Fi/localizacao nas Configuracoes.';break
        }
        if ($null -ne $current -and $current.State -eq 1 -and $current.Profile -ceq $profile) {
          $ok=$true
          foreach ($endpoint in $Endpoints) {
            if ([datetime]::UtcNow -ge $deadline -or -not (Test-NvCameraEndpoint $endpoint 300)) { $ok=$false;break }
          }
        }
        if ($ok) { break };[Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 200
      }
      if ($ok) { $context.Tested[$profile]=$true;$status.Text='Conectado com acesso a camera. Perfil aprovado; salve a configuracao para vincular.' }
      else {
        $context.Tested.Remove($profile)
        if ($null -ne $before -and $before.Profile -and $before.Profile -ne $profile) { [NextVision.Wifi]::Connect($id,$before.Profile) }
        $status.Text='A camera nao foi alcancada. O perfil nao foi aprovado; retorno a rede anterior solicitado quando disponivel.'
      }
    } catch {
      if ($null -ne $before -and $before.Profile -and $before.Profile -cne $profile) {
        try { [NextVision.Wifi]::Connect($id,$before.Profile) } catch { }
      }
      $status.Text='Falha no teste de rede. Confira permissoes, perfil salvo e adaptador Wi-Fi.'
    }
    finally { if ($null -ne $lock) { $lock.Dispose() };$context.Busy=$false;$save.Enabled=$true;$test.Enabled=$true;$form.UseWaitCursor=$false }
  })
  $save.add_Click({
    try {
      if ($null -eq $adapters.SelectedItem -or $null -eq $primary.SelectedItem) { throw 'Selecione adaptador e rede principal.' }
      $policy=@{schema_version=1;enabled=$automatic.Checked;adapter_id=[string]$adapters.SelectedItem.Id;primary=[string]$primary.SelectedItem;backups=@($backups.Items|ForEach-Object {[string]$_});endpoints=$Endpoints;tested=@($context.Tested.Keys)}
      Assert-NvNetworkPolicy $policy
      if ($policy.enabled) { foreach ($profile in (@($policy.primary)+@($policy.backups))) { if (-not $context.Tested.ContainsKey($profile)) { throw 'Teste a rede principal e cada reserva antes de ativar a troca automatica.' } } }
      Write-NvJson $PolicyFile $policy;$form.DialogResult=[Windows.Forms.DialogResult]::OK;$form.Close()
    } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message,'NextVision')|Out-Null }
  })
  try { $form.ShowDialog()|Out-Null } finally { $form.Dispose() }
}
Export-ModuleMember -Function *-Nv*
