param([string]$InstallerPath)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$pin = Get-Content -LiteralPath (Join-Path $repoRoot 'ru-sidecar-source.json') -Raw | ConvertFrom-Json
$staging = Join-Path $repoRoot 'tmp/ru-upstream'
New-Item -ItemType Directory -Path $staging -Force | Out-Null
if (-not $InstallerPath) {
    $InstallerPath = Join-Path $staging $pin.asset
    $url = 'https://github.com/' + $pin.repo + '/releases/download/' + $pin.tag + '/' + $pin.asset
    Invoke-WebRequest -Uri $url -OutFile $InstallerPath
}
$actual = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $pin.installerSha256) { throw 'Official installer SHA-256 mismatch' }
$sevenZip = Join-Path $repoRoot 'node_modules/electron-winstaller/vendor/7z.exe'
if (-not (Test-Path -LiteralPath $sevenZip)) { throw 'Install locked GUI dependencies before preparing the sidecar' }
$extracted = Join-Path $staging 'installer'
& $sevenZip x $InstallerPath "-o$extracted" -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not extract official installer' }
$archive = Get-ChildItem -LiteralPath $extracted -Recurse -Filter app-64.7z | Select-Object -First 1
if (-not $archive) { throw 'Official installer has no Windows x64 payload' }
$payload = Join-Path $staging 'payload'
& $sevenZip x $archive.FullName 'resources/omp.exe' "-o$payload" -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not extract official sidecar' }
$sidecar = Join-Path $payload 'resources/omp.exe'
$actualSidecar = (Get-FileHash -LiteralPath $sidecar -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSidecar -ne $pin.sidecarSha256) { throw 'Official sidecar SHA-256 mismatch' }
Copy-Item -LiteralPath $sidecar -Destination (Join-Path $repoRoot 'resources/omp.exe') -Force
Write-Host "Verified official sidecar: $actualSidecar"
