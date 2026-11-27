param([switch]$SkipBrowser)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$launchLog = Join-Path $projectDirectory ".frameflow-launch.log"
"$(Get-Date -Format o) launcher started (SkipBrowser=$SkipBrowser)" | Add-Content -LiteralPath $launchLog
$nodeCandidates = @(
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
  (Join-Path $env:ProgramFiles "nodejs\node.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

function Test-CanvasReady([int]$Port) {
  $baseUrl = "http://127.0.0.1:$Port"
  try {
    $page = Invoke-WebRequest -Uri "$baseUrl/" -UseBasicParsing -TimeoutSec 2
    if ($page.StatusCode -ne 200 -or $page.Content -notmatch '<title>Frameflow') {
      "$(Get-Date -Format o) health page mismatch status=$($page.StatusCode)" | Add-Content -LiteralPath $launchLog
      return $false
    }
    # /@vite/client exists only on the local server with the /comfyui HTTP/WS proxy.
    $vite = Invoke-WebRequest -Uri "$baseUrl/@vite/client" -UseBasicParsing -TimeoutSec 2
    if ($vite.StatusCode -ne 200 -or $vite.Content -notmatch 'WebSocket') {
      "$(Get-Date -Format o) health vite mismatch status=$($vite.StatusCode)" | Add-Content -LiteralPath $launchLog
      return $false
    }
    # HTML alone can be ready while the actual browser entry is still compiling.
    $entry = Invoke-WebRequest -Uri "$baseUrl/@id/__x00__virtual:vinext-app-browser-entry" -UseBasicParsing -TimeoutSec 15
    if ($entry.StatusCode -ne 200 -or $entry.Headers['Content-Type'] -notmatch 'javascript' -or $entry.Content -notmatch 'import') {
      return $false
    }
    return $true
  } catch {
    "$(Get-Date -Format o) health error: $($_.Exception.Message)" | Add-Content -LiteralPath $launchLog
    return $false
  }
}

function Get-ListeningPid([int]$Port) {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { return [int]$listener.OwningProcess }
  $line = netstat -ano -p TCP | Select-String -Pattern "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$" | Select-Object -First 1
  if ($line -and $line.Matches.Count) { return [int]$line.Matches[0].Groups[1].Value }
  return 0
}

function Test-MediaTrashReady {
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5189/' -TimeoutSec 2
    return $health.service -eq 'frameflow-media-recycle-v3' -and $health.available -eq $true
  } catch { return $false }
}

function Ensure-MediaTrashReady {
  # The shortcut starts vinext directly, and may reuse an already running canvas.
  # In both cases ensure the native helper without touching media or GPU tasks.
  $mutex = New-Object System.Threading.Mutex($false, 'Local\Frameflow-MediaTrash-5189')
  $held = $false
  try {
    try { $held = $mutex.WaitOne(15000) } catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Recycle helper startup is busy. Try the shortcut again shortly.' }
    if (Test-MediaTrashReady) { return }
    if (Get-ListeningPid 5189) { throw 'Port 5189 is occupied or unresponsive; nothing was stopped.' }
    $helper = Start-Process -FilePath ($nodeCandidates | Select-Object -First 1) `
      -ArgumentList @('scripts/media-trash-server.mjs') -WorkingDirectory $projectDirectory `
      -RedirectStandardOutput (Join-Path $projectDirectory '.frameflow-recycle.stdout.log') `
      -RedirectStandardError (Join-Path $projectDirectory '.frameflow-recycle.stderr.log') `
      -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline) {
      if (Test-MediaTrashReady) {
        "$(Get-Date -Format o) recycle helper ready pid=$($helper.Id) at 127.0.0.1:5189" | Add-Content -LiteralPath $launchLog
        return
      }
      if ($helper.HasExited) { break }
      Start-Sleep -Milliseconds 250
    }
    throw 'Recycle helper did not become ready. No media was deleted; check .frameflow-recycle.stderr.log.'
  } finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Test-InboxReady {
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5193/' -TimeoutSec 2
    return $health.service -eq 'frameflow-inbox-v1' -and $health.revision -eq 'inbox-asset-ai-20261113'
  } catch { return $false }
}

function Ensure-InboxReady {
  # The desktop shortcut bypasses npm run dev. Repair the helper even if the canvas already runs.
  # Serialise simultaneous shortcut clicks; never reset claims, import files or stop another process.
  $mutex = New-Object System.Threading.Mutex($false, 'Local\Frameflow-Inbox-5193')
  $held = $false
  try {
    try { $held = $mutex.WaitOne(15000) } catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Inbox startup is busy. Try the shortcut again shortly.' }
    if (Test-InboxReady) {
      "$(Get-Date -Format o) inbox reused at 127.0.0.1:5193" | Add-Content -LiteralPath $launchLog
      return
    }
    if (Get-ListeningPid 5193) { throw 'Port 5193 is occupied by another or unresponsive service; nothing was stopped.' }
    $helper = Start-Process -FilePath ($nodeCandidates | Select-Object -First 1) `
      -ArgumentList @('scripts/inbox-server.mjs') -WorkingDirectory $projectDirectory `
      -RedirectStandardOutput (Join-Path $projectDirectory '.frameflow-inbox.stdout.log') `
      -RedirectStandardError (Join-Path $projectDirectory '.frameflow-inbox.stderr.log') `
      -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline) {
      if (Test-InboxReady) {
        "$(Get-Date -Format o) inbox ready pid=$($helper.Id) at 127.0.0.1:5193" | Add-Content -LiteralPath $launchLog
        return
      }
      if ($helper.HasExited) { break }
      Start-Sleep -Milliseconds 250
    }
    throw 'Inbox helper did not become ready. Check .frameflow-inbox.stderr.log; canvas and queued tasks were left untouched.'
  } finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

try {
  if (-not ($nodeCandidates | Select-Object -First 1)) { throw "Node.js was not found. The canvas cannot be started." }
  $port = 5173
  $ready = Test-CanvasReady $port
  "$(Get-Date -Format o) initial ready=$ready" | Add-Content -LiteralPath $launchLog
  if (-not $ready) {
    $existingPid = Get-ListeningPid $port
    if ($existingPid) {
      $process = Get-Process -Id $existingPid -ErrorAction Stop
      $pageIsOurs = $false
      try {
        $page = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
        $pageIsOurs = $page.Content -match '<title>Frameflow'
      } catch { }
      if ($process.ProcessName -eq 'node' -and $pageIsOurs) {
        # A cold compile/slow health probe is not permission to kill the queue owner.
        $existingDeadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $existingDeadline -and -not (Test-CanvasReady $port)) { Start-Sleep -Milliseconds 500 }
        if (-not (Test-CanvasReady $port)) { throw 'The existing canvas is still busy. No process was stopped; try again later.' }
      } else {
        throw 'Port 5173 is occupied or still starting. No process was stopped and no alternate storage origin was opened.'
      }
    }
    if (-not (Test-CanvasReady $port)) {
      # After a reboot / crash vinext's lock file survives, and its PID may now belong to another app (e.g. WeChat):
      # vinext then refuses to start. Nothing listening on the lock's port = stale lock → remove it (never kill anything).
      $lockFile = Join-Path $projectDirectory ".vinext\dev\lock.json"
      if (Test-Path -LiteralPath $lockFile) {
        $lockPort = 0
        try { $lockPort = [int](Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json).port } catch { }
        if (-not $lockPort -or -not (Get-ListeningPid $lockPort)) {
          Remove-Item -LiteralPath $lockFile -Force
          "$(Get-Date -Format o) removed stale vinext lock (port $lockPort not listening)" | Add-Content -LiteralPath $launchLog
        }
      }
      $nodeExecutable = $nodeCandidates | Select-Object -First 1
      Start-Process `
        -FilePath $nodeExecutable `
        -ArgumentList @("node_modules/vinext/dist/cli.js", "dev", "--port", "$port", "--strictPort") `
        -WorkingDirectory $projectDirectory `
        -RedirectStandardOutput (Join-Path $projectDirectory ".frameflow-launch.stdout.log") `
        -RedirectStandardError (Join-Path $projectDirectory ".frameflow-launch.stderr.log") `
        -WindowStyle Hidden

      $deadline = (Get-Date).AddSeconds(120)
      while ((Get-Date) -lt $deadline -and -not (Test-CanvasReady $port)) { Start-Sleep -Milliseconds 500 }
      if (-not (Test-CanvasReady $port)) {
        throw "The canvas did not become healthy. Check .frameflow-launch.stderr.log in the project directory."
      }
    }
  }
  Ensure-MediaTrashReady
  $recycleProxy = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/media-trash" -TimeoutSec 5
  if ($recycleProxy.service -ne 'frameflow-media-recycle-v3' -or $recycleProxy.available -ne $true) { throw 'Recycle proxy did not confirm readiness; no media was deleted.' }
  Ensure-InboxReady
  $inboxProxy = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/inbox?op=projects" -TimeoutSec 10
  if ($null -eq $inboxProxy.projects) { throw 'Canvas inbox proxy did not confirm readiness; existing queue records were preserved.' }
  if (-not $SkipBrowser) {
    "$(Get-Date -Format o) opening browser" | Add-Content -LiteralPath $launchLog
    $browserLaunch = New-Object System.Diagnostics.ProcessStartInfo
    $browserLaunch.FileName = "http://localhost:$port/"
    $browserLaunch.UseShellExecute = $true
    $browserLaunch.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
    [System.Diagnostics.Process]::Start($browserLaunch) | Out-Null
  }
  "$(Get-Date -Format o) ready at http://localhost:$port/" | Add-Content -LiteralPath $launchLog
  Write-Output "Frameflow ready: http://localhost:$port/"
} catch {
  "$(Get-Date -Format o) error: $($_.Exception.Message)" | Add-Content -LiteralPath $launchLog
  if ($SkipBrowser) { Write-Error $_.Exception.Message; exit 1 }
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($_.Exception.Message, "AI Video Canvas", "OK", "Error") | Out-Null
  exit 1
}
