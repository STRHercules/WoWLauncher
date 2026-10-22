#requires -Version 7.2
param(
    [Parameter(Mandatory = $true)][string]$PayloadRoot,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Version,
    [string]$BaseUrl = '',
    [string]$DeliveryConfig = '',
    [string]$PublishRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$BaseUrl = $BaseUrl.Trim()

function Test-UnderPath([string]$Candidate, [string]$Parent) {
    $Candidate.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or
        $Candidate.StartsWith($Parent.TrimEnd('/', '\') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-DeliveryPath([object]$Value, [switch]$Pattern) {
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { throw 'Delivery paths must be non-empty strings.' }
    $path = $Value.Replace('\', '/').TrimEnd('/')
    if ($path.StartsWith('/') -or $path -match '[:\x00-\x1f]' -or
        @($path.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0 -or
        (-not $Pattern -and $path.IndexOfAny([char[]]'*?') -ge 0)) {
        throw "Unsafe delivery path: $Value"
    }
    $path
}

function Test-SelectedPath([string]$Path, [string[]]$Patterns) {
    foreach ($pattern in $Patterns) {
        if ($Path -eq $pattern -or $Path.StartsWith($pattern + '/', [StringComparison]::OrdinalIgnoreCase) -or $Path -like $pattern) { return $true }
    }
    return $false
}

function Get-PayloadUrl([string]$Path) {
    if ($BaseUrl -match '^https?://') {
        $escaped = ($Path.Split('/') | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
        return $BaseUrl.TrimEnd('/') + '/' + $escaped
    }
    return $Path
}

$root = [IO.Path]::TrimEndingDirectorySeparator((Resolve-Path -LiteralPath $PayloadRoot).Path)
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'PayloadRoot must be a directory.' }
$outputFull = [IO.Path]::GetFullPath($OutputPath)
if (-not $DeliveryConfig -and (Test-Path -LiteralPath (Join-Path $root '.delivery.json') -PathType Leaf)) {
    $DeliveryConfig = Join-Path $root '.delivery.json'
}

$includes = @('*')
$excludes = @()
$folders = @()
$configFull = ''
if ($DeliveryConfig) {
    $configFull = (Resolve-Path -LiteralPath $DeliveryConfig).Path
    $policy = Get-Content -LiteralPath $configFull -Raw | ConvertFrom-Json -AsHashtable
    if ($policy -isnot [Collections.IDictionary]) { throw 'Delivery config must be a JSON object.' }
    foreach ($key in $policy.Keys) {
        if ($key -cnotin @('include', 'exclude', 'folders')) { throw "Unknown delivery option: $key" }
    }
    foreach ($key in @('include', 'exclude', 'folders')) {
        if ($policy.Contains($key) -and $policy[$key] -isnot [array]) { throw "$key must be a JSON array." }
        if (-not $policy.Contains($key)) { $policy[$key] = @() }
    }
    $includes = @(foreach ($value in $policy.include) { Assert-DeliveryPath $value -Pattern })
    $excludes = @(foreach ($value in $policy.exclude) { Assert-DeliveryPath $value -Pattern })
    $folders = @(foreach ($folder in $policy.folders) {
        if ($folder -isnot [Collections.IDictionary] -or $folder.Count -ne 2 -or
            -not $folder.Contains('path') -or -not $folder.Contains('delivery') -or
            $folder.delivery -cnotin @('files', 'zip')) { throw 'Each folder needs path and delivery (files or zip).' }
        $path = Assert-DeliveryPath $folder.path
        if (-not (Test-Path -LiteralPath (Join-Path $root $path) -PathType Container)) { throw "Delivery folder does not exist: $path" }
        @{ path = $path; delivery = $folder.delivery }
    })
    foreach ($folder in $folders) {
        if (@($folders | Where-Object {
            $_ -ne $folder -and ($_.path -eq $folder.path -or $_.path.StartsWith($folder.path + '/', [StringComparison]::OrdinalIgnoreCase) -or
                $folder.path.StartsWith($_.path + '/', [StringComparison]::OrdinalIgnoreCase))
        }).Count -gt 0) { throw "Delivery folders must not overlap: $($folder.path)" }
    }
    $includes += @($folders | ForEach-Object { $_.path })
    if (-not $PublishRoot) { throw 'Delivery policies require PublishRoot so only selected payloads are staged.' }
}

$publish = ''
if ($PublishRoot) {
    $publish = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($PublishRoot))
    if ((Test-UnderPath $publish $root) -or (Test-UnderPath $root $publish)) { throw 'PublishRoot and PayloadRoot must be separate, non-nested directories.' }
    if ([IO.Path]::GetDirectoryName($outputFull) -ne $publish) { throw 'OutputPath must be directly inside PublishRoot.' }
    if ((Test-Path -LiteralPath $publish) -and @(Get-ChildItem -LiteralPath $publish -Force).Count -gt 0) {
        throw 'PublishRoot must be empty. Stage each release into a fresh directory to avoid publishing stale or excluded files.'
    }
}

$sourceFiles = @(Get-ChildItem -LiteralPath $root -Force -Recurse | ForEach-Object {
    if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Source contains a link/junction; use real files: $($_.FullName)" }
    if (-not $_.PSIsContainer) { $_ }
} | Where-Object {
    $relative = [IO.Path]::GetRelativePath($root, $_.FullName).Replace('\', '/')
    $_.FullName -ne $outputFull -and $_.FullName -ne $configFull -and
        $_.Name -notin @('.delivery.json', '.delivery-bundles.json', 'manifest-v2.json', 'manifest.json') -and
        -not $_.Name.EndsWith('.esteria-download', [StringComparison]::OrdinalIgnoreCase) -and
        (Test-SelectedPath $relative $includes) -and -not (Test-SelectedPath $relative $excludes)
} | Sort-Object FullName)
if ($sourceFiles.Count -eq 0) { throw 'No files selected for delivery.' }

$entries = @(foreach ($file in $sourceFiles) {
    $relative = Assert-DeliveryPath ([IO.Path]::GetRelativePath($root, $file.FullName).Replace('\', '/'))
    if ($relative.StartsWith('.launcher/', [StringComparison]::OrdinalIgnoreCase)) { throw 'The .launcher folder is reserved for player launcher state; exclude it from delivery.' }
    if ($publish -and ($relative -eq [IO.Path]::GetFileName($outputFull) -or $relative -like '.bundles/*')) {
        throw "Selected path is reserved for delivery metadata: $relative"
    }
    [ordered]@{ path = $relative; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); size = $file.Length }
})

# Use source casing so Rust's component comparisons see the same folder and member paths.
foreach ($folder in $folders) {
    $firstMember = $entries | Where-Object { $_.path.StartsWith($folder.path + '/', [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    if ($firstMember) { $folder.path = $firstMember.path.Substring(0, $folder.path.Length) }
}

$bundles = @(foreach ($folder in $folders | Where-Object { $_.delivery -eq 'zip' }) {
    $members = @($entries | Where-Object { $_.path.StartsWith($folder.path + '/', [StringComparison]::OrdinalIgnoreCase) })
    if ($members.Count -eq 0) { throw "ZIP folder has no selected files: $($folder.path)" }
    [IO.Directory]::CreateDirectory((Join-Path $publish '.bundles')) | Out-Null
    $temporaryArchive = Join-Path $publish ('.bundles/' + [guid]::NewGuid().ToString('N') + '.tmp')
    $zip = [IO.Compression.ZipFile]::Open($temporaryArchive, [IO.Compression.ZipArchiveMode]::Create)
    try {
        # Match the launcher's wrapped-folder ZIP layout, including folders named *.MPQ.
        $parent = $folder.path.LastIndexOf('/') + 1
        foreach ($entry in $members) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root $entry.path), $entry.path.Substring($parent), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $zip.Dispose() }
    $hash = (Get-FileHash -LiteralPath $temporaryArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    $archive = ".bundles/$hash.zip"
    Move-Item -LiteralPath $temporaryArchive -Destination (Join-Path $publish $archive) -Force
    [ordered]@{ path = $folder.path; archive = $archive; sha256 = $hash; size = (Get-Item -LiteralPath (Join-Path $publish $archive)).Length; url = (Get-PayloadUrl $archive) }
})

if ($publish) {
    foreach ($entry in $entries) {
        if (@($bundles | Where-Object { $entry.path.StartsWith($_.path + '/', [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) { continue }
        $destination = Join-Path $publish $entry.path
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        Copy-Item -LiteralPath (Join-Path $root $entry.path) -Destination $destination
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Source changed while staging: $($entry.path). Build again from a stable source." }
        if ($BaseUrl -match '^https?://') { $entry.url = Get-PayloadUrl $entry.path }
    }
    # Verify compressed content against the manifest too, in case source files changed during packaging.
    foreach ($bundle in $bundles) {
        $zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $publish $bundle.archive))
        try {
            $parent = $bundle.path.LastIndexOf('/') + 1
            foreach ($entry in $entries | Where-Object { $_.path.StartsWith($bundle.path + '/', [StringComparison]::OrdinalIgnoreCase) }) {
                $stream = $zip.GetEntry($entry.path.Substring($parent)).Open()
                try { $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) } finally { $stream.Dispose() }
                if ($hash -ne $entry.sha256) { throw "Source changed while zipping: $($entry.path). Build again from a stable source." }
            }
        } finally { $zip.Dispose() }
    }
}

$manifest = [ordered]@{ schemaVersion = 2; version = $Version; files = $entries; bundles = $bundles }
if (-not [string]::IsNullOrWhiteSpace($BaseUrl)) { $manifest.baseUrl = $BaseUrl.TrimEnd('/', '\') + '/' }
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputFull)) | Out-Null
# Write the manifest last; a failed build must never advertise an incomplete release.
[IO.File]::WriteAllText($outputFull, ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Write-Host "Esteria manifest written to: $outputFull"
Write-Host "Files: $($entries.Count); ZIP bundles: $($bundles.Count)"
