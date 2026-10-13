param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,
    [switch]$SkipSymlinkCheck,
    [switch]$NoZip,
    [switch]$Offline,
    [string]$ServerUrl
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$appRoot = Join-Path $projectRoot 'apps\client'
. (Join-Path $PSScriptRoot 'release-environment.ps1')
if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) { throw 'flutter not found. Add Flutter bin to PATH.' }

# Keep large, disposable Windows build caches off the system drive. These are
# process-local overrides, so running the release script does not change the
# user's global Windows environment.
$buildCacheRoot = if ($env:ANIWORLD_BUILD_CACHE) {
    [IO.Path]::GetFullPath($env:ANIWORLD_BUILD_CACHE)
} else {
    Join-Path $env:LOCALAPPDATA 'AniWorld\BuildCache'
}
$buildTemp = Join-Path $buildCacheRoot 'temp'
$nugetCache = Join-Path $buildCacheRoot 'nuget'
New-Item -ItemType Directory -Path $buildTemp, $nugetCache -Force | Out-Null
$env:TEMP = $buildTemp
$env:TMP = $buildTemp
$env:NUGET_PACKAGES = $nugetCache

Initialize-ReleasePubCache -Offline:$Offline
Write-Host "Build temp: $buildTemp"
Write-Host "NuGet cache: $nugetCache"
Write-Host "Pub cache: $env:PUB_CACHE"

$parts = $Version.Split('.') | ForEach-Object { [int]$_ }
if ($parts[1] -ge 100 -or $parts[2] -ge 100) {
    throw 'Minor and patch versions must be below 100.'
}
$buildNumber = $parts[0] * 10000 + $parts[1] * 100 + $parts[2]

if (-not (Test-Path -LiteralPath $appRoot)) {
    throw "Windows app project was not found: $appRoot"
}

function Test-SymlinkSupport {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) ("aniworld-symlink-test-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
        $target = Join-Path $testRoot 'target'
        $link = Join-Path $testRoot 'link'
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        New-Item -ItemType SymbolicLink -Path $link -Target $target -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    } finally {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not $SkipSymlinkCheck -and -not (Test-SymlinkSupport)) {
    Write-Warning @'
Windows Flutter plugins require symlink support.
Enable Windows Developer Mode, then run this command again:
  start ms-settings:developers

Developer Mode appears enabled on some systems only after opening a new terminal.
Continuing anyway and letting Flutter perform the authoritative check.
'@
}

Push-Location $appRoot
try {
    & flutter config --enable-windows-desktop | Out-Host
    if ($Offline) { & flutter pub get --offline }
    else { & flutter pub get }
    if ($LASTEXITCODE -ne 0) {
        throw 'Pub dependency resolution failed. Check your network or prepare the selected cache before using -Offline.'
    }

    $buildArgs = @('build', 'windows', '--release', '--no-pub', '--build-name', $Version,
        '--build-number', $buildNumber, '--dart-define', "APP_VERSION=$Version")
    if ($ServerUrl) { $buildArgs += @('--dart-define', "ANIWORLD_SERVER_URL=$ServerUrl") }
    & flutter @buildArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Flutter Windows build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$bundleDir = Join-Path $appRoot 'build\windows\x64\runner\Release'
$exePath = Join-Path $bundleDir 'AniWorld.exe'
if (-not (Test-Path -LiteralPath $exePath)) {
    throw "Built AniWorld.exe was not found: $exePath"
}

$releaseDir = Join-Path $projectRoot 'data\releases'
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null

if ($NoZip) {
    Write-Host "Windows release directory ready: $bundleDir"
    Write-Host "Version: $Version ($buildNumber)"
    exit 0
}

$releaseZip = Join-Path $releaseDir "AniWorld_windows_$Version.zip"
$temporaryZip = "$releaseZip.tmp.zip"
Remove-Item -LiteralPath $temporaryZip -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $releaseZip -Force -ErrorAction SilentlyContinue

Compress-Archive -Path (Join-Path $bundleDir '*') -DestinationPath $temporaryZip -Force
Move-Item -LiteralPath $temporaryZip -Destination $releaseZip -Force
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $releaseZip).Hash.ToLowerInvariant()

Write-Host "Windows release ready: $releaseZip"
Write-Host "Bundle directory: $bundleDir"
Write-Host "Version: $Version ($buildNumber)"
Write-Host "ZIP SHA-256: $hash"
