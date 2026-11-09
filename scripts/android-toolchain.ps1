<#
.SYNOPSIS
  Workspace-local Android toolchain and debug APK build helper for LogiNote.
.DESCRIPTION
  Does not install system software, modify persistent PATH, disable HTTPS checks,
  or automatically accept SDK licenses. All downloaded tools and Gradle caches
  stay in .local/android-tools. Existing JDK/SDK paths can be used read-only.

  Google requires acceptance of its SDK license before downloading command-line
  tools. Review https://developer.android.com/studio#command-line-tools-only and
  pass -AcceptAndroidSdkLicense only after the person running this script agrees.
  That switch does NOT pipe acceptance into sdkmanager. Package licenses are
  reviewed interactively through -Action Licenses; no license hashes are forged.
.EXAMPLE
  powershell -NoProfile -File scripts/android-toolchain.ps1 -Action Probe
.EXAMPLE
  powershell -NoProfile -File scripts/android-toolchain.ps1 -Action Bootstrap -JdkOnly
  # Downloads the open-source JDK without downloading Android SDK tools.
.EXAMPLE
  powershell -NoProfile -File scripts/android-toolchain.ps1 -Action Bootstrap -AcceptAndroidSdkLicense
  powershell -NoProfile -File scripts/android-toolchain.ps1 -Action Licenses
  powershell -NoProfile -File scripts/android-toolchain.ps1 -Action InstallSdk
  powershell -NoProfile -File scripts/android-toolchain.ps1 -Action Build
.EXAMPLE
  powershell -NoProfile -File scripts/android-toolchain.ps1 -Action Build -JdkHome C:/tools/jdk-21 -SdkRoot C:/Android/Sdk
#>
[CmdletBinding()]
param(
  [ValidateSet('Probe', 'Bootstrap', 'Licenses', 'InstallSdk', 'Build')]
  [string]$Action = 'Probe',
  [string]$ToolsRoot,
  [string]$JdkHome,
  [string]$SdkRoot,
  [ValidateRange(24, 99)]
  [int]$ApiLevel = 36,
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$BuildToolsVersion = '36.0.0',
  [switch]$AcceptAndroidSdkLicense,
  [switch]$JdkOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $ToolsRoot) { $ToolsRoot = Join-Path $repositoryRoot '.local/android-tools' }
$ToolsRoot = [System.IO.Path]::GetFullPath($ToolsRoot)
$androidProject = Join-Path $repositoryRoot 'apps/android/android'
$cliBuild = '15859902'
$cliArchiveName = "commandlinetools-win-${cliBuild}_latest.zip"
$cliUrl = "https://dl.google.com/android/repository/$cliArchiveName"
$cliSha256 = '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a'
$jdkMetadataUrl = 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse'
$sdkLicenseUrl = 'https://developer.android.com/studio#command-line-tools-only'

function Assert-WorkspacePath([string]$Target) {
  $absolute = [System.IO.Path]::GetFullPath($Target)
  $prefix = $repositoryRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  if (-not $absolute.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Managed output must stay inside the repository: $absolute"
  }
  return $absolute
}

function Ensure-Directory([string]$Target) {
  $absolute = Assert-WorkspacePath $Target
  if (-not (Test-Path -LiteralPath $absolute)) { New-Item -ItemType Directory -Path $absolute -Force | Out-Null }
  return $absolute
}

function Test-Jdk21([string]$Candidate) {
  if (-not $Candidate) { return $false }
  $java = Join-Path $Candidate 'bin/java.exe'
  $javac = Join-Path $Candidate 'bin/javac.exe'
  $release = Join-Path $Candidate 'release'
  if (-not ((Test-Path -LiteralPath $java) -and (Test-Path -LiteralPath $javac) -and (Test-Path -LiteralPath $release))) { return $false }
  return [bool]((Get-Content -LiteralPath $release -Raw) -match 'JAVA_VERSION="21(?:\.|\+|"|-)')
}

function Find-Jdk {
  $candidates = @($JdkHome, $env:JAVA_HOME)
  $managedMarker = Join-Path $ToolsRoot 'jdk-home.txt'
  if (Test-Path -LiteralPath $managedMarker) { $candidates += (Get-Content -LiteralPath $managedMarker -Raw -Encoding UTF8).Trim() }
  $javaCommand = Get-Command java -ErrorAction SilentlyContinue
  if ($javaCommand -and $javaCommand.Source) { $candidates += Split-Path -Parent (Split-Path -Parent $javaCommand.Source) }
  $candidates += @(
    (Join-Path $env:ProgramFiles 'Android/Android Studio/jbr'),
    (Join-Path $env:LOCALAPPDATA 'Programs/Android Studio/jbr')
  )
  foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (Test-Jdk21 $candidate) { return [System.IO.Path]::GetFullPath($candidate) }
  }
  return $null
}

function Find-Sdk {
  $candidates = @($SdkRoot, $env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $ToolsRoot 'sdk'), (Join-Path $env:LOCALAPPDATA 'Android/Sdk'))
  foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if ((Test-Path -LiteralPath (Join-Path $candidate 'cmdline-tools')) -or (Test-Path -LiteralPath (Join-Path $candidate 'platforms'))) { return [System.IO.Path]::GetFullPath($candidate) }
  }
  if ($SdkRoot) { return [System.IO.Path]::GetFullPath($SdkRoot) }
  return Join-Path $ToolsRoot 'sdk'
}

function Find-SdkManager([string]$SdkDirectory) {
  $latest = Join-Path $SdkDirectory 'cmdline-tools/latest/bin/sdkmanager.bat'
  if (Test-Path -LiteralPath $latest) { return $latest }
  $managed = Join-Path $SdkDirectory "cmdline-tools/$cliBuild/bin/sdkmanager.bat"
  if (Test-Path -LiteralPath $managed) { return $managed }
  $commandsRoot = Join-Path $SdkDirectory 'cmdline-tools'
  if (Test-Path -LiteralPath $commandsRoot) {
    foreach ($version in (Get-ChildItem -LiteralPath $commandsRoot -Directory | Sort-Object Name -Descending)) {
      $manager = Join-Path $version.FullName 'bin/sdkmanager.bat'
      if (Test-Path -LiteralPath $manager) { return $manager }
    }
  }
  return $null
}

function Get-VerifiedArchive([string]$Url, [string]$Target, [string]$ExpectedSha256) {
  $absolute = Assert-WorkspacePath $Target
  if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Publisher supplied an invalid SHA-256 checksum.' }
  if (-not (Test-Path -LiteralPath $absolute)) {
    Write-Host "Downloading official archive: $Url"
    # Keep certificate validation enabled. Connection failures are reported;
    # they must never be worked around with HTTP or SkipCertificateCheck.
    Invoke-WebRequest -Uri $Url -OutFile $absolute -UseBasicParsing -TimeoutSec 1800
  }
  $actual = (Get-FileHash -LiteralPath $absolute -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "SHA-256 mismatch for $absolute. Expected $ExpectedSha256, got $actual. The archive was not extracted; review/remove this specific cache file before retrying."
  }
  Write-Host "Verified SHA-256: $actual"
  return $absolute
}

function Install-PortableJdk {
  $existing = Find-Jdk
  if ($existing) { return $existing }
  $downloads = Ensure-Directory (Join-Path $ToolsRoot 'downloads')
  Write-Host 'Resolving Temurin JDK 21 from the official Adoptium API.'
  $assets = @(Invoke-RestMethod -Uri $jdkMetadataUrl -TimeoutSec 60)
  if (-not $assets.Count) { throw 'The official Adoptium API did not return a Windows x64 JDK 21.' }
  $asset = $assets[0]
  $package = $asset.binary.package
  $hostName = ([uri]$package.link).Host
  if ($hostName -notin @('github.com', 'api.adoptium.net', 'adoptium.net')) { throw "Unexpected official JDK asset host: $hostName" }
  $archiveName = [System.IO.Path]::GetFileName(([uri]$package.link).AbsolutePath)
  if (-not $archiveName.EndsWith('.zip', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'The official JDK asset was not a ZIP archive.' }
  $archive = Get-VerifiedArchive $package.link (Join-Path $downloads $archiveName) $package.checksum
  $extract = Ensure-Directory (Join-Path $ToolsRoot ('jdk-' + ($asset.release_name -replace '[^a-zA-Z0-9_.-]', '_')))
  Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
  $jdk = Get-ChildItem -LiteralPath $extract -Directory | Where-Object { Test-Jdk21 $_.FullName } | Select-Object -First 1
  if (-not $jdk) { throw "Verified JDK archive did not contain a JDK 21: $extract" }
  Set-Content -LiteralPath (Join-Path $ToolsRoot 'jdk-home.txt') -Value $jdk.FullName -Encoding UTF8
  [ordered]@{ publisher = 'Eclipse Adoptium'; release = $asset.release_name; metadata = $jdkMetadataUrl; url = $package.link; sha256 = $package.checksum; installedPath = $jdk.FullName } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ToolsRoot 'jdk-provenance.json') -Encoding UTF8
  return $jdk.FullName
}

function Install-PortableCommandLineTools {
  $managedSdk = Join-Path $ToolsRoot 'sdk'
  $existing = Find-SdkManager $managedSdk
  if ($existing) { return $managedSdk }
  if (-not $AcceptAndroidSdkLicense) {
    throw "Android command-line tools were not downloaded. Review Google's SDK license at $sdkLicenseUrl, then explicitly pass -AcceptAndroidSdkLicense if you agree. No license was accepted by this script."
  }
  $downloads = Ensure-Directory (Join-Path $ToolsRoot 'downloads')
  $archive = Get-VerifiedArchive $cliUrl (Join-Path $downloads $cliArchiveName) $cliSha256
  $extract = Ensure-Directory (Join-Path $downloads "android-cli-$cliBuild")
  Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
  $source = Join-Path $extract 'cmdline-tools'
  if (-not (Test-Path -LiteralPath (Join-Path $source 'bin/sdkmanager.bat'))) { throw 'Verified Android command-line archive has an unexpected layout.' }
  $commandRoot = Ensure-Directory (Join-Path $managedSdk 'cmdline-tools')
  $target = Assert-WorkspacePath (Join-Path $commandRoot $cliBuild)
  if (Test-Path -LiteralPath $target) { throw "Incomplete command-line tools already exist: $target. Review this directory before retrying; it was not overwritten." }
  Copy-Item -LiteralPath $source -Destination $target -Recurse
  [ordered]@{ publisher = 'Google'; build = $cliBuild; source = $sdkLicenseUrl; url = $cliUrl; sha256 = $cliSha256; installedPath = $target } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ToolsRoot 'android-cli-provenance.json') -Encoding UTF8
  return $managedSdk
}

function Set-ProcessToolchain([string]$ResolvedJdk, [string]$ResolvedSdk) {
  if (-not $ResolvedJdk) { throw 'JDK 21 is missing. Supply -JdkHome or run -Action Bootstrap.' }
  # Environment changes apply only to this PowerShell process and its children.
  $env:JAVA_HOME = $ResolvedJdk
  $env:ANDROID_HOME = $ResolvedSdk
  $env:ANDROID_SDK_ROOT = $ResolvedSdk
  $env:ANDROID_USER_HOME = Ensure-Directory (Join-Path $ToolsRoot 'android-user')
  # AGP rejects conflicting old/new preference locations. Use the supported
  # ANDROID_USER_HOME only; Java user.home is isolated separately for analytics.
  $env:ANDROID_SDK_HOME = $null
  $env:TEMP = Ensure-Directory (Join-Path $ToolsRoot 'temp')
  $env:TMP = $env:TEMP
  $env:GRADLE_USER_HOME = Ensure-Directory (Join-Path $ToolsRoot 'gradle-cache')
}

function Invoke-SdkManager([string]$Manager, [string[]]$Arguments) {
  # Google's .bat launcher embeds JAVA_HOME inside a nested cmd `for /f` and
  # breaks when the workspace contains parentheses. Invoke the exact official
  # Java main/classpath from that launcher directly, preserving Unicode paths.
  $toolsDirectory = Split-Path -Parent (Split-Path -Parent $Manager)
  $classPath = Join-Path $toolsDirectory 'lib/sdkmanager-classpath.jar'
  if (-not (Test-Path -LiteralPath $classPath)) { throw "Missing official sdkmanager classpath: $classPath" }
  $java = Join-Path $env:JAVA_HOME 'bin/java.exe'
  & $java '-Xmx1024m' "-Dcom.android.sdklib.toolsdir=$toolsDirectory" '-classpath' $classPath 'com.android.sdklib.tool.sdkmanager.SdkManagerCli' @Arguments
}

Assert-WorkspacePath $ToolsRoot | Out-Null
$resolvedJdk = Find-Jdk
$resolvedSdk = Find-Sdk

if ($Action -eq 'Probe') {
  $manager = Find-SdkManager $resolvedSdk
  [ordered]@{
    repository = $repositoryRoot
    java21 = $resolvedJdk
    sdk = $resolvedSdk
    androidUserHome = Join-Path $ToolsRoot 'android-user'
    sdkManager = $manager
    platformApi = $ApiLevel
    platformInstalled = Test-Path -LiteralPath (Join-Path $resolvedSdk "platforms/android-$ApiLevel/android.jar")
    buildToolsVersion = $BuildToolsVersion
    buildToolsInstalled = Test-Path -LiteralPath (Join-Path $resolvedSdk "build-tools/$BuildToolsVersion/aapt2.exe")
    platformToolsInstalled = Test-Path -LiteralPath (Join-Path $resolvedSdk 'platform-tools/adb.exe')
    sdkLicensesPresent = Test-Path -LiteralPath (Join-Path $resolvedSdk 'licenses')
    gradleWrapperPresent = Test-Path -LiteralPath (Join-Path $androidProject 'gradlew.bat')
    sdkLicense = $sdkLicenseUrl
  } | ConvertTo-Json
  exit 0
}

if ($Action -eq 'Bootstrap') {
  Ensure-Directory $ToolsRoot | Out-Null
  $resolvedJdk = Install-PortableJdk
  if ($JdkOnly) { Write-Host "JDK: $resolvedJdk"; Write-Host 'Android SDK tools were not downloaded and no SDK license was accepted.'; exit 0 }
  $resolvedSdk = Install-PortableCommandLineTools
  Write-Host "JDK: $resolvedJdk"
  Write-Host "SDK command-line tools: $resolvedSdk"
  Write-Host 'Next run -Action Licenses to review package licenses interactively, then -Action InstallSdk.'
  exit 0
}

Set-ProcessToolchain $resolvedJdk $resolvedSdk

if ($Action -in @('Licenses', 'InstallSdk')) {
  $manager = Find-SdkManager $resolvedSdk
  if (-not $manager) { throw 'Android command-line tools are missing. Run -Action Bootstrap after reviewing the SDK license.' }
  if ($Action -eq 'Licenses') {
    Write-Host "Review each SDK package license. No automatic responses are supplied. Google SDK terms: $sdkLicenseUrl"
    Invoke-SdkManager $manager @("--sdk_root=$resolvedSdk", '--licenses')
  } else {
    # Install only the requested SDK packages. sdkmanager presents their actual
    # required licenses here; do not pre-create license files or feed blanket
    # acceptance to `--licenses` (which includes unrelated SDK agreements).
    Write-Host 'Installing only platform-tools, the requested platform, and Build Tools. Review each displayed package license; no automatic response is supplied.'
    # sdkmanager is still supported by the pinned command-line tools. Google now
    # recommends the newer Android CLI for new deployments. We pin this official
    # package for a reproducible Capacitor 8 / API 36 local build.
    Invoke-SdkManager $manager @("--sdk_root=$resolvedSdk", 'platform-tools', "platforms;android-$ApiLevel", "build-tools;$BuildToolsVersion")
  }
  if ($LASTEXITCODE -ne 0) { throw "sdkmanager exited with code $LASTEXITCODE" }
  exit 0
}

if ($Action -eq 'Build') {
  $wrapper = Join-Path $androidProject 'gradlew.bat'
  if (-not (Test-Path -LiteralPath $wrapper)) { throw 'Android project is missing. Install the mobile package and run its Capacitor add/sync commands first.' }
  if (-not (Test-Path -LiteralPath (Join-Path $resolvedSdk "platforms/android-$ApiLevel/android.jar"))) { throw "Android API $ApiLevel is missing. Run -Action InstallSdk after license review." }
  if (-not (Test-Path -LiteralPath (Join-Path $resolvedSdk "build-tools/$BuildToolsVersion/aapt2.exe"))) { throw "Build Tools $BuildToolsVersion are missing. Run -Action InstallSdk after license review." }
  Push-Location -LiteralPath $androidProject
  try {
    $javaUserHome = Ensure-Directory (Join-Path $ToolsRoot 'java-user')
    & $wrapper --no-daemon --console=plain --stacktrace "-Duser.home=$javaUserHome" "-Djava.io.tmpdir=$env:TEMP" '-Pkotlin.compiler.execution.strategy=in-process' assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "Gradle failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
  $apk = Join-Path $androidProject 'app/build/outputs/apk/debug/app-debug.apk'
  if (-not (Test-Path -LiteralPath $apk)) { throw 'Gradle did not produce the expected debug APK.' }
  [ordered]@{ apk = $apk; sha256 = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant(); size = (Get-Item -LiteralPath $apk).Length } | ConvertTo-Json
}
