param(
  [string]$Name = "",
  [string]$Id = "",
  [int]$Port = 0,
  [switch]$SkipBrowser
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$known = @{}
if ($env:NEXT_PUBLIC_FRAMEFLOW_SPLIT_PAGES) {
  foreach ($entry in ($env:NEXT_PUBLIC_FRAMEFLOW_SPLIT_PAGES | ConvertFrom-Json)) {
    $known[$entry.id] = @{ Name = $entry.label; Port = $entry.port; InboxPort = $entry.inboxPort; ClaimPort = $entry.claimPort }
  }
}
if (-not $Id -and $Name) {
  $found = $known.GetEnumerator() | Where-Object { $_.Value.Name -eq $Name } | Select-Object -First 1
  if ($found) { $Id = $found.Key }
}
if (-not $Id) { $Id = ([regex]::Replace($Name, "[^A-Za-z0-9]+", "")).ToLower() }
if (-not $Id) { throw "Pass -Id or -Name. The default canvas stays on scripts/launch-canvas.ps1." }
$spec = $known[$Id]
$displayName = if ($Name) { $Name } elseif ($spec) { $spec.Name } else { $Id }
if (-not $Port) { if (-not $spec) { throw "Pass -Port for a canvas that is not in the built-in list." }; $Port = [int]$spec.Port }
if ($Port -eq 5173) { throw "Port 5173 is the default canvas. Use scripts/launch-canvas.ps1. Nothing was started." }
$inboxPort = if ($spec) { [int]$spec.InboxPort } else { 5300 + ($Port % 200) }
$claimPort = if ($spec) { [int]$spec.ClaimPort } else { 8900 + ($Port % 200) }
if ($inboxPort -in @(5192,5193) -or $claimPort -eq 8791) { throw "This instance would use the default inbox. Nothing was started." }
$dataRoot = if ($env:FRAMEFLOW_DATA_ROOT) { $env:FRAMEFLOW_DATA_ROOT } else { Join-Path $projectDirectory "data" }
$inboxRoot = Join-Path $dataRoot ("inbox_" + $Id)
$launchLog = Join-Path $projectDirectory ".frameflow-instance-$Id.log"

$nodeCandidates = @(
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
  (Join-Path $env:ProgramFiles "nodejs\node.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

function Get-ListeningPid([int]$LocalPort) {
  $listener = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { return [int]$listener.OwningProcess }
  $line = netstat -ano -p TCP | Select-String -Pattern "^\s*TCP\s+\S+:$LocalPort\s+\S+\s+LISTENING\s+(\d+)\s*$" | Select-Object -First 1
  if ($line -and $line.Matches.Count) { return [int]$line.Matches[0].Groups[1].Value }
  return 0
}

function Test-CanvasReady([int]$LocalPort) {
  $baseUrl = "http://127.0.0.1:$LocalPort"
  try {
    $page = Invoke-WebRequest -Uri "$baseUrl/" -UseBasicParsing -TimeoutSec 2
    if ($page.StatusCode -ne 200 -or $page.Content -notmatch "<title>Frameflow") { return $false }
    $vite = Invoke-WebRequest -Uri "$baseUrl/@vite/client" -UseBasicParsing -TimeoutSec 2
    if ($vite.StatusCode -ne 200 -or $vite.Content -notmatch "WebSocket") { return $false }
    $entry = Invoke-WebRequest -Uri "$baseUrl/@id/__x00__virtual:vinext-app-browser-entry" -UseBasicParsing -TimeoutSec 15
    return $entry.StatusCode -eq 200 -and $entry.Headers["Content-Type"] -match "javascript" -and $entry.Content -match "import"
  } catch { return $false }
}

function Test-MediaTrashReady {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:5189/" -TimeoutSec 2
    return $health.service -eq "frameflow-media-recycle-v3" -and $health.available -eq $true
  } catch { return $false }
}

function Ensure-MediaTrashReady {
  $mutex = New-Object System.Threading.Mutex($false, "Local\Frameflow-MediaTrash-5189")
  $held = $false
  try {
    try { $held = $mutex.WaitOne(15000) } catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw "Recycle helper startup is busy. Try the shortcut again shortly." }
    if (Test-MediaTrashReady) { return }
    if (Get-ListeningPid 5189) { throw "Port 5189 is occupied or unresponsive; nothing was stopped." }
    Start-Process -FilePath ($nodeCandidates | Select-Object -First 1) -ArgumentList @("scripts/media-trash-server.mjs") -WorkingDirectory $projectDirectory -WindowStyle Hidden | Out-Null
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline) { if (Test-MediaTrashReady) { return }; Start-Sleep -Milliseconds 250 }
    throw "Recycle helper did not become ready. No media was deleted."
  } finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}

function Test-InboxReady([int]$LocalPort) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/" -TimeoutSec 2
    return $health.service -eq "frameflow-inbox-v1" -and $health.revision -eq "inbox-asset-ai-20261113" -and $health.root -eq $inboxRoot
  } catch { return $false }
}

try {
  if (-not ($nodeCandidates | Select-Object -First 1)) { throw "Node.js was not found." }
  "$(Get-Date -Format o) instance=$Id name=$displayName port=$Port" | Add-Content -LiteralPath $launchLog
  New-Item -ItemType Directory -Force -Path $inboxRoot | Out-Null
  $env:FRAMEFLOW_INSTANCE_ID = $Id
  $env:FRAMEFLOW_INSTANCE_NAME = $displayName
  $env:FRAMEFLOW_INBOX_PORT = "$inboxPort"
  $env:FRAMEFLOW_INBOX_ROOT = $inboxRoot
  $env:FRAMEFLOW_CLAIM_PORT = "$claimPort"
  # Keep the optimizer cache under node_modules. A cache outside it is parsed again and Vite's commonjs plugin emits a second default export.
  $env:FRAMEFLOW_VITE_CACHE = "node_modules\.vite-$Id"
  $cacheDir = Join-Path $projectDirectory $env:FRAMEFLOW_VITE_CACHE
  $sharedCache = Join-Path $projectDirectory "node_modules\.vite"
  if (-not (Test-Path -LiteralPath (Join-Path $cacheDir "deps")) -and (Test-Path -LiteralPath (Join-Path $sharedCache "deps"))) {
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    & robocopy $sharedCache $cacheDir /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
  }
  $env:VINEXT_NO_DEV_LOCK = "1"
  $env:WRANGLER_REGISTRY_PATH = ".wrangler\instances\$Id\dev-registry"
  $env:MINIFLARE_REGISTRY_PATH = ".wrangler\instances\$Id\registry"
  $env:WRANGLER_LOG_PATH = ".wrangler\instances\$Id\logs"
  $node = $nodeCandidates | Select-Object -First 1
  if (-not (Test-InboxReady $inboxPort)) {
    if (Get-ListeningPid $inboxPort) { throw "Port $inboxPort is occupied. Nothing was stopped." }
    Start-Process -FilePath $node -ArgumentList @("scripts/inbox-server.mjs") -WorkingDirectory $projectDirectory -RedirectStandardOutput (Join-Path $projectDirectory ".frameflow-inbox-$Id.stdout.log") -RedirectStandardError (Join-Path $projectDirectory ".frameflow-inbox-$Id.stderr.log") -WindowStyle Hidden | Out-Null
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline -and -not (Test-InboxReady $inboxPort)) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-InboxReady $inboxPort)) { throw "Inbox helper did not become ready on $inboxPort." }
  }
  $transferReady = $false
  try {
    $transfer = Invoke-RestMethod -Uri "http://127.0.0.1:5198/" -TimeoutSec 2
    $transferReady = $transfer.service -eq "frameflow-page-transfer-v1"
  } catch { $transferReady = $false }
  if (-not $transferReady) {
    if (Get-ListeningPid 5198) { throw "Port 5198 is occupied by something else. Nothing was stopped." }
    Start-Process -FilePath $node -ArgumentList @("scripts/page-transfer-server.mjs") -WorkingDirectory $projectDirectory -WindowStyle Hidden | Out-Null
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline -and -not $transferReady) {
      try { $transferReady = (Invoke-RestMethod -Uri "http://127.0.0.1:5198/" -TimeoutSec 2).service -eq "frameflow-page-transfer-v1" } catch { $transferReady = $false }
      if (-not $transferReady) { Start-Sleep -Milliseconds 250 }
    }
    if (-not $transferReady) { throw "Page transfer helper did not become ready on 5198." }
  }
  if (-not (Test-CanvasReady $Port)) {
    if (Get-ListeningPid $Port) { throw "Port $Port is occupied or still starting. Nothing was stopped." }
    Start-Process -FilePath $node -ArgumentList @("node_modules/vinext/dist/cli.js", "dev", "--port", "$Port", "--strictPort") -WorkingDirectory $projectDirectory -RedirectStandardOutput (Join-Path $projectDirectory ".frameflow-instance-$Id.stdout.log") -RedirectStandardError (Join-Path $projectDirectory ".frameflow-instance-$Id.stderr.log") -WindowStyle Hidden | Out-Null
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline -and -not (Test-CanvasReady $Port)) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-CanvasReady $Port)) { throw "The canvas did not become healthy on $Port. Check .frameflow-instance-$Id.stderr.log." }
  }
  Ensure-MediaTrashReady
  if (-not $SkipBrowser) {
    # localhost, not 127.0.0.1: IndexedDB is isolated by hostname. No extra Chrome profile flags.
    Start-Process chrome "http://localhost:$Port/"
  }
  Write-Output "Frameflow $displayName ready: http://localhost:$Port/"
} catch {
  "$(Get-Date -Format o) error: $($_.Exception.Message)" | Add-Content -LiteralPath $launchLog
  if ($SkipBrowser) { Write-Error $_.Exception.Message; exit 1 }
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($_.Exception.Message, "AI Video Canvas", "OK", "Error") | Out-Null
  exit 1
}
