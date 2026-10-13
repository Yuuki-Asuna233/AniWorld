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
