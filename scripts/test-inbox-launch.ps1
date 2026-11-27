$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'launch-canvas.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$source = Get-Content -LiteralPath $scriptPath -Raw
if ($source -match 'Stop-Process|5174') { throw 'Launcher must not kill queue owner or switch browser storage origin' }
if ($source -notmatch '(?s)Ensure-InboxReady\s+\$inboxProxy.+?if \(-not \$SkipBrowser\)') { throw 'Helper must be checked even for an existing healthy canvas' }
$fn = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Ensure-InboxReady'}, $true)
if (-not $fn) { throw 'Missing helper startup function' }
# Execute only our own startup function against stubs. No real servers, queue/files, or GPU calls.
Invoke-Expression $fn.Extent.Text
$script:checks=0; $script:starts=0; $script:mode='reuse'
$nodeCandidates=@('node.exe'); $projectDirectory=$PSScriptRoot; $launchLog='unused-test-log'
function Test-InboxReady {
  $script:checks++
  return $script:mode -eq 'reuse' -or ($script:mode -eq 'start' -and $script:checks -gt 1)
}
function Get-ListeningPid { param([int]$Port) if ($script:mode -eq 'occupied') { return 42 }; return 0 }
function Start-Process {
  param($FilePath,$ArgumentList,$WorkingDirectory,$RedirectStandardOutput,$RedirectStandardError,$WindowStyle,[switch]$PassThru)
  if ($WindowStyle -ne 'Hidden' -or $ArgumentList[0] -ne 'scripts/inbox-server.mjs') { throw 'Unsafe startup arguments' }
  $script:starts++
  return [pscustomobject]@{Id=123;HasExited=($script:mode -eq 'exited')}
}
function Add-Content { param($LiteralPath,[Parameter(ValueFromPipeline=$true)]$Value) process {} }
Ensure-InboxReady
if ($script:starts -ne 0) { throw 'Reusing helper started a duplicate process' }
$script:mode='start'; $script:checks=0
Ensure-InboxReady
if ($script:starts -ne 1) { throw 'Missing helper was not started exactly once' }
foreach($case in @('occupied','exited')) {
  $script:mode=$case; $script:checks=0; $failed=$false
  try { Ensure-InboxReady } catch { $failed=$true }
  if (-not $failed) { throw "Expected bounded startup failure: $case" }
}
if ($script:starts -ne 2) { throw 'Occupied port must not start a replacement' }
Write-Output 'PASS launcher parse, existing-helper reuse, missing-helper hidden startup, occupied-port refusal, exited-child failure; no real queues/GPU touched.'
