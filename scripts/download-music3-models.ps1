$ErrorActionPreference = 'Stop'
$comfyRoot = if ($env:FRAMEFLOW_COMFYUI_ROOT) { $env:FRAMEFLOW_COMFYUI_ROOT } else { 'C:/ComfyUI_windows_portable/ComfyUI' }
$modelRoot = Join-Path $comfyRoot 'models'
$revision = '9e364ccd290a401561091fb441ed19cd7de92550'
$files = @(
  @{ path='vae/minimax_music3_dav.safetensors'; size=216696128L; sha='2a32155b769be01445fcc2a8663b910fc9e1751e18dc1c3ec528064512d9ef0c' },
  @{ path='diffusion_models/minimax_music3_dit_fp16.safetensors'; size=4914197682L; sha='45494a2b6b69af115902ff28eaf54118d19067aa54da01000f3e3efce7ba0e34' },
  @{ path='text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors'; size=9196611886L; sha='010b7416d2336a08c711bc22ee65849c9623069ddb7d89bec011a75699e52014' }
)
$remaining = 0L
foreach ($file in $files) {
  $target = Join-Path $modelRoot $file.path
  if (-not (Test-Path -LiteralPath $target)) { $remaining += $file.size }
}
if ((Get-Volume -DriveLetter D).SizeRemaining - $remaining -lt 5GB) { throw 'Insufficient free space to download the models while keeping 5 GiB available.' }
foreach ($file in $files) {
  $target = [IO.Path]::GetFullPath((Join-Path $modelRoot $file.path))
  if (-not $target.StartsWith([IO.Path]::GetFullPath($modelRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Model path escaped the intended directory.' }
  if (Test-Path -LiteralPath $target) {
    if ((Get-Item -LiteralPath $target).Length -ne $file.size -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha) { throw "Existing model differs; preserving it: $($file.path)" }
    Write-Output "Already verified: $($file.path)"
    continue
  }
  $partial = $target + '.frameflow-download.part'
  $parent = Split-Path -Parent $target
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
  Write-Output "Downloading $($file.path) ($($file.size) bytes)"
  & curl.exe --location --fail --silent --show-error --retry 3 --retry-delay 3 --connect-timeout 30 --continue-at - --output $partial "https://huggingface.co/Comfy-Org/MiniMax-Music-3/resolve/$revision/$($file.path)"
  if ($LASTEXITCODE -ne 0) { throw "Download failed; resumable partial retained: $($file.path)" }
  if ((Get-Item -LiteralPath $partial).Length -ne $file.size) { throw "Downloaded size mismatch: $($file.path)" }
  Write-Output "Checking SHA256: $($file.path)"
  if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha) { throw "Downloaded hash mismatch; partial retained: $($file.path)" }
  Move-Item -LiteralPath $partial -Destination $target
  Write-Output "Installed and verified: $($file.path)"
}
Write-Output 'All three MiniMax Music 3 models downloaded and SHA256 verified.'
