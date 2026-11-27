$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'launch-canvas.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$source = Get-Content -LiteralPath $scriptPath -Raw
if ($source -match 'Stop-Process|5174') { throw 'Launcher must not stop jobs or change storage origin' }
if ($source -notmatch '(?s)Ensure-MediaTrashReady\s+\$recycleProxy.+?Ensure-InboxReady') { throw 'Recycle helper readiness must precede browser open even when canvas is already running' }
$fn = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Ensure-MediaTrashReady'}, $true)
if (-not $fn) { throw 'Missing recycle helper startup function' }
Invoke-Expression $fn.Extent.Text
$script:checks=0; $script:starts=0; $script:mode='reuse'
$nodeCandidates=@('node.exe'); $projectDirectory=$PSScriptRoot; $launchLog='unused-test-log'
function Test-MediaTrashReady {
  $script:checks++
  return $script:mode -eq 'reuse' -or ($script:mode -eq 'start' -and $script:checks -gt 1)
}
function Get-ListeningPid { param([int]$Port) if ($Port -ne 5189) { throw 'Wrong port' }; if ($script:mode -eq 'occupied') { return 42 }; return 0 }
function Start-Process {
  param($FilePath,$ArgumentList,$WorkingDirectory,$RedirectStandardOutput,$RedirectStandardError,$WindowStyle,[switch]$PassThru)
  if ($WindowStyle -ne 'Hidden' -or $ArgumentList[0] -ne 'scripts/media-trash-server.mjs') { throw 'Unsafe startup arguments' }
  $script:starts++
  return [pscustomobject]@{Id=123;HasExited=($script:mode -eq 'exited')}
}
function Add-Content { param($LiteralPath,[Parameter(ValueFromPipeline=$true)]$Value) process {} }
Ensure-MediaTrashReady
if ($script:starts -ne 0) { throw 'Duplicate helper on reuse' }
$script:mode='start'; $script:checks=0
Ensure-MediaTrashReady
if ($script:starts -ne 1) { throw 'Missing helper not started exactly once' }
foreach($case in @('occupied','exited')) {
  $script:mode=$case; $script:checks=0; $failed=$false
  try { Ensure-MediaTrashReady } catch { $failed=$true }
  if (-not $failed) { throw "Expected bounded startup failure: $case" }
}
if ($script:starts -ne 2) { throw 'Occupied port started a replacement' }
Write-Output 'PASS recycle launcher: parse, reuse, missing helper hidden startup, occupied port preserved, failed child reported; mocks only, no files recycled.'
