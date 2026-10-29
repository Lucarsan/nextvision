Set-StrictMode -Version 2.0

# .NET events drain FFmpeg output without running PowerShell on background threads.
# Neither input URLs nor FFmpeg diagnostics are written to logs or command lines.
if (-not ('NextVision.MediaProcess' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Text;
using System.Runtime.InteropServices;
namespace NextVision {
  public sealed class MediaProcess : IDisposable {
    public readonly Process Process;
    private long progressTicks = DateTime.UtcNow.Ticks;
    private string lastTime;
    private volatile bool hasProgress;
    private IntPtr job = IntPtr.Zero;
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
      public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, uint length);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public bool HasProgress { get { return hasProgress; } }
    public double IdleSeconds { get { return (DateTime.UtcNow - new DateTime(System.Threading.Interlocked.Read(ref progressTicks), DateTimeKind.Utc)).TotalSeconds; } }
    public bool HasExited { get { return Process.HasExited; } }
    public int ExitCode { get { return Process.ExitCode; } }
    public static string Quote(string value) {
      var b = new StringBuilder("\""); int slashes = 0;
      foreach (char c in value) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append(c); }
        else { b.Append('\\', slashes); b.Append(c); }
        slashes = 0;
      }
      b.Append('\\', slashes * 2); return b.Append('"').ToString();
    }
    public MediaProcess(string binary, string[] args, string input) {
      Process = new Process(); var info = new ProcessStartInfo(binary);
      info.UseShellExecute = false; info.CreateNoWindow = true;
      info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
      var b = new StringBuilder(); foreach (var arg in args) { if (b.Length > 0) b.Append(' '); b.Append(Quote(arg)); }
      info.Arguments = b.ToString(); Process.StartInfo = info;
      Process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
        var line = e.Data;
        if (line != null && line.StartsWith("out_time_us=")) {
          var time = line.Substring(12);
          long numericTime; if (long.TryParse(time, out numericTime) && numericTime > 0) hasProgress = true;
          if (time != "N/A" && time != lastTime) { lastTime = time; System.Threading.Interlocked.Exchange(ref progressTicks, DateTime.UtcNow.Ticks); }
        }
      };
      Process.ErrorDataReceived += delegate { }; // Diagnostics can contain an RTSP password.
      try {
        if (!Process.Start()) throw new InvalidOperationException("FFmpeg did not start");
        if (Environment.OSVersion.Platform == PlatformID.Win32NT) {
          job = CreateJobObject(IntPtr.Zero, null);
          var limit = new ExtendedLimit(); limit.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
          if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf(typeof(ExtendedLimit))) || !AssignProcessToJobObject(job, Process.Handle))
            throw new InvalidOperationException("Unable to contain media process");
        }
        Process.BeginOutputReadLine(); Process.BeginErrorReadLine();
        Process.StandardInput.Write(input); Process.StandardInput.Close();
      } catch { Dispose(); throw new InvalidOperationException("Falha ao iniciar FFmpeg; confira executavel e configuracao local."); }
    }
    public void Dispose() {
      try { if (!Process.HasExited) { Process.Kill(); Process.WaitForExit(5000); } } catch (InvalidOperationException) { }
      if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
      Process.Dispose();
    }
  }
}
'@
}

function Assert-NvId([string]$Id) {
  if ($Id -notmatch '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$') { throw 'Identificador invalido.' }
}
function Get-NvCameraPath($Response, $Camera) {
  Assert-NvId ([string]$Camera.id)
  if ($Response.mode -eq 'legacy_single_camera') {
    if ($Camera.stream_path -eq 'camera') { return 'camera' }
    return $null
  }
  if ($Response.mode -ne 'central_media') { return $null }
  if ($Camera.stream_path -notmatch '^camera_[a-fA-F0-9-]{36}$') { throw 'Caminho de camera invalido.' }
  return [string]$Camera.stream_path
}
function New-NvRtspUrl([string]$Address, [string]$Username, [string]$Password) {
  $uri = $null
  if ($Address -match '[\x00-\x20\x7f]' -or -not [uri]::TryCreate($Address, [UriKind]::Absolute, [ref]$uri) -or
      $uri.Scheme -notin @('rtsp','rtsps') -or -not $uri.Host -or $uri.UserInfo -or $uri.Fragment -or $Address.Contains("'")) {
    throw 'Use uma URL rtsp/rtsps sem senha, espacos, aspas ou fragmento; informe as credenciais separadamente.'
  }
  $builder = New-Object System.UriBuilder($uri)
  $builder.UserName = [uri]::EscapeDataString($Username).Replace("'",'%27')
  $builder.Password = [uri]::EscapeDataString($Password).Replace("'",'%27')
  return $builder.Uri.AbsoluteUri
}
function New-NvConcatInput([string]$Url, [ValidateSet('tcp','udp')][string]$Transport='tcp') {
  if ($Url -notmatch '^rtsps?://' -or $Url -match "[\x00-\x20\x7f']") { throw 'Fonte RTSP invalida.' }
  # A bounded input timeout also makes unavailable sources exit for supervisor retry.
  $tls=''
  if ($Url.StartsWith('rtsps://')) { $tls="option tls_verify 1`n" }
  return "ffconcat version 1.0`nfile '$Url'`noption rtsp_transport $Transport`noption timeout 10000000`n$tls"
}
function Start-NvMedia([string]$Binary, [string]$Url, [ValidateSet('tcp','udp')][string]$Transport, [string[]]$OutputArguments) {
  $arguments = @('-hide_banner','-loglevel','error','-nostats','-progress','pipe:1',
    '-f','concat','-safe','0','-protocol_whitelist','pipe,rtsp,rtsps,tcp,tls,udp,rtp,crypto','-i','pipe:0','-map','0:v:0','-an') + $OutputArguments
  return [NextVision.MediaProcess]::new($Binary, $arguments, (New-NvConcatInput $Url $Transport))
}
function Stop-NvMedia($Media) { if ($null -ne $Media) { $Media.Dispose() } }
function New-NvSupervisor { return @{} }
function Stop-NvPublishers($State) {
  foreach ($key in @($State.Keys)) { Stop-NvMedia $State[$key].Media; $State.Remove($key) }
}
function Sync-NvPublishers {
  param($State, [array]$Desired, [string]$Binary='ffmpeg', [datetime]$Now=[datetime]::UtcNow, [int]$StallSeconds=45)
  $byId = @{}
  foreach ($item in $Desired) {
    Assert-NvId ([string]$item.Id)
    if ($item.Path -notmatch '^(camera|camera_[a-fA-F0-9-]{36})$') { throw 'Destino nao autorizado.' }
    if ($byId.ContainsKey($item.Id)) { throw 'Camera duplicada.' }
    $byId[$item.Id] = $item
  }
  foreach ($key in @($State.Keys)) {
    if (-not $byId.ContainsKey($key) -or $State[$key].Revision -ne $byId[$key].Revision) {
      Stop-NvMedia $State[$key].Media; $State.Remove($key)
    }
  }
  foreach ($item in $Desired) {
    if (-not $State.ContainsKey($item.Id)) {
      $State[$item.Id] = @{Media=$null;Revision=$item.Revision;Failures=0;NextAttempt=$Now;StartedAt=$Now;Status='aguardando'}
    }
    $entry = $State[$item.Id]
    if ($null -ne $entry.Media) {
      if ($entry.Media.HasExited -or $entry.Media.IdleSeconds -gt $StallSeconds) {
        Stop-NvMedia $entry.Media; $entry.Media = $null
        $entry.Failures = [Math]::Min(6, $entry.Failures + 1)
        $entry.NextAttempt = $Now.AddSeconds([Math]::Min(60, [Math]::Pow(2,$entry.Failures)))
        $entry.Status = 'reconectando'
      } elseif (($Now - $entry.StartedAt).TotalSeconds -gt 60) { $entry.Failures = 0 }
    }
    if ($null -eq $entry.Media -and $Now -ge $entry.NextAttempt) {
      try {
        $outputArgs = @('-vf','scale=1280:720,fps=15','-c:v','libx264','-preset','ultrafast','-tune','zerolatency',
          '-b:v','1200k','-pix_fmt','yuv420p','-g','30','-f','rtsp','-rtsp_transport','tcp',('rtsp://127.0.0.1:8554/'+$item.Path))
        $entry.Media = Start-NvMedia $Binary $item.Url $item.Transport $outputArgs
        $entry.StartedAt = $Now; $entry.Status = 'iniciando'
      } catch {
        $entry.Failures = [Math]::Min(6,$entry.Failures+1)
        $entry.NextAttempt = $Now.AddSeconds([Math]::Min(60,[Math]::Pow(2,$entry.Failures)))
        $entry.Status = 'falha ao iniciar'
      }
    } elseif ($null -ne $entry.Media -and $entry.Media.HasProgress -and $entry.Media.IdleSeconds -lt 5) { $entry.Status = 'imagem recebida' }
  }
}
function Set-NvStorageDirectory([string]$Directory) {
  if (-not [IO.Path]::IsPathRooted($Directory)) { throw 'Selecione um caminho absoluto.' }
  $full = [IO.Path]::GetFullPath($Directory)
  [IO.Directory]::CreateDirectory($full) | Out-Null
  $probe = Join-Path $full ('.nextvision-write-test-'+[guid]::NewGuid().ToString('N'))
  try { [IO.File]::WriteAllText($probe,''); [IO.File]::Delete($probe) }
  catch { throw 'A pasta de gravacoes nao permite escrita.' }
  return $full
}
function Complete-NvRecording([string]$Binary, [string]$Raw) {
  $mp4=[IO.Path]::ChangeExtension($Raw,'.mp4')
  if ([IO.File]::Exists($mp4)) { throw 'O MP4 de destino ja existe; nenhum arquivo foi sobrescrito.' }
  $arguments=@('-hide_banner','-loglevel','error','-n','-i',$Raw,'-map','0:v:0','-c','copy','-movflags','+faststart',$mp4)
  $remux=[NextVision.MediaProcess]::new($Binary,$arguments,'')
  try {
    if (-not $remux.Process.WaitForExit(30000) -or $remux.ExitCode -ne 0 -or -not [IO.File]::Exists($mp4) -or (Get-Item -LiteralPath $mp4).Length -lt 1024) {
      throw 'Falha ao finalizar MP4; o arquivo TS foi preservado.'
    }
  } finally { Stop-NvMedia $remux }
  return $mp4
}
function Write-NvJson([string]$Path, $Value) {
  $temporary = $Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  try {
    [IO.File]::WriteAllText($temporary,($Value | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary,$Path,[NullString]::Value) }
    else { [IO.File]::Move($temporary,$Path) }
  } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}
Export-ModuleMember -Function *-Nv*
