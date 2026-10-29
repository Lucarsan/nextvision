param([switch]$Media)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot '../NextVision.Core.psm1') -Force
$script:passed=0
function Check([string]$Name,[scriptblock]$Body) {
  & $Body
  $script:passed++
  Write-Host "PASS $Name"
}
function Assert($Condition,[string]$Message='Assertion failed') { if (-not $Condition) { throw $Message } }
function Throws([scriptblock]$Body) { $thrown=$false;try { & $Body | Out-Null } catch { $thrown=$true };Assert $thrown 'Expected rejection' }
$root=Join-Path ([IO.Path]::GetTempPath()) ('nv-agent-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
$idA=[guid]::NewGuid().ToString();$idB=[guid]::NewGuid().ToString()
try {
  Check 'PowerShell scripts parse without errors' {
    foreach ($file in @(Get-ChildItem (Join-Path $PSScriptRoot '..') -Filter '*.ps*1')) {
      $tokens=$null;$errors=$null
      [Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)|Out-Null
      Assert ($errors.Count -eq 0) ('Parse error in '+$file.Name)
    }
  }
  Check 'per-camera routing and fail-closed modes' {
    $camera=@{id=$idA;stream_path='camera_'+$idA}
    Assert ((Get-NvCameraPath @{mode='central_media'} $camera) -eq ('camera_'+$idA))
    Assert ($null -eq (Get-NvCameraPath @{mode='unconfigured'} $camera))
    Assert ($null -eq (Get-NvCameraPath @{mode='legacy_single_camera'} $camera))
    Assert ((Get-NvCameraPath @{mode='legacy_single_camera'} @{id=$idA;stream_path='camera'}) -eq 'camera')
    Throws { Get-NvCameraPath @{mode='central_media'} @{id=$idA;stream_path='../other'} }
    Throws { Assert-NvId '../../other' }
  }
  Check 'RTSP secret escaping and concat injection rejection' {
    $url=New-NvRtspUrl 'rtsp://127.0.0.1:8554/camera' 'a:b' "space @#%:'secret"
    Assert ($url -like '*a%3Ab:space%20%40%23%25%3A%27secret@*')
    $inputText=New-NvConcatInput $url 'udp'
    Assert ($inputText.Contains('option rtsp_transport udp'))
    Assert (-not $inputText.Contains("'secret"))
    Assert ((New-NvConcatInput 'rtsps://localhost/camera').Contains('option tls_verify 1'))
    Throws { New-NvConcatInput "rtsp://localhost/camera'`nfile '/etc/passwd" }
    Throws { New-NvRtspUrl 'file:///etc/passwd' '' '' }
    Throws { New-NvRtspUrl 'rtsp://user:password@localhost/camera' '' '' }
    Throws { New-NvRtspUrl 'rtsp://localhost/camera#fragment' '' '' }
  }
  Check 'recording directory with spaces and Unicode, atomic JSON, existing files preserved' {
    $directory=Join-Path $root ('videos da loja '+[char]0x00E7)
    Assert ((Set-NvStorageDirectory $directory) -eq $directory)
    $previous=Join-Path $directory 'previous.mp4';[IO.File]::WriteAllText($previous,'preserved')
    $settings=Join-Path $root 'settings.json'
    Write-NvJson $settings @{recording_directory=$directory}
    Write-NvJson $settings @{recording_directory=$directory;version=2}
    $loaded=Get-Content -LiteralPath $settings -Raw|ConvertFrom-Json
    Assert ($loaded.recording_directory -eq $directory -and $loaded.version -eq 2)
    Assert ([IO.File]::ReadAllText($previous) -eq 'preserved')
    Throws { Set-NvStorageDirectory 'relative/path' }
    Throws { Set-NvStorageDirectory $previous }
  }
  Check 'argument quoting preserves spaces, quotes, empty arguments and trailing backslashes' {
    Assert ([NextVision.MediaProcess]::Quote('') -eq '""')
    Assert ([NextVision.MediaProcess]::Quote('C:\video folder\') -eq '"C:\video folder\\"')
    Assert ([NextVision.MediaProcess]::Quote('a"b') -eq '"a\"b"')
  }
  Check 'invalid destination cannot start a publisher' {
    $state=New-NvSupervisor
    Throws { Sync-NvPublishers $state @(@{Id=$idA;Path='other_shop';Url='rtsp://localhost/a';Transport='tcp';Revision='1'}) }
    Assert ($state.Count -eq 0)
  }
  Check 'failed launches back off and removal clears state' {
    $state=New-NvSupervisor;$now=[datetime]::UtcNow
    $desired=@(@{Id=$idA;Path='camera';Url='rtsp://127.0.0.1/a';Transport='tcp';Revision='1'})
    Sync-NvPublishers $state $desired (Join-Path $root 'does-not-exist') $now
    Assert ($state[$idA].Failures -eq 1)
    Sync-NvPublishers $state $desired (Join-Path $root 'does-not-exist') $now.AddSeconds(1)
    Assert ($state[$idA].Failures -eq 1)
    Sync-NvPublishers $state $desired (Join-Path $root 'does-not-exist') $now.AddSeconds(2)
    Assert ($state[$idA].Failures -eq 2)
    Sync-NvPublishers $state @()
    Assert ($state.Count -eq 0)
  }
  if ($env:OS -eq 'Windows_NT') {
    Check 'Windows DPAPI roundtrip binds secrets to current user' {
      $secret='synthetic-'+[guid]::NewGuid().ToString()
      $encoded=ConvertFrom-SecureString (ConvertTo-SecureString $secret -AsPlainText -Force)
      Assert (-not $encoded.Contains($secret))
      $credential=New-Object System.Management.Automation.PSCredential('test',($encoded|ConvertTo-SecureString))
      Assert ($credential.GetNetworkCredential().Password -eq $secret)
    }
    Check 'owned Windows process starts in a kill-on-close job and exits on disposal' {
      $process=[NextVision.MediaProcess]::new($env:ComSpec,@('/c','ping -n 30 127.0.0.1 > NUL'),'')
      $pidOwned=$process.Process.Id
      Assert (-not $process.HasExited)
      Stop-NvMedia $process
      Assert ($null -eq (Get-Process -Id $pidOwned -ErrorAction SilentlyContinue))
    }
  } else { Write-Host 'WINDOWS ONLY: DPAPI and Job Object tests not executed on this platform.' }
  if ($Media) {
    if (-not $env:NV_TEST_SOURCE_A -or -not $env:NV_TEST_SOURCE_B) { throw 'The isolated media test requires two synthetic RTSP sources.' }
    $state=New-NvSupervisor
    $desired=@(
      @{Id=$idA;Path=('camera_'+$idA);Url=$env:NV_TEST_SOURCE_A;Transport='udp';Revision='1'},
      @{Id=$idB;Path=('camera_'+$idB);Url=$env:NV_TEST_SOURCE_B;Transport='tcp';Revision='1'}
    )
    function AwaitFrames($Entry) {
      $deadline=[datetime]::UtcNow.AddSeconds(20)
      while ([datetime]::UtcNow -lt $deadline -and -not $Entry.Media.HasExited -and -not $Entry.Media.HasProgress) { Start-Sleep -Milliseconds 100 }
      Assert ($Entry.Media.HasProgress -and -not $Entry.Media.HasExited) 'Expected moving synthetic video'
    }
    try {
      Check 'two real sources publish concurrently without RTSP passwords in process arguments' {
        Sync-NvPublishers $state $desired
        AwaitFrames $state[$idA];AwaitFrames $state[$idB]
        Assert ($state[$idA].Media.Process.Id -ne $state[$idB].Media.Process.Id)
        foreach ($entry in $state.Values) {
          Assert (-not $entry.Media.Process.StartInfo.Arguments.Contains('synthetic-secret'))
          Assert ($entry.Media.Process.StartInfo.Arguments.Contains('pipe:0'))
        }
        Write-NvJson (Join-Path $env:NV_TEST_DIRECTORY 'paths.json') @{a=$desired[0].Path;b=$desired[1].Path}
      }
      Check 'an unexpected publisher exit is automatically restarted with backoff' {
        $old=$state[$idA].Media.Process.Id
        $state[$idA].Media.Process.Kill();$state[$idA].Media.Process.WaitForExit()
        $now=[datetime]::UtcNow
        Sync-NvPublishers $state $desired 'ffmpeg' $now
        Assert ($null -eq $state[$idA].Media)
        Sync-NvPublishers $state $desired 'ffmpeg' $now.AddSeconds(3)
        AwaitFrames $state[$idA]
        Assert ($state[$idA].Media.Process.Id -ne $old)
      }
      Check 'stalled progress forces a publisher restart' {
        # The media laboratory runs on Linux: suspend only the owned FFmpeg,
        # leaving it alive but unable to produce frames. The other camera keeps moving.
        if ($env:OS -eq 'Windows_NT') { throw 'Use the Linux media laboratory for the real SIGSTOP stall scenario.' }
        $old=$state[$idB].Media.Process.Id;$now=[datetime]::UtcNow
        $unaffected=$state[$idA].Media.Process.Id
        & /bin/kill -STOP -- $old
        Assert ($LASTEXITCODE -eq 0)
        Start-Sleep -Seconds 3
        Assert (-not $state[$idB].Media.HasExited) 'The stalled process must still be alive'
        $now=[datetime]::UtcNow
        Sync-NvPublishers $state $desired 'ffmpeg' $now -StallSeconds 2
        Assert ($null -eq $state[$idB].Media)
        Assert ($state[$idA].Media.Process.Id -eq $unaffected)
        Sync-NvPublishers $state $desired 'ffmpeg' $now.AddSeconds(3)
        AwaitFrames $state[$idB]
        Assert ($state[$idB].Media.Process.Id -ne $old)
      }
      Check 'source revision replaces only the affected publisher' {
        $old=$state[$idA].Media.Process.Id;$unchanged=$state[$idB].Media.Process.Id
        $desired[0].Revision='2'
        Sync-NvPublishers $state $desired
        AwaitFrames $state[$idA]
        Assert ($state[$idA].Media.Process.Id -ne $old)
        Assert ($state[$idB].Media.Process.Id -eq $unchanged)
      }
      Check 'recording reads each approved camera and writes to a directory with spaces' {
        $directory=Set-NvStorageDirectory (Join-Path $env:NV_TEST_DIRECTORY 'recorded videos')
        foreach ($item in $desired) {
          $raw=Join-Path $directory ($item.Id+'.ts')
          $url=New-NvRtspUrl ('rtsp://127.0.0.1:8554/'+$item.Path) 'reader' 'synthetic-secret'
          $recording=Start-NvMedia 'ffmpeg' $url 'tcp' @('-n','-t','3','-c:v','copy','-f','mpegts',$raw)
          try { Assert ($recording.Process.WaitForExit(15000)) 'Recording timeout';Assert ($recording.ExitCode -eq 0);Assert ((Get-Item -LiteralPath $raw).Length -gt 1024) }
          finally { Stop-NvMedia $recording }
          $mp4=Complete-NvRecording 'ffmpeg' $raw
          Assert ((Get-Item -LiteralPath $mp4).Length -gt 1024)
          Assert (Test-Path -LiteralPath $raw)
          $hash=(Get-FileHash -LiteralPath $mp4).Hash
          Throws { Complete-NvRecording 'ffmpeg' $raw }
          Assert ((Get-FileHash -LiteralPath $mp4).Hash -eq $hash)
        }
      }
      Check 'removing a camera stops only its owned publisher' {
        $old=$state[$idA].Media.Process.Id;$keep=$state[$idB].Media.Process.Id
        Sync-NvPublishers $state @($desired[1])
        Assert (-not $state.ContainsKey($idA))
        Assert ($null -eq (Get-Process -Id $old -ErrorAction SilentlyContinue))
        Assert ($state[$idB].Media.Process.Id -eq $keep -and -not $state[$idB].Media.HasExited)
      }
      Check 'loss of authorization stops every owned publisher' {
        $old=$state[$idB].Media.Process.Id
        Stop-NvPublishers $state
        Assert ($state.Count -eq 0)
        Assert ($null -eq (Get-Process -Id $old -ErrorAction SilentlyContinue))
      }
    } finally { Stop-NvPublishers $state }
  }
  Write-Host "$script:passed checks passed."
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
