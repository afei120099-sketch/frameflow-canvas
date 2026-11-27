$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'launch-canvas.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$fn = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-CanvasReady'}, $true)
Invoke-Expression $fn.Extent.Text
$launchLog = 'unused-test-log'
function Add-Content { param($LiteralPath,[Parameter(ValueFromPipeline=$true)]$Value) process {} }
function Invoke-WebRequest {
  param($Uri,[switch]$UseBasicParsing,$TimeoutSec)
  if ($Uri.EndsWith('/@vite/client')) { return @{StatusCode=200; Content='WebSocket'} }
  if ($Uri.EndsWith('/')) { return @{StatusCode=200; Content='<title>Frameflow</title>'} }
  if ($script:mode -eq 'unavailable') { throw 'Entry not compiled' }
  if ($script:mode -eq 'html-fallback') { return @{StatusCode=200; Content='<title>Frameflow</title>'; Headers=@{'Content-Type'='text/html'}} }
  return @{StatusCode=200; Content='import "/app/page.tsx"'; Headers=@{'Content-Type'='text/javascript'}}
}
foreach ($case in @('unavailable','html-fallback','ready')) {
  $script:mode=$case
  if ((Test-CanvasReady 5173) -ne ($case -eq 'ready')) { throw "Readiness incorrectly accepted/rejected: $case" }
}
Write-Output 'PASS launcher waits for JavaScript browser entry; HTML-only and compilation failures do not count as ready; no real servers or GPU.'
