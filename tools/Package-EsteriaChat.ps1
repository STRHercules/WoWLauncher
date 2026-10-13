#requires -Version 7.0
param(
    [Parameter(Mandatory = $true)][string]$ApiOrigin,
    [string]$OutputRoot = '',
    [string]$WxlSdkRoot = 'R:\Users\Zach\Documents\GitHub\AzerothPlex\build\wxl-core',
    [string]$SupportedClient = 'G:\3.3.5a - Dev\Wow.exe',
    [string]$Version = '1.0.0'
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputRoot) { $OutputRoot = Join-Path $repository "dist\chat-$Version" }
$origin = [uri]$ApiOrigin
if (-not $origin.IsAbsoluteUri -or ($origin.Scheme -ne 'https' -and -not ($origin.Scheme -eq 'http' -and $origin.IsLoopback)) -or
    $origin.AbsolutePath -ne '/' -or $origin.UserInfo -or $ApiOrigin -match '["\s]') { throw 'Use an HTTPS origin or HTTP loopback, without path, credentials or whitespace.' }
if (Test-Path -LiteralPath $OutputRoot) { throw 'Choose a new staging folder; existing packages are never overwritten.' }
$native = Join-Path $repository 'native'
& cmake -S $native -B (Join-Path $native 'build') -G 'Visual Studio 18 2026' -A Win32 "-DWXL_SDK_ROOT=$WxlSdkRoot" "-DSUPPORTED_CLIENT=$SupportedClient"
if ($LASTEXITCODE) { throw 'Native configure failed.' }
& cmake --build (Join-Path $native 'build') --config Release
if ($LASTEXITCODE) { throw 'Native build failed.' }
& (Join-Path $native 'build\Release\chat-native-selftest.exe')
if ($LASTEXITCODE) { throw 'Native selftest failed.' }
$extension = Join-Path $OutputRoot 'client\Extensions\wxl-esteria-chat'
New-Item -ItemType Directory -Path $extension -Force | Out-Null
& dotnet publish (Join-Path $native 'helper\EsteriaChatHelper.csproj') -c Release -r win-x86 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $extension --nologo
if ($LASTEXITCODE) { throw 'Helper publish failed.' }
Copy-Item -LiteralPath (Join-Path $native 'build\Release\wxl-esteria-chat.dll') -Destination $extension
Copy-Item -LiteralPath (Join-Path $native 'extension\wxl.json') -Destination $extension
[IO.File]::WriteAllText((Join-Path $extension 'chat-media.ini'), "[Chat]`nApiOrigin=$($ApiOrigin.TrimEnd('/'))`n", [Text.UTF8Encoding]::new($false))
$addonRoot = Join-Path $OutputRoot 'addons'
$publisher = Join-Path $repository '..\EsteriaWoW\Launcher-src\Tools\launcher\publish-addon.ps1'
& $publisher -SourceFolders (Join-Path $repository 'addon\EsteriaChat') -AddonsRoot $addonRoot -Id 'esteria-chat' -Name 'Esteria Chat' -Version $Version -Description 'Shared launcher/game account chat; native media requires the supported WXL extension.' -Author 'Esteria' -Category 'Social' -BaseUrl ($ApiOrigin.TrimEnd('/') + '/addons/')
if ($LASTEXITCODE) { throw 'Addon staging failed.' }
$manifest = Join-Path $OutputRoot 'client-manifest-fragment.json'
& (Join-Path $PSScriptRoot 'New-EsteriaManifest.ps1') -PayloadRoot (Join-Path $OutputRoot 'client') -OutputPath $manifest -Version $Version
$inventory = foreach ($file in Get-ChildItem -LiteralPath $OutputRoot -File -Recurse) {
    [ordered]@{ path = [IO.Path]::GetRelativePath([IO.Path]::GetFullPath($OutputRoot), $file.FullName).Replace('\','/'); sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); size = $file.Length }
}
$receipt = [ordered]@{ version = $Version; supportedClientSha256 = (Get-FileHash -LiteralPath $SupportedClient -Algorithm SHA256).Hash.ToLowerInvariant(); files = @($inventory) }
[IO.File]::WriteAllText((Join-Path $OutputRoot 'package-receipt.json'), ($receipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Write-Output "Staged only: $OutputRoot. No live client or CDN was modified."
