<#
.SYNOPSIS
  Rebrands the launcher for another server: application name, application ID, and icons.

.DESCRIPTION
  Reads the branding currently applied to this checkout from branding.json, replaces the old
  name and application ID everywhere they are compiled in or shown, then writes the new values
  back to branding.json. Safe to run repeatedly.

.EXAMPLE
  .\tools\Set-Branding.ps1 -Name 'Azeroth'

.EXAMPLE
  .\tools\Set-Branding.ps1 -Name 'Azeroth' -Icon 'C:\art\azeroth-icon.png'
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [string]$Identifier = '',

    [string]$Icon = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$brandPath = Join-Path $repoRoot 'branding.json'

$Name = $Name.Trim()
if ([string]::IsNullOrWhiteSpace($Name)) {
    throw 'A name is required.'
}
if ($Name -match '["\\\r\n]') {
    throw 'The name cannot contain quotes, backslashes, or line breaks.'
}
if ($Name -match '(?i)\blauncher\s*$') {
    throw "Pass the brand word only, for example -Name 'Azeroth' instead of -Name 'Azeroth Launcher'."
}

# Files that carry branding. README.md is deliberately excluded: it documents the upstream
# Esteria project and also mentions unrelated paths such as ...\EsteriaWoW.
$brandedFiles = @(
    'package.json',
    'Run-Launcher.cmd',
    'src-tauri/Cargo.toml',
    'src-tauri/tauri.conf.json',
    'src-tauri/src/main.rs',
    'ui/index.html',
    'ui/app.js',
    'ui/chat.html',
    'ui/chat.js',
    'ui/styles.css',
    'ui/chat.css',
    'tools/Publish-EsteriaLauncher.ps1',
    'tools/New-EsteriaManifest.ps1'
)

$current = Get-Content -LiteralPath $brandPath -Raw | ConvertFrom-Json
$previousName = [string]$current.name
$previousIdentifier = [string]$current.identifier

if ([string]::IsNullOrWhiteSpace($Identifier)) {
    $slug = ($Name.ToLowerInvariant() -replace '[^a-z0-9]', '')
    if ([string]::IsNullOrWhiteSpace($slug)) { $slug = 'server' }
    $Identifier = "gg.$slug.launcher"
}

if ($previousName -eq $Name -and $previousIdentifier -eq $Identifier -and [string]::IsNullOrWhiteSpace($Icon)) {
    Write-Output 'Branding is already up to date. Nothing to do.'
    return
}

# The executable keeps the Cargo package name (esteria-launcher.exe), so only mixed-case
# display text and the application ID change here.
$replacements = [ordered]@{}
if ($previousName -and $previousName -ne $Name) { $replacements[$previousName] = $Name }
if ($previousIdentifier -and $previousIdentifier -ne $Identifier) { $replacements[$previousIdentifier] = $Identifier }

# A literal rename hits every mention of the word, including unrelated copy. Flag that up front
# so a name already used in the launcher text is a deliberate choice rather than a surprise.
$collisions = foreach ($relative in $brandedFiles) {
    $path = Join-Path $repoRoot $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    $text = [System.IO.File]::ReadAllText($path)
    foreach ($pair in $replacements.GetEnumerator()) {
        if ($text.Contains($pair.Value)) { $relative; break }
    }
}
if ($collisions) {
    Write-Warning "The new name already appears in: $($collisions -join ', '). Those mentions are replaced too."
}
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
foreach ($relative in $brandedFiles) {
    $path = Join-Path $repoRoot $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    $text = [System.IO.File]::ReadAllText($path)
    $updated = $text
    foreach ($pair in $replacements.GetEnumerator()) {
        $updated = $updated.Replace($pair.Key, $pair.Value)
    }
    if ($updated -ne $text) {
        [System.IO.File]::WriteAllText($path, $updated, $utf8NoBom)
        Write-Output "Updated $relative"
    }
}

# Fail loudly rather than shipping a half-renamed launcher.
if ($previousName -and $previousName -ne $Name) {
    $leftovers = foreach ($relative in $brandedFiles) {
        $path = Join-Path $repoRoot $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        if ([System.IO.File]::ReadAllText($path).Contains($previousName)) { $relative }
    }
    if ($leftovers) {
        throw "The old name is still present in: $($leftovers -join ', ')"
    }
}

$current.name = $Name
$current.identifier = $Identifier
[System.IO.File]::WriteAllText($brandPath, ($current | ConvertTo-Json -Depth 4), $utf8NoBom)

if (-not [string]::IsNullOrWhiteSpace($Icon)) {
    $iconPath = (Resolve-Path -LiteralPath $Icon).Path
    Write-Output "Generating icons from $iconPath"
    Push-Location $repoRoot
    try {
        & npx --yes '@tauri-apps/cli@2.12.1' icon $iconPath
        if ($LASTEXITCODE -ne 0) { throw "tauri icon failed with exit code $LASTEXITCODE." }
    }
    finally {
        Pop-Location
    }

    $ico = Join-Path $repoRoot 'src-tauri/icons/icon.ico'
    if (-not (Test-Path -LiteralPath $ico -PathType Leaf)) {
        throw 'tauri icon did not produce src-tauri/icons/icon.ico.'
    }
    # build.rs recreates icon.ico from this fallback when the file is missing.
    [System.IO.File]::WriteAllText(
        (Join-Path $repoRoot 'src-tauri/icon.b64'),
        [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($ico)),
        $utf8NoBom)
    Write-Output 'Refreshed src-tauri/icon.b64 from the new icon.ico'
}

Write-Output ''
Write-Output "Branding applied: $Name ($Identifier)"
Write-Output 'Build with: npx --yes @tauri-apps/cli@2.12.1 build'