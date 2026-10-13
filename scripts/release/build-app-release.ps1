param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,
    [switch]$ValidateOnly,
    [switch]$Offline,
    [string]$ServerUrl
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$appRoot = Join-Path $projectRoot 'apps\client'
$keyPropertiesPath = Join-Path $appRoot 'android\key.properties'

. (Join-Path $PSScriptRoot 'release-environment.ps1')
if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) { throw 'flutter not found. Add Flutter bin to PATH.' }
Initialize-ReleasePubCache -Offline:$Offline
$sdkRoot = Get-ReleaseAndroidSdk -AppRoot $appRoot
$env:ANDROID_HOME = $sdkRoot
$apksigner = Get-ReleaseApkSigner -SdkRoot $sdkRoot

$parts = $Version.Split('.') | ForEach-Object { [int]$_ }
if ($parts[1] -ge 100 -or $parts[2] -ge 100) {
    throw 'Minor and patch versions must be below 100.'
}
$buildNumber = $parts[0] * 10000 + $parts[1] * 100 + $parts[2]

if (-not (Test-Path -LiteralPath $keyPropertiesPath)) {
    throw "Signing configuration is missing: $keyPropertiesPath"
}
$keyProperties = ConvertFrom-StringData (Get-Content -Raw -Encoding UTF8 -LiteralPath $keyPropertiesPath)
foreach ($field in @('storeFile', 'storePassword', 'keyAlias', 'keyPassword', 'expectedCertSha256')) {
    if (-not $keyProperties[$field] -or $keyProperties[$field].StartsWith('replace-with-')) {
        throw "Fill signing field $field in android/key.properties. See docs/getting-started.md."
    }
}
$keyStorePath = $keyProperties.storeFile
if (-not [IO.Path]::IsPathRooted($keyStorePath)) {
    $keyStorePath = Join-Path (Join-Path $appRoot 'android') $keyStorePath
}
$keyStorePath = [IO.Path]::GetFullPath($keyStorePath)
if (-not (Test-Path -LiteralPath $keyStorePath)) {
    throw "Signing keystore is missing: $keyStorePath"
}

$keytool = Get-ReleaseKeytool
$keyInfo = & $keytool -J-Duser.language=en -J-Duser.country=US -list -v -keystore $keyStorePath `
    -storepass $keyProperties.storePassword -alias $keyProperties.keyAlias 2>&1
if ($LASTEXITCODE -ne 0) { throw "Unable to read signing keystore: $keyInfo" }
$certMatch = [regex]::Match(($keyInfo -join "`n"), 'SHA256:\s*([0-9A-F:]+)', 'IgnoreCase')
if (-not $certMatch.Success) { throw 'Unable to read signing certificate SHA-256.' }
$actualCert = $certMatch.Groups[1].Value.Replace(':', '').ToLowerInvariant()
$expectedCert = $keyProperties.expectedCertSha256.Trim().Replace(':', '').ToLowerInvariant()
if ($expectedCert.Length -ne 64) { throw 'expectedCertSha256 must be the full SHA-256 certificate fingerprint.' }
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
        if ($Offline) { throw "Missing verified native artifact: $destination. Run an online build first." }
        $sources = @("$baseUrl/$($artifact.Name)")
        if ($env:ANIWORLD_DOWNLOAD_MIRROR) {
            $sources += "$($env:ANIWORLD_DOWNLOAD_MIRROR.TrimEnd('/'))/$baseUrl/$($artifact.Name)"
        }
        $downloaded = $false
        foreach ($sourceUrl in $sources) {
            Write-Host "Downloading media_kit artifact: $($artifact.Name)"
            & curl.exe -fL --retry 2 --retry-delay 2 --connect-timeout 20 --max-time 300 `
                --output $temporary $sourceUrl
            if ($LASTEXITCODE -eq 0 -and
                (Get-FileHash -Algorithm SHA256 -LiteralPath $temporary).Hash.ToLowerInvariant() -eq $artifact.Sha256) {
                $downloaded = $true
                break
            }
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
        if (-not $downloaded) { throw "Failed to download verified media_kit artifact: $($artifact.Name). Check GitHub access or configure ANIWORLD_DOWNLOAD_MIRROR." }
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
    if ($Offline) { & flutter pub get --offline }
    else { & flutter pub get }
    if ($LASTEXITCODE -ne 0) {
        throw 'Pub dependency resolution failed. Check your network or prepare the selected cache before using -Offline.'
    }
    $buildArgs = @('build', 'apk', '--release', '--no-pub', '--target-platform', 'android-arm64',
        '--build-name', $Version, '--build-number', $buildNumber, '--dart-define', "APP_VERSION=$Version")
    if ($ServerUrl) { $buildArgs += @('--dart-define', "ANIWORLD_SERVER_URL=$ServerUrl") }
    & flutter @buildArgs
    if ($LASTEXITCODE -ne 0) { throw "Flutter build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$sourceApk = Join-Path $appRoot 'build\app\outputs\flutter-apk\app-release.apk'
if (-not (Test-Path -LiteralPath $sourceApk)) {
    throw "Built APK was not found: $sourceApk"
}

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
