#requires -Version 7.2
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$generator = Join-Path $PSScriptRoot 'New-EsteriaManifest.ps1'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('esteria-delivery-test-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $scratch 'source'
[IO.Directory]::CreateDirectory($source) | Out-Null

function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Write-Fixture([string]$Path, [string]$Text) {
    $full = Join-Path $source $Path
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($full)) | Out-Null
    [IO.File]::WriteAllText($full, $Text)
}
function Build-Release([string]$Name, [object]$Policy, [string]$BaseUrl = '') {
    $config = Join-Path $source '.delivery.json'
    [IO.File]::WriteAllText($config, ($Policy | ConvertTo-Json -Depth 8))
    $release = Join-Path $scratch $Name
    & $generator -PayloadRoot $source -PublishRoot $release -OutputPath (Join-Path $release 'manifest.json') -Version 'test-1' -BaseUrl $BaseUrl
    Get-Content -LiteralPath (Join-Path $release 'manifest.json') -Raw | ConvertFrom-Json
}
function Assert-Rejected([string]$Name, [object]$Policy, [string]$Message) {
    $rejected = $false
    try { Build-Release $Name $Policy | Out-Null } catch { $rejected = $true }
    Assert $rejected $Message
    Assert (-not (Test-Path -LiteralPath (Join-Path $scratch "$Name/manifest.json"))) 'Failed build advertised a manifest.'
}

try {
    Write-Fixture 'Wow.exe' 'game'
    Write-Fixture 'Data/Patch-Housing.MPQ/a.txt' 'managed-a'
    Write-Fixture 'Data/Patch-Housing.MPQ/nested/b.txt' 'managed-b'
    Write-Fixture 'Data/Patch-Housing.MPQ/local.ini' 'do not ship'
    Write-Fixture 'Data/Patch-Housing.MPQ-old/secret.txt' 'prefix boundary'
    Write-Fixture 'Extensions/a #100%.dll' 'extension'
    Write-Fixture 'Extensions/debug.pdb' 'symbols'
    Write-Fixture 'Logs/player.log' 'private'
    Write-Fixture 'partial.esteria-download' 'partial'
    $policy = @{ include = @('Wow.exe'); exclude = @('*.pdb', '**/local.ini'); folders = @(
        @{ path = 'Data/Patch-Housing.MPQ'; delivery = 'zip' },
        @{ path = 'Extensions'; delivery = 'files' }
    ) }
    $manifest = Build-Release 'zipped' $policy
    Assert ($manifest.files.Count -eq 4) 'Selection/exclusions did not produce exactly four files.'
    Assert ($manifest.bundles.Count -eq 1) 'Expected exactly one bundle.'
    $bundle = $manifest.bundles[0]
    $release = Join-Path $scratch 'zipped'
    Assert (-not (Test-Path -LiteralPath (Join-Path $release 'Data'))) 'Zipped files were also staged loose.'
    $inventory = @(Get-ChildItem -LiteralPath $release -Recurse -Force -File)
    Assert ($inventory.Count -eq 4) 'Publish tree contains unintended files.'
    $archive = Join-Path $release $bundle.archive
    Assert ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -eq $bundle.sha256) 'Bundle hash mismatch.'
    Assert ((Get-Item -LiteralPath $archive).Length -eq $bundle.size) 'Bundle size mismatch.'
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        Assert ($zip.Entries.Count -eq 2) 'ZIP contains excluded or extra files.'
        foreach ($file in $manifest.files | Where-Object { $_.path.StartsWith($bundle.path + '/') }) {
            $entry = $zip.GetEntry($file.path.Substring($bundle.path.LastIndexOf('/') + 1))
            Assert ($null -ne $entry) 'ZIP is missing a selected file.'
            $stream = $entry.Open()
            try { $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) } finally { $stream.Dispose() }
            Assert ($hash -eq $file.sha256 -and $entry.Length -eq $file.size) 'Extracted content does not match manifest.'
        }
    } finally { $zip.Dispose() }

    $policy.folders[0].delivery = 'files'
    $loose = Build-Release 'loose' $policy 'https://cdn.example.test/client/release-1/'
    Assert ($loose.bundles.Count -eq 0) 'files mode still created a ZIP.'
    Assert (Test-Path -LiteralPath (Join-Path $scratch 'loose/Data/Patch-Housing.MPQ/nested/b.txt')) 'files mode did not stage folder contents.'
    Assert (($loose.files | Where-Object { $_.path -like 'Extensions/*' }).url -eq 'https://cdn.example.test/client/release-1/Extensions/a%20%23100%25.dll') 'URL encoding is incorrect.'

    $policy.folders[0].delivery = 'zip'
    $policy.folders[0].path = 'data/patch-housing.mpq'
    $cased = Build-Release 'casing' $policy
    Assert ($cased.bundles[0].path -ceq 'Data/Patch-Housing.MPQ') 'Bundle paths must match source casing for launcher comparisons.'

    $single = Build-Release 'single' @{ include = @('Wow.exe') }
    Assert ($single.files -is [array] -and $single.files.Count -eq 1) 'Single-file manifests must use a JSON array.'
    $wildcard = Build-Release 'wildcard' @{ include = @('*'); exclude = @('Data', 'Logs', 'Extensions', '*.esteria-download') }
    Assert ($wildcard.files.Count -eq 1 -and $wildcard.files[0].path -eq 'Wow.exe') 'Folder exclusions or metadata exclusions failed.'

    Assert-Rejected 'empty' @{ include = @() } 'An empty policy must not default to shipping everything.'
    Assert-Rejected 'traversal' @{ include = @('../secret') } 'Traversal was accepted.'
    Assert-Rejected 'absolute' @{ include = @('C:/secret') } 'Absolute paths were accepted.'
    Assert-Rejected 'typo' @{ includes = @('*') } 'Unknown settings were accepted.'
    Assert-Rejected 'bad-array' @{ include = '*' } 'Malformed include was accepted.'
    Assert-Rejected 'bad-mode' @{ folders = @(@{ path = 'Extensions'; delivery = 'tar' }) } 'Unknown delivery mode was accepted.'
    Assert-Rejected 'missing-folder' @{ folders = @(@{ path = 'Missing'; delivery = 'zip' }) } 'Missing folder was accepted.'
    Assert-Rejected 'overlap' @{ folders = @(@{ path = 'Data'; delivery = 'zip' }, @{ path = 'Data/Patch-Housing.MPQ'; delivery = 'files' }) } 'Overlapping folders were accepted.'
    Assert-Rejected 'empty-zip' @{ exclude = @('Extensions'); folders = @(@{ path = 'Extensions'; delivery = 'zip' }) } 'Empty ZIP selection was accepted.'
    Assert-Rejected 'duplicate' @{ folders = @(@{ path = 'Extensions'; delivery = 'zip' }, @{ path = 'Extensions'; delivery = 'files' }) } 'Duplicate folders were accepted.'
    $blocked = $false
    try { & $generator -PayloadRoot $source -PublishRoot $release -OutputPath (Join-Path $release 'manifest.json') -Version 'test-2' } catch { $blocked = $true }
    Assert $blocked 'A populated publish directory was overwritten.'

    $externalPolicy = Join-Path $scratch 'external-policy.json'
    [IO.File]::WriteAllText($externalPolicy, '{"include":["Wow.exe"]}')
    $external = Join-Path $scratch 'external'
    & $generator -PayloadRoot $source -PublishRoot $external -OutputPath (Join-Path $external 'manifest.json') -DeliveryConfig $externalPolicy -Version 'explicit'
    Assert (Test-Path -LiteralPath (Join-Path $external 'Wow.exe')) 'Explicit external policy was not applied.'
    $blocked = $false
    try { & $generator -PayloadRoot $source -PublishRoot (Join-Path $source 'publish') -OutputPath (Join-Path $source 'publish/manifest.json') -DeliveryConfig $externalPolicy -Version 'bad' } catch { $blocked = $true }
    Assert $blocked 'Nested publishing into the source tree was accepted.'

    Remove-Item -LiteralPath (Join-Path $source '.delivery.json')
    $legacyPath = Join-Path $scratch 'legacy.json'
    & $generator -PayloadRoot $source -OutputPath $legacyPath -Version 'legacy'
    $legacy = Get-Content -LiteralPath $legacyPath -Raw | ConvertFrom-Json
    Assert ($legacy.files.Count -eq 8) 'Legacy manifest-only invocation changed unexpectedly.'
    Write-Host 'Delivery self-test passed: selection, ZIP contents/hashes, loose mode, URLs, validation, and legacy invocation.'
} finally {
    $resolved = [IO.Path]::GetFullPath($scratch)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'esteria-delivery-test-*') { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
