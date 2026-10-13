# Shared environment discovery for Windows PowerShell release commands.
function Initialize-ReleasePubCache {
    param([switch]$Offline)
    $cache = if ($env:ANIWORLD_PUB_CACHE) { $env:ANIWORLD_PUB_CACHE }
        elseif ($env:PUB_CACHE) { $env:PUB_CACHE }
        else { Join-Path $env:LOCALAPPDATA 'Pub\Cache' }
    $env:PUB_CACHE = [IO.Path]::GetFullPath($cache)
    if ($Offline -and -not (Test-Path -LiteralPath $env:PUB_CACHE)) {
        throw 'Offline Pub cache is missing. Run npm run app:install first, using the same PUB_CACHE.'
    }
    New-Item -ItemType Directory -Path $env:PUB_CACHE -Force | Out-Null
    Write-Host "Pub cache: $env:PUB_CACHE"
}

function Get-ReleaseAndroidSdk {
    param([string]$AppRoot)
    $sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME }
        elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT }
        else {
            $localFile = Join-Path $AppRoot 'android\local.properties'
            $localSdk = if (Test-Path -LiteralPath $localFile) {
                (ConvertFrom-StringData (Get-Content -Raw -LiteralPath $localFile))['sdk.dir']
            }
            if ($localSdk) { $localSdk }
            else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
        }
    if (-not (Test-Path -LiteralPath $sdk)) {
        throw 'Android SDK not found. Install it in Android Studio and set ANDROID_HOME to its directory.'
    }
    return [IO.Path]::GetFullPath($sdk)
}

function Get-ReleaseKeytool {
    $candidates = @(
        if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\keytool.exe' }
        (Get-Command keytool -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
        if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Android\Android Studio\jbr\bin\keytool.exe' }
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    throw 'keytool not found. Set JAVA_HOME to your JDK directory or add the JDK bin directory to PATH.'
}

function Get-ReleaseApkSigner {
    param([string]$SdkRoot)
    $root = Join-Path $SdkRoot 'build-tools'
    if (Test-Path -LiteralPath $root) {
        $tools = Get-ChildItem -LiteralPath $root -Directory | ForEach-Object {
            $version = $null
            $path = Join-Path $_.FullName 'apksigner.bat'
            if ([version]::TryParse($_.Name, [ref]$version) -and (Test-Path -LiteralPath $path)) {
                [PSCustomObject]@{ Version = $version; Path = $path }
            }
        } | Sort-Object Version -Descending
        if ($tools) { return @($tools)[0].Path }
    }
    throw 'apksigner not found. Install a stable Android SDK Build-Tools version in Android Studio.'
}

# The webview plugin otherwise downloads NuGet 5.10, which cannot use
# NUGET_SCRATCH. Pin a signed upstream CLI that supports isolated build locks.
function Initialize-ReleaseNuGet {
    param([string]$CacheRoot)
    $directory = Join-Path $CacheRoot 'tools\nuget-6.14.0'
    $executable = Join-Path $directory 'nuget.exe'
    $expectedHash = '92dbed160ddee0f64b901e907439e021211b428e57c089ecc12fc38dcc4bd9a5'
    $valid = (Test-Path -LiteralPath $executable) -and
        ((Get-FileHash -Algorithm SHA256 -LiteralPath $executable).Hash.ToLowerInvariant() -eq $expectedHash)
    if (-not $valid) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        $temporary = "$executable.download"
        & curl.exe -fL --retry 2 --connect-timeout 20 --max-time 180 --output $temporary `
            'https://dist.nuget.org/win-x86-commandline/v6.14.0/nuget.exe'
        if ($LASTEXITCODE -ne 0) { throw 'NuGet CLI download failed. Check access to dist.nuget.org.' }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $temporary).Hash.ToLowerInvariant() -ne $expectedHash) {
            throw 'NuGet CLI checksum mismatch.'
        }
        Move-Item -LiteralPath $temporary -Destination $executable -Force
    }
    $env:PATH = "$directory;$env:PATH"
}
