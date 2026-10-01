$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Project = $Root
$OutApk = Join-Path (Split-Path -Parent $Root) "Nexus-Haydovchi.apk"
$Tools = Join-Path $env:LOCALAPPDATA "NexusBuild"
$Sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
$GradleVer = "8.7"
$GradleZip = Join-Path $Tools "gradle-$GradleVer-bin.zip"
$GradleHome = Join-Path $Tools "gradle-$GradleVer"
$CmdZip = Join-Path $Tools "commandlinetools-win.zip"
New-Item -ItemType Directory -Force -Path $Tools | Out-Null
New-Item -ItemType Directory -Force -Path $Sdk | Out-Null

function Find-JavaHome {
    $candidates = @(
        $env:JAVA_HOME,
        "C:\Program Files\Microsoft\jdk-17*",
        "C:\Program Files\Eclipse Adoptium\jdk-17*",
        "C:\Program Files\Java\jdk-17*",
        "C:\Program Files\Microsoft\jdk-21*",
        "C:\Program Files\Android\Android Studio\jbr"
    )
    foreach ($pattern in $candidates) {
        if (-not $pattern) { continue }
        $hits = Get-Item $pattern -ErrorAction SilentlyContinue
        foreach ($hit in $hits) {
            $java = Join-Path $hit.FullName "bin\java.exe"
            if (Test-Path $java) { return $hit.FullName }
        }
    }
    $cmd = Get-Command java -ErrorAction SilentlyContinue
    if ($cmd) {
        return (Split-Path (Split-Path $cmd.Source))
    }
    return $null
}

function Download-File($Url, $Dest) {
    if (Test-Path $Dest) { return }
    Write-Host "Yuklanmoqda: $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Dest
}

$javaHome = Find-JavaHome
if (-not $javaHome) {
    Write-Host "JDK 17 topilmadi. O‘rnatiladi..."
    winget install --id Microsoft.OpenJDK.17 -e --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $javaHome = Find-JavaHome
}
if (-not $javaHome) { throw "JDK 17 o‘rnatilmadi. Microsoft OpenJDK 17 ni o‘rnating va qayta ishga tushiring." }
$env:JAVA_HOME = $javaHome
$env:Path = "$javaHome\bin;" + $env:Path
Write-Host "JAVA_HOME=$javaHome"

Download-File "https://services.gradle.org/distributions/gradle-$GradleVer-bin.zip" $GradleZip
if (-not (Test-Path (Join-Path $GradleHome "bin\gradle.bat"))) {
    Write-Host "Gradle ochilmoqda..."
    Expand-Archive -Path $GradleZip -DestinationPath $Tools -Force
}

Download-File "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip" $CmdZip
$CmdLatest = Join-Path $Sdk "cmdline-tools\latest"
if (-not (Test-Path (Join-Path $CmdLatest "bin\sdkmanager.bat"))) {
    $tmp = Join-Path $Tools "cmdline-unpack"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $CmdZip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path (Split-Path $CmdLatest) | Out-Null
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (Test-Path $CmdLatest) { Remove-Item $CmdLatest -Recurse -Force }
    Move-Item $inner.FullName $CmdLatest
}

$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
$sdkmanager = Join-Path $CmdLatest "bin\sdkmanager.bat"
Set-Content -Path (Join-Path $Project "local.properties") -Value ("sdk.dir=" + ($Sdk.Replace('\', '/'))) -Encoding ASCII

$lic = Join-Path $Sdk "licenses"
New-Item -ItemType Directory -Force -Path $lic | Out-Null
[IO.File]::WriteAllText((Join-Path $lic "android-sdk-license"), "`n24333f8a63b6825ea9c5514f83c2829b004d1dc9`n")
[IO.File]::WriteAllText((Join-Path $lic "android-sdk-preview-license"), "`n84831b9409646167ce81451a1642ea3`n")
[IO.File]::WriteAllText((Join-Path $lic "google-gdk-license"), "`n33b6a2b64607f11b759f320ef9dff4ae`n")
$yes = Join-Path $env:TEMP "sdk-yes.txt"
(1..40 | ForEach-Object { "y" }) | Set-Content $yes -Encoding ASCII
cmd /c "`"$sdkmanager`" --sdk_root=$Sdk --licenses < `"$yes`""
Write-Host "Android SDK paketlari..."
& $sdkmanager --sdk_root=$Sdk "platforms;android-34" "build-tools;34.0.0" "platform-tools"

Write-Host "APK yigilmoqda..."
$gradle = Join-Path $GradleHome "bin\gradle.bat"
Push-Location $Project
try {
    & $gradle --no-daemon assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "Gradle assembleDebug xato: $LASTEXITCODE" }
} finally {
    Pop-Location
}

$built = Join-Path $Project "app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path $built)) { throw "APK topilmadi: $built" }
Copy-Item $built $OutApk -Force
Write-Host "Tayyor: $OutApk"
