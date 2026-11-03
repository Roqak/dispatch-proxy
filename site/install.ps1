# Dispatch installer for Windows.
#   irm https://<site>/install.ps1 | iex
# Downloads the latest x64 setup.exe and runs it silently.
$ErrorActionPreference = 'Stop'
$repo = 'Roqak/dispatch'

Write-Host '==> Finding the latest Dispatch release for Windows' -ForegroundColor Green
$releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=10" -Headers @{ Accept = 'application/vnd.github+json' }
# Newest first; a release missing the Windows build falls back to the previous one.
$asset = $releases | ForEach-Object { $_.assets } | Where-Object { $_.name -like '*_x64-setup.exe' } | Select-Object -First 1
if (-not $asset) { throw "No Windows build found in recent releases (https://github.com/$repo/releases)" }

$out = Join-Path $env:TEMP $asset.name
Write-Host "==> Downloading $($asset.name)" -ForegroundColor Green
Invoke-WebRequest $asset.browser_download_url -OutFile $out -UseBasicParsing

Write-Host '==> Installing' -ForegroundColor Green
Start-Process -FilePath $out -ArgumentList '/S' -Wait
Remove-Item $out -ErrorAction SilentlyContinue
Write-Host '==> Dispatch installed. Find it in the Start menu.' -ForegroundColor Green
