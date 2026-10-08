param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadRoot,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$BaseUrl = ""
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path -LiteralPath $PayloadRoot).Path
$outputFull = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = [System.IO.Path]::GetDirectoryName($outputFull)

if (-not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$files = Get-ChildItem -LiteralPath $root -File -Recurse | Where-Object {
    $_.FullName -ne $outputFull -and -not $_.Name.EndsWith(".esteria-download", [System.StringComparison]::OrdinalIgnoreCase)
} | Sort-Object FullName

$entries = foreach ($file in $files) {
    $relative = [System.IO.Path]::GetRelativePath($root, $file.FullName).Replace("\", "/")
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()

    [ordered]@{
        path = $relative
        sha256 = $hash
        size = $file.Length
    }
}

$manifest = [ordered]@{
    version = $Version
}

if (-not [string]::IsNullOrWhiteSpace($BaseUrl)) {
    $manifest.baseUrl = $BaseUrl.Trim()
}

$manifest.files = @($entries)

$json = $manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($outputFull, $json, [System.Text.UTF8Encoding]::new($false))

Write-Host "Esteria manifest written to: $outputFull"
Write-Host "Files: $($entries.Count)"
