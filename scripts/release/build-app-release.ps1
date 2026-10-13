param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$appRoot = Join-Path $projectRoot 'apps\client'
$keyPropertiesPath = Join-Path $appRoot 'android\key.properties'

# Use the complete local Pub cache for reproducible release builds. The two
# desktop webview dependencies are Git repositories and must not make an
# Android release depend on GitHub being reachable at build time.
$preferredPubCache = if ($env:ANIWORLD_PUB_CACHE) {
    $env:ANIWORLD_PUB_CACHE
} elseif (Test-Path -LiteralPath 'D:\AndroidDev\PubCache') {
    'D:\AndroidDev\PubCache'
} else {
    $env:PUB_CACHE
}
if (-not $preferredPubCache -or -not (Test-Path -LiteralPath $preferredPubCache)) {
    throw 'A local Pub cache was not found. Set ANIWORLD_PUB_CACHE first.'
}
$env:PUB_CACHE = [IO.Path]::GetFullPath($preferredPubCache)
if (-not $env:GRADLE_USER_HOME -and (Test-Path -LiteralPath 'D:\AndroidDev\Caches\gradle')) {
    $env:GRADLE_USER_HOME = 'D:\AndroidDev\Caches\gradle'
}

$parts = $Version.Split('.') | ForEach-Object { [int]$_ }
if ($parts[1] -ge 100 -or $parts[2] -ge 100) {
    throw 'Minor and patch versions must be below 100.'
}
$buildNumber = $parts[0] * 10000 + $parts[1] * 100 + $parts[2]

if (-not (Test-Path -LiteralPath $keyPropertiesPath)) {
    throw "Signing configuration is missing: $keyPropertiesPath"
}
$keyProperties = ConvertFrom-StringData (Get-Content -Raw -LiteralPath $keyPropertiesPath)
$keyStorePath = $keyProperties.storeFile
if (-not [IO.Path]::IsPathRooted($keyStorePath)) {
    $keyStorePath = Join-Path (Join-Path $appRoot 'android') $keyStorePath
}
$keyStorePath = [IO.Path]::GetFullPath($keyStorePath)
if (-not (Test-Path -LiteralPath $keyStorePath)) {
    throw "Signing keystore is missing: $keyStorePath"
}

$keytoolCandidates = @(
    'D:\AndroidDev\Android Studio\jbr\bin\keytool.exe',
    (Get-Command keytool -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
if (-not $keytoolCandidates) {
    throw 'keytool was not found.'
}
$keytool = @($keytoolCandidates)[0]
$keyInfo = & $keytool -list -v -keystore $keyStorePath `
    -storepass $keyProperties.storePassword -alias $keyProperties.keyAlias 2>&1
if ($LASTEXITCODE -ne 0) { throw "Unable to read signing keystore: $keyInfo" }
$certMatch = [regex]::Match(($keyInfo -join "`n"), 'SHA256:\s*([0-9A-F:]+)', 'IgnoreCase')
if (-not $certMatch.Success) { throw 'Unable to read signing certificate SHA-256.' }
$actualCert = $certMatch.Groups[1].Value.Replace(':', '').ToLowerInvariant()
$expectedCert = $keyProperties.expectedCertSha256.Trim().ToLowerInvariant()
if ($actualCert -ne $expectedCert) {
    throw "Signing certificate mismatch. Expected $expectedCert, got $actualCert"
}
if ($ValidateOnly) {
    Write-Host "Release configuration is valid for $Version ($buildNumber)."
    Write-Host "Signing certificate SHA-256: $actualCert"
    exit 0
}

function Initialize-MediaKitAndroidArtifacts {
    $artifactRoot = Join-Path $appRoot 'build\media_kit_libs_android_video\v1.2.6'
    New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
    $baseUrl = 'https://github.com/Predidit/libmpv-android-video-build/releases/download/v1.2.6'
    $artifacts = @(
        @{ Name = 'default-arm64-v8a.jar'; Sha256 = '1f6b8f971be63bb4bd4d5fd64b1eed1be75ada591168ba13b5647fbf845c2414' },
        @{ Name = 'default-armeabi-v7a.jar'; Sha256 = 'b539cc8684fb3e4a0be7a6cce75272e2b7c571fc14c9174786bb17fb338cfee2' },
        @{ Name = 'default-x86_64.jar'; Sha256 = '25a3cc1331326d41efb13a8da959eb14104eabe1b8a318e30c0f703444dcaf7c' },
        @{ Name = 'default-x86.jar'; Sha256 = '847120273bba862749143e58b22f625d229bb73b137ef9b38aa05f097a4509e8' }
    )

    foreach ($artifact in $artifacts) {
        $destination = Join-Path $artifactRoot $artifact.Name
        $valid = (Test-Path -LiteralPath $destination) -and
            ((Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant() -eq $artifact.Sha256)
        if ($valid) {
            Write-Host "Using cached media_kit artifact: $($artifact.Name)"
            continue
        }

        $temporary = "$destination.download"
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
        $sourceUrl = "https://ghfast.top/$baseUrl/$($artifact.Name)"
        Write-Host "Downloading media_kit artifact: $($artifact.Name)"
        & curl.exe -fL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 300 `
            --output $temporary $sourceUrl
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
            throw "Failed to download media_kit artifact: $($artifact.Name)"
        }
        $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporary).Hash.ToLowerInvariant()
        if ($actualSha256 -ne $artifact.Sha256) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
            throw "media_kit artifact checksum mismatch: $($artifact.Name)"
        }
        Move-Item -LiteralPath $temporary -Destination $destination -Force
    }
}

Initialize-MediaKitAndroidArtifacts

Push-Location $appRoot
try {
    & flutter pub get --offline
    if ($LASTEXITCODE -ne 0) {
        throw 'Offline dependency resolution failed. Populate ANIWORLD_PUB_CACHE once before building.'
    }
    & flutter build apk --release --no-pub --target-platform android-arm64 `
    --build-name $Version --build-number $buildNumber `
    --dart-define "APP_VERSION=$Version"
    if ($LASTEXITCODE -ne 0) { throw "Flutter build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$sourceApk = Join-Path $appRoot 'build\app\outputs\flutter-apk\app-release.apk'
if (-not (Test-Path -LiteralPath $sourceApk)) {
    throw "Built APK was not found: $sourceApk"
}

$buildToolsRoot = 'D:\AndroidDev\AndroidSdk\build-tools'
$apksigner = Get-ChildItem -LiteralPath $buildToolsRoot -Directory |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'apksigner.bat' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
if (-not $apksigner) { throw 'apksigner.bat was not found.' }

$apkInfo = & $apksigner verify --print-certs $sourceApk 2>&1
if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed: $apkInfo" }
$apkCertMatch = [regex]::Match(
    ($apkInfo -join "`n"),
    'certificate SHA-256 digest:\s*([0-9a-f]+)',
    'IgnoreCase'
)
if (-not $apkCertMatch.Success) { throw 'Unable to read APK signing certificate.' }
$apkCert = $apkCertMatch.Groups[1].Value.ToLowerInvariant()
if ($apkCert -ne $expectedCert) {
    throw "Built APK has the wrong signing certificate: $apkCert"
}

$releaseDir = Join-Path $projectRoot 'data\releases'
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
$releaseApk = Join-Path $releaseDir "AniWorld_android_$Version.apk"
Copy-Item -LiteralPath $sourceApk -Destination $releaseApk -Force
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $releaseApk).Hash.ToLowerInvariant()

Write-Host "Release ready: $releaseApk"
Write-Host "Version: $Version ($buildNumber)"
Write-Host "Signing certificate SHA-256: $apkCert"
Write-Host "APK SHA-256: $hash"
