param([ValidateRange(1, 65535)][int]$Port = 5173)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$nodeCandidates = @(
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
  (Join-Path $env:ProgramFiles "nodejs\node.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

$nodeExecutable = $nodeCandidates | Select-Object -First 1
if (-not $nodeExecutable) { throw "Node.js was not found." }

$stdoutLog = Join-Path $projectDirectory ".frameflow-dev.stdout.log"
$stderrLog = Join-Path $projectDirectory ".frameflow-dev.stderr.log"
Set-Location -LiteralPath $projectDirectory

# Vite owns the /comfyui HTTP and WebSocket proxy.
& $nodeExecutable "node_modules/vinext/dist/cli.js" "dev" "--port" "$Port" "--strictPort" 1>> $stdoutLog 2>> $stderrLog
exit $LASTEXITCODE
