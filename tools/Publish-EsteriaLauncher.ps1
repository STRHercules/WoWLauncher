param(
    [Parameter(Mandatory = $true)]
    [string]$UpdatesRoot,

    [string]$BundleRoot = '',
    [string]$BaseUrl = 'http://planetkai.hopto.org:7384/launcher-updates/',
    [string]$Version = '',
    [string]$Notes = 'Esteria Launcher update'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($BundleRoot)) {
    $BundleRoot = Join-Path $PSScriptRoot '..\src-tauri\target\release\bundle\nsis'
}
$bundleRootResolved = (Resolve-Path -LiteralPath $BundleRoot).Path
$installer = Get-ChildItem -LiteralPath $bundleRootResolved -Filter '*setup.exe' -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $installer) {
    throw "No NSIS setup executable was found in $bundleRootResolved"
}

$sigPath = "$($installer.FullName).sig"
if (-not (Test-Path -LiteralPath $sigPath -PathType Leaf)) {
    throw "Signed updater artifact is missing: $sigPath. Build with TAURI_SIGNING_PRIVATE_KEY set."
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    $configPath = Join-Path $PSScriptRoot '..\src-tauri\tauri.conf.json'
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $Version = [string]$config.version
}
if ($Version -notmatch '^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "Version must be valid SemVer. Received: $Version"
}

New-Item -ItemType Directory -Force -Path $UpdatesRoot | Out-Null
$destinationInstaller = Join-Path $UpdatesRoot $installer.Name
Copy-Item -LiteralPath $installer.FullName -Destination $destinationInstaller -Force
Copy-Item -LiteralPath $sigPath -Destination "$destinationInstaller.sig" -Force

$base = $BaseUrl.TrimEnd('/') + '/'
$signature = (Get-Content -LiteralPath $sigPath -Raw).Trim()
$latest = [ordered]@{
    version = $Version.TrimStart('v')
    notes = $Notes
    pub_date = (Get-Date).ToUniversalTime().ToString('o')
    platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
            signature = $signature
            url = $base + [uri]::EscapeDataString($installer.Name)
        }
    }
}

$latestPath = Join-Path $UpdatesRoot 'latest.json'
$tempPath = "$latestPath.tmp"
$json = $latest | ConvertTo-Json -Depth 8
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tempPath, $json, $utf8NoBom)
Move-Item -LiteralPath $tempPath -Destination $latestPath -Force

Write-Output "Published Esteria Launcher $Version"
Write-Output "Installer: $destinationInstaller"
Write-Output "Signature: $destinationInstaller.sig"
Write-Output "Metadata: $latestPath"
